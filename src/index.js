/* ══════════════════════════════════════════════════════════════
   NUMINATION — Backend completo
   Todo en un solo archivo: servidor + IA + prompt
   ══════════════════════════════════════════════════════════════ */

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';
import { Mistral } from '@mistralai/mistralai';
import { TEST_KEYS } from '../env.local.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

/* ─────────── Clientes IA ─────────── */
const gemini = new GoogleGenAI({ apiKey: TEST_KEYS.GEMINI_API_KEY });
const mistral = new Mistral({ apiKey: TEST_KEYS.MISTRAL_API_KEY });

/* ══════════════════════════════════════════════════════════════
   SYSTEM PROMPT DE NUMINATION
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
   SERVIDOR EXPRESS
   ══════════════════════════════════════════════════════════════ */

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));

/* ─────────── Health check ─────────── */
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'numination' });
});

/* ─────────── Funciones de cada proveedor ─────────── */
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

/* ─────────── Chat con fallback automático ─────────── */
app.post('/api/chat', async (req, res) => {
  try {
    const { message, provider = 'gemini', role = 'student' } = req.body ?? {};

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Falta el mensaje' });
    }

    const systemPrompt = buildSystemPrompt(role);

    // Orden de intentos: primero el elegido, después el otro
    const primary = provider === 'mistral' ? 'mistral' : 'gemini';
    const fallback = primary === 'gemini' ? 'mistral' : 'gemini';

    const callers = {
      gemini: callGemini,
      mistral: callMistral,
    };

    let reply = '';
    let usedProvider = primary;
    let lastError = null;

    // Intento 1: el proveedor elegido
    try {
      reply = await callers[primary](systemPrompt, message);
    } catch (err) {
      console.warn(`[chat] ${primary} falló: ${err.message}. Intentando con ${fallback}...`);
      lastError = err;

      // Intento 2: el otro proveedor
      try {
        reply = await callers[fallback](systemPrompt, message);
        usedProvider = fallback;
      } catch (err2) {
        console.error(`[chat] ${fallback} también falló:`, err2.message);
        return res.status(503).json({
          error: 'Ambos motores están saturados en este momento. Intenta de nuevo en unos segundos.',
        });
      }
    }

    res.json({ reply, provider: usedProvider });
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
});