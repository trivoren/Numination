/* ================================================================
   NUMINATION · memories.js
   ----------------------------------------------------------------
   Rutas para gestionar las memorias del usuario.
   Una memoria es un dato corto que la IA recuerda entre sesiones.

   Endpoints:
     GET    /api/memories       → lista de memorias del usuario
     POST   /api/memories       → crear nueva memoria { text }
     DELETE /api/memories/:id   → eliminar memoria por id
   ================================================================ */

import {
  listarMemories,
  crearMemory,
  eliminarMemory,
} from './services/supabase.js';

const MAX_MEMORIES_PER_USER = 100;
const MIN_LENGTH = 3;
const MAX_LENGTH = 500;

export function mountMemoryRoutes(app, requireAuth) {

  /* ─────────────────────────────────────────────────────────────
     GET /api/memories
     ───────────────────────────────────────────────────────────── */
  app.get('/api/memories', requireAuth, async (req, res) => {
    try {
      const memories = await listarMemories(req.user.id);
      return res.json({ ok: true, memories: memories || [] });
    } catch (err) {
      console.error('[memories] listar:', err.message);
      return res.status(500).json({ ok: false, error: 'No se pudieron cargar las memorias' });
    }
  });

  /* ─────────────────────────────────────────────────────────────
     POST /api/memories
     ───────────────────────────────────────────────────────────── */
  app.post('/api/memories', requireAuth, async (req, res) => {
    try {
      const raw = (req.body && req.body.text) || '';
      const text = String(raw).trim();

      if (text.length < MIN_LENGTH) {
        return res.status(400).json({
          ok: false,
          error: `La memoria debe tener al menos ${MIN_LENGTH} caracteres`,
        });
      }
      if (text.length > MAX_LENGTH) {
        return res.status(400).json({
          ok: false,
          error: `La memoria no puede superar los ${MAX_LENGTH} caracteres`,
        });
      }

      const actuales = await listarMemories(req.user.id);
      if (actuales && actuales.length >= MAX_MEMORIES_PER_USER) {
        return res.status(400).json({
          ok: false,
          error: `Alcanzaste el límite de ${MAX_MEMORIES_PER_USER} memorias. Elimina algunas para continuar.`,
        });
      }

      const memory = await crearMemory(req.user.id, text);
      if (!memory) {
        return res.status(500).json({ ok: false, error: 'No se pudo guardar la memoria' });
      }

      console.log('[memories] nueva:', text.slice(0, 60));
      return res.json({ ok: true, memory });
    } catch (err) {
      console.error('[memories] crear:', err.message);
      return res.status(500).json({ ok: false, error: 'No se pudo guardar la memoria' });
    }
  });

  /* ─────────────────────────────────────────────────────────────
     DELETE /api/memories/:id
     ───────────────────────────────────────────────────────────── */
  app.delete('/api/memories/:id', requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      if (!id) {
        return res.status(400).json({ ok: false, error: 'Falta el id de la memoria' });
      }

      const ok = await eliminarMemory(req.user.id, id);
      if (!ok) {
        return res.status(404).json({ ok: false, error: 'Memoria no encontrada' });
      }

      console.log('[memories] eliminada:', id.slice(0, 8));
      return res.json({ ok: true });
    } catch (err) {
      console.error('[memories] eliminar:', err.message);
      return res.status(500).json({ ok: false, error: 'No se pudo eliminar la memoria' });
    }
  });

  console.log('[memories] rutas montadas');
}