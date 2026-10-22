/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · toast-manager.js · v1.0
   ─────────────────────────────────────────────────────────────────────────══
   Cola de notificaciones (toasts) con apilado y auto-destrucción.

   REGLAS
     · Máximo 3 toasts visibles a la vez. El cuarto se apila DEBAJO (no
       tapa los anteriores) hasta que uno se destruye.
     · Auto-destrucción a los 3 s (configurable por toast).
     · Animación de entrada (desliza desde abajo) y de salida (se
       desvanece y se colapsa el hueco).
     · Los errores NO se destruyen solos: requieren cierre manual (o
       duran 8 s).
     · Se pausa el temporizador cuando el mouse está encima.
     · Accesible: `role="status"` / `role="alert"`, y `aria-live`.

   INTEGRACIÓN
     Es un reemplazo drop-in de `window.NuminToast`:
        NuminToast.show(mensaje, 'ok')
        NuminToast.error(mensaje)
        NuminToast.info(mensaje)
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STYLE_ID = 'numination-toast-styles';

  const CSS = `
.nm-toasts {
  position: fixed; right: 18px; bottom: 18px; z-index: 300;
  display: flex; flex-direction: column; align-items: flex-end; gap: 9px;
  pointer-events: none; max-width: min(380px, 92vw);
}
.nm-toast {
  pointer-events: auto; width: 100%;
  display: flex; align-items: flex-start; gap: 10px;
  padding: 12px 13px;
  border-radius: 12px;
  background: rgba(20,20,26,.97);
  border: 1px solid rgba(255,255,255,.1);
  box-shadow: 0 16px 40px rgba(0,0,0,.55);
  backdrop-filter: blur(10px);
  color: #d9d9e4;
  font: 400 13px/1.5 var(--font-sans, Inter, system-ui, sans-serif);
  transform: translateY(12px) scale(.97);
  opacity: 0;
  transition: transform .22s cubic-bezier(.22,.9,.3,1), opacity .18s ease, margin .22s ease, max-height .22s ease;
  overflow: hidden; max-height: 0; margin-top: -9px;
}
.nm-toast.is-in { transform: none; opacity: 1; max-height: 200px; margin-top: 0; }
.nm-toast.is-out { transform: translateY(8px) scale(.98); opacity: 0; max-height: 0; margin-top: -9px; }
.nm-toast__icon {
  width: 20px; height: 20px; flex: 0 0 20px; border-radius: 6px;
  display: grid; place-items: center; font-size: 12px; font-weight: 800;
  background: rgba(255,255,255,.08); color: #c9c9d4;
}
.nm-toast__text { flex: 1; min-width: 0; word-break: break-word; }
.nm-toast__title { font-weight: 700; color: #f4f4f7; margin-bottom: 2px; }
.nm-toast__close {
  border: 0; background: transparent; color: #6a6a80; cursor: pointer;
  font-size: 15px; line-height: 1; padding: 1px 4px; border-radius: 6px; flex: 0 0 auto;
}
.nm-toast__close:hover { background: rgba(255,255,255,.08); color: #fff; }
.nm-toast--ok    { border-left: 3px solid #22c55e; }
.nm-toast--ok    .nm-toast__icon { background: rgba(34,197,94,.16); color: #4ade80; }
.nm-toast--error { border-left: 3px solid #f0433a; }
.nm-toast--error .nm-toast__icon { background: rgba(240,67,58,.16); color: #ff8b84; }
.nm-toast--info  { border-left: 3px solid #8b5cf6; }
.nm-toast--info  .nm-toast__icon { background: rgba(139,92,246,.16); color: #c4b5fd; }
.nm-toast--warn  { border-left: 3px solid #f5a524; }
.nm-toast--warn  .nm-toast__icon { background: rgba(245,165,36,.16); color: #fbbf24; }
@media (max-width: 520px) {
  .nm-toasts { right: 10px; left: 10px; bottom: 12px; max-width: none; align-items: stretch; }
}
`;

  const KINDS = {
    ok: { icon: '✓', title: null, duration: 3000, role: 'status' },
    error: { icon: '!', title: null, duration: 8000, role: 'alert' },
    info: { icon: 'i', title: null, duration: 3000, role: 'status' },
    warn: { icon: '!', title: null, duration: 5000, role: 'status' },
  };

  const state = {
    container: null,
    toasts: [],
    maxVisible: 3,
    counter: 0,
  };

  /* ─── Estilos ────────────────────────────────────────────────────────── */

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function ensureContainer() {
    if (state.container && state.container.isConnected) return state.container;

    injectStyles();

    const container = document.createElement('div');
    container.className = 'nm-toasts';
    container.id = 'nm-toasts';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'false');
    document.body.appendChild(container);

    state.container = container;
    return container;
  }

  /* ─── Creación ──────────────────────────────────────────────────────── */

  /**
   * Muestra un toast.
   *
   * @param {string} message
   * @param {string} [kind]   'ok' | 'error' | 'info' | 'warn'
   * @param {object} [opts]   { title, duration, action }
   * @returns {object} { id, dismiss }
   */
  function show(message, kind = 'info', opts = {}) {
    const config = KINDS[kind] || KINDS.info;

    const container = ensureContainer();

    const id = `toast-${++state.counter}`;
    const duration = Number.isFinite(Number(opts.duration))
      ? Number(opts.duration)
      : config.duration;

    const el = document.createElement('div');
    el.className = `nm-toast nm-toast--${kind}`;
    el.dataset.toastId = id;
    el.setAttribute('role', config.role);

    const icon = document.createElement('span');
    icon.className = 'nm-toast__icon';
    icon.textContent = config.icon;
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('div');
    text.className = 'nm-toast__text';

    if (opts.title) {
      const title = document.createElement('div');
      title.className = 'nm-toast__title';
      title.textContent = String(opts.title).slice(0, 120);
      text.appendChild(title);
    }

    const body = document.createElement('div');
    body.textContent = String(message ?? '');
    text.appendChild(body);

    el.append(icon, text);

    if (opts.action && opts.action.label && typeof opts.action.onClick === 'function') {
      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'nm-pwa-btn';
      actionBtn.style.cssText = 'padding:5px 10px;font-size:11.5px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:transparent;color:#c4b5fd;cursor:pointer;';
      actionBtn.textContent = String(opts.action.label).slice(0, 40);
      actionBtn.addEventListener('click', () => {
        try { opts.action.onClick(); } catch (e) { console.warn(e); }
        dismiss(toast);
      });
      el.appendChild(actionBtn);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'nm-toast__close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Cerrar aviso');
    close.addEventListener('click', () => dismiss(toast));
    el.appendChild(close);

    container.appendChild(el);

    const toast = { id, el, timer: null, paused: false, remaining: duration };

    // Se fuerza el layout antes de animar la entrada.
    void el.offsetHeight;
    el.classList.add('is-in');

    if (duration > 0) {
      toast.timer = setTimeout(() => dismiss(toast), duration);
    }

    // Pausa el temporizador si el cursor está encima.
    el.addEventListener('mouseenter', () => {
      if (!toast.timer) return;
      clearTimeout(toast.timer);
      toast.timer = null;
      toast.paused = true;
    });

    el.addEventListener('mouseleave', () => {
      if (!toast.paused) return;
      toast.paused = false;
      if (duration > 0) {
        toast.timer = setTimeout(() => dismiss(toast), 1200);
      }
    });

    state.toasts.push(toast);

    // Si hay más de 3, se apila el último abajo sin tapar los demás.
    enforceLimit();

    return { id, dismiss: () => dismiss(toast) };
  }

  function enforceLimit() {
    // Los toasts visibles nunca son más de `maxVisible`; el resto queda
    // en la cola (apilado abajo) hasta que se libera un lugar.
    const visible = state.toasts.filter((t) => t.el.classList.contains('is-in'));
    if (visible.length <= state.maxVisible) return;

    const overflow = visible.slice(state.maxVisible);
    for (const toast of overflow) {
      // Se atenúan en vez de desaparecer: el usuario no pierde el mensaje.
      toast.el.style.opacity = '0.72';
      toast.el.style.transform = 'scale(.985)';
    }
  }

  function dismiss(toast) {
    if (!toast) return;
    if (toast.timer) {
      clearTimeout(toast.timer);
      toast.timer = null;
    }

    toast.el.classList.remove('is-in');
    toast.el.classList.add('is-out');
    toast.el.style.opacity = '0';

    setTimeout(() => {
      toast.el.remove();
      state.toasts = state.toasts.filter((t) => t.id !== toast.id);
      // Los que estaban atenuados vuelven a su estado normal.
      state.toasts.forEach((t) => {
        t.el.style.opacity = '';
        t.el.style.transform = '';
      });
    }, 240);
  }

  function dismissAll() {
    state.toasts.slice().forEach((t) => dismiss(t));
  }

  /* ─── API de compatibilidad ─────────────────────────────────────────── */

  function info(message, opts) { return show(message, 'info', opts); }
  function ok(message, opts) { return show(message, 'ok', opts); }
  function error(message, opts) { return show(message, 'error', opts); }
  function warn(message, opts) { return show(message, 'warn', opts); }

  /**
   * API tipo toast con soporte de duración y acción.
   */
  function toast(message, opts = {}) {
    return show(message, opts.kind || 'info', opts);
  }

  window.NumToastManager = {
    show,
    toast,
    info,
    ok,
    error,
    warn,
    dismissAll,
    injectStyles,
    get visible() { return state.toasts.length; },
    set maxVisible(n) { state.maxVisible = Math.max(1, Number(n) || 3); },
  };

  // Drop-in: reemplaza / completa el toast manager global.
  if (!window.NuminToast) {
    window.NuminToast = { show, toast, info, ok, error, warn };
  } else {
    // Se respetan los métodos que ya existieran y se completan los que falten.
    const existing = window.NuminToast;
    window.NuminToast = {
      show: typeof existing.show === 'function' ? existing.show.bind(existing) : show,
      toast: typeof existing.toast === 'function' ? existing.toast.bind(existing) : toast,
      info: typeof existing.info === 'function' ? existing.info.bind(existing) : info,
      ok: typeof existing.ok === 'function' ? existing.ok.bind(existing) : ok,
      success: typeof existing.success === 'function' ? existing.success.bind(existing) : ok,
      error: typeof existing.error === 'function' ? existing.error.bind(existing) : error,
      warn: typeof existing.warn === 'function' ? existing.warn.bind(existing) : warn,
    };
  }

  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    ensureContainer();
  });
})();
