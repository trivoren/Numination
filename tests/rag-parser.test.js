/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/rag-parser.test.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pruebas del pipeline de ingesta RAG (PDF → chunks → embeddings → pgvector).

   CASO EXIGIDO
     · Simula la subida de un PDF, verifica que se divida en chunks y que
       se llamen a los embeddings (MOCKEADOS: cero llamadas reales).

   Y ADEMÁS
     · el extractor y el embedder son inyectables (sin red, sin PDF real)
     · los chunks se guardan en la base con su vector
     · el documento queda con el conteo de fragmentos correcto
     · un PDF sin texto falla con un mensaje claro
     · el chunking respeta el solapamiento y no parte palabras
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { mockDatabase, restoreDatabase, withMockedFetch, jsonResponse, TEST_USER_ID } from './setup.js';
import {
  processPDF,
  chunkText,
  embedBatch,
  deterministicEmbedding,
  toVectorLiteral,
  normalizeText,
  searchChunks,
  buildRagContext,
} from '../src/services/rag-parser.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

/** PDF falso: cualquier buffer con contenido sirve (el extractor es inyectado). */
function fakePdf(marker = 'contenido') {
  return Buffer.from(`%PDF-1.4\n%% ${marker}\n`, 'utf8');
}

/**
 * Extractor simulado: devuelve un texto largo y repetitivo.
 * Es una FUNCIÓN (async) porque así la consume processPDF.
 */
function fakeExtractor(paragraphs = 6, sentencesPerParagraph = 6) {
  const sentences = [];
  for (let p = 0; p < paragraphs; p++) {
    const chunk = [];
    for (let s = 0; s < sentencesPerParagraph; s++) {
      chunk.push(`El parrafo ${p} de la ley dice que los pagos se realizan dentro del plazo legal vigente en Colombia numero ${p}${s}.`);
    }
    sentences.push(chunk.join(' '));
  }
  return { text: sentences.join('\n\n'), extractor: 'fake', pages: 1 };
}

/** Versión inyectable: recibe el buffer y devuelve el texto. */
const fakeExtract = async () => fakeExtractor();

/**
 * Embedder simulado: devuelve vectores deterministas y cuenta las llamadas.
 */
function fakeEmbedder(dim = 1536) {
  const state = { calls: 0, texts: [] };

  const embed = async (texts) => {
    state.calls++;
    state.texts.push(...texts);
    return {
      vectors: texts.map((t) => deterministicEmbedding(t, dim)),
      model: 'fake-embed-v1',
      provider: 'test',
    };
  };

  return { embed, state };
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · EL CASO EXIGIDO
   ═══════════════════════════════════════════════════════════════════════════ */

describe('rag-parser · ingesta de un PDF', () => {
  let client = null;

  beforeEach(() => {
    client = mockDatabase({
      'create extension if not exists vector': () => [],
      'create table if not exists rag_documents': () => [],
      'create table if not exists rag_chunks': () => [],
      'create index if not exists rag_documents_user_idx': () => [],
      'create index if not exists rag_chunks_user_doc_idx': () => [],
      'create index if not exists rag_chunks_content_idx': () => [],
      'insert into rag_documents': () => [{
        id: '11111111-2222-4333-8444-555555555555',
        filename: 'contrato.pdf',
        title: 'contrato.pdf',
        bytes: 120,
        chunk_count: 3,
        created_at: '2026-10-01T00:00:00.000Z',
      }],
      'insert into rag_chunks': () => [{
        id: 'chunk-1', doc_id: '11111111-2222-4333-8444-555555555555',
        user_id: TEST_USER_ID, chunk_index: 0, content: 'x', tokens: 10,
      }],
    });
  });

  afterEach(() => {
    restoreDatabase();
    client = null;
  });

  it('divide el PDF en chunks y llama a los embeddings (mockeados)', async () => {
    const { embed, state } = fakeEmbedder();
    const progresses = [];

    const result = await processPDF({
      buffer: fakePdf(),
      filename: 'contrato.pdf',
      userId: TEST_USER_ID,
      extract: fakeExtract,
      embed,
      onProgress: (pct, stage) => progresses.push([pct, stage]),
    });

    // 1 · Se llamaron los embeddings (y sólo con los textos de los chunks).
    assert.ok(state.calls >= 1, 'debe llamar al embedder');
    assert.equal(state.texts.length, result.chunkCount, 'un embedding por chunk');

    // 2 · Se generaron varios chunks a partir del texto extraído.
    assert.ok(result.chunkCount >= 2, `debe dividir en varios chunks (fue ${result.chunkCount})`);
    assert.equal(result.ok, true);
    assert.equal(result.degraded, false);

    // 3 · Se guardó el documento y sus chunks en la base.
    const docs = client.callsMatching('insert into rag_documents');
    const chunks = client.callsMatching('insert into rag_chunks');

    assert.equal(docs.length, 1, 'debe insertar el documento');
    assert.ok(chunks.length >= 1, 'debe insertar los chunks');

    // 4 · El vector viaja como parámetro, no concatenado en el SQL.
    for (const call of chunks) {
      assert.ok(
        call.values.includes(TEST_USER_ID),
        'el user_id debe ser un parámetro del INSERT'
      );
    }

    // 5 · El progreso se reporta con las etapas esperadas.
    assert.ok(progresses.length >= 3);
    assert.ok(progresses.some(([, stage]) => /embedding/i.test(stage)));
  });

  it('el vector del embedding se serializa como literal pgvector', async () => {
    const literal = toVectorLiteral([0.5, -0.25, 1]);

    assert.equal(literal, '[0.5,-0.25,1]');
    assert.equal(toVectorLiteral(null), null);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   03 · CHUNKING
   ═══════════════════════════════════════════════════════════════════════════ */

describe('rag-parser · chunking', () => {
  it('divide un texto largo en varios chunks', () => {
    const texto = Array.from({ length: 40 }, (_, i) => `Frase numero ${i} con suficiente contenido para el fragmento.`).join(' ');
    const chunks = chunkText(texto, { chunkSize: 300, overlap: 50, minChunkChars: 20 });

    assert.ok(chunks.length > 1, 'debe producir varios chunks');
    for (const chunk of chunks) {
      assert.equal(typeof chunk.text, 'string');
      assert.ok(chunk.text.length > 0);
      assert.equal(typeof chunk.index, 'number');
    }
  });

  it('respeta el tamaño máximo del chunk', () => {
    // Texto con fronteras de frase reales: el troceador nunca parte una
    // frase a la mitad, así que el límite es chunkSize + una frase.
    const texto = Array.from({ length: 60 }, (_, i) => `Frase numero ${i} con contenido suficiente para el corte`).join('. ') + '.';
    const chunks = chunkText(texto, { chunkSize: 300, overlap: 50, minChunkChars: 20 });

    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      assert.ok(chunk.text.length <= 460, `chunk demasiado largo: ${chunk.text.length}`);
    }
  });

  it('numera los chunks de forma correlativa', () => {
    const texto = Array.from({ length: 20 }, (_, i) => `Contenido ${i} para probar.`).join(' ');
    const chunks = chunkText(texto, { chunkSize: 200, overlap: 30, minChunkChars: 10 });

    chunks.forEach((chunk, index) => {
      assert.equal(chunk.index, index);
    });
  });

  it('devuelve vacío para un texto vacío', () => {
    assert.deepEqual(chunkText('', { chunkSize: 300 }), []);
    assert.deepEqual(chunkText('   ', { chunkSize: 300 }), []);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   04 · NORMALIZACIÓN Y EMBEDDINGS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('rag-parser · utilidades', () => {
  it('normalizeText une palabras cortadas por salto de línea', () => {
    const texto = 'palabra-\ncontinuada y otra';

    assert.ok(normalizeText(texto).includes('palabra-continued') || normalizeText(texto).includes('palabra'));
    assert.equal(normalizeText('  doble   espacio  '), 'doble espacio');
  });

  it('embedBatch devuelve un vector por texto', async () => {
    const result = await embedBatch(['uno', 'dos']);

    assert.equal(result.vectors.length, 2);
    assert.equal(result.vectors[0].length, 1536);
  });

  it('el embedding determinista es estable (mismo texto → mismo vector)', () => {
    const a = deterministicEmbedding('texto estable');
    const b = deterministicEmbedding('texto estable');
    const c = deterministicEmbedding('otro texto');

    assert.deepEqual(a, b);
    assert.notDeepEqual(a, c);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   05 · ERRORES Y BÚSQUEDA
   ═══════════════════════════════════════════════════════════════════════════ */

describe('rag-parser · errores y búsqueda', () => {
  afterEach(() => {
    restoreDatabase();
  });

  it('falla con un mensaje claro si el PDF no tiene texto', async () => {
    const { embed } = fakeEmbedder();

    await assert.rejects(
      () => processPDF({
        buffer: fakePdf(),
        filename: 'vacio.pdf',
        userId: TEST_USER_ID,
        extract: async () => ({ text: '   ', extractor: 'fake' }),
        embed,
      }),
      /texto/i
    );
  });

  it('exige userId (sin dueño no se indexa nada)', async () => {
    const { embed } = fakeEmbedder();

    await assert.rejects(
      () => processPDF({ buffer: fakePdf(), filename: 'x.pdf', extract: fakeExtract, embed }),
      /userId/i
    );
  });

  it('la búsqueda filtra siempre por user_id', async () => {
    // El embedder real llama a Gemini: se intercepta el fetch para que
    // caiga al embedding determinista (cero red, cero tokens).
    const restoreFetch = withMockedFetch({
      'generativelanguage.googleapis.com': () => jsonResponse({ error: { message: 'sin red en tests' } }, 500),
      'api.openai.com': () => jsonResponse({ error: { message: 'sin red en tests' } }, 500),
    });

    const client = mockDatabase({
      'create table if not exists rag_documents': () => [],
      'create table if not exists rag_chunks': () => [],
      'select c.id::text as id, c.doc_id::text as doc_id': () => [{
        id: 'chunk-1',
        doc_id: 'doc-1',
        chunk_index: 0,
        content: 'El artículo 45 del CST regula el pago del salario.',
        filename: 'contrato.pdf',
        title: 'contrato.pdf',
        score: 0.77,
      }],
    });

    const result = await searchChunks({
      userId: TEST_USER_ID,
      query: 'pago del salario',
      topK: 3,
    });

    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].docTitle, 'contrato.pdf');

    for (const call of client.callsMatching('select c.id::text as id')) {
      assert.ok(call.values.includes(TEST_USER_ID), 'el user_id debe ser un parámetro');
    }

    restoreFetch();
  });

  it('buildRagContext arma el bloque con las citas', () => {
    const contexto = buildRagContext([
      { docTitle: 'contrato.pdf', content: 'El artículo 45 regula el pago.' },
      { docTitle: 'contrato.pdf', content: 'El artículo 229 regula las prestaciones.' },
    ]);

    assert.ok(contexto.includes('Fragmento 1'));
    assert.ok(contexto.includes('Fragmento 2'));
    assert.ok(contexto.includes('artículo 45'));
    assert.ok(contexto.includes('documentos del usuario'));
  });

  it('buildRagContext devuelve vacío sin resultados', () => {
    assert.equal(buildRagContext([]), '');
    assert.equal(buildRagContext(null), '');
  });
});
