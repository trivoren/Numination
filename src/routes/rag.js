/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/rag.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   API de ingesta RAG (PDF → pgvector).

   MONTADO
     mountRagRoutes(app) → añade:
       POST   /api/rag/upload          sube un PDF y lo indexa
       GET    /api/rag/jobs/:jobId     progreso del procesamiento
       GET    /api/rag/documents       lista los documentos del usuario
       DELETE /api/rag/documents/:id   borra un documento (y sus chunks)
       POST   /api/rag/search          busca fragmentos relevantes
       POST   /api/rag/clear           borra todos los documentos

   DISEÑO
   · El upload responde de inmediato con un `jobId`; el indexado corre en
     segundo plano y el cliente sondea el progreso. Indexar un PDF de
     80 páginas puede tardar 20-40 s (extracción + embeddings): bloquear
     la request HTTP durante ese tiempo es una forma segura de que el
     proxy te corte la conexión.
   · Los trabajos viven en memoria (Map) con expiración automática: no
     son datos que sobrevivan a un reinicio, así que no ensucian la base.
   · El contenido de cada job está atado al userId: nadie puede leer el
     progreso del indexado de otra persona.
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import crypto from 'node:crypto';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ValidationError, NotFoundError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import {
  ingestPdf,
  searchChunks,
  buildRagContext,
  listDocuments,
  deleteDocument,
  deleteAllDocuments,
  getRagStatus,
} from '../services/rag-parser.js';

/* ─── multer (opcional pero recomendado) ─────────────────────────────────── */

let multer = null;
try {
  const mod = await import('multer');
  multer = mod.default || mod;
} catch (e) {
  LOG.warn('rag.routes: multer no está instalado, /api/rag/upload quedará deshabilitado', {
    error: e.message,
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   01 · ESTADO DE TRABAJOS
   ═══════════════════════════════════════════════════════════════════════════ */

const JOBS = new Map();
const JOB_TTL_MS = 15 * 60_000;

function newJob(userId, filename) {
  const job = {
    id: crypto.randomUUID(),
    userId,
    filename,
    status: 'queued',   // queued | running | done | error
    pct: 0,
    stage: 'en cola',
    error: null,
    docId: null,
    chunkCount: 0,
    startedAt: Date.now(),
    finishedAt: null,
  };
  JOBS.set(job.id, job);
  return job;
}

function getJob(jobId, userId) {
  const job = JOBS.get(jobId);
  if (!job) return null;
  if (userId && job.userId !== userId) return null;
  return job;
}

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (now - job.startedAt > JOB_TTL_MS) JOBS.delete(id);
  }
}, 60_000);
if (cleanupTimer.unref) cleanupTimer.unref();

/* ═══════════════════════════════════════════════════════════════════════════
   02 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

const MAX_BYTES = 15 * 1024 * 1024;

/**
 * Middleware de multer configurado de forma estricta:
 *  · sólo PDF (mime + extensión)
 *  · límite de tamaño
 *  · storage en memoria: el archivo nunca toca el disco
 */
function buildUploader() {
  if (!multer) return null;

  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_BYTES,
      files: 1,
      fields: 10,
      fieldSize: 1024 * 1024,
    },
    fileFilter(_req, file, cb) {
      const mime = String(file.mimetype || '').toLowerCase();
      const name = String(file.originalname || '').toLowerCase();
      const isPdfMime = mime === 'application/pdf' || mime === 'application/x-pdf';
      const isPdfExt = name.endsWith('.pdf');
      if (isPdfMime || isPdfExt) return cb(null, true);
      return cb(Object.assign(new Error('sólo PDF'), { code: 'PDF_ONLY' }));
    },
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · RUTAS
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountRagRoutes(app) {
  const router = express.Router();
  const upload = buildUploader();

  /* ─── POST /api/rag/upload ──────────────────────────────────────────── */
  router.post(
    '/api/rag/upload',
    requireAuth,
    ...(upload ? [upload.single('file')] : []),
    asyncHandler(async (req, res) => {
      if (!upload) {
        throw new ValidationError(
          'La subida de PDF no está disponible en este entorno (falta multer).',
          'multer'
        );
      }

      const file = req.file;
      if (!file) {
        throw new ValidationError('No se recibió ningún archivo (campo "file").', 'file');
      }
      if (!/pdf$/i.test(file.originalname || '')) {
        throw new ValidationError('El archivo debe ser un PDF.', 'file');
      }
      if (file.size > MAX_BYTES) {
        throw new ValidationError('El PDF supera los 15 MB.', 'file');
      }

      const job = newJob(req.user.id, file.originalname);
      res.status(202).json({
        ok: true,
        jobId: job.id,
        filename: file.originalname,
        bytes: file.size,
        status: job.status,
        pollUrl: `/api/rag/jobs/${job.id}`,
      });

      // ── Procesamiento en segundo plano ────────────────────────────────
      job.status = 'running';
      job.stage = 'extrayendo texto';

      try {
        const result = await ingestPdf({
          buffer: file.buffer,
          filename: file.originalname,
          userId: req.user.id,
          onProgress: (pct, stage) => {
            job.pct = Math.max(0, Math.min(100, Math.round(pct)));
            job.stage = stage;
          },
        });

        job.status = 'done';
        job.pct = 100;
        job.stage = 'listo';
        job.docId = result.id;
        job.chunkCount = result.chunkCount || 0;
        job.degraded = Boolean(result.degraded);
        job.embeddingModel = result.embeddingModel || null;
        job.finishedAt = Date.now();

        LOG.info('rag.document_indexed', {
          userId: req.user.id,
          docId: result.id,
          chunks: job.chunkCount,
          degraded: job.degraded,
        });
      } catch (e) {
        job.status = 'error';
        job.stage = 'error';
        job.error = e.message || 'No se pudo procesar el PDF.';
        job.finishedAt = Date.now();
        LOG.warn('rag.index_failed', { userId: req.user.id, error: e.message });
      }
    })
  );

  /* ─── GET /api/rag/jobs/:jobId ──────────────────────────────────────── */
  router.get('/api/rag/jobs/:jobId', requireAuth, asyncHandler(async (req, res) => {
    const job = getJob(String(req.params.jobId || ''), req.user.id);
    if (!job) {
      throw new NotFoundError('Ese trabajo no existe o expiró.');
    }
    res.json({
      ok: true,
      job: {
        id: job.id,
        filename: job.filename,
        status: job.status,
        pct: job.pct,
        stage: job.stage,
        error: job.error,
        docId: job.docId,
        chunkCount: job.chunkCount,
        degraded: job.degraded || false,
        embeddingModel: job.embeddingModel || null,
        elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
      },
    });
  }));

  /* ─── GET /api/rag/documents ────────────────────────────────────────── */
  router.get('/api/rag/documents', requireAuth, asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
    const result = await listDocuments(req.user.id, { limit });
    res.json({ ok: true, ...result });
  }));

  /* ─── DELETE /api/rag/documents/:id ─────────────────────────────────── */
  router.delete('/api/rag/documents/:id', requireAuth, asyncHandler(async (req, res) => {
    const docId = String(req.params.id || '');
    if (!/^[0-9a-f-]{36}$/i.test(docId)) {
      throw new ValidationError('Identificador de documento inválido.', 'id');
    }
    const result = await deleteDocument(req.user.id, docId);
    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudo eliminar el documento.', 'id');
    }
    if (!result.deleted) {
      throw new NotFoundError('El documento no existe o no te pertenece.');
    }
    res.json({ ok: true, deleted: true, id: docId });
  }));

  /* ─── POST /api/rag/clear ───────────────────────────────────────────── */
  router.post('/api/rag/clear', requireAuth, asyncHandler(async (req, res) => {
    const result = await deleteAllDocuments(req.user.id);
    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudieron eliminar los documentos.', 'clear');
    }
    res.json({ ok: true, deleted: result.deleted || 0 });
  }));

  /* ─── POST /api/rag/search ──────────────────────────────────────────── */
  router.post('/api/rag/search', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const query = String(body.query || body.q || '').trim();

    if (!query) {
      throw new ValidationError('Escribí una consulta para buscar.', 'query');
    }
    if (query.length > 2000) {
      throw new ValidationError('La consulta es demasiado larga.', 'query');
    }

    const topK = Math.min(parseInt(body.topK, 10) || 6, 20);
    const docId = body.docId ? String(body.docId) : null;

    const result = await searchChunks({
      userId: req.user.id,
      query,
      topK,
      docId,
    });

    const context = buildRagContext(result.results);

    res.json({
      ok: true,
      query,
      mode: result.mode || 'none',
      degraded: Boolean(result.degraded),
      count: result.results.length,
      results: result.results.map((r) => ({
        id: r.id,
        docId: r.docId,
        docTitle: r.docTitle,
        filename: r.filename,
        index: r.index,
        score: Number(r.score || 0),
        excerpt: String(r.content || '').slice(0, 600),
      })),
      context,
    });
  }));

  /* ─── GET /api/rag/status ───────────────────────────────────────────── */
  router.get('/api/rag/status', requireAuth, asyncHandler(async (_req, res) => {
    res.json({ ok: true, status: getRagStatus(), multer: Boolean(multer) });
  }));

  app.use(router);

  LOG.info('rag.routes.mounted', {
    endpoints: [
      'POST /api/rag/upload',
      'GET /api/rag/jobs/:jobId',
      'GET /api/rag/documents',
      'DELETE /api/rag/documents/:id',
      'POST /api/rag/search',
      'GET /api/rag/status',
    ],
  });

  return router;
}

export default { mountRagRoutes };
