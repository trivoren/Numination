/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · index.js · v10.0
   ─────────────────────────────────────────────────────────────────────────
   Orquestador completo: Web Search + Images + Tools + Memory + Attachments.

   NUEVO EN v10.0:
     · Agent mode con function calling (TOOLS.runLoop)
     · Memoria semántica (MEMORY.buildContext con embeddings)
     · Attachments multi-file (PDF, DOCX, imágenes, código)
     · Voice endpoints (ElevenLabs / OpenAI TTS proxy)
     · Auth middleware con cache + circuit breaker
     · Logger estructurado con reqId automático
     · SSE con heartbeat + backpressure
     · Admin: memory/tools/attachments stats
     · Health check con 12 subsistemas
     · Rate limiting por usuario + endpoint + plan
     · Graceful shutdown con flush de colas

   ARQUITECTURA:
     ┌─ Middleware: logger → auth → rate-limit → analytics ─┐
     │                                                       │
     ├─ ROUTERS (existing) ─────────────────────────────────┤
     │   auth · chats · memories · skills · connectors      │
     │   email · notifications · search · webhooks          │
     │                                                       │
     ├─ NEW ENDPOINTS ──────────────────────────────────────┤
     │   /api/chat/stream    · agent + memory + web          │
     │   /api/chat           · sin streaming                 │
     │   /api/attachments    · upload/list/delete            │
     │   /api/voice/tts      · proxy a ElevenLabs/OpenAI     │
     │   /api/voice/stt      · proxy a Whisper               │
     │   /api/memory/*       · stats/consolidate/migrate     │
     │   /api/tools/*        · list/test/metrics             │
     │   /api/admin/*        · analytics/migrations/backup   │
     │                                                       │
     ├─ HEALTH ─────────────────────────────────────────────┤
     │   /api/health         · 12 subsistemas                │
     │   /api/version        · metadatos                     │
     │   /api/ping           · liveness                      │
     └───────────────────────────────────────────────────────┘

   MOTORES DE IA:
     Texto     → Groq → Gemini → Kimi
     Archivos  → Gemini → Kimi → Groq
     Tools     → Groq (OpenAI format) → Gemini (native) → Kimi
     Voz       → ElevenLabs → OpenAI TTS → Browser
     Imágenes  → Pollinations
     Embeddings→ OpenAI → Gemini → Voyage → Local hash

   SEGURIDAD:
     · Prompt injection detection (7 patrones)
     · IP rate limit (500/min)
     · User rate limit (por plan)
     · Auth cache con invalidación
     · Circuit breaker para Supabase
     · SSRF protection en url_fetch tool
     · Calculator sin eval (parser propio)
     · HMAC-SHA256 para webhooks
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
   INFRAESTRUCTURA · logger + sse + auth
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  LOG,
  withReqId,
  expressMiddleware as loggerMiddleware,
  getStats as getLoggerStats,
  getMemoryLogs,
} from './lib/logger.js';

import {
  SSE,
  initSSE,
  sseSend,
  sseClose,
  sseError,
  sseHeartbeat,
  closeAllConnections,
  getStats as getSSEStats,
} from './lib/sse.js';

import {
  AUTH,
  attachUser,
  optionalAuth,
  requireAuth,
  requireAdmin,
  requireRole,
  requirePlan,
  requireScope,
  requireVerifiedEmail,
  requireNotBanned,
  requireApiKey,
  verifyWebhookSignature,
  protect,
  currentUser,
  currentContext,
  invalidateSession,
  invalidateProfile,
  issueApiKey,
  getAuthMetrics,
} from './middleware/auth.js';

/* ═══════════════════════════════════════════════════════════════════════════
   AGENTE + MEMORIA + TOOLS
   ═══════════════════════════════════════════════════════════════════════════ */

import { TOOLS } from './services/tools.js';
import { MEMORY } from './services/long-term-memory.js';

/* ═══════════════════════════════════════════════════════════════════════════
   SERVICIOS IA
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
   WEB SEARCH + IMAGES
   ═══════════════════════════════════════════════════════════════════════════ */

import { searchWeb, formatResultsForAI } from './services/websearch.js';
import {
  buildImageUrl,
  isImageRequest,
  extractImagePrompt,
  enrichPrompt as enrichImagePrompt,
} from './services/images.js';

/* ═══════════════════════════════════════════════════════════════════════════
   INFRAESTRUCTURA
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
   MIDDLEWARE VIEJO (complementa al nuevo)
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

import { mountAuthRoutes } from './auth.js';
import { mountChatRoutes } from './chats.js';
import { mountMemoryRoutes } from './memories.js';
import { mountSkillsRoutes } from './skills.js';
import { mountConnectorRoutes } from './connectors.js';
import { mountEmailRoutes } from './email.js';

/* ═══ NUMINATION LIBS · v1.0 · auto-inyectado ═══ */
import { ipGuard, rateLimit as ipRateLimit, blockCountries } from './middleware/ip-guard.js';
import { middleware as validateBody, SCHEMAS } from './lib/validators.js';
import { cache, cacheMiddleware } from './lib/cache.js';
import { createQueue, queueManager } from './lib/queue.js';
import { http } from './lib/http.js';
/* ═══ /NUMINATION LIBS ═══ */


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const VERSION = '10.0.0';
const CODENAME = 'Numi-OT.01';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const IS_PROD = process.env.NODE_ENV === 'production';
const IS_VERCEL = process.env.VERCEL === '1';
const PORT = parseInt(process.env.PORT || '8080', 10);

const CFG = Object.freeze({
  // Requests
  maxMsgLen: 8000,
  jsonLimit: '20mb',           // ↑ para attachments
  urlencodedLimit: '2mb',

  // AI
  aiFirstTokenTimeoutMs: 25_000,
  aiFullResponseTimeoutMs: 120_000,
  geminiCooldownMs: 60_000,
  geminiSoftCooldownMs: 15_000,
  retryBaseDelayMs: 900,

  // SSE
  sseHeartbeatMs: 8_000,
  sseMaxDurationMs: 300_000,

  // Cache
  responseCacheTtlMs: 15 * 60_000,
  responseCacheMax: 500,
  memoryCacheTtlMs: 30_000,

  // Rate limiting
  rateLimitIPWindow: 60_000,
  rateLimitIPMax: 500,
  authFailThreshold: 5,
  authFailWindowMs: 60_000,
  authFailBlockMs: 300_000,

  // HTTP
  keepAliveTimeout: 65_000,
  headersTimeout: 66_000,
  shutdownTimeout: 10_000,

  // Web search
  webSearchTimeoutMs: 8_000,
  webSearchMaxResults: 5,

  // Agent / Tools
  toolsEnabled: process.env.TOOLS_ENABLED !== 'false',
  toolsMaxTurns: 4,
  toolsMaxCallsPerTurn: 8,

  // Memory
  memoryEnabled: process.env.MEMORY_ENABLED !== 'false',
  memoryMaxTokens: 800,
  memoryMaxItems: 8,

  // Attachments
  attachmentsMaxSize: 25 * 1024 * 1024, // 25 MB
  attachmentsMaxCount: 8,
  attachmentsMaxTextChars: 100_000,

  // Voice
  voiceServerTTS: process.env.SERVER_TTS === 'true',
  voiceElevenLabsKey: process.env.ELEVENLABS_API_KEY || null,
  voiceOpenAIKey: process.env.OPENAI_API_KEY || null,

  // Environment
  env: process.env.NODE_ENV || 'development',
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · KEYS + MODELOS
   ═══════════════════════════════════════════════════════════════════════════ */

let TEST_KEYS = {};
try {
  const mod = await import('../env.local.js');
  TEST_KEYS = mod.TEST_KEYS ?? {};
} catch { /* opcional */ }

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

const NAMES = { groq: 'Groq', gemini: 'Gemini', nvidia: 'Kimi K3' };

/* ═══════════════════════════════════════════════════════════════════════════
   03 · GEMINI POOL · 3 keys con cooldown
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
   04 · CLIENTES IA
   ═══════════════════════════════════════════════════════════════════════════ */

const groq = KEYS.GROQ ? new Groq({ apiKey: KEYS.GROQ }) : null;
const nvidia = KEYS.NV
  ? new OpenAI({
      apiKey: KEYS.NV,
      baseURL: 'https://integrate.api.nvidia.com/v1',
    })
  : null;

/* ═══════════════════════════════════════════════════════════════════════════
   05 · UTILIDADES
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
  return (msg.includes('aborted') || msg.includes('abort')) && !msg.includes('timeout');
}

function sseDisconnected(sse, res) {
  return (sse.isClosed && sse.isClosed()) || res.destroyed || res.writableEnded;
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
  /\[SYS\]/i,
  /###\s*SYSTEM\s*:/i,
];

function isInjection(message) {
  if (!message) return false;
  const t = String(message);
  return INJECTION_PATTERNS.some((p) => p.test(t));
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · IP RATE LIMITER (capa 1)
   ═══════════════════════════════════════════════════════════════════════════ */

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
   07 · RESPONSE CACHE
   ═══════════════════════════════════════════════════════════════════════════ */

const responseCache = new Map();

function cacheKey(message, role, userId) {
  return `${userId || 'anon'}:${role}:${crypto.createHash('sha256').update(String(message)).digest('hex').slice(0, 16)}`;
}

function getCachedResponse(message, role, userId) {
  const k = cacheKey(message, role, userId);
  const entry = responseCache.get(k);
  if (!entry) return null;
  if (Date.now() - entry.t > CFG.responseCacheTtlMs) {
    responseCache.delete(k);
    return null;
  }
  return entry.v;
}

function setCachedResponse(message, role, userId, response) {
  if (responseCache.size >= CFG.responseCacheMax) {
    const oldestKey = responseCache.keys().next().value;
    responseCache.delete(oldestKey);
  }
  const k = cacheKey(message, role, userId);
  responseCache.set(k, { v: response, t: Date.now() });
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · IMAGE HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function buildImageUrlSafe(prompt, opts = {}) {
  try {
    return buildImageUrl(prompt, opts);
  } catch (e) {
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
  try { return isImageRequest(msg); }
  catch (e) {
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
  try { return extractImagePrompt(msg); }
  catch (e) {
    return String(msg)
      .replace(/^(genera(me)?|crea(me)?|haz(me)?)\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i, '')
      .replace(/^dibuja(me)?\s+/i, '')
      .replace(/^ilustra(me)?\s+/i, '')
      .replace(/^quiero\s+ver\s+(una\s+)?imagen\s+(de|sobre|con)\s+/i, '')
      .trim();
  }
}

function enrichImagePromptSafe(prompt) {
  try { return enrichImagePrompt(prompt); }
  catch (e) {
    if (/colombia|colombiano|colombiana|café|cumbia|vallenato|magdalena|cóndor|arepa|barranquilla|medellín|bogotá/i.test(prompt)) {
      return prompt + ', Colombia, vibrant colors, golden hour lighting, highly detailed, cinematic';
    }
    return prompt + ', warm colors, artistic style, high quality, detailed';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   09 · MEMORIAS · ahora vía MEMORY service con cache local
   ═══════════════════════════════════════════════════════════════════════════ */

const memCache = new Map();

async function loadMemoriesLegacy(req) {
  if (!req.user?.id) return [];
  const key = req.user.id;
  const cached = memCache.get(key);
  if (cached && Date.now() - cached.t < CFG.memoryCacheTtlMs) {
    return cached.v;
  }
  try {
    const list = await listarMemories(req.user.id);
    if (memCache.size >= 500) {
      const oldestKey = memCache.keys().next().value;
      memCache.delete(oldestKey);
    }
    memCache.set(key, { v: list, t: Date.now() });
    return list;
  } catch (e) {
    LOG.warn('memorias legacy:', { error: e.message });
    return [];
  }
}

/**
 * Carga el contexto semántico de memorias para el prompt.
 * Usa MEMORY.buildContext() si está disponible, sino fallback a legacy.
 */
async function loadMemoryContext(userId, query) {
  if (!CFG.memoryEnabled || !userId || !query) return '';

  try {
    return await MEMORY.buildContext(userId, query, {
      maxTokens: CFG.memoryMaxTokens,
      maxMemories: CFG.memoryMaxItems,
    });
  } catch (e) {
    LOG.warn('memory context failed:', { error: e.message, userId });
    return '';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · WEB SEARCH
   ═══════════════════════════════════════════════════════════════════════════ */

async function runWebSearch(query, reqId) {
  try {
    LOG.debug('webSearch', { reqId, query: short(query, 60) });

    const results = await searchWeb(query, {
      maxResults: CFG.webSearchMaxResults,
      language: 'es',
      timeout: CFG.webSearchTimeoutMs,
    });

    if (!results || results.length === 0) {
      LOG.debug('webSearch · 0 resultados', { reqId });
      return { sources: [], context: '' };
    }

    const sources = results.map((r, i) => {
      let domain = '';
      try { domain = new URL(r.url).hostname.replace(/^www\./, ''); }
      catch { domain = r.source || ''; }

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
    LOG.info(`webSearch · ${sources.length} fuentes`, { reqId });
    return { sources, context };
  } catch (e) {
    LOG.warn('webSearch falló', { reqId, error: e.message });
    return { sources: [], context: '' };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   11 · PERSISTENCIA
   ═══════════════════════════════════════════════════════════════════════════ */

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
    LOG.warn('persist: error creando cliente', { error: e.message });
    return null;
  }
}

async function persistAssistantMessage(req, { chatId, content, sources, toolsUsed = 0 }) {
  if (!chatId || !content) return;
  if (!req.user?.id) return;

  try {
    const supabase = await getSbClient();
    if (!supabase) return;

    const payload = {
      id: crypto.randomUUID(),
      chatId,
      role: 'assistant',
      content: String(content).slice(0, 100_000),
      sources: sources && sources.length > 0 ? sources : null,
      createdAt: new Date().toISOString(),
    };

    const { error } = await supabase.from('Message').insert(payload);
    if (error) {
      LOG.warn('persist error', { reqId: req.id, error: error.message });
      return;
    }

    LOG.debug('message persistido', {
      reqId: req.id,
      chatId,
      sources: sources?.length || 0,
      toolsUsed,
    });
  } catch (e) {
    LOG.warn('persist exception', { reqId: req.id, error: e.message });
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   12 · STREAMING HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

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

    gen.next()
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
    onToken: () => { stats.tokens++; },
    onDone: (s) => {
      stats.tokens = s.tokens;
      stats.chars = s.chars;
      stats.elapsedMs = s.elapsedMs;
      stats.tps = s.tps;
      LOG.debug(`${providerName} OK`, { reqId, tokens: s.tokens, tps: s.tps });
    },
    onError: (info) => {
      LOG.debug(`${providerName} retry ${info.attempt + 1}`, { reqId, kind: info.kind });
    },
  };
}

function orderMotors(file) {
  return file?.data ? ['gemini', 'nvidia', 'groq'] : ['groq', 'gemini', 'nvidia'];
}

/* ═══════════════════════════════════════════════════════════════════════════
   13 · AGENT STREAMING · Tools + LLM
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Streaming de Groq con soporte de tool_calls.
 * Emite tokens vía SSE y acumula tool_calls.
 */
async function streamGroqWithTools(messages, tools, sse, opts = {}) {
  if (!groq) throw new Error('Groq no configurado');

  const { maxTokens = 4096, temperature = 0.7, signal } = opts;

  const stream = await groq.chat.completions.create({
    model: MODELS.GROQ,
    messages,
    tools: tools && tools.length > 0 ? tools : undefined,
    tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
    stream: true,
    temperature,
    max_tokens: maxTokens,
  }, { signal });

  let fullText = '';
  const toolCallsMap = new Map();
  let finishReason = null;

  for await (const chunk of stream) {
    if (sseDisconnected(sse, null)) break;

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      fullText += delta.content;
      sse.send({ token: delta.content, done: false });
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!toolCallsMap.has(idx)) {
          toolCallsMap.set(idx, { id: '', name: '', arguments: '' });
        }
        const entry = toolCallsMap.get(idx);
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.arguments += tc.function.arguments;
      }
    }

    finishReason = chunk.choices?.[0]?.finish_reason || finishReason;
  }

  const calls = Array.from(toolCallsMap.values()).map((tc) => {
    let args = {};
    try { args = JSON.parse(tc.arguments || '{}'); }
    catch (e) { LOG.warn('tool args parse failed', { raw: tc.arguments }); }
    return { id: tc.id, name: tc.name, args, raw: tc };
  });

  return { text: fullText, calls, finishReason };
}

/* ═══════════════════════════════════════════════════════════════════════════
   14 · EXPRESS APP + MIDDLEWARE CHAIN
   ═══════════════════════════════════════════════════════════════════════════ */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

/* ─── 1 · Request ID + Logger ─── */
app.use(requestIdMiddleware());

/* ─── 2 · Security headers ─── */
// M-003 · CSP: 'unsafe-inline' en script/style es TEMPORAL (chat.html y
// login.html usan <script>/<style> inline). TODO: externalizar el JS/CSS
// inline y endurecer a script-src 'self' + nonces.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://accounts.google.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "connect-src 'self' https://*.supabase.co https://api.groq.com https://generativelanguage.googleapis.com",
  "frame-src https://accounts.google.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader('Content-Security-Policy', CSP);
  if (IS_PROD) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

/* ─── 3 · CORS ─── */
const ALLOWED_ORIGINS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:3000',
  'https://numination.app',
  'https://www.numination.app',
  'https://numinationchat.vercel.app',
];

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id, X-Cron-Secret, X-API-Key, X-NM-Token, X-Impersonate-Id');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

/* ─── 4 · IP rate limit ─── */
app.use((req, res, next) => {
  if (/^\/assets\//.test(req.path) || /\.(js|css|png|jpg|svg|woff2?|ico)$/i.test(req.path)) {
    return next();
  }
  const { allowed, reset } = checkIP(req.ip);
  if (!allowed) {
    res.setHeader('Retry-After', String(Math.ceil((reset - Date.now()) / 1000)));
    return res.status(429).json({
      ok: false,
      error: 'Demasiadas peticiones. Esperá un minuto.',
      code: 'limit_ip',
    });
  }
  next();
});

/* ─── 5 · Body + cookies ─── */
app.use(express.json({ limit: CFG.jsonLimit }));
app.use(express.urlencoded({ extended: false, limit: CFG.urlencodedLimit }));
app.use(cookieParser());

/* IP Guard · rate limiting global (opt-out con IP_GUARD=false) */
if (process.env.IP_GUARD !== 'false') {
  app.use(ipGuard({
    rateLimit: true,
    countries: process.env.IP_COUNTRY_BLOCK === 'true',
    tor: process.env.IP_BLOCK_TOR === 'true',
    vpn: process.env.IP_BLOCK_VPN === 'true',
    ban: true,
  }));
}


/* ─── 6 · AUTH (middleware nuevo con cache + circuit breaker) ─── */
app.use(attachUser);

/* ─── 7 · Notifications middleware ─── */
app.use(notificationsMiddleware());

/* ─── 8 · Analytics middleware ─── */
app.use(analyticsMiddleware({ sampleHttp: 1, ignore4xx: false }));

/* ─── 9 · Rate limit por usuario ─── */
app.use(rateLimitUser({
  skipPaths: ['/api/health', '/api/version', '/api/ping'],
}));

/* ─── 10 · Proteger /chat + /chat.html y /coder + /coder.html ─── */
app.use((req, res, next) => {
  if ((req.path === '/chat' || req.path === '/chat.html' || req.path === '/coder' || req.path === '/coder.html') && !req.user) return res.redirect('/login');

  // Admin: sin sesion -> login | sesion no-admin -> chat
  if (req.path === '/admin' || req.path === '/admin.html') {
    if (!req.user) return res.redirect('/login');
    if (req.user.role !== 'admin') return res.redirect('/chat');
  }

  next();
});

/* ─── 11 · Static files ─── */
app.use(express.static(publicDir, {
  index: false,
    extensions: ['html'],
  maxAge: IS_PROD ? '1h' : 0,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

/* ─── 12 · Root redirect ─── */
app.get('/', (req, res) => res.redirect('/login'));

/* ═══════════════════════════════════════════════════════════════════════════
   15 · ROUTERS EXISTENTES
   ═══════════════════════════════════════════════════════════════════════════ */





/* ═══════════════════════════════════════════════════════════════════════
   FIX-NUM-2026 · INTERCEPTOR v6 ELIMINADO
   - Aceptaba JWT decodificados SIN verificar la firma.
   - Sin token, buscaba el PRIMER perfil de la DB y dejaba pasar la request
     como ese usuario (account takeover).
   - Generaba UUIDs sintéticos / admin hardcodeado.
   La sesión ahora la resuelve attachUser (middleware/auth.js) verificando
   la firma real. Sin sesión válida → req.user = null (nunca un usuario falso).
   ═══════════════════════════════════════════════════════════════════════ */

mountAuthRoutes(app);
mountChatRoutes(app, requireAuth);
mountMemoryRoutes(app, requireAuth);
mountSkillsRoutes(app, requireAuth);
mountConnectorRoutes(app, requireAuth);
mountEmailRoutes(app, requireAuth);

/* ═══════════════════════════════════════════════════════════════════════════
   16 · HEALTH · VERSION · PING
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

  let memoryStats = null;
  try {
    if (req.user?.id) memoryStats = await MEMORY.getStats(req.user.id);
  } catch (e) {}

  return res.json({
    ok: true,
    service: 'numination',
    version: VERSION,
    codename: CODENAME,
    env: CFG.env,
    uptime: Math.floor(process.uptime()),
    priority: {
      text: ['groq', 'gemini', 'nvidia'],
      files: ['gemini', 'nvidia', 'groq'],
      agent: ['groq', 'gemini'],
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
      tools: CFG.toolsEnabled,
      memory: CFG.memoryEnabled,
      attachments: true,
      voice: {
        server: CFG.voiceServerTTS,
        elevenlabs: Boolean(CFG.voiceElevenLabsKey),
        openai: Boolean(CFG.voiceOpenAIKey),
      },
      cache: {
        responses: responseCache.size,
        memories: memCache.size,
        logger: getLoggerStats(),
      },
    },
    subsystems: {
      database: { connected: supabaseDisponible(), ping: dbPing },
      limits: limitsPing,
      analytics: analyticsPing,
      notifications: notifPing,
      webhooks: webhookPing,
      search: searchPing,
      backup: backupPing,
      tools: { enabled: CFG.toolsEnabled, count: TOOLS.size() },
      memory: memoryStats || { enabled: CFG.memoryEnabled },
      auth: getAuthMetrics(),
      sse: getSSEStats(),
    },
    user: req.user ? {
      authenticated: true,
      email: req.user.email,
      role: req.user.role,
      plan: req.user.plan,
    } : { authenticated: false },
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
    codename: CODENAME,
    env: CFG.env,
    models: MODELS,
  });
});

app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, pong: Date.now() });
});

/* ═══════════════════════════════════════════════════════════════════════════
   17 · LÍMITES
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/limits/usage', requireAuth, async (req, res) => {
  try {
    const stats = await getUsageStats(req);
    buildRateLimitHeaders(res, stats);
    return res.json({ ok: true, ...stats });
  } catch (e) {
    LOG.error('limits/usage', { reqId: req.id, error: e.message });
    return res.status(500).json({ ok: false, error: 'Error consultando uso' });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   18 · NOTIFICATIONS
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit || '50', 10));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const inbox = await getInbox(req.user.id, { limit, offset });
    return res.json({ ok: true, ...inbox });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Error cargando notificaciones' });
  }
});

app.get('/api/notifications/unread', requireAuth, async (req, res) => {
  try {
    const count = await getUnreadCount(req.user.id);
    return res.json({ ok: true, unread: count });
  } catch { return res.json({ ok: true, unread: 0 }); }
});

app.post('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await markAllRead(req.user.id);
    return res.json({ ok: true });
  } catch { return res.status(500).json({ ok: false, error: 'Error' }); }
});

app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const ok = await markRead(req.user.id, req.params.id);
    return res.json({ ok });
  } catch { return res.status(500).json({ ok: false, error: 'Error' }); }
});

app.delete('/api/notifications', requireAuth, async (req, res) => {
  try {
    await clearInbox(req.user.id);
    return res.json({ ok: true });
  } catch { return res.status(500).json({ ok: false, error: 'Error' }); }
});

app.get('/api/notifications/preferences', requireAuth, async (req, res) => {
  try {
    const prefs = await getPreferences(req.user.id);
    return res.json({ ok: true, preferences: prefs });
  } catch { return res.status(500).json({ ok: false, error: 'Error' }); }
});

app.patch('/api/notifications/preferences', requireAuth, async (req, res) => {
  try {
    const result = await updatePreferences(req.user.id, req.body || {});
    return res.json({ ok: true, preferences: result.prefs });
  } catch { return res.status(500).json({ ok: false, error: 'Error' }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   19 · SEARCH
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, items: [], total: 0 });
    const types = req.query.types ? String(req.query.types).split(',').map((s) => s.trim()) : undefined;
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    const result = await search(q, req.user.id, { types, limit });
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Error buscando' });
  }
});

app.get('/api/search/suggest', requireAuth, async (req, res) => {
  try {
    const prefix = String(req.query.q || '').trim();
    const limit = Math.min(parseInt(req.query.limit || '8', 10), 20);
    return res.json(await suggest(prefix, req.user.id, { limit }));
  } catch { return res.status(500).json({ ok: false, suggestions: [] }); }
});

app.get('/api/search/recent', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 30);
    const recent = await getRecentSearches(req.user.id, { limit });
    return res.json({ ok: true, recent });
  } catch { return res.json({ ok: true, recent: [] }); }
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
  } catch { return res.json({ ok: true, trending: [] }); }
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
   20 · WEBHOOKS
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
  if (sub.userId !== req.user.id) return res.status(403).json({ ok: false, error: 'forbidden' });
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
  return res.json(await testSubscription(req.params.id, req.user.id));
});

app.get('/api/webhooks/:id/deliveries', requireAuth, async (req, res) => {
  const sub = await getSubscription(req.params.id);
  if (!sub || sub.userId !== req.user.id) return res.status(403).json({ ok: false });
  const deliveries = await getDeliveryLog(req.params.id, {
    limit: Math.min(100, parseInt(req.query.limit || '50', 10)),
  });
  return res.json({ ok: true, deliveries });
});

app.get('/api/webhooks/:id/dlq', requireAuth, async (req, res) => {
  const sub = await getSubscription(req.params.id);
  if (!sub || sub.userId !== req.user.id) return res.status(403).json({ ok: false });
  const dlq = await getDlq(req.params.id, {
    limit: Math.min(100, parseInt(req.query.limit || '50', 10)),
  });
  return res.json({ ok: true, dlq });
});

app.post('/api/webhooks/:id/dlq/retry', requireAuth, async (req, res) => {
  const sub = await getSubscription(req.params.id);
  if (!sub || sub.userId !== req.user.id) return res.status(403).json({ ok: false });
  return res.json(await retryFromDlq(req.params.id, req.body?.deliveryId));
});

app.delete('/api/webhooks/:id/dlq', requireAuth, async (req, res) => {
  const sub = await getSubscription(req.params.id);
  if (!sub || sub.userId !== req.user.id) return res.status(403).json({ ok: false });
  return res.json({ ok: await clearDlq(req.params.id) });
});

/* ═══════════════════════════════════════════════════════════════════════════
   21 · MEMORY · endpoints de usuario
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/memory/stats', requireAuth, async (req, res) => {
  try {
    const stats = await MEMORY.getStats(req.user.id);
    return res.json({ ok: true, stats });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/memory/list', requireAuth, async (req, res) => {
  try {
    const category = req.query.category || undefined;
    const limit = Math.min(200, parseInt(req.query.limit || '100', 10));
    const list = await MEMORY.list(req.user.id, { category, limit });
    return res.json({ ok: true, memories: list, count: list.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/memory/search', requireAuth, async (req, res) => {
  try {
    const { query, limit = 10 } = req.body || {};
    if (!query) return res.status(400).json({ ok: false, error: 'query requerido' });
    const results = await MEMORY.search(req.user.id, query, { limit });
    return res.json({ ok: true, results, count: results.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/memory/store', requireAuth, async (req, res) => {
  try {
    const { text, category, importance } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: 'text requerido' });
    const memory = await MEMORY.store(req.user.id, text, { category, importance });
    return res.status(201).json({ ok: true, memory });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/memory/:id', requireAuth, async (req, res) => {
  try {
    await MEMORY.remove(req.user.id, req.params.id);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/memory', requireAuth, async (req, res) => {
  try {
    const count = await MEMORY.clear(req.user.id);
    return res.json({ ok: true, cleared: count });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/memory/consolidate', requireAuth, async (req, res) => {
  try {
    const result = await MEMORY.consolidate(req.user.id);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/memory/migrate', requireAuth, async (req, res) => {
  try {
    const result = await MEMORY.migrate(req.user.id);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/memory/contradictions', requireAuth, async (req, res) => {
  try {
    const contradictions = await MEMORY.detectContradictions(req.user.id);
    return res.json({ ok: true, contradictions, count: contradictions.length });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/memory/decay', requireAuth, async (req, res) => {
  try {
    const result = await MEMORY.applyDecay(req.user.id);
    return res.json({ ok: true, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   22 · TOOLS · endpoints de usuario + admin
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/tools', requireAuth, async (req, res) => {
  try {
    const tools = TOOLS.list({ noBeta: true });
    return res.json({
      ok: true,
      count: tools.length,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        category: t.category,
        cache: t.cache.enabled,
      })),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/tools/execute', requireAuth, async (req, res) => {
  try {
    const { name, args } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name requerido' });

    const result = await TOOLS.execute(name, args || {}, {
      userId: req.user.id,
      reqId: req.id,
    });

    return res.json({ ok: result.ok, ...result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/tools/metrics', requireAuth, requireAdmin, async (_req, res) => {
  return res.json({ ok: true, metrics: TOOLS.metrics() });
});

app.post('/api/admin/tools/test', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const report = await TOOLS.test();
    return res.json({ ok: report.ok, ...report });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   23 · API KEYS · endpoints de usuario
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/keys', requireAuth, async (req, res) => {
  try {
    const { name = 'Default' } = req.body || {};
    const { key, hash, preview } = issueApiKey();
    const supabase = await getSbClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB no disponible' });

    const { error } = await supabase.from('api_keys').insert({
      id: crypto.randomUUID(),
      user_id: req.user.id,
      name: String(name).slice(0, 100),
      key_hash: hash,
      preview,
      scopes: [],
      created_at: new Date().toISOString(),
    });

    if (error) return res.status(500).json({ ok: false, error: error.message });

    // El `key` SOLO se muestra una vez
    return res.status(201).json({
      ok: true,
      key,
      preview,
      message: 'Guardá esta key. No se muestra de nuevo.',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/keys', requireAuth, async (req, res) => {
  try {
    const supabase = await getSbClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB no disponible' });

    const { data, error } = await supabase
      .from('api_keys')
      .select('id, name, preview, scopes, created_at, last_used_at, revoked_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, keys: data || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.delete('/api/keys/:id', requireAuth, async (req, res) => {
  try {
    const supabase = await getSbClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB no disponible' });

    const { error } = await supabase
      .from('api_keys')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('user_id', req.user.id);

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   24 · ATTACHMENTS · endpoints de usuario
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * El frontend envía los attachments embebidos en el body del chat.
 * Estos endpoints son para subirlos a Supabase Storage si se quiere
 * persistirlos entre sesiones.
 */
app.post('/api/attachments/upload', requireAuth, async (req, res) => {
  try {
    const { name, mime, data, size } = req.body || {};
    if (!name || !data) {
      return res.status(400).json({ ok: false, error: 'name y data requeridos' });
    }
    if (size && size > CFG.attachmentsMaxSize) {
      return res.status(413).json({
        ok: false,
        error: `Archivo muy grande (máx ${CFG.attachmentsMaxSize / 1024 / 1024} MB)`,
      });
    }

    const supabase = await getSbClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'Storage no disponible' });

    const buffer = Buffer.from(data, 'base64');
    const ext = name.includes('.') ? name.split('.').pop() : 'bin';
    const path_ = `${req.user.id}/${crypto.randomUUID()}.${ext}`;

    const { error } = await supabase.storage
      .from('attachments')
      .upload(path_, buffer, { contentType: mime || 'application/octet-stream', upsert: false });

    if (error) return res.status(500).json({ ok: false, error: error.message });

    const { data: urlData } = supabase.storage.from('attachments').getPublicUrl(path_);

    return res.json({
      ok: true,
      attachment: {
        id: path_,
        name,
        mime,
        size: buffer.length,
        url: urlData.publicUrl,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/attachments/list', requireAuth, async (req, res) => {
  try {
    const supabase = await getSbClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'Storage no disponible' });

    const { data, error } = await supabase.storage
      .from('attachments')
      .list(req.user.id, { limit: 100 });

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, files: data || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   25 · VOICE · endpoints proxy (opcional)
   ═══════════════════════════════════════════════════════════════════════════ */

app.post('/api/voice/tts', requireAuth, async (req, res) => {
  try {
    const { text, voice = 'default', locale = 'es-CO' } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: 'text requerido' });

    // ElevenLabs primero
    if (CFG.voiceElevenLabsKey) {
      try {
        const voiceId = voice !== 'default' ? voice : 'pNInz6obpgDQGcFmaJgB';
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST',
          headers: {
            'xi-api-key': CFG.voiceElevenLabsKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            text: String(text).slice(0, 5000),
            model_id: 'eleven_multilingual_v2',
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
        });

        if (r.ok) {
          const buffer = Buffer.from(await r.arrayBuffer());
          res.setHeader('Content-Type', 'audio/mpeg');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          return res.send(buffer);
        }
      } catch (e) {
        LOG.warn('ElevenLabs falló', { error: e.message });
      }
    }

    // OpenAI TTS
    if (CFG.voiceOpenAIKey) {
      try {
        const openai = new OpenAI({ apiKey: CFG.voiceOpenAIKey });
        const mp3 = await openai.audio.speech.create({
          model: 'tts-1',
          voice: voice === 'default' ? 'alloy' : voice,
          input: String(text).slice(0, 4000),
        });
        const buffer = Buffer.from(await mp3.arrayBuffer());
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(buffer);
      } catch (e) {
        LOG.warn('OpenAI TTS falló', { error: e.message });
      }
    }

    // Sin providers → 501
    return res.status(501).json({
      ok: false,
      error: 'Server TTS no configurado. Usá el browser TTS del cliente.',
      hint: 'Configurá ELEVENLABS_API_KEY o OPENAI_API_KEY',
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/voice/stt', requireAuth, async (req, res) => {
  try {
    const { audio, mime = 'audio/webm' } = req.body || {};
    if (!audio) return res.status(400).json({ ok: false, error: 'audio requerido' });

    if (!CFG.voiceOpenAIKey) {
      return res.status(501).json({
        ok: false,
        error: 'Server STT no configurado. Usá Web Speech API del cliente.',
        hint: 'Configurá OPENAI_API_KEY para Whisper',
      });
    }

    const openai = new OpenAI({ apiKey: CFG.voiceOpenAIKey });
    const buffer = Buffer.from(audio, 'base64');
    const file = new File([buffer], 'audio.webm', { type: mime });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'es',
    });

    return res.json({ ok: true, text: transcription.text });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   26 · CHAT STREAMING · EL ENDPOINT ESTRELLA
   ═══════════════════════════════════════════════════════════════════════════
   Este endpoint ahora soporta:
     · Texto, archivos, imágenes
     · Web search + sources
     · Agent mode (tools/function calling)
     · Memoria semántica
     · Attachments múltiples
     · Cache de respuestas
     · Fallback entre providers
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
      files = [],              // ← NUEVO: multi-file
      incognito = false,
      history = [],
      webSearch = false,
      chatId = null,
      useTools,                // undefined → default (CFG.toolsEnabled)
      reasoning = false,
    } = req.body ?? {};

    const hasText = message && String(message).trim();
    const hasFile = !!(file?.data || (files && files.length > 0));

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
      LOG.warn('Injection bloqueado', { reqId: req.id });
      return res.status(403).json({
        ok: false,
        error: 'No puedo procesar esa instrucción. Reformulala como una pregunta educativa.',
        code: 'chat_injection_blocked',
      });
    }

    const isReasoning = reasoning === true || role === 'reasoning';
    const effectiveRole = isReasoning ? 'reasoning' : role;
    const finalMessage = buildFinalMessage(message, isReasoning);

    /* ─── Memorias · ahora semánticas ─── */
    const memoryContext = incognito ? '' : await loadMemoryContext(req.user?.id, message);

    /* ─── Detectar imagen ─── */
    const wantsImage = hasText && !hasFile && !isReasoning && isImageRequestSafe(message);

    /* ─── Web search (antes de SSE) ─── */
    let webSources = [];
    let webContext = '';

    if (webSearch === true && hasText && !wantsImage && !isReasoning) {
      const r = await runWebSearch(message, req.id);
      webSources = r.sources;
      webContext = r.context;
    }

    /* ─── System prompt base ─── */
    let systemPrompt = buildSystemPrompt(effectiveRole, [], {
      userId: req.user?.id,
      strategy: 'ab',
    });

    if (memoryContext) {
      systemPrompt += '\n\n' + memoryContext;
    }
    if (webContext) {
      systemPrompt += '\n\n' + webContext;
    }

    /* ─── Abrir SSE ─── */
    const sse = setupSSE(req, res);

    /* ─── Meta inicial ─── */
    sse.send({
      meta: {
        plan: lim.plan,
        restanteDia: lim.restanteDia,
        restanteMin: lim.restanteMin,
        mode: effectiveRole,
        memories: memoryContext ? 1 : 0,
        history: Array.isArray(history) ? history.length : 0,
        files: files.length + (file?.data ? 1 : 0),
        incognito,
        requestId: req.id,
        version: VERSION,
        webSearch: webSources.length > 0,
      },
    });

    /* ─── Fuentes web antes de tokens ─── */
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

    /* ─── MODO IMAGEN · respuesta sintética ─── */
    if (wantsImage) {
      const imgPrompt = extractImagePromptSafe(message);
      if (imgPrompt.length > 3) {
        LOG.info('Imagen', { reqId: req.id, prompt: short(imgPrompt, 60) });

        const enriched = enrichImagePromptSafe(imgPrompt);
        const imageUrl = buildImageUrlSafe(enriched);

        const replyText =
          `Listo, aquí está tu imagen de: **${imgPrompt}**\n\n` +
          `Si querés otra versión, decime "otra imagen de..." y creo una variación.`;

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

        return finishSSE(sse, req, incognito, t0, 50, 'pollinations', replyText, chatId, null);
      }
    }

    /* ─── Cache hit? (solo texto puro, sin file/web/imagen/incognito) ─── */
    if (!incognito && !hasFile && !isReasoning && !webSearch && !wantsImage && hasText) {
      const cached = getCachedResponse(message, effectiveRole, req.user?.id);
      if (cached) {
        LOG.debug('cache hit', { reqId: req.id });
        sse.send({ token: cached, done: false });
        sse.send({ done: true, provider: 'cache', cached: true });
        return finishSSE(sse, req, incognito, t0, 0, 'cache', cached, chatId, null);
      }
    }

    /* ─── AGENT MODE · tools + function calling ─── */
    const toolsWanted = useTools !== false && CFG.toolsEnabled;
    const toolsPossible = toolsWanted && !hasFile && !isReasoning && !wantsImage && groq;

    if (toolsPossible) {
      LOG.debug('Agent mode', { reqId: req.id });

      const tools = TOOLS.forGroq();
      const historyMsgs = (Array.isArray(history) ? history : [])
        .slice(-10)
        .filter((m) => m.content && String(m.content).trim())
        .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));

      const messages = [
        { role: 'system', content: systemPrompt },
        ...historyMsgs,
        { role: 'user', content: message },
      ];

      let fullAnswer = '';
      let toolsUsed = 0;
      let finalProvider = 'groq-agent';

      try {
        const result = await TOOLS.runLoop({
          messages,
          tools,
          ctx: {
            userId: req.user?.id,
            reqId: req.id,
            signal: sse.signal,
          },
          maxTurns: CFG.toolsMaxTurns,
          provider: 'groq',
          callLLM: async (msgs, tls) => {
            return await streamGroqWithTools(msgs, tls, sse, {
              signal: sse.signal,
              temperature: 0.7,
            });
          },
          parseResponse: (r) => ({
            calls: r.calls || [],
            text: r.text || '',
            raw: r,
          }),
          buildResults: (calls, results, msgs, response) => {
            const assistantMsg = {
              role: 'assistant',
              content: response.text || null,
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            };
            const toolMsgs = calls.map((c, i) => {
              const r = results[i]?.result || results[i];
              return {
                role: 'tool',
                tool_call_id: c.id,
                content: r.ok ? JSON.stringify(r.result) : JSON.stringify({ error: r.error }),
              };
            });
            return [...msgs, assistantMsg, ...toolMsgs];
          },
        });

        fullAnswer = result.finalText || '';
        toolsUsed = result.toolCalls?.length || 0;

        // Si el loop no generó texto (raro), usar el último mensaje
        if (!fullAnswer && result.messages && result.messages.length > 0) {
          const last = [...result.messages].reverse().find((m) => m.role === 'assistant' && m.content);
          if (last) fullAnswer = last.content;
        }

        // Enviar done
        sse.send({
          done: true,
          provider: 'groq-agent',
          toolsUsed,
          turns: result.turns,
        });

        return finishSSE(sse, req, incognito, t0, 0, 'groq-agent', fullAnswer, chatId, webSources);
      } catch (err) {
        LOG.warn('Agent mode falló, cayendo a chat normal', {
          reqId: req.id,
          error: err.message,
        });
        // Cae al flujo normal de abajo
      }
    }

    /* ─── FLUJO NORMAL · Iteración por motores ─── */
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
            LOG.debug(`Gemini #${entry.id} streaming`, { reqId: req.id });
            let local = 0;
            entry.requests++;

            const gen = streamGemini(entry.client, systemPrompt, finalMessage, file, opts);

            let first;
            try {
              first = await withFirstTokenTimeout(gen, CFG.aiFirstTokenTimeoutMs, req.id, `Gemini#${entry.id}`);
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
            LOG.warn(`Gemini #${entry.id} falló`, { reqId: req.id, error: short(err.message, 100) });
            if (isClientAbort(err) || sseDisconnected(sse, res)) break;
            if (isRateLimit(err) && !responded) {
              geminiCooldown(entry);
              continue;
            }
            if (responded) {
              sse.send({ token: '', done: true, provider: `gemini-${entry.id}`, partial: true });
              ok = true;
              chosenProvider = `gemini-${entry.id}`;
              break;
            }
            geminiCooldown(entry, CFG.geminiSoftCooldownMs);
          }
        }
        if (ok) {
          return finishSSE(sse, req, incognito, t0, tokens, chosenProvider, fullAnswer, chatId, webSources);
        }
        if (responded || sseDisconnected(sse, res)) {
          return finishSSE(sse, req, incognito, t0, tokens, chosenProvider || 'gemini-partial', fullAnswer, chatId, webSources);
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
          LOG.debug('Groq streaming', { reqId: req.id });
          let local = 0;

          const gen = streamGroq(groq, systemPrompt, finalMessage, file, opts);

          let first;
          try {
            first = await withFirstTokenTimeout(gen, CFG.aiFirstTokenTimeoutMs, req.id, 'Groq');
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
            return finishSSE(sse, req, incognito, t0, tokens, 'groq', fullAnswer, chatId, webSources);
          }
          throw new Error('Groq no devolvió tokens');
        } catch (err) {
          LOG.warn('Groq falló', { reqId: req.id, error: short(err.message, 100) });
          if (isClientAbort(err) || sseDisconnected(sse, res)) {
            return finishSSE(sse, req, incognito, t0, tokens, 'groq-aborted', fullAnswer, chatId, webSources);
          }
          if (responded) {
            sse.send({ token: '', done: true, provider: 'groq', partial: true });
            return finishSSE(sse, req, incognito, t0, tokens, 'groq', fullAnswer, chatId, webSources);
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
          LOG.debug('Kimi streaming', { reqId: req.id });
          let local = 0;

          const gen = streamKimi(nvidia, systemPrompt, finalMessage, file, opts);

          let first;
          try {
            first = await withFirstTokenTimeout(gen, CFG.aiFirstTokenTimeoutMs, req.id, 'Kimi');
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
            return finishSSE(sse, req, incognito, t0, tokens, 'nvidia', fullAnswer, chatId, webSources);
          }
          throw new Error('Kimi no devolvió tokens');
        } catch (err) {
          LOG.warn('Kimi falló', { reqId: req.id, error: short(err.message, 100) });
          if (isClientAbort(err) || sseDisconnected(sse, res)) {
            return finishSSE(sse, req, incognito, t0, tokens, 'nvidia-aborted', fullAnswer, chatId, webSources);
          }
          if (responded) {
            sse.send({ token: '', done: true, provider: 'nvidia', partial: true });
            return finishSSE(sse, req, incognito, t0, tokens, 'nvidia', fullAnswer, chatId, webSources);
          }
        }
      }
    }

    /* ─── Todos fallaron ─── */
    if (!responded && !sseDisconnected(sse, res)) {
      LOG.error('Todos los motores fallaron · reembolsando', { reqId: req.id });
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
        error: 'Los motores de IA están saturados. Intentá de nuevo en unos segundos.',
        done: true,
      });
      sse.close();
    } else if (!sse.isClosed()) {
      sse.close();
    }
  } catch (err) {
    LOG.error('Error en stream', { reqId: req.id, error: err.message, stack: err.stack });
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: 'Error interno del servidor' });
    }
  }
});

/**
 * finishSSE · cierre limpio con persistencia de sources + auto-extract memory.
 */
function finishSSE(sse, req, incognito, t0, tokens, provider, fullAnswer = '', chatId = null, webSources = null) {
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

  /* Persistir mensaje con sources */
  if (chatId && fullAnswer && !incognito) {
    persistAssistantMessage(req, {
      chatId,
      content: fullAnswer,
      sources: webSources,
    }).catch(() => {});
  }

  /* Auto-extract memory del conversation */
  if (!incognito && req.user?.id && fullAnswer && CFG.memoryEnabled) {
    const conversation = [
      ...(Array.isArray(req.body?.history) ? req.body.history.slice(-4) : []),
      { role: 'user', content: req.body?.message || '' },
      { role: 'assistant', content: fullAnswer },
    ];
    MEMORY.extractAndStore(req.user.id, conversation).catch((e) => {
      LOG.debug('memory extract failed', { reqId: req.id, error: e.message });
    });
  }

  /* Cache de respuesta */
  if (
    !incognito &&
    fullAnswer &&
    fullAnswer.length > 20 &&
    provider !== 'cache' &&
    !webSources &&
    !req.body?.reasoning &&
    !req.body?.file
  ) {
    setCachedResponse(
      req.body?.message || '',
      req.body?.role || 'student',
      req.user?.id,
      fullAnswer
    );
  }

  setImmediate(() => {
    sse.close();
    LOG.debug('Stream cerrado', {
      reqId: req.id,
      duration: `${dur}ms`,
      tokens,
      provider,
    });
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   27 · CHAT NORMAL · SIN STREAMING
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
      files = [],
      incognito = false,
      history = [],
      webSearch = false,
      chatId = null,
      reasoning = false,
    } = req.body ?? {};

    const hasText = message && String(message).trim();
    const hasFile = !!(file?.data || (files && files.length > 0));

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

    const isReasoning = reasoning === true || role === 'reasoning';
    const effectiveRole = isReasoning ? 'reasoning' : role;
    const finalMessage = buildFinalMessage(message, isReasoning);

    /* ─── Imagen ─── */
    if (hasText && !hasFile && !isReasoning && isImageRequestSafe(message)) {
      const imgPrompt = extractImagePromptSafe(message);
      if (imgPrompt.length > 3) {
        LOG.info('Imagen', { reqId: req.id, prompt: short(imgPrompt, 60) });
        const imageUrl = buildImageUrlSafe(enrichImagePromptSafe(imgPrompt));

        if (!incognito) registrarUso(req).catch(() => {});

        const replyText =
          `Listo, aquí está tu imagen de: **${imgPrompt}**\n\n` +
          `Si querés otra versión, decime "otra imagen de..." y creo una variación.`;

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
      const r = await runWebSearch(message, req.id);
      webSources = r.sources;
      webContext = r.context;
    }

    /* ─── Cache ─── */
    if (!incognito && !hasFile && !isReasoning && !webSearch && hasText) {
      const cached = getCachedResponse(message, effectiveRole, req.user?.id);
      if (cached) {
        LOG.debug('cache hit', { reqId: req.id });
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

    /* ─── Memory context ─── */
    const memoryContext = incognito ? '' : await loadMemoryContext(req.user?.id, message);

    let systemPrompt = buildSystemPrompt(effectiveRole, [], {
      userId: req.user?.id,
      strategy: 'ab',
    });

    if (memoryContext) systemPrompt += '\n\n' + memoryContext;
    if (webContext) systemPrompt += '\n\n' + webContext;

    const order = orderMotors(file);
    const attempts = [order[0], order[0], order[1], order[2], order[1], order[2]];
    let lastErr = null;

    for (let i = 0; i < attempts.length; i++) {
      const prov = attempts[i];
      if (i > 0) await sleep(CFG.retryBaseDelayMs);

      try {
        LOG.debug(`Intento ${i + 1}/${attempts.length}`, { reqId: req.id, provider: NAMES[prov] });
        const reply = await collectStream(prov, systemPrompt, finalMessage, file, history, isReasoning);

        if (reply && reply.trim()) {
          const dur = Date.now() - t0;
          LOG.info(`${NAMES[prov]} respondió en ${dur}ms`, { reqId: req.id });

          if (!incognito) registrarUso(req).catch(() => {});

          if (chatId && !incognito) {
            persistAssistantMessage(req, {
              chatId,
              content: reply,
              sources: webSources,
            }).catch(() => {});
          }

          if (!incognito && !webSearch && !hasFile && !isReasoning && reply.length > 20) {
            setCachedResponse(message, effectiveRole, req.user?.id, reply);
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
        LOG.warn(`${NAMES[prov]} falló`, { reqId: req.id, error: short(err.message, 100) });
        if (!isRateLimit(err)) break;
      }
    }

    LOG.error('Todos los intentos fallaron · reembolsando', { reqId: req.id });
    if (!incognito) reembolsarUso(req).catch(() => {});

    return res.status(503).json({
      ok: false,
      error: 'Los motores de IA están saturados. Esperá unos segundos e intentá de nuevo.',
    });
  } catch (err) {
    LOG.error('Error en chat normal', { reqId: req.id, error: err.message });
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
   28 · SETUP SSE · usa lib/sse.js wrapper
   ═══════════════════════════════════════════════════════════════════════════ */

function setupSSE(req, res) {
  // Wrapper compatible con el resto del código
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  res.flushHeaders?.();

  try { res.socket?.setNoDelay?.(true); } catch {}
  try { res.socket?.setTimeout?.(0); } catch {}

  let closed = false;
  let closeReason = null;
  const startedAt = Date.now();
  const controller = new AbortController();

  const abort = (reason) => {
    try { controller.abort(reason); } catch {}
  };

  const onClose = (reason) => {
    if (!closed) {
      closed = true;
      closeReason = reason;
      LOG.debug('SSE cerrado', {
        reqId: req.id,
        reason,
        durationMs: Date.now() - startedAt,
      });
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
      LOG.warn('SSE excedió max duration', { reqId: req.id });
      try { res.write(`data: ${JSON.stringify({ done: true, reason: 'max_duration' })}\n\n`); } catch {}
      try { res.end(); } catch {}
      onClose('max_duration');
      clearInterval(heartbeat);
      return;
    }
    try { res.write(': keepalive\n\n'); }
    catch (e) { onClose(`heartbeat.error:${e?.message || 'unknown'}`); }
  }, CFG.sseHeartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  const close = () => {
    clearInterval(heartbeat);
    if (!closed) {
      try { res.end(); } catch {}
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

/* ═══════════════════════════════════════════════════════════════════════════
   29 · ADMIN · Analytics
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
   30 · ADMIN · Métricas generales + health detallado
   ═══════════════════════════════════════════════════════════════════════════ */

app.get('/api/admin/metrics', requireAuth, requireAdmin, async (_req, res) => {
  try {
    return res.json({
      ok: true,
      errors: getErrorMetrics(10),
      rateLimit: getRateLimitMetrics(10),
      webhooks: getWebhookStats(),
      tools: TOOLS.metrics(),
      auth: getAuthMetrics(),
      sse: getSSEStats(),
      logger: getLoggerStats(),
      cache: {
        responses: responseCache.size,
        memories: memCache.size,
      },
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/admin/health', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [db, limits, analytics, notif, webhooks, search, backup] = await Promise.all([
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
      db, limits, analytics,
      notifications: notif,
      webhooks, search, backup,
      tools: TOOLS.metrics(),
      auth: getAuthMetrics(),
      ts: new Date().toISOString(),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   31 · ADMIN · Migraciones
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
   32 · ADMIN · Webhooks + Notify + Backup
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

app.post('/api/admin/notify', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { to, subject, message } = req.body || {};
    if (!to || !subject) return res.status(400).json({ ok: false, error: 'Faltan campos' });
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

app.get('/api/admin/backup', requireAuth, requireAdmin, async (_req, res) => {
  try { return res.json(await listBackups()); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
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
  try { return res.json(await getBackup(req.params.id)); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/admin/backup/:id/download', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await downloadBackup(req.params.id);
    if (!result.ok) return res.status(404).json(result);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
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
  try { return res.json(await deleteBackup(req.params.id)); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/backup/retention', requireAuth, requireAdmin, async (_req, res) => {
  try { return res.json(await runRetention()); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/admin/backup/cron', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try { return res.json(await scheduledBackup()); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   33 · CATCH-ALL + ERROR HANDLER
   ═══════════════════════════════════════════════════════════════════════════ */

app.use(notFoundMiddleware(publicDir));
// M-004 · stack solo en dev Y solo para peers loopback (ver errors.js).
app.use(errorMiddleware({ includeStack: !IS_PROD, includeStackForLocalOnly: true }));

/* ═══════════════════════════════════════════════════════════════════════════
   34 · BOOT · banner + server
   ═══════════════════════════════════════════════════════════════════════════ */

let server = null;

function banner() {
  const dbOn = supabaseDisponible();
  const gCount = geminiPool.length;
  const toolsCount = TOOLS.size();
  const providers = [
    groq ? 'Groq' : null,
    gCount > 0 ? 'Gemini' : null,
    nvidia ? 'Kimi' : null,
  ].filter(Boolean).join(' → ');

  console.log('');
  console.log('  ╭─────────────────────────────────────────────────────────╮');
  console.log(`  │  🇨🇴  NUMINATION · v${VERSION.padEnd(38)} │`);
  console.log(`  │  ${CODENAME} · "Numi es la clave"${' '.repeat(31)}│`);
  console.log('  ╰─────────────────────────────────────────────────────────╯');
  console.log('');
  console.log(`  🚀  http://localhost:${PORT}`);
  console.log('');
  console.log('  📋  PRIORIDAD DE MOTORES');
  console.log(`      Texto    → ${providers || 'sin keys'}`);
  console.log('      Archivos → Gemini → Kimi → Groq');
  console.log('      Agente   → Groq (tools) → Gemini (native)');
  console.log('');
  console.log('  🤖  MODELOS');
  console.log(`      Groq   → ${MODELS.GROQ}`);
  console.log(`      Gemini → ${MODELS.GEMINI}`);
  console.log(`      Kimi   → ${MODELS.KIMI}`);
  console.log('');
  console.log('  🔑  API KEYS');
  console.log(`      Groq         ${groq ? '✓' : '✗'}`);
  console.log(`      Gemini       ${gCount}/3 ${gCount > 0 ? '✓' : '✗'}`);
  console.log(`      Kimi         ${nvidia ? '✓' : '✗'}`);
  console.log('');
  console.log('  🎯  FEATURES');
  console.log(`      🎨 Imágenes       Pollinations`);
  console.log(`      🔍 Web Search     ${CFG.toolsEnabled ? 'activo' : 'inactivo'}`);
  console.log(`      🤖 Tools/Agent    ${toolsCount} tools ${CFG.toolsEnabled ? '✓' : '✗'}`);
  console.log(`      🧠 Memoria        ${CFG.memoryEnabled ? 'semántica (embeddings)' : 'legacy (strings)'}`);
  console.log(`      📎 Attachments    multi-file, ${CFG.attachmentsMaxCount} max, ${CFG.attachmentsMaxSize / 1024 / 1024}MB`);
  console.log(`      🎙️  Voice          ${CFG.voiceServerTTS ? 'server + browser' : 'solo browser'}`);
  console.log(`      💾 Base de datos  ${dbOn ? 'conectada' : 'sin conexión'}`);
  console.log('');
  console.log('  🛠️   SUBSISTEMAS');
  console.log('      · logger        · 6 niveles, JSON, redaction');
  console.log('      · sse           · heartbeat, backpressure');
  console.log('      · auth          · cache + circuit breaker');
  console.log('      · tools         · ' + toolsCount + ' herramientas');
  console.log('      · memory        · pgvector + embeddings');
  console.log('      · websearch     · Wikipedia + DDG + Brave');
  console.log('      · images        · Pollinations');
  console.log('      · analytics     · DAU/WAU/retention');
  console.log('      · notifications · multicanal');
  console.log('      · webhooks      · outbound firmados');
  console.log('      · search        · full-text');
  console.log('      · migrations    · versionado');
  console.log('      · backup        · snapshots');
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

/* ═══════════════════════════════════════════════════════════════════════════
   35 · GRACEFUL SHUTDOWN
   ═══════════════════════════════════════════════════════════════════════════ */

function shutdown(signal) {
  LOG.warn(`Recibido ${signal}. Cerrando...`);

  // Cerrar todas las conexiones SSE activas
  try {
    const closed = closeAllConnections('shutdown');
    LOG.info(`Cerradas ${closed} conexiones SSE`);
  } catch (e) {}

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

/* ═══════════════════════════════════════════════════════════════════════════
   36 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export default app;

export {
  app,
  CFG,
  VERSION,
  CODENAME,
  // Helpers exportados por si los tests los necesitan
  setupSSE,
  finishSSE,
  runWebSearch,
  loadMemoryContext,
  collectStream,
};