/* ================================================================
   NUMINATION · limits.js
   Límite de mensajes por usuario/IP usando Upstash Redis.
   ================================================================ */

import { Redis } from '@upstash/redis';

let TEST_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

const UPSTASH_URL =
  process.env.UPSTASH_REDIS_REST_URL ?? TEST_KEYS.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ?? TEST_KEYS.UPSTASH_REDIS_REST_TOKEN;

if (!UPSTASH_URL || !UPSTASH_TOKEN) {
  console.warn('⚠️  Upstash Redis no configurado. Límites desactivados.');
}

const redis = UPSTASH_URL && UPSTASH_TOKEN
  ? new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN })
  : null;

/* ── Configuración de límites por plan ── */
export const LIMITES = {
  anonimo:   { porMinuto: 3,  porDia: 10  },
  estudiante: { porMinuto: 10, porDia: 50  },
  docente:   { porMinuto: 20, porDia: 200 },
  premium:   { porMinuto: 30, porDia: 500 },
};

function planDelUsuario(req) {
  if (req.user?.plan === 'premium') return 'premium';
  if (req.user?.role === 'teacher') return 'docente';
  if (req.user) return 'estudiante';
  return 'anonimo';
}

function clientKey(req) {
  if (req.user?.id) return `user:${req.user.id}`;
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.ip
    || 'unknown';
  return `ip:${ip}`;
}

function fechaHoy() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function minutoActual() {
  return new Date().toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
}

function segundosHastaMedianoche() {
  const ahora = new Date();
  const medianoche = new Date(ahora);
  medianoche.setHours(24, 0, 0, 0);
  return Math.floor((medianoche - ahora) / 1000);
}

function segundosHastaSiguienteMinuto() {
  return 60 - new Date().getSeconds();
}

/* ── Verificar y registrar uso ── */
export async function verificarLimite(req) {
  if (!redis) {
    return { permitido: true, ilimitado: true, razon: 'sin_redis' };
  }

  const plan = planDelUsuario(req);
  const limites = LIMITES[plan];
  const key = clientKey(req);
  const keyDia = `limit:${key}:day:${fechaHoy()}`;
  const keyMin = `limit:${key}:min:${minutoActual()}`;

  try {
    // Incrementar ambos contadores en paralelo
    const [usoDia, usoMin] = await Promise.all([
      redis.incr(keyDia),
      redis.incr(keyMin),
    ]);

    // Establecer expiración solo la primera vez (evita el bug de re-expirar)
    if (usoDia === 1) await redis.expire(keyDia, 86400);
    if (usoMin === 1) await redis.expire(keyMin, 60);

    // Límite por minuto (anti-spam)
    if (usoMin > limites.porMinuto) {
      return {
        permitido: false,
        razon: 'minuto',
        mensaje: `Vas muy rápido. Espera ${segundosHastaSiguienteMinuto()} segundos antes de enviar otro mensaje.`,
        plan,
        uso: { minuto: usoMin, dia: usoDia },
        limites,
        retryAfter: segundosHastaSiguienteMinuto(),
      };
    }

    // Límite por día
    if (usoDia > limites.porDia) {
      return {
        permitido: false,
        razon: 'dia',
        mensaje: `Alcanzaste el límite de ${limites.porDia} mensajes hoy. Vuelve mañana.`,
        plan,
        uso: { minuto: usoMin, dia: usoDia },
        limites,
        retryAfter: segundosHastaMedianoche(),
      };
    }

    return {
      permitido: true,
      plan,
      uso: { minuto: usoMin, dia: usoDia },
      limites,
      restanteDia: limites.porDia - usoDia,
      restanteMin: limites.porMinuto - usoMin,
    };
  } catch (e) {
    console.error('[limits] error:', e.message);
    return { permitido: true, error: e.message };
  }
}

/* ── Consultar uso sin incrementar (para el frontend) ── */
export async function consultarUso(req) {
  if (!redis) return null;

  const plan = planDelUsuario(req);
  const limites = LIMITES[plan];
  const key = clientKey(req);
  const keyDia = `limit:${key}:day:${fechaHoy()}`;
  const keyMin = `limit:${key}:min:${minutoActual()}`;

  try {
    const [usoDia, usoMin] = await Promise.all([
      redis.get(keyDia),
      redis.get(keyMin),
    ]);

    const dia = parseInt(usoDia, 10) || 0;
    const min = parseInt(usoMin, 10) || 0;

    return {
      plan,
      uso: { dia, minuto: min },
      limites,
      restanteDia: Math.max(0, limites.porDia - dia),
      restanteMin: Math.max(0, limites.porMinuto - min),
    };
  } catch (e) {
    console.error('[limits] consultarUso error:', e.message);
    return null;
  }
}

/* ── Reset manual (útil para pruebas) ── */
export async function resetLimite(req) {
  if (!redis) return false;
  const key = clientKey(req);
  try {
    await Promise.all([
      redis.del(`limit:${key}:day:${fechaHoy()}`),
      redis.del(`limit:${key}:min:${minutoActual()}`),
    ]);
    return true;
  } catch {
    return false;
  }
}