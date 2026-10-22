/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/referral-program.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Programa de referidos con códigos `NUMI-XXXX`.

   FLUJO
     1. El usuario pide su código → `NUMI-XXXX` (alfabeto sin caracteres
        ambiguos: no hay O/0, I/1, S/5).
     2. Un usuario nuevo introduce ese código al registrarse.
     3. En UNA transacción (BEGIN/COMMIT) se:
          · registra la conversión,
          · suma créditos al que invita,
          · suma créditos al invitado,
          · incrementa los contadores del código.
        Si algo falla, se deshace todo: no hay créditos parciales.

   ESQUEMA
     referrals            (id, user_id, code unique, display_name, clicks,
                           conversions, credits_awarded, created_at)
     referral_conversions (id, code, referrer_id, referred_id unique,
                           credits_awarded, created_at)
     credits              (user_id pk, balance, updated_at)
   ═══════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql, supabaseDisponible } from '../src/services/supabase.js';
import { LOG } from '../src/lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  prefix: 'NUMI-',
  codeLength: 4,
  alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  referrerCredits: 50,
  referredCredits: 25,
  tables: Object.freeze({
    referrals: 'referrals',
    conversions: 'referral_conversions',
    credits: 'credits',
  }),
});

/* ═══════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Normaliza un código: mayúsculas y sin espacios.
 * @param {string} code
 * @returns {string}
 */
export function normalizeCode(code) {
  return String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Genera un código aleatorio con el formato `NUMI-XXXX`.
 * @returns {string}
 */
export function randomCode() {
  const bytes = crypto.randomBytes(CFG.codeLength);
  let out = '';
  for (let i = 0; i < CFG.codeLength; i += 1) {
    out += CFG.alphabet[bytes[i] % CFG.alphabet.length];
  }
  return `${CFG.prefix}${out}`;
}

/**
 * ¿El código tiene el formato esperado?
 * @param {string} code
 * @returns {boolean}
 */
export function isValidFormat(code) {
  const value = normalizeCode(code);
  const re = new RegExp(`^${CFG.prefix}[${CFG.alphabet}]{${CFG.codeLength}}$`);
  return re.test(value);
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
        create table if not exists ${sql(CFG.tables.referrals)} (
          id            uuid primary key default gen_random_uuid(),
          user_id       uuid not null,
          code          text not null unique,
          display_name  text,
          clicks        int  not null default 0,
          conversions   int  not null default 0,
          credits_awarded int not null default 0,
          created_at    timestamptz not null default now()
        )
      `;
      await sql`
        create table if not exists ${sql(CFG.tables.conversions)} (
          id            uuid primary key default gen_random_uuid(),
          code          text not null,
          referrer_id   uuid not null,
          referred_id   uuid not null unique,
          credits_awarded int not null default 0,
          created_at    timestamptz not null default now()
        )
      `;
      await sql`
        create table if not exists ${sql(CFG.tables.credits)} (
          user_id    uuid primary key,
          balance    numeric not null default 0,
          updated_at timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists referrals_user_idx
          on ${sql(CFG.tables.referrals)} (user_id)
      `;
      return true;
    } catch (e) {
      LOG.warn('referral-program: no se pudo crear el esquema', { error: e.message, code: e.code });
      return false;
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════
   04 · CRÉDITOS (dentro de la transacción)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Suma créditos a un usuario. `trx` es el cliente de la transacción:
 * si la operación falla, se deshace todo.
 *
 * @param {object} trx    Cliente postgres.js de la transacción.
 * @param {string} userId
 * @param {number} amount
 * @returns {Promise<number>} saldo resultante
 */
async function addCreditsInTx(trx, userId, amount) {
  const rows = await trx`
    insert into ${sql(CFG.tables.credits)} (user_id, balance, updated_at)
    values (${userId}::uuid, ${amount}, now())
    on conflict (user_id) do update
      set balance = ${sql(CFG.tables.credits)}.balance + ${amount},
          updated_at = now()
    returning balance
  `;
  return Number(rows?.[0]?.balance ?? amount);
}

/* ═══════════════════════════════════════════════════════════════════════
   05 · API
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Devuelve (o crea) el código de referido del usuario.
 *
 * @param {string} userId
 * @param {string} [displayName]
 * @returns {Promise<{ok:boolean, code:string|null, created:boolean, error:string|null}>}
 */
export async function generateReferralCode(userId, displayName = null) {
  if (!supabaseDisponible() || !isUuid(userId)) {
    return { ok: false, code: null, created: false, error: 'INVALID_USER' };
  }

  try {
    await ensureSchema();

    const existing = await sql`
      select code from ${sql(CFG.tables.referrals)}
      where user_id = ${userId}::uuid
      limit 1
    `;
    if (existing?.[0]?.code) {
      return { ok: true, code: existing[0].code, created: false, error: null };
    }

    // Hasta 5 intentos por colisión de código (probabilidad bajísima).
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomCode();
      try {
        const rows = await sql`
          insert into ${sql(CFG.tables.referrals)} (user_id, code, display_name)
          values (${userId}::uuid, ${code}, ${displayName ? String(displayName).slice(0, 80) : null})
          on conflict (user_id) do update set code = ${sql(CFG.tables.referrals)}.code
          returning code, (xmax = 0) as inserted
        `;
        const finalCode = rows?.[0]?.code ?? code;
        return { ok: true, code: finalCode, created: Boolean(rows?.[0]?.inserted), error: null };
      } catch (e) {
        if (e.code === '23505') continue; // colisión de unicidad → otro código
        throw e;
      }
    }

    return { ok: false, code: null, created: false, error: 'CODE_COLLISION' };
  } catch (e) {
    LOG.error('referral-program: no se pudo generar el código', {
      userId, error: e.message, code: e.code,
    });
    return { ok: false, code: null, created: false, error: e.message };
  }
}

/**
 * Comprueba si un código existe y a quién pertenece.
 * @param {string} code
 * @returns {Promise<{valid:boolean, code:string|null, referrerId:string|null, reason:string|null}>}
 */
export async function validateReferralCode(code) {
  const normalized = normalizeCode(code);

  if (!isValidFormat(normalized)) {
    return { valid: false, code: null, referrerId: null, reason: 'INVALID_FORMAT' };
  }
  if (!supabaseDisponible()) {
    return { valid: false, code: normalized, referrerId: null, reason: 'DB_UNAVAILABLE' };
  }

  try {
    await ensureSchema();
    const rows = await sql`
      select user_id::text as user_id
      from ${sql(CFG.tables.referrals)}
      where code = ${normalized}
      limit 1
    `;
    const row = rows?.[0];
    if (!row) {
      return { valid: false, code: normalized, referrerId: null, reason: 'NOT_FOUND' };
    }
    return { valid: true, code: normalized, referrerId: row.user_id, reason: null };
  } catch (e) {
    LOG.warn('referral-program: no se pudo validar el código', { error: e.message });
    return { valid: false, code: normalized, referrerId: null, reason: 'DB_ERROR' };
  }
}

/**
 * Aplica un código de referido a un usuario nuevo.
 *
 * Todo ocurre dentro de UNA transacción (BEGIN/COMMIT): o se acreditan
 * los dos lados, o no se acredita ninguno.
 *
 * @param {string} code        Código `NUMI-XXXX`.
 * @param {string} newUserId   Usuario que se acaba de registrar.
 * @returns {Promise<{ok:boolean, applied:boolean, referrerCredits:number,
 *                    referredCredits:number, balances:object|null, reason:string|null}>}
 */
export async function applyReferralCode(code, newUserId) {
  const normalized = normalizeCode(code);
  const empty = {
    ok: false,
    applied: false,
    referrerCredits: 0,
    referredCredits: 0,
    balances: null,
    reason: null,
  };

  if (!isValidFormat(normalized)) return { ...empty, reason: 'INVALID_FORMAT' };
  if (!supabaseDisponible() || !isUuid(newUserId)) {
    return { ...empty, reason: 'INVALID_USER' };
  }

  try {
    await ensureSchema();

    const balances = await sql.begin(async (trx) => {
      // ── Código y referrer (FOR UPDATE serializa dos registros a la vez) ──
      const codeRows = await trx`
        select user_id::text as user_id
        from ${sql(CFG.tables.referrals)}
        where code = ${normalized}
        for update
        limit 1
      `;
      const referrerId = codeRows?.[0]?.user_id;

      if (!referrerId) {
        const error = new Error('NOT_FOUND');
        error.code = 'NOT_FOUND';
        throw error;
      }

      if (referrerId === newUserId) {
        const error = new Error('SELF_REFERRAL');
        error.code = 'SELF_REFERRAL';
        throw error;
      }

      // ── Conversión (única por invitado) ──
      const conversionRows = await trx`
        insert into ${sql(CFG.tables.conversions)}
          (code, referrer_id, referred_id, credits_awarded)
        values (
          ${normalized},
          ${referrerId}::uuid,
          ${newUserId}::uuid,
          ${CFG.referrerCredits + CFG.referredCredits}
        )
        on conflict (referred_id) do nothing
        returning id
      `;

      if (!conversionRows?.length) {
        const error = new Error('ALREADY_APPLIED');
        error.code = 'ALREADY_APPLIED';
        throw error;
      }

      // ── Créditos para ambos ──
      const referrerBalance = await addCreditsInTx(trx, referrerId, CFG.referrerCredits);
      const referredBalance = await addCreditsInTx(trx, newUserId, CFG.referredCredits);

      // ── Contadores del código ──
      await trx`
        update ${sql(CFG.tables.referrals)}
        set conversions = conversions + 1,
            credits_awarded = credits_awarded + ${CFG.referrerCredits},
            display_name = coalesce(display_name, ${null})
        where code = ${normalized}
      `;

      return { referrerId, referrerBalance, referredBalance };
    });

    LOG.info('referral.applied', {
      code: normalized,
      referrerId: balances.referrerId,
      referredId: newUserId,
    });

    return {
      ok: true,
      applied: true,
      referrerCredits: CFG.referrerCredits,
      referredCredits: CFG.referredCredits,
      balances: {
        referrer: balances.referrerBalance,
        referred: balances.referredBalance,
      },
      reason: null,
    };
  } catch (e) {
    const reason = e.code || 'DB_ERROR';
    LOG.warn('referral-program: no se pudo aplicar el código', {
      code: normalized, reason, error: e.message,
    });
    return { ...empty, reason };
  }
}

/**
 * Estadísticas del usuario dentro del programa.
 * @param {string} userId
 * @returns {Promise<{code:string|null, clicks:number, conversions:number,
 *                    creditsAwarded:number, balance:number}>}
 */
export async function getReferralStats(userId) {
  const empty = {
    code: null, clicks: 0, conversions: 0, creditsAwarded: 0, balance: 0,
  };

  if (!supabaseDisponible() || !isUuid(userId)) return empty;

  try {
    await ensureSchema();

    const rows = await sql`
      select code, clicks, conversions, credits_awarded
      from ${sql(CFG.tables.referrals)}
      where user_id = ${userId}::uuid
      limit 1
    `;
    const row = rows?.[0];

    const creditRows = await sql`
      select balance from ${sql(CFG.tables.credits)}
      where user_id = ${userId}::uuid
      limit 1
    `;

    return {
      code: row?.code ?? null,
      clicks: Number(row?.clicks || 0),
      conversions: Number(row?.conversions || 0),
      creditsAwarded: Number(row?.credits_awarded || 0),
      balance: Number(creditRows?.[0]?.balance || 0),
    };
  } catch (e) {
    LOG.warn('referral-program: no se pudieron leer las estadísticas', {
      userId, error: e.message,
    });
    return empty;
  }
}

/**
 * Registra un clic en un enlace de referido.
 * @param {string} code
 * @returns {Promise<boolean>}
 */
export async function trackClick(code) {
  const normalized = normalizeCode(code);
  if (!isValidFormat(normalized) || !supabaseDisponible()) return false;

  try {
    await ensureSchema();
    const rows = await sql`
      update ${sql(CFG.tables.referrals)}
      set clicks = clicks + 1
      where code = ${normalized}
      returning code
    `;
    return Boolean(rows?.length);
  } catch (e) {
    LOG.warn('referral-program: no se pudo registrar el clic', { error: e.message });
    return false;
  }
}

export default {
  generateReferralCode,
  validateReferralCode,
  applyReferralCode,
  getReferralStats,
  trackClick,
  randomCode,
  normalizeCode,
  isValidFormat,
};
