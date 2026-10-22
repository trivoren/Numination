/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/notifications.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   API de notificaciones del usuario.

   MONTADO
     mountNotificationRoutes(app) → añade:
       GET    /api/notifications              lista (paginado)
       GET    /api/notifications/unread-count  cantidad de no leídas
       POST   /api/notifications/:id/read     marca una como leída
       POST   /api/notifications/read-all     marca todas como leídas
       DELETE /api/notifications/:id          borra una
       DELETE /api/notifications              borra todas

   AISLAMIENTO
   Todas las operaciones filtran por el userId de la sesión. El cliente
   no puede pedir las notificaciones de otro usuario: el id sale del
   JWT, no de la request.
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import {
  listNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
  getEngineStatus,
} from '../services/notification-engine.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) {
  return UUID_RE.test(String(v || ''));
}

function readInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/* ═══════════════════════════════════════════════════════════════════════════
   RUTAS
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountNotificationRoutes(app) {
  const router = express.Router();

  /* ─── GET /api/notifications ───────────────────────────────────────── */
  router.get('/api/notifications', requireAuth, asyncHandler(async (req, res) => {
    const result = await listNotifications(req.user.id, {
      limit: readInt(req.query.limit, 30),
      offset: readInt(req.query.offset, 1) - 1,
      onlyUnread: req.query.unread === 'true',
    });

    res.json({
      ok: true,
      notifications: result.notifications,
      total: result.total,
      degraded: Boolean(result.degraded),
    });
  }));

  /* ─── GET /api/notifications/unread-count ─────────────────────────── */
  router.get('/api/notifications/unread-count', requireAuth, asyncHandler(async (req, res) => {
    const result = await getUnreadCount(req.user.id);
    res.json({
      ok: true,
      count: result.count,
      degraded: Boolean(result.degraded),
    });
  }));

  /* ─── POST /api/notifications/read-all ─────────────────────────────── */
  router.post('/api/notifications/read-all', requireAuth, asyncHandler(async (req, res) => {
    const result = await markAllRead(req.user.id);
    res.json({ ok: true, count: result.count || 0 });
  }));

  /* ─── POST /api/notifications/:id/read ─────────────────────────────── */
  router.post('/api/notifications/:id/read', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de notificación inválido.', 'id');
    }

    const result = await markRead(req.user.id, id);

    if (!result.ok) {
      if (result.reason === 'not_found') {
        throw new NotFoundError('Esa notificación no existe.');
      }
      throw new ValidationError('No se pudo marcar la notificación como leída.', 'id');
    }

    const unread = await getUnreadCount(req.user.id);

    res.json({ ok: true, notification: result.notification, unread: unread.count });
  }));

  /* ─── DELETE /api/notifications/:id ────────────────────────────────── */
  router.delete('/api/notifications/:id', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de notificación inválido.', 'id');
    }

    const result = await deleteNotification(req.user.id, id);

    if (!result.deleted) {
      throw new NotFoundError('Esa notificación no existe.');
    }

    res.json({ ok: true, deleted: true, id });
  }));

  /* ─── DELETE /api/notifications ───────────────────────────────────── */
  router.delete('/api/notifications', requireAuth, asyncHandler(async (req, res) => {
    const result = await deleteNotification(req.user.id, null);
    res.json({ ok: true, deleted: result.deleted || 0 });
  }));

  /* ─── GET /api/notifications/status ────────────────────────────────── */
  router.get('/api/notifications/status', requireAuth, asyncHandler(async (_req, res) => {
    res.json({ ok: true, status: getEngineStatus() });
  }));

  app.use(router);

  LOG.info('notification.routes.mounted', {
    endpoints: [
      'GET /api/notifications',
      'GET /api/notifications/unread-count',
      'POST /api/notifications/:id/read',
      'POST /api/notifications/read-all',
      'DELETE /api/notifications/:id',
      'DELETE /api/notifications',
    ],
  });

  return router;
}

export default { mountNotificationRoutes };
