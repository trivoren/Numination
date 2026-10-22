/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/invoice-generator.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Genera recibos en PDF totalmente en memoria (sin escribir a disco).

   ENTRADA
     payment = {
       id, amount, currency, status, method, description, createdAt,
       customer: { name, email },
       items: [{ description, quantity, price }]
     }

   SALIDA
     Promise<Buffer> con el PDF listo para enviar por email o descargar.

   NOTA
     Si `items` no viene, se genera una única línea con el total del
     pago, para que el recibo siempre tenga el desglose mínimo.
   ═══════════════════════════════════════════════════════════════════════ */

import PDFDocument from 'pdfkit';
import { LOG } from '../src/lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  company: 'Numination',
  companyEmail: 'numination@outlook.es',
  currency: 'EUR',
  locale: 'es-ES',
  footer: 'Gracias por usar Numination. Este documento se ha generado automáticamente.',
});

const COLORS = {
  ink: '#111827',
  muted: '#6b7280',
  line: '#e5e7eb',
  accent: '#2563eb',
};

/* ═══════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Formatea un importe con el símbolo de la moneda.
 * @param {number} amount
 * @param {string} [currency]
 * @returns {string}
 */
export function formatCurrency(amount, currency = CFG.currency) {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '0,00 €';

  try {
    return new Intl.NumberFormat(CFG.locale, {
      style: 'currency',
      currency: String(currency || CFG.currency).toUpperCase(),
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date ?? Date.now());
  if (Number.isNaN(d.getTime())) return '—';

  try {
    return new Intl.DateTimeFormat(CFG.locale, {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function safeText(value, fallback = '—') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

/**
 * Normaliza el objeto de pago a la forma que usa la plantilla.
 * @param {object} payment
 * @returns {object}
 */
export function normalizePayment(payment = {}) {
  const amount = Number(payment.amount ?? payment.total ?? 0);
  const currency = String(payment.currency ?? CFG.currency).toUpperCase();

  const items = Array.isArray(payment.items) && payment.items.length
    ? payment.items.map((item) => ({
        description: safeText(item?.description ?? item?.name, 'Concepto'),
        quantity: Math.max(1, Number(item?.quantity ?? 1) || 1),
        price: Number(item?.price ?? item?.unitPrice ?? 0) || 0,
      }))
    : [{
        description: safeText(payment.description ?? payment.plan, 'Suscripción Numination'),
        quantity: 1,
        price: amount,
      }];

  const total = items.reduce((acc, item) => acc + item.quantity * item.price, 0) || amount;

  return {
    id: safeText(payment.id ?? payment.paymentId, '—'),
    amount,
    total,
    currency,
    status: safeText(payment.status, 'paid'),
    method: safeText(payment.method ?? payment.provider, '—'),
    description: safeText(payment.description ?? payment.plan, 'Suscripción Numination'),
    createdAt: payment.createdAt ?? payment.created_at ?? new Date(),
    customer: {
      name: safeText(payment.customer?.name ?? payment.name ?? payment.email, 'Cliente'),
      email: safeText(payment.customer?.email ?? payment.email, ''),
    },
    items,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   03 · PLANTILLA
   ═══════════════════════════════════════════════════════════════════════ */

function drawHeader(doc, data) {
  doc
    .fillColor(COLORS.accent)
    .fontSize(22)
    .font('Helvetica-Bold')
    .text(CFG.company, 50, 50);

  doc
    .fillColor(COLORS.muted)
    .fontSize(9)
    .font('Helvetica')
    .text(CFG.companyEmail, 50, 78);

  doc
    .fillColor(COLORS.ink)
    .fontSize(18)
    .font('Helvetica-Bold')
    .text('FACTURA / RECIBO', 0, 50, { align: 'right', width: 545 });

  doc
    .fillColor(COLORS.muted)
    .fontSize(9)
    .font('Helvetica')
    .text(`Nº ${data.id}`, 0, 76, { align: 'right', width: 545 })
    .text(`Fecha: ${formatDate(data.createdAt)}`, 0, 90, { align: 'right', width: 545 });

  doc.moveTo(50, 112).lineTo(545, 112).strokeColor(COLORS.line).lineWidth(1).stroke();
  doc.y = 130;
}

function drawCustomer(doc, data) {
  doc.fillColor(COLORS.ink).fontSize(10).font('Helvetica-Bold').text('CLIENTE');

  doc
    .fillColor(COLORS.muted)
    .fontSize(10)
    .font('Helvetica')
    .text(data.customer.name)
    .text(data.customer.email);

  doc.moveDown(1);
}

function drawItems(doc, data) {
  const startX = 50;
  const colQty = startX;
  const colDesc = startX + 50;
  const colPrice = startX + 360;
  const colTotal = startX + 460;

  doc.fillColor(COLORS.ink).fontSize(9).font('Helvetica-Bold');
  doc.text('CANT.', colQty, doc.y, { width: 45 });
  doc.text('CONCEPTO', colDesc, doc.y, { width: 300 });
  doc.text('PRECIO', colPrice, doc.y, { width: 90, align: 'right' });
  doc.text('IMPORTE', colTotal, doc.y, { width: 85, align: 'right' });

  doc.moveDown(0.6);
  const lineY = doc.y;
  doc.moveTo(startX, lineY).lineTo(545, lineY).strokeColor(COLORS.line).lineWidth(1).stroke();
  doc.y = lineY + 8;

  for (const item of data.items) {
    const rowTop = doc.y;

    doc.fillColor(COLORS.ink).fontSize(10).font('Helvetica');
    doc.text(String(item.quantity), colQty, rowTop, { width: 45 });
    doc.text(item.description, colDesc, rowTop, { width: 300 });
    doc.text(formatCurrency(item.price, data.currency), colPrice, rowTop, { width: 90, align: 'right' });
    doc.text(
      formatCurrency(item.quantity * item.price, data.currency),
      colTotal, rowTop, { width: 85, align: 'right' }
    );

    doc.y = rowTop + Math.max(16, doc.heightOfString(item.description, { width: 300 }) + 6);
  }

  const totalY = doc.y + 8;
  doc.moveTo(colPrice, totalY).lineTo(545, totalY).strokeColor(COLORS.line).lineWidth(1).stroke();

  doc
    .fillColor(COLORS.ink)
    .fontSize(11)
    .font('Helvetica-Bold')
    .text('TOTAL', colPrice, totalY + 10, { width: 90, align: 'right' })
    .text(formatCurrency(data.total, data.currency), colTotal, totalY + 10, { width: 85, align: 'right' });

  doc.y = totalY + 40;
}

function drawMeta(doc, data) {
  doc.fillColor(COLORS.ink).fontSize(9).font('Helvetica-Bold').text('DETALLES DEL PAGO');

  doc
    .fillColor(COLORS.muted)
    .fontSize(9)
    .font('Helvetica')
    .text(`Estado: ${data.status}`)
    .text(`Método: ${data.method}`)
    .text(`Concepto: ${data.description}`);

  doc.moveDown(1);
}

function drawFooter(doc) {
  const y = 720;
  doc.moveTo(50, y).lineTo(545, y).strokeColor(COLORS.line).lineWidth(1).stroke();
  doc
    .fillColor(COLORS.muted)
    .fontSize(8)
    .font('Helvetica')
    .text(CFG.footer, 50, y + 10, { width: 495, align: 'center' });
}

/* ═══════════════════════════════════════════════════════════════════════
   04 · GENERADOR
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Genera el PDF del recibo en memoria.
 *
 * @param {object} payment
 * @param {object} [options]
 * @param {string} [options.filename]  Nombre sugerido del fichero.
 * @returns {Promise<{buffer:Buffer, filename:string, invoiceId:string}>}
 */
export async function generateInvoice(payment, options = {}) {
  const data = normalizePayment(payment);

  try {
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: {
      Title: `Factura ${data.id}`,
      Author: CFG.company,
      Subject: 'Recibo de pago',
    } });

    const chunks = [];
    const bufferPromise = new Promise((resolve, reject) => {
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (error) => reject(error));
    });

    drawHeader(doc, data);
    drawCustomer(doc, data);
    drawItems(doc, data);
    drawMeta(doc, data);
    drawFooter(doc);

    doc.end();

    const buffer = await bufferPromise;
    const filename = options.filename
      ? String(options.filename)
      : `numination-factura-${data.id}.pdf`.replace(/[^\w.\-]+/g, '_');

    return { buffer, filename, invoiceId: data.id };
  } catch (e) {
    LOG.error('invoice-generator: no se pudo generar el PDF', { error: e.message });
    const error = new Error('No se pudo generar la factura en PDF.');
    error.code = 'INVOICE_GENERATION_FAILED';
    error.cause = e;
    throw error;
  }
}

/**
 * Devuelve únicamente el Buffer del PDF.
 * @param {object} payment
 * @returns {Promise<Buffer>}
 */
export async function generateInvoiceBuffer(payment) {
  const { buffer } = await generateInvoice(payment);
  return buffer;
}

export default {
  generateInvoice,
  generateInvoiceBuffer,
  formatCurrency,
  normalizePayment,
};
