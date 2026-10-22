/**
 * Numination · Modo Coder — context-parser.js
 * Extrae la estructura de un archivo (funciones, clases, variables, imports)
 * con expresiones regulares y la convierte en un resumen en lenguaje natural
 * que se inyecta en el prompt del modelo.
 *
 * Diseñado para ser tolerante: un regex no debe romper nunca el flujo; si el
 * código tiene sintaxis rara, el parser devuelve lo que encuentra y sigue.
 */

/** @typedef {{ name: string, line: number, args: string, kind: string }} CodeSymbol */

/**
 * Elimina SOLO los comentarios, conservando las cadenas.
 * Necesario para detectar imports/exports: la ruta de un módulo vive dentro
 * de una cadena y se perdería si se eliminaran las cadenas primero.
 * @param {string} code
 * @returns {string}
 */
function stripComments(code) {
  return String(code || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')       // comentarios de bloque
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');  // comentarios de línea (no rompe URLs)
}

/**
 * Elimina comentarios y cadenas para evitar falsos positivos del regex.
 * @param {string} code
 * @returns {string}
 */
function stripNoise(code) {
  return stripComments(code)
    .replace(/(['"`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""'); // cadenas
}

/**
 * Calcula el número de línea (1-based) de un índice dentro del texto original.
 * @param {string} code Texto original.
 * @param {number} index Índice en el texto original.
 * @returns {number}
 */
function lineAt(code, index) {
  let line = 1;
  for (let i = 0; i < index && i < code.length; i++) {
    if (code.charCodeAt(i) === 10) line++;
  }
  return line;
}

/**
 * @typedef {Object} CodeContext
 * @property {string} language
 * @property {number} lines
 * @property {number} chars
 * @property {CodeSymbol[]} functions
 * @property {CodeSymbol[]} classes
 * @property {CodeSymbol[]} variables
 * @property {string[]} imports
 * @property {string[]} exports
 */

/**
 * Analiza el código y devuelve su estructura.
 * @param {string} code
 * @param {string} [language='javascript']
 * @returns {CodeContext}
 */
export function parseCodeContext(code, language = 'javascript') {
  const source = typeof code === 'string' ? code : '';
  const clean = stripNoise(source);

  const functions = [];
  const classes = [];
  const variables = [];
  const imports = [];
  const exports = [];

  // ── Funciones declaradas ──
  const fnRe = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  let m;
  while ((m = fnRe.exec(clean)) !== null) {
    functions.push({ name: m[1], args: m[2].trim(), line: lineAt(clean, m.index), kind: 'function' });
  }

  // ── Funciones flecha / métodos shorthand (JS/TS) ──
  const arrowRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\*?\s*)?\(([^)]*)\)\s*=>/g;
  while ((m = arrowRe.exec(clean)) !== null) {
    functions.push({ name: m[1], args: m[2].trim(), line: lineAt(clean, m.index), kind: 'arrow' });
  }

  // ── Clases ──
  const classRe = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*))?/g;
  while ((m = classRe.exec(clean)) !== null) {
    classes.push({
      name: m[1],
      args: m[2] ? `extends ${m[2]}` : '',
      line: lineAt(clean, m.index),
      kind: 'class'
    });
  }

  // ── Funciones de Python (def) y métodos (self) ──
  if (language === 'python') {
    const pyRe = /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(([^)]*)\)/g;
    while ((m = pyRe.exec(clean)) !== null) {
      functions.push({ name: m[1], args: m[2].trim(), line: lineAt(clean, m.index), kind: 'def' });
    }
  }

  // ── Variables de nivel superior (no dentro de paréntesis) ──
  const varRe = /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*([^;\n]{0,120})/g;
  while ((m = varRe.exec(clean)) !== null) {
    const name = m[1];
    if (functions.some((f) => f.name === name)) continue;
    variables.push({
      name,
      args: (m[2] || '').trim().slice(0, 80),
      line: lineAt(clean, m.index),
      kind: 'variable'
    });
  }

  // ── Imports (sobre el texto SIN cadenas eliminadas: la ruta va entre comillas) ──
  const importRe = /^[ \t]*import\s+(?:[^'";\n]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;
  let importScan = stripComments(source);
  while ((m = importRe.exec(importScan)) !== null) imports.push(m[1]);

  const pyImportRe = /(?:^|\n)\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/g;
  while ((m = pyImportRe.exec(clean)) !== null) imports.push(m[1] || m[2]);

  // ── Exports (anclado a línea para no capturar texto dentro de cadenas) ──
  const exportRe = /^[ \t]*export\s+(?:const|let|var|function|class|default)\s+([A-Za-z_$][\w$]*)?/gm;
  while ((m = exportRe.exec(importScan)) !== null) {
    if (m[1]) exports.push(m[1]);
  }

  const pyExportRe = /(?:^|\n)\s*def\s+([A-Za-z_][\w]*)/g;
  if (language === 'python') {
    while ((m = pyExportRe.exec(clean)) !== null) {
      if (!functions.some((f) => f.name === m[1])) exports.push(m[1]);
    }
  }

  return {
    language,
    lines: source ? source.split('\n').length : 0,
    chars: source.length,
    functions: dedupeByName(functions),
    classes: dedupeByName(classes),
    variables: dedupeByName(variables),
    imports: [...new Set(imports)].slice(0, 25),
    exports: [...new Set(exports)].slice(0, 25)
  };
}

/**
 * Elimina duplicados conservando la primera aparición.
 * @template {{name:string}} T
 * @param {T[]} list
 * @returns {T[]}
 */
function dedupeByName(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || seen.has(item.name)) continue;
    seen.add(item.name);
    out.push(item);
  }
  return out;
}

/**
 * Convierte el contexto en el resumen legible que inyecta el backend.
 * @param {CodeContext|string} ctx Resultado de parseCodeContext o código crudo.
 * @returns {string}
 */
export function buildContextSummary(ctx) {
  const parsed = typeof ctx === 'string' ? parseCodeContext(ctx) : ctx;
  if (!parsed) return '';

  const lines = [];
  lines.push(`El usuario está editando un archivo ${parsed.language} de ${parsed.lines} líneas.`);

  if (parsed.functions.length) {
    lines.push(
      `El usuario tiene estas funciones: ${parsed.functions
        .slice(0, 12)
        .map((f) => `${f.name}(${f.args})`)
        .join(', ')}.`
    );
  }
  if (parsed.classes.length) {
    lines.push(`Clases definidas: ${parsed.classes.slice(0, 8).map((c) => c.name).join(', ')}.`);
  }
  if (parsed.variables.length) {
    lines.push(
      `Variables principales: ${parsed.variables.slice(0, 10).map((v) => v.name).join(', ')}.`
    );
  }
  if (parsed.imports.length) {
    lines.push(`Módulos importados: ${parsed.imports.slice(0, 10).join(', ')}.`);
  }
  if (parsed.exports.length) {
    lines.push(`Exportaciones públicas: ${parsed.exports.slice(0, 10).join(', ')}.`);
  }

  return lines.join('\n');
}

/**
 * Atajo: parsea y resume en una llamada.
 * @param {string} code
 * @param {string} [language='javascript']
 * @returns {{ context: CodeContext, summary: string }}
 */
export function analyzeCode(code, language = 'javascript') {
  const context = parseCodeContext(code, language);
  return { context, summary: buildContextSummary(context) };
}

export default { parseCodeContext, buildContextSummary, analyzeCode };
