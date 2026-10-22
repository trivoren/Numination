/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/password-validator.test.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pruebas de la política de contraseñas.

   CASOS EXIGIDOS
     · "123456"      → RECHAZADA (sin mayúscula, sin símbolo)
     · "password"   → RECHAZADA (sin mayúscula, sin número, sin símbolo)
     · "Fuerte123"  → RECHAZADA (sin símbolo)
     · "Fuerte#2024"→ ACEPTADA

   Y ADEMÁS
     · longitud mínima (8)
     · contraseñas triviales ("password", "qwerty", "admin")
     · secuencias del teclado y repeticiones
     · similitud con el correo del usuario
     · medidor de fuerza y generador criptográfico
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  isStrongPassword,
  validatePassword,
  suggestPasswordStrength,
  generatePassword,
  isNotBreached,
  getPasswordPolicy,
} from '../src/services/password-validator.js';

/* ═══════════════════════════════════════════════════════════════════════════
   1 · LOS CASOS EXIGIDOS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('password-validator · casos exigidos', () => {
  it('rechaza "123456": le faltan mayúscula y símbolo', () => {
    const result = isStrongPassword('123456');

    assert.equal(result.valid, false);
    assert.equal(typeof result.message, 'string');
    assert.ok(result.message.length > 0, 'debe explicar por qué falla');
    assert.match(result.message, /mayúscula/i);
    assert.match(result.message, /símbolo/i);
  });

  it('rechaza "password": le faltan mayúscula, número y símbolo', () => {
    const result = isStrongPassword('password');

    assert.equal(result.valid, false);
    assert.match(result.message, /mayúscula/i);
    assert.match(result.message, /número/i);
    assert.match(result.message, /símbolo/i);
  });

  it('rechaza "Fuerte123": no tiene símbolo', () => {
    const result = isStrongPassword('Fuerte123');

    assert.equal(result.valid, false);
    assert.match(result.message, /símbolo/i);
  });

  it('acepta "Fuerte#2024"', () => {
    const result = isStrongPassword('Fuerte#2024');

    assert.equal(result.valid, true);
    assert.equal(typeof result.message, 'string');
  });

  it('devuelve { valid, message } y nada más en la API pública', () => {
    const result = isStrongPassword('Fuerte#2024');

    assert.deepEqual(Object.keys(result).sort(), ['message', 'valid']);
    assert.equal(typeof result.valid, 'boolean');
    assert.equal(typeof result.message, 'string');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   2 · LONGITUD Y REQUISITOS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('password-validator · longitud y requisitos', () => {
  it('exige 8 caracteres como mínimo', () => {
    const result = validatePassword('Ab1#def');

    assert.equal(result.valid, false);
    assert.match(result.message, /8 caracteres/i);
  });

  it('acepta exactamente 8 caracteres si cumple el resto', () => {
    const result = validatePassword('Abc1#def');

    assert.equal(result.valid, true);
  });

  it('acepta un correo con @ porque cuenta como símbolo', () => {
    const result = validatePassword('Abc1234@');

    assert.equal(result.valid, true);
  });

  it('rechaza una contraseña vacía con un mensaje claro', () => {
    const result = validatePassword('');

    assert.equal(result.valid, false);
    assert.match(result.message, /vacía/i);
  });

  it('rechaza una contraseña con espacios', () => {
    const result = validatePassword('        ');

    assert.equal(result.valid, false);
  });

  it('devuelve la lista de requisitos que faltan', () => {
    const result = validatePassword('abc');

    assert.equal(result.valid, false);
    assert.ok(Array.isArray(result.issues));
    assert.ok(result.issues.length >= 3);
    assert.ok(result.issues.every((i) => typeof i === 'string'));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3 · CONTRASEÑAS TRIVIALES Y PATRONES
   ═══════════════════════════════════════════════════════════════════════════ */

describe('password-validator · contraseñas débiles', () => {
  it('marca "Password1!" como débil por ser común (pero válida formalmente)', () => {
    const result = validatePassword('Password1!');

    assert.equal(result.valid, true, 'cumple los requisitos formales');
    assert.equal(result.checks.common, true);
    assert.ok(result.warnings.length > 0, 'debe avisar que es común');
  });

  it('detecta secuencias del teclado', () => {
    const result = validatePassword('Abcdef1!');

    assert.equal(result.checks.sequence, true);
    assert.ok(result.warnings.some((w) => /secuencia/i.test(w)));
  });

  it('detecta la repetición de un mismo carácter', () => {
    const result = validatePassword('Aaaaaaa1!');

    assert.equal(result.checks.repetition, true);
  });

  it('penaliza una contraseña que contiene el correo del usuario', () => {
    const result = validatePassword('Emilio2024#', { email: 'emilio@numination.app' });

    assert.ok(result.checks.emailSimilarity, 'debe detectar la similitud con el correo');
    assert.ok(result.warnings.some((w) => /correo/i.test(w)));
  });

  it('baja el score cuando la contraseña es una palavra común', () => {
    const strong = validatePassword('Xq7#mLp2$Rt9wQz');
    const common = validatePassword('Password1!');

    assert.ok(common.score < strong.score);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4 · MEDIDOR DE FUERZA
   ═══════════════════════════════════════════════════════════════════════════ */

describe('password-validator · medidor de fuerza', () => {
  it('devuelve nivel 0 y etiqueta para una contraseña vacía', () => {
    const strength = suggestPasswordStrength('');

    assert.equal(strength.level, 0);
    assert.equal(typeof strength.label, 'string');
    assert.equal(strength.percent, 0);
  });

  it('devuelve el nivel máximo para una contraseña fuerte', () => {
    const strength = suggestPasswordStrength('Xq7#mLp2$Rt9wQz');

    assert.equal(strength.level, 4);
    assert.equal(strength.percent, 100);
    assert.ok(strength.color.startsWith('#'));
  });

  it('sube de nivel con contraseñas más largas', () => {
    const short = suggestPasswordStrength('Zq7#mLp');
    const long = suggestPasswordStrength('Zq7#mLp2$Rt');

    assert.ok(long.level >= short.level);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5 · GENERADOR
   ═══════════════════════════════════════════════════════════════════════════ */

describe('password-validator · generador', () => {
  let generated = null;

  beforeEach(() => {
    generated = generatePassword(16);
  });

  afterEach(() => {
    generated = null;
  });

  it('genera una contraseña de la longitud pedida', () => {
    assert.equal(generated.length, 16);
  });

  it('genera una contraseña que supera la validación', () => {
    assert.equal(isStrongPassword(generated).valid, true);
  });

  it('genera contraseñas distintas en cada llamada', () => {
    const otra = generatePassword(16);

    assert.notEqual(generated, otra);
  });

  it('respeta la longitud mínima (12) aunque se pida menos', () => {
    assert.equal(generatePassword(4).length, 12);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   6 · POLÍTICA Y BREACHES
   ═══════════════════════════════════════════════════════════════════════════ */

describe('password-validator · política y filtraciones', () => {
  it('expone la política vigente', () => {
    const policy = getPasswordPolicy();

    assert.equal(policy.minLength, 8);
    assert.equal(policy.requireUpper, true);
    assert.equal(policy.requireNumber, true);
    assert.equal(policy.requireSymbol, true);
  });

  it('detecta una contraseña filtrada (hash SHA-1 prefijo)', () => {
    // SHA-1 de "password" → 5BAA6...
    const hash = crypto.createHash('sha1').update('password').digest('hex').toUpperCase();
    const breached = new Set([hash.slice(0, 5)]);

    assert.equal(isNotBreached('password', breached), false);
    assert.equal(isNotBreached('Xq7#mLp2$', breached), true);
  });
});
