/* ================================================================
   NUMINATION · limits.js · v2.0
   ----------------------------------------------------------------
   Rate limiting por plan con Upstash Redis.

   GARANTÍAS:
     · Atómico: INCR + EXPIRE se ejecutan en un único EVAL.
       (En v1.0 el INCR y el EXPIRE eran 2 pasos con ventana de race:
       si el proceso moría entre ambos, la key quedaba sin TTL para
       siempre y el usuario quedaba bloqueado hasta que un humano
       la borrara manualmente. Ahora es imposible.)
     · Multi-ventana: día, minuto, ráfaga (10s), mes.
     · Refund: si el motor de IA falla después de contar, devolvemos
       el mensaje al usuario.
     · Headers HTTP estándar: X-RateLimit-Limit / Remaining / Reset.

   API PÚBLICA:

     verificarLimite(req, opts)   → { permitido, plan, uso, limites, ... }
     consultarUso(req)            → snapshot sin consumir
     registrarUso(req)            → compat con v1 (no-op, ya se cuenta en verificar)
     reembolsarUso(req)           → refund de 1 mensaje
     resetUsage(req)              → borra contadores del usuario
     getUsageStats(req)           → stats ricos (porcentajes, próximo reset)
     buildRateLimitHeaders(res, info) → agrega headers HTTP

   ENV REQUERIDAS (Vercel):
     UPSTASH_REDIS_REST_URL
     UPSTASH_REDIS_REST_TOKEN

   ENV OPCIONALES:
     LIMITS_FAIL_MODE = 'open' | 'closed'   (default: 'open')
                       'open'   = si Upstash no está, permitir todo
                       'closed' = si Upstash no está, bloquear todo
     LIMITS_ANON_PER_MIN = número (default: 1)
     LIMITS_ANON_DAILY_BUDGET = número (default: 500 · techo diario global anon)
   ================================================================ */

export const PLAN_LIMITS = Object.freeze({
  free:    { messagesPerDay: 20,   messagesPerMinute: 5,  messagesPerBurst: 3,  name: 'Free'    },
  basic:   { messagesPerDay: 100,  messagesPerMinute: 15, messagesPerBurst: 5,  name: 'Basic'   },
  pro:     { messagesPerDay: 500,  messagesPerMinute: 30, messagesPerBurst: 10, name: 'Pro'     },
  premium: { messagesPerDay: 2000, messagesPerMinute: 60, messagesPerBurst: 15, name: 'Premium' },
});

const DEFAULT_PLAN = 'free';
const SECOND = 1;
const BURST_SECONDS = 10;
const MINUTE_SECONDS = 60;
const DAY_SECONDS = 86_400;
const MONTH_SECONDS = 30 * DAY_SECONDS;

const FAIL_MODE = (process.env.LIMITS_FAIL_MODE || 'open').toLowerCase();
// M-006 · anónimos más estrictos: 1/min por defecto (antes 3).
const ANON_PER_MIN = Math.max(1, parseInt(process.env.LIMITS_ANON_PER_MIN || '1', 10));
// M-006 · presupuesto diario GLOBAL para anónimos (todas las IPs).
// Frena el drenaje de cuota de IA por rotación de IPs. En memoria por
// instancia: en Vercel multi-instancia el techo real se multiplica por
// N instancias (documentado; con Upstash se podría centralizar).
const ANON_DAILY_BUDGET = Math.max(1, parseInt(process.env.LIMITS_ANON_DAILY_BUDGET || '500', 10));
const anonDayCount = { day: null, count: 0 };

function checkAnonBudget() {
  const day = new Date().toISOString().slice(0, 10);
  if (anonDayCount.day !== day) {
    anonDayCount.day = day;
    anonDayCount.count = 0;
  }
  if (anonDayCount.count >= ANON_DAILY_BUDGET) {
    const midnight = new Date();
    midnight.setUTCHours(24, 0, 0, 0);
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((midnight.getTime() - Date.now()) / 1000)),
    };
  }
  anonDayCount.count++;
  return { ok: true };
}

/* ───────────────────────────────────────────────────────────────────
   LUA · cuenta todo y aplica TTL en una sola operación atómica
   ───────────────────────────────────────────────────────────────────
   KEYS[1] = burstKey
   KEYS[2] = minKey
   KEYS[3] = dayKey
   KEYS[4] = monthKey
   ARGV[1] = burstSeconds
   ARGV[2] = minSeconds
   ARGV[3] = daySeconds
   ARGV[4] = monthSeconds

   Devuelve { burst, min, day, month }
   ─────────────────────────────────────────────────────────────────── */
const EVAL_INCR = `
  local burst = redis.call('INCR', KEYS[1])
  if burst == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end

  local min = redis.call('INCR', KEYS[2])
  if min == 1 then redis.call('EXPIRE', KEYS[2], ARGV[2]) end

  local day = redis.call('INCR', KEYS[3])
  if day == 1 then redis.call('EXPIRE', KEYS[3], ARGV[3]) end

  local month = redis.call('INCR', KEYS[4])
  if month == 1 then redis.call('EXPIRE', KEYS[4], ARGV[4]) end

  return { burst, min, day, month }
`;

/* ───────────────────────────────────────────────────────────────────
   LUA · lee los 4 contadores sin tocar nada
   ─────────────────────────────────────────────────────────────────── */
const EVAL_READ = `
  local function c(k)
    local v = redis.call('GET', k)
    if not v then return 0 end
    return tonumber(v) or 0
  end
  return {
    c(KEYS[1]), c(KEYS[2]), c(KEYS[3]), c(KEYS[4]),
    redis.call('TTL', KEYS[2]),
    redis.call('TTL', KEYS[3])
  }
`;

/* ───────────────────────────────────────────────────────────────────
   LUA · refund: resta 1 a los contadores de burst/min/día/mes
   ─────────────────────────────────────────────────────────────────── */
const EVAL_REFUND = `
  local function dec(k)
    local v = redis.call('GET', k)
    if not v then return 0 end
    local n = tonumber(v) or 0
    if n <= 0 then return 0 end
    return redis.call('DECR', k)
  end
  return { dec(KEYS[1]), dec(KEYS[2]), dec(KEYS[3]), dec(KEYS[4]) }
`;

/* ═══════════════════════════════════════════════════════════════════
   1 · CLIENTE UPSTASH
   ═══════════════════════════════════════════════════════════════════ */

function getUpstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

/**
 * Ejecuta un EVAL contra Upstash.
 * Devuelve { ok: true, result } o { ok: false, error }.
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
    const res = await fetch(`${u.url}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json',
      },
      body,
      // Timeout defensivo: si Upstash tarda más de 3s, no bloqueamos al usuario
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

/* ═══════════════════════════════════════════════════════════════════
   2 · KEY BUILDERS · con timezone UTC explícita
   ═══════════════════════════════════════════════════════════════════ */

function buildKeys(req) {
  const userId = req.user?.id || `ip:${req.ip || 'anon'}`;
  const now = new Date();

  // UTC para que el reset diario sea consistente globalmente
  const day = now.toISOString().slice(0, 10);         // YYYY-MM-DD
  const month = day.slice(0, 7);                       // YYYY-MM
  const minute = now.toISOString().slice(0, 16);       // YYYY-MM-DDTHH:MM
  const burst = Math.floor(now.getTime() / (BURST_SECONDS * 1000)); // bloque 10s

  return {
    userId,
    keys: [
      `ratelimit:${userId}:burst:${burst}`,
      `ratelimit:${userId}:min:${minute}`,
      `ratelimit:${userId}:day:${day}`,
      `ratelimit:${userId}:month:${month}`,
    ],
    now,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   3 · RESPUESTAS ESTÁNDAR
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Snapshot "todo permitido" para cuando no hay Upstash y estamos en fail-open.
 */
function allowAll(limits, reason = 'no_upstash') {
  return {
    permitido: true,
    plan: limits.name,
    restanteDia: limits.messagesPerDay,
    restanteMin: limits.messagesPerMinute,
    limites: {
      porDia: limits.messagesPerDay,
      porMin: limits.messagesPerMinute,
      porMinuto: limits.messagesPerMinute,
      porBurst: limits.messagesPerBurst,
    },
    uso: {
      hoy: 0,
      dia: 0,
      minuto: 0,
      burst: 0,
      mes: 0,
    },
    razon: null,
    mensaje: null,
    retryAfter: null,
    headers: buildHeaders({
      limit: limits.messagesPerMinute,
      remaining: limits.messagesPerMinute,
      resetSeconds: MINUTE_SECONDS,
    }),
    softFailure: reason,   // ← el caller puede loguear esto si quiere
  };
}

/**
 * Snapshot "todo bloqueado" para fail-closed en producción.
 */
function denyAll(limits, reason = 'upstash_unavailable') {
  return {
    permitido: false,
    plan: limits.name,
    restanteDia: 0,
    restanteMin: 0,
    limites: {
      porDia: limits.messagesPerDay,
      porMin: limits.messagesPerMinute,
      porMinuto: limits.messagesPerMinute,
      porBurst: limits.messagesPerBurst,
    },
    uso: { hoy: 0, dia: 0, minuto: 0, burst: 0, mes: 0 },
    razon: reason,
    mensaje: 'Servicio temporalmente saturado. Intenta de nuevo en unos segundos.',
    retryAfter: 30,
    headers: buildHeaders({ limit: 0, remaining: 0, resetSeconds: 30 }),
  };
}

function buildHeaders({ limit, remaining, resetSeconds }) {
  return {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(Math.max(0, remaining)),
    'X-RateLimit-Reset': String(Math.max(0, Math.floor(resetSeconds))),
  };
}

/**
 * Aplica los headers estándar al response Express.
 * No-op si no hay headers en el objeto.
 */
export function buildRateLimitHeaders(res, info) {
  if (!res || !info?.headers) return;
  for (const [k, v] of Object.entries(info.headers)) {
    try { res.setHeader(k, v); } catch {}
  }
}

/* ═══════════════════════════════════════════════════════════════════
   4 · VERIFICAR · la función principal
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Verifica si el usuario puede enviar un mensaje. Consume 1 turno.
 *
 * @param {object} req       Express request
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]  si true, NO consume, solo lee
 * @returns {Promise<object>}  snapshot del límite
 */
export async function verificarLimite(req, opts = {}) {
  const isAnon = !req.user?.id;
  const plan = req.user?.plan || DEFAULT_PLAN;
  const baseLimits = PLAN_LIMITS[plan] || PLAN_LIMITS[DEFAULT_PLAN];

  // Anónimos tienen límites más estrictos (protección contra scraping)
  const limits = isAnon
    ? { ...baseLimits, messagesPerMinute: Math.min(baseLimits.messagesPerMinute, ANON_PER_MIN) }
    : baseLimits;

  // M-006 · techo diario global para anónimos (anti-drenaje de cuota).
  // Solo en modo consume: el dry-run (lecturas) no gasta presupuesto.
  if (isAnon && !opts.dryRun) {
    const budget = checkAnonBudget();
    if (!budget.ok) {
      return {
        permitido: false,
        plan: limits.name,
        restanteDia: 0,
        restanteMin: 0,
        limites: {
          porDia: limits.messagesPerDay,
          porMin: limits.messagesPerMinute,
          porMinuto: limits.messagesPerMinute,
          porBurst: limits.messagesPerBurst,
        },
        uso: { hoy: 0, dia: 0, minuto: 0, burst: 0, mes: 0 },
        razon: 'anon_budget',
        mensaje: 'Cupo diario de pruebas agotado. Creá una cuenta gratis para seguir.',
        retryAfter: budget.retryAfter,
        headers: buildHeaders({ limit: 0, remaining: 0, resetSeconds: budget.retryAfter }),
      };
    }
  }

  const { keys } = buildKeys(req);
  const upstash = getUpstash();

  if (!upstash) {
    return FAIL_MODE === 'closed'
      ? denyAll(limits, 'upstash_missing')
      : allowAll(limits, 'upstash_missing');
  }

  /* ─── Modo dry-run: solo lee ─── */
  if (opts.dryRun) {
    const r = await evalScript(EVAL_READ, keys, []);
    if (!r.ok) return allowAll(limits, r.error);
    const [burst, min, day, month, ttlMin, ttlDay] = r.result;
    return buildSnapshot({ limits, burst, min, day, month, ttlMin, ttlDay, isAnon });
  }

  /* ─── Modo normal: consume atómicamente ─── */
  const r = await evalScript(EVAL_INCR, keys, [
    BURST_SECONDS, MINUTE_SECONDS, DAY_SECONDS, MONTH_SECONDS,
  ]);

  if (!r.ok) {
    return FAIL_MODE === 'closed'
      ? denyAll(limits, r.error)
      : allowAll(limits, r.error);
  }

  const [burst, min, day, month] = r.result;
  return buildSnapshot({ limits, burst, min, day, month, ttlMin: 60, ttlDay: DAY_SECONDS, isAnon });
}

/**
 * Construye el snapshot y decide si está permitido.
 */
function buildSnapshot({ limits, burst, min, day, month, ttlMin, ttlDay, isAnon }) {
  const restanteDia = Math.max(0, limits.messagesPerDay - day);
  const restanteMin = Math.max(0, limits.messagesPerMinute - min);

  // Orden de chequeo: burst → minuto → día
  if (burst > limits.messagesPerBurst) {
    return {
      permitido: false,
      plan: limits.name,
      restanteDia,
      restanteMin,
      limites: {
        porDia: limits.messagesPerDay,
        porMin: limits.messagesPerMinute,
        porMinuto: limits.messagesPerMinute,
        porBurst: limits.messagesPerBurst,
      },
      uso: { hoy: day, dia: day, minuto: min, burst, mes: month },
      razon: 'burst_limit',
      mensaje: 'Demasiados mensajes seguidos. Espera unos segundos.',
      retryAfter: BURST_SECONDS,
      headers: buildHeaders({
        limit: limits.messagesPerBurst,
        remaining: 0,
        resetSeconds: BURST_SECONDS,
      }),
    };
  }

  if (min > limits.messagesPerMinute) {
    return {
      permitido: false,
      plan: limits.name,
      restanteDia,
      restanteMin: 0,
      limites: {
        porDia: limits.messagesPerDay,
        porMin: limits.messagesPerMinute,
        porMinuto: limits.messagesPerMinute,
        porBurst: limits.messagesPerBurst,
      },
      uso: { hoy: day, dia: day, minuto: min, burst, mes: month },
      razon: 'minute_limit',
      mensaje: 'Demasiados mensajes en poco tiempo. Espera unos segundos.',
      retryAfter: ttlMin || MINUTE_SECONDS,
      headers: buildHeaders({
        limit: limits.messagesPerMinute,
        remaining: 0,
        resetSeconds: ttlMin || MINUTE_SECONDS,
      }),
    };
  }

  if (day > limits.messagesPerDay) {
    return {
      permitido: false,
      plan: limits.name,
      restanteDia: 0,
      restanteMin,
      limites: {
        porDia: limits.messagesPerDay,
        porMin: limits.messagesPerMinute,
        porMinuto: limits.messagesPerMinute,
        porBurst: limits.messagesPerBurst,
      },
      uso: { hoy: day, dia: day, minuto: min, burst, mes: month },
      razon: 'daily_limit',
      mensaje: `Límite diario alcanzado (${limits.messagesPerDay} mensajes). Mejora tu plan o espera a mañana.`,
      retryAfter: ttlDay || DAY_SECONDS,
      headers: buildHeaders({
        limit: limits.messagesPerDay,
        remaining: 0,
        resetSeconds: ttlDay || DAY_SECONDS,
      }),
    };
  }

  return {
    permitido: true,
    plan: limits.name,
    restanteDia,
    restanteMin,
    limites: {
      porDia: limits.messagesPerDay,
      porMin: limits.messagesPerMinute,
      porMinuto: limits.messagesPerMinute,
      porBurst: limits.messagesPerBurst,
    },
    uso: { hoy: day, dia: day, minuto: min, burst, mes: month },
    razon: null,
    mensaje: null,
    retryAfter: null,
    headers: buildHeaders({
      limit: limits.messagesPerMinute,
      remaining: restanteMin,
      resetSeconds: ttlMin || MINUTE_SECONDS,
    }),
  };
}

/* ═══════════════════════════════════════════════════════════════════
   5 · CONSULTAR · sin consumir
   ═══════════════════════════════════════════════════════════════════ */

export async function consultarUso(req) {
  const info = await verificarLimite(req, { dryRun: true });
  if (!info || info.softFailure === 'upstash_missing') return null;

  return {
    plan: info.plan,
    limites: info.limites,
    uso: info.uso,
    restanteDia: info.restanteDia,
    restanteMin: info.restanteMin,
    headers: info.headers,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   6 · REGISTRAR · compat con v1 (ya no hace falta)
   ═══════════════════════════════════════════════════════════════════ */

/**
 * No-op por compatibilidad con index.js v6.6.
 * El conteo real ocurre en verificarLimite().
 */
export async function registrarUso(/* req */) {
  return true;
}

/* ═══════════════════════════════════════════════════════════════════
   7 · REEMBOLSAR · devuelve 1 mensaje si el motor de IA falla
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Reembolsa 1 mensaje al usuario. Ideal cuando:
 *   · El motor de IA falló
 *   · El usuario canceló antes de que se emitiera ningún token
 *   · Un error de red impidió completar la respuesta
 *
 * No falla si no hay Upstash. Nunca tira excepción.
 */
export async function reembolsarUso(req) {
  const upstash = getUpstash();
  if (!upstash) return false;

  const { keys } = buildKeys(req);
  const r = await evalScript(EVAL_REFUND, keys, []);
  return Boolean(r.ok);
}

/* ═══════════════════════════════════════════════════════════════════
   8 · RESET · útil para admin o pruebas
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Borra TODOS los contadores del usuario (día, minuto, burst, mes).
 * Solo debe usarse desde un endpoint admin o desde tests.
 */
export async function resetUsage(req) {
  const u = getUpstash();
  if (!u) return false;

  const { keys } = buildKeys(req);
  try {
    const res = await fetch(`${u.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(keys.map((k) => ['DEL', k])),
    });
    if (!res.ok) return false;
    return true;
  } catch {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════
   9 · STATS · info enriquecida para la UI
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Devuelve un objeto con:
 *   · uso y límites actuales
 *   · porcentajes consumidos (para barras de progreso)
 *   · cuándo se resetea cada ventana (ISO strings)
 *   · próximos segundos hasta que se pueda reintentar
 */
export async function getUsageStats(req) {
  const info = await verificarLimite(req, { dryRun: true });

  const limits = info.limites;
  const uso = info.uso;

  const pctDay = limits.porDia > 0 ? Math.min(100, (uso.dia / limits.porDia) * 100) : 0;
  const pctMin = limits.porMin > 0 ? Math.min(100, (uso.minuto / limits.porMin) * 100) : 0;

  const now = new Date();
  const nextMinute = new Date(now);
  nextMinute.setUTCSeconds(60, 0);
  const nextDay = new Date(now);
  nextDay.setUTCHours(24, 0, 0, 0);
  const nextMonth = new Date(now);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1, 1);
  nextMonth.setUTCHours(0, 0, 0, 0);

  return {
    plan: info.plan,
    uso,
    limites: limits,
    restante: {
      dia: info.restanteDia,
      minuto: info.restanteMin,
      burst: Math.max(0, limits.porBurst - (uso.burst || 0)),
    },
    porcentaje: {
      dia: Math.round(pctDay),
      minuto: Math.round(pctMin),
    },
    resetAt: {
      minuto: nextMinute.toISOString(),
      dia: nextDay.toISOString(),
      mes: nextMonth.toISOString(),
    },
    headers: info.headers,
  };
}

/* ═══════════════════════════════════════════════════════════════════
   10 · HEALTH · para /api/health
   ═══════════════════════════════════════════════════════════════════ */

/**
 * Diagnóstico rápido: ¿Upstash está configurado y responde?
 */
export async function pingLimits() {
  const u = getUpstash();
  if (!u) return { ok: false, reason: 'no_upstash', failMode: FAIL_MODE };

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
    if (!res.ok) return { ok: false, reason: `http_${res.status}`, failMode: FAIL_MODE };
    const json = await res.json();
    return {
      ok: json.result === 'PONG',
      latencyMs: Date.now() - t0,
      failMode: FAIL_MODE,
    };
  } catch (e) {
    return { ok: false, reason: e?.message || 'fetch_failed', failMode: FAIL_MODE };
  }
}