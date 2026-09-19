/* ============================================================
   NUMINATION — main.js v4.0 "El Pulpo"
   Runtime global del sitio: tema, menú, scroll, counters,
   formulario, toasts, modales, atajos, easter eggs y más.
   ~2200 líneas. Un solo IIFE. Sin dependencias.
   ============================================================ */

(() => {
  'use strict';

  /* ═══════════════════════════════════════════════════════════
     0. CONFIGURACIÓN GLOBAL
     ═══════════════════════════════════════════════════════════ */

  const CFG = {
    version: '4.0.0',
    themeKey: 'numination-theme',
    prefsKey: 'numination-prefs',
    formsKey: 'numination-forms',
    readingKey: 'numination-reading',
    visitedKey: 'numination-visited',
    bookmarksKey: 'numination-bookmarks',
    cookieKey: 'numination-cookie-consent',
    idleTimeout: 60_000,
    scrollTopThreshold: 600,
    navbarShrinkAt: 40,
    revealThreshold: 0.12,
    countersDuration: 1600,
    toastDuration: 2600,
    konamiSequence: ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'],
    sunriseHour: 6,
    sunsetHour: 18,
    debug: new URLSearchParams(location.search).has('debug'),
  };

  const EMOJI = {
    ok: '✅', warn: '⚠️', err: '❌', info: 'ℹ️',
    sparkle: '✨', rocket: '🚀', fire: '🔥',
  };

  /* ═══════════════════════════════════════════════════════════
     1. UTILIDADES BASE
     ═══════════════════════════════════════════════════════════ */

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const log = (...args) => { if (CFG.debug) console.log('%c[main]', 'color:#7c93d4', ...args); };
  const warn = (...args) => { if (CFG.debug) console.warn('[main]', ...args); };

  function debounce(fn, wait = 200) {
    let t;
    return function debounced(...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function throttle(fn, wait = 100) {
    let last = 0, timer = null;
    return function throttled(...args) {
      const now = Date.now();
      const remaining = wait - (now - last);
      if (remaining <= 0) {
        clearTimeout(timer);
        timer = null;
        last = now;
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = null;
          fn.apply(this, args);
        }, remaining);
      }
    };
  }

  function raf(fn) { return requestAnimationFrame(fn); }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  function once(fn) {
    let done = false;
    return function wrapped(...args) {
      if (done) return;
      done = true;
      return fn.apply(this, args);
    };
  }

  function clamp(n, min, max) { return Math.min(Math.max(n, min), max); }

  function lerp(a, b, t) { return a + (b - a) * t; }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function uid(prefix = 'x') {
    return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  }

  function slugify(s) {
    return String(s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
  }

  function fmtNumber(n, d = 0) {
    return Number(n).toLocaleString('es-CO', {
      minimumFractionDigits: d, maximumFractionDigits: d,
    });
  }

  function fmtRelative(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return 'hace un momento';
    const m = Math.floor(s / 60);
    if (m < 60) return `hace ${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `hace ${h} h`;
    const d = Math.floor(h / 24);
    if (d < 7) return `hace ${d} d`;
    return new Date(ts).toLocaleDateString('es-CO');
  }

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function isMobile() {
    return window.matchMedia('(max-width: 768px)').matches;
  }

  function isTouch() {
    return ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  }

  function onIdle(fn, timeout = 2000) {
    if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout });
    else setTimeout(fn, timeout);
  }

  /* ═══════════════════════════════════════════════════════════
     2. STORAGE WRAPPER
     ═══════════════════════════════════════════════════════════ */

  const Store = {
    read(key, fallback = null) {
      try {
        const raw = localStorage.getItem(key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
      } catch { return fallback; }
    },
    write(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e) {
        warn('storage write', e);
        return false;
      }
    },
    remove(key) { try { localStorage.removeItem(key); } catch {} },
    has(key) { try { return localStorage.getItem(key) !== null; } catch { return false; } },
  };

  /* ═══════════════════════════════════════════════════════════
     3. SISTEMA DE TOASTS
     ═══════════════════════════════════════════════════════════ */

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
      el.textContent = message;
      h.appendChild(el);
      requestAnimationFrame(() => el.classList.add('is-visible'));
      const ttl = Number(opts.duration ?? CFG.toastDuration);
      const t = setTimeout(dismiss, ttl);
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
      ok: (m, o) => show(m, 'ok', o),
      warn: (m, o) => show(m, 'warn', o),
      err: (m, o) => show(m, 'err', o),
      info: (m, o) => show(m, 'info', o),
    };
  })();

  /* ═══════════════════════════════════════════════════════════
     4. SISTEMA DE MODALES
     ═══════════════════════════════════════════════════════════ */

  const Modal = (() => {
    const stack = [];

    function open({ title, body, actions = [], className = '', size = 'md', onClose }) {
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
      if (typeof body === 'string') bodyEl.innerHTML = body;
      else if (body instanceof Node) bodyEl.appendChild(body);

      const foot = back.querySelector('.nm-modal__foot');
      for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ' + (a.variant || 'btn--ghost');
        b.textContent = a.label;
        b.addEventListener('click', () => {
          try { a.onClick && a.onClick(back); }
          finally { if (a.close !== false) close(back); }
        });
        foot.appendChild(b);
      }

      const closeBtn = back.querySelector('.nm-modal__close');
      closeBtn.addEventListener('click', () => close(back));
      back.addEventListener('click', (e) => { if (e.target === back) close(back); });

      document.body.appendChild(back);
      document.body.classList.add('has-modal');
      stack.push(back);

      const focusable = back.querySelector('input, textarea, button:not(.nm-modal__close), [tabindex]');
      if (focusable) setTimeout(() => focusable.focus(), 60);

      trapFocus(back);
      return back;
    }

    function close(back) {
      if (!back || !back.parentNode) return;
      back.remove();
      const i = stack.indexOf(back);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length) document.body.classList.remove('has-modal');
      const prev = stack[stack.length - 1];
      if (prev) trapFocus(prev);
    }

    function closeAll() {
      [...stack].forEach(close);
    }

    function trapFocus(container) {
      const focusables = $$(
        'a[href], button:not([disabled]), textarea, input:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
        container
      );
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const handler = (e) => {
        if (e.key !== 'Tab') return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      };
      container.addEventListener('keydown', handler);
    }

    function confirm(message, opts = {}) {
      return new Promise(resolve => {
        open({
          title: opts.title || 'Confirmar',
          body: `<p class="nm-modal__msg">${escapeHtml(message)}</p>`,
          actions: [
            { label: opts.cancelLabel || 'Cancelar', onClick: () => resolve(false) },
            { label: opts.okLabel || 'Aceptar', variant: 'btn--primary', onClick: () => resolve(true) },
          ],
          onClose: () => resolve(false),
        });
      });
    }

    function prompt(message, defaultValue = '') {
      return new Promise(resolve => {
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
            { label: 'Cancelar', onClick: () => resolve(null) },
            { label: 'Aceptar', variant: 'btn--primary', onClick: () => resolve(input.value) },
          ],
          onClose: () => resolve(null),
        });
      });
    }

    return { open, close, closeAll, confirm, prompt };
  })();

  /* ═══════════════════════════════════════════════════════════
     5. TEMA CLARO/OSCURO/AUTO
     ═══════════════════════════════════════════════════════════ */

  const Theme = (() => {
    const modes = ['light', 'dark', 'auto'];

    function getSystemPref() {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    function getAutoByHour() {
      const h = new Date().getHours();
      return (h >= CFG.sunriseHour && h < CFG.sunsetHour) ? 'light' : 'dark';
    }

    function resolve(mode) {
      if (mode === 'auto') return getAutoByHour();
      return mode === 'dark' ? 'dark' : 'light';
    }

    function apply(mode, silent = false) {
      const resolved = resolve(mode);
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themeMode = mode;
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0a0a12' : '#003893');
      updateToggles(mode, resolved);
      if (!silent) log('theme applied:', mode, '→', resolved);
    }

    function updateToggles(mode, resolved) {
      $$('[data-theme-toggle]').forEach(btn => {
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

    function cycle() {
      const current = document.documentElement.dataset.themeMode || 'light';
      const next = modes[(modes.indexOf(current) + 1) % modes.length];
      set(next);
      Toasts.info(`Tema: ${next === 'auto' ? 'automático' : next}`);
    }

    function set(mode) {
      if (!modes.includes(mode)) mode = 'light';
      Store.write(CFG.themeKey, mode);
      apply(mode);
    }

    function init() {
      const stored = Store.read(CFG.themeKey, null);
      const initial = stored || 'auto';
      apply(initial, true);

      $$('[data-theme-toggle]').forEach(btn => {
        btn.addEventListener('click', () => cycle());
        btn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          set('auto');
          Toasts.info('Modo automático por hora del día.');
        });
      });

      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        if ((document.documentElement.dataset.themeMode || 'auto') === 'auto') apply('auto');
      });

      setInterval(() => {
        if ((document.documentElement.dataset.themeMode || 'auto') === 'auto') apply('auto', true);
      }, 60_000);
    }

    return { init, set, cycle, apply };
  })();

  /* ═══════════════════════════════════════════════════════════
     6. MENÚ MÓVIL
     ═══════════════════════════════════════════════════════════ */

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
      };

      toggle.addEventListener('click', () => setOpen(!open));
      menu.addEventListener('click', (e) => {
        if (e.target.closest('a')) setOpen(false);
      });

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && open) setOpen(false);
      });

      window.addEventListener('resize', debounce(() => {
        if (!isMobile() && open) setOpen(false);
      }, 200));
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     7. SCROLL SUAVE
     ═══════════════════════════════════════════════════════════ */

  const SmoothScroll = (() => {
    function init() {
      document.addEventListener('click', (e) => {
        const a = e.target.closest('a[href^="#"]');
        if (!a) return;
        const id = a.getAttribute('href');
        if (!id || id === '#') return;
        const target = document.querySelector(id);
        if (!target) return;
        e.preventDefault();
        const top = target.getBoundingClientRect().top + window.scrollY - 80;
        window.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        history.replaceState(null, '', id);
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     8. SCROLL REVEAL
     ═══════════════════════════════════════════════════════════ */

  const ScrollReveal = (() => {
    function init() {
      const els = $$('[data-reveal], [data-reveal-stagger]');
      if (!els.length) return;

      if (prefersReducedMotion()) {
        els.forEach(el => el.classList.add('is-visible'));
        return;
      }

      const io = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          io.unobserve(entry.target);
        });
      }, { threshold: CFG.revealThreshold, rootMargin: '0px 0px -60px 0px' });

      els.forEach(el => io.observe(el));
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     9. CONTADORES ANIMADOS
     ═══════════════════════════════════════════════════════════ */

  const Counters = (() => {
    function fmt(n, d, pre, suf) {
      return pre + fmtNumber(n, d) + suf;
    }

    function init() {
      const els = $$('[data-counter]');
      if (!els.length) return;

      const reduce = prefersReducedMotion();

      const io = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          const el = entry.target;
          io.unobserve(el);

          const to = parseFloat(el.dataset.counter) || 0;
          const from = parseFloat(el.dataset.counterFrom || '0');
          const duration = parseInt(el.dataset.counterDuration || CFG.countersDuration, 10);
          const suffix = el.dataset.counterSuffix || '';
          const prefix = el.dataset.counterPrefix || '';
          const decimals = parseInt(el.dataset.counterDecimals || '0', 10);

          if (reduce) { el.textContent = fmt(to, decimals, prefix, suffix); return; }

          const t0 = performance.now();
          const tick = (now) => {
            const p = clamp((now - t0) / duration, 0, 1);
            const eased = 1 - Math.pow(1 - p, 3);
            el.textContent = fmt(from + (to - from) * eased, decimals, prefix, suffix);
            if (p < 1) raf(tick);
            else el.textContent = fmt(to, decimals, prefix, suffix);
          };
          raf(tick);
        });
      }, { threshold: 0.35 });

      els.forEach(el => io.observe(el));
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     10. FORMULARIO DE CONTACTO
     ═══════════════════════════════════════════════════════════ */

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
          counter.style.color = len > MAX * 0.9 ? 'var(--brand-red, #c8102e)' : '';
        };
        mensaje.addEventListener('input', update);
        update();
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!form.checkValidity()) { form.reportValidity(); return; }

        const btn = form.querySelector('button[type="submit"]');
        const originalLabel = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Enviando…'; }

        await wait(800);

        if (status) {
          status.hidden = false;
          status.dataset.state = 'ok';
          status.textContent = 'Mensaje enviado. Te responderemos pronto.';
        }
        Toasts.ok('Gracias por escribirnos.');
        form.reset();
        if (counter && mensaje) {
          counter.textContent = `0 / ${MAX}`;
          counter.style.color = '';
        }
        if (btn) { btn.disabled = false; btn.textContent = originalLabel; }

        // Guardar en historial local
        const history = Store.read('numination-contact-history', []);
        history.unshift({ ts: Date.now(), data: 'anonymous' });
        Store.write('numination-contact-history', history.slice(0, 20));
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     11. BANNER DE COOKIES
     ═══════════════════════════════════════════════════════════ */

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
      requestAnimationFrame(() => banner.classList.add('is-visible'));

      banner.addEventListener('click', (e) => {
        const b = e.target.closest('[data-cookie]');
        if (!b) return;
        Store.write(CFG.cookieKey, { value: b.dataset.cookie, ts: Date.now() });
        banner.classList.remove('is-visible');
        setTimeout(() => banner.remove(), 400);
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     12. BOTÓN VOLVER ARRIBA
     ═══════════════════════════════════════════════════════════ */

  const BackToTop = (() => {
    function init() {
      if ($('.back-to-top')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'back-to-top';
      btn.title = 'Volver arriba';
      btn.setAttribute('aria-label', 'Volver arriba');
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
      btn.addEventListener('click', () => {
        window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      });
      document.body.appendChild(btn);

      const onScroll = throttle(() => {
        btn.classList.toggle('is-visible', window.scrollY > CFG.scrollTopThreshold);
      }, 120);
      window.addEventListener('scroll', onScroll);
      onScroll();
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     13. BARRA DE PROGRESO DE LECTURA
     ═══════════════════════════════════════════════════════════ */

  const ReadingProgress = (() => {
    function init() {
      const bar = document.createElement('div');
      bar.className = 'reading-progress';
      bar.innerHTML = '<div class="reading-progress__fill"></div>';
      document.body.appendChild(bar);
      const fill = bar.firstElementChild;

      const onScroll = throttle(() => {
        const h = document.documentElement.scrollHeight - window.innerHeight;
        const p = h > 0 ? clamp(window.scrollY / h, 0, 1) : 0;
        fill.style.width = (p * 100) + '%';
        bar.classList.toggle('is-visible', p > 0.02 && p < 0.98);
        Store.write(CFG.readingKey, { p, ts: Date.now(), url: location.pathname });
      }, 80);

      window.addEventListener('scroll', onScroll);
      onScroll();
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     14. NAVBAR QUE SE ENCOGE
     ═══════════════════════════════════════════════════════════ */

  const NavbarShrink = (() => {
    function init() {
      const header = $('.site-header, header.site-header, [data-header]');
      if (!header) return;
      const onScroll = throttle(() => {
        header.classList.toggle('is-shrunk', window.scrollY > CFG.navbarShrinkAt);
      }, 100);
      window.addEventListener('scroll', onScroll);
      onScroll();
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     15. TABS GENÉRICOS
     ═══════════════════════════════════════════════════════════ */

  const Tabs = (() => {
    function init() {
      $$('[data-tabs]').forEach(group => {
        const triggers = $$('[data-tab]', group);
        const panels = $$('[data-tab-panel]', group);
        if (!triggers.length) return;
        triggers.forEach(t => {
          t.addEventListener('click', () => {
            const key = t.dataset.tab;
            triggers.forEach(x => {
              const on = x === t;
              x.classList.toggle('is-active', on);
              x.setAttribute('aria-selected', String(on));
            });
            panels.forEach(p => {
              p.classList.toggle('is-active', p.dataset.tabPanel === key);
            });
          });
        });
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     16. ACORDEONES
     ═══════════════════════════════════════════════════════════ */

  const Accordions = (() => {
    function init() {
      $$('[data-accordion]').forEach(group => {
        const items = $$('[data-accordion-item]', group);
        const single = group.dataset.accordion === 'single';
        items.forEach(item => {
          const trigger = item.querySelector('[data-accordion-trigger]');
          if (!trigger) return;
          trigger.addEventListener('click', () => {
            const isOpen = item.classList.contains('is-open');
            if (single) {
              items.forEach(i => i.classList.remove('is-open'));
            }
            item.classList.toggle('is-open', !isOpen);
          });
        });
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     17. LAZY LOAD DE IMÁGENES
     ═══════════════════════════════════════════════════════════ */

  const LazyImages = (() => {
    function init() {
      const imgs = $$('img[data-src], img[loading="lazy"]');
      if (!imgs.length) return;

      if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver((entries) => {
          entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            const img = entry.target;
            if (img.dataset.src) {
              img.src = img.dataset.src;
              delete img.dataset.src;
            }
            img.classList.add('is-loaded');
            io.unobserve(img);
          });
        }, { rootMargin: '200px' });
        imgs.forEach(img => io.observe(img));
      } else {
        imgs.forEach(img => {
          if (img.dataset.src) img.src = img.dataset.src;
        });
      }
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     18. COPIAR BLOQUES DE CÓDIGO
     ═══════════════════════════════════════════════════════════ */

  const CopyCode = (() => {
    async function copy(text) {
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          return true;
        }
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch { return false; }
    }

    function init() {
      $$('pre > code').forEach(code => {
        const pre = code.parentElement;
        if (pre.querySelector('.copy-code-btn')) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'copy-code-btn';
        btn.textContent = 'Copiar';
        btn.addEventListener('click', async () => {
          const ok = await copy(code.textContent);
          btn.textContent = ok ? '✓ Copiado' : 'Falló';
          setTimeout(() => { btn.textContent = 'Copiar'; }, 1600);
        });
        pre.style.position = 'relative';
        pre.appendChild(btn);
      });
    }
    return { init, copy };
  })();

  /* ═══════════════════════════════════════════════════════════
     19. ANCHOR LINKS AUTOMÁTICOS
     ═══════════════════════════════════════════════════════════ */

  const AnchorLinks = (() => {
    function init() {
      $$('h2[id], h3[id], h4[id]').forEach(h => {
        if (h.querySelector('.anchor-link')) return;
        const a = document.createElement('a');
        a.href = '#' + h.id;
        a.className = 'anchor-link';
        a.setAttribute('aria-label', 'Copiar enlace a esta sección');
        a.textContent = '#';
        a.addEventListener('click', async (e) => {
          e.preventDefault();
          const url = location.origin + location.pathname + '#' + h.id;
          const ok = await CopyCode.copy(url);
          Toasts.show(ok ? 'Enlace copiado' : 'No se pudo copiar', ok ? 'ok' : 'err');
        });
        h.appendChild(a);
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     20. LINKS EXTERNOS → NUEVA PESTAÑA
     ═══════════════════════════════════════════════════════════ */

  const ExternalLinks = (() => {
    function init() {
      const host = location.hostname;
      $$('a[href^="http"]').forEach(a => {
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

  /* ═══════════════════════════════════════════════════════════
     21. PERSISTENCIA DE FORMULARIOS
     ═══════════════════════════════════════════════════════════ */

  const FormPersistence = (() => {
    function init() {
      const forms = $$('form[data-persist], form input, form textarea');
      if (!forms.length) return;
      const saved = Store.read(CFG.formsKey, {}) || {};

      const formElements = new Set();
      $$('form input, form textarea, form select').forEach(el => {
        if (el.type === 'password' || el.type === 'hidden') return;
        const form = el.closest('form');
        if (!form) return;
        formElements.add(form);
      });

      formElements.forEach(form => {
        const key = form.id || form.getAttribute('name') || 'form-' + slugify(form.action);
        const inputs = $$('input, textarea, select', form);

        inputs.forEach(input => {
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

  /* ═══════════════════════════════════════════════════════════
     22. ATAJOS DE TECLADO GLOBALES
     ═══════════════════════════════════════════════════════════ */

  const Keyboard = (() => {
    function init() {
      document.addEventListener('keydown', (e) => {
        const mod = e.ctrlKey || e.metaKey;
        const tag = (e.target.tagName || '').toLowerCase();
        const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;

        // Ctrl+Shift+D → toggle debug
        if (mod && e.shiftKey && e.key.toLowerCase() === 'd') {
          e.preventDefault();
          CFG.debug = !CFG.debug;
          Toasts.show('Debug: ' + (CFG.debug ? 'ON' : 'OFF'), 'info');
          return;
        }

        // Ctrl+Shift+K → paleta de comandos
        if (mod && e.shiftKey && e.key.toLowerCase() === 'k') {
          e.preventDefault();
          CommandPalette.open();
          return;
        }

        // ? → mostrar atajos (solo si no está escribiendo)
        if (e.key === '?' && !typing) {
          e.preventDefault();
          Help.show();
          return;
        }

        // Escape → cerrar modales / menús
        if (e.key === 'Escape') {
          Modal.closeAll();
          const menu = $('[data-menu].is-open');
          if (menu) menu.classList.remove('is-open');
          return;
        }

        // g + h → home, g + c → contacto, g + n → chat
        if (!typing && !mod && e.key === 'g') {
          const handler = (e2) => {
            if (e2.key === 'h') location.href = '/index.html';
            if (e2.key === 'c') location.href = '/contacto.html';
            if (e2.key === 'n') location.href = '/chat.html';
            if (e2.key === 's') location.href = '/nosotros.html';
            document.removeEventListener('keydown', handler);
          };
          document.addEventListener('keydown', handler, { once: true });
        }
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     23. PALETA DE COMANDOS
     ═══════════════════════════════════════════════════════════ */

  const CommandPalette = (() => {
    const commands = [
      { label: 'Ir a inicio', shortcut: 'g h', action: () => location.href = '/index.html' },
      { label: 'Ir a chat', shortcut: 'g n', action: () => location.href = '/chat.html' },
      { label: 'Ir a contacto', shortcut: 'g c', action: () => location.href = '/contacto.html' },
      { label: 'Cambiar tema', action: () => Theme.cycle() },
      { label: 'Volver arriba', action: () => window.scrollTo({ top: 0, behavior: 'smooth' }) },
      { label: 'Copiar URL', action: async () => {
        const ok = await CopyCode.copy(location.href);
        Toasts.show(ok ? 'Copiado' : 'Falló', ok ? 'ok' : 'err');
      }},
      { label: 'Ver atajos', action: () => Help.show() },
      { label: 'Limpiar almacenamiento', action: async () => {
        const ok = await Modal.confirm('¿Borrar todos los datos guardados del sitio?');
        if (ok) {
          Object.keys(localStorage).forEach(k => {
            if (k.startsWith('numination-')) localStorage.removeItem(k);
          });
          Toasts.ok('Almacenamiento limpio.');
        }
      }},
      { label: 'Confeti 🎉', action: () => Confetti.burst() },
    ];

    let backdrop = null;

    function open() {
      if (backdrop) return;
      backdrop = document.createElement('div');
      backdrop.className = 'cmd-backdrop';
      backdrop.innerHTML = `
        <div class="cmd">
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
        filtered = q ? commands.filter(c => c.label.toLowerCase().includes(q)) : commands.slice();
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

    return { open, close };
  })();

  /* ═══════════════════════════════════════════════════════════
     24. AYUDA / ATAJOS
     ═══════════════════════════════════════════════════════════ */

  const Help = (() => {
    const rows = [
      ['Ctrl + Shift + K', 'Paleta de comandos'],
      ['Ctrl + Shift + D', 'Modo debug'],
      ['g + h', 'Ir a inicio'],
      ['g + n', 'Ir a chat'],
      ['g + c', 'Ir a contacto'],
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

  /* ═══════════════════════════════════════════════════════════
     25. MARQUEE INFINITO
     ═══════════════════════════════════════════════════════════ */

  const Marquee = (() => {
    function init() {
      $$('[data-marquee]').forEach(el => {
        if (el.dataset.marqueeReady) return;
        el.dataset.marqueeReady = '1';
        const content = el.innerHTML;
        el.innerHTML = '';
        const track = document.createElement('div');
        track.className = 'marquee__track';
        for (let i = 0; i < 3; i++) {
          const clone = document.createElement('div');
          clone.className = 'marquee__chunk';
          clone.innerHTML = content;
          track.appendChild(clone);
        }
        el.appendChild(track);
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     26. TEXT TYPING
     ═══════════════════════════════════════════════════════════ */

  const TextTyping = (() => {
    async function type(el, text, speed = 40) {
      el.textContent = '';
      for (let i = 0; i < text.length; i++) {
        el.textContent += text[i];
        await wait(speed);
      }
    }
    function init() {
      $$('[data-typing]').forEach(el => {
        const text = el.dataset.typing;
        if (!text) return;
        if (prefersReducedMotion()) { el.textContent = text; return; }
        const io = new IntersectionObserver(([e]) => {
          if (!e.isIntersecting) return;
          io.disconnect();
          type(el, text, parseInt(el.dataset.typingSpeed || '40', 10));
        }, { threshold: 0.5 });
        io.observe(el);
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     27. PARALLAX SUAVE
     ═══════════════════════════════════════════════════════════ */

  const Parallax = (() => {
    function init() {
      if (prefersReducedMotion()) return;
      const els = $$('[data-parallax]');
      if (!els.length) return;

      const onScroll = throttle(() => {
        const y = window.scrollY;
        els.forEach(el => {
          const speed = parseFloat(el.dataset.parallax) || 0.2;
          el.style.transform = `translate3d(0, ${y * speed * -1}px, 0)`;
        });
      }, 16);

      window.addEventListener('scroll', onScroll, { passive: true });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     28. CONFETTI
     ═══════════════════════════════════════════════════════════ */

  const Confetti = (() => {
    function burst(count = 80) {
      if (prefersReducedMotion()) return;
      const canvas = document.createElement('canvas');
      canvas.className = 'confetti-canvas';
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      document.body.appendChild(canvas);
      const ctx = canvas.getContext('2d');

      const colors = ['#7c93d4', '#1a1a2e', '#FFCD00', '#10b981', '#f97316'];
      const parts = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: -20 - Math.random() * 200,
        vx: (Math.random() - 0.5) * 4,
        vy: 2 + Math.random() * 4,
        r: 3 + Math.random() * 5,
        color: colors[Math.floor(Math.random() * colors.length)],
        angle: Math.random() * Math.PI,
        va: (Math.random() - 0.5) * 0.2,
      }));

      let frames = 0;
      const tick = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        parts.forEach(p => {
          p.x += p.vx; p.y += p.vy;
          p.vy += 0.08;
          p.angle += p.va;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.angle);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.r, -p.r, p.r * 2, p.r * 0.8);
          ctx.restore();
        });
        frames++;
        if (frames < 180) raf(tick);
        else canvas.remove();
      };
      raf(tick);
    }
    return { burst };
  })();

  /* ═══════════════════════════════════════════════════════════
     29. KONAMI CODE → CONFETTI
     ═══════════════════════════════════════════════════════════ */

  const Konami = (() => {
    function init() {
      let i = 0;
      document.addEventListener('keydown', (e) => {
        if (e.key === CFG.konamiSequence[i] ||
            e.key.toLowerCase() === CFG.konamiSequence[i]) {
          i++;
          if (i === CFG.konamiSequence.length) {
            i = 0;
            Confetti.burst(180);
            Toasts.ok('¡Código Konami activado! 🎉');
            console.log('%c🥳 Konami code!', 'font-size:20px;color:#7c93d4');
          }
        } else {
          i = 0;
        }
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     30. BOTONES DE COMPARTIR
     ═══════════════════════════════════════════════════════════ */

  const Share = (() => {
    function init() {
      $$('[data-share]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const network = btn.dataset.share;
          const url = encodeURIComponent(location.href);
          const title = encodeURIComponent(document.title);
          let target = '';

          if (network === 'native' && navigator.share) {
            try {
              await navigator.share({ url: location.href, title: document.title });
              return;
            } catch {}
          }
          if (network === 'twitter' || network === 'x') {
            target = `https://twitter.com/intent/tweet?url=${url}&text=${title}`;
          } else if (network === 'facebook') {
            target = `https://www.facebook.com/sharer/sharer.php?u=${url}`;
          } else if (network === 'linkedin') {
            target = `https://www.linkedin.com/sharing/share-offsite/?url=${url}`;
          } else if (network === 'whatsapp') {
            target = `https://wa.me/?text=${title}%20${url}`;
          } else if (network === 'copy') {
            const ok = await CopyCode.copy(location.href);
            Toasts.show(ok ? 'Enlace copiado' : 'No se pudo copiar', ok ? 'ok' : 'err');
            return;
          } else if (network === 'email') {
            target = `mailto:?subject=${title}&body=${url}`;
          }

          if (target) window.open(target, '_blank', 'noopener,noreferrer');
        });
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     31. HANDLER DE IMPRESIÓN
     ═══════════════════════════════════════════════════════════ */

  const PrintHandler = (() => {
    function init() {
      $$('[data-print]').forEach(btn => {
        btn.addEventListener('click', () => window.print());
      });
      window.addEventListener('beforeprint', () => document.body.classList.add('is-printing'));
      window.addEventListener('afterprint', () => document.body.classList.remove('is-printing'));
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     32. REPORTAR BUG / FEEDBACK
     ═══════════════════════════════════════════════════════════ */

  const Feedback = (() => {
    function init() {
      $$('[data-feedback]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const kind = btn.dataset.feedback;
          if (kind === 'bug') {
            const msg = await Modal.prompt('Describe el problema que encontraste:');
            if (msg) {
              Toasts.ok('Gracias, lo revisaremos.');
              console.log('[bug]', msg);
            }
          } else {
            const msg = await Modal.prompt('¿Qué te pareció?');
            if (msg) Toasts.ok('¡Gracias por tu opinión!');
          }
        });
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     33. VISOR DE IMÁGENES (lightbox)
     ═══════════════════════════════════════════════════════════ */

  const ImageZoom = (() => {
    function init() {
      document.addEventListener('click', (e) => {
        const img = e.target.closest('[data-zoom], .prose img, .content img');
        if (!img) return;
        if (img.dataset.noZoom !== undefined) return;
        const back = document.createElement('div');
        back.className = 'zoom-backdrop';
        back.innerHTML = `<img src="${img.src}" alt="${img.alt || ''}" />`;
        back.addEventListener('click', () => back.remove());
        document.body.appendChild(back);
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') $$('.zoom-backdrop').forEach(b => b.remove());
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     34. WEB VITALS LIGERO
     ═══════════════════════════════════════════════════════════ */

  const WebVitals = (() => {
    function report(name, value) {
      log('vital:', name, value);
      try {
        if (navigator.sendBeacon) {
          // No enviamos a ningún lado, pero dejamos el hook.
        }
      } catch {}
    }

    function init() {
      // LCP
      try {
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          const last = entries[entries.length - 1];
          report('LCP', Math.round(last.startTime));
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {}

      // CLS
      try {
        let cls = 0;
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (!entry.hadRecentInput) cls += entry.value;
          }
          report('CLS', cls.toFixed(4));
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}

      // FID
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) report('FID', Math.round(entry.processingStart - entry.startTime));
        }).observe({ type: 'first-input', buffered: true });
      } catch {}

      // Navigation timing
      window.addEventListener('load', () => {
        setTimeout(() => {
          const nav = performance.getEntriesByType('navigation')[0];
          if (nav) {
            report('TTFB', Math.round(nav.responseStart));
            report('DOMContentLoaded', Math.round(nav.domContentLoadedEventEnd));
            report('Load', Math.round(nav.loadEventEnd));
          }
        }, 0);
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     35. ANALYTICS SIMPLE
     ═══════════════════════════════════════════════════════════ */

  const Analytics = (() => {
    const events = [];

    function track(name, payload = {}) {
      const evt = { name, payload, ts: Date.now(), url: location.pathname };
      events.push(evt);
      if (events.length > 100) events.shift();
      log('analytics:', name, payload);
    }

    function init() {
      // Click tracking en CTAs
      document.addEventListener('click', (e) => {
        const cta = e.target.closest('[data-track]');
        if (cta) track(cta.dataset.track, { href: cta.getAttribute('href') });
      });

      // Page view
      track('pageview', { title: document.title });
    }

    return { init, track, events };
  })();

  /* ═══════════════════════════════════════════════════════════
     36. IDLE DETECTION
     ═══════════════════════════════════════════════════════════ */

  const Idle = (() => {
    let timer = null;
    let isIdle = false;
    const listeners = [];

    function onIdleChange(fn) { listeners.push(fn); }

    function reset() {
      clearTimeout(timer);
      if (isIdle) { isIdle = false; listeners.forEach(fn => fn(false)); }
      timer = setTimeout(() => {
        isIdle = true;
        listeners.forEach(fn => fn(true));
      }, CFG.idleTimeout);
    }

    function init() {
      ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(ev =>
        document.addEventListener(ev, reset, { passive: true }));
      reset();
    }
    return { init, onIdleChange, isIdle: () => isIdle };
  })();

  /* ═══════════════════════════════════════════════════════════
     37. VISIBILITY CHANGE
     ═══════════════════════════════════════════════════════════ */

  const Visibility = (() => {
    const listeners = [];
    function onChange(fn) { listeners.push(fn); }
    function init() {
      document.addEventListener('visibilitychange', () => {
        listeners.forEach(fn => fn(!document.hidden));
      });
    }
    return { init, onChange };
  })();

  /* ═══════════════════════════════════════════════════════════
     38. BEFOREUNLOAD GUARD
     ═══════════════════════════════════════════════════════════ */

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
    return { init, arm, disarm };
  })();

  /* ═══════════════════════════════════════════════════════════
     39. ONLINE / OFFLINE
     ═══════════════════════════════════════════════════════════ */

  const Network = (() => {
    function init() {
      const update = () => {
        document.body.classList.toggle('is-offline', !navigator.onLine);
      };
      window.addEventListener('online', () => { update(); Toasts.ok('Conexión restaurada.'); });
      window.addEventListener('offline', () => { update(); Toasts.warn('Sin conexión.'); });
      update();
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     40. BOOKMARKS / FAVORITOS
     ═══════════════════════════════════════════════════════════ */

  const Bookmarks = (() => {
    function list() { return Store.read(CFG.bookmarksKey, []) || []; }

    function toggle(url = location.pathname + location.search) {
      const items = list();
      const i = items.findIndex(b => b.url === url);
      if (i >= 0) { items.splice(i, 1); Toasts.info('Quitado de favoritos.'); }
      else { items.unshift({ url, title: document.title, ts: Date.now() }); Toasts.ok('Añadido a favoritos.'); }
      Store.write(CFG.bookmarksKey, items.slice(0, 100));
    }

    function init() {
      $$('[data-bookmark]').forEach(btn => {
        const url = location.pathname + location.search;
        const marked = list().some(b => b.url === url);
        btn.classList.toggle('is-active', marked);
        btn.addEventListener('click', () => {
          toggle(url);
          btn.classList.toggle('is-active');
        });
      });
    }
    return { init, list, toggle };
  })();

  /* ═══════════════════════════════════════════════════════════
     41. RECIÉN VISITADOS
     ═══════════════════════════════════════════════════════════ */

  const RecentlyViewed = (() => {
    function push(url = location.pathname, title = document.title) {
      const items = Store.read(CFG.visitedKey, []) || [];
      const i = items.findIndex(x => x.url === url);
      if (i >= 0) items.splice(i, 1);
      items.unshift({ url, title, ts: Date.now() });
      Store.write(CFG.visitedKey, items.slice(0, 20));
    }

    function init() {
      push();
    }
    return { init, push, list: () => Store.read(CFG.visitedKey, []) };
  })();

  /* ═══════════════════════════════════════════════════════════
     42. URL PARAMS
     ═══════════════════════════════════════════════════════════ */

  const UrlParams = (() => {
    const params = new URLSearchParams(location.search);
    return {
      get: (k, fallback = null) => params.get(k) ?? fallback,
      has: (k) => params.has(k),
      all: () => Object.fromEntries(params.entries()),
    };
  })();

  /* ═══════════════════════════════════════════════════════════
     43. PWA INSTALL PROMPT
     ═══════════════════════════════════════════════════════════ */

  const PWA = (() => {
    let deferredPrompt = null;

    function init() {
      window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        showInstallButton();
      });
    }

    function showInstallButton() {
      if ($('.pwa-install')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pwa-install';
      btn.textContent = '📲 Instalar app';
      btn.addEventListener('click', async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        const result = await deferredPrompt.userChoice;
        if (result.outcome === 'accepted') Toasts.ok('¡Instalada!');
        deferredPrompt = null;
        btn.remove();
      });
      document.body.appendChild(btn);
    }

    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     44. NOTIFICACIONES DEL NAVEGADOR
     ═══════════════════════════════════════════════════════════ */

  const Notify = (() => {
    async function request() {
      if (!('Notification' in window)) return false;
      if (Notification.permission === 'granted') return true;
      if (Notification.permission === 'denied') return false;
      const result = await Notification.requestPermission();
      return result === 'granted';
    }

    async function send(title, body) {
      if (!('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      new Notification(title, { body, icon: '/favicon.ico' });
    }

    return { request, send };
  })();

  /* ═══════════════════════════════════════════════════════════
     45. CONSOLA — EASTER EGG
     ═══════════════════════════════════════════════════════════ */

  const ConsoleArt = (() => {
    function init() {
      const styles = 'background: linear-gradient(90deg, #1a1a2e, #7c93d4); color: #fff; padding: 8px 14px; border-radius: 8px; font-size: 14px;';
      console.log('%c🇨🇴 Numination v' + CFG.version, styles);
      console.log('%cHecho en Colombia · La IA que habla el idioma de nuestra educación.', 'color:#7c93d4;font-style:italic;');
      console.log('%c¿Curioseando? Escríbenos: hola@numination.co', 'color:#6b6b68;font-size:11px;');
      console.log('%c💡 Tip: prueba el código Konami ↑↑↓↓←→←→BA', 'color:#FFCD00;font-size:11px;');
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     46. SPLASH SCREEN (solo en carga inicial)
     ═══════════════════════════════════════════════════════════ */

  const Splash = (() => {
    function init() {
      if (sessionStorage.getItem('numination-splash-seen')) return;
      sessionStorage.setItem('numination-splash-seen', '1');
      if (prefersReducedMotion()) return;

      const splash = document.createElement('div');
      splash.className = 'nm-splash';
      splash.innerHTML = `
        <div class="nm-splash__inner">
          <div class="nm-splash__logo">N</div>
          <div class="nm-splash__bar"><span></span></div>
        </div>`;
      document.body.appendChild(splash);
      requestAnimationFrame(() => splash.classList.add('is-visible'));

      setTimeout(() => {
        splash.classList.remove('is-visible');
        setTimeout(() => splash.remove(), 500);
      }, 900);
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     47. PREFERS-REDUCED-MOTION LIVE
     ═══════════════════════════════════════════════════════════ */

  const MotionPref = (() => {
    function init() {
      const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
      const apply = () => {
        document.body.classList.toggle('reduced-motion', mq.matches);
      };
      apply();
      mq.addEventListener('change', apply);
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     48. FONT-SIZE GLOBAL
     ═══════════════════════════════════════════════════════════ */

  const FontSize = (() => {
    function apply(size) {
      document.documentElement.style.setProperty('--base-font-size', size + 'px');
      Store.write('numination-font-size', size);
    }
    function bump(delta) {
      const cur = parseInt(Store.read('numination-font-size', 16), 10);
      const next = clamp(cur + delta, 12, 22);
      apply(next);
      Toasts.info('Tamaño: ' + next + 'px');
    }
    function init() {
      const stored = Store.read('numination-font-size', null);
      if (stored) apply(stored);
      $$('[data-font-bump]').forEach(btn => {
        btn.addEventListener('click', () => bump(parseInt(btn.dataset.fontBump, 10)));
      });
    }
    return { init, bump };
  })();

  /* ═══════════════════════════════════════════════════════════
     49. ALTO CONTRASTE
     ═══════════════════════════════════════════════════════════ */

  const HighContrast = (() => {
    function init() {
      const stored = Store.read('numination-contrast', false);
      document.body.classList.toggle('high-contrast', !!stored);
      $$('[data-contrast-toggle]').forEach(btn => {
        btn.addEventListener('click', () => {
          const next = !document.body.classList.contains('high-contrast');
          document.body.classList.toggle('high-contrast', next);
          Store.write('numination-contrast', next);
        });
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     50. AHORRO DE DATOS
     ═══════════════════════════════════════════════════════════ */

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

  /* ═══════════════════════════════════════════════════════════
     51. SERVICE WORKER (stub)
     ═══════════════════════════════════════════════════════════ */

  const ServiceWorker = (() => {
    function init() {
      if (!('serviceWorker' in navigator)) return;
      if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
      // no registramos uno real por ahora, pero dejamos el hook
      log('service worker listo');
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     52. CURSOR GLOW (solo desktop)
     ═══════════════════════════════════════════════════════════ */

  const CursorGlow = (() => {
    function init() {
      if (isTouch() || prefersReducedMotion()) return;
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

  /* ═══════════════════════════════════════════════════════════
     53. TRACKING DE LECTURA POR ARTÍCULO
     ═══════════════════════════════════════════════════════════ */

  const ArticleReading = (() => {
    function init() {
      const article = $('article, [data-article]');
      if (!article) return;
      const key = 'numination-read-' + slugify(document.title);
      const onScroll = throttle(() => {
        const rect = article.getBoundingClientRect();
        const total = rect.height - window.innerHeight;
        const progress = total > 0 ? clamp(-rect.top / total, 0, 1) : 1;
        Store.write(key, { progress, ts: Date.now() });
        if (progress > 0.9) {
          document.body.classList.add('article-read');
        }
      }, 200);
      window.addEventListener('scroll', onScroll, { passive: true });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     54. HERRAMIENTA DE TIEMPO DE LECTURA
     ═══════════════════════════════════════════════════════════ */

  const ReadingTime = (() => {
    function init() {
      const el = $('[data-reading-time]');
      if (!el) return;
      const article = $('article, [data-article]') || document.body;
      const words = (article.innerText || '').trim().split(/\s+/).length;
      const minutes = Math.max(1, Math.round(words / 200));
      el.textContent = `${minutes} min de lectura`;
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     55. GUARD: FORMULARIOS SIN GUARDAR
     ═══════════════════════════════════════════════════════════ */

  const FormGuard = (() => {
    function init() {
      const forms = $$('form[data-guard]');
      if (!forms.length) return;
      let dirty = false;
      forms.forEach(form => {
        form.addEventListener('input', () => {
          dirty = true;
          Unload.arm();
        });
        form.addEventListener('submit', () => {
          dirty = false;
          Unload.disarm();
        });
        form.addEventListener('reset', () => {
          dirty = false;
          Unload.disarm();
        });
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     56. DETECCIÓN DE IDIOMA
     ═══════════════════════════════════════════════════════════ */

  const Language = (() => {
    function init() {
      const lang = navigator.language || 'es-CO';
      document.documentElement.lang = lang.startsWith('es') ? 'es-CO' : lang;
      log('idioma:', lang);
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     57. SCROLL DIRECTION
     ═══════════════════════════════════════════════════════════ */

  const ScrollDirection = (() => {
    let lastY = 0;
    const listeners = [];

    function on(fn) { listeners.push(fn); }

    function init() {
      const onScroll = throttle(() => {
        const y = window.scrollY;
        const dir = y > lastY ? 'down' : 'up';
        if (Math.abs(y - lastY) > 10) {
          listeners.forEach(fn => fn(dir, y));
          document.body.dataset.scrollDir = dir;
          lastY = y;
        }
      }, 80);
      window.addEventListener('scroll', onScroll, { passive: true });
    }

    return { init, on };
  })();

  /* ═══════════════════════════════════════════════════════════
     58. AUTO-HIDE HEADER EN SCROLL DOWN
     ═══════════════════════════════════════════════════════════ */

  const HeaderAutoHide = (() => {
    function init() {
      const header = $('.site-header, header.site-header, [data-header]');
      if (!header) return;
      ScrollDirection.on((dir, y) => {
        if (y < 120) { header.classList.remove('is-hidden'); return; }
        header.classList.toggle('is-hidden', dir === 'down');
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     59. BOTÓN DE SCROLL DEL HERO
     ═══════════════════════════════════════════════════════════ */

  const HeroScrollCue = (() => {
    function init() {
      const cue = $('[data-scroll-cue]');
      if (!cue) return;
      cue.addEventListener('click', () => {
        const target = cue.dataset.scrollCue;
        const el = target ? document.querySelector(target) : null;
        const top = el ? el.getBoundingClientRect().top + window.scrollY - 60 : window.innerHeight;
        window.scrollTo({ top, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     60. CONTADOR DE VISITAS LOCAL
     ═══════════════════════════════════════════════════════════ */

  const LocalVisits = (() => {
    function init() {
      const key = 'numination-visits';
      const visits = (Store.read(key, 0) || 0) + 1;
      Store.write(key, visits);
      log('visitas locales:', visits);
      $$('[data-visits]').forEach(el => { el.textContent = visits; });
    }
    return { init };
  })();

  /* ═══════════════════════════════════════════════════════════
     61. BOOT — ARRANQUE GLOBAL
     ═══════════════════════════════════════════════════════════ */

  function boot() {
    log('Numination v' + CFG.version);

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
    Tabs.init();
    Accordions.init();
    LazyImages.init();
    CopyCode.init();
    AnchorLinks.init();
    ExternalLinks.init();
    FormPersistence.init();
    Keyboard.init();
    Marquee.init();
    TextTyping.init();
    Parallax.init();
    Konami.init();
    Share.init();
    PrintHandler.init();
    Feedback.init();
    ImageZoom.init();
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
    HeaderAutoHide.init();
    HeroScrollCue.init();
    LocalVisits.init();

    // Exponer API pública para debug
    if (CFG.debug) {
      window.__numination = {
        CFG, State: {}, Toasts, Modal, Theme, CommandPalette, Help,
        Confetti, Bookmarks, Analytics, WebVitals, RecentlyViewed,
        CopyCode, UrlParams, Notify,
      };
    }

    log('boot completo');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();