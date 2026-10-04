# Numination — Arquitectura

> Documento de referencia técnica. Todo lo que está aquí se verificó leyendo el
> código del repo, no de memoria. Si el código cambia, actualiza este archivo.
>
> **Última verificación:** commit `3942aba`

---

## 1 · Qué es Numination

Plataforma educativa colombiana con IA. El estudiante habla con un tutor que
**no le da la respuesta**: lo guía con preguntas. Produit real en
<https://numinationchat.vercel.app>.

- **Eslogan:** "La IA que habla el idioma de nuestra educación"
- **Fundadores:** Álvaro García Gómez y Robinson Rodríguez Gómez
- **Modelo de marca:** Numi-OT.01 (por debajo usa Groq / Gemini / Kimi, pero el
  usuario nunca ve esos nombres)
- **Stack:** JavaScript puro ESM, Express 5, HTML/CSS/JS vanilla. Sin frameworks,
  sin TypeScript, sin build step.

---

## 2 · Estructura del proyecto

```
numination ai web/
├── api/
│   └── index.js              Wrapper de Vercel → src/index.js
├── public/                   Todo el frontend (vanilla)
│   ├── index.html            Landing
│   ├── login.html            Login Google + GitHub (JS inline)
│   ├── chat.html             Chat principal (~2700 líneas, todo inline)
│   ├── incognito.html        Chat aislado en popup
│   ├── precio.html           4 planes
│   ├── terminos.html         Legal
│   └── assets/
│       ├── css/  auth.css (v3) · main.css (v6 Nocturno)
│       └── js/   main.js (v6) · skills.js (18 skills)
├── src/
│   ├── index.js              Servidor Express (v3.3) — rutas, cascada, SSE
│   ├── auth.js               Google + GitHub + JWT
│   ├── chats.js              CRUD de chats
│   ├── memories.js           CRUD de memorias
│   └── services/
│       ├── streaming.js      streamGroq + streamGemini
│       ├── supabase.js       postgres.js (SQL directo) + helpers
│       └── limits.js         Upstash Redis (REST, sin SDK)
├── docs/architecture.md      Este archivo
└── vercel.json               functions + rewrites
```

**Fuera de git** (nunca se suben): `env.local.js`, `.env.local`, `node_modules/`,
`.vercel/`, `data/`, `*.backup`

---

## 3 · Flujo de autenticación

Hay **dos puertas de entrada** y las dos terminan en lo mismo: un JWT dentro de
una cookie `httpOnly` llamada `numination_session`.

```
                    ┌─────────────────────────┐
                    │  /login.html            │
                    │  (botones Google/GitHub)│
                    └────────┬────────────────┘
                             │
              ┌──────────────┴──────────────┐
              │                             │
    BOTÓN GOOGLE                   BOTÓN GITHUB
              │                             │
              ▼                             ▼
   ┌────────────────────┐      ┌──────────────────────────┐
   │ Google Identity    │      │ GET /api/auth/github     │
   │ Services (GSI)     │      │ (redirect, scope:        │
   │ popup en el        │      │  "user:email")           │
   │ navegador          │      └────────────┬─────────────┘
   └─────────┬──────────┘                   │
             │ idToken JWT                   ▼
             ▼                    github.com/login/oauth/authorize
   ┌────────────────────┐                   │
   │ POST               │◄──────────────────┘
   │ /api/auth/google   │      (GitHub redirige a la callback)
   └─────────┬──────────┘
             │                          │
             │  verifyIdToken()         │  passport-github exchange
             │  (google-auth-library)   │  → accessToken
             ▼                          ▼
   ┌──────────────────────────────────────────────┐
   │        resolverEmailGitHub()  ← NUEVO        │
   │  GET api.github.com/user/emails             │
   │  1. primary:true + verified:true            │
   │  2. primer verified                          │
   │  3. email público del perfil                 │
   │  4. usuario@github.local (último recurso)    │
   │  ⚠ Si GitHub falla → fallback (login sigue)  │
   └──────────────────┬───────────────────────────┘
                      │  email en minúsculas
                      ▼
   ┌──────────────────────────────────────────────┐
   │           findOrCreateUser()                 │
   │  getProfileByEmail(email)                    │
   │      ├─ existe → updateLastLogin → Devuelve  │
   │      └─ no     → createProfile (uuid v4)     │
   │  ⚠ Si Supabase falla → usuario en memoria    │
   └──────────────────┬───────────────────────────┘
                      │
                      ▼
   ┌──────────────────────────────────────────────┐
   │ jwt.sign({ sub, email, role })               │
   │ → Set-Cookie: numination_session             │
   │   httpOnly · secure(prod) · sameSite=lax     │
   │   maxAge 30 días (o 1 día si "no recordar")  │
   └──────────────────┬───────────────────────────┘
                      │
                      ▼
              redirect → /chat.html

   ┌──────────────────────────────────────────────┐
   │  EN CADA REQUEST:  attachUser()              │
   │  lee la cookie → jwt.verify() → req.user     │
   │  si no hay cookie: NO bloquea, sigue igual   │
   └──────────────────────────────────────────────┘
```

**Punto clave:** `findOrCreateUser()` busca **por email**, no por proveedor. Por
eso resolver el email real de GitHub importa: si no, alguien que entra con
GitHub (email privado) y luego con Google (email real) se queda con **dos
cuentas** y sus chats partidos en dos.

**Rutas protegidas:** `attachUser` no bloquea nada. El bloqueo real son
`requireAuth` (en `/api/chats*` y `/api/memories*`) y un middleware aparte que
redirige a `/login.html` cuando pides `/chat.html` sin sesión.

---

## 4 · Cascada de motores de IA

Si un motor falla, se cae al siguiente. El orden cambia según haya archivo o no.

```
   POST /api/chat/stream   { message, role, file?, incognito? }
              │
              ▼
   ┌──────────────────────┐
   │ 1. verificarLimite() │  ← ANTES de todo (ver sección 5)
   └──────────┬───────────┘
              │ permitido
              ▼
   ┌──────────────────────┐
   │ 2. cargarMemorias()  │  ← [] si incognito === true
   │ 3. buildSystemPrompt │    ← las memorias van AQUÍ adentro
   │ 4. setupSSE()        │    ← Content-Type: text/event-stream
   └──────────┬───────────┘
              │
              ▼
      ¿hay archivo adjunto?
        │              │
       SÍ             NO
        │              │
        ▼              ▼
 ┌─────────────┐  ┌─────────────┐
 │ 1. GEMINI   │  │ 1. GROQ     │
 │ 2. KIMI     │  │ 2. GEMINI   │
 │ 3. GROQ     │  │ 3. KIMI     │
 └─────────────┘  └─────────────┘
        │              │
        └──────┬───────┘
               ▼
    ¿todos agotados? ──SÍ──► SSE: { error, done: true }  (503 si es /api/chat)
               │ NO
               ▼
   ┌─────────────────────────────────────────┐
   │  SSE: { meta, plan, restanteDia, ... }  │  (solo la 1ª vez)
   │  SSE: { token, done: false }            │  repetido por cada trozo
   │  SSE: { token, done: true, provider }   │  → el frontend sabe
   │                                          │    cuál motor respondió
   └─────────────────────────────────────────┘
```

### Los tres motores

| # | Id interno | Proveedor | Modelo | Endpoint | Velocidad |
|---|-----------|-----------|--------|----------|-----------|
| 1 | `groq` | Groq | `openai/gpt-oss-120b` | API Groq | 2-3 s |
| 2 | `gemini` | Google | `gemini-3.6-flash` | API Gemini | medio |
| 3 | `nvidia` | NVIDIA | `moonshotai/kimi-k3` | `integrate.api.nvidia.com/v1` | lento |

> **Ojo con el nombre:** el id interno de Kimi K3 es `nvidia` porque se pide
> a través del API de NVIDIA. `nvidia` NO significa que sea un modelo de NVIDIA.
> Por eso `/api/health` responde `motors: ["gemini","nvidia","groq"]`.

### El pool de 3 keys de Gemini

Gemini es el único con pool, porque es el que más falla por cuota:

```
   GEMINI_API_KEY  ─┐
   GEMINI_API_KEY_2 ─┼─→ geminiPool[3]  →  geminiCandidates()
   GEMINI_API_KEY_3 ─┘         │
                               ▼
                  filtra las que NO están en cooldown
                               │
                  ┌────────────┴────────────┐
                  │ todas bien  → usa la #1    │
                  │ todas malas → next motor │
                  └─────────────────────────┘

   Si una key falla:  cooldown 60 s  (Grave: 429, 503, error de red)
   Si da timeout:    cooldown 15 s  (soft: solo esa respuesta)
```

### Modos de respuesta

| `role` | Qué hace |
|--------|----------|
| `student` (por defecto) | Tutor normal. El system prompt le prohíbe dar la respuesta directa. |
| `coder` | Programador. Responder con código ejecutable. |
| `reasoning` | Inyecta `<thinking>...</thinking>` antes de la respuesta. El frontend lo pinta como bloque colapsable. |

---

## 5 · Rate limiting con Upstash Redis

Contador por día (medianoche Colombia, UTC-5) y por minuto. Sin SDK: se llama
la REST API de Upstash con `fetch`.

```
   Petición cualquiera a /api/chat* o /api/limits/usage
              │
              ▼
   ┌──────────────────────────────────┐
   │  getPlan(req)                    │
   │  req.user.plan si es válido      │
   │  si no: 'free' con sesión,       │
   │         'anon'  sin sesión       │
   └────────────────┬─────────────────┘
                    ▼
   ┌──────────────────────────────────┐
   │  getIdentifier(req)               │
   │  con sesión  → numination:usage: │
   │                <uuid del user>   │
   │  sin sesión  → numination:usage: │
   │                anon:<IP>         │
   └────────────────┬─────────────────┘
                    ▼
   ┌──────────────────────────────────┐
   │  verificarLimite(req)  ← LECTURA │
   │  (no incrementa)                  │
   │  GET /get/<key>                   │
   │  GET /get/<key>:min               │
   └────────────────┬─────────────────┘
                    ▼
              ¿permitido?
        │SÍ                │NO
        ▼                  ▼
   sigue normal      HTTP 429 {
                        error, razon,
                        retryAfter, plan,
                        uso, limites }
                    │
                    ▼
   ┌──────────────────────────────────┐
   │  registrarUso(req) ← ESCRITURA   │
   │  (solo si la IA respondió bien)  │
   │  INCRBY día +1                    │
   │  INCRBY minuto +1                 │
   │  EXPIRE ambos a medianoche / 60 s │
   └──────────────────────────────────┘
```

### Límites por plan

| Plan | Por día | Por minuto |
|------|---------|-----------|
| `anon` (sin sesión) | 10 | 3 |
| `free` (con sesión) | 50 | 5 |
| `pro-coder` | 200 | 15 |
| `pro-plus` | 500 | 30 |
| `pro-mad-max` | 2000 | 60 |

> **Pendiente:** `getPlan()` mira `req.user.plan`, pero `auth.js` todavía no
> mete el `plan` en el JWT. Hoy todos los usuarios con sesión caen en `free`
> automáticamente. Cuando se implemente el cobro, el código ya lo leerá solo.

### Detalle importante: cuándo se incrementa

`registrarUso()` se llama **después** de que la IA responde bien, no al
recibir el mensaje. Si el mensaje falla (error de red, motor caído), no cuenta.
Excepto en incógnito, que se registra igualmente para que el modo anónimo no
pueda usarse como refinado gratis.

---

## 6 · Estructura de tablas en Supabase

Se accede con `postgres.js` (SQL directo, puerto **6543** transaction pooler), no
con el cliente JS. `prepare: false` porque el pooler no soporta statements
preparados.

```
   ┌──────────────────────────────┐
   │      public.profiles         │  1 persona = 1 fila
   ├──────────────────────────────┤
   │ id          uuid  PK         │  crypto.randomUUID()
   │ email       text  UNIQUE     │  ← la clave real de identidad
   │ name        text             │
   │ picture     text             │  URL de la foto
   │ role        text  def 'student'
   │ provider    text             │  'google' | 'github'
   │ city        text  nullable   │
   │ grade       text  nullable   │
   │ last_login  timestamptz      │
   │ created_at  timestamptz      │
   └──────────────┬───────────────┘
                  │ 1
                  │
        ┌─────────┴──────────┐
        │ N                  │ N
   ┌────▼──────────────┐  ┌──▼────────────────┐
   │  public.chats     │  │ public.memories   │
   ├───────────────────┤  ├───────────────────┤
   │ id          uuid  │  │ id          uuid   │
   │ user_id     uuid  │  │ user_id     uuid   │
   │ title       text  │  │ text        text   │
   │ created_at  ts    │  │ created_at  ts     │
   │ updated_at  ts    │  └───────────────────┘
   └────┬──────────────┘
        │ 1
        │ N
   ┌────▼──────────────────┐
   │  public.messages      │
   ├───────────────────────┤
   │ id            uuid    │
   │ chat_id       uuid FK │
   │ role          text    │  'user' | 'assistant'
   │ content       text    │
   │ attachment    jsonb?  │  archivo adjunto
   │ image_url     text?   │  Pollinations
   │ provider      text?   │  qué motor respondió
   │ duration_ms   int     │
   │ created_at    ts      │
   └───────────────────────┘
```

**Sobre RLS:** el backend usa `SUPABASE_SERVICE_KEY` (prefijo `sb_secret_`), que
**evita** RLS por completo. Por eso los `INSERT` en `chats` / `messages` /
`memories` funcionan sin políticas. Si algún día se usara la `anon key`, todos
los inserts fallarían con `row-level security policy`.

---

## 7 · Tabla de endpoints

### Salud y límites

| Método | Ruta | Requiere sesión | Request | Response |
|--------|------|:---:|---------|----------|
| `GET` | `/api/health` | no | — | `{ ok, service, version, uptime, motors, modes, auth, limits, database, keys }` |
| `GET` | `/api/limits/usage` | no | — | `{ ok, plan, uso:{dia,minuto}, límites, restanteDia, restanteMin, renovacion }` |

### Auth

| Método | Ruta | Requiere sesión | Request | Response |
|--------|------|:---:|---------|----------|
| `POST` | `/api/auth/google` | no | `{ credential, remember? }` | `{ ok, user:{id,email,name,picture,role} }` |
| `GET` | `/api/auth/github` | no | — | `302` → `github.com/login/oauth/authorize` |
| `GET` | `/api/auth/github/callback` | no | — | `302` → `/chat.html` o `/login.html?error=…` |
| `GET` | `/api/auth/me` | no | — | `{ ok, user \| null }` |
| `GET` | `/api/auth/check` | no | — | `{ authenticated: bool }` |
| `POST` | `/api/auth/logout` | no | — | `{ ok: true }` |

### Chat

| Método | Ruta | Requiere sesión | Request | Response |
|--------|------|:---:|---------|----------|
| `POST` | `/api/chat/stream` | no (límite anon) | `{ message, role, file?, incognito? }` | **SSE** (ver abajo) |
| `POST` | `/api/chat` | no (límite anon) | igual | `{ ok, respuesta, provider, … }` (sin stream) |

**Eventos de `/api/chat/stream`** (`Content-Type: text/event-stream`):

```
data: {"meta":{"plan":"free","restanteDia":42,"restanteMin":4,"mode":"student","memories":2,"incognito":false,"requestId":"a1b2c3d4"}}
data: {"token":"Hol","done":false}
data: {"token":"a","done":false}
data: {"token":"","done":true,"provider":"groq"}
```

- `meta` — solo en el primer evento, si hay sesión
- `token` — trozo de texto. Concatenarlos da la respuesta completa
- `provider` — qué motor respondió (en el evento con `done: true`)
- `error` — `{ error, done: true }` si se agotaron los motores

### Chats

| Método | Ruta | Requiere sesión | Response |
|--------|------|:---:|----------|
| `GET` | `/api/chats` | **sí** | `{ ok, chats:[{id,title,created_at,updated_at}] }` |
| `GET` | `/api/chats/:id` | **sí** | `{ ok, chat, messages }` |
| `POST` | `/api/chats` | **sí** | `{ ok, chat }` |
| `POST` | `/api/chats/:id/messages` | **sí** | `{ ok, message }` |
| `DELETE` | `/api/chats/:id` | **sí** | `{ ok }` |
| `DELETE` | `/api/chats` | **sí** | `{ ok }` (borra todos) |

### Memorias

| Método | Ruta | Requiere sesión | Request | Response |
|--------|------|:---:|---------|----------|
| `GET` | `/api/memories` | **sí** | — | `{ ok, memories:[{id,text,created_at}] }` |
| `POST` | `/api/memories` | **sí** | `{ text }` | `{ ok, memory }` |
| `DELETE` | `/api/memories/:id` | **sí** | — | `{ ok }` |

### Errores comunes

| Código | Significado |
|--------|-------------|
| `400` | JSON mal formado, o falta `message`/`file` |
| `401` | Ruta protegida sin sesión |
| `404` | Endpoint o archivo inexistente |
| `429` | Límite de uso excedido (mira `retryAfter`) |
| `500` | Error interno no manejado |
| `503` | Los 3 motores de IA están saturados |

---

## 8 · Variables de entorno en Vercel

Todas se leen como `process.env.X`, con fallback a `env.local.js` en local.

### Obligatorias (si faltan, la función correspondente se apaga)

| Variable | Para qué | Dónde sacarla |
|----------|----------|---------------|
| `SUPABASE_URL` | URL del proyecto Supabase | Supabase → Project Settings → API |
| `SUPABASE_SERVICE_KEY` | Service key (`sb_secret_…`). **NO la anon key** | Supabase → Project Settings → API |
| `DATABASE_URL` | Postgres puerto **6543** (transaction pooler) | Supabase → Project Settings → Database |
| `JWT_SECRET` | Firma las sesiones. Cambiarlo cierra todas las sesiones | `openssl rand -hex 32` |
| `GOOGLE_CLIENT_ID` | Login con Google (GSI) | Google Cloud Console → Credentials |
| `GOOGLE_CLIENT_SECRET` | Verificación del idToken de Google | Google Cloud Console → Credentials |
| `GITHUB_CLIENT_ID` | Login con GitHub | GitHub → Settings → Developer → OAuth Apps |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth App | GitHub → Settings → Developer → OAuth Apps |
| `UPSTASH_REDIS_REST_URL` | Contadores de uso | Upstash → Database → REST |
| `UPSTASH_REDIS_REST_TOKEN` | Autenticación en Upstash | Upstash → Database → REST |
| `GROQ_API_KEY` | Motor 1 (texto) | console.groq.com |
| `GEMINI_API_KEY` | Motor 2 (clave 1 de 3) | aistudio.google.com |
| `GEMINI_API_KEY_2` | Motor 2 (clave 2 de 3) | aistudio.google.com |
| `GEMINI_API_KEY_3` | Motor 2 (clave 3 de 3) | aistudio.google.com |
| `NVIDIA_API_KEY` | Motor 3 (Kimi K3) | build.nvidia.com |

### Opcionales

| Variable | Default | Para qué |
|----------|---------|----------|
| `NODE_ENV` | — | `production` activa cache 1h y cookie `secure` |
| `PORT` | `8080` | Puerto local |
| `DEBUG` | — | `1` enciende los `LOG.debug` |

> **Las 3 keys de Gemini son opcionales en la práctica:** si no hay ninguna, el
> motor se salta solo y la cascada sigue con Kimi. Pero con una sola key se
> pierde la rotación y la cascada se debilita mucho en hora pico.

---

## 9 · Deploy

```
   GitHub (main)
       │  push
       ▼
   Vercel ──detecta──► package.json (type: module)
       │               vercel.json: functions api/index.js, includeFiles src/**
       │               rewrites: /(.*) → /api/index.js
       ▼
   api/index.js  ──export default──►  src/index.js
       │
       ├── src/**          (incluido por includeFiles)
       ├── public/**       (servido como estático por Vercel)
       └── process.env.*   (del project de Vercel)
```

**`includeFiles: "src/**"` es obligatorio.** Sin él, Vercel solo sube `api/` y el
import de `../src/index.js` falla en producción.

**`maxDuration: 300`** porque el streaming de IA puede tardar. **`memory: 1024`**
porque el SDK de Gemini es pesado.

### Comandos útiles

```bash
vercel link                        # conectar la carpeta al proyecto (1 sola vez)
vercel env pull .env.check --environment production
vercel logs --environment production --follow --expand
vercel dev                         # probar en local con las env de Vercel
```

### Checklist antes de deployar

- [ ] `git status --short` limpio
- [ ] `node --check src/index.js` y de los demás `.js` de `src/`
- [ ] `npm start` levanta y `/api/health` responde `ok: true`
- [ ] `database.supabase: true` en el health
- [ ] La lista de `motors` y `keys` del health trae todo en `true`
- [ ] `vercel env pull` y comparar contra la sección 8 de este documento

---

## 10 · Enlaces

**Proyecto**
- Producción: <https://numinationchat.vercel.app>
- Supabase: <https://supabase.com/dashboard>
- Vercel: <https://vercel.com/dashboard>
- Upstash: <https://console.upstash.com>

**OAuth**
- Google Cloud Console (credenciales): <https://console.cloud.google.com/apis/credentials>
- GitHub OAuth Apps: <https://github.com/settings/developers>
- Passport GitHub: <https://www.passportjs.org/strategies/github/>

**IA**
- Groq: <https://console.groq.com/keys>
- Google AI Studio (Gemini): <https://aistudio.google.com/app/apikey>
- NVIDIA Build (Kimi K3): <https://build.nvidia.com>
- Modelos de Gemini: <https://ai.google.dev/gemini-api/docs/models>

**Librerías**
- Express 5: <https://expressjs.com>
- `postgres.js`: <https://github.com/postgres/postgres.js>
- Upstash Redis: <https://upstash.com/docs/redis/overall/getstarted>
- `passport-github`: <https://github.com/jaredly/github-strategy>

---

## 11 · Notas de mantenimiento

### Decisiones que parece que están mal pero son intencionales

- **`nvidia` es Kimi K3, no un modelo de NVIDIA.** Se llama así por el endpoint.
- **Gemini gasta tokens "pensando" por defecto**, aunque no pidas razonamiento
  (unos 220 tokens para `12×12`). No es un bug, pero encarece.
- **El incógnito no guarda nada**, ni chats ni memorias, pero **sí consume cuota
  anónimo**. A propósito: si no, sería un límite gratis.
- **`state: false` en Passport GitHub.** El server es stateless; la CSRF la
  cubre la cookie `httpOnly` + `sameSite=lax`.

### Bugs ya arreglados (no reintroducirlos)

- **El catch-all devolvía `index.html` con 200 para cualquier archivo faltante.**
  Un `<script src>` mal escrito producía `Uncaught SyntaxError: Unexpected token
  '<'` en vez de un 404 claro. Ahora, si la ruta tiene extensión, es 404.
  (`src/index.js`, final del archivo)
- **JSON mal formado devolvía 500.** Ahora es 400, y la culpa se le echa al
  cliente que lo mandó. Si revisas el log y ves `Error no manejado: Expected
  property name or '}'`, ya sabes que alguien mandó JSON roto.
- **GitHub con email privado creaba cuentas duplicadas.** Ahora consulta
  `api.github.com/user/emails`. (`src/auth.js`, `resolverEmailGitHub()`)

### Pendientes conocidos

- **`favicon.ico` no existe.** Las 6 páginas lo referencian. El navegador usa
  un icono por defecto y no se rompe nada, pero se puede crear.
- **`getPlan()` todavía no lee el plan real.** Todo usuario con sesión es
  `free`. Falta meter `plan` en el JWT al hacer el cobro.
- **Los counters de uso no se limpian** si Upstash se cae: `verificarLimite`
  avisa por consola y deja pasar (fail-open, a propósito).
- **`main.css` y `main.js` aún** mencionan `chat.css v6` en un comentario de
  cabecera, pero ese archivo se borró por estar muerto. Solo es texto.
