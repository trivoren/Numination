/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · notifications-ui.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   La campanita del sidebar.

   Qué hace:
     · Badge rojo con la cantidad de no leídas.
     · Dropdown con la lista de notificaciones.
     · Polling cada 60 segundos (y al volver a la pestaña).
     · Click en una notificación → la marca como leída y navega al link.
     · "Marcar todas como leídas" y "Borrar todas".

   Montaje:
     window.NumNotificationsUI.mount('#notifications-bell')
   o automático si existe [data-notifications] / #notif-bell.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const POLL_MS = 60_000;

  const state = {
    root: null,
    bell: null,
    badge: null,
    panel: null,
    listEl: null,
    count: 0,
    notifications: [],
    open: false,
    timer: null,
    loading: false,
  };

  /* ─── Utilidades ────────────────────────────────────────────────────── */

  const $ = (sel) => document.querySelector(sel);

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((key) => {
        if (key === 'class') node.className = attrs[key];
        else if (key === 'text') node.textContent = attrs[key];
        else if (key === 'html') node.innerHTML = attrs[key];
        else if (key === 'style') node.setAttribute('style', attrs[key]);
        else if (key.startsWith('on') && typeof attrs[key] === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
        } else if (attrs[key] !== null && attrs[key] !== undefined) {
          node.setAttribute(key, attrs[key]);
        }
      });
    }
    (children || []).forEach((child) => {
      if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtRelative(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return '';

    const diff = Date.now() - then;
    const min = Math.round(diff / 60000);
    if (min < 1) return 'ahora';
    if (min < 60) return `hace ${min} min`;

    const hours = Math.round(min / 60);
    if (hours < 24) return `hace ${hours} h`;

    const days = Math.round(hours / 24);
    if (days < 30) return `hace ${days} d`;

    return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium' }).format(new Date(iso));
  }

  function toast(message, kind = 'info') {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
      return;
    }
    console.info('[notifications-ui]', kind, message);
  }

  async function api(path, options = {}) {
    const { method = 'GET', body } = options;

    if (window.NumAPI && typeof window.NumAPI.request === 'function') {
      return window.NumAPI.request(path, { method, body });
    }

    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    if (!res.ok) {
      const err = new Error(payload?.error || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  /* ─── Iconos ────────────────────────────────────────────────────────── */

  const ICON_BELL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.7 21a2 2 0 0 1-3.4 0"></path></svg>';

  const ICON_CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg>';

  const ICON_TRASH = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>';

  /* ─── Render ────────────────────────────────────────────────────────── */

  function renderBadge() {
    if (!state.badge) return;
    if (state.count > 0) {
      state.badge.textContent = state.count > 99 ? '99+' : String(state.count);
      state.badge.hidden = false;
    } else {
      state.badge.hidden = true;
    }
  }

  function priorityClass(notification) {
    const p = String(notification.priority || 'normal').toLowerCase();
    if (p === 'high') return 'notif-item--high';
    if (p === 'low') return 'notif-item--low';
    return '';
  }

  function renderList() {
    const host = state.listEl;
    if (!host) return;

    host.innerHTML = '';

    if (!state.notifications.length) {
      host.appendChild(el('div', { class: 'notif-empty', text: 'No tenés notificaciones.' }));
      return;
    }

    state.notifications.forEach((notification) => {
      const item = el('button', {
        class: `notif-item${notification.isRead ? '' : ' is-unread'} ${priorityClass(notification)}`,
        type: 'button',
        onclick: () => open(notification),
      }, [
        el('span', { class: 'notif-item__dot' }),
        el('span', { class: 'notif-item__body' }, [
          el('span', { class: 'notif-item__title', text: notification.title }),
          notification.body ? el('span', { class: 'notif-item__text', text: notification.body }) : null,
          el('span', { class: 'notif-item__time', text: fmtRelative(notification.createdAt) }),
        ]),
      ]);

      host.appendChild(item);
    });
  }

  /* ─── Datos ─────────────────────────────────────────────────────────── */

  async function fetchCount() {
    try {
      const data = await api('/api/notifications/unread-count');
      state.count = Number(data?.count || 0);
      renderBadge();
      return state.count;
    } catch {
      return state.count;
    }
  }

  async function fetchList() {
    if (state.loading) return;
    state.loading = true;

    try {
      const data = await api('/api/notifications?limit=25');
      state.notifications = Array.isArray(data?.notifications) ? data.notifications : [];
      renderList();
    } catch (e) {
      console.warn('[notifications-ui] no se pudo cargar la lista', e);
    } finally {
      state.loading = false;
    }
  }

  async function open(notification) {
    try {
      await api(`/api/notifications/${encodeURIComponent(notification.id)}/read`, { method: 'POST' });
      notification.isRead = true;
      state.count = Math.max(0, state.count - 1);
      renderBadge();
      renderList();
    } catch (e) {
      console.warn('[notifications-ui] no se pudo marcar como leída', e);
    }

    if (notification.link) {
      window.location.href = notification.link;
    }
  }

  async function markAllRead() {
    try {
      const data = await api('/api/notifications/read-all', { method: 'POST' });
      state.notifications = state.notifications.map((n) => ({ ...n, isRead: true }));
      state.count = 0;
      renderBadge();
      renderList();
      toast(`Marcaste ${data?.count || 0} notificaciones como leídas.`, 'ok');
    } catch (e) {
      toast(e.message || 'No se pudo actualizar.', 'error');
    }
  }

  async function clearAll() {
    if (!window.confirm('¿Borrar todas las notificaciones?')) return;
    try {
      await api('/api/notifications', { method: 'DELETE' });
      state.notifications = [];
      state.count = 0;
      renderBadge();
      renderList();
      toast('Notificaciones borradas.', 'ok');
    } catch (e) {
      toast(e.message || 'No se pudo borrar.', 'error');
    }
  }

  /* ─── Dropdown ──────────────────────────────────────────────────────── */

  function togglePanel() {
    if (state.open) {
      closePanel();
      return;
    }
    state.panel.hidden = false;
    state.open = true;
    state.root?.classList.add('is-open');
    fetchList();
    document.addEventListener('click', onOutside, { once: false });
  }

  function closePanel() {
    if (!state.panel) return;
    state.panel.hidden = true;
    state.open = false;
    state.root?.classList.remove('is-open');
    document.removeEventListener('click', onOutside);
  }

  function onOutside(e) {
    if (!state.root) return;
    if (!state.root.contains(e.target)) closePanel();
  }

  /* ─── Montaje ───────────────────────────────────────────────────────── */

  function build() {
    const bell = el('button', {
      class: 'notif-bell',
      type: 'button',
      title: 'Notificaciones',
      'aria-label': 'Notificaciones',
      html: ICON_BELL,
    });

    const badge = el('span', { class: 'notif-badge', text: '0' });
    badge.hidden = true;

    bell.appendChild(badge);

    const list = el('div', { class: 'notif-list' });
    state.listEl = list;

    const panel = el('div', { class: 'notif-panel' }, [
      el('div', { class: 'notif-panel__head' }, [
        el('span', { class: 'notif-panel__title', text: 'Notificaciones' }),
        el('div', { class: 'notif-panel__actions' }, [
          el('button', {
            class: 'notif-link',
            type: 'button',
            title: 'Marcar todas como leídas',
            html: ICON_CHECK,
            onclick: (e) => { e.stopPropagation(); markAllRead(); },
          }),
          el('button', {
            class: 'notif-link',
            type: 'button',
            title: 'Borrar todas',
            html: ICON_TRASH,
            onclick: (e) => { e.stopPropagation(); clearAll(); },
          }),
        ]),
      ]),
      list,
    ]);
    panel.hidden = true;

    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel();
    });

    const root = el('div', { class: 'notif-root' }, [bell, panel]);

    state.root = root;
    state.bell = bell;
    state.badge = badge;
    state.panel = panel;

    return root;
  }

  function mount(target) {
    const container = typeof target === 'string' ? $(target) : target;
    if (!container) return null;
    if (state.root && state.root.isConnected) return state.root;

    state.root = build();
    container.appendChild(state.root);

    renderBadge();
    fetchCount();
    startPolling();

    return state.root;
  }

  function startPolling() {
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (document.hidden) return;
      fetchCount();
      if (state.open) fetchList();
    }, POLL_MS);

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        fetchCount();
        if (state.open) fetchList();
      }
    });
  }

  /* ─── API pública ───────────────────────────────────────────────────── */

  window.NumNotificationsUI = {
    mount,
    refresh: fetchCount,
    reload: fetchList,
    markAllRead,
    clearAll,
    get count() { return state.count; },
    get notifications() { return state.notifications.slice(); },
    open: togglePanel,
  };

  document.addEventListener('DOMContentLoaded', () => {
    const target = document.querySelector('[data-notifications]') ||
      document.getElementById('notif-bell') ||
      document.getElementById('notifications-bell');
    if (target) mount(target);
  });
})();
