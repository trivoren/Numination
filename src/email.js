/* ═══════════════════════════════════════════════════════════════════════════
   
                              E M A I L   ·   v 1 . 0
   
   ─────────────────────────────────────────────────────────────────────────
   Sistema completo de correo transaccional para Numination.
   
   TRANSPORTES SOPORTADOS (en orden de preferencia):
     1. Brevo API REST     → BREVO_API_KEY     (recomendado)
     2. Brevo SMTP         → BREVO_SMTP_*      (fallback, requiere nodemailer)
     3. Resend API         → RESEND_API_KEY    (alternativa)
     4. Consola (dev)      → si no hay ninguno, loguea el email
   
   CATEGORÍAS DE EMAIL:
     transactional  → reset, verify, welcome (siempre se envían)
     security       → alertas de login, cambios sensibles
     product        → novedades, features
     marketing      → promociones (respeta opt-out)
     digest         → resúmenes semanales
   
   TEMPLATES:
     - welcome
     - verify-email
     - password-reset
     - password-changed
     - login-from-new-device
     - account-deleted
     - weekly-digest
     - feedback-reply
   
   ENDPOINTS:
     POST   /api/email/test              → envía email de prueba
     POST   /api/email/send              → envía desde cualquier template (auth)
     GET    /api/email/stats             → estadísticas de envío
     GET    /api/email/log               → últimos envíos (auth)
     POST   /api/email/preferences       → guardar preferencias (auth)
     GET    /api/email/preferences       → leer preferencias (auth)
     POST   /api/email/webhook/brevo     → recibe eventos de Brevo
     GET    /api/email/preview/:template → preview de template en browser
   
   ─────────────────────────────────────────────────────────────────────────
   Álvaro & Robinson · Medellín · 2026
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

let TEST_KEYS = {};
try {
  const mod = await import('../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

const CFG = Object.freeze({
  /* Transporte activo (auto-detectado) */
  BREVO_API_KEY:    process.env.BREVO_API_KEY     ?? TEST_KEYS.BREVO_API_KEY    ?? null,
  BREVO_SMTP_HOST:  process.env.BREVO_SMTP_HOST   ?? TEST_KEYS.BREVO_SMTP_HOST  ?? 'smtp-relay.brevo.com',
  BREVO_SMTP_PORT:  Number(process.env.BREVO_SMTP_PORT ?? TEST_KEYS.BREVO_SMTP_PORT ?? 587),
  BREVO_SMTP_USER:  process.env.BREVO_SMTP_USER   ?? TEST_KEYS.BREVO_SMTP_USER  ?? null,
  BREVO_SMTP_PASS:  process.env.BREVO_SMTP_PASSWORD ?? TEST_KEYS.BREVO_SMTP_PASSWORD ?? null,
  RESEND_API_KEY:   process.env.RESEND_API_KEY    ?? TEST_KEYS.RESEND_API_KEY   ?? null,

  /* Remitente */
  FROM_EMAIL: process.env.BREVO_FROM_EMAIL ?? TEST_KEYS.BREVO_FROM_EMAIL ?? 'no-reply@numination.app',
  FROM_NAME:  process.env.BREVO_FROM_NAME  ?? TEST_KEYS.BREVO_FROM_NAME  ?? 'Numination',
  REPLY_TO:   process.env.REPLY_TO_EMAIL   ?? TEST_KEYS.REPLY_TO_EMAIL   ?? 'soporte@numination.app',

  /* Comportamiento */
  MAX_RETRIES: 3,
  RETRY_BASE_MS: 800,
  TIMEOUT_MS: 12_000,
  LOG_MAX: 200,
  RATE_WINDOW_MS: 60_000,
  RATE_MAX_PER_EMAIL: 5,
  RATE_MAX_GLOBAL: 100,

  /* URLs (para links dentro de emails) */
  APP_URL: process.env.APP_URL ?? 'http://localhost:8080',

  /* Sandbox: si está en true, no manda emails, solo loguea */
  SANDBOX: process.env.EMAIL_SANDBOX === '1',

  /* Logs */
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
});

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[CFG.LOG_LEVEL] || LEVELS.info;

/* ═══════════════════════════════════════════════════════════════════════════
   2 · LOGGING
   ═══════════════════════════════════════════════════════════════════════════ */

function log(level, event, meta = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const entry = { ts: new Date().toISOString(), lvl: level, event, mod: 'email', ...meta };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error('[mail]', line);
  else if (level === 'warn') console.warn('[mail]', line);
  else console.log('[mail]', line);
}

/* ═══════════════════════════════════════════════════════════════════════════
   3 · TRANSPORTE · detección automática
   ═══════════════════════════════════════════════════════════════════════════ */

const Transport = (() => {

  /* ─── BREVO API REST ─── */
  async function brevoApi({ to, toName, subject, html, text, headers }) {
    if (!CFG.BREVO_API_KEY) throw new Error('Brevo API no configurado');

    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': CFG.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: CFG.FROM_NAME, email: CFG.FROM_EMAIL },
        replyTo: { email: CFG.REPLY_TO },
        to: [{ email: to, name: toName || to.split('@')[0] }],
        subject,
        htmlContent: html,
        textContent: text,
        headers,
      }),
      signal: AbortSignal.timeout(CFG.TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Brevo API ${res.status}: ${errText.slice(0, 200)}`);
    }

    const data = await res.json().catch(() => ({}));
    return { ok: true, messageId: data.messageId, provider: 'brevo-api' };
  }

  /* ─── RESEND API ─── */
  async function resendApi({ to, toName, subject, html, text }) {
    if (!CFG.RESEND_API_KEY) throw new Error('Resend no configurado');

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CFG.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${CFG.FROM_NAME} <${CFG.FROM_EMAIL}>`,
        to: toName ? `${toName} <${to}>` : to,
        reply_to: CFG.REPLY_TO,
        subject,
        html,
        text,
      }),
      signal: AbortSignal.timeout(CFG.TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Resend ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, messageId: data.id, provider: 'resend' };
  }

  /* ─── BREVO SMTP (nodemailer lazy) ─── */
  let _nodemailer = null;
  let _transporter = null;

  async function getTransporter() {
    if (_transporter) return _transporter;
    if (!_nodemailer) {
      try {
        const mod = await import('nodemailer');
        _nodemailer = mod.default || mod;
      } catch {
        throw new Error('nodemailer no instalado (npm install nodemailer)');
      }
    }
    _transporter = _nodemailer.createTransport({
      host: CFG.BREVO_SMTP_HOST,
      port: CFG.BREVO_SMTP_PORT,
      secure: CFG.BREVO_SMTP_PORT === 465,
      auth: {
        user: CFG.BREVO_SMTP_USER,
        pass: CFG.BREVO_SMTP_PASS,
      },
      connectionTimeout: CFG.TIMEOUT_MS,
      greetingTimeout: CFG.TIMEOUT_MS,
      socketTimeout: CFG.TIMEOUT_MS,
    });
    return _transporter;
  }

  async function brevoSmtp({ to, toName, subject, html, text }) {
    if (!CFG.BREVO_SMTP_USER || !CFG.BREVO_SMTP_PASS) {
      throw new Error('Brevo SMTP no configurado');
    }
    const transporter = await getTransporter();
    const info = await transporter.sendMail({
      from: `"${CFG.FROM_NAME}" <${CFG.FROM_EMAIL}>`,
      to: toName ? `"${toName}" <${to}>` : to,
      replyTo: CFG.REPLY_TO,
      subject,
      html,
      text,
    });
    return { ok: true, messageId: info.messageId, provider: 'brevo-smtp' };
  }

  /* ─── DETECCIÓN ─── */
  function detect() {
    if (CFG.SANDBOX) return { name: 'sandbox', fn: null };
    if (CFG.BREVO_API_KEY) return { name: 'brevo-api', fn: brevoApi };
    if (CFG.BREVO_SMTP_USER && CFG.BREVO_SMTP_PASS) return { name: 'brevo-smtp', fn: brevoSmtp };
    if (CFG.RESEND_API_KEY) return { name: 'resend', fn: resendApi };
    return { name: 'console', fn: null };
  }

  const current = detect();

  return {
    name: current.name,
    enabled: current.name !== 'console' && current.name !== 'sandbox',
    async send(payload) {
      if (current.name === 'sandbox') {
        log('info', 'email.sandbox', { to: payload.to, subject: payload.subject });
        return { ok: true, sandbox: true, provider: 'sandbox' };
      }
      if (current.name === 'console' || !current.fn) {
        console.log('═══════════════════════════════════════════════════');
        console.log('[mail] EMAIL (dev · sin transporte)');
        console.log('Para:  ', payload.to);
        console.log('Asunto:', payload.subject);
        const urlMatch = payload.html.match(/href="([^"]+)"/);
        if (urlMatch) console.log('Link:  ', urlMatch[1]);
        console.log('═══════════════════════════════════════════════════');
        return { ok: true, dev: true, provider: 'console' };
      }
      return current.fn(payload);
    },
  };
})();

/* ═══════════════════════════════════════════════════════════════════════════
   4 · BASE HTML · layout compartido por todos los templates
   ═══════════════════════════════════════════════════════════════════════════ */

function baseLayout({ title, preheader, content, cta, ctaUrl, footerNote }) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<title>${title}</title>
<style>
  @media only screen and (max-width:600px){
    .wrap{padding:24px 16px !important}
    .card{padding:32px 24px !important;border-radius:20px !important}
    .h1{font-size:24px !important}
    .cta{padding:14px 24px !important;font-size:15px !important}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f0f0f2;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<div style="display:none;font-size:1px;color:#f0f0f2;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${preheader || ''}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f0f0f2;padding:40px 24px;">
<tr><td align="center">
<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background:#ffffff;border-radius:24px;border:1px solid #e4e4e7;padding:40px 36px;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
  <tr><td align="center" style="padding-bottom:28px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="background:#7c5eff;width:48px;height:48px;border-radius:14px;text-align:center;vertical-align:middle;">
          <span style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:-0.04em;line-height:48px;">N</span>
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td>
    <h1 class="h1" style="margin:0 0 16px;font-size:26px;font-weight:800;letter-spacing:-0.03em;line-height:1.2;color:#0a0a0c;text-align:center;">${title}</h1>
    <div style="font-size:15px;line-height:1.65;color:#3a3a40;letter-spacing:-0.005em;text-align:left;">${content}</div>
    ${cta ? `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:32px auto 0;">
      <tr><td align="center">
        <a href="${ctaUrl}" class="cta" style="display:inline-block;background:#7c5eff;color:#ffffff;text-decoration:none;font-size:15.5px;font-weight:600;letter-spacing:-0.012em;padding:16px 32px;border-radius:999px;">${cta}</a>
      </td></tr>
    </table>` : ''}
    ${ctaUrl ? `<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#a0a0a3;word-break:break-all;text-align:center;">${ctaUrl}</p>` : ''}
  </td></tr>
  <tr><td style="padding-top:32px;border-top:1px solid #ececef;margin-top:32px;">
    <p style="margin:0;font-size:13px;line-height:1.6;color:#6b6b70;text-align:center;letter-spacing:-0.005em;">${footerNote || 'Numination · La IA que habla el idioma de nuestra educación'}</p>
    <p style="margin:8px 0 0;font-size:12px;line-height:1.5;color:#a0a0a3;text-align:center;">
      <a href="${CFG.APP_URL}" style="color:#a0a0a3;text-decoration:underline;">numination.app</a>
      · <a href="${CFG.APP_URL}/terminos" style="color:#a0a0a3;text-decoration:underline;">Términos</a>
      · <a href="${CFG.APP_URL}/privacidad" style="color:#a0a0a3;text-decoration:underline;">Privacidad</a>
    </p>
  </td></tr>
</table>
</div>
</td></tr>
</table>
</body>
</html>`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   5 · TEMPLATES
   ═══════════════════════════════════════════════════════════════════════════ */

const Templates = {

  /* ─── WELCOME ─── */
  welcome({ name = '', email = '' }) {
    const saludo = name ? `Hola <strong>${name}</strong>,` : 'Hola,';
    return {
      subject: '¡Bienvenido a Numination!',
      html: baseLayout({
        title: '¡Bienvenido!',
        preheader: 'Tu cuenta está lista. Empecemos.',
        content: `
          <p style="margin:0 0 16px;">${saludo}</p>
          <p style="margin:0 0 16px;">Tu cuenta de Numination está lista. Ya podés preguntarle lo que quieras, en tus palabras.</p>
          <p style="margin:0 0 16px;">Algunas cosas que podés hacer desde el primer minuto:</p>
          <ul style="margin:0 0 16px;padding-left:22px;">
            <li style="margin:0 0 8px;">Preguntar tareas y entender los pasos</li>
            <li style="margin:0 0 8px;">Practicar con quizzes generados al instante</li>
            <li style="margin:0 0 8px;">Guardar memorias para que te conozca mejor</li>
            <li style="margin:0 0 8px;">Usar el modo incógnito cuando quieras privacidad</li>
          </ul>
          <p style="margin:0;">Cualquier duda, respondé este correo y te contestamos.</p>
        `,
        cta: 'Empezar ahora',
        ctaUrl: `${CFG.APP_URL}/chat`,
      }),
      text: `¡Bienvenido a Numination!\n\nTu cuenta (${email}) está lista. Empezá en ${CFG.APP_URL}/chat\n\n— El equipo de Numination`,
    };
  },

  /* ─── VERIFY EMAIL ─── */
  verifyEmail({ name = '', url = '' }) {
    const saludo = name ? `Hola <strong>${name}</strong>,` : 'Hola,';
    return {
      subject: 'Verificá tu correo · Numination',
      html: baseLayout({
        title: 'Verificá tu correo',
        preheader: 'Un clic y listo.',
        content: `
          <p style="margin:0 0 16px;">${saludo}</p>
          <p style="margin:0 0 16px;">Confirmá tu correo para activar todas las funciones de Numination. El link expira en <strong>15 minutos</strong>.</p>
          <p style="margin:0;">Si no creaste esta cuenta, ignorá este correo.</p>
        `,
        cta: 'Verificar correo',
        ctaUrl: url,
      }),
      text: `Verificá tu correo: ${url}\n\nExpira en 15 minutos.`,
    };
  },

  /* ─── PASSWORD RESET ─── */
  passwordReset({ name = '', url = '' }) {
    const saludo = name ? `Hola <strong>${name}</strong>,` : 'Hola,';
    return {
      subject: 'Recuperá tu contraseña · Numination',
      html: baseLayout({
        title: 'Recuperar contraseña',
        preheader: 'El link expira en 1 hora.',
        content: `
          <p style="margin:0 0 16px;">${saludo}</p>
          <p style="margin:0 0 16px;">Recibimos una solicitud para cambiar tu contraseña de Numination. El link expira en <strong>1 hora</strong>.</p>
          <p style="margin:0;">Si no pediste este cambio, ignorá este correo. Tu cuenta sigue segura.</p>
        `,
        cta: 'Cambiar contraseña',
        ctaUrl: url,
      }),
      text: `Recuperar contraseña: ${url}\n\nExpira en 1 hora.`,
    };
  },

  /* ─── PASSWORD CHANGED ─── */
  passwordChanged({ name = '', when = '', ip = '' }) {
    const saludo = name ? `Hola <strong>${name}</strong>,` : 'Hola,';
    const fecha = when ? new Date(when).toLocaleString('es-CO') : 'hace unos instantes';
    return {
      subject: 'Tu contraseña fue cambiada',
      html: baseLayout({
        title: 'Contraseña actualizada',
        preheader: 'Confirma que fuiste vos.',
        content: `
          <p style="margin:0 0 16px;">${saludo}</p>
          <p style="margin:0 0 16px;">Tu contraseña de Numination se cambió <strong>${fecha}</strong>${ip ? ` desde la IP <code style="background:#f0f0f2;padding:2px 6px;border-radius:4px;font-size:13px;">${ip}</code>` : ''}.</p>
          <p style="margin:0 0 16px;">Si fuiste vos, ignorá este correo.</p>
          <p style="margin:0;color:#dc2626;"><strong>Si NO fuiste vos</strong>, cambiá tu contraseña inmediatamente y escribinos a <a href="mailto:seguridad@numination.app">seguridad@numination.app</a>.</p>
        `,
        cta: 'Ver mi cuenta',
        ctaUrl: `${CFG.APP_URL}/login`,
      }),
      text: `Tu contraseña se cambió ${fecha}. Si no fuiste vos, escribí a seguridad@numination.app`,
    };
  },

  /* ─── LOGIN NEW DEVICE ─── */
  loginNewDevice({ name = '', when = '', ip = '', agent = '' }) {
    const saludo = name ? `Hola <strong>${name}</strong>,` : 'Hola,';
    const fecha = when ? new Date(when).toLocaleString('es-CO') : 'hace unos instantes';
    const ua = agent ? agent.slice(0, 120) : 'Dispositivo desconocido';
    return {
      subject: 'Nuevo inicio de sesión en tu cuenta',
      html: baseLayout({
        title: 'Nuevo inicio de sesión',
        preheader: 'Detectamos actividad nueva.',
        content: `
          <p style="margin:0 0 16px;">${saludo}</p>
          <p style="margin:0 0 16px;">Detectamos un nuevo inicio de sesión en tu cuenta:</p>
          <ul style="margin:0 0 16px;padding-left:22px;">
            <li style="margin:0 0 6px;"><strong>Fecha:</strong> ${fecha}</li>
            ${ip ? `<li style="margin:0 0 6px;"><strong>IP:</strong> ${ip}</li>` : ''}
            ${ua ? `<li style="margin:0 0 6px;"><strong>Dispositivo:</strong> ${ua}</li>` : ''}
          </ul>
          <p style="margin:0;">Si fuiste vos, no hagas nada. Si no reconocés esta actividad, cambiá tu contraseña ya mismo.</p>
        `,
        cta: 'Revisar seguridad',
        ctaUrl: `${CFG.APP_URL}/reset-password`,
      }),
      text: `Nuevo inicio de sesión: ${fecha}${ip ? ` desde ${ip}` : ''}`,
    };
  },

  /* ─── ACCOUNT DELETED ─── */
  accountDeleted({ email = '' }) {
    return {
      subject: 'Tu cuenta de Numination fue eliminada',
      html: baseLayout({
        title: 'Cuenta eliminada',
        preheader: 'Lamentamos verte partir.',
        content: `
          <p style="margin:0 0 16px;">Tu cuenta <strong>${email}</strong> fue eliminada correctamente.</p>
          <p style="margin:0 0 16px;">Todos tus chats, memorias y datos asociados fueron borrados de forma permanente. Esto no se puede deshacer.</p>
          <p style="margin:0;">Gracias por haber formado parte de Numination. Si querés volver, siempre podés crear una cuenta nueva.</p>
        `,
      }),
      text: `Tu cuenta ${email} fue eliminada. Gracias por haber estado.`,
    };
  },

  /* ─── WEEKLY DIGEST ─── */
  weeklyDigest({ name = '', stats = {} }) {
    const saludo = name ? `Hola <strong>${name}</strong>,` : 'Hola,';
    const chats = stats.chats || 0;
    const mensajes = stats.mensajes || 0;
    const memorias = stats.memorias || 0;
    return {
      subject: 'Tu semana en Numination',
      html: baseLayout({
        title: 'Tu semana en Numination',
        preheader: `${chats} chats · ${mensajes} mensajes · ${memorias} memorias`,
        content: `
          <p style="margin:0 0 16px;">${saludo}</p>
          <p style="margin:0 0 16px;">Este es tu resumen de la semana:</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;margin:0 0 16px;background:#f7f7f8;border-radius:14px;padding:20px;">
            <tr>
              <td align="center" style="padding:0 8px;">
                <div style="font-size:24px;font-weight:800;color:#0a0a0c;letter-spacing:-0.03em;">${chats}</div>
                <div style="font-size:12px;color:#6b6b70;margin-top:4px;">chats</div>
              </td>
              <td align="center" style="padding:0 8px;">
                <div style="font-size:24px;font-weight:800;color:#0a0a0c;letter-spacing:-0.03em;">${mensajes}</div>
                <div style="font-size:12px;color:#6b6b70;margin-top:4px;">mensajes</div>
              </td>
              <td align="center" style="padding:0 8px;">
                <div style="font-size:24px;font-weight:800;color:#0a0a0c;letter-spacing:-0.03em;">${memorias}</div>
                <div style="font-size:12px;color:#6b6b70;margin-top:4px;">memorias</div>
              </td>
            </tr>
          </table>
          <p style="margin:0;">Seguí así, cada pregunta te acerca a entender algo nuevo.</p>
        `,
        cta: 'Seguir aprendiendo',
        ctaUrl: `${CFG.APP_URL}/chat`,
      }),
      text: `Tu semana: ${chats} chats · ${mensajes} mensajes · ${memorias} memorias\n\nEntrá: ${CFG.APP_URL}/chat`,
    };
  },

  /* ─── FEEDBACK REPLY ─── */
  feedbackReply({ name = '', originalMessage = '', replyText = '' }) {
    const saludo = name ? `Hola <strong>${name}</strong>,` : 'Hola,';
    return {
      subject: 'Gracias por escribirnos · Numination',
      html: baseLayout({
        title: 'Gracias por escribirnos',
        preheader: 'Leímos tu mensaje.',
        content: `
          <p style="margin:0 0 16px;">${saludo}</p>
          <p style="margin:0 0 16px;">Gracias por tomarte el tiempo de escribirnos. Leímos tu mensaje con atención.</p>
          ${originalMessage ? `<div style="margin:0 0 16px;padding:14px 18px;background:#f7f7f8;border-left:3px solid #a0a0a3;border-radius:8px;font-size:14px;color:#6b6b70;font-style:italic;">"${originalMessage}"</div>` : ''}
          ${replyText ? `<div style="margin:0 0 16px;padding:16px 20px;background:#f2ecff;border-left:3px solid #7c5eff;border-radius:12px;">${replyText}</div>` : ''}
          <p style="margin:0;">Cualquier otra cosa, respondé este correo directamente.</p>
        `,
      }),
      text: replyText || 'Gracias por escribirnos.',
    };
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   6 · RATE LIMITING
   ═══════════════════════════════════════════════════════════════════════════ */

const rateBuckets = new Map();
let globalCount = 0;
let globalResetAt = Date.now() + CFG.RATE_WINDOW_MS;

function checkRate(email) {
  const now = Date.now();

  // Ventana global
  if (now > globalResetAt) {
    globalCount = 0;
    globalResetAt = now + CFG.RATE_WINDOW_MS;
  }
  if (globalCount >= CFG.RATE_MAX_GLOBAL) {
    return { ok: false, reason: 'global', retryAfter: Math.ceil((globalResetAt - now) / 1000) };
  }

  // Por destinatario
  let b = rateBuckets.get(email);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + CFG.RATE_WINDOW_MS };
    rateBuckets.set(email, b);
  }
  if (b.count >= CFG.RATE_MAX_PER_EMAIL) {
    return { ok: false, reason: 'destinatario', retryAfter: Math.ceil((b.resetAt - now) / 1000) };
  }

  b.count++;
  globalCount++;
  return { ok: true };
}

const _cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
}, 60_000);
if (_cleanupTimer.unref) _cleanupTimer.unref();

/* ═══════════════════════════════════════════════════════════════════════════
   7 · LOG DE ENVÍOS
   ═══════════════════════════════════════════════════════════════════════════ */

const sendLog = [];

function recordSend(entry) {
  sendLog.unshift({
    id: crypto.randomBytes(8).toString('hex'),
    ts: new Date().toISOString(),
    ...entry,
  });
  if (sendLog.length > CFG.LOG_MAX) sendLog.length = CFG.LOG_MAX;
}

/* ═══════════════════════════════════════════════════════════════════════════
   8 · PREFERENCIAS DE USUARIO (en memoria · TODO: mover a Supabase)
   ═══════════════════════════════════════════════════════════════════════════ */

const prefs = new Map();

function getPrefs(userId) {
  if (!prefs.has(userId)) {
    prefs.set(userId, {
      transactional: true,   // siempre true (no se puede desactivar)
      security: true,
      product: true,
      marketing: false,
      digest: true,
    });
  }
  return prefs.get(userId);
}

function shouldSend(userId, category) {
  if (category === 'transactional' || category === 'security') return true;
  const p = getPrefs(userId);
  return p[category] !== false;
}

/* ═══════════════════════════════════════════════════════════════════════════
   9 · API PÚBLICA · send()
   ═══════════════════════════════════════════════════════════════════════════ */

async function send({ to, toName, template, data, subject, category = 'transactional', userId }) {
  const t0 = Date.now();

  /* Validación */
  if (!to || typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    throw new Error('Email destinatario inválido');
  }
  if (!template || !Templates[template]) {
    throw new Error(`Template "${template}" no existe`);
  }

  /* Preferencias */
  if (userId && !shouldSend(userId, category)) {
    recordSend({ to, template, category, status: 'skipped', reason: 'user_optout' });
    return { ok: true, skipped: true, reason: 'user_optout' };
  }

  /* Rate limit */
  const rate = checkRate(to);
  if (!rate.ok) {
    recordSend({ to, template, category, status: 'rate_limited', reason: rate.reason });
    throw new Error(`Rate limit (${rate.reason}). Esperá ${rate.retryAfter}s.`);
  }

  /* Render */
  const rendered = Templates[template](data || {});
  const finalSubject = subject || rendered.subject;

  /* Envío con reintentos */
  let lastErr = null;
  for (let i = 0; i < CFG.MAX_RETRIES; i++) {
    try {
      const result = await Transport.send({
        to,
        toName: toName || (data && data.name) || '',
        subject: finalSubject,
        html: rendered.html,
        text: rendered.text,
      });
      const dur = Date.now() - t0;
      log('info', 'email.sent', { to, template, category, ms: dur, provider: result.provider });
      recordSend({ to, template, category, status: 'sent', provider: result.provider, messageId: result.messageId, ms: dur });
      return { ok: true, messageId: result.messageId, provider: result.provider, ms: dur };
    } catch (err) {
      lastErr = err;
      log('warn', 'email.retry', { to, template, attempt: i + 1, error: err.message });
      if (i < CFG.MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, CFG.RETRY_BASE_MS * Math.pow(2, i)));
      }
    }
  }

  const dur = Date.now() - t0;
  log('error', 'email.failed', { to, template, ms: dur, error: lastErr?.message });
  recordSend({ to, template, category, status: 'failed', error: lastErr?.message, ms: dur });
  throw lastErr || new Error('Envío falló');
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · MOUNT · rutas
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountEmailRoutes(app, requireAuth) {

  /* ─── GET /api/email/status · estado del transporte ─── */
  app.get('/api/email/status', (_req, res) => {
    return res.json({
      ok: true,
      transport: Transport.name,
      enabled: Transport.enabled,
      sandbox: CFG.SANDBOX,
      from: { email: CFG.FROM_EMAIL, name: CFG.FROM_NAME },
      replyTo: CFG.REPLY_TO,
      templates: Object.keys(Templates),
      rates: {
        perEmail: CFG.RATE_MAX_PER_EMAIL,
        global: CFG.RATE_MAX_GLOBAL,
        windowMs: CFG.RATE_WINDOW_MS,
      },
    });
  });

  /* ─── POST /api/email/test · envía email de prueba ─── */
  app.post('/api/email/test', requireAuth, async (req, res) => {
    try {
      const { to, template = 'welcome' } = req.body || {};
      const target = to || req.user.email;

      if (!Templates[template]) {
        return res.status(400).json({ ok: false, error: `Template "${template}" no existe.` });
      }

      const result = await send({
        to: target,
        toName: req.user.name || '',
        template,
        data: {
          name: req.user.name || '',
          email: target,
          url: `${CFG.APP_URL}/chat`,
          when: new Date().toISOString(),
          ip: req.ip,
          agent: req.get('user-agent'),
          stats: { chats: 5, mensajes: 42, memorias: 3 },
        },
        category: 'transactional',
      });

      return res.json({ ok: true, ...result });
    } catch (e) {
      log('error', 'email.test.fail', { error: e.message });
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ─── POST /api/email/send · envía desde cualquier template ─── */
  app.post('/api/email/send', requireAuth, async (req, res) => {
    try {
      const { to, toName, template, data, subject, category } = req.body || {};
      if (!to || !template) {
        return res.status(400).json({ ok: false, error: 'Falta to o template.' });
      }
      const result = await send({
        to,
        toName,
        template,
        data,
        subject,
        category: category || 'transactional',
        userId: req.user.id,
      });
      return res.json({ ok: true, ...result });
    } catch (e) {
      log('error', 'email.send.fail', { error: e.message });
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ─── GET /api/email/stats · estadísticas de envíos ─── */
  app.get('/api/email/stats', requireAuth, (_req, res) => {
    const total = sendLog.length;
    const sent = sendLog.filter(e => e.status === 'sent').length;
    const failed = sendLog.filter(e => e.status === 'failed').length;
    const skipped = sendLog.filter(e => e.status === 'skipped').length;
    const rateLimited = sendLog.filter(e => e.status === 'rate_limited').length;

    const byTemplate = {};
    const byProvider = {};
    for (const e of sendLog) {
      byTemplate[e.template] = (byTemplate[e.template] || 0) + 1;
      if (e.provider) byProvider[e.provider] = (byProvider[e.provider] || 0) + 1;
    }

    const successRate = total > 0 ? Math.round((sent / total) * 100) : 0;
    const avgMs = sent > 0
      ? Math.round(sendLog.filter(e => e.status === 'sent').reduce((a, e) => a + (e.ms || 0), 0) / sent)
      : 0;

    return res.json({
      ok: true,
      transport: Transport.name,
      total,
      sent,
      failed,
      skipped,
      rateLimited,
      successRate,
      avgMs,
      byTemplate,
      byProvider,
    });
  });

  /* ─── GET /api/email/log · últimos envíos ─── */
  app.get('/api/email/log', requireAuth, (req, res) => {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    return res.json({ ok: true, count: Math.min(limit, sendLog.length), log: sendLog.slice(0, limit) });
  });

  /* ─── GET /api/email/preferences · leer preferencias ─── */
  app.get('/api/email/preferences', requireAuth, (req, res) => {
    return res.json({ ok: true, preferences: getPrefs(req.user.id) });
  });

  /* ─── POST /api/email/preferences · guardar preferencias ─── */
  app.post('/api/email/preferences', requireAuth, (req, res) => {
    const body = req.body || {};
    const allowed = ['product', 'marketing', 'digest'];
    const current = getPrefs(req.user.id);
    const updated = { ...current };
    for (const k of allowed) {
      if (typeof body[k] === 'boolean') updated[k] = body[k];
    }
    prefs.set(req.user.id, updated);
    return res.json({ ok: true, preferences: updated });
  });

  /* ─── GET /api/email/preview/:template · preview HTML ─── */
  app.get('/api/email/preview/:template', (req, res) => {
    const { template } = req.params;
    if (!Templates[template]) {
      return res.status(404).send('Template no encontrado');
    }
    const sampleData = {
      name: 'Robinson',
      email: 'robinson@ejemplo.com',
      url: `${CFG.APP_URL}/reset-password?token=demo-token`,
      when: new Date().toISOString(),
      ip: '190.25.14.88',
      agent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      originalMessage: 'Excelente, la app va muy bien.',
      replyText: 'Gracias por escribirnos. Estamos trabajando en eso.',
      stats: { chats: 12, mensajes: 89, memorias: 7 },
    };
    const rendered = Templates[template](sampleData);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(rendered.html);
  });

  /* ─── POST /api/email/webhook/brevo · eventos de Brevo ─── */
  app.post('/api/email/webhook/brevo', (req, res) => {
    try {
      const body = req.body || {};
      const event = body.event || 'unknown';

      log('info', 'email.webhook', {
        event,
        email: body.email,
        messageId: body['message-id'],
        ts: body.ts,
      });

      switch (event) {
        case 'delivered':
          recordSend({ to: body.email, status: 'delivered', messageId: body['message-id'] });
          break;
        case 'opened':
          recordSend({ to: body.email, status: 'opened', messageId: body['message-id'] });
          break;
        case 'click':
          recordSend({ to: body.email, status: 'clicked', messageId: body['message-id'], url: body.link });
          break;
        case 'bounced':
          recordSend({ to: body.email, status: 'bounced', messageId: body['message-id'], reason: body.reason });
          break;
        case 'spam':
          recordSend({ to: body.email, status: 'spam', messageId: body['message-id'] });
          break;
        case 'unsubscribed':
          log('warn', 'email.unsubscribed', { email: body.email });
          break;
        default:
          log('debug', 'email.webhook.unknown', { event });
      }

      return res.json({ ok: true });
    } catch (e) {
      log('error', 'email.webhook.fail', { error: e.message });
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ─── BOOT ─── */
  const mode = Transport.enabled
    ? Transport.name
    : (CFG.SANDBOX ? 'sandbox' : 'console (dev)');
  console.log(`[mail] rutas montadas · transporte: ${mode} · ${Object.keys(Templates).length} templates`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   11 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export {
  send as sendEmail,
  Templates,
  Transport,
  getPrefs as getEmailPreferences,
};