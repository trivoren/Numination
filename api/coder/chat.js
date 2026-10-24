/**
 * Numination · Modo Coder — chat.js
 * POST /api/coder/chat  (Server-Sent Events)
 *
 * Body: {
 *   prompt:   string,   // petición del usuario
 *   code:     string,   // contenido actual de Monaco
 *   filePath: string,   // ruta del archivo abierto
 *   language: string,   // lenguaje detectado
 *   history:  Array<{role, content}>  // contexto breve (opcional)
 * }
 *
 * Evento SSE (JSON en `data:`):
 *   { type: 'meta',  requestId, model }
 *   { type: 'token', text }
 *   { type: 'done',  provider, tokens, durationMs, codeBlock: {...}|null }
 *   { type: 'error', message, code }
 *
 * El system prompt vive en `services/code-prompts.js` (contrato de salida) y
 * el contexto estructural del archivo en `services/context-parser.js`.
 * El stream usa los mismos motores que el chat principal del producto
 * (Groq primero, Gemini de respaldo) vía `src/services/streaming.js`.
 */

import Groq from 'groq-sdk';
import { GoogleGenAI } from '@google/genai';

import { streamGroq, streamGemini } from '../../src/services/streaming.js';
import { buildCoderSystemPrompt, buildCoderUserPrompt, clampCode, extractCodeBlock } from '../../services/code-prompts.js';
import { analyzeCode } from '../../services/context-parser.js';
import { verificarLimite, registrarUso, buildRateLimitHeaders } from '../../src/services/limits.js';
import { withCoderSession } from './_session.js';

/* ── Límites del endpoint ── */
const MAX_PROMPT_LEN = 4_000;
const MAX_HISTORY = 6;
const MAX_HISTORY_CHARS = 3_000;
const FIRST_TOKEN_TIMEOUT_MS = 9_000;
const HEARTBEAT_MS = 15_000;
const MAX_STREAM_MS = 55_000;

/* ── Modelos (clientes creados de forma perezosa) ── */
let groqClient = null;
let geminiClient = null;
let clientsResolved = false;

function sanitizeEnv(v) {
  if (typeof v !== 'string') return v;
  return v.trim().replace(/^["']|["']$/g, '').replace(/[\r\n\t]/g, '');
}

function resolveClients() {
  if (clientsResolved) return;
  clientsResolved = true;
  const groqKey = sanitizeEnv(process.env.GROQ_API_KEY);
  const geminiKey = sanitizeEnv(process.env.GEMINI_API_KEY);
  if (groqKey) groqClient = new Groq({ apiKey: groqKey });
  if (geminiKey) geminiClient = new GoogleGenAI({ apiKey: geminiKey });
}

const GROQ_MODEL = sanitizeEnv(process.env.GROQ_MODEL) || 'openai/gpt-oss-120b';
const GEMINI_MODEL = sanitizeEnv(process.env.GEMINI_MODEL) || 'gemini-3.6-flash';

/**
 * Abre un canal SSE con keep-alive y control de cancelación.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {{ send: (data: object) => boolean, close: () => void, isClosed: () => boolean, signal: AbortSignal }}
 */
function openSSE(req, res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  res.flushHeaders?.();
  try { res.socket?.setNoDelay?.(true); } catch { /* noop */ }
  try { res.socket?.setTimeout?.(0); } catch { /* noop */ }

  let closed = false;
  const controller = new AbortController();
  const onClose = () => { if (!closed) { closed = true; controller.abort('client-disconnected'); } };
  res.on('close', onClose);
  res.on('error', onClose);

  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    if (Date.now() - startedAt > MAX_STREAM_MS) {
      try { res.write(`data: ${JSON.stringify({ type: 'done', reason: 'max_duration' })}\n\n`); } catch { /* noop */ }
      try { res.end(); } catch { /* noop */ }
      onClose();
      clearInterval(heartbeat);
      return;
    }
    try { res.write(': keepalive\n\n'); } catch { onClose(); }
  }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  const startedAt = Date.now();

  return {
    send(data) {
      if (closed || res.writableEnded) return false;
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
        return true;
      } catch {
        onClose();
        return false;
      }
    },
    close() {
      clearInterval(heartbeat);
      if (!closed) { try { res.end(); } catch { /* noop */ } closed = true; controller.abort('graceful'); }
    },
    isClosed: () => closed,
    signal: controller.signal
  };
}

/**
 * Normaliza el historial recibido a un máximo razonable.
 * @param {unknown} history
 * @returns {Array<{role:string, content:string}>}
 */
function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter((m) => m && typeof m.content === 'string' && m.content.trim())
    .slice(-MAX_HISTORY)
    .map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content.slice(0, MAX_HISTORY_CHARS)
    }));
}

/**
 * Handler POST con streaming SSE.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Método no permitido. Usa POST.' });
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'Sesión requerida.', code: 'unauthenticated' });
  }

  const body = req.body ?? {};
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) {
    return res.status(400).json({ ok: false, error: 'La petición está vacía.', code: 'empty_prompt' });
  }
  if (prompt.length > MAX_PROMPT_LEN) {
    return res.status(400).json({
      ok: false,
      error: `La petición supera ${MAX_PROMPT_LEN} caracteres.`,
      code: 'prompt_too_long'
    });
  }

  /* ── Cuota del plan (mismo motor que el chat principal) ── */
  try {
    const lim = await verificarLimite(req);
    buildRateLimitHeaders(res, lim);
    if (lim && lim.permitido === false) {
      if (lim.retryAfter) res.setHeader('Retry-After', String(lim.retryAfter));
      return res.status(429).json({
        ok: false,
        error: lim.mensaje || 'Has alcanzado el límite de uso.',
        code: 'quota_exceeded'
      });
    }
  } catch (err) {
    console.warn('[coder/chat] límites no verificables:', err?.message || err);
  }

  resolveClients();
  if (!groqClient && !geminiClient) {
    return res.status(503).json({
      ok: false,
      error: 'No hay motor de IA disponible en este entorno.',
      code: 'no_provider'
    });
  }

  /* ── Preparación del contexto ── */
  const filePath = typeof body.filePath === 'string' ? body.filePath.slice(0, 180) : 'index.js';
  const language = typeof body.language === 'string' ? body.language.slice(0, 30) : 'javascript';
  const { code, truncated } = clampCode(typeof body.code === 'string' ? body.code : '');
  const history = sanitizeHistory(body.history);
  const { summary } = analyzeCode(code, language);

  const systemPrompt = buildCoderSystemPrompt({ filePath, language, contextSummary: summary });
  const userPrompt = buildCoderUserPrompt({
    instruction: prompt,
    code,
    filePath,
    language,
    history: history.map((m) => `${m.role === 'assistant' ? 'IA' : 'Usuario'}: ${m.content}`).join('\n')
  });

  const sse = openSSE(req, res);
  sse.send({
    type: 'meta',
    requestId: req.id || null,
    filePath,
    language,
    truncated,
    contextChars: code.length
  });

  const started = Date.now();
  let tokens = 0;
  let full = '';
  let provider = null;

  const opts = {
    signal: sse.signal,
    timeoutMs: FIRST_TOKEN_TIMEOUT_MS,
    temperature: 0.2,   // baja temperatura: menos creatividad, más fidelidad al archivo
    maxTokens: 8192,
    model: undefined
  };

  const engines = [];
  if (groqClient) engines.push({ name: 'groq', run: () => streamGroq(groqClient, systemPrompt, userPrompt, null, { ...opts, model: GROQ_MODEL }) });
  if (geminiClient) engines.push({ name: 'gemini', run: () => streamGemini(geminiClient, systemPrompt, userPrompt, null, { ...opts, model: GEMINI_MODEL }) });

  for (const engine of engines) {
    if (sse.isClosed()) break;
    try {
      const gen = engine.run();
      for await (const token of gen) {
        if (sse.isClosed()) break;
        if (!token) continue;
        tokens += 1;
        full += token;
        sse.send({ type: 'token', text: token });
      }
      if (tokens > 0) { provider = engine.name; break; }
      throw new Error(`${engine.name} no devolvió tokens`);
    } catch (err) {
      const aborted = err?.name === 'AbortError' || sse.isClosed();
      console.warn(`[coder/chat] motor ${engine.name} falló:`, err?.message || err);
      if (aborted) break;
      if (tokens > 0) { provider = `${engine.name}-partial`; break; }
    }
  }

  if (sse.isClosed()) return; // cliente desconectado: nada que cerrar

  if (!tokens) {
    sse.send({ type: 'error', message: 'El modelo no pudo generar una respuesta.', code: 'no_tokens' });
    sse.close();
    return;
  }

  const codeBlock = extractCodeBlock(full);
  sse.send({
    type: 'done',
    provider,
    tokens,
    durationMs: Date.now() - started,
    codeBlock: codeBlock ? { language: codeBlock.language, code: codeBlock.code } : null
  });
  sse.close();

  /* ── Contabilidad (no bloquea la respuesta) ── */
  try { registrarUso(req).catch(() => {}); } catch { /* noop */ }
  console.log(`[coder/chat] user=${userId} provider=${provider} tokens=${tokens} ${Date.now() - started}ms`);
}

export default withCoderSession(handler);
