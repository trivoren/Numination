/**
 * Numination · Modo Coder — terminal.js
 * Terminal xterm.js embebida. Ejecuta comandos en POST /api/coder/execute
 * (MOCK seguro en Vercel: el backend nunca ejecuta nada real).
 *
 * Contrato:
 *   POST /api/coder/execute  { command: string }  →
 *     { success: boolean, output: string, exitCode: number, detail?: string }
 *
 * Local: `clear`, `help`, flecha ↑/↓ (historial), Ctrl+L.
 * Colores según contrato del backend: verde = éxito, rojo = error.
 */
(function () {
  'use strict';

  const EXECUTE_URL = '/api/coder/execute';
  const MAX_OUTPUT_LINES = 4000; // corta runs infinitos en el mock

  const promptPxEl = document.getElementById('terminal-mount');
  const TAB_KEY = 'Tab';

  /** @type {import('@xterm/xterm').Terminal|null} */
  let term = null;
  let fitAddon = null;
  /** @type {string} línea parcial acumulada por teclas */
  let inputLine = '';
  /** @type {string[]} historial de comandos */
  const history = [];
  let historyIdx = -1;
  /** @type {number} cursor dentro de inputLine */
  let cursorPos = 0;
  /** @type {boolean} bloqueo mientras el backend responde */
  let running = false;
  /** @type {boolean} evita doble init */
  let initialized = false;

  const PROMPT = '\u001b[38;5;170mnumination\u001b[0m \u001b[38;5;245m~/proyecto\u001b[0m \u001b[32m$\u001b[0m ';

  /** Tema xterm alineado con los tokens de coder.css */
  const XTERM_THEME = {
    background: '#0a0a0c',
    foreground: '#e8e8f2',
    cursor: '#8b5cf6',
    cursorAccent: '#0a0a0c',
    selectionBackground: '#8b5cf655',
    green: '#34d399',
    red: '#f87171',
    brightGreen: '#6ee7b7'
  };

  /**
   * Inicializa xterm cuando su panel se muestra (xterm necesita layout real
   * para medir; si se inicia oculto, FitAddon da NaN).
   * @returns {void}
   */
  function ensureInit() {
    if (initialized || !promptPxEl) return;
    if (typeof window.Terminal === 'undefined') {
      dot('error');
      writeColored('No se pudo cargar la terminal (CDN de xterm bloqueado).', 'red');
      window.NuminToast?.error?.('No se pudo cargar la terminal (CDN).');
      return;
    }
    initialized = true;

    term = new window.Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 13,
      theme: XTERM_THEME,
      cursorBlink: true,
      scrollback: 2000,
      convertEol: true
    });
    fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(promptPxEl);

    const fit = () => { try { fitAddon.fit(); } catch { /* panel aún sin tamaño */ } };
    new ResizeObserver(fit).observe(promptPxEl);

    term.onData(onTerminalData);
    printBanner();
    drawPrompt();
    fit();                                        // medir tras el primer print
    dot('ready');
    window.eventBus?.emit('term:ready', {});
  }

  /** Banner inicial del mock (idéntico a la salida de execute --help). */
  function printBanner() {
    term.writeln('\u001b[38;5;245mNumination Secure Shell (sandbox simulado · Vercel)\u001b[0m');
    term.writeln('\u001b[38;5;245mComandos: ls · ls <dir> · cat <archivo> · npm install | run | test · node <archivo> · pwd · help · clear\u001b[0m');
    term.writeln('');
  }

  function drawPrompt() { term.write('\r\n' + PROMPT); }

  /** Redibuja la línea actual con el cursor en su posición. */
  function repaint() {
    const tail = inputLine.slice(cursorPos);
    const head = inputLine.slice(0, cursorPos);
    term.write('\r\u001b[K' + PROMPT + head + tail); // \u001b[K limpia hasta el final
    if (tail) term.write('\u001b[' + tail.length + 'D'); // el cursor regresa al final del texto restante
  }

  /**
   * Entrada cruda de teclado (solo caracteres imprimibles y especiales capturados aquí).
   * @param {string} data
   */
  function onTerminalData(data) {
    if (running) return; // sin eco mientras viaja el comando
    const buffer = data;

    if (buffer === '\r') { submitLine(); return; }                 // Enter
    if (buffer === '\u007f') {                                     // Backspace
      if (cursorPos > 0) {
        inputLine = inputLine.slice(0, cursorPos - 1) + inputLine.slice(cursorPos);
        cursorPos--;
        term.write('\b');
        term.write(inputLine.slice(cursorPos));
        term.write(' ');
        term.write('\u001b[' + (inputLine.length - cursorPos + 1) + 'D');
      }
      return;
    }
    if (buffer === '\u001b[A') { moveHistory(+1); return; }        // ↑
    if (buffer === '\u001b[B') { moveHistory(-1); return; }        // ↓
    if (buffer === '\u000c') { term.clear(); repaintSoft(); return; } // Ctrl+L
    if (buffer === TAB_KEY) return;                                // Tab: sin inferencia (mock)

    if (buffer === '\u001b[C' || buffer === '\u001b[D') {          // →/←: mover cursor
      if (buffer === '\u001b[D' && cursorPos > 0) {
        cursorPos--;
        term.write('\u001b[D');
      } else if (buffer === '\u001b[C' && cursorPos < inputLine.length) {
        cursorPos++;
        term.write('\u001b[C');
      }
      return;
    }

    if (buffer >= ' ' && buffer <= '\u007e' || buffer.charCodeAt(0) >= 160) {
      // Caracteres imprimibles / acentos: inserción en posición de cursor
      if (cursorPos === inputLine.length) {
        inputLine += buffer;
        term.write(buffer);
      } else {
        inputLine = inputLine.slice(0, cursorPos) + buffer + inputLine.slice(cursorPos);
        repaint();
      }
      cursorPos++;
      return;
    }
  }

  function repaintSoft() { inputLine = ''; cursorPos = 0; drawPrompt(); }

  /** Recupera/desplaza en el historial. */
  function moveHistory(dir) {
    if (!history.length) return;
    historyIdx += dir;
    historyIdx = Math.max(-1, Math.min(history.length - 1, historyIdx));
    const codeLine = historyIdx === -1 ? '' : history[history.length - 1 - historyIdx];
    inputLine = codeLine;
    cursorPos = inputLine.length;
    repaint();
  }

  /** Enter → envía al backend (o maneja comando local). */
  function submitLine() {
    const command = inputLine.trim();
    inputLine = '';
    cursorPos = 0;
    term.write('\r\n');

    if (!command) { drawPrompt(); return; }
    history.push(command);
    historyIdx = -1;

    if (command === 'clear') { term.clear(); repaintSoft(); return; }
    if (command === 'help')  { printBanner(); drawPromptSoft(); return; }
    executeRemote(command);
  }

  function drawPromptSoft() { drawPrompt(); }

  /**
   * Estado del indicador del punto en la barra + pestaña de Terminal.
   * CSS premium define: is-ready (violeta) · is-running (verde pulso) ·
   * is-error (rojo). Elementos: #terminal-dot (toolbar) y dot de la pestaña.
   * @param {'ready'|'running'|'error'} state
   */
  function dot(state) {
    const targets = [document.getElementById('terminal-dot')];
    const tabDot = document.querySelector('#tab-terminal .assistant-tabs__dot');
    if (tabDot) targets.push(tabDot);
    for (const el of targets) {
      if (!el) continue;
      el.classList.toggle('is-ready', state === 'ready');
      el.classList.toggle('is-running', state === 'running');
      el.classList.toggle('is-error', state === 'error');
    }
  }

  /**
   * MOCK LOCAL de emergencia: si /api/coder/execute no responde (red caída,
   * 5xx), la terminal NO se queda muda. Simula los comandos más habituales
   * con salida verde/rojo, marcando el origen con una nota tenue.
   * @param {string} command
   * @returns {void}
   */
  function runLocalMock(command) {
    const lower = command.toLowerCase();
    const note = '\u001b[90m(mock local · el servidor de ejecución no respondió)\u001b[0m';
    let out = '';
    let ok = true;

    if (lower === 'help') out = 'Comandos: ls · cat <archivo> · npm install | run | test · node <archivo> · pwd · whoami · env · git status · clear';
    else if (lower === 'pwd') out = '~/proyecto';
    else if (lower === 'whoami') out = 'usuario numination (sandbox local)';
    else if (lower === 'env') out = 'NODE_ENV=sandbox\nMOCK=true';
    else if (lower === 'npm install' || lower === 'npm i' || lower === 'npm ci') {
      out = 'added 0 packages in 0.4s\n17 packages are looking for funding\nrun `npm fund` for details';
    } else if (lower === 'npm test' || lower === 'npm run test') {
      out = '> mock-runner\nPASS (3 pruebas simuladas)';
    } else if (lower === 'npm run' || lower === 'npm run dev' || lower === 'npm start') {
      out = 'Sandbox iniciado (simulación). No se ejecutan procesos reales.';
    } else if (lower === 'git status') {
      out = 'On branch main\nnothing to commit, working tree clean';
    } else if (lower === 'ls' || lower.startsWith('ls ')) {
      out = ['index.js', 'components/', 'styles/', 'README.md'].join('  ');
    } else if (lower.startsWith('cat ') || lower.startsWith('node ')) {
      out = `El contenido de “${command.split(' ').slice(1).join(' ')}” no está disponible sin conexión con el servidor.`;
      ok = false;
    } else {
      ok = false;
      out = `comando no reconocido en el mock local: ${command}`;
    }

    writeColored(out, ok ? 'green' : 'red');
    writeColored(note, 'dim');
  }

  /**
   * POST al backend mock. Colores: verde éxito, rojo fallo.
   * @param {string} command
   * @returns {Promise<void>}
   */
  async function executeRemote(command) {
    running = true;
    dot('running');
    try {
      const body = window.NumAPI
        ? await window.NumAPI.post(EXECUTE_URL, { command }, { silent: true })
        : await (async () => {
            const res = await fetch(EXECUTE_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ command })
            });
            const data = await res.json().catch(() => null);
            if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
            return data;
          })();

      if (!body || typeof body.output !== 'string') {
        writeColored('Respuesta malformada del servidor (falta `output`).', 'red');
      } else if (body.success) {
        writeColored(body.output, 'green');
      } else {
        writeColored(body.output, 'red');
        if (body.detail) writeColored(body.detail, 'dim');
      }
      dot('ready');
    } catch (err) {
      dot('error');
      const status = err?.status;
      const code = err?.code || '';
      if (Number(status) === 401 || err?.message?.includes('Sesión requerida')) {
        writeColored('Sesión requerida: iniciá sesión para ejecutar comandos en el sandbox.', 'red');
      } else if (code === 'network_error' || code === 'timeout' || Number(status) >= 500) {
        // Backend caído → simulación local para que la terminal siga viva.
        runLocalMock(command);
      } else {
        writeColored('Error: ' + (err?.message || 'desconocido'), 'red');
      }
      window.NuminToast?.error?.('La terminal no pudo ejecutar el comando.');
      setTimeout(() => { if (!running) dot('ready'); }, 2200);
    } finally {
      running = false;
      window.eventBus.emit('term:command', { command, done: true });
      drawPrompt();
    }
  }

  /**
   * Escritura con color y límite de líneas.
   * @param {string} text
   * @param {'green'|'red'|'dim'|'plain'} color
   * @param {boolean} [isHttpError]
   */
  function writeColored(text, color, isHttpError) {
    const codes = { green: '32', red: '31', dim: '90', plain: '0' };
    const ansi = `\u001b[${codes[color] || codes.plain}m`;
    const linesArr = String(text).split('\n');
    if (linesArr.length > MAX_OUTPUT_LINES) {
      linesArr.length = MAX_OUTPUT_LINES;
      linesArr.push('… (truncado en el cliente)');
    }
    for (const ln of linesArr) term.writeln(ansi + ln + '\u001b[0m');
    if (isHttpError) term.writeln('');
  }

  /* ═══ Arranque: xterm necesita estar visible → init bajo demanda ═══
     Se coordina por DOS vías para que nunca quede muerta:
       1. clic directo en la pestaña "Terminal" (esta página).
       2. evento `assistant:tab` emitido por el controlador de pestañas. */
  const terminalPanel = document.getElementById('panel-terminal');
  const tabTerminal = document.getElementById('tab-terminal');
  if (tabTerminal && terminalPanel) {
    tabTerminal.addEventListener('click', () => {
      requestAnimationFrame(activateWhenVisible); // layout listo en el siguiente frame
    });
  }
  window.eventBus?.on?.('assistant:tab', (data) => {
    if (data?.id !== 'terminal') return;
    requestAnimationFrame(activateWhenVisible);
  });
  // Fallback: algunos usuarios entran con la terminal abierta por hash.
  if (window.location.hash === '#terminal') ensureInit();

  /** Si el panel de terminal ya es visible: init + fit + focus.
     Si aún sigue oculto (transición de pestaña), no-op hasta el próximo
     `assistant:tab`. Así la terminal nunca arranca sin layout real. */
  function activateWhenVisible() {
    if (terminalPanel?.hidden) return;
    ensureInit();
    try { fitAddon?.fit(); } catch { /* sin layout */ }
    try { term?.focus(); } catch { /* sin init */ }
  }

  /* API pública mínima para el shell de coder.html (pestañas, toolbar). */
  window.NuminTerminal = {
    /** Garantiza init (necesita panel visible) + fit + focus. */
    activate() { activateWhenVisible(); },
    focus() { try { term?.focus(); } catch { /* sin init */ } },
    clear() {
      if (!term) return;
      try {
        term.reset();
        inputLine = '';
        cursorPos = 0;
        printBanner();
        drawPrompt();
        term.focus();
      } catch { /* sin init */ }
    },
    isReady() { return initialized; },
  };
})();
