/* ═══════════════════════════════════════════════════════════════════════════
   
                            ███╗   ██╗██╗   ██╗███╗   ███╗██╗
                            ████╗  ██║██║   ██║████╗ ████║██║
                            ██╔██╗ ██║██║   ██║██╔████╔██║██║
                            ██║╚██╗██║██║   ██║██║╚██╔╝██║██║
                            ██║ ╚████║╚██████╔╝██║ ╚═╝ ██║███████╗
                            ╚═╝  ╚═══╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝
   
                              I N D E X   ·   v 6 . 3
   
   ─────────────────────────────────────────────────────────────────────────
   Punto de entrada del servidor. Monta TODOS los módulos en el orden correcto.
   
   MÓDULOS:
     auth.js         · 15 endpoints de autenticación
     chats.js        · 8 endpoints de chats + streaming SSE
     memories.js     · 14 endpoints de memorias
     skills.js       · 3+ endpoints de skills
     connectors.js   · 15 endpoints de 13 APIs externas
     email.js        · 8 endpoints de email transaccional
   
   ORDEN CRÍTICO:
     1. Middlewares base       → requestId, security, CORS, rate limit, JSON, cookies
     2. Auth                   → attachUser + rutas /api/auth/*
     3. Routers                → chats, memories, skills, connectors, email
     4. Chat streaming         → /api/chat/stream + /api/chat (SSE)
     5. Límites y health       → /api/limits/usage, /api/health, /api/version, /api/ping
     6. Estáticos              → /public
     7. Raíz                   → redirige a /login.html
     8. Catch-all              → 404 JSON para /api/*, HTML para el resto
     9. Error handler          → 500 con requestId
    10. Listen                 → puerto 8080 (excepto en Vercel)
   
   MOTORES DE IA:
     Texto     → Groq → Gemini → Kimi
     Archivos  → Gemini → Kimi → Groq
   ───────────────────────────────────────────────────────────────────────── */

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import OpenAI from 'openai';

/* ─── Servicios internos ─── */
import { streamGroq, streamGemini } from './services/streaming.js';
import { verificarLimite, consultarUso, registrarUso } from './services/limits.js';
import { supabaseDisponible, listarMemories, pingDatabase } from './services/supabase.js';

/* ─── Routers ─── */
import { mountAuthRoutes, attachUser, requireAuth } from './auth.js';
import { mountChatRoutes } from './chats.js';
import { mountMemoryRoutes } from './memories.js';
import { mountSkillsRoutes } from './skills.js';
import { mountConnectorRoutes } from './connectors.js';
import { mountEmailRoutes } from './email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const VERSION = '6.3.0';

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const IS_PROD = process.env.NODE_ENV === 'production';
const IS_VERCEL = process.env.VERCEL === '1';
const PORT = parseInt(process.env.PORT || '8080', 10);

const CFG = Object.freeze({
  maxMsgLen: 8000,
  jsonLimit: '15mb',
  geminiCooldownMs: 60_000,
  geminiSoftCooldownMs: 15_000,
  rateLimitIPWindow: 60_000,
  rateLimitIPMax: 240,
  retryAttempts: 6,
  retryBaseDelayMs: 900,
  sseHeartbeatMs: 15_000,
  sseMaxDurationMs: 120_000,
  memCacheTtlMs: 30_000,
  memCacheMax: 200,
  keepAliveTimeout: 65_000,
  headersTimeout: 66_000,
  shutdownTimeout: 10_000,
});

/* ═══════════════════════════════════════════════════════════════════════════
   LOGGER
   ═══════════════════════════════════════════════════════════════════════════ */

const LVL = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LVL = LVL[(process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug')).toLowerCase()] || LVL.info;

function fmt(v) {
  if (v == null) return String(v);
  if (typeof v === 'string') return v;
  if (v instanceof Error) return v.message;
  try { return JSON.stringify(v); } catch { return String(v); }
}

const LOG = {
  debug: (m, ...a) => MIN_LVL <= LVL.debug && console.log(`🔍 ${m}`, ...a.map(fmt)),
  info:  (m, ...a) => MIN_LVL <= LVL.info  && console.log(`ℹ️  ${m}`, ...a.map(fmt)),
  ok:    (m, ...a) => MIN_LVL <= LVL.info  && console.log(`✅ ${m}`, ...a.map(fmt)),
  warn:  (m, ...a) => MIN_LVL <= LVL.warn  && console.warn(`⚠️  ${m}`, ...a.map(fmt)),
  error: (m, ...a) => MIN_LVL <= LVL.error && console.error(`❌ ${m}`, ...a.map(fmt)),
};

/* ═══════════════════════════════════════════════════════════════════════════
   API KEYS
   ═══════════════════════════════════════════════════════════════════════════ */

let TEST_KEYS = {};
try {
  const mod = await import('../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

const KEYS = Object.freeze({
  GROQ: process.env.GROQ_API_KEY     ?? TEST_KEYS.GROQ_API_KEY,
  NV:   process.env.NVIDIA_API_KEY   ?? TEST_KEYS.NVIDIA_API_KEY,
  GM1:  process.env.GEMINI_API_KEY   ?? TEST_KEYS.GEMINI_API_KEY,
  GM2:  process.env.GEMINI_API_KEY_2 ?? TEST_KEYS.GEMINI_API_KEY_2,
  GM3:  process.env.GEMINI_API_KEY_3 ?? TEST_KEYS.GEMINI_API_KEY_3,
});

/* ═══════════════════════════════════════════════════════════════════════════
   GEMINI POOL · 3 keys con cooldown independiente
   ═══════════════════════════════════════════════════════════════════════════ */

const geminiPool = [KEYS.GM1, KEYS.GM2, KEYS.GM3]
  .filter(Boolean)
  .map((apiKey, i) => ({
    id: i + 1,
    client: new GoogleGenAI({ apiKey }),
    cooldownUntil: 0,
    requests: 0,
    errors: 0,
  }));

const geminiAvailable = () => geminiPool.filter((e) => e.cooldownUntil <= Date.now());

function geminiCooldown(entry, ms = CFG.geminiCooldownMs) {
  entry.cooldownUntil = Date.now() + ms;
  entry.errors++;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CLIENTES IA
   ═══════════════════════════════════════════════════════════════════════════ */

const groq = KEYS.GROQ
  ? new Groq({ apiKey: KEYS.GROQ })
  : null;

const nvidia = KEYS.NV
  ? new OpenAI({
      apiKey: KEYS.NV,
      baseURL: 'https://integrate.api.nvidia.com/v1',
    })
  : null;

/* ═══════════════════════════════════════════════════════════════════════════
   UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function short(t, n = 120) {
  if (!t) return '';
  const s = String(t);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function isRateLimit(err) {
  const msg = String(err?.message || '').toLowerCase();
  const st = err?.status ?? err?.code ?? 0;
  return st === 429 || st === 503 ||
    msg.includes('429') || msg.includes('503') ||
    msg.includes('quota') || msg.includes('rate limit') || msg.includes('overloaded');
}

/* ═══════════════════════════════════════════════════════════════════════════
   SEGURIDAD · prompt injection guard
   ═══════════════════════════════════════════════════════════════════════════ */

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|prior)\s+rules?/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /\[system\]/i,
  /\[INST\]/i,
];

function isInjection(message) {
  if (!message) return false;
  const t = String(message);
  return INJECTION_PATTERNS.some((p) => p.test(t));
}

/* ═══════════════════════════════════════════════════════════════════════════
   RATE LIMITER IP
   ═══════════════════════════════════════════════════════════════════════════ */

const ipBuckets = new Map();

function checkIP(ip) {
  const now = Date.now();
  let b = ipBuckets.get(ip);
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + CFG.rateLimitIPWindow };
    ipBuckets.set(ip, b);
  }
  b.count++;
  return { allowed: b.count <= CFG.rateLimitIPMax, reset: b.reset };
}

const _ipCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of ipBuckets) if (b.reset < now) ipBuckets.delete(ip);
}, 5 * 60_000);
if (_ipCleanup.unref) _ipCleanup.unref();

/* ═══════════════════════════════════════════════════════════════════════════
   SYSTEM PROMPTS
   ═══════════════════════════════════════════════════════════════════════════ */

const NUMINATION_BASE = `
# IDENTIDAD

Eres Numination, una IA educativa colombiana. Fuiste creada por Álvaro García Gómez y Robinson Rodríguez Gómez, dos estudiantes colombianos.

NO eres ChatGPT, Gemini ni ninguna IA genérica. Eres Numination.
Eslogan: "La IA que habla el idioma de nuestra educación."
Modelo: Numi-OT.01

# CONTEXTO COLOMBIA

Cuando uses ejemplos, apóyate en:
- Ciudades: Bogotá, Medellín, Cali, Barranquilla, Cartagena, Bucaramanga, Pereira, Manizales
- Ríos: Magdalena, Cauca, Amazonas, Orinoco, Atrato, Meta
- Regiones: Andina, Caribe, Pacífica, Orinoquía, Amazonía, Insular
- Comida: ajiaco, bandeja paisa, arepas, sancocho, tamales, lechona, mute
- Cultura: cumbia, vallenato, bambuco, porro, Carnaval de Barranquilla, Feria de las Flores
- Historia: Independencia, Batalla de Boyacá, Constitución de 1991, Gaitán, La Violencia
- Deporte: ciclismo (Nairo, Egan), atletismo (Caterine), fútbol (Selección)
- Moneda: pesos colombianos (COP)
- Geografía: nevados, páramos, valles, altiplanos, llanos orientales

# ESTILO (REGLAS DURAS)

- Respuestas normales: MÁXIMO 3 párrafos cortos.
- Temas complejos: usa listas o pasos numerados.
- NUNCA repitas la pregunta al empezar.
- NUNCA hagas introducciones tipo "¡Claro! Excelente pregunta".
- Usa **negrita** solo para términos clave (máximo 3 por respuesta).
- CERO emojis. Solo texto plano.
- Tono directo, claro, sin relleno. Tutea.
- Si comete un error, di "revisemos juntos ese paso".

# REGLAS PEDAGÓGICAS

- NUNCA hagas la tarea por el estudiante. Guíalo.
- Si te pide "resuélveme esto", responde con preguntas que lo lleven a la respuesta.
- Verifica comprensión antes de avanzar.
- Violencia o abuso: ICBF 141, Línea 106.
- Tu rol NO es terapéutico.

# REGLAS ABSOLUTAS

- Contextualiza TODO a Colombia.
- NUNCA sustituyas atención médica, psicológica o legal.
- NUNCA uses ejemplos con dólares, Halloween o nieve.
`.trim();

const ROLE_HINT = {
  student:   'Eres un tutor amable y claro para estudiantes colombianos. Explica paso a paso, usa ejemplos sencillos y adapta el lenguaje al nivel del estudiante.',
  teacher:   'Eres un asistente pedagógico para docentes colombianos. Ayuda a diseñar actividades, evaluaciones y explicaciones aplicables al aula.',
  reasoning: 'Eres Numi-OT.01 en MODO RAZONAMIENTO. Piensas paso a paso, con rigor, antes de responder. Ayudas a razonar, no resuelves.',
  coder:     'Eres un asistente técnico especializado en programación. Explicas código, corriges bugs, sugieres mejoras.',
};

const REASONING_PREFIX = `INSTRUCCIÓN — MODO RAZONAMIENTO:

Piensa paso a paso ANTES de responder. Todo tu proceso mental DEBE ir envuelto entre <thinking> y </thinking>. Después del cierre, escribe la respuesta final limpia y directa.

Formato:
<thinking>
1. Primero identifico...
2. Luego considero...
3. Finalmente concluyo...
</thinking>

[Respuesta final aquí, sin repetir el razonamiento]

PREGUNTA:
`;

function buildSystemPrompt(role = 'student', memories = []) {
  const hint = ROLE_HINT[role] || ROLE_HINT.student;
  let p = NUMINATION_BASE + '\n\n' + hint;

  if (memories.length > 0) {
    const list = memories.slice(0, 20).map((m) => `- ${m.text}`).join('\n');
    p += '\n\n# LO QUE RECUERDAS DEL USUARIO\n\n' + list;
  }
  return p;
}

function buildFinalMessage(message, isReasoning) {
  return isReasoning ? REASONING_PREFIX + (message || '') : (message || '');
}

/* ═══════════════════════════════════════════════════════════════════════════
   IMÁGENES · Pollinations
   ═══════════════════════════════════════════════════════════════════════════ */

function buildImageUrl(prompt, opts = {}) {
  const {
    width = 1024,
    height = 1024,
    model = 'flux',
    seed = Math.floor(Math.random() * 1e6),
  } = opts;
  const enc = encodeURIComponent(prompt.trim().slice(0, 500));
  return `https://image.pollinations.ai/prompt/${enc}?width=${width}&height=${height}&model=${model}&seed=${seed}&nologo=true&enhance=true`;
}

const IMG_TRIGGERS = [
  /^genera(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
  /^crea(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
  /^haz(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
  /^dibuja(me)?\s+/i,
  /^ilustra(me)?\s+/i,
  /^quiero\s+ver\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
];

const isImageRequest = (m) => m && IMG_TRIGGERS.some((r) => r.test(m.trim()));

function extractImagePrompt(m) {
  return String(m)
    .replace(/^(genera(me)?|crea(me)?|haz(me)?)\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i, '')
    .replace(/^dibuja(me)?\s+/i, '')
    .replace(/^ilustra(me)?\s+/i, '')
    .replace(/^quiero\s+ver\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i, '')
    .trim();
}

function enrichColombia(prompt) {
  if (/colombia|colombiano|colombiana|café|cumbia|vallenato|magdalena|cóndor|arepa|barranquilla|medellín|bogotá/i.test(prompt)) {
    return prompt + ', Colombia, vibrant colors, golden hour lighting, highly detailed, cinematic';
  }
  return prompt + ', warm colors, artistic style, high quality, detailed';
}

/* ═══════════════════════════════════════════════════════════════════════════
   LLAMADAS A MOTORES (no streaming)
   ═══════════════════════════════════════════════════════════════════════════ */

async function callGroq(systemPrompt, message, file) {
  if (!groq) throw new Error('Groq no configurado');
  const note = file?.data ? '\n\n[El usuario adjuntó un archivo.]' : '';
  const r = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: (message || '(sin texto)') + note },
    ],
    temperature: 0.7,
    max_tokens: 2048,
  });
  return r.choices?.[0]?.message?.content ?? '';
}

async function callGemini(systemPrompt, message, file) {
  const first = geminiPool[0];
  if (!first) throw new Error('Gemini no configurado');

  const parts = [{ text: message || '(analiza el archivo adjunto)' }];
  if (file?.data) {
    parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
  }

  first.requests++;
  const r = await first.client.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: systemPrompt,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  return r.text ?? '';
}

async function callNvidia(systemPrompt, message, file) {
  if (!nvidia) throw new Error('NVIDIA no configurado');
  const messages = [{ role: 'system', content: systemPrompt }];
  const isImg = file?.data && file.mimeType?.startsWith('image/');

  if (isImg) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: message || 'Analiza esta imagen.' },
        { type: 'image_url', image_url: { url: `data:${file.mimeType};base64,${file.data}` } },
      ],
    });
  } else {
    messages.push({ role: 'user', content: (message || '(sin texto)') });
  }

  const r = await nvidia.chat.completions.create({
    model: 'moonshotai/kimi-k3',
    messages,
    temperature: 0.7,
    max_tokens: 2048,
  });
  return r.choices?.[0]?.message?.content ?? '';
}

const CALLERS = { groq: callGroq, gemini: callGemini, nvidia: callNvidia };
const NAMES = { groq: 'Groq', gemini: 'Gemini', nvidia: 'Kimi K3' };

const orderMotors = (file) => file?.data
  ? ['gemini', 'nvidia', 'groq']
  : ['groq', 'gemini', 'nvidia'];

/* ═══════════════════════════════════════════════════════════════════════════
   MEMORIAS · caché con TTL
   ═══════════════════════════════════════════════════════════════════════════ */

const memCache = new Map();

async function loadMemories(req) {
  if (!req.user?.id) return [];
  const key = req.user.id;
  const cached = memCache.get(key);

  if (cached && Date.now() - cached.t < CFG.memCacheTtlMs) {
    return cached.v;
  }

  try {
    const list = await listarMemories(req.user.id);

    if (memCache.size >= CFG.memCacheMax) {
      const oldestKey = memCache.keys().next().value;
      memCache.delete(oldestKey);
    }
    memCache.set(key, { v: list, t: Date.now() });
    return list;
  } catch (e) {
    LOG.warn('memorias:', e.message);
    return [];
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   SSE HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function setupSSE(req, res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  if (res.socket?.setNoDelay) {
    try { res.socket.setNoDelay(true); } catch {}
  }

  let closed = false;
  const startedAt = Date.now();

  res.on('close', () => { closed = true; });
  res.on('error', () => { closed = true; });

  const send = (data) => {
    if (closed) return false;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch {
      closed = true;
      return false;
    }
  };

  const heartbeat = setInterval(() => {
    if (closed) return;
    if (Date.now() - startedAt > CFG.sseMaxDurationMs) {
      send({ error: 'Timeout', done: true });
      clearInterval(heartbeat);
      try { res.end(); } catch {}
      closed = true;
      return;
    }
    try { res.write(': ping\n\n'); } catch { closed = true; }
  }, CFG.sseHeartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  const close = () => {
    clearInterval(heartbeat);
    if (!closed) {
      try { res.end(); } catch {}
      closed = true;
    }
  };

  return { send, close, isClosed: () => closed, elapsed: () => Date.now() - startedAt };
}

/* ═══════════════════════════════════════════════════════════════════════════
   APP EXPRESS
   ═══════════════════════════════════════════════════════════════════════════ */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ─── Request ID ─── */
app.use((req, res, next) => {
  req.id = crypto.randomBytes(4).toString('hex');
  req._t0 = Date.now();
  res.setHeader('X-Request-Id', req.id);
  next();
});

/* ─── Security headers ─── */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/* ─── CORS ─── */
app.use((req, res, next) => {
  const origin = req.get('origin');
  const allowed = [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'https://numination.app',
    'https://www.numination.app',
    'https://numinationchat.vercel.app',
  ];
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/* ─── Rate limit IP ─── */
app.use((req, res, next) => {
  if (/^\/assets\//.test(req.path) || /\.(js|css|png|jpg|svg|woff2?|ico)$/i.test(req.path)) {
    return next();
  }
  const { allowed, reset } = checkIP(req.ip);
  if (!allowed) {
    res.setHeader('Retry-After', String(Math.ceil((reset - Date.now()) / 1000)));
    return res.status(429).json({
      ok: false,
      error: 'Demasiadas peticiones. Espera un minuto.',
      code: 'ip_rate_limit',
    });
  }
  next();
});

/* ─── Body + cookies ─── */
app.use(express.json({ limit: CFG.jsonLimit }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());

/* ─── Auth attachUser ─── */
app.use(attachUser);

/* ─── Proteger /chat.html ─── */
app.use((req, res, next) => {
  if (req.path === '/chat.html' && !req.user) return res.redirect('/login.html');
  next();
});

/* ─── Static files ─── */
app.use(express.static(publicDir, {
  index: false,
  maxAge: IS_PROD ? '1h' : 0,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

/* ─── Raíz → login ─── */
app.get('/', (req, res) => res.redirect('/login.html'));

/* ═══════════════════════════════════════════════════════════════════════════
   ROUTERS (TODOS antes del catch-all)
   ═══════════════════════════════════════════════════════════════════════════ */

mountAuthRoutes(app);
mountChatRoutes(app, requireAuth);
mountMemoryRoutes(app, requireAuth);
mountSkillsRoutes(app, requireAuth);
mountConnectorRoutes(app, requireAuth);
mountEmailRoutes(app, requireAuth);

/* ═══════════════════════════════════════════════════════════════════════════
   LÍMITES
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/limits/usage', async (req, res) => {
  try {
    const uso = await consultarUso(req);
    if (!uso) return res.json({ ok: false, error: 'Límites no configurados' });
    return res.json({ ok: true, ...uso });
  } catch (e) {
    LOG.error('limits/usage:', e.message);
    return res.status(500).json({ ok: false, error: 'Error consultando uso' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   HEALTH · VERSION · PING
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/health', async (req, res) => {
  const mem = process.memoryUsage();
  const dbPing = await pingDatabase().catch(() => ({ ok: false }));

  return res.json({
    ok: true,
    service: 'numination',
    version: VERSION,
    codename: 'Numi-OT.01',
    env: process.env.NODE_ENV || 'development',
    uptime: Math.floor(process.uptime()),
    priority: {
      text: ['groq', 'gemini', 'nvidia'],
      files: ['gemini', 'nvidia', 'groq'],
    },
    keys: {
      groq: Boolean(KEYS.GROQ),
      gemini_1: Boolean(KEYS.GM1),
      gemini_2: Boolean(KEYS.GM2),
      gemini_3: Boolean(KEYS.GM3),
      nvidia: Boolean(KEYS.NV),
    },
    geminiPool: geminiPool.map((e) => ({
      id: e.id,
      cooldown: e.cooldownUntil > Date.now(),
      requests: e.requests,
      errors: e.errors,
    })),
    database: { connected: supabaseDisponible(), ping: dbPing },
    auth: {
      session: Boolean(req.user),
      email: req.user?.email || null,
    },
    runtime: {
      node: process.version,
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024) + ' MB',
        heap: Math.round(mem.heapUsed / 1024 / 1024) + ' MB',
      },
    },
    ts: new Date().toISOString(),
  });
});

app.get('/api/version', (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    name: 'Numination',
    codename: 'Numi-OT.01',
    env: process.env.NODE_ENV || 'development',
  });
});

app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, pong: Date.now() });
});

/* ═══════════════════════════════════════════════════════════════════════════
   CHAT STREAMING · SSE
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/chat/stream', async (req, res) => {
  const t0 = Date.now();

  try {
    /* ─── Límite ─── */
    const lim = await verificarLimite(req);
    if (!lim.permitido) {
      if (lim.retryAfter) res.setHeader('Retry-After', String(lim.retryAfter));
      return res.status(429).json({
        ok: false,
        error: lim.mensaje,
        razon: lim.razon,
        retryAfter: lim.retryAfter,
        plan: lim.plan,
        uso: lim.uso,
        limites: lim.limites,
      });
    }

    const { message, role = 'student', file = null, incognito = false } = req.body ?? {};

    const hasText = message && String(message).trim();
    const hasFile = file?.data;

    if (!hasText && !hasFile) {
      return res.status(400).json({ ok: false, error: 'Falta el mensaje o archivo' });
    }

    if (hasText && String(message).length > CFG.maxMsgLen) {
      return res.status(400).json({
        ok: false,
        error: `Mensaje muy largo (máx ${CFG.maxMsgLen} caracteres)`,
      });
    }

    /* ─── Injection guard ─── */
    if (hasText && isInjection(message)) {
      LOG.warn(`[${req.id}] Injection bloqueado`);
      return res.status(403).json({
        ok: false,
        error: 'No puedo procesar esa instrucción. Reformúlala como una pregunta educativa.',
        code: 'PROMPT_INJECTION_BLOCKED',
      });
    }

    const isReasoning = role === 'reasoning';
    const effectiveRole = isReasoning ? 'reasoning' : role;
    const finalMessage = buildFinalMessage(message, isReasoning);

    /* ─── Memorias ─── */
    const memories = incognito ? [] : await loadMemories(req);
    const systemPrompt = buildSystemPrompt(effectiveRole, memories);

    LOG.debug(
      `[${req.id}] stream · ${effectiveRole}${incognito ? ' · incognito' : ''} · mem=${memories.length} · file=${hasFile ? 'sí' : 'no'}`
    );

    /* ─── SSE ─── */
    const sse = setupSSE(req, res);

    sse.send({
      meta: {
        plan: lim.plan,
        restanteDia: lim.restanteDia,
        restanteMin: lim.restanteMin,
        mode: effectiveRole,
        memories: memories.length,
        incognito,
        requestId: req.id,
        version: VERSION,
      },
    });

    let responded = false;
    let tokens = 0;

    /* ═══ Iteración por motores ═══ */
    for (const prov of orderMotors(file)) {
      if (sse.isClosed()) break;

      /* ─────── GEMINI ─────── */
      if (prov === 'gemini') {
        const candidates = geminiAvailable();
        if (!candidates.length) {
          LOG.debug(`[${req.id}] Gemini: todas las keys en cooldown`);
          continue;
        }

        let ok = false;
        for (const entry of candidates) {
          if (sse.isClosed()) break;
          try {
            LOG.debug(`[${req.id}] Gemini #${entry.id} streaming...`);
            let local = 0;
            entry.requests++;

            for await (const token of streamGemini(
              entry.client,
              systemPrompt,
              finalMessage,
              file,
              { reasoning: isReasoning }
            )) {
              if (sse.isClosed()) break;
              sse.send({ token, done: false });
              responded = true;
              tokens++;
              local++;
            }

            if (local > 0) {
              sse.send({ token: '', done: true, provider: `gemini-${entry.id}` });
              ok = true;
              break;
            }
            throw new Error('Gemini no devolvió tokens');
          } catch (err) {
            LOG.warn(`[${req.id}] Gemini #${entry.id} falló: ${short(err.message, 100)}`);
            if (isRateLimit(err) && !responded) {
              geminiCooldown(entry);
              continue;
            }
            if (responded) {
              sse.send({ token: '', done: true, provider: `gemini-${entry.id}`, partial: true });
              ok = true;
              break;
            }
            geminiCooldown(entry, CFG.geminiSoftCooldownMs);
          }
        }

        if (ok) {
          finishSSE(sse, req, incognito, t0, tokens, 'gemini');
          return;
        }
      }

      /* ─────── GROQ ─────── */
      else if (prov === 'groq') {
        try {
          LOG.debug(`[${req.id}] Groq streaming...`);
          let local = 0;

          for await (const token of streamGroq(
            groq,
            systemPrompt,
            finalMessage,
            file,
            { reasoning: isReasoning }
          )) {
            if (sse.isClosed()) break;
            sse.send({ token, done: false });
            responded = true;
            tokens++;
            local++;
          }

          if (local > 0) {
            sse.send({ token: '', done: true, provider: 'groq' });
            finishSSE(sse, req, incognito, t0, tokens, 'groq');
            return;
          }
          throw new Error('Groq no devolvió tokens');
        } catch (err) {
          LOG.warn(`[${req.id}] Groq falló: ${short(err.message, 100)}`);
          if (responded) {
            sse.send({ token: '', done: true, provider: 'groq', partial: true });
            finishSSE(sse, req, incognito, t0, tokens, 'groq');
            return;
          }
        }
      }

      /* ─────── NVIDIA / KIMI ─────── */
      else if (prov === 'nvidia') {
        try {
          LOG.debug(`[${req.id}] Kimi K3 sin streaming`);
          const reply = await callNvidia(systemPrompt, finalMessage, file);

          if (reply && reply.trim()) {
            sse.send({ token: reply, done: false });
            sse.send({ token: '', done: true, provider: 'nvidia', noStream: true });
            finishSSE(sse, req, incognito, t0, Math.ceil(reply.length / 4), 'nvidia');
            return;
          }
          throw new Error('Respuesta vacía');
        } catch (err) {
          LOG.warn(`[${req.id}] Kimi K3 falló: ${short(err.message, 100)}`);
        }
      }
    }

    /* ─── Todos fallaron ─── */
    if (!responded && !sse.isClosed()) {
      LOG.error(`[${req.id}] Todos los motores fallaron`);
      sse.send({
        error: 'Los motores de IA están saturados. Intenta de nuevo en unos segundos.',
        done: true,
      });
      sse.close();
    }
  } catch (err) {
    LOG.error(`[${req.id}] Error en stream: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'Error interno del servidor' });
    }
  }
});

function finishSSE(sse, req, incognito, t0, tokens, provider) {
  const dur = Date.now() - t0;
  if (!incognito) registrarUso(req).catch(() => {});
  setImmediate(() => {
    sse.close();
    LOG.debug(`[${req.id}] Stream cerrado en ${dur}ms · ~${tokens} tokens · ${provider}`);
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   CHAT NORMAL · sin streaming
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/chat', async (req, res) => {
  const t0 = Date.now();

  try {
    const lim = await verificarLimite(req);
    if (!lim.permitido) {
      if (lim.retryAfter) res.setHeader('Retry-After', String(lim.retryAfter));
      return res.status(429).json({
        ok: false,
        error: lim.mensaje,
        razon: lim.razon,
        retryAfter: lim.retryAfter,
        plan: lim.plan,
        uso: lim.uso,
        limites: lim.limites,
      });
    }

    const { message, role = 'student', file = null, incognito = false } = req.body ?? {};
    const hasText = message && String(message).trim();
    const hasFile = file?.data;

    if (!hasText && !hasFile) {
      return res.status(400).json({ ok: false, error: 'Falta el mensaje o archivo' });
    }
    if (hasText && String(message).length > CFG.maxMsgLen) {
      return res.status(400).json({ ok: false, error: 'Mensaje muy largo' });
    }
    if (hasText && isInjection(message)) {
      return res.status(403).json({
        ok: false,
        error: 'No puedo procesar esa instrucción.',
        code: 'PROMPT_INJECTION_BLOCKED',
      });
    }

    const isReasoning = role === 'reasoning';
    const effectiveRole = isReasoning ? 'reasoning' : role;
    const finalMessage = buildFinalMessage(message, isReasoning);

    /* ─── Imagen ─── */
    if (hasText && !hasFile && !isReasoning && isImageRequest(message)) {
      const imgPrompt = extractImagePrompt(message);
      if (imgPrompt.length > 3) {
        LOG.info(`[${req.id}] Imagen: "${short(imgPrompt, 60)}"`);
        const imageUrl = buildImageUrl(enrichColombia(imgPrompt));
        if (!incognito) registrarUso(req).catch(() => {});
        return res.json({
          ok: true,
          reply: `Listo, aquí está tu imagen de: **${imgPrompt}**\n\nSi quieres otra versión, pídeme "otra imagen de..." y crearé una variación.`,
          imageUrl,
          imagePrompt: imgPrompt,
          type: 'image',
        });
      }
    }

    /* ─── Memorias + prompt ─── */
    const memories = incognito ? [] : await loadMemories(req);
    const systemPrompt = buildSystemPrompt(effectiveRole, memories);
    const order = orderMotors(file);

    /* ─── Intentos ─── */
    const attempts = [order[0], order[0], order[1], order[2], order[1], order[2]];

    for (let i = 0; i < attempts.length; i++) {
      const prov = attempts[i];
      if (i > 0) await sleep(CFG.retryBaseDelayMs);

      try {
        LOG.debug(`[${req.id}] Intento ${i + 1}/${attempts.length} · ${NAMES[prov]}`);
        const reply = await CALLERS[prov](systemPrompt, finalMessage, file);

        if (reply && reply.trim()) {
          const dur = Date.now() - t0;
          LOG.ok(`[${req.id}] ${NAMES[prov]} respondió en ${dur}ms`);
          if (!incognito) registrarUso(req).catch(() => {});
          return res.json({
            ok: true,
            reply,
            provider: prov,
            mode: effectiveRole,
            durationMs: dur,
          });
        }
        throw new Error('Respuesta vacía');
      } catch (err) {
        LOG.warn(`[${req.id}] ${NAMES[prov]} falló: ${short(err.message, 100)}`);
        if (!isRateLimit(err)) break;
      }
    }

    LOG.error(`[${req.id}] Todos los intentos fallaron`);
    return res.status(503).json({
      ok: false,
      error: 'Los motores de IA están saturados. Espera unos segundos e intenta de nuevo.',
    });
  } catch (err) {
    LOG.error(`[${req.id}] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   CATCH-ALL
   ═══════════════════════════════════════════════════════════════════════════ */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({
      ok: false,
      error: 'Endpoint no encontrado: ' + req.path,
      code: 'endpoint_not_found',
    });
  }
  if (path.extname(req.path)) {
    return res.status(404).json({
      ok: false,
      error: 'Archivo no encontrado: ' + req.path,
      code: 'file_not_found',
    });
  }
  const page404 = path.join(publicDir, '404.html');
  if (fs.existsSync(page404)) {
    return res.status(404).sendFile(page404);
  }
  res.redirect('/login.html');
});

/* ═══════════════════════════════════════════════════════════════════════════
   ERROR HANDLER
   ═══════════════════════════════════════════════════════════════════════════ */

app.use((err, req, res, _next) => {
  if (err?.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    LOG.warn(`[${req.id}] JSON inválido: ${err.message}`);
    if (!res.headersSent) {
      return res.status(400).json({ ok: false, error: 'JSON inválido', code: 'invalid_json' });
    }
    return;
  }

  if (err?.type === 'entity.too.large') {
    if (!res.headersSent) {
      return res.status(413).json({ ok: false, error: 'Payload demasiado grande', code: 'payload_too_large' });
    }
    return;
  }

  LOG.error(`[${req.id}] Error no manejado: ${err.message}`);
  if (!IS_PROD) LOG.error(err.stack);

  if (!res.headersSent) {
    res.status(500).json({
      ok: false,
      error: 'Error interno del servidor',
      requestId: req.id,
    });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ARRANQUE + SHUTDOWN
   ═══════════════════════════════════════════════════════════════════════════ */

let server = null;

function banner() {
  const dbOn = supabaseDisponible();
  const gCount = geminiPool.length;

  console.log('');
  console.log('  ╭───────────────────────────────────────────────────╮');
  console.log(`  │  🇨🇴  NUMINATION · v${VERSION.padEnd(24)} │`);
  console.log('  │  Numi-OT.01                                       │');
  console.log('  ╰───────────────────────────────────────────────────╯');
  console.log('');
  console.log(`  🚀  http://localhost:${PORT}`);
  console.log('');
  console.log('  📋  PRIORIDAD DE MOTORES');
  console.log('      Texto    → Groq → Gemini → Kimi');
  console.log('      Archivos → Gemini → Kimi → Groq');
  console.log('');
  console.log(`  🔑  Groq:         ${groq ? '✓' : '✗'}`);
  console.log(`  🔑  Gemini keys:  ${gCount}/3 ${gCount > 0 ? '✓' : '✗'}`);
  console.log(`  🔑  Kimi:         ${nvidia ? '✓' : '✗'}`);
  console.log('');
  console.log(`  🎨  Imágenes:     Pollinations`);
  console.log(`  🧠  Modos:        chat · coder · reasoning`);
  console.log(`  💾  Memorias:     ${dbOn ? 'activas' : 'sin DB'}`);
  console.log(`  🔌  Conectores:   13 APIs`);
  console.log(`  📧  Email:        configurable`);
  console.log(`  🔐  Auth:         Google + GitHub`);
  console.log('');
  console.log('  📡  MÓDULOS');
  console.log('      /api/auth/*         · 15 endpoints');
  console.log('      /api/chats          · conversaciones');
  console.log('      /api/chat/stream    · streaming SSE');
  console.log('      /api/memories/*     · 14 endpoints');
  console.log('      /api/skills         · habilidades');
  console.log('      /api/connectors/*   · 15 endpoints');
  console.log('      /api/email/*        · 8 endpoints');
  console.log('      /api/health         · estado del server');
  console.log('');
  console.log('  💡 Ctrl+C para detener');
  console.log('');
}

if (!IS_VERCEL) {
  server = app.listen(PORT, () => banner());
  server.keepAliveTimeout = CFG.keepAliveTimeout;
  server.headersTimeout = CFG.headersTimeout;
}

function shutdown(signal) {
  LOG.warn(`Recibido ${signal}. Cerrando...`);
  if (!server) return process.exit(0);

  server.close(() => {
    LOG.ok('Servidor cerrado limpiamente');
    process.exit(0);
  });

  setTimeout(() => {
    LOG.error('Forzando salida por timeout');
    process.exit(1);
  }, CFG.shutdownTimeout).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  LOG.error('Uncaught:', err.message);
  if (!IS_PROD) {
    LOG.error(err.stack);
    return;
  }
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  LOG.error('Unhandled rejection:', String(reason));
});

/* ═══════════════════════════════════════════════════════════════════════════
   EXPORT (para Vercel)
   ═══════════════════════════════════════════════════════════════════════════ */

export default app;