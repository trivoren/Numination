```markdown
<div align="center">

# 🇨🇴 Numination

### La IA que habla el idioma de nuestra educación

**La primera inteligencia artificial educativa 100% colombiana.**

[![Estado](https://img.shields.io/badge/estado-activo-success?style=for-the-badge)](#)
[![Versión](https://img.shields.io/badge/versión-1.0.0-blue?style=for-the-badge)](#)
[![Licencia](https://img.shields.io/badge/licencia-MIT-yellow?style=for-the-badge)](#-licencia)
[![Hecho en](https://img.shields.io/badge/hecho%20en-Colombia-FCD116?style=for-the-badge)](#)

[Descripción](#-sobre-numination) ·
[Características](#-características) ·
[Instalación](#-instalación) ·
[Uso](#-guía-de-uso) ·
[API](#-referencia-de-la-api) ·
[Deploy](#-guía-de-deploy) ·
[FAQ](#-preguntas-frecuentes)

</div>

---

## 📖 Tabla de contenidos

- [Sobre Numination](#-sobre-numination)
- [Características](#-características)
- [Demo en vivo](#-demo-en-vivo)
- [Capturas de pantalla](#-capturas-de-pantalla)
- [Stack tecnológico](#-stack-tecnológico)
- [Arquitectura](#-arquitectura)
- [Requisitos](#-requisitos)
- [Instalación](#-instalación)
- [Configuración](#-configuración)
- [Guía de uso](#-guía-de-uso)
- [Referencia de la API](#-referencia-de-la-api)
- [Guía de deploy](#-guía-de-deploy)
- [Solución de problemas](#-solución-de-problemas)
- [Preguntas frecuentes](#-preguntas-frecuentes)
- [Roadmap](#-roadmap)
- [Cómo contribuir](#-cómo-contribuir)
- [Autores](#-autores)
- [Licencia](#-licencia)

---

## 🇨🇴 Sobre Numination

### ¿Qué es?

**Numination** es una inteligencia artificial educativa diseñada específicamente para el contexto colombiano. No es una adaptación de un modelo extranjero: es un asistente pedagógico pensado desde cero para las necesidades reales de **estudiantes** y **profesores** de Colombia.

Funciona con dos motores de IA en paralelo (Google Gemini y Mistral AI) y aplica un **system prompt especializado** que conoce:

- Los **DBA** (Derechos Básicos de Aprendizaje)
- Los **EBC** (Estándares Básicos de Competencias) del MEN
- Las **pruebas Saber** (3°, 5°, 9°, 11°) y el formato ICFES
- El **PTA** (Programa Todos a Aprender)
- **Escuela Nueva** y aulas multigrado
- El **PEI** de las instituciones educativas

Y todo contextualizado con ejemplos auténticos: el café del Eje Cafetero, el río Magdalena, la cumbia, el vallenato, García Márquez, la Batalla de Boyacá, Nairo Quintana, y un largo etcétera.

### ¿Por qué existe?

En Colombia, la calidad educativa depende demasiado del **código postal** del estudiante. Un niño en Bogotá puede tener un tutor personal; un niño en Quibdó o en zona rural dispersa, muchas veces no.

Numination busca cerrar esa brecha:

> **Un tutor personal 24/7, gratis, con paciencia infinita, que habla colombiano.**

Y para los profesores:

> **Un asistente que les devuelva el tiempo para lo que realmente importa: acompañar a sus estudiantes.**

### Misión

Democratizar el acceso a una tutoría educativa de calidad en Colombia, eliminando las barreras geográficas, económicas y de horario.

### Visión

Que en 2030, cualquier estudiante colombiano —sin importar dónde viva— tenga acceso a un tutor personalizado con IA que le explique con paciencia, con ejemplos de su región, y en su idioma.

---

## ✨ Características

### Para estudiantes

- 🎓 **Tutoría paso a paso**: explica cualquier tema desde cero, con analogías cotidianas.
- 📚 **Preparación Saber 11**: simulacros con formato ICFES, análisis de errores y plan de estudio.
- 🧠 **Técnicas de estudio**: Pomodoro, Feynman, repetición espaciada, mapas mentales.
- 💪 **Apoyo motivacional**: reconoce frustración, celebra logros, fomenta mentalidad de crecimiento.
- 🌱 **Aprendizaje honesto**: **nunca** hace la tarea por el estudiante. Lo guía para que la haga él.
- 📱 **Accesible**: funciona desde el celular, sin apps que descargar.

### Para profesores

- 📝 **Planes de clase**: estructurados con inicio, desarrollo, cierre, alineados con DBA.
- ✅ **Evaluaciones tipo Saber**: preguntas ICFES, rúbricas y análisis por competencia.
- 🎯 **Adaptaciones DUA**: versiones diferenciadas por ritmo, estilo y necesidad.
- 📊 **Rúbricas**: criterios claros, niveles Superior / Alto / Básico / Bajo.
- 💬 **Retroalimentación asistida**: comentarios empáticos y constructivos.
- 🏫 **Material para Escuela Nueva** y aulas multigrado.

### Características técnicas

- 🤖 **Doble motor IA**: Gemini para razonamiento profundo, Mistral para tareas rápidas.
- 🔄 **Fallback automático**: si un motor falla, el otro responde sin que el usuario lo note.
- 🎨 **Interfaz bilingüe visual**: modo claro/oscuro, responsive, mobile-first.
- 💾 **Historial persistente**: las conversaciones se guardan en `localStorage`.
- ⌨️ **Atajos de teclado**: `Ctrl + K` nueva conversación, `Ctrl + Shift + L` modo oscuro.
- 🔒 **API keys protegidas**: nunca se suben al repositorio.
- 📡 **API REST limpia**: un solo endpoint, fácil de consumir desde cualquier cliente.
- 🚀 **Deploy en minutos**: compatible con Railway, Render y Fly.io.

---

## 🎬 Demo en vivo

> **URL de producción:** _(pendiente — pendiente de deploy)_
>
> **Video demo:** _(pendiente — próximamente en YouTube)_

Mientras tanto, puedes correrlo localmente siguiendo la [guía de instalación](#-instalación).

---

## 📸 Capturas de pantalla

### Landing principal

```
┌────────────────────────────────────────────────────────────┐
│  🇨🇴 Numination                        Probar   Comenzar  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│            La IA que habla el idioma de                    │
│                nuestra educación                           │
│                                                            │
│   Numination es la primera inteligencia artificial        │
│   educativa 100% colombiana. Tutor personal 24/7.         │
│                                                            │
│      [ Comenzar gratis → ]   [ Ver características ]      │
│                                                            │
│   1100        24         2         100                    │
│  Municipios  Horas   Motores   % colombiano               │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

### Chat con estudiante

```
┌──────────┬─────────────────────────────────────────────────┐
│ + Nueva  │  🎓 Estudiante   👨‍🏫 Profesor    ✨ Gemini  🌙 │
├──────────┼─────────────────────────────────────────────────┤
│ Recientes│                                                 │
│          │  Yo: Explícame la fotosíntesis con un          │
│ • Hola   │      ejemplo del café colombiano               │
│ • Plan   │                                                 │
│          │  🇨🇴 Numination · 08:16 a.m. · gemini         │
│          │  ¡Claro! Piensa en un cafetal del Eje          │
│          │  Cafetero ☕. Las hojas del cafeto toman       │
│          │  luz del sol, agua y CO₂ para producir su      │
│          │  alimento y liberar oxígeno.                    │
│          │                                                 │
│ Ajustes  │  [ Escribe tu pregunta... ]              [➤]   │
└──────────┴─────────────────────────────────────────────────┘
```

---

## 🛠 Stack tecnológico

### Backend

| Tecnología | Versión | Uso |
|---|---|---|
| **Node.js** | ≥ 20 | Runtime del servidor |
| **Express** | ^4.21 | Framework HTTP |
| **@google/genai** | ^0.21 | SDK de Google Gemini |
| **@mistralai/mistralai** | ^1.3 | SDK de Mistral AI |
| **dotenv** | ^16.4 | Carga de variables (opcional) |

### Frontend

| Tecnología | Uso |
|---|---|
| **HTML5** | Estructura semántica |
| **CSS3** | Estilos modernos (Grid, Flex, variables CSS) |
| **JavaScript ES2022** | Lógica del cliente, sin frameworks |
| **Web Speech API** | TTS + STT nativo del navegador |

### IA

| Proveedor | Modelo | Uso principal |
|---|---|---|
| **Google Gemini** | `gemini-3.6-flash` | Razonamiento pedagógico profundo |
| **Mistral AI** | `mistral-small-latest` | Tareas rápidas, resúmenes, rúbricas |

### Infraestructura

- **Git + GitHub** para control de versiones
- **Railway / Render / Fly.io** para deploy (pendiente)
- **Firebase** para autenticación (roadmap)

---

## 🏗 Arquitectura

### Diagrama de flujo

```
┌─────────────────────────────────────────────────────────────┐
│                     NAVEGADOR DEL USUARIO                    │
│                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐ │
│  │   Landing      │  │   Chat UI      │  │  localStorage  │ │
│  │  (index.html)  │  │   (app.js)     │  │  (historial)   │ │
│  └────────────────┘  └────────────────┘  └────────────────┘ │
│           │                  │                              │
│           └──────────────────┴──────────────────────────────┤
│                              │                              │
│                              ▼                              │
│                     fetch('/api/chat')                      │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              │ HTTP POST (JSON)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  SERVIDOR EXPRESS (Node.js)                 │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │              src/index.js                              │ │
│  │                                                        │ │
│  │  1. Recibe { message, provider, role }                 │ │
│  │  2. Construye el system prompt según el rol            │ │
│  │  3. Intenta con el proveedor elegido                   │ │
│  │  4. Si falla, fallback al otro proveedor               │ │
│  │  5. Devuelve { reply, provider }                       │ │
│  └────────────────────────────────────────────────────────┘ │
│           │                                    │            │
│           ▼                                    ▼            │
│  ┌──────────────────┐                 ┌──────────────────┐  │
│  │  Google Gemini   │                 │   Mistral AI     │  │
│  │  (3.6-flash)     │                 │  (small-latest)  │  │
│  └──────────────────┘                 └──────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Estructura de archivos

```
numination ai web/
├── public/                     # Frontend estático
│   ├── index.html              # Estructura de la app
│   ├── styles.css              # Estilos completos
│   └── app.js                  # Lógica del cliente
│
├── src/                        # Backend
│   └── index.js                # Servidor Express + IA + prompt
│
├── .env.example                # Ejemplo de variables (plantilla)
├── .gitignore                  # Archivos que NO se suben
├── env.local.js                # 🔴 API keys (NO subir)
├── package.json                # Dependencias y scripts
└── README.md                   # Este archivo
```

---

## 📋 Requisitos

Antes de empezar, asegúrate de tener:

- ✅ **Node.js** versión 20 o superior ([descargar](https://nodejs.org))
- ✅ **npm** (viene incluido con Node.js)
- ✅ **Git** ([descargar](https://git-scm.com))
- ✅ Una **cuenta de Google** (para Gemini)
- ✅ Una **cuenta de Mistral** (para Mistral)
- ✅ Un **editor de código** (recomendado: [VS Code](https://code.visualstudio.com))

### Verificar versiones

```bash
node --version    # Debe decir v20.x.x o superior
npm --version     # Debe decir 10.x.x o superior
git --version     # Debe decir 2.x.x o superior
```

Si alguno no funciona, instálalo antes de seguir.

---

## 🚀 Instalación

### Paso 1: Clonar el repositorio

```bash
git clone https://github.com/trivoren/Numination.git
cd Numination
```

O si ya tienes los archivos localmente:

```bash
cd "numination ai web"
```

### Paso 2: Instalar dependencias

```bash
npm install
```

Debe instalar ~70 paquetes. Espera a que termine.

### Paso 3: Obtener las API keys

#### 3.1 — Google Gemini

1. Ve a [aistudio.google.com/apikey](https://aistudio.google.com/apikey)
2. Inicia sesión con tu cuenta de Google
3. Clic en **Create API key**
4. Copia la key (empieza con `AIza...`)

#### 3.2 — Mistral AI

1. Ve a [console.mistral.ai](https://console.mistral.ai)
2. Crea una cuenta gratuita
3. Ve a **API Keys** → **Create new key**
4. Copia la key

### Paso 4: Configurar las keys

Crea un archivo llamado `env.local.js` en la raíz del proyecto:

```javascript
// env.local.js
// ⚠️ Este archivo NO se sube a Git (está en .gitignore)

export const TEST_KEYS = {
  GEMINI_API_KEY: 'AIzaSy...tu_key_de_gemini...',
  MISTRAL_API_KEY: 'tu_key_de_mistral...',
};
```

> 🔴 **NUNCA subas este archivo a GitHub.**

### Paso 5: Correr el proyecto

```bash
npm run dev
```

Debe mostrar:

```
🇨🇴 Numination escuchando en http://localhost:8080
```

Abre tu navegador en:

```
http://localhost:8080
```

¡Listo! Numination está corriendo. 🎉

---

## ⚙ Configuración

### Variables de entorno

| Variable | Descripción | Dónde conseguirla |
|---|---|---|
| `GEMINI_API_KEY` | API key de Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `MISTRAL_API_KEY` | API key de Mistral AI | [console.mistral.ai](https://console.mistral.ai) |
| `PORT` | Puerto del servidor (default `8080`) | Opcional |

En **desarrollo** las keys se leen de `env.local.js`.

En **producción** (Railway, Render, etc.) se leen de las variables de entorno del servidor.

### Prompt del sistema

El prompt está en `src/index.js`, en las constantes:

- `NUMINATION_BASE` — Prompt principal (identidad, contexto, reglas)
- `ROLE_HINT_TEACHER` — Instrucciones extra para modo profesor
- `ROLE_HINT_STUDENT` — Instrucciones extra para modo estudiante

La función `buildSystemPrompt(role)` combina `NUMINATION_BASE` con el hint correcto según el rol activo.

---

## 📘 Guía de uso

### Interfaz web

Al abrir `http://localhost:8080` verás:

1. **Landing** con hero, características, roles, impacto y about.
2. **Botones de acceso**: "Probar", "Comenzar", "Comenzar gratis".
3. **Chat** con sidebar de historial, tabs de rol y proveedor.

### Modo estudiante

1. Clic en el tab **🎓 Estudiante**
2. Aparecen sugerencias tipo:
   - "Explícame la fotosíntesis con un ejemplo del café"
   - "Ayúdame con el Saber 11 de matemáticas"
3. Escribe tu pregunta o pulsa una sugerencia
4. Numination responde con:
   - Explicación paso a paso
   - Ejemplos colombianos
   - Pregunta de verificación al final

### Modo profesor

1. Clic en el tab **👨‍🏫 Profesor**
2. Prueba con:
   - "Plan de clase sobre el Río Magdalena para 5°"
   - "Rúbrica para evaluar una exposición oral"
3. Numination responde con:
   - Estructura completa (inicio / desarrollo / cierre)
   - Alineación con DBA y EBC
   - Adaptaciones DUA

### Cambiar de motor IA

En la esquina superior derecha del chat:

- **✨ Gemini** → razonamiento profundo, respuestas más largas
- **🌪️ Mistral** → respuestas rápidas, menor costo

> Si un motor falla, el sistema usa automáticamente el otro.

### Atajos de teclado

| Atajo | Acción |
|---|---|
| `Enter` | Enviar mensaje |
| `Shift + Enter` | Salto de línea sin enviar |
| `Ctrl + K` | Nueva conversación |
| `Ctrl + Shift + L` | Alternar modo claro/oscuro |
| `Esc` | Cerrar modales o sidebar |

---

## 🔌 Referencia de la API

### `GET /api/health`

Verifica que el servidor esté activo.

**Respuesta:**
```json
{
  "ok": true,
  "service": "numination"
}
```

### `POST /api/chat`

Envía un mensaje y recibe una respuesta.

**Body:**
```json
{
  "message": "Explícame la fotosíntesis",
  "provider": "gemini",
  "role": "student"
}
```

**Parámetros:**

| Campo | Tipo | Requerido | Valores válidos |
|---|---|---|---|
| `message` | string | ✅ | 1-4000 caracteres |
| `provider` | string | ❌ | `"gemini"` (default) o `"mistral"` |
| `role` | string | ❌ | `"student"` (default) o `"teacher"` |

**Respuesta exitosa (200):**
```json
{
  "reply": "¡Claro! Piensa en un cafetal del Eje Cafetero...",
  "provider": "gemini"
}
```

**Respuesta de error (4xx/5xx):**
```json
{
  "error": "Descripción del error"
}
```

**Ejemplo con cURL:**
```bash
curl -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Hola","provider":"gemini","role":"student"}'
```

**Ejemplo con PowerShell:**
```powershell
$body = @{
  message = "Hola"
  provider = "gemini"
  role = "student"
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:8080/api/chat" `
  -Method Post -Body $body -ContentType "application/json"
```

---

## 🚢 Guía de deploy

### Railway (recomendado)

1. Crea cuenta en [railway.app](https://railway.app) con GitHub
2. **New Project** → **Deploy from GitHub repo**
3. Selecciona `trivoren/Numination`
4. Railway detecta Node.js automáticamente
5. Ve a **Variables** y agrega:
   - `GEMINI_API_KEY` = tu key
   - `MISTRAL_API_KEY` = tu key
6. **Deploy** → espera 2 minutos
7. Obtienes una URL tipo `numination-production.up.railway.app`

### Render

1. Crea cuenta en [render.com](https://render.com)
2. **New Web Service** → conecta tu repo
3. Configura:
   - **Build Command:** `npm install`
   - **Start Command:** `node src/index.js`
4. Agrega las variables de entorno
5. Deploy

### Fly.io

```bash
fly launch
fly secrets set GEMINI_API_KEY=tu_key
fly secrets set MISTRAL_API_KEY=tu_key
fly deploy
```

---

## 🔧 Solución de problemas

### El servidor no arranca

**Error:** `Error: listen EADDRINUSE :::8080`

**Solución:**
```powershell
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 2
npm run dev
```

### "Failed to fetch" en el chat

**Causa:** el servidor backend no está corriendo.

**Solución:** verifica que la terminal con `npm run dev` siga abierta y muestre `🇨🇴 Numination escuchando en...`.

### Error 503 de Gemini

**Causa:** Google está saturado.

**Solución:** el sistema cambia automáticamente a Mistral. Si ambos fallan, espera 30 segundos e intenta de nuevo.

### Error 429 de Mistral

**Causa:** superaste el límite gratuito (1 petición/segundo).

**Solución:** espera unos segundos entre mensajes.

### `Cannot find module '@google/genai'`

**Solución:**
```bash
npm install
```

### Pantalla en blanco

**Solución:**
1. Abre DevTools (`F12`) → Console
2. Recarga con `Ctrl + Shift + R`
3. Busca errores rojos
4. Verifica que `public/styles.css` y `public/app.js` no estén vacíos

### Los estilos no cargan

**Causa:** caché del navegador.

**Solución:** `Ctrl + Shift + R` (recarga forzada).

---

## ❓ Preguntas frecuentes

### ¿Numination es gratis?

Sí, es gratis para estudiantes. El proyecto usa las cuotas gratuitas de Gemini y Mistral.

### ¿Reemplaza a los profesores?

**No.** Numination es una herramienta de apoyo. Los profesores son irremplazables.

### ¿Hace las tareas por los estudiantes?

**No.** Por diseño, Numination **guía** al estudiante para que llegue a la respuesta por sí mismo.

### ¿Qué pasa con mis datos?

Las conversaciones se guardan **en tu navegador** (`localStorage`). No hay cuentas, no hay tracking, no hay publicidad.

### ¿Puedo usarlo sin internet?

No. Necesita conectarse a las APIs de IA que requieren internet.

### ¿Funciona en celular?

Sí. La interfaz es responsive.

### ¿Cómo reporto un bug?

Abre un issue en [github.com/trivoren/Numination/issues](https://github.com/trivoren/Numination/issues).

### ¿Puedo contribuir?

¡Claro! Lee la sección de [contribución](#-cómo-contribuir).

### ¿Cómo consigo una API key de Gemini?

Ve a [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

### ¿Cómo consigo una API key de Mistral?

Ve a [console.mistral.ai](https://console.mistral.ai).

### ¿Las conversaciones se pierden al cerrar el navegador?

No. Se guardan en `localStorage`.

### ¿Puedo cambiar el prompt?

Sí. Está en `src/index.js`, en `NUMINATION_BASE`.

---

## 🗺 Roadmap

### v1.0 — Actual ✅

- [x] Backend Express
- [x] Frontend con landing + chat
- [x] Integración Gemini
- [x] Integración Mistral
- [x] Fallback automático
- [x] Prompt colombiano contextualizado
- [x] Modo estudiante / profesor
- [x] Historial en localStorage
- [x] Modo oscuro

### v1.1 — Próximo

- [ ] Deploy a Railway con URL pública
- [ ] README completo
- [ ] Logo y favicon

### v1.2 — Audio

- [ ] Text-to-Speech (Web Speech API)
- [ ] Speech-to-Text (dictado por voz)
- [ ] Botón 🔊 en cada respuesta

### v1.3 — Cuentas y persistencia

- [ ] Login con Firebase Auth
- [ ] Historial en Firestore
- [ ] Sincronización entre dispositivos

### v1.4 — Streaming

- [ ] Respuestas palabra por palabra (SSE)
- [ ] Cancelar respuesta en curso

### v1.5 — Features educativas

- [ ] Generador de simulacros Saber 11
- [ ] Plantillas de plan de clase
- [ ] Rúbricas exportables a PDF

### v2.0 — Comunidad

- [ ] Panel para profesores con estadísticas
- [ ] Biblioteca de materiales compartidos
- [ ] App móvil nativa

---

## 🤝 Cómo contribuir

1. **Fork** el repositorio
2. **Clone** tu fork: `git clone https://github.com/tu-usuario/Numination.git`
3. **Crea una rama**: `git checkout -b feature/nueva-funcionalidad`
4. **Haz tus cambios**
5. **Commit**: `git commit -m "feat: agrega nueva funcionalidad"`
6. **Push**: `git push origin feature/nueva-funcionalidad`
7. **Abre un Pull Request**

### Estilo de commits

- `feat:` nueva funcionalidad
- `fix:` corrección de bug
- `docs:` cambios en documentación
- `style:` cambios de formato
- `refactor:` reorganización de código
- `test:` tests
- `chore:` tareas de mantenimiento

### Áreas donde necesitamos ayuda

- 🎨 **Diseño gráfico**: logo, ilustraciones
- 📝 **Contenido pedagógico**: revisar prompt, DBA
- 🌐 **Traducción**: inglés, portugués
- 🧪 **Testing**: navegadores y dispositivos
- 📱 **Frontend**: UX, accesibilidad

---

## 👥 Autores

**Álvaro García Gómez**
- Cofundador · 14 años
- 📧 trivorensupport@gmail.com
- 🐙 [@trivoren](https://github.com/trivoren)

**Robinson Rodríguez Gómez**
- Cofundador · 14 años

---

## 📜 Licencia

Este proyecto está bajo la licencia **MIT**.

```
MIT License

Copyright (c) 2026 Álvaro García Gómez & Robinson Rodríguez Gómez

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

<div align="center">

### 🇨🇴 Hecho con 💛💙❤️ en Colombia

**Numination — La IA que habla el idioma de nuestra educación**

*"Queremos que ningún estudiante colombiano se quede sin un tutor que le explique con paciencia, sin importar dónde viva."*

**— Álvaro & Robinson, 14 años**

⭐ Si te gusta el proyecto, dale una estrella en GitHub ⭐

</div>
```
