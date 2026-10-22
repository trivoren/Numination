/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/image-generator.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Generación de imágenes con cadena de respaldo y URLs firmadas.

   CADENA DE PROVEEDORES
     1. `pollinations`  → image.pollinations.ai (sin API key, sin costo)
     2. `pollinations-alt` → mismo servicio, modelo alterno (turbo/flux)
     3. `local-svg` → SVG generado en el servidor (placeholder elegante)
        Se usa cuando no hay red o el proveedor rechaza el prompt: el
        chat NUNCA muestra una imagen rota.

   URLs FIRMADAS
   Las imágenes se exponen por URL con firma HMAC-SHA256:
       /api/images/<id>/file?exp=<epoch>&sig=<hex>
   La firma cubre id + expiración. Sin `exp`/`sig` válidos, el endpoint
   devuelve 403. El secreto sale de IMAGE_SIGNING_SECRET y, si no existe,
   se deriva del SESSION_SECRET (nunca se genera uno aleatorio en
   caliente: en un serverless reiniciado dejaría de validar URLs viejas).

   SEGURIDAD
   · El prompt se sanea (se recorta, se eliminan caracteres de control y
     se filtran los términos bloqueados).
   · La URL final siempre se valida: sólo se permiten hosts conocidos.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { buildImageUrl, buildVariationUrl, enrichPrompt, extractImagePrompt, isImageRequest } from './images.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  maxPromptChars: 500,
  defaultWidth: 1024,
  defaultHeight: 1024,
  allowedSizes: [
    [512, 512], [768, 768], [1024, 1024], [1024, 1792], [1792, 1024],
  ],
  signedUrlTtlSec: 60 * 60,        // 1 hora
  maxSignedUrlTtlSec: 60 * 60 * 24,
  allowedHosts: [
    'image.pollinations.ai',
    'cdn.pollinations.ai',
    'images.unsplash.com',
  ],
  timeoutMs: 25_000,
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · FILTRO DE CONTENIDO
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Términos bloqueados. Dos capas:
 *  · `hard`  → se rechaza la solicitud (violación de política).
 *  · `soft`  → se permite pero se registra (palabras ambiguas).
 *
 * La lista es conservadora a propósito: preferimos un falso positivo
 * ocasional a dejar pasar contenido sexual explícito o violencia
 * gráfica. El filtro es una primera barrera, no la única: los modelos
 * generativos de Pollinations también filtran en su lado.
 */
const HARD_BLOCK = [
  'nsfw', 'nude', 'nudes', 'naked', 'porn', 'porno', 'pornography', 'xxx',
  'sexo explícito', 'pornographic', 'erotic nude', 'genitalia', 'genitals',
  'hentai', 'fetish porn', 'sex acts', 'sexual intercourse', 'fellatio',
  'child porn', 'cp', 'underage nude', 'rape', 'bestiality', 'incest',
  'gore', 'dismemberment', 'beheading', 'torture porn',
];

const SOFT_BLOCK = [
  'kill', 'blood', 'weapon', 'nsfw-ish', 'seductive', 'sensual',
];

export const PROMPT_FILTER = Object.freeze({ hard: HARD_BLOCK, soft: SOFT_BLOCK });

/**
 * Analiza un prompt contra el filtro.
 * @returns {{safe:boolean, reason:string|null, matched:string|null, severity:'none'|'soft'|'hard'}}
 */
export function analyzePrompt(prompt) {
  const text = String(prompt || '').toLowerCase();

  for (const term of HARD_BLOCK) {
    if (text.includes(term)) {
      return { safe: false, reason: 'contenido_no_permitido', matched: term, severity: 'hard' };
    }
  }

  for (const term of SOFT_BLOCK) {
    if (text.includes(term)) {
      return { safe: true, reason: null, matched: term, severity: 'soft' };
    }
  }

  return { safe: true, reason: null, matched: null, severity: 'none' };
}

/** Normaliza y recorta un prompt de forma segura. */
export function sanitizePrompt(prompt) {
  return String(prompt || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CFG.maxPromptChars);
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · FIRMA DE URLs
   ═══════════════════════════════════════════════════════════════════════════ */

let _signingSecret = null;

function signingSecret() {
  if (_signingSecret) return _signingSecret;

  const explicit = process.env.IMAGE_SIGNING_SECRET;
  const fallback = process.env.SESSION_SECRET || process.env.JWT_SECRET;

  if (explicit && explicit.length >= 16) {
    _signingSecret = explicit;
  } else if (fallback && fallback.length >= 16) {
    _signingSecret = fallback;
  } else {
    // Último recurso: un secreto derivado y estable por instalación.
    // Sin esto, el servicio de imágenes no podría firmar (se degrada con
    // un aviso en el log).
    const machine = `${process.cwd()}|${process.env.NODE_ENV || 'dev'}`;
    _signingSecret = crypto.createHash('sha256').update(`numination-image-signing:${machine}`).digest('hex');
    LOG.warn('image-generator: sin IMAGE_SIGNING_SECRET, se usa un secreto derivado');
  }

  return _signingSecret;
}

function signPayload(payload) {
  return crypto.createHmac('sha256', signingSecret()).update(payload).digest('hex');
}

/**
 * Genera una URL firmada para descargar/mostrar una imagen.
 * La firma cubre `id.exp`.
 * @returns {{url:string, id:string, expiresAt:number, signature:string}}
 */
export function createSignedUrl({ id, basePath = '/api/images', ttlSec = CFG.signedUrlTtlSec, meta = '' } = {}) {
  const imageId = String(id || crypto.randomUUID());
  const ttl = Math.max(60, Math.min(parseInt(ttlSec, 10) || CFG.signedUrlTtlSec, CFG.maxSignedUrlTtlSec));
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const signature = signPayload(`${imageId}.${expiresAt}.${meta}`);
  const qs = new URLSearchParams({ exp: String(expiresAt), sig: signature });
  if (meta) qs.set('m', meta);

  return {
    id: imageId,
    expiresAt,
    signature,
    url: `${basePath}/${encodeURIComponent(imageId)}/file?${qs.toString()}`,
  };
}

/**
 * Genera una URL de proxy firmada para una imagen remota.
 * La firma cubre la URL de destino + expiración, así que nadie puede
 * redirigir el proxy a otro host (SSRF) ni alargar la vida del enlace.
 */
export function createProxyUrl({ target, basePath = '/api/images', ttlSec = CFG.signedUrlTtlSec } = {}) {
  const url = String(target || '');
  const ttl = Math.max(60, Math.min(parseInt(ttlSec, 10) || CFG.signedUrlTtlSec, CFG.maxSignedUrlTtlSec));
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const signature = signPayload(`${url}.${expiresAt}`);
  const qs = new URLSearchParams({
    url,
    exp: String(expiresAt),
    sig: signature,
  });

  return {
    url,
    expiresAt,
    signature,
    proxyUrl: `${basePath}/proxy?${qs.toString()}`,
  };
}

/**
 * Verifica una firma genérica.
 * @param {object} params
 * @param {string} params.subject  Lo que se firmó (id o URL destino)
 * @param {string|number} params.exp
 * @param {string} params.sig
 * @param {string} [params.meta]
 */
export function verifySignature({ subject, exp, sig, meta = '' }) {
  if (!subject || !exp || !sig) return { valid: false, reason: 'missing_signature' };

  const expiresAt = parseInt(exp, 10);
  if (!Number.isFinite(expiresAt)) return { valid: false, reason: 'bad_expiry' };
  if (expiresAt * 1000 < Date.now()) return { valid: false, reason: 'expired' };

  const expected = signPayload(`${subject}.${expiresAt}.${meta}`);
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);

  if (a.length !== b.length) return { valid: false, reason: 'bad_signature' };
  if (!crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'bad_signature' };

  return { valid: true, reason: null, expiresAt };
}

/**
 * Verifica una URL firmada de tipo /api/images/:id/file.
 */
export function verifySignedUrl({ id, exp, sig }) {
  return verifySignature({ subject: id, exp, sig });
}

/**
 * Verifica la firma de una URL de proxy.
 */
export function verifyProxySignature({ target, exp, sig }) {
  return verifySignature({ subject: target, exp, sig });
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · VALIDACIÓN DE URL REMOTA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Sólo se permiten hosts conocidos. Bloquea el SSRF y evita que una URL
 * generada por un modelo apunte a un recurso interno.
 */
export function isAllowedRemoteUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:') return false;
    return CFG.allowedHosts.includes(u.hostname);
  } catch {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · GENERACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Normaliza el tamaño a una tupla permitida.
 */
export function normalizeSize(width, height) {
  const w = parseInt(width, 10) || CFG.defaultWidth;
  const h = parseInt(height, 10) || CFG.defaultHeight;

  const exact = CFG.allowedSizes.find((s) => s[0] === w && s[1] === h);
  if (exact) return { width: exact[0], height: exact[1] };

  // Si no es exacto, se busca el más cercano por área.
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

/**
 * Genera una imagen.
 *
 * @param {object} params
 * @param {string} params.prompt
 * @param {number} [params.width]
 * @param {number} [params.height]
 * @param {string} [params.model]   'flux' | 'turbo'
 * @param {boolean} [params.variation]
 * @param {boolean} [params.enrich]
 * @returns {Promise<object>} { ok, url, provider, model, seed, prompt, signed }
 */
export async function generateImage(params = {}) {
  const {
    prompt: rawPrompt,
    width,
    height,
    model = 'flux',
    variation = false,
    enrich = true,
    signed = true,
  } = params;

  const clean = sanitizePrompt(rawPrompt);
  if (!clean) {
    return { ok: false, error: 'El prompt está vacío.', code: 'empty_prompt' };
  }

  const filter = analyzePrompt(clean);
  if (!filter.safe) {
    LOG.warn('image-generator: prompt bloqueado', { matched: filter.matched });
    return {
      ok: false,
      error: 'Ese prompt no cumple la política de contenido de Numination.',
      code: 'content_blocked',
      matched: filter.matched,
    };
  }

  if (filter.severity === 'soft') {
    LOG.info('image-generator: prompt con término sensible', { matched: filter.matched });
  }

  const finalPrompt = enrich ? enrichPrompt(clean) : clean;
  const { width: w, height: h } = normalizeSize(width, height);
  const seed = Math.floor(Math.random() * 1_000_000);

  const providers = [
    { name: 'pollinations', build: () => (variation ? buildVariationUrl : buildImageUrl)(finalPrompt, { width: w, height: h, model, seed }) },
    { name: 'pollinations-alt', build: () => buildImageUrl(finalPrompt, { width: w, height: h, model: model === 'flux' ? 'turbo' : 'flux', seed: seed + 1 }) },
  ];

  let chosen = null;

  for (const provider of providers) {
    try {
      const url = provider.build();
      if (!isAllowedRemoteUrl(url)) continue;
      chosen = { url, provider: provider.name, model: provider.name === 'pollinations-alt' ? (model === 'flux' ? 'turbo' : 'flux') : model };
      break;
    } catch (e) {
      LOG.warn(`image-generator: falló el proveedor ${provider.name}`, { error: e.message });
    }
  }

  if (!chosen) {
    // Respaldo local: un SVG con el prompt. Nunca una imagen rota.
    const svg = buildPlaceholderSvg(clean, w, h);
    chosen = {
      url: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
      provider: 'local-svg',
      model: 'placeholder',
      inline: true,
    };
  }

  const result = {
    ok: true,
    url: chosen.url,
    provider: chosen.provider,
    model: chosen.model,
    seed,
    prompt: clean,
    enrichedPrompt: finalPrompt,
    width: w,
    height: h,
    inline: Boolean(chosen.inline),
    createdAt: new Date().toISOString(),
  };

  if (signed && !chosen.inline) {
    const proxy = createProxyUrl({ target: chosen.url });
    result.signed = { expiresAt: proxy.expiresAt, signature: proxy.signature };
    result.downloadUrl = proxy.proxyUrl;
    result.expiresAt = proxy.expiresAt;
  }

  return result;
}

/**
 * SVG de respaldo: gradiente determinista + el prompt truncado.
 * Se ve deliberadamente bien: es un estado de la interfaz, no un error.
 */
export function buildPlaceholderSvg(prompt, width = 1024, height = 1024) {
  const hash = crypto.createHash('sha256').update(prompt).digest();
  const hue = hash[0] % 360;
  const hue2 = (hue + 40) % 360;
  const text = String(prompt).slice(0, 120);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 62%, 22%)"/>
      <stop offset="100%" stop-color="hsl(${hue2}, 58%, 12%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <circle cx="${width * 0.78}" cy="${height * 0.24}" r="${width * 0.18}" fill="rgba(255,255,255,.08)"/>
  <circle cx="${width * 0.22}" cy="${height * 0.78}" r="${width * 0.26}" fill="rgba(255,255,255,.05)"/>
  <text x="50%" y="50%" fill="rgba(255,255,255,.82)" font-family="Inter, system-ui, sans-serif"
        font-size="${Math.max(18, Math.round(width / 34))}" text-anchor="middle" dominant-baseline="middle">
    <tspan x="50%" dy="0">Imagen no disponible</tspan>
  </text>
  <text x="50%" y="${height * 0.58}" fill="rgba(255,255,255,.45)" font-family="Inter, system-ui, sans-serif"
        font-size="${Math.max(12, Math.round(width / 58))}" text-anchor="middle">${escapeXml(text)}</text>
</svg>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · UTILIDADES RE-EXPORTADAS
   ═══════════════════════════════════════════════════════════════════════════ */

export { isImageRequest, extractImagePrompt, enrichPrompt };

/**
 * Comprueba que la URL del proveedor responda (HEAD con timeout).
 * Se usa desde el endpoint de proxy para no mandar al cliente una URL
 * rota.
 */
export async function probeImageUrl(url, timeoutMs = 6000) {
  if (!isAllowedRemoteUrl(url)) return { ok: false, status: 0, reason: 'host_not_allowed' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
    });
    return { ok: res.ok, status: res.status, reason: res.ok ? null : 'http_error' };
  } catch (e) {
    return { ok: false, status: 0, reason: e.name === 'AbortError' ? 'timeout' : 'network_error' };
  } finally {
    clearTimeout(timer);
  }
}

export function getImageServiceStatus() {
  return {
    providers: ['pollinations', 'pollinations-alt', 'local-svg'],
    allowedHosts: CFG.allowedHosts,
    sizes: CFG.allowedSizes.map((s) => `${s[0]}x${s[1]}`),
    maxPromptChars: CFG.maxPromptChars,
    signedUrlTtlSec: CFG.signedUrlTtlSec,
    filterTerms: HARD_BLOCK.length,
  };
}

export default {
  generateImage,
  analyzePrompt,
  sanitizePrompt,
  createSignedUrl,
  createProxyUrl,
  verifySignedUrl,
  verifyProxySignature,
  verifySignature,
  isAllowedRemoteUrl,
  normalizeSize,
  buildPlaceholderSvg,
  probeImageUrl,
  getImageServiceStatus,
  isImageRequest,
  extractImagePrompt,
  enrichPrompt,
};
