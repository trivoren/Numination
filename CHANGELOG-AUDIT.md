# CHANGELOG-AUDIT · Remediación de verga.md (2026-10-14)

Registro por fase de los fixes aplicados sobre los hallazgos de la
auditoría `verga.md`. Un commit por fase. Si un fix rompe algo,
`git revert` de esa fase y se documenta acá.

---

## FASE 1 · HIGH-001 · Logout revoca sesión server-side ✅

**Commit:** `fix(audit): HIGH-001 logout revoca sesion server-side`

**Hallazgo:** `POST /api/auth/logout` solo borraba la cookie; el JWT
seguía válido 30 días (PoC: reuse → `authenticated:true`).

**Cambios:**
- `src/services/migrations.js`: migración
  `2026_10_14_013_session_revocation` (tabla `revoked_sessions` +
  garantiza `profiles.auth_version`). Aplicada con `npm run migrate`
  (1 aplicada, 0 fallidas).
- `migrations/003_revoked_sessions.sql`: mismo DDL como referencia
  auditable / aplicación manual en Supabase.
- `src/services/supabase.js`: helpers `revokeSession(jti, userId,
  expiresAt)` (con prune oportunista de expirados), `isSessionRevoked
  (jti)`, `bumpAuthVersion(userId)`; `getProfileFull` ahora selecciona
  `auth_version` y `normalizeProfile` lo expone (antes el check de
  `loadSession` comparaba `undefined` → no-op silencioso).
- `src/middleware/auth.js`: `verifyToken` consulta la denylist por `jti`
  tras verificar firma (fail-open sin DB, con warn); `attachUser`
  compara `auth_version` de DB vs `ver` firmado (logout-all);
  nuevo export `revokeTokenCache(token)` para purga inmediata del
  cache de 30s en esta instancia.
- `src/auth.js`: `loadSession` chequea denylist; `logout` revoca el jti
  (best-effort), purga caches y borra cookie; `logout-all` revoca el
  jti actual + hace bump de `auth_version` (mata todas las sesiones en
  todas las instancias) + purga caches; `/api/auth/session` responde
  `revoked:true` cuando la firma es válida pero el jti está revocado.
- Tokens legacy sin `jti`: no revocables por denylist (solo cookie +
  cache); se loguea `auth.logout.no_jti`. Todos los tokens nuevos
  llevan `jti` desde `signSession`.

**Verificación viva (server local :8080):**
- signup → session `authenticated:true` → logout → session con cookie
  vieja: `{"authenticated":false,"revoked":true}` (antes: true) ✅
- `/api/chats` con cookie vieja → 401 ✅
- login → logout-all → session: `authenticated:false, revoked:true` ✅
- Usuario de prueba `fase1@test.com` eliminado de la DB.

**No resuelto / caveats:**
- Sin DB (`sql` null) los checks son fail-open (igual que el resto de
  la capa sb). Documentado en código.
- `revoked_sessions` debe aplicarse también en prod
  (`npm run migrate` o endpoint admin `/api/admin/migrations/run`).
