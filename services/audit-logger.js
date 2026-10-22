/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/audit-logger.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Registro de auditoría: quién hizo qué, desde dónde y cuándo.

   QUÉ SE REGISTRA
     Toda acción que modifica datos o permisos:
       auth.login · auth.logout · auth.failed · user.ban · user.suspend
       payment.created · payment.completed · payment.refunded
       admin.stats_view · admin.user_update · gdpr.export · gdpr.delete
       sandbox.exec · flag.update

   PRIVACIDAD
     · La IP NUNCA se guarda en claro: se guarda su hash sha256 con
       sal (AUDIT_IP_SALT o JWT_SECRET). El objetivo es poder correlacionar
       sesiones sin storing un dato personal directo.
     · El `meta` se limpia: contraseñas, tokens, cookies y cabeceras de
       autorización nunca llegan a la tabla.

   ESQUEMA `audit_logs`
     id, user_id, actor_id, action, status, ip, user_agent, meta, created_at

   CONTRATO
     logAction(userId, action, req, meta) → { ok, id, buffered }
   ═══════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql, supabaseDisponible } from '../src/services/supabase.js';
import { LOG } from '../src/lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  table: 'audit_logs',
  maxUserAgent: 300,
  maxAction: 120,
  maxMetaBytes: 4000,
  bufferMax: 500,
  maxValueLength: 500,
});

const SENSITIVE_KEYS = [
  'password', 'passwd', 'pass', 'pwd', 'token', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'idtoken', 'id_token', 'secret', 'jwt',
  'authorization', 'auth', 'cookie', 'session', 'sessionid', 'session_id',
  'apikey', 'api_key', 'card', 'cardnumber', 'card_number', 'cvv', 'cvc',
  'ssn', 'iban', 'pin', 'otp', 'code',
];

const REDACTED = '[redacted]';

/* ═══════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isSensitiveKey(key) {
  const norm = String(key || '').toLowerCase().replace(/[^a-z]/g, '');
  return SENSITIVE_KEYS.some((k) => norm.includes(k.replace(/[^a-z]/g, '')));
}

/**
 * Hashea una IP con sal. La IP en claro no se persiste nunca.
 * @param {string} ip
 * @returns {string|null}
 */
export function hashIp(ip) {
  const value = String(ip ?? '').trim();
  if (!value) return null;

  const salt = process.env.AUDIT_IP_SALT
    || process.env.JWT_SECRET
    || 'numination-audit-static-salt';

  try {
    return crypto
      .createHash('sha256')
      .update(`${salt}:${value}`)
      .digest('hex');
  } catch (e) {
    LOG.warn('audit-logger: no se pudo hashear la IP', { error: e.message });
    return null;
  }
}

/**
 * Limpia un objeto de datos sensibles (recursivo).
 * @param {*} value
 * @param {number} [depth]
 * @returns {*}
 */
export function scrubObject(value, depth = 0) {
  if (depth > 6) return '[depth]';

  if (value === null || value === undefined) return value ?? null;

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => scrubObject(v, depth + 1));
  }

  if (value instanceof Date) return value.toISOString();

  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
        continue;
      }
      out[key] = scrubObject(val, depth + 1);
    }
    return out;
  }

  if (typeof value === 'string' && value.length > CFG.maxValueLength) {
    return `${value.slice(0, CFG.maxValueLength)}…`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  return String(value).slice(0, CFG.maxValueLength);
}

/**
 * Limpia el meta y lo limita en tamaño.
 * @param {object} meta
 * @returns {object}
 */
export function scrubMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};

  try {
    const cleaned = scrubObject(meta, 0);
    const json = JSON.stringify(cleaned);
    if (json.length <= CFG.maxMetaBytes) return cleaned;

    return {
      _truncated: true,
      _originalBytes: json.length,
      preview: json.slice(0, CFG.maxMetaBytes),
    };
  } catch (e) {
    LOG.warn('audit-logger: meta no serializable', { error: e.message });
    return { _error: 'unserializable' };
  }
}

/**
 * Extrae la IP del request respetando los proxies.
 * @param {object} req
 * @returns {string|null}
 */
export function extractIp(req) {
  if (!req) return null;

  try {
    const forwarded = req.headers?.['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) {
      return forwarded.split(',')[0].trim();
    }
    if (Array.isArray(forwarded) && forwarded.length) return String(forwarded[0]).trim();
    return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || null;
  } catch {
    return null;
  }
}

function extractUserAgent(req) {
  try {
    const ua = req?.headers?.['user-agent'] || req?.get?.('user-agent') || '';
    return String(ua).slice(0, CFG.maxUserAgent);
  } catch {
    return '';
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   03 · ESQUEMA + BUFFER
   ═══════════════════════════════════════════════════════════════════════ */

let schemaPromise = null;

async function ensureSchema() {
  if (!supabaseDisponible()) return false;
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
      return true;
    } catch (e) {
      LOG.warn('audit-logger: no se pudo crear el esquema', { error: e.message, code: e.code });
      return false;
    }
  })();

  return schemaPromise;
}

/** Buffer en memoria: si la BD está caída, la auditoría no se pierde. */
const buffer = [];

function bufferPush(entry) {
  if (buffer.length >= CFG.bufferMax) buffer.shift();
  buffer.push({ ...entry, bufferedAt: new Date().toISOString() });
}

/** Entradas pendientes de volcar a la base de datos. */
export function getBuffered() {
  return [...buffer];
}

/**
 * Vuelca el buffer a la base de datos.
 * @returns {Promise<number>} entradas escritas
 */
export async function flushBuffer() {
  if (!buffer.length || !supabaseDisponible()) return 0;

  const pending = buffer.splice(0, buffer.length);
  let written = 0;

  for (const entry of pending) {
    try {
      await sql`
        insert into ${sql(CFG.table)}
          (user_id, actor_id, action, status, ip, user_agent, meta)
        values (
          ${entry.user_id}::uuid,
          ${entry.actor_id}::uuid,
          ${entry.action},
          ${entry.status},
          ${entry.ip},
          ${entry.user_agent},
          ${entry.meta}::jsonb
        )
      `;
      written += 1;
    } catch (e) {
      LOG.warn('audit-logger: no se pudo volcar el buffer', { error: e.message });
      bufferPush(entry);
    }
  }

  return written;
}

/* ═══════════════════════════════════════════════════════════════════════
   04 · API
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Registra una acción en la auditoría.
 *
 * @param {string} userId      Usuario protagonista (puede ser null).
 * @param {string} action      Acción performed (p.ej. 'auth.login').
 * @param {object} [req]       Request de Express (IP, user-agent).
 * @param {object} [meta]      Datos extra (se limpian antes de guardar).
 * @returns {Promise<{ok:boolean, id:string|null, buffered:boolean, error:string|null}>}
 */
export async function logAction(userId, action, req = null, meta = {}) {
  const cleanAction = String(action ?? '').trim().slice(0, CFG.maxAction);
  const entry = {
    user_id: isUuid(userId) ? userId : null,
    actor_id: isUuid(meta?.actorId) ? meta.actorId : null,
    action: cleanAction || 'unknown',
    status: String(meta?.status ?? 'ok').slice(0, 20),
    ip: hashIp(extractIp(req)),
    user_agent: extractUserAgent(req),
    meta: scrubMeta(meta),
  };

  if (!cleanAction) {
    LOG.warn('audit-logger: acción vacía, se registra como unknown');
  }

  try {
    if (!supabaseDisponible()) {
      bufferPush(entry);
      return { ok: false, id: null, buffered: true, error: 'DB_NO_DISPONIBLE' };
    }

    await ensureSchema();

    const rows = await sql`
      insert into ${sql(CFG.table)}
        (user_id, actor_id, action, status, ip, user_agent, meta)
      values (
        ${entry.user_id}::uuid,
        ${entry.actor_id}::uuid,
        ${entry.action},
        ${entry.status},
        ${entry.ip},
        ${entry.user_agent},
        ${entry.meta}::jsonb
      )
      returning id
    `;

    return {
      ok: true,
      id: rows?.[0]?.id ?? null,
      buffered: false,
      error: null,
    };
  } catch (e) {
    LOG.warn('audit-logger: fallo al registrar', {
      action: entry.action,
      error: e.message,
      code: e.code,
    });
    bufferPush(entry);
    return { ok: false, id: null, buffered: true, error: e.message };
  }
}

/**
 * Lee las acciones de un usuario (uso del panel de admin).
 * @param {string} userId
 * @param {object} [options]
 * @param {number} [options.limit]
 * @returns {Promise<Array>}
 */
export async function listUserActions(userId, options = {}) {
  const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));

  if (!supabaseDisponible() || !isUuid(userId)) return [];

  try {
    const rows = await sql`
      select id, action, status, ip, user_agent, meta, created_at
      from ${sql(CFG.table)}
      where user_id = ${userId}::uuid
      order by created_at desc
      limit ${limit}
    `;
    return rows || [];
  } catch (e) {
    LOG.warn('audit-logger: no se pudo listar', { error: e.message });
    return [];
  }
}

export default {
  logAction,
  listUserActions,
  hashIp,
  scrubMeta,
  scrubObject,
  extractIp,
  getBuffered,
  flushBuffer,
};
