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
      window.NuminToast.error('No se pudo cargar la terminal (CDN).');
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
   * POST al backend mock. Colores: verde éxito, rojo fallo.
   * @param {string} command
   * @returns {Promise<void>}
   */
  async function executeRemote(command) {
    running = true;
    try {
      const body = window.NumAPI
        ? await window.NumAPI.post(EXECUTE_URL, { command }, { silent: true })
        : await (async () => {
            const res = await fetch(EXECUTE_URL, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
              credentials: 'same-origin',
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
    } catch (err) {
      writeColored('Error de red: ' + err.message, 'red');
      window.NuminToast.error('La terminal no pudo ejecutar el comando.');
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

  /* ═══ Arranque: xterm necesita estar visible → init bajo demanda ═══ */
  const terminalPanel = document.getElementById('panel-terminal');
  const tabTerminal = document.getElementById('tab-terminal');
  if (tabTerminal && terminalPanel) {
    tabTerminal.addEventListener('click', () => {
      requestAnimationFrame(ensureInit); // layout listo en el siguiente frame
    });
  }
  // Fallback: algunos usuarios entran con la terminal abierta por hash.
  if (window.location.hash === '#terminal') ensureInit();
})();
