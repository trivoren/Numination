(function (global) {
  'use strict';
  var CFG = global.NuminationConfig;
  if (!CFG) { console.error('[api] falta config.js'); return; }

  function ApiException(statusCode, message, code) {
    var e = new Error(message);
    e.name = 'ApiException';
    e.statusCode = statusCode;
    e.code = code || null;
    return e;
  }

  var accessToken = null;

  function setToken(t) {
    accessToken = t && String(t).trim() ? String(t).trim() : null;
    try {
      if (accessToken) localStorage.setItem(CFG.storageKeys.apiToken, accessToken);
      else localStorage.removeItem(CFG.storageKeys.apiToken);
    } catch (_) {}
  }

  function getToken() {
    if (accessToken) return accessToken;
    try {
      var t = localStorage.getItem(CFG.storageKeys.apiToken);
      if (t) accessToken = t;
      return t;
    } catch (_) { return null; }
  }

  function clearSession() {
    accessToken = null;
    try { localStorage.removeItem(CFG.storageKeys.apiToken); } catch (_) {}
  }

  function headers(extra) {
    var h = new Headers(extra || {});
    h.set('Accept', 'application/json');
    if (!h.has('Content-Type')) h.set('Content-Type', 'application/json');
    var token = getToken();
    if (token) h.set('Authorization', 'Bearer ' + token);
    var key = CFG.supabasePublishableKey;
    if (key) h.set('apikey', key);
    return h;
  }

  function uri(path) {
    return CFG.apiBaseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path);
  }

  async function request(method, path, body, opts) {
    opts = opts || {};
    var timeoutMs = opts.timeoutMs || 30000;
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    try {
      var init = { method: method, headers: headers(), signal: controller.signal };
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body);
      var res = await fetch(uri(path), init);
      clearTimeout(timer);
      var data = {};
      var ct = res.headers.get('content-type') || '';
      if (ct.indexOf('json') !== -1) {
        try { data = await res.json(); } catch (_) { data = {}; }
      } else {
        var text = await res.text();
        try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
      }
      if (!res.ok) throw ApiException(res.status, String(data.error || data.message || res.statusText || 'Error'), data.code);
      return data;
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'ApiException') throw e;
      if (e && e.name === 'AbortError') throw ApiException(504, 'Timeout');
      throw ApiException(-1, 'Error de conexión');
    }
  }

  async function* chatStream(body) {
    var res = await fetch(uri('/ai/chat/stream'), {
      method: 'POST',
      headers: headers({ Accept: 'text/event-stream' }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      var data = {};
      try { data = await res.json(); } catch (_) {}
      throw ApiException(res.status, String(data.error || data.message || res.statusText));
    }
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var eventName = 'message';
    var dataLines = [];
    while (true) {
      var result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      var lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line === '') {
          if (dataLines.length) {
            var raw = dataLines.join('\n');
            var payload;
            try { payload = JSON.parse(raw); } catch (_) { payload = { raw: raw }; }
            yield { event: eventName, data: payload };
          }
          eventName = 'message';
          dataLines = [];
          continue;
        }
        if (line.indexOf('event:') === 0) eventName = line.slice(6).trim();
        else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
  }

  global.NuminationApi = {
    setToken: setToken,
    getToken: getToken,
    clearSession: clearSession,
    request: request,
    // Auth profile
    me: function () { return request('GET', '/auth/me'); },
    updateMe: function (b) { return request('PATCH', '/auth/me', b); },
    confirmAge: function (b) { return request('POST', '/auth/confirm-age', b); },
    // Chats
    listChats: function () { return request('GET', '/chats'); },
    createChat: function (b) { return request('POST', '/chats', b || {}); },
    getChat: function (id) { return request('GET', '/chats/' + encodeURIComponent(id)); },
    updateChat: function (id, b) { return request('PATCH', '/chats/' + encodeURIComponent(id), b); },
    deleteChat: function (id) { return request('DELETE', '/chats/' + encodeURIComponent(id)); },
    getMessages: function (id) { return request('GET', '/chats/' + encodeURIComponent(id) + '/messages'); },
    saveMessage: function (id, b) { return request('POST', '/chats/' + encodeURIComponent(id) + '/messages', b); },
    // AI
    chat: function (b) { return request('POST', '/ai/chat', b); },
    chatStream: chatStream,
    coder: function (b) { return request('POST', '/ai/coder', b); },
    modes: function () { return request('GET', '/modes'); },
    // Projects
    listProjects: function () { return request('GET', '/projects'); },
    createProject: function (b) { return request('POST', '/projects', b); },
    projectPreview: function (id) { return request('GET', '/projects/' + encodeURIComponent(id) + '/preview-link'); },
    projectDownload: function (id) { return request('GET', '/projects/' + encodeURIComponent(id) + '/download'); },
    projectUndo: function (id) { return request('POST', '/projects/' + encodeURIComponent(id) + '/undo'); },
    projectFiles: function (id) { return request('GET', '/projects/' + encodeURIComponent(id) + '/files'); },
    // Credits / payments
    credits: function () { return request('GET', '/credits'); },
    creditsHistory: function () { return request('GET', '/credits/history'); },
    paymentPlans: function () { return request('GET', '/payments/plans'); },
    createPayment: function (b) { return request('POST', '/payments/create', b); },
    // Memory
    memory: function () { return request('GET', '/memory'); },
    saveMemory: function (b) { return request('POST', '/memory', b); },
    deleteMemory: function (id) { return request('DELETE', '/memory/' + encodeURIComponent(id)); },
    // Notifications
    notifications: function () { return request('GET', '/notifications'); },
    markNotifications: function (b) { return request('POST', '/notifications', b); },
    // Integrations / connectors
    integrations: function () { return request('GET', '/integrations'); },
    startIntegration: function (b) { return request('POST', '/integrations/start', b); },
    disconnectIntegration: function (b) { return request('POST', '/integrations/disconnect', b); },
    // Artifacts
    artifacts: function () { return request('GET', '/artifacts'); },
    // Health
    health: function () { return request('GET', '/health'); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
