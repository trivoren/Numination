/* ================================================================
   NUMINATION · practica.js v2.0 «Motor»
   Módulo completo del simulacro ICFES.
   ================================================================ */

(() => {
  'use strict';

  /* ══════════════════════════════════════════════════════════════
     1 · CONFIGURACIÓN
     ══════════════════════════════════════════════════════════════ */

  const CFG = {
    version: '2.0.0',
    debug: new URLSearchParams(location.search).has('debug'),

    api: {
      materias: '/api/questions/materias',
      random: '/api/questions/random',
      simulacro: '/api/questions/simulacro',
      check: '/api/questions/check',
      auth: '/api/auth/me',
    },

    storage: {
      history: 'numination-practice-history',
      stats: 'numination-practice-stats',
      prefs: 'numination-practice-prefs',
    },

    icfesMax: 500,
    toastDuration: 3000,
    confettiParticles: 100,
  };

  const MATERIAS_META = {
    matematicas:          { nombre: 'Matemáticas',           icono: '🧮', color: '#3b82f6', soft: 'rgba(59,130,246,.12)' },
    'lectura-critica':    { nombre: 'Lectura Crítica',       icono: '📖', color: '#8b5cf6', soft: 'rgba(139,92,246,.12)' },
    'ciencias-naturales': { nombre: 'Ciencias Naturales',    icono: '🔬', color: '#10b981', soft: 'rgba(16,185,129,.12)' },
    sociales:             { nombre: 'Sociales y Ciudadanas', icono: '🌎', color: '#f59e0b', soft: 'rgba(245,158,11,.12)' },
    ingles:               { nombre: 'Inglés',                icono: '🌐', color: '#ec4899', soft: 'rgba(236,72,153,.12)' },
  };

  /* ══════════════════════════════════════════════════════════════
     2 · UTILIDADES
     ══════════════════════════════════════════════════════════════ */

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const nowMs = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = (fn) => requestAnimationFrame(fn);
  const clamp = (n, min, max) => Math.min(Math.max(n, min), max);
  const lerp = (a, b, t) => a + (b - a) * t;
  const uid = (p = 'x') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

  const log = (...a) => { if (CFG.debug) console.log('%c[practica]', 'color:#7c93d4;font-weight:bold', ...a); };
  const warn = (...a) => console.warn('[practica]', ...a);
  const err = (...a) => console.error('[practica]', ...a);

  const escapeHtml = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  const fmtTime = (seconds) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
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
    return new Date(ts).toLocaleDateString('es-CO');
  };

  const dayKey = (ts = nowMs()) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  /* ══════════════════════════════════════════════════════════════
     3 · STORAGE
     ══════════════════════════════════════════════════════════════ */

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
      catch { return false; }
    },
  };

  const Prefs = {
    defaults: { sound: true, instantFeedback: true, dark: false, compact: false },
    all() { return { ...this.defaults, ...(Store.read(CFG.storage.prefs, {}) || {}) }; },
    get(k) { return this.all()[k]; },
    set(k, v) {
      const all = this.all();
      all[k] = v;
      Store.write(CFG.storage.prefs, all);
      Bus.emit('prefs:changed', { key: k, value: v });
      return all;
    },
  };

  /* ══════════════════════════════════════════════════════════════
     4 · EVENT BUS
     ══════════════════════════════════════════════════════════════ */

  const Bus = (() => {
    const listeners = new Map();
    return {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event).add(handler);
        return () => Bus.off(event, handler);
      },
      off(event, handler) {
        const set = listeners.get(event);
        if (set) set.delete(handler);
      },
      emit(event, payload) {
        const set = listeners.get(event);
        if (set) for (const h of [...set]) {
          try { h(payload); } catch (e) { warn('bus', event, e); }
        }
      },
    };
  })();

  /* ══════════════════════════════════════════════════════════════
     5 · TOASTS
     ══════════════════════════════════════════════════════════════ */

  const Toasts = (() => {
    let host = null;
    function ensure() {
      if (host && document.body.contains(host)) return host;
      host = $('.toast-host') || (() => {
        const h = document.createElement('div');
        h.className = 'toast-host';
        h.setAttribute('aria-live', 'polite');
        document.body.appendChild(h);
        return h;
      })();
      return host;
    }
    function show(message, kind = 'info', opts = {}) {
      const h = ensure();
      const el = document.createElement('div');
      el.className = `toast toast--${kind}`;
      const icon = { ok: '✓', warn: '⚠', err: '✕', info: 'ⓘ' }[kind] || '';
      el.innerHTML = icon
        ? `<span class="toast__ico">${icon}</span><span>${escapeHtml(message)}</span>`
        : escapeHtml(message);
      h.appendChild(el);
      raf(() => el.classList.add('is-visible'));
      const ttl = Number(opts.duration ?? CFG.toastDuration);
      let timer = setTimeout(dismiss, ttl);
      function dismiss() {
        clearTimeout(timer);
        el.classList.remove('is-visible');
        setTimeout(() => el.remove(), 260);
      }
      el.addEventListener('click', dismiss);
    }
    return {
      show,
      ok: (m, o) => show(m, 'ok', o),
      warn: (m, o) => show(m, 'warn', o),
      err: (m, o) => show(m, 'err', o),
      info: (m, o) => show(m, 'info', o),
    };
  })();

  /* ══════════════════════════════════════════════════════════════
     6 · MODALES
     ══════════════════════════════════════════════════════════════ */

  const Modal = (() => {
    let current = null;
    let confirmCb = null;

    function close() {
      if (!current) return;
      current.hidden = true;
      current = null;
    }

    function confirm(opts) {
      const back = $('[data-modal="confirm"]');
      if (!back) return;
      const title = back.querySelector('[data-modal-title]');
      const body = back.querySelector('[data-modal-body]');
      if (title) title.textContent = opts.title || 'Confirmar';
      if (body) body.textContent = opts.body || '¿Estás seguro?';
      confirmCb = opts.onConfirm || null;
      back.hidden = false;
      current = back;
    }

    function runConfirm() {
      if (confirmCb) {
        const fn = confirmCb;
        confirmCb = null;
        try { fn(); } catch (e) { err(e); }
      }
      close();
    }

    return { close, confirm, runConfirm };
  })();

  /* ══════════════════════════════════════════════════════════════
     7 · AUDIO
     ══════════════════════════════════════════════════════════════ */

  const Sound = (() => {
    let ctx = null;
    function ensure() {
      if (!ctx) {
        try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
        catch { ctx = null; }
      }
      return ctx;
    }
    function play(freq, duration, type = 'sine', vol = 0.08) {
      if (!Prefs.get('sound')) return;
      const c = ensure();
      if (!c) return;
      try {
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(vol, c.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, c.currentTime + duration);
        osc.connect(gain);
        gain.connect(c.destination);
        osc.start();
        osc.stop(c.currentTime + duration);
      } catch {}
    }
    return {
      correct() { play(660, 0.12); setTimeout(() => play(880, 0.14), 100); },
      wrong() { play(220, 0.18, 'sawtooth', 0.06); },
      click() { play(440, 0.04, 'sine', 0.04); },
      finish() {
        play(523, 0.15);
        setTimeout(() => play(659, 0.15), 130);
        setTimeout(() => play(784, 0.15), 260);
        setTimeout(() => play(1047, 0.3), 390);
      },
    };
  })();

  /* ══════════════════════════════════════════════════════════════
     8 · CONFETTI
     ══════════════════════════════════════════════════════════════ */

  const Confetti = {
    burst(count = CFG.confettiParticles) {
      const canvas = $('[data-confetti]');
      if (!canvas) return;
      canvas.hidden = false;
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      const ctx = canvas.getContext('2d');
      const colors = ['#7c93d4', '#1a1a2e', '#FFCD00', '#10b981', '#f97316', '#ec4899'];

      const particles = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: -20 - Math.random() * 300,
        vx: (Math.random() - 0.5) * 5,
        vy: 2 + Math.random() * 5,
        r: 4 + Math.random() * 6,
        color: colors[Math.floor(Math.random() * colors.length)],
        angle: Math.random() * Math.PI,
        va: (Math.random() - 0.5) * 0.25,
      }));

      let frames = 0;
      const maxFrames = 220;

      function tick() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (const p of particles) {
          p.x += p.vx;
          p.y += p.vy;
          p.vy += 0.1;
          p.angle += p.va;
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.angle);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.r, -p.r, p.r * 2, p.r * 0.85);
          ctx.restore();
        }
        frames++;
        if (frames < maxFrames) raf(tick);
        else {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          canvas.hidden = true;
        }
      }
      raf(tick);
    },
  };

  /* ══════════════════════════════════════════════════════════════
     9 · LOADING
     ══════════════════════════════════════════════════════════════ */

  const Loading = {
    show(text = 'Cargando...') {
      const el = $('[data-loading]');
      if (!el) return;
      const txt = $('[data-loading-text]');
      if (txt) txt.textContent = text;
      el.hidden = false;
      el.style.display = 'flex';
    },
    hide() {
      const el = $('[data-loading]');
      if (!el) return;
      el.hidden = true;
      el.style.display = 'none';
    },
  };

  /* ══════════════════════════════════════════════════════════════
     10 · API
     ══════════════════════════════════════════════════════════════ */

  const API = {
    async fetch(url, opts = {}) {
      const res = await fetch(url, { credentials: 'include', ...opts });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    },
    async getMaterias() {
      return API.fetch(CFG.api.materias);
    },
    async getSimulacro(cantidad = 10, areas = null) {
      let url = `${CFG.api.simulacro}?cantidad=${cantidad}`;
      if (areas?.length) url += `&areas=${areas.join(',')}`;
      return API.fetch(url);
    },
    async check(id, respuesta) {
      const res = await fetch(CFG.api.check, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ id, respuesta }),
      });
      return res.json();
    },
    async me() {
      try { return await API.fetch(CFG.api.auth); }
      catch { return { ok: false, user: null }; }
    },
  };

  /* ══════════════════════════════════════════════════════════════
     11 · STATE
     ══════════════════════════════════════════════════════════════ */

  const State = {
    user: null,
    screen: null,
    materias: [],
    history: [],
    config: {
      materia: null,
      materiaNombre: null,
      count: 10,
      difficulty: 'easy',
      mode: 'practice',
      timePerQ: 1.5,
    },
    exam: {
      questions: [],
      answers: {},
      current: 0,
      flagged: new Set(),
      startTime: null,
      endTime: null,
      timeLimit: 0,
      timeLeft: 0,
      timerId: null,
      finished: false,
      isSimulacro: false,
    },
    stats: { totalAnswered: 0, totalCorrect: 0, streak: 0, lastStreakDay: null },
  };

  /* ══════════════════════════════════════════════════════════════
     12 · HISTORIAL Y STATS
     ══════════════════════════════════════════════════════════════ */

  const History = {
    load() {
      State.history = Store.read(CFG.storage.history, []) || [];
      return State.history;
    },
    save(session) {
      const list = Store.read(CFG.storage.history, []) || [];
      list.unshift(session);
      Store.write(CFG.storage.history, list.slice(0, 100));
      State.history = list.slice(0, 100);
      Bus.emit('history:updated');
    },
    clear() {
      Store.write(CFG.storage.history, []);
      State.history = [];
      Bus.emit('history:updated');
    },
  };

  const Stats = {
    load() {
      const saved = Store.read(CFG.storage.stats, null);
      if (saved) State.stats = { ...State.stats, ...saved };
      const today = dayKey();
      const last = State.stats.lastStreakDay;
      if (last && last !== today) {
        const diffDays = Math.floor((new Date(today) - new Date(last)) / 86400000);
        if (diffDays > 1) {
          State.stats.streak = 0;
          Stats.save();
        }
      }
      return State.stats;
    },
    save() { Store.write(CFG.storage.stats, State.stats); },
    addAnswer(correct) {
      State.stats.totalAnswered++;
      if (correct) State.stats.totalCorrect++;
      Stats.save();
      Bus.emit('stats:updated');
    },
    accuracy() {
      if (!State.stats.totalAnswered) return 0;
      return State.stats.totalCorrect / State.stats.totalAnswered;
    },
    registerSession() {
      const today = dayKey();
      const last = State.stats.lastStreakDay;
      if (last === today) return;
      if (last) {
        const diffDays = Math.floor((new Date(today) - new Date(last)) / 86400000);
        if (diffDays === 1) State.stats.streak++;
        else if (diffDays > 1) State.stats.streak = 1;
      } else {
        State.stats.streak = 1;
      }
      State.stats.lastStreakDay = today;
      Stats.save();
      Bus.emit('stats:updated');
    },
  };

  /* ══════════════════════════════════════════════════════════════
     13 · ROUTER
     ══════════════════════════════════════════════════════════════ */

  const Router = {
    go(screen) {
      if (State.screen === screen) return;
      if (State.screen === 'exam' && !State.exam.finished && screen !== 'results') {
        Modal.confirm({
          title: '¿Salir de la práctica?',
          body: 'Vas a perder las respuestas de esta sesión. ¿Seguro?',
          onConfirm: () => Router.forceGo(screen),
        });
        return;
      }
      Router.forceGo(screen);
    },
    forceGo(screen) {
      if (State.screen === 'exam' && screen !== 'exam') Exam.stopTimer();
      State.screen = screen;
      $$('.screen').forEach((el) => {
        el.classList.toggle('is-active', el.dataset.screen === screen);
      });
      const titles = {
        home: 'Práctica ICFES',
        config: 'Configurar práctica',
        exam: 'Práctica en curso',
        results: 'Resultados',
        history: 'Historial',
        settings: 'Configuración',
      };
      document.title = `${titles[screen] || 'Práctica'} · Numination`;
      const host = $('[data-screen-host]');
      if (host) host.scrollTop = 0;
      Sidebar.close();
      Bus.emit('screen:changed', { screen });
      log('router →', screen);
    },
  };

  /* ══════════════════════════════════════════════════════════════
     14 · SIDEBAR
     ══════════════════════════════════════════════════════════════ */

  const Sidebar = {
    open() {
      $('[data-sidebar]')?.classList.add('is-open');
      $('[data-sidebar-overlay]')?.classList.add('is-open');
    },
    close() {
      $('[data-sidebar]')?.classList.remove('is-open');
      $('[data-sidebar-overlay]')?.classList.remove('is-open');
    },
    init() {
      $('[data-sidebar-open]')?.addEventListener('click', Sidebar.open);
      $('[data-sidebar-close]')?.addEventListener('click', Sidebar.close);
      $('[data-sidebar-overlay]')?.addEventListener('click', Sidebar.close);
    },
  };

  const SidebarStats = {
    render() {
      const streak = $('[data-streak]');
      const total = $('[data-total-answered]');
      const acc = $('[data-accuracy]');
      const name = $('[data-user-name]');
      if (streak) streak.textContent = String(State.stats.streak);
      if (total) total.textContent = String(State.stats.totalAnswered);
      if (acc) {
        acc.textContent = State.stats.totalAnswered
          ? `${Math.round((State.stats.totalCorrect / State.stats.totalAnswered) * 100)}%`
          : '—';
      }
      if (name && State.user) name.textContent = State.user.name || State.user.email;
    },
  };

  /* ══════════════════════════════════════════════════════════════
     15 · MATERIAS
     ══════════════════════════════════════════════════════════════ */

  const Materias = {
    async load() {
      try {
        Loading.show('Cargando materias...');
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const res = await fetch(CFG.api.materias, {
          credentials: 'include',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        State.materias = data.materias || [];
        Materias.render();
        log('materias:', State.materias.length);
      } catch (e) {
        err('materias', e);
        Toasts.err('No se pudieron cargar las materias.');
      } finally {
        Loading.hide();
      }
    },

    render() {
      const grid = $('[data-materia-grid]');
      if (!grid) return;
      grid.innerHTML = '';

      for (const m of State.materias) {
        const meta = MATERIAS_META[m.slug] || {
          nombre: m.nombre,
          icono: '📚',
          color: '#7c93d4',
          soft: 'rgba(124,147,212,.12)',
        };

        const card = document.createElement('button');
        card.type = 'button';
        card.className = 'materia-card';
        card.style.setProperty('--materia-color', meta.color);
        card.style.setProperty('--materia-soft', meta.soft);
        card.dataset.materia = m.slug;

        card.innerHTML = `
          <div class="materia-card__icon">${meta.icono}</div>
          <div class="materia-card__title">${escapeHtml(m.nombre)}</div>
          <div class="materia-card__meta">
            <span>📝 ${m.total} preguntas</span>
            <svg class="materia-card__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
            </svg>
          </div>
        `;

        card.addEventListener('click', () => {
          Sound.click();
          Config.openFor(m.slug, m.nombre);
        });

        grid.appendChild(card);
      }
    },
  };

  /* ══════════════════════════════════════════════════════════════
     16 · CONFIGURACIÓN
     ══════════════════════════════════════════════════════════════ */

  const Config = {
    openFor(slug, nombre) {
      State.config.materia = slug;
      State.config.materiaNombre = nombre;
      State.config.count = 10;
      State.config.difficulty = 'easy';
      State.config.mode = 'practice';
      State.config.timePerQ = 1.5;
      const title = $('[data-config-title]');
      const eyebrow = $('[data-config-eyebrow]');
      if (title) title.textContent = `Prepara tu práctica de ${nombre}`;
      if (eyebrow) eyebrow.textContent = 'Configuración';
      Config.syncChips();
      Config.updateSummary();
      Router.go('config');
    },

    openSimulacro() {
      State.config.materia = null;
      State.config.materiaNombre = 'Simulacro completo';
      State.config.count = 10;
      State.config.difficulty = 'all';
      State.config.mode = 'exam';
      State.config.timePerQ = 1.5;
      const title = $('[data-config-title]');
      const eyebrow = $('[data-config-eyebrow]');
      if (title) title.textContent = 'Simulacro completo ICFES';
      if (eyebrow) eyebrow.textContent = 'Todas las materias';
      Config.syncChips();
      Config.updateSummary();
      Router.go('config');
    },

    syncChips() {
      $$('[data-chip-group="count"] .chip').forEach((c) => {
        c.classList.toggle('is-active', parseInt(c.dataset.value, 10) === State.config.count);
      });
      $$('[data-chip-group="difficulty"] .chip').forEach((c) => {
        c.classList.toggle('is-active', c.dataset.value === State.config.difficulty);
      });
      $$('[data-chip-group="mode"] .chip').forEach((c) => {
        c.classList.toggle('is-active', c.dataset.value === State.config.mode);
      });
      $$('[data-chip-group="time"] .chip').forEach((c) => {
        c.classList.toggle('is-active', parseFloat(c.dataset.value) === State.config.timePerQ);
      });
    },

    updateSummary() {
      const el = $('[data-config-summary]');
      if (!el) return;
      const totalTime = Math.round(State.config.count * State.config.timePerQ);
      const modoTexto = State.config.mode === 'practice'
        ? 'Práctica (feedback al instante)'
        : 'Simulacro (resultado al final)';
      const materia = State.config.materiaNombre || 'Todas las materias';
      el.innerHTML = `
        <p class="config-summary__text">
          Vas a resolver <strong>${State.config.count} preguntas</strong> de <strong>${escapeHtml(materia)}</strong>
          en modo <strong>${modoTexto}</strong>${State.config.timePerQ > 0 ? `, con un tiempo estimado de <strong>${totalTime} minutos</strong>` : ''}.
        </p>
      `;
    },

    init() {
      $$('[data-chip-group="count"] .chip').forEach((c) => {
        c.addEventListener('click', () => {
          Sound.click();
          State.config.count = parseInt(c.dataset.value, 10);
          Config.syncChips();
          Config.updateSummary();
        });
      });
      $$('[data-chip-group="difficulty"] .chip').forEach((c) => {
        c.addEventListener('click', () => {
          Sound.click();
          State.config.difficulty = c.dataset.value;
          Config.syncChips();
          Config.updateSummary();
        });
      });
      $$('[data-chip-group="mode"] .chip').forEach((c) => {
        c.addEventListener('click', () => {
          Sound.click();
          State.config.mode = c.dataset.value;
          Config.syncChips();
          Config.updateSummary();
        });
      });
      $$('[data-chip-group="time"] .chip').forEach((c) => {
        c.addEventListener('click', () => {
          Sound.click();
          State.config.timePerQ = parseFloat(c.dataset.value);
          Config.syncChips();
          Config.updateSummary();
        });
      });
    },
  };

  /* ══════════════════════════════════════════════════════════════
     17 · EXAMEN
     ══════════════════════════════════════════════════════════════ */

  const Exam = {
    async start() {
      try {
        Loading.show('Preparando preguntas...');
        const areas = State.config.materia ? [State.config.materia] : null;
        const data = await API.getSimulacro(State.config.count, areas);
        const preguntas = data.preguntas || [];

        if (!preguntas.length) {
          Toasts.warn('No hay preguntas disponibles.');
          return;
        }

        State.exam.questions = preguntas;
        State.exam.answers = {};
        State.exam.current = 0;
        State.exam.flagged = new Set();
        State.exam.startTime = nowMs();
        State.exam.endTime = null;
        State.exam.finished = false;
        State.exam.isSimulacro = State.config.mode === 'exam';
        State.exam.timeLimit = Math.round(State.config.count * State.config.timePerQ * 60);
        State.exam.timeLeft = State.exam.timeLimit;

        Router.forceGo('exam');
        Exam.renderNav();
        Exam.renderCurrent();

        if (State.exam.timeLimit > 0) {
          Exam.startTimer();
          const timerWrap = $('[data-exam-timer]');
          if (timerWrap) timerWrap.style.display = '';
        } else {
          const timerWrap = $('[data-exam-timer]');
          if (timerWrap) timerWrap.style.display = 'none';
        }
      } catch (e) {
        err('start', e);
        Toasts.err('No se pudo iniciar la práctica.');
      } finally {
        Loading.hide();
      }
    },

    startTimer() {
      Exam.stopTimer();
      Exam.updateTimerDisplay();
      State.exam.timerId = setInterval(() => {
        State.exam.timeLeft--;
        Exam.updateTimerDisplay();
        if (State.exam.timeLeft <= 0) {
          Exam.stopTimer();
          Exam.finish(true);
        }
      }, 1000);
    },

    stopTimer() {
      if (State.exam.timerId) {
        clearInterval(State.exam.timerId);
        State.exam.timerId = null;
      }
    },

    updateTimerDisplay() {
      const el = $('[data-timer-value]');
      const wrap = $('[data-exam-timer]');
      if (!el) return;
      el.textContent = fmtTime(State.exam.timeLeft);
      if (!wrap) return;
      wrap.classList.remove('is-warning', 'is-danger');
      if (State.exam.timeLeft <= 30) wrap.classList.add('is-danger');
      else if (State.exam.timeLeft <= 60) wrap.classList.add('is-warning');
    },

    currentQuestion() {
      return State.exam.questions[State.exam.current];
    },

    renderCurrent() {
      const q = Exam.currentQuestion();
      if (!q) return;

      const counter = $('[data-exam-counter]');
      if (counter) counter.textContent = `Pregunta ${State.exam.current + 1} de ${State.exam.questions.length}`;

      const progress = ((State.exam.current + 1) / State.exam.questions.length) * 100;
      const bar = $('[data-exam-progress]');
      if (bar) bar.style.width = progress + '%';

      const matEl = $('[data-question-materia]');
      const lvlEl = $('[data-question-level]');
      if (matEl) matEl.textContent = q.materia || 'General';
      if (lvlEl) lvlEl.textContent = `Nivel ${q.nivel_dificultad === 'Alto' ? 3 : q.nivel_dificultad === 'Bajo' ? 1 : 2}`;

      const ctx = $('[data-question-context]');
      if (ctx) {
        if (q.contexto && q.contexto.trim() && q.contexto !== q.enunciado) {
          ctx.innerHTML = escapeHtml(q.contexto).replace(/\n/g, '<br>');
          ctx.style.display = '';
        } else {
          ctx.style.display = 'none';
        }
      }

      const qText = $('[data-question-text]');
      if (qText) qText.textContent = q.enunciado || '';

      Exam.renderOptions(q);

      const prev = State.exam.answers[State.exam.current];
      const fb = $('[data-feedback]');
      if (prev && !State.exam.isSimulacro && fb) {
        Exam.showFeedback(q, prev.letter, prev.correct, q.explicacion);
      } else if (fb) {
        fb.hidden = true;
      }

      const flagBtn = $('[data-action="flag"]');
      if (flagBtn) flagBtn.classList.toggle('is-active', State.exam.flagged.has(State.exam.current));

      const prevBtn = $('[data-action="prev"]');
      if (prevBtn) prevBtn.disabled = State.exam.current === 0;

      const nextBtn = $('[data-action="next"]');
      if (nextBtn) {
        const isLast = State.exam.current === State.exam.questions.length - 1;
        nextBtn.innerHTML = isLast
          ? `<span>Finalizar</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="20 6 9 17 4 12"/></svg>`
          : `<span>Siguiente</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
      }

      Exam.updateNav();
    },

    renderOptions(q) {
      const wrap = $('[data-options]');
      if (!wrap) return;
      wrap.innerHTML = '';

      const prevAnswer = State.exam.answers[State.exam.current];
      const letters = ['A', 'B', 'C', 'D'];

      letters.forEach((letter) => {
        const text = q.opciones?.[letter];
        if (!text) return;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'option';
        btn.dataset.letter = letter;

        btn.innerHTML = `
          <span class="option__letter">${letter}</span>
          <span class="option__text">${escapeHtml(text)}</span>
          <svg class="option__status" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"></svg>
        `;

        if (prevAnswer) {
          btn.disabled = true;
          if (letter === q.respuesta_correcta) {
            btn.classList.add('is-correct');
            const st = btn.querySelector('.option__status');
            if (st) st.innerHTML = '<polyline points="20 6 9 17 4 12"/>';
          } else if (letter === prevAnswer.letter) {
            btn.classList.add('is-wrong');
            const st = btn.querySelector('.option__status');
            if (st) st.innerHTML = '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>';
          }
        } else {
          btn.addEventListener('click', () => Exam.selectOption(letter));
        }

        wrap.appendChild(btn);
      });
    },

    async selectOption(letter) {
      const q = Exam.currentQuestion();
      if (!q) return;

      $$('.option').forEach((el) => el.classList.toggle('is-selected', el.dataset.letter === letter));
      Sound.click();

      let correct = false;
      let explicacion = q.explicacion || 'Sin explicación disponible.';

      try {
        const res = await API.check(q.id, letter);
        if (res.ok) {
          correct = res.correcta;
          explicacion = res.explicacion || explicacion;
        } else {
          correct = letter === q.respuesta_correcta;
        }
      } catch {
        correct = letter === q.respuesta_correcta;
      }

      State.exam.answers[State.exam.current] = { letter, correct };
      Stats.addAnswer(correct);

      if (correct) Sound.correct(); else Sound.wrong();

      if (!State.exam.isSimulacro || Prefs.get('instantFeedback')) {
        Exam.showFeedback(q, letter, correct, explicacion);
      }

      $$('.option').forEach((el) => {
        el.disabled = true;
        if (el.dataset.letter === q.respuesta_correcta) {
          el.classList.add('is-correct');
          const st = el.querySelector('.option__status');
          if (st) st.innerHTML = '<polyline points="20 6 9 17 4 12"/>';
        } else if (el.dataset.letter === letter) {
          el.classList.add('is-wrong');
          const st = el.querySelector('.option__status');
          if (st) st.innerHTML = '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>';
        }
      });

      Exam.updateNav();
    },

    showFeedback(q, letter, correct, explicacion) {
      const fb = $('[data-feedback]');
      if (!fb) return;
      fb.hidden = false;
      fb.classList.toggle('is-correct', correct);
      fb.classList.toggle('is-wrong', !correct);

      const icon = $('[data-feedback-icon]');
      const title = $('[data-feedback-title]');
      const body = $('[data-feedback-body]');
      if (icon) icon.textContent = correct ? '✓' : '✕';
      if (title) title.textContent = correct
        ? '¡Correcto!'
        : `Incorrecto · La respuesta era ${q.respuesta_correcta}`;
      if (body) body.innerHTML = `<p>${escapeHtml(explicacion).replace(/\n/g, '<br>')}</p>`;
    },

    next() {
      if (State.exam.current < State.exam.questions.length - 1) {
        State.exam.current++;
        Exam.renderCurrent();
        Sound.click();
      } else {
        Exam.finish();
      }
    },

    prev() {
      if (State.exam.current > 0) {
        State.exam.current--;
        Exam.renderCurrent();
        Sound.click();
      }
    },

    skip() {
      if (State.exam.current < State.exam.questions.length - 1) {
        State.exam.current++;
        Exam.renderCurrent();
        Sound.click();
      } else {
        Exam.finish();
      }
    },

    toggleFlag() {
      const i = State.exam.current;
      if (State.exam.flagged.has(i)) State.exam.flagged.delete(i);
      else State.exam.flagged.add(i);
      $('[data-action="flag"]')?.classList.toggle('is-active', State.exam.flagged.has(i));
      Exam.updateNav();
    },

    renderNav() {
      const wrap = $('[data-exam-nav]');
      if (!wrap) return;
      wrap.innerHTML = '';

      const title = document.createElement('p');
      title.className = 'exam-nav__title';
      title.textContent = 'Preguntas';
      wrap.appendChild(title);

      const grid = document.createElement('div');
      grid.className = 'exam-nav__grid';

      State.exam.questions.forEach((_, i) => {
        const dot = document.createElement('button');
        dot.type = 'button';
        dot.className = 'nav-dot';
        dot.textContent = String(i + 1);
        dot.dataset.index = i;
        dot.addEventListener('click', () => {
          State.exam.current = i;
          Exam.renderCurrent();
        });
        grid.appendChild(dot);
      });

      wrap.appendChild(grid);

      const legend = document.createElement('div');
      legend.className = 'exam-nav__legend';
      legend.innerHTML = `
        <div class="exam-nav__legend-item"><span class="exam-nav__legend-dot is-current"></span> Actual</div>
        <div class="exam-nav__legend-item"><span class="exam-nav__legend-dot is-answered"></span> Respondida</div>
        <div class="exam-nav__legend-item"><span class="exam-nav__legend-dot is-flagged"></span> Marcada</div>
      `;
      wrap.appendChild(legend);
    },

    updateNav() {
      $$('.nav-dot').forEach((dot, i) => {
        dot.classList.toggle('is-current', i === State.exam.current);
        dot.classList.toggle('is-flagged', State.exam.flagged.has(i));
        const ans = State.exam.answers[i];
        if (ans && !State.exam.isSimulacro) {
          dot.classList.remove('is-answered');
          dot.classList.toggle('is-correct', ans.correct);
          dot.classList.toggle('is-wrong', !ans.correct);
        } else if (ans) {
          dot.classList.add('is-answered');
          dot.classList.remove('is-correct', 'is-wrong');
        } else {
          dot.classList.remove('is-answered', 'is-correct', 'is-wrong');
        }
      });
    },

    finish(byTimeout = false) {
      Exam.stopTimer();
      State.exam.finished = true;
      State.exam.endTime = nowMs();

      for (let i = 0; i < State.exam.questions.length; i++) {
        if (!State.exam.answers[i]) {
          State.exam.answers[i] = { letter: null, correct: false };
        }
      }

      Stats.registerSession();
      const results = Results.calculate();

      History.save({
        id: uid('s'),
        ts: nowMs(),
        materia: State.config.materia,
        materiaNombre: State.config.materiaNombre,
        count: State.exam.questions.length,
        correct: results.correctCount,
        wrong: results.wrongCount,
        score: results.estimatedScore,
        time: results.timeSec,
        isSimulacro: State.exam.isSimulacro,
      });

      Router.forceGo('results');
      Results.render(results);
      Sound.finish();

      if (results.correctCount / State.exam.questions.length >= 0.7) {
        setTimeout(() => Confetti.burst(), 400);
      }
    },
  };

  /* ══════════════════════════════════════════════════════════════
     18 · RESULTADOS
     ══════════════════════════════════════════════════════════════ */

  const Results = {
    calculate() {
      const total = State.exam.questions.length;
      let correctCount = 0;
      let wrongCount = 0;
      const byMateria = {};

      State.exam.questions.forEach((q, i) => {
        const ans = State.exam.answers[i];
        const materia = q.materia || 'General';
        if (!byMateria[materia]) byMateria[materia] = { correct: 0, total: 0 };
        byMateria[materia].total++;
        if (ans?.correct) {
          correctCount++;
          byMateria[materia].correct++;
        } else {
          wrongCount++;
        }
      });

      const accuracy = total ? correctCount / total : 0;
      const estimatedScore = Math.round(accuracy * CFG.icfesMax);
      const timeSec = Math.round((State.exam.endTime - State.exam.startTime) / 1000);

      return { total, correctCount, wrongCount, accuracy, estimatedScore, timeSec, byMateria };
    },

    render(r) {
      const ring = $('[data-result-ring]');
      const circumference = 2 * Math.PI * 52;
      const offset = circumference * (1 - r.accuracy);
      setTimeout(() => {
        if (ring) ring.style.strokeDashoffset = String(offset);
      }, 100);

      Results.animateNumber($('[data-result-score]'), r.estimatedScore, 1400);

      const eyebrow = $('[data-result-eyebrow]');
      const title = $('[data-result-title]');
      const sub = $('[data-result-sub]');

      if (r.accuracy >= 0.9) {
        if (eyebrow) eyebrow.textContent = '¡Excelente!';
        if (title) title.textContent = 'Dominio sobresaliente';
        if (sub) sub.textContent = 'Estás en el nivel más alto. Sigue así.';
      } else if (r.accuracy >= 0.7) {
        if (eyebrow) eyebrow.textContent = 'Buen trabajo';
        if (title) title.textContent = 'Vas por buen camino';
        if (sub) sub.textContent = 'Con un poco más de práctica puedes dominar esta área.';
      } else if (r.accuracy >= 0.5) {
        if (eyebrow) eyebrow.textContent = 'Progreso';
        if (title) title.textContent = 'Hay espacio para mejorar';
        if (sub) sub.textContent = 'Revisa las preguntas que fallaste y vuelve a intentarlo.';
      } else {
        if (eyebrow) eyebrow.textContent = 'A seguir practicando';
        if (title) title.textContent = 'Es momento de reforzar';
        if (sub) sub.textContent = 'No te desanimes. Practica un poco cada día.';
      }

      const cEl = $('[data-result-correct]');
      const wEl = $('[data-result-wrong]');
      const tEl = $('[data-result-time]');
      const aEl = $('[data-result-accuracy]');
      if (cEl) cEl.textContent = String(r.correctCount);
      if (wEl) wEl.textContent = String(r.wrongCount);
      if (tEl) tEl.textContent = fmtTime(r.timeSec);
      if (aEl) aEl.textContent = Math.round(r.accuracy * 100) + '%';

      Results.renderBreakdown(r.byMateria);
      Results.renderReview();
    },

    animateNumber(el, target, duration = 1200) {
      if (!el) return;
      const t0 = performance.now();
      const tick = (now) => {
        const p = clamp((now - t0) / duration, 0, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = String(Math.round(lerp(0, target, eased)));
        if (p < 1) raf(tick);
      };
      raf(tick);
    },

    renderBreakdown(byMateria) {
      const wrap = $('[data-result-breakdown]');
      if (!wrap) return;
      wrap.innerHTML = '';

      const entries = Object.entries(byMateria);
      entries.sort((a, b) => (b[1].correct / b[1].total) - (a[1].correct / a[1].total));

      for (const [nombre, data] of entries) {
        const pct = data.total ? (data.correct / data.total) * 100 : 0;
        const row = document.createElement('div');
        row.className = 'breakdown-row';
        row.innerHTML = `
          <span class="breakdown-row__name">${escapeHtml(nombre)}</span>
          <div class="breakdown-row__bar"><span class="breakdown-row__fill" style="width:0%"></span></div>
          <span class="breakdown-row__value">${data.correct}/${data.total} · ${Math.round(pct)}%</span>
        `;
        wrap.appendChild(row);
        setTimeout(() => {
          const fill = row.querySelector('.breakdown-row__fill');
          if (fill) fill.style.width = pct + '%';
        }, 200);
      }
    },

    renderReview() {
      const wrap = $('[data-review-list]');
      if (!wrap) return;
      wrap.innerHTML = '';

      State.exam.questions.forEach((q, i) => {
        const ans = State.exam.answers[i];
        const correct = ans?.correct;
        const userLetter = ans?.letter || '—';
        const userText = ans?.letter ? (q.opciones?.[ans.letter] || '') : 'Sin respuesta';
        const correctText = q.opciones?.[q.respuesta_correcta] || '';

        const item = document.createElement('div');
        item.className = 'review-item ' + (correct ? 'is-correct' : 'is-wrong');
        item.innerHTML = `
          <div class="review-item__head">
            <span class="review-item__num">${correct ? '✓' : '✕'}</span>
            <span class="review-item__title">Pregunta ${i + 1} · ${escapeHtml((q.enunciado || '').slice(0, 60))}${(q.enunciado || '').length > 60 ? '…' : ''}</span>
            <svg class="review-item__toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="review-item__body">
            <p><strong>Tu respuesta:</strong> ${escapeHtml(userLetter)}. ${escapeHtml(userText)}</p>
            <p><strong>Respuesta correcta:</strong> ${escapeHtml(q.respuesta_correcta)}. ${escapeHtml(correctText)}</p>
            <p><strong>Explicación:</strong> ${escapeHtml(q.explicacion || 'Sin explicación.').replace(/\n/g, '<br>')}</p>
          </div>
        `;
        item.querySelector('.review-item__head').addEventListener('click', () => item.classList.toggle('is-open'));
        wrap.appendChild(item);
      });
    },
  };

  /* ══════════════════════════════════════════════════════════════
     19 · HISTORIAL UI
     ══════════════════════════════════════════════════════════════ */

  const HistoryUI = {
    render() {
      const wrap = $('[data-history-list]');
      if (!wrap) return;
      wrap.innerHTML = '';

      if (!State.history.length) {
        wrap.innerHTML = `
          <div class="history-empty">
            <div class="history-empty__ico">📚</div>
            <p class="history-empty__text">Aún no has hecho ninguna práctica.</p>
          </div>
        `;
        return;
      }

      for (const s of State.history) {
        const pct = s.count ? Math.round((s.correct / s.count) * 100) : 0;
        const item = document.createElement('div');
        item.className = 'history-item';
        item.innerHTML = `
          <div class="history-item__score">${s.score}</div>
          <div class="history-item__info">
            <span class="history-item__title">${escapeHtml(s.materiaNombre || 'Práctica')}</span>
            <div class="history-item__meta">
              <span>📅 ${fmtRelative(s.ts)}</span>
              <span>✓ ${s.correct}/${s.count} (${pct}%)</span>
              <span>⏱ ${fmtTime(s.time)}</span>
            </div>
          </div>
          <svg class="history-item__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        `;
        wrap.appendChild(item);
      }
    },
  };

  /* ══════════════════════════════════════════════════════════════
     20 · SETTINGS
     ══════════════════════════════════════════════════════════════ */

  const Settings = {
    sync() {
      const prefs = Prefs.all();
      $$('[data-switch]').forEach((sw) => {
        const key = sw.dataset.switch;
        const on = Boolean(prefs[key]);
        sw.classList.toggle('is-on', on);
        sw.setAttribute('aria-checked', String(on));
      });
      Settings.applyTheme();
    },
    applyTheme() {
      document.documentElement.dataset.theme = Prefs.get('dark') ? 'dark' : 'light';
    },
    init() {
      $$('[data-switch]').forEach((sw) => {
        sw.addEventListener('click', () => {
          const key = sw.dataset.switch;
          const on = !sw.classList.contains('is-on');
          sw.classList.toggle('is-on', on);
          sw.setAttribute('aria-checked', String(on));
          Prefs.set(key, on);
          if (key === 'dark') Settings.applyTheme();
          if (key === 'compact') document.body.classList.toggle('is-compact', on);
          Sound.click();
        });
      });
      if (Prefs.get('compact')) document.body.classList.add('is-compact');
      Settings.sync();
    },
  };

  /* ══════════════════════════════════════════════════════════════
     21 · ATAJOS
     ══════════════════════════════════════════════════════════════ */

  const Shortcuts = {
    init() {
      document.addEventListener('keydown', (e) => {
        const tag = (e.target.tagName || '').toLowerCase();
        const typing = tag === 'input' || tag === 'textarea';

        if (e.key === 'Escape') {
          const modal = $('.modal-backdrop:not([hidden])');
          if (modal) { Modal.close(); return; }
          if (State.screen === 'exam' && !State.exam.finished) Router.go('home');
          return;
        }

        if (State.screen !== 'exam' || State.exam.finished) return;
        if (typing) return;

        if (/^[1-4]$/.test(e.key)) {
          const letter = ['A', 'B', 'C', 'D'][parseInt(e.key, 10) - 1];
          const btn = $(`.option[data-letter="${letter}"]:not(:disabled)`);
          if (btn) btn.click();
          return;
        }
        if (e.key === 'ArrowRight') { e.preventDefault(); Exam.next(); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); Exam.prev(); }
        if (e.key.toLowerCase() === 'f') { e.preventDefault(); Exam.toggleFlag(); }
      });
    },
  };

  /* ══════════════════════════════════════════════════════════════
     22 · INIT
     ══════════════════════════════════════════════════════════════ */

  async function init() {
    log('Numination práctica v' + CFG.version);
    Loading.hide(); // Asegurar que arranca oculto

    History.load();
    Stats.load();
    SidebarStats.render();
    Settings.applyTheme();
    if (Prefs.get('compact')) document.body.classList.add('is-compact');

    try {
      const me = await API.me();
      if (me.ok && me.user) {
        State.user = me.user;
        SidebarStats.render();
      }
    } catch (e) { warn('auth', e); }

    Sidebar.init();
    Config.init();
    Settings.init();
    Shortcuts.init();

    await Materias.load();

    $('[data-action="simulacro"]')?.addEventListener('click', () => {
      Sound.click();
      Config.openSimulacro();
    });

    $$('[data-show-history]').forEach((el) => el.addEventListener('click', () => {
      Sound.click();
      HistoryUI.render();
      Router.go('history');
    }));

    $$('[data-show-config]').forEach((el) => el.addEventListener('click', () => {
      Sound.click();
      Settings.sync();
      Router.go('settings');
    }));

    $$('[data-action="back"]').forEach((el) => el.addEventListener('click', () => {
      Sound.click();
      Router.go('home');
    }));

    $('[data-action="start"]')?.addEventListener('click', () => {
      Sound.click();
      Exam.start();
    });

    $('[data-action="next"]')?.addEventListener('click', () => Exam.next());
    $('[data-action="prev"]')?.addEventListener('click', () => Exam.prev());
    $('[data-action="skip"]')?.addEventListener('click', () => Exam.skip());
    $('[data-action="flag"]')?.addEventListener('click', () => Exam.toggleFlag());
    $('[data-action="exit-exam"]')?.addEventListener('click', () => {
      if (State.exam.finished) {
        Router.forceGo('home');
        return;
      }
      Modal.confirm({
        title: '¿Salir de la práctica?',
        body: 'Vas a perder las respuestas de esta sesión. ¿Seguro?',
        onConfirm: () => Router.forceGo('home'),
      });
    });

    $('[data-action="retry"]')?.addEventListener('click', () => {
      Sound.click();
      Exam.start();
    });

    $$('[data-action="home"]').forEach((el) => el.addEventListener('click', () => {
      Sound.click();
      Router.go('home');
    }));

    $('[data-action="clear-history"]')?.addEventListener('click', () => {
      Modal.confirm({
        title: '¿Borrar historial?',
        body: 'Se eliminarán todas las sesiones guardadas. Esta acción no se puede deshacer.',
        onConfirm: () => {
          History.clear();
          HistoryUI.render();
          Toasts.ok('Historial borrado.');
        },
      });
    });

    $$('[data-modal-close]').forEach((el) => el.addEventListener('click', () => Modal.close()));
    $$('[data-modal-confirm]').forEach((el) => el.addEventListener('click', () => Modal.runConfirm()));
    $$('.modal-backdrop').forEach((back) => {
      back.addEventListener('click', (e) => {
        if (e.target === back) Modal.close();
      });
    });

    Router.forceGo('home');
    log('boot completo');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();