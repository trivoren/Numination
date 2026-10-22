/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · code-explainer.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Botón flotante de "Explicar código" dentro del editor Monaco.

   · Se inyecta por JS sobre el contenedor del editor (sin archivos .css:
     los estilos se crean con `document.createElement('style')`).
   · Al hacer clic toma la SELECCIÓN del editor (o el archivo entero si
     no hay selección) y pide una explicación a /api/ai/explain.
   · Muestra el resultado en un panel lateral con:
       · explicación línea por línea
       · resumen de qué hace
       · riesgos / casos borde
   · Escribe en un <pre> con textContent (nunca innerHTML con datos del
     modelo): el LLM es contenido no confiable.

   Tokens de diseño: --c-bg #0a0a0c · --c-primary #8b5cf6
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STYLE_ID = 'numination-code-explainer-styles';

  const CSS = `
.nm-explainer-btn {
  position: absolute;
  right: 18px;
  bottom: 18px;
  z-index: 40;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 9px 14px;
  border-radius: 999px;
  border: 1px solid rgba(139, 92, 246, .38);
  background: linear-gradient(135deg, var(--c-primary, #8b5cf6), #6d28d9);
  color: #fff;
  font: 600 12.5px/1 var(--font-sans, Inter, system-ui, sans-serif);
  cursor: pointer;
  box-shadow: 0 10px 28px rgba(139, 92, 246, .34);
  transition: transform .16s ease, box-shadow .16s ease, filter .16s ease;
}
.nm-explainer-btn:hover { transform: translateY(-1px); filter: brightness(1.08); }
.nm-explainer-btn:active { transform: translateY(0) scale(.98); }
.nm-explainer-btn:focus-visible { outline: 2px solid var(--c-primary, #8b5cf6); outline-offset: 3px; }
.nm-explainer-btn[disabled] { opacity: .55; cursor: progress; transform: none; }
.nm-explainer-btn__icon { display: inline-flex; }

.nm-explainer-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 45;
  width: min(440px, 92vw);
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--c-bg, #0a0a0c) 96%, #fff 4%);
  border-left: 1px solid rgba(255, 255, 255, .09);
  box-shadow: -18px 0 48px rgba(0, 0, 0, .55);
  transform: translateX(102%);
  transition: transform .24s cubic-bezier(.22,.9,.3,1);
}
.nm-explainer-panel.is-open { transform: none; }
.nm-explainer-panel__head {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, .08);
}
.nm-explainer-panel__title { font: 700 13px/1 var(--font-sans, Inter, sans-serif); color: var(--c-text, #f4f4f7); }
.nm-explainer-panel__meta { font-size: 11px; color: var(--c-text-2, #8b8b9c); }
.nm-explainer-panel__close {
  margin-left: auto; width: 28px; height: 28px; border-radius: 8px;
  border: 1px solid rgba(255,255,255,.1); background: transparent; color: var(--c-text-1, #c9c9d4);
  cursor: pointer; font-size: 16px; line-height: 1;
}
.nm-explainer-panel__close:hover { background: rgba(255,255,255,.06); }
.nm-explainer-panel__body {
  flex: 1; overflow-y: auto; padding: 16px;
  display: flex; flex-direction: column; gap: 16px;
}
.nm-explainer-section { display: flex; flex-direction: column; gap: 7px; }
.nm-explainer-section__label {
  font-size: 10px; font-weight: 800; letter-spacing: .09em; text-transform: uppercase;
  color: var(--c-primary, #8b5cf6);
}
.nm-explainer-section__text {
  margin: 0; white-space: pre-wrap; word-break: break-word;
  font: 400 12.5px/1.65 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  color: var(--c-text-1, #c9c9d4);
  background: rgba(255,255,255,.03);
  border: 1px solid rgba(255,255,255,.06);
  border-radius: 10px; padding: 11px 12px;
}
.nm-explainer-status { display: flex; align-items: center; gap: 9px; font-size: 12px; color: var(--c-text-2, #8b8b9c); }
.nm-explainer-spinner {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid rgba(139,92,246,.25); border-top-color: var(--c-primary, #8b5cf6);
  animation: nm-explainer-spin .8s linear infinite;
}
@keyframes nm-explainer-spin { to { transform: rotate(360deg); } }
.nm-explainer-error {
  color: #ff8b84; font-size: 12px; line-height: 1.55;
  border: 1px solid rgba(240,67,58,.3); background: rgba(240,67,58,.09);
  border-radius: 10px; padding: 11px 12px;
}
`;

  const state = {
    button: null,
    panel: null,
    body: null,
    busy: false,
    mounted: false,
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

  const $ = (sel) => document.querySelector(sel);

  function toast(message, kind = 'info') {
    if (window.NuminToast) {
      if (typeof window.NuminToast.show === 'function') return window.NuminToast.show(message, kind);
      if (typeof window.NuminToast.error === 'function' && kind === 'error') return window.NuminToast.error(message);
      if (typeof window.NuminToast.info === 'function' && kind === 'info') return window.NuminToast.info(message);
    }
    console.info('[code-explainer]', kind, message);
  }

  function editor() {
    const es = window.EditorState;
    if (!es || !es.monacoInstance) return null;
    return es;
  }

  /** Devuelve { code, language, path, partial }. */
  function getSelection() {
    const es = editor();
    if (!es) return null;

    const monaco = es.monacoInstance;
    const model = monaco.getModel();
    if (!model) return null;

    const selection = monaco.getSelection();
    let code = '';
    let partial = false;

    if (selection && !selection.isEmpty()) {
      code = model.getValueInRange(selection);
      partial = true;
    } else {
      code = model.getValue();
    }

    const file = es.getActiveFile ? es.getActiveFile() : null;

    return {
      code: String(code || ''),
      language: (file && file.language) || 'javascript',
      path: (file && file.path) || 'index.js',
      partial,
    };
  }

  /* ─── Panel ──────────────────────────────────────────────────────────── */

  function buildPanel(container) {
    const panel = document.createElement('div');
    panel.className = 'nm-explainer-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Explicación del código');
    panel.hidden = false;

    const head = document.createElement('div');
    head.className = 'nm-explainer-panel__head';

    const title = document.createElement('span');
    title.className = 'nm-explainer-panel__title';
    title.textContent = 'Explicación';

    const meta = document.createElement('span');
    meta.className = 'nm-explainer-panel__meta';
    meta.textContent = '';

    const close = document.createElement('button');
    close.className = 'nm-explainer-panel__close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Cerrar');
    close.addEventListener('click', () => hidePanel());

    head.append(title, meta, close);

    const body = document.createElement('div');
    body.className = 'nm-explainer-panel__body';

    panel.append(head, body);
    container.appendChild(panel);

    state.panel = panel;
    state.body = body;
    state.meta = meta;

    return panel;
  }

  function showPanel() {
    if (!state.panel) return;
    state.panel.classList.add('is-open');
  }

  function hidePanel() {
    if (!state.panel) return;
    state.panel.classList.remove('is-open');
  }

  function setStatus(text) {
    if (!state.body) return;
    state.body.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'nm-explainer-status';
    const spinner = document.createElement('span');
    spinner.className = 'nm-explainer-spinner';
    const label = document.createElement('span');
    label.textContent = text;
    row.append(spinner, label);
    state.body.appendChild(row);
  }

  function setError(message) {
    if (!state.body) return;
    state.body.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'nm-explainer-error';
    box.textContent = message;
    state.body.appendChild(box);
  }

  function section(label, text) {
    const wrap = document.createElement('div');
    wrap.className = 'nm-explainer-section';

    const head = document.createElement('div');
    head.className = 'nm-explainer-section__label';
    head.textContent = label;

    const pre = document.createElement('pre');
    pre.className = 'nm-explainer-section__text';
    pre.textContent = text || '—';

    wrap.append(head, pre);
    return wrap;
  }

  /* ─── Llamada a la API ──────────────────────────────────────────────── */

  async function explain() {
    if (state.busy) return;

    const selection = getSelection();
    if (!selection || !selection.code.trim()) {
      toast('No hay código para explicar.', 'error');
      return;
    }

    if (selection.code.length > 12000) {
      toast('Seleccioná menos código (máximo 12 000 caracteres).', 'error');
      return;
    }

    state.busy = true;
    if (state.button) state.button.disabled = true;
    showPanel();
    setStatus('Analizando el código…');

    try {
      const payload = {
        code: selection.code,
        language: selection.language,
        filePath: selection.path,
        partial: selection.partial,
      };

      let data;
      if (window.NumAPI && typeof window.NumAPI.post === 'function') {
        data = await window.NumAPI.post('/api/ai/explain', payload);
      } else {
        const res = await fetch('/api/ai/explain', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(payload),
        });
        const text = await res.text();
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        if (!res.ok) throw new Error((parsed && parsed.error) || `Error ${res.status}`);
        data = parsed;
      }

      const explanation = data?.explanation || data?.result || {};
      if (state.body) {
        state.body.innerHTML = '';
        state.body.appendChild(section('Qué hace', explanation.summary || explanation.overview || '—'));
        if (explanation.lineByLine) state.body.appendChild(section('Línea por línea', explanation.lineByLine));
        if (explanation.breakdown) state.body.appendChild(section('Desglose', explanation.breakdown));
        if (explanation.risks) state.body.appendChild(section('Riesgos y casos borde', explanation.risks));
        if (explanation.suggestions) state.body.appendChild(section('Sugerencias', explanation.suggestions));
      }

      if (state.meta) {
        state.meta.textContent = `${selection.path} · ${selection.language}`;
      }

      toast('Explicación lista.', 'ok');
    } catch (e) {
      const message = e?.message || 'No se pudo explicar el código.';
      setError(message);
      toast(message, 'error');
    } finally {
      state.busy = false;
      if (state.button) state.button.disabled = false;
    }
  }

  /* ─── Montaje ───────────────────────────────────────────────────────── */

  function mount() {
    if (state.mounted) return state.button;

    const container =
      document.getElementById('monaco-container') ||
      document.querySelector('.monaco-container') ||
      document.querySelector('[data-monaco-host]');

    if (!container) return null;

    injectStyles();

    const host = container.parentElement || container;
    if (getComputedStyle(host).position === 'static') {
      host.style.position = 'relative';
    }

    const button = document.createElement('button');
    button.className = 'nm-explainer-btn';
    button.type = 'button';
    button.title = 'Explicar el código seleccionado (Ctrl+Shift+E)';
    button.innerHTML =
      '<span class="nm-explainer-btn__icon">✦</span><span>Explicar</span>';
    button.addEventListener('click', explain);

    host.appendChild(button);
    buildPanel(host);

    state.button = button;
    state.mounted = true;

    // Atajo global: Ctrl/Cmd + Shift + E
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
        e.preventDefault();
        explain();
      }
    });

    return button;
  }

  window.NumCodeExplainer = {
    mount,
    explain,
    hidePanel,
    get busy() { return state.busy; },
  };

  document.addEventListener('DOMContentLoaded', () => {
    // El editor puede montarse después: se reintenta con el evento.
    if (!mount() && window.eventBus && typeof window.eventBus.on === 'function') {
      window.eventBus.on('editor:ready', () => mount());
    }
  });
})();
