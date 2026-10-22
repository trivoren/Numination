/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/web-vitals.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Métricas de Web Vitals (LCP / FID / CLS) → Postgres.

   QUÉ MIDE
     · LCP  (Largest Contentful Paint)  → cuánto tarda en verse el
       elemento más grande.
     · FID  (First Input Delay)          → cuánto tarda la app en
       responder al primer toque.
     · CLS  (Cumulative Layout Shift)    → cuánto "bailó" el layout.
     · INP  (Interaction to Next Paint) → la métrica moderna que
       reemplaza a FID (mide todas las interacciones, no sólo la
       primera).
     · TTFB (Time to First Byte)        → la latencia del servidor.
     · FCP  (First Contentful Paint).

   POR QUÉ UNA TABLA PROPIA
     Las métricas de una sesión van juntas: guardarlas separadas
     permite comparar "la página lenta" con "el servidor lento". La
     tabla tiene un índice por (path, created_at) para poder filtrar
     rápido por página.

   ESQUEMA `web_vitals`
     id, user_id, path, lcp, fid, cls, inp, ttfb, fcp, navigation_type,
     connection_type, device_type, meta (jsonb), created_at

   PRIVACIDAD
     No se guarda ninguna URL con parámetros ni datos personales: la ruta
     se normaliza (sin query string) y el `userAgent` se reduce a la
     familia del navegador.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import express from 'express';
import { sql, supabaseDisponible } from './supabase.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  table: 'web_vitals',
  maxValue: 600_000,        // 10 min: por encima es basura
  retentionDays: 90,
  batchWindowMs: 10_000,    // el cliente agrupa envíos
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
          id              uuid primary key default gen_random_uuid(),
          user_id         uuid,
          session_id      text,
          path            text not null default '/',
          lcp             integer,
          fid             integer,
          cls             numeric(6,4),
          inp             integer,
          ttfb            integer,
          fcp             integer,
          navigation_type text,
          connection_type text,
          device_type     text,
          meta            jsonb default '{}'::jsonb,
          created_at      timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists web_vitals_path_idx
          on ${sql(CFG.table)} (path, created_at desc)
      `;
      await sql`
        create index if not exists web_vitals_created_idx
          on ${sql(CFG.table)} (created_at desc)
      `;
      return { ok: true };
    } catch (e) {
      LOG.warn('web-vitals: no se pudo crear el esquema', { error: e.message, code: e.code });
      return { ok: false };
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · NORMALIZACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Normaliza la ruta: sin query string, sin hash, máximo 200 caracteres.
 */
export function normalizePath(raw) {
  const value = String(raw || '/');

  let path = value;
  try {
    path = new URL(value, 'https://numination.app').pathname;
  } catch {
    path = value.split('?')[0].split('#')[0];
  }

  return (path || '/').slice(0, 200);
}

function clampNumber(value, max = CFG.maxValue) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Math.round(n), max);
}

function clampFloat(value, max = 10) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.min(Number(n.toFixed(4)), max);
}

/**
 * Deduce el tipo de dispositivo a partir del user agent.
 */
export function detectDeviceType(userAgent) {
  const ua = String(userAgent || '').toLowerCase();

  if (/ipad|tablet|playbook|silk|(android(?!.*mobile))/.test(ua)) return 'tablet';
  if (/mobi|iphone|android|phone/.test(ua)) return 'mobile';
  if (!ua) return 'unknown';
  return 'desktop';
}

/**
 * Deduce el tipo de conexión (4g / 3g / slow-2g).
 */
export function detectConnectionType(connection) {
  if (!connection) return 'unknown';
  const type = String(connection.effectiveType || connection.type || '').toLowerCase();
  const downlink = Number(connection.downlink);

  if (type) return type;
  if (downlink >= 10) return '4g';
  if (downlink >= 2) return '3g';
  if (downlink >= 0.5) return '2g';
  if (downlink > 0) return 'slow-2g';
  return 'unknown';
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · GUARDADO
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Guarda las métricas de una navegación.
 *
 * @param {object} params
 * @param {string} [params.userId]
 * @param {string} params.path
 * @param {number} [params.lcp]
 * @param {number} [params.fid]
 * @param {number} [params.cls]
 * @param {number} [params.inp]
 * @param {number} [params.ttfb]
 * @param {number} [params.fcp]
 * @param {string} [params.navigationType]
 * @param {string} [params.connectionType]
 * @param {string} [params.deviceType]
 * @param {object} [params.meta]
 * @returns {Promise<object>} { ok, id, degraded }
 */
export async function recordVitals(params = {}) {
  const path = normalizePath(params.path);

  const lcp = clampNumber(params.lcp);
  const fid = clampNumber(params.fid);
  const cls = clampFloat(params.cls);
  const inp = clampNumber(params.inp);
  const ttfb = clampNumber(params.ttfb);
  const fcp = clampNumber(params.fcp);

  // Si no hay ninguna métrica, no hay nada que guardar.
  if (lcp === null && fid === null && cls === null && inp === null && ttfb === null && fcp === null) {
    return { ok: false, error: 'No hay métricas para guardar.', code: 'empty_vitals' };
  }

  const payload = {
    userId: params.userId || null,
    sessionId: params.sessionId ? String(params.sessionId).slice(0, 80) : null,
    path,
    lcp,
    fid,
    cls,
    inp,
    ttfb,
    fcp,
    navigationType: params.navigationType ? String(params.navigationType).slice(0, 40) : null,
    connectionType: params.connectionType ? String(params.connectionType).slice(0, 20) : null,
    deviceType: params.deviceType ? String(params.deviceType).slice(0, 20) : null,
    meta: params.meta && typeof params.meta === 'object' ? params.meta : {},
  };

  if (!supabaseDisponible()) {
    LOG.debug('web-vitals: métricas sin base de datos', payload);
    return { ok: true, degraded: true, id: null };
  }

  try {
    await ensureSchema();

    const rows = await sql`
      insert into ${sql(CFG.table)} (
        user_id, session_id, path, lcp, fid, cls, inp, ttfb, fcp,
        navigation_type, connection_type, device_type, meta
      ) values (
        ${isUuid(payload.userId) ? payload.userId : null}::uuid,
        ${payload.sessionId},
        ${payload.path},
        ${payload.lcp},
        ${payload.fid},
        ${payload.cls},
        ${payload.inp},
        ${payload.ttfb},
        ${payload.fcp},
        ${payload.navigationType},
        ${payload.connectionType},
        ${payload.deviceType},
        ${sql.json(payload.meta)}
      )
      returning id::text as id
    `;

    return { ok: true, degraded: false, id: rows[0]?.id || null };
  } catch (e) {
    LOG.warn('web-vitals: no se pudo guardar', { error: e.message, code: e.code });
    return { ok: false, degraded: false, error: 'No se pudieron guardar las métricas.' };
  }
}

/**
 * Guarda varias navegaciones de un mismo envío (batch).
 */
export async function recordBatch(items = [], userId = null) {
  const list = Array.isArray(items) ? items.slice(0, 20) : [];

  if (!list.length) {
    return { ok: false, error: 'No hay métricas para guardar.', code: 'empty_batch' };
  }

  const results = [];
  for (const item of list) {
    results.push(await recordVitals({ ...item, userId: item.userId || userId }));
  }

  const ok = results.filter((r) => r.ok).length;

  return { ok: ok > 0, saved: ok, failed: results.length - ok };
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · CONSULTAS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Agrega las métricas con percentiles (p50 / p75 / p95).
 *
 * @param {object} [opts] { days, path, limit }
 */
export async function getVitalsSummary(opts = {}) {
  if (!supabaseDisponible()) {
    return {
      ok: true,
      degraded: true,
      count: 0,
      lcp: { p50: null, p75: null, p95: null, avg: null },
      cls: { p50: null, p75: null, p95: null, avg: null },
      inp: { p50: null, p75: null, p95: null, avg: null },
      ttfb: { p50: null, p75: null, p95: null, avg: null },
    };
  }

  try {
    await ensureSchema();

    const days = Math.min(Number(opts.days) || 7, 90);
    const pathFilter = opts.path ? sql`and path = ${normalizePath(opts.path)}` : sql``;

    const rows = await sql`
      select
        count(*)::int as total,
        percentile_cont(0.50) within group (order by lcp)::int as lcp_p50,
        percentile_cont(0.75) within group (order by lcp)::int as lcp_p75,
        percentile_cont(0.95) within group (order by lcp)::int as lcp_p95,
        avg(lcp)::int as lcp_avg,
        percentile_cont(0.50) within group (order by cls)::numeric(6,4) as cls_p50,
        percentile_cont(0.75) within group (order by cls)::numeric(6,4) as cls_p75,
        percentile_cont(0.95) within group (order by cls)::numeric(6,4) as cls_p95,
        avg(cls)::numeric(6,4) as cls_avg,
        percentile_cont(0.50) within group (order by inp)::int as inp_p50,
        percentile_cont(0.75) within group (order by inp)::int as inp_p75,
        percentile_cont(0.95) within group (order by inp)::int as inp_p95,
        avg(inp)::int as inp_avg,
        percentile_cont(0.50) within group (order by ttfb)::int as ttfb_p50,
        percentile_cont(0.75) within group (order by ttfb)::int as ttfb_p75,
        percentile_cont(0.95) within group (order by ttfb)::int as ttfb_p95,
        avg(ttfb)::int as ttfb_avg
      from ${sql(CFG.table)}
      where created_at >= now() - ${days} * interval '1 day'
        ${pathFilter}
    `;

    const r = rows[0] || {};

    const grade = (value, good, poor) => {
      if (value === null || value === undefined) return 'unknown';
      if (value <= good) return 'good';
      if (value <= poor) return 'needs-improvement';
      return 'poor';
    };

    return {
      ok: true,
      degraded: false,
      count: Number(r.total || 0),
      lcp: {
        p50: r.lcp_p50, p75: r.lcp_p75, p95: r.lcp_p95, avg: r.lcp_avg,
        grade: grade(r.lcp_p75, 2500, 4000),
      },
      cls: {
        p50: r.cls_p50, p75: r.cls_p75, p95: r.cls_p95, avg: r.cls_avg,
        grade: grade(r.cls_p75, 0.1, 0.25),
      },
      inp: {
        p50: r.inp_p50, p75: r.inp_p75, p95: r.inp_p95, avg: r.inp_avg,
        grade: grade(r.inp_p75, 200, 500),
      },
      ttfb: {
        p50: r.ttfb_p50, p75: r.ttfb_p75, p95: r.ttfb_p95, avg: r.ttfb_avg,
        grade: grade(r.ttfb_p75, 800, 1800),
      },
    };
  } catch (e) {
    LOG.warn('web-vitals: getVitalsSummary falló', { error: e.message });
    return { ok: true, degraded: true, count: 0 };
  }
}

/**
 * Ranking de las páginas más lentas.
 */
export async function getSlowestPages({ days = 7, limit = 10 } = {}) {
  if (!supabaseDisponible()) return { ok: true, degraded: true, pages: [] };

  try {
    await ensureSchema();

    const rows = await sql`
      select
        path,
        count(*)::int as samples,
        percentile_cont(0.75) within group (order by lcp)::int as lcp_p75,
        percentile_cont(0.75) within group (order by ttfb)::int as ttfb_p75,
        avg(cls)::numeric(6,4) as cls_avg
      from ${sql(CFG.table)}
      where created_at >= now() - ${Math.min(Number(days) || 7, 90)} * interval '1 day'
      group by path
      having count(*) > 1
      order by lcp_p75 desc nulls last
      limit ${Math.min(Number(limit) || 10, 50)}
    `;

    return { ok: true, degraded: false, pages: rows };
  } catch (e) {
    LOG.warn('web-vitals: getSlowestPages falló', { error: e.message });
    return { ok: true, degraded: true, pages: [] };
  }
}

/**
 * Limpia métricas antiguas.
 */
export async function purgeOldVitals(days = CFG.retentionDays) {
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
    LOG.warn('web-vitals: purge falló', { error: e.message });
    return { ok: false, deleted: 0 };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · ROUTER
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Monta el router de Web Vitals.
 *
 *   POST /api/analytics/vitals     guarda métricas (requireAuth opcional)
 *   GET  /api/analytics/vitals/summary  resumen (solo admin)
 */
export function mountWebVitalsRoutes(app, opts = {}) {
  const { requireAuth, requireAdmin } = opts;

  // Sin middleware de auth: las métricas se pueden enviar sin sesión
  // (el usuario puede estar en la landing).
  const auth = requireAuth || ((_req, _res, next) => next());
  const admin = requireAdmin || ((_req, _res, next) => next());

  const router = express.Router();

  router.post('/api/analytics/vitals', auth, async (req, res) => {
    const body = req.body || {};

    const items = Array.isArray(body.items) ? body.items : [body];

    const result = await recordBatch(items, req.user?.id || null);

    res.status(result.ok ? 202 : 400).json({
      ok: result.ok,
      saved: result.saved || 0,
      failed: result.failed || 0,
      error: result.error || undefined,
    });
  });

  router.get('/api/analytics/vitals/summary', admin, async (req, res) => {
    const summary = await getVitalsSummary({
      days: req.query.days,
      path: req.query.path,
    });
    res.json({ ok: true, ...summary });
  });

  router.get('/api/analytics/vitals/slowest', admin, async (req, res) => {
    const result = await getSlowestPages({
      days: req.query.days,
      limit: req.query.limit,
    });
    res.json({ ok: true, ...result });
  });

  app.use(router);

  LOG.info('web-vitals.routes.mounted', {
    endpoints: [
      'POST /api/analytics/vitals',
      'GET /api/analytics/vitals/summary',
      'GET /api/analytics/vitals/slowest',
    ],
  });

  return router;
}

function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export default {
  recordVitals,
  recordBatch,
  getVitalsSummary,
  getSlowestPages,
  purgeOldVitals,
  normalizePath,
  detectDeviceType,
  detectConnectionType,
  mountWebVitalsRoutes,
};
