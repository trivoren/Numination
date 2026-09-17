/* ============================================================
   Reveal on scroll
   Uso: <div data-reveal>...</div>
   ============================================================ */

export function initScrollReveal() {
  const els = document.querySelectorAll('[data-reveal]');
  if (!els.length) return;

  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    els.forEach((el) => { el.style.opacity = '1'; });
    return;
  }

  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      e.target.style.transition = 'opacity .6s ease, transform .6s ease';
      e.target.style.opacity = '1';
      e.target.style.transform = 'translateY(0)';
      io.unobserve(e.target);
    });
  }, { threshold: 0.15 });

  els.forEach((el) => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(16px)';
    io.observe(el);
  });
}