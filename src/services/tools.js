/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tools.js · v1.0
   ─────────────────────────────────────────────────────────────────────────
   Sistema de function calling / agent tools para la IA.

   FILOSOFÍA:
     · La IA decide CUÁNDO y CUÁL tool usar
     · Nosotros validamos, ejecutamos y devolvemos resultado
     · Multi-provider (Groq / Gemini / Kimi)
     · Seguro por defecto (sin eval, sin SSRF, sin DoS)

   API PÚBLICA:

     Registry:
       register(def)                    → id
       unregister(name)                 → boolean
       get(name)                        → def | null
       list(filter)                     → def[]
       clear()                          → void

     Ejecución:
       execute(name, args, ctx)         → Promise<result>
       executeMany(calls, ctx)          → Promise<results[]>
       runLoop(opts)                    → Promise<final>

     Integración con LLM:
       forGroq(filter)                  → tools[]
       forGemini(filter)                → tools[]
       parseGroqResponse(msg)           → calls[]
       parseGeminiResponse(resp)        → calls[]
       buildToolResultMessage(...)      → messages

     Config:
       configure(patch)                 → void
       metrics()                        → stats
       reset()                          → void

   EVENTOS:
     nm:tools:execute    → { name, args, durationMs, ok, cached }
     nm:tools:error      → { name, args, error }
     nm:tools:circuit    → { name, state }

   USO BÁSICO EN INDEX.JS:

     import { TOOLS } from './services/tools.js';

     // En /api/chat/stream:
     const tools = TOOLS.forGroq();
     const result = await TOOLS.runLoop({
       messages,
       tools,
       callLLM: async (msgs, tls) => { ... },
       ctx: { userId, reqId, signal },
       maxTurns: 5,
     });
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { URL } from 'node:url';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = {
  // Ejecutor
  defaultTimeoutMs: 10_000,
  defaultRetries: 0,
  maxRetries: 2,
  retryDelayMs: 500,

  // Cache
  cache: {
    enabled: true,
    maxEntries: 500,
    defaultTtlMs: 60_000,
  },

  // Rate limiting (por usuario)
  rateLimit: {
    enabled: true,
    defaultPerMinute: 30,
    defaultPerHour: 300,
  },

  // Circuit breaker
  circuit: {
    enabled: true,
    failureThreshold: 5,
    resetAfterMs: 30_000,
  },

  // HTTP
  http: {
    userAgent: 'Numination-Tools/1.0 (+https://numination.app)',
    maxResponseBytes: 2 * 1024 * 1024, // 2MB
    allowedSchemes: ['https:', 'http:'],
    blockedHosts: [
      'localhost',
      '127.0.0.1',
      '0.0.0.0',
      'metadata.google.internal',
      'metadata',
    ],
    blockedCidrs: [
      '10.', '172.16.', '172.17.', '172.18.', '172.19.',
      '172.20.', '172.21.', '172.22.', '172.23.', '172.24.',
      '172.25.', '172.26.', '172.27.', '172.28.', '172.29.',
      '172.30.', '172.31.', '192.168.', '169.254.', '127.',
    ],
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Límites globales
  maxToolCallsPerTurn: 8,
  maxTurnsInLoop: 6,
};

/* ═══════════════════════════════════════════════════════════════════════════
   02 · LOGGER
   ═══════════════════════════════════════════════════════════════════════════ */

const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
const CUR_LEVEL = LOG_LEVELS[CFG.logLevel] ?? LOG_LEVELS.info;

const LOG = {
  error: (...a) => CUR_LEVEL >= 1 && console.error ('[tools]', ...a),
  warn:  (...a) => CUR_LEVEL >= 2 && console.warn  ('[tools]', ...a),
  info:  (...a) => CUR_LEVEL >= 3 && console.log   ('[tools]', ...a),
  debug: (...a) => CUR_LEVEL >= 4 && console.log   ('[tools]', ...a),
};

/* ═══════════════════════════════════════════════════════════════════════════
   03 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

function uuid() {
  return crypto.randomUUID();
}

function sha256(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

function md5(str) {
  return crypto.createHash('md5').update(String(str)).digest('hex');
}

function sha1(str) {
  return crypto.createHash('sha1').update(String(str)).digest('hex');
}

function now() {
  return Date.now();
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(str, max) {
  str = String(str || '');
  if (str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

function fmtMs(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · CALCULADORA · parser propio sin eval
   ═══════════════════════════════════════════════════════════════════════════ */

const CALC_CONSTANTS = {
  pi: Math.PI,
  π: Math.PI,
  e: Math.E,
  tau: Math.PI * 2,
  τ: Math.PI * 2,
  phi: (1 + Math.sqrt(5)) / 2,
  φ: (1 + Math.sqrt(5)) / 2,
  inf: Infinity,
  infinity: Infinity,
  nan: NaN,
};

const CALC_FUNCTIONS = {
  // Trigonometría
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,

  // Básicas
  abs: Math.abs, sign: Math.sign,
  sqrt: Math.sqrt, cbrt: Math.cbrt,
  exp: Math.exp, log: Math.log, ln: Math.log,
  log2: Math.log2, log10: Math.log10,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  trunc: Math.trunc,

  // Multi-arg
  pow: (a, b) => Math.pow(a, b),
  min: Math.min, max: Math.max,
  hypot: Math.hypot,
  atan2: Math.atan2,

  // Varios
  fact: (n) => {
    n = Math.floor(n);
    if (n < 0) throw new Error('factorial de negativo');
    if (n > 170) throw new Error('factorial demasiado grande');
    let r = 1;
    for (let i = 2; i <= n; i++) r *= i;
    return r;
  },
  deg: (r) => r * 180 / Math.PI,
  rad: (d) => d * Math.PI / 180,
  rand: Math.random,
  randint: (a, b) => Math.floor(Math.random() * (b - a + 1)) + a,
};

function calcTokenize(src) {
  const tokens = [];
  let i = 0;
  const s = String(src);

  while (i < s.length) {
    const c = s[i];

    // Espacios
    if (/\s/.test(c)) { i++; continue; }

    // Números (int, float, científica)
    if (/\d/.test(c) || (c === '.' && /\d/.test(s[i + 1]))) {
      let j = i;
      while (j < s.length && /[\d.]/.test(s[j])) j++;
      if (s[j] === 'e' || s[j] === 'E') {
        j++;
        if (s[j] === '+' || s[j] === '-') j++;
        while (j < s.length && /\d/.test(s[j])) j++;
      }
      tokens.push({ type: 'num', value: parseFloat(s.slice(i, j)) });
      i = j;
      continue;
    }

    // Identificadores (funciones y constantes)
    if (/[a-zA-Z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-zA-Z0-9_]/.test(s[j])) j++;
      tokens.push({ type: 'id', value: s.slice(i, j) });
      i = j;
      continue;
    }

    // Operadores y paréntesis
    if ('+-*/%^(),'.includes(c)) {
      tokens.push({ type: 'op', value: c });
      i++;
      continue;
    }

    throw new Error('Carácter inválido: ' + c);
  }

  return tokens;
}

function calcParse(tokens) {
  let pos = 0;

  function peek() { return tokens[pos]; }
  function consume() { return tokens[pos++]; }
  function expect(val) {
    const t = tokens[pos];
    if (!t || t.value !== val) throw new Error('Esperaba "' + val + '"');
    pos++;
  }

  // expression := term (('+' | '-') term)*
  function parseExpression() {
    let left = parseTerm();
    while (peek() && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  // term := factor (('*' | '/' | '%') factor)*
  function parseTerm() {
    let left = parseFactor();
    while (peek() && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = consume().value;
      const right = parseFactor();
      if (op === '*') left = left * right;
      else if (op === '/') {
        if (right === 0) throw new Error('División por cero');
        left = left / right;
      } else left = left % right;
    }
    return left;
  }

  // factor := unary ('^' factor)?  (right associative)
  function parseFactor() {
    const base = parseUnary();
    if (peek() && peek().value === '^') {
      consume();
      const exp = parseFactor();
      return Math.pow(base, exp);
    }
    return base;
  }

  // unary := ('-' | '+')? primary
  function parseUnary() {
    if (peek() && (peek().value === '-' || peek().value === '+')) {
      const op = consume().value;
      const val = parseUnary();
      return op === '-' ? -val : val;
    }
    return parsePrimary();
  }

  // primary := num | constant | function call | '(' expression ')'
  function parsePrimary() {
    const t = peek();
    if (!t) throw new Error('Expresión incompleta');

    // Número
    if (t.type === 'num') {
      consume();
      return t.value;
    }

    // Identificador: función o constante
    if (t.type === 'id') {
      const name = t.value.toLowerCase();
      consume();

      // Función: next token es '('
      if (peek() && peek().value === '(') {
        consume();
        const args = [];
        if (peek() && peek().value !== ')') {
          args.push(parseExpression());
          while (peek() && peek().value === ',') {
            consume();
            args.push(parseExpression());
          }
        }
        expect(')');

        const fn = CALC_FUNCTIONS[name];
        if (!fn) throw new Error('Función desconocida: ' + name);
        try {
          return fn.apply(null, args);
        } catch (e) {
          throw new Error('Error en ' + name + '(): ' + e.message);
        }
      }

      // Constante
      if (name in CALC_CONSTANTS) {
        return CALC_CONSTANTS[name];
      }

      throw new Error('Identificador desconocido: ' + name);
    }

    // Paréntesis
    if (t.value === '(') {
      consume();
      const val = parseExpression();
      expect(')');
      return val;
    }

    throw new Error('Token inesperado: ' + t.value);
  }

  const result = parseExpression();
  if (pos < tokens.length) {
    throw new Error('Tokens sobrantes al final');
  }
  return result;
}

function calculate(expression) {
  if (!expression || typeof expression !== 'string') {
    throw new Error('Expresión vacía');
  }
  if (expression.length > 500) {
    throw new Error('Expresión demasiado larga (max 500 chars)');
  }

  const tokens = calcTokenize(expression);
  if (tokens.length === 0) throw new Error('Expresión vacía');
  if (tokens.length > 200) throw new Error('Demasiados tokens');

  const result = calcParse(tokens);

  if (!isFinite(result) && !isNaN(result)) {
    return { result, warning: 'Resultado infinito' };
  }

  return {
    result,
    formatted: formatNumber(result),
  };
}

function formatNumber(n) {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  if (Math.abs(n) < 0.0001 || Math.abs(n) > 1e15) return n.toExponential(6);
  const s = n.toFixed(10);
  return s.replace(/\.?0+$/, '');
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · CACHE LRU
   ═══════════════════════════════════════════════════════════════════════════ */

class LRUCache {
  constructor(maxSize = 500) {
    this.max = maxSize;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return null;
    const entry = this.map.get(key);
    if (entry.expiresAt && entry.expiresAt < now()) {
      this.map.delete(key);
      return null;
    }
    // Move to end (LRU)
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.map.size >= this.max) {
      // Evict oldest
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, {
      value,
      expiresAt: ttlMs ? now() + ttlMs : 0,
    });
  }

  has(key) { return this.get(key) !== null; }

  clear() { this.map.clear(); }

  size() { return this.map.size; }

  stats() { return { size: this.map.size, max: this.max }; }
}

const _cache = new LRUCache(CFG.cache.maxEntries);

function cacheKey(toolName, args) {
  const sorted = JSON.stringify(args, Object.keys(args).sort());
  return sha256(toolName + '|' + sorted);
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · RATE LIMITER
   ═══════════════════════════════════════════════════════════════════════════ */

class RateLimiter {
  constructor() {
    this.buckets = new Map();
  }

  check(key, limit, windowMs) {
    const nowTs = now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt < nowTs) {
      bucket = { count: 0, resetAt: nowTs + windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > limit) {
      return {
        ok: false,
        resetAt: bucket.resetAt,
        retryAfterMs: bucket.resetAt - nowTs,
      };
    }
    return { ok: true, remaining: limit - bucket.count };
  }

  cleanup() {
    const nowTs = now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt < nowTs) this.buckets.delete(key);
    }
  }

  clear() { this.buckets.clear(); }
}

const _rateLimiter = new RateLimiter();

// Cleanup cada 5 min
const _rateCleanup = setInterval(() => _rateLimiter.cleanup(), 5 * 60_000);
if (_rateCleanup.unref) _rateCleanup.unref();

/* ═══════════════════════════════════════════════════════════════════════════
   07 · CIRCUIT BREAKER
   ═══════════════════════════════════════════════════════════════════════════ */

const _circuitState = new Map(); // name -> { failures, openedAt }

function circuitCheck(name) {
  if (!CFG.circuit.enabled) return { ok: true };
  const st = _circuitState.get(name);
  if (!st) return { ok: true };
  if (st.failures < CFG.circuit.failureThreshold) return { ok: true };
  if (now() - st.openedAt > CFG.circuit.resetAfterMs) {
    _circuitState.delete(name);
    return { ok: true };
  }
  return {
    ok: false,
    retryAfterMs: CFG.circuit.resetAfterMs - (now() - st.openedAt),
  };
}

function circuitSuccess(name) {
  if (!CFG.circuit.enabled) return;
  _circuitState.delete(name);
}

function circuitFail(name) {
  if (!CFG.circuit.enabled) return;
  let st = _circuitState.get(name);
  if (!st) st = { failures: 0, openedAt: 0 };
  st.failures++;
  if (st.failures >= CFG.circuit.failureThreshold) {
    st.openedAt = now();
  }
  _circuitState.set(name, st);
}

function circuitState(name) {
  const st = _circuitState.get(name);
  if (!st) return 'closed';
  if (st.failures >= CFG.circuit.failureThreshold) {
    if (now() - st.openedAt > CFG.circuit.resetAfterMs) return 'half-open';
    return 'open';
  }
  return 'closed';
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · MÉTRICAS
   ═══════════════════════════════════════════════════════════════════════════ */

const _metrics = {
  calls: 0,
  successes: 0,
  failures: 0,
  cached: 0,
  rateLimited: 0,
  circuitOpen: 0,
  timeouts: 0,
  byTool: new Map(), // name -> { calls, ok, fail, totalMs, p95buffer }
  since: now(),
};

function recordCall(name, ok, durationMs, cached) {
  _metrics.calls++;
  if (cached) _metrics.cached++;
  if (ok) _metrics.successes++;
  else _metrics.failures++;

  let t = _metrics.byTool.get(name);
  if (!t) {
    t = { calls: 0, ok: 0, fail: 0, totalMs: 0, durations: [] };
    _metrics.byTool.set(name, t);
  }
  t.calls++;
  if (ok) t.ok++;
  else t.fail++;
  t.totalMs += durationMs;
  t.durations.push(durationMs);
  if (t.durations.length > 100) t.durations.shift();
}

function getMetrics() {
  const byTool = {};
  for (const [name, t] of _metrics.byTool) {
    const sorted = t.durations.slice().sort((a, b) => a - b);
    byTool[name] = {
      calls: t.calls,
      ok: t.ok,
      fail: t.fail,
      avgMs: t.calls > 0 ? Math.round(t.totalMs / t.calls) : 0,
      p50Ms: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.5)] : 0,
      p95Ms: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.95)] : 0,
    };
  }
  return {
    calls: _metrics.calls,
    successes: _metrics.successes,
    failures: _metrics.failures,
    cached: _metrics.cached,
    rateLimited: _metrics.rateLimited,
    circuitOpen: _metrics.circuitOpen,
    timeouts: _metrics.timeouts,
    successRate: _metrics.calls > 0 ? +(_metrics.successes / _metrics.calls).toFixed(4) : 0,
    uptimeMs: now() - _metrics.since,
    cache: _cache.stats(),
    circuit: Object.fromEntries(
      Array.from(_circuitState.entries()).map(([k]) => [k, circuitState(k)])
    ),
    byTool,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   09 · HTTP HELPER · con SSRF protection
   ═══════════════════════════════════════════════════════════════════════════ */

async function safeFetch(url, opts = {}) {
  // 1) Validar scheme
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error('URL inválida: ' + url);
  }

  if (!CFG.http.allowedSchemes.includes(parsed.protocol)) {
    throw new Error('Scheme no permitido: ' + parsed.protocol);
  }

  // 2) Bloquear hosts conocidos
  const host = parsed.hostname.toLowerCase();
  if (CFG.http.blockedHosts.includes(host)) {
    throw new Error('Host bloqueado por seguridad');
  }
  for (const blocked of CFG.http.blockedCidrs) {
    if (host.startsWith(blocked)) {
      throw new Error('Host bloqueado por seguridad (IP privada)');
    }
  }

  // 3) Bloquear IPs privadas via DNS resolve
  if (net.isIP(host) === 0) {
    try {
      const addrs = await dns.resolve4(host);
      for (const ip of addrs) {
        if (isPrivateIP(ip)) {
          throw new Error('Host resuelve a IP privada: ' + ip);
        }
      }
    } catch (e) {
      if (e.message.includes('IP privada')) throw e;
      // Si no resuelve, dejar que fetch falle naturalmente
    }
  } else if (isPrivateIP(host)) {
    throw new Error('IP privada bloqueada');
  }

  // 4) Timeout
  const timeoutMs = opts.timeoutMs || CFG.defaultTimeoutMs;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  // Si viene un signal externo, encadenarlo
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => ctrl.abort());
  }

  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: {
        'User-Agent': CFG.http.userAgent,
        'Accept': opts.accept || 'application/json, text/html, text/plain, */*',
        ...(opts.headers || {}),
      },
      body: opts.body,
      signal: ctrl.signal,
      redirect: 'follow',
    });

    // 5) Limitar tamaño
    const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
    if (contentLength > CFG.http.maxResponseBytes) {
      throw new Error('Respuesta demasiado grande: ' + contentLength + ' bytes');
    }

    const contentType = res.headers.get('content-type') || '';

    // Leer con límite
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > CFG.http.maxResponseBytes) {
        reader.cancel();
        throw new Error('Respuesta excede el límite de ' + CFG.http.maxResponseBytes);
      }
      chunks.push(value);
    }

    const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)));

    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers.entries()),
      contentType,
      buffer,
      size: total,
    };
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Timeout tras ' + timeoutMs + 'ms');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function safeFetchJSON(url, opts = {}) {
  const res = await safeFetch(url, opts);
  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ' ' + res.statusText);
  }
  try {
    return JSON.parse(res.buffer.toString('utf-8'));
  } catch (e) {
    throw new Error('Respuesta no es JSON válido');
  }
}

async function safeFetchText(url, opts = {}) {
  const res = await safeFetch(url, opts);
  if (!res.ok) {
    throw new Error('HTTP ' + res.status + ' ' + res.statusText);
  }
  return res.buffer.toString('utf-8');
}

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('fe80')) return true;
    return false;
  }
  return false;
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · VALIDACIÓN DE SCHEMA (JSON Schema subset)
   ═══════════════════════════════════════════════════════════════════════════ */

function validateArgs(args, schema) {
  const errors = [];

  if (!isPlainObject(args)) {
    return { ok: false, errors: ['args debe ser un objeto'] };
  }

  if (schema.type !== 'object') return { ok: true };

  const required = schema.required || [];
  const props = schema.properties || {};

  // Required
  for (const key of required) {
    if (!(key in args)) {
      errors.push('Falta parámetro requerido: ' + key);
    }
  }

  // Tipos
  for (const [key, val] of Object.entries(args)) {
    const propSchema = props[key];
    if (!propSchema) {
      // Permitir extras silenciosamente
      continue;
    }
    const expected = propSchema.type;
    const actual = Array.isArray(val) ? 'array' : typeof val;

    if (expected && expected !== actual) {
      errors.push(key + ': esperado ' + expected + ', obtenido ' + actual);
      continue;
    }

    if (expected === 'string' && propSchema.maxLength && val.length > propSchema.maxLength) {
      errors.push(key + ': max ' + propSchema.maxLength + ' caracteres');
    }
    if (expected === 'number') {
      if (propSchema.minimum !== undefined && val < propSchema.minimum) {
        errors.push(key + ': min ' + propSchema.minimum);
      }
      if (propSchema.maximum !== undefined && val > propSchema.maximum) {
        errors.push(key + ': max ' + propSchema.maximum);
      }
    }
    if (expected === 'string' && propSchema.enum && !propSchema.enum.includes(val)) {
      errors.push(key + ': debe ser uno de ' + propSchema.enum.join(', '));
    }
  }

  return { ok: errors.length === 0, errors };
}

/* ═══════════════════════════════════════════════════════════════════════════
   11 · REGISTRY
   ═══════════════════════════════════════════════════════════════════════════ */

const _tools = new Map();

function register(def) {
  if (!def || !def.name) throw new Error('Tool sin nombre');
  if (typeof def.execute !== 'function') throw new Error('Tool sin execute');

  const normalized = {
    name: def.name,
    description: def.description || '',
    category: def.category || 'other',
    parameters: def.parameters || { type: 'object', properties: {} },
    cache: def.cache !== false ? {
      enabled: true,
      ttlMs: CFG.cache.defaultTtlMs,
      ...(typeof def.cache === 'object' ? def.cache : {}),
    } : { enabled: false },
    rateLimit: def.rateLimit !== false ? {
      perMinute: CFG.rateLimit.defaultPerMinute,
      perHour: CFG.rateLimit.defaultPerHour,
      ...(typeof def.rateLimit === 'object' ? def.rateLimit : {}),
    } : { perMinute: Infinity, perHour: Infinity },
    timeoutMs: def.timeoutMs || CFG.defaultTimeoutMs,
    retries: def.retries ?? CFG.defaultRetries,
    requiresAuth: def.requiresAuth === true,
    beta: def.beta === true,
    execute: def.execute,
    _registeredAt: now(),
    _calls: 0,
  };

  _tools.set(def.name, normalized);
  LOG.info('tool registered:', def.name);
  return def.name;
}

function unregister(name) {
  return _tools.delete(name);
}

function getTool(name) {
  return _tools.get(name) || null;
}

function listTools(filter = {}) {
  let out = Array.from(_tools.values());
  if (filter.category) out = out.filter(t => t.category === filter.category);
  if (filter.noBeta) out = out.filter(t => !t.beta);
  if (filter.authed !== undefined) {
    out = out.filter(t => t.requiresAuth === filter.authed);
  }
  return out;
}

function clearTools() {
  _tools.clear();
}

/* ═══════════════════════════════════════════════════════════════════════════
   12 · EXECUTOR
   ═══════════════════════════════════════════════════════════════════════════ */

async function execute(name, args, ctx = {}) {
  const tool = _tools.get(name);
  if (!tool) {
    return {
      ok: false,
      error: 'Tool no encontrado: ' + name,
      code: 'TOOL_NOT_FOUND',
    };
  }

  // Circuit breaker
  const cb = circuitCheck(name);
  if (!cb.ok) {
    _metrics.circuitOpen++;
    return {
      ok: false,
      error: 'Circuit breaker abierto para ' + name,
      code: 'CIRCUIT_OPEN',
      retryAfterMs: cb.retryAfterMs,
    };
  }

  // Validar args
  const validation = validateArgs(args || {}, tool.parameters);
  if (!validation.ok) {
    return {
      ok: false,
      error: 'Argumentos inválidos: ' + validation.errors.join('; '),
      code: 'INVALID_ARGS',
      details: validation.errors,
    };
  }

  // Rate limit (por user + tool)
  if (CFG.rateLimit.enabled && tool.rateLimit.perMinute !== Infinity) {
    const userId = ctx.userId || 'anon';
    const rl = _rateLimiter.check(
      userId + ':' + name,
      tool.rateLimit.perMinute,
      60_000
    );
    if (!rl.ok) {
      _metrics.rateLimited++;
      return {
        ok: false,
        error: 'Rate limit alcanzado. Reintentá en ' + Math.ceil(rl.retryAfterMs / 1000) + 's.',
        code: 'RATE_LIMITED',
        retryAfterMs: rl.retryAfterMs,
      };
    }
  }

  // Cache
  const ckey = cacheKey(name, args || {});
  if (tool.cache.enabled && CFG.cache.enabled) {
    const cached = _cache.get(ckey);
    if (cached !== null) {
      _metrics.cached++;
      recordCall(name, true, 0, true);
      LOG.debug('cache hit:', name);
      return { ok: true, result: cached, cached: true };
    }
  }

  // Ejecutar con timeout
  const t0 = now();
  const timeoutMs = tool.timeoutMs;
  let attempt = 0;
  const maxAttempts = 1 + Math.min(tool.retries, CFG.maxRetries);

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const execPromise = tool.execute(args || {}, ctx);
      const timeoutPromise = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('TIMEOUT')), timeoutMs)
      );

      const result = await Promise.race([execPromise, timeoutPromise]);
      const durationMs = now() - t0;

      // Guardar en cache
      if (tool.cache.enabled && CFG.cache.enabled) {
        _cache.set(ckey, result, tool.cache.ttlMs);
      }

      circuitSuccess(name);
      recordCall(name, true, durationMs, false);
      tool._calls++;

      // Emit
      try {
        if (typeof globalThis.dispatchEvent !== 'undefined') {
          globalThis.dispatchEvent(new CustomEvent('nm:tools:execute', {
            detail: { name, args, durationMs, ok: true, cached: false },
          }));
        }
      } catch (e) {}

      LOG.debug('tool', name, 'ok in', fmtMs(durationMs));
      return { ok: true, result, durationMs };
    } catch (e) {
      const isTimeout = e.message === 'TIMEOUT';
      if (isTimeout) _metrics.timeouts++;

      if (attempt >= maxAttempts) {
        circuitFail(name);
        recordCall(name, false, now() - t0, false);
        LOG.warn('tool', name, 'failed:', e.message);

        return {
          ok: false,
          error: isTimeout ? 'Timeout después de ' + timeoutMs + 'ms' : e.message,
          code: isTimeout ? 'TIMEOUT' : 'EXEC_ERROR',
        };
      }

      // Retry
      await new Promise(r => setTimeout(r, CFG.retryDelayMs * attempt));
      LOG.debug('retry', name, 'attempt', attempt + 1);
    }
  }
}

async function executeMany(calls, ctx = {}) {
  if (!Array.isArray(calls)) return [];
  // Ejecutar en paralelo con límite
  const results = await Promise.allSettled(
    calls.slice(0, CFG.maxToolCallsPerTurn).map(async (call) => {
      const r = await execute(call.name, call.args, ctx);
      return { ...call, result: r };
    })
  );
  return results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason });
}

/* ═══════════════════════════════════════════════════════════════════════════
   13 · TOOLS BUILT-IN · utility
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── calculator ───
register({
  name: 'calculator',
  description: 'Evalúa una expresión matemática. Soporta +, -, *, /, %, ^, paréntesis y funciones (sin, cos, sqrt, log, etc.).',
  category: 'utility',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description: 'Expresión a evaluar. Ej: "2 + 2", "sqrt(16) + sin(pi/2)", "(3^4) % 7"',
        maxLength: 500,
      },
    },
    required: ['expression'],
  },
  cache: { enabled: true, ttlMs: 60_000 },
  execute: async ({ expression }) => {
    const r = calculate(expression);
    return {
      result: r.result,
      formatted: r.formatted || String(r.result),
      expression,
    };
  },
});

// ─── datetime ───
register({
  name: 'datetime',
  description: 'Obtiene la fecha y hora actual. Opcionalmente en una zona horaria específica.',
  category: 'utility',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'Zona horaria IANA. Ej: "America/Bogota", "Europe/Madrid", "Asia/Tokyo". Por defecto usa la del servidor.',
      },
      format: {
        type: 'string',
        description: 'Formato: "iso", "locale", "unix". Por defecto "iso".',
        enum: ['iso', 'locale', 'unix'],
      },
    },
  },
  cache: { enabled: false },
  execute: async ({ timezone, format = 'iso' }) => {
    const d = new Date();
    const result = {
      unix: Math.floor(d.getTime() / 1000),
      iso: d.toISOString(),
      timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    };

    try {
      if (timezone) {
        result.local = d.toLocaleString('es-CO', { timeZone: timezone });
        result.offset = getTimezoneOffset(timezone, d);
      } else {
        result.local = d.toLocaleString('es-CO');
      }
    } catch (e) {
      result.local = d.toLocaleString('es-CO');
      result.warning = 'Timezone inválido: ' + timezone;
    }

    if (format === 'unix') return { result: result.unix };
    if (format === 'locale') return { result: result.local, ...result };
    return result;
  },
});

function getTimezoneOffset(tz, date) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(date);
    const tzName = parts.find(p => p.type === 'timeZoneName')?.value || '';
    return tzName;
  } catch (e) {
    return '';
  }
}

// ─── unit_convert ───
const UNIT_CONVERSIONS = {
  // Longitud (base: metro)
  m: 1, km: 1000, cm: 0.01, mm: 0.001,
  mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254,
  nmi: 1852, ly: 9.4607e15,

  // Masa (base: kg)
  kg: 1, g: 0.001, mg: 1e-6, t: 1000,
  lb: 0.453592, oz: 0.0283495, st: 6.35029,

  // Volumen (base: litro)
  l: 1, ml: 0.001, m3: 1000, cm3: 0.001,
  gal: 3.78541, qt: 0.946353, pt: 0.473176, cup: 0.236588, floz: 0.0295735,

  // Tiempo (base: segundo)
  s: 1, ms: 0.001, min: 60, h: 3600, d: 86400, wk: 604800,
  mo: 2629746, yr: 31556952,

  // Temperatura (fórmulas especiales)
  c: 'temp_c', f: 'temp_f', k: 'temp_k',

  // Área (base: m²)
  m2: 1, km2: 1e6, cm2: 1e-4, ha: 10000, ac: 4046.86,
  ft2: 0.092903, in2: 0.00064516, mi2: 2589988,

  // Velocidad (base: m/s)
  mps: 1, kph: 0.277778, mph: 0.44704, kn: 0.514444,

  // Datos (base: byte)
  b: 1, kb: 1024, mb: 1048576, gb: 1073741824, tb: 1099511627776,
};

register({
  name: 'unit_convert',
  description: 'Convierte entre unidades (longitud, masa, volumen, tiempo, temperatura, área, velocidad, datos).',
  category: 'utility',
  parameters: {
    type: 'object',
    properties: {
      value: { type: 'number', description: 'Cantidad a convertir' },
      from: { type: 'string', description: 'Unidad origen. Ej: "km", "lb", "c"' },
      to: { type: 'string', description: 'Unidad destino. Ej: "mi", "kg", "f"' },
    },
    required: ['value', 'from', 'to'],
  },
  cache: { enabled: true, ttlMs: 300_000 },
  execute: async ({ value, from, to }) => {
    const f = String(from).toLowerCase().trim();
    const t = String(to).toLowerCase().trim();

    // Temperatura
    if (['c', 'f', 'k'].includes(f) && ['c', 'f', 'k'].includes(t)) {
      let celsius;
      if (f === 'c') celsius = value;
      else if (f === 'f') celsius = (value - 32) * 5 / 9;
      else celsius = value - 273.15;

      let result;
      if (t === 'c') result = celsius;
      else if (t === 'f') result = celsius * 9 / 5 + 32;
      else result = celsius + 273.15;

      return {
        result: +result.toFixed(4),
        from: value + '°' + f.toUpperCase(),
        to: +result.toFixed(4) + '°' + t.toUpperCase(),
      };
    }

    const fVal = UNIT_CONVERSIONS[f];
    const tVal = UNIT_CONVERSIONS[t];

    if (!fVal || typeof fVal === 'string') throw new Error('Unidad origen no válida: ' + f);
    if (!tVal || typeof tVal === 'string') throw new Error('Unidad destino no válida: ' + t);
    if (!canConvert(f, t)) throw new Error('No se puede convertir entre ' + f + ' y ' + t + ' (categorías diferentes)');

    const result = (value * fVal) / tVal;
    return {
      result: +result.toFixed(6),
      from: value + ' ' + f,
      to: +result.toFixed(6) + ' ' + t,
    };
  },
});

function canConvert(a, b) {
  const categories = [
    ['m', 'km', 'cm', 'mm', 'mi', 'yd', 'ft', 'in', 'nmi', 'ly'],
    ['kg', 'g', 'mg', 't', 'lb', 'oz', 'st'],
    ['l', 'ml', 'm3', 'cm3', 'gal', 'qt', 'pt', 'cup', 'floz'],
    ['s', 'ms', 'min', 'h', 'd', 'wk', 'mo', 'yr'],
    ['m2', 'km2', 'cm2', 'ha', 'ac', 'ft2', 'in2', 'mi2'],
    ['mps', 'kph', 'mph', 'kn'],
    ['b', 'kb', 'mb', 'gb', 'tb'],
  ];
  return categories.some(cat => cat.includes(a) && cat.includes(b));
}

// ─── base64 ───
register({
  name: 'base64',
  description: 'Codifica o decodifica texto en base64.',
  category: 'utility',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'encode o decode', enum: ['encode', 'decode'] },
      text: { type: 'string', description: 'Texto a procesar', maxLength: 50_000 },
    },
    required: ['action', 'text'],
  },
  cache: { enabled: true, ttlMs: 300_000 },
  execute: async ({ action, text }) => {
    if (action === 'encode') {
      return { result: Buffer.from(text, 'utf-8').toString('base64') };
    }
    try {
      return { result: Buffer.from(text, 'base64').toString('utf-8') };
    } catch (e) {
      throw new Error('Base64 inválido');
    }
  },
});

// ─── hash ───
register({
  name: 'hash',
  description: 'Genera el hash de un texto (md5, sha1, sha256).',
  category: 'utility',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Texto a hashear', maxLength: 100_000 },
      algorithm: { type: 'string', description: 'Algoritmo', enum: ['md5', 'sha1', 'sha256'] },
    },
    required: ['text'],
  },
  cache: { enabled: true, ttlMs: 60_000 },
  execute: async ({ text, algorithm = 'sha256' }) => {
    const alg = algorithm.toLowerCase();
    let hash;
    if (alg === 'md5') hash = md5(text);
    else if (alg === 'sha1') hash = sha1(text);
    else if (alg === 'sha256') hash = sha256(text);
    else throw new Error('Algoritmo no soportado');
    return { algorithm: alg, hash, length: hash.length };
  },
});

// ─── uuid ───
register({
  name: 'uuid',
  description: 'Genera uno o más UUIDs v4.',
  category: 'utility',
  parameters: {
    type: 'object',
    properties: {
      count: { type: 'number', description: 'Cantidad (1-20)', minimum: 1, maximum: 20 },
    },
  },
  cache: { enabled: false },
  execute: async ({ count = 1 }) => {
    const n = Math.min(Math.max(1, count), 20);
    const uuids = Array.from({ length: n }, () => uuid());
    return { uuids, count: n };
  },
});

// ─── random ───
register({
  name: 'random',
  description: 'Genera un número aleatorio, elige un elemento de una lista o genera una cadena random.',
  category: 'utility',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['number', 'choice', 'string'] },
      min: { type: 'number', description: 'Para type=number' },
      max: { type: 'number', description: 'Para type=number' },
      items: { type: 'array', description: 'Para type=choice' },
      length: { type: 'number', description: 'Para type=string (1-100)', minimum: 1, maximum: 100 },
    },
    required: ['type'],
  },
  cache: { enabled: false },
  execute: async ({ type, min = 0, max = 100, items, length = 8 }) => {
    if (type === 'number') {
      return { result: Math.floor(Math.random() * (max - min + 1)) + min };
    }
    if (type === 'choice') {
      if (!Array.isArray(items) || items.length === 0) throw new Error('items vacío');
      return { result: items[Math.floor(Math.random() * items.length)] };
    }
    if (type === 'string') {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let out = '';
      for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * chars.length)];
      return { result: out };
    }
    throw new Error('type inválido');
  },
});

// ─── text_stats ───
register({
  name: 'text_stats',
  description: 'Cuenta palabras, caracteres, oraciones, párrafos y tiempo estimado de lectura.',
  category: 'utility',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', maxLength: 500_000 },
    },
    required: ['text'],
  },
  cache: { enabled: true, ttlMs: 60_000 },
  execute: async ({ text }) => {
    const chars = text.length;
    const charsNoSpaces = text.replace(/\s/g, '').length;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0).length;
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0).length;
    const readingMinutes = Math.ceil(words / 200);
    return {
      chars,
      charsNoSpaces,
      words,
      sentences,
      paragraphs,
      readingMinutes,
      avgWordLength: words > 0 ? +(charsNoSpaces / words).toFixed(2) : 0,
    };
  },
});

// ─── case_convert ───
register({
  name: 'case_convert',
  description: 'Convierte texto entre camelCase, snake_case, kebab-case, PascalCase, CONSTANT_CASE, Title Case.',
  category: 'utility',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string' },
      to: { type: 'string', enum: ['camel', 'snake', 'kebab', 'pascal', 'constant', 'title', 'upper', 'lower'] },
    },
    required: ['text', 'to'],
  },
  cache: { enabled: true, ttlMs: 300_000 },
  execute: async ({ text, to }) => {
    const words = String(text)
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[_\-\s]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(w => w.toLowerCase());

    let result;
    if (to === 'camel') result = words.map((w, i) => i === 0 ? w : w[0].toUpperCase() + w.slice(1)).join('');
    else if (to === 'snake') result = words.join('_');
    else if (to === 'kebab') result = words.join('-');
    else if (to === 'pascal') result = words.map(w => w[0].toUpperCase() + w.slice(1)).join('');
    else if (to === 'constant') result = words.join('_').toUpperCase();
    else if (to === 'title') result = words.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
    else if (to === 'upper') result = text.toUpperCase();
    else if (to === 'lower') result = text.toLowerCase();
    else throw new Error('to inválido');

    return { result };
  },
});

// ─── color_convert ───
register({
  name: 'color_convert',
  description: 'Convierte un color entre formatos hex, rgb y hsl.',
  category: 'utility',
  parameters: {
    type: 'object',
    properties: {
      color: { type: 'string', description: 'Color en hex (#fff, #ffffff), rgb (rgb(255,0,0)) o hsl (hsl(0,100%,50%))' },
    },
    required: ['color'],
  },
  cache: { enabled: true, ttlMs: 60_000 },
  execute: async ({ color }) => {
    const parsed = parseColor(color);
    if (!parsed) throw new Error('Color no válido');
    return {
      hex: rgbToHex(parsed.r, parsed.g, parsed.b),
      rgb: { r: parsed.r, g: parsed.g, b: parsed.b },
      hsl: rgbToHsl(parsed.r, parsed.g, parsed.b),
      css: `rgb(${parsed.r}, ${parsed.g}, ${parsed.b})`,
    };
  },
});

function parseColor(c) {
  c = String(c).trim().toLowerCase();
  // Hex
  let m = c.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) {
    let hex = m[1];
    if (hex.length === 3) hex = hex.split('').map(x => x + x).join('');
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  // RGB
  m = c.match(/rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  // HSL
  m = c.match(/hsla?\s*\(\s*(\d+)\s*,\s*(\d+)%?\s*,\s*(\d+)%?/);
  if (m) return hslToRgb(+m[1], +m[2], +m[3]);
  return null;
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  let r, g, b;
  if (s === 0) { r = g = b = l; }
  else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

/* ═══════════════════════════════════════════════════════════════════════════
   14 · TOOLS BUILT-IN · data
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── json_format ───
register({
  name: 'json_format',
  description: 'Formatea, valida o minifica JSON. También extrae un campo específico con path.',
  category: 'data',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['format', 'minify', 'validate', 'extract'] },
      json: { type: 'string', maxLength: 200_000 },
      indent: { type: 'number', description: 'Espacios para indent (1-8)', minimum: 0, maximum: 8 },
      path: { type: 'string', description: 'Para extract: ej "user.name" o "items[0].id"' },
    },
    required: ['action', 'json'],
  },
  cache: { enabled: true, ttlMs: 60_000 },
  execute: async ({ action, json, indent = 2, path }) => {
    let parsed;
    try { parsed = JSON.parse(json); }
    catch (e) { throw new Error('JSON inválido: ' + e.message); }

    if (action === 'validate') return { valid: true };

    if (action === 'format') {
      return { result: JSON.stringify(parsed, null, indent), length: JSON.stringify(parsed, null, indent).length };
    }

    if (action === 'minify') {
      const minified = JSON.stringify(parsed);
      return { result: minified, saved: json.length - minified.length };
    }

    if (action === 'extract') {
      if (!path) throw new Error('path es requerido');
      const value = extractPath(parsed, path);
      return { path, value };
    }
  },
});

function extractPath(obj, path) {
  const parts = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur;
}

// ─── regex_test ───
register({
  name: 'regex_test',
  description: 'Prueba una expresión regular contra un texto. Devuelve matches y grupos.',
  category: 'data',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Expresión regular (sin slashes)' },
      flags: { type: 'string', description: 'Flags: g i m s u y' },
      text: { type: 'string', maxLength: 50_000 },
    },
    required: ['pattern', 'text'],
  },
  cache: { enabled: true, ttlMs: 60_000 },
  execute: async ({ pattern, flags = 'g', text }) => {
    let re;
    try { re = new RegExp(pattern, flags); }
    catch (e) { throw new Error('Regex inválido: ' + e.message); }

    const matches = [];
    if (flags.includes('g')) {
      let m;
      while ((m = re.exec(text)) !== null) {
        matches.push({ match: m[0], index: m.index, groups: m.slice(1) });
        if (m.index === re.lastIndex) re.lastIndex++;
        if (matches.length > 100) break;
      }
    } else {
      const m = re.exec(text);
      if (m) matches.push({ match: m[0], index: m.index, groups: m.slice(1) });
    }

    return { matches, count: matches.length };
  },
});

// ─── url_encode ───
register({
  name: 'url_encode',
  description: 'Codifica o decodifica URL components.',
  category: 'data',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['encode', 'decode', 'parse'] },
      text: { type: 'string' },
    },
    required: ['action', 'text'],
  },
  cache: { enabled: true, ttlMs: 300_000 },
  execute: async ({ action, text }) => {
    if (action === 'encode') return { result: encodeURIComponent(text) };
    if (action === 'decode') return { result: decodeURIComponent(text) };
    if (action === 'parse') {
      try {
        const u = new URL(text);
        return {
          protocol: u.protocol,
          host: u.host,
          pathname: u.pathname,
          search: u.search,
          hash: u.hash,
          query: Object.fromEntries(u.searchParams.entries()),
        };
      } catch (e) { throw new Error('URL inválida'); }
    }
  },
});

// ─── lorem_ipsum ───
const LOREM_WORDS = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(' ');

register({
  name: 'lorem_ipsum',
  description: 'Genera texto de relleno Lorem Ipsum.',
  category: 'data',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['paragraphs', 'sentences', 'words'] },
      count: { type: 'number', description: 'Cantidad (1-20)', minimum: 1, maximum: 20 },
    },
    required: ['type'],
  },
  cache: { enabled: false },
  execute: async ({ type = 'paragraphs', count = 3 }) => {
    const n = Math.min(Math.max(1, count), 20);
    const rnd = () => Math.floor(Math.random() * LOREM_WORDS.length);
    const word = () => LOREM_WORDS[rnd()];

    function sentence() {
      const len = 8 + Math.floor(Math.random() * 10);
      const words = Array.from({ length: len }, word);
      words[0] = words[0][0].toUpperCase() + words[0].slice(1);
      return words.join(' ') + '.';
    }
    function paragraph() {
      const len = 3 + Math.floor(Math.random() * 4);
      return Array.from({ length: len }, sentence).join(' ');
    }

    if (type === 'words') return { result: Array.from({ length: n * 10 }, word).join(' ') };
    if (type === 'sentences') return { result: Array.from({ length: n }, sentence).join(' ') };
    return { result: Array.from({ length: n }, paragraph).join('\n\n') };
  },
});

// ─── sort_array ───
register({
  name: 'sort_array',
  description: 'Ordena un array de números o strings, con opción de dirección y eliminación de duplicados.',
  category: 'data',
  parameters: {
    type: 'object',
    properties: {
      items: { type: 'array' },
      direction: { type: 'string', enum: ['asc', 'desc'] },
      unique: { type: 'boolean' },
      numeric: { type: 'boolean' },
    },
    required: ['items'],
  },
  cache: { enabled: true, ttlMs: 60_000 },
  execute: async ({ items, direction = 'asc', unique = false, numeric = false }) => {
    let arr = items.slice();
    if (unique) arr = Array.from(new Set(arr));
    if (numeric) arr = arr.map(Number).filter(v => !isNaN(v));
    arr.sort((a, b) => numeric ? a - b : String(a).localeCompare(String(b)));
    if (direction === 'desc') arr.reverse();
    return { result: arr, count: arr.length };
  },
});

/* ═══════════════════════════════════════════════════════════════════════════
   15 · TOOLS BUILT-IN · web
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── wikipedia ───
register({
  name: 'wikipedia',
  description: 'Busca un artículo en Wikipedia y devuelve un resumen.',
  category: 'web',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Término a buscar', maxLength: 200 },
      lang: { type: 'string', description: 'Código de idioma (ej: "es", "en")', default: 'es' },
    },
    required: ['query'],
  },
  cache: { enabled: true, ttlMs: 24 * 60 * 60_000 }, // 24h
  rateLimit: { perMinute: 30, perHour: 200 },
  timeoutMs: 8000,
  execute: async ({ query, lang = 'es' }) => {
    const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}?redirect=true`;
    const data = await safeFetchJSON(url, { timeoutMs: 7000 });
    return {
      title: data.title,
      extract: data.extract,
      description: data.description,
      url: data.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(query)}`,
      thumbnail: data.thumbnail?.source || null,
    };
  },
});

// ─── weather ───
register({
  name: 'weather',
  description: 'Obtiene el clima actual de una ciudad. Sin API key (usa wttr.in).',
  category: 'web',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'Nombre de la ciudad. Ej: "Bogota", "Madrid"', maxLength: 100 },
    },
    required: ['city'],
  },
  cache: { enabled: true, ttlMs: 10 * 60_000 }, // 10 min
  rateLimit: { perMinute: 10, perHour: 60 },
  timeoutMs: 10_000,
  execute: async ({ city }) => {
    const url = `https://wttr.in/${encodeURIComponent(city)}?format=j1`;
    const data = await safeFetchJSON(url, { timeoutMs: 9000 });

    if (!data.current_condition || !data.current_condition[0]) {
      throw new Error('Ciudad no encontrada');
    }

    const cur = data.current_condition[0];
    const area = data.nearest_area?.[0];

    return {
      city: area?.areaName?.[0]?.value || city,
      country: area?.country?.[0]?.value || '',
      temp_c: +cur.temp_C,
      temp_f: +cur.temp_F,
      feels_like_c: +cur.FeelsLikeC,
      description: cur.weatherDesc?.[0]?.value || '',
      humidity: +cur.humidity,
      wind_kmph: +cur.windspeedKmph,
      pressure: +cur.pressure,
      visibility_km: +cur.visibility,
      uv_index: +cur.uvIndex,
    };
  },
});

// ─── currency ───
register({
  name: 'currency_convert',
  description: 'Convierte divisas con tasas de cambio actuales (exchangerate.host).',
  category: 'web',
  parameters: {
    type: 'object',
    properties: {
      amount: { type: 'number' },
      from: { type: 'string', description: 'Código ISO. Ej: "USD", "COP", "EUR"' },
      to: { type: 'string', description: 'Código ISO. Ej: "USD", "COP", "EUR"' },
    },
    required: ['amount', 'from', 'to'],
  },
  cache: { enabled: true, ttlMs: 60 * 60_000 }, // 1h
  rateLimit: { perMinute: 10, perHour: 60 },
  timeoutMs: 8000,
  execute: async ({ amount, from, to }) => {
    const f = String(from).toUpperCase();
    const t = String(to).toUpperCase();
    const url = `https://api.exchangerate.host/convert?from=${f}&to=${t}&amount=${amount}`;
    const data = await safeFetchJSON(url, { timeoutMs: 7000 });

    if (data.success === false) throw new Error(data.error?.info || 'Error en la API');

    return {
      from: f,
      to: t,
      amount,
      result: +data.result?.toFixed(4) || null,
      rate: data.info?.rate || null,
      date: data.date,
    };
  },
});

// ─── url_fetch ───
register({
  name: 'url_fetch',
  description: 'Descarga el contenido de una URL (HTML, JSON, texto). Bloquea IPs privadas por seguridad.',
  category: 'web',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL http o https', maxLength: 2000 },
      format: { type: 'string', enum: ['text', 'json', 'html'], description: 'Formato de salida' },
      maxLength: { type: 'number', description: 'Max chars a devolver (default 8000)', minimum: 100, maximum: 50000 },
    },
    required: ['url'],
  },
  cache: { enabled: true, ttlMs: 10 * 60_000 },
  rateLimit: { perMinute: 15, perHour: 100 },
  timeoutMs: 10_000,
  execute: async ({ url, format = 'text', maxLength = 8000 }) => {
    const res = await safeFetch(url, { timeoutMs: 9000 });

    if (!res.ok) throw new Error('HTTP ' + res.status);

    let content = res.buffer.toString('utf-8');

    if (format === 'json') {
      try { content = JSON.stringify(JSON.parse(content), null, 2); }
      catch (e) { throw new Error('La respuesta no es JSON'); }
    } else if (format === 'html') {
      // Devolver como está pero truncado
    } else {
      // Texto plano: quitar HTML tags
      content = content
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim();
    }

    return {
      url,
      status: res.status,
      contentType: res.contentType,
      size: res.size,
      content: truncate(content, maxLength),
      truncated: content.length > maxLength,
    };
  },
});

/* ═══════════════════════════════════════════════════════════════════════════
   16 · TOOLS BUILT-IN · ai (delegate)
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── web_search (wraps websearch.js) ───
register({
  name: 'web_search',
  description: 'Busca información actualizada en internet (Wikipedia, DuckDuckGo). Devuelve un resumen con fuentes.',
  category: 'ai',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Término a buscar', maxLength: 300 },
      maxResults: { type: 'number', description: 'Cantidad de resultados (1-10)', minimum: 1, maximum: 10 },
    },
    required: ['query'],
  },
  cache: { enabled: true, ttlMs: 60 * 60_000 },
  rateLimit: { perMinute: 15, perHour: 100 },
  timeoutMs: 12_000,
  execute: async ({ query, maxResults = 5 }, ctx) => {
    // Import dinámico para no romper si websearch.js no existe
    let searchWeb;
    try {
      const mod = await import('./websearch.js');
      searchWeb = mod.searchWeb;
    } catch (e) {
      throw new Error('websearch.js no disponible');
    }

    if (typeof searchWeb !== 'function') throw new Error('searchWeb no es función');

    const results = await searchWeb(query, { maxResults, language: 'es', timeout: 10000 });

    return {
      query,
      count: results.length,
      results: results.map(r => ({
        title: r.title,
        url: r.url,
        snippet: truncate(r.snippet || '', 300),
        source: r.source || '',
      })),
    };
  },
});

// ─── image_generate (wraps images.js) ───
register({
  name: 'image_generate',
  description: 'Genera una imagen a partir de una descripción.',
  category: 'ai',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Descripción de la imagen', maxLength: 500 },
      width: { type: 'number', description: 'Ancho (256-2048)', minimum: 256, maximum: 2048 },
      height: { type: 'number', description: 'Alto (256-2048)', minimum: 256, maximum: 2048 },
    },
    required: ['prompt'],
  },
  cache: { enabled: true, ttlMs: 24 * 60 * 60_000 },
  rateLimit: { perMinute: 5, perHour: 30 },
  timeoutMs: 15_000,
  execute: async ({ prompt, width = 1024, height = 1024 }) => {
    let buildImageUrl, enrichPrompt;
    try {
      const mod = await import('./images.js');
      buildImageUrl = mod.buildImageUrl;
      enrichPrompt = mod.enrichPrompt;
    } catch (e) {
      throw new Error('images.js no disponible');
    }

    const enriched = typeof enrichPrompt === 'function' ? enrichPrompt(prompt) : prompt;
    const url = buildImageUrl(enriched, { width, height });

    return {
      prompt,
      url,
      width,
      height,
      markdown: `![${prompt}](${url})`,
    };
  },
});

// ─── translate (uses LLM callback from ctx) ───
register({
  name: 'translate',
  description: 'Traduce texto de un idioma a otro usando el modelo de IA.',
  category: 'ai',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', maxLength: 5000 },
      to: { type: 'string', description: 'Idioma destino. Ej: "inglés", "francés"' },
      from: { type: 'string', description: 'Idioma origen (opcional, autodetecta)' },
    },
    required: ['text', 'to'],
  },
  cache: { enabled: true, ttlMs: 24 * 60 * 60_000 },
  rateLimit: { perMinute: 20, perHour: 200 },
  timeoutMs: 20_000,
  execute: async ({ text, to, from }, ctx) => {
    if (!ctx || typeof ctx.callLLM !== 'function') {
      throw new Error('translate requiere ctx.callLLM (función que llama al LLM)');
    }
    const systemPrompt = 'Sos un traductor profesional. Traducí el texto del usuario sin agregar explicaciones.';
    const userPrompt = from
      ? `Traducí de ${from} a ${to}:\n\n${text}`
      : `Traducí a ${to}:\n\n${text}`;

    const result = await ctx.callLLM({
      system: systemPrompt,
      user: userPrompt,
      temperature: 0.2,
    });

    return { original: text, translated: String(result || '').trim(), to, from: from || 'auto' };
  },
});

/* ═══════════════════════════════════════════════════════════════════════════
   17 · TOOLS BUILT-IN · meta
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── list_tools ───
register({
  name: 'list_tools',
  description: 'Lista todas las herramientas disponibles para el asistente.',
  category: 'meta',
  parameters: {
    type: 'object',
    properties: {
      category: { type: 'string', description: 'Filtrar por categoría' },
    },
  },
  cache: { enabled: true, ttlMs: 60_000 },
  execute: async ({ category }) => {
    const tools = listTools(category ? { category } : { noBeta: true });
    return {
      count: tools.length,
      tools: tools.map(t => ({
        name: t.name,
        description: t.description,
        category: t.category,
      })),
    };
  },
});

// ─── tool_help ───
register({
  name: 'tool_help',
  description: 'Muestra la ayuda detallada de una herramienta específica.',
  category: 'meta',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Nombre de la herramienta' },
    },
    required: ['name'],
  },
  cache: { enabled: true, ttlMs: 60_000 },
  execute: async ({ name }) => {
    const tool = getTool(name);
    if (!tool) throw new Error('Tool no encontrado: ' + name);
    return {
      name: tool.name,
      description: tool.description,
      category: tool.category,
      parameters: tool.parameters,
      rateLimit: tool.rateLimit,
      cache: tool.cache,
    };
  },
});

/* ═══════════════════════════════════════════════════════════════════════════
   18 · PROVIDER ADAPTERS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Convierte las tools al formato de OpenAI/Groq/Kimi.
 */
function forGroq(filter) {
  return listTools(filter || { noBeta: true }).map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

/**
 * Convierte las tools al formato de Gemini.
 */
function forGemini(filter) {
  const declarations = listTools(filter || { noBeta: true }).map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  return [{ functionDeclarations: declarations }];
}

/**
 * Extrae las tool_calls de la respuesta de Groq/Kimi.
 * Devuelve array de { id, name, args }.
 */
function parseGroqResponse(message) {
  if (!message || !message.tool_calls) return [];
  return message.tool_calls
    .filter(tc => tc.type === 'function' && tc.function)
    .map(tc => {
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); }
      catch (e) { LOG.warn('args parse failed', tc.function.arguments); }
      return {
        id: tc.id,
        name: tc.function.name,
        args,
        raw: tc,
      };
    });
}

/**
 * Extrae las function_calls de la respuesta de Gemini.
 */
function parseGeminiResponse(response) {
  if (!response) return [];
  try {
    const parts = response.candidates?.[0]?.content?.parts || [];
    return parts
      .filter(p => p.functionCall)
      .map((p, i) => ({
        id: 'gem_' + i + '_' + Date.now(),
        name: p.functionCall.name,
        args: p.functionCall.args || {},
      }));
  } catch (e) {
    return [];
  }
}

/**
 * Construye los mensajes de resultado de tools para Groq/Kimi.
 */
function buildGroqToolMessages(calls, results) {
  const messages = [];
  calls.forEach((call, i) => {
    const r = results[i]?.result || results[i];
    const content = r.ok
      ? JSON.stringify(r.result)
      : JSON.stringify({ error: r.error });
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content,
    });
  });
  return messages;
}

/**
 * Construye las parts de resultado para Gemini.
 */
function buildGeminiToolParts(calls, results) {
  return calls.map((call, i) => {
    const r = results[i]?.result || results[i];
    const response = r.ok ? r.result : { error: r.error };
    return {
      functionResponse: {
        name: call.name,
        response,
      },
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   19 · MULTI-TURN LOOP
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Loop que ejecuta tools hasta que el LLM termine sin pedir más.
 *
 * @param {Object} opts
 * @param {Array}  opts.messages       Historial inicial de mensajes
 * @param {Array}  opts.tools          Tools formateadas para el provider
 * @param {Function} opts.callLLM      async (messages, tools) => response
 * @param {Object} opts.ctx            Contexto de ejecución
 * @param {number} opts.maxTurns       Turnos máximos (default 6)
 * @param {string} opts.provider       'groq' | 'gemini' | 'kimi'
 * @param {Function} opts.parseResponse (resp) => { calls, text, raw }
 * @param {Function} opts.buildResults  (calls, results, messages) => newMessages
 * @param {Function} opts.onToken      Callback opcional para streaming
 */
async function runLoop(opts) {
  const {
    messages: initialMessages,
    tools,
    callLLM,
    ctx = {},
    maxTurns = CFG.maxTurnsInLoop,
    provider = 'groq',
    parseResponse,
    buildResults,
    onToken,
  } = opts;

  if (typeof callLLM !== 'function') throw new Error('callLLM requerido');
  if (typeof parseResponse !== 'function') throw new Error('parseResponse requerido');
  if (typeof buildResults !== 'function') throw new Error('buildResults requerido');

  let messages = initialMessages.slice();
  let allToolCalls = [];

  for (let turn = 0; turn < maxTurns; turn++) {
    LOG.debug('loop turn', turn + 1, '/', maxTurns);

    // Llamar al LLM
    const response = await callLLM(messages, tools, { onToken });
    const parsed = parseResponse(response);

    // Si no hay tool calls, terminamos
    if (!parsed.calls || parsed.calls.length === 0) {
      return {
        ok: true,
        turns: turn + 1,
        messages,
        finalText: parsed.text || '',
        toolCalls: allToolCalls,
        raw: response,
      };
    }

    // Ejecutar tools
    LOG.debug('executing', parsed.calls.length, 'tool calls');
    const results = await executeMany(parsed.calls, ctx);
    allToolCalls.push(...parsed.calls.map((c, i) => ({ ...c, result: results[i]?.result })));

    // Añadir mensajes del asistente y resultados
    messages = buildResults(parsed.calls, results, messages, response);
  }

  // Excedimos maxTurns
  LOG.warn('max turns reached');
  return {
    ok: false,
    error: 'Se alcanzó el máximo de ' + maxTurns + ' turnos',
    code: 'MAX_TURNS',
    messages,
    toolCalls: allToolCalls,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   20 · SELF TEST
   ═══════════════════════════════════════════════════════════════════════════ */

async function selfTest() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  // Calculator
  try {
    const r = calculate('2 + 2');
    rec('calc 2+2 = 4', r.result === 4, r);
  } catch (e) { rec('calc 2+2 = 4', false, e.message); }

  try {
    const r = calculate('sqrt(16) + sin(pi/2)');
    rec('calc sqrt(16)+sin(pi/2) = 5', Math.abs(r.result - 5) < 1e-9, r);
  } catch (e) { rec('calc sqrt(16)+sin(pi/2) = 5', false, e.message); }

  try {
    const r = calculate('(3^4) % 7');
    rec('calc (3^4)%7 = 4', r.result === 4, r);
  } catch (e) { rec('calc (3^4)%7 = 4', false, e.message); }

  try {
    calculate('1/0');
    rec('calc 1/0 tira error', false, 'no throw');
  } catch (e) { rec('calc 1/0 tira error', true, e.message); }

  try {
    calculate('evilEval("x")');
    rec('calc sin eval', false, 'no throw');
  } catch (e) { rec('calc sin eval', true, 'rechaza funciones desconocidas'); }

  // Registry
  rec('tools registradas', _tools.size > 15, _tools.size);
  rec('calculator existe', !!getTool('calculator'), true);
  rec('wikipedia existe', !!getTool('wikipedia'), true);

  // Execute local (no network)
  const t0 = now();
  const calcResult = await execute('calculator', { expression: '10 * 5' });
  rec('execute calculator', calcResult.ok && calcResult.result.result === 50, calcResult);

  const uuidResult = await execute('uuid', { count: 3 });
  rec('execute uuid', uuidResult.ok && uuidResult.result.uuids.length === 3, uuidResult);

  const b64 = await execute('base64', { action: 'encode', text: 'hola' });
  rec('execute base64', b64.ok && b64.result.result === 'aG9sYQ==', b64);

  // Cache
  const c1 = await execute('calculator', { expression: '1+1' });
  const c2 = await execute('calculator', { expression: '1+1' });
  rec('cache funciona', c1.ok && c2.ok && c2.cached === true, c2);

  // Validation
  const invalid = await execute('calculator', {});
  rec('args inválidos rechazados', !invalid.ok && invalid.code === 'INVALID_ARGS', invalid);

  // Rate limit
  const limited = await execute('uuid', { count: 1 });
  rec('rate limit configurado', getTool('uuid').rateLimit.perMinute > 0, true);

  // Provider formats
  const groqTools = forGroq();
  rec('forGroq produce array', Array.isArray(groqTools) && groqTools.length > 0, groqTools.length);

  const gemTools = forGemini();
  rec('forGemini produce array', Array.isArray(gemTools) && gemTools[0].functionDeclarations.length > 0, true);

  // Parse
  const parsed = parseGroqResponse({ tool_calls: [{ type: 'function', id: 'x', function: { name: 'calculator', arguments: '{"expression":"2+2"}' } }] });
  rec('parseGroqResponse funciona', parsed.length === 1 && parsed[0].args.expression === '2+2', parsed);

  const passed = results.filter(r => r.ok).length;
  return {
    passed,
    total: results.length,
    ok: passed === results.length,
    results,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   21 · CONFIGURE
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
  LOG.info('config updated', patch);
}

function reset() {
  _metrics.calls = 0;
  _metrics.successes = 0;
  _metrics.failures = 0;
  _metrics.cached = 0;
  _metrics.rateLimited = 0;
  _metrics.circuitOpen = 0;
  _metrics.timeouts = 0;
  _metrics.byTool.clear();
  _metrics.since = now();
  _cache.clear();
  _rateLimiter.clear();
  _circuitState.clear();
  LOG.info('metrics + cache + rate limits reset');
}

/* ═══════════════════════════════════════════════════════════════════════════
   22 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export const TOOLS = {
  // Registry
  register,
  unregister,
  get: getTool,
  list: listTools,
  clear: clearTools,
  size: () => _tools.size,

  // Ejecución
  execute,
  executeMany,
  runLoop,

  // Provider adapters
  forGroq,
  forGemini,
  parseGroqResponse,
  parseGeminiResponse,
  buildGroqToolMessages,
  buildGeminiToolParts,

  // Utils expuestos
  calculate,

  // Config
  configure,
  reset,

  // Observabilidad
  metrics: getMetrics,
  circuitState,

  // Debug
  test: selfTest,

  // Internals para tests
  _config: CFG,
  _cache,
  _rateLimiter,
  _metrics,
};

export default TOOLS;