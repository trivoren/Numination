/**
 * limits.js — Rate limiting por plan con Upstash Redis
 * Usa pipeline (1 request de red por chequeo) y EXPIRE ... NX para no renovar el TTL.
 */

export const PLAN_LIMITS = {
  free:    { messagesPerDay: 20,   messagesPerMinute: 5,  name: 'Free' },
  basic:   { messagesPerDay: 100,  messagesPerMinute: 15, name: 'Basic' },
  pro:     { messagesPerDay: 500,  messagesPerMinute: 30, name: 'Pro' },
  premium: { messagesPerDay: 2000, messagesPerMinute: 60, name: 'Premium' },
};

const DEFAULT_PLAN = 'free';
const DAY_SECONDS = 86400;
const MINUTE_SECONDS = 60;

/** Obtiene el cliente Upstash del entorno (REST token + URL). */
function getUpstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

/** Respuesta estándar cuando Upstash no está disponible (fail-open). */
function failOpen(limits) {
  return {
    permitido: true,
    plan: limits.name,
    restanteDia: limits.messagesPerDay,
    restanteMin: limits.messagesPerMinute,
    limites: { porDia: limits.messagesPerDay, porMin: limits.messagesPerMinute },
    razon: null,
    mensaje: null,
    retryAfter: null,
    uso: { hoy: 0, minuto: 0 },
  };
}

/**
 * Verifica si el usuario puede enviar mensajes.
 * Devuelve { permitido, restanteDia, restanteMin, ... }.
 */
export async function verificarLimite(req) {
  const plan = req.user?.plan || DEFAULT_PLAN;
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS[DEFAULT_PLAN];
  const userId = req.user?.id || req.ip || 'anon';
  const upstash = getUpstash();

  if (!upstash) return failOpen(limits);

  const dayKey = `ratelimit:${userId}:day:${new Date().toISOString().slice(0, 10)}`;
  const minKey = `ratelimit:${userId}:min:${new Date().toISOString().slice(0, 16)}`;

  try {
    // Pipeline: INCR + EXPIRE NX en una sola llamada de red.
    const res = await fetch(`${upstash.url}/pipeline`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${upstash.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['INCR', dayKey],
        ['EXPIRE', dayKey, String(DAY_SECONDS), 'NX'],
        ['INCR', minKey],
        ['EXPIRE', minKey, String(MINUTE_SECONDS), 'NX'],
      ]),
    });

    if (!res.ok) throw new Error(`Upstash ${res.status}`);
    const data = await res.json();
    const usoHoy = data[0]?.result ?? 0;
    const usoMin = data[2]?.result ?? 0;

    const restanteDia = Math.max(0, limits.messagesPerDay - usoHoy);
    const restanteMin = Math.max(0, limits.messagesPerMinute - usoMin);

    if (usoHoy > limits.messagesPerDay) {
      return {
        permitido: false,
        plan: limits.name,
        restanteDia: 0,
        restanteMin,
        limites: { porDia: limits.messagesPerDay, porMin: limits.messagesPerMinute },
        razon: 'daily_limit',
        mensaje: `Límite diario alcanzado (${limits.messagesPerDay} mensajes). Mejora tu plan para continuar.`,
        retryAfter: DAY_SECONDS,
        uso: { hoy: usoHoy, minuto: usoMin },
      };
    }

    if (usoMin > limits.messagesPerMinute) {
      return {
        permitido: false,
        plan: limits.name,
        restanteDia,
        restanteMin: 0,
        limites: { porDia: limits.messagesPerDay, porMin: limits.messagesPerMinute },
        razon: 'minute_limit',
        mensaje: `Demasiados mensajes en poco tiempo. Espera unos segundos.`,
        retryAfter: MINUTE_SECONDS,
        uso: { hoy: usoHoy, minuto: usoMin },
      };
    }

    return {
      permitido: true,
      plan: limits.name,
      restanteDia,
      restanteMin,
      limites: { porDia: limits.messagesPerDay, porMin: limits.messagesPerMinute },
      razon: null,
      mensaje: null,
      retryAfter: null,
      uso: { hoy: usoHoy, minuto: usoMin },
    };
  } catch (e) {
    console.warn('[limits] error:', e.message);
    return failOpen(limits);
  }
}

/** Consulta el uso actual del usuario (para mostrar en UI). */
export async function consultarUso(req) {
  const plan = req.user?.plan || DEFAULT_PLAN;
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS[DEFAULT_PLAN];
  const userId = req.user?.id || req.ip || 'anon';
  const upstash = getUpstash();

  if (!upstash) return null;

  const dayKey = `ratelimit:${userId}:day:${new Date().toISOString().slice(0, 10)}`;
  const minKey = `ratelimit:${userId}:min:${new Date().toISOString().slice(0, 16)}`;

  try {
    const res = await fetch(`${upstash.url}/pipeline`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${upstash.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([
        ['GET', dayKey],
        ['GET', minKey],
      ]),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const usoHoy = data[0]?.result ?? 0;
    const usoMin = data[1]?.result ?? 0;

    return {
      plan: limits.name,
      limites: { porDia: limits.messagesPerDay, porMin: limits.messagesPerMinute },
      uso: { hoy: usoHoy, minuto: usoMin },
      restanteDia: Math.max(0, limits.messagesPerDay - usoHoy),
      restanteMin: Math.max(0, limits.messagesPerMinute - usoMin),
    };
  } catch {
    return null;
  }
}

/** Registra uso (ya se hace en verificarLimite con INCR, pero útil para otros flujos). */
export async function registrarUso(req) {
  // El INCR ya se hace en verificarLimite. Esta función es un no-op
  // que existe por compatibilidad con llamadas existentes.
  return true;
}
