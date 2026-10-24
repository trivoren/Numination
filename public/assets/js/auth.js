(function (global) {
  'use strict';
  const CFG = global.NuminationConfig;
  const Api = global.NuminationApi;
  if (!CFG || !Api) { console.error('[auth] falta config o api'); return; }
  let supabase = null;

  /* ═══════════════════════════════════════════════════════════════════════
     REGLA DURA · URL DE REDIRECCIÓN DE SUPABASE AUTH

     Todo callback de Supabase (Google, GitHub, confirmación de email,
     recuperación de contraseña) debe volver SIEMPRE a un origen http(s)
     de esta misma web. Nunca a un esquema personalizado (`numination://`),
     porque el navegador responde "scheme does not have a registered
     handler" y el usuario queda atascado en el login.

     Destino único e innegociable: window.location.origin + '/chat.html'
     ═══════════════════════════════════════════════════════════════════════ */
  const CHAT_PATH = '/chat.html';

  function getRedirectUrl() {
    try {
      const origin = global.location && global.location.origin;
      if (origin && /^https?:\/\//i.test(origin)) return origin + CHAT_PATH;
    } catch (_) {}
    // Fallback relativo: nunca devuelve un esquema no http(s).
    return CHAT_PATH;
  }

  function getClient() {
    if (supabase) return supabase;
    var lib = global.supabase;
    if (!lib || typeof lib.createClient !== 'function') {
      throw new Error('Supabase JS no cargó. Revisa la red / CDN.');
    }
    supabase = lib.createClient(CFG.supabaseUrl, CFG.supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: CFG.storageKeys.supabaseAuth,
      },
    });
    return supabase;
  }

  function userMeta(user) {
    if (!user) return {};
    return user.user_metadata || user.userMetadata || {};
  }

  function isAgeConfirmed(user) {
    var m = userMeta(user);
    return m.age_14_plus === true || m.age_14_plus === 'true';
  }

  function isBannedUnderage(user) {
    var m = userMeta(user);
    return m.banned_underage === true || m.banned_underage === 'true';
  }

  /** Ruta post-login igual que nextScreenAfterAuth en Flutter */
  function routeAfterAuth(session) {
    if (!session || !session.user) {
      location.replace('/login.html');
      return;
    }
    if (isBannedUnderage(session.user) || !isAgeConfirmed(session.user)) {
      location.replace('/confirm-age.html');
      return;
    }
    location.replace(CFG.postLoginPath || '/chat.html');
  }

  async function syncTokenFromSession(session) {
    if (session && session.access_token) {
      Api.setToken(session.access_token);
      return session;
    }
    Api.clearSession();
    return null;
  }

  async function getSession() {
    const client = getClient();
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    return syncTokenFromSession((result.data && result.data.session) || null);
  }

  async function signInWithPassword(email, password) {
    const client = getClient();
    const result = await client.auth.signInWithPassword({
      email: String(email).trim(),
      password: String(password),
    });
    if (result.error) throw result.error;
    return syncTokenFromSession((result.data && result.data.session) || null);
  }

  /**
   * Alta de cuenta. El email de confirmación vuelve a
   * window.location.origin + '/chat.html' (nunca a un esquema custom).
   */
  async function signUp(email, password, meta) {
    const client = getClient();
    const result = await client.auth.signUp({
      email: String(email).trim(),
      password: String(password),
      options: {
        data: meta || {},
        emailRedirectTo: getRedirectUrl(),
      },
    });
    if (result.error) throw result.error;
    return syncTokenFromSession((result.data && result.data.session) || null);
  }

  /**
   * Google / GitHub. `redirectTo` SIEMPRE es origin + '/chat.html':
   * si la URL no estuviera en la allow-list de Supabase, el proyecto
   * redirigía al Site URL (`numination://`) y el navegador fallaba con
   * "scheme does not have a registered handler".
   */
  async function signInWithOAuth(provider) {
    const client = getClient();
    const result = await client.auth.signInWithOAuth({
      provider: provider,
      options: {
        redirectTo: getRedirectUrl(),
        skipBrowserRedirect: false,
      },
    });
    if (result.error) throw result.error;
    return result.data;
  }

  /**
   * Recuperación de contraseña. El enlace de recuperación vuelve a
   * window.location.origin + '/chat.html' con el token en el hash; el
   * escudo de auth-callback.js lo intercepta y abre la sesión.
   */
  async function resetPasswordForEmail(email, options) {
    const client = getClient();
    const opts = options || {};
    const result = await client.auth.resetPasswordForEmail(String(email).trim(), {
      redirectTo: opts.redirectTo || getRedirectUrl(),
    });
    if (result.error) throw result.error;
    return result.data;
  }

  /** Cambio de contraseña desde una sesión de recuperación. */
  async function updatePassword(newPassword) {
    const client = getClient();
    const result = await client.auth.updateUser({ password: String(newPassword) });
    if (result.error) throw result.error;
    return result.data;
  }

  async function signOut() {
    try {
      const client = getClient();
      await client.auth.signOut();
    } catch (_) {}
    Api.clearSession();
  }

  global.NuminationAuth = {
    getClient: getClient,
    getSession: getSession,
    signInWithPassword: signInWithPassword,
    signUp: signUp,
    signInWithOAuth: signInWithOAuth,
    resetPasswordForEmail: resetPasswordForEmail,
    updatePassword: updatePassword,
    signOut: signOut,
    isAgeConfirmed: isAgeConfirmed,
    isBannedUnderage: isBannedUnderage,
    routeAfterAuth: routeAfterAuth,
    getRedirectUrl: getRedirectUrl,
  };
})(typeof window !== 'undefined' ? window : globalThis);
