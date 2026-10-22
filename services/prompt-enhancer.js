/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/prompt-enhancer.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Expande prompts demasiado cortos para obtener respuestas útiles.

   CUÁNDO ACTIVA
     · El prompt tiene menos de `minChars` caracteres O menos de
       `minWords` palabras.
     · Si ya es detallado, se devuelve tal cual (0 tokens gastados).

   CACHÉ
     Hash sha256 del prompt normalizado: repetir el mismo prompt no
     vuelve a llamar al modelo.

   CONTRATO
     enhancePrompt(prompt, options)
       → { prompt, original, enhanced, provider, cached, tokensSaved }
   ═══════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { LOG } from '../src/lib/logger.js';
import { callGroq } from './ai-orchestrator.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  minChars: 280,
  minWords: 45,
  maxOutputTokens: 600,
  cacheTtlMs: 60 * 60 * 1000,
  cacheMax: 300,
  temperature: 0.6,
});

const cache = new Map(); // hash → { text, at }

/* ═══════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

function normalize(text) {
  return String(text ?? '').trim().replace(/\s+/g, ' ');
}

function hashPrompt(text) {
  return crypto.createHash('sha256').update(normalize(text)).digest('hex');
}

function countWords(text) {
  const value = normalize(text);
  if (!value) return 0;
  return value.split(/\s+/).length;
}

function cacheGet(hash) {
  const hit = cache.get(hash);
  if (!hit) return null;
  if (Date.now() - hit.at > CFG.cacheTtlMs) {
    cache.delete(hash);
    return null;
  }
  return hit.text;
}

function cacheSet(hash, text) {
  if (cache.size >= CFG.cacheMax) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(hash, { text, at: Date.now() });
}

/** Limpia la caché de prompts expandidos. */
export function clearEnhancerCache() {
  cache.clear();
}

/**
 * ¿El prompt ya tiene suficiente detalle?
 * @param {string} prompt
 * @returns {boolean}
 */
export function isDetailedEnough(prompt) {
  const text = String(prompt ?? '').trim();
  if (!text) return true;
  return text.length >= CFG.minChars && countWords(text) >= CFG.minWords;
}

/* ═══════════════════════════════════════════════════════════════════════
   03 · EXPANSIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const ENHANCE_SYSTEM = [
  'Eres un ingeniero de prompts senior.',
  'Reescribes la petición del usuario en un prompt profesional, detallado y autocontenido.',
  'Reglas:',
  '· Conserva la intención y el idioma original.',
  '· Añade contexto, alcance, formato de salida esperado y criterios de calidad.',
  '· NO inventes datos, cifras ni nombres propios que el usuario no haya dado.',
  '· Devuelve SOLO el prompt final, sin comillas ni explicaciones.',
].join('\n');

/**
 * Expande un prompt corto.
 *
 * @param {string} prompt
 * @param {object} [options]
 * @param {string} [options.context]     Contexto adicional (persona, proyecto).
 * @param {string} [options.language]     Idioma de salida (por defecto, el del prompt).
 * @param {boolean}[options.force]        Expandir aunque ya sea detallado.
 * @param {Function}[options.fetchImpl]
 * @returns {Promise<{prompt:string, original:string, enhanced:boolean,
 *                    provider:string|null, cached:boolean, error:string|null}>}
 */
export async function enhancePrompt(prompt, options = {}) {
  const original = String(prompt ?? '').trim();

  const base = {
    prompt: original,
    original,
    enhanced: false,
    provider: null,
    cached: false,
    error: null,
  };

  if (!original) {
    return { ...base, error: 'EMPTY_PROMPT' };
  }

  const force = options.force === true;
  if (!force && isDetailedEnough(original)) return base;

  const hash = hashPrompt(original);
  const cached = cacheGet(hash);
  if (cached) {
    return {
      ...base,
      prompt: cached,
      enhanced: true,
      cached: true,
      provider: 'cache',
    };
  }

  const instructions = [
    `Prompt del usuario:\n"""${original}"""`,
    options.context ? `\nContexto disponible:\n"""${String(options.context).slice(0, 2000)}"""` : '',
    options.language ? `\nIdioma de salida: ${String(options.language)}.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const response = await callGroq({
      messages: [
        { role: 'system', content: ENHANCE_SYSTEM },
        { role: 'user', content: instructions },
      ],
      maxTokens: CFG.maxOutputTokens,
      temperature: CFG.temperature,
      fetchImpl: options.fetchImpl,
    });

    const expanded = String(response?.text ?? '').trim();
    if (!expanded) {
      return { ...base, error: 'EMPTY_ENHANCEMENT' };
    }

    cacheSet(hash, expanded);

    return {
      ...base,
      prompt: expanded,
      enhanced: true,
      provider: response?.provider ?? 'groq',
    };
  } catch (e) {
    LOG.warn('prompt-enhancer: fallo al expandir', { error: e.message, status: e.status || 0 });
    return { ...base, error: e.message };
  }
}

export default {
  enhancePrompt,
  isDetailedEnough,
  clearEnhancerCache,
};
