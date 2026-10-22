/**
 * Numination · Modo Coder — api-client.js
 * Wrapper único de `fetch` para el frontend del IDE.
 *
 * Responsabilidades:
 *  - Inyectar la sesión (cookies httpOnly) sin manipular tokens a mano.
 *  - Normalizar errores (status + code + mensaje) en una única clase.
 *  - Timeouts con AbortController (nada de requests colgados).
 *  - Parseo de SSE sobre `ReadableStream` (el chat necesita el token a token).
 *  - Notificación visual opcional (toast) en cada fallo.
 */

(function () {
  'use strict';

  /** Timeout por defecto para peticiones JSON (ms). */
  const DEFAULT_TIMEOUT_MS = 30_000;
  /** Timeout del primer byte en streams SSE (ms). */
  const STREAM_IDLE_TIMEOUT_MS = 60_000;

  /**
   * Error normalizado de la API.
   */
  class ApiError extends Error {
    /**
     * @param {string} message
     * @param {number} status
     * @param {string} code
     * @param {any} payload
     */
    constructor(message, status = 0, code = 'unknown', payload = null) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.payload = payload;
    }
  }

  /**
   * Notifica al usuario (si el módulo de toasts está cargado).
   * @param {string} message
   * @param {'ok'|'err'|'info'} kind
   */
  function notify(message, kind) {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
    } else {
      console.warn('[api-client]', kind, message);
    }
  }

  /**
   * Petición JSON con timeout, sesión y errores normalizados.
   * @param {string} url
   * @param {{method?:string, body?:any, headers?:Record<string,string>, timeoutMs?:number, signal?:AbortSignal, silent?:boolean, raw?:boolean}} [options]
   * @returns {Promise<any>}
   */
  async function request(url, options = {}) {
    const {
      method = 'GET',
      body,
      headers = {},
      timeoutMs = DEFAULT_TIMEOUT_MS,
      signal,
      silent = false,
      raw = false
    } = options;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const onExternalAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    const init = {
      method,
      credentials: 'same-origin', // cookie de sesión httpOnly
      headers: { Accept: 'application/json', ...headers },
      signal: controller.signal
    };
    if (body !== undefined && body !== null) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      const aborted = err?.name === 'AbortError';
      const message = aborted
        ? 'La operación se canceló o excedió el tiempo de espera.'
        : 'No hay conexión con el servidor.';
      if (!silent) notify(message, 'err');
      throw new ApiError(message, 0, aborted ? 'timeout' : 'network_error', null);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }

    if (raw) {
      if (!res.ok) {
        if (!silent) notify(`Error ${res.status} del servidor.`, 'err');
        throw new ApiError(`HTTP ${res.status}`, res.status, 'http_error', null);
      }
      return res;
    }

    let payload = null;
    const text = await res.text();
    if (text) {
      try { payload = JSON.parse(text); }
      catch { payload = { raw: text }; }
    }

    if (!res.ok) {
      const message = payload?.error || payload?.message || `Error ${res.status}`;
      const code = payload?.code || 'http_error';
      if (!silent) notify(message, 'err');
      throw new ApiError(message, res.status, code, payload);
    }

    return payload;
  }

  /**
   * GET JSON.
   * @param {string} path
   * @param {object} [options]
   * @returns {Promise<any>}
   */
  function get(path, options) { return request(path, { ...options, method: 'GET' }); }

  /**
   * POST JSON.
   * @param {string} path
   * @param {any} body
   * @param {object} [options]
   * @returns {Promise<any>}
   */
  function post(path, body, options) { return request(path, { ...options, method: 'POST', body }); }

  /**
   * Consume un endpoint SSE usando `fetch` + `ReadableStream`.
   * El servidor envía `data: {json}\n\n`; los comentarios `: keepalive` se ignoran.
   *
   * @param {string} path
   * @param {{body?:any, headers?:Record<string,string>, signal?:AbortSignal,
   *          onEvent?:(evt:any)=>void, onOpen?:(res:Response)=>void,
   *          onError?:(err:Error)=>void, onDone?:()=>void, silent?:boolean}} options
   * @returns {Promise<void>}
   */
  async function stream(path, options = {}) {
    const {
      body,
      headers = {},
      signal,
      onEvent,
      onOpen,
      onError,
      onDone,
      silent = false
    } = options;

    const controller = new AbortController();
    const onExternalAbort = () => controller.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let res;
    try {
      res = await fetch(path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', ...headers },
        body: JSON.stringify(body ?? {}),
        signal: controller.signal
      });
    } catch (err) {
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      const aborted = err?.name === 'AbortError';
      const message = aborted ? 'Stream cancelado.' : 'No se pudo conectar con el modelo.';
      if (!silent) notify(message, 'err');
      if (onError) onError(new ApiError(message, 0, aborted ? 'aborted' : 'network_error'));
      else throw new ApiError(message, 0, 'network_error');
      return;
    }

    if (onOpen) onOpen(res);

    if (!res.ok || !res.body) {
      let payload = null;
      try { payload = await res.json(); } catch { /* sin cuerpo JSON */ }
      const message = payload?.error || `El servidor rechazó la petición (${res.status}).`;
      if (!silent) notify(message, 'err');
      if (onError) onError(new ApiError(message, res.status, payload?.code || 'http_error', payload));
      else throw new ApiError(message, res.status, 'http_error', payload);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let idleTimer = setTimeout(() => controller.abort(new Error('idle')), STREAM_IDLE_TIMEOUT_MS);

    /** Procesa un bloque SSE completo y emite los eventos. */
    const flushBlock = (block) => {
      const lines = block.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data:')) continue; // comentarios/keepalive/eventos ignorados
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const parsed = JSON.parse(data);
          if (onEvent) onEvent(parsed);
        } catch {
          // Dato no-JSON: se reenvía como texto plano para no perderlo
          if (onEvent) onEvent({ type: 'raw', text: data });
        }
      }
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(new Error('idle')), STREAM_IDLE_TIMEOUT_MS);

        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          flushBlock(block);
        }
      }
      if (buffer.trim()) flushBlock(buffer);
    } catch (err) {
      if (onError) onError(err instanceof Error ? err : new Error(String(err)));
      else throw err;
    } finally {
      clearTimeout(idleTimer);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
      if (onDone) onDone();
    }
  }

  const NumAPI = { request, get, post, stream, ApiError, DEFAULT_TIMEOUT_MS };
  window.NumAPI = NumAPI;
  window.NumerationApi = NumAPI;
})();
