/* ================================================================
   NUMINATION · rate-limit-per-user.js · v1.0
   ----------------------------------------------------------------
   Rate limiting por usuario y por endpoint, complementario a:

     · limits.js          → cuotas de negocio (plan free/pro/etc.)
     · index.js (IP)      → protección bruta contra scraping

   ¿POR QUÉ UN ARCHIVO NUEVO?
   El rate limit de IP es global: 240 req/min por IP. Pero:

     · Un usuario legítimo detrás de NAT (colegio, oficina) puede
       compartir IP con 30 personas y comerse el límite ajeno.
     · Un atacante puede rotar IPs y evadir el límite de IP pero
       no el de cuenta.
     · Distintos endpoints tienen costos distintos: un GET de
       /api/health es gratis, un POST /api/chat/stream cuesta.
     · Algunos planes merecen más libertad que otros.

   Solución: un segundo limiter por userId + endpoint + plan.

   DIFERENCIAS CLAVE vs IP-limiter:

     · Key:     userId (no IP)
     · Ventana: 4 granularidades (seg, min, hora, día)
     · Costo:   cada endpoint puede pesar más o menos
     · Planes:  free/basic/pro/premium tienen límites distintos
     · Strikes: usuarios que abusan se enfrían exponencialmente
     · Refund:  si la operación falla, se reembolsa el costo
     · Headers: X-RateLimit-* en cada respuesta

   ESTRUCTURA:
     1  · Configuración por plan
     2  · Configuración por endpoint
     3  · Costos (pesos por operación)
     4  · Cooldown exponencial por strikes
     5  · Cliente Upstash
     6  · Lua script atómico
     7  · Key builders
     8  · Resolución de política (endpoint + plan → límites)
     9  · Consume / Check / Refund / Reset
    10  · Middleware Express
    11  · Helpers de admin
    12  · Métricas en memoria
    13  · Self-test
    14  · Exports

   USO EN UN ROUTER:

     import { rateLimitUser } from './middleware/rate-limit-per-user.js';

     app.post('/api/chat/stream',
       requireAuth,
       rateLimitUser(),
       asyncHandler(async (req, res) => { ... })
     );

   USO GLOBAL EN index.js:

     app.use(rateLimitUser({ global: true }));   // después de attachUser
     // ... rutas ...
     app.use(rateLimitUser.errorHandler());      // antes del 404

   USO PROGRAMÁTICO:

     const r = await checkUserRateLimit(req, { policy: 'chat' });
     if (!r.allowed) throw new RateLimitError(...);

   ================================================================ */

import crypto from 'node:crypto';
import { CODES, RateLimitError } from './errors.js';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN POR PLAN
   ═══════════════════════════════════════════════════════════════════════
   Cada plan define límites base para CUALQUIER endpoint.
   Los endpoints pueden override estos números.

   Formato:
     sec   · máximo de requests por segundo
     min   · máximo de requests por minuto
     hour  · máximo de requests por hora
     day   · máximo de requests por día
     burst · máximo de requests en ventana de 5 segundos
   ═══════════════════════════════════════════════════════════════════════ */

export const PLAN_RATE_LIMITS = Object.freeze({
  free: {
    sec:   2,
    min:   30,
    hour:  300,
    day:   2000,
    burst: 5,
  },
  basic: {
    sec:   5,
    min:   60,
    hour:  1000,
    day:   10000,
    burst: 10,
  },
  pro: {
    sec:   10,
    min:   120,
    hour:  3000,
    day:   50000,
    burst: 20,
  },
  premium: {
    sec:   20,
    min:   300,
    hour:  10000,
    day:   200000,
    burst: 50,
  },
  admin: {
    sec:   1000,
    min:   10000,
    hour:  100000,
    day:   1000000,
    burst: 1000,
  },
});

const DEFAULT_PLAN = 'free';

/* ═══════════════════════════════════════════════════════════════════════
   2 · CONFIGURACIÓN POR ENDPOINT
   ═══════════════════════════════════════════════════════════════════════
   Cada entrada define:
     · match       → cómo reconocer el endpoint (method + path pattern)
     · weight      → costo de la operación (default 1)
     · overrides   → límites específicos que pisan los del plan
     · skip        → si true, no cuenta contra el limiter
     · name        → identificador para logs y métricas

   Los patrones son strings con ':' como wildcard.
   Ej: 'GET /api/chats/:id' matchea 'GET /api/chats/abc123'.
   ═══════════════════════════════════════════════════════════════════════ */

export const ENDPOINT_POLICIES = Object.freeze({
  /* ─── Chat e IA (lo más costoso) ─── */
  chatStream: {
    name: 'chat_stream',
    match: 'POST /api/chat/stream',
    weight: 1,
    overrides: {
      free:    { sec: 1, min: 5,  hour: 30,  day: 50,    burst: 2 },
      basic:   { sec: 2, min: 20, hour: 100, day: 100,   burst: 5 },
      pro:     { sec: 5, min: 60, hour: 300, day: 500,   burst: 10 },
      premium: { sec: 10, min: 120, hour: 600, day: 2000, burst: 20 },
    },
  },
  chatPlain: {
    name: 'chat_plain',
    match: 'POST /api/chat',
    weight: 1,
    overrides: {
      free:    { sec: 1, min: 5,  hour: 30,  day: 50,    burst: 2 },
    },
  },

  /* ─── Chats CRUD ─── */
  chatsCreate: {
    name: 'chats_create',
    match: 'POST /api/chats',
    weight: 0.5,
    overrides: {
      free: { min: 10, hour: 60, day: 100 },
    },
  },
  chatsRead: {
    name: 'chats_read',
    match: 'GET /api/chats',
    weight: 0.2,
  },
  chatsGet: {
    name: 'chats_get',
    match: 'GET /api/chats/:id',
    weight: 0.2,
  },
  chatsDelete: {
    name: 'chats_delete',
    match: 'DELETE /api/chats/:id',
    weight: 0.5,
    overrides: {
      free: { min: 10, hour: 60 },
    },
  },
  chatsMessage: {
    name: 'chats_message',
    match: 'POST /api/chats/:id/messages',
    weight: 0.3,
  },

  /* ─── Memorias ─── */
  memoryCreate: {
    name: 'memory_create',
    match: 'POST /api/memories',
    weight: 0.5,
    overrides: {
      free: { min: 10, hour: 100, day: 300 },
    },
  },
  memoryRead: {
    name: 'memory_read',
    match: 'GET /api/memories',
    weight: 0.2,
  },
  memoryUpdate: {
    name: 'memory_update',
    match: 'PATCH /api/memories/:id',
    weight: 0.3,
  },
  memoryDelete: {
    name: 'memory_delete',
    match: 'DELETE /api/memories/:id',
    weight: 0.3,
  },

  /* ─── Auth (muy protegido, contra fuerza bruta) ─── */
  authLogin: {
    name: 'auth_login',
    match: 'POST /api/auth/login',
    weight: 1,
    overrides: {
      // Todos los planes: 5 intentos por minuto
      free:    { min: 5, hour: 20 },
      basic:   { min: 5, hour: 20 },
      pro:     { min: 5, hour: 20 },
      premium: { min: 5, hour: 20 },
    },
  },
  authSignup: {
    name: 'auth_signup',
    match: 'POST /api/auth/signup',
    weight: 1,
    overrides: {
      free:    { min: 3, hour: 5, day: 10 },
      basic:   { min: 3, hour: 5, day: 10 },
      pro:     { min: 3, hour: 5, day: 10 },
      premium: { min: 3, hour: 5, day: 10 },
    },
  },
  authForgot: {
    name: 'auth_forgot',
    match: 'POST /api/auth/forgot-password',
    weight: 1,
    overrides: {
      free:    { min: 3, hour: 5, day: 10 },
      basic:   { min: 3, hour: 5, day: 10 },
      pro:     { min: 3, hour: 5, day: 10 },
      premium: { min: 3, hour: 5, day: 10 },
    },
  },
  authReset: {
    name: 'auth_reset',
    match: 'POST /api/auth/reset-password',
    weight: 1,
    overrides: {
      free:    { min: 5, hour: 10 },
      basic:   { min: 5, hour: 10 },
      pro:     { min: 5, hour: 10 },
      premium: { min: 5, hour: 10 },
    },
  },
  authGoogle: {
    name: 'auth_google',
    match: 'POST /api/auth/google',
    weight: 1,
    overrides: {
      free: { min: 10, hour: 50 },
    },
  },

  /* ─── Otros (light) ─── */
  health: {
    name: 'health',
    match: 'GET /api/health',
    skip: true,
  },
  version: {
    name: 'version',
    match: 'GET /api/version',
    skip: true,
  },
  ping: {
    name: 'ping',
    match: 'GET /api/ping',
    skip: true,
  },
  me: {
    name: 'me',
    match: 'GET /api/auth/me',
    weight: 0.1,
    overrides: {
      free: { min: 60, hour: 300 },
    },
  },
  session: {
    name: 'session',
    match: 'GET /api/auth/session',
    weight: 0.1,
    overrides: {
      free: { min: 60, hour: 300 },
    },
  },
  limitsUsage: {
    name: 'limits_usage',
    match: 'GET /api/limits/usage',
    weight: 0.1,
    overrides: {
      free: { min: 60, hour: 300 },
    },
  },
  skills: {
    name: 'skills',
    match: 'GET /api/skills',
    weight: 0.2,
  },
  connectors: {
    name: 'connectors',
    match: 'GET /api/connectors',
    weight: 0.2,
  },
  connectorsQuery: {
    name: 'connectors_query',
    match: 'POST /api/connectors/:id/query',
    weight: 1,
    overrides: {
      free: { min: 5, hour: 30, day: 100 },
    },
  },

  /* ─── Fallback genérico para cualquier otro endpoint ─── */
  fallback: {
    name: 'default',
    match: '*',
    weight: 0.3,
  },
});

/* ═══════════════════════════════════════════════════════════════════════
   3 · COSTOS · representados como enteros × 100
   ═══════════════════════════════════════════════════════════════════════
   Redis trabaja mejor con enteros. 0.5 se convierte en 50.
   Esto permite granularidad sin flotantes.
   ═══════════════════════════════════════════════════════════════════════ */

const COST_MULTIPLIER = 100;

function toCost(weight) {
  if (typeof weight !== 'number' || !isFinite(weight) || weight < 0) return COST_MULTIPLIER;
  return Math.max(1, Math.round(weight * COST_MULTIPLIER));
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · COOLDOWN EXPONENCIAL POR STRIKES
   ═══════════════════════════════════════════════════════════════════════
   Si un usuario golpea el límite repetidamente, cada strike agrega
   una penalización adicional. Strike 1 y 2 son gratis. Del 3 en
   adelante, el cooldown crece: 3s, 9s, 27s, 81s... tope en 30 min.
   ═══════════════════════════════════════════════════════════════════════ */

const STRIKE_TTL_SECONDS = 3600;      // 1 hora de memoria de strikes
const STRIKE_FREE_PASS = 2;           // primeros 2 strikes son gratis
const STRIKE_COOLDOWN_BASE = 3;       // 3 segundos
const STRIKE_COOLDOWN_MAX = 1800;     // 30 minutos tope

function strikeCooldownSeconds(strikes) {
  if (strikes <= STRIKE_FREE_PASS) return 0;
  const n = strikes - STRIKE_FREE_PASS;
  const sec = STRIKE_COOLDOWN_BASE * Math.pow(3, n - 1);
  return Math.min(STRIKE_COOLDOWN_MAX, sec);
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · CLIENTE UPSTASH
   ═══════════════════════════════════════════════════════════════════════ */

function getUpstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

/**
 * Ejecuta un EVAL contra Upstash.
 */
async function evalScript(script, keys, args) {
  const u = getUpstash();
  if (!u) return { ok: false, error: 'no_upstash' };

  const body = JSON.stringify([
    'EVAL',
    script,
    String(keys.length),
    ...keys,
    ...args.map((a) => String(a)),
  ]);

  try {
    const res = await fetch(u.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, error: `upstash_${res.status}`, detail: txt.slice(0, 120) };
    }
    const json = await res.json();
    if (json.error) return { ok: false, error: json.error };
    return { ok: true, result: json.result };
  } catch (e) {
    return { ok: false, error: e?.message || 'fetch_failed' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · LUA SCRIPT · cuenta atómicamente en 5 ventanas + verifica strike
   ═══════════════════════════════════════════════════════════════════════
   KEYS[1] = window:sec
   KEYS[2] = window:min
   KEYS[3] = window:hour
   KEYS[4] = window:day
   KEYS[5] = window:burst
   KEYS[6] = strikes counter

   ARGV[1] = cost (integer, ej 100 para peso 1)
   ARGV[2] = limit sec
   ARGV[3] = limit min
   ARGV[4] = limit hour
   ARGV[5] = limit day
   ARGV[6] = limit burst
   ARGV[7] = ttl sec (segundos)
   ARGV[8] = ttl min
   ARGV[9] = ttl hour
   ARGV[10] = ttl day
   ARGV[11] = ttl burst
   ARGV[12] = strike TTL
   ARGV[13] = free pass (cuántos strikes no cuentan)

   Devuelve:
     { exceeded (0/1),
       sec, min, hour, day, burst,
       limitSec, limitMin, limitHour, limitDay, limitBurst,
       retryAfterSec,
       strikes,
       reason }
   ═══════════════════════════════════════════════════════════════════════ */

const EVAL_CONSUME = `
  local cost = tonumber(ARGV[1])
  local limitSec = tonumber(ARGV[2])
  local limitMin = tonumber(ARGV[3])
  local limitHour = tonumber(ARGV[4])
  local limitDay = tonumber(ARGV[5])
  local limitBurst = tonumber(ARGV[6])

  local ttlSec = tonumber(ARGV[7])
  local ttlMin = tonumber(ARGV[8])
  local ttlHour = tonumber(ARGV[9])
  local ttlDay = tonumber(ARGV[10])
  local ttlBurst = tonumber(ARGV[11])
  local strikeTTL = tonumber(ARGV[12])

  -- Contar incrementando atómicamente
  local cSec   = redis.call('INCRBY', KEYS[1], cost)
  if cSec == cost then redis.call('EXPIRE', KEYS[1], ttlSec) end

  local cMin   = redis.call('INCRBY', KEYS[2], cost)
  if cMin == cost then redis.call('EXPIRE', KEYS[2], ttlMin) end

  local cHour  = redis.call('INCRBY', KEYS[3], cost)
  if cHour == cost then redis.call('EXPIRE', KEYS[3], ttlHour) end

  local cDay   = redis.call('INCRBY', KEYS[4], cost)
  if cDay == cost then redis.call('EXPIRE', KEYS[4], ttlDay) end

  local cBurst = redis.call('INCRBY', KEYS[5], cost)
  if cBurst == cost then redis.call('EXPIRE', KEYS[5], ttlBurst) end

  -- Verificar excedidos
  local exceeded = 0
  local retryAfter = 0
  local reason = ''

  if cBurst > limitBurst then
    exceeded = 1
    reason = 'burst'
    retryAfter = redis.call('TTL', KEYS[5])
  elseif cSec > limitSec then
    exceeded = 1
    reason = 'second'
    retryAfter = redis.call('TTL', KEYS[1])
  elseif cMin > limitMin then
    exceeded = 1
    reason = 'minute'
    retryAfter = redis.call('TTL', KEYS[2])
  elseif cHour > limitHour then
    exceeded = 1
    reason = 'hour'
    retryAfter = redis.call('TTL', KEYS[3])
  elseif cDay > limitDay then
    exceeded = 1
    reason = 'day'
    retryAfter = redis.call('TTL', KEYS[4])
  end

  -- Gestionar strikes
  local strikes = tonumber(redis.call('GET', KEYS[6]) or '0')
  if exceeded == 1 then
    strikes = redis.call('INCR', KEYS[6])
    if strikes == 1 then
      redis.call('EXPIRE', KEYS[6], strikeTTL)
    end
  else
    -- Reset suave: bajar 1 strike por request exitoso
    if strikes > 0 then
      strikes = redis.call('DECR', KEYS[6])
      if strikes < 0 then
        strikes = 0
        redis.call('SET', KEYS[6], '0')
      end
    end
  end

  return {
    exceeded,
    cSec, cMin, cHour, cDay, cBurst,
    limitSec, limitMin, limitHour, limitDay, limitBurst,
    retryAfter,
    strikes,
    reason
  }
`;

const EVAL_REFUND = `
  local cost = tonumber(ARGV[1])

  -- Bajar de cada ventana sin ir a negativo
  local function dec(key)
    local v = tonumber(redis.call('GET', key) or '0')
    if v <= 0 then return 0 end
    local n = v - cost
    if n < 0 then n = 0 end
    redis.call('SET', key, tostring(n))
    return n
  end

  return {
    dec(KEYS[1]), dec(KEYS[2]), dec(KEYS[3]), dec(KEYS[4]), dec(KEYS[5])
  }
`;

const EVAL_READ = `
  local function c(k)
    local v = redis.call('GET', k)
    if not v then return 0 end
    return tonumber(v) or 0
  end
  return {
    c(KEYS[1]), c(KEYS[2]), c(KEYS[3]), c(KEYS[4]), c(KEYS[5]),
    redis.call('TTL', KEYS[1]),
    redis.call('TTL', KEYS[2]),
    redis.call('TTL', KEYS[3]),
    redis.call('TTL', KEYS[4]),
    c(KEYS[6])
  }
`;

/* ═══════════════════════════════════════════════════════════════════════
   7 · KEY BUILDERS
   ═══════════════════════════════════════════════════════════════════════ */

function windowsFor() {
  const now = new Date();
  const sec   = Math.floor(now.getTime() / 1000);
  const min   = Math.floor(now.getTime() / 60_000);
  const hour  = Math.floor(now.getTime() / 3_600_000);
  const day   = now.toISOString().slice(0, 10);
  const burst = Math.floor(now.getTime() / 5_000);   // ventana de 5s
  return { sec, min, hour, day, burst };
}

function buildKeys(userId, endpointName) {
  const w = windowsFor();
  const prefix = `rl:u:${userId}:${endpointName}`;
  return [
    `${prefix}:s:${w.sec}`,
    `${prefix}:m:${w.min}`,
    `${prefix}:h:${w.hour}`,
    `${prefix}:d:${w.day}`,
    `${prefix}:b:${w.burst}`,
    `rl:u:${userId}:strikes`,
  ];
}

function buildTTLs() {
  return [
    2,        // sec   → 2s de TTL (por si hay jitter)
    120,      // min   → 2 min
    7200,     // hour  → 2 horas
    172800,   // day   → 2 días
    10,       // burst → 10s
  ];
}

/* ═══════════════════════════════════════════════════════════════════════
   8 · RESOLUCIÓN DE POLÍTICA
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Convierte un pattern como 'GET /api/chats/:id' en un regex.
 * Los ':' son wildcards que matchean cualquier segmento.
 */
function patternToRegex(pattern) {
  if (pattern === '*') return /.*/;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '/[^/]+');
  return new RegExp('^' + escaped + '$');
}

/* Cache de regex compiladas */
const REGEX_CACHE = new Map();
function getRegex(pattern) {
  if (!REGEX_CACHE.has(pattern)) {
    REGEX_CACHE.set(pattern, patternToRegex(pattern));
  }
  return REGEX_CACHE.get(pattern);
}

/**
 * Encuentra la política que corresponde a un request.
 * Prioriza match exacto, después wildcards, después fallback.
 */
export function resolveEndpoint(req) {
  const key = `${req.method} ${req.path}`;

  // Primero: intento de match exacto
  for (const [id, policy] of Object.entries(ENDPOINT_POLICIES)) {
    if (policy.match === key) {
      return { id, ...policy };
    }
  }

  // Segundo: wildcards
  for (const [id, policy] of Object.entries(ENDPOINT_POLICIES)) {
    if (policy.match.includes(':')) {
      const re = getRegex(policy.match);
      if (re.test(key)) {
        return { id, ...policy };
      }
    }
  }

  // Tercero: fallback
  return { id: 'fallback', ...ENDPOINT_POLICIES.fallback };
}

/**
 * Combina los límites del plan con los overrides del endpoint.
 * Prioridad: override del endpoint > plan > default.
 */
export function resolveLimits(plan, endpointPolicy) {
  const base = PLAN_RATE_LIMITS[plan] || PLAN_RATE_LIMITS[DEFAULT_PLAN];
  const override = endpointPolicy.overrides?.[plan] || {};

  return {
    sec:   override.sec   ?? base.sec,
    min:   override.min   ?? base.min,
    hour:  override.hour  ?? base.hour,
    day:   override.day   ?? base.day,
    burst: override.burst ?? base.burst,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   9 · CONSUME / CHECK / REFUND / RESET
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Consume 1 request del usuario. Devuelve el estado completo.
 *
 * @param {object} req
 * @param {object} [opts]
 * @param {string} [opts.policy]  · forzar política por nombre
 * @param {number} [opts.cost]    · override del costo
 * @returns {Promise<object>}
 */
export async function consumeUserRateLimit(req, opts = {}) {
  const user = req.user || {};
  const userId = user.id;

  // Sin user → no aplica (deja pasar)
  if (!userId) {
    return allowAllResult('no_user');
  }

  // Admin → skip total
  const plan = String(user.plan || DEFAULT_PLAN).toLowerCase();
  if (plan === 'admin') {
    return allowAllResult('admin');
  }

  // Resolver endpoint
  const endpoint = opts.policy
    ? { id: opts.policy, ...ENDPOINT_POLICIES[opts.policy] }
    : resolveEndpoint(req);

  if (!endpoint || endpoint.skip) {
    return allowAllResult('skipped');
  }

  const limits = resolveLimits(plan, endpoint);
  const cost = opts.cost !== undefined
    ? Math.max(1, Math.round(opts.cost * COST_MULTIPLIER))
    : toCost(endpoint.weight || 1);

  const keys = buildKeys(userId, endpoint.name);
  const ttls = buildTTLs();

  const upstash = getUpstash();
  if (!upstash) {
    return allowAllResult('no_upstash');
  }

  const args = [
    cost,
    limits.sec,
    limits.min,
    limits.hour,
    limits.day,
    limits.burst,
    ttls[0], ttls[1], ttls[2], ttls[3], ttls[4],
    STRIKE_TTL_SECONDS,
    STRIKE_FREE_PASS,
  ];

  const r = await evalScript(EVAL_CONSUME, keys, args);

  if (!r.ok) {
    return allowAllResult('upstash_error', r.error);
  }

  const [
    exceeded,
    cSec, cMin, cHour, cDay, cBurst,
    limitSec, limitMin, limitHour, limitDay, limitBurst,
    retryAfter,
    strikes,
    reason,
  ] = r.result;

  // Calcular cooldown extra por strikes
  const extraCooldown = strikeCooldownSeconds(strikes);
  const totalRetry = Math.max(retryAfter || 0, extraCooldown);

  const resetSec = Math.max(1, 1 - (Date.now() / 1000 % 1));
  const resetMin = Math.max(1, 60 - Math.floor((Date.now() / 1000) % 60));

  return {
    allowed: exceeded === 0,
    reason: exceeded === 0 ? null : reason,
    plan,
    endpoint: endpoint.name,
    cost: cost / COST_MULTIPLIER,
    usage: {
      second: cSec / COST_MULTIPLIER,
      minute: cMin / COST_MULTIPLIER,
      hour:   cHour / COST_MULTIPLIER,
      day:    cDay / COST_MULTIPLIER,
      burst:  cBurst / COST_MULTIPLIER,
    },
    limits: {
      second: limitSec,
      minute: limitMin,
      hour:   limitHour,
      day:    limitDay,
      burst:  limitBurst,
    },
    remaining: {
      second: Math.max(0, limitSec - cSec / COST_MULTIPLIER),
      minute: Math.max(0, limitMin - cMin / COST_MULTIPLIER),
      hour:   Math.max(0, limitHour - cHour / COST_MULTIPLIER),
      day:    Math.max(0, limitDay - cDay / COST_MULTIPLIER),
      burst:  Math.max(0, limitBurst - cBurst / COST_MULTIPLIER),
    },
    strikes,
    retryAfter: exceeded ? totalRetry : 0,
    headers: buildHeaders({
      limit: limitMin,
      remaining: Math.max(0, limitMin - cMin / COST_MULTIPLIER),
      reset: resetMin,
    }),
  };
}

/**
 * Solo consulta, sin consumir. Útil para mostrar en /api/limits/usage.
 */
export async function checkUserRateLimit(req, opts = {}) {
  const user = req.user || {};
  const userId = user.id;
  if (!userId) return allowAllResult('no_user');

  const plan = String(user.plan || DEFAULT_PLAN).toLowerCase();
  if (plan === 'admin') return allowAllResult('admin');

  const endpoint = opts.policy
    ? { id: opts.policy, ...ENDPOINT_POLICIES[opts.policy] }
    : resolveEndpoint(req);

  if (!endpoint || endpoint.skip) return allowAllResult('skipped');

  const limits = resolveLimits(plan, endpoint);
  const keys = buildKeys(userId, endpoint.name);

  const upstash = getUpstash();
  if (!upstash) return allowAllResult('no_upstash');

  const r = await evalScript(EVAL_READ, keys, []);
  if (!r.ok) return allowAllResult('upstash_error', r.error);

  const [cSec, cMin, cHour, cDay, cBurst, ttlSec, ttlMin, ttlHour, ttlDay, strikes] = r.result;

  return {
    allowed: true,
    plan,
    endpoint: endpoint.name,
    usage: {
      second: cSec / COST_MULTIPLIER,
      minute: cMin / COST_MULTIPLIER,
      hour:   cHour / COST_MULTIPLIER,
      day:    cDay / COST_MULTIPLIER,
      burst:  cBurst / COST_MULTIPLIER,
    },
    limits: {
      second: limits.sec,
      minute: limits.min,
      hour:   limits.hour,
      day:    limits.day,
      burst:  limits.burst,
    },
    remaining: {
      second: Math.max(0, limits.sec - cSec / COST_MULTIPLIER),
      minute: Math.max(0, limits.min - cMin / COST_MULTIPLIER),
      hour:   Math.max(0, limits.hour - cHour / COST_MULTIPLIER),
      day:    Math.max(0, limits.day - cDay / COST_MULTIPLIER),
      burst:  Math.max(0, limits.burst - cBurst / COST_MULTIPLIER),
    },
    strikes,
    headers: buildHeaders({
      limit: limits.min,
      remaining: Math.max(0, limits.min - cMin / COST_MULTIPLIER),
      reset: ttlMin || 60,
    }),
  };
}

/**
 * Reembolsa un costo previamente consumido. Ejemplo: si el motor de
 * IA falló después de consumir, devolvemos el costo al usuario.
 */
export async function refundUserRateLimit(req, opts = {}) {
  const user = req.user || {};
  const userId = user.id;
  if (!userId) return false;

  const endpoint = opts.policy
    ? { id: opts.policy, ...ENDPOINT_POLICIES[opts.policy] }
    : resolveEndpoint(req);

  if (!endpoint || endpoint.skip) return false;

  const cost = opts.cost !== undefined
    ? Math.max(1, Math.round(opts.cost * COST_MULTIPLIER))
    : toCost(endpoint.weight || 1);

  const keys = buildKeys(userId, endpoint.name);
  const r = await evalScript(EVAL_REFUND, keys, [cost]);
  return Boolean(r.ok);
}

/**
 * Borra TODOS los contadores del usuario. Solo para admin/tests.
 */
export async function resetUserRateLimit(userId) {
  if (!userId) return false;
  const u = getUpstash();
  if (!u) return false;

  // Borrar todas las keys que empiezan con rl:u:${userId}
  try {
    const res = await fetch(`${u.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['KEYS', `rl:u:${userId}:*`],
      ]),
    });
    if (!res.ok) return false;
    const data = await res.json();
    const keys = data[0]?.result || [];
    if (keys.length === 0) return true;

    const delOps = keys.map((k) => ['DEL', k]);
    const delRes = await fetch(`${u.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(delOps),
    });
    return delRes.ok;
  } catch {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · HELPERS
   ═══════════════════════════════════════════════════════════════════════ */

function allowAllResult(reason, detail) {
  return {
    allowed: true,
    reason: null,
    softFailure: reason,
    detail: detail || null,
    plan: null,
    endpoint: null,
    cost: 0,
    usage: { second: 0, minute: 0, hour: 0, day: 0, burst: 0 },
    limits: { second: 0, minute: 0, hour: 0, day: 0, burst: 0 },
    remaining: { second: 0, minute: 0, hour: 0, day: 0, burst: 0 },
    strikes: 0,
    retryAfter: 0,
    headers: {},
  };
}

function buildHeaders({ limit, remaining, reset }) {
  return {
    'X-RateLimit-Limit': String(Math.max(0, Math.floor(limit))),
    'X-RateLimit-Remaining': String(Math.max(0, Math.floor(remaining))),
    'X-RateLimit-Reset': String(Math.max(0, Math.floor(reset))),
  };
}

function applyHeaders(res, headers) {
  if (!res || !headers) return;
  for (const [k, v] of Object.entries(headers)) {
    try { res.setHeader(k, v); } catch {}
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   11 · MIDDLEWARE EXPRESS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Middleware factory.
 *
 * Opciones:
 *   · policy     · forzar política específica (ej 'chatStream')
 *   · cost       · override del costo (ej 2.5)
 *   · silent     · no loguear (default false)
 *   · skipPaths  · array de paths a ignorar (ej ['/api/health'])
 *
 * Uso:
 *   app.post('/api/chat/stream', requireAuth, rateLimitUser(), handler);
 *
 *   // O global:
 *   app.use(rateLimitUser({ global: true }));
 */
export function rateLimitUser(opts = {}) {
  const skipPaths = new Set(opts.skipPaths || ['/api/health', '/api/version', '/api/ping']);

  return async function rateLimitMiddleware(req, res, next) {
    try {
      // Skip si path ignorado
      if (skipPaths.has(req.path)) return next();

      // Skip si no hay user (endpoints públicos)
      if (!req.user?.id) return next();

      const result = await consumeUserRateLimit(req, {
        policy: opts.policy,
        cost: opts.cost,
      });

      // Aplicar headers siempre
      applyHeaders(res, result.headers);

      if (!result.allowed) {
        res.setHeader('Retry-After', String(result.retryAfter || 30));

        if (!opts.silent) {
          console.warn(`[rl:user] ${req.user.id.slice(0, 8)} excedió ${result.endpoint} · reason=${result.reason} · strikes=${result.strikes} · retry=${result.retryAfter}s`);
        }

        const messages = {
          burst:  'Demasiadas peticiones seguidas. Esperá unos segundos.',
          second: 'Vas muy rápido. Esperá un segundo.',
          minute: 'Llegaste al límite por minuto. Esperá un momento.',
          hour:   'Llegaste al límite por hora. Esperá un poco más.',
          day:    'Llegaste al límite diario. Volvé mañana.',
        };

        const err = new RateLimitError(
          messages[result.reason] || 'Demasiadas peticiones.',
          CODES.LIMIT_MINUTE,
          result.retryAfter,
          {
            endpoint: result.endpoint,
            reason: result.reason,
            strikes: result.strikes,
            usage: result.usage,
            limits: result.limits,
          },
        );
        return next(err);
      }

      // Guardar info en el request para que el handler pueda usar
      req.rateLimit = result;
      next();
    } catch (e) {
      // Nunca romper el request por un error del limiter
      if (!opts.silent) {
        console.warn('[rl:user] error en middleware:', e.message);
      }
      next();
    }
  };
}

/**
 * Adjunta el resultado al response para debug.
 * Útil en desarrollo.
 */
rateLimitUser.debug = function debugRateLimit() {
  return (req, res, next) => {
    if (req.rateLimit) {
      res.setHeader('X-RateLimit-Debug', JSON.stringify({
        endpoint: req.rateLimit.endpoint,
        plan: req.rateLimit.plan,
        usage: req.rateLimit.usage,
      }).slice(0, 300));
    }
    next();
  };
};

/* ═══════════════════════════════════════════════════════════════════════
   12 · HELPERS DE ADMIN
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Devuelve los límites efectivos para un plan + endpoint.
 * Útil para una página de documentación o para /api/admin/limits.
 */
export function getEffectiveLimits(plan = DEFAULT_PLAN, endpointId = null) {
  const endpoint = endpointId ? ENDPOINT_POLICIES[endpointId] : null;
  return resolveLimits(String(plan).toLowerCase(), endpoint || { overrides: {} });
}

/**
 * Lista todos los endpoints con sus límites.
 */
export function listAllPolicies() {
  return Object.entries(ENDPOINT_POLICIES).map(([id, p]) => ({
    id,
    name: p.name,
    match: p.match,
    weight: p.weight || 1,
    skip: Boolean(p.skip),
    overrides: p.overrides ? Object.keys(p.overrides) : [],
  }));
}

/**
 * Diagnóstico rápido del limiter.
 */
export async function pingRateLimit() {
  const u = getUpstash();
  if (!u) return { ok: false, reason: 'no_upstash' };

  try {
    const t0 = Date.now();
    const res = await fetch(u.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['PING']),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { ok: false, reason: `http_${res.status}` };
    const json = await res.json();
    return {
      ok: json.result === 'PONG',
      latencyMs: Date.now() - t0,
    };
  } catch (e) {
    return { ok: false, reason: e?.message || 'fetch_failed' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   13 · MÉTRICAS EN MEMORIA
   ═══════════════════════════════════════════════════════════════════════ */

const METRICS = {
  total: 0,
  allowed: 0,
  denied: 0,
  byReason: new Map(),
  byEndpoint: new Map(),
  byPlan: new Map(),
  topOffenders: new Map(),
  firstAt: null,
  lastAt: null,
};

function bump(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

export function trackRateLimit(result, userId) {
  METRICS.total++;
  const now = Date.now();
  if (!METRICS.firstAt) METRICS.firstAt = now;
  METRICS.lastAt = now;

  if (result.allowed) METRICS.allowed++;
  else {
    METRICS.denied++;
    if (result.reason) bump(METRICS.byReason, result.reason);
    if (userId) bump(METRICS.topOffenders, userId);
  }

  if (result.endpoint) bump(METRICS.byEndpoint, result.endpoint);
  if (result.plan) bump(METRICS.byPlan, result.plan);
}

export function getRateLimitMetrics(topN = 10) {
  const topOf = (map) => Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([key, count]) => ({ key, count }));

  return {
    total: METRICS.total,
    allowed: METRICS.allowed,
    denied: METRICS.denied,
    denyRate: METRICS.total > 0 ? (METRICS.denied / METRICS.total) : 0,
    firstAt: METRICS.firstAt ? new Date(METRICS.firstAt).toISOString() : null,
    lastAt: METRICS.lastAt ? new Date(METRICS.lastAt).toISOString() : null,
    topReasons: topOf(METRICS.byReason),
    topEndpoints: topOf(METRICS.byEndpoint),
    topPlans: topOf(METRICS.byPlan),
    topOffenders: topOf(METRICS.topOffenders),
  };
}

export function resetRateLimitMetrics() {
  METRICS.total = 0;
  METRICS.allowed = 0;
  METRICS.denied = 0;
  METRICS.byReason.clear();
  METRICS.byEndpoint.clear();
  METRICS.byPlan.clear();
  METRICS.topOffenders.clear();
  METRICS.firstAt = null;
  METRICS.lastAt = null;
}

/* ═══════════════════════════════════════════════════════════════════════
   14 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const errors = [];

  // 1 · Políticas resuelven correctamente
  const fakeReq = { method: 'POST', path: '/api/chat/stream' };
  const ep = resolveEndpoint(fakeReq);
  if (ep.name !== 'chat_stream') errors.push(`resolveEndpoint falló: ${ep.name}`);

  // 2 · Wildcards matchean
  const chatsGet = resolveEndpoint({ method: 'GET', path: '/api/chats/abc-123' });
  if (chatsGet.name !== 'chats_get') errors.push(`Wildcard falló: ${chatsGet.name}`);

  // 3 · Fallback funciona
  const unknown = resolveEndpoint({ method: 'GET', path: '/api/xyz-not-defined' });
  if (unknown.name !== 'default') errors.push(`Fallback falló: ${unknown.name}`);

  // 4 · Límites por plan
  const freeChat = resolveLimits('free', ENDPOINT_POLICIES.chatStream);
  if (freeChat.min !== 5) errors.push(`Override de plan falló: min=${freeChat.min}`);

  const freeOther = resolveLimits('free', { overrides: {} });
  if (freeOther.min !== 30) errors.push(`Plan base falló: min=${freeOther.min}`);

  // 5 · Costos correctos
  if (toCost(0.5) !== 50) errors.push(`toCost(0.5) = ${toCost(0.5)}`);
  if (toCost(1) !== 100) errors.push(`toCost(1) = ${toCost(1)}`);
  if (toCost(0) !== 1) errors.push(`toCost(0) debería ser 1, es ${toCost(0)}`);

  // 6 · Cooldown por strikes
  if (strikeCooldownSeconds(0) !== 0) errors.push('Strike 0 debería ser 0s');
  if (strikeCooldownSeconds(2) !== 0) errors.push('Strike 2 debería ser 0s');
  if (strikeCooldownSeconds(3) < 3) errors.push('Strike 3 debería ser ≥3s');
  if (strikeCooldownSeconds(100) > STRIKE_COOLDOWN_MAX) errors.push('Strike alto excede tope');

  // 7 · Todas las políticas tienen match
  for (const [id, p] of Object.entries(ENDPOINT_POLICIES)) {
    if (!p.match) errors.push(`Política ${id} sin match`);
    if (!p.name) errors.push(`Política ${id} sin name`);
  }

  return {
    ok: errors.length === 0,
    errors,
    policies: Object.keys(ENDPOINT_POLICIES).length,
    plans: Object.keys(PLAN_RATE_LIMITS),
    strikes: {
      freePass: STRIKE_FREE_PASS,
      base: STRIKE_COOLDOWN_BASE,
      max: STRIKE_COOLDOWN_MAX,
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   FIN
   ═══════════════════════════════════════════════════════════════════════ */