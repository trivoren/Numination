/* ============================================================
   NUMINATION — main.js
   Todo el JS del sitio (tema, menú, scroll, counters, formulario)
   ============================================================ */

/* ══════════ TEMA OSCURO/CLARO ══════════ */

const THEME_KEY = 'numination-theme';

function initTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initial = stored || (prefers ? 'dark' : 'light');
  applyTheme(initial);

  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme;
      const next = current === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    });
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    const isDark = theme === 'dark';
    const sun = btn.querySelector('[data-icon="sun"]');
    const moon = btn.querySelector('[data-icon="moon"]');
    if (sun) sun.style.display = isDark ? '' : 'none';
    if (moon) moon.style.display = isDark ? 'none' : '';
    btn.setAttribute('aria-label', isDark ? 'Activar modo claro' : 'Activar modo oscuro');
  });
}

/* ══════════ MENÚ MÓVIL ══════════ */

function initMobileMenu() {
  const toggle = document.querySelector('[data-menu-toggle]');
  const menu = document.querySelector('[data-menu]');
  if (!toggle || !menu) return;

  toggle.addEventListener('click', () => {
    const open = menu.classList.toggle('is-open');
    toggle.setAttribute('aria-expanded', String(open));
  });

  menu.querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', () => {
      menu.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
}

/* ══════════ SCROLL SUAVE ══════════ */

function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href');
      if (!id || id === '#') return;
      const target = document.querySelector(id);
      if (!target) return;
      e.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - 80;
      window.scrollTo({ top, behavior: 'smooth' });
    });
  });
}

/* ══════════ REVEAL ON SCROLL ══════════ */

function initScrollReveal() {
  const els = document.querySelectorAll('[data-reveal], [data-reveal-stagger]');
  if (!els.length) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    els.forEach((el) => el.classList.add('is-visible'));
    return;
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.classList.add('is-visible');
      io.unobserve(e.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -60px 0px' });

  els.forEach((el) => io.observe(el));
}

/* ══════════ CONTADORES ══════════ */

function initCounters() {
  const els = document.querySelectorAll('[data-counter]');
  if (!els.length) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      io.unobserve(el);

      const to = parseFloat(el.dataset.counter);
      const from = parseFloat(el.dataset.counterFrom || '0');
      const duration = parseInt(el.dataset.counterDuration || '1600', 10);
      const suffix = el.dataset.counterSuffix || '';
      const prefix = el.dataset.counterPrefix || '';
      const decimals = parseInt(el.dataset.counterDecimals || '0', 10);

      if (reduce) { el.textContent = fmt(to, decimals, prefix, suffix); return; }

      const t0 = performance.now();
      const tick = (now) => {
        const p = Math.min((now - t0) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt(from + (to - from) * eased, decimals, prefix, suffix);
        if (p < 1) requestAnimationFrame(tick);
        else el.textContent = fmt(to, decimals, prefix, suffix);
      };
      requestAnimationFrame(tick);
    });
  }, { threshold: 0.35 });

  els.forEach((el) => io.observe(el));
}

function fmt(n, d, pre, suf) {
  const s = n.toLocaleString('es-CO', { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${pre}${s}${suf}`;
}

/* ══════════ FORMULARIO DE CONTACTO ══════════ */

function initContactForm() {
  const form = document.querySelector('[data-contact-form]');
  if (!form) return;

  const counter = form.querySelector('[data-counter]');
  const mensaje = form.querySelector('#mensaje');
  const status = form.querySelector('[data-form-status]');

  const MAX = mensaje ? (parseInt(mensaje.getAttribute('maxlength'), 10) || 1200) : 1200;

  if (counter && mensaje) {
    const update = () => {
      const len = mensaje.value.length;
      counter.textContent = `${len} / ${MAX}`;
      counter.style.color = len > MAX * 0.9 ? 'var(--brand-red)' : '';
    };
    mensaje.addEventListener('input', update);
    update();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.checkValidity()) { form.reportValidity(); return; }
    const btn = form.querySelector('button[type="submit"]');
    if (btn) btn.disabled = true;

    await new Promise((r) => setTimeout(r, 500));

    if (status) {
      status.hidden = false;
      status.dataset.state = 'ok';
      status.textContent = 'Mensaje enviado. Te responderemos pronto.';
    }
    form.reset();
    if (counter && mensaje) {
      counter.textContent = `0 / ${MAX}`;
      counter.style.color = '';
    }
    if (btn) btn.disabled = false;
  });
}

/* ══════════ BOOT ══════════ */

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initMobileMenu();
  initSmoothScroll();
  initScrollReveal();
  initCounters();
  initContactForm();
});