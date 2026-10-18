(function (global) {
  'use strict';
  const CFG = global.NuminationConfig;
  if (!CFG) { console.error('[api] falta config.js'); return; }

  class ApiException extends Error {
    constructor(statusCode, message, code) {
      super(message);
      this.name = 'ApiException';
      this.statusCode = statusCode;
      this.code = code || null;
    }
  }
  class ApiRequestCancelled extends Error {
    constructor() { super('ApiRequestCancelled'); this.name = 'ApiRequestCancelled'; }
  }
  class ApiCancelToken {
    constructor() { this._cancelled = false; this._controller = null; }
    get isCancelled() { return this._cancelled; }
    cancel() { if (this._cancelled) return; this._cancelled = true; if (this._controller) this._controller.abort(); this._controller = null; }
    attach(c) { if (this._cancelled) c.abort(); else this._controller = c; }
    detach(c) { if (this._controller === c) this._controller = null; }
  }

  let accessToken = null;

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
      const t = localStorage.getItem(CFG.storageKeys.apiToken);
      if (t) accessToken = t;
      return t;
    } catch (_) { return null; }
  }

  function clearSession() {
    accessToken = null;
    try { localStorage.removeItem(CFG.storageKeys.apiToken); } catch (_) {}
  }

  function headers(extra) {
    const h = new Headers(extra || {});
    h.set('Accept', 'application/json');
    if (!h.has('Content-Type')) h.set('Content-Type', 'application/json');
    const token = getToken();
    if (token) h.set('Authorization', 'Bearer ' + token);
    const key = CFG.supabasePublishableKey;
    if (key) h.set('apikey', key);
    return h;
  }

  function uri(path) {
    const base = CFG.apiBaseUrl.replace(/\/+$/, '');
    return base + (path.startsWith('/') ? path : '/' + path);
  }

  async function request(method, path, body, opts) {
    opts = opts || {};
    const cancelToken = opts.cancelToken;
    const timeoutMs = opts.timeoutMs || 25000;
    const controller = new AbortController();
    if (cancelToken) cancelToken.attach(controller);
    const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    try {
      const init = { method: method, headers: headers(), signal: controller.signal };
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') init.body = JSON.stringify(body);
      const res = await fetch(uri(path), init);
      clearTimeout(timer);
      if (cancelToken) cancelToken.detach(controller);
      let data = {};
      const ct = res.headers.get('content-type') || '';
      if (ct.indexOf('application/json') !== -1) {
        try { data = await res.json(); } catch (_) { data = {}; }
      } else {
        const text = await res.text();
        try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
      }
      if (!res.ok) throw new ApiException(res.status, String(data.error || data.message || res.statusText || 'Error'), data.code || null);
      return data;
    } catch (e) {
      clearTimeout(timer);
      if (cancelToken) cancelToken.detach(controller);
      if (e instanceof ApiException) throw e;
      if (e && e.name === 'AbortError') {
        if (cancelToken && cancelToken.isCancelled) throw new ApiRequestCancelled();
        throw new ApiException(504, 'La solicitud tardó demasiado');
      }
      throw new ApiException(-1, 'Error de conexión');
    }
  }

  async function* chatStream(body, cancelToken) {
    const controller = new AbortController();
    if (cancelToken) cancelToken.attach(controller);
    try {
      const res = await fetch(uri('/ai/chat/stream'), {
        method: 'POST',
        headers: headers({ Accept: 'text/event-stream' }),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        let data = {};
        try { data = await res.json(); } catch (_) {}
        throw new ApiException(res.status, String(data.error || data.message || res.statusText), data.code);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = 'message';
      let dataLines = [];
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || '';
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (line === '') {
            if (dataLines.length) {
              const raw = dataLines.join('\n');
              let payload;
              try { payload = JSON.parse(raw); } catch (_) { payload = { raw: raw }; }
              yield { event: eventName, data: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload } };
            }
            eventName = 'message';
            dataLines = [];
            continue;
          }
          if (line.indexOf('event:') === 0) eventName = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
    } finally {
      if (cancelToken) cancelToken.detach(controller);
    }
  }

  global.NuminationApi = {
    ApiException: ApiException,
    ApiRequestCancelled: ApiRequestCancelled,
    ApiCancelToken: ApiCancelToken,
    setToken: setToken,
    getToken: getToken,
    clearSession: clearSession,
    request: request,
    me: function () { return request('GET', '/auth/me'); },
    updateMe: function (b) { return request('PATCH', '/auth/me', b); },
    listChats: function () { return request('GET', '/chats'); },
    createChat: function (b) { return request('POST', '/chats', b || {}); },
    updateChat: function (id, b) { return request('PATCH', '/chats/' + encodeURIComponent(id), b); },
    deleteChat: function (id) { return request('DELETE', '/chats/' + encodeURIComponent(id)); },
    getMessages: function (id) { return request('GET', '/chats/' + encodeURIComponent(id) + '/messages'); },
    saveMessage: function (id, b) { return request('POST', '/chats/' + encodeURIComponent(id) + '/messages', b); },
    chat: function (b) { return request('POST', '/ai/chat', b); },
    chatStream: chatStream,
    coder: function (b) { return request('POST', '/ai/coder', b); },
    listProjects: function () { return request('GET', '/projects'); },
    createProject: function (b) { return request('POST', '/projects', b); },
    projectFiles: function (id) { return request('GET', '/projects/' + encodeURIComponent(id) + '/files'); },
    credits: function () { return request('GET', '/credits'); },
    paymentPlans: function () { return request('GET', '/payments/plans'); },
    createPayment: function (b) { return request('POST', '/payments/create', b); },
    creditsHistory: function () { return request('GET', '/credits/history'); },
    memory: function () { return request('GET', '/memory'); },
    saveMemory: function (b) { return request('POST', '/memory', b); },
    notifications: function () { return request('GET', '/notifications'); },
    integrations: function () { return request('GET', '/integrations'); },
    artifacts: function () { return request('GET', '/artifacts'); },
    health: function () { return request('GET', '/health'); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
