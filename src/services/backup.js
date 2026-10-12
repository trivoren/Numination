/* ================================================================
   NUMINATION · backup.js · v1.0
   ----------------------------------------------------------------
   Sistema de backup y restore de la base de datos.

   ¿POR QUÉ EXISTE?
   Supabase hace backups automáticos, pero:
     · No controlás cuándo ni qué
     · No podés descargar un snapshot puntual
     · No podés restaurar una tabla específica
     · No podés migrar a otro proyecto
     · No sabés si el backup se puede restaurar

   Este módulo te da control total:

     · Backup manual con un click
     · Backup programado (cron/scheduled)
     · Snapshot por tabla (no todo o nada)
     · Compresión gzip (10x más chico)
     · Checksum SHA-256 (verificar integridad)
     · Retención automática (borra los viejos)
     · Restore selectivo (con confirmación)
     · Descarga (para guardar offline)
     · Almacenamiento en Supabase Storage (o local en dev)

   ESTRUCTURA:

     1  · Configuración
     2  · Storage adapters (Supabase, local)
     3  · Serializer (queries de todas las tablas)
     4  · Compresión y checksum
     5  · Operaciones: create, list, get, delete
     6  · Restore
     7  · Descarga
     8  · Retención automática
     9  · Programación (cron hook)
    10  · Health check
    11  · Self-test
    12  · Exports

   USO BÁSICO:

     import { createBackup, listBackups, restoreBackup } from './services/backup.js';

     // Crear snapshot
     const result = await createBackup({ createdBy: 'admin@example.com' });
     console.log(result.backup.id, result.backup.size);

     // Listar
     const backups = await listBackups();

     // Restaurar (con confirmación)
     await restoreBackup(id, { confirm: 'RESTORE' });

   ================================================================ */

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  /* Bucket de Supabase Storage donde se guardan los backups */
  bucket: process.env.BACKUP_BUCKET || 'numination-backups',

  /* Carpeta local para backups (dev) */
  localDir: process.env.BACKUP_LOCAL_DIR || './.backups',

  /* Cuántos backups mantener (se borran los más viejos) */
  retentionCount: parseInt(process.env.BACKUP_RETENTION || '30', 10),

  /* Retención en días (independiente del count) */
  retentionDays: parseInt(process.env.BACKUP_RETENTION_DAYS || '90', 10),

  /* Formato del backup */
  format: 'json-gzip',

  /* Versión del schema del backup */
  schemaVersion: 1,

  /* Timeout por operación de red */
  netTimeoutMs: 60000,

  /* Tamaño máximo de un backup (bytes) */
  maxSizeBytes: 500 * 1024 * 1024, // 500 MB
});

/* Tablas que se incluyen en el backup. Orden importante para restore. */
const BACKUP_TABLES = [
  'profiles',       // Primero: no depende de nada
  'Chat',           // Depende de profiles
  'Message',        // Depende de Chat
  'Memory',         // Depende de profiles
  '_migrations',    // Estado del schema
];

/* ═══════════════════════════════════════════════════════════════════════
   2 · STORAGE ADAPTERS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Adapter de Supabase Storage.
 * Usa la REST API con el service_key.
 */
const SupabaseStorage = {
  name: 'supabase',

  available() {
    return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);
  },

  async upload(filename, buffer, contentType = 'application/gzip') {
    const url = `${process.env.SUPABASE_URL}/storage/v1/object/${CFG.bucket}/${filename}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': contentType,
        'x-upsert': 'true',
      },
      body: buffer,
      signal: AbortSignal.timeout(CFG.netTimeoutMs),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Supabase Storage ${res.status}: ${txt.slice(0, 200)}`);
    }
    return { ok: true, path: filename };
  },

  async download(filename) {
    const url = `${process.env.SUPABASE_URL}/storage/v1/object/${CFG.bucket}/${filename}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      },
      signal: AbortSignal.timeout(CFG.netTimeoutMs),
    });
    if (!res.ok) throw new Error(`Download ${res.status}`);
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  },

  async delete(filename) {
    const url = `${process.env.SUPABASE_URL}/storage/v1/object/${CFG.bucket}/${filename}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      },
      signal: AbortSignal.timeout(CFG.netTimeoutMs),
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Delete ${res.status}`);
    }
    return { ok: true };
  },

  async list() {
    const url = `${process.env.SUPABASE_URL}/storage/v1/object/list/${CFG.bucket}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prefix: '', limit: 1000 }),
      signal: AbortSignal.timeout(CFG.netTimeoutMs),
    });
    if (!res.ok) throw new Error(`List ${res.status}`);
    const items = await res.json();
    return Array.isArray(items) ? items.map((i) => ({
      name: i.name,
      size: i.metadata?.size || 0,
      createdAt: i.created_at || i.updated_at,
    })) : [];
  },
};

/**
 * Adapter de filesystem local (dev).
 */
const LocalStorage = {
  name: 'local',

  available() {
    return true;
  },

  async upload(filename, buffer) {
    if (!fs.existsSync(CFG.localDir)) {
      fs.mkdirSync(CFG.localDir, { recursive: true });
    }
    const filepath = path.join(CFG.localDir, filename);
    fs.writeFileSync(filepath, buffer);
    return { ok: true, path: filepath };
  },

  async download(filename) {
    const filepath = path.join(CFG.localDir, filename);
    if (!fs.existsSync(filepath)) throw new Error('File not found');
    return fs.readFileSync(filepath);
  },

  async delete(filename) {
    const filepath = path.join(CFG.localDir, filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    return { ok: true };
  },

  async list() {
    if (!fs.existsSync(CFG.localDir)) return [];
    const files = fs.readdirSync(CFG.localDir);
    return files
      .filter((f) => f.endsWith('.json.gz') || f.endsWith('.meta.json'))
      .map((name) => {
        const filepath = path.join(CFG.localDir, name);
        const stats = fs.statSync(filepath);
        return {
          name,
          size: stats.size,
          createdAt: stats.mtime.toISOString(),
        };
      });
  },
};

/**
 * Devuelve el storage a usar.
 * Prioridad: Supabase Storage > Local.
 */
function getStorage() {
  if (SupabaseStorage.available()) return SupabaseStorage;
  return LocalStorage;
}

/* ═══════════════════════════════════════════════════════════════════════
   3 · SERIALIZER · dumps de tablas
   ═══════════════════════════════════════════════════════════════════════ */

let _sql = null;

async function getSql() {
  if (_sql) return _sql;
  try {
    const mod = await import('./supabase.js');
    _sql = mod.sql || null;
  } catch {}
  return _sql;
}

export function setSql(client) {
  _sql = client;
}

/**
 * Dumpea una tabla a un array de objetos.
 */
async function dumpTable(sql, tableName) {
  try {
    const rows = await sql.unsafe(`SELECT * FROM "${tableName}"`);
    return { ok: true, rows };
  } catch (e) {
    // Tabla no existe → no es error, la saltamos
    if (/does not exist/i.test(e.message)) {
      return { ok: true, rows: [], skipped: true };
    }
    return { ok: false, error: e.message };
  }
}

/**
 * Serializa todas las tablas a un objeto.
 */
async function serializeAll(sql, opts = {}) {
  const tables = opts.tables || BACKUP_TABLES;
  const data = {};
  const stats = { tables: {}, totalRows: 0 };

  for (const table of tables) {
    const r = await dumpTable(sql, table);
    if (r.ok) {
      data[table] = r.rows;
      stats.tables[table] = r.rows.length;
      stats.totalRows += r.rows.length;
    } else {
      stats.tables[table] = `ERROR: ${r.error}`;
    }
  }

  return { data, stats };
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · COMPRESIÓN Y CHECKSUM
   ═══════════════════════════════════════════════════════════════════════ */

async function compress(jsonString) {
  const buffer = Buffer.from(jsonString, 'utf8');
  const compressed = await gzip(buffer, { level: 9 });
  return compressed;
}

async function decompress(buffer) {
  const decompressed = await gunzip(buffer);
  return decompressed.toString('utf8');
}

function checksum(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function makeBackupId() {
  const now = new Date();
  const date = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = crypto.randomBytes(4).toString('hex');
  return `bk_${date}_${rand}`;
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · OPERACIONES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Crea un backup completo.
 *
 * @param {object} opts
 * @param {string} [opts.createdBy]   · quién lo creó
 * @param {string} [opts.reason]      · 'manual' | 'scheduled' | 'pre-migration'
 * @param {string[]} [opts.tables]    · tablas a incluir (default: todas)
 * @returns {Promise<object>}
 */
export async function createBackup(opts = {}) {
  const t0 = Date.now();

  try {
    const sql = await getSql();
    if (!sql) return { ok: false, error: 'no_db' };

    const id = makeBackupId();
    const storage = getStorage();

    console.log(`[backup] iniciando ${id}...`);

    // 1 · Serializar datos
    const { data, stats } = await serializeAll(sql, { tables: opts.tables });

    // 2 · Construir payload completo
    const payload = {
      schemaVersion: CFG.schemaVersion,
      id,
      createdAt: new Date().toISOString(),
      createdBy: opts.createdBy || 'system',
      reason: opts.reason || 'manual',
      tables: opts.tables || BACKUP_TABLES,
      stats,
      data,
    };

    // 3 · Serializar a JSON
    const json = JSON.stringify(payload);

    // 4 · Comprimir
    const compressed = await compress(json);

    // 5 · Verificar tamaño
    if (compressed.length > CFG.maxSizeBytes) {
      return { ok: false, error: 'too_large', size: compressed.length };
    }

    // 6 · Checksum
    const sum = checksum(compressed);

    // 7 · Metadata
    const meta = {
      id,
      createdAt: payload.createdAt,
      createdBy: payload.createdBy,
      reason: payload.reason,
      tables: payload.tables,
      schemaVersion: payload.schemaVersion,
      sizeBytes: compressed.length,
      sizeRawBytes: json.length,
      checksum: sum,
      stats,
    };

    // 8 · Subir a storage
    const filename = `${id}.json.gz`;
    const metaFilename = `${id}.meta.json`;

    await storage.upload(filename, compressed);
    await storage.upload(metaFilename, Buffer.from(JSON.stringify(meta, null, 2)), 'application/json');

    const durationMs = Date.now() - t0;
    console.log(`[backup] ${id} OK · ${(compressed.length / 1024).toFixed(1)}KB · ${stats.totalRows} filas · ${durationMs}ms`);

    // 9 · Aplicar retención
    await applyRetention(storage).catch((e) => {
      console.warn('[backup] retención falló:', e.message);
    });

    return {
      ok: true,
      backup: {
        id,
        createdAt: meta.createdAt,
        createdBy: meta.createdBy,
        reason: meta.reason,
        tables: meta.tables,
        sizeBytes: compressed.length,
        sizeRawBytes: json.length,
        checksum: sum,
        durationMs,
        stats,
      },
    };
  } catch (e) {
    console.error('[backup] error:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Lista todos los backups.
 */
export async function listBackups() {
  try {
    const storage = getStorage();
    const files = await storage.list();

    // Filtrar solo los .meta.json
    const metaFiles = files.filter((f) => f.name.endsWith('.meta.json'));

    const backups = [];
    for (const f of metaFiles) {
      try {
        const buffer = await storage.download(f.name);
        const meta = JSON.parse(buffer.toString('utf8'));
        backups.push(meta);
      } catch (e) {
        console.warn(`[backup] no pude leer ${f.name}:`, e.message);
      }
    }

    // Ordenar por fecha descendente
    backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return { ok: true, backups };
  } catch (e) {
    return { ok: false, error: e.message, backups: [] };
  }
}

/**
 * Obtiene el metadata de un backup.
 */
export async function getBackup(id) {
  try {
    const storage = getStorage();
    const buffer = await storage.download(`${id}.meta.json`);
    return { ok: true, backup: JSON.parse(buffer.toString('utf8')) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Descarga un backup completo (para guardar offline).
 */
export async function downloadBackup(id) {
  try {
    const storage = getStorage();
    const buffer = await storage.download(`${id}.json.gz`);
    return { ok: true, buffer, filename: `${id}.json.gz` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Elimina un backup.
 */
export async function deleteBackup(id) {
  try {
    const storage = getStorage();
    await storage.delete(`${id}.json.gz`);
    await storage.delete(`${id}.meta.json`);
    console.log(`[backup] ${id} eliminado`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · RESTORE
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Restaura un backup.
 *
 * IMPORTANTE: es una operación destructiva.
 * Requiere confirmación textual: { confirm: 'RESTORE' }
 *
 * @param {string} id
 * @param {object} opts
 * @param {string} opts.confirm     · debe ser 'RESTORE'
 * @param {boolean} [opts.truncate] · si true, borra las tablas antes de insertar
 * @param {string[]} [opts.tables]  · tablas a restaurar (default: todas las del backup)
 */
export async function restoreBackup(id, opts = {}) {
  const t0 = Date.now();

  try {
    if (opts.confirm !== 'RESTORE') {
      return { ok: false, error: 'confirmation_required' };
    }

    const sql = await getSql();
    if (!sql) return { ok: false, error: 'no_db' };

    const storage = getStorage();

    // 1 · Descargar backup
    console.log(`[backup] descargando ${id}...`);
    const buffer = await storage.download(`${id}.json.gz`);

    // 2 · Verificar checksum
    const metaBuffer = await storage.download(`${id}.meta.json`);
    const meta = JSON.parse(metaBuffer.toString('utf8'));
    const computed = checksum(buffer);

    if (computed !== meta.checksum) {
      return {
        ok: false,
        error: 'checksum_mismatch',
        expected: meta.checksum,
        computed,
      };
    }

    // 3 · Descomprimir
    const json = await decompress(buffer);
    const payload = JSON.parse(json);

    // 4 · Determinar tablas a restaurar
    const tables = opts.tables && opts.tables.length > 0
      ? opts.tables.filter((t) => payload.tables.includes(t))
      : payload.tables;

    // 5 · Restaurar en orden
    const results = [];

    for (const table of tables) {
      const rows = payload.data[table] || [];

      if (rows.length === 0) {
        results.push({ table, rows: 0, skipped: true });
        continue;
      }

      try {
        await sql.begin(async (trx) => {
          // Truncar si se pidió
          if (opts.truncate) {
            await trx.unsafe(`TRUNCATE TABLE "${table}" CASCADE`);
          }

          // Insertar por lotes de 100
          const chunkSize = 100;
          for (let i = 0; i < rows.length; i += chunkSize) {
            const chunk = rows.slice(i, i + chunkSize);

            // Construir INSERT multi-row
            const columns = Object.keys(chunk[0]);
            const quotedCols = columns.map((c) => `"${c}"`).join(', ');

            const values = [];
            const placeholders = [];

            chunk.forEach((row, rowIdx) => {
              const rowPlaceholders = [];
              columns.forEach((col) => {
                values.push(row[col]);
                rowPlaceholders.push(`$${values.length}`);
              });
              placeholders.push(`(${rowPlaceholders.join(', ')})`);
            });

            const query = `
              INSERT INTO "${table}" (${quotedCols})
              VALUES ${placeholders.join(', ')}
              ON CONFLICT DO NOTHING
            `;

            await trx.unsafe(query, values);
          }
        });

        results.push({ table, rows: rows.length });
      } catch (e) {
        results.push({ table, error: e.message, rows: 0 });
      }
    }

    const durationMs = Date.now() - t0;
    const totalRestored = results.reduce((s, r) => s + (r.rows || 0), 0);

    console.log(`[backup] restore ${id} OK · ${totalRestored} filas · ${durationMs}ms`);

    return {
      ok: true,
      id,
      durationMs,
      totalRestored,
      results,
    };
  } catch (e) {
    console.error('[backup] restore error:', e.message);
    return { ok: false, error: e.message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · RETENCIÓN AUTOMÁTICA
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Aplica política de retención:
 *   · Mantener los N más recientes
 *   · Borrar los que tengan más de X días
 */
async function applyRetention(storage) {
  const { backups } = await listBackups();
  if (!backups || backups.length === 0) return { deleted: 0 };

  const cutoff = Date.now() - CFG.retentionDays * 86400 * 1000;
  const toDelete = [];

  backups.forEach((b, i) => {
    const age = new Date(b.createdAt).getTime();

    // Borrar si está fuera de los N más recientes
    if (i >= CFG.retentionCount) {
      toDelete.push(b.id);
      return;
    }

    // Borrar si es más viejo que X días
    if (age < cutoff) {
      toDelete.push(b.id);
    }
  });

  for (const id of toDelete) {
    try {
      await storage.delete(`${id}.json.gz`);
      await storage.delete(`${id}.meta.json`);
    } catch (e) {
      console.warn(`[backup] no pude borrar ${id}:`, e.message);
    }
  }

  if (toDelete.length > 0) {
    console.log(`[backup] retención: ${toDelete.length} backups eliminados`);
  }

  return { deleted: toDelete.length, ids: toDelete };
}

export async function runRetention() {
  const storage = getStorage();
  return applyRetention(storage);
}

/* ═══════════════════════════════════════════════════════════════════════
   8 · PROGRAMACIÓN · hook para cron
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Hook que se ejecuta desde un cron externo (Vercel Cron, GitHub Actions,
 * cron-job.org, etc.).
 *
 * Ejemplo de uso desde un endpoint:
 *   app.post('/api/admin/backup/cron', (req, res) => {
 *     if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
 *       return res.status(401).json({ error: 'unauthorized' });
 *     }
 *     createBackup({ reason: 'scheduled' }).then(r => res.json(r));
 *   });
 *
 * Configuración de Vercel Cron (vercel.json):
 *   {
 *     "crons": [
 *       { "path": "/api/admin/backup/cron", "schedule": "0 3 * * *" }
 *     ]
 *   }
 */
export async function scheduledBackup() {
  return createBackup({
    reason: 'scheduled',
    createdBy: 'cron',
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   9 · HEALTH CHECK
   ═══════════════════════════════════════════════════════════════════════ */

export async function pingBackup() {
  try {
    const storage = getStorage();
    const files = await storage.list();

    const backupFiles = files.filter((f) => f.name.endsWith('.meta.json'));
    const lastBackup = backupFiles
      .map((f) => ({
        name: f.name,
        size: f.size,
        createdAt: f.createdAt,
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

    return {
      ok: true,
      storage: storage.name,
      bucket: CFG.bucket,
      totalBackups: backupFiles.length,
      lastBackup: lastBackup ? {
        name: lastBackup.name,
        size: lastBackup.size,
        createdAt: lastBackup.createdAt,
      } : null,
      retention: {
        count: CFG.retentionCount,
        days: CFG.retentionDays,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const errors = [];

  // 1 · Config válida
  if (CFG.retentionCount < 1) errors.push('retentionCount < 1');
  if (CFG.retentionDays < 1) errors.push('retentionDays < 1');
  if (!CFG.bucket) errors.push('bucket vacío');

  // 2 · Tablas listadas
  if (BACKUP_TABLES.length === 0) errors.push('BACKUP_TABLES vacío');

  // 3 · Tabla profiles primero (importante para restore)
  if (BACKUP_TABLES[0] !== 'profiles') {
    errors.push('profiles debe ser la primera tabla (FK order)');
  }

  // 4 · Storage disponible
  const storage = getStorage();
  if (!storage) errors.push('sin storage');
  if (!storage.name) errors.push('storage sin name');

  // 5 · ID generable
  const id1 = makeBackupId();
  const id2 = makeBackupId();
  if (id1 === id2) errors.push('makeBackupId no es único');
  if (!id1.startsWith('bk_')) errors.push('ID no empieza con bk_');

  // 6 · Checksum determinista
  const buf = Buffer.from('test data');
  const c1 = checksum(buf);
  const c2 = checksum(buf);
  if (c1 !== c2) errors.push('checksum no determinista');
  if (c1.length !== 64) errors.push('checksum no es SHA-256');

  return {
    ok: errors.length === 0,
    errors,
    storage: storage.name,
    bucket: CFG.bucket,
    tables: BACKUP_TABLES,
    retention: {
      count: CFG.retentionCount,
      days: CFG.retentionDays,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   FIN
   ═══════════════════════════════════════════════════════════════════════ */