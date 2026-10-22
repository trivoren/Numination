# Instalación y Entorno Local

> **Tiempo estimado:** 15–25 minutos con todo preinstalado.
> **Verificado contra:** `package.json` 3.3.0, Node ≥ 22, Express 5.2.

---

## 1. Requisitos

| Componente | Versión mínima | Verificación | Nota |
|---|---|---|---|
| Node.js | 22.x | `node --version` | `engines.node: ">=22"`. Usa `fetch` nativo y `node:test` |
| npm | 10.x | `npm --version` | Incluido con Node 22 |
| PostgreSQL | 15+ | `psql --version` | Supabase cumple |
| pgvector | 0.5+ | `SELECT extversion FROM pg_extension WHERE extname='vector';` | Opcional pero requerido para RAG semántico |
| Git | 2.40+ | `git --version` | |
| ngrok (opcional) | 3.x | `ngrok --version` | Solo para probar webhooks PayPal en local |

### Sistema operativo

| SO | Estado | Notas |
|---|---|---|
| Windows 11 | ✅ Soportado | PowerShell 7 recomendado |
| macOS 14+ | ✅ Soportado | |
| Linux (Ubuntu 22.04+) | ✅ Soportado | Producción recomendada |
| WSL2 | ✅ Soportado | Usar el filesystem de Linux, no `/mnt/c`, para evitar lentitud |

---

## 2. Clonar e instalar

```bash
git clone <repo-url> numination
cd numination
npm ci
```

> Usa `npm ci` en lugar de `npm install` para respetar `package-lock.json` exactamente. Si no existe el lock, usa `npm install`.

### Verificar integridad

```bash
npm ls --depth=0
node -e "console.log(process.versions.node)"
```

Debe imprimir `v22.x` o superior. Con Node 20 el arranque falla por APIs de `fetch`/`AbortSignal` usadas en streaming.

---

## 3. Variables de entorno

Copia la plantilla:

```bash
cp .env.example .env.local
```

`src/config.js` carga `.env.local` y luego `.env` (el primero gana). **Nunca** subas ninguno de los dos.

### 3.1 Núcleo

| Variable | Obligatoria | Ejemplo | Descripción |
|---|---|---|---|
| `NODE_ENV` | Sí | `development` | `development` \| `production` \| `test` |
| `PORT` | No | `8080` | Puerto HTTP |
| `APP_URL` | Sí | `http://localhost:8080` | Base para callbacks OAuth y links de email |
| `DATABASE_URL` | Sí | `postgresql://user:pass@host:5432/postgres` | Cadena de conexión. En Supabase, usar el **pooler** puerto 6543 |
| `JWT_SECRET` | Sí | 64+ chars aleatorios | Firma de sesiones. En producción el arranque falla si falta |
| `SESSION_TTL_DAYS` | No | `30` | Duración de sesión |
| `CORS_ORIGINS` | No | `http://localhost:8080` | Lista separada por comas |

Genera el secreto:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### 3.2 OAuth

| Variable | Dónde obtenerla |
|---|---|
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud Console → APIs & Services → Credentials |
| `GOOGLE_CALLBACK_URL` | Debe ser exactamente `${APP_URL}/api/auth/google/callback` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub → Settings → Developer settings → OAuth Apps |
| `GITHUB_CALLBACK_URL` | `${APP_URL}/api/auth/github/callback` |

> El callback debe coincidir **carácter por carácter**. Un `http` vs `https` o una barra final de más producen `redirect_uri_mismatch`.

### 3.3 Proveedores de IA

| Variable | Proveedor | Modelo por defecto | Obligatoria |
|---|---|---|---|
| `GROQ_API_KEY` | Groq | Llama 3.x | Recomendada |
| `GEMINI_API_KEY` | Google AI Studio | Gemini Flash | Recomendada |
| `GEMINI_API_KEY_2` | Google AI Studio | — | Opcional (rotación) |
| `GEMINI_API_KEY_3` | Google AI Studio | — | Opcional (rotación) |
| `NVIDIA_API_KEY` | NVIDIA NIM | Kimi / otros | Opcional |
| `KIMI_API_KEY` | Moonshot | Kimi | Opcional |
| `OPENAI_API_KEY` | OpenAI | Embeddings / imágenes | Opcional |

Con **una sola** key el sistema funciona. La cascada se construye solo con los proveedores configurados.

### 3.4 Pagos

| Variable | Ejemplo | Descripción |
|---|---|---|
| `PAYPAL_MODE` | `sandbox` | `sandbox` \| `live` |
| `PAYPAL_CLIENT_ID` | `AX...` | App de PayPal Developer |
| `PAYPAL_CLIENT_SECRET` | `EL...` | Secreto de la app |
| `PAYPAL_WEBHOOK_ID` | `WH-...` | ID del webhook registrado |

### 3.5 Email

| Variable | Descripción |
|---|---|
| `BREVO_API_KEY` | API v3 de Brevo (recomendado) |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Alternativa SMTP |
| `MAIL_FROM` | Remitente verificado |

### 3.6 Ejemplo completo mínimo

```dotenv
NODE_ENV=development
PORT=8080
APP_URL=http://localhost:8080
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/numination
JWT_SECRET=cambia-esto-por-64-bytes-aleatorios
GROQ_API_KEY=gsk_xxx
GEMINI_API_KEY=AIza_xxx
PAYPAL_MODE=sandbox
PAYPAL_CLIENT_ID=AXxxx
PAYPAL_CLIENT_SECRET=ELxxx
PAYPAL_WEBHOOK_ID=WH-xxx
```

---

## 4. Base de datos

### Opción A — Supabase (recomendado)

1. Crear proyecto en [supabase.com](https://supabase.com).
2. Settings → Database → Connection string → **Transaction pooler** (puerto 6543).
3. Copiar a `DATABASE_URL` agregando `?sslmode=require`.
4. SQL Editor → ejecutar:

```sql
create extension if not exists "vector";
create extension if not exists "pgcrypto";
```

5. Ejecutar las migraciones del repo (ver abajo).

### Opción B — Postgres local con Docker

```bash
docker run -d --name numination-db \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=numination \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/numination
```

### Migraciones

```bash
npm run migrate:status   # lista aplicadas / pendientes
npm run migrate          # aplica en orden
```

El runner (`src/services/migrations.js`) crea la tabla `_migrations` y registra cada archivo por nombre. Es **idempotente**: reejecutar no duplica.

| Archivo | Qué hace |
|---|---|
| `001_add_sources_to_messages.sql` | Añade `sources` a mensajes |
| `002_add_files_to_projects.sql` | Adjuntos por proyecto |
| `003_revoked_sessions.sql` | Revocación de sesiones |
| `2026_10_13_long_term_memory.sql` | Tablas y RPC de memoria |

> ⚠️ Las tablas base `profiles`, `"Chat"`, `"Message"`, `"Memory"` **no** se crean desde este repo: son preexistentes en el proyecto Supabase. Si partes de una DB vacía, créalas antes con [`database-schema.md`](./database-schema.md).

---

## 5. Arrancar

```bash
npm run dev
```

Salida esperada:

```text
[info] numination v3.3.0 starting
[info] env=development port=8080
[info] db connected
[info] ai providers: groq, gemini, kimi
[info] listening http://localhost:8080
```

Verifica:

```bash
curl -s http://localhost:8080/api/health
# {"ok":true,"status":"healthy","db":"up","uptime":12.4}

curl -s http://localhost:8080/api/version
# {"ok":true,"version":"3.3.0","node":"v22.x"}
```

Abre `http://localhost:8080` en el navegador.

### Scripts disponibles

| Script | Comando | Uso |
|---|---|---|
| `npm run dev` | `node --watch src/index.js` | Desarrollo con recarga |
| `npm start` | `node src/index.js` | Producción |
| `npm test` | `node --test` | Tests |
| `npm run migrate` | runner | Aplicar migraciones |
| `npm run migrate:status` | runner | Ver estado |

---

## 6. Webhooks de PayPal en local

PayPal no puede llamar a `localhost`. Necesitas un túnel:

```bash
ngrok http 8080
# Forwarding  https://abcd-1234.ngrok-free.app -> http://localhost:8080
```

1. PayPal Developer → tu app → Webhooks → Add.
2. URL: `https://abcd-1234.ngrok-free.app/api/payments/webhook`.
3. Eventos: `PAYMENT.CAPTURE.COMPLETED`, `CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.DENIED`, `PAYMENT.CAPTURE.REFUNDED`.
4. Copiar el `WEBHOOK ID` (`WH-...`) a `PAYPAL_WEBHOOK_ID`.
5. Actualizar `APP_URL` al dominio de ngrok para que el retorno del checkout funcione.

### Probar el webhook

```bash
curl -i -X POST https://abcd-1234.ngrok-free.app/api/payments/webhook \
  -H "Content-Type: application/json" \
  -H "paypal-transmission-id: test" \
  -H "paypal-transmission-sig: test" \
  -H "paypal-transmission-time: 2026-10-21T00:00:00Z" \
  -H "paypal-cert-url: https://api.paypal.com/v1/notifications/certs/CERT-xxx" \
  -H "paypal-auth-algo: SHA256withRSA" \
  -d '{"event_type":"PAYMENT.CAPTURE.COMPLETED"}'
```

Respuesta esperada en local sin firma válida: **401 `Firma inválida.`**. Eso confirma que el guard funciona. Un 200 con datos de prueba significa que la verificación está desactivada — revísalo antes de producción.

> La verificación se delega a `POST /v1/notifications/verify-webhook-signature` de PayPal, no se hace criptografía local. Ver [`payment-flow.md`](./payment-flow.md).

---

## 7. Problemas comunes de instalación

| Síntoma | Causa | Solución |
|---|---|---|
| `Error: Cannot find module 'src/index.js'` | `"type": "module"` y ruta relativa mal | Usa `node src/index.js` desde la raíz |
| `ECONNREFUSED 127.0.0.1:5432` | Postgres no corre | `docker ps` / inicia el servicio |
| `self signed certificate in certificate chain` | Proxy corporativo | `NODE_TLS_REJECT_UNAUTHORIZED=0` **solo en local** |
| `password authentication failed` | URL mal escapada | Codifica `@` como `%40` en la contraseña |
| `relation "profiles" does not exist` | DB vacía | Ejecuta el DDL de `database-schema.md` |
| `vector type not found` | pgvector no instalado | `create extension vector;` |
| `EADDRINUSE :8080` | Otro proceso | `PORT=8081 npm run dev` |
| `JWT_SECRET is required` | Falta en `.env.local` | Añádelo |
| `redirect_uri_mismatch` | Callback distinto | Copia la URL exacta de Google/GitHub |
| SSE se corta a los 30 s | Proxy buffering | Revisa `X-Accel-Buffering: no` y heartbeat |

### Diagnóstico rápido

```bash
# ¿Qué escucha en 8080?
netstat -ano | findstr :8080      # Windows
lsof -i :8080                      # macOS/Linux

# ¿La DB responde?
psql "$DATABASE_URL" -c "select now();"

# ¿pgvector?
psql "$DATABASE_URL" -c "select extversion from pg_extension where extname='vector';"

# ¿Endpoints registrados?
curl -s http://localhost:8080/api/endpoints | head -c 800
```

---

## 8. Configuración del IDE

### VS Code (recomendado)

Extensiones:

| Extensión | Para qué |
|---|---|
| ESLint | Estilo |
| Prettier | Formato |
| PostgreSQL | Explorar la DB |
| REST Client | Probar endpoints desde `.http` |
| Mermaid Preview | Ver diagramas de `docs/` |

`.vscode/launch.json`:

```json
{
  "version": "0.2.0",
  "configurations": [{
    "type": "node",
    "request": "launch",
    "name": "Numination dev",
    "program": "${workspaceFolder}/src/index.js",
    "envFile": "${workspaceFolder}/.env.local",
    "skipFiles": ["<node_internals>/**"]
  }]
}
```

Debug del SSE: pon breakpoint en el handler de `/api/chat/stream` y desactiva `node --watch` para evitar reinicios que cortan el stream.

---

## 9. Checklist de instalación

- [ ] Node ≥ 22 confirmado
- [ ] `npm ci` sin errores
- [ ] `.env.local` creado y **no** versionado
- [ ] `DATABASE_URL` conecta (`select now()`)
- [ ] `pgvector` instalado (si se usa RAG)
- [ ] `JWT_SECRET` de 64+ caracteres
- [ ] Al menos un proveedor de IA configurado
- [ ] `npm run migrate` aplicado
- [ ] `/api/health` devuelve `ok:true`
- [ ] `/api/version` devuelve `3.3.0`
- [ ] Login con email funciona
- [ ] Login OAuth redirige correctamente
- [ ] ngrok activo si se prueban pagos
- [ ] Webhook responde 401 con firma falsa

---

## 10. Siguiente paso

- Entender el modelo de datos: [`database-schema.md`](./database-schema.md)
- Entender la IA: [`ai-orchestration.md`](./ai-orchestration.md)
- Entender los pagos: [`payment-flow.md`](./payment-flow.md)
- Si algo falla: [`troubleshooting.md`](./troubleshooting.md)
