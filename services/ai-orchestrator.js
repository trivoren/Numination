/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/ai-orchestrator.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Cascada de proveedores de IA con degradación automática.

   CASCADA
     1 · Groq    → motor principal (rápido y barato).
     2 · Gemini  → entra cuando Groq responde 429 (saturado) o falla;
                   rota entre las 3 claves disponibles.
     3 · Kimi    → último recurso (Moonshot Kimi vía NVIDIA NIM).

   NUNCA se lanza un error de red hacia el usuario final: si los tres
   proveedores fallan se lanza un error tipado `AI_ALL_PROVIDERS_FAILED`
   con el detalle de cada intento, para que la capa de rutas pueda
   decidir qué mostrar.

   CONTRATO
     generateResponse(prompt, history, options)
       → { text, provider, model, attempts }
   ═══════════════════════════════════════════════════════════════════════ */

import { LOG } from '../src/lib/logger.js';

/* ─── Claves: entorno primero, env.local.js como respaldo ─────────────── */

let FILE_KEYS = {};
try {
  const mod = await import('../env.local.js');
  FILE_KEYS = mod.TEST_KEYS ?? {};
} catch {
  /* env.local.js es opcional en despliegues sin fichero local */
}

function envKey(name) {
  return process.env[name] || FILE_KEYS[name] || null;
}

function geminiKeyList() {
  return [
    process.env.GEMINI_API_KEY   || FILE_KEYS.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2 || FILE_KEYS.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3 || FILE_KEYS.GEMINI_API_KEY_3,
  ].filter((k) => typeof k === 'string' && k.trim().length > 0);
}

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  groqUrl: 'https://api.groq.com/openai/v1/chat/completions',
  geminiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
  nvidiaBase: 'https://integrate.api.nvidia.com/v1',
  timeoutMs: 25_000,
  defaultSystem:
    'Eres el asistente de Numination. Respondes en el idioma del usuario, ' +
    'con precisión, sin inventar datos y de forma concisa.',
  groqModels: ['llama-3.1-8b-instant', 'openai/gpt-oss-120b'],
  geminiModels: ['gemini-2.0-flash', 'gemini-1.5-flash'],
  kimiModels: ['moonshotai/kimi-k2-instruct'],
});

function groqModels() {
  const configured = process.env.GROQ_MODEL || FILE_KEYS.GROQ_MODEL;
  return [...new Set([configured, ...CFG.groqModels].filter(Boolean))];
}

function geminiModels() {
  const configured = process.env.GEMINI_MODEL || FILE_KEYS.GEMINI_MODEL;
  return [...new Set([configured, ...CFG.geminiModels].filter(Boolean))];
}

function kimiModels() {
  const configured = process.env.NVIDIA_MODEL || FILE_KEYS.NVIDIA_MODEL;
  return [...new Set([configured, ...CFG.kimiModels].filter(Boolean))];
}

/* ═══════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

function httpError(message, status) {
  const error = new Error(message);
  error.status = status || 0;
  return error;
}

async function timedFetch(fetchImpl, url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normaliza el historial a mensajes { role, content } válidos.
 * @param {Array} history
 * @returns {Array<{role:string, content:string}>}
 */
export function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && typeof m === 'object')
    .map((m) => ({
      role: m.role === 'assistant' || m.role === 'ai' ? 'assistant'
          : m.role === 'system' ? 'system'
          : 'user',
      content: String(m.content ?? '').trim(),
    }))
    .filter((m) => m.content.length > 0);
}

/**
 * Construye la lista de mensajes para una API estilo OpenAI.
 * @param {Array} history
 * @param {string} prompt
 * @param {string} system
 * @returns {Array<{role:string, content:string}>}
 */
export function buildMessages(history, prompt, system = CFG.defaultSystem) {
  const messages = [];
  if (system && String(system).trim()) {
    messages.push({ role: 'system', content: String(system).trim() });
  }
  messages.push(...normalizeHistory(history));
  messages.push({ role: 'user', content: String(prompt).trim() });
  return messages;
}

/* ═══════════════════════════════════════════════════════════════════════
   03 · PROVEEDORES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Groq (API compatible con OpenAI).
 * @returns {Promise<{text:string, provider:string, model:string}>}
 */
export async function callGroq(params = {}) {
  const {
    messages = [],
    system = '',
    maxTokens = 1024,
    temperature = 0.4,
    json = false,
    fetchImpl = globalThis.fetch,
    key = envKey('GROQ_API_KEY'),
    model = groqModels()[0],
  } = params;

  if (!key) throw httpError('Groq sin clave configurada.', 401);
  if (typeof fetchImpl !== 'function') throw httpError('fetch no disponible.', 0);

  try {
    const payload = {
      model,
      messages: system ? messages : messages.filter((m) => m.role !== 'system'),
      temperature,
      max_tokens: maxTokens,
    };
    if (json) payload.response_format = { type: 'json_object' };

    const res = await timedFetch(fetchImpl, CFG.groqUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw httpError(`Groq ${res.status}: ${String(body).slice(0, 200)}`, res.status);
    }

    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) throw httpError('Groq devolvió una respuesta vacía.', 502);

    return { text, provider: 'groq', model };
  } catch (e) {
    if (!e.status) e.status = 0;
    throw e;
  }
}

/**
 * Gemini (generateContent).
 * @returns {Promise<{text:string, provider:string, model:string}>}
 */
export async function callGemini(params = {}) {
  const {
    messages = [],
    system = '',
    maxTokens = 1024,
    temperature = 0.4,
    json = false,
    fetchImpl = globalThis.fetch,
    key,
    model = geminiModels()[0],
  } = params;

  if (!key) throw httpError('Gemini sin clave configurada.', 401);
  if (typeof fetchImpl !== 'function') throw httpError('fetch no disponible.', 0);

  const userText = messages
    .filter((m) => m.role !== 'system')
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n\n');

  const systemInstruction = system || messages.find((m) => m.role === 'system')?.content || '';

  try {
    const res = await timedFetch(
      fetchImpl,
      `${CFG.geminiUrl}/${model}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(systemInstruction
            ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
            : {}),
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          generationConfig: {
            maxOutputTokens: maxTokens,
            temperature,
            ...(json ? { responseMimeType: 'application/json' } : {}),
          },
        }),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw httpError(`Gemini ${res.status}: ${String(body).slice(0, 200)}`, res.status);
    }

    const data = await res.json();
    const text = String(
      data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ') ?? ''
    ).trim();
    if (!text) throw httpError('Gemini devolvió una respuesta vacía.', 502);

    return { text, provider: 'gemini', model };
  } catch (e) {
    if (!e.status) e.status = 0;
    throw e;
  }
}

/**
 * Kimi (Moonshot) servido por NVIDIA NIM (API compatible con OpenAI).
 * @returns {Promise<{text:string, provider:string, model:string}>}
 */
export async function callKimi(params = {}) {
  const {
    messages = [],
    system = '',
    maxTokens = 1024,
    temperature = 0.4,
    fetchImpl = globalThis.fetch,
    key = envKey('NVIDIA_API_KEY'),
    model = kimiModels()[0],
  } = params;

  if (!key) throw httpError('Kimi/NVIDIA sin clave configurada.', 401);
  if (typeof fetchImpl !== 'function') throw httpError('fetch no disponible.', 0);

  const base = (process.env.NVIDIA_BASE_URL || FILE_KEYS.NVIDIA_BASE_URL || CFG.nvidiaBase)
    .replace(/\/+$/, '');

  try {
    const payload = {
      model,
      messages: system ? messages : messages.filter((m) => m.role !== 'system'),
      temperature,
      max_tokens: maxTokens,
    };

    const res = await timedFetch(fetchImpl, `${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw httpError(`Kimi ${res.status}: ${String(body).slice(0, 200)}`, res.status);
    }

    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) throw httpError('Kimi devolvió una respuesta vacía.', 502);

    return { text, provider: 'kimi', model };
  } catch (e) {
    if (!e.status) e.status = 0;
    throw e;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   04 · ORQUESTADOR
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Genera una respuesta usando la cascada Groq → Gemini → Kimi.
 *
 * @param {string} prompt        Prompt del usuario (obligatorio).
 * @param {Array}  [history]     Historial previo [{ role, content }].
 * @param {object} [options]
 * @param {string} [options.system]        System prompt.
 * @param {number} [options.maxTokens]      Tokens máximos de la respuesta.
 * @param {number} [options.temperature]
 * @param {boolean}[options.json]           Pedir respuesta JSON.
 * @param {Function}[options.fetchImpl]     Inyección de fetch (tests).
 * @returns {Promise<{text:string, provider:string, model:string, attempts:Array}>}
 */
export async function generateResponse(prompt, history = [], options = {}) {
  const {
    system = CFG.defaultSystem,
    maxTokens = 1024,
    temperature = 0.4,
    json = false,
    fetchImpl = globalThis.fetch,
  } = options;

  const userPrompt = String(prompt ?? '').trim();
  if (!userPrompt) {
    const error = new Error('generateResponse necesita un prompt no vacío.');
    error.code = 'EMPTY_PROMPT';
    throw error;
  }

  const messages = buildMessages(history, userPrompt, system);
  const attempts = [];

  /* ── 1 · Groq ─────────────────────────────────────────────────────── */
  const groqKey = envKey('GROQ_API_KEY');
  if (groqKey) {
    try {
      const result = await callGroq({
        messages, system, maxTokens, temperature, json, fetchImpl, key: groqKey,
      });
      attempts.push({ provider: 'groq', model: result.model, ok: true, status: 200 });
      return { text: result.text, provider: 'groq', model: result.model, attempts };
    } catch (e) {
      attempts.push({
        provider: 'groq', ok: false, status: e.status || 0, error: e.message,
      });
      LOG.warn('ai-orchestrator: Groq falló', { status: e.status, error: e.message });
    }
  }

  /* ── 2 · Gemini (rotación de claves) ─────────────────────────────── */
  for (const key of geminiKeyList()) {
    for (const model of geminiModels()) {
      try {
        const result = await callGemini({
          messages, system, maxTokens, temperature, json, fetchImpl, key, model,
        });
        attempts.push({ provider: 'gemini', model: result.model, ok: true, status: 200 });
        return { text: result.text, provider: 'gemini', model: result.model, attempts };
      } catch (e) {
        attempts.push({
          provider: 'gemini', model, ok: false, status: e.status || 0, error: e.message,
        });
        LOG.warn('ai-orchestrator: Gemini falló', { status: e.status, error: e.message });
        // 401/403 → esa clave está mal: la siguiente clave puede funcionar.
        // 429 → la clave está saturada: probar la siguiente clave.
        if (e.status === 400 || e.status === 404) break;
      }
    }
  }

  /* ── 3 · Kimi ────────────────────────────────────────────────────── */
  const kimiKey = envKey('NVIDIA_API_KEY');
  if (kimiKey) {
    for (const model of kimiModels()) {
      try {
        const result = await callKimi({
          messages, system, maxTokens, temperature, fetchImpl, key: kimiKey, model,
        });
        attempts.push({ provider: 'kimi', model: result.model, ok: true, status: 200 });
        return { text: result.text, provider: 'kimi', model: result.model, attempts };
      } catch (e) {
        attempts.push({
          provider: 'kimi', model, ok: false, status: e.status || 0, error: e.message,
        });
        LOG.warn('ai-orchestrator: Kimi falló', { status: e.status, error: e.message });
      }
    }
  }

  const error = new Error('Ningún proveedor de IA respondió.');
  error.code = 'AI_ALL_PROVIDERS_FAILED';
  error.attempts = attempts;
  error.status = 503;
  throw error;
}

/**
 * Estado de los proveedores (para /health y diagnóstico).
 */
export function getProviderStatus() {
  return {
    groq: Boolean(envKey('GROQ_API_KEY')),
    gemini: geminiKeyList().length,
    kimi: Boolean(envKey('NVIDIA_API_KEY')),
    groqModels: groqModels(),
    geminiModels: geminiModels(),
    kimiModels: kimiModels(),
    timeoutMs: CFG.timeoutMs,
  };
}

export default {
  generateResponse,
  callGroq,
  callGemini,
  callKimi,
  buildMessages,
  normalizeHistory,
  getProviderStatus,
};
