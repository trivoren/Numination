/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/backup-robot.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Robot de backups: `pg_dump` diario → `/backups` → retención.

   POR QUÉ child_process Y NO UN SERVICIO EXTERNO
     `pg_dump` es la herramienta oficial de Postgres: sabe resolver el
     formato custom, hacer dumps paralelos y comprimir. No hay que
     reinventarlo.

   SEGURIDAD (esto es lo importante)
     · El DSN NUNCA se pasa por la línea de comandos (queda en el
       `ps` de la máquina). Se pasa por variable de entorno
       `PGPASSWORD` + argumentos, y además se usa `--dbname` con URL
       sanitizada.
     · El comando se ejecuta con `execFile` (NO `exec`): sin shell, sin
       interpretación de metacaracteres, sin inyección de comandos.
     · La ruta de salida se valida contra el directorio de backups.
     · Timeout duro: si pg_dump se cuelga, se mata.
     · El dump se comprime con gzip (o se deja en formato custom, que ya
       está comprimido).

   PLAN DE RECUPERACIÓN
     · `latest.sql.gz` → copia del último backup.
     · Se conserva N días (por defecto 14).
     · Un backup que falla NO borra el anterior: los backups se limpian
       sólo después de que haya uno nuevo y válido.
   ═══════════════════════════════════════════════════════════════════════════ */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { LOG } from '../lib/logger.js';

const execFileAsync = promisify(execFile);

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  backupDir: process.env.BACKUP_DIR || path.join(process.cwd(), 'backups'),
  intervalMs: 24 * 60 * 60_000,     // 24 h
  retentionDays: Number(process.env.BACKUP_RETENTION_DAYS) || 14,
  timeoutMs: 15 * 60_000,           // 15 min máximo para el dump
  format: 'custom',                 // custom | plain
  compress: true,
  maxBufferBytes: 4 * 1024 * 1024,
  binary: 'pg_dump',
  psqlHost: 'db',
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Obtiene el DSN de la base de datos sin exponerlo en los logs.
 */
export function getConnectionConfig() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || null;

  if (url) {
    try {
      const parsed = new URL(url);
      return {
        host: parsed.hostname,
        port: parsed.port || '5432',
        user: decodeURIComponent(parsed.username || 'postgres'),
        password: decodeURIComponent(parsed.password || ''),
        database: parsed.pathname.replace(/^\//, '') || 'postgres',
        ssl: parsed.searchParams.get('sslmode') === 'disable' ? false : 'require',
      };
    } catch (e) {
      LOG.warn('backup-robot: DATABASE_URL inválida', { error: e.message });
    }
  }

  return {
    host: process.env.PGHOST || CFG.psqlHost,
    port: process.env.PGPORT || '5432',
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'postgres',
    ssl: process.env.PGSSLMODE !== 'disable',
  };
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Valida que una ruta esté dentro del directorio de backups.
 * Evita que un nombre de archivo malicioso escriba fuera.
 */
export function isInsideBackupDir(target, baseDir = CFG.backupDir) {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base + path.sep);
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · BACKUP
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Ejecuta un backup.
 *
 * @param {object} [opts] { format, compress, dir, timeoutMs }
 * @returns {Promise<object>} {
 *   ok, file, bytes, durationMs, format, error
 * }
 */
export async function runBackup(opts = {}) {
  const started = Date.now();

  const dir = ensureDir(opts.dir || CFG.backupDir);
  const format = opts.format === 'plain' ? 'plain' : CFG.format;
  const compress = opts.compress !== false && format === 'plain';

  const baseName = `numination-${timestamp()}.${format === 'plain' ? 'sql' : 'dump'}`;
  const outFile = path.join(dir, baseName);

  if (!isInsideBackupDir(outFile, dir)) {
    return { ok: false, error: 'Ruta de backup inválida.' };
  }

  const config = getConnectionConfig();

  if (!config.password && !process.env.DATABASE_URL) {
    return { ok: false, error: 'No hay credenciales de base de datos configuradas para el backup.' };
  }

  const args = [
    '--host', config.host,
    '--port', config.port,
    '--username', config.user,
    '--dbname', config.database,
    '--no-password',
    '--verbose',
    '--no-owner',
    '--no-acl',
  ];

  if (format === 'custom') {
    args.push('--format', 'custom', '--compress', '9');
  } else {
    args.push('--format', 'plain', '--no-comments');
  }

  // El DSN viaja por entorno: nunca aparece en la lista de procesos.
  const env = {
    ...process.env,
    PGPASSWORD: config.password,
    PGSSLMODE: config.ssl ? 'require' : 'disable',
  };

  let stdout = '';
  let stderr = '';

  try {
    const result = await execFileAsync(CFG.binary, [...args, '--file', outFile], {
      env,
      timeout: opts.timeoutMs || CFG.timeoutMs,
      maxBuffer: CFG.maxBufferBytes,
      windowsHide: true,
    });

    stdout = result.stdout || '';
    stderr = result.stderr || '';
  } catch (e) {
    // Un fallo puede dejar un archivo parcial: se elimina.
    try {
      if (fs.existsSync(outFile)) fs.unlinkSync(outFile);
    } catch { /* noop */ }

    LOG.error('backup-robot: falló pg_dump', {
      error: e.message,
      code: e.code,
      signal: e.signal,
    });

    return {
      ok: false,
      error: 'pg_dump falló',
      detail: String(e.stderr || e.message || '').slice(0, 400),
      durationMs: Date.now() - started,
    };
  }

  let finalFile = outFile;
  let bytes = 0;

  try {
    bytes = fs.statSync(outFile).size;

    if (compress) {
      const gzFile = `${outFile}.gz`;
      const zlib = await import('node:zlib');
      const { createReadStream, createWriteStream } = await import('node:fs');
      const pipeline = await import('node:stream/promises');

      await pipeline(
        createReadStream(outFile),
        createWriteStream(gzFile, { mode: 0o600 }),
        zlib.createGzip({ level: 6 })
      );

      fs.unlinkSync(outFile);
      finalFile = gzFile;
      bytes = fs.statSync(gzFile).size;
    }
  } catch (e) {
    LOG.warn('backup-robot: no se pudo comprimir el backup', { error: e.message });
  }

  // Enlace al último backup válido.
  try {
    const latestLink = path.join(dir, `latest${compress ? '.sql.gz' : format === 'plain' ? '.sql' : '.dump'}`);
    if (fs.existsSync(latestLink)) fs.unlinkSync(latestLink);
    fs.symlinkSync(path.basename(finalFile), latestLink);
  } catch (e) {
    LOG.debug('backup-robot: no se pudo crear el enlace latest', { error: e.message });
  }

  // Checksum: permite verificar la integridad del archivo.
  let checksum = null;
  try {
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(finalFile));
    checksum = hash.digest('hex');
  } catch {
    /* archivos grandes: se omite el checksum */
  }

  const durationMs = Date.now() - started;

  LOG.info('backup-robot: backup completado', {
    file: path.basename(finalFile),
    bytes,
    durationMs,
  });

  return {
    ok: true,
    file: finalFile,
    name: path.basename(finalFile),
    bytes,
    checksum,
    durationMs,
    format,
    compressed: compress,
    stderrTail: String(stderr).slice(-400),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · LISTADO Y RETENCIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Lista los backups disponibles.
 */
export function listBackups(dir = CFG.backupDir) {
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((name) => /^numination-/.test(name))
    .map((name) => {
      const full = path.join(dir, name);
      let stat = null;
      try { stat = fs.statSync(full); } catch { /* symlink roto */ }
      return {
        name,
        path: full,
        bytes: stat ? stat.size : 0,
        createdAt: stat ? stat.mtime.toISOString() : null,
        ageDays: stat ? Math.floor((Date.now() - stat.mtime.getTime()) / 86400000) : 0,
      };
    })
    .sort((a, b) => String(b.name).localeCompare(String(a.name)));
}

/**
 * Elimina los backups con más de N días.
 *
 * @param {number} [days]
 * @returns {{ok:boolean, deleted:string[], kept:number}}
 */
export function pruneBackups(days = CFG.retentionDays) {
  const dir = CFG.backupDir;
  const backups = listBackups(dir);
  const deleted = [];

  for (const backup of backups) {
    if (backup.ageDays <= days) continue;
    try {
      fs.unlinkSync(backup.path);
      deleted.push(backup.name);
    } catch (e) {
      LOG.warn('backup-robot: no se pudo borrar un backup', { name: backup.name, error: e.message });
    }
  }

  if (deleted.length) {
    LOG.info('backup-robot: retención aplicada', { deleted: deleted.length, days });
  }

  return { ok: true, deleted, kept: listBackups(dir).length };
}

/**
 * Restaura un backup (helper para documentar el procedimiento).
 * No ejecuta nada: devuelve el comando exacto.
 */
export function getRestoreCommand(backupName) {
  const file = path.join(CFG.backupDir, backupName);
  if (!isInsideBackupDir(file)) {
    return { ok: false, error: 'Nombre de backup inválido.' };
  }

  const isCustom = backupName.endsWith('.dump');
  const cmd = isCustom
    ? `pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" "${file}"`
    : `gunzip -c "${file}" | psql "$DATABASE_URL"`;

  return { ok: true, command: cmd, file, format: isCustom ? 'custom' : 'sql' };
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · CRON
   ═══════════════════════════════════════════════════════════════════════════ */

let timer = null;

/**
 * Arranca el robot de backups. Idempotente.
 */
export function startBackupRobot(opts = {}) {
  if (timer) return timer;

  const interval = opts.intervalMs || CFG.intervalMs;

  timer = setInterval(async () => {
    try {
      const result = await runBackup();
      if (result.ok) {
        pruneBackups(opts.retentionDays || CFG.retentionDays);
      }
    } catch (e) {
      LOG.error('backup-robot: ciclo falló', { error: e.message });
    }
  }, interval);

  if (timer.unref) timer.unref();

  LOG.info('backup-robot: iniciado', { dir: CFG.backupDir, intervalMs: interval });

  return timer;
}

export function stopBackupRobot() {
  if (!timer) return false;
  clearInterval(timer);
  timer = null;
  return true;
}

export function getBackupRobotStatus() {
  const backups = listBackups();
  const totalBytes = backups.reduce((acc, b) => acc + b.bytes, 0);

  return {
    running: Boolean(timer),
    dir: CFG.backupDir,
    intervalMs: CFG.intervalMs,
    retentionDays: CFG.retentionDays,
    count: backups.length,
    totalBytes,
    newest: backups[0] || null,
    binaryAvailable: Boolean(findBinary()),
  };
}

/**
 * Busca el binario pg_dump en el PATH.
 */
export function findBinary() {
  const dirs = (process.env.PATH || '').split(path.delimiter);

  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, CFG.binary + (process.platform === 'win32' ? '.exe' : ''));
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* siguiente */
    }
  }

  return null;
}

export default {
  runBackup,
  listBackups,
  pruneBackups,
  getRestoreCommand,
  startBackupRobot,
  stopBackupRobot,
  getBackupRobotStatus,
  findBinary,
  getConnectionConfig,
  isInsideBackupDir,
};
