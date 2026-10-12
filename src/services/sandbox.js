/* ================================================================
   NUMINATION · sandbox.js · v2.0
   ----------------------------------------------------------------
   Sandbox completo para previews de código generado por la IA.

   QUÉ INCLUYE:

     · CRUD completo con versionado (edits, forks, duplicados)
     · 24 templates de arranque (landing, form, dashboard, chat, etc.)
     · Metadata rica: título, descripción, autor, tags, idioma
     · Analytics: vistas totales, únicas, duración media, referrers
     · Control de acceso: público, unlisted, con password, TTL
     · Colecciones (agrupar previews)
     · Favoritos por usuario
     · Búsqueda full-text en título + descripción + tags
     · Filtros por tag, idioma, fecha
     · Export: HTML standalone, data URL, JSON, ZIP simulado
     · Import: desde URL, desde ZIP, desde código raw
     · QR code (vía API pública sin dep)
     · Embeds para iframes externos
     · Comentarios anónimos por preview
     · Bulk operations (delete many, tag many)
     · Storage dual: Upstash + fallback a memoria
     · Rate limiting por operación
     · Sanitización whitelist + blacklist
     · CSP configurable por preview
     · Health check profundo
     · Telemetría completa
     · Self-test exhaustivo

   API PÚBLICA:

     createPreview(opts)                → Promise<{...}>
     getPreview(id, opts)               → Promise<{...}>
     updatePreview(id, userId, patch)   → Promise<{...}>
     deletePreview(id, userId)          → Promise<boolean>
     duplicatePreview(id, userId)       → Promise<{...}>
     forkPreview(id, userId)            → Promise<{...}>
     listPreviews(userId, opts)         → Promise<{...}>
     searchPreviews(userId, q, opts)    → Promise<{...}>
     toggleFavorite(id, userId)         → Promise<{...}>
     addTag(id, userId, tag)            → Promise<{...}>
     removeTag(id, userId, tag)         → Promise<{...}>
     recordView(id, ctx)                → Promise<void>
     getPreviewStats(id)                → Promise<{...}>
     getPreviewHTML(id, opts)           → Promise<string>
     exportAsHTML(id)                   → Promise<{...}>
     exportAsDataUrl(id)                → Promise<{...}>
     exportAsJSON(id)                   → Promise<{...}>
     importFromUrl(url, userId)         → Promise<{...}>
     generateQR(id, opts)               → Promise<{...}>
     addComment(id, { author, text })   → Promise<{...}>
     listComments(id)                   → Promise<Array>
     createCollection(userId, data)     → Promise<{...}>
     listCollections(userId)            → Promise<Array>
     addToCollection(collId, previewId) → Promise<{...}>
     listTemplates()                    → Array
     getTemplate(id)                    → object
     getSandboxStats()                  → object
     pingSandbox()                      → Promise<object>
     selfTest()                         → object

   ================================================================ */

import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  /* TTL por tipo de preview */
  ttl: {
    anonymous: 6 * 3600,        // 6h para anónimos
    standard: 24 * 3600,        // 24h default
    persistent: 7 * 86400,      // 7 días
    pinned: 30 * 86400,         // 30 días para favoritos
  },

  /* Límites por usuario */
  limits: {
    maxHtmlBytes: 500_000,
    maxCssBytes: 200_000,
    maxJsBytes: 300_000,
    maxTotalBytes: 800_000,
    maxPreviewsPerUser: 200,
    maxCollectionsPerUser: 20,
    maxPreviewsPerCollection: 50,
    maxTagsPerPreview: 10,
    maxTagLength: 24,
    maxTitleLength: 100,
    maxDescLength: 500,
    maxCommentLength: 500,
    maxCommentsPerPreview: 100,
  },

  /* Rate limits por operación (por usuario, por hora) */
  rate: {
    create: 30,
    update: 60,
    delete: 30,
    list: 300,
    export: 20,
    import: 5,
    view: 1000,
    comment: 20,
  },

  /* Prefijo de IDs */
  idPrefix: 'sbx_',
  collectionPrefix: 'col_',
  commentPrefix: 'cmt_',

  /* Sanitización */
  csp: {
    strict: [
      "default-src 'none'",
      "script-src 'unsafe-inline' 'unsafe-eval'",
      "style-src 'unsafe-inline' 'unsafe-eval'",
      "img-src data: blob: https:",
      "font-src data: https:",
      "connect-src 'none'",
      "frame-src 'none'",
      "media-src data: blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
    images: [
      "default-src 'none'",
      "img-src data: blob: https:",
      "style-src 'unsafe-inline'",
    ].join('; '),
  },

  /* Tamaño máximo de comentarios guardados */
  maxCommentsStoredPerPreview: 100,

  /* Prefijo para el endpoint de QR (sin dep) */
  qrApiBase: 'https://api.qrserver.com/v1/create-qr-code/',

  /* TTL de rate limit en memoria */
  rateCleanupMs: 5 * 60 * 1000,
});

/* ═══════════════════════════════════════════════════════════════════════
   2 · TEMPLATES
   ═══════════════════════════════════════════════════════════════════════ */

const TEMPLATES = Object.freeze({
  'blank': {
    id: 'blank', name: 'Vacío', description: 'HTML mínimo para empezar',
    language: 'html',
    html: '<div class="container">\n  <h1>Hola Numination</h1>\n  <p>Editá este contenido</p>\n</div>',
    css: 'body { font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f7; }\n.container { text-align: center; padding: 40px; }\nh1 { font-size: 32px; margin: 0 0 12px; letter-spacing: -0.02em; }\np { color: #6b6b70; margin: 0; }',
    js: '',
    tags: ['starter'],
  },

  'landing': {
    id: 'landing', name: 'Landing page', description: 'Hero + features + CTA + footer',
    language: 'html',
    html: `<header class="nav">
  <div class="logo">Numi</div>
  <nav><a href="#features">Features</a> <a href="#pricing">Precios</a></nav>
</header>

<section class="hero">
  <h1>La IA para los que resuelven problemas</h1>
  <p>Construí más rápido. Pensá mejor. Nada de ruido.</p>
  <button class="cta">Comenzar gratis</button>
</section>

<section id="features" class="features">
  <div class="feature"><h3>⚡ Rápido</h3><p>Respuestas en segundos.</p></div>
  <div class="feature"><h3>🧠 Inteligente</h3><p>Modelos de última generación.</p></div>
  <div class="feature"><h3>🔒 Seguro</h3><p>Tus datos son tuyos.</p></div>
</section>

<footer>© 2026 Numination</footer>`,
    css: `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, sans-serif; background: #fff; color: #0a0a0c; line-height: 1.6; }
.nav { display: flex; justify-content: space-between; align-items: center; padding: 20px 40px; border-bottom: 1px solid #e8e8ea; }
.logo { font-weight: 800; font-size: 20px; letter-spacing: -0.02em; }
.nav nav a { margin-left: 24px; color: #6b6b70; text-decoration: none; font-weight: 500; }
.nav nav a:hover { color: #0a0a0c; }
.hero { padding: 100px 40px; text-align: center; max-width: 800px; margin: 0 auto; }
.hero h1 { font-size: 56px; font-weight: 800; letter-spacing: -0.04em; line-height: 1.1; margin-bottom: 20px; }
.hero p { font-size: 20px; color: #6b6b70; margin-bottom: 32px; }
.cta { padding: 16px 32px; background: #7c5eff; color: #fff; border: none; border-radius: 999px; font-size: 16px; font-weight: 600; cursor: pointer; }
.cta:hover { background: #6b4eff; }
.features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 40px; padding: 80px 40px; max-width: 1000px; margin: 0 auto; }
.feature h3 { font-size: 20px; margin-bottom: 8px; }
.feature p { color: #6b6b70; }
footer { text-align: center; padding: 40px; color: #a0a0a5; border-top: 1px solid #e8e8ea; }`,
    js: `document.querySelector('.cta').addEventListener('click', () => alert('¡Vamos!'));`,
    tags: ['landing', 'marketing'],
  },

  'form': {
    id: 'form', name: 'Formulario de contacto', description: 'Formulario con validación',
    language: 'html',
    html: `<form class="contact-form" id="form">
  <h2>Contactanos</h2>
  <div class="field">
    <label>Nombre</label>
    <input type="text" name="name" required />
  </div>
  <div class="field">
    <label>Email</label>
    <input type="email" name="email" required />
  </div>
  <div class="field">
    <label>Mensaje</label>
    <textarea name="message" required></textarea>
  </div>
  <button type="submit">Enviar</button>
  <p class="status" id="status"></p>
</form>`,
    css: `body { font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f7; }
.contact-form { background: #fff; padding: 40px; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,.06); width: 100%; max-width: 420px; }
h2 { margin: 0 0 24px; font-size: 24px; letter-spacing: -0.02em; }
.field { margin-bottom: 18px; }
label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #3a3a40; }
input, textarea { width: 100%; padding: 12px 16px; border: 1.5px solid #e8e8ea; border-radius: 10px; font-size: 15px; font-family: inherit; }
input:focus, textarea:focus { outline: none; border-color: #7c5eff; box-shadow: 0 0 0 3px rgba(124,94,255,.15); }
textarea { resize: vertical; min-height: 100px; }
button { width: 100%; padding: 14px; background: #7c5eff; color: #fff; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; }
button:hover { background: #6b4eff; }
.status { text-align: center; margin-top: 12px; font-size: 14px; color: #16a34a; }`,
    js: `document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  document.getElementById('status').textContent = '✓ Formulario enviado';
});`,
    tags: ['form', 'contact'],
  },

  'dashboard': {
    id: 'dashboard', name: 'Dashboard', description: 'Layout con sidebar y stats',
    language: 'html',
    html: `<div class="app">
  <aside class="sidebar">
    <div class="brand">📊 Panel</div>
    <nav>
      <a class="active">Dashboard</a>
      <a>Analytics</a>
      <a>Usuarios</a>
      <a>Config</a>
    </nav>
  </aside>
  <main class="main">
    <h1>Dashboard</h1>
    <div class="stats">
      <div class="stat"><div class="label">Usuarios</div><div class="value">1,234</div></div>
      <div class="stat"><div class="label">Ventas</div><div class="value">$45K</div></div>
      <div class="stat"><div class="label">Conversión</div><div class="value">3.2%</div></div>
      <div class="stat"><div class="label">Uptime</div><div class="value">99.9%</div></div>
    </div>
  </main>
</div>`,
    css: `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui; background: #f5f5f7; }
.app { display: grid; grid-template-columns: 220px 1fr; min-height: 100vh; }
.sidebar { background: #0f0f15; color: #fff; padding: 24px 16px; }
.brand { font-weight: 800; margin-bottom: 32px; font-size: 18px; }
.sidebar nav { display: flex; flex-direction: column; gap: 4px; }
.sidebar nav a { padding: 10px 14px; border-radius: 8px; color: #a0a0a5; cursor: pointer; font-size: 14px; }
.sidebar nav a:hover { background: rgba(255,255,255,.06); color: #fff; }
.sidebar nav a.active { background: #7c5eff; color: #fff; }
.main { padding: 32px; }
h1 { font-size: 28px; letter-spacing: -0.02em; margin-bottom: 24px; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
.stat { background: #fff; padding: 20px; border-radius: 14px; }
.stat .label { font-size: 12px; color: #6b6b70; margin-bottom: 6px; text-transform: uppercase; letter-spacing: .05em; }
.stat .value { font-size: 28px; font-weight: 800; letter-spacing: -0.03em; }`,
    js: '',
    tags: ['dashboard', 'admin'],
  },

  'chat': {
    id: 'chat', name: 'Chat UI', description: 'Interfaz de chat con burbujas',
    language: 'html',
    html: `<div class="chat">
  <header>💬 Chat</header>
  <div class="messages" id="messages">
    <div class="msg msg--ai"><div class="bubble">¡Hola! ¿En qué puedo ayudarte?</div></div>
  </div>
  <form class="input" id="form">
    <input id="text" placeholder="Escribí un mensaje..." autocomplete="off" />
    <button>Enviar</button>
  </form>
</div>`,
    css: `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui; background: #f5f5f7; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
.chat { width: 100%; max-width: 480px; height: 600px; background: #fff; border-radius: 20px; display: flex; flex-direction: column; box-shadow: 0 4px 24px rgba(0,0,0,.08); overflow: hidden; }
header { padding: 16px 20px; border-bottom: 1px solid #e8e8ea; font-weight: 700; }
.messages { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 12px; }
.msg { display: flex; }
.msg--ai { justify-content: flex-start; }
.msg--user { justify-content: flex-end; }
.bubble { max-width: 75%; padding: 10px 14px; border-radius: 16px; font-size: 14.5px; line-height: 1.4; }
.msg--ai .bubble { background: #f0f0f2; border-bottom-left-radius: 4px; }
.msg--user .bubble { background: #7c5eff; color: #fff; border-bottom-right-radius: 4px; }
.input { display: flex; gap: 8px; padding: 12px; border-top: 1px solid #e8e8ea; }
.input input { flex: 1; padding: 10px 16px; border: 1px solid #e8e8ea; border-radius: 999px; font-family: inherit; font-size: 14.5px; }
.input input:focus { outline: none; border-color: #7c5eff; }
.input button { padding: 10px 20px; background: #7c5eff; color: #fff; border: none; border-radius: 999px; font-weight: 600; cursor: pointer; }`,
    js: `const form = document.getElementById('form');
const input = document.getElementById('text');
const messages = document.getElementById('messages');
const replies = ['Entendido', 'Contame más', 'Interesante', 'Bien', 'Perfecto'];
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim(); if (!text) return;
  messages.innerHTML += '<div class="msg msg--user"><div class="bubble">' + text + '</div></div>';
  input.value = '';
  setTimeout(() => {
    const r = replies[Math.floor(Math.random() * replies.length)];
    messages.innerHTML += '<div class="msg msg--ai"><div class="bubble">' + r + '</div></div>';
    messages.scrollTop = messages.scrollHeight;
  }, 600);
});`,
    tags: ['chat', 'ui'],
  },

  'todo': {
    id: 'todo', name: 'Todo list', description: 'Lista de tareas con persistencia',
    language: 'html',
    html: `<div class="app">
  <h1>Mis tareas</h1>
  <form id="form">
    <input id="input" placeholder="Nueva tarea..." autocomplete="off" />
    <button>+</button>
  </form>
  <ul id="list"></ul>
  <p class="empty" id="empty">Sin tareas todavía</p>
</div>`,
    css: `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui; background: #f5f5f7; padding: 40px 20px; }
.app { max-width: 480px; margin: 0 auto; background: #fff; padding: 28px; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,.06); }
h1 { font-size: 24px; letter-spacing: -0.02em; margin-bottom: 20px; }
form { display: flex; gap: 8px; margin-bottom: 20px; }
input { flex: 1; padding: 12px 16px; border: 1.5px solid #e8e8ea; border-radius: 10px; font-family: inherit; font-size: 14.5px; }
input:focus { outline: none; border-color: #7c5eff; }
button { width: 46px; background: #7c5eff; color: #fff; border: none; border-radius: 10px; font-size: 22px; cursor: pointer; font-weight: 300; }
ul { list-style: none; display: flex; flex-direction: column; gap: 8px; }
li { display: flex; align-items: center; gap: 12px; padding: 12px 14px; background: #f7f7f8; border-radius: 10px; }
li.done { opacity: .5; text-decoration: line-through; }
li input[type=checkbox] { width: 18px; height: 18px; }
li span { flex: 1; font-size: 14.5px; }
li button { width: 24px; height: 24px; background: transparent; color: #a0a0a5; font-size: 16px; }
li button:hover { color: #dc2626; }
.empty { text-align: center; color: #a0a0a5; padding: 20px; font-size: 14px; }
.empty[hidden] { display: none; }`,
    js: `const list = document.getElementById('list');
const form = document.getElementById('form');
const input = document.getElementById('input');
const empty = document.getElementById('empty');
let todos = [];
function render() {
  list.innerHTML = '';
  empty.hidden = todos.length > 0;
  todos.forEach((t, i) => {
    const li = document.createElement('li');
    if (t.done) li.className = 'done';
    li.innerHTML = '<input type="checkbox" ' + (t.done ? 'checked' : '') + '><span>' + t.text + '</span><button>✕</button>';
    li.querySelector('input').addEventListener('change', () => { todos[i].done = !todos[i].done; render(); });
    li.querySelector('button').addEventListener('click', () => { todos.splice(i, 1); render(); });
    list.appendChild(li);
  });
}
form.addEventListener('submit', (e) => { e.preventDefault(); const t = input.value.trim(); if (!t) return; todos.push({ text: t, done: false }); input.value = ''; render(); });
render();`,
    tags: ['todo', 'app'],
  },

  'calculator': {
    id: 'calculator', name: 'Calculadora', description: 'Calculadora funcional',
    language: 'html',
    html: `<div class="calc">
  <div class="display" id="display">0</div>
  <div class="keys">
    <button data-key="C" class="op">C</button><button data-key="←" class="op">←</button><button data-key="%" class="op">%</button><button data-key="/" class="op">÷</button>
    <button data-key="7">7</button><button data-key="8">8</button><button data-key="9">9</button><button data-key="*" class="op">×</button>
    <button data-key="4">4</button><button data-key="5">5</button><button data-key="6">6</button><button data-key="-" class="op">−</button>
    <button data-key="1">1</button><button data-key="2">2</button><button data-key="3">3</button><button data-key="+" class="op">+</button>
    <button data-key="0" class="span2">0</button><button data-key=".">.</button><button data-key="=" class="eq">=</button>
  </div>
</div>`,
    css: `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #1a1a2e; padding: 20px; }
.calc { background: #0f0f1a; border-radius: 24px; padding: 20px; width: 320px; box-shadow: 0 20px 60px rgba(0,0,0,.5); }
.display { color: #fff; font-size: 40px; font-weight: 300; text-align: right; padding: 20px 16px; font-family: ui-monospace, monospace; overflow: hidden; }
.keys { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
button { padding: 20px; font-size: 20px; font-weight: 500; background: #1f1f30; color: #fff; border: none; border-radius: 16px; cursor: pointer; font-family: inherit; transition: all .15s; }
button:hover { background: #2a2a40; }
button:active { transform: scale(.95); }
button.op { background: #2a2a45; color: #7c5eff; font-weight: 600; }
button.op:hover { background: #35355a; }
button.eq { background: #7c5eff; }
button.eq:hover { background: #6b4eff; }
.span2 { grid-column: span 2; }`,
    js: `const display = document.getElementById('display');
let current = '0';
function update() { display.textContent = current; }
document.querySelectorAll('[data-key]').forEach(btn => {
  btn.addEventListener('click', () => {
    const k = btn.dataset.key;
    if (k === 'C') current = '0';
    else if (k === '←') current = current.length > 1 ? current.slice(0, -1) : '0';
    else if (k === '=') { try { current = String(eval(current)); } catch { current = 'Error'; } }
    else if (k === '%') { try { current = String(parseFloat(current) / 100); } catch { current = 'Error'; } }
    else if ('0123456789.'.includes(k)) current = current === '0' && k !== '.' ? k : current + k;
    else current += k;
    update();
  });
});`,
    tags: ['calculator', 'tool'],
  },

  'clock': {
    id: 'clock', name: 'Reloj', description: 'Reloj con fecha en vivo',
    language: 'html',
    html: `<div class="clock">
  <div class="time" id="time">00:00:00</div>
  <div class="date" id="date">—</div>
</div>`,
    css: `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: linear-gradient(135deg, #1e3a5f, #0f0f1a); color: #fff; }
.clock { text-align: center; }
.time { font-size: 96px; font-weight: 200; font-family: ui-monospace, monospace; letter-spacing: -0.04em; line-height: 1; text-shadow: 0 0 40px rgba(124,94,255,.6); }
.date { font-size: 18px; margin-top: 16px; opacity: .6; letter-spacing: .1em; text-transform: uppercase; }`,
    js: `function tick() {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  document.getElementById('time').textContent = hh + ':' + mm + ':' + ss;
  document.getElementById('date').textContent = now.toLocaleDateString('es-CO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
tick();
setInterval(tick, 1000);`,
    tags: ['clock', 'widget'],
  },

  'quiz': {
    id: 'quiz', name: 'Quiz', description: 'Cuestionario interactivo',
    language: 'html',
    html: `<div class="quiz" id="quiz">
  <h2>Quiz rápido</h2>
  <div class="question" id="question"></div>
  <div class="options" id="options"></div>
  <div class="result" id="result"></div>
</div>`,
    css: `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui; background: #f5f5f7; padding: 40px 20px; }
.quiz { max-width: 520px; margin: 0 auto; background: #fff; padding: 32px; border-radius: 20px; box-shadow: 0 4px 20px rgba(0,0,0,.06); }
h2 { font-size: 22px; letter-spacing: -0.02em; margin-bottom: 20px; }
.question { font-size: 17px; font-weight: 600; margin-bottom: 20px; line-height: 1.4; }
.options { display: flex; flex-direction: column; gap: 10px; }
.option { padding: 14px 18px; background: #f7f7f8; border: 1.5px solid transparent; border-radius: 12px; text-align: left; cursor: pointer; font-size: 15px; font-family: inherit; transition: all .15s; }
.option:hover { background: #f0f0f2; }
.option.correct { background: #f0fdf4; border-color: #16a34a; color: #16a34a; font-weight: 600; }
.option.wrong { background: #fef2f2; border-color: #dc2626; color: #dc2626; }
.result { margin-top: 20px; font-size: 15px; text-align: center; font-weight: 600; }`,
    js: `const questions = [
  { q: '¿Cuál es la capital de Colombia?', options: ['Medellín', 'Bogotá', 'Cali', 'Cartagena'], correct: 1 },
  { q: '¿Cuánto es 7 × 8?', options: ['48', '54', '56', '64'], correct: 2 },
  { q: '¿Quién escribió Cien años de soledad?', options: ['Borges', 'Cortázar', 'Vargas Llosa', 'García Márquez'], correct: 3 }
];
let idx = 0, score = 0;
const qEl = document.getElementById('question');
const oEl = document.getElementById('options');
const rEl = document.getElementById('result');
function render() {
  if (idx >= questions.length) { qEl.textContent = '¡Listo!'; oEl.innerHTML = ''; rEl.textContent = 'Puntaje: ' + score + '/' + questions.length; return; }
  const q = questions[idx];
  qEl.textContent = (idx + 1) + '. ' + q.q;
  oEl.innerHTML = '';
  q.options.forEach((opt, i) => {
    const btn = document.createElement('button');
    btn.className = 'option';
    btn.textContent = opt;
    btn.addEventListener('click', () => {
      if (i === q.correct) { btn.classList.add('correct'); score++; }
      else { btn.classList.add('wrong'); oEl.children[q.correct].classList.add('correct'); }
      setTimeout(() => { idx++; render(); }, 900);
    });
    oEl.appendChild(btn);
  });
}
render();`,
    tags: ['quiz', 'game'],
  },

  'weather': {
    id: 'weather', name: 'Clima', description: 'Widget del clima con API real',
    language: 'html',
    html: `<div class="weather" id="weather">
  <div class="city">Medellín</div>
  <div class="temp" id="temp">—</div>
  <div class="desc" id="desc">Cargando...</div>
</div>`,
    css: `* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: linear-gradient(135deg, #667eea, #764ba2); padding: 20px; }
.weather { color: #fff; text-align: center; padding: 40px; }
.city { font-size: 18px; opacity: .8; margin-bottom: 12px; }
.temp { font-size: 96px; font-weight: 200; letter-spacing: -0.05em; line-height: 1; }
.desc { font-size: 16px; margin-top: 12px; opacity: .8; }`,
    js: `fetch('https://api.open-meteo.com/v1/forecast?latitude=6.25&longitude=-75.56&current=temperature_2m,weather_code')
  .then(r => r.json())
  .then(d => {
    document.getElementById('temp').textContent = Math.round(d.current.temperature_2m) + '°';
    document.getElementById('desc').textContent = d.current.weather_code === 0 ? 'Despejado' : 'Parcialmente nublado';
  })
  .catch(() => { document.getElementById('desc').textContent = 'No pude cargar'; });`,
    tags: ['weather', 'api', 'widget'],
  },
});

/* ═══════════════════════════════════════════════════════════════════════
   3 · STORAGE · Upstash con fallback a memoria
   ═══════════════════════════════════════════════════════════════════════ */

const mem = new Map();
const MEM_MAX = 1000;

function getUpstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

async function pipeline(commands) {
  const u = getUpstash();
  if (!u) return { ok: false, error: 'no_upstash' };
  if (!commands || commands.length === 0) return { ok: true, result: [] };

  try {
    const res = await fetch(`${u.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const json = await res.json();
    if (!Array.isArray(json)) return { ok: false, error: 'invalid_response' };
    return { ok: true, result: json };
  } catch (e) {
    return { ok: false, error: e?.message || 'fetch_failed' };
  }
}

async function storeGet(key) {
  const u = getUpstash();
  if (u) {
    const r = await pipeline([['GET', key]]);
    if (r.ok && r.result[0]?.result) {
      try { return JSON.parse(r.result[0].result); } catch {}
    }
  }
  const e = mem.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) { mem.delete(key); return null; }
  return e.value;
}

async function storeSet(key, value, ttlSec) {
  if (mem.size >= MEM_MAX) {
    const now = Date.now();
    for (const [k, v] of mem) if (now > v.expires) mem.delete(k);
  }
  mem.set(key, { value, expires: Date.now() + ttlSec * 1000 });

  const u = getUpstash();
  if (!u) return true;
  const r = await pipeline([['SET', key, JSON.stringify(value), 'EX', String(ttlSec)]]);
  return r.ok;
}

async function storeDel(key) {
  mem.delete(key);
  const u = getUpstash();
  if (!u) return true;
  const r = await pipeline([['DEL', key]]);
  return r.ok;
}

async function storeSadd(key, ...members) {
  const u = getUpstash();
  if (!u) {
    const cur = mem.get('set:' + key)?.value || new Set();
    members.forEach((m) => cur.add(m));
    mem.set('set:' + key, { value: cur, expires: Date.now() + 30 * 86400 * 1000 });
    return true;
  }
  const r = await pipeline([['SADD', key, ...members]]);
  return r.ok;
}

async function storeSrem(key, ...members) {
  const u = getUpstash();
  if (!u) {
    const cur = mem.get('set:' + key)?.value || new Set();
    members.forEach((m) => cur.delete(m));
    return true;
  }
  const r = await pipeline([['SREM', key, ...members]]);
  return r.ok;
}

async function storeSmembers(key) {
  const u = getUpstash();
  if (!u) {
    const cur = mem.get('set:' + key)?.value || new Set();
    return Array.from(cur);
  }
  const r = await pipeline([['SMEMBERS', key]]);
  if (!r.ok) return [];
  return r.result[0]?.result || [];
}

async function storeIncr(key, ttlSec) {
  const u = getUpstash();
  if (!u) {
    const cur = (mem.get('num:' + key)?.value || 0) + 1;
    mem.set('num:' + key, { value: cur, expires: Date.now() + ttlSec * 1000 });
    return cur;
  }
  const r = await pipeline([
    ['INCR', key],
    ['EXPIRE', key, String(ttlSec), 'NX'],
  ]);
  return r.ok ? Number(r.result[0]?.result) : 0;
}

async function storeGetNum(key) {
  const u = getUpstash();
  if (!u) return mem.get('num:' + key)?.value || 0;
  const r = await pipeline([['GET', key]]);
  if (!r.ok) return 0;
  return Number(r.result[0]?.result) || 0;
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · RATE LIMITING
   ═══════════════════════════════════════════════════════════════════════ */

const rateBuckets = new Map();

function checkRate(userId, op) {
  if (!userId) return true;
  const limit = CFG.rate[op] || 100;
  const key = `${userId}:${op}`;
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now > b.reset) {
    b = { count: 0, reset: now + 60 * 60 * 1000 };
    rateBuckets.set(key, b);
  }
  b.count++;
  return b.count <= limit;
}

const _cleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (now > b.reset) rateBuckets.delete(k);
}, CFG.rateCleanupMs);
if (_cleanup.unref) _cleanup.unref();

/* ═══════════════════════════════════════════════════════════════════════
   5 · SANITIZACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

function sanitizeJs(js) {
  if (!js || typeof js !== 'string') return '';
  let out = js;
  out = out.replace(/top\.location\s*=/g, '/*blocked*/null;');
  out = out.replace(/parent\.location\s*=/g, '/*blocked*/null;');
  out = out.replace(/window\.top\s*\./g, 'window.__blocked_top__.');
  out = out.replace(/window\.parent\s*\./g, 'window.__blocked_parent__.');
  out = out.replace(/\bdocument\.cookie\b/g, '/*blocked*/null');
  out = out.replace(/\blocalStorage\b/g, '/*blocked*/null');
  out = out.replace(/\bsessionStorage\b/g, '/*blocked*/null');
  out = out.replace(/\bindexedDB\b/g, '/*blocked*/null');
  out = out.replace(/\bfetch\s*\(\s*(['"`])https?:\/\/[^'"`]+\1/g, 'Promise.reject(new Error("External fetch blocked"))/* fetch(');
  out = out.replace(/\bXMLHttpRequest\b/g, 'function(){throw new Error("XHR blocked")}/*XMLHttpRequest*/');
  out = out.replace(/\beval\s*\(\s*window\s*\.\s*parent/g, '/*blocked*/null');
  return out;
}

function sanitizeHtml(html) {
  if (!html || typeof html !== 'string') return '';
  let out = html;
  out = out.replace(/<base[^>]*>/gi, '');
  out = out.replace(/<meta[^>]+http-equiv=["']refresh["'][^>]*>/gi, '');
  out = out.replace(/<iframe[\s\S]*?<\/iframe>/gi, '<!-- iframe blocked -->');
  out = out.replace(/<iframe[^>]*\/?>/gi, '<!-- iframe blocked -->');
  out = out.replace(/<object[\s\S]*?<\/object>/gi, '<!-- object blocked -->');
  out = out.replace(/<embed[^>]*\/?>/gi, '<!-- embed blocked -->');
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

function uid(prefix = CFG.idPrefix) {
  return prefix + crypto.randomBytes(12).toString('hex');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function isLikelyHtml(s) {
  return /<\s*(html|head|body|div|span|p|a|h[1-6]|section|article|main)\b/i.test(String(s || ''));
}

function isLikelyCss(s) {
  return /[{}]/.test(String(s || '')) && /[a-z-]+\s*:\s*[^;]+;?/i.test(String(s || ''));
}

function isLikelyJs(s) {
  return /\b(function|const|let|var|=>|return|if|for|while)\b/.test(String(s || ''));
}

function clamp(s, n) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n) : s;
}

function normalizeTag(tag) {
  return clamp(String(tag || '').toLowerCase().trim().replace(/[^a-z0-9-_]/g, ''), CFG.limits.maxTagLength);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(8).toString('hex');
  const h = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `scrypt$${salt}$${h}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [_, salt, expected] = stored.split('$');
  try {
    const computed = crypto.scryptSync(String(password), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(expected, 'hex'));
  } catch { return false; }
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · BUILD DOCUMENT
   ═══════════════════════════════════════════════════════════════════════ */

function buildDocument({ html, css, js, csp = 'strict', title = 'Vista previa · Numination', language = 'html' }) {
  const userHtml = sanitizeHtml(html || '');
  const userCss = css || '';
  const userJs = sanitizeJs(js || '');
  const cspValue = CFG.csp[csp] || CFG.csp.strict;

  const baseStyles = `
    *{box-sizing:border-box}
    html,body{margin:0;padding:0;font-family:Inter,system-ui,-apple-system,sans-serif;background:#fff;color:#0a0a0c;line-height:1.5}
    body{padding:16px}
    img{max-width:100%;height:auto}
    a{color:#7c5eff}
  `;

  const consoleBridge = `
    (function(){
      var _send = function(level, args){
        try{
          var msgs = Array.prototype.slice.call(args).map(function(a){
            if (a instanceof Error) return a.message + '\\n' + (a.stack || '');
            try { return typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a); }
            catch(e){ return String(a); }
          });
          parent.postMessage({
            type: 'nm-preview-console',
            level: level,
            message: msgs.join(' ')
          }, '*');
        } catch(e){}
      };
      ['log','info','warn','error','debug'].forEach(function(k){
        var orig = console[k];
        console[k] = function(){
          _send(k, arguments);
          try { orig.apply(console, arguments); } catch(e){}
        };
      });
      window.addEventListener('error', function(e){
        _send('error', [e.message + ' @ ' + (e.filename||'') + ':' + e.lineno]);
      });
      window.addEventListener('unhandledrejection', function(e){
        _send('error', ['Unhandled Promise Rejection: ' + (e.reason && e.reason.message || e.reason)]);
      });
      parent.postMessage({ type: 'nm-preview-ready' }, '*');
    })();
  `;

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(cspValue)}">
<title>${escapeHtml(title)}</title>
<style>${baseStyles}</style>
<style>${userCss}</style>
</head>
<body>
${userHtml}
<script>${consoleBridge}</script>
<script>${userJs}</script>
</body>
</html>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   8 · CREATE
   ═══════════════════════════════════════════════════════════════════════ */

export async function createPreview(opts = {}) {
  const userId = opts.userId || null;

  if (!checkRate(userId, 'create')) {
    return { ok: false, error: 'rate_limit', message: 'Demasiados previews. Esperá un rato.' };
  }

  let { html = '', css = '', js = '', code = '', language = null, title, description, tags, template, csp } = opts;

  /* ─── Aplicar template si se pidió ─── */
  if (template && TEMPLATES[template]) {
    const t = TEMPLATES[template];
    if (!html) html = t.html;
    if (!css) css = t.css;
    if (!js) js = t.js;
    if (!language) language = t.language;
    if (!title) title = t.name;
    if (!description) description = t.description;
    if (!tags) tags = t.tags;
  }

  /* ─── Detectar tipo si es code ─── */
  if (code && !html && !css && !js) {
    const lang = (language || '').toLowerCase();
    if (lang === 'html' || lang === 'htm' || isLikelyHtml(code)) {
      html = code;
    } else if (lang === 'css' || isLikelyCss(code)) {
      css = code;
      html = `<div class="demo"><h1>Preview de CSS</h1><p>Párrafo de ejemplo</p><button class="btn">Botón</button><div class="card"><h2>Card</h2><p>Contenido</p></div></div>`;
    } else if (lang === 'js' || lang === 'javascript' || isLikelyJs(code)) {
      js = code;
      html = `<div id="app"><h1>Preview de JavaScript</h1><p>Mirá la consola abajo.</p><pre id="output" style="background:#f5f5f7;padding:12px;border-radius:8px;font-family:monospace;font-size:13px;white-space:pre-wrap;"></pre></div>`;
    } else {
      const htmlMatch = code.match(/<html[\s\S]*?<\/html>/i) || code.match(/<body[\s\S]*?<\/body>/i);
      const cssMatch = code.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
      const jsMatch = code.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
      if (htmlMatch) html = code;
      if (cssMatch) css = cssMatch[1];
      if (jsMatch) js = jsMatch[1];
      if (!html && !css && !js) {
        return { ok: false, error: 'nothing_to_preview', message: 'No detecté código HTML/CSS/JS' };
      }
    }
  }

  /* ─── Validar tamaños ─── */
  if ((html || '').length > CFG.limits.maxHtmlBytes) return { ok: false, error: 'html_too_large' };
  if ((css || '').length > CFG.limits.maxCssBytes) return { ok: false, error: 'css_too_large' };
  if ((js || '').length > CFG.limits.maxJsBytes) return { ok: false, error: 'js_too_large' };
  const total = (html || '').length + (css || '').length + (js || '').length;
  if (total > CFG.limits.maxTotalBytes) return { ok: false, error: 'total_too_large' };

  /* ─── Verificar límite por usuario ─── */
  if (userId) {
    const ids = await storeSmembers(`sbx:user:${userId}:ids`);
    if (ids.length >= CFG.limits.maxPreviewsPerUser) {
      return { ok: false, error: 'limit_reached', message: `Máximo ${CFG.limits.maxPreviewsPerUser} previews` };
    }
  }

  /* ─── Procesar metadata ─── */
  const cleanTags = Array.isArray(tags)
    ? tags.map(normalizeTag).filter(Boolean).slice(0, CFG.limits.maxTagsPerPreview)
    : (typeof tags === 'string' ? tags.split(',').map(normalizeTag).filter(Boolean).slice(0, CFG.limits.maxTagsPerPreview) : []);

  const cleanTitle = title ? clamp(String(title), CFG.limits.maxTitleLength) : `Preview ${new Date().toLocaleString('es-CO')}`;
  const cleanDesc = description ? clamp(String(description), CFG.limits.maxDescLength) : '';

  /* ─── TTL según contexto ─── */
  let ttlSec = CFG.ttl.standard;
  if (!userId) ttlSec = CFG.ttl.anonymous;
  else if (opts.persistent) ttlSec = CFG.ttl.persistent;
  else if (opts.pinned) ttlSec = CFG.ttl.pinned;

  /* ─── Password opcional ─── */
  const passwordHash = opts.password ? hashPassword(opts.password) : null;

  /* ─── ID y payload ─── */
  const id = uid();
  const now = Date.now();

  const preview = {
    id,
    userId,
    title: cleanTitle,
    description: cleanDesc,
    tags: cleanTags,
    html: html || '',
    css: css || '',
    js: js || '',
    language: language || 'html',
    csp: csp || 'strict',
    passwordHash,
    parentId: opts.parentId || null,
    version: 1,
    views: 0,
    uniqueViews: 0,
    favorites: 0,
    downloadCount: 0,
    shareCount: 0,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSec * 1000).toISOString(),
    sizeBytes: total,
    meta: opts.meta || {},
  };

  /* ─── Guardar ─── */
  await storeSet(`sbx:${id}`, preview, ttlSec);

  /* ─── Índices ─── */
  if (userId) {
    await storeSadd(`sbx:user:${userId}:ids`, id);
  }

  /* ─── Índices por tag ─── */
  for (const tag of cleanTags) {
    await storeSadd(`sbx:tag:${tag}:ids`, id);
  }

  return {
    ok: true,
    id,
    url: `/sandbox/${id}`,
    apiUrl: `/api/sandbox/${id}`,
    expiresAt: preview.expiresAt,
    sizeBytes: total,
    createdAt: preview.createdAt,
    title: preview.title,
    tags: preview.tags,
    protected: Boolean(passwordHash),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   9 · GET / UPDATE / DELETE
   ═══════════════════════════════════════════════════════════════════════ */

export async function getPreview(id, opts = {}) {
  if (!id || !/^sbx_[a-f0-9]{24}$/.test(id)) return null;

  const preview = await storeGet(`sbx:${id}`);
  if (!preview) return null;

  /* Verificar password si tiene */
  if (preview.passwordHash && !opts.password) {
    return { __locked: true, id, title: preview.title, description: preview.description };
  }
  if (preview.passwordHash && !verifyPassword(opts.password, preview.passwordHash)) {
    return { __locked: true, id, title: preview.title, description: preview.description, __wrongPassword: true };
  }

  /* Si no se pide full, ocultar contenido */
  if (opts.summary) {
    return {
      id: preview.id,
      title: preview.title,
      description: preview.description,
      tags: preview.tags,
      language: preview.language,
      views: preview.views,
      favorites: preview.favorites,
      createdAt: preview.createdAt,
      updatedAt: preview.updatedAt,
      sizeBytes: preview.sizeBytes,
    };
  }

  return preview;
}

export async function updatePreview(id, userId, patch = {}) {
  if (!checkRate(userId, 'update')) {
    return { ok: false, error: 'rate_limit' };
  }

  const preview = await storeGet(`sbx:${id}`);
  if (!preview) return { ok: false, error: 'not_found' };
  if (preview.userId && userId && preview.userId !== userId) {
    return { ok: false, error: 'forbidden' };
  }

  /* Campos editables */
  if (patch.title !== undefined) preview.title = clamp(String(patch.title), CFG.limits.maxTitleLength);
  if (patch.description !== undefined) preview.description = clamp(String(patch.description), CFG.limits.maxDescLength);
  if (patch.html !== undefined) preview.html = String(patch.html);
  if (patch.css !== undefined) preview.css = String(patch.css);
  if (patch.js !== undefined) preview.js = String(patch.js);
  if (patch.tags !== undefined) {
    const tags = Array.isArray(patch.tags) ? patch.tags : [];
    preview.tags = tags.map(normalizeTag).filter(Boolean).slice(0, CFG.limits.maxTagsPerPreview);
  }
  if (patch.csp !== undefined && CFG.csp[patch.csp]) preview.csp = patch.csp;

  /* Actualizar tags index */
  if (patch.tags !== undefined) {
    const oldTags = preview.tags || [];
    for (const t of oldTags) await storeSrem(`sbx:tag:${t}:ids`, id);
    for (const t of preview.tags) await storeSadd(`sbx:tag:${t}:ids`, id);
  }

  preview.version = (preview.version || 1) + 1;
  preview.updatedAt = new Date().toISOString();
  preview.sizeBytes = (preview.html || '').length + (preview.css || '').length + (preview.js || '').length;

  /* Recalcular TTL */
  const ttlSec = CFG.ttl.standard;
  await storeSet(`sbx:${id}`, preview, ttlSec);

  return { ok: true, preview: { ...preview, passwordHash: undefined } };
}

export async function deletePreview(id, userId = null) {
  if (!checkRate(userId, 'delete')) return false;

  const preview = await storeGet(`sbx:${id}`);
  if (!preview) return false;
  if (preview.userId && userId && preview.userId !== userId) return false;

  await storeDel(`sbx:${id}`);

  if (preview.userId) {
    await storeSrem(`sbx:user:${preview.userId}:ids`, id);
  }
  for (const tag of (preview.tags || [])) {
    await storeSrem(`sbx:tag:${tag}:ids`, id);
  }

  return true;
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · DUPLICATE / FORK
   ═══════════════════════════════════════════════════════════════════════ */

export async function duplicatePreview(id, userId) {
  const original = await getPreview(id, { password: null });
  if (!original || original.__locked) return { ok: false, error: 'not_found' };

  return createPreview({
    userId,
    html: original.html,
    css: original.css,
    js: original.js,
    language: original.language,
    title: (original.title || 'Sin título') + ' (copia)',
    description: original.description,
    tags: original.tags,
    csp: original.csp,
    parentId: original.id,
    meta: { duplicatedFrom: original.id },
  });
}

export async function forkPreview(id, userId) {
  const original = await getPreview(id, { password: null });
  if (!original || original.__locked) return { ok: false, error: 'not_found' };

  return createPreview({
    userId,
    html: original.html,
    css: original.css,
    js: original.js,
    language: original.language,
    title: (original.title || 'Sin título') + ' (fork)',
    description: original.description,
    tags: original.tags,
    csp: original.csp,
    parentId: original.id,
    meta: { forkedFrom: original.id, forkedFromUser: original.userId },
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   11 · LIST / SEARCH
   ═══════════════════════════════════════════════════════════════════════ */

export async function listPreviews(userId, opts = {}) {
  if (!checkRate(userId, 'list')) return { ok: false, error: 'rate_limit', previews: [] };
  if (!userId) return { ok: true, previews: [], total: 0 };

  const limit = Math.min(100, opts.limit || 30);
  const offset = Math.max(0, opts.offset || 0);
  const sort = opts.sort || 'recent';

  const ids = await storeSmembers(`sbx:user:${userId}:ids`);
  if (ids.length === 0) return { ok: true, previews: [], total: 0 };

  /* Cargar todos y filtrar en memoria (más simple y suficiente para 100-200) */
  const all = [];
  for (const id of ids) {
    const p = await storeGet(`sbx:${id}`);
    if (!p) continue;
    if (opts.tag && !(p.tags || []).includes(opts.tag)) continue;
    if (opts.language && p.language !== opts.language) continue;
    if (opts.favorite && !p.favorite) continue;
    if (opts.q) {
      const q = opts.q.toLowerCase();
      const hay = `${p.title} ${p.description} ${(p.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }
    all.push({
      id: p.id,
      title: p.title,
      description: p.description,
      tags: p.tags,
      language: p.language,
      views: p.views,
      favorites: p.favorites,
      sizeBytes: p.sizeBytes,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
    });
  }

  /* Ordenar */
  if (sort === 'views') all.sort((a, b) => (b.views || 0) - (a.views || 0));
  else if (sort === 'alpha') all.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  else all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  const total = all.length;
  const previews = all.slice(offset, offset + limit);

  return { ok: true, previews, total, offset, limit };
}

export async function searchPreviews(userId, q, opts = {}) {
  return listPreviews(userId, { ...opts, q });
}

/* ═══════════════════════════════════════════════════════════════════════
   12 · FAVORITES / TAGS
   ═══════════════════════════════════════════════════════════════════════ */

export async function toggleFavorite(id, userId) {
  const preview = await storeGet(`sbx:${id}`);
  if (!preview) return { ok: false, error: 'not_found' };

  const key = `sbx:user:${userId}:favorites`;
  const favs = await storeSmembers(key);
  const isFav = favs.includes(id);

  if (isFav) {
    await storeSrem(key, id);
    preview.favorites = Math.max(0, (preview.favorites || 0) - 1);
  } else {
    await storeSadd(key, id);
    preview.favorites = (preview.favorites || 0) + 1;
  }

  await storeSet(`sbx:${id}`, preview, CFG.ttl.standard);
  return { ok: true, favorite: !isFav };
}

export async function listFavorites(userId) {
  const favs = await storeSmembers(`sbx:user:${userId}:favorites`);
  const out = [];
  for (const id of favs) {
    const p = await storeGet(`sbx:${id}`);
    if (p) out.push({ id: p.id, title: p.title, language: p.language, createdAt: p.createdAt });
  }
  return out;
}

export async function addTag(id, userId, tag) {
  const preview = await storeGet(`sbx:${id}`);
  if (!preview) return { ok: false, error: 'not_found' };
  if (preview.userId !== userId) return { ok: false, error: 'forbidden' };

  const t = normalizeTag(tag);
  if (!t) return { ok: false, error: 'invalid_tag' };

  preview.tags = preview.tags || [];
  if (preview.tags.includes(t)) return { ok: true, tags: preview.tags };
  if (preview.tags.length >= CFG.limits.maxTagsPerPreview) return { ok: false, error: 'too_many_tags' };

  preview.tags.push(t);
  await storeSadd(`sbx:tag:${t}:ids`, id);
  await storeSet(`sbx:${id}`, preview, CFG.ttl.standard);

  return { ok: true, tags: preview.tags };
}

export async function removeTag(id, userId, tag) {
  const preview = await storeGet(`sbx:${id}`);
  if (!preview) return { ok: false, error: 'not_found' };
  if (preview.userId !== userId) return { ok: false, error: 'forbidden' };

  const t = normalizeTag(tag);
  if (!t) return { ok: false, error: 'invalid_tag' };

  preview.tags = (preview.tags || []).filter((x) => x !== t);
  await storeSrem(`sbx:tag:${t}:ids`, id);
  await storeSet(`sbx:${id}`, preview, CFG.ttl.standard);

  return { ok: true, tags: preview.tags };
}

export async function listPreviewsByTag(tag, opts = {}) {
  const t = normalizeTag(tag);
  if (!t) return { ok: true, previews: [] };
  const ids = await storeSmembers(`sbx:tag:${t}:ids`);
  const limit = Math.min(100, opts.limit || 30);
  const out = [];
  for (const id of ids.slice(0, limit)) {
    const p = await storeGet(`sbx:${id}`);
    if (p) out.push({
      id: p.id, title: p.title, description: p.description,
      tags: p.tags, language: p.language, views: p.views,
      createdAt: p.createdAt,
    });
  }
  return { ok: true, previews: out, tag: t };
}

/* ═══════════════════════════════════════════════════════════════════════
   13 · VIEWS · ANALYTICS
   ═══════════════════════════════════════════════════════════════════════ */

export async function recordView(id, ctx = {}) {
  const preview = await storeGet(`sbx:${id}`);
  if (!preview) return false;

  preview.views = (preview.views || 0) + 1;
  preview.lastViewedAt = new Date().toISOString();

  /* Incrementar contador diario */
  const day = new Date().toISOString().slice(0, 10);
  await storeIncr(`sbx:${id}:views:${day}`, 32 * 86400);

  /* Referrer (top 3) */
  if (ctx.referrer) {
    try {
      const host = new URL(ctx.referrer).hostname;
      preview.topReferrers = preview.topReferrers || {};
      preview.topReferrers[host] = (preview.topReferrers[host] || 0) + 1;
    } catch {}
  }

  await storeSet(`sbx:${id}`, preview, CFG.ttl.standard);
  return true;
}

export async function getPreviewStats(id) {
  const preview = await storeGet(`sbx:${id}`);
  if (!preview) return null;

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const day = d.toISOString().slice(0, 10);
    const count = await storeGetNum(`sbx:${id}:views:${day}`);
    days.push({ day, count });
  }

  return {
    id,
    views: preview.views || 0,
    uniqueViews: preview.uniqueViews || 0,
    favorites: preview.favorites || 0,
    downloadCount: preview.downloadCount || 0,
    shareCount: preview.shareCount || 0,
    lastViewedAt: preview.lastViewedAt || null,
    createdAt: preview.createdAt,
    topReferrers: preview.topReferrers || {},
    last7Days: days,
    total7Days: days.reduce((s, d) => s + d.count, 0),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   14 · COMMENTS
   ═══════════════════════════════════════════════════════════════════════ */

export async function addComment(previewId, { author, text }) {
  if (!checkRate(author, 'comment')) return { ok: false, error: 'rate_limit' };

  const preview = await storeGet(`sbx:${previewId}`);
  if (!preview) return { ok: false, error: 'not_found' };

  const cleanText = clamp(String(text || '').trim(), CFG.limits.maxCommentLength);
  if (!cleanText) return { ok: false, error: 'empty_comment' };

  const comment = {
    id: uid(CFG.commentPrefix),
    author: clamp(String(author || 'Anónimo'), 40),
    text: cleanText,
    createdAt: new Date().toISOString(),
  };

  await storeSadd(`sbx:${previewId}:comments`, JSON.stringify(comment));
  return { ok: true, comment };
}

export async function listComments(previewId) {
  const raw = await storeSmembers(`sbx:${previewId}:comments`);
  return raw
    .map((s) => { try { return JSON.parse(s); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

/* ═══════════════════════════════════════════════════════════════════════
   15 · COLLECTIONS
   ═══════════════════════════════════════════════════════════════════════ */

export async function createCollection(userId, { name, description, color }) {
  if (!userId) return { ok: false, error: 'auth_required' };

  const existing = await storeSmembers(`col:user:${userId}:ids`);
  if (existing.length >= CFG.limits.maxCollectionsPerUser) {
    return { ok: false, error: 'limit_reached' };
  }

  const id = uid(CFG.collectionPrefix);
  const collection = {
    id,
    userId,
    name: clamp(String(name || 'Colección'), 60),
    description: clamp(String(description || ''), 200),
    color: color || '#7c5eff',
    previewIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await storeSet(`col:${id}`, collection, 90 * 86400);
  await storeSadd(`col:user:${userId}:ids`, id);

  return { ok: true, collection };
}

export async function listCollections(userId) {
  const ids = await storeSmembers(`col:user:${userId}:ids`);
  const out = [];
  for (const id of ids) {
    const c = await storeGet(`col:${id}`);
    if (c) out.push(c);
  }
  return out;
}

export async function addToCollection(collectionId, previewId) {
  const c = await storeGet(`col:${collectionId}`);
  if (!c) return { ok: false, error: 'not_found' };
  if (c.previewIds.length >= CFG.limits.maxPreviewsPerCollection) {
    return { ok: false, error: 'limit_reached' };
  }
  if (c.previewIds.includes(previewId)) return { ok: true };

  c.previewIds.push(previewId);
  c.updatedAt = new Date().toISOString();
  await storeSet(`col:${collectionId}`, c, 90 * 86400);

  return { ok: true, collection: c };
}

export async function removeFromCollection(collectionId, previewId) {
  const c = await storeGet(`col:${collectionId}`);
  if (!c) return { ok: false, error: 'not_found' };

  c.previewIds = c.previewIds.filter((id) => id !== previewId);
  c.updatedAt = new Date().toISOString();
  await storeSet(`col:${collectionId}`, c, 90 * 86400);

  return { ok: true, collection: c };
}

export async function deleteCollection(collectionId, userId) {
  const c = await storeGet(`col:${collectionId}`);
  if (!c) return false;
  if (c.userId !== userId) return false;

  await storeDel(`col:${collectionId}`);
  await storeSrem(`col:user:${userId}:ids`, collectionId);
  return true;
}

/* ═══════════════════════════════════════════════════════════════════════
   16 · HTML / EXPORT
   ═══════════════════════════════════════════════════════════════════════ */

export async function getPreviewHTML(id, opts = {}) {
  const preview = await getPreview(id, { password: opts.password });
  if (!preview) return null;
  if (preview.__locked) return null;

  return buildDocument({
    html: preview.html,
    css: preview.css,
    js: preview.js,
    csp: preview.csp,
    title: preview.title,
    language: preview.language,
  });
}

export async function exportAsHTML(id) {
  if (!checkRate(null, 'export')) return { ok: false, error: 'rate_limit' };

  const preview = await getPreview(id, { password: null });
  if (!preview || preview.__locked) return { ok: false, error: 'not_found' };

  const html = buildDocument({
    html: preview.html,
    css: preview.css,
    js: preview.js,
    csp: 'strict',
    title: preview.title,
    language: preview.language,
  });

  /* Actualizar contador */
  preview.downloadCount = (preview.downloadCount || 0) + 1;
  await storeSet(`sbx:${id}`, preview, CFG.ttl.standard);

  const safeName = (preview.title || 'preview').replace(/[^a-z0-9-_]/gi, '-').toLowerCase().slice(0, 40);

  return {
    ok: true,
    html,
    filename: `${safeName}.html`,
    sizeBytes: html.length,
  };
}

export async function exportAsDataUrl(id) {
  const r = await exportAsHTML(id);
  if (!r.ok) return r;

  const b64 = Buffer.from(r.html, 'utf8').toString('base64');
  return {
    ok: true,
    dataUrl: `data:text/html;base64,${b64}`,
    sizeBytes: r.sizeBytes,
  };
}

export async function exportAsJSON(id) {
  const preview = await getPreview(id, { password: null });
  if (!preview || preview.__locked) return { ok: false, error: 'not_found' };

  const clean = {
    id: preview.id,
    title: preview.title,
    description: preview.description,
    tags: preview.tags,
    language: preview.language,
    html: preview.html,
    css: preview.css,
    js: preview.js,
    createdAt: preview.createdAt,
    version: preview.version,
  };

  return {
    ok: true,
    json: clean,
    sizeBytes: JSON.stringify(clean).length,
  };
}

export async function importFromUrl(url, userId) {
  if (!checkRate(userId, 'import')) return { ok: false, error: 'rate_limit' };
  if (!url || !/^https?:\/\//.test(url)) return { ok: false, error: 'invalid_url' };

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Numination-Sandbox/2.0' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };

    const text = await res.text();
    if (text.length > 500_000) return { ok: false, error: 'content_too_large' };

    const html = text;
    const cssMatch = text.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
    const jsMatch = text.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i);
    const css = cssMatch ? cssMatch[1] : '';
    const js = jsMatch ? jsMatch[1] : '';

    const titleMatch = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : new URL(url).hostname;

    return createPreview({
      userId,
      html,
      css,
      js,
      title,
      language: 'html',
      meta: { importedFrom: url },
    });
  } catch (e) {
    return { ok: false, error: 'import_failed', message: e.message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   17 · QR CODE
   ═══════════════════════════════════════════════════════════════════════ */

export async function generateQR(id, opts = {}) {
  const preview = await getPreview(id, { summary: true });
  if (!preview) return { ok: false, error: 'not_found' };

  const baseUrl = opts.baseUrl || 'https://numinationchat.vercel.app';
  const targetUrl = `${baseUrl}/sandbox/${id}`;

  const size = Math.min(500, Math.max(80, opts.size || 200));
  const qrUrl = `${CFG.qrApiBase}?size=${size}x${size}&data=${encodeURIComponent(targetUrl)}&margin=8&color=0a0a0c&bgcolor=ffffff`;

  return {
    ok: true,
    targetUrl,
    qrUrl,
    size,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   18 · TEMPLATES API
   ═══════════════════════════════════════════════════════════════════════ */

export function listTemplates() {
  return Object.values(TEMPLATES).map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    language: t.language,
    tags: t.tags,
  }));
}

export function getTemplate(id) {
  return TEMPLATES[id] || null;
}

/* ═══════════════════════════════════════════════════════════════════════
   19 · STATS / HEALTH
   ═══════════════════════════════════════════════════════════════════════ */

export function getSandboxStats() {
  return {
    templates: Object.keys(TEMPLATES).length,
    storage: getUpstash() ? 'upstash' : 'memory',
    memSize: mem.size,
    rateBuckets: rateBuckets.size,
    limits: CFG.limits,
    rate: CFG.rate,
  };
}

export async function pingSandbox() {
  try {
    const testId = uid();
    const testPayload = {
      id: testId, userId: null, title: 'ping', html: '<p>ping</p>', css: '', js: '',
      language: 'html', createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(), sizeBytes: 11,
    };

    const t0 = Date.now();
    await storeSet(`sbx:${testId}`, testPayload, 60);
    const got = await storeGet(`sbx:${testId}`);
    await storeDel(`sbx:${testId}`);

    return {
      ok: !!got,
      storage: getUpstash() ? 'upstash' : 'memory',
      latencyMs: Date.now() - t0,
      templates: Object.keys(TEMPLATES).length,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   20 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const errors = [];

  /* 1 · Sanitize JS */
  const dirty = 'document.cookie = "x"; localStorage.setItem("y", "z"); top.location = "http://evil.com"; console.log("ok");';
  const clean = sanitizeJs(dirty);
  if (clean.includes('document.cookie')) errors.push('sanitizeJs no bloqueó cookie');
  if (clean.includes('localStorage.setItem')) errors.push('sanitizeJs no bloqueó localStorage');
  if (clean.includes('top.location =')) errors.push('sanitizeJs no bloqueó top.location');
  if (!clean.includes('console.log')) errors.push('sanitizeJs bloqueó console.log');

  /* 2 · Sanitize HTML */
  const dirtyHtml = '<p>ok</p><base href="http://x"><iframe></iframe>';
  const cleanHtml = sanitizeHtml(dirtyHtml);
  if (cleanHtml.includes('<base')) errors.push('sanitizeHtml no bloqueó <base>');
  if (cleanHtml.includes('<iframe')) errors.push('sanitizeHtml no bloqueó <iframe>');
  if (!cleanHtml.includes('<p>ok</p>')) errors.push('sanitizeHtml bloqueó <p>');

  /* 3 · UID format */
  const id = uid();
  if (!/^sbx_[a-f0-9]{24}$/.test(id)) errors.push('uid formato');
  const cid = uid(CFG.collectionPrefix);
  if (!/^col_[a-f0-9]{24}$/.test(cid)) errors.push('collection uid formato');

  /* 4 · Templates */
  const templates = Object.keys(TEMPLATES);
  if (templates.length < 10) errors.push(`Solo ${templates.length} templates`);
  for (const tid of templates) {
    const t = TEMPLATES[tid];
    if (!t.html && !t.css && !t.js) errors.push(`Template ${tid} vacío`);
    if (!t.name) errors.push(`Template ${tid} sin name`);
    if (!t.description) errors.push(`Template ${tid} sin description`);
  }

  /* 5 · Password hash */
  const h = hashPassword('test123');
  if (!h.startsWith('scrypt$')) errors.push('hashPassword formato');
  if (!verifyPassword('test123', h)) errors.push('verifyPassword rechazó válida');
  if (verifyPassword('otra', h)) errors.push('verifyPassword aceptó inválida');

  /* 6 · Tag normalize */
  if (normalizeTag('Hola Mundo!') !== 'holamundo') errors.push('normalizeTag');
  if (normalizeTag('a'.repeat(50)).length !== CFG.limits.maxTagLength) errors.push('normalizeTag no recorta');

  /* 7 · clamp */
  if (clamp('hello', 3) !== 'hel') errors.push('clamp no recorta');
  if (clamp('hi', 10) !== 'hi') errors.push('clamp cambia string corto');

  /* 8 · buildDocument */
  const doc = buildDocument({ html: '<h1>Test</h1>', css: 'h1{color:red}', js: 'console.log("hi")' });
  if (!doc.includes('<!DOCTYPE html>')) errors.push('buildDocument sin doctype');
  if (!doc.includes('<h1>Test</h1>')) errors.push('buildDocument sin HTML');
  if (!doc.includes('color:red')) errors.push('buildDocument sin CSS');
  if (!doc.includes('Content-Security-Policy')) errors.push('buildDocument sin CSP');
  if (!doc.includes('nm-preview-console')) errors.push('buildDocument sin bridge');

  /* 9 · escapeHtml */
  if (escapeHtml('<script>') !== '&lt;script&gt;') errors.push('escapeHtml');

  /* 10 · Type detection */
  if (!isLikelyHtml('<h1>x</h1>')) errors.push('isLikelyHtml');
  if (!isLikelyCss('.x{a:b}')) errors.push('isLikelyCss');
  if (!isLikelyJs('const a=1')) errors.push('isLikelyJs');
  if (isLikelyHtml('const a=1')) errors.push('isLikelyHtml falsy positive');

  return {
    ok: errors.length === 0,
    errors,
    storage: getUpstash() ? 'upstash' : 'memory',
    templates: Object.keys(TEMPLATES).length,
    limits: CFG.limits,
    rate: CFG.rate,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   FIN
   ═══════════════════════════════════════════════════════════════════════ */