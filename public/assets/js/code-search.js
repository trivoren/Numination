/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · code-search.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Buscador global de código (Ctrl+Shift+F / Cmd+Shift+F).

   QUÉ INDEXA
     · El contenido de TODOS los archivos del proyecto, no sólo el
       archivo abierto. Por eso necesita el índice del proyecto; si no
       está disponible, usa los archivos que el Coder ya tiene
       cargados.

   CÓMO BUSCA
     · Motor nativo: coincidencias literales (case-insensitive) + un
       modo regex opcional.
     · Se limita el número de coincidencias por archivo (evita que un
       archivo gigante bloquee el hilo).
     · Se recorre el trabajo en trozos (chunks) con `requestIdleCallback`
       para no congelar la UI.

   RESULTADOS
     · Panel con archivo:línea, la línea resaltada y hasta 3 líneas de
       contexto. Click → abre el archivo en esa línea.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STYLE_ID = 'numination-code-search-styles';

  const CSS = `
.nm-cs-backdrop {
  position: fixed; inset: 0; z-index: 130;
  background: rgba(4,4,8,.66); backdrop-filter: blur(3px);
  display: flex; align-items: flex-start; justify-content: center; padding-top: 9vh;
}
.nm-cs-panel {
  width: min(820px, 94vw); max-height: 78vh;
  display: flex; flex-direction: column;
  background: color-mix(in srgb, var(--c-bg, #0a0a0c) 94%, #fff 6%);
  border: 1px solid rgba(255,255,255,.12); border-radius: 14px;
  box-shadow: 0 28px 70px rgba(0,0,0,.68); overflow: hidden;
  animation: nm-cs-in .16s cubic-bezier(.22,.9,.3,1);
}
@keyframes nm-cs-in { from { opacity:0; transform: translateY(-8px) scale(.985);} to { opacity:1; transform:none; } }
.nm-cs-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid rgba(255,255,255,.08); }
.nm-cs-input {
  flex: 1; border: none; outline: none; background: transparent; color: var(--c-text, #f4f4f7);
  font: 400 14.5px/1.4 var(--font-sans, Inter, system-ui, sans-serif);
}
.nm-cs-input::placeholder { color: #6a6a80; }
.nm-cs-toggle {
  border: 1px solid rgba(255,255,255,.14); border-radius: 7px; background: transparent;
  color: #9a9aae; font: 600 11px/1 var(--font-mono, monospace); padding: 6px 9px; cursor: pointer;
}
.nm-cs-toggle.is-active { background: rgba(139,92,246,.18); border-color: rgba(139,92,246,.45); color: #c4b5fd; }
.nm-cs-summary { padding: 8px 16px; font-size: 11.5px; color: #7a7a90; border-bottom: 1px solid rgba(255,255,255,.06); }
.nm-cs-results { flex: 1; overflow-y: auto; padding: 6px 0; }
.nm-cs-file {
  display: flex; align-items: center; gap: 8px; padding: 8px 16px 4px;
  font: 600 12px/1 var(--font-mono, monospace); color: #a78bfa;
  position: sticky; top: 0; background: rgba(12,12,16,.96); backdrop-filter: blur(6px);
}
.nm-cs-hit {
  display: block; width: 100%; text-align: left; padding: 4px 16px 4px 34px;
  border: 0; background: transparent; cursor: pointer;
  font: 400 12px/1.6 var(--font-mono, monospace); color: #b9b9c9;
}
.nm-cs-hit:hover { background: rgba(255,255,255,.045); color: #fff; }
.nm-cs-hit__line { color: #6a6a80; margin-right: 10px; }
.nm-cs-hit mark { background: rgba(139,92,246,.3); color: #fff; border-radius: 3px; padding: 0 2px; }
.nm-cs-empty { padding: 30px 18px; text-align: center; color: #6a6a80; font-size: 12.5px; }
.nm-cs-foot { padding: 9px 16px; border-top: 1px solid rgba(255,255,255,.08); font-size: 11px; color: #6a6a80; }
`;

  const CFG = {
    maxHitsPerFile: 60,
    maxFiles: 400,
    maxFileBytes: 900_000,
    chunkSize: 12,
  };

  const state = {
    panel: null,
    input: null,
    results: null,
    summary: null,
    open: false,
    isRegex: false,
    hits: [],
    files: [],
    searching: false,
    searchToken: 0,
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

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function highlight(line, pattern) {
    const safe = escapeHtml(line);
    if (!pattern) return safe;
    try {
      const re = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
      return safe.replace(re, (m) => `<mark>${m}</mark>`);
    } catch {
      return safe;
    }
  }

  /* ─── Overlay ────────────────────────────────────────────────────────── */

  function buildPanel() {
    if (state.panel) return state.panel;

    const backdrop = document.createElement('div');
    backdrop.className = 'nm-cs-backdrop';

    const panel = document.createElement('div');
    panel.className = 'nm-cs-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Buscar en el proyecto');

    const head = document.createElement('div');
    head.className = 'nm-cs-head';

    const input = document.createElement('input');
    input.className = 'nm-cs-input';
    input.type = 'text';
    input.placeholder = 'Buscar en todos los archivos…';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const toggle = document.createElement('button');
    toggle.className = 'nm-cs-toggle';
    toggle.type = 'button';
    toggle.textContent = '.*';
    toggle.title = 'Buscar con expresión regular';

    toggle.addEventListener('click', () => {
      state.isRegex = !state.isRegex;
      toggle.classList.toggle('is-active', state.isRegex);
      if (state.input.value.trim()) runSearch();
    });

    head.append(input, toggle);

    const summary = document.createElement('div');
    summary.className = 'nm-cs-summary';
    summary.textContent = 'Escribí para buscar.';

    const results = document.createElement('div');
    results.className = 'nm-cs-results';

    const foot = document.createElement('div');
    foot.className = 'nm-cs-foot';
    foot.innerHTML = '<span>↑↓ navegar · ↵ abrir · esc cerrar</span>';

    panel.append(head, summary, results, foot);
    backdrop.appendChild(panel);

    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });

    let debounce = null;
    input.addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => runSearch(), 260);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        openFirstHit();
      }
    });

    document.body.appendChild(backdrop);

    state.panel = backdrop;
    state.input = input;
    state.results = results;
    state.summary = summary;

    return backdrop;
  }

  /* ─── Índice de archivos ────────────────────────────────────────────── */

  /**
   * Consigue la lista de archivos + su contenido.
   * Fuentes: window.NumFileSearch (índice), la API del coder, o los
   * archivos ya cargados en el editor.
   */
  async function collectFiles() {
    // 1) El índice del buscador de archivos (ya sabe la lista).
    if (window.NumFileSearch && typeof window.NumFileSearch.refreshIndex === 'function') {
      await window.NumFileSearch.refreshIndex();
      const files = window.NumFileSearch.files || [];
      if (files.length) return files;
    }

    // 2) API del coder.
    try {
      if (window.NumAPI && typeof window.NumAPI.get === 'function') {
        const data = await window.NumAPI.get('/api/coder/files', { silent: true });
        const list = Array.isArray(data?.files) ? data.files : (Array.isArray(data) ? data : null);
        if (list && list.length) return list;
      }
    } catch {
      /* sin API de archivos */
    }

    return [];
  }

  /**
   * Descarga el contenido de un archivo (para indexarlo).
   */
  async function loadContent(file) {
    const path = file.path || file.name;

    // Si el archivo está abierto en el editor, su contenido ya está en memoria.
    try {
      const es = window.EditorState;
      if (es && typeof es.getValue === 'function') {
        const active = es.getActiveFile ? es.getActiveFile() : null;
        if (active && active.path === path) {
          return String(es.getValue() || '');
        }
      }
    } catch {
      /* sin editor */
    }

    try {
      if (window.NumAPI && typeof window.NumAPI.get === 'function') {
        const data = await window.NumAPI.get(`/api/coder/file?path=${encodeURIComponent(path)}`, { silent: true });
        const content = data?.content ?? data?.code ?? data?.file?.content;
        if (typeof content === 'string') return content;
      }
    } catch {
      /* archivo no accesible */
    }

    return null;
  }

  /* ─── Búsqueda ──────────────────────────────────────────────────────── */

  function buildMatcher(query) {
    if (!query) return null;

    if (state.isRegex) {
      try {
        return new RegExp(query, 'gi');
      } catch {
        return null;
      }
    }

    return new RegExp(escapeRegExp(query), 'gi');
  }

  async function runSearch() {
    const query = state.input.value.trim();
    const token = ++state.searchToken;

    if (!query) {
      state.hits = [];
      state.summary.textContent = 'Escribí para buscar.';
      state.results.innerHTML = '<div class="nm-cs-empty">Sin consulta.</div>';
      return;
    }

    const matcher = buildMatcher(query);
    if (!matcher) {
      state.summary.textContent = 'La expresión regular no es válida.';
      state.results.innerHTML = '<div class="nm-cs-empty">Regex inválida.</div>';
      return;
    }

    state.summary.textContent = 'Buscando…';
    state.results.innerHTML = '';

    const files = (await collectFiles()).slice(0, CFG.maxFiles);
    const hits = [];

    // Se procesa por bloques para no bloquear el hilo principal.
    for (let i = 0; i < files.length; i += CFG.chunkSize) {
      if (token !== state.searchToken) return; // llegó otra búsqueda

      const chunk = files.slice(i, i + CFG.chunkSize);
      const contents = await Promise.all(chunk.map((f) => loadContent(f)));

      chunk.forEach((file, idx) => {
        const content = contents[idx];
        if (typeof content !== 'string' || !content) return;
        if (content.length > CFG.maxFileBytes) return;

        matcher.lastIndex = 0;
        const lines = content.split('\n');
        let fileHits = 0;

        for (let ln = 0; ln < lines.length; ln++) {
          matcher.lastIndex = 0;
          if (!matcher.test(lines[ln])) continue;

          matcher.lastIndex = 0;
          const index = lines[ln].search(matcher);

          hits.push({
            file,
            path: file.path || file.name,
            line: ln + 1,
            text: lines[ln].slice(0, 400),
            column: index >= 0 ? index + 1 : 1,
          });

          fileHits++;
          if (fileHits >= CFG.maxHitsPerFile) break;
        }
      });

      // Se cede el control al navegador entre bloques.
      await new Promise((resolve) => {
        if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 60 });
        else setTimeout(resolve, 0);
      });
    }

    if (token !== state.searchToken) return;

    state.hits = hits;
    renderResults(query);
  }

  function renderResults(query) {
    if (!state.results) return;

    const matcher = buildMatcher(query);

    if (!state.hits.length) {
      state.summary.textContent = `Sin coincidencias para "${query}".`;
      state.results.innerHTML = '<div class="nm-cs-empty">Sin coincidencias.</div>';
      return;
    }

    const filesCount = new Set(state.hits.map((h) => h.path)).size;
    state.summary.textContent = `${state.hits.length} coincidencia${state.hits.length === 1 ? '' : 's'} en ${filesCount} archivo${filesCount === 1 ? '' : 's'}.`;

    // Agrupar por archivo.
    const groups = new Map();
    for (const hit of state.hits) {
      if (!groups.has(hit.path)) groups.set(hit.path, []);
      groups.get(hit.path).push(hit);
    }

    state.results.innerHTML = '';

    for (const [path, hits] of groups) {
      const fileHeader = document.createElement('div');
      fileHeader.className = 'nm-cs-file';
      fileHeader.textContent = `${path}  (${hits.length})`;
      state.results.appendChild(fileHeader);

      hits.forEach((hit) => {
        const button = document.createElement('button');
        button.className = 'nm-cs-hit';
        button.type = 'button';
        button.innerHTML = `<span class="nm-cs-hit__line">${hit.line}</span>${highlight(hit.text, matcher)}`;
        button.addEventListener('click', () => {
          close();
          openHit(hit);
        });
        state.results.appendChild(button);
      });
    }
  }

  function openFirstHit() {
    if (!state.hits.length) return;
    close();
    openHit(state.hits[0]);
  }

  function openHit(hit) {
    if (window.eventBus && typeof window.eventBus.emit === 'function') {
      window.eventBus.emit('file:open', { path: hit.path, line: hit.line, column: hit.column });
      window.eventBus.emit('navigate:file', { path: hit.path, line: hit.line });
    }
    console.info('[code-search] abrir', hit.path, hit.line);
  }

  /* ─── Acciones ───────────────────────────────────────────────────────── */

  function open() {
    injectStyles();
    buildPanel();
    state.open = true;
    state.panel.hidden = false;
    setTimeout(() => state.input.focus(), 30);
  }

  function close() {
    state.open = false;
    if (state.panel) state.panel.hidden = true;
  }

  /* ─── Montaje ───────────────────────────────────────────────────────── */

  document.addEventListener('keydown', (e) => {
    const isSearch = (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F');

    if (isSearch) {
      e.preventDefault();
      if (state.open) close();
      else open();
    }
  });

  window.NumCodeSearch = {
    open,
    close,
    runSearch,
    collectFiles,
    get hits() { return state.hits.slice(); },
    get isRegex() { return state.isRegex; },
    setRegex(value) {
      state.isRegex = Boolean(value);
      const toggle = state.panel?.querySelector('.nm-cs-toggle');
      if (toggle) toggle.classList.toggle('is-active', state.isRegex);
    },
  };

  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    void $;
  });
})();
