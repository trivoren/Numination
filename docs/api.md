# Numination · API Reference

> **v7.0.0** · Numi OT · "La IA para los que resuelven problemas"

Documentación completa de los ~75 endpoints de la API de Numination.

---

## Tabla de contenidos

- [Introducción](#introducción)
- [Autenticación](#autenticación)
- [Formato de errores](#formato-de-errores)
- [Rate limiting](#rate-limiting)
- [Códigos de estado](#códigos-de-estado)
- [Health & Version](#health--version)
- [Auth](#auth)
- [Chats](#chats)
- [Chat & IA](#chat--ia)
- [Memorias](#memorias)
- [Proyectos](#proyectos)
- [Skills](#skills)
- [Conectores](#conectores)
- [Email](#email)
- [Límites y uso](#límites-y-uso)
- [Errores comunes](#errores-comunes)
- [Ejemplos avanzados](#ejemplos-avanzados)

---

## Introducción

### URL base

```
Producción:   https://numinationchat.vercel.app
Desarrollo:   http://localhost:8080
```

### Convenciones

- Todos los endpoints empiezan con `/api/`
- Todas las respuestas son JSON (`Content-Type: application/json`)
- Excepto `/api/chat/stream` que es **SSE** (`text/event-stream`)
- Los IDs son UUID v4 en formato string
- Los timestamps son ISO 8601 en UTC

### Estructura de respuesta

**Éxito:**
```json
{
  "ok": true,
  "data": { ... }
}
```

**Error:**
```json
{
  "ok": false,
  "error": "Mensaje legible",
  "code": "codigo_de_error",
  "requestId": "abc12345"
}
```

### Headers comunes

Todas las respuestas incluyen:

| Header | Descripción |
|---|---|
| `X-Request-Id` | ID único del request (para correlacionar logs) |
| `X-RateLimit-Limit` | Límite del rate limit actual |
| `X-RateLimit-Remaining` | Requests restantes en la ventana |
| `X-RateLimit-Reset` | Segundos hasta que se resetee |

Las respuestas de error incluyen:

| Header | Descripción |
|---|---|
| `Retry-After` | Segundos a esperar antes de reintentar (solo 429/423) |

---

## Autenticación

### Métodos soportados

1. **Google OAuth** (Identity Services)
2. **GitHub OAuth**
3. **Email + contraseña**

### Sesión

Todas las sesiones son **JWT firmados** guardados en cookie `numination_session`:

```
Set-Cookie: numination_session=<JWT>; HttpOnly; SameSite=Lax; Secure; Path=/
```

El JWT incluye:
```json
{
  "sub": "user-uuid",
  "email": "user@example.com",
  "role": "student",
  "ver": 1,
  "jti": "abc123",
  "iat": 1728000000,
  "exp": 1730592000
}
```

- `sub` — user ID
- `ver` — versión de sesión (sube al cambiar contraseña)
- `jti` — ID único del token
- Expira en **30 días** (o **1 día** si `remember: false`)

### Cómo autenticar requests

Desde el navegador:
```javascript
fetch('/api/chats', {
  credentials: 'include',   // ← incluye cookies
})
```

Desde curl:
```bash
curl -b "numination_session=<JWT>" https://numinationchat.vercel.app/api/chats
```

Desde Postman/Insomnia:
- Cookie: `numination_session=<JWT>`

### Endpoints que NO requieren auth

- `GET /api/health`
- `GET /api/version`
- `GET /api/ping`
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/google`
- `GET /api/auth/github`
- `GET /api/auth/github/callback`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET /api/auth/providers`

---

## Formato de errores

Todos los errores siguen este formato:

```json
{
  "ok": false,
  "error": "Mensaje humano en español",
  "code": "codigo_maquina",
  "requestId": "abc12345",
  "details": { "field": "email" }
}
```

### Códigos de error

**Auth:**
- `auth_no_session` · falta sesión
- `auth_invalid_session` · sesión inválida o expirada
- `auth_stale_session` · sesión demasiado vieja para operación sensible
- `auth_invalid_creds` · email o contraseña mal
- `auth_use_oauth` · la cuenta usa Google/GitHub
- `auth_account_locked` · cuenta bloqueada por intentos
- `auth_email_taken` · email ya registrado
- `auth_google_failed` · token de Google inválido
- `auth_invalid_token` · token de reset inválido
- `auth_forbidden` · sin permisos

**Chats:**
- `chat_not_found` · chat no existe
- `chat_empty_message` · mensaje vacío
- `chat_too_long` · mensaje muy largo
- `chat_injection_blocked` · prompt injection detectado

**Memorias:**
- `mem_not_found` · memoria no existe
- `mem_duplicate` · memoria duplicada
- `mem_limit_exceeded` · límite de memorias alcanzado

**IA:**
- `ai_engine_failed` · motor falló
- `ai_all_engines_failed` · los 3 motores fallaron
- `ai_rate_limit` · límite del proveedor alcanzado
- `ai_timeout` · timeout del motor
- `ai_auth` · credenciales del motor inválidas

**Límites:**
- `limit_daily` · límite diario alcanzado
- `limit_minute` · límite por minuto
- `limit_burst` · demasiado rápido
- `limit_ip` · límite por IP

**Base de datos:**
- `db_unavailable` · DB no disponible
- `db_unique_violation` · registro duplicado
- `db_query_failed` · error de query

**Validación:**
- `valid_email` · email inválido
- `valid_password_short` · contraseña muy corta
- `valid_password_common` · contraseña muy común
- `valid_missing_field` · falta un campo
- `valid_payload_large` · payload muy grande

**Internos:**
- `int_server_error` · error interno
- `int_not_found` · endpoint no existe
- `int_endpoint_not_found` · 404 JSON

---

## Rate limiting

Numination tiene **3 capas** de rate limiting:

### 1 · Por IP (global)

- **240 requests por minuto**
- Aplica a todos los endpoints
- Headers: `X-RateLimit-Limit: 240`

### 2 · Por usuario (todos los endpoints)

- **Free:** 2/segundo, 30/minuto, 300/hora, 2000/día
- **Basic:** 5/segundo, 60/minuto, 1000/hora, 10000/día
- **Pro:** 10/segundo, 120/minuto, 3000/hora, 50000/día
- **Premium:** 20/segundo, 300/minuto, 10000/hora, 200000/día

### 3 · Cuotas de negocio (por plan)

- **Free:** 20 mensajes/día
- **Basic:** 100 mensajes/día
- **Pro:** 500 mensajes/día
- **Premium:** 2000 mensajes/día

Solo aplica a endpoints que consumen IA (`/api/chat/stream`).

### Comportamiento al exceder

**Rate limit (429):**
```json
{
  "ok": false,
  "error": "Llegaste al límite por minuto. Esperá un momento.",
  "code": "limit_minute",
  "retryAfter": 42
}
```

**Cuota de negocio (429):**
```json
{
  "ok": false,
  "error": "Límite diario alcanzado (20 mensajes). Mejora tu plan para continuar.",
  "code": "limit_daily",
  "retryAfter": 86400
}
```

### Strikes

Si golpeás el rate limit repetidamente:
- Strike 1-2: cooldown normal
- Strike 3: +3 segundos de cooldown
- Strike 4: +9 segundos
- Strike 5: +27 segundos
- Strike 10+: hasta 30 minutos

---

## Códigos de estado

| Código | Significado |
|---|---|
| 200 | OK |
| 201 | Creado |
| 204 | Sin contenido (OPTIONS) |
| 400 | Petición inválida |
| 401 | No autenticado |
| 403 | Sin permisos / injection |
| 404 | No encontrado |
| 409 | Conflicto (ej. email duplicado) |
| 413 | Payload demasiado grande |
| 422 | Entidad no procesable |
| 423 | Cuenta bloqueada |
| 429 | Rate limit |
| 500 | Error interno |
| 502 | Motor externo falló |
| 503 | Servicio no disponible |
| 504 | Timeout |

---

## Health & Version

### `GET /api/health`

Estado completo del sistema.

**Response 200:**
```json
{
  "ok": true,
  "service": "numination",
  "version": "7.0.0",
  "codename": "Numi-OT.01",
  "env": "production",
  "uptime": 12456,
  "priority": {
    "text": ["groq", "gemini", "nvidia"],
    "files": ["gemini", "nvidia", "groq"]
  },
  "models": {
    "GROQ": "openai/gpt-oss-120b",
    "GEMINI": "gemini-3.6-flash",
    "KIMI": "moonshotai/kimi-k3"
  },
  "keys": {
    "groq": true,
    "gemini_1": true,
    "gemini_2": true,
    "gemini_3": true,
    "nvidia": true
  },
  "geminiPool": [
    { "id": 1, "cooldown": false, "requests": 42, "errors": 0 },
    { "id": 2, "cooldown": false, "requests": 38, "errors": 0 },
    { "id": 3, "cooldown": true, "requests": 30, "errors": 2 }
  ],
  "database": {
    "connected": true,
    "ping": { "ok": true, "latencyMs": 17 }
  },
  "limits": {
    "ok": true,
    "latencyMs": 42,
    "failMode": "open"
  },
  "analytics": {
    "ok": true,
    "latencyMs": 38,
    "bufferSize": 3
  },
  "auth": {
    "session": true,
    "email": "user@example.com"
  },
  "runtime": {
    "node": "v24.21.0",
    "memory": { "rss": "97 MB", "heap": "23 MB" }
  },
  "ts": "2026-10-12T02:05:41.156Z"
}
```

### `GET /api/version`

Versión mínima.

**Response 200:**
```json
{
  "ok": true,
  "version": "7.0.0",
  "name": "Numination",
  "codename": "Numi-OT.01",
  "env": "production",
  "models": { ... }
}
```

### `GET /api/ping`

Ping rápido.

**Response 200:**
```json
{
  "ok": true,
  "pong": 1728000000000
}
```

---

## Auth

### `POST /api/auth/signup`

Crear cuenta con email + contraseña.

**Body:**
```json
{
  "email": "user@example.com",
  "password": "Password123",
  "name": "Álvaro"
}
```

**Validaciones:**
- Email: regex RFC válido, máx 254 chars
- Password: 8-100 chars, mínimo 1 letra + 1 número
- Password no puede estar en top 20 comunes
- Name: opcional, 2-40 chars

**Response 201:**
```json
{
  "ok": true,
  "user": {
    "id": "abc-123",
    "email": "user@example.com",
    "name": "Álvaro",
    "picture": null,
    "role": "student",
    "plan": "free",
    "provider": "email",
    "emailVerified": true,
    "hasPassword": true,
    "createdAt": "2026-10-12T02:00:00.000Z"
  }
}
```

Cookie `numination_session` se setea automáticamente.

**Errores:**
- `400` `valid_email` · email inválido
- `400` `valid_password_short` · contraseña corta
- `400` `valid_password_common` · contraseña común
- `409` `auth_email_taken` · email ya existe
- `429` `limit_ip` · demasiados intentos (5/15min por IP)

**Ejemplo curl:**
```bash
curl -X POST https://numinationchat.vercel.app/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "Password123",
    "name": "Test"
  }' \
  -c cookies.txt
```

---

### `POST /api/auth/login`

Iniciar sesión con email + contraseña.

**Body:**
```json
{
  "email": "user@example.com",
  "password": "Password123",
  "remember": true
}
```

**Response 200:**
```json
{
  "ok": true,
  "user": { ... }
}
```

**Errores:**
- `400` · datos faltantes
- `401` `auth_invalid_creds` · credenciales malas
- `401` `auth_use_oauth` · la cuenta usa Google/GitHub
- `423` `auth_account_locked` · bloqueada 15 min tras 5 intentos
- `429` · demasiados intentos

**Rate limits:**
- IP: 15/15min
- Email: 8/15min
- Bloqueo: tras 5 intentos fallidos → 15 min

---

### `POST /api/auth/google`

Login con Google Identity Services.

**Body:**
```json
{
  "credential": "<JWT de Google>",
  "remember": true
}
```

El `credential` es el ID token que entrega GIS en el frontend.

**Response 200:**
```json
{
  "ok": true,
  "user": { ... }
}
```

**Errores:**
- `400` `missing_credential` · falta el credential
- `401` `auth_google_failed` · token inválido o audience mismatch
- `400` `no_email` · token sin email
- `400` `unverified` · email no verificado en Google

---

### `GET /api/auth/github`

Inicia el flow OAuth de GitHub.

**Response 302:** redirect a `https://github.com/login/oauth/authorize?...`

Después del flow, redirige a `/chat.html` y setea la cookie.

**Query params de error:**
- `?error=access_denied` · el usuario canceló
- `?error=github` · error general
- `?error=session` · sesión expiró

---

### `GET /api/auth/github/callback`

Callback del flow OAuth. **No llamar manualmente**.

---

### `GET /api/auth/me`

Usuario actual.

**Response 200:**
```json
{
  "ok": true,
  "user": {
    "id": "abc-123",
    "email": "user@example.com",
    "name": "Álvaro",
    "picture": "https://...",
    "role": "student",
    "plan": "free",
    "provider": "google",
    "emailVerified": true,
    "hasPassword": false,
    "createdAt": "2026-10-10T19:43:29.092Z",
    "lastLoginAt": "2026-10-12T02:00:00.000Z"
  }
}
```

Si no hay sesión:
```json
{
  "ok": false,
  "user": null
}
```

---

### `GET /api/auth/session`

Info detallada de la sesión.

**Response 200:**
```json
{
  "ok": true,
  "authenticated": true,
  "revoked": false,
  "issuedAt": "2026-10-12T02:00:00.000Z",
  "expiresAt": "2026-11-11T02:00:00.000Z",
  "ageSeconds": 245,
  "expiresInSeconds": 2591755,
  "fresh": true,
  "provider": "google",
  "jti": "abc123def456",
  "user": { ... }
}
```

`fresh: true` significa que la sesión tiene < 5 min, requerido para operaciones sensibles.

---

### `GET /api/auth/check`

¿Hay sesión activa?

**Response 200:**
```json
{ "authenticated": true }
```

---

### `GET /api/auth/providers`

Proveedores de auth disponibles.

**Response 200:**
```json
{
  "ok": true,
  "providers": {
    "google": { "enabled": true, "label": "Google" },
    "github": { "enabled": true, "label": "GitHub" },
    "email": { "enabled": true, "label": "Correo y contraseña" },
    "emailPasswordReset": { "enabled": true, "emailDelivery": true },
    "emailVerification": { "enabled": true, "emailDelivery": true }
  }
}
```

---

### `POST /api/auth/logout`

Cerrar sesión.

**Response 200:**
```json
{ "ok": true }
```

Limpia la cookie.

---

### `POST /api/auth/logout-all`

Cerrar sesión en TODOS los dispositivos.

**Response 200:**
```json
{
  "ok": true,
  "invalidatedAt": "2026-10-12T02:00:00.000Z"
}
```

Incrementa `auth_version` del usuario, invalidando todos los JWT anteriores.

---

### `POST /api/auth/change-password`

Cambiar contraseña. **Requiere sesión fresca (< 5 min).**

**Body:**
```json
{
  "currentPassword": "OldPass123",
  "newPassword": "NewPass456"
}
```

**Response 200:**
```json
{ "ok": true }
```

**Errores:**
- `400` · contraseña nueva débil
- `401` `auth_wrong_password` · contraseña actual mal
- `403` `auth_stale_session` · sesión > 5 min, hay que re-loguearse

---

### `POST /api/auth/forgot-password`

Pedir reset de contraseña. Envía email.

**Body:**
```json
{ "email": "user@example.com" }
```

**Response 200** (siempre, no revela si el email existe):
```json
{ "ok": true }
```

**Rate limit:** 3/hora por email, 10/hora por IP.

El email tiene un link a `/reset-password.html?token=<token>`. El token expira en 1 hora.

---

### `POST /api/auth/reset-password`

Aplicar el reset con el token.

**Body:**
```json
{
  "token": "abc123...",
  "newPassword": "NewPass456"
}
```

**Response 200:**
```json
{ "ok": true }
```

**Errores:**
- `400` `auth_invalid_token` · token inválido o expirado

---

### `PATCH /api/auth/profile`

Actualizar perfil.

**Body:**
```json
{ "name": "Nuevo Nombre" }
```

**Response 200:**
```json
{
  "ok": true,
  "user": { ... }
}
```

**Validaciones:**
- Name: 2-40 chars

---

### `DELETE /api/auth/account`

Eliminar cuenta. **Requiere sesión fresca + confirmación textual.**

**Body:**
```json
{ "confirm": "ELIMINAR" }
```

**Response 200:**
```json
{ "ok": true }
```

Borra el usuario, sus chats, mensajes y memorias en una transacción.

---

### `GET /api/auth/audit`

Ver eventos de seguridad recientes.

**Response 200:**
```json
{
  "ok": true,
  "events": [
    {
      "ts": "2026-10-12T02:00:00.000Z",
      "event": "login.ok",
      "email": "user@example.com",
      "ip": "1.2.3.4"
    }
  ]
}
```

Solo muestra los últimos 30 eventos del usuario actual.

---

## Chats

### `GET /api/chats`

Listar chats del usuario.

**Query params:**
- `limit` (opcional): default 100, máx 500
- `offset` (opcional): default 0

**Response 200:**
```json
{
  "ok": true,
  "chats": [
    {
      "id": "uuid-1",
      "title": "Mi primer chat",
      "mode": "chat",
      "created_at": "2026-10-10T19:44:51.512Z",
      "updated_at": "2026-10-10T21:04:57.871Z"
    },
    {
      "id": "uuid-2",
      "title": "Código React",
      "mode": "coder",
      "created_at": "2026-10-10T20:11:59.678Z",
      "updated_at": "2026-10-10T20:13:08.178Z"
    }
  ]
}
```

---

### `POST /api/chats`

Crear chat nuevo.

**Body:**
```json
{
  "title": "Mi chat",
  "mode": "chat"
}
```

**Response 201:**
```json
{
  "ok": true,
  "chat": {
    "id": "uuid-new",
    "title": "Mi chat",
    "mode": "chat",
    "created_at": "2026-10-12T02:00:00.000Z",
    "updated_at": "2026-10-12T02:00:00.000Z"
  }
}
```

**Modes válidos:** `chat`, `coder`, `reasoning`

---

### `GET /api/chats/:id`

Obtener un chat con TODOS sus mensajes.

**Response 200:**
```json
{
  "ok": true,
  "chat": {
    "id": "uuid-1",
    "title": "Mi chat",
    "mode": "chat",
    "created_at": "2026-10-10T19:44:51.512Z",
    "updated_at": "2026-10-10T21:04:57.871Z",
    "messages": [
      {
        "id": "msg-1",
        "chat_id": "uuid-1",
        "role": "user",
        "content": "Hola",
        "provider": null,
        "created_at": "2026-10-10T19:44:51.512Z"
      },
      {
        "id": "msg-2",
        "chat_id": "uuid-1",
        "role": "ai",
        "content": "¡Hola! ¿En qué puedo ayudarte?",
        "provider": "groq",
        "created_at": "2026-10-10T19:44:53.012Z"
      }
    ]
  }
}
```

---

### `PATCH /api/chats/:id`

Renombrar chat.

**Body:**
```json
{ "title": "Nuevo título" }
```

**Response 200:**
```json
{
  "ok": true,
  "chat": { "id": "uuid-1", "title": "Nuevo título", ... }
}
```

---

### `DELETE /api/chats/:id`

Eliminar chat y todos sus mensajes.

**Response 200:**
```json
{ "ok": true }
```

---

### `POST /api/chats/:id/messages`

Guardar un mensaje (usado por el frontend).

**Body:**
```json
{
  "message": {
    "role": "user",
    "content": "Hola"
  }
}
```

**Response 200:**
```json
{
  "ok": true,
  "message": {
    "id": "msg-new",
    "chat_id": "uuid-1",
    "role": "user",
    "content": "Hola",
    "created_at": "2026-10-12T02:00:00.000Z"
  }
}
```

---

### `GET /api/chats/search`

Buscar chats por título.

**Query params:**
- `q` (requerido): término de búsqueda
- `limit` (opcional): default 30

**Response 200:**
```json
{
  "ok": true,
  "chats": [ ... ]
}
```

---

## Chat & IA

### `POST /api/chat/stream`

**Endpoint principal del chat.** Envía un mensaje y recibe la respuesta en streaming SSE.

**Body:**
```json
{
  "message": "Explícame la fotosíntesis",
  "role": "student",
  "history": [
    { "role": "user", "content": "Hola" },
    { "role": "assistant", "content": "¡Hola! ¿En qué puedo ayudarte?" }
  ],
  "file": null,
  "incognito": false
}
```

**Campos:**
- `message` (req): el texto del mensaje
- `role` (opcional): `student` (default) | `teacher` | `coder` | `reasoning`
- `history` (opcional): array de mensajes previos `[{role, content}]`
- `file` (opcional): `{ data: base64, mimeType, name }`
- `incognito` (opcional): si `true`, no se guarda ni aparece en historial

**Response:** `text/event-stream`

Formato SSE (una línea por evento):
```
data: {"meta":{"plan":"Free","restanteDia":20,"mode":"student","requestId":"abc123"}}

data: {"token":"La","done":false}

data: {"token":" fotosíntesis","done":false}

data: {"token":" es","done":false}

...

data: {"token":"","done":true,"provider":"groq"}
```

**Tipos de eventos:**

1. **`meta`** — primer evento, info de sesión
2. **`token`** — fragmento de la respuesta
3. **`done`** — fin del stream (`provider` indica qué motor respondió)
4. **`error`** — hubo un error

**Evento de error:**
```
data: {"error":"Los motores de IA están saturados.","done":true}
```

**Evento con partial:**
```
data: {"token":"","done":true,"provider":"groq","partial":true}
```

`partial: true` significa que el motor murió a mitad del stream.

**Ejemplo curl:**
```bash
curl -N -X POST https://numinationchat.vercel.app/api/chat/stream \
  -H "Content-Type: application/json" \
  -b "numination_session=<JWT>" \
  -d '{
    "message": "di hola",
    "role": "student"
  }'
```

**Ejemplo JS:**
```javascript
const response = await fetch('/api/chat/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    message: 'Hola',
    role: 'student',
    history: [],
  }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split('\n\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const event = JSON.parse(line.slice(6));

    if (event.meta) console.log('Meta:', event.meta);
    if (event.token) process.stdout.write(event.token);
    if (event.done) console.log('\nDone:', event.provider);
    if (event.error) console.error('Error:', event.error);
  }
}
```

**Errores:**
- `400` `chat_empty_message` · mensaje vacío
- `400` `chat_too_long` · mensaje > 8000 chars
- `403` `chat_injection_blocked` · prompt injection
- `429` `limit_daily` / `limit_minute` · límite alcanzado
- `500` · error interno

**Rate limits:**
- Free: 5/minuto, 30/hora, 50/día
- Basic: 20/minuto, 100/hora, 100/día
- Pro: 60/minuto, 300/hora, 500/día
- Premium: 120/minuto, 600/hora, 2000/día

**Motores (fallback automático):**
1. **Groq** (openai/gpt-oss-120b) — rápido, gratis
2. **Gemini** (3 keys rotando) — potente
3. **Kimi K3** (NVIDIA NIM) — respaldo

Si un motor falla en el primer token, pasa al siguiente en 25s máximo.

---

### `POST /api/chat`

**Variante sin streaming.** Mismo body que `/api/chat/stream`.

**Response 200:**
```json
{
  "ok": true,
  "reply": "La fotosíntesis es...",
  "provider": "groq",
  "mode": "student",
  "durationMs": 1240
}
```

**Cuándo usar:** cuando no necesitás streaming (ej. bots, tests).

---

## Memorias

### `GET /api/memories`

Listar memorias del usuario.

**Query params:**
- `category` (opcional)
- `tags` (opcional, comma-separated)
- `pinned` (opcional, `true`/`false`)
- `sort` (opcional, `newest` | `oldest`)
- `limit` (opcional, default 100)
- `offset` (opcional, default 0)
- `q` (opcional, búsqueda)

**Response 200:**
```json
{
  "ok": true,
  "memories": [
    {
      "id": "mem-1",
      "user_id": "abc-123",
      "text": "Álvaro tiene 14 años",
      "title": "Álvaro tiene 14 años",
      "category": "general",
      "tags": ["perfil", "edad"],
      "pinned": true,
      "relevance": 8,
      "source": "chat",
      "use_count": 3,
      "last_used_at": "2026-10-12T01:00:00.000Z",
      "created_at": "2026-10-10T19:44:00.000Z",
      "updated_at": "2026-10-12T01:00:00.000Z"
    }
  ]
}
```

---

### `POST /api/memories`

Crear memoria.

**Body:**
```json
{
  "text": "El usuario prefiere ejemplos cortos",
  "title": "Preferencia: ejemplos cortos",
  "category": "preferences",
  "tags": ["preferencias", "estilo"],
  "pinned": false,
  "source": "manual"
}
```

**Response 201:**
```json
{
  "ok": true,
  "memory": { ... }
}
```

**Detección de duplicados:**
- Si existe con mismo texto → `409` `mem_duplicate`
- Si es muy parecida → `200` con `code: 'mem_near_duplicate'`

**Límite:** 500 memorias por usuario (plan free).

---

### `GET /api/memories/:id`

Obtener una memoria.

**Response 200:**
```json
{
  "ok": true,
  "memory": { ... }
}
```

---

### `PATCH /api/memories/:id`

Actualizar memoria.

**Body:**
```json
{
  "text": "Nuevo texto",
  "category": "otra",
  "tags": ["a", "b"],
  "pinned": true,
  "relevance": 9
}
```

**Response 200:**
```json
{
  "ok": true,
  "memory": { ... }
}
```

---

### `DELETE /api/memories/:id`

Eliminar memoria.

**Response 200:**
```json
{ "ok": true }
```

---

### `POST /api/memories/:id/pin`

Toggle del pin.

**Response 200:**
```json
{
  "ok": true,
  "memory": { "id": "mem-1", "pinned": true }
}
```

---

### `POST /api/memories/:id/use`

Registrar uso de la memoria (incrementa `use_count`).

**Response 200:**
```json
{
  "ok": true,
  "memory": {
    "id": "mem-1",
    "useCount": 4,
    "lastUsedAt": "2026-10-12T02:00:00.000Z"
  }
}
```

---

### `GET /api/memories/stats`

Estadísticas de memorias.

**Response 200:**
```json
{
  "ok": true,
  "total": 25,
  "pinned": 3,
  "byCategory": {
    "general": 15,
    "preferences": 5,
    "education": 5
  },
  "topTags": [
    { "tag": "perfil", "total": 8 },
    { "tag": "estudio", "total": 5 }
  ],
  "weekDelta": 3,
  "thisWeek": 5,
  "lastWeek": 2
}
```

---

### `GET /api/memories/tags`

Lista de tags únicos.

**Response 200:**
```json
{
  "ok": true,
  "tags": [
    { "tag": "perfil", "total": 8 },
    { "tag": "estudio", "total": 5 }
  ]
}
```

---

### `GET /api/memories/:id/related`

Memorias relacionadas (comparten tags).

**Response 200:**
```json
{
  "ok": true,
  "related": [ ... ]
}
```

---

### `POST /api/memories/bulk/delete`

Eliminar varias memorias.

**Body:**
```json
{ "ids": ["mem-1", "mem-2", "mem-3"] }
```

**Response 200:**
```json
{
  "ok": true,
  "deleted": 3
}
```

---

### `POST /api/memories/bulk/update`

Actualizar varias.

**Body:**
```json
{
  "ids": ["mem-1", "mem-2"],
  "patch": {
    "pinned": true,
    "addTags": ["importante"],
    "removeTags": ["obsoleto"],
    "category": "importante"
  }
}
```

**Response 200:**
```json
{
  "ok": true,
  "updated": 2
}
```

---

### `GET /api/memories/export`

Exportar todas las memorias.

**Query params:**
- `format`: `json` (default) | `md` | `csv`

**Response 200:** archivo con `Content-Disposition: attachment`.

---

### `DELETE /api/memories`

Eliminar TODAS las memorias.

**Body:**
```json
{ "confirm": "BORRAR TODO" }
```

**Response 200:**
```json
{
  "ok": true,
  "deleted": 25
}
```

---

## Proyectos

### `GET /api/projects`

Listar proyectos.

**Response 200:**
```json
{
  "ok": true,
  "projects": [
    {
      "id": "proj-1",
      "name": "Mi proyecto",
      "color": "#7c5eff",
      "type": "coder",
      "createdAt": "2026-10-12T02:00:00.000Z"
    }
  ]
}
```

---

### `POST /api/projects`

Crear proyecto.

**Body:**
```json
{
  "name": "Nuevo proyecto",
  "color": "#7c5eff",
  "type": "coder"
}
```

**Response 201:**
```json
{
  "ok": true,
  "project": { ... }
}
```

---

### `PATCH /api/projects/:id`

Actualizar.

**Response 200:**
```json
{ "ok": true, "project": { ... } }
```

---

### `DELETE /api/projects/:id`

Eliminar.

**Response 200:**
```json
{ "ok": true }
```

---

## Skills

### `GET /api/skills`

Lista de skills disponibles.

**Response 200:**
```json
{
  "ok": true,
  "skills": [
    {
      "id": "explain",
      "name": "Explicar",
      "desc": "Explica un concepto paso a paso",
      "category": "aprender",
      "icon": "book",
      "modes": ["chat", "coder", "reasoning"]
    }
  ],
  "categories": [
    { "id": "aprender", "label": "Aprender", "color": "#7c5eff" }
  ]
}
```

---

### `GET /api/skills/:id`

Detalle de un skill.

**Response 200:**
```json
{
  "ok": true,
  "skill": {
    "id": "explain",
    "name": "Explicar",
    "desc": "...",
    "category": "aprender",
    "icon": "book",
    "modes": ["chat", "coder", "reasoning"],
    "examples": ["Explícame la fotosíntesis"],
    "keywords": ["explica", "qué es"]
  }
}
```

---

### `POST /api/skills/detect`

Detectar qué skill encaja con un prompt.

**Body:**
```json
{ "text": "explícame la relatividad", "mode": "chat" }
```

**Response 200:**
```json
{
  "ok": true,
  "skill": { "id": "explain", "name": "Explicar" },
  "score": 2,
  "all": [
    { "id": "explain", "score": 2 },
    { "id": "explain-simple", "score": 0 }
  ]
}
```

---

## Conectores

### `GET /api/connectors`

Lista de conectores disponibles.

**Response 200:**
```json
{
  "ok": true,
  "connectors": [
    {
      "id": "wikipedia",
      "name": "Wikipedia",
      "description": "Busca y cita artículos en español",
      "category": "Educación",
      "timeoutMs": 8000,
      "cacheTtlMs": 300000
    }
  ]
}
```

**Conectores disponibles:**
1. `wikipedia` · Wikipedia en español
2. `colombia` · API Colombia (departamentos, municipios)
3. `trivia` · Open Trivia (preguntas)
4. `countries` · REST Countries
5. `nasa` · NASA (astronomía)
6. `meteo` · Open-Meteo (clima)
7. `dictionary` · Free Dictionary
8. `quotable` · Quotable (frases célebres)
9. `books` · Google Books
10. `numbers` · Numbers API
11. `wiktionary` · Wiktionary
12. `holidays` · Nager.Date (feriados)
13. `github` · GitHub API

---

### `POST /api/connectors/:id/query`

Ejecutar un conector.

**Body:** depende del conector. Ejemplo para `wikipedia`:
```json
{ "query": "fotosíntesis", "lang": "es" }
```

Ejemplo para `meteo`:
```json
{ "city": "Medellín" }
```

**Response 200:**
```json
{
  "ok": true,
  "connector": "wikipedia",
  "result": {
    "title": "Fotosíntesis",
    "summary": "...",
    "url": "https://es.wikipedia.org/wiki/Fotosíntesis"
  },
  "cached": false,
  "durationMs": 234
}
```

**Errores:**
- `400` · faltan parámetros
- `503` `connector_unavailable` · API externa caída

---

### `GET /api/connectors/:id/health`

Health check de un conector.

**Response 200:**
```json
{
  "ok": true,
  "connector": "wikipedia",
  "healthy": true,
  "latencyMs": 123
}
```

---

## Email

### `GET /api/email/status`

Estado del servicio de email.

**Response 200:**
```json
{
  "ok": true,
  "configured": true,
  "provider": "resend",
  "fromEmail": "no-reply@numination.app"
}
```

---

### `POST /api/email/test`

Enviar email de prueba. **Solo admin.**

**Body:**
```json
{ "to": "test@example.com" }
```

**Response 200:**
```json
{
  "ok": true,
  "messageId": "abc123"
}
```

---

### `GET /api/email/templates`

Lista plantillas disponibles.

**Response 200:**
```json
{
  "ok": true,
  "templates": [
    "reset_password",
    "verify_email",
    "welcome",
    "limit_warning"
  ]
}
```

---

### `GET /api/email/history`

Historial de emails enviados al usuario actual.

**Response 200:**
```json
{
  "ok": true,
  "emails": [
    {
      "id": "email-1",
      "type": "reset_password",
      "status": "delivered",
      "sentAt": "2026-10-12T02:00:00.000Z"
    }
  ]
}
```

---

## Límites y uso

### `GET /api/limits/usage`

Uso actual del usuario.

**Response 200:**
```json
{
  "ok": true,
  "plan": "Free",
  "uso": {
    "hoy": 12,
    "dia": 12,
    "minuto": 1,
    "burst": 1,
    "mes": 87
  },
  "limites": {
    "porDia": 20,
    "porMin": 5,
    "porMinuto": 5,
    "porBurst": 3
  },
  "restanteDia": 8,
  "restanteMin": 4,
  "porcentaje": {
    "dia": 60,
    "minuto": 20
  },
  "resetAt": {
    "minuto": "2026-10-12T02:01:00.000Z",
    "dia": "2026-10-13T00:00:00.000Z",
    "mes": "2026-11-01T00:00:00.000Z"
  }
}
```

**Headers:**
```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 4
X-RateLimit-Reset: 47
```

---

## Errores comunes

### 401 Unauthorized

```json
{
  "ok": false,
  "error": "No autenticado",
  "code": "auth_no_session"
}
```

**Solución:** verificar que la cookie `numination_session` esté presente y válida.

### 403 Forbidden

```json
{
  "ok": false,
  "error": "No puedo procesar esa instrucción. Reformúlala como una pregunta educativa.",
  "code": "chat_injection_blocked"
}
```

**Solución:** reformular el mensaje sin instrucciones de override.

### 429 Too Many Requests

```json
{
  "ok": false,
  "error": "Límite diario alcanzado (20 mensajes). Mejora tu plan para continuar.",
  "code": "limit_daily",
  "retryAfter": 86400
}
```

**Solución:** esperar `retryAfter` segundos o upgrade de plan.

### 500 Internal Server Error

```json
{
  "ok": false,
  "error": "Error interno del servidor",
  "code": "int_server_error",
  "requestId": "abc12345"
}
```

**Solución:** reportar con el `requestId` para buscar en logs.

### 502 Bad Gateway

```json
{
  "ok": false,
  "error": "El motor está saturado.",
  "code": "ai_rate_limit",
  "details": {
    "engine": "groq",
    "status": 429
  }
}
```

**Solución:** reintentar en unos segundos.

### 504 Gateway Timeout

```json
{
  "ok": false,
  "error": "El motor no respondió en el tiempo esperado.",
  "code": "ai_timeout"
}
```

**Solución:** reintentar; normalmente se resuelve solo.

---

## Ejemplos avanzados

### Flujo completo de auth con Google

```javascript
// 1 · Login con Google (el frontend ya obtiene el credential)
const credential = '<JWT de Google>';

const res = await fetch('/api/auth/google', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({ credential, remember: true }),
});

const data = await res.json();
if (data.ok) {
  console.log('Usuario:', data.user);
  window.location.href = '/chat.html';
}
```

### Flujo completo de chat con streaming

```javascript
async function chat(message, history = []) {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      message,
      role: 'student',
      history: history.slice(-12), // últimos 12
    }),
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullText = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6));

        if (event.meta) {
          console.log('Plan:', event.meta.plan);
          console.log('Restante:', event.meta.restanteDia);
        }

        if (event.token) {
          fullText += event.token;
          process.stdout.write(event.token);
        }

        if (event.done) {
          console.log('\n\nMotor:', event.provider);
          return { text: fullText, provider: event.provider };
        }

        if (event.error) {
          throw new Error(event.error);
        }
      } catch (e) {
        // ignorar líneas no-JSON
      }
    }
  }
}

// Uso
const { text, provider } = await chat('Explícame la gravedad');
console.log(`\nRespuesta (${provider}): ${text}`);
```

### Flujo de signup + verificación + login

```javascript
// 1 · Signup
const signup = await fetch('/api/auth/signup', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  credentials: 'include',
  body: JSON.stringify({
    email: 'user@example.com',
    password: 'Password123',
    name: 'Test',
  }),
});
const signupData = await signup.json();

if (!signupData.ok) {
  if (signupData.code === 'auth_email_taken') {
    // Ya existe: ir a login
    return login();
  }
  throw new Error(signupData.error);
}

// 2 · Ya está logueado automáticamente (cookie seteada)
// Verificar:
const me = await fetch('/api/auth/me', { credentials: 'include' });
const meData = await me.json();
console.log('Logueado como:', meData.user.name);

// 3 · Ir al chat
window.location.href = '/chat.html';
```

### Batch de memorias

```javascript
async function importMemories(memoriesArray) {
  const results = await Promise.all(
    memoriesArray.map((text) =>
      fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text, source: 'import' }),
      }).then((r) => r.json())
    )
  );

  const ok = results.filter((r) => r.ok).length;
  const duplicates = results.filter((r) => r.code === 'mem_duplicate').length;
  console.log(`Importadas: ${ok}, duplicadas: ${duplicates}`);
}
```

### Verificar cuota antes de mandar

```javascript
async function canSendMessage() {
  const res = await fetch('/api/limits/usage', { credentials: 'include' });
  const data = await res.json();

  if (!data.ok) return true; // fail-open
  if (data.restanteDia <= 0) {
    console.warn('Sin mensajes disponibles hoy');
    return false;
  }
  return true;
}

// Uso
if (await canSendMessage()) {
  await chat('Hola');
}
```

---

## Webhooks (futuro)

Actualmente no hay webhooks. Si se agregan, se documentarán acá.

---

## SDKs (futuro)

Actualmente no hay SDKs oficiales. Podés usar `fetch` directamente.

---

## Changelog

### v7.0.0 (2026-10-12)
- Rate limit por usuario + endpoint + plan
- Sistema de analytics con DAU/WAU/MAU
- Sistema de prompts versionado
- Middleware de errores centralizado
- Smoke test automatizado
- AbortController en SSE
- Refund automático si fallan los motores

### v6.6.0 (2026-10-12)
- System prompt con identidad Numi OT
- Adaptación de idioma
- Reglas técnicas y de concisión

### v6.5.0 (2026-10-12)
- Fix crítico del SSE (`req.on('close')` eliminado)
- SSE heartbeat cada 8s
- Máxima duración 300s

### v6.4.0 (2026-10-11)
- Modelos configurables por env
- Timeout de primer token (25s)
- Detección de cliente desconectado

---

## Soporte

- **Issues:** https://github.com/kraqinc/Numination/issues
- **Docs:** `/docs/`
- **Email:** soporte@numination.app

---

**Numi es la clave.**