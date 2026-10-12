/* ================================================================
   src/services/websearch.js · v1.0 minimal
   ----------------------------------------------------------------
   Búsqueda web real con Wikipedia + DuckDuckGo.
   Sin dependencias externas. Solo fetch nativo de Node 22+.
   ================================================================ */

const WIKI_API = 'https://es.wikipedia.org/api/rest_v1';
const DDG_API  = 'https://api.duckduckgo.com';

/* ─── Wikipedia ─── */
async function searchWikipedia(query, opts = {}) {
  const { timeout = 8000 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    const url = `${WIKI_API}/page/summary/${encodeURIComponent(query)}?redirect=true`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];

    const data = await res.json();
    if (!data.extract) return [];

    return [{
      title: data.title,
      url: data.content_urls?.desktop?.page
        || `https://es.wikipedia.org/wiki/${encodeURIComponent(data.title)}`,
      snippet: data.extract,
      source: 'es.wikipedia.org',
      trust: 0.95,
    }];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/* ─── DuckDuckGo ─── */
async function searchDuckDuckGo(query, opts = {}) {
  const { maxResults = 5, timeout = 8000 } = opts;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    const url = `${DDG_API}/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];

    const data = await res.json();
    const results = [];

    if (data.AbstractText && data.AbstractURL) {
      results.push({
        title: data.Heading || query,
        url: data.AbstractURL,
        snippet: data.AbstractText,
        source: new URL(data.AbstractURL).hostname,
        trust: 0.8,
      });
    }

    if (Array.isArray(data.RelatedTopics)) {
      for (const topic of data.RelatedTopics.slice(0, maxResults - 1)) {
        if (topic.FirstURL && topic.Text) {
          try {
            results.push({
              title: topic.Text.slice(0, 100),
              url: topic.FirstURL,
              snippet: topic.Text,
              source: new URL(topic.FirstURL).hostname,
              trust: 0.7,
            });
          } catch {}
        }
      }
    }

    return results.slice(0, maxResults);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/* ─── API principal ─── */
export async function searchWeb(query, opts = {}) {
  if (!query || String(query).trim().length < 3) return [];
  const maxResults = opts.maxResults || 5;

  const [wiki, ddg] = await Promise.allSettled([
    searchWikipedia(query, opts),
    searchDuckDuckGo(query, opts),
  ]);

  const results = [];
  if (wiki.status === 'fulfilled') results.push(...wiki.value);
  if (ddg.status === 'fulfilled')  results.push(...ddg.value);

  const seen = new Set();
  const unique = results.filter((r) => {
    if (!r.url || seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });

  return unique.slice(0, maxResults);
}

/* ─── Formato para inyectar en el system prompt ─── */
export function formatResultsForAI(query, results) {
  if (!Array.isArray(results) || results.length === 0) return '';

  const lines = [
    '════════════════════════════════════════════════════════',
    `RESULTADOS DE BUSQUEDA WEB PARA: "${query}"`,
    '════════════════════════════════════════════════════════',
    '',
    'Usa esta informacion para responder con datos actualizados.',
    'Cita las fuentes al final usando el formato [1], [2], etc.',
    '',
  ];

  results.forEach((r, i) => {
    lines.push(`[${i + 1}] ${r.title}`);
    lines.push(`    URL: ${r.url}`);
    if (r.snippet) lines.push(`    ${r.snippet.slice(0, 300)}`);
    lines.push('');
  });

  lines.push('════════════════════════════════════════════════════════');
  return lines.join('\n');
}

export default { searchWeb, formatResultsForAI };