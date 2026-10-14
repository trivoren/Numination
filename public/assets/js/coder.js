/* ═══════════════════════════════════════════════════════════════════════════
   coder.js · v2.0
   ─────────────────────────────────────────────────────────────────────────
   Controlador del editor Coder de Numination.

   FUNCIONALIDAD REAL:
     · Chat con streaming al backend (crea archivos con IA)
     · Parser de code blocks → archivos del proyecto
     · Editor de archivos con line numbers
     · Análisis de dependencias (imports/requires/links reales)
     · Preview compilado desde archivos reales
     · Undo/redo por archivo
     · Búsqueda global
     · Sincronización con backend (chats)
     · Sistema de temas
     · Atajos de teclado
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════
     01 · CONFIGURACIÓN
     ═══════════════════════════════════════════════════════════════════════ */

  var CFG = {
    // Keys de localStorage
    PROJECTS_KEY: 'numination-projects-v11',
    ACTIVE_KEY:   'numination-active-project-v11',
    FILES_KEY:    'numination-project-files-v11',
    CONTENTS_KEY: 'numination-project-contents-v11',
    RELATIONS_KEY:'numination-project-relations-v11',
    CHATMAP_KEY:  'numination-coder-chats-v1',
    THEME_KEY:    'numination-theme',
    HISTORY_KEY:  'numination-coder-history-v1',

    // Timing
    TOAST_DURATION:      3200,
    PREVIEW_LOAD_DELAY:  900,
    AUTOSAVE_DEBOUNCE:   600,
    UNDO_MAX_STACK:      50,

    // Endpoints
    API_CHAT:    '/api/chat/stream',
    API_CHATS:   '/api/chats',

    // Extensiones
    EXT_LANG: {
      js: 'javascript', jsx: 'jsx', ts: 'typescript', tsx: 'tsx',
      mjs: 'javascript', cjs: 'javascript',
      html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
      css: 'css', scss: 'scss', sass: 'sass', less: 'less',
      json: 'json', md: 'markdown', txt: 'text',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
      java: 'java', c: 'c', cpp: 'cpp', cs: 'csharp',
      php: 'php', swift: 'swift', kt: 'kotlin',
      yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
      sh: 'shell', sql: 'sql',
    },

    // Categorías para el arquitecto
    CAT_CORE:    ['js','jsx','ts','tsx','mjs','cjs','html','htm','vue','svelte','py','rb','go','rs','java','c','cpp','cs','php','swift','kt'],
    CAT_DATA:    ['json','csv','xml','yaml','yml','toml','txt','md','sql'],
    CAT_STYLE:   ['css','scss','sass','less'],

    // Códigos que Numi reconoce como bloques de archivo
    FILE_BLOCK_PATTERNS: [
      // ```lang filename.ext\n code ```
      /```([a-zA-Z0-9+#]+)?\s+([\w\-\/\.\\]+\.\w+)\n([\s\S]*?)```/g,
      // **filename.ext**\n```lang\n code ```
      /\*\*([\w\-\/\.\\]+\.\w+)\*\*\s*\n\s*```([a-zA-Z0-9+#]*)\n([\s\S]*?)```/g,
      // ## filename.ext\n```lang\n code ```
      /#{1,3}\s+([\w\-\/\.\\]+\.\w+)\s*\n\s*```([a-zA-Z0-9+#]*)\n([\s\S]*?)```/g,
    ],
  };

  /* ═══════════════════════════════════════════════════════════════════════
     02 · ESTADO
     ═══════════════════════════════════════════════════════════════════════ */

  var S = {
    // Proyecto
    project: null,
    files: [],          // [{name, ext, size, content, modified}]
    activeFile: null,   // nombre del archivo abierto
    editorMode: false,  // si el editor está visible

    // Chat
    chatId: null,
    messages: [],       // [{role, content, ts}]
    isGenerating: false,
    abortCtrl: null,

    // Preview
    previewState: 'idle',  // idle | loading | ready | error
    previewTimeoutId: null,

    // Undo
    history: {},        // { fileName: [content1, content2, ...] }
    historyIndex: {},   // { fileName: pos }
    lastSave: 0,

    // UI
    sideMenuOpen: false,
    editorDirty: false,

    // Search
    searchQuery: '',
    searchResults: [],
  };

  /* ═══════════════════════════════════════════════════════════════════════
     03 · UTILIDADES
     ═══════════════════════════════════════════════════════════════════════ */

  var $ = function (sel, ctx) { return (ctx || document).querySelector(sel); };
  var $$ = function (sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); };

  function storeRead(key, fallback) {
    try {
      var v = localStorage.getItem(key);
      return v ? JSON.parse(v) : (fallback !== undefined ? fallback : null);
    } catch (e) {
      return fallback !== undefined ? fallback : null;
    }
  }

  function storeWrite(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      return false;
    }
  }

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function getExt(name) {
    var m = String(name || '').match(/\.([a-zA-Z0-9]+)$/);
    return m ? m[1].toLowerCase() : '';
  }

  function getLang(name) {
    return CFG.EXT_LANG[getExt(name)] || 'text';
  }

  function shortPath(name) {
    if (!name) return '';
    if (name.length <= 32) return name;
    return '…' + name.slice(-30);
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function formatTime(ts) {
    var d = new Date(ts);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function debounce(fn, ms) {
    var timer;
    return function () {
      var args = arguments;
      var ctx = this;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  function throttle(fn, ms) {
    var last = 0;
    return function () {
      var now = Date.now();
      if (now - last < ms) return;
      last = now;
      fn.apply(this, arguments);
    };
  }

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function normalizePath(p) {
    return String(p || '')
      .replace(/\\/g, '/')
      .replace(/^\.?\//, '')
      .replace(/\/+/g, '/')
      .trim();
  }

  function sanitizeFileName(name) {
    return normalizePath(name)
      .replace(/[<>:"|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, '-')
      .slice(0, 120);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     04 · TOAST
     ═══════════════════════════════════════════════════════════════════════ */

  var toastHost = null;
  var activeToasts = new Map();

  function initToasts() {
    toastHost = document.getElementById('coder-toasts');
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'toasts';
      toastHost.id = 'coder-toasts';
      document.body.appendChild(toastHost);
    }
  }

  function dismissToast(id) {
    var entry = activeToasts.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.el.style.transition = 'opacity .3s, transform .3s';
    entry.el.style.opacity = '0';
    entry.el.style.transform = 'translateY(16px)';
    setTimeout(function () { entry.el.remove(); }, 320);
    activeToasts.delete(id);
  }

  function toast(kind, msg, ttl) {
    if (!toastHost) return;
    if (activeToasts.size >= 4) dismissToast(activeToasts.keys().next().value);

    var id = uid('toast');
    var el = document.createElement('div');
    el.className = 'toast toast--' + kind;
    var icons = { ok: '✓', err: '✕', info: 'ⓘ', warn: '⚠' };
    el.innerHTML = '<span class="toast__icon">' + (icons[kind] || '') + '</span><span>' + escapeHtml(msg) + '</span>';
    toastHost.appendChild(el);

    var duration = ttl || (kind === 'err' ? 5000 : 3200);
    var timer = setTimeout(function () { dismissToast(id); }, duration);
    el.addEventListener('click', function () { dismissToast(id); }, { once: true });

    activeToasts.set(id, { el: el, timer: timer });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     05 · UNDO / REDO STACK
     ═══════════════════════════════════════════════════════════════════════ */

  function pushHistory(fileName, content) {
    if (!fileName) return;
    if (!S.history[fileName]) S.history[fileName] = [];
    if (!S.historyIndex[fileName]) S.historyIndex[fileName] = -1;

    var stack = S.history[fileName];
    var idx = S.historyIndex[fileName];

    // Si estamos en medio del stack, cortar lo de adelante
    if (idx < stack.length - 1) stack.splice(idx + 1);

    // No duplicar si es igual al último
    if (stack[stack.length - 1] === content) return;

    stack.push(content);
    if (stack.length > CFG.UNDO_MAX_STACK) stack.shift();
    S.historyIndex[fileName] = stack.length - 1;
  }

  function undo(fileName) {
    if (!fileName) return null;
    var stack = S.history[fileName];
    if (!stack) return null;
    var idx = S.historyIndex[fileName];
    if (idx <= 0) return null;
    S.historyIndex[fileName] = idx - 1;
    return stack[idx - 1];
  }

  function redo(fileName) {
    if (!fileName) return null;
    var stack = S.history[fileName];
    if (!stack) return null;
    var idx = S.historyIndex[fileName];
    if (idx >= stack.length - 1) return null;
    S.historyIndex[fileName] = idx + 1;
    return stack[idx + 1];
  }

  function persistHistory() {
    // Solo guardamos las últimas 10 versiones por archivo para no llenar el storage
    var compacted = {};
    Object.keys(S.history).forEach(function (fn) {
      var stack = S.history[fn];
      compacted[fn] = stack.slice(-10);
    });
    storeWrite(CFG.HISTORY_KEY, compacted);
  }

  function loadPersistedHistory() {
    var saved = storeRead(CFG.HISTORY_KEY, {}) || {};
    Object.keys(saved).forEach(function (fn) {
      S.history[fn] = saved[fn] || [];
      S.historyIndex[fn] = S.history[fn].length - 1;
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     06 · MARKDOWN RENDERER
     ═══════════════════════════════════════════════════════════════════════ */

  function mdRender(text) {
    var h = escapeHtml(String(text || ''));

    // Code blocks con metadata
    h = h.replace(/```([\w+#-]+)?\s*([\w\-\/\.]+\.\w+)?\n([\s\S]*?)```/g, function (m, lang, fname, code) {
      var l = (lang || 'texto').toLowerCase();
      var meta = fname ? '<span class="md-file-name">' + escapeHtml(fname) + '</span>' : '';
      var enc = encodeURIComponent(code.trim());
      return '<div class="md-pre-head"><span class="md-lang">' + escapeHtml(l) + '</span>' + meta +
             '<button type="button" class="md-pre-copy" data-copy="' + enc + '">Copiar</button></div>' +
             '<pre><code class="lang-' + escapeHtml(l) + '">' + code.trim() + '</code></pre>';
    });

    // Code blocks simples
    h = h.replace(/```(\w+)?\n?([\s\S]*?)```/g, function (m, lang, code) {
      var l = lang || 'texto';
      var enc = encodeURIComponent(code.trim());
      return '<div class="md-pre-head"><span class="md-lang">' + escapeHtml(l) + '</span>' +
             '<button type="button" class="md-pre-copy" data-copy="' + enc + '">Copiar</button></div>' +
             '<pre><code class="lang-' + escapeHtml(l) + '">' + code.trim() + '</code></pre>';
    });

    // Inline code
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');

    // Bold / italic
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

    // Links
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    // Headings
    h = h.replace(/^#### (.+)$/gm, '<h5>$1</h5>');
    h = h.replace(/^### (.+)$/gm, '<h4>$1</h4>');
    h = h.replace(/^## (.+)$/gm, '<h3>$1</h3>');
    h = h.replace(/^# (.+)$/gm, '<h2>$1</h2>');

    // Blockquotes
    h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Lists
    h = h.replace(/^[\-\*]\s+(.+)$/gm, '<li>$1</li>');
    h = h.replace(/(<li>[\s\S]*?<\/li>)(?=\s*<(?!li))/g, '<ul>$1</ul>');

    // Horizontal rules
    h = h.replace(/^---$/gm, '<hr>');

    // Line breaks
    h = h.replace(/\n/g, '<br>');
    h = h.replace(/<br>(<(?:ul|ol|pre|blockquote|h[2-5]|li|div|hr))/g, '$1');
    h = h.replace(/(<\/(?:ul|ol|pre|blockquote|h[2-5]|li|div|hr)>)<br>/g, '$1');

    return h;
  }

  function mdEnhance(root) {
    if (!root) return;
    root.querySelectorAll('.md-pre-copy').forEach(function (btn) {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () {
        var code = decodeURIComponent(btn.dataset.copy || '');
        navigator.clipboard.writeText(code).then(function () {
          var orig = btn.textContent;
          btn.textContent = 'Copiado';
          btn.classList.add('is-copied');
          setTimeout(function () {
            btn.textContent = orig;
            btn.classList.remove('is-copied');
          }, 1400);
        }).catch(function () {
          toast('err', 'No se pudo copiar');
        });
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     07 · PARSER DE ARCHIVOS DESDE RESPUESTA DE IA
     ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Extrae archivos del texto de la respuesta de Numi.
   * Soporta múltiples formatos:
   *   ```lang filename.ext\n...\n```
   *   **filename.ext**\n```lang\n...\n```
   *   ### filename.ext\n```lang\n...\n```
   */
  function extractFilesFromResponse(text) {
    if (!text) return [];
    var out = [];
    var seen = Object.create(null);

    // Patrón 1: ```lang filename.ext
    var re1 = /```([a-zA-Z0-9+#]*)\s+([\w\-\/\.]+\.\w+)\s*\n([\s\S]*?)```/g;
    var m;
    while ((m = re1.exec(text)) !== null) {
      var name = normalizePath(m[2]);
      if (!name || seen[name]) continue;
      // Ignorar si "name" parece un lenguaje
      if (CFG.EXT_LANG[name]) continue;
      seen[name] = 1;
      out.push({
        name: name,
        content: m[3].trim(),
        lang: m[1] || getLang(name),
      });
    }

    // Patrón 2: **filename.ext**\n```lang
    var re2 = /\*\*([\w\-\/\.]+\.\w+)\*\*\s*\n\s*```([a-zA-Z0-9+#]*)\n([\s\S]*?)```/g;
    while ((m = re2.exec(text)) !== null) {
      var n2 = normalizePath(m[1]);
      if (!n2 || seen[n2]) continue;
      seen[n2] = 1;
      out.push({
        name: n2,
        content: m[3].trim(),
        lang: m[2] || getLang(n2),
      });
    }

    // Patrón 3: ### filename.ext\n```lang
    var re3 = /#{1,4}\s+([\w\-\/\.]+\.\w+)\s*\n\s*```([a-zA-Z0-9+#]*)\n([\s\S]*?)```/g;
    while ((m = re3.exec(text)) !== null) {
      var n3 = normalizePath(m[1]);
      if (!n3 || seen[n3]) continue;
      seen[n3] = 1;
      out.push({
        name: n3,
        content: m[3].trim(),
        lang: m[2] || getLang(n3),
      });
    }

    return out;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     08 · PARSER DE IMPORTS (para el mapa de dependencias)
     ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Extrae las dependencias de un archivo según su contenido.
   * Detecta imports ES6, requires, links HTML, @import CSS, etc.
   */
  function analyzeDependencies(fileName, content) {
    var deps = [];
    if (!content) return deps;

    var ext = getExt(fileName);

    // JavaScript / TypeScript
    if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].indexOf(ext) !== -1) {
      var patterns = [
        /import\s+(?:[\w\*\s{},]+\s+from\s+)?['"]([^'"]+)['"]/g,
        /import\(['"]([^'"]+)['"]\)/g,
        /require\(['"]([^'"]+)['"]\)/g,
        /export\s+(?:[\w\*\s{},]+\s+from\s+)?['"]([^'"]+)['"]/g,
      ];
      patterns.forEach(function (re) {
        var m;
        while ((m = re.exec(content)) !== null) {
          deps.push({ target: m[1], type: 'import' });
        }
      });
    }

    // HTML
    if (['html', 'htm'].indexOf(ext) !== -1) {
      var linkRe = /<link[^>]+href=["']([^"']+)["']/g;
      var scriptRe = /<script[^>]+src=["']([^"']+)["']/g;
      var imgRe = /<img[^>]+src=["']([^"']+)["']/g;
      var aRe = /<a[^>]+href=["']([^"']+)["']/g;
      var m;
      while ((m = linkRe.exec(content)) !== null) deps.push({ target: m[1], type: 'link' });
      while ((m = scriptRe.exec(content)) !== null) deps.push({ target: m[1], type: 'script' });
      while ((m = imgRe.exec(content)) !== null) deps.push({ target: m[1], type: 'img' });
      while ((m = aRe.exec(content)) !== null) {
        if (!m[1].startsWith('http') && !m[1].startsWith('#') && !m[1].startsWith('mailto:')) {
          deps.push({ target: m[1], type: 'link' });
        }
      }
    }

    // CSS
    if (['css', 'scss', 'sass', 'less'].indexOf(ext) !== -1) {
      var importRe = /@import\s+['"]([^'"]+)['"]/g;
      var urlRe = /url\(['"]?([^'"\)]+)['"]?\)/g;
      var m;
      while ((m = importRe.exec(content)) !== null) deps.push({ target: m[1], type: 'import' });
      while ((m = urlRe.exec(content)) !== null) {
        if (!m[1].startsWith('data:')) deps.push({ target: m[1], type: 'url' });
      }
    }

    // Normalizar y deduplicar
    var seen = {};
    return deps.filter(function (d) {
      var key = d.type + ':' + d.target;
      if (seen[key]) return false;
      seen[key] = 1;
      return true;
    });
  }

  /**
   * Construye el grafo completo del proyecto.
   * Devuelve:
   *   { nodes: [fileName, ...], edges: [{from, to, type}, ...], incoming: {file: []}, outgoing: {file: []} }
   */
  function buildDependencyGraph() {
    var graph = {
      nodes: [],
      edges: [],
      incoming: {},
      outgoing: {},
    };

    S.files.forEach(function (f) {
      graph.nodes.push(f.name);
      graph.incoming[f.name] = [];
      graph.outgoing[f.name] = [];
    });

    var lookup = {};
    S.files.forEach(function (f) { lookup[f.name] = f; });

    S.files.forEach(function (f) {
      var deps = analyzeDependencies(f.name, f.content || '');
      deps.forEach(function (d) {
        var target = normalizePath(d.target);
        // Resolver el target a un archivo del proyecto
        var resolved = resolveDependency(target, f.name);
        if (resolved && resolved !== f.name) {
          graph.edges.push({ from: f.name, to: resolved, type: d.type });
          graph.outgoing[f.name].push({ to: resolved, type: d.type });
          graph.incoming[resolved].push({ from: f.name, type: d.type });
        }
      });
    });

    return graph;
  }

  /**
   * Intenta resolver un import relativo a un archivo del proyecto.
   */
  function resolveDependency(target, fromFile) {
    if (!target) return null;

    // Quitar ./ y ../
    var clean = target.replace(/^\.?\//, '');

    // Si existe exactamente
    if (S.files.some(function (f) { return f.name === clean; })) return clean;

    // Probar por basename
    var basename = clean.split('/').pop();
    var found = S.files.find(function (f) {
      return f.name === basename || f.name.split('/').pop() === basename;
    });
    if (found) return found.name;

    // Probar con extensiones comunes
    var exts = ['', '.js', '.jsx', '.ts', '.tsx', '.css', '.json', '.html'];
    for (var i = 0; i < exts.length; i++) {
      var candidate = clean + exts[i];
      var match = S.files.find(function (f) { return f.name === candidate; });
      if (match) return match.name;
    }

    // Probar con /index
    var idxCandidate = clean.replace(/\/$/, '') + '/index.js';
    var idxMatch = S.files.find(function (f) { return f.name === idxCandidate; });
    if (idxMatch) return idxMatch.name;

    return null;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     09 · CARGA Y GUARDADO DEL PROYECTO
     ═══════════════════════════════════════════════════════════════════════ */

  function loadProject() {
    var params = new URLSearchParams(location.search);
    var projectId = params.get('project');
    var projects = storeRead(CFG.PROJECTS_KEY, []) || [];

    if (projectId) {
      S.project = projects.find(function (p) { return p.id === projectId; }) || null;
    }
    if (!S.project) {
      var activeId = storeRead(CFG.ACTIVE_KEY, null);
      if (activeId) S.project = projects.find(function (p) { return p.id === activeId; }) || null;
    }
    if (!S.project && projects.length > 0) S.project = projects[0];

    if (!S.project) {
      toast('warn', 'No hay proyecto activo. Volviendo…');
      setTimeout(function () { location.href = '/chat'; }, 1200);
      return null;
    }

    // Cargar archivos
    var allFiles = storeRead(CFG.FILES_KEY, {}) || {};
    var fileNames = allFiles[S.project.id] || [];

    // Cargar contenidos
    var allContents = storeRead(CFG.CONTENTS_KEY, {}) || {};
    var contents = allContents[S.project.id] || {};

    S.files = fileNames.map(function (name) {
      var content = contents[name] || '';
      return {
        name: name,
        ext: getExt(name),
        size: content.length,
        content: content,
        modified: false,
      };
    });

    // Cargar chat asociado
    var chatmap = storeRead(CFG.CHATMAP_KEY, {}) || {};
    S.chatId = chatmap[S.project.id] || null;

    // Cargar historial
    loadPersistedHistory();

    return S.project;
  }

  function saveProject() {
    if (!S.project) return;

    var allFiles = storeRead(CFG.FILES_KEY, {}) || {};
    allFiles[S.project.id] = S.files.map(function (f) { return f.name; });
    storeWrite(CFG.FILES_KEY, allFiles);

    var allContents = storeRead(CFG.CONTENTS_KEY, {}) || {};
    var map = {};
    S.files.forEach(function (f) { map[f.name] = f.content || ''; });
    allContents[S.project.id] = map;
    storeWrite(CFG.CONTENTS_KEY, allContents);

    S.lastSave = Date.now();
  }

  function saveChatMap() {
    if (!S.project || !S.chatId) return;
    var map = storeRead(CFG.CHATMAP_KEY, {}) || {};
    map[S.project.id] = S.chatId;
    storeWrite(CFG.CHATMAP_KEY, map);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     10 · OPERACIONES DE ARCHIVOS
     ═══════════════════════════════════════════════════════════════════════ */

  function findFile(name) {
    return S.files.find(function (f) { return f.name === name; });
  }

  function upsertFile(fileInfo, opts) {
    opts = opts || {};
    var name = sanitizeFileName(fileInfo.name);
    if (!name) return null;

    var existing = findFile(name);
    if (existing) {
      if (opts.force || existing.content !== fileInfo.content) {
        pushHistory(name, existing.content);
        existing.content = fileInfo.content;
        existing.size = fileInfo.content.length;
        existing.modified = true;
      }
      return existing;
    }

    var newFile = {
      name: name,
      ext: getExt(name),
      size: fileInfo.content.length,
      content: fileInfo.content,
      modified: true,
    };
    S.files.push(newFile);
    pushHistory(name, fileInfo.content);
    return newFile;
  }

  function deleteFile(name) {
    var idx = S.files.findIndex(function (f) { return f.name === name; });
    if (idx === -1) return false;
    S.files.splice(idx, 1);
    delete S.history[name];
    delete S.historyIndex[name];
    if (S.activeFile === name) S.activeFile = null;
    saveProject();
    return true;
  }

  function renameFile(oldName, newName) {
    var f = findFile(oldName);
    if (!f) return false;
    var clean = sanitizeFileName(newName);
    if (!clean || findFile(clean)) return false;

    f.name = clean;
    f.ext = getExt(clean);

    // Mover historial
    if (S.history[oldName]) {
      S.history[clean] = S.history[oldName];
      S.historyIndex[clean] = S.historyIndex[oldName];
      delete S.history[oldName];
      delete S.historyIndex[oldName];
    }

    if (S.activeFile === oldName) S.activeFile = clean;
    saveProject();
    return true;
  }

  function createEmptyFile(name) {
    var clean = sanitizeFileName(name);
    if (!clean) { toast('warn', 'Nombre inválido'); return null; }
    if (findFile(clean)) { toast('warn', 'Ya existe: ' + clean); return null; }

    var defaultContent = getDefaultContent(clean);
    var f = upsertFile({ name: clean, content: defaultContent }, { force: true });
    saveProject();
    return f;
  }

  function getDefaultContent(name) {
    var ext = getExt(name);
    if (ext === 'html') return '<!DOCTYPE html>\n<html lang="es">\n<head>\n  <meta charset="UTF-8">\n  <title>' + name + '</title>\n</head>\n<body>\n  <h1>Hola mundo</h1>\n</body>\n</html>';
    if (ext === 'css') return 'body {\n  font-family: system-ui, sans-serif;\n}\n';
    if (ext === 'js') return 'console.log("Hola desde ' + name + '");\n';
    if (ext === 'json') return '{\n  "name": "' + name + '"\n}\n';
    if (ext === 'md') return '# ' + name + '\n\n';
    return '';
  }

  /* ═══════════════════════════════════════════════════════════════════════
     11 · RENDERIZADO · TOPBAR
     ═══════════════════════════════════════════════════════════════════════ */

  function renderTopbar() {
    var name = S.project.name || 'Mi proyecto';
    $$('[data-project-name]').forEach(function (el) { el.textContent = name; });
    $$('[data-menu-project-name]').forEach(function (el) { el.textContent = name; });
    var sub = $('[data-project-sub]');
    if (sub) sub.textContent = S.files.length + ' archivo' + (S.files.length === 1 ? '' : 's');
  }

  /* ═══════════════════════════════════════════════════════════════════════
     12 · RENDERIZADO · PREVIEW CARD
     ═══════════════════════════════════════════════════════════════════════ */

  function renderPreviewCard() {
    var descEl = $('[data-preview-desc]');
    var badgeEl = $('[data-preview-badge]');
    if (!badgeEl) return;

    var hasHtml = S.files.some(function (f) { return f.ext === 'html' || f.ext === 'htm'; });

    if (hasHtml) {
      badgeEl.textContent = 'Listo';
      badgeEl.className = 'preview-card__badge';
      if (descEl) descEl.textContent = 'Abrí la versión actual de tu proyecto.';
    } else if (S.files.length === 0) {
      badgeEl.textContent = 'Vacío';
      badgeEl.className = 'preview-card__badge is-pending';
      if (descEl) descEl.textContent = 'Pedile a Numi que cree tu primer archivo.';
    } else {
      badgeEl.textContent = 'Sin HTML';
      badgeEl.className = 'preview-card__badge is-pending';
      if (descEl) descEl.textContent = 'Todavía no hay un index.html.';
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     13 · RENDERIZADO · PANEL DE ARCHIVOS
     ═══════════════════════════════════════════════════════════════════════ */

  function fileIconSvg(name) {
    var ext = getExt(name);
    if (['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs'].indexOf(ext) !== -1) {
      return '<svg class="file-row__icon" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
    }
    if (['html', 'htm'].indexOf(ext) !== -1) {
      return '<svg class="file-row__icon" viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
    }
    if (['css', 'scss', 'sass', 'less'].indexOf(ext) !== -1) {
      return '<svg class="file-row__icon" viewBox="0 0 24 24"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>';
    }
    return '<svg class="file-row__icon" viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  }

  function renderFiles() {
    var listEl = $('[data-files-list]');
    if (!listEl) return;
    listEl.innerHTML = '';

    if (S.files.length === 0) {
      listEl.innerHTML = '<div class="files-panel__empty">Sin archivos todavía. Pedile a Numi que cree uno.</div>';
      return;
    }

    var sorted = S.files.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });

    sorted.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'file-row' + (S.activeFile === f.name ? ' is-active' : '');
      row.setAttribute('data-file', f.name);

      var badge = f.modified
        ? '<span class="file-row__badge">nuevo</span>'
        : '';

      row.innerHTML =
        fileIconSvg(f.name) +
        '<div class="file-row__name">' + escapeHtml(f.name) + '</div>' +
        badge +
        '<div class="file-row__meta">' + formatBytes(f.size) + '</div>';

      row.addEventListener('click', function () {
        S.activeFile = f.name;
        renderFiles();
        openFileInEditor(f.name);
      });

      row.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        showFileContextMenu(e, f.name);
      });

      listEl.appendChild(row);
    });
  }

  function toggleFilesPanel() {
    var panel = $('[data-files-panel]');
    var btn = $('[data-toggle-files]');
    if (!panel) return;
    var isOpen = panel.classList.toggle('is-open');
    if (btn) btn.classList.toggle('is-open', isOpen);
  }

  function openFilesPanel() {
    var panel = $('[data-files-panel]');
    var btn = $('[data-toggle-files]');
    if (!panel) return;
    panel.classList.add('is-open');
    if (btn) btn.classList.add('is-open');
  }

  function closeFilesPanel() {
    var panel = $('[data-files-panel]');
    var btn = $('[data-toggle-files]');
    if (!panel) return;
    panel.classList.remove('is-open');
    if (btn) btn.classList.remove('is-open');
  }

  /* ═══════════════════════════════════════════════════════════════════════
     14 · MENÚ CONTEXTUAL DE ARCHIVO
     ═══════════════════════════════════════════════════════════════════════ */

  function showFileContextMenu(e, fileName) {
    closeFileContextMenu();

    var menu = document.createElement('div');
    menu.className = 'file-context-menu';
    menu.style.position = 'fixed';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.style.zIndex = '500';

    menu.innerHTML =
      '<button type="button" data-action="open">Abrir</button>' +
      '<button type="button" data-action="rename">Renombrar</button>' +
      '<button type="button" data-action="duplicate">Duplicar</button>' +
      '<div class="divider"></div>' +
      '<button type="button" data-action="download">Descargar</button>' +
      '<button type="button" data-action="delete" class="danger">Eliminar</button>';

    document.body.appendChild(menu);

    // Ajustar si se sale de pantalla
    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';

    menu.addEventListener('click', async function (ev) {
      var action = ev.target.getAttribute('data-action');
      if (!action) return;

      closeFileContextMenu();

      if (action === 'open') {
        S.activeFile = fileName;
        renderFiles();
        openFileInEditor(fileName);
      } else if (action === 'rename') {
        var newName = prompt('Nuevo nombre:', fileName);
        if (newName && newName !== fileName) {
          if (renameFile(fileName, newName)) {
            renderFiles();
            toast('ok', 'Renombrado a ' + newName);
          } else {
            toast('err', 'No se pudo renombrar');
          }
        }
      } else if (action === 'duplicate') {
        var f = findFile(fileName);
        if (!f) return;
        var copyName = fileName.replace(/(\.[^.]+)$/, ' copy$1');
        var copy = upsertFile({ name: copyName, content: f.content }, { force: true });
        if (copy) {
          saveProject();
          renderFiles();
          toast('ok', 'Duplicado: ' + copy.name);
        }
      } else if (action === 'download') {
        var file = findFile(fileName);
        if (!file) return;
        var blob = new Blob([file.content || ''], { type: 'text/plain' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = fileName.split('/').pop();
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } else if (action === 'delete') {
        if (!confirm('¿Eliminar "' + fileName + '"?')) return;
        if (deleteFile(fileName)) {
          renderFiles();
          updatePreviewBadge();
          toast('ok', 'Eliminado');
        }
      }
    });

    setTimeout(function () {
      document.addEventListener('click', closeFileContextMenu, { once: true });
    }, 10);
  }

  function closeFileContextMenu() {
    $$('.file-context-menu').forEach(function (m) { m.remove(); });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     15 · EDITOR DE ARCHIVOS
     ═══════════════════════════════════════════════════════════════════════ */

  var editorEls = null;

  function openFileInEditor(fileName) {
    var file = findFile(fileName);
    if (!file) { toast('err', 'Archivo no encontrado'); return; }

    S.editorMode = true;

    // Crear editor si no existe
    if (!editorEls) editorEls = createEditorView();

    // Mostrar editor
    editorEls.wrap.hidden = false;
    editorEls.title.textContent = fileName;
    editorEls.lang.textContent = getLang(fileName).toUpperCase();
    editorEls.area.value = file.content || '';
    editorEls.area.dataset.file = fileName;
    editorEls.dirty.hidden = true;
    S.editorDirty = false;

    // Focus
    setTimeout(function () { editorEls.area.focus(); }, 60);

    // Actualizar line numbers
    updateLineNumbers();

    // Scroll al inicio
    editorEls.area.scrollTop = 0;
  }

  function closeEditor() {
    if (editorEls && editorEls.wrap) {
      editorEls.wrap.hidden = true;
    }
    S.editorMode = false;
    S.activeFile = null;
    renderFiles();
  }

  function createEditorView() {
    var wrap = document.createElement('div');
    wrap.className = 'coder-editor';
    wrap.hidden = true;
    wrap.innerHTML =
      '<div class="coder-editor__head">' +
        '<button type="button" class="coder-editor__back" data-editor-back>' +
          '<svg viewBox="0 0 24 24"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>' +
        '</button>' +
        '<div class="coder-editor__title-block">' +
          '<div class="coder-editor__title" data-editor-title>archivo.js</div>' +
          '<div class="coder-editor__lang" data-editor-lang>JS</div>' +
        '</div>' +
        '<div class="coder-editor__dirty" data-editor-dirty hidden>Sin guardar</div>' +
        '<button type="button" class="coder-editor__save" data-editor-save>' +
          '<svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>' +
          'Guardar' +
        '</button>' +
      '</div>' +
      '<div class="coder-editor__body">' +
        '<div class="coder-editor__lines" data-editor-lines></div>' +
        '<textarea class="coder-editor__area" data-editor-area spellcheck="false" wrap="off"></textarea>' +
      '</div>';

    // Insertar dentro del main
    var main = $('[data-main]');
    if (main) main.appendChild(wrap);
    else document.body.appendChild(wrap);

    var els = {
      wrap: wrap,
      head: wrap.querySelector('.coder-editor__head'),
      title: wrap.querySelector('[data-editor-title]'),
      lang: wrap.querySelector('[data-editor-lang]'),
      dirty: wrap.querySelector('[data-editor-dirty]'),
      back: wrap.querySelector('[data-editor-back]'),
      save: wrap.querySelector('[data-editor-save]'),
      lines: wrap.querySelector('[data-editor-lines]'),
      area: wrap.querySelector('[data-editor-area]'),
    };

    // Eventos
    els.back.addEventListener('click', function () {
      if (S.editorDirty && !confirm('Hay cambios sin guardar. ¿Salir igual?')) return;
      closeEditor();
    });

    els.save.addEventListener('click', function () {
      saveCurrentFile();
    });

    els.area.addEventListener('input', function () {
      S.editorDirty = true;
      els.dirty.hidden = false;
      updateLineNumbers();
      scheduleAutosave();
    });

    els.area.addEventListener('scroll', function () {
      els.lines.scrollTop = els.area.scrollTop;
    });

    els.area.addEventListener('keydown', function (e) {
      // Tab = 2 espacios
      if (e.key === 'Tab') {
        e.preventDefault();
        var start = els.area.selectionStart;
        var end = els.area.selectionEnd;
        var val = els.area.value;
        els.area.value = val.substring(0, start) + '  ' + val.substring(end);
        els.area.selectionStart = els.area.selectionEnd = start + 2;
        S.editorDirty = true;
        els.dirty.hidden = false;
        updateLineNumbers();
      }
    });

    return els;
  }

  function updateLineNumbers() {
    if (!editorEls || !editorEls.area) return;
    var text = editorEls.area.value || '';
    var lineCount = text.split('\n').length;
    var linesHtml = '';
    for (var i = 1; i <= lineCount; i++) {
      linesHtml += i + '\n';
    }
    editorEls.lines.textContent = linesHtml;
  }

  var scheduleAutosave = debounce(function () {
    if (S.editorMode && S.editorDirty) {
      saveCurrentFile({ silent: true });
    }
  }, CFG.AUTOSAVE_DEBOUNCE);

  function saveCurrentFile(opts) {
    opts = opts || {};
    if (!editorEls || !editorEls.area) return;
    var fileName = editorEls.area.dataset.file;
    if (!fileName) return;

    var file = findFile(fileName);
    if (!file) return;

    var newContent = editorEls.area.value;
    if (file.content !== newContent) {
      pushHistory(fileName, file.content);
      file.content = newContent;
      file.size = newContent.length;
    }

    saveProject();
    persistHistory();

    S.editorDirty = false;
    if (editorEls.dirty) editorEls.dirty.hidden = true;

    renderFiles();
    updatePreviewBadge();

    if (!opts.silent) toast('ok', 'Guardado: ' + fileName);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     16 · RENDERIZADO · ARQUITECTO
     ═══════════════════════════════════════════════════════════════════════ */

  function updateArchCounts() {
    var fileCountEl = $('[data-arch-file-count]');
    if (fileCountEl) fileCountEl.textContent = S.files.length + ' archivo' + (S.files.length === 1 ? '' : 's');

    var graph = buildDependencyGraph();
    var edgesEl = $('[data-arch-relation-count]');
    if (edgesEl) edgesEl.textContent = graph.edges.length + ' relación' + (graph.edges.length === 1 ? '' : 'es');

    renderArchColumns();
  }

  function renderArchColumns() {
    var core = [], data = [], styles = [];

    S.files.forEach(function (f) {
      var ext = f.ext;
      if (CFG.CAT_CORE.indexOf(ext) !== -1) core.push(f.name);
      else if (CFG.CAT_DATA.indexOf(ext) !== -1) data.push(f.name);
      else if (CFG.CAT_STYLE.indexOf(ext) !== -1) styles.push(f.name);
      else core.push(f.name);
    });

    var coreEl = $('[data-arch-col-core]');
    var dataEl = $('[data-arch-col-data]');
    var stylesEl = $('[data-arch-col-backend]');

    function formatList(arr) {
      if (arr.length === 0) return 'Sin archivos';
      return arr.slice(0, 4).join(', ') + (arr.length > 4 ? ' +' + (arr.length - 4) : '');
    }

    if (coreEl) coreEl.textContent = formatList(core);
    if (dataEl) dataEl.textContent = formatList(data);
    if (stylesEl) stylesEl.textContent = formatList(styles);
  }

  function openArchitect() {
    var modal = $('[data-architect-modal]');
    var sub = $('[data-architect-sub]');
    if (!modal) return;
    if (sub) sub.textContent = S.project.name || 'Mi proyecto';
    updateArchCounts();
    modal.hidden = false;
  }

  function closeArchitect() {
    var modal = $('[data-architect-modal]');
    if (modal) modal.hidden = true;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     17 · MAPA DE DEPENDENCIAS (REAL)
     ═══════════════════════════════════════════════════════════════════════ */

  function openDeps(fileName) {
    var modal = $('[data-deps-modal]');
    var fileEl = $('[data-deps-file]');
    var metaEl = $('[data-deps-meta]');
    var nodeLabel = $('[data-deps-node-label]');
    var emptyEl = $('[data-deps-empty]');
    var canvasEl = document.querySelector('.deps-canvas');

    if (!modal) return;

    fileName = fileName || (S.files[0] ? S.files[0].name : 'archivo');

    if (fileEl) fileEl.textContent = fileName;
    if (nodeLabel) nodeLabel.textContent = fileName;

    var graph = buildDependencyGraph();
    var incoming = graph.incoming[fileName] || [];
    var outgoing = graph.outgoing[fileName] || [];

    if (metaEl) {
      if (incoming.length === 0 && outgoing.length === 0) {
        metaEl.textContent = 'Sin dependencias detectadas';
      } else {
        metaEl.textContent = incoming.length + ' entrada(s) · ' + outgoing.length + ' salida(s)';
      }
    }

    // Renderizar el grafo (versión simple: nodo central + aristas)
    if (canvasEl) {
      canvasEl.innerHTML = '';

      // Nodo central
      var centerNode = document.createElement('div');
      centerNode.className = 'dep-node';
      centerNode.innerHTML =
        '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>' +
        '<span>' + escapeHtml(shortPath(fileName)) + '</span>';
      canvasEl.appendChild(centerNode);

      // Lista de deps (si las hay)
      if (incoming.length > 0 || outgoing.length > 0) {
        var listWrap = document.createElement('div');
        listWrap.style.cssText = 'display:flex;flex-direction:column;gap:8px;width:100%;max-width:520px;';

        // Outgoing
        if (outgoing.length > 0) {
          var outTitle = document.createElement('div');
          outTitle.style.cssText = 'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--c-text-muted);padding:0 4px;margin-top:16px;';
          outTitle.textContent = 'Depende de';
          listWrap.appendChild(outTitle);

          outgoing.forEach(function (edge) {
            var row = document.createElement('div');
            row.className = 'dep-row';
            row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--c-surface);border:1px solid var(--c-border);border-radius:10px;font-family:var(--font-mono);font-size:13px;cursor:pointer;';
            row.innerHTML =
              '<span style="font-size:10px;text-transform:uppercase;background:var(--c-primary-soft);color:var(--c-primary);padding:2px 6px;border-radius:4px;font-weight:700;">' + escapeHtml(edge.type) + '</span>' +
              '<span style="flex:1;color:var(--c-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(shortPath(edge.to)) + '</span>';
            row.addEventListener('click', function () {
              closeDeps();
              openDeps(edge.to);
            });
            listWrap.appendChild(row);
          });
        }

        // Incoming
        if (incoming.length > 0) {
          var inTitle = document.createElement('div');
          inTitle.style.cssText = 'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--c-text-muted);padding:0 4px;margin-top:16px;';
          inTitle.textContent = 'Usado por';
          listWrap.appendChild(inTitle);

          incoming.forEach(function (edge) {
            var row = document.createElement('div');
            row.className = 'dep-row';
            row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--c-surface);border:1px solid var(--c-border);border-radius:10px;font-family:var(--font-mono);font-size:13px;cursor:pointer;';
            row.innerHTML =
              '<span style="font-size:10px;text-transform:uppercase;background:var(--c-success-soft);color:var(--c-success);padding:2px 6px;border-radius:4px;font-weight:700;">' + escapeHtml(edge.type) + '</span>' +
              '<span style="flex:1;color:var(--c-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(shortPath(edge.from)) + '</span>';
            row.addEventListener('click', function () {
              closeDeps();
              openDeps(edge.from);
            });
            listWrap.appendChild(row);
          });
        }

        canvasEl.appendChild(listWrap);
      } else {
        var emptyMsg = document.createElement('p');
        emptyMsg.className = 'deps-empty';
        emptyMsg.textContent = 'Este archivo no tiene dependencias detectadas. Si tiene imports, verificá que apunten a archivos existentes del proyecto.';
        canvasEl.appendChild(emptyMsg);
      }
    }

    modal.hidden = false;
  }

  function closeDeps() {
    var modal = $('[data-deps-modal]');
    if (modal) modal.hidden = true;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     18 · PREVIEW (compilación real desde archivos)
     ═══════════════════════════════════════════════════════════════════════ */

  function setPreviewState(state) {
    S.previewState = state;
    var iframe = $('[data-preview-iframe]');
    var loading = $('[data-preview-loading]');
    var error = $('[data-preview-error]');
    if (!iframe || !loading || !error) return;

    if (state === 'idle') {
      iframe.hidden = true; loading.hidden = true; error.hidden = true;
    } else if (state === 'loading') {
      iframe.hidden = true; loading.hidden = false; error.hidden = true;
    } else if (state === 'ready') {
      iframe.hidden = false; loading.hidden = true; error.hidden = true;
    } else if (state === 'error') {
      iframe.hidden = true; loading.hidden = true; error.hidden = false;
    }
  }

  function openPreview() {
    var modal = $('[data-preview-modal]');
    var title = $('[data-preview-title]');
    var sub = $('[data-preview-sub]');
    if (!modal) return;
    if (title) title.textContent = S.project.name || 'Mi proyecto';
    if (sub) sub.textContent = S.files.length + ' archivos · ' + new Date().toLocaleTimeString('es-CO');
    modal.hidden = false;
    startPreviewLoad();
  }

  function closePreview() {
    var modal = $('[data-preview-modal]');
    var iframe = $('[data-preview-iframe]');
    if (modal) modal.hidden = true;
    if (iframe) iframe.srcdoc = '';
    clearTimeout(S.previewTimeoutId);
    S.previewTimeoutId = null;
  }

  /**
   * Compila el proyecto en un solo HTML listo para el iframe.
   * Reemplaza referencias locales con contenido inline.
   */
  function compilePreview() {
    var htmlFile = S.files.find(function (f) { return f.ext === 'html' || f.ext === 'htm'; });
    if (!htmlFile) return null;

    var html = htmlFile.content || '';

    // Reemplazar <link rel="stylesheet" href="styles.css"> con <style>
    html = html.replace(/<link[^>]*href=["']([^"']+\.css)["'][^>]*>/gi, function (match, href) {
      var cssFile = findFile(normalizePath(href));
      if (!cssFile) return match;
      return '<style data-source="' + escapeAttr(cssFile.name) + '">\n' + (cssFile.content || '') + '\n</style>';
    });

    // Reemplazar <script src="app.js"></script> con <script>
    html = html.replace(/<script[^>]*src=["']([^"']+\.js)["'][^>]*><\/script>/gi, function (match, src) {
      var jsFile = findFile(normalizePath(src));
      if (!jsFile) return match;
      return '<script data-source="' + escapeAttr(jsFile.name) + '">\n' + (jsFile.content || '') + '\n</script>';
    });

    // Inyectar CSS adicional (archivos CSS no referenciados explícitamente)
    var extraCSS = S.files
      .filter(function (f) { return f.ext === 'css' && !html.includes(f.name); })
      .map(function (f) { return '<style data-extra="' + escapeAttr(f.name) + '">\n' + (f.content || '') + '\n</style>'; })
      .join('\n');

    // Inyectar JS adicional (archivos JS no referenciados)
    var extraJS = S.files
      .filter(function (f) { return f.ext === 'js' && !html.includes(f.name); })
      .map(function (f) { return '<script data-extra="' + escapeAttr(f.name) + '">\n' + (f.content || '') + '\n</script>'; })
      .join('\n');

    if (extraCSS) {
      html = html.replace('</head>', extraCSS + '\n</head>');
    }

    if (extraJS) {
      html = html.replace('</body>', extraJS + '\n</body>');
    }

    // Añadir un pequeño logger para detectar errores del preview
    var logger = '<script>(function(){window.addEventListener("error",function(e){console.error("[preview]",e.message);});})();<\/script>';
    html = html.replace('</head>', logger + '</head>');

    return html;
  }

  function startPreviewLoad() {
    setPreviewState('loading');

    var compiled = compilePreview();
    if (!compiled) {
      S.previewTimeoutId = setTimeout(function () { setPreviewState('error'); }, 1200);
      return;
    }

    S.previewTimeoutId = setTimeout(function () {
      var iframe = $('[data-preview-iframe]');
      if (!iframe) return;
      iframe.srcdoc = compiled;
      iframe.onload = function () {
        setTimeout(function () { setPreviewState('ready'); }, 300);
      };
      iframe.onerror = function () { setPreviewState('error'); };
    }, CFG.PREVIEW_LOAD_DELAY);
  }

  function updatePreviewBadge() {
    renderPreviewCard();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     19 · CHAT · envío y streaming
     ═══════════════════════════════════════════════════════════════════════ */

  async function ensureChat() {
    if (S.chatId) return S.chatId;

    try {
      var res = await fetch(CFG.API_CHATS, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Coder · ' + (S.project.name || 'Proyecto'),
        }),
      });
      var data = await res.json();
      if (data && data.chat && data.chat.id) {
        S.chatId = data.chat.id;
        saveChatMap();
        return S.chatId;
      }
    } catch (e) {
      console.warn('[coder] No pude crear chat:', e.message);
    }
    return null;
  }

  async function persistMessage(role, content) {
    if (!S.chatId) return;
    try {
      await fetch(CFG.API_CHATS + '/' + S.chatId + '/messages', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: { role: role, content: content } }),
      });
    } catch (e) {
      console.warn('[coder] No pude guardar mensaje:', e.message);
    }
  }

  async function loadChatHistory() {
    if (!S.chatId) return;
    try {
      var res = await fetch(CFG.API_CHATS + '/' + S.chatId, { credentials: 'include' });
      var data = await res.json();
      if (data && data.chat && Array.isArray(data.chat.messages)) {
        S.messages = data.chat.messages.map(function (m) {
          return {
            role: m.role === 'user' ? 'user' : 'assistant',
            content: m.content || '',
            ts: new Date(m.created_at || Date.now()).getTime(),
          };
        });
      }
    } catch (e) {
      console.warn('[coder] No pude cargar historial:', e.message);
    }
  }

  function buildSystemContext() {
    var lines = [];

    lines.push('Estás en el modo Coder de Numination, un editor de código dentro de la plataforma.');
    lines.push('El usuario está trabajando en el proyecto "' + (S.project.name || 'sin nombre') + '".');
    lines.push('');
    lines.push('ESTRUCTURA DEL PROYECTO:');

    if (S.files.length === 0) {
      lines.push('  (vacío · todavía no hay archivos)');
    } else {
      S.files.slice(0, 30).forEach(function (f) {
        lines.push('  · ' + f.name + ' (' + formatBytes(f.size) + ')');
      });
      if (S.files.length > 30) {
        lines.push('  ... y ' + (S.files.length - 30) + ' más');
      }
    }

    lines.push('');
    lines.push('INSTRUCCIONES PARA ARCHIVOS:');
    lines.push('Cuando generes o modifiques archivos, devolvé SIEMPRE el contenido completo en este formato:');
    lines.push('');
    lines.push('```html index.html');
    lines.push('<!-- contenido completo del archivo -->');
    lines.push('```');
    lines.push('');
    lines.push('Usá el lenguaje correcto (html, css, js, json, etc.) y el nombre del archivo con su extensión.');
    lines.push('El sistema va a detectar esos bloques automáticamente y actualizar el proyecto.');
    lines.push('Si modificás un archivo existente, devolvé el contenido COMPLETO, no fragmentos.');
    lines.push('Si creás varios archivos, poné un bloque ``` para cada uno.');
    lines.push('');
    lines.push('IMPORTANTE:');
    lines.push('- Si el proyecto necesita CSS, ponelo en su propio archivo styles.css');
    lines.push('- Si necesita JS, ponelo en app.js');
    lines.push('- El HTML siempre en index.html');
    lines.push('- Referenciá los archivos desde el HTML con <link> y <script src>');

    return lines.join('\n');
  }

  function renderThread() {
    var thread = $('[data-thread]');
    if (!thread) return;

    if (S.messages.length === 0) {
      thread.hidden = true;
      thread.innerHTML = '';
      return;
    }

    thread.hidden = false;
    thread.innerHTML = '';

    S.messages.forEach(function (msg) {
      thread.appendChild(buildMessageBubble(msg));
    });

    scrollToBottom();
  }

  function buildMessageBubble(msg) {
    var div = document.createElement('div');
    div.className = 'message message--' + msg.role;

    if (msg.role === 'user') {
      div.innerHTML =
        '<div class="message__content">' +
          '<div class="message__text">' + mdRender(msg.content) + '</div>' +
        '</div>';
    } else {
      div.innerHTML =
        '<div class="message__avatar">N</div>' +
        '<div class="message__content">' +
          '<div class="message__role">Numination</div>' +
          '<div class="message__text">' + mdRender(msg.content) + '</div>' +
        '</div>';
    }

    mdEnhance(div);
    return div;
  }

  function scrollToBottom() {
    var main = $('[data-main]');
    if (main) {
      requestAnimationFrame(function () {
        main.scrollTop = main.scrollHeight;
      });
    }
  }

  async function sendMessage(prompt) {
    if (!prompt || S.isGenerating) return;

    S.isGenerating = true;
    updateSendButton();

    // 1. Añadir mensaje del usuario
    S.messages.push({ role: 'user', content: prompt, ts: Date.now() });
    renderThread();

    // 2. Asegurar chat en backend
    var chatId = await ensureChat();
    if (chatId) persistMessage('user', prompt);

    // 3. Mensaje live del asistente
    var thread = $('[data-thread]');
    if (!thread) return;
    thread.hidden = false;

    var live = document.createElement('div');
    live.className = 'message message--assistant';
    live.innerHTML =
      '<div class="message__avatar">N</div>' +
      '<div class="message__content">' +
        '<div class="message__role">Numination <span class="typing-indicator"><span></span><span></span><span></span></span></div>' +
        '<div class="message__text"><span class="stream-text"></span><span class="stream-cursor"></span></div>' +
      '</div>';
    thread.appendChild(live);
    scrollToBottom();

    var streamSpan = live.querySelector('.stream-text');
    var cursorSpan = live.querySelector('.stream-cursor');
    var typingEl = live.querySelector('.typing-indicator');

    var accumulated = '';

    // 4. Preparar body
    var history = S.messages.slice(0, -1).slice(-10).filter(function (m) {
      return m.content && m.content.trim();
    }).map(function (m) {
      return { role: m.role === 'user' ? 'user' : 'assistant', content: m.content };
    });

    var body = {
      message: buildSystemContext() + '\n\n---\n\nMENSAJE DEL USUARIO:\n' + prompt,
      role: 'teacher',
      history: history,
      webSearch: false,
      chatId: chatId || null,
    };

    // AbortController
    S.abortCtrl = new AbortController();

    try {
      var res = await fetch(CFG.API_CHAT, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: S.abortCtrl.signal,
      });

      if (res.status === 401) {
        location.href = '/login';
        return;
      }
      if (res.status === 429) {
        var errData = await res.json().catch(function () { return {}; });
        throw new Error(errData.error || 'Límite alcanzado. Esperá un momento.');
      }
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;

        buffer += decoder.decode(chunk.value, { stream: true });
        var parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (var i = 0; i < parts.length; i++) {
          var part = parts[i];
          if (part.indexOf('data: ') !== 0) continue;
          try {
            var evt = JSON.parse(part.slice(6));
            if (evt.error) {
              accumulated += '\n\n⚠️ ' + evt.error;
            } else if (evt.token) {
              accumulated += evt.token;
              streamSpan.textContent = accumulated;
              scrollToBottom();
            }
          } catch (e) {
            // Ignorar chunks malformados
          }
        }
      }

      // 5. Finalizar
      if (typingEl) typingEl.remove();
      if (cursorSpan) cursorSpan.remove();
      if (!accumulated.trim()) accumulated = 'Sin respuesta.';

      streamSpan.innerHTML = mdRender(accumulated);
      mdEnhance(live);

      // 6. Guardar en estado y backend
      S.messages.push({ role: 'assistant', content: accumulated, ts: Date.now() });
      if (chatId) persistMessage('ai', accumulated);

      // 7. Extraer archivos
      var files = extractFilesFromResponse(accumulated);
      if (files.length > 0) {
        var createdNames = [];
        files.forEach(function (f) {
          var result = upsertFile(f, { force: true });
          if (result) createdNames.push(result.name);
        });

        if (createdNames.length > 0) {
          saveProject();
          persistHistory();
          renderFiles();
          renderTopbar();
          updatePreviewBadge();

          // Abrir el panel
          openFilesPanel();

          var summary = createdNames.length === 1
            ? 'Archivo creado: ' + createdNames[0]
            : createdNames.length + ' archivos creados';
          toast('ok', summary);

          // Auto-abrir el primer archivo creado
          if (createdNames.length > 0) {
            setTimeout(function () {
              S.activeFile = createdNames[0];
              renderFiles();
              openFileInEditor(createdNames[0]);
            }, 400);
          }
        }
      }

    } catch (err) {
      if (err.name === 'AbortError') {
        // El usuario abortó
      } else {
        if (typingEl) typingEl.remove();
        if (cursorSpan) cursorSpan.remove();
        streamSpan.textContent = '⚠️ ' + (err.message || 'Error de conexión');
        toast('err', err.message || 'Error al enviar');
      }
    } finally {
      S.isGenerating = false;
      S.abortCtrl = null;
      updateSendButton();
      scrollToBottom();
    }
  }

  function abortGeneration() {
    if (S.abortCtrl) {
      S.abortCtrl.abort();
      S.abortCtrl = null;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     20 · COMPOSER
     ═══════════════════════════════════════════════════════════════════════ */

  function updateSendButton() {
    var field = $('[data-field]');
    var send = $('[data-send]');
    if (!field || !send) return;
    send.disabled = !field.value.trim() || S.isGenerating;
  }

  function setupComposer() {
    var form = $('[data-form]');
    var field = $('[data-field]');
    var send = $('[data-send]');

    if (field) {
      field.addEventListener('input', function () {
        field.style.height = 'auto';
        field.style.height = Math.min(field.scrollHeight, 200) + 'px';
        updateSendButton();
      });

      field.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (!send.disabled) {
            form.dispatchEvent(new Event('submit', { cancelable: true }));
          }
        }
      });
    }

    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var text = field.value.trim();
        if (!text || S.isGenerating) return;
        field.value = '';
        field.style.height = 'auto';
        updateSendButton();
        sendMessage(text);
      });
    }

    var addBtn = $('[data-attach]');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        openAttachSheet();
      });
    }

    var micBtn = $('[data-mic]');
    if (micBtn) {
      micBtn.addEventListener('click', function () {
        toast('info', 'Dictado próximamente');
      });
    }
  }

  function openAttachSheet() {
    var files = [
      { label: 'Archivo nuevo vacío', action: createFileManually },
      { label: 'Subir archivo local', action: uploadLocalFile },
    ];

    var choice = prompt(
      '¿Qué querés hacer?\n\n1) Crear archivo vacío\n2) Subir archivo local\n\nEscribí 1 o 2'
    );

    if (choice === '1') createFileManually();
    else if (choice === '2') uploadLocalFile();
  }

  function createFileManually() {
    var name = prompt('Nombre del archivo (ej: app.js, styles.css, index.html):', 'nuevo.js');
    if (!name) return;
    var f = createEmptyFile(name);
    if (f) {
      renderFiles();
      renderTopbar();
      updatePreviewBadge();
      S.activeFile = f.name;
      openFileInEditor(f.name);
      toast('ok', 'Creado: ' + f.name);
    }
  }

  function uploadLocalFile() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,.md,.json,.csv,.js,.jsx,.ts,.tsx,.py,.html,.css,.scss,.svg,.xml,.yaml,.yml';

    input.addEventListener('change', function () {
      if (!input.files || !input.files.length) return;
      var file = input.files[0];
      var reader = new FileReader();

      reader.onload = function (evt) {
        var content = String(evt.target.result || '');
        var f = upsertFile({ name: file.name, content: content }, { force: true });
        if (f) {
          saveProject();
          renderFiles();
          renderTopbar();
          updatePreviewBadge();
          toast('ok', 'Subido: ' + f.name);
          S.activeFile = f.name;
          openFileInEditor(f.name);
        }
      };

      reader.readAsText(file);
    });

    input.click();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     21 · DESCARGAR PROYECTO
     ═══════════════════════════════════════════════════════════════════════ */

  function downloadProject() {
    var payload = {
      project: {
        name: S.project.name,
        id: S.project.id,
      },
      files: S.files.map(function (f) {
        return { name: f.name, content: f.content || '', ext: f.ext };
      }),
      exportedAt: new Date().toISOString(),
      version: 2,
    };

    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (S.project.name || 'proyecto').toLowerCase().replace(/\s+/g, '_') + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('ok', 'Proyecto descargado');
  }

  function downloadFile(fileName) {
    var f = findFile(fileName);
    if (!f) return;
    var blob = new Blob([f.content || ''], { type: 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName.split('/').pop();
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('ok', 'Descargado: ' + fileName);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     22 · MENÚ LATERAL
     ═══════════════════════════════════════════════════════════════════════ */

  function openSideMenu() {
    var menu = $('[data-side-menu]');
    var overlay = $('[data-side-overlay]');
    if (menu) menu.classList.add('is-open');
    if (overlay) overlay.classList.add('is-active');
    S.sideMenuOpen = true;
  }

  function closeSideMenu() {
    var menu = $('[data-side-menu]');
    var overlay = $('[data-side-overlay]');
    if (menu) menu.classList.remove('is-open');
    if (overlay) overlay.classList.remove('is-active');
    S.sideMenuOpen = false;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     23 · TEMA
     ═══════════════════════════════════════════════════════════════════════ */

  function setTheme(id) {
    document.documentElement.dataset.theme = id;
    try { localStorage.setItem(CFG.THEME_KEY, id); } catch (e) {}
    $$('[data-theme-card]').forEach(function (c) {
      c.classList.toggle('is-active', c.dataset.themeCard === id);
    });
  }

  function getCurrentTheme() {
    try { return localStorage.getItem(CFG.THEME_KEY) || 'blanco'; }
    catch (e) { return 'blanco'; }
  }

  function openSettings() {
    var modal = $('[data-settings-modal]');
    if (!modal) return;
    modal.hidden = false;
    setTheme(getCurrentTheme());
  }

  function closeSettings() {
    var modal = $('[data-settings-modal]');
    if (modal) modal.hidden = true;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     24 · BÚSQUEDA EN ARCHIVOS
     ═══════════════════════════════════════════════════════════════════════ */

  function searchInFiles(query) {
    if (!query || query.length < 2) return [];
    var q = query.toLowerCase();
    var results = [];

    S.files.forEach(function (f) {
      var content = f.content || '';
      var lines = content.split('\n');
      lines.forEach(function (line, i) {
        if (line.toLowerCase().indexOf(q) !== -1) {
          results.push({
            file: f.name,
            line: i + 1,
            text: line.trim(),
            before: lines.slice(Math.max(0, i - 1), i).join('\n'),
            after: lines.slice(i + 1, Math.min(lines.length, i + 2)).join('\n'),
          });
        }
      });
    });

    return results;
  }

  function openSearch() {
    var query = prompt('Buscar en todos los archivos:', '');
    if (!query) return;
    var results = searchInFiles(query);
    if (results.length === 0) {
      toast('info', 'Sin resultados para "' + query + '"');
      return;
    }
    // Abrir el primer resultado
    var first = results[0];
    S.activeFile = first.file;
    openFileInEditor(first.file);
    toast('ok', results.length + ' resultado(s) · abriendo ' + first.file);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     25 · ATAJOS DE TECLADO
     ═══════════════════════════════════════════════════════════════════════ */

  function setupKeyboard() {
    document.addEventListener('keydown', function (e) {
      var isCtrl = e.ctrlKey || e.metaKey;
      var tag = (e.target.tagName || '').toLowerCase();

      // Ctrl+S · Guardar
      if (isCtrl && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (S.editorMode) saveCurrentFile();
        else {
          saveProject();
          toast('ok', 'Proyecto guardado');
        }
        return;
      }

      // Ctrl+Z · Undo (solo en editor)
      if (isCtrl && !e.shiftKey && e.key.toLowerCase() === 'z' && S.editorMode && editorEls) {
        e.preventDefault();
        var fileName = editorEls.area.dataset.file;
        var prev = undo(fileName);
        if (prev !== null) {
          editorEls.area.value = prev;
          updateLineNumbers();
          S.editorDirty = true;
          if (editorEls.dirty) editorEls.dirty.hidden = false;
        }
        return;
      }

      // Ctrl+Shift+Z · Redo
      if (isCtrl && e.shiftKey && e.key.toLowerCase() === 'z' && S.editorMode && editorEls) {
        e.preventDefault();
        var fname = editorEls.area.dataset.file;
        var next = redo(fname);
        if (next !== null) {
          editorEls.area.value = next;
          updateLineNumbers();
          S.editorDirty = true;
          if (editorEls.dirty) editorEls.dirty.hidden = false;
        }
        return;
      }

      // Ctrl+K · Buscar
      if (isCtrl && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openSearch();
        return;
      }

      // Ctrl+B · Toggle panel archivos
      if (isCtrl && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleFilesPanel();
        return;
      }

      // Escape
      if (e.key === 'Escape') {
        var preview = $('[data-preview-modal]');
        var arch = $('[data-architect-modal]');
        var deps = $('[data-deps-modal]');
        var settings = $('[data-settings-modal]');

        if (preview && !preview.hidden) { closePreview(); return; }
        if (settings && !settings.hidden) { closeSettings(); return; }
        if (arch && !arch.hidden) { closeArchitect(); return; }
        if (deps && !deps.hidden) { closeDeps(); return; }
        if (S.sideMenuOpen) { closeSideMenu(); return; }
        if (S.editorMode && !S.editorDirty) { closeEditor(); return; }

        closeFileContextMenu();
      }

      // En editor: no interferir con atajos nativos
      if (S.editorMode && tag === 'textarea') return;

      // Ctrl+Enter · Enviar desde cualquier lado
      if (isCtrl && e.key === 'Enter') {
        var field = $('[data-field]');
        if (field && document.activeElement !== field) {
          e.preventDefault();
          field.focus();
        }
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     26 · EVENTOS GLOBALES
     ═══════════════════════════════════════════════════════════════════════ */

  function setupEvents() {
    // Menú lateral
    var menuBtn = $('[data-menu-open]');
    if (menuBtn) menuBtn.addEventListener('click', openSideMenu);

    var overlay = $('[data-side-overlay]');
    if (overlay) overlay.addEventListener('click', closeSideMenu);

    // Volver a chats
    var backChats = $('[data-back-chats]');
    if (backChats) {
      backChats.addEventListener('click', function () {
        if (S.editorDirty && !confirm('Hay cambios sin guardar. ¿Salir?')) return;
        saveProject();
        location.href = '/chat';
      });
    }

    var backBtn = $('[data-back]');
    if (backBtn) {
      backBtn.addEventListener('click', function () {
        if (S.editorDirty && !confirm('Hay cambios sin guardar. ¿Salir?')) return;
        saveProject();
        location.href = '/chat';
      });
    }

    // Archivos desde menú
    var openFiles = $('[data-open-files]');
    if (openFiles) {
      openFiles.addEventListener('click', function () {
        closeSideMenu();
        openFilesPanel();
      });
    }

    // Ajustes
    var openSettingsBtn = $('[data-open-settings]');
    if (openSettingsBtn) {
      openSettingsBtn.addEventListener('click', function () {
        closeSideMenu();
        openSettings();
      });
    }

    // Tema
    $$('[data-theme-card]').forEach(function (card) {
      card.addEventListener('click', function () {
        setTheme(card.dataset.themeCard);
        toast('ok', 'Tema aplicado');
      });
    });

    var settingsClose = $('[data-settings-close]');
    if (settingsClose) settingsClose.addEventListener('click', closeSettings);

    var settingsModal = $('[data-settings-modal]');
    if (settingsModal) {
      settingsModal.addEventListener('click', function (e) {
        if (e.target === settingsModal) closeSettings();
      });
    }

    // Archivos
    var filesBtn = $('[data-toggle-files]');
    if (filesBtn) filesBtn.addEventListener('click', toggleFilesPanel);

    // Arquitecto
    var archBtn = $('[data-open-architect]');
    if (archBtn) archBtn.addEventListener('click', openArchitect);

    var archClose = $('[data-architect-close]');
    if (archClose) archClose.addEventListener('click', closeArchitect);

    var archCopy = $('[data-architect-copy]');
    if (archCopy) {
      archCopy.addEventListener('click', function () {
        var text = 'Proyecto: ' + S.project.name + '\n' +
          'Archivos (' + S.files.length + '):\n' +
          S.files.map(function (f) { return '  · ' + f.name + ' (' + formatBytes(f.size) + ')'; }).join('\n');
        navigator.clipboard.writeText(text).then(function () {
          toast('ok', 'Copiado');
        });
      });
    }

    // Deps
    var depsBtn = $('[data-open-deps]');
    if (depsBtn) {
      depsBtn.addEventListener('click', function () {
        var first = S.files[0];
        openDeps(first ? first.name : 'archivo');
      });
    }

    var depsClose = $('[data-deps-close]');
    if (depsClose) depsClose.addEventListener('click', closeDeps);

    // Undo global
    var undoBtn = $('[data-undo]');
    if (undoBtn) {
      undoBtn.addEventListener('click', function () {
        if (!S.activeFile && S.files.length > 0) S.activeFile = S.files[0].name;
        if (!S.activeFile) { toast('info', 'Nada para deshacer'); return; }
        var prev = undo(S.activeFile);
        if (prev === null) { toast('info', 'Nada para deshacer'); return; }
        var f = findFile(S.activeFile);
        if (f) {
          f.content = prev;
          f.size = prev.length;
          saveProject();
          renderFiles();
          if (S.editorMode && editorEls && editorEls.area.dataset.file === S.activeFile) {
            editorEls.area.value = prev;
            updateLineNumbers();
          }
          toast('ok', 'Deshecho en ' + S.activeFile);
        }
      });
    }

    // Download
    var downloadBtn = $('[data-download]');
    if (downloadBtn) downloadBtn.addEventListener('click', downloadProject);

    // Preview
    var previewBtn = $('[data-open-preview]');
    if (previewBtn) previewBtn.addEventListener('click', openPreview);

    var previewClose = $('[data-preview-close]');
    if (previewClose) previewClose.addEventListener('click', closePreview);

    var previewRetry = $('[data-preview-retry]');
    if (previewRetry) previewRetry.addEventListener('click', startPreviewLoad);

    var previewRefresh = $('[data-preview-refresh]');
    if (previewRefresh) previewRefresh.addEventListener('click', startPreviewLoad);

    var previewExternal = $('[data-preview-external]');
    if (previewExternal) {
      previewExternal.addEventListener('click', function () {
        var compiled = compilePreview();
        if (!compiled) { toast('warn', 'No hay HTML'); return; }
        var blob = new Blob([compiled], { type: 'text/html' });
        var url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     27 · INIT
     ═══════════════════════════════════════════════════════════════════════ */

  function init() {
    // Toasts
    initToasts();

    // Proyecto
    var p = loadProject();
    if (!p) return;

    // Aplicar tema
    setTheme(getCurrentTheme());

    // Render inicial
    renderTopbar();
    renderFiles();
    renderPreviewCard();
    renderThread();

    // Historial del chat (async)
    loadChatHistory().then(function () {
      renderThread();
    });

    // Setup
    setupComposer();
    setupEvents();
    setupKeyboard();

    // Estado inicial del composer
    updateSendButton();

    // Guardar al salir
    window.addEventListener('beforeunload', function () {
      if (S.editorMode && S.editorDirty && editorEls) {
        saveCurrentFile({ silent: true });
      }
      saveProject();
      persistHistory();
    });

    // Log final
    console.log(
      '%cCoder v2.0 · ' + p.name + ' · ' + S.files.length + ' archivos',
      'color:#1877f2;font-weight:700;padding:3px 10px;background:#e7f3ff;border-radius:6px'
    );
  }

  // Arrancar
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

})();