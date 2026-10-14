# REPORTE-FIXES · Remediación de verga.md · 2026-10-14

Todos los fixes se verificaron en vivo contra server local (`:8080`,
`IP_GUARD=false`, DB Supabase real) antes de commitear. Detalle por
fase en `CHANGELOG-AUDIT.md`.

## Fases completadas (5/5)

| Fase | Commit | Estado |
|------|--------|--------|
| 1 · HIGH-001 logout server-side | `c1c9c39` | ✅ PoC invertido (cookie vieja → 401 + `revoked:true`) |
| 2 · HIGH-002 verify-email real | `6d58653` | ✅ fake → 400; flujo real 200; reuse → 400 |
| 3 · 6 MEDIUMs | `7d84aaa` | ✅ los 6 verificados vivos |
| 4 · 4 LOWs | `0776bf0` | ✅ los 4 verificados vivos |
| 5 · Regression tests | `99f3327` | ✅ 14/14 (`pass 14 · fail 0`) |

Nota: CRITICAL-001 ya estaba cerrado y commiteado en `6c07df5`
 anterior a este trabajo (se verificó: `git status` limpio al inicio,
 JWT tampering rechazado en la auditoría).

## Tests

- `node --test "tests/*.test.js"` → **14 pass, 0 fail** (6 unitarios
  + 8 integración HTTP con server + DB reales).
- `node --check` en cada archivo tocado, por fase.
- `npm run migrate` → 013 y 014 aplicadas (1/0 y 1/0, 0 fallidas).
- `scripts/smoke-test.js` actualizado al nuevo contrato de health
  (SKIP de detalle sin auth + nuevo `health-minimal-public`); no se
  corrió contra prod (requiere deploy).
- Ojo Windows: `node --test tests/` falla con MODULE_NOT_FOUND; usar
  el glob con comillas o `npm test`.

## Hallazgos NO resueltos y por qué

1. **M-006a · captcha para anónimos.** Requiere proveedor (Turnstile/
   reCAPTCHA) + claves + UX. Mitigado con (b) 1/min + (c) budget
   diario global 500. Recomendación: implementar captcha o exigir auth
   si el gasto de IA sube.
2. **L-005 parcial · enumeración por `code`.** Los mensajes ya no
   nombran el proveedor, pero los codes (`use_oauth`,
   `email_taken_oauth`, `provider`) se mantienen porque `login.html`
   los usa para guiar al botón correcto. Eliminarlos rompería el flujo
   de login. Riesgo residual: bajo.
3. **L-004 · RLS sin evidencia de aplicación.** Fuera de alcance de
   código (requiere aplicar `supabase-rls.sql` en el dashboard +
   test con anon-key). Sigue pendiente.
4. **Rotación de `JWT_SECRET`.** Pedida por CRITICAL-001 y por el
   régimen anterior sin revocación: hay que rotarla en Vercel +
   `env.local.js` y redeployar. Es operación del dueño, no código.
5. **Migraciones en prod.** 013/014 aplicadas solo en la DB que usa
   `DATABASE_URL` local. Aplicar en prod (`npm run migrate` o
   `POST /api/admin/migrations/run`) antes de deployar el código
   nuevo (el código es tolerante si faltan las tablas: fail-open con
   warn, pero sin tablas NO hay revocación real).
6. **Rama admin de `/api/health`.** Verificada por código + `node
   --check`, no en vivo (no hay admin local). El smoke-test con cookie
   admin la cubre post-deploy.
7. **`M-006c` multi-instancia.** El budget anon es por instancia; en
   Vercel el techo real ≈ 500 × N instancias. Centralizar en Upstash
   si se necesita techo exacto.

## Usuarios de prueba

Todos creados durante la verificación fueron eliminados de la DB
(`fase1/2/3/4@test.com`, incluido el del suite de regresión vía
`DELETE /api/auth/account`). Queda pendiente de la auditoría original:
`audit1@test.com` ("Hacker") y sus chats.
