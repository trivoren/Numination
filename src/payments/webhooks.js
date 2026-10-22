/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · payments/webhooks.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Receptor de webhooks de PayPal.

   RUTA: POST /api/payments/webhook

   MODELO DE SEGURIDAD (fail-closed):
     1. Se exigen los 5 headers de verificación de PayPal. Si falta uno → 401.
     2. Se valida que el `cert-url` pertenezca al dominio de PayPal → 401 si no.
     3. Se verifica la firma contra el endpoint oficial
        `/v1/notifications/verify-webhook-signature`. Si PayPal no confirma
        la firma → 401 INMEDIATO (no se procesa nada).
     4. Solo después de verificar se interpreta el evento.

   MODELO DE CONSISTENCIA:
     · Cada evento se registra en `payment_webhook_events` con UNIQUE sobre
       `event_id`: los reintentos de PayPal no reprocesan el pago.
     · `fulfillOrder()` es idempotente (bloqueo de fila + estado), así que
       aunque un evento se procese dos veces, los créditos se acreditan UNA
       sola vez.

   CÓDIGO DE RESPUESTA:
     · 401 → firma inválida o headers ausentes (PayPal NO debe reintentar).
     · 400 → cuerpo ilegible.
     · 200 → evento procesado, ignorado o duplicado.
     · 500 → error transitorio (PayPal SÍ reintenta; el fulfill es idempotente).
   ═══════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql } from '../services/supabase.js';
import { createLogger } from '../lib/logger.js';
import {
  verifyWebhookSignature,
  WEBHOOK_REQUIRED_HEADERS,
} from './paypal-sdk.js';
import {
  fulfillOrder,
  getPaymentByOrderId,
  getPaymentByPayPalOrderId,
  markPaymentFailed,
  isUuid,
} from './database.js';
import {
  logPaymentEvent,
  logPaymentEventFromRequest,
  getClientIp,
} from './audit-logger.js';

const log = createLogger('payments-webhook');

const CFG = {
  table: 'payment_webhook_events',
  completedEvent: 'PAYMENT.CAPTURE.COMPLETED',
  deniedEvent: 'PAYMENT.CAPTURE.DENIED',
  maxRawBodyBytes: 512 * 1024,
};

let schemaReady = null;

/* ═══════════════════════════════════════════════════════════════════════
   1 · ESQUEMA
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Crea la tabla de eventos procesados si no existe.
 * @returns {Promise<boolean>}
 */
async function ensureWebhookSchema() {
  if (!sql) return false;
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    try {
      await sql`
        create table if not exists ${sql(CFG.table)} (
          id          uuid primary key,
          event_id    text not null unique,
          event_type  text,
          status      text not null default 'received',
          order_id    uuid,
          user_id     uuid,
          payload     jsonb,
          created_at  timestamptz not null default now()
        )
      `;
      await sql`create index if not exists payment_webhook_events_created_idx
                on ${sql(CFG.table)} (created_at desc)`;
      return true;
    } catch (err) {
      log.error('no pude crear la tabla de eventos de webhook:', err && err.message);
      schemaReady = null;
      return false;
    }
  })();

  return schemaReady;
}

/* ═══════════════════════════════════════════════════════════════════════
   2 · HELPERS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Devuelve el body crudo de la request.
 * `req.rawBody` lo captura el middleware de JSON (ver src/index.js); si no
 * está, se reconstruye desde `req.body` (lo que puede invalidar la firma
 * de PayPal → el webhook se rechaza con 401, que es el comportamiento
 * seguro por defecto).
 *
 * @param {object} req
 * @returns {{raw: string, fromBuffer: boolean}}
 */
export function getRawBody(req) {
  const raw = req && req.rawBody;
  if (Buffer.isBuffer(raw)) {
    return { raw: raw.toString('utf8'), fromBuffer: true };
  }
  if (typeof raw === 'string' && raw.length) {
    return { raw, fromBuffer: true };
  }
  try {
    return { raw: JSON.stringify((req && req.body) || {}), fromBuffer: false };
  } catch {
    return { raw: '{}', fromBuffer: false };
  }
}

/**
 * Parsea el cuerpo del webhook.
 * @param {string} raw
 * @returns {{ok:boolean, event:object|null, error:string|null}}
 */
export function parseEvent(raw) {
  if (!raw || typeof raw !== 'string') {
    return { ok: false, event: null, error: 'Cuerpo vacío.' };
  }
  if (raw.length > CFG.maxRawBodyBytes) {
    return { ok: false, event: null, error: 'Cuerpo demasiado grande.' };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, event: null, error: 'El cuerpo no es un objeto JSON.' };
    }
    return { ok: true, event: parsed, error: null };
  } catch (err) {
    return { ok: false, event: null, error: 'JSON inválido.' };
  }
}

/**
 * Extrae los identificadores relevantes del evento de PayPal.
 *
 * @param {object} event
 * @returns {{eventId:string|null, eventType:string|null, paypalOrderId:string|null,
 *            captureId:string|null, customId:string|null, amount:number|null,
 *            currency:string|null, status:string|null}}
 */
export function extractEventData(event) {
  const out = {
    eventId: null,
    eventType: null,
    paypalOrderId: null,
    captureId: null,
    customId: null,
    amount: null,
    currency: null,
    status: null,
  };

  if (!event || typeof event !== 'object') return out;

  out.eventId = typeof event.id === 'string' ? event.id.slice(0, 120) : null;
  out.eventType = typeof event.event_type === 'string' ? event.event_type.slice(0, 80) : null;
  out.status = typeof event.status === 'string' ? event.status.slice(0, 40) : null;

  const resource = (event.resource && typeof event.resource === 'object') ? event.resource : {};

  const related = resource.supplementary_data && resource.supplementary_data.related_ids;
  if (related && typeof related.order_id === 'string') {
    out.paypalOrderId = related.order_id.slice(0, 64);
  }

  if (typeof resource.id === 'string') {
    out.captureId = resource.id.slice(0, 64);
  }

  if (typeof resource.custom_id === 'string') {
    out.customId = resource.custom_id.slice(0, 64);
  }

  if (resource.amount && typeof resource.amount === 'object') {
    const value = Number(resource.amount.value);
    if (Number.isFinite(value)) out.amount = value;
    if (typeof resource.amount.currency_code === 'string') {
      out.currency = resource.amount.currency_code.slice(0, 8).toUpperCase();
    }
  }

  if (!out.paypalOrderId && typeof resource.invoice_id === 'string') {
    out.paypalOrderId = resource.invoice_id.slice(0, 64);
  }

  return out;
}

/**
 * Registra el evento. Devuelve `false` si ya existía (duplicado).
 *
 * @param {object} params
 * @returns {Promise<boolean>} true si es un evento nuevo.
 */
async function registerEvent(params) {
  if (!sql) return true;
  await ensureWebhookSchema();

  try {
    const rows = await sql`
      insert into ${sql(CFG.table)} (
        id, event_id, event_type, status, order_id, user_id, payload
      ) values (
        ${crypto.randomUUID()},
        ${params.eventId},
        ${params.eventType || null},
        ${params.status || 'received'},
        ${isUuid(params.orderId) ? params.orderId : null},
        ${isUuid(params.userId) ? params.userId : null},
        ${JSON.stringify(params.payload || {}).slice(0, 20000)}::jsonb
      )
      on conflict (event_id) do nothing
      returning event_id
    `;
    return rows.length > 0;
  } catch (err) {
    log.error('no pude registrar el evento de webhook:', err && err.message);
    // Si no se puede deduplicar, se continúa: `fulfillOrder` es idempotente.
    return true;
  }
}

/**
 * Localiza la orden a partir de los identificadores del evento.
 *
 * @param {object} data
 * @returns {Promise<object|null>}
 */
async function findOrder(data) {
  if (data.customId && isUuid(data.customId)) {
    const byCustom = await getPaymentByOrderId(data.customId);
    if (byCustom) return byCustom;
  }
  if (data.paypalOrderId) {
    const byPayPal = await getPaymentByPayPalOrderId(data.paypalOrderId);
    if (byPayPal) return byPayPal;
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════
   3 · HANDLER
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Maneja POST /api/payments/webhook.
 *
 * @param {object} req
 * @param {object} res
 */
export async function handlePaymentWebhook(req, res) {
  const ip = getClientIp(req);

  try {
    /* ── 1 · Body crudo ─────────────────────────────────────────────── */
    const { raw, fromBuffer } = getRawBody(req);
    if (!fromBuffer) {
      log.warn('el webhook llegó sin body crudo: la firma puede fallar', { ip });
    }

    const parsed = parseEvent(raw);
    if (!parsed.ok) {
      log.warn('webhook con cuerpo inválido:', parsed.error, { ip });
      await logPaymentEvent(null, null, 'webhook_invalid_body', ip, { error: parsed.error });
      return res.status(400).json({ ok: false, error: parsed.error });
    }

    const event = parsed.event;
    const data = extractEventData(event);

    /* ── 2 · Headers obligatorios ────────────────────────────────────── */
    const headers = (req && req.headers) || {};
    const missingHeaders = WEBHOOK_REQUIRED_HEADERS.filter((name) => {
      const value = headers[name];
      return !value || !String(value).trim();
    });

    if (missingHeaders.length) {
      log.warn('webhook sin headers de verificación:', missingHeaders.join(', '), { ip });
      await logPaymentEvent(null, data.customId, 'webhook_missing_headers', ip, {
        missing: missingHeaders,
        eventId: data.eventId,
      });
      return res.status(401).json({ ok: false, error: 'Faltan headers de verificación.' });
    }

    /* ── 3 · Verificación de la firma (fail-closed) ──────────────────── */
    const verification = await verifyWebhookSignature({
      headers,
      webhookEvent: event,
      rawBody: raw,
    });

    if (!verification.verified) {
      log.warn('firma de webhook inválida:', verification.status, {
        ip,
        eventId: data.eventId,
        reason: verification.reason,
      });
      await logPaymentEvent(null, data.customId, 'webhook_signature_invalid', ip, {
        status: verification.status,
        eventId: data.eventId,
        eventType: data.eventType,
      });
      return res.status(401).json({ ok: false, error: 'Firma inválida.' });
    }

    log.info('webhook verificado', { eventId: data.eventId, eventType: data.eventType, ip });

    /* ── 4 · Deduplicación ───────────────────────────────────────────── */
    const eventId = data.eventId || `no-id:${crypto.randomUUID()}`;
    const isNew = await registerEvent({
      eventId,
      eventType: data.eventType,
      status: 'verified',
      payload: event,
    });

    if (!isNew) {
      log.info('evento duplicado, se ignora', { eventId });
      return res.status(200).json({ ok: true, duplicate: true, eventId });
    }

    /* ── 5 · PAYMENT.CAPTURE.COMPLETED → abastecer ───────────────────── */
    if (data.eventType === CFG.completedEvent) {
      const order = await findOrder(data);

      if (!order) {
        log.warn('evento de pago sin orden conocida', { eventId, ...data });
        await logPaymentEvent(null, data.customId, 'webhook_order_not_found', ip, {
          eventId,
          paypalOrderId: data.paypalOrderId,
          captureId: data.captureId,
        });
        // 200: no hay nada que_PROCESSAR y reintentar no lo va a resolver.
        return res.status(200).json({ ok: true, ignored: true, reason: 'order_not_found' });
      }

      const userId = String(order.user_id);
      const orderId = String(order.id);

      try {
        const result = await fulfillOrder(userId, order.plan_id, orderId, {
          paypalCaptureId: data.captureId,
        });

        await logPaymentEventFromRequest(req, {
          userId,
          orderId,
          status: 'webhook_fulfilled',
          meta: {
            eventId,
            captureId: data.captureId,
            amount: data.amount,
            currency: data.currency,
            alreadyFulfilled: result.alreadyFulfilled,
          },
        });

        return res.status(200).json({
          ok: true,
          status: 'completed',
          orderId,
          alreadyFulfilled: result.alreadyFulfilled,
        });
      } catch (err) {
        log.error('fallo al abastecer la orden desde el webhook:', err && err.message, {
          eventId,
          orderId,
        });
        await logPaymentEvent(userId, orderId, 'webhook_fulfill_failed', ip, {
          eventId,
          error: err && err.message ? String(err.message).slice(0, 300) : 'error',
        });
        // 500: PayPal reintentará. El fulfill es idempotente → no hay doble crédito.
        return res.status(500).json({ ok: false, error: 'No pudimos procesar el pago.' });
      }
    }

    /* ── 6 · PAYMENT.CAPTURE.DENIED → marcar fallida ─────────────────── */
    if (data.eventType === CFG.deniedEvent) {
      const order = await findOrder(data);
      if (order) {
        await markPaymentFailed(String(order.id), 'failed');
        await logPaymentEventFromRequest(req, {
          userId: String(order.user_id),
          orderId: String(order.id),
          status: 'payment_denied',
          meta: { eventId, captureId: data.captureId },
        });
      }
      return res.status(200).json({ ok: true, status: 'denied' });
    }

    /* ── 7 · Otros eventos → se aceptan y se registran ───────────────── */
    log.debug('evento de webhook ignorado:', data.eventType, { eventId });
    return res.status(200).json({ ok: true, ignored: true, eventType: data.eventType });

  } catch (err) {
    log.error('error inesperado en el webhook de pagos:', err && err.message);
    try {
      await logPaymentEvent(null, null, 'webhook_error', ip, {
        error: err && err.message ? String(err.message).slice(0, 300) : 'error',
      });
    } catch {
      // La auditoría nunca debe throwar.
    }
    return res.status(500).json({ ok: false, error: 'Error interno.' });
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · MONTAJE DE LA RUTA
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Monta la ruta del webhook en la app de Express.
 *
 * IMPORTANTE: la ruta NO lleva `requireAuth` (PayPal no tiene sesión de
 * usuario). La autenticación es la verificación criptográfica de la firma.
 *
 * @param {object} app
 */
export function mountPaymentWebhookRoutes(app) {
  if (!app || typeof app.post !== 'function') {
    throw new Error('mountPaymentWebhookRoutes necesita la app de Express.');
  }

  app.post('/api/payments/webhook', (req, res) => {
    handlePaymentWebhook(req, res).catch((err) => {
      log.error('promesa del webhook rechazada:', err && err.message);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: 'Error interno.' });
      }
    });
  });

  log.info('ruta del webhook de pagos montada: POST /api/payments/webhook');
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  const parsed = parseEvent('{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{}}');
  rec('parseEvent válido', parsed.ok === true, parsed);

  const bad = parseEvent('{no json');
  rec('parseEvent inválido', bad.ok === false, bad);

  const data = extractEventData({
    id: 'WH-2',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: {
      id: 'CAP-1',
      custom_id: '123e4567-e89b-42d3-a456-426614174000',
      supplementary_data: { related_ids: { order_id: 'ORDER-1' } },
      amount: { value: '7.50', currency_code: 'USD' },
    },
  });
  rec('extract eventId', data.eventId === 'WH-2', data);
  rec('extract paypalOrderId', data.paypalOrderId === 'ORDER-1', data);
  rec('extract captureId', data.captureId === 'CAP-1', data);
  rec('extract customId', data.customId === '123e4567-e89b-42d3-a456-426614174000', data);
  rec('extract amount', data.amount === 7.5, data);
  rec('extract currency', data.currency === 'USD', data);

  const raw = getRawBody({ rawBody: Buffer.from('{"a":1}'), body: {} });
  rec('getRawBody desde buffer', raw.fromBuffer === true && raw.raw === '{"a":1}', raw);

  const raw2 = getRawBody({ body: { a: 1 } });
  rec('getRawBody desde body', raw2.fromBuffer === false, raw2);

  const passed = results.filter((r) => r.ok).length;
  return { passed, total: results.length, ok: passed === results.length, results };
}
