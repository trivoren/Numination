/* ================================================================
   NUMINATION · auth.js
   ----------------------------------------------------------------
   Autenticación con Google OAuth + GitHub OAuth + sesiones JWT en
   cookies httpOnly. Persiste usuarios en Supabase (tabla profiles).
   ----------------------------------------------------------------
   Endpoints:
     POST /api/auth/google         → Google Identity Services (popup)
     GET  /api/auth/github         → inicia OAuth GitHub (redirect)
     GET  /api/auth/github/callback → callback OAuth GitHub
     GET  /api/auth/me             → usuario de la sesión activa
     POST /api/auth/logout         → cierra sesión
     GET  /api/auth/check          → ¿hay sesión activa?
   ================================================================ */

import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import passport from 'passport';
import { Strategy as GitHubStrategy } from 'passport-github';

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

const GITHUB_CLIENT_ID     = process.env.GITHUB_CLIENT_ID     ?? TEST_KEYS.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? TEST_KEYS.GITHUB_CLIENT_SECRET;

const COOKIE_NAME  = 'numination_session';
const SESSION_DAYS = 30;

if (!CLIENT_ID)     console.warn('⚠️  GOOGLE_CLIENT_ID no configurado');
if (!CLIENT_SECRET) console.warn('⚠️  GOOGLE_CLIENT_SECRET no configurado');
if (!JWT_SECRET)    console.warn('⚠️  JWT_SECRET no configurado');

const GITHUB_ENABLED = Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET);
if (!GITHUB_ENABLED) {
  console.warn('⚠️  GitHub OAuth no configurado (GITHUB_CLIENT_ID/SECRET faltantes)');
}

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

/**
 * Deriva la URL de callback OAuth desde el request.
 * Funciona en local (http://localhost:8080/...) y en Vercel (https://...)
 * siempre que la URL esté registrada en la GitHub OAuth App.
 */
function getCallbackUrl(req) {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  const host  = req.get('host') || 'localhost:8080';
  return `${proto}://${host}/api/auth/github/callback`;
}

/* ══════════════════════════════════════════════════════════════
   BÚSQUEDA / CREACIÓN DE USUARIO
   ══════════════════════════════════════════════════════════════ */

async function findOrCreateUser({ email, name, picture, provider = 'google' }) {
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
    provider,
  };

  try {
    profile = await createProfile(nuevo);
    if (profile) {
      console.log(`[auth] nuevo usuario (${provider}):`, key);
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

/* ══════════════════════════════════════════════════════════════
   EMAIL REAL DE GITHUB
   ══════════════════════════════════════════════════════════════ */

/**
 * Resuelve el email real de una persona que entra con GitHub.
 *
 * POR QUÉ EXISTE ESTA FUNCIÓN:
 * GitHub oculta el email cuando la persona lo tiene en privado. En ese caso
 * `profile.emails` llega vacío y antes usábamos `usuario@github.local`.
 * El problema: si esa misma persona después entraba con Google usando su
 * email real, Supabase no encontraba el perfil (busca por email) y creaba
 * una SEGUNDA cuenta. Quedabas con dos perfiles y los chats partidos en dos.
 *
 * PASOS (de mejor a peor):
 *   1. GET https://api.github.com/user/emails con el access_token
 *      → elegir el que sea primary:true Y verified:true
 *   2. Si no hay, el primer email verificado
 *   3. Si no hay, el email público del perfil
 *   4. Si no hay nada, usuario@github.local (último recurso)
 *
 * IMPORTANTE: si GitHub falla, NO se tumba el login. Caemos al fallback.
 *
 * @param {string} accessToken  Token que GitHub entrega tras el login
 * @param {object} profile      Perfil que entrega passport-github
 * @returns {Promise<string>}   Email en minúsculas
 */
async function resolverEmailGitHub(accessToken, profile) {
  const fallback = () =>
    String(profile?.emails?.[0]?.value || `${profile?.username}@github.local`)
      .toLowerCase();

  // Sin token no hay nada que consultar con la API de GitHub
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
      console.warn(
        `[auth/github] /user/emails respondió ${res.status} → uso el fallback`
      );
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
    console.warn('[auth/github] no pude leer /user/emails:', e.message);
    return fallback();
  }
}

/* ══════════════════════════════════════════════════════════════
   ESTRATEGIA GITHUB (Passport)
   ══════════════════════════════════════════════════════════════ */

if (GITHUB_ENABLED) {
  passport.use(
    new GitHubStrategy(
      {
        clientID: GITHUB_CLIENT_ID,
        clientSecret: GITHUB_CLIENT_SECRET,
        // callbackURL se pasa por request (para soportar local + Vercel)
        scope: ['user:email'],
        // Sin sessions en el server → desactivamos el state de CSRF
        // (nuestra auth ya usa JWT en cookie httpOnly)
        state: false,
      },
      async (accessToken, _refreshToken, profile, done) => {
        try {
          // GitHub puede ocultar el email si es privado → lo consultamos por API
          const email = await resolverEmailGitHub(accessToken, profile);

          const user = await findOrCreateUser({
            email,
            name: profile.displayName || profile.username || 'Usuario GitHub',
            picture: profile.photos?.[0]?.value || null,
            provider: 'github',
          });

          return done(null, user);
        } catch (err) {
          console.error('[auth/github] verify falló:', err.message);
          return done(err, null);
        }
      }
    )
  );
}

/* ══════════════════════════════════════════════════════════════
   RUTAS
   ══════════════════════════════════════════════════════════════ */

export function mountAuthRoutes(app) {

  // Inicializa passport (ligero, sin sesiones)
  app.use(passport.initialize());

  /* ─────────────────────────────────────────────────────────────
     POST /api/auth/google
     ───────────────────────────────────────────────────────────── */
  app.post('/api/auth/google', async (req, res) => {
    try {
      const { credential, remember = true } = req.body || {};

      if (!credential) {
        return res.status(400).json({ error: 'Falta el credential de Google' });
      }

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
      console.error('[auth] error en Google:', err.message);
      return res.status(401).json({ error: 'Token de Google inválido' });
    }
  });

  /* ─────────────────────────────────────────────────────────────
     GET /api/auth/github
     Inicia el flujo OAuth → redirige a GitHub
     ───────────────────────────────────────────────────────────── */
  if (GITHUB_ENABLED) {
    app.get('/api/auth/github', (req, res, next) => {
      passport.authenticate('github', {
        session: false,
        callbackURL: getCallbackUrl(req),
      })(req, res, next);
    });

    /* ───────────────────────────────────────────────────────────
       GET /api/auth/github/callback
       GitHub devuelve aquí con el code → verificamos → sesión
       ─────────────────────────────────────────────────────────── */
    app.get('/api/auth/github/callback', (req, res, next) => {
      passport.authenticate(
        'github',
        {
          session: false,
          callbackURL: getCallbackUrl(req),
        },
        (err, user, info) => {
          // ── Error de red o verificación
          if (err) {
            console.error('[auth/github] callback error:', err.message);
            return res.redirect('/login.html?error=github');
          }

          // ── Usuario canceló o falló el flujo
          if (!user) {
            const reason = info?.message === 'access_denied'
              ? 'access_denied'
              : 'github';
            console.warn('[auth/github] sin user:', reason);
            return res.redirect('/login.html?error=' + reason);
          }

          // ── Éxito: firmar JWT y redirigir al chat
          const token = signSession(user, true);
          setSessionCookie(res, token, true);

          console.log('[auth] login GitHub OK:', user.email);
          return res.redirect('/chat.html');
        }
      )(req, res, next);
    });
  } else {
    // Si GitHub no está configurado, el endpoint responde 503
    app.get('/api/auth/github', (_req, res) => {
      res.status(503).json({ error: 'GitHub login no configurado en el server' });
    });
  }

  /* ─────────────────────────────────────────────────────────────
     GET /api/auth/me
     ───────────────────────────────────────────────────────────── */
  app.get('/api/auth/me', async (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.json({ ok: false, user: null });

    const payload = verifySession(token);
    if (!payload) return res.json({ ok: false, user: null });

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
     ───────────────────────────────────────────────────────────── */
  app.post('/api/auth/logout', (_req, res) => {
    clearSessionCookie(res);
    return res.json({ ok: true });
  });

  /* ─────────────────────────────────────────────────────────────
     GET /api/auth/check
     ───────────────────────────────────────────────────────────── */
  app.get('/api/auth/check', (req, res) => {
    const token = req.cookies?.[COOKIE_NAME];
    return res.json({ authenticated: Boolean(token && verifySession(token)) });
  });

  console.log(
    `[auth] rutas montadas (Supabase) · Google: ✓ · GitHub: ${GITHUB_ENABLED ? '✓' : '✗'}`
  );
}