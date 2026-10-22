/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/invoice-generator.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Generador de facturas PDF con PDFKit.

   FLUJO
     1. PayPal confirma el pago → el webhook dispara el evento
        `payment.capture.completed`.
     2. Este servicio escucha ese evento, genera el PDF en memoria y
        guarda el registro de la factura en la base.
     3. El usuario la descarga desde /api/billing/invoices/:id/pdf.

   POR QUÉ PDFKIT Y NO UNA LIBRERIA DE FACTURACIÓN
     · Cero dependencias externas: el PDF se arma en el servidor.
     · El logo va incrustado (leído del disco en el arranque, cacheado en
       memoria) → no hay peticiones a un CDN en cada factura.
     · Si el logo no está, se dibuja el wordmark: la factura NUNCA sale
       sin marca.

   AISLAMIENTO DE RUTA
     `generateInvoiceBuffer` recibe el pago YA VALIDADO por el caller
     (que lo pide con `where user_id = $2`). Este servicio no consulta
     la base por su cuenta: es un renderizador puro.
   ═══════════════════════════════════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const CFG = Object.freeze({
  logoCandidates: [
    path.join(ROOT, 'public', 'assets', 'img', 'logo.png'),
    path.join(ROOT, 'public', 'assets', 'img', 'logo-n.png'),
  ],
  brand: {
    name: 'NUMINATION',
    tagline: 'Inteligencia artificial para pensar mejor',
    bg: '#0a0a0c',
    primary: '#8b5cf6',
    text: '#1a1a24',
    muted: '#6b6b7b',
    line: '#e6e6ee',
  },
  footer: 'Documento generado automáticamente por Numination · Sin valor fiscal',
});

let pdfkit = null;
try {
  const mod = await import('pdfkit');
  pdfkit = mod.default || mod;
} catch (e) {
  LOG.warn('invoice-generator: pdfkit no está instalado', { error: e.message });
}

/* ─── Logo cacheado ──────────────────────────────────────────────────────── */

let logoBuffer = null;
let logoChecked = false;

function getLogo() {
  if (logoChecked) return logoBuffer;
  logoChecked = true;

  for (const candidate of CFG.logoCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        logoBuffer = fs.readFileSync(candidate);
        return logoBuffer;
      }
    } catch (e) {
      LOG.debug('invoice-generator: no se pudo leer el logo', { path: candidate, error: e.message });
    }
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

function fmtMoney(value, currency = 'USD') {
  const n = Number(value) || 0;
  try {
    return new Intl.NumberFormat('es-CO', { style: 'currency', currency }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('es-CO', { dateStyle: 'long' }).format(d);
}

function invoiceNumber(payment) {
  const base = String(payment?.id || crypto.randomUUID()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase();
  return `NM-${base}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · GENERACIÓN DEL PDF
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Genera el PDF de una factura.
 *
 * @param {object} params
 * @param {object} params.payment  { id, amount, currency, credits_granted, package_id, status, paypal_order_id, created_at, completed_at }
 * @param {object} [params.profile] { name, email }
 * @returns {Promise<{ok:boolean, buffer?:Buffer, filename?:string, number?:string, error?:string}>}
 */
export async function generateInvoiceBuffer(params = {}) {
  const payment = params.payment || {};
  const profile = params.profile || {};

  if (!payment.id) {
    return { ok: false, error: 'Falta el pago para generar la factura.' };
  }

  if (!pdfkit) {
    return { ok: false, error: 'El generador de PDF no está disponible (falta pdfkit).' };
  }

  const number = invoiceNumber(payment);
  const currency = payment.currency || 'USD';
  const amount = Number(payment.amount || 0);
  const createdAt = payment.completed_at || payment.created_at;
  const planName = payment.package_id || 'Numination';

  try {
    const buffer = await new Promise((resolve, reject) => {
      const doc = new pdfkit({ size: 'A4', margin: 52, info: {
        Title: `Factura ${number}`,
        Author: CFG.brand.name,
        Subject: `Factura ${number}`,
      } });

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageW = doc.page.width;

      /* ── Encabezado de marca ───────────────────────────────────────── */
      doc.rect(0, 0, pageW, 108).fill(CFG.brand.bg);

      const logo = getLogo();
      if (logo) {
        try {
          doc.image(logo, 52, 30, { fit: [46, 46], align: 'center', valign: 'center' });
        } catch (e) {
          LOG.debug('invoice-generator: no se pudo incrustar el logo', { error: e.message });
        }
      }

      const brandX = logo ? 110 : 52;

      doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(19)
        .text(CFG.brand.name, brandX, 32);
      doc.font('Helvetica').fontSize(8.5).fillColor('#b9b9c8')
        .text(CFG.brand.tagline, brandX, 56, { width: 260 });

      doc.font('Helvetica-Bold').fontSize(11).fillColor('#ffffff')
        .text('FACTURA', 0, 38, { width: pageW - 52, align: 'right' });
      doc.font('Helvetica').fontSize(9).fillColor('#b9b9c8')
        .text(number, 0, 56, { width: pageW - 52, align: 'right' });

      /* ── Datos ─────────────────────────────────────────────────────── */
      let y = 146;

      const cols = [
        { label: 'FACTURA', value: number },
        { label: 'FECHA', value: fmtDate(createdAt) },
        { label: 'CLIENTE', value: profile.name || profile.email || 'Usuario Numination' },
        { label: 'CORREO', value: profile.email || '—' },
        { label: 'PLAN', value: planName },
        { label: 'MÉTODO', value: payment.provider || 'paypal' },
      ];

      const colW = (pageW - 104) / 3;

      cols.forEach((col, i) => {
        const x = 52 + colW * (i % 3);
        const yy = y + Math.floor(i / 3) * 56;
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(CFG.brand.primary)
          .text(col.label, x, yy, { characterSpacing: 0.6 });
        doc.font('Helvetica').fontSize(10).fillColor(CFG.brand.text)
          .text(String(col.value), x, yy + 13, { width: colW - 12 });
      });

      y += Math.ceil(cols.length / 3) * 56 + 18;

      /* ── Conceptos ──────────────────────────────────────────────────── */
      doc.moveTo(52, y).lineTo(pageW - 52, y).lineWidth(1).strokeColor(CFG.brand.line).stroke();
      y += 16;

      doc.font('Helvetica-Bold').fontSize(8).fillColor(CFG.brand.muted)
        .text('CONCEPTOS', 52, y, { characterSpacing: 0.6 });
      y += 18;

      const items = [
        {
          description: `Plan ${planName}`,
          detail: `${Number(payment.credits_granted || 0)} créditos · estado ${payment.status || 'completed'}`,
          amount: fmtMoney(amount, currency),
        },
        {
          description: 'Créditos acreditados',
          detail: 'Disponibles de inmediato en tu cuenta',
          amount: String(Number(payment.credits_granted || 0)),
        },
        {
          description: 'Orden de referencia',
          detail: String(payment.paypal_order_id || payment.id),
          amount: '',
        },
      ];

      items.forEach((item) => {
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(CFG.brand.text)
          .text(item.description, 52, y, { width: 300 });
        doc.font('Helvetica').fontSize(8.5).fillColor(CFG.brand.muted)
          .text(item.detail, 52, y + 15, { width: 300 });
        if (item.amount) {
          doc.font('Helvetica').fontSize(10.5).fillColor(CFG.brand.text)
            .text(item.amount, 360, y, { width: pageW - 412, align: 'right' });
        }
        y += 42;
        doc.moveTo(52, y - 12).lineTo(pageW - 52, y - 12).lineWidth(0.5).strokeColor('#f0f0f5').stroke();
      });

      /* ── Total ──────────────────────────────────────────────────────── */
      y += 6;
      doc.moveTo(pageW - 52 - 200, y).lineTo(pageW - 52, y).lineWidth(1.2).strokeColor(CFG.brand.bg).stroke();
      y += 16;

      doc.font('Helvetica-Bold').fontSize(9).fillColor(CFG.brand.muted)
        .text('TOTAL', pageW - 52 - 200, y, { width: 110 });
      doc.font('Helvetica-Bold').fontSize(16).fillColor(CFG.brand.bg)
        .text(fmtMoney(amount, currency), pageW - 52 - 140, y - 5, { width: 140, align: 'right' });

      /* ── Pie ───────────────────────────────────────────────────────── */
      const footY = doc.page.height - 92;
      doc.moveTo(52, footY).lineTo(pageW - 52, footY).lineWidth(0.5).strokeColor(CFG.brand.line).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(CFG.brand.muted)
        .text(CFG.footer, 52, footY + 12, { width: pageW - 104, align: 'center' });
      doc.fontSize(7)
        .text(`Generada el ${fmtDate(new Date())} · ${number}`, 52, footY + 26, { width: pageW - 104, align: 'center' });

      doc.end();
    });

    return {
      ok: true,
      buffer,
      filename: `numination-${number}.pdf`,
      number,
      bytes: buffer.length,
    };
  } catch (e) {
    LOG.error('invoice-generator: falló la generación', { error: e.message });
    return { ok: false, error: 'No se pudo generar la factura.' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · ESCUCHA DEL EVENTO DE PAGO
   ═══════════════════════════════════════════════════════════════════════════ */

const listeners = new Map();

/**
 * Registra un handler para un evento del generador.
 * @param {string} event
 * @param {function} handler
 */
export function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(handler);
  return () => listeners.get(event)?.delete(handler);
}

export async function emit(event, payload = {}) {
  const set = listeners.get(event);
  if (!set || !set.size) return { ok: true, handled: 0 };

  const results = await Promise.allSettled(
    Array.from(set).map((fn) => fn(payload))
  );

  return {
    ok: results.every((r) => r.status === 'fulfilled'),
    handled: results.length,
    errors: results.filter((r) => r.status === 'rejected').length,
  };
}

export const EVENTS = Object.freeze({
  PAYMENT_CAPTURE_COMPLETED: 'PAYMENT.CAPTURE.COMPLETED',
  PAYMENT_REFUNDED: 'PAYMENT.REFUNDED',
  INVOICE_GENERATED: 'invoice.generated',
});

/**
 * Conecta el generador con el motor de notificaciones para que el
 * evento de PayPal dispare la factura automáticamente.
 *
 * Se llama una vez desde src/index.js.
 */
export async function connectPaymentEvents() {
  try {
    const engine = await import('./notification-engine.js');

    await engine.on(engine.EVENTS.PAYMENT_COMPLETED, async ({ payload }) => {
      await emit(EVENTS.PAYMENT_CAPTURE_COMPLETED, payload);
    });

    await engine.on(engine.EVENTS.PAYMENT_REFUNDED, async ({ payload }) => {
      await emit(EVENTS.PAYMENT_REFUNDED, payload);
    });

    LOG.info('invoice-generator: eventos de pago conectados');
    return { ok: true };
  } catch (e) {
    LOG.warn('invoice-generator: no se pudieron conectar los eventos', { error: e.message });
    return { ok: false, error: e.message };
  }
}

/**
 * Genera la factura de un pago y la deja "lista" para descargar.
 * (No se guarda el PDF en disco: se regenera al vuelo desde la orden.)
 */
export async function generateForPayment(payment, profile = {}) {
  const result = await generateInvoiceBuffer({ payment, profile });

  if (result.ok) {
    await emit(EVENTS.INVOICE_GENERATED, {
      paymentId: payment?.id,
      number: result.number,
      bytes: result.bytes,
    });
  }

  return result;
}

export function getInvoiceGeneratorStatus() {
  return {
    engine: pdfkit ? 'pdfkit' : 'unavailable',
    logoEmbedded: Boolean(getLogo()),
    brand: CFG.brand.name,
    events: Object.values(EVENTS),
  };
}

export default {
  generateInvoiceBuffer,
  generateForPayment,
  connectPaymentEvents,
  on,
  emit,
  getInvoiceGeneratorStatus,
  EVENTS,
};
