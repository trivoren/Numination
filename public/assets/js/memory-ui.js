/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · memory-ui.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Modal de "Caja fuerte" en los ajustes.

   Qué hace:
     · Lista los recuerdos que la IA guarda del usuario.
     · Filtra por categoría y busca por texto.
     · Borra un recuerdo con un clic (con confirmación ligera).
     · Fija (pin) un recuerdo para que siempre esté en el contexto.
     · Permite agregar un recuerdo manual.
     · "Vaciar todo" con doble confirmación.

   Montaje:
     window.NumMemoryUI.open()         ← abre el modal
     window.NumMemoryUI.mountTrigger()  ← engancha los botones de la UI
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const state = {
    modal: null,
    listEl: null,
    countEl: null,
    searchEl: null,
    filterEl: null,
    memories: [],
    categories: [],
    filter: 'all',
    query: '',
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

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium' }).format(d);
  }

  function toast(message, kind = 'info') {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
      return;
    }
    console.info('[memory-ui]', kind, message);
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

  const ICONS = {
    trash: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>',
    pin: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"></path><path d="M9 3h6l-1 6 3 3H7l3-3z"></path></svg>',
    plus: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>',
    close: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18"></path><path d="M6 6l12 12"></path></svg>',
  };

  /* ─── Modal ─────────────────────────────────────────────────────────── */

  function buildModal() {
    if (state.modal) return state.modal;

    const list = el('div', { class: 'mem-list' });
    const count = el('div', { class: 'mem-count', text: '—' });

    const search = el('input', {
      class: 'mem-search',
      type: 'search',
      placeholder: 'Buscar recuerdo…',
      autocomplete: 'off',
    });
    state.searchEl = search;

    let debounce = null;
    search.addEventListener('input', (e) => {
      clearTimeout(debounce);
      const value = e.target.value.trim().toLowerCase();
      debounce = setTimeout(() => {
        state.query = value;
        renderList();
      }, 200);
    });

    const filter = el('select', { class: 'mem-filter' });
    state.filterEl = filter;
    filter.addEventListener('change', (e) => {
      state.filter = e.target.value;
      renderList();
    });

    const addBtn = el('button', {
      class: 'mem-btn mem-btn--primary',
      type: 'button',
      html: `${ICONS.plus}<span>Agregar</span>`,
      onclick: () => startAdd(),
    });

    const clearBtn = el('button', {
      class: 'mem-btn mem-btn--danger',
      type: 'button',
      text: 'Vaciar todo',
      onclick: () => clearAll(),
    });

    const body = el('div', { class: 'mem-body' }, [
      el('div', { class: 'mem-toolbar' }, [search, filter, addBtn, clearBtn]),
      count,
      list,
    ]);

    const modal = el('div', { class: 'mem-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Recuerdos de la IA' }, [
      el('div', { class: 'mem-backdrop', onclick: () => close() }),
      el('div', { class: 'mem-dialog' }, [
        el('div', { class: 'mem-head' }, [
          el('div', {}, [
            el('h2', { class: 'mem-title', text: 'Lo que la IA recuerda' }),
            el('p', {
              class: 'mem-subtitle',
              text: 'Estos datos se vuelven a incluir en el contexto de cada conversación. Podés borrarlos cuando quieras.',
            }),
          ]),
          el('button', {
            class: 'mem-close',
            type: 'button',
            html: ICONS.close,
            title: 'Cerrar',
            onclick: () => close(),
          }),
        ]),
        body,
      ]),
    ]);

    modal.hidden = true;
    document.body.appendChild(modal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.hidden) close();
    });

    state.modal = modal;
    state.listEl = list;
    state.countEl = count;

    return modal;
  }

  function open() {
    const modal = buildModal();
    modal.hidden = false;
    document.body.classList.add('mem-open');
    load();
    setTimeout(() => state.searchEl?.focus(), 60);
  }

  function close() {
    if (!state.modal) return;
    state.modal.hidden = true;
    document.body.classList.remove('mem-open');
  }

  /* ─── Datos ─────────────────────────────────────────────────────────── */

  async function load() {
    if (state.loading) return;
    state.loading = true;

    if (state.listEl) {
      state.listEl.innerHTML = '<div class="mem-skeleton"></div><div class="mem-skeleton"></div><div class="mem-skeleton"></div>';
    }

    try {
      const [listData, statsData] = await Promise.all([
        api('/api/memory?limit=200'),
        api('/api/memory/stats').catch(() => null),
      ]);

      state.memories = Array.isArray(listData?.memories) ? listData.memories : [];
      state.categories = Array.isArray(statsData?.byCategory) ? statsData.byCategory : [];

      renderFilters();
      renderList();
    } catch (e) {
      if (state.listEl) {
        state.listEl.innerHTML = `<div class="mem-empty"><span class="mem-empty__icon">⚠</span>${esc(e.message || 'No se pudieron cargar los recuerdos.')}</div>`;
      }
      if (state.countEl) state.countEl.textContent = '—';
    } finally {
      state.loading = false;
    }
  }

  function renderFilters() {
    const select = state.filterEl;
    if (!select) return;

    const current = select.value || state.filter;
    select.innerHTML = '';

    select.appendChild(el('option', { value: 'all', text: 'Todas las categorías' }));
    state.categories.forEach((c) => {
      select.appendChild(el('option', { value: c.category, text: `${c.category} (${c.count})` }));
    });

    select.value = current && current !== 'all' ? current : 'all';
  }

  function visibleMemories() {
    return state.memories.filter((m) => {
      if (state.filter !== 'all' && (m.category || 'other') !== state.filter) return false;
      if (state.query && !String(m.content || '').toLowerCase().includes(state.query)) return false;
      return true;
    });
  }

  function renderList() {
    const list = state.listEl;
    if (!list) return;

    const items = visibleMemories();

    if (state.countEl) {
      state.countEl.textContent = items.length === state.memories.length
        ? `${items.length} recuerdo${items.length === 1 ? '' : 's'}`
        : `${items.length} de ${state.memories.length} recuerdos`;
    }

    if (!items.length) {
      list.innerHTML = `
        <div class="mem-empty">
          <span class="mem-empty__icon">🧠</span>
          ${state.memories.length
            ? 'Ningún recuerdo coincide con el filtro.'
            : 'Todavía no hay recuerdos. Cuando aprendas algo del usuario, aparecerá acá.'}
        </div>`;
      return;
    }

    list.innerHTML = '';

    items.forEach((memory) => {
      const pinned = Boolean(memory.meta?.pinned) || Number(memory.importance) >= 0.95;

      const item = el('div', { class: `mem-item${pinned ? ' is-pinned' : ''}` }, [
        el('div', { class: 'mem-item__main' }, [
          el('div', { class: 'mem-item__content', text: memory.content || '' }),
          el('div', { class: 'mem-item__meta' }, [
            el('span', { class: 'mem-chip', text: memory.category || 'other' }),
            el('span', { class: 'mem-chip mem-chip--muted', text: memory.type || 'fact' }),
            el('span', { class: 'mem-date', text: fmtDate(memory.createdAt) }),
          ]),
        ]),
        el('div', { class: 'mem-item__actions' }, [
          el('button', {
            class: `mem-iconbtn${pinned ? ' is-active' : ''}`,
            type: 'button',
            title: pinned ? 'Desfijar' : 'Fijar',
            html: ICONS.pin,
            onclick: () => togglePin(memory),
          }),
          el('button', {
            class: 'mem-iconbtn mem-iconbtn--danger',
            type: 'button',
            title: 'Borrar recuerdo',
            html: ICONS.trash,
            onclick: () => remove(memory),
          }),
        ]),
      ]);

      list.appendChild(item);
    });
  }

  /* ─── Acciones ──────────────────────────────────────────────────────── */

  async function remove(memory) {
    const ok = await confirmDialog(
      'Borrar recuerdo',
      'Este recuerdo se elimina y la IA deja de usarlo como contexto.',
      'Borrar'
    );
    if (!ok) return;

    try {
      await api(`/api/memory/${encodeURIComponent(memory.id)}`, { method: 'DELETE' });
      state.memories = state.memories.filter((m) => m.id !== memory.id);
      renderList();
      toast('Recuerdo borrado.', 'ok');
    } catch (e) {
      toast(e.message || 'No se pudo borrar.', 'error');
    }
  }

  async function togglePin(memory) {
    const pinned = !(Boolean(memory.meta?.pinned) || Number(memory.importance) >= 0.95);
    try {
      await api(`/api/memory/${encodeURIComponent(memory.id)}/pin`, {
        method: 'POST',
        body: { pinned },
      });
      memory.meta = { ...(memory.meta || {}), pinned };
      memory.importance = pinned ? 0.95 : 0.6;
      renderList();
      toast(pinned ? 'Recuerdo fijado.' : 'Recuerdo desfijado.', 'ok');
    } catch (e) {
      toast(e.message || 'No se pudo actualizar.', 'error');
    }
  }

  async function clearAll() {
    const first = await confirmDialog(
      'Vaciar toda la memoria',
      'Se borran TODOS los recuerdos que la IA guardó de vos. Esta acción no se puede deshacer.',
      'Continuar'
    );
    if (!first) return;

    const second = await confirmDialog(
      '¿Seguro?',
      'Última confirmación: vas a perder todos los recuerdos guardados.',
      'Sí, vaciar'
    );
    if (!second) return;

    try {
      const res = await api('/api/memory', { method: 'DELETE' });
      state.memories = [];
      renderList();
      toast(`Se borraron ${res?.deleted ?? 0} recuerdos.`, 'ok');
    } catch (e) {
      toast(e.message || 'No se pudo vaciar la memoria.', 'error');
    }
  }

  function startAdd() {
    const input = el('textarea', {
      class: 'mem-new__input',
      rows: '3',
      placeholder: 'Ej: Mi nombre es Emilio y trabajo con React y Node.js.',
      maxlength: '2000',
    });

    const category = el('select', { class: 'mem-new__category' }, [
      el('option', { value: 'personal', text: 'Personal' }),
      el('option', { value: 'preferencias', text: 'Preferencias' }),
      el('option', { value: 'trabajo', text: 'Trabajo / estudio' }),
      el('option', { value: 'other', text: 'Otro' }),
    ]);

    const save = el('button', {
      class: 'mem-btn mem-btn--primary',
      type: 'button',
      text: 'Guardar',
      onclick: async () => {
        const content = input.value.trim();
        if (!content) {
          toast('Escribí el recuerdo.', 'error');
          return;
        }
        try {
          const res = await api('/api/memory', {
            method: 'POST',
            body: { content, category: category.value, type: 'manual', importance: 0.8 },
          });
          if (res?.memory) state.memories.unshift(res.memory);
          renderList();
          toast('Recuerdo guardado.', 'ok');
        } catch (e) {
          toast(e.message || 'No se pudo guardar.', 'error');
        }
      },
    });

    const cancel = el('button', {
      class: 'mem-btn mem-btn--ghost',
      type: 'button',
      text: 'Cancelar',
      onclick: () => {
        const existing = state.listEl.querySelector('.mem-new');
        if (existing) existing.remove();
      },
    });

    const block = el('div', { class: 'mem-new' }, [
      input,
      el('div', { class: 'mem-new__row' }, [category, cancel, save]),
    ]);

    const list = state.listEl;
    const previous = list.querySelector('.mem-new');
    if (previous) previous.remove();
    list.insertBefore(block, list.firstChild);
    input.focus();
  }

  /**
   * Diálogo de confirmación (sin depender de window.confirm, que es feo
   * y bloquea el hilo).
   */
  function confirmDialog(title, message, confirmLabel) {
    return new Promise((resolve) => {
      const dialog = el('div', { class: 'mem-modal mem-modal--confirm' }, [
        el('div', { class: 'mem-backdrop' }),
        el('div', { class: 'mem-dialog mem-dialog--sm' }, [
          el('h3', { class: 'mem-confirm__title', text: title }),
          el('p', { class: 'mem-confirm__text', text: message }),
          el('div', { class: 'mem-confirm__actions' }, [
            el('button', {
              class: 'mem-btn mem-btn--ghost',
              type: 'button',
              text: 'Cancelar',
              onclick: () => { dialog.remove(); resolve(false); },
            }),
            el('button', {
              class: 'mem-btn mem-btn--danger',
              type: 'button',
              text: confirmLabel,
              onclick: () => { dialog.remove(); resolve(true); },
            }),
          ]),
        ]),
      ]);

      document.body.appendChild(dialog);
      dialog.querySelector('.mem-backdrop').addEventListener('click', () => {
        dialog.remove();
        resolve(false);
      });
    });
  }

  /* ─── Montaje ───────────────────────────────────────────────────────── */

  function mountTrigger() {
    const selectors = ['#memory-open', '#open-memory', '#memory-settings-btn', '[data-open-memory]'];
    selectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((btn) => {
        if (btn.dataset.memBound === '1') return;
        btn.dataset.memBound = '1';
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          open();
        });
      });
    });
  }

  window.NumMemoryUI = {
    open,
    close,
    load,
    mountTrigger,
    remove,
    clearAll,
  };

  document.addEventListener('DOMContentLoaded', mountTrigger);
})();
