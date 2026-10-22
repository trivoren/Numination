/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/ban-manager.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Sistema de 3 strikes para moderación de usuarios.

   ESCALADA
     Strike 1 → ADVERTENCIA     (mensaje al usuario, sin bloqueo)
     Strike 2 → SUSPENSIÓN 24 h (acceso denegado hasta `suspended_until`)
     Strike 3 → BAN PERMANENTE  (banned = true en profiles + sesiones
                                  destruidas: se invalidan los JWT vivos
                                  bumping `auth_version`)

   ESTADO
     Tabla `user_violations`:
       user_id (pk uuid), strikes int, banned bool, suspended_until
       timestamptz, reason text, last_warning_at timestamptz, updated_at

   CONTRATO
     registerViolation(userId, reason, req) → { strikes, action, ... }
     getUserStatus(userId)                  → { strikes, banned, suspended, ... }
     isBlocked(userId)                      → { blocked, reason, until }
     resetStrikes(userId)                   → boolean
   ═══════════════════════════════════════════════════════════════════════ */

import { sql, supabaseDisponible } from '../src/services/supabase.js';
import { LOG } from '../src/lib/logger.js';
import { logAction } from './audit-logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  violationsTable: 'user_violations',
  maxStrikes: 3,
  suspensionHours: 24,
});

const ACTIONS = Object.freeze({
  WARNING: 'warning',
  SUSPENDED: 'suspended',
  BANNED: 'banned',
});

/* ═══════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function suspensionEnd(from = new Date()) {
  const end = new Date(from.getTime());
  end.setHours(end.getHours() + CFG.suspensionHours);
  return end;
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
        create table if not exists ${sql(CFG.violationsTable)} (
          user_id          uuid primary key,
          strikes          int  not null default 0,
          banned           boolean not null default false,
          suspended_until  timestamptz,
          reason           text,
          last_warning_at  timestamptz,
          updated_at       timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists user_violations_banned_idx
          on ${sql(CFG.violationsTable)} (banned)
      `;
      return true;
    } catch (e) {
      LOG.warn('ban-manager: no se pudo crear el esquema', { error: e.message, code: e.code });
      return false;
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════
   04 · ESTADO
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Estado de moderación de un usuario.
 * @param {string} userId
 * @returns {Promise<{strikes:number, banned:boolean, suspended:boolean,
 *                    suspendedUntil:Date|null, reason:string|null, known:boolean}>}
 */
export async function getUserStatus(userId) {
  const empty = {
    strikes: 0,
    banned: false,
    suspended: false,
    suspendedUntil: null,
    reason: null,
    known: false,
  };

  if (!supabaseDisponible() || !isUuid(userId)) return empty;

  try {
    await ensureSchema();
    const rows = await sql`
      select strikes, banned, suspended_until, reason
      from ${sql(CFG.violationsTable)}
      where user_id = ${userId}::uuid
      limit 1
    `;
    const row = rows?.[0];
    if (!row) return empty;

    const until = row.suspended_until ? new Date(row.suspended_until) : null;
    const suspended = Boolean(until && until.getTime() > Date.now());

    return {
      strikes: Number(row.strikes || 0),
      banned: Boolean(row.banned),
      suspended,
      suspendedUntil: suspended ? until : null,
      reason: row.reason ?? null,
      known: true,
    };
  } catch (e) {
    LOG.warn('ban-manager: no se pudo leer el estado', { userId, error: e.message });
    return empty;
  }
}

/**
 * ¿El usuario está bloqueado ahora mismo (ban o suspensión activa)?
 * @param {string} userId
 * @returns {Promise<{blocked:boolean, reason:string|null, until:Date|null, banned:boolean}>}
 */
export async function isBlocked(userId) {
  const status = await getUserStatus(userId);
  return {
    blocked: status.banned || status.suspended,
    banned: status.banned,
    reason: status.reason,
    until: status.suspendedUntil,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   05 · SESIONES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Destruye las sesiones vivas del usuario:
 *   1. borra las filas de sesiones (si la tabla existe),
 *   2. incrementa `auth_version` para invalidar los JWT emitidos.
 * Ninguna de las dos operaciones debe impedir la otra: cada una va en
 * su propio try/catch.
 *
 * @param {string} userId
 * @returns {Promise<{sessionsDeleted:boolean, tokensInvalidated:boolean}>}
 */
export async function destroySessions(userId) {
  const result = { sessionsDeleted: false, tokensInvalidated: false };

  if (!supabaseDisponible() || !isUuid(userId)) return result;

  try {
    const r = await sql`
      delete from public.sessions where user_id = ${userId}::uuid
    `;
    result.sessionsDeleted = (r?.count || 0) > 0;
  } catch (e) {
    LOG.warn('ban-manager: no se pudieron borrar las sesiones', {
      userId, error: e.message,
    });
  }

  try {
    const rows = await sql`
      update public.profiles
      set auth_version = coalesce(auth_version, 1) + 1,
          "updatedAt"  = now()
      where id = ${userId}::uuid
      returning id
    `;
    result.tokensInvalidated = (rows?.length || 0) > 0;
  } catch (e) {
    LOG.warn('ban-manager: no se pudieron invalidar los tokens', {
      userId, error: e.message,
    });
  }

  return result;
}

/* ═══════════════════════════════════════════════════════════════════════
   06 · STRIKES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Registra una infracción y aplica la sanción correspondiente.
 *
 * @param {string} userId
 * @param {string} reason   Motivo de la infracción.
 * @param {object} [req]    Request (para la auditoría).
 * @returns {Promise<{ok:boolean, strikes:number, action:string,
 *                    banned:boolean, suspendedUntil:Date|null, message:string}>}
 */
export async function registerViolation(userId, reason, req = null) {
  const cleanReason = String(reason ?? '').trim().slice(0, 500) || 'violación sin detalle';

  if (!supabaseDisponible() || !isUuid(userId)) {
    return {
      ok: false,
      strikes: 0,
      action: ACTIONS.WARNING,
      banned: false,
      suspendedUntil: null,
      message: 'Base de datos no disponible: la infracción no se pudo registrar.',
    };
  }

  try {
    await ensureSchema();

    const rows = await sql`
      insert into ${sql(CFG.violationsTable)} (user_id, strikes, reason, updated_at)
      values (${userId}::uuid, 1, ${cleanReason}, now())
      on conflict (user_id) do update
        set strikes = ${sql(CFG.violationsTable)}.strikes + 1,
            reason = ${cleanReason},
            updated_at = now()
      returning strikes
    `;

    const strikes = Number(rows?.[0]?.strikes ?? 1);
    const now = new Date();

    let action = ACTIONS.WARNING;
    let suspendedUntil = null;
    let message = 'Aviso: tu comportamiento ha sido registrado.';

    if (strikes >= CFG.maxStrikes) {
      action = ACTIONS.BANNED;
      message = 'Cuenta baneada permanentemente por reincidencia.';

      await sql`
        update ${sql(CFG.violationsTable)}
        set banned = true,
            suspended_until = null,
            reason = ${cleanReason},
            updated_at = now()
        where user_id = ${userId}::uuid
      `;

      try {
        await sql`
          update public.profiles
          set banned = true,
              "updatedAt" = now()
          where id = ${userId}::uuid
        `;
      } catch (e) {
        LOG.warn('ban-manager: no se pudo marcar banned en profiles', {
          userId, error: e.message,
        });
      }

      await destroySessions(userId);
    } else if (strikes === 2) {
      action = ACTIONS.SUSPENDED;
      suspendedUntil = suspensionEnd(now);
      message = `Cuenta suspendida ${CFG.suspensionHours} h por reincidencia.`;

      await sql`
        update ${sql(CFG.violationsTable)}
        set suspended_until = ${suspendedUntil},
            reason = ${cleanReason},
            updated_at = now()
        where user_id = ${userId}::uuid
      `;
    } else {
      await sql`
        update ${sql(CFG.violationsTable)}
        set last_warning_at = now(),
            updated_at = now()
        where user_id = ${userId}::uuid
      `;
    }

    await logAction(userId, `moderation.${action}`, req, {
      strikes,
      reason: cleanReason,
      suspendedUntil: suspendedUntil ? suspendedUntil.toISOString() : null,
    });

    return {
      ok: true,
      strikes,
      action,
      banned: action === ACTIONS.BANNED,
      suspendedUntil,
      message,
    };
  } catch (e) {
    LOG.error('ban-manager: fallo al registrar la infracción', {
      userId, error: e.message, code: e.code,
    });
    return {
      ok: false,
      strikes: 0,
      action: ACTIONS.WARNING,
      banned: false,
      suspendedUntil: null,
      message: 'No se pudo registrar la infracción.',
    };
  }
}

/**
 * Restablece los strikes de un usuario (uso de administración).
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
export async function resetStrikes(userId) {
  if (!supabaseDisponible() || !isUuid(userId)) return false;

  try {
    await ensureSchema();
    const rows = await sql`
      update ${sql(CFG.violationsTable)}
      set strikes = 0,
          banned = false,
          suspended_until = null,
          reason = null,
          updated_at = now()
      where user_id = ${userId}::uuid
      returning user_id
    `;

    try {
      await sql`
        update public.profiles
        set banned = false,
            "updatedAt" = now()
        where id = ${userId}::uuid
      `;
    } catch (e) {
      LOG.warn('ban-manager: no se pudo desbanear en profiles', { userId, error: e.message });
    }

    return (rows?.length || 0) > 0;
  } catch (e) {
    LOG.warn('ban-manager: no se pudieron resetear los strikes', {
      userId, error: e.message,
    });
    return false;
  }
}

export default {
  registerViolation,
  getUserStatus,
  isBlocked,
  resetStrikes,
  destroySessions,
};
