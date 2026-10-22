/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/error-translator.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Traductor de errores: convierte fallos técnicos en mensajes que un
   usuario final puede entender (y actuar).

   EL PROBLEMA
   "connect ECONNREFUSED 127.0.0.1:5432" no le dice nada a nadie.
   "El motor de IA está descansando. Reintenta en un momento." sí.

   DISEÑO
   · `translateError(err)` → mensaje humano + código estable + hint
     opcional. Nunca lanza: siempre devuelve algo.
   · `errorTranslator()` → middleware Express de 4 argumentos. Se
     monta DESPUÉS de las rutas y antes (o en lugar de) el error
     middleware genérico.
   · `installErrorTranslator(app)` → atajo de montaje.
   · El stack trace NUNCA sale al cliente en producción: se registra en
     el log del servidor con el requestId.

   EL DICCIONARIO
   Cubre 5 familias:
     · Red / socket     (ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EAI_AGAIN…)
     · Postgres         (42P01, 23505, 23503, 57014, 08xxx…)
     · IA / proveedores (429, 503, overloaded, quota…)
     · Auth             (401, 403, token expirado…)
     · Aplicación       (404, 413, 429, 5xx genéricos)
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · DICCIONARIO
   ═══════════════════════════════════════════════════════════════════════════ */

const DICTIONARY = Object.freeze({
  /* ─── Red / socket ─────────────────────────────────────────────────── */
  ECONNREFUSED: {
    message: 'El motor de IA está descansando. Reintenta en un momento.',
    status: 503,
    code: 'engine_unavailable',
    hint: 'No pudimos conectar con el proveedor. Es transitorio.',
  },
  ECONNRESET: {
    message: 'Se cortó la conexión con el motor de IA. Reintentá.',
    status: 502,
    code: 'engine_reset',
  },
  ETIMEDOUT: {
    message: 'El motor de IA tardó demasiado. Probá con una consulta más corta.',
    status: 504,
    code: 'engine_timeout',
    hint: 'Reducí el tamaño del mensaje o el contexto.',
  },
  ENOTFOUND: {
    message: 'No pudimos resolver el servicio. Revisá tu conexión.',
    status: 502,
    code: 'dns_failure',
  },
  EAI_AGAIN: {
    message: 'Problema temporal de red. Reintentá en unos segundos.',
    status: 502,
    code: 'dns_retry',
  },
  ECONNABORTED: {
    message: 'La operación se canceló antes de terminar.',
    status: 499,
    code: 'client_closed',
  },
  EPIPE: {
    message: 'Se perdió la conexión durante la respuesta. Reintentá.',
    status: 502,
    code: 'pipe_broken',
  },
  CERT_HAS_EXPIRED: {
    message: 'Falló la verificación de seguridad del servidor. Contactá a soporte.',
    status: 502,
    code: 'tls_error',
  },
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: {
    message: 'Falló la verificación de seguridad del servidor. Contactá a soporte.',
    status: 502,
    code: 'tls_error',
  },

  /* ─── Postgres ─────────────────────────────────────────────────────── */
  '': {
    message: 'Falta una tabla en la base de datos. Nuestro equipo ya fue notificado.',
    status: 500,
    code: 'db_schema_missing',
    hint: 'Revisá las migraciones.',
  },
  '': {
    message: 'Falta una columna en la base de datos. Nuestro equipo ya fue notificado.',
    status: 500,
    code: 'db_column_missing',
  },
  '': {
    message: 'Ese registro ya existe.',
    status: 409,
    code: 'db_duplicate',
    hint: 'Usá un valor diferente o editá el registro existente.',
  },
  '': {
    message: 'No pudimos completar la operación: falta un dato relacionado.',
    status: 409,
    code: 'db_foreign_key',
  },
  '': {
    message: 'Falta un campo obligatorio en la información que enviaste.',
    status: 400,
    code: 'db_not_null',
  },
  '': {
    message: 'Alguno de los datos enviados tiene un formato inválido.',
    status: 400,
    code: 'db_bad_format',
  },
  '': {
    message: 'La consulta tardó demasiado y la cancelamos. Probá con menos datos.',
    status: 504,
    code: 'db_timeout',
  },
  '08P01': {
    message: 'No pudimos conectar con la base de datos. Reintentá en un momento.',
    status: 503,
    code: 'db_unavailable',
  },
  '08006': {
    message: 'Se perdió la conexión con la base de datos. Reintentá.',
    status: 503,
    code: 'db_connection_lost',
  },
  '08003': {
    message: 'La base de datos no acepta conexiones en este momento.',
    status: 503,
    code: 'db_no_connections',
  },

  /* ─── IA / proveedores ─────────────────────────────────────────────── */
  AI_RATE_LIMIT: {
    message: 'Alcanzaste el límite de uso del motor de IA. Probá en un minuto.',
    status: 429,
    code: 'ai_rate_limit',
  },
  AI_TIMEOUT: {
    message: 'El modelo tardó demasiado en responder. Probá de nuevo.',
    status: 504,
    code: 'ai_timeout',
  },
  AI_AUTH: {
    message: 'El motor de IA rechazó nuestras credenciales. Contactá a soporte.',
    status: 502,
    code: 'ai_credentials',
  },
  AI_MODEL_MISSING: {
    message: 'Ese modelo no está disponible ahora. Probá con otro.',
    status: 502,
    code: 'ai_model_missing',
  },
  AI_NETWORK: {
    message: 'No pudimos comunicarnos con el motor de IA. Reintentá.',
    status: 502,
    code: 'ai_network',
  },
  AI_ENGINE_FAILED: {
    message: 'El motor de IA falló al procesar tu mensaje. Reintentá.',
    status: 502,
    code: 'ai_engine_failed',
  },
  AI_ALL_ENGINES_FAILED: {
    message: 'Ningún motor de IA respondió. Nuestro equipo ya fue notificado.',
    status: 502,
    code: 'ai_all_failed',
  },

  /* ─── Auth ─────────────────────────────────────────────────────────── */
  AUTH_NO_TOKEN: {
    message: 'Tu sesión expiró. Volvé a iniciar sesión.',
    status: 401,
    code: 'session_missing',
  },
  AUTH_INVALID_TOKEN: {
    message: 'Tu sesión no es válida. Volvé a iniciar sesión.',
    status: 401,
    code: 'session_invalid',
  },
  AUTH_EXPIRED_TOKEN: {
    message: 'Tu sesión expiró. Volvé a iniciar sesión.',
    status: 401,
    code: 'session_expired',
  },
  AUTH_SESSION_REVOKED: {
    message: 'Cerramos tu sesión por seguridad. Volvé a entrar.',
    status: 401,
    code: 'session_revoked',
  },
  AUTH_ROLE_INSUFFICIENT: {
    message: 'Tu cuenta no tiene permisos para esta acción.',
    status: 403,
    code: 'forbidden_role',
  },
  AUTH_PLAN_INSUFFICIENT: {
    message: 'Esta función necesita un plan superior.',
    status: 402,
    code: 'plan_required',
    hint: 'Mirá los planes disponibles en Facturación.',
  },
  AUTH_BANNED: {
    message: 'Tu cuenta está suspendida. Contactá a soporte si creés que es un error.',
    status: 403,
    code: 'account_banned',
  },
  AUTH_SUSPENDED: {
    message: 'Tu cuenta está suspendida temporalmente.',
    status: 403,
    code: 'account_suspended',
  },

  /* ─── Aplicación ───────────────────────────────────────────────────── */
  ENTITY_TOO_LARGE: {
    message: 'El archivo o mensaje es demasiado grande.',
    status: 413,
    code: 'payload_too_large',
  },
  LIMIT_MINUTE: {
    message: 'Vas muy rápido. Esperá un momento antes de volver a intentarlo.',
    status: 429,
    code: 'rate_limited',
  },
  LIMIT_BURST: {
    message: 'Demasiadas peticiones seguidas. Tomá un respiro.',
    status: 429,
    code: 'rate_limited_burst',
  },
  INTENT_NOT_FOUND: {
    message: 'No encontramos lo que estabas buscando.',
    status: 404,
    code: 'not_found',
  },
  INT_ENDPOINT_NOT_FOUND: {
    message: 'Esa dirección no existe.',
    status: 404,
    code: 'endpoint_not_found',
  },
  INT_FILE_NOT_FOUND: {
    message: 'No encontramos ese archivo.',
    status: 404,
    code: 'file_not_found',
  },
  INT_MAINTENANCE: {
    message: 'Estamos haciendo mantenimiento. Volvé en unos minutos.',
    status: 503,
    code: 'maintenance',
  },
});

/* ─── Mensajes por código HTTP (último recurso) ─────────────────────────── */

const BY_STATUS = Object.freeze({
  400: 'Revisá la información que enviaste e intentá de nuevo.',
  401: 'Necesitás iniciar sesión para hacer esto.',
  402: 'Esta función requiere un plan superior.',
  403: 'No tenés permisos para esta acción.',
  404: 'No encontramos lo que estabas buscando.',
  408: 'La operación tardó demasiado. Reintentá.',
  409: 'Ese registro ya existe o entra en conflicto con otro.',
  413: 'El contenido es demasiado grande.',
  422: 'No pudimos procesar la información: revisá los campos.',
  429: 'Vas muy rápido. Esperá un momento.',
  500: 'Algo se rompió de nuestro lado. Ya estamos avisados.',
  502: 'Un servicio externo no respondió bien. Reintentá.',
  503: 'El servicio no está disponible en este momento. Reintentá en breve.',
  504: 'La operación tardó demasiado. Probá con menos datos.',
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · TRADUCCIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Traduce un error a un mensaje humano.
 * NUNCA lanza: si algo sale mal, devuelve un mensaje genérico.
 *
 * @param {Error|object|string} err
 * @param {object} [context] { status, path, exposeStack }
 * @returns {object} { ok, message, code, status, hint, original, requestId }
 */
export function translateError(err, context = {}) {
  const requestId = context.requestId || `err_${crypto.randomBytes(4).toString('hex')}`;

  let raw = err;
  if (typeof err === 'string') raw = { message: err };

  const original = raw?.message || 'Error desconocido';
  const rawCode = raw?.code || raw?.err?.code || null;
  const status = Number(raw?.status || raw?.statusCode || context.status || 500);

  const entry = (rawCode && DICTIONARY[rawCode]) || null;

  // El código de la app (p.ej. "ai_rate_limit") también se busca.
  const appEntry = (!entry && raw?.code && DICTIONARY[String(raw.code).toUpperCase()]) || null;
  const chosen = entry || appEntry;

  const message = chosen
    ? chosen.message
    : (raw?.code && BY_STATUS[status])
      ? BY_STATUS[status]
      : `Algo salió mal de nuestro lado. Volvé a intentar. (${requestId})`;

  const finalStatus = chosen?.status || status;

  return {
    ok: false,
    message,
    code: chosen?.code || raw?.code || `http_${finalStatus}`,
    status: finalStatus,
    hint: chosen?.hint || null,
    original,
    requestId,
    context: {
      path: context.path || null,
      method: context.method || null,
    },
  };
}

/**
 * Traduce un código suelto ("ECONNREFUSED") sin necesidad del error.
 */
export function translateCode(code, fallbackStatus = 500) {
  const entry = DICTIONARY[String(code || '').toUpperCase()];
  if (!entry) {
    return {
      message: BY_STATUS[fallbackStatus] || 'Algo salió mal.',
      code: String(code || 'unknown'),
      status: fallbackStatus,
      hint: null,
    };
  }
  return { ...entry };
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · MIDDLEWARE EXPRESS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Middleware de error (4 argumentos) que reemplaza la respuesta cruda
 * por una traduciida.
 *
 * Montaje:
 *   app.use(errorTranslator());
 *   // … rutas …
 *   app.use(errorTranslator());   ← sólo uno, después de las rutas
 */
export function errorTranslator(opts = {}) {
  const {
    includeOriginal = process.env.NODE_ENV !== 'production',
    includeStack = false,
    logger = LOG,
  } = opts;

  return function translator(err, req, res, next) {
    if (res.headersSent) {
      try { res.end(); } catch { /* ya estaba cerrada */ }
      return;
    }

    const translated = translateError(err, {
      requestId: req.id,
      path: req.path,
      method: req.method,
    });

    // Log con TODO el detalle técnico (nunca sale al cliente).
    logger.error('error.translated', {
      reqId: req.id,
      method: req.method,
      path: req.path,
      status: translated.status,
      code: translated.code,
      original: translated.original,
      userId: req.user?.id || null,
      stack: includeStack ? String(err?.stack || '').split('\n').slice(0, 6).join('\n') : undefined,
    });

    const body = {
      ok: false,
      error: translated.message,
      code: translated.code,
      requestId: req.id || translated.requestId,
    };

    if (translated.hint) body.hint = translated.hint;
    if (includeOriginal && err?.message) body.debug = String(err.message).slice(0, 200);

    res.status(translated.status).json(body);
  };
}

/**
 * Monta el traductor en la app.
 * @param {import('express').Application} app
 */
export function installErrorTranslator(app, opts = {}) {
  app.use(errorTranslator(opts));
  return app;
}

/**
 * Envuelve un handler async y traduce sus errores sin depender del
 * middleware global. Útil para endpoints que devuelven respuestas
 * distintas a JSON (por ejemplo, descarga de PDF).
 */
export function translatedHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      const translated = translateError(err, {
        requestId: req.id,
        path: req.path,
        method: req.method,
      });

      LOG.error('error.translated.handler', {
        reqId: req.id,
        path: req.path,
        code: translated.code,
        original: translated.original,
      });

      if (res.headersSent) {
        try { res.end(); } catch { /* ya estaba cerrada */ }
        return;
      }

      res.status(translated.status).json({
        ok: false,
        error: translated.message,
        code: translated.code,
        requestId: req.id || translated.requestId,
        hint: translated.hint || undefined,
      });
    });
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

export function getErrorDictionarySize() {
  return Object.keys(DICTIONARY).length;
}

export function listErrorCodes() {
  return Object.entries(DICTIONARY).map(([code, entry]) => ({
    code,
    message: entry.message,
    status: entry.status,
    hint: entry.hint || null,
  }));
}

export default {
  translateError,
  translateCode,
  errorTranslator,
  installErrorTranslator,
  translatedHandler,
  getErrorDictionarySize,
  listErrorCodes,
  DICTIONARY,
};
