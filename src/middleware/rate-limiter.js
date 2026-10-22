/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · middleware/rate-limiter.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Limitador de requests: 60 por minuto por IP.

   IMPLEMENTACIÓN
     Usa `express-rate-limit` cuando está instalado (es lo que se pidió);
     si no lo está, cae a un bucket en memoria con la misma semántica
     (ventana fija, mismo contrato de headers y de respuesta).

   CONTRATO DE RESPUESTA (429)
     {
       ok: false,
       error: "Vas muy rápido. Esperá 43 segundos.",
       code: "rate_limited",
       retryAfter: 43,
       limit: 60,
       windowMs: 60000
     }

   EXENCIONES
     · /api/health, /api/version, /api/ping → no se limitan (sondas de
       disponibilidad).
     · Se puede pasar una lista de rutas exentas al crear el limitador.

   NOTA SOBRE LA IP
     Se usa `req.ip`, que Express populate con `trust proxy`. En el
     index.js del proyecto `app.set('trust proxy', 1)` está configurado,
     así que la IP real del cliente se respeta detrás de un proxy.
   ═══════════════════════════════════════════════════════════════════════════ */

import { LOG } from '../lib/logger.js';

/* ─── express-rate-limit (opcional) ─────────────────────────────────────── */

let expressRateLimit = null;
try {
  const mod = await import('express-rate-limit');
  expressRateLimit = mod.default || mod.rateLimit || null;
} catch (e) {
  LOG.warn('rate-limiter: express-rate-limit no está instalado, se usa el limitador propio', {
    error: e.message,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

export const DEFAULTS = Object.freeze({
  windowMs: 60_000,
  limit: 60,
  keyGenerator: null,          // null → usa req.ip
  skipSuccessfulRequests: false,
  skipPaths: ['/api/health', '/api/version', '/api/ping'],
  message: null,               // null → mensaje por defecto
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · LIMITADOR PROPIO (fallback)
   ═══════════════════════════════════════════════════════════════════════════ */

const buckets = new Map();

function cleanup() {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.reset <= now) buckets.delete(key);
  }
}

const cleanupTimer = setInterval(cleanup, 60_000);
if (cleanupTimer.unref) cleanupTimer.unref();

function fallbackLimiter(options) {
  const { windowMs, limit, keyGenerator, skipPaths, message } = options;

  return function limitRequest(req, res, next) {
    if (skipPaths && skipPaths.length && skipPaths.includes(req.path)) {
      return next();
    }

    const key = keyGenerator ? keyGenerator(req) : (req.ip || req.socket?.remoteAddress || 'unknown');
    const now = Date.now();

    let bucket = buckets.get(key);
    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count++;

    const remaining = Math.max(0, limit - bucket.count);
    const retryAfter = Math.max(1, Math.ceil((bucket.reset - now) / 1000));

    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.reset / 1000)));

    if (bucket.count > limit) {
      res.setHeader('Retry-After', String(retryAfter));

      LOG.warn('rate-limit.exceeded', {
        key,
        path: req.path,
        count: bucket.count,
        limit,
      });

      return res.status(429).json({
        ok: false,
        error: message || `Vas muy rápido. Esperá ${retryAfter} segundos y reintentá.`,
        code: 'rate_limited',
        retryAfter,
        limit,
        windowMs,
      });
    }

    return next();
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · FACTORY
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Crea el middleware de rate limiting.
 *
 * @param {object} [options]
 * @param {number} [options.windowMs]  Ventana en ms (default 60 000)
 * @param {number} [options.limit]     Requests por ventana (default 60)
 * @param {string[]} [options.skipPaths]
 * @param {function} [options.keyGenerator]
 * @param {boolean} [options.useLibrary] Fuerza el limitador propio
 * @returns {function} middleware Express
 */
export function createRateLimiter(options = {}) {
  const opts = {
    ...DEFAULTS,
    ...options,
    skipPaths: options.skipPaths || DEFAULTS.skipPaths,
  };

  const handler = (req, res) => {
    if (opts.skipPaths.includes(req.path)) return;

    const retryAfter = Number(res.getHeader('Retry-After')) ||
      Math.max(1, Math.ceil(Number(res.getHeader('RateLimit-Reset')) * 1000 - Date.now()) / 1000);

    res.status(429).json({
      ok: false,
      error: opts.message || `Vas muy rápido. Esperá ${Math.ceil(retryAfter)} segundos y reintentá.`,
      code: 'rate_limited',
      retryAfter: Math.ceil(retryAfter),
      limit: opts.limit,
      windowMs: opts.windowMs,
    });
  };

  // `useLibrary: false` fuerza el limitador propio (determinista, sin
  // dependencias). Por defecto se usa express-rate-limit si está
  // instalado.
  const useLibrary = options.useLibrary === undefined
    ? Boolean(expressRateLimit)
    : Boolean(options.useLibrary);

  if (expressRateLimit && useLibrary) {
    try {
      return expressRateLimit({
        windowMs: opts.windowMs,
        limit: opts.limit,
        standardHeaders: opts.standardHeaders,
        legacyHeaders: opts.legacyHeaders,
        skipSuccessfulRequests: opts.skipSuccessfulRequests,
        keyGenerator: opts.keyGenerator || undefined,
        skip: (req) => opts.skipPaths.includes(req.path),
        handler,
      });
    } catch (e) {
      LOG.warn('rate-limiter: no se pudo crear el limitador de la librería, se usa el propio', {
        error: e.message,
      });
    }
  }

  return fallbackLimiter(opts);
}

/**
 * Limitador por defecto: 60 requests/minuto por IP.
 * @type {function}
 */
export const rateLimiter = createRateLimiter();

/**
 * Variante estricta para endpoints sensibles (pagos, auth): 10/min.
 */
export const strictRateLimiter = createRateLimiter({
  limit: 10,
  windowMs: 60_000,
  skipPaths: [],
  message: 'Demasiados intentos. Esperá un minuto antes de reintentar.',
});

/**
 * Variante para endpoints de IA (más caros): 20/min.
 */
export const aiRateLimiter = createRateLimiter({
  limit: 20,
  windowMs: 60_000,
  skipPaths: [],
  message: 'Estás consumiendo el motor demasiado rápido. Probá en un momento.',
});

/**
 * Estado del limitador (para el panel de admin).
 */
export function getRateLimiterStats() {
  return {
    engine: expressRateLimit ? 'express-rate-limit' : 'builtin',
    defaults: {
      windowMs: DEFAULTS.windowMs,
      limit: DEFAULTS.limit,
    },
    trackedKeys: buckets.size,
  };
}

/**
 * Limpia los buckets (tests).
 */
export function resetRateLimiter() {
  buckets.clear();
}

export default {
  createRateLimiter,
  rateLimiter,
  strictRateLimiter,
  aiRateLimiter,
  getRateLimiterStats,
  resetRateLimiter,
  DEFAULTS,
};
