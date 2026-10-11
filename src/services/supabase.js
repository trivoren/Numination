/* ═══════════════════════════════════════════════════════════════════════════
   
                            ███╗   ██╗██╗   ██╗███╗   ███╗██╗
                            ████╗  ██║██║   ██║████╗ ████║██║
                            ██╔██╗ ██║██║   ██║██╔████╔██║██║
                            ██║╚██╗██║██║   ██║██║╚██╔╝██║██║
                            ██║ ╚████║╚██████╔╝██║ ╚═╝ ██║███████╗
                            ╚═╝  ╚═══╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝
   
                         S U P A B A S E   ·   v 4 . 0

   ─────────────────────────────────────────────────────────────────────────
   La única capa que habla con Postgres. Todo lo demás depende de esto.
   
   No hay queries aquí afuera. No hay conexiones sueltas. No hay atajos.
   Si querés leer o escribir en la base de datos, es por acá. Siempre.
   
   Eso no es rigidez. Es paz mental. Un solo lugar donde debuggear cuando
   algo no cuadra. Un solo archivo donde buscar.
   
   ─────────────────────────────────────────────────────────────────────────
   
   ESTRUCTURA:
   
     1 · Cliente y configuración
     2 · Utilidades (uid, uuid, retry, transacción)
     3 · Normalizadores (PascalCase → snake_case)
     4 · Profiles (con auth v3.0)
     5 · Password + reset tokens
     6 · Chats
     7 · Messages
     8 · Memories (con ampliación v3.0)
     9 · Stats + health
    10 · Compatibilidad retro
    11 · Boot
   
   ─────────────────────────────────────────────────────────────────────────
   
   REGLAS DE ESTE ARCHIVO:
   
     · Cada función valida sus inputs antes de tocar Postgres.
     · Ninguna función tira excepción al caller. Devuelven null / [] / false.
     · Los errores se loguean con prefijo [sb], pero no explotan.
     · Los nombres de columna expuestos son snake_case (el frontend no ve
       el caos de nomenclatura de la DB).
     · Las tablas PascalCase ("Chat", "Message", "Memory") van entre
       comillas dobles. Las tablas minúsculas (profiles) van sin comillas.
     · Columnas PascalCase ("displayName", "avatarUrl", "createdAt",
       "updatedAt") van entre comillas. Columnas snake_case (password_hash,
       auth_provider) van sin comillas.
   
   ─────────────────────────────────────────────────────────────────────────
   
   SCHEMA DE REFERENCIA (por si algún día migramos todo a snake_case):

     profiles:
       id              uuid         PK
       email           text         UNIQUE
       "displayName"   text
       "avatarUrl"     text
       role            text         default 'USER'
       tier            text         default 'FREE'
       password_hash   text
       auth_provider   text         default 'google'
       email_verified  boolean      default true
       reset_token     text
       reset_token_expires timestamptz
       last_login_at   timestamptz
       "createdAt"     timestamptz  default now()
       "updatedAt"     timestamptz  default now()

     "Chat":
       id, "userId", title, mode, "isGhost",
       "createdAt", "updatedAt"

     "Message":
       id, "chatId", role, content, provider, "createdAt"

     "Memory":
       id, "userId", title, content, type,
       category, tags text[], pinned, relevance, source,
       "useCount", "lastUsedAt",
       "createdAt", "updatedAt"
   
   ═══════════════════════════════════════════════════════════════════════════ */

import postgres from 'postgres';
import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════════
   1 · CLIENTE Y CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

let TEST_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

const DATABASE_URL = process.env.DATABASE_URL ?? TEST_KEYS.DATABASE_URL;

const CONFIG = Object.freeze({
  max:              10,          // conexiones máximas en el pool
  idle_timeout:     20,          // segundos antes de cerrar una conexión ociosa
  connect_timeout:  10,          // segundos para conectar
  max_lifetime:     60 * 30,     // 30 min: recicla conexiones largas
  backoff_retries:  2,           // reintentos en errores transitorios
  backoff_base_ms:  120,         // espera base entre reintentos
  default_limit:    100,         // límite por defecto en listas
  max_limit:        500,         // límite máximo permitido
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
      onnotice: () => {},          // silenciar NOTICEs de Postgres
    });
  } catch (e) {
    sqlError = e;
    console.warn('[sb] no se pudo crear el cliente:', e.message);
  }
} else {
  sqlError = new Error('DATABASE_URL no configurada');
  console.warn('[sb] DATABASE_URL no configurada');
}

/** ¿Tenemos cliente de Postgres disponible? */
export function supabaseDisponible() {
  return Boolean(sql);
}

/** Exportamos el cliente crudo por si algún endpoint lo necesita */
export { sql };

/* ═══════════════════════════════════════════════════════════════════════════
   2 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

/** UUID v4 con fallback para runtimes sin crypto.randomUUID */
function uid() {
  try { return crypto.randomUUID(); }
  catch { return crypto.randomBytes(16).toString('hex'); }
}

/** Normaliza un email a minúsculas y sin espacios */
function normEmail(e) {
  return String(e || '').trim().toLowerCase();
}

/** Valida formato UUID v4 (acepta cualquier UUID válido) */
function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Log con prefijo [sb] y nombre de operación */
function log(op, err) {
  console.warn(`[sb] ${op}:`, err?.message || err);
}

/**
 * Ejecuta `fn` con reintentos exponenciales cortos.
 * Solo reintenta en errores que parecen transitorios.
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
        e?.code === '57P01' ||     // admin shutdown
        e?.code === '57P02' ||     // crash shutdown
        /timeout|connection|socket/i.test(msg);
      if (!transient || i === CONFIG.backoff_retries) break;
      await new Promise(r => setTimeout(r, CONFIG.backoff_base_ms * (i + 1)));
    }
  }
  log(op, lastErr);
  return null;
}

/**
 * Ejecuta varias operaciones dentro de una transacción.
 * `fn` recibe el cliente transaccional y debe devolver el resultado.
 * Si algo falla, se revierte todo. Devuelve null si hubo error.
 */
async function tx(fn, op) {
  if (!sql) return null;
  try {
    return await sql.begin(async (trx) => fn(trx));
  } catch (e) {
    log(op || 'tx', e);
    return null;
  }
}

/** Asegura que un número esté dentro de un rango */
function clamp(n, min, max, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/* ═══════════════════════════════════════════════════════════════════════════
   3 · NORMALIZADORES
   ═══════════════════════════════════════════════════════════════════════════
   Convertimos filas de Postgres a objetos planos con snake_case.
   El frontend no sabe (ni tiene por qué saber) cómo se llaman las columnas.
   ═══════════════════════════════════════════════════════════════════════════ */

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
    provider: row.provider || null,
    created_at: row.created_at || row.createdAt || null,
  };
}

/**
 * Normaliza una fila de Memory (incluye TODO lo de v3.0:
 * tags, relevance, source, useCount, lastUsedAt).
 */
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

/** Versión simple para compatibilidad con código viejo (sin los campos v3.0) */
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

/**
 * Normaliza una fila de profiles.
 * Acepta tanto PascalCase (displayName, avatarUrl) como snake_case (name, picture)
 * y consolida todo en un objeto uniforme.
 */
function normalizeProfile(row) {
  if (!row) return null;

  // tier → plan legible
  const tierRaw = String(row.tier || 'FREE').toUpperCase();
  const plan =
    tierRaw === 'PRO'     ? 'pro-coder' :
    tierRaw === 'PREMIUM' ? 'pro-plus'  :
    tierRaw === 'MADMAX'  ? 'pro-mad-max' :
                            'free';

  // Nombre: acepta name (alias), displayName (columna real), o email
  const name =
    row.name ||
    row.displayName ||
    (row.email ? row.email.split('@')[0] : 'Usuario');

  // Foto: igual, acepta ambos
  const picture =
    row.picture ||
    row.avatarUrl ||
    null;

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

/** Igual que normalizeProfile pero sin password_hash (seguro para el front) */
function profilePublic(row) {
  const p = normalizeProfile(row);
  if (!p) return null;
  delete p.password_hash;
  return p;
}

/* ═══════════════════════════════════════════════════════════════════════════
   4 · PROFILES
   ═══════════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────────────────
   getProfile · un perfil por id (versión pública, sin hash)
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   getProfileFull · un perfil por id (CON password_hash)
   
   Solo lo usa auth.js. NUNCA exponer al frontend.
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   getProfileByEmail · por email (case-insensitive, público)
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   getProfileByEmailFull · por email (CON password_hash)
   
   Lo usa auth.js en /login para verificar contraseñas.
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   createProfile · crea un perfil nuevo
   
   Acepta:
     createProfile({ id, email, name, picture, provider, password_hash })
     createProfile(id, email, name, picture)
   
   Si ya existe (por email), devuelve el existente sin duplicar.
   
   Escribe SOLO en las columnas reales:
     "displayName" (desde name)
     "avatarUrl"   (desde picture)
   ───────────────────────────────────────────────────────────────────────── */
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

  // Evitar duplicado por email
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

/* ─────────────────────────────────────────────────────────────────────────
   updateProfile · actualiza un perfil
   
   Acepta tanto { name, picture } (auth.js v2.0+) como { displayName, avatarUrl }.
   Los campos ausentes no se tocan.
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   updateLastLogin · marca última conexión + updatedAt
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   deleteProfile · borra perfil + todo lo relacionado
   
   Transaccional: si algo falla, no quedan huérfanos.
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   actualizarPlan · cambia el tier del usuario (FREE/PRO/PREMIUM/MADMAX)
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   countProfiles · cuenta total de usuarios (para dashboards / health)
   ───────────────────────────────────────────────────────────────────────── */
export async function countProfiles() {
  if (!sql) return 0;
  const r = await withRetry(async () => {
    const [row] = await sql`select count(*)::int as total from public.profiles`;
    return row?.total ?? 0;
  }, 'countProfiles');
  return r ?? 0;
}

/* ═══════════════════════════════════════════════════════════════════════════
   5 · PASSWORD + RESET TOKENS
   ═══════════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────────────────
   setPassword · guarda hash de contraseña
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   getPasswordHash · solo el hash (para verificar contraseña)
   ───────────────────────────────────────────────────────────────────────── */
export async function getPasswordHash(userId) {
  if (!sql || !isUuid(userId)) return null;
  const r = await withRetry(async () => {
    const [row] = await sql`
      select password_hash from public.profiles
      where id = ${userId}::uuid limit 1
    `;
    return row?.password_hash ?? null;
  }, 'getPasswordHash');
  return r;
}

/* ─────────────────────────────────────────────────────────────────────────
   setResetToken · guarda token + expiración
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   getProfileByResetToken · busca un perfil por su reset_token vigente
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   clearResetToken · limpia el token de reset
   ───────────────────────────────────────────────────────────────────────── */
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

/* ═══════════════════════════════════════════════════════════════════════════
   6 · CHATS
   ═══════════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────────────────
   crearChat · crea una conversación nueva
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   listarChats · lista las conversaciones del usuario
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   obtenerChat · un chat con todos sus mensajes
   ───────────────────────────────────────────────────────────────────────── */
export async function obtenerChat(chatId, userId) {
  if (!sql || !chatId || !isUuid(userId)) return null;
  return withRetry(async () => {
    const [chat] = await sql`
      select id, title, mode,
             "createdAt" as created_at,
             "updatedAt" as updated_at
      from "Chat"
      where id = ${chatId}
        and "userId" = ${userId}::uuid
      limit 1
    `;
    if (!chat) return null;

    const messages = await sql`
      select id, "chatId" as chat_id, role, content, provider,
             "createdAt" as created_at
      from "Message"
      where "chatId" = ${chatId}
      order by "createdAt" asc
    `;

    return {
      ...normalizeChat(chat),
      messages: messages.map(normalizeMessage),
    };
  }, 'obtenerChat');
}

/* ─────────────────────────────────────────────────────────────────────────
   eliminarChat · borra un chat y todos sus mensajes (transaccional)
   ───────────────────────────────────────────────────────────────────────── */
export async function eliminarChat(chatId, userId) {
  if (!sql || !chatId || !isUuid(userId)) return false;
  const ok = await tx(async (trx) => {
    const [chat] = await trx`
      select id from "Chat"
      where id = ${chatId} and "userId" = ${userId}::uuid
      limit 1
    `;
    if (!chat) return false;

    await trx`delete from "Message" where "chatId" = ${chatId}`;
    const r = await trx`delete from "Chat" where id = ${chatId}`;
    return r.count > 0;
  }, 'eliminarChat');
  return Boolean(ok);
}

/* ─────────────────────────────────────────────────────────────────────────
   renombrarChat · cambia el título de un chat
   ───────────────────────────────────────────────────────────────────────── */
export async function renombrarChat(chatId, userId, newTitle) {
  if (!sql || !chatId || !isUuid(userId)) return null;
  const clean = String(newTitle || '').trim().slice(0, 80);
  if (!clean) return null;
  return withRetry(async () => {
    const [row] = await sql`
      update "Chat"
      set title = ${clean}, "updatedAt" = now()
      where id = ${chatId} and "userId" = ${userId}::uuid
      returning id, title, mode,
                "createdAt" as created_at,
                "updatedAt" as updated_at
    `;
    return normalizeChat(row);
  }, 'renombrarChat');
}

/* ─────────────────────────────────────────────────────────────────────────
   buscarChats · busca chats por título (ILIKE)
   ───────────────────────────────────────────────────────────────────────── */
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

/* ═══════════════════════════════════════════════════════════════════════════
   7 · MESSAGES
   ═══════════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────────────────
   crearMensaje · guarda un mensaje en un chat
   ───────────────────────────────────────────────────────────────────────── */
export async function crearMensaje(chatId, { role, content, provider = null }) {
  if (!sql || !chatId) return null;
  if (role !== 'user' && role !== 'ai' && role !== 'assistant') return null;

  const cleanRole = role === 'assistant' ? 'ai' : role;
  const text = String(content ?? '');
  if (!text.trim()) return null;

  return withRetry(async () => {
    const id = uid();
    const [row] = await sql`
      insert into "Message" (id, "chatId", role, content, provider, "createdAt")
      values (${id}, ${chatId}, ${cleanRole}, ${text}, ${provider}, now())
      returning id, "chatId" as chat_id, role, content, provider,
                "createdAt" as created_at
    `;

    // Toca el "updatedAt" del chat para que suba en la lista
    await sql`
      update "Chat" set "updatedAt" = now() where id = ${chatId}
    `;

    return normalizeMessage(row);
  }, 'crearMensaje');
}

/* ─────────────────────────────────────────────────────────────────────────
   listarMensajes · todos los mensajes de un chat (ordenados)
   ───────────────────────────────────────────────────────────────────────── */
export async function listarMensajes(chatId, { limit = CONFIG.max_limit } = {}) {
  if (!sql || !chatId) return [];
  const lim = clamp(limit, 1, CONFIG.max_limit, CONFIG.max_limit);
  const rows = await withRetry(async () => {
    return await sql`
      select id, "chatId" as chat_id, role, content, provider,
             "createdAt" as created_at
      from "Message"
      where "chatId" = ${chatId}
      order by "createdAt" asc
      limit ${lim}
    `;
  }, 'listarMensajes');
  return (rows || []).map(normalizeMessage);
}

/* ─────────────────────────────────────────────────────────────────────────
   vaciarChat · borra todos los mensajes de un chat (deja el chat)
   ───────────────────────────────────────────────────────────────────────── */
export async function vaciarChat(chatId) {
  if (!sql || !chatId) return false;
  const ok = await tx(async (trx) => {
    const r = await trx`delete from "Message" where "chatId" = ${chatId}`;
    await trx`update "Chat" set "updatedAt" = now() where id = ${chatId}`;
    return r.count;
  }, 'vaciarChat');
  return (ok ?? 0) > 0;
}

/* ═══════════════════════════════════════════════════════════════════════════
   8 · MEMORIES
   ═══════════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────────────────
   getMemory · una memoria por id (v3.0)
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   listarMemoriesConFiltros · lista con filtros opcionales (v3.0)
   
   opts: { category, tags[], pinned, sort, limit, offset, minRelevance }
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   buscarMemories · búsqueda con ranking ponderado (v3.0)
   
   Puntúa:
     · title ilike    → 100 puntos
     · content ilike  → 50 puntos
     · relevance * 2  → hasta 20 puntos
     · useCount       → hasta 10 puntos
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   actualizarMemory · actualiza texto, categoría, tags, pin, relevance (v3.0)
   ───────────────────────────────────────────────────────────────────────── */
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

  // Auto-título si cambió el texto y no hay título explícito
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

/* ─────────────────────────────────────────────────────────────────────────
   togglePinMemory · invierte el estado de pin
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   registrarUsoMemory · incrementa useCount + marca lastUsedAt (v3.0)
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   eliminarMemory · borra una memoria puntual
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   eliminarTodasMemories · borra TODAS las memorias del usuario
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   eliminarMemoriesBulk · borra varias por id (bulk)
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   actualizarMemoriesBulk · actualiza varias (pin, tags, categoría)
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   listarTodasMemories · todas sin paginar (para export / stats)
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   statsMemories · totales, por categoría, top tags, tendencia semanal
   ───────────────────────────────────────────────────────────────────────── */
export async function statsMemories(userId) {
  if (!sql || !isUuid(userId)) {
    return { total: 0, pinned: 0, byCategory: {}, topTags: [], weekDelta: 0 };
  }

  return withRetry(async () => {
    // Totales + por categoría
    const catRows = await sql`
      select
        coalesce(category, 'general') as category,
        count(*)::int as total,
        count(*) filter (where pinned)::int as pinned
      from "Memory"
      where "userId" = ${userId}::uuid and type = 'MEMORY'
      group by category
    `;

    // Top tags (los 10 más usados)
    const tagRows = await sql`
      select tag, count(*)::int as total
      from "Memory", unnest(tags) as tag
      where "userId" = ${userId}::uuid and type = 'MEMORY'
      group by tag
      order by total desc
      limit 10
    `;

    // Comparativa última semana vs anterior
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

/* ─────────────────────────────────────────────────────────────────────────
   listarTagsUnicos · todos los tags del usuario con contador
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   listarMemoriasRelacionadas · memorias que comparten tags (v3.0)
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   contarMemoriaSimilar · cuenta cuántas memorias tienen el mismo texto
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   listarMemories · versión simple (compatibilidad con memories.js v1.0)
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   crearMemory · crea una memoria simple (compatible con v1.0)
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   countMemories · cuenta de memorias del usuario
   ───────────────────────────────────────────────────────────────────────── */
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

/* ═══════════════════════════════════════════════════════════════════════════
   9 · STATS + HEALTH
   ═══════════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────────────────
   getUserStats · chats / mensajes / memorias del usuario
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   pingDatabase · health check con latencia
   ───────────────────────────────────────────────────────────────────────── */
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

/* ─────────────────────────────────────────────────────────────────────────
   listarTablas · todas las tablas de public (útil para debug)
   ───────────────────────────────────────────────────────────────────────── */
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

/* ═══════════════════════════════════════════════════════════════════════════
   10 · COMPATIBILIDAD RETRO
   ═══════════════════════════════════════════════════════════════════════════
   Alias viejos que algunos archivos importan. No los borres hasta que
   confirmes que nadie los usa.
   ═══════════════════════════════════════════════════════════════════════════ */

export const findOrCreateUser = createProfile;

/* ═══════════════════════════════════════════════════════════════════════════
   11 · BOOT
   ═══════════════════════════════════════════════════════════════════════════ */

if (sql) {
  console.log('[sb] cliente Postgres listo · pool 10 · v4.0');
} else {
  console.warn('[sb] sin cliente Postgres · DATABASE_URL:', DATABASE_URL ? 'sí' : 'no');
}

/* ═══════════════════════════════════════════════════════════════════════════
   FIN.
   
   Si leíste hasta acá, gracias. Este archivo es el que va a sostener todo
   Numination. Cada chat, cada memoria, cada sesión de Google pasa por acá.
   
   Que no se rompa.
   
   — Álvaro & Robinson, 14 años, Medellín
   ═══════════════════════════════════════════════════════════════════════════ */