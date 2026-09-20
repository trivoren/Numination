/* ================================================================
   NUMINATION · chats.js
   Persistencia de conversaciones por usuario.
   Formato: data/chats/{userId}.json
   ================================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHATS_DIR = path.join(__dirname, '..', 'data', 'chats');

function ensureDir() {
  if (!fs.existsSync(CHATS_DIR)) fs.mkdirSync(CHATS_DIR, { recursive: true });
}

function fileFor(userId) {
  return path.join(CHATS_DIR, `${userId}.json`);
}

function load(userId) {
  ensureDir();
  const file = fileFor(userId);
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function save(userId, chats) {
  ensureDir();
  fs.writeFileSync(fileFor(userId), JSON.stringify(chats, null, 2), 'utf-8');
}

function uid(prefix = 'c') {
  return prefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function normalizeChat(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    id: raw.id || uid(),
    title: String(raw.title || 'Sin título').slice(0, 120),
    createdAt: Number(raw.createdAt) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Date.now(),
    pinned: Boolean(raw.pinned),
    messages: Array.isArray(raw.messages)
      ? raw.messages.map(normalizeMsg).filter(Boolean)
      : [],
    meta: raw.meta || {},
  };
}

function normalizeMsg(m) {
  if (!m || typeof m !== 'object') return null;
  return {
    id: m.id || uid('m'),
    role: m.role === 'user' ? 'user' : 'ai',
    content: String(m.content || ''),
    attachment: m.attachment || null,
    imageUrl: m.imageUrl || null,
    ts: Number(m.ts) || Date.now(),
    durationMs: Number(m.durationMs) || 0,
    provider: m.provider || null,
  };
}

/* ── Rutas ── */
export function mountChatRoutes(app, requireAuth) {
  app.get('/api/chats', requireAuth, (req, res) => {
    const chats = load(req.user.id);
    return res.json({ ok: true, chats });
  });

  app.get('/api/chats/:id', requireAuth, (req, res) => {
    const chats = load(req.user.id);
    const chat = chats.find((c) => c.id === req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat no encontrado' });
    return res.json({ ok: true, chat });
  });

  app.post('/api/chats', requireAuth, (req, res) => {
    const chats = load(req.user.id);
    const raw = req.body?.chat || req.body;
    const chat = normalizeChat(raw);
    if (!chat) return res.status(400).json({ ok: false, error: 'Chat inválido' });

    chats.unshift(chat);
    save(req.user.id, chats.slice(0, 500));
    return res.json({ ok: true, chat });
  });

  app.put('/api/chats/:id', requireAuth, (req, res) => {
    const chats = load(req.user.id);
    const i = chats.findIndex((c) => c.id === req.params.id);
    if (i === -1) return res.status(404).json({ ok: false, error: 'Chat no encontrado' });

    const raw = req.body?.chat || req.body;
    const chat = normalizeChat({ ...raw, id: req.params.id });
    chat.updatedAt = Date.now();
    chats[i] = chat;
    save(req.user.id, chats);
    return res.json({ ok: true, chat });
  });

  app.post('/api/chats/:id/messages', requireAuth, (req, res) => {
    const chats = load(req.user.id);
    const chat = chats.find((c) => c.id === req.params.id);
    if (!chat) return res.status(404).json({ ok: false, error: 'Chat no encontrado' });

    const msg = normalizeMsg(req.body?.message || req.body);
    if (!msg) return res.status(400).json({ ok: false, error: 'Mensaje inválido' });

    chat.messages.push(msg);
    chat.updatedAt = Date.now();
    save(req.user.id, chats);
    return res.json({ ok: true, message: msg });
  });

  app.delete('/api/chats/:id', requireAuth, (req, res) => {
    const chats = load(req.user.id);
    const i = chats.findIndex((c) => c.id === req.params.id);
    if (i === -1) return res.status(404).json({ ok: false, error: 'Chat no encontrado' });

    chats.splice(i, 1);
    save(req.user.id, chats);
    return res.json({ ok: true });
  });

  app.delete('/api/chats', requireAuth, (req, res) => {
    save(req.user.id, []);
    return res.json({ ok: true });
  });

  console.log('[chats] rutas montadas');
}