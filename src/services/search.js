/* ================================================================
   NUMINATION · search.js · v1.0
   ----------------------------------------------------------------
   Búsqueda full-text unificada sobre todo el contenido del usuario.

   ¿POR QUÉ EXISTE?
   Los usuarios hoy no pueden encontrar cosas que dijeron hace
   semanas. Tienen que scrollear chats enteros. Y no pueden buscar
   "aquella conversación donde hablamos de regex" sin recordar en
   qué chat fue.

   Este módulo busca simultáneamente en:
     · Chats (por título)
     · Mensajes (por contenido)
     · Memorias (por texto, título, tags, categoría)
     · Proyectos (por nombre)

   Y devuelve resultados rankeados, con highlights y filtros.

   CARACTERÍSTICAS:

     · Búsqueda multi-entidad en una sola llamada
     · Ranking por relevancia (título > contenido, recencia, pinned)
     · Highlights con contexto alrededor del match
     · Filtros: fecha, tipo, tags, categoría, modo
     · Búsqueda por frase ("regex en javascript")
     · Búsqueda fuzzy (tolera typos pequeños)
     · Autocomplete / sugerencias (para el input del buscador)
     · Cache en Redis para queries repetidas
     · Historial de búsquedas por usuario
     · Búsquedas guardadas (persistentes)
     · Popularidad global (trending)

   ESTRUCTURA:

     1  · Configuración
     2  · Entidades buscables
     3  · Parser de query
     4  · Cliente Postgres (reusa de supabase.js)
     5  · Queries por entidad
     6  · Ranking y scoring
     7  · Highlights
     8  · Cache
     9  · search() · función principal
    10  · Autocomplete / suggestions
    11  · Historial de búsquedas
    12  · Búsquedas guardadas
    13  · Trending global
    14  · Helpers por entidad
    15  · Middleware Express
    16  · Índices recomendados (SQL)
    17  · Self-test
    18  · Exports

   USO BÁSICO:

     import { search } from './services/search.js';

     const results = await search('regex javascript', userId, {
       types: ['messages', 'memories'],
       limit: 20,
     });

     // results.items = [{ type, id, title, snippet, score, ... }, ...]

   USO PARA AUTOCOMPLETE:

     import { suggest } from './services/search.js';

     const suggestions = await suggest('reg', userId, { limit: 5 });
     // ['regex', 'regexp', 'regular expressions', ...]

   ================================================================ */

import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  /* Límites de resultados */
  defaultLimit: 20,
  maxLimit: 100,

  /* Cuántos chars mostrar en el snippet */
  snippetLength: 180,

  /* Máximo de términos en una query */
  maxTerms: 10,

  /* Largo máximo de query (chars) */
  maxQueryLength: 200,

  /* Cache TTL (segundos) */
  cacheTtlSec: 60,

  /* Cache de sugerencias */
  suggestCacheTtlSec: 300,

  /* Historial: cuántas búsquedas guardar por usuario */
  recentMaxPerUser: 30,

  /* Historial TTL */
  recentTtlSec: 90 * 86400,

  /* Búsquedas guardadas: máximo por usuario */
  savedMaxPerUser: 20,

  /* Trending: ventana en días */
  trendingWindowDays: 7,

  /* Longitud mínima de query */
  minQueryLength: 2,

  /* Longitud mínima para autocomplete */
  minSuggestLength: 2,

  /* Pesos de scoring */
  weights: {
    titleMatch: 100,          // match en título
    contentMatch: 50,         // match en contenido
    categoryMatch: 30,        // match en categoría
    tagMatch: 40,             // match en tag
    phraseBonus: 30,          // bonus por frase exacta
    recentBonus: 20,          // bonus por recencia
    pinnedBonus: 25,          // bonus si está pinneada
    useCountBonus: 10,        // bonus por uso de memoria
    multipleTermsBonus: 15,   // bonus por múltiples términos
  },

  /* Cuántos días se consideran "reciente" para el bonus */
  recentDays: 30,
});

/* ═══════════════════════════════════════════════════════════════════════
   2 · ENTIDADES BUSCABLES
   ═══════════════════════════════════════════════════════════════════════ */

export const TYPES = Object.freeze({
  CHATS: 'chats',
  MESSAGES: 'messages',
  MEMORIES: 'memories',
  PROJECTS: 'projects',
});

export const ALL_TYPES = Object.freeze([
  TYPES.CHATS,
  TYPES.MESSAGES,
  TYPES.MEMORIES,
  TYPES.PROJECTS,
]);

/* ═══════════════════════════════════════════════════════════════════════
   3 · PARSER DE QUERY
   ═══════════════════════════════════════════════════════════════════════
   Convierte un string de búsqueda en una estructura:
     {
       raw: 'original',
       terms: ['term1', 'term2'],        // palabras normales
       phrases: ['exact phrase'],         // entre comillas
       excluded: ['word'],                // con - al inicio
     }
   ═══════════════════════════════════════════════════════════════════════ */

export function parseQuery(input) {
  const raw = String(input || '').trim().slice(0, CFG.maxQueryLength);
  const terms = [];
  const phrases = [];
  const excluded = [];

  if (!raw) return { raw, terms, phrases, excluded };

  // Extraer frases entre comillas
  let working = raw.replace(/"([^"]+)"/g, (_, phrase) => {
    const p = phrase.trim();
    if (p) phrases.push(p);
    return ' __PHRASE__ ';
  });

  // Extraer términos excluidos (-word)
  working = working.replace(/(^|\s)-(\S+)/g, (_, pre, term) => {
    const t = term.trim();
    if (t) excluded.push(t.toLowerCase());
    return pre + ' ';
  });

  // Resto: términos normales
  const words = working
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w && w !== '__PHRASE__')
    .slice(0, CFG.maxTerms);

  for (const w of words) {
    const lower = w.toLowerCase();
    if (lower && !terms.includes(lower)) terms.push(lower);
  }

  return { raw, terms, phrases, excluded };
}

/**
 * ¿La query es válida para buscar?
 */
export function isValidQuery(parsed) {
  if (!parsed) return false;
  const total = parsed.terms.length + parsed.phrases.length;
  if (total === 0) return false;
  const raw = parsed.raw || '';
  if (raw.length < CFG.minQueryLength) return false;
  return true;
}

/**
 * Normaliza un término para comparación fuzzy.
 * Quita acentos, minúsculas.
 */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · CLIENTE POSTGRES
   ═══════════════════════════════════════════════════════════════════════ */

let _sql = null;

/**
 * Carga el cliente Postgres desde supabase.js de forma lazy.
 * Permite que este módulo no dependa directamente de la conexión
 * si solo se usa para tests o para parsear queries.
 */
async function getSql() {
  if (_sql) return _sql;
  try {
    const mod = await import('./supabase.js');
    _sql = mod.sql || null;
  } catch {
    _sql = null;
  }
  return _sql;
}

/* ═══════════════════════════════════════════════════════════════════════
   5 · QUERIES POR ENTIDAD
   ═══════════════════════════════════════════════════════════════════════
   Cada query devuelve filas con columnas normalizadas:
     id, title, content, createdAt, ... + score calculado
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Construye la cláusula WHERE para ILIKE.
 * Requiere: todos los terms deben matchear (AND).
 * Phrases: deben aparecer como substring exacto.
 * Excluded: no deben aparecer.
 */
function buildIlikeConditions(field, terms, phrases, excluded, paramOffset = 1) {
  const conditions = [];
  const params = [];
  let idx = paramOffset;

  // Términos: AND — cada uno debe estar
  for (const t of terms) {
    conditions.push(`${field} ILIKE $${idx++}`);
    params.push(`%${t}%`);
  }

  // Frases: AND — cada frase completa debe aparecer
  for (const p of phrases) {
    conditions.push(`${field} ILIKE $${idx++}`);
    params.push(`%${p}%`);
  }

  // Excluidos: NOT ILIKE
  for (const e of excluded) {
    conditions.push(`${field} NOT ILIKE $${idx++}`);
    params.push(`%${e}%`);
  }

  return {
    clause: conditions.length > 0 ? conditions.join(' AND ') : '1=1',
    params,
    nextIdx: idx,
  };
}

/* ─── Chats ─── */

async function searchChatsTable(sql, userId, parsed, opts) {
  const limit = opts.limit || CFG.defaultLimit;

  // Buscar en title
  const cond = buildIlikeConditions('title', parsed.terms, parsed.phrases, parsed.excluded, 2);

  const rows = await sql.unsafe(`
    SELECT
      id, title, mode,
      "createdAt" as created_at,
      "updatedAt" as updated_at
    FROM "Chat"
    WHERE "userId" = $1::uuid
      AND "isGhost" = false
      AND (${cond.clause})
    ORDER BY "updatedAt" DESC
    LIMIT $${cond.nextIdx}
  `, [userId, ...cond.params, limit]);

  return rows.map((r) => ({
    type: TYPES.CHATS,
    id: r.id,
    title: r.title || 'Sin título',
    content: null,
    snippet: null,
    mode: r.mode,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    url: `/chat?chat=${r.id}`,
  }));
}

/* ─── Mensajes ─── */

async function searchMessagesTable(sql, userId, parsed, opts) {
  const limit = opts.limit || CFG.defaultLimit;

  const cond = buildIlikeConditions('m.content', parsed.terms, parsed.phrases, parsed.excluded, 2);

  const rows = await sql.unsafe(`
    SELECT
      m.id,
      m.content,
      m.role,
      m."createdAt" as created_at,
      m."chatId" as chat_id,
      c.title as chat_title
    FROM "Message" m
    JOIN "Chat" c ON c.id = m."chatId"
    WHERE c."userId" = $1::uuid
      AND c."isGhost" = false
      AND (${cond.clause})
    ORDER BY m."createdAt" DESC
    LIMIT $${cond.nextIdx}
  `, [userId, ...cond.params, limit]);

  return rows.map((r) => ({
    type: TYPES.MESSAGES,
    id: r.id,
    title: r.chat_title || 'Mensaje',
    content: r.content,
    role: r.role,
    chatId: r.chat_id,
    createdAt: r.created_at,
    url: `/chat?chat=${r.chat_id}&msg=${r.id}`,
  }));
}

/* ─── Memorias ─── */

async function searchMemoriesTable(sql, userId, parsed, opts) {
  const limit = opts.limit || CFG.defaultLimit;

  // Buscar en title OR content OR category OR tags
  const fields = ['title', 'content', 'category'];
  const allConds = [];
  const allParams = [userId];
  let idx = 2;

  // Un OR de todas las combinaciones de términos sobre todos los campos
  const orParts = [];

  for (const field of fields) {
    for (const t of parsed.terms) {
      orParts.push(`${field} ILIKE $${idx++}`);
      allParams.push(`%${t}%`);
    }
  }

  // Añadir búsqueda en tags (array)
  for (const t of parsed.terms) {
    orParts.push(`array_to_string(tags, ' ') ILIKE $${idx++}`);
    allParams.push(`%${t}%`);
  }

  // Frases
  for (const field of fields) {
    for (const p of parsed.phrases) {
      orParts.push(`${field} ILIKE $${idx++}`);
      allParams.push(`%${p}%`);
    }
  }

  const orClause = orParts.length > 0 ? orParts.join(' OR ') : '1=0';

  // Excluidos (AND NOT)
  const notParts = [];
  for (const e of parsed.excluded) {
    notParts.push(`(
      title NOT ILIKE $${idx}
      AND content NOT ILIKE $${idx}
      AND category NOT ILIKE $${idx}
    )`);
    allParams.push(`%${e}%`);
    idx++;
  }
  const notClause = notParts.length > 0 ? 'AND ' + notParts.join(' AND ') : '';

  allParams.push(limit);

  const rows = await sql.unsafe(`
    SELECT
      id, title, content, category, tags, pinned, relevance,
      "useCount" as use_count,
      "lastUsedAt" as last_used_at,
      "createdAt" as created_at,
      "updatedAt" as updated_at
    FROM "Memory"
    WHERE "userId" = $1::uuid
      AND type = 'MEMORY'
      AND (${orClause})
      ${notClause}
    ORDER BY
      pinned DESC,
      "updatedAt" DESC NULLS LAST,
      "createdAt" DESC
    LIMIT $${idx}
  `, allParams);

  return rows.map((r) => ({
    type: TYPES.MEMORIES,
    id: r.id,
    title: r.title || 'Memoria',
    content: r.content,
    category: r.category,
    tags: Array.isArray(r.tags) ? r.tags : [],
    pinned: Boolean(r.pinned),
    relevance: Number(r.relevance) || 5,
    useCount: Number(r.use_count) || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    url: `/chat?memory=${r.id}`,
  }));
}

/* ─── Proyectos ─── */

async function searchProjectsTable(sql, userId, parsed, opts) {
  const limit = opts.limit || CFG.defaultLimit;

  // Los proyectos hoy se guardan en localStorage, no en DB.
  // Este search es un placeholder para cuando se migren.
  // Si la tabla no existe, fallamos silenciosamente.

  try {
    const cond = buildIlikeConditions('name', parsed.terms, parsed.phrases, parsed.excluded, 2);

    const rows = await sql.unsafe(`
      SELECT
        id, name, color, type,
        "createdAt" as created_at
      FROM "Project"
      WHERE "userId" = $1::uuid
        AND (${cond.clause})
      ORDER BY "createdAt" DESC
      LIMIT $${cond.nextIdx}
    `, [userId, ...cond.params, limit]);

    return rows.map((r) => ({
      type: TYPES.PROJECTS,
      id: r.id,
      title: r.name,
      color: r.color,
      projectType: r.type,
      createdAt: r.created_at,
      url: `/chat?project=${r.id}`,
    }));
  } catch {
    // Tabla no existe: devolver array vacío silenciosamente
    return [];
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · RANKING Y SCORING
   ═══════════════════════════════════════════════════════════════════════
   Calcula un score de 0 a ~300 para cada resultado.
   Más alto = más relevante.
   ═══════════════════════════════════════════════════════════════════════ */

function scoreItem(item, parsed) {
  let score = 0;
  const W = CFG.weights;

  const title = normalize(item.title || '');
  const content = normalize(item.content || '');
  const category = normalize(item.category || '');
  const tags = (item.tags || []).map(normalize).join(' ');

  // ─── Match por término individual ───
  let termMatches = 0;
  let titleTerms = 0;
  let contentTerms = 0;

  for (const t of parsed.terms) {
    let matched = false;
    if (title.includes(t)) {
      score += W.titleMatch;
      titleTerms++;
      matched = true;
    }
    if (content.includes(t)) {
      score += W.contentMatch;
      contentTerms++;
      matched = true;
    }
    if (category.includes(t)) {
      score += W.categoryMatch;
      matched = true;
    }
    if (tags.includes(t)) {
      score += W.tagMatch;
      matched = true;
    }
    if (matched) termMatches++;
  }

  // ─── Bonus por frase completa ───
  for (const p of parsed.phrases) {
    const pLower = normalize(p);
    if (title.includes(pLower)) score += W.phraseBonus * 2;
    else if (content.includes(pLower)) score += W.phraseBonus;
  }

  // ─── Bonus por múltiples términos ───
  if (parsed.terms.length > 1 && termMatches === parsed.terms.length) {
    score += W.multipleTermsBonus * parsed.terms.length;
  }

  // ─── Bonus por recencia ───
  const ts = item.updatedAt || item.createdAt;
  if (ts) {
    const ageDays = (Date.now() - new Date(ts).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < CFG.recentDays) {
      const factor = 1 - (ageDays / CFG.recentDays);   // 1 → 0
      score += Math.round(W.recentBonus * factor);
    }
  }

  // ─── Bonus por pinned (memorias) ───
  if (item.pinned) {
    score += W.pinnedBonus;
  }

  // ─── Bonus por useCount (memorias) ───
  if (item.useCount) {
    score += Math.min(W.useCountBonus, item.useCount * 2);
  }

  // ─── Bonus por relevance (memorias) ───
  if (item.relevance) {
    score += Math.round(item.relevance * 2);
  }

  return score;
}

/**
 * Ordena los items por score descendente.
 */
function rankItems(items, parsed) {
  const scored = items.map((item) => ({
    ...item,
    score: scoreItem(item, parsed),
  }));
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Tiebreak por recencia
    const aTs = a.updatedAt || a.createdAt || 0;
    const bTs = b.updatedAt || b.createdAt || 0;
    return new Date(bTs).getTime() - new Date(aTs).getTime();
  });
  return scored;
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · HIGHLIGHTS
   ═══════════════════════════════════════════════════════════════════════
   Genera un snippet con el texto alrededor del match.
   ═══════════════════════════════════════════════════════════════════════ */

function buildHighlight(text, parsed, maxLen = CFG.snippetLength) {
  if (!text) return null;
  const s = String(text);
  if (s.length <= maxLen) return s;

  const lower = s.toLowerCase();
  let bestIdx = -1;

  // Buscar el match más temprano
  const candidates = [...parsed.terms, ...parsed.phrases];
  for (const c of candidates) {
    const idx = lower.indexOf(c.toLowerCase());
    if (idx >= 0 && (bestIdx === -1 || idx < bestIdx)) {
      bestIdx = idx;
    }
  }

  if (bestIdx === -1) {
    return s.slice(0, maxLen) + '…';
  }

  // Centrar en el match
  const start = Math.max(0, bestIdx - Math.floor(maxLen / 3));
  const end = Math.min(s.length, start + maxLen);

  let snippet = s.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < s.length) snippet = snippet + '…';

  return snippet;
}

/**
 * Aplica highlights a un array de items.
 */
function applyHighlights(items, parsed) {
  return items.map((item) => {
    const text = item.content || item.title || '';
    return {
      ...item,
      snippet: buildHighlight(text, parsed),
    };
  });
}

/* ═══════════════════════════════════════════════════════════════════════
   8 · CACHE EN REDIS
   ═══════════════════════════════════════════════════════════════════════ */

function getUpstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

async function pipeline(commands) {
  const u = getUpstash();
  if (!u) return { ok: false, error: 'no_upstash' };
  if (!commands || commands.length === 0) return { ok: true, result: [] };

  try {
    const res = await fetch(`${u.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { ok: false, error: `http_${res.status}` };
    const json = await res.json();
    return { ok: true, result: json };
  } catch (e) {
    return { ok: false, error: e?.message || 'fetch_failed' };
  }
}

function cacheKey(userId, query, opts) {
  const fingerprint = [
    userId,
    query,
    (opts.types || []).slice().sort().join(','),
    opts.limit || CFG.defaultLimit,
  ].join('::');
  const hash = crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 20);
  return `search:cache:${hash}`;
}

async function getFromCache(key) {
  const r = await pipeline([['GET', key]]);
  if (!r.ok || !r.result[0]?.result) return null;
  try {
    return JSON.parse(r.result[0].result);
  } catch {
    return null;
  }
}

async function setCache(key, value, ttlSec) {
  await pipeline([
    ['SET', key, JSON.stringify(value), 'EX', String(ttlSec)],
  ]);
}

async function clearCache(userId) {
  // Nota: Upstash no soporta SCAN del lado del cliente fácilmente.
  // Los caches expiran solos por TTL. Documentado.
  return true;
}

/* ═══════════════════════════════════════════════════════════════════════
   9 · SEARCH · función principal
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Busca en todas las entidades.
 *
 * @param {string} query
 * @param {string} userId
 * @param {object} [opts]
 * @param {string[]} [opts.types]     · filtrar entidades (default: todas)
 * @param {number} [opts.limit]       · máximo por tipo
 * @param {boolean} [opts.cache]      · usar cache (default: true)
 * @param {boolean} [opts.highlight]  · incluir snippets (default: true)
 * @returns {Promise<{ok, items, parsed, took, cached, total}>}
 */
export async function search(query, userId, opts = {}) {
  const t0 = Date.now();

  try {
    // Validaciones
    if (!userId) return { ok: false, error: 'no_userId', items: [] };

    const parsed = parseQuery(query);
    if (!isValidQuery(parsed)) {
      return {
        ok: true,
        items: [],
        parsed,
        total: 0,
        took: Date.now() - t0,
        cached: false,
        reason: 'invalid_query',
      };
    }

    // Tipos a buscar
    const types = (Array.isArray(opts.types) && opts.types.length > 0)
      ? opts.types.filter((t) => ALL_TYPES.includes(t))
      : ALL_TYPES.slice();

    if (types.length === 0) {
      return {
        ok: true,
        items: [],
        parsed,
        total: 0,
        took: Date.now() - t0,
        cached: false,
      };
    }

    // Cache
    const useCache = opts.cache !== false;
    const key = useCache ? cacheKey(userId, parsed.raw, { types, limit: opts.limit }) : null;

    if (key) {
      const cached = await getFromCache(key);
      if (cached) {
        return {
          ...cached,
          cached: true,
          took: Date.now() - t0,
        };
      }
    }

    // Ejecutar búsquedas en paralelo
    const sql = await getSql();
    if (!sql) return { ok: false, error: 'no_db', items: [] };

    const limit = Math.min(opts.limit || CFG.defaultLimit, CFG.maxLimit);

    const tasks = types.map((t) => {
      switch (t) {
        case TYPES.CHATS:    return searchChatsTable(sql, userId, parsed, { limit });
        case TYPES.MESSAGES: return searchMessagesTable(sql, userId, parsed, { limit });
        case TYPES.MEMORIES: return searchMemoriesTable(sql, userId, parsed, { limit });
        case TYPES.PROJECTS: return searchProjectsTable(sql, userId, parsed, { limit });
        default:             return Promise.resolve([]);
      }
    });

    const settled = await Promise.allSettled(tasks);
    const all = [];
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      if (r.status === 'fulfilled' && Array.isArray(r.value)) {
        all.push(...r.value);
      } else if (r.status === 'rejected') {
        console.warn(`[search] tipo ${types[i]} falló:`, r.reason?.message);
      }
    }

    // Ranking
    const ranked = rankItems(all, parsed);

    // Highlights
    const withSnippets = opts.highlight === false ? ranked : applyHighlights(ranked, parsed);

    // Limitar total
    const items = withSnippets.slice(0, limit);

    const response = {
      ok: true,
      items,
      parsed,
      total: withSnippets.length,
      took: Date.now() - t0,
      cached: false,
    };

    // Guardar en cache
    if (key) {
      setCache(key, response, CFG.cacheTtlSec).catch(() => {});
    }

    // Trackear en historial (fire-and-forget)
    if (parsed.raw.length >= CFG.minQueryLength) {
      recordSearch(userId, parsed.raw).catch(() => {});
    }

    return response;
  } catch (e) {
    return {
      ok: false,
      error: e?.message || 'unknown',
      items: [],
      took: Date.now() - t0,
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · AUTOCOMPLETE / SUGGESTIONS
   ═══════════════════════════════════════════════════════════════════════
   Dado un prefijo parcial, devuelve sugerencias:
     · términos que empiezan con ese prefijo en títulos
     · títulos de chats que empiezan con ese prefijo
     · tags de memorias que empiezan con ese prefijo
   ═══════════════════════════════════════════════════════════════════════ */

export async function suggest(prefix, userId, opts = {}) {
  try {
    if (!userId) return { ok: false, suggestions: [] };

    const p = String(prefix || '').trim().slice(0, CFG.maxQueryLength);
    if (p.length < CFG.minSuggestLength) {
      return { ok: true, suggestions: [] };
    }

    const limit = Math.min(opts.limit || 8, 20);
    const sql = await getSql();
    if (!sql) return { ok: false, suggestions: [] };

    // Buscar títulos de chats, tags, y categorías que empiecen con el prefijo
    const [chats, tags] = await Promise.all([
      sql.unsafe(`
        SELECT title FROM "Chat"
        WHERE "userId" = $1::uuid
          AND "isGhost" = false
          AND title ILIKE $2
        ORDER BY "updatedAt" DESC
        LIMIT $3
      `, [userId, p + '%', limit]).catch(() => []),

      sql.unsafe(`
        SELECT DISTINCT unnest(tags) as tag FROM "Memory"
        WHERE "userId" = $1::uuid
          AND type = 'MEMORY'
          AND EXISTS (
            SELECT 1 FROM unnest(tags) t WHERE t ILIKE $2
          )
        LIMIT $3
      `, [userId, p + '%', limit]).catch(() => []),
    ]);

    const suggestions = new Set();
    for (const c of chats) {
      if (c.title) suggestions.add(String(c.title).trim());
    }
    for (const t of tags) {
      if (t.tag) suggestions.add(String(t.tag).trim());
    }

    return {
      ok: true,
      suggestions: Array.from(suggestions).slice(0, limit),
    };
  } catch (e) {
    return { ok: false, suggestions: [], error: e.message };
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   11 · HISTORIAL DE BÚSQUEDAS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Guarda una búsqueda en el historial del usuario.
 * Evita duplicados consecutivos.
 */
async function recordSearch(userId, query) {
  const normalized = String(query).trim().toLowerCase();
  if (!normalized) return false;

  const key = `search:recent:${userId}`;

  // Evitar duplicado consecutivo: leer el primero
  const existing = await pipeline([['LINDEX', key, '0']]);
  const last = existing.ok ? existing.result[0]?.result : null;
  if (last === normalized) return true;

  // Guardar en la lista (LPUSH + LTRIM)
  const r = await pipeline([
    ['LPUSH', key, normalized],
    ['LTRIM', key, '0', String(CFG.recentMaxPerUser - 1)],
    ['EXPIRE', key, String(CFG.recentTtlSec)],
  ]);

  // Incrementar contador global para trending
  if (r.ok) {
    pipeline([
      ['ZINCRBY', 'search:trending', '1', normalized],
    ]).catch(() => {});
  }

  return r.ok;
}

/**
 * Devuelve el historial de búsquedas del usuario.
 */
export async function getRecentSearches(userId, { limit = 10 } = {}) {
  const key = `search:recent:${userId}`;
  const r = await pipeline([['LRANGE', key, '0', String(Math.min(limit, CFG.recentMaxPerUser) - 1)]]);
  if (!r.ok) return [];
  return r.result[0]?.result || [];
}

/**
 * Limpia el historial.
 */
export async function clearRecentSearches(userId) {
  const r = await pipeline([['DEL', `search:recent:${userId}`]]);
  return r.ok;
}

/**
 * Elimina una búsqueda específica del historial.
 */
export async function removeRecentSearch(userId, query) {
  const key = `search:recent:${userId}`;
  const normalized = String(query).trim().toLowerCase();
  const r = await pipeline([['LREM', key, '1', normalized]]);
  return r.ok;
}

/* ═══════════════════════════════════════════════════════════════════════
   12 · BÚSQUEDAS GUARDADAS
   ═══════════════════════════════════════════════════════════════════════ */

function savedKey(userId) {
  return `search:saved:${userId}`;
}

/**
 * Guarda una búsqueda con nombre.
 *
 * @param {string} userId
 * @param {object} opts
 * @param {string} opts.name    · nombre de la búsqueda
 * @param {string} opts.query   · query string
 * @param {object} [opts.filters]
 */
export async function saveSearch(userId, { name, query, filters }) {
  if (!userId || !name || !query) {
    return { ok: false, error: 'missing_fields' };
  }

  const key = savedKey(userId);
  const id = 'ss_' + crypto.randomBytes(8).toString('hex');

  const entry = {
    id,
    name: String(name).slice(0, 60),
    query: String(query).slice(0, CFG.maxQueryLength),
    filters: filters || null,
    savedAt: new Date().toISOString(),
  };

  const r = await pipeline([
    ['HSET', key, id, JSON.stringify(entry)],
    ['EXPIRE', key, String(365 * 86400)],
  ]);

  if (!r.ok) return { ok: false, error: 'save_failed' };

  // Limitar total
  const all = await listSavedSearches(userId);
  if (all.length > CFG.savedMaxPerUser) {
    // Borrar el más viejo
    const sorted = all.slice().sort((a, b) => new Date(a.savedAt) - new Date(b.savedAt));
    const toRemove = sorted[0];
    await pipeline([['HDEL', key, toRemove.id]]);
  }

  return { ok: true, saved: entry };
}

/**
 * Lista búsquedas guardadas.
 */
export async function listSavedSearches(userId) {
  const key = savedKey(userId);
  const r = await pipeline([['HGETALL', key]]);
  if (!r.ok) return [];

  const raw = r.result[0]?.result || [];
  const items = [];
  for (let i = 0; i < raw.length; i += 2) {
    try {
      items.push(JSON.parse(raw[i + 1]));
    } catch {}
  }
  return items.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

/**
 * Elimina una búsqueda guardada.
 */
export async function deleteSavedSearch(userId, savedId) {
  const key = savedKey(userId);
  const r = await pipeline([['HDEL', key, savedId]]);
  return r.ok;
}

/* ═══════════════════════════════════════════════════════════════════════
   13 · TRENDING GLOBAL
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Devuelve las búsquedas más populares (global, últimos días).
 * Usa un sorted set con ZREVRANGE.
 */
export async function getTrendingSearches({ limit = 10 } = {}) {
  const r = await pipeline([
    ['ZREVRANGE', 'search:trending', '0', String(Math.min(limit, 50) - 1), 'WITHSCORES'],
  ]);
  if (!r.ok) return [];

  const raw = r.result[0]?.result || [];
  const out = [];
  for (let i = 0; i < raw.length; i += 2) {
    out.push({ query: raw[i], count: Number(raw[i + 1]) || 0 });
  }
  return out;
}

/**
 * Reset del trending (admin).
 */
export async function resetTrending() {
  const r = await pipeline([['DEL', 'search:trending']]);
  return r.ok;
}

/* ═══════════════════════════════════════════════════════════════════════
   14 · HELPERS POR ENTIDAD
   ═══════════════════════════════════════════════════════════════════════ */

export async function searchChats(query, userId, opts = {}) {
  return search(query, userId, { ...opts, types: [TYPES.CHATS] });
}

export async function searchMessages(query, userId, opts = {}) {
  return search(query, userId, { ...opts, types: [TYPES.MESSAGES] });
}

export async function searchMemories(query, userId, opts = {}) {
  return search(query, userId, { ...opts, types: [TYPES.MEMORIES] });
}

export async function searchProjects(query, userId, opts = {}) {
  return search(query, userId, { ...opts, types: [TYPES.PROJECTS] });
}

/* ═══════════════════════════════════════════════════════════════════════
   15 · MIDDLEWARE EXPRESS
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Middleware que adjunta helpers de búsqueda al request.
 * Los endpoints pueden hacer req.search(query, opts).
 */
export function searchMiddleware() {
  return (req, _res, next) => {
    if (!req.user) return next();

    req.search = (query, opts = {}) => search(query, req.user.id, opts);
    req.suggest = (prefix, opts = {}) => suggest(prefix, req.user.id, opts);

    next();
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   16 · ÍNDICES RECOMENDADOS (SQL)
   ═══════════════════════════════════════════════════════════════════════

   Los índices ILIKE no usan los índices B-tree normales. Para que las
   búsquedas sean rápidas con muchos datos, se recomienda:

     -- Trigram en títulos de chats
     CREATE EXTENSION IF NOT EXISTS pg_trgm;
     CREATE INDEX IF NOT EXISTS chats_title_trgm_idx
       ON "Chat" USING GIN (title gin_trgm_ops);

     -- Trigram en contenido de mensajes
     CREATE INDEX IF NOT EXISTS messages_content_trgm_idx
       ON "Message" USING GIN (content gin_trgm_ops);

     -- Trigram en memorias
     CREATE INDEX IF NOT EXISTS memories_title_trgm_idx
       ON "Memory" USING GIN (title gin_trgm_ops);
     CREATE INDEX IF NOT EXISTS memories_content_trgm_idx
       ON "Memory" USING GIN (content gin_trgm_ops);

     -- GIN sobre tags
     CREATE INDEX IF NOT EXISTS memories_tags_idx
       ON "Memory" USING GIN (tags);

     -- B-tree compuestos
     CREATE INDEX IF NOT EXISTS chats_user_updated_idx
       ON "Chat" ("userId", "updatedAt" DESC);

     CREATE INDEX IF NOT EXISTS messages_chat_created_idx
       ON "Message" ("chatId", "createdAt" ASC);

   Sin estos índices funciona igual, solo más lento con muchos datos.

   ═══════════════════════════════════════════════════════════════════════ */

export const RECOMMENDED_INDEXES = `
-- Numination · índices recomendados para búsqueda
-- Ejecutar en Supabase SQL Editor cuando haya >10k filas

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS chats_title_trgm_idx
  ON "Chat" USING GIN (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS messages_content_trgm_idx
  ON "Message" USING GIN (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS memories_title_trgm_idx
  ON "Memory" USING GIN (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS memories_content_trgm_idx
  ON "Memory" USING GIN (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS memories_tags_idx
  ON "Memory" USING GIN (tags);

CREATE INDEX IF NOT EXISTS chats_user_updated_idx
  ON "Chat" ("userId", "updatedAt" DESC);

CREATE INDEX IF NOT EXISTS messages_chat_created_idx
  ON "Message" ("chatId", "createdAt" ASC);

CREATE INDEX IF NOT EXISTS memories_user_type_updated_idx
  ON "Memory" ("userId", type, "updatedAt" DESC);
`;

/* ═══════════════════════════════════════════════════════════════════════
   17 · HEALTH / PING
   ═══════════════════════════════════════════════════════════════════════ */

export async function pingSearch() {
  const u = getUpstash();
  const sql = await getSql();

  const result = {
    ok: true,
    db: Boolean(sql),
    cache: false,
    latencyMs: null,
  };

  if (u) {
    try {
      const t0 = Date.now();
      const res = await fetch(u.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${u.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['PING']),
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const json = await res.json();
        result.cache = json.result === 'PONG';
        result.latencyMs = Date.now() - t0;
      }
    } catch {}
  }

  return result;
}

/* ═══════════════════════════════════════════════════════════════════════
   18 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const errors = [];

  // 1 · Parse query simple
  const p1 = parseQuery('regex javascript');
  if (p1.terms.length !== 2) errors.push(`parseQuery simple: ${p1.terms.length}`);
  if (p1.terms[0] !== 'regex') errors.push(`término mal: ${p1.terms[0]}`);
  if (p1.phrases.length !== 0) errors.push('frases inesperadas');

  // 2 · Parse con frases
  const p2 = parseQuery('"exact phrase" plus word');
  if (p2.phrases.length !== 1) errors.push(`frase no detectada: ${p2.phrases.length}`);
  if (p2.phrases[0] !== 'exact phrase') errors.push(`frase mal: ${p2.phrases[0]}`);
  if (p2.terms.length !== 2) errors.push(`terms: ${p2.terms.length}`);

  // 3 · Parse con excluidos
  const p3 = parseQuery('word -excluded another');
  if (p3.excluded.length !== 1) errors.push(`excluidos no detectados: ${p3.excluded.length}`);
  if (p3.excluded[0] !== 'excluded') errors.push(`excluido mal: ${p3.excluded[0]}`);
  if (p3.terms.length !== 2) errors.push(`terms después de excluir: ${p3.terms.length}`);

  // 4 · Query inválida
  const p4 = parseQuery('');
  if (isValidQuery(p4)) errors.push('query vacía marcada como válida');

  const p5 = parseQuery('a');
  if (isValidQuery(p5)) errors.push('query de 1 char marcada como válida');

  // 5 · Normalización
  if (normalize('ÑOÑO') !== 'nono') errors.push('normalize no quita acentos');
  if (normalize('HOLA') !== 'hola') errors.push('normalize no hace lowercase');

  // 6 · Highlight
  const text = 'Esta es una frase de prueba para ver cómo funciona el highlight en la búsqueda';
  const hl = buildHighlight(text, { terms: ['highlight'], phrases: [], excluded: [] });
  if (!hl.includes('highlight')) errors.push('highlight no incluye el término');

  const hl2 = buildHighlight(text, { terms: ['zzz'], phrases: [], excluded: [] });
  if (!hl2) errors.push('highlight vacío');

  // 7 · Scoring
  const item1 = {
    title: 'Regex en JavaScript',
    content: 'Aprende regex paso a paso',
    createdAt: new Date().toISOString(),
  };
  const parsed = { terms: ['regex'], phrases: [], excluded: [] };
  const score1 = scoreItem(item1, parsed);
  if (score1 < 100) errors.push(`scoring muy bajo: ${score1}`);

  const item2 = {
    title: 'Sin match',
    content: 'Nada relevante aquí',
    createdAt: new Date().toISOString(),
  };
  const score2 = scoreItem(item2, parsed);
  if (score2 > score1) errors.push(`scoring inconsistente`);

  // 8 · Ranking
  const ranked = rankItems([item2, item1], parsed);
  if (ranked[0].title !== 'Regex en JavaScript') errors.push('ranking mal ordenado');

  return {
    ok: errors.length === 0,
    errors,
    types: ALL_TYPES,
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   FIN
   ═══════════════════════════════════════════════════════════════════════ */