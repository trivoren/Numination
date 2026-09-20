/* ================================================================
   NUMINATION · main.js v5.0 «El Enjambre»
   ----------------------------------------------------------------
   Runtime global del sitio. Un solo IIFE. Sin dependencias.
   PARTE 1/2 — andamiaje, utils, primitivas de UI y motores.
   ================================================================ */

(() => {
  'use strict';

  /* ══════════════════════════════════════════════════════════════
     1 · CONFIGURACIÓN
     ══════════════════════════════════════════════════════════════ */

  const VERSION = '5.0.0';
  const BUILD = '2026.09';
  const IS_DEV = new URLSearchParams(location.search).has('debug') ||
                 location.hostname === 'localhost';
  const IS_MOBILE = matchMedia('(max-width: 768px)').matches;
  const IS_TOUCH = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const DARK = matchMedia('(prefers-color-scheme: dark)').matches;

  const CFG = {
    version: VERSION,
    build: BUILD,
    themeKey: 'numination-theme',
    prefsKey: 'numination-prefs',
    formsKey: 'numination-forms',
    visitedKey: 'numination-visited',
    bookmarksKey: 'numination-bookmarks',
    readingKey: 'numination-reading',
    cookieKey: 'numination-cookie-consent',
    analyticsKey: 'numination-events',
    toastDuration: 2600,
    idleTimeout: 60000,
    scrollTopThreshold: 600,
    navbarShrinkAt: 40,
    revealThreshold: 0.12,
    countersDuration: 1600,
    sunriseHour: 6,
    sunsetHour: 18,
    konamiSequence: ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'],
    breakpoints: { sm: 640, md: 768, lg: 1024, xl: 1280 },
  };

  const EMOJI = {
    ok: '✓', warn: '⚠', err: '✕', info: 'ⓘ',
    sparkle: '✨', rocket: '🚀', fire: '🔥', star: '★',
  };

  /* ══════════════════════════════════════════════════════════════
     2 · UTILIDADES BASE
     ══════════════════════════════════════════════════════════════ */

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const $id = (id) => document.getElementById(id);

  const isFn = (v) => typeof v === 'function';
  const isStr = (v) => typeof v === 'string';
  const isNum = (v) => typeof v === 'number' && !Number.isNaN(v);
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const isArr = Array.isArray;
  const isNode = (v) => v instanceof Node;
  const isEl = (v) => v instanceof Element;

  const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
  const lerp = (a, b, t) => a + (b - a) * t;
  const invLerp = (a, b, v) => (v - a) / (b - a);
  const mapRange = (v, a1, a2, b1, b2) => lerp(b1, b2, invLerp(a1, a2, v));

  const uid = (p = 'x') =>
    `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const nowMs = () => Date.now();
  const nowIso = () => new Date().toISOString();

  const log = (...a) => { if (IS_DEV) console.log('%c[main]', 'color:#7c93d4;font-weight:bold', ...a); };
  const warn = (...a) => { if (IS_DEV) console.warn('[main]', ...a); };
  const err = (...a) => console.error('[main]', ...a);

  const escapeHtml = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const escapeAttr = escapeHtml;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = (fn) => requestAnimationFrame(fn);
  const caf = (id) => cancelAnimationFrame(id);

  const noop = () => {};

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

  const once = (fn) => {
    let done = false, value;
    return function (...args) {
      if (done) return value;
      done = true;
      value = fn.apply(this, args);
      return value;
    };
  };

  const memoize = (fn, resolver = (...a) => JSON.stringify(a)) => {
    const cache = new Map();
    return function (...args) {
      const key = resolver(...args);
      if (cache.has(key)) return cache.get(key);
      const v = fn.apply(this, args);
      cache.set(key, v);
      return v;
    };
  };

  const retry = async (fn, { attempts = 3, delay = 500, factor = 2 } = {}) => {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (e) { lastErr = e; if (i < attempts - 1) await sleep(delay * Math.pow(factor, i)); }
    }
    throw lastErr;
  };

  const batchDOM = (fn) => raf(() => raf(fn));

  /* ══════════════════════════════════════════════════════════════
     3 · UTILS · STRINGS
     ══════════════════════════════════════════════════════════════ */

  const Str = {
    capitalize: (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
    titleCase: (s) => s.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase()),
    camel: (s) => s.replace(/[-_\s]+(.)?/g, (_, c) => c ? c.toUpperCase() : ''),
    kebab: (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase(),
    snake: (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[\s-]+/g, '_').toLowerCase(),
    slug: (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''),
    truncate: (s, n = 100, ellip = '…') => s.length > n ? s.slice(0, n - ellip.length) + ellip : s,
    words: (s) => s.trim().split(/\s+/).filter(Boolean),
    countWords: (s) => Str.words(s).length,
    pad: (s, n, ch = '0') => String(s).padStart(n, ch),
    repeat: (s, n) => s.repeat(n),
    reverse: (s) => s.split('').reverse().join(''),
    isEmail: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
    isUrl: (s) => /^https?:\/\/.+/.test(s),
    isPhone: (s) => /^[\+]?[\d\s\-\(\)]{7,}$/.test(s),
  };

  /* ══════════════════════════════════════════════════════════════
     4 · UTILS · NÚMEROS Y FECHAS
     ══════════════════════════════════════════════════════════════ */

  const Num = {
    fmt: (n, d = 0) => Number(n).toLocaleString('es-CO', {
      minimumFractionDigits: d, maximumFractionDigits: d,
    }),
    fmtBytes: (b) => {
      if (b < 1024) return b + ' B';
      if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
      if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
      return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    },
    fmtPct: (n, d = 0) => (n * 100).toFixed(d) + '%',
    fmtCurrency: (n, cur = 'COP') => new Intl.NumberFormat('es-CO', {
      style: 'currency', currency: cur, maximumFractionDigits: 0,
    }).format(n),
    round: (n, d = 0) => Math.round(n * Math.pow(10, d)) / Math.pow(10, d),
    randomInt: (min, max) => Math.floor(Math.random() * (max - min + 1)) + min,
    randomFloat: (min, max) => Math.random() * (max - min) + min,
    between: (n, min, max) => n >= min && n <= max,
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
    fromNow: (ts) => {
      const diff = ts - nowMs();
      if (diff < 0) return DateU.relative(ts);
      const s = Math.floor(diff / 1000);
      if (s < 60) return `en ${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `en ${m} min`;
      return `en ${Math.floor(m / 60)} h`;
    },
    dayName: (ts) => new Date(ts).toLocaleDateString('es-CO', { weekday: 'long' }),
    addDays: (ts, n) => ts + n * 86400000,
    startOfDay: (ts) => new Date(ts).setHours(0, 0, 0, 0),
    isToday: (ts) => DateU.startOfDay(ts) === DateU.startOfDay(nowMs()),
  };

  /* ══════════════════════════════════════════════════════════════
     5 · UTILS · COLORES
     ══════════════════════════════════════════════════════════════ */

  const Color = {
    hexToRgb(hex) {
      const h = hex.replace('#', '');
      const n = h.length === 3
        ? h.split('').map((c) => c + c).join('')
        : h;
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
    lighten(hex, amount = 0.1) { return Color.mix(hex, '#ffffff', amount); },
    darken(hex, amount = 0.1) { return Color.mix(hex, '#000000', amount); },
    random(palette) {
      if (palette?.length) return palette[Math.floor(Math.random() * palette.length)];
      return '#' + Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0');
    },
    palette: ['#1a1a2e', '#7c93d4', '#FFCD00', '#10b981', '#f97316', '#c8102e'],
  };

  /* ══════════════════════════════════════════════════════════════
     6 · UTILS · DOM
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

    clear(el) {
      while (el.firstChild) el.removeChild(el.firstChild);
      return el;
    },

    replace(el, replacement) {
      if (!el.parentNode) return;
      el.parentNode.replaceChild(replacement, el);
    },

    remove(el) { el?.parentNode?.removeChild(el); },

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

    matches(el, sel) { return el?.matches?.(sel) || false; },
    closest(el, sel) { return el?.closest?.(sel) || null; },

    offset(el) {
      const r = el.getBoundingClientRect();
      return { top: r.top + scrollY, left: r.left + scrollX, width: r.width, height: r.height };
    },

    inView(el, margin = 0) {
      const r = el.getBoundingClientRect();
      return r.bottom >= -margin && r.top <= innerHeight + margin &&
             r.right >= -margin && r.left <= innerWidth + margin;
    },

    addClass(el, ...cls) { el?.classList.add(...cls.filter(Boolean)); },
    removeClass(el, ...cls) { el?.classList.remove(...cls.filter(Boolean)); },
    toggleClass(el, cls, force) { el?.classList.toggle(cls, force); },
    hasClass(el, cls) { return el?.classList?.contains(cls) || false; },

    css(el, prop, value) {
      if (!el) return;
      if (isStr(prop)) {
        if (value == null) return getComputedStyle(el).getPropertyValue(prop);
        el.style.setProperty(prop, value);
      } else {
        Object.assign(el.style, prop);
      }
    },

    show(el, display = '') { if (el) el.style.display = display; },
    hide(el) { if (el) el.style.display = 'none'; },

    animate(el, keyframes, opts = {}) {
      if (REDUCED) return Promise.resolve();
      return new Promise((resolve) => {
        const anim = el.animate(keyframes, {
          duration: opts.duration ?? 300,
          easing: opts.easing ?? 'cubic-bezier(.4,0,.2,1)',
          fill: opts.fill ?? 'forwards',
          delay: opts.delay ?? 0,
          iterations: opts.iterations ?? 1,
          direction: opts.direction ?? 'normal',
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
      try {
        localStorage.setItem('__t__', '1');
        localStorage.removeItem('__t__');
        return true;
      } catch { return false; }
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
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        if (e.name === 'QuotaExceededError') Bus.emit('storage:quota', { key });
        return false;
      }
    },

    remove(key) {
      if (!Store.available) return;
      try { localStorage.removeItem(key); } catch {}
    },

    has(key) {
      if (!Store.available) return false;
      return localStorage.getItem(key) !== null;
    },

    keys(prefix = '') {
      if (!Store.available) return [];
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(prefix)) out.push(k);
      }
      return out;
    },

    usage() {
      if (!Store.available) return { bytes: 0, human: '0 B', pct: 0 };
      let bytes = 0;
      for (const k of Store.keys()) {
        bytes += (localStorage.getItem(k) || '').length * 2;
      }
      const total = 5 * 1024 * 1024;
      return { bytes, human: Num.fmtBytes(bytes), pct: (bytes / total) * 100 };
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
    clear() { try { sessionStorage.clear(); } catch {} },
  };

  const Cookies = {
    set(name, value, days = 365) {
      const d = new Date();
      d.setTime(d.getTime() + days * 86400000);
      document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/;SameSite=Lax`;
    },
    get(name) {
      const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
      return m ? decodeURIComponent(m[2]) : null;
    },
    remove(name) {
      document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
    },
    all() {
      return document.cookie.split('; ').reduce((acc, c) => {
        const [k, v] = c.split('=');
        acc[k] = decodeURIComponent(v);
        return acc;
      }, {});
    },
  };

  /* ══════════════════════════════════════════════════════════════
     8 · EVENT BUS
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
      const wrap = (...args) => { off(event, wrap); handler(...args); };
      return on(event, wrap);
    }

    function emit(event, payload) {
      const set = listeners.get(event);
      if (set) for (const h of [...set]) {
        try { h(payload); } catch (e) { warn('bus', event, e); }
      }
      const wc = listeners.get('*');
      if (wc) for (const h of [...wc]) {
        try { h({ event, payload }); } catch {}
      }
    }

    function clear() { listeners.clear(); }

    return { on, off, once, emit, clear };
  })();

  /* ══════════════════════════════════════════════════════════════
     9 · TOASTS
     ══════════════════════════════════════════════════════════════ */

  const Toasts = (() => {
    let host = null;
    const queue = [];
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

      while (h.children.length > maxVisible) {
        h.firstElementChild?.remove();
      }

      const ttl = Number(opts.duration ?? CFG.toastDuration);
      let timer = setTimeout(dismiss, ttl);

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
      ok: (m, o) => show(m, 'ok', o),
      warn: (m, o) => show(m, 'warn', o),
      err: (m, o) => show(m, 'err', o),
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
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
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
          if (e.key === 'Enter') { e.preventDefault(); resolved = true; resolve(input.value); closeAll(); }
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
    let visible = false;
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
      visible = true;

      const r = target.getBoundingClientRect();
      const tr = node.getBoundingClientRect();
      const placement = opts.placement || 'top';

      let top, left;
      if (placement === 'top') {
        top = r.top + scrollY - tr.height - 8;
        left = r.left + scrollX + r.width / 2 - tr.width / 2;
      } else if (placement === 'bottom') {
        top = r.bottom + scrollY + 8;
        left = r.left + scrollX + r.width / 2 - tr.width / 2;
      } else if (placement === 'left') {
        top = r.top + scrollY + r.height / 2 - tr.height / 2;
        left = r.left + scrollX - tr.width - 8;
      } else {
        top = r.top + scrollY + r.height / 2 - tr.height / 2;
        left = r.right + scrollX + 8;
      }

      left = clamp(left, 8, innerWidth - tr.width - 8);
      top = Math.max(top, 8);

      node.style.transform = `translate3d(${left}px, ${top}px, 0)`;
    }

    function hide() {
      if (!el) return;
      el.classList.remove('is-visible');
      visible = false;
    }

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

    return { show, hide, bind, isVisible: () => visible };
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

      document.addEventListener('click', () => closeAll());
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeAll();
      });
    }

    function toggle(menu, trigger) {
      if (menu.classList.contains('is-open')) {
        close(menu);
      } else {
        open(menu, trigger);
      }
    }

    function open(menu, trigger) {
      closeAll();
      menu.classList.add('is-open');
      trigger?.classList.add('is-active');
      openStack.push({ menu, trigger });
      menu.dispatchEvent(new CustomEvent('dropdown:open'));
    }

    function close(menu) {
      menu.classList.remove('is-open');
      const i = openStack.findIndex((x) => x.menu === menu);
      if (i >= 0) {
        openStack[i].trigger?.classList.remove('is-active');
        openStack.splice(i, 1);
      }
    }

    function closeAll() {
      [...openStack].forEach((x) => close(x.menu));
    }

    return { init, open, close, closeAll };
  })();

  /* ══════════════════════════════════════════════════════════════
     13 · TABS
     ══════════════════════════════════════════════════════════════ */

  const Tabs = (() => {
    function init(root = document) {
      $$('[data-tabs]', root).forEach((group) => {
        const triggers = $$('[data-tab]', group);
        const panels = $$('[data-tab-panel]', group);
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
            if (e.key === 'ArrowLeft') { e.preventDefault(); triggers[(i - 1 + triggers.length) % triggers.length].focus(); }
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
     15 · LIGHTBOX / IMAGE ZOOM
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
      Dom.delegate(root, '[data-zoom], .prose img, .content img', 'click', (e, img) => {
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
        let autoplay = el.dataset.carouselAutoplay === 'true';
        let interval = null;
        const gap = parseInt(el.dataset.carouselGap || '16', 10);

        function go(n) {
          index = (n + slides.length) % slides.length;
          const w = slides[0].offsetWidth + gap;
          track.style.transform = `translate3d(${-index * w}px, 0, 0)`;
          if (dots) {
            $$('[data-dot]', dots).forEach((d, i) => d.classList.toggle('is-active', i === index));
          }
          Bus.emit('carousel:changed', { el, index });
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

        if (autoplay) {
          interval = setInterval(() => go(index + 1), 5000);
          el.addEventListener('mouseenter', () => clearInterval(interval));
          el.addEventListener('mouseleave', () => {
            interval = setInterval(() => go(index + 1), 5000);
          });
        }

        // Swipe gestures
        let startX = 0;
        let dragging = false;
        track.addEventListener('touchstart', (e) => {
          startX = e.touches[0].clientX;
          dragging = true;
        }, { passive: true });
        track.addEventListener('touchend', (e) => {
          if (!dragging) return;
          dragging = false;
          const delta = e.changedTouches[0].clientX - startX;
          if (Math.abs(delta) > 40) go(index + (delta < 0 ? 1 : -1));
        }, { passive: true });

        go(0);
      });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     17 · DRAWER (panel lateral)
     ══════════════════════════════════════════════════════════════ */

  const Drawer = (() => {
    const openStack = [];

    function open(opts = {}) {
      const { title = '', body = '', side = 'right', width = '360px' } = opts;
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
     18 · TWEEN ENGINE
     ══════════════════════════════════════════════════════════════ */

  const Ease = {
    linear: (t) => t,
    quadIn: (t) => t * t,
    quadOut: (t) => t * (2 - t),
    quadInOut: (t) => t < .5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
    cubicIn: (t) => t * t * t,
    cubicOut: (t) => --t * t * t + 1,
    cubicInOut: (t) => t < .5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
    quartIn: (t) => t * t * t * t,
    quartOut: (t) => 1 - --t * t * t * t,
    expoOut: (t) => t === 1 ? 1 : 1 - Math.pow(2, -10 * t),
    backOut: (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
    elasticOut: (t) => {
      const c = (2 * Math.PI) / 3;
      return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - .75) * c) + 1;
    },
    bounceOut: (t) => {
      const n = 7.5625, d = 2.75;
      if (t < 1 / d) return n * t * t;
      if (t < 2 / d) return n * (t -= 1.5 / d) * t + .75;
      if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + .9375;
      return n * (t -= 2.625 / d) * t + .984375;
    },
  };

  const Tween = (() => {
    const active = new Map();

    function to(obj, props, opts = {}) {
      const {
        duration = 400,
        delay = 0,
        easing = Ease.cubicOut,
        onUpdate,
        onComplete,
      } = opts;

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
          for (const k of Object.keys(props)) {
            obj[k] = lerp(from[k], props[k], e);
          }
          if (isFn(onUpdate)) onUpdate(obj, t);
          if (t < 1) {
            rafId = raf(tick);
          } else {
            if (isFn(onComplete)) onComplete(obj);
            active.delete(id);
            resolve(obj);
          }
        }
        active.set(id, { cancel: () => caf(rafId) });
        rafId = raf(tick);
      });
    }

    function cancel(id) { active.get(id)?.cancel(); }
    function cancelAll() { for (const a of active.values()) a.cancel(); active.clear(); }

    return { to, cancel, cancelAll, Ease };
  })();

  /* ══════════════════════════════════════════════════════════════
     19 · CONFETTI / PARTICLES
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
          p.x += p.vx;
          p.y += p.vy;
          p.vy += 0.08;
          p.angle += p.va;
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
     20 · TILT / MAGNETIC
     ══════════════════════════════════════════════════════════════ */

  const Tilt = (() => {
    function init(root = document) {
      if (REDUCED || IS_TOUCH) return;
      $$('[data-tilt]', root).forEach((el) => {
        const max = parseFloat(el.dataset.tilt) || 10;
        const scale = parseFloat(el.dataset.tiltScale) || 1.02;

        const onMove = (e) => {
          const r = el.getBoundingClientRect();
          const x = (e.clientX - r.left) / r.width;
          const y = (e.clientY - r.top) / r.height;
          const rx = (y - 0.5) * -2 * max;
          const ry = (x - 0.5) * 2 * max;
          el.style.transform = `perspective(800px) rotateX(${rx}deg) rotateY(${ry}deg) scale(${scale})`;
          el.style.setProperty('--mx', `${x * 100}%`);
          el.style.setProperty('--my', `${y * 100}%`);
        };

        const onLeave = () => {
          el.style.transform = '';
        };

        el.addEventListener('mousemove', throttle(onMove, 16));
        el.addEventListener('mouseleave', onLeave);
      });
    }

    return { init };
  })();

  const Magnetic = (() => {
    function init(root = document) {
      if (REDUCED || IS_TOUCH) return;
      $$('[data-magnetic]', root).forEach((el) => {
        const strength = parseFloat(el.dataset.magnetic) || 0.3;

        const onMove = (e) => {
          const r = el.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const dx = (e.clientX - cx) * strength;
          const dy = (e.clientY - cy) * strength;
          el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
        };

        const onLeave = () => {
          el.style.transform = '';
        };

        el.addEventListener('mousemove', onMove);
        el.addEventListener('mouseleave', onLeave);
      });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     21 · GESTURES
     ══════════════════════════════════════════════════════════════ */

  const Gestures = (() => {
    function onSwipe(el, handler, opts = {}) {
      const minDist = opts.minDist || 40;
      let startX = 0, startY = 0, startT = 0;

      el.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        startT = nowMs();
      }, { passive: true });

      el.addEventListener('touchend', (e) => {
        const dx = e.changedTouches[0].clientX - startX;
        const dy = e.changedTouches[0].clientY - startY;
        const dt = nowMs() - startT;
        if (dt > 600) return;
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        if (Math.max(absX, absY) < minDist) return;
        const dir = absX > absY ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
        handler(dir, { dx, dy, dt });
      }, { passive: true });
    }

    function onLongPress(el, handler, opts = {}) {
      const duration = opts.duration || 500;
      let timer = null;

      const start = (e) => {
        timer = setTimeout(() => handler(e), duration);
      };
      const cancel = () => clearTimeout(timer);

      el.addEventListener('touchstart', start, { passive: true });
      el.addEventListener('touchend', cancel);
      el.addEventListener('touchmove', cancel, { passive: true });
    }

    function onPinch(el, handler) {
      let startDist = 0;

      el.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 2) return;
        startDist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
      }, { passive: true });

      el.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 2) return;
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY,
        );
        handler(dist / startDist);
      }, { passive: true });
    }

    function onDrag(el, opts = {}) {
      let dragging = false, startX = 0, startY = 0;
      const onStart = opts.onStart || noop;
      const onMove = opts.onMove || noop;
      const onEnd = opts.onEnd || noop;

      const down = (e) => {
        dragging = true;
        startX = e.clientX ?? e.touches[0].clientX;
        startY = e.clientY ?? e.touches[0].clientY;
        onStart(e);
        e.preventDefault();
      };

      const move = (e) => {
        if (!dragging) return;
        const x = e.clientX ?? e.touches[0].clientX;
        const y = e.clientY ?? e.touches[0].clientY;
        onMove(x - startX, y - startY, e);
      };

      const up = () => {
        if (!dragging) return;
        dragging = false;
        onEnd();
      };

      el.addEventListener('mousedown', down);
      el.addEventListener('touchstart', down, { passive: false });
      document.addEventListener('mousemove', move);
      document.addEventListener('touchmove', move, { passive: false });
      document.addEventListener('mouseup', up);
      document.addEventListener('touchend', up);
    }

    return { onSwipe, onLongPress, onPinch, onDrag };
  })();

  /* ══════════════════════════════════════════════════════════════
     22 · VALIDACIÓN DE FORMULARIOS
     ══════════════════════════════════════════════════════════════ */

  const Validators = {
    required: (v) => v != null && String(v).trim().length > 0,
    email: (v) => Str.isEmail(v),
    url: (v) => Str.isUrl(v),
    phone: (v) => Str.isPhone(v),
    minLength: (n) => (v) => String(v).length >= n,
    maxLength: (n) => (v) => String(v).length <= n,
    pattern: (re) => (v) => re.test(v),
    number: (v) => !Number.isNaN(parseFloat(v)),
    integer: (v) => Number.isInteger(parseFloat(v)),
    match: (other) => (v) => v === other,
  };

  const FormEngine = (() => {
    function validate(el, rules) {
      const value = el.type === 'checkbox' ? el.checked : el.value;
      const errors = [];
      for (const rule of rules) {
        const [name, ...args] = rule.split(':');
        const fn = Validators[name];
        if (!fn) continue;
        const result = fn(...args)(value);
        if (!result) errors.push(name);
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
        integer: 'Ingresa un número entero.',
        match: 'Los valores no coinciden.',
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
          const onBlur = () => validate(el, rules);
          const onInput = debounce(() => validate(el, rules), 300);
          el.addEventListener('blur', onBlur);
          el.addEventListener('input', onInput);
        });

        form.addEventListener('submit', (e) => {
          let allOk = true;
          fields.forEach((el) => {
            const rules = (el.dataset.rules || '').split('|').filter(Boolean);
            const errors = validate(el, rules);
            if (errors.length) allOk = false;
          });
          if (!allOk) {
            e.preventDefault();
            const firstError = form.querySelector('.has-error input, .has-error textarea, .has-error select');
            firstError?.focus();
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
     23 · INPUT MASKS
     ══════════════════════════════════════════════════════════════ */

  const Mask = (() => {
    const PATTERNS = {
      phone: {
        mask: '(###) ###-####',
        transform: (v) => v.replace(/\D/g, ''),
      },
      'phone-co': {
        mask: '### ### ####',
        transform: (v) => v.replace(/\D/g, ''),
      },
      cedula: {
        mask: '##.###.###-##',
        transform: (v) => v.replace(/\D/g, ''),
      },
      date: {
        mask: '##/##/####',
        transform: (v) => v.replace(/\D/g, ''),
      },
      time: {
        mask: '##:##',
        transform: (v) => v.replace(/\D/g, ''),
      },
      currency: {
        mask: '$ ###,###,###',
        transform: (v) => v.replace(/\D/g, ''),
      },
      nit: {
        mask: '###.###.###-#',
        transform: (v) => v.replace(/\D/g, ''),
      },
    };

    function apply(value, pattern) {
      const p = PATTERNS[pattern];
      if (!p) return value;
      const digits = p.transform(value);
      let out = '';
      let di = 0;
      for (let i = 0; i < p.mask.length && di < digits.length; i++) {
        const m = p.mask[i];
        if (m === '#') {
          out += digits[di++];
        } else if (m === '$' && out.length === 0) {
          out += '$';
        } else {
          out += m;
        }
      }
      return out;
    }

    function init(root = document) {
      Dom.delegate(root, '[data-mask]', 'input', (e, el) => {
        const start = el.selectionStart;
        const oldLen = el.value.length;
        el.value = apply(el.value, el.dataset.mask);
        const newLen = el.value.length;
        const diff = newLen - oldLen;
        el.setSelectionRange(start + diff, start + diff);
      });
    }

    return { apply, init, PATTERNS };
  })();

  /* ══════════════════════════════════════════════════════════════
     24 · AUTOCOMPLETE
     ══════════════════════════════════════════════════════════════ */

  const Autocomplete = (() => {
    function attach(input, options = {}) {
      const { source = [], minChars = 1, onSelect = noop, maxItems = 8 } = options;

      const panel = document.createElement('div');
      panel.className = 'nm-autocomplete';
      panel.setAttribute('role', 'listbox');
      panel.hidden = true;
      (input.parentElement || document.body).appendChild(panel);

      let items = [];
      let active = -1;

      function render() {
        if (!items.length) { panel.hidden = true; return; }
        panel.innerHTML = items.map((it, i) =>
          `<button type="button" class="nm-autocomplete__item ${i === active ? 'is-active' : ''}" data-value="${escapeAttr(it.value)}">
            ${escapeHtml(it.label || it.value)}
          </button>`).join('');
        panel.hidden = false;
      }

      function update() {
        const q = input.value.trim().toLowerCase();
        if (q.length < minChars) { items = []; render(); return; }
        items = source.filter((s) => (s.label || s.value).toLowerCase().includes(q)).slice(0, maxItems);
        active = items.length ? 0 : -1;
        render();
      }

      input.addEventListener('input', debounce(update, 120));
      input.addEventListener('focus', update);

      input.addEventListener('keydown', (e) => {
        if (panel.hidden) return;
        if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; render(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; render(); }
        else if (e.key === 'Enter' && active >= 0) {
          e.preventDefault();
          const it = items[active];
          input.value = it.value;
          panel.hidden = true;
          onSelect(it);
        } else if (e.key === 'Escape') {
          panel.hidden = true;
        }
      });

      Dom.delegate(panel, '[data-value]', 'mousedown', (e, btn) => {
        e.preventDefault();
        input.value = btn.dataset.value;
        panel.hidden = true;
        onSelect({ value: btn.dataset.value });
      });

      document.addEventListener('click', (e) => {
        if (!input.parentElement?.contains(e.target) && e.target !== input) {
          panel.hidden = true;
        }
      });

      return { destroy: () => panel.remove() };
    }

    return { attach };
  })();

  /* ══════════════════════════════════════════════════════════════
     25 · FILE UPLOAD / DROPZONE
     ══════════════════════════════════════════════════════════════ */

  const Dropzone = (() => {
    function init(el, opts = {}) {
      const { onDrop = noop, accept = '*', maxSize = 10 * 1024 * 1024 } = opts;
      let depth = 0;

      el.addEventListener('dragenter', (e) => {
        e.preventDefault();
        depth++;
        el.classList.add('is-dragover');
      });

      el.addEventListener('dragleave', () => {
        depth--;
        if (depth <= 0) {
          depth = 0;
          el.classList.remove('is-dragover');
        }
      });

      el.addEventListener('dragover', (e) => e.preventDefault());

      el.addEventListener('drop', (e) => {
        e.preventDefault();
        depth = 0;
        el.classList.remove('is-dragover');
        const files = Array.from(e.dataTransfer?.files || []);
        const valid = files.filter((f) => {
          if (maxSize && f.size > maxSize) { Toasts.warn(`${f.name} supera el límite.`); return false; }
          if (accept !== '*' && !f.type.match(accept)) { Toasts.warn(`${f.name} no es válido.`); return false; }
          return true;
        });
        if (valid.length) onDrop(valid, e);
      });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     26 · SCROLL UTILITIES
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
     27 · CANVAS EFFECTS (aurora, stars, gradient mesh)
     ══════════════════════════════════════════════════════════════ */

  const CanvasEffects = (() => {
    function stars(canvas, opts = {}) {
      const ctx = canvas.getContext('2d');
      const count = opts.count || 80;
      const dpr = devicePixelRatio || 1;

      const resize = () => {
        canvas.width = canvas.offsetWidth * dpr;
        canvas.height = canvas.offsetHeight * dpr;
        ctx.scale(dpr, dpr);
      };
      resize();
      window.addEventListener('resize', debounce(resize, 200));

      const starsArr = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.offsetWidth,
        y: Math.random() * canvas.offsetHeight,
        r: Math.random() * 1.5 + 0.5,
        alpha: Math.random() * 0.5 + 0.2,
        speed: Math.random() * 0.3 + 0.1,
      }));

      let rafId;
      const tick = () => {
        ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);
        for (const s of starsArr) {
          s.y -= s.speed;
          if (s.y < -2) { s.y = canvas.offsetHeight + 2; s.x = Math.random() * canvas.offsetWidth; }
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255,255,255,${s.alpha})`;
          ctx.fill();
        }
        rafId = raf(tick);
      };

      if (!REDUCED) rafId = raf(tick);

      return { stop: () => caf(rafId) };
    }

    function gradientMesh(canvas, opts = {}) {
      const ctx = canvas.getContext('2d');
      const dpr = devicePixelRatio || 1;
      const colors = opts.colors || ['#1a1a2e', '#7c93d4', '#FFCD00'];

      const resize = () => {
        canvas.width = canvas.offsetWidth * dpr;
        canvas.height = canvas.offsetHeight * dpr;
        ctx.scale(dpr, dpr);
      };
      resize();
      window.addEventListener('resize', debounce(resize, 200));

      let t = 0;
      let rafId;
      const tick = () => {
        t += 0.005;
        ctx.clearRect(0, 0, canvas.offsetWidth, canvas.offsetHeight);
        const w = canvas.offsetWidth;
        const h = canvas.offsetHeight;
        for (let i = 0; i < colors.length; i++) {
          const x = w / 2 + Math.cos(t + i * 2) * w * 0.35;
          const y = h / 2 + Math.sin(t * 1.2 + i * 2) * h * 0.35;
          const grad = ctx.createRadialGradient(x, y, 0, x, y, Math.max(w, h) * 0.6);
          grad.addColorStop(0, colors[i] + '40');
          grad.addColorStop(1, colors[i] + '00');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, w, h);
        }
        rafId = raf(tick);
      };

      if (!REDUCED) rafId = raf(tick);
      return { stop: () => caf(rafId) };
    }

    function init(root = document) {
      $$('[data-canvas-stars]', root).forEach((c) => stars(c));
      $$('[data-canvas-gradient]', root).forEach((c) => gradientMesh(c));
    }

    return { stars, gradientMesh, init };
  })();

  /* ══════════════════════════════════════════════════════════════
     28 · MARQUEE
     ══════════════════════════════════════════════════════════════ */

  const Marquee = (() => {
    function init(root = document) {
      $$('[data-marquee]', root).forEach((el) => {
        if (el.dataset.marqueeReady) return;
        el.dataset.marqueeReady = '1';
        const content = el.innerHTML;
        el.innerHTML = '';
        const track = document.createElement('div');
        track.className = 'marquee__track';
        for (let i = 0; i < 3; i++) {
          const chunk = document.createElement('div');
          chunk.className = 'marquee__chunk';
          chunk.innerHTML = content;
          track.appendChild(chunk);
        }
        el.appendChild(track);
        el.style.setProperty('--marquee-duration', (el.dataset.marqueeDuration || '30') + 's');
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     29 · TYPING TEXT
     ══════════════════════════════════════════════════════════════ */

  const Typer = (() => {
    async function type(el, text, speed = 40) {
      el.textContent = '';
      for (let i = 0; i < text.length; i++) {
        el.textContent += text[i];
        await sleep(speed);
      }
    }

    async function typeAll(items, speed = 40) {
      for (const { el, text } of items) {
        await type(el, text, speed);
      }
    }

    function init(root = document) {
      $$('[data-typing]', root).forEach((el) => {
        const text = el.dataset.typing;
        if (!text) return;
        if (REDUCED) { el.textContent = text; return; }
        const speed = parseInt(el.dataset.typingSpeed || '40', 10);
        const io = new IntersectionObserver(([e]) => {
          if (!e.isIntersecting) return;
          io.disconnect();
          type(el, text, speed);
        }, { threshold: 0.5 });
        io.observe(el);
      });
    }

    return { type, typeAll, init };
  })();

  /* ══════════════════════════════════════════════════════════════
     30 · SPARKLINE / MINI CHARTS
     ══════════════════════════════════════════════════════════════ */

  const Sparkline = (() => {
    function draw(canvas, data, opts = {}) {
      if (!canvas || !data?.length) return;
      const dpr = devicePixelRatio || 1;
      const w = canvas.offsetWidth || 200;
      const h = canvas.offsetHeight || 40;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      const color = opts.color || '#7c93d4';
      const max = Math.max(...data, 1);
      const min = Math.min(...data, 0);
      const range = max - min || 1;
      const step = w / Math.max(data.length - 1, 1);

      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      ctx.lineWidth = opts.lineWidth || 2;
      ctx.strokeStyle = color;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      data.forEach((v, i) => {
        const x = i * step;
        const y = h - ((v - min) / range) * (h - 4) - 2;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();

      if (opts.fill !== false) {
        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        ctx.fillStyle = color + '22';
        ctx.fill();
      }
    }

    function init(root = document) {
      $$('[data-sparkline]', root).forEach((canvas) => {
        try {
          const data = JSON.parse(canvas.dataset.sparkline);
          draw(canvas, data);
        } catch {}
      });
    }

    return { draw, init };
  })();

  /* ══════════════════════════════════════════════════════════════
     31 · DONUT CHART
     ══════════════════════════════════════════════════════════════ */

  const Donut = (() => {
    function draw(canvas, segments, opts = {}) {
      if (!canvas || !segments?.length) return;
      const dpr = devicePixelRatio || 1;
      const size = canvas.offsetWidth || 120;
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      const cx = size / 2;
      const cy = size / 2;
      const r = size / 2 - 4;
      const thickness = opts.thickness || 12;
      const total = segments.reduce((s, x) => s + x.value, 0);
      let start = -Math.PI / 2;

      for (const seg of segments) {
        const angle = (seg.value / total) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r - thickness / 2, start, start + angle);
        ctx.strokeStyle = seg.color || '#7c93d4';
        ctx.lineWidth = thickness;
        ctx.lineCap = 'butt';
        ctx.stroke();
        start += angle;
      }
    }

    return { draw };
  })();

  /* ══════════════════════════════════════════════════════════════
     32 · BAR CHART
     ══════════════════════════════════════════════════════════════ */

  const BarChart = (() => {
    function draw(canvas, data, opts = {}) {
      if (!canvas || !data?.length) return;
      const dpr = devicePixelRatio || 1;
      const w = canvas.offsetWidth || 300;
      const h = canvas.offsetHeight || 160;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);

      const max = Math.max(...data.map((d) => d.value), 1);
      const pad = 20;
      const barW = (w - pad * 2) / data.length - 6;

      data.forEach((d, i) => {
        const barH = ((d.value / max) * (h - pad * 2));
        const x = pad + i * (barW + 6);
        const y = h - pad - barH;
        ctx.fillStyle = d.color || '#7c93d4';
        ctx.beginPath();
        ctx.roundRect(x, y, barW, barH, 4);
        ctx.fill();

        ctx.fillStyle = '#6b6b68';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(d.label || '', x + barW / 2, h - 6);
      });
    }

    return { draw };
  })();

  /* ══════════════════════════════════════════════════════════════
     33 · HASH ROUTER
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
      try { route.handler(route.params); }
      catch (e) { err('router', e); }
      Bus.emit('route:changed', route);
    }

    function init() {
      window.addEventListener('hashchange', navigate);
      navigate();
    }

    return { add, guard, navigate, init, current: () => current };
  })();

  /* ══════════════════════════════════════════════════════════════
     34 · ANIMATION OBSERVER (reveal + counters helper)
     ══════════════════════════════════════════════════════════════ */

  const Observer = (() => {
    function when(selector, cb, opts = {}) {
      const els = typeof selector === 'string' ? $$(selector) : [].concat(selector);
      if (!els.length) return;
      if (!('IntersectionObserver' in window)) {
        els.forEach((el) => cb(el));
        return;
      }
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
    }

    return { when };
  })();

  /* ══════════════════════════════════════════════════════════════
     35 · A11Y HELPERS
     ══════════════════════════════════════════════════════════════ */

  const A11y = {
    focusable(container) {
      return $$(
        'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
        container
      ).filter((el) => el.offsetParent !== null);
    },

    trapFocus(container) {
      const focusables = A11y.focusable(container);
      if (!focusables.length) return noop;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const handler = (e) => {
        if (e.key !== 'Tab') return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
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
        r.setAttribute('aria-atomic', 'true');
        document.body.appendChild(r);
        return r;
      })();
      region.setAttribute('aria-live', priority);
      region.textContent = '';
      setTimeout(() => { region.textContent = message; }, 40);
    },
  };

  /* ══════════════════════════════════════════════════════════════
     36 · CLIPBOARD / SHARE / FILES
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
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
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

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  /* ══════════════════════════════════════════════════════════════
     37 · NETWORK
     ══════════════════════════════════════════════════════════════ */

  const Net = {
    async fetch(url, opts = {}) {
      const { retries = 2, retryDelay = 500, timeout = 10000, ...rest } = opts;
      return retry(async () => {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeout);
        try {
          const res = await fetch(url, { ...rest, signal: controller.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res;
        } finally {
          clearTimeout(t);
        }
      }, { attempts: retries + 1, delay: retryDelay });
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

  /* ══════════════════════════════════════════════════════════════
     38 · FORMATTERS / HELPERS EXTRA
     ══════════════════════════════════════════════════════════════ */

  const Helpers = {
    range(n, start = 0, step = 1) {
      return Array.from({ length: n }, (_, i) => start + i * step);
    },

    chunk(arr, size) {
      const out = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    },

    unique(arr) { return [...new Set(arr)]; },

    groupBy(arr, keyFn) {
      return arr.reduce((acc, item) => {
        const k = keyFn(item);
        (acc[k] = acc[k] || []).push(item);
        return acc;
      }, {});
    },

    sortBy(arr, keyFn, dir = 'asc') {
      return [...arr].sort((a, b) => {
        const ka = keyFn(a), kb = keyFn(b);
        if (ka < kb) return dir === 'asc' ? -1 : 1;
        if (ka > kb) return dir === 'asc' ? 1 : -1;
        return 0;
      });
    },

    pick(obj, keys) {
      return keys.reduce((acc, k) => {
        if (k in obj) acc[k] = obj[k];
        return acc;
      }, {});
    },

    omit(obj, keys) {
      const set = new Set(keys);
      return Object.entries(obj).reduce((acc, [k, v]) => {
        if (!set.has(k)) acc[k] = v;
        return acc;
      }, {});
    },

    deepClone(obj) {
      if (typeof structuredClone === 'function') return structuredClone(obj);
      return JSON.parse(JSON.stringify(obj));
    },

    isEmpty(obj) {
      if (obj == null) return true;
      if (isArr(obj) || isStr(obj)) return obj.length === 0;
      if (isObj(obj)) return Object.keys(obj).length === 0;
      return false;
    },
  };

  /* ══════════════════════════════════════════════════════════════
     FIN DE LA PARTE 1/2
     ══════════════════════════════════════════════════════════════ */
       /* ══════════════════════════════════════════════════════════════
     39 · TEMA
     ══════════════════════════════════════════════════════════════ */

  const Theme = (() => {
    const MODES = ['light', 'dark', 'auto'];

    function systemPref() {
      return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function byHour() {
      const h = new Date().getHours();
      return (h >= CFG.sunriseHour && h < CFG.sunsetHour) ? 'light' : 'dark';
    }

    function resolve(mode) {
      return mode === 'auto' ? byHour() : (mode === 'dark' ? 'dark' : 'light');
    }

    function apply(mode = 'auto', silent = false) {
      const resolved = resolve(mode);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themeMode = mode;
      const meta = $('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0a0a12' : '#003893');
      updateToggles(mode, resolved);
      if (!silent) log('tema:', mode, '→', resolved);
      Bus.emit('theme:changed', { mode, resolved });
    }

    function updateToggles(mode, resolved) {
      $$('[data-theme-toggle]').forEach((btn) => {
        const sun = btn.querySelector('[data-icon="sun"]');
        const moon = btn.querySelector('[data-icon="moon"]');
        const auto = btn.querySelector('[data-icon="auto"]');
        if (sun) sun.style.display = resolved === 'dark' ? '' : 'none';
        if (moon) moon.style.display = resolved === 'dark' ? 'none' : '';
        if (auto) auto.style.display = mode === 'auto' ? '' : 'none';
        btn.setAttribute('aria-label',
          resolved === 'dark' ? 'Activar modo claro' : 'Activar modo oscuro');
        btn.dataset.mode = mode;
      });
    }

    function set(mode) {
      if (!MODES.includes(mode)) mode = 'light';
      Store.write(CFG.themeKey, mode);
      apply(mode);
    }

    function cycle() {
      const cur = document.documentElement.dataset.themeMode || 'auto';
      const next = MODES[(MODES.indexOf(cur) + 1) % MODES.length];
      set(next);
      Toasts.info(`Tema: ${next === 'auto' ? 'automático' : next}`);
    }

    function init() {
      const stored = Store.read(CFG.themeKey, null);
      apply(stored || 'auto', true);

      $$('[data-theme-toggle]').forEach((btn) => {
        btn.addEventListener('click', () => cycle());
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          set('auto');
          Toasts.info('Modo automático por hora del día.');
        });
      });

      const mq = matchMedia('(prefers-color-scheme: dark)');
      mq.addEventListener('change', () => {
        if ((document.documentElement.dataset.themeMode || 'auto') === 'auto') apply('auto', true);
      });

      setInterval(() => {
        if ((document.documentElement.dataset.themeMode || 'auto') === 'auto') apply('auto', true);
      }, 60000);
    }

    return { init, set, cycle, apply, resolve, MODES };
  })();

  /* ══════════════════════════════════════════════════════════════
     40 · MENÚ MÓVIL
     ══════════════════════════════════════════════════════════════ */

  const MobileMenu = (() => {
    function init() {
      const toggle = $('[data-menu-toggle]');
      const menu = $('[data-menu]');
      if (!toggle || !menu) return;

      let open = false;

      const setOpen = (v) => {
        open = v;
        menu.classList.toggle('is-open', v);
        toggle.setAttribute('aria-expanded', String(v));
        document.body.classList.toggle('has-menu', v);
        if (v) {
          Scroll.lock();
          A11y.announce('Menú abierto');
        } else {
          Scroll.unlock();
        }
      };

      toggle.addEventListener('click', () => setOpen(!open));

      Dom.delegate(menu, 'a', 'click', () => setOpen(false));

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && open) setOpen(false);
      });

      window.addEventListener('resize', debounce(() => {
        if (!IS_MOBILE && open) setOpen(false);
      }, 200));

      Bus.on('route:changed', () => setOpen(false));
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     41 · SCROLL SUAVE
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
        Bus.emit('scroll:to', { id });
      });
    }
    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     42 · SCROLL REVEAL
     ══════════════════════════════════════════════════════════════ */

  const ScrollReveal = (() => {
    function init() {
      const els = $$('[data-reveal], [data-reveal-stagger]');
      if (!els.length) return;

      if (REDUCED) {
        els.forEach((el) => el.classList.add('is-visible'));
        return;
      }

      Observer.when(els, (el) => {
        el.classList.add('is-visible');
        Bus.emit('reveal:shown', { el });
      }, { threshold: CFG.revealThreshold });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     43 · CONTADORES
     ══════════════════════════════════════════════════════════════ */

  const Counters = (() => {
    function fmt(n, d, pre, suf) {
      return pre + Num.fmt(n, d) + suf;
    }

    function animate(el) {
      const to = parseFloat(el.dataset.counter) || 0;
      const from = parseFloat(el.dataset.counterFrom || '0');
      const duration = parseInt(el.dataset.counterDuration || CFG.countersDuration, 10);
      const suffix = el.dataset.counterSuffix || '';
      const prefix = el.dataset.counterPrefix || '';
      const decimals = parseInt(el.dataset.counterDecimals || '0', 10);

      if (REDUCED) {
        el.textContent = fmt(to, decimals, prefix, suffix);
        return;
      }

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
     44 · FORMULARIO DE CONTACTO
     ══════════════════════════════════════════════════════════════ */

  const ContactForm = (() => {
    function init() {
      const form = $('[data-contact-form]');
      if (!form) return;

      const mensaje = form.querySelector('#mensaje');
      const counter = form.querySelector('[data-counter]');
      const status = form.querySelector('[data-form-status]');
      const MAX = mensaje ? (parseInt(mensaje.getAttribute('maxlength'), 10) || 1200) : 1200;

      if (counter && mensaje) {
        const update = () => {
          const len = mensaje.value.length;
          counter.textContent = `${len} / ${MAX}`;
          counter.style.color = len > MAX * 0.9 ? 'var(--c-danger)' : '';
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
        Bus.emit('contact:sent', { form });

        form.reset();
        if (counter && mensaje) {
          counter.textContent = `0 / ${MAX}`;
          counter.style.color = '';
        }
        if (btn) { btn.disabled = false; btn.textContent = original; }

        const history = Store.read('numination-contact-history', []) || [];
        history.unshift({ ts: nowMs(), ref: uid('msg') });
        Store.write('numination-contact-history', history.slice(0, 20));
      });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     45 · COOKIE BANNER
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
        Bus.emit('cookie:choice', { value: b.dataset.cookie });
      });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     46 · BACK TO TOP
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
     47 · READING PROGRESS
     ══════════════════════════════════════════════════════════════ */

  const ReadingProgress = (() => {
    function init() {
      const bar = document.createElement('div');
      bar.className = 'reading-progress';
      bar.innerHTML = '<div class="reading-progress__fill"></div>';
      document.body.appendChild(bar);
      const fill = bar.firstElementChild;

      const onScroll = throttle(() => {
        const p = Scroll.progress();
        fill.style.width = (p * 100) + '%';
        bar.classList.toggle('is-visible', p > 0.02 && p < 0.98);
        Store.write(CFG.readingKey, { p, ts: nowMs(), url: location.pathname });
      }, 80);

      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     48 · NAVBAR SHRINK / AUTOHIDE
     ══════════════════════════════════════════════════════════════ */

  const NavbarShrink = (() => {
    function init() {
      const header = $('.site-header, header.site-header, [data-header]');
      if (!header) return;

      let lastY = 0;

      const onScroll = throttle(() => {
        const y = scrollY;
        header.classList.toggle('is-shrunk', y > CFG.navbarShrinkAt);

        if (y < 120) {
          header.classList.remove('is-hidden');
        } else {
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
     49 · LAZY IMAGES
     ══════════════════════════════════════════════════════════════ */

  const LazyImages = (() => {
    function init() {
      const imgs = $$('img[data-src], img[loading="lazy"]');
      if (!imgs.length) return;

      if (!('IntersectionObserver' in window)) {
        imgs.forEach((img) => {
          if (img.dataset.src) img.src = img.dataset.src;
        });
        return;
      }

      const io = new IntersectionObserver((entries) => {
        entries.forEach((e) => {
          if (!e.isIntersecting) return;
          const img = e.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            delete img.dataset.src;
          }
          img.classList.add('is-loaded');
          io.unobserve(img);
        });
      }, { rootMargin: '200px' });

      imgs.forEach((img) => io.observe(img));
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     50 · COPY CODE
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
     51 · ANCHOR LINKS
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
     52 · EXTERNAL LINKS
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
     53 · FORM PERSISTENCE
     ══════════════════════════════════════════════════════════════ */

  const FormPersistence = (() => {
    function init() {
      const saved = Store.read(CFG.formsKey, {}) || {};
      const forms = new Set();

      $$('form input, form textarea, form select').forEach((el) => {
        if (el.type === 'password' || el.type === 'hidden') return;
        const form = el.closest('form');
        if (!form) return;
        forms.add(form);
      });

      forms.forEach((form) => {
        const key = form.id || form.getAttribute('name') || 'form-' + Str.slug(form.action || 'default');
        const inputs = $$('input, textarea, select', form);

        inputs.forEach((input) => {
          const id = input.id || input.name;
          if (!id) return;
          if (saved[key] && saved[key][id] != null) input.value = saved[key][id];

          input.addEventListener('input', debounce(() => {
            const state = saved[key] = saved[key] || {};
            state[id] = input.value;
            Store.write(CFG.formsKey, saved);
          }, 400));
        });

        form.addEventListener('reset', () => {
          delete saved[key];
          Store.write(CFG.formsKey, saved);
        });
      });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     54 · KEYBOARD SHORTCUTS
     ══════════════════════════════════════════════════════════════ */

  const Keyboard = (() => {
    function init() {
      document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const tag = (e.target.tagName || '').toLowerCase();
        const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

        if (mod && e.shiftKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          CommandPalette.open();
          return;
        }

        if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
          e.preventDefault();
          Toasts.info('Debug: ON en consola (__numination).');
          window.__numination = { CFG, Store, Bus, Toasts, Modal, Theme, Tween, Confetti, Router, CommandPalette, Help, Analytics, Sparkline, Donut, BarChart };
          return;
        }

        if (e.key === '?' && !typing) {
          e.preventDefault();
          Help.show();
          return;
        }

        if (e.key === 'Escape') {
          Modal.closeAll();
          Drawer.closeAll();
          const menu = $('[data-menu].is-open');
          if (menu) menu.classList.remove('is-open');
          return;
        }

        if (!typing && !mod && e.key === 'g') {
          document.addEventListener('keydown', function handler(e2) {
            document.removeEventListener('keydown', handler);
            if (e2.key === 'h') location.href = '/index.html';
            else if (e2.key === 'c') location.href = '/contacto.html';
            else if (e2.key === 'n') location.href = '/chat.html';
            else if (e2.key === 's') location.href = '/nosotros.html';
          }, { once: true });
        }
      });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     55 · COMMAND PALETTE
     ══════════════════════════════════════════════════════════════ */

  const CommandPalette = (() => {
    const commands = [
      { label: 'Ir a inicio', shortcut: 'g h', action: () => location.href = '/index.html' },
      { label: 'Ir a chat', shortcut: 'g n', action: () => location.href = '/chat.html' },
      { label: 'Ir a contacto', shortcut: 'g c', action: () => location.href = '/contacto.html' },
      { label: 'Cambiar tema', action: () => Theme.cycle() },
      { label: 'Volver arriba', action: () => Scroll.toTop() },
      { label: 'Copiar URL', action: async () => {
        const ok = await copyToClipboard(location.href);
        Toasts[ok ? 'ok' : 'err'](ok ? 'Copiado.' : 'Falló.');
      }},
      { label: 'Ver atajos', action: () => Help.show() },
      { label: 'Confeti 🎉', action: () => Confetti.burst() },
      { label: 'Limpiar almacenamiento', action: async () => {
        const ok = await Modal.confirm('¿Borrar todos los datos guardados?');
        if (ok) {
          Store.clear('numination-');
          Toasts.ok('Almacenamiento limpio.');
        }
      }},
      { label: 'Modo debug ON', action: () => {
        window.__numination = { CFG, Store, Bus, Toasts, Modal, Theme, Tween, Confetti, Router, CommandPalette, Help, Analytics, Sparkline };
        Toasts.info('Debug activado.');
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
      const list = backdrop.querySelector('.cmd__list');
      let filtered = commands.slice();
      let index = 0;

      const render = () => {
        list.innerHTML = '';
        if (!filtered.length) {
          list.innerHTML = '<li class="cmd__empty">Sin resultados</li>';
          return;
        }
        filtered.forEach((c, i) => {
          const li = document.createElement('li');
          li.className = 'cmd__item' + (i === index ? ' is-active' : '');
          li.innerHTML = `<span>${escapeHtml(c.label)}</span>${c.shortcut ? `<kbd>${c.shortcut}</kbd>` : ''}`;
          li.addEventListener('click', () => run(c));
          list.appendChild(li);
        });
      };

      const run = (c) => {
        close();
        try { c.action(); } catch (e) { warn(e); }
      };

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
     56 · HELP MODAL
     ══════════════════════════════════════════════════════════════ */

  const Help = (() => {
    const rows = [
      ['Ctrl + Shift + K', 'Paleta de comandos'],
      ['Ctrl + Shift + D', 'Modo debug'],
      ['g + h', 'Ir a inicio'],
      ['g + n', 'Ir a chat'],
      ['g + c', 'Ir a contacto'],
      ['g + s', 'Ir a nosotros'],
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
     57 · KONAMI CODE
     ══════════════════════════════════════════════════════════════ */

  const Konami = (() => {
    function init() {
      let i = 0;
      document.addEventListener('keydown', (e) => {
        if (e.key === CFG.konamiSequence[i] || e.key.toLowerCase() === CFG.konamiSequence[i]) {
          i++;
          if (i === CFG.konamiSequence.length) {
            i = 0;
            Confetti.burst(180);
            Toasts.ok('¡Código Konami activado! 🎉');
            console.log('%c🥳 Konami!', 'font-size:20px;color:#7c93d4');
          }
        } else {
          i = 0;
        }
      });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     58 · SHARE BUTTONS
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
            try {
              await navigator.share({ url: location.href, title: document.title });
              return;
            } catch {}
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
     59 · FEEDBACK
     ══════════════════════════════════════════════════════════════ */

  const Feedback = (() => {
    function init() {
      $$('[data-feedback]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const kind = btn.dataset.feedback;
          const label = kind === 'bug' ? 'Describe el problema:' : '¿Qué te pareció?';
          const msg = await Modal.prompt(label);
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
     60 · PRINT HANDLER
     ══════════════════════════════════════════════════════════════ */

  const PrintHandler = (() => {
    function init() {
      $$('[data-print]').forEach((btn) => {
        btn.addEventListener('click', () => window.print());
      });

      window.addEventListener('beforeprint', () => document.body.classList.add('is-printing'));
      window.addEventListener('afterprint', () => document.body.classList.remove('is-printing'));

      if (!$('.print-header')) {
        const h = document.createElement('div');
        h.className = 'print-header';
        h.innerHTML = `
          <h1>Numination</h1>
          <p>Impreso el ${DateU.fmt(nowMs())}</p>`;
        document.body.appendChild(h);
      }
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     61 · WEB VITALS
     ══════════════════════════════════════════════════════════════ */

  const WebVitals = (() => {
    function init() {
      try {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          log('LCP:', Math.round(last.startTime), 'ms');
          Bus.emit('vital:lcp', { value: last.startTime });
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {}

      try {
        let cls = 0;
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (!e.hadRecentInput) cls += e.value;
          }
          Bus.emit('vital:cls', { value: cls });
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}

      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            Bus.emit('vital:fid', { value: e.processingStart - e.startTime });
          }
        }).observe({ type: 'first-input', buffered: true });
      } catch {}

      window.addEventListener('load', () => {
        setTimeout(() => {
          const nav = performance.getEntriesByType('navigation')[0];
          if (!nav) return;
          log('TTFB:', Math.round(nav.responseStart));
          log('DOMContentLoaded:', Math.round(nav.domContentLoadedEventEnd));
          log('Load:', Math.round(nav.loadEventEnd));
        }, 0);
      });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     62 · ANALYTICS LOCAL
     ══════════════════════════════════════════════════════════════ */

  const Analytics = (() => {
    const MAX = 200;

    function track(name, payload = {}) {
      const evt = { name, payload, ts: nowMs(), url: location.pathname };
      const events = Store.read(CFG.analyticsKey, []) || [];
      events.unshift(evt);
      Store.write(CFG.analyticsKey, events.slice(0, MAX));
      log('event:', name, payload);
      Bus.emit('analytics:event', evt);
    }

    function list() {
      return Store.read(CFG.analyticsKey, []) || [];
    }

    function clear() {
      Store.remove(CFG.analyticsKey);
    }

    function init() {
      Dom.delegate(document, '[data-track]', 'click', (e, el) => {
        track(el.dataset.track, { href: el.getAttribute('href') });
      });

      track('pageview', { title: document.title });
    }

    return { init, track, list, clear };
  })();

  /* ══════════════════════════════════════════════════════════════
     63 · IDLE DETECTION
     ══════════════════════════════════════════════════════════════ */

  const Idle = (() => {
    let timer = null;
    let isIdle = false;
    const listeners = [];

    function onChange(fn) { listeners.push(fn); }

    function reset() {
      clearTimeout(timer);
      if (isIdle) {
        isIdle = false;
        listeners.forEach((fn) => fn(false));
      }
      timer = setTimeout(() => {
        isIdle = true;
        listeners.forEach((fn) => fn(true));
      }, CFG.idleTimeout);
    }

    function init() {
      ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach((ev) =>
        document.addEventListener(ev, reset, { passive: true }));
      reset();
    }

    return { init, onChange, isIdle: () => isIdle };
  })();

  /* ══════════════════════════════════════════════════════════════
     64 · VISIBILITY
     ══════════════════════════════════════════════════════════════ */

  const Visibility = (() => {
    const listeners = [];

    function onChange(fn) { listeners.push(fn); }

    function init() {
      document.addEventListener('visibilitychange', () => {
        listeners.forEach((fn) => fn(!document.hidden));
        Bus.emit('visibility:changed', { visible: !document.hidden });
      });
    }

    return { init, onChange };
  })();

  /* ══════════════════════════════════════════════════════════════
     65 · UNLOAD GUARD
     ══════════════════════════════════════════════════════════════ */

  const Unload = (() => {
    let armed = false;

    function arm() { armed = true; }
    function disarm() { armed = false; }

    function init() {
      window.addEventListener('beforeunload', (e) => {
        if (!armed) return;
        e.preventDefault();
        e.returnValue = '';
        return '';
      });
    }

    return { init, arm, disarm, isArmed: () => armed };
  })();

  /* ══════════════════════════════════════════════════════════════
     66 · NETWORK STATUS
     ══════════════════════════════════════════════════════════════ */

  const Network = (() => {
    function init() {
      const update = () => {
        document.body.classList.toggle('is-offline', !navigator.onLine);
      };

      window.addEventListener('online', () => {
        update();
        Toasts.ok('Conexión restaurada.');
        Bus.emit('net:online');
      });

      window.addEventListener('offline', () => {
        update();
        Toasts.warn('Sin conexión.');
        Bus.emit('net:offline');
      });

      update();

      if (navigator.connection) {
        const conn = navigator.connection;
        document.body.dataset.network = conn.effectiveType || 'unknown';
        conn.addEventListener?.('change', () => {
          document.body.dataset.network = conn.effectiveType || 'unknown';
        });
      }
    }

    return { init, isOnline: () => navigator.onLine };
  })();

  /* ══════════════════════════════════════════════════════════════
     67 · BOOKMARKS
     ══════════════════════════════════════════════════════════════ */

  const Bookmarks = (() => {
    function list() {
      return Store.read(CFG.bookmarksKey, []) || [];
    }

    function toggle(url = location.pathname + location.search) {
      const items = list();
      const i = items.findIndex((b) => b.url === url);
      if (i >= 0) {
        items.splice(i, 1);
        Toasts.info('Quitado de favoritos.');
      } else {
        items.unshift({ url, title: document.title, ts: nowMs() });
        Toasts.ok('Añadido a favoritos.');
      }
      Store.write(CFG.bookmarksKey, items.slice(0, 100));
      Bus.emit('bookmarks:changed', { url });
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
     68 · RECENTLY VIEWED
     ══════════════════════════════════════════════════════════════ */

  const RecentlyViewed = (() => {
    function push(url = location.pathname, title = document.title) {
      const items = Store.read(CFG.visitedKey, []) || [];
      const i = items.findIndex((x) => x.url === url);
      if (i >= 0) items.splice(i, 1);
      items.unshift({ url, title, ts: nowMs() });
      Store.write(CFG.visitedKey, items.slice(0, 20));
    }

    function list() {
      return Store.read(CFG.visitedKey, []) || [];
    }

    function init() { push(); }

    return { init, push, list };
  })();

  /* ══════════════════════════════════════════════════════════════
     69 · URL PARAMS
     ══════════════════════════════════════════════════════════════ */

  const UrlParams = (() => {
    const params = new URLSearchParams(location.search);
    return {
      get: (k, fallback = null) => params.get(k) ?? fallback,
      has: (k) => params.has(k),
      all: () => Object.fromEntries(params.entries()),
    };
  })();

  /* ══════════════════════════════════════════════════════════════
     70 · PWA INSTALL
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
        const result = await deferred.userChoice;
        if (result.outcome === 'accepted') Toasts.ok('¡Instalada!');
        deferred = null;
        btn.remove();
      });
      document.body.appendChild(btn);
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     71 · NOTIFY
     ══════════════════════════════════════════════════════════════ */

  const Notify = (() => {
    async function request() {
      if (!('Notification' in window)) return false;
      if (Notification.permission === 'granted') return true;
      if (Notification.permission === 'denied') return false;
      const r = await Notification.requestPermission();
      return r === 'granted';
    }

    function send(title, body, opts = {}) {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      new Notification(title, { body, icon: '/favicon.ico', ...opts });
    }

    return { request, send };
  })();

  /* ══════════════════════════════════════════════════════════════
     72 · CONSOLE ART
     ══════════════════════════════════════════════════════════════ */

  const ConsoleArt = (() => {
    function init() {
      const styles = 'background:linear-gradient(90deg,#1a1a2e,#7c93d4);color:#fff;padding:8px 14px;border-radius:8px;font-size:14px;font-weight:bold';
      console.log('%c🇨🇴 Numination v' + VERSION, styles);
      console.log('%cHecho en Colombia · La IA que habla el idioma de nuestra educación.', 'color:#7c93d4;font-style:italic');
      console.log('%c¿Curioseando? Escríbenos: hola@numination.co', 'color:#6b6b68;font-size:11px');
      console.log('%c💡 Prueba el código Konami: ↑↑↓↓←→←→BA', 'color:#FFCD00;font-size:11px');
      console.log('%c🛠 __numination disponible en consola (Ctrl+Shift+D)', 'color:#10b981;font-size:11px');
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     73 · SPLASH
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
     74 · MOTION PREF
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

  /* ══════════════════════════════════════════════════════════════
     75 · FONT SIZE
     ══════════════════════════════════════════════════════════════ */

  const FontSize = (() => {
    const KEY = 'numination-font-size';
    const MIN = 12;
    const MAX = 22;

    function apply(size) {
      document.documentElement.style.setProperty('--base-font-size', size + 'px');
      document.documentElement.style.fontSize = size + 'px';
      Store.write(KEY, size);
    }

    function bump(delta) {
      const cur = parseInt(Store.read(KEY, 16), 10);
      const next = clamp(cur + delta, MIN, MAX);
      apply(next);
      Toasts.info('Tamaño: ' + next + 'px');
    }

    function init() {
      const stored = Store.read(KEY, null);
      if (stored) apply(stored);
      $$('[data-font-bump]').forEach((btn) => {
        btn.addEventListener('click', () => bump(parseInt(btn.dataset.fontBump, 10)));
      });
    }

    return { init, bump, apply };
  })();

  /* ══════════════════════════════════════════════════════════════
     76 · HIGH CONTRAST
     ══════════════════════════════════════════════════════════════ */

  const HighContrast = (() => {
    const KEY = 'numination-contrast';

    function init() {
      const stored = Store.read(KEY, false);
      document.body.classList.toggle('high-contrast', !!stored);

      $$('[data-contrast-toggle]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const next = !document.body.classList.contains('high-contrast');
          document.body.classList.toggle('high-contrast', next);
          Store.write(KEY, next);
          Toasts.info(next ? 'Alto contraste activado.' : 'Alto contraste desactivado.');
        });
      });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     77 · DATA SAVER
     ══════════════════════════════════════════════════════════════ */

  const DataSaver = (() => {
    function init() {
      if (navigator.connection?.saveData) {
        document.body.classList.add('data-saver');
        log('data saver activo');
      }
      if (navigator.connection?.effectiveType) {
        document.body.dataset.network = navigator.connection.effectiveType;
      }
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     78 · SERVICE WORKER (stub)
     ══════════════════════════════════════════════════════════════ */

  const ServiceWorker = (() => {
    function init() {
      if (!('serviceWorker' in navigator)) return;
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
      log('service worker listo (no registrado)');
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     79 · CURSOR GLOW
     ══════════════════════════════════════════════════════════════ */

  const CursorGlow = (() => {
    function init() {
      if (IS_TOUCH || REDUCED) return;

      const glow = document.createElement('div');
      glow.className = 'cursor-glow';
      document.body.appendChild(glow);

      const move = throttle((e) => {
        glow.style.transform = `translate3d(${e.clientX - 100}px, ${e.clientY - 100}px, 0)`;
        glow.style.opacity = '1';
      }, 24);

      document.addEventListener('mousemove', move);
      document.addEventListener('mouseleave', () => { glow.style.opacity = '0'; });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     80 · ARTICLE READING
     ══════════════════════════════════════════════════════════════ */

  const ArticleReading = (() => {
    function init() {
      const article = $('article, [data-article]');
      if (!article) return;

      const key = 'numination-read-' + Str.slug(document.title);

      const onScroll = throttle(() => {
        const rect = article.getBoundingClientRect();
        const total = rect.height - innerHeight;
        const progress = total > 0 ? clamp(-rect.top / total, 0, 1) : 1;
        Store.write(key, { progress, ts: nowMs() });
        if (progress > 0.9) {
          document.body.classList.add('article-read');
          Bus.emit('article:read', { title: document.title });
        }
      }, 200);

      window.addEventListener('scroll', onScroll, { passive: true });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     81 · READING TIME
     ══════════════════════════════════════════════════════════════ */

  const ReadingTime = (() => {
    function init() {
      const el = $('[data-reading-time]');
      if (!el) return;
      const article = $('article, [data-article]') || document.body;
      const words = Str.countWords(article.innerText || '');
      const minutes = Math.max(1, Math.round(words / 200));
      el.textContent = `${minutes} min de lectura`;
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     82 · FORM GUARD
     ══════════════════════════════════════════════════════════════ */

  const FormGuard = (() => {
    function init() {
      const forms = $$('form[data-guard]');
      if (!forms.length) return;

      forms.forEach((form) => {
        form.addEventListener('input', () => Unload.arm());
        form.addEventListener('submit', () => Unload.disarm());
        form.addEventListener('reset', () => Unload.disarm());
      });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     83 · LANGUAGE
     ══════════════════════════════════════════════════════════════ */

  const Language = (() => {
    function init() {
      const lang = navigator.language || 'es-CO';
      document.documentElement.lang = lang.startsWith('es') ? 'es-CO' : lang;
      log('idioma:', lang);
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     84 · SCROLL DIRECTION
     ══════════════════════════════════════════════════════════════ */

  const ScrollDirection = (() => {
    let lastY = 0;
    const listeners = [];

    function on(fn) { listeners.push(fn); }

    function init() {
      const handler = throttle(() => {
        const y = scrollY;
        if (Math.abs(y - lastY) > 10) {
          const dir = y > lastY ? 'down' : 'up';
          listeners.forEach((fn) => fn(dir, y));
          document.body.dataset.scrollDir = dir;
          lastY = y;
        }
      }, 80);

      window.addEventListener('scroll', handler, { passive: true });
    }

    return { init, on };
  })();

  /* ══════════════════════════════════════════════════════════════
     85 · HERO SCROLL CUE
     ══════════════════════════════════════════════════════════════ */

  const HeroScrollCue = (() => {
    function init() {
      const cue = $('[data-scroll-cue]');
      if (!cue) return;
      cue.addEventListener('click', () => {
        const target = cue.dataset.scrollCue;
        const el = target ? document.querySelector(target) : null;
        if (el) Scroll.to(el);
        else window.scrollTo({ top: innerHeight, behavior: REDUCED ? 'auto' : 'smooth' });
      });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     86 · LOCAL VISITS
     ══════════════════════════════════════════════════════════════ */

  const LocalVisits = (() => {
    const KEY = 'numination-visits';

    function init() {
      const visits = (Store.read(KEY, 0) || 0) + 1;
      Store.write(KEY, visits);
      log('visitas locales:', visits);
      $$('[data-visits]').forEach((el) => { el.textContent = visits; });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     87 · PRELOAD CRÍTICO
     ══════════════════════════════════════════════════════════════ */

  const Preload = (() => {
    function init() {
      $$('link[rel="preload"]').forEach((link) => {
        if (!link.as) return;
        log('preload:', link.href);
      });

      const imgs = $$('img[fetchpriority="high"]');
      imgs.forEach((img) => log('img prioridad alta:', img.src));
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     88 · SCROLL MOMENTUM / SMOOTH (opt-in)
     ══════════════════════════════════════════════════════════════ */

  const ScrollMomentum = (() => {
    function init() {
      if (REDUCED || IS_TOUCH) return;
      if (!document.body.dataset.scrollMomentum) return;

      let target = scrollY;
      let current = scrollY;
      let rafId = null;

      const onWheel = (e) => {
        e.preventDefault();
        target += e.deltaY;
        target = clamp(target, 0, document.documentElement.scrollHeight - innerHeight);
        if (!rafId) rafId = raf(step);
      };

      const step = () => {
        current = lerp(current, target, 0.12);
        window.scrollTo(0, current);
        if (Math.abs(target - current) > 0.5) {
          rafId = raf(step);
        } else {
          current = target;
          rafId = null;
        }
      };

      window.addEventListener('wheel', onWheel, { passive: false });
    }

    return { init };
  })();

  /* ══════════════════════════════════════════════════════════════
     89 · BOOT
     ══════════════════════════════════════════════════════════════ */

  function boot() {
    log(`Numination v${VERSION} · build ${BUILD}`);

    Theme.init();
    MobileMenu.init();
    SmoothScroll.init();
    ScrollReveal.init();
    Counters.init();
    ContactForm.init();
    CookieBanner.init();
    BackToTop.init();
    ReadingProgress.init();
    NavbarShrink.init();
    LazyImages.init();
    CopyCode.init();
    AnchorLinks.init();
    ExternalLinks.init();
    FormPersistence.init();
    Keyboard.init();
    Dropdown.init();
    Tabs.init();
    Accordion.init();
    Lightbox.init();
    Carousel.init();
    Tilt.init();
    Magnetic.init();
    Marquee.init();
    Typer.init();
    CanvasEffects.init();
    Sparkline.init();
    Tooltip.bind();
    FormEngine.init();
    Mask.init();
    Konami.init();
    Share.init();
    Feedback.init();
    PrintHandler.init();
    WebVitals.init();
    Analytics.init();
    Idle.init();
    Visibility.init();
    Unload.init();
    Network.init();
    Bookmarks.init();
    RecentlyViewed.init();
    PWA.init();
    ConsoleArt.init();
    Splash.init();
    MotionPref.init();
    FontSize.init();
    HighContrast.init();
    DataSaver.init();
    ServiceWorker.init();
    CursorGlow.init();
    ArticleReading.init();
    ReadingTime.init();
    FormGuard.init();
    Language.init();
    ScrollDirection.init();
    HeroScrollCue.init();
    LocalVisits.init();
    Preload.init();
    ScrollMomentum.init();

    // Router básico (opcional, si hay hash routing)
    Router.add('/', () => log('ruta: inicio'));
    Router.init();

    // Exponer API para debug
    window.__numination = {
      CFG,
      $, $$,
      Store, Session, Cookies,
      Bus,
      Toasts,
      Modal,
      Tooltip,
      Dropdown,
      Tabs,
      Accordion,
      Lightbox,
      Carousel,
      Drawer,
      Tween,
      Ease,
      Confetti,
      Tilt,
      Magnetic,
      Gestures,
      Validators,
      FormEngine,
      Mask,
      Autocomplete,
      Dropzone,
      Scroll,
      CanvasEffects,
      Marquee,
      Typer,
      Sparkline,
      Donut,
      BarChart,
      Router,
      Observer,
      A11y,
      Net,
      Helpers,
      Str,
      Num,
      DateU,
      Color,
      Dom,
      Theme,
      Analytics,
      Bookmarks,
      RecentlyViewed,
      UrlParams,
      Notify,
      Share,
      copyToClipboard,
      downloadBlob,
    };

    Bus.emit('app:booted', { version: VERSION });

    log('boot completo');
  }

  /* ══════════════════════════════════════════════════════════════
     90 · ARRANQUE
     ══════════════════════════════════════════════════════════════ */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

})();


