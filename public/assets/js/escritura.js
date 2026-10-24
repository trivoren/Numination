/* ═══════════════════════════════════════════════════════════════════════════════
   NUMINATION · ESCRITURA.JS · v3.1 · Ultra Premium Markdown & Code Engine
   ───────────────────────────────────────────────────────────────────────────────
   Motor de renderizado de Markdown para chat con IA. 
   Totalmente adaptado a temas dinámicos (Claro, Oscuro, Medianoche, Gris).
   ═══════════════════════════════════════════════════════════════════════════════ */

window.Escritura = (function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════════════
     SECCIÓN 1: DICCIONARIO MASIVO DE SVGs (Lenguajes y Tecnologías)
     ═══════════════════════════════════════════════════════════════════════════════ */

  const SVGS = {
    js: `<svg viewBox="0 0 24 24" fill="#f7df1e"><path d="M0 0h24v24H0V0zm22.034 18.867c-.204-1.5-1.2-2.246-2.708-2.246-1.323 0-2.22.648-2.22 1.665 0 1.164.738 1.575 1.98 2.115 1.554.648 2.466 1.368 2.466 2.848 0 1.878-1.446 2.844-3.3 2.844-1.92 0-3.15-.912-3.636-2.472l1.734-.99c.36.876.966 1.398 1.86 1.398.786 0 1.32-.33 1.32-.936 0-.594-.414-.882-1.602-1.38-1.482-.606-2.4-1.398-2.4-2.904 0-1.788 1.386-2.634 3.06-2.634 1.602 0 2.85.768 3.288 2.148l-1.842 1.044zm-8.904 2.97c0 1.314.378 2.106 1.572 2.106.906 0 1.362-.504 1.362-1.632V10.44h2.016v9.162c0 2.058-1.206 2.976-3.234 2.976-2.22 0-3.366-1.41-3.366-3.48v-1.26h1.65z"/></svg>`,
    ts: `<svg viewBox="0 0 24 24" fill="#3178c6"><path d="M0 0h24v24H0V0zm22.16 14.093c-.398-1.988-2.062-2.943-4.203-2.943-2.281 0-3.61 1.228-3.61 2.943 0 1.66 1.228 2.433 3.328 2.89 2.126.463 2.83.847 2.83 1.95 0 1.074-.978 1.74-2.565 1.74-1.794 0-2.723-.847-3.03-2.135l-1.962.71c.473 2.06 2.205 3.207 4.863 3.207 2.848 0 4.8-1.45 4.8-3.783 0-1.802-1.12-2.722-3.543-3.31-1.907-.457-2.545-.76-2.545-1.72 0-.857.74-1.455 1.995-1.455 1.288 0 2.033.582 2.288 1.622l1.953-.716zM11.996 11.328v1.907H9.003v8.448H6.833v-8.448H3.84v-1.907h8.156z"/></svg>`,
    py: `<svg viewBox="0 0 24 24" fill="#3776ab"><path d="M14.25.18l.9.2.73.26.59.3.45.32.34.34.25.34.16.33.1.3.04.26.02.2-.01.13V8.5l-.05.63-.13.55-.21.46-.26.38-.3.31-.33.25-.35.19-.35.14-.33.1-.3.07-.26.04-.21.02H8.77l-.69.05-.59.14-.5.22-.41.27-.33.32-.27.35-.2.36-.15.37-.1.35-.07.32-.04.27-.02.21v3.06H3.17l-.21-.03-.28-.07-.32-.12-.35-.18-.36-.26-.36-.36-.35-.46-.32-.59-.27-.68-.21-.79-.14-.88-.05-1.01v-2.3l.05-.6.13-.5.22-.4.3-.34.35-.27.35-.21.36-.15.35-.1.32-.06.27-.03.2-.01h5.9l.62-.04.55-.13.47-.2.38-.25.32-.28.26-.3.21-.33.16-.33.11-.33.07-.3.04-.28.02-.21v-2.3h2.3l.2-.02.28-.06.32-.12.35-.18.36-.26.36-.35.35-.46.32-.59.27-.69.21-.79.14-.88.05-1.02v-1.9l-.04-.53-.12-.47-.2-.42-.27-.35-.34-.28-.4-.21-.43-.16-.44-.11-.4-.06-.35-.02H14.25z"/></svg>`,
    html: `<svg viewBox="0 0 24 24" fill="#e34f26"><path d="M1.5 0h21l-1.91 21.563L11.977 24l-8.564-2.438L1.5 0zm7.031 9.75l-.232-2.718 10.059.003.23-2.622L5.412 4.41l.698 8.01h9.126l-.326 3.426-2.91.804-2.955-.81-.188-2.11H6.248l.33 4.171L12 19.351l5.379-1.443.744-8.157H8.531z"/></svg>`,
    css: `<svg viewBox="0 0 24 24" fill="#1572b6"><path d="M1.5 0h21l-1.91 21.563L11.977 24l-8.565-2.438L1.5 0zm17.09 4.413L5.41 4.41l.213 2.622 10.125.002-.255 2.716h-6.64l.24 2.573h6.182l-.366 3.523-2.91.804-2.956-.81-.188-2.11h-2.61l.29 3.855L12 19.288l5.373-1.53L18.59 4.414z"/></svg>`,
    json: `<svg viewBox="0 0 24 24" fill="#cbcb41"><path d="M12 0C5.373 0 0 5.373 0 12c0 6.627 5.373 12 12 12 6.627 0 12-5.373 12-12C24 5.373 18.627 0 12 0zm-.008 3.902c3.336 0 3.336 1.842 3.336 3.245v.212c0 1.415.008 3.247 1.754 3.247h1.202v2.306h-1.202c-1.746 0-1.754 1.832-1.754 3.247v.212c0 1.403 0 3.245-3.336 3.245h-.19v-2.306h.19c1.194 0 1.194-.66 1.194-2.151v-.212c0-1.627 0-3.013 2.048-3.247v-.212c-2.048-.234-2.048-1.62-2.048-3.247v-.212c0-1.491 0-2.151-1.194-2.151h-.19V3.902h.19zM8.918 3.902h.19v2.306h-.19c-1.194 0-1.194.66-1.194 2.151v.212c0 1.627 0 3.013-2.048 3.247v.212c2.048.234 2.048 1.62 2.048 3.247v.212c0 1.491 0 2.151 1.194 2.151h.19v2.306h-.19c-3.336 0-3.336-1.842-3.336-3.245v-.212c0-1.415-.008-3.247-1.754-3.247H2.626v-2.306h1.202c1.746 0 1.754-1.832 1.754-3.247v-.212c0-1.403 0-3.245 3.336-3.245z"/></svg>`,
    react: `<svg viewBox="0 0 24 24" fill="#61dafb"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 2.25c5.385 0 9.75 4.365 9.75 9.75s-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12 6.615 2.25 12 2.25zm0 3.5c-1.104 0-2.031.727-2.031 1.625s.927 1.625 2.031 1.625 2.031-.727 2.031-1.625S13.104 5.75 12 5.75z"/></svg>`,
    node: `<svg viewBox="0 0 24 24" fill="#339933"><path d="M12 0C5.373 0 0 5.373 0 12c0 6.627 5.373 12 12 12 6.627 0 12-5.373 12-12C24 5.373 18.627 0 12 0zm-2.5 16.5l-3.5-2v-4l3.5-2 3.5 2v4l-3.5 2z"/></svg>`,
    vue: `<svg viewBox="0 0 24 24" fill="#4fc08d"><path d="M24 1h-7.5L12 9.3 7.5 1H0l12 22L24 1z"/></svg>`,
    go: `<svg viewBox="0 0 24 24" fill="#00add8"><path d="M0 0h24v24H0V0zm15.5 10.5c-2.5 0-4.5 2-4.5 4.5s2 4.5 4.5 4.5 4.5-2 4.5-4.5-2-4.5-4.5-4.5zm0 7.5c-1.7 0-3-1.3-3-3s1.3-3 3-3 3 1.3 3 3-1.3 3-3 3zM5 11h2v5H5v-5zm0 6h2v2H5v-2z"/></svg>`,
    rust: `<svg viewBox="0 0 24 24" fill="#dea584"><path d="M12 0C5.373 0 0 5.373 0 12c0 6.627 5.373 12 12 12 6.627 0 12-5.373 12-12C24 5.373 18.627 0 12 0zm0 2.25c5.385 0 9.75 4.365 9.75 9.75s-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12 6.615 2.25 12 2.25z"/></svg>`,
    java: `<svg viewBox="0 0 24 24" fill="#007396"><path d="M8 12.5c-1.5-.5-3-1-3-2.5 0-2 3-2.5 5-2.5v1c-1.5 0-3 .5-3 1.5 0 .8 1 1.2 2.5 1.5v1zM12 17c-3.5 0-6-1.5-6-3.5 0-1.5 1.5-2.5 3.5-3v1c-1.5.5-2.5 1-2.5 2 0 1.5 2 2.5 5 2.5v1z"/></svg>`,
    cpp: `<svg viewBox="0 0 24 24" fill="#00599c"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm-2 14h-2v2H6v-2H4v-2h2V9h2v3h2v2zm8 0h-2v2h-2v-2h-2v-2h2V9h2v3h2v2z"/></svg>`,
    cs: `<svg viewBox="0 0 24 24" fill="#239120"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm-2 14H8v2H6v-2H4v-2h2V9h2v3h2v2zm8 0h-2v2h-2v-2h-2v-2h2V9h2v3h2v2z"/></svg>`,
    php: `<svg viewBox="0 0 24 24" fill="#777bb4"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm-2 14H8v2H6v-2H4v-2h2V9h2v3h2v2zm8 0h-2v2h-2v-2h-2v-2h2V9h2v3h2v2z"/></svg>`,
    ruby: `<svg viewBox="0 0 24 24" fill="#cc342d"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0 18l-6-6 6-6 6 6-6 6z"/></svg>`,
    swift: `<svg viewBox="0 0 24 24" fill="#fa7343"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm5.5 16.5l-3-3-3 3-3-3 3-3-3-3 3-3 3 3 3-3 3 3-3 3 3 3-3 3z"/></svg>`,
    kotlin: `<svg viewBox="0 0 24 24" fill="#7f52ff"><path d="M0 0h24v24H0V0zm3.5 3.5h17v17l-17-17z"/></svg>`,
    sql: `<svg viewBox="0 0 24 24" fill="#4479a1"><path d="M12 2C6.48 2 2 4.24 2 7v10c0 2.76 4.48 5 10 5s10-2.24 10-5V7c0-2.76-4.48-5-10-5zm0 2c4.42 0 8 1.79 8 4s-3.58 4-8 4-8-1.79-8-4 3.58-4 8-4zm0 14c-4.42 0-8-1.79-8-4v-2c1.74 1.64 4.63 2.5 8 2.5s6.26-.86 8-2.5v2c0 2.21-3.58 4-8 4z"/></svg>`,
    bash: `<svg viewBox="0 0 24 24" fill="#4d4d4d"><path d="M0 0h24v24H0V0zm2 3v18h20V3H2zm2 2h16v14H4V5zm2 4l3 3-3 3v-2l1-1-1-1v-2zm4 5h4v1h-4v-1z"/></svg>`,
    docker: `<svg viewBox="0 0 24 24" fill="#2496ed"><path d="M13.5 4.5h-3v3h3v-3zm-4.5 0H6v3h3v-3zm0 4.5H6v3h3v-3zm4.5 0h-3v3h3v-3zm4.5 0h-3v3h3v-3zm4.5 0h-3v3h3v-3zm-13.5 4.5H6v3h3v-3zm4.5 0h-3v3h3v-3zm4.5 0h-3v3h3v-3zm4.5 0h-3v3h3v-3zM24 9c-1-2-3-3-5-3v-1c0-1-1-1.5-2-1.5h-1v2c0 .5.5.5.5 1v1h-2v4.5h10C23.5 11 24 10 24 9z"/></svg>`,
    markdown: `<svg viewBox="0 0 24 24" fill="#083fa1"><path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm-2 16H8v-6H6V8h2v2h2v6zm6 0h-2v-6l-2 2v-4l2 2V8h2v8z"/></svg>`,
    default: `<svg viewBox="0 0 24 24" fill="#8e8e98"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`
  };

  /* ═══════════════════════════════════════════════════════════════════════════════
     SECCIÓN 2: DICCIONARIO DE SINTAXIS (Keywords por lenguaje)
     ═══════════════════════════════════════════════════════════════════════════════ */

  const SYNTAX_KEYWORDS = {
    js: /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|try|catch|new|this|typeof|instanceof|in|of|switch|case|break|default|throw|delete|void)\b/g,
    ts: /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|async|await|interface|type|enum|implements|extends|public|private|protected|readonly|as|any|string|number|boolean|void|never|unknown)\b/g,
    py: /\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|with|lambda|and|or|not|in|is|None|True|False|yield|async|await)\b/g,
    html: /\b(html|head|body|div|span|a|img|ul|li|table|tr|td|th|h1|h2|h3|h4|h5|h6|p|script|style|link|meta|form|input|button|section|article|nav|header|footer|main|aside|video|audio|canvas|svg)\b/g,
    css: /\b(color|background|margin|padding|border|display|flex|grid|position|width|height|font|text|align|justify|transition|transform|animation|opacity|z-index|overflow|none|block|inline|absolute|relative|fixed|sticky|center|left|right|top|bottom)\b/g,
    go: /\b(func|var|const|type|struct|interface|map|chan|go|defer|select|package|import|return|if|else|for|range|switch|case|default|break|continue|fallthrough|goto)\b/g,
    rust: /\b(fn|let|mut|const|struct|enum|trait|impl|match|if|else|for|while|loop|return|use|mod|pub|as|where|self|Self|true|false)\b/g,
    java: /\b(public|private|protected|class|interface|extends|implements|void|int|String|boolean|double|float|char|long|if|else|for|while|do|switch|case|break|return|new|this|super|static|final|try|catch|finally|throw|throws|import|package)\b/g,
    cpp: /\b(int|float|double|char|bool|void|class|struct|public|private|protected|virtual|override|const|static|if|else|for|while|do|switch|case|break|return|new|delete|this|try|catch|throw|namespace|using|template|typename|auto)\b/g,
    php: /\b(function|class|public|private|protected|if|else|elseif|for|foreach|while|do|switch|case|break|return|new|echo|print|include|require|try|catch|finally|throw|namespace|use|extends|implements)\b/g,
    default: /\b(true|false|null|undefined|NaN|Infinity)\b/g
  };

  /* ═══════════════════════════════════════════════════════════════════════════════
     SECCIÓN 3: FUNCIONES UTILITARIAS (Escape y Sanitización)
     ═══════════════════════════════════════════════════════════════════════════════ */

  function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeURL(url) {
    if (!url) return '#';
    const trimmed = url.trim();
    if (/^(javascript|data|vbscript):/i.test(trimmed)) return '#';
    return trimmed;
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     SECCIÓN 4: MOTOR DE RESALTADO DE SINTAXIS
     ═══════════════════════════════════════════════════════════════════════════════ */

  function highlight(code, lang) {
    let html = escapeHTML(code);
    
    // Strings
    html = html.replace(/(["'`])(?:(?=(\\?))\2.)*?\1/g, '<span class="nm-token-string">$&</span>');

    // Comentarios
    if (lang === 'py' || lang === 'bash' || lang === 'rb') {
      html = html.replace(/(#.*)/g, '<span class="nm-token-comment">$&</span>');
    } else {
      html = html.replace(/(\/\/.*|\/\*[\s\S]*?\*\/)/g, '<span class="nm-token-comment">$&</span>');
    }

    // Números
    html = html.replace(/\b(\d+(\.\d+)?)\b/g, '<span class="nm-token-number">$1</span>');

    // Keywords
    const kwRegex = SYNTAX_KEYWORDS[lang] || SYNTAX_KEYWORDS['default'];
    html = html.replace(kwRegex, function(match) {
      return `<span class="nm-token-keyword">${match}</span>`;
    });

    // Funciones
    html = html.replace(/\b([a-zA-Z_]\w*)\s*\(/g, '<span class="nm-token-function">$1</span>(');

    return html;
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     SECCIÓN 5: PARSER DE BLOQUES DE MARKDOWN
     ═══════════════════════════════════════════════════════════════════════════════ */

  function parseBlocks(md) {
    const lines = md.split('\n');
    const blocks = [];
    let inCode = false;
    let codeLang = '';
    let codeFile = '';
    let codeContent = [];
    let inTable = false;
    let tableLines = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Bloques de Código
      if (line.trim().startsWith('```')) {
        if (!inCode) {
          inCode = true;
          const match = line.trim().match(/^```(\w+)?(?:\s+([\w\-.]+))?/);
          codeLang = match && match[1] ? match[1].toLowerCase() : 'text';
          codeFile = match && match[2] ? match[2] : '';
          codeContent = [];
        } else {
          inCode = false;
          blocks.push({ type: 'code', lang: codeLang, file: codeFile, content: codeContent.join('\n') });
        }
        continue;
      }

      if (inCode) {
        codeContent.push(line);
        continue;
      }

      // Tablas
      if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
        if (!inTable) {
          inTable = true;
          tableLines = [];
        }
        tableLines.push(line);
        continue;
      } else if (inTable) {
        inTable = false;
        blocks.push({ type: 'table', lines: tableLines });
        tableLines = [];
      }

      // Callouts
      const calloutMatch = line.match(/^&gt;\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i);
      if (calloutMatch) {
        const type = calloutMatch[1].toUpperCase();
        const content = [];
        while (i + 1 < lines.length && lines[i + 1].trim().startsWith('&gt;')) {
          i++;
          content.push(lines[i].replace(/^&gt;\s?/, ''));
        }
        blocks.push({ type: 'callout', kind: type, content: content.join('\n') });
        continue;
      }

      // Headers
      const headerMatch = line.match(/^(#{1,6})\s+(.*)/);
      if (headerMatch) {
        blocks.push({ type: 'header', level: headerMatch[1].length, text: headerMatch[2] });
        continue;
      }

      // Listas
      if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        blocks.push({ type: 'list-item', text: line });
        continue;
      }

      // Párrafos
      if (line.trim().length > 0) {
        blocks.push({ type: 'paragraph', text: line });
      } else {
        blocks.push({ type: 'blank' });
      }
    }

    if (inCode) {
      blocks.push({ type: 'code', lang: codeLang, file: codeFile, content: codeContent.join('\n') });
    }
    if (inTable) {
      blocks.push({ type: 'table', lines: tableLines });
    }

    return blocks;
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     SECCIÓN 6: PARSER DE TEXTO INLINE
     ═══════════════════════════════════════════════════════════════════════════════ */

  function parseInline(text) {
    let html = text;

    // Código Inline (`code`)
    html = html.replace(/`([^`\n]+)`/g, '<code class="nm-inline-code">$1</code>');

    // Imágenes
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
      return `<img src="${sanitizeURL(url)}" alt="${escapeHTML(alt)}" class="nm-image" loading="lazy" />`;
    });

    // Enlaces
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
      return `<a href="${sanitizeURL(url)}" target="_blank" rel="noopener noreferrer" class="nm-link">${text} <svg viewBox="0 0 24 24" class="nm-link-icon"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`;
    });

    // Negritas y Cursivas
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

    return html;
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     SECCIÓN 7: RENDERIZADORES DE BLOQUES
     ═══════════════════════════════════════════════════════════════════════════════ */

  function renderCodeBlock(block) {
    const lang = block.lang || 'text';
    const svgIcon = SVGS[lang] || SVGS['default'];
    const displayLang = lang.toUpperCase();
    const displayFile = block.file ? `<span class="nm-code-filename">${escapeHTML(block.file)}</span>` : '';
    const encodedCode = encodeURIComponent(block.content);

    // Resaltado de sintaxis
    const highlightedCode = highlight(block.content, lang);
    
    // Generar líneas con números
    const lines = highlightedCode.split('\n');
    const codeWithLines = lines.map((line, i) => 
      `<tr><td class="nm-code-line-num">${i + 1}</td><td class="nm-code-line">${line || ' '}</td></tr>`
    ).join('');

    return `
      <div class="nm-code-block">
        <div class="nm-code-header">
          <div class="nm-code-lang">
            <span class="nm-code-icon">${svgIcon}</span>
            <span>${displayLang}</span>
            ${displayFile}
          </div>
          <div class="nm-code-actions">
            <button type="button" class="nm-code-btn" onclick="Escritura.copyCode(this, '${encodedCode}')" title="Copiar código">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>Copiar</span>
            </button>
            <button type="button" class="nm-code-btn" onclick="Escritura.downloadCode(this, '${encodedCode}', '${lang}')" title="Descargar archivo">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
          </div>
        </div>
        <div class="nm-code-body">
          <table><tbody>${codeWithLines}</tbody></table>
        </div>
      </div>
    `;
  }

  function renderTable(block) {
    const lines = block.lines;
    if (lines.length < 2) return '';

    let html = '<div class="nm-table-wrapper"><table class="nm-table">';
    let isHeader = true;

    lines.forEach(line => {
      const trimmed = line.trim();
      if (/^\|[\s\-\|:]+\|$/.test(trimmed)) {
        isHeader = false;
        return;
      }
      
      const cells = trimmed.split('|').filter((c, i, arr) => i !== 0 && i !== arr.length - 1);
      const tag = isHeader ? 'th' : 'td';
      
      html += '<tr>';
      cells.forEach(cell => {
        html += `<${tag}>${parseInline(cell.trim())}</${tag}>`;
      });
      html += '</tr>';
    });

    html += '</table></div>';
    return html;
  }

  function renderCallout(block) {
    let icon = 'ℹ️', color = '#3b82f6', bg = 'rgba(59, 130, 246, 0.1)';
    if (block.kind === 'TIP') { icon = '💡'; color = '#10b981'; bg = 'rgba(16, 185, 129, 0.1)'; }
    if (block.kind === 'WARNING') { icon = '⚠️'; color = '#f59e0b'; bg = 'rgba(245, 158, 11, 0.1)'; }
    if (block.kind === 'CAUTION') { icon = '🚨'; color = '#ef4444'; bg = 'rgba(239, 68, 68, 0.1)'; }
    if (block.kind === 'IMPORTANT') { icon = '🔥'; color = '#8b5cf6'; bg = 'rgba(139, 92, 246, 0.1)'; }

    return `
      <div class="nm-callout" style="border-left-color: ${color}; background: ${bg};">
        <div class="nm-callout-icon">${icon}</div>
        <div class="nm-callout-content">${parseInline(block.content).replace(/\n/g, '<br>')}</div>
      </div>
    `;
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     SECCIÓN 8: FUNCIÓN PRINCIPAL DE RENDERIZADO
     ═══════════════════════════════════════════════════════════════════════════════ */

  function render(markdownText) {
    if (!markdownText) return '';

    const blocks = parseBlocks(markdownText);
    let html = '';
    let inList = false;

    blocks.forEach((block) => {
      if (block.type === 'list-item') {
        if (!inList) {
          html += '<ul class="nm-ul">';
          inList = true;
        }
        let content = block.text.replace(/^\s*([-*]|\d+\.)\s+/, '');
        
        if (/^\[x\]\s+/i.test(content)) {
          html += `<li class="nm-li nm-task"><input type="checkbox" checked disabled> ${parseInline(content.replace(/^\[x\]\s+/i, ''))}</li>`;
        } else if (/^\[\s*\]\s+/.test(content)) {
          html += `<li class="nm-li nm-task"><input type="checkbox" disabled> ${parseInline(content.replace(/^\[\s*\]\s+/, ''))}</li>`;
        } else {
          html += `<li class="nm-li">${parseInline(content)}</li>`;
        }
        return;
      } else if (inList) {
        html += '</ul>';
        inList = false;
      }

      switch (block.type) {
        case 'code':
          html += renderCodeBlock(block);
          break;
        case 'table':
          html += renderTable(block);
          break;
        case 'callout':
          html += renderCallout(block);
          break;
        case 'header':
          html += `<h${block.level} class="nm-h${block.level}">${parseInline(block.text)}</h${block.level}>`;
          break;
        case 'paragraph':
          html += `<p class="nm-p">${parseInline(block.text)}</p>`;
          break;
        case 'blank':
          html += '<div style="height: 12px;"></div>';
          break;
      }
    });

    if (inList) html += '</ul>';

    return html;
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     SECCIÓN 9: ACCIONES DE LOS BOTONES
     ═══════════════════════════════════════════════════════════════════════════════ */

  function copyCode(btn, encodedCode) {
    const code = decodeURIComponent(encodedCode);
    navigator.clipboard.writeText(code).then(() => {
      const span = btn.querySelector('span');
      if (!span) return;
      const original = span.textContent;
      span.textContent = '¡Copiado!';
      btn.classList.add('is-copied');
      setTimeout(() => {
        span.textContent = original;
        btn.classList.remove('is-copied');
      }, 2000);
    }).catch(() => {
      console.error('Error al copiar');
    });
  }

  function downloadCode(btn, encodedCode, ext) {
    const code = decodeURIComponent(encodedCode);
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `code.${ext === 'text' ? 'txt' : ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ═══════════════════════════════════════════════════════════════════════════════
     SECCIÓN 10: INYECCIÓN DE ESTILOS CSS ADAPTATIVOS
     ═══════════════════════════════════════════════════════════════════════════════ */

  function injectStyles() {
    if (document.getElementById('nm-escritura-styles')) return;

    const style = document.createElement('style');
    style.id = 'nm-escritura-styles';
    style.textContent = `
      /* ==========================================
         BASE TIPOGRÁFICA (Adaptable al Tema)
         ========================================== */
      .nm-p {
        margin-bottom: 16px;
        line-height: 1.75;
        font-size: 15px;
        color: var(--text, inherit);
        word-break: break-word;
      }
      .nm-h1, .nm-h2, .nm-h3, .nm-h4, .nm-h5, .nm-h6 {
        color: var(--text, inherit);
        font-weight: 700;
        margin: 28px 0 16px;
        line-height: 1.3;
        letter-spacing: -0.02em;
      }
      .nm-h1 { font-size: 26px; border-bottom: 1px solid var(--border, #26262c); padding-bottom: 8px; }
      .nm-h2 { font-size: 22px; }
      .nm-h3 { font-size: 19px; }
      .nm-h4 { font-size: 17px; }
      .nm-h5 { font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em; }
      .nm-h6 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-sub, #8e8e98); }
      
      /* ==========================================
         ENLACES E IMÁGENES
         ========================================== */
      .nm-link {
        color: var(--accent, #3b82f6);
        text-decoration: underline;
        text-underline-offset: 3px;
        font-weight: 500;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        transition: opacity 0.2s;
      }
      .nm-link:hover { opacity: 0.8; }
      .nm-link-icon {
        width: 12px;
        height: 12px;
        stroke: currentColor;
        fill: none;
        stroke-width: 2;
      }
      .nm-image {
        max-width: 100%;
        border-radius: 12px;
        border: 1px solid var(--border, #26262c);
        margin: 16px 0;
        display: block;
      }

      /* ==========================================
         BLOQUES DE CÓDIGO (Siempre Oscuro)
         ========================================== */
      .nm-code-block {
        margin: 20px 0;
        border-radius: 12px;
        overflow: hidden;
        border: 1px solid var(--border, #26262c);
        background: #0d0d0f;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
      }
      .nm-code-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 16px;
        background: #161619;
        border-bottom: 1px solid var(--border, #26262c);
      }
      .nm-code-lang {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 12px;
        font-weight: 700;
        color: #e4e4e7;
        font-family: 'JetBrains Mono', monospace;
      }
      .nm-code-icon {
        width: 18px;
        height: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .nm-code-icon svg {
        width: 100%;
        height: 100%;
      }
      .nm-code-filename {
        color: #a1a1aa;
        font-size: 11px;
        font-weight: 500;
        margin-left: 4px;
      }
      .nm-code-actions {
        display: flex;
        gap: 4px;
      }
      .nm-code-btn {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        font-weight: 600;
        color: #a1a1aa;
        transition: 0.2s;
        padding: 6px 10px;
        border-radius: 6px;
        cursor: pointer;
        background: transparent;
        border: none;
      }
      .nm-code-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #fff;
      }
      .nm-code-btn.is-copied {
        color: #10b981;
      }
      .nm-code-btn svg {
        width: 14px;
        height: 14px;
      }
      .nm-code-body {
        padding: 16px;
        overflow-x: auto;
        background: #0d0d0f;
      }
      .nm-code-body table {
        border-collapse: collapse;
        width: 100%;
      }
      .nm-code-line-num {
        user-select: none;
        text-align: right;
        padding-right: 16px;
        color: #4b4b52;
        font-size: 12px;
        font-family: 'JetBrains Mono', monospace;
        width: 1%;
        white-space: nowrap;
        vertical-align: top;
      }
      .nm-code-line {
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
        color: #e4e4e7;
        line-height: 1.6;
        white-space: pre;
        vertical-align: top;
      }

      /* ==========================================
         SYNTAX HIGHLIGHTING (TOKENS)
         ========================================== */
      .nm-token-keyword { color: #c678dd; font-weight: 600; }
      .nm-token-string { color: #98c379; }
      .nm-token-comment { color: #5c6370; font-style: italic; }
      .nm-token-number { color: #d19a66; }
      .nm-token-function { color: #61afef; }

      /* ==========================================
         TABLAS (Adaptables al Tema)
         ========================================== */
      .nm-table-wrapper {
        overflow-x: auto;
        margin: 20px 0;
        border-radius: 10px;
        border: 1px solid var(--border, #26262c);
      }
      .nm-table {
        width: 100%;
        border-collapse: collapse;
        text-align: left;
        font-size: 14px;
      }
      .nm-table th {
        background: var(--bg-soft, #1c1c1f);
        padding: 12px 16px;
        font-weight: 700;
        color: var(--text, #f0f0f5);
        border-bottom: 2px solid var(--border, #26262c);
        white-space: nowrap;
      }
      .nm-table td {
        padding: 12px 16px;
        border-bottom: 1px solid var(--border, #1a1a1e);
        color: var(--text, #a1a1aa);
      }
      .nm-table tr:last-child td {
        border-bottom: none;
      }
      .nm-table tr:hover td {
        background: var(--bg-hover, rgba(255, 255, 255, 0.02));
      }

      /* ==========================================
         CALLOUTS (ALERTAS)
         ========================================== */
      .nm-callout {
        display: flex;
        gap: 14px;
        padding: 16px;
        border-left: 4px solid #3b82f6;
        border-radius: 8px;
        margin: 20px 0;
      }
      .nm-callout-icon {
        font-size: 20px;
        line-height: 1.2;
      }
      .nm-callout-content {
        font-size: 14px;
        color: var(--text, #e4e4e7);
        line-height: 1.6;
        flex: 1;
      }

      /* ==========================================
         CÓDIGO INLINE Y LISTAS
         ========================================== */
      .nm-inline-code {
        font-family: 'JetBrains Mono', monospace;
        font-size: 13px;
        background: var(--bg-hover, rgba(255, 255, 255, 0.1));
        padding: 2px 6px;
        border-radius: 4px;
        color: var(--text, #f0f0f5);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.05));
      }
      .nm-ul, .nm-ol {
        padding-left: 20px;
        margin: 12px 0;
      }
      .nm-li {
        margin-bottom: 8px;
        font-size: 15px;
        color: var(--text, #d4d4d8);
        line-height: 1.6;
      }
      .nm-task {
        list-style: none;
        margin-left: -20px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .nm-task input[type="checkbox"] {
        width: 16px;
        height: 16px;
        accent-color: var(--accent, #8b5cf6);
        cursor: not-allowed;
      }

      /* ==========================================
         SCROLLBAR PERSONALIZADO
         ========================================== */
      .nm-code-body::-webkit-scrollbar,
      .nm-table-wrapper::-webkit-scrollbar {
        height: 8px;
      }
      .nm-code-body::-webkit-scrollbar-track,
      .nm-table-wrapper::-webkit-scrollbar-track {
        background: transparent;
      }
      .nm-code-body::-webkit-scrollbar-thumb,
      .nm-table-wrapper::-webkit-scrollbar-thumb {
        background: #3a3a42;
        border-radius: 4px;
      }
      .nm-code-body::-webkit-scrollbar-thumb:hover,
      .nm-table-wrapper::-webkit-scrollbar-thumb:hover {
        background: #4b4b52;
      }
    `;
    document.head.appendChild(style);
  }

  // Inicializar estilos
  injectStyles();

  /* ═══════════════════════════════════════════════════════════════════════════════
     SECCIÓN 11: EXPORTACIÓN DE LA API PÚBLICA
     ═══════════════════════════════════════════════════════════════════════════════ */

  return {
    render: render,
    copyCode: copyCode,
    downloadCode: downloadCode
  };

})();