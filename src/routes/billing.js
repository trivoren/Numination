/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/billing.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Facturación: historial de pagos y descarga de facturas en PDF.

   MONTADO
     mountBillingRoutes(app) → añade:
       GET /api/billing/summary          plan, créditos, totales
       GET /api/billing/invoices          lista de facturas del usuario
       GET /api/billing/invoices/:id/pdf  descarga la factura en PDF
       GET /api/billing/credits           saldo de créditos

   GENERACIÓN DEL PDF
     1 · pdfkit (si está instalado): maquetación rica con logo, tablas.
     2 · escritor PDF propio (si no): genera un PDF 1.4 válido con
         Helvetica/Helvetica-Bold, una página A4, encabezado, tabla de
         conceptos y pie con el total. Sin dependencias, sin NaN en el
         archivo, con los offsets del xref calculados byte a byte.

   AISLAMIENTO
   La factura se genera a partir de una orden que debe pertenecer al
   usuario de la sesión: `where id = $1 and user_id = $2`. Pedir el PDF
   de la factura de otro devuelve 404.
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import { sql, supabaseDisponible } from '../services/supabase.js';

const PAYMENTS_TABLE = 'payments';
const CREDITS_TABLE = 'credits';
const SUBSCRIPTIONS_TABLE = 'subscriptions';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) {
  return UUID_RE.test(String(v || ''));
}

function readInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

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

/* ═══════════════════════════════════════════════════════════════════════════
   01 · ESCRITOR PDF PROPIO (respaldo sin dependencias)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Escapa una cadena para un literal PDF.
 */
function pdfEscape(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    // Los caracteres fuera de Latin-1 se reemplazan (el PDF base no usa UTF-8).
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
}

/**
 * Genera un PDF 1.4 de una página con bloques de texto.
 *
 * @param {object} opts
 * @param {string} opts.title
 * @param {Array<{label:string, value:string}>} opts.fields  Pares clave/valor
 * @param {Array<{description:string, detail:string, amount:string}>} opts.items
 * @param {string} opts.total
 * @param {string} opts.footer
 * @returns {Buffer}
 */
export function buildInvoicePdf(opts = {}) {
  const {
    title = 'Factura',
    subtitle = '',
    fields = [],
    items = [],
    total = '',
    footer = '',
  } = opts;

  const PAGE_W = 595.28;   // A4
  const PAGE_H = 841.89;
  const MARGIN = 48;

  const ops = [];
  let y = PAGE_H - MARGIN;

  const text = (value, x, size, bold = false, gray = 0) => {
    ops.push(
      'BT',
      `${gray} ${gray} ${gray} rg`,
      `/${bold ? 'F2' : 'F1'} ${size} Tf`,
      `${x} ${y} Td`,
      `(${pdfEscape(value)}) Tj`,
      'ET'
    );
  };

  const line = (x1, y1, x2, y2, gray = 0.85, width = 0.6) => {
    ops.push(`${gray} ${gray} ${gray} RG`, `${width} w`, `${x1} ${y1} m`, `${x2} ${y2} l`, 'S');
  };

  // ── Encabezado ──────────────────────────────────────────────────────
  ops.push('0.09 0.09 0.11 rg', `0 ${PAGE_H - 96} 595.28 96 re`, 'f');
  text('NUMINATION', MARGIN, 22, true, 1);
  text(title.toUpperCase(), MARGIN, 11, false, 0.75);
  if (subtitle) {
    y = PAGE_H - MARGIN + 28;
    text(subtitle, MARGIN, 10, false, 0.75);
  }

  // ── Datos ───────────────────────────────────────────────────────────
  y = PAGE_H - 150;
  let col = MARGIN;
  const colWidth = (PAGE_W - MARGIN * 2) / 3;

  fields.forEach((field, index) => {
    const c = index % 3;
    const r = Math.floor(index / 3);
    const x = MARGIN + colWidth * c;
    const yy = y - r * 54;

    text(String(field.label || '').toUpperCase(), x, yy, true, 0.45);
    ops.push('BT', '0 0 0 rg', '/F1 11 Tf', `${x} ${yy - 18} Td`, `(${pdfEscape(field.value)}) Tj`, 'ET');
  });

  // ── Tabla de conceptos ──────────────────────────────────────────────
  const rows = items.length ? items : [{ description: 'Sin conceptos', detail: '', amount: '—' }];
  let tableY = Math.min(y - Math.ceil(fields.length / 3) * 54 - 30, PAGE_H - 300);

  text('CONCEPTOS', MARGIN, tableY, true, 0.4);
  tableY -= 8;
  line(MARGIN, tableY, PAGE_W - MARGIN, tableY, 0.8);
  tableY -= 22;

  rows.forEach((item) => {
    text(String(item.description || ''), MARGIN, tableY, true, 0.1);
    if (item.detail) {
      text(String(item.detail), MARGIN, tableY - 14, false, 0.45);
    }
    const amount = String(item.amount || '');
    const amountX = PAGE_W - MARGIN - amount.length * 6.2;
    ops.push('BT', '0 0 0 rg', '/F1 11 Tf', `${amountX} ${tableY} Td`, `(${pdfEscape(amount)}) Tj`, 'ET');

    tableY -= 34;
    line(MARGIN, tableY + 12, PAGE_W - MARGIN, tableY + 12, 0.93);
  });

  // ── Total ───────────────────────────────────────────────────────────
  tableY -= 6;
  line(PAGE_W - MARGIN - 220, tableY, PAGE_W - MARGIN, tableY, 0.4, 1);
  tableY -= 24;
  text('TOTAL', PAGE_W - MARGIN - 220, tableY, true, 0.1);

  const totalStr = String(total || '');
  ops.push('BT', '0.09 0.09 0.11 rg', '/F2 14 Tf', `${PAGE_W - MARGIN - totalStr.length * 8} ${tableY} Td`, `(${pdfEscape(totalStr)}) Tj`, 'ET');

  // ── Pie ─────────────────────────────────────────────────────────────
  const footerY = MARGIN + 26;
  line(MARGIN, footerY + 18, PAGE_W - MARGIN, footerY + 18, 0.9);
  text(String(footer || ''), MARGIN, footerY, false, 0.45);

  const content = ops.join('\n');

  /* ── Ensamblado del archivo ────────────────────────────────────────── */
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      '/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];

  const chunks = [];
  let offset = 0;
  const push = (str) => {
    const buf = Buffer.from(str, 'latin1');
    chunks.push(buf);
    offset += buf.length;
  };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    push(`${index + 1} 0 obj\n${body}\nendobj\n`);
  });

  const xrefStart = offset;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  push(xref);

  return Buffer.concat(chunks);
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · PDFKIT (opcional)
   ═══════════════════════════════════════════════════════════════════════════ */

let pdfkit = null;
try {
  const mod = await import('pdfkit');
  pdfkit = mod.default || mod;
} catch (e) {
  LOG.info('billing.routes: pdfkit no está instalado, se usa el escritor PDF propio', {
    error: e.message,
  });
}

function buildInvoiceWithPdfkit(opts = {}) {
  return new Promise((resolve, reject) => {
    const doc = new pdfkit({ size: 'A4', margin: 48, info: { Title: opts.title || 'Factura Numination' } });
    const chunks = [];

    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.rect(0, 0, doc.page.width, 96).fill('#17171d');
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold').text('NUMINATION', 48, 34);
    doc.fontSize(10).font('Helvetica').fillColor('#b8b8c6')
      .text(String(opts.title || 'Factura').toUpperCase(), 48, 62);

    doc.fillColor('#111118').fontSize(11).font('Helvetica-Bold');
    let y = 140;
    (opts.fields || []).forEach((field, index) => {
      const x = 48 + (index % 3) * 170;
      const yy = y + Math.floor(index / 3) * 54;
      doc.fontSize(8).fillColor('#8a8a9c').text(String(field.label || '').toUpperCase(), x, yy);
      doc.fontSize(11).fillColor('#111118').text(String(field.value || ''), x, yy + 14, { width: 160 });
    });

    y += Math.ceil((opts.fields || []).length / 3) * 54 + 20;

    doc.fontSize(8).fillColor('#8a8a9c').font('Helvetica-Bold').text('CONCEPTOS', 48, y);
    doc.moveTo(48, y + 8).lineTo(doc.page.width - 48, y + 8).lineWidth(0.6).strokeColor('#d8d8e2').stroke();
    y += 26;

    (opts.items || []).forEach((item) => {
      doc.fontSize(11).fillColor('#111118').font('Helvetica-Bold').text(String(item.description || ''), 48, y);
      if (item.detail) {
        doc.fontSize(9).fillColor('#6a6a7c').font('Helvetica').text(String(item.detail), 48, y + 15, { width: 320 });
      }
      doc.fontSize(11).fillColor('#111118').font('Helvetica')
        .text(String(item.amount || ''), 380, y, { width: 167, align: 'right' });
      y += 38;
      doc.moveTo(48, y - 10).lineTo(doc.page.width - 48, y - 10).lineWidth(0.4).strokeColor('#ededf2').stroke();
    });

    y += 10;
    doc.moveTo(375, y).lineTo(doc.page.width - 48, y).lineWidth(1).strokeColor('#17171d').stroke();
    y += 16;
    doc.fontSize(10).fillColor('#111118').font('Helvetica-Bold').text('TOTAL', 375, y);
    doc.fontSize(14).text(String(opts.total || ''), 420, y - 4, { width: 127, align: 'right' });

    doc.fontSize(8).fillColor('#8a8a9c').font('Helvetica')
      .text(String(opts.footer || ''), 48, doc.page.height - 80, { width: doc.page.width - 96 });

    doc.end();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · DATOS
   ═══════════════════════════════════════════════════════════════════════════ */

async function getPayment(userId, paymentId) {
  if (!supabaseDisponible()) return null;

  const rows = await sql`
    select
      id::text as id,
      user_id::text as user_id,
      package_id,
      status,
      amount,
      currency,
      credits_granted,
      paypal_order_id,
      provider,
      provider_order_id,
      created_at,
      completed_at
    from ${sql(PAYMENTS_TABLE)}
    where id = ${paymentId}::uuid
      and user_id = ${userId}::uuid
    limit 1
  `;

  return rows.length ? rows[0] : null;
}

async function getUserProfile(userId) {
  if (!supabaseDisponible()) return null;

  const rows = await sql`
    select
      id::text as id,
      email,
      coalesce("displayName", name) as name,
      coalesce(tier, plan, 'free') as plan
    from public.profiles
    where id = ${userId}::uuid
    limit 1
  `;

  return rows.length ? rows[0] : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · RUTAS
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountBillingRoutes(app) {
  const router = express.Router();

  /* ─── GET /api/billing/summary ─────────────────────────────────────── */
  router.get('/api/billing/summary', requireAuth, asyncHandler(async (req, res) => {
    if (!supabaseDisponible()) {
      return res.json({
        ok: true,
        degraded: true,
        plan: req.user.plan || 'free',
        role: req.user.role,
        credits: { balance: 0, lifetime: 0 },
        totals: { paid: 0, orders: 0, currency: 'USD' },
        subscription: null,
      });
    }

    try {
      const [creditRows, subRows, totalRows] = await Promise.all([
        sql`
          select coalesce(balance, 0)::int as balance
          from ${sql(CREDITS_TABLE)}
          where user_id = ${req.user.id}::uuid
          limit 1
        `,
        sql`
          select
            coalesce(paypal_subscription_id, id::text) as id,
            status,
            current_period_end,
            created_at
          from ${sql(SUBSCRIPTIONS_TABLE)}
          where user_id = ${req.user.id}::uuid
            and status = 'active'
          order by created_at desc
          limit 1
        `,
        sql`
          select
            coalesce(sum(amount), 0)::numeric(14,2) as paid,
            count(*)::int as orders
          from ${sql(PAYMENTS_TABLE)}
          where user_id = ${req.user.id}::uuid
            and status = 'completed'
        `,
      ]);

      res.json({
        ok: true,
        degraded: false,
        plan: req.user.plan || 'free',
        role: req.user.role,
        credits: {
          balance: Number(creditRows[0]?.balance || 0),
          lifetime: Number(creditRows[0]?.balance || 0),
        },
        totals: {
          paid: Number(totalRows[0]?.paid || 0),
          orders: Number(totalRows[0]?.orders || 0),
          currency: 'USD',
        },
        subscription: subRows.length ? subRows[0] : null,
      });
    } catch (e) {
      LOG.error('billing.routes: summary falló', { error: e.message, code: e.code });
      res.json({
        ok: true,
        degraded: true,
        plan: req.user.plan || 'free',
        credits: { balance: 0, lifetime: 0 },
        totals: { paid: 0, orders: 0, currency: 'USD' },
        subscription: null,
      });
    }
  }));

  /* ─── GET /api/billing/invoices ────────────────────────────────────── */
  router.get('/api/billing/invoices', requireAuth, asyncHandler(async (req, res) => {
    const limit = Math.min(readInt(req.query.limit, 50), 200);
    const offset = Math.max(0, readInt(req.query.offset, 1) - 1);

    if (!supabaseDisponible()) {
      return res.json({ ok: true, degraded: true, invoices: [], total: 0 });
    }

    try {
      const [rows, countRows] = await Promise.all([
        sql`
          select
            id::text as id,
            package_id,
            status,
            amount,
            currency,
            credits_granted,
            paypal_order_id,
            provider,
            created_at
          from ${sql(PAYMENTS_TABLE)}
          where user_id = ${req.user.id}::uuid
          order by created_at desc
          limit ${limit} offset ${offset}
        `,
        sql`
          select count(*)::int as total
          from ${sql(PAYMENTS_TABLE)}
          where user_id = ${req.user.id}::uuid
        `,
      ]);

      const total = Number(countRows[0]?.total || 0);

      res.json({
        ok: true,
        degraded: false,
        invoices: rows.map((r) => ({
          id: r.id,
          number: `NM-${String(r.id).slice(0, 8).toUpperCase()}`,
          planId: r.package_id || null,
          status: r.status,
          amountCop: 0,
          amountUsd: Number(r.amount || 0),
          currency: r.currency || 'USD',
          credits: Number(r.credits_granted || 0),
          paypalOrderId: r.paypal_order_id,
          provider: r.provider || null,
          createdAt: r.created_at,
          pdfUrl: `/api/billing/invoices/${r.id}/pdf`,
        })),
        total,
        limit,
        offset,
      });
    } catch (e) {
      LOG.error('billing.routes: invoices falló', { error: e.message, code: e.code });
      throw new ValidationError('No se pudo cargar el historial de pagos.', 'invoices');
    }
  }));

  /* ─── GET /api/billing/invoices/:id/pdf ─────────────────────────────── */
  router.get('/api/billing/invoices/:id/pdf', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de factura inválido.', 'id');
    }

    const payment = await getPayment(req.user.id, id);

    if (!payment) {
      throw new NotFoundError('Esa factura no existe o no te pertenece.');
    }

    const profile = await getUserProfile(req.user.id);
    const currency = payment.currency || 'USD';
    const amount = Number(payment.amount || 0);
    const createdAt = payment.completed_at || payment.created_at;
    const planName = payment.package_id || 'Numination';

    const invoiceNumber = `NM-${String(payment.id).slice(0, 8).toUpperCase()}`;

    const docOpts = {
      title: 'Factura',
      fields: [
        { label: 'Factura', value: invoiceNumber },
        { label: 'Fecha', value: fmtDate(createdAt) },
        { label: 'Cliente', value: profile?.name || profile?.email || 'Usuario Numination' },
        { label: 'Correo', value: profile?.email || '—' },
        { label: 'Plan', value: planName },
        { label: 'Orden', value: payment.paypal_order_id || payment.provider_order_id || '—' },
      ],
      items: [
        {
          description: `Plan ${planName}`,
          detail: `${Number(payment.credits_granted || 0)} créditos · estado: ${payment.status}`,
          amount: fmtMoney(amount, currency),
        },
        ...(Number(payment.credits_granted || 0) > 0
          ? [{
            description: 'Créditos acreditados',
            detail: 'Créditos disponibles para usar en Numination',
            amount: String(Number(payment.credits_granted || 0)),
          }]
          : []),
      ],
      total: fmtMoney(amount, currency),
      footer:
        'Numination · Documento generado automáticamente. ' +
        'Gracias por tu confianza. Este comprobante no requiere firma digital.',
    };

    let buffer;
    try {
      buffer = pdfkit ? await buildInvoiceWithPdfkit(docOpts) : buildInvoicePdf(docOpts);
    } catch (e) {
      LOG.warn('billing.routes: falló pdfkit, se usa el escritor propio', { error: e.message });
      buffer = buildInvoicePdf(docOpts);
    }

    const filename = `numination-${invoiceNumber}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(buffer.length));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(buffer);
  }));

  /* ─── GET /api/billing/credits ─────────────────────────────────────── */
  router.get('/api/billing/credits', requireAuth, asyncHandler(async (req, res) => {
    if (!supabaseDisponible()) {
      return res.json({ ok: true, degraded: true, balance: 0, lifetime: 0 });
    }

    try {
      const rows = await sql`
        select coalesce(balance, 0)::int as balance,
               updated_at
        from ${sql(CREDITS_TABLE)}
        where user_id = ${req.user.id}::uuid
        limit 1
      `;

      res.json({
        ok: true,
        degraded: false,
        balance: Number(rows[0]?.balance || 0),
        lifetime: Number(rows[0]?.balance || 0),
        updatedAt: rows[0]?.updated_at || null,
      });
    } catch (e) {
      LOG.warn('billing.routes: credits falló', { error: e.message });
      res.json({ ok: true, degraded: true, balance: 0, lifetime: 0 });
    }
  }));

  app.use(router);

  LOG.info('billing.routes.mounted', {
    endpoints: [
      'GET /api/billing/summary',
      'GET /api/billing/invoices',
      'GET /api/billing/invoices/:id/pdf',
      'GET /api/billing/credits',
    ],
    pdfEngine: pdfkit ? 'pdfkit' : 'builtin',
  });

  return router;
}

export default { mountBillingRoutes };
