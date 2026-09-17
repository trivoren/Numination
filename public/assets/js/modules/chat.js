/* ============================================================
   Chat Numination — frontend
   Backend espera: { message, role }
   Backend devuelve: { reply } o { reply, imageUrl, type }
   ============================================================ */

const API_URL = '/api/chat';
const MAX = 4000;
const ROLE = 'student'; // 'student' | 'teacher'

export function initChat() {
  const shell = document.querySelector('[data-chat-shell]');
  if (!shell) return;

  const form     = document.querySelector('[data-chat-form]');
  const field    = document.querySelector('[data-chat-field]');
  const sendBtn  = document.querySelector('[data-chat-send]');
  const messages = document.querySelector('[data-chat-messages]');
  const empty    = document.querySelector('[data-chat-empty]');
  const counter  = document.querySelector('[data-chat-counter]');

  if (!form || !field || !messages) return;

  let busy = false;

  const resize = () => {
    field.style.height = 'auto';
    field.style.height = Math.min(field.scrollHeight, 160) + 'px';
  };

  const updateCounter = () => {
    if (!counter) return;
    const len = field.value.length;
    counter.classList.toggle('is-visible', len > 0);
    counter.classList.toggle('is-warning', len > MAX * 0.85);
    counter.textContent = `${len} / ${MAX}`;
  };

  const updateSend = () => {
    if (!sendBtn) return;
    sendBtn.disabled = busy || field.value.trim().length === 0;
  };

  field.addEventListener('input', () => {
    if (field.value.length > MAX) field.value = field.value.slice(0, MAX);
    resize();
    updateSend();
    updateCounter();
  });

  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  shell.querySelectorAll('[data-suggestion]').forEach((btn) => {
    btn.addEventListener('click', () => {
      field.value = btn.dataset.suggestion || '';
      resize();
      updateSend();
      updateCounter();
      field.focus();
    });
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;

    const text = field.value.trim();
    if (!text) return;

    field.value = '';
    resize();
    updateCounter();

    if (empty) empty.style.display = 'none';

    addMessage(messages, 'user', text);
    busy = true;
    updateSend();

    const typingEl = addTyping(messages);

    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, role: ROLE }),
      });

      typingEl.remove();

      if (!res.ok) {
        let errMsg = `HTTP ${res.status}`;
        try {
          const data = await res.json();
          if (data?.error) errMsg = data.error;
        } catch {}
        addMessage(messages, 'ai', `⚠️ ${errMsg}`);
        return;
      }

      const data = await res.json();
      const reply = (data?.reply || '').trim();
      const imageUrl = data?.imageUrl || null;

      if (!reply && !imageUrl) {
        addMessage(messages, 'ai', '(Respuesta vacía del servidor)');
        return;
      }

      addMessage(messages, 'ai', reply || 'Aquí está tu imagen:', imageUrl);
    } catch (err) {
      typingEl.remove();
      addMessage(
        messages,
        'ai',
        `⚠️ No se pudo conectar con el servidor.\n\nDetalle: ${err.message}`
      );
      console.error('[chat]', err);
    } finally {
      busy = false;
      updateSend();
      field.focus();
    }
  });

  updateSend();
  updateCounter();
}

function addMessage(container, role, text, imageUrl = null) {
  const wrap = document.createElement('div');
  wrap.className = `msg msg--${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'msg__bubble';

  if (text) {
    const p = document.createElement('div');
    p.textContent = text;
    bubble.appendChild(p);
  }

  if (imageUrl) {
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = 'Imagen generada por Numination';
    img.loading = 'lazy';
    img.className = 'msg__image';
    img.onload = () => {
      container.scrollTop = container.scrollHeight;
    };
    bubble.appendChild(img);
  }

  wrap.appendChild(bubble);
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
  return wrap;
}

function addTyping(container) {
  const wrap = document.createElement('div');
  wrap.className = 'msg msg--ai';
  wrap.innerHTML = `
    <div class="msg__bubble">
      <span class="msg__typing"><span></span><span></span><span></span></span>
    </div>
  `;
  container.appendChild(wrap);
  container.scrollTop = container.scrollHeight;
  return wrap;
}