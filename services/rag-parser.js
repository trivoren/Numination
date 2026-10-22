/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/rag-parser.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Pipeline RAG: PDF → texto → chunks → embeddings.

   PASOS
     1 · Extracción con `pdf-parse` (a texto plano + nº de páginas).
     2 · Troceado en chunks de ~500 tokens con solapamiento (overlap)
        para que una frase partida entre dos chunks siga siendo
        recuperable.
     3 · Embeddings listos para insertar: se calcula el vector de cada
        chunk con OpenAI (`text-embedding-3-small`, 1536 dims). Si no
        hay clave, se genera un vector determinista por hashing: NO es
        semántico, pero mantiene el pipeline funcionando y queda
        marcado como `provider: 'local'`.

   CONTRATO
     parsePDF(buffer)              → { text, numPages, chunks }
     chunkText(text, options)      → [{ index, text, tokens }]
     prepareEmbeddings(chunks)     → { chunks, model, provider }
     parseAndChunk(buffer, options)→ { text, numPages, chunks, model, provider }
   ═══════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import pdfParse from 'pdf-parse';
import { LOG } from '../src/lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  maxTokens: 500,
  overlapTokens: 60,
  embeddingDim: 1536,
  embeddingModel: 'text-embedding-3-small',
  embeddingUrl: 'https://api.openai.com/v1/embeddings',
  batchSize: 16,
  timeoutMs: 30_000,
  avgCharsPerToken: 4,
});

/* ═══════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Estimación de tokens (≈ caracteres/4, con mínimo por palabra).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const value = String(text ?? '');
  if (!value.trim()) return 0;

  const chars = Math.ceil(value.length / CFG.avgCharsPerToken);
  const words = value.trim().split(/\s+/).length;

  return Math.max(chars, Math.ceil(words * 1.3));
}

/**
 * Divide el texto en frases/párrafos conservando el orden.
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  const value = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!value) return [];

  const parts = [];
  let buffer = '';

  for (const rawLine of value.split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      if (buffer) { parts.push(buffer); buffer = ''; }
      continue;
    }

    const sentences = line.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g) || [line];

    for (const sentence of sentences) {
      const piece = sentence.trim();
      if (!piece) continue;

      if (buffer.length + piece.length + 1 > CFG.maxTokens * CFG.avgCharsPerToken) {
        if (buffer) parts.push(buffer);
        buffer = piece;
      } else {
        buffer = buffer ? `${buffer} ${piece}` : piece;
      }
    }
  }

  if (buffer) parts.push(buffer);

  return parts.filter((p) => p.trim().length > 0);
}

/* ═══════════════════════════════════════════════════════════════════════
   03 · EXTRACCIÓN
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Extrae el texto de un PDF.
 * @param {Buffer|Uint8Array|string} buffer
 * @returns {Promise<{text:string, numPages:number, info:object}>}
 */
export async function parsePDF(buffer) {
  if (!buffer || (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array) && typeof buffer !== 'string')) {
    const error = new Error('parsePDF necesita un buffer PDF.');
    error.code = 'INVALID_PDF';
    throw error;
  }

  try {
    const data = await pdfParse(buffer);

    const text = String(data?.text ?? '').replace(/\n{3,}/g, '\n\n').trim();

    return {
      text,
      numPages: Number(data?.numpages ?? 0),
      info: data?.info ?? {},
    };
  } catch (e) {
    LOG.warn('rag-parser: no se pudo leer el PDF', { error: e.message });
    const error = new Error('El PDF no se pudo procesar.');
    error.code = 'PDF_PARSE_FAILED';
    error.cause = e;
    throw error;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   04 · TROCEADO
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Trocea el texto en chunks de `maxTokens` con solapamiento.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.maxTokens]
 * @param {number} [options.overlapTokens]
 * @returns {Array<{index:number, text:string, tokens:number}>}
 */
export function chunkText(text, options = {}) {
  const maxTokens = Number.isFinite(options.maxTokens) ? options.maxTokens : CFG.maxTokens;
  const overlapTokens = Number.isFinite(options.overlapTokens)
    ? options.overlapTokens
    : CFG.overlapTokens;

  const value = String(text ?? '').trim();
  if (!value) return [];

  const sentences = splitSentences(value);
  const chunks = [];

  let buffer = '';
  let bufferTokens = 0;

  const push = () => {
    const chunkTextValue = buffer.trim();
    if (!chunkTextValue) return;
    chunks.push({
      index: chunks.length,
      text: chunkTextValue,
      tokens: estimateTokens(chunkTextValue),
    });
  };

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);

    // Un chunk se cierra al llegar al límite…
    if (bufferTokens + sentenceTokens > maxTokens && buffer) {
      push();

      // …y el nuevo chunk arranca con el solapamiento del anterior.
      const overlapChars = Math.max(0, overlapTokens * CFG.avgCharsPerToken);
      const tail = buffer.slice(-overlapChars).trim();
      buffer = tail ? `${tail} ${sentence}` : sentence;
      bufferTokens = estimateTokens(buffer);
      continue;
    }

    buffer = buffer ? `${buffer} ${sentence}` : sentence;
    bufferTokens += sentenceTokens;
  }

  push();

  return chunks;
}

/* ═══════════════════════════════════════════════════════════════════════
   05 · EMBEDDINGS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Vector determinista por hashing (respaldo sin API).
 * @param {string} text
 * @param {number} dim
 * @returns {number[]}
 */
export function hashEmbedding(text, dim = CFG.embeddingDim) {
  const vector = new Array(dim).fill(0);
  const words = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);

  if (!words.length) return vector;

  for (const word of words) {
    const digest = crypto.createHash('sha256').update(word).digest();
    for (let i = 0; i < digest.length; i += 2) {
      const index = ((digest[i] << 8) | digest[i + 1]) % dim;
      vector[index] += 1;
    }
  }

  const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0)) || 1;
  return vector.map((v) => v / norm);
}

/**
 * Calcula los embeddings de los chunks con OpenAI.
 * @param {Array} chunks
 * @param {object} [options]
 * @returns {Promise<{chunks:Array, model:string, provider:string}>}
 */
export async function prepareEmbeddings(chunks, options = {}) {
  const list = Array.isArray(chunks) ? chunks : [];
  if (!list.length) {
    return { chunks: [], model: 'none', provider: 'none' };
  }

  const apiKey = options.apiKey || process.env.OPENAI_API_KEY;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (!apiKey || typeof fetchImpl !== 'function') {
    return {
      chunks: list.map((chunk) => ({
        ...chunk,
        embedding: hashEmbedding(chunk.text, CFG.embeddingDim),
      })),
      model: 'hash-fallback',
      provider: 'local',
    };
  }

  const model = options.model || CFG.embeddingModel;
  const vectors = [];

  try {
    for (let i = 0; i < list.length; i += CFG.batchSize) {
      const batch = list.slice(i, i + CFG.batchSize);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

      try {
        const res = await fetchImpl(CFG.embeddingUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            input: batch.map((c) => c.text),
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Embeddings ${res.status}: ${body.slice(0, 160)}`);
        }

        const data = await res.json();
        const items = Array.isArray(data?.data) ? data.data : [];
        for (const item of items) {
          vectors.push(Array.isArray(item?.embedding) ? item.embedding : null);
        }
      } finally {
        clearTimeout(timer);
      }
    }

    if (vectors.length !== list.length) {
      throw new Error(`Embeddings incompletos: ${vectors.length}/${list.length}`);
    }

    return {
      chunks: list.map((chunk, i) => ({ ...chunk, embedding: vectors[i] })),
      model,
      provider: 'openai',
    };
  } catch (e) {
    LOG.warn('rag-parser: falló el cálculo de embeddings, se usa el respaldo local', {
      error: e.message,
    });
    return {
      chunks: list.map((chunk) => ({
        ...chunk,
        embedding: hashEmbedding(chunk.text, CFG.embeddingDim),
      })),
      model: 'hash-fallback',
      provider: 'local',
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   06 · PIPELINE COMPLETO
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * PDF → texto → chunks → embeddings.
 *
 * @param {Buffer|Uint8Array} buffer
 * @param {object} [options]
 * @returns {Promise<{text:string, numPages:number, chunks:Array,
 *                    model:string, provider:string}>}
 */
export async function parseAndChunk(buffer, options = {}) {
  try {
    const { text, numPages, info } = await parsePDF(buffer);
    const chunks = chunkText(text, options);
    const embedded = await prepareEmbeddings(chunks, options);

    return {
      text,
      numPages,
      info,
      chunks: embedded.chunks,
      model: embedded.model,
      provider: embedded.provider,
    };
  } catch (e) {
    LOG.error('rag-parser: fallo en el pipeline', { error: e.message });
    throw e;
  }
}

export default {
  parsePDF,
  chunkText,
  prepareEmbeddings,
  parseAndChunk,
  estimateTokens,
  hashEmbedding,
};
