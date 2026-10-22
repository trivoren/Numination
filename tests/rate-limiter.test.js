/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/rate-limiter.test.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pruebas del limitador de peticiones (60 por minuto y por IP).

   CASO EXIGIDO
     · 61 peticiones seguidas desde la misma IP → la 61ª devuelve 429.
     · La respuesta incluye el header `Retry-After`.

   Y ADEMÁS
     · Las 60 primeras pasan.
     · Otra IP no se ve afectada (el límite es por IP, no global).
     · Las rutas exentas (/api/health) no cuentan.
     · El límite se puede construir con otros valores.
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { mockReqRes, flush } from './setup.js';
import {
  createRateLimiter,
  resetRateLimiter,
  getRateLimiterStats,
  DEFAULTS,
} from '../src/middleware/rate-limiter.js';

/**
 * Dispara N peticiones del limitador y devuelve el estado de cada una.
 *
 * @param {Function} limiter
 * @param {number} count
 * @param {string} ip
 * @returns {Promise<Array<{status:number|null, retryAfter:string|undefined, body:object|null}>>}
 */
async function fire(limiter, count, ip = '203.0.113.10') {
  const results = [];

  for (let i = 0; i < count; i++) {
    const { req, res, next, calls } = mockReqRes({
      path: '/api/chat',
      method: 'POST',
      ip,
      headers: { 'x-forwarded-for': ip },
    });

    limiter(req, res, next);
    await flush();

    results.push({
      status: calls.status,
      retryAfter: calls.headers['retry-after'],
      body: calls.json,
      nextCalled: calls.nextCalled === true,
    });
  }

  return results;
}

/* ═══════════════════════════════════════════════════════════════════════════
   1 · EL LÍMITE DE 60/MIN
   ═══════════════════════════════════════════════════════════════════════════ */

describe('rate-limiter · 60 peticiones por minuto', () => {
  let limiter;

  beforeEach(() => {
    resetRateLimiter();
    limiter = createRateLimiter({ useLibrary: false, limit: 60, windowMs: 60_000 });
  });

  afterEach(() => {
    resetRateLimiter();
  });

  it('deja pasar las primeras 60 peticiones', async () => {
    const results = await fire(limiter, 60);

    const blocked = results.filter((r) => r.status === 429);

    assert.equal(blocked.length, 0, 'ninguna de las 60 debe ser bloqueada');
    assert.equal(results[0].nextCalled, true);
    assert.equal(results[59].nextCalled, true);
  });

  it('bloquea la petición 61 con 429 y Retry-After', async () => {
    const results = await fire(limiter, 61);

    const last = results[60];

    assert.equal(last.status, 429, 'la 61ª petición debe recibir 429');
    assert.ok(last.retryAfter, 'debe incluir el header Retry-After');
    assert.ok(Number(last.retryAfter) > 0, 'Retry-After debe ser un número positivo');
    assert.ok(Number(last.retryAfter) <= 60, 'Retry-After no puede superar la ventana');
  });

  it('devuelve un JSON descriptivo con el código rate_limited', async () => {
    const ip = '203.0.113.11';
    await fire(limiter, 61, ip);

    const { req, res, next, calls } = mockReqRes({ path: '/api/chat', ip });
    limiter(req, res, next);
    await flush();

    assert.equal(calls.status, 429);
    assert.equal(calls.json.ok, false);
    assert.equal(calls.json.code, 'rate_limited');
    assert.equal(calls.json.limit, 60);
    assert.equal(calls.json.windowMs, 60_000);
    assert.ok(calls.json.retryAfter > 0);
    assert.match(calls.json.error, /rápido|espera/i);
  });

  it('mantiene el límite con las cabeceras X-RateLimit-*', async () => {
    const { req, res, next, calls } = mockReqRes({ path: '/api/chat', ip: '203.0.113.12' });

    limiter(req, res, next);
    await flush();

    assert.equal(calls.headers['ratelimit-limit'], '60');
    assert.equal(calls.headers['ratelimit-remaining'], '59');
  });

  it('bloquea todas las peticiones siguientes dentro de la ventana', async () => {
    const ip = '203.0.113.13';
    await fire(limiter, 61, ip);
    const extra = await fire(limiter, 3, ip);

    assert.equal(extra.length, 3);
    assert.ok(extra.every((r) => r.status === 429), 'misma IP: siguen bloqueadas');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2 · AISLAMIENTO POR IP
   ═══════════════════════════════════════════════════════════════════════════ */

describe('rate-limiter · por IP', () => {
  let limiter;

  beforeEach(() => {
    resetRateLimiter();
    limiter = createRateLimiter({ useLibrary: false, limit: 60, windowMs: 60_000 });
  });

  afterEach(() => {
    resetRateLimiter();
  });

  it('una IP distinta noAgota el límite de otra', async () => {
    await fire(limiter, 61, '198.51.100.1');

    const otra = await fire(limiter, 5, '198.51.100.2');

    assert.ok(otra.every((r) => r.status === null), 'la segunda IP debe pasar');
    assert.ok(otra.every((r) => r.nextCalled));
  });

  it('cuenta las peticiones por IP, no por usuario', async () => {
    const a = await fire(limiter, 30, '198.51.100.3');
    const b = await fire(limiter, 30, '198.51.100.3');

    assert.equal(a.filter((r) => r.status === 429).length, 0);
    assert.equal(b.filter((r) => r.status === 429).length, 0);
    assert.equal(b.length, 30);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3 · EXENCIONES Y CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

describe('rate-limiter · exenciones y configuración', () => {
  let limiter;

  beforeEach(() => {
    resetRateLimiter();
    limiter = createRateLimiter({ useLibrary: false, limit: 60, windowMs: 60_000 });
  });

  afterEach(() => {
    resetRateLimiter();
  });

  it('no cuenta las rutas exentas (/api/health)', async () => {
    for (let i = 0; i < 80; i++) {
      const { req, res, next, calls } = mockReqRes({ path: '/api/health', ip: '198.51.100.9' });
      limiter(req, res, next);
      await flush();
      assert.equal(calls.status, null);
    }
  });

  it('respeta un límite y una ventana distintos', async () => {
    resetRateLimiter();
    const estricto = createRateLimiter({ useLibrary: false, limit: 3, windowMs: 1000 });

    const results = await fire(estricto, 4, '198.51.100.10');

    assert.equal(results[0].status, null);
    assert.equal(results[2].status, null);
    assert.equal(results[3].status, 429);

    resetRateLimiter();
  });

  it('expone los valores por defecto y las métricas', () => {
    assert.equal(DEFAULTS.limit, 60);
    assert.equal(DEFAULTS.windowMs, 60_000);

    const stats = getRateLimiterStats();

    assert.ok(stats);
    assert.equal(typeof stats.engine, 'string');
    assert.ok(stats.defaults.limit >= 1);
  });
});
