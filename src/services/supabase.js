/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · supabase.js
   Cliente Postgres + helpers.
   ───────────────────────────────────────────────────────────────────────────
   Adaptado a las tablas PascalCase (Chat, Message, Memory) y a profiles.
   La API pública devuelve objetos en snake_case para no romper el frontend.
   ═══════════════════════════════════════════════════════════════════════════ */

import postgres from 'postgres';
import crypto from 'node:crypto';

let TEST_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

const DATABASE_URL = process.env.DATABASE_URL ?? TEST_KEYS.DATABASE_URL;

let sql = null;

if (DATABASE_URL) {
  try {
    sql = postgres(DATABASE_URL, {
      ssl: 'require',
      prepare: false,
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  } catch (e) {
    console.warn('[supabase] No se pudo crear el cliente:', e.message);
  }
} else {
  console.warn('[supabase] DATABASE_URL no configurada');
}

export function supabaseDisponible() {
  return Boolean(sql);
}

export { sql };

/* ═══════════════════════════════════════════════════════════════════════════
   NORMALIZADORES
   ═══════════════════════════════════════════════════════════════════════════ */

function normalizeChat(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title || 'Sin título',
    created_at: row.created_at || row.createdAt || null,
    updated_at: row.updated_at || row.updatedAt || null,
  };
}

function normalizeMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    chat_id: row.chat_id || row.chatId || null,
    role: row.role,
    content: row.content,
    created_at: row.created_at || row.createdAt || null,
  };
}

function normalizeMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id || row.userId || null,
    text: row.text || row.content || '',
    created_at: row.created_at || row.createdAt || null,
  };
}

function normalizeProfile(row) {
  if (!row) return null;

  const tierRaw = String(row.tier || 'FREE').toUpperCase();
  let plan = 'free';
  if (tierRaw === 'PRO') plan = 'pro-coder';
  else if (tierRaw === 'PREMIUM') plan = 'pro-plus';
  else if (tierRaw === 'MADMAX') plan = 'pro-mad-max';

  return {
    id: row.id,
    email: row.email,
    name:
      row.name ||
      row.displayName ||
      (row.email ? row.email.split('@')[0] : 'Usuario'),
    picture: row.picture || row.avatarUrl || null,
    plan: plan,
    created_at: row.created_at || row.createdAt || null,
    updated_at: row.updated_at || row.updatedAt || null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   PROFILES
   ═══════════════════════════════════════════════════════════════════════════ */

export async function getProfile(userId) {
  if (!sql || !userId) return null;
  try {
    const [row] = await sql`
      select id, email, "displayName", "avatarUrl", tier,
             "createdAt" as created_at,
             "updatedAt" as updated_at
      from public.profiles
      where id = ${userId}::uuid
      limit 1
    `;
    return normalizeProfile(row);
  } catch (e) {
    console.error('[supabase] getProfile:', e.message);
    return null;
  }
}

export async function getProfileByEmail(email) {
  if (!sql || !email) return null;
  try {
    const [row] = await sql`
      select id, email, "displayName", "avatarUrl", tier,
             "createdAt" as created_at,
             "updatedAt" as updated_at
      from public.profiles
      where lower(email) = lower(${email})
      limit 1
    `;
    return normalizeProfile(row);
  } catch (e) {
    console.error('[supabase] getProfileByEmail:', e.message);
    return null;
  }
}

/**
 * Crea un perfil nuevo o lo actualiza si ya existe por id o email.
 * Acepta dos formas:
 *   createProfile({ id, email, name, picture })
 *   createProfile(id, email, name, picture)
 */
export async function createProfile(arg1, arg2, arg3, arg4) {
  if (!sql) return null;

  let payload;
  if (arg1 && typeof arg1 === 'object') {
    payload = arg1;
  } else {
    payload = { id: arg1, email: arg2, name: arg3, picture: arg4 };
  }

  const email = payload.email;
  if (!email) {
    console.error('[supabase] createProfile: falta email');
    return null;
  }

  const id = payload.id || crypto.randomUUID();
  const displayName =
    payload.name ||
    payload.displayName ||
    email.split('@')[0] ||
    'Usuario';
  const avatarUrl = payload.picture || payload.avatarUrl || null;

  try {
    // Si ya existe por email, devolver ese en vez de crear otro
    const existing = await getProfileByEmail(email);
    if (existing) {
      await updateLastLogin(existing.id);
      return existing;
    }

    const [row] = await sql`
      insert into public.profiles
        (id, email, "displayName", "avatarUrl", role, tier)
      values
        (${id}::uuid, ${email}, ${displayName}, ${avatarUrl}, 'USER', 'FREE')
      returning id, email, "displayName", "avatarUrl", tier,
                "createdAt" as created_at,
                "updatedAt" as updated_at
    `;
    return normalizeProfile(row);
  } catch (e) {
    console.error('[supabase] createProfile:', e.message);
    return null;
  }
}

export async function updateProfile(userId, patch = {}) {
  if (!sql || !userId) return null;
  try {
    const displayName = patch.name || patch.displayName || null;
    const avatarUrl = patch.picture || patch.avatarUrl || null;

    const [row] = await sql`
      update public.profiles
      set
        "displayName" = coalesce(${displayName}, "displayName"),
        "avatarUrl"   = coalesce(${avatarUrl},   "avatarUrl"),
        "updatedAt"   = now()
      where id = ${userId}::uuid
      returning id, email, "displayName", "avatarUrl", tier,
                "createdAt" as created_at,
                "updatedAt" as updated_at
    `;
    return normalizeProfile(row);
  } catch (e) {
    console.error('[supabase] updateProfile:', e.message);
    return null;
  }
}

/**
 * Alias de getProfile. Lo usa auth.js en el callback de OAuth.
 */
export async function findOrCreateUser(profile) {
  if (!sql || !profile || !profile.email) return null;
  const existing = await getProfileByEmail(profile.email);
  if (existing) {
    await updateLastLogin(existing.id);
    return existing;
  }
  return createProfile({
    id: profile.id,
    email: profile.email,
    name: profile.name || profile.displayName,
    picture: profile.picture || profile.avatarUrl,
  });
}

export async function updateLastLogin(userId) {
  if (!sql || !userId) return false;
  try {
    await sql`
      update public.profiles
      set "updatedAt" = now()
      where id = ${userId}::uuid
    `;
    return true;
  } catch (e) {
    console.error('[supabase] updateLastLogin:', e.message);
    return false;
  }
}

export async function actualizarPlan(userId, tier) {
  if (!sql || !userId) return null;
  try {
    const [row] = await sql`
      update public.profiles
      set tier = ${tier}, "updatedAt" = now()
      where id = ${userId}::uuid
      returning id, email, "displayName", "avatarUrl", tier,
                "createdAt" as created_at,
                "updatedAt" as updated_at
    `;
    return normalizeProfile(row);
  } catch (e) {
    console.error('[supabase] actualizarPlan:', e.message);
    return null;
  }
}

export async function deleteProfile(userId) {
  if (!sql || !userId) return false;
  try {
    await sql`delete from "Memory" where "userId" = ${userId}::uuid`;

    const chats = await sql`
      select id from "Chat" where "userId" = ${userId}::uuid
    `;
    for (const c of chats) {
      await sql`delete from "Message" where "chatId" = ${c.id}`;
    }
    await sql`delete from "Chat" where "userId" = ${userId}::uuid`;
    await sql`delete from public.profiles where id = ${userId}::uuid`;
    return true;
  } catch (e) {
    console.error('[supabase] deleteProfile:', e.message);
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   CHATS
   ═══════════════════════════════════════════════════════════════════════════ */

export async function crearChat(userId, title) {
  if (!sql || !userId) return null;
  try {
    const id = crypto.randomUUID();
    const [row] = await sql`
      insert into "Chat" (id, "userId", title, mode, "isGhost")
      values (${id}, ${userId}::uuid, ${title || 'Nuevo chat'}, 'chat', false)
      returning id, title,
                "createdAt" as created_at,
                "updatedAt" as updated_at
    `;
    return normalizeChat(row);
  } catch (e) {
    console.error('[supabase] crearChat:', e.message);
    return null;
  }
}

export async function listarChats(userId) {
  if (!sql || !userId) return [];
  try {
    const rows = await sql`
      select id, title,
             "createdAt" as created_at,
             "updatedAt" as updated_at
      from "Chat"
      where "userId" = ${userId}::uuid
        and "isGhost" = false
      order by "updatedAt" desc
      limit 100
    `;
    return rows.map(normalizeChat);
  } catch (e) {
    console.error('[supabase] listarChats:', e.message);
    return [];
  }
}

export async function obtenerChat(chatId, userId) {
  if (!sql || !chatId || !userId) return null;
  try {
    const [chat] = await sql`
      select id, title,
             "createdAt" as created_at,
             "updatedAt" as updated_at
      from "Chat"
      where id = ${chatId}
        and "userId" = ${userId}::uuid
      limit 1
    `;
    if (!chat) return null;

    const messages = await sql`
      select id, "chatId" as chat_id, role, content,
             "createdAt" as created_at
      from "Message"
      where "chatId" = ${chatId}
      order by "createdAt" asc
    `;

    return {
      ...normalizeChat(chat),
      messages: messages.map(normalizeMessage),
    };
  } catch (e) {
    console.error('[supabase] obtenerChat:', e.message);
    return null;
  }
}

export async function eliminarChat(chatId, userId) {
  if (!sql || !chatId || !userId) return false;
  try {
    const [chat] = await sql`
      select id from "Chat"
      where id = ${chatId}
        and "userId" = ${userId}::uuid
      limit 1
    `;
    if (!chat) return false;

    await sql`delete from "Message" where "chatId" = ${chatId}`;
    await sql`delete from "Chat" where id = ${chatId}`;
    return true;
  } catch (e) {
    console.error('[supabase] eliminarChat:', e.message);
    return false;
  }
}

export async function crearMensaje(chatId, { role, content }) {
  if (!sql || !chatId) return null;
  try {
    const id = crypto.randomUUID();
    const [row] = await sql`
      insert into "Message" (id, "chatId", role, content)
      values (${id}, ${chatId}, ${role}, ${String(content)})
      returning id, "chatId" as chat_id, role, content,
                "createdAt" as created_at
    `;

    await sql`
      update "Chat"
      set "updatedAt" = now()
      where id = ${chatId}
    `;

    return normalizeMessage(row);
  } catch (e) {
    console.error('[supabase] crearMensaje:', e.message);
    return null;
  }
}

export async function listarMensajes(chatId) {
  if (!sql || !chatId) return [];
  try {
    const rows = await sql`
      select id, "chatId" as chat_id, role, content,
             "createdAt" as created_at
      from "Message"
      where "chatId" = ${chatId}
      order by "createdAt" asc
    `;
    return rows.map(normalizeMessage);
  } catch (e) {
    console.error('[supabase] listarMensajes:', e.message);
    return [];
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MEMORIES
   ═══════════════════════════════════════════════════════════════════════════ */

export async function listarMemories(userId) {
  if (!sql || !userId) return [];
  try {
    const rows = await sql`
      select id, "userId" as user_id, title, content,
             "createdAt" as created_at
      from "Memory"
      where "userId" = ${userId}::uuid
        and type = 'MEMORY'
      order by "createdAt" desc
      limit 100
    `;
    return rows.map(normalizeMemory);
  } catch (e) {
    console.error('[supabase] listarMemories:', e.message);
    return [];
  }
}

export async function crearMemory(userId, text) {
  if (!sql || !userId || !text) return null;
  try {
    const id = crypto.randomUUID();
    const title =
      text.length > 60 ? text.slice(0, 57).trimEnd() + '…' : text;

    const [row] = await sql`
      insert into "Memory" (id, "userId", title, content, type)
      values (${id}, ${userId}::uuid, ${title}, ${text}, 'MEMORY')
      returning id, "userId" as user_id, content,
                "createdAt" as created_at
    `;
    return normalizeMemory(row);
  } catch (e) {
    console.error('[supabase] crearMemory:', e.message);
    return null;
  }
}

export async function eliminarMemory(memoryId, userId) {
  if (!sql || !memoryId || !userId) return false;
  try {
    const result = await sql`
      delete from "Memory"
      where id = ${memoryId}
        and "userId" = ${userId}::uuid
    `;
    return result.count > 0;
  } catch (e) {
    console.error('[supabase] eliminarMemory:', e.message);
    return false;
  }
}