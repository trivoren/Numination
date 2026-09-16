/* ══════════════════════════════════════════════════════════════
   NUMINATION — Backend completo v1.1
   Tres motores IA: Gemini + Mistral + Groq
   ══════════════════════════════════════════════════════════════ */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { Mistral } from '@mistralai/mistralai';
import Groq from 'groq-sdk';
import { TEST_KEYS } from '../env.local.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

/* ─────────── Clientes IA ─────────── */
const gemini = new GoogleGenAI({ apiKey: TEST_KEYS.GEMINI_API_KEY });
const mistral = new Mistral({ apiKey: TEST_KEYS.MISTRAL_API_KEY });
const groq = new Groq({ apiKey: TEST_KEYS.GROQ_API_KEY });

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
Con profesores: colegas. Con estudiantes: cercano.
Con niños: lúdico.

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

async function callGemini(systemPrompt, message) {
  const response = await gemini.models.generateContent({
    model: 'gemini-3.6-flash',
    contents: [{ role: 'user', parts: [{ text: message }] }],
    config: { systemInstruction: systemPrompt },
  });
  return response.text ?? '';
}

async function callMistral(systemPrompt, message) {
  const response = await mistral.chat.complete({
    model: 'mistral-small-latest',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ],
  });
  return response.choices?.[0]?.message?.content ?? '';
}

async function callGroq(systemPrompt, message) {
  const response = await groq.chat.completions.create({
    model: 'openai/gpt-oss-120b',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ],
    temperature: 0.7,
    max_tokens: 2048,
  });
  return response.choices?.[0]?.message?.content ?? '';
}

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
   SERVIDOR EXPRESS
   ══════════════════════════════════════════════════════════════ */

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));

/* ─────────── Health check ─────────── */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'numination', motors: ['gemini', 'mistral', 'groq'] });
});

/* ─────────── Chat con reintentos y 3 motores ─────────── */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, provider = 'gemini', role = 'student' } = req.body ?? {};

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Falta el mensaje' });
    }

    const systemPrompt = buildSystemPrompt(role);
    const primary = ['gemini', 'mistral', 'groq'].includes(provider) ? provider : 'gemini';

    const callers = {
      gemini: callGemini,
      mistral: callMistral,
      groq: callGroq,
    };

    const allProviders = ['gemini', 'mistral', 'groq'];
    const others = allProviders.filter((p) => p !== primary);

    const attempts = [
      { provider: primary,   delay: 0 },
      { provider: primary,   delay: 1000 },
      { provider: others[0], delay: 1000 },
      { provider: others[1], delay: 1500 },
      { provider: others[0], delay: 2000 },
      { provider: others[1], delay: 3000 },
    ];

    let lastError = null;

    for (let i = 0; i < attempts.length; i++) {
      const { provider: prov, delay } = attempts[i];
      if (delay > 0) await sleep(delay);

      try {
        console.log(`[chat] Intento ${i + 1}/${attempts.length} con ${prov}...`);
        const reply = await callers[prov](systemPrompt, message);

        if (reply && reply.trim()) {
          console.log(`[chat] ✅ Respondió ${prov}`);
          return res.json({ reply, provider: prov });
        }
        throw new Error('Respuesta vacía');
      } catch (err) {
        const msg = String(err?.message ?? '').slice(0, 120);
        console.warn(`[chat] ${prov} falló: ${msg}`);
        lastError = err;
        if (!isRetryable(err)) break;
      }
    }

    console.error('[chat] Todos los intentos fallaron');
    return res.status(503).json({
      error: 'Los motores de IA están saturados. Espera unos segundos e intenta de nuevo.',
      detail: String(lastError?.message ?? '').slice(0, 200),
    });
  } catch (err) {
    console.error('[chat] error inesperado:', err);
    res.status(500).json({ error: err.message });
  }
});

/* ─────────── SPA fallback ─────────── */
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

/* ─────────── Arranque ─────────── */
const PORT = process.env.PORT ?? 8080;
app.listen(PORT, () => {
  console.log(`🇨🇴 Numination escuchando en http://localhost:${PORT}`);
  console.log(`🤖 Motores: Gemini + Mistral + Groq`);
});