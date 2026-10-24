/* ═══════════════════════════════════════════════════════════════════════
   ESCUDO DE SEGURIDAD · HASH INTERCEPTOR (Supabase Auth)

   PROBLEMA QUE RESUELVE
   ─────────────────────
   Google/GitHub devuelven la sesión al navegador y Supabase redirige a
   la URL declarada en `redirectTo`:
     · #access_token=...&refresh_token=...   (implicit)
     · ?code=...                              (PKCE)
   Si esa URL no está en la allow-list del proyecto, Supabase cae en el
   "Site URL" configurado — en este proyecto era `numination://` (el deep
   link de la app móvil). El navegador responde entonces
   "scheme does not have a registered handler" y el usuario queda
   atascado en el login.

   QUÉ HACE ESTE ARCHIVO
   ─────────────────────
   1) Detecta el callback de OAuth en la URL actual (#access_token= o
      ?code=) ANTES de que cualquier otro script actúe.
   2) Persiste la sesión en el storage del SDK de Supabase
      (localStorage · key `sb-numeration-auth`) y copia el access token a
      `numination-api-token` para que api.js lo envíe como
      `Authorization: Bearer` a la API.
   3) Limpia la URL (el token no queda en el historial ni se filtra por
      Referer) y hace `location.replace('/chat.html')`.
   4) Si el callback llega con error (otp expirado, access_denied…),
      limpia la URL y devuelve el control al login mostrando el motivo.

   Es idempotente, no depende del orden de carga de los demás scripts y
   no hace absolutamente nada en páginas sin callback.
   ═══════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var CHAT_PATH = '/chat.html';
  var LOGIN_PATH = '/login.html';
  var CONFIRM_AGE_PATH = '/confirm-age.html';

  var SDK_TIMEOUT_MS = 15000;    // espera máxima al CDN de supabase-js
  var CONFIG_TIMEOUT_MS = 5000;  // espera máxima a config.js / auth.js
  var POLL_MS = 50;

  var AUTH_PARAMS = [
    'access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type',
    'type', 'code', 'state', 'error', 'error_code', 'error_description'
  ];

  var state = { started: false, promise: null, params: null, finished: false };

  /* ─────────────────────────────────────────────────────────────────
     UTILIDADES
     ───────────────────────────────────────────────────────────────── */
  function log(level, msg) {
    try { if (global.console && global.console[level]) global.console[level]('[auth-callback] ' + msg); }
    catch (_) {}
  }

  function readMeta(name) {
    try {
      var el = document.querySelector('meta[name="' + name + '"]');
      return el && el.content ? String(el.content).trim() : '';
    } catch (_) { return ''; }
  }

  function cfg() { return global.NuminationConfig || null; }

  function supabaseUrl() {
    var c = cfg();
    if (c && c.supabaseUrl) return c.supabaseUrl;
    return readMeta('supabase-url');
  }

  function publishableKey() {
    var c = cfg();
    if (c) {
      try { if (c.supabasePublishableKey) return c.supabasePublishableKey; } catch (_) {}
    }
    return readMeta('supabase-publishable-key');
  }

  function storageKey() {
    var c = cfg();
    if (c && c.storageKeys && c.storageKeys.supabaseAuth) return c.storageKeys.supabaseAuth;
    return 'sb-numination-auth';
  }

  function apiTokenKey() {
    var c = cfg();
    if (c && c.storageKeys && c.storageKeys.apiToken) return c.storageKeys.apiToken;
    return 'numination-api-token';
  }

  function waitFor(check, timeoutMs) {
    if (check()) return Promise.resolve(true);
    var deadline = Date.now() + timeoutMs;
    return new Promise(function (resolve) {
      (function tick() {
        if (check()) return resolve(true);
        if (Date.now() >= deadline) return resolve(false);
        setTimeout(tick, POLL_MS);
      })();
    });
  }

  /* ─────────────────────────────────────────────────────────────────
     PARSEO DEL CALLBACK
     ───────────────────────────────────────────────────────────────── */
  function parseParams() {
    var out = {};
    function feed(str, prefix) {
      if (!str) return;
      str = String(str).replace(new RegExp('^' + prefix), '');
      if (!str) return;
      str.split('&').forEach(function (kv) {
        if (!kv) return;
        var i = kv.indexOf('=');
        var k = i > 0 ? kv.slice(0, i) : kv;
        var v = i > 0 ? kv.slice(i + 1) : '';
        try { k = decodeURIComponent(k.replace(/\+/g, ' ')); } catch (_) {}
        try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (_) {}
        if (k && !(k in out)) out[k] = v;
      });
    }
    try {
      feed(global.location.hash, '#');
      feed(global.location.search, '\\?');
    } catch (_) {}
    return out;
  }

  /**
   * ¿La URL trae un callback de Supabase?
   * - #access_token=...  → flujo implicit (Google/GitHub)
   * - ?code=...          → flujo PKCE
   * - error_code / error_description → callback de error de Supabase
   * OJO: `?error=state` lo usa el callback legacy del servidor
   *      (/api/auth/github/callback), no es Supabase, por eso NO dispara
   *      este escudo.
   */
  function isCallback(p) {
    if (!p) return false;
    if (p.access_token || p.code) return true;
    if (p.error_code || p.error_description) return true;
    return false;
  }

  /* ─────────────────────────────────────────────────────────────────
     PERSISTENCIA DE LA SESIÓN
     ───────────────────────────────────────────────────────────────── */
  function persistApiToken(accessToken) {
    if (!accessToken) return;
    try { localStorage.setItem(apiTokenKey(), accessToken); } catch (_) {}
    try {
      if (global.NuminationApi && typeof global.NumerationApi.setToken === 'function') {
        global.NumerationApi.setToken(accessToken);
      }
    } catch (_) {}
  }

  function decodeJwtPayload(token) {
    try {
      var parts = String(token).split('.');
      if (parts.length < 2) return null;
      var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var json = new TextDecoder('utf-8').decode(bytes);
      return JSON.parse(json);
    } catch (_) { return null; }
  }

  /**
   * Último recurso: escribir la sesión a mano en el storage del SDK.
   * Formato de supabase-js v2 (GoTrueClient):
   *   { access_token, token_type, expires_in, expires_at, refresh_token, user }
   */
  function persistManually(p) {
    if (!p || !p.access_token || !p.refresh_token) return null;
    try {
      var payload = decodeJwtPayload(p.access_token) || {};
      var now = Math.floor(Date.now() / 1000);
      var expiresIn = Number(p.expires_in) || 3600;
      var expiresAt = Number(p.expires_at) || (now + expiresIn);
      var session = {
        access_token: p.access_token,
        token_type: p.token_type || 'bearer',
        expires_in: expiresIn,
        expires_at: expiresAt,
        refresh_token: p.refresh_token,
        user: {
          id: payload.sub || '',
          aud: payload.aud || 'authenticated',
          role: payload.role || 'authenticated',
          email: payload.email || null,
          email_confirmed_at: payload.email ? new Date().toISOString() : null,
          app_metadata: payload.app_metadata || {},
          user_metadata: payload.user_metadata || {},
          created_at: payload.iat ? new Date(payload.iat * 1000).toISOString() : new Date().toISOString()
        }
      };
      localStorage.setItem(storageKey(), JSON.stringify(session));
      persistApiToken(p.access_token);
      return session;
    } catch (e) {
      log('warn', 'persistManually fallo: ' + (e && e.message));
      return null;
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     CLIENTE SUPABASE
     ───────────────────────────────────────────────────────────────── */
  function sdkReady() {
    return !!(global.supabase && typeof global.supabase.createClient === 'function');
  }

  function authReady() {
    return !!(global.NuminationAuth && typeof global.NumerationAuth.getClient === 'function');
  }

  async function getClient() {
    // 1) Espera al CDN de supabase-js.
    var ok = await waitFor(sdkReady, SDK_TIMEOUT_MS);
    if (!ok) return null;

    // 2) Espera a config.js y a auth.js: comparten URL, publishable key y
    //    storage key, asi que usar su cliente evita dos clientes peleandose
    //    por la misma sesion en localStorage.
    await waitFor(function () { return !!cfg(); }, CONFIG_TIMEOUT_MS);
    await waitFor(authReady, CONFIG_TIMEOUT_MS);

    // 3) Cliente compartido de auth.js.
    try {
      if (authReady()) return global.NuminationAuth.getClient();
    } catch (_) {}

    // 4) Cliente propio (paginas sin auth.js).
    var url = supabaseUrl();
    var key = publishableKey();
    if (!url || !key) {
      log('warn', 'faltan SUPABASE_URL o la publishable key');
      return null;
    }

    return global.supabase.createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // El callback lo gestiona este script de forma explicita: asi no
        // dependemos del orden de carga ni de que el SDK limpie el hash
        // antes de que lo leamos.
        detectSessionInUrl: false,
        storageKey: storageKey()
      }
    });
  }

  /* ─────────────────────────────────────────────────────────────────
     FLUJO PKCE (?code=...)
     ───────────────────────────────────────────────────────────────── */
  async function exchangeCode(client, code) {
    // 1) SDK (guarda el code_verifier en localStorage).
    try {
      var res = await client.auth.exchangeCodeForSession(code);
      if (res && !res.error && res.data && res.data.session) return res.data.session;
      log('warn', 'exchangeCodeForSession: ' + (res && res.error && res.error.message));
    } catch (e) {
      log('warn', 'exchangeCodeForSession lanzo: ' + (e && e.message));
    }

    // 2) Fallback manual: intercambio PKCE contra /auth/v1/token.
    try {
      var verifier = localStorage.getItem(storageKey() + '-code-verifier');
      if (!verifier) return null;
      var r = await fetch(supabaseUrl() + '/auth/v1/token?grant_type=pkce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: publishableKey() },
        body: JSON.stringify({ auth_code: code, code_verifier: verifier, grant_type: 'pkce' })
      });
      if (!r.ok) return null;
      var data = await r.json();
      if (!data || !data.access_token || !data.refresh_token) return null;
      var set = await client.auth.setSession({
        access_token: data.access_token,
        refresh_token: data.refresh_token
      });
      if (set && set.error) return null;
      return (set && set.data && set.data.session) || {
        access_token: data.access_token,
        refresh_token: data.refresh_token
      };
    } catch (e) {
      log('warn', 'intercambio PKCE manual fallo: ' + (e && e.message));
      return null;
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     LIMPIEZA DE URL
     ───────────────────────────────────────────────────────────────── */
  function cleanupUrl() {
    try {
      var q = new URLSearchParams(global.location.search || '');
      AUTH_PARAMS.forEach(function (k) { q.delete(k); });
      var search = q.toString();
      var url = global.location.pathname + (search ? '?' + search : '');
      if (global.history && global.history.replaceState) {
        global.history.replaceState(null, '', url);
      }
    } catch (_) {
      try {
        if (global.history && global.history.replaceState) {
          global.history.replaceState(null, '', global.location.pathname);
        }
      } catch (__) {}
    }
  }

  /* ─────────────────────────────────────────────────────────────────
     ERRORES
     ───────────────────────────────────────────────────────────────── */
  function failFlow(code, message) {
    log('warn', 'callback fallido (' + code + '): ' + message);
    try {
      if (typeof global.CustomEvent === 'function') {
        global.dispatchEvent(new global.CustomEvent('nm:auth-callback-error', {
          detail: { code: code, message: message }
        }));
      }
    } catch (_) {}

    try {
      var path = global.location.pathname || '';
      if (/\/login(\.html)?$/.test(path)) {
        // Ya estamos en el login: mostramos el motivo y paramos.
        var el = document.getElementById('entry-error');
        if (el) el.textContent = message;
      } else {
        global.location.replace(LOGIN_PATH + '?error=' + encodeURIComponent(code));
      }
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────────────────────────
     PUERTA DE EDAD (14+) · coherente con routeAfterAuth de auth.js
     ───────────────────────────────────────────────────────────────── */
  function needsAgeGate(user) {
    var m = (user && (user.user_metadata || user.userMetadata)) || {};
    if (m.banned_underage === true || m.banned_underage === 'true') return true;
    return !(m.age_14_plus === true || m.age_14_plus === 'true');
  }

  function goNext(session) {
    var user = session && (session.user || null);
    if (user && needsAgeGate(user)) {
      log('info', 'usuario sin confirmar edad -> /confirm-age.html');
      global.location.replace(CONFIRM_AGE_PATH);
      return;
    }
    log('info', 'sesion establecida -> ' + CHAT_PATH);
    global.location.replace(CHAT_PATH);
  }

  /* ─────────────────────────────────────────────────────────────────
     PROCESO PRINCIPAL
     ───────────────────────────────────────────────────────────────── */
  async function processCallback(p) {
    // 1) Callback de error de Supabase (otp expirado, access_denied...).
    if (p.error_code || p.error_description) {
      cleanupUrl();
      failFlow(p.error_code || 'oauth_error', p.error_description || p.error_code || 'Error de autenticacion');
      return null;
    }

    var client = await getClient();

    // 2) Sin SDK: escritura manual en localStorage (el token ya viene en
    //    la URL, no hace falta el SDK para persistirlo).
    if (!client) {
      var manual0 = persistManually(p);
      cleanupUrl();
      if (manual0) { global.location.replace(CHAT_PATH); return manual0; }
      failFlow('no_sdk', 'No se pudo cargar el SDK de autenticacion');
      return null;
    }

    var session = null;

    // 3) Flujo implicit: #access_token=...&refresh_token=...
    if (p.access_token && p.refresh_token) {
      try {
        var res = await client.auth.setSession({
          access_token: p.access_token,
          refresh_token: p.refresh_token
        });
        if (res && res.error) {
          log('warn', 'setSession: ' + res.error.message);
        } else if (res && res.data && res.data.session) {
          session = res.data.session;
        }
      } catch (e) {
        log('warn', 'setSession lanzo: ' + (e && e.message));
      }
    }

    // 4) Flujo PKCE: ?code=...
    if (!session && p.code) {
      session = await exchangeCode(client, p.code);
    }

    // 5) ¿Ya habia sesion? (p. ej. el SDK la detecto al inicializarse)
    if (!session) {
      try {
        var g = await client.auth.getSession();
        session = (g && g.data && g.data.session) || null;
      } catch (_) {}
    }

    // 6) Ultimo recurso: escritura manual en localStorage.
    if (!session) {
      var manual = persistManually(p);
      cleanupUrl();
      if (manual) { global.location.replace(CHAT_PATH); return manual; }
      failFlow('no_session', 'No se pudo completar el inicio de sesion');
      return null;
    }

    // 7) Sesion lista -> token para la API + limpieza + redireccion.
    persistApiToken(session.access_token);
    cleanupUrl();
    goNext(session);
    return session;
  }

  /**
   * Punto de entrada. Idempotente: solo se ejecuta una vez por pagina.
   */
  function run() {
    if (state.started) return state.promise;
    state.started = true;

    var params = parseParams();
    state.params = params;

    if (!isCallback(params)) {
      log('debug', 'sin callback en la URL · nada que interceptar');
      state.promise = Promise.resolve(null);
      return state.promise;
    }

    log('info', 'callback detectado · interceptando sesion');
    state.promise = processCallback(params)
      .catch(function (e) {
        log('error', 'error procesando el callback: ' + (e && e.message));
        cleanupUrl();
        failFlow('unexpected', (e && e.message) || 'Error inesperado');
        return null;
      })
      .then(function (r) { state.finished = true; return r; });

    return state.promise;
  }

  global.NumerationAuthCallback = {
    run: run,
    parseParams: parseParams,
    isCallback: isCallback,
    cleanupUrl: cleanupUrl,
    CHAT_PATH: CHAT_PATH,
    LOGIN_PATH: LOGIN_PATH,
    /** true si la URL traia un callback de Supabase (asi el resto de
     *  scripts no hacen un routing competing). */
    detected: function () { return isCallback(state.params); }
  };

  /* Auto-arranque: se procesa el callback en el mismo tick de carga,
     antes de que el resto de scripts (auth.js, api.js...) puedan actuar. */
  if (typeof global.location !== 'undefined') {
    run();
  }
})(typeof window !== 'undefined' ? window : globalThis);
