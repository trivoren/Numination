/* ================================================================
   NUMINATION · auth.js
   Google OAuth + sesiones JWT.
   - Local: guarda usuarios en data/users.json
   - Producción (Vercel): sin escritura a disco, JWT stateless
   ================================================================ */

import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ── Detectar entorno ── */
const IS_VERCEL = process.env.VERCEL === '1';
const CAN_WRITE = !IS_VERCEL; // Vercel = read-only

/* ── Cargar credenciales ── */
let TEST_KEYS = {};
try {
  const mod = await import('../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? TEST_KEYS.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? TEST_KEYS.GOOGLE_CLIENT_SECRET;
const JWT_SECRET = process.env.JWT_SECRET ?? TEST_KEYS.JWT_SECRET;

const COOKIE_NAME = 'numination_session';
const SESSION_DAYS = 30;
const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');

if (!CLIENT_ID) console.warn('⚠️  GOOGLE_CLIENT_ID no configurado');
if (!JWT_SECRET) console.warn('⚠️  JWT_SECRET no configurado');

const googleClient = new OAuth2Client(CLIENT_ID);

/* ── Caché en memoria para producción (vive mientras el lambda esté caliente) ── */
const memoryUsers = new Map();

/* ── Storage de usuarios ── */
function ensureDataDir() {
  if (!CAN_WRITE) return;
  const dir = path.dirname(USERS_FILE);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '{}', 'utf-8');
  } catch (e) {
    console.warn('[auth] no se pudo crear data dir:', e.message);
  }
}

function loadUsers() {
  if (!CAN_WRITE) return {}; // En producción siempre vacío
  try {
    ensureDataDir();
    const raw = fs.readFileSync(USERS_FILE, 'utf-8').trim();
    if (!raw || raw === '{}') return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

function saveUsers(users) {
  if (!CAN_WRITE) return false; // En Vercel, no escribe
  try {
    ensureDataDir();
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
    return true;
  } catch (e) {
    console.warn('[auth] save failed:', e.message);
    return false;
  }
}

/* ── Buscar o crear usuario ── */
function findOrCreateUser({ email, name, picture, provider }) {
  const key = email.toLowerCase();

  // Caché en memoria primero (para producción)
  if (memoryUsers.has(key)) {
    const user = memoryUsers.get(key);
    user.lastLogin = Date.now();
    user.name = name || user.name;
    user.picture = picture || user.picture;
    return user;
  }

  // En local, revisar JSON
  if (CAN_WRITE) {
    const users = loadUsers();
    if (users[key]) {
      users[key].lastLogin = Date.now();
      users[key].name = name || users[key].name;
      users[key].picture = picture || users[key].picture;
      saveUsers(users);
      memoryUsers.set(key, users[key]);
      return users[key];
    }
  }

  // Crear nuevo usuario
  const user = {
    id: 'u-' + crypto.randomBytes(8).toString('hex'),
    email: key,
    name: name || key.split('@')[0],
    picture: picture || null,
    provider: provider || 'google',
    createdAt: Date.now(),
    lastLogin: Date.now(),
    role: 'student',
    verified: true,
  };

  // Guardar
  memoryUsers.set(key, user);

  if (CAN_WRITE) {
    const users = loadUsers();
    users[key] = user;
    saveUsers(users);
  }

  return user;
}

/* ── JWT ── */
function signSession(user, remember = true) {
  const expiresIn = remember ? `${SESSION_DAYS}d` : '1d';
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      role: user.role,
    },
    JWT_SECRET,
    { expiresIn }
  );
}

function verifySession(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

/* ── Cookies ── */
function setSessionCookie(res, token, remember = true) {
  const maxAge = remember
    ? SESSION_DAYS * 24 * 60 * 60 * 1000
    : 24 * 60 * 60 * 1000;

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true, // Vercel siempre HTTPS
    sameSite: 'lax',
    maxAge,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/* ── Construir usuario desde el JWT ── */
function userFromPayload(payload) {
  return {
    id: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    role: payload.role || 'student',
  };
}

/* ── Middleware ── */
export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  const payload = verifySession(token);
  if (!payload) return res.status(401).json({ error: 'Sesión inválida' });

  req.user = userFromPayload(payload);
  next();
}

export function attachUser(req, _res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    const payload = verifySession(token);
    if (payload) req.user = userFromPayload(payload);
  }
  next();
}

/* ── Rutas ── */
export function mountAuthRoutes(app) {
  app.post('/api/auth/google', async (req, res) => {
    try {
      const { credential, remember = true } = req.body || {};
      if (!credential) return res.status(400).json({ error: 'Falta credential' });

      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: CLIENT_ID,
      });

      const payload = ticket.getPayload();
      if (!payload?.email) return res.status(400).json({ error: 'Token sin email' });
      if (!payload.email_verified) return res.status(400).json({ error: 'Email no verificado' });

      const user = findOrCreateUser({
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
        provider: 'google',
      });

      const token = signSession(user, remember);
      setSessionCookie(res, token, remember);

      console.log('[auth] login Google OK:', user.email);
      return res.json({ ok: true, user: publicUser(user) });
    } catch (err) {
      console.error('[auth] error Google:', err.message);
      return res.status(401).json({ error: 'Token de Google inválido: ' + err.message });
    }
  });

  app.get('/api/auth/me', (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.json({ ok: false, user: null });

    const payload = verifySession(token);
    if (!payload) return res.json({ ok: false, user: null });

    return res.json({ ok: true, user: userFromPayload(payload) });
  });

  app.post('/api/auth/logout', (_req, res) => {
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  app.get('/api/auth/check', (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    return res.json({ authenticated: Boolean(token && verifySession(token)) });
  });

  console.log(`[auth] rutas montadas (${CAN_WRITE ? 'con persistencia JSON' : 'stateless / producción'})`);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    role: user.role,
    createdAt: user.createdAt,
  };
}