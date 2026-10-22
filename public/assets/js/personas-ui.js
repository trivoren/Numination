/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · personas-ui.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Selector de Persona para el chat.

   Qué hace:
     · Menú desplegable con las personas del usuario.
     · Al elegir una, se activa en el backend (POST /api/personas/active)
       y se actualiza el System Prompt en vivo.
     · Editor rápido del System Prompt (se guarda con PATCH).
     · Creación de una persona nueva desde el mismo menú.
     · Emite `numination:persona-changed` con el detalle para que el chat
       lo adjunte a la próxima request.

   Montaje:
     window.NumPersonasUI.mount('#chat-personas')   ← cualquier contenedor
   o bien, automáticamente si existe #personas-dropdown / #chat-personas.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const state = {
    root: null,
    menu: null,
    personas: [],
    activeId: null,
    editing: null,
    open: false,
    limits: null,
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

  function toast(message, kind = 'info') {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
      return;
    }
    console.info('[personas-ui]', kind, message);
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

  /* ─── Render ────────────────────────────────────────────────────────── */

  function currentPersona() {
    return state.personas.find((p) => p.id === state.activeId) || null;
  }

  function renderTrigger() {
    if (!state.root) return;
    const persona = currentPersona();
    const trigger = state.root.querySelector('.personas-trigger');
    if (!trigger) return;

    trigger.innerHTML = '';
    trigger.appendChild(el('span', { class: 'personas-trigger__avatar', text: persona ? persona.avatar : '🤖' }));
    trigger.appendChild(el('span', {
      class: 'personas-trigger__label',
      text: persona ? persona.name : 'Sin persona',
    }));
    trigger.appendChild(el('span', { class: 'personas-trigger__caret', text: '▾' }));
    if (persona) trigger.style.setProperty('--persona-color', persona.color || '#7c5cff');
  }

  function renderMenu() {
    if (!state.menu) return;
    state.menu.innerHTML = '';

    state.menu.appendChild(el('div', { class: 'personas-menu__head' }, [
      el('span', { text: 'Personas' }),
      el('button', {
        class: 'personas-btn personas-btn--ghost',
        type: 'button',
        text: '+ Nueva',
        onclick: (e) => {
          e.stopPropagation();
          startCreate();
        },
      }),
    ]));

    if (!state.personas.length) {
      state.menu.appendChild(el('div', {
        class: 'personas-menu__empty',
        text: 'Todavía no creaste ninguna persona. Empezá con una: "Abogado", "Tutor de física"…',
      }));
    }

    state.personas.forEach((persona) => {
      const isActive = persona.id === state.activeId;

      const item = el('button', {
        class: `personas-item${isActive ? ' is-active' : ''}`,
        type: 'button',
        style: `--persona-color:${esc(persona.color || '#7c5cff')}`,
        onclick: (e) => {
          e.stopPropagation();
          selectPersona(persona.id);
        },
      }, [
        el('span', { class: 'personas-item__avatar', text: persona.avatar || '🤖' }),
        el('span', { class: 'personas-item__body' }, [
          el('span', { class: 'personas-item__name', text: persona.name }),
          el('span', {
            class: 'personas-item__desc',
            text: persona.description || 'Sin descripción',
          }),
        ]),
        el('span', { class: 'personas-item__actions' }, [
          el('span', {
            class: 'personas-item__edit',
            title: 'Editar prompt',
            text: '✎',
            onclick: (e) => {
              e.stopPropagation();
              startEdit(persona);
            },
          }),
          el('span', {
            class: 'personas-item__del',
            title: 'Eliminar',
            text: '🗑',
            onclick: (e) => {
              e.stopPropagation();
              removePersona(persona);
            },
          }),
        ]),
      ]);

      state.menu.appendChild(item);
    });

    // Editor inline
    if (state.editing) {
      state.menu.appendChild(renderEditor());
    }
  }

  function renderEditor() {
    const isNew = state.editing.id === '__new__';
    const textarea = el('textarea', {
      class: 'personas-editor__prompt',
      rows: '5',
      placeholder: 'Ej: Sos un abogado especialista en contratación laboral en Colombia. Respondé con citas del Código Sustantivo del Trabajo y sé claro con los plazos.',
    });
    textarea.value = state.editing.systemPrompt || '';

    const nameInput = el('input', {
      class: 'personas-editor__name',
      type: 'text',
      placeholder: 'Nombre de la persona',
      maxlength: '60',
    });
    nameInput.value = isNew ? '' : (state.editing.name || '');

    const descInput = el('input', {
      class: 'personas-editor__desc',
      type: 'text',
      placeholder: 'Descripción corta (opcional)',
      maxlength: '240',
    });
    descInput.value = isNew ? '' : (state.editing.description || '');

    const save = el('button', {
      class: 'personas-btn personas-btn--primary',
      type: 'button',
      text: isNew ? 'Crear' : 'Guardar',
      onclick: async (e) => {
        e.stopPropagation();
        await savePersona({
          id: state.editing.id,
          name: nameInput.value.trim(),
          description: descInput.value.trim(),
          systemPrompt: textarea.value.trim(),
        });
      },
    });

    const cancel = el('button', {
      class: 'personas-btn personas-btn--ghost',
      type: 'button',
      text: 'Cancelar',
      onclick: (e) => {
        e.stopPropagation();
        state.editing = null;
        renderMenu();
      },
    });

    return el('div', { class: 'personas-editor' }, [
      el('div', { class: 'personas-editor__title', text: isNew ? 'Nueva persona' : 'Editar persona' }),
      nameInput,
      descInput,
      textarea,
      el('div', { class: 'personas-editor__actions' }, [cancel, save]),
    ]);
  }

  function renderAll() {
    renderTrigger();
    renderMenu();
  }

  /* ─── Acciones ──────────────────────────────────────────────────────── */

  async function load() {
    try {
      const data = await api('/api/personas');
      state.personas = Array.isArray(data?.personas) ? data.personas : [];
      state.limits = data?.limits || null;

      const active = state.personas.find((p) => p.isActive) || state.personas.find((p) => p.isDefault) || null;
      state.activeId = active ? active.id : null;

      renderAll();
    } catch (e) {
      console.warn('[personas-ui] no se pudieron cargar las personas', e);
      state.personas = [];
      renderAll();
    }
  }

  async function selectPersona(personaId) {
    try {
      await api('/api/personas/active', { method: 'POST', body: { personaId } });
      state.activeId = personaId;
      state.personas = state.personas.map((p) => ({ ...p, isActive: p.id === personaId }));
      renderAll();
      closeMenu();

      const persona = currentPersona();
      document.dispatchEvent(new CustomEvent('numination:persona-changed', {
        detail: { persona },
      }));

      toast(persona ? `Ahora sos "${persona.name}".` : 'Volviste al asistente por defecto.', 'ok');
    } catch (e) {
      toast(e.message || 'No se pudo activar la persona.', 'error');
    }
  }

  function startEdit(persona) {
    state.editing = {
      id: persona.id,
      name: persona.name,
      description: persona.description,
      systemPrompt: persona.systemPrompt,
    };
    renderMenu();
    setTimeout(() => {
      const input = state.menu.querySelector('.personas-editor__prompt');
      if (input) input.focus();
    }, 30);
  }

  function startCreate() {
    state.editing = { id: '__new__', name: '', description: '', systemPrompt: '' };
    renderMenu();
    setTimeout(() => {
      const input = state.menu.querySelector('.personas-editor__name');
      if (input) input.focus();
    }, 30);
  }

  async function savePersona(data) {
    const payload = {
      name: data.name,
      description: data.description,
      systemPrompt: data.systemPrompt,
    };

    try {
      if (data.id === '__new__') {
        if (!payload.name) {
          toast('Poné un nombre para la persona.', 'error');
          return;
        }
        const res = await api('/api/personas', { method: 'POST', body: payload });
        state.editing = null;
        await load();
        if (res?.persona) {
          document.dispatchEvent(new CustomEvent('numination:persona-changed', {
            detail: { persona: res.persona },
          }));
        }
        toast('Persona creada.', 'ok');
      } else {
        await api(`/api/personas/${encodeURIComponent(data.id)}`, { method: 'PATCH', body: payload });
        state.editing = null;
        await load();
        const persona = currentPersona();
        document.dispatchEvent(new CustomEvent('numination:persona-changed', {
          detail: { persona },
        }));
        toast('Prompt actualizado.', 'ok');
      }
    } catch (e) {
      toast(e.message || 'No se pudo guardar.', 'error');
    }
  }

  async function removePersona(persona) {
    if (!window.confirm(`¿Eliminar la persona "${persona.name}"?`)) return;
    try {
      await api(`/api/personas/${encodeURIComponent(persona.id)}`, { method: 'DELETE' });
      if (state.activeId === persona.id) {
        state.activeId = null;
        document.dispatchEvent(new CustomEvent('numination:persona-changed', { detail: { persona: null } }));
      }
      await load();
      toast('Persona eliminada.', 'ok');
    } catch (e) {
      toast(e.message || 'No se pudo eliminar.', 'error');
    }
  }

  /* ─── Menú ──────────────────────────────────────────────────────────── */

  function openMenu() {
    if (!state.menu) return;
    state.menu.hidden = false;
    state.open = true;
    state.root?.classList.add('is-open');
    document.addEventListener('click', onOutsideClick, { once: false });
  }

  function closeMenu() {
    if (!state.menu) return;
    state.menu.hidden = true;
    state.open = false;
    state.root?.classList.remove('is-open');
    document.removeEventListener('click', onOutsideClick);
  }

  function onOutsideClick(e) {
    if (!state.root) return;
    if (!state.root.contains(e.target)) closeMenu();
  }

  function toggleMenu() {
    if (state.open) closeMenu();
    else openMenu();
  }

  /* ─── Montaje ───────────────────────────────────────────────────────── */

  function mount(target) {
    const container = typeof target === 'string' ? $(target) : target;
    if (!container) return null;

    if (state.root && state.root.isConnected) return state.root;

    const trigger = el('button', {
      class: 'personas-trigger',
      type: 'button',
      title: 'Elegir persona',
      'aria-haspopup': 'listbox',
      onclick: (e) => {
        e.stopPropagation();
        toggleMenu();
      },
    });

    const menu = el('div', { class: 'personas-menu', role: 'listbox' });
    menu.hidden = true;

    const root = el('div', { class: 'personas-root' }, [trigger, menu]);

    state.root = root;
    state.menu = menu;

    container.appendChild(root);
    renderAll();
    load();

    return root;
  }

  /* ─── API pública ───────────────────────────────────────────────────── */

  window.NumPersonasUI = {
    mount,
    load,
    reload: load,
    get activePersona() { return currentPersona(); },
    get personas() { return state.personas; },
    select: selectPersona,
    open: openMenu,
    close: closeMenu,
  };

  document.addEventListener('DOMContentLoaded', () => {
    const target = document.getElementById('chat-personas') ||
      document.getElementById('personas-dropdown') ||
      document.getElementById('persona-selector');
    if (target) mount(target);
  });
})();

