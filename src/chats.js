/* ================================================================
   NUMINATION · chats.js
   Persistencia de conversaciones en Supabase.
   ================================================================ */

import {
  listarChats,
  crearChat,
  obtenerChat,
  agregarMensaje,
  eliminarChat,
  eliminarTodosLosChats,
} from './services/supabase.js';

export function mountChatRoutes(app, requireAuth) {
  /* Listar todas las conversaciones del usuario */
  app.get('/api/chats', requireAuth, async (req, res) => {
    try {
      const chats = await listarChats(req.user.id);
      return res.json({ ok: true, chats });
    } catch (e) {
      console.error('[chats] listar:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* Obtener una conversación específica con sus mensajes */
  app.get('/api/chats/:id', requireAuth, async (req, res) => {
    try {
      const chat = await obtenerChat(req.params.id, req.user.id);
      if (!chat) return res.status(404).json({ ok: false, error: 'No encontrado' });
      return res.json({ ok: true, chat });
    } catch (e) {
      console.error('[chats] obtener:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* Crear conversación */
  app.post('/api/chats', requireAuth, async (req, res) => {
    try {
      const title = req.body?.title || req.body?.chat?.title || 'Sin título';
      const chat = await crearChat(req.user.id, title);
      if (!chat) return res.status(500).json({ ok: false, error: 'No se pudo crear' });
      return res.json({ ok: true, chat });
    } catch (e) {
      console.error('[chats] crear:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* Añadir un mensaje */
  app.post('/api/chats/:id/messages', requireAuth, async (req, res) => {
    try {
      const raw = req.body?.message || req.body;
      if (!raw || !raw.role || !raw.content) {
        return res.status(400).json({ ok: false, error: 'Mensaje inválido' });
      }

      const msg = await agregarMensaje(req.params.id, {
        role: raw.role === 'user' ? 'user' : 'ai',
        content: String(raw.content),
        attachment: raw.attachment || null,
        imageUrl: raw.imageUrl || null,
        provider: raw.provider || null,
        durationMs: raw.durationMs || 0,
      });

      if (!msg) return res.status(500).json({ ok: false, error: 'No se pudo guardar' });
      return res.json({ ok: true, message: msg });
    } catch (e) {
      console.error('[chats] mensaje:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* Eliminar conversación */
  app.delete('/api/chats/:id', requireAuth, async (req, res) => {
    try {
      const ok = await eliminarChat(req.params.id, req.user.id);
      if (!ok) return res.status(500).json({ ok: false, error: 'No se pudo eliminar' });
      return res.json({ ok: true });
    } catch (e) {
      console.error('[chats] eliminar:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* Eliminar TODAS las conversaciones del usuario */
  app.delete('/api/chats', requireAuth, async (req, res) => {
    try {
      await eliminarTodosLosChats(req.user.id);
      return res.json({ ok: true });
    } catch (e) {
      console.error('[chats] eliminar todas:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  console.log('[chats] rutas montadas (Supabase)');
}