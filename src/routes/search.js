/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/search.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Búsqueda web en tiempo real.

   MONTADO
     mountSearchRoutes(app) → añade:
       POST /api/search/web     busca en internet (máx. 5 por minuto)
       GET  /api/search/status  proveedores disponibles

   RATE LIMIT
   5 búsquedas por minuto y por usuario. Es un límite estricto a
   propósito: la búsqueda web consume una clave de pago por consulta y
   es el vector más fácil de abusar para drenar la cuota.

   Implementación: ventana deslizante por usuario + refuerzo por IP.
   Se devuelven las cabeceras X-RateLimit-* y 429 con Retry-After cuando
   se excede.

   NOTA
   `/api/search` (búsqueda interna de chats/memorias) ya existe en
   src/index.js. Esta ruta es la búsqueda EXTERNA y vive en /api/search/web.
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ValidationError, RateLimitError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import { searchWeb, formatResultsForAI, toSources, getSearchStatus } from '../services/web-search.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · RATE LIMIT · ventana deslizante
   ═══════════════════════════════════════════════════════════════════════════ */

const RATE = Object.freeze({
  windowMs: 60_000,
  maxPerUser: 5,
  maxPerIp: 15,
});

/** userId → timestamps de las últimas búsquedas */
const userHits = new Map();
/** ip → timestamps */
const ipHits = new Map();

function hit(map, key, windowMs, max) {
  const now = Date.now();
  const list = (map.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  map.set(key, list);

  const oldest = list[0];
  return {
    allowed: list.length <= max,
    count: list.length,
    remaining: Math.max(0, max - list.length),
    resetAt: oldest + windowMs,
    retryAfter: Math.max(1, Math.ceil((oldest + windowMs - now) / 1000)),
  };
}

function clientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, list] of userHits) {
    const fresh = list.filter((t) => now - t < RATE.windowMs);
    if (!fresh.length) userHits.delete(key);
    else userHits.set(key, fresh);
  }
  for (const [key, list] of ipHits) {
    const fresh = list.filter((t) => now - t < RATE.windowMs);
    if (!fresh.length) ipHits.delete(key);
    else ipHits.set(key, fresh);
  }
}, 30_000);
if (cleanup.unref) cleanup.unref();

/* ═══════════════════════════════════════════════════════════════════════════
   02 · RUTAS
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountSearchRoutes(app) {
  const router = express.Router();

  /* ─── POST /api/search/web ─────────────────────────────────────────── */
  router.post('/api/search/web', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const query = String(body.query ?? body.q ?? '').trim();

    if (!query) {
      throw new ValidationError('Escribí qué querés buscar.', 'query');
    }
    if (query.length > 300) {
      throw new ValidationError('La consulta es demasiado larga.', 'query');
    }

    // ── Rate limit por usuario ─────────────────────────────────────────
    const user = hit(userHits, req.user.id, RATE.windowMs, RATE.maxPerUser);

    // ── Rate limit por IP (defensa adicional contra cuentas múltiples) ─
    const ip = hit(ipHits, clientIp(req), RATE.windowMs, RATE.maxPerIp);

    res.setHeader('X-RateLimit-Limit', String(RATE.maxPerUser));
    res.setHeader('X-RateLimit-Remaining', String(user.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(user.resetAt / 1000)));

    if (!user.allowed) {
      res.setHeader('Retry-After', String(user.retryAfter));
      LOG.warn('search.rate_limited', { userId: req.user.id, count: user.count });
      throw new RateLimitError(
        `Máximo ${RATE.maxPerUser} búsquedas por minuto. Probá en ${user.retryAfter}s.`,
        'limit_search_rate',
        user.retryAfter
      );
    }

    if (!ip.allowed) {
      res.setHeader('Retry-After', String(ip.retryAfter));
      throw new RateLimitError(
        'Demasiadas búsquedas desde esta conexión. Probá en un minuto.',
        'limit_search_rate',
        ip.retryAfter
      );
    }

    // ── Búsqueda ───────────────────────────────────────────────────────
    const maxResults = Math.max(1, Math.min(parseInt(body.maxResults, 10) || 6, 12));

    const result = await searchWeb(query, {
      maxResults,
      language: String(body.language || 'es').slice(0, 5),
      country: String(body.country || 'co').slice(0, 5),
      includeAnswer: body.includeAnswer !== false,
      topic: body.topic ? String(body.topic).slice(0, 20) : undefined,
      days: body.days ? Math.min(parseInt(body.days, 10) || 7, 30) : undefined,
      noCache: body.fresh === true,
    });

    if (!result.ok) {
      LOG.warn('search.failed', { userId: req.user.id, error: result.error });
      throw new ValidationError(result.error || 'No se pudo completar la búsqueda.', 'query', result.code || 'search_failed');
    }

    res.json({
      ok: true,
      query: result.query,
      provider: result.provider,
      answer: result.answer || null,
      cached: Boolean(result.cached),
      elapsedMs: result.elapsedMs,
      count: result.results.length,
      results: toSources(result.results),
      context: formatResultsForAI(result.query, result.results),
      remaining: user.remaining,
    });
  }));

  /* ─── GET /api/search/status ───────────────────────────────────────── */
  router.get('/api/search/status', requireAuth, asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      status: getSearchStatus(),
      rateLimit: {
        maxPerMinute: RATE.maxPerUser,
        maxPerIpPerMinute: RATE.maxPerIp,
        windowMs: RATE.windowMs,
      },
    });
  }));

  app.use(router);

  LOG.info('search.routes.mounted', {
    endpoints: ['POST /api/search/web', 'GET /api/search/status'],
    rateLimit: `${RATE.maxPerUser}/min por usuario`,
  });

  return router;
}

export default { mountSearchRoutes };
