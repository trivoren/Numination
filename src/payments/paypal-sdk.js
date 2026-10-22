/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · payments/paypal-sdk.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Cliente del gateway de pagos PayPal (REST API v2) con OAuth2
   client-credentials.

   RESPONSABILIDADES:
     · Resolver credenciales desde `process.env` con fallback a
       `env.local.js` (TEST_KEYS) — el mismo patrón que usa el resto del
       proyecto — y LANZAR un error claro al arrancar si faltan.
     · Cachear el access token con expiración (no pedir uno por request).
     · `createPayPalOrder` / `capturePayPalOrder` sobre /v2/checkout/orders.
     · `verifyWebhookSignature` contra /v1/notifications/verify-webhook-signature
       (fail-closed: si no se puede verificar, NO se procesa el evento).
     · NUNCA loguear secretos: todo pasa por `mask()`.

   VARIABLES DE ENTORNO:
     · PAYPAL_CLIENT_ID     (obligatoria)  — público, se puede exponer al browser.
     · PAYPAL_CLIENT_SECRET (obligatoria)  — secreto de servidor, NUNCA al browser.
     · PAYPAL_WEBHOOK_ID    (obligatoria)  — ID del webhook registrado en PayPal.
     · PAYPAL_ENV           (opcional)    — 'sandbox' (default) | 'live'.
     · PAYPAL_API_TIMEOUT_MS(opcional)    — timeout de las llamadas a PayPal.
   ═══════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = {
  timeoutMs: Number(process.env.PAYPAL_API_TIMEOUT_MS || 15000),
  maxRetries: 2,               // reintentos ante 5xx / errores de red
  retryBaseMs: 350,
  tokenSafetyMarginSec: 60,    // se renueva el token 60s antes de expirar
  defaultCurrency: 'USD',
  environments: Object.freeze({
    sandbox: Object.freeze({
      api: 'https://api-m.sandbox.paypal.com',
      sdk: 'https://www.sandbox.paypal.com',
    }),
    live: Object.freeze({
      api: 'https://api-m.paypal.com',
      sdk: 'https://www.paypal.com',
    }),
  }),
};

/** Error de configuración (faltan credenciales). */
export class PayPalConfigError extends Error {
  constructor(message, missing = []) {
    super(message);
    this.name = 'PayPalConfigError';
    this.code = 'PAYPAL_CONFIG_ERROR';
    this.missing = missing;
  }
}

/** Error de la API de PayPal. */
export class PayPalApiError extends Error {
  constructor(message, status = 0, code = 'paypal_error', details = null) {
    super(message);
    this.name = 'PayPalApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/* ── Secretos de respaldo: env.local.js (TEST_KEYS) ───────────────────── */
let FILE_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  FILE_KEYS = mod.TEST_KEYS ?? {};
} catch {
  // env.local.js es opcional: si no existe, solo cuenta process.env.
}

/**
 * Lee una variable de entorno obligatoria.
 * @param {string} name
 * @returns {string}
 * @throws {PayPalConfigError} si no existe o está vacía.
 */
function requireEnv(name) {
  const fromProcess = process.env[name];
  const fromFile = FILE_KEYS ? FILE_KEYS[name] : undefined;
  const value = (typeof fromProcess === 'string' && fromProcess.trim())
    ? fromProcess.trim()
    : (typeof fromFile === 'string' && fromFile.trim() ? fromFile.trim() : '');

  if (!value) {
    throw new PayPalConfigError(
      `Falta la variable de entorno ${name}. Configurala antes de arrancar el servidor.`,
      [name]
    );
  }
  return value;
}

/**
 * Enmascara un secreto para poder loguearlo sin filtrarlo.
 * @param {string|null|undefined} value
 * @returns {string}
 */
export function mask(value) {
  if (!value || typeof value !== 'string') return '[unset]';
  if (value.length <= 4) return '****';
  return `****${value.slice(-4)}`;
}

/**
 * Valida que las credenciales estén completas. Lanza si falta algo.
 * Se llama en el arranque del servidor (mount de las rutas de pago).
 *
 * @returns {{clientId:string, clientSecret:string, webhookId:string, environment:string,
 *            apiBase:string, sdkBase:string, currency:string}}
 */
export function assertPayPalConfigured() {
  const missing = [];
  const clientId = process.env.PAYPAL_CLIENT_ID || FILE_KEYS.PAYPAL_CLIENT_ID || '';
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET || FILE_KEYS.PAYPAL_CLIENT_SECRET || '';
  const webhookId = process.env.PAYPAL_WEBHOOK_ID || FILE_KEYS.PAYPAL_WEBHOOK_ID || '';

  if (!String(clientId).trim()) missing.push('PAYPAL_CLIENT_ID');
  if (!String(clientSecret).trim()) missing.push('PAYPAL_CLIENT_SECRET');
  if (!String(webhookId).trim()) missing.push('PAYPAL_WEBHOOK_ID');

  if (missing.length) {
    throw new PayPalConfigError(
      `Configuración de PayPal incompleta. Faltan: ${missing.join(', ')}.`,
      missing
    );
  }

  const environment = String(process.env.PAYPAL_ENV || FILE_KEYS.PAYPAL_ENV || 'sandbox').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(CFG.environments, environment)) {
    throw new PayPalConfigError(
      `PAYPAL_ENV inválido: "${environment}". Debe ser "sandbox" o "live".`,
      ['PAYPAL_ENV']
    );
  }

  const currency = String(process.env.PAYPAL_CURRENCY || CFG.defaultCurrency).toUpperCase();

  return {
    clientId: String(clientId).trim(),
    clientSecret: String(clientSecret).trim(),
    webhookId: String(webhookId).trim(),
    environment,
    apiBase: CFG.environments[environment].api,
    sdkBase: CFG.environments[environment].sdk,
    currency,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   2 · ACCESS TOKEN (OAuth2 client-credentials)
   ═══════════════════════════════════════════════════════════════════════ */

let tokenCache = null;   // { token, expiresAt }

/**
 * Devuelve un access token válido, renovándolo si hace falta.
 * @returns {Promise<string>}
 */
async function getAccessToken() {
  const config = assertPayPalConfigured();
  const now = Date.now();

  if (tokenCache && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

  try {
    const res = await fetch(`${config.apiBase}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
      signal: controller.signal,
    });

    const text = await res.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }

    if (!res.ok || !payload || !payload.access_token) {
      throw new PayPalApiError(
        'No pudimos autenticar contra PayPal.',
        res.status,
        'paypal_auth_failed',
        { status: res.status, name: payload && payload.name }
      );
    }

    const expiresIn = Number(payload.expires_in) || 3600;
    tokenCache = {
      token: String(payload.access_token),
      expiresAt: now + Math.max(0, (expiresIn - CFG.tokenSafetyMarginSec)) * 1000,
    };

    return tokenCache.token;
  } catch (err) {
    if (err instanceof PayPalApiError) throw err;
    const aborted = err && err.name === 'AbortError';
    throw new PayPalApiError(
      aborted
        ? 'PayPal no respondió a tiempo al autenticar.'
        : 'Error de red al autenticar con PayPal.',
      0,
      aborted ? 'paypal_timeout' : 'paypal_network_error',
      null
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Invalida el token cacheado (se usa tras un 401 de PayPal). */
export function invalidateAccessToken() {
  tokenCache = null;
}

/* ═══════════════════════════════════════════════════════════════════════
   3 · REQUEST GENÉRICA
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Ejecuta una llamada a la API de PayPal con:
 *   · Authorization Bearer (token cacheado)
 *   · timeout
 *   · retry exponencial ante 5xx / error de red
 *   · `PayPal-Request-Id` para trazabilidad (idempotencia del lado PayPal)
 *
 * @param {string} path            Ruta relativa, ej. '/v2/checkout/orders'
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {object} [opts.body]
 * @param {object} [opts.headers]
 * @param {boolean}[opts.retry=true]
 * @returns {Promise<object>} Payload JSON de PayPal.
 */
async function paypalRequest(path, opts = {}) {
  const {
    method = 'GET',
    body = null,
    headers = {},
    retry = true,
  } = opts;

  const config = assertPayPalConfigured();
  const maxAttempts = retry ? CFG.maxRetries + 1 : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const token = await getAccessToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

    const init = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'PayPal-Request-Id': crypto.randomUUID(),
        ...headers,
      },
      signal: controller.signal,
    };

    if (body !== null && body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    try {
      const res = await fetch(`${config.apiBase}${path}`, init);
      const text = await res.text();

      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }

      if (res.ok) return payload || {};

      // 401 → el token pudo expirar: se invalida y se reintenta una vez.
      if (res.status === 401 && attempt < maxAttempts) {
        invalidateAccessToken();
        lastError = new PayPalApiError('Credenciales de PayPal rechazadas.', 401, 'paypal_unauthorized', null);
        await sleep(CFG.retryBaseMs * attempt);
        continue;
      }

      // 5xx / 429 → transitorio: reintento con backoff.
      if (retry && (res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        lastError = new PayPalApiError(
          `PayPal respondió ${res.status}.`,
          res.status,
          'paypal_transient',
          { status: res.status, name: payload && payload.name }
        );
        await sleep(CFG.retryBaseMs * Math.pow(2, attempt - 1));
        continue;
      }

      const message = (payload && (payload.message || payload.name))
        || `PayPal respondió ${res.status}.`;
      throw new PayPalApiError(message, res.status, 'paypal_api_error', {
        status: res.status,
        name: payload && payload.name,
        debugId: payload && payload.debug_id,
        details: payload && payload.details,
      });
    } catch (err) {
      if (err instanceof PayPalApiError) {
        lastError = err;
        // Reintentable solo si es transitorio.
        const transient = err.code === 'paypal_transient';
        if (transient && attempt < maxAttempts) {
          await sleep(CFG.retryBaseMs * Math.pow(2, attempt - 1));
          continue;
        }
        throw err;
      }

      const aborted = err && err.name === 'AbortError';
      lastError = new PayPalApiError(
        aborted ? 'PayPal no respondió a tiempo.' : 'Error de red con PayPal.',
        0,
        aborted ? 'paypal_timeout' : 'paypal_network_error',
        null
      );

      if (attempt < maxAttempts) {
        await sleep(CFG.retryBaseMs * Math.pow(2, attempt - 1));
        continue;
      }
      throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new PayPalApiError('Error inesperado con PayPal.', 0, 'paypal_unknown', null);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · ÓRDENES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Crea una orden en PayPal.
 *
 * @param {object} params
 * @param {number} params.amount        Importe en la moneda indicada.
 * @param {string} params.currency      Moneda ISO (por defecto USD).
 * @param {string} params.description   Descripción visible en el checkout.
 * @param {string} params.referenceId   Referencia interna (orderId de Numination).
 * @param {string} [params.customId]    custom_id devuelto en los webhooks.
 * @returns {Promise<object>} Respuesta de PayPal (contiene `id`).
 */
export async function createPayPalOrder(params = {}) {
  const {
    amount,
    currency,
    description = 'Suscripción Numination',
    referenceId,
    customId,
  } = params;

  const config = assertPayPalConfigured();
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new PayPalApiError('El importe de la orden debe ser un número mayor que 0.', 400, 'invalid_amount', null);
  }

  const body = {
    intent: 'CAPTURE',
    purchase_units: [
      {
        reference_id: String(referenceId || crypto.randomUUID()),
        custom_id: String(customId || referenceId || ''),
        description: String(description).slice(0, 127),
        amount: {
          currency_code: String(currency || config.currency || 'USD').toUpperCase(),
          value: value.toFixed(2),
        },
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'Numination',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
        },
      },
    },
  };

  return paypalRequest('/v2/checkout/orders', { method: 'POST', body, retry: true });
}

/**
 * Captura (cobra) una orden de PayPal ya aprobada.
 *
 * @param {string} orderId  ID de la orden de PayPal.
 * @returns {Promise<object>} Captura con el estado y el desglose.
 */
export async function capturePayPalOrder(orderId) {
  const clean = String(orderId || '').trim();
  if (!/^[A-Z0-9]{6,32}$/i.test(clean)) {
    throw new PayPalApiError('orderId de PayPal inválido.', 400, 'invalid_paypal_order_id', null);
  }
  return paypalRequest(`/v2/checkout/orders/${encodeURIComponent(clean)}/capture`, {
    method: 'POST',
    body: {},
    retry: true,
  });
}

/**
 * Extrae el estado y los datos relevantes de una captura de PayPal.
 * @param {object} capture
 * @returns {{status:string, orderId:string|null, captureId:string|null, amount:number|null,
 *            currency:string|null, payerEmail:string|null, customId:string|null}}
 */
export function summarizeCapture(capture) {
  const out = {
    status: 'UNKNOWN',
    orderId: null,
    captureId: null,
    amount: null,
    currency: null,
    payerEmail: null,
    customId: null,
  };
  if (!capture || typeof capture !== 'object') return out;

  out.status = String(capture.status || 'UNKNOWN');
  out.orderId = capture.id ? String(capture.id) : null;

  const unit = Array.isArray(capture.purchase_units) ? capture.purchase_units[0] : null;
  if (unit) {
    const payments = Array.isArray(unit.payments) ? unit.payments : [];
    const captured = payments.find((p) => p && p.status === 'COMPLETED') || payments[0];
    if (captured && captured.amount) {
      const raw = Number(captured.amount.value);
      out.amount = Number.isFinite(raw) ? raw : null;
      out.currency = captured.amount.currency_code || null;
      out.captureId = captured.id ? String(captured.id) : null;
    }
    if (unit.custom_id) out.customId = String(unit.custom_id);
  }

  const payer = capture.payer || (unit && unit.payer) || null;
  if (payer && payer.email_address) out.payerEmail = String(payer.email_address);

  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · VERIFICACIÓN DE FIRMA DE WEBHOOK
   ═══════════════════════════════════════════════════════════════════════ */

/** Headers que PayPal envía con cada webhook y que son obligatorios. */
export const WEBHOOK_REQUIRED_HEADERS = Object.freeze([
  'paypal-transmission-id',
  'paypal-transmission-sig',
  'paypal-transmission-time',
  'paypal-cert-url',
  'paypal-auth-algo',
]);

/**
 * Valida que el cert_url venga del dominio oficial de PayPal.
 * (Higiene anti-abuso: el cert_url nunca se descarga desde esta app; solo se
 *  valida que apunte al dominio de PayPal antes de enviarlo a la API.)
 */
export function isPayPalCertUrl(url) {
  try {
    const parsed = new URL(String(url));
    const host = parsed.hostname.toLowerCase();
    return host === 'paypal.com'
      || host.endsWith('.paypal.com')
      || host === 'paypalobjects.com'
      || host.endsWith('.paypalobjects.com');
  } catch {
    return false;
  }
}

/**
 * Verifica la firma de un webhook contra el endpoint oficial de PayPal.
 * FAIL-CLOSED: cualquier duda → `verified: false`.
 *
 * @param {object} params
 * @param {object} params.headers       Headers de la request (req.headers).
 * @param {object} params.webhookEvent  Evento ya parseado.
 * @param {string} [params.rawBody]     Body crudo (para auditoría).
 * @returns {Promise<{verified:boolean, status:string, reason:string|null}>}
 */
export async function verifyWebhookSignature(params = {}) {
  const { headers = {}, webhookEvent = null, rawBody = '' } = params;

  const get = (name) => {
    const value = headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
    return typeof value === 'string' ? value.trim() : '';
  };

  const transmissionId = get('paypal-transmission-id');
  const transmissionSig = get('paypal-transmission-sig');
  const transmissionTime = get('paypal-transmission-time');
  const certUrl = get('paypal-cert-url');
  const authAlgo = get('paypal-auth-algo');

  const missing = [];
  if (!transmissionId) missing.push('PAYPAL-TRANSMISSION-ID');
  if (!transmissionSig) missing.push('PAYPAL-TRANSMISSION-SIG');
  if (!transmissionTime) missing.push('PAYPAL-TRANSMISSION-TIME');
  if (!certUrl) missing.push('PAYPAL-CERT-URL');
  if (!authAlgo) missing.push('PAYPAL-AUTH-ALGO');

  if (missing.length) {
    return {
      verified: false,
      status: 'MISSING_HEADERS',
      reason: `Faltan headers de verificación: ${missing.join(', ')}.`,
    };
  }

  if (!isPayPalCertUrl(certUrl)) {
    return {
      verified: false,
      status: 'INVALID_CERT_URL',
      reason: 'El cert-url no pertenece al dominio de PayPal.',
    };
  }

  if (!webhookEvent || typeof webhookEvent !== 'object') {
    return {
      verified: false,
      status: 'INVALID_EVENT',
      reason: 'El cuerpo del webhook no es un evento válido.',
    };
  }

  let config;
  try {
    config = assertPayPalConfigured();
  } catch {
    return {
      verified: false,
      status: 'NOT_CONFIGURED',
      reason: 'PayPal no está configurado en el servidor.',
    };
  }

  const body = {
    transmission_id: transmissionId,
    transmission_time: transmissionTime,
    transmission_sig: transmissionSig,
    cert_url: certUrl,
    auth_algo: authAlgo,
    webhook_id: config.webhookId,
    webhook_event: webhookEvent,
  };

  try {
    const result = await paypalRequest('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body,
      retry: false,   // una verificación fallida no se reintenta: es una decisión
    });

    const status = String((result && result.verification_status) || 'FAILURE').toUpperCase();
    const verified = status === 'SUCCESS';

    return {
      verified,
      status,
      reason: verified ? null : 'La firma del webhook no pudo verificarse.',
    };
  } catch (err) {
    // Fail-closed: si no se pudo verificar, no se procesa el evento.
    return {
      verified: false,
      status: 'VERIFICATION_ERROR',
      reason: err && err.message ? String(err.message).slice(0, 200) : 'Error verificando la firma.',
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · CONFIG PÚBLICA (para el frontend)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Datos públicos del SDK. El client-id de PayPal ES público por diseño
 * (viaja en el HTML del checkout); el secret NUNCA sale del servidor.
 */
export function getPublicConfig() {
  const config = assertPayPalConfigured();
  return {
    clientId: config.clientId,
    currency: config.currency,
    environment: config.environment,
    sdkBase: config.sdkBase,
  };
}

/** Estado de salud del módulo de pagos (para /api/health). */
export function paypalHealth() {
  try {
    const config = assertPayPalConfigured();
    return {
      ok: true,
      environment: config.environment,
      clientIdMasked: mask(config.clientId),
      webhookIdMasked: mask(config.webhookId),
      tokenCached: Boolean(tokenCache),
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? String(err.message).slice(0, 200) : 'PayPal no configurado.',
      missing: err && Array.isArray(err.missing) ? err.missing : [],
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  rec('mask oculta el secreto', mask('ABCDEFGHIJ').endsWith('HIJ') && !mask('ABCDEFGHIJ').includes('ABC'), mask('ABCDEFGHIJ'));
  rec('mask de vacío', mask('') === '[unset]', mask(''));
  rec('cert-url de paypal aceptado', isPayPalCertUrl('https://api.paypal.com/cert.pem'), true);
  rec('cert-url ajeno rechazado', !isPayPalCertUrl('https://evil.example.com/cert.pem'), true);
  rec('cert-url malformado rechazado', !isPayPalCertUrl('not-a-url'), true);
  rec('summarizeCapture con null', summarizeCapture(null).status === 'UNKNOWN', true);

  const summary = summarizeCapture({
    id: 'ORDER123',
    status: 'COMPLETED',
    purchase_units: [{
      payments: [{ id: 'CAP1', status: 'COMPLETED', amount: { currency_code: 'USD', value: '7.50' } }],
    }],
  });
  rec('summarizeCapture toma el importe', summary.amount === 7.5, summary);
  rec('summarizeCapture toma la moneda', summary.currency === 'USD', summary);

  const passed = results.filter((r) => r.ok).length;
  return { passed, total: results.length, ok: passed === results.length, results };
}
