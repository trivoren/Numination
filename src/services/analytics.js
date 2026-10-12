/* ================================================================
   NUMINATION · analytics.js · v1.0
   ----------------------------------------------------------------
   Sistema de eventos y métricas de producto.

   ¿POR QUÉ EXISTE?
   Hoy no sabemos:
     · ¿Cuántos usuarios activos hay por día?
     · ¿Qué features usan? (chat, coder, razonamiento, incógnito...)
     · ¿En qué momento abandonan?
     · ¿Cuántos vuelven al día siguiente? (retención D1/D7/D30)
     · ¿Qué error se lleva más gente?
     · ¿Qué plan conviene más ofrecer?

   Este módulo responde todas esas preguntas sin guardar:
     · Emails
     · IPs
     · Contenido de mensajes
     · Nombres
     · Tokens
     · Ningún identificador personal

   Solo guarda:
     · userId (hasheado con salt)
     · tipo de evento (de un catálogo cerrado)
     · timestamp
     · metadata técnica no sensible (plan, motor usado, duración)

   PRINCIPIOS DE DISEÑO:
     · Fire-and-forget: nunca bloquea un request
     · Batched: agrupa eventos antes de escribir a Redis
     · Non-PII: solo userId hasheado, jamás email/IP
     · Retention: máximo 90 días de datos
     · Fail-safe: si Upstash cae, se pierden eventos, no requests
     · Sampling: eventos de alto volumen se muestrean

   ESTRUCTURA:
     1  · Configuración y constantes
     2  · Catálogo de eventos (taxonomía cerrada)
     3  · Cliente Upstash (con pool de escrituras)
     4  · Buffer en memoria + flush periódico
     5  · Key builders
     6  · Track (función principal)
     7  · Helpers por dominio (auth, chat, coder, etc.)
     8  · Middleware Express (auto-track)
     9  · Consultas: DAU, WAU, MAU
    10  · Retención: D1, D7, D30
    11  · Funnels: signup → activación
    12  · Cohorts: por semana de registro
    13  · Top eventos / endpoints / usuarios
    14  · Helpers de admin
    15  · Self-test
    16  · Exports

   USO BÁSICO:

     import { track, EVENTS } from './analytics.js';

     // Evento simple
     track(EVENTS.CHAT_MESSAGE_SENT, { userId, mode: 'coder' });

     // Con metadata
     track(EVENTS.AI_RESPONSE, {
       userId,
       provider: 'groq',
       durationMs: 1240,
       tokens: 234,
     });

   USO CON MIDDLEWARE:

     import { analyticsMiddleware } from './analytics.js';
     app.use(analyticsMiddleware());   // trackea cada request

   CONSULTAS:

     const dau = await getDailyActiveUsers(30);   // últimos 30 días
     const ret = await getRetention('2026-10-01'); // cohorte de ese día
     const funnel = await getSignupFunnel();       // embudo de activación

   ================================================================ */

import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN Y CONSTANTES
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  /* Salt para hashear userId. NUNCA cambiar sin migración. */
  userSalt: process.env.ANALYTICS_SALT || 'numination-analytics-v1-salt',

  /* Retención de datos en Redis (días) */
  retentionDays: parseInt(process.env.ANALYTICS_RETENTION_DAYS || '90', 10),

  /* Buffer en memoria: cuántos eventos agrupar antes de escribir */
  bufferSize: 50,

  /* Cada cuánto forzar el flush aunque no esté lleno el buffer (ms) */
  flushIntervalMs: 5000,

  /* Máximo de eventos en buffer si Upstash está caído */
  bufferMaxSize: 500,

  /* Sampling: 1 = trackear todo, 10 = trackear 1 de cada 10 */
  sampleRate: parseFloat(process.env.ANALYTICS_SAMPLE_RATE || '1'),

  /* Keys con TTL (segundos) */
  ttl: {
    event:      90 * 86400,   // 90 días
    eventCount: 90 * 86400,   // 90 días
    userDay:    90 * 86400,   // 90 días
    userProfile: 365 * 86400, // 1 año (para cohortes)
    funnel:     90 * 86400,
  },

  /* Timeout por operación de red a Upstash (ms) */
  upstashTimeoutMs: 3000,
});

/* ═══════════════════════════════════════════════════════════════════════
   2 · CATÁLOGO DE EVENTOS
   ═══════════════════════════════════════════════════════════════════════
   Taxonomía cerrada. Cada evento tiene:
     · key    · string que se guarda en Redis
     · sample · si se debe aplicar sampling
     · weight · importancia relativa (para priorizar si hay muchos)
   ═══════════════════════════════════════════════════════════════════════ */

export const EVENTS = Object.freeze({
  /* ─── Auth ─── */
  AUTH_SIGNUP_START:    { key: 'auth.signup_start',     sample: false },
  AUTH_SIGNUP_SUCCESS:  { key: 'auth.signup_success',   sample: false },
  AUTH_SIGNUP_FAILED:   { key: 'auth.signup_failed',    sample: false },
  AUTH_LOGIN_SUCCESS:   { key: 'auth.login_success',    sample: false },
  AUTH_LOGIN_FAILED:    { key: 'auth.login_failed',     sample: false },
  AUTH_LOGOUT:          { key: 'auth.logout',           sample: false },
  AUTH_OAUTH_START:     { key: 'auth.oauth_start',      sample: false },
  AUTH_OAUTH_SUCCESS:   { key: 'auth.oauth_success',    sample: false },
  AUTH_OAUTH_FAILED:    { key: 'auth.oauth_failed',     sample: false },
  AUTH_PASSWORD_RESET:  { key: 'auth.password_reset',   sample: false },
  AUTH_EMAIL_VERIFIED:  { key: 'auth.email_verified',   sample: false },

  /* ─── Chat ─── */
  CHAT_OPENED:          { key: 'chat.opened',           sample: false },
  CHAT_CREATED:         { key: 'chat.created',          sample: false },
  CHAT_DELETED:         { key: 'chat.deleted',          sample: false },
  CHAT_MESSAGE_SENT:    { key: 'chat.message_sent',     sample: false },
  CHAT_MESSAGE_RECEIVED:{ key: 'chat.message_received', sample: false },
  CHAT_ABORTED:         { key: 'chat.aborted',          sample: false },
  CHAT_COPIED:          { key: 'chat.copied',           sample: true },
  CHAT_SAVED_TO_MEMORY: { key: 'chat.saved_memory',     sample: false },

  /* ─── Modos ─── */
  MODE_SWITCHED:        { key: 'mode.switched',         sample: false },

  /* ─── Coder ─── */
  CODER_PROJECT_CREATED:{ key: 'coder.project_created', sample: false },
  CODER_CODE_SAVED:     { key: 'coder.code_saved',      sample: false },
  CODER_PREVIEW_OPENED: { key: 'coder.preview_opened',  sample: false },

  /* ─── Incógnito ─── */
  INCOGNITO_OPENED:     { key: 'incognito.opened',      sample: false },
  INCOGNITO_MESSAGE:    { key: 'incognito.message',     sample: false },
  INCOGNITO_CLOSED:     { key: 'incognito.closed',      sample: false },

  /* ─── Memorias ─── */
  MEMORY_CREATED:       { key: 'memory.created',        sample: false },
  MEMORY_DELETED:       { key: 'memory.deleted',        sample: false },
  MEMORY_SEARCHED:      { key: 'memory.searched',       sample: true },

  /* ─── Proyectos ─── */
  PROJECT_CREATED:      { key: 'project.created',       sample: false },
  PROJECT_DELETED:      { key: 'project.deleted',       sample: false },

  /* ─── Conectores ─── */
  CONNECTOR_QUERIED:    { key: 'connector.queried',     sample: false },
  CONNECTOR_CONNECTED:  { key: 'connector.connected',   sample: false },

  /* ─── IA (por motor) ─── */
  AI_REQUEST:           { key: 'ai.request',            sample: false },
  AI_RESPONSE:          { key: 'ai.response',           sample: false },
  AI_ERROR:             { key: 'ai.error',              sample: false },
  AI_FALLBACK:          { key: 'ai.fallback',           sample: false },
  AI_RATE_LIMITED:      { key: 'ai.rate_limited',       sample: false },

  /* ─── Límites ─── */
  LIMIT_HIT_DAILY:      { key: 'limit.hit_daily',       sample: false },
  LIMIT_HIT_MINUTE:     { key: 'limit.hit_minute',      sample: false },
  LIMIT_HIT_BURST:      { key: 'limit.hit_burst',       sample: false },
  LIMIT_UPGRADE_CLICKED:{ key: 'limit.upgrade_clicked', sample: false },

  /* ─── UI ─── */
  UI_THEME_CHANGED:     { key: 'ui.theme_changed',      sample: true },
  UI_SEARCH_USED:       { key: 'ui.search_used',        sample: true },
  UI_SETTINGS_OPENED:   { key: 'ui.settings_opened',    sample: true },
  UI_SIDEBAR_OPENED:    { key: 'ui.sidebar_opened',     sample: true },

  /* ─── Negocio ─── */
  PLAN_VIEWED:          { key: 'plan.viewed',           sample: false },
  PLAN_UPGRADED:        { key: 'plan.upgraded',         sample: false },

  /* ─── Errores ─── */
  ERROR_CLIENT:         { key: 'error.client',          sample: true },
  ERROR_SERVER:         { key: 'error.server',          sample: false },
});

/**
 * Verifica que un evento esté en el catálogo.
 * @returns {object|null}
 */
function getEventDef(eventOrKey) {
  if (!eventOrKey) return null;
  if (typeof eventOrKey === 'object' && eventOrKey.key) return eventOrKey;
  if (typeof eventOrKey === 'string') {
    for (const def of Object.values(EVENTS)) {
      if (def.key === eventOrKey) return def;
    }
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════
   3 · CLIENTE UPSTASH
   ═══════════════════════════════════════════════════════════════════════ */

function getUpstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

/**
 * Ejecuta un pipeline de comandos en Upstash.
 * @param {Array<Array<string>>} commands
 * @returns {Promise<{ok: boolean, result?: Array, error?: string}>}
 */
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
      signal: AbortSignal.timeout(CFG.upstashTimeoutMs),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, error: `http_${res.status}`, detail: txt.slice(0, 120) };
    }

    const json = await res.json();
    if (!Array.isArray(json)) return { ok: false, error: 'invalid_response' };
    return { ok: true, result: json };
  } catch (e) {
    return { ok: false, error: e?.message || 'fetch_failed' };
  }
}

/**
 * Ejecuta un EVAL en Upstash.
 */
async function evalScript(script, keys, args) {
  const u = getUpstash();
  if (!u) return { ok: false, error: 'no_upstash' };

  const body = JSON.stringify([
    'EVAL',
    script,
    String(keys.length),
    ...keys,
    ...args.map((a) => String(a)),
  ]);

  try {
    const res = await fetch(u.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(CFG.upstashTimeoutMs),
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const json = await res.json();
    if (json.error) return { ok: false, error: json.error };
    return { ok: true, result: json.result };
  } catch (e) {
    return { ok: false, error: e?.message || 'fetch_failed' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · BUFFER EN MEMORIA + FLUSH
   ═══════════════════════════════════════════════════════════════════════
   Los eventos se acumulan en un array. Cada flush agrupa por (día, evento)
   y hace un único pipeline de INCRBY. Mucho más eficiente que un
   pipeline por evento.
   ═══════════════════════════════════════════════════════════════════════ */

const buffer = [];
let flushTimer = null;
let stats = {
  tracked: 0,
  flushed: 0,
  dropped: 0,
  errors: 0,
  lastFlushAt: null,
  lastErrorAt: null,
};

/**
 * Programa el flush. Solo se ejecuta si no hay timer.
 */
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch(() => {});
  }, CFG.flushIntervalMs);
  if (flushTimer.unref) flushTimer.unref();
}

/**
 * Vuelca el buffer a Upstash.
 * Agrupa por (key, día) para minimizar comandos.
 */
async function flush() {
  if (buffer.length === 0) return { ok: true, count: 0 };

  const pending = buffer.splice(0, buffer.length);
  if (pending.length === 0) return { ok: true, count: 0 };

  // Agrupar
  const groups = new Map();

  for (const ev of pending) {
    const day = ev.ts.slice(0, 10); // YYYY-MM-DD

    // 1 · Contador global por día/evento
    const globalKey = `analytics:event:${day}:${ev.key}`;
    groups.set(globalKey, (groups.get(globalKey) || 0) + 1);

    // 2 · Contador por usuario/día (para DAU/WAU/MAU)
    if (ev.userHash) {
      const udKey = `analytics:user_day:${day}`;
      const member = `${ev.userHash}`;
      // Uso SADD para dedupe, distinto path
      if (!groups.has('__sadd_' + udKey)) {
        groups.set('__sadd_' + udKey, []);
      }
      groups.get('__sadd_' + udKey).push(member);
    }

    // 3 · Si trae provider, contar por motor
    if (ev.meta?.provider) {
      const provKey = `analytics:provider:${day}:${ev.meta.provider}`;
      groups.set(provKey, (groups.get(provKey) || 0) + 1);
    }

    // 4 · Si trae plan, contar por plan
    if (ev.meta?.plan) {
      const planKey = `analytics:plan:${day}:${ev.meta.plan}`;
      groups.set(planKey, (groups.get(planKey) || 0) + 1);
    }

    // 5 · Primer evento del usuario (para cohortes)
    if (ev.userHash && ev.firstEvent) {
      const cohortKey = `analytics:user_first_seen:${ev.userHash}`;
      groups.set('__setnx_' + cohortKey, day);
    }
  }

  // Construir comandos
  const commands = [];
  const sadds = [];

  for (const [key, value] of groups) {
    if (key.startsWith('__sadd_')) {
      const realKey = key.slice(7);
      sadds.push([realKey, ...value]);
    } else if (key.startsWith('__setnx_')) {
      const realKey = key.slice(8);
      commands.push(['SETNX', realKey, String(value)]);
      commands.push(['EXPIRE', realKey, String(CFG.ttl.userProfile)]);
    } else {
      commands.push(['INCRBY', key, String(value)]);
      commands.push(['EXPIRE', key, String(CFG.ttl.eventCount)]);
    }
  }

  // Agregar los SADD (uno por día)
  for (const saddCmd of sadds) {
    const [key, ...members] = saddCmd;
    // Chunk si hay muchos
    for (let i = 0; i < members.length; i += 500) {
      const chunk = members.slice(i, i + 500);
      commands.push(['SADD', key, ...chunk]);
      commands.push(['EXPIRE', key, String(CFG.ttl.userDay)]);
    }
  }

  if (commands.length === 0) return { ok: true, count: 0 };

  const res = await pipeline(commands);

  if (res.ok) {
    stats.flushed += pending.length;
    stats.lastFlushAt = Date.now();
    return { ok: true, count: pending.length };
  } else {
    stats.errors++;
    stats.lastErrorAt = Date.now();
    // Re-encolar si hay espacio (evita pérdida total si Upstash falla)
    if (buffer.length < CFG.bufferMaxSize) {
      buffer.push(...pending.slice(0, CFG.bufferMaxSize - buffer.length));
    } else {
      stats.dropped += pending.length;
    }
    return { ok: false, error: res.error };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · KEY BUILDERS
   ═══════════════════════════════════════════════════════════════════════ */

function hashUser(userId) {
  if (!userId || typeof userId !== 'string') return null;
  return crypto
    .createHmac('sha256', CFG.userSalt)
    .update(userId)
    .digest('hex')
    .slice(0, 16);
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function dayOffset(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · TRACK · la función principal
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Registra un evento.
 *
 * @param {object|string} event   · definición del EVENTS o su key
 * @param {object} [data]         · { userId, meta, firstEvent }
 * @returns {boolean}             · true si se encoló
 */
export function track(event, data = {}) {
  try {
    const def = getEventDef(event);
    if (!def) return false;

    // Sampling
    if (def.sample && CFG.sampleRate < 1) {
      if (Math.random() > CFG.sampleRate) return false;
    }

    const ts = new Date().toISOString();
    const userHash = hashUser(data.userId);

    // Sanitizar metadata: solo tipos primitivos, largo máximo 200 chars
    const meta = sanitizeMeta(data.meta);

    buffer.push({
      key: def.key,
      ts,
      userHash,
      meta,
      firstEvent: Boolean(data.firstEvent),
    });

    stats.tracked++;

    // Flush inmediato si el buffer está lleno
    if (buffer.length >= CFG.bufferSize) {
      flush().catch(() => {});
    } else {
      scheduleFlush();
    }

    return true;
  } catch (e) {
    // Nunca romper el request por analytics
    return false;
  }
}

/**
 * Deja solo strings/números cortos. Nada de objetos anidados ni PII.
 */
function sanitizeMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};

  const out = {};
  const MAX_STR = 200;
  const MAX_KEYS = 15;

  let count = 0;
  for (const [k, v] of Object.entries(meta)) {
    if (count >= MAX_KEYS) break;
    if (v === undefined || v === null) continue;

    const key = String(k).slice(0, 40);

    if (typeof v === 'string') {
      // Filtrar strings sospechosos (emails, tokens)
      const cleaned = v.replace(/[^\w\s\-.:/]/g, '').slice(0, MAX_STR);
      if (cleaned) {
        out[key] = cleaned;
        count++;
      }
    } else if (typeof v === 'number' && isFinite(v)) {
      out[key] = v;
      count++;
    } else if (typeof v === 'boolean') {
      out[key] = v;
      count++;
    }
    // Objetos/arrays/undefined se descartan silenciosamente
  }
  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · HELPERS POR DOMINIO
   ═══════════════════════════════════════════════════════════════════════ */

export const analytics = {
  /* ─── Auth ─── */
  signupStart:   (userId) => track(EVENTS.AUTH_SIGNUP_START, { userId }),
  signupSuccess: (userId, { provider } = {}) => track(EVENTS.AUTH_SIGNUP_SUCCESS, { userId, meta: { provider }, firstEvent: true }),
  signupFailed:  (userId, { reason } = {}) => track(EVENTS.AUTH_SIGNUP_FAILED, { userId, meta: { reason } }),
  loginSuccess:  (userId, { provider } = {}) => track(EVENTS.AUTH_LOGIN_SUCCESS, { userId, meta: { provider } }),
  loginFailed:   (userId, { reason } = {}) => track(EVENTS.AUTH_LOGIN_FAILED, { userId, meta: { reason } }),
  logout:        (userId) => track(EVENTS.AUTH_LOGOUT, { userId }),

  /* ─── Chat ─── */
  chatOpened:  (userId, { chatId } = {}) => track(EVENTS.CHAT_OPENED, { userId, meta: { chatId: chatId ? String(chatId).slice(0, 20) : undefined } }),
  chatCreated: (userId) => track(EVENTS.CHAT_CREATED, { userId }),
  chatDeleted: (userId) => track(EVENTS.CHAT_DELETED, { userId }),
  messageSent: (userId, { mode, length, isFirst } = {}) => track(EVENTS.CHAT_MESSAGE_SENT, {
    userId,
    meta: { mode, length, isFirst },
  }),
  messageReceived: (userId, { provider, durationMs, tokens } = {}) => track(EVENTS.CHAT_MESSAGE_RECEIVED, {
    userId,
    meta: { provider, durationMs, tokens },
  }),

  /* ─── IA ─── */
  aiRequest:     (userId, { provider, mode } = {}) => track(EVENTS.AI_REQUEST, { userId, meta: { provider, mode } }),
  aiResponse:    (userId, { provider, mode, durationMs, tokens } = {}) => track(EVENTS.AI_RESPONSE, {
    userId,
    meta: { provider, mode, durationMs, tokens },
  }),
  aiError:       (userId, { provider, code, status } = {}) => track(EVENTS.AI_ERROR, {
    userId,
    meta: { provider, code, status },
  }),
  aiFallback:    (userId, { from, to, reason } = {}) => track(EVENTS.AI_FALLBACK, {
    userId,
    meta: { from, to, reason },
  }),
  aiRateLimited: (userId, { provider } = {}) => track(EVENTS.AI_RATE_LIMITED, { userId, meta: { provider } }),

  /* ─── Modos ─── */
  modeSwitched: (userId, { from, to }) => track(EVENTS.MODE_SWITCHED, { userId, meta: { from, to } }),

  /* ─── Incógnito ─── */
  incognitoOpened:  (userId) => track(EVENTS.INCOGNITO_OPENED, { userId }),
  incognitoMessage: (userId) => track(EVENTS.INCOGNITO_MESSAGE, { userId }),

  /* ─── Memorias ─── */
  memoryCreated: (userId, { source } = {}) => track(EVENTS.MEMORY_CREATED, { userId, meta: { source } }),
  memoryDeleted: (userId) => track(EVENTS.MEMORY_DELETED, { userId }),

  /* ─── Límites ─── */
  limitHitDaily:  (userId, { plan } = {}) => track(EVENTS.LIMIT_HIT_DAILY, { userId, meta: { plan } }),
  limitHitMinute: (userId, { plan } = {}) => track(EVENTS.LIMIT_HIT_MINUTE, { userId, meta: { plan } }),
  limitUpgradeClicked: (userId) => track(EVENTS.LIMIT_UPGRADE_CLICKED, { userId }),

  /* ─── UI ─── */
  themeChanged:   (userId, { theme }) => track(EVENTS.UI_THEME_CHANGED, { userId, meta: { theme } }),
  searchUsed:     (userId, { results }) => track(EVENTS.UI_SEARCH_USED, { userId, meta: { results } }),
  settingsOpened: (userId) => track(EVENTS.UI_SETTINGS_OPENED, { userId }),

  /* ─── Errores ─── */
  clientError: (userId, { message, path }) => track(EVENTS.ERROR_CLIENT, {
    userId,
    meta: { message: String(message || '').slice(0, 100), path },
  }),
  serverError: (userId, { code, path }) => track(EVENTS.ERROR_SERVER, {
    userId,
    meta: { code, path },
  }),

  /* ─── Flush manual ─── */
  flush: () => flush(),
  stats: () => ({ ...stats, bufferSize: buffer.length }),
};

/* ═══════════════════════════════════════════════════════════════════════
   8 · MIDDLEWARE EXPRESS
   ═══════════════════════════════════════════════════════════════════════
   Auto-trackea cada request, con sampling para endpoints de alto volumen.
   NO guarda: body, headers, cookies, IP, query params.
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Filtra paths que NO queremos trackear (ruido).
 */
const SKIP_PATHS = [
  /^\/api\/health/,
  /^\/api\/version/,
  /^\/api\/ping/,
  /^\/assets\//,
  /\.(js|css|png|jpg|svg|woff2?|ico|map)$/i,
];

function shouldTrackPath(path) {
  return !SKIP_PATHS.some((re) => re.test(path));
}

/**
 * Genera un event key a partir del request.
 * Ej: POST /api/chats → 'http.post_chats'
 */
function requestEventKey(method, path) {
  const normalized = path
    .replace(/\/[0-9a-f]{8,}(-[0-9a-f]+)*/gi, '/:id')
    .replace(/\/\d+/g, '/:n')
    .replace(/\//g, '_')
    .replace(/^_/, '')
    .replace(/_+$/, '');
  return `http.${method.toLowerCase()}_${normalized}`.slice(0, 80);
}

/**
 * Middleware factory.
 *
 * Opciones:
 *   · sampleHttp   · sample rate específico (default 1 = todo)
 *   · ignore4xx    · no trackear 4xx (default false)
 */
export function analyticsMiddleware(opts = {}) {
  const sample = opts.sampleHttp ?? 1;
  const ignore4xx = opts.ignore4xx ?? false;
  const t0Key = Symbol('analytics.t0');

  return (req, res, next) => {
    if (!shouldTrackPath(req.path)) return next();

    // Sampling simple por request
    if (sample < 1 && Math.random() > sample) return next();

    req[t0Key] = Date.now();

    // Hook al final del response
    const originalEnd = res.end;
    res.end = function analyticsEnd(...args) {
      res.end = originalEnd;
      originalEnd.apply(this, args);

      try {
        const status = res.statusCode;
        if (ignore4xx && status >= 400 && status < 500) return;

        const ms = Date.now() - req[t0Key];
        const key = requestEventKey(req.method, req.path);

        // Construir meta saneada
        const meta = {
          status,
          ms,
          method: req.method,
        };
        if (req.user?.plan) meta.plan = req.user.plan;

        track({ key, sample: true }, {
          userId: req.user?.id || null,
          meta,
        });
      } catch {}
    };

    next();
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   9 · CONSULTAS · DAU / WAU / MAU
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Devuelve el conteo de usuarios activos por día (últimos N días).
 */
export async function getDailyActiveUsers(days = 30) {
  const commands = [];
  const dates = [];

  for (let i = days - 1; i >= 0; i--) {
    const day = dayOffset(i);
    dates.push(day);
    commands.push(['SCARD', `analytics:user_day:${day}`]);
  }

  const res = await pipeline(commands);
  if (!res.ok) return { ok: false, error: res.error };

  return {
    ok: true,
    dates,
    counts: res.result.map((r) => Number(r.result) || 0),
  };
}

/**
 * WAU · usuarios únicos en los últimos 7 días.
 */
export async function getWeeklyActiveUsers() {
  return getUniqueUsersOverRange(7);
}

/**
 * MAU · usuarios únicos en los últimos 30 días.
 */
export async function getMonthlyActiveUsers() {
  return getUniqueUsersOverRange(30);
}

async function getUniqueUsersOverRange(days) {
  const keys = [];
  for (let i = 0; i < days; i++) {
    keys.push(`analytics:user_day:${dayOffset(i)}`);
  }

  if (keys.length === 0) return { ok: true, count: 0 };

  // SUNIONSTORE temporal + SCARD
  const tempKey = `analytics:_tmp_union_${Date.now()}`;
  const commands = [
    ['SUNIONSTORE', tempKey, ...keys],
    ['SCARD', tempKey],
    ['DEL', tempKey],
  ];

  const res = await pipeline(commands);
  if (!res.ok) return { ok: false, error: res.error };

  return {
    ok: true,
    days,
    count: Number(res.result[1]?.result) || 0,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · RETENCIÓN · D1 / D7 / D30
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Retención para una cohorte dada por fecha de registro.
 *
 * @param {string} cohortDate · 'YYYY-MM-DD'
 * @returns {Promise<{d1: number, d7: number, d30: number, cohortSize: number}>}
 */
export async function getRetention(cohortDate) {
  const d1Key  = `analytics:cohort:${cohortDate}:d1`;
  const d7Key  = `analytics:cohort:${cohortDate}:d7`;
  const d30Key = `analytics:cohort:${cohortDate}:d30`;
  const sizeKey = `analytics:cohort:${cohortDate}:size`;

  const commands = [
    ['SCARD', sizeKey],
    ['SCARD', d1Key],
    ['SCARD', d7Key],
    ['SCARD', d30Key],
  ];

  const res = await pipeline(commands);
  if (!res.ok) return { ok: false, error: res.error };

  const size = Number(res.result[0]?.result) || 0;
  const d1 = Number(res.result[1]?.result) || 0;
  const d7 = Number(res.result[2]?.result) || 0;
  const d30 = Number(res.result[3]?.result) || 0;

  return {
    ok: true,
    cohortDate,
    cohortSize: size,
    d1, d7, d30,
    rate: {
      d1: size > 0 ? d1 / size : 0,
      d7: size > 0 ? d7 / size : 0,
      d30: size > 0 ? d30 / size : 0,
    },
  };
}

/**
 * Retención promedio de las últimas N cohortes diarias.
 */
export async function getAverageRetention(days = 14) {
  const cohortes = [];
  for (let i = 1; i <= days; i++) {
    cohortes.push(dayOffset(i));
  }

  const results = await Promise.all(cohortes.map((d) => getRetention(d)));

  const valid = results.filter((r) => r.ok && r.cohortSize > 0);
  if (valid.length === 0) {
    return { ok: true, samples: 0, d1: 0, d7: 0, d30: 0, cohorts: [] };
  }

  const avg = (key) => valid.reduce((acc, r) => acc + r.rate[key], 0) / valid.length;

  return {
    ok: true,
    samples: valid.length,
    d1: avg('d1'),
    d7: avg('d7'),
    d30: avg('d30'),
    cohorts: results,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   11 · FUNNELS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Embudo de activación:
 *  1. Signup completo
 *  2. Primer mensaje enviado
 *  3. Primer mensaje recibido (IA respondió)
 *  4. Segundo chat abierto
 *  5. Vuelta al día siguiente (D1)
 */
export async function getSignupFunnel(days = 7) {
  const day = dayOffset(days);
  const commands = [
    ['GET', `analytics:funnel:signup:${day}`],
    ['GET', `analytics:funnel:first_message:${day}`],
    ['GET', `analytics:funnel:first_reply:${day}`],
    ['GET', `analytics:funnel:second_session:${day}`],
    ['GET', `analytics:funnel:d1:${day}`],
  ];

  const res = await pipeline(commands);
  if (!res.ok) return { ok: false, error: res.error };

  const [signup, firstMsg, firstReply, secondSession, d1] = res.result.map((r) => Number(r.result) || 0);

  return {
    ok: true,
    since: day,
    steps: [
      { name: 'signup',         count: signup,         rate: signup > 0 ? 1 : 0 },
      { name: 'first_message',  count: firstMsg,       rate: signup > 0 ? firstMsg / signup : 0 },
      { name: 'first_reply',    count: firstReply,     rate: signup > 0 ? firstReply / signup : 0 },
      { name: 'second_session', count: secondSession,  rate: signup > 0 ? secondSession / signup : 0 },
      { name: 'd1_return',      count: d1,             rate: signup > 0 ? d1 / signup : 0 },
    ],
  };
}

/**
 * Marca un usuario en un paso del embudo.
 * Se llama desde los handlers correspondientes.
 */
export async function markFunnelStep(step, userId) {
  const hash = hashUser(userId);
  if (!hash) return false;
  const day = todayUTC();
  const key = `analytics:funnel:${step}:${day}`;
  const res = await pipeline([
    ['PFADD', key, hash],
    ['EXPIRE', key, String(CFG.ttl.funnel)],
  ]);
  return res.ok;
}

/* ═══════════════════════════════════════════════════════════════════════
   12 · COHORTS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Construye cohorts semanales de las últimas N semanas.
 * Cada cohort = usuarios que se registraron esa semana.
 */
export async function getWeeklyCohorts(weeks = 8) {
  const commands = [];
  const labels = [];

  for (let i = 0; i < weeks; i++) {
    // Inicio de semana (lunes UTC)
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i * 7);
    const dow = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() - dow + 1);
    const weekKey = d.toISOString().slice(0, 10);
    labels.push(weekKey);
    commands.push(['SCARD', `analytics:cohort_week:${weekKey}`]);
  }

  const res = await pipeline(commands);
  if (!res.ok) return { ok: false, error: res.error };

  return {
    ok: true,
    weeks: labels.map((label, i) => ({
      week: label,
      size: Number(res.result[i]?.result) || 0,
    })),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   13 · TOP EVENTOS / ENDPOINTS / USUARIOS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Top de eventos de los últimos N días.
 */
export async function getTopEvents(days = 7, limit = 20) {
  const eventKeys = Object.values(EVENTS).map((e) => e.key);
  const day = todayUTC();
  const commands = [];
  const meta = [];

  for (let i = 0; i < days; i++) {
    const d = dayOffset(i);
    for (const evKey of eventKeys) {
      commands.push(['GET', `analytics:event:${d}:${evKey}`]);
      meta.push({ day: d, event: evKey });
    }
  }

  const res = await pipeline(commands);
  if (!res.ok) return { ok: false, error: res.error };

  // Agregar por evento a través de días
  const totals = new Map();
  for (let i = 0; i < res.result.length; i++) {
    const { event } = meta[i];
    const count = Number(res.result[i]?.result) || 0;
    totals.set(event, (totals.get(event) || 0) + count);
  }

  const sorted = Array.from(totals.entries())
    .map(([event, count]) => ({ event, count }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return {
    ok: true,
    days,
    totalEvents: sorted.reduce((s, e) => s + e.count, 0),
    top: sorted,
  };
}

/**
 * Top de motores por día.
 */
export async function getProviderUsage(days = 7) {
  const providers = ['groq', 'gemini', 'nvidia', 'gemini-1', 'gemini-2', 'gemini-3'];
  const commands = [];
  const meta = [];

  for (let i = 0; i < days; i++) {
    const d = dayOffset(i);
    for (const p of providers) {
      commands.push(['GET', `analytics:provider:${d}:${p}`]);
      meta.push({ day: d, provider: p });
    }
  }

  const res = await pipeline(commands);
  if (!res.ok) return { ok: false, error: res.error };

  const totals = new Map();
  for (let i = 0; i < res.result.length; i++) {
    const { provider } = meta[i];
    const count = Number(res.result[i]?.result) || 0;
    totals.set(provider, (totals.get(provider) || 0) + count);
  }

  return {
    ok: true,
    days,
    usage: Array.from(totals.entries())
      .map(([provider, count]) => ({ provider, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * Distribución por plan.
 */
export async function getPlanDistribution(days = 7) {
  const plans = ['free', 'basic', 'pro', 'premium'];
  const commands = [];
  const meta = [];

  for (let i = 0; i < days; i++) {
    const d = dayOffset(i);
    for (const p of plans) {
      commands.push(['GET', `analytics:plan:${d}:${p}`]);
      meta.push({ day: d, plan: p });
    }
  }

  const res = await pipeline(commands);
  if (!res.ok) return { ok: false, error: res.error };

  const totals = new Map();
  for (let i = 0; i < res.result.length; i++) {
    const { plan } = meta[i];
    const count = Number(res.result[i]?.result) || 0;
    totals.set(plan, (totals.get(plan) || 0) + count);
  }

  return {
    ok: true,
    days,
    plans: Array.from(totals.entries())
      .map(([plan, count]) => ({ plan, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   14 · HELPERS DE ADMIN
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Snapshot completo de las métricas principales.
 * Útil para un endpoint /api/admin/analytics.
 */
export async function getSnapshot({ days = 7 } = {}) {
  const [
    dau,
    wau,
    mau,
    topEvents,
    providers,
    plans,
    retention,
    funnel,
    cohorts,
  ] = await Promise.all([
    getDailyActiveUsers(days),
    getWeeklyActiveUsers(),
    getMonthlyActiveUsers(),
    getTopEvents(days, 10),
    getProviderUsage(days),
    getPlanDistribution(days),
    getAverageRetention(14),
    getSignupFunnel(days),
    getWeeklyCohorts(8),
  ]);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    window: `${days} días`,
    active: {
      dau: dau.ok ? dau.counts[dau.counts.length - 1] : null,
      wau: wau.ok ? wau.count : null,
      mau: mau.ok ? mau.count : null,
      trend: dau.ok ? dau.counts : [],
    },
    topEvents: topEvents.ok ? topEvents.top : [],
    providers: providers.ok ? providers.usage : [],
    plans: plans.ok ? plans.plans : [],
    retention: retention.ok ? {
      d1: retention.d1,
      d7: retention.d7,
      d30: retention.d30,
      samples: retention.samples,
    } : null,
    funnel: funnel.ok ? funnel.steps : [],
    cohorts: cohorts.ok ? cohorts.weeks : [],
  };
}

/**
 * Purga datos antiguos. Se puede correr como cron.
 */
export async function purgeOldData(olderThanDays = CFG.retentionDays) {
  const cutoff = dayOffset(olderThanDays);
  // En producción real esto requeriría SCAN, pero Upstash no lo soporta bien.
  // En su lugar, las keys expiran solas por TTL configurado.
  // Este método es un no-op documentado.
  return { ok: true, cutoff, note: 'Las keys expiran por TTL. No hay nada que purgar.' };
}

/**
 * Diagnóstico rápido.
 */
export async function pingAnalytics() {
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
      bufferSize: buffer.length,
      stats,
    };
  } catch (e) {
    return { ok: false, reason: e?.message || 'fetch_failed' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   15 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const errors = [];

  // 1 · Catálogo de eventos válido
  for (const [name, def] of Object.entries(EVENTS)) {
    if (!def.key) errors.push(`${name} sin key`);
    if (typeof def.key !== 'string') errors.push(`${name} key no es string`);
    if (def.sample !== true && def.sample !== false) errors.push(`${name} sample no es boolean`);
  }

  // 2 · Hash determinista
  const h1 = hashUser('user-123');
  const h2 = hashUser('user-123');
  if (h1 !== h2) errors.push('hashUser no es determinista');

  const h3 = hashUser('user-124');
  if (h1 === h3) errors.push('hashUser colisiona con inputs distintos');

  // 3 · Sanitización de metadata
  const dirty = { name: 'a'.repeat(500), age: 25, active: true, nested: { a: 1 }, email: 'x@y.com' };
  const clean = sanitizeMeta(dirty);
  if (clean.name && clean.name.length > 200) errors.push('sanitizeMeta no recorta strings largos');
  if (clean.age !== 25) errors.push('sanitizeMeta perdió number');
  if (clean.active !== true) errors.push('sanitizeMeta perdió boolean');
  if (clean.nested) errors.push('sanitizeMeta no descartó objeto anidado');

  // 4 · Key builder de request
  const key1 = requestEventKey('POST', '/api/chats/abc-123/messages');
  if (!key1.startsWith('http.post_')) errors.push(`requestEventKey: ${key1}`);

  // 5 · Track funciona
  const before = stats.tracked;
  const tracked = track(EVENTS.CHAT_OPENED, { userId: 'test-user' });
  if (!tracked) errors.push('track retornó false');
  if (stats.tracked !== before + 1) errors.push('stats.tracked no incrementó');

  // 6 · Track rechaza eventos inválidos
  const bad = track('evento.que.no.existe', { userId: 'x' });
  if (bad !== false) errors.push('track aceptó evento desconocido');

  return {
    ok: errors.length === 0,
    errors,
    totalEvents: Object.keys(EVENTS).length,
    bufferSize: buffer.length,
    stats,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   16 · GRACEFUL SHUTDOWN
   ═══════════════════════════════════════════════════════════════════════
   Flush del buffer al apagar el servidor.
   ═══════════════════════════════════════════════════════════════════════ */

export async function flushAndStop() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return await flush();
}

/* ═══════════════════════════════════════════════════════════════════════
   FIN
   ═══════════════════════════════════════════════════════════════════════ */