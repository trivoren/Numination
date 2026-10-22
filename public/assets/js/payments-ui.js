/**
 * Numination · payments-ui.js · v1.0
 * ─────────────────────────────────────────────────────────────────────────
 * Modal de planes + checkout con el SDK de PayPal.
 *
 * RESPONSABILIDADES:
 *  · Generar el DOM del modal con las dos tarjetas de plan:
 *      · Pro      → 30.000 COP  /  USD 7.50
 *      · Ultimate → 45.000 COP  /  USD 11.00
 *  · Inicializar el SDK oficial de PayPal en los contenedores de botones.
 *  · Bloquear el botón INMEDIATAMENTE al hacer clic (doble submit / doble
 *    cobro) antes de cualquier llamada de red.
 *  · Integrarse con `payments-client.js` (retry + toasts) y con el toast
 *    global `NuminToast` si está disponible.
 *
 * DEPENDENCIAS: `payments-client.js` (window.NMPaymentsClient).
 * Expone: `window.NMPaymentsUI`.
 */

(function () {
  'use strict';

  /* ── Catálogo local (fallback; el servidor es la autoridad) ───────── */
  const LOCAL_PLANS = [
    {
      id: 'pro',
      name: 'Pro',
      amountCop: 30000,
      amountUsd: 7.5,
      credits: 500,
      featured: false,
      badge: null,
      features: [
        '500 créditos de IA cada mes',
        'Acceso a todos los modelos',
        'Historial de chats sin límites',
        'Exportación de proyectos',
      ],
    },
    {
      id: 'ultimate',
      name: 'Ultimate',
      amountCop: 45000,
      amountUsd: 11,
      credits: 1200,
      featured: true,
      badge: 'Popular',
      features: [
        '1.200 créditos de IA cada mes',
        'Todos los modelos + modo avanzado',
        'Coder en la nube sin cola',
        'Soporte prioritario 24/7',
      ],
    },
  ];

  const CONFIG = {
    CONFIG_ENDPOINT: '/api/payments/config',
    CREATE_ORDER_ENDPOINT: '/api/payments/create-order',
    CAPTURE_ORDER_ENDPOINT: '/api/payments/capture-order',
    SDK_TIMEOUT_MS: 15000,
    BUSY_ATTR: 'data-nm-pay-busy',
    OPEN_ATTR: 'data-nm-pay-open',
  };

  const state = {
    root: null,
    backdrop: null,
    modal: null,
    plans: LOCAL_PLANS.slice(),
    clientId: null,
    currency: 'USD',
    environment: 'sandbox',
    sdkPromise: null,
    ready: false,
    lastFocused: null,
    busyPlanId: null,
    orders: {},   // paypalOrderId → { orderId, planId }
  };

  const client = () => window.NMPaymentsClient;

  /* ── Helpers de DOM ───────────────────────────────────────────────── */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function moneyCop(amount) {
    const n = Number(amount) || 0;
    return '$' + n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
  }

  function moneyUsd(amount) {
    const n = Number(amount) || 0;
    return 'USD ' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function svgEl(tag, attrs) {
    const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, value));
    return node;
  }

  function closeIcon() {
    const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    svg.appendChild(svgEl('path', { d: 'M18 6 6 18M6 6l12 12' }));
    return svg;
  }

  function lockIcon() {
    const svg = svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    svg.appendChild(svgEl('rect', { x: '3', y: '11', width: '18', height: '11', rx: '2' }));
    svg.appendChild(svgEl('path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }));
    return svg;
  }

  /* ── Construcción del modal ───────────────────────────────────────── */

  function buildPlanCard(plan) {
    const card = el('article', 'nm-pay__card' + (plan.featured ? ' nm-pay__card--featured' : ''));
    card.setAttribute('data-nm-pay-plan', plan.id);

    if (plan.badge) {
      card.appendChild(el('span', 'nm-pay__badge', plan.badge));
    }

    card.appendChild(el('h3', 'nm-pay__plan', plan.name));

    const price = el('div', 'nm-pay__price');
    price.appendChild(el('span', 'nm-pay__price-main', moneyUsd(plan.amountUsd)));
    price.appendChild(el('span', 'nm-pay__price-cop', moneyCop(plan.amountCop) + ' aprox.'));
    card.appendChild(price);

    card.appendChild(el('span', 'nm-pay__credits', plan.credits + ' créditos/mes'));

    const features = el('ul', 'nm-pay__features');
    (plan.features || []).forEach((feature) => {
      features.appendChild(el('li', null, feature));
    });
    card.appendChild(features);

    const actions = el('div', 'nm-pay__actions');

    // Contenedor donde PayPal renderiza sus botones.
    const paypalHost = el('div', 'nm-pay__paypal');
    paypalHost.id = 'nm-pay-buttons-' + plan.id;
    paypalHost.setAttribute('data-nm-pay-paypal', plan.id);
    paypalHost.setAttribute(CONFIG.BUSY_ATTR, 'false');
    actions.appendChild(paypalHost);

    // Fallback visible si el SDK de PayPal no carga.
    const fallback = el('div', 'nm-pay__paypal-fallback', 'No pudimos cargar PayPal. Revisá tu conexión o recargá la página.');
    fallback.id = 'nm-pay-fallback-' + plan.id;
    fallback.setAttribute('data-nm-pay-visible', 'false');
    actions.appendChild(fallback);

    card.appendChild(actions);
    return card;
  }

  function buildModal() {
    const backdrop = el('div', 'nm-pay__backdrop');
    backdrop.setAttribute(CONFIG.OPEN_ATTR, 'false');
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.setAttribute('role', 'dialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-labelledby', 'nm-pay-title');

    const modal = el('div', 'nm-pay__modal');

    const head = el('header', 'nm-pay__head');
    const headText = el('div');
    const title = el('h2', 'nm-pay__title', 'Elegí tu plan');
    title.id = 'nm-pay-title';
    headText.appendChild(title);
    headText.appendChild(el('p', 'nm-pay__subtitle', 'Pago único con PayPal. Activás tu plan al confirmar la compra.'));
    head.appendChild(headText);

    const close = el('button', 'nm-pay__close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Cerrar');
    close.appendChild(closeIcon());
    close.addEventListener('click', () => closeModal());
    head.appendChild(close);
    modal.appendChild(head);

    const grid = el('div', 'nm-pay__grid');
    state.plans.forEach((plan) => grid.appendChild(buildPlanCard(plan)));
    modal.appendChild(grid);

    const foot = el('footer', 'nm-pay__foot');
    const trust = el('div', 'nm-pay__trust');
    trust.appendChild(lockIcon());
    trust.appendChild(el('span', null, 'Pago procesado por PayPal. Numination nunca almacena tu tarjeta.'));
    foot.appendChild(trust);
    foot.appendChild(el('span', 'nm-pay__secure', 'idempotencia · auditoría · cifrado TLS'));
    modal.appendChild(foot);

    backdrop.appendChild(modal);

    // Cerrar clickeando en el backdrop (pero no dentro del modal).
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) closeModal();
    });

    return { backdrop, modal };
  }

  function ensureRoot() {
    if (state.root && document.body.contains(state.root)) return state.root;
    let root = document.getElementById('nm-pay-root');
    if (!root) {
      root = el('div', 'nm-pay');
      root.id = 'nm-pay-root';
      document.body.appendChild(root);
    }
    state.root = root;
    return root;
  }

  /* ── Estado de bloqueo del botón (anti doble submit) ──────────────── */

  function setBusy(planId, busy) {
    const host = document.getElementById('nm-pay-buttons-' + planId);
    if (!host) return;
    host.setAttribute(CONFIG.BUSY_ATTR, busy ? 'true' : 'false');
    host.setAttribute('aria-busy', busy ? 'true' : 'false');
    state.busyPlanId = busy ? planId : null;
  }

  function isBusy(planId) {
    const host = document.getElementById('nm-pay-buttons-' + planId);
    return host ? host.getAttribute(CONFIG.BUSY_ATTR) === 'true' : false;
  }

  /* ── SDK de PayPal ────────────────────────────────────────────────── */

  function sdkUrl() {
    const host = state.environment === 'live'
      ? 'https://www.paypal.com'
      : 'https://www.sandbox.paypal.com';
    const params = [
      'client-id=' + encodeURIComponent(state.clientId || ''),
      'currency=' + encodeURIComponent(state.currency || 'USD'),
      'intent=capture',
      'commit=false',
      'components=buttons',
    ];
    return host + '/sdk/js?' + params.join('&');
  }

  function loadSdk() {
    if (state.sdkPromise) return state.sdkPromise;

    state.sdkPromise = new Promise((resolve, reject) => {
      if (!state.clientId) {
        reject(new Error('Falta el client-id de PayPal.'));
        return;
      }
      if (window.paypal && typeof window.paypal.Buttons === 'function') {
        resolve(window.paypal);
        return;
      }

      const existing = document.querySelector('script[data-nm-pay-sdk]');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.paypal));
        existing.addEventListener('error', () => reject(new Error('No se pudo cargar el SDK de PayPal.')));
        return;
      }

      const script = document.createElement('script');
      script.src = sdkUrl();
      script.async = true;
      script.defer = true;
      script.setAttribute('data-nm-pay-sdk', 'true');

      const timer = setTimeout(() => {
        reject(new Error('Timeout cargando el SDK de PayPal.'));
      }, CONFIG.SDK_TIMEOUT_MS);

      script.addEventListener('load', () => {
        clearTimeout(timer);
        if (window.paypal && typeof window.paypal.Buttons === 'function') {
          resolve(window.paypal);
        } else {
          reject(new Error('El SDK de PayPal cargó pero no expone Buttons.'));
        }
      });

      script.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('No se pudo cargar el SDK de PayPal.'));
      });

      document.head.appendChild(script);
    }).catch((err) => {
      // Permite reintentar la carga si falla una vez.
      state.sdkPromise = null;
      throw err;
    });

    return state.sdkPromise;
  }

  /* ── Flujo de compra ──────────────────────────────────────────────── */

  async function apiCreateOrder(planId) {
    const api = client();
    if (!api) throw new Error('payments-client.js no está cargado.');

    const payload = await api.post(CONFIG.CREATE_ORDER_ENDPOINT, { planId });
    if (!payload || !payload.ok || !payload.orderId || !payload.paypalOrderId) {
      throw new Error((payload && payload.error) || 'No pudimos crear la orden.');
    }
    return payload;
  }

  async function apiCaptureOrder(orderId) {
    const api = client();
    if (!api) throw new Error('payments-client.js no está cargado.');

    const payload = await api.post(CONFIG.CAPTURE_ORDER_ENDPOINT, { orderId });
    if (!payload || !payload.ok) {
      throw new Error((payload && payload.error) || 'No pudimos confirmar el pago.');
    }
    return payload;
  }

  function renderButtons(paypal, plan) {
    const host = document.getElementById('nm-pay-buttons-' + plan.id);
    if (!host) return;

    try {
      const buttons = paypal.Buttons({
        style: { layout: 'vertical', color: 'gold', shape: 'rect', label: 'paypal', height: 46 },
        createOrder: async () => {
          // 1) Se bloquea el botón ANTES de la llamada de red: sin esto,
          //    un doble clic genera dos órdenes y potentially dos cobros.
          if (isBusy(plan.id)) {
            throw new Error('Ya hay una operación en curso.');
          }
          setBusy(plan.id, true);
          try {
            const order = await apiCreateOrder(plan.id);
            state.orders[order.paypalOrderId] = { orderId: order.orderId, planId: plan.id };
            return order.paypalOrderId;
          } catch (err) {
            setBusy(plan.id, false);
            const api = client();
            if (api) api.showToast(err.message || 'Error creando la orden.', 'err');
            throw err;
          }
        },
        onApprove: async (data) => {
          try {
            const paypalOrderId = (data && data.orderID) || '';
            const known = state.orders[paypalOrderId];
            const internalOrderId = known ? known.orderId : null;

            if (!internalOrderId) {
              throw new Error('No pudimos identificar la orden a confirmar.');
            }

            const result = await apiCaptureOrder(internalOrderId);
            setBusy(plan.id, false);
            const api = client();
            if (api) api.showToast(result.message || '¡Pago confirmado! Tu plan ya está activo.', 'ok');
            closeModal();
            document.dispatchEvent(new CustomEvent('nm:payment:success', { detail: result }));
          } catch (err) {
            setBusy(plan.id, false);
            const api = client();
            if (api) api.showToast(err.message || 'Error confirmando el pago.', 'err');
            throw err;
          }
        },
        onCancel: () => {
          setBusy(plan.id, false);
          const api = client();
          if (api) api.showToast('Cancelaste el pago.', 'info');
        },
        onError: () => {
          setBusy(plan.id, false);
          const api = client();
          if (api) api.showToast('PayPal no pudo procesar el pago. Intentá de nuevo.', 'err');
        },
      });

      buttons.render(host).catch((err) => {
        const fallback = document.getElementById('nm-pay-fallback-' + plan.id);
        if (fallback) fallback.setAttribute('data-nm-pay-visible', 'true');
        const api = client();
        if (api) api.showToast(err && err.message ? err.message : 'No se pudo renderizar PayPal.', 'err');
      });
    } catch {
      const fallback = document.getElementById('nm-pay-fallback-' + plan.id);
      if (fallback) fallback.setAttribute('data-nm-pay-visible', 'true');
    }
  }

  /* ── Carga de configuración ───────────────────────────────────────── */

  async function loadConfig() {
    const api = client();
    if (!api) throw new Error('payments-client.js no está cargado.');

    const payload = await api.get(CONFIG.CONFIG_ENDPOINT, { silent: true });
    if (!payload || !payload.ok) {
      throw new Error((payload && payload.error) || 'No pudimos cargar la configuración de pagos.');
    }

    state.clientId = payload.clientId || null;
    state.currency = payload.currency || 'USD';
    state.environment = payload.environment || 'sandbox';

    if (Array.isArray(payload.plans) && payload.plans.length) {
      // El servidor es la autoridad de precios y créditos; el catálogo local
      // solo sirve de fallback cuando el backend no responde.
      state.plans = payload.plans.map((plan) => {
        const fallback = LOCAL_PLANS.find((p) => p.id === plan.id) || {};
        return {
          id: plan.id,
          name: plan.name || fallback.name || plan.id,
          amountCop: Number(plan.amountCop != null ? plan.amountCop : fallback.amountCop) || 0,
          amountUsd: Number(plan.amountUsd != null ? plan.amountUsd : fallback.amountUsd) || 0,
          credits: Number(plan.credits != null ? plan.credits : fallback.credits) || 0,
          featured: Boolean(plan.featured),
          badge: plan.badge || fallback.badge || null,
          features: Array.isArray(plan.features) && plan.features.length
            ? plan.features
            : (fallback.features || []),
        };
      });
    }

    return payload;
  }

  /* ── Render / init ────────────────────────────────────────────────── */

  function render() {
    const root = ensureRoot();
    const built = buildModal();
    state.backdrop = built.backdrop;
    state.modal = built.modal;

    const existing = root.querySelector('.nm-pay__backdrop');
    if (existing) root.removeChild(existing);

    root.appendChild(state.backdrop);

    document.addEventListener('keydown', onKeyDown);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && state.backdrop && state.backdrop.getAttribute(CONFIG.OPEN_ATTR) === 'true') {
      closeModal();
    }
  }

  function bindTriggers() {
    document.querySelectorAll('[data-open-payments]').forEach((trigger) => {
      if (trigger.getAttribute('data-nm-pay-bound') === 'true') return;
      trigger.setAttribute('data-nm-pay-bound', 'true');
      trigger.addEventListener('click', (event) => {
        event.preventDefault();
        openModal();
      });
    });
  }

  async function init() {
    try {
      await loadConfig();
    } catch (err) {
      // Fail-closed: sin clientId no hay checkout posible.
      state.plans = LOCAL_PLANS.slice();
      render();
      bindTriggers();
      const api = client();
      if (api) api.showToast(err.message || 'El checkout no está disponible en este momento.', 'err');
      return false;
    }

    render();
    bindTriggers();

    try {
      const paypal = await loadSdk();
      state.plans.forEach((plan) => renderButtons(paypal, plan));
      state.ready = true;
    } catch (err) {
      state.plans.forEach((plan) => {
        const fallback = document.getElementById('nm-pay-fallback-' + plan.id);
        if (fallback) fallback.setAttribute('data-nm-pay-visible', 'true');
      });
      const api = client();
      if (api) api.showToast(err.message || 'No pudimos cargar PayPal.', 'err');
      return false;
    }

    return true;
  }

  function openModal() {
    if (!state.backdrop) return false;
    state.lastFocused = document.activeElement;
    state.backdrop.setAttribute(CONFIG.OPEN_ATTR, 'true');
    state.backdrop.setAttribute('aria-hidden', 'false');
    const close = state.backdrop.querySelector('.nm-pay__close');
    if (close && typeof close.focus === 'function') close.focus();
    document.documentElement.style.overflow = 'hidden';
    return true;
  }

  function closeModal() {
    if (!state.backdrop) return false;
    state.backdrop.setAttribute(CONFIG.OPEN_ATTR, 'false');
    state.backdrop.setAttribute('aria-hidden', 'true');
    document.documentElement.style.overflow = '';
    if (state.lastFocused && typeof state.lastFocused.focus === 'function') {
      state.lastFocused.focus();
    }
    return true;
  }

  /* ── Bootstrap ────────────────────────────────────────────────────── */

  function bootstrap() {
    try {
      init();
    } catch {
      const api = client();
      if (api) api.showToast('No pudimos inicializar el checkout.', 'err');
    }
  }

  window.NMPaymentsUI = Object.freeze({
    init,
    open: openModal,
    close: closeModal,
    bootstrap,
    getState: () => ({
      ready: state.ready,
      plans: state.plans,
      currency: state.currency,
      environment: state.environment,
      busyPlanId: state.busyPlanId,
    }),
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
