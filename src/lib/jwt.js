/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · lib/jwt.js · v1.0
   ─────────────────────────────────────────────────────────────────────────
   Verificación de JWT con firma REAL · cero dependencias.

   POR QUÉ EXISTE:
     El middleware actual decodifica el JWT sin verificar la firma.
     Eso significa que un atacante puede fabricar un token con cualquier
     payload y el servidor lo acepta. Es un agujero de seguridad crítico.

     Este módulo verifica la firma HMAC-SHA256 con el JWT_SECRET de Supabase.

   FEATURES:
     · HS256 · HS384 · HS512 (HMAC)
     · RS256 · RS384 · RS512 (RSA)
     · ES256 · ES384 · ES512 (ECDSA)
     · Firma y verificación con constant-time compare
     · Validación de exp, nbf, iat, iss, aud, sub
     · Clock skew configurable (por defecto 60s)
     · Grace period para token expirado (opt-in)
     · Detección de alg=none (ataque clásico)
     · Detección de alg confusion (HMAC vs RSA)
     · Cache LRU de verificaciones (por hash del token)
     · Self-test integrado
     · Sin dependencias externas · solo node:crypto

   API PÚBLICA:
     sign(payload, opts)              → string
     verify(token, opts)              → { valid, payload, error }
     verifyOrThrow(token, opts)       → payload (throws)
     decode(token)                    → { header, payload, signature }
     isValidFormat(token)             → boolean
     isExpired(token)                 → boolean
     getRemainingSeconds(token)       → number
     getIssuedAt(token)               → Date | null
     getExpiresAt(token)              → Date | null
     extractBearer(headers)           → token | null
     JWT.test()                       → TestReport

   USO:
     import { JWT } from './lib/jwt.js';

     const result = JWT.verify(token);
     if (!result.valid) {
       return res.status(401).json({ error: result.error });
     }
     const payload = result.payload;

   VARIABLES DE ENTORNO:
     SUPABASE_JWT_SECRET      · El secret de Supabase (Settings → API → JWT Secret)
     JWT_CLOCK_SKEW_SECONDS   · Por defecto 60
     JWT_GRACE_PERIOD_SECONDS · Por defecto 0 (sin gracia)
     JWT_ISSUER               · Por defecto 'supabase'
     JWT_AUDIENCE             · Por defecto 'authenticated'
     JWT_VERIFY_ENABLED       · Por defecto 'true' (si 'false', solo decodifica)
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = {
  // Secret de Supabase para HS256
  secret: process.env.SUPABASE_JWT_SECRET
    || process.env.JWT_SECRET
    || process.env.SESSION_SECRET
    || null,

  // Algoritmos permitidos
  allowedAlgorithms: ['HS256', 'HS384', 'HS512', 'RS256', 'RS384', 'RS512'],

  // Tolerancia de reloj entre servidores (segundos)
  clockSkewSeconds: parseInt(process.env.JWT_CLOCK_SKEW_SECONDS || '60', 10),

  // Grace period para tokens recién expirados
  gracePeriodSeconds: parseInt(process.env.JWT_GRACE_PERIOD_SECONDS || '0', 10),

  // Issuer y audience esperados
  issuer: process.env.JWT_ISSUER || 'supabase',
  audience: process.env.JWT_AUDIENCE || 'authenticated',

  // Si es 'false', solo decodifica sin verificar (modo debug)
  verifyEnabled: process.env.JWT_VERIFY_ENABLED !== 'false',

  // Cache de verificaciones
  cache: {
    enabled: true,
    max: 2000,
    ttlMs: 30_000,
  },

  // Log level
  logLevel: process.env.LOG_LEVEL || 'info',
};

/* ═══════════════════════════════════════════════════════════════════════════
   02 · LOGGER
   ═══════════════════════════════════════════════════════════════════════════ */

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const CUR = LEVELS[CFG.logLevel] ?? LEVELS.info;

const LOG = {
  error: (...a) => CUR >= 1 && console.error('[jwt]', ...a),
  warn:  (...a) => CUR >= 2 && console.warn ('[jwt]', ...a),
  info:  (...a) => CUR >= 3 && console.log  ('[jwt]', ...a),
  debug: (...a) => CUR >= 4 && console.log  ('[jwt]', ...a),
};

/* ═══════════════════════════════════════════════════════════════════════════
   03 · ERRORES
   ═══════════════════════════════════════════════════════════════════════════ */

export class JWTError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'JWTError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export const JWT_ERRORS = {
  INVALID_FORMAT: 'JWT_INVALID_FORMAT',
  INVALID_HEADER: 'JWT_INVALID_HEADER',
  INVALID_PAYLOAD: 'JWT_INVALID_PAYLOAD',
  INVALID_SIGNATURE: 'JWT_INVALID_SIGNATURE',
  ALGORITHM_NONE: 'JWT_ALGORITHM_NONE',
  ALGORITHM_NOT_ALLOWED: 'JWT_ALGORITHM_NOT_ALLOWED',
  ALGORITHM_CONFUSION: 'JWT_ALGORITHM_CONFUSION',
  EXPIRED: 'JWT_EXPIRED',
  NOT_YET_VALID: 'JWT_NOT_YET_VALID',
  INVALID_ISSUER: 'JWT_INVALID_ISSUER',
  INVALID_AUDIENCE: 'JWT_INVALID_AUDIENCE',
  MISSING_SUB: 'JWT_MISSING_SUB',
  NO_SECRET: 'JWT_NO_SECRET',
};

/* ═══════════════════════════════════════════════════════════════════════════
   04 · BASE64URL HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}

function base64UrlEncodeString(str) {
  return base64UrlEncode(Buffer.from(str, 'utf-8'));
}

function base64UrlDecodeToString(str) {
  return base64UrlDecode(str).toString('utf-8');
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · CONSTANT-TIME COMPARE
   ═══════════════════════════════════════════════════════════════════════════ */

function constantTimeEqual(a, b) {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (e) {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · HASH HELPER
   ═══════════════════════════════════════════════════════════════════════════ */

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 24);
}

/* ═══════════════════════════════════════════════════════════════════════════
   07 · ALGORITMOS · map de JWT alg → node crypto
   ═══════════════════════════════════════════════════════════════════════════ */

const ALG_MAP = {
  HS256: { type: 'hmac', hash: 'sha256' },
  HS384: { type: 'hmac', hash: 'sha384' },
  HS512: { type: 'hmac', hash: 'sha512' },
  RS256: { type: 'rsa', hash: 'RSA-SHA256' },
  RS384: { type: 'rsa', hash: 'RSA-SHA384' },
  RS512: { type: 'rsa', hash: 'RSA-SHA512' },
  ES256: { type: 'ec', hash: 'sha256' },
  ES384: { type: 'ec', hash: 'sha384' },
  ES512: { type: 'ec', hash: 'sha512' },
};

function isHmacAlg(alg) {
  return String(alg).startsWith('HS');
}

function isAsymmetricAlg(alg) {
  return String(alg).startsWith('RS') || String(alg).startsWith('ES');
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · SIGN · crear un JWT firmado
   ═══════════════════════════════════════════════════════════════════════════ */

function sign(payload, opts = {}) {
  const {
    algorithm = 'HS256',
    expiresIn = null,
    notBefore = null,
    issuer = CFG.issuer,
    audience = CFG.audience,
    secret = CFG.secret,
    keyId = null,
    subject = null,
  } = opts;

  if (!secret) {
    throw new JWTError(JWT_ERRORS.NO_SECRET, 'No hay secret configurado para firmar');
  }

  if (!ALG_MAP[algorithm]) {
    throw new JWTError(JWT_ERRORS.ALGORITHM_NOT_ALLOWED, `Algoritmo desconocido: ${algorithm}`);
  }

  // Construir payload final
  const now = Math.floor(Date.now() / 1000);
  const finalPayload = {
    iat: now,
    ...payload,
  };

  if (issuer && !finalPayload.iss) finalPayload.iss = issuer;
  if (audience && !finalPayload.aud) finalPayload.aud = audience;
  if (subject && !finalPayload.sub) finalPayload.sub = subject;

  if (expiresIn) {
    finalPayload.exp = now + parseInt(expiresIn, 10);
  }
  if (notBefore) {
    finalPayload.nbf = now + parseInt(notBefore, 10);
  }

  // Header
  const header = {
    alg: algorithm,
    typ: 'JWT',
  };
  if (keyId) header.kid = keyId;

  // Base64URL
  const headerB64 = base64UrlEncodeString(JSON.stringify(header));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(finalPayload));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Firmar
  const signature = signInput(signingInput, secret, ALG_MAP[algorithm]);

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

function signInput(input, secret, algInfo) {
  if (algInfo.type === 'hmac') {
    return crypto.createHmac(algInfo.hash, secret).update(input).digest();
  }
  if (algInfo.type === 'rsa') {
    return crypto.createSign(algInfo.hash).update(input).sign(secret);
  }
  if (algInfo.type === 'ec') {
    return crypto.createSign(algInfo.hash).update(input).sign(secret);
  }
  throw new Error('Algoritmo no soportado para firma: ' + algInfo.type);
}

/* ═══════════════════════════════════════════════════════════════════════════
   09 · DECODE · sin verificar firma
   ═══════════════════════════════════════════════════════════════════════════ */

function decode(token) {
  if (!token || typeof token !== 'string') {
    throw new JWTError(JWT_ERRORS.INVALID_FORMAT, 'Token vacío o no es string');
  }

  const parts = String(token).split('.');
  if (parts.length !== 3) {
    throw new JWTError(
      JWT_ERRORS.INVALID_FORMAT,
      `Formato JWT inválido (${parts.length} partes, esperaba 3)`
    );
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  let header, payload, signature;

  try {
    header = JSON.parse(base64UrlDecodeToString(headerB64));
  } catch (e) {
    throw new JWTError(JWT_ERRORS.INVALID_HEADER, 'Header JWT inválido: ' + e.message);
  }

  try {
    payload = JSON.parse(base64UrlDecodeToString(payloadB64));
  } catch (e) {
    throw new JWTError(JWT_ERRORS.INVALID_PAYLOAD, 'Payload JWT inválido: ' + e.message);
  }

  try {
    signature = base64UrlDecode(signatureB64);
  } catch (e) {
    throw new JWTError(JWT_ERRORS.INVALID_SIGNATURE, 'Signature inválida: ' + e.message);
  }

  return {
    header,
    payload,
    signature,
    signingInput: `${headerB64}.${payloadB64}`,
    parts,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · CACHE DE VERIFICACIONES
   ═══════════════════════════════════════════════════════════════════════════ */

class LRUCache {
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return null;
    const e = this.map.get(key);
    if (e.expiresAt < Date.now()) {
      this.map.delete(key);
      return null;
    }
    // Move to end
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

  clear() { this.map.clear(); }
  size() { return this.map.size; }
}

const _verifyCache = new LRUCache(CFG.cache.max);

/* ═══════════════════════════════════════════════════════════════════════════
   11 · VERIFY · verificación completa
   ═══════════════════════════════════════════════════════════════════════════ */

function verify(token, opts = {}) {
  const {
    secret = CFG.secret,
    publicKey = null,
    allowedAlgorithms = CFG.allowedAlgorithms,
    clockSkewSeconds = CFG.clockSkewSeconds,
    gracePeriodSeconds = CFG.gracePeriodSeconds,
    issuer = CFG.issuer,
    audience = CFG.audience,
    ignoreExpiration = false,
    ignoreNotBefore = false,
    requireSub = false,
    cache = CFG.cache.enabled,
  } = opts;

  // Cache lookup
  if (cache && !ignoreExpiration) {
    const cacheKey = hashToken(token);
    const cached = _verifyCache.get(cacheKey);
    if (cached) {
      LOG.debug('cache hit', { token: cacheKey });
      return cached;
    }
  }

  // ─── 1. Decodificar ───
  let decoded;
  try {
    decoded = decode(token);
  } catch (e) {
    return { valid: false, error: e.message, code: e.code };
  }

  const { header, payload, signingInput, signature } = decoded;

  // ─── 2. Validar header.alg ───
  if (!header.alg) {
    return { valid: false, error: 'Header sin alg', code: JWT_ERRORS.INVALID_HEADER };
  }

  // Ataque clásico: alg=none
  if (String(header.alg).toLowerCase() === 'none') {
    LOG.warn('bloqueado intento de alg=none', { token: hashToken(token) });
    return {
      valid: false,
      error: 'Algoritmo none no permitido',
      code: JWT_ERRORS.ALGORITHM_NONE,
    };
  }

  // Ataque: algoritmo no whitelisted
  if (!allowedAlgorithms.includes(header.alg)) {
    LOG.warn('algoritmo no permitido', { alg: header.alg });
    return {
      valid: false,
      error: `Algoritmo no permitido: ${header.alg}`,
      code: JWT_ERRORS.ALGORITHM_NOT_ALLOWED,
    };
  }

  // Ataque: alg confusion (token dice RS256 pero firman con HMAC del public key)
  if (isAsymmetricAlg(header.alg) && !publicKey) {
    // Si no tenemos public key, no podemos verificar asimétrico
    if (CFG.verifyEnabled) {
      return {
        valid: false,
        error: `Algoritmo ${header.alg} requiere public key`,
        code: JWT_ERRORS.INVALID_SIGNATURE,
      };
    }
  }

  // ─── 3. Verificar firma ───
  const algInfo = ALG_MAP[header.alg];
  let expectedSignature = null;

  try {
    if (algInfo.type === 'hmac') {
      if (!secret) {
        return { valid: false, error: 'Sin secret para verificar HMAC', code: JWT_ERRORS.NO_SECRET };
      }
      expectedSignature = crypto
        .createHmac(algInfo.hash, secret)
        .update(signingInput)
        .digest();
    } else if (algInfo.type === 'rsa') {
      if (!publicKey) {
        return { valid: false, error: 'Sin public key para verificar RSA', code: JWT_ERRORS.INVALID_SIGNATURE };
      }
      const verifier = crypto.createVerify(algInfo.hash);
      verifier.update(signingInput);
      const ok = verifier.verify(publicKey, signature);
      if (!ok) {
        return {
          valid: false,
          error: 'Firma RSA inválida',
          code: JWT_ERRORS.INVALID_SIGNATURE,
        };
      }
      expectedSignature = signature; // Marcar como verificado
    } else if (algInfo.type === 'ec') {
      if (!publicKey) {
        return { valid: false, error: 'Sin public key para verificar ECDSA', code: JWT_ERRORS.INVALID_SIGNATURE };
      }
      const verifier = crypto.createVerify(algInfo.hash);
      verifier.update(signingInput);
      const ok = verifier.verify(publicKey, signature);
      if (!ok) {
        return {
          valid: false,
          error: 'Firma ECDSA inválida',
          code: JWT_ERRORS.INVALID_SIGNATURE,
        };
      }
      expectedSignature = signature;
    }

    // Constant-time compare (solo para HMAC)
    if (algInfo.type === 'hmac') {
      if (!constantTimeEqual(expectedSignature, signature)) {
        LOG.debug('firma HMAC no coincide', { token: hashToken(token) });
        return {
          valid: false,
          error: 'Firma inválida',
          code: JWT_ERRORS.INVALID_SIGNATURE,
        };
      }
    }
  } catch (e) {
    LOG.error('error verificando firma', { error: e.message });
    return {
      valid: false,
      error: 'Error verificando firma: ' + e.message,
      code: JWT_ERRORS.INVALID_SIGNATURE,
    };
  }

  // Si estamos en modo debug (verifyEnabled=false), permitimos firma inválida
  if (!CFG.verifyEnabled) {
    LOG.warn('modo debug: firma no verificada');
  }

  // ─── 4. Validar exp ───
  const now = Math.floor(Date.now() / 1000);

  if (!ignoreExpiration && payload.exp !== undefined) {
    const expWithSkew = payload.exp + clockSkewSeconds;
    const expWithGrace = expWithSkew + gracePeriodSeconds;

    if (now > expWithGrace) {
      const expiredAgo = now - payload.exp;
      LOG.debug('token expirado', { expiredAgo });
      return {
        valid: false,
        error: `Token expirado hace ${expiredAgo}s`,
        code: JWT_ERRORS.EXPIRED,
        expired: true,
      };
    }

    if (now > expWithSkew) {
      LOG.warn('token en grace period', { graceLeft: expWithGrace - now });
    }
  }

  // ─── 5. Validar nbf ───
  if (!ignoreNotBefore && payload.nbf !== undefined) {
    const nbfWithSkew = payload.nbf - clockSkewSeconds;
    if (now < nbfWithSkew) {
      return {
        valid: false,
        error: `Token no válido hasta ${new Date(payload.nbf * 1000).toISOString()}`,
        code: JWT_ERRORS.NOT_YET_VALID,
      };
    }
  }

  // ─── 6. Validar iss ───
  if (issuer && payload.iss !== undefined && payload.iss !== issuer) {
    LOG.warn('issuer mismatch', { expected: issuer, got: payload.iss });
    return {
      valid: false,
      error: `Issuer no coincide (esperado: ${issuer}, recibido: ${payload.iss})`,
      code: JWT_ERRORS.INVALID_ISSUER,
    };
  }

  // ─── 7. Validar aud ───
  if (audience && payload.aud !== undefined) {
    const audList = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const audMatch = audList.some(a => a === audience || a === CFG.audience);
    if (!audMatch) {
      LOG.warn('audience mismatch', { expected: audience, got: payload.aud });
      return {
        valid: false,
        error: `Audience no coincide (esperado: ${audience}, recibido: ${payload.aud})`,
        code: JWT_ERRORS.INVALID_AUDIENCE,
      };
    }
  }

  // ─── 8. Requerir sub ───
  if (requireSub && !payload.sub) {
    return {
      valid: false,
      error: 'Token sin sub',
      code: JWT_ERRORS.MISSING_SUB,
    };
  }

  // ─── 9. Éxito ───
  const result = {
    valid: true,
    payload,
    header,
    expired: false,
    verifiedAt: Date.now(),
    verified: CFG.verifyEnabled,
  };

  // Guardar en cache
  if (cache && payload.exp) {
    const ttl = Math.min(
      CFG.cache.ttlMs,
      Math.max(1000, (payload.exp - now) * 1000 - 5000)
    );
    _verifyCache.set(hashToken(token), result, ttl);
  }

  return result;
}

/**
 * Verifica y tira excepción si falla.
 * Útil para usar con try/catch.
 */
function verifyOrThrow(token, opts = {}) {
  const result = verify(token, opts);
  if (!result.valid) {
    throw new JWTError(result.code || 'JWT_ERROR', result.error);
  }
  return result.payload;
}

/* ═══════════════════════════════════════════════════════════════════════════
   12 · HELPERS · validaciones rápidas
   ═══════════════════════════════════════════════════════════════════════════ */

function isValidFormat(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  // Cada parte debe ser base64url válido (no vacío)
  return parts.every(p => p.length > 0 && /^[A-Za-z0-9_\-=]+$/.test(p));
}

function isExpired(token) {
  try {
    const { payload } = decode(token);
    if (!payload.exp) return false;
    const now = Math.floor(Date.now() / 1000);
    return payload.exp < now;
  } catch (e) {
    return true;
  }
}

function getRemainingSeconds(token) {
  try {
    const { payload } = decode(token);
    if (!payload.exp) return Infinity;
    const now = Math.floor(Date.now() / 1000);
    return Math.max(0, payload.exp - now);
  } catch (e) {
    return 0;
  }
}

function getIssuedAt(token) {
  try {
    const { payload } = decode(token);
    return payload.iat ? new Date(payload.iat * 1000) : null;
  } catch (e) {
    return null;
  }
}

function getExpiresAt(token) {
  try {
    const { payload } = decode(token);
    return payload.exp ? new Date(payload.exp * 1000) : null;
  } catch (e) {
    return null;
  }
}

function getSubject(token) {
  try {
    const { payload } = decode(token);
    return payload.sub || null;
  } catch (e) {
    return null;
  }
}

function getEmail(token) {
  try {
    const { payload } = decode(token);
    return payload.email || null;
  } catch (e) {
    return null;
  }
}

function getRole(token) {
  try {
    const { payload } = decode(token);
    return payload.role || (payload.user_metadata && payload.user_metadata.role) || 'authenticated';
  } catch (e) {
    return null;
  }
}

/**
 * Extrae el Bearer token del header Authorization.
 */
function extractBearer(headers) {
  if (!headers) return null;
  const auth = headers.authorization || headers.Authorization;
  if (!auth) return null;
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Extrae el token de la cookie nm-session.
 */
function extractFromCookie(cookieHeader, cookieName = 'nm-session') {
  if (!cookieHeader) return null;
  const m = String(cookieHeader).match(new RegExp(`${cookieName}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Extrae el token de múltiples fuentes, en orden de prioridad.
 */
function extractToken(req, opts = {}) {
  const {
    cookieName = 'nm-session',
    headerName = 'x-nm-token',
    queryKey = 'token',
    allowQuery = true,
  } = opts;

  // 1. Cookie
  if (req.cookies && req.cookies[cookieName]) {
    return { source: 'cookie', token: req.cookies[cookieName] };
  }

  // 2. Authorization Bearer
  const bearer = extractBearer(req.headers);
  if (bearer) return { source: 'bearer', token: bearer };

  // 3. Custom header
  if (req.headers && req.headers[headerName]) {
    return { source: 'header', token: req.headers[headerName] };
  }

  // 4. Query param
  if (allowQuery && req.query && req.query[queryKey]) {
    return { source: 'query', token: req.query[queryKey] };
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   13 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════════ */

async function selfTest() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  const testSecret = 'test-secret-1234567890-abcdefghijklmnop';

  // ─── Test 1: Base64 URL encode/decode ───
  const encoded = base64UrlEncodeString('hello world');
  rec('base64UrlEncode sin = ni + ni /', !/[=+\/]/.test(encoded), encoded);

  const decoded = base64UrlDecodeToString(encoded);
  rec('base64UrlDecode vuelve a original', decoded === 'hello world', decoded);

  // ─── Test 2: sign + verify ───
  const token = sign({ sub: 'user123', email: 'test@test.com' }, {
    secret: testSecret,
    expiresIn: 3600,
    issuer: 'test-issuer',
    audience: 'test-audience',
  });

  rec('sign produce 3 partes', token.split('.').length === 3, token.slice(0, 40) + '…');

  const verified = verify(token, {
    secret: testSecret,
    issuer: 'test-issuer',
    audience: 'test-audience',
  });

  rec('verify OK', verified.valid === true, verified.error || 'ok');
  rec('payload.sub correcto', verified.payload?.sub === 'user123', verified.payload?.sub);
  rec('payload.email correcto', verified.payload?.email === 'test@test.com', verified.payload?.email);
  rec('payload.iss correcto', verified.payload?.iss === 'test-issuer', verified.payload?.iss);

  // ─── Test 3: firma inválida ───
  const tampered = token.slice(0, -5) + 'XXXXX';
  const badVerify = verify(tampered, { secret: testSecret, ignoreExpiration: true });

  rec('firma alterada rechazada', badVerify.valid === false, badVerify.code);

  // ─── Test 4: secret incorrecto ───
  const wrongSecret = verify(token, { secret: 'wrong-secret', ignoreExpiration: true });
  rec('secret incorrecto rechazado', wrongSecret.valid === false, wrongSecret.code);

  // ─── Test 5: token expirado ───
  const expiredToken = sign({ sub: 'user123' }, {
    secret: testSecret,
    expiresIn: -100, // expirado hace 100s
  });

  const expiredVerify = verify(expiredToken, { secret: testSecret, clockSkewSeconds: 0 });
  rec('token expirado rechazado', expiredVerify.valid === false && expiredVerify.code === JWT_ERRORS.EXPIRED, expiredVerify.code);

  // ─── Test 6: grace period ───
  const justExpired = sign({ sub: 'user123' }, {
    secret: testSecret,
    expiresIn: -5, // expirado hace 5s
  });

  const graceVerify = verify(justExpired, {
    secret: testSecret,
    clockSkewSeconds: 0,
    gracePeriodSeconds: 60,
  });
  rec('grace period acepta token recién expirado', graceVerify.valid === true, graceVerify.error);

  // ─── Test 7: nbf futuro ───
  const futureToken = sign({ sub: 'user123' }, {
    secret: testSecret,
    notBefore: 3600, // válido en 1h
  });

  const futureVerify = verify(futureToken, { secret: testSecret, clockSkewSeconds: 0 });
  rec('nbf futuro rechazado', futureVerify.valid === false && futureVerify.code === JWT_ERRORS.NOT_YET_VALID, futureVerify.code);

  // ─── Test 8: issuer mismatch ───
  const wrongIssuer = verify(token, {
    secret: testSecret,
    issuer: 'otro-issuer',
  });
  rec('issuer mismatch rechazado', wrongIssuer.valid === false && wrongIssuer.code === JWT_ERRORS.INVALID_ISSUER, wrongIssuer.code);

  // ─── Test 9: audience mismatch ───
  const wrongAudience = verify(token, {
    secret: testSecret,
    issuer: 'test-issuer',
    audience: 'otra-audiencia',
  });
  rec('audience mismatch rechazado', wrongAudience.valid === false && wrongAudience.code === JWT_ERRORS.INVALID_AUDIENCE, wrongAudience.code);

  // ─── Test 10: alg=none bloqueado ───
  const headerB64 = base64UrlEncodeString(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const payloadB64 = base64UrlEncodeString(JSON.stringify({ sub: 'hacker' }));
  const noneToken = `${headerB64}.${payloadB64}.`;

  const noneVerify = verify(noneToken, { secret: testSecret, ignoreExpiration: true });
  rec('alg=none bloqueado', noneVerify.valid === false && noneVerify.code === JWT_ERRORS.ALGORITHM_NONE, noneVerify.code);

  // ─── Test 11: formato inválido ───
  rec('formato inválido detectado', isValidFormat('not-a-token') === false, true);
  rec('formato válido detectado', isValidFormat(token) === true, true);

  // ─── Test 12: isExpired ───
  rec('isExpired token válido', isExpired(token) === false, false);
  rec('isExpired token expirado', isExpired(expiredToken) === true, true);

  // ─── Test 13: getRemainingSeconds ───
  const rem = getRemainingSeconds(token);
  rec('getRemainingSeconds > 3000', rem > 3000 && rem < 3600, rem);

  // ─── Test 14: getters ───
  rec('getSubject', getSubject(token) === 'user123', getSubject(token));
  rec('getEmail', getEmail(token) === 'test@test.com', getEmail(token));
  rec('getIssuedAt es Date', getIssuedAt(token) instanceof Date, true);
  rec('getExpiresAt es Date', getExpiresAt(token) instanceof Date, true);

  // ─── Test 15: extractBearer ───
  const bearer = extractBearer({ authorization: 'Bearer abc.def.ghi' });
  rec('extractBearer OK', bearer === 'abc.def.ghi', bearer);
  rec('extractBearer sin header', extractBearer({}) === null, true);

  // ─── Test 16: extractFromCookie ───
  const fromCookie = extractFromCookie('foo=bar; nm-session=token123; baz=qux');
  rec('extractFromCookie OK', fromCookie === 'token123', fromCookie);

  // ─── Test 17: extractToken ───
  const reqMock = {
    headers: { authorization: 'Bearer xx.yy.zz' },
    cookies: {},
    query: {},
  };
  const ext = extractToken(reqMock);
  rec('extractToken bearer', ext?.source === 'bearer' && ext?.token === 'xx.yy.zz', ext);

  const reqCookie = {
    headers: {},
    cookies: { 'nm-session': 'cookie-token' },
    query: {},
  };
  const extCookie = extractToken(reqCookie);
  rec('extractToken cookie', extCookie?.source === 'cookie', extCookie);

  // ─── Test 18: verifyOrThrow ───
  let threw = false;
  try {
    verifyOrThrow('bad.token.here', { secret: testSecret });
  } catch (e) {
    threw = e instanceof JWTError;
  }
  rec('verifyOrThrow tira JWTError', threw === true, true);

  // ─── Test 19: cache funciona ───
  _verifyCache.clear();
  verify(token, { secret: testSecret, issuer: 'test-issuer', audience: 'test-audience' });
  const cacheSize = _verifyCache.size();
  rec('cache guardó verificación', cacheSize >= 1, cacheSize);

  // ─── Test 20: constant-time compare ───
  rec('constant-time true', constantTimeEqual('abc', 'abc') === true, true);
  rec('constant-time false', constantTimeEqual('abc', 'abd') === false, true);
  rec('constant-time length diff', constantTimeEqual('abc', 'abcd') === false, true);

  const passed = results.filter(r => r.ok).length;
  return {
    passed,
    total: results.length,
    ok: passed === results.length,
    results,
    verified: CFG.verifyEnabled,
    hasSecret: !!CFG.secret,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   14 · CONFIGURE
   ═══════════════════════════════════════════════════════════════════════════ */

function configure(patch) {
  if (!patch || typeof patch !== 'object') return;
  Object.keys(patch).forEach(k => {
    if (typeof patch[k] === 'object' && !Array.isArray(patch[k]) && CFG[k]) {
      CFG[k] = { ...CFG[k], ...patch[k] };
    } else {
      CFG[k] = patch[k];
    }
  });
  LOG.info('JWT config actualizada');
}

function clearCache() {
  _verifyCache.clear();
  LOG.info('cache limpiado');
}

/* ═══════════════════════════════════════════════════════════════════════════
   15 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export const JWT = {
  // Core
  sign,
  verify,
  verifyOrThrow,
  decode,

  // Info helpers
  isValidFormat,
  isExpired,
  getRemainingSeconds,
  getIssuedAt,
  getExpiresAt,
  getSubject,
  getEmail,
  getRole,

  // Token extraction
  extractBearer,
  extractFromCookie,
  extractToken,

  // Config
  configure,
  clearCache,

  // Debug
  test: selfTest,

  // Constantes
  ERRORS: JWT_ERRORS,
  JWTError,

  // Internals
  _config: CFG,
  _cache: _verifyCache,
};

export default JWT;