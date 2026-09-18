/* ============================================================
   Chat Numination
   - Streaming SSE con efecto máquina de escribir
   - Adjuntar archivos (imágenes, PDF)
   - Lectura en voz alta de respuestas IA
   ============================================================ */

import { consumeAttachedFile } from './chat-media.js';
import { attachSpeakButton } from './chat-audio.js';

const API_URL = '/api/chat/stream';
const MAX = 4000;
const ROLE = 'student';

export function initChat() {
  const app = document.querySelector('.chat-app');
  if (!app) return;

  const form     = document.querySelector('[data-chat-form]');
  const field    = document.querySelector('[data-chat-field]');
  const sendBtn  = document.querySelector('[data-chat-send]');
  const scroll   = document.querySelector('[data-chat-messages]');
  const empty    = document.querySelector('[data-chat-empty]');
  const thread   = document.querySelector('[data-chat-thread]');
  const newBtn   = document.querySelector('[data-chat-new]');

  const sidebarEl      = document.querySelector('[data-chat-sidebar]');
  const sidebarOverlay = document.querySelector('[data-chat-sidebar-overlay]');
  const sidebarOpen    = document.querySelector('[data-chat-sidebar-open]');
  const sidebarClose   = document.querySelector('[data-chat-sidebar-close]');

  if (!form || !field || !sendBtn || !scroll || !thread) {
    console.warn('[chat] faltan elementos en el DOM');
    return;
  }

  let busy = false;

  /* ─── Sidebar móvil ─── */
  if (sidebarOpen) sidebarOpen.addEventListener('click', () => {
    if (sidebarEl) sidebarEl.classList.add('is-open');
    if (sidebarOverlay) sidebarOverlay.classList.add('is-open');
  });

  const closeSidebar = () => {
    if (sidebarEl) sidebarEl.classList.remove('is-open');
    if (sidebarOverlay) sidebarOverlay.classList.remove('is-open');
  };
  if (sidebarClose) sidebarClose.addEventListener('click', closeSidebar);
  if (sidebarOverlay) sidebarOverlay.addEventListener('click', closeSidebar);

  /* ─── Nuevo chat ─── */
  if (newBtn) newBtn.addEventListener('click', () => {
    thread.innerHTML = '';
    if (empty) empty.style.display = '';
    field.focus();
    closeSidebar();
  });

  /* ─── Auto-resize ─── */
  const resize = () => {
    field.style.height = 'auto';
    field.style.height = Math.min(field.scrollHeight, 200) + 'px';
  };

  /* ─── Estado del botón: solo depende del texto ─── */
  const updateSend = () => {
    sendBtn.disabled = false;
  };

  field.addEventListener('input', () => {
    if (field.value.length > MAX) field.value = field.value.slice(0, MAX);
    resize();
    updateSend();
  });

  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  /* ─── Chips y tarjetas de sugerencia ─── */
  document.querySelectorAll('[data-suggestion]').forEach((btn) => {
    btn.addEventListener('click', () => {
      field.value = btn.dataset.suggestion || '';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      resize();
      updateSend();
      field.focus();
    });
  });

  /* ─── Enviar mensaje ─── */
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;

    const text = field.value.trim();
    if (!text) { field.focus(); return; }

    const attached = consumeAttachedFile();

    field.value = '';
    resize();
    updateSend();

    if (empty) empty.style.display = 'none';

    addMessage(thread, 'user', text, attached);
    busy = true;

    const typingEl = addTyping(thread);
    scroll.scrollTop = scroll.scrollHeight;

    try {
      const body = { message: text, role: ROLE };
      if (attached) {
        body.file = {
          data: attached.data,
          mimeType: attached.mimeType,
          name: attached.name,
        };
      }

      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      typingEl.remove();

      if (!res.ok || !res.body) {
        let errMsg = 'HTTP ' + res.status;
        try {
          const data = await res.json();
          if (data && data.error) errMsg = data.error;
        } catch {}
        addMessage(thread, 'ai', '⚠️ ' + errMsg);
        return;
      }

      /* ─── Streaming SSE ─── */
      const live = createLiveBubble(thread);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let finished = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          const jsonStr = part.slice(6);
          try {
            const evt = JSON.parse(jsonStr);
            if (evt.error) {
              appendToBubble(live, '\n\n⚠️ ' + evt.error);
            } else if (evt.token) {
              appendToBubble(live, evt.token);
              fullText += evt.token;
            }
            if (evt.done && !finished) {
              finished = true;
              finalizeBubble(live, fullText);
            }
          } catch {}
        }
        scroll.scrollTop = scroll.scrollHeight;
      }

      if (!finished) finalizeBubble(live, fullText);
    } catch (err) {
      typingEl.remove();
      addMessage(thread, 'ai', '⚠️ No se pudo conectar con el servidor.\n\nDetalle: ' + err.message);
      console.error('[chat]', err);
    } finally {
      busy = false;
      setTimeout(() => {
        updateSend();
        field.focus();
        const preview = document.getElementById('attach-preview');
        const name = document.getElementById('attach-preview-name');
        if (preview && (!name || !name.textContent)) {
          preview.hidden = true;
          preview.style.display = 'none';
        }
      }, 50);
    }
  });

  updateSend();
}

/* ══════════ Mensajes estándar ══════════ */

function addMessage(container, role, text, attachment = null, imageUrl = null) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg--' + role;

  const avatar = document.createElement('div');
  avatar.className = 'msg__avatar';
  avatar.textContent = role === 'user' ? 'T' : 'N';

  const content = document.createElement('div');
  content.className = 'msg__content';

  const author = document.createElement('div');
  author.className = 'msg__author';
  author.textContent = role === 'user' ? 'Tú' : 'Numination';

  const bubble = document.createElement('div');
  bubble.className = 'msg__bubble';

  if (text) {
    const p = document.createElement('div');
    p.textContent = text;
    bubble.appendChild(p);
  }

  if (attachment) {
    if (attachment.mimeType && attachment.mimeType.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = 'data:' + attachment.mimeType + ';base64,' + attachment.data;
      img.alt = attachment.name || 'imagen';
      img.className = 'msg__image';
      bubble.appendChild(img);
    } else {
      const att = document.createElement('div');
      att.className = 'msg-attachment';
      const s1 = document.createElement('span');
      s1.textContent = '📎';
      const s2 = document.createElement('span');
      s2.textContent = attachment.name || 'archivo';
      att.appendChild(s1);
      att.appendChild(s2);
      bubble.appendChild(att);
    }
  }

  if (imageUrl) {
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = 'Imagen generada';
    img.loading = 'lazy';
    img.className = 'msg__image';
    bubble.appendChild(img);
  }

  if (role === 'ai' && text) {
    attachSpeakButton(bubble, text);
  }

  content.appendChild(author);
  content.appendChild(bubble);
  wrap.appendChild(avatar);
  wrap.appendChild(content);
  container.appendChild(wrap);

  const scroller = container.closest('[data-chat-messages]');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function addTyping(container) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg--ai';
  wrap.innerHTML = '<div class="msg__avatar">N</div><div class="msg__content"><div class="msg__author">Numination</div><div class="msg__bubble"><span class="msg__typing"><span></span><span></span><span></span></span></div></div>';
  container.appendChild(wrap);
  return wrap;
}

/* ══════════ Burbuja en vivo (streaming) ══════════ */

function createLiveBubble(container) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg--ai';

  const avatar = document.createElement('div');
  avatar.className = 'msg__avatar';
  avatar.textContent = 'N';

  const content = document.createElement('div');
  content.className = 'msg__content';

  const author = document.createElement('div');
  author.className = 'msg__author';
  author.textContent = 'Numination';

  const bubble = document.createElement('div');
  bubble.className = 'msg__bubble msg__bubble--streaming';

  const span = document.createElement('span');
  span.className = 'msg__stream-text';
  bubble.appendChild(span);

  const cursor = document.createElement('span');
  cursor.className = 'msg__cursor';
  bubble.appendChild(cursor);

  content.appendChild(author);
  content.appendChild(bubble);
  wrap.appendChild(avatar);
  wrap.appendChild(content);
  container.appendChild(wrap);

  return { bubble, span, cursor, fullText: '' };
}

function appendToBubble(live, token) {
  live.span.textContent += token;
  live.fullText += token;
  const scroller = live.bubble.closest('[data-chat-messages]');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

function finalizeBubble(live, finalText) {
  if (live.cursor) live.cursor.remove();
  live.bubble.classList.remove('msg__bubble--streaming');
  const text = finalText || live.fullText;
  if (text) attachSpeakButton(live.bubble, text);
}