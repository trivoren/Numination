/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/unit-test-writer.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Generador de tests unitarios para el código del Coder.

   FLUJO
     1. Se toma el código del archivo (o un fragmento).
     2. El LLM escribe un archivo `.test.js` con Vitest (o Jest).
     3. Se limpia el output: se quitan las fences de markdown, se
        normaliza el `import` del framework y se formatea.
     4. Se devuelven el código listo para pegar y un resumen de qué se
        cubre.

   POR QUÉ "LISTO PARA PEGAR" Y NO "ARCHIVO GENERADO"
     El sandbox de ejecución está aislado del sistema de archivos del
     proyecto. Generar el archivo en el editor del usuario es más
     honesto que fingir que escribimos en disco.

   FRAMEWORKS
     · vitest   → `import { describe, it, expect } from 'vitest'`
     · jest     → `import { describe, it, expect } from '@jest/globals'`
     · node     → `node:test` + `node:assert` (sin dependencias)

   FALLBACK
     Si no hay API key, se genera un esqueleto de tests determinista a
     partir de las funciones exportadas que se detectan en el código.
     La función NUNCA devuelve vacío.
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/* Las claves pueden venir de .env.local o del archivo env.local.js
   (así lo carga el resto del proyecto). */
let FILE_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  FILE_KEYS = mod.TEST_KEYS ?? {};
} catch { /* archivo opcional */ }

/** Modelos de Groq disponibles para esta cuenta (configurables). */
const GROQ_MODELS = (() => {
  const configured = process.env.GROQ_MODEL || FILE_KEYS.GROQ_MODEL;
  return [configured, 'openai/gpt-oss-120b', 'llama-3.1-8b-instant']
    .filter(Boolean)
    .filter((m, i, arr) => arr.indexOf(m) === i);
})();

/** Modelo de chat de Gemini. */
const GEMINI_MODEL = process.env.GEMINI_MODEL || FILE_KEYS.GEMINI_MODEL || 'gemini-3.6-flash';

const CFG = Object.freeze({
  timeoutMs: 25_000,
  maxCodeChars: 16_000,
  maxTestChars: 20_000,
  groqUrl: 'https://api.groq.com/openai/v1/chat/completions',
  groqModels: GROQ_MODELS,
  geminiUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
});

export const FRAMEWORKS = Object.freeze({
  vitest: {
    id: 'vitest',
    label: 'Vitest',
    importLine: "import { describe, it, expect } from 'vitest';",
    extension: '.test.js',
  },
  jest: {
    id: 'jest',
    label: 'Jest',
    importLine: "import { describe, it, expect } from '@jest/globals';",
    extension: '.test.js',
  },
  node: {
    id: 'node',
    label: 'Node test runner',
    importLine: "import { describe, it } from 'node:test';\nimport assert from 'node:assert/strict';",
    extension: '.test.mjs',
  },
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */



function groqKey() {
  return process.env.GROQ_API_KEY || FILE_KEYS.GROQ_API_KEY || null;
}

function geminiKey() {
  return process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY_3 || FILE_KEYS.GEMINI_API_KEY || null;
}

function clean(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

/**
 * Quita las fences de markdown y cualquier texto previo/postior.
 */
export function stripCodeFences(raw) {
  let text = clean(raw);

  const fenced = text.match(/```(?:[\w-]+)?\n([\s\S]*?)```/);
  if (fenced) {
    text = fenced[1];
  } else {
    // Sin fences: se recorta hasta la primera línea que parezca código.
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^\s*(import|const|let|var|function|class|describe|export|module\.exports)/.test(l));
    if (start > 0) {
      const end = [...lines].reverse().findIndex((l) => /^\s*(```|```$)/.test(l));
      text = lines.slice(start, end > 0 ? lines.length - end : undefined).join('\n');
    }
  }

  return text.replace(/^\s*```[a-z]*\s*$/gm, '').trim();
}

/**
 * Normaliza el import del framework y agrega el que falte.
 */
export function ensureImports(testCode, frameworkId = 'vitest') {
  const fw = FRAMEWORKS[frameworkId] || FRAMEWORKS.vitest;
  let code = String(testCode || '');

  const hasVitest = /from\s+['"]vitest['"]/.test(code);
  const hasJest = /from\s+['"]@jest\/globals['"]/.test(code);
  const hasNodeTest = /from\s+['"]node:test['"]/.test(code);
  const hasAssert = /from\s+['"]node:assert/.test(code);

  const needsVitest = frameworkId === 'vitest' && !hasVitest;
  const needsJest = frameworkId === 'jest' && !hasJest;
  const needsNode = frameworkId === 'node' && (!hasNodeTest || !hasAssert);

  if (needsVitest || needsJest || needsNode) {
    code = `${fw.importLine}\n\n${code}`;
  }

  return code;
}

/**
 * Detecta nombres de funciones exportadas (para el fallback local).
 */
export function detectExports(code) {
  const text = String(code || '');
  const names = new Set();

  const patterns = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /module\.exports\s*=\s*\{([^}]+)\}/g,
    /exports\.([A-Za-z_$][\w$]*)\s*=/g,
  ];

  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[1] && m[1].includes(',')) {
        m[1].split(',').forEach((part) => {
          const name = part.split(':').pop().trim();
          if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
        });
      } else if (m[1] && /^[A-Za-z_$][\w$]*$/.test(m[1])) {
        names.add(m[1]);
      }
    }
  }

  return Array.from(names).filter((n) => n !== 'default').slice(0, 12);
}

/**
 * Genera un esqueleto de tests sin LLM.
 */
export function buildSkeletonTests(code, frameworkId = 'vitest', filePath = 'index.js') {
  const fw = FRAMEWORKS[frameworkId] || FRAMEWORKS.vitest;
  const exports = detectExports(code);
  const moduleName = String(filePath || 'index.js').replace(/\.[^.]+$/, '').replace(/[^\w-]/g, '-');

  const header = `// Tests generados automáticamente para ${filePath}\n// Ejecutá con: npx ${frameworkId === 'node' ? 'node --test' : frameworkId} ${moduleName}${fw.extension}\n`;

  if (!exports.length) {
    return `${header}${fw.importLine}\n\ndescribe('${moduleName}', () => {\n  it('carga el módulo sin errores', async () => {\n    const mod = await import('./${moduleName}');\n    expect(mod).toBeDefined();\n  });\n});\n`;
  }

  const cases = exports
    .map((name) => {
      if (frameworkId === 'node') {
        return `  it('expone ${name}', async () => {\n    const mod = await import('./${moduleName}');\n    assert.ok(mod.${name} !== undefined || typeof mod.${name} === 'function');\n  });\n`;
      }
      return `  it('expone ${name}', async () => {\n    const mod = await import('./${moduleName}');\n    expect(mod.${name}).toBeDefined();\n  });\n`;
    })
    .join('\n');

  return `${header}${fw.importLine}\n\ndescribe('${moduleName}', () => {\n${cases}});\n`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · PROVEEDORES
   ═══════════════════════════════════════════════════════════════════════════ */

function buildInstruction(frameworkId, filePath) {
  const fw = FRAMEWORKS[frameworkId] || FRAMEWORKS.vitest;
  const assertStyle = frameworkId === 'node'
    ? 'Usá `assert.ok`, `assert.equal`, `assert.deepEqual` de node:assert/strict.'
    : 'Usá `expect(...)` de Vitest/Jest.';

  return [
    `Sos un ingeniero de QA senior. Escribí tests unitarios para el código siguiente.`,
    ``,
    `Reglas obligatorias:`,
    `1. Framework: ${fw.label}. Importá desde ${fw.importLine.split(' from ')[1] || 'vitest'}.`,
    `2. ${assertStyle}`,
    `3. Cubrí: caso feliz, casos borde (vacío, null, undefined, valores negativos) y errores.`,
    `4. Cada test debe ser independiente y determinista. No uses red, ni reloj, ni aleatoriedad sin seed.`,
    `5. Nombrá los tests con descripciones claras en español.`,
    `6. NO inventes funciones que no existan en el código.`,
    `7. Devolvé SOLO el archivo de test, sin markdown ni explicaciones.`,
    ``,
    `Archivo a testear (${filePath || 'index.js'}):`,
    '"""',
    '',
    '',
  ].join('\n');
}

async function generateWithGroq(code, frameworkId, filePath, model) {
  const key = groqKey();
  if (!key) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

  try {
    const res = await fetch(CFG.groqUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: buildInstruction(frameworkId, filePath) },
          { role: 'user', content: `${code}\n"""` },
        ],
        temperature: 0.15,
        max_tokens: 1400,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Groq ${res.status}: ${body.slice(0, 160)}`);
    }

    const data = await res.json();
    const text = String(data?.choices?.[0]?.message?.content || '').trim();
    if (!text) throw new Error('Groq devolvió una respuesta vacía.');
    return { raw: text, provider: 'groq', model };
  } finally {
    clearTimeout(timer);
  }
}

async function generateWithGemini(code, frameworkId, filePath) {
  const key = geminiKey();
  if (!key) return null;

  const model = 'GEMINI_MODEL';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

  try {
    const res = await fetch(`${CFG.geminiUrl}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildInstruction(frameworkId, filePath) }] },
        contents: [{ role: 'user', parts: [{ text: `${code}\n"""` }] }],
        generationConfig: { maxOutputTokens: 1400, temperature: 0.15 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Gemini ${res.status}: ${body.slice(0, 160)}`);
    }

    const data = await res.json();
    const text = String(data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join(' ') || '').trim();
    if (!text) throw new Error('Gemini devolvió una respuesta vacía.');
    return { raw: text, provider: 'gemini', model };
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · API PÚBLICA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Genera un archivo de tests.
 *
 * @param {object} params
 * @param {string} params.code        Código a testear
 * @param {string} [params.filePath]  Ruta del archivo
 * @param {string} [params.language]
 * @param {string} [params.framework]  'vitest' | 'jest' | 'node'
 * @returns {Promise<object>} {
 *   ok, testCode, filename, framework, provider, degraded, exports,
 *   testCount, summary
 * }
 */
export async function generateTests(params = {}) {
  const code = String(params.code || '').slice(0, CFG.maxCodeChars);
  const filePath = String(params.filePath || 'index.js');
  const frameworkId = FRAMEWORKS[params.framework] ? params.framework : 'vitest';
  const fw = FRAMEWORKS[frameworkId];

  if (!code.trim()) {
    return { ok: false, error: 'No hay código para testear.', testCode: '', framework: frameworkId };
  }

  const exports = detectExports(code);

  let result = null;
  let lastError = null;

  for (const model of CFG.groqModels) {
    try {
      result = await generateWithGroq(code, frameworkId, filePath, model);
      if (result) break;
    } catch (e) {
      lastError = e;
      LOG.warn('unit-test-writer: Groq falló', { model, error: e.message });
    }
  }

  if (!result) {
    try {
      result = await generateWithGemini(code, frameworkId, filePath);
    } catch (e) {
      lastError = e;
      LOG.warn('unit-test-writer: Gemini falló', { error: e.message });
    }
  }

  const baseName = filePath.replace(/\.[^.]+$/, '') || 'index';
  const filename = `${baseName}${fw.extension}`;

  if (!result) {
    const testCode = buildSkeletonTests(code, frameworkId, filePath);
    LOG.info('unit-test-writer: esqueleto local generado', { filename, degraded: true });
    return {
      ok: true,
      testCode,
      filename,
      framework: frameworkId,
      provider: 'local',
      degraded: true,
      detail: lastError?.message || null,
      exports,
      testCount: (testCode.match(/\bit\(/g) || []).length,
      summary: `Esqueleto con ${(testCode.match(/\bit\(/g) || []).length} casos derivados de las exportaciones detectadas.`,
    };
  }

  let testCode = stripCodeFences(result.raw);
  testCode = ensureImports(testCode, frameworkId);
  testCode = testCode.slice(0, CFG.maxTestChars);

  const testCount = (testCode.match(/\b(it|test)\s*\(/g) || []).length;

  LOG.info('unit-test-writer: tests generados', {
    provider: result.provider,
    filename,
    testCount,
  });

  return {
    ok: true,
    testCode,
    filename,
    framework: frameworkId,
    provider: result.provider,
    degraded: false,
    exports,
    testCount,
    summary: `${testCount} casos generados con ${fw.label} para ${filePath}.`,
  };
}

/**
 * Devuelve el comando exacto para correr los tests.
 */
export function getTestCommand(frameworkId, filename) {
  switch (frameworkId) {
    case 'jest': return `npx jest ${filename}`;
    case 'node': return `node --test ${filename}`;
    default: return `npx vitest run ${filename}`;
  }
}

export function getTestWriterStatus() {
  return {
    frameworks: Object.values(FRAMEWORKS).map((f) => ({ id: f.id, label: f.label })),
    providers: {
      groq: Boolean(groqKey()),
      gemini: Boolean(geminiKey()),
      local: true,
    },
    maxCodeChars: CFG.maxCodeChars,
  };
}

export default {
  generateTests,
  getTestCommand,
  getTestWriterStatus,
  stripCodeFences,
  ensureImports,
  detectExports,
  buildSkeletonTests,
  FRAMEWORKS,
};
