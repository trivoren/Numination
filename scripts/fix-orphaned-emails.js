#!/usr/bin/env node
/* ================================================================
   NUMINATION · fix-orphaned-emails.js · v1.0
   ----------------------------------------------------------------
   FIX-ORPHAN · Reparación de cuentas huérfanas cuyos `email` en
   public.profiles son placeholders del tipo:

       orphaned+<uuid>@invalid.numination.local

   CONTEXTO
   --------
   Si el correo del proveedor OAuth se pierde/genera mal, las cuentas
   quedan con un email sintético irrecuperable: no pueden recibir
   correo, no pueden resetear password y `/api/auth/me` les sirve el
   placeholder con claims firmados. Este script:

     1. Encuentra los perfiles con email placeholder en Postgres.
     2. Intenta RECUPERAR el email real desde, en orden:
          a) auth.users (Supabase) por id del perfil o por el uuid
             embebido en el local part `orphaned+<uuid>@…`.
          b) auth.users.raw_user_meta_data → campo `email`.
          c) columnas JSON de metadata que existan en public.profiles.
          d) displayName si es un email válido.
     3. Decide:
          · Email recuperado y libre  → RESTAURAR (update del email +
            bump auth_version para invalidar sesiones con claims
            "orphaned" viejos).
          · Email recuperado pero YA es otro perfil → CONFLICT
            (por default se marca para revisión; con --merge hace la
            reasignación de datos - Chat/Memory - y borra el huérfano).
          · Nada recuperable → NEEDS_REVIEW (revisión manual).

   SEGURIDAD
   ---------
     · DRY-RUN por default: sin `--apply` NO escribe nada.
     · NUNCA toca los emails `anonimo+…@borrado.numination.local`
       (anonimización GDPR intencional).
     · `--merge` se niega si el huérfano tiene password_hash (podría
       ser una cuenta real distinta, no un auto-registro de OAuth).

   USO
   ---
     node scripts/fix-orphaned-emails.js                  # reporte (dry-run)
     node scripts/fix-orphaned-emails.js --apply          # aplica lo seguro
     node scripts/fix-orphaned-emails.js --apply --mark   # + tabla de revisión
     node scripts/fix-orphaned-emails.js --apply --merge  # + fusionar conflictos
     node scripts/fix-orphaned-emails.js --include-github-local   # admite el legacy @github.local
     node scripts/fix-orphaned-emails.js --domain invalid.numination.local
     node scripts/fix-orphaned-emails.js --report local/out.json

   VARIABLES
   ---------
     DATABASE_URL    · cadena Postgres (igual que el server).
     --url postgres://…  · override puntual.
   ================================================================ */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import postgres from 'postgres';

dotenv.config();

/* ═══ 1 · CLI ═════════════════════════════════════════════════════ */

const args = process.argv.slice(2);

function argValue(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || !args[i + 1] || args[i + 1].startsWith('--')) return null;
  return args[i + 1];
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const APPLY          = hasFlag('apply');
const MARK           = hasFlag('mark');
const MERGE          = hasFlag('merge');
const INCLUDE_GITHUB = hasFlag('include-github-local');
const reportFile     = argValue('report');
const DATABASE_URL   = argValue('url') || process.env.DATABASE_URL || '';
const LIMIT          = (() => { const n = Number(argValue('limit') || 0); return n > 0 ? n : 0; })();

// Dominios placeholder objetivo.
const DOMAIN_OVERRIDE = argValue('domain');
const DOMAINS = [...new Set([
  'invalid.numination.local',
  ...(DOMAIN_OVERRIDE ? [String(DOMAIN_OVERRIDE).toLowerCase()] : []),
  ...(INCLUDE_GITHUB ? ['github.local'] : []),
])].filter((d) => /^[a-z0-9.-]+$/.test(d));

const GDPR_DOMAIN = 'borrado.numination.local'; // GDPR · intencional, NUNCA tocar.

/* ═══ 2 · Utilidades ══════════════════════════════════════════════ */

const C = process.env.NO_COLOR ? { g: '', r: '', y: '', b: '', dim: '', 0: '' } : {
  g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[36m', dim: '\x1b[2m', 0: '\x1b[0m',
};

const say   = (...m) => console.log(...m);
const ok    = (m) => say(`${C.g}✓${C[0]} ${m}`);
const warn  = (m) => say(`${C.y}▲${C[0]} ${m}`);
const err   = (m) => say(`${C.r}✗${C[0]} ${m}`);
const dim   = (m) => say(`${C.dim}  ${m}${C[0]}`);

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9-]+\.)+[a-z]{2,}$/i;
const UUID_RE  = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function realEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  if (!e || e.length > 254 || !EMAIL_RE.test(e)) return null;
  if (DOMAINS.some((d) => e.endsWith(`@${d}`))) return null; // otro placeholder
  if (e.endsWith(`@${GDPR_DOMAIN}`)) return null;            // GDPR anonimizado.
  return e;
}

function extractUuid(s) {
  const m = String(s || '').match(UUID_RE);
  return m ? m[0].toLowerCase() : null;
}

/* ═══ 3 · Conexión ════════════════════════════════════════════════ */

if (!DATABASE_URL) {
  err('DATABASE_URL no definida. Exporta la cadena Postgres o usa --url.');
  say('');
  say('  Ej:');
  say('  DATABASE_URL=postgres://… node scripts/fix-orphaned-emails.js');
  say('  node scripts/fix-orphaned-emails.js --url postgres://… --apply');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, {
  connect_timeout: 15,
  idle_timeout: 20,
  prepare: false, // Necesario vía pooler (Supabase → transacciones).
});

/* ═══ 4 · Detección ═══════════════════════════════════════════════ */

async function findOrphans() {
  const conditions = sql.join(
    DOMAINS.map((d) => sql`lower(email) like ${'%@' + d}`),
    ' or '
  );
  return sql`
    select
      id, email, "displayName" as name, auth_provider, email_verified,
      password_hash,
      "createdAt" as created_at, "updatedAt" as updated_at,
      last_login_at
    from public.profiles
    where (${conditions})
      and lower(email) not like ${'%@' + GDPR_DOMAIN}
    ${LIMIT ? sql`limit ${LIMIT}` : sql``}
  `;
}

/** Columnas JSON de metadata dinámicas en public.profiles (si existen). */
async function metadataColumns() {
  const rows = await sql`
    select column_name
    from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'profiles'
      and (
        column_name ilike '%metadata%'
        or data_type in ('json', 'jsonb')
      )
  `;
  return rows.map((r) => r.column_name);
}

/** Busca un email válido y recursivo dentro de un objeto JSON. */
function digEmail(obj, depth = 0) {
  if (!obj || depth > 4) return null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const hit = digEmail(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (/^email$/i.test(k) && realEmail(v)) return realEmail(v);
      const hit = digEmail(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Intenta, por orden de confianza, recuperar el email real del huérfano. */
async function recoverEmail(orphan, metaCols) {
  const candidates = [];

  /* (a/b) · auth.users: por id del perfil y por el uuid embebido. */
  const authIds = [String(orphan.id), extractUuid(orphan.email)]
    .filter((id, i, a) => id && a.indexOf(id) === i);

  try {
    for (const id of authIds) {
      const rows = await sql`
        select id, email,
               raw_user_meta_data,
               email_confirmed_at
        from auth.users
        where id = ${id}::uuid
        limit 1
      `;
      if (!rows.length) continue;
      const u = rows[0];
      const metaEmail = realEmail(u.raw_user_meta_data?.email);
      const direct    = realEmail(u.email);
      if (metaEmail) candidates.push({ source: 'auth.users.raw_user_meta_data', email: metaEmail, verified: Boolean(u.email_confirmed_at) });
      if (direct && direct !== metaEmail) candidates.push({ source: `auth.users (${id})`, email: direct, verified: Boolean(u.email_confirmed_at) });
    }
  } catch (e) {
    dim(`(sin acceso a auth.users: ${String(e.message).slice(0, 80)})`);
  }

  /* (c) · columnas metadata json/jsonb de public.profiles. */
  for (const col of metaCols) {
    try {
      const rows = await sql`
        select ${sql.identifier(col)} as meta
        from public.profiles
        where id = ${orphan.id}::uuid
      `;
      const email = digEmail(rows[0]?.meta);
      if (email) candidates.push({ source: `profiles.${col}`, email, verified: false });
    } catch { /* columna no accesible → se ignora */ }
  }

  /* (d) · displayName guardado como email (bug antiguo habitual). */
  if (orphan.name) {
    const e = realEmail(orphan.name);
    if (e) candidates.push({ source: 'profiles.displayName', email: e, verified: false });
  }

  const valid = candidates.filter((c) => c.email && c.email !== String(orphan.email).toLowerCase());
  const emails = [...new Set(valid.map((c) => c.email))];
  if (emails.length === 0) return { recovered: null, candidates: [] };
  if (emails.length > 1)   return { recovered: null, candidates: valid, ambiguous: emails };
  return { recovered: valid[0], candidates: valid };
}

/* ═══ 5 · Decisiones ══════════════════════════════════════════════ */

async function emailOwner(candidateEmail) {
  const rows = await sql`
    select id from public.profiles
    where lower(email) = ${candidateEmail}
    limit 1
  `;
  return rows[0] || null;
}

async function restoreEmail(id, recovered) {
  // email real + email_verified si la fuente lo confirma.
  // auth_version +1 → /session invalida JWTs con claims "orphaned" viejos.
  await sql`
    update public.profiles
    set email          = ${recovered.email},
        email_verified = ${recovered.verified ? true : sql`email_verified`},
        auth_version   = coalesce(auth_version, 1) + 1,
        "updatedAt"    = now()
    where id = ${id}::uuid
  `;
}

async function mergeInto(orphanId, ownerId) {
  await sql.begin(async (tx) => {
    await tx`
      update "Chat" set "userId" = ${ownerId}::uuid
      where "userId" = ${orphanId}::uuid
    `;
    await tx`
      update "Memory" set "userId" = ${ownerId}::uuid
      where "userId" = ${orphanId}::uuid
    `;
    await tx`delete from public.profiles where id = ${orphanId}::uuid`;
  });
}

async function ensureReviewTable() {
  await sql`
    create table if not exists public.orphaned_email_review (
      id              uuid primary key,
      orphan_email    text not null,
      recovered_email text,
      status          text not null,
      reason          text,
      detected_at     timestamptz default now(),
      updated_at      timestamptz default now()
    )
  `;
}

async function upsertReview(al) {
  await sql`
    insert into public.orphaned_email_review
      (id, orphan_email, recovered_email, status, reason)
    values
      (${al.id}::uuid, ${al.email}, ${al.recovered || null}, ${al.status}, ${al.reason || null})
    on conflict (id) do update
      set recovered_email = excluded.recovered_email,
          status          = excluded.status,
          reason          = excluded.reason,
          updated_at      = now()
  `;
}

/* ═══ 6 · MAIN ════════════════════════════════════════════════════ */

async function main() {
  say('');
  say(`${C.b}fix-orphaned-emails${C[0]}  ·  ${APPLY ? `${C.g}APPLY${C[0]}` : `${C.y}DRY-RUN${C[0]} (sin --apply no escribe nada)`}`);
  say(`  dominios objetivo · ${DOMAINS.join(', ')}`);
  say(`  merge de conflictos · ${MERGE ? 'sí' : 'no'}  ·  tabla de revisión (--mark) · ${MARK ? 'sí' : 'no'}`);
  say('');

  const orphans = await findOrphans();

  if (!orphans.length) {
    ok('Sin perfiles huérfanos con dominio placeholder. Nada que hacer.');
    await sql.end();
    return;
  }

  if (APPLY && MARK) await ensureReviewTable();

  const metaCols = await metadataColumns().catch(() => []);
  if (metaCols.length) dim(`Columnas metadata detectadas: ${metaCols.join(', ')}`);

  say(`  ${orphans.length} perfiles afectados${LIMIT ? ` (limit ${LIMIT})` : ''}:\n`);

  const summary = { fixed: [], conflicts: [], review: [], ambiguous: [] };
  let exitCode = 0;

  for (const orphan of orphans) {
    const prov =
      `${orphan.auth_provider || '?'} · creado ${String(orphan.created_at || 'n/d').slice(0, 10)}` +
      `${orphan.last_login_at ? ` · último login ${String(orphan.last_login_at).slice(0, 10)}` : ' · sin logins'}`;
    dim(`${orphan.id}  ${orphan.email}`);
    dim(prov);

    const { recovered, ambiguous } = await recoverEmail(orphan, metaCols);

    if (!recovered) {
      const reason = ambiguous
        ? `emails ambiguos en metadata: ${ambiguous.join(' | ')}`
        : 'metadata y auth.users no contienen un email real recuperable';
      if (ambiguous) summary.ambiguous.push({ id: orphan.id, email: orphan.email, ambiguous });
      summary.review.push({ id: orphan.id, email: orphan.email, reason });
      warn(`NEEDS_REVIEW · ${reason}`);
      if (APPLY && MARK) await upsertReview({ id: orphan.id, email: orphan.email, recovered: null, status: 'needs_review', reason });
      exitCode = 4;
      continue;
    }

    const owner = await emailOwner(recovered.email);

    if (owner && owner.id !== String(orphan.id)) {
      // FIX-ORPHAN: el email real YA es otra fila (perfil con email/password
      // u otro OAuth). Por default: revisión. Con --merge (y sin password del
      // huérfano): reasignar datos y borrar el huérfano.
      if (MERGE && APPLY && !orphan.password_hash) {
        warn(`MERGE · ${recovered.email} ya es ${owner.id}; reasignando Chat/Memory y borrando el huérfano`);
        await mergeInto(orphan.id, owner.id);
        summary.fixed.push({
          id: orphan.id, email: orphan.email,
          recovered: recovered.email, source: recovered.source,
          mergedInto: owner.id, applied: true,
        });
        continue;
      }
      const reason = owner.id && orphan.password_hash
        ? `conflict con perfil existente ${String(owner.id).slice(0, 8)} (huérfano y destino tienen password_hash: revisión manual)`
        : `conflict con perfil existente ${String(owner.id).slice(0, 8)} (usa --apply --merge para fusionar)`;
      warn(`CONFLICT · ${recovered.email} → ${reason}`);
      summary.conflicts.push({ id: orphan.id, email: orphan.email, recovered: recovered.email, ownerId: owner.id });
      if (APPLY && MARK) await upsertReview({ id: orphan.id, email: orphan.email, recovered: recovered.email, status: 'conflict', reason });
      exitCode = 4;
      continue;
    }

    try {
      if (APPLY) {
        await restoreEmail(orphan.id, recovered);
        ok(`RESTAURADO · ${orphan.email} → ${recovered.email} (${recovered.source})`);
      } else {
        ok(`(dry-run) restauraría · ${orphan.email} → ${recovered.email} (${recovered.source})`);
      }
      summary.fixed.push({
        id: orphan.id, email: orphan.email,
        recovered: recovered.email, source: recovered.source,
        applied: APPLY,
      });
    } catch (e) {
      const reason = `update falló: ${e.message}`;
      warn(`UPDATE_ERROR · ${orphan.email} → ${reason}${e.code === '23505' ? ' (email real ya existe: carrera, se marca como conflicto)' : ''}`);
      summary.conflicts.push({ id: orphan.id, email: orphan.email, recovered: recovered.email, reason });
      if (APPLY && MARK) await upsertReview({ id: orphan.id, email: orphan.email, recovered: recovered.email, status: 'conflict', reason });
      exitCode = 4;
    }

    if (APPLY && MARK) {
      const al = summary.fixed.at(-1);
      if (al && al.id === String(orphan.id)) {
        await upsertReview({ id: orphan.id, email: orphan.email, recovered: recovered.email, status: 'fixed', reason: recovered.source });
      }
    }
  }

  say('');
  ok(`resumen · ${APPLY ? 'aplicados' : 'a aplicar (dry)'} ${summary.fixed.length} · conflictos ${summary.conflicts.length} · revisión ${summary.review.length}${summary.ambiguous.length ? ` · ambiguos ${summary.ambiguous.length}` : ''}`);

  if (APPLY && !summary.conflicts.length && !summary.review.length && summary.fixed.length) {
    say('');
    ok('Se recomienda re-verificar con: node scripts/fix-orphaned-emails.js');
  }

  if (reportFile) {
    const out = { generatedAt: new Date().toISOString(), apply: APPLY, domains: DOMAINS, summary };
    const file = path.resolve(reportFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(out, null, 2), 'utf8');
    ok(`reporte JSON → ${file}`);
  }

  await sql.end();
  process.exit(exitCode);
}

main().catch(async (e) => {
  err(`Error fatal: ${e.message}`);
  try { await sql.end(); } catch {}
  process.exit(2);
});
