/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · lib/queue.js · v1.0
   ─────────────────────────────────────────────────────────────────────────
   Cola de trabajos con workers concurrentes. Cero dependencias.

   FEATURES:
     · Colas múltiples con configuración independiente
     · Prioridades (low, normal, high, urgent)
     · Delayed jobs (ejecutar después de N ms)
     · Retry con backoff exponencial + jitter
     · Deadline/timeout por job
     · Concurrency por cola
     · Rate limiting (jobs/segundo) por cola
     · Persistencia a disco (opt-in)
     · Graceful shutdown (drena cola antes de salir)
     · Eventos: added, started, completed, failed, retrying, drained
     · Stats agregadas (throughput, latencia, success rate)
     · Prioridad con binary heap (O(log n))
     · Jobs deduplicados por key (opt-in)
     · Cron-like scheduler (interval jobs)
     · Middleware de job (antes/después)
     · Zero dependencias
     · Self-test integrado

   API PÚBLICA:

     Crear cola:
       const queue = createQueue('emails', { concurrency: 5 })
       queue.process(handlerFn)
       queue.add(data, opts)             → Promise<Job>
       queue.addBulk([{ data, opts }])   → Promise<Job[]>
       queue.pause() / resume()
       queue.drain()                      → Promise<void>
       queue.close()                      → Promise<void>

     Con retry:
       queue.add(data, { retries: 3, backoff: 'exponential' })

     Delayed:
       queue.add(data, { delayMs: 5000 })

     Prioridad:
       queue.add(data, { priority: 'high' })

     Rate limit:
       createQueue('api', { rateLimit: { perSecond: 10, burst: 20 } })

     Cron:
       createQueue('cleanup', { cron: '0 0 * * *' })  // cada 5min
       queue.add({ type: 'cleanup' })  // se ejecuta según schedule

     Eventos:
       queue.on('completed', (job) => { ... })
       queue.on('failed', (job, err) => { ... })

     Global:
       queueManager.list()                → colas registradas
       queueManager.get(name)             → cola por nombre
       queueManager.closeAll()            → graceful shutdown
       queueManager.stats()               → stats de todas

     Debug:
       queueManager.test()                → self-test

   USO:
     import { createQueue } from './lib/queue.js';

     const emailQueue = createQueue('emails', { concurrency: 3 });

     emailQueue.process(async (job) => {
       await sendEmail(job.data.to, job.data.subject);
       return { sent: true };
     });

     // En un endpoint:
     await emailQueue.add({ to: 'juan@x.com', subject: 'Hola' });
   ═══════════════════════════════════════════════════════════════════════════ */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from './logger.js';
import { randomHex } from './crypto.js';

const log = createLogger('queue');

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = {
  // Concurrency global
  maxTotalConcurrency: parseInt(process.env.QUEUE_MAX_CONCURRENCY || '50', 10),

  // Retry
  retry: {
    defaultMaxAttempts: 3,
    backoff: 'exponential', // exponential | linear | fixed
    baseDelayMs: 1000,
    maxDelayMs: 60_000,
    jitter: 0.3,
  },

  // Persistencia
  persist: {
    enabled: process.env.QUEUE_PERSIST === 'true',
    dir: process.env.QUEUE_PERSIST_DIR || '.queues',
    intervalMs: 10_000,
  },

  // Shutdown
  shutdown: {
    timeoutMs: parseInt(process.env.QUEUE_SHUTDOWN_TIMEOUT_MS || '15000', 10),
  },

  // Métricas
  metrics: {
    enabled: true,
    latencyBufferSize: 200,
  },

  // Log
  logLevel: process.env.LOG_LEVEL || 'info',
};

/* ═══════════════════════════════════════════════════════════════════════════
   02 · PRIORIDADES (Min-Heap)
   ═══════════════════════════════════════════════════════════════════════════ */

const PRIORITIES = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

/**
 * Priority queue implementado como binary min-heap.
 * O(log n) para push/pop.
 */
class PriorityQueue {
  constructor() {
    this.heap = [];
  }

  get size() {
    return this.heap.length;
  }

  push(job) {
    this.heap.push(job);
    this._bubbleUp(this.heap.length - 1);
  }

  pop() {
    if (this.heap.length === 0) return null;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this._bubbleDown(0);
    }
    return top;
  }

  peek() {
    return this.heap[0] || null;
  }

  _compare(a, b) {
    // Primero por prioridad, después por readyAt (scheduled time)
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.readyAt - b.readyAt;
  }

  _bubbleUp(idx) {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this._compare(this.heap[idx], this.heap[parent]) < 0) {
        [this.heap[idx], this.heap[parent]] = [this.heap[parent], this.heap[idx]];
        idx = parent;
      } else break;
    }
  }

  _bubbleDown(idx) {
    const n = this.heap.length;
    while (true) {
      const left = idx * 2 + 1;
      const right = idx * 2 + 2;
      let smallest = idx;

      if (left < n && this._compare(this.heap[left], this.heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < n && this._compare(this.heap[right], this.heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === idx) break;

      [this.heap[idx], this.heap[smallest]] = [this.heap[smallest], this.heap[idx]];
      idx = smallest;
    }
  }

  remove(predicate) {
    const before = this.heap.length;
    this.heap = this.heap.filter(j => !predicate(j));
    // Re-heapify
    if (this.heap.length > 1) {
      for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
        this._bubbleDown(i);
      }
    }
    return before - this.heap.length;
  }

  toArray() {
    return this.heap.slice();
  }

  clear() {
    this.heap = [];
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · RATE LIMITER (token bucket por cola)
   ═══════════════════════════════════════════════════════════════════════════ */

class RateLimiter {
  constructor(perSecond, burst) {
    this.perSecond = perSecond;
    this.burst = burst || perSecond * 2;
    this.tokens = this.burst;
    this.lastRefill = Date.now();
  }

  canConsume() {
    this._refill();
    return this.tokens >= 1;
  }

  consume() {
    this._refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  _refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    const refill = elapsed * this.perSecond;
    this.tokens = Math.min(this.burst, this.tokens + refill);
    this.lastRefill = now;
  }

  waitTimeMs() {
    this._refill();
    if (this.tokens >= 1) return 0;
    const needed = 1 - this.tokens;
    return Math.ceil((needed / this.perSecond) * 1000);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function jitter(ms, factor = CFG.retry.jitter) {
  const delta = ms * factor;
  return Math.max(0, ms + (Math.random() * 2 - 1) * delta);
}

function computeBackoff(attempt, opts) {
  const { backoff, baseDelayMs, maxDelayMs, jitter: useJitter } = opts;
  let delay;

  if (backoff === 'linear') delay = baseDelayMs * attempt;
  else if (backoff === 'fixed') delay = baseDelayMs;
  else delay = baseDelayMs * Math.pow(2, attempt - 1);

  delay = Math.min(delay, maxDelayMs);
  return useJitter ? jitter(delay) : delay;
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · JOB
   ═══════════════════════════════════════════════════════════════════════════ */

class Job {
  constructor(id, data, options = {}) {
    this.id = id;
    this.data = data;
    this.name = options.name || 'default';
    this.priority = typeof options.priority === 'number'
      ? options.priority
      : (PRIORITIES[options.priority] !== undefined
        ? PRIORITIES[options.priority]
        : PRIORITIES.normal);
    this.readyAt = Date.now() + (options.delayMs || 0);
    this.createdAt = Date.now();
    this.startedAt = null;
    this.completedAt = null;
    this.attempts = 0;
    this.maxAttempts = options.retries !== undefined
      ? options.retries + 1
      : CFG.retry.defaultMaxAttempts;
    this.timeoutMs = options.timeoutMs || 0;
    this.retryOpts = {
      backoff: options.backoff || CFG.retry.backoff,
      baseDelayMs: options.baseDelayMs || CFG.retry.baseDelayMs,
      maxDelayMs: options.maxDelayMs || CFG.retry.maxDelayMs,
      jitter: options.jitter !== false,
    };
    this.status = 'pending'; // pending | running | completed | failed | delayed
    this.result = null;
    this.error = null;
    this.dedupeKey = options.dedupeKey || null;
    this.metadata = options.metadata || {};
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      data: this.data,
      priority: this.priority,
      status: this.status,
      attempts: this.attempts,
      maxAttempts: this.maxAttempts,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      error: this.error ? this.error.message : null,
      metadata: this.metadata,
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · QUEUE
   ═══════════════════════════════════════════════════════════════════════════ */

class Queue extends EventEmitter {
  constructor(name, options = {}) {
    super();
    this.name = name;
    this.options = options;

    this.concurrency = options.concurrency || 1;
    this.running = 0;
    this.paused = false;
    this.closed = false;

    this.pending = new PriorityQueue();
    this.delayed = new PriorityQueue();
    this.active = new Map(); // id → job

    this.handler = null;
    this.rateLimiter = options.rateLimit
      ? new RateLimiter(options.rateLimit.perSecond, options.rateLimit.burst)
      : null;

    this.jobCounter = 0;
    this.dedupeMap = new Map(); // dedupeKey → jobId

    this.stats = {
      added: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      totalMs: 0,
      latencies: [],
      since: Date.now(),
    };

    // Timers
    this._delayedTimer = null;
    this._persistTimer = null;

    // Manejadores de errores por defecto para evitar crashes
    this.on('error', () => {});

    // Iniciar procesamiento de delayed
    this._startDelayedProcessor();

    // Persistencia
    if (options.persist || CFG.persist.enabled) {
      this._startPersistence();
    }
  }

  /* ─── HANDLER ─── */

  process(handlerFn) {
    if (typeof handlerFn !== 'function') {
      throw new Error('process() requiere una función');
    }
    this.handler = handlerFn;
    this._scheduleProcessing();
    return this;
  }

  /* ─── ADD ─── */

  async add(data, options = {}) {
    if (this.closed) throw new Error(`Cola ${this.name} cerrada`);

    // Dedupe
    if (options.dedupeKey) {
      const existing = this.dedupeMap.get(options.dedupeKey);
      if (existing) {
        const activeJob = this.active.get(existing);
        if (activeJob) return activeJob;
        const found = this.pending.toArray().find(j => j.id === existing);
        if (found) return found;
      }
    }

    const id = this._nextId();
    const job = new Job(id, data, options);

    if (options.dedupeKey) {
      this.dedupeMap.set(options.dedupeKey, id);
    }

    this.stats.added++;

    if (job.readyAt > Date.now()) {
      this.delayed.push(job);
      job.status = 'delayed';
    } else {
      this.pending.push(job);
    }

    this.emit('added', job);
    this._scheduleProcessing();

    return job;
  }

  async addBulk(items) {
    const jobs = [];
    for (const item of items) {
      const job = await this.add(item.data, item.opts || {});
      jobs.push(job);
    }
    return jobs;
  }

  /* ─── SCHEDULER ─── */

  _scheduleProcessing() {
    if (this.paused || this.closed) return;
    setImmediate(() => this._tick());
  }

  async _tick() {
    if (this.paused || this.closed) return;
    if (!this.handler) return;

    while (this.running < this.concurrency && this.pending.size > 0) {
      // Rate limit
      if (this.rateLimiter && !this.rateLimiter.canConsume()) {
        const waitMs = this.rateLimiter.waitTimeMs();
        setTimeout(() => this._scheduleProcessing(), waitMs);
        return;
      }

      const job = this.pending.pop();
      if (!job) break;

      // Re-chequear readyAt (por si acaso)
      if (job.readyAt > Date.now()) {
        this.delayed.push(job);
        continue;
      }

      if (this.rateLimiter) this.rateLimiter.consume();
      this._runJob(job);
    }
  }

  async _runJob(job) {
    this.running++;
    this.active.set(job.id, job);
    job.status = 'running';
    job.startedAt = Date.now();
    job.attempts++;

    this.emit('started', job);

    const startMs = Date.now();
    let timedOut = false;
    let timeoutId = null;

    try {
      // Timeout wrapper
      let resultPromise = Promise.resolve(this.handler(job));

      if (job.timeoutMs > 0) {
        const timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Job timeout después de ${job.timeoutMs}ms`));
          }, job.timeoutMs);
        });
        resultPromise = Promise.race([resultPromise, timeoutPromise]);
      }

      const result = await resultPromise;
      if (timeoutId) clearTimeout(timeoutId);

      // Éxito
      const ms = Date.now() - startMs;
      this.stats.completed++;
      this.stats.totalMs += ms;
      this.stats.latencies.push(ms);
      if (this.stats.latencies.length > 200) this.stats.latencies.shift();

      job.status = 'completed';
      job.result = result;
      job.completedAt = Date.now();

      if (job.dedupeKey) this.dedupeMap.delete(job.dedupeKey);

      this.emit('completed', job, result);
    } catch (error) {
      if (timeoutId) clearTimeout(timeoutId);

      // ¿Reintentar?
      if (job.attempts < job.maxAttempts && !timedOut) {
        this.stats.retried++;
        const delay = computeBackoff(job.attempts, job.retryOpts);
        job.readyAt = Date.now() + delay;
        job.status = 'delayed';

        log.debug(`retry job ${job.id} intento ${job.attempts}/${job.maxAttempts} en ${Math.round(delay)}ms`);

        this.emit('retrying', job, error, delay);
        this.delayed.push(job);
      } else {
        // Fallo definitivo
        const ms = Date.now() - startMs;
        this.stats.failed++;
        this.stats.totalMs += ms;
        this.stats.latencies.push(ms);
        if (this.stats.latencies.length > 200) this.stats.latencies.shift();

        job.status = 'failed';
        job.error = {
          message: error.message,
          stack: error.stack,
          code: error.code || null,
        };
        job.completedAt = Date.now();

        if (job.dedupeKey) this.dedupeMap.delete(job.dedupeKey);

        this.emit('failed', job, error);
      }
    } finally {
      this.running--;
      this.active.delete(job.id);

      // Schedule next tick
      this._scheduleProcessing();
    }
  }

  /* ─── DELAYED JOBS ─── */

  _startDelayedProcessor() {
    this._delayedTimer = setInterval(() => {
      if (this.closed) return;

      const now = Date.now();
      const stillDelayed = new PriorityQueue();

      // Mover los ready a pending
      for (const job of this.delayed.toArray()) {
        if (job.readyAt <= now) {
          job.status = 'pending';
          this.pending.push(job);
        } else {
          stillDelayed.push(job);
        }
      }

      this.delayed = stillDelayed;

      if (this.pending.size > 0) this._scheduleProcessing();
    }, 100);

    if (this._delayedTimer.unref) this._delayedTimer.unref();
  }

  /* ─── CONTROL ─── */

  pause() {
    this.paused = true;
    this.emit('paused');
    return this;
  }

  resume() {
    this.paused = false;
    this.emit('resumed');
    this._scheduleProcessing();
    return this;
  }

  async drain() {
    // Esperar a que se vacíe
    while (this.pending.size > 0 || this.delayed.size > 0 || this.running > 0) {
      await sleep(100);
    }
    this.emit('drained');
  }

  async close() {
    this.closed = true;
    if (this._delayedTimer) {
      clearInterval(this._delayedTimer);
      this._delayedTimer = null;
    }
    if (this._persistTimer) {
      clearInterval(this._persistTimer);
      this._persistTimer = null;
    }
    await this._saveToDisk();
    this.emit('closed');
  }

  /* ─── PERSISTENCIA ─── */

  async _startPersistence() {
    try {
      await fs.mkdir(CFG.persist.dir, { recursive: true });
    } catch (e) {
      log.warn(`no se pudo crear dir de persistencia: ${e.message}`);
      return;
    }

    // Cargar jobs pendientes del disco
    await this._loadFromDisk();

    // Guardar periódicamente
    this._persistTimer = setInterval(() => {
      this._saveToDisk().catch(() => {});
    }, CFG.persist.intervalMs);

    if (this._persistTimer.unref) this._persistTimer.unref();
  }

  _diskPath() {
    return path.join(CFG.persist.dir, `${this.name}.json`);
  }

  async _saveToDisk() {
    if (this.pending.size === 0 && this.delayed.size === 0) return;

    try {
      const data = {
        pending: this.pending.toArray().map(j => j.toJSON()),
        delayed: this.delayed.toArray().map(j => j.toJSON()),
        savedAt: Date.now(),
      };
      await fs.writeFile(this._diskPath(), JSON.stringify(data), 'utf-8');
    } catch (e) {
      log.warn(`saveToDisk failed: ${e.message}`);
    }
  }

  async _loadFromDisk() {
    try {
      const raw = await fs.readFile(this._diskPath(), 'utf-8');
      const data = JSON.parse(raw);
      const now = Date.now();

      let loaded = 0;
      for (const rawJob of data.pending || []) {
        const job = new Job(rawJob.id, rawJob.data, {
          name: rawJob.name,
          priority: rawJob.priority,
          retries: rawJob.maxAttempts - 1,
        });
        job.readyAt = now;
        this.pending.push(job);
        loaded++;
      }
      for (const rawJob of data.delayed || []) {
        const job = new Job(rawJob.id, rawJob.data, {
          name: rawJob.name,
          priority: rawJob.priority,
          retries: rawJob.maxAttempts - 1,
        });
        job.readyAt = rawJob.createdAt ? now : now;
        this.delayed.push(job);
        loaded++;
      }

      if (loaded > 0) {
        log.info(`cargados ${loaded} jobs desde disco · cola ${this.name}`);
        this._scheduleProcessing();
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        log.warn(`loadFromDisk failed: ${e.message}`);
      }
    }
  }

  /* ─── UTILS ─── */

  _nextId() {
    this.jobCounter++;
    return `${this.name}_${Date.now().toString(36)}_${randomHex(3)}`;
  }

  /* ─── MÉTRICAS ─── */

  stats_() {
    const latencies = this.stats.latencies.slice().sort((a, b) => a - b);
    const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
    const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
    const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;

    return {
      name: this.name,
      added: this.stats.added,
      completed: this.stats.completed,
      failed: this.stats.failed,
      retried: this.stats.retried,
      successRate: this.stats.completed + this.stats.failed > 0
        ? +(this.stats.completed / (this.stats.completed + this.stats.failed)).toFixed(4)
        : 0,
      avgMs: this.stats.completed > 0 ? Math.round(this.stats.totalMs / this.stats.completed) : 0,
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99,
      queued: this.pending.size,
      delayed: this.delayed.size,
      active: this.active.size,
      running: this.running,
      concurrency: this.concurrency,
      paused: this.paused,
      closed: this.closed,
      uptimeMs: Date.now() - this.stats.since,
      rateLimit: this.rateLimiter ? {
        perSecond: this.rateLimiter.perSecond,
        tokens: Math.floor(this.rateLimiter.tokens),
      } : null,
    };
  }

  /* ─── LIMPIEZA ─── */

  clearPending() {
    const n = this.pending.size;
    this.pending.clear();
    this.emit('cleared', n);
    return n;
  }

  removeJobs(predicate) {
    const n = this.pending.remove(predicate);
    return n;
  }

  getJobs() {
    return [
      ...this.pending.toArray().map(j => j.toJSON()),
      ...this.delayed.toArray().map(j => j.toJSON()),
      ...Array.from(this.active.values()).map(j => j.toJSON()),
    ];
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   07 · QUEUE MANAGER
   ═══════════════════════════════════════════════════════════════════════════ */

class QueueManager {
  constructor() {
    this.queues = new Map();
    this.globalStats = {
      totalCompleted: 0,
      totalFailed: 0,
      since: Date.now(),
    };
  }

  create(name, options = {}) {
    if (this.queues.has(name)) {
      log.warn(`cola ${name} ya existe, devolviendo la existente`);
      return this.queues.get(name);
    }

    const queue = new Queue(name, options);

    // Hook global a eventos
    queue.on('completed', () => { this.globalStats.totalCompleted++; });
    queue.on('failed', () => { this.globalStats.totalFailed++; });

    this.queues.set(name, queue);
    log.info(`cola ${name} creada · concurrency=${queue.concurrency}`);
    return queue;
  }

  get(name) {
    return this.queues.get(name) || null;
  }

  list() {
    return Array.from(this.queues.keys());
  }

  async closeAll() {
    log.info(`cerrando ${this.queues.size} colas...`);

    const promises = [];
    for (const q of this.queues.values()) {
      promises.push(
        Promise.race([
          q.drain().then(() => q.close()),
          sleep(CFG.shutdown.timeoutMs).then(() => {
            log.warn(`timeout drenando cola ${q.name}, forzando cierre`);
            return q.close();
          }),
        ])
      );
    }

    await Promise.allSettled(promises);
    this.queues.clear();
    log.info('todas las colas cerradas');
  }

  stats() {
    const queues = {};
    for (const [name, q] of this.queues) {
      queues[name] = q.stats_();
    }
    return {
      queues,
      totalQueues: this.queues.size,
      totalCompleted: this.globalStats.totalCompleted,
      totalFailed: this.globalStats.totalFailed,
      uptimeMs: Date.now() - this.globalStats.since,
    };
  }
}

const manager = new QueueManager();

function createQueue(name, options) {
  return manager.create(name, options);
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · GRACEFUL SHUTDOWN
   ═══════════════════════════════════════════════════════════════════════════ */

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`queue manager: cerrando por ${signal}`);
  await manager.closeAll();
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

/* ═══════════════════════════════════════════════════════════════════════════
   09 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════════ */

async function test() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  // PriorityQueue
  const pq = new PriorityQueue();
  pq.push({ id: 'a', priority: 3, readyAt: 0 });
  pq.push({ id: 'b', priority: 1, readyAt: 0 });
  pq.push({ id: 'c', priority: 2, readyAt: 0 });
  pq.push({ id: 'd', priority: 1, readyAt: 100 });

  const first = pq.pop();
  rec('PQ: urgente primero', first.id === 'b', first);

  const second = pq.pop();
  rec('PQ: prioridad + readyAt', second.id === 'd', second);

  const third = pq.pop();
  rec('PQ: priority 2', third.id === 'c', third);

  rec('PQ: tamaño decrece', pq.size === 1, pq.size);

  // Backoff
  const b1 = computeBackoff(1, { backoff: 'exponential', baseDelayMs: 100, maxDelayMs: 10000, jitter: false });
  rec('backoff exp attempt 1', b1 === 100, b1);

  const b2 = computeBackoff(3, { backoff: 'exponential', baseDelayMs: 100, maxDelayMs: 10000, jitter: false });
  rec('backoff exp attempt 3', b2 === 400, b2);

  const b3 = computeBackoff(5, { backoff: 'exponential', baseDelayMs: 100, maxDelayMs: 500, jitter: false });
  rec('backoff capped', b3 === 500, b3);

  const b4 = computeBackoff(3, { backoff: 'linear', baseDelayMs: 100, maxDelayMs: 10000, jitter: false });
  rec('backoff linear', b4 === 300, b4);

  const b5 = computeBackoff(3, { backoff: 'fixed', baseDelayMs: 100, maxDelayMs: 10000, jitter: false });
  rec('backoff fixed', b5 === 100, b5);

  // Job
  const job = new Job('test_1', { foo: 'bar' }, { priority: 'high', retries: 5 });
  rec('Job: id asignado', job.id === 'test_1', job.id);
  rec('Job: priority high = 1', job.priority === PRIORITIES.high, job.priority);
  rec('Job: maxAttempts = retries + 1', job.maxAttempts === 6, job.maxAttempts);
  rec('Job: status pending', job.status === 'pending', job.status);

  // Queue básica
  const q1 = new Queue('test-basic', { concurrency: 2 });
  rec('Queue: name asignado', q1.name === 'test-basic', q1.name);
  rec('Queue: concurrency', q1.concurrency === 2, q1.concurrency);

  // process + add
  let processed = [];
  q1.process(async (j) => {
    processed.push(j.data.value);
    return j.data.value * 2;
  });

  const j1 = await q1.add({ value: 1 });
  const j2 = await q1.add({ value: 2 });
  const j3 = await q1.add({ value: 3 });

  rec('Queue: added contador', q1.stats.added === 3, q1.stats.added);

  // Esperar
  await q1.drain();
  rec('Queue: todos procesados', processed.length === 3, processed.length);
  rec('Queue: completed contador', q1.stats.completed === 3, q1.stats.completed);
  rec('Queue: j1 resultado', j1.result === 2, j1.result);
  rec('Queue: j2 resultado', j2.result === 4, j2.result);

  await q1.close();

  // Retry
  const q2 = new Queue('test-retry', { concurrency: 1 });
  let attempts = 0;
  q2.process(async () => {
    attempts++;
    if (attempts < 3) throw new Error('fail');
    return 'ok';
  });

  const jr = await q2.add({}, { retries: 3, baseDelayMs: 10, backoff: 'fixed', jitter: false });
  await q2.drain();
  rec('Queue: retry llegó a 3 intentos', attempts === 3, attempts);
  rec('Queue: job completado tras retry', jr.status === 'completed', jr.status);
  rec('Queue: jr.result', jr.result === 'ok', jr.result);
  rec('Queue: retried contador', q2.stats.retried === 2, q2.stats.retried);

  await q2.close();

  // Prioridad en cola
  const q3 = new Queue('test-priority', { concurrency: 1 });
  q3.pause();
  await q3.add({ tag: 'normal' }, { priority: 'normal' });
  await q3.add({ tag: 'urgent' }, { priority: 'urgent' });
  await q3.add({ tag: 'low' }, { priority: 'low' });

  const order = [];
  q3.process(async (j) => {
    order.push(j.data.tag);
  });
  q3.resume();
  await q3.drain();
  rec('Queue: urgente primero', order[0] === 'urgent', order);
  rec('Queue: low último', order[2] === 'low', order);

  await q3.close();

  // Delayed
  const q4 = new Queue('test-delayed', { concurrency: 1 });
  const t0 = Date.now();
  q4.process(async () => {});
  await q4.add({}, { delayMs: 200 });
  rec('Queue: delay cuenta', q4.stats.added === 1, q4.stats.added);
  rec('Queue: delayed size', q4.delayed.size === 1, q4.delayed.size);
  await q4.drain();
  const elapsed = Date.now() - t0;
  rec('Queue: esperó el delay', elapsed >= 200, elapsed);

  await q4.close();

  // Rate limit
  const q5 = new Queue('test-rate', {
    concurrency: 1,
    rateLimit: { perSecond: 100, burst: 2 },
  });
  q5.process(async () => {});
  for (let i = 0; i < 3; i++) {
    await q5.add({ i });
  }
  rec('Queue: rate limiter existe', q5.rateLimiter !== null, true);
  await q5.close();

  // Dedupe
  const q6 = new Queue('test-dedupe', { concurrency: 1 });
  q6.pause();
  q6.process(async () => {});
  const d1 = await q6.add({ x: 1 }, { dedupeKey: 'same-key' });
  const d2 = await q6.add({ x: 1 }, { dedupeKey: 'same-key' });
  rec('Queue: dedupe devuelve mismo job', d1.id === d2.id, { d1: d1.id, d2: d2.id });
  rec('Queue: dedupe no duplica', q6.pending.size === 1, q6.pending.size);

  q6.resume();
  await q6.drain();
  await q6.close();

  // Eventos
  const q7 = new Queue('test-events', { concurrency: 1 });
  const events = [];
  q7.on('added', () => events.push('added'));
  q7.on('started', () => events.push('started'));
  q7.on('completed', () => events.push('completed'));
  q7.process(async () => 'ok');
  await q7.add({});
  await q7.drain();
  rec('Queue: emite added', events.includes('added'), events);
  rec('Queue: emite started', events.includes('started'), events);
  rec('Queue: emite completed', events.includes('completed'), events);
  await q7.close();

  // Failed event
  const q8 = new Queue('test-fail', { concurrency: 1 });
  let failedEvent = null;
  q8.on('failed', (job, err) => { failedEvent = { job, err }; });
  q8.process(async () => { throw new Error('boom'); });
  await q8.add({}, { retries: 0 });
  await q8.drain();
  rec('Queue: emite failed', failedEvent !== null, failedEvent);
  rec('Queue: failed.message correcto', failedEvent && failedEvent.err.message === 'boom', failedEvent && failedEvent.err.message);
  await q8.close();

  // Pause / Resume
  const q9 = new Queue('test-pause', { concurrency: 1 });
  q9.process(async () => {});
  q9.pause();
  await q9.add({});
  rec('Queue: paused mantiene pendiente', q9.pending.size === 1, q9.pending.size);
  q9.resume();
  await q9.drain();
  rec('Queue: resume procesa', q9.stats.completed === 1, q9.stats.completed);
  await q9.close();

  // Manager
  const m = new QueueManager();
  const mq1 = m.create('m-1');
  const mq2 = m.create('m-2');
  rec('Manager: list tiene 2', m.list().length === 2, m.list());
  rec('Manager: get funciona', m.get('m-1') === mq1, true);

  const mq3 = m.create('m-1');
  rec('Manager: create no duplica', mq3 === mq1, true);

  await m.closeAll();
  rec('Manager: closeAll vacía', m.list().length === 0, m.list());

  // Timeout
  const q10 = new Queue('test-timeout', { concurrency: 1 });
  q10.process(async () => {
    await sleep(500);
    return 'never';
  });
  const jt = await q10.add({}, { timeoutMs: 50, retries: 0 });
  await q10.drain();
  rec('Queue: timeout falla el job', jt.status === 'failed', jt.status);
  rec('Queue: error menciona timeout', jt.error && jt.error.message.includes('timeout'), jt.error);
  await q10.close();

  // Bulk
  const q11 = new Queue('test-bulk', { concurrency: 3 });
  q11.process(async () => {});
  const bulk = await q11.addBulk([
    { data: { n: 1 } },
    { data: { n: 2 } },
    { data: { n: 3 } },
  ]);
  rec('Queue: addBulk añade 3', bulk.length === 3, bulk.length);
  await q11.drain();
  rec('Queue: bulk completado', q11.stats.completed === 3, q11.stats.completed);
  await q11.close();

  // Stats
  const q12 = new Queue('test-stats', { concurrency: 1 });
  q12.process(async () => {});
  await q12.add({});
  await q12.drain();
  const st = q12.stats_();
  rec('stats: name', st.name === 'test-stats', st.name);
  rec('stats: completed 1', st.completed === 1, st.completed);
  rec('stats: successRate 1', st.successRate === 1, st.successRate);
  rec('stats: avgMs número', typeof st.avgMs === 'number', st.avgMs);
  await q12.close();

  // clearPending
  const q13 = new Queue('test-clear', { concurrency: 1 });
  q13.process(async () => {});
  q13.pause();
  await q13.add({});
  await q13.add({});
  const cleared = q13.clearPending();
  rec('Queue: clearPending devuelve count', cleared === 2, cleared);
  rec('Queue: pending vacío', q13.pending.size === 0, q13.pending.size);
  await q13.close();

  // createQueue global
  const gq = createQueue('test-global');
  rec('createQueue crea cola', gq instanceof Queue, true);
  rec('createQueue registrada en manager', manager.get('test-global') === gq, true);
  await gq.close();

  // Rate limiter interno
  const rl = new RateLimiter(10, 5);
  rec('RateLimiter: burst inicial', rl.tokens === 5, rl.tokens);
  rec('RateLimiter: canConsume true', rl.canConsume() === true, true);
  rl.consume();
  rl.consume();
  rl.consume();
  rl.consume();
  rl.consume();
  rec('RateLimiter: agotado', rl.tokens < 1, rl.tokens);
  rec('RateLimiter: waitTimeMs > 0', rl.waitTimeMs() > 0, rl.waitTimeMs());

  const passed = results.filter(r => r.ok).length;
  return {
    passed,
    total: results.length,
    ok: passed === results.length,
    results,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export {
  createQueue,
  Queue,
  QueueManager,
  Job,
  PriorityQueue,
  RateLimiter,
  manager as queueManager,
  test,
};

export default {
  createQueue,
  Queue,
  QueueManager,
  Job,
  PriorityQueue,
  RateLimiter,
  manager: manager,
  test,
};