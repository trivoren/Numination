/**
 * Numination · payments-client.js · v1.0
 * ─────────────────────────────────────────────────────────────────────────
 * Wrapper de `fetch` para el checkout de pagos + notificaciones visuales.
 *
 * RESPONSABILIDADES:
 *  · Retry con backoff exponencial (máximo 3 intentos) SOLO ante fallos
 *    de red o respuestas transitorias (408/425/429/500/502/503/504).
 *    Nunca se reintenta un 4xx de negocio (400/401/403/409): reintentar
 *    un 409 (idempotencia) o un 401 solo genera carga y ambigüedad.
 *  · Validación de que la respuesta del backend sea JSON válido ANTES de
 *    parsearlo. Un HTML de error de un proxy (502 de nginx, página de
 *    mantenimiento) revienta `res.json()` con un error opaco; aquí se
 *    convierte en un error tipado y legible.
 *  · Timeout por intento con AbortController (nada de requests colgados).
 *  · `showToast(msg, type)` para feedback visual. Nunca usa `alert()`.
 *
 * DEPENDENCIAS: ninguna. Se expone como `window.NMPaymentsClient`.
 */

(function () {
  'use strict';

  /* ── Constantes de configuración ──────────────────────────────────── */
  const CONFIG = {
    MAX_ATTEMPTS: 3,              // intentos totales (1 original + 2 reintentos)
    BASE_DELAY_MS: 400,           // base del backoff exponencial
    MAX_DELAY_MS: 4000,           // techo del backoff
    JITTER_MS: 150,               // dispersión anti-thundering-herd
    DEFAULT_TIMEOUT_MS: 20000,    // timeout por intento
    RETRYABLE_STATUS: [408, 425, 429, 500, 502, 503, 504],
    TOAST_DURATION_MS: 4200,
    MAX_TOASTS: 4,
    MAX_BODY_BYTES: 1024 * 512,   // techo del body que aceptamos parsear
  };

  const TOAST_ICONS = {
    ok: '<polyline points="20 6 9 17 4 12"></polyline>',
    err: '<circle cx="12" cy="12" r="9"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line>',
    warn: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
    info: '<circle cx="12" cy="12" r="9"></circle><line x1="12" y1="11" x2="12" y2="16"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>',
  };

  /* ── Error normalizado ────────────────────────────────────────────── */
  class PaymentsApiError extends Error {
    constructor(message, status = 0, code = 'unknown', payload = null) {
      super(message);
      this.name = 'PaymentsApiError';
      this.status = status;
      this.code = code;
      this.payload = payload;
      this.isPaymentsError = true;
    }
  }

  /* ── Utilidades ───────────────────────────────────────────────────── */

  /**
   * Extrae el token CSRF si el backend lo expone. En este proyecto la
   * sesión vive en una cookie httpOnly, así que no hay token que mandar;
   * el hook existe para que, si mañana se adoptan cookies SameSite=None,
   * el cliente ya envíe el token sin reescribir el flujo.
   */
  function readCsrfToken() {
    try {
      const meta = document.querySelector('meta[name="csrf-token"]');
      return meta ? meta.getAttribute('content') : null;
    } catch (err) {
      return null;
    }
  }

  /**
   * Elimina claves peligrosas de un objeto parseado (`__proto__`,
   * `constructor`, `prototype`) para evitar contaminación de prototipos
   * si el backend devolviera un payload manipulado.
   */
  function stripUnsafeKeys(value, depth = 0) {
    if (depth > 8 || value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) {
      return value.map((item) => stripUnsafeKeys(item, depth + 1));
    }
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      out[key] = stripUnsafeKeys(value[key], depth + 1);
    }
    return out;
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function backoffDelay(attempt) {
    const base = Math.min(CONFIG.MAX_DELAY_MS, CONFIG.BASE_DELAY_MS * Math.pow(2, attempt - 1));
    const jitter = Math.floor(Math.random() * CONFIG.JITTER_MS);
    return base + jitter;
  }

  function isRetryableStatus(status) {
    return CONFIG.RETRYABLE_STATUS.indexOf(status) !== -1;
  }

  function isJsonContentType(contentType) {
    return typeof contentType === 'string'
      && (contentType.includes('application/json') || contentType.includes('+json'));
  }

  /**
   * Convierte un body de respuesta en JSON válido.
   * Falla de forma explícita (sin exceptions opacas) si:
   *   · el body está vacío,
   *   · el Content-Type no es JSON,
   *   · el JSON está malformado.
   */
  function parseJsonBody(text, contentType, status) {
    if (!text) {
      if (!status || (status >= 200 && status < 300)) return null;
      throw new PaymentsApiError(
        'El servidor devolvió una respuesta vacía.',
        status,
        'empty_response',
        null
      );
    }

    if (text.length > CONFIG.MAX_BODY_BYTES) {
      throw new PaymentsApiError(
        'La respuesta del servidor es demasiado grande.',
        status,
        'response_too_large',
        null
      );
    }

    if (!isJsonContentType(contentType)) {
      // Puede venir JSON sin header correcto: intentamos igual, pero si
      // tampoco parsea, el error dice exactamente qué pasó.
      try {
        return stripUnsafeKeys(JSON.parse(text));
      } catch {
        throw new PaymentsApiError(
          'El servidor no devolvió JSON válido.',
          status,
          'invalid_json',
          { contentType: contentType || null, preview: text.slice(0, 120) }
        );
      }
    }

    try {
      return stripUnsafeKeys(JSON.parse(text));
    } catch {
      throw new PaymentsApiError(
        'El servidor devolvió un JSON malformado.',
        status,
        'invalid_json',
        { contentType: contentType || null, preview: text.slice(0, 120) }
      );
    }
  }

  /* ── Cliente HTTP con retry ───────────────────────────────────────── */

  /**
   * Petición JSON con retry exponencial.
   *
   * @param {string} url
   * @param {object} [options]
   * @param {string} [options.method='GET']
   * @param {any}    [options.body]          Cuerpo (se serializa a JSON).
   * @param {object} [options.headers]
   * @param {number} [options.timeoutMs]
   * @param {AbortSignal} [options.signal]
   * @param {boolean}[options.silent]        No dispara toast automático.
   * @param {number} [options.retries]       Override del número de intentos.
   * @returns {Promise<any>} Payload parseado.
   */
  async function apiFetch(url, options = {}) {
    const {
      method = 'GET',
      body,
      headers = {},
      timeoutMs = CONFIG.DEFAULT_TIMEOUT_MS,
      signal,
      silent = false,
      retries = CONFIG.MAX_ATTEMPTS,
    } = options;

    if (typeof url !== 'string' || !url) {
      throw new PaymentsApiError('URL inválida.', 0, 'invalid_url', null);
    }

    const maxAttempts = Math.max(1, Math.min(CONFIG.MAX_ATTEMPTS, Number(retries) || CONFIG.MAX_ATTEMPTS));
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error('timeout')),
        timeoutMs
      );

      const onExternalAbort = () => controller.abort(signal && signal.reason);
      if (signal) {
        if (signal.aborted) onExternalAbort();
        else signal.addEventListener('abort', onExternalAbort, { once: true });
      }

      const init = {
        method,
        credentials: 'same-origin',   // cookie de sesión httpOnly
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          ...headers,
        },
        signal: controller.signal,
      };

      const csrf = readCsrfToken();
      if (csrf && !init.headers['X-CSRF-Token']) {
        init.headers['X-CSRF-Token'] = csrf;
      }

      if (body !== undefined && body !== null) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }

      try {
        const res = await fetch(url, init);
        const contentType = res.headers.get('content-type');
        const text = await res.text();

        let payload = null;
        try {
          payload = parseJsonBody(text, contentType, res.status);
        } catch (parseError) {
          // Respuesta no-JSON: no tiene sentido reintentar un 4xx.
          if (!res.ok && isRetryableStatus(res.status) && attempt < maxAttempts) {
            lastError = parseError;
            await sleep(backoffDelay(attempt), signal);
            continue;
          }
          if (!silent) showToast(parseError.message, 'err');
          throw parseError;
        }

        if (!res.ok) {
          const message = (payload && (payload.error || payload.message))
            || `Error ${res.status} del servidor.`;
          const code = (payload && payload.code) || 'http_error';

          if (isRetryableStatus(res.status) && attempt < maxAttempts) {
            lastError = new PaymentsApiError(message, res.status, code, payload);
            await sleep(backoffDelay(attempt), signal);
            continue;
          }

          if (!silent) showToast(message, 'err');
          throw new PaymentsApiError(message, res.status, code, payload);
        }

        return payload;
      } catch (err) {
        if (err instanceof PaymentsApiError) throw err;

        const aborted = err && (err.name === 'AbortError' || controller.signal.aborted);
        const isExternalAbort = signal && signal.aborted;
        const message = aborted && !isExternalAbort
          ? 'La operación tardó demasiado. Intentá de nuevo.'
          : 'No hay conexión con el servidor.';

        lastError = new PaymentsApiError(message, 0, aborted ? 'timeout' : 'network_error', null);

        if (isExternalAbort) throw lastError;

        if (attempt < maxAttempts) {
          await sleep(backoffDelay(attempt), signal);
          continue;
        }

        if (!silent) showToast(message, 'err');
        throw lastError;
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onExternalAbort);
      }
    }

    const finalError = lastError || new PaymentsApiError('Error de red.', 0, 'network_error', null);
    if (!silent) showToast(finalError.message, 'err');
    throw finalError;
  }

  /* ── Helpers de método ────────────────────────────────────────────── */
  function get(path, options) {
    return apiFetch(path, { ...(options || {}), method: 'GET' });
  }

  function post(path, body, options) {
    return apiFetch(path, { ...(options || {}), method: 'POST', body });
  }

  /* ── Toasts ───────────────────────────────────────────────────────── */

  function getToastHost() {
    let host = document.getElementById('nm-pay-toasts');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'nm-pay-toasts';
    host.className = 'nm-pay__toasts';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
    return host;
  }

  /**
   * Muestra un toast. Reutiliza el sistema global `NuminToast` si existe
   * (consistencia visual con el resto de la app) y, si no, usa su propia
   * implementación aislada en payments.css.
   *
   * @param {string} msg
   * @param {'ok'|'err'|'warn'|'info'} [type='info']
   * @param {number} [duration]
   */
  function showToast(msg, type, duration) {
    const text = String(msg == null ? '' : msg);
    const kind = ['ok', 'err', 'warn', 'info'].indexOf(type) !== -1 ? type : 'info';

    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      try {
        window.NuminToast.show(text, kind);
        return null;
      } catch {
        // Si el toast global falla, caemos a la implementación propia.
      }
    }

    if (typeof document === 'undefined' || !document.body) return null;

    const host = getToastHost();

    // Tope de toasts simultáneos (evita apilar 10 avisos).
    while (host.children.length >= CONFIG.MAX_TOASTS) {
      host.removeChild(host.firstElementChild);
    }

    const toast = document.createElement('div');
    toast.className = 'nm-pay__toast';
    toast.setAttribute('data-nm-pay-toast-type', kind);
    toast.setAttribute('data-nm-pay-toast-state', 'out');

    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'nm-pay__toast-icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = TOAST_ICONS[kind] || TOAST_ICONS.info;

    const body = document.createElement('div');
    body.className = 'nm-pay__toast-text';
    body.textContent = text;   // textContent: nunca innerHTML con datos

    toast.appendChild(icon);
    toast.appendChild(body);
    host.appendChild(toast);

    // Pinta el toast (la transition necesita un reflow previo).
    requestAnimationFrame(() => {
      toast.setAttribute('data-nm-pay-toast-state', 'in');
    });

    const ms = Number(duration) > 0 ? Number(duration) : CONFIG.TOAST_DURATION_MS;
    setTimeout(() => {
      toast.setAttribute('data-nm-pay-toast-state', 'out');
      setTimeout(() => {
        if (toast.parentNode === host) host.removeChild(toast);
      }, 260);
    }, ms);

    return toast;
  }

  /* ── Export ───────────────────────────────────────────────────────── */
  window.NMPaymentsClient = Object.freeze({
    apiFetch,
    get,
    post,
    showToast,
    PaymentsApiError,
    CONFIG,
  });
})();
