/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/dall-e-prompter.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Prompts de imagen listos para producción.

   QUÉ HACE
   El usuario escribe "un gato". Para el modelo de imagen eso es
   demasiado poco: sin dirección de arte el resultado es una foto
   genérica. Este servicio:

     1. Enriquece el prompt con una cola de calidad fija
        ("8k, cinematic lighting, highly detailed, artstation").
     2. Aplica el estilo pedido (cinematográfico, anime, oil, etc.).
     3. Limpia y valida (NSFW, longitud, caracteres).
     4. Construye la URL de Pollinations con los parámetros correctos.

   LA COLA DE CALIDAD ES INTENCIONAL
   "8k, cinematic lighting, highly detailed, artstation" es lo que más
   improve el resultado en la práctica: sin iluminación y sin nivel de
   detalle, los modelos de imagen devuelven planos genéricos.

   PRESETS
   · `cinematic`  → el default
   · `anime`      → líneas limpias, color plano
   · `oil`        → pincelada, textura
   · `photo`      → lente 35mm, profundidad de campo
   · `minimal`    → fondo limpio, mucha luz
   · `3d`         → render, subsurface
   ═══════════════════════════════════════════════════════════════════════════ */

import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  /** La cola de calidad que el brief exige. */
  qualitySuffix: '8k, cinematic lighting, highly detailed, artstation',
  maxPromptChars: 500,
  pollinationsBase: 'https://image.pollinations.ai/prompt',
  allowedSizes: [
    [512, 512], [768, 768], [1024, 1024], [1024, 1792], [1792, 1024],
  ],
  allowedModels: ['flux', 'turbo', 'kontext'],
});

export const PRESETS = Object.freeze({
  cinematic: {
    id: 'cinematic',
    label: 'Cinematográfico',
    suffix: 'cinematic lighting, film grain, anamorphic lens, dramatic shadows, color graded',
    negative: 'blurry, low quality, watermark, text',
  },
  anime: {
    id: 'anime',
    label: 'Anime',
    suffix: 'anime style, cel shading, clean lineart, vibrant colors, studio quality',
    negative: 'photorealistic, 3d render, blurry',
  },
  oil: {
    id: 'oil',
    label: 'Óleo',
    suffix: 'oil painting, visible brush strokes, canvas texture, museum lighting, fine art',
    negative: 'digital art, photograph, flat colors',
  },
  photo: {
    id: 'photo',
    label: 'Fotografía',
    suffix: 'photograph, 35mm lens, shallow depth of field, natural light, high dynamic range',
    negative: 'illustration, cartoon, painting',
  },
  minimal: {
    id: 'minimal',
    label: 'Minimalista',
    suffix: 'minimalist, clean composition, soft shadows, neutral palette, studio background',
    negative: 'busy background, clutter, noise',
  },
  '3d': {
    id: '3d',
    label: '3D',
    suffix: '3d render, subsurface scattering, soft global illumination, octane render, 4k',
    negative: 'flat, 2d, sketch',
  },
});

/* ─── Filtro de contenido ────────────────────────────────────────────────── */

const HARD_BLOCK = [
  'nsfw', 'nude', 'nudes', 'naked', 'porn', 'porno', 'pornography', 'xxx',
  'genitalia', 'genitals', 'hentai', 'sex acts', 'sexual intercourse',
  'child porn', 'cp', 'underage nude', 'rape', 'bestiality', 'incest',
  'gore', 'dismemberment', 'beheading',
];

/* ═══════════════════════════════════════════════════════════════════════════
   02 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function clean(value, max) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Analiza el prompt contra el filtro de contenido.
 * @returns {{safe:boolean, reason:string|null, matched:string|null}}
 */
export function analyzeImagePrompt(prompt) {
  const text = String(prompt || '').toLowerCase();

  for (const term of HARD_BLOCK) {
    if (text.includes(term)) {
      return { safe: false, reason: 'contenido_no_permitido', matched: term };
    }
  }

  return { safe: true, reason: null, matched: null };
}

function normalizeSize(width, height) {
  const w = parseInt(width, 10) || 1024;
  const h = parseInt(height, 10) || 1024;

  const exact = CFG.allowedSizes.find((s) => s[0] === w && s[1] === h);
  if (exact) return { width: exact[0], height: exact[1] };

  let best = CFG.allowedSizes[0];
  let bestDelta = Infinity;
  for (const s of CFG.allowedSizes) {
    const delta = Math.abs(s[0] * s[1] - w * h);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = s;
    }
  }
  return { width: best[0], height: best[1] };
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · ENRIQUECIMIENTO
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Enriquece el prompt del usuario.
 *
 * @param {string} rawPrompt
 * @param {object} [opts]
 * @param {string} [opts.style]     Id del preset
 * @param {boolean}[opts.quality]   Agrega la cola de calidad (default true)
 * @param {string} [opts.negative]  Prompt negativo adicional
 * @returns {object} {
 *   ok, prompt, original, style, negative, added, safe, reason
 * }
 */
export function enhanceImagePrompt(rawPrompt, opts = {}) {
  const original = clean(rawPrompt, CFG.maxPromptChars);

  if (!original) {
    return { ok: false, prompt: '', original: '', style: null, added: [], safe: true, reason: 'empty_prompt' };
  }

  const analysis = analyzeImagePrompt(original);
  if (!analysis.safe) {
    LOG.warn('dall-e-prompter: prompt bloqueado', { matched: analysis.matched });
    return {
      ok: false,
      prompt: '',
      original,
      style: null,
      added: [],
      safe: false,
      reason: 'contenido_no_permitido',
      matched: analysis.matched,
    };
  }

  const preset = PRESETS[opts.style] || PRESETS.cinematic;
  const useQuality = opts.quality !== false;

  const parts = [original];
  const added = [];

  // No se duplica la cola si el usuario ya la escribió.
  const lower = original.toLowerCase();

  if (useQuality) {
    const missing = CFG.qualitySuffix
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !lower.includes(s.toLowerCase()));

    if (missing.length) {
      parts.push(missing.join(', '));
      added.push(...missing);
    }
  }

  const presetTokens = preset.suffix
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && !lower.includes(s.toLowerCase()));

  if (presetTokens.length) {
    parts.push(presetTokens.join(', '));
    added.push(...presetTokens);
  }

  const prompt = parts.join(', ').slice(0, CFG.maxPromptChars);

  const negative = clean(
    opts.negative ? `${opts.negative}, ${preset.negative}` : preset.negative,
    300
  );

  return {
    ok: true,
    prompt,
    original,
    style: preset.id,
    styleLabel: preset.label,
    negative,
    added,
    safe: true,
    reason: null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · URL DE POLLINATIONS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Construye la URL de Pollinations con los parámetros correctos.
 *
 * @param {string} prompt  Prompt YA enriquecido
 * @param {object} [opts]  { width, height, model, seed, nologo, enhance }
 * @returns {string}
 */
export function buildPollinationsUrl(prompt, opts = {}) {
  const text = clean(prompt, CFG.maxPromptChars);
  if (!text) throw new Error('Prompt vacío.');

  const { width, height } = normalizeSize(opts.width, opts.height);
  const model = CFG.allowedModels.includes(opts.model) ? opts.model : 'flux';
  const seed = Number.isFinite(Number(opts.seed)) ? Number(opts.seed) : Math.floor(Math.random() * 1_000_000);

  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model,
    seed: String(seed),
    nologo: opts.nologo === false ? 'false' : 'true',
    enhance: opts.enhance === false ? 'false' : 'true',
  });

  const negative = clean(opts.negative, 300);
  if (negative) params.set('negative', negative);

  return `${CFG.pollinationsBase}/${encodeURIComponent(text)}?${params.toString()}`;
}

/**
 * Atajo: prompt crudo → prompt enriquecido + URL lista.
 */
export function prepareImage(rawPrompt, opts = {}) {
  const enhanced = enhanceImagePrompt(rawPrompt, opts);

  if (!enhanced.ok) {
    return {
      ok: false,
      error: enhanced.reason === 'contenido_no_permitido'
        ? 'Ese prompt no cumple la política de contenido de Numination.'
        : 'El prompt está vacío.',
      code: enhanced.reason,
      enhanced,
    };
  }

  const size = normalizeSize(opts.width, opts.height);

  let url = null;
  try {
    url = buildPollinationsUrl(enhanced.prompt, { ...opts, ...size, negative: enhanced.negative });
  } catch (e) {
    return { ok: false, error: e.message, code: 'url_failed', enhanced };
  }

  return {
    ok: true,
    url,
    prompt: enhanced.prompt,
    original: enhanced.original,
    negative: enhanced.negative,
    style: enhanced.style,
    styleLabel: enhanced.styleLabel,
    added: enhanced.added,
    width: size.width,
    height: size.height,
    model: opts.model || 'flux',
    seed: opts.seed || null,
  };
}

export function getPrompterStatus() {
  return {
    qualitySuffix: CFG.qualitySuffix,
    presets: Object.values(PRESETS).map((p) => ({ id: p.id, label: p.label })),
    sizes: CFG.allowedSizes.map((s) => `${s[0]}x${s[1]}`),
    maxPromptChars: CFG.maxPromptChars,
    blockTerms: HARD_BLOCK.length,
  };
}

export default {
  enhanceImagePrompt,
  buildPollinationsUrl,
  prepareImage,
  analyzeImagePrompt,
  getPrompterStatus,
  PRESETS,
};
