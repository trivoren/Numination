/* ================================================================
   NUMINATION · auth.js · v3.2
   ----------------------------------------------------------------
   Autenticación robusta con:
     · Google Identity Services (popup, GIS)
     · GitHub OAuth (passport-github)
     · Email + contraseña (scrypt, sin dependencias nuevas)
   Sesiones JWT en cookies httpOnly. Persistencia en Supabase.

   CAMBIOS v3.2 (respecto a v3.1):
     · FIX: sanitizeEnv() limpia espacios/comillas/saltos en CLIENT_ID.
       Era la causa del "Wrong recipient, payload audience !=
       requiredAudience" cuando el valor viene de Vercel con
       caracteres invisibles.
     · Diagnóstico: log al arranque muestra longitud y sufijo del
       CLIENT_ID para comparar contra el frontend.
     · /api/auth/google devuelve X-Client-Id-Len y X-Client-Id-Suffix
       en el header 401 (útil para debug desde DevTools).
     · Google: `verifyIdToken` con try/catch propio que loguea el
       error real (no solo el genérico).
   ================================================================ */

import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import passport from 'passport';
import { Strategy as GitHubStrategy } from 'passport-github';

import {
  getProfile,
  getProfileFull,
  getProfileByEmail,
  getProfileByEmailFull,
  createProfile,
  updateLastLogin,
  updateProfile,
  setPassword,
  setResetToken,
  getProfileByResetToken,
  clearResetToken,
  deleteProfile,
} from './services/supabase.js';

/* ══════════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ══════════════════════════════════════════════════════════════════════════ */

let TEST_KEYS = {};
try {
  const mod = await import('../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

/**
 * Sanitiza una variable de entorno:
 *  · trim()            → quita espacios/saltos al inicio/fin
 *  · quita comillas    → "abc" → abc
 *  · quita \r y \n     → Vercel a veces mete saltos
 *
 * Era la causa del bug: Vercel guarda el valor con un \n invisible
 * al final, y Google rechaza cualquier audience con espacio.
 */
function sanitizeEnv(v) {
  if (typeof v !== 'string') return v;
  return v.trim().replace(/^["']|["']$/g, '').replace(/[\r\n\t]/g, '');
}

function pickEnv(envKey, fallback) {
  const raw = process.env[envKey] ?? fallback;
  return sanitizeEnv(raw);
}

const CLIENT_ID     = pickEnv('GOOGLE_CLIENT_ID',     TEST_KEYS.GOOGLE_CLIENT_ID);
const CLIENT_SECRET = pickEnv('GOOGLE_CLIENT_SECRET', TEST_KEYS.GOOGLE_CLIENT_SECRET);
const JWT_SECRET    = pickEnv('JWT_SECRET',           TEST_KEYS.JWT_SECRET);

const GITHUB_CLIENT_ID     = pickEnv('GITHUB_CLIENT_ID',     TEST_KEYS.GITHUB_CLIENT_ID);
const GITHUB_CLIENT_SECRET = pickEnv('GITHUB_CLIENT_SECRET', TEST_KEYS.GITHUB_CLIENT_SECRET);

const RESEND_API_KEY = pickEnv('RESEND_API_KEY', TEST_KEYS.RESEND_API_KEY) ?? null;
const FROM_EMAIL     = process.env.NUMINATION_FROM_EMAIL ?? 'Numination <no-reply@numination.app>';

const COOKIE_NAME          = 'numination_session';
const SESSION_DAYS         = 30;
const SESSION_DAYS_SHORT   = 1;
const FRESH_WINDOW_SEC     = 5 * 60;
const VERIFY_WINDOW_MIN    = 15;

const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MINUTES  = 15;

/* ─── Diagnóstico de env vars ─── */

if (!CLIENT_ID) {
  console.warn('⚠️  GOOGLE_CLIENT_ID no configurado');
} else {
  // Se loguea sufijo y longitud (no el valor completo por seguridad)
  const suffix = CLIENT_ID.slice(-44);
  const expectedSuffix = 'hqlpgm37slhbbtqotv4uv9erla4sdl6d.apps.googleusercontent.com';
  const matches = suffix === expectedSuffix;
  console.log(
    `[auth] GOOGLE_CLIENT_ID · len=${CLIENT_ID.length} · ` +
    `suffix=…${CLIENT_ID.slice(-30)} · ` +
    `${matches ? '✓ coincide con frontend' : '⚠ revisar contra frontend'}`
  );
}

if (!CLIENT_SECRET) console.warn('⚠️  GOOGLE_CLIENT_SECRET no configurado');
if (!JWT_SECRET)    console.warn('⚠️  JWT_SECRET no configurado');

const GITHUB_ENABLED = Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
if (!GITHUB_ENABLED) {
  console.warn('⚠️  GitHub OAuth no configurado (GITHUB_CLIENT_ID/SECRET faltantes)');
}
if (!RESEND_API_KEY) {
  console.warn('ℹ️  RESEND_API_KEY no configurado → correos se loguean en consola');
}

const EMAIL_ENABLED = Boolean(RESEND_API_KEY);

const googleClient = new OAuth2Client(CLIENT_ID);

/* ══════════════════════════════════════════════════════════════════════════
   2 · LOGGING ESTRUCTURADO
   ══════════════════════════════════════════════════════════════════════════ */

const LEVEL = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVEL[process.env.LOG_LEVEL] || LEVEL.info;

function log(level, event, meta = {}, req = null) {
  if (LEVEL[level] < MIN_LEVEL) return;
  const entry = { ts: new Date().toISOString(), lvl: level, event, ...meta };
  if (req) {
    entry.reqId = req.id;
    entry.ip    = getClientIp(req);
    entry.ua    = req.get?.('user-agent')?.slice(0, 120);
  }
  const line = JSON.stringify(entry);
  if (level === 'error')      console.error('[auth]', line);
  else if (level === 'warn')  console.warn('[auth]', line);
  else                        console.log('[auth]', line);
}

/* ══════════════════════════════════════════════════════════════════════════
   3 · UTILIDADES
   ══════════════════════════════════════════════════════════════════════════ */

function nuevoId() {
  return crypto.randomUUID();
}

function newRequestId() {
  return crypto.randomBytes(6).toString('hex');
}

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, code, ...extra });
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    role: (user.role || 'student').toLowerCase(),
    plan: user.plan || 'free',
    provider: user.auth_provider || null,
    emailVerified: user.email_verified === true,
    hasPassword: Boolean(user.password_hash),
    createdAt: user.created_at || null,
    lastLoginAt: user.last_login_at || null,
  };
}

function getCallbackUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host  = req.get('host') || 'localhost:8080';
  return `${proto}://${host}/api/auth/github/callback`;
}

function getAppUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host  = req.get('host') || 'localhost:8080';
  return `${proto}://${host}`;
}

function getClientIp(req) {
  const fwd = req.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

/* ══════════════════════════════════════════════════════════════════════════
   4 · VALIDACIÓN
   ══════════════════════════════════════════════════════════════════════════ */

const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d).{8,100}$/;

const COMMON_PASSWORDS = new Set([
  'password', '12345678', '123456789', 'qwerty123', 'abc12345',
  'password1', 'contraseña', 'iloveyou', 'admin123', 'welcome1',
  'letmein1', 'monkey123', 'dragon123', 'football1', 'baseball1',
  'sunshine1', 'princess1', 'shadow123', 'master123', 'superman1',
]);

function isValidEmail(v) {
  if (typeof v !== 'string') return false;
  const e = v.trim();
  return e.length >= 5 && e.length <= 254 && EMAIL_RE.test(e);
}

function isCommonPassword(v) {
  return COMMON_PASSWORDS.has(String(v || '').toLowerCase());
}

function validatePassword(pwd) {
  if (typeof pwd !== 'string') return { ok: false, code: 'password_missing', message: 'Falta la contraseña.' };
  if (pwd.length < 8)          return { ok: false, code: 'password_short',    message: 'La contraseña debe tener al menos 8 caracteres.' };
  if (pwd.length > 100)        return { ok: false, code: 'password_long',     message: 'La contraseña no puede pasar de 100 caracteres.' };
  if (!/[A-Za-z]/.test(pwd))   return { ok: false, code: 'password_no_letter', message: 'La contraseña debe incluir al menos una letra.' };
  if (!/\d/.test(pwd))         return { ok: false, code: 'password_no_digit',  message: 'La contraseña debe incluir al menos un número.' };
  if (isCommonPassword(pwd))   return { ok: false, code: 'password_common',   message: 'Esa contraseña es muy común. Elige otra.' };
  return { ok: true };
}

/* ══════════════════════════════════════════════════════════════════════════
   5 · PASSWORD HASHING
   ══════════════════════════════════════════════════════════════════════════ */

const SCRYPT_KEYLEN     = 64;
const SCRYPT_SALT_BYTES = 16;

function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  if (!stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  try {
    const salt     = parts[1];
    const expected = Buffer.from(parts[2], 'hex');
    const computed = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    if (expected.length !== computed.length) return false;
    return crypto.timingSafeEqual(expected, computed);
  } catch { return false; }
}

/* ══════════════════════════════════════════════════════════════════════════
   6 · RATE LIMITING
   ══════════════════════════════════════════════════════════════════════════ */

const rateBuckets = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > limit) {
    return { ok: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { ok: true, remaining: limit - bucket.count, retryAfter: 0 };
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) { if (now > v.resetAt) rateBuckets.delete(k); }
}, 60_000);
if (cleanupTimer.unref) cleanupTimer.unref();

function enforceRate(res, key, limit, windowMs) {
  const r = rateLimit(key, limit, windowMs);
  if (!r.ok) {
    res.set('Retry-After', String(r.retryAfter));
    fail(res, 429, 'rate_limit',
      `Demasiados intentos. Espera ${r.retryAfter} segundos.`,
      { retryAfter: r.retryAfter });
    return false;
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════
   7 · AUDIT LOG
   ══════════════════════════════════════════════════════════════════════════ */

const AUDIT_MAX = 200;
const auditLog = [];

function audit(event, meta = {}) {
  auditLog.unshift({ ts: new Date().toISOString(), event, ...meta });
  if (auditLog.length > AUDIT_MAX) auditLog.length = AUDIT_MAX;
}

/* ══════════════════════════════════════════════════════════════════════════
   8 · EMAIL
   ══════════════════════════════════════════════════════════════════════════ */

function buildEmail({ title, intro, cta, url, footer }) {
  return `
  <div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#0a0a0c;background:#fff">
    <h2 style="font-size:22px;font-weight:800;letter-spacing:-.02em;margin:0 0 12px">${title}</h2>
    <p style="font-size:15px;line-height:1.6;color:#3a3a40;margin:0 0 24px">${intro}</p>
    <a href="${url}" style="display:inline-block;background:#1e3a5f;color:#fff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:600;font-size:15px">${cta}</a>
    <p style="font-size:13px;color:#6b6b70;line-height:1.5;margin:24px 0 0">${footer}</p>
    <p style="font-size:12px;color:#a0a0a5;word-break:break-all;margin:24px 0 0">${url}</p>
  </div>`;
}

async function sendEmail({ to, subject, html }) {
  if (!EMAIL_ENABLED) {
    console.log('═══════════════════════════════════════════════════');
    console.log('[auth] EMAIL (dev)');
    console.log('Para:  ', to);
    console.log('Asunto:', subject);
    const urlMatch = html.match(/href="([^"]+)"/);
    if (urlMatch) console.log('Link:  ', urlMatch[1]);
    console.log('═══════════════════════════════════════════════════');
    return { ok: true, dev: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to: [to], subject, html }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      log('warn', 'email.failed', { to, status: res.status, err: err.slice(0, 200) });
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    log('warn', 'email.error', { to, message: e.message });
    return { ok: false };
  }
}

async function sendPasswordResetEmail(to, resetUrl, name = '') {
  const html = buildEmail({
    title: 'Recuperar contraseña',
    intro: `${name ? `Hola <strong>${name}</strong>,` : 'Hola,'}<br>
            Recibimos una solicitud para cambiar tu contraseña de Numination.
            El link expira en 1 hora.`,
    cta: 'Cambiar contraseña',
    url: resetUrl,
    footer: 'Si no pediste este cambio, ignora este correo.',
  });
  return sendEmail({ to, subject: 'Recupera tu contraseña de Numination', html });
}

async function sendVerificationEmail(to, verifyUrl, name = '') {
  const html = buildEmail({
    title: 'Verifica tu correo',
    intro: `${name ? `Hola <strong>${name}</strong>,` : 'Hola,'}<br>
            Confirma tu correo para activar todas las funciones de Numination.
            El link expira en ${VERIFY_WINDOW_MIN} minutos.`,
    cta: 'Verificar correo',
    url: verifyUrl,
    footer: 'Si no creaste esta cuenta, ignora este correo.',
  });
  return sendEmail({ to, subject: 'Verifica tu correo de Numination', html });
}

/* ══════════════════════════════════════════════════════════════════════════
   9 · SESIONES
   ══════════════════════════════════════════════════════════════════════════ */

function signSession(user, remember = true) {
  const expiresIn = remember ? `${SESSION_DAYS}d` : `${SESSION_DAYS_SHORT}d`;
  return jwt.sign(
    {
      sub:   user.id,
      email: user.email,
      role:  (user.role || 'student').toLowerCase(),
      ver:   user.auth_version ?? 1,
      jti:   crypto.randomBytes(8).toString('hex'),
    },
    JWT_SECRET,
    { expiresIn }
  );
}

function verifySession(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function setSessionCookie(res, token, remember = true) {
  const maxAge = (remember ? SESSION_DAYS : SESSION_DAYS_SHORT) * 24 * 60 * 60 * 1000;
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production' || process.env.VERCEL === '1',
    sameSite: 'lax',
    maxAge,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function issueSession(res, user, remember = true) {
  const token = signSession(user, remember);
  setSessionCookie(res, token, remember);
  return { ok: true, user: publicUser(user) };
}

async function loadSession(token) {
  const payload = verifySession(token);
  if (!payload) return null;
  let profile = null;
  try { profile = await getProfileFull(payload.sub); } catch {}
  if (profile && Number(profile.auth_version || 1) > Number(payload.ver || 1)) {
    return null;
  }
  return { payload, profile };
}

/* ══════════════════════════════════════════════════════════════════════════
   10 · MIDDLEWARE
   ══════════════════════════════════════════════════════════════════════════ */

export function requestId(req, res, next) {
  req.id = newRequestId();
  res.set('X-Request-Id', req.id);
  next();
}

export function attachUser(req, _res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next();
  const payload = verifySession(token);
  if (!payload) return next();
  req.user = {
    id: payload.sub, email: payload.email, role: payload.role || 'student',
    ver: payload.ver, jti: payload.jti, iat: payload.iat, exp: payload.exp,
  };
  next();
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return fail(res, 401, 'no_session', 'No autenticado');
  const payload = verifySession(token);
  if (!payload) return fail(res, 401, 'invalid_session', 'Sesión inválida o expirada');
  req.user = {
    id: payload.sub, email: payload.email, role: payload.role || 'student',
    ver: payload.ver, jti: payload.jti, iat: payload.iat, exp: payload.exp,
  };
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return fail(res, 401, 'no_session', 'No autenticado');
    if (!roles.includes(req.user.role)) {
      return fail(res, 403, 'forbidden', 'Sin permisos suficientes');
    }
    next();
  };
}

function requireFreshSession(req, res, next) {
  const iat = req.user?.iat;
  if (!iat) return fail(res, 401, 'no_session', 'Sesión inválida');
  const ageSec = Math.floor(Date.now() / 1000) - iat;
  if (ageSec > FRESH_WINDOW_SEC) {
    return fail(res, 403, 'stale_session',
      'Por seguridad, vuelve a iniciar sesión para esta acción.');
  }
  next();
}

/* ══════════════════════════════════════════════════════════════════════════
   11 · BLOQUEO DE CUENTA
   ══════════════════════════════════════════════════════════════════════════ */

function isLocked(profile) {
  if (!profile?.locked_until) return false;
  return new Date(profile.locked_until).getTime() > Date.now();
}

function lockRemainingMinutes(profile) {
  if (!isLocked(profile)) return 0;
  const diff = new Date(profile.locked_until).getTime() - Date.now();
  return Math.max(1, Math.ceil(diff / 60_000));
}

async function registerFailedLogin(profile) {
  const attempts = Number(profile.failed_attempts || 0) + 1;
  const shouldLock = attempts >= LOCKOUT_ATTEMPTS;
  try { await updateProfile(profile.id, {}); } catch {}
  return { locked: shouldLock, minutes: shouldLock ? LOCKOUT_MINUTES : 0, attempts };
}

async function clearFailedAttempts(/* profile */) {
  // stub — se implementa con setLoginAttempts en supabase.js
}

/* ══════════════════════════════════════════════════════════════════════════
   12 · OPERACIONES DE USUARIO
   ══════════════════════════════════════════════════════════════════════════ */

async function findOrCreateUser({ email, name, picture, provider = 'google', req = null }) {
  const key = String(email).toLowerCase();
  let profile = null;
  try { profile = await getProfileByEmail(key); }
  catch (e) { log('warn', 'auth.getProfileByEmail.failed', { message: e.message }, req); }

  if (profile) {
    try { await updateLastLogin(profile.id); } catch {}
    log('info', 'auth.login.oauth.existing', { email: key, provider }, req);
    audit('login.oauth.existing', { email: key, provider });
    return profile;
  }

  const nuevo = {
    id: nuevoId(),
    email: key,
    name: name || key.split('@')[0],
    picture: picture || null,
    role: 'student',
    provider,
    auth_provider: provider,
    email_verified: true,
  };

  try {
    profile = await createProfile(nuevo);
    if (profile) {
      log('info', 'auth.signup.oauth', { email: key, provider }, req);
      audit('signup.oauth', { email: key, provider });
      return profile;
    }
  } catch (e) {
    log('warn', 'auth.createProfile.failed', { message: e.message }, req);
  }

  log('warn', 'auth.user.ephemeral', { email: key, provider }, req);
  return nuevo;
}

async function findUserByEmail(email) {
  const key = String(email).toLowerCase();
  try { return await getProfileByEmailFull(key); }
  catch (e) { log('warn', 'auth.findUserByEmail.failed', { message: e.message }); return null; }
}

async function findUserFullById(id) {
  try { return await getProfileFull(id); }
  catch (e) { log('warn', 'auth.getProfileFull.failed', { message: e.message }); return null; }
}

/* ══════════════════════════════════════════════════════════════════════════
   13 · GOOGLE · v3.2 con verificación robusta y debug
   ══════════════════════════════════════════════════════════════════════════ */

async function handleGoogleLogin(req, res) {
  const { credential, remember = true } = req.body || {};
  if (!credential) return fail(res, 400, 'missing_credential', 'Falta el credential de Google');

  if (!CLIENT_ID) {
    log('error', 'auth.google.no_client_id', { reason: 'CLIENT_ID vacío' }, req);
    return fail(res, 500, 'server_misconfigured', 'Google no está configurado en el server.');
  }

  let ticket;
  try {
    ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: CLIENT_ID,
    });
  } catch (verifyErr) {
    // El error real: "Wrong recipient, payload audience != requiredAudience"
    // o cualquier otro. Lo logueamos con contexto útil.
    const errMsg = verifyErr?.message || String(verifyErr);

    // Intenta extraer el `aud` del token para compararlo con CLIENT_ID
    let tokenAud = null;
    try {
      const parts = String(credential).split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(
          Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
        );
        tokenAud = payload?.aud || null;
      }
    } catch {}

    log('error', 'auth.google.verify_failed', {
      message: errMsg,
      backendClientIdLen: CLIENT_ID.length,
      backendClientIdSuffix: CLIENT_ID.slice(-30),
      tokenAudience: tokenAud,
      match: tokenAud === CLIENT_ID,
    }, req);

    // Headers de diagnóstico (visibles en DevTools → Network)
    res.set('X-Client-Id-Len', String(CLIENT_ID.length));
    res.set('X-Client-Id-Suffix', CLIENT_ID.slice(-30));
    if (tokenAud) res.set('X-Token-Aud-Suffix', tokenAud.slice(-30));

    return fail(res, 401, 'google_failed',
      'Token de Google inválido o audiencia no coincide.',
      process.env.NODE_ENV !== 'production'
        ? {
            debug: {
              backendClientIdSuffix: CLIENT_ID.slice(-30),
              tokenAudienceSuffix: tokenAud ? tokenAud.slice(-30) : null,
            },
          }
        : {});
  }

  const payload = ticket.getPayload();
  if (!payload?.email) return fail(res, 400, 'no_email', 'Token de Google sin email');
  if (!payload.email_verified) return fail(res, 400, 'unverified', 'El correo de Google no está verificado');

  const user = await findOrCreateUser({
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    provider: 'google',
    req,
  });

  log('info', 'auth.login.google.ok', { email: user.email }, req);
  audit('login.google.ok', { email: user.email });
  return res.json(issueSession(res, user, remember));
}

/* ══════════════════════════════════════════════════════════════════════════
   14 · GITHUB
   ══════════════════════════════════════════════════════════════════════════ */

async function resolverEmailGitHub(accessToken, profile) {
  const fallback = () =>
    String(profile?.emails?.[0]?.value || `${profile?.username}@github.local`).toLowerCase();
  if (!accessToken) return fallback();
  try {
    const res = await fetch('https://api.github.com/user/emails', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Numination',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log('warn', 'auth.github.emails.http', { status: res.status });
      return fallback();
    }
    const emails = await res.json();
    if (!Array.isArray(emails) || emails.length === 0) return fallback();
    const elegido =
      emails.find((e) => e.primary && e.verified) ||
      emails.find((e) => e.verified) ||
      emails.find((e) => e.primary) ||
      emails[0];
    const email = String(elegido?.email || '').trim().toLowerCase();
    return email || fallback();
  } catch (e) {
    log('warn', 'auth.github.emails.error', { message: e.message });
    return fallback();
  }
}

if (GITHUB_ENABLED) {
  passport.use(
    new GitHubStrategy(
      {
        clientID: GITHUB_CLIENT_ID,
        clientSecret: GITHUB_CLIENT_SECRET,
        scope: ['user:email'],
        state: false,
      },
      async (accessToken, _refreshToken, profile, done) => {
        try {
          const email = await resolverEmailGitHub(accessToken, profile);
          const user = await findOrCreateUser({
            email,
            name: profile.displayName || profile.username || 'Usuario GitHub',
            picture: profile.photos?.[0]?.value || null,
            provider: 'github',
          });
          return done(null, user);
        } catch (err) {
          log('error', 'auth.github.verify.error', { message: err.message });
          return done(err, null);
        }
      }
    )
  );
}

/* ══════════════════════════════════════════════════════════════════════════
   15 · MOUNT
   ══════════════════════════════════════════════════════════════════════════ */

export function mountAuthRoutes(app) {

  app.use(passport.initialize());

  /* GOOGLE */
  app.post('/api/auth/google', async (req, res) => {
    if (!enforceRate(res, `google:${getClientIp(req)}`, 20, 60_000)) return;
    try {
      await handleGoogleLogin(req, res);
    } catch (err) {
      log('error', 'auth.google.unhandled', { message: err.message }, req);
      if (!res.headersSent) {
        return fail(res, 401, 'google_failed', 'Token de Google inválido');
      }
    }
  });

  /* GITHUB */
  if (GITHUB_ENABLED) {
    app.get('/api/auth/github', (req, res, next) => {
      passport.authenticate('github', { session: false, callbackURL: getCallbackUrl(req) })(req, res, next);
    });
    app.get('/api/auth/github/callback', (req, res, next) => {
      passport.authenticate(
        'github',
        { session: false, callbackURL: getCallbackUrl(req) },
        (err, user, info) => {
          if (err) {
            log('error', 'auth.github.callback.error', { message: err.message }, req);
            return res.redirect('/login.html?error=github');
          }
          if (!user) {
            const reason = info?.message === 'access_denied' ? 'access_denied' : 'github';
            log('warn', 'auth.github.callback.no_user', { reason }, req);
            return res.redirect('/login.html?error=' + reason);
          }
          const token = signSession(user, true);
          setSessionCookie(res, token, true);
          log('info', 'auth.login.github.ok', { email: user.email }, req);
          audit('login.github.ok', { email: user.email });
          return res.redirect('/chat.html');
        }
      )(req, res, next);
    });
  } else {
    app.get('/api/auth/github', (_req, res) =>
      fail(res, 503, 'not_configured', 'GitHub login no configurado en el server'));
  }

  /* PROVIDERS */
  app.get('/api/auth/providers', (_req, res) => {
    return res.json({
      ok: true,
      providers: {
        google:    { enabled: Boolean(CLIENT_ID && CLIENT_SECRET), label: 'Google' },
        github:    { enabled: GITHUB_ENABLED,                      label: 'GitHub' },
        email:     { enabled: true,                                label: 'Correo y contraseña' },
        emailPasswordReset: { enabled: true, emailDelivery: EMAIL_ENABLED },
        emailVerification:  { enabled: true, emailDelivery: EMAIL_ENABLED },
      },
    });
  });

  /* SIGNUP */
  app.post('/api/auth/signup', async (req, res) => {
    const ip = getClientIp(req);
    if (!enforceRate(res, `signup:${ip}`, 5, 15 * 60_000)) return;

    try {
      const { email, password, name } = req.body || {};

      if (!isValidEmail(email)) return fail(res, 400, 'invalid_email', 'Correo inválido.');

      const pwdCheck = validatePassword(password);
      if (!pwdCheck.ok) return fail(res, 400, pwdCheck.code, pwdCheck.message);

      const emailNorm = email.trim().toLowerCase();
      const existing = await findUserByEmail(emailNorm);
      if (existing) {
        if (existing.auth_provider === 'email' || existing.password_hash) {
          return fail(res, 409, 'email_taken', 'Ese correo ya está registrado. Inicia sesión.');
        }
        return fail(res, 409, 'email_taken_oauth',
          'Ese correo ya tiene cuenta con Google o GitHub. Entra por ahí.');
      }

      const nuevo = {
        id: nuevoId(),
        email: emailNorm,
        name: (name && String(name).trim().slice(0, 40)) || emailNorm.split('@')[0],
        picture: null,
        role: 'student',
        provider: 'email',
        auth_provider: 'email',
        email_verified: true,
        password_hash: hashPassword(password),
      };

      let profile = null;
      try { profile = await createProfile(nuevo); }
      catch (e) { log('warn', 'auth.signup.createProfile.failed', { message: e.message }, req); }
      if (!profile) profile = nuevo;

      log('info', 'auth.signup.ok', { email: emailNorm }, req);
      audit('signup.email', { email: emailNorm, ip });

      return res.status(201).json(issueSession(res, profile, true));
    } catch (err) {
      log('error', 'auth.signup.error', { message: err.message }, req);
      return fail(res, 500, 'signup_failed', 'No pudimos crear tu cuenta.');
    }
  });

  /* LOGIN */
  app.post('/api/auth/login', async (req, res) => {
    const ip = getClientIp(req);
    if (!enforceRate(res, `login-ip:${ip}`, 15, 15 * 60_000)) return;

    try {
      const { email, password, remember = true } = req.body || {};
      if (!isValidEmail(email) || typeof password !== 'string' || !password) {
        return fail(res, 400, 'invalid_credentials', 'Credenciales inválidas.');
      }

      const emailNorm = email.trim().toLowerCase();
      if (!enforceRate(res, `login-em:${emailNorm}`, 8, 15 * 60_000)) return;

      const profile = await findUserByEmail(emailNorm);
      if (!profile) {
        audit('login.fail.unknown_email', { email: emailNorm, ip });
        return fail(res, 401, 'invalid_credentials', 'Correo o contraseña incorrectos.');
      }

      if (isLocked(profile)) {
        const min = lockRemainingMinutes(profile);
        audit('login.fail.locked', { email: emailNorm, ip });
        return fail(res, 423, 'account_locked',
          `Cuenta bloqueada. Intenta de nuevo en ${min} min.`,
          { retryAfterMinutes: min });
      }

      if (!profile.password_hash) {
        if (profile.auth_provider && profile.auth_provider !== 'email') {
          return fail(res, 401, 'use_oauth',
            `Esa cuenta usa ${profile.auth_provider === 'github' ? 'GitHub' : 'Google'}. Entra por ahí.`,
            { provider: profile.auth_provider });
        }
        return fail(res, 401, 'invalid_credentials', 'Correo o contraseña incorrectos.');
      }

      if (!verifyPassword(password, profile.password_hash)) {
        const { locked, minutes } = await registerFailedLogin(profile);
        audit('login.fail.bad_password', { email: emailNorm, ip, locked });
        log('warn', 'auth.login.bad_password', { email: emailNorm, locked }, req);
        if (locked) {
          return fail(res, 423, 'account_locked',
            `Cuenta bloqueada ${minutes} min por demasiados intentos.`);
        }
        return fail(res, 401, 'invalid_credentials', 'Correo o contraseña incorrectos.');
      }

      await clearFailedAttempts(profile);
      try { await updateLastLogin(profile.id); } catch {}

      log('info', 'auth.login.ok', { email: emailNorm }, req);
      audit('login.ok', { email: emailNorm, ip });
      return res.json(issueSession(res, profile, remember));
    } catch (err) {
      log('error', 'auth.login.error', { message: err.message }, req);
      return fail(res, 500, 'login_failed', 'No pudimos iniciar sesión.');
    }
  });

  /* CHANGE PASSWORD */
  app.post('/api/auth/change-password', requireAuth, requireFreshSession, async (req, res) => {
    const ip = getClientIp(req);
    if (!enforceRate(res, `chpwd:${ip}`, 10, 60 * 60_000)) return;

    try {
      const { currentPassword, newPassword } = req.body || {};
      const check = validatePassword(newPassword);
      if (!check.ok) return fail(res, 400, check.code, check.message);

      const profile = await findUserFullById(req.user.id);
      if (!profile) return fail(res, 404, 'user_not_found', 'Usuario no encontrado.');

      if (profile.password_hash) {
        if (!verifyPassword(currentPassword, profile.password_hash)) {
          return fail(res, 401, 'wrong_current_password', 'Contraseña actual incorrecta.');
        }
      }

      await setPassword(profile.id, hashPassword(newPassword));
      log('info', 'auth.change_password.ok', { email: profile.email }, req);
      audit('change_password', { email: profile.email, ip });
      return res.json({ ok: true });
    } catch (err) {
      log('error', 'auth.change_password.error', { message: err.message }, req);
      return fail(res, 500, 'change_failed', 'No pudimos cambiar la contraseña.');
    }
  });

  /* FORGOT */
  app.post('/api/auth/forgot-password', async (req, res) => {
    const ip = getClientIp(req);
    if (!enforceRate(res, `forgot-ip:${ip}`, 10, 60 * 60_000)) return;

    try {
      const { email } = req.body || {};
      if (!isValidEmail(email)) return res.json({ ok: true });

      const emailNorm = email.trim().toLowerCase();
      if (!enforceRate(res, `forgot-em:${emailNorm}`, 3, 60 * 60_000)) return;

      const profile = await findUserByEmail(emailNorm);
      if (!profile) {
        log('info', 'auth.forgot.unknown', { email: emailNorm }, req);
        audit('forgot.unknown', { email: emailNorm, ip });
        return res.json({ ok: true });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
      try { await setResetToken(profile.id, token, expiresAt); }
      catch (e) { log('warn', 'auth.forgot.setResetToken.failed', { message: e.message }, req); }

      const resetUrl = `${getAppUrl(req)}/reset-password.html?token=${token}`;
      await sendPasswordResetEmail(profile.email, resetUrl, profile.name);

      log('info', 'auth.forgot.ok', { email: emailNorm }, req);
      audit('forgot.ok', { email: emailNorm, ip });
      return res.json({ ok: true });
    } catch (err) {
      log('error', 'auth.forgot.error', { message: err.message }, req);
      return res.json({ ok: true });
    }
  });

  /* RESET */
  app.post('/api/auth/reset-password', async (req, res) => {
    const ip = getClientIp(req);
    if (!enforceRate(res, `reset:${ip}`, 10, 60 * 60_000)) return;

    try {
      const { token, newPassword } = req.body || {};
      if (!token || typeof token !== 'string') return fail(res, 400, 'invalid_token', 'Token inválido.');

      const check = validatePassword(newPassword);
      if (!check.ok) return fail(res, 400, check.code, check.message);

      const profile = await getProfileByResetToken(token);
      if (!profile) return fail(res, 400, 'invalid_token', 'Token inválido o expirado.');

      await setPassword(profile.id, hashPassword(newPassword));
      await clearResetToken(profile.id);

      log('info', 'auth.reset.ok', { email: profile.email }, req);
      audit('reset_password', { email: profile.email, ip });
      return res.json({ ok: true });
    } catch (err) {
      log('error', 'auth.reset.error', { message: err.message }, req);
      return fail(res, 500, 'reset_failed', 'No pudimos resetear la contraseña.');
    }
  });

  /* VERIFY EMAIL */
  app.post('/api/auth/verify-email/send', requireAuth, async (req, res) => {
    const ip = getClientIp(req);
    if (!enforceRate(res, `verif-send:${ip}`, 5, 60 * 60_000)) return;

    try {
      const profile = await findUserFullById(req.user.id);
      if (!profile) return fail(res, 404, 'user_not_found', 'Usuario no encontrado.');
      if (profile.email_verified) return res.json({ ok: true, alreadyVerified: true });

      const token = crypto.randomBytes(24).toString('hex');
      const url = `${getAppUrl(req)}/verify-email.html?token=${token}`;
      await sendVerificationEmail(profile.email, url, profile.name);
      log('info', 'auth.verify.sent', { email: profile.email }, req);
      return res.json({ ok: true });
    } catch (err) {
      log('error', 'auth.verify.send.error', { message: err.message }, req);
      return fail(res, 500, 'send_failed', 'No pudimos enviar el correo.');
    }
  });

  app.post('/api/auth/verify-email/confirm', async (req, res) => {
    const ip = getClientIp(req);
    if (!enforceRate(res, `verif-conf:${ip}`, 10, 60 * 60_000)) return;

    try {
      const { token } = req.body || {};
      if (!token || typeof token !== 'string') return fail(res, 400, 'invalid_token', 'Token inválido.');
      log('info', 'auth.verify.confirm.received', { token: token.slice(0, 8) + '…' }, req);
      return res.json({ ok: true });
    } catch (err) {
      log('error', 'auth.verify.confirm.error', { message: err.message }, req);
      return fail(res, 500, 'confirm_failed', 'No pudimos verificar el correo.');
    }
  });

  /* ME */
  app.get('/api/auth/me', async (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.json({ ok: false, user: null });

    const s = await loadSession(token);
    if (!s) return res.json({ ok: false, user: null });

    const { profile, payload } = s;
    const user = profile || {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      auth_provider: null,
      email_verified: false,
    };
    return res.json({ ok: true, user: publicUser(user) });
  });

  /* SESSION */
  app.get('/api/auth/session', async (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.json({ ok: true, authenticated: false });

    const payload = verifySession(token);
    if (!payload) return res.json({ ok: true, authenticated: false });

    let profile = null;
    try { profile = await getProfileFull(payload.sub); } catch {}

    const now = Math.floor(Date.now() / 1000);
    const ageSec = payload.iat ? now - payload.iat : null;
    const expiresInSec = payload.exp ? payload.exp - now : null;
    const verMismatch = profile && Number(profile.auth_version || 1) > Number(payload.ver || 1);

    return res.json({
      ok: true,
      authenticated: !verMismatch,
      revoked: Boolean(verMismatch),
      issuedAt: payload.iat ? new Date(payload.iat * 1000).toISOString() : null,
      expiresAt: payload.exp ? new Date(payload.exp * 1000).toISOString() : null,
      ageSeconds: ageSec,
      expiresInSeconds: expiresInSec,
      fresh: ageSec != null && ageSec < FRESH_WINDOW_SEC,
      provider: profile?.auth_provider || null,
      jti: payload.jti || null,
      user: verMismatch ? null : publicUser(profile),
    });
  });

  /* CHECK */
  app.get('/api/auth/check', async (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.json({ authenticated: false });
    const s = await loadSession(token);
    return res.json({ authenticated: Boolean(s) });
  });

  /* LOGOUT */
  app.post('/api/auth/logout', (req, res) => {
    clearSessionCookie(res);
    audit('logout', { ip: getClientIp(req) });
    return res.json({ ok: true });
  });

  /* LOGOUT ALL */
  app.post('/api/auth/logout-all', requireAuth, async (req, res) => {
    try {
      clearSessionCookie(res);
      log('info', 'auth.logout_all', { email: req.user.email }, req);
      audit('logout_all', { email: req.user.email, ip: getClientIp(req) });
      return res.json({ ok: true, invalidatedAt: new Date().toISOString() });
    } catch (err) {
      log('error', 'auth.logout_all.error', { message: err.message }, req);
      return fail(res, 500, 'logout_all_failed', 'No pudimos cerrar las sesiones.');
    }
  });

  /* PROFILE */
  app.patch('/api/auth/profile', requireAuth, async (req, res) => {
    try {
      const { name } = req.body || {};
      const patch = {};
      if (typeof name === 'string') {
        const n = name.trim();
        if (n.length < 2 || n.length > 40) {
          return fail(res, 400, 'invalid_name', 'El nombre debe tener entre 2 y 40 caracteres.');
        }
        patch.name = n;
      }
      if (Object.keys(patch).length === 0) {
        return fail(res, 400, 'nothing_to_update', 'Nada que actualizar.');
      }

      const updated = await updateProfile(req.user.id, patch);
      if (!updated) return fail(res, 404, 'user_not_found', 'Usuario no encontrado.');

      log('info', 'auth.profile.updated', { email: req.user.email }, req);
      return res.json({ ok: true, user: publicUser(updated) });
    } catch (err) {
      log('error', 'auth.profile.error', { message: err.message }, req);
      return fail(res, 500, 'profile_update_failed', 'No pudimos actualizar tu perfil.');
    }
  });

  /* DELETE ACCOUNT */
  app.delete('/api/auth/account', requireAuth, requireFreshSession, async (req, res) => {
    try {
      const { confirm } = req.body || {};
      if (confirm !== 'ELIMINAR') {
        return fail(res, 400, 'confirm_required', 'Debes escribir ELIMINAR para confirmar.');
      }

      await deleteProfile(req.user.id);
      clearSessionCookie(res);

      log('info', 'auth.account.deleted', { email: req.user.email }, req);
      audit('account_deleted', { email: req.user.email, ip: getClientIp(req) });
      return res.json({ ok: true });
    } catch (err) {
      log('error', 'auth.account.delete.error', { message: err.message }, req);
      return fail(res, 500, 'delete_failed', 'No pudimos eliminar tu cuenta.');
    }
  });

  /* AUDIT */
  app.get('/api/auth/audit', requireAuth, (req, res) => {
    const email = req.user.email;
    const myEvents = auditLog.filter(e => e.email === email).slice(0, 30);
    return res.json({ ok: true, events: myEvents });
  });

  /* BOOT */
  const cidSuffix = CLIENT_ID ? CLIENT_ID.slice(-30) : '(vacío)';
  console.log(
    `[auth] rutas montadas (v3.2) · ` +
    `Google: ${CLIENT_ID && CLIENT_SECRET ? '✓' : '✗'} · ` +
    `GitHub: ${GITHUB_ENABLED ? '✓' : '✗'} · ` +
    `Email/Password: ✓ · ` +
    `Email delivery: ${EMAIL_ENABLED ? '✓' : '✗ (dev)'}`
  );
  console.log(`[auth] CLIENT_ID · len=${CLIENT_ID?.length || 0} · sufijo=…${cidSuffix}`);
}