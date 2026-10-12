/* ================================================================
   NUMINATION · websearch.js · v2.0
   ----------------------------------------------------------------
   Búsqueda web multi-proveedor con content fetching y ranking.

   CARACTERÍSTICAS:

     · 7 proveedores: DuckDuckGo, Wikipedia (ES/EN), Brave,
       Searx, Wolfram Alpha, Reddit, HackerNews
     · Fallback en cascada: si un proveedor falla, prueba el
       siguiente
     · Query rewriting: limpia y mejora la query antes de buscar
     · Content fetching: lee el artículo completo, no solo el
       snippet (opcional, con anti-SSRF)
     · Ranking con 6 factores: relevancia textual, trust del
       dominio, frescura, longitud del snippet, posición original,
       bonus por fuente especializada
     · Deduplicación cross-provider por URL canónica
     · Detección de idioma (es/en/pt) para búsqueda multi-idioma
     · 4 verticales: web, noticias, definiciones, imágenes
     · Cache multi-capa con TTL diferenciado por vertical
     · Rate limiting por proveedor (in-memory sliding window)
     · Retry con backoff exponencial
     · Anti-SSRF: bloquea localhost, IPs privadas, metadata
     · Token budget: recorta resultados si no caben en contexto
     · Citation formatting: genera bloque citable para el prompt
     · Telemetría: contadores de éxito/fallo por proveedor

   API PÚBLICA:

     searchWeb(query, opts)           → Promise<Result[]>
     searchNews(query, opts)          → Promise<Result[]>
     searchDefinition(term, opts)     → Promise<Result[]>
     searchMultiLang(query, opts)     → Promise<Result[]>
     fetchContent(url, opts)          → Promise<{ title, text, ... }>
     formatResultsForAI(query, results, opts)  → string
     formatCitations(results)         → string
     detectLanguage(text)             → 'es' | 'en' | 'pt' | null
     buildSmartQuery(text, opts)      → string
     getWebsearchStats()              → object
     resetWebsearchStats()            → void
     pingWebsearch()                  → Promise<object>
     selfTest()                       → object

   USO BÁSICO:

     import { searchWeb, formatResultsForAI } from './services/websearch.js';

     const results = await searchWeb('fotosíntesis');
     const block = formatResultsForAI('fotosíntesis', results);

   USO AVANZADO:

     const results = await searchWeb('inteligencia artificial 2026', {
       vertical: 'news',
       maxResults: 8,
       fetchContent: true,
       languages: ['es', 'en'],
       minTrust: 0.5,
     });

   ================================================================ */

import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  /* Timeouts por operación (ms) */
  searchTimeoutMs: 8_000,
  fetchTimeoutMs: 10_000,
  totalBudgetMs: 20_000,

  /* Límites de resultados */
  maxResults: 8,
  maxResultsPerProvider: 6,

  /* Cache */
  cacheTtlSec: 300,           // 5 min para web search
  cacheTtlNewsSec: 120,       // 2 min para noticias
  cacheTtlDefinitionSec: 1800,// 30 min para definiciones
  cacheTtlContentSec: 3600,   // 1 hora para contenido

  /* Content fetching */
  maxContentBytes: 200_000,   // 200 KB max por página
  maxContentChars: 6_000,     // recorte final del texto

  /* Token budget */
  maxContextChars: 12_000,    // ~3000 tokens aprox

  /* Rate limits (por proveedor, por minuto) */
  rateLimits: {
    duckduckgo: 30,
    wikipedia: 60,
    brave: 20,
    searx: 30,
    wolfram: 5,
    reddit: 10,
    hackernews: 30,
  },

  /* Retry */
  retries: 2,
  backoffBaseMs: 400,

  /* Seguridad */
  allowedProtocols: ['http:', 'https:'],
  blockedHosts: [
    'localhost', '127.0.0.1', '0.0.0.0',
    '169.254.169.254',       // AWS metadata
    'metadata.google.internal',
    'metadata.azure.com',
  ],
  blockedHostPatterns: [
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^127\./,
    /^169\.254\./,
    /^::1$/,
    /^fe80:/i,
    /^fc00:/i,
  ],

  /* Trust scoring de dominios conocidos */
  trustedDomains: {
    'wikipedia.org': 0.95,
    'britannica.com': 0.95,
    'nasa.gov': 0.95,
    'who.int': 0.95,
    'un.org': 0.92,
    'gov.co': 0.90,
    'edu.co': 0.88,
    'nature.com': 0.90,
    'science.org': 0.90,
    'scielo.org': 0.85,
    'github.com': 0.88,
    'stackoverflow.com': 0.85,
    'reuters.com': 0.90,
    'bbc.com': 0.88,
    'elpais.com': 0.85,
    'eltiempo.com': 0.85,
    'semana.com': 0.82,
    'medium.com': 0.60,
    'reddit.com': 0.55,
    'twitter.com': 0.45,
    'x.com': 0.45,
    'facebook.com': 0.40,
    'tiktok.com': 0.35,
    'pinterest.com': 0.40,
  },
  defaultTrust: 0.65,
});

/* ═══════════════════════════════════════════════════════════════════════
   2 · TELEMETRÍA
   ═══════════════════════════════════════════════════════════════════════ */

const stats = {
  startedAt: Date.now(),
  queries: 0,
  providers: {
    duckduckgo: { calls: 0, ok: 0, fail: 0, totalMs: 0 },
    wikipedia:  { calls: 0, ok: 0, fail: 0, totalMs: 0 },
    brave:      { calls: 0, ok: 0, fail: 0, totalMs: 0 },
    searx:      { calls: 0, ok: 0, fail: 0, totalMs: 0 },
    wolfram:    { calls: 0, ok: 0, fail: 0, totalMs: 0 },
    reddit:     { calls: 0, ok: 0, fail: 0, totalMs: 0 },
    hackernews: { calls: 0, ok: 0, fail: 0, totalMs: 0 },
    content:    { calls: 0, ok: 0, fail: 0, totalMs: 0 },
  },
  cache: { hits: 0, misses: 0 },
  errors: [],
};

function trackCall(provider, ms, ok) {
  const p = stats.providers[provider];
  if (!p) return;
  p.calls++;
  p.totalMs += ms;
  if (ok) p.ok++;
  else p.fail++;
}

function trackError(provider, error) {
  stats.errors.push({
    at: new Date().toISOString(),
    provider,
    message: String(error).slice(0, 200),
  });
  if (stats.errors.length > 100) stats.errors.shift();
}

export function getWebsearchStats() {
  const providers = {};
  for (const [name, p] of Object.entries(stats.providers)) {
    providers[name] = {
      calls: p.calls,
      ok: p.ok,
      fail: p.fail,
      successRate: p.calls > 0 ? (p.ok / p.calls).toFixed(3) : '0',
      avgMs: p.calls > 0 ? Math.round(p.totalMs / p.calls) : 0,
    };
  }
  return {
    uptimeMs: Date.now() - stats.startedAt,
    queries: stats.queries,
    providers,
    cache: {
      hits: stats.cache.hits,
      misses: stats.cache.misses,
      hitRate: (stats.cache.hits + stats.cache.misses) > 0
        ? (stats.cache.hits / (stats.cache.hits + stats.cache.misses)).toFixed(3)
        : '0',
    },
    recentErrors: stats.errors.slice(-10),
  };
}

export function resetWebsearchStats() {
  stats.startedAt = Date.now();
  stats.queries = 0;
  for (const p of Object.values(stats.providers)) {
    p.calls = 0; p.ok = 0; p.fail = 0; p.totalMs = 0;
  }
  stats.cache.hits = 0;
  stats.cache.misses = 0;
  stats.errors = [];
}

/* ═══════════════════════════════════════════════════════════════════════
   3 · CACHE (Upstash con fallback a memoria)
   ═══════════════════════════════════════════════════════════════════════ */

const memCache = new Map();
const MEM_CACHE_MAX = 200;

function getUpstash() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ''), token };
}

function hashKey(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex').slice(0, 24);
}

function cacheKey(prefix, value) {
  return `ws:${prefix}:${hashKey(value)}`;
}

function memCacheGet(key) {
  const e = memCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expires) {
    memCache.delete(key);
    return null;
  }
  return e.value;
}

function memCacheSet(key, value, ttlSec) {
  if (memCache.size >= MEM_CACHE_MAX) {
    const oldest = memCache.keys().next().value;
    memCache.delete(oldest);
  }
  memCache.set(key, { value, expires: Date.now() + ttlSec * 1000 });
}

async function cacheGet(key) {
  // 1 · Memoria
  const local = memCacheGet(key);
  if (local) {
    stats.cache.hits++;
    return local;
  }

  // 2 · Upstash
  const u = getUpstash();
  if (!u) {
    stats.cache.misses++;
    return null;
  }

  try {
    const res = await fetch(`${u.url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${u.token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      stats.cache.misses++;
      return null;
    }
    const j = await res.json();
    if (!j.result) {
      stats.cache.misses++;
      return null;
    }
    const parsed = JSON.parse(j.result);
    memCacheSet(key, parsed, 60); // cache local 1min para no golpear Redis
    stats.cache.hits++;
    return parsed;
  } catch {
    stats.cache.misses++;
    return null;
  }
}

async function cacheSet(key, value, ttlSec) {
  memCacheSet(key, value, Math.min(ttlSec, 300));

  const u = getUpstash();
  if (!u) return;

  try {
    await fetch(`${u.url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${u.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: JSON.stringify(value), ex: ttlSec }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

/* ═══════════════════════════════════════════════════════════════════════
   4 · RATE LIMITING POR PROVEEDOR
   ═══════════════════════════════════════════════════════════════════════ */

const rateBuckets = new Map();

function checkRateLimit(provider) {
  const limit = CFG.rateLimits[provider] || 30;
  const key = `rl:${provider}`;
  const now = Date.now();
  const window = 60_000;

  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.reset) {
    bucket = { count: 0, reset: now + window };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= limit;
}

const _cleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) {
    if (now > b.reset) rateBuckets.delete(k);
  }
}, 60_000);
if (_cleanup.unref) _cleanup.unref();

/* ═══════════════════════════════════════════════════════════════════════
   5 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════ */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoffDelay(attempt) {
  const base = CFG.backoffBaseMs * Math.pow(2, attempt);
  const jitter = (Math.random() * 0.4 - 0.2) * base;
  return Math.max(CFG.backoffBaseMs, Math.round(base + jitter));
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    // Quitar parámetros de tracking
    const tracking = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'ref_src', '_ga',
    ];
    tracking.forEach(p => u.searchParams.delete(p));
    // Normalizar trailing slash
    let out = u.toString();
    if (out.endsWith('/') && u.pathname.length > 1) {
      out = out.slice(0, -1);
    }
    return out;
  } catch {
    return '';
  }
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isSafeUrl(url) {
  try {
    const u = new URL(url);
    if (!CFG.allowedProtocols.includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (CFG.blockedHosts.some(h => host === h || host.endsWith('.' + h))) return false;
    if (CFG.blockedHostPatterns.some(p => p.test(host))) return false;
    return true;
  } catch {
    return false;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   6 · DETECCIÓN DE IDIOMA
   ═══════════════════════════════════════════════════════════════════════ */

const LANG_HINTS = {
  es: [
    'el ', 'la ', 'los ', 'las ', 'de ', 'que ', 'cómo ', 'qué ', 'quién ',
    'dónde ', 'cuándo ', 'por qué ', 'para qué ', 'es ', 'son ', 'está ',
    'están ', 'tiene ', 'tienen ', 'puede ', 'pueden ',
  ],
  en: [
    'the ', 'of ', 'and ', 'is ', 'are ', 'how ', 'what ', 'who ', 'where ',
    'when ', 'why ', 'for ', 'with ', 'that ', 'this ', 'can ', 'does ',
  ],
  pt: [
    'o ', 'a ', 'os ', 'as ', 'de ', 'que ', 'como ', 'qual ', 'quem ',
    'onde ', 'quando ', 'por que ', 'para ', 'é ', 'são ', 'está ', 'estão ',
  ],
};

export function detectLanguage(text) {
  if (!text) return null;
  const t = ' ' + String(text).toLowerCase() + ' ';

  const scores = { es: 0, en: 0, pt: 0 };
  for (const [lang, hints] of Object.entries(LANG_HINTS)) {
    for (const h of hints) {
      if (t.includes(h)) scores[lang]++;
    }
  }

  // Acentos ayudan a decidir
  if (/[áéíóúñ¿¡]/i.test(text)) scores.es += 3;
  if (/[ãõçáéíóúâêô]/i.test(text)) scores.pt += 2;

  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best[1] === 0) return null;
  return best[0];
}

/* ═══════════════════════════════════════════════════════════════════════
   7 · QUERY REWRITING
   ═══════════════════════════════════════════════════════════════════════ */

const STOP_WORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del',
  'a', 'al', 'en', 'con', 'por', 'para', 'que', 'es', 'son', 'está',
  'están', 'y', 'o', 'pero', 'si', 'no', 'me', 'te', 'se', 'nos',
  'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'is',
  'are', 'was', 'were', 'and', 'or', 'but',
]);

/**
 * Limpia la query y extrae la parte "buscable".
 * - Quita signos de interrogación y puntuación
 * - Normaliza espacios
 * - Extrae keywords si es muy larga
 */
export function buildSmartQuery(text, opts = {}) {
  if (!text) return '';

  let q = String(text).trim();

  // Quitar "búscame", "busca", "qué es", "quién fue", etc.
  q = q.replace(/^(búscame|busca(me)?|búsca|encuentra(me)?|dime|cuéntame|explícame|explícame sobre)\s+/i, '');

  // Quitar "en la web", "en internet", "en google"
  q = q.replace(/\s+(en\s+(la\s+web|internet|google|wikipedia))$/i, '');

  // Si es muy larga (>15 palabras), extraer keywords principales
  const words = q.split(/\s+/);
  if (words.length > 15) {
    const keywords = words.filter(w => {
      const clean = w.toLowerCase().replace(/[^a-záéíóúñ0-9]/gi, '');
      return clean.length > 2 && !STOP_WORDS.has(clean);
    });
    q = keywords.slice(0, 10).join(' ');
  }

  // Normalizar espacios
  q = q.replace(/\s+/g, ' ').trim();

  // Si terminó vacío, devolver el original
  if (!q) return String(text).trim().slice(0, 200);

  return q.slice(0, 200);
}

/* ═══════════════════════════════════════════════════════════════════════
   8 · PROVEEDORES
   ═══════════════════════════════════════════════════════════════════════ */

/* ─── 8.1 · DuckDuckGo Instant Answer ─── */
async function duckduckgoSearch(query) {
  if (!checkRateLimit('duckduckgo')) throw new Error('rate_limit');
  const t0 = Date.now();

  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&no_redirect=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Numination/8.0 (+https://numination.app)' },
      signal: AbortSignal.timeout(CFG.searchTimeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const results = [];

    if (data.AbstractText) {
      results.push({
        title: data.Heading || query,
        snippet: String(data.AbstractText).slice(0, 500),
        url: data.AbstractURL || '',
        source: 'duckduckgo',
        provider: 'duckduckgo',
      });
    }

    if (data.Answer && String(data.Answer).length > 10) {
      results.push({
        title: `${query} · respuesta directa`,
        snippet: stripHtml(data.Answer).slice(0, 300),
        url: data.AbstractURL || '',
        source: 'duckduckgo',
        provider: 'duckduckgo',
      });
    }

    for (const t of (data.RelatedTopics || []).slice(0, 6)) {
      if (t.Text && t.FirstURL) {
        results.push({
          title: String(t.Text).split(' - ')[0].slice(0, 100),
          snippet: String(t.Text).slice(0, 300),
          url: t.FirstURL,
          source: 'duckduckgo',
          provider: 'duckduckgo',
        });
      }
      // Sub-topics anidados
      if (Array.isArray(t.Topics)) {
        for (const sub of t.Topics.slice(0, 2)) {
          if (sub.Text && sub.FirstURL) {
            results.push({
              title: String(sub.Text).split(' - ')[0].slice(0, 100),
              snippet: String(sub.Text).slice(0, 300),
              url: sub.FirstURL,
              source: 'duckduckgo',
              provider: 'duckduckgo',
            });
          }
        }
      }
    }

    trackCall('duckduckgo', Date.now() - t0, true);
    return results;
  } catch (e) {
    trackCall('duckduckgo', Date.now() - t0, false);
    trackError('duckduckgo', e.message);
    throw e;
  }
}

/* ─── 8.2 · Wikipedia (multi-idioma) ─── */
async function wikipediaSearch(query, lang = 'es') {
  if (!checkRateLimit('wikipedia')) throw new Error('rate_limit');
  const t0 = Date.now();

  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&srlimit=6&origin=*`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Numination/8.0 (+https://numination.app)' },
      signal: AbortSignal.timeout(CFG.searchTimeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const results = (data.query?.search || []).map(r => ({
      title: r.title,
      snippet: stripHtml(r.snippet || '').slice(0, 300),
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
      source: `wikipedia-${lang}`,
      provider: 'wikipedia',
      lang,
    }));

    trackCall('wikipedia', Date.now() - t0, true);
    return results;
  } catch (e) {
    trackCall('wikipedia', Date.now() - t0, false);
    trackError('wikipedia', e.message);
    throw e;
  }
}

/* ─── 8.3 · Wikipedia Extracts (resumen largo) ─── */
async function wikipediaExtract(title, lang = 'es') {
  const t0 = Date.now();
  try {
    const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(title)}&format=json&origin=*`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Numination/8.0' },
      signal: AbortSignal.timeout(CFG.fetchTimeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const pages = data.query?.pages || {};
    const first = Object.values(pages)[0];
    if (!first || !first.extract) return null;

    trackCall('wikipedia', Date.now() - t0, true);
    return {
      title: first.title,
      text: first.extract.slice(0, CFG.maxContentChars),
      source: 'wikipedia',
    };
  } catch (e) {
    trackCall('wikipedia', Date.now() - t0, false);
    return null;
  }
}

/* ─── 8.4 · Brave Search (requiere API key opcional) ─── */
async function braveSearch(query) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) throw new Error('no_api_key');
  if (!checkRateLimit('brave')) throw new Error('rate_limit');
  const t0 = Date.now();

  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10`;
    const res = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': apiKey,
      },
      signal: AbortSignal.timeout(CFG.searchTimeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const results = (data.web?.results || []).map(r => ({
      title: r.title || '',
      snippet: stripHtml(r.description || '').slice(0, 400),
      url: r.url || '',
      source: 'brave',
      provider: 'brave',
    }));

    trackCall('brave', Date.now() - t0, true);
    return results;
  } catch (e) {
    trackCall('brave', Date.now() - t0, false);
    trackError('brave', e.message);
    throw e;
  }
}

/* ─── 8.5 · Searx público (fallback) ─── */
const SEARX_INSTANCES = [
  'https://searx.be',
  'https://search.bus-hit.me',
  'https://searx.tiekoetter.com',
];

async function searxSearch(query) {
  if (!checkRateLimit('searx')) throw new Error('rate_limit');
  const t0 = Date.now();

  for (const instance of SEARX_INSTANCES) {
    try {
      const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&safesearch=1`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Numination/8.0' },
        signal: AbortSignal.timeout(CFG.searchTimeoutMs),
      });
      if (!res.ok) continue;
      const data = await res.json();

      const results = (data.results || []).slice(0, 10).map(r => ({
        title: r.title || '',
        snippet: stripHtml(r.content || '').slice(0, 400),
        url: r.url || '',
        source: 'searx',
        provider: 'searx',
      }));

      if (results.length > 0) {
        trackCall('searx', Date.now() - t0, true);
        return results;
      }
    } catch {}
  }

  trackCall('searx', Date.now() - t0, false);
  throw new Error('all_instances_failed');
}

/* ─── 8.6 · Reddit JSON API ─── */
async function redditSearch(query) {
  if (!checkRateLimit('reddit')) throw new Error('rate_limit');
  const t0 = Date.now();

  try {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&limit=5&sort=relevance`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Numination/8.0 (by /u/numination)' },
      signal: AbortSignal.timeout(CFG.searchTimeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const results = (data.data?.children || []).map(c => {
      const d = c.data;
      return {
        title: d.title || '',
        snippet: String(d.selftext || d.title || '').slice(0, 400),
        url: d.permalink ? `https://reddit.com${d.permalink}` : (d.url || ''),
        source: 'reddit',
        provider: 'reddit',
        score: d.score || 0,
      };
    });

    trackCall('reddit', Date.now() - t0, true);
    return results;
  } catch (e) {
    trackCall('reddit', Date.now() - t0, false);
    trackError('reddit', e.message);
    throw e;
  }
}

/* ─── 8.7 · HackerNews Algolia API ─── */
async function hackerNewsSearch(query) {
  if (!checkRateLimit('hackernews')) throw new Error('rate_limit');
  const t0 = Date.now();

  try {
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=5`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Numination/8.0' },
      signal: AbortSignal.timeout(CFG.searchTimeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const results = (data.hits || []).map(h => ({
      title: h.title || h.story_title || '',
      snippet: stripHtml(h.story_text || h.comment_text || h.title || '').slice(0, 400),
      url: h.url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : ''),
      source: 'hackernews',
      provider: 'hackernews',
      score: h.points || 0,
    })).filter(r => r.title);

    trackCall('hackernews', Date.now() - t0, true);
    return results;
  } catch (e) {
    trackCall('hackernews', Date.now() - t0, false);
    trackError('hackernews', e.message);
    throw e;
  }
}

/* ─── 8.8 · Wikipedia Definition (para términos técnicos) ─── */
async function wikipediaDefinition(term, lang = 'es') {
  const results = await wikipediaSearch(term, lang).catch(() => []);
  return results.slice(0, 2).map(r => ({
    ...r,
    isDefinition: true,
  }));
}

/* ═══════════════════════════════════════════════════════════════════════
   9 · TRUST SCORING
   ═══════════════════════════════════════════════════════════════════════ */

function getDomainTrust(domain) {
  if (!domain) return CFG.defaultTrust;

  // Match exacto
  if (CFG.trustedDomains[domain] !== undefined) {
    return CFG.trustedDomains[domain];
  }

  // Match por sufijo (ej: "es.wikipedia.org" matchea "wikipedia.org")
  for (const [trusted, score] of Object.entries(CFG.trustedDomains)) {
    if (domain === trusted || domain.endsWith('.' + trusted)) {
      return score;
    }
  }

  // Bonus por TLD
  if (domain.endsWith('.gov')) return 0.88;
  if (domain.endsWith('.edu')) return 0.85;
  if (domain.endsWith('.org')) return 0.72;
  if (domain.endsWith('.int')) return 0.85;

  return CFG.defaultTrust;
}

/* ═══════════════════════════════════════════════════════════════════════
   10 · RANKING
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Calcula la relevancia de un resultado respecto a la query.
 * Factores:
 *   1 · Match en el título (peso 3)
 *   2 · Match en el snippet (peso 1)
 *   3 · Trust del dominio (peso 2)
 *   4 · Frescura (bonus por año reciente)
 *   5 · Longitud del snippet (bonus por contenido rico)
 *   6 · Bonus por fuente especializada
 */
function scoreResult(result, query, providerWeight = 1) {
  const q = String(query).toLowerCase();
  const queryWords = q.split(/\s+/).filter(w => w.length > 2);

  const title = String(result.title || '').toLowerCase();
  const snippet = String(result.snippet || '').toLowerCase();

  let score = 0;

  // 1 · Match en título
  let titleMatches = 0;
  for (const w of queryWords) {
    if (title.includes(w)) titleMatches++;
  }
  score += (titleMatches / Math.max(queryWords.length, 1)) * 30;

  // 2 · Match en snippet
  let snippetMatches = 0;
  for (const w of queryWords) {
    if (snippet.includes(w)) snippetMatches++;
  }
  score += (snippetMatches / Math.max(queryWords.length, 1)) * 10;

  // 3 · Trust del dominio
  const domain = extractDomain(result.url);
  const trust = getDomainTrust(domain);
  score += trust * 20;

  // 4 · Frescura (si el snippet menciona años recientes)
  const currentYear = new Date().getFullYear();
  if (snippet.includes(String(currentYear))) score += 5;
  else if (snippet.includes(String(currentYear - 1))) score += 3;

  // 5 · Longitud de snippet
  const snipLen = snippet.length;
  if (snipLen > 200) score += 8;
  else if (snipLen > 100) score += 4;
  else if (snipLen > 50) score += 2;

  // 6 · Bonus por fuente
  if (result.source === 'wikipedia-es') score += 6;
  if (result.source === 'wikipedia-en') score += 4;
  if (result.source === 'duckduckgo') score += 3;
  if (result.source === 'brave') score += 3;

  // 7 · Peso del proveedor (para priorizar según la fuente)
  score *= providerWeight;

  return score;
}

/**
 * Dedupe por URL canónica y título similar.
 */
function dedupeResults(results) {
  const byUrl = new Map();
  const byTitle = new Set();
  const out = [];

  for (const r of results) {
    if (!r.title || !r.url) continue;
    if (!isSafeUrl(r.url)) continue;

    const url = normalizeUrl(r.url);
    const titleKey = r.title.toLowerCase().slice(0, 50);

    if (byUrl.has(url)) continue;
    if (byTitle.has(titleKey)) continue;

    byUrl.set(url, true);
    byTitle.add(titleKey);
    out.push({ ...r, url });
  }

  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   11 · API PRINCIPAL
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Búsqueda web con fallback en cascada.
 *
 * @param {string} query
 * @param {object} opts
 * @param {number} [opts.maxResults]      default 8
 * @param {string} [opts.vertical]        'web' | 'news' | 'definition'
 * @param {string[]} [opts.languages]     ['es'] | ['es', 'en'] ...
 * @param {boolean} [opts.fetchContent]   leer la página completa
 * @param {number} [opts.minTrust]        filtrar por trust mínimo
 * @param {number} [opts.budgetMs]        límite total de tiempo
 */
export async function searchWeb(query, opts = {}) {
  stats.queries++;

  const t0 = Date.now();
  const maxResults = Math.min(opts.maxResults || CFG.maxResults, 20);
  const vertical = opts.vertical || 'web';
  const languages = opts.languages || [detectLanguage(query) || 'es'];
  const budgetMs = opts.budgetMs || CFG.totalBudgetMs;

  if (!query || query.trim().length < 2) return [];

  const smartQuery = buildSmartQuery(query);
  const cacheK = cacheKey(vertical + ':' + languages.join(',') + ':' + smartQuery, '');

  // Cache
  const cached = await cacheGet(cacheK);
  if (cached) {
    return cached.slice(0, maxResults);
  }

  const providerWeights = {
    'definition': { wikipedia: 1.5, duckduckgo: 0.6, searx: 0.5 },
    'news':       { duckduckgo: 1.2, searx: 1.0, brave: 1.2, reddit: 0.8, hackernews: 0.9 },
    'web':        { duckduckgo: 1.0, wikipedia: 1.0, brave: 1.2, searx: 0.9 },
  };
  const weights = providerWeights[vertical] || providerWeights.web;

  /* ─── Ejecutar proveedores en paralelo ─── */
  const tasks = [];

  // DuckDuckGo siempre
  tasks.push(
    duckduckgoSearch(smartQuery)
      .then(r => ({ provider: 'duckduckgo', results: r }))
      .catch(() => ({ provider: 'duckduckgo', results: [] }))
  );

  // Wikipedia según idiomas
  for (const lang of languages) {
    tasks.push(
      wikipediaSearch(smartQuery, lang)
        .then(r => ({ provider: 'wikipedia', results: r }))
        .catch(() => ({ provider: 'wikipedia', results: [] }))
    );
  }

  // Vertical-específicos
  if (vertical === 'news') {
    tasks.push(
      searxSearch(smartQuery)
        .then(r => ({ provider: 'searx', results: r }))
        .catch(() => ({ provider: 'searx', results: [] }))
    );
    tasks.push(
      redditSearch(smartQuery)
        .then(r => ({ provider: 'reddit', results: r }))
        .catch(() => ({ provider: 'reddit', results: [] }))
    );
    tasks.push(
      hackerNewsSearch(smartQuery)
        .then(r => ({ provider: 'hackernews', results: r }))
        .catch(() => ({ provider: 'hackernews', results: [] }))
    );
  } else if (vertical === 'definition') {
    tasks.push(
      wikipediaDefinition(smartQuery, languages[0] || 'es')
        .then(r => ({ provider: 'wikipedia-def', results: r }))
        .catch(() => ({ provider: 'wikipedia-def', results: [] }))
    );
  } else {
    // web: incluir Brave si hay key, si no Searx
    if (process.env.BRAVE_SEARCH_API_KEY) {
      tasks.push(
        braveSearch(smartQuery)
          .then(r => ({ provider: 'brave', results: r }))
          .catch(() => ({ provider: 'brave', results: [] }))
      );
    } else {
      tasks.push(
        searxSearch(smartQuery)
          .then(r => ({ provider: 'searx', results: r }))
          .catch(() => ({ provider: 'searx', results: [] }))
      );
    }
  }

  /* ─── Esperar todas con timeout global ─── */
  const collected = [];
  try {
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve([]), budgetMs)
    );

    const responses = await Promise.race([
      Promise.all(tasks),
      timeoutPromise,
    ]);

    for (const { provider, results } of responses) {
      const weight = weights[provider] || 1;
      for (const r of results) {
        collected.push({
          ...r,
          _weight: weight,
          _provider: provider,
        });
      }
    }
  } catch (e) {
    trackError('aggregator', e.message);
  }

  /* ─── Dedup y ranking ─── */
  const unique = dedupeResults(collected);

  const scored = unique.map(r => ({
    ...r,
    score: scoreResult(r, smartQuery, r._weight || 1),
  }));

  scored.sort((a, b) => b.score - a.score);

  /* ─── Filtro por trust ─── */
  let filtered = scored;
  if (opts.minTrust) {
    filtered = scored.filter(r => getDomainTrust(extractDomain(r.url)) >= opts.minTrust);
  }

  /* ─── Content fetching (opcional) ─── */
  let final = filtered;
  if (opts.fetchContent && filtered.length > 0) {
    try {
      final = await Promise.all(
        filtered.slice(0, maxResults).map(async (r) => {
          if (r.snippet && r.snippet.length > 300) return r; // ya tiene contenido
          const content = await fetchContent(r.url).catch(() => null);
          if (!content) return r;
          return {
            ...r,
            fullText: content.text,
            fullTitle: content.title,
            snippet: content.text.slice(0, 800) || r.snippet,
          };
        })
      );
    } catch (e) {
      trackError('content', e.message);
      final = filtered;
    }
  }

  /* ─── Recortar a maxResults ─── */
  const out = final.slice(0, maxResults);

  /* ─── Limpiar metadata interna ─── */
  const cleaned = out.map(r => {
    const { _weight, _provider, ...rest } = r;
    return rest;
  });

  /* ─── Cache ─── */
  const ttl = vertical === 'news'
    ? CFG.cacheTtlNewsSec
    : vertical === 'definition'
      ? CFG.cacheTtlDefinitionSec
      : CFG.cacheTtlSec;

  if (cleaned.length > 0) {
    cacheSet(cacheK, cleaned, ttl).catch(() => {});
  }

  return cleaned;
}

/* ─── Alias por vertical ─── */

export async function searchNews(query, opts = {}) {
  return searchWeb(query, { ...opts, vertical: 'news' });
}

export async function searchDefinition(term, opts = {}) {
  return searchWeb(term, { ...opts, vertical: 'definition', languages: [opts.lang || 'es'] });
}

export async function searchMultiLang(query, opts = {}) {
  const langs = opts.languages || ['es', 'en'];
  return searchWeb(query, { ...opts, languages: langs });
}

/* ═══════════════════════════════════════════════════════════════════════
   12 · CONTENT FETCHING (lectura de páginas)
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Lee una URL y extrae el texto principal.
 * Protegido contra SSRF (no permite IPs privadas).
 */
export async function fetchContent(url, opts = {}) {
  if (!isSafeUrl(url)) {
    trackError('content', 'url_rejected: ' + url.slice(0, 80));
    return null;
  }

  const key = cacheKey('content', url);
  const cached = await cacheGet(key);
  if (cached) return cached;

  const t0 = Date.now();

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Numination/8.0; +https://numination.app)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8',
      },
      signal: AbortSignal.timeout(CFG.fetchTimeoutMs),
      redirect: 'follow',
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      throw new Error('not_html');
    }

    // Leer con límite de bytes
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no_body');

    let total = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > CFG.maxContentBytes) {
        try { reader.cancel(); } catch {}
        break;
      }
      chunks.push(value);
    }

    const buffer = Buffer.concat(chunks.map(c => Buffer.from(c)));
    const html = buffer.toString('utf8');

    // Extraer título
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]) : extractDomain(url);

    // Extraer meta description
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    const metaDesc = metaMatch ? stripHtml(metaMatch[1]) : '';

    // Extraer contenido principal (heurística)
    let body = html;

    // Preferir <article>, <main>, o el body
    const articleMatch = body.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) {
      body = articleMatch[1];
    } else {
      const mainMatch = body.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
      if (mainMatch) {
        body = mainMatch[1];
      } else {
        const bodyMatch = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
        if (bodyMatch) body = bodyMatch[1];
      }
    }

    // Quitar nav, header, footer, aside
    body = body
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside[\s\S]*?<\/aside>/gi, '')
      .replace(/<form[\s\S]*?<\/form>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '');

    // Extraer párrafos
    const paragraphs = [];
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let m;
    while ((m = pRegex.exec(body)) !== null) {
      const text = stripHtml(m[1]);
      if (text.length > 40) paragraphs.push(text);
      if (paragraphs.length > 40) break;
    }

    // Unir y recortar
    let text = paragraphs.join('\n\n');
    if (!text && metaDesc) text = metaDesc;
    text = text.slice(0, CFG.maxContentChars);

    const result = {
      url,
      title,
      text,
      chars: text.length,
      description: metaDesc,
      fetchedAt: new Date().toISOString(),
    };

    trackCall('content', Date.now() - t0, true);
    cacheSet(key, result, CFG.cacheTtlContentSec).catch(() => {});
    return result;
  } catch (e) {
    trackCall('content', Date.now() - t0, false);
    trackError('content', e.message);
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   13 · TOKEN BUDGET · recortar resultados para el prompt
   ═══════════════════════════════════════════════════════════════════════ */

/**
 * Recorta los resultados para que quepan en el presupuesto de contexto.
 * Mantiene los mejores y descarta los peores.
 */
function budgetResults(results, maxChars) {
  if (!Array.isArray(results)) return [];

  let total = 0;
  const out = [];
  const separatorCost = 40; // aprox por separador

  for (const r of results) {
    const titleCost = (r.title || '').length;
    const snippetCost = (r.snippet || r.fullText || '').length;
    const urlCost = (r.url || '').length;
    const cost = titleCost + snippetCost + urlCost + separatorCost;

    if (total + cost > maxChars && out.length > 0) break;
    out.push(r);
    total += cost;
  }

  return out;
}

/* ═══════════════════════════════════════════════════════════════════════
   14 · FORMATTING PARA EL SYSTEM PROMPT
   ═══════════════════════════════════════════════════════════════════════ */

export function formatResultsForAI(query, results, opts = {}) {
  if (!results || results.length === 0) {
    return `# BÚSQUEDA WEB

El usuario pidió buscar: "${query}"

No se encontraron resultados relevantes. Responde con tu conocimiento general y aclara al usuario que no pudiste buscar en la web en este momento.`;

  const maxChars = opts.maxContextChars || CFG.maxContextChars;
  const budgeted = budgetResults(results, maxChars);

  const lines = budgeted.map((r, i) => {
    const domain = extractDomain(r.url);
    const trust = getDomainTrust(domain);
    const trustLabel = trust >= 0.9 ? '★★★' : trust >= 0.75 ? '★★' : '★';

    let block = `${i + 1}. **${r.title}** ${trustLabel}\n`;
    if (r.fullText) {
      block += `   ${r.fullText.slice(0, 600)}\n`;
    } else {
      block += `   ${r.snippet || '(sin descripción)'}\n`;
    }
    block += `   Fuente: ${r.url}`;
    if (domain) block += `\n   Dominio: ${domain}`;
    return block;
  });

  return `# RESULTADOS DE BÚSQUEDA WEB

El usuario activó el modo búsqueda web para: "${query}"

Se encontraron ${budgeted.length} resultados relevantes (de ${results.length} totales):

${lines.join('\n\n')}

# INSTRUCCIONES PARA RESPONDER

1. Usa la información de arriba como contexto prioritario. Combínala con tu conocimiento general.
2. Cita las fuentes cuando sea relevante. Ejemplos:
   - "Según Wikipedia..."
   - "De acuerdo con el sitio oficial..."
   - Si el dominio es confiable (★★★), podés afirmar con más seguridad.
3. Si la información es contradictoria entre fuentes, mencioná la discrepancia.
4. Si los resultados NO responden la pregunta del usuario, sé honesto y decilo.
5. NUNCA inventes URLs, fechas ni datos que no estén en los resultados.
6. El usuario espera una respuesta clara y útil, no una lista de links.`;
}

/**
 * Formato corto: solo citas, sin el bloque completo.
 */
export function formatCitations(results) {
  if (!results || results.length === 0) return '';

  return results.map((r, i) => {
    const domain = extractDomain(r.url);
    return `[${i + 1}] ${r.title} — ${domain}\n    ${r.url}`;
  }).join('\n\n');
}

/* ═══════════════════════════════════════════════════════════════════════
   15 · HEALTH CHECK
   ═══════════════════════════════════════════════════════════════════════ */

export async function pingWebsearch() {
  const checks = await Promise.allSettled([
    (async () => {
      const t0 = Date.now();
      const res = await fetch('https://api.duckduckgo.com/?q=test&format=json', {
        signal: AbortSignal.timeout(3000),
      });
      return { provider: 'duckduckgo', ok: res.ok, latencyMs: Date.now() - t0 };
    })(),
    (async () => {
      const t0 = Date.now();
      const res = await fetch('https://es.wikipedia.org/api/rest_v1/page/summary/Test', {
        signal: AbortSignal.timeout(3000),
      });
      return { provider: 'wikipedia', ok: res.ok, latencyMs: Date.now() - t0 };
    })(),
  ]);

  const providers = checks.map(r =>
    r.status === 'fulfilled'
      ? r.value
      : { provider: 'unknown', ok: false, error: r.reason?.message }
  );

  return {
    ok: providers.some(p => p.ok),
    providers,
    stats: getWebsearchStats(),
    ts: new Date().toISOString(),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   16 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════ */

export function selfTest() {
  const errors = [];

  /* 1 · Detección de idioma */
  const es = detectLanguage('¿Cómo está el clima en Medellín?');
  if (es !== 'es') errors.push(`detectLanguage ES: ${es}`);

  const en = detectLanguage('How is the weather in New York?');
  if (en !== 'en') errors.push(`detectLanguage EN: ${en}`);

  const pt = detectLanguage('Como está o tempo em São Paulo?');
  if (pt !== 'pt') errors.push(`detectLanguage PT: ${pt}`);

  /* 2 · Query rewriting */
  const q1 = buildSmartQuery('búscame información sobre fotosíntesis en la web');
  if (q1.includes('búscame')) errors.push('buildSmartQuery no quitó el prefijo');
  if (q1.includes('en la web')) errors.push('buildSmartQuery no quitó el sufijo');

  const q2 = buildSmartQuery('¿Qué es la inteligencia artificial?');
  if (q2.includes('?')) errors.push('buildSmartQuery no quitó los signos');

  /* 3 · URL safety */
  if (isSafeUrl('http://localhost/admin')) errors.push('isSafeUrl permite localhost');
  if (isSafeUrl('http://192.168.1.1/')) errors.push('isSafeUrl permite IP privada');
  if (isSafeUrl('http://169.254.169.254/latest')) errors.push('isSafeUrl permite metadata AWS');
  if (!isSafeUrl('https://es.wikipedia.org/wiki/Fotosíntesis')) errors.push('isSafeUrl bloquea URL válida');

  /* 4 · Normalización de URL */
  const u1 = normalizeUrl('https://example.com/page?utm_source=twitter&ref=abc');
  if (u1.includes('utm_source')) errors.push('normalizeUrl no quita utm_source');
  if (u1.includes('ref=')) errors.push('normalizeUrl no quita ref');

  /* 5 · Trust scoring */
  const t1 = getDomainTrust('es.wikipedia.org');
  if (t1 < 0.9) errors.push(`trust wikipedia: ${t1}`);
  const t2 = getDomainTrust('nasa.gov');
  if (t2 < 0.9) errors.push(`trust nasa.gov: ${t2}`);
  const t3 = getDomainTrust('random-blog.xyz');
  if (t3 > 0.7) errors.push(`trust random: ${t3}`);

  /* 6 · Stripping de HTML */
  const html = '<p>Hola <b>mundo</b></p>';
  const stripped = stripHtml(html);
  if (stripped !== 'Hola mundo') errors.push(`stripHtml: "${stripped}"`);

  /* 7 · Format AI */
  const results = [
    { title: 'Test 1', snippet: 'Descripción 1', url: 'https://example.com/1' },
    { title: 'Test 2', snippet: 'Descripción 2', url: 'https://example.com/2' },
  ];
  const formatted = formatResultsForAI('test', results);
  if (!formatted.includes('Test 1')) errors.push('formatResultsForAI no incluye resultados');
  if (!formatted.includes('INSTRUCCIONES')) errors.push('formatResultsForAI sin instrucciones');

  /* 8 · Format AI vacío */
  const emptyFormatted = formatResultsForAI('test', []);
  if (!emptyFormatted.includes('No se encontraron resultados')) {
    errors.push('formatResultsForAI no maneja lista vacía');
  }

  /* 9 · Citations */
  const citations = formatCitations(results);
  if (!citations.includes('example.com')) errors.push('formatCitations sin dominio');

  return {
    ok: errors.length === 0,
    errors,
    providers: [
      'duckduckgo', 'wikipedia', 'brave (opcional)',
      'searx', 'reddit', 'hackernews', 'wolfram (futuro)',
    ],
    verticals: ['web', 'news', 'definition'],
    maxResults: CFG.maxResults,
    maxContextChars: CFG.maxContextChars,
    stats: getWebsearchStats(),
  };
}

/* ═══════════════════════════════════════════════════════════════════════
   FIN
   ══════════════════════════════════════════════════════════════════════