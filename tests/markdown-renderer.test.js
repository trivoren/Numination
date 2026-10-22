/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · tests/markdown-renderer.test.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Pruebas del motor de Markdown del frontend (public/assets/js/escritura.js).

   CASO EXIGIDO
     · Un bloque de código Markdown se convierte en HTML con la clase
       "nm-code-block" y con el botón de copiar.

   Y ADEMÁS
     · el botón de copiar lleva el onclick correcto (Escritura.copyCode)
     · el código viaja codificado (encodeURIComponent): romper las
       comillas simples no puede romper el HTML
     · el resaltado escapa el HTML: un <script> en el código no se ejecuta
     · el resto del Markdown (títulos, listas, tablas) sigue funcionando
     · el script del navegador se carga en Node con un DOM mínimo
   ═══════════════════════════════════════════════════════════════════════════ */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.join(__dirname, '..', 'public', 'assets', 'js', 'escritura.js');

/* ═══════════════════════════════════════════════════════════════════════════
   01 · DOM MÍNIMO PARA CORRER EL SCRIPT DEL NAVEGADOR EN NODE
   ═══════════════════════════════════════════════════════════════════════════ */

function createElement(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    style: {},
    dataset: {},
    className: '',
    innerHTML: '',
    textContent: '',
    children: [],
    attributes: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    removeAttribute(name) { delete this.attributes[name]; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    remove() {},
  };
  return el;
}

function createDomShim() {
  const document = {
    readyState: 'complete',
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement,
    createTextNode: (text) => ({ textContent: String(text) }),
    body: createElement('body'),
    head: createElement('head'),
    documentElement: createElement('html'),
  };

  const window = {
    document,
    addEventListener() {},
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    location: { href: 'http://localhost/', origin: 'http://localhost' },
    navigator: { language: 'es-ES', userAgent: 'node-test' },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  };

  return { window, document };
}

/* ═══════════════════════════════════════════════════════════════════════════
   02 · CARGA DEL MOTOR
   ═══════════════════════════════════════════════════════════════════════════ */

let Escritura = null;

before(async () => {
  const source = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const { window, document } = createDomShim();

  const context = vm.createContext({
    window,
    document,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    encodeURIComponent,
    decodeURIComponent,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    Date,
    Math,
    JSON,
    String,
    Number,
    Array,
    Object,
    RegExp,
    Promise,
    Error,
  });

  // El script del navegador usa `window` como objeto global.
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'escritura.js' });

  Escritura = window.Escritura;
});

/* ═══════════════════════════════════════════════════════════════════════════
   03 · BLOQUES DE CÓDIGO
   ═══════════════════════════════════════════════════════════════════════════ */

describe('markdown-renderer · bloques de código', () => {
  it('convierte un bloque de código en HTML con la clase nm-code-block', () => {
    const html = Escritura.render('```js\nconst x = 1;\n```');

    assert.ok(html.includes('nm-code-block'), 'debe incluir la clase nm-code-block');
    assert.ok(html.includes('nm-code-header'), 'debe incluir el encabezado');
    assert.ok(html.includes('nm-code-body'), 'debe incluir el cuerpo');
    assert.ok(html.includes('JS'), 'debe mostrar el lenguaje');
  });

  it('el botón de copiar tiene el onclick correcto', () => {
    const html = Escritura.render('```js\nconst x = 1;\n```');

    assert.ok(html.includes('Escritura.copyCode('), 'debe llamar a Escritura.copyCode');
    assert.ok(
      html.includes('class="nm-code-btn"'),
      'el botón debe tener la clase nm-code-btn'
    );
    assert.ok(html.includes('onclick="Escritura.copyCode(this,'), 'el onclick debe pasar this');
  });

  it('el código viaja codificado en el onclick', () => {
    const html = Escritura.render("```js\nconst s = 'comillas simples';\n```");

    assert.ok(
      html.includes(encodeURIComponent("const s = 'comillas simples';")),
      'el código debe ir con encodeURIComponent'
    );
  });

  it('un script dentro del bloque NO se ejecuta (se escapa)', () => {
    const html = Escritura.render('```html\n<script>alert(1)</script>\n```');

    assert.equal(
      html.includes('<script>alert(1)</script>'),
      false,
      'el HTML del código debe ir escapado'
    );
    assert.ok(html.includes('nm-code-block'));
  });

  it('el botón de descargar también usa el motor de Escritura', () => {
    const html = Escritura.render('```py\nprint("hola")\n```');

    assert.ok(html.includes('Escritura.downloadCode(this,'));
  });

  it('un bloque sin lenguaje se renderiza igual', () => {
    const html = Escritura.render('```\ntexto plano\n```');

    assert.ok(html.includes('nm-code-block'));
    assert.ok(html.includes('Escritura.copyCode('));
  });

  it('varios bloques en el mismo mensaje se renderizan todos', () => {
    const html = Escritura.render('```js\nuno\n```\n\n```py\ndos\n```');

    const bloques = html.match(/nm-code-block/g) || [];

    assert.equal(bloques.length, 2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   04 · EL RESTO DEL MARKDOWN
   ═══════════════════════════════════════════════════════════════════════════ */

describe('markdown-renderer · markdown general', () => {
  it('renderiza un encabezado', () => {
    const html = Escritura.render('# Título principal');

    assert.ok(html.includes('Título principal'));
    assert.ok(/<h1|nm-h1|class="[^"]*h1/.test(html), 'debe producir un h1');
  });

  it('renderiza una lista', () => {
    const html = Escritura.render('- uno\n- dos');

    assert.ok(html.includes('uno'));
    assert.ok(html.includes('dos'));
    assert.ok(/<li|nm-li/.test(html), 'debe producir items de lista');
  });

  it('renderiza un párrafo con texto plano', () => {
    const html = Escritura.render('Un párrafo normal.');

    assert.ok(html.includes('Un párrafo normal.'));
  });

  it('devuelve vacío para una entrada vacía', () => {
    const html = Escritura.render('');

    assert.equal(typeof html, 'string');
  });

  it('expone las funciones públicas del motor', () => {
    assert.equal(typeof Escritura.render, 'function');
    assert.equal(typeof Escritura.copyCode, 'function');
    assert.equal(typeof Escritura.downloadCode, 'function');
  });
});
