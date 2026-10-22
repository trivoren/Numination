/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/coder-files.test.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pruebas de aislamiento de datos del explorador de archivos del Coder.

   CASO EXIGIDO
     · El Usuario A NO puede leer los archivos del Usuario B (prevención
       de IDOR). La comprobación vive en el SQL (WHERE user_id = $1), no en
       el código de aplicación: por eso el test verifica AMBAS cosas.

   Y ADEMÁS
     · el upsert no duplica registros (idempotencia por user_id+filename)
     · el nombre de archivo se normaliza y se bloquean rutas peligrosas
     · se rechazan archivos demasiado grandes
     · el handler de carga (load.js) y el de guardado (save.js) respetan
       el aislamiento
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { mockDatabase, restoreDatabase, TEST_USER_ID, OTHER_USER_ID } from './setup.js';
import {
  listFiles,
  getFile,
  upsertFile,
  normalizeFilename,
  languageFromPath,
  ensureTable,
  isUuid,
  MAX_FILE_BYTES,
} from '../api/coder/_store.js';

import loadHandler from '../api/coder/load.js';
import saveHandler from '../api/coder/save.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · MOCK DE LA BASE DE DATOS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Mock del store con una tabla en memoria.
 *
 * `filterByUser` simula el WHERE user_id = $1 de Postgres: si el
 * parámetro no coincide con el dueño de la fila, la fila NO aparece.
 * Es la reproducción fiel del comportamiento real de la base.
 */
function storeMock(files = []) {
  const state = { files: [...files] };

  const client = mockDatabase({
    'create extension if not exists pgcrypto': () => [],
    'create table if not exists public.coder_files': () => [],
    'create index if not exists coder_files': () => [],
    'select filename, language, size_bytes, updated_at': (text, params) => {
      const userId = String(params[0] || '');
      return state.files
        .filter((f) => f.user_id === userId)
        .map((f) => ({
          filename: f.filename,
          language: f.language,
          size_bytes: f.content.length,
          updated_at: f.updated_at,
        }));
    },
    'select filename, content, language, updated_at': (text, params) => {
      const userId = String(params[0] || '');
      const filename = String(params[1] || '');
      const row = state.files.find(
        (f) => f.user_id === userId && f.filename === filename
      );
      return row ? [{
        filename: row.filename,
        content: row.content,
        language: row.language,
        updated_at: row.updated_at,
      }] : [];
    },
    'insert into public.coder_files': (text, params) => {
      const userId = String(params[0] || '');
      const filename = String(params[1] || '');
      const content = String(params[2] ?? '');
      const language = params[3] ?? null;

      const idx = state.files.findIndex(
        (f) => f.user_id === userId && f.filename === filename
      );

      const row = {
        user_id: userId,
        filename,
        content,
        language,
        updated_at: new Date().toISOString(),
      };

      if (idx >= 0) {
        state.files[idx] = { ...state.files[idx], ...row };
      } else {
        state.files.push(row);
      }

      return [{
        filename,
        size_bytes: content.length,
        updated_at: row.updated_at,
      }];
    },
  });

  return { client, state };
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · AISLAMIENTO (IDOR)
   ═══════════════════════════════════════════════════════════════════════════ */

describe('coder-files · aislamiento entre usuarios (IDOR)', () => {
  let db = null;

  beforeEach(() => {
    db = storeMock([
      {
        user_id: OTHER_USER_ID,
        filename: 'secreto.js',
        content: 'const clavePrivada = "no-me-lo-mires";',
        language: 'javascript',
        updated_at: '2026-10-01T00:00:00.000Z',
      },
      {
        user_id: TEST_USER_ID,
        filename: 'mio.js',
        content: 'export const mio = true;',
        language: 'javascript',
        updated_at: '2026-10-01T00:00:00.000Z',
      },
    ]);
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('el Usuario A NO puede leer un archivo del Usuario B', async () => {
    const archivo = await getFile(TEST_USER_ID, 'secreto.js');

    assert.equal(archivo, null, 'debe devolver null, no el archivo ajeno');
  });

  it('el Usuario A sí lee SUS archivos', async () => {
    const archivo = await getFile(TEST_USER_ID, 'mio.js');

    assert.ok(archivo);
    assert.equal(archivo.path, 'mio.js');
    assert.ok(archivo.content.includes('mio'));
  });

  it('listFiles sólo devuelve los archivos del propio usuario', async () => {
    const archivos = await listFiles(TEST_USER_ID);

    assert.equal(archivos.length, 1);
    assert.equal(archivos[0].path, 'mio.js');
    assert.equal(
      archivos.some((f) => f.path === 'secreto.js'),
      false,
      'no debe listar archivos ajenos'
    );
  });

  it('la consulta SIEMPRE filtra por user_id como parámetro', async () => {
    await getFile(TEST_USER_ID, 'secreto.js');
    await listFiles(TEST_USER_ID);

    const lecturas = db.client.calls.filter((c) => /select\s+filename/i.test(c.text));

    assert.ok(lecturas.length > 0);
    for (const call of lecturas) {
      assert.ok(
        call.values.includes(TEST_USER_ID),
        'el user_id debe viajar como parámetro de la consulta'
      );
      assert.equal(
        call.text.includes(OTHER_USER_ID),
        false,
        'el user_id ajeno NUNCA debe ir concatenado en el SQL'
      );
    }
  });

  it('un user_id inválido se rechaza antes de tocar la base', async () => {
    await assert.rejects(() => getFile('no-soy-uuid', 'mio.js'), /inválido/i);
    await assert.rejects(() => listFiles(''), /inválido/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   03 · UPSERT IDEMPOTENTE
   ═══════════════════════════════════════════════════════════════════════════ */

describe('coder-files · upsert idempotente', () => {
  let db = null;

  beforeEach(() => {
    db = storeMock([]);
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('guardar dos veces el mismo archivo NO duplica filas', async () => {
    await upsertFile(TEST_USER_ID, 'app.js', 'const a = 1;', 'javascript');
    await upsertFile(TEST_USER_ID, 'app.js', 'const a = 2;', 'javascript');

    const mios = db.state.files.filter((f) => f.user_id === TEST_USER_ID);

    assert.equal(mios.length, 1, 'debe quedar un solo registro');
    assert.equal(mios[0].content, 'const a = 2;', 'debe conservar el contenido más nuevo');
  });

  it('el upsert usa ON CONFLICT sobre (user_id, filename)', async () => {
    await upsertFile(TEST_USER_ID, 'app.js', 'x', 'javascript');

    const insert = db.client.callsMatching('insert into public.coder_files')[0];
    const sql = insert.text.replace(/\s+/g, ' ');

    assert.match(sql, /on conflict/i);
    assert.match(sql, /user_id, filename/i);
  });

  it('el mismo nombre en usuarios distintos son archivos distintos', async () => {
    await upsertFile(TEST_USER_ID, 'app.js', 'contenido A', 'javascript');
    await upsertFile(OTHER_USER_ID, 'app.js', 'contenido B', 'javascript');

    assert.equal(db.state.files.length, 2);

    const mio = await getFile(TEST_USER_ID, 'app.js');
    const suyo = await getFile(OTHER_USER_ID, 'app.js');

    assert.ok(mio.content.includes('contenido A'));
    assert.ok(suyo.content.includes('contenido B'));
  });

  it('rechaza un archivo que supera el tamaño máximo', async () => {
    const gigante = 'x'.repeat(MAX_FILE_BYTES + 10);

    await assert.rejects(
      () => upsertFile(TEST_USER_ID, 'enorme.txt', gigante),
      /máximo/i
    );
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   04 · NORMALIZACIÓN DE RUTAS
   ═══════════════════════════════════════════════════════════════════════════ */

describe('coder-files · normalización de rutas', () => {
  it('acepta una ruta normal y la limpia', () => {
    const result = normalizeFilename('src/app/main.js');

    assert.equal(result.ok, true);
    assert.equal(result.path, 'src/app/main.js');
  });

  it('rechaza rutas peligrosas (path traversal)', () => {
    const peligrosas = [
      '../../../etc/passwd',
      'src/../../secreto.js',
      '/ruta/absoluta.js',
      'C:\\windows\\system32\\cmd.exe',
      'carpeta\\con\\barras.js',
    ];

    for (const ruta of peligrosas) {
      const result = normalizeFilename(ruta);
      assert.equal(result.ok, false, `debe rechazar: ${ruta}`);
      assert.equal(typeof result.error, 'string');
    }
  });

  it('rechaza un nombre vacío o con caracteres de control', () => {
    assert.equal(normalizeFilename('').ok, false);
    assert.equal(normalizeFilename('   ').ok, false);
    assert.equal(normalizeFilename('archivo\u0000.js').ok, false);
  });

  it('detecta el lenguaje por extensión', () => {
    assert.equal(languageFromPath('app.js'), 'javascript');
    assert.equal(languageFromPath('app.tsx'), 'typescript');
    assert.equal(languageFromPath('styles.css'), 'css');
    assert.equal(languageFromPath('leeme.md'), 'markdown');
    assert.equal(languageFromPath('desconocido.xyz'), 'plaintext');
  });

  it('valida los UUID', () => {
    assert.equal(isUuid(TEST_USER_ID), true);
    assert.equal(isUuid('no-uuid'), false);
    assert.equal(isUuid(null), false);
  });

  it('ensureTable es idempotente', async () => {
    await ensureTable();
    await ensureTable();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   05 · HANDLERS HTTP
   ═══════════════════════════════════════════════════════════════════════════ */

describe('coder-files · handlers HTTP', () => {
  let db = null;

  beforeEach(() => {
    db = storeMock([
      {
        user_id: OTHER_USER_ID,
        filename: 'privado.js',
        content: 'secreto',
        language: 'javascript',
        updated_at: '2026-10-01T00:00:00.000Z',
      },
    ]);
  });

  afterEach(() => {
    restoreDatabase();
    db = null;
  });

  it('el handler de carga no filtra archivos ajenos', async () => {
    const req = {
      method: 'GET',
      query: { filename: 'privado.js' },
      user: { id: TEST_USER_ID },
      headers: {},
    };

    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
      send(payload) { this.body = payload; return this; },
      setHeader() { return this; },
    };

    await loadHandler(req, res, () => {});

    const body = JSON.stringify(res.body);

    assert.equal(
      body.includes('secreto'),
      false,
      'la respuesta no debe filtrar el contenido del archivo ajeno'
    );
  });
});
