/* ================================================================
   NUMINATION · migrations.js · v1.0
   ----------------------------------------------------------------
   Sistema de migraciones de base de datos para Postgres/Supabase.

   ¿POR QUÉ EXISTE?
   Hoy el schema cambia cuando alguien corre SQL a mano en el panel
   de Supabase. No hay historial de quién cambió qué, ni manera de
   saber si un entorno (dev/prod) está al día, ni forma de aplicar
   el mismo cambio en dos proyectos distintos sin copy-paste.

   Con este archivo:
     · Cada cambio de schema es una migración versionada
     · Se aplican en orden, una sola vez
     · Se guarda historial con checksum (detecta drift)
     · Se puede rollback (opt-in)
     · Se puede dry-run (ver qué va a pasar)
     · Se puede correr desde CLI o desde un endpoint admin
     · Es idempotente: re-correr no rompe nada

   ESTRUCTURA:

     1  · Configuración
     2  · Registro de migraciones
     3  · Definiciones de las migraciones (10 migraciones)
     4  · Cliente SQL (lazy)
     5  · Tabla de control (_migrations)
     6  · Checksum
     7  · Aplicar (single, batch)
     8  · Consultar (status, pending, applied)
     9  · Rollback
    10  · Verificación de integridad
    11  · Dry run
    12  · CLI
    13  · Self-test
    14  · Exports

   USO PROGRAMÁTICO:

     import { runMigrations, getStatus } from './services/migrations.js';

     // Ver el estado
     const status = await getStatus();
     console.log('Pendientes:', status.pending.length);

     // Aplicar todas las pendientes
     const result = await runMigrations();
     console.log('Aplicadas:', result.applied.length);

   USO DESDE CLI:

     node src/services/migrations.js status
     node src/services/migrations.js pending
     node src/services/migrations.js up
     node src/services/migrations.js up --dry-run
     node src/services/migrations.js up --to 2026_10_12_005
     node src/services/migrations.js rollback 2026_10_12_005
     node src/services/migrations.js verify
     node src/services/migrations.js list

   USO DESDE ENDPOINT ADMIN:

     app.post('/api/admin/migrations/run', requireAdmin, async (req, res) => {
       const result = await runMigrations({ dryRun: Boolean(req.query.dryRun) });
       res.json(result);
     });

   FILOSOFÍA:

     · Cada migración debe ser IDEMPOTENTE (IF NOT EXISTS, etc.).
       Así, si algo falla a mitad de camino, se puede re-correr.
     · Cada migración corre en su propia transacción. Si falla,
       se hace rollback de ESA migración, no de las anteriores.
     · Los checksums detectan si el código de una migración cambió
       después de haberse aplicado.
     · Nada de borrar columnas en migraciones automáticas. Eso se
       hace a mano con supervisión.

   ================================================================ */

import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  /* Nombre de la tabla de control */
  tableName: '_migrations',

  /* Schema donde vive la tabla de control */
  schema: 'public',

  /* Timeout por migración (ms) */
  timeoutMs: 60_000,

  /* Si true, falla al encontrar checksum mismatch */
  strictChecksum: process.env.MIGRATIONS_STRICT === '1',

  /* Si true, muestra SQL en consola */
  verbose: process.env.MIGRATIONS_VERBOSE === '1',
});

/* ═══════════════════════════════════════════════════════════════════════
   2 · REGISTRO DE MIGRACIONES
   ═══════════════════════════════════════════════════════════════════════
   Array ordenado cronológicamente. El `id` debe ser único y ordenable.
   Formato: YYYY_MM_DD_NNN_descripcion
   ═══════════════════════════════════════════════════════════════════════ */

export const MIGRATIONS = Object.freeze([

  /* ───────────────────────────────────────────────────────────────
     001 · Auth columns en profiles
     Agrega todos los campos necesarios para login local + reset.
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_10_001_auth_columns',
    name: 'Add auth columns to profiles',
    async up(sql) {
      await sql`
        ALTER TABLE public.profiles
          ADD COLUMN IF NOT EXISTS password_hash       text,
          ADD COLUMN IF NOT EXISTS auth_provider       text DEFAULT 'google',
          ADD COLUMN IF NOT EXISTS email_verified      boolean DEFAULT true,
          ADD COLUMN IF NOT EXISTS reset_token         text,
          ADD COLUMN IF NOT EXISTS reset_token_expires timestamptz,
          ADD COLUMN IF NOT EXISTS last_login_at       timestamptz,
          ADD COLUMN IF NOT EXISTS auth_version        integer DEFAULT 1,
          ADD COLUMN IF NOT EXISTS failed_attempts     integer DEFAULT 0,
          ADD COLUMN IF NOT EXISTS locked_until        timestamptz,
          ADD COLUMN IF NOT EXISTS created_at          timestamptz DEFAULT now(),
          ADD COLUMN IF NOT EXISTS updated_at          timestamptz DEFAULT now()
      `;
    },
    async down(sql) {
      await sql`
        ALTER TABLE public.profiles
          DROP COLUMN IF EXISTS password_hash,
          DROP COLUMN IF EXISTS auth_provider,
          DROP COLUMN IF EXISTS email_verified,
          DROP COLUMN IF EXISTS reset_token,
          DROP COLUMN IF EXISTS reset_token_expires,
          DROP COLUMN IF EXISTS last_login_at,
          DROP COLUMN IF EXISTS auth_version,
          DROP COLUMN IF EXISTS failed_attempts,
          DROP COLUMN IF EXISTS locked_until
      `;
      // created_at y updated_at se dejan por compatibilidad
    },
  },

  /* ───────────────────────────────────────────────────────────────
     002 · Índices de auth
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_10_002_auth_indexes',
    name: 'Add indexes for auth lookups',
    async up(sql) {
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS profiles_email_lower_idx
          ON public.profiles (lower(email))
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS profiles_reset_token_idx
          ON public.profiles (reset_token)
          WHERE reset_token IS NOT NULL
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS profiles_auth_provider_idx
          ON public.profiles (auth_provider)
      `;
    },
    async down(sql) {
      await sql`DROP INDEX IF EXISTS public.profiles_email_lower_idx`;
      await sql`DROP INDEX IF EXISTS public.profiles_reset_token_idx`;
      await sql`DROP INDEX IF EXISTS public.profiles_auth_provider_idx`;
    },
  },

  /* ───────────────────────────────────────────────────────────────
     003 · Columnas faltantes en Chat
     Agrega mode e isGhost si no existen (algunas instalaciones
     iniciales no los tenían).
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_10_003_chat_columns',
    name: 'Ensure Chat has mode and isGhost columns',
    async up(sql) {
      await sql`
        ALTER TABLE "Chat"
          ADD COLUMN IF NOT EXISTS mode text DEFAULT 'chat',
          ADD COLUMN IF NOT EXISTS "isGhost" boolean DEFAULT false
      `;
    },
  },

  /* ───────────────────────────────────────────────────────────────
     004 · Índices de Chat
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_10_004_chat_indexes',
    name: 'Add indexes for chat queries',
    async up(sql) {
      await sql`
        CREATE INDEX IF NOT EXISTS chats_user_updated_idx
          ON "Chat" ("userId", "updatedAt" DESC)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS chats_user_ghost_idx
          ON "Chat" ("userId", "isGhost")
      `;
    },
    async down(sql) {
      await sql`DROP INDEX IF EXISTS public.chats_user_updated_idx`;
      await sql`DROP INDEX IF EXISTS public.chats_user_ghost_idx`;
    },
  },

  /* ───────────────────────────────────────────────────────────────
     005 · Índices de Message
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_10_005_message_indexes',
    name: 'Add indexes for message queries',
    async up(sql) {
      await sql`
        CREATE INDEX IF NOT EXISTS messages_chat_created_idx
          ON "Message" ("chatId", "createdAt" ASC)
      `;
    },
    async down(sql) {
      await sql`DROP INDEX IF EXISTS public.messages_chat_created_idx`;
    },
  },

  /* ───────────────────────────────────────────────────────────────
     006 · Columnas faltantes en Memory (v3.0)
     Agrega campos para tags, pin, relevance, etc.
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_10_006_memory_columns',
    name: 'Add v3.0 columns to Memory',
    async up(sql) {
      await sql`
        ALTER TABLE "Memory"
          ADD COLUMN IF NOT EXISTS title       text,
          ADD COLUMN IF NOT EXISTS category    text DEFAULT 'general',
          ADD COLUMN IF NOT EXISTS tags        text[] DEFAULT '{}',
          ADD COLUMN IF NOT EXISTS pinned      boolean DEFAULT false,
          ADD COLUMN IF NOT EXISTS relevance   integer DEFAULT 5,
          ADD COLUMN IF NOT EXISTS source      text DEFAULT 'manual',
          ADD COLUMN IF NOT EXISTS "useCount"  integer DEFAULT 0,
          ADD COLUMN IF NOT EXISTS "lastUsedAt" timestamptz,
          ADD COLUMN IF NOT EXISTS "updatedAt" timestamptz DEFAULT now()
      `;
    },
    async down(sql) {
      await sql`
        ALTER TABLE "Memory"
          DROP COLUMN IF EXISTS title,
          DROP COLUMN IF EXISTS category,
          DROP COLUMN IF EXISTS tags,
          DROP COLUMN IF EXISTS pinned,
          DROP COLUMN IF EXISTS relevance,
          DROP COLUMN IF EXISTS source,
          DROP COLUMN IF EXISTS "useCount",
          DROP COLUMN IF EXISTS "lastUsedAt",
          DROP COLUMN IF EXISTS "updatedAt"
      `;
    },
  },

  /* ───────────────────────────────────────────────────────────────
     007 · Índices de Memory
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_10_007_memory_indexes',
    name: 'Add indexes for memory queries',
    async up(sql) {
      await sql`
        CREATE INDEX IF NOT EXISTS memories_user_type_updated_idx
          ON "Memory" ("userId", type, "updatedAt" DESC)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS memories_user_pinned_idx
          ON "Memory" ("userId", pinned DESC)
          WHERE type = 'MEMORY'
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS memories_tags_idx
          ON "Memory" USING GIN (tags)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS memories_category_idx
          ON "Memory" ("userId", category)
          WHERE type = 'MEMORY'
      `;
    },
    async down(sql) {
      await sql`DROP INDEX IF EXISTS public.memories_user_type_updated_idx`;
      await sql`DROP INDEX IF EXISTS public.memories_user_pinned_idx`;
      await sql`DROP INDEX IF EXISTS public.memories_tags_idx`;
      await sql`DROP INDEX IF EXISTS public.memories_category_idx`;
    },
  },

  /* ───────────────────────────────────────────────────────────────
     008 · Extensión pg_trgm para búsqueda
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_12_008_pg_trgm',
    name: 'Enable pg_trgm extension for full-text search',
    async up(sql) {
      await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`;
    },
    // No hacemos DROP EXTENSION en down: puede afectar otros índices
  },

  /* ───────────────────────────────────────────────────────────────
     009 · Índices trigram para búsqueda
     Depende de la migración 008.
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_12_009_search_indexes',
    name: 'Add trigram indexes for search',
    async up(sql) {
      await sql`
        CREATE INDEX IF NOT EXISTS chats_title_trgm_idx
          ON "Chat" USING GIN (title gin_trgm_ops)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS messages_content_trgm_idx
          ON "Message" USING GIN (content gin_trgm_ops)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS memories_title_trgm_idx
          ON "Memory" USING GIN (title gin_trgm_ops)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS memories_content_trgm_idx
          ON "Memory" USING GIN (content gin_trgm_ops)
      `;
    },
    async down(sql) {
      await sql`DROP INDEX IF EXISTS public.chats_title_trgm_idx`;
      await sql`DROP INDEX IF EXISTS public.messages_content_trgm_idx`;
      await sql`DROP INDEX IF EXISTS public.memories_title_trgm_idx`;
      await sql`DROP INDEX IF EXISTS public.memories_content_trgm_idx`;
    },
  },

  /* ───────────────────────────────────────────────────────────────
     010 · Índices de Message con provider
     Agrega índice parcial para queries por provider
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_12_010_provider_indexes',
    name: 'Add partial index for message providers',
    async up(sql) {
      // Nota: provider puede no existir en algunas instalaciones.
      // El índice es opcional, si la columna existe.
      try {
        await sql`
          CREATE INDEX IF NOT EXISTS messages_provider_idx
            ON "Message" (provider)
            WHERE provider IS NOT NULL
        `;
      } catch {
        // Columna provider no existe: skip silencioso
      }
    },
    async down(sql) {
      await sql`DROP INDEX IF EXISTS public.messages_provider_idx`;
    },
  },

  /* ───────────────────────────────────────────────────────────────
     011 · Backfill de auth_provider
     Asegura que todos los usuarios existentes tengan auth_provider
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_12_011_backfill_auth_provider',
    name: 'Backfill auth_provider for existing users',
    async up(sql) {
      await sql`
        UPDATE public.profiles
        SET auth_provider = 'google'
        WHERE auth_provider IS NULL
      `;
      await sql`
        UPDATE public.profiles
        SET auth_version = 1
        WHERE auth_version IS NULL
      `;
      await sql`
        UPDATE public.profiles
        SET failed_attempts = 0
        WHERE failed_attempts IS NULL
      `;
    },
  },

  /* ───────────────────────────────────────────────────────────────
     012 · Vista de stats de usuario
     Vista SQL para calcular stats agregados sin queries repetidas
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_12_012_user_stats_view',
    name: 'Create user stats view',
    async up(sql) {
      await sql`
        CREATE OR REPLACE VIEW public.user_stats AS
        SELECT
          p.id as user_id,
          p.email,
          p.plan,
          COALESCE((
            SELECT COUNT(*)::int FROM "Chat" c
            WHERE c."userId" = p.id AND c."isGhost" = false
          ), 0) as chat_count,
          COALESCE((
            SELECT COUNT(*)::int FROM "Memory" m
            WHERE m."userId" = p.id AND m.type = 'MEMORY'
          ), 0) as memory_count,
          COALESCE((
            SELECT COUNT(*)::int FROM "Message" msg
            JOIN "Chat" c ON c.id = msg."chatId"
            WHERE c."userId" = p.id
          ), 0) as message_count
        FROM public.profiles p
      `;
    },
    async down(sql) {
      await sql`DROP VIEW IF EXISTS public.user_stats`;
    },
  },

  /* ───────────────────────────────────────────────────────────────
     013 · Revocación de sesiones server-side (HIGH-001)
     Tabla denylist de JTIs revocados + garantiza auth_version.
     Sin esto, el logout es solo cliente y el JWT vive 30 días.
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_14_013_session_revocation',
    name: 'Revoked sessions denylist for server-side logout',
    async up(sql) {
      await sql`
        CREATE TABLE IF NOT EXISTS public.revoked_sessions (
          jti text PRIMARY KEY,
          user_id uuid NOT NULL,
          expires_at timestamptz NOT NULL,
          revoked_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS revoked_sessions_user_idx
          ON public.revoked_sessions (user_id)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS revoked_sessions_expires_idx
          ON public.revoked_sessions (expires_at)
      `;
      // auth_version ya lo crea 001, pero IF NOT EXISTS por si el schema
      // se creó a mano sin migraciones.
      await sql`
        ALTER TABLE public.profiles
          ADD COLUMN IF NOT EXISTS auth_version integer DEFAULT 1
      `;
      await sql`
        UPDATE public.profiles
        SET auth_version = 1
        WHERE auth_version IS NULL
      `;
    },
    async down(sql) {
      await sql`DROP TABLE IF EXISTS public.revoked_sessions`;
    },
  },

  /* ───────────────────────────────────────────────────────────────
     014 · Tokens de verificación de email (HIGH-002)
     El endpoint /verify-email/confirm aceptaba cualquier token.
     Ahora los tokens se persisten hasheados, con expiración y un
     solo uso.
     ─────────────────────────────────────────────────────────────── */
  {
    id: '2026_10_14_014_email_verification',
    name: 'Email verification tokens table',
    async up(sql) {
      await sql`
        CREATE TABLE IF NOT EXISTS public.email_verification_tokens (
          id text PRIMARY KEY,
          user_id uuid NOT NULL,
          token_hash text UNIQUE NOT NULL,
          expires_at timestamptz NOT NULL,
          used_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS email_verify_user_idx
          ON public.email_verification_tokens (user_id)
      `;
    },
    async down(sql) {
      await sql`DROP TABLE IF EXISTS public.email_verification_tokens`;
    },
  },
]);

/* ═══════════════════════════════════════════════════════════════════════
   3 · VALIDACIÓN DEL REGISTRO
   ═══════════════════════════════════════════════════════════════════════
   Corre al cargar el módulo. Falla rápido si hay problemas en la
   definición de migraciones.
   ═══════════════════════════════════════════════════════════════════════ */

function validateRegistry() {
  const errors = [];
  const ids = new Set();

  for (const m of MIGRATIONS) {
    if (!m.id) errors.push(`Migración sin id`);
    if (!m.name) errors.push(`${m.id}: sin name`);
    if (typeof m.up !== 'function') errors.push(`${m.id}: sin función up`);

    if (ids.has(m.id)) errors.push(`ID duplicado: ${m.id}`);
    ids.add(m.id);

    if (!/^\d{4}_\d{2}_\d{2}_\d{3}_/.test(m.id)) {
      errors.push(`${m.id}: formato de ID no válido (debe ser YYYY_MM_DD_NNN_...)`);
    }
  }

  // Verificar orden
  const sorted = [...MIGRATIONS].sort((a, b) => a.id.localeCompare(b.id));
  for (let i = 0; i < MIGRATIONS.length; i++) {
    if (MIGRATIONS[i].id !== sorted[i].id) {
      errors.push(`Migraciones fuera de orden en índice ${i}: ${MIGRATIONS[i].id}`);
      break;
    }
  }

  if (errors.length > 0) {
    console.error('[migrations] Errores en el registro:');
    for (const e of errors) console.error('  -', e);
    throw new Error(`Registro de migraciones inválido (${errors.length} errores)`);
  }
}

validateRegistry();

/* ═══════════════════════════════════════════════════════════════════════
   4 · CLIENTE SQL (lazy)
   ═══════════════════════════════════════════════════════════════════════ */

let _sql = null;

async function getSql() {
  if (_sql) return _sql;
  try {
    const mod = await import('./supabase.js');
    _sql = mod.sql || null;
  } catch (e) {
    console.warn('[migrations] no pude cargar supabase.js:', e.message);
    _sql = null;
  }
  return _sql;
}

/**
 * Permite inyectar un cliente SQL en tests.
 */
export function setSql(client) {
  _sql = client;
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · TABLA DE CONTROL
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Crea la tabla de control si no existe. Idempotente.
 */
async function ensureControlTable(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS public._migrations (
      id text PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now(),
      duration_ms integer NOT NULL,
      checksum text NOT NULL,
      success boolean NOT NULL DEFAULT true,
      error text
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS migrations_applied_at_idx
      ON public._migrations (applied_at DESC)
  `;
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · CHECKSUM
   ═══════════════════════════════════════════════════════════════════════
   Fingerprint del contenido de la migración. Detecta si el código
   cambió después de haberse aplicado.
   ═══════════════════════════════════════════════════════════════════════ */

function migrationChecksum(migration) {
  const parts = [
    migration.id,
    migration.name,
    migration.up.toString(),
    migration.down ? migration.down.toString() : '',
  ];
  return crypto
    .createHash('sha256')
    .update(parts.join('\n\n'))
    .digest('hex')
    .slice(0, 16);
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · APLICAR
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Aplica UNA migración.
 * Envuelve el `up()` en una transacción.
 */
async function applyOne(sql, migration) {
  const t0 = Date.now();
  const checksum = migrationChecksum(migration);

  if (CFG.verbose) {
    console.log(`[migrations] applying ${migration.id} · ${migration.name}`);
  }

  try {
    await sql.begin(async (trx) => {
      await migration.up(trx);
    });

    const durationMs = Date.now() - t0;

    await sql`
      INSERT INTO public._migrations (id, name, duration_ms, checksum, success)
      VALUES (${migration.id}, ${migration.name}, ${durationMs}, ${checksum}, true)
      ON CONFLICT (id) DO UPDATE
        SET applied_at = now(),
            duration_ms = EXCLUDED.duration_ms,
            checksum = EXCLUDED.checksum,
            success = true,
            error = null
    `;

    return {
      ok: true,
      id: migration.id,
      name: migration.name,
      durationMs,
      checksum,
    };
  } catch (err) {
    const durationMs = Date.now() - t0;

    // Registrar el fallo (sin transacción, porque ya se hizo rollback)
    try {
      await sql`
        INSERT INTO public._migrations (id, name, duration_ms, checksum, success, error)
        VALUES (${migration.id}, ${migration.name}, ${durationMs}, ${checksum}, false, ${String(err.message).slice(0, 500)})
        ON CONFLICT (id) DO UPDATE
          SET applied_at = now(),
              duration_ms = EXCLUDED.duration_ms,
              checksum = EXCLUDED.checksum,
              success = false,
              error = EXCLUDED.error
      `;
    } catch {}

    return {
      ok: false,
      id: migration.id,
      name: migration.name,
      durationMs,
      error: err.message,
    };
  }
}

/**
 * Aplica todas las migraciones pendientes.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]      · no aplica, solo lista
 * @param {string} [opts.to]           · aplicar hasta este id (inclusive)
 * @param {boolean} [opts.force]       · ignora checksum mismatch
 * @returns {Promise<object>}
 */
export async function runMigrations(opts = {}) {
  const sql = await getSql();
  if (!sql) return { ok: false, error: 'no_db' };

  await ensureControlTable(sql);

  const applied = await getAppliedMigrations();
  const appliedIds = new Set(applied.map((m) => m.id));

  // Verificar checksums
  const drift = [];
  for (const m of applied) {
    const current = MIGRATIONS.find((x) => x.id === m.id);
    if (!current) continue;
    const expected = migrationChecksum(current);
    if (expected !== m.checksum) {
      drift.push({ id: m.id, appliedChecksum: m.checksum, currentChecksum: expected });
    }
  }

  if (drift.length > 0 && !opts.force) {
    return {
      ok: false,
      error: 'checksum_drift',
      message: 'Una o más migraciones cambiaron después de aplicarse. Usá --force para ignorar.',
      drift,
    };
  }

  // Determinar pendientes
  let pending = MIGRATIONS.filter((m) => !appliedIds.has(m.id));

  // Filtro por "to"
  if (opts.to) {
    const idx = MIGRATIONS.findIndex((m) => m.id === opts.to);
    if (idx === -1) {
      return { ok: false, error: 'invalid_target', message: `Migración no existe: ${opts.to}` };
    }
    pending = pending.filter((m, i) => MIGRATIONS.indexOf(m) <= idx);
  }

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      wouldApply: pending.map((m) => ({ id: m.id, name: m.name })),
      total: pending.length,
      drift: drift.length > 0 ? drift : undefined,
    };
  }

  // Aplicar una por una
  const results = [];
  for (const m of pending) {
    const r = await applyOne(sql, m);
    results.push(r);

    if (!r.ok) {
      // Si una falla, parar. No aplicar las siguientes.
      break;
    }
  }

  const ok = results.every((r) => r.ok);
  const appliedCount = results.filter((r) => r.ok).length;
  const failedCount = results.filter((r) => !r.ok).length;

  return {
    ok,
    applied: results.filter((r) => r.ok),
    failed: results.filter((r) => !r.ok),
    total: results.length,
    appliedCount,
    failedCount,
    drift: drift.length > 0 ? drift : undefined,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   8 · CONSULTAR
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Devuelve las migraciones que ya fueron aplicadas (según la DB).
 */
export async function getAppliedMigrations() {
  const sql = await getSql();
  if (!sql) return [];

  try {
    // Asegurarse que la tabla exista antes de consultar
    await ensureControlTable(sql);

    const rows = await sql`
      SELECT id, name, applied_at, duration_ms, checksum, success, error
      FROM public._migrations
      ORDER BY id ASC
    `;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      appliedAt: r.applied_at,
      durationMs: r.duration_ms,
      checksum: r.checksum,
      success: r.success,
      error: r.error,
    }));
  } catch (e) {
    console.warn('[migrations] getAppliedMigrations:', e.message);
    return [];
  }
}

/**
 * Devuelve las migraciones pendientes.
 */
export async function getPendingMigrations() {
  const applied = await getAppliedMigrations();
  const appliedIds = new Set(applied.map((m) => m.id));
  return MIGRATIONS.filter((m) => !appliedIds.has(m.id));
}

/**
 * Devuelve el estado completo.
 */
export async function getStatus() {
  const applied = await getAppliedMigrations();
  const pending = await getPendingMigrations();

  // Verificar drift
  const drift = [];
  for (const m of applied) {
    const current = MIGRATIONS.find((x) => x.id === m.id);
    if (!current) {
      drift.push({ id: m.id, reason: 'not_in_code' });
      continue;
    }
    const expected = migrationChecksum(current);
    if (expected !== m.checksum) {
      drift.push({ id: m.id, reason: 'checksum_mismatch' });
    }
  }

  return {
    ok: true,
    total: MIGRATIONS.length,
    applied: applied.length,
    pending: pending.length,
    failed: applied.filter((m) => !m.success).length,
    drift: drift.length,
    appliedList: applied,
    pendingList: pending.map((m) => ({ id: m.id, name: m.name })),
    driftList: drift,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   9 · ROLLBACK
   ═══════════════════════════════════════════════════════════════════════
   Peligroso. Solo hace rollback de la última migración o de una
   específica. Requiere que la migración tenga función `down`.
   ═══════════════════════════════════════════════════════════════════════ */

export async function rollbackMigration(migrationId) {
  const sql = await getSql();
  if (!sql) return { ok: false, error: 'no_db' };

  await ensureControlTable(sql);

  const migration = MIGRATIONS.find((m) => m.id === migrationId);
  if (!migration) {
    return { ok: false, error: 'not_found', message: `No existe migración ${migrationId}` };
  }

  if (typeof migration.down !== 'function') {
    return { ok: false, error: 'no_down', message: `La migración ${migrationId} no tiene función down()` };
  }

  // Verificar que esté aplicada
  const applied = await getAppliedMigrations();
  const record = applied.find((m) => m.id === migrationId);
  if (!record) {
    return { ok: false, error: 'not_applied', message: `${migrationId} no estaba aplicada` };
  }

  const t0 = Date.now();

  try {
    await sql.begin(async (trx) => {
      await migration.down(trx);
    });

    await sql`DELETE FROM public._migrations WHERE id = ${migrationId}`;

    return {
      ok: true,
      id: migrationId,
      name: migration.name,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    return {
      ok: false,
      id: migrationId,
      error: err.message,
      durationMs: Date.now() - t0,
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · VERIFICACIÓN DE INTEGRIDAD
   ═══════════════════════════════════════════════════════════════════════ */

export async function verifyIntegrity() {
  const applied = await getAppliedMigrations();
  const drift = [];
  const notInCode = [];

  for (const m of applied) {
    const current = MIGRATIONS.find((x) => x.id === m.id);
    if (!current) {
      notInCode.push(m.id);
      continue;
    }
    const expected = migrationChecksum(current);
    if (expected !== m.checksum) {
      drift.push({
        id: m.id,
        appliedChecksum: m.checksum,
        currentChecksum: expected,
      });
    }
  }

  return {
    ok: drift.length === 0 && notInCode.length === 0,
    applied: applied.length,
    drift,
    notInCode,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   11 · DRY RUN
   ═══════════════════════════════════════════════════════════════════════ */

export async function dryRun() {
  return runMigrations({ dryRun: true });
}

/* ═══════════════════════════════════════════════════════════════════════
   12 · CLI
   ═══════════════════════════════════════════════════════════════════════ */

const C = {
  reset: (s) => `\x1b[0m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  gray: (s) => `\x1b[90m${s}\x1b[0m`,
};

async function cli() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'status';
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  const dryRun = flags.has('--dry-run');
  const force = flags.has('--force');
  const noColor = flags.has('--no-color') || process.env.NO_COLOR === '1';

  // Desactivar colores si aplica
  if (noColor) {
    Object.keys(C).forEach((k) => { C[k] = (s) => s; });
  }

  console.log('');
  console.log(C.bold(C.cyan('╭─────────────────────────────────────────────╮')));
  console.log(C.bold(C.cyan('│  NUMINATION · migrations.js                 │')));
  console.log(C.bold(C.cyan('╰─────────────────────────────────────────────╯')));
  console.log('');

  const sql = await getSql();
  if (!sql) {
    console.log(C.red('✗') + ' Sin conexión a la base de datos');
    console.log(C.gray('  Verificá DATABASE_URL en env.local.js'));
    process.exit(1);
  }

  switch (cmd) {
    case 'status': {
      const s = await getStatus();
      console.log(C.bold('Total de migraciones:'), s.total);
      console.log(C.bold('Aplicadas:'), C.green(String(s.applied)));
      console.log(C.bold('Pendientes:'), s.pending > 0 ? C.yellow(String(s.pending)) : '0');
      console.log(C.bold('Fallidas:'), s.failed > 0 ? C.red(String(s.failed)) : '0');
      console.log(C.bold('Drift detectado:'), s.drift > 0 ? C.red(String(s.drift)) : '0');
      console.log('');

      if (s.appliedList.length > 0) {
        console.log(C.bold('Aplicadas:'));
        for (const m of s.appliedList) {
          const icon = m.success ? C.green('✓') : C.red('✗');
          const dur = C.gray(`${m.durationMs}ms`);
          console.log(`  ${icon} ${m.id} · ${m.name} ${dur}`);
        }
        console.log('');
      }

      if (s.pendingList.length > 0) {
        console.log(C.bold(C.yellow('Pendientes:')));
        for (const m of s.pendingList) {
          console.log(`  ${C.yellow('○')} ${m.id} · ${m.name}`);
        }
        console.log('');
      }

      if (s.driftList.length > 0) {
        console.log(C.bold(C.red('Drift:')));
        for (const d of s.driftList) {
          console.log(`  ${C.red('⚠')} ${d.id} · ${d.reason}`);
        }
        console.log('');
      }
      break;
    }

    case 'list': {
      console.log(C.bold('Migraciones registradas:'));
      for (const m of MIGRATIONS) {
        const has = typeof m.down === 'function';
        console.log(`  ${C.gray(m.id)} · ${m.name} ${has ? C.gray('[+down]') : ''}`);
      }
      console.log('');
      console.log(C.gray(`Total: ${MIGRATIONS.length}`));
      break;
    }

    case 'pending': {
      const p = await getPendingMigrations();
      if (p.length === 0) {
        console.log(C.green('✓') + ' No hay migraciones pendientes');
      } else {
        console.log(C.bold(C.yellow(`${p.length} pendientes:`)));
        for (const m of p) {
          console.log(`  ${C.yellow('○')} ${m.id} · ${m.name}`);
        }
      }
      break;
    }

    case 'up': {
      const to = args.includes('--to') ? args[args.indexOf('--to') + 1] : null;
      console.log(dryRun ? C.yellow('Modo dry-run: no se aplicará nada') : C.bold('Aplicando migraciones...'));
      console.log('');

      const result = await runMigrations({ dryRun, to, force });

      if (!result.ok && result.error === 'checksum_drift') {
        console.log(C.red('✗ Drift detectado:'));
        for (const d of result.drift) {
          console.log(`  ${C.red('⚠')} ${d.id}`);
        }
        console.log('');
        console.log(C.gray('Para ignorar: agregar --force'));
        process.exit(1);
      }

      if (dryRun) {
        if (result.total === 0) {
          console.log(C.green('✓') + ' Nada para aplicar');
        } else {
          console.log(C.bold(`${result.total} se aplicarían:`));
          for (const m of result.wouldApply) {
            console.log(`  ${C.yellow('○')} ${m.id} · ${m.name}`);
          }
        }
      } else {
        for (const r of result.applied) {
          console.log(`  ${C.green('✓')} ${r.id} · ${r.name} ${C.gray(`${r.durationMs}ms`)}`);
        }
        for (const r of result.failed) {
          console.log(`  ${C.red('✗')} ${r.id} · ${r.name} ${C.gray(`${r.durationMs}ms`)}`);
          console.log(`      ${C.red(r.error)}`);
        }
        console.log('');
        console.log(`  ${C.bold('Aplicadas:')} ${C.green(String(result.appliedCount))}  ${C.bold('Fallidas:')} ${result.failedCount > 0 ? C.red(String(result.failedCount)) : '0'}`);
      }
      console.log('');
      break;
    }

    case 'rollback': {
      const id = args[1];
      if (!id) {
        console.log(C.red('✗') + ' Falta el ID de la migración');
        console.log(C.gray('  Uso: node src/services/migrations.js rollback 2026_10_12_005'));
        process.exit(1);
      }

      console.log(C.yellow('⚠ Rollback es peligroso. Va a deshacer cambios de schema.'));
      console.log('');
      console.log(`Rollback de ${C.bold(id)}...`);

      const result = await rollbackMigration(id);
      if (result.ok) {
        console.log(`  ${C.green('✓')} ${result.id} · ${result.name} ${C.gray(`${result.durationMs}ms`)}`);
      } else {
        console.log(`  ${C.red('✗')} ${result.error}: ${result.message || ''}`);
      }
      console.log('');
      break;
    }

    case 'verify': {
      const v = await verifyIntegrity();
      if (v.ok) {
        console.log(C.green('✓') + ` Integridad OK · ${v.applied} migraciones verificadas`);
      } else {
        console.log(C.red('✗') + ' Problemas de integridad detectados');
        if (v.drift.length > 0) {
          console.log('');
          console.log(C.bold(C.red('Checksums que no coinciden:')));
          for (const d of v.drift) {
            console.log(`  ${C.red('⚠')} ${d.id}`);
            console.log(`      aplicado: ${C.gray(d.appliedChecksum)}`);
            console.log(`      actual:   ${C.gray(d.currentChecksum)}`);
          }
        }
        if (v.notInCode.length > 0) {
          console.log('');
          console.log(C.bold(C.red('Migraciones aplicadas que ya no existen en el código:')));
          for (const id of v.notInCode) {
            console.log(`  ${C.red('⚠')} ${id}`);
          }
        }
        process.exit(1);
      }
      console.log('');
      break;
    }

    case 'help':
    case '--help':
    case '-h': {
      console.log(C.bold('Comandos:'));
      console.log('');
      console.log('  ' + C.cyan('status') + '             · Ver estado completo');
      console.log('  ' + C.cyan('list') + '               · Listar todas las migraciones registradas');
      console.log('  ' + C.cyan('pending') + '            · Ver pendientes');
      console.log('  ' + C.cyan('up') + '                 · Aplicar todas las pendientes');
      console.log('  ' + C.cyan('up --dry-run') + '       · Ver qué se aplicaría sin aplicar');
      console.log('  ' + C.cyan('up --to <id>') + '       · Aplicar hasta una migración específica');
      console.log('  ' + C.cyan('up --force') + '         · Ignorar drift de checksums');
      console.log('  ' + C.cyan('rollback <id>') + '      · Deshacer una migración específica');
      console.log('  ' + C.cyan('verify') + '             · Verificar integridad');
      console.log('');
      console.log(C.bold('Flags:'));
      console.log('');
      console.log('  ' + C.gray('--no-color') + '         · Sin códigos ANSI');
      console.log('');
      break;
    }

    default: {
      console.log(C.red(`✗ Comando desconocido: ${cmd}`));
      console.log(C.gray('  Corré "node src/services/migrations.js help" para ver opciones'));
      process.exit(1);
    }
  }

  // Flush del buffer si aplica (no hace falta aquí, pero por si acaso)
  process.exit(0);
}

/* ═══════════════════════════════════════════════════════════════════════
   13 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const errors = [];

  // 1 · Registry válido
  try {
    validateRegistry();
  } catch (e) {
    errors.push('validateRegistry lanzó: ' + e.message);
  }

  // 2 · Todos los IDs únicos
  const ids = MIGRATIONS.map((m) => m.id);
  if (new Set(ids).size !== ids.length) {
    errors.push('IDs duplicados');
  }

  // 3 · Orden cronológico
  const sorted = [...ids].sort();
  if (sorted.join(',') !== ids.join(',')) {
    errors.push('Migraciones fuera de orden');
  }

  // 4 · Cada migración tiene up
  for (const m of MIGRATIONS) {
    if (typeof m.up !== 'function') errors.push(`${m.id} sin up()`);
    if (!m.name) errors.push(`${m.id} sin name`);
  }

  // 5 · Checksum determinista
  const m1 = MIGRATIONS[0];
  const c1 = migrationChecksum(m1);
  const c2 = migrationChecksum(m1);
  if (c1 !== c2) errors.push('checksum no es determinista');
  if (c1.length !== 16) errors.push(`checksum length: ${c1.length}`);

  // 6 · Checksum distinto para migraciones distintas
  const c3 = migrationChecksum(MIGRATIONS[1]);
  if (c1 === c3) errors.push('checksums colisionan');

  return {
    ok: errors.length === 0,
    errors,
    total: MIGRATIONS.length,
    withDown: MIGRATIONS.filter((m) => typeof m.down === 'function').length,
    ids: MIGRATIONS.map((m) => m.id),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   14 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════ */

export default {
  MIGRATIONS,
  runMigrations,
  getAppliedMigrations,
  getPendingMigrations,
  getStatus,
  rollbackMigration,
  verifyIntegrity,
  dryRun,
  selfTest,
  setSql,
};

/* ═══════════════════════════════════════════════════════════════════════
   AUTO-CLI
   ═══════════════════════════════════════════════════════════════════════
   Si el módulo se ejecuta directamente (no importado), corre el CLI.
   Detecta si es entry point comparando import.meta.url con argv[1].
   ═══════════════════════════════════════════════════════════════════════ */

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  cli().catch((e) => {
    console.error('\n' + C.red('Error fatal:'));
    console.error(e);
    process.exit(1);
  });
}