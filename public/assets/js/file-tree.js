/**
 * Numination · Modo Coder — file-tree.js
 * Explorador de archivos: pide el árbol a GET /api/coder/load, lo agrupa en
 * carpetas, y al hacer clic descarga el contenido → EditorState (Monaco).
 * Guarda vía POST /api/coder/save cuando escucha `file:save`.
 *
 * Contrato (Lote 2 lo implementa):
 *   GET  /api/coder/load           → { files: [{path, type, language, content?}] }
 *   GET  /api/coder/load?f=<path>  → { file: {path, language, content} }
 *   POST /api/coder/save           → { ok: true, path }
 *
 * Estados UI: loading (aria-busy) → vacío → carpetas → error con reintento.
 */
(function () {
  'use strict';

  const API = {
    load: '/api/coder/load',
    save: '/api/coder/save'
  };

  const treeEl = document.getElementById('file-tree');
  const refreshBtn = document.getElementById('btn-refresh-tree');
  const userEl = document.getElementById('explorer-user');

  /** @type {Map<string, {path:string, content?:string}>} archivos indexados por ruta */
  const fileIndex = new Map();
  /** @type {Set<string>} carpetas contraídas */
  const collapsed = new Set();
  /** @type {string|null} archivo activo */
  let activePath = null;
  /** @type {boolean} evita recargas solapadas (clic doble en "Recargar") */
  let isLoading = false;

  /* ═══ HTTP con errores explícitos ═══ */

  /**
   * Cliente unificado: usa `NumAPI` (api-client.js) cuando está disponible y
   * cae en un fetch directo si el módulo no se cargó (p.ej. uso aislado).
   * @param {string} url
   * @param {RequestInit & {timeoutMs?:number}} [options]
   * @returns {Promise<any>}
   */
  async function requestJson(url, options = {}) {
    if (window.NumAPI?.request) {
      return window.NumAPI.request(url, { silent: true, ...options });
    }
    let res;
    try {
      res = await fetch(url, {
        headers: { 'Accept': 'application/json', ...(options.headers || {}) },
        credentials: 'same-origin',
        ...options
      });
    } catch (networkErr) {
      throw new Error('Red no disponible: ' + networkErr.message);
    }
    let body = null;
    try { body = await res.json(); } catch { /* respuesta sin JSON */ }
    if (!res.ok) {
      const msg = body?.error || res.statusText || 'Error del servidor';
      throw Object.assign(new Error(`HTTP ${res.status}: ${msg}`), { status: res.status });
    }
    return body;
  }

  /** Recupera la sesión (contrato real: GET /api/auth/session → {ok, authenticated, user}). */
  async function loadSession() {
    try {
      const who = await requestJson('/api/auth/session');
      if (!who?.authenticated || !who?.user) {
        if (userEl) userEl.querySelector('.explorer__username').textContent = 'sin sesión';
        return;
      }
      const name = who.user.name || who.user.email?.split('@')[0] || 'sesión activa';
      if (userEl) {
        userEl.querySelector('.explorer__username').textContent = name;
        userEl.querySelector('.explorer__avatar').textContent = name.charAt(0).toUpperCase();
      }
    } catch {
      if (userEl) userEl.querySelector('.explorer__username').textContent = 'sin sesión';
    }
  }

  /* ═══ Modelado del árbol ═══ */

  /**
   * Normaliza la respuesta del backend y la separa por carpetas.
   * @param {Array<{path:string, type?:string, language?:string, content?:string}>} files
   * @returns {{ folders: Map<string, string[]>, loose: string[] }}
   */
  function groupByFolder(files) {
    const folders = new Map();
    const loose = [];
    for (const meta of files) {
      const path = String(meta.path || '').replace(/\\/g, '/');
      if (!path || path.includes('..')) continue; // guards contra rutas raras
      const idx = path.lastIndexOf('/');
      const folder = idx > 0 ? path.slice(0, idx) : '';
      if (folder) {
        if (!folders.has(folder)) folders.set(folder, []);
        folders.get(folder).push(path);
      } else {
        loose.push(path);
      }
    }
    return { folders, loose };
  }

  /** Marca de icono por extensión (unicode simple, sin emoji por accesibilidad). */
  function iconFor(path) {
    const ext = path.split('.').pop().toLowerCase();
    if (['js', 'mjs', 'cjs'].includes(ext)) return 'JS';
    if (['ts', 'tsx'].includes(ext)) return 'TS';
    if (ext === 'json') return '{}';
    if (['css', 'scss'].includes(ext)) return 'CS';
    if (['html', 'htm'].includes(ext)) return '<>';
    if (ext === 'md') return 'MD';
    return '••';
  }

  /**
   * @param {string} folder Ruta de carpeta ('' = raíz del proyecto).
   * @param {string[]} paths Archivos dentro (1 nivel).
   * @param {number} depth
   */
  function renderFolder(folder, paths, depth) {
    const isOpen = !collapsed.has(folder);
    const liFolder = document.createElement('li');
    liFolder.appendChild(buildRow(buildFolderRowCfg(folder), depth, () => {
      const willCollapse = !collapsed.has(folder);
      if (willCollapse) collapsed.add(folder); else collapsed.delete(folder);
      const nowOpen = !collapsed.has(folder);
      liFolder.classList.toggle('is-open', nowOpen);
      [...liFolder.querySelectorAll('ul')].forEach((ul) => { ul.hidden = !nowOpen; });
    }));

    const children = document.createElement('ul');
    children.hidden = !isOpen;
    for (const filePath of paths.sort()) {
      children.appendChild(renderFile(filePath, depth + 1));
    }
    liFolder.appendChild(children);
    return liFolder;
  }

  /**
   * @param {string} filePath
   * @param {number} depth
   */
  function renderFile(filePath, depth) {
    const li = document.createElement('li');
    li.appendChild(buildRow(
      { icon: iconFor(filePath), name: filePath.split('/').pop(), path: filePath },
      depth,
      () => openFile(filePath)
    ));
    return li;
  }

  /**
   * Config base de una fila de árbol.
   * @param {{icon:string, name:string, path:string, caret?:boolean}} cfg
   */
  function buildFolderRowCfg(folder) {
    return { icon: '', name: folder.split('/').pop(), path: folder, caret: true };
  }

  function buildRow(cfg, depth, onClick) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'tree-item';
    row.setAttribute('style-depth', String(depth));
    row.setAttribute('role', 'treeitem');
    row.setAttribute('data-path', cfg.path);

    if (cfg.icon === 'JS' || cfg.icon === 'CS') {
      const badge = document.createElement('span');
      badge.className = 'tree-item__icon';
      badge.textContent = cfg.icon;
      row.appendChild(badge);
      row.appendChild(span(cfg.name));
    } else {
      if (cfg.caret) row.appendChild(span('▸', 'tree-item__caret'));
      row.appendChild(span(cfg.name));
    }
    if (cfg.path === activePath) row.classList.add('is-active');
    row.addEventListener('click', () => onClick());
    return row;
  }

  function span(text, cls) {
    const el = document.createElement('span');
    if (cls) el.className = cls;
    else el.className = 'tree-item__name';
    el.textContent = text; // nunca innerHTML: los nombres son datos del usuario
    return el;
  }

  /* ═══ Acciones ═══ */

  /** Abre un archivo: usa caché o pide el contenido al backend. */
  async function openFile(path) {
    try {
      if (activePath) document.querySelector(`[data-path="${CSS.escape(activePath)}"]`)?.classList.remove('is-active');
      activePath = path;
      document.querySelector(`[data-path="${CSS.escape(path)}"]`)?.classList.add('is-active');

      let file = fileIndex.get(path);
      if (!file || typeof file.content !== 'string') {
        const data = await requestJson(`${API.load}?f=${encodeURIComponent(path)}`);
        file = data?.file;
        if (!file || typeof file.content !== 'string') throw new Error('El backend no devolvió contenido.');
        fileIndex.set(path, file);
      }
      window.EditorState.setValue({
        path: file.path || path,
        content: file.content,
        language: file.language || window.languageFromPath?.(path),
        isSaved: true
      });
      window.eventBus.emit('file:opened', { path, loaded: true });
    } catch (err) {
      console.error('[file-tree] openFile:', err);
      window.NuminToast.error(`No se pudo abrir “${path}”. ${err.message}`);
    }
  }

  /**
   * Guarda el archivo activo. Escuchado desde Ctrl+S emitido por el editor.
   * @param {{ path?: string }} data
   */
  async function saveActive({ path } = {}) {
    const target = path || window.EditorState.getActiveFile()?.path;
    const code = window.EditorState.getValue();
    if (!target || code === null) { window.NuminToast.info('No hay archivo activo que guardar.'); return; }

    try {
      window.EditorState.monacoInstance?.updateOptions({ readOnly: false }); // no-op preventivo
      const res = await requestJson(API.save, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: target, content: code })
      });
      if (res?.ok === false) throw new Error(res?.error || 'guardado rechazado');
      const cached = fileIndex.get(target);
      if (cached) cached.content = code; else fileIndex.set(target, { path: target, content: code });
      window.EditorState.markSaved();
      window.NuminToast.ok(`“${target}” guardado.`);
    } catch (err) {
      console.error('[file-tree] save:', err);
      window.NuminToast.error(`Guardado falló (${err.status || 'red'}): ${err.message}`);
    }
  }

  /** Pinta el árbol desde la respuesta del backend (o vista vacía). */
  function renderTree(files) {
    treeEl.textContent = '';
    if (!files.length) {
      const note = document.createElement('p');
      note.className = 'tree-note';
      note.textContent = 'Tu proyecto está vacío. Escribe código y pulsa Guardar para crear el primer archivo.';
      treeEl.appendChild(note);
      return;
    }
    const ul = document.createElement('ul');
    ul.setAttribute('role', 'tree');
    treeEl.appendChild(ul);

    const { folders, loose } = groupByFolder(files);
    for (const filePath of loose.sort()) ul.appendChild(renderFile(filePath, 0));
    for (const [folder, inPaths] of [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      ul.appendChild(renderFolder(folder, inPaths, 0));
    }
  }

  /* ═══ Ciclo de carga ═══ */

  async function refreshTree() {
    if (isLoading) return;
    isLoading = true;
    treeEl.setAttribute('aria-busy', 'true');
    try {
      const data = await requestJson(API.load);
      const files = [];
      for (const meta of data?.files || []) {
        files.push(meta);
        fileIndex.set(meta.path, meta); // pre-carga de contenidos si vienen inline
      }
      renderTree(files);
    } catch (err) {
      console.error('[file-tree] refresh:', err);
      treeEl.textContent = '';
      const note = document.createElement('p');
      note.className = 'tree-note';
      note.textContent = 'Sin conexión con el backend de archivos. Pulsa Recargar para reintentar.';
      treeEl.appendChild(note);
      window.NuminToast.error(`Explorador sin datos: ${err.message}`);
    } finally {
      isLoading = false;
      treeEl.removeAttribute('aria-busy');
    }
  }

  /* ═══ Arranque ═══ */
  refreshBtn?.addEventListener('click', refreshTree);
  document.getElementById('btn-save')?.addEventListener('click', () => {
    window.eventBus.emit('file:save', { path: window.EditorState?.getActiveFile?.()?.path });
  });
  window.eventBus.on('file:save', saveActive);
  window.eventBus.on('tree:refresh', refreshTree);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { loadSession(); refreshTree(); }, { once: true });
  } else {
    loadSession();
    refreshTree();
  }
})();
