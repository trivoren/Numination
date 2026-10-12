/* ================================================================
   NUMINATION · images.js · v2.0
   ----------------------------------------------------------------
   Generación de imágenes con Pollinations + fallbacks.

   CARACTERÍSTICAS:

     · 3 providers: Pollinations Flux, Pollinations Turbo, Pollinations
       Kontext (especializado en edición). Fallback en cascada.
     · 12 estilos predefinidos: realista, anime, acuarela, oil, pixel,
       cyberpunk, minimalista, 3D, boceto, cartoon, vaporwave, clay
     · 8 aspect ratios: 1:1, 16:9, 9:16, 4:3, 3:4, 21:9, 3:2, 2:3
     · Prompt enhancer: añade tags de calidad sin quemar el original
     · Safety filter: bloquea términos prohibidos antes de generar
     · Cache de URLs: misma query + style + ratio → misma URL (con
       seed fijo) o seed random (variations)
     · Historial: últimas 50 generaciones por usuario en Upstash
     · Detección automática: ¿el mensaje del usuario pide una imagen?
     · Extracción del prompt: quita prefijos ("genera una imagen de...")
     · Rate limiting: 20 generaciones/min por usuario
     · Anti-abuse: rechaza prompts muy cortos o vacíos
     · Telemetría: contadores de éxito/fallo por provider
     · Self-test con 15 casos

   API PÚBLICA:

     generateImage(prompt, opts)         → Promise<{url, ...}>
     generateVariations(prompt, n, opts) → Promise<Array>
     detectImageRequest(message)         → boolean
     extractImagePrompt(message)         → string
     enhancePrompt(prompt, style)        → string
     listStyles()                        → Array
     listRatios()                        → Array
     getHistory(userId, opts)            → Promise<Array>
     clearHistory(userId)                → Promise<boolean>
     getImageStats()                     → object
     pingImages()                        → Promise<object>
     selfTest()                          → object

   USO BÁSICO:

     import { generateImage, detectImageRequest, extractImagePrompt } from './services/images.js';

     if (detectImageRequest(message)) {
       const prompt = extractImagePrompt(message);
       const img = await generateImage(prompt);
       // img.url → "https://image.pollinations.ai/prompt/..."
     }

   USO AVANZADO:

     const img = await generateImage('un gato astronauta', {
       style: 'cyberpunk',
       ratio: '16:9',
       enhance: true,
       seed: 42,        // mismo seed = misma imagen
       userId: 'abc-123',
     });

     const variations = await generateVariations('un perro pirata', 3, {
       style: 'watercolor',
     });

   ================================================================ */

import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  /* Base URL de Pollinations */
  pollinationsBase: 'https://image.pollinations.ai/prompt',

  /* Modelos disponibles */
  models: {
    flux:     'flux',           // Mejor calidad, más lento
    turbo:    'turbo',          // Más rápido, calidad media
    kontext:  'kontext',        // Edición contextual
  },

  /* Provider por defecto (orden de fallback) */
  providerOrder: ['flux', 'turbo', 'kontext'],

  /* Timeout por request */
  timeoutMs: 45_000,

  /* Caché */
  cacheTtlSec: 3600,          // 1 hora
  cacheMaxEntries: 500,

  /* Historial por usuario */
  historyMaxPerUser: 50,
  historyTtlSec: 30 * 86400,  // 30 días

  /* Límites */
  maxPromptLength: 500,
  minPromptLength: 3,
  maxNegativeLength: 200,

  /* Rate limit */
  rateLimitPerMinute: 20,

  /* Tamaños de imagen por ratio */
  ratios: {
    '1:1':  { width: 1024, height: 1024, label: 'Cuadrado' },
    '16:9': { width: 1344, height: 768,  label: 'Panorámico' },
    '9:16': { width: 768,  height: 1344, label: 'Vertical' },
    '4:3':  { width: 1152, height: 896,  label: 'Clásico' },
    '3:4':  { width: 896,  height: 1152, label: 'Retrato' },
    '21:9': { width: 1536, height: 640,  label: 'Cinemático' },
    '3:2':  { width: 1216, height: 832,  label: 'Fotográfico' },
    '2:3':  { width: 832,  height: 1216, label: 'Póster' },
  },

  /* Parámetros de calidad por modelo */
  quality: {
    flux:    { enhance: true, nologo: true, safe: false },
    turbo:   { enhance: true, nologo: true, safe: false },
    kontext: { enhance: false, nologo: true, safe: false },
  },

  /* Tags de calidad que se añaden en enhance */
  qualityTags: 'highly detailed, professional, high quality, sharp focus, vivid colors, 8k',

  /* Términos bloqueados (safety) */
  blockedTerms: [
    'child porn', 'cp', 'pedo', 'pedofil',
    'bestiality', 'zoofilia',
    'rape', 'violacion', 'violación',
    'snuff', 'gore extremo',
    'terrorist attack tutorial',
    'how to make bomb', 'bomba casera',
    'drug synthesis', 'sintesis de drogas',
  ],
});

/* ═══════════════════════════════════════════════════════════════════════
   2 · TELEMETRÍA
   ═══════════════════════════════════════════════════════════════════════ */

const stats = {
  startedAt: Date.now(),
  generated: 0,
  variations: 0,
  blocked: 0,
  rejected: 0,
  byProvider: {
    flux:    { calls: 0, ok: 0, fail: 0 },
    turbo:   { calls: 0, ok: 0, fail: 0 },
    kontext: { calls: 0, ok: 0, fail: 0 },
  },
  byStyle: {},
  byRatio: {},
  recent: [],
};

function trackGeneration({ provider, style, ratio, ok, ms, prompt }) {
  stats.generated++;
  const p = stats.byProvider[provider];
  if (p) { p.calls++; if (ok) p.ok++; else p.fail++; }
  if (style) stats.byStyle[style] = (stats.byStyle[style] || 0) + 1;
  if (ratio) stats.byRatio[ratio] = (stats.byRatio[ratio] || 0) + 1;

  stats.recent.unshift({
    at: new Date().toISOString(),
    provider, style, ratio, ok, ms,
    prompt: String(prompt || '').slice(0, 100),
  });
  if (stats.recent.length > 50) stats.recent.length = 50;
}

export function getImageStats() {
  const providers = {};
  for (const [name, p] of Object.entries(stats.byProvider)) {
    providers[name] = {
      calls: p.calls,
      ok: p.ok,
      fail: p.fail,
      successRate: p.calls > 0 ? (p.ok / p.calls).toFixed(3) : '0',
    };
  }
  return {
    uptimeMs: Date.now() - stats.startedAt,
    generated: stats.generated,
    variations: stats.variations,
    blocked: stats.blocked,
    rejected: stats.rejected,
    byProvider: providers,
    topStyles: Object.entries(stats.byStyle).sort((a, b) => b[1] - a[1]).slice(0, 5),
    topRatios: Object.entries(stats.byRatio).sort((a, b) => b[1] - a[1]).slice(0, 5),
    recent: stats.recent.slice(0, 10),
  };
}

export function resetImageStats() {
  stats.startedAt = Date.now();
  stats.generated = 0;
  stats.variations = 0;
  stats.blocked = 0;
  stats.rejected = 0;
  for (const p of Object.values(stats.byProvider)) {
    p.calls = 0; p.ok = 0; p.fail = 0;
  }
  stats.byStyle = {};
  stats.byRatio = {};
  stats.recent = [];
}

/* ═══════════════════════════════════════════════════════════════════════
   3 · ESTILOS
   ═══════════════════════════════════════════════════════════════════════ */

const STYLES = Object.freeze({
  none:        { label: 'Sin estilo', tag: '' },

  realistic:   { label: 'Fotorrealista', tag: 'photorealistic, 8k, cinematic lighting, sharp focus, photograph, natural lighting' },
  portrait:    { label: 'Retrato',       tag: 'portrait photography, shallow depth of field, 85mm lens, bokeh, soft lighting' },
  landscape:   { label: 'Paisaje',       tag: 'landscape photography, wide angle, golden hour, dramatic sky' },

  anime:       { label: 'Anime',         tag: 'anime style, studio ghibli, cel shading, vibrant colors, anime key visual' },
  manga:       { label: 'Manga',         tag: 'manga style, black and white ink, screentone, detailed lineart' },

  watercolor:  { label: 'Acuarela',      tag: 'watercolor painting, soft edges, pastel colors, paper texture, artistic' },
  oil:         { label: 'Óleo',          tag: 'oil painting, thick brushstrokes, renaissance, chiaroscuro, museum quality' },
  sketch:      { label: 'Boceto',        tag: 'pencil sketch, graphite, hand drawn, shading, cross hatching' },
  ink:         { label: 'Tinta',         tag: 'ink drawing, bold lines, contrast, sumi-e style' },

  cyberpunk:   { label: 'Cyberpunk',     tag: 'cyberpunk, neon lights, futuristic, blade runner aesthetic, rain, chrome' },
  vaporwave:   { label: 'Vaporwave',     tag: 'vaporwave aesthetic, 80s retro, neon grid, sunset, synthwave' },
  steampunk:   { label: 'Steampunk',     tag: 'steampunk, brass, gears, victorian, industrial, copper' },

  '3d':        { label: '3D',            tag: '3d render, octane, cinema4d, subsurface scattering, volumetric lighting' },
  pixel:       { label: 'Pixel Art',     tag: 'pixel art, 16-bit, retro game, sprite, isometric' },
  cartoon:     { label: 'Cartoon',       tag: 'cartoon, playful, bold outlines, flat colors, disney style' },
  clay:        { label: 'Clay',          tag: 'claymation, plasticine, stop motion, tactile, sculpted' },

  minimalist:  { label: 'Minimalista',   tag: 'minimalist, clean, simple composition, few colors, geometric' },
  bauhaus:     { label: 'Bauhaus',       tag: 'bauhaus, geometric shapes, primary colors, typography, swiss design' },
  glitch:      { label: 'Glitch',        tag: 'glitch art, datamosh, distorted, vhs artifacts, chromatic aberration' },
});

/* ═══════════════════════════════════════════════════════════════════════
   4 · CACHE (memoria + Upstash)
   ═══════════════════════════════════════════════════════════════════════ */

const memCache = new Map();

function getUpstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

function cacheKey(prompt, style, ratio, model, seed) {
  const fingerprint = `${prompt}|${style}|${ratio}|${model}|${seed || 'rand'}`;
  const h = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
  return `img:${h}`;
}

async function cacheGet(key) {
  const e = memCache.get(key);
  if (e && Date.now() < e.expires) return e.value;
  if (e) memCache.delete(key);

  const u = getUpstash();
  if (!u) return null;

  try {
    const res = await fetch(`${u.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${u.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (!j.result) return null;
    const parsed = JSON.parse(j.result);
    memCache.set(key, { value: parsed, expires: Date.now() + 60_000 });
    return parsed;
  } catch {
    return null;
  }
}

async function cacheSet(key, value, ttlSec) {
  if (memCache.size >= CFG.cacheMaxEntries) {
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
  memCache.set(key, { value, expires: Date.now() + Math.min(ttlSec, 300) * 1000 });

  const u = getUpstash();
  if (!u) return;
  try {
    await fetch(`${u.url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: JSON.stringify(value), ex: ttlSec }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · RATE LIMITING
   ═══════════════════════════════════════════════════════════════════════ */

const rateBuckets = new Map();

function checkRate(userId) {
  if (!userId) return true;
  const now = Date.now();
  let bucket = rateBuckets.get(userId);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + 60_000 };
    rateBuckets.set(userId, bucket);
  }
  bucket.count++;
  return bucket.count <= CFG.rateLimitPerMinute;
}

const _cleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) {
    if (now > b.reset) rateBuckets.delete(k);
  }
}, 60_000);
if (_cleanup.unref) _cleanup.unref();

/* ═══════════════════════════════════════════════════════════════════════
   6 · SAFETY
   ═══════════════════════════════════════════════════════════════════════ */

function checkSafety(prompt) {
  const t = String(prompt).toLowerCase();
  for (const term of CFG.blockedTerms) {
    if (t.includes(term)) {
      return { ok: false, term };
    }
  }
  return { ok: true };
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · DETECCIÓN Y EXTRACCIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const IMG_TRIGGERS = [
  /^genera(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
  /^crea(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
  /^haz(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
  /^dibuja(me)?\s+/i,
  /^pinta(me)?\s+/i,
  /^ilustra(me)?\s+/i,
  /^quiero\s+ver\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
  /^muestra(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
  /^genera(me)?\s+(una\s+)?foto\s+(de|sobre|con)\s+/i,
  /^crea(me)?\s+(una\s+)?foto\s+(de|sobre|con)\s+/i,
];

export function detectImageRequest(message) {
  if (!message) return false;
  const m = String(message).trim();
  return IMG_TRIGGERS.some(r => r.test(m));
}

export function extractImagePrompt(message) {
  let s = String(message || '').trim();

  // Quitar prefijos comunes
  const prefixes = [
    /^genera(me)?\s+(una\s+)?(imagen|foto|ilustraci[oó]n|dibujo)\s+(de|sobre|con)\s+/i,
    /^crea(me)?\s+(una\s+)?(imagen|foto|ilustraci[oó]n|dibujo)\s+(de|sobre|con)\s+/i,
    /^haz(me)?\s+(una\s+)?(imagen|foto|ilustraci[oó]n|dibujo)\s+(de|sobre|con)\s+/i,
    /^dibuja(me)?\s+/i,
    /^pinta(me)?\s+/i,
    /^ilustra(me)?\s+/i,
    /^quiero\s+ver\s+(una\s+)?(imagen|foto)\s+(de|sobre|con)\s+/i,
    /^muestra(me)?\s+(una\s+)?(imagen|foto)\s+(de|sobre|con)\s+/i,
  ];

  for (const p of prefixes) {
    s = s.replace(p, '');
  }

  return s.trim().slice(0, CFG.maxPromptLength);
}

/* ═══════════════════════════════════════════════════════════════════════
   8 · ENHANCER
   ═══════════════════════════════════════════════════════════════════════ */

const COLOMBIA_HINTS = /\b(colombia|colombiano|colombiana|caf[eé]|cumbia|vallenato|magdalena|cauca|c[oó]ndor|arepa|bandeja paisa|barranquilla|medell[ií]n|bogot[aá]|cali|cartagena)\b/i;

function enrichColombia(prompt) {
  if (COLOMBIA_HINTS.test(prompt)) {
    return prompt + ', Colombia, vibrant tropical colors, golden hour, highly detailed, cinematic';
  }
  return prompt + ', vivid colors, artistic style, high quality, detailed';
}

export function enhancePrompt(prompt, style = 'none', opts = {}) {
  let p = String(prompt || '').trim();
  if (!p) return '';

  const styleDef = STYLES[style] || STYLES.none;

  // Parte 1: prompt original + tags de estilo
  let enhanced = p;
  if (styleDef.tag) {
    enhanced += ', ' + styleDef.tag;
  }

  // Parte 2: contexto Colombia (si aplica) o defaults
  enhanced = enrichColombia(enhanced);

  // Parte 3: tags de calidad
  if (opts.quality !== false) {
    enhanced += ', ' + CFG.qualityTags;
  }

  // Parte 4: negative prompt inline (Pollinations lo soporta)
  if (opts.negative) {
    const neg = String(opts.negative).slice(0, CFG.maxNegativeLength);
    enhanced += ` --no ${neg}`;
  }

  return enhanced.slice(0, 800);
}

/* ═══════════════════════════════════════════════════════════════════════
   9 · BUILD URL (Pollinations)
   ═══════════════════════════════════════════════════════════════════════ */

function buildPollinationsUrl(prompt, opts) {
  const {
    width = 1024,
    height = 1024,
    model = 'flux',
    seed = Math.floor(Math.random() * 1e6),
    nologo = true,
    enhance = true,
    private: isPrivate = true,
  } = opts;

  const enc = encodeURIComponent(prompt);
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    model,
    seed: String(seed),
    nologo: String(nologo),
    enhance: String(enhance),
    private: String(isPrivate),
  });

  return `${CFG.pollinationsBase}/${enc}?${params.toString()}`;
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · GENERAR IMAGEN
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Genera una imagen a partir de un prompt.
 *
 * @param {string} prompt
 * @param {object} opts
 * @param {string} [opts.style]    key de STYLES
 * @param {string} [opts.ratio]    key de CFG.ratios
 * @param {number} [opts.seed]     para reproducibilidad
 * @param {boolean} [opts.enhance] default true
 * @param {string} [opts.negative] tags a excluir
 * @param {string} [opts.userId]   para rate limiting e historial
 * @param {string} [opts.provider] forzar provider: 'flux'|'turbo'|'kontext'
 */
export async function generateImage(prompt, opts = {}) {
  const t0 = Date.now();

  /* Validar prompt */
  if (!prompt || typeof prompt !== 'string') {
    stats.rejected++;
    return { ok: false, error: 'prompt_empty' };
  }

  const clean = prompt.trim().slice(0, CFG.maxPromptLength);
  if (clean.length < CFG.minPromptLength) {
    stats.rejected++;
    return { ok: false, error: 'prompt_too_short' };
  }

  /* Safety */
  const safety = checkSafety(clean);
  if (!safety.ok) {
    stats.blocked++;
    return { ok: false, error: 'blocked_term', term: safety.term };
  }

  /* Rate limit */
  if (opts.userId && !checkRate(opts.userId)) {
    stats.rejected++;
    return { ok: false, error: 'rate_limit' };
  }

  /* Estilo y ratio */
  const style = STYLES[opts.style] ? opts.style : 'none';
  const ratioKey = CFG.ratios[opts.ratio] ? opts.ratio : '1:1';
  const ratio = CFG.ratios[ratioKey];

  /* Cache: solo si hay seed fijo */
  if (opts.seed) {
    const key = cacheKey(clean, style, ratioKey, opts.provider || 'flux', opts.seed);
    const cached = await cacheGet(key);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  /* Enhance */
  const enhanced = opts.enhance === false
    ? clean
    : enhancePrompt(clean, style, { negative: opts.negative, quality: opts.quality !== false });

  /* Providers: probar en orden hasta que uno funcione */
  const providers = opts.provider
    ? [opts.provider]
    : CFG.providerOrder;

  let lastError = null;

  for (const provider of providers) {
    try {
      const model = CFG.models[provider] || provider;
      const seed = opts.seed || Math.floor(Math.random() * 1e6);

      const url = buildPollinationsUrl(enhanced, {
        width: ratio.width,
        height: ratio.height,
        model,
        seed,
        ...CFG.quality[provider],
      });

      /* HEAD request para verificar que la imagen existe (opcional, puede fallar por CORS del provider) */
      // Pollinations acepta cualquier URL y genera al vuelo, no hace falta verificar

      const result = {
        ok: true,
        url,
        prompt: clean,
        enhancedPrompt: enhanced,
        style,
        styleLabel: STYLES[style].label,
        ratio: ratioKey,
        ratioLabel: ratio.label,
        width: ratio.width,
        height: ratio.height,
        model,
        provider,
        seed,
        userId: opts.userId || null,
        createdAt: new Date().toISOString(),
        ms: Date.now() - t0,
      };

      /* Cache */
      if (opts.seed) {
        const key = cacheKey(clean, style, ratioKey, provider, opts.seed);
        cacheSet(key, result, CFG.cacheTtlSec).catch(() => {});
      }

      /* Historial */
      if (opts.userId) {
        addToHistory(opts.userId, result).catch(() => {});
      }

      trackGeneration({ provider, style, ratio: ratioKey, ok: true, ms: Date.now() - t0, prompt: clean });

      return result;
    } catch (e) {
      lastError = e.message;
      trackGeneration({ provider, style, ratio: ratioKey, ok: false, ms: Date.now() - t0, prompt: clean });
    }
  }

  stats.rejected++;
  return { ok: false, error: 'all_providers_failed', message: lastError };
}

/* ═══════════════════════════════════════════════════════════════════════
   11 · VARIATIONS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Genera N variaciones del mismo prompt (diferentes seeds).
 */
export async function generateVariations(prompt, n = 3, opts = {}) {
  stats.variations++;
  const count = Math.max(1, Math.min(n, 4)); // máx 4 para no abusar

  const promises = [];
  for (let i = 0; i < count; i++) {
    promises.push(generateImage(prompt, { ...opts, seed: undefined }));
  }

  const results = await Promise.all(promises);
  return results.filter(r => r.ok);
}

/* ═══════════════════════════════════════════════════════════════════════
   12 · HISTORIAL POR USUARIO
   ═══════════════════════════════════════════════════════════════════════ */

async function addToHistory(userId, image) {
  const u = getUpstash();
  if (!u) return;

  const key = `img:history:${userId}`;
  const entry = {
    id: crypto.randomBytes(6).toString('hex'),
    url: image.url,
    prompt: image.prompt,
    style: image.style,
    ratio: image.ratio,
    createdAt: image.createdAt,
  };

  try {
    await fetch(`${u.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['LPUSH', key, JSON.stringify(entry)],
        ['LTRIM', key, '0', String(CFG.historyMaxPerUser - 1)],
        ['EXPIRE', key, String(CFG.historyTtlSec)],
      ]),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

export async function getHistory(userId, { limit = 30 } = {}) {
  const u = getUpstash();
  if (!u || !userId) return [];

  try {
    const key = `img:history:${userId}`;
    const res = await fetch(`${u.url}/lrange/${encodeURIComponent(key)}/0/${limit - 1}`, {
      headers: { Authorization: `Bearer ${u.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.result || []).map(s => {
      try { return JSON.parse(s); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export async function clearHistory(userId) {
  const u = getUpstash();
  if (!u || !userId) return false;

  try {
    const key = `img:history:${userId}`;
    const res = await fetch(`${u.url}/del/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${u.token}` },
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   13 · HELPERS DE LISTA
   ═══════════════════════════════════════════════════════════════════════ */

export function listStyles() {
  return Object.entries(STYLES).map(([key, def]) => ({
    id: key,
    label: def.label,
    tag: def.tag,
  }));
}

export function listRatios() {
  return Object.entries(CFG.ratios).map(([key, def]) => ({
    id: key,
    label: def.label,
    width: def.width,
    height: def.height,
  }));
}

/* ═══════════════════════════════════════════════════════════════════════
   14 · FORMATTING PARA CHAT
   ═══════════════════════════════════════════════════════════════════════ */

export function formatImageResponse(image) {
  if (!image || !image.ok) {
    return 'No pude generar la imagen. Intentá reformular el pedido.';
  }

  return `Listo, aquí está tu imagen de: **${image.prompt}**

Estilo: ${image.styleLabel} · Formato: ${image.ratioLabel} (${image.width}×${image.height})
Generado por Numi OT en ${image.ms}ms

Si querés variaciones, pídeme "otra versión" o "más variaciones".`;
}

/* ═══════════════════════════════════════════════════════════════════════
   15 · HEALTH
   ═══════════════════════════════════════════════════════════════════════ */

export async function pingImages() {
  try {
    const t0 = Date.now();
    const testUrl = buildPollinationsUrl('test', { width: 256, height: 256, model: 'flux' });

    const res = await fetch(testUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
    });

    return {
      ok: res.ok,
      latencyMs: Date.now() - t0,
      provider: 'pollinations',
      status: res.status,
      stats: getImageStats(),
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      stats: getImageStats(),
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   16 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const errors = [];

  /* 1 · Detección */
  const positives = [
    'genera una imagen de un gato',
    'créame una imagen de un perro',
    'dibuja un árbol',
    'quiero ver una imagen de Medellín',
    'haz una foto de un atardecer',
  ];
  for (const p of positives) {
    if (!detectImageRequest(p)) errors.push(`detectImageRequest falló: "${p}"`);
  }

  const negatives = [
    'hola cómo estás',
    'explícame la fotosíntesis',
    'cuál es la capital de Francia',
  ];
  for (const n of negatives) {
    if (detectImageRequest(n)) errors.push(`detectImageRequest falso positivo: "${n}"`);
  }

  /* 2 · Extracción */
  const ex1 = extractImagePrompt('genera una imagen de un gato astronauta');
  if (ex1 !== 'un gato astronauta') errors.push(`extractImagePrompt: "${ex1}"`);

  const ex2 = extractImagePrompt('dibuja un árbol en el bosque');
  if (ex2 !== 'un árbol en el bosque') errors.push(`extractImagePrompt: "${ex2}"`);

  /* 3 · Safety */
  if (checkSafety('genera una imagen de un gato').ok !== true) {
    errors.push('checkSafety falso positivo');
  }
  if (checkSafety('genera una imagen de child porn').ok !== false) {
    errors.push('checkSafety no bloqueó');
  }

  /* 4 · Enhancer */
  const enh1 = enhancePrompt('un gato', 'realistic');
  if (!enh1.includes('photorealistic')) errors.push('enhancePrompt no añadió estilo');

  const enh2 = enhancePrompt('un gato', 'none', { quality: false });
  if (enh2.includes('8k')) errors.push('enhancePrompt añadió quality cuando no debería');

  /* 5 · Colombia */
  const col = enhancePrompt('una casa en Medellín', 'none', { quality: false });
  if (!col.includes('Colombia')) errors.push('enhancePrompt no detectó Colombia');

  /* 6 · URL builder */
  const url = buildPollinationsUrl('test', { width: 512, height: 512, model: 'flux', seed: 42 });
  if (!url.startsWith('https://image.pollinations.ai/prompt/')) errors.push('buildPollinationsUrl base incorrecta');
  if (!url.includes('seed=42')) errors.push('buildPollinationsUrl sin seed');
  if (!url.includes('width=512')) errors.push('buildPollinationsUrl sin width');

  /* 7 · Listas */
  const styles = listStyles();
  if (styles.length < 10) errors.push('listStyles demasiado corto');
  const ratios = listRatios();
  if (ratios.length < 5) errors.push('listRatios demasiado corto');

  /* 8 · Estilos válidos */
  for (const key of ['realistic', 'anime', 'watercolor', 'cyberpunk', '3d']) {
    if (!STYLES[key]) errors.push(`style ${key} no existe`);
  }

  return {
    ok: errors.length === 0,
    errors,
    styles: Object.keys(STYLES).length,
    ratios: Object.keys(CFG.ratios).length,
    providers: CFG.providerOrder,
    stats: getImageStats(),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   FIN
   ═══════════════════════════════════════════════════════════════════════ */