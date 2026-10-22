/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/theme-manager.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Preferencia de tema del usuario: 'dark' | 'light'.

   POR QUÉ EN LA BASE Y NO EN localStorage
     El tema es una preferencia de la cuenta: tiene que viajar con el
     usuario entre dispositivos. localStorage se usa sólo como caché
     optimista para el primer pintado (evita el parpadeo).

   ESQUEMA `user_settings`
     user_id (pk uuid), theme text not null default 'dark',
     updated_at timestamptz not null default now()
   ═══════════════════════════════════════════════════════════════════════ */

import { sql, supabaseDisponible } from '../src/services/supabase.js';
import { LOG } from '../src/lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

export const THEMES = Object.freeze(['dark', 'light']);

const CFG = Object.freeze({
  table: 'user_settings',
  defaultTheme: 'dark',
  cacheTtlMs: 60_000,
});

/** userId → { theme, at } */
const cache = new Map();

/* ═══════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

function isUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Normaliza el tema recebido. Cualquier valor desconocido cae en el
 * tema por defecto ('dark').
 *
 * @param {string} theme
 * @returns {'dark'|'light'}
 */
export function normalizeTheme(theme) {
  const value = String(theme ?? '').toLowerCase().trim();

  if (value === 'light' || value === 'claro') return 'light';
  if (value === 'dark' || value === 'oscuro') return 'dark';

  return CFG.defaultTheme;
}

function cacheGet(userId) {
  const hit = cache.get(userId);
  if (!hit) return null;
  if (Date.now() - hit.at > CFG.cacheTtlMs) {
    cache.delete(userId);
    return null;
  }
  return hit.theme;
}

function cacheSet(userId, theme) {
  cache.set(userId, { theme, at: Date.now() });
}

/** Limpia la caché de temas. */
export function clearThemeCache() {
  cache.clear();
}

/* ═══════════════════════════════════════════════════════════════════════
   03 · ESQUEMA
   ═══════════════════════════════════════════════════════════════════════ */

let schemaPromise = null;

async function ensureSchema() {
  if (!supabaseDisponible()) return false;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    try {
      await sql`
        create table if not exists ${sql(CFG.table)} (
          user_id    uuid primary key,
          theme      text not null default 'dark',
          updated_at timestamptz not null default now()
        )
      `;
      return true;
    } catch (e) {
      LOG.warn('theme-manager: no se pudo crear el esquema', { error: e.message, code: e.code });
      return false;
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════
   04 · API
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Lee el tema del usuario.
 * @param {string} userId
 * @returns {Promise<'dark'|'light'>}
 */
export async function getTheme(userId) {
  if (!isUuid(userId)) return CFG.defaultTheme;

  const cached = cacheGet(userId);
  if (cached) return cached;

  if (!supabaseDisponible()) return CFG.defaultTheme;

  try {
    await ensureSchema();
    const rows = await sql`
      select theme from ${sql(CFG.table)}
      where user_id = ${userId}::uuid
      limit 1
    `;

    const theme = normalizeTheme(rows?.[0]?.theme);
    cacheSet(userId, theme);
    return theme;
  } catch (e) {
    LOG.warn('theme-manager: no se pudo leer el tema', { userId, error: e.message });
    return CFG.defaultTheme;
  }
}

/**
 * Guarda el tema del usuario.
 *
 * @param {string} userId
 * @param {string} theme  'dark' | 'light'
 * @returns {Promise<{ok:boolean, theme:'dark'|'light', error:string|null}>}
 */
export async function setTheme(userId, theme) {
  const normalized = normalizeTheme(theme);

  if (!supabaseDisponible() || !isUuid(userId)) {
    return { ok: false, theme: normalized, error: 'INVALID_USER_OR_DB' };
  }

  try {
    await ensureSchema();

    await sql`
      insert into ${sql(CFG.table)} (user_id, theme, updated_at)
      values (${userId}::uuid, ${normalized}, now())
      on conflict (user_id) do update
        set theme = ${normalized},
            updated_at = now()
    `;

    cacheSet(userId, normalized);
    return { ok: true, theme: normalized, error: null };
  } catch (e) {
    LOG.warn('theme-manager: no se pudo guardar el tema', {
      userId, error: e.message, code: e.code,
    });
    return { ok: false, theme: normalized, error: e.message };
  }
}

/**
 * Alterna entre 'dark' y 'light' y guarda el resultado.
 * @param {string} userId
 * @returns {Promise<{ok:boolean, theme:'dark'|'light', error:string|null}>}
 */
export async function toggleTheme(userId) {
  const current = await getTheme(userId);
  return setTheme(userId, current === 'dark' ? 'light' : 'dark');
}

export default {
  getTheme,
  setTheme,
  toggleTheme,
  normalizeTheme,
  clearThemeCache,
  THEMES,
};
