/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/auth.test.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pruebas del middleware de autenticación (`requireAuth` / `requireAdmin`).

   CONTRATO QUE SE VERIFICA
     · Sin token            → 401 AUTH_NO_TOKEN
     · Token inválido       → 401 AUTH_INVALID_TOKEN (un token no
       verificable NO es un token: rechazarlo con 403 "no autorizado"
       sería engañoso, porque el problema es la autenticación, no la
       autorización. El 403 se reserva para "autenticado pero sin
       permisos", y eso se prueba con requireAdmin).
     · Token válido         → next() + req.user con id, email y role.
     · Token expirado       → 401.
     · Token de otro        → se rechaza si la firma no verifica.

   El token se firma con el MISMO secreto que usa el middleware
   (SESSION_SECRETS se construye al importar el módulo), por eso
   `tests/setup.js` fija JWT_SECRET antes de que se importe auth.js.
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  mockReqRes,
  signTestToken,
  flush,
  TEST_USER_ID,
} from './setup.js';

/* El import es dinámico: el módulo de auth lee los secretos al cargarse
   y setup.js ya los fijó antes (orden de evaluación de ESM). */
let requireAuth;
let requireAdmin;

before(async () => {
  ({ requireAuth, requireAdmin } = await import('../src/middleware/auth.js'));
});

/**
 * Ejecuta un middleware contra un par req/res simulado.
 * @returns {Promise<{calls:object, req:object}>}
 */
async function run(middleware, options = {}) {
  const { req, res, next, calls } = mockReqRes(options);
  await middleware(req, res, next);
  // Express no espera a los middlewares: hay que drenar el event loop
  // para que attachUser termine su trabajo asincrono.
  await flush();
  return { calls, req, res };
}

/* ═══════════════════════════════════════════════════════════════════════════
   1 · SIN TOKEN
   ═══════════════════════════════════════════════════════════════════════════ */

describe('auth · requireAuth sin token', () => {
  let restoreFetch = null;

  beforeEach(() => {
    restoreFetch = null;
  });

  afterEach(() => {
    if (restoreFetch) restoreFetch();
  });

  it('devuelve 401 cuando no hay cookie ni header Authorization', async () => {
    const { calls } = await run(requireAuth, { path: '/api/chat' });

    assert.equal(calls.status, 401);
    assert.equal(calls.json.ok, false);
    assert.equal(calls.json.code, 'AUTH_NO_TOKEN');
    assert.equal(calls.nextCalled, undefined, 'no debe llamar a next()');
  });

  it('devuelve 401 cuando el token viene vacío', async () => {
    const { calls } = await run(requireAuth, {
      path: '/api/chat',
      headers: { authorization: 'Bearer ' },
    });

    assert.equal(calls.status, 401);
    assert.equal(calls.json.code, 'AUTH_NO_TOKEN');
  });

  it('devuelve 401 cuando el header no tiene el prefijo Bearer', async () => {
    const { calls } = await run(requireAuth, {
      path: '/api/chat',
      headers: { authorization: 'token-crudo-sin-bearer' },
    });

    assert.equal(calls.status, 401);
    assert.ok(['AUTH_NO_TOKEN', 'AUTH_INVALID_TOKEN'].includes(calls.json.code));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2 · TOKEN INVÁLIDO
   ═══════════════════════════════════════════════════════════════════════════ */

describe('auth · token inválido', () => {
  it('rechaza un token con firma inválida (401, no 403)', async () => {
    const { calls } = await run(requireAuth, {
      path: '/api/chat',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.firma-falsa' },
    });

    assert.equal(calls.status, 401);
    assert.equal(calls.json.code, 'AUTH_INVALID_TOKEN');
    assert.equal(calls.nextCalled, undefined);
  });

  it('rechaza un token firmado con otro secreto', async () => {
    const token = await signTestToken({ sub: TEST_USER_ID }, { secret: 'secreto-del-atacante-1234567890' });

    const { calls } = await run(requireAuth, {
      path: '/api/chat',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(calls.status, 401);
    assert.equal(calls.json.code, 'AUTH_INVALID_TOKEN');
  });

  it('rechaza un token expirado', async () => {
    // -5m: el middleware acepta 60 s de desfase de reloj (clockTolerance),
    // así que un token expirado hace un minuto todavía sería válido.
    const token = await signTestToken({ sub: TEST_USER_ID }, { expiresIn: '-5m' });

    const { calls } = await run(requireAuth, {
      path: '/api/chat',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(calls.status, 401);
    assert.equal(calls.json.code, 'AUTH_EXPIRED_TOKEN');
  });

  it('no filtra el stack trace ni el token en la respuesta', async () => {
    const { calls } = await run(requireAuth, {
      path: '/api/chat',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.firma' },
    });

    assert.equal(calls.status, 401);
    assert.equal(calls.json.stack, undefined);
    assert.equal(calls.json.error.includes('eyJ'), false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3 · TOKEN VÁLIDO
   ═══════════════════════════════════════════════════════════════════════════ */

describe('auth · token válido', () => {
  it('llama a next() y adjunta req.user con id, email y role', async () => {
    const token = await signTestToken({
      sub: TEST_USER_ID,
      email: 'ada@numination.app',
      role: 'teacher',
    });

    const { calls, req } = await run(requireAuth, {
      path: '/api/chat',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(calls.nextCalled, true);
    assert.equal(calls.nextError, null);
    assert.equal(calls.status, null, 'no debe responder si la auth pasa');
    assert.ok(req.user, 'req.user debe existir');
    assert.equal(req.user.id, TEST_USER_ID);
    assert.equal(req.user.email, 'ada@numination.app');
    assert.equal(req.user.role, 'teacher');
    assert.equal(req.userId, TEST_USER_ID);
  });

  it('acepta el token por cookie de sesión (nm-session)', async () => {
    const token = await signTestToken({ sub: TEST_USER_ID });

    const { calls, req } = await run(requireAuth, {
      path: '/api/chat',
      cookies: { 'nm-session': token },
    });

    assert.equal(calls.nextCalled, true);
    assert.equal(req.user.id, TEST_USER_ID);
  });

  it('acepta el token por header x-nm-token', async () => {
    const token = await signTestToken({ sub: TEST_USER_ID });

    const { calls } = await run(requireAuth, {
      path: '/api/chat',
      headers: { 'x-nm-token': token },
    });

    assert.equal(calls.nextCalled, true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4 · AUTORIZACIÓN (403)
   ═══════════════════════════════════════════════════════════════════════════ */

describe('auth · requireAdmin (403)', () => {
  it('devuelve 403 cuando el usuario autenticado no es admin', async () => {
    const token = await signTestToken({ sub: TEST_USER_ID, role: 'student' });

    const { calls } = await run(requireAdmin, {
      path: '/api/admin/stats',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(calls.status, 403);
    assert.equal(calls.json.code, 'AUTH_ROLE_INSUFFICIENT');
    assert.equal(calls.nextCalled, undefined);
  });

  it('devuelve 401 (no 403) cuando no hay sesión: la auth precede a la authz', async () => {
    const { calls } = await run(requireAdmin, { path: '/api/admin/stats' });

    assert.equal(calls.status, 401);
    assert.equal(calls.json.code, 'AUTH_NO_TOKEN');
  });

  it('deja pasar a un admin autenticado', async () => {
    const token = await signTestToken({ sub: TEST_USER_ID, role: 'admin' });

    const { calls, req } = await run(requireAdmin, {
      path: '/api/admin/stats',
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(calls.nextCalled, true);
    assert.equal(req.user.role, 'admin');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5 · AISLAM ENTRE USUARIOS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('auth · aislamiento entre usuarios', () => {
  it('el token del usuario A no autentica como el usuario B', async () => {
    const tokenA = await signTestToken({ sub: TEST_USER_ID, email: 'a@numination.app' });

    const { req } = await run(requireAuth, {
      path: '/api/chat',
      headers: { authorization: `Bearer ${tokenA}` },
    });

    assert.equal(req.user.id, TEST_USER_ID);
    assert.notEqual(req.user.id, '22222222-2222-4222-8222-222222222222');
  });

  it('el rol del JWT no puede escalarse a admin por el body', async () => {
    const token = await signTestToken({ sub: TEST_USER_ID, role: 'student' });

    const { req } = await run(requireAuth, {
      path: '/api/chat',
      body: { role: 'admin', email: 'root@numination.app' },
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(req.user.role, 'student');
  });
});

after(() => {
  // Nada que limpiar: el módulo de auth no abre conexiones.
});
