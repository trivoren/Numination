/* ═══════════════════════════════════════════════════════════════════════════
   
   NUMINATION · memories.js · v3.0
   
   ─────────────────────────────────────────────────────────────────────────
   
   La memoria de Numination. No es una tabla con filas. Es lo que la IA
   sabe de vos. Tu curso. Tu manera de aprender. Tus metas. Tus miedos.
   Lo que te gusta. Lo que te cuesta.
   
   Cuando un estudiante le dice a Numination "no entendí la tarea de
   trigonometría", la IA ya sabe si va en 10° o en 11°, si le va bien o
   mal con las matemáticas, si prefiere ejemplos con deportes o con
   música. Todo eso sale de acá.
   
   ─────────────────────────────────────────────────────────────────────────
   
   Lo que hace este archivo:
   
   · Guardar memorias — con tags múltiples, categoría, pin, relevance
   · Encontrarlas — búsqueda con ranking, filtros combinables
   · Organizarlas — timeline, stats, tags únicos
   · Relacionarlas — "esto se parece a esto otro"
   · Fusionarlas — si guardaste lo mismo dos veces, las juntamos
   · Exportarlas — tus datos son tuyos, bajalos cuando quieras
   · Importarlas — restáuralas desde un JSON
   · Bulk todo — porque nadie borra 50 cosas a mano
   
   ─────────────────────────────────────────────────────────────────────────
   
   RUTAS:
   
     GET    /api/memories                    → lista con filtros
     GET    /api/memories/stats              → números y tendencias
     GET    /api/memories/timeline           → agrupado por día
     GET    /api/memories/tags               → todos los tags únicos
     GET    /api/memories/:id                → una
     GET    /api/memories/:id/related        → memorias relacionadas
   
     POST   /api/memories                    → crear
     POST   /api/memories/bulk               → operar en varias
     POST   /api/memories/export             → descargar JSON
     POST   /api/memories/import             → importar JSON
     POST   /api/memories/:id/merge          → fusionar dos
     POST   /api/memories/:id/pin            → toggle pin
     POST   /api/memories/:id/use            → registrar uso
   
     PATCH  /api/memories/:id                → editar
   
     DELETE /api/memories/:id                → borrar una
     DELETE /api/memories                    → borrar todas
   
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  listarMemories,
  listarMemoriesConFiltros,
  listarTodasMemories,
  listarTagsUnicos,
  listarMemoriasRelacionadas,
  getMemory,
  crearMemory,
  actualizarMemory,
  actualizarMemoriesBulk,
  eliminarMemory,
  eliminarMemoriesBulk,
  eliminarTodasMemories,
  togglePinMemory,
  registrarUsoMemory,
  buscarMemories,
  statsMemories,
  contarMemoriaSimilar,
} from './services/supabase.js';

/* ══════════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ══════════════════════════════════════════════════════════════════════════ */

const MAX_TEXT     = 500;
const MAX_TITLE    = 80;
const MAX_CATEGORY = 30;
const MAX_TAGS     = 8;
const MAX_TAG_LEN  = 24;

const VALID_CATEGORIES = new Set([
  'general', 'personal', 'academico', 'preferencias',
  'objetivos', 'contexto', 'familia', 'salud', 'otros',
]);

/* Threshold para considerar dos memorias "casi iguales" */
const NEAR_DUP_THRESHOLD = 0.72;

/* Keywords para auto-tagging */
const AUTO_TAG_RULES = [
  { tag: 'colegio',      rx: /\b(colegio|escuela|clase|grado|curso|profesor|profe|materia)\b/i },
  { tag: 'universidad',  rx: /\b(universidad|uni|semestre|carrera|pregrado|facultad)\b/i },
  { tag: 'matematicas',  rx: /\b(matem[aá]ticas|mate|álgebra|geometr[ií]a|c[áa]lculo|trigo)\b/i },
  { tag: 'ciencias',     rx: /\b(f[ií]sica|qu[ií]mica|biolog[ií]a|ciencia)\b/i },
  { tag: 'humanidades',  rx: /\b(historia|filo|literatura|sociales|espa[ñn]ol|ingl[eé]s)\b/i },
  { tag: 'programacion', rx: /\b(c[oó]digo|programa|python|javascript|react|html|css)\b/i },
  { tag: 'musica',       rx: /\b(m[úu]sica|guitarra|piano|canci[oó]n|cantar|banda)\b/i },
  { tag: 'deporte',      rx: /\b(f[úu]tbol|baloncesto|atletismo|nadar|deporte|entrena)\b/i },
  { tag: 'lectura',      rx: /\b(libro|leer|lectura|novela|autor)\b/i },
  { tag: 'viaje',        rx: /\b(viaje|viajar|ciudad|pa[íi]s|vacaciones)\b/i },
  { tag: 'familia',      rx: /\b(mam[áa]|pap[áa]|hermano|hermana|abuel|t[íi]o|familia)\b/i },
  { tag: 'amigos',       rx: /\b(amigo|amiga|parcero|parche|mejor amig)\b/i },
  { tag: 'futuro',       rx: /\b(quiero ser|meta|sue[ñn]o|futuro|profesi[oó]n)\b/i },
  { tag: 'salud',        rx: /\b(salud|m[eé]dico|enfermo|ansiedad|estr[eé]s)\b/i },
  { tag: 'trabajo',      rx: /\b(trabajo|empleo|jefe|oficina|freelance)\b/i },
];

/* ══════════════════════════════════════════════════════════════════════════
   2 · LOGGING
   ══════════════════════════════════════════════════════════════════════════ */

const LEVEL = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVEL[process.env.LOG_LEVEL] || LEVEL.info;

function log(level, event, meta = {}) {
  if (LEVEL[level] < MIN_LEVEL) return;
  const entry = { ts: new Date().toISOString(), lvl: level, event, ...meta };
  const line = JSON.stringify(entry);
  if      (level === 'error') console.error('[mem]', line);
  else if (level === 'warn')  console.warn ('[mem]', line);
  else                        console.log  ('[mem]', line);
}

/* ══════════════════════════════════════════════════════════════════════════
   3 · RATE LIMITING
   ══════════════════════════════════════════════════════════════════════════ */

const buckets = new Map();

function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (b.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  return { ok: true };
}

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (now > v.resetAt) buckets.delete(k);
}, 60_000);
if (cleanup.unref) cleanup.unref();

function enforceRate(res, key, limit, windowMs) {
  const r = rateLimit(key, limit, windowMs);
  if (!r.ok) {
    res.set('Retry-After', String(r.retryAfter));
    return fail(res, 429, 'rate_limit',
      `Demasiados intentos. Esperá ${r.retryAfter} segundos.`);
  }
  return true;
}

/* ══════════════════════════════════════════════════════════════════════════
   4 · HELPERS
   ══════════════════════════════════════════════════════════════════════════ */

function fail(res, status, code, message, extra = {}) {
  return res.status(status).json({ ok: false, error: message, code, ...extra });
}

function normalizeCategory(cat) {
  if (!cat) return 'general';
  const c = String(cat).toLowerCase().trim().slice(0, MAX_CATEGORY);
  return VALID_CATEGORIES.has(c) ? c : 'general';
}

function sanitizeText(text) {
  if (typeof text !== 'string') return '';
  return text.trim().slice(0, MAX_TEXT);
}

function sanitizeTags(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const t of arr) {
    if (typeof t !== 'string') continue;
    const clean = t.toLowerCase().trim()
      .replace(/[^\w\s\-áéíóúñ]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, MAX_TAG_LEN);
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function autoTitle(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  if (t.length <= MAX_TITLE) return t;
  return t.slice(0, MAX_TITLE - 3).trimEnd() + '…';
}

/* ─── Trigramas para near-duplicate detection ─── */
function trigrams(str) {
  const s = '  ' + String(str).toLowerCase().replace(/[^\w\s]/g, '') + '  ';
  const set = new Set();
  for (let i = 0; i < s.length - 2; i++) {
    set.add(s.slice(i, i + 3));
  }
  return set;
}

/**
 * Similitud de Sørensen-Dice en trigramas.
 * 0 = nada parecido, 1 = idénticos.
 */
function similarity(a, b) {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let intersection = 0;
  for (const x of A) if (B.has(x)) intersection++;
  return (2 * intersection) / (A.size + B.size);
}

/**
 * Encuentra la memoria más parecida al texto dado.
 * Retorna { memory, score } o null si ninguna supera el threshold.
 */
function findNearDuplicate(text, memories, threshold = NEAR_DUP_THRESHOLD) {
  let best = null;
  for (const m of memories) {
    const score = similarity(text, m.text);
    if (score >= threshold && (!best || score > best.score)) {
      best = { memory: m, score };
    }
  }
  return best;
}

/* ─── Auto-tagging ─── */
function inferTags(text, explicitTags = []) {
  const tags = new Set(sanitizeTags(explicitTags));
  const t = String(text || '');
  for (const rule of AUTO_TAG_RULES) {
    if (rule.rx.test(t)) tags.add(rule.tag);
  }
  return Array.from(tags).slice(0, MAX_TAGS);
}

/* ─── Escape CSV/JSON para export ─── */
function toMarkdown(memories) {
  const lines = ['# Mis memorias de Numination', '', `> ${memories.length} memorias exportadas · ${new Date().toISOString()}`, ''];
  const byCat = {};
  for (const m of memories) {
    (byCat[m.category] ||= []).push(m);
  }
  for (const cat of Object.keys(byCat).sort()) {
    lines.push(`## ${cat}`);
    lines.push('');
    for (const m of byCat[cat]) {
      const pin = m.pinned ? '📌 ' : '';
      const tags = m.tags.length ? ` \`${m.tags.join('`, `')}\`` : '';
      lines.push(`- ${pin}**${m.title}**${tags}`);
      if (m.text !== m.title) lines.push(`  ${m.text}`);
      lines.push(`  _${new Date(m.created_at).toLocaleDateString('es-CO')}_`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

/* ══════════════════════════════════════════════════════════════════════════
   5 · MOUNT
   ══════════════════════════════════════════════════════════════════════════ */

export function mountMemoryRoutes(app, requireAuth) {

  /* ═════════════════════════════════════════════════════════════════════
     GET /api/memories · listar con filtros
     
     Query params:
       ?q=texto              → búsqueda con ranking
       ?category=academico   → filtra por categoría
       ?tags=a,b,c           → filtra por tags (OR)
       ?pinned=true          → solo pineadas
       ?minRelevance=7       → solo con relevance >= N
       ?sort=newest|oldest
       ?limit=100&offset=0
     ═════════════════════════════════════════════════════════════════════ */
  app.get('/api/memories', requireAuth, async (req, res) => {
    try {
      const { q, category, tags, pinned, minRelevance, sort, limit, offset } = req.query;

      const parsedTags = tags
        ? String(tags).split(',').map(t => t.trim().toLowerCase()).filter(Boolean)
        : null;

      let memories;

      if (q && String(q).trim()) {
        memories = await buscarMemories(req.user.id, String(q).trim(), {
          limit: Number(limit) || 50,
        });
      } else if (category || parsedTags || pinned !== undefined || minRelevance || sort || limit || offset) {
        memories = await listarMemoriesConFiltros(req.user.id, {
          category: category ? String(category) : null,
          tags: parsedTags,
          pinned: pinned === 'true' ? true : pinned === 'false' ? false : null,
          minRelevance: minRelevance ? Number(minRelevance) : null,
          sort: sort ? String(sort) : 'newest',
          limit: Number(limit) || 100,
          offset: Number(offset) || 0,
        });
      } else {
        memories = await listarMemories(req.user.id, { limit: 100 });
      }

      return res.json({ ok: true, memories, count: memories.length });
    } catch (e) {
      log('error', 'mem.list.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'list_failed', 'No pudimos cargar tus memorias.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     GET /api/memories/stats · números y tendencias
     ═════════════════════════════════════════════════════════════════════ */
  app.get('/api/memories/stats', requireAuth, async (req, res) => {
    try {
      const stats = await statsMemories(req.user.id);
      return res.json({ ok: true, ...stats });
    } catch (e) {
      log('error', 'mem.stats.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'stats_failed', 'No pudimos leer las estadísticas.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     GET /api/memories/tags · todos los tags con contador
     ═════════════════════════════════════════════════════════════════════ */
  app.get('/api/memories/tags', requireAuth, async (req, res) => {
    try {
      const tags = await listarTagsUnicos(req.user.id);
      return res.json({ ok: true, tags });
    } catch (e) {
      log('error', 'mem.tags.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'tags_failed', 'No pudimos leer los tags.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     GET /api/memories/timeline · agrupado por día
     
     ?days=30  (por defecto 30)
     ═════════════════════════════════════════════════════════════════════ */
  app.get('/api/memories/timeline', requireAuth, async (req, res) => {
    try {
      const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
      const since = Date.now() - days * 24 * 60 * 60 * 1000;

      const all = await listarTodasMemories(req.user.id);

      // Agrupar por día
      const byDay = {};
      for (const m of all) {
        const ts = new Date(m.created_at).getTime();
        if (ts < since) continue;
        const day = new Date(ts).toISOString().slice(0, 10);
        (byDay[day] ||= []).push(m);
      }

      // Ordenar descendente por día
      const timeline = Object.keys(byDay)
        .sort()
        .reverse()
        .map(day => ({
          day,
          count: byDay[day].length,
          memories: byDay[day],
        }));

      return res.json({ ok: true, days, timeline });
    } catch (e) {
      log('error', 'mem.timeline.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'timeline_failed', 'No pudimos leer la línea de tiempo.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     POST /api/memories · crear
     
     Body:
       {
         text: string (req, 3-500),
         category?: 'academico' | 'personal' | ...,
         tags?: string[],
         pinned?: boolean,
         relevance?: 1-10,
         source?: 'manual' | 'chat' | 'import',
         force?: boolean  ← ignora el chequeo de duplicado
       }
     
     Respuestas:
       201 { ok: true, memory, tagsAuto }
       409 { ok: false, code: 'duplicate', duplicate: true, similarTo: {...} }
     ═════════════════════════════════════════════════════════════════════ */
  app.post('/api/memories', requireAuth, async (req, res) => {
    if (!enforceRate(res, `mem-create:${req.user.id}`, 30, 60_000)) return;

    try {
      const text = sanitizeText(req.body?.text);

      if (!text) return fail(res, 400, 'empty_text', 'La memoria no puede estar vacía.');
      if (text.length < 3) return fail(res, 400, 'too_short', 'Muy corta (mínimo 3 caracteres).');

      const category = normalizeCategory(req.body?.category);
      const explicitTags = sanitizeTags(req.body?.tags || []);
      const tags = inferTags(text, explicitTags);
      const pinned = Boolean(req.body?.pinned);
      const relevance = Math.min(10, Math.max(1, Number(req.body?.relevance) || 5));
      const source = String(req.body?.source || 'manual').slice(0, 20);
      const force = Boolean(req.body?.force);

      // Chequeo de duplicado exacto (rápido, en DB)
      if (!force) {
        const exactDup = await contarMemoriaSimilar(req.user.id, text);
        if (exactDup > 0) {
          return fail(res, 409, 'duplicate', 'Ya tenés una memoria igual.', {
            duplicate: true,
            exact: true,
          });
        }
      }

      // Chequeo de near-duplicate (trigram, en memoria sobre últimas 50)
      if (!force) {
        const recent = await listarMemoriesConFiltros(req.user.id, { limit: 50, sort: 'newest' });
        const near = findNearDuplicate(text, recent);
        if (near) {
          return fail(res, 409, 'near_duplicate',
            `Muy parecida a "${near.memory.title}". ¿Guardar igual?`,
            {
              duplicate: true,
              exact: false,
              similarity: Math.round(near.score * 100) / 100,
              similarTo: {
                id: near.memory.id,
                title: near.memory.title,
                text: near.memory.text,
              },
            });
        }
      }

      // Crear
      const memory = await crearMemory(req.user.id, text);
      if (!memory) return fail(res, 500, 'create_failed', 'No pudimos guardar.');

      // Aplicar metadatos (categoría, tags, pin, relevance)
      let final = memory;
      try {
        final = await actualizarMemory(memory.id, req.user.id, {
          category,
          tags,
          pinned,
          relevance,
          source,
          title: autoTitle(req.body?.title || text),
        }) || memory;
      } catch (e) {
        log('warn', 'mem.post.update.fail', { message: e.message });
      }

      log('info', 'mem.create.ok', {
        userId: req.user.id,
        memoryId: final.id,
        category,
        tagCount: tags.length,
        pinned,
        nearDupChecked: !force,
      });

      return res.status(201).json({
        ok: true,
        memory: final,
        tagsAuto: tags.filter(t => !explicitTags.includes(t)),
      });
    } catch (e) {
      log('error', 'mem.create.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'create_failed', 'No pudimos guardar la memoria.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     POST /api/memories/bulk · operaciones en varias
     
     Body:
       {
         action: 'delete' | 'pin' | 'unpin' | 'addTags' | 'removeTags' |
                 'setCategory' | 'setRelevance',
         ids: string[],
         tags?: string[],
         category?: string,
         relevance?: number,
       }
     ═════════════════════════════════════════════════════════════════════ */
  app.post('/api/memories/bulk', requireAuth, async (req, res) => {
    if (!enforceRate(res, `mem-bulk:${req.user.id}`, 20, 60_000)) return;

    try {
      const { action, ids, tags, category, relevance } = req.body || {};

      if (!Array.isArray(ids) || ids.length === 0) {
        return fail(res, 400, 'no_ids', 'Necesitás mandar ids.');
      }
      if (ids.length > 100) {
        return fail(res, 400, 'too_many', 'Máximo 100 items por operación.');
      }

      let affected = 0;

      switch (action) {
        case 'delete':
          affected = await eliminarMemoriesBulk(req.user.id, ids);
          break;

        case 'pin':
        case 'unpin':
          affected = await actualizarMemoriesBulk(req.user.id, ids, {
            pinned: action === 'pin',
          });
          break;

        case 'addTags': {
          const cleanTags = sanitizeTags(tags || []);
          if (!cleanTags.length) return fail(res, 400, 'no_tags', 'Faltan tags.');
          affected = await actualizarMemoriesBulk(req.user.id, ids, { addTags: cleanTags });
          break;
        }

        case 'removeTags': {
          const cleanTags = sanitizeTags(tags || []);
          if (!cleanTags.length) return fail(res, 400, 'no_tags', 'Faltan tags.');
          affected = await actualizarMemoriesBulk(req.user.id, ids, { removeTags: cleanTags });
          break;
        }

        case 'setCategory':
          affected = await actualizarMemoriesBulk(req.user.id, ids, {
            category: normalizeCategory(category),
          });
          break;

        case 'setRelevance': {
          const r = Math.min(10, Math.max(1, Number(relevance) || 5));
          affected = await actualizarMemoriesBulk(req.user.id, ids, { relevance: r });
          break;
        }

        default:
          return fail(res, 400, 'invalid_action', `Acción desconocida: ${action}`);
      }

      log('info', 'mem.bulk.ok', {
        userId: req.user.id,
        action,
        count: ids.length,
        affected,
      });

      return res.json({ ok: true, action, requested: ids.length, affected });
    } catch (e) {
      log('error', 'mem.bulk.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'bulk_failed', 'No pudimos completar la operación.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     POST /api/memories/export
     
     Body: { format?: 'json' | 'markdown' | 'txt' }
     
     Devuelve el archivo como attachment.
     ═════════════════════════════════════════════════════════════════════ */
  app.post('/api/memories/export', requireAuth, async (req, res) => {
    if (!enforceRate(res, `mem-export:${req.user.id}`, 5, 60 * 60_000)) return;

    try {
      const format = ['json', 'markdown', 'md', 'txt'].includes(req.body?.format)
        ? req.body.format
        : 'json';

      const memories = await listarTodasMemories(req.user.id);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `numination-memorias-${date}`;

      let content, mimetype, ext;

      if (format === 'json') {
        content = JSON.stringify({
          exportedAt: new Date().toISOString(),
          count: memories.length,
          memories,
        }, null, 2);
        mimetype = 'application/json';
        ext = 'json';
      } else if (format === 'md' || format === 'markdown') {
        content = toMarkdown(memories);
        mimetype = 'text/markdown; charset=utf-8';
        ext = 'md';
      } else {
        content = memories.map(m => `${m.pinned ? '★ ' : ''}${m.text}\n`).join('\n');
        mimetype = 'text/plain; charset=utf-8';
        ext = 'txt';
      }

      res.set({
        'Content-Type': mimetype,
        'Content-Disposition': `attachment; filename="${filename}.${ext}"`,
      });

      log('info', 'mem.export.ok', {
        userId: req.user.id,
        format,
        count: memories.length,
      });

      return res.send(content);
    } catch (e) {
      log('error', 'mem.export.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'export_failed', 'No pudimos exportar.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     POST /api/memories/import
     
     Body: { memories: [...], replace?: boolean }
     
     Importa desde un JSON exportado previamente. Omite duplicados.
     ═════════════════════════════════════════════════════════════════════ */
  app.post('/api/memories/import', requireAuth, async (req, res) => {
    if (!enforceRate(res, `mem-import:${req.user.id}`, 3, 60 * 60_000)) return;

    try {
      const { memories, replace = false } = req.body || {};

      if (!Array.isArray(memories)) {
        return fail(res, 400, 'invalid_payload', 'El payload debe tener { memories: [...] }.');
      }
      if (memories.length > 500) {
        return fail(res, 400, 'too_many', 'Máximo 500 memorias por import.');
      }

      // Borrar todas primero si replace
      if (replace) {
        await eliminarTodasMemories(req.user.id);
      }

      const existing = await listarTodasMemories(req.user.id);
      const existingTexts = new Set(existing.map(m => m.text.toLowerCase().trim()));

      let imported = 0, skipped = 0, failed = 0;

      for (const raw of memories) {
        try {
          const text = sanitizeText(raw?.text);
          if (!text || text.length < 3) { skipped++; continue; }

          const key = text.toLowerCase().trim();
          if (existingTexts.has(key)) { skipped++; continue; }

          const memory = await crearMemory(req.user.id, text);
          if (!memory) { failed++; continue; }

          await actualizarMemory(memory.id, req.user.id, {
            title: raw.title || autoTitle(text),
            category: normalizeCategory(raw.category),
            tags: sanitizeTags(raw.tags || []),
            pinned: Boolean(raw.pinned),
            relevance: Math.min(10, Math.max(1, Number(raw.relevance) || 5)),
            source: 'import',
          });

          existingTexts.add(key);
          imported++;
        } catch {
          failed++;
        }
      }

      log('info', 'mem.import.ok', {
        userId: req.user.id,
        imported, skipped, failed, replace,
      });

      return res.json({ ok: true, imported, skipped, failed, replace });
    } catch (e) {
      log('error', 'mem.import.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'import_failed', 'No pudimos importar.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     POST /api/memories/:id/merge · fusionar con otra
     
     Body: { withId: string }
     
     Combina el texto de ambas, une tags, mantiene la de mayor relevance.
     Borra la otra.
     ═════════════════════════════════════════════════════════════════════ */
  app.post('/api/memories/:id/merge', requireAuth, async (req, res) => {
    if (!enforceRate(res, `mem-merge:${req.user.id}`, 10, 60_000)) return;

    try {
      const mainId = req.params.id;
      const otherId = req.body?.withId;

      if (!otherId || mainId === otherId) {
        return fail(res, 400, 'invalid_merge', 'Necesitás mandar withId distinto al principal.');
      }

      const main = await getMemory(mainId, req.user.id);
      const other = await getMemory(otherId, req.user.id);
      if (!main) return fail(res, 404, 'not_found', 'Memoria principal no encontrada.');
      if (!other) return fail(res, 404, 'not_found', 'Memoria a fusionar no encontrada.');

      // Fusionar
      const mergedText = main.text.includes(other.text)
        ? main.text
        : `${main.text}\n\n${other.text}`.slice(0, MAX_TEXT);

      const mergedTags = Array.from(new Set([...main.tags, ...other.tags])).slice(0, MAX_TAGS);

      const updated = await actualizarMemory(mainId, req.user.id, {
        text: mergedText,
        tags: mergedTags,
        pinned: main.pinned || other.pinned,
        relevance: Math.max(main.relevance, other.relevance),
        title: autoTitle(main.title || mergedText),
      });

      await eliminarMemory(otherId, req.user.id);

      log('info', 'mem.merge.ok', {
        userId: req.user.id,
        mainId, otherId,
      });

      return res.json({
        ok: true,
        memory: updated,
        mergedWith: { id: otherId, text: other.text },
      });
    } catch (e) {
      log('error', 'mem.merge.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'merge_failed', 'No pudimos fusionar.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     GET /api/memories/:id · una
     ═════════════════════════════════════════════════════════════════════ */
  app.get('/api/memories/:id', requireAuth, async (req, res) => {
    try {
      const memory = await getMemory(req.params.id, req.user.id);
      if (!memory) return fail(res, 404, 'not_found', 'Memoria no encontrada.');
      return res.json({ ok: true, memory });
    } catch (e) {
      log('error', 'mem.get.fail', { id: req.params.id, message: e.message });
      return fail(res, 500, 'get_failed', 'No pudimos cargar la memoria.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     GET /api/memories/:id/related · memorias que comparten tags
     ═════════════════════════════════════════════════════════════════════ */
  app.get('/api/memories/:id/related', requireAuth, async (req, res) => {
    try {
      const related = await listarMemoriasRelacionadas(req.user.id, req.params.id, {
        limit: Number(req.query.limit) || 5,
      });
      return res.json({ ok: true, related, count: related.length });
    } catch (e) {
      log('error', 'mem.related.fail', { id: req.params.id, message: e.message });
      return fail(res, 500, 'related_failed', 'No pudimos leer las relacionadas.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     PATCH /api/memories/:id · editar
     
     Body: { text?, title?, category?, tags?, pinned?, relevance?, source? }
     ═════════════════════════════════════════════════════════════════════ */
  app.patch('/api/memories/:id', requireAuth, async (req, res) => {
    try {
      const patch = {};

      if (req.body?.text != null) {
        const t = sanitizeText(req.body.text);
        if (t.length < 3) return fail(res, 400, 'too_short', 'Mínimo 3 caracteres.');
        patch.text = t;
      }
      if (req.body?.category != null) patch.category = normalizeCategory(req.body.category);
      if (Array.isArray(req.body?.tags)) patch.tags = sanitizeTags(req.body.tags);
      if (typeof req.body?.pinned === 'boolean') patch.pinned = req.body.pinned;
      if (Number.isFinite(req.body?.relevance)) {
        patch.relevance = Math.min(10, Math.max(1, Math.trunc(req.body.relevance)));
      }
      if (req.body?.title != null) {
        patch.title = String(req.body.title).trim().slice(0, MAX_TITLE) || null;
      }
      if (req.body?.source != null) patch.source = String(req.body.source).slice(0, 20);

      if (Object.keys(patch).length === 0) {
        return fail(res, 400, 'nothing_to_update', 'Nada que actualizar.');
      }

      const updated = await actualizarMemory(req.params.id, req.user.id, patch);
      if (!updated) return fail(res, 404, 'not_found', 'Memoria no encontrada.');

      return res.json({ ok: true, memory: updated });
    } catch (e) {
      log('error', 'mem.update.fail', { id: req.params.id, message: e.message });
      return fail(res, 500, 'update_failed', 'No pudimos actualizar la memoria.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     POST /api/memories/:id/pin · toggle
     ═════════════════════════════════════════════════════════════════════ */
  app.post('/api/memories/:id/pin', requireAuth, async (req, res) => {
    try {
      const result = await togglePinMemory(req.params.id, req.user.id);
      if (!result) return fail(res, 404, 'not_found', 'Memoria no encontrada.');
      return res.json({ ok: true, pinned: result.pinned });
    } catch (e) {
      log('error', 'mem.pin.fail', { id: req.params.id, message: e.message });
      return fail(res, 500, 'pin_failed', 'No pudimos cambiar el pin.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     POST /api/memories/:id/use · registrar uso
     
     Lo llama el backend cuando la IA lee esta memoria en un chat.
     Sirve para aprender cuáles memorias son las más útiles.
     ═════════════════════════════════════════════════════════════════════ */
  app.post('/api/memories/:id/use', requireAuth, async (req, res) => {
    try {
      const result = await registrarUsoMemory(req.params.id, req.user.id);
      if (!result) return fail(res, 404, 'not_found', 'Memoria no encontrada.');
      return res.json({ ok: true, ...result });
    } catch (e) {
      log('error', 'mem.use.fail', { id: req.params.id, message: e.message });
      return fail(res, 500, 'use_failed', 'No pudimos registrar el uso.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     DELETE /api/memories/:id
     ═════════════════════════════════════════════════════════════════════ */
  app.delete('/api/memories/:id', requireAuth, async (req, res) => {
    try {
      const ok = await eliminarMemory(req.params.id, req.user.id);
      if (!ok) return fail(res, 404, 'not_found', 'Memoria no encontrada.');

      log('info', 'mem.delete.ok', { userId: req.user.id, id: req.params.id });
      return res.json({ ok: true });
    } catch (e) {
      log('error', 'mem.delete.fail', { id: req.params.id, message: e.message });
      return fail(res, 500, 'delete_failed', 'No pudimos borrar la memoria.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     DELETE /api/memories · borrar todas
     ═════════════════════════════════════════════════════════════════════ */
  app.delete('/api/memories', requireAuth, async (req, res) => {
    if (!enforceRate(res, `mem-clear:${req.user.id}`, 3, 60 * 60_000)) return;

    try {
      const deleted = await eliminarTodasMemories(req.user.id);
      log('warn', 'mem.delete_all', { userId: req.user.id, deleted });
      return res.json({ ok: true, deleted });
    } catch (e) {
      log('error', 'mem.delete_all.fail', { userId: req.user.id, message: e.message });
      return fail(res, 500, 'delete_all_failed', 'No pudimos borrar las memorias.');
    }
  });

  /* ═════════════════════════════════════════════════════════════════════
     BOOT
     ═════════════════════════════════════════════════════════════════════ */
  console.log('[mem] rutas montadas · v3.0 · tags · near-dup · bulk · export · merge · timeline');
}