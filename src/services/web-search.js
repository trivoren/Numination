/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/web-search.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Búsqueda web en tiempo real para el chat.

   PROVEEDORES (en orden de preferencia)
     1 · Tavily      → TAVILY_API_KEY      (web + news, con respuesta IA)
     2 · Serper.dev  → SERPER_API_KEY      (Google SERP, muy preciso)
     3 · Respaldo    → Wikipedia + DuckDuckGo (services/websearch.js),
                       sin clave y sin costo.

   El respaldo importa: si nadie configura una clave de pago, la función
   de búsqueda sigue funcionando (con menos resultados) en vez de
   devolver un error.

   NORMALIZACIÓN
   Todos los proveedores devuelven la misma forma:
     { title, url, snippet, source, date, score, provider }
   así el chat, las citas y los tests no dependen del proveedor.

   CACHE
   Se cachea por query+idioma+proveedor durante 10 minutos. La búsqueda
   web es cara y las consultas repetidas son frecuentes.
   ═══════════════════════════════════════════════════════════════════════════ */

import { cache } from '../lib/cache.js';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  defaultMaxResults: 6,
  maxResults: 15,
  minQueryChars: 2,
  maxQueryChars: 300,
  timeoutMs: 9000,
  cacheTtlMs: 10 * 60_000,
  cachePrefix: 'wsearch:',
  tavilyUrl: 'https://api.tavily.com/search',
  tavilyModel: 'search',
  serperUrl: 'https://google.serper.dev/search',
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

/* Las claves pueden venir de .env.local o del archivo env.local.js
   (así lo carga el resto del proyecto). */
let FILE_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  FILE_KEYS = mod.TEST_KEYS ?? {};
} catch { /* archivo opcional */ }

function tavilyKey() {
  return process.env.TAVILY_API_KEY || FILE_KEYS.TAVILY_API_KEY || null;
}

function serperKey() {
  return process.env.SERPER_API_KEY || FILE_KEYS.SERPER_API_KEY || null;
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function normalizeQuery(query) {
  return String(query || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CFG.maxQueryChars);
}

/**
 * Quita los resultados de baja calidad: sin URL, duplicados o dominios
 * que no aportan (ej: el propio search).
 */
function dedupe(results) {
  const seen = new Set();
  const out = [];

  for (const r of results) {
    if (!r || !r.url) continue;
    const key = r.url.replace(/\/$/, '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }

  return out;
}

async function withTimeout(fn, timeoutMs = CFG.timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · TAVILY
   ═══════════════════════════════════════════════════════════════════════════ */

async function searchTavily(query, opts = {}) {
  const key = tavilyKey();
  if (!key) return null;

  const body = {
    query,
    search_depth: opts.depth || 'basic',
    max_results: Math.min(opts.maxResults || CFG.defaultMaxResults, CFG.maxResults),
    include_answer: opts.includeAnswer !== false,
    include_raw_content: false,
  };

  if (opts.days) body.days = opts.days;
  if (opts.topic) body.topic = opts.topic;

  const data = await withTimeout(async (signal) => {
    const res = await fetch(CFG.tavilyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Tavily ${res.status}: ${text.slice(0, 180)}`);
    }

    return res.json();
  }, opts.timeoutMs || CFG.timeoutMs);

  const results = (data?.results || []).map((r, i) => ({
    title: String(r?.title || '').slice(0, 220) || `Resultado ${i + 1}`,
    url: String(r?.url || ''),
    snippet: String(r?.content || r?.snippet || '').slice(0, 600),
    source: domainOf(r?.url),
    date: r?.published_date || null,
    score: Number(r?.score ?? 0),
    provider: 'tavily',
  }));

  return {
    ok: true,
    provider: 'tavily',
    answer: data?.answer ? String(data.answer).slice(0, 1200) : null,
    results,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · SERPER.DEV
   ═══════════════════════════════════════════════════════════════════════════ */

async function searchSerper(query, opts = {}) {
  const key = serperKey();
  if (!key) return null;

  const payload = {
    q: query,
    num: Math.min(opts.maxResults || CFG.defaultMaxResults, CFG.maxResults),
    gl: opts.country || 'co',
    hl: opts.language || 'es',
  };

  if (opts.days) payload.tbs = `qdr:${Math.min(opts.days, 30)}`;

  const data = await withTimeout(async (signal) => {
    const res = await fetch(CFG.serperUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': key,
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Serper ${res.status}: ${text.slice(0, 180)}`);
    }

    return res.json();
  }, opts.timeoutMs || CFG.timeoutMs);

  const organic = Array.isArray(data?.organic) ? data.organic : [];
  const news = Array.isArray(data?.news) ? data.news : [];

  const results = [
    ...organic.map((r) => ({
      title: String(r?.title || '').slice(0, 220),
      url: String(r?.url || ''),
      snippet: String(r?.snippet || '').slice(0, 600),
      source: domainOf(r?.url),
      date: r?.date || null,
      score: 1 - (Number(r?.position || 10) / 20),
      provider: 'serper',
    })),
    ...news.map((r) => ({
      title: String(r?.title || '').slice(0, 220),
      url: String(r?.link || r?.url || ''),
      snippet: String(r?.snippet || '').slice(0, 600),
      source: domainOf(r?.link || r?.url),
      date: r?.date || null,
      score: 0.7,
      provider: 'serper-news',
    })),
  ];

  return {
    ok: true,
    provider: 'serper',
    answer: data?.answerBox?.snippet ? String(data.answerBox.snippet).slice(0, 1200) : null,
    results,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · RESPALDO (Wikipedia + DuckDuckGo)
   ═══════════════════════════════════════════════════════════════════════════ */

async function searchFallback(query, opts = {}) {
  try {
    const mod = await import('./websearch.js');
    if (!mod || typeof mod.searchWeb !== 'function') return null;

    const raw = await mod.searchWeb(query, {
      maxResults: Math.min(opts.maxResults || CFG.defaultMaxResults, CFG.maxResults),
      language: opts.language || 'es',
      timeout: opts.timeoutMs || CFG.timeoutMs,
    });

    if (!Array.isArray(raw) || !raw.length) return null;

    const results = raw.map((r, i) => ({
      title: String(r?.title || r?.url || `Resultado ${i + 1}`).slice(0, 220),
      url: String(r?.url || ''),
      snippet: String(r?.snippet || r?.text || '').slice(0, 600),
      source: r?.source || domainOf(r?.url),
      date: null,
      score: 1 - (i / (raw.length + 1)),
      provider: 'wikipedia',
    }));

    return { ok: true, provider: 'wikipedia', answer: null, results };
  } catch (e) {
    LOG.warn('web-search: el proveedor de respaldo falló', { error: e.message });
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · API PÚBLICA
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Busca en la web.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.maxResults]
 * @param {string} [opts.language]  'es' | 'en'
 * @param {string} [opts.country]   'co' | 'us' …
 * @param {boolean}[opts.includeAnswer]
 * @param {boolean}[opts.noCache]
 * @returns {Promise<object>} { ok, provider, results, answer, cached, elapsedMs }
 */
export async function searchWeb(query, opts = {}) {
  const q = normalizeQuery(query);

  if (q.length < CFG.minQueryChars) {
    return { ok: false, error: 'La búsqueda es demasiado corta.', code: 'query_too_short', results: [] };
  }

  const maxResults = Math.max(1, Math.min(parseInt(opts.maxResults, 10) || CFG.defaultMaxResults, CFG.maxResults));
  const key = `${CFG.cachePrefix}${q.toLowerCase()}|${opts.language || 'es'}|${opts.country || 'co'}|${maxResults}`;

  if (!opts.noCache) {
    try {
      const hit = await cache.get(key);
      if (hit) {
        return { ...hit, cached: true };
      }
    } catch (e) {
      LOG.debug('web-search: cache no disponible', { error: e.message });
    }
  }

  const started = Date.now();
  const providers = [];

  if (tavilyKey()) providers.push({ name: 'tavily', run: () => searchTavily(q, { ...opts, maxResults }) });
  if (serperKey()) providers.push({ name: 'serper', run: () => searchSerper(q, { ...opts, maxResults }) });
  providers.push({ name: 'fallback', run: () => searchFallback(q, { ...opts, maxResults }) });

  let lastError = null;

  for (const provider of providers) {
    try {
      const result = await provider.run();
      if (!result || !Array.isArray(result.results) || !result.results.length) continue;

      const clean = dedupe(result.results).slice(0, maxResults);

      const payload = {
        ok: true,
        provider: result.provider,
        answer: result.answer || null,
        query: q,
        results: clean,
        elapsedMs: Date.now() - started,
      };

      if (!opts.noCache) {
        try {
          await cache.set(key, payload, CFG.cacheTtlMs);
        } catch (e) {
          LOG.debug('web-search: no se pudo guardar en cache', { error: e.message });
        }
      }

      return { ...payload, cached: false };
    } catch (e) {
      lastError = e;
      LOG.warn(`web-search: falló el proveedor ${provider.name}`, { error: e.message });
    }
  }

  return {
    ok: false,
    error: 'No se pudo completar la búsqueda.',
    code: 'search_unavailable',
    detail: lastError?.message || null,
    query: q,
    results: [],
    elapsedMs: Date.now() - started,
  };
}

/**
 * Formatea los resultados para inyectarlos en el prompt del modelo.
 */
export function formatResultsForAI(query, results) {
  if (!Array.isArray(results) || !results.length) return '';

  const lines = results.map((r, i) => {
    const snippet = String(r.snippet || '').replace(/\s+/g, ' ').slice(0, 420);
    return `[${i + 1}] ${r.title}\n    Fuente: ${r.source || r.url}\n    ${snippet}`;
  });

  return (
    `Resultados de búsqueda para "${query}":\n\n` +
    lines.join('\n\n') +
    '\n\nUsá la información anterior y citá las fuentes con su número [n] cuando corresponda.'
  );
}

/**
 * Convierte los resultados en el formato de "sources" que usa el chat.
 */
export function toSources(results) {
  if (!Array.isArray(results)) return [];
  return results.map((r, i) => ({
    title: r.title || `Fuente ${i + 1}`,
    url: r.url,
    snippet: String(r.snippet || '').slice(0, 260),
    source: r.source || domainOf(r.url),
    date: r.date || null,
    trust: r.score ?? null,
    position: i,
  }));
}

/**
 * Estado de los proveedores configurados.
 */
export function getSearchStatus() {
  return {
    providers: {
      tavily: Boolean(tavilyKey()),
      serper: Boolean(serperKey()),
      fallback: true,
    },
    defaultMaxResults: CFG.defaultMaxResults,
    maxResults: CFG.maxResults,
    cacheTtlMs: CFG.cacheTtlMs,
  };
}

export default {
  searchWeb,
  formatResultsForAI,
  toSources,
  getSearchStatus,
};
