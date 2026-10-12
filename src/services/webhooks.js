/* ================================================================
   NUMINATION · webhooks.js · v1.0
   ----------------------------------------------------------------
   Sistema de webhooks OUTBOUND para integraciones externas.

   ¿POR QUÉ EXISTE?
   Numination ya notifica a usuarios (notifications.js). Pero hay
   sistemas externos que necesitan saber cuándo pasa algo:

     · Un bot de Discord que avisa al canal cuando entra un usuario
     · Un dashboard de analytics propio que escucha cada mensaje
     · Una integración con Zapier/Make/n8n
     · Un sistema de tickets que reacciona a errores
     · Tu propio monitoring (Grafana, Datadog, etc.)

   Este módulo permite que usuarios registren URLs y Numination les
   mande POSTs firmados cada vez que ocurre un evento suscrito.

   CARACTERÍSTICAS:

     · Subscripciones con CRUD completo
     · Filtrado por tipo de evento (wildcards soportados)
     · Firma HMAC-SHA256 para verificar autenticidad
     · Reintentos con backoff exponencial (1s, 5s, 25s)
     · Dead letter queue para deliveries fallidos
     · Historial de deliveries por subscription
     · Rate limiting por webhook (no spamear al receptor)
     · Detección de endpoints caídos (auto-disable)
     · Delivery IDs idempotentes
     · Filtros por metadata (ej. solo plan=premium)

   ESTRUCTURA:

     1  · Configuración
     2  · Catálogo de eventos soportados
     3  · Modelo de subscription
     4  · Cliente Redis
     5  · Firma HMAC
     6  · HTTP delivery con reintentos
     7  · Queue en memoria + batching
     8  · Rate limiting por webhook
     9  · Auto-disable por fallos
    10  · CRUD de subscriptions
    11  · dispatch() - emitir evento
    12  · Historial de deliveries
    13  · Dead letter queue
    14  · Reintentos manuales
    15  · Helper de verificación para receptores
    16  · Health check
    17  · Self-test
    18  · Exports

   USO BÁSICO:

     import { dispatch, EVENTS } from './services/webhooks.js';

     // Emitir evento (fire-and-forget)
     dispatch(EVENTS.CHAT_CREATED, {
       userId: 'abc-123',
       data: { chatId: 'chat-456', title: 'Mi chat' },
     });

   REGISTRAR UN WEBHOOK (desde un endpoint):

     const sub = await createSubscription(userId, {
       url: 'https://mi-app.com/webhooks/numination',
       events: ['chat.*', 'user.signup'],
       description: 'Mi integración',
     });

     console.log('Secret (guardalo):', sub.secret);

   VERIFICAR EN EL RECEPTOR (Node.js):

     import { verifySignature } from './services/webhooks.js';

     app.post('/webhooks/numination', (req, res) => {
       const signature = req.headers['x-numination-signature'];
       const timestamp = req.headers['x-numination-timestamp'];
       const body = JSON.stringify(req.body);

       if (!verifySignature(signature, timestamp, body, SECRET)) {
         return res.status(401).send('Invalid signature');
       }

       // Procesar evento
       console.log('Evento:', req.body.event);
       res.status(200).send('OK');
     });

   ================================================================ */

import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  /* Máximo de subscriptions activas por usuario */
  maxSubscriptionsPerUser: 10,

  /* Máximo de subscriptions totales (para evitar abuso global) */
  maxSubscriptionsGlobal: 1000,

  /* Firma HMAC */
  signatureHeader: 'X-Numination-Signature',
  timestampHeader: 'X-Numination-Timestamp',
  deliveryIdHeader: 'X-Numination-Delivery-Id',
  eventHeader: 'X-Numination-Event',
  subscriptionHeader: 'X-Numination-Subscription-Id',

  /* Tolerancia de replay (5 min) */
  replayToleranceSec: 300,

  /* Timeout por delivery HTTP */
  deliveryTimeoutMs: 10_000,

  /* Reintentos: 3 intentos totales (1 original + 2 retries) */
  maxAttempts: 3,

  /* Backoff exponencial entre reintentos */
  backoffBaseMs: 1000,
  backoffMultiplier: 5,

  /* Rate limit por webhook (para no saturar al receptor) */
  rateLimitPerMinute: 60,

  /* Cuántos fallos consecutivos antes de auto-deshabilitar */
  autoDisableAfterFailures: 10,

  /* TTL de deliveries en el log */
  deliveryLogTtlSec: 30 * 86400,   // 30 días

  /* TTL de DLQ */
  dlqTtlSec: 7 * 86400,            // 7 días

  /* Máximo de deliveries en el log por subscription */
  deliveryLogMax: 100,

  /* Tamaño máximo del payload (bytes) */
  maxPayloadBytes: 256 * 1024,      // 256 KB

  /* Cuántos eventos agrupar antes de flush */
  queueBatchSize: 10,

  /* Intervalo de flush */
  queueFlushIntervalMs: 500,

  /* User-Agent que enviamos */
  userAgent: 'Numination-Webhooks/1.0',
});

/* ═══════════════════════════════════════════════════════════════════════
   2 · CATÁLOGO DE EVENTOS
   ═══════════════════════════════════════════════════════════════════════
   Taxonomía cerrada. Los wildcards se resuelven contra esto.
   ═══════════════════════════════════════════════════════════════════════ */

export const EVENTS = Object.freeze({
  /* ─── Chat ─── */
  CHAT_CREATED:          'chat.created',
  CHAT_DELETED:          'chat.deleted',
  CHAT_RENAMED:          'chat.renamed',
  CHAT_MESSAGE_SENT:     'chat.message.sent',
  CHAT_MESSAGE_RECEIVED: 'chat.message.received',
  CHAT_ABORTED:          'chat.aborted',

  /* ─── Usuario ─── */
  USER_SIGNUP:           'user.signup',
  USER_LOGIN:            'user.login',
  USER_LOGOUT:           'user.logout',
  USER_UPDATED:          'user.updated',
  USER_DELETED:          'user.deleted',
  USER_EMAIL_VERIFIED:   'user.email.verified',
  USER_PASSWORD_CHANGED: 'user.password.changed',

  /* ─── Límites ─── */
  LIMIT_WARNING:         'limit.warning',
  LIMIT_REACHED:         'limit.reached',
  LIMIT_RESET:           'limit.reset',
  LIMIT_UPGRADED:        'limit.upgraded',

  /* ─── Memorias ─── */
  MEMORY_CREATED:        'memory.created',
  MEMORY_UPDATED:        'memory.updated',
  MEMORY_DELETED:        'memory.deleted',

  /* ─── Proyectos ─── */
  PROJECT_CREATED:       'project.created',
  PROJECT_UPDATED:       'project.updated',
  PROJECT_DELETED:       'project.deleted',

  /* ─── IA ─── */
  AI_FALLBACK:           'ai.fallback',
  AI_ALL_FAILED:         'ai.all_failed',
  AI_RATE_LIMITED:       'ai.rate_limited',

  /* ─── Sistema (solo admins) ─── */
  ENGINE_DOWN:           'system.engine.down',
  ENGINE_UP:             'system.engine.up',
  DB_SLOW:               'system.db.slow',
  ABUSE_DETECTED:        'system.abuse.detected',

  /* ─── Billing ─── */
  PLAN_UPGRADED:         'billing.plan.upgraded',
  PLAN_DOWNGRADED:       'billing.plan.downgraded',
  PAYMENT_RECEIVED:      'billing.payment.received',
});

/**
 * Lista plana de eventos disponibles.
 */
export const ALL_EVENTS = Object.freeze(Object.values(EVENTS));

/**
 * Valida que un string sea un evento o wildcard válido.
 * Acepta: 'chat.created', 'chat.*', '*'
 */
function isValidEventPattern(pattern) {
  if (pattern === '*') return true;
  if (typeof pattern !== 'string') return false;
  if (!pattern.includes('*')) {
    return ALL_EVENTS.includes(pattern);
  }
  // Wildcard: 'chat.*' debe matchear al menos un evento
  const regex = patternToRegex(pattern);
  return ALL_EVENTS.some((e) => regex.test(e));
}

/**
 * Convierte 'chat.*' en regex.
 */
function patternToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$');
}

/**
 * ¿El evento `evt` matchea alguno de los patterns?
 */
function eventMatches(evt, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  for (const p of patterns) {
    if (p === '*') return true;
    if (p === evt) return true;
    if (p.includes('*') && patternToRegex(p).test(evt)) return true;
  }
  return false;
}

/* ═══════════════════════════════════════════════════════════════════════
   3 · MODELO DE SUBSCRIPTION
   ═══════════════════════════════════════════════════════════════════════
   {
     id: 'sub_abc123',
     userId: 'user-uuid',
     url: 'https://mi-app.com/webhook',
     secret: 'whsec_hex64',
     events: ['chat.created', 'user.signup'],
     description: 'Mi integración',
     active: true,
     createdAt: ISO string,
     lastDeliveryAt: ISO string | null,
     lastStatus: 200 | null,
     consecutiveFailures: 0,
     totalDeliveries: 123,
     totalFailures: 5,
     filters: { plan: 'premium' } | null,
     metadata: { source: 'dashboard' },
   }
   ═══════════════════════════════════════════════════════════════════════ */

function generateId() {
  return 'sub_' + crypto.randomBytes(12).toString('hex');
}

function generateSecret() {
  return 'whsec_' + crypto.randomBytes(32).toString('hex');
}

function generateDeliveryId() {
  return 'dlv_' + crypto.randomBytes(16).toString('hex');
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · CLIENTE REDIS
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
      signal: AbortSignal.timeout(5000),
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
   5 · FIRMA HMAC
   ═══════════════════════════════════════════════════════════════════════
   El receptor verifica que el payload viene de Numination comparando
   la firma HMAC-SHA256 del body con el secret compartido.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Genera la firma HMAC-SHA256 del payload.
 * Formato: sha256=<hex>
 *
 * El mensaje firmado incluye el timestamp para prevenir replay:
 *   ${timestamp}.${body}
 */
export function signPayload(secret, timestamp, body) {
  const payload = `${timestamp}.${body}`;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload, 'utf8');
  return 'sha256=' + hmac.digest('hex');
}

/**
 * Verifica una firma entrante.
 * Uso desde el receptor del webhook.
 *
 * @param {string} signature  · valor del header X-Numination-Signature
 * @param {string} timestamp  · valor del header X-Numination-Timestamp (unix ms)
 * @param {string} body       · body crudo (string, no objeto parseado)
 * @param {string} secret     · el secret compartido
 * @returns {boolean}
 */
export function verifySignature(signature, timestamp, body, secret) {
  if (!signature || !timestamp || !body || !secret) return false;

  // Verificar tolerancia de replay
  const ts = parseInt(timestamp, 10);
  if (!isFinite(ts)) return false;
  const ageSec = Math.abs(Date.now() - ts) / 1000;
  if (ageSec > CFG.replayToleranceSec) return false;

  // Comparar firmas en tiempo constante
  const expected = signPayload(secret, timestamp, body);
  if (signature.length !== expected.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expected, 'utf8'),
    );
  } catch {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · HTTP DELIVERY
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Envía un POST a la URL del webhook con firma y headers.
 * Devuelve { ok, status, durationMs, error, responseBody }
 */
async function deliverOnce(subscription, event, payload, deliveryId) {
  const timestamp = String(Date.now());
  const body = JSON.stringify(payload);
  const signature = signPayload(subscription.secret, timestamp, body);

  const t0 = Date.now();
  let status = 0;
  let error = null;
  let responseBody = '';

  try {
    const res = await fetch(subscription.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': CFG.userAgent,
        [CFG.signatureHeader]: signature,
        [CFG.timestampHeader]: timestamp,
        [CFG.deliveryIdHeader]: deliveryId,
        [CFG.eventHeader]: event,
        [CFG.subscriptionHeader]: subscription.id,
      },
      body,
      signal: AbortSignal.timeout(CFG.deliveryTimeoutMs),
      // Evitar que el fetch siga redirects (evita SSRF bypass)
      redirect: 'manual',
    });

    status = res.status;

    // Leer respuesta (limitada a 500 chars para no llenar logs)
    try {
      const text = await res.text();
      responseBody = String(text).slice(0, 500);
    } catch {}

  } catch (e) {
    error = e?.message || 'network_error';
  }

  const durationMs = Date.now() - t0;
  const ok = status >= 200 && status < 300;

  return { ok, status, durationMs, error, responseBody };
}

/**
 * Delivery con reintentos exponenciales.
 * Backoff: 1s, 5s, 25s (base 1s × 5^n)
 */
async function deliverWithRetry(subscription, event, payload, deliveryId) {
  let lastResult = null;

  for (let attempt = 0; attempt < CFG.maxAttempts; attempt++) {
    if (attempt > 0) {
      const delay = CFG.backoffBaseMs * Math.pow(CFG.backoffMultiplier, attempt - 1);
      await sleep(delay);
    }

    lastResult = await deliverOnce(subscription, event, payload, deliveryId);

    if (lastResult.ok) {
      return { ...lastResult, attempts: attempt + 1 };
    }

    // Errores 4xx (excepto 408/429) no se reintentan
    if (lastResult.status >= 400 && lastResult.status < 500) {
      if (lastResult.status !== 408 && lastResult.status !== 429) {
        return { ...lastResult, attempts: attempt + 1, permanent: true };
      }
    }
  }

  return { ...lastResult, attempts: CFG.maxAttempts };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═══════════════════════════════════════════════════════════════════════
   7 · QUEUE EN MEMORIA + BATCHING
   ═══════════════════════════════════════════════════════════════════════ */

const queue = [];
let flushTimer = null;
let stats = {
  dispatched: 0,
  delivered: 0,
  failed: 0,
  retried: 0,
  dlq: 0,
  skipped: 0,
  byEvent: new Map(),
  lastFlushAt: null,
  lastErrorAt: null,
};

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushQueue().catch(() => {});
  }, CFG.queueFlushIntervalMs);
  if (flushTimer.unref) flushTimer.unref();
}

async function flushQueue() {
  if (queue.length === 0) return { ok: true, count: 0 };

  const batch = queue.splice(0, queue.length);
  let delivered = 0;
  let failed = 0;

  // Ejecutar en paralelo controlado (máx 5 concurrent)
  const CONCURRENCY = 5;
  for (let i = 0; i < batch.length; i += CONCURRENCY) {
    const slice = batch.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map((job) => executeDelivery(job)));
    for (const r of results) {
      if (r.ok) delivered++;
      else failed++;
    }
  }

  stats.lastFlushAt = Date.now();
  if (failed > 0) stats.lastErrorAt = Date.now();

  return { ok: true, count: batch.length, delivered, failed };
}

/**
 * Ejecuta el delivery de un job encolado.
 */
async function executeDelivery(job) {
  const { subscription, event, payload, deliveryId } = job;

  // Rate limiting por webhook
  const allowed = await checkWebhookRate(subscription.id);
  if (!allowed) {
    stats.skipped++;
    return { ok: false, reason: 'rate_limited' };
  }

  // Delivery con reintentos
  const result = await deliverWithRetry(subscription, event, payload, deliveryId);

  // Registrar en log de deliveries
  await recordDelivery(subscription.id, {
    id: deliveryId,
    event,
    ok: result.ok,
    status: result.status,
    durationMs: result.durationMs,
    attempts: result.attempts,
    error: result.error,
    at: new Date().toISOString(),
  }).catch(() => {});

  // Actualizar estado de la subscription
  await updateSubscriptionHealth(subscription.id, {
    ok: result.ok,
    status: result.status,
    permanent: result.permanent,
  }).catch(() => {});

  // Si falló todos los reintentos y no es 4xx permanente → DLQ
  if (!result.ok && !result.permanent) {
    await pushToDlq(subscription.id, job, result).catch(() => {});
    stats.dlq++;
  }

  if (result.ok) {
    stats.delivered++;
    if (result.attempts > 1) stats.retried++;
  } else {
    stats.failed++;
  }

  return result;
}

/* ═══════════════════════════════════════════════════════════════════════
   8 · RATE LIMITING POR WEBHOOK
   ═══════════════════════════════════════════════════════════════════════ */

async function checkWebhookRate(subscriptionId) {
  const u = getUpstash();
  if (!u) return true;

  const now = new Date();
  const minKey = `webhook:rate:${subscriptionId}:${now.toISOString().slice(0, 16)}`;

  const r = await pipeline([
    ['INCR', minKey],
    ['EXPIRE', minKey, '60', 'NX'],
  ]);

  if (!r.ok) return true;
  const count = Number(r.result[0]?.result) || 0;
  return count <= CFG.rateLimitPerMinute;
}

/* ═══════════════════════════════════════════════════════════════════════
   9 · AUTO-DISABLE POR FALLOS
   ═══════════════════════════════════════════════════════════════════════ */

async function updateSubscriptionHealth(subscriptionId, { ok, status, permanent }) {
  const sub = await getSubscription(subscriptionId);
  if (!sub) return;

  if (ok) {
    // Reset al primer éxito
    sub.consecutiveFailures = 0;
    sub.totalDeliveries = (sub.totalDeliveries || 0) + 1;
    sub.lastStatus = status;
    sub.lastDeliveryAt = new Date().toISOString();
  } else {
    sub.consecutiveFailures = (sub.consecutiveFailures || 0) + 1;
    sub.totalFailures = (sub.totalFailures || 0) + 1;
    sub.lastStatus = status;
    sub.lastDeliveryAt = new Date().toISOString();

    // Auto-disable si supera el umbral
    if (sub.consecutiveFailures >= CFG.autoDisableAfterFailures) {
      sub.active = false;
      sub.disabledAt = new Date().toISOString();
      sub.disabledReason = 'too_many_failures';
      console.warn(`[webhook] ${sub.id} auto-deshabilitado tras ${sub.consecutiveFailures} fallos`);
    }
  }

  await saveSubscription(sub);
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · CRUD DE SUBSCRIPTIONS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Crea una nueva subscription.
 *
 * @param {string} userId
 * @param {object} opts
 * @param {string} opts.url          · URL destino (debe ser HTTPS)
 * @param {string[]} opts.events     · eventos a suscribirse
 * @param {string} [opts.description]
 * @param {object} [opts.filters]    · filtros por metadata
 * @returns {Promise<object>}
 */
export async function createSubscription(userId, opts = {}) {
  if (!userId) return { ok: false, error: 'no_userId' };

  // Validar URL
  const url = String(opts.url || '').trim();
  if (!url) return { ok: false, error: 'missing_url' };
  if (!/^https:\/\//.test(url)) {
    return { ok: false, error: 'https_required' };
  }
  try {
    const u = new URL(url);
    // Bloquear IPs privadas (SSRF)
    if (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0)/.test(u.hostname)) {
      return { ok: false, error: 'private_url_not_allowed' };
    }
  } catch {
    return { ok: false, error: 'invalid_url' };
  }

  // Validar eventos
  const events = Array.isArray(opts.events) ? opts.events : [];
  if (events.length === 0) return { ok: false, error: 'no_events' };
  if (events.length > 30) return { ok: false, error: 'too_many_events' };

  for (const e of events) {
    if (!isValidEventPattern(e)) {
      return { ok: false, error: `invalid_event:${e}` };
    }
  }

  // Límite de subscriptions por usuario
  const userSubs = await listSubscriptions(userId);
  if (userSubs.length >= CFG.maxSubscriptionsPerUser) {
    return { ok: false, error: 'limit_reached_per_user' };
  }

  // Límite global
  const total = await countSubscriptions();
  if (total >= CFG.maxSubscriptionsGlobal) {
    return { ok: false, error: 'limit_reached_global' };
  }

  const sub = {
    id: generateId(),
    userId,
    url,
    secret: generateSecret(),
    events,
    description: String(opts.description || '').slice(0, 100),
    filters: opts.filters || null,
    metadata: opts.metadata || {},
    active: true,
    createdAt: new Date().toISOString(),
    lastDeliveryAt: null,
    lastStatus: null,
    consecutiveFailures: 0,
    totalDeliveries: 0,
    totalFailures: 0,
  };

  const saved = await saveSubscription(sub);
  if (!saved) return { ok: false, error: 'save_failed' };

  // Indexar por usuario
  await pipeline([
    ['SADD', `webhook:user:${userId}:subs`, sub.id],
    ['SADD', 'webhook:all_subs', sub.id],
  ]);

  console.log(`[webhook] subscription creada · user=${userId.slice(0, 8)} · events=${events.length} · url=${url.slice(0, 60)}`);

  return { ok: true, subscription: { ...sub } };
}

/**
 * Obtiene una subscription.
 */
export async function getSubscription(id) {
  if (!id) return null;
  const r = await pipeline([['GET', `webhook:sub:${id}`]]);
  if (!r.ok || !r.result[0]?.result) return null;
  try {
    return JSON.parse(r.result[0].result);
  } catch {
    return null;
  }
}

/**
 * Guarda una subscription.
 */
async function saveSubscription(sub) {
  if (!sub || !sub.id) return false;
  const r = await pipeline([
    ['SET', `webhook:sub:${sub.id}`, JSON.stringify(sub)],
    ['EXPIRE', `webhook:sub:${sub.id}`, '31536000'],   // 1 año
  ]);
  return r.ok;
}

/**
 * Lista subscriptions de un usuario.
 */
export async function listSubscriptions(userId) {
  if (!userId) return [];
  const r = await pipeline([['SMEMBERS', `webhook:user:${userId}:subs`]]);
  if (!r.ok) return [];

  const ids = r.result[0]?.result || [];
  if (ids.length === 0) return [];

  const commands = ids.map((id) => ['GET', `webhook:sub:${id}`]);
  const r2 = await pipeline(commands);
  if (!r2.ok) return [];

  return r2.result
    .map((entry) => {
      try { return JSON.parse(entry?.result); } catch { return null; }
    })
    .filter(Boolean);
}

/**
 * Cuenta el total de subscriptions.
 */
async function countSubscriptions() {
  const r = await pipeline([['SCARD', 'webhook:all_subs']]);
  if (!r.ok) return 0;
  return Number(r.result[0]?.result) || 0;
}

/**
 * Actualiza una subscription.
 */
export async function updateSubscription(id, userId, patch = {}) {
  const sub = await getSubscription(id);
  if (!sub) return { ok: false, error: 'not_found' };
  if (sub.userId !== userId) return { ok: false, error: 'forbidden' };

  if (patch.description !== undefined) {
    sub.description = String(patch.description).slice(0, 100);
  }
  if (patch.events !== undefined) {
    const events = Array.isArray(patch.events) ? patch.events : [];
    if (events.length === 0) return { ok: false, error: 'no_events' };
    for (const e of events) {
      if (!isValidEventPattern(e)) {
        return { ok: false, error: `invalid_event:${e}` };
      }
    }
    sub.events = events;
  }
  if (patch.active !== undefined) {
    sub.active = Boolean(patch.active);
    if (sub.active) {
      sub.consecutiveFailures = 0;
      sub.disabledReason = null;
    }
  }
  if (patch.filters !== undefined) {
    sub.filters = patch.filters;
  }
  if (patch.url !== undefined) {
    const url = String(patch.url).trim();
    if (!/^https:\/\//.test(url)) return { ok: false, error: 'https_required' };
    sub.url = url;
  }

  sub.updatedAt = new Date().toISOString();
  const ok = await saveSubscription(sub);
  return ok ? { ok: true, subscription: sub } : { ok: false, error: 'save_failed' };
}

/**
 * Elimina una subscription.
 */
export async function deleteSubscription(id, userId) {
  const sub = await getSubscription(id);
  if (!sub) return { ok: false, error: 'not_found' };
  if (sub.userId !== userId) return { ok: false, error: 'forbidden' };

  await pipeline([
    ['DEL', `webhook:sub:${id}`],
    ['DEL', `webhook:sub:${id}:deliveries`],
    ['DEL', `webhook:sub:${id}:dlq`],
    ['SREM', `webhook:user:${userId}:subs`, id],
    ['SREM', 'webhook:all_subs', id],
  ]);

  console.log(`[webhook] subscription eliminada · id=${id}`);
  return { ok: true };
}

/**
 * Rota el secret (invalidación inmediata).
 */
export async function rotateSecret(id, userId) {
  const sub = await getSubscription(id);
  if (!sub) return { ok: false, error: 'not_found' };
  if (sub.userId !== userId) return { ok: false, error: 'forbidden' };

  sub.secret = generateSecret();
  sub.rotatedAt = new Date().toISOString();
  await saveSubscription(sub);

  return { ok: true, secret: sub.secret };
}

/* ═══════════════════════════════════════════════════════════════════════
   11 · DISPATCH · emitir un evento
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Emite un evento a todas las subscriptions activas que lo escuchen.
 *
 * @param {string} event      · uno de EVENTS
 * @param {object} opts
 * @param {string} [opts.userId]   · si se especifica, solo a ese usuario
 * @param {object} [opts.data]     · payload del evento
 * @param {object} [opts.metadata] · para filtros
 * @returns {Promise<{ok: boolean, dispatched: number}>}
 */
export async function dispatch(event, opts = {}) {
  try {
    if (!ALL_EVENTS.includes(event)) {
      return { ok: false, error: 'unknown_event', dispatched: 0 };
    }

    // Buscar subscriptions
    let subs = [];
    if (opts.userId) {
      subs = await listSubscriptions(opts.userId);
    } else {
      subs = await listAllActiveSubscriptions();
    }

    // Filtrar
    const matching = subs.filter((sub) => {
      if (!sub.active) return false;
      if (!eventMatches(event, sub.events)) return false;
      if (!applyFilters(sub.filters, opts.metadata)) return false;
      return true;
    });

    if (matching.length === 0) {
      stats.dispatched++;
      return { ok: true, dispatched: 0 };
    }

    // Payload común
    const payload = {
      id: generateDeliveryId(),
      event,
      timestamp: new Date().toISOString(),
      userId: opts.userId || null,
      data: opts.data || {},
      version: '1.0',
    };

    // Encolar delivery por cada subscription
    for (const sub of matching) {
      queue.push({
        subscription: sub,
        event,
        payload: { ...payload, subscriptionId: sub.id },
        deliveryId: payload.id,
      });
    }

    stats.dispatched++;
    stats.byEvent.set(event, (stats.byEvent.get(event) || 0) + matching.length);

    if (queue.length >= CFG.queueBatchSize) {
      flushQueue().catch(() => {});
    } else {
      scheduleFlush();
    }

    return { ok: true, dispatched: matching.length };
  } catch (e) {
    stats.failed++;
    return { ok: false, error: e?.message || 'unknown', dispatched: 0 };
  }
}

/**
 * Lista todas las subscriptions activas (global).
 */
async function listAllActiveSubscriptions() {
  const r = await pipeline([['SMEMBERS', 'webhook:all_subs']]);
  if (!r.ok) return [];
  const ids = r.result[0]?.result || [];
  if (ids.length === 0) return [];

  const commands = ids.map((id) => ['GET', `webhook:sub:${id}`]);
  const r2 = await pipeline(commands);
  if (!r2.ok) return [];

  return r2.result
    .map((entry) => {
      try { return JSON.parse(entry?.result); } catch { return null; }
    })
    .filter((s) => s && s.active);
}

/**
 * Aplica filtros de metadata.
 */
function applyFilters(filters, metadata) {
  if (!filters) return true;
  if (!metadata) return false;
  for (const [k, v] of Object.entries(filters)) {
    if (metadata[k] !== v) return false;
  }
  return true;
}

/**
 * Dispatch síncrono (espera a que se entregue).
 * Útil para tests o para eventos críticos.
 */
export async function dispatchNow(event, opts = {}) {
  const result = await dispatch(event, opts);
  await flushQueue();
  return result;
}

/* ═══════════════════════════════════════════════════════════════════════
   12 · HISTORIAL DE DELIVERIES
   ═══════════════════════════════════════════════════════════════════════ */

async function recordDelivery(subscriptionId, delivery) {
  const key = `webhook:sub:${subscriptionId}:deliveries`;
  const commands = [
    ['LPUSH', key, JSON.stringify(delivery)],
    ['LTRIM', key, '0', String(CFG.deliveryLogMax - 1)],
    ['EXPIRE', key, String(CFG.deliveryLogTtlSec)],
  ];
  await pipeline(commands);
}

/**
 * Lista los últimos deliveries de una subscription.
 */
export async function getDeliveryLog(subscriptionId, { limit = 50 } = {}) {
  const key = `webhook:sub:${subscriptionId}:deliveries`;
  const r = await pipeline([['LRANGE', key, '0', String(limit - 1)]]);
  if (!r.ok) return [];

  return (r.result[0]?.result || [])
    .map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    })
    .filter(Boolean);
}

/* ═══════════════════════════════════════════════════════════════════════
   13 · DEAD LETTER QUEUE
   ═══════════════════════════════════════════════════════════════════════ */

async function pushToDlq(subscriptionId, job, result) {
  const key = `webhook:sub:${subscriptionId}:dlq`;
  const entry = {
    id: job.deliveryId,
    event: job.event,
    payload: job.payload,
    failedAt: new Date().toISOString(),
    attempts: result.attempts,
    lastStatus: result.status,
    lastError: result.error,
  };

  await pipeline([
    ['LPUSH', key, JSON.stringify(entry)],
    ['LTRIM', key, '0', '99'],
    ['EXPIRE', key, String(CFG.dlqTtlSec)],
  ]);
}

/**
 * Lista la dead letter queue de una subscription.
 */
export async function getDlq(subscriptionId, { limit = 50 } = {}) {
  const key = `webhook:sub:${subscriptionId}:dlq`;
  const r = await pipeline([['LRANGE', key, '0', String(limit - 1)]]);
  if (!r.ok) return [];

  return (r.result[0]?.result || [])
    .map((s) => {
      try { return JSON.parse(s); } catch { return null; }
    })
    .filter(Boolean);
}

/**
 * Reintenta un delivery específico de la DLQ.
 */
export async function retryFromDlq(subscriptionId, deliveryId) {
  const sub = await getSubscription(subscriptionId);
  if (!sub) return { ok: false, error: 'subscription_not_found' };

  const dlq = await getDlq(subscriptionId, { limit: 100 });
  const entry = dlq.find((e) => e.id === deliveryId);
  if (!entry) return { ok: false, error: 'delivery_not_found' };

  // Encolar de nuevo
  queue.push({
    subscription: sub,
    event: entry.event,
    payload: entry.payload,
    deliveryId: entry.id,
  });

  // Borrar de la DLQ
  await pipeline([['LREM', `webhook:sub:${subscriptionId}:dlq`, '1', JSON.stringify(entry)]]);

  scheduleFlush();
  return { ok: true };
}

/**
 * Vacía la DLQ.
 */
export async function clearDlq(subscriptionId) {
  const r = await pipeline([['DEL', `webhook:sub:${subscriptionId}:dlq`]]);
  return r.ok;
}

/* ═══════════════════════════════════════════════════════════════════════
   14 · TEST / PING DE UNA SUBSCRIPTION
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Envía un evento de prueba a una subscription.
 * Útil para validar que la URL responde correctamente.
 */
export async function testSubscription(subscriptionId, userId) {
  const sub = await getSubscription(subscriptionId);
  if (!sub) return { ok: false, error: 'not_found' };
  if (sub.userId !== userId) return { ok: false, error: 'forbidden' };

  const deliveryId = generateDeliveryId();
  const payload = {
    id: deliveryId,
    event: 'test',
    timestamp: new Date().toISOString(),
    data: { message: 'Este es un evento de prueba de Numination' },
    version: '1.0',
    subscriptionId: sub.id,
  };

  const result = await deliverOnce(sub, 'test', payload, deliveryId);

  return {
    ok: result.ok,
    status: result.status,
    durationMs: result.durationMs,
    error: result.error,
    responseBody: result.responseBody,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   15 · HELPERS DE VERIFICACIÓN (para receptores)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Construye un middleware de Express que verifica la firma
 * y adjunta el evento a `req.webhookEvent`.
 *
 * Uso:
 *   import { webhookVerifier } from './services/webhooks.js';
 *   app.post('/webhooks/numination',
 *     express.raw({ type: 'application/json' }),
 *     webhookVerifier(SECRET),
 *     (req, res) => { console.log(req.webhookEvent); res.send('OK'); }
 *   );
 */
export function webhookVerifier(secret) {
  return (req, res, next) => {
    const signature = req.get(CFG.signatureHeader.toLowerCase());
    const timestamp = req.get(CFG.timestampHeader.toLowerCase());
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    if (!verifySignature(signature, timestamp, body, secret)) {
      return res.status(401).json({ error: 'invalid_signature' });
    }

    try {
      req.webhookEvent = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: 'invalid_json' });
    }

    next();
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   16 · HEALTH / METRICS
   ═══════════════════════════════════════════════════════════════════════ */

export async function pingWebhooks() {
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

    const total = await countSubscriptions();

    return {
      ok: json.result === 'PONG',
      latencyMs: Date.now() - t0,
      queueSize: queue.length,
      totalSubscriptions: total,
      stats: getStats(),
    };
  } catch (e) {
    return { ok: false, reason: e?.message || 'fetch_failed' };
  }
}

export function getStats() {
  return {
    ...stats,
    byEvent: Object.fromEntries(stats.byEvent),
    queueSize: queue.length,
  };
}

export function resetStats() {
  stats.dispatched = 0;
  stats.delivered = 0;
  stats.failed = 0;
  stats.retried = 0;
  stats.dlq = 0;
  stats.skipped = 0;
  stats.byEvent.clear();
  stats.lastFlushAt = null;
  stats.lastErrorAt = null;
}

/* ═══════════════════════════════════════════════════════════════════════
   17 · GRACEFUL SHUTDOWN
   ═══════════════════════════════════════════════════════════════════════ */

export async function flushAndStop() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return await flushQueue();
}

/* ═══════════════════════════════════════════════════════════════════════
   18 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const errors = [];

  // 1 · Todos los eventos son únicos
  const evts = Object.values(EVENTS);
  const unique = new Set(evts);
  if (unique.size !== evts.length) {
    errors.push(`Eventos duplicados: ${evts.length - unique.size}`);
  }

  // 2 · Verificar patterns
  if (!isValidEventPattern('chat.created')) errors.push('chat.created no válido');
  if (!isValidEventPattern('chat.*')) errors.push('chat.* no válido');
  if (!isValidEventPattern('*')) errors.push('* no válido');
  if (isValidEventPattern('chat.invented')) errors.push('chat.invented fue aceptado');
  if (isValidEventPattern('')) errors.push('string vacío fue aceptado');

  // 3 · eventMatches
  if (!eventMatches('chat.created', ['chat.created'])) errors.push('match exacto falló');
  if (!eventMatches('chat.created', ['chat.*'])) errors.push('wildcard falló');
  if (!eventMatches('chat.created', ['*'])) errors.push('* falló');
  if (eventMatches('chat.created', ['user.*'])) errors.push('matcheó pattern incorrecto');
  if (eventMatches('chat.created', [])) errors.push('matcheó con array vacío');

  // 4 · Firma HMAC
  const secret = 'test-secret-123';
  const timestamp = String(Date.now());
  const body = '{"test":"data"}';
  const sig = signPayload(secret, timestamp, body);
  if (!sig.startsWith('sha256=')) errors.push('firma no empieza con sha256=');
  if (sig.length < 20) errors.push('firma muy corta');

  // 5 · Verificación de firma válida
  if (!verifySignature(sig, timestamp, body, secret)) {
    errors.push('verifySignature rechazó firma válida');
  }

  // 6 · Verificación de firma inválida
  if (verifySignature('sha256=bad', timestamp, body, secret)) {
    errors.push('verifySignature aceptó firma inválida');
  }
  if (verifySignature(sig, timestamp, body, 'otro-secret')) {
    errors.push('verifySignature aceptó secret incorrecto');
  }
  if (verifySignature(sig, '0', body, secret)) {
    errors.push('verifySignature aceptó timestamp expirado');
  }

  // 7 · Timestamps expirados
  const oldTimestamp = String(Date.now() - 10 * 60 * 1000);   // 10 min atrás
  const oldSig = signPayload(secret, oldTimestamp, body);
  if (verifySignature(oldSig, oldTimestamp, body, secret)) {
    errors.push('verifySignature aceptó timestamp fuera de tolerancia');
  }

  // 8 · Generate IDs
  const id1 = generateId();
  const id2 = generateId();
  if (id1 === id2) errors.push('generateId no es único');
  if (!id1.startsWith('sub_')) errors.push('generateId no empieza con sub_');

  const s1 = generateSecret();
  const s2 = generateSecret();
  if (s1 === s2) errors.push('generateSecret no es único');
  if (!s1.startsWith('whsec_')) errors.push('generateSecret no empieza con whsec_');

  return {
    ok: errors.length === 0,
    errors,
    totalEvents: evts.length,
    stats: getStats(),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   FIN
   ═══════════════════════════════════════════════════════════════════════ */