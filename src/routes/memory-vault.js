/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/memory-vault.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   "Caja fuerte" de la memoria: lo que la IA recuerda del usuario.

   MONTADO
     mountMemoryVaultRoutes(app) → añade:
       GET    /api/memory          lista los recuerdos del usuario
       GET    /api/memory/stats    estadísticas (cuántos, categorías…)
       POST   /api/memory          crea un recuerdo manual
       DELETE /api/memory/:id      borra un recuerdo puntual
       DELETE /api/memory          borra todos (derecho al olvido)
       POST   /api/memory/:id/pin  fija / desfija un recuerdo

   DÓNDE VIVEN LOS RECUERDOS
   Tabla "Memory" (ya existe en el esquema de Numination):
     id, "userId", content, type, category, importance, tags, meta, …

   AISLAMIENTO
   Todas las consultas filtran por `"userId"`. Un recuerdo ajeno no se
   lista, no se lee y no se borra: el DELETE incluye el filtro de
   usuario en el WHERE, no como verificación posterior.
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import { sql, supabaseDisponible } from '../services/supabase.js';

const MEMORY_TABLE = 'Memory';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MAX_CONTENT_CHARS = 2000;

/* ═══════════════════════════════════════════════════════════════════════════
   01 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * El id de "Memory" es TEXT (no uuid). Validamos el formato UUID porque
 * es el que genera el resto del sistema, pero la comparación en SQL se
 * hace sobre texto: castear a uuid rompería si algún registro antiguo
 * usara otro formato.
 */
function isUuid(v) {
  return UUID_RE.test(String(v || ''));
}

function readInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Tipos válidos en la tabla "Memory".
 * La base tiene un trigger (`validate_memory_type`) que rechaza
 * cualquier valor fuera de esta lista, así que el mapeo se hace ANTES
 * de escribir: "manual" → "USER" (un recuerdo que el usuario creó a
 * mano), "system" → "SYSTEM", etc.
 */
const MEMORY_TYPES = Object.freeze(['PROJECT', 'USER', 'SYSTEM', 'MEMORY']);

function normalizeType(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (MEMORY_TYPES.includes(raw)) return raw;
  if (raw === 'MANUAL' || raw === 'FACT' || raw === 'NOTE' || raw === 'PREFERENCE') return 'USER';
  if (raw === 'CHAT' || raw === 'CONVERSATION') return 'MEMORY';
  return 'USER';
}

/**
 * `relevance` es un INTEGER en la base (escala 0-100).
 * La API expone `importance` en escala 0-1, que es lo que entiende el
 * resto del producto (y el front).
 */
function toRelevance(value, fallback = 70) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const scaled = n > 1 ? n : n * 100;
  return Math.max(0, Math.min(100, Math.round(scaled)));
}

function shape(row) {
  if (!row) return null;
  const relevance = Number(row.relevance ?? 70);
  return {
    id: row.id,
    content: row.content,
    type: row.type || 'USER',
    category: row.category || 'other',
    importance: Number((relevance / 100).toFixed(2)),
    relevance,
    tags: Array.isArray(row.tags) ? row.tags : (row.tags ? [row.tags] : []),
    pinned: Boolean(row.pinned),
    source: row.source || null,
    meta: row.metadata || {},
    accessCount: Number(row.useCount ?? 0),
    lastAccessedAt: row.lastUsedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · RUTAS
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountMemoryVaultRoutes(app) {
  const router = express.Router();

  /* ─── GET /api/memory ───────────────────────────────────────────────── */
  router.get('/api/memory', requireAuth, asyncHandler(async (req, res) => {
    const limit = Math.min(readInt(req.query.limit, 100), 300);
    const offset = Math.max(0, readInt(req.query.offset, 1) - 1);
    const category = String(req.query.category || '').trim().slice(0, 40);

    if (!supabaseDisponible()) {
      return res.json({
        ok: true,
        degraded: true,
        memories: [],
        total: 0,
        limit,
        offset,
      });
    }

    try {
      const filter = category
        ? sql`and coalesce(category, 'other') = ${category}`
        : sql``;

      const [rows, countRows] = await Promise.all([
        sql`
          select
            id,
            content,
            type,
            coalesce(category, 'other') as category,
            coalesce(relevance, 0.5) as relevance,
            tags,
            coalesce(pinned, false) as pinned,
            source,
            metadata,
            coalesce("useCount", 0) as "useCount",
            "lastUsedAt",
            "createdAt",
            "updatedAt"
          from ${sql(MEMORY_TABLE)}
          where "userId" = ${req.user.id}::uuid
          ${filter}
          order by coalesce(relevance, 0.5) desc, "createdAt" desc
          limit ${limit} offset ${offset}
        `,
        sql`
          select count(*)::int as total
          from ${sql(MEMORY_TABLE)}
          where "userId" = ${req.user.id}::uuid
          ${filter}
        `,
      ]);

      res.json({
        ok: true,
        degraded: false,
        memories: rows.map(shape),
        total: Number(countRows[0]?.total || 0),
        limit,
        offset,
      });
    } catch (e) {
      LOG.error('memory-vault: list falló', { error: e.message, code: e.code });
      throw new ValidationError('No se pudieron cargar tus recuerdos.', 'memory');
    }
  }));

  /* ─── GET /api/memory/stats ─────────────────────────────────────────── */
  router.get('/api/memory/stats', requireAuth, asyncHandler(async (req, res) => {
    if (!supabaseDisponible()) {
      return res.json({ ok: true, degraded: true, total: 0, byCategory: [], byType: [] });
    }

    try {
      const [catRows, typeRows, totalRows] = await Promise.all([
        sql`
          select coalesce(category, 'other') as category, count(*)::int as count
          from ${sql(MEMORY_TABLE)}
          where "userId" = ${req.user.id}::uuid
          group by 1
          order by 2 desc
        `,
        sql`
          select coalesce(type, 'fact') as type, count(*)::int as count
          from ${sql(MEMORY_TABLE)}
          where "userId" = ${req.user.id}::uuid
          group by 1
          order by 2 desc
        `,
        sql`
          select count(*)::int as total,
                 coalesce(sum(relevance), 0)::numeric as importance
          from ${sql(MEMORY_TABLE)}
          where "userId" = ${req.user.id}::uuid
        `,
      ]);

      res.json({
        ok: true,
        degraded: false,
        total: Number(totalRows[0]?.total || 0),
        importance: Number(totalRows[0]?.importance || 0),
        byCategory: catRows,
        byType: typeRows,
      });
    } catch (e) {
      LOG.warn('memory-vault: stats falló', { error: e.message });
      res.json({ ok: true, degraded: true, total: 0, byCategory: [], byType: [] });
    }
  }));

  /* ─── POST /api/memory ──────────────────────────────────────────────── */
  router.post('/api/memory', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const content = String(body.content || body.text || '').trim();

    if (!content) {
      throw new ValidationError('El recuerdo está vacío.', 'content');
    }
    if (content.length > MAX_CONTENT_CHARS) {
      throw new ValidationError(`El recuerdo supera los ${MAX_CONTENT_CHARS} caracteres.`, 'content');
    }
    if (!supabaseDisponible()) {
      throw new ValidationError('La memoria no está disponible en este entorno.', 'memory');
    }

    // "title" es NOT NULL en la base: se usa el del body o se deriva
    // del contenido (recortado) para no romper el insert.
    const title = String(body.title || content).replace(/\s+/g, ' ').trim().slice(0, 120) || 'Recuerdo';

    try {
      const rows = await sql`
        insert into ${sql(MEMORY_TABLE)} (
          "userId", title, content, type, category, relevance, tags, pinned,
          source, metadata, "createdAt", "updatedAt"
        ) values (
          ${req.user.id}::uuid,
          ${title},
          ${content},
          ${normalizeType(body.type)},
          ${String(body.category || 'general').slice(0, 40)},
          ${toRelevance(body.importance, 70)},
          ${sql.array(Array.isArray(body.tags) ? body.tags.slice(0, 12).map((t) => String(t).slice(0, 40)) : [])},
          ${Boolean(body.pinned)},
          'manual',
          ${sql.json({ source: 'manual', pinned: Boolean(body.pinned) })},
          now(),
          now()
        )
        returning
          id, content, type, coalesce(category,'general') as category,
          coalesce(relevance, 70) as relevance, tags,
          coalesce(pinned, false) as pinned, source, metadata,
          coalesce("useCount", 0) as "useCount", "lastUsedAt",
          "createdAt", "updatedAt"
      `;

      res.status(201).json({ ok: true, memory: shape(rows[0]) });
    } catch (e) {
      LOG.error('memory-vault: create falló', { error: e.message, code: e.code });
      throw new ValidationError('No se pudo guardar el recuerdo.', 'content');
    }
  }));

  /* ─── DELETE /api/memory/:id ────────────────────────────────────────── */
  router.delete('/api/memory/:id', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de recuerdo inválido.', 'id');
    }
    if (!supabaseDisponible()) {
      return res.json({ ok: true, degraded: true, deleted: true, id });
    }

    try {
      // El filtro de usuario va DENTRO del DELETE: no se borra y luego
      // se verifica. Esto evita la condición de carrera y el borrado
      // accidental de un recuerdo ajeno.
      const rows = await sql`
        delete from ${sql(MEMORY_TABLE)}
        where id = ${id}
          and "userId" = ${req.user.id}::uuid
        returning id
      `;

      if (!rows.length) {
        throw new NotFoundError('Ese recuerdo no existe o no te pertenece.');
      }

      LOG.info('memory.deleted', { userId: req.user.id, memoryId: id });

      res.json({ ok: true, deleted: true, id });
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      LOG.error('memory-vault: delete falló', { error: e.message, code: e.code });
      throw new ValidationError('No se pudo borrar el recuerdo.', 'id');
    }
  }));

  /* ─── POST /api/memory/:id/pin ──────────────────────────────────────── */
  router.post('/api/memory/:id/pin', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de recuerdo inválido.', 'id');
    }
    if (!supabaseDisponible()) {
      return res.json({ ok: true, degraded: true, id, pinned: true });
    }

    const pin = req.body?.pinned !== false;

    try {
      const rows = await sql`
        update ${sql(MEMORY_TABLE)}
        set
          pinned = ${pin},
          relevance = case when ${pin} then 95 else coalesce(relevance, 70) end,
          metadata = coalesce(metadata, '{}'::jsonb) || ${sql.json({ pinned: pin })},
          "updatedAt" = now()
        where id = ${id}
          and "userId" = ${req.user.id}::uuid
        returning id
      `;

      if (!rows.length) {
        throw new NotFoundError('Ese recuerdo no existe o no te pertenece.');
      }

      res.json({ ok: true, id, pinned: pin });
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      LOG.error('memory-vault: pin falló', { error: e.message, code: e.code });
      throw new ValidationError('No se pudo actualizar el recuerdo.', 'id');
    }
  }));

  /* ─── DELETE /api/memory (borrar todo) ──────────────────────────────── */
  router.delete('/api/memory', requireAuth, asyncHandler(async (req, res) => {
    if (!supabaseDisponible()) {
      return res.json({ ok: true, degraded: true, deleted: 0 });
    }

    try {
      const rows = await sql`
        delete from ${sql(MEMORY_TABLE)}
        where "userId" = ${req.user.id}::uuid
        returning id
      `;

      LOG.info('memory.cleared', { userId: req.user.id, count: rows.length });

      res.json({ ok: true, deleted: rows.length });
    } catch (e) {
      LOG.error('memory-vault: clear falló', { error: e.message, code: e.code });
      throw new ValidationError('No se pudieron borrar los recuerdos.', 'memory');
    }
  }));

  app.use(router);

  LOG.info('memory-vault.routes.mounted', {
    endpoints: [
      'GET /api/memory',
      'GET /api/memory/stats',
      'POST /api/memory',
      'DELETE /api/memory/:id',
      'POST /api/memory/:id/pin',
      'DELETE /api/memory',
    ],
  });

  return router;
}

export default { mountMemoryVaultRoutes };
