/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · billing-ui.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Sección de facturación en los ajustes.

   Qué muestra:
     · Plan actual, créditos disponibles, total pagado y número de órdenes.
     · Historial de pagos con estado, monto, fecha y descarga de la
       factura en PDF.

   Montaje:
     window.NumBillingUI.mount('#billing-section')
   o automático si existe [data-billing] / #billing-section.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const state = {
    root: null,
    summaryEl: null,
    tableEl: null,
    summary: null,
    invoices: [],
    loading: false,
  };

  /* ─── Utilidades ────────────────────────────────────────────────────── */

  const $ = (sel) => document.querySelector(sel);

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((key) => {
        if (key === 'class') node.className = attrs[key];
        else if (key === 'text') node.textContent = attrs[key];
        else if (key === 'html') node.innerHTML = attrs[key];
        else if (key === 'style') node.setAttribute('style', attrs[key]);
        else if (key.startsWith('on') && typeof attrs[key] === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
        } else if (attrs[key] !== null && attrs[key] !== undefined) {
          node.setAttribute(key, attrs[key]);
        }
      });
    }
    (children || []).forEach((child) => {
      if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function esc(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtMoney(value, currency = 'USD') {
    const n = Number(value) || 0;
    try {
      return new Intl.NumberFormat('es-CO', { style: 'currency', currency }).format(n);
    } catch {
      return `${currency} ${n.toFixed(2)}`;
    }
  }

  function fmtNumber(n) {
    return new Intl.NumberFormat('es-CO').format(Number(n) || 0);
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(d);
  }

  function toast(message, kind = 'info') {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
      return;
    }
    console.info('[billing-ui]', kind, message);
  }

  async function api(path, options = {}) {
    const { method = 'GET', body } = options;

    if (window.NumAPI && typeof window.NumAPI.request === 'function') {
      return window.NumAPI.request(path, { method, body });
    }

    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    if (!res.ok) {
      const err = new Error(payload?.error || `Error ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  /* ─── Render ────────────────────────────────────────────────────────── */

  function statusBadge(status) {
    const s = String(status || '').toLowerCase();
    const map = {
      completed: ['green', 'Pagado'],
      created: ['muted', 'Creada'],
      pending: ['amber', 'Pendiente'],
      approved: ['cyan', 'Aprobada'],
      failed: ['red', 'Fallido'],
      refunded: ['cyan', 'Reembolsado'],
      cancelled: ['muted', 'Cancelado'],
    };
    const [cls, label] = map[s] || ['muted', s || 'Desconocido'];
    return `<span class="bill-badge bill-badge--${cls}"><span class="bill-badge__dot"></span>${esc(label)}</span>`;
  }

  function renderSummary() {
    const host = state.summaryEl;
    if (!host) return;

    const s = state.summary || {};
    const credits = s.credits || {};
    const totals = s.totals || {};

    const cards = [
      { label: 'Plan actual', value: esc(String(s.plan || 'free').toUpperCase()), foot: s.subscription ? `Renueva ${fmtDate(s.subscription.renews_at)}` : 'Sin suscripción activa' },
      { label: 'Créditos disponibles', value: fmtNumber(credits.balance), foot: `${fmtNumber(credits.lifetime)} acumulados` },
      { label: 'Total pagado', value: fmtMoney(totals.paid, totals.currency || 'USD'), foot: `${fmtNumber(totals.orders)} órdenes` },
      { label: 'Facturas', value: fmtNumber(state.invoices.length), foot: 'Descargables en PDF' },
    ];

    host.innerHTML = cards.map((card) => `
      <div class="bill-stat">
        <div class="bill-stat__label">${card.label}</div>
        <div class="bill-stat__value">${card.value}</div>
        <div class="bill-stat__foot">${card.foot}</div>
      </div>`).join('');
  }

  function renderTable() {
    const host = state.tableEl;
    if (!host) return;

    if (!state.invoices.length) {
      host.innerHTML = `
        <div class="bill-empty">
          <span class="bill-empty__icon">🧾</span>
          Todavía no tenés facturas. Cuando hagas un pago, aparecen acá.
        </div>`;
      return;
    }

    host.innerHTML = `
      <table class="bill-table">
        <thead>
          <tr>
            <th>Factura</th>
            <th>Plan</th>
            <th>Estado</th>
            <th class="num">Monto</th>
            <th class="num">Créditos</th>
            <th>Fecha</th>
            <th style="text-align:right">Documento</th>
          </tr>
        </thead>
        <tbody>
          ${state.invoices.map((inv) => `
            <tr>
              <td class="mono">${esc(inv.number || inv.id)}</td>
              <td><span class="bill-chip">${esc(inv.planId || '—')}</span></td>
              <td>${statusBadge(inv.status)}</td>
              <td class="num">${esc(fmtMoney(inv.amountUsd, inv.currency || 'USD'))}</td>
              <td class="num">${esc(fmtNumber(inv.credits))}</td>
              <td class="muted nowrap">${esc(fmtDate(inv.createdAt))}</td>
              <td style="text-align:right">
                <a class="bill-btn bill-btn--primary" href="${esc(inv.pdfUrl || `/api/billing/invoices/${inv.id}/pdf`)}" download>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                    <path d="M7 10l5 5 5-5"></path><path d="M12 15V3"></path>
                  </svg>
                  <span>PDF</span>
                </a>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  /* ─── Datos ─────────────────────────────────────────────────────────── */

  async function load() {
    if (state.loading) return;
    state.loading = true;

    if (state.tableEl) {
      state.tableEl.innerHTML = '<div class="bill-skeleton"></div><div class="bill-skeleton"></div><div class="bill-skeleton"></div>';
    }

    try {
      const [summary, invoices] = await Promise.all([
        api('/api/billing/summary').catch(() => null),
        api('/api/billing/invoices?limit=50').catch(() => null),
      ]);

      state.summary = summary;
      state.invoices = Array.isArray(invoices?.invoices) ? invoices.invoices : [];

      renderSummary();
      renderTable();
    } catch (e) {
      toast(e.message || 'No se pudo cargar la facturación.', 'error');
      if (state.tableEl) {
        state.tableEl.innerHTML = `<div class="bill-empty"><span class="bill-empty__icon">⚠</span>${esc(e.message || 'Error al cargar')}</div>`;
      }
    } finally {
      state.loading = false;
    }
  }

  /* ─── Montaje ───────────────────────────────────────────────────────── */

  function mount(target) {
    const container = typeof target === 'string' ? $(target) : target;
    if (!container) return null;
    if (state.root && state.root.isConnected) return state.root;

    const summary = el('div', { class: 'bill-stats' });
    const table = el('div', { class: 'bill-table-wrap' });

    state.summaryEl = summary;
    state.tableEl = table;

    const root = el('div', { class: 'bill-root' }, [
      el('div', { class: 'bill-head' }, [
        el('div', {}, [
          el('h2', { class: 'bill-title', text: 'Facturación' }),
          el('p', { class: 'bill-subtitle', text: 'Tu historial de pagos y las facturas en PDF.' }),
        ]),
        el('button', {
          class: 'bill-btn',
          type: 'button',
          text: 'Actualizar',
          onclick: () => load(),
        }),
      ]),
      summary,
      el('div', { class: 'bill-panel' }, [table]),
    ]);

    container.appendChild(root);
    state.root = root;

    load();
    return root;
  }

  /* ─── API pública ───────────────────────────────────────────────────── */

  window.NumBillingUI = {
    mount,
    load,
    get summary() { return state.summary; },
    get invoices() { return state.invoices.slice(); },
  };

  document.addEventListener('DOMContentLoaded', () => {
    const target = document.querySelector('[data-billing]') || document.getElementById('billing-section');
    if (target) mount(target);
  });
})();
