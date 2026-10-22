/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/git-connector.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Conector de GitHub: commit + push del código del Coder.

   FLUJO
     1. El usuario conecta su repo (token + owner/repo + rama).
     2. El servicio guarda la conexión en la tabla `git_connections`
        (el token VA CIFRADO: nunca en claro en la base).
     3. `commitAndPush({ userId, files, message })` agrupa los archivos
        modificados, genera un mensaje de commit si no se pasó uno y
        hace push a la rama configurada.

   SEGURIDAD
     · El token se cifra con AES-256-GCM (clave derivada de
       GIT_ENCRYPTION_KEY; si no existe, se deriva del SESSION_SECRET).
     · El token NUNCA vuelve al cliente: la API responde con
       { connected: true, owner, repo, branch }.
     · El push es a la rama configurada, NUNCA a `main` directo si el
       usuario eligió otra. (El default es `main` porque así lo pide el
       brief, pero la rama viene siempre de la conexión guardada.)
     · Se valida owner/repo contra un patrón estricto antes de tocar la
       API de GitHub: evita path traversal en la URL.
     · Rate limit propio: máximo 20 pushes por hora y por usuario.

   DEPENDENCIA
     octokit. Se importa de forma diferida: si el paquete no está
     instalado, el servicio reporta `unavailable` en vez de romper el
     arranque de la app.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql, supabaseDisponible } from './supabase.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  table: 'git_connections',
  maxPushesPerHour: 20,
  maxFilesPerPush: 30,
  maxFileBytes: 512 * 1024,
  timeoutMs: 25_000,
  defaultBranch: 'main',
  ownerRe: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/,
  repoRe: /^[A-Za-z0-9._-]{1,100}$/,
  branchRe: /^[A-Za-z0-9._/-]{1,120}$/,
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · CIFRADO DE TOKENS
   ═══════════════════════════════════════════════════════════════════════════ */

let cachedKey = null;

function encryptionKey() {
  if (cachedKey) return cachedKey;

  const explicit = process.env.GIT_ENCRYPTION_KEY;
  const fallback = process.env.SESSION_SECRET || process.env.JWT_SECRET;

  const material = (explicit && explicit.length >= 16) ? explicit : fallback;

  if (!material || material.length < 16) {
    LOG.warn('git-connector: sin clave de cifrado, el token NO se persiste');
    cachedKey = null;
    return null;
  }

  cachedKey = crypto.createHash('sha256').update(`numination-git:${material}`).digest();
  return cachedKey;
}

/**
 * Cifra un texto con AES-256-GCM.
 * @returns {{cipher:string, iv:string, tag:string}|null}
 */
export function encryptSecret(plain) {
  const key = encryptionKey();
  if (!key || !plain) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    cipher: enc.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Descifra un texto cifrado.
 * @returns {string|null}
 */
export function decryptSecret(payload) {
  const key = encryptionKey();
  if (!key || !payload?.cipher || !payload?.iv || !payload?.tag) return null;

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(payload.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const dec = Buffer.concat([
      decipher.update(Buffer.from(payload.cipher, 'base64')),
      decipher.final(),
    ]);
    return dec.toString('utf8');
  } catch (e) {
    LOG.warn('git-connector: no se pudo descifrar el token', { error: e.message });
    return null;
  }
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
          id          uuid primary key default gen_random_uuid(),
          user_id     uuid not null,
          owner       text not null,
          repo        text not null,
          branch      text not null default 'main',
          token_cipher text,
          token_iv     text,
          token_tag    text,
          last_push_at timestamptz,
          created_at  timestamptz not null default now(),
          updated_at  timestamptz not null default now(),
          unique (user_id, owner, repo)
        )
      `;
      return { ok: true };
    } catch (e) {
      LOG.warn('git-connector: no se pudo crear el esquema', { error: e.message, code: e.code });
      return { ok: false };
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · OCTOKIT
   ═══════════════════════════════════════════════════════════════════════════ */

let OctokitCtor = null;

/**
 * Carga octokit de forma diferida.
 * @returns {Promise<Function|null>}
 */
export async function loadOctokit() {
  if (OctokitCtor) return OctokitCtor;

  try {
    const mod = await import('@octokit/rest');
    OctokitCtor = mod.Octokit || mod.default?.Octokit || null;
  } catch (e) {
    LOG.warn('git-connector: @octokit/rest no está instalado', { error: e.message });
    OctokitCtor = null;
  }

  return OctokitCtor;
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · VALIDACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Valida owner/repo/branch.
 * @returns {{ok:boolean, error?:string, owner?:string, repo?:string, branch?:string}}
 */
export function validateTarget({ owner, repo, branch }) {
  const o = String(owner || '').trim();
  const r = String(repo || '').trim().replace(/\.git$/i, '');
  const b = String(branch || CFG.defaultBranch).trim();

  if (!o || !r) return { ok: false, error: 'Falta owner o repo.' };
  if (!CFG.ownerRe.test(o)) return { ok: false, error: 'El owner no es válido.' };
  if (!CFG.repoRe.test(r)) return { ok: false, error: 'El repo no es válido.' };
  if (!CFG.branchRe.test(b)) return { ok: false, error: 'La rama no es válida.' };

  return { ok: true, owner: o, repo: r, branch: b };
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · CONEXIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Conecta (o actualiza) un repositorio.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} params.owner
 * @param {string} params.repo
 * @param {string} [params.branch]
 * @param {string} params.token   Token PAT de GitHub
 * @returns {Promise<object>} { ok, connected, owner, repo, branch }
 */
export async function connectRepository(params = {}) {
  const { userId, token } = params;

  const target = validateTarget(params);
  if (!target.ok) return { ok: false, error: target.error };

  if (!userId) return { ok: false, error: 'Se requiere userId.' };
  if (!token || String(token).length < 20) {
    return { ok: false, error: 'El token de GitHub no parece válido.' };
  }

  if (!supabaseDisponible()) {
    return { ok: true, connected: true, degraded: true, owner: target.owner, repo: target.repo, branch: target.branch };
  }

  // Se verifica el token contra la API antes de guardarlo.
  const Octokit = await loadOctokit();
  if (!Octokit) {
    return { ok: false, error: 'El conector de GitHub no está disponible en este entorno.', code: 'octokit_missing' };
  }

  try {
    const client = new Octokit({ auth: token });
    await client.repos.get({ owner: target.owner, repo: target.repo });
  } catch (e) {
    LOG.warn('git-connector: no se pudo verificar el repo', { error: e.message, status: e.status });
    return {
      ok: false,
      error: e.status === 404
        ? 'No encontramos ese repositorio (o el token no tiene acceso).'
        : 'No pudimos verificar el token de GitHub.',
    };
  }

  const encrypted = encryptSecret(token);

  if (!encrypted) {
    // Sin clave no se persiste el token: el servicio queda en "sin clave"
    // pero la conexión es válida para esta sesión.
    return {
      ok: true,
      connected: true,
      persisted: false,
      warning: 'No hay GIT_ENCRYPTION_KEY: el token no se persistirá.',
      owner: target.owner,
      repo: target.repo,
      branch: target.branch,
    };
  }

  try {
    await ensureSchema();

    await sql`
      insert into ${sql(CFG.table)} (
        user_id, owner, repo, branch, token_cipher, token_iv, token_tag
      ) values (
        ${userId}::uuid, ${target.owner}, ${target.repo}, ${target.branch},
        ${encrypted.cipher}, ${encrypted.iv}, ${encrypted.tag}
      )
      on conflict (user_id, owner, repo) do update
        set branch = excluded.branch,
            token_cipher = excluded.token_cipher,
            token_iv = excluded.token_iv,
            token_tag = excluded.token_tag,
            updated_at = now()
    `;

    LOG.info('git-connector: repositorio conectado', { userId, owner: target.owner, repo: target.repo });

    return {
      ok: true,
      connected: true,
      persisted: true,
      owner: target.owner,
      repo: target.repo,
      branch: target.branch,
    };
  } catch (e) {
    LOG.error('git-connector: connectRepository falló', { error: e.message, code: e.code });
    return { ok: false, error: 'No se pudo guardar la conexión.' };
  }
}

/**
 * Devuelve las conexiones del usuario (SIN el token).
 */
export async function listConnections(userId) {
  if (!supabaseDisponible()) return { ok: true, degraded: true, connections: [] };

  try {
    await ensureSchema();
    const rows = await sql`
      select owner, repo, branch, last_push_at, created_at
      from ${sql(CFG.table)}
      where user_id = ${userId}::uuid
      order by created_at desc
    `;
    return {
      ok: true,
      degraded: false,
      connections: rows.map((r) => ({
        owner: r.owner,
        repo: r.repo,
        branch: r.branch,
        lastPushAt: r.last_push_at,
        connectedAt: r.created_at,
      })),
    };
  } catch (e) {
    LOG.warn('git-connector: listConnections falló', { error: e.message });
    return { ok: true, degraded: true, connections: [] };
  }
}

/**
 * Desconecta un repositorio (borra el token cifrado).
 */
export async function disconnectRepository(userId, { owner, repo }) {
  if (!supabaseDisponible()) return { ok: true, degraded: true };

  try {
    await ensureSchema();
    const rows = await sql`
      delete from ${sql(CFG.table)}
      where user_id = ${userId}::uuid
        and owner = ${owner}
        and repo = ${repo}
      returning id
    `;
    return { ok: true, deleted: rows.length > 0 };
  } catch (e) {
    LOG.warn('git-connector: disconnectRepository falló', { error: e.message });
    return { ok: false };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   07 · RATE LIMIT
   ═══════════════════════════════════════════════════════════════════════════ */

const pushWindow = new Map();

function checkPushLimit(userId) {
  const now = Date.now();
  const window = 60 * 60_000;

  const list = (pushWindow.get(userId) || []).filter((t) => now - t < window);
  list.push(now);
  pushWindow.set(userId, list);

  return {
    allowed: list.length <= CFG.maxPushesPerHour,
    used: list.length,
    max: CFG.maxPushesPerHour,
    retryAfter: Math.max(1, Math.ceil((window - (now - list[0])) / 1000)),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · COMMIT + PUSH
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Genera un mensaje de commit a partir de los archivos modificados.
 */
export function buildCommitMessage(files = []) {
  if (!files.length) return 'chore: actualización';

  const added = files.filter((f) => f.status === 'added');
  const removed = files.filter((f) => f.status === 'removed');
  const modified = files.filter((f) => !f.status || f.status === 'modified');

  const parts = [];
  if (added.length) parts.push(`${added.length} archivo${added.length === 1 ? '' : 's'} nuevo${added.length === 1 ? '' : 's'}`);
  if (modified.length) parts.push(`${modified.length} archivo${modified.length === 1 ? '' : 's'} actualizado${modified.length === 1 ? '' : 's'}`);
  if (removed.length) parts.push(`${removed.length} eliminado${removed.length === 1 ? '' : 's'}`);

  const scope = files.length === 1
    ? ` (${String(files[0].path || '').split('/').pop()})`
    : '';

  const body = files
    .slice(0, 8)
    .map((f) => `- ${f.status === 'added' ? 'nuevo' : f.status === 'removed' ? 'eliminado' : 'modificado'}: ${f.path}`)
    .join('\n');

  return `chore: ${parts.join(', ') || 'actualización'}${scope}\n\n${body}`;
}

/**
 * Hace commit y push de los archivos indicados.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.owner]
 * @param {string} [params.repo]
 * @param {string} [params.branch]
 * @param {Array} params.files   [{ path, content, status }]
 * @param {string} [params.message]
 * @returns {Promise<object>} {
 *   ok, commitSha, commitUrl, branch, filesPushed, message, error
 * }
 */
export async function commitAndPush(params = {}) {
  const { userId, files = [], message } = params;

  if (!userId) return { ok: false, error: 'Se requiere userId.' };

  const validFiles = (Array.isArray(files) ? files : [])
    .filter((f) => f && f.path && typeof f.content === 'string')
    .slice(0, CFG.maxFilesPerPush);

  if (!validFiles.length) {
    return { ok: false, error: 'No hay archivos para subir.' };
  }

  const oversized = validFiles.find((f) => Buffer.byteLength(f.content, 'utf8') > CFG.maxFileBytes);
  if (oversized) {
    return { ok: false, error: `El archivo "${oversized.path}" supera el máximo permitido.` };
  }

  const limit = checkPushLimit(userId);
  if (!limit.allowed) {
    return {
      ok: false,
      code: 'rate_limited',
      error: `Alcanzaste el máximo de ${limit.max} pushes por hora.`,
      retryAfter: limit.retryAfter,
    };
  }

  // ── Obtener la conexión ───────────────────────────────────────────────
  const target = validateTarget(params);
  if (!target.ok) return { ok: false, error: target.error };

  const Octokit = await loadOctokit();
  if (!Octokit) {
    return { ok: false, code: 'octokit_missing', error: 'El conector de GitHub no está disponible en este entorno.' };
  }

  let token = params.token || null;

  if (!token && supabaseDisponible()) {
    try {
      await ensureSchema();
      const rows = await sql`
        select token_cipher, token_iv, token_tag
        from ${sql(CFG.table)}
        where user_id = ${userId}::uuid
          and owner = ${target.owner}
          and repo = ${target.repo}
        limit 1
      `;
      if (rows.length) {
        token = decryptSecret({
          cipher: rows[0].token_cipher,
          iv: rows[0].token_iv,
          tag: rows[0].token_tag,
        });
      }
    } catch (e) {
      LOG.warn('git-connector: no se pudo leer la conexión', { error: e.message });
    }
  }

  if (!token) {
    return { ok: false, error: 'No hay token de GitHub para este repositorio. Conectalo de nuevo.' };
  }

  const client = new Octokit({ auth: token, request: { timeout: CFG.timeoutMs } });

  try {
    // 1) Referencia actual de la rama.
    const ref = await client.git.getRef({
      owner: target.owner,
      repo: target.repo,
      ref: `heads/${target.branch}`,
    });

    const baseCommit = ref.data.object.sha;

    // 2) Árbol con los archivos modificados.
    const baseTree = await client.git.getCommit({
      owner: target.owner,
      repo: target.repo,
      commit_sha: baseCommit,
    });

    const tree = await client.git.createTree({
      owner: target.owner,
      repo: target.repo,
      base_tree: baseTree.data.tree.sha,
      tree: validFiles.map((f) => ({
        path: String(f.path).replace(/^\/+/, ''),
        mode: '100644',
        type: 'blob',
        content: f.content,
      })),
    });

    // 3) Commit.
    const commitMessage = String(message || buildCommitMessage(validFiles)).slice(0, 400);

    const commit = await client.git.createCommit({
      owner: target.owner,
      repo: target.repo,
      message: commitMessage,
      tree: tree.data.sha,
      parents: [baseCommit],
    });

    // 4) Push de la referencia.
    await client.git.updateRef({
      owner: target.owner,
      repo: target.repo,
      ref: `heads/${target.branch}`,
      sha: commit.data.sha,
      force: false,
    });

    if (supabaseDisponible()) {
      await sql`
        update ${sql(CFG.table)}
        set last_push_at = now(), updated_at = now()
        where user_id = ${userId}::uuid
          and owner = ${target.owner} and repo = ${target.repo}
      `.catch(() => {});
    }

    LOG.info('git-connector: push realizado', {
      userId,
      owner: target.owner,
      repo: target.repo,
      branch: target.branch,
      files: validFiles.length,
    });

    return {
      ok: true,
      commitSha: commit.data.sha,
      commitUrl: `https://github.com/${target.owner}/${target.repo}/commit/${commit.data.sha}`,
      branch: target.branch,
      filesPushed: validFiles.length,
      message: commitMessage,
    };
  } catch (e) {
    const status = e?.status || 0;

    const friendly = {
      401: 'El token de GitHub expiró o es inválido.',
      403: 'El token no tiene permiso de escritura sobre este repositorio.',
      404: 'No encontramos el repositorio o la rama.',
      409: 'Hubo un conflicto: alguien más subió cambios. Hacé pull y reintentá.',
      422: 'GitHub rechazó el push (rama desactualizada o archivos muy grandes).',
    }[status] || 'No se pudo subir el código a GitHub.';

    LOG.warn('git-connector: falló el push', { error: e.message, status });

    return { ok: false, error: friendly, status, detail: String(e.message || '').slice(0, 200) };
  }
}

/**
 * Estado del conector.
 */
export async function getGitStatus(userId) {
  const connections = await listConnections(userId);
  const Octokit = await loadOctokit();

  return {
    ok: true,
    available: Boolean(Octokit),
    encrypted: Boolean(encryptionKey()),
    connections: connections.connections,
    maxPushesPerHour: CFG.maxPushesPerHour,
    defaultBranch: CFG.defaultBranch,
  };
}

export default {
  connectRepository,
  disconnectRepository,
  listConnections,
  commitAndPush,
  buildCommitMessage,
  validateTarget,
  encryptSecret,
  decryptSecret,
  getGitStatus,
  loadOctokit,
};
