/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/notification-engine.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Motor de eventos → notificaciones persistidas.

   CÓMO FUNCIONA
     1 · El sistema emite un evento:  emit('payment.completed', {...})
     2 · El motor busca los handlers registrados para ese evento.
     3 · Cada handler construye una notificación y la guarda en la tabla
        `notifications`.
     4 · El frontend la ve en la campanita (polling de 60 s).

   EVENTOS NATIVOS
     payment.completed      → "Pago recibido"       (usuario)
     payment.failed         → "No pudimos cobrar"   (usuario)
     payment.refunded       → "Pago reembolsado"     (usuario)
     credits.low            → "Te quedan pocos créditos" (usuario)
     rag.document.ready     → "Tu PDF está listo"    (usuario)
     persona.created        → "Persona creada"      (usuario)
     quota.exceeded         → "Alcanzaste el límite"(usuario)
     system.announcement    → anuncio del admin      (todos)
     user.registered        → "Nuevo usuario"       (admins)
     revenue.milestone      → "Meta de ingresos"     (admins)

   ANTI-SPAM
   · Deduplicación por (userId, tipo, clave) en una ventana de 10 min.
   · Prioridad: un evento `system.announcement` ignora el dedupe.

   AISLAMIENTO
   Las notificaciones siempre llevan `user_id`. Las de admin se dirigen
   a usuarios con rol 'admin' y se resuelven con una consulta filtrada
   por rol, nunca por un id enviado desde el cliente.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql, supabaseDisponible } from './supabase.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  table: 'notifications',
  dedupeWindowMs: 10 * 60_000,
  maxInbox: 200,
  defaultPageSize: 30,
  maxBodyChars: 800,
});

export const EVENTS = Object.freeze({
  PAYMENT_COMPLETED: 'payment.completed',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_REFUNDED: 'payment.refunded',
  CREDITS_LOW: 'credits.low',
  RAG_DOCUMENT_READY: 'rag.document.ready',
  PERSONA_CREATED: 'persona.created',
  QUOTA_EXCEEDED: 'quota.exceeded',
  SYSTEM_ANNOUNCEMENT: 'system.announcement',
  USER_REGISTERED: 'user.registered',
  REVENUE_MILESTONE: 'revenue.milestone',
});

export const PRIORITY = Object.freeze({ low: 'low', normal: 'normal', high: 'high' });

/* ═══════════════════════════════════════════════════════════════════════════
   02 · BUS DE EVENTOS
   ═══════════════════════════════════════════════════════════════════════════ */

/** event → Set<handler> */
const handlers = new Map();

/**
 * Suscribe un handler a un evento.
 * @param {string} event
 * @param {function} handler  async ({ type, payload, userId, emit }) => void
 * @returns {function} unsubscribe
 */
export function on(event, handler) {
  if (!event || typeof handler !== 'function') {
    throw new TypeError('on(event, handler): se requiere un evento y una función.');
  }
  if (!handlers.has(event)) handlers.set(event, new Set());
  handlers.get(event).add(handler);

  return function off() {
    const set = handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (!set.size) handlers.delete(event);
  };
}

/**
 * Cancela una suscripción.
 */
export function off(event, handler) {
  const set = handlers.get(event);
  if (!set) return false;
  const removed = set.delete(handler);
  if (!set.size) handlers.delete(event);
  return removed;
}

/**
 * Emite un evento. Los handlers se ejecutan en paralelo y sus errores
 * no Rompen el flujo que originó el evento (un fallo al notificar no
 * puede tumbar un pago).
 *
 * @param {string} event
 * @param {object} [payload]
 * @returns {Promise<object>} resumen de la ejecución
 */
export async function emit(event, payload = {}) {
  const set = handlers.get(event);
  if (!set || !set.size) {
    return { ok: true, event, handled: 0, errors: 0 };
  }

  const results = await Promise.allSettled(
    Array.from(set).map(async (handler) => handler({ type: event, payload, emit }))
  );

  const errors = results.filter((r) => r.status === 'rejected').length;

  if (errors) {
    LOG.warn('notification-engine: handlers con error', {
      event,
      errors,
      details: results
        .filter((r) => r.status === 'rejected')
        .map((r) => String(r.reason?.message || r.reason))
        .slice(0, 3),
    });
  }

  return { ok: errors === 0, event, handled: results.length, errors };
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · PERSISTENCIA
   ═══════════════════════════════════════════════════════════════════════════ */

let schemaPromise = null;

async function ensureSchema() {
  if (!supabaseDisponible()) return { ok: false };
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    try {
      await sql`
        create table if not exists ${sql(CFG.table)} (
          id         uuid primary key default gen_random_uuid(),
          user_id    uuid not null,
          type       text not null,
          title      text not null,
          body       text,
          link       text,
          priority   text not null default 'normal',
          meta       jsonb default '{}'::jsonb,
          dedupe_key text,
          read_at    timestamptz,
          created_at timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists notifications_user_created_idx
          on ${sql(CFG.table)} (user_id, created_at desc)
      `;
      await sql`
        create index if not exists notifications_user_unread_idx
          on ${sql(CFG.table)} (user_id)
          where read_at is null
      `;
      await sql`
        create index if not exists notifications_dedupe_idx
          on ${sql(CFG.table)} (user_id, dedupe_key, created_at desc)
      `;
      return { ok: true };
    } catch (e) {
      LOG.warn('notification-engine: no se pudo crear la tabla', { error: e.message, code: e.code });
      return { ok: false };
    }
  })();

  return schemaPromise;
}

/** Buffer en memoria (modo degradado / sin BD). */
const MEM = [];
const MEM_LIMIT = 300;

function memPush(notification) {
  MEM.unshift(notification);
  if (MEM.length > MEM_LIMIT) MEM.length = MEM_LIMIT;
}

/**
 * Crea una notificación para un usuario.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.type
 * @param {string} params.title
 * @param {string} [params.body]
 * @param {string} [params.link]
 * @param {string} [params.priority]
 * @param {object} [params.meta]
 * @param {string} [params.dedupeKey]
 * @returns {Promise<object>} { ok, notification | null, reason }
 */
export async function createNotification(params = {}) {
  const {
    userId,
    type,
    title,
    body = '',
    link = null,
    priority = PRIORITY.normal,
    meta = null,
    dedupeKey = null,
  } = params;

  if (!userId) return { ok: false, reason: 'no_user' };
  if (!type) return { ok: false, reason: 'no_type' };
  if (!title) return { ok: false, reason: 'no_title' };

  const cleanTitle = String(title).slice(0, 160);
  const cleanBody = String(body || '').slice(0, CFG.maxBodyChars);

  // ── Deduplicación ──────────────────────────────────────────────────
  if (dedupeKey && !supabaseDisponible()) {
    const now = Date.now();
    const duplicate = MEM.find(
      (n) => n.userId === userId && n.dedupeKey === dedupeKey &&
        now - new Date(n.createdAt).getTime() < CFG.dedupeWindowMs
    );
    if (duplicate) return { ok: true, notification: duplicate, deduped: true };
  }

  if (!supabaseDisponible()) {
    const notification = {
      id: crypto.randomUUID(),
      userId,
      type,
      title: cleanTitle,
      body: cleanBody,
      link,
      priority,
      meta,
      dedupeKey,
      readAt: null,
      createdAt: new Date().toISOString(),
    };
    memPush(notification);
    return { ok: true, notification, degraded: true };
  }

  try {
    await ensureSchema();

    if (dedupeKey) {
      const recent = await sql`
        select id::text as id
        from ${sql(CFG.table)}
        where user_id = ${userId}::uuid
          and dedupe_key = ${dedupeKey}
          and created_at > now() - interval '10 minutes'
        limit 1
      `;
      if (recent.length) {
        return { ok: true, notification: { id: recent[0].id }, deduped: true };
      }
    }

    const rows = await sql`
      insert into ${sql(CFG.table)} (
        user_id, type, title, body, link, priority, meta, dedupe_key
      ) values (
        ${userId}::uuid,
        ${String(type).slice(0, 60)},
        ${cleanTitle},
        ${cleanBody || null},
        ${link ? String(link).slice(0, 400) : null},
        ${String(priority).slice(0, 20)},
        ${meta ? sql.json(meta) : sql.json({})},
        ${dedupeKey ? String(dedupeKey).slice(0, 200) : null}
      )
      returning
        id::text as id, user_id::text as user_id, type, title, body, link,
        priority, meta, dedupe_key, read_at, created_at
    `;

    return { ok: true, notification: shape(rows[0]) };
  } catch (e) {
    LOG.error('notification-engine: create falló', { error: e.message, code: e.code });
    return { ok: false, reason: 'db_error' };
  }
}

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id ?? row.userId ?? null,
    type: row.type,
    title: row.title,
    body: row.body || '',
    link: row.link || null,
    priority: row.priority || 'normal',
    meta: row.meta || {},
    readAt: row.read_at ?? row.readAt ?? null,
    isRead: Boolean(row.read_at ?? row.readAt),
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · HANDLERS NATIVOS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Notifica a todos los administradores.
 * El público de admins se resuelve por rol en la BD: el cliente nunca
 * puede decidir a quién se notifica.
 */
export async function notifyAdmins(params = {}) {
  if (!supabaseDisponible()) {
    // Sin BD no se puede saber quiénes son admins: se registra el evento
    // en el log para que no se pierda silenciosamente.
    LOG.info('notification-engine: notifyAdmins sin base de datos', { type: params.type });
    return { ok: false, reason: 'no_db', notified: 0 };
  }

  try {
    const admins = await sql`
      select id::text as id
      from public.profiles
      where role = 'admin'
        and coalesce(banned, false) = false
      limit 50
    `;

    let notified = 0;
    for (const admin of admins) {
      const result = await createNotification({ ...params, userId: admin.id });
      if (result.ok) notified++;
    }

    return { ok: true, notified };
  } catch (e) {
    LOG.error('notification-engine: notifyAdmins falló', { error: e.message });
    return { ok: false, reason: 'db_error', notified: 0 };
  }
}

function registerNativeHandlers() {
  // ── Pagos ────────────────────────────────────────────────────────────
  on(EVENTS.PAYMENT_COMPLETED, async ({ payload }) => {
    const amount = payload.amount ?? payload.amountUsd ?? 0;
    const currency = payload.currency || 'USD';
    const formatted = typeof amount === 'number'
      ? new Intl.NumberFormat('es-CO', { style: 'currency', currency }).format(amount)
      : String(amount);

    await createNotification({
      userId: payload.userId,
      type: EVENTS.PAYMENT_COMPLETED,
      title: 'Pago recibido',
      body: `Tu pago de ${formatted} se confirmó. Ya podés seguir usando todos los créditos.`,
      link: '/billing',
      priority: PRIORITY.high,
      meta: { orderId: payload.orderId || null, amount, currency },
      dedupeKey: `payment:${payload.orderId || payload.userId}`,
    });
  });

  on(EVENTS.PAYMENT_FAILED, async ({ payload }) => {
    await createNotification({
      userId: payload.userId,
      type: EVENTS.PAYMENT_FAILED,
      title: 'No pudimos procesar tu pago',
      body: 'El pago falló. Podés intentar de nuevo o revisar el método de pago.',
      link: '/billing',
      priority: PRIORITY.high,
      meta: { orderId: payload.orderId || null, reason: payload.reason || null },
      dedupeKey: `payment-failed:${payload.orderId || payload.userId}`,
    });
  });

  on(EVENTS.PAYMENT_REFUNDED, async ({ payload }) => {
    await createNotification({
      userId: payload.userId,
      type: EVENTS.PAYMENT_REFUNDED,
      title: 'Pago reembolsado',
      body: `Se reembolsó tu pago${payload.amount ? ` de ${payload.amount}` : ''}.`,
      link: '/billing',
      priority: PRIORITY.normal,
      meta: { orderId: payload.orderId || null },
      dedupeKey: `payment-refund:${payload.orderId || payload.userId}`,
    });
  });

  // ── Créditos y cuotas ───────────────────────────────────────────────
  on(EVENTS.CREDITS_LOW, async ({ payload }) => {
    const left = payload.remaining ?? 0;
    await createNotification({
      userId: payload.userId,
      type: EVENTS.CREDITS_LOW,
      title: 'Te quedan pocos créditos',
      body: `Te quedan ${left} créditos. Recargá tu plan para no quedarte sin respuestas.`,
      link: '/billing',
      priority: PRIORITY.normal,
      meta: { remaining: left },
      dedupeKey: `credits-low:${payload.userId}`,
    });
  });

  on(EVENTS.QUOTA_EXCEEDED, async ({ payload }) => {
    await createNotification({
      userId: payload.userId,
      type: EVENTS.QUOTA_EXCEEDED,
      title: 'Alcanzaste el límite de tu plan',
      body: 'Volvés a estar disponible a medianoche, o actualizá tu plan para seguir ahora.',
      link: '/billing',
      priority: PRIORITY.high,
      meta: { limit: payload.limit || null },
      dedupeKey: `quota:${payload.userId}:${new Date().toISOString().slice(0, 10)}`,
    });
  });

  // ── Producto ────────────────────────────────────────────────────────
  on(EVENTS.RAG_DOCUMENT_READY, async ({ payload }) => {
    await createNotification({
      userId: payload.userId,
      type: EVENTS.RAG_DOCUMENT_READY,
      title: 'Tu documento está listo',
      body: `"${payload.filename || 'Documento'}" ya se puede consultar desde el chat.`,
      link: '/chat',
      priority: PRIORITY.normal,
      meta: { docId: payload.docId || null, chunks: payload.chunks || 0 },
      dedupeKey: `rag-ready:${payload.docId || payload.filename}`,
    });
  });

  on(EVENTS.PERSONA_CREATED, async ({ payload }) => {
    await createNotification({
      userId: payload.userId,
      type: EVENTS.PERSONA_CREATED,
      title: 'Persona creada',
      body: `"${payload.name || 'Tu persona'}" ya está disponible en el selector del chat.`,
      link: '/chat',
      priority: PRIORITY.low,
      meta: { personaId: payload.personaId || null },
      dedupeKey: `persona:${payload.personaId || payload.name}`,
    });
  });

  // ── Sistema (admin) ─────────────────────────────────────────────────
  on(EVENTS.SYSTEM_ANNOUNCEMENT, async ({ payload }) => {
    await createNotification({
      userId: payload.userId,
      type: EVENTS.SYSTEM_ANNOUNCEMENT,
      title: payload.title || 'Novedad de Numination',
      body: payload.body || '',
      link: payload.link || null,
      priority: payload.priority || PRIORITY.normal,
      meta: payload.meta || null,
    });
  });

  on(EVENTS.USER_REGISTERED, async ({ payload }) => {
    await notifyAdmins({
      type: EVENTS.USER_REGISTERED,
      title: 'Nuevo usuario registrado',
      body: `${payload.email || payload.name || 'Alguien'} se acaba de registrar.`,
      link: '/admin',
      priority: PRIORITY.low,
      meta: { userId: payload.userId || null },
    });
  });

  on(EVENTS.REVENUE_MILESTONE, async ({ payload }) => {
    await notifyAdmins({
      type: EVENTS.REVENUE_MILESTONE,
      title: 'Meta de ingresos alcanzada',
      body: `Se acumularon ${payload.amount ?? 0} ${payload.currency || 'USD'}.`,
      link: '/admin',
      priority: PRIORITY.high,
      meta: { amount: payload.amount ?? null, currency: payload.currency || 'USD' },
    });
  });
}

registerNativeHandlers();

/* ═══════════════════════════════════════════════════════════════════════════
   05 · LECTURA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Lista las notificaciones del usuario.
 */
export async function listNotifications(userId, { limit = CFG.defaultPageSize, offset = 0, onlyUnread = false } = {}) {
  if (!userId) return { ok: false, notifications: [], total: 0 };

  const max = Math.min(parseInt(limit, 10) || CFG.defaultPageSize, CFG.maxInbox);
  const off = Math.max(0, parseInt(offset, 10) || 0);

  if (!supabaseDisponible()) {
    const mine = MEM.filter((n) => n.userId === userId);
    const filtered = onlyUnread ? mine.filter((n) => !n.isRead) : mine;
    return {
      ok: true,
      degraded: true,
      notifications: filtered.slice(off, off + max),
      total: filtered.length,
    };
  }

  try {
    await ensureSchema();

    const where = onlyUnread
      ? sql`where n.user_id = ${userId}::uuid and n.read_at is null`
      : sql`where n.user_id = ${userId}::uuid`;

    const [rows, countRows] = await Promise.all([
      sql`
        select
          n.id::text as id, n.user_id::text as user_id, n.type, n.title, n.body,
          n.link, n.priority, n.meta, n.read_at, n.created_at
        from ${sql(CFG.table)} n
        ${where}
        order by n.created_at desc
        limit ${max} offset ${off}
      `,
      sql`select count(*)::int as total from ${sql(CFG.table)} n ${where}`,
    ]);

    return {
      ok: true,
      degraded: false,
      notifications: rows.map(shape),
      total: Number(countRows[0]?.total || 0),
    };
  } catch (e) {
    LOG.error('notification-engine: list falló', { error: e.message, code: e.code });
    return { ok: true, degraded: true, notifications: [], total: 0 };
  }
}

/**
 * Conteo de no leídas.
 */
export async function getUnreadCount(userId) {
  if (!userId) return { ok: false, count: 0 };

  if (!supabaseDisponible()) {
    return { ok: true, degraded: true, count: MEM.filter((n) => n.userId === userId && !n.isRead).length };
  }

  try {
    await ensureSchema();
    const rows = await sql`
      select count(*)::int as count
      from ${sql(CFG.table)}
      where user_id = ${userId}::uuid and read_at is null
    `;
    return { ok: true, degraded: false, count: Number(rows[0]?.count || 0) };
  } catch (e) {
    LOG.warn('notification-engine: unreadCount falló', { error: e.message });
    return { ok: true, degraded: true, count: 0 };
  }
}

/**
 * Marca una notificación como leída.
 */
export async function markRead(userId, notificationId) {
  if (!userId || !notificationId) return { ok: false };

  if (!supabaseDisponible()) {
    const item = MEM.find((n) => n.id === notificationId && n.userId === userId);
    if (!item) return { ok: false, reason: 'not_found' };
    item.isRead = true;
    item.readAt = new Date().toISOString();
    return { ok: true, degraded: true, notification: item };
  }

  try {
    await ensureSchema();
    const rows = await sql`
      update ${sql(CFG.table)}
      set read_at = coalesce(read_at, now())
      where id = ${notificationId}::uuid and user_id = ${userId}::uuid
      returning id::text as id, read_at
    `;
    if (!rows.length) return { ok: false, reason: 'not_found' };
    return { ok: true, notification: { id: rows[0].id, readAt: rows[0].read_at } };
  } catch (e) {
    LOG.error('notification-engine: markRead falló', { error: e.message });
    return { ok: false, reason: 'db_error' };
  }
}

/**
 * Marca todas como leídas.
 */
export async function markAllRead(userId) {
  if (!userId) return { ok: false, count: 0 };

  if (!supabaseDisponible()) {
    let count = 0;
    MEM.forEach((n) => {
      if (n.userId === userId && !n.isRead) {
        n.isRead = true;
        n.readAt = new Date().toISOString();
        count++;
      }
    });
    return { ok: true, degraded: true, count };
  }

  try {
    await ensureSchema();
    const rows = await sql`
      update ${sql(CFG.table)}
      set read_at = now()
      where user_id = ${userId}::uuid and read_at is null
      returning id
    `;
    return { ok: true, count: rows.length };
  } catch (e) {
    LOG.error('notification-engine: markAllRead falló', { error: e.message });
    return { ok: false, count: 0 };
  }
}

/**
 * Borra las notificaciones del usuario (o una puntual).
 */
export async function deleteNotification(userId, notificationId = null) {
  if (!userId) return { ok: false, deleted: 0 };

  if (!supabaseDisponible()) {
    const before = MEM.length;
    for (let i = MEM.length - 1; i >= 0; i--) {
      const n = MEM[i];
      if (n.userId !== userId) continue;
      if (notificationId && n.id !== notificationId) continue;
      MEM.splice(i, 1);
    }
    return { ok: true, degraded: true, deleted: before - MEM.length };
  }

  try {
    await ensureSchema();
    const rows = notificationId
      ? await sql`
          delete from ${sql(CFG.table)}
          where id = ${notificationId}::uuid and user_id = ${userId}::uuid
          returning id
        `
      : await sql`
          delete from ${sql(CFG.table)}
          where user_id = ${userId}::uuid
          returning id
        `;
    return { ok: true, deleted: rows.length };
  } catch (e) {
    LOG.error('notification-engine: delete falló', { error: e.message });
    return { ok: false, deleted: 0 };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · ESTADO
   ═══════════════════════════════════════════════════════════════════════════ */

export function getEngineStatus() {
  return {
    dbAvailable: supabaseDisponible(),
    events: Object.values(EVENTS),
    handlers: Array.from(handlers.entries()).map(([event, set]) => ({ event, count: set.size })),
    memoryBuffer: MEM.length,
    dedupeWindowMs: CFG.dedupeWindowMs,
  };
}

export default {
  EVENTS,
  PRIORITY,
  on,
  off,
  emit,
  createNotification,
  notifyAdmins,
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
  getEngineStatus,
};

