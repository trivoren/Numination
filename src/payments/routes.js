/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · payments/routes.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Rutas Express del checkout de pagos.

   RUTAS:
     GET  /api/payments/config         → config pública del SDK (sin auth)
     POST /api/payments/create-order   → crea la orden en PayPal (auth)
     POST /api/payments/capture-order  → cobra y abastece la orden (auth)
     GET  /api/payments/credits        → saldo de créditos (auth)
     GET  /api/payments/history        → historial de pagos (auth)
     POST /api/payments/webhook        → receptor de PayPal (firma, sin auth)

   DEFENSAS PRINCIPALES:
     · IDOR: en `capture-order` se verifica que la orden pertenezca a
       `req.user.id`. Si NO es del usuario → 403 + registro en la bitácora
       de auditoría como `idor_attempt`. La comprobación ocurre ANTES de
       cualquier llamada a PayPal: nunca se captura una orden ajena.
     · IDEMPOTENCIA: doble clic → 409 Conflict (ver `idempotency.js`).
     · MASS ASSIGNMENT: el body solo puede contener `planId` / `orderId`
       (objetos estrictos con Zod). El precio y el usuario los decide el
       servidor, nunca el cliente.
     · PRECIO: se toma del catálogo del servidor (`schemas.js`).
   ═══════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { createLogger } from '../lib/logger.js';
import { asyncHandler, NotFoundError, ForbiddenError, ValidationError } from '../middleware/errors.js';
import {
  createOrderSchema,
  captureOrderSchema,
  historyQuerySchema,
  parseOrThrow,
  resolvePlan,
  listPlans,
  PLAN_CATALOG,
} from './schemas.js';
import {
  createPayPalOrder,
  capturePayPalOrder,
  summarizeCapture,
  getPublicConfig,
  assertPayPalConfigured,
} from './paypal-sdk.js';
import { checkAndLock } from './idempotency.js';
import {
  createPaymentRecord,
  getPaymentByOrderId,
  updatePaymentStatus,
  fulfillOrder,
  getCreditsBalance,
  listUserPayments,
  getActiveSubscription,
  isUuid,
} from './database.js';
import {
  logPaymentEventFromRequest,
  logIdorAttempt,
} from './audit-logger.js';
import { mountPaymentWebhookRoutes } from './webhooks.js';

const log = createLogger('payments-routes');

const CFG = {
  createLockTtlMs: 10_000,     // anti doble clic al crear la orden
  captureLockTtlMs: 60_000,    // anti doble cobro al capturar
  maxHistoryRows: 50,
};

/**
 * Extrae el id del usuario autenticado de forma segura.
 * @param {object} req
 * @returns {string|null}
 */
function getUserId(req) {
  const id = (req && req.user && req.user.id) || (req && req.userId) || null;
  return isUuid(id) ? id : null;
}

/* ═══════════════════════════════════════════════════════════════════════
   1 · MONTaje
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Monta todas las rutas de pagos.
 *
 * @param {object} app        App de Express.
 * @param {Function} requireAuth  Middleware de autenticación del proyecto.
 */
export function mountPaymentRoutes(app, requireAuth) {
  if (!app || typeof app.get !== 'function') {
    throw new Error('mountPaymentRoutes necesita la app de Express.');
  }
  if (typeof requireAuth !== 'function') {
    throw new Error('mountPaymentRoutes necesita el middleware requireAuth.');
  }

  // Si PayPal no está configurado, se avisa claro (fail-fast opcional).
  try {
    const config = assertPayPalConfigured();
    log.info('módulo de pagos habilitado', {
      environment: config.environment,
      clientIdMasked: `****${config.clientId.slice(-4)}`,
    });
  } catch (err) {
    log.error('módulo de pagos NO habilitado:', err && err.message, {
      missing: err && Array.isArray(err.missing) ? err.missing : [],
    });
  }

  /* ── GET /api/payments/config ─────────────────────────────────────── */
  app.get('/api/payments/config', asyncHandler(async (req, res) => {
    try {
      const config = getPublicConfig();
      return res.json({
        ok: true,
        clientId: config.clientId,
        currency: config.currency,
        environment: config.environment,
        plans: listPlans(),
      });
    } catch (err) {
      log.error('no pude entregar la config de pagos:', err && err.message);
      return res.status(503).json({
        ok: false,
        error: 'El checkout no está disponible en este momento.',
        code: 'PAYMENTS_UNAVAILABLE',
      });
    }
  }));

  /* ── POST /api/payments/create-order ──────────────────────────────── */
  app.post('/api/payments/create-order', requireAuth, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
      throw new ForbiddenError('No pudimos identificar tu cuenta.', 'AUTH_NO_SESSION');
    }

    // 1) Validación estricta del body (400 si el plan no existe o hay keys extra).
    const { planId } = parseOrThrow(createOrderSchema, req.body, { endpoint: 'create-order' });

    // 2) El precio sale del catálogo del servidor, nunca del cliente.
    const plan = resolvePlan(planId);

    // 3) Cerrojo anti doble clic (10s).
    const lockKey = `create:${userId}:${plan.id}`;
    let lock = null;
    try {
      lock = await checkAndLock(lockKey, CFG.createLockTtlMs);
    } catch (err) {
      if (err && err.status === 409) {
        await logPaymentEventFromRequest(req, {
          userId,
          orderId: null,
          status: 'create_order_conflict',
          meta: { planId: plan.id },
        });
        return res.status(409).json({
          ok: false,
          error: 'Ya hay una orden en creación para este plan. Espera un momento.',
          code: 'PAYMENT_IDEMPOTENCY_CONFLICT',
        });
      }
      throw err;
    }

    try {
      const orderId = crypto.randomUUID();

      const paypalOrder = await createPayPalOrder({
        amount: plan.amountUsd,
        currency: plan.currency,
        description: `Numination · Plan ${plan.name}`,
        referenceId: orderId,
        customId: orderId,
      });

      const paypalOrderId = paypalOrder && paypalOrder.id ? String(paypalOrder.id) : null;
      if (!paypalOrderId) {
        throw new Error('PayPal no devolvió el id de la orden.');
      }

      await createPaymentRecord({
        id: orderId,
        userId,
        planId: plan.id,
        amountCop: plan.amountCop,
        amountUsd: plan.amountUsd,
        currency: plan.currency,
        paypalOrderId,
      });

      await logPaymentEventFromRequest(req, {
        userId,
        orderId,
        status: 'order_created',
        meta: {
          planId: plan.id,
          amountUsd: plan.amountUsd,
          currency: plan.currency,
          paypalOrderId,
        },
      });

      return res.status(201).json({
        ok: true,
        orderId,
        paypalOrderId,
        planId: plan.id,
        planName: plan.name,
        amount: {
          cop: plan.amountCop,
          usd: plan.amountUsd,
          currency: plan.currency,
        },
        credits: plan.credits,
      });
    } catch (err) {
      log.error('fallo al crear la orden:', err && err.message, { userId, planId: plan.id });
      await logPaymentEventFromRequest(req, {
        userId,
        orderId: null,
        status: 'order_create_failed',
        meta: { planId: plan.id, error: err && err.message ? String(err.message).slice(0, 200) : 'error' },
      });

      const status = err && err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
      return res.status(status).json({
        ok: false,
        error: 'No pudimos iniciar el pago. Intentá de nuevo.',
        code: 'PAYMENT_CREATE_FAILED',
      });
    } finally {
      if (lock) await lock.release();
    }
  }));

  /* ── POST /api/payments/capture-order ─────────────────────────────── */
  app.post('/api/payments/capture-order', requireAuth, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
      throw new ForbiddenError('No pudimos identificar tu cuenta.', 'AUTH_NO_SESSION');
    }

    const { orderId } = parseOrThrow(captureOrderSchema, req.body, { endpoint: 'capture-order' });

    /* ── ANTI-IDOR: la orden debe ser del usuario autenticado ───────── */
    const payment = await getPaymentByOrderId(orderId);

    if (!payment) {
      await logPaymentEventFromRequest(req, {
        userId,
        orderId,
        status: 'capture_order_not_found',
        meta: { reason: 'unknown_order' },
      });
      throw new NotFoundError('No encontramos esa orden.', 'PAYMENT_ORDER_NOT_FOUND');
    }

    if (String(payment.user_id) !== String(userId)) {
      // Intento de acceso a una orden ajena: se bloquea y se registra.
      await logIdorAttempt(req, {
        userId,
        orderId,
        ownerId: String(payment.user_id),
        reason: 'order_not_owned',
      });
      throw new ForbiddenError('Esta orden no pertenece a tu cuenta.', 'PAYMENT_ORDER_FORBIDDEN');
    }

    /* ── Idempotencia: si ya se cobró, se responde OK sin cobrar ────── */
    if (payment.status === 'completed') {
      const balance = await getCreditsBalance(userId);
      return res.json({
        ok: true,
        status: 'completed',
        alreadyCompleted: true,
        orderId,
        planId: payment.plan_id,
        credits: balance.balance,
      });
    }

    if (payment.status === 'failed' || payment.status === 'denied') {
      return res.status(409).json({
        ok: false,
        error: 'Esa orden ya no se puede confirmar. Creá una orden nueva.',
        code: 'PAYMENT_ORDER_NOT_PAYABLE',
      });
    }

    /* ── Cerrojo anti doble cobro ───────────────────────────────────── */
    let lock = null;
    try {
      lock = await checkAndLock(`capture:${userId}:${orderId}`, CFG.captureLockTtlMs);
    } catch (err) {
      if (err && err.status === 409) {
        await logPaymentEventFromRequest(req, {
          userId,
          orderId,
          status: 'capture_conflict',
          meta: { reason: 'double_submit' },
        });
        return res.status(409).json({
          ok: false,
          error: 'Ya estamos procesando este pago. No lo repitas.',
          code: 'PAYMENT_IDEMPOTENCY_CONFLICT',
        });
      }
      throw err;
    }

    try {
      if (!payment.paypal_order_id) {
        throw new ValidationError('La orden no tiene referencia de PayPal.', 'orderId', 'PAYMENT_ORDER_INVALID');
      }

      const capture = await capturePayPalOrder(payment.paypal_order_id);
      const summary = summarizeCapture(capture);

      if (summary.status !== 'COMPLETED') {
        await updatePaymentStatus(orderId, 'failed');
        await logPaymentEventFromRequest(req, {
          userId,
          orderId,
          status: 'payment_not_completed',
          meta: { paypalStatus: summary.status },
        });
        return res.status(402).json({
          ok: false,
          error: 'PayPal no completó el pago.',
          code: 'PAYMENT_NOT_COMPLETED',
        });
      }

      // Abastecimiento transaccional: créditos + suscripción + orden.
      const result = await fulfillOrder(userId, payment.plan_id, orderId, {
        paypalCaptureId: summary.captureId,
        credits: PLAN_CATALOG[payment.plan_id] ? PLAN_CATALOG[payment.plan_id].credits : 0,
      });

      await logPaymentEventFromRequest(req, {
        userId,
        orderId,
        status: 'payment_completed',
        meta: {
          planId: payment.plan_id,
          captureId: summary.captureId,
          amount: summary.amount,
          currency: summary.currency,
          alreadyFulfilled: result.alreadyFulfilled,
        },
      });

      return res.json({
        ok: true,
        status: 'completed',
        orderId,
        planId: payment.plan_id,
        credits: result.balance,
        alreadyFulfilled: result.alreadyFulfilled,
        message: '¡Pago confirmado! Tu plan ya está activo.',
      });
    } catch (err) {
      log.error('fallo al capturar la orden:', err && err.message, { userId, orderId });

      if (err && err.status === 404) {
        await logPaymentEventFromRequest(req, {
          userId, orderId, status: 'capture_order_not_found',
          meta: { error: 'not_found' },
        });
        return res.status(404).json({ ok: false, error: 'No encontramos esa orden.', code: 'PAYMENT_ORDER_NOT_FOUND' });
      }

      if (err && err.status === 403) {
        await logIdorAttempt(req, { userId, orderId, reason: 'order_not_owned' });
        return res.status(403).json({ ok: false, error: 'Esta orden no pertenece a tu cuenta.', code: 'PAYMENT_ORDER_FORBIDDEN' });
      }

      await logPaymentEventFromRequest(req, {
        userId,
        orderId,
        status: 'capture_failed',
        meta: { error: err && err.message ? String(err.message).slice(0, 200) : 'error' },
      });

      const status = err && err.status && err.status >= 400 && err.status < 600 ? err.status : 502;
      return res.status(status).json({
        ok: false,
        error: 'No pudimos confirmar el pago. Intentá de nuevo.',
        code: 'PAYMENT_CAPTURE_FAILED',
      });
    } finally {
      if (lock) await lock.release();
    }
  }));

  /* ── GET /api/payments/credits ────────────────────────────────────── */
  app.get('/api/payments/credits', requireAuth, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
      throw new ForbiddenError('No pudimos identificar tu cuenta.', 'AUTH_NO_SESSION');
    }

    const balance = await getCreditsBalance(userId);
    const subscription = await getActiveSubscription(userId);

    return res.json({
      ok: true,
      credits: balance.balance,
      lifetimeCredits: balance.lifetime,
      subscription: subscription
        ? {
            planId: subscription.plan_id,
            status: subscription.status,
            endsAt: subscription.ends_at,
          }
        : null,
    });
  }));

  /* ── GET /api/payments/history ────────────────────────────────────── */
  app.get('/api/payments/history', requireAuth, asyncHandler(async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
      throw new ForbiddenError('No pudimos identificar tu cuenta.', 'AUTH_NO_SESSION');
    }

    const { limit } = parseOrThrow(historyQuerySchema, req.query || {}, { endpoint: 'history' });
    const payments = await listUserPayments(userId, limit || 10);

    return res.json({
      ok: true,
      payments: payments.map((p) => ({
        orderId: p.id,
        planId: p.plan_id,
        amountCop: p.amount_cop,
        amountUsd: Number(p.amount_usd),
        currency: p.currency,
        status: p.status,
        credits: p.credits_granted,
        createdAt: p.created_at,
        updatedAt: p.updated_at,
      })),
    });
  }));

  /* ── Webhook de PayPal (sin sesión: la auth es la firma) ─────────── */
  mountPaymentWebhookRoutes(app);

  log.info('rutas de pagos montadas');
}

/* ═══════════════════════════════════════════════════════════════════════
   2 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  rec('getUserId con user válido', getUserId({ user: { id: '123e4567-e89b-42d3-a456-426614174000' } }) !== null, true);
  rec('getUserId sin user', getUserId({}) === null, true);
  rec('getUserId con id inválido', getUserId({ user: { id: 'abc' } }) === null, true);
  rec('getUserId con userId directo', getUserId({ userId: '123e4567-e89b-42d3-a456-426614174000' }) !== null, true);

  const passed = results.filter((r) => r.ok).length;
  return { passed, total: results.length, ok: passed === results.length, results };
}
