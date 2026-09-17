/* ============================================================
   Contadores animados
   Uso: <span class="counter" data-counter="480" data-counter-suffix="K+"></span>
   ============================================================ */

export function initCounters() {
  const els = document.querySelectorAll('[data-counter]');
  if (!els.length) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      io.unobserve(el);

      const to       = parseFloat(el.dataset.counter);
      const from     = parseFloat(el.dataset.counterFrom || '0');
      const duration = parseInt(el.dataset.counterDuration || '1600', 10);
      const suffix   = el.dataset.counterSuffix || '';
      const prefix   = el.dataset.counterPrefix || '';
      const decimals = parseInt(el.dataset.counterDecimals || '0', 10);

      if (reduce) {
        el.textContent = format(to, decimals, prefix, suffix);
        return;
      }

      const t0 = performance.now();
      const tick = (now) => {
        const p = Math.min((now - t0) / duration, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        const val = from + (to - from) * eased;
        el.textContent = format(val, decimals, prefix, suffix);
        if (p < 1) requestAnimationFrame(tick);
        else el.textContent = format(to, decimals, prefix, suffix);
      };
      requestAnimationFrame(tick);
    });
  }, { threshold: 0.35 });

  els.forEach((el) => io.observe(el));
}

function format(n, decimals, prefix, suffix) {
  const s = n.toLocaleString('es-CO', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${prefix}${s}${suffix}`;
}