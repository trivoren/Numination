/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · chat-export.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Exportación de la conversación a Markdown — 100% en el navegador.

   Por qué en el navegador y no en el backend:
     · El texto de la conversación ya está en el DOM.
     · Mandarlo al servidor para volver a devolverlo es un viaje
       innecesario con datos sensibles.
     · Funciona sin conexión una vez cargada la página.

   Extracción:
     · Busca los mensajes en `#thread` (estructura de Numination:
       `.message.message--user` / `.message.message--assistant` con el
       texto en `.message__content`).
     * Si no encuentra, usa un selector genérico para no romperse si el
       markup cambia.

   Salida:
     # Conversación · Numination
     > Exportado el <fecha> · <n> mensajes · Persona: <nombre>

     ## 👤 Vos — 21/10/2026 14:03
     ...

     ## 🤖 Numination — 21/10/2026 14:03
     ...

   API:
     window.NumChatExport.buildMarkdown(options)
     window.NumChatExport.download(filename)
     window.NumChatExport.copy()
     window.NumChatExport.mountButton(container)
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const SELECTORS = Object.freeze({
    container: ['#thread', '#chat-messages', '#messages', '.thread', '.chat-messages'],
    message: ['.message', '[data-role]', '.chat-msg', '.msg'],
    content: ['.message__content', '.chat-msg__content', '.msg__content', '.content'],
  });

  const ROLE_LABELS = {
    user: 'Vos',
    assistant: 'Numination',
    system: 'Sistema',
    tool: 'Herramienta',
  };

  const ROLE_ICONS = {
    user: '👤',
    assistant: '🤖',
    system: '⚙️',
    tool: '🔧',
  };

  /* ─── Utilidades ────────────────────────────────────────────────────── */

  function firstMatch(selectors) {
    for (const sel of selectors) {
      const node = document.querySelector(sel);
      if (node) return node;
    }
    return null;
  }

  function toast(message, kind = 'info') {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
      return;
    }
    console.info('[chat-export]', kind, message);
  }

  function detectRole(node) {
    const cls = String(node.className || '');
    if (/message--user/.test(cls)) return 'user';
    if (/message--assistant/.test(cls)) return 'assistant';
    if (/message--system/.test(cls)) return 'system';
    if (/message--tool/.test(cls)) return 'tool';

    const attr = node.getAttribute('data-role');
    if (attr) return attr.toLowerCase();

    if (/user/i.test(cls)) return 'user';
    if (/assistant|bot|ai/i.test(cls)) return 'assistant';
    return 'assistant';
  }

  /**
   * Extrae el texto visible del mensaje.
   * Se usa `innerText` (respeta saltos de línea reales) con un fallback
   * a `textContent` para navegadores sin layout (tests).
   */
  function extractText(node) {
    const contentEl = firstMatchIn(node, SELECTORS.content) || node;
    const text = contentEl.innerText !== undefined ? contentEl.innerText : contentEl.textContent;
    return String(text || '').trim();
  }

  function firstMatchIn(scope, selectors) {
    for (const sel of selectors) {
      const node = scope.querySelector(sel);
      if (node) return node;
    }
    return null;
  }

  /**
   * Limpia el texto para Markdown:
   *   · conserva bloques de código con su lenguaje
   *   · normaliza los saltos de línea sueltos
   */
  function toMarkdownText(raw) {
    const text = String(raw || '').replace(/\r\n?/g, '\n');

    // Preserva los bloques de código tal cual.
    const codeBlocks = [];
    let working = text.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_m, lang, body) => {
      const token = `%%CODEBLOCK_${codeBlocks.length}%%`;
      codeBlocks.push({ lang: lang || '', body });
      return token;
    });

    working = working.replace(/\n{3,}/g, '\n\n').trim();

    working = working.replace(/^###\s/gm, '#### ');

    codeBlocks.forEach((block, index) => {
      const lang = block.lang ? block.lang : '';
      const replacement = '```' + lang + '\n' + block.body.replace(/\n$/, '') + '\n```';
      working = working.replace(`%%CODEBLOCK_${index}%%`, replacement);
    });

    return working;
  }

  function formatStamp(date) {
    try {
      return new Intl.DateTimeFormat('es-CO', {
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(date);
    } catch {
      return date.toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  function fileStamp(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `-${pad(date.getHours())}${pad(date.getMinutes())}`;
  }

  /* ─── Recolección ────────────────────────────────────────────────────── */

  /**
   * Lee los mensajes del DOM.
   * @returns {Array<{role:string, text:string, ts:Date|null}>}
   */
  function collectMessages() {
    const container = firstMatch(SELECTORS.container);
    if (!container) return [];

    const nodes = Array.from(container.querySelectorAll(SELECTORS.message.join(',')));
    const messages = [];

    nodes.forEach((node) => {
      const text = extractText(node);
      if (!text) return;

      const timeAttr = node.getAttribute('data-time') || node.getAttribute('data-ts');
      const ts = timeAttr ? new Date(timeAttr) : null;

      messages.push({
        role: detectRole(node),
        text,
        ts: ts && !Number.isNaN(ts.getTime()) ? ts : null,
      });
    });

    return messages;
  }

  /* ─── Construcción del Markdown ─────────────────────────────────────── */

  /**
   * Genera el Markdown de la conversación.
   * @param {object} [options]
   * @param {string} [options.title]
   * @param {string} [options.persona]  Nombre de la persona activa
   * @param {Array}  [options.messages]  Mensajes (si no, se leen del DOM)
   */
  function buildMarkdown(options = {}) {
    const messages = Array.isArray(options.messages) && options.messages.length
      ? options.messages
      : collectMessages();

    const now = new Date();
    const title = options.title || 'Conversación · Numination';
    const persona = options.persona || null;

    const lines = [];

    lines.push(`# ${title}`);
    lines.push('');
    lines.push(
      `> Exportado el ${formatStamp(now)} · ${messages.length} mensaje${messages.length === 1 ? '' : 's'}` +
      `${persona ? ` · Persona: ${persona}` : ''}`
    );
    lines.push('');
    lines.push('---');
    lines.push('');

    if (!messages.length) {
      lines.push('_No hay mensajes para exportar._');
      return lines.join('\n');
    }

    messages.forEach((msg) => {
      const role = String(msg.role || 'assistant').toLowerCase();
      const label = ROLE_LABELS[role] || role;
      const icon = ROLE_ICONS[role] || '💬';
      const stamp = msg.ts ? ` — ${formatStamp(msg.ts)}` : '';

      lines.push(`## ${icon} ${label}${stamp}`);
      lines.push('');
      lines.push(toMarkdownText(msg.text));
      lines.push('');
    });

    lines.push('---');
    lines.push('');
    lines.push(`_Generado por Numination · ${formatStamp(now)}_`);

    return lines.join('\n');
  }

  /* ─── Descarga y copiado ────────────────────────────────────────────── */

  function download(filename = `numination-${fileStamp(new Date())}.md`, content = null) {
    const markdown = content !== null ? content : buildMarkdown();

    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const href = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(href);
      a.remove();
    }, 1200);

    toast('Conversación exportada.', 'ok');
    return markdown;
  }

  async function copy() {
    const markdown = buildMarkdown();

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(markdown);
        toast('Markdown copiado al portapapeles.', 'ok');
        return true;
      }
    } catch (e) {
      console.warn('[chat-export] clipboard API falló', e);
    }

    // Fallback con textarea oculto (contextos http:// no seguros).
    try {
      const area = document.createElement('textarea');
      area.value = markdown;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      if (ok) {
        toast('Markdown copiado al portapapeles.', 'ok');
        return true;
      }
    } catch (e) {
      console.warn('[chat-export] execCommand falló', e);
    }

    toast('No se pudo copiar. Usá "Exportar" para descargar el archivo.', 'error');
    return false;
  }

  /* ─── Botón ─────────────────────────────────────────────────────────── */

  /**
   * Inserta un botón de exportación en el contenedor indicado.
   * @param {HTMLElement|string} container
   * @param {object} [options]
   */
  function mountButton(container, options = {}) {
    const host = typeof container === 'string' ? document.querySelector(container) : container;
    if (!host) return null;
    if (host.dataset.exportBound === '1') return host.querySelector('.chat-export-btn');
    host.dataset.exportBound = '1';

    const wrap = document.createElement('div');
    wrap.className = 'chat-export';

    const exportBtn = document.createElement('button');
    exportBtn.type = 'button';
    exportBtn.className = 'chat-export-btn';
    exportBtn.title = 'Exportar a Markdown';
    exportBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M7 10l5 5 5-5"></path><path d="M12 15V3"></path></svg>' +
      '<span>Exportar</span>';

    exportBtn.addEventListener('click', () => {
      download(options.filename, buildMarkdown(options));
    });

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'chat-export-btn chat-export-btn--ghost';
    copyBtn.title = 'Copiar Markdown';
    copyBtn.innerHTML =
      '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
      '<span>Copiar</span>';

    copyBtn.addEventListener('click', () => copy());

    wrap.appendChild(exportBtn);
    wrap.appendChild(copyBtn);
    host.appendChild(wrap);

    return exportBtn;
  }

  /* ─── API pública ───────────────────────────────────────────────────── */

  window.NumChatExport = {
    buildMarkdown,
    collectMessages,
    download,
    copy,
    mountButton,
    toMarkdownText,
  };

  // Auto-montaje en el toolbar del chat si existe.
  document.addEventListener('DOMContentLoaded', () => {
    const targets = ['#chat-toolbar', '.topbar__actions', '.composer-area', '#chat-scroll'];
    for (const sel of targets) {
      const node = document.querySelector(sel);
      if (node) {
        mountButton(node);
        break;
      }
    }
  });
})();
