/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/context-injector.test.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pruebas del ensamblador de contexto final.

   CASO EXIGIDO
     · buildFinalContext une correctamente una Persona, 2 chunks de RAG y
       3 mensajes de historial SIN exceder el límite de tokens.

   Y ADEMÁS
     · la Persona va al system prompt
     · el RAG va en un bloque de contexto delimitado
     · el historial conserva el orden y se recorta si no entra
     · las fuentes (sources) se exponen para citarlas
     · el presupuesto se respeta siempre
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { mockDatabase, restoreDatabase, TEST_USER_ID } from './setup.js';
import {
  buildFinalContext,
  injectContext,
  stripContext,
  getContextInjectorConfig,
} from '../src/services/context-injector.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · DATOS DE PRUEBA
   ═══════════════════════════════════════════════════════════════════════════ */

const PERSONA = {
  id: 'pers-1',
  name: 'Abogado',
  description: 'Derecho laboral colombiano',
  systemPrompt: 'Sos un abogado especialista en contratación laboral en Colombia. Cita el CST.',
};

const RAG_CHUNKS = [
  { docId: 'doc-1', docTitle: 'contrato.pdf', index: 0, score: 0.91, content: 'El artículo 45 del CST regula el pago del salario.' },
  { docId: 'doc-1', docTitle: 'contrato.pdf', index: 1, score: 0.83, content: 'El artículo 229 obliga al empleador a pagar prestaciones sociales.' },
];

const HISTORY = [
  { role: 'user', content: 'Necesito revisar un contrato laboral.' },
  { role: 'assistant', content: '¿Querés que busque el artículo 45?' },
  { role: 'user', content: 'Sí, y también las prestaciones.' },
];

/* ═══════════════════════════════════════════════════════════════════════════
   02 · EL CASO EXIGIDO
   ═══════════════════════════════════════════════════════════════════════════ */

describe('context-injector · buildFinalContext', () => {
  it('une Persona, 2 chunks de RAG y 3 mensajes de historial sin exceder el límite', () => {
    const result = buildFinalContext({
      persona: PERSONA,
      ragChunks: RAG_CHUNKS,
      history: HISTORY,
      maxTokens: 2000,
    });

    // 1 · El system prompt contiene la Persona.
    assert.ok(result.systemPrompt.includes('Abogado'));
    assert.ok(result.systemPrompt.includes('CST'));
    assert.ok(result.systemPrompt.includes('Derecho laboral colombiano'));

    // 2 · El contexto RAG está presente y delimitado.
    assert.ok(result.contextBlock.includes('artículo 45'));
    assert.ok(result.contextBlock.includes('artículo 229'));
    assert.ok(result.contextBlock.includes('Fragmento 1'));
    assert.ok(result.contextBlock.includes('Fragmento 2'));

    // 3 · Los 3 mensajes del historial están presentes y en orden.
    const userMessages = result.messages.filter((m) => m.role === 'user' && !m.content.startsWith('Contexto de referencia'));
    assert.equal(userMessages.length, 2);
    assert.ok(userMessages[0].content.includes('revisar un contrato'));
    assert.ok(userMessages[1].content.includes('prestaciones'));

    const assistantMessages = result.messages.filter((m) => m.role === 'assistant');
    assert.equal(assistantMessages.length, 1);
    assert.ok(assistantMessages[0].content.includes('artículo 45'));

    // 4 · El presupuesto se respeta.
    assert.ok(result.tokens <= result.maxTokens, `tokens ${result.tokens} > max ${result.maxTokens}`);
    assert.equal(result.truncated, false);
  });

  it('devuelve el desglose de caracteres por bloque', () => {
    const result = buildFinalContext({
      persona: PERSONA,
      ragChunks: RAG_CHUNKS,
      history: HISTORY,
    });

    assert.ok(result.breakdown.personaChars > 0);
    assert.ok(result.breakdown.ragChars > 0);
    assert.ok(result.breakdown.historyChars > 0);
    assert.equal(result.breakdown.dropped, 0);
  });

  it('expone las fuentes para poder citarlas', () => {
    const result = buildFinalContext({
      persona: PERSONA,
      ragChunks: RAG_CHUNKS,
      history: HISTORY,
    });

    assert.equal(result.sources.length, 2);
    assert.equal(result.sources[0].title, 'contrato.pdf');
    assert.equal(result.sources[0].docId, 'doc-1');
    assert.ok(result.sources[0].score > 0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   03 · RECORTE POR PRESUPUESTO
   ═══════════════════════════════════════════════════════════════════════════ */

describe('context-injector · presupuesto de tokens', () => {
  it('recorta el historial cuando no entra todo', () => {
    const largo = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: `Mensaje muy largo número ${i} con_padding_para_ocupar_espacio_real_.`.repeat(6),
    }));

    const result = buildFinalContext({
      persona: PERSONA,
      ragChunks: RAG_CHUNKS,
      history: largo,
      maxTokens: 300,
    });

    assert.ok(result.tokens <= result.maxTokens, 'nunca excede el presupuesto');
    assert.equal(result.truncated, true, 'debe avisar que recortó');
    assert.ok(result.breakdown.dropped > 0);
  });

  it('un presupuesto enorme deja pasar todo el historial', () => {
    const result = buildFinalContext({
      persona: PERSONA,
      ragChunks: RAG_CHUNKS,
      history: HISTORY,
      maxTokens: 100_000,
    });

    assert.equal(result.truncated, false);
    assert.equal(result.messages.filter((m) => m.role === 'user' && !m.content.startsWith('Contexto')).length, 2);
  });

  it('sin historial ni RAG devuelve sólo el system prompt', () => {
    const result = buildFinalContext({ persona: PERSONA });

    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'system');
    assert.equal(result.contextBlock, '');
    assert.deepEqual(result.sources, []);
  });

  it('funciona sin persona (modo asistente genérico)', () => {
    const result = buildFinalContext({ ragChunks: RAG_CHUNKS, history: HISTORY });

    assert.ok(result.systemPrompt.length > 0);
    assert.equal(result.breakdown.personaChars, 0);
    assert.ok(result.contextBlock.includes('artículo 45'));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   04 · INTEGRACIÓN CON EL RESTO DEL MÓDULO
   ═══════════════════════════════════════════════════════════════════════════ */

describe('context-injector · helpers', () => {
  it('injectContext coloca el system prompt primero y el contexto después', () => {
    const bundle = buildFinalContext({ persona: PERSONA, ragChunks: RAG_CHUNKS, history: HISTORY });

    const messages = injectContext([{ role: 'user', content: '¿Y las vacaciones?' }], bundle);

    assert.equal(messages[0].role, 'system');
    assert.ok(messages[1].content.includes('<contexto>'));
    assert.equal(messages[messages.length - 1].content, '¿Y las vacaciones?');
  });

  it('stripContext quita el bloque de contexto del historial', () => {
    const bundle = buildFinalContext({ persona: PERSONA, ragChunks: RAG_CHUNKS, history: HISTORY });
    const messages = injectContext(HISTORY, bundle);

    const limpio = stripContext(messages);

    assert.equal(limpio.some((m) => m.content.startsWith('Contexto de referencia')), false);
    assert.equal(limpio.length, messages.length - 1);
  });

  it('expone la configuración de presupuestos', () => {
    const config = getContextInjectorConfig();

    assert.ok(config.personaBudget > 0);
    assert.ok(config.memoryBudget > 0);
    assert.ok(config.documentBudget > 0);
    assert.ok(config.totalBudget > 0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   05 · AISLAMIENTO (el contexto NUNCA cruza usuarios)
   ═══════════════════════════════════════════════════════════════════════════ */

describe('context-injector · aislamiento', () => {
  let client = null;

  beforeEach(() => {
    client = mockDatabase({
      'select id::text as id, user_id::text as user_id, name, description, system_prompt': () => [{
        id: 'pers-otro',
        name: 'Contable',
        description: 'Otro usuario',
        system_prompt: 'Sos contador',
        avatar: '🧮',
        color: '#22c55e',
        temperature: 0.5,
        is_default: false,
        is_active: true,
        created_at: '2026-01-01T00:00:00.000Z',
      }],
    });
  });

  afterEach(() => {
    restoreDatabase();
    client = null;
  });

  it('la persona consultada siempre filtra por user_id', async () => {
    const { getActivePersona } = await import('../src/services/persona-queries.js');

    await getActivePersona(TEST_USER_ID);

    const selects = client.callsMatching('select id::text as id, user_id::text as user_id, name');

    assert.ok(selects.length > 0);
    for (const call of selects) {
      assert.ok(
        call.values.includes(TEST_USER_ID),
        'el user_id debe ser un parámetro de la consulta, nunca concatenado'
      );
    }
  });
});
