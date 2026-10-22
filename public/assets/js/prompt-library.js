/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · prompt-library.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Gestor visual de prompts guardados.

   Estructura:
     · Columna de carpetas (todas / sin carpeta / creadas por el usuario)
     · Grilla de tarjetas de prompt
     · Modal de creación/edición
     · Botón "Usar" que inserta el prompt en el chat con un clic

   Montaje:
     window.NumPromptLibrary.mount('#prompt-library')
   o bien se auto-monta si existe #prompt-library / [data-prompt-library].
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const state = {
    root: null,
    foldersEl: null,
    gridEl: null,
    searchEl: null,
    prompts: [],
    folders: [],
    activeFolder: 'all',
    query: '',
    loading: false,
    modal: null,
  };

  const COLORS = ['#7c5cff', '#22d3ee', '#22c55e', '#f5a524', '#f0433a', '#ec4899', '#38bdf8'];

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

  function toast(message, kind = 'info') {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
      return;
    }
    console.info('[prompt-library]', kind, message);
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

  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium' }).format(d);
  }

  /* ─── Datos ─────────────────────────────────────────────────────────── */

  async function load() {
    if (state.loading) return;
    state.loading = true;

    const params = new URLSearchParams();
    if (state.activeFolder && state.activeFolder !== 'all') params.set('folder', state.activeFolder);
    if (state.query) params.set('q', state.query);

    try {
      const data = await api(`/api/prompts?${params.toString()}`);
      state.prompts = Array.isArray(data?.prompts) ? data.prompts : [];
      state.folders = Array.isArray(data?.folders) ? data.folders : [];
      renderFolders();
      renderGrid();
    } catch (e) {
      toast(e.message || 'No se pudieron cargar los prompts.', 'error');
      if (state.gridEl) {
        state.gridEl.innerHTML = `<div class="pl-empty"><span class="pl-empty__icon">⚠</span>${esc(e.message || 'Error al cargar')}</div>`;
      }
    } finally {
      state.loading = false;
    }
  }

  /* ─── Render: carpetas ──────────────────────────────────────────────── */

  function renderFolders() {
    const host = state.foldersEl;
    if (!host) return;

    host.innerHTML = '';

    const mk = (id, label, count, color) => el('button', {
      class: `pl-folder${state.activeFolder === id ? ' is-active' : ''}`,
      type: 'button',
      style: color ? `--folder-color:${esc(color)}` : null,
      onclick: () => {
        state.activeFolder = id;
        renderFolders();
        load();
      },
    }, [
      el('span', { class: 'pl-folder__dot' }),
      el('span', { class: 'pl-folder__name', text: label }),
      count !== undefined ? el('span', { class: 'pl-folder__count', text: String(count) }) : null,
    ]);

    host.appendChild(mk('all', 'Todos los prompts', state.prompts.length || undefined));
    host.appendChild(mk('none', 'Sin carpeta'));

    state.folders.forEach((folder) => {
      const item = mk(folder.id, folder.name, folder.count, folder.color);
      item.appendChild(el('span', {
        class: 'pl-folder__del',
        title: 'Eliminar carpeta',
        text: '×',
        onclick: (e) => {
          e.stopPropagation();
          removeFolder(folder);
        },
      }));
      host.appendChild(item);
    });

    host.appendChild(el('button', {
      class: 'pl-folder pl-folder--new',
      type: 'button',
      text: '+ Nueva carpeta',
      onclick: () => createFolder(),
    }));
  }

  /* ─── Render: grilla ────────────────────────────────────────────────── */

  function renderGrid() {
    const host = state.gridEl;
    if (!host) return;

    if (!state.prompts.length) {
      host.innerHTML = `
        <div class="pl-empty">
          <span class="pl-empty__icon">🗂</span>
          ${state.query
            ? 'Ningún prompt coincide con la búsqueda.'
            : 'Todavía no guardaste prompts. Creá el primero con el botón "Nuevo prompt".'}
        </div>`;
      return;
    }

    host.innerHTML = '';

    state.prompts.forEach((prompt) => {
      const card = el('article', { class: 'pl-card' }, [
        el('div', { class: 'pl-card__head' }, [
          el('h3', { class: 'pl-card__title', text: prompt.title }),
          el('button', {
            class: `pl-star${prompt.isFavorite ? ' is-active' : ''}`,
            type: 'button',
            title: prompt.isFavorite ? 'Quitar de favoritos' : 'Marcar como favorito',
            text: prompt.isFavorite ? '★' : '☆',
            onclick: () => toggleFavorite(prompt),
          }),
        ]),
        prompt.description ? el('p', { class: 'pl-card__desc', text: prompt.description }) : null,
        el('pre', { class: 'pl-card__body', text: String(prompt.content || '').slice(0, 320) }),
        el('div', { class: 'pl-card__tags' }, (prompt.tags || []).map((tag) =>
          el('span', { class: 'pl-tag', text: `#${tag}` })
        )),
        el('div', { class: 'pl-card__foot' }, [
          el('span', { class: 'pl-card__meta', text: `${prompt.usageCount || 0} usos · ${fmtDate(prompt.updatedAt)}` }),
          el('div', { class: 'pl-card__actions' }, [
            el('button', {
              class: 'pl-btn pl-btn--primary',
              type: 'button',
              text: 'Usar',
              onclick: () => usePrompt(prompt),
            }),
            el('button', {
              class: 'pl-btn',
              type: 'button',
              text: 'Editar',
              onclick: () => openModal(prompt),
            }),
            el('button', {
              class: 'pl-btn pl-btn--danger',
              type: 'button',
              text: 'Eliminar',
              onclick: () => removePrompt(prompt),
            }),
          ]),
        ]),
      ]);

      host.appendChild(card);
    });
  }

  /* ─── Acciones ──────────────────────────────────────────────────────── */

  /**
   * Reutiliza el prompt: lo inserta en el chat y avisa al resto de la
   * aplicación mediante un evento.
   */
  async function usePrompt(prompt) {
    const input = document.getElementById('chat-input');
    if (input) {
      input.value = prompt.content;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      input.setSelectionRange(prompt.content.length, prompt.content.length);
    }

    document.dispatchEvent(new CustomEvent('numination:prompt-use', {
      detail: { prompt },
    }));

    try {
      await api(`/api/prompts/${encodeURIComponent(prompt.id)}/use`, { method: 'POST' });
      const local = state.prompts.find((p) => p.id === prompt.id);
      if (local) local.usageCount = (local.usageCount || 0) + 1;
    } catch {
      /* el conteo de usos no es crítico */
    }

    toast(`"${prompt.title}" listo para usar.`, 'ok');
  }

  async function toggleFavorite(prompt) {
    try {
      const res = await api(`/api/prompts/${encodeURIComponent(prompt.id)}`, {
        method: 'PATCH',
        body: { isFavorite: !prompt.isFavorite },
      });
      prompt.isFavorite = Boolean(res?.prompt?.isFavorite);
      renderGrid();
    } catch (e) {
      toast(e.message || 'No se pudo actualizar.', 'error');
    }
  }

  async function removePrompt(prompt) {
    if (!window.confirm(`¿Eliminar el prompt "${prompt.title}"?`)) return;
    try {
      await api(`/api/prompts/${encodeURIComponent(prompt.id)}`, { method: 'DELETE' });
      state.prompts = state.prompts.filter((p) => p.id !== prompt.id);
      renderGrid();
      toast('Prompt eliminado.', 'ok');
    } catch (e) {
      toast(e.message || 'No se pudo eliminar.', 'error');
    }
  }

  async function createFolder() {
    const name = window.prompt('Nombre de la carpeta:');
    if (!name || !name.trim()) return;

    const color = COLORS[state.folders.length % COLORS.length];
    try {
      await api('/api/prompts/folders', {
        method: 'POST',
        body: { name: name.trim(), color },
      });
      await load();
      toast('Carpeta creada.', 'ok');
    } catch (e) {
      toast(e.message || 'No se pudo crear la carpeta.', 'error');
    }
  }

  async function removeFolder(folder) {
    if (!window.confirm(`¿Eliminar la carpeta "${folder.name}"? Los prompts quedan guardados sin carpeta.`)) return;
    try {
      await api(`/api/prompts/folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE' });
      if (state.activeFolder === folder.id) state.activeFolder = 'all';
      await load();
      toast('Carpeta eliminada.', 'ok');
    } catch (e) {
      toast(e.message || 'No se pudo eliminar la carpeta.', 'error');
    }
  }

  /* ─── Modal ─────────────────────────────────────────────────────────── */

  function openModal(prompt = null) {
    if (state.modal) state.modal.remove();

    const isEdit = Boolean(prompt && prompt.id);

    const title = el('input', { class: 'pl-modal__title', type: 'text', placeholder: 'Título', maxlength: '120' });
    title.value = prompt?.title || '';

    const description = el('input', { class: 'pl-modal__desc', type: 'text', placeholder: 'Descripción (opcional)', maxlength: '300' });
    description.value = prompt?.description || '';

    const content = el('textarea', { class: 'pl-modal__content', rows: '10', placeholder: 'Escribí el prompt…' });
    content.value = prompt?.content || '';

    const tags = el('input', { class: 'pl-modal__tags', type: 'text', placeholder: 'Etiquetas separadas por coma' });
    tags.value = (prompt?.tags || []).join(', ');

    const folder = el('select', { class: 'pl-modal__folder' });
    folder.appendChild(el('option', { value: 'none', text: 'Sin carpeta' }));
    state.folders.forEach((f) => {
      folder.appendChild(el('option', { value: f.id, text: f.name }));
    });
    folder.value = prompt?.folderId || (state.activeFolder !== 'all' ? state.activeFolder : 'none');

    const save = el('button', {
      class: 'pl-btn pl-btn--primary',
      type: 'button',
      text: isEdit ? 'Guardar cambios' : 'Guardar prompt',
      onclick: async () => {
        const payload = {
          title: title.value.trim(),
          description: description.value.trim(),
          content: content.value.trim(),
          tags: tags.value.split(',').map((t) => t.trim().replace(/^#/, '')).filter(Boolean),
          folderId: folder.value === 'none' ? null : folder.value,
        };

        if (!payload.title) {
          toast('Poné un título.', 'error');
          return;
        }
        if (!payload.content) {
          toast('Escribí el prompt.', 'error');
          return;
        }

        try {
          if (isEdit) {
            await api(`/api/prompts/${encodeURIComponent(prompt.id)}`, { method: 'PATCH', body: payload });
          } else {
            await api('/api/prompts', { method: 'POST', body: payload });
          }
          state.modal.remove();
          state.modal = null;
          await load();
          toast(isEdit ? 'Prompt actualizado.' : 'Prompt guardado.', 'ok');
        } catch (e) {
          toast(e.message || 'No se pudo guardar.', 'error');
        }
      },
    });

    const cancel = el('button', {
      class: 'pl-btn',
      type: 'button',
      text: 'Cancelar',
      onclick: () => {
        state.modal.remove();
        state.modal = null;
      },
    });

    const modal = el('div', { class: 'pl-modal' }, [
      el('div', {
        class: 'pl-modal__backdrop',
        onclick: () => { state.modal.remove(); state.modal = null; },
      }),
      el('div', { class: 'pl-modal__dialog' }, [
        el('h2', { class: 'pl-modal__heading', text: isEdit ? 'Editar prompt' : 'Nuevo prompt' }),
        title,
        description,
        content,
        el('div', { class: 'pl-modal__row' }, [folder, tags]),
        el('div', { class: 'pl-modal__actions' }, [cancel, save]),
      ]),
    ]);

    document.body.appendChild(modal);
    state.modal = modal;
    setTimeout(() => title.focus(), 50);

    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape' && state.modal) {
        state.modal.remove();
        state.modal = null;
        document.removeEventListener('keydown', onKey);
      }
    });
  }

  /* ─── Montaje ───────────────────────────────────────────────────────── */

  function mount(target) {
    const container = typeof target === 'string' ? $(target) : target;
    if (!container) return null;
    if (state.root && state.root.isConnected) return state.root;

    const folders = el('aside', { class: 'pl-folders' });
    const grid = el('div', { class: 'pl-grid' });

    const search = el('input', { class: 'pl-search', type: 'search', placeholder: 'Buscar prompts…' });
    let debounce = null;
    search.addEventListener('input', (e) => {
      clearTimeout(debounce);
      const value = e.target.value.trim();
      debounce = setTimeout(() => {
        state.query = value;
        load();
      }, 260);
    });

    const newBtn = el('button', {
      class: 'pl-btn pl-btn--primary',
      type: 'button',
      text: '+ Nuevo prompt',
      onclick: () => openModal(),
    });

    state.foldersEl = folders;
    state.gridEl = grid;

    const root = el('div', { class: 'pl-root' }, [
      el('header', { class: 'pl-head' }, [
        el('div', {}, [
          el('h1', { class: 'pl-title', text: 'Biblioteca de prompts' }),
          el('p', { class: 'pl-subtitle', text: 'Guardá tus mejores instrucciones y usalas con un clic.' }),
        ]),
        el('div', { class: 'pl-head__actions' }, [search, newBtn]),
      ]),
      el('div', { class: 'pl-body' }, [folders, grid]),
    ]);

    container.appendChild(root);
    state.root = root;

    renderFolders();
    renderGrid();
    load();

    return root;
  }

  /* ─── API pública ───────────────────────────────────────────────────── */

  window.NumPromptLibrary = {
    mount,
    load,
    openModal,
    usePrompt,
    get prompts() { return state.prompts.slice(); },
    get folders() { return state.folders.slice(); },
  };

  document.addEventListener('DOMContentLoaded', () => {
    const target = document.getElementById('prompt-library') ||
      document.querySelector('[data-prompt-library]');
    if (target) mount(target);
  });
})();
