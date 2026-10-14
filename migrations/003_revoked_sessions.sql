-- ═══════════════════════════════════════════════════════════════════
-- NUMINATION · migrations/003_revoked_sessions.sql
-- ───────────────────────────────────────────────────────────────────────────
-- HIGH-001 · Revocación de sesiones server-side.
--
-- Problema: POST /api/auth/logout solo borraba la cookie. El JWT seguía
-- válido 30 días (stateless, sin denylist).
--
-- Esta migración crea la tabla denylist de JTIs revocados y garantiza la
-- columna profiles.auth_version (para logout-all).
--
-- NOTA: el runner oficial es el registry en src/services/migrations.js
-- (entrada 2026_10_14_013_session_revocation, `npm run migrate`). Este
-- archivo .sql existe como referencia auditable y para aplicarlo a mano
-- en el SQL Editor de Supabase si se prefiere.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.revoked_sessions (
  jti        text PRIMARY KEY,
  user_id    uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS revoked_sessions_user_idx
  ON public.revoked_sessions (user_id);

CREATE INDEX IF NOT EXISTS revoked_sessions_expires_idx
  ON public.revoked_sessions (expires_at);

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS auth_version integer DEFAULT 1;

UPDATE public.profiles
SET auth_version = 1
WHERE auth_version IS NULL;
