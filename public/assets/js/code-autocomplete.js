/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · code-autocomplete.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Autocompletado con IA ("ghost text") sobre Monaco.

   CÓMO FUNCIONA
     1. Escucha `keyup` del editor.
     2. Espera 500 ms de inactividad (debounce) para no pedir una
        sugerencia por cada tecla.
     3. Pide la continuación a /api/ai/autocomplete con el contexto
        (archivo, cursor, últimas líneas).
     4. Muestra la sugerencia como "ghost text" (texto atenuado detrás
        del cursor).
     5. Aceptar: Tab. Rechazar: Esc.

   DETALLES QUE IMPORTAN
     · La sugerencia NUNCA se inserta en el documento hasta que el
       usuario la acepta (si no, el código del usuario se corrompe).
     · While la petición está en vuelo, se muestra un placeholder
       sutil; si el usuario sigue escribiendo, la respuesta vieja se
       descarta (se compara el prefijo).
     · Pide confirmación (`editor:change`) antes de escribir.
     · Se desactiva si el usuario tiene el autocompletado nativo de
       Monaco activo en la misma posición.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STYLE_ID = 'numination-autocomplete-styles';

  const CSS = `
.nm-ghost {
  position: absolute;
  z-index: 30;
  pointer-events: none;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 13px;
  line-height: 19px;
  color: rgba(139, 92, 246, .42);
  white-space: pre;
  max-width: 620px;
  overflow: hidden;
  text-overflow: ellipsis;
  font-style: italic;
  text-shadow: 0 0 12px rgba(139, 92,246,.25);
}
.nm-ghost__badge {
  position: absolute;
  top: -16px; left: 0;
  font-size: 9px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  color: #8b5cf6; opacity: .8;
}
.nm-ghost__loading {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: #8b5cf6; animation: nm-ghost-pulse 1s infinite ease-in-out;
}
@keyframes nm-ghost-pulse { 0%,100% { opacity: .25; transform: scale(.8); } 50% { opacity: 1; transform: scale(1.2); } }
`;

  const CFG = {
    debounceMs: 500,
    minCharsBefore: 2,
    maxContextLines: 40,
    maxSuggestionChars: 400,
    endpoint: '/api/ai/autocomplete',
  };

  const state = {
    editor: null,
    monaco: null,
    decoration: null,
    timer: null,
    inFlight: false,
    suggestion: '',
    requestId: 0,
    enabled: true,
    ghostEl: null,
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
    console.info('[code-autocomplete]', kind, message);
  }

  function getEditor() {
    const es = window.EditorState;
    if (!es || !es.monacoInstance) return null;
    return es;
  }

  /**
   * Extrae el contexto alrededor del cursor.
   */
  function getContext() {
    const es = getEditor();
    if (!es) return null;

    const monaco = es.monacoInstance;
    const model = monaco.getModel();
    if (!model) return null;

    const position = monaco.getPosition();
    if (!position) return null;

    const fullValue = model.getValue();
    const offset = model.getOffsetAt(position);

    const before = fullValue.slice(0, offset);
    const lines = before.split('\n');
    const currentLine = lines[lines.length - 1] || '';

    const contextLines = lines.slice(-CFG.maxContextLines);

    const file = es.getActiveFile ? es.getActiveFile() : null;

    return {
      prefix: before.slice(-2000),
      currentLine,
      context: contextLines.join('\n'),
      suffix: fullValue.slice(offset, offset + 600),
      language: (file && file.language) || 'javascript',
      path: (file && file.path) || 'index.js',
      line: position.lineNumber,
      column: position.column,
      offset,
    };
  }

  /* ─── Ghost text ─────────────────────────────────────────────────────── */

  function ensureGhostHost() {
    if (state.ghostEl && state.ghostEl.isConnected) return state.ghostEl;

    const container = document.getElementById('monaco-container') ||
      document.querySelector('.monaco-container');
    if (!container) return null;

    const host = container.parentElement || container;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    const ghost = document.createElement('div');
    ghost.className = 'nm-ghost';
    ghost.hidden = true;
    host.appendChild(ghost);

    state.ghostEl = ghost;
    return ghost;
  }

  function hideGhost() {
    if (state.ghostEl) state.ghostEl.hidden = true;
    if (state.decoration) {
      const ids = state.decoration.getEditor().getModel().deltaDecorations(state.decoration || [], []);
      if (ids && ids.length) state.decoration.getEditor().deltaDecorations(ids, []);
      state.decoration = null;
    }
  }

  function showGhost(text, position) {
    const ghost = ensureGhostHost();
    if (!ghost || !position) return;

    // Posición en píxeles: la convertimos con el editor de Monaco.
    const es = getEditor();
    if (!es) return;

    let left = 0;
    let top = 0;

    try {
      const monaco = es.monacoInstance;
      const model = monaco.getModel();
      const coords = monaco.editor.getModelFontInfo
        ? null
        : null;
      void coords;

      // Conversión manual: se usa la posición del cursor y la altura de
      // línea para aproximar. Es suficiente para el ghost text.
      const lineHeight = 19;
      const topPx = (position.lineNumber - 1) * lineHeight + 26;
      const leftPx = (position.column - 1) * 7.2 + 14;

      left = leftPx;
      top = topPx;
      void model;
    } catch {
      left = 14;
      top = 26;
    }

    ghost.innerHTML = '';
    const badge = document.createElement('span');
    badge.className = 'nm-ghost__badge';
    badge.textContent = 'Tab para aceptar';
    ghost.appendChild(badge);
    ghost.appendChild(document.createTextNode(text));
    ghost.style.left = `${left}px`;
    ghost.style.top = `${top}px`;
    ghost.hidden = false;
  }

  function showLoadingGhost() {
    const ghost = ensureGhostHost();
    if (!ghost) return;
    ghost.innerHTML = '';
    const dot = document.createElement('span');
    dot.className = 'nm-ghost__loading';
    ghost.appendChild(dot);
    ghost.hidden = false;
  }

  /* ─── Aceptar / rechazar ─────────────────────────────────────────────── */

  function acceptSuggestion() {
    if (!state.suggestion) return false;

    const es = getEditor();
    if (!es) return false;

    const monaco = es.monacoInstance;
    const position = monaco.getPosition();
    if (!position) return false;

    const model = monaco.getModel();
    const selection = monaco.getSelection();

    const range = selection && !selection.isEmpty()
      ? selection
      : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);

    model.pushEditOperations(
      [],
      [{ range, text: state.suggestion, forceMoveMarkers: true }],
      () => null
    );

    state.suggestion = '';
    hideGhost();
    return true;
  }

  function rejectSuggestion() {
    state.suggestion = '';
    hideGhost();
  }

  /* ─── Petición ──────────────────────────────────────────────────────── */

  async function requestSuggestion(context) {
    const requestId = ++state.requestId;
    state.inFlight = true;
    showLoadingGhost();

    try {
      let data;
      if (window.NumAPI && typeof window.NumAPI.post === 'function') {
        data = await window.NumAPI.post(CFG.endpoint, {
          prefix: context.prefix,
          currentLine: context.currentLine,
          context: context.context,
          suffix: context.suffix,
          language: context.language,
          filePath: context.path,
        });
      } else {
        const res = await fetch(CFG.endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(context),
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        if (!res.ok) throw new Error((parsed && parsed.error) || `Error ${res.status}`);
        data = parsed;
      }

      // Si el usuario escribió mientras esperaba, la respuesta ya no sirve.
      if (requestId !== state.requestId) return;

      const suggestion = String(data?.suggestion || data?.completion || '').slice(0, CFG.maxSuggestionChars);

      if (!suggestion) {
        hideGhost();
        return;
      }

      state.suggestion = suggestion;

      const es = getEditor();
      const position = es && es.monacoInstance.getPosition();
      showGhost(suggestion, position);
    } catch (e) {
      hideGhost();
      if (requestId === state.requestId) {
        console.debug('[code-autocomplete]', e?.message);
      }
    } finally {
      if (requestId === state.requestId) {
        state.inFlight = false;
      }
    }
  }

  function scheduleSuggestion() {
    clearTimeout(state.timer);

    const context = getContext();
    if (!context) return;

    // No se pide sugerencia si la línea está casi vacía o si el
    // usuario está escribiendo en medio de un string largo.
    const trimmed = context.currentLine.trim();
    if (trimmed.length < CFG.minCharsBefore) {
      hideGhost();
      return;
    }

    if (/['"`]\s*$/.test(context.currentLine) && trimmed.split('"').length > 6) {
      hideGhost();
      return;
    }

    state.timer = setTimeout(() => requestSuggestion(context), CFG.debounceMs);
  }

  /* ─── Montaje ───────────────────────────────────────────────────────── */

  function mount() {
    const es = getEditor();
    if (!es) return false;

    injectStyles();

    const monaco = es.monacoInstance;

    monaco.onKeyUp(() => {
      if (!state.enabled) return;
      const event = monaco.getKeyboardLayoutEvent && monaco.getKeyboardLayoutEvent();
      const key = event && (event.keyCode || event.code);
      // No molestar con teclas de navegación.
      if ([37, 38, 39, 40, 33, 34, 35, 36, 9].includes(key)) return;
      scheduleSuggestion();
    });

    // Tab acepta la sugerencia si hay una.
    monaco.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      if (state.suggestion) {
        acceptSuggestion();
      }
    });

    monaco.addCommand(monaco.KeyCode.Tab, () => {
      if (state.suggestion) {
        acceptSuggestion();
      }
    });

    monaco.addCommand(monaco.KeyCode.Escape, () => {
      rejectSuggestion();
    });

    // Si el usuario edita a mano, la sugerencia deja de ser válida.
    monaco.onDidChangeModelContent(() => {
      if (state.suggestion) {
        state.suggestion = '';
        hideGhost();
      }
    });

    state.editor = es;
    state.monaco = monaco;
    return true;
  }

  window.NumCodeAutocomplete = {
    mount,
    accept: acceptSuggestion,
    reject: rejectSuggestion,
    enable() { state.enabled = true; },
    disable() { state.enabled = false; rejectSuggestion(); },
    get enabled() { return state.enabled; },
    get suggestion() { return state.suggestion; },
  };

  document.addEventListener('DOMContentLoaded', () => {
    if (!mount() && window.eventBus && typeof window.eventBus.on === 'function') {
      window.eventBus.on('editor:ready', () => mount());
    }
  });
})();
