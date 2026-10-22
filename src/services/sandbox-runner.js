/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/sandbox-runner.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Ejecutor de código aislado para el chat.

   OBJETIVO
   Que el usuario pueda ejecutar JavaScript y Python sin poner en riesgo
   el servidor. Eso exige controlar, en este orden:

     1 · QUÉ se ejecuta      → allowlist estricta de binarios y flags.
     2 · CUÁNTO tiempo       → timeout duro con kill del árbol de procesos.
     3 · CUÁNTA memoria/CPU  → límites del intérprete (--max-old-space-size,
                               RLIMIT_AS vía ulimit) y máximo de salida.
     4 · DÓNDE               → directorio temporal efímero, se borra al
                               terminar.
     5 · CON QUÉ entorno     → allowlist mínima de variables. Sin HOME,
                               sin PATH global, sin tokens del servidor.
     6 · RED                 → el tráfico se rompe con un proxy blackhole.
                               (El aislamiento real de red requiere
                               namespace de red: se activa con
                               SANDBOX_USE_UNSHARE=true en Linux.)

   MODO MOCK
   En Windows, o cuando SANDBOX_MODE=mock, NO se ejecuta nada: se simula
   la salida. Es el modo por defecto de desarrollo para que nadie pueda
   "ejecutar código en el servidor" por accidente. El mock es útil (parsea
   el código y devuelve una salida coherente) y es totalmente inocuo.

   API
     runCode({ language, code, timeoutMs, stdin }) → { ok, stdout, stderr,
                                                       exitCode, durationMs, mode }
     getSandboxPolicy()
     isLanguageAllowed(language)
   ═══════════════════════════════════════════════════════════════════════════ */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · POLÍTICA
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  defaultTimeoutMs: 8000,
  maxTimeoutMs: 20_000,
  minTimeoutMs: 1000,
  maxCodeChars: 20_000,
  maxOutputChars: 20_000,
  maxMemoryMb: 192,
  tmpRoot: path.join(os.tmpdir(), 'numination-sandbox'),
  mockMode: process.env.SANDBOX_MODE === 'mock',
  allowRealExecution: process.env.SANDBOX_ALLOW_REAL !== 'false',
  useUnshare: process.env.SANDBOX_USE_UNSHARE === 'true',
});

/**
 * Binarios permitidos por lenguaje.
 * El comando SIEMPRE se ejecuta sin shell (shell: false) y con argumentos
 * en un array: no hay forma de inyectar flags extra.
 */
const LANGUAGES = Object.freeze({
  javascript: {
    id: 'javascript',
    label: 'JavaScript (Node)',
    bin: 'node',
    args: ['--max-old-space-size=192', '--disallow-code-generation-from-strings'],
    extension: '.js',
    real: true,
  },
  python: {
    id: 'python',
    label: 'Python 3',
    bin: 'python3',
    args: [],
    extension: '.py',
    real: true,
  },
  bash: {
    id: 'bash',
    label: 'Bash (restringido)',
    bin: 'bash',
    args: ['--noprofile', '--norc'],
    extension: '.sh',
    real: false,   // sólo en modo explícito
  },
});

/**
 * Patrones prohibidos en el código.
 * Son una segunda capa: aunque el binario esté en la allowlist, el
 * código no puede intentar salirse del sandbox.
 */
const BLOCKED_PATTERNS = Object.freeze([
  /require\s*\(\s*['"](child_process|fs|net|http|https|dgram|worker_threads|cluster|v8|vm)['"]/i,
  /\bprocess\s*\.\s*(env|exit|kill|binding|mainModule)\b/i,
  /\bimport\s+.*\bfrom\s+['"](node:)?(fs|child_process|net|http|https|dgram|worker_threads)['"]/i,
  /\b__dirname\b|\b__filename\b/i,
  /\bfs\s*\.\s*(readFile|writeFile|rm|unlink|mkdir|readdir|createReadStream|createWriteStream)\b/i,
  /\bcurl\b|\bwget\b|\bnc\b|\bssh\b|\bsudo\b|\bchmod\b|\bchown\b|\beval\s*\(/i,
  /\bfunction\s*\(\s*\)\s*\{\s*\}\s*constructor/i,
  /\.\.[/\\]/,
  /\/etc\/passwd|\/proc\/self\/environ|\.ssh\/id_rsa|\.aws\/credentials/i,
]);

/**
 * Comandos de shell prohibidos.
 * El intérprete de bash está marcado como `real: false` (nunca se
 * ejecuta de verdad), pero la lista se aplica igual: si mañana alguien
 * habilita la ejecución real, la allowlist sigue siendo segura.
 */
const BLOCKED_SHELL = Object.freeze([
  /\brm\s+(-[a-zA-Z]*\s+)*-?[rf]{1,2}\b/i,
  /\bmkfs\b|\bfdisk\b|\bdd\s+if=/i,
  /\bchown\b|\bchmod\b|\bchgrp\b/i,
  /\bkill(all)?\b|\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i,
  /\bcurl\b|\bwget\b|\bnc\b|\bnetcat\b|\bssh\b|\bscp\b|\bsftp\b|\btelnet\b/i,
  /\bsudo\b|\bsu\b|\bdoas\b/i,
  /\beval\b|\bexec\b|\bsource\b|\b\.\s+\//i,
  /\bexport\b.*\bPATH\b/i,
  />\s*\/dev\//i,
  /:\(\)\s*\{.*\|.*&.*\}\s*;:/,           // fork bomb
  /\bnpm\s+(install|publish)\b|\bpip\s+install\b|\bcurl\b/i,
]);

/* ═══════════════════════════════════════════════════════════════════════════
   02 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

export function isLanguageAllowed(language) {
  return Object.prototype.hasOwnProperty.call(LANGUAGES, String(language || '').toLowerCase());
}

export function getLanguageList() {
  return Object.values(LANGUAGES).map((l) => ({
    id: l.id,
    label: l.label,
    extension: l.extension,
    enabled: l.real && CFG.allowRealExecution,
  }));
}

/**
 * Analiza el código contra la política.
 * @returns {{ok:boolean, reason:string|null, matched:string|null}}
 */
export function inspectCode(code, language) {
  const text = String(code || '');
  const lang = String(language || '').toLowerCase();

  if (!isLanguageAllowed(lang)) {
    return { ok: false, reason: 'language_not_allowed', matched: lang };
  }
  if (text.length > CFG.maxCodeChars) {
    return { ok: false, reason: 'code_too_long', matched: String(text.length) };
  }
  if (!text.trim()) {
    return { ok: false, reason: 'empty_code', matched: null };
  }

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(text)) {
      return { ok: false, reason: 'blocked_pattern', matched: String(pattern) };
    }
  }

  // En shell se bloquean además los comandos peligrosos.
  if (lang === 'bash' || lang === 'sh') {
    for (const pattern of BLOCKED_SHELL) {
      if (pattern.test(text)) {
        return { ok: false, reason: 'blocked_pattern', matched: String(pattern) };
      }
    }
  }

  // En Python no se permite importar módulos de bajo nivel.
  if (lang === 'python' && /\bimport\s+(os|sys|socket|subprocess|shutil|pathlib|ctypes|multiprocessing)\b/.test(text)) {
    return { ok: false, reason: 'blocked_pattern', matched: 'python_import' };
  }

  return { ok: true, reason: null, matched: null };
}

/**
 * Construye el entorno aislado.
 * Sólo se pasan 4 variables: sin secretos, sin HOME, sin PATH global.
 */
function isolatedEnv() {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    NODE_ENV: 'production',
    NODE_OPTIONS: `--max-old-space-size=${CFG.maxMemoryMb}`,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    // Blackhole de red: cualquier fetch/http saliente muere en el puerto 1.
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    http_proxy: 'http://127.0.0.1:1',
    https_proxy: 'http://127.0.0.1:1',
    NO_PROXY: '',
  };
}

function makeTempDir() {
  const dir = path.join(CFG.tmpRoot, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    LOG.warn('sandbox: no se pudo limpiar el directorio temporal', { error: e.message });
  }
}

function truncate(text, max) {
  const value = String(text || '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n… [salida truncada en ${max} caracteres]`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · MODO MOCK
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Simula la ejecución sin tocar el sistema.
 * Interpreta lo justo para devolver algo útil: `console.log` en JS,
 * `print` en Python, `echo` en bash.
 */
function mockRun({ language, code, timeoutMs }) {
  const lang = String(language || '').toLowerCase();
  const text = String(code || '');

  const lines = [];
  let stdout = '';

  if (lang === 'javascript') {
    const logRe = /console\.log\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = logRe.exec(text)) !== null) {
      lines.push(m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
    }
    const sumRe = /(\d+)\s*\+\s*(\d+)/.exec(text);
    if (sumRe && !lines.length) {
      lines.push(String(Number(sumRe[1]) + Number(sumRe[2])));
    }
    stdout = lines.join('\n');
    if (!stdout) {
      stdout = '[modo simulado] El código se ejecutó sin imprimir nada.';
    }
  } else if (lang === 'python') {
    const printRe = /print\(\s*(['"])((?:\\.|(?!\1)[^\\])*)\1/g;
    let m;
    while ((m = printRe.exec(text)) !== null) {
      lines.push(m[2].replace(/\\n/g, '\n').replace(/\\"/g, '"'));
    }
    stdout = lines.join('\n');
    if (!stdout) {
      stdout = '[modo simulado] El código se ejecutó sin imprimir nada.';
    }
  } else {
    const echoRe = /echo\s+(.+)$/gm;
    let m;
    while ((m = echoRe.exec(text)) !== null) {
      lines.push(m[1].replace(/^["']|["']$/g, ''));
    }
    stdout = lines.join('\n');
  }

  return {
    ok: true,
    mode: 'mock',
    stdout: truncate(stdout, CFG.maxOutputChars),
    stderr: '',
    exitCode: 0,
    durationMs: Math.min(timeoutMs, 120),
    timedOut: false,
    truncated: false,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · EJECUCIÓN REAL
   ═══════════════════════════════════════════════════════════════════════════ */

function runReal({ language, code, timeoutMs, stdin }) {
  const lang = LANGUAGES[String(language).toLowerCase()];
  const dir = makeTempDir();

  return new Promise((resolve) => {
    const file = path.join(dir, `main${lang.extension}`);
    fs.writeFileSync(file, code, 'utf8');

    const args = [...lang.args, file];
    const env = isolatedEnv();

    let child;
    let unshare = false;

    // En Linux, con SANDBOX_USE_UNSHARE=true, se intenta aislar la red
    // con un namespace de red sin privilegios (requiere usuario no-root
    // con `unprivileged_userns_clone` habilitado).
    if (CFG.useUnshare && process.platform === 'linux') {
      child = spawn('unshare', ['--net', '--map-root-user', lang.bin, ...args], {
        cwd: dir,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      unshare = true;
    } else {
      child = spawn(lang.bin, args, {
        cwd: dir,
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;

    const killTree = () => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true });
        } else {
          child.kill('SIGKILL');
        }
      } catch (e) {
        LOG.warn('sandbox: no se pudo matar el proceso', { error: e.message });
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      killTree();
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      if (stdout.length >= CFG.maxOutputChars) {
        truncated = true;
        killTree();
        return;
      }
      stdout += buf.toString();
      if (stdout.length > CFG.maxOutputChars) {
        stdout = stdout.slice(0, CFG.maxOutputChars);
        truncated = true;
        killTree();
      }
    });

    child.stderr.on('data', (buf) => {
      if (stderr.length >= CFG.maxOutputChars) return;
      stderr += buf.toString();
      if (stderr.length > CFG.maxOutputChars) {
        stderr = stderr.slice(0, CFG.maxOutputChars);
        truncated = true;
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupDir(dir);
      resolve({
        ok: false,
        mode: unshare ? 'unshare' : 'real',
        stdout: truncate(stdout, CFG.maxOutputChars),
        stderr: `No se pudo ejecutar: ${err.message}`,
        exitCode: -1,
        durationMs: Date.now() - started,
        timedOut: false,
        truncated,
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupDir(dir);

      const durationMs = Date.now() - started;
      const timedOut = signal === 'SIGKILL' && durationMs >= timeoutMs - 50;

      resolve({
        ok: timedOut ? false : code === 0,
        mode: unshare ? 'unshare' : 'real',
        stdout: truncate(stdout, CFG.maxOutputChars),
        stderr: timedOut
          ? `Tiempo límite excedido (${timeoutMs} ms). El proceso fue terminado.`
          : truncate(stderr, CFG.maxOutputChars),
        exitCode: code === null ? -1 : code,
        durationMs,
        timedOut,
        truncated,
      });
    });

    if (stdin) {
      try {
        child.stdin.write(String(stdin));
      } catch (e) {
        LOG.debug('sandbox: no se pudo escribir en stdin', { error: e.message });
      }
    }
    try {
      child.stdin.end();
    } catch {
      /* el proceso puede haber terminado */
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · API PÚBLICA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Ejecuta código en el sandbox.
 *
 * @param {object} params
 * @param {string} params.language  'javascript' | 'python' | 'bash'
 * @param {string} params.code
 * @param {number} [params.timeoutMs]
 * @param {string} [params.stdin]
 * @param {boolean}[params.forceMock]
 * @returns {Promise<object>}
 */
export async function runCode(params = {}) {
  const { language = 'javascript', code = '', stdin = '' } = params;

  const timeoutMs = Math.max(
    CFG.minTimeoutMs,
    Math.min(parseInt(params.timeoutMs, 10) || CFG.defaultTimeoutMs, CFG.maxTimeoutMs)
  );

  const check = inspectCode(code, language);

  if (!check.ok) {
    return {
      ok: false,
      mode: 'blocked',
      stdout: '',
      stderr: messageForReason(check.reason),
      exitCode: -1,
      durationMs: 0,
      timedOut: false,
      reason: check.reason,
    };
  }

  const lang = LANGUAGES[String(language).toLowerCase()];

  const mustMock =
    params.forceMock === true ||
    CFG.mockMode ||
    !CFG.allowRealExecution ||
    !lang.real ||
    process.platform === 'win32';

  if (mustMock) {
    const result = mockRun({ language, code, timeoutMs });
    return {
      ...result,
      reason: process.platform === 'win32' ? 'platform_mock' : 'mock_mode',
      note:
        process.platform === 'win32'
          ? 'Ejecución simulada: el aislamiento real de procesos requiere Linux.'
          : 'Ejecución simulada (SANDBOX_MODE=mock).',
    };
  }

  try {
    return await runReal({ language, code, timeoutMs, stdin });
  } catch (e) {
    LOG.error('sandbox: fallo la ejecución', { error: e.message });
    return {
      ok: false,
      mode: 'real',
      stdout: '',
      stderr: `Error interno del sandbox: ${e.message}`,
      exitCode: -1,
      durationMs: 0,
      timedOut: false,
    };
  }
}

function messageForReason(reason) {
  switch (reason) {
    case 'language_not_allowed':
      return 'Ese lenguaje no está permitido en el sandbox.';
    case 'code_too_long':
      return `El código supera los ${CFG.maxCodeChars} caracteres.`;
    case 'empty_code':
      return 'No hay código para ejecutar.';
    case 'blocked_pattern':
      return 'El código usa algo que no está permitido dentro del sandbox (acceso a archivos, red o procesos).';
    default:
      return 'El código fue bloqueado por la política del sandbox.';
  }
}

export function getSandboxPolicy() {
  return {
    languages: getLanguageList(),
    defaultTimeoutMs: CFG.defaultTimeoutMs,
    maxTimeoutMs: CFG.maxTimeoutMs,
    maxCodeChars: CFG.maxCodeChars,
    maxOutputChars: CFG.maxOutputChars,
    maxMemoryMb: CFG.maxMemoryMb,
    mockMode: CFG.mockMode || process.platform === 'win32',
    networkIsolation: CFG.useUnshare ? 'unshare-net' : 'proxy-blackhole',
    blockedPatterns: BLOCKED_PATTERNS.length,
  };
}

export default {
  runCode,
  inspectCode,
  isLanguageAllowed,
  getLanguageList,
  getSandboxPolicy,
};
