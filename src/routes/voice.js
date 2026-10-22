/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/voice.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   API de voz (STT + TTS).

   MONTADO
     mountVoiceRoutes(app) → añade:
       POST /api/voice/transcribe   audio → texto   (multipart o base64)
       POST /api/voice/speak        texto → audio  (devuelve el binario)
       GET  /api/voice/status       proveedores y voces disponibles

   NOTA
   `/api/voice/tts` y `/api/voice/stt` (implementación previa en
   src/index.js) siguen disponibles. Estas rutas son la versión nueva:
   manejan multipart, cadena de proveedores y streaming de audio.

   SEGURIDAD
   · Ambas rutas exigen `requireAuth`.
   · El audio se valida por tipo MIME y por tamaño antes de procesarse.
   · El texto a sintetizar se recorta a 8000 caracteres.
   · Nunca se escribe audio en disco.
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ValidationError, RateLimitError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import { transcribe, speak, getVoiceStatus } from '../services/voice-engine.js';

/* ─── multer opcional (para subidas multipart) ───────────────────────────── */

let multer = null;
try {
  const mod = await import('multer');
  multer = mod.default || mod;
} catch (e) {
  LOG.warn('voice.routes: multer no disponible, la transcripción acepta sólo base64', { error: e.message });
}

const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
const ALLOWED_AUDIO_MIME = [
  'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mp4',
  'audio/wav', 'audio/x-wav', 'audio/flac', 'audio/aac', 'audio/webm;codecs=opus',
];

let upload = null;
if (multer) {
  upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1, fields: 6 },
    fileFilter(_req, file, cb) {
      const mime = String(file.mimetype || '').toLowerCase();
      if (mime.startsWith('audio/') || ALLOWED_AUDIO_MIME.includes(mime)) return cb(null, true);
      return cb(Object.assign(new Error('sólo audio'), { code: 'AUDIO_ONLY' }));
    },
  });
}

/* ─── Rate limit de TTS (el TTS cuesta plata) ────────────────────────────── */

const RATE = Object.freeze({ windowMs: 60_000, max: 12 });
const buckets = new Map();

function checkRate(userId) {
  const now = Date.now();
  let b = buckets.get(userId);
  if (!b || b.reset <= now) {
    b = { count: 0, reset: now + RATE.windowMs };
    buckets.set(userId, b);
  }
  b.count++;
  return {
    allowed: b.count <= RATE.max,
    remaining: Math.max(0, RATE.max - b.count),
    reset: b.reset,
    retryAfter: Math.max(1, Math.ceil((b.reset - now) / 1000)),
  };
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) if (b.reset <= now) buckets.delete(key);
}, 60_000);
if (cleanup.unref) cleanup.unref();

/* ═══════════════════════════════════════════════════════════════════════════
   RUTAS
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountVoiceRoutes(app) {
  const router = express.Router();

  /* ─── POST /api/voice/transcribe ────────────────────────────────────── */
  router.post(
    '/api/voice/transcribe',
    requireAuth,
    ...(upload ? [upload.single('audio')] : []),
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      let buffer = null;
      let filename = null;
      let mimeType = null;

      if (req.file) {
        buffer = req.file.buffer;
        filename = req.file.originalname;
        mimeType = req.file.mimetype;
      } else if (body.audioBase64 || body.audio) {
        const raw = String(body.audioBase64 || body.audio || '');
        const payload = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
        mimeType = String(body.mime || body.mimeType || 'audio/webm');
        try {
          buffer = Buffer.from(payload, 'base64');
        } catch {
          throw new ValidationError('El audio en base64 no es válido.', 'audio');
        }
        filename = body.filename || 'audio';
      }

      if (!buffer || !buffer.length) {
        throw new ValidationError(
          'No se recibió audio. Mandá un archivo (campo "audio") o base64 en el cuerpo.',
          'audio'
        );
      }

      if (buffer.length > MAX_AUDIO_BYTES) {
        throw new ValidationError('El audio supera los 25 MB.', 'audio');
      }

      const language = String(body.language || 'es').slice(0, 8);

      const result = await transcribe({
        buffer,
        filename,
        mimeType,
        language,
        prompt: String(body.prompt || '').slice(0, 800),
      });

      if (!result.ok) {
        throw new ValidationError(result.error || 'No se pudo transcribir el audio.', 'audio', result.code || 'stt_failed');
      }

      res.json({
        ok: true,
        available: result.available !== false,
        text: result.text || '',
        provider: result.provider,
        language: result.language,
        durationMs: result.durationMs || null,
        elapsedMs: result.elapsedMs || null,
        fallback: result.fallback || null,
        message: result.message || null,
      });
    })
  );

  /* ─── POST /api/voice/speak ─────────────────────────────────────────── */
  router.post('/api/voice/speak', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};
    const text = String(body.text || '').trim();

    if (!text) {
      throw new ValidationError('Mandá el texto que querés que lea.', 'text');
    }
    if (text.length > 8000) {
      throw new ValidationError('El texto supera los 8000 caracteres.', 'text');
    }

    const rate = checkRate(req.user.id);
    res.setHeader('X-RateLimit-Limit', String(RATE.max));
    res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(rate.reset / 1000)));

    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfter));
      throw new RateLimitError(
        `Alcanzaste el máximo de ${RATE.max} lecturas por minuto.`,
        'limit_voice_rate',
        rate.retryAfter
      );
    }

    const format = String(body.format || 'mp3').toLowerCase();
    const voice = String(body.voice || '').slice(0, 40);
    const speed = Number(body.speed) || 1;

    const result = await speak({ text, voice, format, speed });

    if (!result.ok) {
      throw new ValidationError(result.error || 'No se pudo generar el audio.', 'text', result.code || 'tts_failed');
    }

    // Sin proveedor: se informa al cliente para que use Web Speech API.
    if (result.available === false) {
      return res.json({
        ok: true,
        available: false,
        provider: result.provider,
        fallback: result.fallback || 'webspeech',
        message: result.message || 'Usá la síntesis de voz del navegador.',
      });
    }

    if (body.asJson === true) {
      return res.json({
        ok: true,
        available: true,
        provider: result.provider,
        contentType: result.contentType,
        bytes: result.bytes,
        audioBase64: result.audio.toString('base64'),
      });
    }

    res.setHeader('Content-Type', result.contentType || 'audio/mpeg');
    res.setHeader('Content-Length', String(result.audio.length));
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Voice-Provider', result.provider);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(result.audio);
  }));

  /* ─── GET /api/voice/status ─────────────────────────────────────────── */
  router.get('/api/voice/status', requireAuth, asyncHandler(async (_req, res) => {
    res.json({ ok: true, status: getVoiceStatus() });
  }));

  app.use(router);

  LOG.info('voice.routes.mounted', {
    endpoints: [
      'POST /api/voice/transcribe',
      'POST /api/voice/speak',
      'GET /api/voice/status',
    ],
  });

  return router;
}

export default { mountVoiceRoutes };
