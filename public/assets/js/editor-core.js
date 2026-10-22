/**
 * Numination · Modo Coder — editor-core.js
 * Núcleo de edición: inicializa Monaco, expone el estado global `EditorState`,
 * rastrea el estado "sucio" (sin guardar) y emite eventos en el bus.
 *
 * Eventos que emite (numination-boot/ide-events):
 *   editor:ready   { }                          Monaco listo para usar.
 *   editor:change  { value }                    Debounce del contenido.
 *   editor:dirty   { isDirty }                  Transición de estado sucio.
 *   file:open-requested { path }                Solicita abrir un archivo.
 */
(function () {
  'use strict';

  const MONACO_VERSION_LOADER = 0.45; // coincide con el CDN de coder.html
  const CHANGE_DEBOUNCE_MS = 300;

  /** Extensiones → lenguajes Monaco. Extensible sin tocar lógica. */
  const LANG_BY_EXT = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    jsx: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    json: 'json', css: 'css', scss: 'scss', less: 'less',
    html: 'html', htm: 'html', svg: 'xml', xml: 'xml',
    md: 'markdown', mdx: 'markdown',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', php: 'php', sh: 'shell', bash: 'shell',
    yml: 'yaml', yaml: 'yaml', sql: 'sql', env: 'ini'
  };

  /* Media queries centrales para el tema del editor */
  const THEME_TOKENS = {
    base: '#0a0a0c', surface: '#12121b', accent: '#8b5cf6',
    ink: '#e8e8f2', ink2: '#9a9aae', ink3: '#5f5f74', line: '#23232f',
    ok: '#34d399', err: '#f87171'
  };

  function defineNuminationTheme(monaco) {
    monaco.editor.defineTheme('numination-noir', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '5F5F74', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'A78BFA' },
        { token: 'string', foreground: '34D399' },
        { token: 'number', foreground: 'F472B6' },
        { token: 'function', foreground: '93C5FD' },
        { token: 'type', foreground: 'A78BFA' }
      ],
      colors: {
        'editor.background': THEME_TOKENS.surface,
        'editor.foreground': THEME_TOKENS.ink,
        'editorLineNumber.foreground': THEME_TOKENS.ink3,
        'editorLineNumber.activeForeground': THEME_TOKENS.accent,
        'editor.lineHighlightBackground': '#171722',
        'editor.selectionBackground': '#8b5cf655',
        'editorIndentGuide.background1': THEME_TOKENS.line,
        'editorGutter.background': THEME_TOKENS.surface,
        'editorWidget.background': THEME_TOKENS.base,
        'editorSuggestWidget.background': '#171722',
        'editorHoverWidget.background': '#171722',
        'scrollbarSlider.background': '#2c2c3a80',
        'scrollbarSlider.hoverBackground': '#3a3a4ccc'
      }
    });
  }

  /** @returns {string} lenguaje Monaco para una ruta de archivo */
  function languageFromPath(path) {
    const ext = String(path || '').split('.').pop().toLowerCase();
    return LANG_BY_EXT[ext] || 'plaintext';
  }

  /** Carátula nueva en Supabase cuando el proyecto aún no existe. */
  const DEFAULT_FILE = {
    path: 'index.js',
    language: 'javascript',
    content: [
      '/**',
      ' * Proyecto Numination — punto de entrada.',
      ' * Se creó automáticamente en tu primer guardado.',
      ' */',
      'export function main(args) {',
      "  console.log('Numination Coder listo ✨');",
      '  return args;',
      '}',
      '',
      'main();',
      ''
    ].join('\n')
  };

  const EditorState = {
    /** @type {import('monaco-editor').editor.IStandaloneCodeEditor|null} */
    monacoInstance: null,
    monaco: null,

    /** @type {{path:string, language:string}|null} archivo activo */
    activeFile: null,
    /** Snapshot en disco del archivo activo (para contraste dirty). */
    _savedValue: '',
    _ready: false,
    _pendingOpen: null,

    /**
     * Carga Monaco y crea la instancia del editor.
     * Idempotente: si ya está listo, resuelve inmediatamente.
     * @param {HTMLElement} container Contenedor (con tamaño definido por CSS).
     * @returns {Promise<void>}
     */
    init(container) {
      if (this._ready) return Promise.resolve();
      if (!container) return Promise.reject(new Error('container requerido para Monaco'));

      return new Promise((resolve, reject) => {
        if (typeof require === 'undefined') {
          reject(new Error('El loader de Monaco (loader.js) no está disponible'));
          return;
        }
        require(['vs/editor/editor.main'], () => {
          try {
            this.monaco = window.monaco;
            defineNuminationTheme(this.monaco);

            this.monacoInstance = this.monaco.editor.create(container, {
              model: this.monaco.editor.createModel(DEFAULT_FILE.content, DEFAULT_FILE.language),
              theme: 'numination-noir',
              language: DEFAULT_FILE.language,
              automaticLayout: true, // ResizeObserver interno: sin thrashing
              fontFamily: '"JetBrains Mono", ui-monospace, monospace',
              fontSize: 14,
              fontLigatures: true,
              minimap: { enabled: true, scale: 1, renderCharacters: false },
              smoothScrolling: true,
              cursorBlinking: 'phase',
              renderWhitespace: 'selection',
              tabSize: 2,
              scrollBeyondLastLine: false,
              padding: { top: 12 },
              tabCompletion: 'on'
            });

            this.activeFile = { path: DEFAULT_FILE.path, language: DEFAULT_FILE.language };
            this._savedValue = DEFAULT_FILE.content;
            this._wireEvents();
            this._wireSaveShortcut();

            this._ready = true;
            // Aplicar apertura pendida por file-tree antes de estar listo
            if (this._pendingOpen) {
              const pending = this._pendingOpen;
              this._pendingOpen = null;
              this.setValue(pending);
            }
            window.eventBus.emit('editor:ready', {});
            resolve();
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        }, (err) => reject(new Error(`No se pudo cargar Monaco desde CDN: ${JSON.stringify(err)}`)));
      });
    },

    /** @returns {boolean} true si Monaco terminó de inicializar */
    isReady() { return Boolean(this._ready && this.monacoInstance); },

    /** @returns {string|null} contenido actual del editor */
    getValue() {
      return this.monacoInstance ? this.monacoInstance.getValue() : null;
    },

    /**
     * Establece el contenido (y opcionalmente idioma/ruta). Si Monaco aún
     * está cargando, guarda la petición y la aplica al terminar.
     * @param {{ code?: string, content?: string, language?: string, path?: string,
     *           isSaved?: boolean }} payload Descripción del archivo.
     * @returns {void}
     */
    setValue(payload) {
      const payloadData = payload || {};
      const code = payloadData.code ?? payloadData.content ?? '';
      const filepath = payloadData.path || (this.activeFile?.path) || 'index.js';
      const lang = payloadData.language || languageFromPath(filepath);
      const isSaved = payloadData.isSaved !== false;

      if (!this.isReady()) { this._pendingOpen = { code, path: filepath, language: lang, isSaved }; return; }

      const model = this.monacoInstance.getModel();
      if (!model) return;

      model.setValue(code); // reset de historial: apertura intencional, no Ctrl+Z desde otro archivo
      this.monaco.editor.setModelLanguage(model, lang);

      this.activeFile = { path: filepath, language: lang };
      this._savedValue = isSaved ? code : this._savedValue;
      this._pushStatus();
      this._emitDirty();
      window.eventBus.emit('file:opened', { path: filepath, language: lang, lines: code.split('\n').length });
    },

    /** @returns {string|null} idioma Monaco activo */
    getLanguage() {
      return this.activeFile?.language || null;
    },

    /** @returns {{path: string, language: string} | null} archivo en disco virtual */
    getActiveFile() { return this.activeFile ? { ...this.activeFile } : null; },

    /**
     * Pone el valor directamente como ya guardado (p.ej. tras Aplicar diff
     * auto-guardado) sin destruir el snapshot de disco si es edición.
     * @param {string} code
     * @param {boolean} [asSaved=false]
     * @returns {void}
     */
    updateValue(code, asSaved) {
      if (!this.isReady()) return;
      const model = this.monacoInstance.getModel();
      if (!model) return;
      model.setValue(code);
      if (asSaved) { this._savedValue = code; this._emitDirty(); this._pushStatus(); }
    },

    /** @returns {boolean} el código difiere del último guardado */
    isDirty() {
      const value = this.getValue();
      return value !== null && value !== this._savedValue;
    },

    /** Marca el contenido actual como recién guardado. */
    markSaved() {
      this._savedValue = this.getValue() ?? '';
      this._emitDirty();
      this._pushStatus();
      window.eventBus.emit('editor:saved', { path: this.activeFile?.path });
    },

    /* ── wiring interno ─────────────────────────────────────── */

    _wireEvents() {
      let timer = null;
      this.monacoInstance.onDidChangeModelContent(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          window.eventBus.emit('editor:change', { value: this.getValue() });
          this._pushStatus();
          this._emitDirty();
        }, CHANGE_DEBOUNCE_MS);
      });

      // Label del cursor para statusbar
      this.monacoInstance.onDidChangeCursorPosition((e) => {
        const el = document.getElementById('status-file-extra');
        if (el) el.textContent = `Ln ${e.position.lineNumber}, Col ${e.position.column}`;
        else window.eventBus.emit('editor:cursor', {
          line: e.position.lineNumber, column: e.position.column
        });
      });
    },

    _wireSaveShortcut() {
      // Ctrl/Cmd+S → deposita en el bus; file-tree hace el POST a /api/coder/save
      this.monacoInstance.addCommand(
        // KeyCommand alcanza el monaco command
        this.monaco.KeyMod.CtrlCmd | this.monaco.KeyCode.KeyS,
        () => window.eventBus.emit('file:save', { path: this.activeFile?.path })
      );
    },

    _emitDirty() {
      window.eventBus.emit('editor:dirty', { isDirty: this.isDirty() });
    },

    /**
     * Renderiza la pestaña del archivo activo con su indicador de cambios.
     * @returns {void}
     */
    _renderTab() {
      const bar = document.getElementById('editor-tabs');
      if (!bar) return;
      bar.textContent = '';
      if (!this.activeFile) return;

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'editor-tab is-active';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', 'true');
      tab.title = this.activeFile.path;

      const name = document.createElement('span');
      name.textContent = this.activeFile.path;
      tab.appendChild(name);

      if (this.isDirty()) {
        const dot = document.createElement('span');
        dot.className = 'editor-tab__dirty';
        dot.textContent = '●';
        dot.setAttribute('aria-label', 'cambios sin guardar');
        tab.appendChild(dot);
      }
      bar.appendChild(tab);
    },

    _pushStatus() {
      const pathEl = document.getElementById('status-file');
      const dirtyEl = document.getElementById('status-dirty');
      const langEl = document.getElementById('status-language');
      if (pathEl && this.activeFile) pathEl.textContent = this.activeFile.path;
      if (langEl) langEl.textContent = this.getLanguage() || 'plaintext';
      if (dirtyEl) {
        dirtyEl.textContent = this.isDirty() ? '● sin guardar' : '';
        dirtyEl.className = this.isDirty() ? 'is-dirty' : '';
      }
      this._renderTab();
    }
  };

  /* ═══ Bootstrap ═══ */
  function start() {
    const container = document.getElementById('monaco-container');
    const loaderEl = document.getElementById('editor-loading');
    EditorState.init(container)
      .then(() => { if (loaderEl) loaderEl.hidden = true; })
      .catch((err) => {
        console.error('[editor-core] init falló:', err);
        if (loaderEl) {
          loaderEl.innerHTML = '';
          const msg = document.createElement('span');
          msg.textContent = `Editor no disponible: ${err.message}`;
          loaderEl.append(msg);
        }
        window.NuminToast.error('No se pudo cargar el editor de código.');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  window.EditorState = EditorState;
  window.EditorState.ALLOWED_VERSION = MONACO_VERSION_LOADER; // solo para diagnóstico
  window.languageFromPath = languageFromPath;                 // usado por file-tree
})();
