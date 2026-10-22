/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/personas.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   CRUD de las personas (asistentes personalizados).

   MONTADO
     mountPersonaRoutes(app) → añade:
       GET    /api/personas          lista las personas del usuario
       POST   /api/personas          crea una persona
       GET    /api/personas/active   persona activa (o la default)
       POST   /api/personas/active   activa una persona (o "none")
       GET    /api/personas/:id      una persona concreta
       PATCH  /api/personas/:id      actualiza (PUT también funciona)
       DELETE /api/personas/:id      elimina

   AISLAMIENTO
   Todas las operaciones van contra `user_id` del JWT: un usuario no
   puede leer, modificar ni borrar la persona de otro, aunque conozca
   el UUID. `getPersona` devuelve `null` (no 403) para no revelar que
   el id existe en otra cuenta.
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import {
  listPersonas,
  getPersona,
  createPersona,
  updatePersona,
  deletePersona,
  setActivePersona,
  getActivePersona,
  getPersonaLimits,
} from '../services/persona-queries.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) {
  return UUID_RE.test(String(v || ''));
}

/* ═══════════════════════════════════════════════════════════════════════════
   RUTAS
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountPersonaRoutes(app) {
  const router = express.Router();

  /* ─── GET /api/personas ─────────────────────────────────────────────── */
  router.get('/api/personas', requireAuth, asyncHandler(async (req, res) => {
    const result = await listPersonas(req.user.id);

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudieron cargar tus personas.', 'personas');
    }

    res.json({
      ok: true,
      personas: result.personas,
      degraded: Boolean(result.degraded),
      limits: getPersonaLimits(),
    });
  }));

  /* ─── GET /api/personas/active ──────────────────────────────────────── */
  router.get('/api/personas/active', requireAuth, asyncHandler(async (req, res) => {
    const persona = await getActivePersona(req.user.id);
    res.json({ ok: true, persona, active: Boolean(persona && persona.isActive) });
  }));

  /* ─── POST /api/personas/active ─────────────────────────────────────── */
  router.post('/api/personas/active', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const personaId = body.personaId ?? body.id ?? body.persona_id ?? null;

    const result = await setActivePersona(req.user.id, personaId);

    if (!result.ok) {
      throw new NotFoundError(result.error || 'No se encontró esa persona.');
    }

    res.json({ ok: true, persona: result.persona, degraded: Boolean(result.degraded) });
  }));

  /* ─── POST /api/personas ────────────────────────────────────────────── */
  router.post('/api/personas', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const result = await createPersona(req.user.id, body);

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudo crear la persona.', result.field || 'persona');
    }

    LOG.info('persona.created', { userId: req.user.id, personaId: result.persona.id });

    res.status(201).json({
      ok: true,
      persona: result.persona,
      degraded: Boolean(result.degraded),
    });
  }));

  /* ─── GET /api/personas/:id ─────────────────────────────────────────── */
  router.get('/api/personas/:id', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de persona inválido.', 'id');
    }

    const persona = await getPersona(req.user.id, id);

    if (!persona) {
      throw new NotFoundError('No se encontró esa persona.');
    }

    res.json({ ok: true, persona });
  }));

  /* ─── PATCH|PUT /api/personas/:id ───────────────────────────────────── */
  const handleUpdate = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de persona inválido.', 'id');
    }

    const result = await updatePersona(req.user.id, id, req.body || {});

    if (!result.ok) {
      if (result.error && /no se encontró/i.test(result.error)) {
        throw new NotFoundError(result.error);
      }
      throw new ValidationError(result.error || 'No se pudo actualizar la persona.', result.field || 'persona');
    }

    LOG.info('persona.updated', { userId: req.user.id, personaId: id });

    res.json({ ok: true, persona: result.persona, degraded: Boolean(result.degraded) });
  });

  router.patch('/api/personas/:id', requireAuth, handleUpdate);
  router.put('/api/personas/:id', requireAuth, handleUpdate);

  /* ─── DELETE /api/personas/:id ──────────────────────────────────────── */
  router.delete('/api/personas/:id', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de persona inválido.', 'id');
    }

    const result = await deletePersona(req.user.id, id);

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudo eliminar la persona.', 'id');
    }
    if (!result.deleted) {
      throw new NotFoundError('No se encontró esa persona.');
    }

    LOG.info('persona.deleted', { userId: req.user.id, personaId: id });

    res.json({ ok: true, deleted: true, id });
  }));

  app.use(router);

  LOG.info('persona.routes.mounted', {
    endpoints: [
      'GET /api/personas',
      'POST /api/personas',
      'GET /api/personas/active',
      'POST /api/personas/active',
      'GET /api/personas/:id',
      'PATCH /api/personas/:id',
      'DELETE /api/personas/:id',
    ],
  });

  return router;
}

export default { mountPersonaRoutes };
