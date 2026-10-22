/**
 * Numination · Modo Coder — _store.js
 * Capa de persistencia de los archivos del proyecto (Postgres de Supabase).
 *
 * Decisiones de diseño:
 *  - Toda consulta está filtrada por `user_id`: un usuario NUNCA ve archivos de otro.
 *  - La tabla se crea de forma idempotente en el primer arranque en frío
 *    (CREATE TABLE IF NOT EXISTS) y se cachea la promesa para no repetir DDL.
 *  - `upsert` sobre (user_id, filename) ⇒ guardado idempotente: repetir el
 *    mismo guardado no duplica filas ni dispara efectos secundarios.
 */

import { sql, supabaseDisponible } from '../../src/services/supabase.js';

/** Tamaño máximo por archivo (evita filas gigantes y abuso de cuota). */
export const MAX_FILE_BYTES = 256 * 1024;

/** Extensiones de código admitidas en el explorador. */
const ALLOWED_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'css', 'scss', 'less',
  'html', 'htm', 'xml', 'svg', 'md', 'mdx', 'txt', 'yml', 'yaml', 'env',
  'py', 'rb', 'go', 'rs', 'java', 'php', 'sh', 'bash', 'sql', 'toml', 'ini'
]);

/** @type {Promise<void>|null} promesa de creación de tabla (cacheada) */
let tablePromise = null;

/**
 * Valida un UUID (formato de `profiles.id`).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Normaliza y valida una ruta de archivo.
 * Reglas: sin `..`, sin rutas absolutas, sin barras invertidas, sin bytes de control,
 * longitud razonable y extensión permitida (o sin extensión).
 * @param {unknown} filename
 * @returns {{ ok: true, path: string } | { ok: false, error: string }}
 */
export function normalizeFilename(filename) {
  if (typeof filename !== 'string' || !filename.trim()) {
    return { ok: false, error: 'Nombre de archivo vacío.' };
  }
  const raw = filename.trim();

  if (raw.length > 180) return { ok: false, error: 'Ruta demasiado larga (máx. 180 caracteres).' };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F]/.test(raw)) return { ok: false, error: 'Ruta con caracteres de control.' };
  if (raw.includes('\\')) return { ok: false, error: 'Usa "/" como separador de carpetas.' };
  if (raw.startsWith('/')) return { ok: false, error: 'Ruta absoluta no permitida.' };
  if (raw.includes('..')) return { ok: false, error: 'La ruta no puede contener "..".' };
  if (/^[a-zA-Z]:/.test(raw)) return { ok: false, error: 'Ruta de Windows no permitida.' };

  const segments = raw.split('/').filter((s) => s.length > 0);
  if (!segments.length) return { ok: false, error: 'Ruta vacía.' };
  if (segments.some((s) => s === '.' || s === '..')) {
    return { ok: false, error: 'Segmento de ruta inválido.' };
  }
  if (segments.some((s) => /[<>:"|?*]/.test(s))) {
    return { ok: false, error: 'La ruta contiene caracteres no permitidos.' };
  }

  const ext = segments[segments.length - 1].includes('.')
    ? segments[segments.length - 1].split('.').pop().toLowerCase()
    : '';
  if (ext && !ALLOWED_EXT.has(ext)) {
    return { ok: false, error: `Extensión ".${ext}" no permitida en el explorador.` };
  }

  return { ok: true, path: segments.join('/') };
}

/**
 * Crea la tabla si no existe (idempotente, cacheado por cold start).
 * @returns {Promise<void>}
 */
export function ensureTable() {
  if (!supabaseDisponible()) {
    return Promise.reject(new Error('Base de datos no disponible (DATABASE_URL ausente).'));
  }
  if (tablePromise) return tablePromise;

  tablePromise = (async () => {
    try {
      await sql`create extension if not exists pgcrypto`;
    } catch {
      /* la extensión puede no ser creable: gen_random_uuid() suele existir igual */
    }

    try {
      await sql`
        create table if not exists public.coder_files (
          id          uuid primary key default gen_random_uuid(),
          user_id     uuid not null,
          filename    text not null,
          content     text not null default '',
          language    text,
          size_bytes  integer not null default 0,
          created_at  timestamptz not null default now(),
          updated_at  timestamptz not null default now(),
          unique (user_id, filename)
        )
      `;
    } catch (err) {
      // Reintento sin FK por si `public.profiles` no está en este proyecto
      await sql`
        create table if not exists public.coder_files (
          id          uuid primary key default gen_random_uuid(),
          user_id     uuid not null,
          filename    text not null,
          content     text not null default '',
          language    text,
          size_bytes  integer not null default 0,
          created_at  timestamptz not null default now(),
          updated_at  timestamptz not null default now(),
          unique (user_id, filename)
        )
      `;
    }

    await sql`
      create index if not exists coder_files_user_updated_idx
      on public.coder_files (user_id, updated_at desc)
    `;
  })().catch((err) => {
    tablePromise = null; // permite reintento en el próximo request
    throw err;
  });

  return tablePromise;
}

/**
 * Lista los archivos de un usuario (ruta, lenguaje, tamaño y fecha).
 * @param {string} userId UUID del usuario autenticado.
 * @returns {Promise<Array<{path:string, language:string|null, size:number, updatedAt:string}>>}
 */
export async function listFiles(userId) {
  if (!isUuid(userId)) throw new Error('Identificador de usuario inválido.');
  await ensureTable();
  const rows = await sql`
    select filename, language, size_bytes, updated_at
    from public.coder_files
    where user_id = ${userId}::uuid
    order by filename asc
    limit 500
  `;
  return rows.map((r) => ({
    path: r.filename,
    language: r.language || null,
    size: Number(r.size_bytes || 0),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null
  }));
}

/**
 * Lee un archivo concreto del usuario.
 * @param {string} userId
 * @param {string} filename Ruta normalizada.
 * @returns {Promise<{path:string, content:string, language:string|null, updatedAt:string|null}|null>}
 */
export async function getFile(userId, filename) {
  if (!isUuid(userId)) throw new Error('Identificador de usuario inválido.');
  await ensureTable();
  const rows = await sql`
    select filename, content, language, updated_at
    from public.coder_files
    where user_id = ${userId}::uuid and filename = ${filename}
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    path: row.filename,
    content: row.content ?? '',
    language: row.language || null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

/**
 * Guarda (upsert) un archivo. Idempotente por (user_id, filename).
 * @param {string} userId
 * @param {string} filename Ruta normalizada.
 * @param {string} content
 * @param {string|null} language
 * @returns {Promise<{path:string, size:number, updatedAt:string}>}
 */
export async function upsertFile(userId, filename, content, language = null) {
  if (!isUuid(userId)) throw new Error('Identificador de usuario inválido.');
  await ensureTable();
  const size = Buffer.byteLength(content, 'utf8');
  if (size > MAX_FILE_BYTES) {
    throw new Error(`El archivo supera el máximo de ${Math.round(MAX_FILE_BYTES / 1024)} KB.`);
  }
  const rows = await sql`
    insert into public.coder_files (user_id, filename, content, language, size_bytes, updated_at)
    values (${userId}::uuid, ${filename}, ${content}, ${language}, ${size}, now())
    on conflict (user_id, filename)
    do update set
      content    = excluded.content,
      language   = coalesce(excluded.language, public.coder_files.language),
      size_bytes = excluded.size_bytes,
      updated_at = now()
    returning filename, size_bytes, updated_at
  `;
  const row = rows[0];
  return {
    path: row.filename,
    size: Number(row.size_bytes || 0),
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

/**
 * Detecta el lenguaje por extensión (mapa compartido con el frontend).
 * @param {string} filename
 * @returns {string}
 */
export function languageFromPath(filename) {
  const ext = String(filename || '').split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', css: 'css', scss: 'scss',
    less: 'less', html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
    md: 'markdown', mdx: 'markdown', py: 'python', rb: 'ruby', go: 'go',
    rs: 'rust', java: 'java', php: 'php', sh: 'shell', bash: 'shell',
    yml: 'yaml', yaml: 'yaml', sql: 'sql', env: 'ini', toml: 'ini', ini: 'ini',
    txt: 'plaintext'
  };
  return map[ext] || 'plaintext';
}

export default { ensureTable, listFiles, getFile, upsertFile, normalizeFilename, languageFromPath, isUuid, MAX_FILE_BYTES };
