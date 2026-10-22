/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · sandbox-ui.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Editor de código con consola dentro del chat.

   Qué hace:
     · Editor multi-lenguaje (JavaScript / Python / Bash).
     · Botón "Ejecutar" (y Ctrl/Cmd + Enter) que llama a /api/sandbox/run.
     · Consola con salida verde (stdout), errores en rojo (stderr) y el
       código de salida como badge.
     · Indicador de "en ejecución" con spinner y botón cancelar.
     · Historial de las últimas ejecuciones en la misma sesión.

   Montaje:
     window.NumSandboxUI.mount('#sandbox-panel')   ← cualquier contenedor
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const state = {
    root: null,
    editor: null,
    output: null,
    status: null,
    runBtn: null,
    language: 'javascript',
    running: false,
    controller: null,
    history: [],
  };

  const SNIPPETS = {
    javascript: [
      'const numeros = [3, 1, 4, 1, 5, 9, 2, 6];',
      'const pares = numeros.filter((n) => n % 2 === 0);',
      'console.log("Números pares:", pares.join(", "));',
      'console.log("Suma total:", numeros.reduce((a, b) => a + b, 0));',
    ].join('\n'),
    python: [
      'def es_primo(n):',
      '    if n < 2:',
      '        return False',
      '    for i in range(2, int(n ** 0.5) + 1):',
      '        if n % i == 0:',
      '            return False',
      '    return True',
      '',
      'primos = [n for n in range(2, 30) if es_primo(n)]',
      'print("Primos:", primos)',
    ].join('\n'),
    bash: [
      'echo "Hola desde el sandbox"',
      'for i in 1 2 3 4 5; do',
      '  echo "línea $i"',
      'done',
    ].join('\n'),
  };

  /* ─── Utilidades ────────────────────────────────────────────────────── */

  const $ = (sel) => document.querySelector(sel);

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((key) => {
        if (key === 'class') node.className = attrs[key];
        else if (key === 'text') node.textContent = attrs[key];
        else if (key === 'html') node.innerHTML = attrs[key];
        else if (key === 'style') node.setAttribute('style', attrs[key]);
        else if (key.startsWith('on') && typeof attrs[key] === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
        } else if (attrs[key] !== null && attrs[key] !== undefined) {
          node.setAttribute(key, attrs[key]);
        }
      });
    }
    (children || []).forEach((child) => {
      if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function toast(message, kind = 'info') {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
      return;
    }
    console.info('[sandbox-ui]', kind, message);
  }

  async function api(path, options = {}) {
    const { method = 'GET', body, signal } = options;

    if (window.NumAPI && typeof window.NumAPI.request === 'function') {
      return window.NumAPI.request(path, { method, body, signal });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
      }
      if (!res.ok) {
        const err = new Error(payload?.error || `Error ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ─── Render ────────────────────────────────────────────────────────── */

  function setStatus(text, kind = 'idle') {
    if (!state.status) return;
    state.status.className = `sandbox-status sandbox-status--${kind}`;
    state.status.textContent = text;
  }

  function renderOutput(result) {
    if (!state.output) return;

    state.output.innerHTML = '';

    if (!result) {
      state.output.appendChild(el('div', { class: 'sandbox-console__empty', text: 'Ejecutá el código para ver la salida.' }));
      return;
    }

    const meta = el('div', { class: 'sandbox-console__meta' }, [
      el('span', {
        class: `sandbox-badge sandbox-badge--${result.exitCode === 0 ? 'ok' : 'err'}`,
        text: `exit ${result.exitCode}`,
      }),
      el('span', { class: 'sandbox-console__time', text: `${result.durationMs} ms` }),
      result.mode && result.mode !== 'real' ? el('span', { class: 'sandbox-badge sandbox-badge--muted', text: result.mode }) : null,
      result.timedOut ? el('span', { class: 'sandbox-badge sandbox-badge--warn', text: 'timeout' }) : null,
    ]);

    state.output.appendChild(meta);

    if (result.note) {
      state.output.appendChild(el('div', { class: 'sandbox-console__note', text: result.note }));
    }

    if (result.stdout) {
      state.output.appendChild(el('pre', { class: 'sandbox-console__out', text: result.stdout }));
    }

    if (result.stderr) {
      state.output.appendChild(el('pre', { class: 'sandbox-console__err', text: result.stderr }));
    }

    if (!result.stdout && !result.stderr) {
      state.output.appendChild(el('div', { class: 'sandbox-console__empty', text: 'Sin salida.' }));
    }
  }

  /* ─── Ejecución ─────────────────────────────────────────────────────── */

  async function run() {
    if (state.running) return;

    const code = state.editor ? state.editor.value : '';
    if (!code.trim()) {
      toast('Escribí algo de código primero.', 'error');
      return;
    }

    state.running = true;
    state.runBtn.disabled = true;
    state.runBtn.textContent = 'Ejecutando…';
    setStatus('ejecutando…', 'run');
    renderOutput(null);

    const controller = new AbortController();
    state.controller = controller;

    const started = performance.now();

    try {
      const data = await api('/api/sandbox/run', {
        method: 'POST',
        body: { language: state.language, code },
        signal: controller.signal,
      });

      const result = data?.result || {};
      renderOutput(result);

      state.history.unshift({
        language: state.language,
        ok: Boolean(data?.ok),
        exitCode: result.exitCode,
        durationMs: result.durationMs || Math.round(performance.now() - started),
        at: Date.now(),
      });
      state.history = state.history.slice(0, 10);

      setStatus(data?.ok ? 'ok' : 'error', data?.ok ? 'ok' : 'err');
    } catch (e) {
      const message = e?.message || 'No se pudo ejecutar el código.';
      renderOutput({
        stdout: '',
        stderr: message,
        exitCode: -1,
        durationMs: Math.round(performance.now() - started),
        mode: 'error',
      });
      setStatus('error', 'err');
      toast(message, 'error');
    } finally {
      state.running = false;
      state.controller = null;
      if (state.runBtn) {
        state.runBtn.disabled = false;
        state.runBtn.textContent = 'Ejecutar';
      }
    }
  }

  function cancel() {
    if (state.controller) {
      state.controller.abort();
      state.controller = null;
      setStatus('cancelado', 'warn');
    }
  }

  /* ─── Montaje ───────────────────────────────────────────────────────── */

  function build() {
    const editor = el('textarea', {
      class: 'sandbox-editor__code',
      spellcheck: 'false',
      autocomplete: 'off',
      autocapitalize: 'off',
      placeholder: '// Escribí tu código acá',
    });
    editor.value = SNIPPETS.javascript;
    state.editor = editor;

    const language = el('select', { class: 'sandbox-editor__lang' }, [
      el('option', { value: 'javascript', text: 'JavaScript' }),
      el('option', { value: 'python', text: 'Python' }),
      el('option', { value: 'bash', text: 'Bash' }),
    ]);
    language.addEventListener('change', () => {
      state.language = language.value;
      editor.value = SNIPPETS[state.language] || '';
      setStatus('listo', 'idle');
    });

    const runBtn = el('button', { class: 'sandbox-btn sandbox-btn--primary', type: 'button', text: 'Ejecutar' });
    runBtn.addEventListener('click', run);
    state.runBtn = runBtn;

    const clearBtn = el('button', { class: 'sandbox-btn', type: 'button', text: 'Limpiar' });
    clearBtn.addEventListener('click', () => {
      editor.value = '';
      renderOutput(null);
      setStatus('listo', 'idle');
      editor.focus();
    });

    const cancelBtn = el('button', { class: 'sandbox-btn sandbox-btn--ghost', type: 'button', text: 'Cancelar' });
    cancelBtn.addEventListener('click', cancel);
    cancelBtn.hidden = true;

    const status = el('div', { class: 'sandbox-status sandbox-status--idle', text: 'listo' });
    state.status = status;

    const output = el('div', { class: 'sandbox-console' });
    state.output = output;
    renderOutput(null);

    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        run();
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = `${editor.value.slice(0, start)}  ${editor.value.slice(end)}`;
        editor.selectionStart = editor.selectionEnd = start + 2;
      }
    });

    const root = el('div', { class: 'sandbox-panel' }, [
      el('div', { class: 'sandbox-head' }, [
        el('div', { class: 'sandbox-head__title', text: 'Consola' }),
        el('div', { class: 'sandbox-head__actions' }, [status, language]),
      ]),
      el('div', { class: 'sandbox-editor' }, [
        editor,
        el('div', { class: 'sandbox-editor__bar' }, [
          runBtn,
          cancelBtn,
          clearBtn,
          el('span', { class: 'sandbox-hint', text: 'Ctrl + Enter para ejecutar' }),
        ]),
      ]),
      output,
    ]);

    return root;
  }

  function mount(target) {
    const container = typeof target === 'string' ? $(target) : target;
    if (!container) return null;
    if (state.root && state.root.isConnected) return state.root;

    state.root = build();
    container.appendChild(state.root);

    // Botón de cancelar visible sólo durante la ejecución.
    const originalRun = run;
    state.root.querySelector('.sandbox-editor__bar').addEventListener('click', (e) => {
      const btn = e.target.closest('.sandbox-btn');
      if (!btn) return;
      const cancelBtn = state.root.querySelector('.sandbox-btn--ghost');
      if (btn.textContent === 'Ejecutar') cancelBtn.hidden = false;
      if (btn.textContent === 'Limpiar') cancelBtn.hidden = true;
    });

    void originalRun;

    return state.root;
  }

  /* ─── API pública ───────────────────────────────────────────────────── */

  window.NumSandboxUI = {
    mount,
    run,
    cancel,
    get history() { return state.history.slice(); },
    get running() { return state.running; },
  };

  document.addEventListener('DOMContentLoaded', () => {
    const target = document.getElementById('sandbox-panel') || document.getElementById('code-console');
    if (target) mount(target);
  });
})();
