/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/spam-filter.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Detector de prompt injection y HTML malicioso.

   PUNTUACIÓN
     Cada patrón tiene un peso. La suma se limita a 100.
       0-24  → limpio (se permite, sólo se registra)
      25-59  → sospechoso (se permite pero se marca)
      60-100 → peligroso (se bloquea)

   CONTRATO
     analyzeText(text) → { score, isSpam, blocked, reasons[], flags }
     isSpam(text, threshold) → boolean
     sanitizeText(text) → string
   ═══════════════════════════════════════════════════════════════════════ */

import { LOG } from '../src/lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  suspiciousThreshold: 25,
  blockThreshold: 60,
  maxTextLength: 20_000,
});

/**
 * Patrones de detección.
 * weight = puntos que suma al score.
 */
const PATTERNS = Object.freeze([
  // ── HTML / XSS ─────────────────────────────────────────────────────
  { type: 'script_tag',      weight: 45, re: /<\s*script\b[^>]*>[\s\S]{0,4000}?(?:<\s*\/\s*script\s*>|$)/gi },
  { type: 'script_open',     weight: 30, re: /<\s*script\b/gi },
  { type: 'event_handler',   weight: 25, re: /\bon(?:error|load|click|mouseover|mouseenter|focus|blur|submit|animationstart|toggle)\s*=/gi },
  { type: 'javascript_uri',  weight: 30, re: /javascript\s*:/gi },
  { type: 'data_uri_html',   weight: 20, re: /data\s*:\s*text\/html/gi },
  { type: 'iframe_object',   weight: 20, re: /<\s*(iframe|object|embed|applet|meta|base|form)\b[^>]*>/gi },
  { type: 'svg_payload',     weight: 20, re: /<\s*svg\b[^>]*onload\s*=/gi },
  { type: 'eval_call',       weight: 20, re: /\b(?:eval|setTimeout|setInterval)\s*\(\s*['"`]/gi },
  { type: 'import_node',     weight: 20, re: /\b(?:require|import)\s*\(\s*['"](?:child_process|fs|net|http|https)['"]/gi },

  // ── Prompt injection ──────────────────────────────────────────────
  { type: 'ignore_instructions', weight: 40, re: /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,40}\b(?:instruction|instructions|prompt|prompts|rule|rules|instructiones|instructions?|sistema|system)\b/gi },
  { type: 'ignore_previous',     weight: 35, re: /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:previous|prior|above|earlier)\b/gi },
  { type: 'new_instructions',    weight: 30, re: /\b(?:new|updated|revised)\s+(?:system\s+)?(?:instructions?|prompt)\s*[:\-]/gi },
  { type: 'fake_system_role',    weight: 30, re: /(?:^|\n)\s*(?:system|assistant|developer)\s*[:>]\s+/gi },
  { type: 'role_override',       weight: 30, re: /\b(?:you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as|pretend\s+to\s+be|roleplay\s+as|simulate\s+being)\b[^.\n]{0,40}\b(?:dan|root|admin|administrator|developer|unrestricted|jailbroken|god\s+mode|developer\s+mode)\b/gi },
  { type: 'jailbreak',           weight: 30, re: /\b(?:jailbreak|jail\s?broken|DAN\s+mode|developer\s+mode\s+enabled|unfiltered\s+mode)\b/gi },
  { type: 'reveal_prompt',       weight: 30, re: /\b(?:reveal|show|print|repeat|output|display)\b[^.\n]{0,30}\b(?:your\s+)?(?:system\s+)?(?:prompt|instructions|initial\s+prompt|hidden\s+rules?)\b/gi },
  { type: 'safety_bypass',       weight: 30, re: /\b(?:without|no|ignore)\b[^.\n]{0,30}\b(?:restrictions?|filters?|guardrails?|safety|moderation|censorship)\b/gi },
  { type: 'policy_override',     weight: 25, re: /\b(?:disable|turn\s+off|deactivate|disable)\b[^.\n]{0,20}\b(?:your\s+)?(?:filters?|safety|moderation|restrictions?)\b/gi },
  { type: 'exfiltration',        weight: 30, re: /\b(?:curl|wget)\b[^\n]{0,80}\|\s*(?:ba|z)?sh\b/gi },
  { type: 'secret_exfil',        weight: 30, re: /\b(?:send|post|upload|leak|exfiltrate)\b[^.\n]{0,40}\b(?:api[_ -]?key|secret|password|token|credential|env\s+var)s?\b/gi },
]);

/* ═══════════════════════════════════════════════════════════════════════
   02 · NORMALIZACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Normaliza el texto para hacer los regex más fiables:
 * quita los zero-width, unifica espacios y decodifica entities básicas.
 * @param {string} text
 * @returns {string}
 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#0*39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ');
}

/* ═══════════════════════════════════════════════════════════════════════
   03 · ANÁLISIS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Analiza un texto y devuelve el score de riesgo (0-100).
 *
 * @param {string} text
 * @param {object} [options]
 * @param {number} [options.threshold]  Umbral de bloqueo (60 por defecto).
 * @returns {{score:number, isSpam:boolean, blocked:boolean,
 *            suspicious:boolean, reasons:Array<{type:string,weight:number,matches:number}>,
 *            flags:string[], text:string}}
 */
export function analyzeText(text, options = {}) {
  const threshold = Number.isFinite(options.threshold) ? options.threshold : CFG.blockThreshold;
  const raw = String(text ?? '');
  const normalized = normalizeText(raw).slice(0, CFG.maxTextLength);

  const reasons = [];
  const flags = [];
  let score = 0;

  if (!normalized.trim()) {
    return {
      score: 0,
      isSpam: false,
      blocked: false,
      suspicious: false,
      reasons: [],
      flags: [],
      text: raw,
    };
  }

  for (const pattern of PATTERNS) {
    const matches = normalized.match(pattern.re);
    if (!matches || !matches.length) continue;

    const count = matches.length;
    // El peso no crece linealmente: 1er match = peso completo,
    // siguientes = 25 % extra (tope 1.5×).
    const weighted = Math.round(pattern.weight * Math.min(1.5, 1 + (count - 1) * 0.25));
    score += weighted;
    reasons.push({ type: pattern.type, weight: weighted, matches: count });
    flags.push(pattern.type);
  }

  // Repetición excesiva de un mismo carácter (anti-flood).
  if (/(.)\1{60,}/s.test(normalized)) {
    score += 10;
    reasons.push({ type: 'char_flood', weight: 10, matches: 1 });
    flags.push('char_flood');
  }

  // Texto casi todo en mayúsculas (sociometría clásica de spam).
  const letters = normalized.replace(/[^a-zA-Z]/g, '');
  if (letters.length > 40) {
    const upper = letters.replace(/[^A-Z]/g, '').length / letters.length;
    if (upper > 0.85) {
      score += 15;
      reasons.push({ type: 'all_caps', weight: 15, matches: 1 });
      flags.push('all_caps');
    }
  }

  // Blob base64 / binario ofuscado.
  if (/[A-Za-z0-9+/]{180,}={0,2}/.test(normalized)) {
    score += 20;
    reasons.push({ type: 'encoded_blob', weight: 20, matches: 1 });
    flags.push('encoded_blob');
  }

  // Repetición del mismo token (spam clásico).
  const tokens = normalized.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length > 12) {
    const counts = new Map();
    for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
    const maxRepeat = Math.max(...counts.values());
    if (maxRepeat >= 8) {
      score += 10;
      reasons.push({ type: 'token_repeat', weight: 10, matches: maxRepeat });
      flags.push('token_repeat');
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  const result = {
    score,
    isSpam: score >= threshold,
    blocked: score >= threshold,
    suspicious: score >= CFG.suspiciousThreshold && score < threshold,
    reasons,
    flags,
    text: raw,
  };

  if (result.blocked) {
    LOG.warn('spam-filter: contenido bloqueado', {
      score: result.score,
      flags: result.flags.join(','),
    });
  }

  return result;
}

/**
 * ¿El texto supera el umbral de riesgo?
 * @param {string} text
 * @param {number} [threshold]
 * @returns {boolean}
 */
export function isSpam(text, threshold = CFG.blockThreshold) {
  try {
    return analyzeText(text, { threshold }).isSpam;
  } catch (e) {
    LOG.warn('spam-filter: error al analizar', { error: e.message });
    return false;
  }
}

/**
 * Limpia el texto de las partes más peligrosas (script tags, manejadores
 * de eventos y URIs javascript:). No sustituye al bloqueo: es una
 * segunda capa para contenido que ya se ha aceptado.
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeText(text) {
  let value = String(text ?? '');

  try {
    value = value.replace(/<\s*script\b[\s\S]*?(?:<\s*\/\s*script\s*>|$)/gi, '');
    value = value.replace(/<\s*(iframe|object|embed|applet)\b[^>]*>[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi, '');
    value = value.replace(/\bon(?:error|load|click|mouseover|mouseenter|focus|blur|submit)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    value = value.replace(/javascript\s*:/gi, 'removed:');
    value = value.replace(/[\u200B-\u200D\uFEFF]/g, '');
  } catch (e) {
    LOG.warn('spam-filter: error al sanitizar', { error: e.message });
    return String(text ?? '');
  }

  return value;
}

export default {
  analyzeText,
  isSpam,
  sanitizeText,
  normalizeText,
};
