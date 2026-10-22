/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/theme-manager.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Preferencia de tema del usuario: 'dark' | 'light' | 'system'.

   FLUJO
     1. El frontend lee el tema desde el perfil y lo aplica ANTES de
        pintar (evita el parpadeo del tema claro).
     2. El usuario cambia el tema → se guarda en la base (tabla
        `user_settings`) y se aplica al instante.
     3. Con `system` se sigue al `prefers-color-scheme` del sistema y se
        actualiza solo cuando el sistema cambia.

   POR QUÉ EN LA BASE Y NO EN localStorage
     El tema es una preferencia de la cuenta: tiene que viajar con el
     usuario entre dispositivos. localStorage se usa sólo como caché
     optimista para el primer pintado.

   ESQUEMA `user_settings`
     user_id (pk), theme, updated_at
   ═══════════════════════════════════════════════════════════════════════════ */

import { sql, supabaseDisponible } from './supabase.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

export const THEMES = Object.freeze(['dark', 'light', 'system']);

const CFG = Object.freeze({
  table: 'user_settings',
  cacheTtlMs: 60_000,
  localStorageKey: 'nm_theme',
  defaultTheme: 'dark',
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · CACHE
   ═══════════════════════════════════════════════════════════════════════════ */

const cache = new Map();   // userId → { theme, at }

function cacheGet(userId) {
  const hit = cache.get(userId);
  if (!hit) return null;
  if (Date.now() - hit.at > CFG.cacheTtlMs) {
    cache.delete(userId);
    return null;
  }
  return hit.value;
}

function cacheSet(userId, theme) {
  cache.set(userId, { theme, at: Date.now() });
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · ESQUEMA
   ═══════════════════════════════════════════════════════════════════════════ */

let schemaPromise = null;

async function ensureSchema() {
  if (!supabaseDisponible()) return { ok: false };
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
      return { ok: true };
    } catch (e) {
      LOG.warn('theme-manager: no se pudo crear el esquema', { error: e.message, code: e.code });
      return { ok: false };
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · NORMALIZACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

export function normalizeTheme(theme) {
  const value = String(theme || '').toLowerCase().trim();
  if (THEMES.includes(value)) return value;
  if (value === 'claro' || value === 'light-mode') return 'light';
  if (value === 'oscuro' || value === 'dark-mode') return 'dark';
  return CFG.defaultTheme;
}

/**
 * Resuelve 'system' al tema efectivo según la preferencia del SO.
 */
export function resolveTheme(theme) {
  const normalized = normalizeTheme(theme);

  if (normalized !== 'system') return normalized;

  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · API
   ═══════════════════════════════════════════��══════════════════════════════ */

/**
 * Lee el tema del usuario.
 *
 * @param {string} userId
 * @returns {Promise<object>} { ok, theme, effective, degraded }
 */
export async function getTheme(userId) {
  if (!userId) {
    return { ok: true, theme: CFG.defaultTheme, effective: resolveTheme(CFG.defaultTheme), degraded: true };
  }

  const cached = cacheGet(userId);
  if (cached) {
    return { ok: true, theme: cached, effective: resolveTheme(cached), degraded: false, cached: true };
  }

  if (!supabaseDisponible()) {
    return {
      ok: true,
      theme: CFG.defaultTheme,
      effective: resolveTheme(CFG.defaultTheme),
      degraded: true,
    };
  }

  try {
    await ensureSchema();

    const rows = await sql`
      select theme from ${sql(CFG.table)} where user_id = ${userId}::uuid limit 1
    `;

    const theme = rows.length ? normalizeTheme(rows[0].theme) : CFG.defaultTheme;
    cacheSet(userId, theme);

    return { ok: true, theme, effective: resolveTheme(theme), degraded: false, cached: false };
  } catch (e) {
    LOG.warn('theme-manager: getTheme falló', { error: e.message });
    return {
      ok: true,
      theme: CFG.defaultTheme,
      effective: resolveTheme(CFG.defaultTheme),
      degraded: true,
    };
  }
}

/**
 * Guarda el tema del usuario.
 *
 * @param {string} userId
 * @param {string} theme  'dark' | 'light' | 'system'
 * @returns {Promise<object>} { ok, theme, effective }
 */
export async function setTheme(userId, theme) {
  const normalized = normalizeTheme(theme);

  if (!userId) {
    return { ok: false, error: 'Se requiere userId.' };
  }

  cacheSet(userId, normalized);

  if (!supabaseDisponible()) {
    return { ok: true, theme: normalized, effective: resolveTheme(normalized), degraded: true };
  }

  try {
    await ensureSchema();

    await sql`
      insert into ${sql(CFG.table)} (user_id, theme, updated_at)
      values (${userId}::uuid, ${normalized}, now())
      on conflict (user_id) do update
        set theme = excluded.theme, updated_at = now()
    `;

    LOG.info('theme-manager: tema actualizado', { userId, theme: normalized });

    return { ok: true, theme: normalized, effective: resolveTheme(normalized), degraded: false };
  } catch (e) {
    LOG.error('theme-manager: setTheme falló', { error: e.message, code: e.code });
    return { ok: false, error: 'No se pudo guardar el tema.' };
  }
}

/**
 * Devuelve el tema + la info que el frontend necesita para aplicarlo.
 * Se usa en el endpoint que el frontend consulta al cargar.
 */
export async function getThemePayload(userId) {
  const result = await getTheme(userId);

  return {
    ok: true,
    theme: result.theme,
    effective: result.effective,
    available: THEMES,
    degraded: Boolean(result.degraded),
  };
}

export function invalidateThemeCache(userId) {
  if (userId) cache.delete(userId);
  else cache.clear();
}

export function getThemeConfig() {
  return {
    themes: THEMES,
    defaultTheme: CFG.defaultTheme,
    cacheTtlMs: CFG.cacheTtlMs,
    localStorageKey: CFG.localStorageKey,
  };
}

export default {
  getTheme,
  setTheme,
  getThemePayload,
  normalizeTheme,
  resolveTheme,
  invalidateThemeCache,
  getThemeConfig,
  THEMES,
};
