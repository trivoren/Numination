/* ================================================================
   NUMINATION · auth.js
   Google OAuth + JWT + Supabase como almacenamiento.
   ================================================================ */

import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import {
  getProfileByEmail,
  createProfile,
  updateLastLogin,
  supabaseDisponible,
} from './services/supabase.js';

let TEST_KEYS = {};
try {
  const mod = await import('../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID ?? TEST_KEYS.GOOGLE_CLIENT_ID;
const JWT_SECRET = process.env.JWT_SECRET ?? TEST_KEYS.JWT_SECRET;

const COOKIE_NAME = 'numination_session';
const SESSION_DAYS = 30;

if (!CLIENT_ID) console.warn('⚠️  GOOGLE_CLIENT_ID no configurado');
if (!JWT_SECRET) console.warn('⚠️  JWT_SECRET no configurado');

const googleClient = new OAuth2Client(CLIENT_ID);

/* ── Sesiones JWT ── */
function signSession(user, remember = true) {
  const expiresIn = remember ? `${SESSION_DAYS}d` : '1d';
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      name: user.name,
      picture: user.picture,
      role: user.role || 'student',
      plan: user.plan || 'free',
    },
    JWT_SECRET,
    { expiresIn }
  );
}

function verifySession(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

function userFromPayload(payload) {
  return {
    id: payload.sub,
    email: payload.email,
    name: payload.name,
    picture: payload.picture,
    role: payload.role || 'student',
    plan: payload.plan || 'free',
  };
}

/* ── Cookies ── */
function setSessionCookie(res, token, remember = true) {
  const maxAge = remember ? SESSION_DAYS * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const isProd = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/* ── Encontrar o crear usuario ── */
async function findOrCreateUser({ email, name, picture, provider }) {
  const key = email.toLowerCase();

  // 1. Buscar en Supabase
  let user = await getProfileByEmail(key);

  if (user) {
    await updateLastLogin(user.id);
    return user;
  }

  // 2. Crear nuevo
  const id = 'u-' + crypto.randomBytes(8).toString('hex');
  user = await createProfile({
    id,
    email: key,
    name: name || key.split('@')[0],
    picture: picture || null,
  });

  if (!user) {
    // Fallback: usuario en memoria si Supabase falla
    console.warn('[auth] Supabase falló, usando usuario en memoria');
    user = {
      id,
      email: key,
      name: name || key.split('@')[0],
      picture: picture || null,
      role: 'student',
      plan: 'free',
    };
  }

  return user;
}

/* ── Middlewares ── */
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

      const user = await findOrCreateUser({
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
      return res.status(401).json({ error: 'Token de Google inválido' });
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

  console.log(`[auth] rutas montadas (${supabaseDisponible() ? 'Supabase' : 'sin DB'})`);
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    role: user.role || 'student',
    plan: user.plan || 'free',
    createdAt: user.created_at || user.createdAt,
  };
}