/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · lib/crypto.js · v1.0
   ─────────────────────────────────────────────────────────────────────────
   Criptografía de alto nivel. Cero dependencias, solo node:crypto.

   FEATURES:
     · AES-256-GCM (cifrado autenticado)
     · Envelope encryption (múltiples versiones de clave)
     · Key rotation (rota sin perder acceso a datos viejos)
     · Hashing: SHA-256, SHA-512, BLAKE2b
     · HMAC: firmar/verificar
     · Password hashing: scrypt con salt + timing-safe
     · Key derivation: HKDF, PBKDF2
     · Tokens firmados compactos (formato JWT-like)
     · Generación de secretos criptográficamente seguros
     · Encoding: base64, base64url, hex
     · Comparación en tiempo constante
     · Redacción de PII/secrets
     · Self-test integrado

   API PÚBLICA:

     Cifrado:
       encrypt(plaintext, opts)          → { ciphertext, iv, tag, version }
       decrypt(envelope, opts)           → string
       encryptJSON(obj, opts)            → string (base64url compacto)
       decryptJSON(str, opts)            → obj
       encryptObject(obj)                → string
       decryptObject(str)                → obj

     Hashing:
       hash(data, algo)                  → hex string
       sha256(data)                      → hex
       sha512(data)                      → hex
       blake2b(data, size)               → hex

     HMAC:
       hmac(data, secret, algo)          → hex
       sign(data, secret)                → string firmado
       verify(data, signature, secret)   → boolean

     Passwords:
       hashPassword(password)            → string (formato PHC-like)
       verifyPassword(password, hash)    → boolean
       needsRehash(hash)                 → boolean

     KDF:
       hkdf(input, salt, info, length)   → Buffer
       pbkdf2(password, salt, opts)      → Buffer

     Tokens:
       signToken(payload, secret, opts)  → string
       verifyToken(token, secret)        → payload
       decodeToken(token)                → { header, payload, signature }

     Random:
       randomBytes(n)                    → Buffer
       randomHex(n)                      → string hex
       randomBase64(n)                   → string
       randomBase64Url(n)                → string
       randomUUID()                      → string
       randomToken(bytes)                → string URL-safe
       randomPassword(length)            → string

     Utilidades:
       encode(str, format)               → string
       decode(str, format)               → string
       base64url(input)                  → string
       fromBase64url(input)              → Buffer
       timingSafeEqual(a, b)             → boolean
       redact(data, keys)                → objeto redactado

   USO:
     import { crypto } from './lib/crypto.js';

     const secret = crypto.randomToken(32);
     const envelope = crypto.encrypt('mensaje secreto', { key: secret });
     const plain = crypto.decrypt(envelope, { key: secret });

     const hash = await crypto.hashPassword('mi_password_123');
     const ok = await crypto.verifyPassword('mi_password_123', hash);
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { createLogger } from './logger.js';

const log = createLogger('crypto');

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = {
  // Algoritmo de cifrado por defecto
  algorithm: 'aes-256-gcm',

  // Tamaño de la clave maestra en bytes (32 = 256 bits)
  keyLength: 32,

  // Tamaño del IV (12 bytes recomendado para GCM)
  ivLength: 12,

  // Tamaño del tag de autenticación (16 bytes = 128 bits)
  tagLength: 16,

  // Algoritmo de hash por defecto
  hashAlgorithm: 'sha256',

  // Parámetros de scrypt para passwords
  password: {
    algorithm: 'scrypt',
    N: 16384,        // cost (2^14)
    r: 8,            // block size
    p: 1,            // parallelization
    keyLen: 64,      // longitud de la clave derivada
    saltLen: 16,     // bytes del salt
    maxmem: 64 * 1024 * 1024, // 64MB
  },

  // Formato de tokens
  token: {
    version: 'v1',
    defaultTTL: 24 * 60 * 60, // 24 horas en segundos
  },

  // Log
  logLevel: process.env.LOG_LEVEL || 'info',
};

/* ═══════════════════════════════════════════════════════════════════════════
   02 · GESTIÓN DE CLAVES MAESTRAS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Cache de claves derivadas de las env vars.
 * Formato esperado: ENCRYPTION_KEY_V1=<32 bytes en hex>
 *                   ENCRYPTION_KEY_V2=<32 bytes en hex>
 *                   ENCRYPTION_KEY_CURRENT=v2
 */
const keyStore = new Map();
let currentKeyVersion = null;

function loadKeysFromEnv() {
  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^ENCRYPTION_KEY_(V\d+)$/);
    if (!match) continue;

    const version = match[1].toLowerCase(); // "v1", "v2"
    if (!value || value.length < 32) {
      log.warn(`env var ${key} muy corta, ignorando`);
      continue;
    }

    try {
      const buf = Buffer.from(value, 'hex');
      if (buf.length !== CFG.keyLength) {
        log.warn(`${key} no es de ${CFG.keyLength} bytes, ignorando`);
        continue;
      }
      keyStore.set(version, buf);
    } catch (e) {
      log.warn(`${key} no es hex válido`);
    }
  }

  // Detectar la clave actual
  currentKeyVersion = process.env.ENCRYPTION_KEY_CURRENT || null;

  // Si no se especifica current, usar la más alta
  if (!currentKeyVersion && keyStore.size > 0) {
    const versions = Array.from(keyStore.keys()).sort();
    currentKeyVersion = versions[versions.length - 1];
  }

  if (keyStore.size === 0) {
    log.warn('No hay claves de cifrado configuradas en env vars');
  } else {
    log.info(`claves cargadas: ${Array.from(keyStore.keys()).join(', ')} · actual: ${currentKeyVersion}`);
  }
}

loadKeysFromEnv();

/**
 * Obtiene la clave de cifrado para una versión dada.
 * Si no se especifica, usa la actual.
 */
function resolveKey(opts = {}) {
  // 1. Clave pasada directamente
  if (opts.key) {
    const buf = Buffer.isBuffer(opts.key)
      ? opts.key
      : Buffer.from(String(opts.key), 'utf-8');

    // Si no es de 32 bytes, derivar con HKDF
    if (buf.length !== CFG.keyLength) {
      return crypto.hkdfSync(
        'sha256',
        buf,
        Buffer.from('numination-key-salt'),
        Buffer.from('numination-key-info'),
        CFG.keyLength
      );
    }

    return buf;
  }

  // 2. Versión específica
  const version = opts.version || currentKeyVersion;

  if (version && keyStore.has(version)) {
    return keyStore.get(version);
  }

  // 3. Fallback: primera clave disponible
  if (keyStore.size > 0) {
    return keyStore.values().next().value;
  }

  throw new Error(
    'No hay clave de cifrado. Configurá ENCRYPTION_KEY_V1 en .env.local'
  );
}

/**
 * Registra una clave manualmente en runtime.
 */
function registerKey(version, key) {
  const v = String(version).toLowerCase();
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'hex');

  if (buf.length !== CFG.keyLength) {
    throw new Error(`La clave debe ser de ${CFG.keyLength} bytes`);
  }

  keyStore.set(v, buf);
  if (!currentKeyVersion) currentKeyVersion = v;
  return true;
}

/**
 * Devuelve la versión actual de la clave.
 */
function getCurrentKeyVersion() {
  return currentKeyVersion;
}

/**
 * Lista todas las versiones registradas.
 */
function listKeyVersions() {
  return Array.from(keyStore.keys()).sort();
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · ENCODING
   ═══════════════════════════════════════════════════════════════════════════ */

function toBase64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf-8');
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(input) {
  let s = String(input).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function toHex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf-8');
  return buf.toString('hex');
}

function fromHex(input) {
  return Buffer.from(String(input), 'hex');
}

function encode(str, format = 'base64url') {
  if (format === 'base64url') return toBase64url(str);
  if (format === 'base64') return Buffer.from(String(str), 'utf-8').toString('base64');
  if (format === 'hex') return toHex(str);
  throw new Error(`Formato desconocido: ${format}`);
}

function decode(str, format = 'base64url') {
  if (format === 'base64url') return fromBase64url(str).toString('utf-8');
  if (format === 'base64') return Buffer.from(String(str), 'base64').toString('utf-8');
  if (format === 'hex') return fromHex(str).toString('utf-8');
  throw new Error(`Formato desconocido: ${format}`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · RANDOM
   ═══════════════════════════════════════════════════════════════════════════ */

function randomBytes(n) {
  return crypto.randomBytes(n);
}

function randomHex(n = 32) {
  return crypto.randomBytes(n).toString('hex');
}

function randomBase64(n = 32) {
  return crypto.randomBytes(n).toString('base64');
}

function randomBase64Url(n = 32) {
  return toBase64url(crypto.randomBytes(n));
}

function randomUUID() {
  return crypto.randomUUID();
}

/**
 * Token URL-safe. Por defecto 32 bytes de entropía → 43 chars.
 */
function randomToken(bytes = 32) {
  return toBase64url(crypto.randomBytes(bytes));
}

/**
 * Password aleatorio con caracteres seguros.
 */
function randomPassword(length = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*-_=+';
  const len = chars.length;
  // Rejection sampling para evitar bias
  const max = 256 - (256 % len);
  let result = '';
  while (result.length < length) {
    const buf = crypto.randomBytes(length * 2);
    for (let i = 0; i < buf.length && result.length < length; i++) {
      if (buf[i] >= max) continue;
      result += chars[buf[i] % len];
    }
  }
  return result;
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · HASHING
   ═══════════════════════════════════════════════════════════════════════════ */

function hash(data, algorithm = CFG.hashAlgorithm) {
  return crypto
    .createHash(algorithm)
    .update(Buffer.isBuffer(data) ? data : String(data))
    .digest('hex');
}

function sha256(data) {
  return hash(data, 'sha256');
}

function sha512(data) {
  return hash(data, 'sha512');
}

function blake2b(data, size = 32) {
  const digestLength = Math.max(1, Math.min(64, size));
  return crypto
    .createHash('blake2b512')
    .update(Buffer.isBuffer(data) ? data : String(data))
    .digest('hex')
    .slice(0, digestLength * 2);
}

function md5(data) {
  return hash(data, 'md5');
}

function sha1(data) {
  return hash(data, 'sha1');
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · HMAC
   ═══════════════════════════════════════════════════════════════════════════ */

function hmac(data, secret, algorithm = 'sha256') {
  return crypto
    .createHmac(algorithm, secret)
    .update(Buffer.isBuffer(data) ? data : String(data))
    .digest('hex');
}

function hmacBuffer(data, secret, algorithm = 'sha256') {
  return crypto
    .createHmac(algorithm, secret)
    .update(Buffer.isBuffer(data) ? data : String(data))
    .digest();
}

/**
 * Firma un string. Formato: <data>.<hmac>
 */
function sign(data, secret) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
  const sig = hmacBuffer(payload, secret);
  return toBase64url(payload) + '.' + toBase64url(sig);
}

/**
 * Verifica una firma. Timing-safe.
 */
function verify(data, signature, secret) {
  const parts = String(signature).split('.');
  if (parts.length !== 2) return false;

  try {
    const payload = fromBase64url(parts[0]);
    const expected = hmacBuffer(payload, secret);
    const actual = fromBase64url(parts[1]);

    if (expected.length !== actual.length) return false;
    if (!crypto.timingSafeEqual(expected, actual)) return false;

    // Además, verificar que el payload coincide con el data
    const provided = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf-8');
    if (provided.length !== payload.length) return false;
    return crypto.timingSafeEqual(provided, payload);
  } catch (e) {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   07 · CIFRADO · AES-256-GCM
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Cifra un string u objeto. Devuelve un envelope.
 *
 * @param {string|Buffer|Object} plaintext
 * @param {Object} opts
 * @param {string|Buffer} [opts.key]     - clave directa (32 bytes o string)
 * @param {string} [opts.version]        - versión de la clave maestra
 * @param {Buffer} [opts.aad]            - additional authenticated data
 * @returns {{ iv: string, tag: string, ciphertext: string, version: string }}
 */
function encrypt(plaintext, opts = {}) {
  const key = resolveKey(opts);
  const version = opts.version || currentKeyVersion || 'v1';

  // Serializar si es objeto
  let data;
  if (typeof plaintext === 'string') {
    data = Buffer.from(plaintext, 'utf-8');
  } else if (Buffer.isBuffer(plaintext)) {
    data = plaintext;
  } else {
    data = Buffer.from(JSON.stringify(plaintext), 'utf-8');
  }

  const iv = crypto.randomBytes(CFG.ivLength);
  const cipher = crypto.createCipheriv(CFG.algorithm, key, iv, {
    authTagLength: CFG.tagLength,
  });

  if (opts.aad) {
    cipher.setAAD(Buffer.isBuffer(opts.aad) ? opts.aad : Buffer.from(String(opts.aad)));
  }

  const ciphertext = Buffer.concat([
    cipher.update(data),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return {
    v: version,
    iv: toBase64url(iv),
    tag: toBase64url(tag),
    ct: toBase64url(ciphertext),
  };
}

/**
 * Descifra un envelope. Devuelve string u objeto.
 */
function decrypt(envelope, opts = {}) {
  if (!envelope || typeof envelope !== 'object') {
    throw new Error('Envelope inválido');
  }

  // Aceptar tanto { iv, tag, ct, v } como { iv, tag, ciphertext, version }
  const ivStr = envelope.iv;
  const tagStr = envelope.tag;
  const ctStr = envelope.ct || envelope.ciphertext;
  const version = envelope.v || envelope.version;

  if (!ivStr || !tagStr || !ctStr) {
    throw new Error('Envelope incompleto: falta iv, tag o ct');
  }

  const key = resolveKey({ ...opts, version });

  const iv = fromBase64url(ivStr);
  const tag = fromBase64url(tagStr);
  const ciphertext = fromBase64url(ctStr);

  const decipher = crypto.createDecipheriv(CFG.algorithm, key, iv, {
    authTagLength: CFG.tagLength,
  });

  if (opts.aad) {
    decipher.setAAD(Buffer.isBuffer(opts.aad) ? opts.aad : Buffer.from(String(opts.aad)));
  }

  decipher.setAuthTag(tag);

  let decrypted;
  try {
    decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
  } catch (e) {
    throw new Error('Descifrado falló: ' + e.message);
  }

  const text = decrypted.toString('utf-8');

  // Si el texto es JSON válido, parsearlo
  if (opts.parseJSON !== false) {
    const trimmed = text.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.parse(trimmed);
      } catch (e) {
        // No era JSON válido, devolver como string
      }
    }
  }

  return text;
}

/**
 * Cifra cualquier valor y devuelve un string compacto (URL-safe).
 * Formato: v1.<iv>.<tag>.<ct> (todo base64url)
 */
function encryptString(plaintext, opts = {}) {
  const env = encrypt(plaintext, opts);
  return [env.v, env.iv, env.tag, env.ct].join('.');
}

/**
 * Descifra el formato compacto devuelto por encryptString.
 */
function decryptString(str, opts = {}) {
  if (typeof str !== 'string') throw new Error('Se esperaba un string');
  const parts = str.split('.');
  if (parts.length !== 4) throw new Error('Formato inválido');

  const [v, iv, tag, ct] = parts;
  return decrypt({ v, iv, tag, ct }, opts);
}

/**
 * Alias más corto.
 */
function encryptJSON(obj, opts = {}) {
  return encryptString(obj, opts);
}

function decryptJSON(str, opts = {}) {
  return decryptString(str, opts);
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · PASSWORD HASHING · scrypt
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Hashea una password. Formato PHC-like:
 *   scrypt$N=16384,r=8,p=1$<salt-b64>$<hash-b64>
 */
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password vacío');
  }

  const p = CFG.password;
  const salt = crypto.randomBytes(p.saltLen);

  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      p.keyLen,
      { N: p.N, r: p.r, p: p.p, maxmem: p.maxmem },
      (err, derivedKey) => {
        if (err) return reject(err);
        const hash = toBase64url(derivedKey);
        const saltB64 = toBase64url(salt);
        resolve(`scrypt$N=${p.N},r=${p.r},p=${p.p}$${saltB64}$${hash}`);
      }
    );
  });
}

/**
 * Verifica una password contra un hash. Timing-safe.
 */
async function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || !storedHash) return false;

  try {
    const parts = String(storedHash).split('$');
    if (parts.length !== 4) return false;

    const [algo, paramsStr, saltB64, hashB64] = parts;
    if (algo !== 'scrypt') return false;

    // Parsear parámetros
    const params = {};
    paramsStr.split(',').forEach(kv => {
      const [k, v] = kv.split('=');
      params[k.trim()] = parseInt(v, 10);
    });

    const salt = fromBase64url(saltB64);
    const expectedHash = fromBase64url(hashB64);

    return new Promise((resolve) => {
      crypto.scrypt(
        password,
        salt,
        expectedHash.length,
        {
          N: params.N || CFG.password.N,
          r: params.r || CFG.password.r,
          p: params.p || CFG.password.p,
          maxmem: CFG.password.maxmem,
        },
        (err, derivedKey) => {
          if (err) return resolve(false);
          if (derivedKey.length !== expectedHash.length) return resolve(false);
          try {
            resolve(crypto.timingSafeEqual(derivedKey, expectedHash));
          } catch (e) {
            resolve(false);
          }
        }
      );
    });
  } catch (e) {
    return false;
  }
}

/**
 * Verifica si un hash fue generado con parámetros obsoletos.
 */
function needsRehash(storedHash) {
  try {
    const parts = String(storedHash).split('$');
    if (parts.length !== 4) return true;

    const paramsStr = parts[1];
    const params = {};
    paramsStr.split(',').forEach(kv => {
      const [k, v] = kv.split('=');
      params[k.trim()] = parseInt(v, 10);
    });

    return (
      params.N !== CFG.password.N ||
      params.r !== CFG.password.r ||
      params.p !== CFG.password.p
    );
  } catch (e) {
    return true;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   09 · KEY DERIVATION · HKDF, PBKDF2
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * HKDF: deriva claves de un input keying material.
 * Ideal para derivar claves de distintas partes del sistema del mismo secret.
 */
function hkdf(input, salt, info, length = 32, hash = 'sha256') {
  if (!input) throw new Error('input requerido');
  const inputBuf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf-8');
  const saltBuf = salt
    ? (Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'utf-8'))
    : Buffer.alloc(32);
  const infoBuf = info
    ? (Buffer.isBuffer(info) ? info : Buffer.from(String(info), 'utf-8'))
    : Buffer.alloc(0);

  return Buffer.from(crypto.hkdfSync(hash, inputBuf, saltBuf, infoBuf, length));
}

/**
 * PBKDF2: deriva una clave de una password.
 * Útil para compatibilidad con sistemas que lo usan.
 */
function pbkdf2(password, salt, opts = {}) {
  const iterations = opts.iterations || 600000;
  const length = opts.length || 32;
  const hash = opts.hash || 'sha256';

  const passBuf = Buffer.isBuffer(password) ? password : Buffer.from(String(password), 'utf-8');
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(String(salt), 'utf-8');

  return crypto.pbkdf2Sync(passBuf, saltBuf, iterations, length, hash);
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · TOKENS FIRMADOS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Firma un token compacto URL-safe.
 * Formato: v1.<payload>.<signature>
 * donde payload = base64url(JSON)
 *       signature = base64url(HMAC-SHA256(v1.payload, secret))
 */
function signToken(payload, secret, opts = {}) {
  if (!secret) throw new Error('secret requerido');

  const version = opts.version || CFG.token.version;
  const now = Math.floor(Date.now() / 1000);

  const fullPayload = {
    ...payload,
    iat: now,
    ...(opts.expiresIn !== undefined ? { exp: now + parseInt(opts.expiresIn, 10) } : {}),
  };

  const header = `${version}.${toBase64url(JSON.stringify(fullPayload))}`;
  const sig = hmacBuffer(header, secret);

  return `${header}.${toBase64url(sig)}`;
}

/**
 * Verifica y devuelve el payload de un token.
 * Tira error si la firma no coincide o si expiró.
 */
function verifyToken(token, secret, opts = {}) {
  if (!token || !secret) throw new Error('token y secret requeridos');

  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('Token inválido');

  const [version, payloadB64, sigB64] = parts;

  // Verificar versión
  if (opts.version && version !== opts.version) {
    throw new Error(`Versión de token no soportada: ${version}`);
  }

  // Verificar firma
  const header = `${version}.${payloadB64}`;
  const expected = hmacBuffer(header, secret);
  let actual;
  try {
    actual = fromBase64url(sigB64);
  } catch (e) {
    throw new Error('Token inválido: firma malformada');
  }

  if (expected.length !== actual.length) throw new Error('Token inválido: firma no coincide');
  if (!crypto.timingSafeEqual(expected, actual)) throw new Error('Token inválido: firma no coincide');

  // Parsear payload
  let payload;
  try {
    payload = JSON.parse(fromBase64url(payloadB64).toString('utf-8'));
  } catch (e) {
    throw new Error('Token inválido: payload malformado');
  }

  // Verificar expiración
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error('Token expirado');
  }

  // Verificar nbf (not before)
  if (payload.nbf && payload.nbf > now) {
    throw new Error('Token aún no válido');
  }

  return payload;
}

/**
 * Decodifica un token SIN verificar la firma.
 * Útil para inspeccionar sin secret.
 */
function decodeToken(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3) throw new Error('Token inválido');

  const [version, payloadB64, sigB64] = parts;
  try {
    return {
      version,
      payload: JSON.parse(fromBase64url(payloadB64).toString('utf-8')),
      signature: sigB64,
    };
  } catch (e) {
    throw new Error('Token malformado');
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   11 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Comparación en tiempo constante entre dos strings o buffers.
 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bufB = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch (e) {
    return false;
  }
}

/**
 * Redacta claves sensibles de un objeto. Por defecto redacta las comunes.
 * Devuelve una copia profunda con esos campos reemplazados por '[REDACTED]'.
 */
const DEFAULT_SENSITIVE_KEYS = new Set([
  'password', 'passwd', 'pwd', 'secret', 'token', 'accesstoken', 'access_token',
  'refreshtoken', 'refresh_token', 'apikey', 'api_key', 'auth', 'authorization',
  'cookie', 'session', 'sessionid', 'csrf', 'privatekey', 'private_key',
  'secretkey', 'secret_key', 'clientsecret', 'client_secret', 'bearer',
  'encryption_key', 'encryptionkey', 'cvv', 'ssn',
]);

function redact(data, keys = null, depth = 0) {
  if (depth > 10) return '[MaxDepth]';
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;
  if (Buffer.isBuffer(data)) return '[Buffer ' + data.length + 'b]';
  if (data instanceof Date) return data;

  const sensitiveSet = keys
    ? new Set(keys.map(k => String(k).toLowerCase()))
    : DEFAULT_SENSITIVE_KEYS;

  if (Array.isArray(data)) {
    return data.map(v => redact(v, keys, depth + 1));
  }

  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (sensitiveSet.has(k.toLowerCase())) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v, keys, depth + 1);
    }
  }
  return out;
}

/**
 * Genera un checksum rápido (no criptográfico) para detectar cambios.
 */
function checksum(data, algorithm = 'sha256') {
  return hash(data, algorithm).slice(0, 16);
}

/**
 * Compara dos buffers/strings con timing-safe (wrapper).
 */
function secureCompare(a, b) {
  return timingSafeEqual(a, b);
}

/* ═══════════════════════════════════════════════════════════════════════════
   12 · ENVELOPE ENCRYPTION · rotación de claves
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Envuelve un valor con múltiples versiones de claves para permitir rotación.
 * Internamente cifra con la clave actual y guarda metadata.
 *
 * Para rotar claves, simplemente:
 *   1. Generá ENCRYPTION_KEY_V2 y agregala a env vars
 *   2. Seteá ENCRYPTION_KEY_CURRENT=v2
 *   3. Los nuevos datos se cifran con v2, los viejos siguen descifrándose con v1
 */
function wrapValue(value, opts = {}) {
  const env = encrypt(value, opts);
  return encryptString(env, opts);
}

function unwrapValue(str, opts = {}) {
  const env = decryptString(str, { ...opts, parseJSON: true });
  return decrypt(env, opts);
}

/* ═══════════════════════════════════════════════════════════════════════════
   13 · CONFIGURACIÓN RUNTIME
   ═══════════════════════════════════════════════════════════════════════════ */

function configure(patch) {
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
  log.info('crypto config actualizada');
}

/* ═══════════════════════════════════════════════════════════════════════════
   14 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════════ */

async function test() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  // Random
  const rand1 = randomHex(16);
  const rand2 = randomHex(16);
  rec('randomHex genera 32 chars', rand1.length === 32, rand1.length);
  rec('randomHex es único', rand1 !== rand2, true);

  const token1 = randomToken(32);
  rec('randomToken URL-safe', !/[+/=]/.test(token1), token1.slice(0, 12));

  const uuid = randomUUID();
  rec('randomUUID formato válido', /^[0-9a-f-]{36}$/.test(uuid), uuid);

  const pwd = randomPassword(20);
  rec('randomPassword length', pwd.length === 20, pwd.length);

  // Hashing
  rec('sha256("hola") 64 chars', sha256('hola').length === 64, true);
  rec('sha256 determinista', sha256('hola') === sha256('hola'), true);
  rec('sha256 diferente input', sha256('hola') !== sha256('chau'), true);
  rec('sha512 128 chars', sha512('hola').length === 128, true);
  rec('blake2b 32 bytes → 64 hex', blake2b('hola', 32).length === 64, true);

  // HMAC
  const sig = hmac('data', 'secret');
  rec('hmac 64 hex chars', sig.length === 64, sig.length);
  rec('hmac determinista', hmac('data', 'secret') === sig, true);
  rec('hmac cambia con key', hmac('data', 'otro') !== sig, true);

  // Sign/verify
  const signed = sign('mensaje', 'secret-key');
  rec('sign formato con punto', signed.includes('.'), true);
  rec('verify firma válida', verify('mensaje', signed, 'secret-key') === true, true);
  rec('verify firma inválida', verify('mensaje', signed, 'wrong-key') === false, true);
  rec('verify data diferente', verify('otro', signed, 'secret-key') === false, true);

  // Base64url
  const b64 = toBase64url('hola mundo');
  rec('toBase64url sin +/=', !/[+/=]/.test(b64), b64);
  rec('fromBase64url recupera', fromBase64url(b64).toString('utf-8') === 'hola mundo', true);

  // Encrypt/decrypt string
  const testKey = randomHex(32);
  const plaintext = 'Mensaje secreto con ñ, é, 中文, 🎉';
  const env = encrypt(plaintext, { key: testKey });
  rec('encrypt devuelve envelope', !!env.iv && !!env.tag && !!env.ct, Object.keys(env));
  const dec = decrypt(env, { key: testKey });
  rec('decrypt recupera texto', dec === plaintext, dec);

  // Decrypt con key incorrecta debe fallar
  let failedWrongKey = false;
  try {
    decrypt(env, { key: randomHex(32) });
  } catch (e) {
    failedWrongKey = true;
  }
  rec('decrypt con key wrong falla', failedWrongKey === true, true);

  // Encrypt/decrypt objeto
  const obj = { user: 'juan', age: 25, nested: { foo: 'bar' } };
  const env2 = encrypt(obj, { key: testKey });
  const dec2 = decrypt(env2, { key: testKey });
  rec('encrypt/decrypt objeto', dec2.user === 'juan' && dec2.nested.foo === 'bar', dec2);

  // Encrypt/decrypt string compacto
  const compact = encryptString(plaintext, { key: testKey });
  rec('encryptString compacto tiene 4 partes', compact.split('.').length === 4, compact.split('.').length);
  const dec3 = decryptString(compact, { key: testKey });
  rec('decryptString recupera', dec3 === plaintext, dec3);

  // AAD
  const env3 = encrypt('data', { key: testKey, aad: 'context-1' });
  rec('AAD decrypt correcto', decrypt(env3, { key: testKey, aad: 'context-1' }) === 'data', true);
  let failedAAD = false;
  try {
    decrypt(env3, { key: testKey, aad: 'context-2' });
  } catch (e) {
    failedAAD = true;
  }
  rec('AAD incorrecto falla', failedAAD === true, true);

  // Password hashing
  const passHash = await hashPassword('mi_password_segura_123');
  rec('hashPassword formato PHC', passHash.startsWith('scrypt$'), passHash.slice(0, 30));
  const verifyOk = await verifyPassword('mi_password_segura_123', passHash);
  rec('verifyPassword correcto', verifyOk === true, true);
  const verifyBad = await verifyPassword('otra_password', passHash);
  rec('verifyPassword incorrecto', verifyBad === false, true);
  const rehashCheck = needsRehash(passHash);
  rec('needsRehash false para hash actual', rehashCheck === false, rehashCheck);
  const oldHash = 'scrypt$N=1024,r=8,p=1$' + toBase64url(randomBytes(16)) + '$' + toBase64url(randomBytes(64));
  rec('needsRehash true para hash viejo', needsRehash(oldHash) === true, true);

  // HKDF
  const key1 = hkdf('input', 'salt', 'info-1', 32);
  const key2 = hkdf('input', 'salt', 'info-2', 32);
  const key3 = hkdf('input', 'salt', 'info-1', 32);
  rec('hkdf length correcto', key1.length === 32, key1.length);
  rec('hkdf determinista', key1.equals(key3), true);
  rec('hkdf diferente info', !key1.equals(key2), true);

  // PBKDF2
  const pbkdf = pbkdf2('password', 'salt', { iterations: 1000, length: 32 });
  rec('pbkdf2 length correcto', pbkdf.length === 32, pbkdf.length);

  // Tokens
  const jwtSecret = 'secreto-super-seguro-12345';
  const jwtPayload = { userId: 'abc123', role: 'admin' };
  const jwt = signToken(jwtPayload, jwtSecret, { expiresIn: 3600 });
  rec('signToken 3 partes', jwt.split('.').length === 3, jwt.split('.').length);

  const verified = verifyToken(jwt, jwtSecret);
  rec('verifyToken recupera payload', verified.userId === 'abc123', verified);
  rec('verifyToken añade iat', typeof verified.iat === 'number', typeof verified.iat);
  rec('verifyToken añade exp', typeof verified.exp === 'number', typeof verified.exp);

  let failedJWT = false;
  try {
    verifyToken(jwt, 'wrong-secret');
  } catch (e) {
    failedJWT = true;
  }
  rec('verifyToken con secret wrong falla', failedJWT === true, true);

  // Expiración
  const expiredJWT = signToken({ x: 1 }, jwtSecret, { expiresIn: -10 });
  let expiredFailed = false;
  try {
    verifyToken(expiredJWT, jwtSecret);
  } catch (e) {
    expiredFailed = e.message.includes('expirado');
  }
  rec('verifyToken rechaza expirado', expiredFailed === true, true);

  // decodeToken
  const decoded = decodeToken(jwt);
  rec('decodeToken funciona sin secret', decoded.payload.userId === 'abc123', decoded.payload);

  // timingSafeEqual
  rec('timingSafeEqual iguales', timingSafeEqual('abc', 'abc') === true, true);
  rec('timingSafeEqual diferentes', timingSafeEqual('abc', 'abd') === false, true);
  rec('timingSafeEqual longitudes', timingSafeEqual('abc', 'abcd') === false, true);

  // redact
  const redacted = redact({
    user: 'juan',
    password: 'secreto123',
    token: 'abc',
    nested: { api_key: 'xyz', name: 'ok' },
  });
  rec('redact password', redacted.password === '[REDACTED]', redacted.password);
  rec('redact token', redacted.token === '[REDACTED]', redacted.token);
  rec('redact nested api_key', redacted.nested.api_key === '[REDACTED]', redacted.nested.api_key);
  rec('redact no toca user', redacted.user === 'juan', redacted.user);
  rec('redact no toca nested.name', redacted.nested.name === 'ok', redacted.nested.name);

  // registerKey
  const testKeyHex = randomHex(32);
  registerKey('vtest', testKeyHex);
  rec('registerKey funciona', listKeyVersions().includes('vtest'), listKeyVersions());

  // Envelope con clave registrada
  const envTest = encrypt('hola', { version: 'vtest' });
  rec('encrypt con versión registrada', envTest.v === 'vtest', envTest.v);
  const decTest = decrypt(envTest);
  rec('decrypt con clave correcta por versión', decTest === 'hola', decTest);

  const passed = results.filter(r => r.ok).length;
  return {
    passed,
    total: results.length,
    ok: passed === results.length,
    results,
    keys: listKeyVersions(),
    currentKey: getCurrentKeyVersion(),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   15 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export const cryptoLib = {
  // Cifrado
  encrypt,
  decrypt,
  encryptString,
  decryptString,
  encryptJSON,
  decryptJSON,
  wrapValue,
  unwrapValue,

  // Hashing
  hash,
  sha256,
  sha512,
  sha1,
  md5,
  blake2b,

  // HMAC y firma
  hmac,
  hmacBuffer,
  sign,
  verify,

  // Passwords
  hashPassword,
  verifyPassword,
  needsRehash,

  // KDF
  hkdf,
  pbkdf2,

  // Tokens
  signToken,
  verifyToken,
  decodeToken,

  // Random
  randomBytes,
  randomHex,
  randomBase64,
  randomBase64Url,
  randomUUID,
  randomToken,
  randomPassword,

  // Encoding
  encode,
  decode,
  toBase64url,
  fromBase64url,
  toHex,
  fromHex,

  // Utilidades
  timingSafeEqual,
  secureCompare,
  redact,
  checksum,

  // Keys
  registerKey,
  getCurrentKeyVersion,
  listKeyVersions,

  // Config
  configure,

  // Debug
  test,

  // Internals
  _config: CFG,
};

export default cryptoLib;

/* ═══════════════════════════════════════════════════════════════════════════
   NAMED EXPORTS · para import directo
   ═══════════════════════════════════════════════════════════════════════════
   Uso:  import { randomHex, encrypt } from './lib/crypto.js';
   ═══════════════════════════════════════════════════════════════════════════ */

export {
  randomBytes, randomHex, randomBase64, randomBase64Url, randomUUID, randomToken, randomPassword,
  hash, sha256, sha512, sha1, md5, blake2b,
  hmac, hmacBuffer, sign, verify,
  hashPassword, verifyPassword, needsRehash,
  hkdf, pbkdf2,
  signToken, verifyToken, decodeToken,
  encode, decode, toBase64url, fromBase64url, toHex, fromHex,
  timingSafeEqual, secureCompare, redact, checksum,
  encrypt, decrypt, encryptString, decryptString, encryptJSON, decryptJSON,
  wrapValue, unwrapValue,
  registerKey, getCurrentKeyVersion, listKeyVersions,
  configure,
  test,
};
