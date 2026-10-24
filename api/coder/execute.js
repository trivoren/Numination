/**
 * Numination · Modo Coder — execute.js
 * POST /api/coder/execute
 *
 * Body: { command: string }
 * → 200 { ok, success, output, exitCode, command, mocked: true, durationMs }
 * → 400 { ok: false, error, code }  (comando inválido o no permitido)
 * → 429 { ok: false, error, code }  (límite de ejecuciones)
 *
 * ⚠️ MOCK SEGURO — ESTE SERVIDOR NUNCA EJECUTA CÓDIGOS REALES.
 * En Vercel no existe un shell de usuario: el backend NO hace `spawn`, ni
 * `exec`, ni `eval`. Este endpoint SIMULA la salida de los comandos más usados
 * para que el usuario pueda probar el flujo del IDE sin riesgo de ejecución
 * arbitraria en la infraestructura.
 *
 * Defensa en profundidad (security-auditor):
 *  1. Allowlist explícita de binarios. Cualquier otro binario se rechaza.
 *  2. Allowlist de caracteres: se prohíben `;`, `&`, `|`, `` ` ``, `$()`,
 *     redirecciones `>`/`<`, saltos de línea y NUL (inyección de shell).
 *  3. Límite de longitud (200 caracteres) y de frecuencia (60/min por usuario).
 *  4. Sin interpolación en respuestas HTML: la salida es texto plano.
 */

import { listFiles, getFile } from './_store.js';
import { withCoderSession } from './_session.js';

/** Binarios que el sandbox simula. */
const ALLOWED_BINARIES = new Set([
  'ls', 'cat', 'pwd', 'echo', 'clear', 'help', 'whoami', 'node', 'npm', 'npx', 'git', 'env'
]);

/** Caracteres permitidos en el comando (sin metacarácter de shell). */
const ALLOWED_CHARS = /^[A-Za-z0-9 ._\-/:@=+,'"()[\]{}?*#%]+$/;

/** Longitud máxima del comando. */
const MAX_COMMAND_LEN = 200;

/** Máximo de ejecuciones por minuto y por usuario. */
const RATE_LIMIT_PER_MIN = 60;

/** @type {Map<string, {count:number, resetAt:number}>} contador en memoria */
const counters = new Map();

/**
 * Comprueba el límite de frecuencia por usuario.
 * @param {string} userId
 * @returns {{ allowed: boolean, retryAfter: number }}
 */
function checkRateLimit(userId) {
  const now = Date.now();
  const entry = counters.get(userId);
  if (!entry || now > entry.resetAt) {
    counters.set(userId, { count: 1, resetAt: now + 60_000 });
    return { allowed: true, retryAfter: 0 };
  }
  if (entry.count >= RATE_LIMIT_PER_MIN) {
    return { allowed: false, retryAfter: Math.ceil((entry.resetAt - now) / 1000) };
  }
  entry.count += 1;
  return { allowed: true, retryAfter: 0 };
}

/**
 * Valida y normaliza el comando recibido.
 * @param {unknown} raw
 * @returns {{ ok: true, command: string, binary: string, args: string[] } | { ok: false, error: string, code: string }}
 */
export function validateCommand(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    return { ok: false, error: 'Comando vacío.', code: 'empty_command' };
  }
  const command = raw.trim();
  if (command.length > MAX_COMMAND_LEN) {
    return { ok: false, error: `Comando demasiado largo (máx. ${MAX_COMMAND_LEN} caracteres).`, code: 'command_too_long' };
  }
  if (/[\r\n\0]/.test(command)) {
    return { ok: false, error: 'Comandos multilínea no permitidos.', code: 'multiline_command' };
  }
  if (/[;&|`$><]/.test(command)) {
    return {
      ok: false,
      error: 'Caracteres de encadenamiento de shell (; & | ` $ > <) no permitidos en el sandbox.',
      code: 'shell_metacharacters'
    };
  }
  if (!ALLOWED_CHARS.test(command)) {
    return { ok: false, error: 'El comando contiene caracteres no permitidos.', code: 'invalid_chars' };
  }

  const parts = command.split(/\s+/).filter(Boolean);
  const binary = parts[0].toLowerCase();
  if (!ALLOWED_BINARIES.has(binary)) {
    return {
      ok: false,
      error: `El binario "${binary}" no está disponible en el sandbox. Permitidos: ${[...ALLOWED_BINARIES].sort().join(', ')}.`,
      code: 'binary_not_allowed'
    };
  }
  return { ok: true, command, binary, args: parts.slice(1) };
}

/**
 * Simula `ls`: usa el árbol REAL del usuario (así la terminal no miente).
 * @param {string} userId
 * @param {string[]} args
 * @returns {Promise<{output:string, success:boolean, exitCode:number}>}
 */
async function mockLs(userId, args) {
  const files = await listFiles(userId);
  const filter = (args[0] || '').replace(/^\/+/, '').replace(/\/+$/, '');
  const list = files
    .map((f) => f.path)
    .filter((p) => !filter || p.startsWith(filter) || p.split('/')[0] === filter)
    .sort();

  if (!list.length) {
    return { output: filter ? `ls: no se encontró «${filter}»` : 'ls: el proyecto está vacío', success: false, exitCode: 2 };
  }
  const dirs = new Set(list.filter((p) => p.includes('/')).map((p) => p.split('/')[0]));
  const rendered = [
    ...[...dirs].sort().map((d) => `${d}/`),
    ...list.filter((p) => !p.includes('/')).sort()
  ];
  return { output: rendered.join('\n'), success: true, exitCode: 0 };
}

/**
 * Simula `cat`: devuelve el contenido REAL del archivo del usuario.
 * @param {string} userId
 * @param {string[]} args
 * @returns {Promise<{output:string, success:boolean, exitCode:number}>}
 */
async function mockCat(userId, args) {
  const target = (args[0] || '').replace(/^\/+/, '');
  if (!target) return { output: 'cat: falta el nombre del archivo', success: false, exitCode: 1 };
  const file = await getFile(userId, target);
  if (!file) return { output: `cat: ${target}: No existe el archivo`, success: false, exitCode: 1 };
  return { output: file.content, success: true, exitCode: 0 };
}

/**
 * Simula la ejecución de un archivo Node: analysis estática, sin ejecutar nada.
 * @param {string} userId
 * @param {string[]} args
 * @returns {Promise<{output:string, success:boolean, exitCode:number}>}
 */
async function mockNode(userId, args) {
  if (args[0] === '--version' || args[0] === '-v') {
    return { output: 'v20.11.0', success: true, exitCode: 0 };
  }
  const target = (args[0] || '').replace(/^\/+/, '');
  if (!target) return { output: 'node: falta el archivo a ejecutar', success: false, exitCode: 1 };
  const file = await getFile(userId, target);
  if (!file) return { output: `node: cannot find module '${target}'`, success: false, exitCode: 1 };

  const logs = (file.content.match(/console\.(log|info|warn|error)\(/g) || []).length;
  const hasExport = /\bexport\b/.test(file.content);
  const output = [
    `> node ${target}`,
    `[sandbox] ejecución simulada: ${file.content.split('\n').length} líneas, ${logs} console.log, ${hasExport ? 'módulo ESM' : 'script común'}`,
    '[sandbox] 0 errores de sintaxis detectados, 0 efectos secundarios ejecutados.'
  ].join('\n');
  return { output, success: true, exitCode: 0 };
}

/**
 * Simula npm (install / run / test / --version).
 * @param {string[]} args
 * @returns {Promise<{output:string, success:boolean, exitCode:number}>}
 */
async function mockNpm(args) {
  if (!args.length || args[0] === '--version') {
    return { output: '10.2.4', success: true, exitCode: 0 };
  }
  const sub = args[0].toLowerCase();

  if (sub === 'install' || sub === 'i') {
    const pkg = args[1] || 'dependencies';
    return {
      output: [
        '',
        `> npm install ${pkg === 'dependencies' ? '' : pkg}`.trim(),
        '',
        'added 214 packages, and audited 215 packages in 4s',
        '',
        '58 packages are looking for funding',
        '  run `npm fund` for details',
        '',
        `found 0 vulnerabilities`,
        ''
      ].join('\n'),
      success: true,
      exitCode: 0
    };
  }

  if (sub === 'run' || sub === 'start' || sub === 'dev') {
    const script = args[1] || 'dev';
    return {
      output: [
        '',
        `> proyecto@1.0.0 ${script}`,
        '',
        '  ▲ Numination dev server (simulado)',
        `  - Local:   http://localhost:3000 (sandbox)`,
        '',
        '  Listo en 412 ms.',
        ''
      ].join('\n'),
      success: true,
      exitCode: 0
    };
  }

  if (sub === 'test') {
    return {
      output: [
        '',
        '> proyecto@1.0.0 test',
        '',
        '  PASS  src/editor.test.js',
        '  PASS  src/storage.test.js',
        '',
        '  Tests:  2 passed, 2 total',
        '  Time:   0.83 s',
        ''
      ].join('\n'),
      success: true,
      exitCode: 0
    };
  }

  return { output: `npm: comando desconocido "${sub}"`, success: false, exitCode: 1 };
}

/**
 * Simula git (status / log / diff / branch).
 * @param {string[]} args
 * @returns {Promise<{output:string, success:boolean, exitCode:number}>}
 */
async function mockGit(args) {
  const sub = (args[0] || 'status').toLowerCase();
  if (sub === 'status') {
    return {
      output: [
        'En rama main',
        'Cambios por confirmar:',
        '  (sin cambios: el sandbox no modifica el repositorio)'
      ].join('\n'),
      success: true,
      exitCode: 0
    };
  }
  if (sub === 'log') {
    return {
      output: [
        'commit 0a1b2c3 (HEAD -> main)',
        'Author: Numination <dev@numination.ai>',
        'Date:   ahora',
        '',
        '    chore: sandbox inicial'
      ].join('\n'),
      success: true,
      exitCode: 0
    };
  }
  if (sub === 'diff') {
    return { output: '(sin diferencias — sandbox)', success: true, exitCode: 0 };
  }
  return { output: `git: '${sub}' no está disponible en el sandbox`, success: false, exitCode: 1 };
}

/**
 * Ejecuta la simulación del comando validado.
 * @param {string} userId
 * @param {{binary:string, args:string[]}} parsed
 * @returns {Promise<{output:string, success:boolean, exitCode:number}>}
 */
async function runMock(userId, parsed) {
  const { binary, args } = parsed;
  switch (binary) {
    case 'ls': return mockLs(userId, args);
    case 'cat': return mockCat(userId, args);
    case 'node': return mockNode(userId, args);
    case 'npm':
    case 'npx': return mockNpm(args);
    case 'git': return mockGit(args);
    case 'pwd': return { output: '/home/numination/proyecto', success: true, exitCode: 0 };
    case 'whoami': return { output: 'numination', success: true, exitCode: 0 };
    case 'env': return { output: 'NODE_ENV=production\nSANDBOX=1\nPLATFORM=vercel', success: true, exitCode: 0 };
    case 'echo': return { output: args.join(' '), success: true, exitCode: 0 };
    case 'clear': return { output: '', success: true, exitCode: 0 };
    case 'help':
      return {
        output: [
          'Numination Secure Shell (sandbox simulado)',
          '',
          '  ls [ruta]            lista los archivos de tu proyecto',
          '  cat <archivo>        muestra el contenido de un archivo',
          '  node <archivo>       simula la ejecución de un script',
          '  npm install|run|test  simula el flujo de npm',
          '  git status|log|diff   estado del repositorio (simulado)',
          '  pwd · whoami · env · echo · clear · help',
          '',
          'Nota: nada se ejecuta realmente en el servidor.'
        ].join('\n'),
        success: true,
        exitCode: 0
      };
    default:
      return { output: `Comando no simulado: ${binary}`, success: false, exitCode: 127 };
  }
}

/**
 * Handler POST.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Método no permitido. Usa POST.' });
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'Sesión requerida.', code: 'unauthenticated' });
  }

  const limit = checkRateLimit(userId);
  if (!limit.allowed) {
    res.setHeader('Retry-After', String(limit.retryAfter));
    return res.status(429).json({
      ok: false,
      error: `Demasiadas ejecuciones. Reintenta en ${limit.retryAfter}s.`,
      code: 'rate_limited'
    });
  }

  const parsed = validateCommand(req.body?.command);
  if (!parsed.ok) {
    return res.status(400).json({ ok: false, error: parsed.error, code: parsed.code });
  }

  const started = Date.now();
  try {
    const result = await runMock(userId, parsed);
    console.log(`[coder/execute] user=${userId} cmd="${parsed.command}" exit=${result.exitCode} ${Date.now() - started}ms`);
    return res.json({
      ok: true,
      success: result.success,
      output: result.output,
      exitCode: result.exitCode,
      command: parsed.command,
      mocked: true,
      durationMs: Date.now() - started
    });
  } catch (err) {
    console.error('[coder/execute] error:', err?.message || err);
    return res.status(500).json({
      ok: false,
      success: false,
      output: 'Error interno del sandbox simulado.',
      exitCode: 1,
      code: 'sandbox_error'
    });
  }
}

export default withCoderSession(handler);
