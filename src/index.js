/* ══════════════════════════════════════════════════════════════
   NUMINATION — Backend v3.3
   ----------------------------------------------------------------
   Chat IA con routing inteligente por tipo de contenido.
   Texto    → Groq (2-3s) → Gemini → Kimi K3
   Archivos → Gemini (multimodal) → Kimi K3 → Groq
   Modos: chat · coder · reasoning
   Memorias: inyectadas al system prompt
   Auth: Google OAuth + GitHub + JWT sobre Supabase
   DB: Supabase (Postgres)
   Límites: Upstash Redis
   Imágenes: Pollinations
   Express 5.x compatible
   ══════════════════════════════════════════════════════════════ */

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import OpenAI from 'openai';

import { streamGroq, streamGemini } from './services/streaming.js';
import { mountAuthRoutes, attachUser, requireAuth } from './auth.js';
import { mountChatRoutes } from './chats.js';
import { mountMemoryRoutes } from './memories.js';
import { verificarLimite, consultarUso, registrarUso } from './services/limits.js';
import {
  supabaseDisponible,
  listarMemories,
} from './services/supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

/* ══════════════════════════════════════════════════════════════
   LOGGER con niveles
   ══════════════════════════════════════════════════════════════ */

const LOG = {
  info:  (msg, ...args) => console.log(`ℹ️  ${msg}`, ...args),
  ok:    (msg, ...args) => console.log(`✅ ${msg}`, ...args),
  warn:  (msg, ...args) => console.warn(`⚠️  ${msg}`, ...args),
  error: (msg, ...args) => console.error(`❌ ${msg}`, ...args),
  debug: (msg, ...args) => {
    if (process.env.DEBUG === '1') console.log(`🔍 ${msg}`, ...args);
  },
};

/* ══════════════════════════════════════════════════════════════
   API KEYS
   ══════════════════════════════════════════════════════════════ */

let TEST_KEYS = {};
try {
  const mod = await import('../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

const KEYS = {
  GEMINI_API_KEY:   process.env.GEMINI_API_KEY   ?? TEST_KEYS.GEMINI_API_KEY,
  GEMINI_API_KEY_2: process.env.GEMINI_API_KEY_2 ?? TEST_KEYS.GEMINI_API_KEY_2,
  GEMINI_API_KEY_3: process.env.GEMINI_API_KEY_3 ?? TEST_KEYS.GEMINI_API_KEY_3,
  NVIDIA_API_KEY:   process.env.NVIDIA_API_KEY   ?? TEST_KEYS.NVIDIA_API_KEY,
  GROQ_API_KEY:     process.env.GROQ_API_KEY     ?? TEST_KEYS.GROQ_API_KEY,
};

if (!KEYS.GEMINI_API_KEY && !KEYS.GEMINI_API_KEY_2 && !KEYS.GEMINI_API_KEY_3) {
  LOG.warn('Ninguna GEMINI_API_KEY configurada');
}
if (!KEYS.NVIDIA_API_KEY) LOG.warn('NVIDIA_API_KEY no configurada');
if (!KEYS.GROQ_API_KEY)   LOG.warn('GROQ_API_KEY no configurada');

/* ══════════════════════════════════════════════════════════════
   POOL DE GEMINI (con rotación y cooldown)
   ══════════════════════════════════════════════════════════════ */

const GEMINI_KEY_LIST = [
  KEYS.GEMINI_API_KEY,
  KEYS.GEMINI_API_KEY_2,
  KEYS.GEMINI_API_KEY_3,
].filter(Boolean);

const geminiPool = GEMINI_KEY_LIST.map((apiKey, i) => ({
  id: i + 1,
  key: apiKey,
  client: new GoogleGenAI({ apiKey }),
  cooldownUntil: 0,
}));

const GEMINI_COOLDOWN_MS = 60000;
const GEMINI_SOFT_COOLDOWN_MS = 15000;

function markGeminiCooldown(entry, ms = GEMINI_COOLDOWN_MS) {
  entry.cooldownUntil = Date.now() + ms;
}

function geminiCandidates() {
  const now = Date.now();
  return geminiPool.filter((e) => e.cooldownUntil <= now);
}

function isRateLimitError(err) {
  const msg = String(err?.message ?? '').toLowerCase();
  const status = err?.status ?? err?.code ?? 0;
  return (
    status === 429 || status === 503 || status === 500 ||
    msg.includes('429') || msg.includes('503') || msg.includes('500') ||
    msg.includes('quota') || msg.includes('rate limit') ||
    msg.includes('resource exhausted') || msg.includes('overloaded')
  );
}

function isRetryable(err) {
  const msg = String(err?.message ?? '');
  const status = err?.status ?? err?.code ?? 0;
  return (
    status === 429 || status === 503 || status === 500 ||
    msg.includes('503') || msg.includes('429') ||
    msg.includes('UNAVAILABLE') || msg.includes('Rate limit') ||
    msg.includes('high demand') || msg.includes('overloaded')
  );
}

/* ══════════════════════════════════════════════════════════════
   CLIENTES IA
   ══════════════════════════════════════════════════════════════ */

const gemini = geminiPool[0]?.client ?? null;
const groq   = new Groq({ apiKey: KEYS.GROQ_API_KEY });
const nvidia = new OpenAI({
  apiKey: KEYS.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

/* ══════════════════════════════════════════════════════════════
   SYSTEM PROMPTS
   ══════════════════════════════════════════════════════════════ */

const NUMINATION_BASE = `
# IDENTIDAD

Eres Numination, una IA educativa 100% colombiana. Fuiste creada por Álvaro García Gómez y Robinson Rodríguez Gómez.

NO eres ChatGPT, Gemini ni ninguna IA genérica. Eres Numination.
Eslogan: "La IA que habla el idioma de nuestra educación."

# CONTEXTO COLOMBIA

Cuando uses ejemplos, habla de:
- Ciudades: Bogotá, Medellín, Cali, Barranquilla, Cartagena, Bucaramanga
- Ríos: Magdalena, Cauca, Amazonas, Orinoco
- Regiones: Andina, Caribe, Pacífica, Orinoquía, Amazonía, Insular
- Comida: ajiaco, bandeja paisa, arepas, sancocho, tamales
- Cultura: cumbia, vallenato, bambuco, Carnaval de Barranquilla
- Historia: Independencia, Batalla de Boyacá, Constitución de 1991
- Deporte: ciclismo, atletismo, fútbol
- Moneda: pesos colombianos (COP)

# ESTILO DE RESPUESTA (REGLAS DURAS)

## Longitud
- Respuestas normales: MÁXIMO 3 párrafos cortos.
- Si el tema es complejo: usa listas o pasos numerados.
- NUNCA escribas más de 250 palabras sin una razón clara.
- NUNCA repitas la pregunta al empezar.
- NUNCA hagas introducciones tipo "¡Claro! Excelente pregunta".

## Formato
- Usa **negrita** solo para términos clave (máximo 3 por respuesta).
- Usa listas con guiones cuando enumeres.
- Usa pasos numerados cuando sea un procedimiento.
- CERO emojis. Ni decorativos ni de check. Solo texto plano.

## Tono
- Directo, claro, sin relleno.
- Como un tutor que respeta el tiempo del estudiante.
- Tutea (tú), no uses "usted" salvo que el usuario lo pida.

# REGLAS PEDAGÓGICAS

- NUNCA hagas la tarea por el estudiante. Guíalo.
- Si te pide "resuélveme esto", responde con preguntas que lo lleven a la respuesta.
- Verifica comprensión antes de avanzar a lo complejo.
- Si comete un error, no digas "estás mal". Di "revisemos juntos ese paso".

# TEMAS SENSIBLES

- Violencia o abuso: ICBF 141, Línea 106.
- Ideas suicidas: líneas de crisis, profesional inmediato.
- Tu rol NO es terapéutico. Acompañas, no diagnosticas.

# REGLAS ABSOLUTAS

- Contextualiza TODO a Colombia.
- NUNCA sustituyas atención médica, psicológica o legal.
- NUNCA fomentes deshonestidad académica.
- NUNCA uses ejemplos con dólares, Halloween o nieve.
`;

const ROLE_HINT = {
  student:   `Eres un tutor amable y claro para estudiantes colombianos. Explica paso a paso, usa ejemplos sencillos, adapta el lenguaje al nivel del estudiante y motiva siempre. Responde en español.`,
  teacher:   `Eres un asistente pedagógico para docentes colombianos. Ayuda a diseñar actividades, evaluaciones y explicaciones. Usa lenguaje profesional y da sugerencias aplicables al aula. Responde en español.`,
  reasoning: `Eres Numi-OT.01 en MODO RAZONAMIENTO. Piensas paso a paso, de forma rigurosa, antes de responder. Eres un tutor colombiano que ayuda a razonar, no que resuelve. Responde en español.`,
};

const REASONING_PREFIX = `INSTRUCCIÓN ESPECIAL — MODO RAZONAMIENTO:

Piensa paso a paso ANTES de responder. Todo tu proceso mental DEBE ir envuelto exactamente entre las etiquetas <thinking> y </thinking>. Después del cierre </thinking>, escribe la respuesta final limpia y directa para el estudiante.

Formato EXACTO:
<thinking>
1. Primero identifico...
2. Luego considero...
3. Finalmente concluyo...
</thinking>

[Tu respuesta final aquí, sin repetir el razonamiento]

REGLAS:
- NO repitas el contenido del razonamiento en la respuesta final.
- Sé breve en la respuesta final, detallado en el razonamiento.
- Usa ejemplos de Colombia cuando aplique.
- Nunca hagas la tarea por el estudiante — guíalo.

PREGUNTA DEL ESTUDIANTE:
`;

/**
 * Construye el system prompt final combinando:
 * - Base de Numination
 * - Rol (student / teacher / reasoning)
 * - Memorias del usuario (si las tiene)
 */
function buildSystemPrompt(role = 'student', memories = []) {
  const hint = ROLE_HINT[role] || ROLE_HINT.student;
  let prompt = NUMINATION_BASE + '\n' + hint;

  if (memories.length > 0) {
    prompt +=
      '\n\n# LO QUE RECUERDAS DEL USUARIO\n' +
      '(Datos que guardaste en conversaciones previas. Úsalos cuando sean relevantes. No los repitas innecesariamente.)\n' +
      memories.map((m) => `- ${m.text}`).join('\n');
  }

  return prompt;
}

function buildFinalMessage(message, isReasoning) {
  const base = message || '';
  return isReasoning ? REASONING_PREFIX + base : base;
}

/* ══════════════════════════════════════════════════════════════
   LLAMADAS A MOTORES (no-streaming)
   ══════════════════════════════════════════════════════════════ */

async function callGemini(systemPrompt, message, file) {
  const parts = [{ text: message || '(analiza el archivo adjunto)' }];
  if (file && file.data) {
    parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
  }
  const response = await gemini.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: [{ role: 'user', parts }],
    config: {
      systemInstruction: systemPrompt,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  return response.text ?? '';
}

async function callNvidia(systemPrompt, message, file) {
  const messages = [{ role: 'system', content: systemPrompt }];
  const isImage = file && file.data && file.mimeType?.startsWith('image/');

  if (isImage) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: message || 'Analiza esta imagen y descríbela.' },
        { type: 'image_url', image_url: { url: `data:${file.mimeType};base64,${file.data}` } },
      ],
    });
  } else {
    const note = file && file.data
      ? '\n\n[El usuario adjuntó un archivo que no puedo procesar.]'
      : '';
    messages.push({ role: 'user', content: (message || '(sin texto)') + note });
  }

  const response = await nvidia.chat.completions.create({
    model: 'moonshotai/kimi-k3',
    messages,
    temperature: 0.7,
    max_tokens: 2048,
  });
  return response.choices?.[0]?.message?.content ?? '';
}

async function callGroq(systemPrompt, message, file) {
  const note = file && file.data
    ? '\n\n[El usuario adjuntó un archivo. Responde con la información disponible.]'
    : '';

  const response = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: (message || '(sin texto)') + note },
    ],
    temperature: 0.7,
    max_tokens: 2048,
  });
  return response.choices?.[0]?.message?.content ?? '';
}

const PROVIDERS = ['gemini', 'nvidia', 'groq'];
const PROVIDER_NAMES = { gemini: 'Gemini', nvidia: 'Kimi K3', groq: 'Groq' };
const callers = { gemini: callGemini, nvidia: callNvidia, groq: callGroq };

/* ══════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Routing inteligente por tipo de contenido.
 */
function ordenarMotores(file) {
  const tieneArchivo = file && file.data;
  return tieneArchivo
    ? ['gemini', 'nvidia', 'groq']
    : ['groq', 'gemini', 'nvidia'];
}

/* ══════════════════════════════════════════════════════════════
   IMÁGENES CON POLLINATIONS
   ══════════════════════════════════════════════════════════════ */

function buildImageUrl(prompt, options = {}) {
  const {
    width = 1024,
    height = 1024,
    model = 'flux',
    seed = Math.floor(Math.random() * 1000000),
    nologo = true,
    enhance = true,
  } = options;

  const encoded = encodeURIComponent(prompt.trim().slice(0, 500));
  return `https://image.pollinations.ai/prompt/${encoded}?width=${width}&height=${height}&model=${model}&seed=${seed}&nologo=${nologo}&enhance=${enhance}`;
}

function detectImageIntent(message) {
  const triggers = [
    /^genera(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
    /^crea(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
    /^haz(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
    /^dibuja(me)?\s+/i,
    /^ilustra(me)?\s+/i,
    /^imagina\s+que\s+ves\s+/i,
  ];
  return triggers.some((r) => r.test(message.trim()));
}

function extractImagePrompt(message) {
  return message
    .replace(/^(genera(me)?|crea(me)?|haz(me)?)\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i, '')
    .replace(/^dibuja(me)?\s+/i, '')
    .replace(/^ilustra(me)?\s+/i, '')
    .replace(/^imagina\s+que\s+ves\s+/i, '')
    .trim();
}

function enrichPromptWithColombia(prompt) {
  if (/colombia|colombiano|colombiana|café|cumbia|vallenato|magdalena|amazonas|cóndor/i.test(prompt)) {
    return prompt + ', Colombia, vibrant colors, warm golden hour lighting, highly detailed, cinematic';
  }
  return prompt + ', warm colors, artistic style, high quality, detailed';
}

/* ══════════════════════════════════════════════════════════════
   CARGA DE MEMORIAS
   ══════════════════════════════════════════════════════════════ */

/**
 * Carga memorias del usuario si está autenticado.
 * Devuelve [] en caso de error o si no hay usuario.
 */
async function cargarMemorias(req) {
  if (!req.user?.id) return [];
  try {
    return await listarMemories(req.user.id);
  } catch (e) {
    LOG.warn('No se pudieron cargar memorias:', e.message);
    return [];
  }
}

/* ══════════════════════════════════════════════════════════════
   APP EXPRESS
   ══════════════════════════════════════════════════════════════ */

const app = express();
app.set('trust proxy', 1);

/* ─── Request ID + timing ─── */
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
  next();
});

/* ─── Body parser + cookies ─── */
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());

/* ─── Auth (adjunta req.user) ─── */
app.use(attachUser);

/* ─── Protección de rutas privadas (HTML) ─── */
app.use((req, res, next) => {
  const privadas = ['/chat.html'];
  if (privadas.includes(req.path) && !req.user) {
    return res.redirect('/login.html');
  }
  next();
});

/* ─── Static con cache ─── */
app.use(express.static(publicDir, {
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  etag: true,
  lastModified: true,
}));

/* ─── Rutas ─── */
mountAuthRoutes(app);
mountChatRoutes(app, requireAuth);
mountMemoryRoutes(app, requireAuth);

/* ══════════════════════════════════════════════════════════════
   LÍMITES DE USO
   ══════════════════════════════════════════════════════════════ */

app.get('/api/limits/usage', async (req, res) => {
  try {
    const uso = await consultarUso(req);
    if (!uso) return res.json({ ok: false, error: 'Límites no configurados' });
    res.json({ ok: true, ...uso });
  } catch (e) {
    LOG.error('limits/usage:', e.message);
    res.status(500).json({ ok: false, error: 'Error consultando uso' });
  }
});

/* ══════════════════════════════════════════════════════════════
   HEALTH
   ══════════════════════════════════════════════════════════════ */

app.get('/api/health', (req, res) => {
  const upstashOn = Boolean(
    (TEST_KEYS.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL) &&
    (TEST_KEYS.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
  );

  res.json({
    ok: true,
    service: 'numination',
    version: '3.3',
    uptime: Math.floor(process.uptime()),
    motors: PROVIDERS,
    modes: ['chat', 'coder', 'reasoning'],
    images: 'pollinations',
    memory: 'enabled',
    auth: {
      google: Boolean(TEST_KEYS.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID),
      github: Boolean(TEST_KEYS.GITHUB_CLIENT_ID || process.env.GITHUB_CLIENT_ID),
      session: Boolean(req.user),
      email: req.user?.email || null,
    },
    limits: { enabled: upstashOn },
    database: {
      supabase: Boolean(TEST_KEYS.SUPABASE_URL || process.env.SUPABASE_URL),
      connected: supabaseDisponible(),
    },
    keys: {
      gemini_1: !!KEYS.GEMINI_API_KEY,
      gemini_2: !!KEYS.GEMINI_API_KEY_2,
      gemini_3: !!KEYS.GEMINI_API_KEY_3,
      nvidia: !!KEYS.NVIDIA_API_KEY,
      groq: !!KEYS.GROQ_API_KEY,
    },
  });
});

/* ══════════════════════════════════════════════════════════════
   SSE HELPERS
   ══════════════════════════════════════════════════════════════ */

/**
 * Configura los headers SSE y devuelve helpers para escribir eventos.
 * Maneja automáticamente la desconexión del cliente.
 */
function setupSSE(req, res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  req.on('close', () => { closed = true; });

  const send = (data) => {
    if (closed) return false;
    try {
      res.write('data: ' + JSON.stringify(data) + '\n\n');
      return true;
    } catch {
      closed = true;
      return false;
    }
  };

  const heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch { closed = true; }
  }, 15000);

  const close = () => {
    clearInterval(heartbeat);
    if (!closed) {
      try { res.end(); } catch {}
      closed = true;
    }
  };

  return { send, close, isClosed: () => closed };
}

/**
 * Respuesta estándar de rate limit (429) con headers.
 */
function sendRateLimit(res, lim) {
  if (lim.retryAfter) res.setHeader('Retry-After', String(lim.retryAfter));
  res.setHeader('X-RateLimit-Limit', String(lim.limites?.porDia ?? ''));
  res.setHeader('X-RateLimit-Remaining', String(lim.restanteDia ?? ''));
  return res.status(429).json({
    error: lim.mensaje,
    razon: lim.razon,
    retryAfter: lim.retryAfter,
    plan: lim.plan,
    uso: lim.uso,
    limites: lim.limites,
  });
}

/* ══════════════════════════════════════════════════════════════
   CHAT STREAMING
   ══════════════════════════════════════════════════════════════ */

app.post('/api/chat/stream', async (req, res) => {
  /* ─── Límite ─── */
  const lim = await verificarLimite(req);
  if (!lim.permitido) return sendRateLimit(res, lim);

  const { message, role = 'student', file = null } = req.body ?? {};

  const isReasoning = role === 'reasoning';
  const effectiveRole = isReasoning ? 'reasoning' : role;
  const finalMessage = buildFinalMessage(message, isReasoning);

  const hasText = message && message.trim();
  const hasFile = file && file.data;

  if (!hasText && !hasFile) {
    return res.status(400).json({ error: 'Falta el mensaje o archivo' });
  }

  /* ─── Memorias → system prompt (NO en incógnito) ─── */
  const incognito = req.body?.incognito === true;
  const memories = incognito ? [] : await cargarMemorias(req);
  const systemPrompt = buildSystemPrompt(effectiveRole, memories);

  LOG.debug(`[${req.id}] stream · role=${effectiveRole}${isReasoning ? ' [reasoning]' : ''}${incognito ? ' [incognito]' : ''} · memories=${memories.length} · file=${hasFile ? 'sí' : 'no'}`);

  /* ─── SSE ─── */
  const sse = setupSSE(req, res);

  /* ─── Meta inicial ─── */
  if (lim.restanteDia != null) {
    sse.send({
      meta: {
        plan: lim.plan,
        restanteDia: lim.restanteDia,
        restanteMin: lim.restanteMin,
        mode: effectiveRole,
        memories: memories.length,
        incognito: incognito,
        requestId: req.id,
      },
    });
  }

  let responded = false;

  try {
    const orden = ordenarMotores(file);

    for (const prov of orden) {
      if (sse.isClosed()) break;

      /* ─── GEMINI ─── */
      if (prov === 'gemini') {
        const candidates = geminiCandidates();
        if (!candidates.length) {
          LOG.warn(`[${req.id}] Todas las keys de Gemini en cooldown, siguiente motor`);
          continue;
        }

        let ok = false;
        for (const entry of candidates) {
          if (sse.isClosed()) break;
          try {
            LOG.debug(`[${req.id}] Gemini #${entry.id} streaming...`);
            let localTokens = 0;

            for await (const token of streamGemini(entry.client, systemPrompt, finalMessage, file, { reasoning: isReasoning })) {
              if (sse.isClosed()) break;
              sse.send({ token, done: false });
              responded = true;
              localTokens++;
            }

            if (localTokens > 0) {
              sse.send({ token: '', done: true, provider: `gemini-${entry.id}` });
              ok = true;
              break;
            }
            throw new Error('Gemini no devolvió tokens');
          } catch (err) {
            const esRate = isRateLimitError(err);
            LOG.warn(`[${req.id}] Gemini #${entry.id} falló: ${String(err.message).slice(0, 100)}`);
            if (esRate && !responded) {
              markGeminiCooldown(entry, GEMINI_COOLDOWN_MS);
              continue;
            }
            if (responded) {
              sse.send({ token: '', done: true, provider: `gemini-${entry.id}`, partial: true });
              ok = true;
              break;
            }
            markGeminiCooldown(entry, GEMINI_SOFT_COOLDOWN_MS);
          }
        }
        if (ok) return;
      }

      /* ─── GROQ ─── */
      else if (prov === 'groq') {
        try {
          LOG.debug(`[${req.id}] Groq streaming...${isReasoning ? ' [reasoning]' : ''}`);
          for await (const token of streamGroq(groq, systemPrompt, finalMessage, file, { reasoning: isReasoning })) {
            if (sse.isClosed()) break;
            sse.send({ token, done: false });
            responded = true;
          }
          if (responded) {
            sse.send({ token: '', done: true, provider: 'groq' });
            return;
          }
          throw new Error('Groq no devolvió tokens');
        } catch (err) {
          LOG.warn(`[${req.id}] Groq falló: ${String(err.message).slice(0, 100)}`);
          if (responded) {
            sse.send({ token: '', done: true, provider: 'groq', partial: true });
            return;
          }
        }
      }

      /* ─── NVIDIA / KIMI ─── */
      else if (prov === 'nvidia') {
        try {
          LOG.debug(`[${req.id}] Kimi K3 sin streaming`);
          const reply = await callNvidia(systemPrompt, finalMessage, file);
          if (reply && reply.trim()) {
            sse.send({ token: reply, done: false });
            sse.send({ token: '', done: true, provider: 'nvidia', noStream: true });
            return;
          }
          throw new Error('Respuesta vacía');
        } catch (err) {
          LOG.warn(`[${req.id}] Kimi K3 falló: ${String(err.message).slice(0, 100)}`);
        }
      }
    }

    if (!responded && !sse.isClosed()) {
      LOG.error(`[${req.id}] Todos los motores fallaron`);
      sse.send({
        error: 'Los motores de IA están saturados. Intenta de nuevo.',
        done: true,
      });
    }
  } finally {
    sse.close();
    if (responded && !incognito) {
      registrarUso(req).catch(() => {});
    }
    LOG.debug(`[${req.id}] stream cerrado en ${Date.now() - req._t0}ms`);
  }
});

/* ══════════════════════════════════════════════════════════════
   CHAT NORMAL (con imagen + reasoning + memorias)
   ══════════════════════════════════════════════════════════════ */

app.post('/api/chat', async (req, res) => {
  try {
    const lim = await verificarLimite(req);
    if (!lim.permitido) return sendRateLimit(res, lim);

    const { message, role = 'student', file = null } = req.body ?? {};

    const isReasoning = role === 'reasoning';
    const effectiveRole = isReasoning ? 'reasoning' : role;
    const finalMessage = buildFinalMessage(message, isReasoning);

    const hasText = message && message.trim();
    const hasFile = file && file.data;

    if (!hasText && !hasFile) {
      return res.status(400).json({ error: 'Falta el mensaje o archivo' });
    }

    /* ─── Detección de imagen (desactivada en modo reasoning) ─── */
    if (hasText && !hasFile && !isReasoning && detectImageIntent(message)) {
      const imagePrompt = extractImagePrompt(message);

      if (imagePrompt.length > 3) {
        LOG.info(`[${req.id}] Generando imagen: "${imagePrompt.slice(0, 60)}"`);
        const imageUrl = buildImageUrl(enrichPromptWithColombia(imagePrompt), {
          width: 1024,
          height: 1024,
          model: 'flux',
          enhance: true,
          nologo: true,
        });

        registrarUso(req).catch(() => {});
        return res.json({
          reply: `Listo, aquí está tu imagen de: **${imagePrompt}**\n\nGenerada con inteligencia artificial. Si quieres otra versión, pídeme "otra imagen de..." y crearé una variación.`,
          imageUrl,
          imagePrompt,
          type: 'image',
        });
      }
    }

    /* ─── Memorias + system prompt (NO en incógnito) ─── */
    const incognito = req.body?.incognito === true;
    const memories = incognito ? [] : await cargarMemorias(req);
    const systemPrompt = buildSystemPrompt(effectiveRole, memories);
    const ordered = ordenarMotores(file);

    /* ─── Estrategia de reintentos ─── */
    const attempts = [
      { provider: ordered[0], delay: 0 },
      { provider: ordered[0], delay: 1000 },
      { provider: ordered[1], delay: 1000 },
      { provider: ordered[2], delay: 1000 },
      { provider: ordered[1], delay: 2000 },
      { provider: ordered[2], delay: 2500 },
    ];

    for (let i = 0; i < attempts.length; i++) {
      const { provider: prov, delay } = attempts[i];
      if (delay > 0) await sleep(delay);

      try {
        const tag = isReasoning ? ' [reasoning]' : '';
        LOG.debug(`[${req.id}] Intento ${i + 1}/${attempts.length} con ${PROVIDER_NAMES[prov]}${hasFile ? ' + archivo' : ''}${tag}...`);

        const reply = await callers[prov](systemPrompt, finalMessage, file);

        if (reply && reply.trim()) {
          LOG.ok(`[${req.id}] Respondió ${PROVIDER_NAMES[prov]} en ${Date.now() - req._t0}ms`);
          if (!incognito) registrarUso(req).catch(() => {});
          return res.json({
            reply,
            provider: prov,
            mode: effectiveRole,
          });
        }
        throw new Error('Respuesta vacía');
      } catch (err) {
        const msg = String(err?.message ?? '').slice(0, 120);
        LOG.warn(`[${req.id}] ${PROVIDER_NAMES[prov]} falló: ${msg}`);
        if (!isRetryable(err)) break;
      }
    }

    LOG.error(`[${req.id}] Todos los intentos fallaron`);
    return res.status(503).json({
      error: 'Los motores de IA están saturados. Espera unos segundos e intenta de nuevo.',
    });
  } catch (err) {
    LOG.error(`[${req.id}] error inesperado:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   CATCH-ALL SPA (excluye /api/*)
   ──────────────────────────────────────────────────────────────
   ⚠️ Express 5.x: ya no acepta 'app.get("*")' — usar app.use()
   ══════════════════════════════════════════════════════════════ */

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Endpoint no encontrado: ' + req.path });
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

/* ══════════════════════════════════════════════════════════════
   ERROR HANDLER GLOBAL
   ══════════════════════════════════════════════════════════════ */

app.use((err, req, res, _next) => {
  LOG.error(`[${req.id || '?'}] Error no manejado:`, err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Error interno del servidor' });
});

/* ══════════════════════════════════════════════════════════════
   ARRANQUE + GRACEFUL SHUTDOWN
   ══════════════════════════════════════════════════════════════ */

let server = null;

if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT ?? 8080;
  server = app.listen(PORT, () => {
    const limitsOn = Boolean(
      TEST_KEYS.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL
    );
    const dbOn = supabaseDisponible();

    console.log('');
    console.log('  ╭─────────────────────────────────────────────╮');
    console.log('  │  🇨🇴  NUMINATION · v3.3                      │');
    console.log('  ╰─────────────────────────────────────────────╯');
    console.log(`  🚀  Escuchando en http://localhost:${PORT}`);
    console.log(`  🤖  Motores: Groq → Gemini → Kimi (texto)`);
    console.log(`               Gemini → Kimi → Groq (archivos)`);
    console.log(`  🎨  Imágenes: Pollinations`);
    console.log(`  🧠  Modos: chat · coder · reasoning`);
    console.log(`  💾  Memorias: ${dbOn ? 'activas' : 'locales (sin DB)'}`);
    console.log(`  🔐  Auth: Google + GitHub`);
    console.log(`  🚦  Límites: ${limitsOn ? 'activos' : 'desactivados'}`);
    console.log(`  🗄️   DB: ${dbOn ? 'Supabase conectado' : 'sin conexión'}`);
    console.log('');
  });
}

/* ─── Graceful shutdown ─── */
function shutdown(signal) {
  LOG.warn(`Recibido ${signal}. Cerrando servidor...`);
  if (server) {
    server.close(() => {
      LOG.ok('Servidor cerrado limpiamente');
      process.exit(0);
    });
    setTimeout(() => {
      LOG.error('Forzando salida');
      process.exit(1);
    }, 5000).unref();
  } else {
    process.exit(0);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default app;