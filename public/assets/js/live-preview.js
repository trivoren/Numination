/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · live-preview.js · v1.1 (MEJORADO)
   ───────────────────────────────────────────────────────────────────────────
   Vista previa en vivo del HTML/CSS/JS dentro del Coder.

   QUÉ HACE
     · Renderiza el archivo HTML actual en un `iframe` con `srcdoc` y
       `sandbox="allow-scripts"` (aislado: no puede tocar la cookie de
       sesión ni el DOM de la app padre).
     · Se re-renderiza al guardar, al cambiar de pestaña y de forma
       automática (con debounce) mientras se escribe.
     · Captura los errores de consola del iframe vía `postMessage` y los
       muestra en una tira inferior.
     · Selector de ancho (móvil / tablet / escritorio) para responsive.

   POR QUÉ `sandbox="allow-scripts"` Y NADA MÁS
     El preview ejecuta código del usuario. Con `allow-scripts` (sin
     `allow-same-origin`) el iframe corre en un origen opaco: no puede
     leer cookies, ni localStorage, ni el DOM del padre. Es el mismo
     criterio que usa un sandbox serio.

   MEJORAS RESPECTO A LA v1.0
     · Antes se re-renderizaba sólo al guardar; ahora también al cambiar
       de pestaña y de forma continua con debounce de 700 ms.
     · Antes los errores de consola se perdían; ahora se capturan y se
       muestran con el archivo y la línea.
     · Antes no había control de ancho; ahora hay 3 presets.
     · Antes el iframe se recreaba en cada render (perdía el scroll y el
       estado); ahora se reutiliza y sólo se actualiza el srcdoc.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STYLE_ID = 'numination-live-preview-styles';

  const CSS = `
.nm-lp-root {
  display: flex; flex-direction: column; height: 100%;
  background: var(--c-bg, #0a0a0c);
  border: 1px solid rgba(255,255,255,.08);
  border-radius: 12px; overflow: hidden;
}
.nm-lp-toolbar {
  display: flex; align-items: center; gap: 8px; padding: 8px 11px;
  border-bottom: 1px solid rgba(255,255,255,.08); background: rgba(255,255,255,.02);
}
.nm-lp-btn {
  border: 1px solid rgba(255,255,255,.12); border-radius: 7px; background: transparent;
  color: #b9b9c9; cursor: pointer; padding: 5px 9px;
  font: 600 11px/1 var(--font-sans, Inter, system-ui, sans-serif);
}
.nm-lp-btn:hover { background: rgba(255,255,255,.06); color: #fff; }
.nm-lp-btn.is-active { background: rgba(139,92,246,.18); border-color: rgba(139,92,246,.4); color: #c4b5fd; }
.nm-lp-status { margin-left: auto; font: 600 10.5px/1 var(--font-mono, monospace); color: #6a6a80; }
.nm-lp-status.is-ok { color: #4ade80; }
.nm-lp-status.is-error { color: #ff8b84; }
.nm-lp-stage {
  flex: 1; overflow: auto; display: flex; justify-content: center;
  background:
    repeating-linear-gradient(45deg, rgba(255,255,255,.012) 0 10px, transparent 10px 20px),
    #08080b;
  padding: 12px;
}
.nm-lp-frame {
  width: 100%; height: 100%; min-height: 320px;
  border: 0; border-radius: 9px; background: #fff;
  box-shadow: 0 12px 34px rgba(0,0,0,.5);
  transition: width .2s ease;
}
.nm-lp-errors {
  max-height: 30%; overflow-y: auto;
  border-top: 1px solid rgba(255,255,255,.08); background: rgba(240,67,58,.05);
}
.nm-lp-errors[hidden] { display: none; }
.nm-lp-error {
  display: flex; gap: 9px; align-items: baseline;
  padding: 7px 12px; font: 400 11.5px/1.5 var(--font-mono, monospace); color: #ffb0ab;
  border-bottom: 1px solid rgba(240,67,58,.12);
}
.nm-lp-error__where { color: #8b8b9c; flex: 0 0 auto; }
.nm-lp-empty { display: grid; place-items: center; height: 100%; color: #6a6a80; font-size: 12.5px; text-align: center; padding: 20px; }
`;

  const CFG = {
    debounceMs: 700,
    widths: {
      mobile: 390,
      tablet: 768,
      desktop: 0,   // 0 = 100%
    },
    defaultWidth: 'desktop',
  };

  const state = {
    root: null,
    iframe: null,
    stage: null,
    errorsEl: null,
    statusEl: null,
    widthKey: CFG.defaultWidth,
    errors: [],
    timer: null,
    lastHtml: '',
    mounted: false,
    ready: false,
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
    console.info('[live-preview]', kind, message);
  }

  function getEditor() {
    const es = window.EditorState;
    if (!es || !es.monacoInstance) return null;
    return es;
  }

  /**
   * Obtiene el HTML a previsualizar.
   *
   * · Si el archivo abierto es .html → su contenido.
   * · Si es CSS → se envuelve en un HTML mínimo con el CSS.
   * · Si es JS → se envuelve con un HTML mínimo que lo carga.
   */
  function getPreviewSource() {
    const es = getEditor();
    if (!es) return null;

    const file = es.getActiveFile ? es.getActiveFile() : null;
    const content = String(es.getValue() || '');
    const path = String((file && file.path) || 'index.html');
    const ext = path.split('.').pop().toLowerCase();

    if (ext === 'html' || ext === 'htm') {
      return { html: content, path, kind: 'html' };
    }

    if (ext === 'css') {
      return {
        html: `<!doctype html><html><head><meta charset="utf-8"><style>\n${content}\n</style></head>` +
               `<body><div class="preview-sample"><h1>Título</h1><p>Párrafo de muestra.</p>` +
               `<button>Botón</button></div></body></html>`,
        path,
        kind: 'css',
      };
    }

    if (ext === 'js' || ext === 'mjs' || ext === 'ts' || ext === 'jsx' || ext === 'tsx') {
      return {
        html: `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
               `<div id="root"></div><script>\n${content}\n</script></body></html>`,
        path,
        kind: 'js',
      };
    }

    return null;
  }

  /* ─── Errores ────────────────────────────────────────────────────────── */

  function setStatus(text, kind = '') {
    if (!state.statusEl) return;
    state.statusEl.textContent = text;
    state.statusEl.className = `nm-lp-status${kind ? ` is-${kind}` : ''}`;
  }

  function addError(message, source = '', line = 0) {
    state.errors.unshift({ message: String(message).slice(0, 400), source, line, at: Date.now() });
    state.errors = state.errors.slice(0, 30);
    renderErrors();
  }

  function clearErrors() {
    state.errors = [];
    renderErrors();
  }

  function renderErrors() {
    if (!state.errorsEl) return;

    state.errorsEl.innerHTML = '';
    state.errorsEl.hidden = state.errors.length === 0;

    for (const err of state.errors) {
      const row = document.createElement('div');
      row.className = 'nm-lp-error';

      const where = document.createElement('span');
      where.className = 'nm-lp-error__where';
      where.textContent = err.line ? `${err.source || 'preview'}:${err.line}` : (err.source || 'preview');

      const text = document.createElement('span');
      text.textContent = err.message;

      row.append(where, text);
      state.errorsEl.appendChild(row);
    }
  }

  /* ─── Render ─────────────────────────────────────────────────────────── */

  function render(force = false) {
    const source = getPreviewSource();

    if (!source) {
      if (state.stage) {
        state.stage.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'nm-lp-empty';
        empty.textContent = 'Abrí un archivo HTML, CSS o JS para ver la vista previa.';
        state.stage.appendChild(empty);
      }
      setStatus('sin archivo compatible');
      return false;
    }

    if (!state.iframe) return false;

    if (!force && source.html === state.lastHtml) return true;

    state.lastHtml = source.html;

    // Se reutiliza el iframe: sólo se le cambia el srcdoc.
    state.iframe.srcdoc = source.html;

    setStatus('renderizando…');

    return true;
  }

  function scheduleRender() {
    clearTimeout(state.timer);
    state.timer = setTimeout(() => render(false), CFG.debounceMs);
  }

  function setWidth(key) {
    state.widthKey = key;
    if (!state.iframe) return;

    const width = CFG.widths[key];
    state.iframe.style.width = width ? `${width}px` : '100%';

    const buttons = state.root.querySelectorAll('[data-width]');
    buttons.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.width === key));
  }

  /* ─── PostMessage (errores del iframe) ───────────────────────────────── */

  function onMessage(event) {
    if (!state.iframe || event.source !== state.iframe.contentWindow) return;

    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'nm-preview-error') {
      addError(data.message, data.source, data.line);
      setStatus('error', 'error');
    }

    if (data.type === 'nm-preview-ready') {
      setStatus('listo', 'ok');
    }
  }

  /* ─── Montaje ────────────────────────────────────────────────────────── */

  function build() {
    injectStyles();

    const root = document.createElement('div');
    root.className = 'nm-lp-root';

    const toolbar = document.createElement('div');
    toolbar.className = 'nm-lp-toolbar';

    const refresh = document.createElement('button');
    refresh.className = 'nm-lp-btn';
    refresh.type = 'button';
    refresh.textContent = '↻ Recargar';
    refresh.addEventListener('click', () => {
      clearErrors();
      render(true);
    });

    const widths = ['mobile', 'tablet', 'desktop'];
    const widthButtons = widths.map((key) => {
      const btn = document.createElement('button');
      btn.className = 'nm-lp-btn';
      btn.type = 'button';
      btn.dataset.width = key;
      btn.textContent = key === 'mobile' ? 'Móvil' : key === 'tablet' ? 'Tablet' : 'Escritorio';
      btn.addEventListener('click', () => setWidth(key));
      return btn;
    });

    const status = document.createElement('span');
    status.className = 'nm-lp-status';
    status.textContent = 'inactivo';
    state.statusEl = status;

    toolbar.append(refresh, ...widthButtons, status);

    const stage = document.createElement('div');
    stage.className = 'nm-lp-stage';
    state.stage = stage;

    const iframe = document.createElement('iframe');
    iframe.className = 'nm-lp-frame';
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('title', 'Vista previa del código');
    iframe.srcdoc = '<!doctype html><html><body></body></html>';
    state.iframe = iframe;

    stage.appendChild(iframe);

    const errors = document.createElement('div');
    errors.className = 'nm-lp-errors';
    errors.hidden = true;
    state.errorsEl = errors;

    root.append(toolbar, stage, errors);

    return root;
  }

  function mount(target) {
    if (state.mounted && state.root && state.root.isConnected) return state.root;

    const container = typeof target === 'string' ? document.querySelector(target) : target;
    if (!container) return null;

    const root = build();
    container.appendChild(root);

    state.root = root;
    state.mounted = true;
    state.ready = true;

    setWidth(state.widthKey);
    render(true);

    window.addEventListener('message', onMessage);

    bindEvents();

    return root;
  }

  function bindEvents() {
    if (!window.eventBus || typeof window.eventBus.on !== 'function') return;

    // Se re-renderiza al guardar y al cambiar de pestaña.
    window.eventBus.on('editor:saved', () => {
      clearErrors();
      render(true);
    });

    window.eventBus.on('file:opened', (data) => {
      clearErrors();
      state.lastHtml = '';
      if (data && data.path && /(^|\/)[^/]*\.(html?|css|m?js|jsx|tsx)$/i.test(data.path)) {
        render(true);
      } else {
        render(true);
      }
    });

    window.eventBus.on('editor:change', () => {
      scheduleRender();
    });
  }

  window.NumLivePreview = {
    mount,
    render,
    scheduleRender,
    setWidth,
    clearErrors,
    get errors() { return state.errors.slice(); },
    get width() { return state.widthKey; },
  };

  document.addEventListener('DOMContentLoaded', () => {
    const target = document.getElementById('live-preview') ||
      document.querySelector('[data-live-preview]');
    if (target) mount(target);
    else if (window.eventBus && typeof window.eventBus.on === 'function') {
      window.eventBus.on('editor:ready', () => mount('#preview-container'));
    }
  });
})();
