/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · payments/database.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Capa de datos del módulo de pagos (Postgres.js).

   GARANTÍA CENTRAL:
     `fulfillOrder()` ejecuta TODO el abastecimiento de la compra dentro de
     UNA transacción ACID explícita:

        BEGIN
          1. SELECT ... FOR UPDATE sobre la orden   (bloqueo de fila)
          2. UPDATE créditos (user_credits)          (upsert + suma)
          3. INSERT en el ledger de créditos
          4. INSERT en la suscripción (30 días)
          5. UPDATE de la orden a 'completed'
        COMMIT

     Si CUALQUIER paso falla → ROLLBACK y el error se propaga. Nunca queda
     una transacción a medias: o se acreditan los créditos Y la suscripción
     Y se marca la orden, o no se mueve nada.

   IDEMPOTENCIA:
     · La orden se bloquea con `FOR UPDATE` y se comprueba su estado: si ya
       está 'completed', se devuelve `{ alreadyFulfilled: true }` sin
       acreditar nada (protección frente a webhooks duplicados).

   TABLAS (se crean con CREATE TABLE IF NOT EXISTS):
     payments · user_credits · payment_credit_ledger · payment_subscriptions
   ═══════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql, supabaseDisponible } from '../services/supabase.js';
import { createLogger } from '../lib/logger.js';
import { NotFoundError, ForbiddenError, DatabaseError } from '../middleware/errors.js';
import { SUBSCRIPTION_DAYS } from './schemas.js';

const log = createLogger('payments-db');

const CFG = {
  tables: Object.freeze({
    payments: 'payments',
    credits: 'user_credits',
    ledger: 'payment_credit_ledger',
    subscriptions: 'payment_subscriptions',
  }),
  subscriptionDays: SUBSCRIPTION_DAYS,
  maxHistoryRows: 100,
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ¿Es un UUID válido? */
export function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

let schemaReady = null;

/* ═══════════════════════════════════════════════════════════════════════
   1 · ESQUEMA
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Crea las tablas del módulo de pagos si no existen.
 * @returns {Promise<boolean>}
 */
export async function ensurePaymentsSchema() {
  if (!sql) return false;
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    try {
      // ── Órdenes ──────────────────────────────────────────────────────
      await sql`
        create table if not exists ${sql(CFG.tables.payments)} (
          id                uuid primary key,
          user_id           uuid not null,
          plan_id           text not null,
          amount_cop        integer not null default 0,
          amount_usd        numeric(12,2) not null default 0,
          currency          text not null default 'USD',
          status            text not null default 'created',
          paypal_order_id   text,
          paypal_capture_id text,
          credits_granted   integer not null default 0,
          created_at        timestamptz not null default now(),
          updated_at        timestamptz not null default now()
        )
      `;
      await sql`create unique index if not exists payments_paypal_order_idx
                on ${sql(CFG.tables.payments)} (paypal_order_id)
                where paypal_order_id is not null`;
      await sql`create index if not exists payments_user_idx
                on ${sql(CFG.tables.payments)} (user_id, created_at desc)`;

      // ── Saldo de créditos ────────────────────────────────────────────
      await sql`
        create table if not exists ${sql(CFG.tables.credits)} (
          user_id          uuid primary key,
          balance          integer not null default 0,
          lifetime_credits integer not null default 0,
          updated_at       timestamptz not null default now()
        )
      `;

      // ── Ledger de créditos ───────────────────────────────────────────
      await sql`
        create table if not exists ${sql(CFG.tables.ledger)} (
          id            uuid primary key,
          user_id       uuid not null,
          order_id      uuid,
          delta         integer not null,
          reason        text not null,
          balance_after integer,
          created_at    timestamptz not null default now()
        )
      `;
      await sql`create index if not exists payment_credit_ledger_user_idx
                on ${sql(CFG.tables.ledger)} (user_id, created_at desc)`;

      // ── Suscripciones ────────────────────────────────────────────────
      await sql`
        create table if not exists ${sql(CFG.tables.subscriptions)} (
          id                uuid primary key,
          user_id           uuid not null,
          plan_id           text not null,
          status            text not null default 'active',
          credits_per_period integer not null default 0,
          started_at        timestamptz not null default now(),
          ends_at           timestamptz not null,
          created_at        timestamptz not null default now(),
          updated_at        timestamptz not null default now()
        )
      `;
      await sql`create unique index if not exists payment_subscriptions_active_idx
                on ${sql(CFG.tables.subscriptions)} (user_id)
                where status = 'active'`;

      log.info('esquema de pagos listo');
      return true;
    } catch (err) {
      log.error('no pude crear el esquema de pagos:', err && err.message);
      schemaReady = null;
      return false;
    }
  })();

  return schemaReady;
}

/* ═══════════════════════════════════════════════════════════════════════
   2 · TRANSACCIONES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Ejecuta `fn` dentro de una transacción ACID explícita.
 *
 *   BEGIN → fn(conn) → COMMIT
 *   Si fn lanza → ROLLBACK y se vuelve a lanzar el error.
 *
 * Se usa `sql.reserve()` para obtener una conexión EXCLUSIVA del pool:
 * de lo contrario el BEGIN y el COMMIT podrían ejecutarse en conexiones
 * distintas y la transacción quedaría abierta (fuga de conexiones y
 * bloqueos en la base).
 *
 * @param {(conn: Function) => Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function withTransaction(fn) {
  if (!sql) {
    throw new DatabaseError('La base de datos no está disponible.', 'DB_UNAVAILABLE', null, null);
  }

  const conn = await sql.reserve();
  let began = false;

  try {
    await conn.unsafe('begin');
    began = true;

    const result = await fn(conn);

    await conn.unsafe('commit');
    began = false;

    return result;
  } catch (err) {
    if (began) {
      try {
        await conn.unsafe('rollback');
        log.warn('transacción revertida (rollback):', err && err.message);
      } catch (rollbackError) {
        log.error('fallo el ROLLBACK:', rollbackError && rollbackError.message, {
          original: err && err.message,
        });
      }
    }
    throw err;
  } finally {
    try {
      conn.release();
    } catch (releaseError) {
      log.warn('no pude liberar la conexión reservada:', releaseError && releaseError.message);
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   3 · ÓRDENES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Crea el registro de la orden (antes de que el usuario pague).
 *
 * @param {object} params
 * @param {string} params.id            UUID público de la orden.
 * @param {string} params.userId        UUID del usuario.
 * @param {string} params.planId
 * @param {number} params.amountCop
 * @param {number} params.amountUsd
 * @param {string} params.currency
 * @param {string} [params.paypalOrderId]
 * @returns {Promise<object|null>}
 */
export async function createPaymentRecord(params = {}) {
  try {
    if (!sql) return null;
    await ensurePaymentsSchema();

    const {
      id = crypto.randomUUID(),
      userId,
      planId,
      amountCop = 0,
      amountUsd = 0,
      currency = 'USD',
      paypalOrderId = null,
    } = params;

    if (!isUuid(userId) || !isUuid(id)) {
      throw new DatabaseError('Identificadores inválidos para la orden.', 'DB_QUERY_FAILED', null, null);
    }

    const rows = await sql`
      insert into ${sql(CFG.tables.payments)} (
        id, user_id, plan_id, amount_cop, amount_usd, currency, status, paypal_order_id
      ) values (
        ${id}::uuid,
        ${userId}::uuid,
        ${String(planId).slice(0, 40)},
        ${Math.trunc(Number(amountCop) || 0)},
        ${Number(amountUsd || 0).toFixed(2)},
        ${String(currency || 'USD').slice(0, 8).toUpperCase()},
        'created',
        ${paypalOrderId ? String(paypalOrderId).slice(0, 64) : null}
      )
      returning id, user_id, plan_id, amount_cop, amount_usd, currency, status,
                paypal_order_id, paypal_capture_id, credits_granted, created_at, updated_at
    `;

    return rows[0] || null;
  } catch (err) {
    log.error('no pude crear el registro de la orden:', err && err.message);
    throw err;
  }
}

/**
 * Busca una orden por su UUID público (sin filtrar por usuario: el control
 * de propiedad lo hace la capa de rutas para poder auditar el intento).
 *
 * @param {string} orderId
 * @returns {Promise<object|null>}
 */
export async function getPaymentByOrderId(orderId) {
  try {
    if (!sql || !isUuid(orderId)) return null;
    const rows = await sql`
      select id, user_id, plan_id, amount_cop, amount_usd, currency, status,
             paypal_order_id, paypal_capture_id, credits_granted, created_at, updated_at
      from ${sql(CFG.tables.payments)}
      where id = ${orderId}::uuid
      limit 1
    `;
    return rows[0] || null;
  } catch (err) {
    log.error('no pude leer la orden:', err && err.message, { orderId: String(orderId).slice(0, 64) });
    return null;
  }
}

/**
 * Busca una orden por el ID de PayPal (usado por el webhook).
 *
 * @param {string} paypalOrderId
 * @returns {Promise<object|null>}
 */
export async function getPaymentByPayPalOrderId(paypalOrderId) {
  try {
    if (!sql || !paypalOrderId) return null;
    const rows = await sql`
      select id, user_id, plan_id, amount_cop, amount_usd, currency, status,
             paypal_order_id, paypal_capture_id, credits_granted, created_at, updated_at
      from ${sql(CFG.tables.payments)}
      where paypal_order_id = ${String(paypalOrderId).slice(0, 64)}
      limit 1
    `;
    return rows[0] || null;
  } catch (err) {
    log.error('no pude leer la orden por paypal_order_id:', err && err.message);
    return null;
  }
}

/**
 * Actualiza el estado de una orden.
 *
 * @param {string} orderId
 * @param {string} status
 * @param {object} [extra] Campos extra (paypalCaptureId, creditsGranted).
 * @returns {Promise<object|null>}
 */
export async function updatePaymentStatus(orderId, status, extra = {}) {
  try {
    if (!sql || !isUuid(orderId)) return null;
    const captureId = extra.paypalCaptureId ? String(extra.paypalCaptureId).slice(0, 64) : null;
    const credits = Number.isFinite(Number(extra.creditsGranted))
      ? Math.trunc(Number(extra.creditsGranted))
      : null;

    const rows = await sql`
      update ${sql(CFG.tables.payments)}
      set status = ${String(status).slice(0, 40)},
          paypal_capture_id = coalesce(${captureId}, paypal_capture_id),
          credits_granted = coalesce(${credits}, credits_granted),
          updated_at = now()
      where id = ${orderId}::uuid
      returning id, user_id, plan_id, status, paypal_order_id, paypal_capture_id,
                credits_granted, updated_at
    `;
    return rows[0] || null;
  } catch (err) {
    log.error('no pude actualizar el estado de la orden:', err && err.message, { orderId: String(orderId).slice(0, 64) });
    return null;
  }
}

/**
 * Historial de pagos del usuario.
 *
 * @param {string} userId
 * @param {number} [limit=20]
 * @returns {Promise<Array<object>>}
 */
export async function listUserPayments(userId, limit = 20) {
  try {
    if (!sql || !isUuid(userId)) return [];
    const safeLimit = Math.max(1, Math.min(CFG.maxHistoryRows, Math.trunc(Number(limit) || 20)));
    const rows = await sql`
      select id, plan_id, amount_cop, amount_usd, currency, status,
             paypal_order_id, credits_granted, created_at, updated_at
      from ${sql(CFG.tables.payments)}
      where user_id = ${userId}::uuid
      order by created_at desc
      limit ${safeLimit}
    `;
    return rows || [];
  } catch (err) {
    log.error('no pude listar los pagos del usuario:', err && err.message);
    return [];
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · CRÉDITOS Y SUSCRIPCIONES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Saldo actual de créditos del usuario.
 *
 * @param {string} userId
 * @returns {Promise<{balance:number, lifetime:number}>}
 */
export async function getCreditsBalance(userId) {
  try {
    if (!sql || !isUuid(userId)) return { balance: 0, lifetime: 0 };
    const rows = await sql`
      select balance, lifetime_credits
      from ${sql(CFG.tables.credits)}
      where user_id = ${userId}::uuid
      limit 1
    `;
    const row = rows[0];
    return {
      balance: Number(row ? row.balance : 0) || 0,
      lifetime: Number(row ? row.lifetime_credits : 0) || 0,
    };
  } catch (err) {
    log.error('no pude leer el saldo de créditos:', err && err.message);
    return { balance: 0, lifetime: 0 };
  }
}

/**
 * Suscripción activa del usuario (si la hay).
 *
 * @param {string} userId
 * @returns {Promise<object|null>}
 */
export async function getActiveSubscription(userId) {
  try {
    if (!sql || !isUuid(userId)) return null;
    const rows = await sql`
      select id, user_id, plan_id, status, credits_per_period, started_at, ends_at
      from ${sql(CFG.tables.subscriptions)}
      where user_id = ${userId}::uuid
        and status = 'active'
        and ends_at > now()
      order by ends_at desc
      limit 1
    `;
    return rows[0] || null;
  } catch (err) {
    log.error('no pude leer la suscripción activa:', err && err.message);
    return null;
  }
}

/**
 * Sincroniza el `tier` del perfil con el plan comprado.
 * Se ejecuta FUERA de la transacción principal a propósito: el perfil es
 * un dato derivado y una tabla de otra base lógica; si falla, el pago
 * sigue siendo válido (queda registrado en el log de auditoría).
 *
 * @param {string} userId
 * @param {string} planId
 * @returns {Promise<boolean>}
 */
export async function syncProfileTier(userId, planId) {
  try {
    if (!sql || !isUuid(userId)) return false;
    const tier = planId === 'ultimate' ? 'PREMIUM' : (planId === 'pro' ? 'PRO' : 'FREE');
    const result = await sql`
      update public.profiles
      set tier = ${tier},
          "updatedAt" = now()
      where id = ${userId}::uuid
    `;
    return result.count > 0;
  } catch (err) {
    log.warn('no pude sincronizar el tier del perfil:', err && err.message, { planId });
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · ABASTECIMIENTO (FULFILLMENT)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Abastece una orden pagada: acredita créditos, crea la suscripción y
 * marca la orden como completada, TODO dentro de una transacción ACID.
 *
 * @param {string} userId   UUID del usuario propietario de la orden.
 * @param {string} planId   Plan comprado ('pro' | 'ultimate').
 * @param {string} orderId  UUID público de la orden.
 * @param {object} [opts]
 * @param {string} [opts.paypalCaptureId]
 * @param {number} [opts.credits]
 * @returns {Promise<{ok:boolean, alreadyFulfilled:boolean, balance:number, orderId:string}>}
 * @throws {NotFoundError}   la orden no existe
 * @throws {ForbiddenError}  la orden pertenece a otro usuario
 * @throws {Error}           cualquier fallo de la transacción (con ROLLBACK aplicado)
 */
export async function fulfillOrder(userId, planId, orderId, opts = {}) {
  if (!sql) {
    throw new DatabaseError('La base de datos no está disponible.', 'DB_UNAVAILABLE', null, null);
  }
  if (!isUuid(userId) || !isUuid(orderId)) {
    throw new NotFoundError('Orden o usuario inválido.', 'PAYMENT_ORDER_INVALID', { orderId: String(orderId).slice(0, 64) });
  }

  await ensurePaymentsSchema();

  const cleanPlanId = String(planId || '').slice(0, 40);
  const paypalCaptureId = opts.paypalCaptureId ? String(opts.paypalCaptureId).slice(0, 64) : null;
  const credits = Math.max(0, Math.trunc(Number(opts.credits) || 0));

  const result = await withTransaction(async (conn) => {
    /* ── 1 · Bloquear la orden (FOR UPDATE) ───────────────────────────── */
    const paymentRows = await conn`
      select id, user_id, plan_id, status, amount_cop, amount_usd, currency,
             paypal_order_id, credits_granted
      from ${sql(CFG.tables.payments)}
      where id = ${orderId}::uuid
      for update
    `;

    const payment = paymentRows[0];
    if (!payment) {
      log.warn('fulfillOrder: la orden no existe', { orderId });
      throw new NotFoundError('La orden no existe.', 'PAYMENT_ORDER_NOT_FOUND', { orderId });
    }

    /* ── 2 · Propiedad de la orden (defensa en profundidad anti-IDOR) ── */
    if (String(payment.user_id) !== String(userId)) {
      log.warn('fulfillOrder: la orden pertenece a otro usuario', {
        orderId,
        owner: String(payment.user_id).slice(0, 8),
        requester: String(userId).slice(0, 8),
      });
      throw new ForbiddenError('Esta orden no pertenece a tu cuenta.', 'PAYMENT_ORDER_FORBIDDEN', {
        orderId,
      });
    }

    /* ── 3 · Idempotencia: ya completada → no se acredita nada ──────── */
    if (payment.status === 'completed') {
      const balanceRows = await conn`
        select balance from ${sql(CFG.tables.credits)}
        where user_id = ${userId}::uuid
        limit 1
      `;
      log.info('fulfillOrder: la orden ya estaba completada (idempotente)', { orderId });
      return {
        ok: true,
        alreadyFulfilled: true,
        balance: Number(balanceRows[0] ? balanceRows[0].balance : 0) || 0,
        orderId,
      };
    }

    /* ── 4 · Determinar los créditos a acreditar ─────────────────────── */
    const planCredits = credits > 0
      ? credits
      : Math.max(0, Math.trunc(Number(payment.credits_granted) || 0));

    /* ── 5 · Acreditar créditos (upsert + suma atómica) ─────────────── */
    const creditRows = await conn`
      insert into ${sql(CFG.tables.credits)} (user_id, balance, lifetime_credits, updated_at)
      values (${userId}::uuid, ${planCredits}, ${planCredits}, now())
      on conflict (user_id) do update
        set balance = ${sql(CFG.tables.credits)}.balance + excluded.balance,
            lifetime_credits = ${sql(CFG.tables.credits)}.lifetime_credits + excluded.lifetime_credits,
            updated_at = now()
      returning balance, lifetime_credits
    `;

    const balanceAfter = Number(creditRows[0] ? creditRows[0].balance : planCredits) || planCredits;

    /* ── 6 · Ledger de créditos (traza contable) ─────────────────────── */
    await conn`
      insert into ${sql(CFG.tables.ledger)} (
        id, user_id, order_id, delta, reason, balance_after
      ) values (
        ${crypto.randomUUID()},
        ${userId}::uuid,
        ${orderId}::uuid,
        ${planCredits},
        ${`subscription:${cleanPlanId}`},
        ${balanceAfter}
      )
    `;

    /* ── 7 · Suscripción: cerrar la anterior y abrir la nueva ───────── */
    await conn`
      update ${sql(CFG.tables.subscriptions)}
      set status = 'expired',
          updated_at = now()
      where user_id = ${userId}::uuid
        and status = 'active'
    `;

    await conn`
      insert into ${sql(CFG.tables.subscriptions)} (
        id, user_id, plan_id, status, credits_per_period, started_at, ends_at
      ) values (
        ${crypto.randomUUID()},
        ${userId}::uuid,
        ${cleanPlanId},
        'active',
        ${planCredits},
        now(),
        now() + (${CFG.subscriptionDays}::text || ' days')::interval
      )
    `;

    /* ── 8 · Marcar la orden como completada ─────────────────────────── */
    await conn`
      update ${sql(CFG.tables.payments)}
      set status = 'completed',
          paypal_capture_id = coalesce(${paypalCaptureId}, paypal_capture_id),
          credits_granted = ${planCredits},
          updated_at = now()
      where id = ${orderId}::uuid
    `;

    return {
      ok: true,
      alreadyFulfilled: false,
      balance: balanceAfter,
      credits: planCredits,
      orderId,
    };
  });

  /* ── 9 · Sincronizar el tier del perfil (fuera de la transacción) ─── */
  await syncProfileTier(userId, cleanPlanId);

  log.info('orden abonada correctamente', {
    orderId,
    planId: cleanPlanId,
    alreadyFulfilled: result.alreadyFulfilled,
    balance: result.balance,
  });

  return result;
}

/**
 * Marca una orden como fallida (denegada / error de captura).
 *
 * @param {string} orderId
 * @param {string} status
 * @returns {Promise<object|null>}
 */
export async function markPaymentFailed(orderId, status = 'failed') {
  return updatePaymentStatus(orderId, status);
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · HEALTH
   ═══════════════════════════════════════════════════════════════════════ */

/** Estado de la capa de datos de pagos. */
export async function paymentsHealth() {
  try {
    if (!sql) {
      return { ok: false, error: 'Base de datos no configurada.', dbAvailable: false };
    }
    const rows = await sql`select 1 as ok`;
    return {
      ok: Array.isArray(rows) && rows.length > 0,
      dbAvailable: supabaseDisponible(),
      schemaReady: Boolean(schemaReady),
    };
  } catch (err) {
    return { ok: false, error: err && err.message, dbAvailable: supabaseDisponible() };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  rec('isUuid válido', isUuid('123e4567-e89b-42d3-a456-426614174000'), true);
  rec('isUuid inválido', !isUuid('abc'), true);
  rec('isUuid con SQL', !isUuid("1' OR '1'='1"), true);
  rec('isUuid vacío', !isUuid(''), true);

  const passed = results.filter((r) => r.ok).length;
  return { passed, total: results.length, ok: passed === results.length, results };
}
