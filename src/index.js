/* ══════════════════════════════════════════════════════════════
   NUMINATION — Backend v3.0
   ----------------------------------------------------------------
   Chat IA con 3 motores en cascada.
   Auth: Google OAuth + JWT
   DB: Supabase (Postgres)
   Límites: Upstash Redis
   Imágenes: Pollinations
   ══════════════════════════════════════════════════════════════ */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import OpenAI from 'openai';

import { streamGroq, streamGemini } from './services/streaming.js';
import { mountAuthRoutes, attachUser, requireAuth } from './auth.js';
import { mountChatRoutes } from './chats.js';
import { verificarLimite, consultarUso } from './services/limits.js';
import { supabaseDisponible } from './services/supabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

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
  console.warn('⚠️  Ninguna GEMINI_API_KEY configurada');
}
if (!KEYS.NVIDIA_API_KEY) console.warn('⚠️  NVIDIA_API_KEY no configurada');
if (!KEYS.GROQ_API_KEY)   console.warn('⚠️  GROQ_API_KEY no configurada');

/* ══════════════════════════════════════════════════════════════
   POOL DE GEMINI
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

const gemini = geminiPool[0]?.client ?? null;
const groq = new Groq({ apiKey: KEYS.GROQ_API_KEY });
const nvidia = new OpenAI({
  apiKey: KEYS.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

/* ══════════════════════════════════════════════════════════════
   SYSTEM PROMPT
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
- NO uses emojis decorativos. Cero 🚀 🎯 ✨ 📚.
- Puedes usar a lo sumo 1 emoji si aporta (ej. ✅ al final de un paso resuelto).

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

const ROLE_HINT_STUDENT = `Eres un tutor amable y claro para estudiantes colombianos. Explica paso a paso, usa ejemplos sencillos, adapta el lenguaje al nivel del estudiante y motiva siempre. Responde en español.`;

const ROLE_HINT_TEACHER = `Eres un asistente pedagógico para docentes colombianos. Ayuda a diseñar actividades, evaluaciones y explicaciones. Usa lenguaje profesional y da sugerencias aplicables al aula. Responde en español.`;

function buildSystemPrompt(role = 'student') {
  const hint = role === 'teacher' ? ROLE_HINT_TEACHER : ROLE_HINT_STUDENT;
  return NUMINATION_BASE + '\n' + hint;
}

/* ══════════════════════════════════════════════════════════════
   LLAMADAS A MOTORES
   ══════════════════════════════════════════════════════════════ */

async function callGemini(systemPrompt, message, file) {
  const parts = [{ text: message || '(analiza el archivo adjunto)' }];
  if (file && file.data) {
    parts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
  }
  const response = await gemini.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: [{ role: 'user', parts }],
    config: { systemInstruction: systemPrompt },
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
    const note = file && file.data ? '\n\n[El usuario adjuntó un archivo que no puedo procesar.]' : '';
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

const PROVIDERS = ['groq', 'gemini', 'nvidia'];
const PROVIDER_NAMES = { gemini: 'Gemini', nvidia: 'Kimi K3', groq: 'Groq' };

const callers = {
  gemini: callGemini,
  nvidia: callNvidia,
  groq: callGroq,
};

/* ══════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
   SERVIDOR EXPRESS
   ══════════════════════════════════════════════════════════════ */

const app = express();

/* ── Middleware ── */
app.use(express.json({ limit: '15mb' }));
app.use(cookieParser());
app.use(attachUser);

/* ── Protección de rutas privadas ── */
app.use((req, res, next) => {
  const privadas = ['/chat.html'];
  if (privadas.includes(req.path) && !req.user) {
    return res.redirect('/login.html');
  }
  next();
});

app.use(express.static(publicDir));

/* ── Rutas de auth y chats ── */
mountAuthRoutes(app);
mountChatRoutes(app, requireAuth);

/* ─────────── LÍMITES DE USO ─────────── */

app.get('/api/limits/usage', async (req, res) => {
  const uso = await consultarUso(req);
  if (!uso) return res.json({ ok: false, error: 'Límites no configurados' });
  res.json({ ok: true, ...uso });
});

/* ─────────── HEALTH ─────────── */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'numination',
    version: '3.0',
    motors: PROVIDERS,
    images: 'pollinations',
    auth: {
      google: Boolean(TEST_KEYS.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID),
      session: Boolean(req.user),
      email: req.user?.email || null,
    },
    limits: {
      enabled: Boolean(
        (TEST_KEYS.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL) &&
        (TEST_KEYS.UPSTASH_REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN)
      ),
    },
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
   CHAT STREAMING
   ══════════════════════════════════════════════════════════════ */

app.post('/api/chat/stream', async (req, res) => {
  const lim = await verificarLimite(req);
  if (!lim.permitido) {
    return res.status(429).json({
      error: lim.mensaje,
      razon: lim.razon,
      retryAfter: lim.retryAfter,
      plan: lim.plan,
      uso: lim.uso,
      limites: lim.limites,
    });
  }

  const { message, role = 'student', file = null } = req.body ?? {};
  const hasText = message && message.trim();
  const hasFile = file && file.data;

  if (!hasText && !hasFile) {
    return res.status(400).json({ error: 'Falta el mensaje o archivo' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  if (lim.restanteDia != null) {
    res.write('data: ' + JSON.stringify({
      meta: {
        plan: lim.plan,
        restanteDia: lim.restanteDia,
        restanteMin: lim.restanteMin,
      },
    }) + '\n\n');
  }

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 15000);

  const send = (data) => {
    try { res.write('data: ' + JSON.stringify(data) + '\n\n'); } catch {}
  };

  const systemPrompt = buildSystemPrompt(role);
  let responded = false;

  try {
    const orden = ['gemini', 'groq', 'nvidia'];
    for (const prov of orden) {
      if (prov === 'gemini') {
        const candidates = geminiCandidates();
        if (!candidates.length) {
          console.warn('[stream] Todas las keys de Gemini en cooldown, paso a Groq');
          continue;
        }
        let ok = false;
        for (const entry of candidates) {
          try {
            console.log('[stream] Gemini #' + entry.id + ' -> streaming...');
            let localTokens = 0;
            for await (const token of streamGemini(entry.client, systemPrompt, message || '', file)) {
              send({ token, done: false });
              responded = true;
              localTokens++;
            }
            if (localTokens > 0) {
              send({ token: '', done: true, provider: 'gemini-' + entry.id });
              ok = true;
              break;
            }
            throw new Error('Gemini no devolvió tokens');
          } catch (err) {
            const esRate = isRateLimitError(err);
            console.warn('[stream] Gemini #' + entry.id + ' falló: ' + String(err.message).slice(0, 100));
            if (esRate && !responded) {
              markGeminiCooldown(entry, GEMINI_COOLDOWN_MS);
              console.warn('[stream] Key #' + entry.id + ' en cooldown 60s');
              continue;
            }
            if (responded) {
              send({ token: '', done: true, provider: 'gemini-' + entry.id, partial: true });
              ok = true;
              break;
            }
            markGeminiCooldown(entry, 15000);
            continue;
          }
        }
        if (ok) return;
      } else if (prov === 'groq') {
        try {
          console.log('[stream] Groq -> streaming...');
          for await (const token of streamGroq(groq, systemPrompt, message || '', file)) {
            send({ token, done: false });
            responded = true;
          }
          if (responded) {
            send({ token: '', done: true, provider: 'groq' });
            return;
          }
          throw new Error('Groq no devolvió tokens');
        } catch (err) {
          console.warn('[stream] Groq falló: ' + String(err.message).slice(0, 100));
          if (responded) {
            send({ token: '', done: true, provider: 'groq', partial: true });
            return;
          }
        }
      } else if (prov === 'nvidia') {
        try {
          console.log('[stream] Kimi K3 -> sin streaming');
          const reply = await callNvidia(systemPrompt, message || '', file);
          if (reply && reply.trim()) {
            send({ token: reply, done: false });
            send({ token: '', done: true, provider: 'nvidia', noStream: true });
            return;
          }
          throw new Error('Respuesta vacía');
        } catch (err) {
          console.warn('[stream] Kimi K3 falló: ' + String(err.message).slice(0, 100));
        }
      }
    }

    if (!responded) {
      console.error('[stream] Todos los motores fallaron');
      send({ error: 'Los motores de IA están saturados. Intenta de nuevo.', done: true });
    }
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

/* ══════════════════════════════════════════════════════════════
   CHAT NORMAL (con imágenes)
   ══════════════════════════════════════════════════════════════ */

app.post('/api/chat', async (req, res) => {
  try {
    const lim = await verificarLimite(req);
    if (!lim.permitido) {
      return res.status(429).json({
        error: lim.mensaje,
        razon: lim.razon,
        retryAfter: lim.retryAfter,
        plan: lim.plan,
        uso: lim.uso,
        limites: lim.limites,
      });
    }

    const { message, role = 'student', file = null } = req.body ?? {};
    const hasText = message && message.trim();
    const hasFile = file && file.data;

    if (!hasText && !hasFile) {
      return res.status(400).json({ error: 'Falta el mensaje o archivo' });
    }

    /* ─── Detección de generación de imágenes ─── */
    if (hasText && detectImageIntent(message)) {
      const imagePrompt = extractImagePrompt(message);

      if (imagePrompt.length > 3) {
        console.log(`[chat] 🎨 Generando imagen: "${imagePrompt}"`);
        const imageUrl = buildImageUrl(enrichPromptWithColombia(imagePrompt), {
          width: 1024,
          height: 1024,
          model: 'flux',
          enhance: true,
          nologo: true,
        });

        return res.json({
          reply: `🎨 Listo, aquí está tu imagen de: **${imagePrompt}**\n\nGenerada con inteligencia artificial. Si quieres otra versión, pídeme "otra imagen de..." y crearé una variación.`,
          imageUrl,
          imagePrompt,
          type: 'image',
        });
      }
    }

    /* ─── Respuesta normal con IA ─── */
    const systemPrompt = buildSystemPrompt(role);
    const ordered = PROVIDERS;

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
        console.log(`[chat] Intento ${i + 1}/${attempts.length} con ${PROVIDER_NAMES[prov]}${hasFile ? ' + archivo' : ''}...`);
        const reply = await callers[prov](systemPrompt, message || '', file);

        if (reply && reply.trim()) {
          console.log(`[chat] ✅ Respondió ${PROVIDER_NAMES[prov]}`);
          return res.json({ reply });
        }
        throw new Error('Respuesta vacía');
      } catch (err) {
        const msg = String(err?.message ?? '').slice(0, 120);
        console.warn(`[chat] ${PROVIDER_NAMES[prov]} falló: ${msg}`);
        if (!isRetryable(err)) break;
      }
    }

    console.error('[chat] Todos los intentos fallaron');
    return res.status(503).json({
      error: 'Los motores de IA están saturados. Espera unos segundos e intenta de nuevo.',
    });
  } catch (err) {
    console.error('[chat] error inesperado:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────── FALLBACK SPA ─────────── */

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

/* ══════════════════════════════════════════════════════════════
   ARRANQUE
   ══════════════════════════════════════════════════════════════ */

if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT ?? 8080;
  app.listen(PORT, () => {
    const limitsOn = Boolean(
      TEST_KEYS.UPSTASH_REDIS_REST_URL || process.env.UPSTASH_REDIS_REST_URL
    );
    const dbOn = supabaseDisponible();

    console.log(`🇨🇴 Numination v3.0 escuchando en http://localhost:${PORT}`);
    console.log(`🤖 Motores: Gemini → Groq → Kimi K3`);
    console.log(`🎨 Imágenes: Pollinations`);
    console.log(`🔐 Auth: Google OAuth`);
    console.log(`🚦 Límites: ${limitsOn ? 'activos' : 'desactivados'}`);
    console.log(`🗄️  DB: ${dbOn ? 'Supabase conectado' : 'sin conexión'}`);
  });
}

export default app;