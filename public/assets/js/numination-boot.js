/**
 * Numination · Modo Coder — BOOT
 * Núcleo mínimo compartido que necesita el Lote 1 para funcionar de forma
 * autónoma: (1) sistema de toasts accesible y (2) un bus de eventos temporal.
 * Cuando se cargue `ide-events.js` (Lote 3) sustituirá al bus de respaldo;
 * si ya existe, este archivo no lo toca. No tiene TODOs a futuro.
 */
(function () {
  'use strict';

  /* ────────────────────────────────────────────────────────────────
     TOASTS — única vía de notificación visual de errores/éxitos.
     API: NuminToast.show(message, kind, timeoutMs)
     kind: 'ok' | 'err' | 'info'
     Seguro por diseño: usa textContent (nunca innerHTML) → sin XSS.
     Accesible: el contenedor en coder.html tiene role="status"/aria-live.
     ──────────────────────────────────────────────────────────────── */
  const TOAST_KINDS = { ok: 'ok', error: 'err', err: 'err', info: 'info' };
  const DEFAULT_TIMEOUT = 4500;
  const MAX_TOASTS = 5;

  function buildToastEl(message, kind) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.dataset.kind = TOAST_KINDS[kind] || 'info';

    const body = document.createElement('div');
    body.className = 'toast__msg';
    body.textContent = String(message); // ← inmunidad a inyección de marcado

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast__btn';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Cerrar notificación');
    close.addEventListener('click', () => destroyToast(toast));

    toast.append(body, close);
    return toast;
  }

  function destroyToast(toast) {
    if (!toast.isConnected) return;
    toast.dataset.leaving = 'true';
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    // Red de seguridad por si animationend no dispara (pestaña oculta)
    setTimeout(() => toast.remove(), 400);
  }

  const NuminToast = {
    /**
     * Muestra una notificación visual.
     * @param {string} message Texto plano del mensaje.
     * @param {'ok'|'err'|'info'} [kind='info'] Naturaleza del aviso.
     * @param {number} [timeoutMs=4500] Milisegundos visible.
     * @returns {void}
     */
    show(message, kind, timeoutMs) {
      const stack = document.getElementById('toast-stack');
      if (!stack) { console.warn('[NuminToast] contenedor ausente:', message); return; }

      while (stack.children.length >= MAX_TOASTS) stack.firstElementChild.remove();
      const toast = buildToastEl(message, kind);
      stack.appendChild(toast);
      if (timeoutMs !== 0) {
        setTimeout(() => destroyToast(toast), Number(timeoutMs) || DEFAULT_TIMEOUT);
      }
    },
    ok(msg, ms) { this.show(msg, 'ok', ms); },
    error(msg, ms) { this.show(msg, 'err', ms); },
    info(msg, ms) { this.show(msg, 'info', ms); }
  };
  window.NuminToast = NuminToast;

  /* ────────────────────────────────────────────────────────────────
     BUS DE EVENTOS DE RESPALDO — misma interfaz que ide-events.js
     (on / off / once / emit) con eventos de dominio documentados:
       editor:change, editor:dirty, editor:saved, file:opened,
       file:save, tree:refresh, term:command
     Se sustituye por ide-events.js sin módificar a los emisores: si
     ya hay un bus activo, este archivo respeta el que exista.
     ──────────────────────────────────────────────────────────────── */
  if (!window.eventBus) {
    const handlers = new Map();

    window.eventBus = {
      /**
       * @param {string} evt
       * @param {(data: any) => void} fn
       */
      on(evt, fn) {
        if (!handlers.has(evt)) handlers.set(evt, new Set());
        handlers.get(evt).add(fn);
        return () => this.off(evt, fn);
      },
      /**
       * @param {string} evt
       * @param {(data: any) => void} fn
       */
      off(evt, fn) { handlers.get(evt)?.delete(fn); },
      /**
       * @param {string} evt
       * @param {(data: any) => void} fn
       */
      once(evt, fn) {
        const wrapped = (data) => { this.off(evt, wrapped); fn(data); };
        this.on(evt, wrapped);
      },
      /**
       * @param {string} evt
       * @param {any} [data]
       */
      emit(evt, data) {
        handlers.get(evt)?.forEach((fn) => {
          try { fn(data); }
          catch (err) { console.error(`[eventBus] listener de "${evt}" falló:`, err); }
        });
        // Compatibilidad: reflejar como CustomEvent del window
        window.dispatchEvent(new CustomEvent(`numination:${evt}`, { detail: data }));
      }
    };
    window.eventBusIsFallback = true;
  }
})();
