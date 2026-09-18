/* ══════════════════════════════════════════════════════════════
   NUMINATION — Backend v2.0
   Motores: Gemini → Kimi K3 → Groq
   Imágenes: Pollinations (sin API key)
   Banco ICFES: 500 preguntas reales (5 materias × 100)
   ══════════════════════════════════════════════════════════════ */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import OpenAI from 'openai';

import {
  listarMaterias,
  preguntaAleatoria,
  simulacro,
  verificarRespuesta,
  formatearParaChat,
} from './services/questions.js';

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
# SYSTEM PROMPT: NUMINATION v1.1

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

/* ─────────── ENDPOINTS DE PREGUNTAS ─────────── */

app.get('/api/questions/materias', (_req, res) => {
  res.json({ materias: listarMaterias() });
});

app.get('/api/questions/random', (req, res) => {
  const materia = req.query.materia || null;
  const p = preguntaAleatoria(materia);
  if (!p) return res.status(404).json({ error: 'No hay preguntas disponibles' });
  res.json({ pregunta: p });
});

app.get('/api/questions/simulacro', (req, res) => {
  const cantidad = Math.min(parseInt(req.query.cantidad, 10) || 10, 40);
  const areas = req.query.areas ? String(req.query.areas).split(',') : null;
  const preguntas = simulacro(cantidad, areas);
  res.json({ cantidad: preguntas.length, preguntas });
});

app.post('/api/questions/check', (req, res) => {
  const { id, respuesta } = req.body ?? {};
  if (!id || !respuesta) {
    return res.status(400).json({ error: 'Faltan id y respuesta' });
  }
  const resultado = verificarRespuesta(id, respuesta);
  if (!resultado.ok) return res.status(404).json(resultado);
  res.json(resultado);
});

/* ─────────── HEALTH ─────────── */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'numination',
    version: '2.0',
    motors: PROVIDERS,
    images: 'pollinations',
    banco: listarMaterias(),
    keys: {
      gemini: !!KEYS.GEMINI_API_KEY,
      nvidia: !!KEYS.NVIDIA_API_KEY,
      groq: !!KEYS.GROQ_API_KEY,
    },
  });
});

/* ══════════════════════════════════════════════════════════════
   DETECCIÓN DE INTENCIÓN DE PRÁCTICA
   ══════════════════════════════════════════════════════════════ */

function detectarPractica(message) {
  const t = message.trim().toLowerCase();

  // "practicar matematicas", "practicar lectura critica"
  const materiaMatch = t.match(
    /^(?:practicar|practica|practícame|quiero practicar|dame practica de|hazme practicar)\s+(?:de\s+)?(.+)$/i
  );
  if (materiaMatch) {
    const raw = materiaMatch[1].trim();
    const mapa = {
      matematicas: 'matematicas', matemática: 'matematicas', matemáticas: 'matematicas',
      'lectura critica': 'lectura-critica', 'lectura crítica': 'lectura-critica',
      sociales: 'sociales', 'ciencias sociales': 'sociales',
      'ciencias naturales': 'ciencias-naturales', ciencias: 'ciencias-naturales',
      ingles: 'ingles', inglés: 'ingles',
    };
    const slug = mapa[raw] || (raw.includes('matem') ? 'matematicas'
                 : raw.includes('lectura') ? 'lectura-critica'
                 : raw.includes('social') ? 'sociales'
                 : raw.includes('cienc') ? 'ciencias-naturales'
                 : raw.includes('ingl') ? 'ingles'
                 : null);
    if (slug) return { tipo: 'materia', slug };
  }

  if (/^(?:simulacro|simulacro completo|hazme un simulacro|quiero un simulacro)/i.test(t)) {
    return { tipo: 'simulacro' };
  }

  if (/^(?:practicar|practica|pregunta aleatoria|dame una pregunta)/i.test(t)) {
    return { tipo: 'aleatoria' };
  }

  return null;
}

/* ══════════════════════════════════════════════════════════════
   CHAT
   ══════════════════════════════════════════════════════════════ */

app.post('/api/chat', async (req, res) => {
  try {
    const { message, role = 'student', file = null, checkId = null, checkRespuesta = null } = req.body ?? {};
    const hasText = message && message.trim();
    const hasFile = file && file.data;

    if (!hasText && !hasFile && !checkId) {
      return res.status(400).json({ error: 'Falta el mensaje o archivo' });
    }

    /* ─── Verificar respuesta de pregunta ICFES ─── */
    if (checkId && checkRespuesta) {
      const r = verificarRespuesta(checkId, checkRespuesta);
      if (!r.ok) return res.status(404).json(r);
      const emoji = r.correcta ? '✅' : '❌';
      const encabezado = r.correcta
        ? `${emoji} **¡Correcto!** La respuesta era **${r.respuesta_correcta}**.`
        : `${emoji} **Incorrecto.** La respuesta correcta era **${r.respuesta_correcta}**.`;
      return res.json({
        reply: `${encabezado}\n\n**Explicación:**\n${r.explicacion}\n\n¿Quieres practicar otra? Escribe "practicar ${r.materia.toLowerCase()}" o "simulacro".`,
        type: 'check',
        correcta: r.correcta,
      });
    }

    /* ─── Detección de práctica ICFES ─── */
    if (hasText) {
      const practica = detectarPractica(message);

      if (practica) {
        if (practica.tipo === 'simulacro') {
          const preguntas = simulacro(10);
          const texto = preguntas.map((p, i) => {
            return `**Pregunta ${i + 1} de 10** · ${p.materia}\n\n${p.contexto}\n\n${p.enunciado}\n\nA) ${p.opciones.A}\nB) ${p.opciones.B}\nC) ${p.opciones.C}\nD) ${p.opciones.D}\n\n_(ID: ${p.id})_`;
          }).join('\n\n---\n\n');
          return res.json({
            reply: `# 📝 Simulacro ICFES · 10 preguntas\n\nResponde cada pregunta con la letra (A, B, C o D). Cuando termines, envía tu respuesta en el formato:\n\n\`MATE-001 B\` o simplemente dime "verificar MATE-001 B".\n\n---\n\n${texto}`,
            type: 'simulacro',
            preguntas,
          });
        }

        const p = practica.tipo === 'materia'
          ? preguntaAleatoria(practica.slug)
          : preguntaAleatoria();

        if (!p) return res.status(404).json({ error: 'No hay preguntas disponibles' });

        return res.json({
          reply: formatearParaChat(p),
          type: 'practica',
          pregunta: p,
        });
      }
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
    console.log(`🇨🇴 Numination v2.0 escuchando en http://localhost:${PORT}`);
    console.log(`🤖 Motores: Groq → Gemini → Kimi K3`);
    console.log(`🎨 Imágenes: Pollinations (sin API key)`);
    const banco = listarMaterias();
    const total = banco.reduce((s, m) => s + m.total, 0);
    console.log(`📚 Banco ICFES: ${total} preguntas en ${banco.length} materias`);
  });
}

export default app;
