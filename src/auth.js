/* ================================================================
   NUMINATION · auth.js
   ----------------------------------------------------------------
   Autenticación con Google OAuth + sesiones JWT en cookies httpOnly.
   Persiste usuarios en Supabase (tabla profiles).
   ----------------------------------------------------------------
   Endpoints:
     POST /api/auth/google   → verifica credential de Google, crea usuario
     GET  /api/auth/me       → devuelve usuario de la sesión activa
     POST /api/auth/logout   → cierra sesión (borra cookie)
     GET  /api/auth/check    → ¿hay sesión activa?
   ================================================================ */

import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

import {
  getProfile,
  getProfileByEmail,
  createProfile,
  updateLastLogin,
} from './services/supabase.js';

/* ══════════════════════════════════════════════════════════════
   CONFIGURACIÓN
   ══════════════════════════════════════════════════════════════ */

let TEST_KEYS = {};
try {
  const mod = await import('../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     ?? TEST_KEYS.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ?? TEST_KEYS.GOOGLE_CLIENT_SECRET;
const JWT_SECRET    = process.env.JWT_SECRET           ?? TEST_KEYS.JWT_SECRET;

const COOKIE_NAME  = 'numination_session';
const SESSION_DAYS = 30;

if (!CLIENT_ID)     console.warn('⚠️  GOOGLE_CLIENT_ID no configurado');
if (!CLIENT_SECRET) console.warn('⚠️  GOOGLE_CLIENT_SECRET no configurado');
if (!JWT_SECRET)    console.warn('⚠️  JWT_SECRET no configurado');

const googleClient = new OAuth2Client(CLIENT_ID);

/* ══════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════ */

/**
 * Genera un UUID v4 válido para la columna uuid de Postgres.
 * crypto.randomUUID() → "f47ac10b-58cc-4372-a567-0e02b2c3d479"
 */
function nuevoId() {
  return crypto.randomUUID();
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
    role: user.role,
  };
}

/* ══════════════════════════════════════════════════════════════
   BÚSQUEDA / CREACIÓN DE USUARIO
   ══════════════════════════════════════════════════════════════ */

async function findOrCreateUser({ email, name, picture }) {
  const key = String(email).toLowerCase();

  // 1) Buscar en Supabase por email
  let profile = null;
  try {
    profile = await getProfileByEmail(key);
  } catch (e) {
    console.warn('[auth] getProfileByEmail falló:', e.message);
  }

  // 2) Si existe → actualizar lastLogin + devolver
  if (profile) {
    try {
      await updateLastLogin(profile.id);
    } catch (e) {
      console.warn('[auth] updateLastLogin falló:', e.message);
    }
    return profile;
  }

  // 3) Si no existe → crear con UUID válido
  const nuevo = {
    id: nuevoId(),
    email: key,
    name: name || key.split('@')[0],
    picture: picture || null,
    role: 'student',
  };

  try {
    profile = await createProfile(nuevo);
    if (profile) {
      console.log('[auth] nuevo usuario creado:', key);
      return profile;
    }
  } catch (e) {
    console.warn('[auth] createProfile falló:', e.message);
  }

  // 4) Fallback en memoria (si Supabase falla, al menos la sesión funciona)
  console.warn('[auth] usando usuario en memoria (no persistido)');
  return nuevo;
}

/* ══════════════════════════════════════════════════════════════
   SESIONES (JWT)
   ══════════════════════════════════════════════════════════════ */

function signSession(user, remember = true) {
  const expiresIn = remember ? `${SESSION_DAYS}d` : '1d';
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role || 'student' },
    JWT_SECRET,
    { expiresIn }
  );
}

function verifySession(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

function setSessionCookie(res, token, remember = true) {
  const maxAge = remember
    ? SESSION_DAYS * 24 * 60 * 60 * 1000
    : 24 * 60 * 60 * 1000;

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

/* ══════════════════════════════════════════════════════════════
   MIDDLEWARE
   ══════════════════════════════════════════════════════════════ */

/** Adjunta req.user si hay sesión activa (no bloquea) */
export function attachUser(req, _res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return next();

  const payload = verifySession(token);
  if (!payload) return next();

  req.user = {
    id: payload.sub,
    email: payload.email,
    role: payload.role || 'student',
  };
  next();
}

/** Bloquea si no hay sesión activa */
export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'No autenticado' });

  const payload = verifySession(token);
  if (!payload) return res.status(401).json({ error: 'Sesión inválida o expirada' });

  req.user = {
    id: payload.sub,
    email: payload.email,
    role: payload.role || 'student',
  };
  next();
}

/** Carga el perfil completo desde Supabase (opcional) */
export async function loadProfile(req, _res, next) {
  if (req.user?.id) {
    try {
      const profile = await getProfile(req.user.id);
      if (profile) req.user = { ...req.user, ...profile };
    } catch (e) {
      console.warn('[auth] loadProfile falló:', e.message);
    }
  }
  next();
}

/* ══════════════════════════════════════════════════════════════
   RUTAS
   ══════════════════════════════════════════════════════════════ */

export function mountAuthRoutes(app) {

  /* ─────────────────────────────────────────────────────────────
     POST /api/auth/google
     Recibe el credential de Google (JWT) y crea/verifica sesión.
     ───────────────────────────────────────────────────────────── */
  app.post('/api/auth/google', async (req, res) => {
    try {
      const { credential, remember = true } = req.body || {};

      if (!credential) {
        return res.status(400).json({ error: 'Falta el credential de Google' });
      }

      // Verificar el ID token de Google
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: CLIENT_ID,
      });

      const payload = ticket.getPayload();
      if (!payload?.email) {
        return res.status(400).json({ error: 'Token de Google sin email' });
      }

      if (!payload.email_verified) {
        return res.status(400).json({ error: 'El correo de Google no está verificado' });
      }

      // Crear o recuperar usuario en Supabase
      const user = await findOrCreateUser({
        email: payload.email,
        name: payload.name,
        picture: payload.picture,
      });

      // Firmar JWT y setear cookie
      const token = signSession(user, remember);
      setSessionCookie(res, token, remember);

      console.log('[auth] login Google OK:', user.email);

      return res.json({ ok: true, user: publicUser(user) });
    } catch (err) {
      console.error('[auth] error en Google:', err.message);
      return res.status(401).json({ error: 'Token de Google inválido' });
    }
  });

  /* ─────────────────────────────────────────────────────────────
     GET /api/auth/me
     Devuelve el usuario de la sesión activa.
     ───────────────────────────────────────────────────────────── */
  app.get('/api/auth/me', async (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.json({ ok: false, user: null });

    const payload = verifySession(token);
    if (!payload) return res.json({ ok: false, user: null });

    // Intentar cargar perfil completo desde Supabase
    let profile = null;
    try {
      profile = await getProfile(payload.sub);
    } catch (e) {
      console.warn('[auth] getProfile falló:', e.message);
    }

    const user = profile || {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
    };

    return res.json({ ok: true, user: publicUser(user) });
  });

  /* ─────────────────────────────────────────────────────────────
     POST /api/auth/logout
     Cierra sesión (borra cookie).
     ───────────────────────────────────────────────────────────── */
  app.post('/api/auth/logout', (_req, res) => {
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  /* ─────────────────────────────────────────────────────────────
     GET /api/auth/check
     ¿Hay sesión activa? (sin detalles del usuario)
     ───────────────────────────────────────────────────────────── */
  app.get('/api/auth/check', (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    return res.json({ authenticated: Boolean(token && verifySession(token)) });
  });

  console.log('[auth] rutas montadas (Supabase)');
}