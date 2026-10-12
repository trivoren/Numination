// ═══════════════════════════════════════════════════════════════════════════
// src/config.js
// ═══════════════════════════════════════════════════════════════════════════
// Configuración central de Numination.
//
// CARACTERÍSTICAS:
//   · Carga .env de forma segura (dotenv)
//   · Valida variables requeridas al arrancar (fail-fast)
//   · Coacciona tipos: int, float, boolean, array, json, duration, bytes
//   · Valores por defecto razonables para desarrollo
//   · Diferencia entre development / staging / production / test
//   · Feature flags centralizados
//   · Objeto congelado (Object.freeze) para evitar mutaciones
//   · Redacción automática de secretos en .dump()
//   · Helpers: isProd, isDev, isTest, hasFeature, url
//   · Validación de URLs, colores, lenguajes, puertos
//   · Secciones organizadas: server, db, ai, search, auth, cache, etc.
//   · Warnings en stderr para variables faltantes opcionales
//   · Errors con detalle para variables faltantes críticas
//   · Compatible con Vercel, Railway, Render, Fly.io, AWS, etc.
//
// USO:
//   import { CONFIG } from './config.js';
//
//   app.listen(CONFIG.server.port);
//   const key = CONFIG.ai.providers.groq.apiKey;
//   if (CONFIG.features.webSearch) { ... }
//   if (CONFIG.isProd) { ... }
//
// NUNCA hacer:
//   process.env.GROQ_API_KEY  ← usar CONFIG.ai.providers.groq.apiKey
// ═══════════════════════════════════════════════════════════════════════════

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════════════
// 01 · CONSTANTES DE ARRANQUE
// ═══════════════════════════════════════════════════════════════════════════

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = resolve(__dirname, '..');
const PUBLIC_DIR = join(ROOT_DIR, 'public');
const SRC_DIR = join(ROOT_DIR, 'src');
const LOGS_DIR = join(ROOT_DIR, 'logs');
const TMP_DIR = join(ROOT_DIR, '.tmp');
const MIGRATIONS_DIR = join(ROOT_DIR, 'migrations');
const TESTS_DIR = join(ROOT_DIR, 'tests');

const VALID_ENVS = ['development', 'staging', 'production', 'test'];
const VALID_LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
const VALID_LOG_FORMATS = ['pretty', 'json', 'compact'];

// ═══════════════════════════════════════════════════════════════════════════
// 02 · HELPERS DE PARSEO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Lee una variable de entorno. Si no existe, devuelve el default.
 */
function env(key, defaultValue = undefined) {
  const value = process.env[key];
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return value;
}

/**
 * Lee una variable requerida. Falla si no existe (sin default).
 */
function required(key, options = {}) {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (options.default !== undefined) {
      return options.default;
    }

    const err = new Error(
      `Falta la variable de entorno requerida: ${key}`
      + (options.hint ? `\n  Hint: ${options.hint}` : '')
      + `\n  Cómo arreglar: agregá ${key}=tu_valor en .env.local`
    );
    err.code = 'MISSING_ENV_VAR';
    err.varName = key;
    err.isConfigError = true;
    throw err;
  }
  return value;
}

/**
 * Igual que env pero sin tirar error. Solo advierte en consola.
 */
function optional(key, defaultValue = undefined, options = {}) {
  const value = process.env[key];
  if (value === undefined || value === '') {
    if (options.warn && defaultValue === undefined) {
      warnMissing(key, options.hint);
    }
    return defaultValue;
  }
  return value;
}

function warnMissing(key, hint) {
  if (process.env.NODE_ENV === 'test') return;
  const msg = `⚠️  Variable opcional no configurada: ${key}`
    + (hint ? ` (${hint})` : '');
  process.stderr.write(msg + '\n');
}

/**
 * Convierte un string a booleano.
 * Acepta: 'true', '1', 'yes', 'on', 'y' → true
 *         'false', '0', 'no', 'off', 'n' → false
 */
function toBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;

  const s = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on', 'si', 'sí'].includes(s)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(s)) return false;

  throw new Error(`Valor booleano inválido: "${value}"`);
}

/**
 * Convierte un string a entero.
 */
function toInt(value, defaultValue = 0, options = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;

  const n = parseInt(value, 10);
  if (isNaN(n)) {
    throw new Error(`Valor entero inválido: "${value}"`);
  }

  if (options.min !== undefined && n < options.min) {
    throw new Error(`Valor ${n} menor al mínimo permitido (${options.min})`);
  }
  if (options.max !== undefined && n > options.max) {
    throw new Error(`Valor ${n} mayor al máximo permitido (${options.max})`);
  }
  return n;
}

/**
 * Convierte un string a float.
 */
function toFloat(value, defaultValue = 0, options = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;

  const n = parseFloat(value);
  if (isNaN(n)) {
    throw new Error(`Valor decimal inválido: "${value}"`);
  }

  if (options.min !== undefined && n < options.min) {
    throw new Error(`Valor ${n} menor al mínimo permitido (${options.min})`);
  }
  if (options.max !== undefined && n > options.max) {
    throw new Error(`Valor ${n} mayor al máximo permitido (${options.max})`);
  }
  return n;
}

/**
 * Convierte un string separado por comas a array.
 */
function toArray(value, defaultValue = [], options = {}) {
  if (value === undefined || value === null || value === '') return defaultValue;

  let items;
  if (Array.isArray(value)) {
    items = value;
  } else {
    const sep = options.separator || ',';
    items = String(value).split(sep);
  }

  items = items
    .map((s) => String(s).trim())
    .filter((s) => s.length > 0);

  if (options.unique) {
    items = [...new Set(items)];
  }
  return items;
}

/**
 * Parsea JSON de una env var.
 */
function toJSON(value, defaultValue = null) {
  if (value === undefined || value === null || value === '') return defaultValue;

  try {
    return JSON.parse(value);
  } catch (e) {
    throw new Error(`JSON inválido en variable: "${String(value).slice(0, 100)}"`);
  }
}

/**
 * Convierte un string de duración a milisegundos.
 * Acepta: '500ms', '30s', '5m', '2h', '1d', o número puro (ms).
 */
function toDuration(value, defaultValue = 0) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'number') return value;

  const s = String(value).trim().toLowerCase();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/);
  if (!match) {
    throw new Error(`Duración inválida: "${value}"`);
  }

  const n = parseFloat(match[1]);
  const unit = match[2] || 'ms';

  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return Math.round(n * multipliers[unit]);
}

/**
 * Convierte un string de bytes a número.
 * Acepta: '1kb', '10mb', '1gb', o número puro.
 */
function toBytes(value, defaultValue = 0) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'number') return value;

  const s = String(value).trim().toLowerCase();
  const match = s.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/);
  if (!match) {
    throw new Error(`Tamaño de bytes inválido: "${value}"`);
  }

  const n = parseFloat(match[1]);
  const unit = match[2] || 'b';

  const multipliers = {
    b: 1,
    kb: 1024,
    mb: 1024 * 1024,
    gb: 1024 * 1024 * 1024,
    tb: 1024 * 1024 * 1024 * 1024,
  };

  return Math.round(n * multipliers[unit]);
}

/**
 * Valida que un string sea una URL válida.
 */
function toURL(value, defaultValue = null) {
  if (value === undefined || value === null || value === '') return defaultValue;

  try {
    const u = new URL(value);
    return u.toString().replace(/\/$/, ''); // sin trailing slash
  } catch (e) {
    throw new Error(`URL inválida: "${value}"`);
  }
}

/**
 * Verifica si un string tiene formato de email.
 */
function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
}

/**
 * Valida que un valor esté en una lista permitida.
 */
function toEnum(value, allowed, defaultValue) {
  const v = value === undefined || value === '' ? defaultValue : String(value);

  if (!allowed.includes(v)) {
    throw new Error(
      `Valor inválido: "${v}". Opciones válidas: ${allowed.join(', ')}`
    );
  }
  return v;
}

/**
 * Enmascara un secreto para mostrarlo en logs.
 * 'gsk_abcdefghij1234567890' → 'gsk_abcd…7890'
 */
function mask(secret, options = {}) {
  if (!secret) return '';
  const s = String(secret);
  const keepStart = options.keepStart ?? 8;
  const keepEnd = options.keepEnd ?? 4;
  const minLen = keepStart + keepEnd + 5;

  if (s.length < minLen) return '[REDACTED]';
  if (s.length <= keepStart + keepEnd) return s;

  return s.slice(0, keepStart) + '…' + s.slice(-keepEnd);
}

// ═══════════════════════════════════════════════════════════════════════════
// 03 · DETECCIÓN DE ENTORNO
// ═══════════════════════════════════════════════════════════════════════════

const NODE_ENV = toEnum(
  process.env.NODE_ENV,
  VALID_ENVS,
  'development'
);

const isDev  = NODE_ENV === 'development';
const isTest = NODE_ENV === 'test';
const isProd = NODE_ENV === 'production';
const isStaging = NODE_ENV === 'staging';

// Detectar plataforma de deploy
const PLATFORM = (() => {
  if (process.env.VERCEL) return 'vercel';
  if (process.env.RAILWAY_ENVIRONMENT) return 'railway';
  if (process.env.RENDER) return 'render';
  if (process.env.FLY_APP_NAME) return 'fly';
  if (process.env.AWS_LAMBDA_FUNCTION_NAME) return 'aws-lambda';
  if (process.env.HEROKU_APP_NAME) return 'heroku';
  if (process.env.DYNO) return 'heroku';
  if (process.env.K_SERVICE) return 'cloud-run';
  return 'local';
})();

const isServerless = ['vercel', 'aws-lambda', 'cloud-run'].includes(PLATFORM);

// ═══════════════════════════════════════════════════════════════════════════
// 04 · CONFIGURACIÓN DEL SERVIDOR
// ═══════════════════════════════════════════════════════════════════════════

const server = {
  port: toInt(env('PORT'), 8080, { min: 1, max: 65535 }),
  host: env('HOST', '0.0.0.0'),

  nodeEnv: NODE_ENV,
  platform: PLATFORM,
  isServerless,

  // URLs públicas
  publicUrl: toURL(
    env('PUBLIC_URL') || env('APP_URL') || env('VERCEL_URL'),
    isProd ? null : 'http://localhost:8080'
  ),

  // Si estamos detrás de un proxy (Cloudflare, Vercel, Nginx)
  trustProxy: toBool(env('TRUST_PROXY'), isProd || isServerless),

  // Timeouts
  timeouts: {
    requestMs: toDuration(env('REQUEST_TIMEOUT'), '30s'),
    keepAliveMs: toDuration(env('KEEP_ALIVE_TIMEOUT'), '65s'),
    headersMs: toDuration(env('HEADERS_TIMEOUT'), '66s'),
    shutdownMs: toDuration(env('SHUTDOWN_TIMEOUT'), '30s'),
  },

  // CORS
  cors: {
    enabled: toBool(env('CORS_ENABLED'), true),
    origins: toArray(
      env('CORS_ORIGINS'),
      isProd
        ? ['https://numinationchat.vercel.app']
        : ['http://localhost:8080', 'http://localhost:3000', 'http://127.0.0.1:8080'],
      { unique: true }
    ),
    credentials: toBool(env('CORS_CREDENTIALS'), true),
    methods: toArray(env('CORS_METHODS'), ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
    maxAge: toDuration(env('CORS_MAX_AGE'), '24h'),
  },

  // Body parser
  body: {
    jsonLimit: toBytes(env('BODY_JSON_LIMIT'), '2mb'),
    urlencodedLimit: toBytes(env('BODY_URLENCODED_LIMIT'), '2mb'),
    rawLimit: toBytes(env('BODY_RAW_LIMIT'), '10mb'),
  },

  // Compresión
  compression: {
    enabled: toBool(env('COMPRESSION_ENABLED'), true),
    level: toInt(env('COMPRESSION_LEVEL'), 6, { min: 1, max: 9 }),
    threshold: toBytes(env('COMPRESSION_THRESHOLD'), '1kb'),
  },

  // Health check
  healthCheck: {
    path: env('HEALTHCHECK_PATH', '/health'),
    includeDb: toBool(env('HEALTHCHECK_DB'), true),
    includeRedis: toBool(env('HEALTHCHECK_REDIS'), true),
    includeAi: toBool(env('HEALTHCHECK_AI'), false),
    timeout: toDuration(env('HEALTHCHECK_TIMEOUT'), '5s'),
  },

  // Static files
  static: {
    dir: PUBLIC_DIR,
    maxAgeMs: toDuration(env('STATIC_MAX_AGE'), '1h'),
    etag: toBool(env('STATIC_ETAG'), true),
    index: toArray(env('STATIC_INDEX'), ['index.html', 'chat.html']),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 05 · BASE DE DATOS (Supabase / PostgreSQL)
// ═══════════════════════════════════════════════════════════════════════════

const db = {
  provider: 'supabase',

  supabase: {
    url: required('SUPABASE_URL', {
      hint: 'Lo encontrás en Supabase → Settings → API → Project URL',
    }),

    anonKey: required('SUPABASE_ANON_KEY', {
      hint: 'Supabase → Settings → API → anon public',
    }),

    serviceKey: required('SUPABASE_SERVICE_KEY', {
      hint: 'Supabase → Settings → API → service_role secret. ¡NO compartir!',
      // En dev puede no ser crítico
      default: isDev ? env('SUPABASE_ANON_KEY') : undefined,
    }),

    // JWT secret para verificar tokens sin llamar a Supabase
    jwtSecret: optional('SUPABASE_JWT_SECRET', null),

    // Pool de conexiones
    pool: {
      max: toInt(env('DB_POOL_MAX'), isServerless ? 3 : 10, { min: 1, max: 100 }),
      min: toInt(env('DB_POOL_MIN'), 0, { min: 0, max: 50 }),
      idleTimeoutMs: toDuration(env('DB_IDLE_TIMEOUT'), '30s'),
      connectionTimeoutMs: toDuration(env('DB_CONNECT_TIMEOUT'), '10s'),
    },

    // Opciones del cliente
    options: {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      db: {
        schema: env('DB_SCHEMA', 'public'),
      },
      global: {
        headers: {
          'x-application-name': 'numination',
        },
      },
    },
  },

  // Tablas conocidas (evita typos)
  tables: {
    users: 'users',
    chats: 'chats',
    messages: 'messages',
    memories: 'memories',
    projects: 'projects',
    artifacts: 'artifacts',
    connectors: 'connectors',
    attachments: 'attachments',
    subscriptions: 'subscriptions',
    usage: 'usage_logs',
    audit: 'audit_logs',
  },

  // Storage buckets
  storage: {
    bucketAvatars: env('STORAGE_BUCKET_AVATARS', 'avatars'),
    bucketAttachments: env('STORAGE_BUCKET_ATTACHMENTS', 'attachments'),
    bucketBackups: env('STORAGE_BUCKET_BACKUPS', 'backups'),
    signedUrlExpiry: toDuration(env('STORAGE_SIGNED_URL_EXPIRY'), '1h'),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 06 · PROVEEDORES DE IA
// ═══════════════════════════════════════════════════════════════════════════

const ai = {
  // Orden de fallback: si Groq falla, prueba Gemini, después Kimi
  fallbackChain: toArray(
    env('AI_FALLBACK_CHAIN'),
    ['groq', 'gemini', 'kimi'],
    { unique: true }
  ),

  // Timeouts globales
  timeouts: {
    firstTokenMs: toDuration(env('AI_FIRST_TOKEN_TIMEOUT'), '25s'),
    fullResponseMs: toDuration(env('AI_FULL_RESPONSE_TIMEOUT'), '120s'),
    connectionMs: toDuration(env('AI_CONNECT_TIMEOUT'), '10s'),
  },

  // Reintentos
  retry: {
    maxAttempts: toInt(env('AI_MAX_RETRIES'), 2, { min: 0, max: 5 }),
    backoffMs: toDuration(env('AI_RETRY_BACKOFF'), '1s'),
    backoffMultiplier: toFloat(env('AI_RETRY_MULTIPLIER'), 2.0),
    retryOn: toArray(env('AI_RETRY_ON'), ['timeout', 'rate_limit', 'network', '5xx']),
  },

  // Límites de tokens
  tokens: {
    maxInput: toInt(env('AI_MAX_INPUT_TOKENS'), 32000),
    maxOutput: toInt(env('AI_MAX_OUTPUT_TOKENS'), 4096),
    historyMax: toInt(env('AI_HISTORY_MAX_MESSAGES'), 12),
  },

  // Temperatura por modo
  temperature: {
    default: toFloat(env('AI_TEMP_DEFAULT'), 0.7, { min: 0, max: 2 }),
    coder: toFloat(env('AI_TEMP_CODER'), 0.3, { min: 0, max: 2 }),
    reasoning: toFloat(env('AI_TEMP_REASONING'), 0.5, { min: 0, max: 2 }),
    creative: toFloat(env('AI_TEMP_CREATIVE'), 0.9, { min: 0, max: 2 }),
  },

  // Proveedores individuales
  providers: {
    groq: {
      enabled: toBool(env('GROQ_ENABLED'), true),
      name: 'Groq',
      apiKey: optional('GROQ_API_KEY', null),
      baseUrl: env('GROQ_BASE_URL', 'https://api.groq.com/openai/v1'),
      model: env('GROQ_MODEL', 'llama-3.3-70b-versatile'),
      modelFallbacks: toArray(env('GROQ_MODEL_FALLBACKS'), [
        'llama-3.3-70b-versatile',
        'llama-3.1-70b-versatile',
        'mixtral-8x7b-32768',
      ]),
      priority: 1,
      costPerMillionInputTokens: toFloat(env('GROQ_COST_INPUT'), 0.59),
      costPerMillionOutputTokens: toFloat(env('GROQ_COST_OUTPUT'), 0.79),
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsFunctionCalling: true,
      maxContextTokens: 131072,
    },

    gemini: {
      enabled: toBool(env('GEMINI_ENABLED'), true),
      name: 'Google Gemini',
      apiKey: optional('GEMINI_API_KEY', null),
      baseUrl: env('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta'),
      model: env('GEMINI_MODEL', 'gemini-2.0-flash-exp'),
      modelFallbacks: toArray(env('GEMINI_MODEL_FALLBACKS'), [
        'gemini-2.0-flash-exp',
        'gemini-1.5-flash',
        'gemini-1.5-pro',
      ]),
      priority: 2,
      costPerMillionInputTokens: toFloat(env('GEMINI_COST_INPUT'), 0.075),
      costPerMillionOutputTokens: toFloat(env('GEMINI_COST_OUTPUT'), 0.30),
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsFunctionCalling: true,
      supportsVision: true,
      maxContextTokens: 1000000,
    },

    kimi: {
      enabled: toBool(env('KIMI_ENABLED'), true),
      name: 'Moonshot Kimi',
      apiKey: optional('KIMI_API_KEY', null),
      baseUrl: env('KIMI_BASE_URL', 'https://api.moonshot.cn/v1'),
      model: env('KIMI_MODEL', 'moonshot-v1-32k'),
      modelFallbacks: toArray(env('KIMI_MODEL_FALLBACKS'), [
        'moonshot-v1-32k',
        'moonshot-v1-128k',
      ]),
      priority: 3,
      costPerMillionInputTokens: toFloat(env('KIMI_COST_INPUT'), 0.50),
      costPerMillionOutputTokens: toFloat(env('KIMI_COST_OUTPUT'), 0.50),
      supportsStreaming: true,
      supportsJsonMode: true,
      supportsFunctionCalling: true,
      maxContextTokens: 128000,
    },

    // Proveedores auxiliares
    pollinations: {
      enabled: toBool(env('POLLINATIONS_ENABLED'), true),
      baseUrl: env('POLLINATIONS_BASE_URL', 'https://image.pollinations.ai'),
      model: env('POLLINATIONS_MODEL', 'flux'),
      apiKey: optional('POLLINATIONS_KEY', null),
    },

    openrouter: {
      enabled: toBool(env('OPENROUTER_ENABLED'), false),
      apiKey: optional('OPENROUTER_API_KEY', null),
      baseUrl: env('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
      model: env('OPENROUTER_MODEL', 'anthropic/claude-3.5-sonnet'),
    },

    ollama: {
      enabled: toBool(env('OLLAMA_ENABLED'), false),
      baseUrl: env('OLLAMA_BASE_URL', 'http://localhost:11434'),
      model: env('OLLAMA_MODEL', 'llama3.2'),
    },
  },

  // Sistema de prompts
  prompts: {
    version: env('PROMPT_VERSION', 'v2'),
    abTest: {
      enabled: toBool(env('PROMPT_AB_TEST'), false),
      variants: toArray(env('PROMPT_VARIANTS'), ['a', 'b']),
    },
  },

  // Modo incógnito
  incognito: {
    enabled: toBool(env('INCOGNITO_ENABLED'), true),
    // Después de X tiempo, borrar los chats incógnitos que quedaron colgados
    cleanupAfter: toDuration(env('INCOGNITO_CLEANUP_AFTER'), '24h'),
  },

  // Imágenes
  images: {
    enabled: toBool(env('IMAGES_ENABLED'), true),
    defaultSize: env('IMAGES_DEFAULT_SIZE', '1024x1024'),
    allowedSizes: toArray(env('IMAGES_ALLOWED_SIZES'), [
      '512x512',
      '768x768',
      '1024x1024',
      '1024x1792',
      '1792x1024',
    ]),
    maxPromptLength: toInt(env('IMAGES_MAX_PROMPT_LENGTH'), 500),
    cacheEnabled: toBool(env('IMAGES_CACHE'), true),
    cacheTTL: toDuration(env('IMAGES_CACHE_TTL'), '7d'),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 07 · BÚSQUEDA WEB
// ═══════════════════════════════════════════════════════════════════════════

const search = {
  enabled: toBool(env('WEBSEARCH_ENABLED'), true),

  // Proveedores disponibles
  providers: {
    wikipedia: {
      enabled: toBool(env('WIKIPEDIA_ENABLED'), true),
      baseUrl: env('WIKIPEDIA_BASE_URL', 'https://es.wikipedia.org/api/rest_v1'),
      language: env('WIKIPEDIA_LANGUAGE', 'es'),
      timeout: toDuration(env('WIKIPEDIA_TIMEOUT'), '6s'),
      priority: 1,
    },

    duckduckgo: {
      enabled: toBool(env('DDG_ENABLED'), true),
      baseUrl: env('DDG_BASE_URL', 'https://api.duckduckgo.com'),
      timeout: toDuration(env('DDG_TIMEOUT'), '6s'),
      priority: 2,
    },

    brave: {
      enabled: toBool(env('BRAVE_ENABLED'), false),
      apiKey: optional('BRAVE_SEARCH_KEY', null),
      baseUrl: env('BRAVE_BASE_URL', 'https://api.search.brave.com/res/v1'),
      timeout: toDuration(env('BRAVE_TIMEOUT'), '6s'),
      priority: 3,
    },
  },

  // Parámetros de búsqueda
  maxResults: toInt(env('WEBSEARCH_MAX_RESULTS'), 5, { min: 1, max: 20 }),
  fetchTimeout: toDuration(env('WEBSEARCH_FETCH_TIMEOUT'), '8s'),
  maxContentBytes: toBytes(env('WEBSEARCH_MAX_CONTENT'), '200kb'),

  // Cache
  cache: {
    enabled: toBool(env('WEBSEARCH_CACHE'), true),
    ttl: toDuration(env('WEBSEARCH_CACHE_TTL'), '1h'),
  },

  // Filtros
  blockedDomains: toArray(env('WEBSEARCH_BLOCKED_DOMAINS'), [
    'pinterest.com',
    'quora.com',
  ]),
  trustedDomains: toArray(env('WEBSEARCH_TRUSTED_DOMAINS'), [
    'wikipedia.org',
    'github.com',
    'stackoverflow.com',
    'developer.mozilla.org',
  ]),
};

// ═══════════════════════════════════════════════════════════════════════════
// 08 · AUTENTICACIÓN
// ═══════════════════════════════════════════════════════════════════════════

const auth = {
  session: {
    cookieName: env('SESSION_COOKIE', 'nm-session'),
    secret: required('SESSION_SECRET', {
      hint: 'Generá uno con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
      default: isDev ? crypto.randomBytes(32).toString('hex') : undefined,
    }),
    maxAge: toDuration(env('SESSION_MAX_AGE'), '30d'),
    secure: toBool(env('SESSION_SECURE'), isProd),
    sameSite: toEnum(env('SESSION_SAME_SITE'), ['lax', 'strict', 'none'], 'lax'),
    httpOnly: toBool(env('SESSION_HTTP_ONLY'), true),
    domain: optional('SESSION_DOMAIN', null),
  },

  // OAuth
  oauth: {
    google: {
      enabled: toBool(env('GOOGLE_OAUTH_ENABLED'), true),
      clientId: optional('GOOGLE_CLIENT_ID', null),
      clientSecret: optional('GOOGLE_CLIENT_SECRET', null),
      callbackUrl: env('GOOGLE_CALLBACK_URL', '/api/auth/google/callback'),
      scopes: toArray(env('GOOGLE_SCOPES'), ['openid', 'email', 'profile']),
    },

    github: {
      enabled: toBool(env('GITHUB_OAUTH_ENABLED'), true),
      clientId: optional('GITHUB_CLIENT_ID', null),
      clientSecret: optional('GITHUB_CLIENT_SECRET', null),
      callbackUrl: env('GITHUB_CALLBACK_URL', '/api/auth/github/callback'),
      scopes: toArray(env('GITHUB_SCOPES'), ['read:user', 'user:email']),
    },
  },

  // Validaciones
  password: {
    minLength: toInt(env('PASSWORD_MIN_LENGTH'), 8),
    requireUppercase: toBool(env('PASSWORD_REQUIRE_UPPER'), false),
    requireNumber: toBool(env('PASSWORD_REQUIRE_NUMBER'), true),
    requireSymbol: toBool(env('PASSWORD_REQUIRE_SYMBOL'), false),
  },

  // Verificación de email
  emailVerification: {
    required: toBool(env('EMAIL_VERIFICATION_REQUIRED'), false),
    tokenTTL: toDuration(env('EMAIL_VERIFY_TTL'), '24h'),
    maxResends: toInt(env('EMAIL_VERIFY_MAX_RESENDS'), 5),
  },

  // 2FA
  twoFactor: {
    enabled: toBool(env('TWO_FACTOR_ENABLED'), false),
    issuer: env('TWO_FACTOR_ISSUER', 'Numination'),
    window: toInt(env('TWO_FACTOR_WINDOW'), 1),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 09 · LÍMITES Y CUOTAS
// ═══════════════════════════════════════════════════════════════════════════

const limits = {
  // Planes
  plans: {
    free: {
      name: 'Free',
      price: 0,
      currency: 'COP',
      messagesPerDay: toInt(env('FREE_MESSAGES_PER_DAY'), 50),
      messagesPerMinute: toInt(env('FREE_MESSAGES_PER_MINUTE'), 5),
      maxChats: toInt(env('FREE_MAX_CHATS'), 100),
      maxMemories: toInt(env('FREE_MAX_MEMORIES'), 20),
      maxProjects: toInt(env('FREE_MAX_PROJECTS'), 5),
      maxAttachments: toInt(env('FREE_MAX_ATTACHMENTS'), 10),
      maxAttachmentSizeBytes: toBytes(env('FREE_MAX_ATTACHMENT_SIZE'), '5mb'),
      webSearchEnabled: toBool(env('FREE_WEB_SEARCH'), true),
      imagesEnabled: toBool(env('FREE_IMAGES'), true),
      imagesPerDay: toInt(env('FREE_IMAGES_PER_DAY'), 5),
      priority: 0,
    },

    pro: {
      name: 'Pro',
      price: toInt(env('PRO_PRICE_COP'), 19900),
      currency: 'COP',
      messagesPerDay: toInt(env('PRO_MESSAGES_PER_DAY'), 500),
      messagesPerMinute: toInt(env('PRO_MESSAGES_PER_MINUTE'), 20),
      maxChats: toInt(env('PRO_MAX_CHATS'), -1), // -1 = ilimitado
      maxMemories: toInt(env('PRO_MAX_MEMORIES'), 500),
      maxProjects: toInt(env('PRO_MAX_PROJECTS'), 50),
      maxAttachments: toInt(env('PRO_MAX_ATTACHMENTS'), 200),
      maxAttachmentSizeBytes: toBytes(env('PRO_MAX_ATTACHMENT_SIZE'), '25mb'),
      webSearchEnabled: true,
      imagesEnabled: true,
      imagesPerDay: toInt(env('PRO_IMAGES_PER_DAY'), 100),
      priority: 1,
    },

    team: {
      name: 'Team',
      price: toInt(env('TEAM_PRICE_COP'), 49900),
      currency: 'COP',
      messagesPerDay: toInt(env('TEAM_MESSAGES_PER_DAY'), 2000),
      messagesPerMinute: toInt(env('TEAM_MESSAGES_PER_MINUTE'), 50),
      maxChats: -1,
      maxMemories: -1,
      maxProjects: -1,
      maxAttachments: -1,
      maxAttachmentSizeBytes: toBytes(env('TEAM_MAX_ATTACHMENT_SIZE'), '50mb'),
      webSearchEnabled: true,
      imagesEnabled: true,
      imagesPerDay: toInt(env('TEAM_IMAGES_PER_DAY'), 500),
      seats: toInt(env('TEAM_SEATS'), 5),
      priority: 2,
    },
  },

  // Cuotas globales (protección contra abuse)
  global: {
    maxRequestsPerSecond: toInt(env('GLOBAL_MAX_RPS'), 100),
    maxRequestsPerMinute: toInt(env('GLOBAL_MAX_RPM'), 3000),
    maxConcurrentStreams: toInt(env('GLOBAL_MAX_STREAMS'), 200),
    maxConcurrentPerUser: toInt(env('USER_MAX_STREAMS'), 3),
  },

  // Rate limiting
  rateLimit: {
    enabled: toBool(env('RATE_LIMIT_ENABLED'), true),
    windowMs: toDuration(env('RATE_LIMIT_WINDOW'), '1m'),
    skipSuccessfulRequests: toBool(env('RATE_LIMIT_SKIP_SUCCESS'), false),
    skipFailedRequests: toBool(env('RATE_LIMIT_SKIP_FAILED'), false),
  },

  // Bloqueos
  blocks: {
    // Si el usuario pasa el límite, cuánto tiempo se le bloquea
    cooldownAfterLimit: toDuration(env('COOLDOWN_AFTER_LIMIT'), '10m'),
    // Después de N strikes, ban temporal
    strikesBeforeBan: toInt(env('STRIKES_BEFORE_BAN'), 5),
    banDuration: toDuration(env('BAN_DURATION'), '1h'),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 10 · CACHE (Upstash Redis / en memoria)
// ═══════════════════════════════════════════════════════════════════════════

const cache = {
  enabled: toBool(env('CACHE_ENABLED'), true),

  driver: toEnum(
    env('CACHE_DRIVER'),
    ['memory', 'upstash', 'redis'],
    isProd ? 'upstash' : 'memory'
  ),

  // Upstash (recomendado para serverless)
  upstash: {
    url: optional('UPSTASH_REDIS_URL', null),
    token: optional('UPSTASH_REDIS_TOKEN', null),
  },

  // Redis clásico
  redis: {
    url: optional('REDIS_URL', null),
    host: optional('REDIS_HOST', null),
    port: toInt(env('REDIS_PORT'), 6379),
    password: optional('REDIS_PASSWORD', null),
    db: toInt(env('REDIS_DB'), 0),
  },

  // TTLs por tipo de dato
  ttl: {
    sessions: toDuration(env('CACHE_TTL_SESSIONS'), '1h'),
    userProfile: toDuration(env('CACHE_TTL_USER'), '5m'),
    chatList: toDuration(env('CACHE_TTL_CHAT_LIST'), '30s'),
    chatMessages: toDuration(env('CACHE_TTL_MESSAGES'), '2m'),
    memories: toDuration(env('CACHE_TTL_MEMORIES'), '5m'),
    aiResponses: toDuration(env('CACHE_TTL_AI'), '1h'),
    webSearch: toDuration(env('CACHE_TTL_SEARCH'), '1h'),
    images: toDuration(env('CACHE_TTL_IMAGES'), '7d'),
    limits: toDuration(env('CACHE_TTL_LIMITS'), '1m'),
    rateLimit: toDuration(env('CACHE_TTL_RATE'), '1m'),
  },

  // Prefix para evitar colisiones
  prefix: env('CACHE_PREFIX', 'nm:'),

  // Stats
  trackHits: toBool(env('CACHE_TRACK_HITS'), true),
};

// ═══════════════════════════════════════════════════════════════════════════
// 11 · ARCHIVOS Y SUBIDAS
// ═══════════════════════════════════════════════════════════════════════════

const uploads = {
  enabled: toBool(env('UPLOADS_ENABLED'), true),

  maxSize: toBytes(env('UPLOAD_MAX_SIZE'), '10mb'),
  maxFilesPerRequest: toInt(env('UPLOAD_MAX_FILES'), 5),

  allowedTypes: toArray(env('UPLOAD_ALLOWED_TYPES'), [
    'text/plain',
    'text/markdown',
    'text/csv',
    'application/json',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/svg+xml',
  ]),

  allowedExtensions: toArray(env('UPLOAD_ALLOWED_EXTENSIONS'), [
    '.txt', '.md', '.csv', '.json', '.pdf',
    '.doc', '.docx',
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg',
    '.js', '.ts', '.jsx', '.tsx',
    '.py', '.rb', '.go', '.rs',
    '.html', '.css', '.scss',
    '.yaml', '.yml', '.toml', '.xml',
    '.sh', '.sql',
  ]),

  // Extracción de texto
  extractText: {
    enabled: toBool(env('UPLOAD_EXTRACT_TEXT'), true),
    maxExtractedChars: toInt(env('UPLOAD_MAX_EXTRACTED_CHARS'), 50000),
    pdfEnabled: toBool(env('UPLOAD_PDF_ENABLED'), true),
    docxEnabled: toBool(env('UPLOAD_DOCX_ENABLED'), true),
  },

  // OCR de imágenes
  ocr: {
    enabled: toBool(env('UPLOAD_OCR_ENABLED'), false),
    provider: toEnum(env('UPLOAD_OCR_PROVIDER'), ['tesseract', 'google', 'openai'], 'tesseract'),
  },

  // Antivirus / sandbox
  safety: {
    scanVirus: toBool(env('UPLOAD_SCAN_VIRUS'), false),
    scanProvider: env('UPLOAD_SCAN_PROVIDER', 'clamav'),
    quarantineSuspicious: toBool(env('UPLOAD_QUARANTINE'), true),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 12 · EMAIL
// ═══════════════════════════════════════════════════════════════════════════

const email = {
  enabled: toBool(env('EMAIL_ENABLED'), isProd),

  from: {
    name: env('EMAIL_FROM_NAME', 'Numination'),
    address: env('EMAIL_FROM_ADDRESS', 'noreply@numination.com'),
  },

  replyTo: env('EMAIL_REPLY_TO', 'trivorensupport@gmail.com'),

  // Proveedor
  provider: toEnum(
    env('EMAIL_PROVIDER'),
    ['resend', 'sendgrid', 'smtp', 'console'],
    isProd ? 'resend' : 'console'
  ),

  resend: {
    apiKey: optional('RESEND_API_KEY', null),
  },

  sendgrid: {
    apiKey: optional('SENDGRID_API_KEY', null),
  },

  smtp: {
    host: optional('SMTP_HOST', null),
    port: toInt(env('SMTP_PORT'), 587),
    secure: toBool(env('SMTP_SECURE'), false),
    user: optional('SMTP_USER', null),
    password: optional('SMTP_PASSWORD', null),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 13 · PAGOS
// ═══════════════════════════════════════════════════════════════════════════

const payments = {
  enabled: toBool(env('PAYMENTS_ENABLED'), false),

  currency: env('PAYMENTS_CURRENCY', 'COP'),
  country: env('PAYMENTS_COUNTRY', 'CO'),

  stripe: {
    enabled: toBool(env('STRIPE_ENABLED'), false),
    publicKey: optional('STRIPE_PUBLIC_KEY', null),
    secretKey: optional('STRIPE_SECRET_KEY', null),
    webhookSecret: optional('STRIPE_WEBHOOK_SECRET', null),
    successUrl: env('STRIPE_SUCCESS_URL', '/success'),
    cancelUrl: env('STRIPE_CANCEL_URL', '/pricing'),
  },

  mercadoPago: {
    enabled: toBool(env('MERCADOPAGO_ENABLED'), false),
    publicKey: optional('MP_PUBLIC_KEY', null),
    accessToken: optional('MP_ACCESS_TOKEN', null),
    webhookSecret: optional('MP_WEBHOOK_SECRET', null),
  },

  payu: {
    enabled: toBool(env('PAYU_ENABLED'), false),
    apiKey: optional('PAYU_API_KEY', null),
    merchantId: optional('PAYU_MERCHANT_ID', null),
    accountId: optional('PAYU_ACCOUNT_ID', null),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 14 · WEBHOOKS
// ═══════════════════════════════════════════════════════════════════════════

const webhooks = {
  enabled: toBool(env('WEBHOOKS_ENABLED'), true),

  secret: optional('WEBHOOK_SECRET', crypto.randomBytes(32).toString('hex')),

  timeout: toDuration(env('WEBHOOK_TIMEOUT'), '10s'),
  maxRetries: toInt(env('WEBHOOK_MAX_RETRIES'), 3),
  retryBackoffMs: toDuration(env('WEBHOOK_RETRY_BACKOFF'), '5s'),

  endpoints: toJSON(env('WEBHOOK_ENDPOINTS'), {
    // Ejemplo:
    // new_user: 'https://hooks.example.com/new-user',
    // subscription_created: 'https://hooks.example.com/sub',
  }),

  // Eventos que se pueden disparar
  events: {
    userCreated: 'user.created',
    userDeleted: 'user.deleted',
    subscriptionCreated: 'subscription.created',
    subscriptionCancelled: 'subscription.cancelled',
    subscriptionRenewed: 'subscription.renewed',
    limitReached: 'limit.reached',
    errorOccurred: 'error.occurred',
    dailySummary: 'daily.summary',
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 15 · ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════

const analytics = {
  enabled: toBool(env('ANALYTICS_ENABLED'), isProd),

  provider: toEnum(
    env('ANALYTICS_PROVIDER'),
    ['posthog', 'plausible', 'ga4', 'umami', 'custom', 'none'],
    'custom'
  ),

  posthog: {
    apiKey: optional('POSTHOG_API_KEY', null),
    host: env('POSTHOG_HOST', 'https://us.i.posthog.com'),
  },

  plausible: {
    domain: optional('PLAUSIBLE_DOMAIN', null),
    apiKey: optional('PLAUSIBLE_API_KEY', null),
  },

  ga4: {
    measurementId: optional('GA4_MEASUREMENT_ID', null),
    apiSecret: optional('GA4_API_SECRET', null),
  },

  // Custom events
  custom: {
    batchSize: toInt(env('ANALYTICS_BATCH_SIZE'), 50),
    flushIntervalMs: toDuration(env('ANALYTICS_FLUSH_INTERVAL'), '10s'),
    retentionDays: toInt(env('ANALYTICS_RETENTION_DAYS'), 90),
  },

  // Sampling (loggear solo X% de eventos)
  sampling: {
    enabled: toBool(env('ANALYTICS_SAMPLING'), false),
    rate: toFloat(env('ANALYTICS_SAMPLE_RATE'), 1.0, { min: 0, max: 1 }),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 16 · LOGGING
// ═══════════════════════════════════════════════════════════════════════════

const logging = {
  level: toEnum(env('LOG_LEVEL'), VALID_LOG_LEVELS, isDev ? 'debug' : 'info'),
  format: toEnum(env('LOG_FORMAT'), VALID_LOG_FORMATS, isProd ? 'json' : 'pretty'),
  timestamp: toEnum(env('LOG_TIMESTAMP'), ['iso', 'time', 'epoch'], isProd ? 'iso' : 'time'),

  silent: toBool(env('LOG_SILENT'), isTest),
  redact: toBool(env('LOG_REDACT'), true),

  colors: toBool(env('LOG_COLORS'), !isProd && process.stdout?.isTTY === true),

  // Archivos
  file: {
    enabled: toBool(env('LOG_FILE'), false),
    dir: env('LOG_DIR', LOGS_DIR),
    maxSizeMb: toInt(env('LOG_MAX_SIZE_MB'), 10),
    maxFiles: toInt(env('LOG_MAX_FILES'), 7),
    compress: toBool(env('LOG_COMPRESS'), false),
  },

  // Deduplicación
  dedupe: {
    enabled: toBool(env('LOG_DEDUPE'), true),
    windowMs: toDuration(env('LOG_DEDUPE_WINDOW'), '3s'),
    threshold: toInt(env('LOG_DEDUPE_THRESHOLD'), 3),
  },

  // Sampling
  sampling: {
    debug: toInt(env('LOG_SAMPLE_DEBUG'), 1),
    trace: toInt(env('LOG_SAMPLE_TRACE'), 1),
  },

  // Slow operation warnings
  slowMs: {
    warn: toDuration(env('LOG_SLOW_WARN'), '1s'),
    error: toDuration(env('LOG_SLOW_ERROR'), '5s'),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 17 · SEGURIDAD
// ═══════════════════════════════════════════════════════════════════════════

const security = {
  // Headers de seguridad (Helmet)
  helmet: {
    enabled: toBool(env('HELMET_ENABLED'), true),
    contentSecurityPolicy: toBool(env('CSP_ENABLED'), isProd),
    crossOriginEmbedderPolicy: toBool(env('COEP_ENABLED'), false),
    crossOriginResourcePolicy: toBool(env('CORP_ENABLED'), true),
    crossOriginOpenerPolicy: toBool(env('COOP_ENABLED'), true),
    frameguard: toBool(env('FRAMEGUARD_ENABLED'), true),
    hsts: toBool(env('HSTS_ENABLED'), isProd),
    noSniff: true,
    referrerPolicy: env('REFERRER_POLICY', 'strict-origin-when-cross-origin'),
  },

  // JWT
  jwt: {
    algorithm: env('JWT_ALGORITHM', 'HS256'),
    expiresIn: toDuration(env('JWT_EXPIRES_IN'), '7d'),
    issuer: env('JWT_ISSUER', 'numination'),
    audience: env('JWT_AUDIENCE', 'numination-users'),
  },

  // Encriptación
  encryption: {
    algorithm: env('ENCRYPTION_ALGORITHM', 'aes-256-gcm'),
    key: optional('ENCRYPTION_KEY', isDev ? crypto.randomBytes(32).toString('hex') : null),
  },

  // CSRF
  csrf: {
    enabled: toBool(env('CSRF_ENABLED'), isProd),
    cookieName: env('CSRF_COOKIE', 'nm-csrf'),
    headerName: env('CSRF_HEADER', 'x-csrf-token'),
  },

  // Sanitización
  sanitize: {
    enabled: toBool(env('SANITIZE_ENABLED'), true),
    stripHtml: toBool(env('SANITIZE_STRIP_HTML'), true),
    escapeHtml: toBool(env('SANITIZE_ESCAPE_HTML'), false),
  },

  // Bloqueo por IP
  ipBlocking: {
    enabled: toBool(env('IP_BLOCKING_ENABLED'), true),
    blocklist: toArray(env('IP_BLOCKLIST'), []),
    allowlist: toArray(env('IP_ALLOWLIST'), []),
    // Detrás de Cloudflare
    trustedProxies: toArray(env('TRUSTED_PROXIES'), [
      'cloudflare',
      'vercel',
      'loopback',
    ]),
  },

  // Detección de abuso
  abuseDetection: {
    enabled: toBool(env('ABUSE_DETECTION'), isProd),
    maxFailedLogins: toInt(env('MAX_FAILED_LOGINS'), 5),
    lockoutDuration: toDuration(env('LOCKOUT_DURATION'), '15m'),
    suspiciousUserAgents: toArray(env('SUSPICIOUS_UAS'), [
      'curl', 'wget', 'python-requests', 'scrapy', 'bot', 'crawler', 'spider',
    ]),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 18 · FEATURE FLAGS
// ═══════════════════════════════════════════════════════════════════════════

const features = {
  // Core
  chat: toBool(env('FEATURE_CHAT'), true),
  webSearch: toBool(env('FEATURE_WEB_SEARCH'), true),
  images: toBool(env('FEATURE_IMAGES'), true),
  voice: toBool(env('FEATURE_VOICE'), true),
  codePreview: toBool(env('FEATURE_CODE_PREVIEW'), true),
  reasoning: toBool(env('FEATURE_REASONING'), true),
  incognito: toBool(env('FEATURE_INCOGNITO'), true),

  // Intermedio
  projects: toBool(env('FEATURE_PROJECTS'), true),
  artifacts: toBool(env('FEATURE_ARTIFACTS'), true),
  attachments: toBool(env('FEATURE_ATTACHMENTS'), true),
  connectors: toBool(env('FEATURE_CONNECTORS'), false),
  memories: toBool(env('FEATURE_MEMORIES'), true),

  // Avanzado
  multiModel: toBool(env('FEATURE_MULTI_MODEL'), true),
  functionCalling: toBool(env('FEATURE_FUNCTION_CALLING'), false),
  longTermMemory: toBool(env('FEATURE_LONG_TERM_MEMORY'), false),
  semanticSearch: toBool(env('FEATURE_SEMANTIC_SEARCH'), false),
  agents: toBool(env('FEATURE_AGENTS'), false),

  // Monetización
  payments: toBool(env('FEATURE_PAYMENTS'), false),
  premiumModels: toBool(env('FEATURE_PREMIUM_MODELS'), false),
  subscriptions: toBool(env('FEATURE_SUBSCRIPTIONS'), false),

  // UI
  admin: toBool(env('FEATURE_ADMIN'), true),
  darkMode: toBool(env('FEATURE_DARK_MODE'), true),
  customThemes: toBool(env('FEATURE_CUSTOM_THEMES'), false),
  onboarding: toBool(env('FEATURE_ONBOARDING'), true),

  // Experimental
  experimentalUI: toBool(env('FEATURE_EXPERIMENTAL_UI'), false),
  betaFeatures: toBool(env('FEATURE_BETA'), isDev),
  debugMode: toBool(env('FEATURE_DEBUG_MODE'), isDev),
};

// ═══════════════════════════════════════════════════════════════════════════
// 19 · LÍMITES DE COSTO
// ═══════════════════════════════════════════════════════════════════════════

const costs = {
  // Presupuesto global por mes (en USD)
  monthlyBudgetUsd: toFloat(env('MONTHLY_BUDGET_USD'), 100),

  // Alertas
  alerts: {
    at50Percent: toBool(env('COST_ALERT_50'), true),
    at80Percent: toBool(env('COST_ALERT_80'), true),
    at100Percent: toBool(env('COST_ALERT_100'), true),
    email: env('COST_ALERT_EMAIL', 'trivorensupport@gmail.com'),
  },

  // Comportamiento al llegar al límite
  onBudgetExceeded: toEnum(
    env('COST_ON_EXCEEDED'),
    ['warn', 'throttle', 'block_free', 'block_all'],
    'warn'
  ),

  // Umbrales por usuario (para detectar abuso)
  perUser: {
    dailyUsdLimit: toFloat(env('USER_DAILY_USD_LIMIT'), 1.0),
    monthlyUsdLimit: toFloat(env('USER_MONTHLY_USD_LIMIT'), 15.0),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 20 · INTEGRACIONES EXTERNAS
// ═══════════════════════════════════════════════════════════════════════════

const integrations = {
  // ElevenLabs (TTS de alta calidad)
  elevenlabs: {
    enabled: toBool(env('ELEVENLABS_ENABLED'), false),
    apiKey: optional('ELEVENLABS_API_KEY', null),
    voiceId: env('ELEVENLABS_VOICE_ID', 'pNInz6obpgDQGcFmaJgB'),
    model: env('ELEVENLABS_MODEL', 'eleven_multilingual_v2'),
  },

  // OpenAI (Whisper para STT, embeddings)
  openai: {
    enabled: toBool(env('OPENAI_ENABLED'), false),
    apiKey: optional('OPENAI_API_KEY', null),
    whisperModel: env('OPENAI_WHISPER_MODEL', 'whisper-1'),
    embeddingModel: env('OPENAI_EMBEDDING_MODEL', 'text-embedding-3-small'),
  },

  // SendGrid / Resend ya cubiertos en email

  // Cloudflare
  cloudflare: {
    enabled: toBool(env('CLOUDFLARE_ENABLED'), false),
    apiToken: optional('CLOUDFLARE_API_TOKEN', null),
    zoneId: optional('CLOUDFLARE_ZONE_ID', null),
  },

  // Sentry (error tracking)
  sentry: {
    enabled: toBool(env('SENTRY_ENABLED'), isProd),
    dsn: optional('SENTRY_DSN', null),
    environment: NODE_ENV,
    tracesSampleRate: toFloat(env('SENTRY_TRACES_RATE'), isProd ? 0.1 : 1.0),
  },

  // Google Analytics 4 (ya en analytics)

  // IPInfo (geo lookup)
  ipinfo: {
    enabled: toBool(env('IPINFO_ENABLED'), false),
    apiKey: optional('IPINFO_API_KEY', null),
  },

  // Weather (para conectores)
  openweather: {
    enabled: toBool(env('OPENWEATHER_ENABLED'), false),
    apiKey: optional('OPENWEATHER_API_KEY', null),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 21 · WORKERS / JOBS
// ═══════════════════════════════════════════════════════════════════════════

const workers = {
  enabled: toBool(env('WORKERS_ENABLED'), !isServerless),

  // Cleanup jobs
  cleanup: {
    enabled: toBool(env('CLEANUP_ENABLED'), true),
    intervalMs: toDuration(env('CLEANUP_INTERVAL'), '1h'),
    incognitoAfter: toDuration(env('CLEANUP_INCOGNITO_AFTER'), '24h'),
    draftsAfter: toDuration(env('CLEANUP_DRAFTS_AFTER'), '7d'),
    logsAfter: toDuration(env('CLEANUP_LOGS_AFTER'), '30d'),
  },

  // Backups
  backup: {
    enabled: toBool(env('BACKUP_ENABLED'), isProd),
    intervalMs: toDuration(env('BACKUP_INTERVAL'), '24h'),
    retentionDays: toInt(env('BACKUP_RETENTION_DAYS'), 30),
    destination: toEnum(env('BACKUP_DEST'), ['supabase', 's3', 'local'], 'supabase'),
  },

  // Reportes
  reports: {
    dailySummary: toBool(env('DAILY_SUMMARY'), isProd),
    weeklyReport: toBool(env('WEEKLY_REPORT'), isProd),
    monthlyReport: toBool(env('MONTHLY_REPORT'), isProd),
  },

  // Métricas
  metrics: {
    enabled: toBool(env('METRICS_ENABLED'), isProd),
    intervalMs: toDuration(env('METRICS_INTERVAL'), '5m'),
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 22 · PATHS Y ARCHIVOS
// ═══════════════════════════════════════════════════════════════════════════

const paths = {
  root: ROOT_DIR,
  src: SRC_DIR,
  public: PUBLIC_DIR,
  logs: LOGS_DIR,
  tmp: TMP_DIR,
  migrations: MIGRATIONS_DIR,
  tests: TESTS_DIR,

  // Archivos específicos
  packageJson: join(ROOT_DIR, 'package.json'),
  envFile: join(ROOT_DIR, '.env.local'),

  // Frontend
  chat: join(PUBLIC_DIR, 'chat.html'),
  login: join(PUBLIC_DIR, 'login.html'),
  admin: join(PUBLIC_DIR, 'admin.html'),
  pricing: join(PUBLIC_DIR, 'precio.html'),
  landing: join(PUBLIC_DIR, 'index.html'),

  // Assets
  assets: join(PUBLIC_DIR, 'assets'),
  css: join(PUBLIC_DIR, 'assets', 'css'),
  js: join(PUBLIC_DIR, 'assets', 'js'),
  images: join(PUBLIC_DIR, 'assets', 'images'),

  // Existe
  exists(filePath) {
    return existsSync(filePath);
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 23 · FEATURE DETECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verifica si un proveedor de IA está configurado y habilitado.
 */
function hasAIProvider(name) {
  const p = ai.providers[name];
  if (!p || !p.enabled) return false;
  if (name === 'ollama') return !!p.baseUrl; // Ollama no necesita API key
  return !!p.apiKey;
}

/**
 * Devuelve la lista de proveedores de IA disponibles ordenados por prioridad.
 */
function getAvailableAIProviders() {
  return ai.fallbackChain
    .filter((name) => hasAIProvider(name))
    .sort((a, b) => (ai.providers[a]?.priority || 999) - (ai.providers[b]?.priority || 999));
}

/**
 * Verifica si el cache está funcionalmente disponible.
 */
function hasCache() {
  if (!cache.enabled) return false;
  if (cache.driver === 'memory') return true;
  if (cache.driver === 'upstash') return !!(cache.upstash.url && cache.upstash.token);
  if (cache.driver === 'redis') return !!(cache.redis.url || cache.redis.host);
  return false;
}

/**
 * Verifica si los pagos están configurados.
 */
function hasPayments() {
  if (!payments.enabled) return false;
  return payments.stripe.enabled || payments.mercadoPago.enabled || payments.payu.enabled;
}

/**
 * Verifica si el email está configurado.
 */
function hasEmail() {
  if (!email.enabled) return false;
  if (email.provider === 'console') return true;
  if (email.provider === 'resend') return !!email.resend.apiKey;
  if (email.provider === 'sendgrid') return !!email.sendgrid.apiKey;
  if (email.provider === 'smtp') return !!email.smtp.host;
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// 24 · VALIDACIÓN GLOBAL
// ═══════════════════════════════════════════════════════════════════════════

function validate() {
  const errors = [];
  const warnings = [];

  // En producción, exigir configuraciones mínimas
  if (isProd) {
    if (!server.publicUrl) {
      errors.push('PUBLIC_URL es requerido en producción');
    }

    if (!hasAIProvider('groq') && !hasAIProvider('gemini') && !hasAIProvider('kimi')) {
      errors.push('Se requiere al menos un proveedor de IA (GROQ, GEMINI o KIMI)');
    }

    if (!db.supabase.url || !db.supabase.serviceKey) {
      errors.push('Supabase URL y SERVICE_KEY son requeridos');
    }

    if (security.jwt.algorithm === 'none') {
      errors.push('JWT_ALGORITHM no puede ser "none"');
    }

    if (auth.session.secret === 'dev-secret-change-me') {
      errors.push('SESSION_SECRET debe ser único en producción');
    }

    if (server.cors.origins.includes('*')) {
      errors.push('CORS no puede ser "*" en producción');
    }
  }

  // Warnings
  if (isProd && !hasCache()) {
    warnings.push('Cache deshabilitado en producción (rendimiento degradado)');
  }

  if (isProd && !integrations.sentry.dsn) {
    warnings.push('Sentry no configurado (no habrá error tracking)');
  }

  if (features.payments && !hasPayments()) {
    warnings.push('Feature de pagos activada pero ningún provider configurado');
  }

  if (features.email && !hasEmail()) {
    warnings.push('Feature de email activada pero ningún provider configurado');
  }

  if (isProd && logging.level === 'debug') {
    warnings.push('LOG_LEVEL=debug en producción (verbose, costoso)');
  }

  // Si hay errores, explotar
  if (errors.length > 0) {
    const msg = '❌ Errores de configuración:\n  · ' + errors.join('\n  · ');
    throw new Error(msg);
  }

  // Warnings a stderr
  if (warnings.length > 0 && !isTest) {
    for (const w of warnings) {
      process.stderr.write(`⚠️  ${w}\n`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 25 · OBJECT PRINCIPAL
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Meta
  env: NODE_ENV,
  isDev,
  isProd,
  isStaging,
  isTest,
  platform: PLATFORM,
  isServerless,

  // Info del sistema
  system: {
    node: process.version,
    pid: process.pid,
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMemoryMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMemoryMb: Math.round(os.freemem() / 1024 / 1024),
    uptimeSec: Math.round(process.uptime()),
    nodeEnv: NODE_ENV,
  },

  // Secciones
  server,
  db,
  ai,
  search,
  auth,
  limits,
  cache,
  uploads,
  email,
  payments,
  webhooks,
  analytics,
  logging,
  security,
  features,
  costs,
  integrations,
  workers,
  paths,

  // Helpers
  hasAIProvider,
  getAvailableAIProviders,
  hasCache,
  hasPayments,
  hasEmail,

  // Utilidades
  mask,
  isEmail,

  // Debug
  dump() {
    return dump();
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// 26 · DUMP (para debugging, redacta secretos)
// ═══════════════════════════════════════════════════════════════════════════

function dump() {
  const secretKeys = new Set([
    'apiKey', 'secretKey', 'serviceKey', 'secret', 'token', 'password',
    'accessToken', 'refreshToken', 'privateKey', 'jwtSecret', 'webhookSecret',
    'sessionSecret', 'key',
  ]);

  function redact(obj, depth = 0) {
    if (depth > 8) return '[MaxDepth]';
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== 'object') {
      if (typeof obj === 'string' && obj.length > 200) {
        return obj.slice(0, 200) + '…';
      }
      return obj;
    }
    if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));

    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (secretKeys.has(k) && typeof v === 'string') {
        out[k] = mask(v);
      } else if (typeof v === 'function') {
        out[k] = '[Function]';
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }

  return redact(CONFIG);
}

// ═══════════════════════════════════════════════════════════════════════════
// 27 · ARRANQUE
// ═══════════════════════════════════════════════════════════════════════════

// Validar en cuanto se importa el módulo
if (!isTest) {
  try {
    validate();
  } catch (e) {
    process.stderr.write('\n' + e.message + '\n\n');
    process.exit(1);
  }
}

// Congelar profundo (evita mutaciones accidentales)
function deepFreeze(obj) {
  Object.freeze(obj);
  Object.getOwnPropertyNames(obj).forEach((prop) => {
    if (
      obj[prop] !== null &&
      (typeof obj[prop] === 'object' || typeof obj[prop] === 'function') &&
      !Object.isFrozen(obj[prop])
    ) {
      deepFreeze(obj[prop]);
    }
  });
  return obj;
}

deepFreeze(CONFIG);

// ═══════════════════════════════════════════════════════════════════════════
// 28 · EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

export { CONFIG };
export default CONFIG;

// Aliases convenientes
export const {
  env: ENV,
  isDev: IS_DEV,
  isProd: IS_PROD,
  isTest: IS_TEST,
} = CONFIG;