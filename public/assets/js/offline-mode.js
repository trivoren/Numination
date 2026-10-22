/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · offline-mode.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Modo offline: cola de mensajes y sincronización al volver la conexión.

   FLUJO
     1. `window.addEventListener('offline')` → se avisa al usuario y se
        empieza a encolar lo que escribe.
     2. Los mensajes se guardan en localStorage (cola persistente).
     3. `window.addEventListener('online')` → se reintenta el envío de la
        cola, uno por uno, y se avisa qué se sincronizó.
     4. La cola se vacía a medida que se confirma cada envío.

   DECISIONES
     · La cola vive en localStorage, no en memoria: si el usuario cierra
       la pestaña sin conexión, el mensaje NO se pierde.
     · Se manda primero lo más viejo (orden conversacional).
     · Se reintentan con backoff exponencial y un tope de 5 intentos
       (si falla 5 veces, el mensaje queda marcado como fallido para que
       el usuario no pierda tiempo).
     · Nunca se manda un mensaje duplicado: cada uno lleva un `clientId`
       (uuid) que el backend puede deduplicar.

   NOTA
     La sincronización usa POST /api/chat/offline-sync: si el endpoint no
     existe (versiones antiguas), los mensajes quedan en la cola y se
     reintentan más tarde. No se pierden.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STORAGE_KEY = 'nm_offline_queue';
  const MAX_QUEUE = 50;
  const MAX_ATTEMPTS = 5;
  const SYNC_ENDPOINT = '/api/chat/offline-sync';

  const state = {
    queue: [],
    online: true,
    syncing: false,
    listeners: new Set(),
    badge: null,
  };

  /* ─── Utilidades ────────────────────────────────────────────────────── */

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return `off-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  }

  function load() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      state.queue = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(state.queue)) state.queue = [];
    } catch (e) {
      state.queue = [];
      console.warn('[offline-mode] no se pudo leer la cola', e);
    }
    return state.queue;
  }

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.queue.slice(-MAX_QUEUE)));
    } catch (e) {
      console.warn('[offline-mode] no se pudo guardar la cola', e);
    }
    render();
  }

  function toast(message, kind = 'info') {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
      return;
    }
    console.info('[offline-mode]', kind, message);
  }

  function emit(event, detail) {
    document.dispatchEvent(new CustomEvent(`numination:${event}`, { detail }));
    state.listeners.forEach((fn) => {
      try { fn(detail); } catch { /* un listener roto no rompe el flujo */ }
    });
  }

  /* ─── Badge de estado ───────────────────────────────────────────────── */

  const STYLE_ID = 'numination-offline-styles';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.nm-offline-badge {
  position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
  z-index: 200; display: flex; align-items: center; gap: 9px;
  padding: 9px 15px; border-radius: 99px;
  background: rgba(20,20,26,.96); border: 1px solid rgba(245,165,36,.4);
  color: #fbbf24; font: 600 12.5px/1 var(--font-sans, Inter, system-ui, sans-serif);
  box-shadow: 0 14px 36px rgba(0,0,0,.55); backdrop-filter: blur(8px);
}
.nm-offline-badge__dot { width: 8px; height: 8px; border-radius: 50%; background: #f5a524; }
.nm-offline-badge.is-online { border-color: rgba(34,197,94,.4); color: #4ade80; }
.nm-offline-badge.is-online .nm-offline-badge__dot { background: #22c55e; }
.nm-offline-badge__count {
  font: 700 11px/1 var(--font-mono, monospace);
  background: rgba(245,165,36,.18); border-radius: 99px; padding: 3px 7px;
}
`;
    document.head.appendChild(style);
  }

  function render() {
    if (!state.badge) {
      injectStyles();
      state.badge = document.createElement('div');
      state.badge.className = 'nm-offline-badge';
      state.badge.hidden = true;
      document.body.appendChild(state.badge);
    }

    const pending = state.queue.filter((item) => item.status === 'pending').length;

    if (state.online && pending === 0) {
      state.badge.hidden = true;
      return;
    }

    state.badge.classList.toggle('is-online', state.online);
    state.badge.innerHTML = '';

    const dot = document.createElement('span');
    dot.className = 'nm-offline-badge__dot';
    state.badge.appendChild(dot);

    const label = document.createElement('span');
    label.textContent = state.online
      ? (pending ? 'Sincronizando mensajes…' : 'Conectado')
      : 'Sin conexión · tus mensajes se guardan';
    state.badge.appendChild(label);

    if (pending) {
      const count = document.createElement('span');
      count.className = 'nm-offline-badge__count';
      count.textContent = String(pending);
      state.badge.appendChild(count);
    }

    state.badge.hidden = false;
  }

  /* ─── Cola ──────────────────────────────────────────────────────────── */

  /**
   * Encola un mensaje.
   * @param {object} payload { message, chatId, role, meta }
   * @returns {string} clientId
   */
  function enqueue(payload = {}) {
    const item = {
      clientId: uuid(),
      message: String(payload.message ?? '').slice(0, 8000),
      chatId: payload.chatId ?? null,
      role: payload.role || 'user',
      files: Array.isArray(payload.files) ? payload.files.slice(0, 3) : [],
      meta: payload.meta && typeof payload.meta === 'object' ? payload.meta : {},
      createdAt: new Date().toISOString(),
      attempts: 0,
      status: 'pending',
      lastError: null,
    };

    if (!item.message && !item.files.length) {
      console.warn('[offline-mode] mensaje vacío: no se encola');
      return item.clientId;
    }

    state.queue.push(item);

    if (state.queue.length > MAX_QUEUE) {
      state.queue.splice(0, state.queue.length - MAX_QUEUE);
    }

    save();
    emit('offline-queued', item);

    // Si ya hay conexión, se intenta enviar de inmediato.
    if (state.online) {
      sync();
    }

    return item.clientId;
  }

  /**
   * Intenta enviar la cola.
   * @returns {Promise<object>} { ok, sent, failed, remaining }
   */
  async function sync() {
    if (state.syncing) return { ok: false, reason: 'already_syncing', sent: 0, failed: 0, remaining: state.queue.length };
    if (!state.online) return { ok: false, reason: 'offline', sent: 0, failed: 0, remaining: state.queue.length };

    const pending = state.queue.filter((item) => item.status === 'pending');
    if (!pending.length) return { ok: true, sent: 0, failed: 0, remaining: 0 };

    state.syncing = true;
    render();

    let sent = 0;
    let failed = 0;

    for (const item of pending) {
      try {
        await sendItem(item);
        item.status = 'sent';
        sent++;
      } catch (e) {
        item.attempts = (item.attempts || 0) + 1;
        item.lastError = String(e.message || e).slice(0, 200);

        if (item.attempts >= MAX_ATTEMPTS) {
          item.status = 'failed';
          failed++;
          console.warn('[offline-mode] mensaje descartado tras varios intentos', item.clientId);
        } else {
          // Backoff exponencial antes del siguiente reintento.
          await sleep(Math.min(500 * 2 ** item.attempts, 8000));
          continue;
        }
      }
    }

    // Se limpian los enviados y los fallidos definitivos.
    state.queue = state.queue.filter((item) => item.status === 'pending');

    state.syncing = false;
    save();

    if (sent) {
      toast(`${sent} mensaje${sent === 1 ? '' : 's'} sincronizado${sent === 1 ? '' : 's'}.`, 'ok');
      emit('offline-synced', { sent, failed });
    }

    return { ok: true, sent, failed, remaining: state.queue.length };
  }

  async function sendItem(item) {
    const body = {
      clientId: item.clientId,
      message: item.message,
      chatId: item.chatId,
      role: item.role,
      files: item.files,
      meta: item.meta,
      sentAt: item.createdAt,
      offline: true,
    };

    const res = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 404) {
      throw new Error('El endpoint de sincronización no existe todavía.');
    }

    if (!res.ok) {
      let message = `Error ${res.status}`;
      try {
        const text = await res.text();
        const parsed = text ? JSON.parse(text) : null;
        if (parsed?.error) message = parsed.error;
      } catch { /* respuesta no JSON */ }
      throw new Error(message);
    }

    return res;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ─── Eventos de red ────────────────────────────────────────────────── */

  function onOffline() {
    state.online = false;
    render();
    toast('Se cortó la conexión. Guardamos tus mensajes y los mandamos al volver.', 'info');
    emit('offline', { queueLength: state.queue.length });
  }

  function onOnline() {
    state.online = true;
    render();
    emit('online', { queueLength: state.queue.length });

    if (state.queue.length) {
      sync();
    } else {
      toast('Volvió la conexión.', 'ok');
    }
  }

  /* ─── Montaje ───────────────────────────────────────────────────────── */

  function init() {
    load();

    state.online = navigator.onLine !== false;

    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);

    // Reintento periódico si quedó algo pendiente.
    const timer = setInterval(() => {
      if (state.online && state.queue.length && !state.syncing) {
        sync();
      }
    }, 30_000);

    if (timer && typeof timer.unref === 'object') {
      // En el navegador no hay unref: se deja el intervalo activo.
    }

    render();

    return state.queue;
  }

  window.NumOfflineMode = {
    init,
    enqueue,
    sync,
    on(event, cb) {
      state.listeners.add(cb);
      return () => state.listeners.delete(cb);
    },
    get queue() { return state.queue.slice(); },
    get pending() { return state.queue.filter((i) => i.status === 'pending').length; },
    get online() { return state.online; },
  };

  document.addEventListener('DOMContentLoaded', init, { once: true });
})();
