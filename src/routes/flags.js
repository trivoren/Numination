/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/flags.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   API de banderas de funcionalidad.

   MONTADO
     mountFlagRoutes(app) → añade:
       GET   /api/flags            mapa de banderas activas (para el frontend)
       GET   /api/flags/registry   catálogo de banderas disponibles
       GET   /api/admin/flags      detalle completo (admin)
       PATCH /api/admin/flags      enciende/apaga (admin)
       POST  /api/admin/flags/reset/:key  vuelve al valor por defecto (admin)

   PERMISOS
     · `/api/flags` → requireAuth: cualquier usuario autenticado puede
       saber qué features tiene activadas (el frontend lo necesita para
       mostrar u ocultar la UI).
     · `/api/admin/flags*` → requireAdmin: sólo el admin modifica.

   El valor de una bandera NO se filtra por rol en la respuesta: cada
   usuario recibe la evaluación para SU contexto (plan y rollout).
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler, ValidationError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import {
  isEnabled,
  getEnabledMap,
  listFlags,
  setFlag,
  resetFlag,
  setRollout,
  getRegistry,
  isKnownFlag,
} from '../services/feature-flags.js';

/* ═══════════════════════════════════════════════════════════════════════════
   RUTAS
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountFlagRoutes(app) {
  const router = express.Router();

  /* ─── GET /api/flags ───────────────────────────────────────────────── */
  router.get('/api/flags', requireAuth, asyncHandler(async (req, res) => {
    const ctx = {
      userId: req.user.id,
      plan: req.user.plan,
      role: req.user.role,
    };

    const map = await getEnabledMap(ctx);

    res.json({
      ok: true,
      flags: map,
      plan: req.user.plan || 'free',
      role: req.user.role,
      ts: new Date().toISOString(),
    });
  }));

  /* ─── GET /api/flags/registry ──────────────────────────────────────── */
  router.get('/api/flags/registry', requireAuth, asyncHandler(async (_req, res) => {
    res.json({ ok: true, registry: getRegistry() });
  }));

  /* ─── GET /api/admin/flags ─────────────────────────────────────────── */
  router.get('/api/admin/flags', requireAdmin, asyncHandler(async (_req, res) => {
    const flags = await listFlags();
    res.json({ ok: true, flags, total: flags.length });
  }));

  /* ─── PATCH /api/admin/flags ──────────────────────────────────────── */
  router.patch('/api/admin/flags', requireAdmin, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const key = String(body.key || body.flag || '').trim();

    if (!key) {
      throw new ValidationError('Falta la bandera a modificar.', 'key');
    }
    if (!isKnownFlag(key)) {
      throw new ValidationError(`La bandera "${key}" no existe.`, 'key');
    }

    // "enabled" puede venir como booleano o como string ("true"/"false").
    let enabled;
    if (typeof body.enabled === 'boolean') {
      enabled = body.enabled;
    } else if (typeof body.enabled === 'string') {
      enabled = body.enabled.toLowerCase() === 'true' || body.enabled === '1';
    } else {
      throw new ValidationError('Mandá "enabled" con true o false.', 'enabled');
    }

    const result = await setFlag(key, enabled, {
      rollout: body.rollout,
      plans: body.plans,
      value: body.value,
      userId: req.user.id,
    });

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudo actualizar la bandera.', 'key');
    }

    res.json({ ok: true, ...result });
  }));

  /* ─── POST /api/admin/flags/rollout ───────────────────────────────── */
  router.post('/api/admin/flags/rollout', requireAdmin, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const key = String(body.key || '').trim();

    if (!key) {
      throw new ValidationError('Falta la bandera.', 'key');
    }
    if (!isKnownFlag(key)) {
      throw new ValidationError(`La bandera "${key}" no existe.`, 'key');
    }

    const rollout = Number(body.rollout);
    if (!Number.isFinite(rollout) || rollout < 0 || rollout > 100) {
      throw new ValidationError('El rollout debe ser un número entre 0 y 100.', 'rollout');
    }

    const result = await setRollout(key, rollout, { userId: req.user.id });

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudo actualizar el rollout.', 'rollout');
    }

    res.json({ ok: true, ...result });
  }));

  /* ─── POST /api/admin/flags/reset/:key ─────────────────────────────── */
  router.post('/api/admin/flags/reset/:key', requireAdmin, asyncHandler(async (req, res) => {
    const key = String(req.params.key || '').trim();

    if (!isKnownFlag(key)) {
      throw new ValidationError(`La bandera "${key}" no existe.`, 'key');
    }

    const result = await resetFlag(key, { userId: req.user.id });

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudo resetear la bandera.', 'key');
    }

    res.json({ ok: true, ...result });
  }));

  /* ─── GET /api/admin/flags/:key ────────────────────────────────────── */
  router.get('/api/admin/flags/:key', requireAdmin, asyncHandler(async (req, res) => {
    const key = String(req.params.key || '').trim();

    if (!isKnownFlag(key)) {
      throw new ValidationError(`La bandera "${key}" no existe.`, 'key');
    }

    const flags = await listFlags();
    const flag = flags.find((f) => f.key === key);

    res.json({ ok: true, flag });
  }));

  app.use(router);

  LOG.info('flags.routes.mounted', {
    endpoints: [
      'GET /api/flags',
      'GET /api/flags/registry',
      'GET /api/admin/flags',
      'PATCH /api/admin/flags',
      'POST /api/admin/flags/rollout',
      'POST /api/admin/flags/reset/:key',
      'GET /api/admin/flags/:key',
    ],
  });

  return router;
}

export default { mountFlagRoutes };
