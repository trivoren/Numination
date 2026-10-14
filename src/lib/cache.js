/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · lib/cache.js · v1.0
   ─────────────────────────────────────────────────────────────────────────
   Cache multi-nivel: LRU + TTL en memoria, con adaptadores opcionales para
   Redis y Upstash. Cero dependencias obligatorias.

   FEATURES:
     · LRU eviction (least recently used)
     · TTL por entrada
     · Namespaces para aislar dominios
     · Multi-tier (L1 memoria + L2 Redis/Upstash)
     · Tag-based invalidation (invalidar por tags)
     · Stampede protection (mutex por key)
     · getOrSet: fetch on miss transparente
     · mget/mset/mdel: operaciones bulk
     · Serialización: JSON, string, buffer
     · Stats: hits, misses, evictions, hit rate
     · Events: hit, miss, set, evict, expire
     · Warmup (precarga)
     · Persistencia a disco (opt-in)
     · Middleware Express de cache HTTP
     · Zero dependencias obligatorias
     · Self-test integrado

   API PÚBLICA:

     Básico:
       cache.get(key)                    → Promise<any | null>
       cache.set(key, value, opts)       → Promise<void>
       cache.del(key)                    → Promise<boolean>
       cache.has(key)                    → Promise<boolean>
       cache.clear()                     → Promise<void>

     Avanzado:
       cache.getOrSet(key, fetchFn, opts) → Promise<any>
       cache.mget([keys])                → Promise<any[]>
       cache.mset({ key: value }, opts)  → Promise<void>
       cache.mdel([keys])                → Promise<number>
       cache.invalidateTag(tag)          → Promise<number>
       cache.invalidateNamespace(ns)     → Promise<number>
       cache.warmup(items)               → Promise<number>

     Namespaces:
       cache.namespace(name)             → sub-cache con prefijo

     Stats/Events:
       cache.stats()                     → objeto de stats
       cache.on(event, handler)          → unsubscribe
       cache.resetStats()                → void

     Config:
       cache.configure(patch)            → void
       cache.connectRedis(url)           → Promise<boolean>
       cache.connectUpstash(url, token)  → Promise<boolean>

     Middleware:
       cache.middleware(opts)            → Express middleware

     Debug:
       cache.test()                      → self-test

   USO:
     import { cache } from './lib/cache.js';

     // Simple
     await cache.set('user:123', { name: 'Juan' }, { ttl: 60_000 });
     const user = await cache.get('user:123');

     // getOrSet (fetch on miss)
     const user2 = await cache.getOrSet('user:456', async () => {
       return await db.getUser(456);
     }, { ttl: 300_000 });

     // Namespaces
     const chatCache = cache.namespace('chat');
     await chatCache.set('list', chats);

     // Tags
     await cache.set('user:789', user, { ttl: 60_000, tags: ['users'] });
     await cache.invalidateTag('users'); // invalida todos los que tengan ese tag
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { createLogger } from './logger.js';

const log = createLogger('cache');

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = {
  // L1 memoria
  memory: {
    enabled: true,
    max: parseInt(process.env.CACHE_MEMORY_MAX || '1000', 10),
    maxSizeBytes: parseInt(process.env.CACHE_MEMORY_MAX_BYTES || '52428800', 10), // 50MB
  },

  // TTL por defecto
  defaultTtlMs: parseInt(process.env.CACHE_DEFAULT_TTL_MS || '300000', 10), // 5min

  // Redis L2 (opcional)
  redis: {
    enabled: process.env.CACHE_REDIS === 'true',
    url: process.env.REDIS_URL || null,
    host: process.env.REDIS_HOST || null,
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || null,
    db: parseInt(process.env.REDIS_DB || '0', 10),
    keyPrefix: process.env.CACHE_REDIS_PREFIX || 'nm:',
  },

  // Upstash L2 (opcional, ideal para serverless)
  upstash: {
    enabled: process.env.CACHE_UPSTASH === 'true',
    url: process.env.UPSTASH_REDIS_URL || null,
    token: process.env.UPSTASH_REDIS_TOKEN || null,
    keyPrefix: process.env.CACHE_UPSTASH_PREFIX || 'nm:',
  },

  // Comportamiento
  behavior: {
    // Escribir en L1 Y L2, o solo L2 (útil para datos compartidos)
    writeThrough: true,
    // Si L1 miss pero L2 hit, promover a L1
    promoteOnHit: true,
    // Si L2 falla, seguir sin error
    silentFallback: true,
    // Compresión opt-in
    compress: process.env.CACHE_COMPRESS === 'true',
    // Compress si payload > X bytes
    compressThreshold: 1024, // 1KB
  },

  // Stampede protection
  stampede: {
    enabled: true,
    // Timeout del lock (evita deadlock si el fetch se cuelga)
    lockTimeoutMs: 30_000,
  },

  // Persistencia (opt-in)
  persist: {
    enabled: false,
    path: process.env.CACHE_PERSIST_PATH || '.cache.json',
    intervalMs: 60_000,
  },

  // Stats
  stats: {
    enabled: true,
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

/* ═══════════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !Buffer.isBuffer(v);
}

function estimateSize(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return value.length * 2;
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 4;
  if (Buffer.isBuffer(value)) return value.length;
  try {
    return JSON.stringify(value).length * 2;
  } catch {
    return 0;
  }
}

function safeStringify(v) {
  try {
    return JSON.stringify(v);
  } catch (e) {
    log.warn('stringify failed', e.message);
    return null;
  }
}

function safeParse(s) {
  if (s === null || s === undefined) return null;
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · LRU + TTL STORE (en memoria)
   ═══════════════════════════════════════════════════════════════════════════ */

class LRUTTLStore {
  constructor(options = {}) {
    this.max = options.max || 1000;
    this.maxSizeBytes = options.maxSizeBytes || 50 * 1024 * 1024;
    this.entries = new Map();
    this.sizeBytes = 0;
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
      expirations: 0,
    };
  }

  /**
   * Entry: { value, expiresAt, size, tags, createdAt, accessedAt }
   */
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) {
      this.stats.misses++;
      return { hit: false };
    }

    // Expirado
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      this.sizeBytes -= entry.size;
      this.stats.expirations++;
      this.stats.misses++;
      return { hit: false, expired: true };
    }

    // Mover al final (LRU: el último es el más reciente)
    this.entries.delete(key);
    this.entries.set(key, entry);
    entry.accessedAt = Date.now();
    this.stats.hits++;

    return { hit: true, value: entry.value, entry };
  }

  set(key, value, options = {}) {
    const ttl = options.ttl;
    const tags = options.tags || [];

    const size = estimateSize(value);

    // Eliminar si ya existe
    if (this.entries.has(key)) {
      const old = this.entries.get(key);
      this.sizeBytes -= old.size;
      this.entries.delete(key);
    }

    const entry = {
      value,
      expiresAt: ttl ? Date.now() + ttl : 0,
      size,
      tags,
      createdAt: Date.now(),
      accessedAt: Date.now(),
    };

    this.entries.set(key, entry);
    this.sizeBytes += size;
    this.stats.sets++;

    // Evict si excede límites
    this._evictIfNeeded();

    return true;
  }

  has(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      this.sizeBytes -= entry.size;
      this.stats.expirations++;
      return false;
    }
    return true;
  }

  delete(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.entries.delete(key);
    this.sizeBytes -= entry.size;
    this.stats.deletes++;
    return true;
  }

  clear() {
    const count = this.entries.size;
    this.entries.clear();
    this.sizeBytes = 0;
    this.stats.deletes += count;
    return count;
  }

  _evictIfNeeded() {
    // Evict por cantidad
    while (this.entries.size > this.max) {
      const firstKey = this.entries.keys().next().value;
      const firstEntry = this.entries.get(firstKey);
      this.entries.delete(firstKey);
      this.sizeBytes -= firstEntry.size;
      this.stats.evictions++;
    }

    // Evict por tamaño
    while (this.sizeBytes > this.maxSizeBytes && this.entries.size > 0) {
      const firstKey = this.entries.keys().next().value;
      const firstEntry = this.entries.get(firstKey);
      this.entries.delete(firstKey);
      this.sizeBytes -= firstEntry.size;
      this.stats.evictions++;
    }
  }

  /**
   * Devuelve todas las keys con un tag dado.
   */
  keysWithTag(tag) {
    const keys = [];
    for (const [key, entry] of this.entries) {
      if (entry.tags && entry.tags.includes(tag)) keys.push(key);
    }
    return keys;
  }

  /**
   * Devuelve todas las keys que empiezan con un prefijo.
   */
  keysWithPrefix(prefix) {
    const keys = [];
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }

  /**
   * Cleanup de expirados. Llamado periódicamente.
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt && entry.expiresAt < now) {
        this.entries.delete(key);
        this.sizeBytes -= entry.size;
        this.stats.expirations++;
        cleaned++;
      }
    }
    return cleaned;
  }

  size() {
    return this.entries.size;
  }

  info() {
    return {
      size: this.entries.size,
      sizeBytes: this.sizeBytes,
      max: this.max,
      maxSizeBytes: this.maxSizeBytes,
      ...this.stats,
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · REDIS ADAPTER (opcional)
   ═══════════════════════════════════════════════════════════════════════════ */

let redisClient = null;
let redisReady = false;

async function connectRedis(config = {}) {
  if (redisReady && redisClient) return true;

  try {
    // Intenta importar `redis` (el cliente oficial moderno)
    const { createClient } = await import('redis');

    const url = config.url || CFG.redis.url;
    const opts = url
      ? { url }
      : {
          socket: {
            host: config.host || CFG.redis.host || '127.0.0.1',
            port: config.port || CFG.redis.port,
          },
          password: config.password || CFG.redis.password,
          database: config.db ?? CFG.redis.db,
        };

    redisClient = createClient(opts);

    redisClient.on('error', (err) => {
      log.warn('redis error', err.message);
      redisReady = false;
    });

    redisClient.on('ready', () => {
      log.info('redis conectado');
      redisReady = true;
    });

    await redisClient.connect();
    redisReady = true;
    return true;
  } catch (e) {
    log.warn(`no se pudo conectar a Redis: ${e.message}`);
    redisClient = null;
    redisReady = false;
    return false;
  }
}

async function redisGet(key) {
  if (!redisReady || !redisClient) return { hit: false, unavailable: true };
  try {
    const v = await redisClient.get(key);
    if (v === null) return { hit: false };
    return { hit: true, value: safeParse(v) };
  } catch (e) {
    log.warn('redis get failed', e.message);
    return { hit: false, unavailable: true };
  }
}

async function redisSet(key, value, ttlMs) {
  if (!redisReady || !redisClient) return false;
  try {
    const str = safeStringify(value);
    if (str === null) return false;
    if (ttlMs) {
      await redisClient.set(key, str, { PX: ttlMs });
    } else {
      await redisClient.set(key, str);
    }
    return true;
  } catch (e) {
    log.warn('redis set failed', e.message);
    return false;
  }
}

async function redisDel(key) {
  if (!redisReady || !redisClient) return false;
  try {
    const n = await redisClient.del(key);
    return n > 0;
  } catch (e) {
    return false;
  }
}

async function redisKeys(pattern) {
  if (!redisReady || !redisClient) return [];
  try {
    const keys = [];
    for await (const key of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      keys.push(key);
    }
    return keys;
  } catch (e) {
    return [];
  }
}

async function redisFlushPattern(pattern) {
  if (!redisReady || !redisClient) return 0;
  const keys = await redisKeys(pattern);
  if (keys.length === 0) return 0;
  try {
    await redisClient.del(keys);
    return keys.length;
  } catch (e) {
    return 0;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · UPSTASH ADAPTER (REST, ideal para serverless)
   ═══════════════════════════════════════════════════════════════════════════ */

let upstashReady = false;

async function connectUpstash(url, token) {
  const u = url || CFG.upstash.url;
  const t = token || CFG.upstash.token;

  if (!u || !t) return false;

  try {
    // Ping para validar
    const res = await fetch(`${u}/ping`, {
      headers: { Authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    upstashReady = true;
    log.info('upstash conectado');
    return true;
  } catch (e) {
    log.warn(`no se pudo conectar a Upstash: ${e.message}`);
    upstashReady = false;
    return false;
  }
}

async function upstashCmd(command, ...args) {
  const u = CFG.upstash.url;
  const t = CFG.upstash.token;
  if (!upstashReady || !u || !t) return null;

  try {
    const url = `${u}/${command}/${args.map(a => encodeURIComponent(typeof a === 'string' ? a : JSON.stringify(a))).join('/')}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${t}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return data.result;
  } catch (e) {
    log.warn(`upstash ${command} failed: ${e.message}`);
    return null;
  }
}

async function upstashGet(key) {
  const result = await upstashCmd('get', key);
  if (result === null || result === undefined) return { hit: false };
  return { hit: true, value: safeParse(result) };
}

async function upstashSet(key, value, ttlMs) {
  const str = safeStringify(value);
  if (str === null) return false;

  if (ttlMs) {
    const result = await upstashCmd('set', key, str, 'PX', ttlMs);
    return result === 'OK';
  } else {
    const result = await upstashCmd('set', key, str);
    return result === 'OK';
  }
}

async function upstashDel(key) {
  const result = await upstashCmd('del', key);
  return result > 0;
}

async function upstashScanPattern(pattern) {
  const result = await upstashCmd('keys', pattern);
  return Array.isArray(result) ? result : [];
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · STAMPEDE PROTECTION (mutex por key)
   ═══════════════════════════════════════════════════════════════════════════ */

const inflight = new Map();

async function withLock(key, fn) {
  if (inflight.has(key)) {
    // Ya hay un fetch en curso, esperarlo
    return inflight.get(key);
  }

  const promise = (async () => {
    try {
      return await fn();
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, promise);

  // Safety timeout
  setTimeout(() => {
    if (inflight.get(key) === promise) {
      inflight.delete(key);
    }
  }, CFG.stampede.lockTimeoutMs).unref?.();

  return promise;
}

/* ═══════════════════════════════════════════════════════════════════════════
   07 · EVENTS
   ═══════════════════════════════════════════════════════════════════════════ */

const eventHandlers = new Map();

function emit(event, data) {
  const handlers = eventHandlers.get(event);
  if (!handlers) return;
  for (const h of handlers) {
    try {
      h(data);
    } catch (e) {
      log.warn(`handler ${event} failed`, e.message);
    }
  }
}

function on(event, handler) {
  if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
  eventHandlers.get(event).add(handler);
  return () => off(event, handler);
}

function off(event, handler) {
  const handlers = eventHandlers.get(event);
  if (handlers) handlers.delete(handler);
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · STATS GLOBALES
   ═══════════════════════════════════════════════════════════════════════════ */

const globalStats = {
  hits: 0,
  misses: 0,
  sets: 0,
  deletes: 0,
  evictions: 0,
  expirations: 0,
  errors: 0,
  l2Hits: 0,
  stampedeMerged: 0,
  since: Date.now(),
};

function resetStats() {
  Object.keys(globalStats).forEach(k => {
    if (typeof globalStats[k] === 'number' && k !== 'since') globalStats[k] = 0;
  });
  globalStats.since = Date.now();
}

/* ═══════════════════════════════════════════════════════════════════════════
   09 · CACHE CORE
   ═══════════════════════════════════════════════════════════════════════════ */

class Cache {
  constructor(options = {}) {
    this.store = new LRUTTLStore({
      max: options.max || CFG.memory.max,
      maxSizeBytes: options.maxSizeBytes || CFG.memory.maxSizeBytes,
    });
    this.defaultTtlMs = options.defaultTtlMs || CFG.defaultTtlMs;
    // OJO: se llama _ns porque `namespace` es el método de abajo; usar el
    // mismo nombre como propiedad pisaría el método en cada instancia.
    this._ns = options.namespace || '';
    this.prefix = options.prefix || '';

    // Cleanup periódico
    this._cleanupInterval = setInterval(() => {
      const cleaned = this.store.cleanup();
      if (cleaned > 0) log.debug(`cleanup: ${cleaned} expirados`);
    }, 60_000);
    this._cleanupInterval.unref?.();

    // Persistencia
    if (options.persist || CFG.persist.enabled) {
      this._startPersist(options.persistPath || CFG.persist.path);
    }
  }

  /**
   * Construye la key completa (namespace + prefix + key).
   */
  _fullKey(key) {
    const parts = [];
    if (this._ns) parts.push(this._ns);
    if (this.prefix) parts.push(this.prefix);
    parts.push(String(key));
    return parts.join(':');
  }

  /**
   * Crea un sub-cache con namespace.
   */
  namespace(name) {
    const child = new Cache({
      max: this.store.max,
      defaultTtlMs: this.defaultTtlMs,
      namespace: this._ns ? `${this._ns}:${name}` : name,
      prefix: this.prefix,
    });
    // Comparte el mismo store para LRU global
    child.store = this.store;
    clearInterval(child._cleanupInterval);
    return child;
  }

  /* ─── GET ─── */
  async get(key, options = {}) {
    const fullKey = this._fullKey(key);

    // L1: memoria
    if (CFG.memory.enabled) {
      const mem = this.store.get(fullKey);
      if (mem.hit) {
        globalStats.hits++;
        emit('hit', { key: fullKey, level: 'L1' });
        return mem.value;
      }
    }

    // L2: Redis
    if (CFG.redis.enabled && redisReady) {
      const r = await redisGet(fullKey);
      if (r.hit) {
        globalStats.l2Hits++;
        emit('hit', { key: fullKey, level: 'L2-redis' });
        if (CFG.behavior.promoteOnHit) {
          this.store.set(fullKey, r.value, { ttl: options.ttl });
        }
        return r.value;
      }
    }

    // L2: Upstash
    if (CFG.upstash.enabled && upstashReady) {
      const r = await upstashGet(fullKey);
      if (r.hit) {
        globalStats.l2Hits++;
        emit('hit', { key: fullKey, level: 'L2-upstash' });
        if (CFG.behavior.promoteOnHit) {
          this.store.set(fullKey, r.value, { ttl: options.ttl });
        }
        return r.value;
      }
    }

    globalStats.misses++;
    emit('miss', { key: fullKey });
    return null;
  }

  /* ─── SET ─── */
  async set(key, value, options = {}) {
    const fullKey = this._fullKey(key);
    const ttl = options.ttl !== undefined ? options.ttl : this.defaultTtlMs;
    const tags = options.tags || [];

    // L1
    if (CFG.memory.enabled) {
      this.store.set(fullKey, value, { ttl, tags });
    }

    // L2
    if (CFG.behavior.writeThrough) {
      if (CFG.redis.enabled && redisReady) {
        await redisSet(fullKey, value, ttl);
      }
      if (CFG.upstash.enabled && upstashReady) {
        await upstashSet(fullKey, value, ttl);
      }
    }

    globalStats.sets++;
    emit('set', { key: fullKey, ttl, tags });
    return true;
  }

  /* ─── DEL ─── */
  async del(key) {
    const fullKey = this._fullKey(key);
    let deleted = false;

    if (CFG.memory.enabled) {
      deleted = this.store.delete(fullKey) || deleted;
    }

    if (CFG.redis.enabled && redisReady) {
      deleted = (await redisDel(fullKey)) || deleted;
    }
    if (CFG.upstash.enabled && upstashReady) {
      deleted = (await upstashDel(fullKey)) || deleted;
    }

    if (deleted) {
      globalStats.deletes++;
      emit('delete', { key: fullKey });
    }

    return deleted;
  }

  /* ─── HAS ─── */
  async has(key) {
    const fullKey = this._fullKey(key);

    if (CFG.memory.enabled && this.store.has(fullKey)) return true;

    if (CFG.redis.enabled && redisReady) {
      const r = await redisGet(fullKey);
      if (r.hit) return true;
    }
    if (CFG.upstash.enabled && upstashReady) {
      const r = await upstashGet(fullKey);
      if (r.hit) return true;
    }

    return false;
  }

  /* ─── CLEAR ─── */
  async clear() {
    let count = 0;
    if (CFG.memory.enabled) {
      count += this.store.clear();
    }
    // Nota: no limpiamos Redis/Upstash globalmente (podría afectar otras apps)
    emit('clear', { count });
    return count;
  }

  /* ─── GET OR SET ─── */
  /**
   * Busca en cache. Si no está, llama a fetchFn y guarda el resultado.
   * Con protección contra stampede: si múltiples requests piden la misma key
   * al mismo tiempo, solo uno hace el fetch y los demás esperan.
   */
  async getOrSet(key, fetchFn, options = {}) {
    // Intento 1: cache
    const cached = await this.get(key, options);
    if (cached !== null) return cached;

    const fullKey = this._fullKey(key);
    const useStampede = options.stampede !== false && CFG.stampede.enabled;

    const doFetch = async () => {
      // Re-check por si otro worker ya lo llenó mientras esperábamos
      const recheck = await this.get(key, options);
      if (recheck !== null) {
        globalStats.stampedeMerged++;
        return recheck;
      }

      try {
        const value = await fetchFn();
        if (value !== undefined && value !== null) {
          await this.set(key, value, options);
        }
        return value;
      } catch (e) {
        globalStats.errors++;
        emit('error', { key: fullKey, error: e.message });
        throw e;
      }
    };

    if (useStampede) {
      return withLock(fullKey, doFetch);
    }

    return doFetch();
  }

  /* ─── MGET ─── */
  async mget(keys) {
    const results = [];
    for (const key of keys) {
      results.push(await this.get(key));
    }
    return results;
  }

  /* ─── MSET ─── */
  async mset(obj, options = {}) {
    for (const [key, value] of Object.entries(obj)) {
      await this.set(key, value, options);
    }
  }

  /* ─── MDEL ─── */
  async mdel(keys) {
    let count = 0;
    for (const key of keys) {
      if (await this.del(key)) count++;
    }
    return count;
  }

  /* ─── INVALIDATE TAG ─── */
  /**
   * Elimina todas las keys con un tag dado.
   */
  async invalidateTag(tag) {
    let count = 0;

    // L1
    const keys = this.store.keysWithTag(tag);
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }

    // L2 (redis/upstash) — buscamos por pattern si tenemos el namespace
    // Nota: tags en L2 requieren índices; esto es best-effort por prefix
    if (CFG.redis.enabled && redisReady) {
      const pattern = `${CFG.redis.keyPrefix}*`;
      // No podemos filtrar por tag en Redis sin un set auxiliar; skip
    }

    emit('invalidate-tag', { tag, count });
    return count;
  }

  /* ─── INVALIDATE NAMESPACE ─── */
  async invalidateNamespace(namespace) {
    const prefix = namespace ? `${namespace}:` : '';
    let count = 0;

    // L1
    const keys = this.store.keysWithPrefix(prefix);
    for (const key of keys) {
      if (this.store.delete(key)) count++;
    }

    // L2 Redis
    if (CFG.redis.enabled && redisReady) {
      const pattern = `${CFG.redis.keyPrefix}${prefix}*`;
      count += await redisFlushPattern(pattern);
    }

    // L2 Upstash
    if (CFG.upstash.enabled && upstashReady) {
      const pattern = `${CFG.upstash.keyPrefix}${prefix}*`;
      const keys = await upstashScanPattern(pattern);
      for (const key of keys) {
        await upstashDel(key);
        count++;
      }
    }

    emit('invalidate-namespace', { namespace, count });
    return count;
  }

  /* ─── WARMUP ─── */
  async warmup(items) {
    let loaded = 0;
    for (const item of items) {
      try {
        const value = typeof item.fetch === 'function' ? await item.fetch() : item.value;
        if (value !== undefined && value !== null) {
          await this.set(item.key, value, item.opts || {});
          loaded++;
        }
      } catch (e) {
        log.warn(`warmup ${item.key} failed: ${e.message}`);
      }
    }
    log.info(`warmup: ${loaded}/${items.length} keys cargadas`);
    return loaded;
  }

  /* ─── STATS ─── */
  stats() {
    const storeInfo = this.store.info();
    const total = globalStats.hits + globalStats.misses;
    const hitRate = total > 0 ? globalStats.hits / total : 0;

    return {
      ...globalStats,
      uptimeMs: Date.now() - globalStats.since,
      hitRate: Number(hitRate.toFixed(4)),
      store: storeInfo,
      redisReady,
      upstashReady,
      inflight: inflight.size,
    };
  }

  /* ─── PERSISTENCIA ─── */
  async _startPersist(path) {
    try {
      const fs = await import('node:fs/promises');

      // Cargar
      try {
        const data = await fs.readFile(path, 'utf-8');
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed.entries)) {
          const now = Date.now();
          for (const [key, entry] of parsed.entries) {
            if (entry.expiresAt && entry.expiresAt < now) continue;
            this.store.entries.set(key, entry);
            this.store.sizeBytes += entry.size || 0;
          }
          log.info(`persist: ${this.store.entries.size} keys cargadas`);
        }
      } catch (e) {
        if (e.code !== 'ENOENT') log.warn('persist load failed', e.message);
      }

      // Guardar periódicamente
      setInterval(async () => {
        try {
          const entries = Array.from(this.store.entries.entries());
          await fs.writeFile(path, JSON.stringify({ entries, savedAt: Date.now() }));
        } catch (e) {
          log.warn('persist save failed', e.message);
        }
      }, CFG.persist.intervalMs).unref?.();
    } catch (e) {
      log.warn('persist init failed', e.message);
    }
  }

  /* ─── DESTROY ─── */
  destroy() {
    clearInterval(this._cleanupInterval);
    this.store.clear();
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · INSTANCIA GLOBAL
   ═══════════════════════════════════════════════════════════════════════════ */

const cache = new Cache();

/* ═══════════════════════════════════════════════════════════════════════════
   11 · MIDDLEWARE EXPRESS · HTTP cache
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Middleware que cachea respuestas HTTP GET.
 *
 *   app.get('/api/chats', cacheMiddleware({ ttl: 30_000 }), handler);
 *
 * - Genera una key basada en método + path + query + user id
 * - Si hay hit, responde directo con 200 y header X-Cache: HIT
 * - Si no, captura la respuesta JSON y la guarda
 */
function cacheMiddleware(options = {}) {
  const ttl = options.ttl || 30_000;
  const keyFn = options.keyFn || ((req) => {
    const userPart = req.user?.id ? `user:${req.user.id}:` : 'anon:';
    const queryPart = Object.keys(req.query).length
      ? ':' + JSON.stringify(req.query)
      : '';
    return `http:${userPart}${req.method}:${req.path}${queryPart}`;
  });
  const skipFn = options.skip || (() => false);
  const tags = options.tags || [];

  return async function cacheMiddlewareHandler(req, res, next) {
    // Solo cachear GET
    if (req.method !== 'GET') return next();
    if (skipFn(req)) return next();

    const key = keyFn(req);

    // Intentar hit
    try {
      const cached = await cache.get(key);
      if (cached !== null) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Cache-Control', `private, max-age=${Math.floor(ttl / 1000)}`);
        return res.json(cached);
      }
    } catch (e) {
      log.warn('cache middleware get failed', e.message);
    }

    res.setHeader('X-Cache', 'MISS');

    // Interceptar res.json para guardar
    const originalJson = res.json.bind(res);
    res.json = function (body) {
      // Guardar solo si fue exitoso (2xx)
      if (res.statusCode >= 200 && res.statusCode < 300) {
        cache.set(key, body, { ttl, tags }).catch(() => {});
      }
      return originalJson(body);
    };

    next();
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   12 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

function configure(patch) {
  if (!patch || typeof patch !== 'object') return;

  function merge(target, source) {
    for (const k of Object.keys(source)) {
      if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        merge(target[k], source[k]);
      } else {
        target[k] = source[k];
      }
    }
  }

  merge(CFG, patch);
  log.info('cache config actualizada');
}

/* ═══════════════════════════════════════════════════════════════════════════
   13 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════════ */

async function test() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  // Test store básico
  const c = new Cache({ max: 5, defaultTtlMs: 1000 });

  rec('set/get básico', await (async () => {
    await c.set('a', 'hola');
    return (await c.get('a')) === 'hola';
  })(), true);

  rec('get miss devuelve null', await c.get('nope') === null, true);

  rec('has true', await c.has('a'), true);
  rec('has false', !(await c.has('nope')), true);

  rec('del elimina', await c.del('a') && (await c.get('a')) === null, true);

  // TTL
  await c.set('ttl', 'value', { ttl: 100 });
  rec('get antes de expirar', (await c.get('ttl')) === 'value', true);
  await new Promise(r => setTimeout(r, 150));
  rec('get después de expirar', (await c.get('ttl')) === null, true);

  // LRU eviction
  const lru = new Cache({ max: 3, defaultTtlMs: 60_000 });
  await lru.set('k1', 1);
  await lru.set('k2', 2);
  await lru.set('k3', 3);
  await lru.get('k1'); // marca k1 como reciente
  await lru.set('k4', 4); // debe evictar k2
  rec('LRU evicta el menos usado', (await lru.get('k2')) === null, true);
  rec('LRU conserva k1', (await lru.get('k1')) === 1, true);
  rec('LRU conserva k4', (await lru.get('k4')) === 4, true);

  // getOrSet
  let fetchCount = 0;
  const fetchFn = async () => {
    fetchCount++;
    return { id: 1, name: 'Juan' };
  };

  const g1 = await c.getOrSet('user:1', fetchFn, { ttl: 60_000 });
  const g2 = await c.getOrSet('user:1', fetchFn, { ttl: 60_000 });
  rec('getOrSet hace fetch solo 1 vez', fetchCount === 1, fetchCount);
  rec('getOrSet devuelve mismo value', g1.name === 'Juan' && g2.name === 'Juan', true);

  // Stampede
  let stampedeCount = 0;
  const stampedeFn = async () => {
    stampedeCount++;
    await new Promise(r => setTimeout(r, 50));
    return 'stampede-result';
  };

  const p1 = c.getOrSet('stampede', stampedeFn, { ttl: 60_000 });
  const p2 = c.getOrSet('stampede', stampedeFn, { ttl: 60_000 });
  const p3 = c.getOrSet('stampede', stampedeFn, { ttl: 60_000 });
  const [s1, s2, s3] = await Promise.all([p1, p2, p3]);
  rec('stampede: 3 requests = 1 fetch', stampedeCount === 1, stampedeCount);
  rec('stampede: todos reciben valor', s1 === 'stampede-result' && s2 === 'stampede-result' && s3 === 'stampede-result', true);

  // mset/mget
  await c.mset({ x1: 1, x2: 2, x3: 3 }, { ttl: 60_000 });
  const mvals = await c.mget(['x1', 'x2', 'x3']);
  rec('mset/mget funciona', mvals[0] === 1 && mvals[1] === 2 && mvals[2] === 3, mvals);

  // mdel
  const mdelCount = await c.mdel(['x1', 'x2']);
  rec('mdel elimina 2', mdelCount === 2, mdelCount);
  rec('mdel deja el resto', (await c.get('x3')) === 3, true);

  // Namespace
  const nsCache = c.namespace('ns1');
  await nsCache.set('key', 'valor-ns');
  rec('namespace funciona', (await nsCache.get('key')) === 'valor-ns', true);
  rec('namespace no colisiona', (await c.get('key')) === null, true);

  // invalidateTag
  const t1 = new Cache({ max: 10 });
  await t1.set('a', 1, { tags: ['users'] });
  await t1.set('b', 2, { tags: ['users'] });
  await t1.set('c', 3, { tags: ['posts'] });
  const invalidated = await t1.invalidateTag('users');
  rec('invalidateTag borra tagged', invalidated === 2, invalidated);
  rec('invalidateTag no toca otros', (await t1.get('c')) === 3, true);

  // invalidateNamespace
  const t2 = new Cache({ max: 10 });
  const nsA = t2.namespace('a');
  const nsB = t2.namespace('b');
  await nsA.set('k1', 1);
  await nsA.set('k2', 2);
  await nsB.set('k1', 1);
  const nsInvalidated = await t2.invalidateNamespace('a');
  rec('invalidateNamespace borra su rango', nsInvalidated >= 2, nsInvalidated);
  rec('invalidateNamespace no toca otros', (await nsB.get('k1')) === 1, true);

  // clear
  const t3 = new Cache({ max: 10 });
  await t3.set('a', 1);
  await t3.set('b', 2);
  const cleared = await t3.clear();
  rec('clear borra todo', cleared === 2 && (await t3.get('a')) === null, cleared);

  // warmup
  const t4 = new Cache({ max: 10 });
  const warmed = await t4.warmup([
    { key: 'w1', value: 'one' },
    { key: 'w2', fetch: async () => 'two' },
    { key: 'w3', value: null }, // skip
  ]);
  rec('warmup carga valores', warmed === 2, warmed);
  rec('warmup con fetch', (await t4.get('w2')) === 'two', true);

  // Stats
  const stats = c.stats();
  rec('stats tiene hits/misses', typeof stats.hits === 'number' && typeof stats.misses === 'number', stats);
  rec('stats tiene hitRate', typeof stats.hitRate === 'number', stats.hitRate);
  rec('stats store info', typeof stats.store === 'object' && 'size' in stats.store, stats.store);

  // Events
  let setCount = 0;
  let hitCount = 0;
  const offSet = on('set', () => setCount++);
  const offHit = on('hit', () => hitCount++);

  const t5 = new Cache({ max: 10 });
  await t5.set('evt', 'value');
  await t5.get('evt');
  offSet();
  offHit();

  rec('evento set se emite', setCount >= 1, setCount);
  rec('evento hit se emite', hitCount >= 1, hitCount);

  // Object values
  const obj = { a: 1, nested: { b: 2 } };
  await c.set('obj', obj);
  const objBack = await c.get('obj');
  rec('objeto roundtrip', objBack.nested.b === 2, objBack);

  // Buffer values
  const buf = Buffer.from('hello');
  await c.set('buf', buf.toString('base64'));
  rec('buffer como string', (await c.get('buf')) === 'aGVsbG8=', true);

  // resetStats
  resetStats();
  const statsAfter = cache.stats();
  rec('resetStats limpia hits', statsAfter.hits === 0, statsAfter.hits);

  // middleware existe
  rec('middleware es función', typeof cacheMiddleware() === 'function', true);

  // configure existe
  rec('configure es función', typeof configure === 'function', true);

  // connectRedis (no falla si no está instalado)
  const redisOk = await connectRedis({ url: 'redis://invalid-host:9999' });
  rec('connectRedis falla silencioso', redisOk === false, redisOk);

  // connectUpstash (no falla sin config)
  const upstashOk = await connectUpstash('', '');
  rec('connectUpstash sin config devuelve false', upstashOk === false, upstashOk);

  // Cleanup de timers
  c.destroy();
  t1.destroy?.();
  t2.destroy?.();
  t3.destroy();
  t4.destroy();
  t5.destroy();
  lru.destroy();

  const passed = results.filter(r => r.ok).length;
  return {
    passed,
    total: results.length,
    ok: passed === results.length,
    results,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   14 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

// Auto-conectar Redis/Upstash si están configurados
if (CFG.redis.enabled) {
  connectRedis().catch(() => {});
}
if (CFG.upstash.enabled) {
  connectUpstash().catch(() => {});
}

export {
  cache,
  Cache,
  cacheMiddleware,
  connectRedis,
  connectUpstash,
  on,
  off,
  resetStats,
  configure,
  test,
};

export default {
  cache,
  Cache,
  middleware: cacheMiddleware,
  connectRedis,
  connectUpstash,
  on,
  off,
  resetStats,
  configure,
  test,
};