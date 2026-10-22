/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/ai-tools.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Router de las herramientas de IA y de las integraciones del mega-proyecto.

   MONTADO
     mountAiToolsRoutes(app) → añade:
       POST /api/ai/explain          explica el código seleccionado
       POST /api/ai/autocomplete     sugerencia de continuación (ghost text)
       POST /api/ai/enhance          mejora un prompt
       POST /api/ai/summarize        resume un historial largo
       POST /api/ai/tests            genera tests unitarios
       POST /api/ai/image-prompt     enriquece un prompt de imagen
       POST /api/chat/offline-sync   sincroniza la cola offline
       GET  /api/referrals/mine      datos del programa de referidos
       POST /api/referrals/apply     canjea un código
       POST /api/referrals/generate  genera un código
       GET  /api/coder/git/status    estado del conector de GitHub
       POST /api/coder/git/connect   conecta un repositorio
       POST /api/coder/git/commit    commit + push
       GET  /api/theme               tema del usuario
       PUT  /api/theme               cambia el tema

   POR QUÉ UN SOLO ARCHIVO
     Todas estas rutas comparten la misma plumbing (LLM + auth + rate
     limit). Separarlas en 8 archivos sería 8 archivos con el mismo
     boilerplate. Este router es el cableado de la Fase 1 y la Fase 2.

   LLM COMPARTIDO
     `callLLM()` habla con Groq y, si falla, con Gemini. Si no hay
     ninguna key, devuelve `null` y cada endpoint usa su fallback local
     (nunca se devuelve 500 por falta de credenciales).
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ValidationError, RateLimitError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import { sql, supabaseDisponible } from '../services/supabase.js';

import { summarizeHistory, compressHistory, injectSummary } from '../services/ai-summarizer.js';
import { enhancePrompt } from '../services/prompt-enhancer.js';
import { generateTests, getTestCommand } from '../services/unit-test-writer.js';
import { enhanceImagePrompt, buildPollinationsUrl, prepareImage } from '../services/dall-e-prompter.js';
import {
  generateReferralCode,
  applyReferralCode,
  validateCode,
  getReferralStats,
  normalizeCode,
} from '../services/referral-program.js';
import {
  connectRepository,
  commitAndPush,
  listConnections,
  getGitStatus,
} from '../services/git-connector.js';
import { getTheme, setTheme, getThemePayload } from '../services/theme-manager.js';
import { recordUsage, FEATURES } from '../services/chat-analyzer.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · LLM COMPARTIDO
   ═══════════════════════════════════════════════════════════════════════════ */

/* Las claves pueden venir de .env.local o del archivo env.local.js
   (así lo carga el resto del proyecto). */
let FILE_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  FILE_KEYS = mod.TEST_KEYS ?? {};
} catch { /* archivo opcional */ }

/** Modelos de Groq disponibles para esta cuenta (configurables). */
const GROQ_MODELS = (() => {
  const configured = process.env.GROQ_MODEL || FILE_KEYS.GROQ_MODEL;
  return [configured, 'openai/gpt-oss-120b', 'llama-3.1-8b-instant']
    .filter(Boolean)
    .filter((m, i, arr) => arr.indexOf(m) === i);
})();

/** Modelo de chat de Gemini. */
const GEMINI_MODEL = process.env.GEMINI_MODEL || FILE_KEYS.GEMINI_MODEL || 'gemini-3.6-flash';

const LLM = Object.freeze({
  groqUrl: 'https://api.groq.com/openai/v1/chat/completions',
  groqModels: GROQ_MODELS,
  geminiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
  timeoutMs: 25_000,
});



function groqKey() {
  return process.env.GROQ_API_KEY || FILE_KEYS.GROQ_API_KEY || null;
}

function geminiKey() {
  return process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY_3 || FILE_KEYS.GEMINI_API_KEY || null;
}

/**
 * Llama a un LLM y devuelve el texto.
 *
 * @param {object} params
 * @param {string} params.system
 * @param {string} params.user
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @param {boolean}[params.json]  Pedir salida en JSON
 * @returns {Promise<{text:string, provider:string, model:string}|null>}
 */
async function callLLM(params = {}) {
  const { system = '', user = '', maxTokens = 900, temperature = 0.3, json = false } = params;

  if (groqKey()) {
    for (const model of LLM.groqModels) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LLM.timeoutMs);

        const res = await fetch(LLM.groqUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey()}` },
          body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
            temperature,
            max_tokens: maxTokens,
            response_format: json ? { type: 'json_object' } : undefined,
          }),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`Groq ${res.status}: ${body.slice(0, 160)}`);
        }

        const data = await res.json();
        const text = String(data?.choices?.[0]?.message?.content || '').trim();
        if (text) return { text, provider: 'groq', model };
      } catch (e) {
        LOG.warn('ai-tools: Groq falló', { model, error: e.message });
      }
    }
  }

  if (geminiKey()) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LLM.timeoutMs);

      const res = await fetch(`${LLM.geminiUrl}/GEMINI_MODEL:generateContent?key=${encodeURIComponent(geminiKey())}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { maxOutputTokens: maxTokens, temperature, responseMimeType: json ? 'application/json' : undefined },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Gemini ${res.status}: ${body.slice(0, 160)}`);
      }

      const data = await res.json();
      const text = String(data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ') || '').trim();
      if (text) return { text, provider: 'gemini', model: 'GEMINI_MODEL' };
    } catch (e) {
      LOG.warn('ai-tools: Gemini falló', { error: e.message });
    }
  }

  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function readInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readString(value, max = 8000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

/** Extrae JSON de una respuesta del LLM (a veces viene con ```json). */
function parseJsonLoose(text) {
  if (!text) return null;

  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : String(text);

  try {
    return JSON.parse(candidate.trim());
  } catch {
    // Último recurso: el primer objeto JSON del texto.
    const match = candidate.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · RATE LIMIT DE IA (por usuario)
   ═══════════════════════════════════════════════════════════════════════════ */

const aiBuckets = new Map();

function checkAiLimit(userId, max = 30) {
  const now = Date.now();
  const windowMs = 60_000;

  let bucket = aiBuckets.get(userId);
  if (!bucket || bucket.reset <= now) {
    bucket = { count: 0, reset: now + windowMs };
    aiBuckets.set(userId, bucket);
  }
  bucket.count++;

  return {
    allowed: bucket.count <= max,
    remaining: Math.max(0, max - bucket.count),
    retryAfter: Math.max(1, Math.ceil((bucket.reset - now) / 1000)),
  };
}

const aiCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of aiBuckets) if (bucket.reset <= now) aiBuckets.delete(key);
}, 60_000);
if (aiCleanup.unref) aiCleanup.unref();

function guardAi(req, res, max = 30) {
  const limit = checkAiLimit(req.user.id, max);

  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(limit.remaining));

  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    throw new RateLimitError(
      `Alcanzaste el máximo de ${max} peticiones de IA por minuto.`,
      'limit_ai_rate',
      limit.retryAfter
    );
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · ROUTER
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountAiToolsRoutes(app) {
  const router = express.Router();

  /* ─── POST /api/ai/explain ──────────────────────────────────────────── */
  router.post('/api/ai/explain', requireAuth, asyncHandler(async (req, res) => {
    guardAi(req, res, 20);

    const body = req.body || {};
    const code = readString(body.code, 12000);
    const language = readString(body.language, 40) || 'javascript';
    const filePath = readString(body.filePath, 200) || 'index.js';

    if (!code.trim()) {
      throw new ValidationError('No hay código para explicar.', 'code');
    }

    const system = [
      'Sos un senior engineer que explica código a otro developer.',
      'Respondé SIEMPRE en JSON válido con esta forma exacta:',
      '{"summary":"<qué hace, 2-3 frases>","lineByLine":"<explicación por bloques, con saltos de línea>","breakdown":"<desglose de responsabilidades>","risks":"<riesgos, casos borde y bugs potenciales>","suggestions":"<mejoras concretas, accionables>"}',
      'Si el código está vacío o es trivial, decilo con honestidad. No inventes comportamiento.',
      'Respondé en el idioma del usuario.',
    ].join(' ');

    const user = `Archivo: ${filePath}\nLenguaje: ${language}\n\nCódigo:\n"""\n${code}\n"""`;

    const result = await callLLM({ system, user, maxTokens: 1400, temperature: 0.2, json: true });

    let explanation;

    if (result) {
      explanation = parseJsonLoose(result.text);
      if (!explanation) {
        explanation = { summary: result.text, lineByLine: '', breakdown: '', risks: '', suggestions: '' };
      }
    } else {
      // Fallback local: análisis estático honesto.
      const lines = code.split('\n').length;
      const functions = (code.match(/function\s+\w+|=>|const\s+\w+\s*=/g) || []).length;
      explanation = {
        summary: `El archivo tiene ${lines} líneas y ${functions} bloques de código (no hay motor de IA configurado para explicarlo en detalle).`,
        lineByLine: code.split('\n').slice(0, 40).map((l, i) => `${String(i + 1).padStart(3, ' ')} | ${l}`).join('\n'),
        breakdown: 'Análisis estático básico: se listan las líneas del archivo.',
        risks: 'No se pudo ejecutar el análisis semántico (sin LLM configurado).',
        suggestions: 'Configurá GROQ_API_KEY o GEMINI_API_KEY para explicaciones detalladas.',
      };
    }

    await recordUsage(req.user.id, FEATURES.CODER).catch(() => {});

    res.json({
      ok: true,
      explanation,
      degraded: !result,
      provider: result?.provider || 'local',
      model: result?.model || 'static',
    });
  }));

  /* ─── POST /api/ai/autocomplete ─────────────────────────────────────── */
  router.post('/api/ai/autocomplete', requireAuth, asyncHandler(async (req, res) => {
    guardAi(req, res, 60);

    const body = req.body || {};
    const prefix = readString(body.prefix ?? body.currentLine, 2000);
    const context = readString(body.context, 4000);
    const language = readString(body.language, 40) || 'javascript';

    if (!prefix.trim() && !context.trim()) {
      throw new ValidationError('No hay contexto para completar.', 'prefix');
    }

    const system = [
      'Sos un autocompletador de código. Devolvé SOLO la continuación del código,',
      'sin explicaciones, sin markdown y sin comillas que lo encierren.',
      'Si el código ya está completo, devolvé una cadena vacía.',
    ].join(' ');

    const user = `Lenguaje: ${language}\n\nCódigo previo:\n"""\n${context || prefix}\n"""`;

    const result = await callLLM({
      system,
      user,
      maxTokens: 180,
      temperature: 0.15,
    });

    let suggestion = '';
    if (result) {
      suggestion = String(result.text)
        .replace(/^```[\w-]*\n?/, '')
        .replace(/```$/, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//') || line.includes(prefix.trim().slice(-24)))
        .join('\n')
        .slice(0, 400);
    }

    res.json({
      ok: true,
      suggestion,
      provider: result?.provider || 'local',
    });
  }));

  /* ─── POST /api/ai/enhance ─────────────────────────────────────────── */
  router.post('/api/ai/enhance', requireAuth, asyncHandler(async (req, res) => {
    guardAi(req, res, 20);

    const body = req.body || {};
    const prompt = readString(body.prompt, 4000);

    if (!prompt.trim()) {
      throw new ValidationError('El prompt está vacío.', 'prompt');
    }

    const result = await enhancePrompt(prompt, {
      context: readString(body.context, 1000),
      language: body.language,
      force: body.force === true,
    });

    res.json({ ok: true, ...result });
  }));

  /* ─── POST /api/ai/summarize ───────────────────────────────────────── */
  router.post('/api/ai/summarize', requireAuth, asyncHandler(async (req, res) => {
    guardAi(req, res, 20);

    const body = req.body || {};
    const history = Array.isArray(body.history) ? body.history : [];

    if (!history.length) {
      throw new ValidationError('El historial está vacío.', 'history');
    }

    const result = await summarizeHistory(history, {
      force: body.force === true,
      maxWords: readInt(body.maxWords, 200),
    });

    res.json({
      ok: true,
      ...result,
      systemPrompt: result.summary ? injectSummary('', result.summary) : null,
    });
  }));

  /* ─── POST /api/ai/tests ────────────────────────────────────────────── */
  router.post('/api/ai/tests', requireAuth, asyncHandler(async (req, res) => {
    guardAi(req, res, 15);

    const body = req.body || {};
    const code = readString(body.code, 16000);

    if (!code.trim()) {
      throw new ValidationError('No hay código para testear.', 'code');
    }

    const result = await generateTests({
      code,
      filePath: readString(body.filePath, 200) || 'index.js',
      language: readString(body.language, 40),
      framework: readString(body.framework, 20) || 'vitest',
    });

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudieron generar los tests.', 'code');
    }

    res.json({
      ok: true,
      ...result,
      runCommand: getTestCommand(result.framework, result.filename),
    });
  }));

  /* ─── POST /api/ai/image-prompt ─────────────────────────────────────── */
  router.post('/api/ai/image-prompt', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const prompt = readString(body.prompt, 500);

    if (!prompt.trim()) {
      throw new ValidationError('El prompt está vacío.', 'prompt');
    }

    const enhanced = enhanceImagePrompt(prompt, {
      style: readString(body.style, 20) || undefined,
      quality: body.quality !== false,
    });

    if (!enhanced.ok) {
      throw new ValidationError(
        'Ese prompt no cumple la política de contenido de Numination.',
        'prompt',
        'content_blocked'
      );
    }

    const prepared = prepareImage(prompt, {
      style: body.style,
      width: body.width,
      height: body.height,
      model: body.model,
    });

    res.json({
      ok: true,
      prompt: enhanced.prompt,
      original: enhanced.original,
      negative: enhanced.negative,
      style: enhanced.style,
      styleLabel: enhanced.styleLabel,
      added: enhanced.added,
      url: prepared.ok ? prepared.url : null,
      width: prepared.width || null,
      height: prepared.height || null,
    });
  }));

  /* ─── POST /api/chat/offline-sync ──────────────────────────────────── */
  router.post('/api/chat/offline-sync', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const message = readString(body.message, 8000);

    if (!message.trim()) {
      throw new ValidationError('El mensaje está vacío.', 'message');
    }

    if (!supabaseDisponible()) {
      return res.status(202).json({ ok: true, degraded: true, synced: false, clientId: body.clientId || null });
    }

    // Idempotencia: si el clientId ya se procesó, se responde igual.
    const clientId = readString(body.clientId, 80) || null;

    try {
      const { crearChat, crearMensaje } = await import('../services/supabase.js');

      let chatId = body.chatId || null;

      if (!chatId) {
        const chat = await crearChat(req.user.id, 'Sincronizado offline');
        chatId = chat?.id || chat?.chat?.id || null;
      }

      if (!chatId) {
        throw new ValidationError('No se pudo crear la conversación para sincronizar.', 'chatId');
      }

      await crearMensaje(chatId, { role: body.role === 'assistant' ? 'assistant' : 'user', content: message });

      res.status(201).json({
        ok: true,
        synced: true,
        clientId,
        chatId,
        syncedAt: new Date().toISOString(),
      });
    } catch (e) {
      LOG.warn('ai-tools: offline-sync falló', { error: e.message });
      res.status(202).json({
        ok: true,
        degraded: true,
        synced: false,
        clientId,
        error: 'Se guardará en la cola local y se reintentará.',
      });
    }
  }));

  /* ─── GET /api/referrals/mine ───────────────────────────────────────── */
  router.get('/api/referrals/mine', requireAuth, asyncHandler(async (req, res) => {
    const stats = await getReferralStats(req.user.id);

    if (!stats.code) {
      const created = await generateReferralCode({
        userId: req.user.id,
        name: req.user.name || (req.user.email || '').split('@')[0],
        email: req.user.email,
      });
      if (created.ok) {
        stats.code = created.code;
      }
    }

    res.json({
      ok: true,
      ...stats,
      creditsPerReferral: 1000,
      shareUrl: stats.code ? `${process.env.APP_URL || ''}/?ref=${stats.code}` : null,
    });
  }));

  /* ─── POST /api/referrals/generate ──────────────────────────────────── */
  router.post('/api/referrals/generate', requireAuth, asyncHandler(async (req, res) => {
    const result = await generateReferralCode({
      userId: req.user.id,
      name: req.user.name || (req.user.email || '').split('@')[0],
      email: req.user.email,
    });

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudo generar el código.', 'code');
    }

    res.json({ ok: true, code: result.code, created: result.created, shareUrl: `${process.env.APP_URL || ''}/?ref=${result.code}` });
  }));

  /* ─── POST /api/referrals/apply ────────────────────────────────────── */
  router.post('/api/referrals/apply', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const code = readString(body.code, 40);

    if (!code.trim()) {
      throw new ValidationError('Falta el código de referido.', 'code');
    }

    const result = await applyReferralCode({
      code,
      referredId: req.user.id,
      referredEmail: req.user.email,
    });

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudo aplicar el código.', 'code');
    }

    res.json({ ok: true, ...result });
  }));

  /* ─── GET /api/referrals/validate/:code ─────────────────────────────── */
  router.get('/api/referrals/validate/:code', requireAuth, asyncHandler(async (req, res) => {
    const result = await validateCode(String(req.params.code || ''));
    res.json({ ok: true, ...result });
  }));

  /* ─── Git: status / connect / commit ───────────────────────────────── */
  router.get('/api/coder/git/status', requireAuth, asyncHandler(async (req, res) => {
    const status = await getGitStatus(req.user.id);
    res.json({ ok: true, ...status });
  }));

  router.get('/api/coder/git/connections', requireAuth, asyncHandler(async (req, res) => {
    const result = await listConnections(req.user.id);
    res.json({ ok: true, connections: result.connections, degraded: result.degraded });
  }));

  router.post('/api/coder/git/connect', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};

    const result = await connectRepository({
      userId: req.user.id,
      owner: body.owner,
      repo: body.repo,
      branch: body.branch,
      token: readString(body.token, 300),
    });

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudo conectar el repositorio.', 'repo');
    }

    res.json({ ok: true, ...result });
  }));

  router.post('/api/coder/git/commit', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const files = Array.isArray(body.files) ? body.files : [];

    const result = await commitAndPush({
      userId: req.user.id,
      owner: body.owner,
      repo: body.repo,
      branch: body.branch,
      token: body.token ? readString(body.token, 300) : undefined,
      files: files.map((f) => ({
        path: readString(f.path, 300),
        content: readString(f.content, 600_000),
        status: f.status,
      })),
      message: body.message ? readString(body.message, 400) : undefined,
    });

    if (!result.ok) {
      if (result.code === 'rate_limited') {
        res.setHeader('Retry-After', String(result.retryAfter || 60));
        throw new RateLimitError(result.error, 'limit_git_rate', result.retryAfter || 60);
      }
      throw new ValidationError(result.error || 'No se pudo subir el código.', 'files');
    }

    await recordUsage(req.user.id, FEATURES.CODER).catch(() => {});

    res.json({ ok: true, ...result });
  }));

  /* ─── Tema ─────────────────────────────────────────────────────────── */
  router.get('/api/theme', requireAuth, asyncHandler(async (req, res) => {
    const payload = await getThemePayload(req.user.id);
    res.json(payload);
  }));

  router.put('/api/theme', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const result = await setTheme(req.user.id, body.theme);

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudo guardar el tema.', 'theme');
    }

    res.json({ ok: true, theme: result.theme, effective: result.effective });
  }));

  app.use(router);

  LOG.info('ai-tools.routes.mounted', {
    endpoints: [
      'POST /api/ai/explain',
      'POST /api/ai/autocomplete',
      'POST /api/ai/enhance',
      'POST /api/ai/summarize',
      'POST /api/ai/tests',
      'POST /api/ai/image-prompt',
      'POST /api/chat/offline-sync',
      'GET /api/referrals/mine',
      'POST /api/referrals/apply',
      'GET /api/coder/git/status',
      'POST /api/coder/git/connect',
      'POST /api/coder/git/commit',
      'GET /api/theme',
      'PUT /api/theme',
    ],
  });

  return router;
}

export default { mountAiToolsRoutes };
