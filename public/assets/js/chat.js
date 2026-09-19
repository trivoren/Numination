/* ============================================================
   NUMINATION — chat.js  ·  v3.0 "Café con Leche"
   Todo el runtime del chat: persistencia, búsqueda, atajos,
   exportar/importar, comandos, papelera, plantillas y más.
   ============================================================ */

(() => {
  'use strict';

  /* ══════════════════════════════════════════════════════════
     CONFIGURACIÓN GLOBAL
     ══════════════════════════════════════════════════════════ */

  const CONFIG = {
    API_URL: '/api/chat/stream',
    MAX_CHARS: 4000,
    ROLE: 'student',
    MAX_FILE_SIZE: 10 * 1024 * 1024,
    STREAM_TIMEOUT_MS: 45000,
    RETRY_LIMIT: 2,
    RETRY_DELAY_MS: 1200,
    STORAGE_KEY: 'numination-chats-v3',
    STORAGE_TRASH: 'numination-trash-v3',
    STORAGE_PREFS: 'numination-prefs-v3',
    STORAGE_MIGRATE_FROM: ['numination-chats-v2', 'numination-chats-v1'],
    MIGRATE_VERSION: 3,
    PROMPT_HISTORY_MAX: 50,
    TOAST_DURATION: 2600,
    AUTOSAVE_DEBOUNCE_MS: 400,
  };

  const EMOJIS = {
    ok: '✅', warn: '⚠️', err: '❌', info: 'ℹ️',
    trash: '🗑️', pin: '📌', star: '⭐', search: '🔍',
    download: '💾', upload: '📥', copy: '📋', check: '✔️',
  };

  /* ══════════════════════════════════════════════════════════
     ESTADO GLOBAL (módulo)
     ══════════════════════════════════════════════════════════ */

  const State = {
    chats: [],
    trash: [],
    prefs: {
      fontSize: 15,
      compact: false,
      focusMode: false,
      sidebarCollapsed: false,
      autoSpeak: false,
      feedback: {},
      pinnedIds: [],
    },
    currentId: null,
    promptHistory: [],
    promptCursor: -1,
    busy: false,
    attachedFile: null,
    online: navigator.onLine,
    stats: {
      messages: 0,
      words: 0,
      chars: 0,
      sessionStart: Date.now(),
    },
  };

  /* ══════════════════════════════════════════════════════════
     UTILIDADES BÁSICAS
     ══════════════════════════════════════════════════════════ */

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  function debounce(fn, wait) {
    let t;
    return function debounced(...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function throttle(fn, wait) {
    let last = 0;
    return function throttled(...args) {
      const now = Date.now();
      if (now - last < wait) return;
      last = now;
      fn.apply(this, args);
    };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uid(prefix = 'c') {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function nowIso() { return new Date().toISOString(); }

  function fmtTime(ts) {
    try {
      return new Date(ts).toLocaleString('es-CO', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      });
    } catch { return ''; }
  }

  function fmtRelative(ts) {
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return 'hace un momento';
    const m = Math.floor(s / 60);
    if (m < 60) return `hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `hace ${d} d`;
    return fmtTime(ts);
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function countWords(s) {
    return String(s || '').trim().split(/\s+/).filter(Boolean).length;
  }

  function slugify(s) {
    return String(s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 60) || 'conversacion';
  }

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }

  function download(filename, content, mime = 'text/plain') {
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /* ══════════════════════════════════════════════════════════
     STORAGE
     ══════════════════════════════════════════════════════════ */

  const Storage = {
    read(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed ?? fallback;
      } catch { return fallback; }
    },
    write(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e) {
        console.warn('[storage] write failed', e);
        if (e.name === 'QuotaExceededError') {
          toast('El almacenamiento está lleno. Libera conversaciones antiguas.', 'warn');
        }
        return false;
      }
    },
    remove(key) {
      try { localStorage.removeItem(key); return true; } catch { return false; }
    },
  };

  function migrateIfNeeded() {
    const mine = Storage.read(CONFIG.STORAGE_KEY, null);
    if (Array.isArray(mine)) return mine;
    for (const oldKey of CONFIG.STORAGE_MIGRATE_FROM) {
      const old = Storage.read(oldKey, null);
      if (Array.isArray(old) && old.length) {
        const normalized = old.map(normalizeChat);
        Storage.write(CONFIG.STORAGE_KEY, normalized);
        return normalized;
      }
    }
    return [];
  }

  function normalizeChat(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return {
      id: raw.id || uid(),
      title: String(raw.title || 'Sin título'),
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Date.now(),
      pinned: Boolean(raw.pinned),
      tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 6) : [],
      messages: Array.isArray(raw.messages) ? raw.messages.map(normalizeMsg).filter(Boolean) : [],
      meta: raw.meta || {},
    };
  }

  function normalizeMsg(m) {
    if (!m || typeof m !== 'object') return null;
    return {
      role: m.role === 'user' ? 'user' : 'ai',
      content: String(m.content || ''),
      attachment: m.attachment || null,
      imageUrl: m.imageUrl || null,
      ts: Number(m.ts) || Date.now(),
      durationMs: Number(m.durationMs) || 0,
      feedback: m.feedback || null,
    };
  }

  const persistChats = debounce(() => {
    Storage.write(CONFIG.STORAGE_KEY, State.chats);
  }, CONFIG.AUTOSAVE_DEBOUNCE_MS);

  const persistTrash = debounce(() => {
    Storage.write(CONFIG.STORAGE_TRASH, State.trash);
  }, CONFIG.AUTOSAVE_DEBOUNCE_MS);

  const persistPrefs = debounce(() => {
    Storage.write(CONFIG.STORAGE_PREFS, State.prefs);
  }, CONFIG.AUTOSAVE_DEBOUNCE_MS);

  /* ══════════════════════════════════════════════════════════
     TOASTS
     ══════════════════════════════════════════════════════════ */

  let toastHost = null;

  function ensureToastHost() {
    if (toastHost && document.body.contains(toastHost)) return toastHost;
    toastHost = document.createElement('div');
    toastHost.className = 'toast-host';
    toastHost.setAttribute('role', 'status');
    toastHost.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastHost);
    return toastHost;
  }

  function toast(message, kind = 'info', opts = {}) {
    const host = ensureToastHost();
    const el = document.createElement('div');
    el.className = 'toast toast--' + kind;
    el.textContent = message;
    el.dataset.kind = kind;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    const ttl = Number(opts.duration || CONFIG.TOAST_DURATION);
    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 260);
    }, ttl);
    el.addEventListener('click', () => el.remove());
  }

  /* ══════════════════════════════════════════════════════════
     HELPERS DOM
     ══════════════════════════════════════════════════════════ */

  function svg(path, extra = '') {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${path}</svg>`;
  }

  function elFromHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
  }

  function findChat(id) {
    return State.chats.find(c => c.id === id) || null;
  }

  function getCurrent() {
    return State.currentId ? findChat(State.currentId) : null;
  }

  function touchChat(chat) {
    if (!chat) return;
    chat.updatedAt = Date.now();
    persistChats();
  }

  /* ══════════════════════════════════════════════════════════
     CHAT MODEL
     ══════════════════════════════════════════════════════════ */

  function makeTitleFromText(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return 'Nueva conversación';
    return t.length > 48 ? t.slice(0, 45) + '…' : t;
  }

  function createChat(firstText) {
    const chat = {
      id: uid(),
      title: makeTitleFromText(firstText),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      tags: [],
      messages: [],
      meta: { motor: 'auto', source: 'chat.html' },
    };
    State.chats.unshift(chat);
    State.currentId = chat.id;
    persistChats();
    return chat;
  }

  function ensureChat(firstText) {
    return getCurrent() || createChat(firstText);
  }

  function appendMessage(chat, role, content, opts = {}) {
    if (!chat) return null;
    const msg = {
      role,
      content: String(content || ''),
      attachment: opts.attachment || null,
      imageUrl: opts.imageUrl || null,
      ts: Date.now(),
      durationMs: opts.durationMs || 0,
      feedback: null,
    };
    chat.messages.push(msg);
    chat.updatedAt = Date.now();
    State.stats.messages++;
    State.stats.words += countWords(msg.content);
    State.stats.chars += msg.content.length;
    persistChats();
    return msg;
  }

  function deleteChat(id, { soft = true } = {}) {
    const idx = State.chats.findIndex(c => c.id === id);
    if (idx === -1) return;
    const [removed] = State.chats.splice(idx, 1);
    if (soft) {
      removed.deletedAt = Date.now();
      State.trash.unshift(removed);
      if (State.trash.length > 100) State.trash.length = 100;
      persistTrash();
      toast('Conversación movida a la papelera.', 'info');
    }
    if (State.currentId === id) State.currentId = null;
    persistChats();
  }

  function restoreFromTrash(id) {
    const idx = State.trash.findIndex(c => c.id === id);
    if (idx === -1) return;
    const [back] = State.trash.splice(idx, 1);
    delete back.deletedAt;
    State.chats.unshift(back);
    persistChats();
    persistTrash();
    toast('Conversación restaurada.', 'ok');
  }

  function emptyTrash() {
    if (!State.trash.length) { toast('La papelera ya está vacía.', 'info'); return; }
    State.trash = [];
    persistTrash();
    toast('Papelera vaciada.', 'ok');
  }

  function togglePin(id) {
    const chat = findChat(id);
    if (!chat) return;
    chat.pinned = !chat.pinned;
    persistChats();
    toast(chat.pinned ? 'Conversación fijada.' : 'Conversación desfijada.', 'info');
  }

  function renameChat(id) {
    const chat = findChat(id);
    if (!chat) return;
    const next = prompt('Nuevo nombre para la conversación:', chat.title);
    if (next === null) return;
    const clean = next.trim();
    if (!clean) return;
    chat.title = clean.slice(0, 80);
    touchChat(chat);
    toast('Conversación renombrada.', 'ok');
  }

  /* ══════════════════════════════════════════════════════════
     BÚSQUEDA
     ══════════════════════════════════════════════════════════ */

  function searchChats(query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return State.chats.slice();
    const out = [];
    for (const chat of State.chats) {
      const inTitle = chat.title.toLowerCase().includes(q);
      const inMsgs = chat.messages.some(m => m.content.toLowerCase().includes(q));
      if (inTitle || inMsgs) out.push(chat);
    }
    return out;
  }

  /* ══════════════════════════════════════════════════════════
     EXPORTAR / IMPORTAR / COMPARTIR
     ══════════════════════════════════════════════════════════ */

  function chatToMarkdown(chat) {
    const lines = [];
    lines.push(`# ${chat.title}`);
    lines.push('');
    lines.push(`_Creado: ${fmtTime(chat.createdAt)} · Mensajes: ${chat.messages.length}_`);
    lines.push('');
    lines.push('---');
    lines.push('');
    for (const m of chat.messages) {
      const who = m.role === 'user' ? '**Tú**' : '**Numination**';
      lines.push(`### ${who}`);
      lines.push('');
      lines.push(m.content || '_(sin contenido)_');
      if (m.attachment) lines.push(`\n> 📎 Adjunto: ${m.attachment.name || 'archivo'}`);
      if (m.imageUrl) lines.push(`\n![imagen](${m.imageUrl})`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
    lines.push('_Generado por Numination · Hecho en Colombia_');
    return lines.join('\n');
  }

  function chatToText(chat) {
    const lines = [];
    lines.push(chat.title);
    lines.push('='.repeat(chat.title.length));
    lines.push('');
    for (const m of chat.messages) {
      lines.push(`[${m.role === 'user' ? 'Tú' : 'Numination'}]`);
      lines.push(m.content || '');
      lines.push('');
    }
    return lines.join('\n');
  }

  function chatToJson(chat) {
    return JSON.stringify({
      version: CONFIG.MIGRATE_VERSION,
      exportedAt: nowIso(),
      chat,
    }, null, 2);
  }

  function exportChat(chat, format = 'md') {
    if (!chat) { toast('No hay conversación activa.', 'warn'); return; }
    const slug = slugify(chat.title);
    if (format === 'json') {
      download(`numination-${slug}.json`, chatToJson(chat), 'application/json');
    } else if (format === 'txt') {
      download(`numination-${slug}.txt`, chatToText(chat), 'text/plain');
    } else {
      download(`numination-${slug}.md`, chatToMarkdown(chat), 'text/markdown');
    }
    toast('Conversación exportada.', 'ok');
  }

  function exportAll() {
    if (!State.chats.length) { toast('No hay conversaciones para exportar.', 'warn'); return; }
    const payload = {
      version: CONFIG.MIGRATE_VERSION,
      exportedAt: nowIso(),
      count: State.chats.length,
      chats: State.chats,
    };
    download('numination-backup.json', JSON.stringify(payload, null, 2), 'application/json');
    toast(`Backup de ${State.chats.length} conversaciones exportado.`, 'ok');
  }

  function importFromFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('El archivo es muy grande.', 'warn'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        const incoming = Array.isArray(data) ? data : (data.chats || [data.chat]);
        const valid = incoming.map(normalizeChat).filter(Boolean);
        if (!valid.length) throw new Error('sin chats');
        let added = 0;
        const existingIds = new Set(State.chats.map(c => c.id));
        for (const c of valid) {
          if (existingIds.has(c.id)) c.id = uid();
          State.chats.unshift(c);
          added++;
        }
        persistChats();
        toast(`${added} conversación(es) importada(s).`, 'ok');
      } catch (e) {
        console.warn(e);
        toast('El archivo no tiene el formato correcto.', 'err');
      }
    };
    reader.readAsText(file);
  }

  function shareChat(chat) {
    if (!chat) { toast('No hay conversación para compartir.', 'warn'); return; }
    try {
      const payload = btoa(unescape(encodeURIComponent(JSON.stringify({
        t: chat.title,
        m: chat.messages.map(m => ({ r: m.role, c: m.content })),
      }))));
      const url = location.origin + location.pathname + '#share=' + payload;
      copyToClipboard(url).then(ok => {
        if (ok) toast('Link copiado al portapapeles.', 'ok');
        else toast('Copia el link desde la consola.', 'info');
        console.log('[share]', url);
      });
    } catch (e) {
      toast('No se pudo generar el link.', 'err');
    }
  }

  function tryLoadShared() {
    if (!location.hash.startsWith('#share=')) return false;
    try {
      const payload = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(7)))));
      const chat = {
        id: uid(),
        title: payload.t || 'Conversación compartida',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: (payload.m || []).map(m => ({
          role: m.r, content: m.c, ts: Date.now(),
        })),
      };
      State.chats.unshift(chat);
      State.currentId = chat.id;
      persistChats();
      history.replaceState(null, '', location.pathname);
      return true;
    } catch { return false; }
  }

  /* ══════════════════════════════════════════════════════════
     PLANTILLAS DE PROMPTS
     ══════════════════════════════════════════════════════════ */

  const TEMPLATES = [
    { icon: '🧮', title: 'Explicar matemática', body: 'Explícame paso a paso cómo resolver [tema], con un ejemplo sencillo y un ejercicio final.' },
    { icon: '📖', title: 'Resumen de texto', body: 'Resume este texto en 5 ideas clave y dime cuál es la idea principal: [pega aquí]' },
    { icon: '🧪', title: 'Experimento casero', body: 'Proponme un experimento casero para entender [concepto], con materiales que tenga en casa.' },
    { icon: '📝', title: 'Ensayo argumentativo', body: 'Ayúdame a estructurar un ensayo sobre [tema], con tesis, 3 argumentos y conclusión.' },
    { icon: '🌎', title: 'Contexto Colombia', body: 'Explícame [tema] con un ejemplo colombiano que pueda entender fácilmente.' },
    { icon: '📅', title: 'Plan de estudio', body: 'Hazme un plan de estudio de 7 días para dominar [tema], con horas y metas diarias.' },
    { icon: '🎯', title: 'Simulacro Saber 11', body: 'Genera 5 preguntas tipo ICFES sobre [tema] con su explicación.' },
    { icon: '🗣️', title: 'Exposición oral', body: 'Ayúdame a preparar una exposición de 5 minutos sobre [tema] con introducción, cuerpo y cierre.' },
    { icon: '🧠', title: 'Mnemotecnia', body: 'Dame una regla mnemotécnica divertida para recordar [tema].' },
    { icon: '🖼️', title: 'Generar imagen', body: 'Genera una imagen educativa sobre [tema] que pueda usar en clase.' },
    { icon: '🔍', title: 'Analogía simple', body: 'Explícame [tema] como si tuviera 10 años, usando una analogía de la vida diaria.' },
    { icon: '💡', title: 'Lluvia de ideas', body: 'Dame 10 ideas originales sobre [tema] para un proyecto escolar.' },
  ];

  /* ══════════════════════════════════════════════════════════
     ATAJOS DE TECLADO
     ══════════════════════════════════════════════════════════ */

  const Shortcuts = {
    bind(ctx) {
      document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const tag = (e.target.tagName || '').toLowerCase();
        const typing = tag === 'input' || tag === 'textarea';

        // Ctrl+K: buscar
        if (mod && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          ctx.openSearch();
          return;
        }
        // Ctrl+B: nueva conversación
        if (mod && e.key.toLowerCase() === 'b') {
          e.preventDefault();
          ctx.newChat();
          return;
        }
        // Ctrl+/: atajos
        if (mod && e.key === '/') {
          e.preventDefault();
          ctx.showShortcuts();
          return;
        }
        // Ctrl+Shift+E: exportar MD
        if (mod && e.shiftKey && e.key.toLowerCase() === 'e') {
          e.preventDefault();
          exportChat(getCurrent(), 'md');
          return;
        }
        // Ctrl+Shift+S: modo enfoque
        if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
          e.preventDefault();
          ctx.toggleFocusMode();
          return;
        }
        // Escape: cerrar modales
        if (e.key === 'Escape') {
          ctx.closeAllModals();
          return;
        }
        // Alt+1..9: cargar chat N
        if (e.altKey && /^[1-9]$/.test(e.key)) {
          const idx = parseInt(e.key, 10) - 1;
          const sorted = sortChats(State.chats);
          if (sorted[idx]) ctx.loadChat(sorted[idx].id);
          return;
        }
        // Flechas arriba/abajo dentro del field: recorrer historial de prompts
        if (typing && e.target.matches('[data-chat-field]')) {
          if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey) {
            const cur = e.target.value.trim();
            if (!cur || State.promptCursor === State.promptHistory.length) {
              if (State.promptHistory.length) {
                e.preventDefault();
                State.promptCursor = State.promptHistory.length - 1;
                e.target.value = State.promptHistory[State.promptCursor];
                ctx.triggerResize();
              }
            } else if (State.promptCursor > 0) {
              e.preventDefault();
              State.promptCursor--;
              e.target.value = State.promptHistory[State.promptCursor];
              ctx.triggerResize();
            }
          } else if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey) {
            if (State.promptCursor >= 0 && State.promptCursor < State.promptHistory.length - 1) {
              e.preventDefault();
              State.promptCursor++;
              e.target.value = State.promptHistory[State.promptCursor];
              ctx.triggerResize();
            } else if (State.promptCursor === State.promptHistory.length - 1) {
              e.preventDefault();
              State.promptCursor = State.promptHistory.length;
              e.target.value = '';
              ctx.triggerResize();
            }
          }
        }
      });
    },
  };

  function sortChats(list) {
    return [...list].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });
  }

  /* ══════════════════════════════════════════════════════════
     MODALES LIGEROS
     ══════════════════════════════════════════════════════════ */

  function openModal({ title, body, actions = [], className = '' }) {
    const existing = $('.nm-modal-backdrop');
    if (existing) existing.remove();

    const back = document.createElement('div');
    back.className = 'nm-modal-backdrop';
    back.innerHTML = `
      <div class="nm-modal ${className}" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <header class="nm-modal__head">
          <h2 class="nm-modal__title">${escapeHtml(title)}</h2>
          <button class="nm-modal__close" type="button" aria-label="Cerrar">${svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}</button>
        </header>
        <div class="nm-modal__body"></div>
        <footer class="nm-modal__foot"></footer>
      </div>
    `;
    back.querySelector('.nm-modal__body').appendChild(
      typeof body === 'string' ? elFromHtml(`<div>${body}</div>`) : body
    );
    const foot = back.querySelector('.nm-modal__foot');
    for (const a of actions) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ' + (a.variant || 'btn--ghost');
      btn.textContent = a.label;
      btn.addEventListener('click', () => {
        try { a.onClick && a.onClick(back); } finally { if (a.close !== false) back.remove(); }
      });
      foot.appendChild(btn);
    }
    back.querySelector('.nm-modal__close').addEventListener('click', () => back.remove());
    back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
    document.body.appendChild(back);
    const input = back.querySelector('input, textarea');
    if (input) setTimeout(() => input.focus(), 60);
    return back;
  }

  /* ══════════════════════════════════════════════════════════
     COMPONENTES DEL SIDEBAR
     ══════════════════════════════════════════════════════════ */

  function buildHistoryItem(chat) {
    const li = document.createElement('li');
    li.className = 'sidebar__history-item';
    if (chat.id === State.currentId) li.classList.add('is-active');
    if (chat.pinned) li.classList.add('is-pinned');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sidebar__history-btn';
    btn.dataset.chatId = chat.id;
    btn.setAttribute('title', `${chat.title} · ${fmtRelative(chat.updatedAt)}`);

    const icon = chat.pinned ? '📌' : '💬';
    btn.innerHTML = `
      <span class="sidebar__history-ico">${icon}</span>
      <span class="sidebar__history-txt">${escapeHtml(chat.title)}</span>
    `;
    li.appendChild(btn);

    const actions = document.createElement('div');
    actions.className = 'sidebar__history-actions';

    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'sidebar__history-act';
    pinBtn.title = chat.pinned ? 'Desfijar' : 'Fijar';
    pinBtn.dataset.chatPin = chat.id;
    pinBtn.innerHTML = chat.pinned ? '★' : '☆';

    const renameBtn = document.createElement('button');
    renameBtn.type = 'button';
    renameBtn.className = 'sidebar__history-act';
    renameBtn.title = 'Renombrar';
    renameBtn.dataset.chatRename = chat.id;
    renameBtn.innerHTML = '✎';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'sidebar__history-act sidebar__history-act--danger';
    delBtn.title = 'Eliminar';
    delBtn.dataset.chatDel = chat.id;
    delBtn.innerHTML = '🗑';

    actions.appendChild(pinBtn);
    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);
    li.appendChild(actions);

    return li;
  }

  /* ══════════════════════════════════════════════════════════
     INICIALIZACIÓN PRINCIPAL
     ══════════════════════════════════════════════════════════ */

  document.addEventListener('DOMContentLoaded', () => {
    const app = $('.chat-app');
    if (!app) return;
    initChat();
  });

  function initChat() {
    /* ─── Referencias DOM ─── */
    const form       = $('[data-chat-form]');
    const field      = $('[data-chat-field]');
    const sendBtn    = $('[data-chat-send]');
    const scroll     = $('[data-chat-messages]');
    const empty      = $('[data-chat-empty]');
    const thread     = $('[data-chat-thread]');
    const newBtn     = $('[data-chat-new]');
    const historyEl  = $('[data-chat-history]');
    const historyEmp = $('[data-chat-history-empty]');
    const sidebarEl  = $('[data-chat-sidebar]');
    const overlay    = $('[data-chat-sidebar-overlay]');
    const sbOpen     = $('[data-chat-sidebar-open]');
    const sbClose    = $('[data-chat-sidebar-close]');

    if (!form || !field || !sendBtn || !scroll || !thread) return;

    /* ─── Estado local ─── */
    let busy = false;
    let attachedFile = null;
    let typingEl = null;

    /* ─── Cargar storage ─── */
    State.chats = migrateIfNeeded();
    State.trash = Storage.read(CONFIG.STORAGE_TRASH, []);
    State.prefs = { ...State.prefs, ...Storage.read(CONFIG.STORAGE_PREFS, {}) };
    applyPrefs();

    if (tryLoadShared()) {
      toast('Conversación compartida cargada.', 'ok');
    }

    /* ─── SIDEBAR MÓVIL ─── */
    if (sbOpen) sbOpen.addEventListener('click', () => {
      sidebarEl?.classList.add('is-open');
      overlay?.classList.add('is-open');
    });
    const closeSidebar = () => {
      sidebarEl?.classList.remove('is-open');
      overlay?.classList.remove('is-open');
    };
    sbClose?.addEventListener('click', closeSidebar);
    overlay?.addEventListener('click', closeSidebar);

    /* ─── RESIZE / SEND ─── */
    const resize = () => {
      field.style.height = 'auto';
      field.style.height = Math.min(field.scrollHeight, 200) + 'px';
    };
    const updateSend = () => {
      sendBtn.disabled = busy || field.value.trim().length === 0;
    };
    field.addEventListener('input', () => {
      if (field.value.length > CONFIG.MAX_CHARS) field.value = field.value.slice(0, CONFIG.MAX_CHARS);
      resize();
      updateSend();
      handleSlashCommands(field.value);
    });
    field.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    /* ─── SUGERENCIAS ─── */
    $$('[data-suggestion]').forEach((btn) => {
      btn.addEventListener('click', () => {
        field.value = btn.dataset.suggestion || '';
        resize();
        updateSend();
        field.focus();
      });
    });

    /* ─── ADJUNTOS ─── */
    let fileInput = document.getElementById('file-input');
    if (!fileInput) {
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.id = 'file-input';
      fileInput.hidden = true;
      fileInput.accept = 'image/*,.pdf,.txt,.doc,.docx,.xls,.xlsx,.csv,.json';
      document.body.appendChild(fileInput);
    }
    const attachBtn = $('[data-attach-btn]');
    const previewEl = $('[data-attach-preview]');
    const previewName = $('[data-attach-name]');
    const previewSize = $('[data-attach-size]');
    const previewRemove = $('[data-attach-remove]');

    attachBtn?.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) processFile(f);
    });
    previewRemove?.addEventListener('click', () => {
      attachedFile = null;
      fileInput.value = '';
      renderAttachPreview();
    });
    field.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) { e.preventDefault(); processFile(f); }
          return;
        }
      }
    });

    /* Drag & drop de archivos */
    ['dragenter', 'dragover'].forEach(ev => {
      scroll.addEventListener(ev, (e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          scroll.classList.add('is-dragover');
        }
      });
    });
    ['dragleave', 'drop'].forEach(ev => {
      scroll.addEventListener(ev, (e) => {
        scroll.classList.remove('is-dragover');
      });
    });
    scroll.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      processFile(e.dataTransfer.files[0]);
    });

    function processFile(file) {
      if (file.size > CONFIG.MAX_FILE_SIZE) { toast('El archivo supera los 10 MB.', 'warn'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result);
        const commaIdx = result.indexOf(',');
        const base64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
        attachedFile = {
          name: file.name || 'archivo',
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          data: base64,
        };
        renderAttachPreview();
      };
      reader.onerror = () => toast('No se pudo leer el archivo.', 'err');
      reader.readAsDataURL(file);
    }

    function renderAttachPreview() {
      if (!previewEl) return;
      if (!attachedFile) {
        previewEl.hidden = true;
        attachBtn?.classList.remove('has-file');
        return;
      }
      previewEl.hidden = false;
      attachBtn?.classList.add('has-file');
      if (previewName) previewName.textContent = attachedFile.name;
      if (previewSize) previewSize.textContent = fmtSize(attachedFile.size);
    }

    /* ─── DICTADO ─── */
    const micBtn = document.getElementById('mic-btn');
    let recognition = null;
    let listening = false;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (micBtn && SR) {
      recognition = new SR();
      recognition.lang = 'es-CO';
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.onstart = () => {
        listening = true;
        micBtn.classList.add('is-listening');
        field.placeholder = 'Escuchando…';
      };
      recognition.onresult = (e) => {
        let finalTxt = '', interimTxt = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalTxt += t; else interimTxt += t;
        }
        const base = field.dataset.voiceBase || '';
        field.value = base + finalTxt + interimTxt;
        resize(); updateSend();
      };
      recognition.onend = () => {
        listening = false;
        micBtn.classList.remove('is-listening');
        field.placeholder = 'Pregúntale algo a Numination…';
        delete field.dataset.voiceBase;
      };
      recognition.onerror = (e) => {
        console.warn('[audio]', e.error);
        if (e.error === 'not-allowed') toast('Necesito permiso para usar el micrófono.', 'warn');
        listening = false;
        micBtn.classList.remove('is-listening');
      };
      micBtn.addEventListener('click', () => {
        if (listening) { recognition.stop(); return; }
        field.dataset.voiceBase = field.value ? field.value + ' ' : '';
        try { recognition.start(); } catch {}
      });
    } else if (micBtn) {
      micBtn.style.display = 'none';
    }

    /* ─── HISTORIAL: clicks ─── */
    historyEl?.addEventListener('click', (e) => {
      const delBtn = e.target.closest('[data-chat-del]');
      if (delBtn) { e.stopPropagation(); deleteChat(delBtn.dataset.chatDel); renderHistory(); return; }
      const pinBtn = e.target.closest('[data-chat-pin]');
      if (pinBtn) { e.stopPropagation(); togglePin(pinBtn.dataset.chatPin); renderHistory(); return; }
      const renBtn = e.target.closest('[data-chat-rename]');
      if (renBtn) { e.stopPropagation(); renameChat(renBtn.dataset.chatRename); renderHistory(); return; }
      const loadBtn = e.target.closest('[data-chat-id]');
      if (loadBtn) { loadChat(loadBtn.dataset.chatId); closeSidebar(); }
    });

    /* ─── NUEVO CHAT ─── */
    newBtn?.addEventListener('click', newChat);

    /* ─── SUBMIT ─── */
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const text = field.value.trim();
      if (!text) { field.focus(); return; }

      if (text.startsWith('/')) {
        const handled = await runSlashCommand(text);
        if (handled) { field.value = ''; resize(); updateSend(); return; }
      }

      const attachment = attachedFile;
      attachedFile = null;
      if (fileInput) fileInput.value = '';
      renderAttachPreview();

      field.value = '';
      resize();
      if (empty) empty.style.display = 'none';

      // Push al historial de prompts
      State.promptHistory.push(text);
      if (State.promptHistory.length > CONFIG.PROMPT_HISTORY_MAX) State.promptHistory.shift();
      State.promptCursor = State.promptHistory.length;

      const chat = ensureChat(text);
      addMessage(thread, 'user', text, attachment);
      appendMessage(chat, 'user', text, { attachment });
      renderHistory();

      busy = true; updateSend();
      typingEl = addTyping(thread);
      scroll.scrollTop = scroll.scrollHeight;

      const t0 = performance.now();
      try {
        const answer = await sendStream({ message: text, role: CONFIG.ROLE, file: attachment });
        typingEl.remove();
        typingEl = null;
        const dur = Math.round(performance.now() - t0);
        if (answer.error) {
          const msg = '⚠️ ' + answer.error;
          addMessage(thread, 'ai', msg);
          appendMessage(chat, 'ai', msg, { durationMs: dur });
        } else {
          const live = answer.live;
          finalizeBubble(live, answer.fullText);
          if (answer.fullText.trim()) {
            appendMessage(chat, 'ai', answer.fullText, { durationMs: dur });
          }
        }
        renderHistory();
        if (State.prefs.autoSpeak && answer.fullText) speak(answer.fullText);
      } catch (err) {
        typingEl?.remove();
        typingEl = null;
        const msg = '⚠️ No se pudo conectar con el servidor.\n\nDetalle: ' + err.message;
        addMessage(thread, 'ai', msg);
        appendMessage(chat, 'ai', msg);
      } finally {
        busy = false; updateSend(); field.focus();
      }
    });
    /* ─── Panel de configuración ─── */
    function openSettings() {
      // Si ya está abierto, no duplicar
      if ($('.nm-settings-modal')) return;

      const back = document.createElement('div');
      back.className = 'nm-modal-backdrop';
      back.style.padding = '20px';

      const modal = document.createElement('div');
      modal.className = 'nm-settings-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('aria-label', 'Configuración');

      const themeMode = document.documentElement.dataset.themeMode || 'auto';
      const fontSize = State.prefs.fontSize || 15;

      modal.innerHTML = `
        <aside class="nm-settings-nav">
          <h2 class="nm-settings-nav__title">Configuración</h2>
          <button type="button" class="nm-settings-nav__item is-active" data-panel="apariencia">
            ${svg('<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>')}
            <span>Apariencia</span>
          </button>
          <button type="button" class="nm-settings-nav__item" data-panel="comportamiento">
            ${svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>')}
            <span>Comportamiento</span>
          </button>
          <button type="button" class="nm-settings-nav__item" data-panel="datos">
            ${svg('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>')}
            <span>Datos</span>
          </button>
          <div class="nm-settings-nav__spacer"></div>
          <button type="button" class="nm-settings-nav__close" data-close>Cerrar</button>
        </aside>

        <main class="nm-settings-main">

          <!-- APARIENCIA -->
          <section class="nm-settings-panel is-active" data-panel-content="apariencia">
            <h3 class="nm-settings-panel__title">Apariencia</h3>
            <p class="nm-settings-panel__sub">Personaliza cómo se ve Numination.</p>

            <div class="nm-setting">
              <div class="nm-setting__info">
                <span class="nm-setting__label">Tema</span>
                <span class="nm-setting__hint">Claro, oscuro o automático por hora</span>
              </div>
              <div class="nm-seg" data-seg="theme">
                <button type="button" data-value="light" class="${themeMode === 'light' ? 'is-active' : ''}">☀ Claro</button>
                <button type="button" data-value="dark" class="${themeMode === 'dark' ? 'is-active' : ''}">☾ Oscuro</button>
                <button type="button" data-value="auto" class="${themeMode === 'auto' ? 'is-active' : ''}">◐ Auto</button>
              </div>
            </div>

            <div class="nm-setting">
              <div class="nm-setting__info">
                <span class="nm-setting__label">Tamaño de texto</span>
                <span class="nm-setting__hint">Ajusta el tamaño del chat</span>
              </div>
              <div class="nm-step" data-step="fontSize">
                <button type="button" data-action="dec">A−</button>
                <span data-display>${fontSize}</span>
                <button type="button" data-action="inc">A+</button>
              </div>
            </div>

            <div class="nm-setting">
              <div class="nm-setting__info">
                <span class="nm-setting__label">Modo compacto</span>
                <span class="nm-setting__hint">Más mensajes por pantalla</span>
              </div>
              <button type="button" class="nm-switch ${State.prefs.compact ? 'is-on' : ''}" data-switch="compact" role="switch" aria-checked="${!!State.prefs.compact}"></button>
            </div>

            <div class="nm-setting">
              <div class="nm-setting__info">
                <span class="nm-setting__label">Alto contraste</span>
                <span class="nm-setting__hint">Mejora la legibilidad del texto</span>
              </div>
              <button type="button" class="nm-switch ${document.body.classList.contains('high-contrast') ? 'is-on' : ''}" data-switch="contrast" role="switch"></button>
            </div>
          </section>

          <!-- COMPORTAMIENTO -->
          <section class="nm-settings-panel" data-panel-content="comportamiento">
            <h3 class="nm-settings-panel__title">Comportamiento</h3>
            <p class="nm-settings-panel__sub">Cómo se comporta el chat mientras trabajas.</p>

            <div class="nm-setting">
              <div class="nm-setting__info">
                <span class="nm-setting__label">Modo enfoque</span>
                <span class="nm-setting__hint">Oculta la barra lateral y centra el chat</span>
              </div>
              <button type="button" class="nm-switch ${State.prefs.focusMode ? 'is-on' : ''}" data-switch="focusMode" role="switch" aria-checked="${!!State.prefs.focusMode}"></button>
            </div>

            <div class="nm-setting">
              <div class="nm-setting__info">
                <span class="nm-setting__label">Leer respuestas en voz alta</span>
                <span class="nm-setting__hint">Reproduce automáticamente cada respuesta</span>
              </div>
              <button type="button" class="nm-switch ${State.prefs.autoSpeak ? 'is-on' : ''}" data-switch="autoSpeak" role="switch" aria-checked="${!!State.prefs.autoSpeak}"></button>
            </div>

            <div class="nm-setting">
              <div class="nm-setting__info">
                <span class="nm-setting__label">Movimiento reducido</span>
                <span class="nm-setting__hint">Desactiva animaciones (se detecta automático)</span>
              </div>
              <button type="button" class="nm-switch ${document.body.classList.contains('reduced-motion') ? 'is-on' : ''}" data-switch="reducedMotion" role="switch" disabled style="opacity:.6;cursor:not-allowed"></button>
            </div>
          </section>

          <!-- DATOS -->
          <section class="nm-settings-panel" data-panel-content="datos">
            <h3 class="nm-settings-panel__title">Datos</h3>
            <p class="nm-settings-panel__sub">Todo se guarda en tu navegador. Nada viaja a servidores externos.</p>

            <div class="nm-actions">
              <button type="button" class="nm-action-btn" data-action="exportall">
                <span class="nm-action-btn__ico">💾</span>
                <span class="nm-action-btn__label">
                  <strong>Exportar todo</strong>
                  <small>Descarga un backup JSON con todas las conversaciones</small>
                </span>
              </button>
              <button type="button" class="nm-action-btn" data-action="import">
                <span class="nm-action-btn__ico">📥</span>
                <span class="nm-action-btn__label">
                  <strong>Importar</strong>
                  <small>Restaura desde un archivo de backup</small>
                </span>
              </button>
              <button type="button" class="nm-action-btn" data-action="trash">
                <span class="nm-action-btn__ico">🗑️</span>
                <span class="nm-action-btn__label">
                  <strong>Papelera</strong>
                  <small>Recupera conversaciones borradas</small>
                </span>
              </button>
            </div>

            <div class="nm-setting" style="margin-top:20px;padding-top:20px;border-top:1px solid var(--c-border)">
              <div class="nm-setting__info">
                <span class="nm-setting__label">Borrar todos los datos</span>
                <span class="nm-setting__hint">Elimina conversaciones, preferencias y papelera</span>
              </div>
              <button type="button" class="nm-btn-danger" data-action="clear">Borrar todo</button>
            </div>
          </section>

          <footer class="nm-settings-footer">
            <span>Numination v1.4</span>
            <span class="nm-settings-footer__dot">·</span>
            <a data-action="shortcuts">Ver atajos de teclado</a>
            <span class="nm-settings-footer__dot">·</span>
            <a data-action="share">Compartir esta conversación</a>
          </footer>
        </main>
      `;

      back.appendChild(modal);
      document.body.appendChild(back);
      document.body.classList.add('has-modal');

      // Cerrar
      const close = () => {
        back.remove();
        document.body.classList.remove('has-modal');
      };
      modal.querySelector('[data-close]').addEventListener('click', close);
      back.addEventListener('click', (e) => { if (e.target === back) close(); });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
      });

      // Navegación entre paneles
      modal.querySelectorAll('.nm-settings-nav__item').forEach(btn => {
        btn.addEventListener('click', () => {
          modal.querySelectorAll('.nm-settings-nav__item').forEach(b => b.classList.remove('is-active'));
          btn.classList.add('is-active');
          const target = btn.dataset.panel;
          modal.querySelectorAll('.nm-settings-panel').forEach(p => {
            p.classList.toggle('is-active', p.dataset.panelContent === target);
          });
        });
      });

      // Tema
      modal.querySelectorAll('[data-seg="theme"] button').forEach(btn => {
        btn.addEventListener('click', () => {
          const val = btn.dataset.value;
          const mode = val === 'auto' ? 'auto' : val;
          localStorage.setItem('numination-theme', JSON.stringify(mode));
          if (window.__numination?.Theme?.set) {
            window.__numination.Theme.set(mode);
          } else {
            // fallback: aplicar directo
            const resolved = mode === 'auto'
              ? (new Date().getHours() >= 6 && new Date().getHours() < 18 ? 'light' : 'dark')
              : mode;
            document.documentElement.dataset.theme = resolved;
            document.documentElement.dataset.themeMode = mode;
          }
          modal.querySelectorAll('[data-seg="theme"] button').forEach(b => b.classList.remove('is-active'));
          btn.classList.add('is-active');
        });
      });

      // Tamaño de fuente
      const stepDisplay = modal.querySelector('[data-step="fontSize"] [data-display]');
      modal.querySelectorAll('[data-step="fontSize"] button').forEach(btn => {
        btn.addEventListener('click', () => {
          const delta = btn.dataset.action === 'inc' ? 1 : -1;
          State.prefs.fontSize = Math.max(12, Math.min(22, (State.prefs.fontSize || 15) + delta));
          persistPrefs();
          document.body.style.fontSize = State.prefs.fontSize + 'px';
          stepDisplay.textContent = State.prefs.fontSize;
          document.documentElement.style.setProperty('--c-font-size', State.prefs.fontSize + 'px');
        });
      });

      // Switches
      modal.querySelectorAll('.nm-switch').forEach(sw => {
        sw.addEventListener('click', () => {
          if (sw.disabled) return;
          const key = sw.dataset.switch;
          const on = !sw.classList.contains('is-on');
          sw.classList.toggle('is-on', on);
          sw.setAttribute('aria-checked', String(on));
          if (key === 'compact') {
            State.prefs.compact = on;
            document.body.classList.toggle('is-compact', on);
            persistPrefs();
          } else if (key === 'focusMode') {
            State.prefs.focusMode = on;
            document.body.classList.toggle('is-focus-mode', on);
            persistPrefs();
          } else if (key === 'autoSpeak') {
            State.prefs.autoSpeak = on;
            persistPrefs();
          } else if (key === 'contrast') {
            document.body.classList.toggle('high-contrast', on);
            localStorage.setItem('numination-contrast', JSON.stringify(on));
          }
        });
      });

      // Acciones de la sección Datos
      modal.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const action = btn.dataset.action;
          if (action === 'exportall') {
            exportAll();
          } else if (action === 'import') {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.addEventListener('change', () => {
              const f = input.files?.[0];
              if (f) {
                importFromFile(f);
                setTimeout(() => { close(); setTimeout(openSettings, 200); }, 400);
              }
            });
            input.click();
          } else if (action === 'trash') {
            close();
            setTimeout(() => showTrash(), 150);
          } else if (action === 'clear') {
            if (confirm('¿Borrar TODO? Conversaciones, preferencias y papelera. Esta acción no se puede deshacer.')) {
              Object.keys(localStorage).forEach(k => {
                if (k.startsWith('numination-')) localStorage.removeItem(k);
              });
              location.reload();
            }
          } else if (action === 'shortcuts') {
            close();
            setTimeout(() => showShortcuts(), 150);
          } else if (action === 'share') {
            shareChat(getCurrent());
          }
        });
      });
    }

    // Exponer para el botón del sidebar
    window.__openSettings = openSettings;
    /* ─── API interna ─── */
    async function sendStream({ message, role, file }) {
      const body = { message, role };
      if (file) body.file = { data: file.data, mimeType: file.mimeType, name: file.name };

      let attempt = 0;
      let lastErr = null;
      while (attempt <= CONFIG.RETRY_LIMIT) {
        try {
          const res = await fetch(CONFIG.API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!res.ok || !res.body) {
            let errMsg = 'HTTP ' + res.status;
            try { const d = await res.json(); if (d?.error) errMsg = d.error; } catch {}
            return { error: errMsg };
          }
          return await readStream(res);
        } catch (err) {
          lastErr = err;
          attempt++;
          if (attempt <= CONFIG.RETRY_LIMIT) {
            toast(`Reintentando (${attempt}/${CONFIG.RETRY_LIMIT})…`, 'warn', { duration: 1600 });
            await new Promise(r => setTimeout(r, CONFIG.RETRY_DELAY_MS));
          }
        }
      }
      throw lastErr;
    }

    async function readStream(res) {
      const live = createLiveBubble(thread);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let finished = false;

      while (true) {
        const timeout = new Promise((_, rej) =>
          setTimeout(() => rej(new Error('timeout')), CONFIG.STREAM_TIMEOUT_MS)
        );
        let race;
        try { race = await Promise.race([reader.read(), timeout]); }
        catch (err) {
          try { await reader.cancel(); } catch {}
          break;
        }
        const { value, done } = race;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          try {
            const evt = JSON.parse(part.slice(6));
            if (evt.error) appendToBubble(live, '\n\n⚠️ ' + evt.error);
            else if (evt.token) { appendToBubble(live, evt.token); fullText += evt.token; }
            if (evt.done && !finished) { finished = true; finalizeBubble(live, fullText); }
          } catch {}
        }
        scroll.scrollTop = scroll.scrollHeight;
      }
      if (!finished) finalizeBubble(live, fullText);
      return { live, fullText };
    }

    /* ─── Render historial ─── */
    function renderHistory(filterQuery = '') {
      if (!historyEl) return;
      historyEl.innerHTML = '';
      const list = sortChats(filterQuery ? searchChats(filterQuery) : State.chats);
      if (!list.length) {
        if (historyEmp) historyEmp.style.display = '';
        return;
      }
      if (historyEmp) historyEmp.style.display = 'none';
      for (const chat of list) historyEl.appendChild(buildHistoryItem(chat));
    }

    /* ─── Cargar chat ─── */
    function loadChat(id) {
      const chat = findChat(id);
      if (!chat) return;
      State.currentId = id;
      thread.innerHTML = '';
      if (empty) empty.style.display = 'none';
      for (const m of chat.messages) {
        addMessage(thread, m.role, m.content, m.attachment, m.imageUrl, m);
      }
      scroll.scrollTop = scroll.scrollHeight;
      renderHistory();
    }

    /* ─── Nuevo chat ─── */
    function newChat() {
      State.currentId = null;
      thread.innerHTML = '';
      if (empty) empty.style.display = '';
      busy = false; attachedFile = null;
      field.value = '';
      updateSend(); renderHistory(); field.focus();
      closeSidebar();
    }

    /* ─── Comandos slash ─── */
    async function runSlashCommand(raw) {
      const [cmd, ...rest] = raw.slice(1).split(' ');
      const arg = rest.join(' ').trim();
      const c = cmd.toLowerCase();
      switch (c) {
        case 'help':
        case 'ayuda':
          showSlashHelp();
          return true;
        case 'clear':
        case 'limpiar':
          if (!confirm('¿Borrar TODAS las conversaciones del sidebar?')) return true;
          State.chats = []; State.currentId = null;
          persistChats(); thread.innerHTML = '';
          if (empty) empty.style.display = '';
          renderHistory();
          toast('Historial limpio.', 'ok');
          return true;
        case 'export':
        case 'exportar':
          exportChat(getCurrent(), arg || 'md');
          return true;
        case 'exportall':
          exportAll();
          return true;
        case 'save':
        case 'guardar':
          persistChats();
          toast('Guardado.', 'ok');
          return true;
        case 'focus':
        case 'enfoque':
          toggleFocusMode();
          return true;
        case 'theme':
        case 'tema':
          document.querySelector('[data-theme-toggle]')?.click();
          return true;
        case 'compact':
        case 'compacto':
          toggleCompact();
          return true;
        case 'big':
        case 'grande':
          bumpFont(+1);
          return true;
        case 'small':
        case 'pequeño':
          bumpFont(-1);
          return true;
        case 'stats':
        case 'estadisticas':
          showStats();
          return true;
        case 'trash':
        case 'papelera':
          showTrash();
          return true;
        case 'template':
        case 'plantilla':
          showTemplates();
          return true;
        case 'shortcuts':
        case 'atajos':
          showShortcuts();
          return true;
        case 'share':
        case 'compartir':
          shareChat(getCurrent());
          return true;
        case 'import':
        case 'importar':
          fileInput.accept = '.json';
          fileInput.onchange = (e) => {
            const f = e.target.files?.[0];
            if (f) importFromFile(f);
            fileInput.onchange = null;
            fileInput.value = '';
          };
          fileInput.click();
          return true;
        default:
          toast(`Comando desconocido: /${c}. Escribe /help.`, 'warn');
          return true;
      }
    }

    function handleSlashCommands(text) {
      const chip = $('.slash-chip');
      if (text.startsWith('/') && !text.includes(' ')) {
        const partial = text.slice(1).toLowerCase();
        const matches = SLASH_COMMANDS.filter(c => c.cmd.startsWith(partial)).slice(0, 5);
        if (matches.length && partial.length) {
          if (!chip) {
            const el = document.createElement('div');
            el.className = 'slash-chip';
            el.innerHTML = matches.map(c => `<button data-slash="${c.cmd}">/${c.cmd} <small>${c.desc}</small></button>`).join('');
            form.parentElement.appendChild(el);
            el.addEventListener('click', (e) => {
              const b = e.target.closest('[data-slash]');
              if (!b) return;
              field.value = '/' + b.dataset.slash + ' ';
              field.focus(); resize(); updateSend();
              el.remove();
            });
          } else {
            chip.innerHTML = matches.map(c => `<button data-slash="${c.cmd}">/${c.cmd} <small>${c.desc}</small></button>`).join('');
          }
          return;
        }
      }
      chip?.remove();
    }

    /* ─── Atajos: registrar contexto ─── */
    Shortcuts.bind({
      openSearch,
      newChat,
      showShortcuts,
      loadChat,
      closeAllModals: () => $$('.nm-modal-backdrop').forEach(m => m.remove()),
      toggleFocusMode,
      triggerResize: () => { resize(); updateSend(); },
    });

    /* ─── Estado online/offline ─── */
    window.addEventListener('online', () => {
      State.online = true;
      toast('Conexión restaurada.', 'ok');
      updateNetBadge(true);
    });
    window.addEventListener('offline', () => {
      State.online = false;
      toast('Sin conexión. Los mensajes nuevos fallarán.', 'warn');
      updateNetBadge(false);
    });

    /* ─── Sincronización entre pestañas ─── */
    window.addEventListener('storage', (e) => {
      if (e.key === CONFIG.STORAGE_KEY) {
        State.chats = Storage.read(CONFIG.STORAGE_KEY, []);
        renderHistory();
      }
    });

    /* ─── Botón scroll-bottom ─── */
    const jumpBtn = document.createElement('button');
    jumpBtn.type = 'button';
    jumpBtn.className = 'chat-jump';
    jumpBtn.title = 'Ir al final';
    jumpBtn.innerHTML = svg('<polyline points="6 9 12 15 18 9"/>');
    jumpBtn.addEventListener('click', () => { scroll.scrollTop = scroll.scrollHeight; });
    scroll.parentElement?.appendChild(jumpBtn);
    scroll.addEventListener('scroll', throttle(() => {
      const near = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
      jumpBtn.classList.toggle('is-visible', !near);
    }, 120));

    /* ─── Título con tiempo ─── */
    setInterval(() => {
      const chat = getCurrent();
      if (!chat) { document.title = 'Numination — Chat'; return; }
      document.title = chat.title.slice(0, 30) + ' — Numination';
    }, 4000);
    /* ─── Botón de configuración en el sidebar ─── */
    (function addSettingsButton() {
      const footer = $('.sidebar__footer');
      if (!footer || $('.sidebar__settings-btn')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sidebar__settings-btn';
      btn.innerHTML = `
        ${svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>')}
        <span>Configuración</span>
      `;
      btn.addEventListener('click', () => window.__openSettings());
      footer.insertBefore(btn, footer.firstChild);
    })();
    /* ─── Render inicial ─── */
    updateSend();
    renderHistory();
    if (!State.chats.length && !State.currentId) {
      // estado vacío por defecto
    } else if (State.chats.length) {
      // abrir la más reciente
      const first = sortChats(State.chats)[0];
      if (first) loadChat(first.id);
    }
    applyPrefs();

    /* ══════════════════════════════════════════════════════════
       Funciones internas de UI (usan clausura)
       ══════════════════════════════════════════════════════════ */

    function openSearch() {
      const back = openModal({
        title: 'Buscar en conversaciones',
        body: `<div class="nm-search"><input type="search" placeholder="Escribe para filtrar…" /></div><ul class="nm-search__list"></ul>`,
        actions: [{ label: 'Cerrar', variant: 'btn--ghost', close: false, onClick: (b) => b.remove() }],
      });
      const input = $('input', back);
      const list = $('.nm-search__list', back);
      const refresh = () => {
        const res = searchChats(input.value);
        if (!res.length) { list.innerHTML = '<li class="nm-search__empty">Sin resultados.</li>'; return; }
        list.innerHTML = '';
        for (const chat of res) {
          const li = document.createElement('li');
          li.innerHTML = `<button type="button" class="nm-search__item">
            <span class="nm-search__title">${escapeHtml(chat.title)}</span>
            <span class="nm-search__meta">${chat.messages.length} mensajes · ${fmtRelative(chat.updatedAt)}</span>
          </button>`;
          li.querySelector('button').addEventListener('click', () => {
            loadChat(chat.id);
            back.remove();
          });
          list.appendChild(li);
        }
      };
      input.addEventListener('input', debounce(refresh, 120));
      refresh();
    }

    function showShortcuts() {
      const rows = [
        ['Ctrl + K', 'Buscar conversaciones'],
        ['Ctrl + B', 'Nueva conversación'],
        ['Ctrl + /', 'Ver atajos'],
        ['Ctrl + Shift + E', 'Exportar a Markdown'],
        ['Ctrl + Shift + S', 'Modo enfoque (oculta sidebar)'],
        ['Alt + 1..9', 'Abrir conversación N'],
        ['↑ / ↓ en el campo', 'Navegar por prompts anteriores'],
        ['Enter', 'Enviar'],
        ['Shift + Enter', 'Nueva línea'],
        ['Escape', 'Cerrar modales'],
        ['/help', 'Lista de comandos'],
      ];
      openModal({
        title: 'Atajos de teclado',
        body: `<ul class="nm-shortcuts">${rows.map(([k, v]) => `<li><kbd>${k}</kbd><span>${v}</span></li>`).join('')}</ul>`,
        actions: [{ label: 'Cerrar' }],
      });
    }

    function showSlashHelp() {
      openModal({
        title: 'Comandos',
        body: `<ul class="nm-shortcuts">${SLASH_COMMANDS.map(c => `<li><kbd>/${c.cmd}</kbd><span>${c.desc}</span></li>`).join('')}</ul>`,
        actions: [{ label: 'Cerrar' }],
      });
    }

    function showStats() {
      const totalChats = State.chats.length;
      const totalMsgs = State.chats.reduce((n, c) => n + c.messages.length, 0);
      const words = State.chats.reduce((n, c) => n + c.messages.reduce((m, x) => m + countWords(x.content), 0), 0);
      const time = Math.round((Date.now() - State.stats.sessionStart) / 60000);
      openModal({
        title: 'Estadísticas',
        body: `<ul class="nm-stats">
          <li><strong>${totalChats}</strong><span>conversaciones</span></li>
          <li><strong>${totalMsgs}</strong><span>mensajes</span></li>
          <li><strong>${words.toLocaleString('es-CO')}</strong><span>palabras</span></li>
          <li><strong>${time} min</strong><span>sesión actual</span></li>
        </ul>`,
        actions: [{ label: 'Cerrar' }],
      });
    }

    function showTrash() {
      const back = openModal({
        title: 'Papelera',
        body: `<ul class="nm-trash">${State.trash.length ? '' : '<li class="nm-trash__empty">Vacía.</li>'}</ul>`,
        actions: [
          { label: 'Vaciar papelera', variant: 'btn--ghost', onClick: () => { emptyTrash(); back.remove(); } },
          { label: 'Cerrar', variant: 'btn--ghost' },
        ],
      });
      const list = $('.nm-trash', back);
      for (const chat of State.trash) {
        const li = document.createElement('li');
        li.className = 'nm-trash__item';
        li.innerHTML = `<span>${escapeHtml(chat.title)}</span><button type="button" class="btn btn--ghost btn--sm" data-restore="${chat.id}">Restaurar</button>`;
        li.querySelector('[data-restore]').addEventListener('click', () => {
          restoreFromTrash(chat.id);
          renderHistory();
          li.remove();
        });
        list.appendChild(li);
      }
    }

    function showTemplates() {
      const grid = document.createElement('div');
      grid.className = 'nm-templates';
      for (const t of TEMPLATES) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'nm-template';
        card.innerHTML = `<span class="nm-template__ico">${t.icon}</span><span class="nm-template__title">${t.title}</span><span class="nm-template__body">${escapeHtml(t.body)}</span>`;
        card.addEventListener('click', () => {
          field.value = t.body;
          field.focus();
          resize(); updateSend();
          $$('.nm-modal-backdrop').forEach(m => m.remove());
        });
        grid.appendChild(card);
      }
      openModal({
        title: 'Plantillas de prompts',
        body: grid,
        actions: [{ label: 'Cerrar' }],
      });
    }

    function toggleFocusMode() {
      State.prefs.focusMode = !State.prefs.focusMode;
      persistPrefs();
      document.body.classList.toggle('is-focus-mode', State.prefs.focusMode);
      toast(State.prefs.focusMode ? 'Modo enfoque activado.' : 'Modo enfoque desactivado.', 'info');
    }

    function toggleCompact() {
      State.prefs.compact = !State.prefs.compact;
      persistPrefs();
      document.body.classList.toggle('is-compact', State.prefs.compact);
    }

    function bumpFont(delta) {
      State.prefs.fontSize = Math.max(12, Math.min(22, State.prefs.fontSize + delta));
      persistPrefs();
      document.documentElement.style.setProperty('--c-font-size', State.prefs.fontSize + 'px');
      document.body.style.fontSize = State.prefs.fontSize + 'px';
      toast('Tamaño: ' + State.prefs.fontSize + 'px', 'info', { duration: 1200 });
    }

    function updateNetBadge(ok) {
      document.body.classList.toggle('is-offline', !ok);
    }
  }

  /* ══════════════════════════════════════════════════════════
     APLICAR PREFERENCIAS
     ══════════════════════════════════════════════════════════ */

  function applyPrefs() {
    if (State.prefs.fontSize && State.prefs.fontSize !== 15) {
      document.body.style.fontSize = State.prefs.fontSize + 'px';
    }
    document.body.classList.toggle('is-compact', !!State.prefs.compact);
    document.body.classList.toggle('is-focus-mode', !!State.prefs.focusMode);
    document.body.classList.toggle('is-offline', !navigator.onLine);
  }

  /* ══════════════════════════════════════════════════════════
     COMANDOS DISPONIBLES (registro)
     ══════════════════════════════════════════════════════════ */

  const SLASH_COMMANDS = [
    { cmd: 'help', desc: 'Ver comandos disponibles' },
    { cmd: 'clear', desc: 'Borrar todo el historial' },
    { cmd: 'export', desc: 'Exportar chat actual (md | txt | json)' },
    { cmd: 'exportall', desc: 'Backup completo en JSON' },
    { cmd: 'import', desc: 'Importar un backup JSON' },
    { cmd: 'save', desc: 'Forzar guardado' },
    { cmd: 'focus', desc: 'Modo enfoque' },
    { cmd: 'theme', desc: 'Cambiar tema claro/oscuro' },
    { cmd: 'compact', desc: 'Modo compacto' },
    { cmd: 'big', desc: 'Aumentar tamaño de fuente' },
    { cmd: 'small', desc: 'Reducir tamaño de fuente' },
    { cmd: 'stats', desc: 'Estadísticas de uso' },
    { cmd: 'trash', desc: 'Abrir papelera' },
    { cmd: 'template', desc: 'Plantillas de prompts' },
    { cmd: 'shortcuts', desc: 'Atajos de teclado' },
    { cmd: 'share', desc: 'Compartir conversación (link)' },
  ];

  /* ══════════════════════════════════════════════════════════
     HELPERS DE RENDERIZADO DE MENSAJES
     ══════════════════════════════════════════════════════════ */

  function addMessage(container, role, text, attachment = null, imageUrl = null, meta = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg--' + role;
    if (meta.ts) wrap.dataset.ts = meta.ts;

    const avatar = document.createElement('div');
    avatar.className = 'msg__avatar';
    avatar.textContent = role === 'user' ? 'T' : 'N';

    const content = document.createElement('div');
    content.className = 'msg__content';

    const author = document.createElement('div');
    author.className = 'msg__author';
    author.innerHTML = role === 'user'
      ? 'Tú'
      : `Numination${meta.durationMs ? ` · ${(meta.durationMs/1000).toFixed(1)}s` : ''}`;

    const bubble = document.createElement('div');
    bubble.className = 'msg__bubble';

    if (text) {
      const p = document.createElement('div');
      p.className = 'msg__text';
      p.textContent = text;
      bubble.appendChild(p);
    }

    if (attachment) {
      if (attachment.mimeType?.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = 'data:' + attachment.mimeType + ';base64,' + attachment.data;
        img.alt = attachment.name || 'imagen';
        img.className = 'msg__image';
        img.addEventListener('click', () => openImageModal(img.src));
        bubble.appendChild(img);
      } else {
        const att = document.createElement('div');
        att.className = 'msg-attachment';
        att.innerHTML = `<span>📎</span><span>${escapeHtml(attachment.name || 'archivo')}</span>`;
        bubble.appendChild(att);
      }
    }

    if (imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = 'Imagen generada';
      img.loading = 'lazy';
      img.className = 'msg__image';
      img.addEventListener('click', () => openImageModal(img.src));
      bubble.appendChild(img);
    }

    if (role === 'ai' && text) {
      attachMessageTools(bubble, text, meta);
      if ('speechSynthesis' in window) attachSpeakButton(bubble, text);
    }
    if (role === 'user' && text) attachMessageTools(bubble, text, meta);

    content.appendChild(author);
    content.appendChild(bubble);
    wrap.appendChild(avatar);
    wrap.appendChild(content);
    container.appendChild(wrap);

    const scroller = container.closest('[data-chat-messages]');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    return wrap;
  }

  function attachMessageTools(bubble, text, meta) {
    const tools = document.createElement('div');
    tools.className = 'msg__tools';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'msg__tool';
    copyBtn.title = 'Copiar';
    copyBtn.innerHTML = svg('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
    copyBtn.addEventListener('click', async () => {
      const ok = await copyToClipboard(text);
      toast(ok ? 'Copiado.' : 'No se pudo copiar.', ok ? 'ok' : 'err', { duration: 1200 });
    });
    tools.appendChild(copyBtn);

    if (meta.role === 'ai' || bubble.closest('.msg--ai')) {
      const regen = document.createElement('button');
      regen.type = 'button';
      regen.className = 'msg__tool';
      regen.title = 'Regenerar';
      regen.innerHTML = svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>');
      regen.addEventListener('click', () => toast('Función de regenerar próximamente.', 'info'));
      tools.appendChild(regen);
    }

    bubble.appendChild(tools);
  }

  function openImageModal(src) {
    const back = document.createElement('div');
    back.className = 'nm-modal-backdrop nm-modal-backdrop--image';
    back.innerHTML = `<img src="${src}" alt="imagen ampliada" />`;
    back.addEventListener('click', () => back.remove());
    document.body.appendChild(back);
  }

  function addTyping(container) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg--ai msg--typing';
    wrap.innerHTML = '<div class="msg__avatar">N</div><div class="msg__content"><div class="msg__author">Numination</div><div class="msg__bubble"><span class="msg__typing"><span></span><span></span><span></span></span></div></div>';
    container.appendChild(wrap);
    return wrap;
  }

  function createLiveBubble(container) {
    const wrap = document.createElement('div');
    wrap.className = 'msg msg--ai';
    wrap.innerHTML = `
      <div class="msg__avatar">N</div>
      <div class="msg__content">
        <div class="msg__author">Numination</div>
        <div class="msg__bubble msg__bubble--streaming">
          <span class="msg__stream-text"></span><span class="msg__cursor"></span>
        </div>
      </div>`;
    container.appendChild(wrap);
    return {
      wrap,
      bubble: wrap.querySelector('.msg__bubble'),
      span: wrap.querySelector('.msg__stream-text'),
      cursor: wrap.querySelector('.msg__cursor'),
      fullText: '',
    };
  }

  function appendToBubble(live, token) {
    if (!live) return;
    live.span.textContent += token;
    live.fullText += token;
    const scroller = live.bubble.closest('[data-chat-messages]');
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  function finalizeBubble(live, finalText) {
    if (!live) return;
    live.cursor?.remove();
    live.bubble.classList.remove('msg__bubble--streaming');
    const text = finalText || live.fullText;
    if (text && !live.bubble.querySelector('.msg__speak')) {
      attachSpeakButton(live.bubble, text);
      attachMessageTools(live.bubble, text, { role: 'ai' });
    }
  }

  /* ══════════════════════════════════════════════════════════
     TTS
     ══════════════════════════════════════════════════════════ */

  let voices = [];
  if ('speechSynthesis' in window) {
    const loadVoices = () => { voices = window.speechSynthesis.getVoices(); };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }

  function pickVoice() {
    return (
      voices.find(v => v.lang === 'es-CO') ||
      voices.find(v => v.lang === 'es-MX') ||
      voices.find(v => v.lang === 'es-US') ||
      voices.find(v => v.lang.startsWith('es')) ||
      voices[0] || null
    );
  }

  function cleanForSpeech(text) {
    return String(text)
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/\*(.+?)\*/g, '$1')
      .replace(/#+\s/g, '')
      .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
      .replace(/\[(.+?)\]\(.+?\)/g, '$1')
      .replace(/_{1,2}(.+?)_{1,2}/g, '$1')
      .replace(/^\s*[-*]\s+/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function speak(text) {
    if (!('speechSynthesis' in window)) return;
    const clean = cleanForSpeech(text);
    if (!clean) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(clean);
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'es-CO';
    u.rate = 1.0; u.pitch = 1.0;
    window.speechSynthesis.speak(u);
  }

  function attachSpeakButton(bubble, text) {
    if (!bubble || !('speechSynthesis' in window)) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg__speak';
    btn.setAttribute('aria-label', 'Leer en voz alta');
    btn.innerHTML = svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>');
    let speaking = false;
    btn.addEventListener('click', () => {
      if (speaking) { window.speechSynthesis.cancel(); speaking = false; btn.classList.remove('is-speaking'); return; }
      speak(text);
      speaking = true;
      btn.classList.add('is-speaking');
      const cleanup = () => {
        speaking = false;
        btn.classList.remove('is-speaking');
        window.speechSynthesis.removeEventListener('end', cleanup);
      };
      window.speechSynthesis.addEventListener('end', cleanup);
    });
    bubble.appendChild(btn);
  }

})();