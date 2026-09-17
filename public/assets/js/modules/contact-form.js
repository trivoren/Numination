/* ============================================================
   Formulario de contacto
   - Contador de caracteres en el textarea
   - Estado "enviado" simulado (hasta que exista backend)
   ============================================================ */

export function initContactForm() {
  const form = document.querySelector('[data-contact-form]');
  if (!form) return;

  const counter = form.querySelector('[data-counter]');
  const mensaje = form.querySelector('#mensaje');
  const status  = form.querySelector('[data-form-status]');

  if (counter && mensaje) {
    const MAX = parseInt(mensaje.getAttribute('maxlength'), 10) || 1200;
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

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const submitBtn = form.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;

    // TODO: reemplazar por fetch real al backend cuando exista endpoint.
    await new Promise((r) => setTimeout(r, 500));

    if (status) {
      status.hidden = false;
      status.dataset.state = 'ok';
      status.textContent = 'Mensaje enviado. Te responderemos pronto.';
    }

    form.reset();
    if (counter && mensaje) {
      counter.textContent = `0 / ${mensaje.getAttribute('maxlength')}`;
      counter.style.color = '';
    }
    if (submitBtn) submitBtn.disabled = false;
  });
}