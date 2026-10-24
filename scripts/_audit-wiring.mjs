/**
 * Auditoría estática de cableado del Modo Coder.
 * Verifica que cada id/clase que el JS busca exista en el HTML/CSS y que el
 * orden de carga de los scripts sea correcto.
 * Ejecuta: node scripts/_audit-wiring.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('public/coder.html');
const css = read('public/assets/css/coder.css');
const jsFiles = [
  'public/assets/js/ide-events.js',
  'public/assets/js/numination-boot.js',
  'public/assets/js/api-client.js',
  'public/assets/js/editor-core.js',
  'public/assets/js/file-tree.js',
  'public/assets/js/diff-viewer.js',
  'public/assets/js/agent-chat.js',
  'public/assets/js/terminal.js'
];

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
};

console.log('\n[1] ids del HTML');
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const requiredIds = [
  'coder-app', 'file-tree', 'btn-refresh-tree', 'explorer-user', 'btn-save',
  'editor-tabs', 'monaco-container', 'editor-loading', 'status-file', 'status-dirty',
  'status-language', 'tab-chat', 'tab-terminal', 'panel-chat', 'panel-terminal',
  'terminal-mount', 'chat-form', 'chat-input', 'btn-send', 'chat-stream',
  'diff-modal', 'diff-body', 'diff-stats', 'diff-stat-add', 'diff-stat-del',
  'diff-modal-title', 'toast-stack'
];
for (const id of requiredIds) ok(`#${id} existe`, htmlIds.has(id));

console.log('\n[2] getElementById del JS → HTML');
for (const file of jsFiles) {
  const src = read(file);
  const used = [...src.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  for (const id of new Set(used)) {
    // 'status-file-extra' es opcional por diseño (el cursor)
    const optional = id === 'status-file-extra';
    ok(`${path.basename(file)} → #${id}`, htmlIds.has(id) || optional);
  }
}

console.log('\n[3] clases del JS → CSS');
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const jsClasses = new Set();
for (const file of jsFiles) {
  const src = read(file);
  for (const m of src.matchAll(/className\s*=\s*[`'"]([^`'"$]+)[`'"]/g)) {
    m[1].split(/\s+/).filter(Boolean).forEach((c) => jsClasses.add(c));
  }
  for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\(['"]([\w-]+)['"]\)/g)) jsClasses.add(m[1]);
}
for (const cls of jsClasses) {
  // Clases añadidas dinámicamente con template literal (diff-line--add etc.)
  if (cls.includes('--') || cls.startsWith('chat-msg--')) {
    const base = cls.replace(/--\w+$/, '');
    ok(`${cls} (base ${base} en CSS)`, cssClasses.has(base));
    continue;
  }
  ok(`.${cls}`, cssClasses.has(cls));
}

console.log('\n[4] orden de carga de scripts');
const order = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
const idx = (needle) => order.findIndex((s) => s.includes(needle));
ok('ide-events.js antes de numination-boot.js', idx('ide-events.js') > -1 && idx('ide-events.js') < idx('numination-boot.js'));
ok('numination-boot.js antes de los módulos', idx('numination-boot.js') < idx('editor-core.js'));
ok('api-client.js antes de file-tree/agent-chat/terminal',
  idx('api-client.js') > -1 && idx('api-client.js') < idx('file-tree.js') && idx('api-client.js') < idx('agent-chat.js'));
ok('diff-viewer.js antes de agent-chat.js', idx('diff-viewer.js') < idx('agent-chat.js'));
ok('editor-core.js antes de file-tree.js', idx('editor-core.js') < idx('file-tree.js'));

console.log('\n[5] assets locales referenciados');
for (const m of html.matchAll(/(?:src|href)="(assets\/[^"]+)"/g)) {
  ok(`${m[1]} existe en disco`, fs.existsSync(path.join(root, 'public', m[1])));
}

console.log('\n[6] contratos de API (frontend ↔ backend)');
const apiClient = read('public/assets/js/api-client.js');
const agentChat = read('public/assets/js/agent-chat.js');
const fileTree = read('public/assets/js/file-tree.js');
const terminal = read('public/assets/js/terminal.js');
ok('el chat llama a /api/coder/chat', agentChat.includes('/api/coder/chat'));
ok('el árbol llama a /api/coder/load', fileTree.includes('/api/coder/load'));
ok('el árbol guarda en /api/coder/save', fileTree.includes('/api/coder/save'));
ok('la terminal llama a /api/coder/execute', terminal.includes('/api/coder/execute'));
ok('el cliente expone stream()', apiClient.includes('stream:') || apiClient.includes('stream('));

console.log('\n[7] backend: las 4 rutas existen');
const backend = [
  ['api/coder/load.js', 'GET'],
  ['api/coder/save.js', 'POST'],
  ['api/coder/execute.js', 'POST'],
  ['api/coder/chat.js', 'POST']
];
for (const [file, method] of backend) {
  const src = read(file);
  // El patrón directo (sin sesión) era la fuente del 401 en Vercel:
  // los handlers serverless deben usar el wrapper `withCoderSession`
  // (resuelve cookies/query/body + attachUser en contexto serverless).
  const okPattern =
    src.includes(`export default withCoderSession(handler)`) ||
    src.includes(`export default async function handler`);
  ok(`${file} declara ${method}`, okPattern && src.includes(`'${method}'`));
}
const mount = read('src/coder.js');
for (const route of ['/api/coder/load', '/api/coder/save', '/api/coder/execute', '/api/coder/chat']) {
  ok(`montada ${route}`, mount.includes(route));
}
const index = read('src/index.js');
ok('mountCoderRoutes invocado en src/index.js', index.includes('mountCoderRoutes(app, requireAuth)'));

console.log('\n[8] higiene');
for (const file of [...jsFiles, ...backend.map((b) => b[0]), 'src/coder.js', 'services/code-prompts.js', 'services/context-parser.js']) {
  const src = read(file);
  ok(`${file} sin TODO/FIXME`, !/\b(TODO|FIXME|XXX)\b/.test(src));
  ok(`${file} sin CJK accidental`, !/[\u4e00-\u9fff]/.test(src));
}

console.log(failures === 0 ? '\n✅ AUDITORÍA DE CABLEADO OK\n' : `\n❌ ${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
