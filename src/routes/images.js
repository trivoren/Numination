/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/images.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   API de generación de imágenes.

   MONTADO
     mountImageRoutes(app) → añade:
       POST /api/images/generate   genera una imagen (filtro NSFW)
       GET  /api/images/proxy      sirve la imagen remota con firma válida
       GET  /api/images/status     estado del servicio

   SEGURIDAD
   · El prompt pasa por el filtro de contenido antes de tocar el
     proveedor: los términos bloqueados devuelven 422 con el código
     `content_blocked`.
   · El proxy exige firma HMAC válida y expirada + host en la lista
     blanca. Sin eso, 403. Esto cierra el SSRF y evita que cualquiera
     use el servidor como CDN abierto.
   · Límite por usuario (10 imágenes/minuto) para que un script no queme
     la cuota del proveedor.
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ValidationError, ForbiddenError, RateLimitError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import {
  generateImage,
  analyzePrompt,
  sanitizePrompt,
  verifyProxySignature,
  isAllowedRemoteUrl,
  getImageServiceStatus,
  PROMPT_FILTER,
} from '../services/image-generator.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · RATE LIMIT POR USUARIO
   ═══════════════════════════════════════════════════════════════════════════ */

const RATE = Object.freeze({
  windowMs: 60_000,
  max: 10,
});

const buckets = new Map();

function checkRate(userId) {
  const now = Date.now();
  let b = buckets.get(userId);
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + RATE.windowMs };
    buckets.set(userId, b);
  }
  b.count++;
  return {
    allowed: b.count <= RATE.max,
    remaining: Math.max(0, RATE.max - b.count),
    reset: b.reset,
    retryAfter: Math.max(1, Math.ceil((b.reset - now) / 1000)),
  };
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.reset <= now) buckets.delete(key);
  }
}, 60_000);
if (cleanup.unref) cleanup.unref();

/* ═══════════════════════════════════════════════════════════════════════════
   02 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function readInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function readString(value, max = 600) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · RUTAS
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountImageRoutes(app) {
  const router = express.Router();

  /* ─── POST /api/images/generate ─────────────────────────────────────── */
  router.post('/api/images/generate', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const rawPrompt = body.prompt ?? body.q ?? body.text ?? '';

    if (!rawPrompt || !String(rawPrompt).trim()) {
      throw new ValidationError('Describí la imagen que querés generar.', 'prompt');
    }

    const prompt = sanitizePrompt(rawPrompt);
    if (!prompt) {
      throw new ValidationError('El prompt quedó vacío al limpiarlo.', 'prompt');
    }

    // ── Filtro de contenido ───────────────────────────────────────────
    const filter = analyzePrompt(prompt);
    if (!filter.safe) {
      LOG.warn('images: prompt rechazado', {
        userId: req.user.id,
        matched: filter.matched,
        severity: filter.severity,
      });
      throw new ValidationError(
        'Ese prompt no cumple la política de contenido de Numination.',
        'prompt',
        'content_blocked'
      );
    }

    // ── Rate limit ────────────────────────────────────────────────────
    const rate = checkRate(req.user.id);
    res.setHeader('X-RateLimit-Limit', String(RATE.max));
    res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(rate.reset / 1000)));

    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfter));
      throw new RateLimitError(
        `Alcanzaste el máximo de ${RATE.max} imágenes por minuto.`,
        'limit_image_rate',
        rate.retryAfter
      );
    }

    const result = await generateImage({
      prompt,
      width: readInt(body.width, 1024),
      height: readInt(body.height, 1024),
      model: readString(body.model, 20) || 'flux',
      variation: Boolean(body.variation),
      enrich: body.enrich !== false,
    });

    if (!result.ok) {
      if (result.code === 'content_blocked') {
        throw new ValidationError(result.error || 'Prompt no permitido.', 'prompt', 'content_blocked');
      }
      throw new ValidationError(result.error || 'No se pudo generar la imagen.', 'prompt');
    }

    res.json({
      ok: true,
      image: {
        url: result.url,
        downloadUrl: result.downloadUrl || null,
        provider: result.provider,
        model: result.model,
        seed: result.seed,
        prompt: result.prompt,
        width: result.width,
        height: result.height,
        inline: result.inline,
        expiresAt: result.expiresAt || null,
        createdAt: result.createdAt,
      },
      filter: { severity: filter.severity },
    });
  }));

  /* ─── GET /api/images/proxy ─────────────────────────────────────────── */
  router.get('/api/images/proxy', asyncHandler(async (req, res) => {
    const target = readString(req.query.url, 2000);
    const exp = readString(req.query.exp, 20);
    const sig = readString(req.query.sig, 128);

    if (!target) {
      throw new ValidationError('Falta la URL de la imagen.', 'url');
    }

    const check = verifyProxySignature({ target, exp, sig });
    if (!check.valid) {
      throw new ForbiddenError(
        check.reason === 'expired'
          ? 'El enlace de la imagen expiró. Generala de nuevo.'
          : 'Firma inválida: no se puede servir esa imagen.'
      );
    }

    if (!isAllowedRemoteUrl(target)) {
      throw new ForbiddenError('Ese host no está permitido para el proxy de imágenes.');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);

    try {
      const upstream = await fetch(target, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { Accept: 'image/*' },
      });

      if (!upstream.ok) {
        throw new ValidationError('El proveedor de imágenes no respondió bien.', 'upstream');
      }

      const contentType = upstream.headers.get('content-type') || 'image/png';
      if (!contentType.startsWith('image/')) {
        throw new ForbiddenError('El recurso no es una imagen.');
      }

      const buffer = Buffer.from(await upstream.arrayBuffer());

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(buffer);
    } catch (e) {
      if (e.name === 'AbortError') {
        throw new ValidationError('El proveedor de imágenes tardó demasiado.', 'upstream');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }));

  /* ─── GET /api/images/status ────────────────────────────────────────── */
  router.get('/api/images/status', requireAuth, asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      status: getImageServiceStatus(),
      filter: {
        hardTerms: PROMPT_FILTER.hard.length,
        softTerms: PROMPT_FILTER.soft.length,
      },
    });
  }));

  app.use(router);

  LOG.info('images.routes.mounted', {
    endpoints: [
      'POST /api/images/generate',
      'GET /api/images/proxy',
      'GET /api/images/status',
    ],
  });

  return router;
}

export default { mountImageRoutes };
