(function (global) {
  'use strict';
  const CFG = global.NuminationConfig;
  const Api = global.NuminationApi;
  if (!CFG || !Api) { console.error('[auth] falta config o api'); return; }
  let supabase = null;

  function getClient() {
    if (supabase) return supabase;
    if (!global.supabase || !global.supabase.createClient) {
      throw new Error('Carga @supabase/supabase-js antes de auth.js');
    }
    const key = CFG.supabasePublishableKey;
    supabase = global.supabase.createClient(CFG.supabaseUrl, key || 'missing-key', {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        storageKey: CFG.storageKeys.session,
      },
    });
    return supabase;
  }

  async function syncSessionToApi() {
    const client = getClient();
    const result = await client.auth.getSession();
    if (result.error) throw result.error;
    const session = (result.data && result.data.session) || null;
    if (session) {
      Api.saveSession({
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_at: session.expires_at,
        user: session.user,
      });
      Api.setToken(session.access_token);
    } else {
      Api.clearSession();
    }
    return session;
  }

  async function getSession() { return syncSessionToApi(); }

  async function signInWithPassword(email, password) {
    const client = getClient();
    const result = await client.auth.signInWithPassword({ email: String(email).trim(), password: String(password) });
    if (result.error) throw result.error;
    await syncSessionToApi();
    return result.data;
  }

  async function signUp(email, password, meta) {
    const client = getClient();
    const result = await client.auth.signUp({
      email: String(email).trim(),
      password: String(password),
      options: { data: meta || {}, emailRedirectTo: CFG.authRedirectUrl },
    });
    if (result.error) throw result.error;
    await syncSessionToApi();
    return result.data;
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
    const client = getClient();
    await client.auth.signOut();
    Api.clearSession();
  }

  global.NuminationAuth = {
    getClient: getClient,
    getSession: getSession,
    syncSessionToApi: syncSessionToApi,
    signInWithPassword: signInWithPassword,
    signUp: signUp,
    signInWithOAuth: signInWithOAuth,
    signOut: signOut,
    me: async function () { await syncSessionToApi(); return Api.me(); },
    requireAuth: async function (loginPath) {
      const session = await getSession();
      if (!session) { location.replace(loginPath || '/login'); return null; }
      return session;
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
