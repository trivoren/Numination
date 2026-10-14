/* ================================================================
   NUMINATION · errors.js · v1.0
   ----------------------------------------------------------------
   Manejo centralizado de errores para toda la plataforma.

   ¿POR QUÉ EXISTE ESTE ARCHIVO?
   Antes cada router (auth, chats, memories, connectors, email)
   tiraba errores con su propio formato. El frontend tenía que
   adivinar si "error" venía con "code", con "razon", o solo texto.
   Cuando algo fallaba en producción, cada endpoint logueaba
   distinto y era difícil filtrar.

   Con este archivo:
     · Todos los errores salen con el MISMO formato JSON.
     · Todos los errores se loguean con el MISMO formato.
     · Los códigos HTTP se asignan automáticamente por tipo.
     · Los errores de Postgres se traducen a mensajes humanos.
     · Los errores de motores IA se clasifican igual que en
       streaming.js (rate_limit, auth, timeout, etc.).
     · Se preservan los datos sensibles fuera de la respuesta.
     · En producción NO se filtra el stack trace al cliente.

   ESTRUCTURA:
     1 · Códigos de error (registry centralizado)
     2 · Clases de error tipadas
     3 · Mapeo de Postgres → AppError
     4 · Mapeo de motores IA → AppError
     5 · Sanitización (remover datos sensibles del response)
     6 · Logger integrado
     7 · Métricas (contadores por tipo)
     8 · Middleware Express
     9 · Async handler (wrapper para try/catch automático)
    10 · Handlers globales de proceso
    11 · Exports

   USO EN UN ROUTER:

     import { ValidationError, NotFoundError, asyncHandler } from './middleware/errors.js';

     app.post('/api/chats', asyncHandler(async (req, res) => {
       if (!req.body.title) throw new ValidationError('Falta title', 'title');
       const chat = await db.createChat(req.body.title);
       if (!chat) throw new NotFoundError('Chat no creado');
       res.json({ ok: true, chat });
     }));

     Y listo. No hace falta try/catch. El middleware atrapa
     el error, lo loguea, y devuelve el JSON correcto.

   USO EN EL SERVER (index.js):

     import { requestIdMiddleware, notFoundMiddleware, errorMiddleware, installProcessHandlers } from './middleware/errors.js';

     app.use(requestIdMiddleware());
     // ... todas las rutas ...
     app.use(notFoundMiddleware(publicDir));
     app.use(errorMiddleware());
     installProcessHandlers();

   ================================================================ */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CÓDIGOS DE ERROR · un solo lugar para consultarlos
   ═══════════════════════════════════════════════════════════════════════
   Formato: SCREAMING_SNAKE_CASE.
   Prefijos por dominio para poder filtrar en logs:
     AUTH_*      · autenticación
     CHAT_*      · chats y mensajes
     MEM_*       · memorias
     AI_*        · motores de IA
     LIMIT_*     · cuotas y rate limits
     DB_*        · base de datos
     VALID_*     · validación de input
     INT_*       · internos del servidor
   ═══════════════════════════════════════════════════════════════════════ */

export const CODES = Object.freeze({
  /* ─── Auth ─── */
  AUTH_NO_SESSION:        'auth_no_session',
  AUTH_INVALID_SESSION:   'auth_invalid_session',
  AUTH_STALE_SESSION:     'auth_stale_session',
  AUTH_INVALID_CREDS:     'auth_invalid_creds',
  AUTH_USE_OAUTH:         'auth_use_oauth',
  AUTH_ACCOUNT_LOCKED:    'auth_account_locked',
  AUTH_EMAIL_TAKEN:       'auth_email_taken',
  AUTH_EMAIL_TAKEN_OAUTH: 'auth_email_taken_oauth',
  AUTH_GOOGLE_FAILED:     'auth_google_failed',
  AUTH_GITHUB_FAILED:     'auth_github_failed',
  AUTH_INVALID_TOKEN:     'auth_invalid_token',
  AUTH_EXPIRED_TOKEN:     'auth_expired_token',
  AUTH_WRONG_PASSWORD:    'auth_wrong_password',
  AUTH_NO_PASSWORD:       'auth_no_password',
  AUTH_EMAIL_UNVERIFIED:  'auth_email_unverified',
  AUTH_FORBIDDEN:         'auth_forbidden',

  /* ─── Chats ─── */
  CHAT_NOT_FOUND:         'chat_not_found',
  CHAT_EMPTY_MESSAGE:     'chat_empty_message',
  CHAT_TOO_LONG:          'chat_too_long',
  CHAT_INJECTION_BLOCKED: 'chat_injection_blocked',
  CHAT_CREATE_FAILED:     'chat_create_failed',
  CHAT_DELETE_FAILED:     'chat_delete_failed',

  /* ─── Memorias ─── */
  MEM_NOT_FOUND:          'mem_not_found',
  MEM_EMPTY:              'mem_empty',
  MEM_DUPLICATE:          'mem_duplicate',
  MEM_NEAR_DUPLICATE:     'mem_near_duplicate',
  MEM_CREATE_FAILED:      'mem_create_failed',
  MEM_LIMIT_EXCEEDED:     'mem_limit_exceeded',

  /* ─── Motores IA ─── */
  AI_ENGINE_FAILED:       'ai_engine_failed',
  AI_ALL_ENGINES_FAILED:  'ai_all_engines_failed',
  AI_RATE_LIMIT:          'ai_rate_limit',
  AI_TIMEOUT:             'ai_timeout',
  AI_AUTH:                'ai_auth',
  AI_MODEL_MISSING:       'ai_model_missing',
  AI_NETWORK:             'ai_network',
  AI_NO_TOKENS:           'ai_no_tokens',
  AI_CONFIG_MISSING:      'ai_config_missing',

  /* ─── Límites ─── */
  LIMIT_DAILY:            'limit_daily',
  LIMIT_MINUTE:           'limit_minute',
  LIMIT_BURST:            'limit_burst',
  LIMIT_IP:               'limit_ip',
  LIMIT_ANON:             'limit_anon',
  LIMIT_UPSTASH_DOWN:     'limit_upstash_down',

  /* ─── Base de datos ─── */
  DB_UNAVAILABLE:         'db_unavailable',
  DB_UNIQUE_VIOLATION:    'db_unique_violation',
  DB_FOREIGN_KEY:         'db_foreign_key',
  DB_NOT_NULL:            'db_not_null',
  DB_TIMEOUT:             'db_timeout',
  DB_QUERY_FAILED:        'db_query_failed',
  DB_NO_ROWS:             'db_no_rows',

  /* ─── Validación ─── */
  VALID_EMAIL:            'valid_email',
  VALID_PASSWORD_SHORT:   'valid_password_short',
  VALID_PASSWORD_LONG:    'valid_password_long',
  VALID_PASSWORD_LETTER:  'valid_password_letter',
  VALID_PASSWORD_DIGIT:   'valid_password_digit',
  VALID_PASSWORD_COMMON:  'valid_password_common',
  VALID_NAME_LENGTH:      'valid_name_length',
  VALID_JSON:             'valid_json',
  VALID_PAYLOAD_LARGE:    'valid_payload_large',
  VALID_MISSING_FIELD:    'valid_missing_field',
  VALID_INVALID_FIELD:    'valid_invalid_field',

  /* ─── Internos ─── */
  INT_SERVER_ERROR:       'int_server_error',
  INT_NOT_FOUND:          'int_not_found',
  INT_FILE_NOT_FOUND:     'int_file_not_found',
  INT_ENDPOINT_NOT_FOUND: 'int_endpoint_not_found',
  INT_MAINTENANCE:        'int_maintenance',
});

/* ═══════════════════════════════════════════════════════════════════════
   2 · CLASES DE ERROR TIPADAS
   ═══════════════════════════════════════════════════════════════════════
   Todas heredan de AppError. Cada una tiene un status HTTP por defecto
   y un `code` del registry. Los datos sensibles van en `internal`
   (nunca salen al cliente).

   Convención:
     · message   → lo que ve el usuario (en español, claro)
     · code      → identificador máquina
     · status    → HTTP status code
     · internal  → datos extra para logs, NO para el cliente
     · cause     → el error original (encadenamiento)
   ═══════════════════════════════════════════════════════════════════════ */

export class AppError extends Error {
  constructor(message, code, status = 500, internal = null, cause = null) {
    super(message || 'Error interno');
    this.name = 'AppError';
    this.code = code || CODES.INT_SERVER_ERROR;
    this.status = status;
    this.internal = internal || {};
    this.cause = cause;
    this.isOperational = true;
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }

  /** Serializa al formato JSON estándar */
  toJSON(includeInternal = false) {
    const out = {
      ok: false,
      error: this.message,
      code: this.code,
    };
    if (includeInternal && Object.keys(this.internal).length > 0) {
      out.details = this.internal;
    }
    return out;
  }
}

/* ─── 4xx · Errores del cliente ─── */

export class ValidationError extends AppError {
  constructor(message, field = null, code = CODES.VALID_MISSING_FIELD, internal = {}) {
    super(message, code, 400, { field, ...internal });
    this.name = 'ValidationError';
    this.field = field;
  }
}

export class AuthError extends AppError {
  constructor(message, code = CODES.AUTH_INVALID_CREDS, status = 401, internal = null) {
    super(message, code, status, internal);
    this.name = 'AuthError';
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Sin permisos suficientes', code = CODES.AUTH_FORBIDDEN, internal = null) {
    super(message, code, 403, internal);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'No encontrado', code = CODES.INT_NOT_FOUND, internal = null) {
    super(message, code, 404, internal);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends AppError {
  constructor(message, code = CODES.DB_UNIQUE_VIOLATION, internal = null) {
    super(message, code, 409, internal);
    this.name = 'ConflictError';
  }
}

export class RateLimitError extends AppError {
  constructor(message, code = CODES.LIMIT_MINUTE, retryAfter = null, internal = null) {
    super(message, code, 429, internal);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class UnprocessableError extends AppError {
  constructor(message, code = CODES.VALID_INVALID_FIELD, internal = null) {
    super(message, code, 422, internal);
    this.name = 'UnprocessableError';
  }
}

/* ─── 5xx · Errores del servidor ─── */

export class ExternalError extends AppError {
  constructor(message, code = CODES.AI_ENGINE_FAILED, status = 502, internal = null, cause = null) {
    super(message, code, status, internal, cause);
    this.name = 'ExternalError';
  }
}

export class TimeoutError extends AppError {
  constructor(message = 'El servicio tardó demasiado', code = CODES.AI_TIMEOUT, internal = null) {
    super(message, code, 504, internal);
    this.name = 'TimeoutError';
  }
}

export class DatabaseError extends AppError {
  constructor(message, code = CODES.DB_QUERY_FAILED, internal = null, cause = null) {
    super(message, code, 500, internal, cause);
    this.name = 'DatabaseError';
  }
}

export class EngineError extends AppError {
  constructor(message, code = CODES.AI_ENGINE_FAILED, engine = null, internal = null, cause = null) {
    super(message, code, 502, { engine, ...internal }, cause);
    this.name = 'EngineError';
    this.engine = engine;
  }
}

export class InternalError extends AppError {
  constructor(message = 'Error interno del servidor', code = CODES.INT_SERVER_ERROR, internal = null, cause = null) {
    super(message, code, 500, internal, cause);
    this.name = 'InternalError';
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   3 · MAPEO · errores de Postgres → AppError
   ═══════════════════════════════════════════════════════════════════════
   Postgres usa códigos SQLSTATE de 5 caracteres. Los más comunes:

     23505 · unique_violation
     23503 · foreign_key_violation
     23502 · not_null_violation
     22P02 · invalid_text_representation
     42P01 · undefined_table
     42703 · undefined_column
     57014 · query_canceled
     57P01 · admin_shutdown
     08*   · connection errors

   Más info: https://www.postgresql.org/docs/current/errcodes-appendix.html
   ═══════════════════════════════════════════════════════════════════════ */

const PG_MAP = Object.freeze({
  '23505': {
    code: CODES.DB_UNIQUE_VIOLATION,
    status: 409,
    msg: (detail) => {
      // "Key (email)=(x@y) already exists."
      const m = String(detail || '').match(/\(([^)]+)\)=\(([^)]+)\)/);
      if (m) return `El ${m[1]} "${m[2]}" ya está registrado.`;
      return 'Ese registro ya existe.';
    },
  },
  '23503': {
    code: CODES.DB_FOREIGN_KEY,
    status: 409,
    msg: () => 'Referencia inválida. El registro relacionado no existe.',
  },
  '23502': {
    code: CODES.DB_NOT_NULL,
    status: 400,
    msg: (detail) => {
      const m = String(detail || '').match(/column "([^"]+)"/);
      return m ? `Falta el campo "${m[1]}".` : 'Falta un campo obligatorio.';
    },
  },
  '22P02': {
    code: CODES.VALID_INVALID_FIELD,
    status: 400,
    msg: () => 'Formato de dato inválido.',
  },
  '42P01': {
    code: CODES.DB_QUERY_FAILED,
    status: 500,
    msg: () => 'Error de configuración de base de datos.',
  },
  '42703': {
    code: CODES.DB_QUERY_FAILED,
    status: 500,
    msg: () => 'Error de configuración de base de datos.',
  },
  '57014': {
    code: CODES.DB_TIMEOUT,
    status: 504,
    msg: () => 'La consulta tardó demasiado.',
  },
  '57P01': {
    code: CODES.DB_UNAVAILABLE,
    status: 503,
    msg: () => 'La base de datos está reiniciándose.',
  },
  '57P02': {
    code: CODES.DB_UNAVAILABLE,
    status: 503,
    msg: () => 'La base de datos se cayó.',
  },
});

export function fromPgError(err) {
  if (!err || !err.code) return null;

  // Empieza con '08' → problema de conexión
  if (String(err.code).startsWith('08')) {
    return new DatabaseError(
      'No se pudo conectar a la base de datos.',
      CODES.DB_UNAVAILABLE,
      { pgCode: err.code },
      err,
    );
  }

  const entry = PG_MAP[err.code];
  if (!entry) return null;

  return new DatabaseError(
    entry.msg(err.detail || err.message),
    entry.code,
    { pgCode: err.code, pgDetail: err.detail, pgTable: err.table, pgColumn: err.column },
    err,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · MAPEO · errores de motores IA → AppError
   ═══════════════════════════════════════════════════════════════════════ */

export function fromEngineError(err, engine = null) {
  if (!err) return null;

  const msg = String(err.message || '').toLowerCase();
  const status = err.status ?? err.code ?? err.response?.status ?? 0;

  // Cliente abortó: no es error del motor
  if (err.name === 'AbortError' || (msg.includes('aborted') && !msg.includes('timeout'))) {
    return new EngineError('Cancelado por el cliente', 'ai_client_abort', engine, {}, err);
  }

  // Timeout
  if (err.name === 'TimeoutError' || msg.includes('timeout') || msg.includes('etimedout') || status === 504) {
    return new TimeoutError(
      `${engine || 'El motor'} no respondió en el tiempo esperado.`,
      CODES.AI_TIMEOUT,
      { engine, status },
    );
  }

  // Rate limit
  if (status === 429 || msg.includes('429') || msg.includes('quota') || msg.includes('rate limit')) {
    return new EngineError(
      `${engine || 'El motor'} alcanzó su límite de uso.`,
      CODES.AI_RATE_LIMIT,
      engine,
      { status },
      err,
    );
  }

  // Overloaded
  if (status === 503 || msg.includes('overloaded') || msg.includes('503')) {
    return new EngineError(
      `${engine || 'El motor'} está saturado.`,
      CODES.AI_RATE_LIMIT,
      engine,
      { status },
      err,
    );
  }

  // Auth
  if (status === 401 || status === 403 || msg.includes('unauthorized') || msg.includes('invalid api key')) {
    return new EngineError(
      `${engine || 'El motor'} rechazó las credenciales.`,
      CODES.AI_AUTH,
      engine,
      { status },
      err,
    );
  }

  // Modelo no existe
  if (status === 404 || msg.includes('model not found') || msg.includes('not found')) {
    return new EngineError(
      `Modelo no encontrado en ${engine || 'el motor'}.`,
      CODES.AI_MODEL_MISSING,
      engine,
      { status },
      err,
    );
  }

  // Red
  if (msg.includes('fetch failed') || msg.includes('econnreset') || msg.includes('enotfound')) {
    return new EngineError(
      `Error de red al contactar ${engine || 'el motor'}.`,
      CODES.AI_NETWORK,
      engine,
      {},
      err,
    );
  }

  // Genérico
  return new EngineError(
    err.message || `Error en ${engine || 'el motor'}.`,
    CODES.AI_ENGINE_FAILED,
    engine,
    { status },
    err,
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · SANITIZACIÓN · qué NO debe llegar al cliente
   ═══════════════════════════════════════════════════════════════════════
   Los errores de Postgres, motores IA y Node vienen con información
   sensible (queries, paths, keys parciales). Este módulo filtra eso
   antes de mandar el response al cliente.
   ═══════════════════════════════════════════════════════════════════════ */

const SENSITIVE_PATTERNS = [
  // API keys (Groq, Gemini, NVIDIA, etc.)
  /\b(gsk_|AIza|nvapi-|sk-|xkeysib-|xsmtpsib-)[A-Za-z0-9_\-]{10,}/gi,
  // JWT tokens
  /\beyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}/g,
  // Passwords en URLs
  /(password|token|secret)=([^&\s]+)/gi,
  // Cookies en headers
  /(cookie|authorization|api[-_]?key)["':\s]+[^"',\s]+/gi,
  // Rutas absolutas del filesystem (filtra /Users/... y C:\Users\...)
  /(?:[A-Za-z]:\\Users\\[^\\]+|\/(?:home|Users)\/[^\/\s]+)/g,
];

export function sanitizeForClient(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const p of SENSITIVE_PATTERNS) {
    out = out.replace(p, '[REDACTED]');
  }
  return out;
}

/**
 * Recorta un stack trace para producción. Solo deja las primeras N líneas
 * y las rutas relevantes del proyecto.
 */
export function shortStack(stack) {
  if (!stack) return null;
  return String(stack)
    .split('\n')
    .slice(0, 6)
    .map((line) => sanitizeForClient(line))
    .join('\n');
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · LOGGER INTERNO · evita dependencia circular con index.js
   ═══════════════════════════════════════════════════════════════════════
   Puede ser reemplazado por el logger externo a través de
   `setLogger()`. Por defecto usa console con formato JSON.
   ═══════════════════════════════════════════════════════════════════════ */

let _logger = null;

export function setLogger(loggerObj) {
  _logger = loggerObj;
}

function defaultLogger(level, event, meta) {
  const entry = { ts: new Date().toISOString(), lvl: level, event, ...meta };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error('[err]', line);
  else if (level === 'warn') console.warn('[err]', line);
  else console.log('[err]', line);
}

function logEvent(level, event, meta) {
  try {
    if (_logger && typeof _logger[level] === 'function') {
      _logger[level](event, meta);
    } else {
      defaultLogger(level, event, meta);
    }
  } catch {
    // Nunca dejar que un error del logger rompa el request
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · MÉTRICAS · contadores en memoria
   ═══════════════════════════════════════════════════════════════════════
   Se resetean al reiniciar el proceso. Si querés persistencia, usá
   Redis. Sirven para /api/health o para detectar patrones.
   ═══════════════════════════════════════════════════════════════════════ */

const METRICS = {
  total: 0,
  byCode: new Map(),
  byStatus: new Map(),
  byPath: new Map(),
  byUser: new Map(),
  firstAt: null,
  lastAt: null,
};

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function trackError(err, req) {
  METRICS.total++;
  const now = Date.now();
  if (!METRICS.firstAt) METRICS.firstAt = now;
  METRICS.lastAt = now;

  bump(METRICS.byCode, err.code || 'unknown');
  bump(METRICS.byStatus, String(err.status || 500));
  if (req?.path) bump(METRICS.byPath, req.path);
  if (req?.user?.id) bump(METRICS.byUser, req.user.id);
}

export function getErrorMetrics(topN = 10) {
  const topOf = (map) =>
    Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([key, count]) => ({ key, count }));

  return {
    total: METRICS.total,
    firstAt: METRICS.firstAt ? new Date(METRICS.firstAt).toISOString() : null,
    lastAt: METRICS.lastAt ? new Date(METRICS.lastAt).toISOString() : null,
    topCodes: topOf(METRICS.byCode),
    topStatuses: topOf(METRICS.byStatus),
    topPaths: topOf(METRICS.byPath),
    topUsers: topOf(METRICS.byUser),
  };
}

export function resetErrorMetrics() {
  METRICS.total = 0;
  METRICS.byCode.clear();
  METRICS.byStatus.clear();
  METRICS.byPath.clear();
  METRICS.byUser.clear();
  METRICS.firstAt = null;
  METRICS.lastAt = null;
}

/* ═══════════════════════════════════════════════════════════════════════
   8 · MIDDLEWARE EXPRESS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Asigna un request ID corto a cada request. Se puede usar en logs
 * y en el header X-Request-Id.
 */
export function requestIdMiddleware() {
  return (req, res, next) => {
    req.id = req.id || crypto.randomBytes(4).toString('hex');
    req._t0 = req._t0 || Date.now();
    res.setHeader('X-Request-Id', req.id);
    next();
  };
}

/**
 * Convierte cualquier error en una respuesta HTTP consistente.
 * SIEMPRE debe ir después de TODAS las rutas.
 *
 * @param {object} opts
 * @param {boolean} opts.includeStack  · incluir stack en la respuesta (solo dev)
 * @param {string}  opts.requestIdField · nombre del campo con request ID
 */
export function errorMiddleware(opts = {}) {
  const includeStack = Boolean(opts.includeStack);
  const requestIdField = opts.requestIdField || 'requestId';

  return (err, req, res, _next) => {
    // Si ya mandamos headers, no podemos hacer nada
    if (res.headersSent) {
      logEvent('warn', 'error.headers_sent', {
        reqId: req.id,
        path: req.path,
        message: err?.message,
      });
      try { res.end(); } catch {}
      return;
    }

    // Normalizar el error a AppError
    const appErr = normalizeError(err);

    // Trackear
    trackError(appErr, req);

    // Loguear
    const logMeta = {
      reqId: req.id,
      method: req.method,
      path: req.path,
      status: appErr.status,
      code: appErr.code,
      message: appErr.message,
      userId: req.user?.id || null,
      ip: req.ip || null,
      elapsedMs: req._t0 ? Date.now() - req._t0 : null,
    };

    if (appErr.status >= 500) {
      logEvent('error', `http.${appErr.code}`, {
        ...logMeta,
        stack: shortStack(appErr.stack || appErr.cause?.stack),
        internal: sanitizeInternal(appErr.internal),
      });
    } else if (appErr.status === 401 || appErr.status === 403) {
      logEvent('warn', `http.${appErr.code}`, logMeta);
    } else if (appErr.status === 429) {
      logEvent('warn', `http.${appErr.code}`, logMeta);
    } else {
      logEvent('info', `http.${appErr.code}`, logMeta);
    }

    // Construir respuesta
    const body = {
      ok: false,
      error: sanitizeForClient(appErr.message),
      code: appErr.code,
      [requestIdField]: req.id,
    };

    // Datos extra para el cliente (si el AppError los tiene)
    if (appErr.internal && Object.keys(appErr.internal).length > 0) {
      // Solo campos seguros, NO pgDetail, NO stack
      const safe = pickSafeFields(appErr.internal);
      if (Object.keys(safe).length > 0) body.details = safe;
    }

    // Retry-After para rate limits
    if (appErr.retryAfter) {
      res.setHeader('Retry-After', String(appErr.retryAfter));
      body.retryAfter = appErr.retryAfter;
    }

    // Stack en desarrollo
    if (includeStack && appErr.stack) {
      body.stack = shortStack(appErr.stack);
    }

    res.status(appErr.status).json(body);
  };
}

/**
 * 404 para /api/* → JSON.
 * 404 para el resto → sirve 404.html si existe, sino redirige a /login.html.
 */
export function notFoundMiddleware(publicDir) {
  return (req, res, next) => {
    if (req.path.startsWith('/api/')) {
      return res.status(404).json({
        ok: false,
        error: 'Endpoint no encontrado: ' + req.path,
        code: CODES.INT_ENDPOINT_NOT_FOUND,
        requestId: req.id,
      });
    }

    // Archivos con extensión (ej. .js, .css, .png) → 404 JSON
    if (path.extname(req.path)) {
      return res.status(404).json({
        ok: false,
        error: 'Archivo no encontrado: ' + req.path,
        code: CODES.INT_FILE_NOT_FOUND,
        requestId: req.id,
      });
    }

    // HTML
    const page404 = publicDir ? path.join(publicDir, '404.html') : null;
    if (page404 && fs.existsSync(page404)) {
      return res.status(404).sendFile(page404);
    }
    return res.redirect('/login');
  };
}

/**
 * Convierte errores de distinto origen a un AppError tipado.
 */
function normalizeError(err) {
  // Ya es AppError
  if (err instanceof AppError) return err;

  // JSON inválido (body-parser)
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400)) {
    return new ValidationError(
      'El JSON enviado no es válido.',
      null,
      CODES.VALID_JSON,
      { hint: 'Revisa las comillas y las llaves.' },
    );
  }

  // Payload muy grande
  if (err?.type === 'entity.too.large') {
    return new ValidationError(
      'El cuerpo del mensaje es demasiado grande.',
      null,
      CODES.VALID_PAYLOAD_LARGE,
    );
  }

  // Postgres
  const pg = fromPgError(err);
  if (pg) return pg;

  // Motor IA
  if (err?.engine || /groq|gemini|nvidia|kimi|openai/i.test(err?.message || '')) {
    const engineErr = fromEngineError(err);
    if (engineErr) return engineErr;
  }

  // Timeout genérico
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return new TimeoutError('La operación tardó demasiado.');
  }

  // Genérico (por defecto 500)
  const internal = {};
  if (err?.message) internal.originalMessage = String(err.message).slice(0, 200);

  return new InternalError(
    'Error interno del servidor.',
    CODES.INT_SERVER_ERROR,
    internal,
    err,
  );
}

/**
 * De un objeto internal, deja solo los campos seguros para el cliente.
 * Los pg* y stack se excluyen SIEMPRE.
 */
function pickSafeFields(internal) {
  const safe = {};
  const allow = ['field', 'engine', 'status', 'hint', 'retryAfter', 'limit'];
  for (const k of allow) {
    if (internal[k] !== undefined) safe[k] = internal[k];
  }
  return safe;
}

/**
 * Sanitiza el objeto internal para el LOG (no para el cliente).
 * Aquí sí incluimos pgCode, pgDetail, etc.
 */
function sanitizeInternal(internal) {
  if (!internal || typeof internal !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(internal)) {
    if (typeof v === 'string') out[k] = sanitizeForClient(v).slice(0, 500);
    else out[k] = v;
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   9 · ASYNC HANDLER · try/catch automático
   ═══════════════════════════════════════════════════════════════════════
   Express no atrapa errores de funciones async. Este wrapper los manda
   al middleware de errores.
   ═══════════════════════════════════════════════════════════════════════ */

export function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Variante para múltiples handlers en cadena.
 */
export function chainHandlers(...handlers) {
  return handlers.map((h) => asyncHandler(h));
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · HANDLERS GLOBALES DE PROCESO
   ═══════════════════════════════════════════════════════════════════════
   Capturan errores que se escapan del request y dejan traza en logs.
   NO cierran el proceso automáticamente para no tumbar Vercel.
   ═══════════════════════════════════════════════════════════════════════ */

export function installProcessHandlers(opts = {}) {
  const isProd = process.env.NODE_ENV === 'production';
  const exitOnUncaught = opts.exitOnUncaught !== false && !process.env.VERCEL;

  process.on('uncaughtException', (err) => {
    logEvent('error', 'process.uncaught_exception', {
      message: err?.message,
      code: err?.code,
      stack: shortStack(err?.stack),
    });
    if (exitOnUncaught) {
      // Dar tiempo a escribir el log
      setTimeout(() => process.exit(1), 100).unref?.();
    }
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? shortStack(reason.stack) : null;
    logEvent('error', 'process.unhandled_rejection', {
      message: msg,
      stack,
    });
  });

  if (!isProd) {
    // En desarrollo, avisar si hay memory leaks
    const CHECK_MS = 60_000;
    let lastHeap = process.memoryUsage().heapUsed;
    const t = setInterval(() => {
      const now = process.memoryUsage().heapUsed;
      const deltaMB = (now - lastHeap) / 1024 / 1024;
      if (deltaMB > 50) {
        logEvent('warn', 'process.memory_growth', {
          deltaMB: Math.round(deltaMB),
          heapMB: Math.round(now / 1024 / 1024),
        });
      }
      lastHeap = now;
    }, CHECK_MS);
    if (t.unref) t.unref();
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   11 · HELPERS · para crear errores desde código sin recordar status
   ═══════════════════════════════════════════════════════════════════════
   Estos son shortcuts que muchos routers agradecen.
   ═══════════════════════════════════════════════════════════════════════ */

export const err = {
  /** 400 · validación */
  invalid: (message, field = null, code = CODES.VALID_MISSING_FIELD) =>
    new ValidationError(message, field, code),

  /** 400 · JSON malformado */
  badJson: (hint = null) =>
    new ValidationError('JSON inválido.', null, CODES.VALID_JSON, hint ? { hint } : {}),

  /** 400 · payload grande */
  tooLarge: (message = 'El contenido es demasiado grande.') =>
    new ValidationError(message, null, CODES.VALID_PAYLOAD_LARGE),

  /** 401 · sin sesión */
  noAuth: (message = 'No autenticado.') =>
    new AuthError(message, CODES.AUTH_NO_SESSION, 401),

  /** 401 · sesión inválida */
  badSession: (message = 'Sesión inválida o expirada.') =>
    new AuthError(message, CODES.AUTH_INVALID_SESSION, 401),

  /** 401 · credenciales malas */
  badCreds: (message = 'Correo o contraseña incorrectos.') =>
    new AuthError(message, CODES.AUTH_INVALID_CREDS, 401),

  /** 401 · hay que usar OAuth */
  useOauth: (provider = 'google') =>
    new AuthError(
      provider === 'github'
        ? 'Esa cuenta usa GitHub. Entra por ahí.'
        : 'Esa cuenta usa Google. Entra por ahí.',
      CODES.AUTH_USE_OAUTH,
      401,
      { provider },
    ),

  /** 403 · sin permisos */
  forbidden: (message = 'No tienes permiso para esto.') =>
    new ForbiddenError(message),

  /** 404 · no encontrado */
  notFound: (message = 'No encontrado.', code = CODES.INT_NOT_FOUND) =>
    new NotFoundError(message, code),

  /** 409 · conflicto / duplicado */
  conflict: (message, code = CODES.DB_UNIQUE_VIOLATION) =>
    new ConflictError(message, code),

  /** 429 · rate limit */
  rateLimit: (message, code = CODES.LIMIT_MINUTE, retryAfter = null) =>
    new RateLimitError(message, code, retryAfter),

  /** 502 · motor externo */
  engine: (engine, message, code = CODES.AI_ENGINE_FAILED) =>
    new EngineError(message, code, engine),

  /** 504 · timeout */
  timeout: (message = 'El servicio tardó demasiado.') =>
    new TimeoutError(message),

  /** 500 · base de datos */
  db: (message, cause = null) =>
    new DatabaseError(message, CODES.DB_QUERY_FAILED, null, cause),

  /** 500 · error interno */
  internal: (message = 'Error interno del servidor.', cause = null) =>
    new InternalError(message, CODES.INT_SERVER_ERROR, null, cause),
};

/* ═══════════════════════════════════════════════════════════════════════
   12 · UTILIDADES DE ASSERT · tirar si algo no se cumple
   ═══════════════════════════════════════════════════════════════════════
   Forma corta de validar sin if/throw manual.
   ═══════════════════════════════════════════════════════════════════════ */

export function assert(cond, errorOrMessage) {
  if (cond) return;
  if (errorOrMessage instanceof AppError) throw errorOrMessage;
  throw new InternalError(String(errorOrMessage || 'Assertion failed'));
}

export function assertField(value, field, message) {
  if (value === undefined || value === null || value === '') {
    throw new ValidationError(
      message || `Falta el campo "${field}".`,
      field,
      CODES.VALID_MISSING_FIELD,
    );
  }
}

export function assertEmail(value, field = 'email') {
  if (!value || typeof value !== 'string') {
    throw new ValidationError('Falta el correo.', field, CODES.VALID_EMAIL);
  }
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  if (!re.test(value.trim())) {
    throw new ValidationError('Ese correo no parece válido.', field, CODES.VALID_EMAIL);
  }
}

export function assertString(value, field, { min = 0, max = 10000 } = {}) {
  if (typeof value !== 'string') {
    throw new ValidationError(`"${field}" debe ser texto.`, field, CODES.VALID_INVALID_FIELD);
  }
  if (value.length < min) {
    throw new ValidationError(`"${field}" debe tener al menos ${min} caracteres.`, field, CODES.VALID_MISSING_FIELD);
  }
  if (value.length > max) {
    throw new ValidationError(`"${field}" no puede pasar de ${max} caracteres.`, field, CODES.VALID_INVALID_FIELD);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   FIN
   ═══════════════════════════════════════════════════════════════════════ */