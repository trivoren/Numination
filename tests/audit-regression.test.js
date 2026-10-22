/* ═══════════════════════════════════════════════════════════════════
   NUMINATION · tests/audit-regression.test.js
   ───────────────────────────────────────────────────────────────────────────
   Tests de regresión de los fixes de verga.md (ver CHANGELOG-AUDIT.md).

   Dos grupos:
     1) Unitarios puros (sin server): errorMiddleware/stack gating,
        sanitizeForClient, stripTags, límite anon.
     2) Integración HTTP contra un server vivo (BASE_URL, default
        http://localhost:8080). Requieren DB (usan signup/login reales
        con emails únicos por run y borran al usuario al final).

   Correr con el server levantado:
      $env:IP_GUARD='false'; node src/index.js &
      node --test tests/
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  errorMiddleware,
  sanitizeForClient,
} from '../src/middleware/errors.js';
import { stripTags } from '../src/chats.js';
import { verificarLimite } from '../src/services/limits.js';

const BASE = process.env.AUDIT_BASE_URL || 'http://localhost:8080';

/* ─── Helpers HTTP ─── */

async function req(method, path, { body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `nm-session=${cookie}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* HTML u otro */ }
  return { status: res.status, json, headers: res.headers };
}

/* ═══════════════════════════════════════════════════════════════════
   1 · UNITARIOS (sin server)
   ═══════════════════════════════════════════════════════════════════ */

describe('audit · unitarios', () => {
  it('M-004 · errorMiddleware: sin stack si includeStack=false', () => {
    const mw = errorMiddleware({ includeStack: false });
    let out = null;
    const req = { id: 't1', path: '/x', socket: { remoteAddress: '127.0.0.1' } };
    const res = {
      headersSent: false,
      status(c) { this.code = c; return this; },
      json(b) { out = b; },
    };
    mw(new Error('boom-test-stack'), req, res, () => {});
    assert.equal(res.code, 500);
    assert.ok(!('stack' in out), 'no debe incluir stack');
  });

  it('M-004 · errorMiddleware: peer remoto NO recibe stack aunque includeStack=true', () => {
    const mw = errorMiddleware({ includeStack: true, includeStackForLocalOnly: true });
    let out = null;
    const req = { id: 't2', path: '/x', socket: { remoteAddress: '203.0.113.9' } };
    const res = {
      headersSent: false,
      status(c) { this.code = c; return this; },
      json(b) { out = b; },
    };
    mw(new SyntaxError('bad json remote'), req, res, () => {});
    assert.ok(!('stack' in out), 'peer remoto no debe ver stack');
    assert.ok(out.requestId, 'igual trae requestId');
  });

  it('M-004 · errorMiddleware: peer loopback SÍ recibe stack (debug local)', () => {
    const mw = errorMiddleware({ includeStack: true, includeStackForLocalOnly: true });
    let out = null;
    const req = { id: 't3', path: '/x', socket: { remoteAddress: '127.0.0.1' } };
    const res = {
      headersSent: false,
      status(c) { this.code = c; return this; },
      json(b) { out = b; },
    };
    mw(new SyntaxError('bad json local'), req, res, () => {});
    assert.ok(typeof out.stack === 'string', 'loopback conserva stack en dev');
  });

  it('M-004 · sanitizeForClient redacta paths Windows con slashes', () => {
    const red = sanitizeForClient('at file:///C:/Users/ALGUIEN/app/x.js:1:2');
    assert.ok(!red.includes('ALGUIEN'), `filtra usuario: ${red}`);
  });

  it('L-003 · stripTags quita etiquetas y deja texto', () => {
    assert.equal(stripTags('<img src=x onerror=alert(1)>'), '');
    assert.equal(stripTags('Hola <b>mundo</b>'), 'Hola mundo');
    assert.equal(stripTags('Q&A normal'), 'Q&A normal');
    assert.equal(stripTags(null), '');
  });

  it('M-006 · anon tiene porMin=1 por defecto', async () => {
    const s = await verificarLimite({}, { dryRun: true });
    assert.equal(s.limites.porMin, 1);
    assert.equal(s.limites.porMinuto, 1);
  });
});

/* ═══════════════════════════════════════════════════════════════════
   2 · INTEGRACIÓN (server vivo en BASE_URL)
   ═══════════════════════════════════════════════════════════════════ */

const T = {
  email: `audit-reg-${Date.now()}@test.com`,
  password: 'Test1234Abc',
  cookie: null,
};

// Extrae nm-session del header set-cookie usando fetch crudo (undici
// expone getSetCookie en Node 20+).
async function signupAndGetCookie() {
  const res = await fetch(BASE + '/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: T.email, password: T.password, name: 'AuditReg' }),
  });
  const json = await res.json().catch(() => null);
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [];
  const m = setCookies.join(';').match(/nm-session=([^;]+)/);
  return { status: res.status, json, cookie: m ? m[1] : null };
}

/**
 * ¿Hay un server escuchando? La suite de integración HTTP se OMITE (no
 * falla) si no lo hay: en CI no siempre hay servidor, y un test que
 * exige infraestructura externa no debe romper el pipeline.
 * Con el server arriba (IP_GUARD=false node src/index.js) se ejecuta.
 */
async function serverIsUp() {
  try {
    const r = await fetch(BASE + '/api/ping', { signal: AbortSignal.timeout(5000) });
    return r.status === 200;
  } catch {
    return false;
  }
}

const SERVER_UP = await serverIsUp();

if (!SERVER_UP) {
  console.log(
    `\n  ⚠️  Integración HTTP omitida: no hay server en ${BASE}.\n` +
    '     Para ejecutarla: IP_GUARD=false node src/index.js\n'
  );
}

describe(
  'audit · integración HTTP',
  { skip: SERVER_UP ? false : `requiere un server en ${BASE}` },
  () => {

  after(async () => {
    // Limpieza best-effort: login fresco + borrado de cuenta.
    try {
      const l = await req('POST', '/api/auth/login', {
        body: { email: T.email, password: T.password },
      });
      const cookies = l.headers.getSetCookie ? l.headers.getSetCookie() : [];
      const m = cookies.join(';').match(/nm-session=([^;]+)/);
      if (m) {
        await req('DELETE', '/api/auth/account', {
          body: { confirm: 'ELIMINAR' },
          cookie: m[1],
        });
      }
    } catch { /* best-effort: no falla el suite */ }
  });

  it('M-002 · signup nace sin email verificado', async () => {
    const { status, json, cookie } = await signupAndGetCookie();
    assert.equal(status, 201);
    assert.ok(cookie, 'debe setear cookie de sesión');
    T.cookie = cookie;
    assert.equal(json.user.emailVerified, false);

    const me = await req('GET', '/api/auth/me', { cookie });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.emailVerified, false);
  });

  it('M-001 · query-token válido sin cookie → 401', async () => {
    assert.ok(T.cookie, 'requiere el signup previo');
    const r = await req('GET', `/api/chats?token=${encodeURIComponent(T.cookie)}`);
    assert.equal(r.status, 401);
  });

  it('L-005 · signup duplicado no nombra proveedor', async () => {
    const r = await req('POST', '/api/auth/signup', {
      body: { email: T.email, password: T.password },
    });
    assert.equal(r.status, 409);
    assert.ok(!/google|github/i.test(r.json.error), `mensaje filtra proveedor: ${r.json.error}`);
  });

  it('HIGH-002 · verify-email con token falso → 400', async () => {
    const r = await req('POST', '/api/auth/verify-email/confirm', {
      body: { token: 'token-falso-de-regresion' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'invalid_token');
  });

  it('M-003 · CSP presente', async () => {
    const res = await fetch(BASE + '/login');
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp && csp.includes("default-src 'self'"), 'falta CSP');
    assert.ok(csp.includes("object-src 'none'"), 'CSP incompleta');
  });

  it('L-001 · health público mínimo', async () => {
    const r = await req('GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.ok(r.json.version, 'trae version');
    for (const f of ['keys', 'models', 'engines', 'subsystems', 'features']) {
      assert.ok(!(f in r.json), `health público expone "${f}"`);
    }
  });

  it('M-004 · JSON malformado → 400 con requestId', async () => {
    const res = await fetch(BASE + '/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":}',
    });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.ok(json.requestId, 'trae requestId');
  });

  it('HIGH-001 · logout revoca: cookie vieja rechazada', async () => {
    assert.ok(T.cookie, 'requiere el signup previo');
    const pre = await req('GET', '/api/auth/session', { cookie: T.cookie });
    assert.equal(pre.json.authenticated, true);

    const lo = await req('POST', '/api/auth/logout', { cookie: T.cookie });
    assert.equal(lo.json.ok, true);

    const post = await req('GET', '/api/auth/session', { cookie: T.cookie });
    assert.equal(post.json.authenticated, false);
    assert.equal(post.json.revoked, true);

    const chats = await req('GET', '/api/chats', { cookie: T.cookie });
    assert.equal(chats.status, 401);
  });
  }
);
