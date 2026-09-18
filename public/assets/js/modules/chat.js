/* ============================================================
   Chat Numination - Conecta con POST /api/chat
   Incluye adjuntos, dictado por voz y lectura en voz alta.
   ============================================================ */

import { consumeAttachedFile } from './chat-media.js';
import { attachSpeakButton } from './chat-audio.js';

const API_URL = '/api/chat';
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

  if (newBtn) newBtn.addEventListener('click', () => {
    thread.innerHTML = '';
    if (empty) empty.style.display = '';
    field.focus();
    closeSidebar();
  });

  const resize = () => {
    field.style.height = 'auto';
    field.style.height = Math.min(field.scrollHeight, 200) + 'px';
  };

  const updateSend = () => {
    sendBtn.disabled = busy || field.value.trim().length === 0;
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

  document.querySelectorAll('[data-suggestion]').forEach((btn) => {
    btn.addEventListener('click', () => {
      field.value = btn.dataset.suggestion || '';
      resize();
      updateSend();
      field.focus();
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;

    const text = field.value.trim();
    if (!text) return;

    const attached = consumeAttachedFile();

    field.value = '';
    resize();
    updateSend();

    if (empty) empty.style.display = 'none';

    addMessage(thread, 'user', text, attached);
    busy = true;
    updateSend();

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

      if (!res.ok) {
        let errMsg = 'HTTP ' + res.status;
        try {
          const data = await res.json();
          if (data && data.error) errMsg = data.error;
        } catch {}
        addMessage(thread, 'ai', '⚠️ ' + errMsg);
        return;
      }

      const data = await res.json();
      const reply = ((data && data.reply) || '').trim();
      const imageUrl = (data && data.imageUrl) || null;

      if (!reply && !imageUrl) {
        addMessage(thread, 'ai', '(Respuesta vacía del servidor)');
        return;
      }

      addMessage(thread, 'ai', reply || 'Aquí está tu imagen:', null, imageUrl);
    } catch (err) {
      typingEl.remove();
      addMessage(thread, 'ai', '⚠️ No se pudo conectar con el servidor.\n\nDetalle: ' + err.message);
      console.error('[chat]', err);
    } finally {
      busy = false;
      updateSend();
      field.focus();
    }
  });

  updateSend();
}

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