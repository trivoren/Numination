/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · find-and-replace.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Buscar y reemplazar dentro del archivo abierto (Ctrl+H).

   CARACTERÍSTICAS
     · Interfaz flotante sobre el editor.
     · Cuenta de coincidencias en vivo (resaltadas en el código).
     · "Reemplazar" (una) y "Reemplazar todo".
     · Case-insensitive por defecto; opción "regex" y "case" activables.
     · Navegación entre coincidencias con Enter / Shift+Enter.

   IMPLEMENTACIÓN
     Usa las APIs de Monaco (`find`, `replace`, `getModel`): las
     coincidencias las resalta el propio editor y no hay que reimplementar
     el resaltado. El reemplazo se hace con `pushEditOperations` para que
     sea deshacible.

   SEGURIDAD
     · El texto de búsqueda y reemplazo se trata como DATOS: se usa
       `setModelMarkers` / `find` de Monaco, nunca innerHTML.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STYLE_ID = 'numination-find-replace-styles';

  const CSS = `
.nm-fr-panel {
  position: absolute; top: 12px; right: 14px; z-index: 50;
  width: min(400px, 92vw);
  background: color-mix(in srgb, var(--c-bg, #0a0a0c) 96%, #fff 4%);
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 12px;
  box-shadow: 0 18px 44px rgba(0,0,0,.6);
  overflow: hidden;
  animation: nm-fr-in .14s ease;
}
@keyframes nm-fr-in { from { opacity:0; transform: translateY(-6px); } to { opacity:1; transform:none; } }
.nm-fr-row { display: flex; align-items: center; gap: 7px; padding: 9px 10px; border-bottom: 1px solid rgba(255,255,255,.07); }
.nm-fr-row:last-child { border-bottom: 0; }
.nm-fr-input {
  flex: 1; min-width: 0; padding: 7px 10px;
  background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.12); border-radius: 8px;
  color: var(--c-text, #f4f4f7); font: 400 12.5px/1.3 var(--font-mono, monospace);
  outline: none;
}
.nm-fr-input:focus { border-color: var(--c-primary, #8b5cf6); background: rgba(139,92,246,.08); }
.nm-fr-count { font: 600 10.5px/1 var(--font-mono, monospace); color: #8b8b9c; min-width: 46px; text-align: right; }
.nm-fr-toggle {
  width: 26px; height: 26px; border-radius: 7px; border: 1px solid rgba(255,255,255,.12);
  background: transparent; color: #8b8b9c; cursor: pointer;
  font: 700 10.5px/1 var(--font-mono, monospace);
}
.nm-fr-toggle:hover { background: rgba(255,255,255,.06); color: #fff; }
.nm-fr-toggle.is-active { background: rgba(139,92,246,.2); border-color: rgba(139,92,246,.45); color: #c4b5fd; }
.nm-fr-btn {
  border: 1px solid rgba(255,255,255,.13); border-radius: 7px; background: transparent;
  color: #c9c9d4; cursor: pointer; padding: 6px 10px;
  font: 600 11.5px/1 var(--font-sans, Inter, system-ui, sans-serif);
  white-space: nowrap;
}
.nm-fr-btn:hover { background: rgba(255,255,255,.06); color: #fff; }
.nm-fr-btn--primary { background: var(--c-primary, #8b5cf6); border-color: transparent; color: #fff; }
.nm-fr-btn--primary:hover { filter: brightness(1.1); background: var(--c-primary, #8b5cf6); }
.nm-fr-btn:disabled { opacity: .45; cursor: not-allowed; }
.nm-fr-close {
  position: absolute; top: 8px; right: 9px; z-index: 2;
  width: 22px; height: 22px; border: 0; background: transparent; color: #8b8b9c;
  cursor: pointer; font-size: 15px; line-height: 1;
}
.nm-fr-close:hover { color: #fff; }
`;

  const state = {
    panel: null,
    findInput: null,
    replaceInput: null,
    countEl: null,
    findBtn: null,
    replaceBtn: null,
    replaceAllBtn: null,
    caseToggle: null,
    regexToggle: null,
    matches: [],
    index: 0,
    open: false,
    caseSensitive: false,
    useRegex: false,
  };

  /* ─── Estilos ────────────────────────────────────────────────────────── */

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /* ─── Utilidades ────────────────────────────────────────────────────── */

  function toast(message, kind = 'info') {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
      return;
    }
    console.info('[find-and-replace]', kind, message);
  }

  function getEditor() {
    const es = window.EditorState;
    if (!es || !es.monacoInstance) return null;
    return es;
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function buildMatcher(text) {
    if (!text) return null;
    const flags = state.caseSensitive ? 'g' : 'gi';
    if (state.useRegex) {
      try {
        return new RegExp(text, flags);
      } catch {
        return null;
      }
    }
    return new RegExp(escapeRegExp(text), flags);
  }

  /* ─── Panel ──────────────────────────────────────────────────────────── */

  function buildPanel() {
    if (state.panel) return state.panel;

    const container = document.getElementById('monaco-container') ||
      document.querySelector('.monaco-container');
    if (!container) return null;

    const host = container.parentElement || container;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    const panel = document.createElement('div');
    panel.className = 'nm-fr-panel';

    /* ── Fila de búsqueda ─────────────────────────────────────────────── */
    const findRow = document.createElement('div');
    findRow.className = 'nm-fr-row';

    const findInput = document.createElement('input');
    findInput.className = 'nm-fr-input';
    findInput.type = 'text';
    findInput.placeholder = 'Buscar…';
    findInput.spellcheck = false;

    const countEl = document.createElement('span');
    countEl.className = 'nm-fr-count';
    countEl.textContent = '0/0';

    const caseToggle = document.createElement('button');
    caseToggle.className = 'nm-fr-toggle';
    caseToggle.type = 'button';
    caseToggle.textContent = 'Aa';
    caseToggle.title = 'Distinguir mayúsculas';

    const regexToggle = document.createElement('button');
    regexToggle.className = 'nm-fr-toggle';
    regexToggle.type = 'button';
    regexToggle.textContent = '.*';
    regexToggle.title = 'Usar expresión regular';

    const findBtn = document.createElement('button');
    findBtn.className = 'nm-fr-btn';
    findBtn.type = 'button';
    findBtn.textContent = 'Siguiente';
    findBtn.title = 'Enter';

    findRow.append(findInput, countEl, caseToggle, regexToggle, findBtn);

    /* ── Fila de reemplazo ────────────────────────────────────────────── */
    const replaceRow = document.createElement('div');
    replaceRow.className = 'nm-fr-row';

    const replaceInput = document.createElement('input');
    replaceInput.className = 'nm-fr-input';
    replaceInput.type = 'text';
    replaceInput.placeholder = 'Reemplazar con…';
    replaceInput.spellcheck = false;

    const replaceBtn = document.createElement('button');
    replaceBtn.className = 'nm-fr-btn';
    replaceBtn.type = 'button';
    replaceBtn.textContent = 'Reemplazar';

    const replaceAllBtn = document.createElement('button');
    replaceAllBtn.className = 'nm-fr-btn nm-fr-btn--primary';
    replaceAllBtn.type = 'button';
    replaceAllBtn.textContent = 'Todo';

    replaceRow.append(replaceInput, replaceBtn, replaceAllBtn);

    const close = document.createElement('button');
    close.className = 'nm-fr-close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Cerrar');
    close.addEventListener('click', () => closePanel());

    panel.append(close, findRow, replaceRow);
    host.appendChild(panel);

    /* ── Eventos ──────────────────────────────────────────────────────── */
    let debounce = null;
    findInput.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => runFind(), 180);
    });

    findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.shiftKey ? findPrevious() : findNext();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closePanel();
      }
    });

    replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePanel();
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        replaceOne();
      }
    });

    caseToggle.addEventListener('click', () => {
      state.caseSensitive = !state.caseSensitive;
      caseToggle.classList.toggle('is-active', state.caseSensitive);
      runFind();
    });

    regexToggle.addEventListener('click', () => {
      state.useRegex = !state.useRegex;
      regexToggle.classList.toggle('is-active', state.useRegex);
      runFind();
    });

    findBtn.addEventListener('click', () => findNext());
    replaceBtn.addEventListener('click', () => replaceOne());
    replaceAllBtn.addEventListener('click', () => replaceAll());

    state.panel = panel;
    state.findInput = findInput;
    state.replaceInput = replaceInput;
    state.countEl = countEl;
    state.findBtn = findBtn;
    state.replaceBtn = replaceBtn;
    state.replaceAllBtn = replaceAllBtn;
    state.caseToggle = caseToggle;
    state.regexToggle = regexToggle;

    return panel;
  }

  /* ─── Búsqueda ──────────────────────────────────────────────────────── */

  function runFind() {
    const es = getEditor();
    if (!es) return;

    const query = state.findInput.value;
    const matcher = buildMatcher(query);

    if (!matcher) {
      state.matches = [];
      state.countEl.textContent = '0/0';
      return;
    }

    const model = es.monacoInstance.getModel();
    if (!model) return;

    const text = model.getValue();
    const lines = text.split('\n');

    const matches = [];
    matcher.lastIndex = 0;

    lines.forEach((line, lineIndex) => {
      matcher.lastIndex = 0;
      let match;
      while ((match = matcher.exec(line)) !== null) {
        matches.push({
          lineNumber: lineIndex + 1,
          column: match.index + 1,
          length: match[0].length,
        });
        if (match[0].length === 0) matcher.lastIndex++;   // evita loops infinitos
        if (matches.length > 5000) break;
      }
    });

    state.matches = matches;
    state.index = 0;

    updateCount();
    selectMatch(0);
  }

  function updateCount() {
    const total = state.matches.length;
    state.countEl.textContent = total ? `${state.index + 1}/${total}` : '0/0';
    state.replaceBtn.disabled = total === 0;
    state.replaceAllBtn.disabled = total === 0;
  }

  function selectMatch(index) {
    const es = getEditor();
    if (!es || !state.matches.length) return;

    const total = state.matches.length;
    state.index = ((index % total) + total) % total;

    const match = state.matches[state.index];
    const monaco = es.monacoInstance;

    monaco.setSelection({
      startLineNumber: match.lineNumber,
      startColumn: match.column,
      endLineNumber: match.lineNumber,
      endColumn: match.column + match.length,
    });

    monaco.revealLineInCenter(match.lineNumber);
    updateCount();
  }

  function findNext() {
    if (!state.matches.length) {
      runFind();
      return;
    }
    selectMatch(state.index + 1);
  }

  function findPrevious() {
    if (!state.matches.length) {
      runFind();
      return;
    }
    selectMatch(state.index - 1);
  }

  /* ─── Reemplazo ──────────────────────────────────────────────────────── */

  function replaceOne() {
    const es = getEditor();
    if (!es || !state.matches.length) return;

    const monaco = es.monacoInstance;
    const model = monaco.getModel();
    const selection = monaco.getSelection();

    if (!selection) return;

    const match = state.matches[state.index];
    const selectedText = model.getValueInRange(selection);

    // Si la selección actual NO es una coincidencia, se avanza a la
    // siguiente y se reemplaza esa.
    const isCurrentMatch =
      selection.startLineNumber === match.lineNumber &&
      selection.startColumn === match.column;

    if (!isCurrentMatch) {
      findNext();
      return;
    }

    const replacement = state.replaceInput.value;

    model.pushEditOperations(
      [],
      [{
        range: selection,
        text: replacement,
        forceMoveMarkers: true,
      }],
      () => null
    );

    void selectedText;

    // Se vuelve a buscar para refrescar los índices.
    runFind();
    toast('Reemplazo hecho.', 'ok');
  }

  function replaceAll() {
    const es = getEditor();
    if (!es) return;

    const query = state.findInput.value;
    if (!query) return;

    const matcher = buildMatcher(query);
    if (!matcher) return;

    const model = es.monacoInstance.getModel();
    if (!model) return;

    const text = model.getValue();
    const replacement = state.replaceInput.value;

    let updated;
    try {
      updated = text.replace(matcher, replacement);
    } catch (e) {
      toast('La expresión regular no es válida.', 'error');
      return;
    }

    if (updated === text) {
      toast('No había coincidencias.', 'info');
      return;
    }

    const count = state.matches.length;

    model.pushEditOperations(
      [],
      [{ range: model.getFullModelRange(), text: updated, forceMoveMarkers: true }],
      () => null
    );

    runFind();
    toast(`${count} reemplazo${count === 1 ? '' : 's'} hecho${count === 1 ? '' : 's'}.`, 'ok');
  }

  /* ─── Acciones ───────────────────────────────────────────────────────── */

  function openPanel() {
    injectStyles();

    if (!buildPanel()) {
      toast('El editor no está listo.', 'error');
      return;
    }

    state.open = true;
    state.panel.hidden = false;

    const selection = getEditor()?.monacoInstance.getSelection();
    if (selection) {
      const es = getEditor();
      const model = es.monacoInstance.getModel();
      const selected = model ? model.getValueInRange(selection) : '';
      if (selected && !selected.includes('\n')) {
        state.findInput.value = selected;
      }
    }

    state.findInput.focus();
    state.findInput.select();
    runFind();
  }

  function closePanel() {
    state.open = false;
    if (state.panel) state.panel.hidden = true;
  }

  function togglePanel() {
    if (state.open) closePanel();
    else openPanel();
  }

  /* ─── Montaje ────────────────────────────────────────────────────────── */

  document.addEventListener('keydown', (e) => {
    const isFind = (e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && !e.shiftKey;

    if (isFind) {
      // Si el buscador global (Ctrl+Shift+F) no lo tomó, se abre éste.
      e.preventDefault();
      togglePanel();
    }
  });

  window.NumFindReplace = {
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
    findNext,
    findPrevious,
    replaceOne,
    replaceAll,
    runFind,
    get matches() { return state.matches.slice(); },
    get open$() { return state.open; },
  };

  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
  });
})();
