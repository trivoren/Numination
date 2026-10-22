/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/audit-logger.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Log de auditoría: quién hizo qué, desde dónde y cuándo.

   QUÉ SE REGISTRA
     Toda acción que modifica datos o permisos:
       · auth.login / auth.logout / auth.failed
       · user.role_change / user.ban / user.suspend
       · payment.created / payment.completed / payment.refunded
       · admin.stats_view / admin.user_update
       · gdpr.export / gdpr.delete
       · sandbox.exec
     Todo lo que llega desde `req` se guarda normalizado y con longitudes
     acotadas: la auditoría no es un vertedero de payloads.

   ESQUEMA `audit_logs`
     id, user_id, action, ip, user_agent, meta (jsonb), created_at

   ÍNDICES
     · (user_id, created_at desc) → "qué hizo este usuario".
     · (action, created_at desc)  → "qué pasa con esta acción".
     · (created_at desc)          → feed global.

   PRIVACIDAD
     · La IP se guarda completa (es un dato de auditoría legítimo), pero
       el `meta` NUNCA contiene contraseñas, tokens ni cuerpos de
       request: se filtra con `scrubMeta`.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql, supabaseDisponible } from './supabase.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  table: 'audit_logs',
  maxMetaBytes: 4000,
  maxUserAgent: 300,
  maxIp: 64,
  retentionDays: 365,
  // Buffer en memoria: si la BD está caída, la auditoría no se pierde.
  bufferMax: 500,
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · ESQUEMA
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
          user_id    uuid,
          actor_id   uuid,
          action     text not null,
          status     text not null default 'ok',
          ip         text,
          user_agent text,
          meta       jsonb default '{}'::jsonb,
          created_at timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists audit_logs_user_idx
          on ${sql(CFG.table)} (user_id, created_at desc)
      `;
      await sql`
        create index if not exists audit_logs_action_idx
          on ${sql(CFG.table)} (action, created_at desc)
      `;
      await sql`
        create index if not exists audit_logs_created_idx
          on ${sql(CFG.table)} (created_at desc)
      `;
      return { ok: true };
    } catch (e) {
      LOG.warn('audit-logger: no se pudo crear el esquema', { error: e.message, code: e.code });
      return { ok: false };
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · SANITIZACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const SECRET_KEYS = [
  'password', 'passwd', 'pwd', 'secret', 'token', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'apikey', 'api_key', 'authorization', 'cookie',
  'session', 'jwt', 'bearer', 'otp', 'pin', 'cvv', 'cardnumber', 'card_number',
];

function isSecretKey(key) {
  const k = String(key || '').toLowerCase().replace(/[^a-z]/g, '');
  return SECRET_KEYS.some((s) => k.includes(s.replace(/[^a-z]/g, '')));
}

/**
 * Limpia el objeto `meta`: elimina secretos y acota tamaños.
 */
export function scrubMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};

  const out = {};
  let size = 0;

  for (const [key, value] of Object.entries(meta)) {
    if (size > CFG.maxMetaBytes) break;

    if (isSecretKey(key)) {
      out[key] = '[REDACTED]';
      size += 20;
      continue;
    }

    if (value === null || value === undefined) {
      out[key] = null;
      continue;
    }

    if (typeof value === 'object') {
      out[key] = scrubMeta(value);
      continue;
    }

    const str = String(value);
    if (str.length > 500) {
      out[key] = `${str.slice(0, 500)}…`;
      size += 500;
    } else {
      out[key] = str;
      size += str.length;
    }
  }

  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · BUFFER EN MEMORIA
   ═══════════════════════════════════════════════════════════════════════════ */

const buffer = [];

function bufferPush(entry) {
  buffer.unshift(entry);
  if (buffer.length > CFG.bufferMax) buffer.length = CFG.bufferMax;
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · API PÚBLICA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Registra una acción.
 *
 * @param {string|null} userId  Usuario afectado (puede ser null)
 * @param {string} action       Acción (ej: 'auth.login')
 * @param {object} [meta]        Contexto extra (se sanea)
 * @param {object} [opts]        { req, status, actorId, ip, userAgent }
 * @returns {Promise<object>} { ok, id, degraded }
 */
export async function logAction(userId, action, meta = {}, opts = {}) {
  const cleanAction = String(action || 'unknown').slice(0, 120);
  const req = opts.req || null;

  const ip = String(
    opts.ip ||
    (req && (req.headers['cf-connecting-ip'] || req.headers['x-real-ip'] || req.socket?.remoteAddress)) ||
    ''
  ).slice(0, CFG.maxIp);

  const userAgent = String(
    opts.userAgent ||
    (req && req.headers['user-agent']) ||
    ''
  ).slice(0, CFG.maxUserAgent);

  const payload = scrubMeta(meta);
  const status = String(opts.status || 'ok').slice(0, 20);

  const entry = {
    userId: userId || null,
    actorId: opts.actorId || null,
    action: cleanAction,
    status,
    ip,
    userAgent,
    meta: payload,
    createdAt: new Date().toISOString(),
  };

  bufferPush(entry);

  if (!supabaseDisponible()) {
    return { ok: true, degraded: true, id: null };
  }

  try {
    await ensureSchema();

    const rows = await sql`
      insert into ${sql(CFG.table)} (user_id, actor_id, action, status, ip, user_agent, meta)
      values (
        ${isUuid(userId) ? userId : null}::uuid,
        ${isUuid(opts.actorId) ? opts.actorId : null}::uuid,
        ${cleanAction},
        ${status},
        ${ip || null},
        ${userAgent || null},
        ${sql.json(payload)}
      )
      returning id::text as id
    `;

    return { ok: true, degraded: false, id: rows[0]?.id || null };
  } catch (e) {
    LOG.warn('audit-logger: no se pudo escribir el registro', { action: cleanAction, error: e.message });
    return { ok: false, degraded: false, error: e.message };
  }
}

/**
 * Middleware Express: registra la request y su resultado.
 *
 * @param {object} [opts] { action, actions, skipPaths }
 * @returns {function} middleware
 */
export function auditMiddleware(opts = {}) {
  const {
    actions = null,          // ['auth.login', ...] o null = todas
    skipPaths = ['/api/health', '/api/version', '/api/ping', '/assets'],
    skipStatic = true,
  } = opts;

  return async function audit(req, res, next) {
    if (skipPaths.includes(req.path) || (skipStatic && req.method === 'GET' && !req.path.startsWith('/api/admin'))) {
      return next();
    }

    const started = Date.now();

    res.on('finish', () => {
      const action = actions && actions.length
        ? actions[0]
        : `${req.method.toLowerCase()}.${req.path.split('/').filter(Boolean).slice(0, 2).join('.') || 'root'}`;

      logAction(req.user?.id || null, action, {
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        durationMs: Date.now() - started,
      }, { req, status: res.statusCode < 400 ? 'ok' : 'error' }).catch(() => {});
    });

    return next();
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · CONSULTAS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Lee el log de auditoría.
 *
 * @param {object} [opts] { userId, action, since, limit, offset }
 */
export async function getAuditLogs(opts = {}) {
  if (!supabaseDisponible()) {
    const filtered = buffer.filter((e) => {
      if (opts.userId && e.userId !== opts.userId) return false;
      if (opts.action && e.action !== opts.action) return false;
      return true;
    });
    return {
      ok: true,
      degraded: true,
      logs: filtered.slice(0, opts.limit || 100),
      total: filtered.length,
    };
  }

  try {
    await ensureSchema();

    const filters = [];
    if (opts.userId) filters.push(sql`user_id = ${opts.userId}::uuid`);
    if (opts.action) filters.push(sql`action = ${opts.action}`);
    if (opts.since) filters.push(sql`created_at >= ${opts.since}`);

    const where = filters.length
      ? sql`where ${filters.reduce((acc, cur, i) => (i === 0 ? cur : sql`${acc} and ${cur}`))}`
      : sql``;

    const limit = Math.min(Number(opts.limit) || 100, 500);
    const offset = Math.max(Number(opts.offset) || 0, 0);

    const [rows, countRows] = await Promise.all([
      sql`
        select
          id::text as id,
          user_id::text as user_id,
          actor_id::text as actor_id,
          action,
          status,
          ip,
          user_agent,
          meta,
          created_at
        from ${sql(CFG.table)}
        ${where}
        order by created_at desc
        limit ${limit} offset ${offset}
      `,
      sql`select count(*)::int as total from ${sql(CFG.table)} ${where}`,
    ]);

    return {
      ok: true,
      degraded: false,
      logs: rows,
      total: Number(countRows[0]?.total || 0),
    };
  } catch (e) {
    LOG.warn('audit-logger: getAuditLogs falló', { error: e.message });
    return { ok: true, degraded: true, logs: buffer.slice(0, 100), total: buffer.length };
  }
}

/**
 * Resumen de actividad por acción (para el panel de admin).
 */
export async function getAuditSummary({ days = 7 } = {}) {
  if (!supabaseDisponible()) {
    return { ok: true, degraded: true, byAction: [], errors: 0 };
  }

  try {
    await ensureSchema();

    const rows = await sql`
      select action, count(*)::int as count
      from ${sql(CFG.table)}
      where created_at >= now() - ${Number(days) || 7} * interval '1 day'
      group by action
      order by count desc
      limit 50
    `;

    const errorRows = await sql`
      select count(*)::int as errors
      from ${sql(CFG.table)}
      where status = 'error'
        and created_at >= now() - ${Number(days) || 7} * interval '1 day'
    `;

    return {
      ok: true,
      degraded: false,
      byAction: rows,
      errors: Number(errorRows[0]?.errors || 0),
    };
  } catch (e) {
    LOG.warn('audit-logger: getAuditSummary falló', { error: e.message });
    return { ok: true, degraded: true, byAction: [], errors: 0 };
  }
}

/**
 * Elimina registros antiguos (retención).
 */
export async function purgeOldLogs(days = CFG.retentionDays) {
  if (!supabaseDisponible()) return { ok: true, degraded: true, deleted: 0 };

  try {
    await ensureSchema();
    const rows = await sql`
      delete from ${sql(CFG.table)}
      where created_at < now() - ${Number(days) || CFG.retentionDays} * interval '1 day'
      returning id
    `;
    return { ok: true, deleted: rows.length };
  } catch (e) {
    LOG.warn('audit-logger: purgeOldLogs falló', { error: e.message });
    return { ok: false, deleted: 0 };
  }
}

function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export function getAuditStatus() {
  return {
    dbAvailable: supabaseDisponible(),
    bufferSize: buffer.length,
    bufferMax: CFG.bufferMax,
    retentionDays: CFG.retentionDays,
  };
}

export default {
  logAction,
  auditMiddleware,
  getAuditLogs,
  getAuditSummary,
  purgeOldLogs,
  scrubMeta,
  getAuditStatus,
};
