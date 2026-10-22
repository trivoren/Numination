/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   NUMINATION Â· index.js Â· v10.1 (Vercel Ready)
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
import OpenAI from 'openai';

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   INFRAESTRUCTURA
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
import { LOG, withReqId, expressMiddleware as loggerMiddleware, getStats as getLoggerStats, getMemoryLogs } from './lib/logger.js';
import { SSE, initSSE, sseSend, sseClose, sseError, sseHeartbeat, closeAllConnections, getStats as getSSEStats } from './lib/sse.js';
import { AUTH, attachUser, optionalAuth, requireAuth, requireAdmin, requireRole, requirePlan, requireScope, requireVerifiedEmail, requireNotBanned, requireApiKey, verifyWebhookSignature, protect, currentUser, currentContext, invalidateSession, invalidateProfile, issueApiKey, getAuthMetrics } from './middleware/auth.js';
import { TOOLS } from './services/tools.js';
import { MEMORY } from './services/long-term-memory.js';

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   SERVICIOS IA
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
import { streamGroq, streamGemini, streamKimi } from './services/streaming.js';
import { buildSystemPrompt, buildFinalMessage } from './services/prompts.js';
import { verificarLimite, registrarUso, reembolsarUso, getUsageStats, buildRateLimitHeaders, pingLimits } from './services/limits.js';
import { supabaseDisponible, listarMemories, pingDatabase } from './services/supabase.js';
import { searchWeb, formatResultsForAI } from './services/websearch.js';
import { buildImageUrl, isImageRequest, extractImagePrompt, enrichPrompt as enrichImagePrompt } from './services/images.js';

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   INFRAESTRUCTURA EXTRA
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
import { analyticsMiddleware, track, EVENTS as ANALYTICS_EVENTS, getSnapshot as getAnalyticsSnapshot, getDailyActiveUsers, getWeeklyActiveUsers, getMonthlyActiveUsers, getAverageRetention, getSignupFunnel, getWeeklyCohorts, getTopEvents, getProviderUsage, getPlanDistribution, pingAnalytics, flushAndStop as flushAnalytics } from './services/analytics.js';
import { notificationsMiddleware, notify, TYPES, getInbox, getUnreadCount, markAllRead, markRead, clearInbox, getPreferences, updatePreferences, pingNotifications, flushAndStop as flushNotifications } from './services/notifications.js';
import { dispatch, EVENTS as WEBHOOK_EVENTS, createSubscription, getSubscription, listSubscriptions, updateSubscription, deleteSubscription, rotateSecret, getDeliveryLog, getDlq, retryFromDlq, clearDlq, testSubscription, pingWebhooks, getStats as getWebhookStats, flushAndStop as flushWebhooks } from './services/webhooks.js';
import { search, suggest, getRecentSearches, clearRecentSearches, saveSearch, listSavedSearches, deleteSavedSearch, getTrendingSearches, pingSearch } from './services/search.js';
import { runMigrations, getStatus as getMigrationsStatus, verifyIntegrity as verifyMigrations } from './services/migrations.js';
import { createBackup, listBackups, getBackup, downloadBackup, deleteBackup, restoreBackup, runRetention, pingBackup, scheduledBackup } from './services/backup.js';
import { requestIdMiddleware, notFoundMiddleware, errorMiddleware, installProcessHandlers, getErrorMetrics } from './middleware/errors.js';
import { rateLimitUser, getRateLimitMetrics } from './middleware/rate-limit-per-user.js';

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   ROUTERS
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
import { mountAuthRoutes } from './auth.js';
import { mountChatRoutes } from './chats.js';
import { mountMemoryRoutes } from './memories.js';
import { mountSkillsRoutes } from './skills.js';
import { mountConnectorRoutes } from './connectors.js';
import { mountEmailRoutes } from './email.js';
import { mountCoderRoutes } from './coder.js';
import { mountPaymentRoutes } from './payments/routes.js';
import { mountAllRoutes } from './routes/index.js';

/* ═══════════════════════════════════════════════════════════════════════
   GUARDIA DE SEGURIDAD · Fase 3 (middleware)
   ═══════════════════════════════════════════════════════════════════════ */
import { rateLimiter } from './middleware/rate-limiter.js';
import { ipBlocker } from './middleware/ip-blocker.js';
import { banGuard, connectSpamFilter } from './middleware/ban-manager.js';
import { spamFilterMiddleware } from './services/spam-filter.js';
import { auditMiddleware } from './services/audit-logger.js';
import { affiliateTracker } from './services/affiliate-tracker.js';

/* ═══════════════════════════════════════════════════════════════════════
   WORKERS EN BACKGROUND · Fase 1
   ═══════════════════════════════════════════════════════════════════════ */
import { startAnalyzerWorker } from './services/chat-analyzer.js';
import { startCreditAlertCron } from './services/credit-alerts.js';
import { startBackupRobot } from './services/backup-robot.js';
import { connectPaymentEvents } from './services/invoice-generator.js';
import { mountWebVitalsRoutes } from './services/web-vitals.js';

/* â•â•â• NUMINATION LIBS â•â•â• */
import { ipGuard, rateLimit as ipRateLimit, blockCountries } from './middleware/ip-guard.js';
import { middleware as validateBody, SCHEMAS } from './lib/validators.js';
import { cache, cacheMiddleware } from './lib/cache.js';
import { createQueue, queueManager } from './lib/queue.js';
import { http } from './lib/http.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const VERSION = '10.1.0'; // ðŸ‘ˆ AJUSTE VERCEL
const CODENAME = 'Numi-OT.02';

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   01 Â· CONFIGURACIÃ“N (Ajustada para Serverless)
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

const IS_PROD = process.env.NODE_ENV === 'production';
const IS_VERCEL = process.env.VERCEL === '1' || process.env.VERCEL === 'true';
const PORT = parseInt(process.env.PORT || '8080', 10);

const CFG = Object.freeze({
  maxMsgLen: 8000,
  jsonLimit: '20mb',
  urlencodedLimit: '2mb',

  // ðŸ‘ˆ AJUSTE VERCEL: Vercel aborta a los 10s (Hobby) o 60s (Pro). 
  // Bajamos el timeout a 9s para que la IA tenga tiempo de responder antes de que Vercel la corte.
  aiFirstTokenTimeoutMs: 9_000, 
  aiFullResponseTimeoutMs: 55_000, 
  geminiCooldownMs: 60_000,
  geminiSoftCooldownMs: 15_000,
  retryBaseDelayMs: 900,

  sseHeartbeatMs: 8_000,
  sseMaxDurationMs: 50_000, // ðŸ‘ˆ Reducido a 50s por el lÃ­mite de Vercel

  responseCacheTtlMs: 15 * 60_000,
  responseCacheMax: 500,
  memoryCacheTtlMs: 30_000,

  rateLimitIPWindow: 60_000,
  rateLimitIPMax: 500,
  authFailThreshold: 5,
  authFailWindowMs: 60_000,
  authFailBlockMs: 300_000,

  keepAliveTimeout: 65_000,
  headersTimeout: 66_000,
  shutdownTimeout: 10_000,

  webSearchTimeoutMs: 8_000,
  webSearchMaxResults: 5,

  toolsEnabled: process.env.TOOLS_ENABLED !== 'false',
  toolsMaxTurns: 4,
  toolsMaxCallsPerTurn: 8,

  memoryEnabled: process.env.MEMORY_ENABLED !== 'false',
  memoryMaxTokens: 800,
  memoryMaxItems: 8,

  attachmentsMaxSize: 25 * 1024 * 1024,
  attachmentsMaxCount: 8,
  attachmentsMaxTextChars: 100_000,

  voiceServerTTS: process.env.SERVER_TTS === 'true',
  voiceElevenLabsKey: process.env.ELEVENLABS_API_KEY || null,
  voiceOpenAIKey: process.env.OPENAI_API_KEY || null,

  env: process.env.NODE_ENV || 'development',
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   02 Â· KEYS + MODELOS
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

// ðŸ‘ˆ AJUSTE VERCEL: Solo importar env.local si NO estamos en Vercel y existe el archivo
let TEST_KEYS = {};
if (!IS_VERCEL && fs.existsSync(path.join(__dirname, '..', 'env.local.js'))) {
  try {
    const mod = await import('../env.local.js');
    TEST_KEYS = mod.TEST_KEYS ?? {};
  } catch { /* ignorar */ }
}

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

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   03 Â· GEMINI POOL
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   04 Â· CLIENTES IA
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

const groq = KEYS.GROQ ? new Groq({ apiKey: KEYS.GROQ }) : null;
const nvidia = KEYS.NV
  ? new OpenAI({
      apiKey: KEYS.NV,
      baseURL: 'https://integrate.api.nvidia.com/v1',
    })
  : null;

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   05 Â· UTILIDADES
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function short(t, n = 120) {
  if (!t) return '';
  const s = String(t);
  return s.length <= n ? s : s.slice(0, n - 1) + 'â€¦';
}

function isRateLimit(err) {
  const msg = String(err?.message || '').toLowerCase();
  const st = err?.status ?? err?.code ?? 0;
  return (
    st === 429 || st === 503 || msg.includes('429') || msg.includes('503') ||
    msg.includes('quota') || msg.includes('rate limit') || msg.includes('overloaded')
  );
}

function isClientAbort(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  const msg = String(err?.message || '').toLowerCase();
  return (msg.includes('aborted') || msg.includes('abort')) && !msg.includes('timeout');
}

function sseDisconnected(sse, res) {
  return (sse.isClosed && sse.isClosed()) || (res && (res.destroyed || res.writableEnded));
}

/* â”€â”€â”€ Prompt injection guard â”€â”€â”€ */
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
  return INJECTION_PATTERNS.some((p) => p.test(String(message)));
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   06 Â· IP RATE LIMITER
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   07 Â· RESPONSE CACHE
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   08 Â· IMAGE HELPERS
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

function buildImageUrlSafe(prompt, opts = {}) {
  try {
    return buildImageUrl(prompt, opts);
  } catch (e) {
    const { width = 1024, height = 1024, model = 'flux', seed = Math.floor(Math.random() * 1e6) } = opts;
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
    if (/colombia|colombiano|colombiana|cafÃ©|cumbia|vallenato|magdalena|cÃ³ndor|arepa|barranquilla|medellÃ­n|bogotÃ¡/i.test(prompt)) {
      return prompt + ', Colombia, vibrant colors, golden hour lighting, highly detailed, cinematic';
    }
    return prompt + ', warm colors, artistic style, high quality, detailed';
  }
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   09 Â· MEMORIAS
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   10 Â· WEB SEARCH
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

async function runWebSearch(query, reqId) {
  try {
    LOG.debug('webSearch', { reqId, query: short(query, 60) });
    const results = await searchWeb(query, {
      maxResults: CFG.webSearchMaxResults,
      language: 'es',
      timeout: CFG.webSearchTimeoutMs,
    });

    if (!results || results.length === 0) {
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
    return { sources, context };
  } catch (e) {
    LOG.warn('webSearch fallÃ³', { reqId, error: e.message });
    return { sources: [], context: '' };
  }
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   11 Â· PERSISTENCIA
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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
  if (!chatId || !content || !req.user?.id) return;
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
    }
  } catch (e) {
    LOG.warn('persist exception', { reqId: req.id, error: e.message });
  }
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   12 Â· STREAMING HELPERS
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

function withFirstTokenTimeout(gen, timeoutMs, reqId, engineName) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`${engineName} no enviÃ³ primer token en ${timeoutMs}ms`);
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

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   13 Â· AGENT STREAMING Â· Tools + LLM
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

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

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   14 Â· EXPRESS APP + MIDDLEWARE CHAIN
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(requestIdMiddleware());

const CSP = [
  "default-src 'self'",
  // PayPal carga el SDK desde su dominio y abre sus iframes de checkout.
  // jsDelivr sirve Chart.js para el panel de administración.
  "script-src 'self' 'unsafe-inline' https://accounts.google.com https://www.paypal.com https://www.sandbox.paypal.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: https:",
  "connect-src 'self' https://*.supabase.co https://api.groq.com https://generativelanguage.googleapis.com https://www.paypal.com https://api-m.sandbox.paypal.com https://api-m.paypal.com https://api.openai.com https://api.tavily.com https://google.serper.dev",
  "frame-src https://accounts.google.com https://www.paypal.com https://www.sandbox.paypal.com https://www.paypalobjects.com",
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

/* ðŸ‘ˆ AJUSTE VERCEL: Asegurar que el dominio de Vercel estÃ© permitido */
const ALLOWED_ORIGINS = [
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:3000',
  'https://numination.app',
  'https://www.numination.app',
  'https://numinationchat.vercel.app', // Dominio de Vercel
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

app.use((req, res, next) => {
  if (/^\/assets\//.test(req.path) || /\.(js|css|png|jpg|svg|woff2?|ico)$/i.test(req.path)) {
    return next();
  }
  const { allowed, reset } = checkIP(req.ip);
  if (!allowed) {
    res.setHeader('Retry-After', String(Math.ceil((reset - Date.now()) / 1000)));
    return res.status(429).json({ ok: false, error: 'Demasiadas peticiones. EsperÃ¡ un minuto.', code: 'limit_ip' });
  }
  next();
});

// El body crudo solo se conserva para el webhook de PayPal: la firma se
// calcula sobre los bytes EXACTOS que envió PayPal, así que no puede
// re-serializarse el JSON ya parseado.
app.use(express.json({
  limit: CFG.jsonLimit,
  verify: (req, _res, buf) => {
    try {
      const url = req.originalUrl || req.url || '';
      if (url.startsWith('/api/payments/webhook')) {
        req.rawBody = Buffer.from(buf);
      }
    } catch {
      // Nunca romper el parseo por el capturador del body crudo.
    }
  },
}));
app.use(express.urlencoded({ extended: false, limit: CFG.urlencodedLimit }));
app.use(cookieParser());

if (process.env.IP_GUARD !== 'false') {
  app.use(ipGuard({
    rateLimit: true,
    countries: process.env.IP_COUNTRY_BLOCK === 'true',
    tor: process.env.IP_BLOCK_TOR === 'true',
    vpn: process.env.IP_BLOCK_VPN === 'true',
    ban: true,
  }));
}

/* ═══════════════════════════════════════════════════════════════════════
   GUARDIA DE SEGURIDAD · Fase 3
   -----------------------------------------------------------------------
   Orden (importante):
     1 · IP blocker        → descarta traffic de datacenters/VPN.
     2 · Rate limiter     → 60 req/min por IP (JSON 429 descriptivo).
     3 · Affiliate tracker→ registra ?ref= antes de que el usuario entre.
     4 · attachUser       → resuelve la sesión.
     5 · banGuard         → corta cuentas baneadas/suspendidas.
     6 · Spam filter     → puntúa el body (el ban-manager reacciona).
     7 · Audit logger     → registra la acción al terminar la request.
   ═══════════════════════════════════════════════════════════════════════ */
app.use(ipBlocker());
app.use(rateLimiter);
app.use(affiliateTracker());

app.use(attachUser);
app.use(notificationsMiddleware());
app.use(analyticsMiddleware({ sampleHttp: 1, ignore4xx: false }));
app.use(banGuard());

app.use(rateLimitUser({
  skipPaths: ['/api/health', '/api/version', '/api/ping'],
}));

// Filtro de spam: evalúa los cuerpos de escritura ANTES de que los
// routers los atiendan (si se montara después, Express ya habría
// respondido y el middleware no se ejecutaría nunca).
//
// OJO: no se revisa el campo "code": en el Coder es legítimo pegar
// <script> o "ignore previous instructions" dentro de un archivo.
app.use(spamFilterMiddleware({ fields: ['message', 'prompt', 'content'] }));

// Auditoría: registra la request al terminar. También debe ir antes de
// las rutas: usa res.on('finish'), que sólo se dispara si el listener
// se registró antes de que la respuesta terminara.
app.use(auditMiddleware({
  skipPaths: ['/api/health', '/api/version', '/api/ping'],
  skipStatic: true,
}));

app.use((req, res, next) => {
  if ((req.path === '/chat' || req.path === '/chat.html' || req.path === '/coder' || req.path === '/coder.html') && !req.user) {
    return res.redirect('/login');
  }
  if (req.path === '/admin' || req.path === '/admin.html') {
    if (!req.user) return res.redirect('/login');
    if (req.user.role !== 'admin') return res.redirect('/chat');
  }
  next();
});

/* ðŸ‘ˆ AJUSTE VERCEL: express.static solo en desarrollo local. 
   En Vercel, los archivos estÃ¡ticos los sirve la CDN (vercel.json -> outputDirectory: "public") */
if (!IS_VERCEL) {
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
}

app.get('/', (req, res) => res.redirect('/login'));

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   15 Â· ROUTERS EXISTENTES
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

mountAuthRoutes(app);
mountChatRoutes(app, requireAuth);
mountMemoryRoutes(app, requireAuth);
mountSkillsRoutes(app, requireAuth);
mountConnectorRoutes(app, requireAuth);
mountEmailRoutes(app, requireAuth);
mountCoderRoutes(app, requireAuth);

// ═══════════════════════════════════════════════════════════════════════
// MEGA-PROYECTO · routers nuevos
// -----------------------------------------------------------------------
// Un solo punto de montaje (src/routes/index.js) para:
//   /api/admin/*      panel de administración      (requireAdmin)
//   /api/rag/*        ingesta RAG + pgvector       (requireAuth)
//   /api/images/*     generación de imágenes        (requireAuth)
//   /api/voice/*      STT + TTS                     (requireAuth)
//   /api/personas/*   CRUD de personas              (requireAuth)
//   /api/memory*      caja fuerte de memoria        (requireAuth)
//   /api/sandbox/*    ejecutor de código aislado    (requireAuth)
//   /api/search/web   búsqueda web (5/min)          (requireAuth)
//   /api/prompts/*    biblioteca de prompts         (requireAuth)
//   /api/flags        banderas (lectura)            (requireAuth)
//   /api/admin/flags  banderas (escritura)          (requireAdmin)
//   /api/notifications* notificaciones               (requireAuth)
//   /api/billing/*    historial + facturas PDF      (requireAuth)
//   /api/ai/*         herramientas de IA            (requireAuth)
//   /api/gdpr/*       derechos del usuario         (requireAuth)
// ═══════════════════════════════════════════════════════════════════════
mountAllRoutes(app);

// Web Vitals (métricas de performance del frontend)
mountWebVitalsRoutes(app, { requireAuth, requireAdmin });

// ═══════════════════════════════════════════════════════════════════════
// WORKERS EN BACKGROUND
// -----------------------------------------------------------------------
// · chat-analyzer  → detecta uso intenso del Coder y sugiere el Plan.
// · credit-alerts  → cron diario con los usuarios que están sin créditos.
// · backup-robot   → pg_dump diario a /backups.
// · ban-manager    → conecta el filtro de spam con las sanciones.
// · invoice-gen    → genera la factura cuando PayPal confirma el pago.
// ═══════════════════════════════════════════════════════════════════════
(async () => {
  try {
    await connectSpamFilter();
    await connectPaymentEvents();
  } catch (e) {
    LOG.warn('workers: no se pudieron conectar los eventos', { error: e.message });
  }

  if (process.env.NODE_ENV !== 'test') {
    startAnalyzerWorker();
    startCreditAlertCron();
    if (process.env.BACKUP_ENABLED === 'true') {
      startBackupRobot();
    }
  }
})();

// ═══════════════════════════════════════════════════════════════════════
// PAGOS · PayPal
// -----------------------------------------------------------------------
// Monta:
//   POST /api/payments/create-order   (auth)
//   POST /api/payments/capture-order  (auth + anti-IDOR)
//   GET  /api/payments/config|credits|history
//   POST /api/payments/webhook        (firma criptográfica, sin sesión)
//
// Si PayPal no está configurado (faltan PAYPAL_CLIENT_ID /
// PAYPAL_CLIENT_SECRET / PAYPAL_WEBHOOK_ID) se loguea el error y el módulo
// queda deshabilitado: el resto de la app sigue funcionando. Con
// PAYMENTS_STRICT=true (o NODE_ENV=production) el arranque falla duro,
// porque un checkout mal configurado no debe aceptar cobros a medias.
// ═══════════════════════════════════════════════════════════════════════
try {
  mountPaymentRoutes(app, requireAuth);
} catch (err) {
  const paymentsStrict = process.env.PAYMENTS_STRICT === 'true' || process.env.NODE_ENV === 'production';
  LOG.error('payments.routes.mount_failed', {
    message: err && err.message,
    missing: err && Array.isArray(err.missing) ? err.missing : [],
  });
  if (paymentsStrict) throw err;
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   16 Â· HEALTH Â· VERSION Â· PING
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

app.get('/api/health', async (req, res) => {
  const minimal = {
    ok: true,
    service: 'numination',
    version: VERSION,
    uptime: Math.floor(process.uptime()),
    ts: new Date().toISOString(),
  };
  if (req.user?.role !== 'admin') return res.json(minimal);

  const mem = process.memoryUsage();
  const [dbPing, limitsPing, analyticsPing, notifPing, webhookPing, searchPing, backupPing] = await Promise.all([
    pingDatabase().catch(() => ({ ok: false })),
    pingLimits().catch(() => ({ ok: false })),
    pingAnalytics().catch(() => ({ ok: false })),
    pingNotifications().catch(() => ({ ok: false })),
    pingWebhooks().catch(() => ({ ok: false })),
    pingSearch().catch(() => ({ ok: false })),
    pingBackup().catch(() => ({ ok: false })),
  ]);

  let memoryStats = null;
  try { if (req.user?.id) memoryStats = await MEMORY.getStats(req.user.id); } catch (e) {}

  return res.json({
    ok: true, service: 'numination', version: VERSION, codename: CODENAME, env: CFG.env,
    uptime: Math.floor(process.uptime()),
    priority: { text: ['groq', 'gemini', 'nvidia'], files: ['gemini', 'nvidia', 'groq'], agent: ['groq', 'gemini'] },
    models: MODELS,
    engines: {
      groq: Boolean(groq), gemini: geminiPool.length > 0, nvidia: Boolean(nvidia),
      geminiPool: geminiPool.map((e) => ({ id: e.id, cooldown: e.cooldownUntil > Date.now(), requests: e.requests, errors: e.errors })),
    },
    keys: { groq: Boolean(KEYS.GROQ), gemini_1: Boolean(KEYS.GM1), gemini_2: Boolean(KEYS.GM2), gemini_3: Boolean(KEYS.GM3), nvidia: Boolean(KEYS.NV) },
    features: {
      webSearch: true, images: true, sources: true, tools: CFG.toolsEnabled, memory: CFG.memoryEnabled, attachments: true,
      voice: { server: CFG.voiceServerTTS, elevenlabs: Boolean(CFG.voiceElevenLabsKey), openai: Boolean(CFG.voiceOpenAIKey) },
      cache: { responses: responseCache.size, memories: memCache.size, logger: getLoggerStats() },
    },
    subsystems: {
      database: { connected: supabaseDisponible(), ping: dbPing },
      limits: limitsPing, analytics: analyticsPing, notifications: notifPing, webhooks: webhookPing, search: searchPing, backup: backupPing,
      tools: { enabled: CFG.toolsEnabled, count: TOOLS.size() }, memory: memoryStats || { enabled: CFG.memoryEnabled },
      auth: getAuthMetrics(), sse: getSSEStats(),
    },
    user: req.user ? { authenticated: true, email: req.user.email, role: req.user.role, plan: req.user.plan } : { authenticated: false },
    runtime: { node: process.version, memory: { rss: Math.round(mem.rss / 1024 / 1024) + ' MB', heap: Math.round(mem.heapUsed / 1024 / 1024) + ' MB' } },
    ts: new Date().toISOString(),
  });
});

app.get('/api/version', (_req, res) => {
  res.json({ ok: true, version: VERSION, name: 'Numination', codename: CODENAME, env: CFG.env, models: MODELS });
});

app.get('/api', (req, res) => {
  res.json({ ok: true, message: 'API de Numination funcionando al 100%', status: 'online' });
});

app.get('/api/ping', (_req, res) => {
  res.json({ ok: true, pong: Date.now() });
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   RESTO DE RUTAS (LÃ­mites, notificaciones, search, webhooks, memory, tools, keys, attachments, voice)
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

app.get('/api/limits/usage', requireAuth, async (req, res) => {
  try {
    const stats = await getUsageStats(req);
    buildRateLimitHeaders(res, stats);
    return res.json({ ok: true, ...stats });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Error consultando uso' });
  }
});

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const limit = Math.min(100, parseInt(req.query.limit || '50', 10));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));
    const inbox = await getInbox(req.user.id, { limit, offset });
    return res.json({ ok: true, ...inbox });
  } catch (e) { return res.status(500).json({ ok: false, error: 'Error cargando notificaciones' }); }
});

app.get('/api/notifications/unread', requireAuth, async (req, res) => {
  try { const count = await getUnreadCount(req.user.id); return res.json({ ok: true, unread: count }); } catch { return res.json({ ok: true, unread: 0 }); }
});

app.post('/api/notifications/read-all', requireAuth, async (req, res) => {
  try { await markAllRead(req.user.id); return res.json({ ok: true }); } catch { return res.status(500).json({ ok: false, error: 'Error' }); }
});

app.post('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try { const ok = await markRead(req.user.id, req.params.id); return res.json({ ok }); } catch { return res.status(500).json({ ok: false, error: 'Error' }); }
});

app.delete('/api/notifications', requireAuth, async (req, res) => {
  try { await clearInbox(req.user.id); return res.json({ ok: true }); } catch { return res.status(500).json({ ok: false, error: 'Error' }); }
});

app.get('/api/notifications/preferences', requireAuth, async (req, res) => {
  try { const prefs = await getPreferences(req.user.id); return res.json({ ok: true, preferences: prefs }); } catch { return res.status(500).json({ ok: false, error: 'Error' }); }
});

app.patch('/api/notifications/preferences', requireAuth, async (req, res) => {
  try { const result = await updatePreferences(req.user.id, req.body || {}); return res.json({ ok: true, preferences: result.prefs }); } catch { return res.status(500).json({ ok: false, error: 'Error' }); }
});

app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ ok: true, items: [], total: 0 });
    const types = req.query.types ? String(req.query.types).split(',').map((s) => s.trim()) : undefined;
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);
    return res.json(await search(q, req.user.id, { types, limit }));
  } catch (e) { return res.status(500).json({ ok: false, error: 'Error buscando' }); }
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
    return res.json({ ok: true, recent: await getRecentSearches(req.user.id, { limit }) });
  } catch { return res.json({ ok: true, recent: [] }); }
});

app.delete('/api/search/recent', requireAuth, async (req, res) => {
  await clearRecentSearches(req.user.id);
  return res.json({ ok: true });
});

app.get('/api/search/trending', async (_req, res) => {
  try {
    const limit = Math.min(parseInt(_req.query.limit || '10', 10), 50);
    return res.json({ ok: true, trending: await getTrendingSearches({ limit }) });
  } catch { return res.json({ ok: true, trending: [] }); }
});

app.post('/api/search/saved', requireAuth, async (req, res) => {
  const result = await saveSearch(req.user.id, req.body || {});
  return res.status(result.ok ? 201 : 400).json(result);
});

app.get('/api/search/saved', requireAuth, async (req, res) => {
  return res.json({ ok: true, saved: await listSavedSearches(req.user.id) });
});

app.delete('/api/search/saved/:id', requireAuth, async (req, res) => {
  return res.json({ ok: await deleteSavedSearch(req.user.id, req.params.id) });
});

app.get('/api/webhooks', requireAuth, async (req, res) => {
  const subs = await listSubscriptions(req.user.id);
  return res.json({ ok: true, webhooks: subs.map((s) => ({ ...s, secret: undefined })) });
});

app.post('/api/webhooks', requireAuth, async (req, res) => {
  const result = await createSubscription(req.user.id, req.body || {});
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
  return res.json(await deleteSubscription(req.params.id, req.user.id));
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
  const deliveries = await getDeliveryLog(req.params.id, { limit: Math.min(100, parseInt(req.query.limit || '50', 10)) });
  return res.json({ ok: true, deliveries });
});

app.get('/api/webhooks/:id/dlq', requireAuth, async (req, res) => {
  const sub = await getSubscription(req.params.id);
  if (!sub || sub.userId !== req.user.id) return res.status(403).json({ ok: false });
  const dlq = await getDlq(req.params.id, { limit: Math.min(100, parseInt(req.query.limit || '50', 10)) });
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

app.get('/api/memory/stats', requireAuth, async (req, res) => {
  try { return res.json({ ok: true, stats: await MEMORY.getStats(req.user.id) }); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/memory/list', requireAuth, async (req, res) => {
  try {
    const list = await MEMORY.list(req.user.id, { category: req.query.category || undefined, limit: Math.min(200, parseInt(req.query.limit || '100', 10)) });
    return res.json({ ok: true, memories: list, count: list.length });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/memory/search', requireAuth, async (req, res) => {
  try {
    const { query, limit = 10 } = req.body || {};
    if (!query) return res.status(400).json({ ok: false, error: 'query requerido' });
    const results = await MEMORY.search(req.user.id, query, { limit });
    return res.json({ ok: true, results, count: results.length });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/memory/store', requireAuth, async (req, res) => {
  try {
    const { text, category, importance } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: 'text requerido' });
    return res.status(201).json({ ok: true, memory: await MEMORY.store(req.user.id, text, { category, importance }) });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/memory/:id', requireAuth, async (req, res) => {
  try { await MEMORY.remove(req.user.id, req.params.id); return res.json({ ok: true }); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/memory', requireAuth, async (req, res) => {
  try { return res.json({ ok: true, cleared: await MEMORY.clear(req.user.id) }); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/memory/consolidate', requireAuth, async (req, res) => {
  try { return res.json({ ok: true, ...await MEMORY.consolidate(req.user.id) }); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/memory/migrate', requireAuth, async (req, res) => {
  try { return res.json({ ok: true, ...await MEMORY.migrate(req.user.id) }); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/memory/contradictions', requireAuth, async (req, res) => {
  try { return res.json({ ok: true, contradictions: await MEMORY.detectContradictions(req.user.id) }); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/memory/decay', requireAuth, async (req, res) => {
  try { return res.json({ ok: true, ...await MEMORY.applyDecay(req.user.id) }); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/tools', requireAuth, async (req, res) => {
  try {
    const tools = TOOLS.list({ noBeta: true });
    return res.json({ ok: true, count: tools.length, tools: tools.map((t) => ({ name: t.name, description: t.description, category: t.category, cache: t.cache.enabled })) });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/tools/execute', requireAuth, async (req, res) => {
  try {
    const { name, args } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: 'name requerido' });
    return res.json({ ok: (await TOOLS.execute(name, args || {}, { userId: req.user.id, reqId: req.id })).ok, ...await TOOLS.execute(name, args || {}, { userId: req.user.id, reqId: req.id }) });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/admin/tools/metrics', requireAuth, requireAdmin, async (_req, res) => {
  return res.json({ ok: true, metrics: TOOLS.metrics() });
});

app.post('/api/admin/tools/test', requireAuth, requireAdmin, async (_req, res) => {
  try { return res.json(await TOOLS.test()); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/keys', requireAuth, async (req, res) => {
  try {
    const { key, hash, preview } = issueApiKey();
    const supabase = await getSbClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB no disponible' });

    const { error } = await supabase.from('api_keys').insert({
      id: crypto.randomUUID(), user_id: req.user.id, name: String(req.body?.name || 'Default').slice(0, 100),
      key_hash: hash, preview, scopes: [], created_at: new Date().toISOString(),
    });

    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.status(201).json({ ok: true, key, preview, message: 'GuardÃ¡ esta key. No se muestra de nuevo.' });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/keys', requireAuth, async (req, res) => {
  try {
    const supabase = await getSbClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB no disponible' });
    const { data, error } = await supabase.from('api_keys').select('id, name, preview, scopes, created_at, last_used_at, revoked_at').eq('user_id', req.user.id).order('created_at', { ascending: false });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, keys: data || [] });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/keys/:id', requireAuth, async (req, res) => {
  try {
    const supabase = await getSbClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'DB no disponible' });
    const { error } = await supabase.from('api_keys').update({ revoked_at: new Date().toISOString() }).eq('id', req.params.id).eq('user_id', req.user.id);
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/attachments/upload', requireAuth, async (req, res) => {
  try {
    const { name, mime, data, size } = req.body || {};
    if (!name || !data) return res.status(400).json({ ok: false, error: 'name y data requeridos' });
    if (size && size > CFG.attachmentsMaxSize) return res.status(413).json({ ok: false, error: `Archivo muy grande (mÃ¡x ${CFG.attachmentsMaxSize / 1024 / 1024} MB)` });

    const supabase = await getSbClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'Storage no disponible' });

    const buffer = Buffer.from(data, 'base64');
    const ext = name.includes('.') ? name.split('.').pop() : 'bin';
    const path_ = `${req.user.id}/${crypto.randomUUID()}.${ext}`;

    const { error } = await supabase.storage.from('attachments').upload(path_, buffer, { contentType: mime || 'application/octet-stream', upsert: false });
    if (error) return res.status(500).json({ ok: false, error: error.message });

    const { data: urlData } = supabase.storage.from('attachments').getPublicUrl(path_);
    return res.json({ ok: true, attachment: { id: path_, name, mime, size: buffer.length, url: urlData.publicUrl } });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/attachments/list', requireAuth, async (req, res) => {
  try {
    const supabase = await getSbClient();
    if (!supabase) return res.status(503).json({ ok: false, error: 'Storage no disponible' });
    const { data, error } = await supabase.storage.from('attachments').list(req.user.id, { limit: 100 });
    if (error) return res.status(500).json({ ok: false, error: error.message });
    return res.json({ ok: true, files: data || [] });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/voice/tts', requireAuth, async (req, res) => {
  try {
    const { text, voice = 'default', locale = 'es-CO' } = req.body || {};
    if (!text) return res.status(400).json({ ok: false, error: 'text requerido' });

    if (CFG.voiceElevenLabsKey) {
      try {
        const voiceId = voice !== 'default' ? voice : 'pNInz6obpgDQGcFmaJgB';
        const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
          method: 'POST', headers: { 'xi-api-key': CFG.voiceElevenLabsKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: String(text).slice(0, 5000), model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
        });
        if (r.ok) {
          res.setHeader('Content-Type', 'audio/mpeg');
          res.setHeader('Cache-Control', 'public, max-age=3600');
          return res.send(Buffer.from(await r.arrayBuffer()));
        }
      } catch (e) { LOG.warn('ElevenLabs fallÃ³', { error: e.message }); }
    }

    if (CFG.voiceOpenAIKey) {
      try {
        const openai = new OpenAI({ apiKey: CFG.voiceOpenAIKey });
        const mp3 = await openai.audio.speech.create({ model: 'tts-1', voice: voice === 'default' ? 'alloy' : voice, input: String(text).slice(0, 4000) });
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(Buffer.from(await mp3.arrayBuffer()));
      } catch (e) { LOG.warn('OpenAI TTS fallÃ³', { error: e.message }); }
    }

    return res.status(501).json({ ok: false, error: 'Server TTS no configurado.', hint: 'ConfigurÃ¡ ELEVENLABS_API_KEY o OPENAI_API_KEY' });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.post('/api/voice/stt', requireAuth, async (req, res) => {
  try {
    const { audio, mime = 'audio/webm' } = req.body || {};
    if (!audio) return res.status(400).json({ ok: false, error: 'audio requerido' });
    if (!CFG.voiceOpenAIKey) return res.status(501).json({ ok: false, error: 'Server STT no configurado.', hint: 'ConfigurÃ¡ OPENAI_API_KEY' });

    const openai = new OpenAI({ apiKey: CFG.voiceOpenAIKey });
    const file = new File([Buffer.from(audio, 'base64')], 'audio.webm', { type: mime });
    const transcription = await openai.audio.transcriptions.create({ file, model: 'whisper-1', language: 'es' });
    return res.json({ ok: true, text: transcription.text });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   26 Â· CHAT STREAMING
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

app.post('/api/chat/stream', async (req, res) => {
  const t0 = Date.now();
  try {
    const lim = await verificarLimite(req);
    buildRateLimitHeaders(res, lim);

    if (!lim.permitido) {
      if (lim.retryAfter) res.setHeader('Retry-After', String(lim.retryAfter));
      return res.status(429).json({ ok: false, error: lim.mensaje, razon: lim.razon, retryAfter: lim.retryAfter, plan: lim.plan, uso: lim.uso, limites: lim.limites });
    }

    const { message, role = 'student', file = null, files = [], incognito = false, history = [], webSearch = false, chatId = null, useTools, reasoning = false } = req.body ?? {};
    const hasText = message && String(message).trim();
    const hasFile = !!(file?.data || (files && files.length > 0));

    if (!hasText && !hasFile) return res.status(400).json({ ok: false, error: 'Falta el mensaje o archivo' });
    if (hasText && String(message).length > CFG.maxMsgLen) return res.status(400).json({ ok: false, error: `Mensaje muy largo (mÃ¡x ${CFG.maxMsgLen} caracteres)` });
    if (hasText && isInjection(message)) return res.status(403).json({ ok: false, error: 'No puedo procesar esa instrucciÃ³n.', code: 'chat_injection_blocked' });

    const isReasoning = reasoning === true || role === 'reasoning';
    const effectiveRole = isReasoning ? 'reasoning' : role;
    const finalMessage = buildFinalMessage(message, isReasoning);
    const memoryContext = incognito ? '' : await loadMemoryContext(req.user?.id, message);
    const wantsImage = hasText && !hasFile && !isReasoning && isImageRequestSafe(message);

    let webSources = [];
    let webContext = '';

    if (webSearch === true && hasText && !wantsImage && !isReasoning) {
      const r = await runWebSearch(message, req.id);
      webSources = r.sources;
      webContext = r.context;
    }

    let systemPrompt = buildSystemPrompt(effectiveRole, [], { userId: req.user?.id, strategy: 'ab' });
    if (memoryContext) systemPrompt += '\n\n' + memoryContext;
    if (webContext) systemPrompt += '\n\n' + webContext;

    const sse = setupSSE(req, res);

    sse.send({ meta: { plan: lim.plan, restanteDia: lim.restanteDia, restanteMin: lim.restanteMin, mode: effectiveRole, memories: memoryContext ? 1 : 0, history: Array.isArray(history) ? history.length : 0, files: files.length + (file?.data ? 1 : 0), incognito, requestId: req.id, version: VERSION, webSearch: webSources.length > 0 } });

    if (webSources.length > 0) sse.send({ sources: webSources });

    if (req.user?.id && !incognito) {
      track(ANALYTICS_EVENTS.AI_REQUEST, { userId: req.user.id, meta: { mode: effectiveRole, webSearch: webSources.length > 0 } });
    }

    if (wantsImage) {
      const imgPrompt = extractImagePromptSafe(message);
      if (imgPrompt.length > 3) {
        const imageUrl = buildImageUrlSafe(enrichImagePromptSafe(imgPrompt));
        const replyText = `Listo, aquÃ­ estÃ¡ tu imagen de: **${imgPrompt}**\n\nSi querÃ©s otra versiÃ³n, decime "otra imagen de..." y creo una variaciÃ³n.`;
        sse.send({ token: replyText, done: false });
        sse.send({ image: { url: imageUrl, prompt: imgPrompt }, done: true, provider: 'pollinations' });
        if (!incognito) {
          registrarUso(req).catch(() => {});
          if (chatId) persistAssistantMessage(req, { chatId, content: replyText + `\n\n![imagen](${imageUrl})`, sources: null }).catch(() => {});
        }
        return finishSSE(sse, req, incognito, t0, 50, 'pollinations', replyText, chatId, null);
      }
    }

    if (!incognito && !hasFile && !isReasoning && !webSearch && !wantsImage && hasText) {
      const cached = getCachedResponse(message, effectiveRole, req.user?.id);
      if (cached) {
        sse.send({ token: cached, done: false });
        sse.send({ done: true, provider: 'cache', cached: true });
        return finishSSE(sse, req, incognito, t0, 0, 'cache', cached, chatId, null);
      }
    }

    const toolsWanted = useTools !== false && CFG.toolsEnabled;
    const toolsPossible = toolsWanted && !hasFile && !isReasoning && !wantsImage && groq;

    if (toolsPossible) {
      const tools = TOOLS.forGroq();
      const historyMsgs = (Array.isArray(history) ? history : []).slice(-10).filter((m) => m.content && String(m.content).trim()).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
      const messages = [{ role: 'system', content: systemPrompt }, ...historyMsgs, { role: 'user', content: message }];
      let fullAnswer = '';
      let toolsUsed = 0;

      try {
        const result = await TOOLS.runLoop({
          messages, tools, ctx: { userId: req.user?.id, reqId: req.id, signal: sse.signal }, maxTurns: CFG.toolsMaxTurns, provider: 'groq',
          callLLM: async (msgs, tls) => streamGroqWithTools(msgs, tls, sse, { signal: sse.signal, temperature: 0.7 }),
          parseResponse: (r) => ({ calls: r.calls || [], text: r.text || '', raw: r }),
          buildResults: (calls, results, msgs, response) => {
            const assistantMsg = { role: 'assistant', content: response.text || null, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) };
            const toolMsgs = calls.map((c, i) => ({ role: 'tool', tool_call_id: c.id, content: (results[i]?.result || results[i]).ok ? JSON.stringify((results[i]?.result || results[i]).result) : JSON.stringify({ error: (results[i]?.result || results[i]).error }) }));
            return [...msgs, assistantMsg, ...toolMsgs];
          },
        });
        fullAnswer = result.finalText || '';
        toolsUsed = result.toolCalls?.length || 0;
        if (!fullAnswer && result.messages?.length > 0) {
          const last = [...result.messages].reverse().find((m) => m.role === 'assistant' && m.content);
          if (last) fullAnswer = last.content;
        }
        sse.send({ done: true, provider: 'groq-agent', toolsUsed, turns: result.turns });
        return finishSSE(sse, req, incognito, t0, 0, 'groq-agent', fullAnswer, chatId, webSources);
      } catch (err) {
        LOG.warn('Agent mode fallÃ³', { reqId: req.id, error: err.message });
      }
    }

    let responded = false;
    let tokens = 0;
    let chosenProvider = null;
    let fullAnswer = '';

    for (const prov of orderMotors(file)) {
      if (sseDisconnected(sse, res)) break;

      if (prov === 'gemini') {
        const candidates = geminiAvailable();
        if (!candidates.length) continue;
        let ok = false;
        for (const entry of candidates) {
          if (sseDisconnected(sse, res)) break;
          const opts = buildStreamOpts({ reasoning: isReasoning, history, signal: sse.signal, reqId: req.id, providerName: `Gemini#${entry.id}` });
          try {
            let local = 0;
            entry.requests++;
            const gen = streamGemini(entry.client, systemPrompt, finalMessage, file, opts);
            let first;
            try { first = await withFirstTokenTimeout(gen, CFG.aiFirstTokenTimeoutMs, req.id, `Gemini#${entry.id}`); } catch (e) { throw new Error(`Gemini#${entry.id} timeout`); }
            if (!first.done && first.value) { sse.send({ token: first.value, done: false }); fullAnswer += first.value; responded = true; tokens++; local++; }
            for await (const token of gen) {
              if (sseDisconnected(sse, res)) break;
              sse.send({ token, done: false }); fullAnswer += token; responded = true; tokens++; local++;
            }
            if (local > 0) { sse.send({ token: '', done: true, provider: `gemini-${entry.id}` }); ok = true; chosenProvider = `gemini-${entry.id}`; break; }
            throw new Error('Gemini no devolviÃ³ tokens');
          } catch (err) {
            if (isClientAbort(err) || sseDisconnected(sse, res)) break;
            if (isRateLimit(err) && !responded) { geminiCooldown(entry); continue; }
            if (responded) { sse.send({ token: '', done: true, provider: `gemini-${entry.id}`, partial: true }); ok = true; chosenProvider = `gemini-${entry.id}`; break; }
            geminiCooldown(entry, CFG.geminiSoftCooldownMs);
          }
        }
        if (ok) return finishSSE(sse, req, incognito, t0, tokens, chosenProvider, fullAnswer, chatId, webSources);
        if (responded || sseDisconnected(sse, res)) return finishSSE(sse, req, incognito, t0, tokens, chosenProvider || 'gemini-partial', fullAnswer, chatId, webSources);
      }
      else if (prov === 'groq') {
        if (!groq) continue;
        const opts = buildStreamOpts({ reasoning: isReasoning, history, signal: sse.signal, reqId: req.id, providerName: 'Groq' });
        try {
          let local = 0;
          const gen = streamGroq(groq, systemPrompt, finalMessage, file, opts);
          let first;
          try { first = await withFirstTokenTimeout(gen, CFG.aiFirstTokenTimeoutMs, req.id, 'Groq'); } catch (e) { throw new Error(`Groq timeout`); }
          if (!first.done && first.value) { sse.send({ token: first.value, done: false }); fullAnswer += first.value; responded = true; tokens++; local++; }
          for await (const token of gen) {
            if (sseDisconnected(sse, res)) break;
            sse.send({ token, done: false }); fullAnswer += token; responded = true; tokens++; local++;
          }
          if (local > 0) { sse.send({ token: '', done: true, provider: 'groq' }); return finishSSE(sse, req, incognito, t0, tokens, 'groq', fullAnswer, chatId, webSources); }
          throw new Error('Groq no devolviÃ³ tokens');
        } catch (err) {
          if (isClientAbort(err) || sseDisconnected(sse, res)) return finishSSE(sse, req, incognito, t0, tokens, 'groq-aborted', fullAnswer, chatId, webSources);
          if (responded) { sse.send({ token: '', done: true, provider: 'groq', partial: true }); return finishSSE(sse, req, incognito, t0, tokens, 'groq', fullAnswer, chatId, webSources); }
        }
      }
      else if (prov === 'nvidia') {
        if (!nvidia) continue;
        const opts = buildStreamOpts({ reasoning: isReasoning, history, signal: sse.signal, reqId: req.id, providerName: 'Kimi' });
        try {
          let local = 0;
          const gen = streamKimi(nvidia, systemPrompt, finalMessage, file, opts);
          let first;
          try { first = await withFirstTokenTimeout(gen, CFG.aiFirstTokenTimeoutMs, req.id, 'Kimi'); } catch (e) { throw new Error(`Kimi timeout`); }
          if (!first.done && first.value) { sse.send({ token: first.value, done: false }); fullAnswer += first.value; responded = true; tokens++; local++; }
          for await (const token of gen) {
            if (sseDisconnected(sse, res)) break;
            sse.send({ token, done: false }); fullAnswer += token; responded = true; tokens++; local++;
          }
          if (local > 0) { sse.send({ token: '', done: true, provider: 'nvidia' }); return finishSSE(sse, req, incognito, t0, tokens, 'nvidia', fullAnswer, chatId, webSources); }
          throw new Error('Kimi no devolviÃ³ tokens');
        } catch (err) {
          if (isClientAbort(err) || sseDisconnected(sse, res)) return finishSSE(sse, req, incognito, t0, tokens, 'nvidia-aborted', fullAnswer, chatId, webSources);
          if (responded) { sse.send({ token: '', done: true, provider: 'nvidia', partial: true }); return finishSSE(sse, req, incognito, t0, tokens, 'nvidia', fullAnswer, chatId, webSources); }
        }
      }
    }

    if (!responded && !sseDisconnected(sse, res)) {
      if (!incognito) {
        reembolsarUso(req).catch(() => {});
        dispatch(WEBHOOK_EVENTS.AI_ALL_FAILED, { userId: req.user?.id, data: { mode: effectiveRole } }).catch(() => {});
        if (req.user?.id) track(ANALYTICS_EVENTS.AI_ERROR, { userId: req.user.id, meta: { provider: 'all', code: 'all_failed' } });
      }
      sse.send({ error: 'Los motores de IA estÃ¡n saturados. IntentÃ¡ de nuevo en unos segundos.', done: true });
      sse.close();
    } else if (!sse.isClosed()) {
      sse.close();
    }
  } catch (err) {
    LOG.error('Error en stream', { reqId: req.id, error: err.message, stack: err.stack });
    if (!res.headersSent) res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

function finishSSE(sse, req, incognito, t0, tokens, provider, fullAnswer = '', chatId = null, webSources = null) {
  const dur = Date.now() - t0;
  if (!incognito) {
    registrarUso(req).catch(() => {});
    if (req.user?.id) {
      track(ANALYTICS_EVENTS.CHAT_MESSAGE_RECEIVED, { userId: req.user.id, meta: { provider, durationMs: dur, tokens, sources: webSources?.length || 0 } });
      dispatch(WEBHOOK_EVENTS.CHAT_MESSAGE_RECEIVED, { userId: req.user.id, data: { provider, tokens, durationMs: dur } }).catch(() => {});
    }
  }

  if (chatId && fullAnswer && !incognito) {
    persistAssistantMessage(req, { chatId, content: fullAnswer, sources: webSources }).catch(() => {});
  }

  if (!incognito && req.user?.id && fullAnswer && CFG.memoryEnabled) {
    const conversation = [...(Array.isArray(req.body?.history) ? req.body.history.slice(-4) : []), { role: 'user', content: req.body?.message || '' }, { role: 'assistant', content: fullAnswer }];
    MEMORY.extractAndStore(req.user.id, conversation).catch(() => {});
  }

  if (!incognito && fullAnswer && fullAnswer.length > 20 && provider !== 'cache' && !webSources && !req.body?.reasoning && !req.body?.file) {
    setCachedResponse(req.body?.message || '', req.body?.role || 'student', req.user?.id, fullAnswer);
  }

  setImmediate(() => {
    sse.close();
  });
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   27 Â· CHAT NORMAL Â· SIN STREAMING
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

app.post('/api/chat', async (req, res) => {
  const t0 = Date.now();
  try {
    const lim = await verificarLimite(req);
    buildRateLimitHeaders(res, lim);
    if (!lim.permitido) {
      if (lim.retryAfter) res.setHeader('Retry-After', String(lim.retryAfter));
      return res.status(429).json({ ok: false, error: lim.mensaje });
    }

    const { message, role = 'student', file = null, files = [], incognito = false, history = [], webSearch = false, chatId = null, reasoning = false } = req.body ?? {};
    const hasText = message && String(message).trim();
    const hasFile = !!(file?.data || (files && files.length > 0));

    if (!hasText && !hasFile) return res.status(400).json({ ok: false, error: 'Falta el mensaje o archivo' });
    if (hasText && String(message).length > CFG.maxMsgLen) return res.status(400).json({ ok: false, error: 'Mensaje muy largo' });
    if (hasText && isInjection(message)) return res.status(403).json({ ok: false, error: 'No puedo procesar esa instrucciÃ³n.' });

    const isReasoning = reasoning === true || role === 'reasoning';
    const effectiveRole = isReasoning ? 'reasoning' : role;
    const finalMessage = buildFinalMessage(message, isReasoning);

    if (hasText && !hasFile && !isReasoning && isImageRequestSafe(message)) {
      const imgPrompt = extractImagePromptSafe(message);
      if (imgPrompt.length > 3) {
        const imageUrl = buildImageUrlSafe(enrichImagePromptSafe(imgPrompt));
        if (!incognito) registrarUso(req).catch(() => {});
        const replyText = `Listo, aquÃ­ estÃ¡ tu imagen de: **${imgPrompt}**\n\nSi querÃ©s otra versiÃ³n, decime "otra imagen de..." y creo una variaciÃ³n.`;
        if (chatId && !incognito) persistAssistantMessage(req, { chatId, content: replyText + `\n\n![imagen](${imageUrl})`, sources: null }).catch(() => {});
        return res.json({ ok: true, reply: replyText, imageUrl, imagePrompt: imgPrompt, type: 'image', provider: 'pollinations' });
      }
    }

    let webSources = [];
    let webContext = '';

    if (webSearch === true && hasText && !isReasoning && !hasFile) {
      const r = await runWebSearch(message, req.id);
      webSources = r.sources;
      webContext = r.context;
    }

    if (!incognito && !hasFile && !isReasoning && !webSearch && hasText) {
      const cached = getCachedResponse(message, effectiveRole, req.user?.id);
      if (cached) return res.json({ ok: true, reply: cached, provider: 'cache', cached: true, mode: effectiveRole, durationMs: 0 });
    }

    const memoryContext = incognito ? '' : await loadMemoryContext(req.user?.id, message);
    let systemPrompt = buildSystemPrompt(effectiveRole, [], { userId: req.user?.id, strategy: 'ab' });
    if (memoryContext) systemPrompt += '\n\n' + memoryContext;
    if (webContext) systemPrompt += '\n\n' + webContext;

    const order = orderMotors(file);
    const attempts = [order[0], order[0], order[1], order[2], order[1], order[2]];
    let lastErr = null;

    for (let i = 0; i < attempts.length; i++) {
      const prov = attempts[i];
      if (i > 0) await sleep(CFG.retryBaseDelayMs);
      try {
        const reply = await collectStream(prov, systemPrompt, finalMessage, file, history, isReasoning);
        if (reply && reply.trim()) {
          const dur = Date.now() - t0;
          if (!incognito) registrarUso(req).catch(() => {});
          if (chatId && !incognito) persistAssistantMessage(req, { chatId, content: reply, sources: webSources }).catch(() => {});
          if (!incognito && !webSearch && !hasFile && !isReasoning && reply.length > 20) setCachedResponse(message, effectiveRole, req.user?.id, reply);
          return res.json({ ok: true, reply, provider: prov, mode: effectiveRole, durationMs: dur, sources: webSources.length > 0 ? webSources : undefined });
        }
        throw new Error('Respuesta vacÃ­a');
      } catch (err) {
        lastErr = err;
        if (!isRateLimit(err)) break;
      }
    }

    if (!incognito) reembolsarUso(req).catch(() => {});
    return res.status(503).json({ ok: false, error: 'Los motores de IA estÃ¡n saturados. EsperÃ¡ unos segundos e intentÃ¡ de nuevo.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error interno del servidor' });
  }
});

async function collectStream(prov, systemPrompt, finalMessage, file, history, isReasoning) {
  const opts = { reasoning: isReasoning, history, timeoutMs: CFG.aiFirstTokenTimeoutMs };
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

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   28 Â· SETUP SSE
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

function setupSSE(req, res) {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding', 'identity');
  res.flushHeaders?.();
  try { res.socket?.setNoDelay?.(true); } catch {}
  try { res.socket?.setTimeout?.(0); } catch {}

  let closed = false;
  const startedAt = Date.now();
  const controller = new AbortController();

  const onClose = (reason) => {
    if (!closed) {
      closed = true;
      controller.abort(reason);
    }
  };

  res.on('close', () => onClose('res.close'));
  res.on('error', () => onClose('res.error'));

  const send = (data) => {
    if (closed || res.writableEnded) return false;
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); return true; } catch { onClose('send.error'); return false; }
  };

  const heartbeat = setInterval(() => {
    if (closed || res.writableEnded) return;
    if (Date.now() - startedAt > CFG.sseMaxDurationMs) {
      try { res.write(`data: ${JSON.stringify({ done: true, reason: 'max_duration' })}\n\n`); } catch {}
      try { res.end(); } catch {}
      onClose('max_duration');
      clearInterval(heartbeat);
      return;
    }
    try { res.write(': keepalive\n\n'); } catch { onClose('heartbeat.error'); }
  }, CFG.sseHeartbeatMs);
  if (heartbeat.unref) heartbeat.unref();

  const close = () => {
    clearInterval(heartbeat);
    if (!closed) { try { res.end(); } catch {} closed = true; controller.abort('graceful'); }
  };

  return { send, close, isClosed: () => closed, elapsed: () => Date.now() - startedAt, signal: controller.signal };
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   29-32 Â· ADMIN (RESUMIDO PARA NO HACER EL ARCHIVO MÃS LARGO)
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

app.get('/api/admin/analytics', requireAuth, requireAdmin, async (req, res) => {
  try { return res.json(await getAnalyticsSnapshot({ days: Math.min(90, parseInt(req.query.days || '7', 10)) })); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/admin/metrics', requireAuth, requireAdmin, async (_req, res) => {
  try {
    return res.json({ ok: true, errors: getErrorMetrics(10), rateLimit: getRateLimitMetrics(10), webhooks: getWebhookStats(), tools: TOOLS.metrics(), auth: getAuthMetrics(), sse: getSSEStats(), logger: getLoggerStats(), cache: { responses: responseCache.size, memories: memCache.size } });
  } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   33 Â· CATCH-ALL + ERROR HANDLER
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

app.use(notFoundMiddleware(publicDir));
app.use(errorMiddleware({ includeStack: !IS_PROD, includeStackForLocalOnly: true }));

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   34 Â· BOOT Â· banner + server
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

let server = null;

function banner() {
  console.log(`ðŸ‡¨ðŸ‡´ NUMINATION v${VERSION} iniciado.`);
  console.log(`ðŸš€ http://localhost:${PORT}`);
}

// ðŸ‘ˆ AJUSTE VERCEL: Si estamos en Vercel, NO hacer app.listen()
const SHOULD_LISTEN = !IS_VERCEL && process.env.NODE_ENV !== 'test' && !process.env.NO_LISTEN;

if (SHOULD_LISTEN) {
  server = app.listen(PORT, () => banner());
  server.keepAliveTimeout = CFG.keepAliveTimeout;
  server.headersTimeout = CFG.headersTimeout;
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   35 Â· GRACEFUL SHUTDOWN
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

function shutdown(signal) {
  try { closeAllConnections('shutdown'); } catch (e) {}
  Promise.all([flushAnalytics().catch(() => {}), flushNotifications().catch(() => {}), flushWebhooks().catch(() => {})]).finally(() => {
    if (!server) return process.exit(0);
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), CFG.shutdownTimeout).unref?.();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
installProcessHandlers();

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   36 Â· EXPORTS (CRUCIAL PARA VERCEL)
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

export default app;

export {
  app,
  CFG,
  VERSION,
  CODENAME,
  setupSSE,
  finishSSE,
  runWebSearch,
  loadMemoryContext,
  collectStream,
};