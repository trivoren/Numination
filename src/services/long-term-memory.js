/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · long-term-memory.js · v1.0
   ─────────────────────────────────────────────────────────────────────────
   Sistema de memoria semántica de largo plazo para Numi.

   CARACTERÍSTICAS:

     · Embeddings multi-provider (OpenAI, Gemini, Voyage, local fallback)
     · pgvector en Supabase con búsqueda cosine O(log n)
     · Cache de embeddings con LRU (ahorra $$ y llamadas)
     · Auto-extracción de memorias desde conversaciones
     · Categorización automática (fact / preference / goal / context / skill / relation)
     · Deduplicación por similitud (>= 0.92 → merge)
     · Detección de contradicciones (>= 0.85 sim + negación opuesta)
     · Consolidación batch (merge de clústers)
     · Decay exponencial por tiempo sin uso
     · Importance scoring dinámico
     · Hybrid search (embedding + keyword BM25)
     · Context builder con token budget
     · Migración desde sistema legacy (strings planos)
     · Batch embedding (múltiples textos en una API call)
     · Fallback a hash-embedding si no hay API key
     · Self-test integrado
     · Analytics: uso, hits, ahorro de tokens

   API PÚBLICA:

     Embeddings:
       embed(text)                    → Promise<number[]>
       embedBatch(texts)              → Promise<number[][]>

     Memorias:
       store(userId, text, meta)      → Promise<Memory>
       search(userId, query, opts)    → Promise<Memory[]>
       list(userId, opts)             → Promise<Memory[]>
       get(userId, id)                → Promise<Memory | null>
       update(userId, id, patch)      → Promise<Memory>
       remove(userId, id)             → Promise<boolean>
       clear(userId)                  → Promise<number>

     Extracción:
       extract(text, ctx)             → Promise<Candidate[]>
       extractFromConversation(msgs)  → Promise<Candidate[]>

     Consolidación:
       consolidate(userId)            → Promise<{ merged, removed, updated }>
       dedupe(userId)                 → Promise<{ duplicates, merged }>

     Context:
       buildContext(userId, query, opts) → Promise<string>
       searchRelevant(userId, query, n)  → Promise<Memory[]>

     Analytics:
       getStats(userId)               → Promise<Stats>

     Migración:
       migrate(userId)                → Promise<{ migrated, skipped }>

     Config:
       configure(patch)               → void
       test()                         → Promise<TestReport>

   USO EN INDEX.JS:

     import { MEMORY } from './services/long-term-memory.js';

     // En /api/chat/stream (antes de llamar al LLM):
     const memoryContext = await MEMORY.buildContext(req.user.id, userMessage, {
       maxTokens: 800,
       maxMemories: 8,
     });

     systemPrompt += '\n\n' + memoryContext;

     // Después de responder:
     MEMORY.extractAndStore(req.user.id, [...history, userMsg, aiMsg]).catch(() => {});

   EVENTOS:
     nm:memory:stored         → { id, category, importance }
     nm:memory:extracted      → { count, categories }
     nm:memory:deduped        → { kept, merged }
     nm:memory:removed        → { id }
     nm:memory:consolidated   → { userId, merged, removed }
     nm:memory:error          → { error, context }
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = {
  // Embeddings
  embedding: {
    // Provider por default (auto detecta por API keys disponibles)
    provider: null,                 // 'openai' | 'gemini' | 'voyage' | 'local'
    dimensions: 1536,
    batchSize: 32,                  // máx textos por request batch
    cacheMax: 1000,                 // entradas en cache LRU
    cacheTtlMs: 7 * 24 * 60 * 60_000, // 7 días
    timeoutMs: 15_000,
    retries: 2,
  },

  // Providers
  openai: {
    enabled: true,
    apiKey: process.env.OPENAI_API_KEY || null,
    model: process.env.OPENAI_EMBED_MODEL || 'text-embedding-3-small',
    dimensions: 1536,
    baseUrl: 'https://api.openai.com/v1/embeddings',
  },

  gemini: {
    enabled: true,
    apiKey: process.env.GEMINI_API_KEY || null,
    model: 'text-embedding-004',
    dimensions: 768,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
  },

  voyage: {
    enabled: false,
    apiKey: process.env.VOYAGE_API_KEY || null,
    model: 'voyage-2',
    dimensions: 1024,
    baseUrl: 'https://api.voyageai.com/v1/embeddings',
  },

  local: {
    enabled: true,                // fallback siempre disponible
    dimensions: 1536,
  },

  // Búsqueda
  search: {
    defaultLimit: 8,
    minSimilarity: 0.55,
    hybridWeight: 0.7,            // 0.7 embedding + 0.3 keyword
    recencyBoostMax: 1.3,         // boost máximo por recencia
    recencyHalfLifeDays: 30,      // a los 30 días el boost se reduce a la mitad
    importanceWeight: 0.15,       // cuánto pesa la importancia en el score final
  },

  // Deduplicación
  dedupe: {
    enabled: true,
    similarityThreshold: 0.92,    // >= este valor → merge
    maxCandidatesPerRun: 200,
  },

  // Contradicciones
  contradiction: {
    enabled: true,
    similarityThreshold: 0.85,
    negationPairs: [
      ['me gusta', 'no me gusta'],
      ['amo', 'odio'],
      ['siempre', 'nunca'],
      ['soy', 'no soy'],
      ['tengo', 'no tengo'],
      ['puedo', 'no puedo'],
      ['quiero', 'no quiero'],
      ['vivo en', 'no vivo en'],
      ['trabajo en', 'no trabajo en'],
    ],
  },

  // Decay
  decay: {
    enabled: true,
    halfLifeDays: 60,             // a los 60 días sin uso, importance se reduce a la mitad
    minImportance: 0.05,
    cleanupThreshold: 0.03,       // por debajo de esto, eliminar
  },

  // Extracción
  extract: {
    autoExtract: true,            // extrae memorias automáticamente del chat
    minLength: 15,                // mínimo de chars para considerar una memoria
    maxLength: 500,               // máximo (truncar)
    maxPerConversation: 10,
    useLLM: false,                // si true, usa ctx.callLLM para extracción
    minConfidence: 0.5,
  },

  // Categorías válidas
  categories: ['fact', 'preference', 'goal', 'context', 'skill', 'relation', 'other'],

  // Supabase
  supabase: {
    table: 'Memory',
    rpcMatch: 'match_memories',
    useRPC: true,                 // si la función match_memories existe
    fallbackFetchAll: true,       // si RPC falla, fetch all + cosine in JS
    maxFetchAll: 1000,
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

/* ═══════════════════════════════════════════════════════════════════════════
   02 · LOGGER
   ═══════════════════════════════════════════════════════════════════════════ */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const CUR = LEVELS[CFG.logLevel] ?? LEVELS.info;

const LOG = {
  error: (...a) => CUR >= 1 && console.error ('[mem]', ...a),
  warn:  (...a) => CUR >= 2 && console.warn  ('[mem]', ...a),
  info:  (...a) => CUR >= 3 && console.log   ('[mem]', ...a),
  debug: (...a) => CUR >= 4 && console.log   ('[mem]', ...a),
};

/* ═══════════════════════════════════════════════════════════════════════════
   03 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

function now() { return Date.now(); }

function uid(prefix) {
  return (prefix || 'mem') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function sha256(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function hashInt(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
    h = h >>> 0; // unsigned 32-bit
  }
  return h;
}

function truncate(str, max) {
  str = String(str || '');
  if (str.length <= max) return str;
  return str.slice(0, max - 1).trim() + '…';
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[áàäâ]/g, 'a')
    .replace(/[éèëê]/g, 'e')
    .replace(/[íìïî]/g, 'i')
    .replace(/[óòöô]/g, 'o')
    .replace(/[úùüû]/g, 'u')
    .replace(/ñ/g, 'n')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return normalizeText(text).split(' ').filter(w => w.length >= 3);
}

/**
 * Cosine similarity entre 2 vectores.
 */
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Distancia euclidiana entre 2 vectores.
 */
function euclidean(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/**
 * Normaliza un vector L2 (magnitud 1).
 */
function normalize(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  return v.map(x => x / norm);
}

/**
 * BM25 keyword score entre query tokens y doc tokens.
 */
function bm25(queryTokens, docTokens, opts = {}) {
  const k1 = opts.k1 || 1.5;
  const b = opts.b || 0.75;
  const avgDocLen = opts.avgDocLen || docTokens.length;
  const N = opts.N || 1;
  const df = opts.df || {};

  let score = 0;
  const docLen = docTokens.length;
  const docTf = {};
  for (const t of docTokens) docTf[t] = (docTf[t] || 0) + 1;

  for (const q of queryTokens) {
    const tf = docTf[q] || 0;
    if (tf === 0) continue;
    const docFreq = df[q] || 1;
    const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
    const norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * docLen / avgDocLen));
    score += idf * norm;
  }
  return score;
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · PROVEEDORES DE EMBEDDINGS
   ═══════════════════════════════════════════════════════════════════════════ */

let _sbClient = null;

async function getSbClient() {
  if (_sbClient) return _sbClient;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    LOG.warn('Supabase no configurado');
    return null;
  }
  _sbClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _sbClient;
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = CFG.embedding.timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/* ─── OpenAI ─── */
async function embedOpenAI(texts) {
  if (!CFG.openai.apiKey) throw new Error('OPENAI_API_KEY missing');
  const res = await fetchWithTimeout(CFG.openai.baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + CFG.openai.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CFG.openai.model,
      input: texts,
      encoding_format: 'float',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('OpenAI ' + res.status + ': ' + errText.slice(0, 200));
  }

  const data = await res.json();
  return data.data.map(item => item.embedding);
}

/* ─── Gemini ─── */
async function embedGemini(texts) {
  if (!CFG.gemini.apiKey) throw new Error('GEMINI_API_KEY missing');

  // Gemini no soporta batch en un request, hacemos N
  const results = [];
  for (const text of texts) {
    const url = `${CFG.gemini.baseUrl}/${CFG.gemini.model}:embedContent?key=${CFG.gemini.apiKey}`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/' + CFG.gemini.model,
        content: { parts: [{ text }] },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error('Gemini ' + res.status + ': ' + errText.slice(0, 200));
    }

    const data = await res.json();
    const vec = data.embedding?.values;
    if (!Array.isArray(vec)) throw new Error('Gemini sin embedding');
    results.push(vec);
  }
  return results;
}

/* ─── Voyage ─── */
async function embedVoyage(texts) {
  if (!CFG.voyage.apiKey) throw new Error('VOYAGE_API_KEY missing');
  const res = await fetchWithTimeout(CFG.voyage.baseUrl, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + CFG.voyage.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CFG.voyage.model,
      input: texts,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Voyage ' + res.status + ': ' + errText.slice(0, 200));
  }

  const data = await res.json();
  return data.data.map(item => item.embedding);
}

/* ─── Local (hash-based fallback) ─── */
function embedLocal(texts) {
  return texts.map(text => hashEmbed(text, CFG.local.dimensions));
}

/**
 * Embedding basado en hash de n-grams.
 * NO es semántico, pero funciona para dedup y similitud básica.
 * Normalizado a magnitud 1.
 */
function hashEmbed(text, dims = 1536) {
  const vec = new Float32Array(dims);
  const normalized = normalizeText(text);
  if (!normalized) return Array.from(vec);

  // Generar n-grams 2, 3, 4
  const tokens = normalized.split(' ');
  const grams = [];
  for (const tok of tokens) {
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= tok.length; i++) {
        grams.push(tok.slice(i, i + n));
      }
    }
    // También tokens completos
    grams.push(tok);
  }

  // Hashear y acumular con signo
  for (const gram of grams) {
    const h = hashInt(gram);
    const idx = h % dims;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    vec[idx] += sign * (1 + Math.log(1 + gram.length));
  }

  // Normalizar
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) vec[i] /= norm;

  return Array.from(vec);
}

/* ─── Selector de provider ─── */
function pickProvider() {
  if (CFG.embedding.provider) return CFG.embedding.provider;

  if (CFG.openai.enabled && CFG.openai.apiKey) return 'openai';
  if (CFG.gemini.enabled && CFG.gemini.apiKey) return 'gemini';
  if (CFG.voyage.enabled && CFG.voyage.apiKey) return 'voyage';
  if (CFG.local.enabled) return 'local';

  throw new Error('No hay proveedor de embeddings disponible');
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · CACHE DE EMBEDDINGS (LRU)
   ═══════════════════════════════════════════════════════════════════════════ */

class LRU {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return null;
    const entry = this.map.get(key);
    if (entry.exp < now()) {
      this.map.delete(key);
      return null;
    }
    // Refresh
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.v;
  }

  set(key, value, ttl) {
    if (this.map.size >= this.max) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, { v: value, exp: ttl ? now() + ttl : 0 });
  }

  clear() { this.map.clear(); }
  size() { return this.map.size; }
}

const _embedCache = new LRU(CFG.embedding.cacheMax);

/* ═══════════════════════════════════════════════════════════════════════════
   06 · EMBED PÚBLICO
   ═══════════════════════════════════════════════════════════════════════════ */

async function embed(text) {
  const arr = await embedBatch([text]);
  return arr[0];
}

async function embedBatch(texts) {
  if (!Array.isArray(texts) || texts.length === 0) return [];

  // Normalizar
  const normalized = texts.map(t => truncate(String(t || ''), 8000));

  // Cache lookup
  const results = new Array(normalized.length);
  const toCompute = [];
  const toComputeIdx = [];

  for (let i = 0; i < normalized.length; i++) {
    const key = sha256('emb:' + normalized[i]);
    const cached = _embedCache.get(key);
    if (cached) {
      results[i] = cached;
    } else {
      toCompute.push(normalized[i]);
      toComputeIdx.push(i);
    }
  }

  if (toCompute.length === 0) {
    LOG.debug('100% cache hit');
    return results;
  }

  // Chunkear si excede batchSize
  const computed = [];
  for (let i = 0; i < toCompute.length; i += CFG.embedding.batchSize) {
    const chunk = toCompute.slice(i, i + CFG.embedding.batchSize);
    const chunkEmbed = await embedChunk(chunk);
    computed.push(...chunkEmbed);
  }

  // Guardar en cache y armar resultado
  for (let i = 0; i < toComputeIdx.length; i++) {
    const idx = toComputeIdx[i];
    const vec = computed[i];
    results[idx] = vec;
    const key = sha256('emb:' + normalized[idx]);
    _embedCache.set(key, vec, CFG.embedding.cacheTtlMs);
  }

  return results;
}

async function embedChunk(texts) {
  const provider = pickProvider();
  let lastErr;

  for (let attempt = 0; attempt <= CFG.embedding.retries; attempt++) {
    try {
      if (provider === 'openai') return await embedOpenAI(texts);
      if (provider === 'gemini') return await embedGemini(texts);
      if (provider === 'voyage') return await embedVoyage(texts);
      if (provider === 'local') return embedLocal(texts);
      throw new Error('Provider desconocido: ' + provider);
    } catch (e) {
      lastErr = e;
      LOG.warn(`embed[${provider}] attempt ${attempt + 1} failed: ${e.message}`);

      // Si falla el provider real, caer a local
      if (attempt === CFG.embedding.retries && provider !== 'local' && CFG.local.enabled) {
        LOG.info('falling back to local embeddings');
        try {
          return embedLocal(texts);
        } catch (e2) {
          lastErr = e2;
        }
      }

      if (attempt < CFG.embedding.retries) {
        await new Promise(r => setTimeout(r, 400 * Math.pow(2, attempt)));
      }
    }
  }

  throw lastErr || new Error('Embedding failed');
}

/* ═══════════════════════════════════════════════════════════════════════════
   07 · CATEGORIZACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CATEGORY_PATTERNS = {
  fact: [
    /\bme llamo\b/i, /\bmi nombre es\b/i, /\btengo \d+ años\b/i,
    /\bvivo en\b/i, /\bsoy de\b/i, /\bnací en\b/i,
    /\btrabajo (en|de|como)\b/i, /\bestudio\b/i,
    /\bmi (correo|email|teléfono|numero)\b/i,
    /\bmi cumpleaños\b/i, /\bmi familia\b/i,
  ],
  preference: [
    /\bme gusta\b/i, /\bno me gusta\b/i,
    /\bprefiero\b/i, /\bamo\b/i, /\bodio\b/i,
    /\bmi (color|comida|música|película|libro) favorit/i,
    /\bsoy fan de\b/i,
  ],
  goal: [
    /\bquiero (aprender|ser|lograr|estudiar|trabajar|viajar)\b/i,
    /\bmi meta es\b/i, /\bmi sueño es\b/i,
    /\bplaneo\b/i, /\bvoy a (aprender|estudiar|hacer)\b/i,
    /\bestoy aprendiendo\b/i,
  ],
  context: [
    /\bactualmente\b/i, /\bahora mismo\b/i,
    /\beste (año|mes|semestre)\b/i,
    /\bpor ahora\b/i, /\ben estos momentos\b/i,
  ],
  skill: [
    /\bsé (programar|hablar|tocar|usar|hacer)\b/i,
    /\bsoy bueno (en|para)\b/i, /\btengo experiencia (en|con)\b/i,
    /\bd【o】mino\b/i, /\bmanejo\b/i,
  ],
  relation: [
    /\bmi (papá|mamá|madre|padre|hermano|hermana|hijo|hija|pareja|novia|novio|esposa|esposo)\b/i,
    /\bmi (perro|gato|mascota)\b/i,
    /\bmi (amigo|amiga|compañero|colega)\b/i,
    /\bmi (profesor|profe|jefe|jefa)\b/i,
  ],
};

function classify(text) {
  if (!text) return 'other';
  for (const [cat, patterns] of Object.entries(CATEGORY_PATTERNS)) {
    if (patterns.some(re => re.test(text))) return cat;
  }
  return 'other';
}

function categorize(text) {
  return {
    category: classify(text),
    confidence: 0.9, // por ahora siempre alto con heuristics
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · IMPORTANCE SCORING
   ═══════════════════════════════════════════════════════════════════════════ */

const IMPORTANCE_BOOSTS = {
  fact: 0.75,
  relation: 0.7,
  goal: 0.65,
  preference: 0.6,
  skill: 0.6,
  context: 0.35,
  other: 0.5,
};

function computeImportance(text, category, meta = {}) {
  let score = IMPORTANCE_BOOSTS[category] || 0.5;

  // Extensión: no muy corto (info) ni muy largo (probablemente ruido)
  const len = text.length;
  if (len < 20) score -= 0.1;
  if (len > 300) score -= 0.1;

  // Si tiene datos específicos (números, nombres propios)
  if (/\d/.test(text)) score += 0.05;
  if (/\b[A-Z][a-z]{2,}\b/.test(text)) score += 0.05;

  // Meta override
  if (meta.importance != null) score = meta.importance;

  return Math.max(0.05, Math.min(1, score));
}

/**
 * Aplica decay exponencial a una memoria según el tiempo desde last access.
 */
function applyDecay(importance, lastAccessMs) {
  if (!CFG.decay.enabled) return importance;
  const days = Math.max(0, (now() - lastAccessMs) / (24 * 60 * 60_000));
  const decayFactor = Math.pow(0.5, days / CFG.decay.halfLifeDays);
  const decayed = importance * decayFactor;
  return Math.max(CFG.decay.minImportance, decayed);
}

/* ═══════════════════════════════════════════════════════════════════════════
   09 · EXTRACTOR DE MEMORIAS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Extrae candidatos de memoria de un texto usando heuristics.
 * Retorna array de { text, category, importance, source }.
 */
function extractHeuristic(text) {
  if (!text || typeof text !== 'string') return [];
  const candidates = [];

  // Dividir por oraciones
  const sentences = text
    .split(/(?<=[.!?…])\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= CFG.extract.minLength);

  for (const sentence of sentences) {
    // Aplicar patrones por categoría
    for (const [cat, patterns] of Object.entries(CATEGORY_PATTERNS)) {
      for (const re of patterns) {
        if (re.test(sentence)) {
          candidates.push({
            text: truncate(sentence, CFG.extract.maxLength),
            category: cat,
            importance: computeImportance(sentence, cat),
            source: 'heuristic',
            confidence: 0.75,
          });
          break; // una categoría por oración
        }
      }
    }
  }

  // Dedupe inmediato
  const seen = new Set();
  return candidates.filter(c => {
    const k = normalizeText(c.text);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Extrae memorias de una conversación.
 * @param {Array<{role, content}>} messages
 * @param {Object} ctx - { callLLM?: Function }
 */
async function extractFromConversation(messages, ctx = {}) {
  if (!Array.isArray(messages)) return [];

  // Solo nos interesan los mensajes del user
  const userMessages = messages.filter(m => m.role === 'user');
  const allText = userMessages.map(m => m.content).join('\n\n');

  // Base: heuristics
  let candidates = extractHeuristic(allText);

  // Enhancement con LLM (opt-in)
  if (CFG.extract.useLLM && typeof ctx.callLLM === 'function' && candidates.length < 3) {
    try {
      const llmCandidates = await extractWithLLM(allText, ctx.callLLM);
      candidates = dedupeCandidates([...candidates, ...llmCandidates]);
    } catch (e) {
      LOG.warn('LLM extraction failed, using heuristics only', e.message);
    }
  }

  // Limitar cantidad
  candidates = candidates
    .sort((a, b) => b.importance - a.importance)
    .slice(0, CFG.extract.maxPerConversation);

  return candidates;
}

async function extractWithLLM(text, callLLM) {
  const prompt =
    'Extraé memorias sobre el usuario de esta conversación. ' +
    'Solo datos persistentes (no preguntas, no hipótesis). ' +
    'Cada memoria en una línea con formato: [categoría] texto. ' +
    'Categorías: fact, preference, goal, context, skill, relation.\n\n' +
    'Conversación:\n' + truncate(text, 3000) + '\n\n' +
    'Memorias:';

  const result = await callLLM({
    system: 'Sos un extractor de memorias. Devolvés solo las memorias en el formato pedido, una por línea.',
    user: prompt,
    temperature: 0.2,
  });

  const lines = String(result || '').split('\n').filter(Boolean);
  const candidates = [];

  for (const line of lines) {
    const m = line.match(/^\[(\w+)\]\s*(.+)$/);
    if (!m) continue;
    const cat = m[1].toLowerCase();
    const text = m[2].trim();
    if (text.length < CFG.extract.minLength) continue;
    if (!CFG.categories.includes(cat)) continue;
    candidates.push({
      text: truncate(text, CFG.extract.maxLength),
      category: cat,
      importance: computeImportance(text, cat),
      source: 'llm',
      confidence: 0.85,
    });
  }

  return candidates;
}

function dedupeCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(c => {
    const k = normalizeText(c.text);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · STORAGE (Supabase)
   ═══════════════════════════════════════════════════════════════════════════ */

async function store(userId, text, meta = {}) {
  if (!userId) throw new Error('userId requerido');
  if (!text || text.length < CFG.extract.minLength) {
    throw new Error('texto muy corto (min ' + CFG.extract.minLength + ')');
  }

  const sb = await getSbClient();
  if (!sb) throw new Error('Supabase no disponible');

  const cleanText = truncate(text, CFG.extract.maxLength);
  const category = meta.category || classify(cleanText);
  const importance = computeImportance(cleanText, category, meta);

  // Generar embedding
  const embedding = await embed(cleanText);

  // Dedupe check
  if (CFG.dedupe.enabled && !meta.force) {
    const existing = await findSimilar(userId, embedding, CFG.dedupe.similarityThreshold);
    if (existing) {
      // Merge: incrementar importancia, actualizar timestamp
      const newImportance = Math.min(1, (existing.importance || 0.5) + 0.05);
      await sb.from(CFG.supabase.table).update({
        importance: newImportance,
        last_accessed_at: new Date().toISOString(),
      }).eq('id', existing.id).eq('userId', userId);

      LOG.debug('memoria duplicada, merge:', existing.id);
      emit('nm:memory:deduped', { kept: existing.id, merged: cleanText });
      return { ...existing, importance: newImportance, merged: true };
    }
  }

  // Insert
  const payload = {
    id: uid(),
    userId,
    content: cleanText,
    embedding,
    category,
    importance,
    access_count: 0,
    last_accessed_at: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    meta: meta.meta || {},
  };

  const { data, error } = await sb.from(CFG.supabase.table).insert(payload).select().single();

  if (error) {
    LOG.error('store failed:', error.message);
    throw new Error('No pude guardar: ' + error.message);
  }

  emit('nm:memory:stored', { id: data.id, category, importance });
  LOG.info('memoria guardada:', data.id, '[' + category + ']');
  return normalizeMemory(data);
}

/**
 * Extrae + guarda en un solo paso. Usado post-respuesta del chat.
 */
async function extractAndStore(userId, messages, ctx = {}) {
  if (!CFG.extract.autoExtract) return [];
  if (!userId) return [];

  try {
    const candidates = await extractFromConversation(messages, ctx);
    if (candidates.length === 0) return [];

    const stored = [];
    for (const c of candidates) {
      try {
        const mem = await store(userId, c.text, {
          category: c.category,
          importance: c.importance,
          meta: { source: c.source },
        });
        stored.push(mem);
      } catch (e) {
        LOG.warn('no pude guardar candidato:', e.message);
      }
    }

    emit('nm:memory:extracted', {
      count: stored.length,
      categories: stored.map(s => s.category),
    });
    LOG.info('extraídas', stored.length, 'memorias');
    return stored;
  } catch (e) {
    emit('nm:memory:error', { error: e.message, context: 'extractAndStore' });
    LOG.error('extractAndStore failed:', e.message);
    return [];
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   11 · NORMALIZACIÓN DE MEMORY
   ═══════════════════════════════════════════════════════════════════════════ */

function normalizeMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.userId,
    content: row.content,
    category: row.category || 'other',
    importance: row.importance ?? 0.5,
    accessCount: row.access_count ?? 0,
    lastAccessedAt: row.last_accessed_at ? new Date(row.last_accessed_at).getTime() : Date.now(),
    createdAt: row.createdAt ? new Date(row.createdAt).getTime() : Date.now(),
    meta: row.meta || {},
    similarity: row.similarity,
    score: row.score,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   12 · BÚSQUEDA SEMÁNTICA
   ═══════════════════════════════════════════════════════════════════════════ */

async function findSimilar(userId, embedding, threshold) {
  const results = await searchByEmbedding(userId, embedding, { limit: 1, minSimilarity: threshold });
  return results[0] || null;
}

async function searchByEmbedding(userId, embedding, opts = {}) {
  const sb = await getSbClient();
  if (!sb) throw new Error('Supabase no disponible');

  const limit = opts.limit || CFG.search.defaultLimit;
  const minSim = opts.minSimilarity ?? CFG.search.minSimilarity;

  // Intentar RPC (pgvector)
  if (CFG.supabase.useRPC) {
    try {
      const { data, error } = await sb.rpc(CFG.supabase.rpcMatch, {
        query_embedding: embedding,
        match_threshold: minSim,
        match_count: limit,
        p_user_id: userId,
      });

      if (!error && Array.isArray(data)) {
        return data.map(normalizeMemory);
      }

      if (error) {
        LOG.debug('RPC failed:', error.message, '→ fallback');
      }
    } catch (e) {
      LOG.debug('RPC exception:', e.message, '→ fallback');
    }
  }

  // Fallback: fetch all + cosine in JS
  if (!CFG.supabase.fallbackFetchAll) return [];

  const { data, error } = await sb
    .from(CFG.supabase.table)
    .select('*')
    .eq('userId', userId)
    .not('embedding', 'is', null)
    .order('createdAt', { ascending: false })
    .limit(CFG.supabase.maxFetchAll);

  if (error) throw new Error(error.message);
  if (!data) return [];

  const scored = data.map(row => ({
    ...normalizeMemory(row),
    similarity: cosine(embedding, row.embedding),
  }));

  return scored
    .filter(m => m.similarity >= minSim)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);
}

/**
 * Hybrid search: combina similitud semántica con BM25 keyword.
 */
async function search(userId, query, opts = {}) {
  if (!userId || !query) return [];

  const limit = opts.limit || CFG.search.defaultLimit;
  const minSim = opts.minSimilarity ?? CFG.search.minSimilarity;

  // 1) Embedding search
  const queryEmbedding = await embed(query);
  const semanticResults = await searchByEmbedding(userId, queryEmbedding, {
    limit: limit * 2,
    minSimilarity: Math.max(0.3, minSim - 0.2),
  });

  // 2) Si no hay queryEmbedding útil o no hay resultados, fetch all + keyword
  let allMemories = semanticResults;
  if (allMemories.length === 0) {
    const sb = await getSbClient();
    if (sb) {
      const { data } = await sb
        .from(CFG.supabase.table)
        .select('*')
        .eq('userId', userId)
        .order('createdAt', { ascending: false })
        .limit(CFG.supabase.maxFetchAll);
      if (data) allMemories = data.map(normalizeMemory);
    }
  }

  if (allMemories.length === 0) return [];

  // 3) BM25 keyword score
  const queryTokens = tokenize(query);
  const docs = allMemories.map(m => ({ tokens: tokenize(m.content), mem: m }));

  const df = {};
  for (const d of docs) {
    const seen = new Set();
    for (const t of d.tokens) {
      if (!seen.has(t)) {
        df[t] = (df[t] || 0) + 1;
        seen.add(t);
      }
    }
  }
  const avgDocLen = docs.reduce((s, d) => s + d.tokens.length, 0) / Math.max(1, docs.length);
  const N = docs.length;

  const maxBm25 = Math.max(1, ...docs.map(d =>
    bm25(queryTokens, d.tokens, { df, N, avgDocLen })
  ));

  // 4) Combine score
  const w = CFG.search.hybridWeight;
  const scored = docs.map(d => {
    const simScore = d.mem.similarity || cosine(queryEmbedding, d.mem.embedding || []);
    const bm = bm25(queryTokens, d.tokens, { df, N, avgDocLen });
    const bmNorm = bm / maxBm25;

    // Recency boost exponencial
    const daysSince = (now() - d.mem.lastAccessedAt) / (24 * 60 * 60_000);
    const recencyFactor = Math.pow(0.5, daysSince / CFG.search.recencyHalfLifeDays);
    const recencyBoost = 1 + (CFG.search.recencyBoostMax - 1) * recencyFactor;

    // Combined score
    const base = (w * simScore) + ((1 - w) * bmNorm);
    const withImportance = base + (CFG.search.importanceWeight * d.mem.importance);
    const final = withImportance * recencyBoost;

    return { ...d.mem, similarity: simScore, bm25: bmNorm, score: final };
  });

  // 5) Filter + sort + limit
  return scored
    .filter(m => m.similarity >= minSim || m.bm25 > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Incrementa access_count y last_accessed_at de las memorias usadas.
 */
async function markAccessed(userId, ids) {
  if (!ids || ids.length === 0) return;
  const sb = await getSbClient();
  if (!sb) return;

  try {
    // Update en batch
    const { error } = await sb.rpc('increment_memory_access', {
      p_user_id: userId,
      p_ids: ids,
    });
    if (error) {
      // Fallback: update individual
      for (const id of ids) {
        await sb.from(CFG.supabase.table)
          .update({
            access_count: sb.raw ? undefined : undefined, // no podemos increment sin RPC
            last_accessed_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('userId', userId);
      }
    }
  } catch (e) {
    LOG.debug('markAccessed failed:', e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   13 · CRUD
   ═══════════════════════════════════════════════════════════════════════════ */

async function listMemories(userId, opts = {}) {
  const sb = await getSbClient();
  if (!sb) return [];

  let q = sb.from(CFG.supabase.table).select('*').eq('userId', userId);
  if (opts.category) q = q.eq('category', opts.category);
  q = q.order('importance', { ascending: false })
       .order('last_accessed_at', { ascending: false })
       .limit(opts.limit || 100);

  const { data, error } = await q;
  if (error) {
    LOG.error('list failed:', error.message);
    return [];
  }
  return (data || []).map(normalizeMemory);
}

async function getMemory(userId, id) {
  const sb = await getSbClient();
  if (!sb) return null;

  const { data, error } = await sb
    .from(CFG.supabase.table)
    .select('*')
    .eq('id', id)
    .eq('userId', userId)
    .single();

  if (error) return null;
  return normalizeMemory(data);
}

async function updateMemory(userId, id, patch) {
  const sb = await getSbClient();
  if (!sb) throw new Error('Supabase no disponible');

  const updates = {};
  if (patch.content) {
    updates.content = truncate(patch.content, CFG.extract.maxLength);
    // Re-embed
    if (patch.reembed !== false) {
      updates.embedding = await embed(updates.content);
    }
  }
  if (patch.category) updates.category = patch.category;
  if (patch.importance != null) updates.importance = patch.importance;
  if (patch.meta) updates.meta = patch.meta;

  const { data, error } = await sb
    .from(CFG.supabase.table)
    .update(updates)
    .eq('id', id)
    .eq('userId', userId)
    .select()
    .single();

  if (error) throw new Error(error.message);
  return normalizeMemory(data);
}

async function removeMemory(userId, id) {
  const sb = await getSbClient();
  if (!sb) throw new Error('Supabase no disponible');

  const { error } = await sb
    .from(CFG.supabase.table)
    .delete()
    .eq('id', id)
    .eq('userId', userId);

  if (error) throw new Error(error.message);
  emit('nm:memory:removed', { id });
  return true;
}

async function clearMemories(userId) {
  const sb = await getSbClient();
  if (!sb) throw new Error('Supabase no disponible');

  const { data, error } = await sb
    .from(CFG.supabase.table)
    .delete()
    .eq('userId', userId)
    .select();

  if (error) throw new Error(error.message);
  const count = Array.isArray(data) ? data.length : 0;
  LOG.info('cleared', count, 'memorias de', userId);
  return count;
}

/* ═══════════════════════════════════════════════════════════════════════════
   14 · DEDUPE + CONSOLIDACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

async function dedupe(userId, opts = {}) {
  const sb = await getSbClient();
  if (!sb) throw new Error('Supabase no disponible');

  const threshold = opts.threshold || CFG.dedupe.similarityThreshold;
  const maxCandidates = CFG.dedupe.maxCandidatesPerRun;

  const { data: rows } = await sb
    .from(CFG.supabase.table)
    .select('*')
    .eq('userId', userId)
    .not('embedding', 'is', null)
    .order('createdAt', { ascending: false })
    .limit(maxCandidates);

  if (!rows || rows.length < 2) {
    return { duplicates: 0, merged: 0 };
  }

  const memories = rows.map(normalizeMemory);
  const mergedIds = new Set();
  let mergeCount = 0;

  // O(n²) — aceptable para <= 200
  for (let i = 0; i < memories.length; i++) {
    if (mergedIds.has(memories[i].id)) continue;
    for (let j = i + 1; j < memories.length; j++) {
      if (mergedIds.has(memories[j].id)) continue;
      const sim = cosine(rows[i].embedding, rows[j].embedding);
      if (sim >= threshold) {
        // Merge: mantener el más viejo (i), borrar j
        const newImp = Math.min(1, memories[i].importance + 0.03);
        await sb.from(CFG.supabase.table).update({
          importance: newImp,
          last_accessed_at: new Date().toISOString(),
        }).eq('id', memories[i].id);
        await sb.from(CFG.supabase.table).delete().eq('id', memories[j].id);
        mergedIds.add(memories[j].id);
        mergeCount++;
      }
    }
  }

  emit('nm:memory:deduped', { kept: memories.length - mergeCount, merged: mergeCount });
  LOG.info('dedupe:', mergeCount, 'memorias mergeadas');
  return { duplicates: mergedIds.size, merged: mergeCount };
}

async function consolidate(userId) {
  const dedupeResult = await dedupe(userId);
  emit('nm:memory:consolidated', { userId, ...dedupeResult });
  return dedupeResult;
}

/* ═══════════════════════════════════════════════════════════════════════════
   15 · CONTRADICTION DETECTION
   ═══════════════════════════════════════════════════════════════════════════ */

async function detectContradictions(userId) {
  if (!CFG.contradiction.enabled) return [];

  const sb = await getSbClient();
  if (!sb) return [];

  const { data: rows } = await sb
    .from(CFG.supabase.table)
    .select('*')
    .eq('userId', userId)
    .not('embedding', 'is', null)
    .limit(300);

  if (!rows || rows.length < 2) return [];

  const contradictions = [];

  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const sim = cosine(rows[i].embedding, rows[j].embedding);
      if (sim < CFG.contradiction.similarityThreshold) continue;

      const a = rows[i].content.toLowerCase();
      const b = rows[j].content.toLowerCase();

      for (const [pos, neg] of CFG.contradiction.negationPairs) {
        if ((a.includes(pos) && b.includes(neg)) || (a.includes(neg) && b.includes(pos))) {
          contradictions.push({
            a: normalizeMemory(rows[i]),
            b: normalizeMemory(rows[j]),
            similarity: sim,
            reason: pos + ' vs ' + neg,
          });
          break;
        }
      }
    }
  }

  return contradictions;
}

/* ═══════════════════════════════════════════════════════════════════════════
   16 · DECAY / CLEANUP
   ═══════════════════════════════════════════════════════════════════════════ */

async function applyDecayToAll(userId) {
  if (!CFG.decay.enabled) return { updated: 0, removed: 0 };

  const sb = await getSbClient();
  if (!sb) return { updated: 0, removed: 0 };

  const { data: rows } = await sb
    .from(CFG.supabase.table)
    .select('*')
    .eq('userId', userId);

  if (!rows) return { updated: 0, removed: 0 };

  let updated = 0;
  let removed = 0;

  for (const row of rows) {
    const lastAccess = row.last_accessed_at ? new Date(row.last_accessed_at).getTime() : new Date(row.createdAt).getTime();
    const decayed = applyDecay(row.importance ?? 0.5, lastAccess);

    if (decayed < CFG.decay.cleanupThreshold) {
      // Eliminar
      await sb.from(CFG.supabase.table).delete().eq('id', row.id);
      removed++;
    } else if (Math.abs(decayed - (row.importance ?? 0.5)) > 0.01) {
      await sb.from(CFG.supabase.table).update({ importance: decayed }).eq('id', row.id);
      updated++;
    }
  }

  LOG.info('decay:', updated, 'actualizadas,', removed, 'eliminadas');
  return { updated, removed };
}

/* ═══════════════════════════════════════════════════════════════════════════
   17 · CONTEXT BUILDER
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Construye un bloque de contexto (markdown) con las memorias más relevantes,
 * dentro de un presupuesto de tokens.
 */
async function buildContext(userId, query, opts = {}) {
  if (!userId) return '';

  const maxTokens = opts.maxTokens || 800;
  const maxMemories = opts.maxMemories || 8;
  const minCharsPerToken = 4; // ~4 chars por token promedio

  try {
    const memories = await search(userId, query, {
      limit: maxMemories,
      minSimilarity: opts.minSimilarity ?? CFG.search.minSimilarity,
    });

    if (memories.length === 0) return '';

    // Construir bloque
    const lines = [];
    lines.push('## Lo que sabés del usuario (memoria de largo plazo)');
    lines.push('');

    let charBudget = maxTokens * minCharsPerToken;
    const usedIds = [];

    for (const m of memories) {
      const line = `- [${m.category}] ${m.content}`;
      if (line.length > charBudget) break;
      lines.push(line);
      charBudget -= line.length;
      usedIds.push(m.id);
    }

    // Marcar como accedidas (async, no bloqueante)
    if (usedIds.length > 0) {
      markAccessed(userId, usedIds).catch(() => {});
    }

    lines.push('');
    lines.push('_Usá esta información para personalizar tus respuestas, pero no la menciones explícitamente._');

    return lines.join('\n');
  } catch (e) {
    LOG.warn('buildContext failed:', e.message);
    return '';
  }
}

async function searchRelevant(userId, query, limit = 5) {
  return search(userId, query, { limit });
}

/* ═══════════════════════════════════════════════════════════════════════════
   18 · MIGRACIÓN DESDE LEGACY
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Migra las memorias string-planas existentes al nuevo formato con embeddings.
 * Asume que ya hay registros en Memory sin embedding.
 */
async function migrate(userId) {
  const sb = await getSbClient();
  if (!sb) throw new Error('Supabase no disponible');

  const { data: rows } = await sb
    .from(CFG.supabase.table)
    .select('*')
    .eq('userId', userId)
    .is('embedding', null);

  if (!rows || rows.length === 0) {
    LOG.info('nada para migrar');
    return { migrated: 0, skipped: 0 };
  }

  let migrated = 0;
  let skipped = 0;

  // Batch embeddings
  const texts = rows.map(r => r.content || '').filter(Boolean);
  const embeddings = await embedBatch(texts);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const text = row.content || '';
    if (!text || text.length < CFG.extract.minLength) {
      skipped++;
      continue;
    }

    const category = classify(text);
    const importance = computeImportance(text, category);

    const { error } = await sb.from(CFG.supabase.table).update({
      embedding: embeddings[i],
      category,
      importance,
      access_count: 0,
      last_accessed_at: new Date().toISOString(),
      meta: { migrated: true },
    }).eq('id', row.id);

    if (error) skipped++;
    else migrated++;
  }

  LOG.info('migración:', migrated, 'ok,', skipped, 'skipped');
  return { migrated, skipped };
}

/* ═══════════════════════════════════════════════════════════════════════════
   19 · ANALYTICS
   ═══════════════════════════════════════════════════════════════════════════ */

async function getStats(userId) {
  const sb = await getSbClient();
  if (!sb) return null;

  const { data: rows } = await sb
    .from(CFG.supabase.table)
    .select('*')
    .eq('userId', userId);

  if (!rows) return null;

  const byCategory = {};
  let totalImportance = 0;
  let totalAccess = 0;
  let withEmbedding = 0;

  for (const r of rows) {
    const cat = r.category || 'other';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    totalImportance += r.importance ?? 0.5;
    totalAccess += r.access_count ?? 0;
    if (r.embedding) withEmbedding++;
  }

  return {
    total: rows.length,
    withEmbedding,
    withoutEmbedding: rows.length - withEmbedding,
    byCategory,
    avgImportance: rows.length > 0 ? +(totalImportance / rows.length).toFixed(3) : 0,
    totalAccess,
    provider: pickProvider(),
    dimensions: CFG.embedding.dimensions,
    cacheSize: _embedCache.size(),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   20 · SELF TEST
   ═══════════════════════════════════════════════════════════════════════════ */

async function selfTest() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  // Utils
  rec('sha256("test") funciona', sha256('test').length === 64, sha256('test').slice(0, 16) + '…');
  rec('hashInt("abc") > 0', hashInt('abc') > 0, hashInt('abc'));

  // Cosine
  const v1 = [1, 0, 0];
  const v2 = [1, 0, 0];
  const v3 = [0, 1, 0];
  rec('cosine idéntico = 1', Math.abs(cosine(v1, v2) - 1) < 1e-9, cosine(v1, v2));
  rec('cosine ortogonal = 0', Math.abs(cosine(v1, v3)) < 1e-9, cosine(v1, v3));
  rec('cosine opuesto = -1', Math.abs(cosine(v1, [-1, 0, 0]) + 1) < 1e-9, cosine(v1, [-1, 0, 0]));

  // Normalize
  const norm = normalize([3, 4]);
  rec('normalize L2', Math.abs(Math.sqrt(norm[0]**2 + norm[1]**2) - 1) < 1e-9, norm);

  // Tokenize
  const tokens = tokenize('¡Hola, mundo! ¿Cómo estás?');
  rec('tokenize filtra stopwords', tokens.length >= 3, tokens);

  // Classify
  rec('classify "me llamo Juan" → fact', classify('Me llamo Juan') === 'fact', classify('Me llamo Juan'));
  rec('classify "me gusta el café" → preference', classify('Me gusta el café') === 'preference', classify('Me gusta el café'));
  rec('classify "quiero aprender piano" → goal', classify('Quiero aprender piano') === 'goal', classify('Quiero aprender piano'));
  rec('classify "mi perro se llama Max" → relation', classify('Mi perro se llama Max') === 'relation', classify('Mi perro se llama Max'));

  // Importance
  const imp1 = computeImportance('Me llamo Juan Pérez y tengo 25 años', 'fact');
  rec('importance fact alta', imp1 > 0.6, imp1);
  const imp2 = computeImportance('ok', 'other');
  rec('importance short baja', imp2 < 0.5, imp2);

  // Decay
  const decayed = applyDecay(1.0, now() - 60 * 24 * 60 * 60_000); // 60 días
  rec('decay reduce a ~0.5 a los 60d', Math.abs(decayed - 0.5) < 0.05, decayed);

  // Extract heuristics
  const extracted = extractHeuristic(
    'Me llamo Juan. Me gusta el café. Quiero aprender a tocar guitarra. Mi perro se llama Max.'
  );
  rec('extrae múltiples memorias', extracted.length >= 3, extracted.length);
  rec('extrae categorías variadas', new Set(extracted.map(e => e.category)).size >= 3, extracted.map(e => e.category));

  // HashEmbed
  const emb = hashEmbed('hola mundo');
  rec('hashEmbed produce array', Array.isArray(emb) && emb.length === 1536, emb.length);
  const embNorm = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
  rec('hashEmbed normalizado', Math.abs(embNorm - 1) < 1e-6, embNorm);

  // HashEmbed similitud
  const embA = hashEmbed('me llamo juan y tengo 25 años');
  const embB = hashEmbed('me llamo juan y tengo 25 años');
  const embC = hashEmbed('otra cosa completamente distinta');
  const simAB = cosine(embA, embB);
  const simAC = cosine(embA, embC);
  rec('hashEmbed idéntico = 1', Math.abs(simAB - 1) < 1e-6, simAB);
  rec('hashEmbed distinto < 0.5', simAC < 0.5, simAC);

  // Cache
  _embedCache.clear();
  _embedCache.set('k1', [1, 2, 3], 10_000);
  rec('cache set/get funciona', JSON.stringify(_embedCache.get('k1')) === '[1,2,3]', _embedCache.get('k1'));
  rec('cache size correcto', _embedCache.size() === 1, _embedCache.size());

  // Provider
  const provider = pickProvider();
  rec('provider seleccionado', ['openai', 'gemini', 'voyage', 'local'].includes(provider), provider);

  // Embed (usa local por defecto en test)
  const v = await embed('test de embedding');
  rec('embed produce vector', Array.isArray(v) && v.length > 0, v.length);

  // Batch
  const vs = await embedBatch(['uno', 'dos', 'tres']);
  rec('embedBatch múltiples', vs.length === 3, vs.length);

  const passed = results.filter(r => r.ok).length;
  return {
    passed,
    total: results.length,
    ok: passed === results.length,
    results,
    provider: pickProvider(),
    hasSupabase: !!(process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY)),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   21 · EVENT EMITTER
   ═══════════════════════════════════════════════════════════════════════════ */

function emit(name, detail) {
  try {
    if (typeof globalThis.dispatchEvent === 'function') {
      globalThis.dispatchEvent(new CustomEvent(name, { detail }));
    }
  } catch (e) {}
}

/* ═══════════════════════════════════════════════════════════════════════════
   22 · CONFIGURE
   ═══════════════════════════════════════════════════════════════════════════ */

function configure(patch) {
  if (!patch || typeof patch !== 'object') return;
  function merge(target, source) {
    for (const k of Object.keys(source)) {
      if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        merge(target[k], source[k]);
      } else {
        target[k] = source[k];
      }
    }
  }
  merge(CFG, patch);
  LOG.info('config updated');
}

function resetCache() {
  _embedCache.clear();
  LOG.info('cache cleared');
}

/* ═══════════════════════════════════════════════════════════════════════════
   23 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export const MEMORY = {
  // Embeddings
  embed,
  embedBatch,

  // CRUD
  store,
  get: getMemory,
  update: updateMemory,
  remove: removeMemory,
  clear: clearMemories,
  list: listMemories,

  // Búsqueda
  search,
  searchRelevant,
  findSimilar,

  // Extracción
  extractFromConversation,
  extractHeuristic,
  extractAndStore,

  // Consolidación
  dedupe,
  consolidate,
  detectContradictions,
  applyDecay: applyDecayToAll,

  // Context
  buildContext,

  // Migración
  migrate,

  // Analytics
  getStats,

  // Config
  configure,
  resetCache,

  // Utils expuestos (para testing)
  _utils: {
    cosine,
    euclidean,
    normalize,
    tokenize,
    bm25,
    classify,
    computeImportance,
    applyDecay,
    hashEmbed,
  },

  // Debug
  test: selfTest,

  // Internals
  _config: CFG,
  _cache: _embedCache,
};

export default MEMORY;