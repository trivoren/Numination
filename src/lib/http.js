/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · lib/http.js · v1.0
   ─────────────────────────────────────────────────────────────────────────
   Cliente HTTP robusto con retry, circuit breaker, timeouts, y streaming.

   FEATURES:
     · Retry con backoff exponencial + jitter
     · Circuit breaker por host (abre tras N fallos)
     · Timeout global y por request
     · Cancelación con AbortSignal (externa + interna)
     · Rate limiting por host (token bucket)
     · Concurrency limiter (máx requests en paralelo por host)
     · Interceptors (request / response / error)
     · Auto-parse JSON con fallback a texto
     · Taxonomía de errores tipados
     · Streaming SSE (Server-Sent Events)
     · Streaming NDJSON (newline-delimited JSON)
     · Retry-After header respetado
     · Idempotency-key automático para POST/PUT
     · User-Agent personalizable
     · Métricas agregadas por host
     · Self-test integrado

   API PÚBLICA:

     Básicos:
       http.get(url, opts)              → Promise<Response>
       http.post(url, body, opts)       → Promise<Response>
       http.put(url, body, opts)        → Promise<Response>
       http.patch(url, body, opts)      → Promise<Response>
       http.delete(url, opts)           → Promise<Response>
       http.request(url, opts)          → Promise<Response>

     JSON helpers:
       http.getJSON(url, opts)          → Promise<any>
       http.postJSON(url, body, opts)   → Promise<any>

     Streaming:
       http.streamSSE(url, opts)        → AsyncIterator<event>
       http.streamNDJSON(url, opts)     → AsyncIterator<object>
       http.streamText(url, opts)       → AsyncIterator<string>

     Config:
       http.configure(patch)            → void
       http.on(event, handler)          → unsubscribe

     Utilidades:
       http.getMetrics()                → stats
       http.resetCircuit(host)          → void
       http.addHostConfig(host, cfg)    → void

     Debug:
       http.test()                      → self-test

   USO:
     import { http } from './lib/http.js';

     // GET simple
     const data = await http.getJSON('https://api.example.com/data');

     // POST con retry
     const res = await http.postJSON('https://api.openai.com/v1/chat', {
       model: 'gpt-4',
       messages: [{ role: 'user', content: 'hola' }],
     }, {
       headers: { Authorization: 'Bearer sk-xxx' },
       retries: 3,
       timeoutMs: 30000,
     });

     // SSE streaming
     for await (const evt of http.streamSSE(url, { method: 'POST', body })) {
       if (evt.data === '[DONE]') break;
       const chunk = JSON.parse(evt.data);
       // ...
     }
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { createLogger } from './logger.js';

const log = createLogger('http');

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = {
  // Timeouts
  timeoutMs: parseInt(process.env.HTTP_TIMEOUT_MS || '30000', 10),
  connectTimeoutMs: parseInt(process.env.HTTP_CONNECT_TIMEOUT_MS || '10000', 10),

  // Retry
  retry: {
    enabled: true,
    maxAttempts: parseInt(process.env.HTTP_RETRY_MAX || '3', 10),
    baseDelayMs: 500,
    maxDelayMs: 30_000,
    multiplier: 2,
    jitter: 0.3, // ±30% de aleatoriedad
    // Status codes que disparan retry
    retryStatuses: [408, 429, 500, 502, 503, 504],
    // Errores que disparan retry
    retryErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ABORT_ERR'],
  },

  // Circuit breaker
  circuit: {
    enabled: true,
    failureThreshold: 5,
    successThreshold: 2, // después de abrir, N éxitos para cerrar
    openMs: 30_000,      // tiempo abierto antes de half-open
  },

  // Rate limit por host (token bucket)
  rateLimit: {
    enabled: true,
    defaultPerSecond: 20,
    defaultBurst: 40,
    perHost: {
      'api.groq.com': { perSecond: 30, burst: 60 },
      'generativelanguage.googleapis.com': { perSecond: 15, burst: 30 },
      'api.moonshot.cn': { perSecond: 20, burst: 40 },
      'image.pollinations.ai': { perSecond: 5, burst: 10 },
      'es.wikipedia.org': { perSecond: 10, burst: 20 },
      'api.duckduckgo.com': { perSecond: 5, burst: 10 },
    },
  },

  // Concurrency
  concurrency: {
    enabled: true,
    defaultPerHost: 6,
    perHost: {
      'api.groq.com': 8,
      'image.pollinations.ai': 3,
    },
  },

  // Headers por defecto
  headers: {
    'user-agent': 'Numination/1.0 (+https://numination.app)',
    'accept': 'application/json, text/plain, */*',
  },

  // Comportamiento
  behavior: {
    // Enviar Idempotency-Key en POST/PUT automáticamente
    idempotency: process.env.HTTP_IDEMPOTENCY === 'true',
    // Loggear cada request
    logRequests: process.env.HTTP_LOG_REQUESTS === 'true',
    // Follow redirects
    redirect: 'follow',
    // Máximo de redirects
    maxRedirects: 5,
  },

  // Log
  logLevel: process.env.LOG_LEVEL || 'info',
};

/* ═══════════════════════════════════════════════════════════════════════════
   02 · ERRORES TIPADOS
   ═══════════════════════════════════════════════════════════════════════════ */

class HTTPError extends Error {
  constructor(code, message, meta = {}) {
    super(message);
    this.name = 'HTTPError';
    this.code = code;
    Object.assign(this, meta);
  }

  get isTimeout() { return this.code === 'TIMEOUT'; }
  get isAbort() { return this.code === 'ABORTED'; }
  get isNetwork() { return this.code === 'NETWORK'; }
  get isHTTP() { return this.code === 'HTTP_STATUS'; }
  get isCircuit() { return this.code === 'CIRCUIT_OPEN'; }
  get isRateLimit() { return this.code === 'RATE_LIMITED'; }
  get isRetryable() {
    return ['TIMEOUT', 'NETWORK', 'HTTP_STATUS'].includes(this.code) &&
           (this.status === undefined || CFG.retry.retryStatuses.includes(this.status));
  }
}

const ERR = {
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  NETWORK: 'NETWORK',
  HTTP_STATUS: 'HTTP_STATUS',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  RATE_LIMITED: 'RATE_LIMITED',
  PARSE_ERROR: 'PARSE_ERROR',
  TOO_MANY_REDIRECTS: 'TOO_MANY_REDIRECTS',
};

/* ═══════════════════════════════════════════════════════════════════════════
   03 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function jitter(ms, factor = CFG.retry.jitter) {
  const delta = ms * factor;
  return Math.max(0, ms + (Math.random() * 2 - 1) * delta);
}

function parseHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown';
  }
}

function isJSONContentType(ct) {
  if (!ct) return false;
  const lower = String(ct).toLowerCase();
  return lower.includes('application/json') ||
         lower.includes('application/ld+json') ||
         lower.includes('+json');
}

function isStreamContentType(ct) {
  if (!ct) return false;
  const lower = String(ct).toLowerCase();
  return lower.includes('text/event-stream') ||
         lower.includes('application/x-ndjson') ||
         lower.includes('application/stream+json');
}

function sha256Hex(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · CIRCUIT BREAKER (por host)
   ═══════════════════════════════════════════════════════════════════════════ */

const circuits = new Map();

function getCircuit(host) {
  let c = circuits.get(host);
  if (!c) {
    c = { state: 'closed', failures: 0, successes: 0, openedAt: 0 };
    circuits.set(host, c);
  }
  return c;
}

function circuitCheck(host) {
  if (!CFG.circuit.enabled) return { ok: true };

  const c = getCircuit(host);

  if (c.state === 'open') {
    const elapsed = Date.now() - c.openedAt;
    if (elapsed < CFG.circuit.openMs) {
      return {
        ok: false,
        retryAfterMs: CFG.circuit.openMs - elapsed,
      };
    }
    // Pasar a half-open
    c.state = 'half-open';
    c.successes = 0;
    log.info(`circuit ${host} → half-open`);
  }

  return { ok: true };
}

function circuitSuccess(host) {
  if (!CFG.circuit.enabled) return;
  const c = getCircuit(host);

  if (c.state === 'half-open') {
    c.successes++;
    if (c.successes >= CFG.circuit.successThreshold) {
      c.state = 'closed';
      c.failures = 0;
      c.successes = 0;
      log.info(`circuit ${host} → closed`);
    }
  } else {
    c.failures = Math.max(0, c.failures - 1);
  }
}

function circuitFail(host) {
  if (!CFG.circuit.enabled) return;
  const c = getCircuit(host);
  c.failures++;

  if (c.state === 'closed' && c.failures >= CFG.circuit.failureThreshold) {
    c.state = 'open';
    c.openedAt = Date.now();
    log.warn(`circuit ${host} → open (${c.failures} fallos)`);
  } else if (c.state === 'half-open') {
    c.state = 'open';
    c.openedAt = Date.now();
    c.successes = 0;
    log.warn(`circuit ${host} → open de nuevo (half-open falló)`);
  }
}

function resetCircuit(host) {
  if (host) {
    circuits.delete(host);
  } else {
    circuits.clear();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · RATE LIMITER (token bucket por host)
   ═══════════════════════════════════════════════════════════════════════════ */

const buckets = new Map();

function getBucket(host) {
  let b = buckets.get(host);
  if (!b) {
    const cfg = CFG.rateLimit.perHost[host] || {};
    b = {
      perSecond: cfg.perSecond || CFG.rateLimit.defaultPerSecond,
      burst: cfg.burst || CFG.rateLimit.defaultBurst,
      tokens: cfg.burst || CFG.rateLimit.defaultBurst,
      lastRefill: Date.now(),
    };
    buckets.set(host, b);
  }
  return b;
}

async function rateLimitAcquire(host) {
  if (!CFG.rateLimit.enabled) return;

  const b = getBucket(host);
  const now = Date.now();

  // Refill
  const elapsedSec = (now - b.lastRefill) / 1000;
  const refill = elapsedSec * b.perSecond;
  b.tokens = Math.min(b.burst, b.tokens + refill);
  b.lastRefill = now;

  // Si no hay tokens, esperar
  if (b.tokens < 1) {
    const needed = 1 - b.tokens;
    const waitMs = Math.ceil((needed / b.perSecond) * 1000);
    log.debug(`rate limit ${host} · esperando ${waitMs}ms`);
    await sleep(waitMs);
    // Recursión para re-chequear
    return rateLimitAcquire(host);
  }

  b.tokens -= 1;
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · CONCURRENCY LIMITER (por host)
   ═══════════════════════════════════════════════════════════════════════════ */

const active = new Map(); // host → count
const waiters = new Map(); // host → [resolve]

function getLimit(host) {
  return CFG.concurrency.perHost[host] || CFG.concurrency.defaultPerHost;
}

async function concurrencyAcquire(host) {
  if (!CFG.concurrency.enabled) return;

  const limit = getLimit(host);
  const current = active.get(host) || 0;

  if (current < limit) {
    active.set(host, current + 1);
    return;
  }

  // Esperar en cola
  return new Promise(resolve => {
    if (!waiters.has(host)) waiters.set(host, []);
    waiters.get(host).push(() => {
      active.set(host, (active.get(host) || 0) + 1);
      resolve();
    });
  });
}

function concurrencyRelease(host) {
  if (!CFG.concurrency.enabled) return;

  const current = active.get(host) || 0;
  active.set(host, Math.max(0, current - 1));

  // Despertar al siguiente en cola
  const queue = waiters.get(host);
  if (queue && queue.length > 0) {
    const next = queue.shift();
    next();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   07 · INTERCEPTORS
   ═══════════════════════════════════════════════════════════════════════════ */

const interceptors = {
  request: [],
  response: [],
  error: [],
};

function addInterceptor(kind, fn) {
  if (!interceptors[kind]) throw new Error('Interceptor kind inválido: ' + kind);
  interceptors[kind].push(fn);
  return () => {
    const idx = interceptors[kind].indexOf(fn);
    if (idx >= 0) interceptors[kind].splice(idx, 1);
  };
}

async function applyRequestInterceptors(ctx) {
  let current = ctx;
  for (const fn of interceptors.request) {
    try {
      const result = await fn(current);
      if (result) current = result;
    } catch (e) {
      log.warn('request interceptor failed', e.message);
    }
  }
  return current;
}

async function applyResponseInterceptors(res) {
  let current = res;
  for (const fn of interceptors.response) {
    try {
      const result = await fn(current);
      if (result) current = result;
    } catch (e) {
      log.warn('response interceptor failed', e.message);
    }
  }
  return current;
}

async function applyErrorInterceptors(err, ctx) {
  let current = err;
  for (const fn of interceptors.error) {
    try {
      const result = await fn(current, ctx);
      if (result) current = result;
    } catch (e) {
      log.warn('error interceptor failed', e.message);
    }
  }
  return current;
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · MÉTRICAS
   ═══════════════════════════════════════════════════════════════════════════ */

const metrics = {
  total: 0,
  success: 0,
  failed: 0,
  retries: 0,
  timeouts: 0,
  aborted: 0,
  circuitOpens: 0,
  rateLimited: 0,
  byHost: new Map(), // host → { requests, errors, avgMs, totalMs }
  since: Date.now(),
};

function recordRequest(host, ok, ms) {
  metrics.total++;
  if (ok) metrics.success++;
  else metrics.failed++;

  let h = metrics.byHost.get(host);
  if (!h) {
    h = { requests: 0, errors: 0, totalMs: 0 };
    metrics.byHost.set(host, h);
  }
  h.requests++;
  if (!ok) h.errors++;
  h.totalMs += ms;
}

function getMetrics() {
  const byHost = {};
  for (const [host, h] of metrics.byHost) {
    byHost[host] = {
      requests: h.requests,
      errors: h.errors,
      avgMs: h.requests > 0 ? Math.round(h.totalMs / h.requests) : 0,
      errorRate: h.requests > 0 ? +(h.errors / h.requests).toFixed(4) : 0,
    };
  }

  const circuitsObj = {};
  for (const [host, c] of circuits) {
    circuitsObj[host] = c.state;
  }

  return {
    total: metrics.total,
    success: metrics.success,
    failed: metrics.failed,
    retries: metrics.retries,
    timeouts: metrics.timeouts,
    aborted: metrics.aborted,
    circuitOpens: metrics.circuitOpens,
    rateLimited: metrics.rateLimited,
    successRate: metrics.total > 0 ? +(metrics.success / metrics.total).toFixed(4) : 0,
    uptimeMs: Date.now() - metrics.since,
    byHost,
    circuits: circuitsObj,
    activeRequests: Array.from(active.values()).reduce((a, b) => a + b, 0),
  };
}

function resetMetrics() {
  metrics.total = 0;
  metrics.success = 0;
  metrics.failed = 0;
  metrics.retries = 0;
  metrics.timeouts = 0;
  metrics.aborted = 0;
  metrics.circuitOpens = 0;
  metrics.rateLimited = 0;
  metrics.byHost.clear();
  metrics.since = Date.now();
}

/* ═══════════════════════════════════════════════════════════════════════════
   09 · EVENTOS
   ═══════════════════════════════════════════════════════════════════════════ */

const eventHandlers = new Map();

function emit(event, data) {
  const handlers = eventHandlers.get(event);
  if (!handlers) return;
  for (const h of handlers) {
    try { h(data); } catch (e) { log.warn(`handler ${event} failed`, e.message); }
  }
}

function on(event, handler) {
  if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
  eventHandlers.get(event).add(handler);
  return () => eventHandlers.get(event)?.delete(handler);
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · CLIENTE HTTP · request base
   ═══════════════════════════════════════════════════════════════════════════ */

async function request(url, options = {}) {
  const t0 = Date.now();
  const host = parseHost(url);

  // ─── 1. Circuit breaker ───
  const cb = circuitCheck(host);
  if (!cb.ok) {
    metrics.circuitOpens++;
    const err = new HTTPError(ERR.CIRCUIT_OPEN, `Circuit abierto para ${host}`, {
      host,
      retryAfterMs: cb.retryAfterMs,
    });
    emit('error', err);
    throw err;
  }

  // ─── 2. Rate limit ───
  try {
    await rateLimitAcquire(host);
  } catch (e) {
    metrics.rateLimited++;
    throw new HTTPError(ERR.RATE_LIMITED, `Rate limit en ${host}`, { host });
  }

  // ─── 3. Concurrency ───
  await concurrencyAcquire(host);

  let released = false;
  const releaseOnce = () => {
    if (!released) {
      released = true;
      concurrencyRelease(host);
    }
  };

  try {
    // ─── 4. Preparar request ───
    const ctx = await applyRequestInterceptors({
      url,
      host,
      options,
      method: (options.method || 'GET').toUpperCase(),
    });

    const result = await executeWithRetry(ctx);

    // ─── 5. Aplicar interceptors de response ───
    await applyResponseInterceptors(result);

    recordRequest(host, true, Date.now() - t0);
    circuitSuccess(host);

    return result;
  } catch (e) {
    circuitFail(host);
    recordRequest(host, false, Date.now() - t0);

    const finalErr = await applyErrorInterceptors(e, { url, host, options });
    emit('error', finalErr);
    throw finalErr;
  } finally {
    releaseOnce();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   11 · RETRY con backoff exponencial
   ═══════════════════════════════════════════════════════════════════════════ */

async function executeWithRetry(ctx) {
  const { url, host, options } = ctx;
  const maxAttempts = CFG.retry.enabled
    ? (options.retries !== undefined ? options.retries + 1 : CFG.retry.maxAttempts)
    : 1;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await executeOnce(ctx);
      return result;
    } catch (e) {
      lastError = e;

      // No reintentar si no es retryable
      if (!shouldRetry(e, attempt, maxAttempts)) {
        throw e;
      }

      // Backoff
      const delay = computeBackoff(attempt, e);
      log.debug(`retry ${attempt}/${maxAttempts} · ${host} · esperando ${Math.round(delay)}ms`);

      emit('retry', { url, host, attempt, delay, error: e.message });
      metrics.retries++;

      await sleep(delay);
    }
  }

  throw lastError;
}

function shouldRetry(error, attempt, maxAttempts) {
  if (attempt >= maxAttempts) return false;

  if (error.code === ERR.TIMEOUT) return true;
  if (error.code === ERR.ABORTED) return false; // abort del usuario, no reintentar
  if (error.code === ERR.CIRCUIT_OPEN) return false;
  if (error.code === ERR.NETWORK) {
    return CFG.retry.retryErrors.some(code => String(error.message).includes(code)) ||
           String(error.message).includes('fetch failed');
  }
  if (error.code === ERR.HTTP_STATUS) {
    return CFG.retry.retryStatuses.includes(error.status);
  }

  return false;
}

function computeBackoff(attempt, error) {
  // Si el server dice Retry-After, respetarlo
  if (error.retryAfterMs) {
    return Math.min(error.retryAfterMs, CFG.retry.maxDelayMs);
  }

  const base = CFG.retry.baseDelayMs * Math.pow(CFG.retry.multiplier, attempt - 1);
  const capped = Math.min(base, CFG.retry.maxDelayMs);
  return jitter(capped);
}

/* ═══════════════════════════════════════════════════════════════════════════
   12 · EJECUCIÓN ÚNICA
   ═══════════════════════════════════════════════════════════════════════════ */

async function executeOnce(ctx) {
  const { url, options, host } = ctx;

  const method = (options.method || 'GET').toUpperCase();
  const timeoutMs = options.timeoutMs || CFG.timeoutMs;

  // Abort controller combinando signal externo + timeout
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(new Error('TIMEOUT')), timeoutMs);

  if (options.signal) {
    if (options.signal.aborted) {
      ctrl.abort(options.signal.reason);
    } else {
      options.signal.addEventListener('abort', () => ctrl.abort(options.signal.reason), { once: true });
    }
  }

  // Headers
  const headers = new Headers({
    ...CFG.headers,
    ...(options.headers || {}),
  });

  // Body
  let body = options.body;
  if (body !== undefined && body !== null && !(body instanceof FormData) &&
      !(body instanceof Blob) && !(body instanceof ArrayBuffer) &&
      !Buffer.isBuffer(body) && typeof body !== 'string') {
    body = JSON.stringify(body);
    if (!headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
  } else if (typeof body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'text/plain; charset=utf-8');
  }

  // Idempotency key
  if (CFG.behavior.idempotency &&
      ['POST', 'PUT', 'PATCH'].includes(method) &&
      !headers.has('idempotency-key')) {
    const seed = method + ':' + url + ':' + (typeof body === 'string' ? body : '');
    headers.set('idempotency-key', sha256Hex(seed).slice(0, 32));
  }

  if (CFG.behavior.logRequests) {
    log.debug(`${method} ${url}`, { host, attempt: ctx.attempt });
  }

  // Fetch
  let response;
  const fetchStart = Date.now();
  try {
    response = await fetch(url, {
      method,
      headers,
      body,
      signal: ctrl.signal,
      redirect: options.redirect || CFG.behavior.redirect,
      ...(options.cache && { cache: options.cache }),
      ...(options.mode && { mode: options.mode }),
      ...(options.credentials && { credentials: options.credentials }),
    });
  } catch (e) {
    clearTimeout(timeoutId);

    if (e.name === 'AbortError') {
      const reason = ctrl.signal.reason;
      const isTimeout = reason && String(reason.message || reason).includes('TIMEOUT');

      if (isTimeout) {
        metrics.timeouts++;
        throw new HTTPError(ERR.TIMEOUT, `Timeout después de ${timeoutMs}ms`, {
          url, host, timeoutMs,
        });
      }
      metrics.aborted++;
      throw new HTTPError(ERR.ABORTED, 'Request abortado', { url, host });
    }

    throw new HTTPError(ERR.NETWORK, e.message || 'Error de red', {
      url, host, originalError: e,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const fetchMs = Date.now() - fetchStart;

  // Leer body
  const contentType = response.headers.get('content-type') || '';
  let data;
  let rawText;

  try {
    if (options.responseType === 'stream') {
      // No consumir el body
      data = response.body;
    } else if (options.responseType === 'buffer') {
      const buf = await response.arrayBuffer();
      data = Buffer.from(buf);
    } else if (options.responseType === 'text') {
      rawText = await response.text();
      data = rawText;
    } else {
      // Auto: JSON si el content-type lo indica, si no texto
      rawText = await response.text();
      if (isJSONContentType(contentType)) {
        try {
          data = rawText ? JSON.parse(rawText) : null;
        } catch (e) {
          // 2xx con body inválido
          if (response.ok) {
            throw new HTTPError(ERR.PARSE_ERROR, 'JSON inválido en respuesta', {
              url, host, body: rawText.slice(0, 500),
            });
          }
          data = rawText;
        }
      } else {
        data = rawText;
      }
    }
  } catch (e) {
    if (e instanceof HTTPError) throw e;
    throw new HTTPError(ERR.PARSE_ERROR, 'Error leyendo respuesta: ' + e.message, {
      url, host,
    });
  }

  // Si no es 2xx, tirar error
  if (!response.ok) {
    const retryAfter = response.headers.get('retry-after');
    const retryAfterMs = retryAfter
      ? (isNaN(Number(retryAfter))
        ? new Date(retryAfter).getTime() - Date.now()
        : Number(retryAfter) * 1000)
      : null;

    throw new HTTPError(ERR.HTTP_STATUS, `HTTP ${response.status} ${response.statusText}`, {
      url, host,
      status: response.status,
      statusText: response.statusText,
      retryAfterMs,
      data,
      headers: Object.fromEntries(response.headers),
    });
  }

  // Respuesta exitosa
  return {
    ok: true,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers),
    contentType,
    data,
    raw: rawText,
    url: response.url,
    durationMs: fetchMs,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   13 · WRAPPERS · get, post, put, patch, delete
   ═══════════════════════════════════════════════════════════════════════════ */

async function get(url, options = {}) {
  return request(url, { ...options, method: 'GET' });
}

async function post(url, body, options = {}) {
  return request(url, { ...options, method: 'POST', body });
}

async function put(url, body, options = {}) {
  return request(url, { ...options, method: 'PUT', body });
}

async function patch(url, body, options = {}) {
  return request(url, { ...options, method: 'PATCH', body });
}

async function del(url, options = {}) {
  return request(url, { ...options, method: 'DELETE' });
}

/* ─── JSON helpers ─── */

async function getJSON(url, options = {}) {
  const res = await get(url, options);
  return res.data;
}

async function postJSON(url, body, options = {}) {
  const res = await post(url, body, options);
  return res.data;
}

/* ═══════════════════════════════════════════════════════════════════════════
   14 · STREAMING · SSE + NDJSON + texto
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Iterator asíncrono sobre un stream SSE.
 * Cada iteración devuelve: { event, data, id, retry }
 *
 * Uso:
 *   for await (const evt of http.streamSSE(url, { method: 'POST', body })) {
 *     if (evt.data === '[DONE]') break;
 *     const chunk = JSON.parse(evt.data);
 *   }
 */
async function* streamSSE(url, options = {}) {
  const res = await request(url, {
    ...options,
    responseType: 'stream',
    headers: {
      ...(options.headers || {}),
      'accept': 'text/event-stream',
    },
  });

  const reader = res.data.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Los eventos SSE se separan por doble newline
      let sepIdx;
      while ((sepIdx = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);

        // Parsear el evento
        const evt = parseSSEEvent(rawEvent);
        if (evt) yield evt;
      }
    }

    // Procesar lo que quedó
    if (buffer.trim()) {
      const evt = parseSSEEvent(buffer);
      if (evt) yield evt;
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function parseSSEEvent(raw) {
  if (!raw || !raw.trim()) return null;

  const lines = raw.split(/\r?\n/);
  const event = { event: 'message', data: '', id: null, retry: null };

  for (const line of lines) {
    if (!line || line.startsWith(':')) continue; // comment
    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const field = line.slice(0, idx);
    let value = line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') event.event = value;
    else if (field === 'data') event.data += (event.data ? '\n' : '') + value;
    else if (field === 'id') event.id = value;
    else if (field === 'retry') event.retry = parseInt(value, 10);
  }

  return event;
}

/**
 * Iterator asíncrono sobre un stream NDJSON
 * (newline-delimited JSON, uno por línea).
 */
async function* streamNDJSON(url, options = {}) {
  const res = await request(url, {
    ...options,
    responseType: 'stream',
    headers: {
      ...(options.headers || {}),
      'accept': 'application/x-ndjson',
    },
  });

  const reader = res.data.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          yield JSON.parse(line);
        } catch (e) {
          log.warn('ndjson parse failed', line.slice(0, 100));
        }
      }
    }

    if (buffer.trim()) {
      try { yield JSON.parse(buffer.trim()); } catch {}
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

/**
 * Iterator sobre un stream de texto plano en chunks.
 */
async function* streamText(url, options = {}) {
  const res = await request(url, {
    ...options,
    responseType: 'stream',
  });

  const reader = res.data.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   15 · CONFIGURACIÓN RUNTIME
   ═══════════════════════════════════════════════════════════════════════════ */

function configure(patch) {
  if (!patch || typeof patch !== 'object') return;

  function merge(target, source) {
    for (const k of Object.keys(source)) {
      if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        merge(target[k], source[k]);
      } else {
        target[k] = source[k];
      }
    }
  }
  merge(CFG, patch);
  log.info('http config actualizada');
}

function addHostConfig(host, cfg) {
  if (!host || !cfg) return;
  if (cfg.rateLimit) {
    CFG.rateLimit.perHost[host] = {
      ...(CFG.rateLimit.perHost[host] || {}),
      ...cfg.rateLimit,
    };
  }
  if (cfg.concurrency !== undefined) {
    CFG.concurrency.perHost[host] = cfg.concurrency;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   16 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════════ */

async function test() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  // Parse host
  rec('parseHost válido', parseHost('https://api.example.com/v1') === 'api.example.com', true);
  rec('parseHost inválido', parseHost('not-a-url') === 'unknown', true);

  // Content type
  rec('isJSONContentType json', isJSONContentType('application/json') === true, true);
  rec('isJSONContentType json con charset', isJSONContentType('application/json; charset=utf-8') === true, true);
  rec('isJSONContentType text', isJSONContentType('text/plain') === false, true);

  // Jitter
  const j1 = jitter(1000, 0.3);
  rec('jitter en rango', j1 >= 700 && j1 <= 1300, j1);

  // SSE parser
  const evt1 = parseSSEEvent('event: message\ndata: {"token":"hola"}');
  rec('SSE parse event', evt1.event === 'message', evt1);
  rec('SSE parse data', evt1.data === '{"token":"hola"}', evt1.data);

  const evt2 = parseSSEEvent('data: línea 1\ndata: línea 2');
  rec('SSE multi-línea', evt2.data === 'línea 1\nlínea 2', evt2.data);

  const evt3 = parseSSEEvent(': comment\n\ndata: real');
  rec('SSE ignora comments', evt3.data === 'real', evt3.data);

  const evt4 = parseSSEEvent('id: 123\nretry: 5000\ndata: test');
  rec('SSE id y retry', evt4.id === '123' && evt4.retry === 5000, evt4);

  // Circuit breaker
  resetCircuit();
  const c1 = getCircuit('test-host-1');
  rec('circuit inicia cerrado', c1.state === 'closed', c1.state);

  for (let i = 0; i < CFG.circuit.failureThreshold; i++) circuitFail('test-host-1');
  const c2 = getCircuit('test-host-1');
  rec('circuit abre tras threshold', c2.state === 'open', c2.state);

  const check = circuitCheck('test-host-1');
  rec('circuit bloquea cuando abierto', check.ok === false, check);

  resetCircuit('test-host-1');
  rec('circuit resetea', getCircuit('test-host-1').state === 'closed', true);

  // Rate limiter
  const b = getBucket('test-host-2');
  rec('rate bucket inicializado', b.tokens === CFG.rateLimit.defaultBurst, b.tokens);

  // Idempotency
  const hash1 = sha256Hex('POST:/url:body');
  const hash2 = sha256Hex('POST:/url:body');
  rec('idempotency determinista', hash1 === hash2, true);

  // Métricas
  resetMetrics();
  const m = getMetrics();
  rec('metrics inicial', m.total === 0, true);

  // addHostConfig
  addHostConfig('custom-host', { concurrency: 10 });
  rec('addHostConfig', CFG.concurrency.perHost['custom-host'] === 10, true);

  // Interceptors
  let intercepted = false;
  const off = addInterceptor('request', (ctx) => {
    intercepted = true;
    return ctx;
  });
  await applyRequestInterceptors({ url: 'x' });
  off();
  rec('request interceptor funciona', intercepted === true, true);

  // Eventos
  let eventFired = false;
  const offEvt = on('test-event', () => { eventFired = true; });
  emit('test-event');
  offEvt();
  rec('evento se emite', eventFired === true, true);

  // Errores tipados
  const errTimeout = new HTTPError(ERR.TIMEOUT, 'timeout');
  rec('HTTPError isTimeout', errTimeout.isTimeout === true, true);
  const errNet = new HTTPError(ERR.NETWORK, 'net');
  rec('HTTPError isNetwork', errNet.isNetwork === true, true);
  const errHTTP = new HTTPError(ERR.HTTP_STATUS, '500', { status: 500 });
  rec('HTTPError isRetryable (500)', errHTTP.isRetryable === true, true);
  const errHTTP2 = new HTTPError(ERR.HTTP_STATUS, '404', { status: 404 });
  rec('HTTPError no retryable (404)', errHTTP2.isRetryable === false, true);

  // shouldRetry
  rec('shouldRetry timeout → true', shouldRetry(errTimeout, 1, 3) === true, true);
  rec('shouldRetry abort → false', shouldRetry(new HTTPError(ERR.ABORTED, 'x'), 1, 3) === false, true);
  rec('shouldRetry max attempt → false', shouldRetry(errTimeout, 3, 3) === false, true);

  // computeBackoff
  const backoff1 = computeBackoff(1, errTimeout);
  rec('computeBackoff attempt 1', backoff1 >= 350 && backoff1 <= 650, backoff1);
  const backoff2 = computeBackoff(2, errTimeout);
  rec('computeBackoff attempt 2 mayor', backoff2 > backoff1, backoff2);

  const backoffRetryAfter = computeBackoff(1, { retryAfterMs: 5000 });
  rec('computeBackoff respeta retryAfter', backoffRetryAfter === 5000, backoffRetryAfter);

  // Métodos públicos existen
  rec('http.get es función', typeof get === 'function', true);
  rec('http.post es función', typeof post === 'function', true);
  rec('http.getJSON es función', typeof getJSON === 'function', true);
  rec('http.streamSSE es función', typeof streamSSE === 'function', true);
  rec('http.streamNDJSON es función', typeof streamNDJSON === 'function', true);
  rec('http.streamText es función', typeof streamText === 'function', true);

  // Config
  rec('configure es función', typeof configure === 'function', true);

  const passed = results.filter(r => r.ok).length;
  return {
    passed,
    total: results.length,
    ok: passed === results.length,
    results,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   17 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export const http = {
  // Básicos
  request,
  get,
  post,
  put,
  patch,
  delete: del,

  // JSON
  getJSON,
  postJSON,

  // Streaming
  streamSSE,
  streamNDJSON,
  streamText,

  // Config
  configure,
  addHostConfig,

  // Interceptors
  onRequest: (fn) => addInterceptor('request', fn),
  onResponse: (fn) => addInterceptor('response', fn),
  onError: (fn) => addInterceptor('error', fn),

  // Eventos
  on,
  off: (event, handler) => eventHandlers.get(event)?.delete(handler),

  // Circuit
  resetCircuit,
  getCircuit,

  // Métricas
  getMetrics,
  resetMetrics,

  // Debug
  test,

  // Internals
  _config: CFG,
  HTTPError,
  ERR,
};

export { HTTPError, ERR };
export default http;