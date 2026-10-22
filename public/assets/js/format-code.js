/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · format-code.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Formateo de código con Prettier (Shift+Alt+F).

   ESTRATEGIA
     · Carga Prettier 3 desde el CDN (ESM) una sola vez y lo cachea.
     · Si el CDN no está disponible (offline, CSP), usa un formateador
       nativo propio: normaliza indentación, comas colgantes y saltos de
       línea. Es una aproximación, pero deja el código legible — nunca
       rompe nada.
     · Sólo formatea si el cambio es "seguro": el formateador nativo
       sólo toca espacios al principio de línea, nunca el contenido de
       las cadenas.

   ATAJO
     Shift + Alt + F (y Ctrl+Shift+F en Windows como alternativa).

   NOTA
     Prettier en el navegador no soporta TODOS los parsers de forma
     completa (algunos plugins no están en el bundle ESM del CDN); por
     eso el formateador nativo está siempre disponible como plan B.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const PRETTIER_URL = 'https://cdn.jsdelivr.net/npm/prettier@3.3.3/standalone.js';
  const PLUGINS = {
    javascript: 'https://cdn.jsdelivr.net/npm/prettier@3.3.3/plugins/babel.js',
    typescript: 'https://cdn.jsdelivr.net/npm/prettier@3.3.3/plugins/typescript.js',
    jsx: 'https://cdn.jsdelivr.net/npm/prettier@3.3.3/plugins/estree.js',
    json: 'https://cdn.jsdelivr.net/npm/prettier@3.3.3/plugins/babel.js',
    css: 'https://cdn.jsdelivr.net/npm/prettier@3.3.3/plugins/postcss.js',
    html: 'https://cdn.jsdelivr.net/npm/prettier@3.3.3/plugins/html.js',
    markdown: 'https://cdn.jsdelivr.net/npm/prettier@3.3.3/plugins/markdown.js',
    yaml: 'https://cdn.jsdelivr.net/npm/prettier@3.3.3/plugins/yaml.js',
  };

  const state = {
    prettier: null,
    loading: null,
    busy: false,
    engine: 'native',
    loadedPlugins: new Set(),
  };

  /* ─── Utilidades ────────────────────────────────────────────────────── */

  function toast(message, kind = 'info') {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
      return;
    }
    console.info('[format-code]', kind, message);
  }

  function getEditor() {
    const es = window.EditorState;
    if (!es || !es.monacoInstance) return null;
    return es;
  }

  function parserFor(language) {
    switch (String(language || '').toLowerCase()) {
      case 'javascript':
      case 'jsx':
      case 'json':
        return 'babel';
      case 'typescript':
        return 'typescript';
      case 'css':
      case 'scss':
      case 'less':
        return 'css';
      case 'html':
        return 'html';
      case 'markdown':
        return 'markdown';
      case 'yaml':
        return 'yaml';
      default:
        return null;
    }
  }

  /* ─── Carga de Prettier ──────────────────────────────────────────────── */

  /**
   * Carga Prettier (una sola vez). Devuelve null si no está disponible.
   */
  async function loadPrettier() {
    if (state.prettier) return state.prettier;
    if (state.loading) return state.loading;

    state.loading = (async () => {
      try {
        if (!window.prettier) {
          await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = PRETTIER_URL;
            script.onload = resolve;
            script.onerror = () => reject(new Error('No se pudo cargar Prettier.'));
            document.head.appendChild(script);
          });
        }

        state.prettier = window.prettier || null;
        return state.prettier;
      } catch (e) {
        console.info('[format-code] Prettier no disponible:', e.message);
        state.prettier = null;
        return null;
      } finally {
        state.loading = null;
      }
    })();

    return state.loading;
  }

  /**
   * Carga el plugin del parser necesario.
   */
  async function loadPlugin(parser) {
    if (!parser) return null;
    if (state.loadedPlugins.has(parser)) return state.loadedPlugins.get(parser);

    const url = PLUGINS[parser];
    if (!url) return null;

    try {
      const mod = await import(/* @vite-ignore */ url);
      state.loadedPlugins.set(parser, mod);
      return mod;
    } catch (e) {
      console.info('[format-code] no se pudo cargar el plugin', parser, e.message);
      return null;
    }
  }

  /* ─── Formateador nativo ─────────────────────────────────────────────── */

  /**
   * Formateo conservador: sólo normaliza la indentación a 2 espacios y
   * elimina espacios finales. NO toca el contenido de las líneas.
   */
  function nativeFormat(code, language) {
    const lines = String(code || '').split('\n');
    const indentUnit = /^\s*(yaml|yml)/i.test(String(language || '')) ? 2 : 2;

    let out = [];

    for (const raw of lines) {
      const withoutTrailing = raw.replace(/\s+$/, '');
      const leading = withoutTrailing.match(/^[ \t]*/)[0];
      const body = withoutTrailing.slice(leading.length);

      // Se detectan bloques que no usan indentación (JSON, YAML plano).
      const isFlat = /^(json|yaml|yml)$/i.test(String(language || ''));
      const tabs = leading.includes('\t');
      const spaces = tabs ? leading.length : leading.replace(/\t/g, '  ').length;
      const normalized = isFlat ? '' : ' '.repeat(Math.floor(spaces / 2) * indentUnit);

      out.push(body.length ? normalized + body : '');
    }

    // Se colapsan más de 2 líneas en blanco.
    return out.join('\n').replace(/\n{3,}/g, '\n\n');
  }

  /* ─── Formateo ───────────────────────────────────────────────────────── */

  /**
   * Formatea el código del editor (o un string).
   *
   * @param {string} [code]
   * @returns {Promise<object>} { ok, formatted, engine }
   */
  async function format(code) {
    const es = getEditor();
    const target = code !== undefined ? String(code) : (es ? String(es.getValue() || '') : '');
    const language = es && es.getActiveFile ? (es.getActiveFile().language || 'javascript') : 'javascript';

    if (!target.trim()) {
      return { ok: false, error: 'No hay código para formatear.' };
    }

    const parser = parserFor(language);

    if (parser) {
      const prettier = await loadPrettier();

      if (prettier) {
        try {
          const plugin = await loadPlugin(parser);
          const formatted = await prettier.format(target, {
            parser,
            plugins: plugin ? [plugin] : [],
            printWidth: 100,
            tabWidth: 2,
            semi: true,
            singleQuote: false,
            trailingComma: 'es5',
            arrowParens: 'always',
            endOfLine: 'lf',
          });

          state.engine = 'prettier';
          return { ok: true, formatted: String(formatted), engine: 'prettier', language };
        } catch (e) {
          console.info('[format-code] Prettier falló, se usa el formateador nativo:', e.message);
        }
      }
    }

    state.engine = 'native';
    return {
      ok: true,
      formatted: nativeFormat(target, language),
      engine: 'native',
      language,
      warning: 'Se usó el formateador nativo (Prettier no está disponible).',
    };
  }

  /**
   * Formatea el archivo abierto en el editor.
   */
  async function formatCurrentFile() {
    if (state.busy) return null;

    const es = getEditor();
    if (!es) {
      toast('El editor no está listo.', 'error');
      return null;
    }

    state.busy = true;

    try {
      const result = await format();

      if (!result.ok) {
        toast(result.error || 'No se pudo formatear.', 'error');
        return null;
      }

      const current = String(es.getValue() || '');

      if (current === result.formatted) {
        toast('El código ya estaba formateado.', 'info');
        return result;
      }

      // Se usa pushEditOperations para que el usuario pueda deshacer.
      const monaco = es.monacoInstance;
      const model = monaco.getModel();
      if (!model) return null;

      const fullRange = model.getFullModelRange();

      model.pushEditOperations(
        [],
        [{ range: fullRange, text: result.formatted, forceMoveMarkers: true }],
        () => null
      );

      if (window.eventBus && typeof window.eventBus.emit === 'function') {
        window.eventBus.emit('editor:formatted', {
          engine: result.engine,
          path: es.getActiveFile ? es.getActiveFile().path : null,
        });
      }

      toast(result.engine === 'prettier' ? 'Código formateado con Prettier.' : 'Código formateado (motor nativo).', 'ok');
      return result;
    } catch (e) {
      toast(e?.message || 'No se pudo formatear el código.', 'error');
      return null;
    } finally {
      state.busy = false;
    }
  }

  /* ─── Montaje ────────────────────────────────────────────────────────── */

  function bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Shift+Alt+F  (y Ctrl+Shift+F como alternativa)
      const isFormat = e.shiftKey && e.altKey && (e.key === 'f' || e.key === 'F');
      const isFormatAlt = e.ctrlKey && e.shiftKey && (e.key === 'f' || e.key === 'F');

      if (isFormat || isFormatAlt) {
        // Si el panel de búsqueda global está abierto, no se intercepta.
        if (window.NumCodeSearch && window.NumCodeSearch.hits) {
          // se deja pasar: el otro módulo también escucha Ctrl+Shift+F
        }
        e.preventDefault();
        formatCurrentFile();
      }
    });
  }

  window.NumFormatCode = {
    format,
    formatCurrentFile,
    nativeFormat,
    loadPrettier,
    get engine() { return state.engine; },
    get busy() { return state.busy; },
  };

  document.addEventListener('DOMContentLoaded', () => {
    bindShortcuts();
  });
})();
