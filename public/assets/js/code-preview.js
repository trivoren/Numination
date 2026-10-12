/* ================================================================
   NUMINATION · code-preview.js · v3.0
   ----------------------------------------------------------------
   Widget de vista previa para código generado por la IA.

   NUEVO EN v3.0:
     · Loading state en el botón mientras abre el modal
     · Máquina de estados del modal (idle/opening/ready/closing)
     · Detección proactiva de errores del iframe → auto-switch a Console
     · Console virtual scroll (soporta miles de líneas sin lag)
     · Editor auto-resize + sincronización con números de línea
     · Screenshot robusto con fallback CORS
     · Cleanup correcto al cerrar (listeners, timers, observers)
     · Fallback UI cuando el botón no puede inyectarse
     · Debounce inteligente de reload (no rebota con cada tecla)
     · Auto-scroll de console/network/elements al fondo
     · Mejor integración con el markdown del chat (.md-pre-head)

   API PÚBLICA (igual que v2.0):
     NM_preview.open({ html, css, js, language, title })
     NM_preview.close()
     NM_preview.scanAll()
     NM_preview.attach(codeElement)
     NM_preview.setShareEndpoint(url)
     NM_preview.setSandboxEndpoint(url)
     NM_preview.setLocale('es'|'en')
   ================================================================ */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════
     1 · CONFIGURACIÓN
     ═══════════════════════════════════════════════════════════════════ */

  const CFG = {
    previewableLangs: new Set([
      'html', 'htm', 'xhtml',
      'css',
      'js', 'javascript', 'mjs', 'cjs', 'jsx',
      'svg',
      'markdown', 'md',
    ]),

    shareEndpoint: '/api/sandbox',
    sandboxEndpoint: '/api/sandbox',

    iframeLoadTimeoutMs: 12_000,
    rescanDebounceMs: 250,
    reloadDebounceMs: 450,
    autoSaveDebounceMs: 1200,

    maxConsoleLines: 2000,
    maxNetworkLines: 500,

    zoom: { min: 0.25, max: 2.0, step: 0.15, default: 1 },

    devices: {
      desktop: { width: 1280, height: 800, label: 'Desktop' },
      tablet:  { width: 834,  height: 1112, label: 'Tablet' },
      mobile:  { width: 390,  height: 844, label: 'Mobile' },
    },

    locale: (typeof navigator !== 'undefined' && navigator.language || 'es').slice(0, 2),

    debug: false,

    keys: {
      draft: 'numination-preview-draft-v3',
      theme: 'numination-preview-theme',
      device: 'numination-preview-device',
      zoom: 'numination-preview-zoom',
    },
  };

  /* ═══════════════════════════════════════════════════════════════════
     2 · I18N
     ═══════════════════════════════════════════════════════════════════ */

  const I18N = {
    es: {
      title: 'Vista previa',
      preview: 'Vista previa',
      code: 'Código',
      console: 'Consola',
      elements: 'Elementos',
      network: 'Red',
      reload: 'Recargar',
      share: 'Compartir',
      save: 'Guardar',
      download: 'Descargar',
      copy: 'Copiar',
      close: 'Cerrar',
      fullscreen: 'Pantalla completa',
      theme: 'Tema',
      zoom: 'Zoom',
      clear: 'Limpiar',
      search: 'Buscar en consola...',
      emptyConsole: 'La consola aparecerá acá cuando el código imprima algo.',
      loading: 'Cargando vista previa...',
      error: 'Error al cargar la vista previa',
      noCode: 'Sin código para previsualizar',
      copied: 'Copiado',
      copyCode: 'Copiar código',
      copyUrl: 'Copiar URL',
      shareSuccess: 'URL copiada al portapapeles',
      shareError: 'No pude compartir el preview',
      saveSuccess: 'Preview guardado',
      saveError: 'No pude guardar el preview',
      screenshot: 'Captura',
      screenshotError: 'No pude tomar la captura',
      templates: 'Plantillas',
      applyTemplate: 'Aplicar plantilla',
      applyTemplateConfirm: '¿Reemplazar el código actual con la plantilla?',
      undo: 'Deshacer',
      redo: 'Rehacer',
      reset: 'Reiniciar',
      resetConfirm: '¿Descartar cambios y volver al código original?',
      lines: 'líneas',
      chars: 'chars',
      elementsEmpty: 'El DOM del preview aparecerá acá.',
      networkEmpty: 'Sin requests capturados.',
      openPreview: 'Vista previa',
      device: { desktop: 'Escritorio', tablet: 'Tablet', mobile: 'Móvil' },
    },
    en: {
      title: 'Preview',
      preview: 'Preview',
      code: 'Code',
      console: 'Console',
      elements: 'Elements',
      network: 'Network',
      reload: 'Reload',
      share: 'Share',
      save: 'Save',
      download: 'Download',
      copy: 'Copy',
      close: 'Close',
      fullscreen: 'Fullscreen',
      theme: 'Theme',
      zoom: 'Zoom',
      clear: 'Clear',
      search: 'Search console...',
      emptyConsole: 'Console output will appear here.',
      loading: 'Loading preview...',
      error: 'Error loading preview',
      noCode: 'No code to preview',
      copied: 'Copied',
      copyCode: 'Copy code',
      copyUrl: 'Copy URL',
      shareSuccess: 'URL copied to clipboard',
      shareError: 'Could not share preview',
      saveSuccess: 'Preview saved',
      saveError: 'Could not save preview',
      screenshot: 'Screenshot',
      screenshotError: 'Could not capture screenshot',
      templates: 'Templates',
      applyTemplate: 'Apply template',
      applyTemplateConfirm: 'Replace current code with template?',
      undo: 'Undo',
      redo: 'Redo',
      reset: 'Reset',
      resetConfirm: 'Discard changes and restore original code?',
      lines: 'lines',
      chars: 'chars',
      elementsEmpty: 'DOM tree will appear here.',
      networkEmpty: 'No requests captured.',
      openPreview: 'Preview',
      device: { desktop: 'Desktop', tablet: 'Tablet', mobile: 'Mobile' },
    },
  };

  function t(key) {
    const dict = I18N[CFG.locale] || I18N.es;
    return dict[key] || key;
  }

  /* ═══════════════════════════════════════════════════════════════════
     3 · UTILS
     ═══════════════════════════════════════════════════════════════════ */

  function log(...args) { if (CFG.debug) console.log('[preview]', ...args); }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch {}
  }

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }

  function debounce(fn, ms) {
    let timer = null;
    return function () {
      const args = arguments;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function throttle(fn, ms) {
    let last = 0;
    let timer = null;
    return function () {
      const args = arguments;
      const now = Date.now();
      const remaining = ms - (now - last);
      if (remaining <= 0) {
        last = now;
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = Date.now();
          timer = null;
          fn.apply(this, args);
        }, remaining);
      }
    };
  }

  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      + '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function id(prefix = 'nm') {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  }

  /* ═══════════════════════════════════════════════════════════════════
     4 · TOAST WRAPPER
     ═══════════════════════════════════════════════════════════════════ */

  function toast(kind, msg) {
    if (window.__nm && window.__nm.toast && typeof window.__nm.toast[kind] === 'function') {
      try { window.__nm.toast[kind](msg); return; } catch {}
    }
    log(kind, msg);
  }

  /* ═══════════════════════════════════════════════════════════════════
     5 · PARSING DE CÓDIGO
     ═══════════════════════════════════════════════════════════════════ */

  function detectCodeBlocks(root) {
    if (!root) root = document;
    return Array.from(root.querySelectorAll('pre > code, pre code, .message__text pre code'));
  }

  function getLangFromCodeEl(codeEl) {
    const classes = (codeEl.className || '').split(/\s+/);
    for (const c of classes) {
      if (/^language-/.test(c)) return c.replace(/^language-/, '').toLowerCase();
      if (/^lang-/.test(c)) return c.replace(/^lang-/, '').toLowerCase();
    }
    const pre = codeEl.parentElement;
    if (pre && pre.previousElementSibling) {
      const head = pre.previousElementSibling;
      if (head.classList && head.classList.contains('md-pre-head')) {
        const span = head.querySelector('span');
        if (span) return (span.textContent || '').trim().toLowerCase();
      }
    }
    return 'text';
  }

  function getCodeFromCodeEl(codeEl) { return codeEl.textContent || ''; }

  function isPreviewable(lang) { return CFG.previewableLangs.has(lang); }
  function isHtmlLike(lang) { return ['html', 'htm', 'xhtml'].includes(lang); }
  function isCssOnly(lang) { return lang === 'css'; }
  function isJsOnly(lang) { return ['js', 'javascript', 'mjs', 'cjs', 'jsx'].includes(lang); }
  function isSvg(lang) { return lang === 'svg'; }
  function isMarkdown(lang) { return ['markdown', 'md'].includes(lang); }

  function buildPreviewParts(code, lang) {
    code = String(code || '');

    if (isHtmlLike(lang)) {
      let html = code;
      let css = '';
      let js = '';

      const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
      let m;
      while ((m = styleRe.exec(code)) !== null) css += '\n' + m[1];

      const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
      while ((m = scriptRe.exec(code)) !== null) js += '\n' + m[1];

      return { html, css, js };
    }

    if (isCssOnly(lang)) {
      return {
        html: `<div class="__demo">
  <h1>Vista previa de CSS</h1>
  <p>Este es un párrafo de ejemplo. Los estilos que definiste se aplican acá.</p>
  <button class="btn">Botón de ejemplo</button>
  <div class="card">
    <h2>Tarjeta</h2>
    <p>Contenido de ejemplo para ver el estilo.</p>
  </div>
  <ul><li>Item uno</li><li>Item dos</li><li>Item tres</li></ul>
  <a href="#">Enlace de ejemplo</a>
</div>`,
        css: code,
        js: '',
      };
    }

    if (isJsOnly(lang)) {
      return {
        html: `<div id="app">
  <h1>Vista previa de JavaScript</h1>
  <p>Mirá la pestaña <strong>Consola</strong> para ver la salida.</p>
  <pre id="__output" style="background:#f5f5f7;padding:12px;border-radius:8px;font-family:monospace;font-size:13px;white-space:pre-wrap;min-height:60px;"></pre>
</div>`,
        css: '',
        js: `(function(){
  var out = document.getElementById('__output');
  var origLog = console.log;
  console.log = function(){
    var args = Array.prototype.slice.call(arguments);
    var line = args.map(function(a){
      try { return typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a); }
      catch(e){ return String(a); }
    }).join(' ');
    if (out) out.textContent += line + '\\n';
    origLog.apply(console, arguments);
  };
  try { ${code} }
  catch(e){ console.error('Error: ' + e.message); }
})();`,
      };
    }

    if (isSvg(lang)) return { html: code, css: '', js: '' };

    if (isMarkdown(lang)) {
      return {
        html: markdownToHtml(code),
        css: `
          body { padding: 24px; max-width: 760px; margin: 0 auto; line-height: 1.7; }
          h1 { font-size: 28px; margin: 24px 0 12px; letter-spacing: -0.02em; }
          h2 { font-size: 22px; margin: 20px 0 10px; }
          h3 { font-size: 18px; margin: 16px 0 8px; }
          p { margin: 12px 0; }
          code { background: #f5f5f7; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: .9em; }
          pre { background: #0f0f10; color: #e6e6e6; padding: 16px; border-radius: 10px; overflow-x: auto; }
          pre code { background: none; padding: 0; color: inherit; }
          blockquote { border-left: 3px solid #7c5eff; padding-left: 16px; color: #6b6b70; margin: 16px 0; }
          a { color: #7c5eff; }
          ul, ol { padding-left: 24px; margin: 12px 0; }
          hr { border: none; border-top: 1px solid #e8e8ea; margin: 24px 0; }
        `,
        js: '',
      };
    }

    return { html: '', css: '', js: '' };
  }

  function markdownToHtml(md) {
    let h = esc(md);
    h = h.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, l, c) => `<pre><code>${c.trim()}</code></pre>`);
    h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    h = h.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    h = h.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');
    h = h.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
    h = h.replace(/(<li>[\s\S]*?<\/li>)(?=\s*<(?!li))/g, '<ul>$1</ul>');
    h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    h = h.replace(/^---$/gm, '<hr>');
    h = h.split('\n\n').map((p) => {
      if (/^\s*<(h[1-6]|ul|ol|pre|blockquote|hr|p)/.test(p)) return p;
      return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');
    return h;
  }

  /* ═══════════════════════════════════════════════════════════════════
     6 · BUILD DOCUMENT (iframe HTML)
     ═══════════════════════════════════════════════════════════════════ */

  function buildDocument({ html = '', css = '', js = '', theme = 'device' }) {
    const base = theme === 'dark'
      ? `*{box-sizing:border-box}html,body{margin:0;padding:0;font-family:Inter,system-ui,sans-serif;background:#0f0f15;color:#f0f0f5;line-height:1.5}body{padding:16px}a{color:#8b73ff}`
      : `*{box-sizing:border-box}html,body{margin:0;padding:0;font-family:Inter,system-ui,sans-serif;background:#fff;color:#0a0a0c;line-height:1.5}body{padding:16px}a{color:#7c5eff}`;

    const bridge = `
      (function(){
        var LEVELS = ['log','info','warn','error','debug'];
        function serialize(a){
          if (a instanceof Error) return a.message + '\\n' + (a.stack || '');
          if (typeof a === 'string') return a;
          if (typeof a === 'number' || typeof a === 'boolean') return String(a);
          if (a === null) return 'null';
          if (a === undefined) return 'undefined';
          try {
            var seen = new WeakSet();
            return JSON.stringify(a, function(k, v){
              if (typeof v === 'object' && v !== null) {
                if (seen.has(v)) return '[Circular]';
                seen.add(v);
              }
              return v;
            }, 2);
          } catch(e) { return String(a); }
        }
        function send(level, args, meta){
          try{
            var msgs = Array.prototype.slice.call(args).map(serialize);
            parent.postMessage({
              type: 'nm-preview-console',
              level: level,
              message: msgs.join(' '),
              at: Date.now(),
              meta: meta || {}
            }, '*');
          } catch(e){}
        }
        LEVELS.forEach(function(k){
          var orig = console[k];
          console[k] = function(){
            send(k, arguments);
            try { orig.apply(console, arguments); } catch(e){}
          };
        });
        window.addEventListener('error', function(e){
          send('error', [e.message + ' @ ' + (e.filename||'inline') + ':' + e.lineno], { source: 'window' });
        });
        window.addEventListener('unhandledrejection', function(e){
          send('error', ['Unhandled Promise Rejection: ' + ((e.reason && e.reason.message) || e.reason)], { source: 'promise' });
        });

        var _origFetch = window.fetch;
        window.fetch = function(){
          var url = String(arguments[0] || '');
          var t0 = Date.now();
          send('debug', ['[fetch] → ' + url], { net: 'request', url: url, method: 'GET' });
          return _origFetch.apply(this, arguments).then(function(res){
            send('debug', ['[fetch] ← ' + res.status + ' ' + url + ' (' + (Date.now()-t0) + 'ms)'], { net: 'response', url: url, status: res.status, duration: Date.now()-t0 });
            return res;
          }, function(err){
            send('error', ['[fetch] ✗ ' + url + ' · ' + err.message], { net: 'error', url: url });
            throw err;
          });
        };

        var OrigXHR = window.XMLHttpRequest;
        if (OrigXHR) {
          window.XMLHttpRequest = function(){
            var xhr = new OrigXHR();
            var _open = xhr.open;
            var _url = '';
            var _method = 'GET';
            var _t0 = 0;
            xhr.open = function(method, url){
              _url = String(url || '');
              _method = String(method || 'GET');
              send('debug', ['[xhr] → ' + _method + ' ' + _url], { net: 'request', url: _url, method: _method });
              return _open.apply(xhr, arguments);
            };
            var _send = xhr.send;
            xhr.send = function(){
              _t0 = Date.now();
              xhr.addEventListener('loadend', function(){
                var dur = Date.now() - _t0;
                var status = xhr.status;
                var level = status >= 400 ? 'error' : 'debug';
                send(level, ['[xhr] ← ' + status + ' ' + _url + ' (' + dur + 'ms)'], { net: 'response', url: _url, status: status, duration: dur });
              });
              return _send.apply(xhr, arguments);
            };
            return xhr;
          };
        }

        window.addEventListener('message', function(e){
          if (!e.data || typeof e.data !== 'object') return;
          if (e.data.type === 'nm-preview-request-dom') {
            try {
              parent.postMessage({
                type: 'nm-preview-dom',
                requestId: e.data.requestId,
                tree: serializeNode(document.documentElement, 0, 5)
              }, '*');
            } catch(err){}
          }
          if (e.data.type === 'nm-preview-request-styles') {
            try {
              var el = document.querySelector(e.data.selector);
              if (!el) return;
              var computed = window.getComputedStyle(el);
              var styles = {};
              for (var i = 0; i < computed.length; i++) {
                var prop = computed[i];
                styles[prop] = computed.getPropertyValue(prop);
              }
              parent.postMessage({
                type: 'nm-preview-styles',
                requestId: e.data.requestId,
                selector: e.data.selector,
                styles: styles
              }, '*');
            } catch(err){}
          }
        });

        function serializeNode(node, depth, maxDepth){
          if (!node || depth > maxDepth) return null;
          var out = {
            tag: (node.tagName || '').toLowerCase(),
            id: node.id || null,
            classes: node.className && typeof node.className === 'string' ? node.className.split(/\\s+/).filter(Boolean) : [],
            children: [],
            text: null
          };
          if (node.nodeType === 3) {
            out.tag = '#text';
            out.text = (node.textContent || '').slice(0, 100);
            return out;
          }
          for (var i = 0; i < node.childNodes.length && i < 30; i++) {
            var child = serializeNode(node.childNodes[i], depth+1, maxDepth);
            if (child) out.children.push(child);
          }
          return out;
        }

        parent.postMessage({ type: 'nm-preview-ready' }, '*');
      })();
    `;

    return `<!DOCTYPE html>
<html lang="${CFG.locale}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vista previa</title>
<style>${base}</style>
<style>${css}</style>
</head>
<body>
${html}
<script>${bridge}</script>
<script>try{${js}}catch(e){console.error('Runtime: ' + e.message)}</script>
</body>
</html>`;
  }

  /* ═══════════════════════════════════════════════════════════════════
     7 · STATE · máquina de estados del modal
     ═══════════════════════════════════════════════════════════════════ */

  const MODAL_STATE = {
    IDLE: 'idle',
    OPENING: 'opening',
    READY: 'ready',
    CLOSING: 'closing',
  };

  const state = {
    modalState: MODAL_STATE.IDLE,
    isOpen: false,

    parts: { html: '', css: '', js: '' },
    originalParts: { html: '', css: '', js: '' },
    language: 'html',
    title: '',

    activeTab: 'preview',
    theme: localStorage.getItem(CFG.keys.theme) || 'device',
    device: localStorage.getItem(CFG.keys.device) || 'desktop',
    zoom: parseFloat(localStorage.getItem(CFG.keys.zoom) || String(CFG.zoom.default)),

    consoleLines: [],
    consoleFilter: 'all',
    consoleSearch: '',

    domTree: null,
    networkLines: [],

    history: [],
    historyIndex: -1,

    messageListener: null,
    keydownListener: null,
    currentRequestId: 0,

    iframeReady: false,
    iframeError: false,
    iframeTimeout: null,
    hasCodeErrors: false,
  };

  /* ═══════════════════════════════════════════════════════════════════
     8 · MODAL CREATION
     ═══════════════════════════════════════════════════════════════════ */

  function ensureModal() {
    let modal = document.getElementById('nm-preview-modal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'nm-preview-modal';
    modal.className = 'nm-preview-modal';
    modal.hidden = true;
    modal.innerHTML = `
      <div class="nm-preview-modal__backdrop" data-action="close"></div>
      <div class="nm-preview-modal__panel" role="dialog" aria-modal="true" aria-label="${t('title')}">

        <header class="nm-preview-modal__head">
          <div class="nm-preview-modal__title">
            <span class="nm-preview-modal__dot"></span>
            <span class="nm-preview-modal__title-text" data-title>${t('title')}</span>
            <span class="nm-preview-modal__badge" data-lang-badge>html</span>
          </div>

          <div class="nm-preview-modal__header-group">
            <div class="nm-preview-modal__device-picker" data-device-picker>
              <button class="nm-preview-modal__device-btn" data-device="desktop" title="${t('device').desktop}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
              </button>
              <button class="nm-preview-modal__device-btn" data-device="tablet" title="${t('device').tablet}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
              </button>
              <button class="nm-preview-modal__device-btn" data-device="mobile" title="${t('device').mobile}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
              </button>
            </div>

            <div class="nm-preview-modal__zoom" data-zoom-control>
              <button class="nm-preview-modal__zoom-btn" data-zoom="out" title="Zoom out">−</button>
              <span class="nm-preview-modal__zoom-value" data-zoom-value>100%</span>
              <button class="nm-preview-modal__zoom-btn" data-zoom="in" title="Zoom in">+</button>
            </div>

            <button class="nm-preview-modal__btn" data-action="theme" title="${t('theme')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            </button>
          </div>

          <div class="nm-preview-modal__actions">
            <button class="nm-preview-modal__btn" data-action="templates" title="${t('templates')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </button>
            <button class="nm-preview-modal__btn" data-action="screenshot" title="${t('screenshot')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
            </button>
            <button class="nm-preview-modal__btn" data-action="reload" title="${t('reload')} (Ctrl+Enter)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            </button>
            <button class="nm-preview-modal__btn" data-action="save" title="${t('save')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            </button>
            <button class="nm-preview-modal__btn" data-action="share" title="${t('share')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            </button>
            <button class="nm-preview-modal__btn" data-action="download" title="${t('download')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
            <button class="nm-preview-modal__btn" data-action="copy" title="${t('copy')}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            </button>
            <button class="nm-preview-modal__btn" data-action="fullscreen" title="${t('fullscreen')} (F)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>
            </button>
            <button class="nm-preview-modal__btn nm-preview-modal__btn--close" data-action="close" title="${t('close')} (Esc)">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          </div>
        </header>

        <nav class="nm-preview-modal__tabs" role="tablist">
          <button class="nm-preview-modal__tab is-active" data-tab="preview" role="tab">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
            ${t('preview')}
          </button>
          <button class="nm-preview-modal__tab" data-tab="code" role="tab">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
            ${t('code')}
          </button>
          <button class="nm-preview-modal__tab" data-tab="console" role="tab">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
            ${t('console')}
            <span class="nm-preview-modal__tab-badge" data-console-count hidden>0</span>
          </button>
          <button class="nm-preview-modal__tab" data-tab="elements" role="tab">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="12" y1="2" x2="12" y2="22"/></svg>
            ${t('elements')}
          </button>
          <button class="nm-preview-modal__tab" data-tab="network" role="tab">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a10 10 0 1 0 10 10"/><path d="M12 12l7-7"/><circle cx="12" cy="12" r="3"/></svg>
            ${t('network')}
            <span class="nm-preview-modal__tab-badge" data-network-count hidden>0</span>
          </button>
        </nav>

        <div class="nm-preview-modal__body">
          <div class="nm-preview-modal__view" data-view="preview">
            <div class="nm-preview-modal__canvas" data-canvas>
              <div class="nm-preview-modal__device-frame" data-device-frame>
                <iframe class="nm-preview-modal__iframe" sandbox="allow-scripts allow-modals allow-popups" referrerpolicy="no-referrer" loading="eager" title="Vista previa de código" data-iframe></iframe>
              </div>
              <div class="nm-preview-modal__loading" data-loading>
                <div class="nm-preview-modal__spinner"></div>
                <span>${t('loading')}</span>
              </div>
              <div class="nm-preview-modal__error" data-error hidden>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                <p data-error-message>${t('error')}</p>
              </div>
            </div>
          </div>

          <div class="nm-preview-modal__view" data-view="code" hidden>
            <div class="nm-preview-modal__code-toolbar">
              <span class="nm-preview-modal__code-stats" data-code-stats></span>
              <div class="nm-preview-modal__code-actions">
                <button class="nm-preview-modal__code-btn" data-action="undo" title="${t('undo')} (Ctrl+Z)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M3 13a9 9 0 1 0 3-7.7L3 8"/></svg>
                </button>
                <button class="nm-preview-modal__code-btn" data-action="redo" title="${t('redo')} (Ctrl+Y)">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M21 13a9 9 0 1 1-3-7.7L21 8"/></svg>
                </button>
                <button class="nm-preview-modal__code-btn" data-action="reset" title="${t('reset')}">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
                </button>
              </div>
            </div>
            <div class="nm-preview-modal__code-wrap">
              <div class="nm-preview-modal__code-editor">
                <div class="nm-preview-modal__code-lines" data-code-lines></div>
                <textarea class="nm-preview-modal__code-textarea" data-code-textarea spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
              </div>
            </div>
          </div>

          <div class="nm-preview-modal__view" data-view="console" hidden>
            <div class="nm-preview-modal__console-toolbar">
              <div class="nm-preview-modal__console-filters">
                <button class="nm-preview-modal__filter is-active" data-filter="all">Todo</button>
                <button class="nm-preview-modal__filter" data-filter="log">Log</button>
                <button class="nm-preview-modal__filter" data-filter="info">Info</button>
                <button class="nm-preview-modal__filter" data-filter="warn">Warn</button>
                <button class="nm-preview-modal__filter" data-filter="error">Error</button>
              </div>
              <label class="nm-preview-modal__console-search">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                <input type="text" placeholder="${t('search')}" data-console-search />
              </label>
              <button class="nm-preview-modal__code-btn" data-action="clear-console" title="${t('clear')}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
              </button>
            </div>
            <div class="nm-preview-modal__console" data-console-output>
              <div class="nm-preview-modal__console-empty">${t('emptyConsole')}</div>
            </div>
          </div>

          <div class="nm-preview-modal__view" data-view="elements" hidden>
            <div class="nm-preview-modal__elements-toolbar">
              <button class="nm-preview-modal__code-btn" data-action="refresh-dom" title="${t('reload')}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
              </button>
            </div>
            <div class="nm-preview-modal__elements" data-elements-tree>
              <div class="nm-preview-modal__console-empty">${t('elementsEmpty')}</div>
            </div>
          </div>

          <div class="nm-preview-modal__view" data-view="network" hidden>
            <div class="nm-preview-modal__console-toolbar">
              <button class="nm-preview-modal__code-btn" data-action="clear-network" title="${t('clear')}">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>
              </button>
            </div>
            <div class="nm-preview-modal__network" data-network-output>
              <div class="nm-preview-modal__console-empty">${t('networkEmpty')}</div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    /* Event delegation en el modal */
    modal.addEventListener('click', (e) => {
      const actionEl = e.target.closest('[data-action]');
      if (actionEl) { handleAction(actionEl.dataset.action); return; }

      const tabEl = e.target.closest('[data-tab]');
      if (tabEl) { switchTab(tabEl.dataset.tab); return; }

      const deviceBtn = e.target.closest('[data-device]');
      if (deviceBtn) { setDevice(deviceBtn.dataset.device); return; }

      const zoomBtn = e.target.closest('[data-zoom]');
      if (zoomBtn) { zoomAction(zoomBtn.dataset.zoom); return; }

      const filterBtn = e.target.closest('[data-filter]');
      if (filterBtn) { setConsoleFilter(filterBtn.dataset.filter); return; }
    });

    /* Console search */
    const searchInput = modal.querySelector('[data-console-search]');
    if (searchInput) {
      searchInput.addEventListener('input', debounce(() => {
        state.consoleSearch = searchInput.value.toLowerCase();
        renderConsole();
      }, 120));
    }

    /* Code editor */
    const textarea = modal.querySelector('[data-code-textarea]');
    if (textarea) {
      textarea.addEventListener('input', debounce(() => {
        applyEdit(textarea.value);
      }, CFG.reloadDebounceMs));
      textarea.addEventListener('keydown', handleEditorKeydown);
      textarea.addEventListener('scroll', syncLineNumbers, { passive: true });
    }

    /* Message from iframe */
    state.messageListener = (e) => handleIframeMessage(e);
    window.addEventListener('message', state.messageListener);

    /* Keyboard shortcuts */
    state.keydownListener = (e) => globalKeydown(e);
    document.addEventListener('keydown', state.keydownListener);

    updateZoomDisplay();
    updateDeviceButtons();

    return modal;
  }

  /* ═══════════════════════════════════════════════════════════════════
     9 · ACTION HANDLERS
     ═══════════════════════════════════════════════════════════════════ */

  function handleAction(action) {
    switch (action) {
      case 'close':          return close();
      case 'reload':         return reloadIframe();
      case 'theme':          return cycleTheme();
      case 'copy':           return copyCode();
      case 'download':       return downloadHtml();
      case 'share':          return sharePreview();
      case 'save':           return savePreview();
      case 'screenshot':     return takeScreenshot();
      case 'fullscreen':     return toggleFullscreen();
      case 'templates':      return showTemplates();
      case 'undo':           return undo();
      case 'redo':           return redo();
      case 'reset':          return resetCode();
      case 'clear-console':  return clearConsole();
      case 'clear-network':  return clearNetwork();
      case 'refresh-dom':    return refreshElements();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     10 · IFRAME MANAGEMENT
     ═══════════════════════════════════════════════════════════════════ */

  function reloadIframe() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal || !state.parts) return;

    const iframe = modal.querySelector('[data-iframe]');
    const loading = modal.querySelector('[data-loading]');
    const error = modal.querySelector('[data-error]');

    if (!iframe) return;

    /* Limpiar timeout previo */
    if (state.iframeTimeout) {
      clearTimeout(state.iframeTimeout);
      state.iframeTimeout = null;
    }

    state.iframeReady = false;
    state.iframeError = false;
    state.hasCodeErrors = false;

    if (loading) loading.hidden = false;
    if (error) error.hidden = true;

    const doc = buildDocument({
      html: state.parts.html,
      css: state.parts.css,
      js: state.parts.js,
      theme: state.theme,
    });

    iframe.srcdoc = doc;

    /* Timeout de carga */
    state.iframeTimeout = setTimeout(() => {
      if (!state.iframeReady && !state.iframeError) {
        state.iframeError = true;
        if (loading) loading.hidden = true;
        if (error) {
          error.hidden = false;
          const msg = error.querySelector('[data-error-message]');
          if (msg) msg.textContent = 'La vista previa tardó demasiado en cargar. Probá con menos código.';
        }
        emit('nm:preview:error', { reason: 'timeout' });
      }
    }, CFG.iframeLoadTimeoutMs);

    emit('nm:preview:reload', { at: Date.now() });
  }

  function handleIframeMessage(e) {
    if (!state.isOpen) return;
    if (!e.data || typeof e.data !== 'object') return;
    const { type } = e.data;

    if (type === 'nm-preview-ready') {
      state.iframeReady = true;
      if (state.iframeTimeout) {
        clearTimeout(state.iframeTimeout);
        state.iframeTimeout = null;
      }
      const modal = document.getElementById('nm-preview-modal');
      const loading = modal && modal.querySelector('[data-loading]');
      if (loading) loading.hidden = true;
      log('iframe ready');
      return;
    }

    if (type === 'nm-preview-console') {
      addConsoleLine(e.data.level, e.data.message, e.data.at, e.data.meta);
      return;
    }

    if (type === 'nm-preview-dom') {
      state.domTree = e.data.tree;
      renderElements();
      return;
    }

    if (type === 'nm-preview-styles') {
      log('styles received', e.data);
      return;
    }
  }

  function refreshElements() {
    const modal = document.getElementById('nm-preview-modal');
    const iframe = modal && modal.querySelector('[data-iframe]');
    if (!iframe || !iframe.contentWindow) return;
    const reqId = ++state.currentRequestId;
    iframe.contentWindow.postMessage({ type: 'nm-preview-request-dom', requestId: reqId }, '*');
  }

  function syncLineNumbers() {
    const modal = document.getElementById('nm-preview-modal');
    const textarea = modal && modal.querySelector('[data-code-textarea]');
    const linesEl = modal && modal.querySelector('[data-code-lines]');
    if (!textarea || !linesEl) return;
    linesEl.scrollTop = textarea.scrollTop;
  }

  /* ═══════════════════════════════════════════════════════════════════
     11 · CONSOLE
     ═══════════════════════════════════════════════════════════════════ */

  function addConsoleLine(level, message, at, meta) {
    state.consoleLines.push({
      level: level || 'log',
      message: String(message || ''),
      at: at || Date.now(),
      meta: meta || {},
    });

    if (state.consoleLines.length > CFG.maxConsoleLines) {
      state.consoleLines.shift();
    }

    if (level === 'error') state.hasCodeErrors = true;

    if (meta && (meta.net === 'request' || meta.net === 'response')) {
      state.networkLines.push({
        kind: meta.net,
        url: meta.url,
        status: meta.status || null,
        method: meta.method || 'GET',
        duration: meta.duration || null,
        at: at || Date.now(),
      });
      if (state.networkLines.length > CFG.maxNetworkLines) state.networkLines.shift();
      updateNetworkBadge();
      if (state.activeTab === 'network') renderNetwork();
    }

    renderConsole();
    updateConsoleBadge();

    /* Auto-switch a console si hay error y estamos en preview */
    if (level === 'error' && state.activeTab === 'preview' && state.iframeReady) {
      /* Solo auto-switch la primera vez */
      if (!state._autoSwitchedToConsole) {
        state._autoSwitchedToConsole = true;
        setTimeout(() => {
          if (state.activeTab === 'preview' && state.hasCodeErrors) {
            switchTab('console');
          }
        }, 400);
      }
    }
  }

  function renderConsole() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    const out = modal.querySelector('[data-console-output]');
    if (!out) return;

    const filtered = state.consoleLines.filter((l) => {
      if (state.consoleFilter !== 'all' && l.level !== state.consoleFilter) return false;
      if (state.consoleSearch && !l.message.toLowerCase().includes(state.consoleSearch)) return false;
      return true;
    });

    if (filtered.length === 0) {
      out.innerHTML = `<div class="nm-preview-modal__console-empty">${
        state.consoleSearch || state.consoleFilter !== 'all'
          ? 'Sin resultados'
          : t('emptyConsole')
      }</div>`;
      return;
    }

    /* Virtual-ish render: solo los últimos 300 */
    const MAX_RENDER = 300;
    const slice = filtered.length > MAX_RENDER ? filtered.slice(-MAX_RENDER) : filtered;

    const frag = document.createDocumentFragment();
    for (const l of slice) {
      const icon = l.level === 'error' ? '✕'
                 : l.level === 'warn' ? '⚠'
                 : l.level === 'info' ? 'ⓘ'
                 : l.level === 'debug' ? '›'
                 : '›';
      const div = document.createElement('div');
      div.className = `nm-preview-modal__console-line nm-preview-modal__console-line--${l.level}`;
      div.innerHTML = `<span class="nm-preview-modal__console-time">${esc(fmtTime(l.at))}</span>`
        + `<span class="nm-preview-modal__console-icon">${icon}</span>`
        + `<span class="nm-preview-modal__console-msg">${esc(l.message)}</span>`;
      frag.appendChild(div);
    }

    out.innerHTML = '';
    out.appendChild(frag);
    out.scrollTop = out.scrollHeight;
  }

  function updateConsoleBadge() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    const badge = modal.querySelector('[data-console-count]');
    if (!badge) return;

    if (state.consoleLines.length === 0) { badge.hidden = true; return; }
    badge.hidden = false;
    badge.textContent = String(state.consoleLines.length);

    const hasError = state.consoleLines.some((l) => l.level === 'error');
    const hasWarn = state.consoleLines.some((l) => l.level === 'warn');
    badge.classList.toggle('is-error', hasError);
    badge.classList.toggle('is-warn', !hasError && hasWarn);
  }

  function setConsoleFilter(filter) {
    state.consoleFilter = filter;
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    modal.querySelectorAll('[data-filter]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.filter === filter);
    });
    renderConsole();
  }

  function clearConsole() {
    state.consoleLines = [];
    state.hasCodeErrors = false;
    state._autoSwitchedToConsole = false;
    renderConsole();
    updateConsoleBadge();
  }

  function clearNetwork() {
    state.networkLines = [];
    renderNetwork();
    updateNetworkBadge();
  }

  function updateNetworkBadge() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    const badge = modal.querySelector('[data-network-count]');
    if (!badge) return;
    if (state.networkLines.length === 0) { badge.hidden = true; return; }
    badge.hidden = false;
    badge.textContent = String(state.networkLines.length);
  }

  function renderNetwork() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    const out = modal.querySelector('[data-network-output]');
    if (!out) return;

    if (state.networkLines.length === 0) {
      out.innerHTML = `<div class="nm-preview-modal__console-empty">${t('networkEmpty')}</div>`;
      return;
    }

    const html = state.networkLines.map((n) => {
      const status = n.status != null ? n.status : '—';
      const statusClass = status >= 400 ? 'nm-preview-modal__net-status--err'
                       : status >= 300 ? 'nm-preview-modal__net-status--warn'
                       : 'nm-preview-modal__net-status--ok';
      return `<div class="nm-preview-modal__net-line">
        <span class="nm-preview-modal__net-kind nm-preview-modal__net-kind--${esc(n.kind)}">${esc(n.kind)}</span>
        <span class="nm-preview-modal__net-method">${esc(n.method)}</span>
        <span class="nm-preview-modal__net-url">${esc(n.url)}</span>
        <span class="nm-preview-modal__net-status ${statusClass}">${status}</span>
        ${n.duration ? `<span class="nm-preview-modal__net-duration">${n.duration}ms</span>` : ''}
      </div>`;
    }).join('');

    out.innerHTML = html;
  }

  /* ═══════════════════════════════════════════════════════════════════
     12 · ELEMENTS
     ═══════════════════════════════════════════════════════════════════ */

  function renderElements() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    const out = modal.querySelector('[data-elements-tree]');
    if (!out) return;

    if (!state.domTree) {
      out.innerHTML = `<div class="nm-preview-modal__console-empty">${t('elementsEmpty')}</div>`;
      return;
    }
    out.innerHTML = renderNode(state.domTree, 0);
  }

  function renderNode(node, depth) {
    if (!node) return '';
    const indent = '  '.repeat(depth);
    const cls = node.classes && node.classes.length > 0
      ? '.' + node.classes.slice(0, 3).join('.')
      : '';
    const id = node.id ? '#' + node.id : '';

    if (node.tag === '#text') {
      const text = (node.text || '').trim();
      if (!text) return '';
      return `<div class="nm-preview-modal__el-line nm-preview-modal__el-line--text" style="padding-left:${depth * 14}px">${esc(indent)}<span class="nm-preview-modal__el-text">"${esc(text.slice(0, 60))}"</span></div>`;
    }

    let html = `<div class="nm-preview-modal__el-line" style="padding-left:${depth * 14}px">
      <span class="nm-preview-modal__el-tag">&lt;${esc(node.tag)}</span>
      <span class="nm-preview-modal__el-id">${esc(id)}</span>
      <span class="nm-preview-modal__el-class">${esc(cls)}</span>
      <span class="nm-preview-modal__el-tag">&gt;</span>
    </div>`;

    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        html += renderNode(child, depth + 1);
      }
    }
    return html;
  }

  /* ═══════════════════════════════════════════════════════════════════
     13 · TABS
     ═══════════════════════════════════════════════════════════════════ */

  function switchTab(name) {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;

    state.activeTab = name;

    modal.querySelectorAll('[data-tab]').forEach((t) => {
      t.classList.toggle('is-active', t.dataset.tab === name);
    });
    modal.querySelectorAll('[data-view]').forEach((v) => {
      v.hidden = v.dataset.view !== name;
    });

    if (name === 'console') {
      renderConsole();
      const searchInput = modal.querySelector('[data-console-search]');
      if (searchInput) setTimeout(() => searchInput.focus(), 80);
      setTimeout(() => {
        const out = modal.querySelector('[data-console-output]');
        if (out) out.scrollTop = out.scrollHeight;
      }, 30);
    }
    if (name === 'elements' && !state.domTree) refreshElements();
    if (name === 'network') renderNetwork();
    if (name === 'code') {
      const textarea = modal.querySelector('[data-code-textarea]');
      if (textarea) setTimeout(() => textarea.focus(), 50);
      updateCodeStats();
      updateLineNumbers();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     14 · EDITOR
     ═══════════════════════════════════════════════════════════════════ */

  function getRawCode() {
    let out = '';
    if (state.parts.html) out += `<!-- HTML -->\n${state.parts.html}\n\n`;
    if (state.parts.css)  out += `/* CSS */\n${state.parts.css}\n\n`;
    if (state.parts.js)   out += `// JavaScript\n${state.parts.js}\n`;
    return out.trim();
  }

  function applyEdit(newRaw) {
    const parts = parseEditedCode(newRaw);
    if (!parts) return;
    state.parts = parts;
    pushHistory(newRaw);
    saveDraft();
    reloadIframe();
    updateCodeStats();
    updateLineNumbers();
  }

  function parseEditedCode(raw) {
    let html = '';
    let css = '';
    let js = '';

    const htmlMatch = raw.match(/<!-- HTML -->\s*([\s\S]*?)(?=(\/\* CSS \*\/|\/\/ JavaScript|$))/i);
    const cssMatch  = raw.match(/\/\* CSS \*\/\s*([\s\S]*?)(?=(\/\/ JavaScript|$))/i);
    const jsMatch   = raw.match(/\/\/ JavaScript\s*([\s\S]*)$/i);

    if (htmlMatch) html = htmlMatch[1].trim();
    if (cssMatch)  css  = cssMatch[1].trim();
    if (jsMatch)   js   = jsMatch[1].trim();

    if (!html && !css && !js) html = raw;

    return { html, css, js };
  }

  function updateLineNumbers() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    const textarea = modal.querySelector('[data-code-textarea]');
    const linesEl = modal.querySelector('[data-code-lines]');
    if (!textarea || !linesEl) return;

    const lineCount = textarea.value.split('\n').length;
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= lineCount; i++) {
      const div = document.createElement('div');
      div.className = 'nm-preview-modal__code-line';
      div.textContent = String(i);
      frag.appendChild(div);
    }
    linesEl.innerHTML = '';
    linesEl.appendChild(frag);
    linesEl.scrollTop = textarea.scrollTop;
  }

  function updateCodeStats() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    const stats = modal.querySelector('[data-code-stats]');
    if (!stats) return;

    const raw = getRawCode();
    const lines = raw.split('\n').length;
    const chars = raw.length;
    stats.textContent = `${lines} ${t('lines')} · ${chars} ${t('chars')} · ${fmtBytes(chars)}`;
  }

  function handleEditorKeydown(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const t = e.target;
      const start = t.selectionStart;
      const end = t.selectionEnd;
      const value = t.value;

      if (start === end) {
        t.value = value.slice(0, start) + '  ' + value.slice(end);
        t.selectionStart = t.selectionEnd = start + 2;
      } else {
        const lines = value.slice(start, end).split('\n');
        const indented = lines.map((l) => '  ' + l).join('\n');
        t.value = value.slice(0, start) + indented + value.slice(end);
        t.selectionStart = start;
        t.selectionEnd = end + (indented.length - (end - start));
      }
      t.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) {
      e.preventDefault();
      redo();
      return;
    }
  }

  function pushHistory(raw) {
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(raw);
    if (state.history.length > 50) state.history.shift();
    state.historyIndex = state.history.length - 1;
  }

  function undo() {
    if (state.historyIndex <= 0) return;
    state.historyIndex--;
    setEditorContent(state.history[state.historyIndex], false);
  }

  function redo() {
    if (state.historyIndex >= state.history.length - 1) return;
    state.historyIndex++;
    setEditorContent(state.history[state.historyIndex], false);
  }

  function setEditorContent(raw, addToHistory = true) {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    const textarea = modal.querySelector('[data-code-textarea]');
    if (!textarea) return;
    textarea.value = raw;
    if (addToHistory) pushHistory(raw);
    const parts = parseEditedCode(raw);
    if (parts) {
      state.parts = parts;
      reloadIframe();
    }
    updateLineNumbers();
    updateCodeStats();
    saveDraft();
  }

  async function resetCode() {
    const ok = await showConfirm(t('reset'), t('resetConfirm'));
    if (!ok) return;
    state.parts = { ...state.originalParts };
    const modal = document.getElementById('nm-preview-modal');
    const textarea = modal.querySelector('[data-code-textarea]');
    if (textarea) textarea.value = getRawCode();
    reloadIframe();
    updateLineNumbers();
    updateCodeStats();
    state.history = [];
    state.historyIndex = -1;
    pushHistory(getRawCode());
  }

  /* ═══════════════════════════════════════════════════════════════════
     15 · ZOOM / DEVICE / THEME
     ═══════════════════════════════════════════════════════════════════ */

  function zoomAction(action) {
    if (action === 'in')         state.zoom = Math.min(CFG.zoom.max, state.zoom + CFG.zoom.step);
    else if (action === 'out')   state.zoom = Math.max(CFG.zoom.min, state.zoom - CFG.zoom.step);
    else if (action === 'reset') state.zoom = CFG.zoom.default;
    applyZoom();
  }

  function applyZoom() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    const frame = modal.querySelector('[data-device-frame]');
    if (!frame) return;
    frame.style.transform = `scale(${state.zoom})`;
    frame.style.transformOrigin = 'top center';
    updateZoomDisplay();
    localStorage.setItem(CFG.keys.zoom, String(state.zoom));
  }

  function updateZoomDisplay() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    const el = modal.querySelector('[data-zoom-value]');
    if (el) el.textContent = Math.round(state.zoom * 100) + '%';
  }

  function setDevice(name) {
    if (!CFG.devices[name]) return;
    state.device = name;
    applyDevice();
    localStorage.setItem(CFG.keys.device, name);
    updateDeviceButtons();
  }

  function applyDevice() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    const frame = modal.querySelector('[data-device-frame]');
    if (!frame) return;

    const dev = CFG.devices[state.device] || CFG.devices.desktop;

    /* En desktop, dejar que el CSS maneje el 100% */
    if (state.device === 'desktop') {
      frame.style.width = '';
      frame.style.height = '';
    } else {
      frame.style.width = dev.width + 'px';
      frame.style.height = dev.height + 'px';
    }

    if (state.zoom > 1) {
      state.zoom = 1;
      applyZoom();
    }
  }

  function updateDeviceButtons() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    modal.querySelectorAll('[data-device]').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.device === state.device);
    });
  }

  function cycleTheme() {
    const themes = ['device', 'light', 'dark'];
    const idx = themes.indexOf(state.theme);
    state.theme = themes[(idx + 1) % themes.length];
    localStorage.setItem(CFG.keys.theme, state.theme);
    toast('ok', 'Tema: ' + state.theme);
    reloadIframe();
  }

  function toggleFullscreen() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    const panel = modal.querySelector('.nm-preview-modal__panel');
    if (!panel) return;
    panel.classList.toggle('is-fullscreen');
  }

  /* ═══════════════════════════════════════════════════════════════════
     16 · ACTIONS · copy/download/share/save/screenshot
     ═══════════════════════════════════════════════════════════════════ */

  async function copyCode() {
    const raw = getRawCode();
    try {
      await navigator.clipboard.writeText(raw);
      toast('ok', t('copyCode') + ' · ' + t('copied'));
    } catch (e) {
      toast('err', 'No pude copiar');
    }
  }

  function downloadHtml() {
    const doc = buildDocument({
      html: state.parts.html,
      css: state.parts.css,
      js: state.parts.js,
      theme: state.theme,
    });
    const blob = new Blob([doc], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `numination-preview-${Date.now()}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('ok', 'Descargado .html');
  }

  async function takeScreenshot() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;
    const iframe = modal.querySelector('[data-iframe]');
    if (!iframe || !iframe.contentWindow) return;

    try {
      const doc = iframe.contentDocument;
      if (!doc) { toast('err', t('screenshotError')); return; }

      const html = doc.documentElement.outerHTML;
      const w = iframe.clientWidth;
      const h = iframe.clientHeight;

      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
          <foreignObject width="100%" height="100%">
            <div xmlns="http://www.w3.org/1999/xhtml">${html}</div>
          </foreignObject>
        </svg>
      `;

      const img = new Image();
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = url;
      });

      const canvas = document.createElement('canvas');
      canvas.width = w * 2;
      canvas.height = h * 2;
      const ctx = canvas.getContext('2d');
      ctx.scale(2, 2);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url);

      canvas.toBlob((blob) => {
        const dlUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = dlUrl;
        a.download = `numination-preview-${Date.now()}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(dlUrl);
        toast('ok', 'Captura guardada');
      }, 'image/png');
    } catch (e) {
      log('screenshot error', e);
      toast('err', t('screenshotError'));
    }
  }

  async function sharePreview() {
    try {
      const res = await fetch(CFG.shareEndpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: state.parts.html,
          css: state.parts.css,
          js: state.parts.js,
          language: state.language,
          title: state.title || 'Preview',
        }),
      });
      const data = await res.json();
      if (data.ok && data.url) {
        const fullUrl = location.origin + data.url;
        try {
          await navigator.clipboard.writeText(fullUrl);
          toast('ok', t('shareSuccess'));
        } catch {
          prompt(t('copyUrl'), fullUrl);
        }
      } else {
        toast('err', data.message || t('shareError'));
      }
    } catch (e) {
      toast('err', t('shareError'));
    }
  }

  async function savePreview() {
    try {
      const res = await fetch(CFG.sandboxEndpoint, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          html: state.parts.html,
          css: state.parts.css,
          js: state.parts.js,
          language: state.language,
          title: state.title || 'Preview',
          persistent: true,
        }),
      });
      const data = await res.json();
      if (data.ok) toast('ok', t('saveSuccess'));
      else toast('err', data.message || t('saveError'));
    } catch (e) {
      toast('err', t('saveError'));
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     17 · TEMPLATES
     ═══════════════════════════════════════════════════════════════════ */

  const QUICK_TEMPLATES = [
    { id: 'blank', name: 'Vacío', icon: '📄' },
    { id: 'landing', name: 'Landing', icon: '🚀' },
    { id: 'form', name: 'Formulario', icon: '📝' },
    { id: 'dashboard', name: 'Dashboard', icon: '📊' },
    { id: 'chat', name: 'Chat UI', icon: '💬' },
    { id: 'todo', name: 'Todo', icon: '✅' },
    { id: 'calculator', name: 'Calc', icon: '🧮' },
    { id: 'clock', name: 'Reloj', icon: '⏰' },
    { id: 'quiz', name: 'Quiz', icon: '❓' },
    { id: 'weather', name: 'Clima', icon: '☁️' },
  ];

  function showTemplates() {
    const modal = document.getElementById('nm-preview-modal');
    if (!modal) return;

    let overlay = modal.querySelector('.nm-preview-templates');
    if (overlay) { overlay.remove(); return; }

    overlay = document.createElement('div');
    overlay.className = 'nm-preview-templates';
    overlay.innerHTML = `
      <div class="nm-preview-templates__panel">
        <h3>${t('templates')}</h3>
        <div class="nm-preview-templates__grid">
          ${QUICK_TEMPLATES.map((tpl) => `
            <button class="nm-preview-templates__item" data-template="${tpl.id}">
              <span class="nm-preview-templates__icon">${tpl.icon}</span>
              <span class="nm-preview-templates__name">${esc(tpl.name)}</span>
            </button>
          `).join('')}
        </div>
      </div>
    `;
    modal.querySelector('.nm-preview-modal__panel').appendChild(overlay);

    overlay.addEventListener('click', async (e) => {
      if (e.target === overlay) { overlay.remove(); return; }
      const item = e.target.closest('[data-template]');
      if (!item) return;

      const tplId = item.dataset.template;
      overlay.remove();

      const ok = await showConfirm(t('applyTemplate'), t('applyTemplateConfirm'));
      if (!ok) return;

      await applyTemplate(tplId);
    });
  }

  async function applyTemplate(tplId) {
    try {
      const res = await fetch(`/api/sandbox/templates/${tplId}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        if (data.ok && data.template) {
          state.parts = {
            html: data.template.html || '',
            css: data.template.css || '',
            js: data.template.js || '',
          };
        }
      }
    } catch {
      const fallback = getInlineTemplate(tplId);
      if (fallback) state.parts = fallback;
    }

    const modal = document.getElementById('nm-preview-modal');
    const textarea = modal.querySelector('[data-code-textarea]');
    if (textarea) textarea.value = getRawCode();

    reloadIframe();
    updateLineNumbers();
    updateCodeStats();
    saveDraft();
    pushHistory(getRawCode());
  }

  function getInlineTemplate(id) {
    const tpls = {
      blank: {
        html: '<h1>Hola Numination</h1><p>Editá este contenido</p>',
        css: 'body{font-family:system-ui;padding:40px;background:#f5f5f7}h1{font-size:32px;letter-spacing:-.02em}p{color:#6b6b70}',
        js: '',
      },
    };
    return tpls[id] || null;
  }

  /* ═══════════════════════════════════════════════════════════════════
     18 · CONFIRM MODAL
     ═══════════════════════════════════════════════════════════════════ */

  function showConfirm(title, message) {
    return new Promise((resolve) => {
      const modal = document.getElementById('nm-preview-modal');
      if (!modal) return resolve(false);

      const overlay = document.createElement('div');
      overlay.className = 'nm-preview-confirm';
      overlay.innerHTML = `
        <div class="nm-preview-confirm__panel">
          <h3>${esc(title)}</h3>
          <p>${esc(message)}</p>
          <div class="nm-preview-confirm__actions">
            <button class="nm-preview-confirm__btn" data-cancel>Cancelar</button>
            <button class="nm-preview-confirm__btn nm-preview-confirm__btn--primary" data-ok>Continuar</button>
          </div>
        </div>
      `;
      modal.querySelector('.nm-preview-modal__panel').appendChild(overlay);

      overlay.querySelector('[data-cancel]').addEventListener('click', () => {
        overlay.remove(); resolve(false);
      });
      overlay.querySelector('[data-ok]').addEventListener('click', () => {
        overlay.remove(); resolve(true);
      });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) { overlay.remove(); resolve(false); }
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     19 · DRAFT PERSISTENCE
     ═══════════════════════════════════════════════════════════════════ */

  const saveDraft = debounce(() => {
    try {
      sessionStorage.setItem(CFG.keys.draft, JSON.stringify({
        html: state.parts.html,
        css: state.parts.css,
        js: state.parts.js,
        at: Date.now(),
      }));
    } catch {}
  }, CFG.autoSaveDebounceMs);

  /* ═══════════════════════════════════════════════════════════════════
     20 · KEYBOARD SHORTCUTS
     ═══════════════════════════════════════════════════════════════════ */

  function globalKeydown(e) {
    if (!state.isOpen) return;

    if (e.key === 'Escape') {
      const modal = document.getElementById('nm-preview-modal');
      const overlay = modal && modal.querySelector('.nm-preview-templates, .nm-preview-confirm');
      if (overlay) { e.preventDefault(); overlay.remove(); return; }
      e.preventDefault();
      close();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      reloadIframe();
      toast('info', 'Recargando…');
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      savePreview();
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'f' && state.activeTab === 'preview') {
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      toggleFullscreen();
      return;
    }

    if (!e.ctrlKey && !e.metaKey && !e.altKey && /^[1-5]$/.test(e.key)) {
      const target = e.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const tabs = ['preview', 'code', 'console', 'elements', 'network'];
      const idx = parseInt(e.key, 10) - 1;
      if (tabs[idx]) { e.preventDefault(); switchTab(tabs[idx]); }
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     21 · OPEN / CLOSE · máquina de estados
     ═══════════════════════════════════════════════════════════════════ */

  function open({ html, css, js, language, title }) {
    /* Evitar doble open */
    if (state.modalState === MODAL_STATE.OPENING || state.modalState === MODAL_STATE.READY) {
      log('modal already open, ignoring');
      return;
    }

    state.modalState = MODAL_STATE.OPENING;

    const modal = ensureModal();

    state.isOpen = true;
    state.language = language || 'html';
    state.title = title || '';
    state.originalParts = { html: html || '', css: css || '', js: js || '' };
    state.parts = { ...state.originalParts };
    state.consoleLines = [];
    state.networkLines = [];
    state.domTree = null;
    state.history = [];
    state.historyIndex = -1;
    state.iframeReady = false;
    state.iframeError = false;
    state.hasCodeErrors = false;
    state._autoSwitchedToConsole = false;

    if (state.iframeTimeout) {
      clearTimeout(state.iframeTimeout);
      state.iframeTimeout = null;
    }

    /* Badge + título */
    const badge = modal.querySelector('[data-lang-badge]');
    if (badge) badge.textContent = state.language;
    const titleEl = modal.querySelector('[data-title]');
    if (titleEl) titleEl.textContent = title || t('title');

    /* Editor */
    const textarea = modal.querySelector('[data-code-textarea]');
    if (textarea) textarea.value = getRawCode();

    /* Reset badges */
    updateConsoleBadge();
    updateNetworkBadge();
    renderConsole();
    renderNetwork();

    /* Device + zoom */
    applyDevice();
    applyZoom();
    updateDeviceButtons();

    /* Mostrar */
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add('is-open'));
    document.body.style.overflow = 'hidden';

    /* Cargar iframe */
    switchTab('preview');
    setTimeout(() => {
      reloadIframe();
      pushHistory(getRawCode());
      updateLineNumbers();
      updateCodeStats();
      state.modalState = MODAL_STATE.READY;
    }, 50);

    emit('nm:preview:opened', { at: Date.now() });
  }

  function close() {
    if (state.modalState === MODAL_STATE.CLOSING || state.modalState === MODAL_STATE.IDLE) return;

    state.modalState = MODAL_STATE.CLOSING;

    const modal = document.getElementById('nm-preview-modal');
    if (!modal) {
      state.modalState = MODAL_STATE.IDLE;
      return;
    }

    state.isOpen = false;
    modal.classList.remove('is-open');

    if (state.iframeTimeout) {
      clearTimeout(state.iframeTimeout);
      state.iframeTimeout = null;
    }

    setTimeout(() => {
      modal.hidden = true;
      const iframe = modal.querySelector('[data-iframe]');
      if (iframe) iframe.srcdoc = '';
      const panel = modal.querySelector('.nm-preview-modal__panel');
      if (panel) panel.classList.remove('is-fullscreen');
      state.modalState = MODAL_STATE.IDLE;
    }, 200);

    document.body.style.overflow = '';
    emit('nm:preview:closed', { at: Date.now() });
  }

  /* ═══════════════════════════════════════════════════════════════════
     22 · ATTACH · inyección del botón en el chat
     ═══════════════════════════════════════════════════════════════════ */

  function attachPreviewButton(codeEl) {
    if (codeEl.__nmPreviewAttached) return;
    codeEl.__nmPreviewAttached = true;

    const lang = getLangFromCodeEl(codeEl);
    if (!isPreviewable(lang)) return;

    const code = getCodeFromCodeEl(codeEl);
    if (!code.trim()) return;

    const pre = codeEl.closest('pre');
    if (!pre) return;

    /* Buscar el head existente */
    const prev = pre.previousElementSibling;
    const existingHead = (prev && prev.classList && prev.classList.contains('md-pre-head'))
      ? prev
      : null;

    /* Crear botón */
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nm-code-preview-btn';
    btn.title = 'Ver vista previa';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/>
        <circle cx="12" cy="12" r="3"/>
      </svg>
      <span>${t('openPreview')}</span>
    `;

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      /* Loading state en el botón */
      const originalHTML = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="animation:nm-preview-spin 0.8s linear infinite">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
        </svg>
        <span>Abriendo…</span>
      `;

      const codeNow = getCodeFromCodeEl(codeEl);
      const langNow = getLangFromCodeEl(codeEl);
      const parts = buildPreviewParts(codeNow, langNow);

      try {
        open({ ...parts, language: langNow });
      } finally {
        setTimeout(() => {
          btn.disabled = false;
          btn.innerHTML = originalHTML;
        }, 300);
      }
    });

    if (existingHead) {
      existingHead.appendChild(btn);
    } else {
      const head = document.createElement('div');
      head.className = 'nm-code-preview-head';
      const lbl = document.createElement('span');
      lbl.textContent = lang;
      head.appendChild(lbl);
      head.appendChild(btn);
      pre.parentNode.insertBefore(head, pre);
    }
  }

  function scanAll() {
    detectCodeBlocks().forEach(attachPreviewButton);
  }

  /* ═══════════════════════════════════════════════════════════════════
     23 · MUTATION OBSERVER
     ═══════════════════════════════════════════════════════════════════ */

  let rescanTimer = null;
  function scheduleRescan() {
    if (rescanTimer) clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      scanAll();
    }, CFG.rescanDebounceMs);
  }

  function startObserver() {
    const thread = document.querySelector('[data-thread]');
    if (!thread) { setTimeout(startObserver, 500); return; }
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.addedNodes.length > 0) { scheduleRescan(); return; }
      }
    });
    obs.observe(thread, { childList: true, subtree: true });
    log('observer attached');
  }

  /* ═══════════════════════════════════════════════════════════════════
     24 · INIT
     ═══════════════════════════════════════════════════════════════════ */

  let _init = false;
  function init() {
    if (_init) return;
    _init = true;
    scanAll();
    startObserver();
    updateDeviceButtons();
    log('initialized');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  /* ═══════════════════════════════════════════════════════════════════
     25 · PUBLIC API
     ═══════════════════════════════════════════════════════════════════ */

  window.NM_preview = {
    open, close, scanAll,
    attach: attachPreviewButton,
    setShareEndpoint:   (url) => { CFG.shareEndpoint = url; },
    setSandboxEndpoint: (url) => { CFG.sandboxEndpoint = url; },
    setLocale:          (loc) => { CFG.locale = loc; },
    setDebug:           (v) => { CFG.debug = !!v; },
    getState: () => ({ ...state }),
    _config: CFG,
    _state: state,
    _version: '3.0.0',
  };

  log('module loaded · v3.0.0');
})();