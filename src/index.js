/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · index.js · v9.0
   ─────────────────────────────────────────────────────────────────────────
   Orquestador completo con Web Search, Images y Sources persistidas.

   NUEVO EN v9.0:
     · Web search integrado (Wikipedia + DDG + Brave)
     · Fuentes web visibles en el chat
     · Sources persistidas en Message.sources (JSONB)
     · Imágenes funcionan también con SSE
     · Logger centralizado (src/lib/logger.js)
     · SSE helper robusto (src/lib/sse.js)
     · Cache de respuestas IA (ahorra tokens)
     · Health checks con detalles de subsistemas
     · Graceful shutdown con flush de colas
     · Manejo de errores defensivo
     · Detección de request ID en headers

   MÓDULOS EXISTENTES (sin cambios de interfaz):
     auth.js         · 15 endpoints de autenticación
     chats.js        · 8 endpoints de chats
     memories.js     · 14 endpoints de memorias
     skills.js       · 3+ endpoints de skills
     connectors.js   · 15 endpoints de 13 APIs externas
     email.js        · 8 endpoints de email transaccional

   INFRAESTRUCTURA:
     errors.js               · manejo centralizado + métricas
     rate-limit-per-user.js  · rate limit por usuario/endpoint/plan
     prompts.js              · prompts versionados + A/B testing
     analytics.js            · eventos, DAU/WAU/retention/funnels
     notifications.js        · notificaciones multicanal
     webhooks.js             · webhooks outbound firmados
     search.js               · búsqueda full-text multi-entidad
     migrations.js           · versionado de schema DB
     backup.js               · backups y restore
     websearch.js            · NUEVO · búsqueda en internet
     images.js               · NUEVO · generación de imágenes
     logger.js               · NUEVO · logging centralizado
     sse.js                  · NUEVO · Server-Sent Events helpers

   MOTORES DE IA:
     Texto     → Groq → Gemini → Kimi
     Archivos  → Gemini → Kimi → Groq

   PANEL ADMIN:
     /admin.html             · 10 vistas
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import OpenAI from 'openai';

/* ═══════════════════════════════════════════════════════════════════════════
   NUEVOS IMPORTS · v9.0
   ═══════════════════════════════════════════════════════════════════════════ */

/* Logger centralizado */
import { LOG, withReqId, expressMiddleware as loggerMiddleware } from './lib/logger.js';

/* SSE helper robusto */
import { initSSE, sseSend, sseClose, sseHeartbeat } from './lib/sse.js';

/* Web search */
import { searchWeb, formatResultsForAI } from './services/websearch.js';

/* Generación de imágenes */
import {
  buildImageUrl,
  isImageRequest,
  extractImagePrompt,
  enrichPrompt as enrichImagePrompt,
} from './services/images.js';

/* ═══════════════════════════════════════════════════════════════════════════
   SERVICIOS IA EXISTENTES
   ═══════════════════════════════════════════════════════════════════════════ */

import { streamGroq, streamGemini, streamKimi } from './services/streaming.js';
import { buildSystemPrompt, buildFinalMessage } from './services/prompts.js';
import {
  verificarLimite,
  registrarUso,
  reembolsarUso,
  getUsageStats,
  buildRateLimitHeaders,
  pingLimits,
} from './services/limits.js';
import {
  supabaseDisponible,
  listarMemories,
  pingDatabase,
} from './services/supabase.js';

/* ═══════════════════════════════════════════════════════════════════════════
   SERVICIOS DE INFRAESTRUCTURA
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  analyticsMiddleware,
  track,
  EVENTS as ANALYTICS_EVENTS,
  getSnapshot as getAnalyticsSnapshot,
  getDailyActiveUsers,
  getWeeklyActiveUsers,
  getMonthlyActiveUsers,
  getAverageRetention,
  getSignupFunnel,
  getWeeklyCohorts,
  getTopEvents,
  getProviderUsage,
  getPlanDistribution,
  pingAnalytics,
  flushAndStop as flushAnalytics,
} from './services/analytics.js';

import {
  notificationsMiddleware,
  notify,
  TYPES,
  getInbox,
  getUnreadCount,
  markAllRead,
  markRead,
  clearInbox,
  getPreferences,
  updatePreferences,
  pingNotifications,
  flushAndStop as flushNotifications,
} from './services/notifications.js';

import {
  dispatch,
  EVENTS as WEBHOOK_EVENTS,
  createSubscription,
  getSubscription,
  listSubscriptions,
  updateSubscription,
  deleteSubscription,
  rotateSecret,
  getDeliveryLog,
  getDlq,
  retryFromDlq,
  clearDlq,
  testSubscription,
  pingWebhooks,
  getStats as getWebhookStats,
  flushAndStop as flushWebhooks,
} from './services/webhooks.js';

import {
  search,
  suggest,
  getRecentSearches,
  clearRecentSearches,
  saveSearch,
  listSavedSearches,
  deleteSavedSearch,
  getTrendingSearches,
  pingSearch,
} from './services/search.js';

import {
  runMigrations,
  getStatus as getMigrationsStatus,
  verifyIntegrity as verifyMigrations,
} from './services/migrations.js';

import {
  createBackup,
  listBackups,
  getBackup,
  downloadBackup,
  deleteBackup,
  restoreBackup,
  runRetention,
  pingBackup,
  scheduledBackup,
} from './services/backup.js';

/* ═══════════════════════════════════════════════════════════════════════════
   MIDDLEWARE
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  requestIdMiddleware,
  notFoundMiddleware,
  errorMiddleware,
  installProcessHandlers,
  getErrorMetrics,
} from './middleware/errors.js';

import {
  rateLimitUser,
  getRateLimitMetrics,
} from './middleware/rate-limit-per-user.js';

/* ═══════════════════════════════════════════════════════════════════════════
   ROUTERS
   ═══════════════════════════════════════════════════════════════════════════ */

import { mountAuthRoutes, attachUser, requireAuth } from './auth.js';
import { mountChatRoutes } from './chats.js';
import { mountMemoryRoutes } from './memories.js';
import { mountSkillsRoutes } from './skills.js';
import { mountConnectorRoutes } from './connectors.js';
import { mountEmailRoutes } from './email.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const VERSION = '9.0.0';

/* ═══════════════════════════════════════════════════════════════════════════
   CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const IS_PROD = process.env.NODE_ENV === 'production';
const IS_VERCEL = process.env.VERCEL === '1';
const PORT = parseInt(process.env.PORT || '8080', 10);

const CFG = Object.freeze({
  maxMsgLen: 8000,
  jsonLimit: '15mb',
  geminiCooldownMs: 60_000,
  geminiSoftCooldownMs: 15_000,
  rateLimitIPWindow: 60_000,
  rateLimitIPMax: 500,
  retryBaseDelayMs: 900,
  sseHeartbeatMs: 8_000,
  sseMaxDurationMs: 300_000,
  aiFirstTokenTimeoutMs: 25_000,
  memCacheTtlMs: 30_000,
  memCacheMax: 200,
  responseCacheTtlMs: 15 * 60_000,
  responseCacheMax: 500,
  keepAliveTimeout: 65_000,
  headersTimeout: 66_000,
  shutdownTimeout: 10_000,
  webSearchTimeoutMs: 8_000,
  webSearchMaxResults: 5,
});

/* ═══════════════════════════════════════════════════════════════════════════
   LOGGER · Ahora usa el módulo centralizado
   ═══════════════════════════════════════════════════════════════════════════ */

const LVL = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LVL =
  LVL[
    (
      process.env.LOG_LEVEL ||
      (IS_PROD ? 'info' : 'debug')
    ).toLowerCase()
  ] || LVL.info;

/* Wrapper local para no romper los usos existentes de LOG.ok */
const AppLog = {
  debug: (m, ...a) => {
    if (MIN_LVL <= LVL.debug) LOG.debug(m, a.length ? { extra: a } : undefined);
  },
  info: (m, ...a) => {
    if (MIN_LVL <= LVL.info) LOG.info(m, a.length ? { extra: a } : undefined);
  },
  ok: (m, ...a) => {
    if (MIN_LVL <= LVL.info) LOG.info(`✅ ${m}`, a.length ? { extra: a } : undefined);
  },
  warn: (m, ...a) => {
    if (MIN_LVL <= LVL.warn) LOG.warn(m, a.length ? { extra: a } : undefined);
  },
  error: (m, ...a) => {
    if (MIN_LVL <= LVL.error) LOG.error(m, a.length ? { extra: a } : undefined);
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   KEYS · MODELOS
   ═══════════════════════════════════════════════════════════════════════════ */

let TEST_KEYS = {};
try {
  const mod = await import('../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch {}

function sanitizeEnv(v) {
  if (typeof v !== 'string') return v;
  return v.trim().replace(/^["']|["']$/g, '').replace(/[\r\n\t]/g, '');
}

const KEYS = Object.freeze({
  GROQ: sanitizeEnv(process.env.GROQ_API_KEY ?? TEST_KEYS.GROQ_API_KEY),
  NV: sanitizeEnv(process.env.NVIDIA_API_KEY ?? TEST_KEYS.NVIDIA_API_KEY),
  GM1: sanitizeEnv(process.env.GEMINI_API_KEY ?? TEST_KEYS.GEMINI_API_KEY),
  GM2: sanitizeEnv(process.env.GEMINI_API_KEY_2 ?? TEST_KEYS.GEMINI_API_KEY_2),
  GM3: sanitizeEnv(process.env.GEMINI_API_KEY_3 ?? TEST_KEYS.GEMINI_API_KEY_3),
});

const MODELS = Object.freeze({
  GROQ: sanitizeEnv(process.env.GROQ_MODEL ?? TEST_KEYS.GROQ_MODEL) ?? 'openai/gpt-oss-120b',
  GEMINI: sanitizeEnv(process.env.GEMINI_MODEL ?? TEST_KEYS.GEMINI_MODEL) ?? 'gemini-3.6-flash',
  KIMI: sanitizeEnv(process.env.KIMI_MODEL ?? TEST_KEYS.KIMI_MODEL) ?? 'moonshotai/kimi-k3',
});

/* ═══════════════════════════════════════════════════════════════════════════
   GEMINI POOL · 3 keys con cooldown independiente
   ═══════════════════════════════════════════════════════════════════════════ */

const geminiPool = [KEYS.GM1, KEYS.GM2, KEYS.GM3]
  .filter(Boolean)
  .map((apiKey, i) => ({
    id: i + 1,
    client: new GoogleGenAI({ apiKey }),
    cooldownUntil: 0,
    requests: 0,
    errors: 0,
  }));

const geminiAvailable = () => geminiPool.filter((e) => e.cooldownUntil <= Date.now());

function geminiCooldown(entry, ms = CFG.geminiCooldownMs) {
  entry.cooldownUntil = Date.now() + ms;
  entry.errors++;
}

/* ═══════════════════════════════════════════════════════════════════════════
   CLIENTES IA
   ═══════════════════════════════════════════════════════════════════════════ */

const groq = KEYS.GROQ ? new Groq({ apiKey: KEYS.GROQ }) : null;
const nvidia = KEYS.NV
  ? new OpenAI({
      apiKey: KEYS.NV,
      baseURL: 'https://integrate.api.nvidia.com/v1',
    })
  : null;

/* ═══════════════════════════════════════════════════════════════════════════
   UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function short(t, n = 120) {
  if (!t) return '';
  const s = String(t);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function isRateLimit(err) {
  const msg = String(err?.message || '').toLowerCase();
  const st = err?.status ?? err?.code ?? 0;
  return (
    st === 429 ||
    st === 503 ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('overloaded')
  );
}

function isClientAbort(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const msg = String(err?.message || '').toLowerCase();
  return (
    (msg.includes('aborted') || msg.includes('abort')) &&
    !msg.includes('timeout')
  );
}

function sseDisconnected(sse, res) {
  return (
    (sse.isClosed && sse.isClosed()) ||
    res.destroyed ||
    res.writableEnded
  );
}

/* ─── Prompt injection guard ─── */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/i,
  /disregard\s+(all\s+)?(previous|prior)\s+rules?/i,
  /you\s+are\s+now\s+(a|an)\s+/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /\[system\]/i,
  /\[INST\]/i,
];

function isInjection(message) {
  if (!message) return false;
  const t = String(message);
  return INJECTION_PATTERNS.some((p) => p.test(t));
}

/* ─── IP rate limiter (capa 1) ─── */
const ipBuckets = new Map();

function checkIP(ip) {
  const now = Date.now();
  let b = ipBuckets.get(ip);
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + CFG.rateLimitIPWindow };
    ipBuckets.set(ip, b);
  }
  b.count++;
  return { allowed: b.count <= CFG.rateLimitIPMax, reset: b.reset };
}

const _ipCleanup = setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of ipBuckets) if (b.reset < now) ipBuckets.delete(ip);
}, 5 * 60_000);
if (_ipCleanup.unref) _ipCleanup.unref();

/* ═══════════════════════════════════════════════════════════════════════════
   IMÁGENES · helpers wrapper sobre services/images.js
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Wrapper compatible con la versión anterior de index.js.
 * Si services/images.js exporta las funciones correctas, se usan.
 * Si no, se usan los fallbacks locales.
 */
function buildImageUrlSafe(prompt, opts = {}) {
  try {
    return buildImageUrl(prompt, opts);
  } catch (e) {
    /* Fallback local */
    const {
      width = 1024,
      height = 1024,
      model = 'flux',
      seed = Math.floor(Math.random() * 1e6),
    } = opts;
    const enc = encodeURIComponent(String(prompt).trim().slice(0, 500));
    return `https://image.pollinations.ai/prompt/${enc}?width=${width}&height=${height}&model=${model}&seed=${seed}&nologo=true&enhance=true`;
  }
}

function isImageRequestSafe(msg) {
  try {
    return isImageRequest(msg);
  } catch (e) {
    /* Fallback: detección básica por regex */
    if (!msg) return false;
    const patterns = [
      /^genera(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
      /^crea(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
      /^haz(me)?\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
      /^dibuja(me)?\s+/i,
      /^ilustra(me)?\s+/i,
      /^quiero\s+ver\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
    ];
    return patterns.some((r) => r.test(String(msg).trim()));
  }
}

function extractImagePromptSafe(msg) {
  try {
    return extractImagePrompt(msg);
  } catch (e) {
    return String(msg)
      .replace(
        /^(genera(me)?|crea(me)?|haz(me)?)\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i,
        ''
      )
      .replace(/^dibuja(me)?\s+/i, '')
      .replace(/^ilustra(me)?\s+/i, '')
      .replace(/^quiero\s+ver\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i, '')
      .trim();
  }
}

function enrichImagePromptSafe(prompt) {
  try {
    return enrichImagePrompt(prompt);
  } catch (e) {
    if (
      /colombia|colombiano|colombiana|café|cumbia|vallenato|magdalena|cóndor|arepa|barranquilla|medellín|bogotá/i.test(
        prompt
      )
    ) {
      return (
        prompt +
        ', Colombia, vibrant colors, golden hour lighting, highly detailed, cinematic'
      );
    }
    return prompt + ', warm colors, artistic style, high quality, detailed';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   MEMORIAS · CACHÉ CON TTL
   ═══════════════════════════════════════════════════════════════════════════ */

const memCache = new Map();

async function loadMemories(req) {
  if (!req.user?.id) return [];
  const key = req.user.id;
  const cached = memCache.get(key);

  if (cached && Date.now() - cached.t < CFG.memCacheTtlMs) {
    return cached.v;
  }

  try {
    const list = await listarMemories(req.user.id);
    if (memCache.size >= CFG.memCacheMax) {
      const oldestKey = memCache.keys().next().value;
      memCache.delete(oldestKey);
    }
    memCache.set(key, { v: list, t: Date.now() });
    return list;
  } catch (e) {
    AppLog.warn('memorias:', e.message);
    return [];
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   CACHE DE RESPUESTAS IA · ahorra tokens en preguntas repetidas
   ═══════════════════════════════════════════════════════════════════════════ */

const responseCache = new Map();

function cacheKey(message, role) {
  return `${role}:${crypto.createHash('sha256').update(String(message)).digest('hex').slice(0, 16)}`;
}

function getCachedResponse(message, role) {
  const k = cacheKey(message, role);
  const entry = responseCache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.t > CFG.responseCacheTtlMs) {
    responseCache.delete(k);
    return null;
  }
  return entry.v;
}

function setCachedResponse(message, role, response) {
  if (responseCache.size >= CFG.responseCacheMax) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
  const k = cacheKey(message, role);
  responseCache.set(k, { v: response, t: Date.now() });
}

/* ═══════════════════════════════════════════════════════════════════════════
   SSE HELPERS · Wrapper sobre lib/sse.js con API compatible
   ═══════════════════════════════════════════════════════════════════════════ */

function setupSSE(req, res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  res.flushHeaders?.();

  if (res.socket?.setNoDelay)
    try {
      res.socket.setNoDelay(true);
    } catch {}
  if (res.socket?.setTimeout)
    try {
      res.socket.setTimeout(0);
    } catch {}

  let closed = false;
  let closeReason = null;
  const startedAt = Date.now();
  const controller = new AbortController();

  const abort = (reason) => {
    try {
      controller.abort(reason);
    } catch {}
  };

  const onClose = (reason) => {
    if (!closed) {
      closed = true;
      closeReason = reason;
      LOG.debug(`[${req.id}] SSE cerrado · ${reason} · ${Date.now() - startedAt}ms`);
      abort(reason);
    }
  };

  res.on('close', () => onClose('res.close'));
  res.on('error', (e) => onClose(`res.error:${e?.message || 'unknown'}`));

  const send = (data) => {
    if (closed || res.writableEnded) return false;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch (e) {
      onClose(`send.error:${e?.message || 'unknown'}`);
      return false;
    }
  };

  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;

    if (Date.now() - startedAt > CFG.sseMaxDurationMs) {
      LOG.warn(`[${req.id}] SSE excedió ${CFG.sseMaxDurationMs}ms, cerrando`);
      try {
        res.write(`data: ${JSON.stringify({ done: true, reason: 'max_duration' })}\n\n`);
      } catch {}
      try {
        res.end();
      } catch {}
      onClose('max_duration');
      clearInterval(heartbeat);
      return;
    }

    try {
      res.write(': keepalive\n\n');
    } catch (e) {
      onClose(`heartbeat.error:${e?.message || 'unknown'}`);
    }
  }, CFG.sseHeartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  const close = () => {
    clearInterval(heartbeat);
    if (!closed) {
      try {
        res.end();
      } catch {}
      closed = true;
      closeReason = closeReason || 'graceful';
      abort('graceful');
    }
  };

  return {
    send,
    close,
    isClosed: () => closed,
    getReason: () => closeReason,
    elapsed: () => Date.now() - startedAt,
    signal: controller.signal,
  };
}

function withFirstTokenTimeout(gen, timeoutMs, reqId, engineName) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`${engineName} no envió primer token en ${timeoutMs}ms`);
      err.kind = 'timeout';
      reject(err);
    }, timeoutMs);

    gen
      .next()
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

function buildStreamOpts({ reasoning, history, signal, reqId, providerName }) {
  const stats = { tokens: 0, chars: 0, elapsedMs: 0, tps: '0' };
  return {
    reasoning,
    history,
    signal,
    timeoutMs: CFG.aiFirstTokenTimeoutMs,
    onToken: () => {
      stats.tokens++;
    },
    onDone: (s) => {
      stats.tokens = s.tokens;
      stats.chars = s.chars;
      stats.elapsedMs = s.elapsedMs;
      stats.tps = s.tps;
      LOG.debug(`[${reqId}] ${providerName} OK · ${s.tokens} tokens · ${s.tps} tps`);
    },
    onError: (info) => {
      LOG.debug(`[${reqId}] ${providerName} retry ${info.attempt + 1} · ${info.kind}`);
    },
  };
}

const NAMES = { groq: 'Groq', gemini: 'Gemini', nvidia: 'Kimi K3' };

function orderMotors(file) {
  return file?.data ? ['gemini', 'nvidia', 'groq'] : ['groq', 'gemini', 'nvidia'];
}

/* ═══════════════════════════════════════════════════════════════════════════
   WEB SEARCH · normaliza resultados a estructura de sources
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Ejecuta web search y devuelve { sources, context }.
 * NUNCA tira exception · si falla, devuelve vacío.
 */
async function runWebSearch(query, reqId) {
  try {
    LOG.debug(`[${reqId}] webSearch · query="${short(query, 60)}"`);

    const results = await searchWeb(query, {
      maxResults: CFG.webSearchMaxResults,
      language: 'es',
      timeout: CFG.webSearchTimeoutMs,
    });

    if (!results || results.length === 0) {
      LOG.debug(`[${reqId}] webSearch · 0 resultados`);
      return { sources: [], context: '' };
    }

    const sources = results.map((r, i) => {
      let domain = '';
      try {
        domain = new URL(r.url).hostname.replace(/^www\./, '');
      } catch {
        domain = r.source || '';
      }

      return {
        title: r.title || r.url || `Fuente ${i + 1}`,
        url: r.url,
        snippet: (r.snippet || '').slice(0, 240),
        source: domain,
        trust: r.trust ?? null,
        position: i,
      };
    });

    const context = formatResultsForAI(query, results);

    LOG.info(`[${reqId}] webSearch · ${sources.length} fuentes inyectadas`);
    return { sources, context };
  } catch (e) {
    LOG.warn(`[${reqId}] webSearch falló: ${e.message}`);
    return { sources: [], context: '' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   PERSISTENCIA · Guardar mensajes con sources en Supabase
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Guarda el mensaje del asistente con sus fuentes.
 * Si falla, no rompe el stream.
 */
let _sbClient = null;

async function getSbClient() {
  if (_sbClient) return _sbClient;
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
    if (!url || !key) {
      LOG.warn('persist: faltan SUPABASE_URL o SUPABASE_SERVICE_KEY');
      return null;
    }
    _sbClient = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return _sbClient;
  } catch (e) {
    LOG.warn('persist: error creando cliente: ' + e.message);
    return null;
  }
}

async function persistAssistantMessage(req, { chatId, content, sources }) {
  if (!chatId || !content) {
    LOG.debug('[' + req.id + '] persist skip chatId=' + !!chatId + ' content=' + !!content);
    return;
  }
  if (!req.user?.id) {
    LOG.debug('[' + req.id + '] persist skip sin user');
    return;
  }

  try {
    const supabase = await getSbClient();
    if (!supabase) return;

    const payload = {
      id: crypto.randomUUID(),
      chatId,
      role: 'assistant',
      content: String(content).slice(0, 100000),
      sources: sources && sources.length > 0 ? sources : null,
      createdAt: new Date().toISOString(),
    };

    const { error } = await supabase.from('Message').insert(payload);

    if (error) {
      LOG.warn('[' + req.id + '] persist error: ' + error.message);
      return;
    }

    LOG.debug('[' + req.id + '] message persistido chat=' + chatId + ' sources=' + (sources?.length || 0));
  } catch (e) {
    LOG.warn('[' + req.id + '] persist excepcion: ' + e.message);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   APP EXPRESS
   ═══════════════════════════════════════════════════════════════════════════ */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* 1 · Request ID */
app.use(requestIdMiddleware());

/* 2 · Security headers */
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );
  if (IS_PROD)
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains'
    );
  next();
});

/* 3 · CORS */
app.use((req, res, next) => {
  const origin = req.get('origin');
  const allowed = [
    'http://localhost:8080',
    'http://127.0.0.1:8080',
    'https://numination.app',
    'https://www.numination.app',
    'https://numinationchat.vercel.app',
  ];
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Request-Id, X-Cron-Secret'
    );
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/* 4 · Rate limit por IP (capa 1) */
app.use((req, res, next) => {
  if (
    /^\/assets\//.test(req.path) ||
    /\.(js|css|png|jpg|svg|woff2?|ico)$/i.test(req.path)
  ) {
    return next();
  }
  const { allowed, reset } = checkIP(req.ip);
  if (!allowed) {
    res.setHeader(
      'Retry-After',
      String(Math.ceil((reset - Date.now()) / 1000))
    );
    return res.status(429).json({
      ok: false,
      error: 'Demasiadas peticiones. Espera un minuto.',
      code: 'limit_ip',
    });
  }
  next();
});

/* 5 · Body + cookies */
app.use(express.json({ limit: CFG.jsonLimit }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use(cookieParser());

/* 6 · Auth */
app.use(attachUser);

/* 7 · Notifications middleware */
app.use(notificationsMiddleware());

/* 8 · Analytics middleware */
app.use(analyticsMiddleware({ sampleHttp: 1, ignore4xx: false }));

/* 9 · Rate limit por usuario (capa 2) */
app.use(
  rateLimitUser({
    skipPaths: ['/api/health', '/api/version', '/api/ping'],
  })
);

/* 10 · Proteger /chat.html */
app.use((req, res, next) => {
  if (req.path === '/chat.html' && !req.user) return res.redirect('/login.html');
  next();
});

/* 11 · Static */
app.use(
  express.static(publicDir, {
    index: false,
    maxAge: IS_PROD ? '1h' : 0,
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  })
);

/* 12 · Root */
app.get('/', (req, res) => res.redirect('/login.html'));

/* ═══════════════════════════════════════════════════════════════════════════
   ROUTERS EXISTENTES
   ═══════════════════════════════════════════════════════════════════════════ */

mountAuthRoutes(app);
mountChatRoutes(app, requireAuth);
mountMemoryRoutes(app, requireAuth);
mountSkillsRoutes(app, requireAuth);
mountConnectorRoutes(app, requireAuth);
mountEmailRoutes(app, requireAuth);

/* ═══════════════════════════════════════════════════════════════════════════
   HELPERS · requireAdmin
   ═══════════════════════════════════════════════════════════════════════════ */

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      ok: false,
      error: 'No autenticado',
      code: 'auth_no_session',
    });
  }
  const role = String(req.user.role || '').toLowerCase();
  if (role !== 'admin') {
    return res.status(403).json({
      ok: false,
      error: 'Sin permisos de admin',
      code: 'auth_forbidden',
    });
  }
  next();
}

/* ═══════════════════════════════════════════════════════════════════════════
   LÍMITES
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/limits/usage', async (req, res) => {
  try {
    const stats = await getUsageStats(req);
    buildRateLimitHeaders(res, stats);
    return res.json({ ok: true, ...stats });
  } catch (e) {
    AppLog.error('limits/usage:', e.message);
    return res.status(500).json({ ok: false, error: 'Error consultando uso' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   HEALTH · VERSION · PING
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/health', async (req, res) => {
  const mem = process.memoryUsage();

  const [
    dbPing,
    limitsPing,
    analyticsPing,
    notifPing,
    webhookPing,
    searchPing,
    backupPing,
  ] = await Promise.all([
    pingDatabase().catch(() => ({ ok: false })),
    pingLimits().catch(() => ({ ok: false })),
    pingAnalytics().catch(() => ({ ok: false })),
    pingNotifications().catch(() => ({ ok: false })),
    pingWebhooks().catch(() => ({ ok: false })),
    pingSearch().catch(() => ({ ok: false })),
    pingBackup().catch(() => ({ ok: false })),
  ]);

  return res.json({
    ok: true,
    service: 'numination',
    version: VERSION,
    codename: 'Numi-OT.01',
    env: process.env.NODE_ENV || 'development',
    uptime: Math.floor(process.uptime()),
    priority: {
      text: ['groq', 'gemini', 'nvidia'],
      files: ['gemini', 'nvidia', 'groq'],
    },
    models: MODELS,
    engines: {
      groq: Boolean(groq),
      gemini: geminiPool.length > 0,
      nvidia: Boolean(nvidia),
      geminiPool: geminiPool.map((e) => ({
        id: e.id,
        cooldown: e.cooldownUntil > Date.now(),
        requests: e.requests,
        errors: e.errors,
      })),
    },
    keys: {
      groq: Boolean(KEYS.GROQ),
      gemini_1: Boolean(KEYS.GM1),
      gemini_2: Boolean(KEYS.GM2),
      gemini_3: Boolean(KEYS.GM3),
      nvidia: Boolean(KEYS.NV),
    },
    features: {
      webSearch: true,
      images: true,
      sources: true,
      cache: {
        memories: memCache.size,
        responses: responseCache.size,
      },
    },
    database: { connected: supabaseDisponible(), ping: dbPing },
    limits: limitsPing,
    analytics: analyticsPing,
    notifications: notifPing,
    webhooks: webhookPing,
    search: searchPing,
    backup: backupPing,
    auth: {
      session: Boolean(req.user),
      email: req.user?.email || null,
    },
    runtime: {
      node: process.version,
      memory: {
        rss: Math.round(mem.rss / 1024 / 1024) + ' MB',
        heap: Math.round(mem.heapUsed / 1024 / 1024) + ' MB',
      },
    },
    ts: new Date().toISOString(),
  });
});

app.get('/api/version', (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    name: 'Numination',
    codename: 'Numi-OT.01',
    env: process.env.NODE_ENV || 'development',
    models: MODELS,
  });
});

app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, pong: Date.now() });
});

/* ═══════════════════════════════════════════════════════════════════════════
   NOTIFICATIONS · endpoints de usuario
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit || '50', 10));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const inbox = await getInbox(req.user.id, { limit, offset });
    return res.json({ ok: true, ...inbox });
  } catch (e) {
    AppLog.error('notifications.list:', e.message);
    return res.status(500).json({ ok: false, error: 'Error cargando notificaciones' });
  }
});

app.get('/api/notifications/unread', requireAuth, async (req, res) => {
  try {
    const count = await getUnreadCount(req.user.id);
    return res.json({ ok: true, unread: count });
  } catch {
    return res.json({ ok: true, unread: 0 });
  }
});

app.post('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await markAllRead(req.user.id);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ ok: false, error: 'Error' });
  }
});

app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const ok = await markRead(req.user.id, req.params.id);
    return res.json({ ok });
  } catch {
    return res.status(500).json({ ok: false, error: 'Error' });
  }
});

app.delete('/api/notifications', requireAuth, async (req, res) => {
  try {
    await clearInbox(req.user.id);
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ ok: false, error: 'Error' });
  }
});

app.get('/api/notifications/preferences', requireAuth, async (req, res) => {
  try {
    const prefs = await getPreferences(req.user.id);
    return res.json({ ok: true, preferences: prefs });
  } catch {
    return res.status(500).json({ ok: false, error: 'Error' });
  }
});

app.patch('/api/notifications/preferences', requireAuth, async (req, res) => {
  try {
    const result = await updatePreferences(req.user.id, req.body || {});
    return res.json({ ok: true, preferences: result.prefs });
  } catch {
    return res.status(500).json({ ok: false, error: 'Error' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   SEARCH · endpoints
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, items: [], total: 0 });

    const types = req.query.types
      ? String(req.query.types).split(',').map((s) => s.trim())
      : undefined;

    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

    const result = await search(q, req.user.id, { types, limit });
    return res.json(result);
  } catch (e) {
    AppLog.error('search:', e.message);
    return res.status(500).json({ ok: false, error: 'Error buscando' });
  }
});

app.get('/api/search/suggest', requireAuth, async (req, res) => {
  try {
    const prefix = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '8', 10), 20);
    const result = await suggest(prefix, req.user.id, { limit });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, suggestions: [] });
  }
});

app.get('/api/search/recent', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 30);
    const recent = await getRecentSearches(req.user.id, { limit });
    return res.json({ ok: true, recent });
  } catch {
    return res.json({ ok: true, recent: [] });
  }
});

app.delete('/api/search/recent', requireAuth, async (req, res) => {
  await clearRecentSearches(req.user.id);
  return res.json({ ok: true });
});

app.get('/api/search/trending', async (_req, res) => {
  try {
    const limit = Math.min(parseInt(_req.query.limit || '10', 10), 50);
    const trending = await getTrendingSearches({ limit });
    return res.json({ ok: true, trending });
  } catch {
    return res.json({ ok: true, trending: [] });
  }
});

app.post('/api/search/saved', requireAuth, async (req, res) => {
  const { name, query, filters } = req.body || {};
  const result = await saveSearch(req.user.id, { name, query, filters });
  return res.status(result.ok ? 201 : 400).json(result);
});

app.get('/api/search/saved', requireAuth, async (req, res) => {
  const saved = await listSavedSearches(req.user.id);
  return res.json({ ok: true, saved });
});

app.delete('/api/search/saved/:id', requireAuth, async (req, res) => {
  const ok = await deleteSavedSearch(req.user.id, req.params.id);
  return res.json({ ok });
});

/* ═══════════════════════════════════════════════════════════════════════════
   WEBHOOKS · endpoints
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/webhooks', requireAuth, async (req, res) => {
  const subs = await listSubscriptions(req.user.id);
  const safe = subs.map((s) => ({ ...s, secret: undefined }));
  return res.json({ ok: true, webhooks: safe });
});

app.post('/api/webhooks', requireAuth, async (req, res) => {
  const result = await createSubscription(req.user.id, {
    url: req.body?.url,
    events: req.body?.events,
    description: req.body?.description,
    filters: req.body?.filters,
  });
  if (!result.ok) return res.status(400).json(result);
  return res.status(201).json({ ok: true, webhook: result.subscription });
});

app.get('/api/webhooks/events', (_req, res) => {
  return res.json({ ok: true, events: Object.values(WEBHOOK_EVENTS) });
});

app.get('/api/webhooks/:id', requireAuth, async (req, res) => {
  const sub = await getSubscription(req.params.id);
  if (!sub) return res.status(404).json({ ok: false, error: 'not_found' });
  if (sub.userId !== req.user.id)
    return res.status(403).json({ ok: false, error: 'forbidden' });
  return res.json({ ok: true, webhook: { ...sub, secret: undefined } });
});

app.patch('/api/webhooks/:id', requireAuth, async (req, res) => {
  const result = await updateSubscription(req.params.id, req.user.id, req.body || {});
  if (!result.ok) return res.status(400).json(result);
  return res.json({ ok: true, webhook: { ...result.subscription, secret: undefined } });
});

app.delete('/api/webhooks/:id', requireAuth, async (req, res) => {
  const result = await deleteSubscription(req.params.id, req.user.id);
  return res.json(result);
});

app.post('/api/webhooks/:id/rotate-secret', requireAuth, async (req, res) => {
  const result = await rotateSecret(req.params.id, req.user.id);
  if (!result.ok) return res.status(400).json(result);
  return res.json({ ok: true, secret: result.secret });
});

app.post('/api/webhooks/:id/test', requireAuth, async (req, res) => {
  const result = await testSubscription(req.params.id, req.user.id);
  return res.json(result);
});

app.get('/api/webhooks/:id/deliveries', requireAuth, async (req, res) => {
  const sub = await getSubscription(req.params.id);
  if (!sub || sub.userId !== req.user.id)
    return res.status(403).json({ ok: false });
  const deliveries = await getDeliveryLog(req.params.id, {
    limit: Math.min(100, parseInt(req.query.limit || '50', 10)),
  });
  return res.json({ ok: true, deliveries });
});

app.get('/api/webhooks/:id/dlq', requireAuth, async (req, res) => {
  const sub = await getSubscription(req.params.id);
  if (!sub || sub.userId !== req.user.id)
    return res.status(403).json({ ok: false });
  const dlq = await getDlq(req.params.id, {
    limit: Math.min(100, parseInt(req.query.limit || '50', 10)),
  });
  return res.json({ ok: true, dlq });
});

app.post('/api/webhooks/:id/dlq/retry', requireAuth, async (req, res) => {
  const sub = await getSubscription(req.params.id);
  if (!sub || sub.userId !== req.user.id)
    return res.status(403).json({ ok: false });
  const result = await retryFromDlq(req.params.id, req.body?.deliveryId);
  return res.json(result);
});

app.delete('/api/webhooks/:id/dlq', requireAuth, async (req, res) => {
  const sub = await getSubscription(req.params.id);
  if (!sub || sub.userId !== req.user.id)
    return res.status(403).json({ ok: false });
  const ok = await clearDlq(req.params.id);
  return res.json({ ok });
});

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN · Analytics
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/admin/analytics', requireAuth, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(90, parseInt(req.query.days || '7', 10));
    return res.json(await getAnalyticsSnapshot({ days }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/analytics/dau', requireAuth, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(90, parseInt(req.query.days || '30', 10));
    const [dau, wau, mau] = await Promise.all([
      getDailyActiveUsers(days),
      getWeeklyActiveUsers(),
      getMonthlyActiveUsers(),
    ]);
    return res.json({
      ok: true,
      dau: dau.ok ? dau : null,
      wau: wau.ok ? wau : null,
      mau: mau.ok ? mau : null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/analytics/retention', requireAuth, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(30, parseInt(req.query.days || '14', 10));
    return res.json(await getAverageRetention(days));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/analytics/funnel', requireAuth, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(30, parseInt(req.query.days || '7', 10));
    return res.json(await getSignupFunnel(days));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/analytics/cohorts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const weeks = Math.min(16, parseInt(req.query.weeks || '8', 10));
    return res.json(await getWeeklyCohorts(weeks));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/analytics/events', requireAuth, requireAdmin, async (req, res) => {
  try {
    const days = Math.min(30, parseInt(req.query.days || '7', 10));
    const limit = Math.min(50, parseInt(req.query.limit || '20', 10));
    const [events, providers, plans] = await Promise.all([
      getTopEvents(days, limit),
      getProviderUsage(days),
      getPlanDistribution(days),
    ]);
    return res.json({ ok: true, events, providers, plans });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN · Métricas y health
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/admin/metrics', requireAuth, requireAdmin, async (_req, res) => {
  try {
    return res.json({
      ok: true,
      errors: getErrorMetrics(10),
      rateLimit: getRateLimitMetrics(10),
      webhooks: getWebhookStats(),
      cache: {
        memories: memCache.size,
        responses: responseCache.size,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/health', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [db, limits, analytics, notif, webhooks, search, backup] =
      await Promise.all([
        pingDatabase().catch(() => ({ ok: false })),
        pingLimits().catch(() => ({ ok: false })),
        pingAnalytics().catch(() => ({ ok: false })),
        pingNotifications().catch(() => ({ ok: false })),
        pingWebhooks().catch(() => ({ ok: false })),
        pingSearch().catch(() => ({ ok: false })),
        pingBackup().catch(() => ({ ok: false })),
      ]);
    return res.json({
      ok: true,
      db,
      limits,
      analytics,
      notifications: notif,
      webhooks,
      search,
      backup,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN · Migraciones
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/admin/migrations', requireAuth, requireAdmin, async (_req, res) => {
  try {
    return res.json(await getMigrationsStatus());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/migrations/run', requireAuth, requireAdmin, async (req, res) => {
  try {
    const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;
    return res.json(await runMigrations({ dryRun }));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/migrations/verify', requireAuth, requireAdmin, async (_req, res) => {
  try {
    return res.json(await verifyMigrations());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN · Webhooks globales
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/admin/webhooks', requireAuth, requireAdmin, async (_req, res) => {
  try {
    return res.json({
      ok: true,
      stats: getWebhookStats(),
      ping: await pingWebhooks().catch(() => ({ ok: false })),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN · Notificar manualmente
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/admin/notify', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { to, subject, message } = req.body || {};
    if (!to || !subject) {
      return res.status(400).json({ ok: false, error: 'Faltan campos' });
    }
    const result = await notify(TYPES.SYSTEM_ALERT, {
      userId: `admin:${req.user.email}`,
      email: to,
      data: { alert: subject, message: message || '(sin mensaje)' },
      force: true,
    });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN · Backup
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/admin/backup', requireAuth, requireAdmin, async (_req, res) => {
  try {
    return res.json(await listBackups());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/backup', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await createBackup({
      createdBy: req.user.email,
      reason: req.body?.reason || 'manual',
    });
    return res.status(result.ok ? 201 : 500).json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/backup/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    return res.json(await getBackup(req.params.id));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/backup/:id/download', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await downloadBackup(req.params.id);
    if (!result.ok) return res.status(404).json(result);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`
    );
    return res.send(result.buffer);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/backup/:id/restore', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await restoreBackup(req.params.id, {
      confirm: req.body?.confirm,
      truncate: req.body?.truncate === true,
      tables: req.body?.tables,
    });
    return res.status(result.ok ? 200 : 400).json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/admin/backup/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    return res.json(await deleteBackup(req.params.id));
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/admin/backup/retention', requireAuth, requireAdmin, async (_req, res) => {
  try {
    return res.json(await runRetention());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* Cron endpoint: backup programado */
app.post('/api/admin/backup/cron', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    return res.json(await scheduledBackup());
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   CHAT STREAMING · SSE · CON WEB SEARCH E IMÁGENES
   ═══════════════════════════════════════════════════════════════════════════

   Novedades v9.0:
     · Web search opcional (body.webSearch === true)
     · Imágenes también por SSE (antes solo sin stream)
     · Sources enviadas por SSE y persistidas en Message.sources
     · Cache de respuestas para preguntas repetidas
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/chat/stream', async (req, res) => {
  const t0 = Date.now();

  try {
    /* ─── Límites ─── */
    const lim = await verificarLimite(req);
    buildRateLimitHeaders(res, lim);

    if (!lim.permitido) {
      if (lim.retryAfter) res.setHeader('Retry-After', String(lim.retryAfter));
      return res.status(429).json({
        ok: false,
        error: lim.mensaje,
        razon: lim.razon,
        retryAfter: lim.retryAfter,
        plan: lim.plan,
        uso: lim.uso,
        limites: lim.limites,
      });
    }

    /* ─── Extraer body ─── */
    const {
      message,
      role = 'student',
      file = null,
      incognito = false,
      history = [],
      webSearch = false,       /* ← NUEVO */
      chatId = null,           /* ← NUEVO · para persistir */
    } = req.body ?? {};

    const hasText = message && String(message).trim();
    const hasFile = file?.data;

    /* ─── Validaciones ─── */
    if (!hasText && !hasFile) {
      return res.status(400).json({ ok: false, error: 'Falta el mensaje o archivo' });
    }
    if (hasText && String(message).length > CFG.maxMsgLen) {
      return res.status(400).json({
        ok: false,
        error: `Mensaje muy largo (máx ${CFG.maxMsgLen} caracteres)`,
      });
    }
    if (hasText && isInjection(message)) {
      LOG.warn(`[${req.id}] Injection bloqueado`);
      return res.status(403).json({
        ok: false,
        error:
          'No puedo procesar esa instrucción. Reformúlala como una pregunta educativa.',
        code: 'chat_injection_blocked',
      });
    }

    const isReasoning = role === 'reasoning';
    const effectiveRole = isReasoning ? 'reasoning' : role;
    const finalMessage = buildFinalMessage(message, isReasoning);

    /* ─── Memorias ─── */
    const memories = incognito ? [] : await loadMemories(req);

    /* ─── Detectar imagen ─── */
    const wantsImage =
      hasText && !hasFile && !isReasoning && isImageRequestSafe(message);

    /* ─── Ejecutar web search ANTES de abrir SSE ─── */
    let webSources = [];
    let webContext = '';

    if (webSearch === true && hasText && !wantsImage && !isReasoning) {
      const { sources, context } = await runWebSearch(message, req.id);
      webSources = sources;
      webContext = context;
    }

    /* ─── System prompt con contexto de búsqueda ─── */
    let systemPrompt = buildSystemPrompt(effectiveRole, memories, {
      userId: req.user?.id,
      strategy: 'ab',
    });

    if (webContext) {
      systemPrompt += '\n\n' + webContext;
    }

    LOG.debug(
      `[${req.id}] stream · ${effectiveRole}${incognito ? ' · incognito' : ''} · mem=${memories.length} · hist=${
        Array.isArray(history) ? history.length : 0
      } · file=${hasFile ? 'sí' : 'no'} · web=${webSources.length} · img=${wantsImage ? 'sí' : 'no'}`
    );

    /* ─── Abrir SSE ─── */
    const sse = setupSSE(req, res);

    /* ─── Meta inicial ─── */
    sse.send({
      meta: {
        plan: lim.plan,
        restanteDia: lim.restanteDia,
        restanteMin: lim.restanteMin,
        mode: effectiveRole,
        memories: memories.length,
        history: Array.isArray(history) ? history.length : 0,
        incognito,
        requestId: req.id,
        version: VERSION,
        webSearch: webSources.length > 0,
      },
    });

    /* ─── Mandar fuentes ANTES de los tokens ─── */
    if (webSources.length > 0) {
      sse.send({ sources: webSources });
    }

    /* ─── Analytics ─── */
    if (req.user?.id && !incognito) {
      track(ANALYTICS_EVENTS.AI_REQUEST, {
        userId: req.user.id,
        meta: { mode: effectiveRole, webSearch: webSources.length > 0 },
      });
    }

    /* ─── MODO IMAGEN · respuesta sintética por SSE ─── */
    if (wantsImage) {
      const imgPrompt = extractImagePromptSafe(message);
      if (imgPrompt.length > 3) {
        LOG.info(`[${req.id}] Imagen: "${short(imgPrompt, 60)}"`);

        const enriched = enrichImagePromptSafe(imgPrompt);
        const imageUrl = buildImageUrlSafe(enriched);

        const replyText =
          `Listo, aquí está tu imagen de: **${imgPrompt}**\n\n` +
          `Si quieres otra versión, pídeme "otra imagen de..." y crearé una variación.`;

        /* Mandar como tokens para que el frontend lo renderice igual */
        sse.send({ token: replyText, done: false });
        sse.send({
          image: { url: imageUrl, prompt: imgPrompt },
          done: true,
          provider: 'pollinations',
        });

        if (!incognito) {
          registrarUso(req).catch(() => {});
          if (chatId) {
            persistAssistantMessage(req, {
              chatId,
              content: replyText + `\n\n![imagen](${imageUrl})`,
              sources: null,
            }).catch(() => {});
          }
        }

        finishSSE(
          sse,
          req,
          incognito,
          t0,
          50,
          'pollinations',
          null,
          chatId
        );
        return;
      }
    }

    /* ─── Verificar cache (solo chat normal, no coder ni reasoning) ─── */
    if (
      !incognito &&
      !hasFile &&
      !isReasoning &&
      !webSearch &&
      !wantsImage &&
      hasText
    ) {
      const cached = getCachedResponse(message, effectiveRole);
      if (cached) {
        LOG.debug(`[${req.id}] cache hit`);
        sse.send({ token: cached, done: false });
        sse.send({ done: true, provider: 'cache', cached: true });
        finishSSE(sse, req, incognito, t0, 0, 'cache', null, chatId);
        return;
      }
    }

    /* ─── Iteración por motores ─── */
    let responded = false;
    let tokens = 0;
    let chosenProvider = null;
    let fullAnswer = '';

    for (const prov of orderMotors(file)) {
      if (sseDisconnected(sse, res)) break;

      /* ─── GEMINI ─── */
      if (prov === 'gemini') {
        const candidates = geminiAvailable();
        if (!candidates.length) continue;

        let ok = false;
        for (const entry of candidates) {
          if (sseDisconnected(sse, res)) break;

          const opts = buildStreamOpts({
            reasoning: isReasoning,
            history,
            signal: sse.signal,
            reqId: req.id,
            providerName: `Gemini#${entry.id}`,
          });

          try {
            LOG.debug(`[${req.id}] Gemini #${entry.id} streaming...`);
            let local = 0;
            entry.requests++;

            const gen = streamGemini(
              entry.client,
              systemPrompt,
              finalMessage,
              file,
              opts
            );

            let first;
            try {
              first = await withFirstTokenTimeout(
                gen,
                CFG.aiFirstTokenTimeoutMs,
                req.id,
                `Gemini#${entry.id}`
              );
            } catch (e) {
              throw new Error(`Gemini#${entry.id} timeout: ${e.message}`);
            }

            if (!first.done && first.value) {
              sse.send({ token: first.value, done: false });
              fullAnswer += first.value;
              responded = true;
              tokens++;
              local++;
            }
            for await (const token of gen) {
              if (sseDisconnected(sse, res)) break;
              sse.send({ token, done: false });
              fullAnswer += token;
              responded = true;
              tokens++;
              local++;
            }
            if (local > 0) {
              sse.send({ token: '', done: true, provider: `gemini-${entry.id}` });
              ok = true;
              chosenProvider = `gemini-${entry.id}`;
              break;
            }
            throw new Error('Gemini no devolvió tokens');
          } catch (err) {
            LOG.warn(
              `[${req.id}] Gemini #${entry.id} falló: ${short(err.message, 100)}`
            );
            if (isClientAbort(err) || sseDisconnected(sse, res)) break;
            if (isRateLimit(err) && !responded) {
              geminiCooldown(entry);
              continue;
            }
            if (responded) {
              sse.send({
                token: '',
                done: true,
                provider: `gemini-${entry.id}`,
                partial: true,
              });
              ok = true;
              chosenProvider = `gemini-${entry.id}`;
              break;
            }
            geminiCooldown(entry, CFG.geminiSoftCooldownMs);
          }
        }
        if (ok) {
          finishSSE(
            sse,
            req,
            incognito,
            t0,
            tokens,
            chosenProvider,
            fullAnswer,
            chatId,
            webSources
          );
          return;
        }
        if (responded || sseDisconnected(sse, res)) {
          finishSSE(
            sse,
            req,
            incognito,
            t0,
            tokens,
            chosenProvider || 'gemini-partial',
            fullAnswer,
            chatId,
            webSources
          );
          return;
        }
      }

      /* ─── GROQ ─── */
      else if (prov === 'groq') {
        if (!groq) continue;
        const opts = buildStreamOpts({
          reasoning: isReasoning,
          history,
          signal: sse.signal,
          reqId: req.id,
          providerName: 'Groq',
        });
        try {
          LOG.debug(`[${req.id}] Groq streaming...`);
          let local = 0;

          const gen = streamGroq(groq, systemPrompt, finalMessage, file, opts);

          let first;
          try {
            first = await withFirstTokenTimeout(
              gen,
              CFG.aiFirstTokenTimeoutMs,
              req.id,
              'Groq'
            );
          } catch (e) {
            throw new Error(`Groq timeout: ${e.message}`);
          }

          if (!first.done && first.value) {
            sse.send({ token: first.value, done: false });
            fullAnswer += first.value;
            responded = true;
            tokens++;
            local++;
          }
          for await (const token of gen) {
            if (sseDisconnected(sse, res)) break;
            sse.send({ token, done: false });
            fullAnswer += token;
            responded = true;
            tokens++;
            local++;
          }
          if (local > 0) {
            sse.send({ token: '', done: true, provider: 'groq' });
            finishSSE(
              sse,
              req,
              incognito,
              t0,
              tokens,
              'groq',
              fullAnswer,
              chatId,
              webSources
            );
            return;
          }
          throw new Error('Groq no devolvió tokens');
        } catch (err) {
          LOG.warn(`[${req.id}] Groq falló: ${short(err.message, 100)}`);
          if (isClientAbort(err) || sseDisconnected(sse, res)) {
            finishSSE(
              sse,
              req,
              incognito,
              t0,
              tokens,
              'groq-aborted',
              fullAnswer,
              chatId,
              webSources
            );
            return;
          }
          if (responded) {
            sse.send({ token: '', done: true, provider: 'groq', partial: true });
            finishSSE(
              sse,
              req,
              incognito,
              t0,
              tokens,
              'groq',
              fullAnswer,
              chatId,
              webSources
            );
            return;
          }
        }
      }

      /* ─── NVIDIA / KIMI ─── */
      else if (prov === 'nvidia') {
        if (!nvidia) continue;
        const opts = buildStreamOpts({
          reasoning: isReasoning,
          history,
          signal: sse.signal,
          reqId: req.id,
          providerName: 'Kimi',
        });
        try {
          LOG.debug(`[${req.id}] Kimi streaming...`);
          let local = 0;

          const gen = streamKimi(nvidia, systemPrompt, finalMessage, file, opts);

          let first;
          try {
            first = await withFirstTokenTimeout(
              gen,
              CFG.aiFirstTokenTimeoutMs,
              req.id,
              'Kimi'
            );
          } catch (e) {
            throw new Error(`Kimi timeout: ${e.message}`);
          }

          if (!first.done && first.value) {
            sse.send({ token: first.value, done: false });
            fullAnswer += first.value;
            responded = true;
            tokens++;
            local++;
          }
          for await (const token of gen) {
            if (sseDisconnected(sse, res)) break;
            sse.send({ token, done: false });
            fullAnswer += token;
            responded = true;
            tokens++;
            local++;
          }
          if (local > 0) {
            sse.send({ token: '', done: true, provider: 'nvidia' });
            finishSSE(
              sse,
              req,
              incognito,
              t0,
              tokens,
              'nvidia',
              fullAnswer,
              chatId,
              webSources
            );
            return;
          }
          throw new Error('Kimi no devolvió tokens');
        } catch (err) {
          LOG.warn(`[${req.id}] Kimi falló: ${short(err.message, 100)}`);
          if (isClientAbort(err) || sseDisconnected(sse, res)) {
            finishSSE(
              sse,
              req,
              incognito,
              t0,
              tokens,
              'nvidia-aborted',
              fullAnswer,
              chatId,
              webSources
            );
            return;
          }
          if (responded) {
            sse.send({
              token: '',
              done: true,
              provider: 'nvidia',
              partial: true,
            });
            finishSSE(
              sse,
              req,
              incognito,
              t0,
              tokens,
              'nvidia',
              fullAnswer,
              chatId,
              webSources
            );
            return;
          }
        }
      }
    }

    /* ─── Todos fallaron ─── */
    if (!responded && !sseDisconnected(sse, res)) {
      LOG.error(`[${req.id}] Todos los motores fallaron · reembolsando`);
      if (!incognito) {
        reembolsarUso(req).catch(() => {});
        dispatch(WEBHOOK_EVENTS.AI_ALL_FAILED, {
          userId: req.user?.id,
          data: { mode: effectiveRole },
        }).catch(() => {});
        if (req.user?.id) {
          track(ANALYTICS_EVENTS.AI_ERROR, {
            userId: req.user.id,
            meta: { provider: 'all', code: 'all_failed' },
          });
        }
      }
      sse.send({
        error: 'Los motores de IA están saturados. Intenta de nuevo en unos segundos.',
        done: true,
      });
      sse.close();
    } else if (!sse.isClosed()) {
      sse.close();
    }
  } catch (err) {
    LOG.error(`[${req.id}] Error en stream: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'Error interno del servidor' });
    }
  }
});

/**
 * finishSSE · cierre limpio con persistencia de sources.
 */
function finishSSE(
  sse,
  req,
  incognito,
  t0,
  tokens,
  provider,
  fullAnswer = '',
  chatId = null,
  webSources = null
) {
  const dur = Date.now() - t0;

  if (!incognito) {
    registrarUso(req).catch(() => {});

    if (req.user?.id) {
      track(ANALYTICS_EVENTS.CHAT_MESSAGE_RECEIVED, {
        userId: req.user.id,
        meta: {
          provider,
          durationMs: dur,
          tokens,
          sources: webSources?.length || 0,
        },
      });
      dispatch(WEBHOOK_EVENTS.CHAT_MESSAGE_RECEIVED, {
        userId: req.user.id,
        data: { provider, tokens, durationMs: dur },
      }).catch(() => {});
    }
  }

  /* Persistir mensaje con sources si hay chatId */
  if (chatId && fullAnswer && !incognito) {
    persistAssistantMessage(req, {
      chatId,
      content: fullAnswer,
      sources: webSources,
    }).catch(() => {});
  }

  /* Cache de respuesta (solo chat normal sin file/websearch/imagen) */
  if (
    !incognito &&
    fullAnswer &&
    fullAnswer.length > 20 &&
    provider !== 'cache' &&
    !webSources &&
    req.body?.role !== 'reasoning' &&
    !req.body?.file
  ) {
    setCachedResponse(req.body?.message || '', req.body?.role || 'student', fullAnswer);
  }

  setImmediate(() => {
    sse.close();
    LOG.debug(
      `[${req.id}] Stream cerrado en ${dur}ms · ~${tokens} tokens · ${provider}`
    );
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   CHAT NORMAL · SIN STREAMING
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/chat', async (req, res) => {
  const t0 = Date.now();

  try {
    const lim = await verificarLimite(req);
    buildRateLimitHeaders(res, lim);

    if (!lim.permitido) {
      if (lim.retryAfter) res.setHeader('Retry-After', String(lim.retryAfter));
      return res.status(429).json({
        ok: false,
        error: lim.mensaje,
        razon: lim.razon,
        retryAfter: lim.retryAfter,
        plan: lim.plan,
        uso: lim.uso,
        limites: lim.limites,
      });
    }

    const {
      message,
      role = 'student',
      file = null,
      incognito = false,
      history = [],
      webSearch = false,        /* ← NUEVO */
      chatId = null,
    } = req.body ?? {};

    const hasText = message && String(message).trim();
    const hasFile = file?.data;

    if (!hasText && !hasFile) {
      return res.status(400).json({ ok: false, error: 'Falta el mensaje o archivo' });
    }
    if (hasText && String(message).length > CFG.maxMsgLen) {
      return res.status(400).json({ ok: false, error: 'Mensaje muy largo' });
    }
    if (hasText && isInjection(message)) {
      return res.status(403).json({
        ok: false,
        error: 'No puedo procesar esa instrucción.',
        code: 'chat_injection_blocked',
      });
    }

    const isReasoning = role === 'reasoning';
    const effectiveRole = isReasoning ? 'reasoning' : role;
    const finalMessage = buildFinalMessage(message, isReasoning);

    /* ─── Imagen ─── */
    if (hasText && !hasFile && !isReasoning && isImageRequestSafe(message)) {
      const imgPrompt = extractImagePromptSafe(message);
      if (imgPrompt.length > 3) {
        LOG.info(`[${req.id}] Imagen: "${short(imgPrompt, 60)}"`);
        const imageUrl = buildImageUrlSafe(enrichImagePromptSafe(imgPrompt));

        if (!incognito) registrarUso(req).catch(() => {});

        const replyText =
          `Listo, aquí está tu imagen de: **${imgPrompt}**\n\n` +
          `Si quieres otra versión, pídeme "otra imagen de..." y crearé una variación.`;

        if (chatId && !incognito) {
          persistAssistantMessage(req, {
            chatId,
            content: replyText + `\n\n![imagen](${imageUrl})`,
            sources: null,
          }).catch(() => {});
        }

        return res.json({
          ok: true,
          reply: replyText,
          imageUrl,
          imagePrompt: imgPrompt,
          type: 'image',
          provider: 'pollinations',
        });
      }
    }

    /* ─── Web search ─── */
    let webSources = [];
    let webContext = '';

    if (webSearch === true && hasText && !isReasoning && !hasFile) {
      const { sources, context } = await runWebSearch(message, req.id);
      webSources = sources;
      webContext = context;
    }

    /* ─── Cache ─── */
    if (
      !incognito &&
      !hasFile &&
      !isReasoning &&
      !webSearch &&
      hasText
    ) {
      const cached = getCachedResponse(message, effectiveRole);
      if (cached) {
        LOG.debug(`[${req.id}] cache hit`);
        return res.json({
          ok: true,
          reply: cached,
          provider: 'cache',
          cached: true,
          mode: effectiveRole,
          durationMs: 0,
        });
      }
    }

    const memories = incognito ? [] : await loadMemories(req);
    let systemPrompt = buildSystemPrompt(effectiveRole, memories, {
      userId: req.user?.id,
      strategy: 'ab',
    });

    if (webContext) {
      systemPrompt += '\n\n' + webContext;
    }

    const order = orderMotors(file);
    const attempts = [order[0], order[0], order[1], order[2], order[1], order[2]];
    let lastErr = null;

    for (let i = 0; i < attempts.length; i++) {
      const prov = attempts[i];
      if (i > 0) await sleep(CFG.retryBaseDelayMs);

      try {
        LOG.debug(`[${req.id}] Intento ${i + 1}/${attempts.length} · ${NAMES[prov]}`);
        const reply = await collectStream(
          prov,
          systemPrompt,
          finalMessage,
          file,
          history,
          isReasoning
        );

        if (reply && reply.trim()) {
          const dur = Date.now() - t0;
          LOG.ok(`[${req.id}] ${NAMES[prov]} respondió en ${dur}ms`);

          if (!incognito) registrarUso(req).catch(() => {});

          /* Persistir */
          if (chatId && !incognito) {
            persistAssistantMessage(req, {
              chatId,
              content: reply,
              sources: webSources,
            }).catch(() => {});
          }

          /* Cache */
          if (
            !incognito &&
            !webSearch &&
            !hasFile &&
            !isReasoning &&
            reply.length > 20
          ) {
            setCachedResponse(message, effectiveRole, reply);
          }

          return res.json({
            ok: true,
            reply,
            provider: prov,
            mode: effectiveRole,
            durationMs: dur,
            sources: webSources.length > 0 ? webSources : undefined,
          });
        }
        throw new Error('Respuesta vacía');
      } catch (err) {
        lastErr = err;
        LOG.warn(`[${req.id}] ${NAMES[prov]} falló: ${short(err.message, 100)}`);
        if (!isRateLimit(err)) break;
      }
    }

    LOG.error(`[${req.id}] Todos los intentos fallaron · reembolsando`);
    if (!incognito) reembolsarUso(req).catch(() => {});

    return res.status(503).json({
      ok: false,
      error:
        'Los motores de IA están saturados. Espera unos segundos e intenta de nuevo.',
    });
  } catch (err) {
    LOG.error(`[${req.id}] Error: ${err.message}`);
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

async function collectStream(prov, systemPrompt, finalMessage, file, history, isReasoning) {
  const opts = {
    reasoning: isReasoning,
    history,
    timeoutMs: CFG.aiFirstTokenTimeoutMs,
  };

  let gen;
  if (prov === 'groq') {
    if (!groq) throw new Error('Groq no configurado');
    gen = streamGroq(groq, systemPrompt, finalMessage, file, opts);
  } else if (prov === 'gemini') {
    const first = geminiAvailable()[0];
    if (!first) throw new Error('Gemini no disponible');
    first.requests++;
    gen = streamGemini(first.client, systemPrompt, finalMessage, file, opts);
  } else if (prov === 'nvidia') {
    if (!nvidia) throw new Error('Kimi no configurado');
    gen = streamKimi(nvidia, systemPrompt, finalMessage, file, opts);
  } else {
    throw new Error('Motor desconocido: ' + prov);
  }

  const parts = [];
  for await (const token of gen) parts.push(token);
  return parts.join('');
}

/* ═══════════════════════════════════════════════════════════════════════════
   CATCH-ALL + ERROR HANDLER
   ═══════════════════════════════════════════════════════════════════════════ */

app.use(notFoundMiddleware(publicDir));
app.use(errorMiddleware({ includeStack: !IS_PROD }));

/* ═══════════════════════════════════════════════════════════════════════════
   BOOT + SHUTDOWN
   ═══════════════════════════════════════════════════════════════════════════ */

let server = null;

function banner() {
  const dbOn = supabaseDisponible();
  const gCount = geminiPool.length;

  console.log('');
  console.log('  ╭───────────────────────────────────────────────────╮');
  console.log(`  │  🇨🇴  NUMINATION · v${VERSION.padEnd(24)} │`);
  console.log('  │  Numi-OT.01 · "Numi es la clave"                  │');
  console.log('  ╰───────────────────────────────────────────────────╯');
  console.log('');
  console.log(`  🚀  http://localhost:${PORT}`);
  console.log('');
  console.log('  📋  PRIORIDAD DE MOTORES');
  console.log('      Texto    → Groq → Gemini → Kimi');
  console.log('      Archivos → Gemini → Kimi → Groq');
  console.log('');
  console.log('  🤖  MODELOS');
  console.log(`      Groq   → ${MODELS.GROQ}`);
  console.log(`      Gemini → ${MODELS.GEMINI}`);
  console.log(`      Kimi   → ${MODELS.KIMI}`);
  console.log('');
  console.log(`  🔑  Groq:         ${groq ? '✓' : '✗'}`);
  console.log(`  🔑  Gemini keys:  ${gCount}/3 ${gCount > 0 ? '✓' : '✗'}`);
  console.log(`  🔑  Kimi:         ${nvidia ? '✓' : '✗'}`);
  console.log('');
  console.log(`  🎨  Imágenes:     Pollinations`);
  console.log(`  🔍  Web Search:   activo`);
  console.log(`  🧠  Modos:        chat · coder · reasoning`);
  console.log(`  💾  Memorias:     ${dbOn ? 'activas' : 'sin DB'}`);
  console.log(`  🔌  Conectores:   13 APIs`);
  console.log(`  📧  Email:        configurable`);
  console.log(`  🔐  Auth:         Google + GitHub`);
  console.log('');
  console.log('  🛠️   INFRAESTRUCTURA');
  console.log('      · errors        · manejo centralizado');
  console.log('      · rate-limit    · por usuario/endpoint/plan');
  console.log('      · prompts       · versionado + A/B');
  console.log('      · analytics     · DAU/WAU/retention');
  console.log('      · notifications · multicanal');
  console.log('      · webhooks      · outbound firmados');
  console.log('      · search        · full-text');
  console.log('      · migrations    · versionado de schema');
  console.log('      · backup        · snapshots + restore');
  console.log('      · websearch     · Wikipedia + DDG + Brave');
  console.log('      · logger        · centralizado');
  console.log('      · sse           · Server-Sent Events');
  console.log('');
  console.log('  🎛️   ADMIN PANEL');
  console.log(`      /admin.html`);
  console.log('');
  console.log('  💡 Ctrl+C para detener');
  console.log('');
}

if (!IS_VERCEL) {
  server = app.listen(PORT, () => banner());
  server.keepAliveTimeout = CFG.keepAliveTimeout;
  server.headersTimeout = CFG.headersTimeout;
}

function shutdown(signal) {
  LOG.warn(`Recibido ${signal}. Cerrando...`);

  Promise.all([
    flushAnalytics().catch(() => {}),
    flushNotifications().catch(() => {}),
    flushWebhooks().catch(() => {}),
  ]).finally(() => {
    if (!server) return process.exit(0);
    server.close(() => {
      LOG.info('Servidor cerrado limpiamente');
      process.exit(0);
    });
  });

  setTimeout(() => {
    LOG.error('Forzando salida por timeout');
    process.exit(1);
  }, CFG.shutdownTimeout).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

installProcessHandlers();

export default app;