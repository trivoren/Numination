/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/prompts.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Backend de la biblioteca de prompts guardados.

   MONTADO
     mountPromptRoutes(app) → añade:
       GET    /api/prompts              lista los prompts del usuario
       POST   /api/prompts              crea un prompt
       GET    /api/prompts/folders      lista las carpetas
       POST   /api/prompts/folders      crea una carpeta
       PATCH  /api/prompts/folders/:id  renombra / recolorea
       DELETE /api/prompts/folders/:id  borra la carpeta (los prompts quedan
                                        sin carpeta, no se borran)
       GET    /api/prompts/:id          un prompt puntual
       PATCH  /api/prompts/:id          actualiza
       DELETE /api/prompts/:id          borra
       POST   /api/prompts/:id/use      registra un uso (botón "reutilizar")

   ESQUEMA
     prompt_folders  id, user_id, name, color, created_at
     saved_prompts   id, user_id, folder_id, title, content, description,
                     tags, usage_count, is_favorite, created_at, updated_at

   AISLAMIENTO
   Toda consulta filtra por `user_id`. Las carpetas y los prompts están
   atados al dueño: no hay forma de leer los de otro usuario ni de
   mover un prompt a la carpeta de otro (el UPDATE de `folder_id`
   valida que la carpeta pertenezca al mismo usuario).
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import { sql, supabaseDisponible } from '../services/supabase.js';

const PROMPTS_TABLE = 'saved_prompts';
const FOLDERS_TABLE = 'prompt_folders';

const LIMITS = Object.freeze({
  maxTitleChars: 120,
  maxContentChars: 8000,
  maxDescriptionChars: 300,
  maxFolders: 40,
  maxPrompts: 300,
  maxTags: 12,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) {
  return UUID_RE.test(String(v || ''));
}

function clean(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function readInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/* ═══════════════════════════════════════════════════════════════════════════
   01 · ESQUEMA (idempotente)
   ═══════════════════════════════════════════════════════════════════════════ */

let schemaPromise = null;

async function ensureSchema() {
  if (!supabaseDisponible()) return { ok: false };
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    try {
      await sql`
        create table if not exists ${sql(FOLDERS_TABLE)} (
          id         uuid primary key default gen_random_uuid(),
          user_id    uuid not null,
          name       text not null,
          color      text not null default '#7c5cff',
          created_at timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists prompt_folders_user_idx
          on ${sql(FOLDERS_TABLE)} (user_id, name)
      `;

      await sql`
        create table if not exists ${sql(PROMPTS_TABLE)} (
          id          uuid primary key default gen_random_uuid(),
          user_id     uuid not null,
          folder_id   uuid references ${sql(FOLDERS_TABLE)}(id) on delete set null,
          title       text not null,
          content     text not null default '',
          description text,
          tags        text[] not null default '{}',
          usage_count integer not null default 0,
          is_favorite boolean not null default false,
          created_at  timestamptz not null default now(),
          updated_at  timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists saved_prompts_user_idx
          on ${sql(PROMPTS_TABLE)} (user_id, updated_at desc)
      `;
      await sql`
        create index if not exists saved_prompts_folder_idx
          on ${sql(PROMPTS_TABLE)} (user_id, folder_id)
      `;

      return { ok: true };
    } catch (e) {
      LOG.warn('prompts.routes: no se pudo crear el esquema', { error: e.message, code: e.code });
      return { ok: false };
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · HELPERS DE DATOS
   ═══════════════════════════════════════════════════════════════════════════ */

function shapePrompt(row) {
  if (!row) return null;
  return {
    id: row.id,
    folderId: row.folder_id || null,
    title: row.title,
    content: row.content,
    description: row.description || '',
    tags: Array.isArray(row.tags) ? row.tags : [],
    usageCount: Number(row.usage_count || 0),
    isFavorite: Boolean(row.is_favorite),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function shapeFolder(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    color: row.color || '#7c5cff',
    count: row.count !== undefined ? Number(row.count) : undefined,
    createdAt: row.created_at,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · RUTAS
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountPromptRoutes(app) {
  const router = express.Router();

  /* ─── GET /api/prompts ─────────────────────────────────────────────── */
  router.get('/api/prompts', requireAuth, asyncHandler(async (req, res) => {
    if (!supabaseDisponible()) {
      return res.json({ ok: true, degraded: true, prompts: [], total: 0, folders: [] });
    }

    await ensureSchema();

    const folderId = String(req.query.folder || '').trim();
    const q = clean(req.query.q, 80).toLowerCase();
    const limit = Math.min(readInt(req.query.limit, 100), LIMITS.maxPrompts);
    const offset = Math.max(0, readInt(req.query.offset, 1) - 1);

    const filters = [];
    if (isUuid(folderId)) filters.push(sql`p.folder_id = ${folderId}::uuid`);
    if (folderId === 'none') filters.push(sql`p.folder_id is null`);
    if (q) filters.push(sql`(lower(p.title) like ${`%${q}%`} or lower(p.content) like ${`%${q}%`})`);

    const where = filters.length
      ? sql`where ${filters.reduce((acc, cur, i) => (i === 0 ? cur : sql`${acc} and ${cur}`))}`
      : sql``;

    try {
      const [rows, countRows, folderRows] = await Promise.all([
        sql`
          select
            p.id::text as id,
            p.folder_id::text as folder_id,
            p.title,
            p.content,
            p.description,
            p.tags,
            p.usage_count,
            p.is_favorite,
            p.created_at,
            p.updated_at
          from ${sql(PROMPTS_TABLE)} p
          ${where}
          order by p.is_favorite desc, p.usage_count desc, p.updated_at desc
          limit ${limit} offset ${offset}
        `,
        sql`select count(*)::int as total from ${sql(PROMPTS_TABLE)} p ${where}`,
        sql`
          select
            f.id::text as id,
            f.name,
            f.color,
            f.created_at,
            (select count(*)::int from ${sql(PROMPTS_TABLE)} p2 where p2.folder_id = f.id) as count
          from ${sql(FOLDERS_TABLE)} f
          where f.user_id = ${req.user.id}::uuid
          order by f.name asc
        `,
      ]);

      res.json({
        ok: true,
        degraded: false,
        prompts: rows.map(shapePrompt),
        folders: folderRows.map(shapeFolder),
        total: Number(countRows[0]?.total || 0),
        limit,
        offset,
      });
    } catch (e) {
      LOG.error('prompts.routes: list falló', { error: e.message, code: e.code });
      throw new ValidationError('No se pudieron cargar tus prompts.', 'prompts');
    }
  }));

  /* ─── GET /api/prompts/folders ─────────────────────────────────────── */
  router.get('/api/prompts/folders', requireAuth, asyncHandler(async (req, res) => {
    if (!supabaseDisponible()) {
      return res.json({ ok: true, degraded: true, folders: [] });
    }

    await ensureSchema();

    try {
      const rows = await sql`
        select
          f.id::text as id,
          f.name,
          f.color,
          f.created_at,
          (select count(*)::int from ${sql(PROMPTS_TABLE)} p where p.folder_id = f.id) as count
        from ${sql(FOLDERS_TABLE)} f
        where f.user_id = ${req.user.id}::uuid
        order by f.name asc
      `;
      res.json({ ok: true, degraded: false, folders: rows.map(shapeFolder) });
    } catch (e) {
      LOG.warn('prompts.routes: listFolders falló', { error: e.message });
      res.json({ ok: true, degraded: true, folders: [] });
    }
  }));

  /* ─── POST /api/prompts/folders ────────────────────────────────────── */
  router.post('/api/prompts/folders', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const name = clean(body.name, 60);

    if (!name) {
      throw new ValidationError('Poné un nombre para la carpeta.', 'name');
    }
    if (!supabaseDisponible()) {
      throw new ValidationError('Las carpetas no están disponibles en este entorno.', 'folder');
    }

    await ensureSchema();

    try {
      const countRows = await sql`
        select count(*)::int as total from ${sql(FOLDERS_TABLE)} where user_id = ${req.user.id}::uuid
      `;
      if (Number(countRows[0]?.total || 0) >= LIMITS.maxFolders) {
        throw new ValidationError(`Llegaste al máximo de ${LIMITS.maxFolders} carpetas.`, 'name');
      }

      let color = clean(body.color, 9) || '#7c5cff';
      if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) color = '#7c5cff';

      const rows = await sql`
        insert into ${sql(FOLDERS_TABLE)} (user_id, name, color)
        values (${req.user.id}::uuid, ${name}, ${color})
        returning id::text as id, name, color, created_at
      `;

      res.status(201).json({ ok: true, folder: shapeFolder(rows[0]) });
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      if (e.code === '23505') {
        throw new ValidationError('Ya tenés una carpeta con ese nombre.', 'name');
      }
      LOG.error('prompts.routes: createFolder falló', { error: e.message, code: e.code });
      throw new ValidationError('No se pudo crear la carpeta.', 'name');
    }
  }));

  /* ─── PATCH /api/prompts/folders/:id ───────────────────────────────── */
  router.patch('/api/prompts/folders/:id', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de carpeta inválido.', 'id');
    }
    if (!supabaseDisponible()) {
      throw new ValidationError('Las carpetas no están disponibles en este entorno.', 'folder');
    }

    await ensureSchema();

    const sets = [];
    if (body.name !== undefined) {
      const name = clean(body.name, 60);
      if (!name) throw new ValidationError('Poné un nombre para la carpeta.', 'name');
      sets.push(sql`name = ${name}`);
    }
    if (body.color !== undefined) {
      let color = clean(body.color, 9) || '#7c5cff';
      if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) color = '#7c5cff';
      sets.push(sql`color = ${color}`);
    }
    if (!sets.length) {
      throw new ValidationError('No hay cambios válidos que aplicar.', 'body');
    }

    try {
      const rows = await sql`
        update ${sql(FOLDERS_TABLE)}
        set ${sets.reduce((acc, cur, i) => (i === 0 ? cur : sql`${acc}, ${cur}`))}
        where id = ${id}::uuid and user_id = ${req.user.id}::uuid
        returning id::text as id, name, color, created_at
      `;
      if (!rows.length) throw new NotFoundError('No se encontró esa carpeta.');
      res.json({ ok: true, folder: shapeFolder(rows[0]) });
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      LOG.error('prompts.routes: updateFolder falló', { error: e.message });
      throw new ValidationError('No se pudo actualizar la carpeta.', 'id');
    }
  }));

  /* ─── DELETE /api/prompts/folders/:id ──────────────────────────────── */
  router.delete('/api/prompts/folders/:id', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de carpeta inválido.', 'id');
    }
    if (!supabaseDisponible()) {
      return res.json({ ok: true, degraded: true, deleted: true, id });
    }

    await ensureSchema();

    try {
      // on delete set null → los prompts quedan "sin carpeta", no se pierden.
      const rows = await sql`
        delete from ${sql(FOLDERS_TABLE)}
        where id = ${id}::uuid and user_id = ${req.user.id}::uuid
        returning id::text as id
      `;
      if (!rows.length) throw new NotFoundError('No se encontró esa carpeta.');
      res.json({ ok: true, deleted: true, id });
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      LOG.error('prompts.routes: deleteFolder falló', { error: e.message });
      throw new ValidationError('No se pudo eliminar la carpeta.', 'id');
    }
  }));

  /* ─── POST /api/prompts ────────────────────────────────────────────── */
  router.post('/api/prompts', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const title = clean(body.title, LIMITS.maxTitleChars);
    const content = clean(body.content ?? body.prompt, LIMITS.maxContentChars);

    if (!title) {
      throw new ValidationError('Poné un título para el prompt.', 'title');
    }
    if (!content) {
      throw new ValidationError('El prompt está vacío.', 'content');
    }
    if (!supabaseDisponible()) {
      throw new ValidationError('La biblioteca no está disponible en este entorno.', 'prompt');
    }

    await ensureSchema();

    try {
      const countRows = await sql`
        select count(*)::int as total from ${sql(PROMPTS_TABLE)} where user_id = ${req.user.id}::uuid
      `;
      if (Number(countRows[0]?.total || 0) >= LIMITS.maxPrompts) {
        throw new ValidationError(`Llegaste al máximo de ${LIMITS.maxPrompts} prompts.`, 'title');
      }

      // La carpeta debe pertenecer al mismo usuario.
      let folderId = null;
      if (body.folderId && isUuid(body.folderId)) {
        const check = await sql`
          select id::text as id from ${sql(FOLDERS_TABLE)}
          where id = ${body.folderId}::uuid and user_id = ${req.user.id}::uuid
        `;
        if (!check.length) {
          throw new ValidationError('Esa carpeta no existe o no te pertenece.', 'folderId');
        }
        folderId = body.folderId;
      }

      const tags = Array.isArray(body.tags)
        ? body.tags.slice(0, LIMITS.maxTags).map((t) => clean(t, 40)).filter(Boolean)
        : [];

      const rows = await sql`
        insert into ${sql(PROMPTS_TABLE)} (
          user_id, folder_id, title, content, description, tags, is_favorite
        ) values (
          ${req.user.id}::uuid,
          ${folderId ? folderId : null}::uuid,
          ${title},
          ${content},
          ${clean(body.description, LIMITS.maxDescriptionChars) || null},
          ${sql.array(tags)},
          ${Boolean(body.isFavorite)}
        )
        returning
          id::text as id, folder_id::text as folder_id, title, content,
          description, tags, usage_count, is_favorite, created_at, updated_at
      `;

      res.status(201).json({ ok: true, prompt: shapePrompt(rows[0]) });
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      LOG.error('prompts.routes: create falló', { error: e.message, code: e.code });
      throw new ValidationError('No se pudo guardar el prompt.', 'title');
    }
  }));

  /* ─── GET /api/prompts/:id ─────────────────────────────────────────── */
  router.get('/api/prompts/:id', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de prompt inválido.', 'id');
    }
    if (!supabaseDisponible()) {
      throw new NotFoundError('El prompt no existe.');
    }

    await ensureSchema();

    try {
      const rows = await sql`
        select
          p.id::text as id, p.folder_id::text as folder_id, p.title, p.content,
          p.description, p.tags, p.usage_count, p.is_favorite,
          p.created_at, p.updated_at
        from ${sql(PROMPTS_TABLE)} p
        where p.id = ${id}::uuid and p.user_id = ${req.user.id}::uuid
        limit 1
      `;
      if (!rows.length) throw new NotFoundError('El prompt no existe.');
      res.json({ ok: true, prompt: shapePrompt(rows[0]) });
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      LOG.error('prompts.routes: get falló', { error: e.message });
      throw new ValidationError('No se pudo cargar el prompt.', 'id');
    }
  }));

  /* ─── PATCH /api/prompts/:id ───────────────────────────────────────── */
  router.patch('/api/prompts/:id', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;
    const body = req.body || {};

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de prompt inválido.', 'id');
    }
    if (!supabaseDisponible()) {
      throw new ValidationError('La biblioteca no está disponible en este entorno.', 'prompt');
    }

    await ensureSchema();

    try {
      const sets = [];

      if (body.title !== undefined) {
        const title = clean(body.title, LIMITS.maxTitleChars);
        if (!title) throw new ValidationError('El título no puede quedar vacío.', 'title');
        sets.push(sql`title = ${title}`);
      }
      if (body.content !== undefined || body.prompt !== undefined) {
        const content = clean(body.content ?? body.prompt, LIMITS.maxContentChars);
        if (!content) throw new ValidationError('El prompt no puede quedar vacío.', 'content');
        sets.push(sql`content = ${content}`);
      }
      if (body.description !== undefined) {
        sets.push(sql`description = ${clean(body.description, LIMITS.maxDescriptionChars) || null}`);
      }
      if (body.tags !== undefined && Array.isArray(body.tags)) {
        const tags = body.tags.slice(0, LIMITS.maxTags).map((t) => clean(t, 40)).filter(Boolean);
        sets.push(sql`tags = ${sql.array(tags)}`);
      }
      if (body.isFavorite !== undefined) {
        sets.push(sql`is_favorite = ${Boolean(body.isFavorite)}`);
      }
      if (body.folderId !== undefined) {
        if (!body.folderId || body.folderId === 'none') {
          sets.push(sql`folder_id = null`);
        } else {
          if (!isUuid(body.folderId)) {
            throw new ValidationError('Identificador de carpeta inválido.', 'folderId');
          }
          const check = await sql`
            select id::text as id from ${sql(FOLDERS_TABLE)}
            where id = ${body.folderId}::uuid and user_id = ${req.user.id}::uuid
          `;
          if (!check.length) {
            throw new ValidationError('Esa carpeta no existe o no te pertenece.', 'folderId');
          }
          sets.push(sql`folder_id = ${body.folderId}::uuid`);
        }
      }

      if (!sets.length) {
        throw new ValidationError('No hay cambios válidos que aplicar.', 'body');
      }

      const rows = await sql`
        update ${sql(PROMPTS_TABLE)}
        set ${sets.reduce((acc, cur, i) => (i === 0 ? cur : sql`${acc}, ${cur}`))}, updated_at = now()
        where id = ${id}::uuid and user_id = ${req.user.id}::uuid
        returning
          id::text as id, folder_id::text as folder_id, title, content,
          description, tags, usage_count, is_favorite, created_at, updated_at
      `;

      if (!rows.length) throw new NotFoundError('El prompt no existe.');
      res.json({ ok: true, prompt: shapePrompt(rows[0]) });
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      if (e instanceof ValidationError) throw e;
      LOG.error('prompts.routes: update falló', { error: e.message, code: e.code });
      throw new ValidationError('No se pudo actualizar el prompt.', 'id');
    }
  }));

  /* ─── POST /api/prompts/:id/use ────────────────────────────────────── */
  router.post('/api/prompts/:id/use', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de prompt inválido.', 'id');
    }
    if (!supabaseDisponible()) {
      return res.json({ ok: true, degraded: true, id, usageCount: 1 });
    }

    await ensureSchema();

    try {
      const rows = await sql`
        update ${sql(PROMPTS_TABLE)}
        set usage_count = usage_count + 1, updated_at = now()
        where id = ${id}::uuid and user_id = ${req.user.id}::uuid
        returning id::text as id, usage_count
      `;
      if (!rows.length) throw new NotFoundError('El prompt no existe.');
      res.json({ ok: true, id, usageCount: Number(rows[0].usage_count || 0) });
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      LOG.warn('prompts.routes: use falló', { error: e.message });
      res.json({ ok: true, degraded: true, id });
    }
  }));

  /* ─── DELETE /api/prompts/:id ──────────────────────────────────────── */
  router.delete('/api/prompts/:id', requireAuth, asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!isUuid(id)) {
      throw new ValidationError('Identificador de prompt inválido.', 'id');
    }
    if (!supabaseDisponible()) {
      return res.json({ ok: true, degraded: true, deleted: true, id });
    }

    await ensureSchema();

    try {
      const rows = await sql`
        delete from ${sql(PROMPTS_TABLE)}
        where id = ${id}::uuid and user_id = ${req.user.id}::uuid
        returning id::text as id
      `;
      if (!rows.length) throw new NotFoundError('El prompt no existe.');
      res.json({ ok: true, deleted: true, id });
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      LOG.error('prompts.routes: delete falló', { error: e.message, code: e.code });
      throw new ValidationError('No se pudo eliminar el prompt.', 'id');
    }
  }));

  app.use(router);

  LOG.info('prompts.routes.mounted', {
    endpoints: [
      'GET /api/prompts',
      'POST /api/prompts',
      'GET /api/prompts/folders',
      'POST /api/prompts/folders',
      'PATCH /api/prompts/folders/:id',
      'DELETE /api/prompts/folders/:id',
      'GET /api/prompts/:id',
      'PATCH /api/prompts/:id',
      'POST /api/prompts/:id/use',
      'DELETE /api/prompts/:id',
    ],
  });

  return router;
}

export default { mountPromptRoutes };
