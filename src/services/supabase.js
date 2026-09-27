/* ================================================================
   NUMINATION · supabase.js
   Cliente de Supabase + helpers de base de datos.
   ================================================================ */

import { createClient } from '@supabase/supabase-js';
import postgres from 'postgres';

let TEST_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL ?? TEST_KEYS.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? TEST_KEYS.SUPABASE_SERVICE_KEY;
const DATABASE_URL = process.env.DATABASE_URL ?? TEST_KEYS.DATABASE_URL;

if (!SUPABASE_URL) console.warn('⚠️  SUPABASE_URL no configurada');
if (!SUPABASE_SERVICE_KEY) console.warn('⚠️  SUPABASE_SERVICE_KEY no configurada');
if (!DATABASE_URL) console.warn('⚠️  DATABASE_URL no configurada');

export const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

export const sql = DATABASE_URL
  ? postgres(DATABASE_URL, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    })
  : null;

/* ══════════════════════════════════════════════════════════════
   PROFILES
   ══════════════════════════════════════════════════════════════ */

export async function getProfile(userId) {
  if (!sql) return null;
  try {
    const [profile] = await sql`
      select * from public.profiles where id = ${userId} limit 1
    `;
    return profile || null;
  } catch (e) {
    console.error('[supabase] getProfile:', e.message);
    return null;
  }
}

export async function getProfileByEmail(email) {
  if (!sql) return null;
  try {
    const [profile] = await sql`
      select * from public.profiles where email = ${email.toLowerCase()} limit 1
    `;
    return profile || null;
  } catch (e) {
    console.error('[supabase] getProfileByEmail:', e.message);
    return null;
  }
}

export async function createProfile({ id, email, name, picture }) {
  if (!sql) return null;
  try {
    const [profile] = await sql`
      insert into public.profiles (id, email, name, picture)
      values (${id}, ${email.toLowerCase()}, ${name}, ${picture})
      on conflict (id) do update set
        name = excluded.name,
        picture = excluded.picture,
        last_login = now()
      returning *
    `;
    return profile;
  } catch (e) {
    console.error('[supabase] createProfile:', e.message);
    return null;
  }
}

export async function updateLastLogin(userId) {
  if (!sql) return;
  try {
    await sql`
      update public.profiles set last_login = now() where id = ${userId}
    `;
  } catch (e) {
    console.error('[supabase] updateLastLogin:', e.message);
  }
}

export async function updateProfile(userId, data) {
  if (!sql) return null;
  try {
    const [profile] = await sql`
      update public.profiles
      set name = ${data.name ?? null},
          city = ${data.city ?? null},
          grade = ${data.grade ?? null},
          last_login = now()
      where id = ${userId}
      returning *
    `;
    return profile;
  } catch (e) {
    console.error('[supabase] updateProfile:', e.message);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   CHATS
   ══════════════════════════════════════════════════════════════ */

export async function listarChats(userId) {
  if (!sql) return [];
  try {
    return await sql`
      select id, title, created_at, updated_at
      from public.chats
      where user_id = ${userId}
      order by updated_at desc
      limit 100
    `;
  } catch (e) {
    console.error('[supabase] listarChats:', e.message);
    return [];
  }
}

export async function crearChat(userId, title) {
  if (!sql) return null;
  try {
    const [chat] = await sql`
      insert into public.chats (user_id, title)
      values (${userId}, ${title || 'Sin título'})
      returning *
    `;
    return chat;
  } catch (e) {
    console.error('[supabase] crearChat:', e.message);
    return null;
  }
}

export async function obtenerChat(chatId, userId) {
  if (!sql) return null;
  try {
    const [chat] = await sql`
      select * from public.chats
      where id = ${chatId} and user_id = ${userId}
      limit 1
    `;
    if (!chat) return null;

    const mensajes = await sql`
      select * from public.messages
      where chat_id = ${chatId}
      order by created_at asc
    `;

    return { ...chat, messages: mensajes };
  } catch (e) {
    console.error('[supabase] obtenerChat:', e.message);
    return null;
  }
}

export async function agregarMensaje(chatId, msg) {
  if (!sql) return null;
  try {
    const [mensaje] = await sql`
      insert into public.messages (chat_id, role, content, attachment, image_url, provider, duration_ms)
      values (
        ${chatId},
        ${msg.role},
        ${msg.content},
        ${msg.attachment || null},
        ${msg.imageUrl || null},
        ${msg.provider || null},
        ${msg.durationMs || 0}
      )
      returning *
    `;

    await sql`
      update public.chats set updated_at = now() where id = ${chatId}
    `;

    return mensaje;
  } catch (e) {
    console.error('[supabase] agregarMensaje:', e.message);
    return null;
  }
}

export async function eliminarChat(chatId, userId) {
  if (!sql) return false;
  try {
    await sql`
      delete from public.chats
      where id = ${chatId} and user_id = ${userId}
    `;
    return true;
  } catch (e) {
    console.error('[supabase] eliminarChat:', e.message);
    return false;
  }
}

export async function eliminarTodosLosChats(userId) {
  if (!sql) return false;
  try {
    await sql`
      delete from public.chats where user_id = ${userId}
    `;
    return true;
  } catch (e) {
    console.error('[supabase] eliminarTodosLosChats:', e.message);
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════
   MEMORIAS
   Datos cortos que Numi-OT.01 recuerda sobre cada usuario.
   ══════════════════════════════════════════════════════════════ */

/**
 * Lista todas las memorias del usuario, ordenadas por más reciente.
 * @param {string} userId - UUID del usuario
 * @returns {Promise<Array<{id: string, text: string, created_at: string}>>}
 */
export async function listarMemories(userId) {
  if (!sql) return [];
  try {
    const rows = await sql`
      select id, text, created_at
      from public.memories
      where user_id = ${userId}
      order by created_at desc
      limit 100
    `;
    return rows || [];
  } catch (e) {
    console.error('[supabase] listarMemories:', e.message);
    return [];
  }
}

/**
 * Crea una nueva memoria.
 * @param {string} userId - UUID del usuario
 * @param {string} text - Texto de la memoria (3-500 chars)
 * @returns {Promise<{id: string, text: string, created_at: string}|null>}
 */
export async function crearMemory(userId, text) {
  if (!sql) return null;
  try {
    const [memory] = await sql`
      insert into public.memories (user_id, text)
      values (${userId}, ${text})
      returning id, text, created_at
    `;
    return memory || null;
  } catch (e) {
    console.error('[supabase] crearMemory:', e.message);
    return null;
  }
}

/**
 * Elimina una memoria. Solo si pertenece al usuario.
 * @param {string} userId - UUID del usuario
 * @param {string} memoryId - UUID de la memoria
 * @returns {Promise<boolean>}
 */
export async function eliminarMemory(userId, memoryId) {
  if (!sql) return false;
  try {
    const result = await sql`
      delete from public.memories
      where id = ${memoryId} and user_id = ${userId}
    `;
    // postgres.js devuelve un array con count
    return result.count > 0 || true;
  } catch (e) {
    console.error('[supabase] eliminarMemory:', e.message);
    return false;
  }
}

/* ══════════════════════════════════════════════════════════════
   HEALTH
   ══════════════════════════════════════════════════════════════ */

export function supabaseDisponible() {
  return Boolean(sql);
}