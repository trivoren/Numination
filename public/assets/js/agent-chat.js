/**
 * Numination · Modo Coder — agent-chat.js
 * Chat lateral del IDE. Envía la petición + el código actual de Monaco al
 * backend y consume la respuesta en streaming (SSE sobre ReadableStream).
 *
 * Cuando la IA devuelve un bloque de código, se abre el Diff Viewer para que
 * el usuario revise los cambios ANTES de que toquen el editor.
 *
 * Interacción:
 *   Enter            → enviar
 *   Shift+Enter      → salto de línea
 *   Ctrl/Cmd+Enter   → enviar (alternativa)
 */

(function () {
  'use strict';

  const form = document.getElementById('chat-form');
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('btn-send');
  const streamEl = document.getElementById('chat-stream');

  /** Historial breve de la conversación (se envía como contexto). */
  const history = [];
  const MAX_HISTORY = 6;

  /** @type {AbortController|null} controlador del stream en curso */
  let activeStream = null;
  /** @type {HTMLElement|null} nodo que recibe los tokens en streaming */
  let streamingNode = null;
  /** @type {boolean} */
  let busy = false;

  /* ────────────────────────────────────────────────────────────────
     RENDER
     ──────────────────────────────────────────────────────────────── */

  /**
   * Crea un nodo de mensaje en el chat.
   * @param {'user'|'ai'|'note'} kind
   * @param {string} text
   * @returns {HTMLElement}
   */
  function addMessage(kind, text) {
    if (!streamEl) return null;
    const el = document.createElement('div');
    el.className = `chat-msg chat-msg--${kind}`;
    el.textContent = text; // texto plano: nunca HTML del modelo
    streamEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  /**
   * Scroll suave al final del chat (throttle con rAF para no jankear).
   */
  let scrollScheduled = false;
  function scrollToBottom() {
    if (!streamEl || scrollScheduled) return;
    scrollScheduled = true;
    requestAnimationFrame(() => {
      scrollScheduled = false;
      if (!streamEl) return;
      streamEl.scrollTo({ top: streamEl.scrollHeight, behavior: 'smooth' });
    });
  }

  /**
   * Inserta texto en el nodo de streaming (acumulando en un buffer para no
   * repintar el DOM en cada token).
   * @param {string} text
   */
  function appendToken(text) {
    if (!streamingNode || !text) return;
    streamingNode.textContent += text;
    scrollToBottom();
  }

  /**
   * Añade el cursor de "escribiendo".
   * @param {HTMLElement} node
   */
  function setTyping(node) {
    if (!node) return;
    node.classList.add('chat-msg--dirty');
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.setAttribute('aria-hidden', 'true');
    node.appendChild(caret);
  }

  /**
   * Quita el cursor de "escribiendo".
   * @param {HTMLElement} node
   */
  function clearTyping(node) {
    if (!node) return;
    node.classList.remove('chat-msg--dirty');
    node.querySelector('.caret')?.remove();
  }

  /* ────────────────────────────────────────────────────────────────
     ENVÍO
     ──────────────────────────────────────────────────────────────── */

  /**
   * Estado del editor: código + ruta + lenguaje.
   * @returns {{code:string, filePath:string, language:string}}
   */
  function readEditor() {
    const code = window.EditorState?.getValue?.() ?? '';
    const file = window.EditorState?.getActiveFile?.() ?? null;
    return {
      code: typeof code === 'string' ? code : '',
      filePath: file?.path || 'index.js',
      language: file?.language || window.EditorState?.getLanguage?.() || 'javascript'
    };
  }

  /**
   * Envía el mensaje al backend y gestiona el stream.
   * @param {string} prompt
   * @returns {Promise<void>}
   */
  async function sendMessage(prompt) {
    if (busy) { window.NuminToast.info('Espera a que termine la respuesta anterior.'); return; }

    const editor = readEditor();
    busy = true;
    toggleBusy(true);

    addMessage('user', prompt);
    history.push({ role: 'user', content: prompt });
    trimHistory();

    const aiNode = addMessage('ai', '');
    streamingNode = aiNode;
    setTyping(aiNode);

    const controller = new AbortController();
    activeStream = controller;

    let raw = '';
    let codeBlock = null;
    let provider = null;

    try {
      await window.NumAPI.stream('/api/coder/chat', {
        body: {
          prompt,
          code: editor.code,
          filePath: editor.filePath,
          language: editor.language,
          history: history.slice(0, -1)
        },
        signal: controller.signal,
        onEvent: (evt) => {
          if (!evt || typeof evt !== 'object') return;
          switch (evt.type) {
            case 'meta':
              window.eventBus?.emit('chat:meta', evt);
              break;
            case 'token':
              raw += evt.text || '';
              appendToken(evt.text || '');
              window.eventBus?.emit('chat:stream', { text: evt.text || '' });
              break;
            case 'done':
              codeBlock = evt.codeBlock || null;
              provider = evt.provider || null;
              window.eventBus?.emit('chat:done', { provider, tokens: evt.tokens });
              break;
            case 'error':
              window.eventBus?.emit('chat:error', { message: evt.message });
              window.NuminToast?.error(evt.message || 'Error del modelo.');
              break;
            default:
              break;
          }
        },
        onError: (err) => {
          console.error('[agent-chat] stream error:', err);
          window.eventBus?.emit('chat:error', { message: err?.message || 'Error de stream.' });
        }
      });
    } catch (err) {
      console.error('[agent-chat] fallo:', err);
    } finally {
      clearTyping(aiNode);
      busy = false;
      toggleBusy(false);
      activeStream = null;

      // Si el modelo no dijo nada, muestra un mensaje de error legible.
      if (!raw.trim() && aiNode) {
        aiNode.textContent = 'No se recibió respuesta del modelo. Revisa tu cuota o inténtalo de nuevo.';
        aiNode.classList.add('chat-msg--note');
      } else if (raw.trim()) {
        history.push({ role: 'assistant', content: raw.slice(0, 1200) });
        trimHistory();
      }

      // Propuesta de código → Diff Viewer (nunca se aplica sola).
      const parsed = window.DiffViewer?.parseAiResponse?.(raw);
      if (parsed && parsed.code && parsed.code.trim()) {
        const original = editor.code;
        if (original.trim() !== parsed.code.trim()) {
          window.DiffViewer.open({
            original,
            next: parsed.code,
            filePath: editor.filePath,
            language: parsed.language || editor.language
          });
        } else {
          window.NuminToast.info('La IA devolvió el mismo código (sin cambios).');
        }
      }

      window.eventBus?.emit('chat:finished', { provider });
      scrollToBottom();
    }
  }

  /**
   * Recorta el historial al máximo permitido.
   * @returns {void}
   */
  function trimHistory() {
    while (history.length > MAX_HISTORY) history.shift();
  }

  /**
   * Bloquea o desbloquea el compositor.
   * @param {boolean} value
   * @returns {void}
   */
  function toggleBusy(value) {
    if (input) input.disabled = value;
    if (sendBtn) {
      sendBtn.setAttribute('aria-busy', value ? 'true' : 'false');
      sendBtn.disabled = value;
    }
  }

  /* ────────────────────────────────────────────────────────────────
     EVENTOS DE UI
     ──────────────────────────────────────────────────────────────── */

  form?.addEventListener('submit', (event) => {
    event.preventDefault();
    const prompt = (input?.value || '').trim();
    if (!prompt) return;
    if (input) input.value = '';
    sendMessage(prompt);
  });

  input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form?.requestSubmit();
    }
  });

  // Botón "parar" cuando hay un stream activo (Escape).
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeStream) {
      activeStream.abort();
      window.NuminToast.info('Generación cancelada.');
    }
  });

  /* ── Mensaje de bienvenida ── */
  if (streamEl && !streamEl.children.length) {
    addMessage(
      'note',
      'Pide un cambio sobre el archivo abierto. La IA responde con un diff que revisas antes de aplicar.'
    );
  }

  window.AgentChat = {
    send: sendMessage,
    readEditor,
    history,
    isBusy: () => busy,
    abort: () => activeStream?.abort()
  };
  window.agentChat = window.AgentChat;
})();
