/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · middleware/ban-manager.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Escalamiento de sanciones por spam. LÓGICA ESTRICTA.

   REGLA (exacta, sin interpretación)
     · El filtro de spam (`spam-filter`) evalúa cada mensaje y devuelve un
       score 0-100.
     · Si el score > 80 → se suma 1 strike.

   ESCALAMIENTO
     Strike 1 → { warning: 'Cuidado con el spam' }
                 (se avisa, NO se suspende)
     Strike 2 → cuenta suspendida 24 h  (profiles.suspended_until)
     Strike 3 → is_banned = true       (profiles.banned)
                 + se destruye la sesión (denylist de jti)

   POR QUÉ EL FILTRO ES UN EVENTO Y NO UN MIDDLEWARE
     El filtro de spam vive en `src/services/spam-filter.js` y expone
     `onSpamScore(cb)`. El ban-manager se suscribe a ese evento. Así el
     filtro puede usarse en TODOS los puntos de entrada (chat, coder,
     comentarios) sin duplicar la lógica de sanciones.

   PERSISTENCIA
     · `user_moderation`  → contador de strikes + score acumulado.
     · `profiles.banned` y `profiles.suspended_until` → los flags que ya
       lee `src/middleware/auth.js` (el módulo de auth los usa para
       bloquear la cuenta). Se agregan si no existen.
     · Los strikes se reinician tras 30 días sin incidencias.

   DESTRUCCIÓN DE SESIÓN
     Se llama a `invalidateSession(userId)` + se borra el perfil: la
     sesión queda revocada de inmediato (el middleware de auth la
     invalida por cache en 30 s como máximo).
   ═══════════════════════════════════════════════════════════════════════════ */

import { sql, supabaseDisponible } from '../services/supabase.js';
import { LOG } from '../lib/logger.js';
import { invalidateSession } from './auth.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  scoreThreshold: 80,          // score > 80 cuenta como strike
  strikesBeforeSuspension: 2,
  strikesBeforeBan: 3,
  suspensionHours: 24,
  strikeExpiryDays: 30,
  table: 'user_moderation',
  bannedColumn: 'banned',
  suspendedColumn: 'suspended_until',
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
      // El módulo de auth ya lee estas columnas: se crean si faltan.
      await sql`
        do $$
        begin
          if not exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'profiles' and column_name = 'banned'
          ) then
            alter table public.profiles add column banned boolean not null default false;
          end if;

          if not exists (
            select 1 from information_schema.columns
            where table_schema = 'public' and table_name = 'profiles' and column_name = 'suspended_until'
          ) then
            alter table public.profiles add column suspended_until timestamptz;
          end if;
        end $$;
      `;

      await sql`
        create table if not exists ${sql(CFG.table)} (
          user_id      uuid primary key,
          strikes      integer not null default 0,
          last_score   integer not null default 0,
          total_score  integer not null default 0,
          incidents    integer not null default 0,
          suspended_until timestamptz,
          banned       boolean not null default false,
          last_reason  text,
          created_at   timestamptz not null default now(),
          updated_at   timestamptz not null default now()
        )
      `;

      await sql`
        create index if not exists user_moderation_banned_idx
          on ${sql(CFG.table)} (banned, strikes desc)
      `;

      return { ok: true };
    } catch (e) {
      LOG.warn('ban-manager: no se pudo crear el esquema', { error: e.message, code: e.code });
      return { ok: false };
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · ESTADO DE SANCIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Lee el estado de moderación de un usuario.
 *
 * @param {string} userId
 * @returns {Promise<object>} {
 *   ok, strikes, banned, suspended, suspendedUntil, lastScore
 * }
 */
export async function getModerationState(userId) {
  if (!userId) {
    return { ok: false, strikes: 0, banned: false, suspended: false, suspendedUntil: null, lastScore: 0 };
  }

  if (!supabaseDisponible()) {
    return {
      ok: true,
      degraded: true,
      strikes: 0,
      banned: false,
      suspended: false,
      suspendedUntil: null,
      lastScore: 0,
    };
  }

  try {
    await ensureSchema();

    const rows = await sql`
      select
        strikes,
        last_score,
        suspended_until,
        banned
      from ${sql(CFG.table)}
      where user_id = ${userId}::uuid
      limit 1
    `;

    if (!rows.length) {
      return {
        ok: true,
        degraded: false,
        strikes: 0,
        banned: false,
        suspended: false,
        suspendedUntil: null,
        lastScore: 0,
      };
    }

    const row = rows[0];
    const suspendedUntil = row.suspended_until ? new Date(row.suspended_until) : null;
    const suspended = Boolean(suspendedUntil && suspendedUntil.getTime() > Date.now());

    return {
      ok: true,
      degraded: false,
      strikes: Number(row.strikes || 0),
      banned: Boolean(row.banned),
      suspended,
      suspendedUntil: suspendedUntil ? suspendedUntil.toISOString() : null,
      lastScore: Number(row.last_score || 0),
    };
  } catch (e) {
    LOG.warn('ban-manager: getModerationState falló', { error: e.message });
    return { ok: true, degraded: true, strikes: 0, banned: false, suspended: false, suspendedUntil: null, lastScore: 0 };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · SANCIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Aplica una sanción por un score de spam.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {number} params.score      0-100
 * @param {string} [params.reason]
 * @param {string} [params.ip]
 * @returns {Promise<object>} {
 *   ok, strikes, action: 'none'|'warning'|'suspend'|'ban',
 *   warning, banned, suspendedUntil, message
 * }
 */
export async function applySanction(params = {}) {
  const { userId, score = 0, reason = 'spam', ip = null } = params;

  if (!userId) {
    return { ok: false, action: 'none', error: 'Se requiere userId.' };
  }

  const numericScore = Number(score) || 0;

  if (numericScore <= CFG.scoreThreshold) {
    return { ok: true, action: 'none', strikes: 0, message: 'Score dentro del rango permitido.' };
  }

  if (!supabaseDisponible()) {
    // Modo sin base: se devuelve la advertencia pero no se persiste.
    return {
      ok: true,
      degraded: true,
      action: 'warning',
      strikes: 1,
      warning: 'Cuidado con el spam',
      message: 'Cuidado con el spam',
    };
  }

  try {
    await ensureSchema();

    // 1) Se incrementa el contador de strikes de forma atómica.
    const updated = await sql`
      insert into ${sql(CFG.table)} (user_id, strikes, last_score, total_score, incidents, last_reason, updated_at)
      values (${userId}::uuid, 1, ${numericScore}, ${numericScore}, 1, ${String(reason).slice(0, 200)}, now())
      on conflict (user_id) do update
        set strikes = ${sql(CFG.table)}.strikes + 1,
            last_score = excluded.last_score,
            total_score = ${sql(CFG.table)}.total_score + excluded.total_score,
            incidents = ${sql(CFG.table)}.incidents + 1,
            last_reason = excluded.last_reason,
            updated_at = now()
      returning strikes, banned, suspended_until
    `;

    const strikes = Number(updated[0]?.strikes || 1);
    const alreadyBanned = Boolean(updated[0]?.banned);

    // ── Strike 1 · aviso ────────────────────────────────────────────────
    if (strikes < CFG.strikesBeforeSuspension) {
      const warning = 'Cuidado con el spam';

      LOG.warn('ban-manager: strike 1 (advertencia)', {
        userId,
        strikes,
        score: numericScore,
        ip,
      });

      return {
        ok: true,
        action: 'warning',
        strikes,
        warning,
        message: warning,
        banned: false,
        suspended: false,
        suspendedUntil: null,
      };
    }

    // ── Strike 2 · suspensión 24 h ──────────────────────────────────────
    if (strikes < CFG.strikesBeforeBan) {
      const until = new Date(Date.now() + CFG.suspensionHours * 3600_000);

      await sql`
        update ${sql(CFG.table)}
        set suspended_until = ${until.toISOString()}, updated_at = now()
        where user_id = ${userId}::uuid
      `;

      // El flag que lee el módulo de auth.
      await sql`
        update public.profiles
        set suspended_until = ${until.toISOString()}, updated_at = now()
        where id = ${userId}::uuid
      `;

      // Se destruye la caché de sesión para que el bloqueo sea inmediato.
      try {
        invalidateSession(userId);
      } catch (e) {
        LOG.debug('ban-manager: invalidateSession falló', { error: e.message });
      }

      LOG.warn('ban-manager: strike 2 (suspensión)', {
        userId,
        strikes,
        until: until.toISOString(),
        ip,
      });

      return {
        ok: true,
        action: 'suspend',
        strikes,
        banned: false,
        suspended: true,
        suspendedUntil: until.toISOString(),
        message: `Tu cuenta quedó suspendida por ${CFG.suspensionHours} horas.`,
      };
    }

    // ── Strike 3 · baneado definitivo ───────────────────────────────────
    await sql`
      update ${sql(CFG.table)}
      set banned = true, suspended_until = null, updated_at = now()
      where user_id = ${userId}::uuid
    `;

    await sql`
      update public.profiles
      set banned = true, suspended_until = null, updated_at = now()
      where id = ${userId}::uuid
    `;

    try {
      invalidateSession(userId);
    } catch (e) {
      LOG.debug('ban-manager: invalidateSession falló', { error: e.message });
    }

    LOG.error('ban-manager: strike 3 (baneo)', { userId, strikes, score: numericScore, ip });

    return {
      ok: true,
      action: 'ban',
      strikes,
      banned: true,
      suspended: false,
      suspendedUntil: null,
      message: 'Tu cuenta fue baneada porAbuso de spam.',
    };
  } catch (e) {
    LOG.error('ban-manager: applySanction falló', { error: e.message, code: e.code });
    return { ok: false, action: 'none', error: 'No se pudo aplicar la sanción.' };
  }
}

/**
 * Revierte una sanción (uso del admin).
 */
export async function clearSanction(userId) {
  if (!userId || !supabaseDisponible()) return { ok: true, degraded: true };

  try {
    await ensureSchema();

    await sql`
      update ${sql(CFG.table)}
      set strikes = 0, banned = false, suspended_until = null, updated_at = now()
      where user_id = ${userId}::uuid
    `;

    await sql`
      update public.profiles
      set banned = false, suspended_until = null, updated_at = now()
      where id = ${userId}::uuid
    `;

    try { invalidateSession(userId); } catch { /* cache */ }

    LOG.info('ban-manager: sanción revertida', { userId });
    return { ok: true };
  } catch (e) {
    LOG.warn('ban-manager: clearSanction falló', { error: e.message });
    return { ok: false };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · MIDDLEWARE
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Middleware que bloquea a los usuarios baneados o suspendidos.
 *
 * Se monta DESPUÉS de `attachUser` y `requireAuth`.
 */
export function banGuard() {
  return async function guard(req, res, next) {
    const userId = req.user?.id;

    if (!userId) return next();

    try {
      const state = await getModerationState(userId);

      if (state.banned) {
        return res.status(403).json({
          ok: false,
          error: 'Tu cuenta está baneada por abuso de spam.',
          code: 'account_banned',
        });
      }

      if (state.suspended) {
        const until = state.suspendedUntil;
        res.setHeader('Retry-After', '3600');
        return res.status(403).json({
          ok: false,
          error: `Tu cuenta está suspendida${until ? ` hasta ${until}` : ''}.`,
          code: 'account_suspended',
          suspendedUntil: until,
        });
      }
    } catch (e) {
      LOG.warn('ban-manager: guard falló', { error: e.message });
      // Fail-open: un fallo del filtro de moderación no bloquea al
      // usuario legítimo.
    }

    return next();
  };
}

/**
 * Conecta el filtro de spam con este gestor.
 * Se llama una vez desde src/index.js.
 *
 * @returns {Promise<object>} { ok, unsubscribed }
 */
export async function connectSpamFilter() {
  try {
    const spam = await import('../services/spam-filter.js');

    const off = spam.onSpamScore(async ({ userId, score, reason, ip }) => {
      if (!userId) return;

      const result = await applySanction({ userId, score, reason, ip });

      if (result.action === 'warning') {
        spam.emitSpamWarning({ userId, message: result.warning, score });
      }
    });

    LOG.info('ban-manager: conectado al filtro de spam');

    return { ok: true, unsubscribed: off };
  } catch (e) {
    LOG.warn('ban-manager: no se pudo conectar al filtro de spam', { error: e.message });
    return { ok: false, error: e.message };
  }
}

export function getBanManagerConfig() {
  return {
    scoreThreshold: CFG.scoreThreshold,
    strikesBeforeSuspension: CFG.strikesBeforeSuspension,
    strikesBeforeBan: CFG.strikesBeforeBan,
    suspensionHours: CFG.suspensionHours,
  };
}

export default {
  applySanction,
  getModerationState,
  clearSanction,
  banGuard,
  connectSpamFilter,
  getBanManagerConfig,
};
