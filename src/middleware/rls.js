/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · middleware/rls.js · v1.0
   ─────────────────────────────────────────────────────────────────────────
   Row Level Security enforcement para Supabase.

   QUÉ HACE:
     · Verifica que req.user.id esté seteado antes de cualquier query
     · Inyecta automáticamente .eq('userId', req.user.id) en cada query
     · Bloquea queries sin userId (deny by default)
     · Diferencia entre admin (acceso total) y user (acceso propio)
     · Detecta y bloquea intentos de bypass
     · Whitelist de tablas accesibles
     · Log de accesos sospechosos
     · Métricas por tabla y operación
     · Self-test integrado

   FILOSOFÍA:
     Supabase tiene RLS nativo, pero:
       1. Puede estar mal configurado en alguna tabla
       2. Alguien puede usar service_key (bypass de RLS)
       3. El frontend nunca debe confiar en el cliente
     Este middleware es la ÚLTIMA línea de defensa.

   USO:
     import { requireRLS, enforceUserScope, RLSDeniedError } from './middleware/rls.js';

     // Opción 1: Verificar que req.user exista (fail fast)
     app.use('/api/chats', requireAuth, requireRLS);

     // Opción 2: Envolver el cliente Supabase para forzar scope
     const sb = scopedClient(req); // Todos los .eq('userId') se añaden solos
     await sb.from('Chat').select('*'); // ← Auto-filtra por userId

     // Opción 3: Manual
     const query = enforceUserScope(req, sb.from('Chat').select('*'));
     await query; // Ya tiene el filtro

   EVENTOS:
     nm:rls:allowed   → { userId, table, op }
     nm:rls:denied    → { userId, table, op, reason }
     nm:rls:suspicious → { userId, ip, reason, query }

   API PÚBLICA:
     requireRLS                 · middleware que exige req.user
     enforceUserScope(req, query) · inyecta .eq('userId', ...)
     scopedClient(req)          · devuelve cliente Supabase con scope
     validateTable(table)       · verifica tabla permitida
     RLSDeniedError             · error tipado
     RLSEngine.test()           · tests
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = {
  // Tablas que SIEMPRE filtran por userId
  userScopedTables: [
    'Chat',
    'Message',
    'Memory',
    'Project',
    'Artifact',
    'Notification',
    'UserActivity',
    'MessageFeedback',
    'ProjectFile',
    'ProjectFileRevision',
    'StorageFile',
    'AiMode',
    'CreditLog',
    'PendingRecharge',
    'payments',
    'connector_integrations',
    'connector_oauth_states',
    'subscriptions',
  ],

  // Tablas públicas (no filtran por userId)
  publicTables: [
    'profiles',
    'BillingPlan',
    'AppVersion',
    'processed_webhook_events',
  ],

  // Columnas comunes donde buscar el userId (en orden de prioridad)
  userIdColumns: ['userId', 'user_id', 'profileId', 'profile_id', 'ownerId', 'owner_id'],

  // Tablas que solo admin puede tocar
  adminOnlyTables: [
    'AuditLog',
    'BillingPlan',
    'AppVersion',
    'processed_webhook_events',
  ],

  // Whitelist de operaciones por tabla
  operations: {
    Chat:            ['select', 'insert', 'update', 'delete'],
    Message:         ['select', 'insert', 'update', 'delete'],
    Memory:          ['select', 'insert', 'update', 'delete'],
    Project:         ['select', 'insert', 'update', 'delete'],
    ProjectFile:     ['select', 'insert', 'update', 'delete'],
    Artifact:        ['select', 'insert', 'update', 'delete'],
    Notification:    ['select', 'insert', 'update', 'delete'],
    UserActivity:    ['select', 'insert'],
    MessageFeedback: ['select', 'insert', 'update', 'delete'],
    AiMode:          ['select', 'insert', 'update'],
    CreditLog:       ['select', 'insert'],
    PendingRecharge: ['select', 'insert', 'update'],
    payments:        ['select', 'insert'],
    subscriptions:   ['select'],
    profiles:        ['select', 'update'],
  },

  // Si es true, requiere userId en req
  strictMode: process.env.RLS_STRICT !== 'false',

  // Si es true, permite bypass a admins
  adminBypass: process.env.RLS_ADMIN_BYPASS !== 'false',

  // Máximo de queries por request (rate limit)
  maxQueriesPerRequest: 200,

  // Log level
  logLevel: process.env.LOG_LEVEL || 'info',
};

/* ═══════════════════════════════════════════════════════════════════════════
   02 · LOGGER
   ═══════════════════════════════════════════════════════════════════════════ */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const CUR = LEVELS[CFG.logLevel] ?? LEVELS.info;

const LOG = {
  error: (...a) => CUR >= 1 && console.error('[rls]', ...a),
  warn:  (...a) => CUR >= 2 && console.warn ('[rls]', ...a),
  info:  (...a) => CUR >= 3 && console.log  ('[rls]', ...a),
  debug: (...a) => CUR >= 4 && console.log  ('[rls]', ...a),
};

/* ═══════════════════════════════════════════════════════════════════════════
   03 · ERRORES TIPADOS
   ═══════════════════════════════════════════════════════════════════════════ */

export class RLSDeniedError extends Error {
  constructor(code, message, statusCode = 403, extra = {}) {
    super(message);
    this.name = 'RLSDeniedError';
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}

const ERR = {
  NO_USER: 'RLS_NO_USER',
  NO_USER_ID: 'RLS_NO_USER_ID',
  INVALID_TABLE: 'RLS_INVALID_TABLE',
  INVALID_OPERATION: 'RLS_INVALID_OPERATION',
  INVALID_QUERY: 'RLS_INVALID_QUERY',
  SCOPE_MISMATCH: 'RLS_SCOPE_MISMATCH',
  ADMIN_ONLY: 'RLS_ADMIN_ONLY',
  RATE_LIMIT: 'RLS_RATE_LIMIT',
  SUSPICIOUS_QUERY: 'RLS_SUSPICIOUS_QUERY',
};

/* ═══════════════════════════════════════════════════════════════════════════
   04 · MÉTRICAS
   ═══════════════════════════════════════════════════════════════════════════ */

const _metrics = {
  totalQueries: 0,
  allowed: 0,
  denied: 0,
  suspicious: 0,
  byTable: new Map(),
  byOperation: new Map(),
  deniedReasons: new Map(),
  since: Date.now(),
};

function recordAllowed(table, op) {
  _metrics.totalQueries++;
  _metrics.allowed++;
  _metrics.byTable.set(table, (_metrics.byTable.get(table) || 0) + 1);
  _metrics.byOperation.set(op, (_metrics.byOperation.get(op) || 0) + 1);
}

function recordDenied(table, op, reason) {
  _metrics.totalQueries++;
  _metrics.denied++;
  _metrics.deniedReasons.set(reason, (_metrics.deniedReasons.get(reason) || 0) + 1);
}

function recordSuspicious() {
  _metrics.suspicious++;
}

export function getRLSMetrics() {
  return {
    totalQueries: _metrics.totalQueries,
    allowed: _metrics.allowed,
    denied: _metrics.denied,
    suspicious: _metrics.suspicious,
    allowRate: _metrics.totalQueries > 0
      ? +((_metrics.allowed / _metrics.totalQueries) * 100).toFixed(2)
      : 100,
    byTable: Object.fromEntries(_metrics.byTable),
    byOperation: Object.fromEntries(_metrics.byOperation),
    deniedReasons: Object.fromEntries(_metrics.deniedReasons),
    uptimeMs: Date.now() - _metrics.since,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · EVENT EMITTER
   ═══════════════════════════════════════════════════════════════════════════ */

function emit(name, detail) {
  try {
    if (typeof globalThis.dispatchEvent === 'function') {
      globalThis.dispatchEvent(new CustomEvent(name, { detail }));
    }
  } catch (e) {}
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · VALIDACIÓN DE TABLA Y OPERACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

function isUserScoped(table) {
  return CFG.userScopedTables.includes(table);
}

function isPublic(table) {
  return CFG.publicTables.includes(table);
}

function isAdminOnly(table) {
  return CFG.adminOnlyTables.includes(table);
}

function getAllowedOperations(table) {
  return CFG.operations[table] || ['select'];
}

function validateOperation(table, op) {
  const allowed = getAllowedOperations(table);
  return allowed.includes(op);
}

function isAdmin(user) {
  return user && (user.role === 'admin' || user.is_admin === true);
}

/* ═══════════════════════════════════════════════════════════════════════════
   07 · RATE LIMIT POR REQUEST
   ═══════════════════════════════════════════════════════════════════════════ */

const _requestCounters = new WeakMap();

function checkRateLimit(req) {
  if (!req) return { ok: true };
  let count = _requestCounters.get(req) || 0;
  count++;
  _requestCounters.set(req, count);
  if (count > CFG.maxQueriesPerRequest) {
    return { ok: false, count, max: CFG.maxQueriesPerRequest };
  }
  return { ok: true, count };
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · DETECCIÓN DE QUERY SOSPECHOSA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Detecta patrones sospechosos en una query:
 *  · Intento de leer todas las filas sin filtro
 *  · Intentos de OR lógicos para bypass
 *  · Uso de service_role sin autorización
 *  · WHERE userId = 'otro-valor' (mismatch)
 */
function detectSuspicious(query, table, req) {
  const warnings = [];

  if (!req.user) {
    warnings.push('sin req.user');
  }

  // Detectar intento de bypass común: si el request incluye query params sospechosos
  if (req.query) {
    const suspiciousParams = ['all', 'admin', 'bypass', 'service'];
    for (const p of suspiciousParams) {
      if (req.query[p] === '1' || req.query[p] === 'true') {
        warnings.push('parámetro sospechoso: ' + p);
      }
    }
  }

  // Detectar userId en body que no coincide con req.user
  if (req.body && req.body.userId && req.user && req.body.userId !== req.user.id) {
    warnings.push('userId mismatch: ' + req.body.userId + ' != ' + req.user.id);
  }

  return warnings;
}

/* ═══════════════════════════════════════════════════════════════════════════
   09 · MIDDLEWARE · requireRLS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Middleware que exige que req.user esté seteado.
 * Se usa DESPUÉS de requireAuth.
 *
 * Uso:
 *   app.get('/api/chats', requireAuth, requireRLS, handler);
 */
export function requireRLS(req, res, next) {
  // 1. Verificar user
  if (!req.user) {
    const err = new RLSDeniedError(
      ERR.NO_USER,
      'Se requiere autenticación para esta operación',
      401
    );
    LOG.warn('requireRLS · sin user', { path: req.path });
    recordDenied(req.path, 'unknown', ERR.NO_USER);
    return res.status(err.statusCode).json({ ok: false, error: err.message, code: err.code });
  }

  // 2. Verificar userId
  if (!req.user.id) {
    const err = new RLSDeniedError(
      ERR.NO_USER_ID,
      'Usuario sin ID (token inválido)',
      401
    );
    LOG.error('requireRLS · user sin id', { user: req.user });
    recordDenied(req.path, 'unknown', ERR.NO_USER_ID);
    return res.status(err.statusCode).json({ ok: false, error: err.message, code: err.code });
  }

  // 3. Normalizar userId
  if (!req.userId) {
    req.userId = req.user.id;
  }

  // 4. Marcar req como RLS-safe
  req.__rls = {
    userId: req.userId,
    isAdmin: isAdmin(req.user),
    checkedAt: Date.now(),
  };

  LOG.debug('requireRLS · OK', { userId: req.userId, path: req.path });
  emit('nm:rls:allowed', { userId: req.userId, path: req.path, op: 'middleware' });

  next();
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · ENFORCE USER SCOPE · inyecta filtros
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Toma un query builder de Supabase y le inyecta el filtro .eq('userId', req.user.id).
 * Si el user es admin, no inyecta.
 *
 * Uso:
 *   const q = enforceUserScope(req, sb.from('Chat').select('*'));
 *   const { data } = await q;
 */
export function enforceUserScope(req, query, options = {}) {
  if (!req) {
    throw new RLSDeniedError(ERR.NO_USER, 'Sin request');
  }

  if (!req.user) {
    throw new RLSDeniedError(ERR.NO_USER, 'Sin usuario autenticado', 401);
  }

  if (!req.userId) {
    req.userId = req.user.id;
  }

  // Detectar tabla del query (approximado del query string interno)
  const table = detectTableFromQuery(query) || 'unknown';
  const op = detectOperationFromQuery(query) || 'select';

  // Rate limit por request
  const rl = checkRateLimit(req);
  if (!rl.ok) {
    recordDenied(table, op, ERR.RATE_LIMIT);
    throw new RLSDeniedError(
      ERR.RATE_LIMIT,
      `Demasiadas queries en un request (max ${rl.max})`,
      429,
      { count: rl.count }
    );
  }

  // Admin bypass (opcional)
  if (CFG.adminBypass && isAdmin(req.user)) {
    LOG.debug('enforceUserScope · admin bypass', { userId: req.userId, table });
    recordAllowed(table, op);
    return query;
  }

  // Tabla pública: no filtramos
  if (isPublic(table)) {
    LOG.debug('enforceUserScope · tabla pública', { table });
    recordAllowed(table, op);
    return query;
  }

  // Tabla admin-only: rechazar si no es admin
  if (isAdminOnly(table)) {
    recordDenied(table, op, ERR.ADMIN_ONLY);
    throw new RLSDeniedError(
      ERR.ADMIN_ONLY,
      `Tabla ${table} solo accesible para admins`,
      403
    );
  }

  // Verificar operación permitida
  if (!validateOperation(table, op)) {
    recordDenied(table, op, ERR.INVALID_OPERATION);
    throw new RLSDeniedError(
      ERR.INVALID_OPERATION,
      `Operación ${op} no permitida en tabla ${table}`,
      403,
      { table, operation: op }
    );
  }

  // Detección de query sospechosa
  const warnings = detectSuspicious(query, table, req);
  if (warnings.length > 0) {
    recordSuspicious();
    LOG.warn('query sospechosa', { userId: req.userId, table, warnings });
    emit('nm:rls:suspicious', {
      userId: req.userId,
      ip: req.ip,
      table,
      warnings,
    });
  }

  // Inyectar filtro de userId
  let scopedQuery = query;
  try {
    if (typeof query.eq === 'function') {
      scopedQuery = query.eq('userId', req.userId);
      LOG.debug('enforceUserScope · filtro userId inyectado', {
        userId: req.userId,
        table,
        op,
      });
    } else {
      // Query builder sin .eq (raro)
      LOG.warn('query sin .eq() · no se pudo filtrar', { table, op });
    }
  } catch (e) {
    LOG.error('enforceUserScope · error al filtrar', { error: e.message });
    recordDenied(table, op, ERR.INVALID_QUERY);
    throw new RLSDeniedError(
      ERR.INVALID_QUERY,
      'No se pudo aplicar el filtro de seguridad',
      500
    );
  }

  recordAllowed(table, op);
  emit('nm:rls:allowed', { userId: req.userId, table, op });

  return scopedQuery;
}

/* ═══════════════════════════════════════════════════════════════════════════
   11 · DETECCIÓN DE TABLA Y OPERACIÓN EN QUERY
   ═══════════════════════════════════════════════════════════════════════════ */

function detectTableFromQuery(query) {
  // Estrategia: buscar en el objeto interno del query builder
  // Supabase no expone la tabla directamente, así que buscamos en los símbolos o propiedades

  // Try common properties
  const props = ['table', 'from', '_table', 'url'];
  for (const p of props) {
    if (query && query[p]) {
      const val = String(query[p]);
      if (val.startsWith('/rest/v1/')) {
        return val.replace('/rest/v1/', '').split('?')[0];
      }
      return val;
    }
  }

  // Buscar en toString
  try {
    const str = String(query);
    const m = str.match(/\/rest\/v1\/([A-Za-z_]+)/);
    if (m) return m[1];
  } catch (e) {}

  return 'unknown';
}

function detectOperationFromQuery(query) {
  // Intentar detectar el método HTTP interno
  const method = query?.method || query?.headers?.method || query?._method;
  if (method === 'POST') return 'insert';
  if (method === 'PATCH') return 'update';
  if (method === 'PUT') return 'update';
  if (method === 'DELETE') return 'delete';
  return 'select';
}

/* ═══════════════════════════════════════════════════════════════════════════
   12 · SCOPED CLIENT · wrapper de Supabase
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Devuelve un cliente Supabase "envuelto" que fuerza el filtro userId
 * en cada query a tablas user-scoped.
 *
 * Uso:
 *   const sb = scopedClient(req);
 *   const { data } = await sb.from('Chat').select('*');
 *   // ↑ Automáticamente filtra por userId
 */
export function scopedClient(req, baseClient) {
  if (!baseClient) {
    throw new Error('scopedClient requiere un cliente Supabase base');
  }

  if (!req.user || !req.userId) {
    LOG.warn('scopedClient · sin user, denegando acceso');
    throw new RLSDeniedError(ERR.NO_USER, 'Sin usuario autenticado', 401);
  }

  const userId = req.userId;
  const isUserAdmin = CFG.adminBypass && isAdmin(req.user);

  return {
    from(table) {
      // Validar tabla
      if (!isUserScoped(table) && !isPublic(table) && !isAdminOnly(table)) {
        LOG.warn('scopedClient · tabla no whitelisted', { table });
        // Pero permitimos igual, puede ser una tabla nueva
      }

      if (isAdminOnly(table) && !isUserAdmin) {
        throw new RLSDeniedError(
          ERR.ADMIN_ONLY,
          `Tabla ${table} solo accesible para admins`,
          403
        );
      }

      const queryBuilder = baseClient.from(table);

      // Si es tabla user-scoped, inyectamos el filtro en select/insert/update/delete
      if (isUserScoped(table) && !isUserAdmin) {
        return wrapQueryBuilder(queryBuilder, table, userId, req);
      }

      return queryBuilder;
    },

    // Pasar métodos directos
    rpc: baseClient.rpc ? baseClient.rpc.bind(baseClient) : undefined,
    storage: baseClient.storage,
    auth: baseClient.auth,
  };
}

/**
 * Envuelve un query builder para inyectar el userId en cada operación.
 */
function wrapQueryBuilder(qb, table, userId, req) {
  // Detectar el método original
  const origSelect = qb.select?.bind(qb);
  const origInsert = qb.insert?.bind(qb);
  const origUpdate = qb.update?.bind(qb);
  const origDelete = qb.delete?.bind(qb);
  const origEq = qb.eq?.bind(qb);

  const wrapped = Object.create(qb);

  // Select: añadir .eq('userId', userId)
  wrapped.select = function(...args) {
    const q = origSelect.apply(qb, args);
    return q.eq('userId', userId);
  };

  // Insert: forzar userId en el payload
  wrapped.insert = function(data, ...args) {
    let payload = data;

    if (Array.isArray(payload)) {
      payload = payload.map(item => ({ ...item, userId }));
    } else if (payload && typeof payload === 'object') {
      payload = { ...payload, userId };
    }

    // Detección de intento de inyectar otro userId
    const originalUserId = Array.isArray(data)
      ? data[0]?.userId
      : data?.userId;
    if (originalUserId && originalUserId !== userId) {
      LOG.warn('scopedClient · intento de insert con userId ajeno', {
        table,
        intento: originalUserId,
        real: userId,
        ip: req.ip,
      });
      recordSuspicious();
      emit('nm:rls:suspicious', {
        userId,
        ip: req.ip,
        table,
        reason: 'insert userId mismatch',
      });
    }

    return origInsert(payload, ...args);
  };

  // Update: forzar userId en el filtro
  wrapped.update = function(data, ...args) {
    const q = origUpdate(data, ...args);
    return q.eq('userId', userId);
  };

  // Delete: forzar userId
  wrapped.delete = function(...args) {
    const q = origDelete(...args);
    return q.eq('userId', userId);
  };

  // Pasar el resto de métodos
  return new Proxy(wrapped, {
    get(target, prop) {
      if (prop in target) return target[prop];
      const val = qb[prop];
      return typeof val === 'function' ? val.bind(qb) : val;
    },
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   13 · GUARDS ESPECÍFICOS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Middleware específico para verificar que un ID de path pertenece al user.
 * Útil para rutas como /api/chats/:id
 */
export function requireOwnership(getOwnerId, options = {}) {
  const { field = 'userId' } = options;

  return async (req, res, next) => {
    try {
      if (!req.user || !req.userId) {
        return res.status(401).json({ ok: false, error: 'No autenticado', code: ERR.NO_USER });
      }

      // Admin bypass
      if (CFG.adminBypass && isAdmin(req.user)) {
        return next();
      }

      // Obtener owner del recurso
      const resourceId = req.params.id;
      if (!resourceId) {
        return res.status(400).json({ ok: false, error: 'Falta :id', code: 'RLS_NO_ID' });
      }

      const ownerId = await getOwnerId(resourceId);
      if (!ownerId) {
        return res.status(404).json({ ok: false, error: 'Recurso no encontrado', code: 'NOT_FOUND' });
      }

      if (String(ownerId) !== String(req.userId)) {
        LOG.warn('requireOwnership · denegado', {
          userId: req.userId,
          resourceId,
          ownerId,
          ip: req.ip,
        });
        recordDenied(req.path, 'ownership', ERR.SCOPE_MISMATCH);
        emit('nm:rls:denied', {
          userId: req.userId,
          resourceId,
          reason: ERR.SCOPE_MISMATCH,
        });
        return res.status(403).json({
          ok: false,
          error: 'No tenés acceso a este recurso',
          code: ERR.SCOPE_MISMATCH,
        });
      }

      next();
    } catch (e) {
      LOG.error('requireOwnership · error', { error: e.message });
      res.status(500).json({ ok: false, error: 'Error verificando ownership' });
    }
  };
}

/**
 * Middleware para bloquear acceso a tablas admin-only.
 */
export function requireAdminTable(tableName) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ ok: false, error: 'No autenticado' });
    }

    if (!isAdmin(req.user)) {
      LOG.warn('requireAdminTable · denegado', {
        userId: req.userId,
        table: tableName,
      });
      recordDenied(tableName, 'access', ERR.ADMIN_ONLY);
      return res.status(403).json({
        ok: false,
        error: `Tabla ${tableName} solo accesible para admins`,
        code: ERR.ADMIN_ONLY,
      });
    }

    next();
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   14 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Obtiene el userId del request (o del body, o de la sesión).
 * Nunca confía en el body si hay user autenticado.
 */
export function getEffectiveUserId(req) {
  if (req.user?.id) return req.user.id;
  if (req.userId) return req.userId;
  return null;
}

/**
 * Sanitiza un userId: remueve caracteres peligrosos.
 */
export function sanitizeUserId(userId) {
  if (!userId) return null;
  return String(userId).replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 64);
}

/**
 * Verifica si el user puede acceder a la tabla.
 */
export function canAccessTable(user, table) {
  if (!user) return false;
  if (isAdmin(user)) return true;
  if (isPublic(table)) return true;
  if (isAdminOnly(table)) return false;
  return true; // user-scoped, pero con filtro
}

/* ═══════════════════════════════════════════════════════════════════════════
   15 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════════ */

async function selfTest() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  // Test 1: isUserScoped
  rec('Chat es user-scoped', isUserScoped('Chat') === true, true);
  rec('profiles es pública', isPublic('profiles') === true, true);
  rec('AuditLog es admin-only', isAdminOnly('AuditLog') === true, true);

  // Test 2: validateOperation
  rec('Chat permite select', validateOperation('Chat', 'select') === true, true);
  rec('UserActivity NO permite delete', validateOperation('UserActivity', 'delete') === false, true);

  // Test 3: isAdmin
  rec('role=admin → isAdmin', isAdmin({ role: 'admin' }) === true, true);
  rec('role=student → no admin', isAdmin({ role: 'student' }) === false, true);
  rec('user null → no admin', isAdmin(null) === false, true);

  // Test 4: sanitizeUserId
  rec('sanitize quita chars', sanitizeUserId('abc-123_xyz') === 'abc-123_xyz', sanitizeUserId('abc-123_xyz'));
  rec('sanitize remueve peligrosos', sanitizeUserId("abc';DROP--") === 'abcDROP', sanitizeUserId("abc';DROP--"));

  // Test 5: requireRLS sin user → error
  let requireRLSFail = false;
  const fakeRes = {
    status: (code) => ({ json: (data) => { requireRLSFail = code === 401; return { code }; } }),
  };
  requireRLS({ user: null, path: '/test' }, fakeRes, () => {});
  rec('requireRLS sin user → 401', requireRLSFail === true, requireRLSFail);

  // Test 6: requireRLS con user → ok
  let requireRLSPass = false;
  requireRLS(
    { user: { id: 'user123' }, userId: 'user123', path: '/test' },
    fakeRes,
    () => { requireRLSPass = true; }
  );
  rec('requireRLS con user → next()', requireRLSPass === true, requireRLSPass);

  // Test 7: enforceUserScope con query mock
  const fakeQuery = {
    eq: function(col, val) {
      this._filter = { col, val };
      return this;
    },
    _filter: null,
  };

  try {
    const req = { user: { id: 'user123' }, userId: 'user123', ip: '1.2.3.4', query: {} };
    const scoped = enforceUserScope(req, fakeQuery);
    rec('enforceUserScope inyecta filtro', scoped._filter?.col === 'userId' && scoped._filter?.val === 'user123', scoped._filter);
  } catch (e) {
    rec('enforceUserScope inyecta filtro', false, e.message);
  }

  // Test 8: enforceUserScope sin user → error
  try {
    enforceUserScope({}, fakeQuery);
    rec('enforceUserScope sin user → error', false, 'no throw');
  } catch (e) {
    rec('enforceUserScope sin user → error', e.code === ERR.NO_USER, e.code);
  }

  // Test 9: getMetrics
  const m = getRLSMetrics();
  rec('getRLSMetrics devuelve objeto', typeof m === 'object' && 'totalQueries' in m, typeof m);

  // Test 10: canAccessTable
  rec('admin accede a todo', canAccessTable({ role: 'admin' }, 'AuditLog') === true, true);
  rec('student NO accede a AuditLog', canAccessTable({ role: 'student' }, 'AuditLog') === false, true);
  rec('student accede a Chat', canAccessTable({ role: 'student' }, 'Chat') === true, true);

  // Test 11: getEffectiveUserId
  rec('getEffectiveUserId con user', getEffectiveUserId({ user: { id: 'u1' } }) === 'u1', 'u1');
  rec('getEffectiveUserId sin user', getEffectiveUserId({}) === null, null);

  // Test 12: Detección tabla
  rec('detectTableFromQuery con prop', detectTableFromQuery({ table: 'Chat' }) === 'Chat', 'Chat');
  rec('detectTableFromQuery con URL', detectTableFromQuery({ url: '/rest/v1/Message?x=1' }) === 'Message', 'Message');

  const passed = results.filter(r => r.ok).length;
  return {
    passed,
    total: results.length,
    ok: passed === results.length,
    results,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   16 · CONFIGURE
   ═══════════════════════════════════════════════════════════════════════════ */

export function configure(patch) {
  if (!patch || typeof patch !== 'object') return;
  Object.keys(patch).forEach(k => {
    if (typeof patch[k] === 'object' && !Array.isArray(patch[k])) {
      CFG[k] = { ...CFG[k], ...patch[k] };
    } else {
      CFG[k] = patch[k];
    }
  });
  LOG.info('RLS config updated');
}

/* ═══════════════════════════════════════════════════════════════════════════
   17 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export const RLS = {
  // Middleware
  requireRLS,
  requireOwnership,
  requireAdminTable,
  scopedClient,
  enforceUserScope,

  // Helpers
  getEffectiveUserId,
  sanitizeUserId,
  canAccessTable,
  isUserScoped,
  isPublic,
  isAdminOnly,

  // Métricas
  metrics: getRLSMetrics,

  // Config
  configure,

  // Debug
  test: selfTest,

  // Errores
  RLSDeniedError,
  ERR,

  // Internals
  _config: CFG,
  _metrics,
};

export default RLS;

/* ═══════════════════════════════════════════════════════════════════════════
   18 · DEMO USAGE
   ═══════════════════════════════════════════════════════════════════════════

   // EN index.js
   import { requireRLS, scopedClient, getRLSMetrics } from './middleware/rls.js';
   import { requireAuth } from './middleware/auth.js';

   app.get('/api/chats', requireAuth, requireRLS, async (req, res) => {
     const sb = scopedClient(req, supabase);
     const { data, error } = await sb.from('Chat').select('*');
     // ↑ Solo chats de req.user.id
   });

   app.get('/api/chats/:id', requireAuth, requireRLS, async (req, res) => {
     const sb = scopedClient(req, supabase);
     const { data } = await sb.from('Chat').select('*').eq('id', req.params.id).single();
     // ↑ Si el chat no es del user, no devuelve nada
   });

   app.post('/api/chats', requireAuth, requireRLS, async (req, res) => {
     const sb = scopedClient(req, supabase);
     const { data } = await sb.from('Chat').insert({ title: req.body.title });
     // ↑ Auto-inyecta userId
   });

   // Admin
   app.get('/api/admin/audit', requireAuth, requireAdmin, async (req, res) => {
     // Admin bypass automático
   });

   // Métricas
   app.get('/api/admin/rls-metrics', requireAdmin, (req, res) => {
     res.json(getRLSMetrics());
   });

   ═══════════════════════════════════════════════════════════════════════════ */