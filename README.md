# Numination

**La IA que habla el idioma de nuestra educación.**

[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15%2B-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![License](https://img.shields.io/badge/license-Proprietary-red)](docs/LICENSE.md)
[![Build](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/trivoren/Numination/actions)
[![Version](https://img.shields.io/badge/version-3.3.0-blue)](https://github.com/trivoren/Numination/releases)

> Un SaaS de productividad con IA que orquesta modelos, contexto y créditos para que el usuario nunca vea el drama de la infraestructura.

[Demo en vivo](https://numination.app) · [Documentación](docs/README.md) · [API](docs/api-reference.md) · [Contribuir](CONTRIBUTING.md) · [Seguridad](SECURITY.md)

---

## ¿Qué es Numination?

Numination es una plataforma de IA para programadores, estudiantes y equipos que combina cuatro productos en una sola aplicación:

| Producto | Qué resuelve |
|---|---|
| **Chat IA** | Conversación con streaming en tiempo real, búsqueda web, adjuntos e imágenes |
| **Modo Coder** | IDE en el navegador con editor, file tree, terminal simulada y diff viewer |
| **Sistema RAG** | Ingesta de PDFs, chunking, embeddings y búsqueda semántica sobre documentos propios |
| **Personas** | Perfiles de IA con system prompt, temperatura, avatar y color configurables |

Alrededor de esos productos viven capas transversales: autenticación con Google, GitHub y email/password; pagos con PayPal; créditos; memoria de largo plazo; webhooks salientes; notificaciones; feature flags; analytics; y un panel de administración.

No es un wrapper de un modelo. Es un **orquestador** que decide en tiempo de ejecución qué motor responde, qué contexto recuperar, cuántos créditos cobrar y qué hacer cuando un proveedor cae.

---

## Features

- 💬 **Chat IA con streaming** — respuestas token por token vía SSE, con heartbeat y timeout.
- 🧑‍💻 **Modo Coder** — escribe, depura, explica y refactoriza código con un IDE integrado.
- 🧠 **Razonamiento paso a paso** — proceso interno separado de la respuesta final.
- 📚 **RAG sobre tus documentos** — sube PDFs, fragmenta, genera embeddings y consulta con búsqueda semántica.
- 🔌 **13 conectores externos** — Wikipedia, NASA, Open Trivia, datos de Colombia y más.
- 🎭 **Personas configurables** — system prompt, temperatura, avatar y color por perfil.
- 🧾 **Pagos y créditos** — PayPal REST v2, ledger idempotente y catálogo de planes.
- 🔐 **Autenticación completa** — Google, GitHub y email/password con cookies `HttpOnly`.
- 🕵️ **Modo incógnito** — conversaciones que no se guardan ni aparecen en el historial.
- 🧬 **Memoria de largo plazo** — la IA recuerda contexto relevante entre sesiones.
- 🛡️ **Seguridad por capas** — rate limiting, verificación de webhooks y aislamiento por usuario.
- ⚡ **Multi-motor con fallback** — Groq → Gemini → Kimi, sin que el usuario note la caída.

---

## Stack

```text
Cliente      HTML5 + CSS3 + Vanilla JS (ES2022, sin bundler)
Servidor     Node.js ≥ 22 · Express 5 · Zod 4 · JWT
Base de datos PostgreSQL 15+ (Supabase) · pgvector opcional
IA           Groq · Google Gemini (×3 keys) · NVIDIA NIM / Kimi
Pagos        PayPal REST v2
Email        Brevo / Resend
Deploy       Vercel (serverless) · Node 22 (long-running)
Testing      node:test · supertest · nock
```

---

## Arquitectura en 30 segundos

```mermaid
flowchart LR
    U[Usuario] --> W[Frontend Vanilla JS]
    W -->|HTTPS / SSE| E[Express 5]
    E --> A[Auth + Rate Limit]
    A --> O[Orquestador IA]
    O --> G[Groq]
    O --> GM[Gemini]
    O --> K[Kimi]
    O --> R[RAG / pgvector]
    E --> P[(PostgreSQL)]
    E --> PAY[PayPal]
    E --> M[Brevo / Resend]
```

La regla es simple: **degradación elegante**. Si falta pgvector, la app arranca sin vectores. Si un proveedor de IA falla, se usa el siguiente. Si un módulo no puede acceder a la base de datos, responde `degraded: true` en lugar de tumbar el proceso.

---

## Quick Start

### Requisitos

- Node.js **22 o superior**
- PostgreSQL **15+** (Supabase es la opción recomendada)
- Cuenta de Groq (gratis)
- Cuenta de Google Cloud y GitHub (para OAuth)
- Cuenta de PayPal (para probar pagos)

### Instalación

```bash
# 1. Clonar el repositorio
git clone https://github.com/trivoren/Numination.git
cd Numination

# 2. Instalar dependencias
npm install

# 3. Crear el archivo de entorno
cp .env.example env.local.js
# Edita env.local.js con tus credenciales. Nunca lo subas a Git.

# 4. Verificar el estado de las migraciones
npm run migrate:status

# 5. Aplicar migraciones
npm run migrate

# 6. Arrancar en desarrollo
npm run dev
```

Abre [http://localhost:8080](http://localhost:8080) y verifica el estado del servidor:

```bash
curl -s http://localhost:8080/api/health
curl -s http://localhost:8080/api/version
```

### Variables de entorno esenciales

El servidor carga `env.local.js` en desarrollo. También acepta variables de entorno normales en Vercel o en un archivo `.env`.

```js
// env.local.js
export const TEST_KEYS = {
  DATABASE_URL: 'postgresql://usuario:password@host:5432/numination',
  JWT_SECRET: 'una-clave-aleatoria-de-64-caracteres',
  GOOGLE_CLIENT_ID: '...',
  GOOGLE_CLIENT_SECRET: '...',
  GITHUB_CLIENT_ID: '...',
  GITHUB_CLIENT_SECRET: '...',
  GROQ_API_KEY: 'gsk_...',
  GEMINI_API_KEY: 'AIza...',
  GEMINI_API_KEY_2: 'AIza...',
  GEMINI_API_KEY_3: 'AIza...',
  NVIDIA_API_KEY: 'nvapi-...',
  BREVO_SMTP_USER: '...',
  BREVO_SMTP_PASSWORD: '...',
  BREVO_FROM_EMAIL: 'no-reply@numination.app',
};
```

La lista completa, con valores de ejemplo y notas de seguridad, está en [`.env.example`](.env.example) y en [`docs/installation.md`](docs/installation.md).

---

## Scripts disponibles

| Comando | Qué hace |
|---|---|
| `npm run dev` | Desarrollo con auto-reload (`node --watch`) |
| `npm start` | Arranque en producción |
| `npm test` | Ejecuta la suite con `node:test` |
| `npm run migrate` | Aplica migraciones pendientes |
| `npm run migrate:down` | Revierte la última migración |
| `npm run migrate:status` | Muestra el estado de las migraciones |
| `npm run migrate:fresh` | Recrea la base de datos (solo desarrollo) |
| `npm run test:coder` | Smoke test del módulo Coder |
| `npm run test:coder:api` | Smoke test de la API del Coder |
| `npm run audit:coder` | Auditoría de wiring del Coder |

Antes de abrir un Pull Request, ejecuta siempre:

```bash
npm ci
npm test
npm audit --omit=dev
```

---

## Estructura del repositorio

```text
.
├── api/                  # Vercel serverless functions + handlers del Coder
├── docs/                 # Documentación técnica completa
├── migrations/           # SQL versionado
├── public/               # Frontend estático (HTML + JS vanilla)
├── scripts/              # Smoke tests y auditorías
├── services/             # Prompts y parser de contexto
├── src/
│   ├── index.js          # Entrada, middleware y rutas core
│   ├── config.js         # Configuración tipada y validada
│   ├── auth.js           # OAuth + password + sesiones
│   ├── chats.js          # CRUD de chats
│   ├── coder.js          # Rutas del IDE
│   ├── memories.js       # Memorias clásicas
│   ├── connectors.js     # Conectores externos
│   ├── skills.js         # Catálogo de skills
│   ├── email.js          # Email transaccional
│   ├── lib/              # Cache, crypto, HTTP, JWT, logger, queue, SSE
│   ├── middleware/       # Auth, ban, errores, IP guard, rate limit, RLS
│   ├── payments/         # PayPal, idempotencia, ledger, webhooks
│   ├── routes/           # Admin, RAG, imágenes, voz, personas
│   └── services/         # Servicios de dominio
└── tests/                # Suite con node:test
```

---

## API

Todos los endpoints viven bajo `/api/`. La referencia completa, con parámetros y respuestas, está en [`docs/api-reference.md`](docs/api-reference.md).

| Área | Endpoints principales |
|---|---|
| Autenticación | `POST /api/auth/register`, `POST /api/auth/login`, `GET /api/auth/me` |
| Chat | `GET /api/chats`, `POST /api/chat/stream`, `POST /api/chat` |
| Memorias | `GET /api/memories`, `POST /api/memories`, `GET /api/memories/stats` |
| RAG | `POST /api/rag/upload`, `POST /api/rag/query` |
| Coder | `POST /api/coder/chat`, `POST /api/coder/execute` |
| Pagos | `POST /api/payments/orders`, `POST /api/payments/webhooks/paypal` |
| Salud | `GET /api/health`, `GET /api/version` |

Todas las respuestas siguen el contrato:

```json
{ "ok": true, "data": {} }
```

```json
{ "ok": false, "error": "Descripción legible", "code": "ERROR_CODE", "requestId": "uuid" }
```

---

## Seguridad

- Contraseñas con hash fuerte y verificación de longitud.
- Cookies `HttpOnly`, `SameSite=Lax` y `Secure` en producción.
- JWT firmados con expiración y soporte de revocación por `jti`.
- Rate limiting por IP, por usuario y por plan.
- Verificación criptográfica de webhooks de PayPal.
- Firma HMAC-SHA256 en webhooks salientes.
- Aislamiento de recursos por `user_id` en todas las consultas.
- Validación de entrada con Zod en el borde.
- CSP, cabeceras de seguridad y saneamiento de HTML/URLs.

Si encuentras una vulnerabilidad, **no abras un issue público**. Sigue el proceso descrito en [SECURITY.md](SECURITY.md) y escribe a [security@numination.com](mailto:security@numination.com).

---

## Documentación

| Documento | Para qué sirve |
|---|---|
| [docs/README.md](docs/README.md) | Índice y mapa completo de la documentación |
| [docs/installation.md](docs/installation.md) | Instalación paso a paso, variables y ngrok |
| [docs/architecture.md](docs/architecture.md) | Capas, flujos y ciclo de una request |
| [docs/api-reference.md](docs/api-reference.md) | Contratos de la API |
| [docs/database-schema.md](docs/database-schema.md) | Esquema SQL, índices y RLS |
| [docs/ai-orchestration.md](docs/ai-orchestration.md) | Cascada de modelos y prompts |
| [docs/coder-module.md](docs/coder-module.md) | IDE, file tree, terminal y diff viewer |
| [docs/memory-system.md](docs/memory-system.md) | Chunking, embeddings y pgvector |
| [docs/payment-flow.md](docs/payment-flow.md) | PayPal, idempotencia y ledger |
| [docs/security.md](docs/security.md) | Modelo de amenazas y controles |
| [docs/deployment.md](docs/deployment.md) | Vercel y límites serverless |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Diagnóstico de problemas comunes |
| [docs/roadmap.md](docs/roadmap.md) | Próximas capacidades |

---

## Contribuir

Numination es software propietario. Las contribuciones externas están sujetas a revisión y cesión de derechos patrimoniales al titular.

Antes de enviar un Pull Request:

1. Lee [CONTRIBUTING.md](CONTRIBUTING.md).
2. Respeta el [Código de Conducta](CODE_OF_CONDUCT.md).
3. Ejecuta `npm test`.
4. Verifica que no hay secretos en tu diff.
5. Abre el PR con la plantilla incluida.

---

## Soporte

- 🐛 **Bugs reproducibles:** abre un issue con la [plantilla de bug](.github/ISSUE_TEMPLATE/bug_report.md).
- ❓ **Preguntas y discusiones:** usa [GitHub Discussions](https://github.com/trivoren/Numination/discussions).
- 📖 **Documentación:** empieza por [docs/README.md](docs/README.md).
- 💬 **Comunidad:** únete al [Discord de Numination](https://discord.gg/numination).
- 📧 **Soporte directo:** [soporte@numination.app](mailto:soporte@numination.app).

Más detalles en [.github/SUPPORT.md](.github/SUPPORT.md).

---

## Licencia

**Todos los derechos reservados.** Numination es propiedad de sus fundadores. El código fuente no es de código abierto y no se concede permiso para copiarlo, modificarlo ni redistribuirlo sin autorización escrita.

Consulta [`docs/LICENSE.md`](docs/LICENSE.md) para los términos completos.

---

## Estado del proyecto

| Área | Estado |
|---|---|
| Backend | ✅ Producción — módulos de dominio y 70+ endpoints |
| Chat + SSE | ✅ Producción — streaming con heartbeat y timeout |
| Cascada IA | ✅ Producción — 3 proveedores y rotación de keys |
| RAG | ✅ Producción — degrada sin pgvector |
| Coder | ✅ Producción — sandbox simulado, no ejecución real |
| Pagos | ✅ Producción — firma verificada e idempotencia |
| Tests | ⚠️ Parcial — cobertura en expansión |
| Frontend | ✅ Producción — vanilla JS sin build step |

---

<div align="center">

**Numination** · Hecho con amor en Barranquilla, Colombia 🇨🇴 · 2026

[Web](https://numination.app) · [GitHub](https://github.com/trivoren/Numination) · [Documentación](docs/README.md)

</div>
