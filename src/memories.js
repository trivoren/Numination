/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · memories.js
   Rutas CRUD para memorias del usuario.
   Adaptado a la tabla PascalCase "Memory" con columnas title + content.
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  listarMemories,
  crearMemory,
  eliminarMemory,
} from './services/supabase.js';

export function mountMemoryRoutes(app, requireAuth) {
  /* ─── GET /api/memories ─── */
  app.get('/api/memories', requireAuth, async (req, res) => {
    try {
      const memories = await listarMemories(req.user.id);
      return res.json({ ok: true, memories });
    } catch (e) {
      console.error('[memories] listar:', e.message);
      return res.status(500).json({
        ok: false,
        error: 'No se pudieron cargar las memorias.',
      });
    }
  });

  /* ─── POST /api/memories ─── */
  app.post('/api/memories', requireAuth, async (req, res) => {
    try {
      const text = String(req.body?.text || '').trim();

      if (!text) {
        return res.status(400).json({
          ok: false,
          error: 'Falta el texto de la memoria.',
        });
      }

      if (text.length > 500) {
        return res.status(400).json({
          ok: false,
          error: 'La memoria es muy larga (máximo 500 caracteres).',
        });
      }

      const memory = await crearMemory(req.user.id, text);

      if (!memory) {
        return res.status(500).json({
          ok: false,
          error: 'No se pudo guardar la memoria.',
        });
      }

      return res.json({ ok: true, memory });
    } catch (e) {
      console.error('[memories] crear:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ─── DELETE /api/memories/:id ─── */
  app.delete('/api/memories/:id', requireAuth, async (req, res) => {
    try {
      const ok = await eliminarMemory(req.params.id, req.user.id);
      if (!ok) {
        return res.status(404).json({
          ok: false,
          error: 'Memoria no encontrada.',
        });
      }
      return res.json({ ok: true });
    } catch (e) {
      console.error('[memories] eliminar:', e.message);
      return res.status(500).json({ ok: false, error: e.message });
    }
  });
}