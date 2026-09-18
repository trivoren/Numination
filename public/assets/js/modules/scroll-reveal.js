export function initScrollReveal() {
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