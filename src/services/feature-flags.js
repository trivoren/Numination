/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/feature-flags.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Banderas de funcionalidad: encender y apagar features sin tocar código.

   POR QUÉ EXISTE
   Un `if (process.env.NEW_AI === 'true')` obliga a redeployar para
   apagar una feature. Con banderas en base de datos, el admin la
   apaga en caliente y el efecto se ve en el siguiente request.

   MODELO
   Cada bandera tiene:
     · key           identificador estable ('rag', 'sandbox', 'voice'…)
     · defaultValue  valor por defecto (si no hay fila en la BD)
     · label/description/category  metadatos para la UI del admin
     · plans         planes a los que aplica (null = todos)
     · rollout       0..100 → porcentaje de usuarios que la ven activa
                     (hash estable del userId, no aleatorio: el mismo
                      usuario siempre cae en el mismo lado)

   ALMACENAMIENTO
   Tabla `feature_flags`:
     key text primary key, enabled boolean, value jsonb,
     plans text[], rollout int, updated_by uuid, updated_at timestamptz

   Si no hay base de datos, el sistema opera con los valores por defecto
   (degradación limpia): la app nunca se cae por una bandera.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql, supabaseDisponible } from './supabase.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · REGISTRO DE BANDERAS
   ═══════════════════════════════════════════════════════════════════════════ */

const REGISTRY = Object.freeze({
  rag: {
    key: 'rag',
    defaultValue: true,
    label: 'RAG (documentos PDF)',
    description: 'Permite subir PDFs y responder con contexto recuperado.',
    category: 'ia',
    plans: null,
    rollout: 100,
  },
  images: {
    key: 'images',
    defaultValue: true,
    label: 'Generación de imágenes',
    description: 'Permite generar imágenes desde el chat.',
    category: 'ia',
    plans: null,
    rollout: 100,
  },
  voice: {
    key: 'voice',
    defaultValue: true,
    label: 'Voz (STT/TTS)',
    description: 'Transcripción y lectura en voz alta.',
    category: 'ia',
    plans: null,
    rollout: 100,
  },
  personas: {
    key: 'personas',
    defaultValue: true,
    label: 'Personas personalizadas',
    description: 'El usuario puede crear sus propios asistentes.',
    category: 'personalización',
    plans: null,
    rollout: 100,
  },
  memoryVault: {
    key: 'memoryVault',
    defaultValue: true,
    label: 'Caja fuerte de memoria',
    description: 'El usuario ve y borra lo que la IA recuerda.',
    category: 'personalización',
    plans: null,
    rollout: 100,
  },
  sandbox: {
    key: 'sandbox',
    defaultValue: false,
    label: 'Ejecutor de código',
    description: 'Ejecuta JavaScript/Python en un sandbox aislado.',
    category: 'herramientas',
    plans: ['pro', 'team'],
    rollout: 100,
  },
  webSearch: {
    key: 'webSearch',
    defaultValue: true,
    label: 'Búsqueda web',
    description: 'Permite buscar en internet desde el chat.',
    category: 'herramientas',
    plans: null,
    rollout: 100,
  },
  promptLibrary: {
    key: 'promptLibrary',
    defaultValue: true,
    label: 'Biblioteca de prompts',
    description: 'Permite guardar y reutilizar prompts con carpetas.',
    category: 'producto',
    plans: null,
    rollout: 100,
  },
  chatExport: {
    key: 'chatExport',
    defaultValue: true,
    label: 'Exportar a Markdown',
    description: 'Descarga la conversación en formato Markdown.',
    category: 'producto',
    plans: null,
    rollout: 100,
  },
  billingInvoices: {
    key: 'billingInvoices',
    defaultValue: true,
    label: 'Facturas en PDF',
    description: 'Descarga de facturas desde los ajustes.',
    category: 'pagos',
    plans: ['pro', 'team'],
    rollout: 100,
  },
  notifications: {
    key: 'notifications',
    defaultValue: true,
    label: 'Notificaciones',
    description: 'Campanita con avisos del sistema.',
    category: 'producto',
    plans: null,
    rollout: 100,
  },
  darkMode: {
    key: 'darkMode',
    defaultValue: true,
    label: 'Modo oscuro',
    description: 'Tema oscuro en toda la interfaz.',
    category: 'ui',
    plans: null,
    rollout: 100,
  },
  betaFeatures: {
    key: 'betaFeatures',
    defaultValue: false,
    label: 'Features beta',
    description: 'Muestra los experimentos internos.',
    category: 'experimental',
    plans: null,
    rollout: 20,
  },
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  cacheTtlMs: 15_000,
  table: 'feature_flags',
});

/* ═══════════════════════════════════════════════════════════════════════════
   03 · CACHE EN MEMORIA
   ═══════════════════════════════════════════════════════════════════════════ */

let cacheValue = null;
let cacheAt = 0;
let inflight = null;

function invalidate() {
  cacheValue = null;
  cacheAt = 0;
}

function defaultsMap() {
  const out = {};
  for (const [key, flag] of Object.entries(REGISTRY)) {
    out[key] = {
      key,
      enabled: flag.defaultValue,
      value: null,
      plans: flag.plans,
      rollout: flag.rollout,
      label: flag.label,
      description: flag.description,
      category: flag.category,
      defaultValue: flag.defaultValue,
      updatedAt: null,
      updatedBy: null,
    };
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · ESQUEMA
   ═══════════════════════════════════════════════════════════════════════════ */

let schemaPromise = null;

async function ensureSchema() {
  if (!supabaseDisponible()) return { ok: false };
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    try {
      await sql`
        create table if not exists ${sql(CFG.table)} (
          key        text primary key,
          enabled    boolean not null default true,
          value      jsonb,
          plans      text[],
          rollout    integer not null default 100,
          updated_by uuid,
          updated_at timestamptz not null default now()
        )
      `;
      return { ok: true };
    } catch (e) {
      LOG.warn('feature-flags: no se pudo crear la tabla', { error: e.message, code: e.code });
      return { ok: false };
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · LECTURA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Carga todas las banderas (cache 15 s).
 */
async function loadFlags({ force = false } = {}) {
  if (!force && cacheValue && Date.now() - cacheAt < CFG.cacheTtlMs) {
    return cacheValue;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const base = defaultsMap();

    if (!supabaseDisponible()) {
      cacheValue = base;
      cacheAt = Date.now();
      inflight = null;
      return base;
    }

    try {
      await ensureSchema();

      const rows = await sql`
        select
          key,
          enabled,
          value,
          plans,
          rollout,
          updated_by::text as updated_by,
          updated_at
        from ${sql(CFG.table)}
      `;

      for (const row of rows) {
        const meta = REGISTRY[row.key];
        base[row.key] = {
          ...(base[row.key] || {
            key: row.key,
            label: row.key,
            description: '',
            category: 'otro',
            defaultValue: false,
          }),
          key: row.key,
          enabled: Boolean(row.enabled),
          value: row.value ?? null,
          plans: Array.isArray(row.plans) ? row.plans : (meta?.plans ?? null),
          rollout: Number.isFinite(Number(row.rollout)) ? Number(row.rollout) : (meta?.rollout ?? 100),
          updatedAt: row.updated_at,
          updatedBy: row.updated_by || null,
          known: Boolean(meta),
        };
      }
    } catch (e) {
      LOG.warn('feature-flags: no se pudieron leer, se usan los valores por defecto', { error: e.message });
    }

    cacheValue = base;
    cacheAt = Date.now();
    inflight = null;
    return base;
  })();

  return inflight;
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · EVALUACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Hash estable de un userId → número 0..99.
 * Se usa para el rollout porcentual: el mismo usuario siempre obtiene
 * el mismo resultado (no se "mueve" de un lado a otro entre requests).
 */
function stableBucket(userId, salt = '') {
  if (!userId) return 0;
  const digest = crypto.createHash('sha256').update(`${salt}:${userId}`).digest();
  return digest[0] % 100;
}

/**
 * ¿Está la bandera activa para este contexto?
 *
 * @param {string} key
 * @param {object} [ctx]  { userId, plan, role }
 * @returns {Promise<boolean>}
 */
export async function isEnabled(key, ctx = {}) {
  const name = String(key || '');
  if (!REGISTRY[name]) {
    LOG.debug('feature-flags: bandera desconocida', { key: name });
    return false;
  }

  const flags = await loadFlags();
  const flag = flags[name];
  if (!flag) return REGISTRY[name].defaultValue;

  // Los admins ven todo activado: si algo falla, se debuggea, no se
  // pierde funcionalidad en producción.
  if (ctx.role === 'admin') return true;

  if (!flag.enabled) return false;

  if (Array.isArray(flag.plans) && flag.plans.length) {
    if (!ctx.plan || !flag.plans.includes(ctx.plan)) return false;
  }

  const rollout = Number(flag.rollout ?? 100);
  if (rollout < 100) {
    const bucket = stableBucket(ctx.userId || 'anon', name);
    if (bucket >= rollout) return false;
  }

  return true;
}

/**
 * Versión síncrona: usa sólo el cache (sin I/O).
 * Útil en rutas hot donde una llamada extra a la base no es aceptable.
 */
export function isEnabledSync(key, ctx = {}) {
  const name = String(key || '');
  const meta = REGISTRY[name];
  if (!meta) return false;
  if (!cacheValue) return meta.defaultValue;

  const flag = cacheValue[name];
  if (!flag) return meta.defaultValue;
  if (ctx.role === 'admin') return true;
  if (!flag.enabled) return false;

  if (Array.isArray(flag.plans) && flag.plans.length) {
    if (!ctx.plan || !flag.plans.includes(ctx.plan)) return false;
  }

  const rollout = Number(flag.rollout ?? 100);
  if (rollout < 100 && stableBucket(ctx.userId || 'anon', name) >= rollout) return false;

  return true;
}

/**
 * Mapa simple { banderabool } para enviarle al frontend.
 */
export async function getEnabledMap(ctx = {}) {
  const flags = await loadFlags();
  const out = {};

  for (const key of Object.keys(REGISTRY)) {
    out[key] = await isEnabled(key, ctx);
  }

  return out;
}

/**
 * Todas las banderas con su metadata (para el panel de admin).
 */
export async function listFlags() {
  const flags = await loadFlags({ force: true });
  return Object.values(flags).map((f) => ({
    key: f.key,
    enabled: Boolean(f.enabled),
    defaultValue: Boolean(f.defaultValue),
    label: f.label,
    description: f.description,
    category: f.category,
    plans: f.plans || null,
    rollout: Number(f.rollout ?? 100),
    updatedAt: f.updatedAt || null,
    updatedBy: f.updatedBy || null,
    known: f.known !== false,
  }));
}

/* ═══════════════════════════════════════════════════════════════════════════
   07 · ESCRITURA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Enciende / apaga una bandera.
 *
 * @param {string} key
 * @param {boolean} enabled
 * @param {object} [opts] { rollout, plans, userId, value }
 */
export async function setFlag(key, enabled, opts = {}) {
  const name = String(key || '');
  const meta = REGISTRY[name];

  if (!meta) {
    return { ok: false, error: `La bandera "${name}" no existe.` };
  }

  const on = Boolean(enabled);

  if (!supabaseDisponible()) {
    // Modo sin base: se aplica en memoria para que el admin vea el
    // efecto durante la sesión (no se persiste entre reinicios).
    const flags = await loadFlags();
    flags[name] = { ...flags[name], enabled: on, updatedAt: new Date().toISOString() };
    cacheAt = Date.now();
    return { ok: true, degraded: true, key: name, enabled: on };
  }

  try {
    await ensureSchema();

    const rollout = Number.isFinite(Number(opts.rollout))
      ? Math.max(0, Math.min(100, Math.round(Number(opts.rollout))))
      : meta.rollout;

    const plans = Array.isArray(opts.plans)
      ? opts.plans.filter((p) => ['free', 'pro', 'team'].includes(p))
      : (meta.plans || null);

    const rows = await sql`
      insert into ${sql(CFG.table)} (key, enabled, value, plans, rollout, updated_by, updated_at)
      values (
        ${name},
        ${on},
        ${opts.value === undefined ? null : sql.json(opts.value)},
        ${plans ? sql.array(plans) : null},
        ${rollout},
        ${opts.userId && /^[0-9a-f-]{36}$/i.test(opts.userId) ? opts.userId : null}::uuid,
        now()
      )
      on conflict (key) do update
        set enabled = excluded.enabled,
            value = excluded.value,
            plans = excluded.plans,
            rollout = excluded.rollout,
            updated_by = excluded.updated_by,
            updated_at = now()
      returning key, enabled, rollout, plans, updated_at
    `;

    invalidate();

    LOG.info('feature-flag.updated', { key: name, enabled: on, by: opts.userId || null });

    return {
      ok: true,
      key: name,
      enabled: on,
      rollout,
      plans,
      updatedAt: rows[0]?.updated_at || null,
    };
  } catch (e) {
    LOG.error('feature-flags: setFlag falló', { error: e.message, code: e.code, key: name });
    return { ok: false, error: 'No se pudo actualizar la bandera.' };
  }
}

/**
 * Devuelve una bandera a su valor por defecto (borra la fila).
 */
export async function resetFlag(key, opts = {}) {
  const name = String(key || '');
  if (!REGISTRY[name]) {
    return { ok: false, error: `La bandera "${name}" no existe.` };
  }

  if (!supabaseDisponible()) {
    const flags = await loadFlags();
    flags[name] = { ...flags[name], enabled: REGISTRY[name].defaultValue };
    cacheAt = Date.now();
    return { ok: true, degraded: true, key: name, enabled: REGISTRY[name].defaultValue };
  }

  try {
    await ensureSchema();
    await sql`delete from ${sql(CFG.table)} where key = ${name}`;
    invalidate();
    LOG.info('feature-flag.reset', { key: name, by: opts.userId || null });
    return { ok: true, key: name, enabled: REGISTRY[name].defaultValue };
  } catch (e) {
    LOG.error('feature-flags: resetFlag falló', { error: e.message, code: e.code });
    return { ok: false, error: 'No se pudo resetear la bandera.' };
  }
}

/**
 * Cambia el rollout porcentual de una bandera.
 */
export async function setRollout(key, rollout, opts = {}) {
  const name = String(key || '');
  if (!REGISTRY[name]) {
    return { ok: false, error: `La bandera "${name}" no existe.` };
  }
  const pct = Math.max(0, Math.min(100, Math.round(Number(rollout) || 0)));
  return setFlag(name, true, { ...opts, rollout: pct });
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

export function getRegistry() {
  return Object.values(REGISTRY).map((f) => ({
    key: f.key,
    label: f.label,
    description: f.description,
    category: f.category,
    defaultValue: f.defaultValue,
    plans: f.plans,
    rollout: f.rollout,
  }));
}

export function isKnownFlag(key) {
  return Object.prototype.hasOwnProperty.call(REGISTRY, String(key || ''));
}

export function invalidateFlagCache() {
  invalidate();
}

export default {
  isEnabled,
  isEnabledSync,
  getEnabledMap,
  listFlags,
  setFlag,
  resetFlag,
  setRollout,
  getRegistry,
  isKnownFlag,
  invalidateFlagCache,
};
