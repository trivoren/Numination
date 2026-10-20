(function (global) {
  'use strict';
  const CFG = global.NuminationConfig;
  const Api = global.NuminationApi;
  if (!CFG || !Api) { console.error('[auth] falta config o api'); return; }
  let supabase = null;

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
      location.replace('/login');
      return;
    }
    if (isBannedUnderage(session.user) || !isAgeConfirmed(session.user)) {
      location.replace('/confirm-age');
      return;
    }
    location.replace('/chat');
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

  async function signUp(email, password, meta) {
    const client = getClient();
    const result = await client.auth.signUp({
      email: String(email).trim(),
      password: String(password),
      options: { data: meta || {}, emailRedirectTo: CFG.authRedirectUrl },
    });
    if (result.error) throw result.error;
    return syncTokenFromSession((result.data && result.data.session) || null);
  }

  async function signInWithOAuth(provider) {
    const client = getClient();
    const result = await client.auth.signInWithOAuth({
      provider: provider,
      options: { redirectTo: CFG.authRedirectUrl, skipBrowserRedirect: false },
    });
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
    signOut: signOut,
    isAgeConfirmed: isAgeConfirmed,
    isBannedUnderage: isBannedUnderage,
    routeAfterAuth: routeAfterAuth,
  };
})(typeof window !== 'undefined' ? window : globalThis);
