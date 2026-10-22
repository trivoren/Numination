/**
 * Smoke test del Lote 3 (lógica pura del IDE).
 * Ejecuta: node _smoke-coder.mjs
 */
import { parseCodeContext, buildContextSummary } from '../services/context-parser.js';
import { buildCoderSystemPrompt, buildCoderUserPrompt, extractCodeBlock, clampCode } from '../services/code-prompts.js';
import { validateCommand } from '../api/coder/execute.js';

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name} ${extra}`); }
};

console.log('\n[1] context-parser');
const sample = `
import { render } from './render.js';
const MAX_ITEMS = 50;
let counter = 0;

export function calculateTotal(items, tax = 0.21) {
  return items.reduce((acc, i) => acc + i.price, 0) * (1 + tax);
}

const formatCurrency = (value) => '$' + value.toFixed(2);

export class Cart {
  constructor() { this.items = []; }
  add(item) { this.items.push(item); }
}

export default calculateTotal;
`;
const ctx = parseCodeContext(sample, 'javascript');
ok('detecta funciones declaradas', ctx.functions.some((f) => f.name === 'calculateTotal'));
ok('detecta arrow functions', ctx.functions.some((f) => f.name === 'formatCurrency'));
ok('detecta clases', ctx.classes.some((c) => c.name === 'Cart'));
ok('detecta constantes', ctx.variables.some((v) => v.name === 'MAX_ITEMS'));
ok('detecta imports', ctx.imports.includes('./render.js'));
ok('detecta exports', ctx.exports.includes('Cart'));
const summary = buildContextSummary(ctx);
ok('resumen en lenguaje natural', summary.includes('El usuario tiene estas funciones') && summary.includes('calculateTotal'), summary.slice(0, 120));

console.log('\n[2] code-prompts');
const sys = buildCoderSystemPrompt({ filePath: 'app.js', language: 'javascript', contextSummary: summary });
ok('system prompt incluye archivo', sys.includes('app.js'));
ok('system prompt incluye reglas de bloque', sys.includes('```'));
const usr = buildCoderUserPrompt({ instruction: 'añade validación', code: sample, filePath: 'app.js', language: 'javascript' });
ok('user prompt incluye petición', usr.includes('añade validación'));
ok('user prompt incluye código', usr.includes('MAX_ITEMS'));
const block = extractCodeBlock('Explico un poco\n```javascript\nconst a = 1;\n```\nfin');
ok('extrae bloque de código', block && block.code === 'const a = 1;' && block.language === 'javascript');
ok('devuelve null sin bloque', extractCodeBlock('solo texto') === null);
const clamped = clampCode('a'.repeat(50000));
ok('recorta código largo', clamped.truncated && clamped.code.length < 50000);

console.log('\n[3] execute.js · validación de comandos');
ok('rechaza "; rm -rf"', validateCommand('ls; rm -rf /').ok === false);
ok('rechaza "&&"', validateCommand('ls && whoami').ok === false);
ok('rechaza redirección', validateCommand('cat a > b').ok === false);
ok('rechaza binario desconocido', validateCommand('rm -rf /').ok === false);
ok('rechaza multilínea', validateCommand('ls\nwhoami').ok === false);
ok('acepta ls', validateCommand('ls -la').ok === true);
ok('acepta npm install', validateCommand('npm install express').ok === true);
ok('acepta node archivo', validateCommand('node index.js').ok === true);
ok('rechaza longitud excesiva', validateCommand('x'.repeat(300)).ok === false);

console.log('\n[4] diff-viewer · algoritmo (entorno simulado)');
const { JSDOMless } = { JSDOMless: null };
globalThis.window = {
  addEventListener() {}, dispatchEvent() {}, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
  NuminToast: { info() {}, ok() {}, error() {} },
  eventBus: { emit() {} }
};
globalThis.document = {
  getElementById: () => null,
  addEventListener() {},
  body: { style: {} }
};
await import('../public/assets/js/diff-viewer.js');
const DV = globalThis.window.DiffViewer;
ok('diff-viewer expone API', !!DV && typeof DV.buildDiff === 'function');
const diff = DV.buildDiff('a\nb\nc', 'a\nB\nc');
ok('detecta 1 adición y 1 borrado', diff.added === 1 && diff.removed === 1, JSON.stringify(diff));
ok('conserva contexto', diff.ops.some((o) => o.type === 'ctx' && o.text === 'a'));
const elided = DV.buildDiff('a\nb\nc', 'a\n// ...\nc');
ok('expande la elisión "// ..."', elided.added === 0 && elided.removed === 0, JSON.stringify(elided.ops));
const parsed = DV.parseAiResponse('```js\nconst x = 1;\n```');
ok('parsea respuesta con bloque', parsed && parsed.code === 'const x = 1;');

console.log(failures === 0 ? '\n✅ TODOS LOS TESTS PASAN\n' : `\n❌ ${failures} FALLOS\n`);
process.exit(failures === 0 ? 0 : 1);
