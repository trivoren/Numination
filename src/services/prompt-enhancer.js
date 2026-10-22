/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/prompt-enhancer.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Mejora de prompts: convierte una petición floja en una instrucción
   precisa para un modelo.

   EJEMPLO
     Entrada:  "escribeme un correo para el cliente"
     Salida:   "Actuá como analista de negocio. Redactá un correo de 150
                palabras para un cliente que pidió una cotización...
                Formato: asunto, cuerpo con 3 párrafos, cierre.
                Tono: profesional y directo. No inventes datos."

   DISEÑO
   · El LLM es el motor principal (Groq → Gemini → fallback local).
   · El fallback local NO es un LLM: aplica plantillas deterministas
     (rol, restricciones, formato) para que la función nunca devuelva
     una promesa vacía.
   · Cache por hash del prompt + contexto (mismo prompt → misma mejora,
     sin volver a pagar la llamada).
   · El prompt original SIEMPRE se devuelve: la mejora es una sugerencia,
     nunca se pierde el input del usuario.
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
  timeoutMs: 20_000,
  maxPromptChars: 4000,
  maxContextChars: 1000,
  maxOutputChars: 6000,
  cacheTtlMs: 60 * 60_000,
  cacheMax: 300,
  groqUrl: 'https://api.groq.com/openai/v1/chat/completions',
  groqModels: GROQ_MODELS,
  geminiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
  engineerInstruction:
    'Reescribí esto como si fueras un Senior Prompt Engineer. ' +
    'Añadí contexto, restricciones y formato de salida. ' +
    'Reglas: (1) conservá la intención original y todos los datos concretos ' +
    '(nombres, números, archivos); (2) explicitá el rol que debe adoptar la IA; ' +
    '(3) agregá restricciones claras (qué NO hacer, qué tono, qué extensión); ' +
    '(4) definí el formato de salida esperado; (5) no inventes requisitos nuevos; ' +
    '(6) devolvé SOLO el prompt mejorado, sin explicaciones ni comillas que lo encierren.',
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

function clean(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function hashKey(prompt, context) {
  return crypto.createHash('sha256').update(`${prompt}::${context || ''}`).digest('hex').slice(0, 32);
}

/* ─── Cache ─────────────────────────────────────────────────────────────── */

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
   03 · PROVEEDORES
   ═══════════════════════════════════════════════════════════════════════════ */

async function enhanceWithGroq(prompt, context, model) {
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
          { role: 'system', content: CFG.engineerInstruction },
          {
            role: 'user',
            content: context
              ? `Prompt original:\n"""\n${prompt}\n"""\n\nContexto adicional del proyecto:\n${context}`
              : `Prompt original:\n"""\n${prompt}\n"""`,
          },
        ],
        temperature: 0.3,
        max_tokens: 700,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Groq ${res.status}: ${body.slice(0, 160)}`);
    }

    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error('Groq devolvió una respuesta vacía.');

    return { enhanced: text.slice(0, CFG.maxOutputChars), provider: 'groq', model };
  } finally {
    clearTimeout(timer);
  }
}

async function enhanceWithGemini(prompt, context) {
  const key = geminiKey();
  if (!key) return null;

  const model = 'GEMINI_MODEL';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

  try {
    const res = await fetch(`${CFG.geminiUrl}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: CFG.engineerInstruction }] },
        contents: [{
          role: 'user',
          parts: [{
            text: context
              ? `Prompt original:\n"""\n${prompt}\n"""\n\nContexto adicional del proyecto:\n${context}`
              : `Prompt original:\n"""\n${prompt}\n"""`,
          }],
        }],
        generationConfig: { maxOutputTokens: 700, temperature: 0.3 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini ${res.status}: ${body.slice(0, 160)}`);
    }

    const data = await res.json();
    const text = String(data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ') || '').trim();
    if (!text) throw new Error('Gemini devolvió una respuesta vacía.');

    return { enhanced: text.slice(0, CFG.maxOutputChars), provider: 'gemini', model };
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · MEJORA LOCAL (fallback determinista)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Detecta la intención del prompt para elegir rol, restricciones y
 * formato de salida.
 */
function inferIntent(prompt) {
  const p = prompt.toLowerCase();

  if (/\b(correo|email|mail|mensaje a)\b/.test(p)) {
    return {
      role: 'redactor de comunicaciones profesionales',
      constraints: [
        'Usá español neutro y profesional',
        'No inventes datos del destinatario ni fechas',
        'Mantené el tono indicado por el usuario',
      ],
      format: 'Devolvé: Asunto (1 línea), luego el cuerpo, y nada más.',
      length: '150 palabras',
    };
  }

  if (/\b(código|code|función|function|script|bug|error|refactor)\b/.test(p)) {
    return {
      role: 'senior software engineer',
      constraints: [
        'No inventes APIs ni librerías que no estén disponibles',
        'Incluí manejo de errores y casos borde',
        'Explicá brevemente por qué cada decisión',
      ],
      format: 'Devolvé: explicación de 3 líneas, luego el código en un bloque, luego cómo probarlo.',
      length: 'tan breve como se pueda',
    };
  }

  if (/\b(explicá|explica|qué es|cómo funciona|enseñ|difícil)\b/.test(p)) {
    return {
      role: 'profesor técnico paciente',
      constraints: [
        'Usá analogías simples y un ejemplo concreto',
        'Avoidá jerga innecesaria; si la usás, definila',
        'Respondé en pasos numerados cuando el proceso lo requiera',
      ],
      format: 'Devolvé: explicación clara, ejemplo y un resumen de 2 líneas.',
      length: '300 palabras',
    };
  }

  if (/\b(analiz|resum|compar|datos|métrica)\b/.test(p)) {
    return {
      role: 'analista de datos',
      constraints: [
        'Separá hechos de inferencias',
        'Indicá supuestos explícitamente',
        'No inventes cifras ausentes',
      ],
      format: 'Devolvé: hallazgos en viñetas, luego una conclusión de 2 líneas.',
      length: '250 palabras',
    };
  }

  return {
    role: 'asistente experto en el tema',
    constraints: [
      'Respondé en el idioma del usuario',
      'No inventes datos; si falta información, preguntá',
        'Priorizá precisión sobre velocidad',
    ],
    format: 'Devolvé una respuesta directa y luego, si aporta, un ejemplo.',
    length: '200 palabras',
  };
}

/**
 * Mejora determinista sin LLM.
 */
function localEnhance(prompt, context) {
  const intent = inferIntent(prompt);
  const parts = [];

  parts.push(`Actuá como ${intent.role}.`);
  parts.push('');
  parts.push('Tarea:');
  parts.push(prompt);
  parts.push('');
  parts.push('Restricciones:');
  intent.constraints.forEach((c) => parts.push(`- ${c}`));
  parts.push(`- Extensión aproximada: ${intent.length}`);
  if (context) {
    parts.push('');
    parts.push('Contexto del proyecto:');
    parts.push(context);
  }
  parts.push('');
  parts.push('Formato de salida:');
  parts.push(intent.format);

  return parts.join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · API PÚBLICA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Mejora un prompt.
 *
 * @param {string} rawPrompt
 * @param {object} [opts]
 * @param {string} [opts.context]  Contexto del proyecto (archivos, stack…)
 * @param {boolean}[opts.force]     Ignora la cache
 * @param {string} [opts.language]  'es' | 'en'
 * @returns {Promise<object>} {
 *   ok, original, enhanced, changed, provider, model, cached, degraded,
 *   originalTokens, enhancedTokens
 * }
 */
export async function enhancePrompt(rawPrompt, opts = {}) {
  const prompt = clean(rawPrompt, CFG.maxPromptChars);

  if (!prompt) {
    return {
      ok: false,
      error: 'El prompt está vacío.',
      original: '',
      enhanced: '',
      changed: false,
      provider: null,
    };
  }

  const context = clean(opts.context, CFG.maxContextChars);
  const key = hashKey(prompt, context);

  if (!opts.force) {
    const cached = cacheGet(key);
    if (cached) {
      return { ok: true, ...cached, cached: true, original: prompt };
    }
  }

  const languageHint = opts.language === 'en'
    ? 'El prompt debe quedar en inglés.'
    : 'El prompt debe quedar en español.';

  let result = null;
  let lastError = null;

  for (const model of CFG.groqModels) {
    try {
      result = await enhanceWithGroq(`${prompt}\n\n(${languageHint})`, context, model);
      if (result) break;
    } catch (e) {
      lastError = e;
      LOG.warn('prompt-enhancer: Groq falló', { model, error: e.message });
    }
  }

  if (!result) {
    try {
      result = await enhanceWithGemini(`${prompt}\n\n(${languageHint})`, context);
    } catch (e) {
      lastError = e;
      LOG.warn('prompt-enhancer: Gemini falló', { error: e.message });
    }
  }

  if (!result) {
    const enhanced = localEnhance(prompt, context);
    const payload = {
      ok: true,
      enhanced,
      changed: enhanced !== prompt,
      provider: 'local',
      model: 'deterministic-v1',
      degraded: true,
      detail: lastError?.message || null,
      originalTokens: Math.ceil(prompt.length / 4),
      enhancedTokens: Math.ceil(enhanced.length / 4),
    };
    cacheSet(key, payload);
    return { ...payload, original: prompt, cached: false };
  }

  const enhanced = result.enhanced.trim();
  const payload = {
    ok: true,
    enhanced,
    changed: enhanced !== prompt,
    provider: result.provider,
    model: result.model,
    degraded: false,
    originalTokens: Math.ceil(prompt.length / 4),
    enhancedTokens: Math.ceil(enhanced.length / 4),
  };

  cacheSet(key, payload);

  LOG.info('prompt-enhancer: prompt mejorado', {
    provider: result.provider,
    from: payload.originalTokens,
    to: payload.enhancedTokens,
  });

  return { ...payload, original: prompt, cached: false };
}

/**
 * Compara dos prompts y explica las diferencias (para el diff en la UI).
 */
export function diffPrompts(original, enhanced) {
  const a = String(original || '').split(/\s+/).filter(Boolean);
  const b = String(enhanced || '').split(/\s+/).filter(Boolean);
  const setA = new Set(a.map((w) => w.toLowerCase()));
  const setB = new Set(b.map((w) => w.toLowerCase()));

  return {
    added: b.filter((w) => !setA.has(w.toLowerCase())).slice(0, 40),
    removed: a.filter((w) => !setB.has(w.toLowerCase())).slice(0, 40),
    ratio: a.length ? Math.round((b.length / a.length) * 100) : 100,
  };
}

export function getEnhancerStatus() {
  return {
    providers: {
      groq: Boolean(groqKey()),
      gemini: Boolean(geminiKey()),
      local: true,
    },
    cacheSize: cache.size,
    cacheTtlMs: CFG.cacheTtlMs,
    maxPromptChars: CFG.maxPromptChars,
  };
}

export function clearEnhancerCache() {
  cache.clear();
}

export default {
  enhancePrompt,
  diffPrompts,
  getEnhancerStatus,
  clearEnhancerCache,
  inferIntent,
};

