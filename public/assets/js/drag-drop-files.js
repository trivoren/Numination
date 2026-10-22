/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · drag-drop-files.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Arrastrar y soltar archivos dentro del editor.

   FLUJO
     1. Escucha `dragover` / `dragleave` / `drop` sobre el host del editor.
     2. Filtra: solo archivos (no carpetas, no URLs).
     3. Lee el contenido con FileReader.
     4. Lo inyecta como una NUEVA PESTAÑA en el editor (evento
        `file:opened` con el path del archivo).
     5. Para archivos binarios (imágenes), genera un preview en base64 y
        una nota para no intentar editarlo como texto.

   SEGURIDAD
     · Límite de tamaño (2 MB por archivo) para no congelar el editor.
     · Límite de cantidad (5 archivos por drop).
     · El contenido se trata como TEXTO PLANO: se escribe con textContent
       en cualquier parte del DOM. Nunca se evalúa.
     · Se ignora el drag&drop de URLs (podría ser un phishing que
       "arrastra" una imagen externa).
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STYLE_ID = 'numination-drag-drop-styles';

  const CSS = `
.nm-dd-overlay {
  position: absolute; inset: 0; z-index: 60;
  display: none; align-items: center; justify-content: center;
  background: rgba(10,10,12,.82);
  border: 2px dashed rgba(139,92,246,.55);
  border-radius: 12px;
  pointer-events: none;
}
.nm-dd-overlay.is-active { display: flex; }
.nm-dd-overlay__box {
  text-align: center; color: #f4f4f7;
  font: 600 14px/1.5 var(--font-sans, Inter, system-ui, sans-serif);
}
.nm-dd-overlay__box span { display: block; font-size: 11.5px; color: #9a9aae; font-weight: 400; margin-top: 6px; }
.nm-dd-badge {
  position: absolute; right: 16px; bottom: 16px; z-index: 55;
  padding: 7px 12px; border-radius: 99px;
  background: rgba(139,92,246,.16); border: 1px solid rgba(139,92,246,.36);
  color: #c4b5fd; font: 600 11.5px/1 var(--font-sans, Inter, system-ui, sans-serif);
  opacity: 0; transform: translateY(6px); transition: opacity .18s ease, transform .18s ease;
}
.nm-dd-badge.is-visible { opacity: 1; transform: none; }
`;

  const CFG = {
    maxBytes: 2 * 1024 * 1024,
    maxFiles: 5,
    binaryExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'zip', 'mp3', 'mp4', 'woff', 'woff2', 'ttf', 'eot'],
  };

  const state = {
    host: null,
    overlay: null,
    badge: null,
    depth: 0,
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

  function toast(message, kind = 'info') {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
      return;
    }
    console.info('[drag-drop-files]', kind, message);
  }

  function extensionOf(name) {
    const parts = String(name || '').split('.');
    return parts.length > 1 ? parts.pop().toLowerCase() : '';
  }

  function isBinary(file) {
    if (CFG.binaryExtensions.includes(extensionOf(file.name))) return true;
    return Boolean(file.type && !file.type.startsWith('text/') && file.type !== 'application/json');
  }

  function readFile(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ ok: true, content: String(reader.result || '') });
      reader.onerror = () => resolve({ ok: false, error: reader.error?.message || 'No se pudo leer el archivo.' });
      reader.readAsText(file);
    });
  }

  function readAsDataUrl(file) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve({ ok: true, content: String(reader.result || '') });
      reader.onerror = () => resolve({ ok: false, error: 'No se pudo leer el archivo.' });
      reader.readAsDataURL(file);
    });
  }

  /* ─── Overlay ────────────────────────────────────────────────────────── */

  function ensureOverlay() {
    if (state.overlay && state.overlay.isConnected) return state.overlay;

    const container = document.getElementById('monaco-container') ||
      document.querySelector('.monaco-container');
    if (!container) return null;

    const host = container.parentElement || container;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    const overlay = document.createElement('div');
    overlay.className = 'nm-dd-overlay';

    const box = document.createElement('div');
    box.className = 'nm-dd-overlay__box';
    box.innerHTML = 'Soltá los archivos acá<span>Se abren como pestañas nuevas</span>';
    overlay.appendChild(box);

    const badge = document.createElement('div');
    badge.className = 'nm-dd-badge';

    host.append(overlay);
    host.append(badge);

    state.host = host;
    state.overlay = overlay;
    state.badge = badge;

    return overlay;
  }

  function showBadge(text) {
    if (!state.badge) return;
    state.badge.textContent = text;
    state.badge.classList.add('is-visible');
  }

  function hideBadge() {
    if (!state.badge) return;
    state.badge.classList.remove('is-visible');
  }

  /* ─── Apertura de archivos ───────────────────────────────────────────── */

  /**
   * Abre un archivo como pestaña nueva.
   */
  function openAsTab(file, content, { isBinary = false } = {}) {
    const path = file.name;

    if (window.eventBus && typeof window.eventBus.emit === 'function') {
      window.eventBus.emit('file:opened', {
        path,
        name: file.name,
        code: content,
        language: isBinary ? 'plaintext' : detectLanguage(path),
        isSaved: false,
        isBinary,
      });
      window.eventBus.emit('file:dropped', { path, name: file.name, bytes: file.size });
    }

    if (typeof window.openFileInEditor === 'function') {
      window.openFileInEditor(path, content);
    }
  }

  function detectLanguage(path) {
    const ext = extensionOf(path);
    const map = {
      js: 'javascript', jsx: 'javascript', mjs: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      json: 'json', css: 'css', scss: 'scss', html: 'html',
      md: 'markdown', py: 'python', go: 'go', rs: 'rust', java: 'java',
      php: 'php', rb: 'ruby', sh: 'shell', yml: 'yaml', yaml: 'yaml',
    };
    return map[ext] || 'plaintext';
  }

  /* ─── Procesamiento ─────────────────────────────────────────────────── */

  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);

    if (!files.length) return;

    const accepted = files.slice(0, CFG.maxFiles);

    if (files.length > CFG.maxFiles) {
      toast(`Sólo se abren los primeros ${CFG.maxFiles} archivos.`, 'info');
    }

    let opened = 0;

    for (const file of accepted) {
      if (file.size > CFG.maxBytes) {
        toast(`"${file.name}" supera los 2 MB.`, 'error');
        continue;
      }

      if (isBinary(file)) {
        const data = await readAsDataUrl(file);
        if (!data.ok) {
          toast(`No se pudo leer "${file.name}".`, 'error');
          continue;
        }
        openAsTab(file, `// Archivo binario (${file.type || 'application/octet-stream'})\n// ${file.size} bytes\n// ${data.content.slice(0, 200)}…`, { isBinary: true });
        opened++;
        continue;
      }

      const read = await readFile(file);
      if (!read.ok) {
        toast(`No se pudo leer "${file.name}".`, 'error');
        continue;
      }

      openAsTab(file, read.content, { isBinary: false });
      opened++;
    }

    if (opened) {
      toast(`${opened} archivo${opened === 1 ? '' : 's'} abierto${opened === 1 ? '' : 's'}.`, 'ok');
    }
  }

  /* ─── Eventos ────────────────────────────────────────────────────────── */

  function hasFiles(event) {
    const dt = event.dataTransfer;
    if (!dt) return false;

    // Se ignoran los drags de texto plano y las URLs.
    if (dt.types && Array.from(dt.types).includes('text/uri-list')) return false;

    return Array.from(dt.items || []).some((item) => item.kind === 'file');
  }

  function onDragEnter(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    state.depth++;
    const overlay = ensureOverlay();
    if (overlay) overlay.classList.add('is-active');
  }

  function onDragOver(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';

    const overlay = ensureOverlay();
    if (overlay) overlay.classList.add('is-active');
  }

  function onDragLeave(e) {
    if (!hasFiles(e)) return;
    state.depth = Math.max(0, state.depth - 1);
    if (state.depth === 0 && state.overlay) state.overlay.classList.remove('is-active');
  }

  function onDrop(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();

    state.depth = 0;
    if (state.overlay) state.overlay.classList.remove('is-active');

    const files = e.dataTransfer.files;
    if (!files || !files.length) return;

    showBadge(`Abriendo ${files.length} archivo${files.length === 1 ? '' : 's'}…`);
    handleFiles(files).finally(() => {
      setTimeout(hideBadge, 1400);
    });
  }

  /* ─── Montaje ────────────────────────────────────────────────────────── */

  function mount() {
    if (state.mounted) return true;

    const container = document.getElementById('monaco-container') ||
      document.querySelector('.monaco-container') ||
      document.querySelector('[data-editor-host]');

    if (!container) return false;

    injectStyles();

    const host = container.parentElement || container;

    host.addEventListener('dragenter', onDragEnter);
    host.addEventListener('dragover', onDragOver);
    host.addEventListener('dragleave', onDragLeave);
    host.addEventListener('drop', onDrop);

    state.mounted = true;
    state.host = host;

    return true;
  }

  window.NumDragDropFiles = {
    mount,
    handleFiles,
    openAsTab,
    detectLanguage,
    get maxBytes() { return CFG.maxBytes; },
  };

  document.addEventListener('DOMContentLoaded', () => {
    if (!mount() && window.eventBus && typeof window.eventBus.on === 'function') {
      window.eventBus.on('editor:ready', () => mount());
    }
  });
})();
