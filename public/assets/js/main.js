/* ================================================================
   NUMINATION · main.js v6.0 «Nocturno»
   ----------------------------------------------------------------
   Runtime global del sitio. Un solo IIFE. Sin dependencias.
   Alineado con main.css v6, auth.css v3, chat.css v6.
   Autor: Numination · Colombia · 2026
   ================================================================ */

(() => {
  'use strict';

  /* ══════════════════════════════════════════════════════════════
     1 · CONFIGURACIÓN
     ══════════════════════════════════════════════════════════════ */

  const VERSION = '6.0.0';
  const BUILD   = '2026.09';
  const IS_DEV    = new URLSearchParams(location.search).has('debug') || location.hostname === 'localhost';
  const IS_MOBILE = matchMedia('(max-width: 768px)').matches;
  const IS_TOUCH  = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const REDUCED   = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const CFG = {
    version: VERSION,
    build: BUILD,
    themeKey:    'numination-theme',
    prefsKey:    'numination-prefs',
    formsKey:    'numination-forms',
    bookmarksKey:'numination-bookmarks',
    cookieKey:   'numination-cookie-consent',
    analyticsKey:'numination-events',
    toastDuration: 2600,
    scrollTopThreshold: 600,
    navbarShrinkAt: 40,
    revealThreshold: 0.12,
    countersDuration: 1600,
  };

  /* Rutas activas — v6 sin contacto.html ni nosotros.html */
  const ROUTES = {
    home:    '/index.html',
    login:   '/login.html',
    chat:    '/chat.html',
    pricing: '/precio.html',
    legal:   '/terminos.html',
  };

  /* Los 4 temas del rediseño Nocturno */
  const THEMES = {
    oscuro:     { label: 'Oscuro',     meta: '#0a0a0a', dot: '#0a0a0a' },
    medianoche: { label: 'Medianoche', meta: '#0a0a1a', dot: '#7c5eff' },
    gris:       { label: 'Gris',       meta: '#1a1a1f', dot: '#7c5eff' },
    blanco:     { label: 'Blanco',     meta: '#ffffff', dot: '#7c5eff' },
  };
  const THEME_IDS = Object.keys(THEMES);

  const EMOJI = { ok: '✓', warn: '⚠', err: '✕', info: 'ⓘ' };

  /* Paleta Nocturna — reemplaza la vieja Colombia+navy */
  const PALETTE = ['#7c5eff', '#a78bfa', '#8d72ff', '#5b3dd4', '#c4b5fd', '#6d28d9'];

  /* ══════════════════════════════════════════════════════════════
     2 · UTILIDADES BASE
     ══════════════════════════════════════════════════════════════ */

  const $   = (sel, root = document) => root.querySelector(sel);
  const $$  = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const $id = (id) => document.getElementById(id);

  const isFn  = (v) => typeof v === 'function';
  const isStr = (v) => typeof v === 'string';
  const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const isArr = Array.isArray;
  const isNode = (v) => v instanceof Node;

  const clamp  = (n, min, max) => Math.min(Math.max(n, min), max);
  const lerp   = (a, b, t) => a + (b - a) * t;
  const invLerp= (a, b, v) => (v - a) / (b - a);
  const mapRange = (v, a1, a2, b1, b2) => lerp(b1, b2, invLerp(a1, a2, v));
  const uid    = (p = 'x') =>
    `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const nowMs  = () => Date.now();
  const nowIso = () => new Date().toISOString();

  const log  = (...a) => { if (IS_DEV) console.log('%c[numination]', 'color:#7c5eff;font-weight:bold', ...a); };
  const warn = (...a) => { if (IS_DEV) console.warn('[numination]', ...a); };
  const err  = (...a) => console.error('[numination]', ...a);

  const escapeHtml = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const escapeAttr = escapeHtml;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf   = (fn) => requestAnimationFrame(fn);
  const noop  = () => {};

  const debounce = (fn, wait = 200) => {
    let t;
    return function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), wait);
    };
  };

  const throttle = (fn, wait = 100) => {
    let last = 0, timer = null;
    return function (...a) {
      const now = nowMs();
      const rem = wait - (now - last);
      if (rem <= 0) {
        clearTimeout(timer); timer = null; last = now;
        fn.apply(this, a);
      } else if (!timer) {
        timer = setTimeout(() => { last = nowMs(); timer = null; fn.apply(this, a); }, rem);
      }
    };
  };

  /* ══════════════════════════════════════════════════════════════
     3 · STRINGS
     ══════════════════════════════════════════════════════════════ */

  const Str = {
    capitalize: (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
    titleCase:  (s) => s.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()),
    slug: (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
    truncate: (s, n = 100, e = '…') => s.length > n ? s.slice(0, n - e.length) + e : s,
    words:    (s) => s.trim().split(/\s+/).filter(Boolean),
    countWords: (s) => Str.words(s).length,
    isEmail:  (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
    isUrl:    (s) => /^https?:\/\/.+/.test(s),
    isPhone:  (s) => /^[\+]?[\d\s\-\(\)]{7,}$/.test(s),
  };

  /* ══════════════════════════════════════════════════════════════
     4 · NÚMEROS Y FECHAS
     ══════════════════════════════════════════════════════════════ */

  const Num = {
    fmt: (n, d = 0) => Number(n).toLocaleString('es-CO', {
      minimumFractionDigits: d, maximumFractionDigits: d,
    }),
    fmtBytes: (b) => {
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
      if (b < 1024 ** 3) return (b / 1024 / 1024).toFixed(1) + ' MB';
      return (b / 1024 ** 3).toFixed(2) + ' GB';
    },
    fmtCurrency: (n, cur = 'COP') => new Intl.NumberFormat('es-CO', {
      style: 'currency', currency: cur, maximumFractionDigits: 0,
    }).format(n),
    round: (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d,
    randomInt: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
  };

  const DateU = {
    fmt: (ts, opts) => new Date(ts).toLocaleString('es-CO', opts),
    date: (ts) => new Date(ts).toLocaleDateString('es-CO'),
    time: (ts) => new Date(ts).toLocaleTimeString('es-CO'),
    relative: (ts) => {
      const s = Math.floor((nowMs() - ts) / 1000);
      if (s < 60) return 'hace un momento';
      const m = Math.floor(s / 60);
      if (m < 60) return `hace ${m} min`;
      const h = Math.floor(m / 60);
      if (h < 24) return `hace ${h} h`;
      const d = Math.floor(h / 24);
      if (d < 7) return `hace ${d} d`;
      return DateU.date(ts);
    },
    addDays: (ts, n) => ts + n * 86400000,
    isToday: (ts) => new Date(ts).toDateString() === new Date().toDateString(),
  };

  /* ══════════════════════════════════════════════════════════════
     5 · COLORES — paleta Nocturna
     ══════════════════════════════════════════════════════════════ */

  const Color = {
    hexToRgb(hex) {
      const h = hex.replace('#', '');
      const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      return {
        r: parseInt(n.slice(0, 2), 16),
        g: parseInt(n.slice(2, 4), 16),
        b: parseInt(n.slice(4, 6), 16),
      };
    },
    rgbToHex(r, g, b) {
      const to = (n) => clamp(n, 0, 255).toString(16).padStart(2, '0');
      return '#' + to(r) + to(g) + to(b);
    },
    luminance(hex) {
      const { r, g, b } = Color.hexToRgb(hex);
      const a = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    },
    contrast(hex1, hex2) {
      const l1 = Color.luminance(hex1);
      const l2 = Color.luminance(hex2);
      const [max, min] = l1 > l2 ? [l1, l2] : [l2, l1];
      return (max + 0.05) / (min + 0.05);
    },
    mix(hex1, hex2, ratio = 0.5) {
      const a = Color.hexToRgb(hex1);
      const b = Color.hexToRgb(hex2);
      return Color.rgbToHex(
        Math.round(lerp(a.r, b.r, ratio)),
        Math.round(lerp(a.g, b.g, ratio)),
        Math.round(lerp(a.b, b.b, ratio)),
      );
    },
    lighten: (hex, amount = 0.1) => Color.mix(hex, '#ffffff', amount),
    darken:  (hex, amount = 0.1) => Color.mix(hex, '#000000', amount),
    random: (palette = PALETTE) => palette[Math.floor(Math.random() * palette.length)],
    palette: PALETTE,
  };

  /* ══════════════════════════════════════════════════════════════
     6 · DOM
     ══════════════════════════════════════════════════════════════ */

  const Dom = {
    el(tag, attrs = {}, children = []) {
      const e = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'style' && isObj(v)) Object.assign(e.style, v);
        else if (k.startsWith('on') && isFn(v)) e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'dataset' && isObj(v)) Object.assign(e.dataset, v);
        else e.setAttribute(k, v);
      }
      for (const c of [].concat(children)) {
        if (c == null) continue;
        e.appendChild(isNode(c) ? c : document.createTextNode(String(c)));
      }
      return e;
    },
    fromHtml(html) {
      const t = document.createElement('template');
      t.innerHTML = html.trim();
      return t.content.firstElementChild;
    },
    frag(children) {
      const f = document.createDocumentFragment();
      for (const c of children) {
        if (c == null) continue;
        f.appendChild(isNode(c) ? c : document.createTextNode(String(c)));
      }
      return f;
    },
    clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; },
    on(el, event, handler, opts) {
      el.addEventListener(event, handler, opts);
      return () => el.removeEventListener(event, handler, opts);
    },
    delegate(root, selector, event, handler) {
      const wrap = (e) => {
        const t = e.target.closest(selector);
        if (t && root.contains(t)) handler.call(t, e, t);
      };
      root.addEventListener(event, wrap);
      return () => root.removeEventListener(event, wrap);
    },
    offset(el) {
      const r = el.getBoundingClientRect();
      return { top: r.top + scrollY, left: r.left + scrollX, width: r.width, height: r.height };
    },
    inView(el, margin = 0) {
      const r = el.getBoundingClientRect();
      return r.bottom >= -margin && r.top <= innerHeight + margin;
    },
    addClass(el, ...c)    { el?.classList.add(...c.filter(Boolean)); },
    removeClass(el, ...c) { el?.classList.remove(...c.filter(Boolean)); },
    toggleClass(el, c, f) { el?.classList.toggle(c, f); },
    hasClass(el, c)       { return el?.classList?.contains(c) || false; },
    css(el, prop, value) {
      if (!el) return;
      if (isStr(prop)) {
        if (value == null) return getComputedStyle(el).getPropertyValue(prop);
        el.style.setProperty(prop, value);
      } else Object.assign(el.style, prop);
    },
    show(el, display = '') { if (el) el.style.display = display; },
    hide(el) { if (el) el.style.display = 'none'; },
    animate(el, kf, opts = {}) {
      if (REDUCED) return Promise.resolve();
      return new Promise((resolve) => {
        const anim = el.animate(kf, {
          duration: opts.duration ?? 300,
          easing: opts.easing ?? 'cubic-bezier(.4,0,.2,1)',
          fill: opts.fill ?? 'forwards',
          delay: opts.delay ?? 0,
        });
        anim.onfinish = () => resolve(anim);
        anim.oncancel = () => resolve(anim);
      });
    },
  };

  /* ══════════════════════════════════════════════════════════════
     7 · STORAGE
     ══════════════════════════════════════════════════════════════ */

  const Store = {
    available: (() => {
      try { localStorage.setItem('__t__', '1'); localStorage.removeItem('__t__'); return true; }
      catch { return false; }
    })(),
    read(key, fallback = null) {
      if (!Store.available) return fallback;
      try {
        const raw = localStorage.getItem(key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch { return fallback; }
    },
    write(key, value) {
      if (!Store.available) return false;
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e) {
        if (e.name === 'QuotaExceededError') Bus.emit('storage:quota', { key });
        return false;
      }
    },
    remove(key) { if (Store.available) try { localStorage.removeItem(key); } catch {} },
    has(key)    { return Store.available && localStorage.getItem(key) !== null; },
    keys(prefix = '') {
      if (!Store.available) return [];
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) out.push(k);
      }
      return out;
    },
    clear(prefix = '') {
      if (!Store.available) return;
      for (const k of Store.keys(prefix)) localStorage.removeItem(k);
    },
  };

  const Session = {
    read(key, fallback = null) {
      try {
        const raw = sessionStorage.getItem(key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch { return fallback; }
    },
    write(key, value) {
      try { sessionStorage.setItem(key, JSON.stringify(value)); return true; }
      catch { return false; }
    },
    remove(key) { try { sessionStorage.removeItem(key); } catch {} },
  };

  /* ══════════════════════════════════════════════════════════════
     8 · EVENT BUS
     ══════════════════════════════════════════════════════════════ */

  const Bus = (() => {
    const listeners = new Map();
    function on(evt, h) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(h);
      return () => off(evt, h);
    }
    function off(evt, h) { listeners.get(evt)?.delete(h); }
    function emit(evt, payload) {
      const set = listeners.get(evt);
      if (set) for (const h of [...set]) {
        try { h(payload); } catch (e) { warn('bus', evt, e); }
      }
    }
    return { on, off, emit };
  })();

  /* ══════════════════════════════════════════════════════════════
     9 · TOASTS
     ══════════════════════════════════════════════════════════════ */

  const Toasts = (() => {
    let host = null;
    let maxVisible = 3;

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
      const icon = EMOJI[kind] || '';
      el.innerHTML = icon
        ? `<span class="toast__ico">${icon}</span><span class="toast__msg">${escapeHtml(message)}</span>`
        : escapeHtml(message);
      h.appendChild(el);
      raf(() => el.classList.add('is-visible'));
      while (h.children.length > maxVisible) h.firstElementChild?.remove();

      const ttl = Number(opts.duration ?? CFG.toastDuration);
      const timer = setTimeout(dismiss, ttl);
      function dismiss() {
        clearTimeout(timer);
        el.classList.remove('is-visible');
        setTimeout(() => el.remove(), 260);
      }
      el.addEventListener('click', dismiss);
      Bus.emit('toast:shown', { kind, message });
      return dismiss;
    }

    return {
      show,
      ok:   (m, o) => show(m, 'ok', o),
      warn: (m, o) => show(m, 'warn', o),
      err:  (m, o) => show(m, 'err', o),
      info: (m, o) => show(m, 'info', o),
      clear: () => { if (host) host.innerHTML = ''; },
      setMax: (n) => { maxVisible = n; },
    };
  })();

  /* ══════════════════════════════════════════════════════════════
     10 · MODAL
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
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </header>
          <div class="nm-modal__body"></div>
          <footer class="nm-modal__foot"></footer>
        </div>`;

      const bodyEl = back.querySelector('.nm-modal__body');
      if (isStr(body)) bodyEl.innerHTML = body;
      else if (isNode(body)) bodyEl.appendChild(body);

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

      const focusable = back.querySelector('input, textarea, button:not(.nm-modal__close), [tabindex]');
      if (focusable) setTimeout(() => focusable.focus(), 60);
      A11y.trapFocus(back);
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
     11 · TOOLTIP
     ══════════════════════════════════════════════════════════════ */

  const Tooltip = (() => {
    let el = null;
    let timer = null;

    function ensure() {
      if (el && document.body.contains(el)) return el;
      el = document.createElement('div');
      el.className = 'nm-tooltip';
      el.setAttribute('role', 'tooltip');
      document.body.appendChild(el);
      return el;
    }

    function show(target, text, opts = {}) {
      const node = ensure();
      node.textContent = text;
      node.classList.add('is-visible');
      const r  = target.getBoundingClientRect();
      const tr = node.getBoundingClientRect();
      const placement = opts.placement || 'top';
      let top, left;
      if (placement === 'bottom') {
        top = r.bottom + scrollY + 8;
        left = r.left + scrollX + r.width / 2 - tr.width / 2;
      } else {
        top = r.top + scrollY - tr.height - 8;
        left = r.left + scrollX + r.width / 2 - tr.width / 2;
      }
      left = clamp(left, 8, innerWidth - tr.width - 8);
      top = Math.max(top, 8);
      node.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    }

    function hide() { el?.classList.remove('is-visible'); }

    function bind(root = document) {
      root.addEventListener('mouseenter', (e) => {
        const t = e.target.closest('[data-tooltip]');
        if (!t) return;
        clearTimeout(timer);
        timer = setTimeout(() => show(t, t.dataset.tooltip, {
          placement: t.dataset.tooltipPlacement,
        }), 320);
      }, true);

      root.addEventListener('mouseleave', (e) => {
        const t = e.target.closest('[data-tooltip]');
        if (!t) return;
        clearTimeout(timer);
        hide();
      }, true);

      document.addEventListener('scroll', hide, { passive: true });
    }

    return { show, hide, bind };
  })();

  /* ══════════════════════════════════════════════════════════════
     12 · DROPDOWN
     ══════════════════════════════════════════════════════════════ */

  const Dropdown = (() => {
    const openStack = [];

    function init() {
      Dom.delegate(document, '[data-dropdown-trigger]', 'click', (e, trigger) => {
        e.stopPropagation();
        const id = trigger.dataset.dropdownTrigger;
        const menu = document.querySelector(`[data-dropdown="${id}"]`);
        if (!menu) return;
        toggle(menu, trigger);
      });
      document.addEventListener('click', closeAll);
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });
    }

    function toggle(menu, trigger) {
      menu.classList.contains('is-open') ? close(menu) : open(menu, trigger);
    }

    function open(menu, trigger) {
      closeAll();
      menu.classList.add('is-open');
      trigger?.classList.add('is-active');
      openStack.push({ menu, trigger });
    }

    function close(menu) {
      menu.classList.remove('is-open');
      const i = openStack.findIndex((x) => x.menu === menu);
      if (i >= 0) {
        openStack[i].trigger?.classList.remove('is-active');
        openStack.splice(i, 1);
      }
    }

    function closeAll() { [...openStack].forEach((x) => close(x.menu)); }

    return { init, open, close, closeAll };
  })();

  /* ══════════════════════════════════════════════════════════════
     13 · TABS
     ══════════════════════════════════════════════════════════════ */

  const Tabs = (() => {
    function init(root = document) {
      $$('[data-tabs]', root).forEach((group) => {
        const triggers = $$('[data-tab]', group);
        const panels   = $$('[data-tab-panel]', group);
        if (!triggers.length) return;

        const activate = (key) => {
          triggers.forEach((t) => {
            const on = t.dataset.tab === key;
            t.classList.toggle('is-active', on);
            t.setAttribute('aria-selected', String(on));
          });
          panels.forEach((p) => {
            p.classList.toggle('is-active', p.dataset.tabPanel === key);
          });
          Bus.emit('tabs:changed', { key, group });
        };

        triggers.forEach((t) => {
          t.addEventListener('click', () => activate(t.dataset.tab));
          t.addEventListener('keydown', (e) => {
            const i = triggers.indexOf(t);
            if (e.key === 'ArrowRight') { e.preventDefault(); triggers[(i + 1) % triggers.length].focus(); }
            if (e.key === 'ArrowLeft')  { e.preventDefault(); triggers[(i - 1 + triggers.length) % triggers.length].focus(); }
          });
        });

        const active = triggers.find((t) => t.classList.contains('is-active'));
        if (active) activate(active.dataset.tab);
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     14 · ACORDEÓN
     ══════════════════════════════════════════════════════════════ */

  const Accordion = (() => {
    function init(root = document) {
      $$('[data-accordion]', root).forEach((group) => {
        const items = $$('[data-accordion-item]', group);
        const single = group.dataset.accordion === 'single';

        items.forEach((item) => {
          const trigger = item.querySelector('[data-accordion-trigger]');
          if (!trigger) return;
          trigger.setAttribute('aria-expanded', String(item.classList.contains('is-open')));

          trigger.addEventListener('click', () => {
            const wasOpen = item.classList.contains('is-open');
            if (single) items.forEach((i) => {
              i.classList.remove('is-open');
              i.querySelector('[data-accordion-trigger]')?.setAttribute('aria-expanded', 'false');
            });
            item.classList.toggle('is-open', !wasOpen);
            trigger.setAttribute('aria-expanded', String(!wasOpen));
            Bus.emit('accordion:toggled', { item, open: !wasOpen });
          });
        });
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     15 · LIGHTBOX
     ══════════════════════════════════════════════════════════════ */

  const Lightbox = (() => {
    let backdrop = null;

    function open(src, alt = '') {
      close();
      backdrop = document.createElement('div');
      backdrop.className = 'lightbox';
      backdrop.innerHTML = `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" />`;
      backdrop.addEventListener('click', close);
      document.body.appendChild(backdrop);
      raf(() => backdrop.classList.add('is-visible'));
    }

    function close() {
      if (!backdrop) return;
      backdrop.classList.remove('is-visible');
      setTimeout(() => { backdrop?.remove(); backdrop = null; }, 200);
    }

    function init(root = document) {
      Dom.delegate(root, '[data-zoom]', 'click', (e, img) => {
        if (img.dataset.noZoom !== undefined) return;
        e.preventDefault();
        open(img.src, img.alt);
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    }

    return { open, close, init };
  })();

  /* ══════════════════════════════════════════════════════════════
     16 · CAROUSEL
     ══════════════════════════════════════════════════════════════ */

  const Carousel = (() => {
    function init(root = document) {
      $$('[data-carousel]', root).forEach((el) => {
        const track = el.querySelector('[data-carousel-track]');
        if (!track) return;
        const slides = $$('[data-carousel-slide]', track);
        const prev = el.querySelector('[data-carousel-prev]');
        const next = el.querySelector('[data-carousel-next]');
        const dots = el.querySelector('[data-carousel-dots]');
        let index = 0;
        const gap = parseInt(el.dataset.carouselGap || '16', 10);

        function go(n) {
          index = (n + slides.length) % slides.length;
          const w = slides[0].offsetWidth + gap;
          track.style.transform = `translate3d(${-index * w}px, 0, 0)`;
          if (dots) $$('[data-dot]', dots).forEach((d, i) => d.classList.toggle('is-active', i === index));
        }

        if (prev) prev.addEventListener('click', () => go(index - 1));
        if (next) next.addEventListener('click', () => go(index + 1));

        if (dots) {
          for (let i = 0; i < slides.length; i++) {
            const d = document.createElement('button');
            d.type = 'button';
            d.className = 'carousel__dot';
            d.dataset.dot = String(i);
            d.setAttribute('aria-label', `Ir al slide ${i + 1}`);
            d.addEventListener('click', () => go(i));
            dots.appendChild(d);
          }
        }

        let startX = 0;
        track.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; }, { passive: true });
        track.addEventListener('touchend', (e) => {
          const delta = e.changedTouches[0].clientX - startX;
          if (Math.abs(delta) > 40) go(index + (delta < 0 ? 1 : -1));
        }, { passive: true });

        go(0);
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     17 · DRAWER
     ══════════════════════════════════════════════════════════════ */

  const Drawer = (() => {
    const openStack = [];

    function open({ title = '', body = '', side = 'right', width = '360px' } = {}) {
      const wrap = document.createElement('div');
      wrap.className = `nm-drawer nm-drawer--${side}`;
      wrap.style.setProperty('--drawer-width', width);
      wrap.innerHTML = `
        <div class="nm-drawer__overlay"></div>
        <aside class="nm-drawer__panel" role="dialog" aria-modal="true">
          <header class="nm-drawer__head">
            <h2 class="nm-drawer__title">${escapeHtml(title)}</h2>
            <button class="nm-drawer__close" type="button" aria-label="Cerrar">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </header>
          <div class="nm-drawer__body"></div>
        </aside>`;
      const bodyEl = wrap.querySelector('.nm-drawer__body');
      if (isStr(body)) bodyEl.innerHTML = body;
      else if (isNode(body)) bodyEl.appendChild(body);

      document.body.appendChild(wrap);
      raf(() => wrap.classList.add('is-open'));
      document.body.classList.add('has-drawer');

      wrap.querySelector('.nm-drawer__close').addEventListener('click', () => close(wrap));
      wrap.querySelector('.nm-drawer__overlay').addEventListener('click', () => close(wrap));
      openStack.push(wrap);
      return wrap;
    }

    function close(wrap) {
      if (!wrap || !wrap.parentNode) return;
      wrap.classList.remove('is-open');
      setTimeout(() => {
        wrap.remove();
        const i = openStack.indexOf(wrap);
        if (i >= 0) openStack.splice(i, 1);
        if (!openStack.length) document.body.classList.remove('has-drawer');
      }, 260);
    }

    function closeAll() { [...openStack].forEach(close); }

    return { open, close, closeAll };
  })();

  /* ══════════════════════════════════════════════════════════════
     18 · EASE + TWEEN
     ══════════════════════════════════════════════════════════════ */

  const Ease = {
    linear:     (t) => t,
    quadOut:    (t) => t * (2 - t),
    cubicOut:   (t) => --t * t * t + 1,
    cubicInOut: (t) => t < .5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
    expoOut:    (t) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
    backOut:    (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  };

  const Tween = (() => {
    const active = new Map();

    function to(obj, props, opts = {}) {
      const { duration = 400, delay = 0, easing = Ease.cubicOut, onUpdate, onComplete } = opts;
      const from = {};
      for (const k of Object.keys(props)) from[k] = obj[k];
      const id = uid('tween');
      const start = nowMs() + delay;
      let rafId = null;

      return new Promise((resolve) => {
        function tick() {
          const now = nowMs();
          const elapsed = now - start;
          if (elapsed < 0) { rafId = raf(tick); return; }
          const t = clamp(elapsed / duration, 0, 1);
          const e = easing(t);
          for (const k of Object.keys(props)) obj[k] = lerp(from[k], props[k], e);
          if (isFn(onUpdate)) onUpdate(obj, t);
          if (t < 1) rafId = raf(tick);
          else {
            if (isFn(onComplete)) onComplete(obj);
            active.delete(id);
            resolve(obj);
          }
        }
        active.set(id, { cancel: () => cancelAnimationFrame(rafId) });
        rafId = raf(tick);
      });
    }

    function cancelAll() { for (const a of active.values()) a.cancel(); active.clear(); }

    return { to, cancelAll, Ease };
  })();

  /* ══════════════════════════════════════════════════════════════
     19 · CONFETTI
     ══════════════════════════════════════════════════════════════ */

  const Confetti = (() => {
    function burst(count = 80, opts = {}) {
      if (REDUCED) return;
      const canvas = document.createElement('canvas');
      canvas.className = 'confetti-canvas';
      canvas.width = innerWidth;
      canvas.height = innerHeight;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');

      const colors = opts.colors || Color.palette;
      const parts = Array.from({ length: count }, () => ({
        x: opts.x ?? Math.random() * canvas.width,
        y: opts.y ?? -20 - Math.random() * 200,
        vx: (Math.random() - 0.5) * (opts.spread ?? 4),
        vy: (opts.speed ?? 2) + Math.random() * 4,
        r: 3 + Math.random() * 5,
        color: colors[Math.floor(Math.random() * colors.length)],
        angle: Math.random() * Math.PI,
        va: (Math.random() - 0.5) * 0.2,
      }));

      let frames = 0;
      const maxFrames = opts.frames ?? 180;

      const tick = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const p of parts) {
          p.x += p.vx; p.y += p.vy; p.vy += 0.08; p.angle += p.va;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.angle);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.r, -p.r, p.r * 2, p.r * 0.8);
          ctx.restore();
        }
        frames++;
        if (frames < maxFrames) raf(tick);
        else canvas.remove();
      };
      raf(tick);
    }

    function from(el, count = 60) {
      const r = el.getBoundingClientRect();
      burst(count, { x: r.left + r.width / 2, y: r.top });
    }

    return { burst, from };
  })();

  /* ══════════════════════════════════════════════════════════════
     20 · VALIDACIÓN + FORMS
     ══════════════════════════════════════════════════════════════ */

  const Validators = {
    required: (v) => v != null && String(v).trim().length > 0,
    email:    (v) => Str.isEmail(v),
    url:      (v) => Str.isUrl(v),
    phone:    (v) => Str.isPhone(v),
    minLength: (n) => (v) => String(v).length >= n,
    maxLength: (n) => (v) => String(v).length <= n,
    pattern:  (re) => (v) => re.test(v),
    number:   (v) => !Number.isNaN(parseFloat(v)),
  };

  const FormEngine = (() => {
    function validate(el, rules) {
      const value = el.type === 'checkbox' ? el.checked : el.value;
      const errors = [];
      for (const rule of rules) {
        const [name, ...args] = rule.split(':');
        const fn = Validators[name];
        if (!fn) continue;
        if (!fn(...args)(value)) errors.push(name);
      }
      setState(el, errors.length === 0, errors);
      return errors;
    }

    function setState(el, ok, errors = []) {
      const wrapper = el.closest('.form-row, .field, label') || el.parentElement;
      if (!wrapper) return;
      wrapper.classList.toggle('has-error', !ok);
      wrapper.classList.toggle('is-valid', ok);
      wrapper.dataset.errors = errors.join(',');
      const msg = wrapper.querySelector('.field-error');
      if (msg) msg.textContent = !ok && errors.length ? messageFor(errors[0]) : '';
    }

    function messageFor(rule) {
      const messages = {
        required: 'Este campo es obligatorio.',
        email: 'Ingresa un correo válido.',
        url: 'Ingresa una URL válida.',
        phone: 'Ingresa un teléfono válido.',
        number: 'Ingresa un número.',
      };
      const [name, arg] = rule.split(':');
      if (name === 'minLength') return `Mínimo ${arg} caracteres.`;
      if (name === 'maxLength') return `Máximo ${arg} caracteres.`;
      return messages[name] || 'Valor inválido.';
    }

    function init(root = document) {
      $$('form[data-validate]', root).forEach((form) => {
        const fields = $$('[data-rules]', form);
        fields.forEach((el) => {
          const rules = (el.dataset.rules || '').split('|').filter(Boolean);
          el.addEventListener('blur', () => validate(el, rules));
          el.addEventListener('input', debounce(() => validate(el, rules), 300));
        });
        form.addEventListener('submit', (e) => {
          let allOk = true;
          fields.forEach((el) => {
            const rules = (el.dataset.rules || '').split('|').filter(Boolean);
            if (validate(el, rules).length) allOk = false;
          });
          if (!allOk) {
            e.preventDefault();
            form.querySelector('.has-error input, .has-error textarea')?.focus();
            Bus.emit('form:invalid', { form });
            return;
          }
          Bus.emit('form:valid', { form });
        });
      });
    }

    return { validate, setState, messageFor, init };
  })();

  /* ══════════════════════════════════════════════════════════════
     21 · SCROLL
     ══════════════════════════════════════════════════════════════ */

  const Scroll = {
    to(target, opts = {}) {
      const el = isStr(target) ? $(target) : target;
      if (!el) return;
      const offset = opts.offset ?? 80;
      const top = el.getBoundingClientRect().top + scrollY - offset;
      window.scrollTo({ top, behavior: REDUCED ? 'auto' : 'smooth' });
    },
    toTop() {
      window.scrollTo({ top: 0, behavior: REDUCED ? 'auto' : 'smooth' });
    },
    lock() {
      const sw = innerWidth - document.documentElement.clientWidth;
      document.body.style.paddingRight = sw + 'px';
      document.body.classList.add('scroll-locked');
    },
    unlock() {
      document.body.style.paddingRight = '';
      document.body.classList.remove('scroll-locked');
    },
    progress() {
      const h = document.documentElement.scrollHeight - innerHeight;
      return h > 0 ? clamp(scrollY / h, 0, 1) : 0;
    },
  };

  /* ══════════════════════════════════════════════════════════════
     22 · OBSERVER + A11Y
     ══════════════════════════════════════════════════════════════ */

  const Observer = {
    when(selector, cb, opts = {}) {
      const els = typeof selector === 'string' ? $$(selector) : [].concat(selector);
      if (!els.length) return;
      if (!('IntersectionObserver' in window)) { els.forEach(cb); return; }
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          cb(e.target);
          if (opts.once !== false) io.unobserve(e.target);
        });
      }, {
        threshold: opts.threshold ?? CFG.revealThreshold,
        rootMargin: opts.rootMargin ?? '0px 0px -60px 0px',
      });
      els.forEach((el) => io.observe(el));
      return io;
    },
  };

  const A11y = {
    focusable(container) {
      return $$('a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])', container)
        .filter((el) => el.offsetParent !== null);
    },
    trapFocus(container) {
      const focusables = A11y.focusable(container);
      if (!focusables.length) return noop;
      const first = focusables[0];
      const last  = focusables[focusables.length - 1];
      const handler = (e) => {
        if (e.key !== 'Tab') return;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      };
      container.addEventListener('keydown', handler);
      return () => container.removeEventListener('keydown', handler);
    },
    announce(message, priority = 'polite') {
      const region = document.getElementById('a11y-live') || (() => {
        const r = document.createElement('div');
        r.id = 'a11y-live';
        r.className = 'sr-only';
        r.setAttribute('aria-live', priority);
        document.body.appendChild(r);
        return r;
      })();
      region.setAttribute('aria-live', priority);
      region.textContent = '';
      setTimeout(() => { region.textContent = message; }, 40);
    },
  };

  /* ══════════════════════════════════════════════════════════════
     23 · CLIPBOARD + FILES + SHARE
     ══════════════════════════════════════════════════════════════ */

  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && isSecureContext) {
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

  function downloadBlob(filename, content, mime = 'text/plain') {
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function share(opts = {}) {
    if (navigator.share) {
      try {
        await navigator.share({
          title: opts.title || document.title,
          text: opts.text || '',
          url: opts.url || location.href,
        });
        return true;
      } catch { return false; }
    }
    return copyToClipboard(opts.url || location.href);
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
  }

  /* ══════════════════════════════════════════════════════════════
     24 · NET + HELPERS
     ══════════════════════════════════════════════════════════════ */

  const Net = {
    async fetch(url, opts = {}) {
      const { retries = 2, retryDelay = 500, timeout = 10000, ...rest } = opts;
      let lastErr;
      for (let i = 0; i <= retries; i++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        try {
          const res = await fetch(url, { ...rest, signal: ctrl.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res;
        } catch (e) {
          lastErr = e;
          if (i < retries) await sleep(retryDelay * Math.pow(2, i));
        } finally { clearTimeout(t); }
      }
      throw lastErr;
    },
    async json(url, opts) {
      const res = await Net.fetch(url, opts);
      return res.json();
    },
    async post(url, body, opts = {}) {
      return Net.json(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...opts,
      });
    },
    prefetch(url) {
      if (!url) return;
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = url;
      document.head.appendChild(link);
    },
  };

  const Helpers = {
    range: (n, start = 0, step = 1) => Array.from({ length: n }, (_, i) => start + i * step),
    chunk(arr, size) {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    },
    unique: (arr) => [...new Set(arr)],
    groupBy(arr, keyFn) {
      return arr.reduce((acc, item) => {
        const k = keyFn(item);
        (acc[k] = acc[k] || []).push(item);
        return acc;
      }, {});
    },
    pick(obj, keys) { return keys.reduce((a, k) => (k in obj && (a[k] = obj[k]), a), {}); },
    deepClone(obj) {
      return typeof structuredClone === 'function'
        ? structuredClone(obj)
        : JSON.parse(JSON.stringify(obj));
    },
  };

  /* ══════════════════════════════════════════════════════════════
     25 · TEMA (4 modos Nocturnos)
     ══════════════════════════════════════════════════════════════ */

  const Theme = (() => {
    function apply(id, silent = false) {
      if (!THEMES[id]) id = 'oscuro';
      document.documentElement.dataset.theme = id;
      document.documentElement.dataset.themeId = id;
      document.documentElement.dataset.themeMode = id;

      const meta = $('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', THEMES[id].meta);

      updateToggles(id);
      if (!silent) log('tema:', id);
      Bus.emit('theme:changed', { id });
    }

    function updateToggles(id) {
      $$('[data-theme-picker] [data-theme-card]').forEach((card) => {
        card.classList.toggle('is-active', card.dataset.themeCard === id);
      });
      $$('[data-theme-toggle]').forEach((btn) => {
        btn.dataset.themeId = id;
      });
    }

    function set(id) {
      if (!THEMES[id]) id = 'oscuro';
      Store.write(CFG.themeKey, id);
      apply(id);
    }

    function cycle() {
      const cur = Store.read(CFG.themeKey, 'oscuro');
      const next = THEME_IDS[(THEME_IDS.indexOf(cur) + 1) % THEME_IDS.length];
      set(next);
      Toasts.info(`Tema: ${THEMES[next].label}`);
    }

    function init() {
      const stored = Store.read(CFG.themeKey, null);
      // Si es del sistema viejo (light/dark/auto), migrar a oscuro
      const initial = THEMES[stored] ? stored : 'oscuro';
      apply(initial, true);

      $$('[data-theme-toggle]').forEach((btn) => {
        btn.addEventListener('click', cycle);
      });

      $$('[data-theme-card]').forEach((card) => {
        card.addEventListener('click', () => {
          set(card.dataset.themeCard);
          Toasts.info(`Tema: ${THEMES[card.dataset.themeCard].label}`);
        });
      });

      // Sigue el sistema si no hay preferencia manual
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if (!Store.has(CFG.themeKey)) apply('oscuro', true);
      });
    }

    return { init, set, cycle, apply, THEMES, IDs: THEME_IDS };
  })();

  /* ══════════════════════════════════════════════════════════════
     26 · MENÚ MÓVIL
     ══════════════════════════════════════════════════════════════ */

  const MobileMenu = (() => {
    function init() {
      const toggle = $('[data-menu-toggle]');
      const menu   = $('[data-menu]');
      if (!toggle || !menu) return;

      let open = false;
      const setOpen = (v) => {
        open = v;
        menu.classList.toggle('is-open', v);
        toggle.setAttribute('aria-expanded', String(v));
        document.body.classList.toggle('has-menu', v);
        if (v) { Scroll.lock(); A11y.announce('Menú abierto'); }
        else Scroll.unlock();
      };

      toggle.addEventListener('click', () => setOpen(!open));
      Dom.delegate(menu, 'a', 'click', () => setOpen(false));
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && open) setOpen(false);
      });
      window.addEventListener('resize', debounce(() => {
        if (!IS_MOBILE && open) setOpen(false);
      }, 200));
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     27 · SMOOTH SCROLL
     ══════════════════════════════════════════════════════════════ */

  const SmoothScroll = (() => {
    function init() {
      Dom.delegate(document, 'a[href^="#"]', 'click', (e, a) => {
        const id = a.getAttribute('href');
        if (!id || id === '#') return;
        const target = document.querySelector(id);
        if (!target) return;
        e.preventDefault();
        Scroll.to(target);
        history.replaceState(null, '', id);
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     28 · SCROLL REVEAL
     ══════════════════════════════════════════════════════════════ */

  const ScrollReveal = (() => {
    function init() {
      const els = $$('[data-reveal], [data-reveal-stagger]');
      if (!els.length) return;
      if (REDUCED) { els.forEach((el) => el.classList.add('is-visible')); return; }
      Observer.when(els, (el) => el.classList.add('is-visible'), {
        threshold: CFG.revealThreshold,
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     29 · CONTADORES
     ══════════════════════════════════════════════════════════════ */

  const Counters = (() => {
    function fmt(n, d, pre, suf) { return pre + Num.fmt(n, d) + suf; }

    function animate(el) {
      const to = parseFloat(el.dataset.counter) || 0;
      const from = parseFloat(el.dataset.counterFrom || '0');
      const duration = parseInt(el.dataset.counterDuration || CFG.countersDuration, 10);
      const suffix = el.dataset.counterSuffix || '';
      const prefix = el.dataset.counterPrefix || '';
      const decimals = parseInt(el.dataset.counterDecimals || '0', 10);

      if (REDUCED) { el.textContent = fmt(to, decimals, prefix, suffix); return; }

      const t0 = performance.now();
      const tick = (now) => {
        const p = clamp((now - t0) / duration, 0, 1);
        const eased = Ease.cubicOut(p);
        el.textContent = fmt(from + (to - from) * eased, decimals, prefix, suffix);
        if (p < 1) raf(tick);
        else el.textContent = fmt(to, decimals, prefix, suffix);
      };
      raf(tick);
    }

    function init() {
      const els = $$('[data-counter]');
      if (!els.length) return;
      Observer.when(els, animate, { threshold: 0.35 });
    }
    return { init, animate };
  })();

  /* ══════════════════════════════════════════════════════════════
     30 · COOKIE BANNER
     ══════════════════════════════════════════════════════════════ */

  const CookieBanner = (() => {
    function init() {
      if (Store.has(CFG.cookieKey)) return;
      const banner = document.createElement('div');
      banner.className = 'cookie-banner';
      banner.innerHTML = `
        <div class="cookie-banner__inner">
          <p class="cookie-banner__text">
            Usamos almacenamiento local para recordar tus preferencias.
            No rastreamos ni compartimos datos.
          </p>
          <div class="cookie-banner__actions">
            <button type="button" class="btn btn--ghost btn--sm" data-cookie="reject">Rechazar</button>
            <button type="button" class="btn btn--primary btn--sm" data-cookie="accept">Aceptar</button>
          </div>
        </div>`;
      document.body.appendChild(banner);
      raf(() => banner.classList.add('is-visible'));
      banner.addEventListener('click', (e) => {
        const b = e.target.closest('[data-cookie]');
        if (!b) return;
        Store.write(CFG.cookieKey, { value: b.dataset.cookie, ts: nowMs() });
        banner.classList.remove('is-visible');
        setTimeout(() => banner.remove(), 400);
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     31 · BACK TO TOP
     ══════════════════════════════════════════════════════════════ */

  const BackToTop = (() => {
    function init() {
      if ($('.back-to-top')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'back-to-top';
      btn.title = 'Volver arriba';
      btn.setAttribute('aria-label', 'Volver arriba');
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
      btn.addEventListener('click', Scroll.toTop);
      document.body.appendChild(btn);
      const onScroll = throttle(() => {
        btn.classList.toggle('is-visible', scrollY > CFG.scrollTopThreshold);
      }, 120);
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     32 · READING PROGRESS
     ══════════════════════════════════════════════════════════════ */

  const ReadingProgress = (() => {
    function init() {
      // Solo en páginas legales
      if (!document.body.matches('[data-page="legal"], .legal-content') && !$('.legal-content')) return;
      const bar = document.createElement('div');
      bar.className = 'reading-progress';
      bar.innerHTML = '<div class="reading-progress__fill"></div>';
      document.body.appendChild(bar);
      const fill = bar.firstElementChild;
      const onScroll = throttle(() => {
        const p = Scroll.progress();
        fill.style.width = (p * 100) + '%';
        bar.classList.toggle('is-visible', p > 0.02 && p < 0.98);
      }, 80);
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     33 · NAVBAR SHRINK
     ══════════════════════════════════════════════════════════════ */

  const NavbarShrink = (() => {
    function init() {
      const header = $('.site-header, [data-header]');
      if (!header) return;
      let lastY = 0;
      const onScroll = throttle(() => {
        const y = scrollY;
        header.classList.toggle('is-shrunk', y > CFG.navbarShrinkAt);
        if (y < 120) header.classList.remove('is-hidden');
        else {
          const dir = y > lastY ? 'down' : 'up';
          header.classList.toggle('is-hidden', dir === 'down' && y > 300);
        }
        lastY = y;
      }, 100);
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     34 · LAZY IMAGES
     ══════════════════════════════════════════════════════════════ */

  const LazyImages = (() => {
    function init() {
      const imgs = $$('img[data-src]');
      if (!imgs.length) return;
      if (!('IntersectionObserver' in window)) {
        imgs.forEach((img) => { if (img.dataset.src) img.src = img.dataset.src; });
        return;
      }
      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const img = e.target;
          if (img.dataset.src) { img.src = img.dataset.src; delete img.dataset.src; }
          img.classList.add('is-loaded');
          io.unobserve(img);
        });
      }, { rootMargin: '200px' });
      imgs.forEach((img) => io.observe(img));
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     35 · COPY CODE
     ══════════════════════════════════════════════════════════════ */

  const CopyCode = (() => {
    function init() {
      $$('pre > code').forEach((code) => {
        const pre = code.parentElement;
        if (pre.querySelector('.copy-code-btn')) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'copy-code-btn';
        btn.textContent = 'Copiar';
        btn.addEventListener('click', async () => {
          const ok = await copyToClipboard(code.textContent);
          btn.textContent = ok ? '✓ Copiado' : 'Falló';
          setTimeout(() => { btn.textContent = 'Copiar'; }, 1600);
        });
        pre.style.position = 'relative';
        pre.appendChild(btn);
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     36 · ANCHOR LINKS
     ══════════════════════════════════════════════════════════════ */

  const AnchorLinks = (() => {
    function init() {
      $$('h2[id], h3[id], h4[id]').forEach((h) => {
        if (h.querySelector('.anchor-link')) return;
        const a = document.createElement('a');
        a.href = '#' + h.id;
        a.className = 'anchor-link';
        a.setAttribute('aria-label', 'Copiar enlace a esta sección');
        a.textContent = '#';
        a.addEventListener('click', async (e) => {
          e.preventDefault();
          const url = location.origin + location.pathname + '#' + h.id;
          const ok = await copyToClipboard(url);
          Toasts[ok ? 'ok' : 'err'](ok ? 'Enlace copiado.' : 'No se pudo copiar.');
        });
        h.appendChild(a);
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     37 · EXTERNAL LINKS
     ══════════════════════════════════════════════════════════════ */

  const ExternalLinks = (() => {
    function init() {
      const host = location.hostname;
      $$('a[href^="http"]').forEach((a) => {
        try {
          const url = new URL(a.href);
          if (url.hostname !== host) {
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.classList.add('is-external');
          }
        } catch {}
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     38 · FORMULARIO DE CONTACTO (dentro de precio.html)
     ══════════════════════════════════════════════════════════════ */

  const ContactForm = (() => {
    function init() {
      const form = $('[data-contact-form]');
      if (!form) return;
      const mensaje = form.querySelector('#mensaje');
      const counter = form.querySelector('[data-char-counter]');
      const status  = form.querySelector('[data-form-status]');
      const MAX = mensaje ? (parseInt(mensaje.getAttribute('maxlength'), 10) || 1200) : 1200;

      if (counter && mensaje) {
        const update = () => {
          const len = mensaje.value.length;
          counter.textContent = `${len} / ${MAX}`;
          counter.style.color = len > MAX * 0.9 ? 'var(--danger)' : '';
        };
        mensaje.addEventListener('input', update);
        update();
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!form.checkValidity()) { form.reportValidity(); return; }
        const btn = form.querySelector('button[type="submit"]');
        const original = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }

        await sleep(800);

        if (status) {
          status.hidden = false;
          status.dataset.state = 'ok';
          status.textContent = 'Mensaje enviado. Te responderemos pronto.';
        }
        Toasts.ok('Gracias por escribirnos.');
        form.reset();
        if (counter && mensaje) { counter.textContent = `0 / ${MAX}`; counter.style.color = ''; }
        if (btn) { btn.disabled = false; btn.textContent = original; }
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     39 · KEYBOARD SHORTCUTS — rutas v6
     ══════════════════════════════════════════════════════════════ */

  const Keyboard = (() => {
    function init() {
      document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const tag = (e.target.tagName || '').toLowerCase();
        const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

        if (mod && e.shiftKey && e.key.toLowerCase() === 'k') {
          e.preventDefault(); CommandPalette.open(); return;
        }
        if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
          e.preventDefault();
          Toasts.info('Debug en consola (window.__numination).');
          window.__numination = window.__numination || {};
          return;
        }
        if (e.key === '?' && !typing) { e.preventDefault(); Help.show(); return; }
        if (e.key === 'Escape') {
          Modal.closeAll();
          Drawer.closeAll();
          $('[data-menu].is-open')?.classList.remove('is-open');
          return;
        }
        if (!typing && !mod && e.key === 'g') {
          document.addEventListener('keydown', function handler(e2) {
            document.removeEventListener('keydown', handler);
            if (e2.key === 'h') location.href = ROUTES.home;
            else if (e2.key === 'l') location.href = ROUTES.login;
            else if (e2.key === 'n') location.href = ROUTES.chat;
            else if (e2.key === 'p') location.href = ROUTES.pricing;
            else if (e2.key === 't') location.href = ROUTES.legal;
          }, { once: true });
        }
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     40 · COMMAND PALETTE — rutas v6
     ══════════════════════════════════════════════════════════════ */

  const CommandPalette = (() => {
    const commands = [
      { label: 'Ir a inicio',    shortcut: 'g h', action: () => location.href = ROUTES.home },
      { label: 'Ir al chat',     shortcut: 'g n', action: () => location.href = ROUTES.chat },
      { label: 'Ir a precios',   shortcut: 'g p', action: () => location.href = ROUTES.pricing },
      { label: 'Ir a términos',  shortcut: 'g t', action: () => location.href = ROUTES.legal },
      { label: 'Iniciar sesión', shortcut: 'g l', action: () => location.href = ROUTES.login },
      { label: 'Cambiar tema',   action: () => Theme.cycle() },
      { label: 'Volver arriba',  action: () => Scroll.toTop() },
      { label: 'Copiar URL',     action: async () => {
        const ok = await copyToClipboard(location.href);
        Toasts[ok ? 'ok' : 'err'](ok ? 'Copiado.' : 'Falló.');
      }},
      { label: 'Ver atajos',     action: () => Help.show() },
      { label: 'Confeti 🎉',     action: () => Confetti.burst() },
      { label: 'Limpiar almacenamiento', action: async () => {
        const ok = await Modal.confirm('¿Borrar todos los datos guardados localmente?');
        if (ok) { Store.clear('numination-'); Toasts.ok('Almacenamiento limpio.'); }
      }},
    ];

    let backdrop = null;

    function open() {
      if (backdrop) return;
      backdrop = document.createElement('div');
      backdrop.className = 'cmd-backdrop';
      backdrop.innerHTML = `
        <div class="cmd" role="dialog" aria-modal="true">
          <input type="search" class="cmd__input" placeholder="Escribe un comando…" autofocus />
          <ul class="cmd__list"></ul>
        </div>`;
      document.body.appendChild(backdrop);

      const input = backdrop.querySelector('.cmd__input');
      const list  = backdrop.querySelector('.cmd__list');
      let filtered = commands.slice();
      let index = 0;

      const render = () => {
        list.innerHTML = filtered.length
          ? filtered.map((c, i) => `<li class="cmd__item${i === index ? ' is-active' : ''}" data-idx="${i}">
              <span>${escapeHtml(c.label)}</span>
              ${c.shortcut ? `<kbd>${c.shortcut}</kbd>` : ''}
            </li>`).join('')
          : '<li class="cmd__empty">Sin resultados</li>';
        list.querySelectorAll('.cmd__item').forEach((li) => {
          li.addEventListener('click', () => run(filtered[+li.dataset.idx]));
        });
      };

      const run = (c) => { close(); try { c.action(); } catch (e) { warn(e); } };

      input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        filtered = q ? commands.filter((c) => c.label.toLowerCase().includes(q)) : commands.slice();
        index = 0;
        render();
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); index = (index + 1) % Math.max(filtered.length, 1); render(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); index = (index - 1 + filtered.length) % Math.max(filtered.length, 1); render(); }
        else if (e.key === 'Enter') { e.preventDefault(); if (filtered[index]) run(filtered[index]); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      });

      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
      render();
      setTimeout(() => input.focus(), 60);
    }

    function close() {
      if (!backdrop) return;
      backdrop.remove();
      backdrop = null;
    }

    return { open, close, add: (c) => commands.push(c) };
  })();

  /* ══════════════════════════════════════════════════════════════
     41 · HELP MODAL
     ══════════════════════════════════════════════════════════════ */

  const Help = (() => {
    const rows = [
      ['Ctrl + Shift + K', 'Paleta de comandos'],
      ['Ctrl + Shift + D', 'Modo debug'],
      ['g + h', 'Ir a inicio'],
      ['g + n', 'Ir al chat'],
      ['g + p', 'Ir a precios'],
      ['g + t', 'Ir a términos'],
      ['g + l', 'Iniciar sesión'],
      ['?', 'Esta ventana'],
      ['Escape', 'Cerrar modales'],
    ];

    function show() {
      Modal.open({
        title: 'Atajos de teclado',
        body: `<ul class="nm-shortcuts">${rows.map(([k, v]) =>
          `<li><kbd>${k}</kbd><span>${v}</span></li>`).join('')}</ul>`,
        actions: [{ label: 'Cerrar' }],
      });
    }
    return { show };
  })();

  /* ══════════════════════════════════════════════════════════════
     42 · KONAMI
     ══════════════════════════════════════════════════════════════ */

  const Konami = (() => {
    const SEQ = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
    function init() {
      let i = 0;
      document.addEventListener('keydown', (e) => {
        if (e.key === SEQ[i] || e.key.toLowerCase() === SEQ[i]) {
          i++;
          if (i === SEQ.length) {
            i = 0;
            Confetti.burst(180);
            Toasts.ok('¡Código Konami activado! 🎉');
          }
        } else i = 0;
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     43 · SHARE BUTTONS
     ══════════════════════════════════════════════════════════════ */

  const Share = (() => {
    function init() {
      $$('[data-share]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const net = btn.dataset.share;
          const url = encodeURIComponent(location.href);
          const title = encodeURIComponent(document.title);
          let target = '';

          if (net === 'native' && navigator.share) {
            try { await navigator.share({ url: location.href, title: document.title }); return; } catch {}
          }
          if (net === 'twitter' || net === 'x') target = `https://twitter.com/intent/tweet?url=${url}&text=${title}`;
          else if (net === 'facebook') target = `https://www.facebook.com/sharer/sharer.php?u=${url}`;
          else if (net === 'linkedin') target = `https://www.linkedin.com/sharing/share-offsite/?url=${url}`;
          else if (net === 'whatsapp') target = `https://wa.me/?text=${title}%20${url}`;
          else if (net === 'telegram') target = `https://t.me/share/url?url=${url}&text=${title}`;
          else if (net === 'email') target = `mailto:?subject=${title}&body=${url}`;
          else if (net === 'copy') {
            const ok = await copyToClipboard(location.href);
            Toasts[ok ? 'ok' : 'err'](ok ? 'Enlace copiado.' : 'Falló.');
            return;
          }
          if (target) window.open(target, '_blank', 'noopener,noreferrer');
        });
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     44 · FEEDBACK
     ══════════════════════════════════════════════════════════════ */

  const Feedback = (() => {
    function init() {
      $$('[data-feedback]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const kind = btn.dataset.feedback;
          const msg = await Modal.prompt(kind === 'bug' ? 'Describe el problema:' : '¿Qué te pareció?');
          if (!msg) return;
          const list = Store.read('numination-feedback', []) || [];
          list.unshift({ kind, text: msg, ts: nowMs(), url: location.pathname });
          Store.write('numination-feedback', list.slice(0, 50));
          Toasts.ok('Gracias por tu opinión.');
        });
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     45 · PRINT HANDLER
     ══════════════════════════════════════════════════════════════ */

  const PrintHandler = (() => {
    function init() {
      $$('[data-print]').forEach((btn) => btn.addEventListener('click', () => window.print()));
      window.addEventListener('beforeprint', () => document.body.classList.add('is-printing'));
      window.addEventListener('afterprint',  () => document.body.classList.remove('is-printing'));
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     46 · WEB VITALS
     ══════════════════════════════════════════════════════════════ */

  const WebVitals = (() => {
    function init() {
      try {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          log('LCP:', Math.round(last.startTime), 'ms');
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {}
      try {
        let cls = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) if (!e.hadRecentInput) cls += e.value;
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     47 · ANALYTICS LOCAL
     ══════════════════════════════════════════════════════════════ */

  const Analytics = (() => {
    const MAX = 200;
    function track(name, payload = {}) {
      const evt = { name, payload, ts: nowMs(), url: location.pathname };
      const events = Store.read(CFG.analyticsKey, []) || [];
      events.unshift(evt);
      Store.write(CFG.analyticsKey, events.slice(0, MAX));
      Bus.emit('analytics:event', evt);
    }
    function init() {
      Dom.delegate(document, '[data-track]', 'click', (e, el) => {
        track(el.dataset.track, { href: el.getAttribute('href') });
      });
      track('pageview', { title: document.title });
    }
    return { init, track, list: () => Store.read(CFG.analyticsKey, []) || [], clear: () => Store.remove(CFG.analyticsKey) };
  })();

  /* ══════════════════════════════════════════════════════════════
     48 · NETWORK STATUS
     ══════════════════════════════════════════════════════════════ */

  const Network = (() => {
    function init() {
      const update = () => document.body.classList.toggle('is-offline', !navigator.onLine);
      window.addEventListener('online',  () => { update(); Toasts.ok('Conexión restaurada.'); });
      window.addEventListener('offline', () => { update(); Toasts.warn('Sin conexión.'); });
      update();
    }
    return { init, isOnline: () => navigator.onLine };
  })();

  /* ══════════════════════════════════════════════════════════════
     49 · BOOKMARKS
     ══════════════════════════════════════════════════════════════ */

  const Bookmarks = (() => {
    function list() { return Store.read(CFG.bookmarksKey, []) || []; }
    function toggle(url = location.pathname + location.search) {
      const items = list();
      const i = items.findIndex((b) => b.url === url);
      if (i >= 0) { items.splice(i, 1); Toasts.info('Quitado de favoritos.'); }
      else { items.unshift({ url, title: document.title, ts: nowMs() }); Toasts.ok('Añadido a favoritos.'); }
      Store.write(CFG.bookmarksKey, items.slice(0, 100));
      return i < 0;
    }
    function isBookmarked(url = location.pathname + location.search) {
      return list().some((b) => b.url === url);
    }
    function init() {
      $$('[data-bookmark]').forEach((btn) => {
        const url = location.pathname + location.search;
        btn.classList.toggle('is-active', isBookmarked(url));
        btn.addEventListener('click', () => {
          const added = toggle(url);
          btn.classList.toggle('is-active', added);
        });
      });
    }
    return { init, list, toggle, isBookmarked };
  })();

  /* ══════════════════════════════════════════════════════════════
     50 · URL PARAMS
     ══════════════════════════════════════════════════════════════ */

  const UrlParams = (() => {
    const p = new URLSearchParams(location.search);
    return {
      get: (k, fb = null) => p.get(k) ?? fb,
      has: (k) => p.has(k),
      all: () => Object.fromEntries(p.entries()),
    };
  })();

  /* ══════════════════════════════════════════════════════════════
     51 · PWA
     ══════════════════════════════════════════════════════════════ */

  const PWA = (() => {
    let deferred = null;
    function init() {
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferred = e;
        showInstallButton();
      });
      window.addEventListener('appinstalled', () => {
        Toasts.ok('¡Aplicación instalada!');
        deferred = null;
      });
    }
    function showInstallButton() {
      if ($('.pwa-install')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pwa-install';
      btn.textContent = '📲 Instalar app';
      btn.addEventListener('click', async () => {
        if (!deferred) return;
        deferred.prompt();
        const r = await deferred.userChoice;
        if (r.outcome === 'accepted') Toasts.ok('¡Instalada!');
        deferred = null;
        btn.remove();
      });
      document.body.appendChild(btn);
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     52 · NOTIFICATIONS
     ══════════════════════════════════════════════════════════════ */

  const Notify = (() => {
    async function request() {
      if (!('Notification' in window)) return false;
      if (Notification.permission === 'granted') return true;
      if (Notification.permission === 'denied') return false;
      return (await Notification.requestPermission()) === 'granted';
    }
    function send(title, body, opts = {}) {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      new Notification(title, { body, icon: '/favicon.ico', ...opts });
    }
    return { request, send };
  })();

  /* ══════════════════════════════════════════════════════════════
     53 · CONSOLE ART — paleta Nocturna
     ══════════════════════════════════════════════════════════════ */

  const ConsoleArt = (() => {
    function init() {
      const badge = 'background:linear-gradient(135deg,#7c5eff,#a78bfa);color:#fff;padding:8px 14px;border-radius:8px;font-size:14px;font-weight:bold';
      console.log('%c🇨🇴 Numination v' + VERSION, badge);
      console.log('%cHecho en Colombia · La IA que habla el idioma de nuestra educación.', 'color:#a78bfa;font-style:italic');
      console.log('%c¿Curioseando? Escríbenos: hola@numination.co', 'color:#8a8a92;font-size:11px');
      console.log('%c💡 Konami: ↑↑↓↓←→←→BA', 'color:#7c5eff;font-size:11px');
      console.log('%c🛠  window.__numination disponible en consola', 'color:#10b981;font-size:11px');
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     54 · SPLASH
     ══════════════════════════════════════════════════════════════ */

  const Splash = (() => {
    function init() {
      if (Session.read('numination-splash-seen')) return;
      Session.write('numination-splash-seen', true);
      if (REDUCED) return;
      const el = document.createElement('div');
      el.className = 'nm-splash';
      el.innerHTML = `
        <div class="nm-splash__inner">
          <div class="nm-splash__logo">N</div>
          <div class="nm-splash__bar"><span></span></div>
        </div>`;
      document.body.appendChild(el);
      raf(() => el.classList.add('is-visible'));
      setTimeout(() => {
        el.classList.remove('is-visible');
        setTimeout(() => el.remove(), 500);
      }, 900);
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     55 · MOTION PREF + LANGUAGE
     ══════════════════════════════════════════════════════════════ */

  const MotionPref = (() => {
    function init() {
      const mq = matchMedia('(prefers-reduced-motion: reduce)');
      const apply = () => document.body.classList.toggle('reduced-motion', mq.matches);
      apply();
      mq.addEventListener('change', apply);
    }
    return { init };
  })();

  const Language = (() => {
    function init() {
      const lang = navigator.language || 'es-CO';
      document.documentElement.lang = lang.startsWith('es') ? 'es-CO' : lang;
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     56 · ROUTER (hash)
     ══════════════════════════════════════════════════════════════ */

  const Router = (() => {
    const routes = new Map();
    const guards = [];
    let current = null;

    function add(pattern, handler) {
      const re = new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$');
      const keys = (pattern.match(/:\w+/g) || []).map((k) => k.slice(1));
      routes.set(pattern, { re, keys, handler });
    }

    function guard(fn) { guards.push(fn); }

    function parse() {
      const hash = location.hash.slice(1) || '/';
      for (const [pattern, { re, keys, handler }] of routes) {
        const m = hash.match(re);
        if (!m) continue;
        const params = {};
        keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        return { pattern, params, handler };
      }
      return null;
    }

    function navigate() {
      const route = parse();
      if (!route) return;
      for (const g of guards) {
        const result = g(route);
        if (result === false) return;
        if (isStr(result)) { location.hash = result; return; }
      }
      if (current?.pattern === route.pattern) return;
      current = route;
      try { route.handler(route.params); } catch (e) { err('router', e); }
      Bus.emit('route:changed', route);
    }

    function init() {
      window.addEventListener('hashchange', navigate);
      navigate();
    }

    return { add, guard, navigate, init, current: () => current };
  })();

  /* ══════════════════════════════════════════════════════════════
     57 · BOOT
     ══════════════════════════════════════════════════════════════ */

  function boot() {
    log(`Numination v${VERSION} · build ${BUILD}`);

    // Core siempre
    Theme.init();
    MobileMenu.init();
    SmoothScroll.init();
    ScrollReveal.init();
    Counters.init();
    CookieBanner.init();
    BackToTop.init();
    ReadingProgress.init();
    NavbarShrink.init();
    LazyImages.init();
    CopyCode.init();
    AnchorLinks.init();
    ExternalLinks.init();
    ContactForm.init();
    Keyboard.init();
    Dropdown.init();
    Tabs.init();
    Accordion.init();
    Lightbox.init();
    Carousel.init();
    Tooltip.bind();
    FormEngine.init();
    Konami.init();
    Share.init();
    Feedback.init();
    PrintHandler.init();
    WebVitals.init();
    Analytics.init();
    Network.init();
    Bookmarks.init();
    PWA.init();
    ConsoleArt.init();
    Splash.init();
    MotionPref.init();
    Language.init();

    Router.add('/', () => log('ruta: inicio'));
    Router.init();

    // Exponer API pública para debug
    window.__numination = {
      version: VERSION,
      build: BUILD,
      CFG, ROUTES,
      $, $$,
      Store, Session,
      Bus, Toasts, Modal, Tooltip, Dropdown, Tabs, Accordion,
      Lightbox, Carousel, Drawer,
      Tween, Ease, Confetti,
      Validators, FormEngine,
      Scroll, Observer, A11y,
      Net, Helpers,
      Str, Num, DateU, Color, Dom,
      Theme, Router,
      copyToClipboard, downloadBlob, share, readFile,
    };

    Bus.emit('app:booted', { version: VERSION });
    log('boot completo');
  }

  /* ══════════════════════════════════════════════════════════════
     58 · ARRANQUE
     ══════════════════════════════════════════════════════════════ */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();