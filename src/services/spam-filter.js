/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/spam-filter.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Filtro de spam: devuelve un score 0-100 para un texto.

   QUÉ DETECTA
     1 · Prompt injection  ("ignore previous instructions", "revelá tu
       system prompt", "actuá como DAN"…).
     2 · Scripts maliciosos  (<script>, javascript:, onerror=, data:text/html).
     3 · Explotación de prompt (tool abuse, "reveal your API key").
     4 · Spam comercial (demasiados links, repetition, ALL CAPS).
     5 · Repetición patológica (el mismo token 20 veces).

   SCORE
     Cada categoría suma puntos. El score final es 0-100.
       · 0-30  → limpio (se envía).
       · 31-80 → sospechoso: se registra y se avisa al usuario.
       · >80  → dispara el ban-manager (strike).

   DISEÑO
     · Es un EVENT BUS: `onSpamScore(cb)` recibe cada evaluación con
       score alto. El ban-manager se suscribe ahí.
     · El filtro NUNCA bloquea por sí solo (eso es del ban-manager): sólo
       informa. Así el mismo filtro puede usarse para "marcar" en el chat
       o para "sancionar".
     · Los patrones se pueden ampliar desde fuera (`addPattern`).
   ═══════════════════════════════════════════════════════════════════════════ */

import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · PATRONES
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Categoría → { regex, weight, label }
 * El peso se suma al score cuando el patrón matchea.
 */
const BUILTIN_PATTERNS = [
  /* ─── Prompt injection (peso alto) ────────────────────────────────── */
  {
    category: 'prompt_injection',
    label: 'Intento de inyección de prompt',
    weight: 85,
    patterns: [
      /ignore\s+(all\s+)?(the\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|rules?)/i,
      /disregard\s+(all\s+)?(the\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
      /forget\s+(everything|all|your)\s+(you|instructions?|rules?|training)/i,
      /(reveal|show|print|output|display|dump)\s+(me\s+)?(your|the)\s+(system\s+)?(prompt|instructions?|rules?|api[_\s-]?key|token|password)/i,
      /what\s+(were|are)\s+your\s+(exact\s+)?(instructions?|system\s+prompt|guidelines)/i,
      /(repeat|print|output)\s+(everything|all)\s+(above|before|you\s+(were|are)\s+told)/i,
      /\[\s*(system|inst)\s*\]/i,
      /<\s*(system|important|override)\s*>/i,
      /you\s+are\s+now\s+(dan\b|jailbroken|an?\s+unfiltered|an?\s+unrestricted|in\s+developer\s+mode|an?\s+amoral)/i,
      /developer\s+mode\s+(enabled|on)/i,
      /\bpretend\s+(you\s+are|to\s+be)\s+(an?\s+)?(unfiltered|uncensored|evil|admin)/i,
      /act\s+as\s+(if\s+you\s+have\s+no\s+)?(no\s+)?(restrictions?|filters?|rules)/i,
      /(bypass|circumvent|disable|turn\s+off)\s+(the\s+)?(safety|guardrails?|filters?|restrictions?|content\s+policy)/i,
      /do\s+anything\s+now/i,
      /system\s*prompt\s*[:>]/i,
      /instrucciones\s+(del\s+sistema|internas)/i,
      /ignora\s+(las\s+)?(instrucciones|reglas)\s+(anteriores|previas)/i,
      /revel[áa]\s+(tu|el)\s+(prompt|instrucciones)/i,
    ],
  },

  /* ─── XSS / scripts maliciosos (peso alto) ────────────────────────── */
  {
    category: 'xss',
    label: 'Script o HTML malicioso',
    weight: 85,
    patterns: [
      /<\s*script\b[\s\S]*?(?:<\s*\/\s*script\s*>|$)/i,
      /javascript\s*:/i,
      /\bon(?:error|load|mouseover|focus|click)\s*=/i,
      /data\s*:\s*text\/html/i,
      /<\s*iframe\b[^>]*srcdoc/i,
      /<\s*object\b[^>]*data\s*=/i,
      /document\s*\.\s*cookie/i,
      /window\s*\.\s*location\s*=/i,
      /localStorage\s*\.\s*setItem/i,
      /<\s*svg[^>]*onload/i,
      /<\s*img[^>]*src\s*=\s*["']?\s*javascript:/i,
    ],
  },

  /* ─── Exfiltración / herramientas ─────────────────────────────────── */
  {
    category: 'tool_abuse',
    label: 'Intento de abuso de herramientas',
    weight: 30,
    patterns: [
      /(curl|wget)\s+https?:\/\//i,
      /cat\s+\/etc\/passwd/i,
      /\brm\s+-rf\s+\//i,
      /process\s*\.\s*env\b/i,
      /require\s*\(\s*['"](child_process|fs)['"]/i,
      /\bSELECT\s+.+\s+FROM\s+/i,
      /\bDROP\s+TABLE\b/i,
      /\bUNION\s+SELECT\b/i,
      /\$\(\s*curl/i,
    ],
  },

  /* ─── Spam comercial ──────────────────────────────────────────────── */
  {
    category: 'spam',
    label: 'Spam',
    weight: 22,
    patterns: [
      /\b(?:buy|cheap|discount)\s+(?:now|today|followers|likes|views)\b/i,
      /\b(?:telegram|whatsapp)\s*:\s*\+?\d[\d\s-]{6,}/i,
      /\b(?:click|visit)\s+this\s+link\b/i,
      /https?:\/\/\S{0,200}(bit\.ly|tinyurl|t\.me|is\.gd)\b/i,
      /\bwork\s+from\s+home\s+(?:and\s+)?earn\s+\$?\d+/i,
      /\b(?:crypto|forex)\s+(?:signals?|bot)\b/i,
      /\bseo\s+(?:services|backlinks)\b/i,
    ],
  },
];

/* Patrones extraíbles desde fuera */
const EXTRA_PATTERNS = [];

/* ═══════════════════════════════════════════════════════════════════════════
   02 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  threshold: 80,          // > 80 dispara strike
  suspiciousThreshold: 31,
  maxLength: 20_000,
  maxLinks: 8,
  maxCapsRatio: 0.7,
  maxRepeatToken: 12,
});

/* ═══════════════════════════════════════════════════════════════════════════
   03 · BUS DE EVENTOS
   ═══════════════════════════════════════════════════════════════════════════ */

const listeners = new Set();

/**
 * Se suscribe a las evaluaciones de spam.
 * @param {function} cb  ({ userId, score, reason, categories, text }) => void
 * @returns {function} unsubscribe
 */
export function onSpamScore(cb) {
  if (typeof cb !== 'function') throw new TypeError('onSpamScore(cb) requiere una función.');
  listeners.add(cb);
  return function off() { listeners.delete(cb); };
}

/**
 * Emite una evaluación.
 */
export async function emitSpamScore(payload) {
  if (!listeners.size) return { ok: true, handled: 0 };

  const results = await Promise.allSettled(
    Array.from(listeners).map((fn) => fn(payload))
  );

  return { ok: true, handled: results.length, errors: results.filter((r) => r.status === 'rejected').length };
}

/**
 * Emite una advertencia al usuario (para el chat).
 */
export function emitSpamWarning(payload) {
  try {
    document.dispatchEvent(new CustomEvent('numination:spam-warning', { detail: payload }));
  } catch {
    /* sin DOM (backend) */
  }
}

/**
 * Registra un patrón extra.
 *
 * Se normaliza a la misma forma que los patrones internos
 * ({ patterns: [...] }) para que el analizador pueda iterarlos sin
 * distinguir el origen.
 */
export function addPattern({ category = 'custom', label = 'Patrón personalizado', weight = 20, pattern, flags = 'i' } = {}) {
  if (!(pattern instanceof RegExp)) {
    throw new TypeError('addPattern requiere una RegExp.');
  }
  EXTRA_PATTERNS.push({
    category,
    label,
    weight,
    patterns: [pattern],
    flags: pattern.flags || flags,
  });
  return EXTRA_PATTERNS.length;
}

export function clearExtraPatterns() {
  EXTRA_PATTERNS.length = 0;
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · HEURÍSTICAS
   ═══════════════════════════════════════════════════════════════════════════ */

function countLinks(text) {
  const matches = text.match(/https?:\/\/\S+/gi);
  return matches ? matches.length : 0;
}

function capsRatio(text) {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 20) return 0;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length;
}

function maxTokenRepeat(text) {
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  const counts = new Map();
  let max = 0;
  for (const token of tokens) {
    const next = (counts.get(token) || 0) + 1;
    counts.set(token, next);
    if (next > max) max = next;
  }
  return max;
}

function hasControlChars(text) {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text);
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · ANÁLISIS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Analiza un texto y devuelve el score de spam (0-100).
 *
 * @param {string} text
 * @param {object} [opts] { userId, ip }
 * @returns {object} {
 *   score, isSpam, suspicious, categories: [{category,label,weight,match}],
 *   reason, length
 * }
 */
export function analyzeSpam(text, opts = {}) {
  const raw = String(text || '');
  const input = raw.slice(0, CFG.maxLength);

  const categories = [];
  let score = 0;

  /* ── 1 · Patrones por categoría ───────────────────────────────────── */
  const all = [...BUILTIN_PATTERNS, ...EXTRA_PATTERNS];

  for (const group of all) {
    let groupWeight = 0;
    let groupMatches = 0;

    for (const pattern of group.patterns) {
      const re = pattern instanceof RegExp
        ? new RegExp(pattern.source, pattern.flags)
        : new RegExp(pattern, group.flags || 'i');

      const match = input.match(re);
      if (!match) continue;

      groupMatches++;

      // El primer acierto pesa el 100 %; cada acierto extra suma la
      // mitad. Así un ataque con varias vectores (injection + system
      // prompt + DAN) supera el umbral de sanción, mientras que un
      // mensaje con un solo patrón sospechoso queda en "revisar".
      const weight = groupMatches === 1
        ? group.weight
        : Math.max(10, Math.round(group.weight * 0.5));

      groupWeight += weight;

      categories.push({
        category: group.category,
        label: group.label,
        weight,
        match: String(match[0]).slice(0, 80),
      });
    }

    if (groupMatches) {
      score += groupWeight;
    }
  }

  /* ── 2 · Heurísticas ──────────────────────────────────────────────── */
  const links = countLinks(input);
  if (links > CFG.maxLinks) {
    score += 15;
    categories.push({ category: 'spam', label: 'Demasiados enlaces', weight: 15, match: `${links} enlaces` });
  }

  const caps = capsRatio(input);
  if (caps > CFG.maxCapsRatio && input.length > 60) {
    score += 10;
    categories.push({ category: 'spam', label: 'Texto en mayúsculas', weight: 10, match: `${Math.round(caps * 100)}%` });
  }

  const repeat = maxTokenRepeat(input);
  if (repeat >= CFG.maxRepeatToken) {
    score += 12;
    categories.push({ category: 'repetition', label: 'Repetición de una palabra', weight: 12, match: `${repeat} veces` });
  }

  if (hasControlChars(input)) {
    score += 20;
    categories.push({ category: 'obfuscation', label: 'Caracteres de control', weight: 20, match: 'control chars' });
  }

  // Score acotado a 100.
  const finalScore = Math.max(0, Math.min(100, Math.round(score)));

  const result = {
    score: finalScore,
    isSpam: finalScore > CFG.threshold,
    suspicious: finalScore > CFG.suspiciousThreshold && finalScore <= CFG.threshold,
    categories,
    reason: categories.length ? categories.map((c) => c.label).join(', ') : null,
    length: input.length,
  };

  /* ── 3 · Notificación al bus ──────────────────────────────────────── */
  if (finalScore > CFG.threshold) {
    emitSpamScore({
      userId: opts.userId || null,
      ip: opts.ip || null,
      score: finalScore,
      reason: result.reason,
      categories: result.categories,
      text: input.slice(0, 500),
    }).catch((e) => LOG.debug('spam-filter: emit falló', { error: e.message }));
  }

  return result;
}

/**
 * Middleware Express: evalúa el body de la request.
 */
export function spamFilterMiddleware(opts = {}) {
  const { fields = ['message', 'prompt', 'content', 'text'] } = opts;

  return function filter(req, res, next) {
    const body = req.body || {};

    for (const field of fields) {
      const value = body[field];
      if (typeof value !== 'string' || !value.trim()) continue;

      const analysis = analyzeSpam(value, {
        userId: req.user?.id,
        ip: req.ip,
      });

      req.spamAnalysis = analysis;

      if (analysis.isSpam) {
        LOG.warn('spam-filter: contenido bloqueado', {
          userId: req.user?.id,
          field,
          score: analysis.score,
          reason: analysis.reason,
        });

        return res.status(422).json({
          ok: false,
          error: 'El contenido fue bloqueado por el filtro de seguridad.',
          code: 'spam_blocked',
          score: analysis.score,
        });
      }

      break;
    }

    return next();
  };
}

export function getSpamFilterStatus() {
  return {
    threshold: CFG.threshold,
    suspiciousThreshold: CFG.suspiciousThreshold,
    categories: BUILTIN_PATTERNS.map((g) => ({
      category: g.category,
      label: g.label,
      weight: g.weight,
      patterns: g.patterns.length,
    })),
    extraPatterns: EXTRA_PATTERNS.length,
    listeners: listeners.size,
  };
}

export default {
  analyzeSpam,
  onSpamScore,
  emitSpamScore,
  emitSpamWarning,
  addPattern,
  clearExtraPatterns,
  spamFilterMiddleware,
  getSpamFilterStatus,
};
