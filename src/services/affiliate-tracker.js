/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/affiliate-tracker.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Tracking de afiliados: clics en `?ref=` → Postgres → comisiones.

   FLUJO
     1. Middleware `affiliateTracker()`: al detectar `?ref=CODIGO` en
        cualquier request, guarda el código en una cookie (30 días) y
        registra el clic.
     2. Cuando el visitante se registra (o se convierte en suscriptor),
        el código de la cookie se canjea y se calcula la comisión.
     3. `calculateCommissions(period)` reparte el total de la ventana
        entre los afiliados según el modelo configurado.

   MODELO DE COMISIÓN
     · Porcentaje del pago del referido (por defecto 20 %).
     · Comisión fija por conversión (opcional).
     · Tope mensual por afiliado (protege el margen).

   PRIVACIDAD
     · Solo se guarda: código, IP truncada por hash, user agent truncado,
       landing y timestamp. No se guarda el email del visitante ni
       cookies de terceros.
     · La IP se hashea con un salt: sirve para detectar abuso sin
       guardar un dato personal en claro.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql, supabaseDisponible } from './supabase.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  cookieName: 'nm_ref',
  cookieDays: 30,
  paramName: 'ref',
  commissionPct: 20,          // % sobre el pago del referido
  fixedCommission: 0,         // créditos extra por conversión
  monthlyCapCredits: 20000,   // tope de comisión por mes y afiliado
  ipSalt: process.env.AFFILIATE_SALT || 'numination-affiliate-v1',
  tables: {
    affiliates: 'affiliates',
    clicks: 'affiliate_clicks',
    conversions: 'affiliate_conversions',
    commissions: 'affiliate_commissions',
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
        create table if not exists ${sql(CFG.tables.affiliates)} (
          id           uuid primary key default gen_random_uuid(),
          code         text not null unique,
          user_id      uuid,
          name         text,
          email        text,
          payout_email text,
          commission_pct numeric(5,2) not null default ${CFG.commissionPct},
          is_active    boolean not null default true,
          created_at   timestamptz not null default now(),
          updated_at   timestamptz not null default now()
        )
      `;

      await sql`
        create table if not exists ${sql(CFG.tables.clicks)} (
          id         uuid primary key default gen_random_uuid(),
          code       text not null,
          visitor    text,
          user_agent text,
          landing    text,
          referrer   text,
          created_at timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists affiliate_clicks_code_idx
          on ${sql(CFG.tables.clicks)} (code, created_at desc)
      `;

      await sql`
        create table if not exists ${sql(CFG.tables.conversions)} (
          id          uuid primary key default gen_random_uuid(),
          code        text not null,
          affiliate_id uuid,
          user_id     uuid not null,
          amount      numeric(12,2) not null default 0,
          credits     integer not null default 0,
          commission  numeric(12,2) not null default 0,
          created_at  timestamptz not null default now(),
          unique (code, user_id)
        )
      `;

      await sql`
        create table if not exists ${sql(CFG.tables.commissions)} (
          id           uuid primary key default gen_random_uuid(),
          affiliate_id uuid not null,
          period       text not null,
          conversions  integer not null default 0,
          revenue      numeric(14,2) not null default 0,
          commission   numeric(14,2) not null default 0,
          capped       boolean not null default false,
          paid         boolean not null default false,
          created_at   timestamptz not null default now(),
          updated_at   timestamptz not null default now(),
          unique (affiliate_id, period)
        )
      `;

      return { ok: true };
    } catch (e) {
      LOG.warn('affiliate-tracker: no se pudo crear el esquema', { error: e.message, code: e.code });
      return { ok: false };
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHash('sha256').update(`${CFG.ipSalt}:${ip}`).digest('hex').slice(0, 32);
}

function clientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

export function normalizeAffiliateCode(input) {
  const raw = String(input || '').trim().toUpperCase();
  if (!raw) return null;
  const compact = raw.replace(/[^A-Z0-9-]/g, '');
  return compact.slice(0, 32);
}

function currentPeriod(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · REGISTRO DE CLICS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Middleware Express: detecta `?ref=` y registra el clic.
 * @param {object} [opts]
 * @returns {function} middleware
 */
export function affiliateTracker(opts = {}) {
  const { paramName = CFG.paramName, cookieName = CFG.cookieName } = opts;

  return function track(req, res, next) {
    try {
      const raw = req.query?.[paramName];
      const code = normalizeAffiliateCode(raw);

      if (code) {
        res.cookie(cookieName, code, {
          maxAge: CFG.cookieDays * 86400_000,
          httpOnly: false,
          sameSite: 'lax',
          secure: process.env.NODE_ENV === 'production',
          path: '/',
        });

        // El registro es fire-and-forget: nunca bloquea la request.
        recordClick({
          code,
          ip: clientIp(req),
          userAgent: req.headers['user-agent'],
          landing: req.originalUrl || req.url,
          referrer: req.headers.referer || null,
        }).catch(() => {});
      }
    } catch (e) {
      LOG.debug('affiliate-tracker: no se pudo registrar el clic', { error: e.message });
    }

    next();
  };
}

/**
 * Persiste un clic.
 */
export async function recordClick({ code, ip, userAgent, landing, referrer } = {}) {
  const normalized = normalizeAffiliateCode(code);
  if (!normalized) return { ok: false };

  if (!supabaseDisponible()) return { ok: true, degraded: true };

  try {
    await ensureSchema();

    await sql`
      insert into ${sql(CFG.tables.clicks)} (code, visitor, user_agent, landing, referrer)
      values (
        ${normalized},
        ${hashIp(ip)},
        ${String(userAgent || '').slice(0, 200) || null},
        ${String(landing || '').slice(0, 300) || null},
        ${String(referrer || '').slice(0, 300) || null}
      )
    `;

    return { ok: true, degraded: false };
  } catch (e) {
    LOG.warn('affiliate-tracker: recordClick falló', { error: e.message });
    return { ok: false };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · CONVERSIONES Y COMISIONES
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Registra una conversión (alta o pago) y calcula la comisión.
 *
 * @param {object} params
 * @param {string} params.code
 * @param {string} params.userId    El referido
 * @param {number} [params.amount]  Monto del pago
 * @param {number} [params.credits]
 * @returns {Promise<object>} { ok, converted, commission, reason }
 */
export async function trackConversion(params = {}) {
  const { code, userId, amount = 0, credits = 0 } = params;
  const normalized = normalizeAffiliateCode(code);

  if (!normalized || !userId) {
    return { ok: false, converted: false, reason: 'missing_params' };
  }

  if (!supabaseDisponible()) {
    const commission = (Number(amount) * CFG.commissionPct) / 100;
    return { ok: true, degraded: true, converted: true, commission };
  }

  try {
    await ensureSchema();

    const affRows = await sql`
      select id::text as id, commission_pct, is_active
      from ${sql(CFG.tables.affiliates)}
      where code = ${normalized} and is_active = true
      limit 1
    `;

    if (!affRows.length) {
      return { ok: true, converted: false, reason: 'unknown_code' };
    }

    const affiliate = affRows[0];
    const pct = Number(affiliate.commission_pct ?? CFG.commissionPct);
    const commission = (Number(amount || 0) * pct) / 100 + CFG.fixedCommission;

    const inserted = await sql`
      insert into ${sql(CFG.tables.conversions)} (
        code, affiliate_id, user_id, amount, credits, commission
      ) values (
        ${normalized}, ${affiliate.id}::uuid, ${userId}::uuid,
        ${Number(amount || 0)}, ${Number(credits || 0)}, ${commission}
      )
      on conflict (code, user_id) do nothing
      returning id
    `;

    if (!inserted.length) {
      return { ok: true, converted: false, reason: 'already_converted' };
    }

    await sql`
      insert into ${sql(CFG.tables.commissions)} (
        affiliate_id, period, conversions, revenue, commission
      ) values (
        ${affiliate.id}::uuid, ${currentPeriod()}, 1, ${Number(amount || 0)}, ${commission}
      )
      on conflict (affiliate_id, period) do update
        set conversions = ${sql(CFG.tables.commissions)}.conversions + 1,
            revenue = ${sql(CFG.tables.commissions)}.revenue + ${Number(amount || 0)},
            commission = ${sql(CFG.tables.commissions)}.commission + ${commission},
            updated_at = now()
    `;

    LOG.info('affiliate-tracker: conversión registrada', {
      code: normalized,
      amount,
      commission: Number(commission.toFixed(2)),
    });

    return {
      ok: true,
      degraded: false,
      converted: true,
      commission: Number(commission.toFixed(2)),
      rate: pct,
    };
  } catch (e) {
    if (e.code === '23505') {
      return { ok: true, converted: false, reason: 'already_converted' };
    }
    LOG.error('affiliate-tracker: trackConversion falló', { error: e.message, code: e.code });
    return { ok: false, converted: false, reason: 'db_error' };
  }
}

/**
 * Calcula las comisiones de un período aplicando el tope mensual.
 *
 * @param {object} [opts] { period, applyCap }
 * @returns {Promise<object>} { ok, period, affiliates: [...], total }
 */
export async function calculateCommissions(opts = {}) {
  if (!supabaseDisponible()) {
    return { ok: true, degraded: true, period: opts.period || currentPeriod(), affiliates: [], total: 0 };
  }

  const period = String(opts.period || currentPeriod());

  try {
    await ensureSchema();

    const rows = await sql`
      select
        c.affiliate_id::text as affiliate_id,
        a.code,
        a.name,
        a.email,
        a.commission_pct,
        c.conversions,
        c.revenue,
        c.commission
      from ${sql(CFG.tables.commissions)} c
      join ${sql(CFG.tables.affiliates)} a on a.id = c.affiliate_id
      where c.period = ${period}
      order by c.commission desc
    `;

    const affiliates = rows.map((row) => {
      const raw = Number(row.commission || 0);
      const capped = raw > CFG.monthlyCapCredits;
      const commission = capped ? CFG.monthlyCapCredits : raw;

      return {
        affiliateId: row.affiliate_id,
        code: row.code,
        name: row.name,
        email: row.email,
        rate: Number(row.commission_pct || CFG.commissionPct),
        conversions: Number(row.conversions || 0),
        revenue: Number(row.revenue || 0),
        commission: Number(commission.toFixed(2)),
        rawCommission: Number(raw.toFixed(2)),
        capped,
      };
    });

    const total = affiliates.reduce((acc, a) => acc + a.commission, 0);

    if (opts.applyCap) {
      for (const aff of affiliates) {
        await sql`
          update ${sql(CFG.tables.commissions)}
          set commission = ${aff.commission},
              capped = ${aff.capped},
              updated_at = now()
          where affiliate_id = ${aff.affiliateId}::uuid and period = ${period}
        `;
      }
    }

    return {
      ok: true,
      degraded: false,
      period,
      affiliates,
      total: Number(total.toFixed(2)),
    };
  } catch (e) {
    LOG.error('affiliate-tracker: calculateCommissions falló', { error: e.message, code: e.code });
    return { ok: false, period, affiliates: [], total: 0 };
  }
}

/**
 * Estadísticas de un afiliado: clics, conversiones, comisión del mes.
 */
export async function getAffiliateStats(code) {
  const normalized = normalizeAffiliateCode(code);

  if (!supabaseDisponible()) {
    return { ok: true, degraded: true, code: normalized, clicks: 0, conversions: 0, commission: 0 };
  }

  try {
    await ensureSchema();

    const [clickRows, convRows, affRows] = await Promise.all([
      sql`
        select count(*)::int as clicks
        from ${sql(CFG.tables.clicks)}
        where code = ${normalized}
          and created_at >= now() - interval '30 days'
      `,
      sql`
        select
          count(*)::int as conversions,
          coalesce(sum(amount), 0)::numeric(14,2) as revenue,
          coalesce(sum(commission), 0)::numeric(14,2) as commission
        from ${sql(CFG.tables.conversions)}
        where code = ${normalized}
          and created_at >= now() - interval '30 days'
      `,
      sql`
        select code, name, commission_pct, is_active, created_at
        from ${sql(CFG.tables.affiliates)}
        where code = ${normalized}
        limit 1
      `,
    ]);

    return {
      ok: true,
      degraded: false,
      code: normalized,
      name: affRows[0]?.name || null,
      rate: Number(affRows[0]?.commission_pct ?? CFG.commissionPct),
      active: affRows[0]?.is_active !== false,
      clicks: Number(clickRows[0]?.clicks || 0),
      conversions: Number(convRows[0]?.conversions || 0),
      revenue: Number(convRows[0]?.revenue || 0),
      commission: Number(convRows[0]?.commission || 0),
    };
  } catch (e) {
    LOG.warn('affiliate-tracker: getAffiliateStats falló', { error: e.message });
    return { ok: true, degraded: true, code: normalized, clicks: 0, conversions: 0, commission: 0 };
  }
}

/**
 * Registra (o actualiza) un afiliado.
 */
export async function upsertAffiliate(params = {}) {
  const { code, userId = null, name = null, email = null, payoutEmail = null, commissionPct } = params;
  const normalized = normalizeAffiliateCode(code);

  if (!normalized) return { ok: false, error: 'Código inválido.' };
  if (!supabaseDisponible()) return { ok: true, degraded: true, code: normalized };

  try {
    await ensureSchema();

    const pct = Number.isFinite(Number(commissionPct))
      ? Math.max(0, Math.min(100, Number(commissionPct)))
      : CFG.commissionPct;

    const rows = await sql`
      insert into ${sql(CFG.tables.affiliates)} (
        code, user_id, name, email, payout_email, commission_pct
      ) values (
        ${normalized},
        ${isUuid(userId) ? userId : null}::uuid,
        ${name ? String(name).slice(0, 80) : null},
        ${email ? String(email).slice(0, 160) : null},
        ${payoutEmail ? String(payoutEmail).slice(0, 160) : null},
        ${pct}
      )
      on conflict (code) do update
        set name = coalesce(excluded.name, ${sql(CFG.tables.affiliates)}.name),
            email = coalesce(excluded.email, ${sql(CFG.tables.affiliates)}.email),
            payout_email = coalesce(excluded.payout_email, ${sql(CFG.tables.affiliates)}.payout_email),
            commission_pct = excluded.commission_pct,
            updated_at = now()
      returning code, name, commission_pct
    `;

    return { ok: true, degraded: false, affiliate: rows[0] };
  } catch (e) {
    LOG.error('affiliate-tracker: upsertAffiliate falló', { error: e.message, code: e.code });
    return { ok: false, error: 'No se pudo guardar el afiliado.' };
  }
}

function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export function getAffiliateConfig() {
  return {
    paramName: CFG.paramName,
    cookieName: CFG.cookieName,
    cookieDays: CFG.cookieDays,
    commissionPct: CFG.commissionPct,
    fixedCommission: CFG.fixedCommission,
    monthlyCapCredits: CFG.monthlyCapCredits,
  };
}

export default {
  affiliateTracker,
  recordClick,
  trackConversion,
  calculateCommissions,
  getAffiliateStats,
  upsertAffiliate,
  normalizeAffiliateCode,
  getAffiliateConfig,
};
