/* ================================================================
   NUMINATION · auth.js v2
   ================================================================ */
(() => {
  'use strict';

  const CFG = {
    version: '2.0.0',
    debug: new URLSearchParams(location.search).has('debug'),
    keys: {
      users: 'numination-auth-users',
      session: 'numination-auth-session',
      attempts: 'numination-auth-attempts',
    },
    toastDuration: 3000,
    spinnerMinMs: 400,
    resendCooldownSec: 60,
    sessionDays: 30,
    maxLoginAttempts: 5,
    lockMinutes: 15,
    passwordMin: 8,
    screens: ['welcome', 'email', 'password', 'signup', 'verify', 'forgot', 'reset'],
    defaultScreen: 'welcome',
  };

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raf = (fn) => requestAnimationFrame(fn);
  const nowMs = () => Date.now();
  const uid = (p = 'x') => `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const log = (...a) => { if (CFG.debug) console.log('%c[auth]', 'color:#7c93d4', ...a); };
  const escapeHtml = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  /* ── Storage ────────────────────────────────────────────── */
  const Store = {
    read(k, fb = null) {
      try { const r = localStorage.getItem(k); return r == null ? fb : JSON.parse(r); }
      catch { return fb; }
    },
    write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    remove(k) { try { localStorage.removeItem(k); } catch {} },
  };

  /* ── Toasts ─────────────────────────────────────────────── */
  const Toasts = (() => {
    let host = null;
    function ensure() {
      if (host && document.body.contains(host)) return host;
      host = $('.toast-host') || (() => {
        const h = document.createElement('div');
        h.className = 'toast-host';
        document.body.appendChild(h);
        return h;
      })();
      return host;
    }
    function show(msg, kind = 'info') {
      const h = ensure();
      const el = document.createElement('div');
      el.className = `toast toast--${kind}`;
      const ico = { ok: '✓', warn: '⚠', err: '✕', info: 'ⓘ' }[kind] || '';
      el.innerHTML = `<span class="toast__ico">${ico}</span><span>${escapeHtml(msg)}</span>`;
      h.appendChild(el);
      raf(() => el.classList.add('is-visible'));
      let t = setTimeout(dismiss, CFG.toastDuration);
      function dismiss() { clearTimeout(t); el.classList.remove('is-visible'); setTimeout(() => el.remove(), 260); }
      el.addEventListener('click', dismiss);
    }
    return {
      show,
      ok: (m) => show(m, 'ok'),
      warn: (m) => show(m, 'warn'),
      err: (m) => show(m, 'err'),
      info: (m) => show(m, 'info'),
    };
  })();

  /* ── Email validator ───────────────────────────────────── */
  const Email = {
    RE: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/,
    normalize: (e) => String(e || '').trim().toLowerCase(),
    valid(e) { const n = Email.normalize(e); return Email.RE.test(n) && n.length <= 254; },
  };

  /* ── Password strength ─────────────────────────────────── */
  const Password = {
    analyze(p) {
      const s = String(p || '');
      const hasLower = /[a-z]/.test(s);
      const hasUpper = /[A-Z]/.test(s);
      const hasDigit = /\d/.test(s);
      const hasSym = /[^A-Za-z0-9]/.test(s);
      let score = 0;
      if (s.length >= 8) score++;
      if (s.length >= 12) score++;
      if (hasLower && hasUpper) score++;
      if (hasDigit) score++;
      if (hasSym) score++;
      const commons = ['12345678', 'password', 'contraseña', 'qwerty', 'numination', 'colombia'];
      const common = commons.some((c) => s.toLowerCase().includes(c));
      let level = 0;
      if (score >= 1) level = 1;
      if (score >= 2 && s.length >= 8) level = 2;
      if (score >= 3 && s.length >= 10) level = 3;
      if (score >= 4 && s.length >= 12) level = 4;
      if (common) level = Math.min(level, 2);
      if (!s.length) level = 0;
      const labels = ['Muy débil', 'Débil', 'Media', 'Fuerte', 'Muy fuerte'];
      return { level, label: labels[level], score, common };
    },
    acceptable(p) {
      const a = Password.analyze(p);
      return p.length >= CFG.passwordMin && a.level >= 2 && !a.common;
    },
  };

  /* ── Mock API ──────────────────────────────────────────── */
  const API = (() => {
    const delay = (ms = 500) => sleep(ms + Math.random() * 200);
    const loadUsers = () => Store.read(CFG.keys.users, {}) || {};
    const saveUsers = (u) => Store.write(CFG.keys.users, u);
    const hash = (s) => {
      let h = 0; const str = String(s) + '::numination';
      for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
      return 'h' + h.toString(36);
    };

    async function checkEmail(email) {
      await delay(400);
      const e = Email.normalize(email);
      const users = loadUsers();
      return { exists: Boolean(users[e]), email: e };
    }

    async function signup(email, password) {
      await delay(600);
      const e = Email.normalize(email);
      const users = loadUsers();
      if (users[e]) return { ok: false, error: 'exists', message: 'Ese correo ya está registrado.' };
      users[e] = {
        id: uid('u'), email: e, passwordHash: hash(password),
        createdAt: nowMs(), verified: true, verificationToken: uid('vt'),
      };
      saveUsers(users);
      return { ok: true, user: users[e] };
    }

    async function login(email, password, remember = false) {
      await delay(500);
      const e = Email.normalize(email);
      const users = loadUsers();
      const user = users[e];
      if (!user) return { ok: false, error: 'not_found', message: 'No encontramos esa cuenta.' };
      if (user.passwordHash !== hash(password)) return { ok: false, error: 'wrong_password', message: 'Contraseña incorrecta.' };

      const session = {
        token: uid('s'), userId: user.id, email: user.email,
        remember, createdAt: nowMs(),
        expiresAt: nowMs() + (remember ? CFG.sessionDays : 1) * 86400000,
      };
      Store.write(CFG.keys.session, session);
      return { ok: true, user, session };
    }

    async function google() {
      await delay(800);
      const e = 'usuario.google@numination.co';
      const users = loadUsers();
      let user = users[e];
      if (!user) {
        user = { id: uid('u'), email: e, name: 'Usuario de Google', provider: 'google', verified: true, createdAt: nowMs() };
        users[e] = user;
        saveUsers(users);
      }
      const session = { token: uid('s'), userId: user.id, email: e, remember: true, createdAt: nowMs(), expiresAt: nowMs() + CFG.sessionDays * 86400000 };
      Store.write(CFG.keys.session, session);
      return { ok: true, user, session };
    }

    async function requestReset(email) {
      await delay(400);
      const users = loadUsers();
      const e = Email.normalize(email);
      const user = users[e];
      if (!user) return { ok: true };
      user.resetToken = uid('rt');
      user.resetExpiresAt = nowMs() + 60 * 60 * 1000;
      saveUsers(users);
      return { ok: true, token: user.resetToken };
    }

    async function resetPassword(token, newPassword) {
      await delay(500);
      if (!token) return { ok: false };
      const users = loadUsers();
      for (const email in users) {
        const u = users[email];
        if (u.resetToken === token) {
          u.passwordHash = hash(newPassword);
          delete u.resetToken;
          delete u.resetExpiresAt;
          saveUsers(users);
          return { ok: true, email };
        }
      }
      return { ok: false };
    }

    return { checkEmail, signup, login, google, requestReset, resetPassword };
  })();

  /* ── Attempts ──────────────────────────────────────────── */
  const Attempts = {
    get(email) {
      const all = Store.read(CFG.keys.attempts, {}) || {};
      return all[email] || { count: 0, lockedUntil: 0 };
    },
    record(email) {
      const all = Store.read(CFG.keys.attempts, {}) || {};
      const a = all[email] || { count: 0, lockedUntil: 0 };
      a.count++;
      if (a.count >= CFG.maxLoginAttempts) {
        a.lockedUntil = nowMs() + CFG.lockMinutes * 60000;
        a.count = 0;
      }
      all[email] = a;
      Store.write(CFG.keys.attempts, all);
      return a;
    },
    clear(email) {
      const all = Store.read(CFG.keys.attempts, {}) || {};
      delete all[email];
      Store.write(CFG.keys.attempts, all);
    },
    isLocked(email) { return Attempts.get(email).lockedUntil > nowMs(); },
    remaining(email) {
      const ms = Math.max(0, Attempts.get(email).lockedUntil - nowMs());
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      return `${m}:${String(s).padStart(2, '0')}`;
    },
  };

  /* ── State ─────────────────────────────────────────────── */
  const State = {
    screen: null,
    email: null,
    verifyEmail: null,
    resetToken: null,
    loading: false,
    resendTimer: null,
  };

  /* ── Router ────────────────────────────────────────────── */
  const Router = {
    go(screen) {
      if (!CFG.screens.includes(screen)) screen = CFG.defaultScreen;
      State.screen = screen;
      location.hash = screen;
      Router.render(screen);
    },
    render(screen) {
      let visibleCount = 0;
      $$('.auth-screen').forEach((el) => {
        const on = el.dataset.screen === screen;
        el.hidden = !on;
        if (on) visibleCount++;
      });
      log('render:', screen, '| visibles:', visibleCount);

      const titles = {
        welcome: 'Bienvenido', email: 'Ingresa tu correo', password: 'Contraseña',
        signup: 'Crea tu cuenta', verify: 'Revisa tu correo', forgot: 'Recuperar',
        reset: 'Nueva contraseña',
      };
      document.title = `${titles[screen] || 'Numination'} · Numination`;

      // Foco
      const active = $(`.auth-screen[data-screen="${screen}"]`);
      const first = active?.querySelector('input:not([type="hidden"]):not([disabled])');
      if (first) setTimeout(() => first.focus(), 100);
    },
    init() {
      const hash = location.hash.slice(1);
      const initial = CFG.screens.includes(hash) ? hash : CFG.defaultScreen;
      Router.render(initial);
      State.screen = initial;
      window.addEventListener('hashchange', () => {
        const s = location.hash.slice(1);
        if (CFG.screens.includes(s) && s !== State.screen) {
          State.screen = s;
          Router.render(s);
        }
      });
    },
    back() {
      const idx = CFG.screens.indexOf(State.screen);
      Router.go(CFG.screens[Math.max(0, idx - 1)] || 'welcome');
    },
  };

  /* ── Form helpers ──────────────────────────────────────── */
  const Form = {
    error(input, msg) {
      const f = input.closest('.auth-field');
      if (!f) return;
      f.classList.toggle('has-error', Boolean(msg));
      const el = f.querySelector('.auth-field__error');
      if (el) el.textContent = msg || '';
    },
    clear(input) { Form.error(input, ''); },
    setLoading(btn, on) {
      if (!btn) return;
      btn.classList.toggle('is-loading', on);
      btn.disabled = on;
    },
    async wrap(btn, fn) {
      if (State.loading) return null;
      State.loading = true;
      Form.setLoading(btn, true);
      const t0 = nowMs();
      try {
        const r = await fn();
        const el = nowMs() - t0;
        if (el < CFG.spinnerMinMs) await sleep(CFG.spinnerMinMs - el);
        return r;
      } finally {
        Form.setLoading(btn, false);
        State.loading = false;
      }
    },
    shake(el) {
      if (!el) return;
      el.animate(
        [{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' },
         { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' },
         { transform: 'translateX(4px)' }, { transform: 'translateX(0)' }],
        { duration: 380, easing: 'ease-out' }
      );
    },
  };

  /* ── Chip email ────────────────────────────────────────── */
  function renderChips(email) {
    $$('[data-chip-email]').forEach((el) => { el.textContent = email || ''; });
    $$('[data-verify-email]').forEach((el) => { el.textContent = email || ''; });
  }

  /* ── Password toggles ──────────────────────────────────── */
  function initPasswordToggles() {
    $$('[data-action="toggle-pass"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const wrap = btn.closest('.auth-input-wrap');
        const input = wrap?.querySelector('input');
        if (!input) return;
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        const eye = btn.querySelector('[data-icon="eye"]');
        const eyeOff = btn.querySelector('[data-icon="eye-off"]');
        if (eye) eye.style.display = show ? 'none' : '';
        if (eyeOff) eye.style.display = show ? '' : 'none';
      });
    });
  }

  /* ── Screen handlers ───────────────────────────────────── */
  function initWelcome() {
    $$('[data-action="to-email"]').forEach((b) => {
      b.addEventListener('click', (e) => { e.preventDefault(); Router.go('email'); });
    });
  }

  function initEmail() {
    const form = $('[data-form="email"]');
    if (!form) return;
    const input = $('#email');
    const submit = form.querySelector('button[type="submit"]');

    if (State.email) input.value = State.email;

    input.addEventListener('input', () => Form.clear(input));
    input.addEventListener('blur', () => {
      const v = input.value.trim();
      if (v && !Email.valid(v)) Form.error(input, 'Ingresa un correo válido.');
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = Email.normalize(input.value);
      if (!email) { Form.error(input, 'Ingresa tu correo.'); Form.shake(input); return; }
      if (!Email.valid(email)) { Form.error(input, 'Ese correo no parece válido.'); Form.shake(input); return; }

      await Form.wrap(submit, async () => {
        const r = await API.checkEmail(email);
        State.email = email;
        renderChips(email);
        if (r.exists) Router.go('password');
        else { Toasts.info('No encontramos esa cuenta. Vamos a crearla.'); Router.go('signup'); }
      });
    });

    $('[data-screen="email"] [data-action="back"]')?.addEventListener('click', (e) => {
      e.preventDefault(); Router.back();
    });
  }

  function initPassword() {
    const form = $('[data-form="password"]');
    if (!form) return;
    const input = $('#password');
    const submit = form.querySelector('button[type="submit"]');

    input.addEventListener('input', () => Form.clear(input));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = input.value;
      const email = State.email;
      if (!email) { Router.go('email'); return; }
      if (!password) { Form.error(input, 'Ingresa tu contraseña.'); Form.shake(input); return; }
      if (Attempts.isLocked(email)) { Toasts.err(`Cuenta bloqueada. Intenta en ${Attempts.remaining(email)}.`); return; }

      await Form.wrap(submit, async () => {
        const remember = form.querySelector('input[name="remember"]')?.checked ?? true;
        const r = await API.login(email, password, remember);
        if (r.ok) {
          Attempts.clear(email);
          Toasts.ok('Bienvenido de vuelta.');
          await sleep(500);
          location.href = 'public/chat.html';
          return;
        }
        if (r.error === 'wrong_password') {
          const a = Attempts.record(email);
          if (a.lockedUntil > nowMs()) {
            Toasts.err(`Demasiados intentos. Bloqueado por ${CFG.lockMinutes} min.`);
            Form.error(input, 'Cuenta bloqueada temporalmente.');
          } else {
            Form.error(input, r.message); Form.shake(input); Toasts.err(r.message);
          }
        } else if (r.error === 'not_found') {
          Toasts.warn('No encontramos esa cuenta. Vamos a crearla.');
          await sleep(800);
          Router.go('signup');
        }
      });
    });

    $('[data-screen="password"] [data-action="to-forgot"]')?.addEventListener('click', (e) => {
      e.preventDefault(); Router.go('forgot');
    });
    $('[data-screen="password"] [data-action="to-email"]')?.addEventListener('click', (e) => {
      e.preventDefault(); Router.go('email');
    });
  }

  function initSignup() {
    const form = $('[data-form="signup"]');
    if (!form) return;
    const input = $('#new-password');
    const submit = form.querySelector('button[type="submit"]');
    const meter = $('[data-strength]');
    const label = $('[data-strength-label]');

    input.addEventListener('input', () => {
      const a = Password.analyze(input.value);
      if (meter) meter.dataset.level = String(a.level);
      if (label) label.textContent = `(${a.label})`;
      Form.clear(input);
    });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = input.value;
      const terms = form.querySelector('input[name="terms"]')?.checked;
      if (!pw || pw.length < CFG.passwordMin) { Form.error(input, `Mínimo ${CFG.passwordMin} caracteres.`); Form.shake(input); return; }
      if (!Password.acceptable(pw)) { Form.error(input, 'Esa contraseña es muy débil.'); Form.shake(input); return; }
      if (!terms) { Toasts.err('Debes aceptar los términos y la política.'); return; }

      await Form.wrap(submit, async () => {
        const r = await API.signup(State.email, pw);
        if (r.ok) {
          State.verifyEmail = State.email;
          renderChips(State.email);
          Toasts.ok('Cuenta creada. Revisa tu correo.');
          await sleep(700);
          Router.go('verify');
          return;
        }
        if (r.error === 'exists') {
          Toasts.err('Ese correo ya está registrado.');
          await sleep(800);
          Router.go('password');
        }
      });
    });

    $('[data-screen="signup"] [data-action="to-email"]')?.addEventListener('click', (e) => {
      e.preventDefault(); Router.go('email');
    });
  }

  function initVerify() {
    const resendBtn = $('[data-screen="verify"] [data-action="resend"]');
    const resendLabel = $('[data-resend-label]');
    renderChips(State.verifyEmail || State.email);

    function startCountdown() {
      if (State.resendTimer) clearInterval(State.resendTimer);
      let left = CFG.resendCooldownSec;
      resendBtn.disabled = true;
      resendLabel.textContent = `Reenviar en ${left}s`;
      State.resendTimer = setInterval(() => {
        left--;
        if (left <= 0) {
          clearInterval(State.resendTimer);
          State.resendTimer = null;
          resendBtn.disabled = false;
          resendLabel.textContent = 'Reenviar correo';
        } else {
          resendLabel.textContent = `Reenviar en ${left}s`;
        }
      }, 1000);
    }
    startCountdown();

    resendBtn?.addEventListener('click', () => {
      if (resendBtn.disabled) return;
      Toasts.info('Correo reenviado.');
      startCountdown();
    });

    $('[data-screen="verify"] [data-action="to-email"]')?.addEventListener('click', (e) => {
      e.preventDefault(); Router.go('email');
    });

    $('[data-screen="verify"] [data-action="continue"]')?.addEventListener('click', async (e) => {
      e.preventDefault();
      // Marcar como verificado y pasar a login
      const users = Store.read(CFG.keys.users, {}) || {};
      const email = State.verifyEmail || State.email;
      if (email && users[email]) {
        users[email].verified = true;
        Store.write(CFG.keys.users, users);
      }
      Toasts.ok('Correo verificado. Ingresa con tu contraseña.');
      await sleep(500);
      Router.go('password');
    });
  }

  function initForgot() {
    const form = $('[data-form="forgot"]');
    if (!form) return;
    const input = $('#forgot-email');
    const submit = form.querySelector('button[type="submit"]');
    if (State.email) input.value = State.email;
    input.addEventListener('input', () => Form.clear(input));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = Email.normalize(input.value);
      if (!Email.valid(email)) { Form.error(input, 'Correo inválido.'); Form.shake(input); return; }
      await Form.wrap(submit, async () => {
        const r = await API.requestReset(email);
        State.email = email;
        State.resetToken = r.token || uid('rt');
        Toasts.ok('Si el correo existe, te enviamos un link.');
        await sleep(800);
        Router.go('reset');
      });
    });

    $('[data-screen="forgot"] [data-action="back"]')?.addEventListener('click', (e) => {
      e.preventDefault(); Router.back();
    });
  }

  function initReset() {
    const form = $('[data-form="reset"]');
    if (!form) return;
    const p1 = $('#reset-1');
    const p2 = $('#reset-2');
    const submit = form.querySelector('button[type="submit"]');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!p1.value || p1.value.length < CFG.passwordMin) { Form.error(p1, `Mínimo ${CFG.passwordMin} caracteres.`); Form.shake(p1); return; }
      if (p1.value !== p2.value) { Form.error(p2, 'Las contraseñas no coinciden.'); Form.shake(p2); return; }
      if (!Password.acceptable(p1.value)) { Form.error(p1, 'Esa contraseña es muy débil.'); Form.shake(p1); return; }

      await Form.wrap(submit, async () => {
        const r = await API.resetPassword(State.resetToken, p1.value);
        if (r.ok) {
          Toasts.ok('Contraseña actualizada. Inicia sesión.');
          State.resetToken = null;
          await sleep(700);
          Router.go('password');
        } else {
          Toasts.err('El link expiró. Solicita uno nuevo.');
          await sleep(900);
          Router.go('forgot');
        }
      });
    });
  }

  /* ── Boot ──────────────────────────────────────────────── */
  function boot() {
    log('Numination auth v' + CFG.version);

    // Si hay sesión activa → redirigir
    const session = Store.read(CFG.keys.session);
    if (session && session.expiresAt > nowMs() && !new URLSearchParams(location.search).has('stay')) {
      log('sesión activa detectada');
      // Descomenta esto cuando quieras redirigir auto:
      // location.href = 'public/chat.html';
      // return;
    }

    initPasswordToggles();
    initWelcome();
    initEmail();
    initPassword();
    initSignup();
    initVerify();
    initForgot();
    initReset();
    Router.init();

    if (CFG.debug) {
      window.__auth = { CFG, State, Router, API, Password, Attempts, Store, Toasts };
      log('__auth disponible');
    }
    log('boot completo');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
      /* ── Google Sign-In callback ── */
  window.handleGoogleCredential = async (response) => {
    const credential = response?.credential;
    if (!credential) {
      Toasts.err('Google no devolvió credenciales.');
      return;
    }

    const btn = document.querySelector('.g_id_signin');
    if (btn) btn.style.pointerEvents = 'none';

    try {
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ credential, remember: true }),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        throw new Error(data.error || 'Error de autenticación');
      }

      Toasts.ok(`Bienvenido, ${data.user.name}`);
      await sleep(700);
      location.href = '/chat.html';
    } catch (err) {
      console.error('[auth] Google:', err);
      Toasts.err('No pudimos iniciar sesión con Google.');
      if (btn) btn.style.pointerEvents = '';
    }
        // Verificar si ya hay sesión
    try {
      const res = await fetch('/api/auth/me', { credentials: 'include' });
      const data = await res.json();
      if (data.ok && data.user && !new URLSearchParams(location.search).has('stay')) {
        location.href = '/chat.html';
        return;
      }
    } catch {}
  };
  }
})();