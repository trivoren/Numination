/* NUMINATION — Lógica del cliente v1.3 */

const STORAGE_KEY = 'numination_state_v2';
const THEME_KEY = 'numination_theme';
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const SUGGESTIONS = {
  student: [
    'Explícame la fotosíntesis con un ejemplo del café colombiano',
    'Ayúdame a prepararme para el Saber 11 de matemáticas',
    'No entiendo las fracciones, ¿me ayudas paso a paso?',
    'Dame una técnica de estudio para no distraerme',
  ],
  teacher: [
    'Plan de clase de 45 min sobre el Río Magdalena para 5°',
    'Rúbrica para evaluar una exposición oral en 9°',
    'Adaptación DUA para un estudiante con dislexia',
    'Preguntas tipo Saber 11 sobre la Independencia',
  ],
};

const ICFES_PROMPTS = {
  matematicas: `Genera un simulacro de 5 preguntas tipo ICFES de MATEMÁTICAS para grado 11.\n\nFormato: enunciado claro, 4 opciones (A, B, C, D).\nAl final, solucionario paso a paso.\nContextualiza con ejemplos colombianos. Empieza con la pregunta 1.`,
  lectura: `Genera un simulacro de 5 preguntas tipo ICFES de LECTURA CRÍTICA para grado 11.\n\nIncluye: 1 texto corto, 5 preguntas (2 literales, 2 inferenciales, 1 crítica), opciones A/B/C/D, y solucionario al final. Empieza con el texto.`,
  naturales: `Genera un simulacro de 5 preguntas tipo ICFES de CIENCIAS NATURALES para grado 11.\n\nMezcla: 2 biología, 2 química, 1 física. Formato ICFES + solucionario. Usa ejemplos colombianos. Empieza ya.`,
  sociales: `Genera un simulacro de 5 preguntas tipo ICFES de CIENCIAS SOCIALES para grado 11.\n\nIncluye: historia de Colombia, geografía, Constitución de 1991, economía, actualidad. Formato ICFES + solucionario. Empieza ya.`,
  ingles: `Generate a 5-question ICFES-style ENGLISH practice test for 11th grade.\n\nInclude a short reading passage in English, 5 multiple-choice questions (A/B/C/D), and explain each answer in Spanish at the end. Start with the passage.`,
  completo: `Vamos a hacer un simulacro COMPLETO tipo ICFES para grado 11.\n\n10 preguntas: 2 Matemáticas, 2 Lectura Crítica, 2 Ciencias Naturales, 2 Ciencias Sociales, 2 Inglés.\nFormato: Área, enunciado, 4 opciones.\nAl final, solucionario completo.\nEmpieza con Matemáticas.`,
};

const state = {
  screen: 'landing',
  theme: localStorage.getItem(THEME_KEY) || 'light',
  role: 'student',
  conversations: [],
  currentConvId: null,
  busy: false,
  attachedFile: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function toast(msg, kind = 'info', ttl = 3200) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  const ico = kind === 'ok' ? '✅' : kind === 'err' ? '⚠️' : 'ℹ️';
  el.innerHTML = '<span>' + ico + '</span><span>' + escapeHtml(msg) + '</span>';
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ttl);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      role: state.role,
      conversations: state.conversations,
      currentConvId: state.currentConvId,
    }));
  } catch {}
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    state.role = d.role || 'student';
    state.conversations = Array.isArray(d.conversations) ? d.conversations : [];
    state.currentConvId = d.currentConvId || null;
  } catch {}
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem(THEME_KEY, state.theme);
  const b1 = $('#nav-theme'); if (b1) b1.textContent = state.theme === 'dark' ? '☀️' : '🌙';
  const b2 = $('#btn-theme-chat'); if (b2) b2.textContent = state.theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
}

function go(screen) {
  state.screen = screen;
  $$('.screen').forEach((el) => el.classList.remove('active'));
  const target = $('#screen-' + screen);
  if (target) target.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'instant' });
  if (screen === 'chat') {
    requestAnimationFrame(() => {
      const i = $('#input');
      if (i) i.focus();
      scrollBottom();
    });
  }
}

/* ══════════════════════════════════════════════════════════════
   ADJUNTAR ARCHIVOS
   ══════════════════════════════════════════════════════════════ */

function iconForFile(mimeType, name) {
  if (mimeType?.startsWith('image/')) return '🖼️';
  if (mimeType === 'application/pdf' || name?.endsWith('.pdf')) return '📕';
  if (mimeType?.startsWith('text/')) return '📄';
  if (mimeType?.includes('json')) return '🧾';
  if (mimeType?.includes('csv')) return '📊';
  return '📎';
}

function handleFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  if (file.size > MAX_FILE_SIZE) {
    toast('El archivo es muy grande (máx 10 MB)', 'err');
    e.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const base64 = reader.result.split(',')[1];
    state.attachedFile = {
      name: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      data: base64,
    };
    renderAttachPreview();
    toast('📎 ' + file.name + ' adjuntado', 'ok', 2000);
  };
  reader.onerror = () => toast('No se pudo leer el archivo', 'err');
  reader.readAsDataURL(file);
}

function clearAttachedFile() {
  state.attachedFile = null;
  const input = $('#file-input');
  if (input) input.value = '';
  renderAttachPreview();
}

function renderAttachPreview() {
  const preview = $('#attach-preview');
  const btn = $('#attach-btn');
  const f = state.attachedFile;
  if (!preview || !btn) return;

  if (!f) {
    preview.classList.remove('active');
    btn.classList.remove('has-file');
    return;
  }
  preview.classList.add('active');
  btn.classList.add('has-file');
  $('#attach-preview-icon').textContent = iconForFile(f.mimeType, f.name);
  $('#attach-preview-name').textContent = f.name;
  $('#attach-preview-size').textContent = fmtSize(f.size);
}

/* ══════════════════════════════════════════════════════════════
   CONVERSACIONES
   ══════════════════════════════════════════════════════════════ */

function newConversation() {
  const id = uid();
  state.conversations.unshift({ id, title: 'Nueva conversación', messages: [], created: Date.now() });
  state.currentConvId = id;
  save();
  renderConversations();
  renderMessages();
  return state.conversations[0];
}

function getCurrent() {
  return state.conversations.find((c) => c.id === state.currentConvId) || null;
}

function switchConversation(id) {
  if (id === state.currentConvId) return;
  state.currentConvId = id;
  save();
  renderConversations();
  renderMessages();
  if (window.innerWidth < 769) closeSidebar();
}

function deleteConversation(id, ev) {
  if (ev) ev.stopPropagation();
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.currentConvId === id) {
    state.currentConvId = state.conversations[0] ? state.conversations[0].id : null;
  }
  save();
  renderConversations();
  renderMessages();
  toast('Conversación eliminada', 'ok');
}

function clearAll() {
  if (!confirm('¿Borrar TODAS las conversaciones?')) return;
  state.conversations = [];
  state.currentConvId = null;
  save();
  renderConversations();
  renderMessages();
  toast('Historial borrado', 'ok');
}

function renderConversations() {
  const list = $('#conv-list');
  if (!list) return;
  list.innerHTML = '';
  if (state.conversations.length === 0) {
    list.innerHTML = '<div style="padding:12px;font-size:12.5px;color:var(--fg-suave)">Sin conversaciones aún</div>';
    return;
  }
  state.conversations.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === state.currentConvId ? ' active' : '');
    item.innerHTML = '<span class="conv-item-title">' + escapeHtml(c.title) + '</span><button class="conv-item-del" title="Eliminar">×</button>';
    item.addEventListener('click', () => switchConversation(c.id));
    item.querySelector('.conv-item-del').addEventListener('click', (ev) => deleteConversation(c.id, ev));
    list.appendChild(item);
  });
}

function renderMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/```([\s\S]*?)```/g, function(_, c) { return '<pre><code>' + c + '</code></pre>'; });
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^---$/gm, '<hr/>');
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, function(m) { return '<ul>' + m + '</ul>'; });
  html = html.replace(/<\/ul>\s*<ul>/g, '');
  html = html.split(/\n{2,}/).map(function(block) {
    if (/^\s*<(h\d|ul|ol|pre|hr|blockquote)/.test(block)) return block;
    return '<p>' + block.replace(/\n/g, '<br/>') + '</p>';
  }).join('');
  return html;
}

function renderMessages() {
  const wrap = $('#messages');
  const empty = $('#chat-empty');
  if (!wrap || !empty) return;
  wrap.innerHTML = '';
  const conv = getCurrent();
  if (!conv || conv.messages.length === 0) {
    empty.style.display = 'block';
    renderSuggestions();
    return;
  }
  empty.style.display = 'none';
  conv.messages.forEach((m) => wrap.appendChild(buildMessageEl(m)));
  scrollBottom();
}

function buildMessageEl(m) {
  const isUser = m.role === 'user';
  const el = document.createElement('div');
  el.className = 'msg ' + (isUser ? 'user' : 'bot');

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = isUser ? '👤' : '🇨🇴';

  const content = document.createElement('div');
  content.className = 'msg-content';

  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = '<span>' + (isUser ? 'Tú' : 'Numination') + '</span><span>·</span><span>' + fmtTime(m.ts) + '</span>';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderMarkdown(m.content);

  if (m.attachment) {
    if (m.attachment.mimeType?.startsWith('image/') && m.attachment.data) {
      const img = document.createElement('img');
      img.src = 'data:' + m.attachment.mimeType + ';base64,' + m.attachment.data;
      img.alt = m.attachment.name;
      bubble.appendChild(img);
    } else {
      const att = document.createElement('div');
      att.className = 'msg-attachment';
      att.innerHTML = '<span class="msg-attachment-icon">' + iconForFile(m.attachment.mimeType, m.attachment.name) + '</span><span class="msg-attachment-name">' + escapeHtml(m.attachment.name) + '</span>';
      bubble.appendChild(att);
    }
  }

  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  if (!isUser) {
    const speakBtn = document.createElement('button');
    speakBtn.className = 'msg-action speak-btn';
    speakBtn.textContent = '🔊 Escuchar';
    speakBtn.addEventListener('click', () => speak(m.content, el));
    actions.appendChild(speakBtn);
  }

  const copyBtn = document.createElement('button');
  copyBtn.className = 'msg-action';
  copyBtn.textContent = '📋 Copiar';
  copyBtn.addEventListener('click', () => copyText(m.content));
  actions.appendChild(copyBtn);

  content.appendChild(head);
  content.appendChild(bubble);
  content.appendChild(actions);
  el.appendChild(avatar);
  el.appendChild(content);
  return el;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copiado', 'ok', 1800);
  } catch {
    toast('No se pudo copiar', 'err');
  }
}

function scrollBottom() {
  const s = $('#chat-scroll');
  if (s) s.scrollTop = s.scrollHeight;
}

function renderSuggestions() {
  const box = $('#suggest-box');
  if (!box) return;
  box.innerHTML = '';
  SUGGESTIONS[state.role].forEach((txt) => {
    const b = document.createElement('button');
    b.className = 'sug';
    b.textContent = txt;
    b.addEventListener('click', () => {
      const i = $('#input');
      if (i) i.value = txt;
      updateCharCount();
      send();
    });
    box.appendChild(b);
  });
}

/* ══════════════════════════════════════════════════════════════
   ENVIAR
   ══════════════════════════════════════════════════════════════ */

async function send() {
  if (state.busy) return;
  const input = $('#input');
  const text = input.value.trim();
  const file = state.attachedFile;

  if (!text && !file) return;

  let conv = getCurrent();
  if (!conv) conv = newConversation();

  const attachmentSnapshot = file ? {
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    data: file.data,
  } : null;

  conv.messages.push({
    role: 'user',
    content: text || '(archivo adjunto)',
    ts: Date.now(),
    attachment: attachmentSnapshot,
  });

  if (conv.messages.length === 1) {
    const base = text || file.name;
    conv.title = base.slice(0, 40) + (base.length > 40 ? '…' : '');
  }

  input.value = '';
  input.style.height = 'auto';
  clearAttachedFile();
  updateCharCount();
  renderMessages();
  renderConversations();
  save();

  const wrap = $('#messages');
  const typingEl = document.createElement('div');
  typingEl.className = 'msg bot';
  typingEl.innerHTML = '<div class="msg-avatar">🇨🇴</div><div class="msg-content"><div class="msg-head"><span>Numination</span><span>·</span><span>analizando...</span></div><div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div></div>';
  wrap.appendChild(typingEl);
  scrollBottom();

  state.busy = true;
  setComposerBusy(true);

  try {
    const body = {
      message: text,
      role: state.role,
    };
    if (attachmentSnapshot) body.file = attachmentSnapshot;

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    typingEl.remove();

    if (!res.ok) {
      let msg = 'Error ' + res.status;
      try {
        const err = await res.json();
        msg = (err.error && err.error.message) || err.error || msg;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    const reply = data.reply || '(sin respuesta)';
    conv.messages.push({
      role: 'assistant',
      content: reply,
      ts: Date.now(),
    });
    save();
    renderMessages();
  } catch (err) {
    typingEl.remove();
    conv.messages.push({
      role: 'assistant',
      content: '❌ **Error:** ' + err.message + '\n\nIntenta de nuevo en unos segundos.',
      ts: Date.now(),
    });
    save();
    renderMessages();
    toast(err.message, 'err', 5000);
  } finally {
    state.busy = false;
    setComposerBusy(false);
    input.focus();
  }
}

function setComposerBusy(busy) {
  const s = $('#send-btn'); if (s) s.disabled = busy;
  const i = $('#input'); if (i) i.disabled = busy;
  const a = $('#attach-btn'); if (a) a.disabled = busy;
  const m = $('#mic-btn'); if (m) m.disabled = busy;
}

function updateCharCount() {
  const i = $('#input');
  const c = $('#char-count');
  if (i && c) c.textContent = i.value.length + ' / 4000';
}

function exportConversation() {
  const conv = getCurrent();
  if (!conv || conv.messages.length === 0) {
    toast('No hay conversación para exportar', 'err');
    return;
  }
  const lines = conv.messages.map((m) => {
    const who = m.role === 'user' ? 'TÚ' : 'NUMINATION';
    const time = new Date(m.ts).toLocaleString('es-CO');
    const att = m.attachment ? '\n[Archivo: ' + m.attachment.name + ']' : '';
    return '[' + time + '] ' + who + ':' + att + '\n' + m.content + '\n';
  });
  const blob = new Blob(['Conversación: ' + conv.title + '\n\n' + lines.join('\n---\n\n')], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'numination-' + conv.id + '.txt';
  a.click();
  URL.revokeObjectURL(url);
  toast('Descargado', 'ok');
}

function openSidebar() {
  const s = $('#sidebar'); const o = $('#overlay');
  if (s) s.classList.add('open');
  if (o) o.classList.add('active');
}
function closeSidebar() {
  const s = $('#sidebar'); const o = $('#overlay');
  if (s) s.classList.remove('open');
  if (o) o.classList.remove('active');
}

function animateCounters() {
  $$('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count);
    const dur = 1200;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min((now - start) / dur, 1);
      const val = Math.floor(target * (1 - Math.pow(1 - t, 3)));
      el.textContent = val.toLocaleString('es-CO');
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = target.toLocaleString('es-CO');
    };
    requestAnimationFrame(tick);
  });
}

/* ══════════════════════════════════════════════════════════════
   BINDINGS
   ══════════════════════════════════════════════════════════════ */

function bindNav() {
  window.addEventListener('scroll', () => {
    const nav = $('.nav');
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 10);
  });
  const t1 = $('#nav-theme'); if (t1) t1.addEventListener('click', toggleTheme);
  const t2 = $('#btn-theme-chat'); if (t2) t2.addEventListener('click', toggleTheme);

  $$('[data-nav="landing"]').forEach((a) => {
    a.addEventListener('click', (e) => { e.preventDefault(); go('landing'); });
  });

  $$('[data-action="open-chat-guest"]').forEach((b) => {
    b.addEventListener('click', () => {
      if (!state.conversations.length) newConversation();
      else if (!state.currentConvId) state.currentConvId = state.conversations[0].id;
      go('chat');
      renderConversations();
      renderMessages();
    });
  });

  $$('[data-action="scroll-features"]').forEach((b) => {
    b.addEventListener('click', () => {
      const el = $('#features');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    });
  });

  $$('[data-role-start]').forEach((b) => {
    b.addEventListener('click', () => {
      state.role = b.dataset.roleStart;
      save();
      syncRoleTabs();
      if (!state.conversations.length) newConversation();
      go('chat');
      renderConversations();
      renderMessages();
      toast('Modo ' + (state.role === 'teacher' ? 'profesor' : 'estudiante') + ' activado', 'ok');
    });
  });

  $$('[data-icfes-start]').forEach((b) => {
    b.addEventListener('click', () => {
      const tipo = b.dataset.icfesStart;
      const prompt = ICFES_PROMPTS[tipo];
      if (!prompt) return;
      state.role = 'student';
      save();
      syncRoleTabs();
      newConversation();
      go('chat');
      setTimeout(() => {
        const input = $('#input');
        if (input) {
          input.value = prompt;
          input.style.height = 'auto';
          input.style.height = Math.min(input.scrollHeight, 180) + 'px';
          updateCharCount();
          input.focus();
        }
        toast('Simulacro listo. Presiona Enter para comenzar.', 'ok', 3000);
      }, 150);
    });
  });
}

function bindChat() {
  $$('.header-tabs .tab').forEach((t) => {
    t.addEventListener('click', () => {
      state.role = t.dataset.role;
      save();
      syncRoleTabs();
      renderSuggestions();
      toast('Modo ' + (state.role === 'teacher' ? 'profesor' : 'estudiante'), 'info', 1800);
    });
  });

  const input = $('#input');
  if (input) {
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 180) + 'px';
      updateCharCount();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
  }

  const sendBtn = $('#send-btn'); if (sendBtn) sendBtn.addEventListener('click', send);
  const micBtn = $('#mic-btn'); if (micBtn) micBtn.addEventListener('click', toggleMic);

  const attachBtn = $('#attach-btn');
  const fileInput = $('#file-input');
  if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', handleFileSelect);
  }
  const attachRemove = $('#attach-remove');
  if (attachRemove) attachRemove.addEventListener('click', clearAttachedFile);

  document.addEventListener('paste', (e) => {
    if (state.screen !== 'chat') return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          handleFileSelect({ target: { files: [file], value: '' } });
          e.preventDefault();
          break;
        }
      }
    }
  });

  const newBtn = $('#btn-new-chat'); if (newBtn) newBtn.addEventListener('click', () => { newConversation(); toast('Nueva conversación', 'ok', 1600); });
  const clr = $('#btn-clear'); if (clr) clr.addEventListener('click', clearAll);
  const set = $('#btn-settings'); if (set) set.addEventListener('click', openSettings);
  const mt = $('#menu-toggle'); if (mt) mt.addEventListener('click', openSidebar);
  const ov = $('#overlay'); if (ov) ov.addEventListener('click', closeSidebar);
}

function syncRoleTabs() {
  $$('.header-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.role === state.role));
  $$('[data-role-set]').forEach((b) => b.classList.toggle('active', b.dataset.roleSet === state.role));
}

function openSettings() {
  const m = $('#modal-settings'); if (m) m.classList.add('active');
  syncRoleTabs();
  $$('[data-theme]').forEach((b) => b.classList.toggle('active', b.dataset.theme === state.theme));
}
function closeSettings() {
  const m = $('#modal-settings'); if (m) m.classList.remove('active');
}

function bindSettings() {
  const x = $('#modal-settings-close'); if (x) x.addEventListener('click', closeSettings);
  const m = $('#modal-settings');
  if (m) m.addEventListener('click', (e) => { if (e.target.id === 'modal-settings') closeSettings(); });

  $$('[data-theme]').forEach((b) => {
    b.addEventListener('click', () => {
      state.theme = b.dataset.theme;
      applyTheme();
      $$('[data-theme]').forEach((x) => x.classList.toggle('active', x === b));
    });
  });
  $$('[data-role-set]').forEach((b) => {
    b.addEventListener('click', () => { state.role = b.dataset.roleSet; save(); syncRoleTabs(); renderSuggestions(); });
  });
  const exp = $('#btn-export'); if (exp) exp.addEventListener('click', exportConversation);
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSettings(); closeSidebar(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state.screen === 'chat') newConversation();
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      toggleTheme();
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   WEB SPEECH API
   ══════════════════════════════════════════════════════════════ */

const speech = {
  supported: 'speechSynthesis' in window,
  voices: [],
  recognition: null,
  listening: false,
  rate: 1,
  voiceURI: localStorage.getItem('numination_voice') || null,
};

function initSpeech() {
  if (speech.supported) {
    const loadVoices = () => {
      speech.voices = window.speechSynthesis.getVoices();
      if (!speech.voiceURI) {
        const preferred = speech.voices.find(v => v.lang === 'es-CO') ||
          speech.voices.find(v => v.lang === 'es-MX') ||
          speech.voices.find(v => v.lang === 'es-US') ||
          speech.voices.find(v => v.lang.startsWith('es'));
        if (preferred) {
          speech.voiceURI = preferred.voiceURI;
          localStorage.setItem('numination_voice', speech.voiceURI);
        }
      }
    };
    loadVoices();
    window.speechSynthesis.onvoiceschanged = loadVoices;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return;

  const rec = new SR();
  rec.lang = 'es-CO';
  rec.continuous = false;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  rec.onstart = () => {
    speech.listening = true;
    const mic = document.getElementById('mic-btn');
    if (mic) mic.classList.add('listening');
  };
  rec.onresult = (e) => {
    let finalTxt = '';
    let interimTxt = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalTxt += t;
      else interimTxt += t;
    }
    const input = document.getElementById('input');
    if (input) {
      input.value = (finalTxt || interimTxt).trim();
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 180) + 'px';
      updateCharCount();
    }
  };
  rec.onerror = (e) => {
    speech.listening = false;
    const mic = document.getElementById('mic-btn');
    if (mic) mic.classList.remove('listening');
    if (e.error === 'not-allowed') toast('Permite el micrófono', 'err', 4000);
    else if (e.error === 'no-speech') toast('No se detectó voz', 'info', 2200);
  };
  rec.onend = () => {
    speech.listening = false;
    const mic = document.getElementById('mic-btn');
    if (mic) mic.classList.remove('listening');
  };
  speech.recognition = rec;
}

function toggleMic() {
  if (!speech.recognition) {
    toast('Tu navegador no soporta dictado. Usa Chrome.', 'err', 4000);
    return;
  }
  if (speech.listening) { speech.recognition.stop(); return; }
  const input = document.getElementById('input');
  if (input) input.value = '';
  try { speech.recognition.start(); } catch (e) { console.warn(e); }
}

function cleanForSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' bloque de código ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/^---+$/gm, '')
    .replace(/https?:\/\/\S+/g, 'enlace')
    .replace(/[🇨🇴☕🌱✨⚡🎯📘✅⏰📋🔊🎤🚀💛💙❤️]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function speak(text, msgEl) {
  if (!speech.supported) { toast('Navegador sin soporte de voz', 'err'); return; }
  if (window.speechSynthesis.speaking) {
    window.speechSynthesis.cancel();
    document.querySelectorAll('.msg.speaking').forEach(el => el.classList.remove('speaking'));
    return;
  }
  const clean = cleanForSpeech(text);
  if (!clean) return;
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = 'es-CO';
  u.rate = speech.rate;
  const voice = speech.voices.find(v => v.voiceURI === speech.voiceURI);
  if (voice) u.voice = voice;
  if (msgEl) {
    u.onstart = () => msgEl.classList.add('speaking');
    u.onend = () => msgEl.classList.remove('speaking');
    u.onerror = () => msgEl.classList.remove('speaking');
  }
  window.speechSynthesis.speak(u);
}

/* ══════════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════════ */

function init() {
  load();
  applyTheme();
  syncRoleTabs();
  updateCharCount();
  bindNav();
  bindChat();
  bindSettings();
  bindKeyboard();
  renderConversations();
  renderMessages();
  initSpeech();
  animateCounters();
}

document.addEventListener('DOMContentLoaded', init);