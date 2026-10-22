/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/persona-queries.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Persistencia de las "Personas" (asistentes personalizados del usuario).

   TABLA `personas`
     id             uuid      pk
     user_id        uuid      NOT NULL  ← dueño (aislamiento)
     name           text      NOT NULL  ← "Abogado", "Tutor de física"…
     description    text                ← para qué sirve
     system_prompt  text      NOT NULL  ← instrucciones del asistente
     avatar         text                ← emoji o url
     color          text                ← color de acento en la UI
     temperature    numeric             ← 0..2
     is_default     boolean             ← la que se usa si no se elige otra
     is_active      boolean             ← la seleccionada en este momento
     usage_count    integer             ← veces usada
     created_at / updated_at timestamptz

   AISLAMIENTO (la regla que no se rompe)
   TODAS las consultas filtran por `user_id`. Ni siquiera las de borrado:
   un DELETE sin filtro borraría la persona de otro usuario. Por eso
   `deletePersona` hace `where id = $1 and user_id = $2` y mira el
   `returning` para saber si realmente era suya.

   MODO DEGRADADO
   Sin base de datos, las personas viven en un Map en memoria: la UI
   sigue siendo usable durante el desarrollo y los tests no dependen de
   Postgres.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql, supabaseDisponible } from './supabase.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONSTANTES
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  maxNameChars: 60,
  maxDescriptionChars: 240,
  maxPromptChars: 4000,
  maxPerUser: 30,
  minTemperature: 0,
  maxTemperature: 2,
});

const TABLE = 'personas';

const DEFAULTS = Object.freeze({
  avatar: '🤖',
  color: '#7c5cff',
  temperature: 0.7,
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · ESQUEMA
   ═══════════════════════════════════════════════════════════════════════════ */

let schemaPromise = null;

export async function ensurePersonaSchema() {
  if (!supabaseDisponible()) return { ok: false, reason: 'no_db' };
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    try {
      await sql`
        create table if not exists ${sql(TABLE)} (
          id            uuid primary key default gen_random_uuid(),
          user_id       uuid not null,
          name          text not null,
          description   text,
          system_prompt text not null default '',
          avatar        text not null default '🤖',
          color         text not null default '#7c5cff',
          temperature   numeric(3,2) not null default 0.70,
          is_default    boolean not null default false,
          is_active     boolean not null default false,
          usage_count   integer not null default 0,
          created_at    timestamptz not null default now(),
          updated_at    timestamptz not null default now()
        )
      `;

      await sql`
        create index if not exists personas_user_idx
          on ${sql(TABLE)} (user_id, updated_at desc)
      `;

      // Un solo nombre por usuario (case-insensitive).
      await sql`
        create unique index if not exists personas_user_name_idx
          on ${sql(TABLE)} (user_id, lower(name))
      `;

      // Índice parcial: la persona activa por usuario.
      await sql`
        create unique index if not exists personas_active_idx
          on ${sql(TABLE)} (user_id)
          where is_active = true
      `;

      return { ok: true };
    } catch (e) {
      LOG.warn('persona-queries: no se pudo crear el esquema', { error: e.message, code: e.code });
      return { ok: false, reason: e.code || 'schema_error' };
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · MEMORIA EN RAMA (modo degradado)
   ═══════════════════════════════════════════════════════════════════════════ */

/** userId → Map(personaId → persona) */
const MEM = new Map();

function memBucket(userId) {
  if (!MEM.has(userId)) MEM.set(userId, new Map());
  return MEM.get(userId);
}

function memList(userId) {
  return Array.from(memBucket(userId).values()).sort(
    (a, b) => (b.is_active - a.is_active) || (b.is_default - a.is_default) ||
      String(a.name).localeCompare(String(b.name))
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · NORMALIZACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function cleanText(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

/**
 * Normaliza y valida los datos de una persona.
 * @returns {{ok:boolean, data?:object, error?:string, field?:string}}
 */
export function normalizePersona(input = {}) {
  const name = cleanText(input.name, CFG.maxNameChars);
  if (!name) {
    return { ok: false, error: 'Poné un nombre para la persona.', field: 'name' };
  }
  if (name.length < 2) {
    return { ok: false, error: 'El nombre es demasiado corto.', field: 'name' };
  }

  const description = cleanText(input.description, CFG.maxDescriptionChars);
  const systemPrompt = cleanText(input.systemPrompt ?? input.system_prompt, CFG.maxPromptChars);
  const avatar = cleanText(input.avatar, 8) || DEFAULTS.avatar;

  let color = cleanText(input.color, 9) || DEFAULTS.color;
  if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) color = DEFAULTS.color;

  let temperature = Number(input.temperature);
  if (!Number.isFinite(temperature)) temperature = DEFAULTS.temperature;
  temperature = Math.max(CFG.minTemperature, Math.min(CFG.maxTemperature, temperature));

  return {
    ok: true,
    data: {
      name,
      description,
      systemPrompt,
      avatar,
      color,
      temperature: Number(temperature.toFixed(2)),
      isDefault: Boolean(input.isDefault ?? input.is_default),
    },
  };
}

function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id ?? row.userId ?? null,
    name: row.name,
    description: row.description || '',
    systemPrompt: row.system_prompt ?? row.systemPrompt ?? '',
    avatar: row.avatar || DEFAULTS.avatar,
    color: row.color || DEFAULTS.color,
    temperature: Number(row.temperature ?? DEFAULTS.temperature),
    isDefault: Boolean(row.is_default ?? row.isDefault),
    isActive: Boolean(row.is_active ?? row.isActive),
    usageCount: Number(row.usage_count ?? row.usageCount ?? 0),
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · OPERACIONES
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Lista las personas del usuario.
 * La persona activa va primero.
 */
export async function listPersonas(userId) {
  if (!userId) return { ok: false, error: 'Se requiere userId.' };

  if (!supabaseDisponible()) {
    return { ok: true, degraded: true, personas: memList(userId) };
  }

  try {
    await ensurePersonaSchema();
    const rows = await sql`
      select
        id::text as id,
        user_id::text as user_id,
        name,
        description,
        system_prompt,
        avatar,
        color,
        temperature,
        is_default,
        is_active,
        usage_count,
        created_at,
        updated_at
      from ${sql(TABLE)}
      where user_id = ${userId}::uuid
      order by is_active desc, is_default desc, lower(name) asc
    `;
    return { ok: true, degraded: false, personas: rows.map(shape) };
  } catch (e) {
    LOG.error('persona-queries: listPersonas falló', { error: e.message, code: e.code });
    return { ok: false, error: 'No se pudieron cargar tus personas.', personas: [] };
  }
}

/**
 * Obtiene una persona concreta del usuario.
 * Devuelve null si no existe O si es de otro usuario (mismo resultado
 * para no filtrar información por fuerza bruta).
 */
export async function getPersona(userId, personaId) {
  if (!userId || !isUuid(personaId)) return null;

  if (!supabaseDisponible()) {
    const persona = memBucket(userId).get(personaId);
    return persona ? { ...persona } : null;
  }

  try {
    await ensurePersonaSchema();
    const rows = await sql`
      select
        id::text as id,
        user_id::text as user_id,
        name,
        description,
        system_prompt,
        avatar,
        color,
        temperature,
        is_default,
        is_active,
        usage_count,
        created_at,
        updated_at
      from ${sql(TABLE)}
      where id = ${personaId}::uuid
        and user_id = ${userId}::uuid
      limit 1
    `;
    return rows.length ? shape(rows[0]) : null;
  } catch (e) {
    LOG.warn('persona-queries: getPersona falló', { error: e.message });
    return null;
  }
}

/**
 * Crea una persona.
 */
export async function createPersona(userId, input) {
  const norm = normalizePersona(input);
  if (!norm.ok) return { ok: false, error: norm.error, field: norm.field };
  if (!userId) return { ok: false, error: 'Se requiere userId.' };

  const data = norm.data;

  if (!supabaseDisponible()) {
    const existing = memList(userId);
    if (existing.length >= CFG.maxPerUser) {
      return { ok: false, error: `Llegaste al máximo de ${CFG.maxPerUser} personas.` };
    }
    if (existing.some((p) => p.name.toLowerCase() === data.name.toLowerCase())) {
      return { ok: false, error: 'Ya tenés una persona con ese nombre.', field: 'name' };
    }

    const id = crypto.randomUUID();
    const persona = {
      id,
      userId,
      ...data,
      isActive: false,
      usageCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (data.isDefault) {
      memBucket(userId).forEach((p) => { p.isDefault = false; });
    }

    memBucket(userId).set(id, persona);
    return { ok: true, degraded: true, persona: { ...persona } };
  }

  try {
    await ensurePersonaSchema();

    const countRows = await sql`
      select count(*)::int as total from ${sql(TABLE)} where user_id = ${userId}::uuid
    `;
    if (Number(countRows[0]?.total || 0) >= CFG.maxPerUser) {
      return { ok: false, error: `Llegaste al máximo de ${CFG.maxPerUser} personas.` };
    }

    if (data.isDefault) {
      await sql`
        update ${sql(TABLE)} set is_default = false, updated_at = now()
        where user_id = ${userId}::uuid and is_default = true
      `;
    }

    const rows = await sql`
      insert into ${sql(TABLE)} (
        user_id, name, description, system_prompt, avatar, color,
        temperature, is_default, is_active
      ) values (
        ${userId}::uuid,
        ${data.name},
        ${data.description || null},
        ${data.systemPrompt},
        ${data.avatar},
        ${data.color},
        ${data.temperature},
        ${data.isDefault},
        false
      )
      returning
        id::text as id, user_id::text as user_id, name, description,
        system_prompt, avatar, color, temperature, is_default, is_active,
        usage_count, created_at, updated_at
    `;

    return { ok: true, degraded: false, persona: shape(rows[0]) };
  } catch (e) {
    if (e.code === '23505') {
      return { ok: false, error: 'Ya tenés una persona con ese nombre.', field: 'name' };
    }
    LOG.error('persona-queries: createPersona falló', { error: e.message, code: e.code });
    return { ok: false, error: 'No se pudo crear la persona.' };
  }
}

/**
 * Actualiza una persona (sólo las del usuario).
 */
export async function updatePersona(userId, personaId, patch = {}) {
  if (!userId || !isUuid(personaId)) {
    return { ok: false, error: 'Identificador inválido.' };
  }

  if (!supabaseDisponible()) {
    const persona = memBucket(userId).get(personaId);
    if (!persona) return { ok: false, error: 'No se encontró esa persona.' };

    const merged = normalizePersona({
      name: patch.name ?? persona.name,
      description: patch.description ?? persona.description,
      systemPrompt: patch.systemPrompt ?? patch.system_prompt ?? persona.systemPrompt,
      avatar: patch.avatar ?? persona.avatar,
      color: patch.color ?? persona.color,
      temperature: patch.temperature ?? persona.temperature,
      isDefault: patch.isDefault ?? patch.is_default ?? persona.isDefault,
    });

    if (!merged.ok) return { ok: false, error: merged.error, field: merged.field };

    if (merged.data.isDefault) {
      memBucket(userId).forEach((p) => { p.isDefault = false; });
    }

    Object.assign(persona, merged.data, { updatedAt: new Date().toISOString() });
    return { ok: true, degraded: true, persona: { ...persona } };
  }

  try {
    await ensurePersonaSchema();

    const sets = [];
    const values = {};

    if (patch.name !== undefined) {
      const norm = normalizePersona({ name: patch.name });
      if (!norm.ok) return { ok: false, error: norm.error, field: norm.field };
      sets.push(sql`name = ${norm.data.name}`);
    }
    if (patch.description !== undefined) {
      sets.push(sql`description = ${cleanText(patch.description, CFG.maxDescriptionChars) || null}`);
    }
    if (patch.systemPrompt !== undefined || patch.system_prompt !== undefined) {
      sets.push(sql`system_prompt = ${cleanText(patch.systemPrompt ?? patch.system_prompt, CFG.maxPromptChars)}`);
    }
    if (patch.avatar !== undefined) {
      sets.push(sql`avatar = ${cleanText(patch.avatar, 8) || DEFAULTS.avatar}`);
    }
    if (patch.color !== undefined) {
      let color = cleanText(patch.color, 9) || DEFAULTS.color;
      if (!/^#[0-9a-fA-F]{3,8}$/.test(color)) color = DEFAULTS.color;
      sets.push(sql`color = ${color}`);
    }
    if (patch.temperature !== undefined) {
      let t = Number(patch.temperature);
      if (!Number.isFinite(t)) t = DEFAULTS.temperature;
      t = Math.max(CFG.minTemperature, Math.min(CFG.maxTemperature, t));
      sets.push(sql`temperature = ${Number(t.toFixed(2))}`);
    }
    if (patch.isDefault !== undefined || patch.is_default !== undefined) {
      const isDefault = Boolean(patch.isDefault ?? patch.is_default);
      if (isDefault) {
        await sql`
          update ${sql(TABLE)} set is_default = false, updated_at = now()
          where user_id = ${userId}::uuid and is_default = true
        `;
      }
      sets.push(sql`is_default = ${isDefault}`);
    }

    if (!sets.length) {
      return { ok: false, error: 'No hay cambios válidos que aplicar.' };
    }

    const rows = await sql`
      update ${sql(TABLE)}
      set ${sets.reduce((acc, cur, i) => (i === 0 ? cur : sql`${acc}, ${cur}`))}, updated_at = now()
      where id = ${personaId}::uuid
        and user_id = ${userId}::uuid
      returning
        id::text as id, user_id::text as user_id, name, description,
        system_prompt, avatar, color, temperature, is_default, is_active,
        usage_count, created_at, updated_at
    `;

    if (!rows.length) {
      return { ok: false, error: 'No se encontró esa persona.' };
    }

    return { ok: true, degraded: false, persona: shape(rows[0]) };
  } catch (e) {
    if (e.code === '23505') {
      return { ok: false, error: 'Ya tenés una persona con ese nombre.', field: 'name' };
    }
    LOG.error('persona-queries: updatePersona falló', { error: e.message, code: e.code });
    return { ok: false, error: 'No se pudo actualizar la persona.' };
  }
}

/**
 * Elimina una persona del usuario.
 */
export async function deletePersona(userId, personaId) {
  if (!userId || !isUuid(personaId)) {
    return { ok: false, error: 'Identificador inválido.' };
  }

  if (!supabaseDisponible()) {
    const removed = memBucket(userId).delete(personaId);
    return { ok: removed, degraded: true, deleted: removed };
  }

  try {
    await ensurePersonaSchema();
    const rows = await sql`
      delete from ${sql(TABLE)}
      where id = ${personaId}::uuid
        and user_id = ${userId}::uuid
      returning id::text as id
    `;
    return { ok: true, degraded: false, deleted: rows.length > 0 };
  } catch (e) {
    LOG.error('persona-queries: deletePersona falló', { error: e.message, code: e.code });
    return { ok: false, error: 'No se pudo eliminar la persona.' };
  }
}

/**
 * Activa una persona (desactiva las demás del usuario).
 * El índice parcial `personas_active_idx` garantiza una sola activa.
 */
export async function setActivePersona(userId, personaId) {
  if (!userId) return { ok: false, error: 'Se requiere userId.' };

  // "null" = volver al modo por defecto (sin persona activa).
  if (!personaId || personaId === 'none' || personaId === 'null') {
    if (!supabaseDisponible()) {
      memBucket(userId).forEach((p) => { p.isActive = false; });
      return { ok: true, degraded: true, persona: null };
    }
    try {
      await ensurePersonaSchema();
      await sql`
        update ${sql(TABLE)} set is_active = false, updated_at = now()
        where user_id = ${userId}::uuid and is_active = true
      `;
      return { ok: true, degraded: false, persona: null };
    } catch (e) {
      LOG.warn('persona-queries: setActivePersona (reset) falló', { error: e.message });
      return { ok: false, error: 'No se pudo desactivar la persona.' };
    }
  }

  if (!isUuid(personaId)) return { ok: false, error: 'Identificador inválido.' };

  if (!supabaseDisponible()) {
    const bucket = memBucket(userId);
    if (!bucket.has(personaId)) return { ok: false, error: 'No se encontró esa persona.' };
    bucket.forEach((p) => { p.isActive = false; });
    const persona = bucket.get(personaId);
    persona.isActive = true;
    persona.usageCount = (persona.usageCount || 0) + 1;
    persona.updatedAt = new Date().toISOString();
    return { ok: true, degraded: true, persona: { ...persona } };
  }

  try {
    await ensurePersonaSchema();

    await sql`
      update ${sql(TABLE)} set is_active = false, updated_at = now()
      where user_id = ${userId}::uuid and is_active = true
    `;

    const rows = await sql`
      update ${sql(TABLE)}
      set is_active = true, usage_count = usage_count + 1, updated_at = now()
      where id = ${personaId}::uuid and user_id = ${userId}::uuid
      returning
        id::text as id, user_id::text as user_id, name, description,
        system_prompt, avatar, color, temperature, is_default, is_active,
        usage_count, created_at, updated_at
    `;

    if (!rows.length) return { ok: false, error: 'No se encontró esa persona.' };
    return { ok: true, degraded: false, persona: shape(rows[0]) };
  } catch (e) {
    LOG.error('persona-queries: setActivePersona falló', { error: e.message, code: e.code });
    return { ok: false, error: 'No se pudo activar la persona.' };
  }
}

/**
 * Devuelve la persona activa (o la default) del usuario.
 */
export async function getActivePersona(userId) {
  const { personas } = await listPersonas(userId);
  if (!Array.isArray(personas) || !personas.length) return null;
  return personas.find((p) => p.isActive) || personas.find((p) => p.isDefault) || null;
}

export function getPersonaLimits() {
  return {
    maxPerUser: CFG.maxPerUser,
    maxNameChars: CFG.maxNameChars,
    maxPromptChars: CFG.maxPromptChars,
    maxDescriptionChars: CFG.maxDescriptionChars,
  };
}

export default {
  listPersonas,
  getPersona,
  createPersona,
  updatePersona,
  deletePersona,
  setActivePersona,
  getActivePersona,
  normalizePersona,
  ensurePersonaSchema,
  getPersonaLimits,
};
