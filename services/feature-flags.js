/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/feature-flags.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Banderas de funcionalidad servidas desde la base de datos.

   POR QUÉ EN LA BD
     Un `if (process.env.NEW_AI === 'true')` obliga a redeployar para
     apagar una feature. Con banderas en base, el admin la apaga en
     caliente y el efecto se ve en el siguiente request.

   MODELO
     Cada bandera tiene:
       · key          identificador estable ('rag', 'sandbox', 'voice'…)
       · enabled      interruptor principal
       · value        jsonb con configuración (límites, presets…)
       · plans        planes a los que aplica (null = todos)
       · rollout      0..100 → % de usuarios que la ven activa, con hash
                      estable del userId (el mismo usuario cae siempre en
                      el mismo lado)

   ESQUEMA `feature_flags`
     key text primary key, enabled boolean, value jsonb, plans text[],
     rollout int, updated_by uuid, updated_at timestamptz

   DEGRADACIÓN
     Si la base no está disponible se usan los valores por defecto del
     REGISTRY: la app nunca se cae por una bandera.
   ═══════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql, supabaseDisponible } from '../src/services/supabase.js';
import { LOG } from '../src/lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  table: 'feature_flags',
  cacheTtlMs: 30_000,
  planCacheTtlMs: 5 * 60 * 1000,
});

/** Valores por defecto: se usan si la bandera no existe en la BD. */
const REGISTRY = Object.freeze({
  rag: true,
  images: true,
  voice: true,
  personas: true,
  memoryVault: true,
  sandbox: false,
  webSearch: true,
  promptLibrary: true,
  chatExport: true,
  billingInvoices: true,
  voiceClone: false,
  betaPanel: false,
});

/** Banderas sin fila en la BD → activo por defecto, sin restricciones. */
const DEFAULTS = Object.freeze({
  enabled: true,
  value: {},
  plans: null,
  rollout: 100,
});

/* ═══════════════════════════════════════════════════════════════════════
   02 · CACHÉ
   ═══════════════════════════════════════════════════════════════════════ */

let flagsCache = null;   // { flags, at }
const planCache = new Map(); // userId → { plan, at }

function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Hash estable del usuario → 0..99. Determinista: el mismo usuario
 * siempre cae en el mismo lado del rollout.
 * @param {string} userId
 * @returns {number}
 */
export function rolloutBucket(userId) {
  const value = String(userId ?? '');
  if (!value) return 0;

  try {
    const digest = crypto.createHash('sha256').update(value).digest();
    const n = digest.readUInt32BE(0);
    return n % 100;
  } catch {
    return 0;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   03 · ESQUEMA
   ═══════════════════════════════════════════════════════════════════════ */

let schemaPromise = null;

async function ensureSchema() {
  if (!supabaseDisponible()) return false;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    try {
      await sql`
        create table if not exists ${sql(CFG.table)} (
          key        text primary key,
          enabled    boolean not null default true,
          value      jsonb default '{}'::jsonb,
          plans      text[],
          rollout    int not null default 100,
          updated_by uuid,
          updated_at timestamptz not null default now()
        )
      `;
      return true;
    } catch (e) {
      LOG.warn('feature-flags: no se pudo crear el esquema', { error: e.message, code: e.code });
      return false;
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════
   04 · CARGA
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Carga todas las banderas desde la base de datos (con caché corta).
 * @param {object} [options]
 * @param {boolean}[options.force]  Ignorar la caché.
 * @returns {Promise<Object<string, {enabled:boolean, value:object, plans:string[]|null, rollout:number}>>}
 */
export async function getFlags(options = {}) {
  const now = Date.now();

  if (!options.force && flagsCache && now - flagsCache.at < CFG.cacheTtlMs) {
    return flagsCache.flags;
  }

  if (!supabaseDisponible()) {
    return {};
  }

  try {
    await ensureSchema();
    const rows = await sql`
      select key, enabled, value, plans, rollout
      from ${sql(CFG.table)}
    `;

    const flags = {};
    for (const row of rows || []) {
      flags[row.key] = {
        enabled: row.enabled !== false,
        value: (row.value && typeof row.value === 'object') ? row.value : {},
        plans: Array.isArray(row.plans) && row.plans.length ? row.plans : null,
        rollout: Number.isFinite(Number(row.rollout)) ? Number(row.rollout) : 100,
      };
    }

    flagsCache = { flags, at: now };
    return flags;
  } catch (e) {
    LOG.warn('feature-flags: no se pudieron cargar las banderas', { error: e.message });
    return flagsCache?.flags ?? {};
  }
}

/** Fuerza la recarga de las banderas en el próximo uso. */
export function reloadFlags() {
  flagsCache = null;
  planCache.clear();
}

/** Limpia las cachés de banderas y planes. */
export function clearFlagCache() {
  flagsCache = null;
  planCache.clear();
}

/* ═══════════════════════════════════════════════════════════════════════
   05 · PLAN DEL USUARIO
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Plan (tier) del usuario, con caché.
 * @param {string} userId
 * @returns {Promise<string>} 'FREE' | 'PRO' | …
 */
export async function getUserPlan(userId) {
  if (!isUuid(userId)) return 'FREE';

  const hit = planCache.get(userId);
  if (hit && Date.now() - hit.at < CFG.planCacheTtlMs) return hit.plan;

  if (!supabaseDisponible()) return 'FREE';

  try {
    const rows = await sql`
      select tier from public.profiles where id = ${userId}::uuid limit 1
    `;
    const plan = String(rows?.[0]?.tier || 'FREE').toUpperCase();
    planCache.set(userId, { plan, at: Date.now() });
    return plan;
  } catch (e) {
    LOG.warn('feature-flags: no se pudo leer el plan', { userId, error: e.message });
    return 'FREE';
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   06 · API
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * ¿Está activada la bandera para este usuario?
 *
 * @param {string} flag      Clave de la bandera.
 * @param {string} [userId]  Usuario (para rollout y plan).
 * @param {object} [options]
 * @param {string} [options.plan]  Plan del usuario (si ya se conoce).
 * @returns {Promise<boolean>}
 */
export async function isEnabled(flag, userId = null, options = {}) {
  const key = String(flag ?? '').trim();
  if (!key) return false;

  try {
    const flags = await getFlags(options);
    const row = flags[key];

    // Sin fila en la BD: se usa el registro de valores por defecto.
    const enabled = row
      ? row.enabled !== false
      : (REGISTRY[key] ?? DEFAULTS.enabled);

    if (!enabled) return false;

    const plans = row?.plans ?? null;
    const rollout = row?.rollout ?? DEFAULTS.rollout;

    if (rollout < 100) {
      const bucket = rolloutBucket(userId || key);
      if (bucket >= rollout) return false;
    }

    if (plans && plans.length) {
      const plan = String(
        options.plan || (userId ? await getUserPlan(userId) : 'FREE')
      ).toUpperCase();
      const allowed = plans.map((p) => String(p).toUpperCase());
      if (!allowed.includes(plan)) return false;
    }

    return true;
  } catch (e) {
    LOG.warn('feature-flags: error evaluando la bandera', { flag, error: e.message });
    return Boolean(REGISTRY[key] ?? DEFAULTS.enabled);
  }
}

/**
 * Devuelve la configuración completa de una bandera.
 * @param {string} flag
 * @returns {Promise<object|null>}
 */
export async function getFlagValue(flag) {
  const key = String(flag ?? '').trim();
  if (!key) return null;

  const flags = await getFlags();
  return flags[key]?.value ?? null;
}

/**
 * Actualiza una bandera (administración).
 *
 * @param {string} key
 * @param {object} patch  { enabled, value, plans, rollout }
 * @param {string} [updatedBy]
 * @returns {Promise<boolean>}
 */
export async function setFlag(key, patch = {}, updatedBy = null) {
  const name = String(key ?? '').trim();
  if (!name || !supabaseDisponible()) return false;

  try {
    await ensureSchema();

    const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : true;
    const value = patch.value && typeof patch.value === 'object' ? patch.value : {};
    const plans = Array.isArray(patch.plans)
      ? patch.plans.map((p) => String(p).toUpperCase())
      : null;
    const rollout = Math.min(100, Math.max(0, Number(patch.rollout ?? 100) || 0));

    await sql`
      insert into ${sql(CFG.table)} (key, enabled, value, plans, rollout, updated_by, updated_at)
      values (
        ${name},
        ${enabled},
        ${value}::jsonb,
        ${plans}::text[],
        ${rollout},
        ${isUuid(updatedBy) ? updatedBy : null}::uuid,
        now()
      )
      on conflict (key) do update
        set enabled = ${enabled},
            value = ${value}::jsonb,
            plans = ${plans}::text[],
            rollout = ${rollout},
            updated_by = ${isUuid(updatedBy) ? updatedBy : null}::uuid,
            updated_at = now()
    `;

    reloadFlags();
    return true;
  } catch (e) {
    LOG.warn('feature-flags: no se pudo actualizar la bandera', {
      key: name, error: e.message,
    });
    return false;
  }
}

export default {
  isEnabled,
  getFlags,
  getFlagValue,
  setFlag,
  reloadFlags,
  clearFlagCache,
  getUserPlan,
  rolloutBucket,
};
