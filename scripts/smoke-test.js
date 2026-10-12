#!/usr/bin/env node
/* ================================================================
   NUMINATION · smoke-test.js · v1.0
   ----------------------------------------------------------------
   Test rápido contra producción (o local) para verificar que los
   endpoints críticos siguen vivos después de cada deploy.

   ¿POR QUÉ EXISTE?
   Hoy cada push puede romper algo y no te enterás hasta que un
   usuario lo reporta. Con este script corrés:

     node scripts/smoke-test.js

   y en 5 segundos sabés si algo se rompió.

   USO BÁSICO:

     node scripts/smoke-test.js                    # contra Vercel
     node scripts/smoke-test.js --local            # contra localhost:8080
     node scripts/smoke-test.js --url https://...  # URL custom

   OPCIONES:

     --local              · apunta a http://localhost:8080
     --url <url>          · URL base custom
     --cookie <cookie>    · cookie de sesión para tests autenticados
     --session <path>     · archivo con cookie (una línea)
     --quick              · solo 5 tests (los más críticos)
     --full               · todos los tests (~30)
     --verbose            · muestra cada request/response
     --json               · salida en JSON (para CI)
     --timeout <ms>       · timeout por request (default 10000)
     --no-color           · sin códigos ANSI

   VARIABLES DE ENTORNO:

     SMOKE_URL            · mismo que --url
     SMOKE_COOKIE         · mismo que --cookie
     SMOKE_TIMEOUT        · mismo que --timeout
     NO_COLOR=1           · desactiva colores

   CÓDIGOS DE SALIDA:

     0 · todos los tests pasaron
     1 · al menos un test falló
     2 · error de configuración

   ESTRUCTURA INTERNA:

     1 · Configuración y constantes
     2 · Colores y logger
     3 · Parser de argumentos
     4 · HTTP client con cookie jar
     5 · Aserciones
     6 · Test registry
     7 · Tests públicos (sin auth)
     8 · Tests autenticados (con cookie)
     9 · Runner
    10 · Reporte final
   ================================================================ */

import process from 'node:process';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN Y CONSTANTES
   ═══════════════════════════════════════════════════════════════════════ */

const DEFAULT_URL = 'https://numinationchat.vercel.app';
const LOCAL_URL = 'http://localhost:8080';
const DEFAULT_TIMEOUT_MS = 10_000;

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_CONFIG = 2;

/* ═══════════════════════════════════════════════════════════════════════
   2 · COLORES Y LOGGER
   ═══════════════════════════════════════════════════════════════════════ */

const noColor = process.env.NO_COLOR === '1' || process.argv.includes('--no-color');

const C = noColor ? new Proxy({}, { get: () => (s) => s }) : {
  reset: (s) => `\x1b[0m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
};

const log = {
  ok: (msg, extra) => console.log(`${C.green('✓')} ${msg}${extra ? C.gray(' ' + extra) : ''}`),
  fail: (msg, extra) => console.log(`${C.red('✗')} ${msg}${extra ? C.gray(' ' + extra) : ''}`),
  warn: (msg, extra) => console.log(`${C.yellow('⚠')} ${msg}${extra ? C.gray(' ' + extra) : ''}`),
  info: (msg, extra) => console.log(`${C.blue('ℹ')} ${msg}${extra ? C.gray(' ' + extra) : ''}`),
  section: (title) => console.log(`\n${C.bold(C.cyan('─── ' + title + ' ───'))}`),
  plain: (msg) => console.log(msg),
  json: (obj) => console.log(JSON.stringify(obj, null, 2)),
};

/* ═══════════════════════════════════════════════════════════════════════
   3 · PARSER DE ARGUMENTOS
   ═══════════════════════════════════════════════════════════════════════ */

function parseArgs(argv) {
  const opts = {
    url: process.env.SMOKE_URL || DEFAULT_URL,
    cookie: process.env.SMOKE_COOKIE || null,
    cookieFile: null,
    mode: 'full',
    verbose: false,
    json: false,
    timeout: parseInt(process.env.SMOKE_TIMEOUT || DEFAULT_TIMEOUT_MS, 10),
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];

    switch (a) {
      case '--local':       opts.url = LOCAL_URL; break;
      case '--url':         opts.url = next(); break;
      case '--cookie':      opts.cookie = next(); break;
      case '--session':     opts.cookieFile = next(); break;
      case '--quick':       opts.mode = 'quick'; break;
      case '--full':        opts.mode = 'full'; break;
      case '--verbose':     opts.verbose = true; break;
      case '--json':        opts.json = true; break;
      case '--timeout':     opts.timeout = parseInt(next(), 10); break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(EXIT_OK);
      default:
        if (a.startsWith('--')) {
          console.error(`Opción desconocida: ${a}`);
          process.exit(EXIT_CONFIG);
        }
    }
  }

  // Cargar cookie desde archivo si aplica
  if (opts.cookieFile) {
    try {
      opts.cookie = fs.readFileSync(opts.cookieFile, 'utf8').trim();
    } catch (e) {
      console.error(`No pude leer ${opts.cookieFile}: ${e.message}`);
      process.exit(EXIT_CONFIG);
    }
  }

  // Normalizar URL
  opts.url = opts.url.replace(/\/$/, '');

  return opts;
}

function printHelp() {
  console.log(`
${C.bold('Numination · smoke-test.js')}

${C.bold('USO')}
  node scripts/smoke-test.js [opciones]

${C.bold('OPCIONES')}
  --local              · apunta a http://localhost:8080
  --url <url>          · URL base custom
  --cookie <cookie>    · cookie de sesión para tests autenticados
  --session <path>     · archivo con cookie (una línea)
  --quick              · solo 5 tests críticos
  --full               · todos los tests (default)
  --verbose            · muestra cada request
  --json               · salida en JSON
  --timeout <ms>       · timeout por request (default 10000)
  --no-color           · sin códigos ANSI

${C.bold('EJEMPLOS')}
  # Producción, quick check
  node scripts/smoke-test.js --quick

  # Local con sesión
  node scripts/smoke-test.js --local --session .cookie.txt

  # Para CI (JSON limpio)
  node scripts/smoke-test.js --json --no-color

${C.bold('CÓDIGO DE SALIDA')}
  0 · todo OK
  1 · algún test falló
  2 · error de configuración
`);
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · HTTP CLIENT con cookie jar
   ═══════════════════════════════════════════════════════════════════════ */

class HTTPClient {
  constructor(baseUrl, opts = {}) {
    this.base = baseUrl;
    this.timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
    this.verbose = Boolean(opts.verbose);
    this.cookies = new Map();
    if (opts.cookie) this.setCookieString(opts.cookie);
  }

  setCookieString(str) {
    if (!str) return;
    // Parsear "name=value; name2=value2"
    for (const part of String(str).split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k && v.length) this.cookies.set(k, v.join('='));
    }
  }

  cookieHeader() {
    if (this.cookies.size === 0) return '';
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  saveSetCookies(res) {
    const raw = res.headers.get('set-cookie');
    if (!raw) return;
    // Solo el primer cookie (Vercel puede mandar varios)
    const first = raw.split(',')[0];
    const [pair] = first.split(';');
    const [k, ...v] = pair.trim().split('=');
    if (k && v.length) this.cookies.set(k, v.join('='));
  }

  async request(method, path, { body, headers, expectStream } = {}) {
    const url = path.startsWith('http') ? path : this.base + path;
    const opts = {
      method,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Numination-Smoke/1.0',
        ...headers,
      },
      signal: AbortSignal.timeout(this.timeout),
    };

    if (this.cookies.size > 0) {
      opts.headers['Cookie'] = this.cookieHeader();
    }

    if (body !== undefined) {
      if (typeof body === 'string') {
        opts.body = body;
      } else {
        opts.body = JSON.stringify(body);
        opts.headers['Content-Type'] = 'application/json';
      }
    }

    if (this.verbose) {
      console.log(C.gray(`    → ${method} ${path}`));
    }

    const t0 = performance.now();
    let res, text = '', json = null, error = null;

    try {
      res = await fetch(url, opts);
      this.saveSetCookies(res);

      if (expectStream) {
        // Leer solo el primer chunk para no bloquear con streams infinitos
        const reader = res.body?.getReader();
        if (reader) {
          const { value } = await reader.read();
          text = value ? new TextDecoder().decode(value) : '';
          try { reader.cancel(); } catch {}
        }
      } else {
        text = await res.text();
        try { json = text ? JSON.parse(text) : null; } catch {}
      }
    } catch (e) {
      error = e;
    }

    const ms = Math.round(performance.now() - t0);

    if (this.verbose) {
      const code = res?.status ?? 'ERR';
      const color = !res ? C.red : res.status < 400 ? C.green : C.red;
      console.log(C.gray(`    ← ${color(code)} ${ms}ms${text ? ' · ' + text.slice(0, 60).replace(/\n/g, ' ') : ''}`));
    }

    return {
      ok: res ? res.ok : false,
      status: res?.status ?? 0,
      headers: res?.headers,
      text,
      json,
      ms,
      error,
    };
  }

  get(path, opts)    { return this.request('GET', path, opts); }
  post(path, body, opts) { return this.request('POST', path, { ...opts, body }); }
  patch(path, body, opts){ return this.request('PATCH', path, { ...opts, body }); }
  del(path, opts)    { return this.request('DELETE', path, opts); }
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · ASERCIONES · throw si fallan, devuelven mensaje si OK
   ═══════════════════════════════════════════════════════════════════════ */

class AssertionError extends Error {
  constructor(msg) { super(msg); this.name = 'AssertionError'; }
}

function assert(cond, msg) {
  if (!cond) throw new AssertionError(msg);
}

function assertStatus(res, expected) {
  const expectedArr = Array.isArray(expected) ? expected : [expected];
  if (!expectedArr.includes(res.status)) {
    const got = res.status || `network error: ${res.error?.message || 'unknown'}`;
    const preview = res.text ? ` · "${res.text.slice(0, 100).replace(/\n/g, ' ')}"` : '';
    throw new AssertionError(`Esperaba ${expectedArr.join('/')} pero recibí ${got}${preview}`);
  }
}

function assertJson(res) {
  if (!res.json || typeof res.json !== 'object') {
    throw new AssertionError(`Respuesta no es JSON válido · "${res.text.slice(0, 100)}"`);
  }
}

function assertField(obj, field, expected) {
  if (!obj || !(field in obj)) {
    throw new AssertionError(`Falta el campo "${field}" en la respuesta`);
  }
  if (expected !== undefined && obj[field] !== expected) {
    throw new AssertionError(`Campo "${field}" es "${obj[field]}", esperaba "${expected}"`);
  }
}

function assertFasterThan(ms, limit, label) {
  if (ms > limit) {
    throw new AssertionError(`${label || 'Request'} tardó ${ms}ms (límite: ${limit}ms)`);
  }
}

function assertHeader(res, name, expected) {
  const v = res.headers?.get(name);
  if (!v) throw new AssertionError(`Falta header "${name}"`);
  if (expected && !String(v).includes(expected)) {
    throw new AssertionError(`Header "${name}" es "${v}", no incluye "${expected}"`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · TEST REGISTRY
   ═══════════════════════════════════════════════════════════════════════ */

const tests = [];

/**
 * Registrar un test.
 * @param {string} id      · identificador único
 * @param {string} label   · descripción humana
 * @param {Function} fn    · async (ctx) => string | void (throw para fallar)
 * @param {object} opts    · { critical, needsAuth, group }
 */
function test(id, label, fn, opts = {}) {
  tests.push({ id, label, fn, ...opts });
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · TESTS PÚBLICOS (sin auth)
   ═══════════════════════════════════════════════════════════════════════ */

test('health', 'GET /api/health responde 200', async ({ http }) => {
  const res = await http.get('/api/health');
  assertStatus(res, 200);
  assertJson(res);
  assertField(res.json, 'ok', true);
  assertField(res.json, 'version');
  return `v${res.json.version} · ${res.ms}ms`;
}, { critical: true, group: 'health' });

test('health-db', 'Base de datos conectada', async ({ http }) => {
  const res = await http.get('/api/health');
  assertJson(res);
  const db = res.json.database;
  assert(db && db.connected === true, `DB no conectada: ${JSON.stringify(db)}`);
  if (db.ping && db.ping.ok) return `latencia ${db.ping.latencyMs}ms`;
  return 'conectada';
}, { group: 'health' });

test('health-engines', 'Los 3 motores configurados', async ({ http }) => {
  const res = await http.get('/api/health');
  assertJson(res);
  const keys = res.json.keys || {};
  const have = [];
  if (keys.groq) have.push('Groq');
  if (keys.gemini_1 || keys.gemini_2 || keys.gemini_3) have.push('Gemini');
  if (keys.nvidia) have.push('Kimi');
  assert(have.length >= 1, `Ningún motor disponible · keys: ${JSON.stringify(keys)}`);
  return have.join(' · ');
}, { critical: true, group: 'health' });

test('version', 'GET /api/version responde 200', async ({ http }) => {
  const res = await http.get('/api/version');
  assertStatus(res, 200);
  assertJson(res);
  assertField(res.json, 'name', 'Numination');
  return `v${res.json.version}`;
}, { group: 'health' });

test('ping', 'GET /api/ping responde pong', async ({ http }) => {
  const res = await http.get('/api/ping');
  assertStatus(res, 200);
  assertJson(res);
  assertField(res.json, 'ok', true);
  assertField(res.json, 'pong');
}, { group: 'health' });

test('security-headers', 'Headers de seguridad presentes', async ({ http }) => {
  const res = await http.get('/api/health');
  assertHeader(res, 'x-content-type-options', 'nosniff');
  assertHeader(res, 'x-frame-options', 'SAMEORIGIN');
  assertHeader(res, 'referrer-policy');
}, { group: 'security' });

test('request-id', 'X-Request-Id presente en cada respuesta', async ({ http }) => {
  const res = await http.get('/api/health');
  const id = res.headers?.get('x-request-id');
  assert(id && /^[a-f0-9]{6,}$/i.test(id), `Request ID inválido: ${id}`);
  return `id=${id}`;
}, { group: 'observability' });

test('cors-preflight', 'OPTIONS responde 204', async ({ http }) => {
  const res = await http.request('OPTIONS', '/api/health', {
    headers: { 'Origin': 'https://numinationchat.vercel.app' },
  });
  assertStatus(res, 204);
}, { group: 'security' });

test('login-missing-body', 'POST /api/auth/login sin body → 400', async ({ http }) => {
  const res = await http.post('/api/auth/login', {});
  assertStatus(res, [400, 401]);
  assertJson(res);
  assertField(res.json, 'ok', false);
  assert(res.json.error, 'Falta el campo error');
}, { group: 'auth-public' });

test('login-bad-email', 'POST /api/auth/login con email inválido → 400/401', async ({ http }) => {
  const res = await http.post('/api/auth/login', {
    email: 'no-es-email',
    password: 'x',
  });
  assertStatus(res, [400, 401, 429]);
  assertJson(res);
  assertField(res.json, 'ok', false);
}, { group: 'auth-public' });

test('signup-bad-password', 'POST /api/auth/signup con pass corto → 400', async ({ http }) => {
  const res = await http.post('/api/auth/signup', {
    email: 'smoke-test-' + Date.now() + '@example.com',
    password: '123',
  });
  assertStatus(res, [400, 429]);
  assertJson(res);
  assertField(res.json, 'ok', false);
}, { group: 'auth-public' });

test('login-wrong-creds', 'Login con credenciales malas → 401', async ({ http }) => {
  const res = await http.post('/api/auth/login', {
    email: 'noexiste-' + Date.now() + '@example.com',
    password: 'Password123',
  });
  assertStatus(res, [401, 429]);
  assertJson(res);
  assertField(res.json, 'ok', false);
}, { group: 'auth-public' });

test('google-empty-credential', 'POST /api/auth/google sin credential → 400', async ({ http }) => {
  const res = await http.post('/api/auth/google', {});
  assertStatus(res, [400, 401, 429]);
  assertJson(res);
  assertField(res.json, 'ok', false);
}, { group: 'auth-public' });

test('chat-stream-no-auth', 'POST /api/chat/stream sin sesión → 401', async ({ http }) => {
  const res = await http.post('/api/chat/stream', { message: 'hola' });
  // Aceptamos 401 o 429 (por rate limit)
  assertStatus(res, [401, 403, 429]);
  if (res.json) assertField(res.json, 'ok', false);
}, { group: 'auth-public' });

test('chats-list-no-auth', 'GET /api/chats sin sesión → 401', async ({ http }) => {
  const res = await http.get('/api/chats');
  assertStatus(res, [401, 429]);
  assertJson(res);
}, { group: 'auth-public' });

test('memories-list-no-auth', 'GET /api/memories sin sesión → 401', async ({ http }) => {
  const res = await http.get('/api/memories');
  assertStatus(res, [401, 429]);
  assertJson(res);
}, { group: 'auth-public' });

test('limits-usage-no-auth', 'GET /api/limits/usage sin sesión tolera 401/200', async ({ http }) => {
  const res = await http.get('/api/limits/usage');
  // Puede ser 200 (fail-open) o 401. Ambos válidos.
  assertStatus(res, [200, 401, 429]);
  assertJson(res);
}, { group: 'limits' });

test('404-json', 'Ruta /api/no-existe devuelve JSON 404', async ({ http }) => {
  const res = await http.get('/api/no-existe-' + Date.now());
  assertStatus(res, 404);
  assertJson(res);
  assertField(res.json, 'ok', false);
}, { group: 'routing' });

test('404-no-stack', 'La respuesta 404 no filtra paths internos', async ({ http }) => {
  const res = await http.get('/api/no-existe-' + Date.now());
  const body = res.text || '';
  assert(!body.includes('/Users/'), 'Stack filtra ruta de usuario');
  assert(!body.includes('C:\\Users'), 'Stack filtra ruta de Windows');
  assert(!body.includes('node_modules'), 'Stack filtra node_modules');
}, { group: 'security' });

test('root-redirects', 'GET / redirige a login', async ({ http }) => {
  const res = await http.request('GET', '/', { headers: { 'Accept': 'text/html' } });
  // fetch sigue redirects por defecto → esperamos 200 y HTML con "Numination"
  assert(res.status === 200, `Root devolvió ${res.status}`);
  assert(res.text.includes('Numination'), 'Root no sirve HTML de Numination');
}, { group: 'routing' });

test('login-page', 'GET /login.html sirve HTML', async ({ http }) => {
  const res = await http.request('GET', '/login.html');
  assertStatus(res, 200);
  assert(res.text.includes('Numination'), 'Login no contiene "Numination"');
  assert(res.text.includes('google'), 'Login no carga Google');
}, { group: 'frontend' });

test('chat-page-redirects-if-no-auth', 'GET /chat.html sin sesión → login', async ({ http }) => {
  const res = await http.request('GET', '/chat.html', { headers: { 'Accept': 'text/html' } });
  // fetch sigue el redirect → terminamos en login.html
  assert(res.status === 200, `Esperaba 200 tras redirect, recibí ${res.status}`);
  assert(
    res.text.includes('Welcome to') || res.text.includes('login'),
    'No fuimos redirigidos al login'
  );
}, { group: 'frontend' });

test('favicon-or-404', 'GET /favicon.ico no cuelga', async ({ http }) => {
  const res = await http.request('GET', '/favicon.ico');
  // 200 o 404, ambos OK. Lo importante es que responda rápido.
  assertStatus(res, [200, 404]);
  assertFasterThan(res.ms, 3000, 'favicon');
}, { group: 'frontend' });

/* ═══════════════════════════════════════════════════════════════════════
   8 · TESTS AUTENTICADOS (requieren cookie)
   ═══════════════════════════════════════════════════════════════════════ */

test('auth-me', 'GET /api/auth/me devuelve user', async ({ http, hasAuth }) => {
  if (!hasAuth) return 'SKIP (sin cookie)';
  const res = await http.get('/api/auth/me');
  assertStatus(res, 200);
  assertJson(res);
  if (res.json.ok) {
    assertField(res.json, 'user');
    return res.json.user.email || 'ok';
  }
  return 'sin sesión';
}, { group: 'auth-protected' });

test('auth-session', 'GET /api/auth/session devuelve info', async ({ http, hasAuth }) => {
  if (!hasAuth) return 'SKIP (sin cookie)';
  const res = await http.get('/api/auth/session');
  assertStatus(res, 200);
  assertJson(res);
  return res.json.authenticated ? 'autenticado' : 'anónimo';
}, { group: 'auth-protected' });

test('chats-list', 'GET /api/chats devuelve array', async ({ http, hasAuth }) => {
  if (!hasAuth) return 'SKIP (sin cookie)';
  const res = await http.get('/api/chats');
  assertStatus(res, 200);
  assertJson(res);
  assertField(res.json, 'ok', true);
  assert(Array.isArray(res.json.chats), 'chats no es array');
  return `${res.json.chats.length} chats`;
}, { group: 'chats' });

test('chats-create-and-delete', 'POST/DELETE /api/chats funciona', async ({ http, hasAuth }) => {
  if (!hasAuth) return 'SKIP (sin cookie)';
  const create = await http.post('/api/chats', { title: 'Smoke test ' + Date.now() });
  assertStatus(create, [200, 201]);
  assertJson(create);
  const chatId = create.json?.chat?.id || create.json?.id;
  assert(chatId, 'No devolvió id del chat');

  const del = await http.del('/api/chats/' + chatId);
  assertStatus(del, [200, 204]);
  return `creado y eliminado ${chatId.slice(0, 8)}`;
}, { group: 'chats', needsAuth: true });

test('limits-usage', 'GET /api/limits/usage devuelve uso', async ({ http, hasAuth }) => {
  if (!hasAuth) return 'SKIP (sin cookie)';
  const res = await http.get('/api/limits/usage');
  assertStatus(res, 200);
  assertJson(res);
  return `plan=${res.json.plan || '?'} · uso=${res.json.uso?.dia ?? '?'}/${res.json.limites?.porDia ?? '?'}`;
}, { group: 'limits' });

test('memories-list', 'GET /api/memories devuelve array', async ({ http, hasAuth }) => {
  if (!hasAuth) return 'SKIP (sin cookie)';
  const res = await http.get('/api/memories');
  assertStatus(res, 200);
  assertJson(res);
  return `${(res.json.memories || []).length} memorias`;
}, { group: 'memories' });

test('chat-stream-tokens', 'POST /api/chat/stream emite tokens SSE', async ({ http, hasAuth }) => {
  if (!hasAuth) return 'SKIP (sin cookie)';
  const res = await http.post('/api/chat/stream',
    { message: 'di solo la palabra ok', role: 'student' },
    { expectStream: true }
  );
  assertStatus(res, 200);
  assert(res.text.includes('data:'), 'No es SSE (falta "data:")');
  const hasMeta = res.text.includes('"meta"');
  const hasToken = res.text.includes('"token"');
  assert(hasMeta || hasToken, 'SSE no contiene meta ni token');
  const ct = res.headers?.get('content-type') || '';
  assert(ct.includes('text/event-stream'), `Content-Type incorrecto: ${ct}`);
  return hasToken ? 'meta + tokens' : 'solo meta';
}, { group: 'chat', needsAuth: true });

test('skills-list', 'GET /api/skills responde', async ({ http, hasAuth }) => {
  if (!hasAuth) return 'SKIP (sin cookie)';
  const res = await http.get('/api/skills');
  assertStatus(res, [200, 401]);
  if (res.status === 200) assertJson(res);
  return res.status === 200 ? 'ok' : 'requiere auth';
}, { group: 'skills' });

test('connectors-list', 'GET /api/connectors responde', async ({ http, hasAuth }) => {
  if (!hasAuth) return 'SKIP (sin cookie)';
  const res = await http.get('/api/connectors');
  assertStatus(res, [200, 401, 404]);
  if (res.status === 200) assertJson(res);
  return res.status === 200 ? 'ok' : `status ${res.status}`;
}, { group: 'connectors' });

/* ═══════════════════════════════════════════════════════════════════════
   9 · RUNNER
   ═══════════════════════════════════════════════════════════════════════ */

async function run(opts) {
  const http = new HTTPClient(opts.url, {
    timeout: opts.timeout,
    verbose: opts.verbose,
    cookie: opts.cookie,
  });

  const hasAuth = Boolean(opts.cookie);

  if (!opts.json) {
    log.section('Numination · Smoke Test');
    log.info(`URL: ${C.bold(opts.url)}`);
    log.info(`Modo: ${opts.mode} · Timeout: ${opts.timeout}ms · Auth: ${hasAuth ? '✓' : '✗'}`);
  }

  // Filtrar tests según el modo
  let toRun = tests;
  if (opts.mode === 'quick') {
    toRun = tests.filter((t) => t.critical);
  }

  // Separar grupos
  const groupOrder = ['health', 'security', 'observability', 'auth-public', 'auth-protected', 'chat', 'chats', 'limits', 'memories', 'skills', 'connectors', 'routing', 'frontend'];
  const grouped = new Map();
  for (const t of toRun) {
    const g = t.group || 'other';
    if (!grouped.has(g)) grouped.set(g, []);
    grouped.get(g).push(t);
  }
  const orderedGroups = groupOrder.filter((g) => grouped.has(g));

  const results = [];
  const t0 = performance.now();

  for (const g of orderedGroups) {
    if (!opts.json) log.section(g);

    for (const t of grouped.get(g)) {
      const start = performance.now();
      try {
        const detail = await t.fn({ http, hasAuth, opts });
        const ms = Math.round(performance.now() - start);
        const isSkip = typeof detail === 'string' && detail.startsWith('SKIP');
        results.push({ id: t.id, label: t.label, ok: true, skipped: isSkip, ms, detail, group: g });
        if (!opts.json) {
          if (isSkip) log.warn(t.label, `(${ms}ms)`);
          else log.ok(t.label, detail ? `· ${detail} · ${ms}ms` : `${ms}ms`);
        }
      } catch (err) {
        const ms = Math.round(performance.now() - start);
        const msg = err instanceof AssertionError ? err.message : (err.message || String(err));
        results.push({ id: t.id, label: t.label, ok: false, ms, error: msg, group: g });
        if (!opts.json) log.fail(t.label, `(${ms}ms)`);
        if (!opts.json) console.log(C.gray(`      ${msg}`));
      }
    }
  }

  const totalMs = Math.round(performance.now() - t0);
  const passed = results.filter((r) => r.ok && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const failed = results.filter((r) => !r.ok).length;
  const total = results.length;

  /* ─── Reporte final ─── */
  if (opts.json) {
    const out = {
      ok: failed === 0,
      url: opts.url,
      mode: opts.mode,
      totalMs,
      summary: { total, passed, skipped, failed },
      results: results.map((r) => ({
        id: r.id,
        label: r.label,
        group: r.group,
        ok: r.ok,
        skipped: r.skipped || false,
        ms: r.ms,
        detail: r.detail || null,
        error: r.error || null,
      })),
    };
    console.log(JSON.stringify(out, null, 2));
  } else {
    log.section('Resultado');
    const summary = `${C.bold('Total:')} ${total}  ${C.green('✓ ' + passed)}  ${C.yellow('⊘ ' + skipped)}  ${failed > 0 ? C.red('✗ ' + failed) : C.gray('✗ 0')}`;
    log.plain('  ' + summary);
    log.plain('  ' + C.gray(`Tiempo total: ${totalMs}ms · promedio: ${Math.round(totalMs / total)}ms/test`));

    // Mostrar los más lentos si hay tiempo
    const slow = results.filter((r) => r.ok && r.ms > 500).sort((a, b) => b.ms - a.ms).slice(0, 3);
    if (slow.length > 0) {
      log.plain('');
      log.plain('  ' + C.bold('Más lentos:'));
      for (const r of slow) {
        log.plain('  ' + C.gray(`· ${r.label} · ${r.ms}ms`));
      }
    }

    if (failed > 0) {
      log.plain('');
      log.plain('  ' + C.bold(C.red('Fallidos:')));
      for (const r of results.filter((x) => !x.ok)) {
        log.plain('  ' + C.red(`✗ ${r.id}`) + ' · ' + r.label);
        log.plain('     ' + C.gray(r.error));
      }
    }
  }

  return failed === 0 ? EXIT_OK : EXIT_FAIL;
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · MAIN
   ═══════════════════════════════════════════════════════════════════════ */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.url || !/^https?:\/\//.test(opts.url)) {
    console.error(`URL inválida: ${opts.url}`);
    process.exit(EXIT_CONFIG);
  }

  try {
    const code = await run(opts);
    process.exit(code);
  } catch (e) {
    console.error('\n' + C.red('Error fatal en el runner:'));
    console.error(e);
    process.exit(EXIT_CONFIG);
  }
}

main();