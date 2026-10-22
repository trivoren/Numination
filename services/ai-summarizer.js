/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/ai-summarizer.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Resumen del historial largo para ahorrar tokens.

   REGLA
     · Con más de 40 mensajes, los primeros 30 se sustituyen por un
       resumen generado con Groq (el motor más barato y rápido).
     · El resumen se cachea por hash del contenido: si el mismo bloque
       de mensajes vuelve a aparecer, no se vuelve a pagar la llamada.

   CONTRATO
     summarizeHistory(history, options)
       → { summarized, summary, messages, replacedCount, tokensSaved, cached }
   ═══════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { LOG } from '../src/lib/logger.js';
import { callGroq } from './ai-orchestrator.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  threshold: 40,      // a partir de este número de mensajes se resume
  summarizeCount: 30, // cuántos mensajes iniciales se condensan
  cacheTtlMs: 30 * 60 * 1000,
  cacheMax: 200,
  maxSummaryTokens: 400,
  charsPerToken: 4,
});

const cache = new Map(); // hash → { summary, at }

/* ═══════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Estimación de tokens por longitud (≈4 caracteres por token).
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const value = String(text ?? '');
  if (!value) return 0;
  return Math.ceil(value.length / CFG.charsPerToken);
}

/**
 * Hash estable del bloque de mensajes a resumir.
 * @param {Array} messages
 * @returns {string}
 */
export function hashMessages(messages) {
  const payload = JSON.stringify(
    (Array.isArray(messages) ? messages : []).map((m) => ({
      r: m?.role ?? '',
      c: String(m?.content ?? ''),
    }))
  );
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function cacheGet(hash) {
  const hit = cache.get(hash);
  if (!hit) return null;
  if (Date.now() - hit.at > CFG.cacheTtlMs) {
    cache.delete(hash);
    return null;
  }
  return hit.summary;
}

function cacheSet(hash, summary) {
  if (cache.size >= CFG.cacheMax) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(hash, { summary, at: Date.now() });
}

/** Limpia la caché de resúmenes. */
export function clearSummaryCache() {
  cache.clear();
}

/** Estadísticas de la caché. */
export function getSummaryCacheStats() {
  return { size: cache.size, ttlMs: CFG.cacheTtlMs, max: CFG.cacheMax };
}

/* ═══════════════════════════════════════════════════════════════════════
   03 · RESUMEN
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Construye el texto plano que se envía al modelo.
 * @param {Array} messages
 * @returns {string}
 */
function toPlainText(messages) {
  return messages
    .map((m) => {
      const role = m?.role === 'assistant' || m?.role === 'ai' ? 'assistant' : 'user';
      return `${role.toUpperCase()}: ${String(m?.content ?? '').trim()}`;
    })
    .filter((t) => t.length > 6)
    .join('\n\n');
}

const SUMMARY_SYSTEM =
  'Eres un resumidor técnico. Condensa la conversación manteniendo: ' +
  'decisiones tomadas, datos concretos, nombres de archivos/código, ' +
  'preguntas abiertas y el objetivo del usuario. No inventes ni comentes. ' +
  'Responde en el idioma de la conversación, en un máximo de 8 frases.';

/**
 * Resume los primeros `summarizeCount` mensajes del historial.
 *
 * @param {Array}  history    Historial completo [{ role, content }].
 * @param {object} [options]
 * @param {number} [options.threshold]
 * @param {number} [options.summarizeCount]
 * @param {Function}[options.fetchImpl]
 * @returns {Promise<{summarized:boolean, summary:string|null, messages:Array,
 *                    replacedCount:number, tokensSaved:number, cached:boolean}>}
 */
export async function summarizeHistory(history, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : CFG.threshold;
  const summarizeCount = Number.isFinite(options.summarizeCount)
    ? options.summarizeCount
    : CFG.summarizeCount;

  const messages = Array.isArray(history) ? history : [];

  const result = {
    summarized: false,
    summary: null,
    messages: [...messages],
    replacedCount: 0,
    tokensSaved: 0,
    cached: false,
  };

  if (messages.length <= threshold) return result;

  const head = messages.slice(0, summarizeCount);
  const tail = messages.slice(summarizeCount);
  const hash = hashMessages(head);

  const cachedSummary = cacheGet(hash);
  let summary = cachedSummary;
  result.cached = Boolean(cachedSummary);

  if (!summary) {
    const plain = toPlainText(head);
    if (!plain.trim()) return result;

    try {
      const response = await callGroq({
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM },
          { role: 'user', content: `Resume esta conversación:\n\n${plain}` },
        ],
        maxTokens: CFG.maxSummaryTokens,
        temperature: 0.2,
        fetchImpl: options.fetchImpl,
      });
      summary = String(response?.text ?? '').trim();
      if (summary) cacheSet(hash, summary);
    } catch (e) {
      LOG.warn('ai-summarizer: fallo al resumir', { error: e.message, status: e.status || 0 });
      return result; // sin resumen devolvemos el historial intacto
    }
  }

  if (!summary) return result;

  const originalTokens = head.reduce((acc, m) => acc + estimateTokens(m?.content), 0);
  const summaryTokens = estimateTokens(summary);

  result.summarized = true;
  result.summary = summary;
  result.replacedCount = head.length;
  result.tokensSaved = Math.max(0, originalTokens - summaryTokens);
  result.messages = [
    {
      role: 'system',
      content: `[Resumen de los ${head.length} mensajes anteriores]\n${summary}`,
      synthetic: true,
    },
    ...tail,
  ];

  return result;
}

export default {
  summarizeHistory,
  estimateTokens,
  hashMessages,
  clearSummaryCache,
  getSummaryCacheStats,
};
