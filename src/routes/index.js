/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · routes/index.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Agregador de routers del mega-proyecto.

   Un solo punto de montaje para que src/index.js no se llene de
   `mountXRoutes(app)` y para que quede claro el mapa de la API.

   MONTAJES
     mountAllRoutes(app) → añade:
       · /api/admin/*        Panel de administración   (requireAdmin)
       · /api/rag/*          Ingesta RAG               (requireAuth)
       · /api/images/*       Generación de imágenes    (requireAuth)
       · /api/voice/*        Voz (STT/TTS)             (requireAuth)
       · /api/personas/*     Personas                  (requireAuth)
       · /api/memory*        Caja fuerte de memoria    (requireAuth)
       · /api/sandbox/*      Ejecutor de código        (requireAuth)
       · /api/search/web     Búsqueda web              (requireAuth)
       · /api/prompts/*      Biblioteca de prompts     (requireAuth)
       · /api/flags          Banderas (lectura)        (requireAuth)
       · /api/admin/flags    Banderas (escritura)      (requireAdmin)
       · /api/notifications* Notificaciones             (requireAuth)
       · /api/billing/*      Facturación               (requireAuth)

   NOTA SOBRE EL ORDEN
   Los routers se montan en orden alfabético, pero las rutas más
   específicos se registran antes de las genéricas cuando hay riesgo de
   colisión (por ejemplo `/api/personas/active` antes que
   `/api/personas/:id`). Dentro de cada router el orden ya está cuidado.
   ═══════════════════════════════════════════════════════════════════════════ */

import { mountAdminRoutes } from './admin.js';
import { mountRagRoutes } from './rag.js';
import { mountImageRoutes } from './images.js';
import { mountVoiceRoutes } from './voice.js';
import { mountPersonaRoutes } from './personas.js';
import { mountMemoryVaultRoutes } from './memory-vault.js';
import { mountSandboxRoutes } from './sandbox.js';
import { mountSearchRoutes } from './search.js';
import { mountPromptRoutes } from './prompts.js';
import { mountFlagRoutes } from './flags.js';
import { mountNotificationRoutes } from './notifications.js';
import { mountBillingRoutes } from './billing.js';
import { mountAiToolsRoutes } from './ai-tools.js';
import { mountGdprRoutes } from './gdpr-tools.js';
import { LOG } from '../lib/logger.js';

/**
 * Monta todos los routers nuevos.
 * @param {import('express').Application} app
 * @returns {string[]} Nombres de los routers montados
 */
export function mountAllRoutes(app) {
  const mounted = [];

  const safe = (name, fn) => {
    try {
      fn(app);
      mounted.push(name);
    } catch (e) {
      // Un router que falla al montarse no debe tumbar la app: se loguea
      // y el resto de la API sigue disponible.
      LOG.error(`routes.mount_failed`, { router: name, error: e?.message });
    }
  };

  safe('admin', mountAdminRoutes);
  safe('rag', mountRagRoutes);
  safe('images', mountImageRoutes);
  safe('voice', mountVoiceRoutes);
  safe('personas', mountPersonaRoutes);
  safe('memory-vault', mountMemoryVaultRoutes);
  safe('sandbox', mountSandboxRoutes);
  safe('search', mountSearchRoutes);
  safe('prompts', mountPromptRoutes);
  safe('flags', mountFlagRoutes);
  safe('notifications', mountNotificationRoutes);
  safe('billing', mountBillingRoutes);
  safe('ai-tools', mountAiToolsRoutes);
  safe('gdpr-tools', mountGdprRoutes);

  LOG.info('routes.mount_all', { mounted, count: mounted.length });

  return mounted;
}

export default { mountAllRoutes };
