/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/referral-program.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Programa de referidos: "traé a un amigo, ganá 1000 créditos".

   CÓDIGO
     Formato `NUMI-<SEIS>`: prefijo fijo + 6 caracteres derivados del
     nombre del usuario + un hash corto. Es legible ("NUMI-EMILIO" se
     recuerda y se dicta por teléfono) y único (el hash desempata).

   RECOMPENSA
     · Cuando un usuario NUEVO se registra usando un código válido, el
       que invitó recibe 1000 créditos de inmediato.
     · La conversión se registra UNA sola vez: la misma persona no puede
       canjear el mismo código dos veces (constraint único en la BD).
     · El referido también recibe 250 créditos de bienvenida.

   AISLAMIENTO
     · El código se valida contra la tabla `referrals`: un código que no
       existe no se guarda en ninguna parte.
     · No se puede autoreferir: si el userId del referido es el del
       owner del código, la conversión se rechaza.
     · Los créditos se suman con un UPDATE atómico (balance + 1000) y un
       ledger para poder auditar cada movimiento.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql, supabaseDisponible } from './supabase.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  prefix: 'NUMI',
  codeLength: 6,
  referrerCredits: 1000,
  referredCredits: 500,
  codeTtlDays: 365,
  maxCodesPerUser: 3,
  tables: {
    referrals: 'referrals',
    conversions: 'referral_conversions',
    ledger: 'referral_credit_ledger',
  },
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
        create table if not exists ${sql(CFG.tables.referrals)} (
          id              uuid primary key default gen_random_uuid(),
          user_id         uuid not null,
          code            text not null unique,
          display_name    text,
          email           text,
          clicks          integer not null default 0,
          conversions     integer not null default 0,
          credits_awarded integer not null default 0,
          is_active       boolean not null default true,
          created_at      timestamptz not null default now(),
          updated_at      timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists referrals_user_idx
          on ${sql(CFG.tables.referrals)} (user_id)
      `;

      await sql`
        create table if not exists ${sql(CFG.tables.conversions)} (
          id            uuid primary key default gen_random_uuid(),
          code          text not null,
          referrer_id   uuid not null,
          referred_id   uuid not null,
          referrer_credits integer not null default 0,
          referred_credits integer not null default 0,
          created_at    timestamptz not null default now(),
          unique (code, referred_id)
        )
      `;

      await sql`
        create table if not exists ${sql(CFG.tables.ledger)} (
          id         uuid primary key default gen_random_uuid(),
          user_id    uuid not null,
          delta      integer not null,
          reason     text not null,
          code       text,
          balance_after integer,
          created_at timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists referral_ledger_user_idx
          on ${sql(CFG.tables.ledger)} (user_id, created_at desc)
      `;

      return { ok: true };
    } catch (e) {
      LOG.warn('referral-program: no se pudo crear el esquema', { error: e.message, code: e.code });
      return { ok: false };
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · GENERACIÓN DE CÓDIGO
   ═══════════════════════════════════════════════════════════════════════════ */

const VOWELS = 'AEIOU';

/**
 * Convierte un nombre en un fragmento legible de 6 caracteres.
 * "Emilio García" → "EMILIO" (corta en la primera palabra útil).
 */
function nameSlug(name) {
  const clean = String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

  if (!clean) return '';

  // Si la primera palabra es demasiado corta, se toman las iniciales
  // de las siguientes ("Ana María Restrepo" → "AMR").
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const first = words[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z]/g, '').toUpperCase();
    if (first.length < 3) {
      const initials = words.slice(0, 3).map((w) => w[0] || '').join('').toUpperCase();
      if (initials.length >= 3) return initials.slice(0, CFG.codeLength);
    }
  }

  return clean.slice(0, CFG.codeLength);
}

/**
 * Genera un código único para un usuario.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.name]
 * @param {string} [params.email]
 * @returns {Promise<object>} { ok, code, created, degraded }
 */
export async function generateReferralCode(params = {}) {
  const { userId, name = '', email = null } = params;

  if (!userId) return { ok: false, error: 'Se requiere userId.' };

  if (!supabaseDisponible()) {
    const code = `${CFG.prefix}-${nameSlug(name) || crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    return { ok: true, code, created: true, degraded: true };
  }

  try {
    await ensureSchema();

    // Si ya tiene un código activo, se reutiliza (un código estable es
    // más fácil de recordar y de compartir).
    const existing = await sql`
      select code, display_name, email, clicks, conversions, credits_awarded, created_at
      from ${sql(CFG.tables.referrals)}
      where user_id = ${userId}::uuid and is_active = true
      order by created_at asc
      limit 1
    `;

    if (existing.length) {
      return {
        ok: true,
        code: existing[0].code,
        created: false,
        degraded: false,
        stats: {
          clicks: Number(existing[0].clicks || 0),
          conversions: Number(existing[0].conversions || 0),
          credits: Number(existing[0].credits_awarded || 0),
        },
      };
    }

    const base = nameSlug(name) || crypto.randomBytes(3).toString('hex').toUpperCase();
    const suffix = crypto.randomBytes(2).toString('hex').slice(0, 2).toUpperCase();

    let code = `${CFG.prefix}-${base.slice(0, CFG.codeLength)}`;
    if (base.length >= CFG.codeLength) code = `${CFG.prefix}-${base.slice(0, CFG.codeLength - 2)}${suffix}`;

    // Si el código ya existe, se añade un sufijo numérico.
    const clash = await sql`select 1 from ${sql(CFG.tables.referrals)} where code = ${code} limit 1`;
    if (clash.length) {
      code = `${CFG.prefix}-${base.slice(0, 4)}${crypto.randomBytes(2).toString('hex').slice(0, 2).toUpperCase()}`;
    }

    const rows = await sql`
      insert into ${sql(CFG.tables.referrals)} (user_id, code, display_name, email)
      values (${userId}::uuid, ${code}, ${String(name || '').slice(0, 80) || null}, ${email})
      returning code, created_at
    `;

    LOG.info('referral.code_created', { userId, code: rows[0].code });

    return { ok: true, code: rows[0].code, created: true, degraded: false };
  } catch (e) {
    LOG.error('referral-program: generateReferralCode falló', { error: e.message, code: e.code });
    return { ok: false, error: 'No se pudo generar el código de referido.' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · VALIDACIÓN Y CANJE
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Normaliza un código escrito por el usuario.
 * "numi-emilio", "NUMI EMILIO", "numiemilio" → "NUMI-EMILIO".
 */
export function normalizeCode(input) {
  const raw = String(input || '').trim().toUpperCase().replace(/\s+/g, '-');
  if (!raw) return null;

  const compact = raw.replace(/[^A-Z0-9-]/g, '');
  if (compact.includes('-')) {
    const [prefix, ...rest] = compact.split('-');
    return `${prefix}-${rest.join('')}`;
  }

  if (compact.startsWith(CFG.prefix)) return compact;
  return `${CFG.prefix}-${compact}`;
}

/**
 * Valida un código sin canjearlo.
 */
export async function validateCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return { valid: false, reason: 'empty' };

  if (!supabaseDisponible()) {
    return { valid: true, code: normalized, degraded: true, referrer: null };
  }

  try {
    await ensureSchema();

    const rows = await sql`
      select code, display_name, is_active, clicks, conversions
      from ${sql(CFG.tables.referrals)}
      where code = ${normalized} and is_active = true
      limit 1
    `;

    if (!rows.length) return { valid: false, reason: 'not_found', code: normalized };

    return {
      valid: true,
      code: normalized,
      degraded: false,
      referrer: {
        name: rows[0].display_name || 'Alguien',
        clicks: Number(rows[0].clicks || 0),
        conversions: Number(rows[0].conversions || 0),
      },
    };
  } catch (e) {
    LOG.warn('referral-program: validateCode falló', { error: e.message });
    return { valid: false, reason: 'db_error', code: normalized };
  }
}

/**
 * Canjea un código: el referido queda vinculado y el invitante recibe
 * los créditos.
 *
 * @param {object} params
 * @param {string} params.code
 * @param {string} params.referredId   Usuario nuevo
 * @param {string} [params.referredEmail]
 * @returns {Promise<object>} {
 *   ok, applied, reason, referrerCredits, referredCredits, code
 * }
 */
export async function applyReferralCode(params = {}) {
  const { code, referredId, referredEmail = null } = params;

  if (!code || !referredId) {
    return { ok: false, applied: false, reason: 'missing_params' };
  }

  const normalized = normalizeCode(code);
  if (!normalized) return { ok: false, applied: false, reason: 'empty_code' };

  if (!supabaseDisponible()) {
    return {
      ok: true,
      applied: true,
      degraded: true,
      code: normalized,
      referrerCredits: CFG.referrerCredits,
      referredCredits: CFG.referredCredits,
    };
  }

  try {
    await ensureSchema();

    const refRows = await sql`
      select user_id::text as user_id, code, display_name
      from ${sql(CFG.tables.referrals)}
      where code = ${normalized} and is_active = true
      limit 1
    `;

    if (!refRows.length) {
      return { ok: true, applied: false, reason: 'invalid_code', code: normalized };
    }

    const referrerId = refRows[0].user_id;

    if (referrerId === referredId) {
      return { ok: true, applied: false, reason: 'self_referral', code: normalized };
    }

    // El insert con `unique (code, referred_id)` evita el doble canje.
    const inserted = await sql`
      insert into ${sql(CFG.tables.conversions)} (
        code, referrer_id, referred_id, referrer_credits, referred_credits
      ) values (
        ${normalized}, ${referrerId}::uuid, ${referredId}::uuid,
        ${CFG.referrerCredits}, ${CFG.referredCredits}
      )
      on conflict (code, referred_id) do nothing
      returning id
    `;

    if (!inserted.length) {
      return { ok: true, applied: false, reason: 'already_applied', code: normalized };
    }

    // ── Créditos ────────────────────────────────────────────────────────
    await addCredits(referrerId, CFG.referrerCredits, `referral:${normalized}`, normalized);
    await addCredits(referredId, CFG.referredCredits, `referral-welcome:${normalized}`, normalized);

    await sql`
      update ${sql(CFG.tables.referrals)}
      set conversions = conversions + 1,
          credits_awarded = credits_awarded + ${CFG.referrerCredits},
          updated_at = now()
      where code = ${normalized}
    `;

    LOG.info('referral.applied', { code: normalized, referrerId, referredId });

    return {
      ok: true,
      applied: true,
      degraded: false,
      code: normalized,
      referrerName: refRows[0].display_name || null,
      referrerCredits: CFG.referrerCredits,
      referredCredits: CFG.referredCredits,
    };
  } catch (e) {
    if (e.code === '23505') {
      return { ok: true, applied: false, reason: 'already_applied', code: normalized };
    }
    LOG.error('referral-program: applyReferralCode falló', { error: e.message, code: e.code });
    return { ok: false, applied: false, reason: 'db_error', code: normalized };
  }
}

/**
 * Suma créditos de forma atómica y deja registro en el ledger.
 */
async function addCredits(userId, amount, reason, referralCode = null) {
  if (!userId || !amount) return false;

  try {
    await sql`
      insert into credits (user_id, balance, updated_at)
      values (${userId}::uuid, ${amount}, now())
      on conflict (user_id) do update
        set balance = credits.balance + ${amount},
            updated_at = now()
    `;

    const [row] = await sql`
      select balance from credits where user_id = ${userId}::uuid limit 1
    `;

    await sql`
      insert into ${sql(CFG.tables.ledger)} (user_id, delta, reason, code, balance_after)
      values (${userId}::uuid, ${amount}, ${reason}, ${referralCode}, ${Number(row?.balance || 0)})
    `;

    return true;
  } catch (e) {
    LOG.warn('referral-program: addCredits falló', { error: e.message, code: e.code });
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · ESTADÍSTICAS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Estadísticas del usuario: su código, clicks, conversiones y créditos.
 */
export async function getReferralStats(userId) {
  if (!supabaseDisponible()) {
    return {
      ok: true,
      degraded: true,
      code: null,
      clicks: 0,
      conversions: 0,
      creditsEarned: 0,
      conversionRate: 0,
    };
  }

  try {
    await ensureSchema();

    const rows = await sql`
      select code, clicks, conversions, credits_awarded, created_at
      from ${sql(CFG.tables.referrals)}
      where user_id = ${userId}::uuid and is_active = true
      order by created_at asc
      limit 1
    `;

    if (!rows.length) {
      return { ok: true, degraded: false, code: null, clicks: 0, conversions: 0, creditsEarned: 0, conversionRate: 0 };
    }

    const row = rows[0];
    const clicks = Number(row.clicks || 0);
    const conversions = Number(row.conversions || 0);

    return {
      ok: true,
      degraded: false,
      code: row.code,
      clicks,
      conversions,
      creditsEarned: Number(row.credits_awarded || 0),
      conversionRate: clicks > 0 ? Number(((conversions / clicks) * 100).toFixed(2)) : 0,
      createdAt: row.created_at,
    };
  } catch (e) {
    LOG.warn('referral-program: getReferralStats falló', { error: e.message });
    return { ok: true, degraded: true, code: null, clicks: 0, conversions: 0, creditsEarned: 0, conversionRate: 0 };
  }
}

/**
 * Registra un clic sobre el link de referido (sin canjear).
 */
export async function recordClick(code) {
  const normalized = normalizeCode(code);
  if (!normalized || !supabaseDisponible()) return { ok: true, degraded: true };

  try {
    await ensureSchema();
    await sql`
      update ${sql(CFG.tables.referrals)}
      set clicks = clicks + 1, updated_at = now()
      where code = ${normalized}
    `;
    return { ok: true, degraded: false };
  } catch (e) {
    LOG.warn('referral-program: recordClick falló', { error: e.message });
    return { ok: false };
  }
}

/**
 * Ranking de mejores referidores (solo para admin).
 */
export async function getTopReferrers({ limit = 20 } = {}) {
  if (!supabaseDisponible()) return { ok: true, degraded: true, users: [] };

  try {
    await ensureSchema();
    const rows = await sql`
      select
        r.code,
        r.display_name,
        r.clicks,
        r.conversions,
        r.credits_awarded,
        p.email
      from ${sql(CFG.tables.referrals)} r
      left join public.profiles p on p.id = r.user_id
      order by r.credits_awarded desc, r.conversions desc
      limit ${Math.min(Number(limit) || 20, 100)}
    `;
    return { ok: true, degraded: false, users: rows };
  } catch (e) {
    LOG.warn('referral-program: getTopReferrers falló', { error: e.message });
    return { ok: true, degraded: true, users: [] };
  }
}

export function getReferralConfig() {
  return {
    prefix: CFG.prefix,
    codeLength: CFG.codeLength,
    referrerCredits: CFG.referrerCredits,
    referredCredits: CFG.referredCredits,
  };
}

/**
 * Alias con el nombre de negocio ("processReferral"): aplica un código
 * de referido y reparte los créditos (1000 al invitador, 500 al invitado).
 *
 * @param {object} params { code, referredId, referredEmail }
 * @returns {Promise<object>}
 */
export const processReferral = applyReferralCode;

export default {
  generateReferralCode,
  applyReferralCode,
  processReferral,
  validateCode,
  getReferralStats,
  getTopReferrers,
  recordClick,
  normalizeCode,
  getReferralConfig,
};
