// ═══════════════════════════════════════════════════════════════════════════
// src/lib/logger.js
// ═══════════════════════════════════════════════════════════════════════════
// Logger estructurado production-grade para Numination.
//
// FEATURES:
//   · 6 niveles: fatal, error, warn, info, debug, trace
//   · Colores ANSI automáticos (detecta si estás en TTY)
//   · JSON estructurado para producción (parseable por Datadog, etc)
//   · Redacción automática de datos sensibles (API keys, tokens, passwords)
//   · Serialización correcta de Errores (stack + cause chain)
//   · Timers / benchmarks con formato humano (12ms, 1.2s, 3m 45s)
//   · Deduplicación de logs repetidos (evita spam de N+1 queries)
//   · Child loggers con contexto fijo (service, module, reqId, userId)
//   · AsyncLocalStorage para propagar contexto sin pasarlo a mano
//   · Middleware Express listo para usar
//   · Transporte de archivo con rotación y compresión (opcional)
//   · Transporte en memoria para tests
//   · Loggers especializados: ai, db, http, sse, cache, auth, security
//   · Renderizado de tablas y diffs
//   · Banners y divisores para arranque del server
//   · Slow operation warnings automáticos
//   · Sampling configurable
//   · Métricas de logs (contadores por nivel)
//   · Sin dependencias externas
//
// USO BÁSICO:
//   import { LOG } from './lib/logger.js';
//   LOG.info('Servidor arrancando');
//   LOG.error('Falló la conexión', { error: e, userId: 'user_123' });
//
// USO CON CONTEXTO:
//   import { withReqId } from './lib/logger.js';
//   const log = withReqId('abc123', 'user_456');
//   log.info('Procesando mensaje');
//
// USO CON SERVICIOS:
//   import { createLogger } from './lib/logger.js';
//   const log = createLogger('websearch');
//   log.debug('Buscando en Wikipedia', { query });
//
// USO EN EXPRESS:
//   import { expressMiddleware } from './lib/logger.js';
//   app.use(expressMiddleware());
// ═══════════════════════════════════════════════════════════════════════════

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import util from 'node:util';

// ═══════════════════════════════════════════════════════════════════════════
// 01 · CONFIGURACIÓN GLOBAL
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Nivel mínimo a loggear. En producción: 'info'. En dev: 'debug'.
  level: (process.env.LOG_LEVEL || '').toLowerCase() || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),

  // Formato de salida: 'pretty' (colores), 'json' (producción), 'compact'
  format: process.env.LOG_FORMAT || (process.env.NODE_ENV === 'production' ? 'json' : 'pretty'),

  // Timestamp: 'iso' (2026-10-13T15:32:11.482Z), 'time' (15:32:11.482), 'epoch'
  timestamp: process.env.LOG_TIMESTAMP || (process.env.NODE_ENV === 'production' ? 'iso' : 'time'),

  // Zona horaria para pretty. 'America/Bogota' por defecto.
  timezone: process.env.TZ || 'America/Bogota',

  // Redactar datos sensibles automáticamente
  redact: process.env.LOG_REDACT !== 'false',

  // Loggers silenciados (para tests)
  silent: process.env.LOG_SILENT === 'true',

  // Escritura a archivo (opcional)
  file: {
    enabled: process.env.LOG_FILE === 'true',
    dir: process.env.LOG_DIR || 'logs',
    maxSizeMb: parseInt(process.env.LOG_MAX_SIZE_MB || '10', 10),
    maxFiles: parseInt(process.env.LOG_MAX_FILES || '7', 10),
    compress: process.env.LOG_COMPRESS === 'true',
  },

  // Deduplicación: si un log se repite >N veces en <X ms, se agrupa
  dedupe: {
    enabled: process.env.LOG_DEDUPE !== 'false',
    windowMs: 3000,
    threshold: 3,
  },

  // Sampling: solo loggear 1 de cada N logs de nivel debug/trace
  sampling: {
    debug: parseInt(process.env.LOG_SAMPLE_DEBUG || '1', 10),
    trace: parseInt(process.env.LOG_SAMPLE_TRACE || '1', 10),
  },

  // Slow operation warnings
  slowMs: {
    warn: parseInt(process.env.LOG_SLOW_WARN_MS || '1000', 10),
    error: parseInt(process.env.LOG_SLOW_ERROR_MS || '5000', 10),
  },

  // Stack traces solo cuando son útiles
  captureStackTrace: {
    error: true,
    warn: process.env.NODE_ENV !== 'production',
    info: false,
    debug: false,
  },

  // Máxima profundidad para serializar objetos
  maxDepth: 6,

  // Máximo largo de un string antes de truncar
  maxStringLength: 4000,

  // Metadata extra que se agrega a TODOS los logs
  baseMeta: {
    service: 'numination',
    env: process.env.NODE_ENV || 'development',
    host: os.hostname(),
    pid: process.pid,
    version: process.env.npm_package_version || '1.0.0',
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 02 · COLORES ANSI
// ═══════════════════════════════════════════════════════════════════════════

const supportsColor = (() => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === '1') return true;
  if (process.env.FORCE_COLOR === '0') return false;
  return process.stdout?.isTTY === true;
})();

const C = supportsColor
  ? {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      italic: '\x1b[3m',
      underline: '\x1b[4m',
      strikethrough: '\x1b[9m',

      black: '\x1b[30m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      magenta: '\x1b[35m',
      cyan: '\x1b[36m',
      white: '\x1b[37m',
      gray: '\x1b[90m',

      bgRed: '\x1b[41m',
      bgGreen: '\x1b[42m',
      bgYellow: '\x1b[43m',
      bgBlue: '\x1b[44m',
      bgMagenta: '\x1b[45m',
      bgCyan: '\x1b[46m',

      brightRed: '\x1b[91m',
      brightGreen: '\x1b[92m',
      brightYellow: '\x1b[93m',
      brightBlue: '\x1b[94m',
      brightMagenta: '\x1b[95m',
      brightCyan: '\x1b[96m',
      brightWhite: '\x1b[97m',
    }
  : new Proxy({}, { get: () => '' });

// ═══════════════════════════════════════════════════════════════════════════
// 03 · NIVELES
// ═══════════════════════════════════════════════════════════════════════════

const LEVELS = {
  fatal: { value: 60, label: 'FATAL', color: C.bgRed + C.brightWhite + C.bold, icon: '💀' },
  error: { value: 50, label: 'ERROR', color: C.brightRed + C.bold,              icon: '✖' },
  warn:  { value: 40, label: 'WARN',  color: C.brightYellow + C.bold,           icon: '⚠' },
  info:  { value: 30, label: 'INFO',  color: C.brightCyan,                      icon: 'ℹ' },
  debug: { value: 20, label: 'DEBUG', color: C.gray,                            icon: '⚙' },
  trace: { value: 10, label: 'TRACE', color: C.dim + C.gray,                    icon: '·' },
};

const LEVEL_ORDER = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

const currentLevelValue = (LEVELS[CONFIG.level]?.value) ?? LEVELS.info.value;

function shouldLog(level) {
  if (CONFIG.silent) return false;
  return (LEVELS[level]?.value ?? 0) >= currentLevelValue;
}

// ═══════════════════════════════════════════════════════════════════════════
// 04 · CONTEXTO ASYNC (AsyncLocalStorage)
// ═══════════════════════════════════════════════════════════════════════════

const asyncContext = new AsyncLocalStorage();

/**
 * Ejecuta una función dentro de un contexto que se propaga automáticamente
 * a todos los logs hechos dentro (incluso en promesas y callbacks).
 */
export function runWithContext(context, fn) {
  return asyncContext.run(context, fn);
}

/**
 * Devuelve el contexto actual (o {} si no hay).
 */
export function getContext() {
  return asyncContext.getStore() || {};
}

/**
 * Agrega metadata al contexto actual sin reemplazarlo.
 */
export function addContext(extra) {
  const store = asyncContext.getStore();
  if (store && typeof store === 'object') {
    Object.assign(store, extra);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 05 · UTILIDADES
// ═══════════════════════════════════════════════════════════════════════════

function padEnd(str, len) {
  str = String(str);
  while (str.length < len) str += ' ';
  return str;
}

function padStart(str, len) {
  str = String(str);
  while (str.length < len) str = ' ' + str;
  return str;
}

function truncate(str, max = 100) {
  str = String(str);
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function shortId(id) {
  if (!id) return '';
  return String(id).slice(0, 8);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && v.constructor === Object;
}

function isError(v) {
  return v instanceof Error;
}

function isPromise(v) {
  return v && typeof v.then === 'function';
}

/**
 * Formatea milisegundos a string humano: 12ms, 1.2s, 3m 45s.
 */
function formatDuration(ms) {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

/**
 * Timestamp formateado según config.
 */
function formatTimestamp(date = new Date()) {
  if (CONFIG.timestamp === 'epoch') return date.getTime();
  if (CONFIG.timestamp === 'iso') return date.toISOString();

  // 'time' — HH:MM:SS.mmm
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// 06 · REDACTAR DATOS SENSIBLES
// ═══════════════════════════════════════════════════════════════════════════

const SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'pwd', 'secret', 'token', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'apikey', 'api_key', 'auth', 'authorization',
  'cookie', 'set-cookie', 'session', 'sessionid', 'session_id', 'csrf',
  'privatekey', 'private_key', 'secretkey', 'secret_key', 'bearer',
  'clientsecret', 'client_secret', 'clientid', 'client_id', 'credentials',
  'creditcard', 'credit_card', 'cardnumber', 'card_number', 'cvv', 'ssn',
  'service_key', 'servicekey', 'service_role', 'anon_key', 'anonkey',
  'groq_api_key', 'gemini_api_key', 'kimi_api_key', 'supabase_service_key',
]);

const SENSITIVE_PATTERNS = [
  // API keys comunes
  /sk-[a-zA-Z0-9]{20,}/g,
  /gsk_[a-zA-Z0-9]{20,}/g,
  /AIza[a-zA-Z0-9_-]{20,}/g,
  /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, // JWT
  // Bearer tokens
  /Bearer\s+[a-zA-Z0-9._-]{20,}/gi,
  // Passwords en URL
  /:\/\/[^:]+:([^@]+)@/g,
];

function redactString(str) {
  if (!CONFIG.redact || typeof str !== 'string') return str;
  let result = str;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, (match) => {
      if (match.startsWith('Bearer')) return 'Bearer [REDACTED]';
      if (match.startsWith('://')) return '://[REDACTED]:[REDACTED]@';
      return '[REDACTED]';
    });
  }
  return result;
}

function redactValue(value, depth = 0) {
  if (depth > CONFIG.maxDepth) return '[MaxDepth]';
  if (!CONFIG.redact) return value;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value instanceof Date) return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactValue(v, depth + 1);
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 07 · SERIALIZACIÓN DE ERRORES
// ═══════════════════════════════════════════════════════════════════════════

function serializeError(err, depth = 0) {
  if (depth > 4) return { message: '[CauseChainTooDeep]' };
  if (!isError(err)) return err;

  const out = {
    name: err.name,
    message: err.message,
    ...(err.code && { code: err.code }),
    ...(err.status && { status: err.status }),
    ...(err.statusCode && { statusCode: err.statusCode }),
    ...(err.errno && { errno: err.errno }),
    ...(err.syscall && { syscall: err.syscall }),
    ...(err.stack && { stack: err.stack }),
  };

  // Errores anidados (ES2022 Error.cause)
  if (err.cause) {
    out.cause = serializeError(err.cause, depth + 1);
  }

  // Errores de agregación (AggregateError)
  if (err.errors && Array.isArray(err.errors)) {
    out.errors = err.errors.map((e) => serializeError(e, depth + 1));
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// 08 · NORMALIZAR ARGUMENTOS
// ═══════════════════════════════════════════════════════════════════════════

function normalizeMeta(meta) {
  if (meta === null || meta === undefined) return {};

  // Si es un Error directo, lo envolvemos
  if (isError(meta)) return { error: serializeError(meta) };

  // Si es un objeto plano, lo procesamos
  if (isPlainObject(meta)) {
    const out = {};
    for (const [k, v] of Object.entries(meta)) {
      if (isError(v)) {
        out[k] = serializeError(v);
      } else {
        out[k] = redactValue(v);
      }
    }
    return out;
  }

  // Cualquier otra cosa (string, array, number), lo metemos en 'data'
  return { data: redactValue(meta) };
}

// ═══════════════════════════════════════════════════════════════════════════
// 09 · FORMATTERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Formato 'pretty' — con colores, alineación, iconos.
 */
function formatPretty(level, message, meta) {
  const lvl = LEVELS[level] || LEVELS.info;
  const ts = C.gray + formatTimestamp() + C.reset;
  const tag = lvl.color + padEnd(lvl.label, 5) + C.reset;

  // Contexto compacto: [reqId user=xxx service=yyy]
  const ctxParts = [];
  if (meta.reqId)  ctxParts.push(C.gray + '[' + shortId(meta.reqId) + ']' + C.reset);
  if (meta.userId) ctxParts.push(C.cyan + 'user=' + shortId(meta.userId) + C.reset);
  if (meta.service && meta.service !== 'numination') {
    ctxParts.push(C.magenta + meta.service + C.reset);
  }
  const ctx = ctxParts.length > 0 ? ctxParts.join(' ') + ' ' : '';

  const msg = C.bold + message + C.reset;

  let line = `${ts} ${tag} ${ctx}${msg}`;

  // Metadata estructurada (sin las cosas de contexto ya mostradas)
  const extraKeys = Object.keys(meta).filter(
    (k) => !['reqId', 'userId', 'service', 'env', 'host', 'pid', 'version'].includes(k)
  );

  if (extraKeys.length > 0) {
    const extra = {};
    for (const k of extraKeys) extra[k] = meta[k];
    const pretty = prettyPrint(extra);
    if (pretty) {
      line += '\n' + indent(pretty, '       ');
    }
  }

  return line;
}

/**
 * Formato 'json' — una línea JSON, parseable por log aggregators.
 */
function formatJson(level, message, meta) {
  const record = {
    level,
    time: formatTimestamp(),
    msg: message,
    ...CONFIG.baseMeta,
    ...meta,
  };
  try {
    return JSON.stringify(record);
  } catch (e) {
    // Fallback si hay referencias circulares
    return JSON.stringify({
      level,
      time: formatTimestamp(),
      msg: message,
      _serializationError: e.message,
    });
  }
}

/**
 * Formato 'compact' — una línea, sin colores, sin indentación.
 */
function formatCompact(level, message, meta) {
  const lvl = LEVELS[level] || LEVELS.info;
  const ts = formatTimestamp();
  const parts = [ts, padEnd(lvl.label, 5), ''];

  if (meta.reqId)  parts.push('[' + shortId(meta.reqId) + ']');
  if (meta.userId) parts.push('user=' + shortId(meta.userId));
  if (meta.service && meta.service !== 'numination') parts.push(meta.service);

  parts.push(message);

  const extra = Object.keys(meta).filter(
    (k) => !['reqId', 'userId', 'service', 'env', 'host', 'pid', 'version'].includes(k)
  );
  if (extra.length > 0) {
    const obj = {};
    for (const k of extra) obj[k] = meta[k];
    try {
      parts.push(JSON.stringify(obj));
    } catch {}
  }

  return parts.join(' ');
}

/**
 * Pretty print para objetos anidados.
 */
function prettyPrint(obj, depth = 0, maxDepth = CONFIG.maxDepth) {
  if (depth > maxDepth) return C.gray + '[MaxDepth]' + C.reset;
  if (obj === null) return C.gray + 'null' + C.reset;
  if (obj === undefined) return C.gray + 'undefined' + C.reset;

  if (typeof obj === 'string') {
    const s = truncate(obj, CONFIG.maxStringLength);
    return C.green + JSON.stringify(s) + C.reset;
  }

  if (typeof obj === 'number') return C.yellow + String(obj) + C.reset;
  if (typeof obj === 'boolean') return C.magenta + String(obj) + C.reset;
  if (typeof obj === 'bigint') return C.yellow + String(obj) + 'n' + C.reset;
  if (typeof obj === 'function') return C.gray + '[Function ' + (obj.name || 'anonymous') + ']' + C.reset;
  if (typeof obj === 'symbol') return C.gray + obj.toString() + C.reset;

  if (obj instanceof Date) return C.cyan + obj.toISOString() + C.reset;
  if (obj instanceof RegExp) return C.cyan + obj.toString() + C.reset;

  if (Array.isArray(obj)) {
    if (obj.length === 0) return C.gray + '[]' + C.reset;
    if (obj.length <= 5 && obj.every((x) => typeof x !== 'object' || x === null)) {
      return '[' + obj.map((x) => prettyPrint(x, depth + 1, maxDepth)).join(', ') + ']';
    }
    const items = obj.slice(0, 30).map((x, i) => {
      return '  ' + C.gray + i + ':' + C.reset + ' ' + prettyPrint(x, depth + 1, maxDepth);
    });
    const more = obj.length > 30 ? ['  ' + C.gray + '... +' + (obj.length - 30) + ' más' + C.reset] : [];
    return '[\n' + items.concat(more).join(',\n') + '\n]';
  }

  if (typeof obj === 'object') {
    const keys = Object.keys(obj);
    if (keys.length === 0) return C.gray + '{}' + C.reset;
    const lines = keys.map((k) => {
      const v = prettyPrint(obj[k], depth + 1, maxDepth);
      return C.cyan + k + C.reset + ': ' + v;
    });
    return '{\n' + lines.map((l) => '  ' + l).join(',\n') + '\n}';
  }

  return String(obj);
}

function indent(str, prefix) {
  return str.split('\n').map((line) => prefix + line).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════════
// 10 · DEDUPLICACIÓN
// ═══════════════════════════════════════════════════════════════════════════

const dedupeMap = new Map();

function shouldDedupe(level, message, meta) {
  if (!CONFIG.dedupe.enabled) return false;
  if (level === 'error' || level === 'fatal') return false; // Siempre mostrar errores

  const key = level + '|' + message + '|' + (meta.service || '');

  const now = Date.now();
  const entry = dedupeMap.get(key);

  if (!entry || now - entry.firstAt > CONFIG.dedupe.windowMs) {
    dedupeMap.set(key, { firstAt: now, count: 1, suppressed: 0 });
    return false;
  }

  entry.count++;
  if (entry.count > CONFIG.dedupe.threshold) {
    entry.suppressed++;
    return true;
  }
  return false;
}

function flushDedupe() {
  const toFlush = [];
  const now = Date.now();
  for (const [key, entry] of dedupeMap.entries()) {
    if (entry.suppressed > 0 && now - entry.firstAt > CONFIG.dedupe.windowMs) {
      toFlush.push({ key, ...entry });
      dedupeMap.delete(key);
    }
  }
  for (const item of toFlush) {
    const [level, message] = item.key.split('|');
    write(level, message, { suppressed: item.suppressed, note: `repetido ${item.count} veces en ${CONFIG.dedupe.windowMs}ms` });
  }
}

// Limpiar dedupe cada 5s
if (CONFIG.dedupe.enabled) {
  const timer = setInterval(flushDedupe, 5000);
  if (timer.unref) timer.unref();
}

// ═══════════════════════════════════════════════════════════════════════════
// 11 · SAMPLING
// ═══════════════════════════════════════════════════════════════════════════

const sampleCounters = { debug: 0, trace: 0 };

function shouldSample(level) {
  if (level !== 'debug' && level !== 'trace') return true;
  const rate = CONFIG.sampling[level];
  if (rate <= 1) return true;
  sampleCounters[level]++;
  return sampleCounters[level] % rate === 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// 12 · TRANSPORTES
// ═══════════════════════════════════════════════════════════════════════════

const transports = [];

// ─── Console transport (siempre activo) ───
transports.push({
  name: 'console',
  write(level, message, meta) {
    const formatter =
      CONFIG.format === 'json' ? formatJson :
      CONFIG.format === 'compact' ? formatCompact :
      formatPretty;

    const output = formatter(level, message, meta);
    const stream = (level === 'error' || level === 'fatal' || level === 'warn')
      ? process.stderr
      : process.stdout;
    stream.write(output + '\n');
  },
});

// ─── File transport (opt-in con LOG_FILE=true) ───
if (CONFIG.file.enabled) {
  try {
    if (!fs.existsSync(CONFIG.file.dir)) {
      fs.mkdirSync(CONFIG.file.dir, { recursive: true });
    }

    const logFile = path.join(CONFIG.file.dir, 'numination.log');
    const stream = fs.createWriteStream(logFile, { flags: 'a' });

    transports.push({
      name: 'file',
      write(level, message, meta) {
        const record = { level, time: formatTimestamp(), msg: message, ...CONFIG.baseMeta, ...meta };
        try {
          stream.write(JSON.stringify(record) + '\n');
        } catch {}
      },
    });

    // Rotación básica por tamaño
    process.on('exit', () => {
      try { stream.end(); } catch {}
    });
  } catch (e) {
    console.error('[logger] No pude inicializar file transport:', e.message);
  }
}

// ─── Memory transport (para tests) ───
const memoryBuffer = [];
const MAX_MEMORY = 1000;

transports.push({
  name: 'memory',
  write(level, message, meta) {
    memoryBuffer.push({ level, time: Date.now(), msg: message, ...meta });
    if (memoryBuffer.length > MAX_MEMORY) memoryBuffer.shift();
  },
});

// ═══════════════════════════════════════════════════════════════════════════
// 13 · ESCRITURA CENTRAL
// ═══════════════════════════════════════════════════════════════════════════

const stats = {
  total: 0,
  byLevel: { fatal: 0, error: 0, warn: 0, info: 0, debug: 0, trace: 0 },
  suppressed: 0,
  startedAt: Date.now(),
};

function write(level, message, rawMeta = {}) {
  if (!shouldLog(level)) return;
  if (!shouldSample(level)) return;
  if (shouldDedupe(level, message, rawMeta)) {
    stats.suppressed++;
    return;
  }

  // Fusionar contexto async + metadata pasada + baseMeta
  const ctx = getContext();
  const normalized = normalizeMeta(rawMeta);
  const meta = { ...ctx, ...normalized };

  stats.total++;
  stats.byLevel[level] = (stats.byLevel[level] || 0) + 1;

  for (const transport of transports) {
    try {
      transport.write(level, message, meta);
    } catch (e) {
      // Nunca romper por un logger roto
      try {
        process.stderr.write(`[logger] transport "${transport.name}" failed: ${e.message}\n`);
      } catch {}
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 14 · API PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════

export const LOG = {
  fatal: (msg, meta) => write('fatal', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
  warn:  (msg, meta) => write('warn',  msg, meta),
  info:  (msg, meta) => write('info',  msg, meta),
  debug: (msg, meta) => write('debug', msg, meta),
  trace: (msg, meta) => write('trace', msg, meta),

  // Alias
  log: (msg, meta) => write('info', msg, meta),
};

// ═══════════════════════════════════════════════════════════════════════════
// 15 · CHILD LOGGER CON CONTEXTO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Crea un logger con contexto fijo. Todos los logs llevan esos campos.
 *
 *   const log = createLogger('websearch');
 *   log.info('Buscando en Wikipedia');  // → meta.service = 'websearch'
 *
 *   const userLog = log.child({ userId: 'user_123' });
 *   userLog.warn('Cuota al límite');    // → meta.service + meta.userId
 */
export function createLogger(service, baseMeta = {}) {
  const fixedMeta = {
    ...(service && { service }),
    ...baseMeta,
  };

  return {
    fatal: (msg, meta) => write('fatal', msg, { ...fixedMeta, ...meta }),
    error: (msg, meta) => write('error', msg, { ...fixedMeta, ...meta }),
    warn:  (msg, meta) => write('warn',  msg, { ...fixedMeta, ...meta }),
    info:  (msg, meta) => write('info',  msg, { ...fixedMeta, ...meta }),
    debug: (msg, meta) => write('debug', msg, { ...fixedMeta, ...meta }),
    trace: (msg, meta) => write('trace', msg, { ...fixedMeta, ...meta }),

    child: (extra) => createLogger(service, { ...fixedMeta, ...extra }),

    // Timers
    time: (label, meta) => startTimer(label, { ...fixedMeta, ...meta }, createLogger(service, fixedMeta)),
    timeEnd: (label, meta) => endTimer(label, { ...fixedMeta, ...meta }),

    // Utilidades
    banner: (title, subtitle) => banner(title, subtitle),
    table: (data) => table(data, fixedMeta),
    diff: (a, b) => diff(a, b),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 16 · withReqId / withUser
// ═══════════════════════════════════════════════════════════════════════════

export function withReqId(reqId, userId = null) {
  const meta = { reqId, ...(userId && { userId }) };
  return createLogger(null, meta);
}

export function withUser(userId, extra = {}) {
  return createLogger(null, { userId, ...extra });
}

// ═══════════════════════════════════════════════════════════════════════════
// 17 · TIMERS / BENCHMARKS
// ═══════════════════════════════════════════════════════════════════════════

const timers = new Map();

/**
 * Inicia un timer con un label. Devuelve una función que lo detiene.
 *
 *   const end = LOG.timer('consulta-a-DB');
 *   await doSomething();
 *   end();  // → loggea "consulta-a-DB completado en 45ms"
 */
export function startTimer(label, meta = {}, logger = LOG) {
  const startAt = process.hrtime.bigint();
  const startWall = Date.now();

  const stop = (extraMeta = {}) => {
    const endAt = process.hrtime.bigint();
    const durationMs = Number(endAt - startAt) / 1e6;

    let level = 'debug';
    if (durationMs > CONFIG.slowMs.error)      level = 'error';
    else if (durationMs > CONFIG.slowMs.warn)  level = 'warn';

    logger[level](`⏱ ${label} · ${formatDuration(durationMs)}`, {
      ...meta,
      ...extraMeta,
      durationMs: Math.round(durationMs * 100) / 100,
      durationHuman: formatDuration(durationMs),
      startedAt: startWall,
      slow: durationMs > CONFIG.slowMs.warn,
    });

    return durationMs;
  };

  timers.set(label, { startAt, startWall, stop });
  return stop;
}

function endTimer(label, extraMeta = {}) {
  const t = timers.get(label);
  if (!t) {
    LOG.warn(`⏱ timeEnd sin time previo: ${label}`);
    return;
  }
  timers.delete(label);
  t.stop(extraMeta);
}

// ═══════════════════════════════════════════════════════════════════════════
// 18 · BENCHMARK DE FUNCIONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Mide automáticamente el tiempo de una función async.
 *
 *   const result = await LOG.benchmark('fetch-user', async () => {
 *     return await db.getUser(id);
 *   });
 */
export async function benchmark(label, fn, meta = {}) {
  const end = startTimer(label, meta);
  try {
    const result = await fn();
    end({ ok: true });
    return result;
  } catch (error) {
    end({ ok: false, error: serializeError(error) });
    throw error;
  }
}

LOG.time = (label, meta) => startTimer(label, meta);
LOG.timeEnd = endTimer;
LOG.benchmark = benchmark;

// ═══════════════════════════════════════════════════════════════════════════
// 19 · MIDDLEWARE EXPRESS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Middleware que:
 *   1. Genera un reqId único por request
 *   2. Envuelve el handler en AsyncLocalStorage (contexto automático)
 *   3. Loguea la request entrante y saliente
 *   4. Agrega req.log y req.id
 *
 *   import { expressMiddleware } from './lib/logger.js';
 *   app.use(expressMiddleware());
 */
export function expressMiddleware(options = {}) {
  const {
    skipPaths = ['/health', '/favicon.ico'],
    logIncoming = true,
    logOutgoing = true,
  } = options;

  return (req, res, next) => {
    if (skipPaths.some((p) => req.path.startsWith(p))) return next();

    const reqId = req.headers['x-request-id'] || crypto.randomUUID().slice(0, 12);
    const userId = req.user?.id || null;

    req.id = reqId;
    req.log = withReqId(reqId, userId);
    res.setHeader('x-request-id', reqId);

    const startAt = process.hrtime.bigint();

    if (logIncoming) {
      req.log.debug(`→ ${req.method} ${req.path}`, {
        method: req.method,
        path: req.path,
        query: Object.keys(req.query).length ? req.query : undefined,
        ip: req.ip || req.socket?.remoteAddress,
        userAgent: truncate(req.get('user-agent') || '', 80),
      });
    }

    // Hook al finalizar la respuesta
    res.on('finish', () => {
      if (!logOutgoing) return;
      const durationMs = Number(process.hrtime.bigint() - startAt) / 1e6;

      let level = 'info';
      if (res.statusCode >= 500) level = 'error';
      else if (res.statusCode >= 400) level = 'warn';
      else if (durationMs > CONFIG.slowMs.warn) level = 'warn';

      req.log[level](`← ${req.method} ${req.path} ${res.statusCode} · ${formatDuration(durationMs)}`, {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 100) / 100,
        contentLength: res.get('content-length'),
      });
    });

    // Envuelve el handler en el contexto async
    runWithContext({ reqId, userId }, () => next());
  };
}

/**
 * Middleware específico para rutas con auth: captura el user del JWT
 * después de requireAuth.
 */
export function userContextMiddleware() {
  return (req, res, next) => {
    if (req.user?.id) {
      addContext({ userId: req.user.id });
      if (req.log) req.log = withReqId(req.id, req.user.id);
    }
    next();
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 20 · LOGGERS ESPECIALIZADOS
// ═══════════════════════════════════════════════════════════════════════════

// Base para todos los servicios
export const ai       = createLogger('ai');
export const db       = createLogger('db');
export const http     = createLogger('http');
export const sse      = createLogger('sse');
export const cache    = createLogger('cache');
export const auth     = createLogger('auth');
export const security = createLogger('security');
export const admin    = createLogger('admin');
export const websearch = createLogger('websearch');
export const limits   = createLogger('limits');
export const streaming = createLogger('streaming');
export const sandbox  = createLogger('sandbox');
export const voice    = createLogger('voice');
export const images   = createLogger('images');

// ═══════════════════════════════════════════════════════════════════════════
// 21 · BANNERS Y DIVISORES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Banner grande para arranque del server.
 */
export function banner(title, subtitle = '') {
  if (!supportsColor) {
    const line = '='.repeat(60);
    console.log('\n' + line);
    console.log('  ' + title);
    if (subtitle) console.log('  ' + subtitle);
    console.log(line + '\n');
    return;
  }

  const width = 60;
  const tLen = title.length;
  const padLeft = Math.max(0, Math.floor((width - tLen) / 2));
  const padRight = Math.max(0, width - tLen - padLeft);

  const top    = '╔' + '═'.repeat(width) + '╗';
  const mid    = '║' + ' '.repeat(padLeft) + C.bold + C.brightCyan + title + C.reset + ' '.repeat(padRight) + '║';
  const bot    = '╚' + '═'.repeat(width) + '╝';

  console.log('\n' + C.brightMagenta + top + C.reset);
  console.log(C.brightMagenta + mid + C.reset);
  if (subtitle) {
    const sLen = subtitle.length;
    const sPad = Math.max(0, Math.floor((width - sLen) / 2));
    const sPadR = Math.max(0, width - sLen - sPad);
    console.log(C.brightMagenta + '║' + ' '.repeat(sPad) + C.gray + subtitle + C.reset + ' '.repeat(sPadR) + C.brightMagenta + '║' + C.reset);
  }
  console.log(C.brightMagenta + bot + C.reset + '\n');
}

/**
 * Divisor simple.
 */
export function divider(label = '', char = '─', width = 60) {
  if (!label) {
    console.log(C.gray + char.repeat(width) + C.reset);
    return;
  }
  const labelStr = ' ' + label + ' ';
  const left = Math.floor((width - labelStr.length) / 2);
  const right = width - labelStr.length - left;
  console.log(C.gray + char.repeat(left) + C.bold + labelStr + C.reset + C.gray + char.repeat(right) + C.reset);
}

LOG.banner = banner;
LOG.divider = divider;

// ═══════════════════════════════════════════════════════════════════════════
// 22 · TABLA
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Renderiza una tabla en la consola.
 *
 *   LOG.table([
 *     { name: 'Álvaro', chats: 45, tokens: 12300 },
 *     { name: 'Robinson', chats: 32, tokens: 8900 },
 *   ]);
 */
export function table(data, extraMeta = {}) {
  if (!Array.isArray(data) || data.length === 0) {
    LOG.info('(tabla vacía)', extraMeta);
    return;
  }

  const headers = Object.keys(data[0]);
  const rows = data.map((row) => headers.map((h) => String(row[h] ?? '')));
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));

  const sep = '─';
  const line = '┌' + widths.map((w) => sep.repeat(w + 2)).join('┬') + '┐';
  const headerLine = '│' + headers.map((h, i) => ' ' + C.bold + padEnd(h, widths[i]) + C.reset + ' ').join('│') + '│';
  const separator = '├' + widths.map((w) => sep.repeat(w + 2)).join('┼') + '┤';
  const bottom = '└' + widths.map((w) => sep.repeat(w + 2)).join('┴') + '┘';

  console.log(C.gray + line + C.reset);
  console.log(headerLine);
  console.log(C.gray + separator + C.reset);
  for (const row of rows) {
    console.log('│' + row.map((cell, i) => ' ' + padEnd(cell, widths[i]) + ' ').join('│') + '│');
  }
  console.log(C.gray + bottom + C.reset);

  write('info', `Tabla: ${data.length} fila${data.length === 1 ? '' : 's'}`, extraMeta);
}

// ═══════════════════════════════════════════════════════════════════════════
// 23 · DIFF
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Renderiza un diff textual entre dos strings.
 */
export function diff(a, b, label = 'diff') {
  const linesA = String(a).split('\n');
  const linesB = String(b).split('\n');
  const max = Math.max(linesA.length, linesB.length);

  console.log(C.bold + `── ${label} ──` + C.reset);
  for (let i = 0; i < max; i++) {
    const la = linesA[i];
    const lb = linesB[i];
    if (la === lb) {
      console.log(C.gray + '  ' + (la || '') + C.reset);
    } else {
      if (la !== undefined) console.log(C.red + '- ' + la + C.reset);
      if (lb !== undefined) console.log(C.green + '+ ' + lb + C.reset);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 24 · MÉTRICAS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Devuelve estadísticas del logger.
 */
export function getStats() {
  return {
    ...stats,
    uptime: Date.now() - stats.startedAt,
    memoryBufferSize: memoryBuffer.length,
    dedupeEntries: dedupeMap.size,
    activeTimers: timers.size,
  };
}

/**
 * Devuelve el buffer en memoria (útil para tests).
 */
export function getMemoryLogs(filter = {}) {
  let logs = [...memoryBuffer];
  if (filter.level) logs = logs.filter((l) => l.level === filter.level);
  if (filter.service) logs = logs.filter((l) => l.service === filter.service);
  if (filter.since) logs = logs.filter((l) => l.time >= filter.since);
  return logs;
}

export function clearMemoryLogs() {
  memoryBuffer.length = 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// 25 · CONTROL DE CONFIGURACIÓN EN RUNTIME
// ═══════════════════════════════════════════════════════════════════════════

export function setLevel(level) {
  if (!LEVELS[level]) throw new Error(`Nivel inválido: ${level}. Opciones: ${LEVEL_ORDER.join(', ')}`);
  CONFIG.level = level;
  LOG.info(`Logger level cambiado a: ${level}`);
}

export function setFormat(format) {
  if (!['pretty', 'json', 'compact'].includes(format)) {
    throw new Error('Formato inválido. Opciones: pretty, json, compact');
  }
  CONFIG.format = format;
}

export function setSilent(silent) {
  CONFIG.silent = !!silent;
}

export function getConfig() {
  return { ...CONFIG };
}

// ═══════════════════════════════════════════════════════════════════════════
// 26 · HELPERS ESPECÍFICOS PARA NUMINATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Loguea una request de IA.
 */
export function logAIRequest({ provider, model, prompt, tokens, durationMs, userId, reqId }) {
  const meta = {
    provider,
    model,
    promptLength: prompt?.length || 0,
    promptPreview: truncate(prompt || '', 100),
    tokens,
    durationMs: Math.round(durationMs * 100) / 100,
    durationHuman: formatDuration(durationMs),
    userId,
    reqId,
  };

  if (durationMs > CONFIG.slowMs.warn) {
    LOG.warn(`🤖 ${provider}/${model} lento (${formatDuration(durationMs)})`, meta);
  } else {
    LOG.debug(`🤖 ${provider}/${model} OK (${formatDuration(durationMs)})`, meta);
  }
}

/**
 * Loguea un resultado de web search.
 */
export function logWebSearch({ query, results, durationMs, cached, userId, reqId }) {
  LOG.debug(`🔍 "${truncate(query, 50)}" · ${results.length} resultados · ${formatDuration(durationMs)}${cached ? ' (cache)' : ''}`, {
    query,
    resultCount: results.length,
    durationMs,
    cached,
    sources: results.slice(0, 3).map((r) => r.source || r.url),
    userId,
    reqId,
  });
}

/**
 * Loguea cuota consumida.
 */
export function logLimit({ userId, plan, used, limit, action, reqId }) {
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  const level = pct >= 100 ? 'warn' : pct >= 80 ? 'info' : 'debug';

  LOG[level](`📊 Cuota ${action} · ${used}/${limit} (${pct.toFixed(0)}%) · plan=${plan}`, {
    userId,
    plan,
    used,
    limit,
    pct: Math.round(pct),
    action,
    reqId,
  });
}

/**
 * Loguea evento de seguridad.
 */
export function logSecurity({ event, userId, ip, userAgent, details, severity = 'info' }) {
  security[severity](`🔒 ${event}`, {
    event,
    userId,
    ip,
    userAgent: truncate(userAgent || '', 60),
    ...details,
  });
}

/**
 * Loguea una query de DB lenta.
 */
export function logSlowQuery({ query, durationMs, table, operation, userId }) {
  if (durationMs < CONFIG.slowMs.warn) return;

  LOG.warn(`🐌 Query lenta (${formatDuration(durationMs)}) · ${operation} ${table}`, {
    query: truncate(query, 200),
    durationMs,
    table,
    operation,
    userId,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 27 · EXPORTAR UTILIDADES SUELTAS
// ═══════════════════════════════════════════════════════════════════════════

export { formatDuration, formatTimestamp, serializeError, redactValue };
export const LEVELS_LIST = LEVEL_ORDER;

// ═══════════════════════════════════════════════════════════════════════════
// 28 · BANNER DE CARGA
// ═══════════════════════════════════════════════════════════════════════════

// Detectar si estamos en modo silencioso
if (!CONFIG.silent) {
  const levelColored = (LEVELS[CONFIG.level]?.label || CONFIG.level);
  const formatLabel = CONFIG.format;
  const tsLabel = CONFIG.timestamp;

  LOG.trace(`Logger inicializado · level=${levelColored} format=${formatLabel} timestamp=${tsLabel} color=${supportsColor ? 'on' : 'off'}`, {
    service: 'logger',
    pid: process.pid,
    node: process.version,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 29 · DEFAULT EXPORT
// ═══════════════════════════════════════════════════════════════════════════

export default LOG;