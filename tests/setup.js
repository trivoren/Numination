/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/setup.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Helper global de la suite de pruebas.

   QUÉ HACE
     1 · Configura el entorno de pruebas (NODE_ENV=test, secretos de
       prueba, desactiva el guard de IPs).
     2 · Proporciona un CLIENTE DE BASE DE DATOS MOCK: un objeto
       compatible con postgres.js que registra todas las consultas y
       devuelve filas programables. Se instala con `setSqlClient()`
       (binding vivo → todos los módulos lo ven sin tocar sus queries).
     3 · `mockReqRes()` simula una request/response de Express.
     4 · `withMockedFetch()` intercepta `globalThis.fetch` para simular
       Groq, Gemini, PayPal y cualquier otra API externa SIN gastar un
       solo token ni hacer una sola request real.
     5 · `startServer()` levanta la app de Express en un puerto
       efímero (sin tocar el 8080).

   IMPORTANTE
     Este archivo NO es un test: no tiene `test()`. Se importa al
     principio de cada archivo de pruebas y sus efectos colaterales
     (env, mocks) se aplican antes de que se evalúe el resto del
     módulo de test.
   ═══════════════════════════════════════════════════════════════════════════ */


/* ═══════════════════════════════════════════════════════════════════════════
   00 · ORDEN DE CARGA (importante)
   ───────────────────────────────────────────────────────────────────────────
   El import de la capa de datos se hace DE FORMA DINÁMICA y DESPUÉS de
   fijar el entorno. Motivo: varios módulos del proyecto usan top-level
   await (para leer env.local.js). Con TLA, el evaluador de ESM puede
   suspender un módulo y seguir con el siguiente hermano, de modo que un
   módulo importado más abajo puede evaluarse ANTES de que este archivo
   termine su cuerpo. Si el módulo de auth capturara los secretos en ese
   momento, leería un entorno vacío.

   Por eso: primero entorno, después dependencias.
   ═══════════════════════════════════════════════════════════════════════════ */

/* ═══════════════════════════════════════════════════════════════════════════
   01 · ENTORNO
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Secretos de prueba. Se fijan ANTES de que se importe cualquier módulo
 * que los lea en tiempo de carga (src/middleware/auth.js lee
 * SESSION_SECRETS al importarse).
 */
process.env.NODE_ENV = 'test';
process.env.TEST = 'true';
process.env.JWT_SECRET = 'test-jwt-secret-para-suite-de-pruebas-0123456789';
process.env.SESSION_SECRET = 'test-session-secret-para-suite-de-pruebas-9876543210';
process.env.SUPABASE_JWT_SECRET = 'test-jwt-secret-para-suite-de-pruebas-0123456789';

/** No levantar el guard de IPs ni el servidor real durante los tests. */
process.env.IP_GUARD = 'false';
process.env.NO_LISTEN = '1';
process.env.BACKUP_ENABLED = 'false';
process.env.SANDBOX_MODE = 'mock';

/* La capa de datos se importa DESPUÉS de fijar el entorno (ver nota 00). */
const { setSqlClient, resetSqlClient, supabaseDisponible } = await import('../src/services/supabase.js');

/** IDs deterministas: dos usuarios distintos para probar el aislamiento. */
export const TEST_USER_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
export const THIRD_USER_ID = '33333333-3333-4333-8333-333333333333';

/** Perfil de usuario simulado. */
export function testUser(overrides = {}) {
  return {
    id: TEST_USER_ID,
    userId: TEST_USER_ID,
    email: 'test@numination.app',
    name: 'Usuario de Prueba',
    role: 'student',
    plan: 'free',
    verified: true,
    banned: false,
    suspended: false,
    scopes: [],
    ...overrides,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · MOCK DE BASE DE DATOS (postgres.js)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Crea un cliente compatible con postgres.js.
 *
 * @param {object} handlers
 *   Mapa de "substring del SQL" → filas | (text, values, calls) => filas.
 *   La clave se busca por substring (sin distinguir mayúsculas).
 * @param {object} [options]
 *   defaultRows → filas por defecto cuando no hay handler (por defecto []).
 * @returns {Function} cliente mock (callable + .json/.array/.unsafe/.begin)
 */
export function createMockSql(handlers = {}, options = {}) {
  const calls = [];
  const defaultRows = options.defaultRows ?? [];

  const find = (text) => {
    // El texto SQL viene del template de postgres.js con saltos de línea
    // entre las partes: se normaliza para que las claves del mapa
    // ("select strikes") coincidan con ("select\n  strikes").
    const haystack = String(text).toLowerCase().replace(/\s+/g, ' ').trim();

    for (const [key, handler] of Object.entries(handlers)) {
      const needle = String(key).toLowerCase().replace(/\s+/g, ' ').trim();
      if (haystack.includes(needle)) return handler;
    }
    return null;
  };

  const run = async (text, values) => {
    const params = values || [];

    calls.push({ text: String(text), values: params });

    const handler = find(text);
    if (!handler) return defaultRows;

    if (typeof handler === 'function') {
      const result = await handler(String(text), params, calls);
      return Array.isArray(result) ? result : (result ?? defaultRows);
    }

    return handler;
  };

  /**
   * Expande una plantilla (como hace postgres.js).
   * Un valor que sea un "fragmento" (otra plantilla) se inyecta EN LÍNEA:
   * sus strings y sus values se mezclan con los de la plantilla padre.
   *
   * @param {string[]} strings
   * @param {Array} values
   * @returns {{text:string, params:Array}}
   */
  const buildQuery = (strings, values) => {
    let text = '';
    const params = [];

    for (let i = 0; i < strings.length; i++) {
      text += strings[i];

      if (i >= values.length) continue;

      const value = values[i];

      if (value && value.__frag) {
        const inner = buildQuery(value.strings, value.values);
        text += inner.text;
        params.push(...inner.params);
      } else if (value && typeof value === 'object' && value.__id) {
        // Identificador: se inyecta como texto, NO es un parámetro.
        text += value.__id;
      } else {
        text += ' ? ';
        params.push(value);
      }
    }

    return { text, params };
  };

  /**
   * Fragmento: objeto "thenable" (se puede await) que además se puede
   * embeber en otra plantilla. Es exactamente el modelo de postgres.js.
   */
  const makeFragment = (strings, values) => ({
    __frag: true,
    strings,
    values,
    then(onOk, onErr) {
      const { text, params } = buildQuery(strings, values);
      return run(text, params).then(onOk, onErr);
    },
  });

  const client = (strings, ...values) => {
    // postgres.js permite dos usos:
    //   sql`select ...`        → template tag (fragmento thenable)
    //   sql('nombre_tabla')    → identificador: se devuelve de forma
    //                            SINCRÓNICA para poder interpolarlo
    //                            dentro de otro template.
    if (!Array.isArray(strings)) {
      return { __id: String(strings) };
    }

    return makeFragment(strings, values);
  };

  // Helpers de postgres.js usados por los servicios.
  client.json = (value) => ({ __json: value });
  client.array = (value) => ({ __array: value });
  client.unsafe = async (text, params = []) => run(text, params);
  client.begin = async (fn) => fn(client);

  // postgres.js reserva una conexión del pool dentro de una transacción.
  // Contamos las reservas para poder verificar que una operación sensible
  // (un abono de créditos) corre dentro de una transacción.
  let reserveCount = 0;
  client.reserve = async () => {
    reserveCount++;
    return client;
  };
  Object.defineProperty(client, 'reserveCount', { get: () => reserveCount });

  client.calls = calls;
  client.values = () => calls;

  /** Devuelve la última consulta registrada. */
  client.lastCall = () => calls[calls.length - 1] || null;
  /** Devuelve las consultas que contienen un fragmento. */
  client.callsMatching = (fragment) => {
    const needle = String(fragment).toLowerCase().replace(/\s+/g, ' ').trim();
    return calls.filter((c) => c.text.toLowerCase().replace(/\s+/g, ' ').includes(needle));
  };

  return client;
}

/**
 * Instala un cliente mock en la capa de datos.
 * @returns {Function} el cliente instalado
 */
export function mockDatabase(handlers = {}, options = {}) {
  const client = createMockSql(handlers, options);
  setSqlClient(client);
  return client;
}

/**
 * Restaura el cliente real de Postgres.
 */
export function restoreDatabase() {
  return resetSqlClient();
}

/**
 * ¿Hay base de datos disponible ahora mismo?
 */
export function databaseAvailable() {
  return supabaseDisponible();
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · MOCK DE REQUEST / RESPONSE DE EXPRESS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Crea un par (req, res, next) que imita a Express.
 *
 * @param {object} [options]
 *   body, params, query, headers, user, ip, method, path, cookies
 * @returns {{req:object, res:object, next:Function, calls:object}}
 */
export function mockReqRes(options = {}) {
  const {
    body = {},
    params = {},
    query = {},
    headers = {},
    user = null,
    ip = '127.0.0.1',
    method = 'GET',
    path = '/',
    cookies = {},
  } = options;

  const calls = {
    status: null,
    json: null,
    sent: null,
    end: false,
    headers: {},
  };

  const req = {
    body,
    params,
    query,
    headers: { 'user-agent': 'node-test', ...headers },
    cookies,
    user,
    userId: user?.id ?? null,
    ip,
    method,
    path,
    originalUrl: path,
    // express-rate-limit consulta trust proxy en la app.
    app: { get: (name) => (name === 'trust proxy' ? false : undefined) },
    get(name) {
      const key = String(name).toLowerCase();
      return this.headers[key] ?? this.headers[name] ?? undefined;
    },
    socket: { remoteAddress: ip },
  };

  const res = {
    headersSent: false,
    statusCode: 200,
    locals: {},
    headers: {},
    setHeader(name, value) {
      calls.headers[String(name).toLowerCase()] = value;
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    removeHeader(name) {
      delete this.headers[String(name).toLowerCase()];
    },
    status(code) {
      calls.status = code;
      this.statusCode = code;
      return this;
    },
    json(payload) {
      calls.json = payload;
      this.headersSent = true;
      return this;
    },
    send(payload) {
      calls.sent = payload;
      this.headersSent = true;
      return this;
    },
    end(payload) {
      calls.end = true;
      if (payload !== undefined) calls.sent = payload;
      return this;
    },
    redirect(url) {
      calls.redirect = url;
      this.headersSent = true;
      return this;
    },
  };

  const next = (err) => {
    calls.nextCalled = true;
    calls.nextError = err || null;
  };

  return { req, res, next, calls };
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · MOCK DE FETCH (APIs EXTERNAS)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Intercepta `globalThis.fetch` con una tabla de respuestas.
 *
 * @param {object} routes
 *   Mapa de "substring de la URL" → función (url, init) => Response | objeto
 * @returns {Function} restaurador (llamar en afterEach)
 */
export function withMockedFetch(routes = {}) {
  const original = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    const href = typeof url === 'string' ? url : String(url?.url || url);
    calls.push({ url: href, init });

    const lower = href.toLowerCase();
    for (const [fragment, handler] of Object.entries(routes)) {
      if (lower.includes(String(fragment).toLowerCase())) {
        const result = typeof handler === 'function' ? await handler(href, init) : handler;
        if (result instanceof Response) return result;
        return jsonResponse(result);
      }
    }

    return jsonResponse({ error: { message: `Sin mock para ${href}` } }, 501);
  };

  const restore = () => {
    globalThis.fetch = original;
  };

  restore.calls = calls;
  return restore;
}

/**
 * Construye una Response JSON.
 */
export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Construye una Response de texto.
 */
export function textResponse(body, status = 200, contentType = 'text/plain') {
  return new Response(body, { status, headers: { 'Content-Type': contentType } });
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · SERVIDOR EFÍMERO
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Levanta una app de Express en un puerto efímero (no toca el 8080).
 *
 * @param {import('express').Application} app
 * @returns {Promise<{url:string, port:number, close:Function, request:Function}>}
 */
export function startServer(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const url = `http://127.0.0.1:${port}`;

      /**
       * Petición helper: devuelve { status, json, headers, text }.
       */
      const request = async (path, options = {}) => {
        const { method = 'GET', body, headers = {}, cookie } = options;
        const finalHeaders = { Accept: 'application/json', ...headers };
        if (cookie) finalHeaders.Cookie = cookie;
        if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';

        const res = await fetch(url + path, {
          method,
          headers: finalHeaders,
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        const text = await res.text();
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* no JSON */ }

        return { status: res.status, json, text, headers: res.headers };
      };

      resolve({
        url,
        port,
        request,
        close: () => new Promise((done) => server.close(done)),
      });
    });

    server.on('error', reject);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

/** Genera un JWT de prueba (para el middleware de auth). */
export async function signTestToken(payload = {}, { secret = process.env.JWT_SECRET, expiresIn = '1h' } = {}) {
  const jwt = (await import('jsonwebtoken')).default;
  return jwt.sign(
    {
      sub: payload.sub ?? TEST_USER_ID,
      email: payload.email ?? 'test@numination.app',
      role: payload.role ?? 'student',
      ver: payload.ver ?? 1,
      ...payload,
    },
    secret,
    { algorithm: 'HS256', expiresIn }
  );
}

/** Coincidencia de substring, insensible a mayúsculas. */
export function contains(haystack, needle) {
  return String(haystack || '').toLowerCase().includes(String(needle || '').toLowerCase());
}

/** Espera un tiempo dado (ms). */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deja que terminen los middlewares asíncronos.
 *
 * Express no espera a los middlewares: `requireAuth` dispara `attachUser`
 * sin await y sigue la cadena cuando el callback invoca `next()`. En los
 * tests hay que drenar la cola de tareas para observar el resultado.
 *
 * @param {number} [times] vueltas del event loop
 */
export async function flush(times = 4) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Restaura todos los mocks globales. Llamar en `afterEach`.
 */
export function restoreAll({ restoreFetch = null, restoreDb = false } = {}) {
  if (typeof restoreFetch === 'function') restoreFetch();
  if (restoreDb) restoreDatabase();
}

export default {
  TEST_USER_ID,
  OTHER_USER_ID,
  THIRD_USER_ID,
  testUser,
  createMockSql,
  mockDatabase,
  restoreDatabase,
  databaseAvailable,
  mockReqRes,
  withMockedFetch,
  jsonResponse,
  textResponse,
  startServer,
  signTestToken,
  contains,
  sleep,
  restoreAll,
};
