/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/ban-manager.test.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pruebas de la escalera de sanciones por spam (3 strikes).

   ESCALAMIENTO EXIGIDO
     · Strike 1 → { warning: 'Cuidado con el spam' }   (NO suspende)
     · Strike 2 → suspende 24 h                          (suspended_until)
     · Strike 3 → baneo permanente                       (banned = true)
                    + destruye la sesión

   La base de datos está MOCKEADA (tests/setup.js → mockDatabase): no se
   toca Postgres. El mock registra todas las consultas para poder
   verificar que el filtro por usuario está SIEMPRE en el WHERE.
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { mockDatabase, restoreDatabase, TEST_USER_ID, OTHER_USER_ID } from './setup.js';
import {
  applySanction,
  getModerationState,
  clearSanction,
  banGuard,
  getBanManagerConfig,
} from '../src/middleware/ban-manager.js';
import { mockReqRes, flush } from './setup.js';

/* ═══════════════════════════════════════════════════════════════════════════
   1 · MOCK DE LA BASE DE DATOS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Crea un mock de la tabla de moderación con un contador de strikes
 * que se incrementa como en la base real.
 */
function moderationMock(initialStrikes = 0) {
  const state = { strikes: initialStrikes, banned: false, suspendedUntil: null };

  const client = mockDatabase({
    'insert into user_moderation': () => {
      state.strikes += 1;
      return [{
        strikes: state.strikes,
        last_score: 95,
        banned: state.banned,
        suspended_until: state.suspendedUntil,
      }];
    },
    'update user_moderation': (text) => {
      if (/banned\s*=\s*true/.test(text)) {
        state.banned = true;
        state.suspendedUntil = null;
      }
      if (/suspended_until\s*=/.test(text) && !/banned/.test(text)) {
        state.suspendedUntil = '2026-10-23T00:00:00.000Z';
      }
      if (/strikes\s*=\s*0/.test(text)) {
        state.strikes = 0;
        state.banned = false;
        state.suspendedUntil = null;
      }
      return [];
    },
    'update public.profiles': () => [],
    'select strikes': () => [{
      strikes: state.strikes,
      last_score: 95,
      banned: state.banned,
      suspended_until: state.suspendedUntil,
    }],
  });

  return { client, state };
}

/* ═══════════════════════════════════════════════════════════════════════════
   2 · LOS 3 STRIKES
   ═══════════════════════════════════════════════════════════════════════════ */

describe('ban-manager · los 3 strikes', () => {
  let db = null;

  beforeEach(() => {
    db = moderationMock(0);
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('strike 1: devuelve la advertencia y NO suspende', async () => {
    const result = await applySanction({
      userId: TEST_USER_ID,
      score: 95,
      reason: 'test',
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'warning');
    assert.equal(result.warning, 'Cuidado con el spam');
    assert.equal(result.strikes, 1);
    assert.equal(result.suspended, false);
    assert.equal(result.banned, false);
    assert.equal(result.suspendedUntil, null);
  });

  it('strike 2: suspende la cuenta 24 h', async () => {
    // Se llega al strike 2 con un mock que ya tiene 1 strike.
    restoreDatabase();
    db = moderationMock(1);

    const result = await applySanction({
      userId: TEST_USER_ID,
      score: 95,
      reason: 'test',
    });

    assert.equal(result.action, 'suspend');
    assert.equal(result.strikes, 2);
    assert.equal(result.suspended, true);
    assert.equal(result.banned, false);
    assert.ok(result.suspendedUntil, 'debe indicar hasta cuándo');
    assert.ok(result.message.includes('24 horas'));
  });

  it('strike 3: banea permanentemente', async () => {
    restoreDatabase();
    db = moderationMock(2);

    const result = await applySanction({
      userId: TEST_USER_ID,
      score: 95,
      reason: 'test',
    });

    assert.equal(result.action, 'ban');
    assert.equal(result.strikes, 3);
    assert.equal(result.banned, true);
    assert.equal(result.suspended, false);
    assert.match(result.message, /baneada/i);
  });

  it('la escalera completa: 1 aviso → 2 suspensión → 3 baneo', async () => {
    restoreDatabase();
    db = moderationMock(0);

    const primero = await applySanction({ userId: TEST_USER_ID, score: 90 });
    const segundo = await applySanction({ userId: TEST_USER_ID, score: 90 });
    const tercero = await applySanction({ userId: TEST_USER_ID, score: 90 });

    assert.equal(primero.action, 'warning');
    assert.equal(segundo.action, 'suspend');
    assert.equal(tercero.action, 'ban');
    assert.equal(db.state.banned, true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   3 · UMBRAL Y AISLAMIENTO
   ═══════════════════════════════════════════════════════════════════════════ */

describe('ban-manager · umbral y aislamiento', () => {
  let db = null;

  beforeEach(() => {
    db = moderationMock(0);
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('un score igual o menor a 80 no sanciona', async () => {
    const result = await applySanction({ userId: TEST_USER_ID, score: 80 });

    assert.equal(result.action, 'none');
    assert.equal(result.strikes, 0);
    assert.equal(db.client.calls.length, 0, 'no debe tocar la base de datos');
  });

  it('un score de 81 sí sanciona', async () => {
    const result = await applySanction({ userId: TEST_USER_ID, score: 81 });

    assert.equal(result.action, 'warning');
  });

  it('exige userId', async () => {
    const result = await applySanction({ userId: null, score: 99 });

    assert.equal(result.ok, false);
    assert.equal(result.action, 'none');
  });

  it('el INSERT y el UPDATE filtran siempre por user_id (nunca hay sanción cruzada)', async () => {
    // Strike 1: sólo hay INSERT.
    await applySanction({ userId: TEST_USER_ID, score: 95 });

    const inserts = db.client.callsMatching('insert into user_moderation');

    assert.ok(inserts.length > 0, 'debe haber un insert');
    for (const call of inserts) {
      assert.ok(
        call.values.includes(TEST_USER_ID),
        'el user_id debe viajar como parámetro del INSERT'
      );
    }

    // Strike 2: además hay UPDATE (suspensión).
    restoreDatabase();
    db = moderationMock(1);

    await applySanction({ userId: TEST_USER_ID, score: 95 });

    const updates = db.client.callsMatching('update user_moderation');

    assert.ok(updates.length > 0, 'debe haber un update');
    for (const call of updates) {
      assert.ok(
        call.values.includes(TEST_USER_ID),
        'el user_id debe viajar como parámetro del UPDATE'
      );
      assert.ok(!call.text.includes(OTHER_USER_ID));
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   4 · ESTADO Y REVERSIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

describe('ban-manager · estado y reversión', () => {
  let db = null;

  beforeEach(() => {
    db = moderationMock(0);
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('getModerationState devuelve los contadores', async () => {
    const state = await getModerationState(TEST_USER_ID);

    assert.equal(state.ok, true);
    assert.equal(state.strikes, 0);
    assert.equal(state.banned, false);
    assert.equal(state.suspended, false);
  });

  it('clearSanction reinicia los contadores', async () => {
    await applySanction({ userId: TEST_USER_ID, score: 95 });

    const result = await clearSanction(TEST_USER_ID);

    assert.equal(result.ok, true);
    assert.equal(db.state.strikes, 0);
    assert.equal(db.state.banned, false);
  });

  it('expone la configuración de la escalera', () => {
    const config = getBanManagerConfig();

    assert.equal(config.scoreThreshold, 80);
    assert.equal(config.strikesBeforeSuspension, 2);
    assert.equal(config.strikesBeforeBan, 3);
    assert.equal(config.suspensionHours, 24);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   5 · EL GUARD (MIDDLEWARE)
   ═══════════════════════════════════════════════════════════════════════════ */

describe('ban-manager · guard', () => {
  let db = null;

  beforeEach(() => {
    db = moderationMock(0);
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('deja pasar a un usuario sin sanciones', async () => {
    const { req, res, next, calls } = mockReqRes({ user: { id: TEST_USER_ID } });

    await banGuard()(req, res, next);

    assert.equal(calls.status, null);
    assert.equal(calls.nextCalled, true);
  });

  it('bloquea con 403 a un usuario baneado', async () => {
    db.state.banned = true;

    const { req, res, next, calls } = mockReqRes({ user: { id: TEST_USER_ID } });

    await banGuard()(req, res, next);

    assert.equal(calls.status, 403);
    assert.equal(calls.json.code, 'account_banned');
    assert.equal(calls.nextCalled, undefined);
  });

  it('bloquea con 403 a un usuario suspendido', async () => {
    db.state.suspendedUntil = new Date(Date.now() + 3600_000).toISOString();

    const { req, res, next, calls } = mockReqRes({ user: { id: TEST_USER_ID } });

    await banGuard()(req, res, next);

    assert.equal(calls.status, 403);
    assert.equal(calls.json.code, 'account_suspended');
    assert.ok(calls.headers['retry-after']);
  });

  it('no bloquea a un usuario sin sesión (fail-open)', async () => {
    const { req, res, next, calls } = mockReqRes({ user: null });

    await banGuard()(req, res, next);

    assert.equal(calls.status, null);
    assert.equal(calls.nextCalled, true);
  });

  it('deja pasar si la base falla (fail-open: no dejaría fuera al usuario)', async () => {
    restoreDatabase();
    mockDatabase({
      'select strikes': () => { throw new Error('DB caída'); },
    });

    const { req, res, next, calls } = mockReqRes({ user: { id: TEST_USER_ID } });

    await banGuard()(req, res, next);

    assert.equal(calls.status, null);
    assert.equal(calls.nextCalled, true);
  });
});
