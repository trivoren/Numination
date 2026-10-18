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
  function setToken(t) { accessToken = t && String(t).trim() ? String(t).trim() : null; }
  function getToken() {
    if (accessToken) return accessToken;
    try {
      const raw = localStorage.getItem(CFG.storageKeys.session);
      if (!raw) return null;
      const s = JSON.parse(raw);
      const t = s.access_token || s.accessToken || null;
      if (t) accessToken = t;
      return t;
    } catch (_) { return null; }
  }
  function saveSession(session) {
    if (!session) { accessToken = null; localStorage.removeItem(CFG.storageKeys.session); return; }
    localStorage.setItem(CFG.storageKeys.session, JSON.stringify(session));
    setToken(session.access_token || session.accessToken || null);
  }
  function clearSession() { accessToken = null; try { localStorage.removeItem(CFG.storageKeys.session); } catch (_) {} }

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
    const timeoutMs = opts.timeoutMs || 35000;
    const retryable = !!opts.retryable;
    const maxAttempts = retryable ? 4 : 1;
    const delays = [1000, 2000, 4000];
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (cancelToken && cancelToken.isCancelled) throw new ApiRequestCancelled();
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
        if (e instanceof ApiRequestCancelled) throw e;
        if (e instanceof ApiException) {
          if (e.statusCode >= 400 && e.statusCode < 500 && e.statusCode !== 429) throw e;
          lastError = e;
        } else if (e && e.name === 'AbortError') {
          if (cancelToken && cancelToken.isCancelled) throw new ApiRequestCancelled();
          lastError = new ApiException(504, 'La solicitud tardó demasiado');
        } else {
          lastError = new ApiException(-1, 'Error de conexión');
        }
        if (retryable && attempt < maxAttempts - 1) {
          await new Promise(function (r) { setTimeout(r, delays[attempt]); });
          continue;
        }
        throw lastError;
      }
    }
    throw lastError || new ApiException(-1, 'Error de conexión');
  }

  async function* chatStream(body, cancelToken) {
    if (cancelToken && cancelToken.isCancelled) throw new ApiRequestCancelled();
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
      const ct = res.headers.get('content-type') || '';
      if (ct.indexOf('text/event-stream') === -1) {
        const data = await res.json().catch(function () { return {}; });
        yield { event: 'done', data: data };
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = 'message';
      let dataLines = [];
      while (true) {
        if (cancelToken && cancelToken.isCancelled) throw new ApiRequestCancelled();
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
              yield {
                event: eventName,
                data: payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload },
              };
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
    saveSession: saveSession,
    clearSession: clearSession,
    request: request,
    me: function () { return request('GET', '/auth/me', undefined, { retryable: true }); },
    updateMe: function (b) { return request('PATCH', '/auth/me', b); },
    confirmAge: function (b) { return request('POST', '/auth/confirm-age', b); },
    listChats: function () { return request('GET', '/chats', undefined, { retryable: true }); },
    createChat: function (b) { return request('POST', '/chats', b || {}); },
    updateChat: function (id, b) { return request('PATCH', '/chats/' + encodeURIComponent(id), b); },
    deleteChat: function (id) { return request('DELETE', '/chats/' + encodeURIComponent(id)); },
    getMessages: function (id) { return request('GET', '/chats/' + encodeURIComponent(id) + '/messages', undefined, { retryable: true }); },
    saveMessage: function (id, b) { return request('POST', '/chats/' + encodeURIComponent(id) + '/messages', b); },
    chat: function (b, o) { return request('POST', '/ai/chat', b, o); },
    chatStream: chatStream,
    coder: function (b, o) { return request('POST', '/ai/coder', b, o); },
    listProjects: function () { return request('GET', '/projects', undefined, { retryable: true }); },
    createProject: function (b) { return request('POST', '/projects', b); },
    projectFiles: function (id) { return request('GET', '/projects/' + encodeURIComponent(id) + '/files', undefined, { retryable: true }); },
    credits: function () { return request('GET', '/credits', undefined, { retryable: true }); },
    paymentPlans: function () { return request('GET', '/payments/plans', undefined, { retryable: true }); },
    createPayment: function (b) { return request('POST', '/payments/create', b); },
    creditsHistory: function () { return request('GET', '/credits/history', undefined, { retryable: true }); },
    memory: function () { return request('GET', '/memory', undefined, { retryable: true }); },
    saveMemory: function (b) { return request('POST', '/memory', b); },
    notifications: function () { return request('GET', '/notifications', undefined, { retryable: true }); },
    markNotifications: function (b) { return request('POST', '/notifications', b); },
    integrations: function () { return request('GET', '/integrations', undefined, { retryable: true }); },
    startIntegration: function (b) { return request('POST', '/integrations/start', b); },
    disconnectIntegration: function (b) { return request('POST', '/integrations/disconnect', b); },
    artifacts: function () { return request('GET', '/artifacts', undefined, { retryable: true }); },
    health: function () { return request('GET', '/health', undefined, { retryable: true }); },
    modes: function () { return request('GET', '/modes', undefined, { retryable: true }); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
