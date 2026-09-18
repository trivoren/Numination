import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'public', 'assets', 'js', 'modules', 'chat.js');
let src = fs.readFileSync(file, 'utf-8');

// 1) Reemplaza el fetch normal por streaming SSE
const oldFetch = `      const res = await fetch(API_URL, {
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

      addMessage(thread, 'ai', reply || 'Aquí está tu imagen:', null, imageUrl);`;

const newFetch = `      const res = await fetch('/api/chat/stream', {
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

      const liveBubble = createLiveBubble(thread);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\\n\\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          const json = part.slice(6);
          try {
            const evt = JSON.parse(json);
            if (evt.error) {
              appendToBubble(liveBubble, '\\n\\n⚠️ ' + evt.error);
            } else if (evt.token) {
              appendToBubble(liveBubble, evt.token);
              fullText += evt.token;
            }
            if (evt.done) finalizeBubble(liveBubble, fullText);
          } catch (e) {}
        }
        scroll.scrollTop = scroll.scrollHeight;
      }

      if (fullText) finalizeBubble(liveBubble, fullText);`;

if (src.includes(oldFetch)) {
  src = src.replace(oldFetch, newFetch);
  console.log('  [OK] fetch reemplazado por streaming SSE');
} else {
  console.log('  [ERR] no se encontro el bloque de fetch original');
  console.log('  Revisa manualmente chat.js: ' + file);
  process.exit(1);
}

// 2) Añade las 3 funciones helper al final
const helpers = `
/* ══════════ Streaming: burbuja viva ══════════ */

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
`;

if (!src.includes('function createLiveBubble')) {
  src = src + helpers;
  console.log('  [OK] funciones helper agregadas al final');
} else {
  console.log('  [skip] helpers ya existian');
}

fs.writeFileSync(file, src, 'utf-8');
console.log('\\nListo.');