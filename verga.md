# Auditoría brutal · Numination · 2026-10-14

**Auditor:** pentester senior + security auditor + QA + SRE (agente, read-only).
**Alcance:** `C:\Users\EMILIO\Desktop\Numination\numination ai web` — commit `a02b887` + working tree sin commitear.
**Stack:** Node.js v24 (engines pide ≥22), Express 5.2.1 ESM, Supabase Postgres, JWT en cookie `nm-session`, frontend vanilla en `public/`.
**Metodología:** análisis estático (grep de secretos, código peligroso, endpoints, config), `npm audit`, `npm outdated`, server local levantado (`node src/index.js`, puerto 8080, `IP_GUARD=false`) + batería dinámica real: signup, login, session, JWT tampering (payload, alg:none, bogus), logout-reuse, privesc, IDOR (código + 1 intento vivo), rate-limit (20 logins), inyecciones (SQLi/NoSQLi/XSS), CORS, SSRF vía `url_fetch`, backup-cron, impersonación, DoS (body 11 MB), info disclosure (stack, health, archivos sensibles), render frontend.
**Regla de oro aplicada:** todo lo que digo "vulnerable" tiene PoC con comando + output. Lo que no pude probar dice NO VERIFICABLE o TEÓRICA.

---

## Resumen ejecutivo

El sistema **en el working tree actual (con los fixes sin commitear) está razonablemente defendido en autenticación básica**: passwords con scrypt + `timingSafeEqual`, validación de email/password, rate-limit de login que sí corta (429 al 7º intento), JWT con verificación de firma real (payload manipulado y `alg:none` rechazados), CORS con allowlist estricta, SSRF bloqueado en `url_fetch` (probado contra `169.254.169.254` y `localhost`), IDOR mitigado por scoping `userId` en todas las queries de chats, y renderer markdown propio que escapa antes de formatear.

**Pero hay dos problemas graves:**

1. **El código que realmente se deploya (git HEAD, lo que Vercel compila) contiene un backdoor de autenticación.** El "interceptor v6" y el `verifyToken` de HEAD aceptan JWT sin verificar firma, aceptan cualquier token opaco como admin, y si no hay token buscan el primer perfil de la DB o inventan un usuario `role:'admin', plan:'team'`. El fix existe **solo en el working tree sin commitear**. Cualquier deploy desde git = takeover total. Esto es lo primero que atacaría, y es lo primero que hay que arreglar (commitear + redeploy + rotar `JWT_SECRET`).
2. **Dos fallas lógicas vivas incluso con el fix:** el logout no mata la sesión en el servidor (el JWT sigue válido 30 días) y `/api/auth/verify-email/confirm` acepta cualquier token (`{"ok":true}` sin verificar nada).

**¿Lo pondría en producción?** El working tree: sí, después de corregir los 2 HIGH lógicos + commitear el fix + los MEDIUM baratos (CSP, query-token, email_verified). El HEAD commiteado: **no, bajo ninguna circunstancia** — está comprometido por diseño.

---

## Scorecard

| Categoría | Score | Nota |
|-----------|-------|------|
| Autenticación | 6/10 | Login/signup sólidos y rate-limit real; pero logout no revoca y verify-email es stub. HEAD commiteado = 0/10 (backdoor). |
| Autorización | 7/10 | Admin correctamente 403, privesc ignorado, IDOR scopeado por userId; impersonación solo admin. Resta logout-reuse. |
| Validación de input | 7/10 | SQLi/NoSQLi/XSS en auth rechazados; SSRF bloqueado en vivo; markdown escapa. Pero títulos/chats guardan HTML crudo (frágil) y body 20 MB. |
| Criptografía | 7/10 | scrypt 64B + timingSafeEqual + JWT HS256 verificado + HMAC webhooks. Sin `ENCRYPTION_KEY_*` en el entorno (warning vivo). |
| Configuración | 5/10 | Sin CSP, HSTS/Secure solo en prod, stack traces en dev, `trust proxy: 1`, GitHub `state:false`, health con info. CORS bien. |
| Rate limiting | 8/10 | IP 500/min + login 15/8 por 15 min + signup 5/15 min, todos verificados vivos (429 real, sin bypass por XFF). |
| Info disclosure | 5/10 | Stack + paths absolutos en errores dev, health revela keys/models/env, pero sin `.env`/`.git`/fuente expuestos. |
| Dependencias | 9/10 | `npm audit`: 0 vulns. Solo minors desactualizados. Sin postinstall. |
| Client-side | 8/10 | `__nm.esc` + markdown escape-first + links solo http(s); sin tokens en storage. `eval` solo en demo calculadora no alcanzable. |
| Logging | 6/10 | Logger con redacción de `gsk_/AIza/sk-` etc.; pero auth loguea emails y auth.js loguea links de reset en consola (dev). |
| **TOTAL** | **68/100** | Working tree. HEAD commiteado: **~20/100** (auth bypass total). |

## Conteo de hallazgos

| Severidad | Cantidad |
|-----------|----------|
| 🔴 CRITICAL | 1 (HEAD commiteado: auth bypass total; el fix vive solo en working tree) |
| 🟠 HIGH | 2 (logout no revoca; verify-email stub) |
| 🟡 MEDIUM | 6 (query-token, email auto-verificado, sin CSP, stack en dev, OAuth sin state, chat anónimo quema cuota) |
| 🔵 LOW | 5 (health info, Secure solo prod, HTML crudo en API, RLS sin evidencia de aplicación, signup enumera OAuth vs email) |
| ⚪ INFO | 3 (eval no alcanzable, minors outdated, audit-log propio) |

---

## Hallazgos

### [CRITICAL-001] Backdoor de autenticación en git HEAD — el fix no está commiteado
- **Ubicación:** `src/index.js` (interceptor v6, HEAD) · `src/middleware/auth.js` (verifyToken ESTRATEGIA 1/2, HEAD)
- **CVSS v3.1:** 10.0 (Critical) · `AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H`
- **CWE:** CWE-287 (Improper Authentication) · CWE-798-equivalente (credencial/modo debug en código)
- **Descripción:** El código commiteado en HEAD (`a02b887` y anteriores `b3bfeaf`, `b25cf25`, "auth ultra permisivo (modo debug)") hace tres cosas: (1) decodifica el JWT con `Buffer.from(parts[1],'base64url')` sin verificar la firma; (2) si el token es opaco, lo acepta igual con `role:'admin'`; (3) el interceptor de `index.js`, sin usuario válido, busca el primer perfil de la DB y atiende como ese usuario, y en el `catch` asigna `req.user = { id: fallbackId, email:'fallback@numination.app', role:'admin', plan:'team' }`. El working tree actual elimina todo eso (comentario `FIX-NUM-2026`) y verifica firma con `jsonwebtoken` — **pero `git status` muestra esos archivos como `M` sin commitear**, así que Vercel (que compila desde git) deploya el código vulnerable.
- **Impacto:** Account takeover de cualquier usuario + admin gratis, sin credenciales: basta pedir `/api/chats` sin cookie (te atiende como el primer perfil de la DB) o mandar cualquier string como cookie `nm-session`.
- **PoC (Proof of Concept):**
  ```
  $ git show HEAD:src/index.js | Select-String 'fallback@numination'
      req.user = { id: fallbackId, email: 'fallback@numination.app', role: 'admin', plan: 'team' };
  $ git show HEAD:src/middleware/auth.js | Select-String 'aceptar cualquier'
    // ESTRATEGIA 2: TOKEN OPAQUE · aceptar cualquier cosa
  $ git status --short   # src/index.js y src/middleware/auth.js figuran como M (no commiteados)
  ```
  No se explotó en vivo porque el server levantado corre el working tree ya fixeado (los tests de JWT tampering abajo lo confirman). Contra HEAD sería explotación trivial; no se levantó HEAD a propósito para no dejar un bypass abierto.
- **Recomendación:** commitear YA el fix, redeploy inmediato, rotar `JWT_SECRET`/`SESSION_SECRET` (todas las sesiones emitidas bajo el régimen vulnerable son sospechosas), prohibir commits con la palabra "permisivo/debug" sin revisión (hook o CI `git log --grep`), y añadir test que falle si `req.user` se asigna fuera de `verifyToken`/`loadSession`.
- **Estado verificado:** en el working tree el bypass está cerrado (ver HIGH/INFO de JWT tampering: payload manipulado → `authenticated:false`, `alg:none` → `authenticated:false`).

### [HIGH-001] Logout no invalida la sesión en el servidor (JWT reutilizable 30 días)
- **Ubicación:** `src/auth.js:1127` (`POST /api/auth/logout` solo hace `clearSessionCookie`) + `src/middleware/auth.js:1064` (`invalidateSession` recorre cache en memoria, nunca se llama desde logout; `logout-all` tampoco bumpa `auth_version`)
- **CVSS v3.1:** 7.5 (High) · `AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:N`
- **CWE:** CWE-613 (Insufficient Session Expiration)
- **Descripción:** El JWT dura 30 días (`SESSION_DAYS = 30`) y es stateless. El logout solo borra la cookie del navegador. El token viejo sigue verificando firma y la API lo acepta.
- **Impacto:** Robo de cookie/token (XSS en otro subdominio, máquina compartida, backup de disco) = acceso por 30 días aunque la víctima haga logout. El "logout en dispositivo robado" no sirve.
- **PoC:**
  ```
  $ curl -s -D lo-h.txt -o NUL -X POST http://localhost:8080/api/auth/logout -H "Cookie: nm-session=<JWT>"
  Set-Cookie: nm-session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT   # cookie borrada solo en cliente
  $ curl -s http://localhost:8080/api/auth/session -H "Cookie: nm-session=<MISMO_JWT>"
  {"ok":true,"authenticated":true,...,"expiresInSeconds":2591943,...}  # HTTP 200, sigue viva
  ```
- **Recomendación:** mantener denylist de `jti` revocados (Supabase/Redis con TTL = exp) consultada en `verifyToken`/`loadSession`; o bump de `auth_version` en logout-all + `clearResetToken`-style; documentar que el logout actual es solo cliente.

### [HIGH-002] `/api/auth/verify-email/confirm` acepta cualquier token
- **Ubicación:** `src/auth.js:1053-1066`
- **CVSS v3.1:** 7.4 (High) · `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:H/A:N`
- **CWE:** CWE-287 (Improper Authentication)
- **Descripción:** El handler no consulta nada: loguea los primeros 8 chars y devuelve `{ok:true}`. No hay tabla de tokens de verificación (el `send` genera un token random pero ni lo persiste).
- **Impacto:** Hoy impacto limitado porque el signup ya marca `email_verified:true` (ver MEDIUM-002) y nada exige verificación; pero cualquier flujo futuro que confíe en este endpoint (puertas premium, `requireVerifiedEmail`) nace roto. Además miente al frontend.
- **PoC:**
  ```
  $ curl -s -X POST http://localhost:8080/api/auth/verify-email/confirm \
      -H 'Content-Type: application/json' -d '{"token":"cualquier-cosa"}'
  {"ok":true}   # HTTP 200, token inventado
  ```
- **Recomendación:** persistir token hasheado + expiración + single-use como el reset-password, o eliminar el endpoint hasta implementarlo.

### [MEDIUM-001] Token de sesión aceptado por query string (`?token=`)
- **Ubicación:** `src/middleware/auth.js:76` (`allowQueryToken`, default true) + `extractToken` (línea 584)
- **CVSS v3.1:** 5.3 (Medium) · `AV:N/AC:H/PR:N/UI:R/S:U/C:H/I:N/A:N`
- **CWE:** CWE-598 (Sensitive Data in Query String)
- **Descripción:** La sesión viaja también en `?token=`. Queda en logs de proxy, historial, `Referer`, y paneles.
- **Impacto:** Filtración silenciosa de sesiones de 30 días.
- **PoC:**
  ```
  $ curl -s "http://localhost:8080/api/chats?token=<JWT>"   # sin cookie
  {"ok":true,"chats":[...]}   # HTTP 200, auténtica por URL
  ```
- **Recomendación:** `AUTH_ALLOW_QUERY_TOKEN=false` por defecto; permitir query-token solo en el endpoint SSE estrictamente necesario, con tokens de un solo uso y corta vida.

### [MEDIUM-002] Signup auto-verifica el email (`email_verified:true` sin verificar nada)
- **Ubicación:** `src/auth.js:861` (`email_verified: true` en `nuevo`); OAuth `src/auth.js:591` igual
- **CVSS v3.1:** 5.3 (Medium) · `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:N`
- **CWE:** CWE-287
- **Descripción:** Cualquier signup con email ajeno nace "verificado". El flujo de verificación existe en UI pero no tiene efecto real (ver HIGH-002).
- **Impacto:** Suplantación de identidad por email, password-reset a casillas no propias con cuenta "verificada", y `requireVerifiedEmail` inútil.
- **PoC:** `POST /api/auth/signup {"email":"audit1@test.com",...}` → `201` con `"emailVerified":false` en respuesta pública pero fila con `email_verified:true` (contradicción pública/DB; el `send` de verificación devuelve `alreadyVerified` para estos usuarios — código línea 1040).
- **Recomendación:** crear con `email_verified:false`, exigir verificación para acciones sensibles, unificar `publicUser` con la DB.

### [MEDIUM-003] Sin `Content-Security-Policy` (ni en código ni en `vercel.json`)
- **Ubicación:** `src/index.js:864` (headers) + `vercel.json:8` (headers)
- **CVSS v3.1:** 5.8 (Medium) · `AV:N/AC:L/PR:N/UI:R/S:U/C:L/I:L/A:N`
- **CWE:** CWE-693 (Protection Mechanism Failure)
- **Descripción:** Hay `X-Content-Type-Options`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy`, `Permissions-Policy` — pero ninguna CSP. Verificado en vivo: ningún `Content-Security-Policy` en respuestas.
- **Impacto:** Ante cualquier XSS futuro (o CDN comprometido), no hay segunda barrera; el admin/chat quedan expuestos a exfiltración.
- **PoC:** `curl -s -D - -o NUL http://localhost:8080/login | Select-String 'Content-Security'` → vacío.
- **Recomendación:** CSP estricta (`default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'self'`) + `report-uri`; validar que el inline actual de `chat.html` se externalice o noncee.

### [MEDIUM-004] Stack traces + paths absolutos en errores (dev)
- **Ubicación:** `src/index.js` (`errorMiddleware({ includeStack: !IS_PROD })`) + `src/middleware/errors.js:768` (`normalizeError` con `stack`)
- **CVSS v3.1:** 5.3 (Medium) · `AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N`
- **CWE:** CWE-209 (Information Exposure Through an Error Message)
- **Descripción:** Con `NODE_ENV=development` (el valor vivo del server auditado), cualquier JSON malformado devuelve `stack` con paths absolutos del disco (`C:\Users\EMILIO\...`) y código interno.
- **Impacto:** Reconocimiento gratis (usuario del SO, estructura de carpetas, versiones de Express/router). En Vercel (`NODE_ENV=production`) se oculta — pero el server corre en dev hoy.
- **PoC:**
  ```
  $ curl -s -X POST http://localhost:8080/api/auth/signup -H 'Content-Type: application/json' -d 'not-json{{{'
  {"ok":false,...,"stack":"ValidationError: ...\n    at normalizeError (file:///C:/Users/EMILIO/Desktop/Numination/numination%20ai%20web/src/middleware/errors.js:768:12)\n ..."}  # HTTP 400
  ```
- **Recomendación:** `includeStack` solo si `NODE_ENV!=='production'` **y** IP local; correr prod siempre con `NODE_ENV=production`.

### [MEDIUM-005] GitHub OAuth sin `state` (CSRF de login)
- **Ubicación:** `src/auth.js:742` (`state: false`)
- **CVSS v3.1:** 4.3 (Medium) · `AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:N`
- **CWE:** CWE-352 (Cross-Site Request Forgery)
- **Descripción:** Sin `state`, un atacante puede fijar su cuenta de GitHub en el navegador de la víctima (login CSRF) vía `/api/auth/github/callback`.
- **Impacto:** La víctima opera sin saberlo en la cuenta del atacante (o viceversa según flujo); clásico pero real.
- **PoC:** estático (no se explotó: requiere app GitHub real y red externa — NO VERIFICABLE en vivo).
- **Recomendación:** `state: true` con store de sesión + verificación en el callback.

### [MEDIUM-006] `/api/chat` y `/api/chat/stream` sin autenticación (anónimos queman cuota de IA paga)
- **Ubicación:** `src/index.js:1741`, `src/index.js:2313` (sin `requireAuth`; anon con `LIMITS_ANON_PER_MIN=3`)
- **CVSS v3.1:** 5.3 (Medium) · `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L`
- **CWE:** CWE-770 (Allocation of Resources Without Limits)
- **Descripción:** Decisión de producto (probar sin cuenta), pero cada request anónimo gasta Groq/Gemini/Kimi del server. El límite anon (3/min por IP) se verificó en código (`src/services/limits.js:53,170,284`); el IP se toma de `req.ip` con `trust proxy: 1`.
- **Impacto:** Abuso barato con rotación de IP/proxies para agotar cuota y generar costo; además expone los motores a prompt-injection masivo.
- **PoC (código):** `app.post('/api/chat/stream', async (req,res)=>` sin middleware de auth; `verificarLimite` usa `req.user?.id || ip:...`. No se bombardeó el endpoint para no quemar cuota real.
- **Recomendación:** exigir auth para chat, o captcha + límites anon mucho más duros + presupuesto separado + alertas de gasto.

### [LOW-001] `/api/health` revela presencia de keys, modelos, env y subsistemas
- **Ubicación:** `src/index.js:1006` (público, sin auth)
- **CVSS v3.1:** 3.7 (Low) · `AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N`
- **CWE:** CWE-200
- **PoC:** `curl -s http://localhost:8080/api/health` → `{"env":"development","models":{...},"keys":{"groq":true,"gemini_1":true,...},"subsystems":{"database":{"connected":true,...}}}` (HTTP 200).
- **Recomendación:** health público mínimo (`ok/version`) y detalle solo con `requireAdmin`.

### [LOW-002] Cookie sin `Secure` fuera de prod + `HSTS` solo en prod
- **Ubicación:** `src/auth.js:409`, `src/index.js:869`
- **CVSS v3.1:** 3.1 (Low) · resto igual. **CWE:** CWE-614.
- **PoC:** `Set-Cookie: nm-session=...; HttpOnly; SameSite=Lax` sin `Secure` con `NODE_ENV=development` (verificado en signup/login vivos). En Vercel/prod se activa — correcto, pero el entorno actual corre en dev.
- **Recomendación:** `Secure` siempre salvo `localhost`; correr todo lo que no sea laptop con `NODE_ENV=production`.

### [LOW-003] La API devuelve HTML crudo; la seguridad XSS vive solo en el render
- **Ubicación:** `src/chats.js` (`title` sin sanitizar), `sanitizeMessage` (línea 524: solo trim+slice)
- **CVSS v3.1:** 3.5 (Low) · **CWE:** CWE-116.
- **PoC:** `POST /api/chats {"title":"<img src=x onerror=alert(1)>"}` → `201` y el GET devuelve el payload intacto. El frontend lo neutraliza (`__nm.esc(c.title)`, markdown escape-first — verificado), así que hoy no ejecuta. Pero cualquier cliente nuevo (app móvil, embed) que no escape, ejecuta.
- **Recomendación:** sanitizar/escapar en el servidor también (defensa en profundidad) o servir títulos ya escapados + test de contrato.

### [LOW-004] RLS de Supabase existe en repo pero sin evidencia de aplicación
- **Ubicación:** `src/services/supabase-rls.sql` (untracked `??`), `src/middleware/rls.js` (untracked)
- **CWE:** CWE-284. **Nota:** el backend usa service-role (bypassa RLS por diseño) y scopea por `userId` en cada query (verificado: `where id::text = ${chatId} and "userId" = ...` con tagged templates parametrizados). Si alguna vez se expone la anon-key en cliente, sin RLS aplicado hay lectura total. NO VERIFICABLE desde afuera si el SQL se aplicó en el dashboard.
- **Recomendación:** aplicar el SQL en Supabase, test de intrusión con anon-key, y commitear `rls.js`/SQL.

### [LOW-005] Login/signup distinguen cuenta OAuth de cuenta email (enumeración parcial)
- **Ubicación:** `src/auth.js:849` (`email_taken_oauth` vs `email_taken`), `src/auth.js:910` (`use_oauth` revela proveedor)
- **CWE:** CWE-204. El login con password incorrecta vs email inexistente sí unifica mensaje (`invalid_credentials` — bien), y forgot siempre `ok:true` (bien). Pero el signup y el login-OAuth revelan si un email existe y con qué proveedor.
- **Recomendación:** mensaje único en signup/login siempre que sea posible.

### [INFO-001] `eval()` en `sandbox.js` no es explotable
- `src/services/sandbox.js:411` (`String(eval(current))`) vive dentro de un template de **demo calculadora cliente**, sin ruta que lo exponga en servidor. Sin hallazgo.

### [INFO-002] Dependencias sanas, solo minors atrás
- `npm audit --json`: **0 vulnerabilidades** (145 prod). `npm outdated`: `@google/genai 2.24→2.29`, `express 5.2.1→5.3.0`, `openai 7.23→7.33`, `google-auth-library`, `nodemailer`, `@supabase/supabase-js` patch. Sin `postinstall`. Actualizar en ventana normal.

### [INFO-003] JWT del working tree resiste tampering (verificado en vivo)
- Payload con `role:admin` re-firmado con firma original → `{"authenticated":false}` 200. `alg:none` → `authenticated:false`. Cookie inventada → `authenticated:false`. Admin sin auth → 401 `AUTH_NO_TOKEN`; como user → 403 `AUTH_ROLE_INSUFFICIENT`; privesc `{role:admin,plan:team}` ignorado (sigue `student/free`).

---

## Verificaciones con resultado "Sin hallazgos" (honestidad brutal)

- **Secretos hardcodeados:** solo valores demo/test (`DEMO_KEY`, `secreto123`, `sk-xxx`, `test-secret`) en código y docs. `env.local.js` / `.env.local` con keys reales existen en disco pero están en `.gitignore` y **no** trackeados (`git ls-files` no los lista). `.env.example` solo placeholders.
- **SQL injection:** `postgres` con tagged templates en todo `supabase.js`; payloads `' OR '1'='1`, NoSQL `{"$gt":""}` y XSS en login → 400/401 limpios, sin errores Postgres ni timing anómalo.
- **SSRF en tools:** `url_fetch` a `169.254.169.254` → `Host bloqueado por seguridad (IP privada)`; a `localhost:8080` → `Host bloqueado`. Blocklist + `isPrivateIP` + resolución DNS verificadas en `tools.js:100-111,645-685`.
- **CORS:** `evil.com` no recibe `Access-Control-Allow-Origin`; origen permitido sí, con `Vary: Origin` y sin `*` + credentials. Bien.
- **Rate-limit bypass por `X-Forwarded-For`:** con IP falsa el login siguió en 429 (el bucket por email/IP aguantó).
- **IDOR en chats (código):** `obtenerChat/renombrarChat/eliminarChat/crearMensaje` filtran por `userId`; el intento vivo con segundo usuario no concluyó por rate-limit de signup (429, que a su vez confirma el límite) — marcado como verificación por código + 1 prueba parcial, no como explotado.
- **Backup cron:** sin secreto → 401 correcto (`X-Cron-Secret` exigido).
- **Impersonación no-admin:** header `X-Impersonate-Id` como user normal → ignorado, devuelve datos propios.
- **DoS body grande:** 11 MB → 400 sin caída (límite `jsonLimit 20mb` + validación). No se probó Slowloris/OOM a propósito en DB real.
- **Frontend storage:** solo theme/UI en `localStorage`; sesión solo en cookie httpOnly. Sin `postMessage` ni service worker sensible encontrados.

## NO VERIFICABLE (razón)

- GitHub/Google OAuth completos (requieren apps reales y red externa con credenciales).
- Envío real de emails (sin `RESEND_API_KEY`; el server loguea links en consola en dev — no exponer esos logs).
- RLS aplicado en el dashboard Supabase (requiere acceso al proyecto).
- Race conditions de doble gasto (requieren IA/cuota y concurrencia real; no se bombardeó para no quemar cuota).
- `logout-all` con bump de `auth_version` (sin segundo dispositivo a mano).

---

## Apéndice · Comandos y outputs (evidencia mínima)

```
$ node --version / npm --version            → v24.18.0 / 11.16.0
$ npm audit --json                          → 0 vulnerabilidades (145 deps prod)
$ npm outdated                              → 7 minors (express 5.2.1→5.3.0, openai 7.23→7.33, ...)
$ curl -s -o NUL -w '%{http_code}' /api/ping → 200
$ / → 302 · /login → 200 · /chat → 302 (sin sesión) · /nonexistent → 404
$ /.env /package.json /.git/config /src/index.js /env.local.js → 404 · /api/auth/audit sin auth → 401
$ POST /api/auth/signup válido              → 201 + Set-Cookie nm-session (HttpOnly, SameSite=Lax, Path=/, sin Secure en dev)
$ POST /api/auth/signup duplicado           → 409 · password "1" → 400 · email inválido → 400
$ POST /api/auth/login válido               → 200 + cookie · password mala → 401 mensaje unificado
$ 20 logins malos seguidos                  → 401×6 luego 429×14 (rate-limit real)
$ GET /api/auth/session válida              → authenticated:true · bogus/tampered/alg:none → authenticated:false
$ GET /api/chats?token=<JWT>                → 200 con datos (MEDIUM-001)
$ GET /api/admin/metrics sin auth → 401 · como user → 403 · privesc PATCH ignorado
$ POST /api/auth/logout                     → cookie borrada en cliente, pero JWT reuse → authenticated:true (HIGH-001)
$ POST /api/auth/verify-email/confirm {"token":"cualquier-cosa"} → {"ok":true} (HIGH-002)
$ POST /api/chats {"title":"<img src=x onerror=alert(1)>"} → 201, GET lo devuelve crudo (LOW-003)
$ POST /api/tools/execute url_fetch 169.254 → "Host bloqueado por seguridad (IP privada)"
$ POST /api/admin/backup/cron sin secreto   → 401
$ POST signup con body no-JSON              → 400 CON stack + paths absolutos (MEDIUM-004)
$ Headers vivos: X-Content-Type-Options, X-Frame-Options SAMEORIGIN, Referrer-Policy,
  Permissions-Policy presentes; Content-Security-Policy ausente; HSTS ausente en dev
$ CORS Origin:https://evil.com              → sin ACAO · Origin permitido → ACAO + credentials + Vary: Origin
$ Body 11 MB a /api/chat                    → 400 sin caída
```

## Datos de prueba creados (limpieza)

- `audit1@test.com` (user `Hacker`, verificado en signup/login/IDOR/XSS-rate tests). El segundo signup (`audit2@test.com`) fue bloqueado por rate-limit (429) así que no existe. No se pudo borrar `audit1` por API (el delete exige sesión fresca y el login quedó rate-limitado al final de la batería). **Borrar `audit1@test.com` y los chats `<img src=x...>` / `chat-de-A` desde Supabase** antes de dar por cerrada la auditoría.

---

## Plan de remediación (orden CISO)

1. **Hoy (CRITICAL):** commitear el fix de auth, redeploy, rotar `JWT_SECRET` (+ `SESSION_SECRET`, `SUPABASE_JWT_SECRET` si existen), invalidar todas las sesiones (bump `auth_version` global), revisar logs de accesos anómalos bajo HEAD vulnerable.
2. **Esta semana (HIGH):** revocación server-side de JWT en logout + implementar de verdad verify-email (o borrar el endpoint).
3. **Esta semana (MEDIUM barato):** `AUTH_ALLOW_QUERY_TOKEN=false`, `email_verified:false` por defecto, CSP, `includeStack` solo local, `state:true` en GitHub, auth o captcha en `/api/chat`.
4. **Próximo sprint (LOW):** health mínimo público, escapar en servidor, aplicar RLS + test con anon-key, unificar mensajes OAuth, `Secure` siempre salvo localhost, `npm outdated` al día.
5. **Proceso:** prohibir "modo debug/permisivo" sin revisión, test que falle si `req.user` se asigna sin verificar firma, y repetir esta batería contra staging con `NODE_ENV=production` antes de cada release.
