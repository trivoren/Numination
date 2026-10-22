/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/ai-orchestrator.js · v1.0
   ─────────────────────────────────────────────────────────────────────────══
   Orquestador de IA: la cascada de proveedores con fallback automático.

   CASCADA
     1 · Groq    → rápido y barato (modelo configurado en GROQ_MODEL).
     2 · Gemini  → plan B cuando Groq está saturado (429) o caído (5xx).
     3 · Fallback local → cada servicio tiene el suyo (resumen extractivo,
        esqueleto de tests, explicación estática). NUNCA se devuelve un
        error 500 por falta de un proveedor.

   POR QUÉ UN MÓDULO PROPIO
     La cascada estaba duplicada en 4 archivos. Centralizarla aquí:
       · un solo lugar donde cambiar el orden de los proveedores,
       · un solo lugar donde medir/metricar los intentos,
       · y un punto de inyección claro para los tests: `fetchImpl` y
         `providers` se pueden pasar por parámetro, así que la suite
         verifica el fallback SIN gastar un solo token.

   CONTRATO
     callLLM({ system, user, maxTokens, temperature, json, fetchImpl, providers, timeoutMs })
       → { text, provider, model, attempts: [{ provider, ok, status }] }
       → null si ningún proveedor respondió.
   ═══════════════════════════════════════════════════════════════════════════ */

import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  groqUrl: 'https://api.groq.com/openai/v1/chat/completions',
  geminiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
  timeoutMs: 25_000,
  maxAttempts: 4,
  groqModels: ['openai/gpt-oss-120b', 'llama-3.1-8b-instant'],
  geminiModels: ['gemini-3.6-flash', 'gemini-3.5-flash'],
});

let FILE_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  FILE_KEYS = mod.TEST_KEYS ?? {};
} catch { /* archivo opcional */ }

/* ═══════════════════════════════════════════════════════════════════════════
   02 · CLAVES Y MODELOS
   ═══════════════════════════════════════════════════════════════════════════ */

export function getGroqKey() {
  return process.env.GROQ_API_KEY || FILE_KEYS.GROQ_API_KEY || null;
}

export function getGeminiKey() {
  return process.env.GEMINI_API_KEY
    || process.env.GEMINI_API_KEY_2
    || process.env.GEMINI_API_KEY_3
    || FILE_KEYS.GEMINI_API_KEY
    || null;
}

export function getGroqModels() {
  const configured = process.env.GROQ_MODEL || FILE_KEYS.GROQ_MODEL;
  return [configured, ...CFG.groqModels]
    .filter(Boolean)
    .filter((m, i, arr) => arr.indexOf(m) === i);
}

export function getGeminiModels() {
  const configured = process.env.GEMINI_MODEL || FILE_KEYS.GEMINI_MODEL;
  return [configured, ...CFG.geminiModels]
    .filter(Boolean)
    .filter((m, i, arr) => arr.indexOf(m) === i);
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · PROVEEDORES
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Groq (compatible con OpenAI).
 */
async function callGroq({ system, user, maxTokens, temperature, json, fetchImpl, model, key }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

  try {
    const res = await fetchImpl(CFG.groqUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature,
        max_tokens: maxTokens,
        response_format: json ? { type: 'json_object' } : undefined,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = new Error(`Groq ${res.status}: ${body.slice(0, 180)}`);
      error.status = res.status;
      throw error;
    }

    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error('Groq devolvió una respuesta vacía.');

    return { text, provider: 'groq', model };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Gemini (generateContent).
 */
async function callGemini({ system, user, maxTokens, temperature, json, fetchImpl, model, key }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

  try {
    const res = await fetchImpl(
      `${CFG.geminiUrl}/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature,
            responseMimeType: json ? 'application/json' : undefined,
          },
        }),
        signal: controller.signal,
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = new Error(`Gemini ${res.status}: ${body.slice(0, 180)}`);
      error.status = res.status;
      throw error;
    }

    const data = await res.json();
    const text = String(data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ') || '').trim();
    if (!text) throw new Error('Gemini devolvió una respuesta vacía.');

    return { text, provider: 'gemini', model };
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · ORQUESTADOR
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Ejecuta la cascada de proveedores.
 *
 * @param {object} params
 * @param {string} params.system
 * @param {string} params.user
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @param {boolean}[params.json]
 * @param {Function}[params.fetchImpl]  Inyección de fetch (tests).
 * @param {Array}[params.providers]     Inyección del orden de proveedores.
 * @param {boolean}[params.throwOnFail]  Si true, lanza en vez de devolver null.
 * @returns {Promise<{text:string, provider:string, model:string, attempts:Array}|null>}
 */
export async function callLLM(params = {}) {
  const {
    system = '',
    user = '',
    maxTokens = 900,
    temperature = 0.3,
    json = false,
    fetchImpl = globalThis.fetch,
    throwOnFail = false,
  } = params;

  if (typeof fetchImpl !== 'function') {
    throw new Error('callLLM necesita un fetch implementable.');
  }

  const groqKey = getGroqKey();
  const geminiKey = getGeminiKey();

  const defaultOrder = [];
  if (groqKey) defaultOrder.push('groq');
  if (geminiKey) defaultOrder.push('gemini');

  const order = Array.isArray(params.providers) && params.providers.length
    ? params.providers
    : defaultOrder;

  const attempts = [];

  for (const provider of order) {
    if (attempts.length >= CFG.maxAttempts) break;

    try {
      if (provider === 'groq' && groqKey) {
        for (const model of getGroqModels()) {
          if (attempts.length >= CFG.maxAttempts) break;
          try {
            const result = await callGroq({
              system, user, maxTokens, temperature, json, fetchImpl, model, key: groqKey,
            });
            attempts.push({ provider: 'groq', model, ok: true, status: 200 });
            return { ...result, attempts };
          } catch (e) {
            attempts.push({ provider: 'groq', model, ok: false, status: e.status || 0, error: e.message });
            // 401/403 → la clave está mal: no tiene sentido reintentar con
            // otro modelo de Groq.
            if (e.status === 401 || e.status === 403) break;
          }
        }
        continue;
      }

      if (provider === 'gemini' && geminiKey) {
        for (const model of getGeminiModels()) {
          if (attempts.length >= CFG.maxAttempts) break;
          try {
            const result = await callGemini({
              system, user, maxTokens, temperature, json, fetchImpl, model, key: geminiKey,
            });
            attempts.push({ provider: 'gemini', model, ok: true, status: 200 });
            return { ...result, attempts };
          } catch (e) {
            attempts.push({ provider: 'gemini', model, ok: false, status: e.status || 0, error: e.message });
            if (e.status === 401 || e.status === 403) break;
          }
        }
      }
    } catch (e) {
      attempts.push({ provider, ok: false, status: e.status || 0, error: e.message });
    }
  }

  LOG.warn('ai-orchestrator: ningún proveedor respondió', {
    attempts: attempts.map((a) => `${a.provider}:${a.status}`).join(','),
  });

  if (throwOnFail) {
    const error = new Error('Ningún proveedor de IA respondió.');
    error.code = 'AI_ALL_ENGINES_FAILED';
    error.attempts = attempts;
    throw error;
  }

  return null;
}

/**
 * Igual que callLLM pero devuelve siempre texto (nunca null).
 * Si ningún proveedor responde, usa el `fallback` que le pasen.
 *
 * @param {object} params
 * @param {Function} [params.fallback]  () => string
 * @returns {Promise<{text:string, provider:string, degraded:boolean, attempts:Array}>}
 */
export async function callLLMOrFallback(params = {}) {
  const result = await callLLM(params);

  if (result) {
    return { ...result, degraded: false };
  }

  const fallbackText = typeof params.fallback === 'function'
    ? String(await params.fallback() || '')
    : '';

  return {
    text: fallbackText,
    provider: 'fallback',
    model: 'local',
    degraded: true,
    attempts: params.attempts || [],
  };
}

export function getOrchestratorStatus() {
  return {
    providers: {
      groq: Boolean(getGroqKey()),
      gemini: Boolean(getGeminiKey()),
    },
    groqModels: getGroqModels(),
    geminiModels: getGeminiModels(),
    timeoutMs: CFG.timeoutMs,
    maxAttempts: CFG.maxAttempts,
  };
}

export default {
  callLLM,
  callLLMOrFallback,
  getOrchestratorStatus,
  getGroqKey,
  getGeminiKey,
  getGroqModels,
  getGeminiModels,
};
