/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · payments/idempotency.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Cerrojo de idempotencia para el checkout de pagos.

   PROBLEMA:
     Un doble clic (o un doble submit del formulario, o un reintento del
     cliente) puede generar DOS capturas de la misma orden → COBRO DOBLE.
     Un click y medio con la red lenta es el caso clásico.

   SOLUCIÓN (doble capa):
     1) Mapa en memoria (rápido, sin I/O): reserva síncrona dentro del
        proceso. El hilo de JS es single-threaded, así que el par
        check+set es atómico siempre que NO haya un `await` en medio.
     2) Postgres (verdad entre instancias): `INSERT ... ON CONFLICT DO
        NOTHING` sobre una clave primaria. Si otra instancia del server
        ya tiene el cerrojo, la inserción no afecta filas y la segunda
        petición recibe 409 Conflict.

   CONTRATO:
     · `checkAndLock(key, ttl)` → `{ key, acquired: true, release() }`
       o LANZA `ConflictError` (HTTP 409) si el cerrojo ya está tomado.
     · `release(key)` libera el cerrojo (excepción o fin de la operación).
     · Si la DB no está disponible, se degrada a memoria-only y se loguea
       el warning: el doble clic local sigue bloqueado, pero el cerrojo
       deja de ser global.
   ═══════════════════════════════════════════════════════════════════════ */

import { sql, supabaseDisponible } from '../services/supabase.js';
import { ConflictError, ValidationError } from '../middleware/errors.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('payments-idempotency');

const CFG = {
  defaultTtlMs: 60_000,          // TTL por defecto del cerrojo
  maxTtlMs: 15 * 60_000,        // Techo duro (evita cerrojos huérfanos)
  maxKeys: 5000,                // Tope de claves en memoria
  sweepIntervalMs: 60_000,      // Frecuencia de limpieza de expirados
  table: 'payment_idempotency',
};

/* ═══════════════════════════════════════════════════════════════════════
   1 · ESTADO EN MEMORIA
   ═══════════════════════════════════════════════════════════════════════ */

/** Map<key, { expiresAt, createdAt, hits }> */
const memoryLocks = new Map();

const METRICS = {
  acquired: 0,
  conflicts: 0,
  released: 0,
  expired: 0,
  dbFailures: 0,
};

let dbUnavailableWarned = false;
let schemaReady = null;   // Promise | null → cache del DDL

/* ═══════════════════════════════════════════════════════════════════════
   2 · HELPERS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Valida y normaliza la clave del cerrojo.
 * @param {string} key
 * @returns {string}
 * @throws {ValidationError} si la clave es inválida.
 */
function normalizeKey(key) {
  const clean = typeof key === 'string' ? key.trim() : '';
  if (!clean) {
    throw new ValidationError('Falta la clave de idempotencia.', 'key', 'VALID_MISSING_FIELD', { key: null });
  }
  if (clean.length > 200) {
    throw new ValidationError('Clave de idempotencia demasiado larga.', 'key', 'VALID_INVALID_FIELD', { key: null });
  }
  return clean;
}

/**
 * Normaliza el TTL.
 * @param {number} ttl
 * @returns {number} Milisegundos.
 */
function normalizeTtl(ttl) {
  const value = Number(ttl);
  if (!Number.isFinite(value) || value <= 0) return CFG.defaultTtlMs;
  return Math.min(CFG.maxTtlMs, Math.trunc(value));
}

/** ¿La entrada en memoria sigue vigente? */
function isAlive(entry) {
  return Boolean(entry) && entry.expiresAt > Date.now();
}

/** Elimina del mapa las claves expiradas. */
function sweepMemory() {
  const now = Date.now();
  let removed = 0;
  for (const [key, entry] of memoryLocks) {
    if (!entry || entry.expiresAt <= now) {
      memoryLocks.delete(key);
      removed++;
      METRICS.expired++;
    }
  }
  return removed;
}

/**
 * Crea la tabla de idempotencia si no existe (una sola vez por proceso).
 * @returns {Promise<boolean>}
 */
async function ensureSchema() {
  if (!sql) return false;
  if (schemaReady) return schemaReady;

  schemaReady = (async () => {
    try {
      await sql`
        create table if not exists ${sql(CFG.table)} (
          key         text primary key,
          created_at  timestamptz not null default now(),
          expires_at  timestamptz not null
        )
      `;
      await sql`create index if not exists payment_idempotency_expires_idx
                on ${sql(CFG.table)} (expires_at)`;
      return true;
    } catch (err) {
      log.warn('no pude crear la tabla de idempotencia:', err && err.message);
      schemaReady = null;
      return false;
    }
  })();

  return schemaReady;
}

/**
 * Intenta tomar el cerrojo en la base (verdad entre instancias).
 * @param {string} key
 * @param {number} ttlMs
 * @returns {Promise<boolean>} true si se adquirió, false si ya estaba tomado.
 */
async function acquireInDb(key, ttlMs) {
  if (!sql) return true;   // modo degradado (memoria)

  const ready = await ensureSchema();
  if (!ready) return true;

  const expiresAt = new Date(Date.now() + ttlMs);

  try {
    const result = await sql`
      insert into ${sql(CFG.table)} (key, expires_at)
      values (${key}, ${expiresAt})
      on conflict (key) do nothing
    `;
    return result.count > 0;
  } catch (err) {
    METRICS.dbFailures++;
    log.error('fallo al tomar el cerrojo de idempotencia:', err && err.message, { key });
    // Fail-closed en la DB, fail-open en memoria: si la DB falla no se puede
    // garantizar el cerrojo global, pero el doble clic local sí se bloquea.
    if (!dbUnavailableWarned) {
      dbUnavailableWarned = true;
      log.warn('idempotencia degradada a memoria (DB no disponible).');
    }
    return true;
  }
}

/**
 * Libera el cerrojo en la base.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function releaseInDb(key) {
  if (!sql) return false;
  try {
    const result = await sql`
      delete from ${sql(CFG.table)} where key = ${key}
    `;
    return result.count > 0;
  } catch (err) {
    log.warn('fallo al liberar el cerrojo de idempotencia:', err && err.message, { key });
    return false;
  }
}

/** Limpia las claves expiradas de la base (best-effort). */
async function purgeExpiredInDb() {
  if (!sql) return 0;
  try {
    const result = await sql`
      delete from ${sql(CFG.table)} where expires_at <= now()
    `;
    return result.count;
  } catch (err) {
    log.debug('purge de idempotencia falló:', err && err.message);
    return 0;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   3 · API PÚBLICA
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Toma el cerrojo de idempotencia para una clave.
 *
 * @param {string} key    Clave única de la operación (ej. `capture:<userId>:<orderId>`).
 * @param {number} [ttl]  Tiempo de vida del cerrojo en ms (por defecto 60s).
 * @returns {Promise<{key:string, acquired:true, release:() => Promise<boolean>}>}
 * @throws {ConflictError} HTTP 409 si la operación ya está en curso.
 */
export async function checkAndLock(key, ttl) {
  const cleanKey = normalizeKey(key);
  const ttlMs = normalizeTtl(ttl);

  sweepMemory();

  // 1) Reserva síncrona en memoria (sin await entre check y set → atómico).
  const existing = memoryLocks.get(cleanKey);
  if (isAlive(existing)) {
    METRICS.conflicts++;
    log.warn('conflicto de idempotencia (memoria):', cleanKey, { expiresIn: existing.expiresAt - Date.now() });
    throw new ConflictError(
      'Ya hay una operación de pago en curso para esta orden.',
      'PAYMENT_IDEMPOTENCY_CONFLICT',
      { key: cleanKey, scope: 'memory' }
    );
  }

  // Tope de tamaño: se purga antes de insertar (evita growth ilimitado).
  if (memoryLocks.size >= CFG.maxKeys) {
    sweepMemory();
    if (memoryLocks.size >= CFG.maxKeys) {
      const oldest = memoryLocks.keys().next().value;
      if (oldest) memoryLocks.delete(oldest);
    }
  }

  memoryLocks.set(cleanKey, { expiresAt: Date.now() + ttlMs, createdAt: Date.now(), hits: 1 });

  // 2) Cerrojo global en la base.
  let acquired = false;
  try {
    acquired = await acquireInDb(cleanKey, ttlMs);
  } catch (err) {
    log.error('error inesperado al tomar el cerrojo:', err && err.message, { key: cleanKey });
    acquired = true;   // memoria ya reservada: se continúa en modo degradado
  }

  if (!acquired) {
    // Otra instancia tiene el cerrojo: se devuelve la reserva de memoria.
    memoryLocks.delete(cleanKey);
    METRICS.conflicts++;
    log.warn('conflicto de idempotencia (db):', cleanKey);
    throw new ConflictError(
      'Ya hay una operación de pago en curso para esta orden.',
      'PAYMENT_IDEMPOTENCY_CONFLICT',
      { key: cleanKey, scope: 'database' }
    );
  }

  METRICS.acquired++;

  let released = false;
  const release = async () => {
    if (released) return false;
    released = true;
    memoryLocks.delete(cleanKey);
    METRICS.released++;
    const ok = await releaseInDb(cleanKey);
    return ok;
  };

  return { key: cleanKey, acquired: true, release };
}

/**
 * Libera un cerrojo por clave (uso manual; `release()` del resultado hace lo mismo).
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function release(key) {
  const cleanKey = normalizeKey(key);
  const existed = memoryLocks.delete(cleanKey);
  const dbReleased = await releaseInDb(cleanKey);
  if (existed) METRICS.released++;
  return existed || dbReleased;
}

/**
 * ¿Está tomado el cerrojo? (memoria + base).
 * @param {string} key
 * @returns {Promise<boolean>}
 */
export async function isLocked(key) {
  const cleanKey = normalizeKey(key);
  const entry = memoryLocks.get(cleanKey);
  if (isAlive(entry)) return true;

  if (!sql) return false;

  try {
    const rows = await sql`
      select 1 from ${sql(CFG.table)}
      where key = ${cleanKey} and expires_at > now()
      limit 1
    `;
    const locked = Array.isArray(rows) && rows.length > 0;
    if (!locked) memoryLocks.delete(cleanKey);
    return locked;
  } catch (err) {
    log.debug('no pude consultar el cerrojo en la base:', err && err.message);
    return false;
  }
}

/**
 * Ejecuta `fn` bajo el cerrojo de idempotencia y lo libera siempre.
 *
 * @param {string} key
 * @param {number} ttl
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
export async function withIdempotency(key, ttl, fn) {
  const lock = await checkAndLock(key, ttl);
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/** Métricas del módulo (para health checks). */
export function getIdempotencyMetrics() {
  sweepMemory();
  return {
    ...METRICS,
    memoryKeys: memoryLocks.size,
    dbAvailable: supabaseDisponible(),
    degraded: !supabaseDisponible(),
  };
}

/** Reinicia el estado en memoria (solo tests). */
export function resetIdempotency() {
  memoryLocks.clear();
  METRICS.acquired = 0;
  METRICS.conflicts = 0;
  METRICS.released = 0;
  METRICS.expired = 0;
  METRICS.dbFailures = 0;
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · LIMPIEZA PERIÓDICA
   ═══════════════════════════════════════════════════════════════════════ */

const sweepTimer = setInterval(() => {
  try {
    sweepMemory();
    purgeExpiredInDb().catch(() => {});
  } catch (err) {
    log.debug('sweep de idempotencia falló:', err && err.message);
  }
}, CFG.sweepIntervalMs);

if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

/* ═══════════════════════════════════════════════════════════════════════
   5 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export async function selfTest() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  const key = `selftest:${Date.now()}`;

  const lock = await checkAndLock(key, 5000);
  rec('primera toma acquire', lock.acquired === true, lock);

  let conflict = false;
  try {
    await checkAndLock(key, 5000);
  } catch (err) {
    conflict = err && err.status === 409;
  }
  rec('segunda toma da 409', conflict, true);

  await lock.release();
  rec('release devuelve boolean', typeof (await lock.release()) === 'boolean', true);

  const lock2 = await checkAndLock(key, 5000);
  rec('se puede volver a tomar tras release', lock2.acquired === true, lock2);
  await lock2.release();

  let threw = false;
  try {
    await checkAndLock('', 1000);
  } catch (err) {
    threw = Boolean(err);
  }
  rec('clave vacía lanza', threw, true);

  const passed = results.filter((r) => r.ok).length;
  return { passed, total: results.length, ok: passed === results.length, results };
}
