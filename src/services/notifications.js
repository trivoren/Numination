/* ================================================================
   NUMINATION · notifications.js · v1.0
   ----------------------------------------------------------------
   Sistema de notificaciones multicanal para Numi OT.

   ¿POR QUÉ EXISTE?
   Los usuarios necesitan saber cuándo:
     · Alguien cambió su contraseña
     · Se logueó desde un dispositivo nuevo
     · Llegaron al 80% de su cuota diaria
     · Hay novedades o funciones nuevas
     · Algo importante pasó en su cuenta

   Y los admins necesitan saber cuándo:
     · Un endpoint empezó a fallar
     · Un usuario está abusando
     · La DB está lenta
     · Los 3 motores de IA se cayeron

   Este módulo resuelve todo eso con:
     · 4 canales: in-app, email, push, webhook
     · Preferencias por usuario (qué quiere recibir)
     · Throttling (no mandar el mismo dos veces en X tiempo)
     · Queue con batching (no spamear a Redis)
     · Templates con variables ({{name}}, {{limit}}, etc.)
     · Prioridades (low, normal, high, urgent)
     · TTL por tipo de notificación
     · Fallback si un canal falla

   ESTRUCTURA:
     1  · Configuración
     2  · Tipos de notificación (catálogo)
     3  · Templates (email HTML + in-app copy)
     4  · Preferencias por defecto
     5  · Canales (email, in-app, push, webhook)
     6  · Queue en memoria + flush batched
     7  · Throttling
     8  · Key builders
     9  · send() - función principal
    10  · Helpers por dominio
    11  · Consultas: historial, no leídas
    12  · Preferencias: get/set
    13  · Admin: broadcast
    14  · Middleware Express
    15  · Self-test
    16  · Exports

   USO BÁSICO:

     import { notify, TYPES } from './notifications.js';

     // Enviar notificación
     await notify(TYPES.PASSWORD_CHANGED, {
       userId: 'abc-123',
       email: 'user@example.com',
       name: 'Álvaro',
     });

     // Con metadata
     await notify(TYPES.LIMIT_WARNING, {
       userId,
       data: { limit: 20, used: 16, percent: 80 },
     });

   USO CON MIDDLEWARE:

     import { notificationsMiddleware } from './notifications.js';
     app.use(notificationsMiddleware());

   CANALES SOPORTADOS:

     · in-app   → guardado en Redis, leído con GET /api/notifications
     · email    → vía Resend (o SMTP)
     · push     → placeholder para FCM (futuro Android)
     · webhook  → Discord/Slack para admins

   ================================================================ */

import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  /* Ventana de throttling por defecto (segundos) */
  throttleWindowSec: 3600,

  /* Cuántas notificaciones in-app guardar por usuario */
  inboxMaxSize: 100,

  /* TTL por defecto de notificaciones in-app (segundos) */
  inboxTtlSec: 90 * 86400,

  /* Buffer: cuántas notificaciones agrupar antes de flush */
  bufferSize: 20,

  /* Cada cuánto forzar flush (ms) */
  flushIntervalMs: 4000,

  /* Máximo de reintentos por notificación */
  maxRetries: 3,

  /* Backoff base para reintentos (ms) */
  retryBackoffMs: 500,

  /* Timeout por operación de red */
  netTimeoutMs: 8000,

  /* Email de origen */
  fromEmail: process.env.NUMINATION_FROM_EMAIL || 'Numi <no-reply@numination.app>',

  /* Resend API key */
  resendKey: process.env.RESEND_API_KEY || null,

  /* Webhook para admin (Discord/Slack) */
  adminWebhook: process.env.ADMIN_WEBHOOK_URL || null,

  /* Nombre del producto */
  productName: 'Numination',
});

/* ═══════════════════════════════════════════════════════════════════════
   2 · TIPOS DE NOTIFICACIÓN · catálogo cerrado
   ═══════════════════════════════════════════════════════════════════════
   Cada tipo define:
     · key       · identificador único
     · priority  · 'low' | 'normal' | 'high' | 'urgent'
     · channels  · canales por defecto: ['in-app', 'email', 'push']
     · ttlSec    · cuánto tiempo se guarda in-app (default: inboxTtlSec)
     · throttle  · segundos entre notificaciones iguales (0 = sin throttle)
     · template  · función que construye { subject, html, text, inApp }
   ═══════════════════════════════════════════════════════════════════════ */

export const TYPES = Object.freeze({
  /* ─── Auth ─── */
  WELCOME:             'welcome',
  PASSWORD_CHANGED:    'password_changed',
  PASSWORD_RESET_DONE: 'password_reset_done',
  NEW_DEVICE_LOGIN:    'new_device_login',
  EMAIL_VERIFIED:      'email_verified',
  SUSPICIOUS_LOGIN:    'suspicious_login',
  ACCOUNT_LOCKED:      'account_locked',
  ACCOUNT_DELETED:     'account_deleted',

  /* ─── Límites ─── */
  LIMIT_WARNING:       'limit_warning',
  LIMIT_REACHED:       'limit_reached',
  LIMIT_RESET:         'limit_reset',

  /* ─── Producto ─── */
  NEW_FEATURE:         'new_feature',
  TIP:                 'tip',
  MEMORY_SUGGESTION:   'memory_suggestion',

  /* ─── Admin (solo admins) ─── */
  SYSTEM_ALERT:        'system_alert',
  ENGINE_DOWN:         'engine_down',
  DB_SLOW:             'db_slow',
  ABUSE_DETECTED:      'abuse_detected',

  /* ─── Seguridad ─── */
  SESSION_EXPIRED:     'session_expired',
  REVOKED_DEVICE:      'revoked_device',
});

/* ═══════════════════════════════════════════════════════════════════════
   3 · PRIORIDADES
   ═══════════════════════════════════════════════════════════════════════ */

const PRIORITY = Object.freeze({
  low:     { order: 1, badge: null,        forceEmail: false },
  normal:  { order: 2, badge: null,        forceEmail: false },
  high:    { order: 3, badge: '⚠',         forceEmail: true  },
  urgent:  { order: 4, badge: '🔴',        forceEmail: true  },
});

/* ═══════════════════════════════════════════════════════════════════════
   4 · TEMPLATES
   ═══════════════════════════════════════════════════════════════════════
   Cada template tiene:
     · subject  · asunto del email (con soporte {{var}})
     · title    · título in-app
     · body     · cuerpo en texto plano ({{var}})
     · ctaLabel · texto del botón (opcional)
     · ctaUrl   · URL del botón (opcional, soporta {{var}})
   ═══════════════════════════════════════════════════════════════════════ */

const TEMPLATES = Object.freeze({
  /* ─── Auth ─── */
  [TYPES.WELCOME]: {
    subject: '¡Bienvenido a {{product}}, {{name}}!',
    title: '¡Bienvenido a Numination!',
    body: 'Hola {{name}}, tu cuenta está lista. Numi está listo para ayudarte con código, tareas y proyectos.',
    ctaLabel: 'Ir al chat',
    ctaUrl: '{{appUrl}}/chat',
    channels: ['in-app', 'email'],
    priority: 'normal',
    throttle: 0,
  },

  [TYPES.PASSWORD_CHANGED]: {
    subject: 'Tu contraseña cambió en {{product}}',
    title: 'Contraseña cambiada',
    body: 'Tu contraseña cambió el {{date}} desde {{ip}}. Si fuiste vos, ignorá este mensaje. Si no fuiste vos, contactanos inmediatamente.',
    ctaLabel: 'Cerrar todas las sesiones',
    ctaUrl: '{{appUrl}}/login',
    channels: ['in-app', 'email'],
    priority: 'high',
    throttle: 60,
  },

  [TYPES.PASSWORD_RESET_DONE]: {
    subject: 'Tu contraseña fue restablecida',
    title: 'Contraseña restablecida',
    body: 'Recuperaste el acceso a tu cuenta el {{date}}. Ya podés iniciar sesión con tu nueva contraseña.',
    ctaLabel: 'Iniciar sesión',
    ctaUrl: '{{appUrl}}/login',
    channels: ['in-app', 'email'],
    priority: 'high',
    throttle: 60,
  },

  [TYPES.NEW_DEVICE_LOGIN]: {
    subject: 'Nuevo inicio de sesión en tu cuenta',
    title: 'Nuevo dispositivo',
    body: 'Alguien inició sesión con tu cuenta desde {{device}} ({{ip}}) el {{date}}. Si fuiste vos, todo bien. Si no, cambiá tu contraseña.',
    ctaLabel: 'Ver sesiones activas',
    ctaUrl: '{{appUrl}}/settings',
    channels: ['in-app', 'email'],
    priority: 'high',
    throttle: 300,
  },

  [TYPES.EMAIL_VERIFIED]: {
    subject: 'Correo verificado',
    title: 'Correo verificado',
    body: 'Tu correo {{email}} quedó verificado. Ya podés usar todas las funciones de Numination.',
    channels: ['in-app'],
    priority: 'normal',
    throttle: 60,
  },

  [TYPES.SUSPICIOUS_LOGIN]: {
    subject: '⚠️ Actividad sospechosa en tu cuenta',
    title: 'Actividad sospechosa',
    body: 'Detectamos un intento de acceso desde {{ip}} ({{location}}). Bloqueamos ese intento por seguridad. Si fuiste vos, ignorá este mensaje.',
    ctaLabel: 'Revisar seguridad',
    ctaUrl: '{{appUrl}}/settings',
    channels: ['in-app', 'email'],
    priority: 'urgent',
    throttle: 0,
  },

  [TYPES.ACCOUNT_LOCKED]: {
    subject: 'Tu cuenta fue bloqueada temporalmente',
    title: 'Cuenta bloqueada',
    body: 'Bloqueamos tu cuenta por 15 minutos después de 5 intentos fallidos de inicio de sesión. Podés intentar de nuevo en unos minutos.',
    channels: ['in-app', 'email'],
    priority: 'high',
    throttle: 300,
  },

  [TYPES.ACCOUNT_DELETED]: {
    subject: 'Tu cuenta fue eliminada',
    title: 'Cuenta eliminada',
    body: 'Eliminamos tu cuenta de {{product}} junto con todos tus chats, memorias y proyectos. Esta acción no se puede deshacer.',
    channels: ['email'],
    priority: 'urgent',
    throttle: 0,
  },

  /* ─── Límites ─── */
  [TYPES.LIMIT_WARNING]: {
    subject: 'Te queda poco para tu límite diario',
    title: 'Casi sin mensajes',
    body: 'Usaste {{used}} de {{limit}} mensajes hoy ({{percent}}%). Cuando llegues al 100%, no vas a poder mandar más hasta mañana.',
    ctaLabel: 'Ver planes',
    ctaUrl: '{{appUrl}}/precio',
    channels: ['in-app'],
    priority: 'normal',
    throttle: 3600,
  },

  [TYPES.LIMIT_REACHED]: {
    subject: 'Alcanzaste tu límite diario',
    title: 'Sin mensajes disponibles',
    body: 'Llegaste a los {{limit}} mensajes del plan {{plan}}. Volvé mañana o mejorá tu plan para seguir chateando.',
    ctaLabel: 'Mejorar plan',
    ctaUrl: '{{appUrl}}/precio',
    channels: ['in-app', 'email'],
    priority: 'high',
    throttle: 3600,
  },

  [TYPES.LIMIT_RESET]: {
    subject: 'Tu límite diario se renovó',
    title: 'Mensajes renovados',
    body: 'Tu cuota diaria se reinició. Ya tenés {{limit}} mensajes disponibles.',
    channels: ['in-app'],
    priority: 'low',
    throttle: 0,
  },

  /* ─── Producto ─── */
  [TYPES.NEW_FEATURE]: {
    subject: 'Nueva función en {{product}}: {{feature}}',
    title: 'Novedad: {{feature}}',
    body: '{{description}}',
    ctaLabel: 'Probar ahora',
    ctaUrl: '{{appUrl}}/chat',
    channels: ['in-app', 'email'],
    priority: 'low',
    throttle: 0,
  },

  [TYPES.TIP]: {
    subject: 'Tip de Numi: {{tipTitle}}',
    title: '{{tipTitle}}',
    body: '{{tipBody}}',
    channels: ['in-app'],
    priority: 'low',
    throttle: 0,
  },

  [TYPES.MEMORY_SUGGESTION]: {
    subject: null,
    title: 'Sugerencia de memoria',
    body: '¿Querés que recuerde "{{suggestion}}"? Guardala desde el menú de la respuesta.',
    channels: ['in-app'],
    priority: 'low',
    throttle: 60,
  },

  /* ─── Admin ─── */
  [TYPES.SYSTEM_ALERT]: {
    subject: '⚠️ Alerta del sistema: {{alert}}',
    title: 'Alerta del sistema',
    body: '{{message}}',
    channels: ['email', 'webhook'],
    priority: 'urgent',
    throttle: 300,
  },

  [TYPES.ENGINE_DOWN]: {
    subject: '🔴 Motor {{engine}} caído',
    title: 'Motor caído',
    body: 'El motor {{engine}} dejó de responder a las {{time}}. Los otros motores están cubriendo el servicio.',
    channels: ['webhook'],
    priority: 'urgent',
    throttle: 600,
  },

  [TYPES.DB_SLOW]: {
    subject: 'Base de datos lenta',
    title: 'DB lenta',
    body: 'La DB tardó {{latencyMs}}ms en responder (límite: {{threshold}}ms).',
    channels: ['webhook'],
    priority: 'high',
    throttle: 300,
  },

  [TYPES.ABUSE_DETECTED]: {
    subject: '🚨 Abuso detectado: {{userId}}',
    title: 'Abuso detectado',
    body: 'El usuario {{userId}} golpeó el rate limit {{strikes}} veces en 1 hora. Endpoint: {{endpoint}}.',
    channels: ['webhook'],
    priority: 'high',
    throttle: 300,
  },

  /* ─── Seguridad ─── */
  [TYPES.SESSION_EXPIRED]: {
    subject: null,
    title: 'Sesión expirada',
    body: 'Tu sesión expiró. Volvé a iniciar sesión para continuar.',
    ctaLabel: 'Iniciar sesión',
    ctaUrl: '{{appUrl}}/login',
    channels: ['in-app'],
    priority: 'normal',
    throttle: 0,
  },

  [TYPES.REVOKED_DEVICE]: {
    subject: 'Cerraste sesión en todos los dispositivos',
    title: 'Sesiones cerradas',
    body: 'Cerraste sesión en todos los dispositivos el {{date}}. Solo este dispositivo sigue activo.',
    channels: ['in-app', 'email'],
    priority: 'normal',
    throttle: 60,
  },
});

/* ═══════════════════════════════════════════════════════════════════════
   5 · PREFERENCIAS POR DEFECTO
   ═══════════════════════════════════════════════════════════════════════ */

const DEFAULT_PREFS = Object.freeze({
  // Canales habilitados
  channels: {
    inApp: true,
    email: true,
    push: false,      // futuro
  },

  // Categorías
  categories: {
    security: true,   // password, login nuevo, etc.
    limits: true,     // límites alcanzados
    product: false,   // novedades y tips
    marketing: false, // promociones
  },

  // Digest
  digest: 'immediate',  // 'immediate' | 'daily' | 'weekly' | 'off'

  // Quiet hours (no enviar emails entre estas horas locales)
  quietHours: {
    enabled: false,
    from: 22,   // 22:00
    to: 8,      // 08:00
  },
});

/**
 * Determina la categoría de un tipo de notificación.
 */
function categoryOf(type) {
  if ([
    TYPES.PASSWORD_CHANGED,
    TYPES.PASSWORD_RESET_DONE,
    TYPES.NEW_DEVICE_LOGIN,
    TYPES.SUSPICIOUS_LOGIN,
    TYPES.ACCOUNT_LOCKED,
    TYPES.ACCOUNT_DELETED,
    TYPES.EMAIL_VERIFIED,
    TYPES.SESSION_EXPIRED,
    TYPES.REVOKED_DEVICE,
  ].includes(type)) return 'security';

  if ([
    TYPES.LIMIT_WARNING,
    TYPES.LIMIT_REACHED,
    TYPES.LIMIT_RESET,
  ].includes(type)) return 'limits';

  if ([
    TYPES.NEW_FEATURE,
    TYPES.TIP,
    TYPES.MEMORY_SUGGESTION,
  ].includes(type)) return 'product';

  // Admin alerts van siempre
  return 'security';
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · CLIENTE UPSTASH
   ═══════════════════════════════════════════════════════════════════════ */

function getUpstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

async function pipeline(commands) {
  const u = getUpstash();
  if (!u) return { ok: false, error: 'no_upstash' };
  if (!commands || commands.length === 0) return { ok: true, result: [] };

  try {
    const res = await fetch(`${u.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(CFG.netTimeoutMs),
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const json = await res.json();
    if (!Array.isArray(json)) return { ok: false, error: 'invalid_response' };
    return { ok: true, result: json };
  } catch (e) {
    return { ok: false, error: e?.message || 'fetch_failed' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · TEMPLATE ENGINE
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Reemplaza {{variable}} por su valor.
 * Si falta una variable, deja el placeholder tal cual.
 */
function render(template, vars) {
  if (typeof template !== 'string') return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? `{{${key}}}` : String(v);
  });
}

/**
 * Construye el HTML de un email a partir del template.
 */
function buildEmailHtml({ title, body, ctaLabel, ctaUrl, productName }) {
  const safeTitle = escapeHtml(title || productName);
  const safeBody = escapeHtml(body || '').replace(/\n/g, '<br>');

  const cta = ctaLabel && ctaUrl
    ? `<a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#1e3a5f;color:#fff;text-decoration:none;padding:14px 28px;border-radius:999px;font-weight:600;font-size:15px;margin-top:24px">${escapeHtml(ctaLabel)}</a>`
    : '';

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background:#f0f0f2;font-family:Inter,system-ui,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="padding:40px 20px">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(0,0,0,.06);max-width:100%">
<tr><td style="padding:36px 32px">
<div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#7c5eff;margin-bottom:20px">${productName}</div>
<h1 style="font-size:22px;font-weight:800;letter-spacing:-.02em;line-height:1.3;color:#0a0a0c;margin:0 0 16px">${safeTitle}</h1>
<p style="font-size:15px;line-height:1.65;color:#3a3a40;margin:0 0 8px">${safeBody}</p>
${cta}
<hr style="border:none;border-top:1px solid #ececef;margin:32px 0 16px">
<p style="font-size:12px;line-height:1.5;color:#a0a0a5;margin:0">
Recibís este correo porque tenés una cuenta en Numination. Si no querés recibir más avisos de este tipo,
<a href="{{appUrl}}/settings" style="color:#a0a0a5;text-decoration:underline">cambiá tus preferencias</a>.
</p>
</td></tr>
</table>
</div></td></tr>
</table>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ═══════════════════════════════════════════════════════════════════════
   8 · CANALES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Canal: in-app (guardado en Redis)
 */
const ChannelInApp = {
  name: 'in-app',

  async send(notif, ctx) {
    const u = getUpstash();
    if (!u) return { ok: false, error: 'no_upstash' };

    const id = crypto.randomUUID();
    const key = `notif:user:${notif.userId}:inbox`;
    const item = JSON.stringify({
      id,
      type: notif.type,
      priority: notif.priority,
      title: notif.title,
      body: notif.body,
      ctaLabel: notif.ctaLabel,
      ctaUrl: notif.ctaUrl,
      data: notif.data || {},
      read: false,
      createdAt: new Date().toISOString(),
    });

    const commands = [
      ['LPUSH', key, item],
      ['LTRIM', key, '0', String(CFG.inboxMaxSize - 1)],
      ['EXPIRE', key, String(notif.ttlSec || CFG.inboxTtlSec)],
      // Índice de no leídas
      ['INCR', `notif:user:${notif.userId}:unread`],
      ['EXPIRE', `notif:user:${notif.userId}:unread`, String(notif.ttlSec || CFG.inboxTtlSec)],
    ];

    const r = await pipeline(commands);
    return r.ok ? { ok: true, id } : { ok: false, error: r.error };
  },
};

/**
 * Canal: email (vía Resend)
 */
const ChannelEmail = {
  name: 'email',

  async send(notif, ctx) {
    if (!notif.email) return { ok: false, error: 'no_email' };
    if (!CFG.resendKey) {
      // Dev mode: log a consola
      console.log('═══════════════════════════════════════════════════');
      console.log('[notif:email] (dev · sin RESEND_API_KEY)');
      console.log('Para:  ', notif.email);
      console.log('Asunto:', notif.subject);
      console.log('═══════════════════════════════════════════════════');
      return { ok: true, dev: true };
    }

    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CFG.resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: CFG.fromEmail,
          to: [notif.email],
          subject: notif.subject,
          html: notif.html,
          text: notif.text,
        }),
        signal: AbortSignal.timeout(CFG.netTimeoutMs),
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { ok: false, error: `resend_${res.status}`, detail: txt.slice(0, 200) };
      }

      const json = await res.json();
      return { ok: true, messageId: json.id };
    } catch (e) {
      return { ok: false, error: e?.message || 'fetch_failed' };
    }
  },
};

/**
 * Canal: push (placeholder para FCM futuro)
 */
const ChannelPush = {
  name: 'push',

  async send(notif, ctx) {
    // En el futuro esto llamará a FCM
    // Por ahora es un no-op que registra intención
    return { ok: true, skipped: true, reason: 'push_not_implemented' };
  },
};

/**
 * Canal: webhook (Discord/Slack para admin)
 */
const ChannelWebhook = {
  name: 'webhook',

  async send(notif, ctx) {
    if (!CFG.adminWebhook) {
      console.log('[notif:webhook] (sin ADMIN_WEBHOOK_URL configurado)');
      console.log('  Tipo:', notif.type);
      console.log('  Título:', notif.title);
      return { ok: true, dev: true };
    }

    try {
      const payload = {
        content: `**${notif.title}**\n${notif.body}`,
        username: 'Numi Alerts',
        embeds: [{
          title: notif.subject || notif.title,
          description: notif.body,
          color: notif.priority === 'urgent' ? 0xff0000 :
                 notif.priority === 'high'   ? 0xff8800 : 0x7c5eff,
          timestamp: new Date().toISOString(),
          footer: { text: `Tipo: ${notif.type} · Prioridad: ${notif.priority}` },
        }],
      };

      const res = await fetch(CFG.adminWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CFG.netTimeoutMs),
      });

      return res.ok ? { ok: true } : { ok: false, error: `webhook_${res.status}` };
    } catch (e) {
      return { ok: false, error: e?.message || 'fetch_failed' };
    }
  },
};

const CHANNELS = {
  'in-app':  ChannelInApp,
  'email':   ChannelEmail,
  'push':    ChannelPush,
  'webhook': ChannelWebhook,
};

/* ═══════════════════════════════════════════════════════════════════════
   9 · QUEUE EN MEMORIA + FLUSH BATCHED
   ═══════════════════════════════════════════════════════════════════════ */

const queue = [];
let flushTimer = null;
let stats = {
  queued: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  throttled: 0,
  byChannel: { 'in-app': 0, 'email': 0, 'push': 0, 'webhook': 0 },
  lastFlushAt: null,
  lastErrorAt: null,
};

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushQueue().catch(() => {});
  }, CFG.flushIntervalMs);
  if (flushTimer.unref) flushTimer.unref();
}

async function flushQueue() {
  if (queue.length === 0) return { ok: true, count: 0 };

  const pending = queue.splice(0, queue.length);
  let sent = 0;
  let failed = 0;

  // Los webhooks se agrupan (todos van al mismo endpoint)
  // Los in-app van en un solo pipeline por usuario
  // Los emails van uno por uno (Resend no soporta batch)

  const inAppByUser = new Map();

  for (const notif of pending) {
    for (const channelName of notif.channels) {
      const channel = CHANNELS[channelName];
      if (!channel) continue;

      try {
        // Optimización: agrupar in-app por usuario
        if (channelName === 'in-app') {
          if (!inAppByUser.has(notif.userId)) inAppByUser.set(notif.userId, []);
          inAppByUser.get(notif.userId).push(notif);
          continue;
        }

        // Enviar inmediato para otros canales
        const result = await channel.send(notif, {});
        if (result.ok) {
          stats.byChannel[channelName]++;
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
      }
    }
    sent++;
  }

  // Procesar in-app batched
  const u = getUpstash();
  if (u && inAppByUser.size > 0) {
    const commands = [];
    for (const [userId, notifs] of inAppByUser.entries()) {
      const key = `notif:user:${userId}:inbox`;
      const unreadKey = `notif:user:${userId}:unread`;

      for (const n of notifs) {
        const id = crypto.randomUUID();
        const item = JSON.stringify({
          id,
          type: n.type,
          priority: n.priority,
          title: n.title,
          body: n.body,
          ctaLabel: n.ctaLabel,
          ctaUrl: n.ctaUrl,
          data: n.data || {},
          read: false,
          createdAt: new Date().toISOString(),
        });
        commands.push(['LPUSH', key, item]);
      }
      commands.push(['LTRIM', key, '0', String(CFG.inboxMaxSize - 1)]);
      commands.push(['EXPIRE', key, String(CFG.inboxTtlSec)]);
      commands.push(['INCRBY', unreadKey, String(notifs.length)]);
      commands.push(['EXPIRE', unreadKey, String(CFG.inboxTtlSec)]);
    }

    const r = await pipeline(commands);
    if (r.ok) {
      stats.byChannel['in-app'] += inAppByUser.size;
    } else {
      failed += inAppByUser.size;
    }
  }

  stats.sent += sent;
  stats.failed += failed;
  stats.lastFlushAt = Date.now();
  if (failed > 0) stats.lastErrorAt = Date.now();

  return { ok: true, count: pending.length, failed };
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · THROTTLING
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Verifica si podemos enviar una notificación de este tipo a este usuario.
 * Usa Redis SET NX con TTL.
 *
 * @returns {Promise<boolean>} true si podemos enviar
 */
async function checkThrottle(userId, type, windowSec) {
  if (!windowSec || windowSec <= 0) return true;

  const u = getUpstash();
  if (!u) return true; // fail-open sin Redis

  const key = `notif:throttle:${userId}:${type}`;

  const r = await pipeline([
    ['SET', key, '1', 'EX', String(windowSec), 'NX'],
  ]);

  if (!r.ok) return true;

  // Si SET NX devolvió OK → podemos enviar
  // Si devolvió null → ya existía → throttled
  return r.result[0]?.result === 'OK';
}

/* ═══════════════════════════════════════════════════════════════════════
   11 · PREFERENCIAS · Redis
   ═══════════════════════════════════════════════════════════════════════ */

async function loadPreferences(userId) {
  const u = getUpstash();
  if (!u) return { ...DEFAULT_PREFS };

  const r = await pipeline([
    ['GET', `notif:user:${userId}:prefs`],
  ]);

  if (!r.ok || !r.result[0]?.result) return { ...DEFAULT_PREFS };

  try {
    const stored = JSON.parse(r.result[0].result);
    return deepMerge(DEFAULT_PREFS, stored);
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

async function savePreferences(userId, prefs) {
  const u = getUpstash();
  if (!u) return false;

  const r = await pipeline([
    ['SET', `notif:user:${userId}:prefs`, JSON.stringify(prefs)],
    ['EXPIRE', `notif:user:${userId}:prefs`, String(365 * 86400)],
  ]);

  return r.ok;
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Decide si el usuario quiere recibir este tipo de notificación por este canal.
 */
function shouldSendToChannel(prefs, type, channelName) {
  const category = categoryOf(type);

  // Canales deshabilitados
  if (channelName === 'in-app' && !prefs.channels.inApp) return false;
  if (channelName === 'email' && !prefs.channels.email) return false;
  if (channelName === 'push' && !prefs.channels.push) return false;
  // webhook siempre activo (es para admin)

  // Categorías
  if (category === 'security' && !prefs.categories.security) {
    // Los emails de seguridad SIEMPRE se mandan (no se pueden deshabilitar)
    if (channelName === 'email') return true;
    return false;
  }
  if (category === 'limits' && !prefs.categories.limits) return false;
  if (category === 'product' && !prefs.categories.product) return false;

  return true;
}

/* ═══════════════════════════════════════════════════════════════════════
   12 · SEND · función principal
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Envía una notificación.
 *
 * @param {string} type            · uno de TYPES
 * @param {object} opts
 * @param {string} opts.userId     · UUID del usuario
 * @param {string} [opts.email]    · email del usuario (para canal email)
 * @param {object} [opts.data]     · variables del template + metadata
 * @param {string[]} [opts.channels] · override de canales
 * @param {string} [opts.priority] · override de prioridad
 * @param {boolean} [opts.force]   · saltar throttling y preferencias
 * @returns {Promise<{ok: boolean, queued?: boolean, reason?: string}>}
 */
export async function notify(type, opts = {}) {
  try {
    const tpl = TEMPLATES[type];
    if (!tpl) {
      return { ok: false, reason: 'unknown_type' };
    }

    const userId = opts.userId;
    if (!userId) {
      return { ok: false, reason: 'no_userId' };
    }

    // Cargar preferencias
    const prefs = opts.force ? DEFAULT_PREFS : await loadPreferences(userId);

    // Throttling
    if (!opts.force) {
      const throttle = tpl.throttle ?? CFG.throttleWindowSec;
      const canSend = await checkThrottle(userId, type, throttle);
      if (!canSend) {
        stats.throttled++;
        return { ok: true, queued: false, reason: 'throttled' };
      }
    }

    // Construir variables del template
    const appUrl = process.env.APP_URL || 'https://numinationchat.vercel.app';
    const vars = {
      product: CFG.productName,
      appUrl,
      date: new Date().toLocaleString('es-CO', { dateStyle: 'long', timeStyle: 'short' }),
      ...opts.data,
    };

    // Determinar canales
    let channels = opts.channels || tpl.channels || ['in-app'];
    channels = channels.filter((c) => shouldSendToChannel(prefs, type, c));

    if (channels.length === 0) {
      stats.skipped++;
      return { ok: true, queued: false, reason: 'no_channels' };
    }

    // Renderizar template
    const subject = tpl.subject ? render(tpl.subject, vars) : null;
    const title = render(tpl.title, vars);
    const body = render(tpl.body, vars);
    const ctaLabel = tpl.ctaLabel ? render(tpl.ctaLabel, vars) : null;
    const ctaUrl = tpl.ctaUrl ? render(tpl.ctaUrl, vars) : null;

    const html = channels.includes('email')
      ? buildEmailHtml({
          title,
          body,
          ctaLabel,
          ctaUrl,
          productName: CFG.productName,
        })
      : null;

    const notif = {
      userId,
      email: opts.email,
      type,
      subject,
      title,
      body,
      html,
      text: body, // fallback plain text
      ctaLabel,
      ctaUrl,
      priority: opts.priority || tpl.priority || 'normal',
      channels,
      ttlSec: tpl.ttlSec || CFG.inboxTtlSec,
      data: opts.data || {},
      createdAt: Date.now(),
    };

    queue.push(notif);
    stats.queued++;

    if (queue.length >= CFG.bufferSize) {
      flushQueue().catch(() => {});
    } else {
      scheduleFlush();
    }

    return { ok: true, queued: true };
  } catch (e) {
    stats.failed++;
    return { ok: false, reason: e?.message || 'unknown' };
  }
}

/**
 * Igual que notify pero espera a que se envíe (no encola).
 * Útil para tests o cuando necesitás confirmación.
 */
export async function notifyNow(type, opts = {}) {
  const result = await notify(type, opts);
  if (result.queued) {
    await flushQueue();
  }
  return result;
}

/* ═══════════════════════════════════════════════════════════════════════
   13 · HELPERS POR DOMINIO
   ═══════════════════════════════════════════════════════════════════════ */

export const notifications = {
  /* ─── Auth ─── */
  welcome: (userId, email, name) =>
    notify(TYPES.WELCOME, { userId, email, data: { name } }),

  passwordChanged: (userId, email, ip) =>
    notify(TYPES.PASSWORD_CHANGED, { userId, email, data: { ip } }),

  passwordResetDone: (userId, email) =>
    notify(TYPES.PASSWORD_RESET_DONE, { userId, email }),

  newDeviceLogin: (userId, email, { device, ip }) =>
    notify(TYPES.NEW_DEVICE_LOGIN, { userId, email, data: { device, ip } }),

  emailVerified: (userId, email) =>
    notify(TYPES.EMAIL_VERIFIED, { userId, data: { email } }),

  suspiciousLogin: (userId, email, { ip, location }) =>
    notify(TYPES.SUSPICIOUS_LOGIN, { userId, email, data: { ip, location } }),

  accountLocked: (userId, email) =>
    notify(TYPES.ACCOUNT_LOCKED, { userId, email }),

  accountDeleted: (email) =>
    notify(TYPES.ACCOUNT_DELETED, { userId: 'deleted', email }),

  /* ─── Límites ─── */
  limitWarning: (userId, { limit, used, percent }) =>
    notify(TYPES.LIMIT_WARNING, { userId, data: { limit, used, percent } }),

  limitReached: (userId, email, { limit, plan }) =>
    notify(TYPES.LIMIT_REACHED, { userId, email, data: { limit, plan } }),

  limitReset: (userId, { limit }) =>
    notify(TYPES.LIMIT_RESET, { userId, data: { limit } }),

  /* ─── Producto ─── */
  newFeature: (userId, email, { feature, description }) =>
    notify(TYPES.NEW_FEATURE, { userId, email, data: { feature, description } }),

  tip: (userId, { tipTitle, tipBody }) =>
    notify(TYPES.TIP, { userId, data: { tipTitle, tipBody } }),

  memorySuggestion: (userId, { suggestion }) =>
    notify(TYPES.MEMORY_SUGGESTION, { userId, data: { suggestion } }),

  /* ─── Admin ─── */
  systemAlert: (alert, message) =>
    notify(TYPES.SYSTEM_ALERT, {
      userId: 'admin',
      data: { alert, message },
      force: true,
    }),

  engineDown: (engine) =>
    notify(TYPES.ENGINE_DOWN, {
      userId: 'admin',
      data: { engine, time: new Date().toISOString() },
      force: true,
    }),

  dbSlow: (latencyMs, threshold = 500) =>
    notify(TYPES.DB_SLOW, {
      userId: 'admin',
      data: { latencyMs, threshold },
      force: true,
    }),

  abuseDetected: (userId, { strikes, endpoint }) =>
    notify(TYPES.ABUSE_DETECTED, {
      userId: 'admin',
      data: { userId, strikes, endpoint },
      force: true,
    }),

  /* ─── Utilidades ─── */
  flush: () => flushQueue(),
  stats: () => ({ ...stats, queueSize: queue.length }),
};

/* ═══════════════════════════════════════════════════════════════════════
   14 · CONSULTAS · historial e inbox
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Devuelve el inbox de un usuario.
 */
export async function getInbox(userId, { limit = 50, offset = 0 } = {}) {
  const u = getUpstash();
  if (!u) return { ok: true, notifications: [], unread: 0 };

  const key = `notif:user:${userId}:inbox`;
  const unreadKey = `notif:user:${userId}:unread`;

  const r = await pipeline([
    ['LRANGE', key, String(offset), String(offset + limit - 1)],
    ['GET', unreadKey],
  ]);

  if (!r.ok) return { ok: false, error: r.error };

  const items = (r.result[0]?.result || []).map((s) => {
    try { return JSON.parse(s); } catch { return null; }
  }).filter(Boolean);

  return {
    ok: true,
    notifications: items,
    unread: Number(r.result[1]?.result) || 0,
  };
}

/**
 * Cuenta de no leídas.
 */
export async function getUnreadCount(userId) {
  const u = getUpstash();
  if (!u) return 0;

  const r = await pipeline([['GET', `notif:user:${userId}:unread`]]);
  if (!r.ok) return 0;
  return Number(r.result[0]?.result) || 0;
}

/**
 * Marca todas las notificaciones como leídas.
 */
export async function markAllRead(userId) {
  const u = getUpstash();
  if (!u) return false;

  const r = await pipeline([
    ['SET', `notif:user:${userId}:unread`, '0'],
  ]);
  return r.ok;
}

/**
 * Marca una notificación específica como leída.
 */
export async function markRead(userId, notificationId) {
  const u = getUpstash();
  if (!u) return false;

  // Leemos el inbox, modificamos el item y lo reescribimos
  const { notifications: items } = await getInbox(userId, { limit: CFG.inboxMaxSize });
  if (!items || items.length === 0) return false;

  let found = false;
  for (const item of items) {
    if (item.id === notificationId && !item.read) {
      item.read = true;
      found = true;
      break;
    }
  }
  if (!found) return false;

  const key = `notif:user:${userId}:inbox`;
  const unreadKey = `notif:user:${userId}:unread`;

  const commands = [
    ['DEL', key],
    ...items.reverse().map((item) => ['LPUSH', key, JSON.stringify(item)]),
    ['LTRIM', key, '0', String(CFG.inboxMaxSize - 1)],
    ['EXPIRE', key, String(CFG.inboxTtlSec)],
    ['DECR', unreadKey],
  ];

  const r = await pipeline(commands);
  return r.ok;
}

/**
 * Elimina todas las notificaciones del usuario.
 */
export async function clearInbox(userId) {
  const u = getUpstash();
  if (!u) return false;

  const r = await pipeline([
    ['DEL', `notif:user:${userId}:inbox`],
    ['DEL', `notif:user:${userId}:unread`],
  ]);
  return r.ok;
}

/* ═══════════════════════════════════════════════════════════════════════
   15 · PREFERENCIAS · API pública
   ═══════════════════════════════════════════════════════════════════════ */

export async function getPreferences(userId) {
  return loadPreferences(userId);
}

export async function updatePreferences(userId, patch) {
  const current = await loadPreferences(userId);
  const merged = deepMerge(current, patch);
  const ok = await savePreferences(userId, merged);
  return { ok, prefs: merged };
}

export function getDefaultPreferences() {
  return JSON.parse(JSON.stringify(DEFAULT_PREFS));
}

/* ═══════════════════════════════════════════════════════════════════════
   16 · ADMIN · broadcast
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Envía una notificación a TODOS los admins.
 */
export async function notifyAdmins(type, data) {
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (admins.length === 0) {
    return { ok: false, reason: 'no_admins_configured' };
  }

  const results = await Promise.all(
    admins.map((email) =>
      notify(type, {
        userId: `admin:${email}`,
        email,
        data,
        force: true,
      })
    )
  );

  return { ok: true, sent: results.length };
}

/* ═══════════════════════════════════════════════════════════════════════
   17 · MIDDLEWARE EXPRESS
   ═══════════════════════════════════════════════════════════════════════
   Adjunta helpers al request:
     req.notify(type, opts) · atajo
     req.user.notifications · inbox cargado lazy
   ═══════════════════════════════════════════════════════════════════════ */

export function notificationsMiddleware() {
  return (req, _res, next) => {
    // Añadir helper al request
    req.notify = (type, opts = {}) => {
      return notify(type, {
        userId: req.user?.id,
        email: req.user?.email,
        ...opts,
      });
    };

    next();
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   18 · HEALTH / PING
   ═══════════════════════════════════════════════════════════════════════ */

export async function pingNotifications() {
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
      queueSize: queue.length,
      emailConfigured: Boolean(CFG.resendKey),
      webhookConfigured: Boolean(CFG.adminWebhook),
      stats,
    };
  } catch (e) {
    return { ok: false, reason: e?.message || 'fetch_failed' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   19 · GRACEFUL SHUTDOWN
   ═══════════════════════════════════════════════════════════════════════ */

export async function flushAndStop() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return await flushQueue();
}

/* ═══════════════════════════════════════════════════════════════════════
   20 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const errors = [];

  // 1 · Todos los tipos tienen template
  for (const type of Object.values(TYPES)) {
    if (!TEMPLATES[type]) {
      errors.push(`Tipo ${type} sin template`);
    } else {
      const t = TEMPLATES[type];
      if (!t.title) errors.push(`Template ${type} sin title`);
      if (!t.body) errors.push(`Template ${type} sin body`);
    }
  }

  // 2 · Categorización
  if (categoryOf(TYPES.PASSWORD_CHANGED) !== 'security') {
    errors.push('categoryOf(PASSWORD_CHANGED) no es security');
  }
  if (categoryOf(TYPES.LIMIT_WARNING) !== 'limits') {
    errors.push('categoryOf(LIMIT_WARNING) no es limits');
  }
  if (categoryOf(TYPES.NEW_FEATURE) !== 'product') {
    errors.push('categoryOf(NEW_FEATURE) no es product');
  }

  // 3 · Render
  const r1 = render('Hola {{name}}', { name: 'Álvaro' });
  if (r1 !== 'Hola Álvaro') errors.push(`render falló: ${r1}`);

  const r2 = render('{{missing}}', {});
  if (r2 !== '{{missing}}') errors.push(`render missing falló: ${r2}`);

  // 4 · HTML
  const html = buildEmailHtml({ title: 'Test', body: 'Hola', productName: 'Numi' });
  if (!html.includes('Hola')) errors.push('buildEmailHtml no incluye body');
  if (!html.includes('Numi')) errors.push('buildEmailHtml no incluye productName');

  // 5 · Escape HTML
  const escaped = escapeHtml('<script>');
  if (escaped !== '&lt;script&gt;') errors.push(`escapeHtml falló: ${escaped}`);

  // 6 · deepMerge
  const merged = deepMerge({ a: 1, b: { c: 2, d: 3 } }, { b: { c: 9 } });
  if (merged.a !== 1) errors.push('deepMerge perdió a');
  if (merged.b.c !== 9) errors.push('deepMerge no override c');
  if (merged.b.d !== 3) errors.push('deepMerge perdió d');

  // 7 · shouldSendToChannel
  const prefs = { channels: { inApp: true, email: false }, categories: { security: true, product: true } };
  if (!shouldSendToChannel(prefs, TYPES.PASSWORD_CHANGED, 'in-app')) {
    errors.push('shouldSendToChannel falló para in-app con email off');
  }
  if (shouldSendToChannel(prefs, TYPES.NEW_FEATURE, 'email')) {
    errors.push('shouldSendToChannel dejó pasar email deshabilitado');
  }

  return {
    ok: errors.length === 0,
    errors,
    totalTypes: Object.keys(TYPES).length,
    totalTemplates: Object.keys(TEMPLATES).length,
    channels: Object.keys(CHANNELS),
    stats,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   FIN
   ═══════════════════════════════════════════════════════════════════════ */