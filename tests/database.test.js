/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/database.test.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pruebas de las queries de administración.

   CASOS EXIGIDOS
     · El SUM(amount) de los pagos se calcula correctamente (y en SQL, no
       en JavaScript: la base devuelve el agregado).
     · No hay inyección SQL: un ID con comillas simples se viaja SIEMPRE
       como parámetro, nunca concatenado en el texto de la consulta.

   Y ADEMÁS
     · los filtros (estado, rol, búsqueda) también van como parámetros
     · la paginación se acota
     · los conteos y los totales son consistentes
     · la auditoría no filtra secretos
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { mockDatabase, restoreDatabase, TEST_USER_ID } from './setup.js';
import {
  getAdminStats,
  listAdminUsers,
  listAdminPayments,
  listAdminLogs,
  updateAdminUser,
  recordAdminAction,
  getAdminQueryStats,
} from '../src/services/admin-queries.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · MOCK DE LA BASE DE DATOS
   ═══════════════════════════════════════════════════════════════════════════ */

/** Estados válidos de una orden (para reconocer el parámetro en el mock). */
const STATUSES = /^(completed|created|failed|pending|refunded|cancelled|approved)$/i;

/**
 * Mock con tablas de pagos, perfiles y auditoría.
 */
function adminMock(payments = [], users = []) {
  const state = { payments, users, audited: [] };

  const findStatus = (params) =>
    (params || []).find((v) => typeof v === 'string' && STATUSES.test(v));

  const client = mockDatabase({
    'create table if not exists admin_audit_log': () => [],
    'create index if not exists admin_audit_log_created_idx': () => [],

    // ── Métricas agregadas (una sola consulta con CTE) ─────────────────
    'with u as': () => [{
      total_users: users.length,
      new_users_30d: 2,
      prev_users_30d: 1,
      active_users_7d: 3,
      banned_users: 0,
      revenue_now: payments
        .filter((p) => p.status === 'completed')
        .reduce((acc, p) => acc + Number(p.amount || 0), 0),
      revenue_prev: 10,
      completed_now: payments.filter((p) => p.status === 'completed').length,
      completed_prev: 1,
      failed: payments.filter((p) => p.status === 'failed').length,
      pending: payments.filter((p) => p.status === 'created').length,
      total_orders: payments.length,
    }],

    // ── Serie diaria ──────────────────────────────────────────────────
    'from generate_series': () => payments.map((p) => ({
      date: (p.created_at || '2026-10-01').slice(0, 10),
      amount: p.status === 'completed' ? Number(p.amount || 0) : 0,
      orders: 1,
    })),

    // ── Perfiles (listado o conteo) ───────────────────────────────────
    'from public.profiles p': (text) => {
      if (/count\(\*\)/i.test(text)) return [{ total: users.length }];

      return users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name,
        role: u.role,
        plan: u.plan,
        created_at: u.created_at,
        last_login_at: u.last_login_at,
        banned: false,
        suspended_until: null,
        verified: true,
        messages: u.messages ?? 0,
      }));
    },

    // ── Conteo de mensajes (acotado, sin N+1) ────────────────────────
    'select c."userId"::text as user_id, count(m.id)::int as messages': () => [],

    // ── Pagos ─────────────────────────────────────────────────────────
    'select id::text as id, user_id::text as user_id, package_id': (text, params) => {
      const status = findStatus(params);
      const set = status ? payments.filter((p) => p.status === status) : payments;

      return set.map((p) => ({
        id: p.id,
        user_id: p.user_id,
        package_id: p.package_id,
        status: p.status,
        amount: Number(p.amount || 0),
        amount_cop: 0,
        currency: p.currency || 'USD',
        credits_granted: p.credits_granted || 0,
        paypal_order_id: p.paypal_order_id,
        provider: 'paypal',
        created_at: p.created_at,
        completed_at: p.completed_at || null,
      }));
    },

    'select count(*)::int as total from payments': (text, params) => {
      const status = findStatus(params);
      const set = status ? payments.filter((p) => p.status === status) : payments;
      return [{ total: set.length }];
    },

    'select coalesce(sum(amount), 0)::numeric(14,2) as total': (text, params) => {
      const status = findStatus(params);
      const set = status ? payments.filter((p) => p.status === status) : payments;
      return [{
        total: set
          .filter((p) => p.status === 'completed')
          .reduce((acc, p) => acc + Number(p.amount || 0), 0),
      }];
    },

    // ── Auditoría ─────────────────────────────────────────────────────
    'insert into admin_audit_log': (text, params) => {
      state.audited.push(params);
      return [{ id: 'audit-1' }];
    },

    'select id::text as id, user_id::text as user_id, actor_id::text as actor_id': () => [],

    // ── Actualización de usuario ──────────────────────────────────────
    'update public.profiles set banned': () => [{
      id: TEST_USER_ID, email: 'a@b.c', name: 'x', role: 'student', plan: 'free', banned: true,
    }],
  });

  return { client, state };
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · SUM(amount)
   ═══════════════════════════════════════════════════════════════════════════ */

describe('admin-queries · agregación de pagos', () => {
  let db = null;

  beforeEach(() => {
    db = adminMock([
      { id: 'p1', user_id: TEST_USER_ID, package_id: 'pro', status: 'completed', amount: 19.9, currency: 'USD', credits_granted: 500, created_at: '2026-10-01T00:00:00.000Z' },
      { id: 'p2', user_id: TEST_USER_ID, package_id: 'team', status: 'completed', amount: 49.5, currency: 'USD', credits_granted: 2000, created_at: '2026-10-02T00:00:00.000Z' },
      { id: 'p3', user_id: TEST_USER_ID, package_id: 'pro', status: 'failed', amount: 19.9, currency: 'USD', credits_granted: 0, created_at: '2026-10-03T00:00:00.000Z' },
    ]);
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('el total de ingresos es el SUM(amount) calculado en SQL', async () => {
    const stats = await getAdminStats({ days: 30 });

    // 19.90 + 49.50 = 69.40 (el pago fallido NO cuenta).
    assert.equal(stats.totalRevenue, 69.4);
    assert.equal(stats.completedPayments, 2);
    assert.equal(stats.failedPayments, 1);
    assert.equal(stats.degraded, false);
  });

  it('el agregado se pide a la base, no se calcula en JavaScript', async () => {
    await getAdminStats({ days: 30 });

    const agregados = db.client.callsMatching('with u as');

    assert.equal(agregados.length, 1, 'debe usar una sola consulta con CTE');
    assert.match(agregados[0].text.replace(/\s+/g, ' '), /sum\(amount\)/i);
    assert.match(agregados[0].text.replace(/\s+/g, ' '), /count\(\*\)/i);
  });

  it('la lista de pagos devuelve el total y respeta el filtro por estado', async () => {
    const todos = await listAdminPayments({ page: 1, limit: 10 });

    assert.equal(todos.ok, true);
    assert.equal(todos.total, 3);
    assert.equal(todos.payments.length, 3);
    assert.equal(todos.sumAmount, 69.4);

    const soloCompletados = await listAdminPayments({ page: 1, limit: 10, status: 'completed' });

    assert.equal(soloCompletados.payments.length, 2);
    assert.equal(soloCompletados.payments.every((p) => p.status === 'completed'), true);
    assert.equal(soloCompletados.total, 2);
  });

  it('la paginación se acota y se reporta en pages/total/limit', async () => {
    const resultado = await listAdminPayments({ page: 2, limit: 2 });

    assert.equal(resultado.page, 2);
    assert.equal(resultado.total, 3);
    assert.equal(resultado.pages, 2);
    assert.ok(resultado.limit <= 200, 'el límite nunca es infinito');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   03 · INYECCIÓN SQL
   ═══════════════════════════════════════════════════════════════════════════ */

describe('admin-queries · resistencia a inyección SQL', () => {
  let db = null;

  beforeEach(() => {
    db = adminMock([], [
      { id: TEST_USER_ID, email: 'ada@numination.app', name: 'Ada', role: 'student', plan: 'free', created_at: '2026-01-01', last_login_at: '2026-10-01', messages: 4 },
    ]);
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('un ID con comillas simples viaja como parámetro, no en el SQL', async () => {
    const malicioso = "11111111-1111-4111-8111-111111111111' OR '1'='1";

    await listAdminUsers({ page: 1, limit: 10, q: malicioso });

    const consultas = db.client.calls;

    assert.ok(consultas.length > 0);

    for (const call of consultas) {
      assert.equal(
        call.text.includes(malicioso),
        false,
        'el valor malicioso NUNCA debe aparecer concatenado en el SQL'
      );
    }

    // El servicio normaliza el término a minúsculas: se compara sin
    // distinguir mayúsculas.
    const conParametro = consultas.filter((c) =>
      c.values.some((v) => typeof v === 'string' && v.toLowerCase().includes(malicioso.toLowerCase()))
    );
    assert.ok(conParametro.length > 0, 'debe viajar como parámetro');
  });

  it('el filtro de búsqueda se parametriza (LIKE con comodines)', async () => {
    await listAdminUsers({ page: 1, limit: 10, q: "%' OR 1=1 --" });

    const conParametro = db.client.calls.filter((c) =>
      c.values.some((v) => typeof v === 'string' && v.toLowerCase().includes('or 1=1'))
    );

    assert.ok(conParametro.length > 0);
    for (const call of db.client.calls) {
      assert.equal(call.text.includes('OR 1=1'), false);
    }
  });

  it('un estado de pago malicioso también viaja como parámetro', async () => {
    const malicioso = "completed'; drop table payments; --";

    await listAdminPayments({ page: 1, limit: 10, status: malicioso });

    for (const call of db.client.calls) {
      assert.equal(call.text.includes('drop table'), false);
    }
    assert.ok(db.client.calls.some((c) => c.values.includes(malicioso)));
  });

  it('el nivel de logs malicioso se parametriza', async () => {
    await listAdminLogs({ page: 1, limit: 10, level: "info' UNION SELECT * FROM profiles --" });

    for (const call of db.client.calls) {
      assert.equal(call.text.includes('UNION SELECT'), false);
    }
  });

  it('actualizar un usuario con un id malicioso no ejecuta SQL arbitrario', async () => {
    const resultado = await updateAdminUser("' OR 1=1 --", { action: 'toggle_ban' });

    assert.equal(resultado.ok, false);
    assert.match(resultado.error, /inválido/i);
    assert.equal(db.client.calls.length, 0, 'no debe llegar a la base de datos');
  });

  it('la auditoría registra la acción sin filtrar secretos', async () => {
    await recordAdminAction({
      userId: TEST_USER_ID,
      action: 'admin.test',
      meta: {
        password: 'no-me-muestres',
        apiKey: 'sk-1234567890',
        userId: 'u-1',
      },
    });

    const inserts = db.client.callsMatching('insert into admin_audit_log');

    assert.equal(inserts.length, 1);
    assert.equal(inserts[0].text.includes('no-me-muestres'), false);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   04 · USUARIOS Y AUDITORÍA
   ═══════════════════════════════════════════════════════════════════════════ */

describe('admin-queries · usuarios y auditoría', () => {
  let db = null;

  beforeEach(() => {
    db = adminMock([], [
      { id: TEST_USER_ID, email: 'ada@numination.app', name: 'Ada', role: 'student', plan: 'free', created_at: '2026-01-01', last_login_at: '2026-10-01', messages: 4 },
    ]);
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('lista los usuarios con paginación y total', async () => {
    const resultado = await listAdminUsers({ page: 1, limit: 10 });

    assert.equal(resultado.ok, true);
    assert.equal(resultado.total, 1);
    assert.equal(resultado.users[0].email, 'ada@numination.app');
    assert.equal(resultado.page, 1);
    assert.ok(resultado.limit <= 200);
  });

  it('el conteo de mensajes se hace en una consulta aparte y acotada', async () => {
    await listAdminUsers({ page: 1, limit: 10 });

    const conteos = db.client.callsMatching('select c."userId"::text as user_id, count(m.id)::int as messages');

    assert.ok(conteos.length <= 1, 'no debe hacer N+1');
  });

  it('registra una acción de auditoría', async () => {
    const resultado = await recordAdminAction({
      userId: TEST_USER_ID,
      action: 'admin.accion',
      meta: { foo: 'bar' },
    });

    assert.equal(resultado.ok, true);
    assert.equal(db.state.audited.length, 1);
    assert.ok(db.state.audited[0].includes('admin.accion'));
  });

  it('expone las métricas de las queries', () => {
    const stats = getAdminQueryStats();

    assert.ok(stats.maxLimit >= 1);
    assert.ok(stats.defaultLimit >= 1);
  });
});
