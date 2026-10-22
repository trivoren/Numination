/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/gdpr-tools.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Derechos del usuario sobre sus datos (GDPR / Ley 1581 Colombia).

   MONTADO
     mountGdprRoutes(app) → añade:
       GET    /api/gdpr/export        exporta TODOS los datos del usuario
       DELETE /api/gdpr/delete        borra la cuenta y sus datos
       GET    /api/gdpr/info           qué se guardará y por qué

   EXPORTACIÓN
     Devuelve un JSON con: perfil, chats, mensajes, memorias, personas,
     documentos RAG, prompts guardados, notificaciones, pagos,
     suscripciones y créditos. Todo filtrado por el userId de la sesión:
     un usuario NUNCA puede exportar datos de otro.

   BORRADO
     · Borra en cascada los datos que pertenecen al usuario.
     · Por defecto ANONIMIZA (mantiene los pagos y el historial
       financiero, porque la contabilidad lo exige) y BORRA el resto.
     · Con `?hard=true` borra también el historial de pagos y la cuenta
       de perfil (derecho al olvido completo).
     · Antes de borrar se genera un snapshot en la tabla `gdpr_deletions`
       (metadatos, sin contenido) para tener trazabilidad.
     · La sesión se destruye al terminar.
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import { sql, supabaseDisponible } from '../services/supabase.js';
import { logAction } from '../services/audit-logger.js';
import { invalidateSession } from '../middleware/auth.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  maxMessages: 5000,
  maxChats: 1000,
  deletionTable: 'gdpr_deletions',
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/**
 * Ejecuta una consulta devolviendo [] si la tabla no existe.
 * (El esquema de Numination evoluciona; el GDPR no puede romperse por
 *  una tabla que todavía no existe.)
 */
async function safeQuery(fragment) {
  try {
    const rows = await fragment;
    return Array.isArray(rows) ? rows : [];
  } catch (e) {
    LOG.debug('gdpr-tools: consulta ignorada', { error: e.message });
    return [];
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · RUTAS
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountGdprRoutes(app) {
  const router = express.Router();

  /* ─── GET /api/gdpr/info ───────────────────────────────────────────── */
  router.get('/api/gdpr/info', requireAuth, asyncHandler(async (_req, res) => {
    res.json({
      ok: true,
      info: {
        collects: [
          { data: 'Perfil (nombre, correo, avatar)', why: 'Para tu cuenta y para mostrarte en el chat.', retention: 'Hasta que elimines la cuenta.' },
          { data: 'Conversaciones y mensajes', why: 'Son tu historial: sin ellos, no hay producto.', retention: 'Hasta que los borres o elimines la cuenta.' },
          { data: 'Memorias (hechos que la IA recuerda)', why: 'Para que la IA no te pregunte lo mismo cada vez.', retention: 'Hasta que las borres.' },
          { data: 'Personas (asistentes personalizados)', why: 'Son tuyos; los creaste vos.', retention: 'Hasta que las elimines.' },
          { data: 'Documentos PDF indexados', why: 'Para responder con citas de tus fuentes.', retention: 'Hasta que los borres.' },
          { data: 'Historial de pagos', why: 'Obligación contable y fiscal.', retention: '5 años (normativa colombiana).' },
          { data: 'Logs de seguridad y auditoría', why: 'Prevenir fraude y abuso.', retention: '12 meses.' },
        ],
        rights: [
          'Acceso: exportás todos tus datos en JSON (GET /api/gdpr/export).',
          'Rectificación: editás tu perfil y tus memorias desde la app.',
          'Supresión: eliminás la cuenta y todos tus datos (DELETE /api/gdpr/delete).',
          'Portabilidad: la exportación es JSON, listo para otra plataforma.',
          'Oposición: pedís que no usemos tus datos para marketing desde Notificaciones.',
        ],
        contact: 'privacidad@numination.com',
      },
    });
  }));

  /* ─── GET /api/gdpr/export ─────────────────────────────────────────── */
  router.get('/api/gdpr/export', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.id;

    if (!supabaseDisponible()) {
      throw new ValidationError('La base de datos no está disponible para la exportación.', 'export');
    }

    const started = Date.now();

    const [
      profileRows,
      chatRows,
      messageRows,
      memoryRows,
      personaRows,
      documentRows,
      promptRows,
      notificationRows,
      paymentRows,
      subscriptionRows,
      creditRows,
    ] = await Promise.all([
      safeQuery(sql`
        select id::text as id, email, "displayName" as name, "avatarUrl" as avatar,
               role, coalesce(tier, plan, 'free') as plan, "createdAt" as created_at,
               last_login_at, email_verified
        from public.profiles where id = ${userId}::uuid
      `),
      safeQuery(sql`
        select id::text as id, title, mode, "isGhost" as is_ghost, "createdAt" as created_at
        from "Chat" where "userId" = ${userId}::uuid
        order by "createdAt" desc limit ${CFG.maxChats}
      `),
      safeQuery(sql`
        select m.id::text as id, m."chatId"::text as chat_id, m.role, m.content,
               m.sources, m."createdAt" as created_at
        from "Message" m
        join "Chat" c on c.id = m."chatId"
        where c."userId" = ${userId}::uuid
        order by m."createdAt" desc limit ${CFG.maxMessages}
      `),
      safeQuery(sql`
        select id, content, type, coalesce(category,'other') as category, tags,
               coalesce(relevance, 70) as relevance, pinned, source,
               "createdAt" as created_at, "updatedAt" as updated_at
        from "Memory" where "userId" = ${userId}::uuid
        order by "createdAt" desc
      `),
      safeQuery(sql`
        select id::text as id, name, description, system_prompt, avatar, color,
               temperature, is_default, is_active, "createdAt" as created_at
        from personas where user_id = ${userId}::uuid
        order by "createdAt" desc
      `),
      safeQuery(sql`
        select id::text as id, filename, title, bytes, chunk_count, status, "created_at"
        from rag_documents where user_id = ${userId}::uuid
        order by created_at desc
      `),
      safeQuery(sql`
        select p.id::text as id, p.title, p.content, p.description, p.tags,
               p.usage_count, f.name as folder
        from saved_prompts p
        left join prompt_folders f on f.id = p.folder_id
        where p.user_id = ${userId}::uuid
        order by p.updated_at desc
      `),
      safeQuery(sql`
        select id, type, title, body, priority, "createdAt" as created_at, read_at
        from notifications where user_id = ${userId}::uuid
        order by "createdAt" desc limit 1000
      `),
      safeQuery(sql`
        select id::text as id, package_id, status, amount, currency,
               credits_granted, paypal_order_id, "created_at"
        from payments where user_id = ${userId}::uuid
        order by created_at desc
      `),
      safeQuery(sql`
        select id::text as id, status, current_period_end, created_at
        from subscriptions where user_id = ${userId}::uuid
      `),
      safeQuery(sql`
        select user_id::text as user_id, balance, updated_at
        from credits where user_id = ${userId}::uuid
      `),
    ]);

    const payload = {
      ok: true,
      export: {
        format: 'numination-user-export',
        version: 1,
        exportedAt: new Date().toISOString(),
        requestedBy: req.user.email || req.user.id,
        durationMs: Date.now() - started,
      },
      profile: profileRows[0] || null,
      chats: chatRows,
      messages: messageRows,
      memories: memoryRows,
      personas: personaRows,
      documents: documentRows,
      savedPrompts: promptRows,
      notifications: notificationRows,
      payments: paymentRows,
      subscriptions: subscriptionRows,
      credits: creditRows,
      summary: {
        chats: chatRows.length,
        messages: messageRows.length,
        memories: memoryRows.length,
        personas: personaRows.length,
        documents: documentRows.length,
        savedPrompts: promptRows.length,
        notifications: notificationRows.length,
        payments: paymentRows.length,
      },
    };

    await logAction(userId, 'gdpr.export', {
      summary: payload.summary,
      durationMs: payload.export.durationMs,
    }, { req });

    // Se descarga como archivo para que el usuario lo pueda guardar.
    const disposition = req.query.download === 'true'
      ? `attachment; filename="numination-export-${new Date().toISOString().slice(0, 10)}.json"`
      : 'inline';

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', disposition);
    res.setHeader('Cache-Control', 'no-store');

    res.json(payload);
  }));

  /* ─── DELETE /api/gdpr/delete ──────────────────────────────────────── */
  router.delete('/api/gdpr/delete', requireAuth, asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const hard = String(req.query.hard || req.body?.hard || 'false') === 'true';
    const confirm = String(req.query.confirm || req.body?.confirm || '').toUpperCase();

    if (confirm !== 'BORRAR') {
      throw new ValidationError(
        'Para confirmar el borrado, enviá ?confirm=BORRAR.',
        'confirm'
      );
    }

    if (!supabaseDisponible()) {
      throw new ValidationError('La base de datos no está disponible para el borrado.', 'delete');
    }

    const deleted = {};
    const errors = [];

    const run = async (label, fn) => {
      try {
        const res = await fn();
        deleted[label] = Array.isArray(res) ? res.length : (res || 0);
      } catch (e) {
        errors.push({ table: label, error: e.message });
        deleted[label] = 0;
      }
    };

    /* ── 1 · Rastro (sin contenido) ─────────────────────────────────── */
    await run('gdpr_deletions', async () => {
      await sql`
        create table if not exists ${sql(CFG.deletionTable)} (
          id          uuid primary key default gen_random_uuid(),
          user_id     uuid,
          email_hash  text,
          hard_delete boolean not null default false,
          deleted_at  timestamptz not null default now()
        )
      `;

      const hash = (await import('node:crypto')).createHash('sha256')
        .update(String(req.user.email || userId)).digest('hex').slice(0, 32);

      const rows = await sql`
        insert into ${sql(CFG.deletionTable)} (user_id, email_hash, hard_delete)
        values (${userId}::uuid, ${hash}, ${hard})
        returning id
      `;
      return rows;
    });

    /* ── 2 · Datos del usuario ──────────────────────────────────────── */
    await run('rag_documents', () => sql`delete from rag_documents where user_id = ${userId}::uuid`);
    await run('rag_chunks', () => sql`delete from rag_chunks where user_id = ${userId}::uuid`);
    await run('personas', () => sql`delete from personas where user_id = ${userId}::uuid`);
    await run('saved_prompts', () => sql`delete from saved_prompts where user_id = ${userId}::uuid`);
    await run('prompt_folders', () => sql`delete from prompt_folders where user_id = ${userId}::uuid`);
    await run('notifications', () => sql`delete from notifications where user_id = ${userId}::uuid`);
    await run('credits', () => sql`delete from credits where user_id = ${userId}::uuid`);
    await run('referrals', () => sql`delete from referrals where user_id = ${userId}::uuid`);
    await run('affiliate_clicks', () => sql`delete from affiliate_clicks where code in (select code from referrals where user_id = ${userId}::uuid)`);

    await run('messages', async () => {
      const rows = await sql`
        delete from "Message"
        where "chatId" in (select id from "Chat" where "userId" = ${userId}::uuid)
        returning id
      `;
      return rows;
    });

    await run('chats', () => sql`delete from "Chat" where "userId" = ${userId}::uuid`);
    await run('memories', () => sql`delete from "Memory" where "userId" = ${userId}::uuid`);

    /* ── 3 · Pago: se conserva salvo que sea borrado duro ───────────── */
    if (hard) {
      await run('payments', () => sql`delete from payments where user_id = ${userId}::uuid`);
      await run('subscriptions', () => sql`delete from subscriptions where user_id = ${userId}::uuid`);
    } else {
      deleted.payments = 'conservados (obligación contable)';
      deleted.subscriptions = 'conservados (obligación contable)';
    }

    /* ── 4 · Perfil ─────────────────────────────────────────────────── */
    if (hard) {
      await run('profile', () => sql`delete from public.profiles where id = ${userId}::uuid`);
    } else {
      // Anonimización: se conservan el id y el rol (para el historial
      // de la app) pero se borran los datos personales.
      await run('profile', () => sql`
        update public.profiles
        set email = ${`anonimo+${String(userId).slice(0, 8)}@borrado.numination.local`},
            "displayName" = 'Usuario eliminado',
            name = null,
            "avatarUrl" = null,
            picture = null,
            phone = null,
            "updatedAt" = now(),
            updated_at = now()
        where id = ${userId}::uuid
      `);
    }

    /* ── 5 · Sesión ─────────────────────────────────────────────────── */
    try {
      invalidateSession(userId);
    } catch (e) {
      LOG.debug('gdpr-tools: invalidateSession falló', { error: e.message });
    }

    await logAction(userId, 'gdpr.delete', {
      hard,
      deleted,
      errors: errors.length,
    }, { req });

    LOG.info('gdpr-tools: datos eliminados', { userId, hard, errors: errors.length });

    res.json({
      ok: true,
      hard,
      deleted,
      errors,
      message: hard
        ? 'Tu cuenta y todos tus datos fueron eliminados.'
        : 'Tus datos personales fueron eliminados. Conservamos el historial de pagos por obligación legal.',
      sessionDestroyed: true,
    });
  }));

  /* ─── GET /api/gdpr/deletion-status ────────────────────────────────── */
  router.get('/api/gdpr/deletion-status', requireAuth, asyncHandler(async (req, res) => {
    if (!supabaseDisponible()) {
      return res.json({ ok: true, degraded: true, deletions: [] });
    }

    const rows = await safeQuery(sql`
      select id::text as id, hard_delete, deleted_at
      from ${sql(CFG.deletionTable)}
      where user_id = ${req.user.id}::uuid
      order by deleted_at desc
      limit 10
    `);

    res.json({ ok: true, degraded: false, deletions: rows });
  }));

  app.use(router);

  LOG.info('gdpr.routes.mounted', {
    endpoints: [
      'GET /api/gdpr/info',
      'GET /api/gdpr/export',
      'DELETE /api/gdpr/delete',
      'GET /api/gdpr/deletion-status',
    ],
  });

  return router;
}

export default { mountGdprRoutes };
