/* ================================================================
   src/services/images.js · v1.0 minimal
   ----------------------------------------------------------------
   Generación de imágenes con Pollinations.
   Detecta intención de imagen en el mensaje y construye URLs.
   Sin dependencias externas.
   ================================================================ */

const POLLINATIONS_BASE = 'https://image.pollinations.ai/prompt';

/* ─── Detección de intención de imagen ─── */
const IMG_TRIGGERS = [
  /^genera(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
  /^crea(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
  /^haz(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
  /^dibuja(me)?\s+/i,
  /^ilustra(me)?\s+/i,
  /^quiero\s+ver\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
  /^muestra(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
  /^pinta(me)?\s+/i,
];

export function isImageRequest(message) {
  if (!message) return false;
  const m = String(message).trim();
  return IMG_TRIGGERS.some((re) => re.test(m));
}

/* ─── Extracción del prompt limpio ─── */
export function extractImagePrompt(message) {
  if (!message) return '';
  return String(message)
    .replace(/^(genera(me)?|crea(me)?|haz(me)?|muestra(me)?)\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i, '')
    .replace(/^dibuja(me)?\s+/i, '')
    .replace(/^ilustra(me)?\s+/i, '')
    .replace(/^pinta(me)?\s+/i, '')
    .replace(/^quiero\s+ver\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i, '')
    .trim();
}

/* ─── Enriquecimiento del prompt ─── */
const COLOMBIA_KEYWORDS = /colombia|colombiano|colombiana|café|cumbia|vallenato|magdalena|cóndor|arepa|barranquilla|medellín|bogotá|cartagena|cali|andes/i;

export function enrichPrompt(prompt) {
  const base = String(prompt || '').trim();
  if (!base) return base;

  if (COLOMBIA_KEYWORDS.test(base)) {
    return base + ', Colombia, vibrant colors, golden hour lighting, highly detailed, cinematic, 8k';
  }
  return base + ', warm colors, artistic style, high quality, detailed, cinematic';
}

/* ─── Constructor de URL de Pollinations ─── */
export function buildImageUrl(prompt, opts = {}) {
  const {
    width = 1024,
    height = 1024,
    model = 'flux',
    seed = Math.floor(Math.random() * 1e6),
    nologo = true,
    enhance = true,
  } = opts;

  const clean = String(prompt || '').trim().slice(0, 500);
  if (!clean) throw new Error('Prompt vacío');

  const enc = encodeURIComponent(clean);

  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model,
    seed: String(seed),
    nologo: nologo ? 'true' : 'false',
    enhance: enhance ? 'true' : 'false',
  });

  return `${POLLINATIONS_BASE}/${enc}?${params.toString()}`;
}

/* ─── Variación (mismo prompt, seed distinto) ─── */
export function buildVariationUrl(prompt, opts = {}) {
  return buildImageUrl(prompt, {
    ...opts,
    seed: Math.floor(Math.random() * 1e6),
  });
}

/* ─── Default export ─── */
export default {
  buildImageUrl,
  buildVariationUrl,
  isImageRequest,
  extractImagePrompt,
  enrichPrompt,
};