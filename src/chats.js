/* ═══════════════════════════════════════════════════════════════════════════
   
                            N U M I N A T I O N   ·   C H A T S   ·   v 3 . 1

   ─────────────────────────────────────────────────────────────────────────
   El corazón del sistema. Todo lo que pasa cuando alguien escribe algo.

   Nada aquí es nuevo. Todo esto ya existía en pedazos:
   · En tu chat.html (el frontend)
   · En tu server viejo (los motores de IA)
   · En tu cabeza (el sistema de cuotas)
   · En tus sueños (el streaming perfecto que querías)

   Hoy por fin está todo junto, en un solo archivo, funcionando como debería
   haber funcionado desde el principio.

   ─────────────────────────────────────────────────────────────────────────
   ENDPOINTS:

     GET    /api/chats                    → listar tus conversaciones
     POST   /api/chats                    → crear una nueva
     GET    /api/chats/:id                → ver una con sus mensajes
     PATCH  /api/chats/:id                → renombrar
     DELETE /api/chats/:id                → borrar una
     DELETE /api/chats                    → borrar todas (peligro)
     POST   /api/chats/:id/messages       → guardar un mensaje suelto

     POST   /api/chat/stream              → EL endpoint (SSE con IA real)
     GET    /api/limits/usage             → cuánto te queda del día

   ─────────────────────────────────────────────────────────────────────────
   MOTORES DE IA (en orden de preferencia para texto):

     🥇  Groq       → el más rápido, casi siempre responde
     🥈  Gemini     → el más estable, 3 keys rotando
     🥉  NVIDIA     → respaldo final, corre Kimi K2, Qwen y más

   Si uno falla, el otro responde. Si el otro falla, el tercero responde.
   El usuario nunca ve el drama detrás. Solo ve la respuesta.

   ─────────────────────────────────────────────────────────────────────────
   CAMBIOS v3.1:
     · Detección automática de Kimi vía múltiples nombres de variable:
       KIMI_API_KEY | NVIDIA_API_KEY | MOONSHOT_API_KEY
     · Base URL configurable según el proveedor detectado
     · Modelo ajustado automáticamente
     · Tercer motor ahora aparece en el fallback si existe alguna de esas keys
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  crearChat,
  listarChats,
  obtenerChat,
  eliminarChat,
  renombrarChat,
  crearMensaje,
  listarMensajes,
  getUserStats,
} from './services/supabase.js';

/* ══════════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ══════════════════════════════════════════════════════════════════════════ */

let TEST_KEYS = {};
try {
  const mod = await import('../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

/* ─── Groq ─── */
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? TEST_KEYS.GROQ_API_KEY;
const GROQ_MODEL   = process.env.GROQ_MODEL   ?? TEST_KEYS.GROQ_MODEL ?? 'llama-3.3-70b-versatile';

/* ─── Gemini (3 keys rotando) ─── */
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY_1 ?? TEST_KEYS.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2 ?? TEST_KEYS.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3 ?? TEST_KEYS.GEMINI_API_KEY_3,
].filter(Boolean);
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? TEST_KEYS.GEMINI_MODEL ?? 'gemini-2.0-flash';

/* ─── Tercer motor · Kimi / NVIDIA / Moonshot ───
   
   Tu env.local.js tenía un comentario "NVIDIA / Kimi K3 (respaldo 2)"
   pero sin la variable. Detectamos automáticamente el nombre correcto.
   ─────────────────────────────────────────────────────────────────────── */

const KIMI_API_KEY =
  process.env.KIMI_API_KEY     ?? TEST_KEYS.KIMI_API_KEY     ??
  process.env.NVIDIA_API_KEY   ?? TEST_KEYS.NVIDIA_API_KEY   ??
  process.env.MOONSHOT_API_KEY ?? TEST_KEYS.MOONSHOT_API_KEY ??
  null;

// Base URL: depende de qué key encontramos
function detectKimiBaseUrl() {
  if (process.env.KIMI_BASE_URL)     return process.env.KIMI_BASE_URL;
  if (TEST_KEYS.KIMI_BASE_URL)       return TEST_KEYS.KIMI_BASE_URL;

  // NVIDIA NIM
  if (process.env.NVIDIA_BASE_URL)   return process.env.NVIDIA_BASE_URL;
  if (TEST_KEYS.NVIDIA_BASE_URL)     return TEST_KEYS.NVIDIA_BASE_URL;

  // Moonshot
  if (process.env.MOONSHOT_BASE_URL) return process.env.MOONSHOT_BASE_URL;
  if (TEST_KEYS.MOONSHOT_BASE_URL)   return TEST_KEYS.MOONSHOT_BASE_URL;

  // Si la key empieza con nvapi- → NVIDIA
  if (KIMI_API_KEY?.startsWith('nvapi-')) {
    return 'https://integrate.api.nvidia.com/v1';
  }

  // Por defecto asumimos Moonshot
  return 'https://api.moonshot.cn/v1';
}

// Modelo: depende del proveedor
function detectKimiModel() {
  if (process.env.KIMI_MODEL)   return process.env.KIMI_MODEL;
  if (TEST_KEYS.KIMI_MODEL)     return TEST_KEYS.KIMI_MODEL;

  const base = detectKimiBaseUrl();

  // NVIDIA NIM → modelo con prefijo del vendor
  if (base.includes('nvidia')) {
    return process.env.NVIDIA_MODEL ?? TEST_KEYS.NVIDIA_MODEL ?? 'moonshotai/kimi-k2-instruct';
  }

  // Moonshot → modelo directo
  return process.env.MOONSHOT_MODEL ?? TEST_KEYS.MOONSHOT_MODEL ?? 'moonshot-v1-8k';
}

const KIMI_BASE_URL = detectKimiBaseUrl();
const KIMI_MODEL    = detectKimiModel();

/* ─── Límites ─── */
const MAX_HISTORY  = 12;      // cuántos mensajes previos mandamos al modelo
const MAX_CHARS    = 8000;    // cuántos caracteres por mensaje
const MAX_TITLE    = 80;      // cuántos caracteres por título de chat
const MAX_TOKENS   = 2048;    // cuántos tokens puede generar la IA
const TEMPERATURE  = 0.7;     // qué tan "creativa" es la IA

/* ══════════════════════════════════════════════════════════════════════════
   2 · LOGGING
   ══════════════════════════════════════════════════════════════════════════ */

const LEVEL = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVEL[process.env.LOG_LEVEL] || LEVEL.info;

function log(level, event, meta = {}) {
  if (LEVEL[level] < MIN_LEVEL) return;
  const entry = { ts: new Date().toISOString(), lvl: level, event, ...meta };
  const line = JSON.stringify(entry);
  if      (level === 'error') console.error('[chat]', line);
  else if (level === 'warn')  console.warn ('[chat]', line);
  else                        console.log  ('[chat]', line);
}

/* ══════════════════════════════════════════════════════════════════════════
   3 · SYSTEM PROMPTS · el alma de cada modo
   ══════════════════════════════════════════════════════════════════════════ */

const SYSTEM_PROMPTS = {

  /* ─── Modo Estudiante (Chat normal) ─── */
  student: `Eres Numination, un tutor de IA colombiano para estudiantes de colegio.

PERSONALIDAD:
- Hablas en español colombiano neutro, cercano pero sin exagerar el acento.
- Explicas con paciencia, sin condescendencia.
- Nunca das la respuesta directa sin explicar el porqué.
- Si el estudiante se equivoca, corriges con cariño: "Casi, mira por acá...".
- Adaptas el lenguaje a la edad del estudiante.

CÓMO RESPONDES:
- Máximo 3 párrafos, salvo que pidan más detalle.
- Usa **negrita** para los conceptos clave.
- Cuando resuelvas matemáticas, muestra cada paso numerado.
- Cuando cites historia, incluye fechas y contexto colombiano cuando aplique.
- Cierras con una pregunta que invite a seguir aprendiendo.

LO QUE NUNCA HACES:
- Inventar datos. Si no sabes algo, lo dices abiertamente.
- Dar la respuesta completa sin explicación.
- Usar lenguaje técnico sin explicarlo antes.`,

  /* ─── Modo Coder (programación) ─── */
  teacher: `Eres Numination Coder, asistente técnico para programadores.

PERSONALIDAD:
- Preciso. Directo. Cero relleno.
- Sabes JavaScript, TypeScript, Python, React, Node, SQL, HTML/CSS.
- Conoces las mejores prácticas modernas y las aplicas.

CÓMO RESPONDES:
- Cada bloque de código va en \`\`\`lenguaje ... \`\`\`.
- Comentarios en español, pero solo donde agregan valor.
- Si hay varias formas, muestras la mejor primero y mencionas alternativas.
- Al final de cada bloque, una línea: "// Esto hace: ...".
- Si el usuario dice "solo el código", devuelves SOLO el bloque.

NUNCA:
- Das código que no funcione.
- Ignoras errores de manejo de casos borde.
- Escribes comentarios obvios como "// sumo 1 a x".`,

  /* ─── Modo Reasoning (razonamiento paso a paso) ─── */
  reasoning: `Eres Numination Razonador. Resuelves problemas complejos razonando
de verdad, no respondiendo por reflejo.

MÉTODO OBLIGATORIO:
1. Reformulas el problema en tus propias palabras.
2. Descompones en subproblemas.
3. Explorás alternativas antes de decidir.
4. Descartás las hipótesis incorrectas explicando por qué.
5. Das la solución final con verificación.

REGLA CRÍTICA DE FORMATO:
Todo el razonamiento va DENTRO de etiquetas <thinking></thinking>.
Después del cierre, va la respuesta final limpia, sin repetir el proceso.

EJEMPLO:
<thinking>
El usuario pregunta X. Considero tres enfoques:
- Enfoque A: descartado porque...
- Enfoque B: descartado porque...
- Enfoque C: elegido porque...
Verificación: cumple con la restricción Y y Z.
</thinking>
La respuesta es C, porque cumple con lo que pediste.

NUNCA:
- Mezclas razonamiento con respuesta final.
- Das la respuesta sin haber explorado alternativas.
- Rindes rápido. Si es difícil, razonas más, no menos.`,
};

function getSystemPrompt(role) {
  return SYSTEM_PROMPTS[role] || SYSTEM_PROMPTS.student;
}

/* ══════════════════════════════════════════════════════════════════════════
   4 · PARSER SSE · unifica todos los motores
   ══════════════════════════════════════════════════════════════════════════ */

async function* parseSSE(body, extractor) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (!trimmed.startsWith('data:')) continue;

        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;

        const token = extractor(payload);
        if (token) yield token;
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

function extractOpenAI(payload) {
  try {
    const obj = JSON.parse(payload);
    return obj?.choices?.[0]?.delta?.content || null;
  } catch { return null; }
}

function extractGemini(payload) {
  try {
    const obj = JSON.parse(payload);
    return obj?.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch { return null; }
}

/* ══════════════════════════════════════════════════════════════════════════
   5 · CLIENTES DE IA
   ══════════════════════════════════════════════════════════════════════════ */

/* ─── Groq · API compatible con OpenAI ─── */
async function* streamGroq(messages, opts = {}) {
  if (!GROQ_API_KEY) throw new Error('Groq no configurado');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      stream: true,
      temperature: opts.temperature ?? TEMPERATURE,
      max_tokens: opts.max_tokens ?? MAX_TOKENS,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Groq ${res.status}: ${txt.slice(0, 200)}`);
  }

  yield* parseSSE(res.body, extractOpenAI);
}

/* ─── Gemini · formato propio ─── */
async function* streamGemini(messages, opts = {}) {
  if (GEMINI_KEYS.length === 0) throw new Error('Gemini no configurado');

  const key = GEMINI_KEYS[Math.floor(Math.random() * GEMINI_KEYS.length)];

  const systemMsg = messages.find(m => m.role === 'system');
  const convMessages = messages.filter(m => m.role !== 'system');

  const contents = convMessages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${key}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents,
      systemInstruction: systemMsg
        ? { parts: [{ text: systemMsg.content }] }
        : undefined,
      generationConfig: {
        temperature: opts.temperature ?? TEMPERATURE,
        maxOutputTokens: opts.max_tokens ?? MAX_TOKENS,
      },
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Gemini ${res.status}: ${txt.slice(0, 200)}`);
  }

  yield* parseSSE(res.body, extractGemini);
}

/* ─── Tercer motor · Kimi / NVIDIA / Moonshot · API compatible OpenAI ─── */
async function* streamKimi(messages, opts = {}) {
  if (!KIMI_API_KEY) throw new Error('Kimi/NVIDIA no configurado');

  const res = await fetch(`${KIMI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KIMI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: KIMI_MODEL,
      messages,
      stream: true,
      temperature: opts.temperature ?? TEMPERATURE,
      max_tokens: opts.max_tokens ?? MAX_TOKENS,
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Kimi ${res.status}: ${txt.slice(0, 200)}`);
  }

  yield* parseSSE(res.body, extractOpenAI);
}

/* ══════════════════════════════════════════════════════════════════════════
   6 · CADENA DE FALLBACK
   ══════════════════════════════════════════════════════════════════════════ */

const ENGINES = [
  { name: 'groq',   stream: streamGroq,   available: () => Boolean(GROQ_API_KEY) },
  { name: 'gemini', stream: streamGemini, available: () => GEMINI_KEYS.length > 0 },
  { name: 'kimi',   stream: streamKimi,   available: () => Boolean(KIMI_API_KEY) },
];

async function* streamWithFallback(messages, opts = {}) {
  let lastErr = null;
  let usedEngine = null;

  for (const engine of ENGINES) {
    if (!engine.available()) continue;

    let emitted = false;
    try {
      log('debug', 'ai.try', { engine: engine.name });

      for await (const token of engine.stream(messages, opts)) {
        if (!emitted) {
          emitted = true;
          usedEngine = engine.name;
          log('info', 'ai.pick', { engine: engine.name });
        }
        yield token;
      }

      log('debug', 'ai.done', { engine: engine.name });
      return;
    } catch (err) {
      lastErr = err;

      if (emitted) {
        log('error', 'ai.partial_fail', {
          engine: engine.name,
          message: err.message,
        });
        throw err;
      }

      log('warn', 'ai.retry_next', {
        engine: engine.name,
        message: err.message,
      });
    }
  }

  throw lastErr || new Error('No hay motores de IA configurados');
}

/* ══════════════════════════════════════════════════════════════════════════
   7 · CUOTAS · por plan, por usuario, en memoria
   ══════════════════════════════════════════════════════════════════════════ */

const PLAN_LIMITS = {
  free:          { porDia: 50,    porMinuto: 5 },
  'pro-coder':   { porDia: 500,   porMinuto: 20 },
  'pro-plus':    { porDia: 2000,  porMinuto: 40 },
  'pro-mad-max': { porDia: 10000, porMinuto: 100 },
};

const usageByUser = new Map();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getUsage(userId) {
  const now = Date.now();
  let entry = usageByUser.get(userId);

  if (!entry || entry.day !== todayKey()) {
    entry = { day: todayKey(), count: 0, minuteBuckets: [] };
    usageByUser.set(userId, entry);
  }

  entry.minuteBuckets = entry.minuteBuckets.filter(t => now - t < 60_000);
  return entry;
}

function checkLimit(userId, plan) {
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  const usage = getUsage(userId);
  const porMinutoActual = usage.minuteBuckets.length;

  if (usage.count >= limits.porDia) {
    return {
      ok: false,
      reason: 'dia',
      limite: limits.porDia,
      mensaje: `Alcanzaste el límite diario (${limits.porDia}). Vuelve mañana.`,
    };
  }

  if (porMinutoActual >= limits.porMinuto) {
    return {
      ok: false,
      reason: 'minuto',
      limite: limits.porMinuto,
      mensaje: `Demasiados mensajes por minuto (${limits.porMinuto}). Espera unos segundos.`,
    };
  }

  return { ok: true, limits, usage };
}

function consumeLimit(userId) {
  const usage = getUsage(userId);
  usage.count++;
  usage.minuteBuckets.push(Date.now());
}

/* ══════════════════════════════════════════════════════════════════════════
   8 · VALIDACIÓN
   ══════════════════════════════════════════════════════════════════════════ */

const VALID_ROLES = new Set(['student', 'teacher', 'reasoning']);

function normalizeRole(role) {
  if (!role) return 'student';
  const r = String(role).toLowerCase().trim();
  if (VALID_ROLES.has(r)) return r;

  if (r === 'chat') return 'student';
  if (r === 'coder') return 'teacher';
  if (r === 'razonamiento') return 'reasoning';

  return 'student';
}

function sanitizeMessage(text) {
  if (typeof text !== 'string') return '';
  return text.trim().slice(0, MAX_CHARS);
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(m => m && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map(m => ({
      role: m.role === 'assistant' || m.role === 'ai' ? 'assistant' : 'user',
      content: String(m.content).slice(0, MAX_CHARS),
    }));
}

function fail(res, status, code, message) {
  return res.status(status).json({ ok: false, error: message, code });
}

/* ══════════════════════════════════════════════════════════════════════════
   9 · MOUNT
   ══════════════════════════════════════════════════════════════════════════ */

export function mountChatRoutes(app, requireAuth) {

  /* ───────────────────────────────────────────────────────────────────
     GET /api/chats
     ─────────────────────────────────────────────────────────────────── */
  app.get('/api/chats', requireAuth, async (req, res) => {
    try {
      const chats = await listarChats(req.user.id, { limit: 100 });
      return res.json({ ok: true, chats });
    } catch (e) {
      log('error', 'chats.list.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'list_failed', 'No pudimos cargar tus chats.');
    }
  });

  /* ───────────────────────────────────────────────────────────────────
     POST /api/chats
     ─────────────────────────────────────────────────────────────────── */
  app.post('/api/chats', requireAuth, async (req, res) => {
    try {
      const title = String(
        req.body?.title || 'Nuevo chat'
      ).trim().slice(0, MAX_TITLE) || 'Nuevo chat';

      const chat = await crearChat(req.user.id, title);
      if (!chat) return fail(res, 500, 'create_failed', 'No pudimos crear el chat.');

      log('info', 'chats.create.ok', { userId: req.user.id, chatId: chat.id });
      return res.status(201).json({ ok: true, chat });
    } catch (e) {
      log('error', 'chats.create.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'create_failed', 'No pudimos crear el chat.');
    }
  });

  /* ───────────────────────────────────────────────────────────────────
     GET /api/chats/:id
     ─────────────────────────────────────────────────────────────────── */
  app.get('/api/chats/:id', requireAuth, async (req, res) => {
    try {
      const chat = await obtenerChat(req.params.id, req.user.id);
      if (!chat) return fail(res, 404, 'not_found', 'Chat no encontrado.');
      return res.json({ ok: true, chat });
    } catch (e) {
      log('error', 'chats.get.fail', { id: req.params.id, message: e.message });
      return fail(res, 500, 'get_failed', 'No pudimos cargar el chat.');
    }
  });

  /* ───────────────────────────────────────────────────────────────────
     PATCH /api/chats/:id
     ─────────────────────────────────────────────────────────────────── */
  app.patch('/api/chats/:id', requireAuth, async (req, res) => {
    try {
      const title = String(req.body?.title || '').trim().slice(0, MAX_TITLE);
      if (!title) return fail(res, 400, 'title_required', 'Falta el título.');

      const chat = await renombrarChat(req.params.id, req.user.id, title);
      if (!chat) return fail(res, 404, 'not_found', 'Chat no encontrado.');

      return res.json({ ok: true, chat });
    } catch (e) {
      log('error', 'chats.rename.fail', { id: req.params.id, message: e.message });
      return fail(res, 500, 'rename_failed', 'No pudimos renombrar el chat.');
    }
  });

  /* ───────────────────────────────────────────────────────────────────
     DELETE /api/chats/:id
     ─────────────────────────────────────────────────────────────────── */
  app.delete('/api/chats/:id', requireAuth, async (req, res) => {
    try {
      const ok = await eliminarChat(req.params.id, req.user.id);
      if (!ok) return fail(res, 404, 'not_found', 'Chat no encontrado.');

      log('info', 'chats.delete.ok', { userId: req.user.id, chatId: req.params.id });
      return res.json({ ok: true });
    } catch (e) {
      log('error', 'chats.delete.fail', { id: req.params.id, message: e.message });
      return fail(res, 500, 'delete_failed', 'No pudimos borrar el chat.');
    }
  });

  /* ───────────────────────────────────────────────────────────────────
     DELETE /api/chats · borrar todos
     ─────────────────────────────────────────────────────────────────── */
  app.delete('/api/chats', requireAuth, async (req, res) => {
    try {
      const chats = await listarChats(req.user.id, { limit: 500 });
      let deleted = 0;

      for (const c of chats) {
        if (await eliminarChat(c.id, req.user.id)) deleted++;
      }

      log('warn', 'chats.delete_all', { userId: req.user.id, deleted });
      return res.json({ ok: true, deleted });
    } catch (e) {
      log('error', 'chats.delete_all.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'delete_all_failed', 'No pudimos borrar los chats.');
    }
  });

  /* ───────────────────────────────────────────────────────────────────
     POST /api/chats/:id/messages
     ─────────────────────────────────────────────────────────────────── */
  app.post('/api/chats/:id/messages', requireAuth, async (req, res) => {
    try {
      const body = req.body?.message || req.body || {};
      const { role, content, provider } = body;

      if (!content || typeof content !== 'string') {
        return fail(res, 400, 'invalid_message', 'Falta el contenido.');
      }

      const chat = await obtenerChat(req.params.id, req.user.id);
      if (!chat) return fail(res, 404, 'not_found', 'Chat no encontrado.');

      const normalizedRole = role === 'user' ? 'user' : 'ai';

      const message = await crearMensaje(req.params.id, {
        role: normalizedRole,
        content: sanitizeMessage(content),
        provider: provider || null,
      });

      if (!message) return fail(res, 500, 'save_failed', 'No pudimos guardar el mensaje.');

      return res.json({ ok: true, message });
    } catch (e) {
      log('error', 'messages.save.fail', { id: req.params.id, message: e.message });
      return fail(res, 500, 'save_failed', 'No pudimos guardar el mensaje.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     POST /api/chat/stream
     ═════════════════════════════════════════════════════════════════════ */
  app.post('/api/chat/stream', requireAuth, async (req, res) => {
    const userId = req.user.id;
    const reqStart = Date.now();

    try {
      const {
        message,
        role = 'student',
        history = [],
        incognito = false,
        chatId = null,
      } = req.body || {};

      const cleanMessage = sanitizeMessage(message);
      if (!cleanMessage) {
        return fail(res, 400, 'empty_message', 'Escribí algo primero.');
      }

      const cleanRole = normalizeRole(role);

      if (!incognito) {
        const check = checkLimit(userId, req.user.plan || 'free');
        if (!check.ok) {
          log('warn', 'chat.stream.quota', {
            userId,
            reason: check.reason,
            usado: check.usage?.count,
          });
          return res.status(429).json({
            ok: false,
            error: check.mensaje,
            code: 'quota_exceeded',
          });
        }
      }

      const messages = [
        { role: 'system', content: getSystemPrompt(cleanRole) },
        ...sanitizeHistory(history),
        { role: 'user', content: cleanMessage },
      ];

      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders?.();

      const ac = new AbortController();
      req.on('close', () => ac.abort());

      if (!incognito) consumeLimit(userId);

      let provider = null;
      let fullText = '';
      let tokenCount = 0;

      try {
        for await (const token of streamWithFallback(messages, { signal: ac.signal })) {
          fullText += token;
          tokenCount++;
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
        }
      } catch (err) {
        log('error', 'chat.stream.engine_fail', {
          message: err.message,
          userId,
          role: cleanRole,
          emittedTokens: tokenCount,
        });

        res.write(`data: ${JSON.stringify({
          error: 'Los motores de IA fallaron. Intenta de nuevo en un momento.',
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      res.write(`data: ${JSON.stringify({
        done: true,
        provider: provider || 'auto',
        tokens: tokenCount,
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();

      log('info', 'chat.stream.ok', {
        userId,
        role: cleanRole,
        tokens: tokenCount,
        chars: fullText.length,
        ms: Date.now() - reqStart,
        incognito,
      });

    } catch (err) {
      log('error', 'chat.stream.fatal', {
        message: err.message,
        userId,
        stack: err.stack?.slice(0, 300),
      });

      if (!res.headersSent) {
        return fail(res, 500, 'stream_failed', 'No pudimos procesar tu mensaje.');
      }

      try {
        res.write(`data: ${JSON.stringify({ error: 'Error interno.' })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch {}
    }
  });

  /* ───────────────────────────────────────────────────────────────────
     GET /api/limits/usage
     ─────────────────────────────────────────────────────────────────── */
  app.get('/api/limits/usage', requireAuth, async (req, res) => {
    try {
      const plan = req.user.plan || 'free';
      const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
      const usage = getUsage(req.user.id);
      const restanteDia = Math.max(0, limits.porDia - usage.count);
      const restanteMinuto = Math.max(0, limits.porMinuto - usage.minuteBuckets.length);

      let stats = { chats: 0, messages: 0, memories: 0 };
      try { stats = await getUserStats(req.user.id); } catch {}

      return res.json({
        ok: true,
        plan,
        limites: limits,
        uso: {
          dia: usage.count,
          minuto: usage.minuteBuckets.length,
          ultimaLlamada: usage.minuteBuckets.length > 0
            ? new Date(Math.max(...usage.minuteBuckets)).toISOString()
            : null,
        },
        restanteDia,
        restanteMinuto,
        stats,
      });
    } catch (e) {
      log('error', 'limits.usage.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'usage_failed', 'No pudimos leer tu cuota.');
    }
  });

  /* ───────────────────────────────────────────────────────────────────
     BOOT
     ─────────────────────────────────────────────────────────────────── */
  const enginesAvailable = ENGINES.filter(e => e.available()).map(e => e.name);
  const enginesLine = enginesAvailable.length
    ? enginesAvailable.join(' → ')
    : '⚠️  ninguno (configurá GROQ_API_KEY, GEMINI_API_KEY_*, o KIMI/NVIDIA_API_KEY)';

  console.log(`[chat] rutas montadas · motores: ${enginesLine}`);

  // Si el tercer motor está activo, decir cuál es
  if (KIMI_API_KEY) {
    const vendor = KIMI_BASE_URL.includes('nvidia') ? 'NVIDIA' :
                   KIMI_BASE_URL.includes('moonshot') ? 'Moonshot' : 'Kimi';
    console.log(`[chat] tercer motor: ${vendor} · modelo: ${KIMI_MODEL}`);
  } else {
    console.log('[chat] tercer motor no configurado (KIMI_API_KEY / NVIDIA_API_KEY / MOONSHOT_API_KEY)');
  }

  console.log(`[chat] cuotas: free=50/día · coder=500/día · plus=2000/día · madmax=10000/día`);
}

/* ══════════════════════════════════════════════════════════════════════════
   FIN.
   ══════════════════════════════════════════════════════════════════════════ */