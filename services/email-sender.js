/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/email-sender.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Wrapper de envío de email con dos motores y reintentos exponenciales.

   MOTORES (en este orden)
     1 · Resend      → API HTTP (RESEND_API_KEY). Es el preferido.
     2 · Nodemailer  → SMTP (BREVO_*). Plan B si no hay clave de Resend.

   REINTENTOS
     3 intentos con espera exponencial: 500 ms · 1 s · 2 s.
     Sólo se reintenta lo que es transitorio (red, 429, 5xx). Un 400
     (email inválido) no se reintenta: se pierde el tiempo.

   CONTRATO
     sendEmail(to, subject, html, options) → { ok, id, provider, attempts }
   ═══════════════════════════════════════════════════════════════════════ */

import nodemailer from 'nodemailer';
import { LOG } from '../src/lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  resendUrl: 'https://api.resend.com/emails',
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  timeoutMs: 15_000,
  fromName: process.env.BREVO_FROM_NAME || process.env.EMAIL_FROM_NAME || 'Numination',
  fromEmail:
    process.env.BREVO_FROM_EMAIL
    || process.env.EMAIL_FROM
    || 'numination@outlook.es',
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/* ═══════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * ¿Hay algún motor de email configurado?
 * @returns {{configured:boolean, provider:string|null}}
 */
export function isEmailConfigured() {
  const resend = Boolean(process.env.RESEND_API_KEY);
  const smtp = Boolean(process.env.BREVO_SMTP_HOST && process.env.BREVO_SMTP_USER);
  return {
    configured: resend || smtp,
    provider: resend ? 'resend' : (smtp ? 'nodemailer' : null),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * ¿El error es transitorio (merece la pena reintentar)?
 * @param {Error & {status?:number}} error
 * @returns {boolean}
 */
export function isTransient(error) {
  const status = Number(error?.status || 0);
  if (status === 429 || status >= 500) return true;

  const code = String(error?.code || '');
  if (['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code)) {
    return true;
  }

  const message = String(error?.message || '').toLowerCase();
  return /timeout|temporar|rate limit|socket hang up|network|connection/.test(message);
}

/**
 * Construye el remitente final.
 * @param {object} [options]
 * @returns {string}
 */
function resolveFrom(options = {}) {
  if (options.from) return String(options.from);
  return `"${CFG.fromName}" <${CFG.fromEmail}>`;
}

/* ═══════════════════════════════════════════════════════════════════════
   03 · MOTORES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Envío con Resend (API HTTP).
 * @returns {Promise<{id:string}>}
 */
async function sendViaResend({ to, subject, html, from, replyTo, fetchImpl }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    const error = new Error('RESEND_API_KEY no configurada.');
    error.code = 'NO_RESEND_KEY';
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

  try {
    const res = await fetchImpl(CFG.resendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
      signal: controller.signal,
    });

    const body = await res.text().catch(() => '');
    if (!res.ok) {
      const error = new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
      error.status = res.status;
      throw error;
    }

    let parsed = {};
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = {};
    }

    return { id: parsed?.id || null };
  } catch (e) {
    if (!e.status && e.name === 'AbortError') e.status = 408;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Envío con Nodemailer (SMTP).
 * @returns {Promise<{id:string|null}>}
 */
async function sendViaSmtp({ to, subject, html, from }) {
  const host = process.env.BREVO_SMTP_HOST;
  const user = process.env.BREVO_SMTP_USER;
  const pass = process.env.BREVO_SMTP_PASSWORD;

  if (!host || !user || !pass) {
    const error = new Error('Configuración SMTP incompleta (BREVO_*).');
    error.code = 'NO_SMTP_CONFIG';
    throw error;
  }

  const transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.BREVO_SMTP_PORT || 587),
    secure: Number(process.env.BREVO_SMTP_PORT || 587) === 465,
    auth: { user, pass },
    connectionTimeout: CFG.timeoutMs,
  });

  const info = await transporter.sendMail({
    from,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    html,
  });

  return { id: info?.messageId || null };
}

/* ═══════════════════════════════════════════════════════════════════════
   04 · API
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Envía un email con reintentos exponenciales.
 *
 * @param {string|string[]} to      Destinatario(s).
 * @param {string} subject          Asunto.
 * @param {string} html             Cuerpo en HTML.
 * @param {object} [options]
 * @param {string} [options.from]       Remitente.
 * @param {string} [options.replyTo]
 * @param {number} [options.attempts]   Número máximo de intentos.
 * @param {Function}[options.fetchImpl]
 * @returns {Promise<{ok:boolean, id:string|null, provider:string|null,
 *                    attempts:number, error:string|null}>}
 */
export async function sendEmail(to, subject, html, options = {}) {
  const recipients = (Array.isArray(to) ? to : [to])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);

  if (!recipients.length) {
    return { ok: false, id: null, provider: null, attempts: 0, error: 'NO_RECIPIENT' };
  }

  const invalid = recipients.find((value) => !EMAIL_RE.test(value));
  if (invalid) {
    LOG.warn('email-sender: destinatario inválido', { to: invalid });
    return { ok: false, id: null, provider: null, attempts: 0, error: 'INVALID_RECIPIENT' };
  }

  const cleanSubject = String(subject ?? '').trim();
  if (!cleanSubject) {
    return { ok: false, id: null, provider: null, attempts: 0, error: 'EMPTY_SUBJECT' };
  }

  const body = String(html ?? '');
  if (!body.trim()) {
    return { ok: false, id: null, provider: null, attempts: 0, error: 'EMPTY_BODY' };
  }

  const { configured, provider } = isEmailConfigured();
  if (!configured) {
    LOG.warn('email-sender: no hay motor de email configurado');
    return { ok: false, id: null, provider: null, attempts: 0, error: 'NOT_CONFIGURED' };
  }

  const maxAttempts = Math.max(1, Number(options.attempts) || CFG.maxAttempts);
  const from = resolveFrom(options);
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = provider === 'resend'
        ? await sendViaResend({
          to: recipients, subject: cleanSubject, html: body, from,
          replyTo: options.replyTo, fetchImpl,
        })
        : await sendViaSmtp({ to: recipients, subject: cleanSubject, html: body, from });

      return {
        ok: true,
        id: result?.id ?? null,
        provider,
        attempts: attempt,
        error: null,
      };
    } catch (e) {
      lastError = e;
      LOG.warn('email-sender: intento fallido', {
        attempt, provider, error: e.message, status: e.status || 0,
      });

      const canRetry = attempt < maxAttempts && isTransient(e);
      if (!canRetry) break;

      const delay = Math.min(CFG.maxDelayMs, CFG.baseDelayMs * 2 ** (attempt - 1));
      await sleep(delay);
    }
  }

  return {
    ok: false,
    id: null,
    provider,
    attempts: maxAttempts,
    error: lastError?.message || 'UNKNOWN_ERROR',
  };
}

/**
 * Envía un email con el PDF adjunto (facturas).
 *
 * @param {string|string[]} to
 * @param {string} subject
 * @param {string} html
 * @param {Buffer} attachment
 * @param {string} filename
 * @param {object} [options]
 * @returns {Promise<object>}
 */
export async function sendEmailWithAttachment(to, subject, html, attachment, filename, options = {}) {
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length || !attachment?.length) {
    return { ok: false, id: null, provider: null, attempts: 0, error: 'INVALID_ARGS' };
  }

  const { configured, provider } = isEmailConfigured();
  if (!configured) {
    return { ok: false, id: null, provider: null, attempts: 0, error: 'NOT_CONFIGURED' };
  }

  const from = resolveFrom(options);

  try {
    if (provider === 'nodemailer') {
      const transporter = nodemailer.createTransport({
        host: process.env.BREVO_SMTP_HOST,
        port: Number(process.env.BREVO_SMTP_PORT || 587),
        secure: Number(process.env.BREVO_SMTP_PORT || 587) === 465,
        auth: {
          user: process.env.BREVO_SMTP_USER,
          pass: process.env.BREVO_SMTP_PASSWORD,
        },
      });

      const info = await transporter.sendMail({
        from,
        to: recipients.join(', '),
        subject: String(subject ?? ''),
        html: String(html ?? ''),
        attachments: [{
          filename: String(filename || 'documento.pdf'),
          content: attachment,
          contentType: 'application/pdf',
        }],
      });

      return { ok: true, id: info?.messageId || null, provider, attempts: 1, error: null };
    }

    // Resend: adjunto en base64.
    const apiKey = process.env.RESEND_API_KEY;
    const res = await (options.fetchImpl || globalThis.fetch)(CFG.resendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        from,
        to: recipients,
        subject: String(subject ?? ''),
        html: String(html ?? ''),
        attachments: [{
          filename: String(filename || 'documento.pdf'),
          content: Buffer.from(attachment).toString('base64'),
        }],
      }),
    });

    const body = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
    }

    let parsed = {};
    try { parsed = JSON.parse(body); } catch { parsed = {}; }
    return { ok: true, id: parsed?.id || null, provider, attempts: 1, error: null };
  } catch (e) {
    LOG.warn('email-sender: fallo al enviar el adjunto', { error: e.message });
    return { ok: false, id: null, provider, attempts: 1, error: e.message };
  }
}

export default {
  sendEmail,
  sendEmailWithAttachment,
  isEmailConfigured,
  isTransient,
};
