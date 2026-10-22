# Referencia de API

> **Base:** `https://numination.app` (prod) · `http://localhost:8080` (dev)
> **Formato:** JSON · **Auth:** cookie `token` (JWT) salvo indicación.
> **Envelope:** `{ ok: true, data }` / `{ ok: false, error, code, requestId }`

---

## 1. Convenciones

| Aspecto | Regla |
|---|---|
| Content-Type | `application/json` (excepto uploads `multipart/form-data`) |
| Auth | Cookie `token` o header `Authorization: Bearer <jwt>` |
| IDs | UUID v4 (excepto `Memory.id` que es `mem_<base36>`) |
| Fechas | ISO 8601 UTC |
| Paginación | `?limit=&cursor=` (cursor opaco) |
| Errores | HTTP status + `code` estable |
| Rate limit | Headers `RateLimit-*` |

### Códigos de error

| HTTP | `code` | Significado |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Body/query inválido |
| 401 | `UNAUTHORIZED` | Sin sesión |
| 401 | `SESSION_REVOKED` | Logout remoto |
| 402 | `PLAN_REQUIRED` | Plan insuficiente |
| 403 | `FORBIDDEN` | Sin permiso |
| 403 | `ACCOUNT_SUSPENDED` | Suspensión temporal |
| 403 | `PAYMENT_ORDER_FORBIDDEN` | IDOR |
| 404 | `NOT_FOUND` | Recurso inexistente |
| 409 | `CONFLICT` | Duplicado / stale write |
| 422 | `UNPROCESSABLE` | Semánticamente inválido |
| 429 | `RATE_LIMITED` | Demasiadas requests |
| 500 | `INTERNAL` | Error no controlado |
| 503 | `ALL_PROVIDERS_FAILED` | IA caída |

---

## 2. Sistema

### `GET /api/health`

Sin auth. Estado de la app y DB.

```json
{ "ok": true, "status": "healthy", "db": "up", "uptime": 1234.5 }
```

### `GET /api/version`

```json
{ "ok": true, "version": "3.3.0", "node": "v22.11.0", "env": "production" }
```

### `GET /api/endpoints`

Lista todos los endpoints registrados (útil en dev).

```json
{ "ok": true, "count": 78, "data": [{ "method": "GET", "path": "/api/chats" }] }
```

> En producción se recomienda restringirlo a `admin`.

---

## 3. Autenticación

### `POST /api/auth/register`

```json
{ "email": "ana@example.com", "password": "S3gura!Pass", "name": "Ana" }
```

| Campo | Tipo | Reglas |
|---|---|---|
| `email` | string | válido, único |
| `password` | string | 8–72 bytes |
| `name` | string | 1–80, opcional |

**201**

```json
{ "ok": true, "data": { "id": "uuid", "email": "ana@example.com", "plan": "free", "credits": 0 } }
```

| Error | Código |
|---|---|
| Email existe | 409 `CONFLICT` |
| Password corta | 400 `VALIDATION_ERROR` |
| Rate limit | 429 |

### `POST /api/auth/login`

```json
{ "email": "ana@example.com", "password": "S3gura!Pass" }
```

**200** + `Set-Cookie: token=...; HttpOnly; Secure; SameSite=Lax`

| Error | Código |
|---|---|
| Credenciales | 401 `INVALID_CREDENTIALS` (mensaje genérico) |
| Suspendido | 403 `ACCOUNT_SUSPENDED` |

> El mensaje de error **no** distingue entre email inexistente y password incorrecta.

### `POST /api/auth/logout`

Revoca el `jti` y limpia la cookie. **200** `{ ok: true }`.

### `POST /api/auth/refresh`

Rota el token si es válido y no está revocado. Devuelve nueva cookie.

### `GET /api/auth/google` → 302 a Google

### `GET /api/auth/google/callback?code=&state=`

| Error | Código |
|---|---|
| `state` inválido | 400 `INVALID_STATE` |
| Email no verificado | 403 `EMAIL_NOT_VERIFIED` |

### `GET /api/auth/github` → 302 a GitHub
### `GET /api/auth/github/callback?code=&state=`

### `GET /api/me`

```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "email": "ana@example.com",
    "name": "Ana",
    "avatarUrl": null,
    "plan": "pro",
    "credits": 412,
    "role": "user",
    "createdAt": "2026-01-01T00:00:00Z"
  }
}
```

---

## 4. Chats

### `GET /api/chats`

Query: `limit` (1–100, def. 20), `cursor`, `q` (búsqueda en título).

```json
{
  "ok": true,
  "data": [
    { "id": "uuid", "title": "Plan de estudio", "updatedAt": "...", "messageCount": 12 }
  ],
  "nextCursor": "eyJpZCI6..."
}
```

### `POST /api/chats`

```json
{ "title": "Nuevo chat", "personaId": "uuid|null" }
```

**201** `{ ok: true, data: { id, title, createdAt } }`

### `GET /api/chats/:id`

Incluye los últimos 50 mensajes.

```json
{
  "ok": true,
  "data": {
    "id": "uuid",
    "title": "...",
    "personaId": null,
    "summary": "...",
    "messages": [
      { "id": "uuid", "role": "user", "content": "...", "createdAt": "..." }
    ]
  }
}
```

### `PATCH /api/chats/:id`

```json
{ "title": "Nuevo título" }
```

### `DELETE /api/chats/:id`

Cascade sobre `"Message"`. **200** `{ ok: true }`.

### `POST /api/chats/:id/summarize`

Genera/actualiza `summary`. Requiere ≥ 10 mensajes. **200** `{ ok: true, data: { summary } }`.

### `POST /api/chat/stream`

El endpoint central. **SSE**.

```json
{
  "chatId": "uuid",
  "content": "Explícame la fotosíntesis",
  "personaId": "uuid|null",
  "useRag": true,
  "useWeb": false,
  "attachments": []
}
```

**200** `Content-Type: text/event-stream`

```text
event: meta
data: {"chatId":"uuid","provider":"groq","model":"llama-3.3-70b"}

event: token
data: {"t":"La fotosíntesis"}

event: usage
data: {"promptTokens":820,"completionTokens":210}

event: done
data: {"messageId":"uuid","credits":1}
```

| Evento | Payload |
|---|---|
| `meta` | Proveedor y modelo elegidos |
| `token` | Fragmento de texto |
| `usage` | Tokens |
| `done` | ID del mensaje y créditos cobrados |
| `error` | `{ code, message, retryable }` |

| Error | Cuándo |
|---|---|
| 402 | Sin créditos |
| 403 | Chat ajeno |
| 429 | Rate limit de IA |
| 503 | Todos los proveedores fallaron |

---

## 5. Mensajes

### `GET /api/chats/:id/messages?limit=&cursor=`

### `POST /api/chats/:id/messages`

Mensaje sin streaming (fallback).

```json
{ "role": "user", "content": "..." }
```

### `DELETE /api/messages/:id`

Sólo el autor del chat.

### `POST /api/messages/:id/feedback`

```json
{ "value": "up" }
```

Valores: `up`, `down`. Se guarda para evaluación futura.

---

## 6. Personas

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/personas` | Lista propias + públicas |
| `POST` | `/api/personas` | Crear |
| `GET` | `/api/personas/:id` | Detalle |
| `PATCH` | `/api/personas/:id` | Editar |
| `DELETE` | `/api/personas/:id` | Borrar |
| `POST` | `/api/personas/:id/duplicate` | Copiar |

### `POST /api/personas`

```json
{
  "name": "Tutor de matemáticas",
  "description": "Explica paso a paso",
  "systemPrompt": "Eres un tutor paciente...",
  "temperature": 0.4,
  "color": "#22c55e",
  "isPublic": false
}
```

| Campo | Reglas |
|---|---|
| `name` | 1–60 |
| `systemPrompt` | 1–8000 |
| `temperature` | 0–2 |
| `color` | hex `#rrggbb` |
| `isPublic` | sólo admin si `user_id` es null |

**201** `{ ok: true, data: { id, ... } }`

| Error | Código |
|---|---|
| Prompt con patrón prohibido | 400 `PROMPT_REJECTED` |
| Persona ajena | 403 |

---

## 7. RAG

### `POST /api/rag/upload`

`multipart/form-data`, campo `file`.

| Límite | Valor |
|---|---|
| Tamaño | 10 MB |
| Tipos | pdf, txt, md, json |
| Concurrentes | 3 |

**202**

```json
{ "ok": true, "data": { "documentId": "uuid", "status": "pending" } }
```

### `GET /api/rag/documents`

```json
{
  "ok": true,
  "data": [
    { "id": "uuid", "filename": "tesis.pdf", "status": "ready", "chunkCount": 143 }
  ]
}
```

### `GET /api/rag/documents/:id`

Incluye metadatos y conteo, **no** el contenido.

### `DELETE /api/rag/documents/:id`

Borra documento y chunks (cascade).

### `POST /api/rag/query`

```json
{ "query": "¿Cuál es la conclusión?", "documentIds": ["uuid"], "topK": 6 }
```

**200**

```json
{
  "ok": true,
  "data": {
    "answer": "...",
    "sources": [
      { "chunkId": "uuid", "documentId": "uuid", "filename": "tesis.pdf", "similarity": 0.82, "preview": "..." }
    ],
    "mode": "vector"
  }
}
```

`mode`: `vector` | `lexical`.

### `GET /api/rag/status`

```json
{ "ok": true, "data": { "mode": "vector", "documents": 4, "chunks": 512 } }
```

---

## 8. Memoria

### `GET /api/memory-vault?limit=&cursor=&q=`

### `POST /api/memory-vault`

```json
{ "content": "Prefiere respuestas cortas", "importance": 0.8, "tags": ["preferencia"] }
```

### `PATCH /api/memory-vault/:id`

### `DELETE /api/memory-vault/:id`

Borrado físico.

### `POST /api/memory-vault/search`

```json
{ "query": "¿Cómo se llama mi perro?", "topK": 6 }
```

### `GET /api/memory-vault/export`

JSON con todas las memorias del usuario.

---

## 9. Coder

| Método | Ruta | Body |
|---|---|---|
| `GET` | `/api/coder/load?projectId=` | — |
| `POST` | `/api/coder/projects` | `{ name, language? }` |
| `PUT` | `/api/coder/save` | `{ projectId, path, content }` |
| `DELETE` | `/api/coder/files` | `{ projectId, path }` |
| `POST` | `/api/coder/chat` | `{ projectId, message, activeFile, mode }` (SSE) |
| `POST` | `/api/coder/execute` | `{ projectId, command }` |
| `GET` | `/api/coder/export?projectId=` | — |

### `POST /api/coder/execute`

```json
{ "projectId": "uuid", "command": "ls src" }
```

**200**

```json
{ "ok": true, "data": { "stdout": "index.js\nutils/", "stderr": "", "exitCode": 0 } }
```

| Código | Significado |
|---|---|
| 0 | OK |
| 1 | Error del comando |
| 126 | Comando no permitido |
| 127 | No encontrado |

---

## 10. Pagos

### `POST /api/payments/create`

```json
{ "planId": "pro" }
```

**200**

```json
{
  "ok": true,
  "data": {
    "orderId": "5O190127TN364715T",
    "approveUrl": "https://www.paypal.com/checkoutnow?token=...",
    "plan": { "id": "pro", "credits": 500, "priceUsd": 7.5 }
  }
}
```

### `POST /api/payments/capture`

```json
{ "orderId": "5O190127TN364715T" }
```

**200**

```json
{ "ok": true, "data": { "status": "completed", "credits": 500, "plan": "pro", "alreadyCompleted": false } }
```

| Error | Código |
|---|---|
| Orden ajena | 403 `PAYMENT_ORDER_FORBIDDEN` |
| Plan inválido | 400 |
| Captura fallida | 502 `PAYPAL_CAPTURE_FAILED` |

### `GET /api/payments/orders`

Historial del usuario.

### `POST /api/payments/webhook`

Sin auth. Requiere los 5 headers de PayPal y firma válida.

| Situación | Status |
|---|---|
| Firma válida | 200 |
| Firma inválida | 401 `Firma inválida.` |
| Error interno | 500 |

### `POST /api/billing/portal`

Devuelve datos para gestionar la suscripción.

---

## 11. Billing y créditos

### `GET /api/billing/plan`

```json
{ "ok": true, "data": { "plan": "pro", "credits": 412, "renewsAt": "2026-11-20T00:00:00Z" } }
```

### `GET /api/billing/credits/history?limit=50`

```json
{
  "ok": true,
  "data": [
    { "delta": 500, "reason": "purchase", "createdAt": "..." },
    { "delta": -1, "reason": "chat", "createdAt": "..." }
  ]
}
```

### `GET /api/billing/plans`

Catálogo público (sin secretos).

---

## 12. Admin

Requiere `role = admin`.

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/admin/users?q=&plan=&limit=` | Listar usuarios |
| `GET` | `/api/admin/users/:id` | Detalle |
| `PATCH` | `/api/admin/users/:id` | Cambiar plan/role/credits |
| `POST` | `/api/admin/users/:id/suspend` | Suspender |
| `POST` | `/api/admin/users/:id/unsuspend` | Reactivar |
| `GET` | `/api/admin/metrics` | Totales |
| `GET` | `/api/admin/flags` | Flags |
| `PATCH` | `/api/admin/flags/:key` | Activar/desactivar |
| `GET` | `/api/admin/audit?action=&limit=` | Audit log |

### `GET /api/admin/metrics`

```json
{
  "ok": true,
  "data": {
    "users": 1240,
    "active7d": 318,
    "chats": 9821,
    "messages": 143002,
    "revenueUsd": 4820.5,
    "ordersCompleted": 402
  }
}
```

### `POST /api/admin/users/:id/suspend`

```json
{ "hours": 24, "reason": "Spam reiterado" }
```

---

## 13. Feature flags

### `GET /api/flags`

```json
{ "ok": true, "data": { "coder": true, "voice": false, "newCheckout": true } }
```

### `GET /api/flags/:key`

### `PATCH /api/flags/:key` (admin)

```json
{ "enabled": true, "rolloutPct": 25 }
```

`rolloutPct` se evalúa por hash estable del `userId` para que un usuario no vea el flag cambiar entre requests.

---

## 14. Notificaciones

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/notifications` | Lista paginada |
| `POST` | `/api/notifications/:id/read` | Marcar leída |
| `POST` | `/api/notifications/read-all` | Marcar todas |
| `DELETE` | `/api/notifications/:id` | Borrar |
| `GET` | `/api/notifications/unread-count` | Contador |

---

## 15. Prompts

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/prompts` | Lista pública + propias |
| `POST` | `/api/prompts` | Crear |
| `PATCH` | `/api/prompts/:id` | Editar |
| `DELETE` | `/api/prompts/:id` | Borrar |
| `POST` | `/api/prompts/:id/favorite` | Favorito |

---

## 16. Búsqueda web

### `POST /api/search/web`

```json
{ "query": "precio del dólar hoy", "limit": 5 }
```

```json
{
  "ok": true,
  "data": {
    "results": [
      { "title": "...", "url": "https://...", "snippet": "..." }
    ]
  }
}
```

Rate limit: `aiRateLimiter`.

---

## 17. Imágenes

### `POST /api/images/generate`

```json
{ "prompt": "Un gato astronauta", "size": "1024x1024" }
```

Costo: 5 créditos.

```json
{ "ok": true, "data": { "id": "uuid", "url": "https://...", "credits": 5 } }
```

### `GET /api/images`

Galería del usuario.

### `DELETE /api/images/:id`

---

## 18. Voz

### `POST /api/voice/tts`

```json
{ "text": "Hola mundo", "voice": "es-CO-female" }
```

Devuelve `audio/mpeg`.

### `POST /api/voice/stt`

`multipart/form-data` con `audio`. Devuelve `{ text }`.

---

## 19. Sandbox

### `POST /api/sandbox/run`

```json
{ "language": "javascript", "code": "console.log(1+1)" }
```

Ejecución simulada. **No** hay proceso real.

```json
{ "ok": true, "data": { "stdout": "2\n", "stderr": "", "exitCode": 0 } }
```

---

## 20. Webhooks salientes

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/webhooks` | Lista endpoints |
| `POST` | `/api/webhooks` | Crear |
| `PATCH` | `/api/webhooks/:id` | Editar |
| `DELETE` | `/api/webhooks/:id` | Borrar |
| `POST` | `/api/webhooks/:id/test` | Enviar ping |
| `GET` | `/api/webhooks/:id/deliveries` | Historial |

### Crear

```json
{ "url": "https://example.com/hook", "events": ["chat.completed", "payment.completed"] }
```

Respuesta incluye `secret` **una sola vez**.

---

## 21. Ejemplos con curl

### Login y uso de sesión

```bash
curl -c cookies.txt -X POST http://localhost:8080/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"ana@example.com","password":"S3gura!Pass"}'

curl -b cookies.txt http://localhost:8080/api/me
```

### Chat con SSE

```bash
curl -N -b cookies.txt -X POST http://localhost:8080/api/chat/stream \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"chatId":"00000000-0000-0000-0000-000000000000","content":"Hola"}'
```

`-N` desactiva el buffering de curl. Sin él verás todo al final.

### Subir PDF

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/rag/upload \
  -F "file=@tesis.pdf"
```

### Crear orden de pago

```bash
curl -b cookies.txt -X POST http://localhost:8080/api/payments/create \
  -H "Content-Type: application/json" \
  -d '{"planId":"pro"}'
```

---

## 22. Versionado y compatibilidad

| Cambio | Política |
|---|---|
| Nuevo campo en respuesta | No breaking |
| Nuevo endpoint | No breaking |
| Quitar campo | Breaking → anunciar |
| Cambiar tipo | Breaking |
| Cambiar código de error | Breaking |

No hay versionado en la URL (`/v1/`). La API se considera interna: el único cliente es el frontend del mismo repo. Si se abre a terceros, se debe introducir `/v1/` y un plan de deprecación.

---

## 23. Tabla resumen

| Grupo | Endpoints | Auth | Plan |
|---|---|---|---|
| Sistema | 3 | No | — |
| Auth | 8 | Mixto | — |
| Chats | 6 | Sí | free+ |
| Chat stream | 1 | Sí | free+ (créditos) |
| Mensajes | 4 | Sí | free+ |
| Personas | 6 | Sí | free+ |
| RAG | 5 | Sí | pro+ |
| Memoria | 6 | Sí | free+ |
| Coder | 7 | Sí | pro+ |
| Pagos | 4 | Mixto | — |
| Billing | 3 | Sí | free+ |
| Admin | 9 | Admin | — |
| Flags | 3 | Mixto | — |
| Notificaciones | 5 | Sí | free+ |
| Prompts | 5 | Sí | free+ |
| Búsqueda | 1 | Sí | pro+ |
| Imágenes | 3 | Sí | pro+ |
| Voz | 2 | Sí | pro+ |
| Sandbox | 1 | Sí | free+ |
| Webhooks | 6 | Sí | ultimate |

*Total aproximado: 78 endpoints.*

*Ver también: [`security.md`](./security.md) y [`troubleshooting.md`](./troubleshooting.md).*
