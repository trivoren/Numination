/* ================================================================
   NUMINATION · chat.js v5.0 «Café de Origen»
   ----------------------------------------------------------------
   Runtime del chat. Sin dependencias. Un solo IIFE.
   Autor: Numination · Colombia · 2026
   ================================================================ */

(() => {
  'use strict';

  /* ══════════════════════════════════════════════════════════════
     1 · CONSTANTES
     ══════════════════════════════════════════════════════════════ */

  const VERSION = '5.0.0';
  const BUILD = '2026.09';
  const API_URL = '/api/chat/stream';
  const API_HEALTH = '/api/health';

  const LIMITS = {
    MAX_CHARS: 4000,
    MAX_FILE_SIZE: 10 * 1024 * 1024,
    STREAM_TIMEOUT_MS: 45000,
    RETRY_LIMIT: 3,
    RETRY_BASE_MS: 800,
    PROMPT_HISTORY_MAX: 100,
    UNDO_STACK_MAX: 30,
    TRASH_MAX: 100,
    TOAST_DURATION: 2600,
    AUTOSAVE_DEBOUNCE_MS: 400,
    ESTIMATED_TOKENS_PER_CHAR: 0.25,
    VIRTUAL_SCROLL_THRESHOLD: 400,
    HEALTH_CHECK_INTERVAL_MS: 60000,
  };

  const STORAGE_KEYS = {
    CHATS: 'numination-chats-v5',
    TRASH: 'numination-trash-v5',
    PREFS: 'numination-prefs-v5',
    PROMPTS: 'numination-prompts-v5',
    UNDO: 'numination-undo-v5',
    META: 'numination-meta-v5',
    MIGRATE_FROM: ['numination-chats-v3', 'numination-chats-v2', 'numination-chats-v1'],
  };

  const DEFAULTS = {
    prefs: {
      fontSize: 15,
      chatFont: 'sans',
      chatWidth: 'normal',
      sidebarWidth: 'normal',
      zoom: 100,
      theme: 'auto',
      sendMode: 'enter',
      compact: false,
      focusMode: false,
      autoSpeak: false,
      autoScroll: true,
      sepia: false,
      noAnimations: false,
      showTimestamps: false,
      hideAvatars: false,
      hideFloaters: false,
      confirmDelete: true,
      savePromptHistory: true,
      syncAcrossTabs: true,
      streamCursor: true,
      showTokenCount: false,
      markdown: true,
      typingSound: false,
    },
  };

  const EMOJI_PALETTE = ['📚','🧮','🔬','🌎','📝','🎯','💡','🧠','🗣️','📊','🎨','⚡'];

  const SLASH_COMMANDS = [
    { cmd: 'help',        desc: 'Lista de comandos disponibles',     aliases: ['ayuda','?'] },
    { cmd: 'clear',       desc: 'Borrar el historial de esta sesión', aliases: ['limpiar'] },
    { cmd: 'delete',      desc: 'Eliminar la conversación actual',    aliases: ['borrar'] },
    { cmd: 'export',      desc: 'Exportar chat (md | txt | json | html)', aliases: ['exportar'] },
    { cmd: 'exportall',   desc: 'Backup completo JSON',               aliases: ['backup'] },
    { cmd: 'import',      desc: 'Importar un backup JSON',            aliases: ['importar'] },
    { cmd: 'share',       desc: 'Generar link para compartir',        aliases: ['compartir'] },
    { cmd: 'rename',      desc: 'Renombrar la conversación actual',   aliases: ['renombrar'] },
    { cmd: 'pin',         desc: 'Fijar / desfijar conversación',      aliases: ['fijar'] },
    { cmd: 'search',      desc: 'Buscar en conversaciones',           aliases: ['buscar'] },
    { cmd: 'stats',       desc: 'Estadísticas de uso',                aliases: ['estadisticas'] },
    { cmd: 'trash',       desc: 'Abrir papelera',                     aliases: ['papelera'] },
    { cmd: 'template',    desc: 'Plantillas de prompts',              aliases: ['plantilla'] },
    { cmd: 'shortcuts',   desc: 'Atajos de teclado',                  aliases: ['atajos'] },
    { cmd: 'focus',       desc: 'Modo enfoque',                       aliases: ['enfoque'] },
    { cmd: 'compact',     desc: 'Modo compacto',                      aliases: ['compacto'] },
    { cmd: 'theme',       desc: 'Cambiar tema',                       aliases: ['tema'] },
    { cmd: 'settings',    desc: 'Abrir configuración',                aliases: ['config','ajustes'] },
    { cmd: 'retry',       desc: 'Reintentar el último mensaje',       aliases: ['reintentar'] },
    { cmd: 'edit',        desc: 'Editar el último mensaje enviado',   aliases: ['editar'] },
    { cmd: 'fork',        desc: 'Duplicar la conversación',           aliases: ['duplicar'] },
    { cmd: 'cost',        desc: 'Costo estimado de la sesión',        aliases: ['costo'] },
    { cmd: 'health',      desc: 'Estado de los motores IA',           aliases: ['estado'] },
    { cmd: 'feedback',    desc: 'Enviar comentarios',                 aliases: ['comentarios'] },
  ];

  const TEMPLATES = [
    { icon: '🧮', title: 'Ecuación paso a paso',    body: 'Explícame cómo resolver [tema] paso a paso, con un ejemplo sencillo y un ejercicio final para practicar.' },
    { icon: '📖', title: 'Resumen en 5 ideas',      body: 'Resume el siguiente texto en 5 ideas clave y dime cuál es la idea principal:\n\n[pega el texto aquí]' },
    { icon: '🧪', title: 'Experimento casero',      body: 'Proponme un experimento casero para entender [concepto], con materiales que tenga en casa.' },
    { icon: '📝', title: 'Ensayo argumentativo',    body: 'Ayúdame a estructurar un ensayo sobre [tema], con tesis, 3 argumentos y conclusión.' },
    { icon: '🌎', title: 'Ejemplo colombiano',      body: 'Explícame [tema] con un ejemplo colombiano que pueda entender fácilmente.' },
    { icon: '📅', title: 'Plan de 7 días',          body: 'Hazme un plan de estudio de 7 días para dominar [tema], con horas y metas diarias.' },
    { icon: '🎯', title: 'Simulacro Saber 11',      body: 'Genera 5 preguntas tipo ICFES sobre [tema], con su explicación.' },
    { icon: '🗣️', title: 'Exposición de 5 min',     body: 'Ayúdame a preparar una exposición de 5 minutos sobre [tema], con introducción, cuerpo y cierre.' },
    { icon: '🧠', title: 'Mnemotecnia',             body: 'Dame una regla mnemotécnica divertida para recordar [tema].' },
    { icon: '🖼️', title: 'Imagen educativa',        body: 'Genera una imagen educativa sobre [tema] que pueda usar en clase.' },
    { icon: '🔍', title: 'Analogía simple',         body: 'Explícame [tema] como si tuviera 10 años, usando una analogía de la vida diaria.' },
    { icon: '💡', title: 'Lluvia de ideas',         body: 'Dame 10 ideas originales sobre [tema] para un proyecto escolar.' },
    { icon: '📊', title: 'Comparar dos cosas',      body: 'Compárame [A] y [B] en una tabla, con ventajas y desventajas de cada uno.' },
    { icon: '🧭', title: 'Guía de investigación',   body: 'Dame una guía paso a paso para investigar sobre [tema], con fuentes confiables que pueda consultar.' },
    { icon: '🎓', title: 'Preguntas de repaso',     body: 'Hazme 8 preguntas de repaso sobre [tema], de menor a mayor dificultad, con sus respuestas.' },
    { icon: '🔧', title: 'Corregir un texto',       body: 'Corrige la ortografía y redacción del siguiente texto, y explícame los errores:\n\n[pega el texto aquí]' },
  ];

  /* ══════════════════════════════════════════════════════════════
     2 · UTILIDADES
     ══════════════════════════════════════════════════════════════ */

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const isFn = (v) => typeof v === 'function';
  const isStr = (v) => typeof v === 'string';
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  const clamp = (n, min, max) => Math.min(Math.max(n, min), max);

  const nowMs = () => Date.now();
  const nowIso = () => new Date().toISOString();

  const uid = (prefix = 'x') =>
    `${prefix}-${nowMs().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  const slugify = (s) =>
    String(s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '')
      .slice(0, 60) || 'conversacion';

  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const escapeAttr = escapeHtml;

  const countWords = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;

  const estimateTokens = (s) => Math.ceil(String(s || '').length * LIMITS.ESTIMATED_TOKENS_PER_CHAR);

  const fmtNumber = (n, d = 0) =>
    Number(n).toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d });

  const fmtBytes = (bytes) => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const fmtTime = (ts) => {
    try {
      return new Date(ts).toLocaleString('es-CO', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      });
    } catch { return ''; }
  };

  const fmtRelative = (ts) => {
    const diff = nowMs() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return 'hace un momento';
    const m = Math.floor(s / 60);
    if (m < 60) return `hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `hace ${d} d`;
    return fmtTime(ts);
  };

  const debounce = (fn, wait = 200) => {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  };

  const throttle = (fn, wait = 100) => {
    let last = 0, timer = null;
    return function (...args) {
      const now = nowMs();
      const remaining = wait - (now - last);
      if (remaining <= 0) {
        clearTimeout(timer);
        timer = null;
        last = now;
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = nowMs();
          timer = null;
          fn.apply(this, args);
        }, remaining);
      }
    };
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const raf = (fn) => requestAnimationFrame(fn);

  const svg = (path, extra = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${path}</svg>`;

  const elFromHtml = (html) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
  };

  const prefersReducedMotion = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const isMobile = () => window.matchMedia('(max-width: 768px)').matches;

  const isTouch = () => ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

  /* ══════════════════════════════════════════════════════════════
     3 · STORAGE
     ══════════════════════════════════════════════════════════════ */

  const Storage = {
    available: (() => {
      try {
        const k = '__numination_test__';
        localStorage.setItem(k, '1');
        localStorage.removeItem(k);
        return true;
      } catch { return false; }
    })(),

    read(key, fallback = null) {
      if (!this.available) return fallback;
      try {
        const raw = localStorage.getItem(key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch { return fallback; }
    },

    write(key, value) {
      if (!this.available) return false;
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        if (e.name === 'QuotaExceededError') {
          Bus.emit('storage:quota', { key });
        }
        return false;
      }
    },

    remove(key) {
      if (!this.available) return;
      try { localStorage.removeItem(key); } catch {}
    },

    keys(prefix = '') {
      if (!this.available) return [];
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) out.push(k);
      }
      return out;
    },

    usage() {
      if (!this.available) return { bytes: 0, human: '0 B', pct: 0 };
      let bytes = 0;
      for (const k of this.keys('numination-')) {
        bytes += (localStorage.getItem(k) || '').length * 2;
      }
      const total = 5 * 1024 * 1024;
      return {
        bytes,
        human: fmtBytes(bytes),
        pct: Math.min(100, (bytes / total) * 100),
      };
    },
  };

  /* ══════════════════════════════════════════════════════════════
     4 · EVENT BUS
     ══════════════════════════════════════════════════════════════ */

  const Bus = (() => {
    const listeners = new Map();

    function on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
      return () => off(event, handler);
    }

    function off(event, handler) {
      const set = listeners.get(event);
      if (set) set.delete(handler);
    }

    function once(event, handler) {
      const wrap = (...args) => {
        off(event, wrap);
        handler(...args);
      };
      return on(event, wrap);
    }

    function emit(event, payload) {
      const set = listeners.get(event);
      if (set) {
        for (const h of [...set]) {
          try { h(payload); } catch (e) { console.warn('[bus]', event, e); }
        }
      }
      const wildcard = listeners.get('*');
      if (wildcard) {
        for (const h of [...wildcard]) {
          try { h({ event, payload }); } catch {}
        }
      }
    }

    function clear() { listeners.clear(); }

    return { on, off, once, emit, clear };
  })();

  /* ══════════════════════════════════════════════════════════════
     5 · TOASTS
     ══════════════════════════════════════════════════════════════ */

  const Toasts = (() => {
    let host = null;

    function ensure() {
      if (host && document.body.contains(host)) return host;
      host = document.createElement('div');
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
      return host;
    }

    function show(message, kind = 'info', opts = {}) {
      const h = ensure();
      const el = document.createElement('div');
      el.className = `toast toast--${kind}`;
      const icon = {
        ok: '✓', warn: '⚠', err: '✕', info: 'ⓘ',
      }[kind] || '';
      el.innerHTML = icon
        ? `<span class="toast__ico">${icon}</span><span class="toast__msg">${escapeHtml(message)}</span>`
        : escapeHtml(message);
      h.appendChild(el);
      raf(() => el.classList.add('is-visible'));

      const ttl = Number(opts.duration ?? LIMITS.TOAST_DURATION);
      let t = setTimeout(dismiss, ttl);

      function dismiss() {
        clearTimeout(t);
        el.classList.remove('is-visible');
        setTimeout(() => el.remove(), 260);
      }

      el.addEventListener('click', dismiss);
      return dismiss;
    }

    return {
      show,
      ok:   (m, o) => show(m, 'ok', o),
      warn: (m, o) => show(m, 'warn', o),
      err:  (m, o) => show(m, 'err', o),
      info: (m, o) => show(m, 'info', o),
      clear: () => { if (host) host.innerHTML = ''; },
    };
  })();

  /* ══════════════════════════════════════════════════════════════
     6 · MODALES
     ══════════════════════════════════════════════════════════════ */

  const Modal = (() => {
    const stack = [];

    function open({ title, body, actions = [], size = 'md', className = '', onClose }) {
      const back = document.createElement('div');
      back.className = `nm-modal-backdrop nm-modal-backdrop--${size}`;
      back.innerHTML = `
        <div class="nm-modal ${className}" role="dialog" aria-modal="true">
          <header class="nm-modal__head">
            <h2 class="nm-modal__title">${escapeHtml(title || '')}</h2>
            <button class="nm-modal__close" type="button" aria-label="Cerrar">
              ${svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>')}
            </button>
          </header>
          <div class="nm-modal__body"></div>
          <footer class="nm-modal__foot"></footer>
        </div>`;

      const bodyEl = back.querySelector('.nm-modal__body');
      if (isStr(body)) bodyEl.innerHTML = body;
      else if (body instanceof Node) bodyEl.appendChild(body);

      const foot = back.querySelector('.nm-modal__foot');
      for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ' + (a.variant || 'btn--ghost');
        b.textContent = a.label;
        b.addEventListener('click', () => {
          try { if (isFn(a.onClick)) a.onClick(back); }
          finally { if (a.close !== false) close(back); }
        });
        foot.appendChild(b);
      }

      back.querySelector('.nm-modal__close').addEventListener('click', () => close(back));
      back.addEventListener('click', (e) => { if (e.target === back) close(back); });

      document.body.appendChild(back);
      document.body.classList.add('has-modal');
      stack.push(back);

      const focusable = back.querySelector(
        'input, textarea, button:not(.nm-modal__close), [tabindex]'
      );
      if (focusable) setTimeout(() => focusable.focus(), 60);

      trapFocus(back);
      back._onClose = onClose;
      return back;
    }

    function close(back) {
      if (!back || !back.parentNode) return;
      back.remove();
      const i = stack.indexOf(back);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) document.body.classList.remove('has-modal');
      if (isFn(back._onClose)) try { back._onClose(); } catch {}
    }

    function closeAll() { [...stack].forEach(close); }

    function trapFocus(container) {
      const focusables = $$(
        'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
        container
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      container.addEventListener('keydown', (e) => {
        if (e.key !== 'Tab') return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      });
    }

    function confirm(message, opts = {}) {
      return new Promise((resolve) => {
        let resolved = false;
        open({
          title: opts.title || 'Confirmar',
          body: `<p class="nm-modal__msg">${escapeHtml(message)}</p>`,
          actions: [
            { label: opts.cancelLabel || 'Cancelar', onClick: () => { resolved = true; resolve(false); } },
            { label: opts.okLabel || 'Aceptar', variant: 'btn--primary', onClick: () => { resolved = true; resolve(true); } },
          ],
          onClose: () => { if (!resolved) resolve(false); },
        });
      });
    }

    function prompt(message, defaultValue = '') {
      return new Promise((resolve) => {
        let resolved = false;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = defaultValue;
        input.className = 'nm-modal__input';
        const wrap = document.createElement('div');
        wrap.innerHTML = `<p class="nm-modal__msg">${escapeHtml(message)}</p>`;
        wrap.appendChild(input);
        open({
          title: 'Introduce un valor',
          body: wrap,
          actions: [
            { label: 'Cancelar', onClick: () => { resolved = true; resolve(null); } },
            { label: 'Aceptar', variant: 'btn--primary', onClick: () => { resolved = true; resolve(input.value); } },
          ],
          onClose: () => { if (!resolved) resolve(null); },
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            resolved = true;
            resolve(input.value);
            closeAll();
          }
        });
      });
    }

    return { open, close, closeAll, confirm, prompt, stack };
  })();

  /* ══════════════════════════════════════════════════════════════
     7 · ESTADO GLOBAL
     ══════════════════════════════════════════════════════════════ */

  const State = {
    version: VERSION,
    build: BUILD,
    chats: [],
    trash: [],
    prefs: { ...DEFAULTS.prefs },
    prompts: [],
    promptCursor: -1,
    currentId: null,
    busy: false,
    attachedFile: null,
    online: navigator.onLine,
    undoStack: [],
    sessionStats: {
      start: nowMs(),
      messages: 0,
      words: 0,
      chars: 0,
      tokens: 0,
      retries: 0,
      errors: 0,
    },
  };

  const persist = {
    chats: debounce(() => Storage.write(STORAGE_KEYS.CHATS, State.chats), LIMITS.AUTOSAVE_DEBOUNCE_MS),
    trash: debounce(() => Storage.write(STORAGE_KEYS.TRASH, State.trash), LIMITS.AUTOSAVE_DEBOUNCE_MS),
    prefs: debounce(() => Storage.write(STORAGE_KEYS.PREFS, State.prefs), LIMITS.AUTOSAVE_DEBOUNCE_MS),
    prompts: debounce(() => Storage.write(STORAGE_KEYS.PROMPTS, State.prompts.slice(-LIMITS.PROMPT_HISTORY_MAX)), LIMITS.AUTOSAVE_DEBOUNCE_MS),
    undo: debounce(() => Storage.write(STORAGE_KEYS.UNDO, State.undoStack.slice(-LIMITS.UNDO_STACK_MAX)), LIMITS.AUTOSAVE_DEBOUNCE_MS),
  };

  /* ══════════════════════════════════════════════════════════════
     8 · MODELO DE CONVERSACIÓN
     ══════════════════════════════════════════════════════════════ */

  const ChatModel = (() => {
    function makeTitle(text) {
      const t = String(text || '').replace(/\s+/g, ' ').trim();
      if (!t) return 'Nueva conversación';
      return t.length > 48 ? t.slice(0, 45) + '…' : t;
    }

    function normalizeChat(raw) {
      if (!raw || typeof raw !== 'object') return null;
      return {
        id: raw.id || uid(),
        title: String(raw.title || 'Sin título').slice(0, 120),
        createdAt: Number(raw.createdAt) || nowMs(),
        updatedAt: Number(raw.updatedAt) || nowMs(),
        pinned: Boolean(raw.pinned),
        archived: Boolean(raw.archived),
        tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 8) : [],
        messages: Array.isArray(raw.messages)
          ? raw.messages.map(normalizeMsg).filter(Boolean)
          : [],
        meta: isObj(raw.meta) ? raw.meta : { motor: 'auto', source: 'chat.html' },
      };
    }

    function normalizeMsg(m) {
      if (!m || typeof m !== 'object') return null;
      return {
        id: m.id || uid('m'),
        role: m.role === 'user' ? 'user' : 'ai',
        content: String(m.content || ''),
        attachment: isObj(m.attachment) ? m.attachment : null,
        imageUrl: isStr(m.imageUrl) ? m.imageUrl : null,
        ts: Number(m.ts) || nowMs(),
        durationMs: Number(m.durationMs) || 0,
        provider: m.provider || null,
        tokens: Number(m.tokens) || 0,
        feedback: m.feedback || null,
        edited: Boolean(m.edited),
      };
    }

    function migrate() {
      const existing = Storage.read(STORAGE_KEYS.CHATS, null);
      if (Array.isArray(existing) && existing.length) {
        return existing.map(normalizeChat).filter(Boolean);
      }
      for (const key of STORAGE_KEYS.MIGRATE_FROM) {
        const old = Storage.read(key, null);
        if (Array.isArray(old) && old.length) {
          const migrated = old.map(normalizeChat).filter(Boolean);
          Storage.write(STORAGE_KEYS.CHATS, migrated);
          console.info(`[migrate] ${old.length} conversaciones desde ${key}`);
          return migrated;
        }
      }
      return [];
    }

    function create(firstText) {
      const chat = {
        id: uid(),
        title: makeTitle(firstText),
        createdAt: nowMs(),
        updatedAt: nowMs(),
        pinned: false,
        archived: false,
        tags: [],
        messages: [],
        meta: { motor: 'auto', source: 'chat.html' },
      };
      State.chats.unshift(chat);
      State.currentId = chat.id;
      persist.chats();
      Bus.emit('chat:created', chat);
      return chat;
    }

    function find(id) {
      return State.chats.find((c) => c.id === id) || null;
    }

    function current() {
      return State.currentId ? find(State.currentId) : null;
    }

    function ensure(firstText) {
      return current() || create(firstText);
    }

    function addMessage(chat, role, content, opts = {}) {
      if (!chat) return null;
      const msg = {
        id: uid('m'),
        role,
        content: String(content || ''),
        attachment: opts.attachment || null,
        imageUrl: opts.imageUrl || null,
        ts: nowMs(),
        durationMs: opts.durationMs || 0,
        provider: opts.provider || null,
        tokens: estimateTokens(content),
        feedback: null,
        edited: false,
      };
      chat.messages.push(msg);
      chat.updatedAt = nowMs();
      State.sessionStats.messages++;
      State.sessionStats.words += countWords(msg.content);
      State.sessionStats.chars += msg.content.length;
      State.sessionStats.tokens += msg.tokens;
      persist.chats();
      Bus.emit('message:added', { chat, msg });
      return msg;
    }

    function updateMessage(chatId, msgId, patch) {
      const chat = find(chatId);
      if (!chat) return false;
      const msg = chat.messages.find((m) => m.id === msgId);
      if (!msg) return false;
      Object.assign(msg, patch);
      chat.updatedAt = nowMs();
      persist.chats();
      Bus.emit('message:updated', { chat, msg });
      return true;
    }

    function deleteMessage(chatId, msgId) {
      const chat = find(chatId);
      if (!chat) return false;
      const i = chat.messages.findIndex((m) => m.id === msgId);
      if (i === -1) return false;
      const [removed] = chat.messages.splice(i, 1);
      chat.updatedAt = nowMs();
      persist.chats();
      Bus.emit('message:deleted', { chat, msg: removed });
      return true;
    }

    function remove(id, { soft = true } = {}) {
      const i = State.chats.findIndex((c) => c.id === id);
      if (i === -1) return;
      const [removed] = State.chats.splice(i, 1);
      if (soft) {
        removed.deletedAt = nowMs();
        State.trash.unshift(removed);
        if (State.trash.length > LIMITS.TRASH_MAX) State.trash.length = LIMITS.TRASH_MAX;
        persist.trash();
      }
      if (State.currentId === id) State.currentId = null;
      persist.chats();
      Bus.emit('chat:deleted', removed);
    }

    function restore(id) {
      const i = State.trash.findIndex((c) => c.id === id);
      if (i === -1) return false;
      const [chat] = State.trash.splice(i, 1);
      delete chat.deletedAt;
      State.chats.unshift(chat);
      persist.chats();
      persist.trash();
      Bus.emit('chat:restored', chat);
      return true;
    }

    function emptyTrash() {
      State.trash = [];
      persist.trash();
      Bus.emit('trash:emptied');
    }

    function togglePin(id) {
      const chat = find(id);
      if (!chat) return;
      chat.pinned = !chat.pinned;
      chat.updatedAt = nowMs();
      persist.chats();
      Bus.emit('chat:pinned', chat);
    }

    function rename(id, title) {
      const chat = find(id);
      if (!chat) return false;
      const clean = String(title || '').trim();
      if (!clean) return false;
      chat.title = clean.slice(0, 120);
      chat.updatedAt = nowMs();
      persist.chats();
      Bus.emit('chat:renamed', chat);
      return true;
    }

    function duplicate(id) {
      const chat = find(id);
      if (!chat) return null;
      const copy = {
        ...JSON.parse(JSON.stringify(chat)),
        id: uid(),
        title: chat.title + ' (copia)',
        createdAt: nowMs(),
        updatedAt: nowMs(),
        pinned: false,
        messages: chat.messages.map((m) => ({ ...m, id: uid('m'), ts: nowMs() })),
      };
      State.chats.unshift(copy);
      persist.chats();
      Bus.emit('chat:duplicated', copy);
      return copy;
    }

    function sort(list) {
      return [...list].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
    }

    function search(query) {
      const q = String(query || '').trim().toLowerCase();
      if (!q) return State.chats.slice();
      const terms = q.split(/\s+/).filter(Boolean);
      const out = [];
      for (const chat of State.chats) {
        const haystack = [
          chat.title,
          ...chat.messages.map((m) => m.content),
        ].join(' ').toLowerCase();
        const matches = terms.every((t) => haystack.includes(t));
        if (matches) {
          const idx = haystack.indexOf(terms[0]);
          out.push({ chat, score: idx, snippet: haystack.slice(Math.max(0, idx - 30), idx + 60) });
        }
      }
      return out.sort((a, b) => a.score - b.score).map((x) => x.chat);
    }

    function stats() {
      const chats = State.chats.length;
      const msgs = State.chats.reduce((n, c) => n + c.messages.length, 0);
      const words = State.chats.reduce((n, c) =>
        n + c.messages.reduce((m, x) => m + countWords(x.content), 0), 0);
      const chars = State.chats.reduce((n, c) =>
        n + c.messages.reduce((m, x) => m + x.content.length, 0), 0);
      const pinned = State.chats.filter((c) => c.pinned).length;
      const oldest = State.chats.length
        ? Math.min(...State.chats.map((c) => c.createdAt))
        : nowMs();
      return { chats, msgs, words, chars, pinned, oldest };
    }

    return {
      makeTitle, normalizeChat, normalizeMsg, migrate,
      create, find, current, ensure,
      addMessage, updateMessage, deleteMessage,
            remove, restore, emptyTrash, togglePin, rename, duplicate,
      sort, search, stats,
    };
  })();

  /* ══════════════════════════════════════════════════════════════
     9 · HISTORIAL DE PROMPTS
     ══════════════════════════════════════════════════════════════ */

  const PromptHistory = (() => {
    function push(text) {
      const clean = String(text || '').trim();
      if (!clean) return;
      if (State.prompts[State.prompts.length - 1] === clean) return;
      State.prompts.push(clean);
      if (State.prompts.length > LIMITS.PROMPT_HISTORY_MAX) {
        State.prompts = State.prompts.slice(-LIMITS.PROMPT_HISTORY_MAX);
      }
      State.promptCursor = State.prompts.length;
      persist.prompts();
    }

    function up(currentValue) {
      if (!State.prompts.length) return null;
      if (State.promptCursor >= State.prompts.length) {
        State.promptCursor = State.prompts.length - 1;
      } else if (State.promptCursor > 0) {
        State.promptCursor--;
      }
      return State.prompts[State.promptCursor];
    }

    function down() {
      if (!State.prompts.length) return null;
      if (State.promptCursor < State.prompts.length - 1) {
        State.promptCursor++;
        return State.prompts[State.promptCursor];
      }
      State.promptCursor = State.prompts.length;
      return '';
    }

    function reset() {
      State.promptCursor = State.prompts.length;
    }

    return { push, up, down, reset, list: () => [...State.prompts] };
  })();

  /* ══════════════════════════════════════════════════════════════
     10 · EXPORTAR / IMPORTAR / COMPARTIR
     ══════════════════════════════════════════════════════════════ */

  const Exporter = (() => {
    function toMarkdown(chat) {
      const lines = [];
      lines.push(`# ${chat.title}`);
      lines.push('');
      lines.push(`_Creado: ${fmtTime(chat.createdAt)}_`);
      lines.push(`_Actualizado: ${fmtTime(chat.updatedAt)}_`);
      lines.push(`_Mensajes: ${chat.messages.length}_`);
      lines.push('');
      lines.push('---');
      lines.push('');
      for (const m of chat.messages) {
        const who = m.role === 'user' ? 'Tú' : 'Numination';
        lines.push(`### ${who}`);
        lines.push('');
        lines.push(m.content || '_(sin contenido)_');
        if (m.attachment) lines.push(`\n> 📎 ${m.attachment.name || 'archivo'}`);
        if (m.imageUrl) lines.push(`\n![imagen](${m.imageUrl})`);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
      lines.push('_Generado por Numination · Hecho en Colombia_');
      return lines.join('\n');
    }

    function toText(chat) {
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

    function toJson(chat) {
      return JSON.stringify({
        version: VERSION,
        exportedAt: nowIso(),
        chat,
      }, null, 2);
    }

    function toHtml(chat) {
      return `<!DOCTYPE html>
<html lang="es-CO">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(chat.title)}</title>
<style>
  body { font-family: Inter, system-ui, sans-serif; max-width: 720px; margin: 40px auto; padding: 20px; line-height: 1.6; color: #1a1a1e; }
  h1 { font-family: 'Source Serif 4', Georgia, serif; font-weight: 400; }
  .msg { margin: 20px 0; padding: 12px 16px; border-radius: 10px; }
  .msg--user { background: #f0efec; margin-left: auto; max-width: 80%; }
  .msg--ai { background: #f7f7f5; }
  .meta { font-size: 12px; color: #888; margin-bottom: 6px; }
  footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e8e6e1; font-size: 12px; color: #888; text-align: center; }
</style>
</head>
<body>
<h1>${escapeHtml(chat.title)}</h1>
<p class="meta">Exportado el ${fmtTime(nowMs())} · ${chat.messages.length} mensajes</p>
${chat.messages.map((m) => `
  <div class="msg msg--${m.role}">
    <div class="meta">${m.role === 'user' ? 'Tú' : 'Numination'} · ${fmtTime(m.ts)}</div>
    <div>${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>
    ${m.imageUrl ? `<img src="${escapeAttr(m.imageUrl)}" style="max-width:100%;border-radius:8px;margin-top:8px">` : ''}
  </div>
`).join('')}
<footer>Generado por Numination · Hecho en Colombia</footer>
</body>
</html>`;
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

    function save(chat, format = 'md') {
      if (!chat) { Toasts.warn('No hay conversación activa.'); return; }
      const slug = slugify(chat.title);
      if (format === 'json') return download(`numination-${slug}.json`, toJson(chat), 'application/json');
      if (format === 'txt')  return download(`numination-${slug}.txt`, toText(chat), 'text/plain');
      if (format === 'html') return download(`numination-${slug}.html`, toHtml(chat), 'text/html');
      return download(`numination-${slug}.md`, toMarkdown(chat), 'text/markdown');
    }

    function saveAll() {
      if (!State.chats.length) { Toasts.warn('No hay conversaciones.'); return; }
      const payload = {
        version: VERSION,
        exportedAt: nowIso(),
        count: State.chats.length,
        chats: State.chats,
        trash: State.trash,
        prefs: State.prefs,
      };
      download('numination-backup.json', JSON.stringify(payload, null, 2), 'application/json');
      Toasts.ok(`Backup de ${State.chats.length} conversaciones.`);
    }

    function load(file) {
      if (!file) return;
      if (file.size > 10 * 1024 * 1024) { Toasts.warn('El archivo es muy grande.'); return; }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result));
          const incoming = Array.isArray(data) ? data : (data.chats || [data.chat]);
          const valid = incoming.map(ChatModel.normalizeChat).filter(Boolean);
          if (!valid.length) throw new Error('sin chats');
          let added = 0;
          const existingIds = new Set(State.chats.map((c) => c.id));
          for (const c of valid) {
            if (existingIds.has(c.id)) c.id = uid();
            State.chats.unshift(c);
            added++;
          }
          if (Array.isArray(data.trash)) {
            State.trash = [...data.trash.map(ChatModel.normalizeChat).filter(Boolean), ...State.trash];
          }
          persist.chats();
          persist.trash();
          Toasts.ok(`${added} conversación(es) importada(s).`);
          Bus.emit('import:done', { added });
        } catch (e) {
          console.warn('[import]', e);
          Toasts.err('El archivo no tiene el formato correcto.');
        }
      };
      reader.readAsText(file);
    }

    function shareLink(chat) {
      if (!chat) { Toasts.warn('No hay conversación para compartir.'); return; }
      try {
        const payload = btoa(unescape(encodeURIComponent(JSON.stringify({
          v: 1,
          t: chat.title,
          m: chat.messages.map((m) => ({ r: m.role, c: m.content, ts: m.ts })),
        }))));
        const url = location.origin + location.pathname + '#share=' + payload;
        copyToClipboard(url).then((ok) => {
          if (ok) Toasts.ok('Link copiado.');
          else { Toasts.info('Link en consola.'); console.log('[share]', url); }
        });
      } catch {
        Toasts.err('No se pudo generar el link.');
      }
    }

    function tryLoadShared() {
      if (!location.hash.startsWith('#share=')) return false;
      try {
        const payload = JSON.parse(decodeURIComponent(escape(atob(location.hash.slice(7)))));
        const chat = {
          id: uid(),
          title: payload.t || 'Conversación compartida',
          createdAt: nowMs(),
          updatedAt: nowMs(),
          pinned: false,
          tags: [],
          messages: (payload.m || []).map((m) => ({
            id: uid('m'),
            role: m.r === 'user' ? 'user' : 'ai',
            content: String(m.c || ''),
            ts: Number(m.ts) || nowMs(),
            attachment: null,
            imageUrl: null,
            durationMs: 0,
            tokens: estimateTokens(m.c || ''),
            feedback: null,
            edited: false,
          })),
          meta: { source: 'share-link' },
        };
        State.chats.unshift(chat);
        State.currentId = chat.id;
        persist.chats();
        history.replaceState(null, '', location.pathname);
        return true;
      } catch { return false; }
    }

    return { toMarkdown, toText, toJson, toHtml, save, saveAll, load, shareLink, tryLoadShared, download };
  })();

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

  /* ══════════════════════════════════════════════════════════════
     11 · MARKDOWN LIGERO
     ══════════════════════════════════════════════════════════════ */

  const Markdown = (() => {
    function render(text) {
      if (!State.prefs.markdown) return escapeHtml(text).replace(/\n/g, '<br>');
      let html = escapeHtml(String(text || ''));

      // Bloques de código ```
      html = html.replace(/```([\s\S]*?)```/g, (_, code) =>
        `<pre class="md-pre"><code>${code.trim()}</code></pre>`);

      // Inline code
      html = html.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');

      // Negrita
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

      // Cursiva
      html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

      // Links
      html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

      // Listas
      html = html.replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>');
      html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul class="md-list">${m}</ul>`);

      // Listas numeradas
      html = html.replace(/^\d+\.\s+(.+)$/gm, '<li>$1</li>');

      // Headings
      html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
      html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
      html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

      // Citas
      html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

      // Saltos de línea
      html = html.replace(/\n/g, '<br>');

      // Limpiar <br> colindantes con bloques
      html = html.replace(/<br>(<(?:ul|ol|pre|blockquote|h[2-4]|li))/g, '$1');
      html = html.replace(/(<\/(?:ul|ol|pre|blockquote|h[2-4]|li)>)<br>/g, '$1');

      return html;
    }

    return { render };
  })();

  /* ══════════════════════════════════════════════════════════════
     12 · TTS (voz de salida)
     ══════════════════════════════════════════════════════════════ */

  const TTS = (() => {
    let voices = [];
    let enabled = 'speechSynthesis' in window;

    function loadVoices() {
      if (!enabled) return;
      voices = window.speechSynthesis.getVoices();
    }

    if (enabled) {
      loadVoices();
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }

    function pickVoice() {
      return (
        voices.find((v) => v.lang === 'es-CO') ||
        voices.find((v) => v.lang === 'es-MX') ||
        voices.find((v) => v.lang === 'es-US') ||
        voices.find((v) => v.lang.startsWith('es')) ||
        voices[0] || null
      );
    }

    function clean(text) {
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
      if (!enabled) return;
      const cleanText = clean(text);
      if (!cleanText) return;
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(cleanText);
      const v = pickVoice();
      if (v) { u.voice = v; u.lang = v.lang; }
      else u.lang = 'es-CO';
      u.rate = 1.0;
      u.pitch = 1.0;
      window.speechSynthesis.speak(u);
    }

    function cancel() {
      if (!enabled) return;
      window.speechSynthesis.cancel();
    }

    return { speak, cancel, isSupported: () => enabled };
  })();

  /* ══════════════════════════════════════════════════════════════
     13 · STT (voz de entrada)
     ══════════════════════════════════════════════════════════════ */

  const STT = (() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const supported = Boolean(SR);
    let recognition = null;
    let listening = false;
    let callbacks = { onResult: null, onEnd: null, onError: null };

    function init() {
      if (!supported || recognition) return;
      recognition = new SR();
      recognition.lang = 'es-CO';
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onstart = () => {
        listening = true;
        Bus.emit('stt:start');
      };
      recognition.onresult = (e) => {
        let finalTxt = '', interimTxt = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const t = e.results[i][0].transcript;
          if (e.results[i].isFinal) finalTxt += t;
          else interimTxt += t;
        }
        callbacks.onResult && callbacks.onResult(finalTxt, interimTxt);
      };
      recognition.onend = () => {
        listening = false;
        callbacks.onEnd && callbacks.onEnd();
        Bus.emit('stt:end');
      };
      recognition.onerror = (e) => {
        listening = false;
        callbacks.onError && callbacks.onError(e.error);
        Bus.emit('stt:error', e.error);
      };
    }

    function start(handlers) {
      if (!supported) return false;
      init();
      callbacks = { ...callbacks, ...handlers };
      try { recognition.start(); return true; }
      catch { return false; }
    }

    function stop() {
      if (!recognition) return;
      try { recognition.stop(); } catch {}
    }

    function toggle(handlers) {
      if (listening) stop();
      else start(handlers);
    }

    return { start, stop, toggle, isListening: () => listening, isSupported: () => supported };
  })();

  /* ══════════════════════════════════════════════════════════════
     14 · API CLIENT
     ══════════════════════════════════════════════════════════════ */

  const API = (() => {
    async function stream({ message, role, file, signal, onToken, onDone, onError }) {
      const body = { message, role };
      if (file) {
        body.file = {
          data: file.data,
          mimeType: file.mimeType,
          name: file.name,
        };
      }

      let attempt = 0;
      let lastErr = null;

      while (attempt <= LIMITS.RETRY_LIMIT) {
        try {
          const res = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
          });

          if (!res.ok || !res.body) {
            let errMsg = `HTTP ${res.status}`;
            try {
              const data = await res.json();
              if (data?.error) errMsg = data.error;
            } catch {}
            onError && onError(errMsg);
            return;
          }

          await readStream(res, { onToken, onDone });
          return;
        } catch (err) {
          if (err.name === 'AbortError') return;
          lastErr = err;
          attempt++;
          State.sessionStats.retries++;
          if (attempt <= LIMITS.RETRY_LIMIT) {
            const delay = LIMITS.RETRY_BASE_MS * Math.pow(2, attempt - 1);
            Toasts.warn(`Reintentando (${attempt}/${LIMITS.RETRY_LIMIT})…`, { duration: delay });
            await sleep(delay);
          }
        }
      }

      State.sessionStats.errors++;
      onError && onError(lastErr?.message || 'Error desconocido');
    }

    async function readStream(res, { onToken, onDone }) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      let lastActivity = nowMs();

      const watchdog = setInterval(() => {
        if (nowMs() - lastActivity > LIMITS.STREAM_TIMEOUT_MS) {
          reader.cancel().catch(() => {});
          clearInterval(watchdog);
          if (!finished) onDone && onDone({ partial: true });
        }
      }, 2000);

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          lastActivity = nowMs();
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';

          for (const part of parts) {
            if (!part.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(part.slice(6));
              if (evt.error) onError && onError(evt.error);
              else if (evt.token) onToken && onToken(evt.token);
              if (evt.done && !finished) {
                finished = true;
                onDone && onDone({ provider: evt.provider });
              }
            } catch {}
          }
        }
      } finally {
        clearInterval(watchdog);
        if (!finished) onDone && onDone({ partial: true });
      }
    }

    async function health() {
      try {
        const res = await fetch(API_HEALTH);
        if (!res.ok) return null;
        return await res.json();
      } catch { return null; }
    }

    return { stream, health };
  })();

  /* ══════════════════════════════════════════════════════════════
     15 · COMPONENTES DE MENSAJE (DOM)
     ══════════════════════════════════════════════════════════════ */

  const MessageView = (() => {
    function create({ role, content, attachment, imageUrl, meta = {} }) {
      const wrap = document.createElement('div');
      wrap.className = `msg msg--${role}`;
      wrap.dataset.msgId = meta.id || uid('m');
      if (meta.ts) wrap.dataset.ts = meta.ts;

      const avatar = document.createElement('div');
      avatar.className = 'msg__avatar';
      avatar.textContent = role === 'user' ? 'T' : 'N';
      avatar.setAttribute('aria-hidden', 'true');

      const contentEl = document.createElement('div');
      contentEl.className = 'msg__content';

      const author = document.createElement('div');
      author.className = 'msg__author';
      const who = role === 'user' ? 'Tú' : 'Numination';
      const dur = meta.durationMs ? ` · ${(meta.durationMs / 1000).toFixed(1)}s` : '';
      const tok = State.prefs.showTokenCount && meta.tokens
        ? ` · ~${meta.tokens} tok` : '';
      author.innerHTML = `${who}${dur}${tok}<time>${fmtTime(meta.ts || nowMs())}</time>`;

      const bubble = document.createElement('div');
      bubble.className = 'msg__bubble';

      if (content) {
        const text = document.createElement('div');
        text.className = 'msg__text';
        text.innerHTML = Markdown.render(content);
        bubble.appendChild(text);
      }

      if (attachment) attachFile(bubble, attachment);
      if (imageUrl) attachImage(bubble, imageUrl);
      if (role === 'ai' && content) Tools.attach(bubble, content, meta);

      contentEl.appendChild(author);
      contentEl.appendChild(bubble);
      wrap.appendChild(avatar);
      wrap.appendChild(contentEl);

      return wrap;
    }

    function attachFile(bubble, attachment) {
      if (attachment.mimeType?.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = 'data:' + attachment.mimeType + ';base64,' + attachment.data;
        img.alt = attachment.name || 'imagen';
        img.className = 'msg__image';
        img.addEventListener('click', () => Lightbox.open(img.src));
        bubble.appendChild(img);
      } else {
        const att = document.createElement('div');
        att.className = 'msg-attachment';
        att.innerHTML = `
          <span class="msg-attachment__ico">📎</span>
          <span class="msg-attachment__name">${escapeHtml(attachment.name || 'archivo')}</span>
          <span class="msg-attachment__size">${fmtBytes(attachment.size || 0)}</span>
        `;
        bubble.appendChild(att);
      }
    }

    function attachImage(bubble, imageUrl) {
      const img = document.createElement('img');
      img.src = imageUrl;
      img.alt = 'Imagen generada';
      img.loading = 'lazy';
      img.className = 'msg__image';
      img.addEventListener('click', () => Lightbox.open(img.src));
      bubble.appendChild(img);
    }

    return { create, attachFile, attachImage };
  })();

  /* ══════════════════════════════════════════════════════════════
     16 · HERRAMIENTAS DEL MENSAJE
     ══════════════════════════════════════════════════════════════ */

  const Tools = (() => {
    function attach(bubble, text, meta = {}) {
      if (bubble.querySelector('.msg__tools')) return;
      const tools = document.createElement('div');
      tools.className = 'msg__tools';

      tools.appendChild(btnCopy(text));
      if (meta.role !== 'user') {
        tools.appendChild(btnSpeak(text));
        tools.appendChild(btnRegenerate(meta));
        tools.appendChild(btnFeedback(meta));
      }
      bubble.appendChild(tools);
    }

    function btnCopy(text) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'msg__tool';
      b.title = 'Copiar';
      b.setAttribute('aria-label', 'Copiar mensaje');
      b.innerHTML = svg('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>');
      b.addEventListener('click', async () => {
        const ok = await copyToClipboard(text);
        Toasts[ok ? 'ok' : 'err'](ok ? 'Copiado.' : 'No se pudo copiar.', { duration: 1200 });
      });
      return b;
    }

    function btnSpeak(text) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'msg__tool';
      b.title = 'Leer en voz alta';
      b.setAttribute('aria-label', 'Leer en voz alta');
      b.innerHTML = svg('<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>');
      let speaking = false;
      b.addEventListener('click', () => {
        if (speaking) {
          TTS.cancel();
          speaking = false;
          b.classList.remove('is-active');
          return;
        }
        TTS.speak(text);
        speaking = true;
        b.classList.add('is-active');
        const cleanup = () => {
          speaking = false;
          b.classList.remove('is-active');
          window.speechSynthesis.removeEventListener('end', cleanup);
        };
        window.speechSynthesis.addEventListener('end', cleanup);
      });
      return b;
    }

    function btnRegenerate(meta) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'msg__tool';
      b.title = 'Regenerar';
      b.setAttribute('aria-label', 'Regenerar respuesta');
      b.innerHTML = svg('<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>');
      b.addEventListener('click', () => Bus.emit('msg:regenerate', meta));
      return b;
    }

    function btnFeedback(meta) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'msg__tool';
      b.title = 'Enviar comentario';
      b.setAttribute('aria-label', 'Enviar comentario');
      b.innerHTML = svg('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>');
      b.addEventListener('click', () => Bus.emit('msg:feedback', meta));
      return b;
    }

    return { attach };
  })();

  /* ══════════════════════════════════════════════════════════════
     17 · LIGHTBOX
     ══════════════════════════════════════════════════════════════ */

  const Lightbox = (() => {
    let backdrop = null;

    function open(src) {
      close();
      backdrop = document.createElement('div');
      backdrop.className = 'lightbox';
      backdrop.innerHTML = `<img src="${escapeAttr(src)}" alt="imagen ampliada" />`;
      backdrop.addEventListener('click', close);
      document.body.appendChild(backdrop);
      raf(() => backdrop.classList.add('is-visible'));
    }

    function close() {
      if (!backdrop) return;
      backdrop.classList.remove('is-visible');
      setTimeout(() => { backdrop?.remove(); backdrop = null; }, 200);
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
    });

    return { open, close };
  })();

  /* ══════════════════════════════════════════════════════════════
     18 · ADJUNTOS
     ══════════════════════════════════════════════════════════════ */

  const Attachments = (() => {
    let input = null;

    function ensureInput() {
      if (input && document.body.contains(input)) return input;
      input = document.createElement('input');
      input.type = 'file';
      input.id = 'nm-file-input';
      input.hidden = true;
      input.accept = 'image/*,.pdf,.txt,.doc,.docx,.xls,.xlsx,.csv,.json,.md';
      document.body.appendChild(input);
      return input;
    }

    function pick(onPick) {
      const inp = ensureInput();
      inp.value = '';
      inp.onchange = (e) => {
        const f = e.target.files?.[0];
        if (f) onPick(f);
      };
      inp.click();
    }

    function process(file, cb) {
      if (file.size > LIMITS.MAX_FILE_SIZE) {
        Toasts.warn('El archivo supera los 10 MB.');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result);
        const commaIdx = result.indexOf(',');
        const base64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
        cb({
          name: file.name || 'archivo',
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          data: base64,
        });
      };
      reader.onerror = () => Toasts.err('No se pudo leer el archivo.');
      reader.readAsDataURL(file);
    }

    return { pick, process };
  })();

  /* ══════════════════════════════════════════════════════════════
     19 · SIDEBAR RENDER
     ══════════════════════════════════════════════════════════════ */

  const Sidebar = (() => {
    let historyEl, emptyEl, rootEl;

    function bind() {
      historyEl = $('[data-chat-history]');
      emptyEl = $('[data-chat-history-empty]');
      rootEl = $('[data-chat-sidebar]');
    }

    function render(filter = '') {
      if (!historyEl) return;
      historyEl.innerHTML = '';
      const list = filter ? ChatModel.search(filter) : ChatModel.sort(State.chats);
      if (!list.length) {
        if (emptyEl) emptyEl.style.display = '';
        return;
      }
      if (emptyEl) emptyEl.style.display = 'none';

      const frag = document.createDocumentFragment();
      for (const chat of list) frag.appendChild(item(chat));
      historyEl.appendChild(frag);
    }

    function item(chat) {
      const li = document.createElement('li');
      li.className = 'sidebar__history-item';
      li.dataset.chatItem = chat.id;
      if (chat.id === State.currentId) li.classList.add('is-active');
      if (chat.pinned) li.classList.add('is-pinned');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sidebar__history-btn';
      btn.dataset.chatId = chat.id;
      btn.setAttribute('title', `${chat.title} · ${fmtRelative(chat.updatedAt)}`);
      btn.innerHTML = `
        <span class="sidebar__history-ico">${chat.pinned ? '📌' : '💬'}</span>
        <span class="sidebar__history-txt">${escapeHtml(chat.title)}</span>
      `;
      li.appendChild(btn);

      const actions = document.createElement('div');
      actions.className = 'sidebar__history-actions';
      actions.appendChild(actionBtn('chatPin', chat.id, chat.pinned ? '★' : '☆', chat.pinned ? 'Desfijar' : 'Fijar'));
      actions.appendChild(actionBtn('chatRename', chat.id, '✎', 'Renombrar'));
      actions.appendChild(actionBtn('chatDup', chat.id, '⎘', 'Duplicar'));
      actions.appendChild(actionBtn('chatDel', chat.id, '🗑', 'Eliminar', true));
      li.appendChild(actions);

      return li;
    }

    function actionBtn(attr, id, glyph, title, danger = false) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sidebar__history-act' + (danger ? ' sidebar__history-act--danger' : '');
      b.title = title;
      b.setAttribute('aria-label', title);
      b.dataset[attr] = id;
      b.textContent = glyph;
      return b;
    }

    function setActive(id) {
      $$('.sidebar__history-item', historyEl).forEach((li) => {
        li.classList.toggle('is-active', li.dataset.chatItem === id);
      });
    }

    return { bind, render, setActive };
  })();

  /* ══════════════════════════════════════════════════════════════
     20 · SLASH MENU
     ══════════════════════════════════════════════════════════════ */

  const SlashMenu = (() => {
    let el = null;
    let anchor = null;
    let selected = 0;
    let matches = [];

    function bind(target) {
      anchor = target;
    }

    function update(input) {
      const v = String(input || '');
      if (!v.startsWith('/') || v.includes(' ')) {
        hide();
        return;
      }
      const partial = v.slice(1).toLowerCase();
      matches = SLASH_COMMANDS.filter((c) =>
        c.cmd.startsWith(partial) ||
        (c.aliases || []).some((a) => a.startsWith(partial))
      ).slice(0, 6);

      if (!partial || !matches.length) { hide(); return; }
      show();
    }

    function show() {
      if (!el) {
        el = document.createElement('div');
        el.className = 'slash-menu';
        el.setAttribute('role', 'listbox');
        anchor?.appendChild(el);
      }
      selected = clamp(selected, 0, matches.length - 1);
      el.innerHTML = matches.map((c, i) => `
        <button type="button" class="slash-menu__item ${i === selected ? 'is-active' : ''}" data-cmd="${c.cmd}">
          <code>/${c.cmd}</code>
          <span>${escapeHtml(c.desc)}</span>
        </button>
      `).join('');
      el.querySelectorAll('[data-cmd]').forEach((b) => {
        b.addEventListener('mousedown', (e) => {
          e.preventDefault();
          Bus.emit('slash:pick', b.dataset.cmd);
        });
      });
    }

    function hide() {
      if (el) { el.remove(); el = null; }
    }

    function move(delta) {
      if (!matches.length) return;
      selected = clamp(selected + delta, 0, matches.length - 1);
      show();
    }

    function pick() {
      if (!matches[selected]) return null;
      return matches[selected].cmd;
    }

    return { bind, update, show, hide, move, pick, isOpen: () => !!el };
  })();

  /* ══════════════════════════════════════════════════════════════
     21 · STATUS BAR (health)
     ══════════════════════════════════════════════════════════════ */

  const Status = (() => {
    let el = null;
    let last = null;

    function ensure() {
      if (el && document.body.contains(el)) return el;
      el = document.createElement('div');
      el.className = 'nm-statusbar';
      el.hidden = true;
      el.innerHTML = `
        <span class="nm-statusbar__dot"></span>
        <span class="nm-statusbar__text">Conectando…</span>
      `;
      document.body.appendChild(el);
      return el;
    }

    async function refresh() {
      const data = await API.health();
      last = data;
      const node = ensure();
      if (!data) {
        node.hidden = true;
        return;
      }
      const keys = data.keys || {};
      const geminiOk = keys.gemini_1 || keys.gemini || keys.gemini_2 || keys.gemini_3;
      const groqOk = keys.groq;
      const nvidiaOk = keys.nvidia;
      const total = [geminiOk, groqOk, nvidiaOk].filter(Boolean).length;
      node.hidden = false;
      node.dataset.health = total >= 2 ? 'ok' : total === 1 ? 'warn' : 'err';
      node.querySelector('.nm-statusbar__text').textContent =
        `${total}/3 motores activos`;
      node.title = `Gemini: ${geminiOk ? '✓' : '✗'} · Groq: ${groqOk ? '✓' : '✗'} · NVIDIA: ${nvidiaOk ? '✓' : '✗'}`;
    }

    function init() {
      refresh();
      setInterval(refresh, LIMITS.HEALTH_CHECK_INTERVAL_MS);
      window.addEventListener('online', refresh);
      window.addEventListener('offline', refresh);
    }

    return { init, refresh, last: () => last };
  })();

  /* ══════════════════════════════════════════════════════════════
     22 · BOOT
     ══════════════════════════════════════════════════════════════ */

  document.addEventListener('DOMContentLoaded', () => {
    const app = $('.chat-app');
    if (!app) return;
    try { init(); }
    catch (e) {
      console.error('[chat] init failed', e);
      Toasts.err('Error al iniciar el chat.');
    }
  });

  function init() {
    /* ── Referencias DOM ── */
    const form      = $('[data-chat-form]');
    const field     = $('[data-chat-field]');
    const sendBtn   = $('[data-chat-send]');
    const scroll    = $('[data-chat-messages]');
    const empty     = $('[data-chat-empty]');
    const thread    = $('[data-chat-thread]');
    const newBtn    = $('[data-chat-new]');
    const sidebarEl = $('[data-chat-sidebar]');
    const overlay   = $('[data-chat-sidebar-overlay]');
    const sbOpen    = $('[data-chat-sidebar-open]');
    const sbClose   = $('[data-chat-sidebar-close]');

    if (!form || !field || !sendBtn || !scroll || !thread) {
      console.warn('[chat] elementos faltantes');
      return;
    }

    /* ── Cargar storage ── */
    State.chats = ChatModel.migrate();
    State.trash = (Storage.read(STORAGE_KEYS.TRASH, []) || [])
      .map(ChatModel.normalizeChat).filter(Boolean);
    State.prefs = { ...DEFAULTS.prefs, ...(Storage.read(STORAGE_KEYS.PREFS, {}) || {}) };
    State.prompts = Storage.read(STORAGE_KEYS.PROMPTS, []) || [];
    State.promptCursor = State.prompts.length;

    applyPrefs();
    Sidebar.bind();
    SlashMenu.bind(form.parentElement);

    /* ── Abrir conversación más reciente ── */
    if (Exporter.tryLoadShared()) {
      Toasts.ok('Conversación compartida cargada.');
    }

    /* ── Sidebar móvil ── */
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

    /* ── Resize y estado del botón ── */
    const resize = () => {
      field.style.height = 'auto';
      field.style.height = Math.min(field.scrollHeight, 220) + 'px';
    };
    const updateSend = () => {
      sendBtn.disabled = State.busy || field.value.trim().length === 0;
    };

    /* ── Eventos del campo ── */
    field.addEventListener('input', () => {
      if (field.value.length > LIMITS.MAX_CHARS) {
        field.value = field.value.slice(0, LIMITS.MAX_CHARS);
        Toasts.warn(`Máximo ${LIMITS.MAX_CHARS} caracteres.`, { duration: 1600 });
      }
      resize();
      updateSend();
      SlashMenu.update(field.value);
    });

    field.addEventListener('keydown', (e) => {
      if (SlashMenu.isOpen()) {
        if (e.key === 'ArrowDown') { e.preventDefault(); SlashMenu.move(1); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); SlashMenu.move(-1); return; }
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          const cmd = SlashMenu.pick();
          if (cmd) {
            field.value = '/' + cmd + ' ';
            SlashMenu.hide();
            resize(); updateSend();
          }
          return;
        }
        if (e.key === 'Escape') { SlashMenu.hide(); return; }
      }

      if (e.key === 'Enter' && !e.shiftKey && State.prefs.sendMode === 'enter') {
        e.preventDefault();
        form.requestSubmit();
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && State.prefs.sendMode === 'ctrlenter') {
        e.preventDefault();
        form.requestSubmit();
        return;
      }
      if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !field.value.trim()) {
        const v = PromptHistory.up();
        if (v != null) { field.value = v; resize(); updateSend(); }
      } else if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey) {
        const v = PromptHistory.down();
        if (v != null) { field.value = v; resize(); updateSend(); }
      }
    });

    /* ── Sugerencias del welcome ── */
    $$('[data-suggestion]').forEach((btn) => {
      btn.addEventListener('click', () => {
        field.value = btn.dataset.suggestion || '';
        resize();
        updateSend();
        field.focus();
      });
    });

    /* ── Adjuntos ── */
    const attachBtn = $('[data-attach-btn]');
    const previewEl = $('[data-attach-preview]');
    const previewName = $('[data-attach-name]');
    const previewSize = $('[data-attach-size]');
    const previewRemove = $('[data-attach-remove]');

    attachBtn?.addEventListener('click', () => {
      Attachments.pick((file) => Attachments.process(file, (att) => {
        State.attachedFile = att;
        renderAttachPreview();
      }));
    });

    previewRemove?.addEventListener('click', () => {
      State.attachedFile = null;
      renderAttachPreview();
    });

    field.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith('image/')) {
          const f = it.getAsFile();
          if (f) { e.preventDefault(); Attachments.process(f, (att) => {
            State.attachedFile = att;
            renderAttachPreview();
          }); }
          return;
        }
      }
    });

    ['dragenter', 'dragover'].forEach((ev) => {
      scroll.addEventListener(ev, (e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          scroll.classList.add('is-dragover');
        }
      });
    });
    ['dragleave', 'drop'].forEach((ev) => {
      scroll.addEventListener(ev, () => scroll.classList.remove('is-dragover'));
    });
    scroll.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      Attachments.process(e.dataTransfer.files[0], (att) => {
        State.attachedFile = att;
        renderAttachPreview();
      });
    });

    function renderAttachPreview() {
      if (!previewEl) return;
      if (!State.attachedFile) {
        previewEl.hidden = true;
        attachBtn?.classList.remove('has-file');
        return;
      }
      previewEl.hidden = false;
      attachBtn?.classList.add('has-file');
      if (previewName) previewName.textContent = State.attachedFile.name;
      if (previewSize) previewSize.textContent = fmtBytes(State.attachedFile.size);
    }

    /* ── Micrófono ── */
    const micBtn = document.getElementById('mic-btn');
    if (micBtn) {
      if (!STT.isSupported()) {
        micBtn.style.display = 'none';
      } else {
        micBtn.addEventListener('click', () => {
          STT.toggle({
            onResult: (finalTxt, interimTxt) => {
              const base = field.dataset.voiceBase || '';
              field.value = base + finalTxt + interimTxt;
              resize(); updateSend();
            },
            onEnd: () => {
              micBtn.classList.remove('is-listening');
              field.placeholder = 'Pregúntale algo a Numination…';
              delete field.dataset.voiceBase;
            },
            onError: (err) => {
              if (err === 'not-allowed') Toasts.warn('Permiso de micrófono denegado.');
            },
          });
          if (STT.isListening()) {
            micBtn.classList.add('is-listening');
            field.placeholder = 'Escuchando…';
            field.dataset.voiceBase = field.value ? field.value + ' ' : '';
          }
        });
      }
    }

    /* ── Nuevo chat ── */
    newBtn?.addEventListener('click', newChat);

    /* ── Historial: clicks ── */
    $('[data-chat-history]')?.addEventListener('click', (e) => {
      const del = e.target.closest('[data-chat-del]');
      if (del) { e.stopPropagation(); requestDelete(del.dataset.chatDel); return; }
      const pin = e.target.closest('[data-chat-pin]');
      if (pin) { e.stopPropagation(); ChatModel.togglePin(pin.dataset.chatPin); Sidebar.render(); return; }
      const ren = e.target.closest('[data-chat-rename]');
      if (ren) { e.stopPropagation(); requestRename(ren.dataset.chatRename); return; }
      const dup = e.target.closest('[data-chat-dup]');
      if (dup) { e.stopPropagation(); const c = ChatModel.duplicate(dup.dataset.chatDup); if (c) { loadChat(c.id); Toasts.ok('Duplicada.'); } return; }
      const load = e.target.closest('[data-chat-id]');
      if (load) { loadChat(load.dataset.chatId); closeSidebar(); }
    });

    /* ── Submit ── */
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (State.busy) return;
      const text = field.value.trim();
      if (!text) { field.focus(); return; }

      if (text.startsWith('/')) {
        const handled = await runSlash(text);
        if (handled) {
          field.value = '';
          resize(); updateSend();
          return;
        }
      }

      await sendMessage(text);
    });

    /* ══════════════════════════════════════════════════════════════
       Lógica interna
       ══════════════════════════════════════════════════════════════ */

    async function sendMessage(text) {
      const attachment = State.attachedFile;
      State.attachedFile = null;
      renderAttachPreview();

      field.value = '';
      resize();
      if (empty) empty.style.display = 'none';

      PromptHistory.push(text);

      const chat = ChatModel.ensure(text);
      const userMsg = ChatModel.addMessage(chat, 'user', text, { attachment });
      appendMessageView(userMsg);

      State.busy = true;
      updateSend();
      const typing = addTypingIndicator();
      scrollBottom();

      const t0 = performance.now();
      const live = createLiveBubble();

      try {
        let fullText = '';
        let provider = null;
        await API.stream({
          message: text,
          role: 'student',
          file: attachment,
          onToken: (tok) => {
            appendToBubble(live, tok);
            fullText += tok;
          },
          onDone: (info) => {
            provider = info?.provider || null;
            finalizeBubble(live, fullText, provider);
          },
          onError: (err) => {
            typing.remove();
            appendToBubble(live, '\n\n⚠️ ' + err);
            finalizeBubble(live, fullText, 'error');
          },
        });

        typing.remove();
        const dur = Math.round(performance.now() - t0);

        if (fullText.trim()) {
          ChatModel.addMessage(chat, 'ai', fullText, {
            durationMs: dur,
            provider,
          });
          if (State.prefs.autoSpeak) TTS.speak(fullText);
        }
      } catch (err) {
        typing.remove();
        const msg = '⚠️ No se pudo conectar con el servidor.\n\nDetalle: ' + err.message;
        appendMessageView({
          id: uid('m'),
          role: 'ai',
          content: msg,
          ts: nowMs(),
        });
        ChatModel.addMessage(chat, 'ai', msg);
      } finally {
        State.busy = false;
        updateSend();
        field.focus();
        Sidebar.render();
      }
    }

    function appendMessageView(msg) {
      const view = MessageView.create({
        role: msg.role,
        content: msg.content,
        attachment: msg.attachment,
        imageUrl: msg.imageUrl,
        meta: msg,
      });
      thread.appendChild(view);
      scrollBottom();
      return view;
    }

    function addTypingIndicator() {
      const wrap = document.createElement('div');
      wrap.className = 'msg msg--ai msg--typing';
      wrap.innerHTML = `
        <div class="msg__avatar">N</div>
        <div class="msg__content">
          <div class="msg__author">Numination</div>
          <div class="msg__bubble">
            <span class="msg__typing"><span></span><span></span><span></span></span>
          </div>
        </div>`;
      thread.appendChild(wrap);
      return wrap;
    }

    function createLiveBubble() {
      const wrap = document.createElement('div');
      wrap.className = 'msg msg--ai';
      wrap.innerHTML = `
        <div class="msg__avatar">N</div>
        <div class="msg__content">
          <div class="msg__author">Numination</div>
          <div class="msg__bubble msg__bubble--streaming">
            <span class="msg__stream-text"></span>
            <span class="msg__cursor"></span>
          </div>
        </div>`;
      thread.appendChild(wrap);
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
      if (State.prefs.autoScroll) scrollBottom();
    }

    function finalizeBubble(live, text, provider) {
      if (!live) return;
      live.cursor?.remove();
      live.bubble.classList.remove('msg__bubble--streaming');
      live.span.innerHTML = Markdown.render(text);
      if (text) Tools.attach(live.bubble, text, { role: 'ai', provider });
    }

    function scrollBottom() {
      if (!State.prefs.autoScroll) return;
      scroll.scrollTop = scroll.scrollHeight;
    }

    /* ── Cargar chat ── */
    function loadChat(id) {
      const chat = ChatModel.find(id);
      if (!chat) return;
      State.currentId = id;
      thread.innerHTML = '';
      if (empty) empty.style.display = 'none';
      for (const m of chat.messages) appendMessageView(m);
      scrollBottom();
      Sidebar.render();
    }

    /* ── Nuevo chat ── */
    function newChat() {
      State.currentId = null;
      thread.innerHTML = '';
      if (empty) empty.style.display = '';
      State.busy = false;
      State.attachedFile = null;
      field.value = '';
      updateSend();
      Sidebar.render();
      field.focus();
      closeSidebar();
    }

    /* ── Renombrar ── */
    async function requestRename(id) {
      const chat = ChatModel.find(id);
      if (!chat) return;
      const name = await Modal.prompt('Nuevo nombre:', chat.title);
      if (name != null && name.trim()) {
        ChatModel.rename(id, name);
        Sidebar.render();
        Toasts.ok('Renombrada.');
      }
    }

    /* ── Borrar ── */
    async function requestDelete(id) {
      const chat = ChatModel.find(id);
      if (!chat) return;
      if (State.prefs.confirmDelete) {
        const ok = await Modal.confirm(`¿Eliminar "${chat.title}"?`);
        if (!ok) return;
      }
      ChatModel.remove(id);
      Sidebar.render();
      if (State.currentId === id) newChat();
      Toasts.info('Movida a la papelera.');
    }

    /* ── Comandos ── */
    async function runSlash(raw) {
      const parts = raw.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();
      const arg = parts.slice(1).join(' ').trim();

      const found = SLASH_COMMANDS.find((c) =>
        c.cmd === cmd || (c.aliases || []).includes(cmd)
      );
      if (!found) { Toasts.warn(`Comando desconocido: /${cmd}`); return true; }

      switch (found.cmd) {
        case 'help': showSlashHelp(); break;
        case 'clear': clearSession(); break;
        case 'delete': await requestDelete(State.currentId); break;
        case 'export': Exporter.save(ChatModel.current(), arg || 'md'); break;
        case 'exportall': Exporter.saveAll(); break;
        case 'import': importDialog(); break;
        case 'share': Exporter.shareLink(ChatModel.current()); break;
        case 'rename': await requestRename(State.currentId); break;
        case 'pin': ChatModel.togglePin(State.currentId); Sidebar.render(); break;
        case 'search': openSearch(); break;
        case 'stats': showStats(); break;
        case 'trash': showTrash(); break;
        case 'template': showTemplates(); break;
        case 'shortcuts': showShortcuts(); break;
        case 'focus': togglePref('focusMode'); break;
        case 'compact': togglePref('compact'); break;
        case 'theme': cycleTheme(); break;
        case 'settings': window.__openSettings && window.__openSettings(); break;
        case 'retry': retryLast(); break;
        case 'edit': editLast(); break;
        case 'fork': forkCurrent(); break;
        case 'cost': showCost(); break;
        case 'health': showHealth(); break;
        case 'feedback': showFeedback(); break;
      }
      return true;
    }

    function clearSession() {
      if (!State.currentId) return;
      Modal.confirm('¿Vaciar el contenido de esta conversación?').then((ok) => {
        if (!ok) return;
        const chat = ChatModel.current();
        chat.messages = [];
        chat.updatedAt = nowMs();
        persist.chats();
        thread.innerHTML = '';
        if (empty) empty.style.display = '';
        Sidebar.render();
      });
    }

    function importDialog() {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json';
      inp.addEventListener('change', () => {
        const f = inp.files?.[0];
        if (f) Exporter.load(f);
      });
      inp.click();
    }

    function retryLast() {
      const chat = ChatModel.current();
      if (!chat || !chat.messages.length) return;
      const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) return;
      field.value = lastUser.content;
      resize(); updateSend();
      field.focus();
    }

    function editLast() {
      const chat = ChatModel.current();
      if (!chat) return;
      const lastUser = [...chat.messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) return;
      Modal.prompt('Editar mensaje:', lastUser.content).then((v) => {
        if (v != null && v.trim()) {
          ChatModel.updateMessage(chat.id, lastUser.id, { content: v, edited: true });
          loadChat(chat.id);
          Toasts.ok('Editado.');
        }
      });
    }

    function forkCurrent() {
      const chat = ChatModel.current();
      if (!chat) return;
      const copy = ChatModel.duplicate(chat.id);
      if (copy) { loadChat(copy.id); Toasts.ok('Conversación duplicada.'); }
    }

    function showCost() {
      const s = ChatModel.stats();
      const tokens = Math.round(s.chars * LIMITS.ESTIMATED_TOKENS_PER_CHAR);
      Modal.open({
        title: 'Costo estimado',
        body: `
          <ul class="nm-stats">
            <li><strong>${fmtNumber(tokens)}</strong><span>tokens (estimado)</span></li>
            <li><strong>${fmtNumber(s.words)}</strong><span>palabras</span></li>
            <li><strong>${fmtNumber(s.chars)}</strong><span>caracteres</span></li>
            <li><strong>${fmtNumber(s.msgs)}</strong><span>mensajes</span></li>
          </ul>
          <p style="font-size:12px;color:var(--c-fg-subtle);margin-top:12px;line-height:1.5">
            El cálculo usa una estimación de ~0.25 tokens por carácter.
            El costo real depende del motor y del modelo usado.
          </p>`,
        actions: [{ label: 'Cerrar' }],
      });
    }

    function showHealth() {
      API.health().then((data) => {
        const keys = data?.keys || {};
        const row = (label, on) => `<li><strong>${on ? '✓' : '✗'}</strong><span>${label}</span></li>`;
        Modal.open({
          title: 'Estado de los motores',
          body: `
            <ul class="nm-stats">
              ${row('Gemini #1', !!keys.gemini_1 || !!keys.gemini)}
              ${row('Gemini #2', !!keys.gemini_2)}
              ${row('Gemini #3', !!keys.gemini_3)}
              ${row('Groq', !!keys.groq)}
              ${row('NVIDIA / Kimi', !!keys.nvidia)}
            </ul>`,
          actions: [{ label: 'Cerrar' }],
        });
      });
    }

    function showFeedback() {
      Modal.prompt('Cuéntanos qué te pareció o qué podemos mejorar:').then((v) => {
        if (v && v.trim()) {
          const list = Storage.read('numination-feedback', []) || [];
          list.unshift({ ts: nowMs(), text: v.trim() });
          Storage.write('numination-feedback', list.slice(0, 50));
          Toasts.ok('¡Gracias por tu opinión!');
        }
      });
    }

    function togglePref(key) {
      State.prefs[key] = !State.prefs[key];
      persist.prefs();
      applyPrefs();
    }

    function cycleTheme() {
      const modes = ['light', 'dark', 'auto'];
      const cur = document.documentElement.dataset.themeMode || 'auto';
      const next = modes[(modes.indexOf(cur) + 1) % modes.length];
      localStorage.setItem('numination-theme', JSON.stringify(next));
      const resolved = next === 'auto'
        ? (new Date().getHours() >= 6 && new Date().getHours() < 18 ? 'light' : 'dark')
        : next;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themeMode = next;
      Toasts.info(`Tema: ${next}`);
    }

    /* ── Modales auxiliares ── */
    function showSlashHelp() {
      Modal.open({
        title: 'Comandos disponibles',
        body: `<ul class="nm-shortcuts">
          ${SLASH_COMMANDS.map((c) => `<li><kbd>/${c.cmd}</kbd><span>${c.desc}</span></li>`).join('')}
        </ul>`,
        actions: [{ label: 'Cerrar' }],
      });
    }

    function showShortcuts() {
      const rows = [
        ['Ctrl K', 'Buscar conversaciones'],
        ['Ctrl B', 'Nueva conversación'],
        ['Ctrl /', 'Ver atajos'],
        ['Ctrl Shift E', 'Exportar a Markdown'],
        ['Ctrl Shift S', 'Modo enfoque'],
        ['Alt 1..9', 'Abrir conversación N'],
        ['↑ / ↓ en el campo', 'Navegar prompts anteriores'],
        ['Enter', 'Enviar (configurable)'],
        ['Shift Enter', 'Nueva línea'],
        ['Escape', 'Cerrar modales'],
        ['/', 'Menú de comandos'],
      ];
      Modal.open({
        title: 'Atajos de teclado',
        body: `<ul class="nm-shortcuts">${rows.map(([k, v]) =>
          `<li><kbd>${k}</kbd><span>${v}</span></li>`).join('')}</ul>`,
        actions: [{ label: 'Cerrar' }],
      });
    }

    function showStats() {
      const s = ChatModel.stats();
      const time = Math.round((nowMs() - State.sessionStats.start) / 60000);
      Modal.open({
        title: 'Estadísticas',
        body: `
          <ul class="nm-stats">
            <li><strong>${fmtNumber(s.chats)}</strong><span>conversaciones</span></li>
            <li><strong>${fmtNumber(s.msgs)}</strong><span>mensajes</span></li>
            <li><strong>${fmtNumber(s.words)}</strong><span>palabras</span></li>
            <li><strong>${fmtNumber(s.pinned)}</strong><span>fijadas</span></li>
            <li><strong>${time} min</strong><span>sesión actual</span></li>
            <li><strong>${State.sessionStats.retries}</strong><span>reintentos</span></li>
          </ul>`,
        actions: [{ label: 'Cerrar' }],
      });
    }

    function showTrash() {
      const list = document.createElement('ul');
      list.className = 'nm-trash';
      if (!State.trash.length) {
        list.innerHTML = '<li class="nm-trash__empty">La papelera está vacía.</li>';
      } else {
        for (const chat of State.trash) {
          const li = document.createElement('li');
          li.className = 'nm-trash__item';
          li.innerHTML = `
            <span>${escapeHtml(chat.title)}</span>
            <button type="button" class="btn btn--ghost btn--sm" data-restore="${chat.id}">Restaurar</button>
          `;
          li.querySelector('[data-restore]').addEventListener('click', () => {
            ChatModel.restore(chat.id);
            Sidebar.render();
            li.remove();
          });
          list.appendChild(li);
        }
      }
      Modal.open({
        title: 'Papelera',
        body: list,
        actions: [
          { label: 'Vaciar', onClick: () => { ChatModel.emptyTrash(); Modal.closeAll(); Toasts.ok('Papelera vaciada.'); } },
          { label: 'Cerrar' },
        ],
      });
    }

    function showTemplates() {
      const grid = document.createElement('div');
      grid.className = 'nm-templates';
      for (const t of TEMPLATES) {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'nm-template';
        card.innerHTML = `
          <span class="nm-template__ico">${t.icon}</span>
          <span class="nm-template__title">${t.title}</span>
          <span class="nm-template__body">${escapeHtml(t.body)}</span>
        `;
        card.addEventListener('click', () => {
          field.value = t.body;
          field.focus();
          resize(); updateSend();
          Modal.closeAll();
        });
        grid.appendChild(card);
      }
      Modal.open({
        title: 'Plantillas',
        body: grid,
        actions: [{ label: 'Cerrar' }],
      });
    }

    function openSearch() {
      const back = Modal.open({
        title: 'Buscar',
        size: 'md',
        body: `
          <div class="nm-search">
            <input type="search" placeholder="Escribe para filtrar…" />
            <ul class="nm-search__list"></ul>
          </div>`,
        actions: [{ label: 'Cerrar', close: false, onClick: (b) => Modal.close(b) }],
      });
      const input = back.querySelector('input');
      const list = back.querySelector('.nm-search__list');

      const refresh = () => {
        const res = ChatModel.search(input.value);
        if (!res.length) {
          list.innerHTML = '<li class="nm-search__empty">Sin resultados.</li>';
          return;
        }
        list.innerHTML = '';
        for (const chat of res.slice(0, 50)) {
          const li = document.createElement('li');
          li.innerHTML = `
            <button type="button" class="nm-search__item">
              <span class="nm-search__title">${escapeHtml(chat.title)}</span>
              <span class="nm-search__meta">${chat.messages.length} mensajes · ${fmtRelative(chat.updatedAt)}</span>
            </button>`;
          li.querySelector('button').addEventListener('click', () => {
            loadChat(chat.id);
            Modal.close(back);
          });
          list.appendChild(li);
        }
      };
      input.addEventListener('input', debounce(refresh, 120));
      refresh();
    }

    /* ── Botón de configuración ── */
    (function addSettingsButton() {
      const footer = $('.sidebar__footer');
      if (!footer || $('.sidebar__settings-btn')) return;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'sidebar__settings-btn';
      b.innerHTML = `
        ${svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>')}
        <span>Configuración</span>`;
      b.addEventListener('click', () => window.__openSettings && window.__openSettings());
      footer.insertBefore(b, footer.firstChild);
    })();

    /* ── Atajos globales ── */
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openSearch(); return; }
      if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); newChat(); return; }
      if (mod && e.key === '/') { e.preventDefault(); showShortcuts(); return; }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault(); Exporter.save(ChatModel.current(), 'md'); return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault(); togglePref('focusMode'); return;
      }
      if (e.altKey && /^[1-9]$/.test(e.key)) {
        const list = ChatModel.sort(State.chats);
        const idx = parseInt(e.key, 10) - 1;
        if (list[idx]) loadChat(list[idx].id);
        return;
      }
      if (e.key === 'Escape') { Modal.closeAll(); SlashMenu.hide(); }
    });

    /* ── Eventos Bus ── */
    Bus.on('slash:pick', (cmd) => {
      field.value = '/' + cmd + ' ';
      SlashMenu.hide();
      resize(); updateSend();
      field.focus();
    });

    Bus.on('msg:regenerate', () => {
      retryLast();
    });

    Bus.on('msg:feedback', () => {
      showFeedback();
    });

    Bus.on('storage:quota', () => {
      Toasts.warn('Almacenamiento lleno. Exporta y borra conversaciones antiguas.');
    });

    /* ── Sincronización entre pestañas ── */
    if (State.prefs.syncAcrossTabs) {
      window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEYS.CHATS) {
          State.chats = (Storage.read(STORAGE_KEYS.CHATS, []) || [])
            .map(ChatModel.normalizeChat).filter(Boolean);
          Sidebar.render();
        }
      });
    }

    /* ── Online/offline ── */
    window.addEventListener('online', () => {
      State.online = true;
      Toasts.ok('Conexión restaurada.');
      document.body.classList.remove('is-offline');
    });
    window.addEventListener('offline', () => {
      State.online = false;
      Toasts.warn('Sin conexión.');
      document.body.classList.add('is-offline');
    });
    if (!navigator.onLine) document.body.classList.add('is-offline');

    /* ── Botón scroll-bottom ── */
    const jumpBtn = document.createElement('button');
    jumpBtn.type = 'button';
    jumpBtn.className = 'chat-jump';
    jumpBtn.title = 'Ir al final';
    jumpBtn.setAttribute('aria-label', 'Ir al final');
    jumpBtn.innerHTML = svg('<polyline points="6 9 12 15 18 9"/>');
    jumpBtn.addEventListener('click', () => scrollBottom());
    scroll.parentElement?.appendChild(jumpBtn);
    scroll.addEventListener('scroll', throttle(() => {
      const near = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
      jumpBtn.classList.toggle('is-visible', !near);
    }, 120));

    /* ── Estado del servidor ── */
    Status.init();

    /* ── Arranque final ── */
    updateSend();
    Sidebar.render();

    if (State.chats.length) {
      const first = ChatModel.sort(State.chats)[0];
      if (first) loadChat(first.id);
    }

    applyPrefs();

    console.info(
      `%c[chat.js v${VERSION}]`,
      'background:#1a1a2e;color:#7c93d4;padding:2px 6px;border-radius:4px',
      'listo'
    );
  }

  /* ══════════════════════════════════════════════════════════════
     23 · PREFERENCIAS — aplicar al DOM
     ══════════════════════════════════════════════════════════════ */

  function applyPrefs() {
    const p = State.prefs;

    if (p.fontSize && p.fontSize !== 15) {
      document.body.style.fontSize = p.fontSize + 'px';
      document.documentElement.style.setProperty('--c-font-size', p.fontSize + 'px');
    } else {
      document.body.style.fontSize = '';
    }

    document.body.classList.toggle('is-compact', !!p.compact);
    document.body.classList.toggle('is-focus-mode', !!p.focusMode);
    document.body.classList.toggle('theme-sepia', !!p.sepia);
    document.body.classList.toggle('no-animations', !!p.noAnimations);
    document.body.classList.toggle('show-timestamps', !!p.showTimestamps);
    document.body.classList.toggle('hide-avatars', !!p.hideAvatars);
    document.body.classList.toggle('hide-floaters', !!p.hideFloaters);
    document.body.classList.toggle('reduced-motion', prefersReducedMotion());

    document.body.dataset.chatWidth = p.chatWidth || 'normal';
    document.body.dataset.chatFont = p.chatFont || 'sans';
    document.body.dataset.sidebarWidth = p.sidebarWidth || 'normal';

    document.body.classList.remove('zoom-90', 'zoom-110', 'zoom-125');
    if (p.zoom === 90) document.body.classList.add('zoom-90');
    else if (p.zoom === 110) document.body.classList.add('zoom-110');
    else if (p.zoom === 125) document.body.classList.add('zoom-125');
  }

  /* ══════════════════════════════════════════════════════════════
     24 · API PÚBLICA (para debug)
     ══════════════════════════════════════════════════════════════ */

  window.__numination = {
    version: VERSION,
    build: BUILD,
    State,
    Bus,
    Storage,
    Toasts,
    Modal,
    ChatModel,
    Exporter,
    Markdown,
    TTS,
    STT,
    API,
    Status,
    SLASH_COMMANDS,
    TEMPLATES,
  };
    /* ══════════════════════════════════════════════════════════════
     25 · INDEXEDDB (fallback para conversaciones grandes)
     ══════════════════════════════════════════════════════════════ */

  const IDB = (() => {
    const DB_NAME = 'numination-db';
    const DB_VERSION = 1;
    const STORE = 'chats';
    let dbPromise = null;

    function open() {
      if (dbPromise) return dbPromise;
      if (!('indexedDB' in window)) return Promise.reject(new Error('sin indexedDB'));
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    }

    async function put(chat) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(chat);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    }

    async function get(id) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    }

    async function all() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    }

    async function del(id) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    }

    async function clear() {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    }

    async function backup() {
      const items = await all();
      const blob = new Blob([JSON.stringify({ version: DB_VERSION, items }, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `numination-idb-backup-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    }

    return { open, put, get, all, del, clear, backup, available: () => 'indexedDB' in window };
  })();

  /* ══════════════════════════════════════════════════════════════
     26 · SIDEBAR RESIZER (arrastrar borde)
     ══════════════════════════════════════════════════════════════ */

  const SidebarResizer = (() => {
    const MIN_W = 200;
    const MAX_W = 480;

    function init() {
      if (isMobile()) return;
      const app = $('.chat-app');
      const sidebar = $('[data-chat-sidebar]');
      if (!app || !sidebar) return;

      const handle = document.createElement('div');
      handle.className = 'sidebar-resizer';
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-label', 'Redimensionar barra lateral');
      sidebar.appendChild(handle);

      let dragging = false;
      let startX = 0;
      let startW = 0;

      handle.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX;
        startW = sidebar.offsetWidth;
        document.body.classList.add('is-resizing');
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const delta = e.clientX - startX;
        const next = clamp(startW + delta, MIN_W, MAX_W);
        document.documentElement.style.setProperty('--sidebar-width', next + 'px');
        app.style.gridTemplateColumns = `${next}px 1fr`;
      });

      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        document.body.classList.remove('is-resizing');
        const w = sidebar.offsetWidth;
        State.prefs.sidebarPx = w;
        persist.prefs();
      });

      // Restaurar ancho guardado
      if (State.prefs.sidebarPx) {
        const w = clamp(State.prefs.sidebarPx, MIN_W, MAX_W);
        document.documentElement.style.setProperty('--sidebar-width', w + 'px');
        app.style.gridTemplateColumns = `${w}px 1fr`;
      }

      // Doble click para resetear
      handle.addEventListener('dblclick', () => {
        document.documentElement.style.setProperty('--sidebar-width', '260px');
        app.style.gridTemplateColumns = '260px 1fr';
        delete State.prefs.sidebarPx;
        persist.prefs();
      });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     27 · MESSAGE COLLAPSE (ver más en mensajes largos)
     ══════════════════════════════════════════════════════════════ */

  const MessageCollapse = (() => {
    const MAX_HEIGHT = 420;

    function apply(bubble) {
      if (!bubble || bubble.dataset.collapseApplied) return;
      const text = bubble.querySelector('.msg__text');
      if (!text) return;
      const h = text.scrollHeight;
      if (h <= MAX_HEIGHT) return;

      bubble.dataset.collapseApplied = '1';
      bubble.classList.add('is-collapsed');

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'msg__expand';
      btn.innerHTML = `<span>Ver más</span>${svg('<polyline points="6 9 12 15 18 9"/>')}`;
      btn.addEventListener('click', () => {
        const collapsed = bubble.classList.toggle('is-collapsed');
        btn.querySelector('span').textContent = collapsed ? 'Ver más' : 'Ver menos';
      });
      bubble.appendChild(btn);
    }

    function scanAll() {
      $$('.msg--ai .msg__bubble').forEach(apply);
    }

    return { apply, scanAll };
  })();

  /* ══════════════════════════════════════════════════════════════
     28 · CODE BLOCKS ENHANCED (botón copiar + lenguaje)
     ══════════════════════════════════════════════════════════════ */

  const CodeBlocks = (() => {
    function enhance(bubble) {
      if (!bubble || bubble.dataset.codeApplied) return;
      bubble.dataset.codeApplied = '1';

      $$('.md-pre', bubble).forEach((pre) => {
        const code = pre.querySelector('code');
        if (!code) return;

        const wrap = document.createElement('div');
        wrap.className = 'md-pre-wrap';
        pre.parentNode.insertBefore(wrap, pre);
        wrap.appendChild(pre);

        const head = document.createElement('div');
        head.className = 'md-pre-head';
        const lang = detectLang(code.textContent);
        head.innerHTML = `
          <span class="md-pre-lang">${lang}</span>
          <button type="button" class="md-pre-copy" aria-label="Copiar código">
            ${svg('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>')}
            <span>Copiar</span>
          </button>`;
        wrap.insertBefore(head, pre);

        head.querySelector('.md-pre-copy').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          const ok = await copyToClipboard(code.textContent);
          const label = btn.querySelector('span');
          const original = label.textContent;
          label.textContent = ok ? 'Copiado' : 'Falló';
          setTimeout(() => { label.textContent = original; }, 1500);
        });
      });
    }

    function detectLang(sample) {
      const s = String(sample || '').slice(0, 400).toLowerCase();
      if (/^\s*(import|export|const|let|var|function|=>)/m.test(s)) return 'javascript';
      if (/^\s*(def|class|import|from|self\.)/m.test(s)) return 'python';
      if (/^\s*(<[a-z]|<\/[a-z])/m.test(s)) return 'html';
      if (/^\s*(\.[a-z-]+\s*\{|@media|:root)/m.test(s)) return 'css';
      if (/^\s*(select|from|where|insert|update)/m.test(s)) return 'sql';
      if (/^\s*(\{|\[)/.test(s)) return 'json';
      if (/^\s*(\$|#|>)/.test(s)) return 'shell';
      return 'texto';
    }

    return { enhance, detectLang };
  })();

  /* ══════════════════════════════════════════════════════════════
     29 · TAGS Y COLORES
     ══════════════════════════════════════════════════════════════ */

  const Tags = (() => {
    const PALETTE = [
      { name: 'Matemáticas', color: '#3b82f6' },
      { name: 'Ciencias',    color: '#10b981' },
      { name: 'Sociales',    color: '#f59e0b' },
      { name: 'Lenguaje',    color: '#8b5cf6' },
      { name: 'Inglés',      color: '#ec4899' },
      { name: 'Examen',      color: '#ef4444' },
      { name: 'Importante',  color: '#dc2626' },
      { name: 'Ideas',       color: '#06b6d4' },
    ];

    function forChat(chatId) {
      return State.prefs.tags?.[chatId] || [];
    }

    function toggle(chatId, tagName) {
      if (!State.prefs.tags) State.prefs.tags = {};
      const list = State.prefs.tags[chatId] || [];
      const i = list.findIndex((t) => t === tagName);
      if (i >= 0) list.splice(i, 1);
      else list.push(tagName);
      State.prefs.tags[chatId] = list;
      persist.prefs();
      Bus.emit('tags:changed', { chatId, tags: list });
    }

    function render(chat, container) {
      const list = forChat(chat.id);
      container.innerHTML = '';
      for (const t of list) {
        const tag = PALETTE.find((x) => x.name === t);
        if (!tag) continue;
        const el = document.createElement('span');
        el.className = 'chat-tag-badge';
        el.style.background = tag.color + '22';
        el.style.color = tag.color;
        el.style.borderColor = tag.color + '55';
        el.textContent = t;
        container.appendChild(el);
      }
    }

    return { PALETTE, forChat, toggle, render };
  })();

  /* ══════════════════════════════════════════════════════════════
     30 · PLANTILLAS PERSONALIZADAS
     ══════════════════════════════════════════════════════════════ */

  const CustomTemplates = (() => {
    const KEY = 'numination-custom-templates';

    function list() {
      return Storage.read(KEY, []) || [];
    }

    function save(template) {
      const items = list();
      items.unshift({ ...template, id: uid('tpl'), ts: nowMs() });
      Storage.write(KEY, items.slice(0, 100));
      Bus.emit('templates:changed');
    }

    function remove(id) {
      const items = list().filter((t) => t.id !== id);
      Storage.write(KEY, items);
      Bus.emit('templates:changed');
    }

    function use(id, onPick) {
      const tpl = list().find((t) => t.id === id);
      if (!tpl) return;
      onPick && onPick(tpl.body);
    }

    return { list, save, remove, use };
  })();

  /* ══════════════════════════════════════════════════════════════
     31 · HISTORIAL DE BÚSQUEDAS
     ══════════════════════════════════════════════════════════════ */

  const SearchHistory = (() => {
    const KEY = 'numination-search-history';
    const MAX = 20;

    function push(query) {
      const q = String(query || '').trim();
      if (!q) return;
      const items = list().filter((x) => x !== q);
      items.unshift(q);
      Storage.write(KEY, items.slice(0, MAX));
    }

    function list() {
      return Storage.read(KEY, []) || [];
    }

    function clear() {
      Storage.write(KEY, []);
    }

    return { push, list, clear };
  })();

  /* ══════════════════════════════════════════════════════════════
     32 · SUGERENCIAS INTELIGENTES
     ══════════════════════════════════════════════════════════════ */

  const SmartSuggestions = (() => {
    const KEYWORDS = {
      'ecuación|algebra|factoriz|x²':    ['Resolver paso a paso', 'Graficar la función', 'Dame 3 ejercicios'],
      'química|molécula|reacción':       ['Balancear la ecuación', 'Explicar con ejemplo', 'Tipos de reacción'],
      'física|velocidad|fuerza':         ['Aplicar fórmula', 'Unidad correcta', 'Ejemplo cotidiano'],
      'historia|independencia|colonia':  ['Línea de tiempo', 'Causas y consecuencias', 'Personajes clave'],
      'inglés|english|verb':             ['Conjugar verbos', 'Ejemplo de uso', 'Falso amigo'],
      'redacción|ensayo|texto':          ['Estructura sugerida', 'Conectores útiles', 'Revisar mi texto'],
    };

    function suggest(lastText) {
      const t = String(lastText || '').toLowerCase();
      for (const pattern of Object.keys(KEYWORDS)) {
        const re = new RegExp(pattern, 'i');
        if (re.test(t)) return KEYWORDS[pattern];
      }
      return ['Explícame más simple', 'Dame un ejemplo', 'Hazme 3 preguntas'];
    }

    function render(container, baseText, onPick) {
      const items = suggest(baseText);
      container.innerHTML = '';
      for (const s of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'smart-chip';
        b.textContent = s;
        b.addEventListener('click', () => onPick(s));
        container.appendChild(b);
      }
    }

    return { suggest, render };
  })();

  /* ══════════════════════════════════════════════════════════════
     33 · ANALYTICS MINI (sparklines)
     ══════════════════════════════════════════════════════════════ */

  const Sparklines = (() => {
    function draw(canvas, data, color = '#7c93d4') {
      if (!canvas || !data?.length) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.offsetWidth || 200;
      const h = canvas.offsetHeight || 40;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      const max = Math.max(...data, 1);
      const min = Math.min(...data, 0);
      const range = max - min || 1;
      const step = w / Math.max(data.length - 1, 1);

      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.lineJoin = 'round';

      data.forEach((v, i) => {
        const x = i * step;
        const y = h - ((v - min) / range) * (h - 4) - 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      // Fill bajo la línea
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fillStyle = color + '22';
      ctx.fill();
    }

    function fromChats() {
      const days = Array(14).fill(0);
      const now = nowMs();
      const day = 24 * 60 * 60 * 1000;
      for (const chat of State.chats) {
        const d = Math.floor((now - chat.createdAt) / day);
        if (d >= 0 && d < 14) days[13 - d]++;
      }
      return days;
    }

    return { draw, fromChats };
  })();

  /* ══════════════════════════════════════════════════════════════
     34 · NOTAS POR CONVERSACIÓN
     ══════════════════════════════════════════════════════════════ */

  const Notes = (() => {
    const KEY = 'numination-notes';

    function get(chatId) {
      const all = Storage.read(KEY, {}) || {};
      return all[chatId] || '';
    }

    function set(chatId, text) {
      const all = Storage.read(KEY, {}) || {};
      all[chatId] = String(text || '');
      Storage.write(KEY, all);
      Bus.emit('notes:changed', { chatId });
    }

    function remove(chatId) {
      const all = Storage.read(KEY, {}) || {};
      delete all[chatId];
      Storage.write(KEY, all);
    }

    return { get, set, remove };
  })();

  /* ══════════════════════════════════════════════════════════════
     35 · MATH LIGHT (sub/superíndices, símbolos)
     ══════════════════════════════════════════════════════════════ */

  const MathLight = (() => {
    const MAP = {
      '\\pi': 'π', '\\alpha': 'α', '\\beta': 'β', '\\gamma': 'γ',
      '\\delta': 'δ', '\\theta': 'θ', '\\lambda': 'λ', '\\mu': 'μ',
      '\\sigma': 'σ', '\\phi': 'φ', '\\omega': 'ω',
      '\\infty': '∞', '\\pm': '±', '\\times': '×', '\\div': '÷',
      '\\leq': '≤', '\\geq': '≥', '\\neq': '≠', '\\approx': '≈',
      '\\rightarrow': '→', '\\leftarrow': '←', '\\sum': 'Σ',
      '\\int': '∫', '\\sqrt': '√',
    };

    function render(text) {
      let out = String(text || '');
      for (const [k, v] of Object.entries(MAP)) {
        out = out.split(k).join(v);
      }
      // x^2 → x²
      out = out.replace(/\^(\d)/g, (_, d) =>
        ['⁰','¹','²','³','⁴','⁵','⁶','⁷','⁸','⁹'][parseInt(d, 10)]);
      // x_2 → x₂
      out = out.replace(/_(\d)/g, (_, d) =>
        ['₀','₁','₂','₃','₄','₅','₆','₇','₈','₉'][parseInt(d, 10)]);
      return out;
    }

    return { render };
  })();

  /* ══════════════════════════════════════════════════════════════
     36 · FULLSCREEN
     ══════════════════════════════════════════════════════════════ */

  const Fullscreen = (() => {
    function toggle() {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen?.().catch(() => {});
      } else {
        document.exitFullscreen?.();
      }
    }

    function isActive() {
      return Boolean(document.fullscreenElement);
    }

    document.addEventListener('fullscreenchange', () => {
      document.body.classList.toggle('is-fullscreen', isActive());
    });

    return { toggle, isActive };
  })();

  /* ══════════════════════════════════════════════════════════════
     37 · PRINT MODE
     ══════════════════════════════════════════════════════════════ */

  const PrintMode = (() => {
    function trigger() {
      document.body.classList.add('is-printing');
      window.print();
      setTimeout(() => document.body.classList.remove('is-printing'), 500);
    }

    function setupPrintHeader() {
      const header = document.createElement('div');
      header.className = 'print-header';
      header.innerHTML = `
        <h1>Numination</h1>
        <p>Exportado el ${new Date().toLocaleString('es-CO')}</p>`;
      document.body.appendChild(header);
    }

    return { trigger, setupPrintHeader };
  })();

  /* ══════════════════════════════════════════════════════════════
     38 · LINK EXTRACTOR
     ══════════════════════════════════════════════════════════════ */

  const LinkExtractor = (() => {
    const URL_RE = /https?:\/\/[^\s<>"')]+/g;

    function fromChat(chat) {
      if (!chat) return [];
      const set = new Set();
      for (const m of chat.messages) {
        const found = m.content.match(URL_RE) || [];
        found.forEach((u) => set.add(u));
        if (m.imageUrl) set.add(m.imageUrl);
      }
      return [...set];
    }

    function show(chat) {
      const links = fromChat(chat);
      const list = document.createElement('ul');
      list.className = 'nm-linklist';
      if (!links.length) {
        list.innerHTML = '<li class="nm-linklist__empty">No hay enlaces en esta conversación.</li>';
      } else {
        for (const url of links) {
          const li = document.createElement('li');
          li.innerHTML = `
            <a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>
            <button type="button" class="nm-linklist__copy" aria-label="Copiar">📋</button>`;
          li.querySelector('.nm-linklist__copy').addEventListener('click', async () => {
            const ok = await copyToClipboard(url);
            Toasts[ok ? 'ok' : 'err'](ok ? 'Copiado.' : 'Falló.');
          });
          list.appendChild(li);
        }
      }
      Modal.open({
        title: `Enlaces (${links.length})`,
        body: list,
        actions: [
          { label: 'Copiar todos', onClick: async () => {
            const ok = await copyToClipboard(links.join('\n'));
            Toasts[ok ? 'ok' : 'err'](ok ? 'Todos copiados.' : 'Falló.');
          }},
          { label: 'Cerrar' },
        ],
      });
    }

    return { fromChat, show };
  })();

  /* ══════════════════════════════════════════════════════════════
     39 · PERSONALIZADOR DE TEMA
     ══════════════════════════════════════════════════════════════ */

  const ThemeCustomizer = (() => {
    const KEY = 'numination-custom-theme';
    const VARS = [
      { key: '--c-bg',        label: 'Fondo',         def: '#ffffff' },
      { key: '--c-bg-alt',    label: 'Fondo alt',     def: '#f7f7f5' },
      { key: '--c-fg',        label: 'Texto',         def: '#1f1f1e' },
      { key: '--c-fg-muted',  label: 'Texto suave',   def: '#6b6b68' },
      { key: '--c-border',    label: 'Bordes',        def: '#e8e6e1' },
      { key: '--c-accent',    label: 'Acento',        def: '#1a1a2e' },
    ];

    function apply(theme) {
      if (!theme) return;
      for (const [k, v] of Object.entries(theme)) {
        document.documentElement.style.setProperty(k, v);
      }
    }

    function reset() {
      Storage.remove(KEY);
      for (const v of VARS) document.documentElement.style.removeProperty(v.key);
    }

    function load() {
      const t = Storage.read(KEY, null);
      if (t) apply(t);
    }

    function show() {
      const current = Storage.read(KEY, {}) || {};
      const form = document.createElement('div');
      form.className = 'nm-custom-theme';
      for (const v of VARS) {
        const row = document.createElement('label');
        row.className = 'nm-custom-theme__row';
        row.innerHTML = `
          <span>${v.label}</span>
          <input type="color" value="${current[v.key] || v.def}" data-var="${v.key}" />
          <code>${current[v.key] || v.def}</code>`;
        form.appendChild(row);
      }
      const back = Modal.open({
        title: 'Tema personalizado',
        body: form,
        actions: [
          { label: 'Restaurar', onClick: reset },
          { label: 'Aplicar', variant: 'btn--primary', onClick: () => {
            const theme = {};
            form.querySelectorAll('[data-var]').forEach((inp) => {
              theme[inp.dataset.var] = inp.value;
            });
            Storage.write(KEY, theme);
            apply(theme);
            Toasts.ok('Tema aplicado.');
          }},
          { label: 'Cerrar' },
        ],
      });

      form.querySelectorAll('input[type="color"]').forEach((inp) => {
        inp.addEventListener('input', () => {
          inp.nextElementSibling.textContent = inp.value;
          document.documentElement.style.setProperty(inp.dataset.var, inp.value);
        });
      });
    }

    return { apply, reset, load, show };
  })();

  /* ══════════════════════════════════════════════════════════════
     40 · DETECCIÓN DE SPAM / CONTENIDO
     ══════════════════════════════════════════════════════════════ */

  const ContentFilter = (() => {
    const BLOCKED = [
      /\b(?:puta|mierda|verga|pendejo|marica|gonorrea|hp|hijueputa)\b/gi,
    ];

    function has(text) {
      const t = String(text || '');
      return BLOCKED.some((re) => re.test(t));
    }

    function mask(text) {
      let out = String(text || '');
      for (const re of BLOCKED) {
        out = out.replace(re, (m) => '*'.repeat(m.length));
      }
      return out;
    }

    return { has, mask };
  })();

  /* ══════════════════════════════════════════════════════════════
     41 · MIGRACIÓN A INDEXEDDB
     ══════════════════════════════════════════════════════════════ */

  const Migrator = (() => {
    async function run() {
      if (!IDB.available()) return { skipped: true, reason: 'sin idb' };
      if (State.prefs.idbMigrated) return { skipped: true, reason: 'ya migrado' };
      try {
        for (const chat of State.chats) await IDB.put(chat);
        State.prefs.idbMigrated = true;
        persist.prefs();
        return { ok: true, count: State.chats.length };
      } catch (e) {
        return { ok: false, error: String(e) };
      }
    }

    async function restore() {
      if (!IDB.available()) return 0;
      const items = await IDB.all();
      if (!items.length) return 0;
      State.chats = items.map(ChatModel.normalizeChat).filter(Boolean);
      persist.chats();
      return State.chats.length;
    }

    return { run, restore };
  })();

  /* ══════════════════════════════════════════════════════════════
     42 · VISOR DE NOTAS
     ══════════════════════════════════════════════════════════════ */

  const NotesView = (() => {
    function show(chatId) {
      const current = Notes.get(chatId);
      const ta = document.createElement('textarea');
      ta.className = 'nm-notes-area';
      ta.value = current;
      ta.placeholder = 'Escribe notas sobre esta conversación…';
      ta.rows = 10;
      Modal.open({
        title: 'Notas',
        body: ta,
        actions: [
          { label: 'Borrar', onClick: () => { Notes.remove(chatId); Toasts.info('Notas borradas.'); } },
          { label: 'Guardar', variant: 'btn--primary', onClick: () => {
            Notes.set(chatId, ta.value);
            Toasts.ok('Notas guardadas.');
          }},
          { label: 'Cerrar' },
        ],
      });
      setTimeout(() => ta.focus(), 100);
    }

    return { show };
  })();

  /* ══════════════════════════════════════════════════════════════
     43 · DASHBOARD DE ACTIVIDAD
     ══════════════════════════════════════════════════════════════ */

  const Dashboard = (() => {
    function show() {
      const s = ChatModel.stats();
      const spark = document.createElement('canvas');
      spark.className = 'nm-sparkline';
      spark.style.width = '100%';
      spark.style.height = '60px';

      const body = document.createElement('div');
      body.innerHTML = `
        <ul class="nm-stats">
          <li><strong>${fmtNumber(s.chats)}</strong><span>conversaciones</span></li>
          <li><strong>${fmtNumber(s.msgs)}</strong><span>mensajes</span></li>
          <li><strong>${fmtNumber(s.words)}</strong><span>palabras</span></li>
          <li><strong>${fmtNumber(s.pinned)}</strong><span>fijadas</span></li>
        </ul>
        <h4 class="nm-dash__title">Actividad últimos 14 días</h4>`;
      body.appendChild(spark);
      const days = Sparklines.fromChats();
      Modal.open({
        title: 'Panel de actividad',
        body,
        actions: [{ label: 'Cerrar' }],
      });
      setTimeout(() => Sparklines.draw(spark, days), 100);
    }

    return { show };
  })();

  /* ══════════════════════════════════════════════════════════════
     44 · APLICAR MEJORAS AL BOOT
     ══════════════════════════════════════════════════════════════ */

  // Se ejecutan después de que init() termine.
  Bus.on('chat:booted', () => {
    SidebarResizer.init();
    MessageCollapse.scanAll();
    ThemeCustomizer.load();
    Migrator.run().then((r) => {
      if (r.ok) console.info(`[idb] migradas ${r.count} conversaciones`);
    });
  });

  Bus.on('message:added', ({ msg }) => {
    // Scroll auto y aplicar collapse a mensajes largos
    setTimeout(() => {
      const last = $$('.msg--ai .msg__bubble').pop();
      if (last) {
        MessageCollapse.apply(last);
        CodeBlocks.enhance(last);
      }
    }, 60);
  });

  Bus.on('chat:created', () => {
    setTimeout(() => MessageCollapse.scanAll(), 100);
  });

  Bus.on('chat:loaded', () => {
    setTimeout(() => {
      MessageCollapse.scanAll();
      $$('.msg--ai .msg__bubble').forEach(CodeBlocks.enhance);
    }, 100);
  });

})();