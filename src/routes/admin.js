/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/admin.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   API del panel de administración.

   MONTADO
     mountAdminRoutes(app) → añade:
       GET    /api/admin/stats      KPIs + serie diaria + salud
       GET    /api/admin/users      página de usuarios (filtros + búsqueda)
       PATCH  /api/admin/users/:id  banear / desbanear / rol / plan
       GET    /api/admin/payments   página de órdenes de pago
       GET    /api/admin/logs       auditoría (paginada, filtrable)

   SEGURIDAD
     · TODOS los endpoints exigen `requireAdmin` (rol admin verificado
       contra la firma del JWT + perfil en BD).
     · `requireAdmin` ya encadena `requireAuth`, así que no hace falta
       repetir el middleware.
     · Las mutaciones quedan registradas en el log de auditoría.
     · Los parámetros se validan y se acotan (page/limit) antes de tocar
       Postgres: nunca se interpolan strings del usuario en el SQL
       (postgres.js usa parámetros preparados).
     · ip-guard ya bloquea CN/RU/KP y aplica rate limit por IP sobre
       /api/admin.
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { asyncHandler, ValidationError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import {
  getAdminStats,
  listAdminUsers,
  listAdminPayments,
  listAdminLogs,
  updateAdminUser,
  recordAdminAction,
  getAdminQueryStats,
} from '../services/admin-queries.js';

/* ─── Helpers de validación ───────────────────────────────────────────────── */

function readInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function clientIp(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

function readString(value, max = 120) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

/* ═══════════════════════════════════════════════════════════════════════════
   ROUTER
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountAdminRoutes(app) {
  const router = express.Router();

  /* ─── GET /api/admin/stats ──────────────────────────────────────────── */
  router.get('/api/admin/stats', requireAdmin, asyncHandler(async (req, res) => {
    const days = readInt(req.query.days, 30);
    const stats = await getAdminStats({ days });

    res.json({
      ok: true,
      ...stats,
      queryStats: getAdminQueryStats(),
    });
  }));

  /* ─── GET /api/admin/users ──────────────────────────────────────────── */
  router.get('/api/admin/users', requireAdmin, asyncHandler(async (req, res) => {
    const result = await listAdminUsers({
      page: readInt(req.query.page, 1),
      limit: readInt(req.query.limit, 20),
      q: readString(req.query.q, 80),
      role: readString(req.query.role, 20),
      plan: readString(req.query.plan, 20),
    });

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudieron cargar los usuarios.', 'users');
    }

    res.json(result);
  }));

  /* ─── PATCH /api/admin/users/:id ────────────────────────────────────── */
  router.patch('/api/admin/users/:id', requireAdmin, asyncHandler(async (req, res) => {
    const userId = readString(req.params.id, 64);
    const body = req.body || {};

    const allowed = new Set(['action', 'role', 'plan', 'suspended']);
    const patch = {};
    for (const key of Object.keys(body)) {
      if (allowed.has(key)) patch[key] = body[key];
    }

    if (!Object.keys(patch).length) {
      throw new ValidationError('No se envió ningún cambio válido.', 'body');
    }

    if (userId === req.user?.id && (patch.action === 'toggle_ban' || patch.suspended === true)) {
      throw new ValidationError('No podés suspender tu propia cuenta.', 'id');
    }

    const result = await updateAdminUser(userId, patch);

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudo actualizar el usuario.', 'user');
    }

    await recordAdminAction({
      action: `user.${patch.action || 'update'}`,
      level: 'info',
      detail: `target=${userId} · ${Object.keys(patch).join(',')}`,
      userId: req.user?.id || null,
      ip: clientIp(req),
      meta: { target: userId, patch },
    });

    res.json({ ok: true, user: result.user, degraded: Boolean(result.degraded) });
  }));

  /* ─── GET /api/admin/payments ───────────────────────────────────────── */
  router.get('/api/admin/payments', requireAdmin, asyncHandler(async (req, res) => {
    const result = await listAdminPayments({
      page: readInt(req.query.page, 1),
      limit: readInt(req.query.limit, 20),
      status: readString(req.query.status, 30),
    });

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudieron cargar los pagos.', 'payments');
    }

    res.json(result);
  }));

  /* ─── GET /api/admin/logs ───────────────────────────────────────────── */
  router.get('/api/admin/logs', requireAdmin, asyncHandler(async (req, res) => {
    const result = await listAdminLogs({
      page: readInt(req.query.page, 1),
      limit: readInt(req.query.limit, 20),
      level: readString(req.query.level, 20),
    });

    res.json(result);
  }));

  /* ─── GET /api/admin/health (diagnóstico rápido) ────────────────────── */
  router.get('/api/admin/health', requireAdmin, asyncHandler(async (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
      ok: true,
      uptime: Math.floor(process.uptime()),
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      },
      node: process.version,
      queries: getAdminQueryStats(),
      ts: new Date().toISOString(),
    });
  }));

  app.use(router);

  LOG.info('admin.routes.mounted', {
    endpoints: [
      'GET /api/admin/stats',
      'GET /api/admin/users',
      'PATCH /api/admin/users/:id',
      'GET /api/admin/payments',
      'GET /api/admin/logs',
      'GET /api/admin/health',
    ],
  });

  return router;
}

export default { mountAdminRoutes };
