/**
 * Numination · Modo Coder — code-prompts.js
 * Contrato de prompt para el modo de programación.
 *
 * Principio (prompt-engineer): el prompt es una INTERFAZ. Define el contrato
 * de salida que el frontend sabe parsear (`diff-viewer.js`), por eso la salida
 * es determinista: un único bloque ```lenguaje con el ARCHIVO COMPLETO.
 *
 * Si la IA devuelve explicaciones, el parser las descarta y el diff viewer
 * sigue funcionando; si devuelve el archivo completo, el diff es exacto.
 */

/**
 * Prompt de sistema del Modo Coder.
 * @type {string}
 */
export const SYSTEM_PROMPT = `Eres el motor de refactorización de Numination Coder, un IDE web.

REGLAS DE SALIDA (innegociables):
1. Responde SIEMPRE con UN SOLO bloque de código markdown, delimitado así:
   \`\`\`<lenguaje>
   <código completo del archivo>
   \`\`\`
2. El bloque debe contener el ARCHIVO COMPLETO ya modificado, no fragmentos.
3. No escribas explicaciones, prosa, listas ni texto antes o después del bloque.
   Si necesitas comentar algo del código, usa comentarios dentro del propio código.
4. Mantén exactamente el lenguaje del archivo original (javascript, typescript,
   python, css, html, json, etc.). Si el archivo no tiene extensión reconocible,
   usa "text".
5. Conserva el estilo, la indentación, las comillas y el idioma de los comentarios
   ya presentes en el archivo original.
6. No elimines código que el usuario no te pidió tocar. Cambia solo lo necesario.
7. Si el archivo es largo y solo cambia una parte, puedes marcar el resto con
   una línea de comentario: // ... ( resto del archivo sin cambios ) ...
   Esa marca se expande con el contenido original al aplicar el diff.
8. Si la petición no requiere cambios de código, devuelve el archivo original
   sin modificar dentro del bloque.
9. Nunca incluyas secretos, claves de API ni datos personales inventados.
10. Responde en el idioma del usuario solo dentro de comentarios de código.`;

/**
 * Tokens de contexto como los usa la plataforma.
 * @typedef {Object} CoderPromptContext
 * @property {string} [filePath] Ruta del archivo abierto.
 * @property {string} [language] Lenguaje detectado.
 * @property {string} [code] Contenido actual del archivo.
 * @property {string} [contextSummary] Resumen estructural del archivo.
 * @property {string} [instruction] Petición textual del usuario.
 * @property {string} [history] Historial breve en texto plano.
 */

/**
 * Construye el prompt de sistema final (reglas + contexto del proyecto).
 * @param {CoderPromptContext} ctx
 * @returns {string}
 */
export function buildCoderSystemPrompt(ctx = {}) {
  const blocks = [SYSTEM_PROMPT];

  const filePath = safeText(ctx.filePath, 'index.js');
  const language = safeText(ctx.language, 'text');
  const summary = safeText(ctx.contextSummary, '');

  blocks.push(
    '\n\n── CONTEXTO DEL ENTORNO ──\n' +
    `Archivo abierto: ${filePath}\n` +
    `Lenguaje: ${language}\n` +
    (summary ? `\n${summary}\n` : '')
  );

  return blocks.join('');
}

/**
 * Construye el mensaje del usuario con la instrucción + código actual.
 * @param {CoderPromptContext} ctx
 * @returns {string}
 */
export function buildCoderUserPrompt(ctx = {}) {
  const instruction = safeText(ctx.instruction, '').trim();
  const code = typeof ctx.code === 'string' ? ctx.code : '';
  const filePath = safeText(ctx.filePath, 'index.js');
  const language = safeText(ctx.language, 'text');
  const history = safeText(ctx.history, '').trim();

  const parts = [];
  if (history) parts.push(`── CONVERSACIÓN PREVIA ──\n${history}\n`);
  parts.push(`── PETICIÓN ──\n${instruction}\n`);
  parts.push(`── ARCHIVO ACTUAL (${filePath}) ──\n${code}\n`);
  parts.push(
    `── RESPUESTA REQUERIDA ──\nDevuelve únicamente el bloque \`\`\`${language} con el archivo completo modificado.`
  );
  return parts.join('\n');
}

/**
 * Límite de caracteres de código que se envían al modelo (control de coste).
 * @type {number}
 */
export const MAX_CODE_CHARS = 40_000;

/**
 * Recorta el código de forma inteligente (por líneas) para no romper el budget.
 * @param {string} code
 * @param {number} [max=MAX_CODE_CHARS]
 * @returns {{ code: string, truncated: boolean }}
 */
export function clampCode(code, max = MAX_CODE_CHARS) {
  const text = typeof code === 'string' ? code : '';
  if (text.length <= max) return { code: text, truncated: false };
  const head = text.slice(0, Math.floor(max * 0.75));
  const tail = text.slice(-Math.floor(max * 0.2));
  const omitted = text.length - head.length - tail.length;
  return {
    code: `${head}\n// ... (${omitted} caracteres omitidos por límite de contexto) ...\n${tail}`,
    truncated: true
  };
}

/**
 * Extrae el primer bloque de código de una respuesta de la IA.
 * @param {string} text
 * @returns {{ code: string, language: string } | null}
 */
export function extractCodeBlock(text) {
  if (typeof text !== 'string' || !text) return null;
  const fence = /```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/;
  const match = fence.exec(text);
  if (!match) return null;
  return {
    language: (match[1] || 'text').toLowerCase(),
    code: match[2].replace(/\r\n/g, '\n').replace(/\s+$/, '')
  };
}

/**
 * Texto plano seguro (sin caracteres de control).
 * @param {unknown} value
 * @param {string} fallback
 * @returns {string}
 */
function safeText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  // eslint-disable-next-line no-control-regex
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  return clean || fallback;
}

export default {
  SYSTEM_PROMPT,
  MAX_CODE_CHARS,
  buildCoderSystemPrompt,
  buildCoderUserPrompt,
  clampCode,
  extractCodeBlock
};
