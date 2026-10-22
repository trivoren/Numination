/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/rag-parser.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pipeline RAG: PDF → texto → chunks → embeddings → pgvector.

   POR QUÉ EXISTE
   El chat de Numination responde "en general". Con RAG, responde "en
   general Y con la fuente que el usuario subió". Este módulo es el
   motor que convierte un PDF en algo que el LLM puede citar.

   EL EMBEDDING
   · Primario:  OpenAI  `text-embedding-3-small` (1536 dims)
   · Secundario: Gemini `text-embedding-004` (768 dims) — se reescala a
     1536 con padding para no romper la dimensión de la columna vector.
   · Terciario:  embedding determinista por hashing (NO es semántico, pero
     mantiene el pipeline completo y testeable sin credenciales). Queda
     marcado en `embedding_model` para no confundirlo con uno real.

   EL ALMACENAMIENTO
   Tabla `rag_documents` + `rag_chunks` con `vector(1536)` y búsqueda
   por similitud coseno (pgvector). TodoIndex IVFFlat / HNSW se crean
   de forma perezosa cuando ya hay filas suficientes.

   AISLAMIENTO POR USUARIO
   Cada chunk guarda `user_id`. TODAS las consultas filtran por user_id
   en el WHERE: un usuario no puede recuperar fragmentos de otro, ni
   siquiera adivinando el id del documento.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { sql, supabaseDisponible } from './supabase.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  maxFileBytes: 15 * 1024 * 1024,   // 15 MB
  maxChars: 1_500_000,              // ~1.5M de caracteres por documento
  chunkSize: 1000,                  // caracteres por chunk (≈250 tokens)
  chunkOverlap: 180,                // solapamiento entre chunks
  minChunkChars: 60,
  embeddingDim: 1536,               // dimensión de la columna vector
  batchSize: 32,                    // chunks por llamada a la API
  topK: 6,                          // fragmentos devueltos al LLM
  maxContextChars: 6000,            // presupuesto de contexto RAG
  openaiEmbedUrl: 'https://api.openai.com/v1/embeddings',
  openaiEmbedModel: 'text-embedding-3-small',
  geminiEmbedUrl: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents',
  geminiEmbedFallback: 'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent',
  timeoutMs: 20_000,
});

const TABLES = Object.freeze({
  documents: 'rag_documents',
  chunks: 'rag_chunks',
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · EXTRACCIÓN DE TEXTO DEL PDF
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Extrae texto de un PDF.
 *
 * Estrategia en cascada:
 *   1. `pdf-parse` si está instalado (mejor calidad en la mayoría de
 *      los casos, respeta el orden de lectura).
 *   2. Extractor propio: descomprime los streams FlateDecode, interpreta
 *      los operadores de texto (Tj/TJ/'/") con cadenas literales y
 *      hexadecimales, y aplica las tablas ToUnicode cuando el PDF usa
 *      fuentes subconjuntadas (LaTeX, Word, InDesign…).
 *
 * En ambos casos se normalizan espacios, se quitan guiones de corte de
 * línea y se colapsan blancos excesivos.
 */
export async function extractPdfText(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('El archivo PDF está vacío.');
  }

  // ── 1) pdf-parse (opcional) ───────────────────────────────────────────
  try {
    const mod = await import('pdf-parse/lib/pdf-parse.js');
    const parse = mod.default || mod;
    const result = await parse(buffer);
    const text = normalizeText(result?.text || '');
    if (text.length > 40) {
      return { text, extractor: 'pdf-parse', pages: result?.numpages || null };
    }
  } catch (e) {
    LOG.debug('rag: pdf-parse no pudo leer el PDF, se usa el extractor propio', { error: e.message });
  }

  // ── 2) Extractor propio ──────────────────────────────────────────────
  const raw = extractTextFromPdfBytes(buffer);
  const text = normalizeText(raw);
  if (text.length < 20) {
    throw new Error(
      'No se pudo extraer texto del PDF. Si es un PDF escaneado, necesita OCR.'
    );
  }
  return { text, extractor: 'builtin', pages: null };
}

/**
 * Extractor propio: recorre los streams del PDF, descomprime los
 * FlateDecode y recoge el texto de los operadores de escritura.
 */
function extractTextFromPdfBytes(buffer) {
  const raw = buffer.toString('latin1');
  const cmaps = parseToUnicodeMaps(raw);

  const chunks = [];
  const streamRe = /stream\r?\n?([\s\S]*?)\r?\n?endstream/g;
  let match;

  while ((match = streamRe.exec(raw)) !== null) {
    const body = Buffer.from(match[1], 'latin1');
    const content = inflateBuffer(body);
    if (!content) continue;

    const text = content.toString('latin1');
    if (!/(Tj|TJ|'|")/.test(text)) continue;

    const extracted = extractTextOperators(text, cmaps);
    if (extracted) chunks.push(extracted);
  }

  // Si no se encontró nada con streams, se intenta el texto plano del PDF
  if (!chunks.length) {
    const plainRe = /\(((?:\\.|[^\\()])*)\)/g;
    let m;
    const plain = [];
    while ((m = plainRe.exec(raw)) !== null) {
      const s = unescapePdfString(m[1]);
      if (/[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(s)) plain.push(s);
    }
    chunks.push(plain.join(' '));
  }

  return chunks.join('\n');
}

/**
 * Interpreta los operadores de texto de un content stream.
 *
 * · `(literal) Tj`   → texto literal
 * · `<hex> Tj`       → texto hexadecimal (posiblemente con ToUnicode)
 * · `[ ... ] TJ`     → array de fragmentos (se concatenan sin separador;
 *   un ajuste numérico grande (< -120) implica un espacio)
 * · `(...) '` y `(...) "` → igual que Tj (con salto de línea)
 */
function extractTextOperators(content, cmaps) {
  const pieces = [];
  const re = /\[((?:[^\[\]\\]|\\[\s\S])*)\]\s*TJ|\(((?:\\.|[^\\()])*)\)\s*(Tj|'|")|<([0-9A-Fa-f\s]+)>\s*Tj/g;

  let m;
  while ((m = re.exec(content)) !== null) {
    if (m[1] !== undefined) {
      // Array TJ
      pieces.push(parseTjArray(m[1], cmaps));
    } else if (m[2] !== undefined) {
      // Literal Tj / ' / "
      pieces.push(unescapePdfString(m[2]));
    } else if (m[3] !== undefined) {
      // Hexadecimal Tj
      pieces.push(decodeHexString(m[3], cmaps));
    }
  }

  return pieces.filter(Boolean).join(' ');
}

/**
 * Parsea el interior de un array TJ.
 */
function parseTjArray(body, cmaps) {
  const parts = [];
  const re = /\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]+)>|(-?\d+(?:\.\d+)?)/g;

  let m;
  while ((m = re.exec(body)) !== null) {
    if (m[1] !== undefined) {
      parts.push(unescapePdfString(m[1]));
    } else if (m[2] !== undefined) {
      parts.push(decodeHexString(m[2], cmaps));
    } else if (m[3] !== undefined) {
      // Ajuste de posición: un número muy negativo implica un espacio.
      const kern = parseFloat(m[3]);
      if (Number.isFinite(kern) && kern < -120) parts.push(' ');
    }
  }

  return parts.join('');
}

/** Decodifica una cadena hexadecimal, aplicando ToUnicode si hace falta. */
function decodeHexString(hex, cmaps) {
  const clean = String(hex || '').replace(/\s+/g, '');
  if (!clean) return '';

  const bytes = Buffer.from(clean.length % 2 ? `${clean}0` : clean, 'hex');
  if (!bytes.length) return '';

  // 1) Si los bytes son ASCII/UTF-8 legible, se usan tal cual.
  const asText = bytes.toString('latin1');
  const printable = asText.replace(/[^\x20-\x7E¡-ÿ]/g, '').length / asText.length;
  if (printable > 0.85) return asText;

  // 2) Si no, se busca la traducción en las tablas ToUnicode.
  if (cmaps && cmaps.size) {
    let out = '';
    for (let i = 0; i < bytes.length - 1; i += 2) {
      const code = (bytes[i] << 8) | bytes[i + 1];
      const mapped = cmaps.get(code);
      out += mapped !== undefined ? mapped : '';
    }
    if (out.trim()) return out;
  }

  return asText;
}

/**
 * Extrae las tablas ToUnicode de los objetos del PDF.
 * Formato soportado: `beginbfchar` y `beginbfrange`.
 *
 * @returns {Map<number, string>}
 */
function parseToUnicodeMaps(raw) {
  const map = new Map();

  // Se buscan los bloques de definición dentro de los streams.
  const cmaps = raw.match(/begincmap[\s\S]*?endcmap/g);
  if (!cmaps) return map;

  for (const cmap of cmaps) {
    // bfchar: <src> <dst>
    const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
    let block;
    while ((block = bfcharRe.exec(cmap)) !== null) {
      const pairRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let p;
      while ((p = pairRe.exec(block[1])) !== null) {
        const src = parseInt(p[1], 16);
        const dst = hexToUnicodeString(p[2]);
        if (Number.isFinite(src) && dst !== null) map.set(src, dst);
      }
    }

    // bfrange: <lo> <hi> <dst>   o   <lo> <hi> [<d1> <d2> ...]
    const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((block = bfrangeRe.exec(cmap)) !== null) {
      const body = block[1];

      const simpleRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let r;
      while ((r = simpleRe.exec(body)) !== null) {
        const lo = parseInt(r[1], 16);
        const hi = parseInt(r[2], 16);
        const base = parseInt(r[3], 16);
        if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(base)) continue;
        const limit = Math.min(hi - lo, 65535);
        for (let i = 0; i <= limit; i++) {
          const dst = hexToUnicodeString((base + i).toString(16).padStart(r[3].length, '0'));
          if (dst !== null) map.set(lo + i, dst);
        }
      }

      const listRe = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*\[([^\]]*)\]/g;
      while ((r = listRe.exec(body)) !== null) {
        const lo = parseInt(r[1], 16);
        const items = r[3].match(/<([0-9A-Fa-f]+)>/g) || [];
        items.forEach((it, idx) => {
          const hex = it.replace(/[<>]/g, '');
          const dst = hexToUnicodeString(hex);
          if (Number.isFinite(lo) && dst !== null) map.set(lo + idx, dst);
        });
      }
    }
  }

  return map;
}

/**
 * Convierte una cadena hexadecimal UTF-16BE en texto.
 */
function hexToUnicodeString(hex) {
  const clean = String(hex || '').replace(/\s+/g, '');
  if (!clean) return null;
  try {
    const buf = Buffer.from(clean.length % 2 ? `${clean}0` : clean, 'hex');
    if (!buf.length) return null;
    if (buf.length === 1) return String.fromCharCode(buf[0]);
    // UTF-16BE
    let out = '';
    for (let i = 0; i + 1 < buf.length; i += 2) {
      out += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
    }
    return out;
  } catch {
    return null;
  }
}

/** Descomprime un buffer con zlib (FlateDecode). */
function inflateBuffer(buffer) {
  try {
    return zlib.inflateSync(buffer);
  } catch {
    try {
      return zlib.inflateRawSync(buffer);
    } catch {
      return null;
    }
  }
}

/** Convierte escapes de cadena PDF (\(, \\, \n, octales) a texto plano. */
function unescapePdfString(str) {
  return String(str)
    .replace(/\\([nrtbf])/g, (_m, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' }[c] || ' '))
    .replace(/\\([0-7]{1,3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)))
    .replace(/\\(.)/g, '$1');
}

/** Normaliza el texto extraído. */
export function normalizeText(text) {
  if (!text) return '';
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/­/g, '')                 // soft hyphen
    .replace(/([A-Za-zÁÉÍÓÚÑáéíóúñ])-\n([a-záéíóúñ])/g, '$1$2') // palabra cortada
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ ]{2,}/g, ' ')
    .trim();
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · CHUNKING
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Divide el texto en chunks con solapamiento.
 *
 * Se respeta la frontera de párrafo y, si no es posible, la de oración.
 * Un chunk que parte una palabra por la mitad es basura para el modelo
 * y entrena mal al recuperador.
 */
export function chunkText(text, options = {}) {
  const size = options.chunkSize || CFG.chunkSize;
  const overlap = options.overlap ?? CFG.chunkOverlap;
  const minChars = options.minChunkChars ?? CFG.minChunkChars;

  const clean = normalizeText(text).slice(0, CFG.maxChars);
  if (!clean) return [];

  const paragraphs = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks = [];

  let current = '';
  const flush = () => {
    const value = current.trim();
    if (value.length >= minChars) {
      chunks.push({ text: value, index: chunks.length });
    }
    current = '';
  };

  for (const para of paragraphs) {
    if (para.length > size) {
      // Párrafo largo → se parte por oraciones.
      flush();
      const sentences = para.match(/[^.!?¡¿]+[.!?¡¿]?/g) || [para];
      let buf = '';
      for (const sentence of sentences) {
        if ((buf + sentence).length > size && buf) {
          chunks.push({ text: buf.trim(), index: chunks.length });
          // Solapamiento: se arrastra el final del chunk anterior.
          buf = buf.slice(Math.max(0, buf.length - overlap)) + sentence;
        } else {
          buf += sentence;
        }
      }
      if (buf.trim().length >= minChars) {
        chunks.push({ text: buf.trim(), index: chunks.length });
      }
      continue;
    }

    if ((current + '\n\n' + para).length > size) {
      flush();
    }
    current += (current ? '\n\n' : '') + para;
  }
  flush();

  // Se fusionan chunks muy cortos con el siguiente.
  const merged = [];
  for (const chunk of chunks) {
    const prev = merged[merged.length - 1];
    if (prev && prev.text.length < minChars && (prev.text.length + chunk.text.length) <= size + 120) {
      prev.text += '\n\n' + chunk.text;
    } else {
      merged.push({ ...chunk, index: merged.length });
    }
  }

  return merged;
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · EMBEDDINGS
   ═══════════════════════════════════════════════════════════════════════════ */

/* Las claves pueden venir de .env.local o del archivo env.local.js. */
let FILE_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  FILE_KEYS = mod.TEST_KEYS ?? {};
} catch { /* archivo opcional */ }

function hasOpenAI() {
  return Boolean(process.env.OPENAI_API_KEY || FILE_KEYS.OPENAI_API_KEY);
}

function hasGemini() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY_3 || FILE_KEYS.GEMINI_API_KEY);
}

/**
 * Genera embeddings para un lote de textos.
 * Devuelve { vectors, model, provider }.
 */
export async function embedBatch(texts) {
  const list = Array.isArray(texts) ? texts.filter((t) => typeof t === 'string' && t.length) : [];
  if (!list.length) {
    return { vectors: [], model: 'none', provider: 'none' };
  }

  if (hasOpenAI()) {
    try {
      const vectors = await embedWithOpenAI(list);
      return { vectors, model: CFG.openaiEmbedModel, provider: 'openai' };
    } catch (e) {
      LOG.warn('rag: OpenAI embeddings fallaron, se intenta Gemini', { error: e.message });
    }
  }

  if (hasGemini()) {
    try {
      const vectors = await embedWithGemini(list);
      return { vectors, model: 'gemini-embedding-001', provider: 'gemini' };
    } catch (e) {
      LOG.warn('rag: Gemini embeddings fallaron, se usa el embedding determinista', { error: e.message });
    }
  }

  return {
    vectors: list.map((t) => deterministicEmbedding(t)),
    model: 'deterministic-hash-v1',
    provider: 'local',
  };
}

/** Embeddings deterministas por hashing (fallback sin credenciales). */
export function deterministicEmbedding(text, dim = CFG.embeddingDim) {
  const vec = new Array(dim).fill(0);
  const source = String(text || '').toLowerCase();
  const tokens = source.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const hashed = tokens.length ? tokens : [source];

  for (let i = 0; i < hashed.length; i++) {
    const digest = crypto.createHash('sha256').update(`${hashed[i]}#${i}`).digest();
    for (let j = 0; j < digest.length; j++) {
      vec[(i * 31 + j) % dim] += (digest[j] / 255 - 0.5) * 0.6;
    }
  }

  // Normalización L2 para que la similitud coseno sea coherente.
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  return vec.map((v) => v / norm);
}

/** OpenAI embeddings. */
async function embedWithOpenAI(texts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

  try {
    const res = await fetch(CFG.openaiEmbedUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: CFG.openaiEmbedModel,
        input: texts,
        encoding_format: 'float',
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json();
    const vectors = (data?.data || []).map((d) => d.embedding);

    if (!vectors.length) throw new Error('OpenAI devolvió una respuesta vacía.');

    return vectors.map((v) => padVector(v, CFG.embeddingDim));
  } finally {
    clearTimeout(timer);
  }
}

/** Gemini embeddings (768 dims → 1536 con padding). */
async function embedWithGemini(texts) {
  // Se prueban las claves candidatas en orden hasta que una funcione: en
  // desarrollo suele haber una clave vieja en el entorno y la valida en
  // env.local.js (o al reves).
  const candidates = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    FILE_KEYS.GEMINI_API_KEY,
    FILE_KEYS.GEMINI_API_KEY_2,
    FILE_KEYS.GEMINI_API_KEY_3,
  ].filter((k) => typeof k === 'string' && k.trim().length > 20);

  if (!candidates.length) return null;

  const requests = texts.map((text) => ({
    model: 'models/gemini-embedding-001',
    content: { parts: [{ text: String(text).slice(0, 8000) }] },
    taskType: 'RETRIEVAL_DOCUMENT',
    outputDimensionality: CFG.embeddingDim,
  }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

  try {
    let lastError = null;

    for (const key of candidates) {
      try {
        let res = await fetch(`${CFG.geminiEmbedUrl}?key=${encodeURIComponent(key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requests }),
          signal: controller.signal,
        });

        // Si el modelo nuevo no esta disponible, se prueba el anterior
        // (text-embedding-004 usa :embedContent con un unico contenido).
        if (!res.ok) {
          const single = requests[0];
          res = await fetch(`${CFG.geminiEmbedFallback}?key=${encodeURIComponent(key)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'models/text-embedding-004',
              content: single.content,
              taskType: single.taskType,
            }),
            signal: controller.signal,
          });
        }

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          lastError = new Error(`Gemini ${res.status}: ${body.slice(0, 180)}`);
          continue;
        }

        const data = await res.json();
        const vectors = (data?.embeddings || []).map((e) => e?.values || []);

        if (!vectors.length) throw new Error('Gemini devolvio una respuesta vacia.');

        return vectors.map((v) => padVector(v, CFG.embeddingDim));
      } catch (e) {
        lastError = e;
        if (e.name === 'AbortError') throw e;
      }
    }

    throw lastError || new Error('Gemini: ninguna clave funciono.');
  } finally {
    clearTimeout(timer);
  }
}

/** Ajusta un vector a la dimensión de la columna (rellena con ceros). */
export function padVector(vector, dim = CFG.embeddingDim) {
  const out = new Array(dim).fill(0);
  for (let i = 0; i < Math.min(vector.length, dim); i++) out[i] = Number(vector[i]);
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · ESQUEMA (pgvector)
   ═══════════════════════════════════════════════════════════════════════════ */

let schemaPromise = null;

/**
 * Crea la extensión vector y las tablas del RAG (idempotente).
 *
 * Si la extensión `vector` no está disponible (Supabase free sin
 * pgvector), NO se aborta: se crea la tabla `rag_chunks` SIN la columna
 * de embeddings y el módulo sigue funcionando con búsqueda de texto
 * completo. La búsqueda semántica queda degradada, pero el pipeline
 * (subir → trocear → guardar → buscar) sigue vivo.
 */
export async function ensureRagSchema() {
  if (!supabaseDisponible()) return { ok: false, reason: 'no_db' };
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    let hasVector = false;

    try {
      await sql`create extension if not exists vector`;
      hasVector = true;
    } catch (e) {
      LOG.warn('rag: la extensión vector no está disponible, el RAG queda en modo texto completo', {
        error: e.message,
      });
    }

    try {
      await sql`
        create table if not exists ${sql(TABLES.documents)} (
          id              uuid primary key default gen_random_uuid(),
          user_id         uuid not null,
          filename        text not null,
          title           text,
          bytes           integer not null default 0,
          pages           integer,
          chars           integer not null default 0,
          chunk_count     integer not null default 0,
          embedding_model text,
          extractor       text,
          status          text not null default 'ready',
          error           text,
          meta            jsonb default '{}'::jsonb,
          created_at      timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists rag_documents_user_idx
          on ${sql(TABLES.documents)} (user_id, created_at desc)
      `;

      if (hasVector) {
        // La dimensión va como literal (no como parámetro): Postgres no
        // puede inferir el tipo de un parámetro dentro de un modificador
        // de tipo (vector($1) → 42P18). El valor es una constante
        // validada de nuestra config, nunca entrada del usuario.
        const dim = Number.isInteger(CFG.embeddingDim) && CFG.embeddingDim > 0 && CFG.embeddingDim <= 16000
          ? CFG.embeddingDim
          : 1536;

        await sql`
          create table if not exists ${sql(TABLES.chunks)} (
            id          uuid primary key default gen_random_uuid(),
            doc_id      uuid not null references ${sql(TABLES.documents)}(id) on delete cascade,
            user_id     uuid not null,
            chunk_index integer not null,
            content     text not null,
            tokens      integer,
            embedding   vector(${sql.unsafe(String(dim))}),
            created_at  timestamptz not null default now()
          )
        `;
      } else {
        await sql`
          create table if not exists ${sql(TABLES.chunks)} (
            id          uuid primary key default gen_random_uuid(),
            doc_id      uuid not null references ${sql(TABLES.documents)}(id) on delete cascade,
            user_id     uuid not null,
            chunk_index integer not null,
            content     text not null,
            tokens      integer,
            created_at  timestamptz not null default now()
          )
        `;
      }

      await sql`
        create index if not exists rag_chunks_user_doc_idx
          on ${sql(TABLES.chunks)} (user_id, doc_id)
      `;
      await sql`
        create index if not exists rag_chunks_content_idx
          on ${sql(TABLES.chunks)} using gin (to_tsvector('spanish', content))
      `;

      return { ok: true, vector: hasVector };
    } catch (e) {
      LOG.warn('rag: no se pudo crear el esquema', { error: e.message, code: e.code });
      return { ok: false, reason: e.code || 'schema_error', vector: hasVector };
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · INGESTA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Procesa un PDF completo: extrae, trocea, embebe y guarda.
 *
 * @param {object} params
 * @param {Buffer} params.buffer   Contenido del PDF
 * @param {string} params.filename Nombre original
 * @param {string} params.userId   Dueño (obligatorio: aísla los datos)
 * @param {function} [params.onProgress] Callback (pct, stage)
 * @returns {object} Resumen del documento procesado
 */
export async function ingestPdf({ buffer, filename, userId, onProgress = null }) {
  if (!userId) throw new Error('Se requiere userId para procesar un documento.');
  if (!buffer || !buffer.length) throw new Error('El archivo está vacío.');
  if (buffer.length > CFG.maxFileBytes) {
    throw new Error(`El PDF supera el máximo de ${Math.round(CFG.maxFileBytes / 1024 / 1024)} MB.`);
  }

  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  progress(5, 'extrayendo texto');
  const { text, extractor, pages } = await extractPdfText(buffer);

  progress(25, 'dividiendo en fragmentos');
  const chunks = chunkText(text);

  if (!chunks.length) {
    throw new Error('El PDF no tiene texto suficiente para indexarlo.');
  }

  progress(35, 'generando embeddings');
  const vectors = [];
  let model = 'none';
  let provider = 'none';

  for (let i = 0; i < chunks.length; i += CFG.batchSize) {
    const batch = chunks.slice(i, i + CFG.batchSize);
    const result = await embedBatch(batch.map((c) => c.text));
    vectors.push(...result.vectors);
    model = result.model;
    provider = result.provider;
    const pct = 35 + Math.round(((i + batch.length) / chunks.length) * 50);
    progress(pct, 'generando embeddings');
  }

  progress(88, 'guardando en la base de datos');

  const stored = await storeDocument({
    userId,
    filename,
    title: String(filename || 'documento').replace(/\.pdf$/i, ''),
    bytes: buffer.length,
    pages,
    chars: text.length,
    chunks,
    vectors,
    model,
    extractor,
  });

  progress(100, 'listo');

  return {
    ok: true,
    ...stored,
    extractor,
    embeddingModel: model,
    embeddingProvider: provider,
  };
}

/**
 * Persiste documento + chunks con sus embeddings.
 * Si no hay pgvector, se guardan los chunks sin embedding (el documento
 * queda indexado por texto completo, no por similitud).
 */
export async function storeDocument({
  userId, filename, title, bytes, pages, chars, chunks, vectors, model, extractor,
}) {
  if (!supabaseDisponible()) {
    // Modo degradado: se devuelven los datos para que la UI pueda
    // mostrarlos, pero nada se persiste.
    return {
      id: crypto.randomUUID(),
      persisted: false,
      degraded: true,
      chunkCount: chunks.length,
      filename,
    };
  }

  const schema = await ensureRagSchema();

  const [doc] = await sql`
    insert into ${sql(TABLES.documents)} (
      user_id, filename, title, bytes, pages, chars,
      chunk_count, embedding_model, extractor, status
    ) values (
      ${userId}::uuid, ${filename}, ${title}, ${bytes}, ${pages}, ${chars},
      ${chunks.length}, ${model}, ${extractor}, 'ready'
    )
    returning id::text as id
  `;

  const docId = doc.id;
  const hasVectors = Array.isArray(vectors) && vectors.length === chunks.length;

  if (hasVectors && schema.ok && schema.vector !== false) {
    // Inserción por lotes para no mandar un solo statement enorme.
    // El vector viaja como literal de texto '[0.1,0.2,...]' y se castea
    // en SQL: es la forma más portable entre versiones de pgvector.
    for (let i = 0; i < chunks.length; i += CFG.batchSize) {
      const batch = chunks.slice(i, i + CFG.batchSize);
      const vecs = vectors.slice(i, i + CFG.batchSize);
      const rows = batch.map((c, k) => ({
        chunk_index: c.index,
        content: c.text,
        tokens: estimateTokens(c.text),
        embedding: toVectorLiteral(vecs[k]),
      }));

      await sql`
        insert into ${sql(TABLES.chunks)} (doc_id, user_id, chunk_index, content, tokens, embedding)
        select
          ${docId}::uuid,
          ${userId}::uuid,
          r.chunk_index,
          r.content,
          r.tokens,
          r.embedding::vector
        from jsonb_to_recordset(${sql.json(rows)}) as r(
          chunk_index int, content text, tokens int, embedding text
        )
      `;
    }
  } else {
    for (let i = 0; i < chunks.length; i += CFG.batchSize) {
      const batch = chunks.slice(i, i + CFG.batchSize);
      const rows = batch.map((c) => ({
        chunk_index: c.index,
        content: c.text,
        tokens: estimateTokens(c.text),
      }));

      await sql`
        insert into ${sql(TABLES.chunks)} (doc_id, user_id, chunk_index, content, tokens)
        select
          ${docId}::uuid,
          ${userId}::uuid,
          rows.*.chunk_index,
          rows.*.content,
          rows.*.tokens
        from jsonb_to_recordset(${sql.json(rows)}) as rows(
          chunk_index int, content text, tokens int
        )
      `;
    }
  }

  return {
    id: docId,
    persisted: true,
    degraded: !hasVectors || !schema.ok,
    chunkCount: chunks.length,
    filename,
  };
}

function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

/**
 * Convierte un array de números en el literal de texto que pgvector
 * entiende: '[0.1,0.2,0.3]'.
 */
export function toVectorLiteral(vector) {
  if (!Array.isArray(vector)) return null;
  return `[${vector.map((v) => Number(v) || 0).join(',')}]`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   07 · BÚSQUEDA / RECUPERACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Recupera los fragmentos más relevantes para una consulta.
 *
 * Estrategia:
 *   · Si hay embeddings → similitud coseno con pgvector.
 *   · Si no → búsqueda de texto completo (tsvector en español).
 *
 * En ambos casos se filtra SIEMPRE por user_id.
 */
export async function searchChunks({ userId, query, topK = CFG.topK, docId = null }) {
  if (!userId) return { ok: false, results: [], reason: 'no_user' };
  if (!supabaseDisponible()) return { ok: true, results: [], degraded: true };

  const k = Math.max(1, Math.min(parseInt(topK, 10) || CFG.topK, 20));

  try {
    const schema = await ensureRagSchema();
    const vectorAvailable = schema.ok && schema.vector !== false;

    // ── Vectorial ──────────────────────────────────────────────────────
    const { vectors, model } = await embedBatch([String(query || '').slice(0, 4000)]);
    const vec = vectors[0];

    const useVector = vectorAvailable && model !== 'deterministic-hash-v1' && Array.isArray(vec) && vec.length === CFG.embeddingDim;

    if (useVector) {
      const literal = toVectorLiteral(vec);
      const rows = await sql`
        select
          c.id::text as id,
          c.doc_id::text as doc_id,
          c.chunk_index,
          c.content,
          d.filename,
          d.title,
          1 - (c.embedding <=> ${literal}::vector) as score
        from ${sql(TABLES.chunks)} c
        join ${sql(TABLES.documents)} d on d.id = c.doc_id
        where c.user_id = ${userId}::uuid
          ${docId ? sql`and c.doc_id = ${docId}::uuid` : sql``}
        order by c.embedding <=> ${literal}::vector
        limit ${k}
      `;

      return {
        ok: true,
        degraded: false,
        mode: 'vector',
        results: rows.map((r) => ({
          id: r.id,
          docId: r.doc_id,
          docTitle: r.title || r.filename,
          filename: r.filename,
          index: r.chunk_index,
          content: r.content,
          score: Number(r.score || 0),
        })),
      };
    }

    // ── Texto completo ─────────────────────────────────────────────────
    const rows = await sql`
      select
        c.id::text as id,
        c.doc_id::text as doc_id,
        c.chunk_index,
        c.content,
        d.filename,
        d.title,
        ts_rank(to_tsvector('spanish', c.content), plainto_tsquery('spanish', ${query})) as score
      from ${sql(TABLES.chunks)} c
      join ${sql(TABLES.documents)} d on d.id = c.doc_id
      where c.user_id = ${userId}::uuid
        and to_tsvector('spanish', c.content) @@ plainto_tsquery('spanish', ${query})
        ${docId ? sql`and c.doc_id = ${docId}::uuid` : sql``}
      order by score desc
      limit ${k}
    `;

    return {
      ok: true,
      degraded: true,
      mode: 'fulltext',
      results: rows.map((r) => ({
        id: r.id,
        docId: r.doc_id,
        docTitle: r.title || r.filename,
        filename: r.filename,
        index: r.chunk_index,
        content: r.content,
        score: Number(r.score || 0),
      })),
    };
  } catch (e) {
    LOG.warn('rag: searchChunks falló', { error: e.message, code: e.code });
    return { ok: false, results: [], reason: 'search_error' };
  }
}

/**
 * Arma el bloque de contexto que se inyecta en el prompt.
 * Respeta un presupuesto de caracteres para no desbordar el contexto
 * del modelo.
 */
export function buildRagContext(results, budget = CFG.maxContextChars) {
  if (!Array.isArray(results) || !results.length) return '';

  const parts = [];
  let used = 0;

  for (const r of results) {
    const block =
      `[Fragmento ${r.index + 1} · ${r.docTitle || r.filename || 'documento'}] ` +
      String(r.content || '').slice(0, 1400);

    if (used + block.length > budget) break;
    parts.push(block);
    used += block.length;
  }

  if (!parts.length) return '';

  return (
    'Contexto recuperado de los documentos del usuario (úsalo para responder con precisión ' +
    'y cita el documento cuando corresponda):\n\n' +
    parts.join('\n\n---\n\n')
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · GESTIÓN DE DOCUMENTOS
   ═══════════════════════════════════════════════════════════════════════════ */

export async function listDocuments(userId, { limit = 25 } = {}) {
  if (!supabaseDisponible()) return { ok: true, degraded: true, documents: [] };

  try {
    await ensureRagSchema();
    const rows = await sql`
      select
        d.id::text as id,
        d.filename,
        d.title,
        d.bytes,
        d.pages,
        d.chars,
        d.chunk_count,
        d.embedding_model,
        d.extractor,
        d.status,
        d.created_at,
        (select count(*)::int from ${sql(TABLES.chunks)} c where c.doc_id = d.id) as chunks
      from ${sql(TABLES.documents)} d
      where d.user_id = ${userId}::uuid
      order by d.created_at desc
      limit ${Math.min(parseInt(limit, 10) || 25, 100)}
    `;
    return { ok: true, degraded: false, documents: rows };
  } catch (e) {
    LOG.warn('rag: listDocuments falló', { error: e.message });
    return { ok: true, degraded: true, documents: [] };
  }
}

export async function deleteDocument(userId, docId) {
  if (!supabaseDisponible()) return { ok: true, degraded: true };

  try {
    await ensureRagSchema();
    const rows = await sql`
      delete from ${sql(TABLES.documents)}
      where id = ${docId}::uuid
        and user_id = ${userId}::uuid
      returning id::text as id
    `;
    return { ok: true, deleted: rows.length > 0 };
  } catch (e) {
    LOG.warn('rag: deleteDocument falló', { error: e.message });
    return { ok: false, error: 'No se pudo eliminar el documento.' };
  }
}

/** Borra todos los documentos de un usuario (derecho al olvido). */
export async function deleteAllDocuments(userId) {
  if (!supabaseDisponible()) return { ok: true, degraded: true, deleted: 0 };

  try {
    await ensureRagSchema();
    const rows = await sql`
      delete from ${sql(TABLES.documents)}
      where user_id = ${userId}::uuid
      returning id
    `;
    return { ok: true, deleted: rows.length };
  } catch (e) {
    LOG.warn('rag: deleteAllDocuments falló', { error: e.message });
    return { ok: false, error: 'No se pudieron eliminar los documentos.' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   09 · ESTADO
   ═══════════════════════════════════════════════════════════════════════════ */

export function getRagStatus() {
  return {
    available: supabaseDisponible(),
    embeddingDim: CFG.embeddingDim,
    chunkSize: CFG.chunkSize,
    chunkOverlap: CFG.chunkOverlap,
    topK: CFG.topK,
    maxFileMb: Math.round(CFG.maxFileBytes / 1024 / 1024),
    providers: {
      openai: hasOpenAI(),
      gemini: hasGemini(),
      fallback: 'deterministic-hash-v1',
    },
  };
}

export default {
  extractPdfText,
  normalizeText,
  chunkText,
  embedBatch,
  deterministicEmbedding,
  ingestPdf,
  searchChunks,
  buildRagContext,
  listDocuments,
  deleteDocument,
  deleteAllDocuments,
  ensureRagSchema,
  getRagStatus,
};
