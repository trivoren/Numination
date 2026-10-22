/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/ai-orchestrator.test.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pruebas de la cascada de fallback entre proveedores de IA.

   CASO EXIGIDO
     · Si Groq devuelve 429, el orquestador cae automáticamente a Gemini.

   Y ADEMÁS
     · Si Groq funciona, no se llama a Gemini (no se gasta doble).
     · Un 401 en Groq no reintenta con otro modelo (la clave está mal).
     · Si ambos fallan, devuelve null y el caller usa su fallback local.
     · Los intentos quedan registrados para la observabilidad.
     · NINGUNA llamada real: el fetch está mockeado en el borde HTTP.
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { withMockedFetch, jsonResponse } from './setup.js';
import {
  callLLM,
  callLLMOrFallback,
  getOrchestratorStatus,
} from '../src/services/ai-orchestrator.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Fetch simulado: Groq responde con el estado indicado, Gemini con otro.
 * @param {object} [opts] { groqStatus, geminiStatus }
 */
function mockProviders({ groqStatus = 429, geminiStatus = 200 } = {}) {
  const calls = [];

  const restore = withMockedFetch({
    'api.groq.com': (url, init) => {
      calls.push({ provider: 'groq', url, init });
      if (groqStatus === 200) {
        return jsonResponse({ choices: [{ message: { content: 'respuesta de Groq' } }] });
      }
      return jsonResponse({ error: { message: 'rate limit' } }, groqStatus);
    },
    'generativelanguage.googleapis.com': (url, init) => {
      calls.push({ provider: 'gemini', url, init });
      if (geminiStatus === 200) {
        return jsonResponse({
          candidates: [{ content: { parts: [{ text: 'respuesta de Gemini' }] } }],
        });
      }
      return jsonResponse({ error: { message: 'error simulado' } }, geminiStatus);
    },
  });

  return { restore, calls };
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · EL FALLBACK
   ═══════════════════════════════════════════════════════════════════════════ */

describe('ai-orchestrator · cascada de fallback', () => {
  it('si Groq devuelve 429, cae automáticamente a Gemini', async () => {
    const { restore, calls } = mockProviders({ groqStatus: 429 });

    try {
      const result = await callLLM({
        system: 'Sos un asistente.',
        user: 'Hola',
        providers: ['groq', 'gemini'],
        fetchImpl: globalThis.fetch,
      });

      assert.ok(result, 'debe devolver una respuesta');
      assert.equal(result.provider, 'gemini');
      assert.equal(result.text, 'respuesta de Gemini');

      assert.ok(calls.some((c) => c.provider === 'groq'), 'debe intentar Groq primero');
      assert.ok(calls.some((c) => c.provider === 'gemini'), 'debe caer a Gemini');

      const groqAttempt = result.attempts.find((a) => a.provider === 'groq');
      assert.equal(groqAttempt.ok, false);
      assert.equal(groqAttempt.status, 429);
    } finally {
      restore();
    }
  });

  it('si Groq funciona, NO llama a Gemini', async () => {
    const { restore, calls } = mockProviders({ groqStatus: 200 });

    try {
      const result = await callLLM({
        system: 'Sos un asistente.',
        user: 'Hola',
        providers: ['groq', 'gemini'],
        fetchImpl: globalThis.fetch,
      });

      assert.equal(result.provider, 'groq');
      assert.equal(result.text, 'respuesta de Groq');
      assert.equal(calls.filter((c) => c.provider === 'gemini').length, 0, 'no debe gastar Gemini');
    } finally {
      restore();
    }
  });

  it('si Groq da 500, también cae a Gemini', async () => {
    const { restore } = mockProviders({ groqStatus: 500 });

    try {
      const result = await callLLM({
        system: 'x', user: 'y',
        providers: ['groq', 'gemini'],
        fetchImpl: globalThis.fetch,
      });

      assert.equal(result.provider, 'gemini');
    } finally {
      restore();
    }
  });

  it('un 401 en Groq no reintenta con otro modelo de Groq', async () => {
    const { restore, calls } = mockProviders({ groqStatus: 401 });

    try {
      const result = await callLLM({
        system: 'x', user: 'y',
        providers: ['groq', 'gemini'],
        fetchImpl: globalThis.fetch,
      });

      assert.equal(calls.filter((c) => c.provider === 'groq').length, 1, 'con la clave inválida no se insiste');
      assert.equal(result.provider, 'gemini');
    } finally {
      restore();
    }
  });

  it('si ambos proveedores fallan devuelve null (el caller usa su fallback)', async () => {
    const { restore } = mockProviders({ groqStatus: 500, geminiStatus: 503 });

    try {
      const result = await callLLM({
        system: 'x', user: 'y',
        providers: ['groq', 'gemini'],
        fetchImpl: globalThis.fetch,
      });

      assert.equal(result, null);
    } finally {
      restore();
    }
  });

  it('callLLMOrFallback devuelve el texto local si nadie responde', async () => {
    const { restore } = mockProviders({ groqStatus: 500, geminiStatus: 503 });

    try {
      const result = await callLLMOrFallback({
        system: 'x', user: 'y',
        providers: ['groq', 'gemini'],
        fetchImpl: globalThis.fetch,
        fallback: () => 'texto local de emergencia',
      });

      assert.equal(result.text, 'texto local de emergencia');
      assert.equal(result.provider, 'fallback');
      assert.equal(result.degraded, true);
    } finally {
      restore();
    }
  });

  it('lanza el error si se pide throwOnFail', async () => {
    const { restore } = mockProviders({ groqStatus: 500, geminiStatus: 503 });

    try {
      await assert.rejects(
        () => callLLM({
          system: 'x', user: 'y',
          providers: ['groq', 'gemini'],
          fetchImpl: globalThis.fetch,
          throwOnFail: true,
        }),
        (err) => {
          assert.equal(err.code, 'AI_ALL_ENGINES_FAILED');
          assert.ok(Array.isArray(err.attempts));
          return true;
        }
      );
    } finally {
      restore();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   03 · CONTRATO DE LA PETICIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

describe('ai-orchestrator · contrato', () => {
  it('envía el system prompt y el user prompt al proveedor', async () => {
    const { restore, calls } = mockProviders({ groqStatus: 200 });

    try {
      await callLLM({
        system: 'Sos un senior engineer.',
        user: 'Explicame este código',
        providers: ['groq'],
        fetchImpl: globalThis.fetch,
      });

      const body = JSON.parse(calls[0].init.body);

      assert.equal(body.messages[0].role, 'system');
      assert.equal(body.messages[0].content, 'Sos un senior engineer.');
      assert.equal(body.messages[1].role, 'user');
      assert.equal(body.messages[1].content, 'Explicame este código');
    } finally {
      restore();
    }
  });

  it('rechaza un fetch que no sea función', async () => {
    await assert.rejects(
      () => callLLM({ system: 'x', user: 'y', fetchImpl: 'no soy una función' }),
      /fetch implementable/
    );
  });

  it('expone el estado de los proveedores configurados', () => {
    const status = getOrchestratorStatus();

    assert.ok(status.providers);
    assert.ok('groq' in status.providers);
    assert.ok('gemini' in status.providers);
    assert.ok(Array.isArray(status.groqModels));
    assert.ok(status.timeoutMs > 0);
  });

  it('usa el orden de proveedores que se le pase', async () => {
    const { restore, calls } = mockProviders({ groqStatus: 200 });

    try {
      await callLLM({
        system: 'x', user: 'y',
        providers: ['gemini', 'groq'],
        fetchImpl: globalThis.fetch,
      });

      assert.equal(calls[0].provider, 'gemini', 'respeta el orden pedido');
    } finally {
      restore();
    }
  });
});
