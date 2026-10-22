/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/sandbox.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Endpoint de ejecución de código.

   MONTADO
     mountSandboxRoutes(app) → añade:
       POST /api/sandbox/run     ejecuta código en el sandbox
       GET  /api/sandbox/policy  política vigente (lenguajes, límites)

   SEGURIDAD (en este orden)
     1 · requireAuth          → sólo usuarios con sesión.
     2 · Allowlist de comandos → el binario se elige de una lista fija;
                                 nunca se acepta un comando del cliente.
     3 · Validación de código  → patrones prohibidos (fs, red, procesos).
     4 · Límite de tamaño      → 20 000 caracteres.
     5 · Timeout estricto      → 8 s por defecto, 20 s máximo.
     6 · Salida acotada        → 20 000 caracteres.
     7 · Entorno aislado       → sin secretos, sin red.

   El cliente NUNCA envía el binario a ejecutar: sólo el lenguaje. El
   comando se resuelve en el servidor desde la allowlist.
   ═══════════════════════════════════════════════════════════════════════════ */

import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler, ValidationError, RateLimitError } from '../middleware/errors.js';
import { LOG } from '../lib/logger.js';
import {
  runCode,
  inspectCode,
  isLanguageAllowed,
  getLanguageList,
  getSandboxPolicy,
} from '../services/sandbox-runner.js';

/* ─── Rate limit (el sandbox consume CPU del servidor) ──────────────────── */

const RATE = Object.freeze({ windowMs: 60_000, max: 20 });
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

export function mountSandboxRoutes(app) {
  const router = express.Router();

  /* ─── POST /api/sandbox/run ────────────────────────────────────────── */
  router.post('/api/sandbox/run', requireAuth, asyncHandler(async (req, res) => {
    const body = req.body || {};

    // 1 · El binario NUNCA viene del cliente.
    const language = String(body.language || body.lang || 'javascript').toLowerCase();

    if (!isLanguageAllowed(language)) {
      throw new ValidationError(
        `Lenguaje no permitido. Disponibles: ${getLanguageList().map((l) => l.id).join(', ')}.`,
        'language'
      );
    }

    const code = String(body.code ?? body.source ?? '');
    if (!code.trim()) {
      throw new ValidationError('Mandá el código a ejecutar.', 'code');
    }

    // 2 · Validación previa (respuesta rápida, sin gastar CPU).
    const check = inspectCode(code, language);
    if (!check.ok) {
      LOG.warn('sandbox: código bloqueado', { userId: req.user.id, reason: check.reason });
      throw new ValidationError(
        check.reason === 'blocked_pattern'
          ? 'Ese código usa funciones no permitidas dentro del sandbox.'
          : 'El código no cumple la política del sandbox.',
        'code',
        check.reason
      );
    }

    // 3 · Rate limit por usuario.
    const rate = checkRate(req.user.id);
    res.setHeader('X-RateLimit-Limit', String(RATE.max));
    res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(rate.reset / 1000)));

    if (!rate.allowed) {
      res.setHeader('Retry-After', String(rate.retryAfter));
      throw new RateLimitError(
        `Alcanzaste el máximo de ${RATE.max} ejecuciones por minuto.`,
        'limit_sandbox_rate',
        rate.retryAfter
      );
    }

    // 4 · Ejecución.
    const result = await runCode({
      language,
      code,
      timeoutMs: body.timeoutMs,
      stdin: body.stdin ? String(body.stdin).slice(0, 4000) : '',
      forceMock: body.mock === true,
    });

    LOG.info('sandbox.exec', {
      userId: req.user.id,
      language,
      mode: result.mode,
      ok: result.ok,
      durationMs: result.durationMs,
    });

    res.json({
      ok: result.ok,
      result: {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: result.exitCode ?? -1,
        durationMs: result.durationMs || 0,
        timedOut: Boolean(result.timedOut),
        truncated: Boolean(result.truncated),
        mode: result.mode,
        language,
        note: result.note || null,
        reason: result.reason || null,
      },
    });
  }));

  /* ─── GET /api/sandbox/policy ──────────────────────────────────────── */
  router.get('/api/sandbox/policy', requireAuth, asyncHandler(async (_req, res) => {
    res.json({ ok: true, policy: getSandboxPolicy() });
  }));

  app.use(router);

  LOG.info('sandbox.routes.mounted', {
    endpoints: ['POST /api/sandbox/run', 'GET /api/sandbox/policy'],
  });

  return router;
}

export default { mountSandboxRoutes };
