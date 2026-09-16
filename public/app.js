/* ══════════════════════════════════════════════════════════════
   NUMINATION — Lógica del cliente v2
   ══════════════════════════════════════════════════════════════ */

/* ─────────── Constantes ─────────── */
const STORAGE_KEY   = 'numination_state_v2';
const THEME_KEY     = 'numination_theme';
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

/* ─────────── Estado ─────────── */
const state = {
  screen: 'landing',
  theme: localStorage.getItem(THEME_KEY) || 'light',
  role: 'student',
  provider: 'gemini',
  conversations: [],       // [{id, title, messages:[{role, content, ts, provider}], created}]
  currentConvId: null,
  busy: false,
};

/* ─────────── Utilidades ─────────── */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function toast(msg, kind = 'info', ttl = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  const ico = kind === 'ok' ? '✅' : kind === 'err' ? '⚠️' : 'ℹ️';
  el.innerHTML = `<span>${ico}</span><span>${escapeHtml(msg)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.animation = 'toastIn .3s ease reverse';
    setTimeout(() => el.remove(), 280);
  }, ttl);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}

function fmtRel(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `hace ${d} d`;
  return new Date(ts).toLocaleDateString('es-CO');
}

/* ─────────── Persistencia ─────────── */
function save() {
  const data = {
    role: state.role,
    provider: state.provider,
    conversations: state.conversations,
    currentConvId: state.currentConvId,
  };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    state.role = data.role || 'student';
    state.provider = data.provider || 'gemini';
    state.conversations = Array.isArray(data.conversations) ? data.conversations : [];
    state.currentConvId = data.currentConvId || null;
  } catch {}
}

/* ─────────── Tema ─────────── */
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem(THEME_KEY, state.theme);
  const btn = $('#nav-theme');
  if (btn) btn.textContent = state.theme === 'dark' ? '☀️' : '🌙';
  const btn2 = $('#btn-theme-chat');
  if (btn2) btn2.textContent = state.theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
}

/* ─────────── Router de pantallas ─────────── */
function go(screen) {
  state.screen = screen;
  $$('.screen').forEach((el) => el.classList.remove('active'));
  $(`#screen-${screen}`).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'instant' });

  if (screen === 'chat') {
    requestAnimationFrame(() => {
      const input = $('#input');
      if (input) input.focus();
      scrollBottom();
    });
  }
}

/* ─────────── Conversaciones ─────────── */
function newConversation() {
  const id = uid();
  const conv = {
    id,
    title: 'Nueva conversación',
    messages: [],
    created: Date.now(),
  };
  state.conversations.unshift(conv);
  state.currentConvId = id;
  save();
  renderConversations();
  renderMessages();
  return conv;
}

function getCurrent() {
  return state.conversations.find((c) => c.id === state.currentConvId) ?? null;
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
  ev?.stopPropagation();
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (state.currentConvId === id) {
    state.currentConvId = state.conversations[0]?.id ?? null;
  }
  save();
  renderConversations();
  renderMessages();
  toast('Conversación eliminada', 'ok');
}

function clearAll() {
  if (!confirm('¿Borrar TODAS las conversaciones? Esta acción no se puede deshacer.')) return;
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
    list.innerHTML = `<div style="padding:12px;font-size:12.5px;color:var(--fg-suave)">Sin conversaciones aún</div>`;
    return;
  }

  state.conversations.forEach((c) => {
    const item = document.createElement('div');
    item.className = 'conv-item' + (c.id === state.currentConvId ? ' active' : '');
    item.innerHTML = `
      <span class="conv-item-title">${escapeHtml(c.title)}</span>
      <button class="conv-item-del" title="Eliminar">×</button>
    `;
    item.addEventListener('click', () => switchConversation(c.id));
    item.querySelector('.conv-item-del').addEventListener('click', (ev) => deleteConversation(c.id, ev));
    list.appendChild(item);
  });
}

/* ─────────── Markdown simple ─────────── */
function renderMarkdown(text) {
  let html = escapeHtml(text);

  // Código en bloque
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code}</code></pre>`);
  // Código inline
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Negritas
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Itálicas
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // Headings
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  // Separador
  html = html.replace(/^---$/gm, '<hr/>');
  // Listas no ordenadas
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>[\s\S]*?<\/li>)/g, (m) => `<ul>${m}</ul>`);
  html = html.replace(/<\/ul>\s*<ul>/g, '');
  // Párrafos: doble salto
  html = html.split(/\n{2,}/).map((block) => {
    if (/^\s*<(h\d|ul|ol|pre|hr|blockquote)/.test(block)) return block;
    return `<p>${block.replace(/\n/g, '<br/>')}</p>`;
  }).join('');

  return html;
}

/* ─────────── Render de mensajes ─────────── */
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

  conv.messages.forEach((m, i) => {
    wrap.appendChild(buildMessageEl(m, i));
  });
  scrollBottom();
}

function buildMessageEl(m, index) {
  const isUser = m.role === 'user';
  const el = document.createElement('div');
  el.className = `msg ${isUser ? 'user' : 'bot'}`;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.textContent = isUser ? '👤' : '🇨🇴';

  const content = document.createElement('div');
  content.className = 'msg-content';

  const head = document.createElement('div');
  head.className = 'msg-head';
  head.innerHTML = `
    <span>${isUser ? 'Tú' : 'Numination'}</span>
    <span>·</span>
    <span>${fmtTime(m.ts)}</span>
    ${m.provider ? `<span>·</span><span>${m.provider}</span>` : ''}
  `;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.innerHTML = renderMarkdown(m.content);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
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
    toast('Copiado al portapapeles', 'ok', 1800);
  } catch {
    toast('No se pudo copiar', 'err');
  }
}

function scrollBottom() {
  const scroller = $('#chat-scroll');
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
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
      $('#input').value = txt;
      updateCharCount();
      send();
    });
    box.appendChild(b);
  });
}

/* ─────────── Envío de mensajes ─────────── */
async function send() {
  if (state.busy) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;

  let conv = getCurrent();
  if (!conv) conv = newConversation();

  // Agregar mensaje del usuario
  conv.messages.push({ role: 'user', content: text, ts: Date.now() });

  // Actualizar título si es el primero
  if (conv.messages.length === 1) {
    conv.title = text.slice(0, 40) + (text.length > 40 ? '…' : '');
  }

  input.value = '';
  input.style.height = 'auto';
  updateCharCount();

  renderMessages();
  renderConversations();
  save();

  // Typing indicator
  const wrap = $('#messages');
  const typingEl = document.createElement('div');
  typingEl.className = 'msg bot';
  typingEl.id = 'typing-indicator';
  typingEl.innerHTML = `
    <div class="msg-avatar">🇨🇴</div>
    <div class="msg-content">
      <div class="msg-head"><span>Numination</span><span>·</span><span>escribiendo</span></div>
      <div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>
    </div>
  `;
  wrap.appendChild(typingEl);
  scrollBottom();

  state.busy = true;
  setComposerBusy(true);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        provider: state.provider,
        role: state.role,
      }),
    });

    typingEl.remove();

    if (!res.ok) {
      let msg = `Error ${res.status}`;
      try {
        const err = await res.json();
        msg = err.error?.message || err.error || msg;
      } catch {}
      throw new Error(msg);
    }

    const data = await res.json();
    const reply = data.reply || '(sin respuesta)';

    conv.messages.push({
      role: 'assistant',
      content: reply,
      ts: Date.now(),
      provider: data.provider || state.provider,
    });
    save();
    renderMessages();
  } catch (err) {
    typingEl.remove();
    conv.messages.push({
      role: 'assistant',
      content: `❌ **Error:** ${err.message}\n\nIntenta de nuevo o cambia de motor arriba a la derecha.`,
      ts: Date.now(),
      provider: state.provider,
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
  $('#send-btn').disabled = busy;
  $('#input').disabled = busy;
}

function updateCharCount() {
  const len = $('#input').value.length;
  $('#char-count').textContent = `${len} / 4000`;
}

/* ─────────── Exportar ─────────── */
function exportConversation() {
  const conv = getCurrent();
  if (!conv || conv.messages.length === 0) {
    toast('No hay conversación para exportar', 'err');
    return;
  }
  const lines = conv.messages.map((m) => {
    const who = m.role === 'user' ? 'TÚ' : 'NUMINATION';
    const time = new Date(m.ts).toLocaleString('es-CO');
    return `[${time}] ${who}:\n${m.content}\n`;
  });
  const blob = new Blob(
    [`Conversación: ${conv.title}\n\n` + lines.join('\n---\n\n')],
    { type: 'text/plain;charset=utf-8' }
  );
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `numination-${conv.id}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Conversación descargada', 'ok');
}

/* ─────────── Sidebar móvil ─────────── */
function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#overlay').classList.add('active');
}
function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#overlay').classList.remove('active');
}

/* ─────────── Contadores animados ─────────── */
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

/* ─────────── Bindings ─────────── */
function bindNav() {
  // Scroll shadow
  window.addEventListener('scroll', () => {
    const nav = $('.nav');
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 10);
  });

  // Theme nav
  $('#nav-theme')?.addEventListener('click', toggleTheme);
  $('#btn-theme-chat')?.addEventListener('click', toggleTheme);

  // Nav a landing
  $$('[data-nav="landing"]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      go('landing');
    });
  });

  // Abrir chat como invitado
  $$('[data-action="open-chat-guest"]').forEach((b) => {
    b.addEventListener('click', () => {
      if (!state.conversations.length) newConversation();
      else if (!state.currentConvId) state.currentConvId = state.conversations[0].id;
      go('chat');
      renderConversations();
      renderMessages();
    });
  });

  // Scroll a features
  $$('[data-action="scroll-features"]').forEach((b) => {
    b.addEventListener('click', () => {
      $('#features')?.scrollIntoView({ behavior: 'smooth' });
    });
  });

  // Botones "Entrar como ..."
  $$('[data-role-start]').forEach((b) => {
    b.addEventListener('click', () => {
      state.role = b.dataset.roleStart;
      save();
      syncRoleTabs();
      if (!state.conversations.length) newConversation();
      go('chat');
      renderConversations();
      renderMessages();
      toast(`Modo ${state.role === 'teacher' ? 'profesor' : 'estudiante'} activado`, 'ok');
    });
  });
}

function bindChat() {
  // Roles
  $$('.header-tabs .tab').forEach((t) => {
    t.addEventListener('click', () => {
      state.role = t.dataset.role;
      save();
      syncRoleTabs();
      renderSuggestions();
      toast(`Modo ${state.role === 'teacher' ? 'profesor' : 'estudiante'}`, 'info', 1800);
    });
  });

  // Providers
  $$('.provider-tabs .ptab').forEach((p) => {
    p.addEventListener('click', () => {
      state.provider = p.dataset.provider;
      save();
      syncProviderTabs();
      const name = state.provider === 'gemini' ? 'Gemini' : 'Mistral';
      $('#provider-hint').textContent = `Respondiendo con ${name}`;
    });
  });

  // Input
  const input = $('#input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    updateCharCount();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  $('#send-btn').addEventListener('click', send);
  $('#btn-new-chat').addEventListener('click', () => {
    newConversation();
    toast('Nueva conversación', 'ok', 1600);
  });
  $('#btn-clear').addEventListener('click', clearAll);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#menu-toggle').addEventListener('click', openSidebar);
  $('#overlay').addEventListener('click', closeSidebar);
}

function syncRoleTabs() {
  $$('.header-tabs .tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.role === state.role);
  });
  $$('[data-role-set]').forEach((b) => {
    b.classList.toggle('active', b.dataset.roleSet === state.role);
  });
}

function syncProviderTabs() {
  $$('.provider-tabs .ptab').forEach((p) => {
    p.classList.toggle('active', p.dataset.provider === state.provider);
  });
  $$('[data-prov]').forEach((b) => {
    b.classList.toggle('active', b.dataset.prov === state.provider);
  });
  const name = state.provider === 'gemini' ? 'Gemini' : 'Mistral';
  const hint = $('#provider-hint');
  if (hint) hint.textContent = `Respondiendo con ${name}`;
}

/* ─────────── Ajustes (modal) ─────────── */
function openSettings() {
  $('#modal-settings').classList.add('active');
  syncRoleTabs();
  syncProviderTabs();
  $$('[data-theme]').forEach((b) => {
    b.classList.toggle('active', b.dataset.theme === state.theme);
  });
}
function closeSettings() {
  $('#modal-settings').classList.remove('active');
}

function bindSettings() {
  $('#modal-settings-close').addEventListener('click', closeSettings);
  $('#modal-settings').addEventListener('click', (e) => {
    if (e.target.id === 'modal-settings') closeSettings();
  });

  $$('[data-theme]').forEach((b) => {
    b.addEventListener('click', () => {
      state.theme = b.dataset.theme;
      applyTheme();
      $$('[data-theme]').forEach((x) => x.classList.toggle('active', x === b));
    });
  });

  $$('[data-prov]').forEach((b) => {
    b.addEventListener('click', () => {
      state.provider = b.dataset.prov;
      save();
      syncProviderTabs();
    });
  });

  $$('[data-role-set]').forEach((b) => {
    b.addEventListener('click', () => {
      state.role = b.dataset.roleSet;
      save();
      syncRoleTabs();
      renderSuggestions();
    });
  });

  $('#btn-export').addEventListener('click', exportConversation);
}

/* ─────────── Teclado global ─────────── */
function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Esc: cerrar modales / sidebar
    if (e.key === 'Escape') {
      closeSettings();
      closeSidebar();
    }
    // Ctrl/Cmd + K: nueva conversación
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (state.screen === 'chat') {
        newConversation();
      }
    }
    // Ctrl/Cmd + Shift + L: toggle theme
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      toggleTheme();
    }
  });
}

/* ─────────── Init ─────────── */
function init() {
  load();
  applyTheme();
  syncRoleTabs();
  syncProviderTabs();
  updateCharCount();

  bindNav();
  bindChat();
  bindSettings();
  bindKeyboard();

  renderConversations();
  renderMessages();
  animateCounters();

  // Si ya hay historial, ofrecer ir directo al chat
  if (state.conversations.length > 0) {
    // pequeño delay para que no sea agresivo
    setTimeout(() => {
      toast('Tienes conversaciones guardadas. Pulsa "Probar" para retomarlas.', 'info', 4500);
    }, 1500);
  }
}

document.addEventListener('DOMContentLoaded', init);