/* ================================================================
   NUMINATION · streaming.js · v2.0
   ----------------------------------------------------------------
   Motor de streaming multi-proveedor con:

     · Historial de conversación (últimos N mensajes, configurable)
     · Retry con backoff exponencial (para 429/503)
     · Timeout de primer token configurable
     · Soporte de AbortSignal para cancelación limpia
     · Detección y clasificación de errores
     · Modo razonamiento con etiquetas <thinking>
     · Normalización de roles por proveedor
     · Métricas: duración, tokens, TPS
     · Callbacks opcionales: onToken, onMeta, onDone, onError

   PROVEEDORES SOPORTADOS:

     · Groq              → OpenAI-compatible
     · Google Gemini     → SDK @google/genai
     · NVIDIA NIM (Kimi) → OpenAI-compatible
     · Cualquier OpenAI-compatible (OpenRouter, DeepSeek, Together, etc.)
       con createOpenAIStreamer()

   API PÚBLICA (misma firma que v1.0, compatible):

     streamGroq(groq, system, message, file, opts)      → AsyncGenerator<string>
     streamGemini(gemini, system, message, file, opts)  → AsyncGenerator<string>

   API PÚBLICA NUEVA:

     streamKimi(nvidia, system, message, file, opts)    → AsyncGenerator<string>
     createOpenAIStreamer(cfg)                          → función que devuelve generator

   EXPORTS ADICIONALES (helpers para el caller):

     REASONING_PREFIX       — prefijo modo razonamiento
     normalizeHistory       — limpia/normaliza array de mensajes
     mergeConsecutiveRoles  — fusiona roles consecutivos (Gemini)
     estimateTokens         — estima tokens desde caracteres
     extractThinking        — separa <thinking> de la respuesta
     classifyError          — tipifica errores del motor
     ENGINE_CONFIG          — límites y defaults por motor

   OPCIONES (opts) ACEPTADAS:

     reasoning   boolean  → modo razonamiento con <thinking>
     history     array    → [{role:'user'|'assistant', content:string}]
     signal      AbortSignal
     timeoutMs   number   → timeout del primer token (default 25000)
     temperature number
     maxTokens   number
     model       string   → override del modelo por defecto
     retries     number   → intentos extra para 429/503 (default 2)
     onToken     function → callback(token)
     onMeta      function → callback({elapsedMs, provider})
     onDone      function → callback({tokens, chars, elapsedMs, tps, provider})
     onError     function → callback(err)
   ================================================================ */

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN POR MOTOR
   ═══════════════════════════════════════════════════════════════════════ */

const ENGINE_CONFIG = Object.freeze({
  groq: {
    name: 'Groq',
    model: 'openai/gpt-oss-120b',
    temperature: 0.7,
    reasoningTemperature: 0.5,
    maxTokens: 2048,
    reasoningMaxTokens: 4096,
    firstTokenTimeoutMs: 25_000,
    retries: 2,
    backoffBaseMs: 400,
  },
  gemini: {
    name: 'Gemini',
    model: 'gemini-3.6-flash',
    temperature: 0.7,
    reasoningTemperature: 0.5,
    maxTokens: 2048,
    reasoningMaxTokens: 4096,
    firstTokenTimeoutMs: 25_000,
    retries: 2,
    backoffBaseMs: 400,
    thinkingBudgetReasoning: 2000,
    thinkingBudgetNormal: 0,
  },
  nvidia: {
    name: 'Kimi K3',
    model: 'moonshotai/kimi-k3',
    temperature: 0.7,
    reasoningTemperature: 0.5,
    maxTokens: 2048,
    reasoningMaxTokens: 4096,
    firstTokenTimeoutMs: 25_000,
    retries: 2,
    backoffBaseMs: 400,
  },
});

const HISTORY_MAX_MESSAGES = 20;
const HISTORY_MAX_CHARS    = 6000;

/* ═══════════════════════════════════════════════════════════════════════
   2 · PROMPT MODO RAZONAMIENTO
   ═══════════════════════════════════════════════════════════════════════ */

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

/* ═══════════════════════════════════════════════════════════════════════
   3 · UTILIDADES DE HISTORIAL
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Normaliza el historial que llega del frontend.
 * - Acepta [{role, content}, ...]
 * - Filtra entradas inválidas o vacías
 * - Recorta al máximo de mensajes
 * - Recorta el total de caracteres (evita prompts gigantes)
 *
 * @param {Array} raw
 * @param {number} maxMsgs  default HISTORY_MAX_MESSAGES
 * @returns {Array<{role:'user'|'assistant', content:string}>}
 */
export function normalizeHistory(raw, maxMsgs = HISTORY_MAX_MESSAGES) {
  if (!Array.isArray(raw)) return [];

  const clean = [];
  let totalChars = 0;

  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;

    // Normalizar rol
    let role = null;
    if (m.role === 'assistant' || m.role === 'ai' || m.role === 'model') {
      role = 'assistant';
    } else if (m.role === 'user' || m.role === 'human') {
      role = 'user';
    } else if (m.role === 'system') {
      continue; // ignoramos system del historial (lo inyectamos nosotros)
    }
    if (!role) continue;

    // Normalizar contenido
    const content = typeof m.content === 'string'
      ? m.content
      : String(m.content ?? '');
    const trimmed = content.trim();
    if (!trimmed) continue;

    // Recortar si ya pasamos el límite
    if (totalChars + trimmed.length > HISTORY_MAX_CHARS) {
      // Si el mensaje es muy largo, lo recortamos
      const remaining = Math.max(0, HISTORY_MAX_CHARS - totalChars);
      if (remaining < 100) break;
      clean.push({ role, content: trimmed.slice(0, remaining) + '…' });
      totalChars = HISTORY_MAX_CHARS;
      break;
    }

    clean.push({ role, content: trimmed });
    totalChars += trimmed.length;
  }

  // Solo los últimos N
  return clean.slice(-maxMsgs);
}

/**
 * Fusiona mensajes consecutivos del mismo rol.
 * Gemini (y algunos otros) exigen roles alternados user/model.
 */
export function mergeConsecutiveRoles(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const out = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += '\n\n' + m.content;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · UTILIDADES DE TOKENS Y THINKING
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Estimación grosera de tokens (4 chars ≈ 1 token para texto ES/EN).
 * Suficiente para logging. No usar para facturación.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/**
 * Separa el contenido entre <thinking>...</thinking> y la respuesta final.
 * Útil para procesar la respuesta completa después del stream.
 *
 * @returns {{ thinking: string|null, answer: string }}
 */
export function extractThinking(raw) {
  if (!raw) return { thinking: null, answer: '' };
  const s = String(raw);
  const m = s.match(/<thinking>([\s\S]*?)<\/thinking>([\s\S]*)/);
  if (!m) return { thinking: null, answer: s };
  return {
    thinking: m[1].trim(),
    answer: m[2].trim(),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · CLASIFICACIÓN DE ERRORES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Tipifica el error para tomar decisiones (reintentar, cambiar motor, etc).
 *
 * @returns {{
 *   kind: 'rate_limit'|'auth'|'model_missing'|'timeout'|'network'|'client_abort'|'unknown',
 *   status?: number,
 *   retryable: boolean,
 *   message: string
 * }}
 */
export function classifyError(err) {
  const msg = String(err?.message || '').toLowerCase();
  const status = err?.status ?? err?.code ?? err?.response?.status ?? 0;

  if (msg.includes('aborted') && !msg.includes('timeout')) {
    return { kind: 'client_abort', retryable: false, message: err.message };
  }
  if (msg.includes('timeout') || msg.includes('etimedout')) {
    return { kind: 'timeout', retryable: true, message: err.message, status };
  }
  if (status === 429 || msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) {
    return { kind: 'rate_limit', retryable: true, message: err.message, status };
  }
  if (status === 503 || msg.includes('503') || msg.includes('overloaded')) {
    return { kind: 'rate_limit', retryable: true, message: err.message, status };
  }
  if (status === 401 || status === 403 || msg.includes('unauthorized') || msg.includes('invalid api key')) {
    return { kind: 'auth', retryable: false, message: err.message, status };
  }
  if (status === 404 || msg.includes('model not found') || msg.includes('not found')) {
    return { kind: 'model_missing', retryable: false, message: err.message, status };
  }
  if (msg.includes('fetch failed') || msg.includes('econnreset') || msg.includes('enotfound')) {
    return { kind: 'network', retryable: true, message: err.message };
  }
  return { kind: 'unknown', retryable: false, message: err.message, status };
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · UTILIDADES INTERNAS
   ═══════════════════════════════════════════════════════════════════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Backoff exponencial con jitter. Base 400ms → 400, 800, 1600, 3200...
 * Jitter: ±30% para evitar thundering herd.
 */
function backoffDelay(attempt, baseMs) {
  const exp = baseMs * Math.pow(2, attempt);
  const jitter = (Math.random() * 0.6 - 0.3) * exp;
  return Math.max(baseMs, Math.round(exp + jitter));
}

/**
 * Construye el bloque de mensajes para APIs OpenAI-compatible.
 * [system] + [...historial] + [user actual]
 */
function buildOpenAIMessages(systemPrompt, userContent, history) {
  const messages = [{ role: 'system', content: systemPrompt }];
  if (Array.isArray(history)) {
    for (const m of history) messages.push(m);
  }
  messages.push({ role: 'user', content: userContent });
  return messages;
}

/**
 * Añade la nota de archivo adjunto al mensaje.
 */
function withFileNote(content, file) {
  if (!file || !file.data) return content;
  return content + '\n\n[El usuario adjuntó un archivo. Responde con la información disponible.]';
}

/**
 * Timeout del primer token — Promise.race entre el próximo yield
 * y un timer. Si el timer gana, tira error tipificado.
 */
function withFirstTokenTimeout(iterator, timeoutMs, engineName) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`${engineName} no envió primer token en ${timeoutMs}ms`);
      err.name = 'TimeoutError';
      err.kind = 'timeout';
      reject(err);
    }, timeoutMs);

    iterator.next()
      .then((res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Construye el mensaje final del usuario (con modo razonamiento si aplica).
 */
function buildUserContent(message, reasoning, file) {
  const base = message || (reasoning ? '' : '(sin texto)');
  const text = reasoning ? REASONING_PREFIX + base : base;
  return withFileNote(text, file);
}

/**
 * Emite las métricas finales si el callback existe.
 */
function emitDone(opts, provider, stats) {
  if (typeof opts.onDone === 'function') {
    try { opts.onDone({ provider, ...stats }); } catch {}
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · STREAMER GENÉRICO OPENAI-COMPATIBLE
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Factory: crea un async generator para cualquier API OpenAI-compatible.
 * Usalo así:
 *
 *   const streamDeepSeek = createOpenAIStreamer({
 *     name: 'DeepSeek',
 *     model: 'deepseek-chat',
 *     call: (client, params, signal) =>
 *       client.chat.completions.create(params, { signal }),
 *   });
 *
 * Y luego:
 *
 *   for await (const token of streamDeepSeek(client, system, msg, file, opts)) {
 *     process.stdout.write(token);
 *   }
 */
export function createOpenAIStreamer(cfg) {
  const {
    name = 'OpenAI-compatible',
    model,
    temperature = 0.7,
    reasoningTemperature = 0.5,
    maxTokens = 2048,
    reasoningMaxTokens = 4096,
    firstTokenTimeoutMs = 25_000,
    retries = 2,
    backoffBaseMs = 400,
    call,
  } = cfg;

  return async function* streamer(client, systemPrompt, message, file, opts = {}) {
    const reasoning = Boolean(opts.reasoning);
    const history = normalizeHistory(opts.history);
    const userContent = buildUserContent(message, reasoning, file);

    const params = {
      model: opts.model || model,
      messages: buildOpenAIMessages(systemPrompt, userContent, history),
      temperature: opts.temperature ?? (reasoning ? reasoningTemperature : temperature),
      max_tokens: opts.maxTokens ?? (reasoning ? reasoningMaxTokens : maxTokens),
      stream: true,
    };

    let lastErr;
    const maxAttempts = (opts.retries ?? retries) + 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        const delay = backoffDelay(attempt - 1, backoffBaseMs);
        await sleep(delay);
      }

      const t0 = Date.now();
      let tokens = 0;
      let chars = 0;
      let first = true;

      try {
        const iterator = call(client, params, opts.signal)[Symbol.asyncIterator]();

        // Esperar el primer token con timeout
        const firstResult = await withFirstTokenTimeout(
          iterator,
          opts.timeoutMs ?? firstTokenTimeoutMs,
          name,
        );

        if (firstResult.done) {
          // Stream vacío de una
          lastErr = new Error(`${name} no devolvió tokens`);
          continue;
        }

        // Procesar el primer token (con posible delta.content)
        let chunk = firstResult.value;
        let token = chunk?.choices?.[0]?.delta?.content;
        if (token) {
          first = false;
          tokens++;
          chars += token.length;
          if (typeof opts.onToken === 'function') {
            try { opts.onToken(token); } catch {}
          }
          yield token;
        }

        // Primer token OK: emitimos meta
        if (typeof opts.onMeta === 'function') {
          try { opts.onMeta({ elapsedMs: Date.now() - t0, provider: name }); } catch {}
        }

        // Resto del stream
        for await (const chunk of iterator) {
          if (opts.signal?.aborted) {
            const err = new Error('aborted by client');
            err.name = 'AbortError';
            throw err;
          }
          token = chunk?.choices?.[0]?.delta?.content;
          if (!token) continue;
          first = false;
          tokens++;
          chars += token.length;
          if (typeof opts.onToken === 'function') {
            try { opts.onToken(token); } catch {}
          }
          yield token;
        }

        // Stream completado OK
        const elapsedMs = Date.now() - t0;
        emitDone(opts, name, {
          tokens,
          chars,
          elapsedMs,
          tps: elapsedMs > 0 ? (tokens / (elapsedMs / 1000)).toFixed(1) : '0',
        });
        return;
      } catch (err) {
        lastErr = err;
        const kind = classifyError(err);
        const isLast = attempt === maxAttempts - 1;

        // Si el stream ya emitió tokens, no reintentamos: el usuario ya vio algo
        if (tokens > 0) throw err;

        // Cliente abortó: no reintentamos
        if (kind.kind === 'client_abort') throw err;

        // Si no es retryable o es el último intento → tirar
        if (!kind.retryable || isLast) throw err;

        if (typeof opts.onError === 'function') {
          try { opts.onError({ kind: kind.kind, attempt, willRetry: true, err }); } catch {}
        }
        // continuar al siguiente intento
      }
    }

    if (lastErr) throw lastErr;
    throw new Error(`${name} falló sin error específico`);
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   8 · GROQ
   ═══════════════════════════════════════════════════════════════════════ */

export async function* streamGroq(groq, systemPrompt, message, file, opts = {}) {
  const cfg = ENGINE_CONFIG.groq;
  const reasoning = Boolean(opts.reasoning);
  const history = normalizeHistory(opts.history);
  const userContent = buildUserContent(message, reasoning, file);

  const params = {
    model: opts.model || cfg.model,
    messages: buildOpenAIMessages(systemPrompt, userContent, history),
    temperature: opts.temperature ?? (reasoning ? cfg.reasoningTemperature : cfg.temperature),
    max_tokens: opts.maxTokens ?? (reasoning ? cfg.reasoningMaxTokens : cfg.maxTokens),
    stream: true,
  };

  let lastErr;
  const maxAttempts = (opts.retries ?? cfg.retries) + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(backoffDelay(attempt - 1, cfg.backoffBaseMs));

    const t0 = Date.now();
    let tokens = 0;
    let chars = 0;

    try {
      const stream = await groq.chat.completions.create(params, { signal: opts.signal });
      const iterator = stream[Symbol.asyncIterator]();

      const firstResult = await withFirstTokenTimeout(
        iterator,
        opts.timeoutMs ?? cfg.firstTokenTimeoutMs,
        cfg.name,
      );

      if (firstResult.done) {
        lastErr = new Error('Groq no devolvió tokens');
        continue;
      }

      let token = firstResult.value?.choices?.[0]?.delta?.content;
      if (token) {
        tokens++; chars += token.length;
        if (typeof opts.onToken === 'function') { try { opts.onToken(token); } catch {} }
        yield token;
      }

      if (typeof opts.onMeta === 'function') {
        try { opts.onMeta({ elapsedMs: Date.now() - t0, provider: 'groq' }); } catch {}
      }

      for await (const chunk of iterator) {
        if (opts.signal?.aborted) {
          const err = new Error('aborted by client'); err.name = 'AbortError'; throw err;
        }
        token = chunk?.choices?.[0]?.delta?.content;
        if (!token) continue;
        tokens++; chars += token.length;
        if (typeof opts.onToken === 'function') { try { opts.onToken(token); } catch {} }
        yield token;
      }

      const elapsedMs = Date.now() - t0;
      emitDone(opts, 'groq', {
        tokens, chars, elapsedMs,
        tps: elapsedMs > 0 ? (tokens / (elapsedMs / 1000)).toFixed(1) : '0',
      });
      return;
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);
      const isLast = attempt === maxAttempts - 1;
      if (tokens > 0) throw err;
      if (kind.kind === 'client_abort') throw err;
      if (!kind.retryable || isLast) throw err;
      if (typeof opts.onError === 'function') {
        try { opts.onError({ kind: kind.kind, attempt, willRetry: true, err }); } catch {}
      }
    }
  }

  if (lastErr) throw lastErr;
  throw new Error('Groq falló sin error específico');
}

/* ═══════════════════════════════════════════════════════════════════════
   9 · GEMINI
   ═══════════════════════════════════════════════════════════════════════ */

export async function* streamGemini(gemini, systemPrompt, message, file, opts = {}) {
  const cfg = ENGINE_CONFIG.gemini;
  const reasoning = Boolean(opts.reasoning);
  const history = normalizeHistory(opts.history);
  const mergedHistory = mergeConsecutiveRoles(history);

  const baseText = message || (file && file.data ? '(analiza el archivo adjunto)' : '');
  const userText = reasoning ? REASONING_PREFIX + baseText : baseText;

  // Historial convertido a contents de Gemini
  const contents = mergedHistory.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  const currentParts = [{ text: userText }];
  if (file && file.data) {
    currentParts.push({ inlineData: { mimeType: file.mimeType, data: file.data } });
  }
  contents.push({ role: 'user', parts: currentParts });

  const config = {
    systemInstruction: systemPrompt,
    thinkingConfig: reasoning
      ? { thinkingBudget: cfg.thinkingBudgetReasoning }
      : { thinkingBudget: cfg.thinkingBudgetNormal },
    temperature: opts.temperature ?? (reasoning ? cfg.reasoningTemperature : cfg.temperature),
    maxOutputTokens: opts.maxTokens ?? (reasoning ? cfg.reasoningMaxTokens : cfg.maxTokens),
  };

  let lastErr;
  const maxAttempts = (opts.retries ?? cfg.retries) + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(backoffDelay(attempt - 1, cfg.backoffBaseMs));

    const t0 = Date.now();
    let tokens = 0;
    let chars = 0;

    try {
      const stream = await gemini.models.generateContentStream({
        model: opts.model || cfg.model,
        contents,
        config,
      });

      const iterator = stream[Symbol.asyncIterator]();

      const firstResult = await withFirstTokenTimeout(
        iterator,
        opts.timeoutMs ?? cfg.firstTokenTimeoutMs,
        cfg.name,
      );

      if (firstResult.done) {
        lastErr = new Error('Gemini no devolvió tokens');
        continue;
      }

      let token = firstResult.value?.text;
      if (token) {
        tokens++; chars += token.length;
        if (typeof opts.onToken === 'function') { try { opts.onToken(token); } catch {} }
        yield token;
      }

      if (typeof opts.onMeta === 'function') {
        try { opts.onMeta({ elapsedMs: Date.now() - t0, provider: 'gemini' }); } catch {}
      }

      for await (const chunk of iterator) {
        if (opts.signal?.aborted) {
          const err = new Error('aborted by client'); err.name = 'AbortError'; throw err;
        }
        token = chunk?.text;
        if (!token) continue;
        tokens++; chars += token.length;
        if (typeof opts.onToken === 'function') { try { opts.onToken(token); } catch {} }
        yield token;
      }

      const elapsedMs = Date.now() - t0;
      emitDone(opts, 'gemini', {
        tokens, chars, elapsedMs,
        tps: elapsedMs > 0 ? (tokens / (elapsedMs / 1000)).toFixed(1) : '0',
      });
      return;
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);
      const isLast = attempt === maxAttempts - 1;
      if (tokens > 0) throw err;
      if (kind.kind === 'client_abort') throw err;
      if (!kind.retryable || isLast) throw err;
      if (typeof opts.onError === 'function') {
        try { opts.onError({ kind: kind.kind, attempt, willRetry: true, err }); } catch {}
      }
    }
  }

  if (lastErr) throw lastErr;
  throw new Error('Gemini falló sin error específico');
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · KIMI / NVIDIA NIM
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Stream desde NVIDIA NIM (u otro cliente OpenAI-compatible con Kimi).
 * Nota: NVIDIA NIM soporta streaming en la mayoría de sus modelos,
 * incluido Kimi K3. Si algún modelo no lo soporta, el caller puede
 * caer a la versión no-streaming (callNvidia en index.js).
 */
export async function* streamKimi(nvidia, systemPrompt, message, file, opts = {}) {
  const cfg = ENGINE_CONFIG.nvidia;
  const reasoning = Boolean(opts.reasoning);
  const history = normalizeHistory(opts.history);

  const isImg = file?.data && file.mimeType?.startsWith('image/');

  // Mensajes base
  const messages = [{ role: 'system', content: systemPrompt }];
  for (const m of history) messages.push(m);

  if (isImg) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: buildUserContent(message, reasoning, null) },
        { type: 'image_url', image_url: { url: `data:${file.mimeType};base64,${file.data}` } },
      ],
    });
  } else {
    messages.push({ role: 'user', content: buildUserContent(message, reasoning, file) });
  }

  const params = {
    model: opts.model || cfg.model,
    messages,
    temperature: opts.temperature ?? (reasoning ? cfg.reasoningTemperature : cfg.temperature),
    max_tokens: opts.maxTokens ?? (reasoning ? cfg.reasoningMaxTokens : cfg.maxTokens),
    stream: true,
  };

  let lastErr;
  const maxAttempts = (opts.retries ?? cfg.retries) + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(backoffDelay(attempt - 1, cfg.backoffBaseMs));

    const t0 = Date.now();
    let tokens = 0;
    let chars = 0;

    try {
      const stream = await nvidia.chat.completions.create(params, { signal: opts.signal });
      const iterator = stream[Symbol.asyncIterator]();

      const firstResult = await withFirstTokenTimeout(
        iterator,
        opts.timeoutMs ?? cfg.firstTokenTimeoutMs,
        cfg.name,
      );

      if (firstResult.done) {
        lastErr = new Error('Kimi no devolvió tokens');
        continue;
      }

      let token = firstResult.value?.choices?.[0]?.delta?.content;
      if (token) {
        tokens++; chars += token.length;
        if (typeof opts.onToken === 'function') { try { opts.onToken(token); } catch {} }
        yield token;
      }

      if (typeof opts.onMeta === 'function') {
        try { opts.onMeta({ elapsedMs: Date.now() - t0, provider: 'nvidia' }); } catch {}
      }

      for await (const chunk of iterator) {
        if (opts.signal?.aborted) {
          const err = new Error('aborted by client'); err.name = 'AbortError'; throw err;
        }
        token = chunk?.choices?.[0]?.delta?.content;
        if (!token) continue;
        tokens++; chars += token.length;
        if (typeof opts.onToken === 'function') { try { opts.onToken(token); } catch {} }
        yield token;
      }

      const elapsedMs = Date.now() - t0;
      emitDone(opts, 'nvidia', {
        tokens, chars, elapsedMs,
        tps: elapsedMs > 0 ? (tokens / (elapsedMs / 1000)).toFixed(1) : '0',
      });
      return;
    } catch (err) {
      lastErr = err;
      const kind = classifyError(err);
      const isLast = attempt === maxAttempts - 1;
      if (tokens > 0) throw err;
      if (kind.kind === 'client_abort') throw err;
      if (!kind.retryable || isLast) throw err;
      if (typeof opts.onError === 'function') {
        try { opts.onError({ kind: kind.kind, attempt, willRetry: true, err }); } catch {}
      }
    }
  }

  if (lastErr) throw lastErr;
  throw new Error('Kimi falló sin error específico');
}

/* ═══════════════════════════════════════════════════════════════════════
   11 · EXPORT DE CONFIGURACIÓN (para el caller)
   ═══════════════════════════════════════════════════════════════════════ */

export { ENGINE_CONFIG };