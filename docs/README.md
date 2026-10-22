# Numination — Documentación Técnica

> **Versión:** 3.3.0 · **Node:** ≥ 22 · **Runtime:** Express 5 + Postgres.js + Vanilla JS
> **Licencia:** Propietaria — ver [`LICENSE.md`](./LICENSE.md)

---

## 1. Qué es Numination

Numination es una plataforma SaaS de productividad con IA que combina cuatro productos en una sola aplicación:

| Producto | Qué resuelve | Módulo |
|---|---|---|
| **Chat IA** | Conversación con streaming en tiempo real, búsqueda web, adjuntos e imágenes | `src/index.js` |
| **Modo Coder** | IDE en el navegador con editor, file tree, terminal simulada y diff viewer | `src/coder.js`, `api/coder/` |
| **Sistema RAG** | Ingesta de PDFs, chunking, embeddings y búsqueda semántica sobre documentos propios | `src/services/rag-parser.js` |
| **Personas** | Perfiles de IA con system prompt, temperatura, avatar y color propios | `src/routes/personas.js` |

Alrededor de esos cuatro productos existen capas transversales: autenticación (Google, GitHub, email/password), pagos con PayPal, créditos, memoria de largo plazo, webhooks salientes, notificaciones, feature flags, analytics y un panel de administración.

### Visión

Numination no es un wrapper de un modelo. Es un **orquestador** que decide, en tiempo de ejecución, qué motor responde, qué contexto recuperar, cuántos créditos cobrar y qué hacer cuando un proveedor cae. La promesa es simple: **el usuario nunca ve el drama de la infraestructura**.

### Principios de diseño

1. **Degradación elegante.** Si falta pgvector, la app arranca sin vectores. Si falta un proveedor de IA, cae al siguiente. Si falta la DB en un módulo, ese módulo responde con `degraded: true` en lugar de tumbar el proceso.
2. **Seguridad por defecto.** Fail-closed en pagos, fail-open en moderación, rate limiting en capas y verificación criptográfica de webhooks.
3. **Cero frameworks en el cliente.** Vanilla JS puro, sin build step, sin bundler. Lo que se sirve es lo que se escribe.
4. **Idempotencia en todo lo que mueve dinero.** Doble capa: memoria + Postgres.

---

## 2. Stack real

```text
┌─────────────────────────────────────────────────────────────┐
│  Cliente                                                    │
│  HTML5 + CSS3 + Vanilla JS (ES2022, sin bundler)            │
│  · escritura.js  → motor Markdown/highlight                 │
│  · main.js       → chat, SSE, estado                        │
│  · coder.js      → IDE, file tree, terminal, diff           │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTPS / SSE
┌──────────────────────────▼──────────────────────────────────┐
│  Edge / Hosting                                             │
│  Vercel (serverless)  ó  Node 22 (long-running)             │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Aplicación                                                 │
│  Express 5.2 · postgres.js 3.4 · Zod 4 · JWT                │
│  Passport (GitHub) · google-auth-library · Multer           │
└───────┬──────────────────┬───────────────────┬──────────────┘
        │                  │                   │
┌───────▼──────┐  ┌────────▼────────┐  ┌───────▼──────────────┐
│  Postgres    │  │  Proveedores IA │  │  Servicios externos  │
│  Supabase    │  │  Groq           │  │  PayPal REST v2      │
│  + pgvector  │  │  Gemini (×3)    │  │  Brevo (email)       │
│              │  │  NVIDIA / Kimi  │  │  ElevenLabs / OpenAI │
└──────────────┘  └─────────────────┘  └──────────────────────┘
```

Dependencias declaradas en `package.json`:

```json
{
  "@google/genai": "^2.24.0",
  "@octokit/rest": "^21.1.1",
  "@supabase/supabase-js": "^2.117.2",
  "cookie-parser": "^1.4.7",
  "dotenv": "^16.4.5",
  "express": "^5.2.1",
  "express-list-endpoints": "^7.1.1",
  "express-rate-limit": "^7.5.1",
  "google-auth-library": "^11.1.0",
  "groq-sdk": "^1.6.0",
  "jsonwebtoken": "^9.0.3",
  "multer": "^2.4.0",
  "nodemailer": "^10.1.0",
  "openai": "^7.23.0",
  "passport": "^0.7.0",
  "passport-github": "^1.1.0",
  "pdf-parse": "^1.1.4",
  "pdfkit": "^0.17.2",
  "postgres": "^3.4.9",
  "zod": "^4.6.7"
}
```

---

## 3. Mapa de la documentación

| # | Documento | Para quién | Qué encontrarás |
|---|---|---|---|
| 01 | [architecture.md](./architecture.md) | Arquitectos, nuevos devs | Diagramas de flujo, capas, patrón de diseño, ciclo de una request |
| 02 | [installation.md](./installation.md) | DevOps, devs | Requisitos, variables, `npm install`, ngrok, webhooks |
| 03 | [database-schema.md](./database-schema.md) | Backend, DBA | SQL de creación, columnas, tipos, índices, RLS |
| 04 | [ai-orchestration.md](./ai-orchestration.md) | AI engineers | Cascada Groq→Gemini→Kimi, cooldowns, system prompts, contexto |
| 05 | [coder-module.md](./coder-module.md) | Frontend, backend | Monaco, file tree, terminal sandbox, diff viewer |
| 06 | [memory-system.md](./memory-system.md) | AI engineers, DBA | Chunking, embeddings, pgvector, bóveda, decay |
| 07 | [payment-flow.md](./payment-flow.md) | Backend, fintech | Secuencia PayPal, firma de webhooks, ledger |
| 08 | [security.md](./security.md) | Security, SRE | Rate limiting, strikes, HMAC, IDOR, XSS |
| 09 | [api-reference.md](./api-reference.md) | Integradores | ~75 endpoints con método, ruta, params y respuesta |
| 10 | [deployment.md](./deployment.md) | DevOps | Vercel, `vercel.json`, límites serverless |
| 11 | [frontend-guide.md](./frontend-guide.md) | Frontend | Vanilla JS, `escritura.js`, inyección de CSS, SSE |
| 12 | [troubleshooting.md](./troubleshooting.md) | Soporte, on-call | 401, webhooks, caídas de IA, DB |
| 13 | [roadmap.md](./roadmap.md) | Producto | App móvil, WhatsApp, fine-tuning |
| 14 | [contributing.md](./contributing.md) | Contribuidores | Conventional Commits, ESLint, secretos |
| 15 | [api.md](./api.md) | — | Notas legacy de API |

---

## 4. Inicio rápido (60 segundos)

```bash
# 1. Requisitos: Node ≥ 22, Postgres 15+ con pgvector
node --version

# 2. Dependencias
npm install

# 3. Variables (copiar y rellenar)
cp .env.example .env.local

# 4. Migraciones
npm run migrate:status
npm run migrate

# 5. Arrancar
npm run dev        # node --watch src/index.js
# → http://localhost:8080
```

Verificación:

```bash
curl -s http://localhost:8080/api/health | jq
curl -s http://localhost:8080/api/version | jq
```

---

## 5. Estructura del repositorio

```text
.
├── api/                  # Vercel serverless functions + coder handlers
│   ├── index.js          # catch-all → app Express
│   ├── debug.js
│   └── coder/            # load, save, execute, chat, _store
├── docs/                 # esta documentación
├── migrations/           # SQL versionado (001, 002, 003, 2026_10_13)
├── public/               # frontend estático
│   ├── assets/css/       # 6 hojas de estilo
│   ├── assets/js/        # ~45 módulos vanilla
│   ├── assets/img/
│   └── *.html            # chat, coder, admin, login, …
├── scripts/              # smoke tests y auditorías
├── services/             # prompts de coder, parser de contexto
├── src/
│   ├── index.js          # entrada, middleware, rutas inline
│   ├── config.js         # configuración tipada y validada
│   ├── auth.js           # OAuth + password + sesiones
│   ├── chats.js          # CRUD de chats
│   ├── coder.js          # rutas del IDE
│   ├── memories.js       # memorias clásicas
│   ├── connectors.js     # 13 conectores educativos
│   ├── skills.js         # catálogo de skills
│   ├── email.js          # Brevo (API + SMTP)
│   ├── lib/              # cache, crypto, http, jwt, logger, queue, sse
│   ├── middleware/       # auth, ban, errors, ip-guard, rate-limit, rls
│   ├── payments/         # PayPal, idempotencia, ledger, webhooks
│   ├── routes/           # admin, rag, images, voice, personas, …
│   └── services/         # ~40 servicios de dominio
└── tests/                # node:test
```

---

## 6. Convenciones

| Convención | Regla |
|---|---|
| Módulos | ESM (`"type": "module"`), `import`/`export` |
| Nombres de archivo | `kebab-case.js` en `services/`, `camelCase.js` en raíz |
| Respuesta API | Siempre `{ ok: boolean, ... }` |
| Errores | `{ ok: false, error, code, requestId }` |
| Fechas | ISO 8601 UTC en JSON; `timestamptz` en Postgres |
| IDs | UUID v4 (`crypto.randomUUID()`), salvo `Memory.id` que es TEXT |
| Idioma de UI | Español (es-CO) |
| Idioma de código | Inglés para identificadores, español para mensajes de usuario |

---

## 7. Estado del proyecto

| Área | Estado | Nota |
|---|---|---|
| Chat + SSE | ✅ Producción | Streaming con heartbeat y timeout |
| Cascada IA | ✅ Producción | 3 proveedores, 3 keys de Gemini |
| RAG | ✅ Producción | Degrada sin pgvector |
| Coder | ✅ Producción | Sandbox simulado, no ejecución real |
| PayPal | ✅ Producción | Firma verificada vía API de PayPal |
| Tests | ⚠️ Parcial | `tests/audit-regression.test.js` |
| Cobertura | ❌ No medida | Pendiente integrar c8 |

---

## 8. Advertencia de seguridad

Este repositorio contiene lógica comercial sensible. **No publiques** `env.local.js`, `.env.local`, claves de API, tokens de PayPal ni cadenas de conexión. Ver [`security.md`](./security.md) y [`contributing.md`](./contributing.md).

---

*Documentación mantenida por el equipo de Numination. Última revisión: octubre 2026.*
