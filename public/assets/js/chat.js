/* ============================================================
   NUMINATION — chat.js
   Chat completo: streaming, adjuntos, dictado por voz, lectura.
   Todo en un solo archivo.
   ============================================================ */

const API_URL = '/api/chat/stream';
const MAX = 4000;
const ROLE = 'student';
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

document.addEventListener('DOMContentLoaded', () => {
  const app = document.querySelector('.chat-app');
  if (!app) return;
  initChat();
});

/* ══════════ INIT PRINCIPAL ══════════ */

function initChat() {
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
  let attachedFile = null;

  /* ══════════ SIDEBAR MÓVIL ══════════ */

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

  /* ══════════ NUEVO CHAT ══════════ */

  if (newBtn) newBtn.addEventListener('click', () => {
    thread.innerHTML = '';
    if (empty) empty.style.display = '';
    field.focus();
    closeSidebar();
  });

  /* ══════════ AUTO-RESIZE ══════════ */

  const resize = () => {
    field.style.height = 'auto';
    field.style.height = Math.min(field.scrollHeight, 200) + 'px';
  };

  field.addEventListener('input', () => {
    if (field.value.length > MAX) field.value = field.value.slice(0, MAX);
    resize();
  });

  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  /* ══════════ SUGERENCIAS ══════════ */

  document.querySelectorAll('[data-suggestion]').forEach((btn) => {
    btn.addEventListener('click', () => {
      field.value = btn.dataset.suggestion || '';
      resize();
      field.focus();
    });
  });

  /* ══════════ ADJUNTAR ARCHIVOS ══════════ */

  const fileInput = document.getElementById('file-input');
  const attachBtn = document.getElementById('attach-btn');
  const previewEl = document.getElementById('attach-preview');
  const previewIcon = document.getElementById('attach-preview-icon');
  const previewName = document.getElementById('attach-preview-name');
  const previewSize = document.getElementById('attach-preview-size');
  const previewRemove = document.getElementById('attach-preview-remove');

  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
      const f = e.target.files?.[0];
      if (f) processFile(f);
    });
  }

  if (previewRemove) {
    previewRemove.addEventListener('click', () => {
      attachedFile = null;
      if (fileInput) fileInput.value = '';
      renderAttachPreview();
    });
  }

  // Pegar imagen desde el portapapeles
  field.addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const it of items) {
      if (it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) { e.preventDefault(); processFile(f); }
        return;
      }
    }
  });

  function processFile(file) {
    if (file.size > MAX_FILE_SIZE) {
      alert('El archivo supera los 10 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const commaIdx = result.indexOf(',');
      const base64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;

      attachedFile = {
        name: file.name || 'archivo',
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        data: base64,
      };
      renderAttachPreview();
    };
    reader.onerror = () => alert('No se pudo leer el archivo.');
    reader.readAsDataURL(file);
  }

  function renderAttachPreview() {
    if (!previewEl) return;
    if (!attachedFile) {
      previewEl.hidden = true;
      if (attachBtn) attachBtn.classList.remove('has-file');
      return;
    }
    previewEl.hidden = false;
    if (attachBtn) attachBtn.classList.add('has-file');
    if (previewIcon) previewIcon.textContent = iconForFile(attachedFile.mimeType, attachedFile.name);
    if (previewName) previewName.textContent = attachedFile.name;
    if (previewSize) previewSize.textContent = formatSize(attachedFile.size);
  }

  /* ══════════ DICTADO POR VOZ ══════════ */

  const micBtn = document.getElementById('mic-btn');
  let recognition = null;
  let listening = false;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (micBtn && SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.lang = 'es-CO';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      listening = true;
      micBtn.classList.add('is-listening');
      field.placeholder = 'Escuchando…';
    };

    recognition.onresult = (e) => {
      let finalTxt = '';
      let interimTxt = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalTxt += t;
        else interimTxt += t;
      }
      const base = field.dataset.voiceBase || '';
      field.value = base + finalTxt + interimTxt;
      resize();
    };

    recognition.onend = () => {
      listening = false;
      micBtn.classList.remove('is-listening');
      field.placeholder = 'Pregúntale algo a Numination…';
      delete field.dataset.voiceBase;
    };

    recognition.onerror = (e) => {
      console.warn('[audio] error:', e.error);
      if (e.error === 'not-allowed') alert('Necesito permiso para usar el micrófono.');
      listening = false;
      micBtn.classList.remove('is-listening');
      field.placeholder = 'Pregúntale algo a Numination…';
    };

    micBtn.addEventListener('click', () => {
      if (listening) { recognition.stop(); return; }
      field.dataset.voiceBase = field.value ? field.value + ' ' : '';
      try { recognition.start(); } catch (err) { console.warn(err); }
    });
  } else if (micBtn) {
    micBtn.style.display = 'none';
  }

  /* ══════════ SUBMIT ══════════ */

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;

    const text = field.value.trim();
    if (!text) { field.focus(); return; }

    const attachment = attachedFile;
    attachedFile = null;
    if (fileInput) fileInput.value = '';
    renderAttachPreview();

    field.value = '';
    resize();

    if (empty) empty.style.display = 'none';

    addMessage(thread, 'user', text, attachment);
    busy = true;

    const typingEl = addTyping(thread);
    scroll.scrollTop = scroll.scrollHeight;

    try {
      const body = { message: text, role: ROLE };
      if (attachment) {
        body.file = {
          data: attachment.data,
          mimeType: attachment.mimeType,
          name: attachment.name,
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
          if (data?.error) errMsg = data.error;
        } catch {}
        addMessage(thread, 'ai', '⚠️ ' + errMsg);
        return;
      }

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
          try {
            const evt = JSON.parse(part.slice(6));
            if (evt.error) appendToBubble(live, '\n\n⚠️ ' + evt.error);
            else if (evt.token) { appendToBubble(live, evt.token); fullText += evt.token; }
            if (evt.done && !finished) { finished = true; finalizeBubble(live, fullText); }
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
      field.focus();
    }
  });
}

/* ══════════ MENSAJES ══════════ */

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
    if (attachment.mimeType?.startsWith('image/')) {
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

  if (role === 'ai' && text) attachSpeakButton(bubble, text);

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

/* ══════════ STREAMING BUBBLE ══════════ */

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

/* ══════════ LECTURA EN VOZ ALTA ══════════ */

let voices = [];
if ('speechSynthesis' in window) {
  const loadVoices = () => { voices = window.speechSynthesis.getVoices(); };
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function pickVoice() {
  return (
    voices.find(v => v.lang === 'es-CO') ||
    voices.find(v => v.lang === 'es-MX') ||
    voices.find(v => v.lang === 'es-US') ||
    voices.find(v => v.lang.startsWith('es')) ||
    voices[0] || null
  );
}

function cleanForSpeech(text) {
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/#+\s/g, '')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/_{1,2}(.+?)_{1,2}/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const clean = cleanForSpeech(text);
  if (!clean) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; }
  else u.lang = 'es-CO';
  u.rate = 1.0;
  u.pitch = 1.0;
  window.speechSynthesis.speak(u);
}

function attachSpeakButton(bubble, text) {
  if (!bubble || !('speechSynthesis' in window)) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg__speak';
  btn.setAttribute('aria-label', 'Leer en voz alta');
  btn.innerHTML = '<svg class="icon icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';

  let speaking = false;

  btn.addEventListener('click', () => {
    if (speaking) {
      window.speechSynthesis.cancel();
      speaking = false;
      btn.classList.remove('is-speaking');
      return;
    }
    speak(text);
    speaking = true;
    btn.classList.add('is-speaking');
    const cleanup = () => {
      speaking = false;
      btn.classList.remove('is-speaking');
      window.speechSynthesis.removeEventListener('end', cleanup);
    };
    window.speechSynthesis.addEventListener('end', cleanup);
  });

  bubble.appendChild(btn);
}

/* ══════════ HELPERS ══════════ */

function iconForFile(mime, name) {
  if (mime.startsWith('image/')) return '🖼️';
  if (mime === 'application/pdf') return '📕';
  if (mime.startsWith('text/')) return '📄';
  if (/\.(doc|docx)$/i.test(name)) return '📘';
  if (/\.(xls|xlsx)$/i.test(name)) return '📊';
  return '📎';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}