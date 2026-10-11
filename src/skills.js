/* ═══════════════════════════════════════════════════════════════════════════
   src/skills.js  ·  BACKEND
   ───────────────────────────────────────────────────────────────────────────
   Sirve el archivo public/assets/js/skills.js como API JSON.
   
   Este archivo NO contiene las skills. Solo las lee del frontend y las
   expone por HTTP. Las 150+ skills reales están en:
       public/assets/js/skills.js
   ═══════════════════════════════════════════════════════════════════════════ */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_PATH = join(__dirname, '..', 'public', 'assets', 'js', 'skills.js');

let cache = null;
let cacheTime = 0;
const CACHE_TTL = 60_000;

/* ═══════════════════════════════════════════════════════════════════════════
   CARGAR Y PARSEAR
   ═══════════════════════════════════════════════════════════════════════════ */

async function loadSkills() {
  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL) return cache;

  try {
    const raw = await readFile(SKILLS_PATH, 'utf-8');

    // Extraer SKILLS
    const skillsMatch = raw.match(/var\s+SKILLS\s*=\s*(\[[\s\S]*?\n\s*\]);/);
    let skills = [];
    if (skillsMatch) {
      try {
        skills = Function('"use strict"; return (' + skillsMatch[1] + ');')();
      } catch (e) {
        console.warn('[skills] error parseando SKILLS:', e.message);
      }
    }

    // Extraer CATEGORIES
    const catsMatch = raw.match(/var\s+CATEGORIES\s*=\s*(\{[\s\S]*?\n\s*\});/);
    let categories = {};
    if (catsMatch) {
      try {
        categories = Function('"use strict"; return (' + catsMatch[1] + ');')();
      } catch {}
    }

    // Extraer ICONS
    const iconsMatch = raw.match(/var\s+ICONS\s*=\s*(\{[\s\S]*?\n\s*\});/);
    let icons = {};
    if (iconsMatch) {
      try {
        icons = Function('"use strict"; return (' + iconsMatch[1] + ');')();
      } catch {}
    }

    // Extraer PATHS
    const pathsMatch = raw.match(/var\s+PATHS\s*=\s*(\[[\s\S]*?\n\s*\]);/);
    let paths = [];
    if (pathsMatch) {
      try {
        paths = Function('"use strict"; return (' + pathsMatch[1] + ');')();
      } catch {}
    }

    // Extraer COMBOS
    const combosMatch = raw.match(/var\s+COMBOS\s*=\s*(\[[\s\S]*?\n\s*\]);/);
    let combos = [];
    if (combosMatch) {
      try {
        combos = Function('"use strict"; return (' + combosMatch[1] + ');')();
      } catch {}
    }

    // Extraer versión
    const verMatch = raw.match(/version:\s*['"]([^'"]+)['"]/);
    const version = verMatch ? verMatch[1] : '6.2.0';

    cache = {
      skills,
      categories,
      icons,
      paths,
      combos,
      version,
      count: skills.length,
      loadedAt: new Date().toISOString(),
    };
    cacheTime = now;
    return cache;
  } catch (e) {
    console.warn('[skills] no pude leer skills.js:', e.message);
    return { skills: [], categories: {}, icons: {}, paths: [], combos: [], version: '0', count: 0 };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   DETECCIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

function normalize(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function detectSkill(text, mode, skills) {
  const t = normalize(text);
  if (!t) return null;

  const candidates = mode ? skills.filter(s => (s.modes || []).includes(mode)) : skills;
  let best = null, bestScore = 0;

  for (const s of candidates) {
    let score = 0;
    for (const kw of (s.keywords || [])) {
      if (t.includes(normalize(kw))) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best ? { skill: best, score: bestScore } : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   MOUNT
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountSkillsRoutes(app, requireAuth) {

  /* GET /api/skills · lista completa (público) */
  app.get('/api/skills', async (_req, res) => {
    try {
      const data = await loadSkills();
      return res.json({
        ok: true,
        count: data.count,
        version: data.version,
        skills: data.skills,
        categories: data.categories,
        paths: data.paths,
        combos: data.combos,
      });
    } catch (e) {
      console.error('[skills] error:', e.message);
      return res.status(500).json({ ok: false, error: 'No pudimos cargar las skills.' });
    }
  });

  /* GET /api/skills/stats · estadísticas */
  app.get('/api/skills/stats', async (_req, res) => {
    try {
      const data = await loadSkills();
      const byCategory = {};
      const byMode = {};
      for (const s of data.skills) {
        byCategory[s.category] = (byCategory[s.category] || 0) + 1;
        for (const m of (s.modes || [])) byMode[m] = (byMode[m] || 0) + 1;
      }
      return res.json({
        ok: true,
        total: data.count,
        version: data.version,
        categories: Object.keys(data.categories).length,
        icons: Object.keys(data.icons).length,
        paths: data.paths.length,
        combos: data.combos.length,
        byCategory,
        byMode,
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* GET /api/skills/icons · mapa completo de iconos */
  app.get('/api/skills/icons', async (_req, res) => {
    try {
      const data = await loadSkills();
      return res.json({ ok: true, count: Object.keys(data.icons).length, icons: data.icons });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* GET /api/skills/paths · rutas de aprendizaje */
  app.get('/api/skills/paths', async (_req, res) => {
    try {
      const data = await loadSkills();
      return res.json({ ok: true, count: data.paths.length, paths: data.paths });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* GET /api/skills/combos · combinaciones sugeridas */
  app.get('/api/skills/combos', async (_req, res) => {
    try {
      const data = await loadSkills();
      return res.json({ ok: true, count: data.combos.length, combos: data.combos });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* POST /api/skills/detect · detecta skill por texto */
  app.post('/api/skills/detect', requireAuth, async (req, res) => {
    try {
      const { text, mode } = req.body || {};
      if (!text || typeof text !== 'string') {
        return res.status(400).json({ ok: false, error: 'Falta el texto.' });
      }
      const data = await loadSkills();
      const detected = detectSkill(text, mode, data.skills);
      if (!detected) return res.json({ ok: true, skill: null, score: 0 });
      return res.json({ ok: true, skill: detected.skill, score: detected.score });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* GET /api/skills/:id · una skill */
  app.get('/api/skills/:id', async (req, res) => {
    try {
      const data = await loadSkills();
      const skill = data.skills.find(s => s.id === req.params.id);
      if (!skill) return res.status(404).json({ ok: false, error: 'Skill no encontrada.' });
      return res.json({ ok: true, skill });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  console.log('[skills] rutas montadas · /api/skills · /api/skills/:id · /api/skills/detect');
}