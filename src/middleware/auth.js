/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · middleware/auth.js · v1.0
   ─────────────────────────────────────────────────────────────────────────
   Middleware de autenticación + autorización de Numination.

   FILOSOFÍA:
     · Un solo lugar para auth. Sin duplicación.
     · Cache agresivo con TTL para no martillar Supabase.
     · Errores tipados para que el frontend sepa qué hacer.
     · Graceful degradation si el backend de auth cae.
     · Log de intentos sospechosos para seguridad.

   API PÚBLICA:

     Middlewares Express:
       attachUser              → adjunta req.user si hay sesión, no bloquea
       requireAuth             → bloquea si no hay sesión válida
       optionalAuth            → alias de attachUser
       requireAdmin            → requiere rol admin
       requireRole(...roles)   → requiere uno de esos roles
       requirePlan(...plans)   → requiere plan free/pro/team
       requireScope(...scopes) → requiere scopes específicos
       requireVerifiedEmail    → requiere email verificado
       requireNotBanned        → bloquea suspendidos
       requireApiKey           → auth por API key
       protect({...})          → middleware compuesto
       verifyWebhookSignature  → valida HMAC de webhooks entrantes

     Utilidades:
       currentUser()           → user del AsyncLocalStorage actual
       currentContext()        → contexto completo del request
       invalidateSession(id)   → fuerza logout inmediato
       invalidateProfile(id)   → invalida cache de perfil
       verifyToken(token)      → verifica un token manualmente
       issueApiKey(userId)     → genera API key + hash
       AUTH.test()             → corre 15 tests

   USO BÁSICO:

     import { requireAuth, requireAdmin, attachUser } from './middleware/auth.js';

     // Endpoint público con user opcional
     app.get('/api/public', attachUser, handler);

     // Endpoint privado
     app.post('/api/chat', requireAuth, handler);

     // Endpoint de admin
     app.get('/api/admin/users', requireAuth, requireAdmin, handler);

     // Endpoint premium
     app.post('/api/ai/advanced', requireAuth, requirePlan('pro', 'team'), handler);
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import jwt from 'jsonwebtoken';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = {
  // Cookie
  cookieName: process.env.SESSION_COOKIE || 'nm-session',
  cookieSecret: process.env.SESSION_SECRET || '',

  // Headers
  authHeader: 'authorization',
  apiKeyHeader: 'x-api-key',
  impersonateHeader: 'x-impersonate-id',
  customTokenHeader: 'x-nm-token',

  // Query (para SSE)
  queryTokenKey: 'token',
  allowQueryToken: process.env.AUTH_ALLOW_QUERY_TOKEN !== 'false',

  // Cache
  cache: {
    sessions: {
      ttlMs: 30_000,           // 30s — logout se propaga en 30s
      maxEntries: 500,
    },
    profiles: {
      ttlMs: 60_000,           // 60s
      maxEntries: 500,
    },
    invalidTokens: {
      ttlMs: 60_000,           // 60s — previene brute-force
      maxEntries: 1000,
    },
  },

  // Circuit breaker para Supabase
  circuit: {
    failureThreshold: 5,
    resetAfterMs: 30_000,
  },

  // Fingerprint
  fingerprint: {
    enabled: process.env.AUTH_FINGERPRINT !== 'false',
    strict: process.env.AUTH_FINGERPRINT_STRICT === 'true',
    // Header user-agent se hashea con salt
    salt: process.env.AUTH_FP_SALT || 'numination-fp-v1',
  },

  // Rate limit de intentos fallidos
  failedAuth: {
    threshold: 5,              // 5 fallos → bloqueo temporal
    windowMs: 60_000,          // en 60s
    blockMs: 300_000,          // bloqueado por 5 min
  },

  // Timeouts
  verifyTimeoutMs: 8000,

  // Roles válidos
  roles: ['admin', 'teacher', 'student', 'user'],

  // Planes válidos
  plans: ['free', 'pro', 'team'],

  // Log
  logLevel: process.env.LOG_LEVEL || 'info',
};

/* ═══════════════════════════════════════════════════════════════════════════
   02 · LOGGER
   ═══════════════════════════════════════════════════════════════════════════ */

const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const CUR_LEVEL = LOG_LEVELS[CFG.logLevel] ?? LOG_LEVELS.info;

const LOG = {
  error: (...a) => CUR_LEVEL >= 1 && console.error ('[auth]', ...a),
  warn:  (...a) => CUR_LEVEL >= 2 && console.warn  ('[auth]', ...a),
  info:  (...a) => CUR_LEVEL >= 3 && console.log   ('[auth]', ...a),
  debug: (...a) => CUR_LEVEL >= 4 && console.log   ('[auth]', ...a),
};

/* ═══════════════════════════════════════════════════════════════════════════
   03 · ERRORES TIPADOS
   ═══════════════════════════════════════════════════════════════════════════ */

class AuthError extends Error {
  constructor(code, message, statusCode = 401, extra = {}) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
    this.statusCode = statusCode;
    Object.assign(this, extra);
  }
}

const ERR = {
  NO_TOKEN:          'AUTH_NO_TOKEN',
  INVALID_TOKEN:     'AUTH_INVALID_TOKEN',
  EXPIRED_TOKEN:     'AUTH_EXPIRED_TOKEN',
  SESSION_REVOKED:   'AUTH_SESSION_REVOKED',
  BANNED:            'AUTH_BANNED',
  SUSPENDED:         'AUTH_SUSPENDED',
  EMAIL_UNVERIFIED:  'AUTH_EMAIL_UNVERIFIED',
  INSUFFICIENT_ROLE: 'AUTH_ROLE_INSUFFICIENT',
  INSUFFICIENT_PLAN: 'AUTH_PLAN_INSUFFICIENT',
  MISSING_SCOPE:     'AUTH_MISSING_SCOPE',
  IMPERSONATE_DENIED:'AUTH_IMPERSONATE_DENIED',
  BACKEND_DOWN:      'AUTH_BACKEND_DOWN',
  RATE_LIMITED:      'AUTH_RATE_LIMITED',
  FINGERPRINT_MISMATCH:'AUTH_FP_MISMATCH',
  API_KEY_INVALID:   'AUTH_API_KEY_INVALID',
  WEBHOOK_INVALID:   'AUTH_WEBHOOK_INVALID',
};

/* ═══════════════════════════════════════════════════════════════════════════
   04 · ASYNC CONTEXT
   ═══════════════════════════════════════════════════════════════════════════ */

const asyncCtx = new AsyncLocalStorage();

/**
 * Devuelve el usuario del contexto actual.
 * Útil para logger, analytics, tools, etc. sin prop drilling.
 */
export function currentUser() {
  return asyncCtx.getStore()?.user || null;
}

/**
 * Devuelve el contexto completo del request.
 */
export function currentContext() {
  return asyncCtx.getStore() || null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · LRU CACHE
   ═══════════════════════════════════════════════════════════════════════════ */

class LRUCache {
  constructor(maxSize) {
    this.max = maxSize;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return null;
    const e = this.map.get(key);
    if (e.expiresAt < Date.now()) {
      this.map.delete(key);
      return null;
    }
    // Move to end (LRU)
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key, value, ttlMs) {
    if (this.map.size >= this.max) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  delete(key) { return this.map.delete(key); }
  has(key) { return this.get(key) !== null; }
  clear() { this.map.clear(); }
  size() { return this.map.size; }
}

const sessionCache = new LRUCache(CFG.cache.sessions.maxEntries);
const profileCache = new LRUCache(CFG.cache.profiles.maxEntries);
const invalidTokenCache = new LRUCache(CFG.cache.invalidTokens.maxEntries);

/* ═══════════════════════════════════════════════════════════════════════════
   06 · CIRCUIT BREAKER · Supabase down detection
   ═══════════════════════════════════════════════════════════════════════════ */

const circuit = {
  failures: 0,
  openedAt: 0,
};

function circuitCheck() {
  if (circuit.failures < CFG.circuit.failureThreshold) return { ok: true };
  const elapsed = Date.now() - circuit.openedAt;
  if (elapsed > CFG.circuit.resetAfterMs) {
    circuit.failures = 0;
    return { ok: true };
  }
  return { ok: false, retryAfterMs: CFG.circuit.resetAfterMs - elapsed };
}

function circuitSuccess() {
  circuit.failures = 0;
}

function circuitFail() {
  circuit.failures++;
  if (circuit.failures >= CFG.circuit.failureThreshold) {
    circuit.openedAt = Date.now();
    LOG.warn('circuit breaker abierto · Supabase parece caído');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   07 · RATE LIMITER de intentos fallidos
   ═══════════════════════════════════════════════════════════════════════════ */

const failedAttempts = new Map(); // ip -> { count, firstAt, blockedUntil }

function checkFailedRate(ip) {
  const now = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry) return { ok: true };
  if (entry.blockedUntil > now) {
    return {
      ok: false,
      retryAfterMs: entry.blockedUntil - now,
    };
  }
  if (now - entry.firstAt > CFG.failedAuth.windowMs) {
    failedAttempts.delete(ip);
    return { ok: true };
  }
  return { ok: true };
}

function recordFailed(ip) {
  const now = Date.now();
  let e = failedAttempts.get(ip);
  if (!e || now - e.firstAt > CFG.failedAuth.windowMs) {
    e = { count: 0, firstAt: now, blockedUntil: 0 };
  }
  e.count++;
  if (e.count >= CFG.failedAuth.threshold) {
    e.blockedUntil = now + CFG.failedAuth.blockMs;
    LOG.warn('IP bloqueada por intentos fallidos:', ip, '·', e.count);
  }
  failedAttempts.set(ip, e);
}

function clearFailed(ip) {
  failedAttempts.delete(ip);
}

// Cleanup cada 10 min
const _cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of failedAttempts) {
    if (now - e.firstAt > CFG.failedAuth.windowMs && e.blockedUntil < now) {
      failedAttempts.delete(ip);
    }
  }
}, 10 * 60_000);
if (_cleanupTimer.unref) _cleanupTimer.unref();

/* ═══════════════════════════════════════════════════════════════════════════
   08 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function shortToken(token) {
  if (!token) return '';
  const t = String(token);
  if (t.length < 16) return '[token]';
  return t.slice(0, 8) + '…' + t.slice(-4);
}

function clientIP(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function safeTimingCompare(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) return false;
  try {
    return crypto.timingSafeEqual(aBuf, bBuf);
  } catch {
    return false;
  }
}

/**
 * Fingerprint de sesión: hash del user-agent + salt.
 * Detecta si el token se usa desde otro dispositivo.
 */
function fingerprint(req) {
  if (!CFG.fingerprint.enabled) return null;
  const ua = req.headers['user-agent'] || '';
  return crypto
    .createHash('sha256')
    .update(ua + '|' + CFG.fingerprint.salt)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Construye un user estandarizado con TODOS los campos que el resto
 * del código espera ver.
 */
function normalizeUser(rawUser, profile = null) {
  if (!rawUser) return null;
  const p = profile || {};
  return {
    id: rawUser.id || p.id,
    email: rawUser.email || p.email || null,
    name: p.name || rawUser.user_metadata?.full_name || rawUser.user_metadata?.name || null,
    picture: p.picture || p.avatar_url || rawUser.user_metadata?.avatar_url || null,
    role: p.role || rawUser.role || 'student',
    plan: p.plan || 'free',
    verified: !!(rawUser.email_confirmed_at || rawUser.confirmed_at || p.email_verified),
    banned: !!p.banned,
    suspended: !!p.suspended_until && new Date(p.suspended_until) > new Date(),
    suspended_until: p.suspended_until || null,
    scopes: Array.isArray(p.scopes) ? p.scopes : [],
    meta: {
      created_at: rawUser.created_at,
      last_sign_in: rawUser.last_sign_in_at,
      provider: rawUser.app_metadata?.provider || 'email',
      raw_profile: p,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   09 · SUPABASE CLIENT · import defensivo
   ═══════════════════════════════════════════════════════════════════════════ */

let _supabaseClient = null;
let _supabaseLoadError = null;

async function getSupabaseClient() {
  if (_supabaseClient) return _supabaseClient;
  if (_supabaseLoadError) return null;

  // 1) Intentar importar el cliente existente de services/supabase.js
  try {
    const mod = await import('../services/supabase.js');
    if (mod.supabase) {
      _supabaseClient = mod.supabase;
      LOG.debug('supabase client: from services/supabase.js');
      return _supabaseClient;
    }
  } catch (e) {
    LOG.debug('services/supabase.js no expone supabase:', e.message);
  }

  // 2) Fallback: crear cliente propio con @supabase/supabase-js
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      _supabaseLoadError = new Error('SUPABASE_URL y SUPABASE_SERVICE_KEY requeridos');
      LOG.error(_supabaseLoadError.message);
      return null;
    }
    _supabaseClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    LOG.info('supabase client: new instance');
    return _supabaseClient;
  } catch (e) {
    _supabaseLoadError = e;
    LOG.error('no pude crear cliente Supabase:', e.message);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · VERIFICACIÓN DE TOKEN
   ═══════════════════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────────────────
   Secretos aceptados para verificar la firma (server-side only).
   El token lo firma src/auth.js con JWT_SECRET (o TEST_KEYS.JWT_SECRET).
   ───────────────────────────────────────────────────────────────────────── */

let _fileKeys = {};
try {
  const mod = await import('../../env.local.js');
  _fileKeys = mod.TEST_KEYS ?? {};
} catch { /* opcional */ }

const SESSION_SECRETS = [...new Set([
  process.env.JWT_SECRET,
  process.env.SESSION_SECRET,
  process.env.SUPABASE_JWT_SECRET,
  _fileKeys.JWT_SECRET,
].filter((s) => typeof s === 'string' && s.trim().length >= 16))];

const JWT_ALGS = ['HS256', 'HS384', 'HS512'];

/**
 * Verifica un token de sesión.
 * FIX-NUM-2026 · Antes solo decodificaba el payload (Buffer.from(base64))
 * sin comprobar la firma, y si el token era opaco devolvía un usuario
 * admin falso. Ahora:
 *   · la firma HMAC se verifica de verdad contra los secrets del server
 *   · exp / nbf los valida jsonwebtoken
 *   · token opaco o firma inválida → AuthError (nunca usuario)
 */
async function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.length < 5) {
    throw new AuthError(ERR.INVALID_TOKEN, 'Token vacío');
  }

  const hash = hashToken(token);

  // Cache positivo
  const cached = sessionCache.get(hash);
  if (cached) return { user: cached.user, fingerprint: null, fromCache: true };

  // Cache negativo (evita recalcular firmas inválidas)
  if (invalidTokenCache.get(hash)) {
    throw new AuthError(ERR.INVALID_TOKEN, 'Token inválido');
  }

  const parts = String(token).split('.');
  if (parts.length !== 3) {
    invalidTokenCache.set(hash, true, CFG.cache.invalidTokens.ttlMs);
    throw new AuthError(ERR.INVALID_TOKEN, 'Formato de token inválido');
  }

  // Verificación criptográfica de la firma
  let payload = null;
  let lastErr = null;
  for (const secret of SESSION_SECRETS) {
    try {
      payload = jwt.verify(token, secret, { algorithms: JWT_ALGS, clockTolerance: 60 });
      break;
    } catch (e) {
      lastErr = e;
      if (e.name === 'TokenExpiredError') break; // firma OK pero expirado
    }
  }

  if (!payload || !payload.sub) {
    invalidTokenCache.set(hash, true, CFG.cache.invalidTokens.ttlMs);
    const code = lastErr?.name === 'TokenExpiredError' ? ERR.EXPIRED_TOKEN : ERR.INVALID_TOKEN;
    throw new AuthError(code, 'Sesión inválida o expirada');
  }

  // HIGH-001 · denylist server-side: un jti revocado (logout) invalida
  // el JWT aunque la firma sea válida y no haya expirado.
  // Sin DB → fail-open (igual que loadProfile): se loguea y se sigue.
  if (payload.jti) {
    try {
      const { isSessionRevoked } = await import('../services/supabase.js');
      if (await isSessionRevoked(payload.jti)) {
        invalidTokenCache.set(hash, true, CFG.cache.invalidTokens.ttlMs);
        throw new AuthError(ERR.SESSION_REVOKED, 'Sesión revocada. Volvé a iniciar sesión.');
      }
    } catch (e) {
      if (e instanceof AuthError) throw e;
      LOG.warn('revocation check falló (fail-open):', e.message);
    }
  }

  const user = {
    id: String(payload.sub),
    email: payload.email || null,
    role: CFG.roles.includes(String(payload.role || '').toLowerCase())
      ? String(payload.role).toLowerCase()
      : 'student',
    plan: 'free',
    ver: Number(payload.ver || 1),
    user_metadata: payload.user_metadata || {},
    app_metadata: {},
    created_at: payload.iat ? new Date(payload.iat * 1000).toISOString() : new Date().toISOString(),
    email_confirmed_at: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
    _jwt: true,
  };

  LOG.info('JWT verificado', { userId: user.id.slice(0, 8), email: user.email });
  sessionCache.set(hash, { user, fingerprint: null }, CFG.cache.sessions.ttlMs);
  return { user, fingerprint: null, fromCache: false };
}

async function loadProfile(userId) {
  if (!userId) return null;

  const cached = profileCache.get(userId);
  if (cached) return cached;

  const supabase = await getSupabaseClient();
  if (!supabase) return null;

  try {
    const { data, error } = await Promise.race([
      supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('PROFILE_TIMEOUT')), 5000)
      ),
    ]);
    if (error || !data) return null;
    profileCache.set(userId, data, CFG.cache.profiles.ttlMs);
    return data;
  } catch (e) {
    LOG.debug('loadProfile failed:', e.message);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   11 · EXTRACCIÓN DE TOKEN · multi-source
   ═══════════════════════════════════════════════════════════════════════════ */

function extractToken(req) {
  const candidates = [];

  // 1) Cookie
  if (req.cookies && req.cookies[CFG.cookieName]) {
    candidates.push({ source: 'cookie', value: req.cookies[CFG.cookieName] });
  }

  // 2) Authorization: Bearer <token>
  const auth = req.headers[CFG.authHeader];
  if (auth) {
    const m = String(auth).match(/^Bearer\s+(.+)$/i);
    if (m) candidates.push({ source: 'bearer', value: m[1].trim() });
  }

  // 3) Custom header
  const custom = req.headers[CFG.customTokenHeader];
  if (custom) candidates.push({ source: 'header', value: String(custom).trim() });

  // 4) Query param (para SSE)
  if (CFG.allowQueryToken && req.query && req.query[CFG.queryTokenKey]) {
    candidates.push({ source: 'query', value: String(req.query[CFG.queryTokenKey]).trim() });
  }

  // Devolver el primero no vacío
  for (const c of candidates) {
    if (c.value && c.value.length > 20) return c;
  }
  return null;
}

function extractApiKey(req) {
  const key = req.headers[CFG.apiKeyHeader];
  if (!key) return null;
  return String(key).trim();
}

/* ═══════════════════════════════════════════════════════════════════════════
   12 · RESPUESTAS DE ERROR
   ═══════════════════════════════════════════════════════════════════════════ */

function sendAuthError(res, err, req) {
  const body = {
    ok: false,
    error: err.message,
    code: err.code,
  };
  if (err.retryAfterMs) {
    body.retryAfterMs = err.retryAfterMs;
    res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
  }

  LOG.debug('auth error:', err.code, req?.path || '', '·', err.message);
  return res.status(err.statusCode || 401).json(body);
}

/* ═══════════════════════════════════════════════════════════════════════════
   13 · ATTACH USER · middleware opcional
   ═══════════════════════════════════════════════════════════════════════════ */

export async function attachUser(req, res, next) {
  // Si ya hay user (por otro middleware), saltar
  if (req.user) return next();

  try {
    const extracted = extractToken(req);

    if (!extracted) {
      // Sin token → anónimo (NO error: hay rutas públicas)
      req.user = null;
      req.userId = null;
      req.authSource = 'anon';
      return asyncCtx.run({ req, user: null }, () => next());
    }

    const { user: rawUser, fromCache } = await verifyToken(extracted.value);
    const profile = await loadProfile(rawUser.id);
    const user = normalizeUser(rawUser, profile);

    // HIGH-001 · logout-all: si la DB tiene auth_version mayor que el
    // `ver` firmado en el JWT, todas las sesiones viejas están revocadas.
    const tokenVer = Number(rawUser?.ver || 1);
    const dbVer = profile ? Number(profile.auth_version ?? tokenVer) : tokenVer;
    if (profile && dbVer > tokenVer) {
      sessionCache.delete(hashToken(extracted.value));
      throw new AuthError(ERR.SESSION_REVOKED, 'Sesión revocada. Volvé a iniciar sesión.');
    }

    const fp = fingerprint(req);

    // Fingerprint estricto (opt-in)
    if (fp && CFG.fingerprint.strict) {
      const expectedFP = sessionCache.get(hashToken(extracted.value))?.fingerprint;
      if (expectedFP && expectedFP !== fp) {
        LOG.warn('fingerprint mismatch:', shortToken(extracted.value), '· IP', clientIP(req));
        sessionCache.delete(hashToken(extracted.value));
        throw new AuthError(ERR.FINGERPRINT_MISMATCH, 'Sesión usada desde otro dispositivo');
      }
    }

    // banned / suspended → no se corta la navegación pública, requireAuth responde
    if (user.banned) {
      req.user = null;
      req.userId = null;
      req.authSource = 'banned';
      req.authError = { code: ERR.BANNED, message: 'Tu cuenta está suspendida permanentemente', statusCode: 403 };
      return asyncCtx.run({ req, user: null }, () => next());
    }
    if (user.suspended) {
      req.user = null;
      req.userId = null;
      req.authSource = 'suspended';
      req.authError = { code: ERR.SUSPENDED, message: 'Tu cuenta está suspendida hasta ' + user.suspended_until, statusCode: 403 };
      return asyncCtx.run({ req, user: null }, () => next());
    }

    sessionCache.set(hashToken(extracted.value), { user, fingerprint: fp }, CFG.cache.sessions.ttlMs);

    // Impersonación (solo admin, y solo con sesión REAL verificada)
    const impersonateId = req.headers[CFG.impersonateHeader];
    if (impersonateId && user.role === 'admin') {
      const impProfile = await loadProfile(String(impersonateId));
      if (!impProfile) {
        throw new AuthError(ERR.IMPERSONATE_DENIED, 'Usuario a impersonar no encontrado', 404);
      }
      req.realUser = user;
      req.user = normalizeUser({ id: impProfile.id, email: impProfile.email }, impProfile);
      req.userId = req.user.id;
      req.authSource = 'impersonate';
      LOG.info('impersonate:', user.id.slice(0, 8), '→', req.userId.slice(0, 8));
    } else {
      req.user = user;
      req.userId = user.id;
      req.authSource = extracted.source;
    }

    req.session = {
      fromCache,
      fingerprint: fp,
      tokenHash: hashToken(extracted.value).slice(0, 16),
    };

    return asyncCtx.run({ req, user: req.user, realUser: req.realUser }, () => next());
  } catch (err) {
    if (err instanceof AuthError) {
      LOG.warn('token rechazado:', err.code, '·', req.path || '');
      req.user = null;
      req.userId = null;
      req.authSource = 'invalid';
      req.authError = {
        code: err.code,
        message: err.message,
        statusCode: err.statusCode || 401,
      };
      return asyncCtx.run({ req, user: null }, () => next());
    }
    LOG.error('attachUser unexpected:', err);
    req.user = null;
    req.userId = null;
    req.authSource = 'error';
    req.authError = { code: ERR.BACKEND_DOWN, message: 'Error de autenticación', statusCode: 500 };
    return asyncCtx.run({ req, user: null }, () => next());
  }
}

export const optionalAuth = attachUser;

/* ═══════════════════════════════════════════════════════════════════════════
   14 · REQUIRE AUTH · middleware estricto
   ═══════════════════════════════════════════════════════════════════════════ */

export function requireAuth(req, res, next) {
  if (req.user && req.userId) return next();

  attachUser(req, res, () => {
    if (!req.user || !req.userId) {
      const e = req.authError || {};
      return sendAuthError(
        res,
        new AuthError(
          e.code || ERR.NO_TOKEN,
          e.message || 'No autenticado',
          e.statusCode || 401
        ),
        req
      );
    }
    next();
  });
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return sendAuthError(res, new AuthError(
        ERR.INSUFFICIENT_ROLE,
        'Se requiere rol admin',
        403
      ), req);
    }
    next();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   16 · REQUIRE ROLE · múltiples roles
   ═══════════════════════════════════════════════════════════════════════════ */

export function requireRole(...roles) {
  const allowed = roles.flat().filter(Boolean);
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (!allowed.includes(req.user.role)) {
        return sendAuthError(res, new AuthError(
          ERR.INSUFFICIENT_ROLE,
          `Se requiere uno de: ${allowed.join(', ')}`,
          403,
          { requiredRoles: allowed, userRole: req.user.role }
        ), req);
      }
      next();
    });
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   17 · REQUIRE PLAN · para features premium
   ═══════════════════════════════════════════════════════════════════════════ */

export function requirePlan(...plans) {
  const allowed = plans.flat().filter(Boolean);
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (!allowed.includes(req.user.plan)) {
        return sendAuthError(res, new AuthError(
          ERR.INSUFFICIENT_PLAN,
          `Requiere plan: ${allowed.join(' o ')}`,
          402,   // Payment Required
          { requiredPlans: allowed, userPlan: req.user.plan }
        ), req);
      }
      next();
    });
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   18 · REQUIRE SCOPE · permisos granulares
   ═══════════════════════════════════════════════════════════════════════════ */

export function requireScope(...scopes) {
  const needed = scopes.flat().filter(Boolean);
  return (req, res, next) => {
    requireAuth(req, res, () => {
      const userScopes = req.user.scopes || [];
      // Admin tiene todos los scopes
      if (req.user.role === 'admin') return next();

      const missing = needed.filter(s => !userScopes.includes(s));
      if (missing.length > 0) {
        return sendAuthError(res, new AuthError(
          ERR.MISSING_SCOPE,
          `Faltan permisos: ${missing.join(', ')}`,
          403,
          { missingScopes: missing, requiredScopes: needed }
        ), req);
      }
      next();
    });
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   19 · REQUIRE VERIFIED EMAIL
   ═══════════════════════════════════════════════════════════════════════════ */

export function requireVerifiedEmail(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.verified) {
      return sendAuthError(res, new AuthError(
        ERR.EMAIL_UNVERIFIED,
        'Verificá tu email para continuar',
        403
      ), req);
    }
    next();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   20 · REQUIRE NOT BANNED · explícito
   ═══════════════════════════════════════════════════════════════════════════ */

export function requireNotBanned(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.banned || req.user.suspended) {
      return sendAuthError(res, new AuthError(
        req.user.banned ? ERR.BANNED : ERR.SUSPENDED,
        req.user.banned ? 'Cuenta suspendida' : 'Cuenta temporalmente suspendida',
        403
      ), req);
    }
    next();
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   21 · API KEY AUTH
   ═══════════════════════════════════════════════════════════════════════════ */

export async function requireApiKey(req, res, next) {
  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return sendAuthError(res, new AuthError(
      ERR.API_KEY_INVALID,
      'API key requerida'
    ), req);
  }

  const supabase = await getSupabaseClient();
  if (!supabase) {
    return sendAuthError(res, new AuthError(
      ERR.BACKEND_DOWN,
      'Auth backend no disponible',
      503
    ), req);
  }

  const keyHash = hashToken(apiKey);

  try {
    const { data, error } = await supabase
      .from('api_keys')
      .select('id, user_id, name, scopes, last_used_at, revoked_at')
      .eq('key_hash', keyHash)
      .maybeSingle();

    if (error || !data) {
      return sendAuthError(res, new AuthError(
        ERR.API_KEY_INVALID,
        'API key inválida'
      ), req);
    }

    if (data.revoked_at) {
      return sendAuthError(res, new AuthError(
        ERR.API_KEY_INVALID,
        'API key revocada'
      ), req);
    }

    // Cargar el user
    const profile = await loadProfile(data.user_id);
    if (!profile) {
      return sendAuthError(res, new AuthError(
        ERR.API_KEY_INVALID,
        'Usuario de API key no encontrado'
      ), req);
    }

    req.user = normalizeUser({ id: data.user_id, email: profile.email }, profile);
    req.user.scopes = data.scopes || [];
    req.userId = data.user_id;
    req.authSource = 'api_key';

    // Actualizar last_used_at (fire and forget)
    supabase
      .from('api_keys')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id)
      .then(() => {})
      .catch(() => {});

    return asyncCtx.run({ req, user: req.user }, () => next());
  } catch (e) {
    LOG.error('requireApiKey:', e);
    return res.status(500).json({ ok: false, error: 'Error de autenticación' });
  }
}

/**
 * Genera una nueva API key y su hash.
 * Devuelve { key, hash, preview } — el `key` solo se muestra UNA vez.
 */
export function issueApiKey() {
  const key = 'nm_' + crypto.randomBytes(32).toString('base64url');
  const hash = hashToken(key);
  const preview = key.slice(0, 8) + '…' + key.slice(-4);
  return { key, hash, preview };
}

/* ═══════════════════════════════════════════════════════════════════════════
   22 · WEBHOOK SIGNATURE VERIFICATION
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Verifica la firma HMAC-SHA256 de un webhook entrante.
 * Uso:
 *   app.post('/api/webhooks/stripe',
 *     verifyWebhookSignature({ secret: process.env.STRIPE_WEBHOOK_SECRET }),
 *     handler
 *   );
 *
 * El cliente debe mandar el header `X-Signature: sha256=<hex>` con HMAC del body.
 */
export function verifyWebhookSignature(opts = {}) {
  const { secret, header = 'x-signature', algorithm = 'sha256' } = opts;
  if (!secret) throw new Error('webhook secret requerido');

  return (req, res, next) => {
    const signature = req.headers[header];
    if (!signature) {
      return sendAuthError(res, new AuthError(
        ERR.WEBHOOK_INVALID,
        'Falta header de firma',
        401
      ), req);
    }

    const m = String(signature).match(/^(sha\d+)=(.*)$/);
    if (!m) {
      return sendAuthError(res, new AuthError(
        ERR.WEBHOOK_INVALID,
        'Formato de firma inválido'
      ), req);
    }

    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    const expected = crypto
      .createHmac(algorithm, secret)
      .update(rawBody)
      .digest('hex');

    if (!safeTimingCompare(expected, m[2])) {
      LOG.warn('webhook signature mismatch · IP', clientIP(req));
      return sendAuthError(res, new AuthError(
        ERR.WEBHOOK_INVALID,
        'Firma inválida'
      ), req);
    }

    next();
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   23 · PROTECT · middleware compuesto
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Middleware compuesto.
 *   protect({ auth: true, admin: true, plan: ['pro'], scopes: ['x:y'] })
 *
 * Aplica en orden:
 *   1. auth (attachUser / requireAuth)
 *   2. admin / roles
 *   3. plan
 *   4. scopes
 *   5. verifiedEmail
 *   6. notBanned
 */
export function protect(opts = {}) {
  const {
    auth = true,
    admin = false,
    roles = null,
    plan = null,
    scopes = null,
    verifiedEmail = false,
    notBanned = true,
  } = opts;

  const middlewares = [];

  if (auth === true) middlewares.push(requireAuth);
  else if (auth === 'optional') middlewares.push(attachUser);

  if (notBanned) middlewares.push(requireNotBanned);
  if (verifiedEmail) middlewares.push(requireVerifiedEmail);
  if (admin) middlewares.push(requireAdmin);
  if (roles && roles.length > 0) middlewares.push(requireRole(...roles));
  if (plan && plan.length > 0) middlewares.push(requirePlan(...plan));
  if (scopes && scopes.length > 0) middlewares.push(requireScope(...scopes));

  // Ejecutar en cadena
  return (req, res, next) => {
    let i = 0;
    const step = (err) => {
      if (err) return next(err);
      if (i >= middlewares.length) return next();
      const mw = middlewares[i++];
      try {
        mw(req, res, step);
      } catch (e) {
        next(e);
      }
    };
    step();
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   24 · INVALIDACIÓN DE CACHE
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Invalida inmediatamente la sesión de un usuario.
 * Llamar tras logout, cambio de password, etc.
 */
export function invalidateSession(userId) {
  if (!userId) return 0;
  let count = 0;
  // Como el cache está por hash de token, no podemos invalidar por userId
  // directo. Pero sí podemos invalidar el perfil y, si guardamos userId → token,
  // podríamos hacerlo. Como workaround, invalidamos todo el cache de sesión.
  // TODO: mantener un índice userId → tokenHash si hace falta.
  for (const [key, val] of sessionCache.map) {
    if (val.value?.user?.id === userId) {
      sessionCache.delete(key);
      count++;
    }
  }
  profileCache.delete(userId);
  LOG.debug('session invalidated for user', userId, '· entries:', count);
  return count;
}

/**
 * Invalida la cache de perfil de un usuario (tras cambiar nombre, plan, etc.)
 */
export function invalidateProfile(userId) {
  if (!userId) return false;
  return profileCache.delete(userId);
}

/**
 * HIGH-001 · Borra un token concreto de las caches de sesión.
 * Lo llama el endpoint de logout DESPUÉS de insertar el jti en la
 * denylist, para que la revocación sea inmediata en esta instancia
 * (sin esperar los 30s de TTL). Las demás instancias lo ven vía DB.
 * Devuelve true si había una entrada cacheada.
 */
export function revokeTokenCache(token) {
  if (!token || typeof token !== 'string') return false;
  const hash = hashToken(token);
  const had = sessionCache.delete(hash);
  invalidTokenCache.delete(hash);
  return had;
}

/* ═══════════════════════════════════════════════════════════════════════════
   25 · VERIFY TOKEN (público · para uso externo)
   ═══════════════════════════════════════════════════════════════════════════ */

export async function verifyRawToken(token) {
  try {
    const { user: rawUser } = await verifyToken(token);
    const profile = await loadProfile(rawUser.id);
    return normalizeUser(rawUser, profile);
  } catch (e) {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   26 · SELF TEST
   ═══════════════════════════════════════════════════════════════════════════ */

async function selfTest() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  // 1) Hash
  const h1 = hashToken('test-token');
  const h2 = hashToken('test-token');
  rec('hashToken determinista', h1 === h2 && h1.length === 64, h1.slice(0, 16));

  // 2) shortToken
  rec('shortToken truncado', shortToken('abcdefghijklmnop').includes('…'), shortToken('abcdefghijklmnop'));
  rec('shortToken corto', shortToken('abc') === '[token]', shortToken('abc'));

  // 3) safeTimingCompare
  rec('timingCompare iguales', safeTimingCompare('abc', 'abc') === true, true);
  rec('timingCompare diferentes', safeTimingCompare('abc', 'abd') === false, true);
  rec('timingCompare longitudes distintas', safeTimingCompare('abc', 'abcd') === false, true);

  // 4) normalizeUser
  const u = normalizeUser(
    { id: 'u1', email: 'a@b.com', email_confirmed_at: '2025-01-01', created_at: '2024-01-01', app_metadata: { provider: 'google' } },
    { name: 'Test', role: 'teacher', plan: 'pro' }
  );
  rec('normalizeUser tiene id', u.id === 'u1', u.id);
  rec('normalizeUser role', u.role === 'teacher', u.role);
  rec('normalizeUser plan', u.plan === 'pro', u.plan);
  rec('normalizeUser verified', u.verified === true, u.verified);

  // 5) extractToken
  const req1 = { headers: { authorization: 'Bearer xyz123456789012345678901234567890' }, cookies: {}, query: {} };
  const t1 = extractToken(req1);
  rec('extractToken bearer', t1?.source === 'bearer', t1);

  const req2 = { headers: {}, cookies: { 'nm-session': 'abcdefghij1234567890abcdefghij1234567890' }, query: {} };
  const t2 = extractToken(req2);
  rec('extractToken cookie', t2?.source === 'cookie', t2);

  const req3 = { headers: {}, cookies: {}, query: { token: 'abcdefghij1234567890abcdefghij1234567890' } };
  const t3 = extractToken(req3);
  rec('extractToken query', t3?.source === 'query', t3);

  const req4 = { headers: {}, cookies: {}, query: {} };
  rec('extractToken sin token', extractToken(req4) === null, true);

  // 6) Fingerprint
  const fp1 = fingerprint({ headers: { 'user-agent': 'Mozilla/5.0' } });
  const fp2 = fingerprint({ headers: { 'user-agent': 'Mozilla/5.0' } });
  const fp3 = fingerprint({ headers: { 'user-agent': 'Different UA' } });
  rec('fingerprint estable', fp1 === fp2 && fp1.length === 16, fp1);
  rec('fingerprint cambia con UA', fp1 !== fp3, true);

  // 7) clientIP
  const ip1 = clientIP({ headers: { 'cf-connecting-ip': '1.2.3.4' }, socket: {} });
  rec('clientIP cloudflare', ip1 === '1.2.3.4', ip1);

  const ip2 = clientIP({ headers: { 'x-forwarded-for': '5.6.7.8, 9.10.11.12' }, socket: {} });
  rec('clientIP forwarded', ip2 === '5.6.7.8', ip2);

  // 8) issueApiKey
  const { key, hash, preview } = issueApiKey();
  rec('issueApiKey key formato', key.startsWith('nm_'), key.slice(0, 8));
  rec('issueApiKey hash 64 chars', hash.length === 64, hash.length);
  rec('issueApiKey preview', preview.includes('…'), preview);

  // 9) AuthError
  const err = new AuthError(ERR.NO_TOKEN, 'test', 401, { foo: 'bar' });
  rec('AuthError código', err.code === ERR.NO_TOKEN, err.code);
  rec('AuthError statusCode', err.statusCode === 401, err.statusCode);
  rec('AuthError extra', err.foo === 'bar', err.foo);

  // 10) cache
  const cache = new LRUCache(3);
  cache.set('a', 1, 1000);
  cache.set('b', 2, 1000);
  cache.set('c', 3, 1000);
  rec('cache get', cache.get('a') === 1, cache.get('a'));
  cache.set('d', 4, 1000);
  rec('cache LRU evict', cache.get('b') === null, cache.get('b'));
  rec('cache size', cache.size() === 3, cache.size());

  // 11) currentUser sin contexto
  rec('currentUser sin ctx', currentUser() === null, true);

  // 12) protect
  const mw = protect({ auth: false });
  rec('protect devuelve función', typeof mw === 'function', true);

  // 13) requireRole
  const rr = requireRole('admin', 'teacher');
  rec('requireRole devuelve middleware', typeof rr === 'function', true);

  // 14) requirePlan
  const rp = requirePlan('pro', 'team');
  rec('requirePlan devuelve middleware', typeof rp === 'function', true);

  // 15) verifyWebhookSignature
  const vw = verifyWebhookSignature({ secret: 'test-secret' });
  rec('verifyWebhookSignature devuelve middleware', typeof vw === 'function', true);

  const passed = results.filter(r => r.ok).length;
  return {
    passed,
    total: results.length,
    ok: passed === results.length,
    results,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   27 · MÉTRICAS · para health check
   ═══════════════════════════════════════════════════════════════════════════ */

export function getAuthMetrics() {
  return {
    sessions: {
      size: sessionCache.size(),
      max: CFG.cache.sessions.maxEntries,
      ttlMs: CFG.cache.sessions.ttlMs,
    },
    profiles: {
      size: profileCache.size(),
      max: CFG.cache.profiles.maxEntries,
      ttlMs: CFG.cache.profiles.ttlMs,
    },
    invalidTokens: {
      size: invalidTokenCache.size(),
      max: CFG.cache.invalidTokens.maxEntries,
    },
    circuit: {
      failures: circuit.failures,
      opened: circuit.failures >= CFG.circuit.failureThreshold,
      openedAt: circuit.openedAt,
    },
    failedAttempts: failedAttempts.size,
    supabaseLoaded: !!_supabaseClient,
    supabaseError: _supabaseLoadError?.message || null,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   28 · SHUTDOWN
   ═══════════════════════════════════════════════════════════════════════════ */

export function shutdown() {
  sessionCache.clear();
  profileCache.clear();
  invalidTokenCache.clear();
  failedAttempts.clear();
  LOG.info('auth caches cleared');
}

/* ═══════════════════════════════════════════════════════════════════════════
   29 · CONFIGURE
   ═══════════════════════════════════════════════════════════════════════════ */

export function configure(patch) {
  if (!patch || typeof patch !== 'object') return;
  function merge(target, source) {
    for (const k of Object.keys(source)) {
      if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        merge(target[k], source[k]);
      } else {
        target[k] = source[k];
      }
    }
  }
  merge(CFG, patch);
  LOG.info('auth config updated', patch);
}

/* ═══════════════════════════════════════════════════════════════════════════
   30 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export const AUTH = {
  // Middlewares
  attachUser,
  optionalAuth,
  requireAuth,
  requireAdmin,
  requireRole,
  requirePlan,
  requireScope,
  requireVerifiedEmail,
  requireNotBanned,
  requireApiKey,
  verifyWebhookSignature,
  protect,

  // Contexto
  currentUser,
  currentContext,

  // Utils
  verifyToken: verifyRawToken,
  invalidateSession,
  invalidateProfile,
  revokeTokenCache,
  issueApiKey,

  // Config
  configure,

  // Observabilidad
  metrics: getAuthMetrics,

  // Lifecycle
  shutdown,

  // Test
  test: selfTest,

  // Internals para tests
  _config: CFG,
  _errors: ERR,
  _caches: { sessionCache, profileCache, invalidTokenCache },
};

export default AUTH;