/**
 * Prueba de integración del Modo Coder contra la app Express real.
 * Ejecuta: node scripts/_smoke-coder-api.mjs
 *
 * Levanta la app en un puerto efímero y comprueba:
 *   - Las rutas /api/coder/* existen y están protegidas (401 sin sesión).
 *   - La validación del backend responde 400 con el código correcto.
 *   - La tabla coder_files se puede crear en Postgres.
 */
import { app } from '../src/index.js';

const server = app.listen(0);
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
};

async function call(path, options = {}) {
  const res = await fetch(base + path, options);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* no json */ }
  return { status: res.status, json, text };
}

try {
  console.log('\n[API] rutas del Modo Coder');

  const load = await call('/api/coder/load');
  ok('GET /api/coder/load responde 401 sin sesión', load.status === 401, `status=${load.status}`);
  ok('...con código de error', !!load.json?.code, JSON.stringify(load.json));

  const save = await call('/api/coder/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'a.js', content: 'x' })
  });
  ok('POST /api/coder/save responde 401 sin sesión', save.status === 401, `status=${save.status}`);

  const exec = await call('/api/coder/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: 'ls' })
  });
  ok('POST /api/coder/execute responde 401 sin sesión', exec.status === 401, `status=${exec.status}`);

  const chat = await call('/api/coder/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'hola' })
  });
  ok('POST /api/coder/chat responde 401 sin sesión', chat.status === 401, `status=${chat.status}`);

  console.log('\n[API] método incorrecto');
  const bad = await call('/api/coder/save', { method: 'GET' });
  ok('GET /api/coder/save no ejecuta guardado', bad.status === 404 || bad.status === 405 || bad.status === 401, `status=${bad.status}`);

  console.log('\n[DB] capa de almacenamiento');
  const store = await import('../api/coder/_store.js');
  const { ensureTable, normalizeFilename, listFiles, getFile, upsertFile } = store;
  try {
    await ensureTable();
    console.log('  ok   tabla public.coder_files disponible');
  } catch (err) {
    console.log(`  warn tabla no creada: ${err.message}`);
  }
  ok('rechaza path con ".."', normalizeFilename('../etc/passwd').ok === false);
  ok('rechaza ruta absoluta', normalizeFilename('/etc/passwd').ok === false);
  ok('rechaza extensión no permitida', normalizeFilename('app.exe').ok === false);
  ok('acepta ruta con carpetas', normalizeFilename('src/utils/format.js').ok === true);

  console.log('\n[DB] aislamiento por usuario (upsert/list/get)');
  const uuidA = '11111111-1111-4111-8111-111111111111';
  const uuidB = '22222222-2222-4222-8222-222222222222';
  try {
    await upsertFile(uuidA, 'demo/saludo.js', 'export const hola = () => "hola";', 'javascript');
    const listA = await listFiles(uuidA);
    ok('el archivo aparece en la lista de su dueño', listA.some((f) => f.path === 'demo/saludo.js'));
    const readA = await getFile(uuidA, 'demo/saludo.js');
    ok('el contenido se lee correctamente', readA?.content?.includes('hola'));
    const listB = await listFiles(uuidB);
    ok('otro usuario NO ve los archivos ajenos', !listB.some((f) => f.path === 'demo/saludo.js'));
    const readB = await getFile(uuidB, 'demo/saludo.js');
    ok('lectura ajena devuelve null', readB === null);
    // idempotencia: mismo archivo, nuevo contenido → una sola fila
    await upsertFile(uuidA, 'demo/saludo.js', 'export const hola = () => "hola v2";', 'javascript');
    const listA2 = await listFiles(uuidA);
    ok('upsert es idempotente (no duplica filas)', listA2.filter((f) => f.path === 'demo/saludo.js').length === 1);
    const readA2 = await getFile(uuidA, 'demo/saludo.js');
    ok('upsert actualiza el contenido', readA2?.content?.includes('v2'));
  } catch (err) {
    failures++;
    console.log(`  FAIL operaciones de almacenamiento: ${err.message}`);
  } finally {
    try {
      const { sql } = await import('../src/services/supabase.js');
      await sql`delete from public.coder_files where user_id in (${uuidA}::uuid, ${uuidB}::uuid)`;
      console.log('  ok   filas de prueba eliminadas');
    } catch { /* cleanup opcional */ }
  }
} finally {
  server.close();
}

console.log(failures === 0 ? '\n✅ INTEGRACIÓN OK\n' : `\n❌ ${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
