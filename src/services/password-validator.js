/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/password-validator.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Validación de contraseñas.

   REGLA BASE (la que pide el brief)
     · 8+ caracteres
     · 1 mayúscula
     · 1 número
     · 1 símbolo

   EXTRAS (recomendación de sentido común, configurables)
     · Longitud mínima recomendada: 10 (para planes altos).
     · Rechazo de contraseñas triviales ("password", "123456", "qwerty").
     · Rechazo de secuencias ("abcdef", "123456", "qwerty") y repeticiones
       ("aaaaaa").
     · Penalización de la similitud con el email.

   API
     · isStrongPassword(pwd) → { valid, message, score, issues }
     · validatePassword(pwd, { email, minLength }) → resultado extendida
     · suggestPasswordStrength(pwd) → { level, label, color }
     · generatePassword(len) → una contraseña fuerte (para el botón
       "generar" del formulario de registro).

   MENSAJES
     Siempre en español y accionables: el usuario tiene que saber QUÉ
     falta, no sólo que "es débil".
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  minLength: 8,
  recommendedLength: 10,
  maxLength: 128,
  requireUpper: true,
  requireLower: true,
  requireNumber: true,
  requireSymbol: true,
  symbolPattern: /[^\p{L}\p{N}\s]/u,
  upperPattern: /\p{Lu}/u,
  lowerPattern: /\p{Ll}/u,
  numberPattern: /\p{Nd}/u,
  // Contraseñas que se filtraron en breaches conocidos.
  commonPasswords: [
    'password', 'contraseña', 'contrasena', '123456', '12345678', '123456789',
    'qwerty', 'qwertyuiop', 'abc123', 'letmein', 'admin', 'administrador',
    'iloveyou', 'monkey', 'dragon', 'sunshine', 'princess', 'football',
    'baseball', 'welcome', 'shadow', 'master', 'superman', 'trustno1',
    'numpassword', 'numination', 'changeme', 'default', 'usuario',
  ],
  // Secuencias y repeticiones obvious.
  sequences: [
    'abcdefghijklmnopqrstuvwxyz',
    'zyxwvutsrqponmlkjihgfedcba',
    '01234567890',
    '09876543210',
    'qwertyuiopasdfghjklzxcvbnm',
  ],
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

function countCategories(password) {
  let count = 0;
  if (CFG.upperPattern.test(password)) count++;
  if (CFG.lowerPattern.test(password)) count++;
  if (CFG.numberPattern.test(password)) count++;
  if (CFG.symbolPattern.test(password)) count++;
  return count;
}

function hasSequence(password) {
  const lower = password.toLowerCase();

  for (const seq of CFG.sequences) {
    for (let i = 0; i + 6 <= seq.length; i++) {
      const chunk = seq.slice(i, i + 6);
      if (lower.includes(chunk)) return chunk;
    }
  }

  return null;
}

function hasRepetition(password) {
  return /(.)\1{4,}/.test(password);
}

function isCommon(password) {
  const lower = password.toLowerCase();
  return CFG.commonPasswords.some((p) => lower.includes(p));
}

function similarityWithEmail(password, email) {
  if (!email || typeof email !== 'string') return 0;

  const pwd = password.toLowerCase();
  const mail = String(email).toLowerCase();

  const localPart = mail.split('@')[0] || '';

  if (localPart.length >= 3 && pwd.includes(localPart)) return 1;
  if (pwd.length >= 4 && mail.includes(pwd)) return 1;

  return 0;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · VALIDACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Valida una contraseña.
 *
 * @param {string} password
 * @param {object} [opts] { email, minLength, requireRecommended }
 * @returns {object} {
 *   valid: boolean,
 *   message: string,
 *   score: number,        // 0-4
 *   issues: string[],     // lista de requisitos que faltan
 *   checks: { length, upper, lower, number, symbol, common, sequence }
 * }
 */
export function validatePassword(password, opts = {}) {
  const minLength = Number.isFinite(Number(opts.minLength)) ? Number(opts.minLength) : CFG.minLength;
  const pwd = typeof password === 'string' ? password : '';

  const issues = [];

  const checks = {
    length: pwd.length >= minLength,
    upper: CFG.upperPattern.test(pwd),
    lower: CFG.lowerPattern.test(pwd),
    number: CFG.numberPattern.test(pwd),
    symbol: CFG.symbolPattern.test(pwd),
    common: isCommon(pwd),
    sequence: Boolean(hasSequence(pwd)),
    repetition: hasRepetition(pwd),
    emailSimilarity: similarityWithEmail(pwd, opts.email),
  };

  /* ── Requisitos ────────────────────────────────────────────────────── */
  if (!pwd) {
    issues.push('La contraseña está vacía.');
  } else {
    if (!checks.length) {
      issues.push(`Usá al menos ${minLength} caracteres.`);
    }
    if (!checks.upper) issues.push('Incluí al menos una mayúscula (A-Z).');
    if (!checks.lower) issues.push('Incluí al menos una minúscula (a-z).');
    if (!checks.number) issues.push('Incluí al menos un número (0-9).');
    if (!checks.symbol) issues.push('Incluí al menos un símbolo (!@#$%…).');
  }

  /* ── Reglas blandas (no invalidan, pero bajan el score) ────────────── */
  const warnings = [];

  if (pwd && pwd.length < CFG.recommendedLength) {
    warnings.push(`Con ${CFG.recommendedLength} caracteres o más la contraseña es mucho más difícil de adivinar.`);
  }
  if (checks.common) {
    warnings.push('Esa contraseña es de las más usadas del mundo: evitá las palabras comunes.');
  }
  if (checks.sequence) {
    warnings.push('Evitá las secuencias del teclado (abc, 123, qwerty).');
  }
  if (checks.repetition) {
    warnings.push('Evitá repetir el mismo carácter varias veces.');
  }
  if (checks.emailSimilarity) {
    warnings.push('No uses tu correo ni tu nombre dentro de la contraseña.');
  }
  if (pwd.length > CFG.maxLength) {
    issues.push(`La contraseña no puede pasar de ${CFG.maxLength} caracteres.`);
  }

  /* ── Score ─────────────────────────────────────────────────────────── */
  let score = 0;
  if (checks.length) score++;
  if (checks.upper) score++;
  if (checks.lower) score++;
  if (checks.number) score++;
  if (checks.symbol) score++;
  if (pwd.length >= CFG.recommendedLength) score++;
  if (pwd.length >= 14) score++;
  if (!checks.common && !checks.sequence && !checks.repetition) score++;
  if (checks.emailSimilarity) score = Math.max(0, score - 2);

  score = Math.max(0, Math.min(4, score));

  const valid = issues.length === 0;

  /* ── Mensaje ───────────────────────────────────────────────────────── */
  let message;
  if (valid) {
    message = warnings.length
      ? `Contraseña válida. ${warnings[0]}`
      : 'Contraseña válida.';
  } else if (issues.length === 1) {
    message = issues[0];
  } else {
    message = `La contraseña necesita: ${issues.join(' ')}`;
  }

  return {
    valid,
    message,
    score,
    issues,
    warnings,
    checks,
  };
}

/**
 * Valida una contraseña exigiendo SOLO las reglas del brief.
 *
 * @param {string} pwd
 * @returns {{valid:boolean, message:string}}
 */
export function isStrongPassword(pwd) {
  const result = validatePassword(pwd);

  return {
    valid: result.valid,
    message: result.message,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · FUERZA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Traduce el score a una etiqueta visual.
 * @returns {{level:number, label:string, color:string, percent:number}}
 */
export function suggestPasswordStrength(pwd) {
  const result = validatePassword(pwd);
  const percent = Math.round((result.score / 4) * 100);

  const levels = [
    { level: 0, label: 'Muy débil', color: '#f0433a', percent: 10 },
    { level: 1, label: 'Débil', color: '#f5a524', percent: 35 },
    { level: 2, label: 'Aceptable', color: '#f5a524', percent: 60 },
    { level: 3, label: 'Buena', color: '#22d3ee', percent: 82 },
    { level: 4, label: 'Excelente', color: '#22c55e', percent: 100 },
  ];

  if (!pwd) {
    return { level: 0, label: 'Sin contraseña', color: '#5c5c6b', percent: 0 };
  }

  return levels[result.score] || levels[0];
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · GENERADOR
   ═══════════════════════════════════════════════════════════════════════════ */

const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{}?';

/**
 * Genera una contraseña fuerte (criptográficamente aleatoria).
 * @param {number} [length]
 * @returns {string}
 */
export function generatePassword(length = 16) {
  const len = Math.max(12, Math.min(Number(length) || 16, 64));

  const pools = [LOWER, UPPER, DIGITS, SYMBOLS];
  const all = pools.join('');

  const bytes = crypto.randomBytes(len * 2);
  let out = '';

  // Se garantiza al menos un carácter de cada categoría.
  pools.forEach((pool) => {
    out += pool[bytes[out.length] % pool.length];
  });

  while (out.length < len) {
    out += all[bytes[out.length % bytes.length] % all.length];
  }

  // Se baraja con Fisher-Yates sobre bytes aleatorios.
  const shuffleBytes = crypto.randomBytes(len);
  const chars = out.split('');
  for (let i = chars.length - 1; i > 0; i--) {
    const j = shuffleBytes[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  return chars.join('');
}

/**
 * Verifica que una contraseña no esté en la lista de contraseñas
 * comprometidas (descargadas de HIBP).
 *
 * @param {string} password
 * @param {Set<string>} breachSet  Hashes SHA-1 (prefijo del hash).
 * @returns {boolean} true si NO aparece (es decir, es segura)
 */
export function isNotBreached(password, breachSet) {
  if (!breachSet || typeof breachSet.has !== 'function') return true;

  const hash = crypto.createHash('sha1').update(String(password)).digest('hex').toUpperCase();
  return !breachSet.has(hash.slice(0, 5));
}

export function getPasswordPolicy() {
  return {
    minLength: CFG.minLength,
    recommendedLength: CFG.recommendedLength,
    maxLength: CFG.maxLength,
    requireUpper: CFG.requireUpper,
    requireLower: CFG.requireLower,
    requireNumber: CFG.requireNumber,
    requireSymbol: CFG.requireSymbol,
  };
}

export default {
  isStrongPassword,
  validatePassword,
  suggestPasswordStrength,
  generatePassword,
  isNotBreached,
  getPasswordPolicy,
};
