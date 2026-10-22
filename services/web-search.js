/* ═══════════════════════════════════════════════════════════════════════
   NUMINATION · services/web-search.js · v1.0
   ───────────────────────────────────────────────────────────────────────
   Búsqueda web con Tavily, con caché de 10 minutos.

   POR QUÉ LA CACHÉ
     La misma consulta (múltiples reintentos del chat, recargas de la
     UI) no debería volver a pagar la búsqueda. 10 minutos es un
     equilibrio razonable entre frescura y coste.

   CONTRATO
     webSearch(query, options) → [{ title, url, snippet }]
     clearSearchCache()        → void
     getSearchCacheStats()     → { size, ttlMs }
   ═══════════════════════════════════════════════════════════════════════ */

import { LOG } from '../src/lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  url: 'https://api.tavily.com/search',
  timeoutMs: 20_000,
  cacheTtlMs: 10 * 60 * 1000,   // 10 minutos
  cacheMax: 200,
  defaultMaxResults: 5,
  maxResults: 20,
  maxSnippetLength: 400,
});

const cache = new Map(); // key → { results, at }

/* ═══════════════════════════════════════════════════════════════════════
   02 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Normaliza la consulta para la clave de caché y para la API.
 * @param {string} query
 * @returns {string}
 */
export function normalizeQuery(query) {
  return String(query ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Recorta el snippet a una longitud razonable.
 * @param {string} content
 * @returns {string}
 */
function toSnippet(content) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= CFG.maxSnippetLength) return text;
  return `${text.slice(0, CFG.maxSnippetLength).trimEnd()}…`;
}

function cacheKey(query, options) {
  return [
    normalizeQuery(query),
    options.maxResults,
    options.searchDepth,
    options.topic,
    options.includeAnswer ? '1' : '0',
  ].join('|');
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CFG.cacheTtlMs) {
    cache.delete(key);
    return null;
  }
  return hit.results;
}

function cacheSet(key, results) {
  if (cache.size >= CFG.cacheMax) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { results, at: Date.now() });
}

/** Vacía la caché de búsquedas. */
export function clearSearchCache() {
  cache.clear();
}

/** Estadísticas de la caché. */
export function getSearchCacheStats() {
  return { size: cache.size, ttlMs: CFG.cacheTtlMs, max: CFG.cacheMax };
}

/* ═══════════════════════════════════════════════════════════════════════
   03 · TAVILY
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Consulta a Tavily.
 * @param {string} query
 * @param {object} options
 * @returns {Promise<Array<{title:string, url:string, snippet:string}>>}
 */
async function callTavily(query, options, fetchImpl) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    const error = new Error('TAVILY_API_KEY no configurada.');
    error.code = 'NO_TAVILY_KEY';
    throw error;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.timeoutMs);

  try {
    const res = await fetchImpl(CFG.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: options.maxResults,
        search_depth: options.searchDepth,
        topic: options.topic,
        include_answer: Boolean(options.includeAnswer),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const error = new Error(`Tavily ${res.status}: ${body.slice(0, 200)}`);
      error.status = res.status;
      throw error;
    }

    const data = await res.json();
    const items = Array.isArray(data?.results) ? data.results : [];

    return items
      .filter((item) => item && item.url)
      .slice(0, options.maxResults)
      .map((item) => ({
        title: String(item.title ?? item.url).trim(),
        url: String(item.url).trim(),
        snippet: toSnippet(item.content ?? item.snippet ?? ''),
      }));
  } catch (e) {
    if (!e.status && e.name === 'AbortError') e.status = 408;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   04 · API
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Busca en la web.
 *
 * @param {string} query
 * @param {object} [options]
 * @param {number}  [options.maxResults]   Máximo de resultados (5).
 * @param {string}  [options.searchDepth]  'basic' | 'advanced'.
 * @param {string}  [options.topic]        'general' | 'news' | 'finance'.
 * @param {boolean} [options.includeAnswer]
 * @param {boolean} [options.useCache]
 * @param {Function}[options.fetchImpl]
 * @returns {Promise<Array<{title:string, url:string, snippet:string}>>}
 */
export async function webSearch(query, options = {}) {
  const cleanQuery = String(query ?? '').trim();
  if (!cleanQuery) return [];

  const settings = {
    maxResults: Math.min(
      CFG.maxResults,
      Math.max(1, Number(options.maxResults) || CFG.defaultMaxResults)
    ),
    searchDepth: options.searchDepth === 'advanced' ? 'advanced' : 'basic',
    topic: options.topic || 'general',
    includeAnswer: Boolean(options.includeAnswer),
  };

  const useCache = options.useCache !== false;
  const key = cacheKey(cleanQuery, settings);

  if (useCache) {
    const cached = cacheGet(key);
    if (cached) {
      LOG.info('web-search: caché', { query: cleanQuery.slice(0, 60), results: cached.length });
      return cached;
    }
  }

  const fetchImpl = options.fetchImpl || globalThis.fetch;

  try {
    const results = await callTavily(cleanQuery, settings, fetchImpl);
    if (useCache) cacheSet(key, results);
    return results;
  } catch (e) {
    LOG.warn('web-search: la búsqueda falló', { error: e.message, status: e.status || 0 });
    return [];
  }
}

/**
 * Igual que `webSearch` pero devuelve también la respuesta resumida
 * de Tavily cuando el motor la ofrece.
 *
 * @param {string} query
 * @param {object} [options]
 * @returns {Promise<{results:Array, answer:string|null}>}
 */
export async function webSearchWithAnswer(query, options = {}) {
  const results = await webSearch(query, { ...options, includeAnswer: true });
  return { results, answer: null };
}

export default {
  webSearch,
  webSearchWithAnswer,
  clearSearchCache,
  getSearchCacheStats,
  normalizeQuery,
};
