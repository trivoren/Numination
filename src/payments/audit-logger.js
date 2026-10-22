/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · payments/audit-logger.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Bitácora de auditoría del flujo de pagos.

   OBJETIVO:
     · Dejar rastro INALTERABLE de cada evento de pago: quién, qué orden,
       en qué estado, desde qué IP y con qué metadatos.
     · La tabla se crea con `CREATE TABLE IF NOT EXISTS` en el primer uso:
       el módulo funciona aunque la migración manual no se haya corrido.
     · Capturar la IP REAL del cliente (`req.ip` ya viene resuelta por
       Express con `trust proxy`), con fallback a los headers estándar
       de CDN/proxy y al socket.
     · NUNCA romper el request por un fallo de auditoría: si el insert
       falla se loguea el error y se devuelve `false`. Un error de log
       no puede tumbar un cobro ya cobrado.

   TABLA: payment_audit_logs
     id · user_id · order_id · status · ip · user_agent · meta · created_at
   ═══════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql, supabaseDisponible } from '../services/supabase.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('payments-audit');

const CFG = {
  table: 'payment_audit_logs',
  maxMetaBytes: 8000,          // tope del JSON de metadatos
  maxTextLength: 300,
};

const METRICS = { written: 0, failed: 0, skipped: 0 };

let schemaReady = null;

/* ═══════════════════════════════════════════════════════════════════════
   1 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;

/**
 * Valida un IPv4 (cada octeto 0-255).
 * @param {string} value
 * @returns {boolean}
 */
function isValidIpv4(value) {
  const match = IPV4_RE.exec(value);
  if (!match) return false;
  return match.slice(1).every((octet) => Number(octet) >= 0 && Number(octet) <= 255);
}

/**
 * Valida un IPv6, incluyendo la forma comprimida (`::1`, `fe80::1`) y la
 * forma mapeada con IPv4 (`::ffff:127.0.0.1`).
 * @param {string} value
 * @returns {boolean}
 */
function isValidIpv6(value) {
  if (!value.includes(':')) return false;

  const doubleColons = value.match(/::/g) || [];
  if (doubleColons.length > 1) return false;

  const parts = value.split(':');
  let groups = 0;
  let sawEmpty = false;

  for (const part of parts) {
    if (part === '') {
      sawEmpty = true;
      continue;
    }
    if (part.includes('.')) {
      // Cola IPv4 mapeada (::ffff:127.0.0.1) → ocupa 2 grupos.
      if (!isValidIpv4(part)) return false;
      groups += 2;
      continue;
    }
    if (!IPV6_GROUP_RE.test(part)) return false;
    groups += 1;
  }

  if (groups > 8) return false;
  if (sawEmpty && doubleColons.length === 0) return false;  // ':' suelta
  if (!sawEmpty && groups !== 8) return false;              // IPv6 completo
  return true;
}

/**
 * Valida que un string tenga forma de dirección IP.
 * @param {string} value
 * @returns {boolean}
 */
export function isValidIp(value) {
  const v = String(value || '').trim();
  if (!v) return false;
  if (isValidIpv4(v)) return true;
  return isValidIpv6(v);
}

/**
 * Resuelve la IP REAL del cliente.
 *
 * Orden de preferencia:
 *   1. `req.ip` → Express ya aplica `trust proxy` (en este proyecto es 1),
 *      por lo que devuelve la IP del cliente y no la del proxy.
 *   2. Headers de CDN/proxy (Cloudflare, nginx).
 *   3. `req.socket.remoteAddress`.
 *
 * @param {object} req  Request de Express.
 * @returns {string} IP validada o 'unknown'.
 */
export function getClientIp(req) {
  if (!req || typeof req !== 'object') return 'unknown';

  const headerValue = (name) => {
    const raw = req.headers ? req.headers[name] : undefined;
    if (Array.isArray(raw)) return String(raw[0] || '');
    return typeof raw === 'string' ? raw : '';
  };

  const forwarded = headerValue('x-forwarded-for').split(',')[0].trim();
  const candidates = [
    req.ip,
    headerValue('cf-connecting-ip'),
    headerValue('x-real-ip'),
    forwarded,
    req.socket ? req.socket.remoteAddress : '',
  ];

  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    if (isValidIp(value)) return value;
  }

  return 'unknown';
}

/**
 * Normaliza el user agent.
 * @param {object} req
 * @returns {string|null}
 */
export function getUserAgent(req) {
  try {
    const ua = req && req.headers ? req.headers['user-agent'] : null;
    if (!ua) return null;
    return String(ua).slice(0, CFG.maxTextLength);
  } catch {
    return null;
  }
}

/**
 * Serializa los metadatos de forma segura (JSON plano, sin ciclos, con tope).
 * @param {object} meta
 * @returns {string} JSON serializado.
 */
function serializeMeta(meta) {
  if (!meta || typeof meta !== 'object') return '{}';

  const safe = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    if (value === null || typeof value !== 'object') {
      safe[String(key).slice(0, 64)] = typeof value === 'string'
        ? value.slice(0, CFG.maxTextLength)
        : value;
      continue;
    }
    try {
      const json = JSON.stringify(value);
      safe[String(key).slice(0, 64)] = json ? json.slice(0, 1000) : null;
    } catch {
      safe[String(key).slice(0, 64)] = '[unserializable]';
    }
  }

  let out = JSON.stringify(safe);
  if (out.length > CFG.maxMetaBytes) {
    out = JSON.stringify({ truncated: true, keys: Object.keys(safe).slice(0, 40) });
  }
  return out;
}

/**
 * Crea la tabla de auditoría si no existe.
 * @returns {Promise<boolean>}
 */
async function ensureSchema() {
  if (!sql) return false;
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    try {
      await sql`
        create table if not exists ${sql(CFG.table)} (
          id          uuid primary key,
          user_id     uuid,
          order_id    text,
          status      text not null,
          ip          text,
          user_agent  text,
          meta        jsonb not null default '{}'::jsonb,
          created_at  timestamptz not null default now()
        )
      `;
      await sql`create index if not exists payment_audit_logs_user_idx
                on ${sql(CFG.table)} (user_id, created_at desc)`;
      await sql`create index if not exists payment_audit_logs_order_idx
                on ${sql(CFG.table)} (order_id)`;
      return true;
    } catch (err) {
      log.error('no pude crear la tabla de auditoría:', err && err.message);
      schemaReady = null;
      return false;
    }
  })();

  return schemaReady;
}

/* ═══════════════════════════════════════════════════════════════════════
   2 · API PÚBLICA
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Registra un evento de pago en la bitácora de auditoría.
 *
 * @param {string|null} userId   UUID del usuario (puede ser null en eventos de sistema).
 * @param {string|null} orderId  Identificador de la orden.
 * @param {string} status        Estado: 'created' | 'completed' | 'failed' | 'denied' |
 *                               'idor_attempt' | 'webhook_verified' | ...
 * @param {string} ip            IP real del cliente (getClientIp(req)).
 * @param {object} [meta]        Metadatos adicionales (JSON-safe).
 * @returns {Promise<boolean>} true si se insertó.
 */
export async function logPaymentEvent(userId, orderId, status, ip, meta) {
  try {
    if (!sql) {
      METRICS.skipped++;
      log.warn('auditoría omitida (sin base de datos):', status, { orderId: orderId || null });
      return false;
    }

    const ready = await ensureSchema();
    if (!ready) {
      METRICS.skipped++;
      return false;
    }

    const cleanUserId = (typeof userId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId))
      ? userId
      : null;
    const cleanOrderId = orderId ? String(orderId).slice(0, 100) : null;
    const cleanStatus = String(status || 'unknown').slice(0, 60);
    const cleanIp = isValidIp(ip) ? String(ip).trim() : 'unknown';
    const metaJson = serializeMeta(meta);

    await sql`
      insert into ${sql(CFG.table)} (
        id, user_id, order_id, status, ip, user_agent, meta
      ) values (
        ${crypto.randomUUID()},
        ${cleanUserId}::uuid,
        ${cleanOrderId},
        ${cleanStatus},
        ${cleanIp},
        ${meta && meta.userAgent ? String(meta.userAgent).slice(0, CFG.maxTextLength) : null},
        ${metaJson}::jsonb
      )
    `;

    METRICS.written++;
    log.debug('evento de pago auditado:', cleanStatus, {
      userId: cleanUserId,
      orderId: cleanOrderId,
      ip: cleanIp,
    });
    return true;
  } catch (err) {
    METRICS.failed++;
    log.error('no pude escribir el log de auditoría:', err && err.message, {
      status: String(status || '').slice(0, 60),
      orderId: orderId ? String(orderId).slice(0, 100) : null,
    });
    return false;
  }
}

/**
 * Variante que extrae la IP y el user agent directamente del request.
 *
 * @param {object} req
 * @param {object} params
 * @param {string|null} params.userId
 * @param {string|null} params.orderId
 * @param {string} params.status
 * @param {object} [params.meta]
 * @returns {Promise<boolean>}
 */
export async function logPaymentEventFromRequest(req, params = {}) {
  const ip = getClientIp(req);
  const userAgent = getUserAgent(req);
  const meta = { ...(params.meta || {}) };
  if (userAgent) meta.userAgent = userAgent;

  return logPaymentEvent(
    params.userId ?? null,
    params.orderId ?? null,
    params.status,
    ip,
    meta
  );
}

/**
 * Registra un intento de acceso a una orden ajena (IDOR).
 * Se loguea en warning para que salte en las alertas de seguridad.
 *
 * @param {object} req
 * @param {object} params
 * @param {string} params.userId      Usuario autenticado (el atacante).
 * @param {string} params.orderId     Orden que intentó capturar.
 * @param {string} [params.ownerId]   Dueño real de la orden (si se conoce).
 * @param {string} [params.reason]
 * @returns {Promise<boolean>}
 */
export async function logIdorAttempt(req, params = {}) {
  const ip = getClientIp(req);
  log.warn('intento de IDOR en pagos:', {
    userId: params.userId || null,
    orderId: params.orderId || null,
    ownerId: params.ownerId || null,
    ip,
    reason: params.reason || 'order_not_owned',
  });

  return logPaymentEvent(
    params.userId || null,
    params.orderId || null,
    'idor_attempt',
    ip,
    {
      ownerId: params.ownerId || null,
      reason: params.reason || 'order_not_owned',
      userAgent: getUserAgent(req),
      path: req && req.path ? String(req.path).slice(0, 200) : null,
    }
  );
}

/**
 * Lista los eventos de auditoría de un usuario.
 *
 * @param {string} userId
 * @param {number} [limit=50]
 * @returns {Promise<Array<object>>}
 */
export async function listAuditLogs(userId, limit = 50) {
  try {
    if (!sql) return [];
    const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = await sql`
      select id, user_id, order_id, status, ip, user_agent, meta, created_at
      from ${sql(CFG.table)}
      where user_id = ${userId}::uuid
      order by created_at desc
      limit ${safeLimit}
    `;
    return rows || [];
  } catch (err) {
    log.warn('no pude listar los logs de auditoría:', err && err.message);
    return [];
  }
}

/** Métricas del módulo (health check). */
export function getAuditMetrics() {
  return {
    ...METRICS,
    dbAvailable: supabaseDisponible(),
    table: CFG.table,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   3 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  rec('ipv4 válida', isValidIp('8.8.8.8'), true);
  rec('ipv4 inválida', !isValidIp('999.1.1.1'), true);
  rec('ipv6 válida', isValidIp('2001:db8::1'), true);
  rec('string no-IP', !isValidIp('not-an-ip'), true);
  rec('vacío', !isValidIp(''), true);

  const req = {
    ip: '1.2.3.4',
    headers: { 'user-agent': 'Mozilla/5.0', 'x-forwarded-for': '5.6.7.8, 9.10.11.12' },
    socket: { remoteAddress: '127.0.0.1' },
  };
  rec('getClientIp usa req.ip', getClientIp(req) === '1.2.3.4', getClientIp(req));

  const req2 = { ip: '', headers: { 'cf-connecting-ip': '5.6.7.8' }, socket: {} };
  rec('getClientIp fallback CF', getClientIp(req2) === '5.6.7.8', getClientIp(req2));

  const req3 = { ip: '', headers: {}, socket: { remoteAddress: '::1' } };
  rec('getClientIp fallback socket', getClientIp(req3) === '::1', getClientIp(req3));

  rec('getClientIp sin request', getClientIp(null) === 'unknown', true);
  rec('getUserAgent corta', (getUserAgent({ headers: { 'user-agent': 'x'.repeat(500) } }) || '').length <= CFG.maxTextLength, true);

  const passed = results.filter((r) => r.ok).length;
  return { passed, total: results.length, ok: passed === results.length, results };
}
