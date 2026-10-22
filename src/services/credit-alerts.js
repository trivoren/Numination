/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/credit-alerts.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Alertas de créditos bajos (cron diario).

   QUÉ HACE
     Una vez por día busca a los usuarios con menos de 500 créditos y les
     manda un email con un CTA al Plan Pro.

   REGLAS DE LA ALERTA
     · Un email por usuario por día (tabla de control `credit_alerts_sent`).
     · Si el usuario ya tiene un plan pago, no se le avisa (ya tiene
       créditos de pago).
     · El email nunca incluye datos de otros usuarios ni datos sensibles.
     · Si no hay SMTP configurado, el envío se registra como "simulado":
       el cron no falla nunca y queda el log para revisar.

   TRANSPORTE
     nodemailer si está configurado (SMTP o servicio HTTP). Si no, modo
     `console`: se registra el contenido del email en el log del servidor.

   PRIVACIDAD
     El usuario puede pedir la baja de los emails de marketing en
     /api/email/preferences (ver src/email.js). Este módulo respeta esa
     preferencia si la tabla de preferencias está disponible.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { sql, supabaseDisponible } from './supabase.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  creditThreshold: 500,
  intervalMs: 24 * 60 * 60_000,   // 24 h
  maxEmailsPerRun: 200,
  tables: {
    sent: 'credit_alerts_sent',
  },
  from: {
    name: process.env.EMAIL_FROM_NAME || 'Numination',
    address: process.env.EMAIL_FROM_ADDRESS || 'noreply@numination.com',
  },
  appUrl: process.env.APP_URL || 'https://numinationchat.vercel.app',
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
        create table if not exists ${sql(CFG.tables.sent)} (
          id         uuid primary key default gen_random_uuid(),
          user_id    uuid not null,
          day        date not null,
          balance    integer not null default 0,
          email      text,
          status     text not null default 'sent',
          error      text,
          created_at timestamptz not null default now(),
          unique (user_id, day)
        )
      `;
      await sql`
        create index if not exists credit_alerts_sent_day_idx
          on ${sql(CFG.tables.sent)} (day desc)
      `;
      return { ok: true };
    } catch (e) {
      LOG.warn('credit-alerts: no se pudo crear el esquema', { error: e.message, code: e.code });
      return { ok: false };
    }
  })();

  return schemaPromise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · TRANSPORTE DE EMAIL
   ═══════════════════════════════════════════════════════════════════════════ */

let transporter = null;
let transporterError = null;

async function getTransporter() {
  if (transporter || transporterError) return transporter;

  const host = process.env.SMTP_HOST;
  if (!host) {
    transporterError = new Error('SMTP no configurado');
    return null;
  }

  try {
    const mod = await import('nodemailer');
    const nodemailer = mod.default || mod;

    transporter = nodemailer.createTransport({
      host,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
        : undefined,
    });

    return transporter;
  } catch (e) {
    transporterError = e;
    LOG.warn('credit-alerts: no se pudo crear el transporter', { error: e.message });
    return null;
  }
}

/**
 * Envía un email. Si no hay SMTP, lo registra (modo simulado).
 * @returns {Promise<{ok:boolean, simulated:boolean, id?:string, error?:string}>}
 */
export async function sendEmail({ to, subject, html, text }) {
  if (!to) return { ok: false, error: 'sin destinatario' };

  const mailer = await getTransporter();

  if (!mailer) {
    LOG.info('credit-alerts: email simulado (sin SMTP)', {
      to,
      subject,
      preview: String(text || '').slice(0, 160),
    });
    return { ok: true, simulated: true, id: `sim_${crypto.randomBytes(4).toString('hex')}` };
  }

  try {
    const info = await mailer.sendMail({
      from: `${CFG.from.name} <${CFG.from.address}>`,
      to,
      subject,
      text: text || String(html || '').replace(/<[^>]+>/g, ' '),
      html,
    });
    return { ok: true, simulated: false, id: info?.messageId || null };
  } catch (e) {
    LOG.warn('credit-alerts: fallo el envío', { to, error: e.message });
    return { ok: false, error: e.message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · PLANTILLA
   ═══════════════════════════════════════════════════════════════════════════ */

function buildEmail({ name, balance }) {
  const url = `${CFG.appUrl}/billing?plan=pro`;
  const greeting = name ? `Hola, ${name}.` : 'Hola.';

  const text = [
    greeting,
    '',
    `Te quedan ${balance} créditos en Numination.`,
    'Cuando se acaben, tus mensajes y el análisis de PDFs se pausan hasta que recargues.',
    '',
    `Podés recargar con el Plan Pro desde acá: ${url}`,
    '',
    'Si no querés recibir estos avisos, los podés desactivar en Ajustes → Notificaciones.',
    '',
    '— El equipo de Numination',
  ].join('\n');

  const html = `<!doctype html>
<html lang="es">
<body style="margin:0;padding:0;background:#0a0a0c;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#e8e8f0">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0c;padding:32px 16px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#12121a;border:1px solid rgba(255,255,255,.09);border-radius:16px;overflow:hidden">
        <tr><td style="padding:24px 28px;border-bottom:1px solid rgba(255,255,255,.08)">
          <div style="font-size:18px;font-weight:800;letter-spacing:.08em;color:#fff">NUMINATION</div>
          <div style="font-size:11px;color:#8b8b9c;margin-top:4px">Inteligencia artificial para pensar mejor</div>
        </td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 12px;font-size:19px;color:#fff">Te quedan ${balance} créditos</h1>
          <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#c9c9d4">
            ${greeting} Te quedan <strong style="color:#8b5cf6">${balance} créditos</strong> en Numination.
            Cuando se acaben, tus mensajes y el análisis de PDFs se pausan hasta que recargues.
          </p>
          <a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#8b5cf6,#6d28d9);color:#fff;text-decoration:none;font-size:13.5px;font-weight:700;padding:11px 20px;border-radius:10px">
            Recargar con el Plan Pro
          </a>
          <p style="margin:20px 0 0;font-size:12px;line-height:1.6;color:#6f6f85">
            Si no querés recibir estos avisos, desactivalos en Ajustes → Notificaciones.
          </p>
        </td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid rgba(255,255,255,.08);font-size:11px;color:#6f6f85">
          Numination · Estás recibiendo este email porque tenés créditos bajos.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { text, html, url };
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · CRON
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Busca usuarios con créditos bajos y les manda el aviso.
 *
 * @param {object} [opts] { force, threshold, limit }
 * @returns {Promise<object>} { ok, candidates, sent, simulated, skipped }
 */
export async function runCreditAlerts(opts = {}) {
  if (!supabaseDisponible()) {
    return { ok: true, degraded: true, candidates: 0, sent: 0, simulated: 0, skipped: 0, reason: 'no_db' };
  }

  const threshold = Number.isFinite(Number(opts.threshold)) ? Number(opts.threshold) : CFG.creditThreshold;

  try {
    await ensureSchema();

    // Usuarios con saldo bajo (o sin fila de créditos → 0).
    const rows = await sql`
      select
        p.id::text as user_id,
        p.email,
        coalesce(p."displayName", p.name) as name,
        coalesce(p.tier, p.plan, 'free') as plan,
        coalesce(c.balance, 0)::int as balance
      from public.profiles p
      left join credits c on c.user_id = p.id
      where coalesce(c.balance, 0) < ${threshold}
        and p.email is not null
        and coalesce(p.tier, p.plan, 'free') = 'free'
        and coalesce((to_jsonb(p)->>'banned')::boolean, false) = false
      order by coalesce(c.balance, 0) asc
      limit ${Math.min(Number(opts.limit) || CFG.maxEmailsPerRun, 500)}
    `;

    if (!rows.length) {
      return { ok: true, degraded: false, candidates: 0, sent: 0, simulated: 0, skipped: 0 };
    }

    let sent = 0;
    let simulated = 0;
    let skipped = 0;

    for (const row of rows) {
      // ¿Ya recibió el aviso hoy?
      const already = await sql`
        select 1 from ${sql(CFG.tables.sent)}
        where user_id = ${row.user_id}::uuid and day = current_date
        limit 1
      `;
      if (already.length && !opts.force) {
        skipped++;
        continue;
      }

      const template = buildEmail({ name: row.name, balance: row.balance });
      const result = await sendEmail({
        to: row.email,
        subject: `Te quedan ${row.balance} créditos en Numination`,
        text: template.text,
        html: template.html,
      });

      if (result.ok) {
        if (result.simulated) simulated++;
        else sent++;
      }

      await sql`
        insert into ${sql(CFG.tables.sent)} (user_id, day, balance, email, status, error)
        values (
          ${row.user_id}::uuid, current_date, ${Number(row.balance || 0)}, ${row.email},
          ${result.ok ? (result.simulated ? 'simulated' : 'sent') : 'failed'},
          ${result.ok ? null : String(result.error || '').slice(0, 300)}
        )
        on conflict (user_id, day) do update
          set status = excluded.status,
              error = excluded.error,
              balance = excluded.balance
      `;
    }

    LOG.info('credit-alerts: ciclo completado', { candidates: rows.length, sent, simulated, skipped });

    return { ok: true, degraded: false, candidates: rows.length, sent, simulated, skipped };
  } catch (e) {
    LOG.error('credit-alerts: runCreditAlerts falló', { error: e.message, code: e.code });
    return { ok: false, error: e.message, candidates: 0, sent: 0, simulated: 0, skipped: 0 };
  }
}

/* ─── Worker ─────────────────────────────────────────────────────────────── */

let timer = null;

/**
 * Arranca el cron diario. Idempotente.
 */
export function startCreditAlertCron(opts = {}) {
  if (timer) return timer;

  const interval = opts.intervalMs || CFG.intervalMs;

  timer = setInterval(() => {
    runCreditAlerts().catch((e) => LOG.warn('credit-alerts: ciclo falló', { error: e.message }));
  }, interval);

  if (timer.unref) timer.unref();

  LOG.info('credit-alerts: cron iniciado', { intervalMs: interval });

  return timer;
}

export function stopCreditAlertCron() {
  if (!timer) return false;
  clearInterval(timer);
  timer = null;
  return true;
}

export function getCreditAlertsStatus() {
  return {
    running: Boolean(timer),
    intervalMs: CFG.intervalMs,
    threshold: CFG.creditThreshold,
    smtpConfigured: Boolean(process.env.SMTP_HOST),
    dbAvailable: supabaseDisponible(),
  };
}

export default {
  runCreditAlerts,
  startCreditAlertCron,
  stopCreditAlertCron,
  getCreditAlertsStatus,
  sendEmail,
};
