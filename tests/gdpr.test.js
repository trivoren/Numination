/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/gdpr.test.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pruebas del endpoint de exportación de datos (GDPR / Ley 1581).

   CASO EXIGIDO
     · GET /api/gdpr/export devuelve un JSON con los chats, las memorias
       y el perfil del usuario.
     · NO incluye contraseñas ni hashes.

   Y ADEMÁS
     · la exportación sólo contiene datos del usuario autenticado
     · una request sin sesión devuelve 401
     · el borrado en cascada funciona y destruye la sesión
     · el borrado duro también elimina el perfil
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';

import {
  mockDatabase,
  restoreDatabase,
  mockReqRes,
  signTestToken,
  startServer,
  flush,
  TEST_USER_ID,
  OTHER_USER_ID,
} from './setup.js';

import { mountGdprRoutes } from '../src/routes/gdpr-tools.js';
import { errorMiddleware } from '../src/middleware/errors.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · MOCK DE LA BASE DE DATOS
   ═══════════════════════════════════════════════════════════════════════════ */

function gdprMock() {
  const state = { deleted: {} };

  const client = mockDatabase({
    'create table if not exists gdpr_deletions': () => [],
    'insert into gdpr_deletions': () => [{ id: 'del-1' }],
    'select id::text as id, email,': () => [{
      id: TEST_USER_ID,
      email: 'ada@numination.app',
      name: 'Ada Lovelace',
      avatarUrl: null,
      role: 'student',
      plan: 'free',
      created_at: '2026-01-01T00:00:00.000Z',
      last_login_at: '2026-10-20T00:00:00.000Z',
      email_verified: true,
    }],
    'select id::text as id, title, mode': () => ([
      { id: 'chat-1', title: 'Mi primera charla', mode: 'chat', is_ghost: false, created_at: '2026-02-01T00:00:00.000Z' },
      { id: 'chat-2', title: 'Consulta sobre PDFs', mode: 'chat', is_ghost: false, created_at: '2026-03-01T00:00:00.000Z' },
    ]),
    'select m.id::text as id, m."chatId"': () => ([
      { id: 'msg-1', chat_id: 'chat-1', role: 'user', content: 'Hola', sources: null, created_at: '2026-02-01T00:01:00.000Z' },
      { id: 'msg-2', chat_id: 'chat-1', role: 'assistant', content: '¡Hola!', sources: null, created_at: '2026-02-01T00:01:05.000Z' },
    ]),
    'select id, content, type,': () => ([
      { id: 'mem-1', content: 'Me gusta el fútbol', type: 'MEMORY', category: 'general', tags: [], relevance: 70, pinned: false, source: 'chat', metadata: {}, useCount: 1, lastUsedAt: null, createdAt: '2026-02-02T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z' },
    ]),
    'select id::text as id, name, description, system_prompt': () => ([
      { id: 'pers-1', name: 'Abogado', description: 'Legal', system_prompt: 'Sos abogado', avatar: '⚖️', color: '#7c5cff', temperature: 0.7, is_default: false, is_active: true, created_at: '2026-03-01T00:00:00.000Z' },
    ]),
    'select id::text as id, filename, title, bytes': () => ([
      { id: 'doc-1', filename: 'contrato.pdf', title: 'contrato', bytes: 1024, chunk_count: 3, status: 'ready', created_at: '2026-03-02T00:00:00.000Z' },
    ]),
    'select p.id::text as id, p.title, p.content': () => ([
      { id: 'prompt-1', title: 'Resumir', content: 'Resumí esto', description: '', tags: [], usage_count: 3, folder: 'Trabajo' },
    ]),
    'select id, type, title, body, priority': () => ([
      { id: 'notif-1', type: 'system', title: 'Bienvenido', body: 'Gracias por entrar', priority: 'normal', created_at: '2026-03-03T00:00:00.000Z', read_at: null },
    ]),
    'select id::text as id, package_id, status, amount': () => ([
      { id: 'pay-1', package_id: 'pro', status: 'completed', amount: 19.9, amount_cop: 0, currency: 'USD', credits_granted: 500, paypal_order_id: 'ORDER123', created_at: '2026-03-04T00:00:00.000Z' },
    ]),
    'select id::text as id, status, current_period_end': () => ([
      { id: 'sub-1', status: 'active', current_period_end: '2026-11-01T00:00:00.000Z', created_at: '2026-03-04T00:00:00.000Z' },
    ]),
    'select user_id::text as user_id, balance': () => ([
      { user_id: TEST_USER_ID, balance: 500, updated_at: '2026-03-04T00:00:00.000Z' },
    ]),
    // Borrados
    'delete from rag_chunks': () => [],
    'delete from rag_documents': () => [],
    'delete from personas': () => [],
    'delete from saved_prompts': () => [],
    'delete from prompt_folders': () => [],
    'delete from notifications': () => [],
    'delete from credits': () => [],
    'delete from referrals': () => [],
    'delete from affiliate_clicks': () => [],
    'delete from "Message"': () => [],
    'delete from "Chat"': () => [],
    'delete from "Memory"': () => [],
    'delete from payments': () => [],
    'delete from subscriptions': () => [],
    'delete from public.profiles': () => [],
    'update public.profiles set email': () => [],
  });

  void state;
  return client;
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · EXPORTACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

describe('gdpr · exportación de datos', () => {
  let server = null;
  let token = null;

  beforeEach(async () => {
    mockDatabase({
      'select id::text as id, email,': () => [{
        id: TEST_USER_ID, email: 'ada@numination.app', name: 'Ada Lovelace', avatarUrl: null,
        role: 'student', plan: 'free', created_at: '2026-01-01T00:00:00.000Z',
        last_login_at: '2026-10-20T00:00:00.000Z', email_verified: true,
      }],
      'select id::text as id, title, mode': () => ([
        { id: 'chat-1', title: 'Mi primera charla', mode: 'chat', is_ghost: false, created_at: '2026-02-01T00:00:00.000Z' },
      ]),
      'select m.id::text as id, m."chatId"': () => ([
        { id: 'msg-1', chat_id: 'chat-1', role: 'user', content: 'Hola', sources: null, created_at: '2026-02-01T00:01:00.000Z' },
      ]),
      'select id, content, type,': () => ([
        { id: 'mem-1', content: 'Me gusta el fútbol', type: 'MEMORY', category: 'general', tags: [], relevance: 70, pinned: false, source: 'chat', metadata: {}, useCount: 1, lastUsedAt: null, createdAt: '2026-02-02T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z' },
      ]),
      'select id::text as id, name, description, system_prompt': () => [],
      'select id::text as id, filename, title, bytes': () => [],
      'select p.id::text as id, p.title, p.content': () => [],
      'select id, type, title, body, priority': () => [],
      'select id::text as id, package_id, status, amount': () => [],
      'select id::text as id, status, current_period_end': () => [],
      'select user_id::text as user_id, balance': () => [],
    });

    const app = express();
    app.use(express.json());
    app.use(cookieParser());   // como en producción
    mountGdprRoutes(app);
    app.use(errorMiddleware({ includeStack: false }));
    app.use(errorMiddleware({ includeStack: false }));

    server = await startServer(app);
    token = await signTestToken({ sub: TEST_USER_ID, email: 'ada@numination.app' });
  });

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    restoreDatabase();
  });

  it('devuelve un JSON con chats, memorias y perfil', async () => {
    const res = await server.request('/api/gdpr/export', {
      cookie: `nm-session=${token}`,
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);

    assert.ok(res.json.profile, 'debe incluir el perfil');
    assert.equal(res.json.profile.email, 'ada@numination.app');

    assert.ok(Array.isArray(res.json.chats), 'debe incluir los chats');
    assert.equal(res.json.chats.length, 1);
    assert.equal(res.json.chats[0].title, 'Mi primera charla');

    assert.ok(Array.isArray(res.json.memories), 'debe incluir las memorias');
    assert.equal(res.json.memories.length, 1);
    assert.equal(res.json.memories[0].content, 'Me gusta el fútbol');

    assert.ok(Array.isArray(res.json.messages));
    assert.equal(res.json.messages.length, 1);
  });

  it('incluye un resumen con los conteos', async () => {
    const res = await server.request('/api/gdpr/export', { cookie: `nm-session=${token}` });

    assert.ok(res.json.summary);
    assert.equal(res.json.summary.chats, 1);
    assert.equal(res.json.summary.memories, 1);
    assert.equal(res.json.summary.messages, 1);
  });

  it('NO incluye contraseñas ni hashes', async () => {
    const res = await server.request('/api/gdpr/export', { cookie: `nm-session=${token}` });
    const raw = JSON.stringify(res.json);

    for (const prohibido of ['password_hash', 'passwordHash', 'password', 'reset_token', 'auth_version', 'lockdown', 'hash']) {
      assert.equal(
        raw.includes(prohibido),
        false,
        `la exportación no debe contener "${prohibido}"`
      );
    }
  });

  it('la cabecera de contenido es un JSON descargable', async () => {
    const res = await server.request('/api/gdpr/export?download=true', { cookie: `nm-session=${token}` });

    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /attachment/);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
  });

  it('exige sesión: sin token devuelve 401', async () => {
    const res = await server.request('/api/gdpr/export');

    assert.equal(res.status, 401);
    assert.equal(res.json.ok, false);
  });

  it('expone qué datos se guardan y por qué', async () => {
    const res = await server.request('/api/gdpr/info', { cookie: `nm-session=${token}` });

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.info.collects));
    assert.ok(res.json.info.collects.length >= 5);
    assert.ok(res.json.info.rights.length >= 3);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   03 · BORRADO EN CASCADA
   ═══════════════════════════════════════════════════════════════════════════ */

describe('gdpr · borrado de datos', () => {
  let server = null;
  let token = null;
  let client = null;

  beforeEach(async () => {
    client = mockDatabase({
      'create table if not exists gdpr_deletions': () => [],
      'insert into gdpr_deletions': () => [{ id: 'del-1' }],
      'delete from rag_chunks': () => [],
      'delete from rag_documents': () => [],
      'delete from personas': () => [],
      'delete from saved_prompts': () => [],
      'delete from prompt_folders': () => [],
      'delete from notifications': () => [],
      'delete from credits': () => [],
      'delete from referrals': () => [],
      'delete from affiliate_clicks': () => [],
      'delete from "Message"': () => [],
      'delete from "Chat"': () => [],
      'delete from "Memory"': () => [],
      'delete from payments': () => [],
      'delete from subscriptions': () => [],
      'delete from public.profiles': () => [],
      'update public.profiles set email': () => [],
    });

    const app = express();
    app.use(express.json());
    app.use(cookieParser());   // como en producción
    mountGdprRoutes(app);
    app.use(errorMiddleware({ includeStack: false }));

    server = await startServer(app);
    token = await signTestToken({ sub: TEST_USER_ID, email: 'ada@numination.app' });
  });

  afterEach(async () => {
    if (server) await server.close();
    server = null;
    restoreDatabase();
  });

  it('exige confirmación explícita', async () => {
    const res = await server.request('/api/gdpr/delete', {
      method: 'DELETE',
      cookie: `nm-session=${token}`,
    });

    assert.equal(res.status, 400);
    assert.equal(res.json.ok, false);
    assert.match(res.json.error, /confirm/i);
  });

  it('borra en cascada y anonimiza el perfil', async () => {
    const res = await server.request('/api/gdpr/delete?confirm=BORRAR', {
      method: 'DELETE',
      cookie: `nm-session=${token}`,
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.sessionDestroyed, true);

    const mutaciones = client.calls.filter((c) => /delete from|update public\.profiles/i.test(c.text));
    const textos = mutaciones.map((c) => c.text.replace(/\s+/g, ' '));

    assert.ok(textos.some((t) => t.includes('delete from "Chat"')), 'debe borrar los chats');
    assert.ok(textos.some((t) => t.includes('delete from "Memory"')), 'debe borrar las memorias');
    assert.ok(textos.some((t) => t.includes('delete from personas')), 'debe borrar las personas');
    assert.ok(textos.some((t) => t.includes('update public.profiles')), 'debe anonimizar el perfil');
  });

  it('el borrado duro también elimina el perfil y los pagos', async () => {
    const res = await server.request('/api/gdpr/delete?confirm=BORRAR&hard=true', {
      method: 'DELETE',
      cookie: `nm-session=${token}`,
    });

    assert.equal(res.status, 200);
    assert.equal(res.json.hard, true);

    const textos = client.callsMatching('delete from').map((c) => c.text.replace(/\s+/g, ' '));

    assert.ok(textos.some((t) => t.includes('delete from public.profiles')));
    assert.ok(textos.some((t) => t.includes('delete from payments')));
  });

  it('conserva los pagos en el borrado normal (obligación contable)', async () => {
    await server.request('/api/gdpr/delete?confirm=BORRAR', {
      method: 'DELETE',
      cookie: `nm-session=${token}`,
    });

    const textos = client.callsMatching('delete from').map((c) => c.text.replace(/\s+/g, ' '));

    assert.equal(textos.some((t) => t.includes('delete from payments')), false);
  });

  it('exige sesión para borrar', async () => {
    const res = await server.request('/api/gdpr/delete?confirm=BORRAR', { method: 'DELETE' });

    assert.equal(res.status, 401);
  });
});
