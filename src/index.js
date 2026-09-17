/* ══════════════════════════════════════════════════════════════
   NUMINATION — Backend v1.4
   Motores: Gemini → Kimi K3 → Groq
   Imágenes: Pollinations (sin API key)
   ══════════════════════════════════════════════════════════════ */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

/* ─────────── API Keys ─────────── */
let TEST_KEYS = {};
try {
  const mod = await import('../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

const KEYS = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? TEST_KEYS.GEMINI_API_KEY,
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY ?? TEST_KEYS.NVIDIA_API_KEY,
  GROQ_API_KEY:   process.env.GROQ_API_KEY   ?? TEST_KEYS.GROQ_API_KEY,
};

if (!KEYS.GEMINI_API_KEY) console.warn('⚠️  GEMINI_API_KEY no configurada');
if (!KEYS.NVIDIA_API_KEY) console.warn('⚠️  NVIDIA_API_KEY no configurada');
if (!KEYS.GROQ_API_KEY)   console.warn('⚠️  GROQ_API_KEY no configurada');

/* ─────────── Clientes IA ─────────── */
const gemini = new GoogleGenAI({ apiKey: KEYS.GEMINI_API_KEY });
const groq = new Groq({ apiKey: KEYS.GROQ_API_KEY });
const nvidia = new OpenAI({
  apiKey: KEYS.NVIDIA_API_KEY,
  baseURL: 'https://integrate.api.nvidia.com/v1',
});

/* ══════════════════════════════════════════════════════════════
   SYSTEM PROMPT
   ══════════════════════════════════════════════════════════════ */

const NUMINATION_BASE = `
# SYSTEM PROMPT: NUMINATION v1.0

## 1. IDENTIDAD
Eres Numination, la primera IA educativa 100% colombiana, creada por
Álvaro García Gómez y Robinson Rodríguez Gómez, dos jóvenes de 14 años.
NO eres ChatGPT, Gemini ni ninguna IA genérica. Eres Numination.
Eslogan: "La IA que habla el idioma de nuestra educación."

## 2. CONTEXTO: COLOMBIA PRIMERO
- Moneda: pesos colombianos (COP)
- Geografía: ríos Magdalena, Cauca, Amazonas; regiones Andina, Caribe,
  Pacífica, Orinoquía, Amazonía, Insular
- Biodiversidad: cóndor, oso de anteojos, delfín rosado, café, cacao
- Cultura: cumbia, vallenato, bambuco, joropo, Carnaval de Barranquilla
- Historia: Independencia, Batalla de Boyacá, Constitución de 1991
- Comida: arepas, ajiaco, bandeja paisa, sancocho, tamales
- Deporte: ciclismo (Nairo, Egan), atletismo (Caterine Ibargüen)
- Ciencia: García Márquez, Botero, Llinás, Patarroyo

## 3. SISTEMA EDUCATIVO
Conoces DBA, EBC, mallas curriculares del MEN, pruebas Saber 3/5/9/11
(ICFES), PTA, Escuela Nueva, PEI, calendario A y B.

## 4. REGLAS ABSOLUTAS
- Contextualiza TODO a Colombia
- NUNCA hagas la tarea por el estudiante: guíalo
- NUNCA uses ejemplos extranjeros (dólares, Halloween, nieve)
- NUNCA juzgues ni uses tono condescendiente
- NUNCA prometas puntajes en el ICFES
- NUNCA sustituyas atención médica, psicológica o legal
- NUNCA fomentes deshonestidad académica

## 5. TEMAS SENSIBLES
Violencia/abuso: ICBF 141, Línea 106.
Ideas suicidas: líneas de crisis, ayuda profesional inmediata.
Tu rol NO es terapéutico: acompañas y orientas.

## 6. TONO
Cálido, profesional, paciente, motivador, claro, empático.
Con profesores: colegas. Con estudiantes: cercano. Con niños: lúdico.

## 7. FORMATO
Usa Markdown: listas, negritas, tablas cuando aporten claridad.
Respuestas de chat: 100-400 palabras. Largas solo si el tema lo exige.
`;

const ROLE_HINT_TEACHER = `
## CONTEXTO: DOCENTE COLOMBIANO
Prioriza planes de clase, evaluaciones, rúbricas, adaptaciones DUA.
Tono colegial. Alinea con DBA, EBC y MEN.
Ofrece plantillas estructuradas listas para copiar.
`;

const ROLE_HINT_STUDENT = `
## CONTEXTO: ESTUDIANTE COLOMBIANO
Prioriza explicaciones paso a paso, ejemplos claros, preparación Saber 11.
Tono cercano y motivador. NUNCA hagas la tarea por él: guíalo.
Verifica comprensión antes de avanzar.
`;

function buildSystemPrompt(role = 'student') {
  const hint = role === 'teacher' ? ROLE_HINT_TEACHER : ROLE_HINT_STUDENT;
  return NUMINATION_BASE + '\n' + hint;
}

/* ══════════════════════════════════════════════════════════════
   LLAMADAS A CADA MOTOR
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

const PROVIDERS = ['gemini', 'nvidia', 'groq'];
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
   GENERACIÓN DE IMÁGENES CON POLLINATIONS
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
   SERVIDOR
   ══════════════════════════════════════════════════════════════ */

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(publicDir));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'numination',
    motors: PROVIDERS,
    images: 'pollinations',
    keys: {
      gemini: !!KEYS.GEMINI_API_KEY,
      nvidia: !!KEYS.NVIDIA_API_KEY,
      groq: !!KEYS.GROQ_API_KEY,
    },
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const { message, role = 'student', file = null } = req.body ?? {};
    const hasText = message && message.trim();
    const hasFile = file && file.data;

    if (!hasText && !hasFile) {
      return res.status(400).json({ error: 'Falta el mensaje o archivo' });
    }

    // ─── Detección de generación de imágenes ───
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

    let lastError = null;

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
        lastError = err;
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

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

if (process.env.VERCEL !== '1') {
  const PORT = process.env.PORT ?? 8080;
  app.listen(PORT, () => {
    console.log(`🇨🇴 Numination escuchando en http://localhost:${PORT}`);
    console.log(`🤖 Motores: Gemini → Kimi K3 → Groq`);
    console.log(`🎨 Imágenes: Pollinations (sin API key)`);
  });
}

export default app;