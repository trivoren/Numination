(function (global) {
  'use strict';
  var THEMES = ['gray', 'light', 'dark', 'midnight'];

  function initTheme() {
    var t = 'gray';
    try { t = localStorage.getItem('numination-theme') || 'gray'; } catch (_) {}
    if (THEMES.indexOf(t) === -1) t = 'gray';
    document.documentElement.dataset.theme = t;
    return t;
  }

  function applyTheme(t) {
    if (THEMES.indexOf(t) === -1) return;
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem('numination-theme', t); } catch (_) {}
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (r) { setTimeout(function () { r(null); }, ms); })]);
  }

  async function requireSession(loginPath) {
    loginPath = loginPath || '/login';
    try { localStorage.removeItem('numination-supabase-session'); } catch (_) {}
    if (!global.NuminationAuth) {
      location.replace(loginPath);
      return null;
    }
    var session = null;
    try {
      session = await withTimeout(global.NuminationAuth.getSession(), 4000);
    } catch (_) {
      session = null;
    }
    if (!session) {
      var tok = null;
      try { tok = localStorage.getItem('numination-api-token'); } catch (_) {}
      if (!tok) {
        location.replace(loginPath);
        return null;
      }
      return { user: { email: 'usuario' } };
    }
    return session;
  }

  function pageStyles() {
    return [
      '*{box-sizing:border-box;margin:0;padding:0}',
      'body{font-family:Inter,system-ui,sans-serif;background:var(--bg);color:var(--text-primary);min-height:100dvh}',
      '.page-bar{display:flex;align-items:center;gap:8px;padding:12px 12px;border-bottom:1px solid var(--border)}',
      '.page-bar a{width:40px;height:40px;display:flex;align-items:center;justify-content:center;border-radius:50%;color:inherit;text-decoration:none}',
      '.page-bar a:hover{background:var(--surface-alt)}',
      '.page-bar h1{font-size:18px;font-weight:600;flex:1}',
      '.page-body{max-width:720px;margin:0 auto;padding:16px}',
      '.card{background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:16px;margin-bottom:12px}',
      '.muted{color:var(--text-secondary);font-size:13px}',
      '.list-item{display:block;padding:14px 0;border-bottom:1px solid var(--border);color:inherit;text-decoration:none}',
      '.btn{display:inline-flex;align-items:center;justify-content:center;height:44px;padding:0 18px;border:none;border-radius:14px;background:var(--accent);color:#fff;font-weight:600;cursor:pointer;text-decoration:none}',
      '.empty{text-align:center;padding:40px 16px;color:var(--text-secondary)}',
      '.row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.badge{font-weight:700;color:var(--accent)}',
    ].join('');
  }

  global.NuminationShell = {
    THEMES: THEMES,
    initTheme: initTheme,
    applyTheme: applyTheme,
    requireSession: requireSession,
    withTimeout: withTimeout,
    pageStyles: pageStyles,
  };
})(typeof window !== 'undefined' ? window : globalThis);
