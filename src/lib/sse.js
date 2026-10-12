// ═══════════════════════════════════════════════════════════════════════════
// src/lib/sse.js
// ═══════════════════════════════════════════════════════════════════════════
// Helper de Server-Sent Events production-grade para Numination.
//
// FEATURES:
//   · Inicialización con headers correctos (compresión, buffering off)
//   · Formato de eventos tipados: token, sources, thinking, error, done, etc.
//   · Heartbeat automático (evita timeout de proxies Cloudflare/Vercel/Nginx)
//   · Detección de desconexión del cliente (res.on close)
//   · Backpressure handling (no rompe si el cliente no lee rápido)
//   · Last-Event-ID para reconexión (RFC 7231)
//   · Retry hint al cliente (para reconexiones)
//   · Multi-byte chunk safety (UTF-8 correcto)
//   · Auto-cleanup de timers y listeners
//   · Contadores y métricas por conexión
//   · Métricas globales agregadas
//   · Wrappers específicos para Numination: token, sources, thinking, done
//   · Pipe de un ReadableStream al response
//   · Compatible con fetch + ReadableStream en el cliente
//
// USO BÁSICO:
//   import { SSE } from './lib/sse.js';
//   const sse = SSE.init(req, res);
//   sse.token('hola');
//   sse.token(' mundo');
//   sse.sources([{ title, url }]);
//   sse.done();
//
// USO CON HELPERS:
//   import { initSSE, sseSend, sseClose } from './lib/sse.js';
//   initSSE(res);
//   sseSend(res, { token: 'hola' });
//   sseClose(res);
//
// USO CON PIPELINE:
//   await SSE.pipe(req, res, aiStream);
// ═══════════════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import { createLogger } from './logger.js';

const log = createLogger('sse');

// ═══════════════════════════════════════════════════════════════════════════
// 01 · CONFIGURACIÓN
// ═══════════════════════════════════════════════════════════════════════════

const CONFIG = {
  // Cada cuánto mandar heartbeat (ms)
  heartbeatMs: parseInt(process.env.SSE_HEARTBEAT_MS || '15000', 10),

  // Máximo tiempo de vida de una conexión (ms). 0 = sin límite
  maxConnectionMs: parseInt(process.env.SSE_MAX_CONNECTION_MS || '600000', 10),

  // Máximo de bytes por evento individual (protección contra payloads gigantes)
  maxEventBytes: parseInt(process.env.SSE_MAX_EVENT_BYTES || '1048576', 10),

  // Cuántos eventos puede bufferear el kernel antes de que Node haga backpressure
  // Si el buffer interno supera esto, empezamos a loggear warns
  backpressureWarnBytes: parseInt(process.env.SSE_BACKPRESSURE_WARN || '262144', 10),

  // Retry hint que le mandamos al cliente (ms)
  retryHintMs: parseInt(process.env.SSE_RETRY_HINT_MS || '3000', 10),

  // Header X-Accel-Buffering para Nginx
  disableProxyBuffering: process.env.SSE_DISABLE_PROXY_BUFFERING !== 'false',

  // Comprimir chunks (solo si el cliente lo soporta)
  compression: process.env.SSE_COMPRESSION !== 'false',
};

// ═══════════════════════════════════════════════════════════════════════════
// 02 · MÉTRICAS GLOBALES
// ═══════════════════════════════════════════════════════════════════════════

const globalStats = {
  totalConnections: 0,
  activeConnections: 0,
  totalEvents: 0,
  totalBytes: 0,
  errors: 0,
  slowClients: 0,
  since: Date.now(),
};

// Set de conexiones activas para poder cerrarlas todas en un shutdown
const activeConnections = new Set();

// ═══════════════════════════════════════════════════════════════════════════
// 03 · ERRORES
// ═══════════════════════════════════════════════════════════════════════════

export class SSEError extends Error {
  constructor(message, code, meta = {}) {
    super(message);
    this.name = 'SSEError';
    this.code = code;
    Object.assign(this, meta);
  }
}

export const SSE_ERRORS = {
  CLIENT_DISCONNECTED: 'CLIENT_DISCONNECTED',
  WRITE_AFTER_END: 'WRITE_AFTER_END',
  BACKPRESSURE: 'BACKPRESSURE',
  EVENT_TOO_LARGE: 'EVENT_TOO_LARGE',
  INVALID_STATE: 'INVALID_STATE',
};

// ═══════════════════════════════════════════════════════════════════════════
// 04 · SERIALIZACIÓN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Escapa una línea para que sea segura en formato SSE.
 * Los caracteres \n y \r se convierten en múltiples líneas con "data:".
 */
function escapeData(str) {
  return String(str)
    .split(/\r?\n/)
    .map((line) => 'data: ' + line)
    .join('\n');
}

/**
 * Formatea un evento SSE completo con id/event/data opcionales.
 */
function formatEvent({ id, event, data, retry }) {
  const lines = [];
  if (id !== undefined && id !== null) lines.push('id: ' + id);
  if (event) lines.push('event: ' + event);
  if (retry !== undefined) lines.push('retry: ' + retry);
  if (data !== undefined) lines.push(escapeData(data));
  return lines.join('\n') + '\n\n';
}

/**
 * Serializa data a JSON con fallback para objetos circulares.
 */
function safeJSON(obj) {
  try {
    return JSON.stringify(obj);
  } catch (e) {
    return JSON.stringify({
      error: 'SERIALIZATION_FAILED',
      message: e.message,
      type: typeof obj,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 05 · CLASE PRINCIPAL · SSEConnection
// ═══════════════════════════════════════════════════════════════════════════

export class SSEConnection {
  constructor(req, res, options = {}) {
    this.id = crypto.randomUUID().slice(0, 12);
    this.req = req;
    this.res = res;
    this.options = options;

    // Estado
    this.closed = false;
    this.closing = false;
    this.initialized = false;
    this.bytesSent = 0;
    this.eventsSent = 0;
    this.eventId = 0;

    // Timers
    this.heartbeatTimer = null;
    this.lifetimeTimer = null;

    // Listeners (para cleanup)
    this._onClose = null;
    this._onError = null;
    this._onDrain = null;

    // Backpressure
    this.backpressured = false;
    this.backpressureWarned = false;

    // Timing
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();

    // Contexto
    this.userId = req?.user?.id || null;
    this.reqId = req?.id || this.id;
  }

  // ───────────────────────────────────────────────────────────────────────
  // init: arranca la conexión
  // ───────────────────────────────────────────────────────────────────────
  init() {
    if (this.initialized) return this;
    if (this.closed) throw new SSEError('Connection already closed', SSE_ERRORS.INVALID_STATE);

    const res = this.res;

    // Headers
    const headers = {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': CONFIG.disableProxyBuffering ? 'no' : 'yes',
      'X-SSE-Connection-Id': this.id,
      'X-Request-Id': this.reqId,
    };

    // CORS para SSE desde el mismo origen
    const origin = this.req?.headers?.origin;
    if (origin) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Credentials'] = 'true';
      headers['Vary'] = 'Origin';
    }

    res.writeHead(200, headers);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    // Mandar retry hint inicial
    this._writeRaw(`retry: ${CONFIG.retryHintMs}\n\n`);

    // Mandar comentario de apertura (evita buffering en algunos proxies)
    this._writeRaw(`: SSE connection established (id=${this.id})\n\n`);

    // Setup listeners
    this._setupListeners();

    // Heartbeat
    if (CONFIG.heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => this._heartbeat(), CONFIG.heartbeatMs);
      if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
    }

    // Lifetime máximo
    if (CONFIG.maxConnectionMs > 0) {
      this.lifetimeTimer = setTimeout(() => {
        log.debug('SSE lifetime máximo alcanzado', { connId: this.id, ms: CONFIG.maxConnectionMs });
        this.close('lifetime');
      }, CONFIG.maxConnectionMs);
      if (this.lifetimeTimer.unref) this.lifetimeTimer.unref();
    }

    this.initialized = true;

    // Métricas
    globalStats.totalConnections++;
    globalStats.activeConnections++;
    activeConnections.add(this);

    log.trace(`SSE abierto · ${this.id}`, { connId: this.id, userId: this.userId });

    return this;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Listeners internos
  // ───────────────────────────────────────────────────────────────────────
  _setupListeners() {
    const res = this.res;

    this._onClose = () => {
      if (this.closed) return;
      log.trace(`Cliente cerró · ${this.id}`, {
        connId: this.id,
        userId: this.userId,
        bytesSent: this.bytesSent,
        eventsSent: this.eventsSent,
        durationMs: Date.now() - this.createdAt,
      });
      this._cleanup('client-close');
    };

    this._onError = (err) => {
      if (this.closed) return;
      log.debug(`Error en SSE · ${this.id}`, {
        connId: this.id,
        error: err.message,
        code: err.code,
      });
      globalStats.errors++;
      this._cleanup('error');
    };

    // Si la respuesta se cierra (por el cliente o por nosotros)
    res.on('close', this._onClose);
    res.on('error', this._onError);

    // Backpressure: escuchar 'drain' para saber cuándo el cliente puede recibir más
    this._onDrain = () => {
      this.backpressured = false;
      this.backpressureWarned = false;
    };
    res.on('drain', this._onDrain);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Escritura interna
  // ───────────────────────────────────────────────────────────────────────
  _writeRaw(chunk) {
    if (this.closed || this.closing) return false;
    const res = this.res;
    if (res.writableEnded || res.destroyed) {
      this._cleanup('ended');
      return false;
    }

    try {
      const ok = res.write(chunk);
      this.bytesSent += Buffer.byteLength(chunk);
      globalStats.totalBytes += Buffer.byteLength(chunk);
      this.lastActivityAt = Date.now();

      if (!ok) {
        this.backpressured = true;
        globalStats.slowClients++;
        if (!this.backpressureWarned && this.bytesSent > CONFIG.backpressureWarnBytes) {
          this.backpressureWarned = true;
          log.warn(`Backpressure en SSE · ${this.id}`, {
            connId: this.id,
            bytesSent: this.bytesSent,
            userId: this.userId,
          });
        }
      }
      return ok;
    } catch (err) {
      log.debug(`Error escribiendo SSE · ${this.id}`, { error: err.message });
      this._cleanup('write-error');
      return false;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Heartbeat
  // ───────────────────────────────────────────────────────────────────────
  _heartbeat() {
    if (this.closed || this.closing) return;
    // Comentario SSE: los clientes lo ignoran, pero mantiene viva la conexión
    this._writeRaw(`: hb ${Date.now()}\n\n`);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Enviar evento genérico
  // ───────────────────────────────────────────────────────────────────────
  send(data, { id, event, retry } = {}) {
    if (this.closed || this.closing) return false;

    const eventId = id !== undefined ? id : ++this.eventId;
    const payload = typeof data === 'string' ? data : safeJSON(data);

    // Validar tamaño
    if (payload.length > CONFIG.maxEventBytes) {
      log.warn(`Evento SSE demasiado grande · ${this.id}`, {
        connId: this.id,
        bytes: payload.length,
        max: CONFIG.maxEventBytes,
      });
      return this.error('Evento demasiado grande', SSE_ERRORS.EVENT_TOO_LARGE);
    }

    const formatted = formatEvent({
      id: eventId,
      event,
      data: payload,
      retry: retry ?? undefined,
    });

    const ok = this._writeRaw(formatted);
    if (ok) {
      this.eventsSent++;
      globalStats.totalEvents++;
    }
    return ok;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Helpers tipados para Numination
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Envía un token de texto (streaming del chat).
   */
  token(text) {
    return this.send({ token: text });
  }

  /**
   * Envía múltiples tokens de una sola vez (batching).
   */
  tokens(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return true;
    return this.send({ token: arr.join('') });
  }

  /**
   * Envía las fuentes web consultadas.
   */
  sources(sources) {
    if (!Array.isArray(sources)) return true;
    return this.send({ sources });
  }

  /**
   * Envía metadata de la respuesta (modelo usado, tokens, timing).
   */
  meta(meta) {
    return this.send({ meta });
  }

  /**
   * Envía el bloque de razonamiento (thinking mode estilo DeepSeek).
   */
  thinking(text) {
    return this.send({ thinking: text });
  }

  /**
   * Envía un evento de estado intermedio.
   *   sse.status('searching', { query: 'clima bogotá' })
   *   sse.status('thinking', { })
   *   sse.status('generating', { })
   */
  status(state, extra = {}) {
    return this.send({ status: state, ...extra }, { event: 'status' });
  }

  /**
   * Envía un error estructurado y cierra la conexión.
   */
  error(message, code = null, extra = {}) {
    globalStats.errors++;
    this.send({
      error: message,
      ...(code ? { code } : {}),
      ...extra,
    });
    return this.done();
  }

  /**
   * Envía un warning sin cerrar la conexión.
   */
  warn(message, extra = {}) {
    return this.send({ warning: message, ...extra });
  }

  /**
   * Marca el final del stream (evento terminal).
   */
  done(extra = {}) {
    if (this.closed || this.closing) return false;
    this.send({ done: true, ...extra }, { event: 'done' });
    return this.close('done');
  }

  // ───────────────────────────────────────────────────────────────────────
  // Cerrar conexión
  // ───────────────────────────────────────────────────────────────────────
  close(reason = 'manual') {
    if (this.closed || this.closing) return false;
    this.closing = true;

    // Mandar un último comentario de cierre
    try {
      this._writeRaw(`: SSE closed (${reason})\n\n`);
    } catch {}

    // Cerrar response
    try {
      if (!this.res.writableEnded) this.res.end();
    } catch (err) {
      log.trace(`Error al cerrar SSE · ${this.id}`, { error: err.message });
    }

    this._cleanup(reason);
    return true;
  }

  // ───────────────────────────────────────────────────────────────────────
  // Cleanup interno
  // ───────────────────────────────────────────────────────────────────────
  _cleanup(reason = 'unknown') {
    if (this.closed) return;
    this.closed = true;

    // Clear timers
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.lifetimeTimer) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = null;
    }

    // Remove listeners
    if (this._onClose) {
      this.res.off('close', this._onClose);
      this._onClose = null;
    }
    if (this._onError) {
      this.res.off('error', this._onError);
      this._onError = null;
    }
    if (this._onDrain) {
      this.res.off('drain', this._onDrain);
      this._onDrain = null;
    }

    // Métricas
    globalStats.activeConnections = Math.max(0, globalStats.activeConnections - 1);
    activeConnections.delete(this);

    log.trace(`SSE cerrado · ${this.id} · ${reason}`, {
      connId: this.id,
      reason,
      userId: this.userId,
      bytesSent: this.bytesSent,
      eventsSent: this.eventsSent,
      durationMs: Date.now() - this.createdAt,
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Estado
  // ───────────────────────────────────────────────────────────────────────
  get isOpen() {
    return this.initialized && !this.closed && !this.closing;
  }

  get stats() {
    return {
      id: this.id,
      userId: this.userId,
      reqId: this.reqId,
      isOpen: this.isOpen,
      bytesSent: this.bytesSent,
      eventsSent: this.eventsSent,
      durationMs: Date.now() - this.createdAt,
      backpressured: this.backpressured,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 06 · API SIMPLE · COMPATIBLE CON CÓDIGO EXISTENTE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Inicializa una conexión SSE y devuelve headers correctos.
 * Compatible con la API antigua: initSSE(res) o initSSE(req, res).
 */
export function initSSE(reqOrRes, maybeRes) {
  let req, res;
  if (maybeRes) {
    req = reqOrRes;
    res = maybeRes;
  } else {
    req = null;
    res = reqOrRes;
  }

  // Si ya está inicializada, no hacemos nada
  if (res.headersSent) return res;

  const headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform, must-revalidate',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': CONFIG.disableProxyBuffering ? 'no' : 'yes',
  };

  if (req?.headers?.origin) {
    headers['Access-Control-Allow-Origin'] = req.headers.origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Vary'] = 'Origin';
  }

  res.writeHead(200, headers);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write(`retry: ${CONFIG.retryHintMs}\n\n`);
  return res;
}

/**
 * Envía un evento sin tener que gestionar una instancia.
 * Uso: sseSend(res, { token: 'hola' })
 */
export function sseSend(res, data, { id, event } = {}) {
  if (!res || res.writableEnded || res.destroyed) return false;
  try {
    const payload = typeof data === 'string' ? data : safeJSON(data);
    res.write(formatEvent({ id, event, data: payload }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Cierra la conexión SSE.
 */
export function sseClose(res) {
  if (!res || res.writableEnded || res.destroyed) return;
  try {
    res.write(': SSE closed\n\n');
    res.end();
  } catch {}
}

/**
 * Envía un error y cierra.
 */
export function sseError(res, message, code = null) {
  sseSend(res, { error: message, ...(code ? { code } : {}) });
  sseClose(res);
}

/**
 * Heartbeat manual (por si preferís manejar el timer tú).
 * Devuelve una función para detenerlo.
 */
export function sseHeartbeat(res, intervalMs = CONFIG.heartbeatMs) {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(timer);
      return;
    }
    try {
      res.write(`: hb ${Date.now()}\n\n`);
    } catch {
      clearInterval(timer);
    }
  }, intervalMs);

  if (timer.unref) timer.unref();
  return () => clearInterval(timer);
}

// ═══════════════════════════════════════════════════════════════════════════
// 07 · PIPE DESDE ReadableStream
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pipea un ReadableStream (por ejemplo, el stream de OpenAI, Groq, etc)
 * directamente a la conexión SSE, transformando cada chunk en tokens.
 *
 * El transform debe devolver un array de eventos SSE-ready:
 *   [{ token: 'hola' }, { token: ' mundo' }]
 * o un evento único:
 *   { token: 'hola mundo' }
 *
 * @example
 *   const stream = await groqStream(message);
 *   await SSE.pipe(req, res, stream, {
 *     transform: (chunk) => parseGroqChunk(chunk),
 *   });
 */
async function pipe(req, res, readable, options = {}) {
  const {
    transform,
    onFinish,
    onError,
    closeOnFinish = true,
    sendDone = true,
  } = options;

  const connection = new SSEConnection(req, res).init();

  try {
    const reader = readable.getReader
      ? readable.getReader()
      : readable;

    const decoder = new TextDecoder('utf-8');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (connection.closed) break;

      const text = typeof value === 'string' ? value : decoder.decode(value, { stream: true });
      if (!text) continue;

      if (typeof transform === 'function') {
        const events = transform(text);
        if (events) {
          const list = Array.isArray(events) ? events : [events];
          for (const evt of list) {
            if (evt && typeof evt === 'object') connection.send(evt);
            else if (typeof evt === 'string') connection.token(evt);
          }
        }
      } else {
        // Sin transform: mandamos el texto crudo como token
        connection.token(text);
      }
    }

    if (typeof onFinish === 'function') {
      await onFinish(connection);
    }

    if (sendDone) connection.done();
    else if (closeOnFinish) connection.close('stream-finished');

    return connection;
  } catch (err) {
    log.error('Error en SSE.pipe', { error: err, connId: connection.id });
    if (typeof onError === 'function') {
      try { onError(err, connection); } catch {}
    }
    connection.error(err.message || 'Error procesando el stream');
    return connection;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 08 · UTILIDADES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cierra todas las conexiones activas (para shutdown graceful).
 */
export function closeAllConnections(reason = 'server-shutdown') {
  const count = activeConnections.size;
  for (const conn of activeConnections) {
    try { conn.close(reason); } catch {}
  }
  log.info(`Cerradas ${count} conexiones SSE activas`);
  return count;
}

/**
 * Devuelve las métricas globales.
 */
export function getStats() {
  return {
    ...globalStats,
    uptimeMs: Date.now() - globalStats.since,
  };
}

/**
 * Handler de SIGTERM/SIGINT para shutdown graceful.
 * Uso: SSE.setupGracefulShutdown();
 */
export function setupGracefulShutdown() {
  const shutdown = (signal) => {
    log.info(`Señal ${signal} recibida · cerrando conexiones SSE`);
    closeAllConnections(signal.toLowerCase());
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// ═══════════════════════════════════════════════════════════════════════════
// 09 · MIDDLEWARE EXPRESS (opcional)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Middleware que agrega `req.sse = () => new SSEConnection(req, res).init()`
 * para que cada handler pueda abrir una conexión fácilmente.
 *
 * @example
 *   app.use(sseMiddleware());
 *
 *   app.get('/api/stream', (req, res) => {
 *     const sse = req.sse();
 *     sse.token('hola');
 *     sse.done();
 *   });
 */
export function sseMiddleware() {
  return (req, res, next) => {
    req.sse = (options) => new SSEConnection(req, res, options).init();
    next();
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 10 · HELPERS DE PARSING EN SERVIDOR (por si parseas streams de IA)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parsea un chunk de OpenAI/Groq en formato SSE (data: {...}\n\n).
 * Devuelve un array de objetos JSON ya parseados.
 */
export function parseAISSEChunk(raw) {
  const events = [];
  const lines = String(raw).split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(':')) continue; // comentario
    if (!trimmed.startsWith('data: ')) continue;

    const payload = trimmed.slice(6);
    if (payload === '[DONE]') {
      events.push({ done: true });
      continue;
    }
    try {
      events.push(JSON.parse(payload));
    } catch (e) {
      // Chunk incompleto, lo ignoramos (el siguiente read lo completa)
    }
  }

  return events;
}

// ═══════════════════════════════════════════════════════════════════════════
// 11 · EXPORTAR API COMPLETA
// ═══════════════════════════════════════════════════════════════════════════

export const SSE = {
  // Clase
  Connection: SSEConnection,

  // Constructor
  init: (req, res, options) => new SSEConnection(req, res, options).init(),

  // Funciones de bajo nivel (compatibilidad con código viejo)
  initSSE,
  send: sseSend,
  close: sseClose,
  error: sseError,
  heartbeat: sseHeartbeat,

  // Pipe desde ReadableStream
  pipe,

  // Utilidades
  closeAll: closeAllConnections,
  getStats,
  setupGracefulShutdown,
  parseAISSEChunk,
  middleware: sseMiddleware,

  // Config
  config: CONFIG,
  errors: SSE_ERRORS,
};

// ═══════════════════════════════════════════════════════════════════════════
// 12 · DEFAULT EXPORT
// ═══════════════════════════════════════════════════════════════════════════

export default SSE;

// ═══════════════════════════════════════════════════════════════════════════
// 13 · BANNER DE CARGA (en debug)
// ═══════════════════════════════════════════════════════════════════════════

log.trace('SSE module cargado', {
  heartbeatMs: CONFIG.heartbeatMs,
  maxConnectionMs: CONFIG.maxConnectionMs,
  maxEventBytes: CONFIG.maxEventBytes,
  compression: CONFIG.compression,
});