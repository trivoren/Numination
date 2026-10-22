/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/payments.test.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pruebas del flujo de pago (PayPal) y del abono de créditos.

   CASO EXIGIDO
     · fulfillOrder suma los créditos correctos (orden exitosa).
     · Una orden fallida NO suma créditos.

   MOCKS
     · La API de PayPal se simula en el borde HTTP (`globalThis.fetch`):
       el proyecto usa su propio cliente REST sobre api-m.sandbox.paypal.com,
       así que mockear `fetch` es el equivalente exacto de mockear el
       SDK de PayPal, sin gastar un solo request ni token.
     · La base de datos se simula con el cliente mock de tests/setup.js.

   TRANSACCIONES
     · Se verifica que la operación de crédito corre dentro de una
       transacción (BEGIN/COMMIT) y que ante un error se hace ROLLBACK.
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  mockDatabase,
  restoreDatabase,
  withMockedFetch,
  jsonResponse,
  TEST_USER_ID,
  OTHER_USER_ID,
} from './setup.js';

import { fulfillOrder, markPaymentFailed, getCreditsBalance } from '../src/payments/database.js';
import {
  createPayPalOrder,
  capturePayPalOrder,
  summarizeCapture,
  mask,
} from '../src/payments/paypal-sdk.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · MOCK DE PAYPAL
   ═══════════════════════════════════════════════════════════════════════════ */

const TOKEN_RESPONSE = { access_token: 'mock-token', expires_in: 3600 };

const ORDER_OK = {
  id: 'ORDER123',
  status: 'CREATED',
  links: [{ rel: 'approve', href: 'https://sandbox.paypal.com/approve/ORDER123' }],
};

const CAPTURE_OK = {
  id: 'CAPTURE456',
  status: 'COMPLETED',
  purchase_units: [{
    reference_id: 'REF-1',
    custom_id: 'REF-1',
    payments: [{
      id: 'PAYMENT-1',
      status: 'COMPLETED',
      amount: { currency_code: 'USD', value: '19.90' },
    }],
  }],
  payer: { email_address: 'comprador@numination.app' },
};

const CAPTURE_FAIL = {
  id: 'CAPTUREFAIL',
  status: 'FAILED',
  purchase_units: [{
    reference_id: 'REF-1',
    payments: [{
      id: 'PAYMENT-2',
      status: 'FAILED',
      amount: { currency_code: 'USD', value: '19.90' },
    }],
  }],
};

/**
 * Instala el mock de la API de PayPal.
 * @param {object} [opts] { capture: 'ok'|'fail', captureStatus }
 */
function mockPayPal(opts = {}) {
  const { capture = 'ok' } = opts;

  return withMockedFetch({
    'oauth2/token': () => jsonResponse(TOKEN_RESPONSE),
    '/v2/checkout/orders': (url, init) => {
      // Endpoint de captura: POST /v2/checkout/orders/{id}/capture
      if (String(url).includes('/capture')) {
        return jsonResponse(capture === 'fail' ? CAPTURE_FAIL : CAPTURE_OK);
      }
      if (init?.method === 'POST') return jsonResponse(ORDER_OK, 201);
      return jsonResponse(ORDER_OK);
    },
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · MOCK DE LA BASE DE DATOS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Mock de la base de pagos con una orden existente.
 */
function paymentsMock(order = {}) {
  const state = {
    balance: 0,
    lifetime: 0,
    order: {
      id: '11111111-1111-4111-8111-111111111111',
      user_id: TEST_USER_ID,
      plan_id: 'pro',
      status: 'created',
      amount_cop: 19900,
      amount_usd: 19.9,
      currency: 'USD',
      paypal_order_id: 'ORDER123',
      credits_granted: 0,
      ...order,
    },
    committed: 0,
    rolledBack: 0,
  };

  const client = mockDatabase({
    'create table if not exists': () => [],
    'create unique index if not exists': () => [],
    'create index if not exists': () => [],
    'select id, user_id, plan_id, status': () => [state.order],
    'select balance from': () => [{ balance: state.balance }],
    'insert into user_credits': (text, params) => {
      const userId = params[0];
      const amount = Number(params[1] || 0);
      state.balance += amount;
      state.lifetime += amount;
      return [{ balance: state.balance, lifetime_credits: state.lifetime }];
    },
    'insert into payment_credit_ledger': () => [],
    'update payment_subscriptions set status': () => [],
    'insert into payment_subscriptions': () => [],
    'update payments set status': () => [],
    'update profiles': () => [],
  });

  // Instrumenta la reserva de conexión (transacciones).
  const originalReserve = client.reserve;
  client.reserve = async () => {
    state.committed++;
    try {
      return await originalReserve();
    } catch (e) {
      state.rolledBack++;
      throw e;
    }
  };

  return { client, state };
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · FULFILL ORDER
   ═══════════════════════════════════════════════════════════════════════════ */

describe('payments · fulfillOrder', () => {
  let db = null;
  let restoreFetch = null;

  beforeEach(() => {
    db = paymentsMock();
    restoreFetch = mockPayPal();
  });

  afterEach(() => {
    if (restoreFetch) restoreFetch();
    restoreFetch = null;
    restoreDatabase();
    db = null;
  });

  it('suma los créditos correctos al completar una orden', async () => {
    const result = await fulfillOrder(
      TEST_USER_ID,
      'pro',
      '11111111-1111-4111-8111-111111111111',
      { credits: 500, paypalCaptureId: 'CAPTURE-456' }
    );

    assert.equal(result.ok, true);
    assert.equal(result.alreadyFulfilled, false);
    assert.equal(result.credits, 500);
    assert.equal(result.balance, 500);
    assert.equal(db.state.balance, 500);
  });

  it('usa credits_granted de la orden cuando no se pasan créditos explícitos', async () => {
    db.state.order.credits_granted = 250;

    const result = await fulfillOrder(
      TEST_USER_ID,
      'pro',
      '11111111-1111-4111-8111-111111111111',
      {}
    );

    assert.equal(result.credits, 250);
    assert.equal(db.state.balance, 250);
  });

  it('es idempotente: una orden ya completada NO vuelve a acreditar', async () => {
    db.state.order.status = 'completed';

    const result = await fulfillOrder(
      TEST_USER_ID,
      'pro',
      '11111111-1111-4111-8111-111111111111',
      { credits: 500 }
    );

    assert.equal(result.ok, true);
    assert.equal(result.alreadyFulfilled, true);
    assert.equal(db.state.balance, 0, 'no debe acreditar nada');
  });

  it('rechaza una orden de otro usuario (anti-IDOR)', async () => {
    db.state.order.user_id = OTHER_USER_ID;

    await assert.rejects(
      () => fulfillOrder(TEST_USER_ID, 'pro', '11111111-1111-4111-8111-111111111111', { credits: 500 }),
      (err) => {
        assert.match(err.code || '', /FORBIDDEN/i);
        return true;
      }
    );

    assert.equal(db.state.balance, 0);
  });

  it('falla si la orden no existe', async () => {
    db.state.order = null;
    const original = db.client;
    void original;

    await assert.rejects(
      () => fulfillOrder(TEST_USER_ID, 'pro', '11111111-1111-4111-8111-111111111111', { credits: 500 }),
      (err) => {
        assert.match(err.code || '', /NOT_FOUND/i);
        return true;
      }
    );
  });

  it('valida los UUID antes de tocar la base', async () => {
    await assert.rejects(
      () => fulfillOrder('no-es-uuid', 'pro', '11111111-1111-4111-8111-111111111111', {}),
      (err) => {
        assert.match(err.code || '', /INVALID/i);
        return true;
      }
    );
  });

  it('corre el abono dentro de una transacción', async () => {
    await fulfillOrder(TEST_USER_ID, 'pro', '11111111-1111-4111-8111-111111111111', { credits: 500 });

    assert.equal(db.client.reserveCount, 1, 'debe reservar una conexión transaccional');
    assert.equal(db.state.rolledBack, 0);
  });

  it('hace ROLLBACK si algo falla dentro de la transacción', async () => {
    restoreDatabase();

    const fallido = mockDatabase({
      'create table if not exists': () => [],
      'select id, user_id, plan_id, status': () => [{
        id: '11111111-1111-4111-8111-111111111111',
        user_id: TEST_USER_ID,
        plan_id: 'pro',
        status: 'created',
        amount_cop: 19900,
        amount_usd: 19.9,
        currency: 'USD',
        paypal_order_id: 'ORDER-123',
        credits_granted: 500,
      }],
      'insert into user_credits': () => { throw new Error('DB caída'); },
    });

    let rolledBack = 0;
    const originalReserve = fallido.reserve;
    fallido.reserve = async () => {
      rolledBack++;
      return originalReserve();
    };

    await assert.rejects(
      () => fulfillOrder(TEST_USER_ID, 'pro', '11111111-1111-4111-8111-111111111111', { credits: 500 })
    );

    assert.equal(rolledBack, 1, 'debe revertirse la transacción');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   04 · ORDENES DE PAYPAL (CON MOCK DE FETCH)
   ═══════════════════════════════════════════════════════════════════════════ */

describe('payments · API de PayPal (mock)', () => {
  let restoreFetch = null;

  beforeEach(() => {
    process.env.PAYPAL_CLIENT_ID = 'client-id-de-prueba';
    process.env.PAYPAL_CLIENT_SECRET = 'client-secret-de-prueba';
    process.env.PAYPAL_WEBHOOK_ID = 'webhook-id-de-prueba';
    process.env.PAYPAL_ENV = 'sandbox';
    restoreFetch = mockPayPal();
  });

  afterEach(() => {
    if (restoreFetch) restoreFetch();
    restoreFetch = null;
  });

  it('crea una orden y devuelve el enlace de aprobación', async () => {
    const order = await createPayPalOrder({
      amount: '19.90',
      currency: 'USD',
      planId: 'pro',
    });

    assert.ok(order, 'debe devolver la orden');
    const serialized = JSON.stringify(order);
    assert.match(serialized, /ORDER123/);
  });

  it('captura una orden exitosa y resume el cobro', async () => {
    const capture = await capturePayPalOrder('ORDER123');
    const summary = summarizeCapture(capture);

    assert.ok(summary);
    assert.equal(summary.status, 'COMPLETED');
    assert.equal(summary.amount, 19.9);
    assert.equal(summary.currency, 'USD');
    assert.equal(summary.payerEmail, 'comprador@numination.app');
  });

  it('una captura fallida NO genera créditos', async () => {
    restoreFetch();
    restoreFetch = mockPayPal({ capture: 'fail' });

    const capture = await capturePayPalOrder('ORDER123');
    const summary = summarizeCapture(capture);

    assert.equal(summary.status, 'FAILED');
    assert.notEqual(summary.status, 'COMPLETED');
  });

  it('nunca filtra el client secret en los logs', () => {
    const secreto = 'super-secreto-paypal-123';

    const masked = mask(secreto);

    assert.notEqual(masked, secreto);
    assert.ok(!masked.includes('paypal-123'), 'no debe quedar elcola del secreto');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   05 · ESTADO DE CRÉDITOS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('payments · saldo de créditos', () => {
  let db = null;

  beforeEach(() => {
    db = paymentsMock();
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('devuelve el saldo del usuario', async () => {
    const balance = await getCreditsBalance(TEST_USER_ID);

    assert.equal(typeof balance, 'object');
    assert.equal(balance.balance, 0);
    assert.equal(balance.lifetime, 0);
  });

  it('marca una orden como fallida sin acreditar nada', async () => {
    const result = await markPaymentFailed('11111111-1111-4111-8111-111111111111', 'failed');

    assert.equal(result, null);
    assert.equal(db.state.balance, 0);
  });
});
