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
    // Destino de los callbacks de Supabase Auth (OAuth, confirmación de
    // email, recuperación de contraseña).
    // REGLA DURA: origin + '/chat.html'. Nunca '/login' (ruta sin extensión
    // que dependía de cleanUrls/extensions del servidor) y nunca un esquema
    // personalizado (`numination://` → "scheme does not have a registered
    // handler" en el navegador).
    authRedirectUrl: (typeof location !== 'undefined' ? location.origin + '/chat.html' : '/chat.html'),
    // Destino post-login: SIEMPRE el fichero real '/chat.html'.
    // Las rutas sin extensión ('/chat') dependen de que el servidor de
    // estáticos resuelva la extensión implícita (express.static
    // 'extensions' en local, cleanUrls en Vercel); si no la resuelve,
    // '/chat' cae en el 404 o en la app por defecto en vez de abrir el chat.
    postLoginPath: '/chat.html',
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
