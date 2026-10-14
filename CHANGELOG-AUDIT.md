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

---

## FASE 2 · HIGH-002 · verify-email valida token de verdad ✅

**Commit:** `fix(audit): HIGH-002 verify-email valida token de verdad`

**Hallazgo:** `POST /api/auth/verify-email/confirm` devolvía `{ok:true}`
sin verificar nada (PoC: `{"token":"cualquiera"}` → 200).

**Cambios:**
- `src/services/migrations.js`: migración
  `2026_10_14_014_email_verification` (tabla
  `email_verification_tokens`: id, user_id, token_hash UNIQUE,
  expires_at, used_at, created_at). Aplicada (1/0).
- `src/services/supabase.js`: `createEmailVerifyToken`,
  `getValidEmailVerifyToken` (solo no-usados y no-expirados),
  `consumeEmailVerifyToken` (single-use atómico por `used_at is
  null`), `setEmailVerified`, más prune oportunista.
- `src/auth.js`: `send` persiste el sha256 del token (15 min,
  `VERIFY_WINDOW_MIN`) antes de enviar el mail — nunca viaja ni se
  guarda el token en claro; `confirm` hashea, valida, consume y marca
  `email_verified:true`. Token ausente/inválido/expirado/reutilizado
  → 400 `invalid_token` (mismo mensaje para no enumerar).

**Verificación viva:**
- `{"token":"cualquiera"}` → 400 (antes 200) ✅
- Flujo real: signup → send → token del log dev → confirm → 200 ✅
- Reuse del mismo token → 400 ✅
- DB: `email_verified=true` tras confirmar ✅
- Usuario `fase2@test.com` eliminado.

**No resuelto / caveats:**
- Si el insert falla (DB caída), el mail igual se envía (fail-open
  como antes) pero el confirm dará 400 con "solicitá un nuevo link".
- Sin `RESEND_API_KEY` los mails solo se loguean (dev) — igual que
  antes; no exponer esos logs.

---

## FASE 3 · MEDIUMs baratos ✅

**Commit:** `fix(audit): MEDIUMs - query token, email verified, CSP,
stack, OAuth state, chat anon`

**3.1 · M-001 · query-token denegado por defecto** (`middleware/auth.js`)
- `allowQueryToken` ahora exige `AUTH_ALLOW_QUERY_TOKEN=true`
  explícito (antes `!== 'false'`). Verificado: ningún lector SSE ni
  frontend usa `?token=` de sesión (solo el token de un solo uso de
  verify-email en URL, no afectado).
- Self-test interno actualizado al nuevo default.
- Vivo: JWT válido por `?token=` sin cookie → 401 (antes 200) ✅

**3.2 · M-002 · email_verified fail-closed** (`auth.js`, `supabase.js`)
- Signup email: `false`. OAuth Google: `true` (Google lo afirma y el
  handler rechaza `!email_verified`); GitHub: `false` (sin señal
  fiable; el fallback `@github.local` nunca es verificado).
- `createProfile` respeta `payload.email_verified` explícito.
- `normalizeProfile`: `=== true` (antes `!== false` que hacía NULL →
  verificado).
- Vivo: signup → DB `email_verified=false` ✅

**3.3 · M-003 · CSP** (`index.js`, `vercel.json`)
- Header `Content-Security-Policy` en ambas capas. `unsafe-inline` en
  script/style es TEMPORAL con TODO (hay inline en chat/login).
  Verificado con curl en `/login` ✅

**3.4 · M-004 · stack traces** (`errors.js`, `index.js`)
- `errorMiddleware` acepta `includeStackForLocalOnly` (default true):
  el stack solo sale si el peer TCP es loopback, mirando
  `socket.remoteAddress` — NO `req.ip` (spoofeable con trust proxy).
- Regex de redacción ampliado a `C:/Users/...` con slashes (los stacks
  de Node mezclan formatos). Vivo: `file:///[REDACTED]/Desktop/...`
  (el usuario del SO ya no filtra) ✅

**3.5 · M-005 · GitHub OAuth state** (`auth.js`)
- State HMAC propio (`ts.rand.hmac`, TTL 10 min, `timingSafeEqual`),
  sin express-session (dependencia nueva evitada a propósito).
- `/api/auth/github` lo envía (passport lo propaga: verificado en el
  `Location: ...&state=...` vivo ✅); el callback sin state válido →
  `/login?error=state` (verificado vivo ✅).
- Sin `JWT_SECRET` no hay state posible (se omite; logueado en
  diagnóstico de arranque si falta).

**3.6 · M-006 · chat anónimo** (`limits.js`, sin exigir auth por
decisión de producto)
- `LIMITS_ANON_PER_MIN` default 3 → 1. Vivo: `verificarLimite` anon →
  `porMin: 1` ✅
- Presupuesto diario global anon (`LIMITS_ANON_DAILY_BUDGET`, default
  500): excedido → denegado con `razon: 'anon_budget'` y mensaje que
  invita a crear cuenta. En memoria por instancia (multi-instancia
  multiplica el techo; documentado — centralizar en Upstash a futuro).
- NO implementado: captcha (3.6a, requiere proveedor/claves). Queda
  como recomendación en REPORTE-FIXES.md.

---

## FASE 4 · LOWs ✅

**Commit:** `fix(audit): LOWs - health minimo, cookie secure, escapado
server, mensajes unificados`

**4.1 · L-001 · health mínimo** (`index.js`, `scripts/smoke-test.js`)
- `/api/health` sin admin → solo `{ok, service, version, uptime,
  ts}`. El detalle (keys/modelos/subsistemas) solo con `role:admin`.
  Vivo: público mínimo ✅
- `smoke-test.js`: `health-db`/`health-engines` hacen SKIP sin cookie
  (antes fallarían contra el health mínimo); nuevo test
  `health-minimal-public` que falla si el health público expone
  `keys/models/engines/subsystems/features`.

**4.2 · L-002 · Secure** (`auth.js`)
- `setSessionCookie`/`clearSessionCookie` aceptan `req`: `Secure` si
  prod/Vercel **o** `req.secure` **o** `x-forwarded-proto:https`.
  Todos los call-sites pasan `req`. El `clear` usa los mismos
  atributos (si no, algunos browsers no borran cookie Secure).
- Vivo: localhost HTTP → sin Secure (correcto); con
  `X-Forwarded-Proto: https` → con Secure ✅

**4.3 · L-003 · títulos sin HTML** (`chats.js`)
- Nuevo `stripTags` (exportado para tests) aplicado en POST y PATCH de
  chats. El contenido de mensajes NO se toca (lo necesita el markdown
  del frontend, que escapa primero).
- Vivo: `{"title":"<img src=x onerror=alert(1)>"}` → guardado como
  `Nuevo chat`, sin `<>` en la API ✅

**4.4 · L-005 · mensajes unificados** (`auth.js`)
- Ambos mensajes ya no nombran el proveedor. Los `code`
  (`email_taken_oauth`, `use_oauth`) y el campo `provider` se
  mantienen porque `login.html` los usa para guiar al botón correcto
  (quitarlos rompería el flujo). Mitigación parcial y documentada: un
  atacante determinado aún puede enumerar por code, pero la API cruda
  ya no filtra "Google vs GitHub".
- Vivo: signup duplicado email → `email_taken` genérico ✅ (rama
  OAuth verificada solo por código, sin OAuth local).

---

## FASE 5 · Tests de regresión ✅

**Commit:** `test(audit): regression tests de los fixes`

**Archivo:** `tests/audit-regression.test.js` (primero del repo; `npm
test` antes no tenía qué correr — `node --test tests/` además falla
en Windows con MODULE_NOT_FOUND; usar `node --test "tests/*.test.js"`
o `npm test`).

**Cobertura (14 tests, todos pasando):**
- Unitarios sin server (6): stack gating del errorMiddleware
  (off/remoto/local), redacción `C:/Users`, `stripTags`, anon
  `porMin=1`.
- Integración HTTP contra server vivo + DB real (8): signup no
  verificado, query-token→401, signup duplicado sin proveedor,
  verify falso→400, CSP, health mínimo, bad JSON→400+requestId,
  logout→revocado (session + chats 401).
- El suite crea UN solo usuario por run (email con timestamp) y lo
  borra en `after()` vía login fresco + `DELETE /api/auth/account`.
- Si no hay server en `AUDIT_BASE_URL` (default `:8080`), el `before()`
  falla con el comando exacto para levantarlo.

**Resultado:** `ℹ pass 14 · fail 0` ✅
