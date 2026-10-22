/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · admin-queries.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Capa de datos del panel de administración.

   PRINCIPIOS
     · Una sola ida a la base de datos por métrica (CTEs + agregaciones).
       Nada de N+1: el panel se refresca cada 30 s y no puede martillar
       Postgres.
     · Agregaciones en SQL (SUM / COUNT / FILTER), nunca en JS. Traer
       50 000 filas para sumarlas en memoria es la causa clásica de que
       un panel de admin tumbe la RAM de la instancia.
     · Lecturas siempre acotadas (LIMIT). Las cuentas de pago se
       calculan con índices sobre (status, created_at).
     · Degradación limpia: si la base no está disponible, se devuelven
       datos simulados con `degraded: true` y el panel lo avisa en vez
       de romperse.
     · Defensive SQL: las columnas opcionales (banned, suspended_until…)
       se leen con `to_jsonb(p)->>'col'` para que un schema antiguo no
       rompa el panel con un 42703.

   EXPORTS
     getAdminStats()        → KPIs + serie diaria + salud
     listAdminUsers()       → página de usuarios con conteo de mensajes
     listAdminPayments()    → página de órdenes de pago
     listAdminLogs()        → auditoría (BD + buffer en memoria)
     updateAdminUser()      → banear / desbanear / cambiar rol
     recordAdminAction()    → escribe en el log de auditoría
     resetAdminQueryCache()
   ═══════════════════════════════════════════════════════════════════════════ */

import { sql, supabaseDisponible } from './supabase.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONSTANTES Y HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  maxLimit: 200,
  defaultLimit: 20,
  statsCacheMs: 15_000,
  ringSize: 300,
  revenueDays: 30,
});

const TABLES = Object.freeze({
  payments: 'payments',
  profiles: 'public.profiles',
  chat: 'Chat',
  message: 'Message',
  audit: 'admin_audit_log',
});

/** Ring buffer en memoria: los logs sobreviven aunque la BD esté caída. */
const RING = [];

function pushRing(entry) {
  RING.push({ ...entry, created_at: entry.created_at || new Date().toISOString() });
  if (RING.length > CFG.ringSize) RING.splice(0, RING.length - CFG.ringSize);
}

function clampLimit(limit) {
  const n = parseInt(limit, 10);
  if (!Number.isFinite(n) || n <= 0) return CFG.defaultLimit;
  return Math.min(n, CFG.maxLimit);
}

function clampPage(page) {
  const n = parseInt(page, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return n;
}

function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function pct(current, previous) {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p === 0) return c === 0 ? 0 : 100;
  return ((c - p) / Math.abs(p)) * 100;
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · ESQUEMA (DDL idempotente)
   ═══════════════════════════════════════════════════════════════════════════ */

let schemaPromise = null;

/**
 * Crea la tabla de auditoría si no existe.
 * Idempotente y perezoso: sólo se ejecuta una vez por proceso y sólo
 * cuando hay conexión.
 */
async function ensureAuditSchema() {
  if (!supabaseDisponible()) return false;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    try {
      await sql`
        create table if not exists ${sql(TABLES.audit)} (
          id         uuid primary key default gen_random_uuid(),
          user_id    uuid,
          action     text not null,
          level      text not null default 'info',
          detail     text,
          ip         text,
          meta       jsonb default '{}'::jsonb,
          created_at timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists admin_audit_log_created_idx
          on ${sql(TABLES.audit)} (created_at desc)
      `;
      return true;
    } catch (e) {
      LOG.warn('admin-queries: no se pudo crear la tabla de auditoría', { error: e.message });
      return false;
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · MOCK · datos simulados cuando no hay base de datos
   ═══════════════════════════════════════════════════════════════════════════ */

function mockRevenueByDay(days = CFG.revenueDays) {
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400_000);
    const seed = (d.getDate() * 7 + d.getMonth() * 13) % 17;
    out.push({
      date: d.toISOString().slice(0, 10),
      amount: Number((12 + seed * 3.4).toFixed(2)),
    });
  }
  return out;
}

const MOCK_USERS = [
  { id: '00000000-0000-4000-8000-000000000001', name: 'Ana Restrepo', email: 'ana@numination.app', role: 'admin', plan: 'team', banned: false, suspended: false, verified: true, messages: 482, created_at: '2026-01-12T10:00:00.000Z', last_login_at: '2026-10-20T18:20:00.000Z' },
  { id: '00000000-0000-4000-8000-000000000002', name: 'Carlos Maya', email: 'carlos@example.com', role: 'teacher', plan: 'pro', banned: false, suspended: false, verified: true, messages: 213, created_at: '2026-02-03T08:12:00.000Z', last_login_at: '2026-10-19T09:41:00.000Z' },
  { id: '00000000-0000-4000-8000-000000000003', name: 'Lucía Pardo', email: 'lucia@example.com', role: 'student', plan: 'free', banned: true, suspended: false, verified: false, messages: 17, created_at: '2026-09-30T15:44:00.000Z', last_login_at: '2026-10-02T11:05:00.000Z' },
];

const MOCK_PAYMENTS = [
  { id: '10000000-0000-4000-8000-000000000001', paypal_order_id: 'PAY-9F2K1A', plan_id: 'pro', status: 'completed', amount_cop: 19900, amount_usd: 4.99, currency: 'USD', credits_granted: 500, created_at: '2026-10-20T12:00:00.000Z' },
  { id: '10000000-0000-4000-8000-000000000002', paypal_order_id: 'PAY-7H4D8B', plan_id: 'team', status: 'completed', amount_cop: 49900, amount_usd: 12.5, currency: 'USD', credits_granted: 2000, created_at: '2026-10-18T09:30:00.000Z' },
  { id: '10000000-0000-4000-8000-000000000003', paypal_order_id: 'PAY-2X9Q0M', plan_id: 'pro', status: 'failed', amount_cop: 19900, amount_usd: 4.99, currency: 'USD', credits_granted: 0, created_at: '2026-10-17T20:11:00.000Z' },
];

const MOCK_HEALTH = [
  { name: 'Base de datos', status: 'warn', detail: 'sin conexión (modo simulado)' },
  { name: 'Pagos', status: 'warn', detail: 'datos simulados' },
  { name: 'Mensajería', status: 'warn', detail: 'datos simulados' },
];

/* ═══════════════════════════════════════════════════════════════════════════
   04 · MÉTRICAS PRINCIPALES
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Calcula todas las métricas del dashboard.
 *
 * Estrategia: 3 consultas en paralelo (no 12).
 *   1. Agregados de perfiles + pagos (una sola con CTE).
 *   2. Serie diaria de ingresos (generate_series + join).
 *   3. Usuarios recientes.
 * Los conteos se resuelven en Postgres con COUNT/SUM: el servidor nunca
 * recibe la tabla entera.
 */
export async function getAdminStats({ days = CFG.revenueDays } = {}) {
  const window = Math.max(7, Math.min(parseInt(days, 10) || CFG.revenueDays, 90));

  if (!supabaseDisponible()) {
    return {
      ok: true,
      degraded: true,
      currency: 'USD',
      totalRevenue: 0,
      revenueDeltaPct: 0,
      completedPayments: 0,
      failedPayments: 0,
      pendingPayments: 0,
      avgTicket: 0,
      ticketDeltaPct: 0,
      failureRatePct: 0,
      totalUsers: MOCK_USERS.length,
      newUsers30d: 0,
      activeUsers7d: 0,
      bannedUsers: 0,
      usersDeltaPct: 0,
      totalMessages: 0,
      revenueByDay: mockRevenueByDay(window),
      recentUsers: MOCK_USERS,
      health: MOCK_HEALTH,
      generatedAt: new Date().toISOString(),
    };
  }

  const t0 = Date.now();

  try {
    const [aggRows, seriesRows, recentRows] = await Promise.all([
      // ── 1 · Agregados (CTE: una sola pasada) ────────────────────────────
      sql`
        with u as (
          select
            count(*)::int as total_users,
            count(*) filter (where p."createdAt" >= now() - interval '30 days')::int as new_users_30d,
            count(*) filter (where p."createdAt" >= now() - interval '60 days'
                               and p."createdAt" <  now() - interval '30 days')::int as prev_users_30d,
            count(*) filter (where p.last_login_at >= now() - interval '7 days')::int as active_users_7d,
            count(*) filter (where coalesce((to_jsonb(p)->>'banned')::boolean, false))::int as banned_users
          from ${sql(TABLES.profiles)} p
        ),
        pay as (
          select
            coalesce(sum(amount) filter (where status = 'completed'), 0)::numeric(14,2) as revenue_now,
            coalesce(sum(amount) filter (where status = 'completed'
                              and created_at < now() - interval '30 days'), 0)::numeric(14,2) as revenue_prev,
            count(*) filter (where status = 'completed')::int as completed_now,
            count(*) filter (where status = 'completed'
                               and created_at < now() - interval '30 days')::int as completed_prev,
            count(*) filter (where status in ('failed','refunded','cancelled'))::int as failed,
            count(*) filter (where status in ('created','pending','approved'))::int as pending,
            count(*)::int as total_orders
          from ${sql(TABLES.payments)}
        )
        select u.*, pay.* from u, pay
      `,

      // ── 2 · Serie diaria (una fila por día, holes rellenados por SQL) ───
      sql`
        select
          d::date::text as date,
          coalesce(sum(p.amount), 0)::numeric(14,2) as amount,
          count(p.id)::int as orders
        from generate_series(
               date_trunc('day', now() - make_interval(days => ${window - 1})),
               date_trunc('day', now()),
               interval '1 day'
             ) as d
        left join ${sql(TABLES.payments)} p
               on p.created_at >= d
              and p.created_at <  d + interval '1 day'
              and p.status = 'completed'
        group by d
        order by d
      `,

      // ── 3 · Usuarios recientes ──────────────────────────────────────────
      sql`
        select
          p.id::text as id,
          p.email,
          p."displayName" as name,
          p.role,
          coalesce(p.tier, 'free') as plan,
          p."createdAt" as created_at,
          p.last_login_at,
          coalesce((to_jsonb(p)->>'banned')::boolean, false) as banned,
          coalesce((to_jsonb(p)->>'suspended_until')::timestamptz, null) as suspended_until,
          coalesce((to_jsonb(p)->>'email_verified')::boolean, true) as verified
        from ${sql(TABLES.profiles)} p
        order by p."createdAt" desc
        limit 8
      `,
    ]);

    const agg = aggRows[0] || {};
    const revenueNow = Number(agg.revenue_now || 0);
    const revenuePrev = Number(agg.revenue_prev || 0);
    const completedNow = Number(agg.completed_now || 0);
    const completedPrev = Number(agg.completed_prev || 0);
    const totalOrders = Number(agg.total_orders || 0);
    const failed = Number(agg.failed || 0);

    const avgTicket = completedNow > 0 ? revenueNow / completedNow : 0;
    const prevTicket = completedPrev > 0 ? revenuePrev / completedPrev : 0;

    const totalUsers = Number(agg.total_users || 0);
    const newUsers30d = Number(agg.new_users_30d || 0);
    const prevUsers30d = Number(agg.prev_users_30d || 0);

    const health = buildHealth({ revenueNow, completedNow, failed, totalOrders, elapsedMs: Date.now() - t0 });

    return {
      ok: true,
      degraded: false,
      currency: 'USD',
      totalRevenue: Number(revenueNow.toFixed(2)),
      revenueDeltaPct: Number(pct(revenueNow, revenuePrev).toFixed(2)),
      completedPayments: completedNow,
      failedPayments: failed,
      pendingPayments: Number(agg.pending || 0),
      avgTicket: Number(avgTicket.toFixed(2)),
      ticketDeltaPct: Number(pct(avgTicket, prevTicket).toFixed(2)),
      failureRatePct: totalOrders > 0 ? Number(((failed / totalOrders) * 100).toFixed(2)) : 0,
      totalUsers,
      newUsers30d,
      activeUsers7d: Number(agg.active_users_7d || 0),
      bannedUsers: Number(agg.banned_users || 0),
      usersDeltaPct: Number(pct(newUsers30d, prevUsers30d).toFixed(2)),
      totalMessages: null,
      revenueByDay: seriesRows.map((r) => ({
        date: r.date,
        amount: Number(r.amount || 0),
        orders: Number(r.orders || 0),
      })),
      recentUsers: recentUsersSafe(recentRows),
      health,
      queryMs: Date.now() - t0,
      generatedAt: new Date().toISOString(),
    };
  } catch (e) {
    LOG.error('admin-queries: getAdminStats falló', { error: e.message, code: e.code });
    return {
      ok: true,
      degraded: true,
      currency: 'USD',
      totalRevenue: 0,
      revenueDeltaPct: 0,
      completedPayments: 0,
      failedPayments: 0,
      pendingPayments: 0,
      avgTicket: 0,
      ticketDeltaPct: 0,
      failureRatePct: 0,
      totalUsers: MOCK_USERS.length,
      newUsers30d: 0,
      activeUsers7d: 0,
      bannedUsers: 0,
      usersDeltaPct: 0,
      revenueByDay: mockRevenueByDay(window),
      recentUsers: MOCK_USERS,
      health: [{ name: 'Base de datos', status: 'error', detail: e.code || 'error' }],
      generatedAt: new Date().toISOString(),
    };
  }
}

function recentUsersSafe(rows) {
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    plan: r.plan,
    created_at: r.created_at,
    last_login_at: r.last_login_at,
    banned: r.banned,
    suspended: Boolean(r.suspended_until),
    verified: r.verified,
    messages: 0,
  }));
}

function buildHealth({ revenueNow, completedNow, failed, totalOrders, elapsedMs }) {
  const health = [];

  health.push({
    name: 'Base de datos',
    status: 'ok',
    detail: `${elapsedMs} ms`,
  });

  const failureRate = totalOrders > 0 ? (failed / totalOrders) * 100 : 0;
  health.push({
    name: 'Pagos',
    status: failureRate > 10 ? 'error' : failureRate > 5 ? 'warn' : 'ok',
    detail: `${completedNow} ok · ${failureRate.toFixed(1)}% fallo`,
  });

  health.push({
    name: 'Ingresos',
    status: revenueNow > 0 ? 'ok' : 'warn',
    detail: revenueNow > 0 ? `$${revenueNow.toFixed(2)} últimos 30 d` : 'sin ingresos en 30 d',
  });

  health.push({
    name: 'Rendimiento',
    status: elapsedMs > 1500 ? 'warn' : 'ok',
    detail: elapsedMs > 1500 ? 'consulta lenta' : 'óptimo',
  });

  return health;
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · USUARIOS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Lista usuarios con paginación y filtros.
 *
 * El conteo de mensajes se resuelve en una SEGUNDA consulta acotada a los
 * ids de la página actual. Hacerlo con un JOIN lateral obligaría a
 * agregar todos los mensajes de todos los usuarios que cumplen el filtro
 * (incluso los que después se descartan con LIMIT): eso es exactamente
 * el patrón que tumba la RAM de Postgres.
 */
export async function listAdminUsers({ page = 1, limit = 20, q = '', role = '', plan = '' } = {}) {
  const p = clampPage(page);
  const l = clampLimit(limit);
  const offset = (p - 1) * l;
  const search = String(q || '').trim().toLowerCase();

  if (!supabaseDisponible()) {
    const filtered = MOCK_USERS.filter((u) => {
      if (role && u.role !== role) return false;
      if (plan && u.plan !== plan) return false;
      if (search && !(`${u.name} ${u.email}`.toLowerCase().includes(search))) return false;
      return true;
    });
    return {
      ok: true,
      degraded: true,
      users: filtered.slice(offset, offset + l),
      total: filtered.length,
      page: p,
      pages: Math.max(Math.ceil(filtered.length / l), 1),
    };
  }

  try {
    const filters = [];
    if (role) filters.push(sql`p.role = ${role}`);
    if (plan) filters.push(sql`coalesce(p.tier, 'free') = ${plan}`);
    if (search) {
      filters.push(sql`(p.email ilike ${`%${search}%`} or p."displayName" ilike ${`%${search}%`})`);
    }
    const where = filters.length
      ? sql`where ${filters.reduce((acc, cur, i) => (i === 0 ? cur : sql`${acc} and ${cur}`))}`
      : sql``;

    const [rows, countRows] = await Promise.all([
      sql`
        select
          p.id::text as id,
          p.email,
          p."displayName" as name,
          p.role,
          coalesce(p.tier, 'free') as plan,
          p."createdAt" as created_at,
          p.last_login_at,
          coalesce((to_jsonb(p)->>'banned')::boolean, false) as banned,
          coalesce((to_jsonb(p)->>'suspended_until')::timestamptz, null) as suspended_until,
          coalesce((to_jsonb(p)->>'email_verified')::boolean, true) as verified
        from ${sql(TABLES.profiles)} p
        ${where}
        order by p."createdAt" desc
        limit ${l} offset ${offset}
      `,
      sql`
        select count(*)::int as total
        from ${sql(TABLES.profiles)} p
        ${where}
      `,
    ]);

    const users = await attachMessageCounts(rows);

    const total = Number(countRows[0]?.total || 0);

    return {
      ok: true,
      degraded: false,
      users,
      total,
      page: p,
      pages: Math.max(Math.ceil(total / l), 1),
      limit: l,
    };
  } catch (e) {
    LOG.error('admin-queries: listAdminUsers falló', { error: e.message, code: e.code });
    return { ok: false, error: 'No se pudieron cargar los usuarios.', users: [], total: 0, page: p, pages: 1 };
  }
}

/**
 * Adjunta el conteo de mensajes de la página actual.
 * Una sola consulta agrupada, acotada a <= maxLimit ids.
 */
async function attachMessageCounts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return list;

  const ids = list.map((r) => r.id).filter((id) => isUuid(id));
  if (!ids.length) return list.map((r) => ({ ...r, messages: 0 }));

  try {
    const counts = await sql`
      select c."userId"::text as user_id, count(m.id)::int as messages
      from ${sql(TABLES.chat)} c
      join ${sql(TABLES.message)} m on m."chatId" = c.id
      where c."userId"::text = any(${sql(ids)})
      group by c."userId"::text
    `;

    const map = new Map(counts.map((c) => [c.user_id, Number(c.messages || 0)]));
    return list.map((r) => ({ ...r, messages: map.get(r.id) || 0 }));
  } catch (e) {
    LOG.warn('admin-queries: attachMessageCounts falló', { error: e.message });
    return list.map((r) => ({ ...r, messages: 0 }));
  }
}

/**
 * Detecta qué columnas opcionales existen realmente en public.profiles.
 * Se cachea 5 minutos: el schema cambia muy pocas veces y consultarlo
 * en cada request sería una ida extra a la base.
 */
let columnsCache = { at: 0, value: null };

async function profileColumns() {
  if (columnsCache.value && Date.now() - columnsCache.at < 300_000) {
    return columnsCache.value;
  }
  try {
    const rows = await sql`
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'profiles'
    `;
    const set = new Set(rows.map((r) => r.column_name));
    columnsCache = { at: Date.now(), value: set };
    return set;
  } catch (e) {
    LOG.warn('admin-queries: no se pudo leer el schema de profiles', { error: e.message });
    columnsCache = { at: Date.now(), value: new Set() };
    return columnsCache.value;
  }
}

/**
 * Actualiza un usuario (ban / rol / plan).
 * Sólo campos de una lista blanca; nunca se acepta SQL libre.
 */
export async function updateAdminUser(userId, patch = {}) {
  if (!isUuid(userId)) {
    return { ok: false, error: 'Identificador de usuario inválido.' };
  }
  if (!supabaseDisponible()) {
    return { ok: true, degraded: true, user: { id: userId, ...patch } };
  }

  const columns = await profileColumns();
  const sets = [];

  if (patch.action === 'toggle_ban') {
    if (!columns.has('banned')) {
      return { ok: false, error: 'El esquema no tiene la columna "banned".' };
    }
    sets.push(sql`banned = not coalesce(banned, false)`);
  }

  if (typeof patch.role === 'string' && ['admin', 'teacher', 'student', 'user'].includes(patch.role)) {
    sets.push(sql`role = ${patch.role}`);
  }

  if (typeof patch.plan === 'string' && ['free', 'pro', 'team'].includes(patch.plan)) {
    if (!columns.has('tier')) {
      return { ok: false, error: 'El esquema no tiene la columna "tier".' };
    }
    sets.push(sql`tier = ${patch.plan}`);
  }

  if (patch.suspended === true && columns.has('suspended_until')) {
    sets.push(sql`suspended_until = now() + interval '30 days'`);
  } else if (patch.suspended === false && columns.has('suspended_until')) {
    sets.push(sql`suspended_until = null`);
  }

  if (!sets.length) {
    return { ok: false, error: 'No hay cambios válidos que aplicar.' };
  }

  try {
    const rows = await sql`
      update ${sql(TABLES.profiles)}
      set ${sets.reduce((acc, cur, i) => (i === 0 ? cur : sql`${acc}, ${cur}`))}
      where id = ${userId}::uuid
      returning id::text as id, email, "displayName" as name, role,
                coalesce(tier, 'free') as plan,
                coalesce(banned, false) as banned
    `;
    return { ok: true, user: rows[0] || null };
  } catch (e) {
    LOG.error('admin-queries: updateAdminUser falló', { error: e.message, code: e.code });
    return { ok: false, error: 'No se pudo actualizar el usuario.' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · PAGOS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Lista órdenes de pago con paginación y filtro por estado.
 * Ordena por fecha descendente usando el índice payments_user_idx /
 * created_at; el filtro por estado se resuelve en el propio scan.
 */
export async function listAdminPayments({ page = 1, limit = 20, status = '' } = {}) {
  const p = clampPage(page);
  const l = clampLimit(limit);
  const offset = (p - 1) * l;
  const st = String(status || '').trim();

  if (!supabaseDisponible()) {
    const filtered = st ? MOCK_PAYMENTS.filter((x) => x.status === st) : MOCK_PAYMENTS;
    return {
      ok: true,
      degraded: true,
      payments: filtered.slice(offset, offset + l),
      total: filtered.length,
      page: p,
      pages: Math.max(Math.ceil(filtered.length / l), 1),
      sumAmount: filtered.reduce((a, b) => a + Number(b.amount_usd || 0), 0),
    };
  }

  try {
    const where = st ? sql`where status = ${st}` : sql``;

    const [rows, countRows, sumRows] = await Promise.all([
      sql`
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
        from ${sql(TABLES.payments)}
        ${where}
        order by created_at desc
        limit ${l} offset ${offset}
      `,
      sql`select count(*)::int as total from ${sql(TABLES.payments)} ${where}`,
      sql`
        select coalesce(sum(amount), 0)::numeric(14,2) as total
        from ${sql(TABLES.payments)}
        ${where}
      `,
    ]);

    const total = Number(countRows[0]?.total || 0);

    return {
      ok: true,
      degraded: false,
      payments: rows.map((r) => ({
        ...r,
        amount: Number(r.amount || 0),
        credits_granted: Number(r.credits_granted || 0),
      })),
      total,
      page: p,
      pages: Math.max(Math.ceil(total / l), 1),
      limit: l,
      sumAmount: Number(sumRows[0]?.total || 0),
    };
  } catch (e) {
    LOG.error('admin-queries: listAdminPayments falló', { error: e.message, code: e.code });
    return { ok: false, error: 'No se pudieron cargar los pagos.', payments: [], total: 0, page: p, pages: 1 };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   07 · LOGS DE AUDITORÍA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Registra una acción administrativa.
 * Siempre escribe en el buffer en memoria; además persiste si hay BD.
 */
export async function recordAdminAction({ action, level = 'info', detail = '', userId = null, ip = null, meta = null }) {
  const entry = {
    action: String(action || 'unknown'),
    level: String(level || 'info'),
    detail: String(detail || '').slice(0, 500),
    user_id: userId,
    ip,
    meta,
    created_at: new Date().toISOString(),
  };

  pushRing(entry);

  if (!supabaseDisponible()) return { ok: true, degraded: true };

  try {
    await ensureAuditSchema();
    await sql`
      insert into ${sql(TABLES.audit)} (user_id, action, level, detail, ip, meta)
      values (
        ${isUuid(userId) ? userId : null}::uuid,
        ${entry.action},
        ${entry.level},
        ${entry.detail},
        ${ip},
        ${meta ? sql.json(meta) : sql.json({})}
      )
    `;
    return { ok: true };
  } catch (e) {
    LOG.warn('admin-queries: recordAdminAction falló', { error: e.message });
    return { ok: false };
  }
}

/**
 * Devuelve los logs combining BD + buffer en memoria.
 * El buffer garantiza que la vista nunca quede vacía aunque la tabla
 * todavía no exista o la BD esté caída.
 */
export async function listAdminLogs({ page = 1, limit = 20, level = '' } = {}) {
  const p = clampPage(page);
  const l = clampLimit(limit);
  const offset = (p - 1) * l;
  const lv = String(level || '').trim().toLowerCase();

  if (!supabaseDisponible()) {
    const filtered = lv ? RING.filter((e) => e.level === lv) : RING.slice();
    const ordered = filtered.slice().reverse();
    return {
      ok: true,
      degraded: true,
      logs: ordered.slice(offset, offset + l),
      total: ordered.length,
      page: p,
      pages: Math.max(Math.ceil(ordered.length / l), 1),
    };
  }

  try {
    await ensureAuditSchema();

    const where = lv ? sql`where level = ${lv}` : sql``;

    const [rows, countRows] = await Promise.all([
      sql`
        select
          id::text as id,
          user_id::text as user_id,
          action,
          level,
          detail,
          ip,
          created_at
        from ${sql(TABLES.audit)}
        ${where}
        order by created_at desc
        limit ${l} offset ${offset}
      `,
      sql`select count(*)::int as total from ${sql(TABLES.audit)} ${where}`,
    ]);

    const total = Number(countRows[0]?.total || 0);

    return {
      ok: true,
      degraded: false,
      logs: rows,
      total,
      page: p,
      pages: Math.max(Math.ceil(total / l), 1),
    };
  } catch (e) {
    LOG.error('admin-queries: listAdminLogs falló', { error: e.message, code: e.code });
    const ordered = RING.slice().reverse();
    return {
      ok: true,
      degraded: true,
      logs: ordered.slice(offset, offset + l),
      total: ordered.length,
      page: p,
      pages: Math.max(Math.ceil(ordered.length / l), 1),
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · UTILIDADES PÚBLICAS
   ═══════════════════════════════════════════════════════════════════════════ */

export function getAdminQueryStats() {
  return {
    dbAvailable: supabaseDisponible(),
    ringSize: RING.length,
    ringCapacity: CFG.ringSize,
    maxLimit: CFG.maxLimit,
    defaultLimit: CFG.defaultLimit,
    revenueDays: CFG.revenueDays,
  };
}

export function resetAdminQueryCache() {
  RING.length = 0;
  schemaPromise = null;
}

export default {
  getAdminStats,
  listAdminUsers,
  listAdminPayments,
  listAdminLogs,
  updateAdminUser,
  recordAdminAction,
  getAdminQueryStats,
  resetAdminQueryCache,
};
