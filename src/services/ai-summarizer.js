/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/ai-summarizer.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Resumen de conversaciones largas con Llama 3 (Groq).

   POR QUÉ
   Una conversación de 120 mensajes se paga en tokens de entrada CADA
   vez que se manda al modelo: el mismo prefijo largo se vuelve a pagar
   en cada turno. El resumen no lo hace gratis, pero lo amortiza: se
   paga una vez y después se manda un bloque de 200 palabras en lugar
   de 40 mensajes.

   REGLA
     · Si `history.length <= 40` → no se resume (no hay savings).
     · Si supera los 40 → se resumen LOS PRIMEROS 30 mensajes (la
       cabecera de la conversación: objetivos, contexto, restricciones).
       Los últimos 10 mensajes (la conversación reciente) se mantienen
       literales porque son los que importan para la coherencia.
     · El resumen se cachea por hash: no se vuelve a pagar hasta que
       la conversación cambia de forma significativa.

   CADENA DE PROVEEDORES
     1. Groq (Llama 3)  → rápido y barato.
     2. Groq (Llama 3.1 fallback) si el primero falla.
     3. Gemini → si no hay Groq.
     4. Resumen extractivo local → SIEMPRE hay resultado. La app nunca
        se queda sin contexto por falta de una API key.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/* Las claves pueden venir de .env.local o del archivo env.local.js
   (así lo carga el resto del proyecto). */
let FILE_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  FILE_KEYS = mod.TEST_KEYS ?? {};
} catch { /* archivo opcional */ }

/** Modelos de Groq disponibles para esta cuenta (configurables). */
const GROQ_MODELS = (() => {
  const configured = process.env.GROQ_MODEL || FILE_KEYS.GROQ_MODEL;
  return [configured, 'openai/gpt-oss-120b', 'llama-3.1-8b-instant']
    .filter(Boolean)
    .filter((m, i, arr) => arr.indexOf(m) === i);
})();

/** Modelo de chat de Gemini. */
const GEMINI_MODEL = process.env.GEMINI_MODEL || FILE_KEYS.GEMINI_MODEL || 'gemini-3.6-flash';

const CFG = Object.freeze({
  threshold: 40,          // a partir de cuántos mensajes se resume
  headCount: 30,          // cuántos mensajes del inicio entran al resumen
  tailCount: 10,          // cuántos mensajes finales quedan literales
  targetWords: 200,
  maxInputChars: 24_000,
  timeoutMs: 20_000,
  cacheTtlMs: 30 * 60_000,
  cacheMax: 200,
  groqUrl: 'https://api.groq.com/openai/v1/chat/completions',
  groqModels: GROQ_MODELS,
  geminiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
  systemPrompt:
    'Sos un resumidor técnico. Condensá la conversación en un solo bloque de texto ' +
    'sin perder objetivos, restricciones, datos concretos, nombres, archivos, decisiones ' +
    'tomadas y tareas pendientes. Escribí en español salvo que la conversación esté en ' +
    'otro idioma. NO inventes nada. NO uses viñetas ni encabezados: escribí prosa ' +
    'corrida y densa. Máximo 200 palabras.',
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */



function groqKey() {
  return process.env.GROQ_API_KEY || FILE_KEYS.GROQ_API_KEY || null;
}

function geminiKey() {
  return process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY_3 || FILE_KEYS.GEMINI_API_KEY || null;
}

function clean(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normaliza los mensajes del historial a { role, content }. */
function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((m) => ({
      role: m?.role === 'assistant' ? 'assistant' : m?.role === 'system' ? 'system' : 'user',
      content: clean(m?.content ?? m?.text ?? m?.message ?? ''),
    }))
    .filter((m) => m.content.length > 0);
}

/** Hash estable del contenido que se resume (para la cache). */
function hashMessages(messages) {
  const payload = messages.map((m) => `${m.role}:${m.content.slice(0, 400)}`).join('|');
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/** Estimación de tokens (chars/4 es una aproximación estándar). */
export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · CACHE
   ═══════════════════════════════════════════════════════════════════════════ */

const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CFG.cacheTtlMs) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (cache.size >= CFG.cacheMax) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, { value, at: Date.now() });
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · RESUMEN LOCAL (fallback sin API keys)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Resumen extractivo: puntúa las frases por señales de densidad
 * (números, nombres de archivo, decisiones) y las concatena.
 * No es un modelo de lenguaje, pero conserva los hechos concretos.
 */
function localSummary(messages, maxWords = CFG.targetWords) {
  const scored = [];

  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const sentences = msg.content.split(/(?<=[.!?])\s+/).filter((s) => s.length > 24);

    for (const sentence of sentences) {
      let score = 0;
      if (/\d/.test(sentence)) score += 2;                       // datos concretos
      if (/[A-Za-z0-9_./-]+\.(js|ts|jsx|tsx|json|md|css|html|py)\b/i.test(sentence)) score += 3;
      if (/\b(usar|crear|implementar|arreglar|cambiar|necesitamos|queremos|debe|tenemos que)\b/i.test(sentence)) score += 2;
      if (msg.role === 'user') score += 1;                        // el usuario define el objetivo
      if (sentence.length > 220) score -= 1;

      if (score > 0) scored.push({ score, sentence: sentence.trim() });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  const picked = [];
  let words = 0;
  for (const item of scored) {
    const w = item.sentence.split(/\s+/).length;
    if (words + w > maxWords) continue;
    picked.push(item.sentence);
    words += w;
    if (words >= maxWords * 0.8) break;
  }

  if (!picked.length) {
    const head = messages
      .slice(0, 4)
      .map((m) => m.content.slice(0, 160))
      .join(' ');
    return `Contexto de la conversación: ${head}`.slice(0, 1200);
  }

  return picked.join(' ').slice(0, maxWords * 7);
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · PROVEEDORES LLM
   ═══════════════════════════════════════════════════════════════════════════ */

async function summarizeWithGroq(messages, model) {
  const key = groqKey();
  if (!key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

  try {
    const res = await fetch(CFG.groqUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: CFG.systemPrompt },
          {
            role: 'user',
            content: `Resumí esta conversación:\n\n${messages
              .map((m) => `${m.role === 'user' ? 'Usuario' : m.role === 'assistant' ? 'Asistente' : 'Sistema'}: ${m.content}`)
              .join('\n\n')}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 400,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Groq ${res.status}: ${body.slice(0, 160)}`);
    }

    const data = await res.json();
    const text = clean(data?.choices?.[0]?.message?.content || '');
    if (!text) throw new Error('Groq devolvió una respuesta vacía.');

    return { summary: text, provider: 'groq', model };
  } finally {
    clearTimeout(timer);
  }
}

async function summarizeWithGemini(messages, model = 'GEMINI_MODEL') {
  const key = geminiKey();
  if (!key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

  try {
    const res = await fetch(`${CFG.geminiUrl}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CFG.systemPrompt }] },
        contents: [{
          role: 'user',
          parts: [{
            text: `Resumí esta conversación:\n\n${messages
              .map((m) => `${m.role === 'user' ? 'Usuario' : 'Asistente'}: ${m.content}`)
              .join('\n\n')}`,
          }],
        }],
        generationConfig: { maxOutputTokens: 400, temperature: 0.2 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini ${res.status}: ${body.slice(0, 160)}`);
    }

    const data = await res.json();
    const text = clean(data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ') || '');
    if (!text) throw new Error('Gemini devolvió una respuesta vacía.');

    return { summary: text, provider: 'gemini', model };
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · API PÚBLICA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Resume el historial si corresponde.
 *
 * @param {Array} history   Mensajes normalizados { role, content }
 * @param {object} [opts]   { force, maxWords, model }
 * @returns {Promise<object>} {
 *   ok, used, summary, head, tail, tokensBefore, tokensAfter, tokensSaved,
 *   provider, model, cached, reason
 * }
 */
export async function summarizeHistory(history, opts = {}) {
  const messages = normalizeHistory(history);

  const tokensBefore = messages.reduce((acc, m) => acc + estimateTokens(m.content), 0);

  if (!opts.force && messages.length <= CFG.threshold) {
    return {
      ok: true,
      used: false,
      reason: 'below_threshold',
      summary: null,
      head: messages,
      tail: [],
      tokensBefore,
      tokensAfter: tokensBefore,
      tokensSaved: 0,
      provider: null,
    };
  }

  const head = messages.slice(0, CFG.headCount);
  const tail = messages.slice(-CFG.tailCount);

  const key = hashMessages(head);

  if (!opts.force) {
    const cached = cacheGet(key);
    if (cached) {
      return {
        ok: true,
        used: true,
        summary: cached.summary,
        head: [],
        tail,
        tokensBefore,
        tokensAfter: estimateTokens(cached.summary) + tail.reduce((a, m) => acc + estimateTokens(m.content), 0),
        tokensSaved: Math.max(0, tokensBefore - estimateTokens(cached.summary) - tail.reduce((a, m) => a + estimateTokens(m.content), 0)),
        provider: cached.provider,
        model: cached.model,
        cached: true,
      };
    }
  }

  const maxChars = CFG.maxInputChars;
  const trimmed = head.map((m) => ({
    ...m,
    content: m.content.slice(0, Math.floor(maxChars / Math.max(head.length, 1))),
  }));

  let result = null;
  let lastError = null;

  for (const model of CFG.groqModels) {
    try {
      result = await summarizeWithGroq(trimmed, model);
      if (result) break;
    } catch (e) {
      lastError = e;
      LOG.warn('ai-summarizer: Groq falló', { model, error: e.message });
    }
  }

  if (!result) {
    try {
      result = await summarizeWithGemini(trimmed);
    } catch (e) {
      lastError = e;
      LOG.warn('ai-summarizer: Gemini falló', { error: e.message });
    }
  }

  if (!result) {
    const summary = localSummary(trimmed, opts.maxWords || CFG.targetWords);
    cacheSet(key, { summary, provider: 'local', model: 'extractive' });
    const tokensAfter = estimateTokens(summary) + tail.reduce((a, m) => a + estimateTokens(m.content), 0);
    return {
      ok: true,
      used: true,
      summary,
      head: [],
      tail,
      tokensBefore,
      tokensAfter,
      tokensSaved: Math.max(0, tokensBefore - tokensAfter),
      provider: 'local',
      model: 'extractive',
      cached: false,
      degraded: true,
      detail: lastError?.message || null,
    };
  }

  const summary = result.summary.slice(0, (opts.maxWords || CFG.targetWords) * 7);
  cacheSet(key, { summary, provider: result.provider, model: result.model });

  const tailTokens = tail.reduce((a, m) => a + estimateTokens(m.content), 0);
  const tokensAfter = estimateTokens(summary) + tailTokens;

  LOG.info('ai-summarizer: historial resumido', {
    messages: messages.length,
    tokensBefore,
    tokensAfter,
    saved: Math.max(0, tokensBefore - tokensAfter),
    provider: result.provider,
  });

  return {
    ok: true,
    used: true,
    summary,
    head: [],
    tail,
    tokensBefore,
    tokensAfter,
    tokensSaved: Math.max(0, tokensBefore - tokensAfter),
    provider: result.provider,
    model: result.model,
    cached: false,
  };
}

/**
 * Inyecta el resumen en el system prompt.
 *
 * @param {string} systemPrompt
 * @param {string} summary
 * @returns {string}
 */
export function injectSummary(systemPrompt, summary) {
  const base = String(systemPrompt || '').trim();
  const block = String(summary || '').trim();

  if (!block) return base;

  const injected =
    `## Resumen de la conversación anterior\n` +
    `${block}\n\n` +
    `Usá este resumen como contexto de la conversación. Si el usuario se refiere a algo ` +
    `que no aparece acá, preguntale o revisá el historial reciente.`;

  return base ? `${base}\n\n${injected}` : injected;
}

/**
 * Construye el array de mensajes optimizado para enviar al modelo.
 * Reemplaza la cabeza por el resumen y conserva la cola literal.
 *
 * @param {Array} history
 * @param {object} [opts]
 * @returns {Promise<{messages:Array, summary:object}>}
 */
export async function compressHistory(history, opts = {}) {
  const result = await summarizeHistory(history, opts);

  if (!result.used) {
    return { messages: normalizeHistory(history), summary: result };
  }

  const messages = [
    { role: 'system', content: `Resumen del inicio de la conversación:\n${result.summary}` },
    ...result.tail,
  ];

  return { messages, summary: result };
}

/** Estado del servicio. */
export function getSummarizerStatus() {
  return {
    threshold: CFG.threshold,
    headCount: CFG.headCount,
    tailCount: CFG.tailCount,
    targetWords: CFG.targetWords,
    providers: {
      groq: Boolean(groqKey()),
      gemini: Boolean(geminiKey()),
      local: true,
    },
    cacheSize: cache.size,
    cacheTtlMs: CFG.cacheTtlMs,
  };
}

/** Limpia la cache (tests / cambio de configuración). */
export function clearSummaryCache() {
  cache.clear();
}

export default {
  summarizeHistory,
  compressHistory,
  injectSummary,
  estimateTokens,
  getSummarizerStatus,
  clearSummaryCache,
};
