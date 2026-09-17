/* ============================================================
   Toggle de tema claro/oscuro
   - Lee preferencia del sistema la primera vez
   - Guarda elección en localStorage
   - Cambia data-theme en <html>
   - Muestra/oculta iconos sol/luna
   ============================================================ */

const KEY = 'numination-theme';

export function initTheme() {
  const stored  = localStorage.getItem(KEY);
  const prefers = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initial = stored ?? (prefers ? 'dark' : 'light');

  apply(initial);

  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme;
      const next = current === 'dark' ? 'light' : 'dark';
      localStorage.setItem(KEY, next);
      apply(next);
    });
  });
}

function apply(theme) {
  document.documentElement.dataset.theme = theme;

  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    const isDark = theme === 'dark';
    const sun  = btn.querySelector('[data-icon="sun"]');
    const moon = btn.querySelector('[data-icon="moon"]');

    if (sun)  sun.style.display  = isDark ? '' : 'none';
    if (moon) moon.style.display = isDark ? 'none' : '';

    btn.setAttribute(
      'aria-label',
      isDark ? 'Activar modo claro' : 'Activar modo oscuro'
    );
  });
}