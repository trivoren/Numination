# Numination

**La IA que habla el idioma de nuestra educación.**

Numination es una plataforma de IA para programadores y estudiantes de código. Escribís código, lo depurás, lo explicás, lo refactorizás. Simple: entrás y chateás.

---

## Qué es

Numination es un chat con IA enfocado en código. No es una IA genérica. No es un tutor de colegio. Es un asistente que entiende de programación y te ayuda a escribir, depurar, entender y mejorar código.

Modelo: Numi-OT.01
Fundadores: Álvaro García Gómez & Robinson Rodríguez Gómez
País: Colombia

---

## Features

- Chat con IA: conversación en streaming, token por token
- 3 modos: Chat general, Coder (código), Razonamiento (paso a paso)
- Modo incógnito: conversaciones que no se guardan ni aparecen en el historial
- Memorias: la IA recuerda lo que le contás para ayudarte mejor
- Multi-motor: Groq → Gemini → Kimi con fallback automático
- Google + GitHub: login OAuth, sin contraseñas
- Email + password: alternativa si no querés usar OAuth
- 13 conectores: Wikipedia, NASA, Open Trivia, Colombia, etc.
- 150+ skills: habilidades específicas por categoría

---

## Stack

Backend:
- Node.js 20+ (ESM)
- Express
- Postgres (Supabase)
- JWT en cookies httpOnly
- SSE para streaming

IA:
- Groq (motor principal)
- Google Gemini (motor secundario, 3 keys rotando)
- NVIDIA NIM / Kimi K3 (respaldo)

Frontend:
- HTML, CSS, JavaScript vanilla
- Sin frameworks
- Sin build step

Deploy:
- Vercel (serverless)

---

## Instalación

Requisitos:
- Node.js 20 o superior
- Cuenta de Supabase (gratis)
- Cuenta de Google Cloud (para OAuth)
- Cuenta de GitHub (para OAuth)
- Cuenta de Groq (gratis)

Pasos:

    git clone https://github.com/tu-usuario/numination.git
    cd numination
    npm install
    cp .env.example env.local.js
    npm run dev

Abrí http://localhost:8080

---

## Estructura

    numination/
    ├── src/
    │   ├── index.js           servidor Express + rutas core
    │   ├── auth.js            login, signup, JWT, OAuth
    │   ├── chats.js           CRUD chats + streaming SSE
    │   ├── memories.js        memorias con tags y búsqueda
    │   ├── skills.js          endpoint de skills
    │   ├── connectors.js      13 conectores a APIs externas
    │   ├── email.js           envío de correos (Brevo)
    │   └── services/
    │       ├── supabase.js    cliente de Postgres + helpers
    │       ├── streaming.js   adaptadores de streaming para cada IA
    │       └── limits.js      cuotas por plan
    │
    ├── public/
    │   ├── login.html         entrada (Google, GitHub, email)
    │   ├── chat.html          la app
    │   ├── verify-email.html  verificación de correo
    │   ├── reset-password.html recuperar contraseña
    │   ├── 404.html           página no encontrada
    │   ├── terminos.html      términos y condiciones
    │   ├── privacidad.html    política de privacidad
    │   └── assets/
    │       └── js/
    │           └── skills.js  biblioteca de 150+ skills
    │
    ├── env.local.js           variables (NO subir a git)
    ├── .env.example           plantilla de variables
    ├── package.json
    └── README.md

---

## Variables de entorno

Copiá .env.example a env.local.js y rellená:

    export const TEST_KEYS = {
      DATABASE_URL: 'postgresql://...',
      JWT_SECRET: 'clave-aleatoria-de-64-caracteres',
      GOOGLE_CLIENT_ID: '...',
      GOOGLE_CLIENT_SECRET: '...',
      GITHUB_CLIENT_ID: '...',
      GITHUB_CLIENT_SECRET: '...',
      GROQ_API_KEY: 'gsk_...',
      GEMINI_API_KEY: 'AIza...',
      GEMINI_API_KEY_2: 'AIza...',
      GEMINI_API_KEY_3: 'AIza...',
      NVIDIA_API_KEY: 'nvapi-...',
      BREVO_SMTP_USER: 'xsmtpsib-...',
      BREVO_SMTP_PASSWORD: 'xsmtpsib-...',
      BREVO_FROM_EMAIL: 'no-reply@numination.app',
      BREVO_FROM_NAME: 'Numination',
    };

---

## Comandos

    npm run dev      Desarrollo con auto-reload
    npm start        Producción
    npm test         Tests (próximamente)

---

## API

Todos los endpoints empiezan con /api/

Autenticación:
    POST    /api/auth/signup              Crear cuenta email + password
    POST    /api/auth/login               Iniciar sesión
    POST    /api/auth/logout              Cerrar sesión
    POST    /api/auth/google              Login con Google (GIS)
    GET     /api/auth/github              Iniciar OAuth GitHub
    GET     /api/auth/me                  Usuario actual
    GET     /api/auth/session             Info de la sesión
    POST    /api/auth/forgot-password     Pedir reset
    POST    /api/auth/reset-password      Aplicar reset
    PATCH   /api/auth/profile             Editar perfil
    DELETE  /api/auth/account             Eliminar cuenta

Chat:
    GET     /api/chats                    Listar conversaciones
    POST    /api/chats                    Crear conversación
    GET     /api/chats/:id                Obtener una con mensajes
    PATCH   /api/chats/:id                Renombrar
    DELETE  /api/chats/:id                Eliminar
    POST    /api/chat/stream              Streaming SSE con IA
    POST    /api/chat                     Chat sin streaming

Memorias:
    GET     /api/memories                 Listar con filtros
    POST    /api/memories                 Crear
    PATCH   /api/memories/:id             Editar
    DELETE  /api/memories/:id             Eliminar
    GET     /api/memories/stats           Estadísticas

Otros:
    GET     /api/skills                   Lista de skills
    GET     /api/connectors               Lista de conectores
    POST    /api/connectors/:id/query     Ejecutar conector
    GET     /api/limits/usage             Cuota del plan
    GET     /api/health                   Estado del server

---

## Modos de la IA

Chat (role: 'student')
Conversación general. Explica conceptos, resuelve dudas, sugiere caminos.

Coder (role: 'teacher')
Especializado en programación. Escribe, depura, explica y refactoriza código. Sabe JavaScript, TypeScript, Python, React, Node, SQL y más.

Razonamiento (role: 'reasoning')
Piensa paso a paso antes de responder. El proceso interno va dentro de etiquetas thinking y después viene la respuesta final limpia.

---

## Motores de IA

Numination usa 3 motores con fallback automático:

    Texto     → Groq → Gemini → Kimi
    Archivos  → Gemini → Kimi → Groq

Si uno falla, pasa al siguiente. El usuario nunca ve el drama. Si los tres fallan, se devuelve un error legible.

Configuración en src/index.js:
- Groq: modelo openai/gpt-oss-120b
- Gemini: gemini-3.6-flash con 3 keys rotando
- NVIDIA NIM: moonshotai/kimi-k3

---

## Deploy

Vercel:

    npm i -g vercel
    vercel login
    vercel --prod

Variables de entorno en Vercel: Settings → Environment Variables. Copiá todas las de env.local.js

---

## Seguridad

- Contraseñas con scrypt (64-byte key, 16-byte salt)
- Cookies httpOnly + SameSite=Lax + Secure en producción
- JWT firmados con expiración de 30 días
- Rate limiting por IP y por email
- Bloqueo de cuenta tras 5 intentos fallidos
- Verificación de email
- Prompt injection guard
- CORS restringido a dominios propios

Si encontrás una vulnerabilidad, escribí a seguridad@numination.app (no abras un issue público).

---

## Licencia

Todos los derechos reservados. Numination es propiedad de sus fundadores.

El código fuente no es de código abierto. Si querés colaborar, escribinos.

---

## Contacto

Soporte: soporte@numination.app
Privacidad: privacidad@numination.app
Seguridad: seguridad@numination.app

---

## Estado del proyecto

    Backend completo         7 módulos, 73+ endpoints
    Frontend de auth         login, verify, reset
    Frontend de chat         chat.html con streaming
    Frontend legal           404, términos, privacidad
    Deploy                   configurado en Vercel

Hecho con amor en Colombia|Barranquilla · 2026