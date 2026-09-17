/* ============================================================
   Menú móvil (hamburguesa)
   - Alterna .is-open en el contenedor [data-menu]
   - Actualiza aria-expanded
   - Cierra al hacer click en un link
   ============================================================ */

export function initMobileMenu() {
  const toggle = document.querySelector('[data-menu-toggle]');
  const menu   = document.querySelector('[data-menu]');
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