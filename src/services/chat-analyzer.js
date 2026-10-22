/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/chat-analyzer.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Analizador de uso en background.

   QUÉ MIDE
   · Cuántas veces al día usa cada persona el Coder (el IDE de código).
   · Cuántas conversaciones de chat abre.
   · Cuántas imágenes genera.

   PARA QUÉ
   Un usuario que abre el Coder 12 veces en un día está construyendo
   algo: es el momento exacto para ofrecerle un plan con más potencia.
   La señal es fuerte y la ventana es corta, así que el análisis corre
   en background (no bloquea ninguna request) y genera UNA notificación
   por usuario y por día.

   GARANTÍAS
   · Idempotente: el mismo usuario no recibe dos avisos el mismo día
     (se apoya en la clave de deduplicación del motor de notificaciones).
   · Nunca rompe el flujo: si la base no está, se registra y se sale.
   · El intervalo es unref() → no impide que el proceso termine.
   ═══════════════════════════════════════════════════════════════════════════ */

import { sql, supabaseDisponible } from './supabase.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  table: 'coder_usage_daily',
  coderThreshold: 10,          // más de 10 usos del Coder en un día
  chatThreshold: 25,
  imageThreshold: 20,
  intervalMs: 30 * 60_000,     // cada 30 minutos
  retentionDays: 90,
  plans: ['pro', 'team'],
});

export const FEATURES = Object.freeze({
  CODER: 'coder',
  CHAT: 'chat',
  IMAGE: 'image',
  VOICE: 'voice',
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · ESQUEMA
   ═══════════════════════════════════════════════════════════════════════════ */

let schemaPromise = null;

async function ensureSchema() {
  if (!supabaseDisponible()) return { ok: false };
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    try {
      await sql`
        create table if not exists ${sql(CFG.table)} (
          user_id      uuid not null,
          day          date not null,
          coder_uses   integer not null default 0,
          chat_uses    integer not null default 0,
          image_uses   integer not null default 0,
          voice_uses   integer not null default 0,
          total_uses   integer not null default 0,
          notified     boolean not null default false,
          updated_at   timestamptz not null default now(),
          primary key (user_id, day)
        )
      `;
      await sql`
        create index if not exists coder_usage_day_idx
          on ${sql(CFG.table)} (day desc, coder_uses desc)
      `;
      return { ok: true };
    } catch (e) {
      LOG.warn('chat-analyzer: no se pudo crear el esquema', { error: e.message, code: e.code });
      return { ok: false };
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · REGISTRO DE USO
   ═══════════════════════════════════════════════════════════════════════════ */

function columnFor(feature) {
  switch (String(feature || '').toLowerCase()) {
    case FEATURES.CODER: return 'coder_uses';
    case FEATURES.CHAT: return 'chat_uses';
    case FEATURES.IMAGE: return 'image_uses';
    case FEATURES.VOICE: return 'voice_uses';
    default: return null;
  }
}

/**
 * Registra un uso.
 *
 * @param {string} userId
 * @param {string} feature  'coder' | 'chat' | 'image' | 'voice'
 * @param {number} [amount]
 * @returns {Promise<{ok:boolean, degraded:boolean}>}
 */
export async function recordUsage(userId, feature, amount = 1) {
  if (!userId) return { ok: false, degraded: true };

  const column = columnFor(feature);
  if (!column) return { ok: false, degraded: true, error: 'feature_desconocida' };

  if (!supabaseDisponible()) {
    LOG.debug('chat-analyzer: uso registrado en modo degradado', { userId, feature });
    return { ok: true, degraded: true };
  }

  try {
    await ensureSchema();

    await sql`
      insert into ${sql(CFG.table)} (
        user_id, day, ${sql(column)}, total_uses
      ) values (
        ${userId}::uuid, current_date, ${Number(amount) || 1}, ${Number(amount) || 1}
      )
      on conflict (user_id, day) do update
        set ${sql(column)} = ${sql(CFG.table)}.${sql(column)} + ${Number(amount) || 1},
            total_uses = ${sql(CFG.table)}.total_uses + ${Number(amount) || 1},
            updated_at = now()
    `;

    return { ok: true, degraded: false };
  } catch (e) {
    LOG.warn('chat-analyzer: recordUsage falló', { error: e.message, code: e.code });
    return { ok: false, degraded: false, error: e.message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · ANÁLISIS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Busca usuarios que superaron los umbrales de uso HOY y genera una
 * notificación por cada uno (una sola vez por día).
 *
 * @param {object} [opts] { force, day }
 * @returns {Promise<object>} resumen del análisis
 */
export async function analyzeUsage(opts = {}) {
  if (!supabaseDisponible()) {
    return { ok: true, degraded: true, candidates: 0, notified: 0, reason: 'no_db' };
  }

  try {
    await ensureSchema();

    const rows = await sql`
      select
        u.user_id::text as user_id,
        u.coder_uses,
        u.chat_uses,
        u.image_uses,
        u.total_uses,
        p.email,
        coalesce(p."displayName", p.name) as name,
        coalesce(p.tier, p.plan, 'free') as plan
      from ${sql(CFG.table)} u
      left join public.profiles p on p.id = u.user_id
      where u.day = ${opts.day || sql`current_date`}
        and u.notified = false
        and (
          u.coder_uses > ${CFG.coderThreshold}
          or u.chat_uses > ${CFG.chatThreshold}
          or u.image_uses > ${CFG.imageThreshold}
        )
      limit 200
    `;

    if (!rows.length) {
      return { ok: true, degraded: false, candidates: 0, notified: 0 };
    }

    let notified = 0;

    for (const row of rows) {
      try {
        await notifyCandidate(row, opts);
        notified++;
      } catch (e) {
        LOG.warn('chat-analyzer: no se pudo notificar', { userId: row.user_id, error: e.message });
      }

      // Se marca como notificado aunque la notificación falle: evita
      // reintentos infinitos dentro del mismo día.
      await sql`
        update ${sql(CFG.table)}
        set notified = true, updated_at = now()
        where user_id = ${row.user_id}::uuid
          and day = ${opts.day || sql`current_date`}
      `;
    }

    LOG.info('chat-analyzer: análisis completado', {
      candidates: rows.length,
      notified,
    });

    return { ok: true, degraded: false, candidates: rows.length, notified };
  } catch (e) {
    LOG.error('chat-analyzer: analyzeUsage falló', { error: e.message, code: e.code });
    return { ok: false, degraded: false, error: e.message, candidates: 0, notified: 0 };
  }
}

/**
 * Genera la notificación para un candidato.
 */
async function notifyCandidate(row, opts = {}) {
  const { EVENTS, createNotification } = await import('./notification-engine.js');

  const reasons = [];
  if (row.coder_uses > CFG.coderThreshold) reasons.push(`${row.coder_uses} usos del Coder`);
  if (row.chat_uses > CFG.chatThreshold) reasons.push(`${row.chat_uses} consultas`);
  if (row.image_uses > CFG.imageThreshold) reasons.push(`${row.image_uses} imágenes`);

  const reason = reasons.join(' · ');
  const name = row.name ? `, ${row.name}` : '';

  await createNotification({
    userId: row.user_id,
    type: EVENTS.SYSTEM_ANNOUNCEMENT,
    title: 'Vas como un pro',
    body:
      `Hoy usaste Numination ${reason}${name}. ` +
      'El Plan Ultimate te da más créditos, acceso al Coder sin límites y ' +
      'respuestas más rápidas.',
    link: '/billing?plan=ultimate',
    priority: 'normal',
    meta: {
      reason: 'coder_intensity',
      coderUses: row.coder_uses,
      chatUses: row.chat_uses,
      imageUses: row.image_uses,
      plan: row.plan,
      force: Boolean(opts.force),
    },
    dedupeKey: `plan-upsell:${row.user_id}:${new Date().toISOString().slice(0, 10)}`,
  });
}

/**
 * Estadísticas de uso de un usuario (para el dashboard y el admin).
 */
export async function getUsageStats(userId, { days = 7 } = {}) {
  if (!supabaseDisponible()) {
    return { ok: true, degraded: true, days: [], totals: { coder: 0, chat: 0, image: 0, total: 0 } };
  }

  try {
    await ensureSchema();

    const rows = await sql`
      select
        day::text as day,
        coder_uses,
        chat_uses,
        image_uses,
        voice_uses,
        total_uses
      from ${sql(CFG.table)}
      where user_id = ${userId}::uuid
        and day >= current_date - ${Number(days) || 7}
      order by day asc
    `;

    const totals = rows.reduce(
      (acc, r) => ({
        coder: acc.coder + Number(r.coder_uses || 0),
        chat: acc.chat + Number(r.chat_uses || 0),
        image: acc.image + Number(r.image_uses || 0),
        total: acc.total + Number(r.total_uses || 0),
      }),
      { coder: 0, chat: 0, image: 0, total: 0 }
    );

    return { ok: true, degraded: false, days: rows, totals };
  } catch (e) {
    LOG.warn('chat-analyzer: getUsageStats falló', { error: e.message });
    return { ok: true, degraded: true, days: [], totals: { coder: 0, chat: 0, image: 0, total: 0 } };
  }
}

/**
 * Ranking de usuarios por uso del Coder (solo admin).
 */
export async function getTopCoderUsers({ limit = 20, days = 1 } = {}) {
  if (!supabaseDisponible()) return { ok: true, degraded: true, users: [] };

  try {
    await ensureSchema();

    const rows = await sql`
      select
        u.user_id::text as user_id,
        u.coder_uses,
        u.total_uses,
        p.email,
        coalesce(p."displayName", p.name) as name,
        coalesce(p.tier, p.plan, 'free') as plan
      from ${sql(CFG.table)} u
      left join public.profiles p on p.id = u.user_id
      where u.day >= current_date - ${Number(days) || 1}
      order by u.coder_uses desc, u.total_uses desc
      limit ${Math.min(Number(limit) || 20, 100)}
    `;

    return { ok: true, degraded: false, users: rows };
  } catch (e) {
    LOG.warn('chat-analyzer: getTopCoderUsers falló', { error: e.message });
    return { ok: true, degraded: true, users: [] };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · WORKER EN BACKGROUND
   ═══════════════════════════════════════════════════════════════════════════ */

let workerTimer = null;
let workerRunning = false;

/**
 * Arranca el worker. Idempotente: llamarlo dos veces no duplica timers.
 */
export function startAnalyzerWorker(opts = {}) {
  if (workerTimer) return workerTimer;

  const interval = opts.intervalMs || CFG.intervalMs;

  workerTimer = setInterval(async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      await analyzeUsage();
    } catch (e) {
      LOG.warn('chat-analyzer: ciclo falló', { error: e.message });
    } finally {
      workerRunning = false;
    }
  }, interval);

  if (workerTimer.unref) workerTimer.unref();

  LOG.info('chat-analyzer: worker iniciado', { intervalMs: interval });

  return workerTimer;
}

export function stopAnalyzerWorker() {
  if (!workerTimer) return false;
  clearInterval(workerTimer);
  workerTimer = null;
  LOG.info('chat-analyzer: worker detenido');
  return true;
}

export function getAnalyzerStatus() {
  return {
    running: Boolean(workerTimer),
    intervalMs: CFG.intervalMs,
    thresholds: {
      coder: CFG.coderThreshold,
      chat: CFG.chatThreshold,
      image: CFG.imageThreshold,
    },
    dbAvailable: supabaseDisponible(),
  };
}

/** Limpia registros antiguos. */
export async function purgeOldUsage(days = CFG.retentionDays) {
  if (!supabaseDisponible()) return { ok: true, degraded: true, deleted: 0 };
  try {
    await ensureSchema();
    const rows = await sql`
      delete from ${sql(CFG.table)}
      where day < current_date - ${Number(days) || CFG.retentionDays}
      returning user_id
    `;
    return { ok: true, deleted: rows.length };
  } catch (e) {
    LOG.warn('chat-analyzer: purge falló', { error: e.message });
    return { ok: false, deleted: 0 };
  }
}

export default {
  FEATURES,
  recordUsage,
  analyzeUsage,
  getUsageStats,
  getTopCoderUsers,
  startAnalyzerWorker,
  stopAnalyzerWorker,
  getAnalyzerStatus,
  purgeOldUsage,
};
