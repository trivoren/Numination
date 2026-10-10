/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · chats.js
   Rutas CRUD para conversaciones y mensajes.
   La API pública NO cambia — sólo por debajo consultamos las tablas
   PascalCase ("Chat", "Message") vía los helpers de supabase.js.
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  crearChat,
  listarChats,
  obtenerChat,
  eliminarChat,
  crearMensaje,
} from './services/supabase.js';

export function mountChatRoutes(app, requireAuth) {
  /* ─── GET /api/chats ─── */
  app.get('/api/chats', requireAuth, async (req, res) => {
    try {
      const chats = await listarChats(req.user.id);
      return res.json({ ok: true, chats });
    } catch (e) {
      console.error('[chats] listar:', e.message);
      return res.status(500).json({
        ok: false,
        error: 'No se pudieron cargar las conversaciones.',
      });
    }
  });

  /* ─── POST /api/chats ─── */
  app.post('/api/chats', requireAuth, async (req, res) => {
    try {
      const title =
        req.body?.title ||
        req.body?.chat?.title ||
        'Nuevo chat';

      const chat = await crearChat(req.user.id, title);

      if (!chat) {
        return res.status(500).json({
          ok: false,
          error: 'No se pudo crear la conversación.',
        });
      }

      return res.json({ ok: true, chat });
    } catch (e) {
      console.error('[chats] crear:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ─── GET /api/chats/:id ─── */
  app.get('/api/chats/:id', requireAuth, async (req, res) => {
    try {
      const chat = await obtenerChat(req.params.id, req.user.id);
      if (!chat) {
        return res.status(404).json({ ok: false, error: 'No encontrada.' });
      }
      return res.json({ ok: true, chat });
    } catch (e) {
      console.error('[chats] obtener:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ─── DELETE /api/chats/:id ─── */
  app.delete('/api/chats/:id', requireAuth, async (req, res) => {
    try {
      const ok = await eliminarChat(req.params.id, req.user.id);
      if (!ok) {
        return res.status(404).json({ ok: false, error: 'No encontrada.' });
      }
      return res.json({ ok: true });
    } catch (e) {
      console.error('[chats] eliminar:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ─── POST /api/chats/:id/messages ─── */
  app.post('/api/chats/:id/messages', requireAuth, async (req, res) => {
    try {
      const body = req.body?.message || req.body || {};
      const { role, content } = body;

      if (!role || !content) {
        return res.status(400).json({
          ok: false,
          error: 'Falta role o content.',
        });
      }

      // Verificar que el chat pertenece al usuario
      const chat = await obtenerChat(req.params.id, req.user.id);
      if (!chat) {
        return res.status(404).json({ ok: false, error: 'Chat no encontrado.' });
      }

      // Normalizar role: 'ai' → 'assistant' para consistencia
      const normalizedRole = role === 'ai' ? 'assistant' : role;

      const message = await crearMensaje(req.params.id, {
        role: normalizedRole,
        content: String(content),
      });

      if (!message) {
        return res.status(500).json({
          ok: false,
          error: 'No se pudo guardar el mensaje.',
        });
      }

      return res.json({ ok: true, message });
    } catch (e) {
      console.error('[chats] mensaje:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ─── DELETE /api/chats (eliminar todos) ─── */
  app.delete('/api/chats', requireAuth, async (req, res) => {
    try {
      const chats = await listarChats(req.user.id);
      let deleted = 0;

      for (const c of chats) {
        const ok = await eliminarChat(c.id, req.user.id);
        if (ok) deleted++;
      }

      return res.json({ ok: true, deleted });
    } catch (e) {
      console.error('[chats] eliminar todos:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}