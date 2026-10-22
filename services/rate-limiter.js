/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/rate-limiter.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Limitador de peticiones en memoria: 60 req/min por IP.

   POR QUÉ EN MEMORIA
     Es la primera línea de defensa (lo más barato de aplicar) y
     cubre el abuso trivial. Las cuotas de negocio (créditos, planes)
     viven en la base de datos; aquí sólo se corta el volumen bruto.

   ALGORITMO
     Ventana deslizante: se guardan los timestamps de las peticiones
     recientes por IP y se descartan los que ya han salido de la
     ventana de 60 s. Con 60 marcas de tiempo la memoria es ridícula.

   NOTA
     En despliegues multi-instancia cada proceso lleva su propio
     contador. Para un límite global hay que subir esto a Redis.

   CONTRATO
     rateLimit(ip) → { allowed, limit, remaining, resetAt, retryAfter, count }
     checkRateLimit(req, res, next) → middleware de Express
   ═══════════════════════════════════════════════════════════════════════ */

import { LOG } from '../src/lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  limit: 60,              // peticiones por ventana
  windowMs: 60_000,       // 1 minuto
  maxTrackedIps: 20_000,  // cota de IPs en memoria (evita fuga)
  cleanupMs: 60_000,      // barrido de IPs inactivas
});

/** ip → { hits: number[], blockedUntil: number } */
const store = new Map();

/* ═══════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Normaliza la clave de un cliente (IP o identificador alternativo).
 * @param {string|object} input
 * @returns {string}
 */
export function resolveKey(input) {
  if (!input) return 'unknown';

  if (typeof input === 'string') return input.trim().slice(0, 64) || 'unknown';

  try {
    const forwarded = input.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) {
      return forwarded.split(',')[0].trim().slice(0, 64);
    }
    const ip = input.ip || input.socket?.remoteAddress || input.connection?.remoteAddress;
    if (ip) return String(ip).slice(0, 64);
  } catch {
    /* se cae al identificador genérico */
  }

  return 'unknown';
}

/**
 * Vacía las marcas de tiempo que ya han salido de la ventana.
 * @param {{hits:number[]}} entry
 * @param {number} now
 * @returns {number[]}
 */
function prune(entry, now) {
  const cutoff = now - CFG.windowMs;
  let index = 0;
  while (index < entry.hits.length && entry.hits[index] <= cutoff) index += 1;
  if (index > 0) entry.hits.splice(0, index);
  return entry.hits;
}

/* ═══════════════════════════════════════════════════════════════════════
   03 · API
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Comprueba y consume una unidad del cuota de una IP.
 *
 * @param {string} ip
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {number} [options.windowMs]
 * @returns {{allowed:boolean, limit:number, remaining:number, count:number,
 *            resetAt:number, retryAfter:number}}
 */
export function rateLimit(ip, options = {}) {
  const limit = Number.isFinite(options.limit) ? options.limit : CFG.limit;
  const windowMs = Number.isFinite(options.windowMs) ? options.windowMs : CFG.windowMs;
  const key = resolveKey(ip);
  const now = Date.now();

  let entry = store.get(key);
  if (!entry) {
    if (store.size >= CFG.maxTrackedIps) sweep();
    entry = { hits: [], blockedUntil: 0 };
    store.set(key, entry);
  }

  const hits = prune(entry, now);

  // Bloqueo temporal heredado de una respuesta anterior.
  if (entry.blockedUntil > now) {
    return {
      allowed: false,
      limit,
      remaining: 0,
      count: hits.length,
      resetAt: entry.blockedUntil,
      retryAfter: Math.ceil((entry.blockedUntil - now) / 1000),
    };
  }

  if (hits.length >= limit) {
    const oldest = hits[0];
    const resetAt = oldest + windowMs;
    entry.blockedUntil = resetAt;

    return {
      allowed: false,
      limit,
      remaining: 0,
      count: hits.length,
      resetAt,
      retryAfter: Math.max(1, Math.ceil((resetAt - now) / 1000)),
    };
  }

  hits.push(now);

  return {
    allowed: true,
    limit,
    remaining: Math.max(0, limit - hits.length),
    count: hits.length,
    resetAt: (hits[0] || now) + windowMs,
    retryAfter: 0,
  };
}

/**
 * Middleware de Express: aplica el límite y responde 429 si se agota.
 * @param {object} req
 * @param {object} res
 * @param {Function} next
 */
export function checkRateLimit(req, res, next) {
  try {
    const key = resolveKey(req);
    const result = rateLimit(key);

    if (res?.setHeader) {
      res.setHeader('X-RateLimit-Limit', String(result.limit));
      res.setHeader('X-RateLimit-Remaining', String(result.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
    }

    if (!result.allowed) {
      if (res?.setHeader) res.setHeader('Retry-After', String(result.retryAfter));
      LOG.warn('rate-limiter: cuota agotada', { key, limit: result.limit });
      res?.status?.(429)?.json?.({
        error: 'rate_limit_exceeded',
        message: 'Demasiadas peticiones. Inténtalo de nuevo en unos segundos.',
        retryAfter: result.retryAfter,
      });
      return;
    }

    next();
  } catch (e) {
    LOG.warn('rate-limiter: error en el middleware', { error: e.message });
    next();
  }
}

/**
 * Libera la cuota de una IP.
 * @param {string} ip
 * @returns {boolean}
 */
export function resetRateLimit(ip) {
  return store.delete(resolveKey(ip));
}

/** Vacía todo el store. */
export function clearRateLimits() {
  store.clear();
}

/**
 * Estadísticas del limitador.
 * @returns {{trackedIps:number, limit:number, windowMs:number}}
 */
export function getRateLimiterStats() {
  return {
    trackedIps: store.size,
    limit: CFG.limit,
    windowMs: CFG.windowMs,
  };
}

/**
 * Estado de una IP concreta (para debug).
 * @param {string} ip
 * @returns {{count:number, blockedUntil:number}}
 */
export function inspect(ip) {
  const entry = store.get(resolveKey(ip));
  if (!entry) return { count: 0, blockedUntil: 0 };
  prune(entry, Date.now());
  return { count: entry.hits.length, blockedUntil: entry.blockedUntil };
}

/* ═══════════════════════════════════════════════════════════════════════
   04 · BARRIDO
   ═══════════════════════════════════════════════════════════════════════ */

function sweep() {
  const now = Date.now();
  for (const [key, entry] of store.entries()) {
    prune(entry, now);
    if (!entry.hits.length && entry.blockedUntil <= now) {
      store.delete(key);
    }
  }
}

const timer = setInterval(sweep, CFG.cleanupMs);
if (typeof timer.unref === 'function') timer.unref();

export default {
  rateLimit,
  checkRateLimit,
  resetRateLimit,
  clearRateLimits,
  getRateLimiterStats,
  inspect,
  resolveKey,
};
