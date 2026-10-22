/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/referral.test.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pruebas del programa de referidos.

   CASO EXIGIDO
     · processReferral suma 1000 créditos al INVITADOR y 500 al INVITADO,
       dentro de una transacción.

   Y ADEMÁS
     · un código inexistente no reparte créditos
     · un código inválido (formato) se normaliza
     · el auto-referido se rechaza
     · el mismo código no se puede canjear dos veces
     · los créditos se acreditan de forma atómica (upsert con suma)
     · el ledger deja rastro de cada movimiento
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { mockDatabase, restoreDatabase, TEST_USER_ID, OTHER_USER_ID } from './setup.js';
import {
  processReferral,
  applyReferralCode,
  generateReferralCode,
  validateCode,
  normalizeCode,
  getReferralConfig,
} from '../src/services/referral-program.js';

/* ═══════════════════════════════════════════════════════════════════════════
   1 · MOCK DE LA BASE DE DATOS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Mock con la tabla `referrals` poblada y las columnas de crédito.
 * `creditos` registra los saldos resultantes de cada acreditación.
 */
function referralMock(options = {}) {
  const {
    referrals = [{ code: 'NUMI-EMILIO', user_id: OTHER_USER_ID, display_name: 'Emilio' }],
    conversionRows = [],
  } = options;

  const state = { credits: {}, conversions: conversionRows };

  const client = mockDatabase({
    'create table if not exists referrals': () => [],
    'create table if not exists referral_conversions': () => [],
    'create table if not exists referral_credit_ledger': () => [],
    'create index if not exists referrals_user_idx': () => [],
    'create index if not exists referral_ledger_user_idx': () => [],
    'select code, display_name, is_active': (text, params) => {
      // Filtra por el código buscado: un código inexistente no debe
      // devolver la fila de otro.
      const sought = String(params[params.length - 1] || '').toUpperCase();
      return referrals
        .filter((r) => r.code.toUpperCase() === sought)
        .map((r) => ({
          code: r.code,
          display_name: r.display_name,
          is_active: true,
          clicks: 0,
          conversions: 0,
        }));
    },
    'select user_id::text as user_id, code, display_name from referrals where code': (text, params) => {
      // Búsqueda por código (canje): el parámetro es el código.
      const sought = String(params[0] || '').toUpperCase();
      return referrals
        .filter((r) => r.code.toUpperCase() === sought)
        .map((r) => ({
          user_id: r.user_id,
          code: r.code,
          display_name: r.display_name,
        }));
    },
    'select code, display_name, email, clicks': (text, params) => {
      // Búsqueda por usuario (código ya generado): el parámetro es el user_id.
      const userId = String(params[0] || '');
      return referrals
        .filter((r) => !userId || r.user_id === userId)
        .map((r) => ({
          code: r.code,
          display_name: r.display_name,
          email: r.email ?? null,
          clicks: 0,
          conversions: 0,
          credits_awarded: 0,
          created_at: new Date().toISOString(),
        }));
    },
    'insert into referrals': (text, values) => {
      // El primer valor es el identificador de tabla interpolado; el
      // código es el valor que empieza por "NUMI-".
      const code = values.find((v) => typeof v === 'string' && v.startsWith('NUMI-'))
        || values[2];
      return [{
        code,
        display_name: values[3] ?? null,
        email: values[4] ?? null,
        created_at: new Date().toISOString(),
      }];
    },
    'insert into referral_conversions': (text, values) => {
      // Simula el ON CONFLICT DO NOTHING: si ya existe, no devuelve filas.
      if (state.conversions.some((c) => c.code === values[0] && c.referred_id === values[2])) {
        return [];
      }
      state.conversions.push({ code: values[0], referrer_id: values[1], referred_id: values[2] });
      return [{ id: 'conv-1' }];
    },
    'insert into credits': (text, values) => {
      const userId = values[0];
      const amount = Number(values[1]);
      state.credits[userId] = (state.credits[userId] || 0) + amount;
      return [{ balance: state.credits[userId] }];
    },
    'select balance from credits': (text, values) => [
      { balance: state.credits[values[0]] || 0 },
    ],
    'insert into referral_credit_ledger': () => [],
    'update referrals set conversions': () => [],
    'update referrals set clicks': () => [],
    'select code, clicks, conversions': () => referrals.map((r) => ({
      code: r.code,
      display_name: r.display_name,
      clicks: 0,
      conversions: 0,
      credits_awarded: 0,
      created_at: new Date().toISOString(),
    })),
    'select code, clicks': () => referrals.map((r) => ({
      code: r.code,
      display_name: r.display_name,
      clicks: 0,
      conversions: 0,
      credits_awarded: 0,
      created_at: new Date().toISOString(),
    })),
    'select id::text as id, code, display_name': () => referrals.map((r) => ({
      id: `ref-${r.code}`,
      code: r.code,
      display_name: r.display_name,
      email: null,
      clicks: 0,
      conversions: 0,
      credits_awarded: 0,
      created_at: new Date().toISOString(),
    })),
  });

  return { client, state };
}

/* ═══════════════════════════════════════════════════════════════════════════
   2 · EL CASO EXIGIDO
   ═══════════════════════════════════════════════════════════════════════════ */

describe('referral · reparto de créditos', () => {
  let db = null;

  beforeEach(() => {
    db = referralMock();
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('suma 1000 créditos al invitador y 500 al invitado', async () => {
    const result = await processReferral({
      code: 'NUMI-EMILIO',
      referredId: TEST_USER_ID,
      referredEmail: 'nuevo@numination.app',
    });

    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.equal(result.referrerCredits, 1000);
    assert.equal(result.referredCredits, 500);

    // El invitante (OTHER_USER_ID) recibe 1000.
    assert.equal(db.state.credits[OTHER_USER_ID], 1000);
    // El invitado (TEST_USER_ID) recibe 500.
    assert.equal(db.state.credits[TEST_USER_ID], 500);
  });

  it('acredita los créditos con un UPSERT atómico (suma, no overwrite)', async () => {
    await processReferral({ code: 'NUMI-EMILIO', referredId: TEST_USER_ID });

    const inserts = db.client.callsMatching('insert into credits');

    assert.ok(inserts.length >= 2, 'un insert por usuario');

    for (const call of inserts) {
      assert.match(
        call.text.replace(/\s+/g, ' '),
        /on conflict/i,
        'debe usar ON CONFLICT para no perder el saldo anterior'
      );
      assert.match(call.text.replace(/\s+/g, ' '), /balance\s*=\s*\w*\.?balance\s*\+/i);
    }
  });

  it('deja rastro en el ledger de créditos', async () => {
    await processReferral({ code: 'NUMI-EMILIO', referredId: TEST_USER_ID });

    const ledger = db.client.callsMatching('insert into referral_credit_ledger');

    assert.equal(ledger.length, 2, 'un asiento por usuario acreditado');
  });

  it('el canje queda registrado en referral_conversions con ambos usuarios', async () => {
    await processReferral({ code: 'NUMI-EMILIO', referredId: TEST_USER_ID });

    assert.equal(db.state.conversions.length, 1);
    assert.equal(db.state.conversions[0].code, 'NUMI-EMILIO');
    assert.equal(db.state.conversions[0].referrer_id, OTHER_USER_ID);
    assert.equal(db.state.conversions[0].referred_id, TEST_USER_ID);
  });

  it('el importe viene de la configuración, no de un número mágico', () => {
    const config = getReferralConfig();

    assert.equal(config.referrerCredits, 1000);
    assert.equal(config.referredCredits, 500);
    assert.equal(config.prefix, 'NUMI');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3 · CASOS INVÁLIDOS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('referral · casos inválidos', () => {
  let db = null;

  beforeEach(() => {
    db = referralMock();
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('un código inexistente no reparte créditos', async () => {
    const result = await processReferral({ code: 'NUMI-NOEXISTE', referredId: TEST_USER_ID });

    assert.equal(result.ok, true);
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'invalid_code');
    assert.deepEqual(db.state.credits, {});
  });

  it('rechaza el auto-referido', async () => {
    const result = await processReferral({
      code: 'NUMI-EMILIO',
      referredId: OTHER_USER_ID,   // el mismo que es dueño del código
    });

    assert.equal(result.applied, false);
    assert.equal(result.reason, 'self_referral');
    assert.deepEqual(db.state.credits, {});
  });

  it('exige código y usuario', async () => {
    const sinCodigo = await processReferral({ referredId: TEST_USER_ID });
    const sinUsuario = await processReferral({ code: 'NUMI-EMILIO' });

    assert.equal(sinCodigo.applied, false);
    assert.equal(sinUsuario.applied, false);
  });

  it('no reparte dos veces con el mismo código y el mismo usuario', async () => {
    const primero = await processReferral({ code: 'NUMI-EMILIO', referredId: TEST_USER_ID });
    const segundo = await processReferral({ code: 'NUMI-EMILIO', referredId: TEST_USER_ID });

    assert.equal(primero.applied, true);
    assert.equal(segundo.applied, false);
    assert.equal(segundo.reason, 'already_applied');
    assert.equal(db.state.credits[TEST_USER_ID], 500, 'sólo se acreditó una vez');
  });

  it('applyReferralCode es el mismo comportamiento que processReferral', async () => {
    assert.equal(processReferral, applyReferralCode);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4 · NORMALIZACIÓN Y VALIDACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

describe('referral · normalización y validación', () => {
  let db = null;

  beforeEach(() => {
    db = referralMock();
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('normaliza el formato del código', () => {
    assert.equal(normalizeCode('numi-emilio'), 'NUMI-EMILIO');
    assert.equal(normalizeCode('NUMI EMILIO'), 'NUMI-EMILIO');
    assert.equal(normalizeCode('emilio'), 'NUMI-EMILIO');
    assert.equal(normalizeCode(''), null);
  });

  it('valida un código existente', async () => {
    const result = await validateCode('NUMI-EMILIO');

    assert.equal(result.valid, true);
    assert.equal(result.code, 'NUMI-EMILIO');
    assert.equal(result.referrer.name, 'Emilio');
  });

  it('invalida un código inexistente', async () => {
    const result = await validateCode('NUMI-FANTASMA');

    assert.equal(result.valid, false);
    assert.equal(result.reason, 'not_found');
  });

  it('genera un código legible con el nombre del usuario', async () => {
    const result = await generateReferralCode({
      userId: TEST_USER_ID,
      name: 'Emilio García',
      email: 'emilio@numination.app',
    });

    assert.equal(result.ok, true);
    assert.match(result.code, /^NUMI-[A-Z0-9]{4,6}$/);
  });
});
