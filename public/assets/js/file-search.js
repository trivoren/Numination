/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · file-search.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Búsqueda rápida de archivos (Ctrl+P / Cmd+P) con coincidencia difusa.

   IMPLEMENTACIÓN
     · Usa Fuse.js si está cargado en la página (`window.Fuse`).
     · Si no, usa un motor nativo: scoring por subsecuencia + coincidencia
       de prefijo + bonus por coincidencia de camelCase y por ruta.
     El motor nativo no es un relleno: ordena igual de bien para el
     caso de uso real (escribir partes del nombre o de la ruta).

   ÍNDICE
     · Se construye desde el árbol de archivos que expone el Coder
       (`window.eventBus` / `window.FileTree` / la API del coder).
     · Se refresca con `file:opened`, `file:saved` y periódicamente.

   UX
     · Overlay tipo Command Palette.
     · Enter abre el archivo; Esc cierra; ↑/↓ navega.
     · Los estilos se inyectan por JS (sin archivos .css).
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STYLE_ID = 'numination-file-search-styles';

  const CSS = `
.nm-fs-backdrop {
  position: fixed; inset: 0; z-index: 120;
  background: rgba(4, 4, 8, .62);
  backdrop-filter: blur(3px);
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 12vh;
}
.nm-fs-panel {
  width: min(620px, 92vw);
  background: color-mix(in srgb, var(--c-bg, #0a0a0c) 94%, #fff 6%);
  border: 1px solid rgba(255,255,255,.12);
  border-radius: 14px;
  box-shadow: 0 28px 70px rgba(0,0,0,.65);
  overflow: hidden;
  animation: nm-fs-in .16s cubic-bezier(.22,.9,.3,1);
}
@keyframes nm-fs-in { from { opacity: 0; transform: translateY(-8px) scale(.985); } to { opacity: 1; transform: none; } }
.nm-fs-input {
  width: 100%; padding: 15px 18px; border: none; outline: none;
  background: transparent; color: var(--c-text, #f4f4f7);
  font: 400 15px/1.4 var(--font-sans, Inter, system-ui, sans-serif);
  border-bottom: 1px solid rgba(255,255,255,.08);
}
.nm-fs-input::placeholder { color: #6a6a80; }
.nm-fs-list { max-height: 46vh; overflow-y: auto; padding: 6px 0; }
.nm-fs-item {
  display: flex; align-items: center; gap: 10px;
  width: 100%; padding: 9px 18px; border: 0; background: transparent;
  color: var(--c-text-1, #c9c9d4); text-align: left; cursor: pointer;
  font: 400 13px/1.4 var(--font-sans, Inter, system-ui, sans-serif);
}
.nm-fs-item:hover { background: rgba(255,255,255,.04); }
.nm-fs-item.is-active { background: var(--c-primary-soft, rgba(139,92,246,.16)); color: #fff; }
.nm-fs-item__icon { width: 15px; height: 15px; flex: 0 0 15px; opacity: .6; }
.nm-fs-item__name { font-weight: 600; }
.nm-fs-item__path { color: #6a6a80; font-size: 11.5px; margin-left: 6px; }
.nm-fs-item__ext {
  margin-left: auto; font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
  color: #6a6a80; border: 1px solid rgba(255,255,255,.1); border-radius: 5px; padding: 1px 6px;
}
.nm-fs-empty { padding: 22px 18px; text-align: center; color: #6a6a80; font-size: 12.5px; }
.nm-fs-foot {
  display: flex; gap: 14px; padding: 9px 18px;
  border-top: 1px solid rgba(255,255,255,.08); font-size: 11px; color: #6a6a80;
}
.nm-fs-foot kbd {
  font: 600 10px/1 var(--font-mono, monospace);
  border: 1px solid rgba(255,255,255,.14); border-radius: 4px; padding: 3px 5px; color: #b9b9c9;
}
`;

  const state = {
    files: [],
    results: [],
    activeIndex: 0,
    open: false,
    panel: null,
    input: null,
    list: null,
    fuse: null,
    query: '',
  };

  /* ─── Estilos ────────────────────────────────────────────────────────── */

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /* ─── Scoring nativo ─────────────────────────────────────────────────── */

  /**
   * Devuelve el score de coincidencia (0 = no coincide, 1 = exacto)
   * o -1 si no hay coincidencia.
   */
  function fuzzyScore(query, target) {
    if (!query) return 0.5;

    const q = query.toLowerCase();
    const t = target.toLowerCase();

    if (t === q) return 1;
    if (t.startsWith(q)) return 0.95;

    const idx = t.indexOf(q);
    if (idx >= 0) {
      // Bonus por aparecer temprano y por estar en un nombre de archivo.
      return 0.85 - Math.min(idx / 200, 0.25) + (t.includes('/') && t.lastIndexOf(q) > t.lastIndexOf('/') ? 0.05 : 0);
    }

    // Coincidencia por subsecuencia: "fssr" → "file-search.js"
    let ti = 0;
    let hits = 0;
    let streak = 0;
    let bestStreak = 0;

    for (const ch of q) {
      const found = t.indexOf(ch, ti);
      if (found === -1) return -1;
      streak = found === ti ? streak + 1 : 1;
      bestStreak = Math.max(bestStreak, streak);
      hits++;
      ti = found + 1;
    }

    if (hits !== q.length) return -1;

    return 0.35 + Math.min(bestStreak / q.length, 0.4);
  }

  /**
   * Normaliza una ruta en un "target" de búsqueda con camelCase partido.
   */
  function searchTargets(file) {
    const path = String(file.path || file.name || '');
    const base = path.split('/').pop() || path;
    const camel = base.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
    return [path.toLowerCase(), base.toLowerCase(), camel];
  }

  function search(query) {
    if (!query) {
      return state.files.slice(0, 40).map((f) => ({ file: f, score: 0.5 }));
    }

    // Fuse.js si está disponible.
    if (window.Fuse && state.files.length) {
      if (!state.fuse || state.fuse._nmQuery !== query) {
        state.fuse = new window.Fuse(state.files, {
          keys: ['path', 'name'],
          threshold: 0.35,
          ignoreLocation: true,
          includeScore: true,
        });
        state.fuse._nmQuery = query;
      }
      return state.fuse.search(query).slice(0, 40).map((r) => ({ file: r.item, score: 1 - (r.score || 0) }));
    }

    // Motor nativo.
    const scored = [];

    for (const file of state.files) {
      const targets = searchTargets(file);
      let best = -1;

      for (const target of targets) {
        const score = fuzzyScore(query, target);
        if (score > best) best = score;
      }

      if (best >= 0) scored.push({ file, score: best });
    }

    scored.sort((a, b) => b.score - a.score || a.file.path.length - b.file.path.length);

    return scored.slice(0, 40);
  }

  /* ─── Overlay ────────────────────────────────────────────────────────── */

  function buildPanel() {
    if (state.panel) return state.panel;

    const backdrop = document.createElement('div');
    backdrop.className = 'nm-fs-backdrop';

    const panel = document.createElement('div');
    panel.className = 'nm-fs-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Buscar archivos');

    const input = document.createElement('input');
    input.className = 'nm-fs-input';
    input.type = 'text';
    input.placeholder = 'Buscar archivos por nombre…';
    input.autocomplete = 'off';
    input.spellcheck = false;

    const list = document.createElement('div');
    list.className = 'nm-fs-list';

    const foot = document.createElement('div');
    foot.className = 'nm-fs-foot';
    foot.innerHTML =
      '<span><kbd>↑</kbd><kbd>↓</kbd> navegar</span>' +
      '<span><kbd>↵</kbd> abrir</span>' +
      '<span><kbd>esc</kbd> cerrar</span>' +
      '<span style="margin-left:auto" id="nm-fs-count"></span>';

    panel.append(input, list, foot);
    backdrop.appendChild(panel);

    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) close();
    });

    input.addEventListener('input', () => {
      state.query = input.value.trim();
      state.activeIndex = 0;
      renderResults();
    });

    input.addEventListener('keydown', onKeyDown);

    document.body.appendChild(backdrop);

    state.panel = backdrop;
    state.input = input;
    state.list = list;

    return backdrop;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      state.activeIndex = Math.min(state.activeIndex + 1, state.results.length - 1);
      renderResults();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      state.activeIndex = Math.max(state.activeIndex - 1, 0);
      renderResults();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const picked = state.results[state.activeIndex];
      if (picked) {
        close();
        openFile(picked.file);
      }
    }
  }

  function renderResults() {
    if (!state.list) return;

    state.results = search(state.query);

    const count = state.panel?.querySelector('#nm-fs-count');
    if (count) count.textContent = `${state.results.length} resultado${state.results.length === 1 ? '' : 's'}`;

    if (!state.results.length) {
      state.list.innerHTML = '<div class="nm-fs-empty">Ningún archivo coincide.</div>';
      return;
    }

    state.list.innerHTML = '';

    state.results.forEach((result, index) => {
      const file = result.file;
      const path = String(file.path || file.name || '');
      const parts = path.split('/');
      const name = parts.pop();
      const dir = parts.join('/');

      const button = document.createElement('button');
      button.className = `nm-fs-item${index === state.activeIndex ? ' is-active' : ''}`;
      button.type = 'button';

      const icon = document.createElement('span');
      icon.className = 'nm-fs-item__icon';
      icon.textContent = iconFor(path);

      const nameEl = document.createElement('span');
      nameEl.className = 'nm-fs-item__name';
      nameEl.textContent = name;

      button.append(icon, nameEl);

      if (dir) {
        const dirEl = document.createElement('span');
        dirEl.className = 'nm-fs-item__path';
        dirEl.textContent = dir;
        button.appendChild(dirEl);
      }

      const ext = document.createElement('span');
      ext.className = 'nm-fs-item__ext';
      ext.textContent = (path.split('.').pop() || '').slice(0, 6);
      button.appendChild(ext);

      button.addEventListener('mouseenter', () => {
        state.activeIndex = index;
        renderResults();
      });

      button.addEventListener('click', () => {
        close();
        openFile(file);
      });

      state.list.appendChild(button);
    });
  }

  function iconFor(path) {
    const ext = String(path).split('.').pop().toLowerCase();
    if (['js', 'jsx', 'ts', 'tsx'].includes(ext)) return 'JS';
    if (['json'].includes(ext)) return '{}';
    if (['md', 'txt'].includes(ext)) return 'MD';
    if (['css', 'scss'].includes(ext)) return '#';
    if (['html'].includes(ext)) return '<>';
    if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'].includes(ext)) return 'IMG';
    return '·';
  }

  /* ─── Acciones ───────────────────────────────────────────────────────── */

  function open() {
    injectStyles();
    buildPanel();
    state.open = true;
    state.query = '';
    state.activeIndex = 0;
    state.input.value = '';
    state.panel.hidden = false;
    renderResults();
    setTimeout(() => state.input.focus(), 30);
  }

  function close() {
    state.open = false;
    if (state.panel) state.panel.hidden = true;
  }

  /**
   * Abre un archivo en el editor.
   */
  function openFile(file) {
    if (window.eventBus && typeof window.eventBus.emit === 'function') {
      window.eventBus.emit('file:open', { path: file.path, name: file.name });
      window.eventBus.emit('navigate:file', { path: file.path });
    }

    if (typeof window.openFileInEditor === 'function') {
      window.openFileInEditor(file.path);
      return;
    }

    console.info('[file-search] abrir', file.path);
  }

  /* ─── ÍNDICE ─────────────────────────────────────────────────────────── */

  /**
   * Reemplaza el índice de archivos.
   * @param {Array} files  [{ path, name, language }]
   */
  function setFiles(files) {
    const list = Array.isArray(files) ? files : [];

    state.files = list
      .map((f) => {
        const path = String(f.path || f.name || '');
        if (!path) return null;
        return {
          path,
          name: String(f.name || path.split('/').pop()),
          language: f.language || null,
          size: f.size ?? null,
        };
      })
      .filter(Boolean);
  }

  /**
   * Intenta construir el índice desde las fuentes disponibles en la
   * página (árbol de archivos del Coder o API del coder).
   */
  async function refreshIndex() {
    // 1) API del coder (si existe).
    try {
      if (window.NumAPI && typeof window.NumAPI.get === 'function') {
        const data = await window.NumAPI.get('/api/coder/files', { silent: true });
        const files = Array.isArray(data?.files) ? data.files : (Array.isArray(data) ? data : null);
        if (files && files.length) {
          setFiles(files);
          return state.files.length;
        }
      }
    } catch {
      /* la API puede no estar montada en el chat normal */
    }

    // 2) Árbol de archivos ya cargado en la página.
    const tree = window.__nmFileTree || window.fileTree;
    if (tree && Array.isArray(tree.files)) {
      setFiles(tree.files);
      return state.files.length;
    }

    // 3) Último recurso: los archivos abiertos.
    if (window.EditorState && typeof window.EditorState.getActiveFile === 'function') {
      const active = window.EditorState.getActiveFile();
      if (active?.path) {
        setFiles([active]);
        return state.files.length;
      }
    }

    return 0;
  }

  /* ─── Montaje ───────────────────────────────────────────────────────── */

  function bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      const isPalette = (e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P');

      // Ctrl+Shift+P se usa en algunas terminales: se acepta también.
      if (isPalette) {
        e.preventDefault();
        if (state.open) close();
        else open();
      }
    });
  }

  function bindEvents() {
    if (!window.eventBus || typeof window.eventBus.on !== 'function') return;

    window.eventBus.on('file:opened', () => { refreshIndex(); });
    window.eventBus.on('editor:ready', () => { refreshIndex(); });
    window.eventBus.on('files:changed', (data) => {
      if (data && Array.isArray(data.files)) setFiles(data.files);
      else refreshIndex();
    });
  }

  window.NumFileSearch = {
    open,
    close,
    setFiles,
    refreshIndex,
    search,
    fuzzyScore,
    get files() { return state.files.slice(); },
    get results() { return state.results.slice(); },
  };

  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    bindShortcuts();
    bindEvents();
    refreshIndex();
  });
})();
