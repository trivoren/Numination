/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · supabase.js · v4.1
   ─────────────────────────────────────────────────────────────────────
   La única capa que habla con Postgres. Todo lo demás depende de esto.

   v4.1 · 11/10/2026
     · FIX: quitada columna "provider" de Message (no existía en la DB)
     · FIX: los errores ya no se silencian — se loguean con detalle
     · MEJORA: helper queryLog para ver SQL cuando hay error
     · MEJORA: fallback a SELECT sin columnas opcionales
   ═══════════════════════════════════════════════════════════════════════ */

import postgres from 'postgres';
import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CLIENTE Y CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

let TEST_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

const DATABASE_URL = process.env.DATABASE_URL ?? TEST_KEYS.DATABASE_URL;

const CONFIG = Object.freeze({
  max:              10,
  idle_timeout:     20,
  connect_timeout:  10,
  max_lifetime:     60 * 30,
  backoff_retries:  2,
  backoff_base_ms:  120,
  default_limit:    100,
  max_limit:        500,
  verbose_errors:   process.env.NODE_ENV !== 'production',
});

let sql = null;
let sqlError = null;

if (DATABASE_URL) {
  try {
    sql = postgres(DATABASE_URL, {
      ssl: 'require',
      prepare: false,
      max: CONFIG.max,
      idle_timeout: CONFIG.idle_timeout,
      connect_timeout: CONFIG.connect_timeout,
      max_lifetime: CONFIG.max_lifetime,
      onnotice: () => {},
    });
  } catch (e) {
    sqlError = e;
    console.warn('[sb] no se pudo crear el cliente:', e.message);
  }
} else {
  sqlError = new Error('DATABASE_URL no configurada');
  console.warn('[sb] DATABASE_URL no configurada');
}

export function supabaseDisponible() { return Boolean(sql); }
export { sql };

/* ═══════════════════════════════════════════════════════════════════════
   2 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

function uid() {
  try { return crypto.randomUUID(); }
  catch { return crypto.randomBytes(16).toString('hex'); }
}

function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * Log de error con contexto enriquecido.
 * En desarrollo, imprime código Postgres y detalle. En producción, resumen.
 */
function log(op, err, extra) {
  const detail = {
    op,
    msg: err?.message || String(err),
    code: err?.code || null,
    detail: err?.detail || null,
    hint: err?.hint || null,
  };
  if (extra) Object.assign(detail, extra);

  if (CONFIG.verbose_errors) {
    console.warn(`[sb] ${op}:`, detail.msg, detail.code ? `(code ${detail.code})` : '');
    if (detail.detail) console.warn(`[sb]   detail:`, detail.detail);
    if (detail.hint) console.warn(`[sb]   hint:`, detail.hint);
  } else {
    console.warn(`[sb] ${op}: ${detail.msg}`);
  }
}

/**
 * Ejecuta `fn` con reintentos exponenciales cortos.
 * Solo reintenta en errores transitorios (red, timeouts).
 *
 * IMPORTANTE: si falla definitivamente, devuelve null.
 * El error queda en consola con [sb] para debug.
 */
async function withRetry(fn, op) {
  let lastErr;
  for (let i = 0; i <= CONFIG.backoff_retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const msg = String(e?.message || '');
      const transient =
        e?.code === 'ECONNRESET' ||
        e?.code === 'ETIMEDOUT' ||
        e?.code === '57P01' ||
        e?.code === '57P02' ||
        /timeout|connection|socket|terminating/i.test(msg);
      if (!transient || i === CONFIG.backoff_retries) break;
      await new Promise(r => setTimeout(r, CONFIG.backoff_base_ms * (i + 1)));
    }
  }
  log(op, lastErr);
  return null;
}

async function tx(fn, op) {
  if (!sql) return null;
  try {
    return await sql.begin(async (trx) => fn(trx));
  } catch (e) {
    log(op || 'tx', e);
    return null;
  }
}

function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/* ═══════════════════════════════════════════════════════════════════════
   3 · NORMALIZADORES
   ═══════════════════════════════════════════════════════════════════════ */

function normalizeChat(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title || 'Sin título',
    mode: row.mode || 'chat',
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
    content: row.content ?? '',
    provider: row.provider || null,   // siempre null hasta que exista la columna
    created_at: row.created_at || row.createdAt || null,
  };
}

function normalizeMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id || row.userId || null,
    text: row.content ?? row.text ?? '',
    title: row.title || null,
    category: row.category || 'general',
    tags: Array.isArray(row.tags) ? row.tags : [],
    pinned: Boolean(row.pinned),
    relevance: Number(row.relevance ?? 5),
    source: row.source || 'manual',
    use_count: Number(row.useCount ?? row.use_count ?? 0),
    last_used_at: row.lastUsedAt || row.last_used_at || null,
    created_at: row.created_at || row.createdAt || null,
    updated_at: row.updated_at || row.updatedAt || null,
  };
}

function normalizeMemorySimple(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id || row.userId || null,
    text: row.content ?? row.text ?? '',
    title: row.title || null,
    created_at: row.created_at || row.createdAt || null,
  };
}

function normalizeProfile(row) {
  if (!row) return null;

  const tierRaw = String(row.tier || 'FREE').toUpperCase();
  const plan =
    tierRaw === 'PRO'     ? 'pro-coder' :
    tierRaw === 'PREMIUM' ? 'pro-plus'  :
    tierRaw === 'MADMAX'  ? 'pro-mad-max' :
                            'free';

  const name =
    row.name ||
    row.displayName ||
    (row.email ? row.email.split('@')[0] : 'Usuario');

  const picture = row.picture || row.avatarUrl || null;

  return {
    id: row.id,
    email: row.email,
    name,
    picture,
    role: row.role || 'STUDENT',
    tier: tierRaw,
    plan,
    auth_provider: row.auth_provider || null,
    email_verified: row.email_verified !== false,
    password_hash: row.password_hash || null,
    last_login_at: row.last_login_at || null,
    created_at: row.created_at || row.createdAt || null,
    updated_at: row.updated_at || row.updatedAt || null,
  };
}

function profilePublic(row) {
  const p = normalizeProfile(row);
  if (!p) return null;
  delete p.password_hash;
  return p;
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · PROFILES
   ═══════════════════════════════════════════════════════════════════════ */

export async function getProfile(userId) {
  if (!sql || !isUuid(userId)) return null;
  return withRetry(async () => {
    const [row] = await sql`
      select id, email,
             "displayName" as name,
             "avatarUrl"   as picture,
             role, tier,
             auth_provider,
             email_verified,
             last_login_at,
             "createdAt" as created_at,
             "updatedAt" as updated_at
      from public.profiles
      where id = ${userId}::uuid
      limit 1
    `;
    return profilePublic(row);
  }, 'getProfile');
}

export async function getProfileFull(userId) {
  if (!sql || !isUuid(userId)) return null;
  return withRetry(async () => {
    const [row] = await sql`
      select id, email,
             "displayName" as name,
             "avatarUrl"   as picture,
             role, tier,
             auth_provider,
             email_verified,
             password_hash,
             last_login_at,
             "createdAt" as created_at,
             "updatedAt" as updated_at
      from public.profiles
      where id = ${userId}::uuid
      limit 1
    `;
    return normalizeProfile(row);
  }, 'getProfileFull');
}

export async function getProfileByEmail(email) {
  const key = normEmail(email);
  if (!sql || !key) return null;
  return withRetry(async () => {
    const [row] = await sql`
      select id, email,
             "displayName" as name,
             "avatarUrl"   as picture,
             role, tier,
             auth_provider,
             email_verified,
             last_login_at,
             "createdAt" as created_at,
             "updatedAt" as updated_at
      from public.profiles
      where lower(email) = ${key}
      limit 1
    `;
    return profilePublic(row);
  }, 'getProfileByEmail');
}

export async function getProfileByEmailFull(email) {
  const key = normEmail(email);
  if (!sql || !key) return null;
  return withRetry(async () => {
    const [row] = await sql`
      select id, email,
             "displayName" as name,
             "avatarUrl"   as picture,
             role, tier,
             auth_provider,
             email_verified,
             password_hash,
             last_login_at,
             "createdAt" as created_at,
             "updatedAt" as updated_at
      from public.profiles
      where lower(email) = ${key}
      limit 1
    `;
    return normalizeProfile(row);
  }, 'getProfileByEmailFull');
}

export async function createProfile(arg1, arg2, arg3, arg4) {
  if (!sql) return null;

  const payload = (arg1 && typeof arg1 === 'object')
    ? arg1
    : { id: arg1, email: arg2, name: arg3, picture: arg4 };

  const email = normEmail(payload.email);
  if (!email) {
    console.warn('[sb] createProfile: falta email');
    return null;
  }

  const existing = await getProfileByEmail(email);
  if (existing) {
    await updateLastLogin(existing.id);
    return existing;
  }

  const id = isUuid(payload.id) ? payload.id : uid();
  const displayName = String(
    payload.name || payload.displayName || email.split('@')[0] || 'Usuario'
  ).trim().slice(0, 60) || 'Usuario';
  const avatarUrl = payload.picture || payload.avatarUrl || null;
  const provider = payload.auth_provider || payload.provider || 'google';
  const passwordHash = payload.password_hash || null;
  const role = String(payload.role || 'USER').toUpperCase();
  const tier = String(payload.tier || 'FREE').toUpperCase();

  return withRetry(async () => {
    const [row] = await sql`
      insert into public.profiles (
        id, email, "displayName", "avatarUrl",
        role, tier,
        auth_provider, email_verified,
        password_hash, last_login_at,
        "createdAt", "updatedAt"
      ) values (
        ${id}::uuid,
        ${email},
        ${displayName},
        ${avatarUrl},
        ${role},
        ${tier},
        ${provider},
        ${provider !== 'email'},
        ${passwordHash},
        now(),
        now(),
        now()
      )
      returning id, email,
                "displayName" as name,
                "avatarUrl"   as picture,
                role, tier,
                auth_provider,
                email_verified,
                last_login_at,
                "createdAt" as created_at,
                "updatedAt" as updated_at
    `;
    return profilePublic(row);
  }, 'createProfile');
}

export async function updateProfile(userId, patch = {}) {
  if (!sql || !isUuid(userId)) return null;

  const name = (patch.name ?? patch.displayName ?? null);
  const picture = (patch.picture ?? patch.avatarUrl ?? null);

  if (name === null && picture === null) {
    return getProfile(userId);
  }

  const cleanName = name != null
    ? String(name).trim().slice(0, 60) || null
    : null;
  const cleanPicture = picture != null
    ? String(picture).trim() || null
    : null;

  return withRetry(async () => {
    const [row] = await sql`
      update public.profiles
      set
        "displayName" = coalesce(${cleanName},    "displayName"),
        "avatarUrl"   = coalesce(${cleanPicture}, "avatarUrl"),
        "updatedAt"   = now()
      where id = ${userId}::uuid
      returning id, email,
                "displayName" as name,
                "avatarUrl"   as picture,
                role, tier,
                auth_provider,
                email_verified,
                last_login_at,
                "createdAt" as created_at,
                "updatedAt" as updated_at
    `;
    return profilePublic(row);
  }, 'updateProfile');
}

export async function updateLastLogin(userId) {
  if (!sql || !isUuid(userId)) return false;
  const result = await withRetry(async () => {
    const r = await sql`
      update public.profiles
      set last_login_at = now(),
          "updatedAt"   = now()
      where id = ${userId}::uuid
    `;
    return r.count > 0;
  }, 'updateLastLogin');
  return Boolean(result);
}

export async function deleteProfile(userId) {
  if (!sql || !isUuid(userId)) return false;

  const ok = await tx(async (trx) => {
    await trx`
      delete from "Message"
      where "chatId" in (
        select id from "Chat" where "userId" = ${userId}::uuid
      )
    `;
    await trx`delete from "Chat"   where "userId" = ${userId}::uuid`;
    await trx`delete from "Memory" where "userId" = ${userId}::uuid`;
    const r = await trx`
      delete from public.profiles where id = ${userId}::uuid
    `;
    return r.count > 0;
  }, 'deleteProfile');

  return Boolean(ok);
}

export async function actualizarPlan(userId, tier) {
  if (!sql || !isUuid(userId)) return null;
  const t = String(tier || 'FREE').toUpperCase();
  return withRetry(async () => {
    const [row] = await sql`
      update public.profiles
      set tier = ${t},
          "updatedAt" = now()
      where id = ${userId}::uuid
      returning id, email,
                "displayName" as name,
                "avatarUrl"   as picture,
                role, tier,
                auth_provider,
                email_verified,
                last_login_at,
                "createdAt" as created_at,
                "updatedAt" as updated_at
    `;
    return profilePublic(row);
  }, 'actualizarPlan');
}

export async function countProfiles() {
  if (!sql) return 0;
  const r = await withRetry(async () => {
    const [row] = await sql`select count(*)::int as total from public.profiles`;
    return row?.total ?? 0;
  }, 'countProfiles');
  return r ?? 0;
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · PASSWORD + RESET TOKENS
   ═══════════════════════════════════════════════════════════════════════ */

export async function setPassword(userId, passwordHash) {
  if (!sql || !isUuid(userId) || !passwordHash) return null;
  return withRetry(async () => {
    const [row] = await sql`
      update public.profiles
      set password_hash = ${passwordHash},
          auth_provider = coalesce(nullif(auth_provider, ''), 'email'),
          "updatedAt"   = now()
      where id = ${userId}::uuid
      returning id, email,
                "displayName" as name,
                "avatarUrl"   as picture,
                role, tier,
                auth_provider,
                email_verified,
                last_login_at,
                "createdAt" as created_at,
                "updatedAt" as updated_at
    `;
    return profilePublic(row);
  }, 'setPassword');
}

export async function getPasswordHash(userId) {
  if (!sql || !isUuid(userId)) return null;
  return withRetry(async () => {
    const [row] = await sql`
      select password_hash from public.profiles
      where id = ${userId}::uuid limit 1
    `;
    return row?.password_hash ?? null;
  }, 'getPasswordHash');
}

export async function setResetToken(userId, token, expiresAt) {
  if (!sql || !isUuid(userId) || !token) return null;
  const exp = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  return withRetry(async () => {
    const [row] = await sql`
      update public.profiles
      set reset_token         = ${token},
          reset_token_expires = ${exp},
          "updatedAt"         = now()
      where id = ${userId}::uuid
      returning id, email,
                "displayName" as name,
                "avatarUrl"   as picture,
                role, tier,
                auth_provider,
                email_verified,
                last_login_at,
                "createdAt" as created_at,
                "updatedAt" as updated_at
    `;
    return profilePublic(row);
  }, 'setResetToken');
}

export async function getProfileByResetToken(token) {
  if (!sql || !token || typeof token !== 'string') return null;
  return withRetry(async () => {
    const [row] = await sql`
      select id, email,
             "displayName" as name,
             "avatarUrl"   as picture,
             role, tier,
             auth_provider,
             email_verified,
             password_hash,
             reset_token,
             reset_token_expires,
             last_login_at,
             "createdAt" as created_at,
             "updatedAt" as updated_at
      from public.profiles
      where reset_token = ${token}
        and reset_token_expires > now()
      limit 1
    `;
    return normalizeProfile(row);
  }, 'getProfileByResetToken');
}

export async function clearResetToken(userId) {
  if (!sql || !isUuid(userId)) return null;
  return withRetry(async () => {
    const [row] = await sql`
      update public.profiles
      set reset_token         = null,
          reset_token_expires = null,
          "updatedAt"         = now()
      where id = ${userId}::uuid
      returning id, email,
                "displayName" as name,
                "avatarUrl"   as picture,
                role, tier,
                auth_provider,
                email_verified,
                last_login_at,
                "createdAt" as created_at,
                "updatedAt" as updated_at
    `;
    return profilePublic(row);
  }, 'clearResetToken');
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · CHATS
   ═══════════════════════════════════════════════════════════════════════ */

export async function crearChat(userId, title) {
  if (!sql || !isUuid(userId)) return null;
  const cleanTitle = String(title || 'Nuevo chat').trim().slice(0, 80) || 'Nuevo chat';
  return withRetry(async () => {
    const id = uid();
    const [row] = await sql`
      insert into "Chat" (id, "userId", title, mode, "isGhost", "createdAt", "updatedAt")
      values (${id}, ${userId}::uuid, ${cleanTitle}, 'chat', false, now(), now())
      returning id, title, mode,
                "createdAt" as created_at,
                "updatedAt" as updated_at
    `;
    return normalizeChat(row);
  }, 'crearChat');
}

export async function listarChats(userId, { limit = CONFIG.default_limit, offset = 0 } = {}) {
  if (!sql || !isUuid(userId)) return [];
  const lim = clamp(limit, 1, CONFIG.max_limit, CONFIG.default_limit);
  const off = Math.max(0, Math.trunc(offset));
  const rows = await withRetry(async () => {
    return await sql`
      select id, title, mode,
             "createdAt" as created_at,
             "updatedAt" as updated_at
      from "Chat"
      where "userId" = ${userId}::uuid
        and "isGhost" = false
      order by "updatedAt" desc
      limit ${lim}
      offset ${off}
    `;
  }, 'listarChats');
  return (rows || []).map(normalizeChat);
}

/**
 * obtenerChat · un chat con todos sus mensajes
 *
 * NOTA v4.1: la tabla "Message" NO tiene columna "provider".
 * Se quitó del SELECT. Si algún día se agrega, se puede reactivar.
 */
export async function obtenerChat(chatId, userId) {
  if (!sql || !chatId || !isUuid(userId)) return null;
  return withRetry(async () => {
    const [chat] = await sql`
      select id, title, mode,
             "createdAt" as created_at,
             "updatedAt" as updated_at
      from "Chat"
      where id::text = ${chatId}
        and "userId" = ${userId}::uuid
      limit 1
    `;
    if (!chat) return null;

    const messages = await sql`
      select id, "chatId" as chat_id, role, content,
             "createdAt" as created_at
      from "Message"
      where "chatId"::text = ${chatId}
      order by "createdAt" asc
    `;

    return {
      ...normalizeChat(chat),
      messages: messages.map(normalizeMessage),
    };
  }, 'obtenerChat');
}

export async function eliminarChat(chatId, userId) {
  if (!sql || !chatId || !isUuid(userId)) return false;
  const ok = await tx(async (trx) => {
    const [chat] = await trx`
      select id from "Chat"
      where id::text = ${chatId} and "userId" = ${userId}::uuid
      limit 1
    `;
    if (!chat) return false;

    await trx`delete from "Message" where "chatId"::text = ${chatId}`;
    const r = await trx`delete from "Chat" where id::text = ${chatId}`;
    return r.count > 0;
  }, 'eliminarChat');
  return Boolean(ok);
}

export async function renombrarChat(chatId, userId, newTitle) {
  if (!sql || !chatId || !isUuid(userId)) return null;
  const clean = String(newTitle || '').trim().slice(0, 80);
  if (!clean) return null;
  return withRetry(async () => {
    const [row] = await sql`
      update "Chat"
      set title = ${clean}, "updatedAt" = now()
      where id::text = ${chatId} and "userId" = ${userId}::uuid
      returning id, title, mode,
                "createdAt" as created_at,
                "updatedAt" as updated_at
    `;
    return normalizeChat(row);
  }, 'renombrarChat');
}

export async function buscarChats(userId, query, { limit = 30 } = {}) {
  if (!sql || !isUuid(userId)) return [];
  const q = String(query || '').trim();
  if (!q) return listarChats(userId, { limit });
  const lim = clamp(limit, 1, 100, 30);
  const pattern = '%' + q.replace(/[%_]/g, m => '\\' + m) + '%';
  const rows = await withRetry(async () => {
    return await sql`
      select id, title, mode,
             "createdAt" as created_at,
             "updatedAt" as updated_at
      from "Chat"
      where "userId" = ${userId}::uuid
        and "isGhost" = false
        and title ilike ${pattern}
      order by "updatedAt" desc
      limit ${lim}
    `;
  }, 'buscarChats');
  return (rows || []).map(normalizeChat);
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · MESSAGES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * crearMensaje · guarda un mensaje en un chat
 *
 * NOTA v4.1: la tabla "Message" no tiene columna "provider".
 * Solo insertamos id, chatId, role, content, createdAt.
 */
export async function crearMensaje(chatId, { role, content }) {
  if (!sql || !chatId) return null;
  if (role !== 'user' && role !== 'ai' && role !== 'assistant') return null;

  const cleanRole = role === 'assistant' ? 'ai' : role;
  const text = String(content ?? '');
  if (!text.trim()) return null;

  return withRetry(async () => {
    const id = uid();
    const [row] = await sql`
      insert into "Message" (id, "chatId", role, content, "createdAt")
      values (${id}, ${chatId}, ${cleanRole}, ${text}, now())
      returning id, "chatId" as chat_id, role, content,
                "createdAt" as created_at
    `;

    await sql`
      update "Chat" set "updatedAt" = now() where id::text = ${chatId}
    `;

    return normalizeMessage(row);
  }, 'crearMensaje');
}

export async function listarMensajes(chatId, { limit = CONFIG.max_limit } = {}) {
  if (!sql || !chatId) return [];
  const lim = clamp(limit, 1, CONFIG.max_limit, CONFIG.max_limit);
  const rows = await withRetry(async () => {
    return await sql`
      select id, "chatId" as chat_id, role, content,
             "createdAt" as created_at
      from "Message"
      where "chatId"::text = ${chatId}
      order by "createdAt" asc
      limit ${lim}
    `;
  }, 'listarMensajes');
  return (rows || []).map(normalizeMessage);
}

export async function vaciarChat(chatId) {
  if (!sql || !chatId) return false;
  const ok = await tx(async (trx) => {
    const r = await trx`delete from "Message" where "chatId"::text = ${chatId}`;
    await trx`update "Chat" set "updatedAt" = now() where id::text = ${chatId}`;
    return r.count;
  }, 'vaciarChat');
  return (ok ?? 0) > 0;
}

/* ═══════════════════════════════════════════════════════════════════════
   8 · MEMORIES
   ═══════════════════════════════════════════════════════════════════════ */

export async function getMemory(memoryId, userId) {
  if (!sql || !memoryId || !isUuid(userId)) return null;
  return withRetry(async () => {
    const [row] = await sql`
      select id, "userId" as user_id, title, content,
             category, tags, pinned, relevance, source,
             "useCount", "lastUsedAt",
             "createdAt" as created_at,
             coalesce("updatedAt", "createdAt") as updated_at
      from "Memory"
      where id = ${memoryId}
        and "userId" = ${userId}::uuid
        and type = 'MEMORY'
      limit 1
    `;
    return normalizeMemory(row);
  }, 'getMemory');
}

export async function listarMemoriesConFiltros(userId, opts = {}) {
  if (!sql || !isUuid(userId)) return [];

  const limit  = clamp(opts.limit, 1, CONFIG.max_limit, 100);
  const offset = Math.max(0, Math.trunc(opts.offset || 0));
  const category = opts.category ? String(opts.category).toLowerCase() : null;
  const pinned = typeof opts.pinned === 'boolean' ? opts.pinned : null;
  const sort = opts.sort === 'oldest' ? 'oldest' : 'newest';
  const tags = Array.isArray(opts.tags) && opts.tags.length ? opts.tags : null;
  const minRelevance = Number.isFinite(opts.minRelevance) ? Math.trunc(opts.minRelevance) : null;

  const rows = await withRetry(async () => {
    return await sql`
      select id, "userId" as user_id, title, content,
             category, tags, pinned, relevance, source,
             "useCount", "lastUsedAt",
             "createdAt" as created_at,
             coalesce("updatedAt", "createdAt") as updated_at
      from "Memory"
      where "userId" = ${userId}::uuid
        and type = 'MEMORY'
        and (${category}::text is null or lower(category) = ${category})
        and (${pinned}::boolean is null or pinned = ${pinned})
        and (${tags}::text[] is null or tags && ${tags})
        and (${minRelevance}::int is null or relevance >= ${minRelevance})
      order by
        pinned desc,
        case when ${sort} = 'oldest' then "createdAt" end asc,
        case when ${sort} = 'newest' then "createdAt" end desc
      limit ${limit}
      offset ${offset}
    `;
  }, 'listarMemoriesConFiltros');

  return (rows || []).map(normalizeMemory);
}

export async function buscarMemories(userId, query, { limit = 50 } = {}) {
  if (!sql || !isUuid(userId)) return [];
  const q = String(query || '').trim();
  if (!q) return listarMemoriesConFiltros(userId, { limit });

  const pattern = '%' + q.replace(/[%_]/g, m => '\\' + m) + '%';
  const lim = clamp(limit, 1, 100, 50);

  const rows = await withRetry(async () => {
    return await sql`
      select id, "userId" as user_id, title, content,
             category, tags, pinned, relevance, source,
             "useCount", "lastUsedAt",
             "createdAt" as created_at,
             coalesce("updatedAt", "createdAt") as updated_at
      from "Memory"
      where "userId" = ${userId}::uuid
        and type = 'MEMORY'
        and (
          title ilike ${pattern}
          or content ilike ${pattern}
          or category ilike ${pattern}
          or array_to_string(tags, ' ') ilike ${pattern}
        )
      order by
        pinned desc,
        (case when title ilike ${pattern} then 100 else 0 end
         + case when content ilike ${pattern} then 50 else 0 end
         + relevance * 2
         + least("useCount", 10)) desc,
        "createdAt" desc
      limit ${lim}
    `;
  }, 'buscarMemories');

  return (rows || []).map(normalizeMemory);
}

export async function actualizarMemory(memoryId, userId, patch = {}) {
  if (!sql || !memoryId || !isUuid(userId)) return null;

  const hasAny = ['text','title','category','tags','pinned','relevance','source']
    .some(k => patch[k] !== undefined);
  if (!hasAny) return getMemory(memoryId, userId);

  const newText     = patch.text     != null ? String(patch.text).trim()     : null;
  const newTitle    = patch.title    != null ? String(patch.title).trim()    : null;
  const newCategory = patch.category != null ? String(patch.category).toLowerCase().trim() : null;
  const newPinned   = typeof patch.pinned === 'boolean' ? patch.pinned : null;
  const newRelevance = Number.isFinite(patch.relevance) ? Math.trunc(patch.relevance) : null;
  const newSource   = patch.source != null ? String(patch.source).trim() : null;
  const newTags     = Array.isArray(patch.tags) ? patch.tags : null;

  const finalTitle = newTitle != null
    ? newTitle
    : (newText != null
        ? (newText.length > 60 ? newText.slice(0, 57).trimEnd() + '…' : newText)
        : null);

  return withRetry(async () => {
    const [row] = await sql`
      update "Memory"
      set
        content     = coalesce(${newText},      content),
        title       = coalesce(${finalTitle},   title),
        category    = coalesce(${newCategory},  category),
        tags        = coalesce(${newTags}::text[], tags),
        pinned      = coalesce(${newPinned},    pinned),
        relevance   = coalesce(${newRelevance}, relevance),
        source      = coalesce(${newSource},    source),
        "updatedAt" = now()
      where id = ${memoryId}
        and "userId" = ${userId}::uuid
        and type = 'MEMORY'
      returning id, "userId" as user_id, title, content,
                category, tags, pinned, relevance, source,
                "useCount", "lastUsedAt",
                "createdAt" as created_at,
                coalesce("updatedAt", "createdAt") as updated_at
    `;
    return normalizeMemory(row);
  }, 'actualizarMemory');
}

export async function togglePinMemory(memoryId, userId) {
  if (!sql || !memoryId || !isUuid(userId)) return null;
  return withRetry(async () => {
    const [row] = await sql`
      update "Memory"
      set pinned = not pinned, "updatedAt" = now()
      where id = ${memoryId}
        and "userId" = ${userId}::uuid
        and type = 'MEMORY'
      returning id, pinned
    `;
    return row ? { id: row.id, pinned: Boolean(row.pinned) } : null;
  }, 'togglePinMemory');
}

export async function registrarUsoMemory(memoryId, userId) {
  if (!sql || !memoryId || !isUuid(userId)) return null;
  return withRetry(async () => {
    const [row] = await sql`
      update "Memory"
      set "useCount"   = "useCount" + 1,
          "lastUsedAt" = now()
      where id = ${memoryId}
        and "userId" = ${userId}::uuid
        and type = 'MEMORY'
      returning id, "useCount", "lastUsedAt"
    `;
    return row ? {
      id: row.id,
      useCount: row.useCount,
      lastUsedAt: row.lastUsedAt,
    } : null;
  }, 'registrarUsoMemory');
}

export async function eliminarMemory(memoryId, userId) {
  if (!sql || !memoryId || !isUuid(userId)) return false;
  const ok = await withRetry(async () => {
    const r = await sql`
      delete from "Memory"
      where id = ${memoryId}
        and "userId" = ${userId}::uuid
    `;
    return r.count > 0;
  }, 'eliminarMemory');
  return Boolean(ok);
}

export async function eliminarTodasMemories(userId) {
  if (!sql || !isUuid(userId)) return 0;
  const n = await withRetry(async () => {
    const r = await sql`
      delete from "Memory"
      where "userId" = ${userId}::uuid
        and type = 'MEMORY'
    `;
    return r.count || 0;
  }, 'eliminarTodasMemories');
  return n || 0;
}

export async function eliminarMemoriesBulk(userId, ids) {
  if (!sql || !isUuid(userId) || !Array.isArray(ids) || !ids.length) return 0;
  const cleanIds = ids.filter(isUuid);
  if (!cleanIds.length) return 0;

  const n = await withRetry(async () => {
    const r = await sql`
      delete from "Memory"
      where "userId" = ${userId}::uuid
        and type = 'MEMORY'
        and id = any(${cleanIds}::text[])
    `;
    return r.count || 0;
  }, 'eliminarMemoriesBulk');
  return n || 0;
}

export async function actualizarMemoriesBulk(userId, ids, patch = {}) {
  if (!sql || !isUuid(userId) || !Array.isArray(ids) || !ids.length) return 0;
  const cleanIds = ids.filter(isUuid);
  if (!cleanIds.length) return 0;

  const addTags    = Array.isArray(patch.addTags)    ? patch.addTags    : null;
  const removeTags = Array.isArray(patch.removeTags) ? patch.removeTags : null;
  const setPinned  = typeof patch.pinned === 'boolean' ? patch.pinned : null;
  const setCategory = patch.category != null ? String(patch.category).toLowerCase().trim() : null;
  const setRelevance = Number.isFinite(patch.relevance) ? Math.trunc(patch.relevance) : null;

  if (addTags === null && removeTags === null && setPinned === null &&
      setCategory === null && setRelevance === null) return 0;

  const n = await withRetry(async () => {
    const r = await sql`
      update "Memory"
      set
        tags      = case
                      when ${addTags}::text[] is not null and ${removeTags}::text[] is not null
                        then array(select unnest(tags || ${addTags}::text[]) except select unnest(${removeTags}::text[]))
                      when ${addTags}::text[] is not null
                        then (select array(select distinct unnest(tags || ${addTags}::text[])))
                      when ${removeTags}::text[] is not null
                        then array(select unnest(tags) except select unnest(${removeTags}::text[]))
                      else tags
                    end,
        pinned    = coalesce(${setPinned},    pinned),
        category  = coalesce(${setCategory},  category),
        relevance = coalesce(${setRelevance}, relevance),
        "updatedAt" = now()
      where "userId" = ${userId}::uuid
        and type = 'MEMORY'
        and id = any(${cleanIds}::text[])
    `;
    return r.count || 0;
  }, 'actualizarMemoriesBulk');
  return n || 0;
}

export async function listarTodasMemories(userId) {
  if (!sql || !isUuid(userId)) return [];
  const rows = await withRetry(async () => {
    return await sql`
      select id, "userId" as user_id, title, content,
             category, tags, pinned, relevance, source,
             "useCount", "lastUsedAt",
             "createdAt" as created_at,
             coalesce("updatedAt", "createdAt") as updated_at
      from "Memory"
      where "userId" = ${userId}::uuid
        and type = 'MEMORY'
      order by "createdAt" asc
    `;
  }, 'listarTodasMemories');
  return (rows || []).map(normalizeMemory);
}

export async function statsMemories(userId) {
  if (!sql || !isUuid(userId)) {
    return { total: 0, pinned: 0, byCategory: {}, topTags: [], weekDelta: 0 };
  }

  return withRetry(async () => {
    const catRows = await sql`
      select
        coalesce(category, 'general') as category,
        count(*)::int as total,
        count(*) filter (where pinned)::int as pinned
      from "Memory"
      where "userId" = ${userId}::uuid and type = 'MEMORY'
      group by category
    `;

    const tagRows = await sql`
      select tag, count(*)::int as total
      from "Memory", unnest(tags) as tag
      where "userId" = ${userId}::uuid and type = 'MEMORY'
      group by tag
      order by total desc
      limit 10
    `;

    const weekRows = await sql`
      select
        count(*) filter (where "createdAt" >= now() - interval '7 days')::int as this_week,
        count(*) filter (where "createdAt" >= now() - interval '14 days'
                          and "createdAt" <  now() - interval '7 days')::int as last_week
      from "Memory"
      where "userId" = ${userId}::uuid and type = 'MEMORY'
    `;

    const byCategory = {};
    let total = 0, pinned = 0;
    for (const r of catRows) {
      byCategory[r.category] = r.total;
      total += r.total;
      pinned += r.pinned;
    }

    const wk = weekRows[0] || { this_week: 0, last_week: 0 };

    return {
      total,
      pinned,
      byCategory,
      topTags: tagRows.map(r => ({ tag: r.tag, total: r.total })),
      weekDelta: (wk.this_week || 0) - (wk.last_week || 0),
      thisWeek: wk.this_week || 0,
      lastWeek: wk.last_week || 0,
    };
  }, 'statsMemories');
}

export async function listarTagsUnicos(userId) {
  if (!sql || !isUuid(userId)) return [];
  const rows = await withRetry(async () => {
    return await sql`
      select tag, count(*)::int as total
      from "Memory", unnest(tags) as tag
      where "userId" = ${userId}::uuid and type = 'MEMORY'
      group by tag
      order by total desc, tag asc
    `;
  }, 'listarTagsUnicos');
  return (rows || []).map(r => ({ tag: r.tag, total: r.total }));
}

export async function listarMemoriasRelacionadas(userId, memoryId, { limit = 5 } = {}) {
  if (!sql || !isUuid(userId) || !memoryId) return [];
  const lim = clamp(limit, 1, 20, 5);
  const rows = await withRetry(async () => {
    return await sql`
      select m.id, m."userId" as user_id, m.title, m.content,
             m.category, m.tags, m.pinned, m.relevance, m.source,
             m."useCount", m."lastUsedAt",
             m."createdAt" as created_at,
             coalesce(m."updatedAt", m."createdAt") as updated_at,
             (select count(*) from unnest(m.tags) t where t = any(src.tags))::int as shared_tags
      from "Memory" m,
           (select tags from "Memory" where id = ${memoryId} and "userId" = ${userId}::uuid limit 1) src
      where m."userId" = ${userId}::uuid
        and m.type = 'MEMORY'
        and m.id <> ${memoryId}
        and m.tags && src.tags
      order by shared_tags desc, m.pinned desc, m."createdAt" desc
      limit ${lim}
    `;
  }, 'listarMemoriasRelacionadas');
  return (rows || []).map(normalizeMemory);
}

export async function contarMemoriaSimilar(userId, text) {
  if (!sql || !isUuid(userId)) return 0;
  const clean = String(text || '').trim().toLowerCase();
  if (!clean) return 0;
  const r = await withRetry(async () => {
    const [row] = await sql`
      select count(*)::int as total
      from "Memory"
      where "userId" = ${userId}::uuid
        and type = 'MEMORY'
        and lower(trim(content)) = ${clean}
    `;
    return row?.total ?? 0;
  }, 'contarMemoriaSimilar');
  return r || 0;
}

export async function listarMemories(userId, { limit = CONFIG.default_limit } = {}) {
  if (!sql || !isUuid(userId)) return [];
  const lim = clamp(limit, 1, CONFIG.max_limit, CONFIG.default_limit);
  const rows = await withRetry(async () => {
    return await sql`
      select id, "userId" as user_id, title, content,
             "createdAt" as created_at
      from "Memory"
      where "userId" = ${userId}::uuid
        and type = 'MEMORY'
      order by "createdAt" desc
      limit ${lim}
    `;
  }, 'listarMemories');
  return (rows || []).map(normalizeMemorySimple);
}

export async function crearMemory(userId, text) {
  if (!sql || !isUuid(userId)) return null;
  const clean = String(text || '').trim();
  if (!clean) return null;

  const title = clean.length > 60 ? clean.slice(0, 57).trimEnd() + '…' : clean;

  return withRetry(async () => {
    const id = uid();
    const [row] = await sql`
      insert into "Memory" (id, "userId", title, content, type, "createdAt")
      values (${id}, ${userId}::uuid, ${title}, ${clean}, 'MEMORY', now())
      returning id, "userId" as user_id, title, content,
                "createdAt" as created_at
    `;
    return normalizeMemorySimple(row);
  }, 'crearMemory');
}

export async function countMemories(userId) {
  if (!sql || !isUuid(userId)) return 0;
  const r = await withRetry(async () => {
    const [row] = await sql`
      select count(*)::int as total
      from "Memory"
      where "userId" = ${userId}::uuid and type = 'MEMORY'
    `;
    return row?.total ?? 0;
  }, 'countMemories');
  return r ?? 0;
}

/* ═══════════════════════════════════════════════════════════════════════
   9 · STATS + HEALTH
   ═══════════════════════════════════════════════════════════════════════ */

export async function getUserStats(userId) {
  if (!sql || !isUuid(userId)) {
    return { chats: 0, messages: 0, memories: 0 };
  }
  const r = await withRetry(async () => {
    const [chatsRow] = await sql`
      select count(*)::int as total
      from "Chat" where "userId" = ${userId}::uuid and "isGhost" = false
    `;
    const [msgsRow] = await sql`
      select count(*)::int as total
      from "Message" m
      join "Chat" c on c.id = m."chatId"
      where c."userId" = ${userId}::uuid
    `;
    const [memsRow] = await sql`
      select count(*)::int as total
      from "Memory"
      where "userId" = ${userId}::uuid and type = 'MEMORY'
    `;
    return {
      chats:    chatsRow?.total ?? 0,
      messages: msgsRow?.total ?? 0,
      memories: memsRow?.total ?? 0,
    };
  }, 'getUserStats');
  return r ?? { chats: 0, messages: 0, memories: 0 };
}

export async function pingDatabase() {
  if (!sql) {
    return { ok: false, error: sqlError?.message || 'Cliente no inicializado' };
  }
  try {
    const t0 = Date.now();
    await sql`select 1 as ok`;
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    log('pingDatabase', e);
    return { ok: false, error: e.message };
  }
}

export async function listarTablas() {
  if (!sql) return [];
  const rows = await withRetry(async () => {
    return await sql`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
      order by table_name
    `;
  }, 'listarTablas');
  return (rows || []).map(r => r.table_name);
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · COMPATIBILIDAD RETRO
   ═══════════════════════════════════════════════════════════════════════ */

export const findOrCreateUser = createProfile;

/* ═══════════════════════════════════════════════════════════════════════
   11 · BOOT
   ═══════════════════════════════════════════════════════════════════════ */

if (sql) {
  console.log('[sb] cliente Postgres listo · pool 10 · v4.1');
} else {
  console.warn('[sb] sin cliente Postgres · DATABASE_URL:', DATABASE_URL ? 'sí' : 'no');
}