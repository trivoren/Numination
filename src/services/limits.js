/* ================================================================
   NUMINATION · limits.js
   Límite de mensajes por usuario/IP usando Upstash Redis REST API.
   ----------------------------------------------------------------
   API pública:
     verificarLimite(req)  → consulta sin incrementar
     registrarUso(req)     → incrementa día + minuto (atómico)
     consultarUso(req)     → snapshot para /api/limits/usage
     resetLimite(req)      → borra los contadores (debug)
   ================================================================ */

let TEST_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL ?? TEST_KEYS.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? TEST_KEYS.UPSTASH_REDIS_REST_TOKEN;

const PLAN_LIMITS = {
  anon:          { porDia: 10,   porMinuto: 3  },
  free:          { porDia: 50,   porMinuto: 5  },
  'pro-coder':   { porDia: 200,  porMinuto: 15 },
  'pro-plus':    { porDia: 500,  porMinuto: 30 },
  'pro-mad-max': { porDia: 2000, porMinuto: 60 },
};

const KEY_PREFIX = 'numination:usage:';
const TZ_OFFSET = -5 * 60 * 60 * 1000;
const DEBUG = process.env.DEBUG === '1';

const upstashConfigured = Boolean(UPSTASH_URL && UPSTASH_TOKEN);
let warningShown = false;

if (!upstashConfigured) {
  console.warn('[limits] Upstash no configurado — sin límites activos');
}

function getPlan(req) {
  const raw = req.user?.plan;
  if (raw && PLAN_LIMITS[raw]) return raw;
  return req.user ? 'free' : 'anon';
}

function getIdentifier(req) {
  if (req.user?.id) {
    return { key: KEY_PREFIX + req.user.id, label: req.user.id };
  }
  const ip =
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.ip ||
    'unknown';
  return { key: KEY_PREFIX + 'anon:' + ip, label: 'anon:' + ip };
}

function getSecondsUntilMidnight() {
  const ahora = new Date();
  const co = new Date(ahora.getTime() + TZ_OFFSET);
  const media = new Date(co);
  media.setHours(24, 0, 0, 0);
  const diff = media.getTime() - co.getTime();
  return Math.max(1, Math.floor(diff / 1000));
}

async function upstashPipeline(commands) {
  if (!upstashConfigured) return null;
  try {
    const response = await fetch(UPSTASH_URL + '/pipeline', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + UPSTASH_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    if (!response.ok) {
      console.warn('[limits] Pipeline HTTP', response.status);
      return null;
    }
    const data = await response.json();
    if (!Array.isArray(data)) return null;
    return data.map((entry) => entry?.result ?? null);
  } catch (err) {
    console.warn('[limits] Pipeline error:', err.message);
    return null;
  }
}

async function upstashCommand(command, ...args) {
  if (!upstashConfigured) return null;
  try {
    const response = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + UPSTASH_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([command, ...args]),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.result ?? null;
  } catch (err) {
    if (DEBUG) console.warn('[limits] Command error:', err.message);
    return null;
  }
}

function toNumber(v) {
  if (v === null || v === undefined) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function dayKey(base)   { return base + ':day'; }
function minuteKey(base) {
  const min = Math.floor(Date.now() / 60000);
  return base + ':min:' + min;
}

export async function verificarLimite(req) {
  const plan = getPlan(req);
  const límites = PLAN_LIMITS[plan];
  const { key: base, label } = getIdentifier(req);
  const dk = dayKey(base);
  const mk = minuteKey(base);

  if (!upstashConfigured) {
    return {
      permitido: true,
      plan,
      uso: { dia: 0, minuto: 0 },
      límites,
      restanteDia: límites.porDia,
      restanteMin: límites.porMinuto,
    };
  }

  const results = await upstashPipeline([
    ['GET', dk],
    ['GET', mk],
  ]);

  const usoDia  = toNumber(results?.[0]);
  const usoMin  = toNumber(results?.[1]);

  const restanteDia = Math.max(0, límites.porDia - usoDia);
  const restanteMin = Math.max(0, límites.porMinuto - usoMin);

  if (usoMin >= límites.porMinuto) {
    const retryAfter = 60 - (Math.floor(Date.now() / 1000) % 60);
    if (DEBUG) console.warn(`[limits] ${label} excedió minuto: ${usoMin}/${límites.porMinuto}`);
    return {
      permitido: false,
      razon: 'minuto',
      mensaje: `Vas muy rápido. Espera ${retryAfter} segundos antes de enviar otro mensaje.`,
      retryAfter,
      plan,
      uso: { dia: usoDia, minuto: usoMin },
      límites,
      restanteDia,
      restanteMin: 0,
    };
  }

  if (usoDia >= límites.porDia) {
    const retryAfter = getSecondsUntilMidnight();
    if (DEBUG) console.warn(`[limits] ${label} excedió día: ${usoDia}/${límites.porDia}`);
    return {
      permitido: false,
      razon: 'dia',
      mensaje: `Alcanzaste el límite de ${límites.porDia} mensajes hoy. Vuelve mañana.`,
      retryAfter,
      plan,
      uso: { dia: usoDia, minuto: usoMin },
      límites,
      restanteDia: 0,
      restanteMin,
    };
  }

  return {
    permitido: true,
    plan,
    uso: { dia: usoDia, minuto: usoMin },
    límites,
    restanteDia,
    restanteMin,
  };
}

export async function registrarUso(req) {
  if (!upstashConfigured) return;

  const { key: base, label } = getIdentifier(req);
  const dk = dayKey(base);
  const mk = minuteKey(base);
  const ttlDia = getSecondsUntilMidnight();

  const results = await upstashPipeline([
    ['INCR', dk],
    ['EXPIRE', dk, String(ttlDia), 'NX'],
    ['INCR', mk],
    ['EXPIRE', mk, '60', 'NX'],
  ]);

  if (!results) {
    console.warn('[limits] registrarUso falló para', label);
    return;
  }

  const usoDia = toNumber(results[0]);
  if (DEBUG) {
    const límites = PLAN_LIMITS[getPlan(req)];
    console.log(`[limits] ${label} registro uso: ${usoDia}/${límites.porDia}`);
  }
}

export async function consultarUso(req) {
  const plan = getPlan(req);
  const límites = PLAN_LIMITS[plan];
  const { key: base } = getIdentifier(req);
  const dk = dayKey(base);
  const mk = minuteKey(base);
  const renovacion = getSecondsUntilMidnight() * 1000;

  if (!upstashConfigured) {
    return {
      ok: true,
      plan,
      uso: { dia: 0, minuto: 0 },
      límites,
      restanteDia: límites.porDia,
      restanteMin: límites.porMinuto,
      renovacion,
    };
  }

  const results = await upstashPipeline([
    ['GET', dk],
    ['GET', mk],
  ]);

  const usoDia = toNumber(results?.[0]);
  const usoMin = toNumber(results?.[1]);

  return {
    ok: true,
    plan,
    uso: { dia: usoDia, minuto: usoMin },
    límites,
    restanteDia: Math.max(0, límites.porDia - usoDia),
    restanteMin: Math.max(0, límites.porMinuto - usoMin),
    renovacion,
  };
}

export async function resetLimite(req) {
  if (!upstashConfigured) return false;
  const { key: base } = getIdentifier(req);
  const dk = dayKey(base);
  const mk = minuteKey(base);
  const results = await upstashPipeline([
    ['DEL', dk],
    ['DEL', mk],
  ]);
  return results !== null;
}