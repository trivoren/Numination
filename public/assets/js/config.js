(function (global) {
  'use strict';
  const SUPABASE_URL = 'https://whxqciwphwgzcshejpty.supabase.co';
  const API_BASE_URL = SUPABASE_URL + '/functions/v1/api';
  const UPDATER_BASE_URL = SUPABASE_URL + '/functions/v1/numination-updater';
  const DEFAULT_PUBLISHABLE_KEY = 'sb_publishable_mrKTw0QGiuikjTb6SY0Hgg_Nak0QLk7';

  function readPublishableKey() {
    try {
      const meta = document.querySelector('meta[name="supabase-publishable-key"]');
      if (meta && meta.content && meta.content.trim()) return meta.content.trim();
    } catch (_) {}
    return DEFAULT_PUBLISHABLE_KEY;
  }

  global.NuminationConfig = Object.freeze({
    supabaseUrl: SUPABASE_URL,
    apiBaseUrl: API_BASE_URL,
    updaterBaseUrl: UPDATER_BASE_URL,
    get supabasePublishableKey() { return readPublishableKey(); },
    authRedirectUrl: (typeof location !== 'undefined' ? location.origin + '/login' : ''),
    appVersion: '1.0.0',
    // IMPORTANTE: no reutilizar la misma key que supabase.auth (rompe getSession)
    storageKeys: {
      supabaseAuth: 'sb-numination-auth',
      apiToken: 'numination-api-token',
      theme: 'numination-theme',
      prefs: 'numination-prefs',
    },
  });
})(typeof window !== 'undefined' ? window : globalThis);
