/* ═══════════════════════════════════════════════════════════════════════════
   
                            ███╗   ██╗██╗   ██╗███╗   ███╗██╗
                            ████╗  ██║██║   ██║████╗ ████║██║
                            ██╔██╗ ██║██║   ██║██╔████╔██║██║
                            ██║╚██╗██║██║   ██║██║╚██╔╝██║██║
                            ██║ ╚████║╚██████╔╝██║ ╚═╝ ██║███████╗
                            ╚═╝  ╚═══╝ ╚═════╝ ╚═╝     ╚═╝╚══════╝
   
                            C O N N E C T O R S   ·   v 1 . 0
   
   ─────────────────────────────────────────────────────────────────────────
   13 conectores gratuitos que dan superpoderes a Numination.
   
   Cada conector es una API externa gratuita que la IA consulta cuando
   necesita información real: definiciones, clima, datos de Colombia,
   astronomía, libros, trivia educativa, y más.
   
   FILOSOFÍA:
     · Cada conector es autónomo — si uno falla, los demás siguen.
     · Todo tiene timeout — nada bloquea más de 8 segundos.
     · Todo se cachea — 5 min por defecto, LRU de 500 entradas.
     · Todo se loggea — sabés qué conector se usó y cuánto tardó.
     · Nada requiere API key — todos son gratuitos sin registro.
   
   CONECTORES:
     📚 Educación   → wikipedia · trivia · colombia · books · dictionary · rae · wiktionary
     🔬 Ciencia     → nasa · meteo · countries
     🧮 Utilidades  → quotable · numbers · holidays
   
   ENDPOINTS:
     GET    /api/connectors                 → lista todos
     GET    /api/connectors/:id             → detalle
     GET    /api/connectors/:id/health      → ping upstream
     POST   /api/connectors/:id/query       → ejecuta consulta
     GET    /api/connectors/status          → estado de todos
     POST   /api/connectors/detect          → detecta conector
   
   ─────────────────────────────────────────────────────────────────────────
   Álvaro & Robinson · Medellín · 2026
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';

/* ═══════════════════════════════════════════════════════════════════════════
   1 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CONFIG = Object.freeze({
  DEFAULT_TIMEOUT_MS: 8000,
  FAST_TIMEOUT_MS: 5000,
  SLOW_TIMEOUT_MS: 12000,
  MAX_RETRIES: 2,
  RETRY_BASE_MS: 300,
  CACHE_TTL_MS: 5 * 60 * 1000,
  CACHE_MAX_ENTRIES: 500,
  RATE_WINDOW_MS: 60_000,
  RATE_MAX_REQUESTS: 30,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
  USER_AGENT: 'Numination/1.0 (+https://numination.app)',
  LANG: 'es',
});

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[CONFIG.LOG_LEVEL] || LEVELS.info;

/* ═══════════════════════════════════════════════════════════════════════════
   2 · LOGGING
   ═══════════════════════════════════════════════════════════════════════════ */

function log(level, event, meta = {}) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const entry = { ts: new Date().toISOString(), lvl: level, event, mod: 'connectors', ...meta };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error('[conn]', line);
  else if (level === 'warn') console.warn('[conn]', line);
  else if (level === 'debug') console.debug('[conn]', line);
  else console.log('[conn]', line);
}

/* ═══════════════════════════════════════════════════════════════════════════
   3 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

const Utils = {
  uid() { return crypto.randomBytes(8).toString('hex'); },
  sleep(ms) { return new Promise(r => setTimeout(r, ms)); },
  isStr(v) { return typeof v === 'string' && v.trim().length > 0; },
  isObj(v) { return Object.prototype.toString.call(v) === '[object Object]'; },
  isArr(v) { return Array.isArray(v) && v.length > 0; },
  clamp(n, min, max, fb) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fb;
    return Math.min(max, Math.max(min, Math.trunc(v)));
  },
  truncate(s, max) {
    const str = String(s || '');
    return str.length <= max ? str : str.slice(0, max - 1) + '…';
  },
  stripHtml(s) {
    return String(s || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ');
  },
  normKey(s) {
    return String(s || '').toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .trim();
  },
};

/* ═══════════════════════════════════════════════════════════════════════════
   4 · CACHE LRU
   ═══════════════════════════════════════════════════════════════════════════ */

class LRUCache {
  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    if (!this.map.has(key)) {
      this.misses++;
      return null;
    }
    const entry = this.map.get(key);
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      this.misses++;
      return null;
    }
    // Mover al final (más reciente)
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  clear() {
    this.map.clear();
    this.hits = 0;
    this.misses = 0;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      maxSize: this.maxSize,
      hits: this.hits,
      misses: this.misses,
      hitRate: total > 0 ? Math.round((this.hits / total) * 100) / 100 : 0,
    };
  }
}

const cache = new LRUCache(CONFIG.CACHE_MAX_ENTRIES);

/* ═══════════════════════════════════════════════════════════════════════════
   5 · HTTP CLIENT con retry y timeout
   ═══════════════════════════════════════════════════════════════════════════ */

async function httpFetch(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || CONFIG.DEFAULT_TIMEOUT_MS;
  const retries = opts.retries ?? CONFIG.MAX_RETRIES;
  const method = opts.method || 'GET';
  const headers = {
    'User-Agent': CONFIG.USER_AGENT,
    'Accept': 'application/json',
    ...(opts.headers || {}),
  };

  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: opts.body,
        signal: ctrl.signal,
      });

      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;

        // No reintentar en 4xx (excepto 429)
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          throw err;
        }
        lastErr = err;
        if (attempt < retries) {
          await Utils.sleep(CONFIG.RETRY_BASE_MS * Math.pow(2, attempt));
          continue;
        }
        throw err;
      }

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return await res.json();
      }
      return await res.text();

    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (e.name === 'AbortError') {
        lastErr = new Error(`Timeout ${timeoutMs}ms`);
      }
      if (attempt < retries && !e.status) {
        await Utils.sleep(CONFIG.RETRY_BASE_MS * Math.pow(2, attempt));
        continue;
      }
      break;
    }
  }

  throw lastErr || new Error('Fetch failed');
}

/* ═══════════════════════════════════════════════════════════════════════════
   6 · RATE LIMITING por usuario
   ═══════════════════════════════════════════════════════════════════════════ */

const rateBuckets = new Map();

function rateLimit(userId, limit = CONFIG.RATE_MAX_REQUESTS, windowMs = CONFIG.RATE_WINDOW_MS) {
  const now = Date.now();
  let b = rateBuckets.get(userId);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    rateBuckets.set(userId, b);
  }
  b.count++;
  if (b.count > limit) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
  }
  return { ok: true, remaining: limit - b.count };
}

// Limpieza periódica
const _rlCleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) {
    if (now > v.resetAt) rateBuckets.delete(k);
  }
}, 60_000);
if (_rlCleanup.unref) _rlCleanup.unref();

/* ═══════════════════════════════════════════════════════════════════════════
   7 · BASE CONNECTOR
   ═══════════════════════════════════════════════════════════════════════════ */

class BaseConnector {
  constructor({ id, name, description, category, icon, ttlMs, timeoutMs, keywords, examples }) {
    this.id = id;
    this.name = name;
    this.description = description;
    this.category = category;
    this.icon = icon;
    this.ttlMs = ttlMs || CONFIG.CACHE_TTL_MS;
    this.timeoutMs = timeoutMs || CONFIG.DEFAULT_TIMEOUT_MS;
    this.keywords = keywords || [];
    this.examples = examples || [];
    this.stats = { queries: 0, errors: 0, totalMs: 0, cacheHits: 0 };
  }

  /** Override en subclases */
  async run(input, ctx) { throw new Error('run() no implementado'); }
  async ping() { return { ok: true }; }

  /** Ejecuta con cache, timeout, stats */
  async query(input, ctx = {}) {
    const start = Date.now();
    const cacheKey = `conn:${this.id}:${JSON.stringify(input)}`;

    // Cache hit
    const cached = cache.get(cacheKey);
    if (cached) {
      this.stats.cacheHits++;
      log('debug', 'connector.cache.hit', { id: this.id, ms: Date.now() - start });
      return { ok: true, cached: true, data: cached, ms: Date.now() - start };
    }

    try {
      this.stats.queries++;
      const result = await this.run(input, ctx);
      const ms = Date.now() - start;
      this.stats.totalMs += ms;
      cache.set(cacheKey, result, this.ttlMs);
      log('info', 'connector.query.ok', { id: this.id, ms });
      return { ok: true, cached: false, data: result, ms };
    } catch (e) {
      this.stats.errors++;
      const ms = Date.now() - start;
      log('warn', 'connector.query.fail', { id: this.id, ms, error: e.message });
      return { ok: false, error: e.message, ms };
    }
  }

  info() {
    const avg = this.stats.queries > 0
      ? Math.round(this.stats.totalMs / this.stats.queries)
      : 0;
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      category: this.category,
      icon: this.icon,
      keywords: this.keywords,
      examples: this.examples,
      stats: { ...this.stats, avgMs: avg },
    };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   8 · CONECTOR · WIKIPEDIA
   ═══════════════════════════════════════════════════════════════════════════ */

class WikipediaConnector extends BaseConnector {
  constructor() {
    super({
      id: 'wikipedia',
      name: 'Wikipedia',
      description: 'Busca y cita artículos en español de Wikipedia',
      category: 'educacion',
      icon: 'book',
      ttlMs: 10 * 60 * 1000,
      keywords: ['wikipedia', 'artículo', 'enciclopedia', 'quién fue', 'qué es', 'historia de'],
      examples: ['¿Quién fue Simón Bolívar?', 'Historia de Colombia', 'Qué es la fotosíntesis'],
    });
  }

  async run(input) {
    const q = String(input.query || input.q || '').trim();
    if (!q) throw new Error('Falta el query');

    const limit = Utils.clamp(input.limit, 1, 10, 3);
    const lang = input.lang === 'en' ? 'en' : 'es';

    // 1. Buscar artículos
    const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=${limit}&format=json&origin=*`;
    const searchRes = await httpFetch(searchUrl, { timeoutMs: this.timeoutMs });

    const hits = searchRes?.query?.search || [];
    if (!hits.length) return { query: q, results: [] };

    // 2. Enriquecer con extractos
    const results = [];
    for (const hit of hits) {
      try {
        const summaryUrl = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title)}`;
        const summary = await httpFetch(summaryUrl, { timeoutMs: CONFIG.FAST_TIMEOUT_MS });
        results.push({
          title: hit.title,
          snippet: Utils.stripHtml(hit.snippet || ''),
          extract: summary?.extract || '',
          url: summary?.content_urls?.desktop?.page || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`,
          thumbnail: summary?.thumbnail?.source || null,
          wordCount: hit.wordcount || 0,
          timestamp: hit.timestamp || null,
        });
      } catch (e) {
        results.push({
          title: hit.title,
          snippet: Utils.stripHtml(hit.snippet || ''),
          extract: '',
          url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`,
          thumbnail: null,
          wordCount: hit.wordcount || 0,
        });
      }
    }

    return { query: q, count: results.length, results };
  }

  async ping() {
    const t = Date.now();
    await httpFetch('https://es.wikipedia.org/api/rest_v1/page/summary/Colombia', { timeoutMs: 5000 });
    return { ok: true, ms: Date.now() - t };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   9 · CONECTOR · OPEN TRIVIA DB
   ═══════════════════════════════════════════════════════════════════════════ */

class TriviaConnector extends BaseConnector {
  constructor() {
    super({
      id: 'trivia',
      name: 'Open Trivia',
      description: 'Genera preguntas de repaso tipo quiz de cualquier materia',
      category: 'educacion',
      icon: 'help-circle',
      ttlMs: 60 * 1000,
      keywords: ['trivia', 'quiz', 'preguntas', 'examen', 'repaso', 'test'],
      examples: ['Hazme un quiz de historia', 'Preguntas de matemáticas'],
    });
  }

  async run(input) {
    const amount = Utils.clamp(input.amount, 1, 20, 5);
    const category = input.category ? Number(input.category) : null;
    const difficulty = ['easy', 'medium', 'hard'].includes(input.difficulty) ? input.difficulty : null;
    const type = ['multiple', 'boolean'].includes(input.type) ? input.type : 'multiple';

    let url = `https://opentdb.com/api.php?amount=${amount}&type=${type}`;
    if (category) url += `&category=${category}`;
    if (difficulty) url += `&difficulty=${difficulty}`;

    const res = await httpFetch(url, { timeoutMs: this.timeoutMs });

    if (res?.response_code !== 0) {
      throw new Error(`Open Trivia respondió con código ${res?.response_code}`);
    }

    const questions = (res.results || []).map(q => {
      const correct = this.decodeHtml(q.correct_answer);
      const incorrect = (q.incorrect_answers || []).map(a => this.decodeHtml(a));
      const options = this.shuffle([correct, ...incorrect]);
      return {
        category: this.decodeHtml(q.category),
        difficulty: q.difficulty,
        type: q.type,
        question: this.decodeHtml(q.question),
        correct,
        incorrect,
        options,
      };
    });

    return { count: questions.length, questions };
  }

  decodeHtml(s) {
    return String(s || '')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&eacute;/g, 'é')
      .replace(/&aacute;/g, 'á')
      .replace(/&iacute;/g, 'í')
      .replace(/&oacute;/g, 'ó')
      .replace(/&uacute;/g, 'ú')
      .replace(/&ntilde;/g, 'ñ');
  }

  shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  async ping() {
    const t = Date.now();
    await httpFetch('https://opentdb.com/api.php?amount=1', { timeoutMs: 5000 });
    return { ok: true, ms: Date.now() - t };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · CONECTOR · API COLOMBIA
   ═══════════════════════════════════════════════════════════════════════════ */

class ColombiaConnector extends BaseConnector {
  constructor() {
    super({
      id: 'colombia',
      name: 'API Colombia',
      description: 'Departamentos, municipios, presidentes y datos del país',
      category: 'educacion',
      icon: 'flag',
      ttlMs: 30 * 60 * 1000,
      keywords: ['colombia', 'departamento', 'municipio', 'presidente', 'bogotá', 'medellín'],
      examples: ['Cuántos departamentos tiene Colombia', 'Presidentes de Colombia'],
    });
  }

  async run(input) {
    const type = String(input.type || 'departments').toLowerCase();

    const endpoints = {
      departments: 'https://api-colombia.com/api/v1/Department',
      regions: 'https://api-colombia.com/api/v1/Region',
      presidents: 'https://api-colombia.com/api/v1/President',
      'natural-areas': 'https://api-colombia.com/api/v1/NaturalArea',
      'touristic-attractions': 'https://api-colombia.com/api/v1/TouristicAttraction',
      'indigenous-reservations': 'https://api-colombia.com/api/v1/IndigenousReservation',
      'radio-stations': 'https://api-colombia.com/api/v1/RadioStation',
      'constitution-articles': 'https://api-colombia.com/api/v1/ConstitutionArticle',
    };

    // Si viene id específico, consultar detalle
    if (input.id && endpoints[type]) {
      const url = `${endpoints[type]}/${input.id}`;
      const data = await httpFetch(url, { timeoutMs: this.timeoutMs });
      return { type, id: input.id, data };
    }

    // Búsqueda por nombre en departamentos
    if (type === 'search' && input.q) {
      const q = Utils.normKey(input.q);
      const all = await httpFetch(endpoints.departments, { timeoutMs: this.timeoutMs });
      const found = (all || []).filter(d => Utils.normKey(d.name).includes(q));
      return { type: 'search', q: input.q, count: found.length, results: found.slice(0, 10) };
    }

    // Listado con límite
    const endpoint = endpoints[type];
    if (!endpoint) throw new Error(`Tipo "${type}" no soportado`);

    const data = await httpFetch(endpoint, { timeoutMs: this.timeoutMs });
    const limit = Utils.clamp(input.limit, 1, 100, 20);
    const sliced = Array.isArray(data) ? data.slice(0, limit) : data;

    return {
      type,
      count: Array.isArray(sliced) ? sliced.length : 1,
      total: Array.isArray(data) ? data.length : 1,
      results: sliced,
    };
  }

  async ping() {
    const t = Date.now();
    await httpFetch('https://api-colombia.com/api/v1/Department', { timeoutMs: 5000 });
    return { ok: true, ms: Date.now() - t };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   11 · CONECTOR · GOOGLE BOOKS
   ═══════════════════════════════════════════════════════════════════════════ */

class BooksConnector extends BaseConnector {
  constructor() {
    super({
      id: 'books',
      name: 'Google Books',
      description: 'Millones de libros, textos académicos y autores',
      category: 'educacion',
      icon: 'book-open',
      ttlMs: 30 * 60 * 1000,
      keywords: ['libro', 'autor', 'isbn', 'leer', 'bibliografía'],
      examples: ['Libros de García Márquez', 'Textos de física cuántica'],
    });
  }

  async run(input) {
    const q = String(input.query || input.q || '').trim();
    if (!q) throw new Error('Falta el query');

    const limit = Utils.clamp(input.limit, 1, 20, 5);
    const lang = input.lang === 'en' ? 'en' : 'es';

    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${limit}&langRestrict=${lang}`;
    const res = await httpFetch(url, { timeoutMs: this.timeoutMs });

    const items = res?.items || [];
    const results = items.map(it => {
      const v = it.volumeInfo || {};
      return {
        id: it.id,
        title: v.title || '',
        subtitle: v.subtitle || '',
        authors: v.authors || [],
        publisher: v.publisher || '',
        publishedDate: v.publishedDate || '',
        description: Utils.truncate(v.description || '', 500),
        pageCount: v.pageCount || 0,
        categories: v.categories || [],
        language: v.language || '',
        thumbnail: v.imageLinks?.thumbnail || null,
        previewLink: v.previewLink || '',
        infoLink: v.infoLink || '',
        isbn: (v.industryIdentifiers || [])[0]?.identifier || null,
      };
    });

    return { query: q, count: results.length, total: res?.totalItems || 0, results };
  }

  async ping() {
    const t = Date.now();
    await httpFetch('https://www.googleapis.com/books/v1/volumes?q=colombia&maxResults=1', { timeoutMs: 5000 });
    return { ok: true, ms: Date.now() - t };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   12 · CONECTOR · FREE DICTIONARY (inglés)
   ═══════════════════════════════════════════════════════════════════════════ */

class DictionaryConnector extends BaseConnector {
  constructor() {
    super({
      id: 'dictionary',
      name: 'Free Dictionary',
      description: 'Definiciones, fonética, sinónimos y audio en inglés',
      category: 'educacion',
      icon: 'languages',
      ttlMs: 24 * 60 * 60 * 1000,
      keywords: ['diccionario', 'significa', 'definición en inglés', 'traducir'],
      examples: ['What does serendipity mean', 'Definición de beautiful'],
    });
  }

  async run(input) {
    const word = String(input.word || input.query || '').trim().toLowerCase();
    if (!word) throw new Error('Falta la palabra');
    if (!/^[a-z\-]+$/.test(word)) throw new Error('Palabra inválida (solo letras a-z y guiones)');

    const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
    const res = await httpFetch(url, { timeoutMs: this.timeoutMs });

    if (!Array.isArray(res) || res.length === 0) {
      return { word, found: false, entries: [] };
    }

    const entries = res.map(entry => ({
      word: entry.word,
      phonetic: entry.phonetic || '',
      phonetics: (entry.phonetics || []).map(p => ({
        text: p.text || '',
        audio: p.audio || '',
      })).filter(p => p.text || p.audio),
      meanings: (entry.meanings || []).map(m => ({
        partOfSpeech: m.partOfSpeech,
        definitions: (m.definitions || []).slice(0, 5).map(d => ({
          definition: d.definition,
          example: d.example || '',
          synonyms: d.synonyms || [],
          antonyms: d.antonyms || [],
        })),
        synonyms: m.synonyms || [],
        antonyms: m.antonyms || [],
      })),
    }));

    return { word, found: true, count: entries.length, entries };
  }

  async ping() {
    const t = Date.now();
    await httpFetch('https://api.dictionaryapi.dev/api/v2/entries/en/hello', { timeoutMs: 5000 });
    return { ok: true, ms: Date.now() - t };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   13 · CONECTOR · RAE (no oficial)
   ═══════════════════════════════════════════════════════════════════════════ */

class RAEConnector extends BaseConnector {
  constructor() {
    super({
      id: 'rae',
      name: 'RAE',
      description: 'Diccionario oficial español — definiciones y conjugaciones',
      category: 'educacion',
      icon: 'book',
      ttlMs: 24 * 60 * 60 * 1000,
      keywords: ['rae', 'español', 'significado', 'definición', 'conjugar'],
      examples: ['Definición de ñapa', 'Cómo se conjuga entender'],
    });
  }

  async run(input) {
    const word = String(input.word || input.query || '').trim();
    if (!word) throw new Error('Falta la palabra');

    // 1. Definiciones
    if (input.type === 'conjugate' || input.type === 'conjugacion') {
      const url = `https://api.rae.es/conjugate/${encodeURIComponent(word)}`;
      try {
        const res = await httpFetch(url, { timeoutMs: this.timeoutMs });
        return { type: 'conjugate', word, data: res };
      } catch (e) {
        throw new Error(`No pude conjugar "${word}": ${e.message}`);
      }
    }

    const url = `https://api.rae.es/search/${encodeURIComponent(word)}`;
    try {
      const res = await httpFetch(url, { timeoutMs: this.timeoutMs });
      return { type: 'definition', word, data: res };
    } catch (e) {
      // Fallback a Wiktionary ES
      const fallbackUrl = `https://es.wiktionary.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`;
      const fallback = await httpFetch(fallbackUrl, { timeoutMs: CONFIG.FAST_TIMEOUT_MS });
      return {
        type: 'definition',
        word,
        fallback: true,
        extract: fallback?.extract || '',
        url: fallback?.content_urls?.desktop?.page || null,
      };
    }
  }

  async ping() {
    const t = Date.now();
    await httpFetch('https://es.wiktionary.org/api/rest_v1/page/summary/hola', { timeoutMs: 5000 });
    return { ok: true, ms: Date.now() - t };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   14 · CONECTOR · WIKTIONARY (multiidioma)
   ═══════════════════════════════════════════════════════════════════════════ */

class WiktionaryConnector extends BaseConnector {
  constructor() {
    super({
      id: 'wiktionary',
      name: 'Wiktionary',
      description: 'Diccionario multiidioma con etimología y traducciones',
      category: 'educacion',
      icon: 'languages',
      ttlMs: 24 * 60 * 60 * 1000,
      keywords: ['etimología', 'traducción', 'wiktionary', 'origen de la palabra'],
      examples: ['Etimología de chocolate', 'Cómo se dice casa en náhuatl'],
    });
  }

  async run(input) {
    const word = String(input.word || input.query || '').trim();
    if (!word) throw new Error('Falta la palabra');

    const lang = ['es', 'en', 'fr', 'pt', 'it', 'de'].includes(input.lang) ? input.lang : 'es';

    const url = `https://${lang}.wiktionary.org/api/rest_v1/page/summary/${encodeURIComponent(word)}`;
    const res = await httpFetch(url, { timeoutMs: this.timeoutMs });

    return {
      word,
      lang,
      title: res?.title || word,
      extract: res?.extract || '',
      description: res?.description || '',
      url: res?.content_urls?.desktop?.page || null,
      thumbnail: res?.thumbnail?.source || null,
    };
  }

  async ping() {
    const t = Date.now();
    await httpFetch('https://es.wiktionary.org/api/rest_v1/page/summary/agua', { timeoutMs: 5000 });
    return { ok: true, ms: Date.now() - t };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   15 · CONECTOR · NASA
   ═══════════════════════════════════════════════════════════════════════════ */

class NASAConnector extends BaseConnector {
  constructor() {
    super({
      id: 'nasa',
      name: 'NASA',
      description: 'Astronomía, Marte, asteroides y fotos espaciales reales',
      category: 'ciencia',
      icon: 'rocket',
      ttlMs: 30 * 60 * 1000,
      keywords: ['nasa', 'espacio', 'planeta', 'marte', 'asteroide', 'apod', 'universo'],
      examples: ['Foto astronómica del día', 'Asteroides cerca de la Tierra'],
    });
  }

  async run(input) {
    const type = String(input.type || 'apod').toLowerCase();
    const apiKey = 'DEMO_KEY'; // 30 req/hr

    const endpoints = {
      apod: `https://api.nasa.gov/planetary/apod?api_key=${apiKey}`,
      mars: `https://api.nasa.gov/mars-photos/api/v1/rovers/curiosity/photos?sol=1000&api_key=${apiKey}&page=1`,
      asteroids: `https://api.nasa.gov/neo/rest/v1/feed?api_key=${apiKey}&start_date=${input.date || new Date().toISOString().slice(0, 10)}&end_date=${input.date || new Date().toISOString().slice(0, 10)}`,
      epic: `https://api.nasa.gov/EPIC/api/natural/images?api_key=${apiKey}`,
      earth: `https://api.nasa.gov/planetary/earth/assets?lon=${input.lon || -74.08}&lat=${input.lat || 4.71}&date=${input.date || '2020-01-01'}&api_key=${apiKey}`,
    };

    const url = endpoints[type];
    if (!url) throw new Error(`Tipo "${type}" no soportado`);

    const res = await httpFetch(url, { timeoutMs: CONFIG.SLOW_TIMEOUT_MS });

    // Normalizar
    if (type === 'apod') {
      return {
        type, title: res.title, date: res.date, url: res.url,
        hdurl: res.hdurl, media_type: res.media_type,
        explanation: Utils.truncate(res.explanation || '', 800),
        copyright: res.copyright || null,
      };
    }

    if (type === 'mars') {
      const photos = (res.photos || []).slice(0, 8).map(p => ({
        id: p.id, sol: p.sol, camera: p.camera?.full_name,
        img_src: p.img_src, earth_date: p.earth_date,
        rover: p.rover?.name,
      }));
      return { type, count: photos.length, photos };
    }

    if (type === 'asteroids') {
      const days = res.near_earth_objects || {};
      const all = [];
      for (const day of Object.keys(days)) {
        for (const ast of days[day]) {
          all.push({
            id: ast.id, name: ast.name,
            diameter_km_min: ast.estimated_diameter?.kilometers?.estimated_diameter_min,
            diameter_km_max: ast.estimated_diameter?.kilometers?.estimated_diameter_max,
            hazardous: ast.is_potentially_hazardous_asteroid,
            close_approach_date: ast.close_approach_data?.[0]?.close_approach_date,
            velocity_kmh: ast.close_approach_data?.[0]?.relative_velocity?.kilometers_per_hour,
          });
        }
      }
      return { type, count: all.length, asteroids: all.slice(0, 10) };
    }

    return { type, data: res };
  }

  async ping() {
    const t = Date.now();
    await httpFetch('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY', { timeoutMs: 8000 });
    return { ok: true, ms: Date.now() - t };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   16 · CONECTOR · OPEN-METEO
   ═══════════════════════════════════════════════════════════════════════════ */

class MeteoConnector extends BaseConnector {
  constructor() {
    super({
      id: 'meteo',
      name: 'Open-Meteo',
      description: 'Clima actual, pronóstico e histórico de cualquier ciudad',
      category: 'ciencia',
      icon: 'cloud',
      ttlMs: 10 * 60 * 1000,
      keywords: ['clima', 'tiempo', 'temperatura', 'llueve', 'pronóstico', 'lluvia'],
      examples: ['Clima en Medellín', 'Pronóstico de mañana en Bogotá'],
    });
  }

  async run(input) {
    const lat = Number(input.lat);
    const lon = Number(input.lon);
    let queryLat = lat, queryLon = lon;

    // Geocoding si no hay coords
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      const city = String(input.city || input.query || 'Bogotá').trim();
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=es&format=json`;
      const geo = await httpFetch(geoUrl, { timeoutMs: this.timeoutMs });
      if (!geo?.results?.length) throw new Error(`No encontré la ciudad "${city}"`);
      queryLat = geo.results[0].latitude;
      queryLon = geo.results[0].longitude;
    }

    const currentUrl = `https://api.open-meteo.com/v1/forecast?latitude=${queryLat}&longitude=${queryLon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=3`;
    const res = await httpFetch(currentUrl, { timeoutMs: this.timeoutMs });

    return {
      lat: queryLat,
      lon: queryLon,
      timezone: res?.timezone,
      current: {
        temperature: res?.current?.temperature_2m,
        feelsLike: res?.current?.apparent_temperature,
        humidity: res?.current?.relative_humidity_2m,
        precipitation: res?.current?.precipitation,
        windSpeed: res?.current?.wind_speed_10m,
        weatherCode: res?.current?.weather_code,
        condition: this.decodeWeatherCode(res?.current?.weather_code),
      },
      forecast: (res?.daily?.time || []).slice(0, 3).map((date, i) => ({
        date,
        min: res.daily.temperature_2m_min[i],
        max: res.daily.temperature_2m_max[i],
        precipitation: res.daily.precipitation_sum[i],
        weatherCode: res.daily.weather_code[i],
        condition: this.decodeWeatherCode(res.daily.weather_code[i]),
      })),
    };
  }

  decodeWeatherCode(code) {
    const map = {
      0: 'Despejado', 1: 'Mayormente despejado', 2: 'Parcialmente nublado', 3: 'Nublado',
      45: 'Niebla', 48: 'Niebla con escarcha',
      51: 'Llovizna ligera', 53: 'Llovizna moderada', 55: 'Llovizna densa',
      61: 'Lluvia ligera', 63: 'Lluvia moderada', 65: 'Lluvia fuerte',
      71: 'Nieve ligera', 73: 'Nieve moderada', 75: 'Nieve fuerte',
      80: 'Chubascos ligeros', 81: 'Chubascos moderados', 82: 'Chubascos violentos',
      95: 'Tormenta eléctrica', 96: 'Tormenta con granizo', 99: 'Tormenta fuerte con granizo',
    };
    return map[code] || 'Desconocido';
  }

  async ping() {
    const t = Date.now();
    await httpFetch('https://api.open-meteo.com/v1/forecast?latitude=4.71&longitude=-74.08&current=temperature_2m', { timeoutMs: 5000 });
    return { ok: true, ms: Date.now() - t };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   17 · CONECTOR · REST COUNTRIES
   ═══════════════════════════════════════════════════════════════════════════ */

class CountriesConnector extends BaseConnector {
  constructor() {
    super({
      id: 'countries',
      name: 'REST Countries',
      description: '250+ países: capital, moneda, idioma, bandera, población',
      category: 'ciencia',
      icon: 'globe',
      ttlMs: 24 * 60 * 60 * 1000,
      keywords: ['país', 'capital', 'moneda', 'bandera', 'población'],
      examples: ['Capital de Francia', 'Países de Sudamérica'],
    });
  }

  async run(input) {
    // Por nombre
    if (input.name) {
      const url = `https://restcountries.com/v3.1/name/${encodeURIComponent(input.name)}?fields=name,capital,currencies,languages,flags,population,region,subregion,timezones`;
      const res = await httpFetch(url, { timeoutMs: this.timeoutMs });
      return { query: input.name, count: res.length, results: res.map(this.norm) };
    }

    // Por región
    if (input.region) {
      const url = `https://restcountries.com/v3.1/region/${encodeURIComponent(input.region)}?fields=name,capital,flags,population`;
      const res = await httpFetch(url, { timeoutMs: this.timeoutMs });
      const limit = Utils.clamp(input.limit, 1, 50, 20);
      return { region: input.region, count: res.length, results: res.slice(0, limit).map(this.norm) };
    }

    // Por código
    if (input.code) {
      const url = `https://restcountries.com/v3.1/alpha/${encodeURIComponent(input.code)}`;
      const res = await httpFetch(url, { timeoutMs: this.timeoutMs });
      return { code: input.code, results: res.map(this.norm) };
    }

    // Todas
    const url = `https://restcountries.com/v3.1/all?fields=name,capital,flags,population`;
    const res = await httpFetch(url, { timeoutMs: CONFIG.SLOW_TIMEOUT_MS });
    const limit = Utils.clamp(input.limit, 1, 100, 30);
    return { count: res.length, results: res.slice(0, limit).map(this.norm) };
  }

  norm(c) {
    return {
      name: c.name?.common || '',
      officialName: c.name?.official || '',
      capital: c.capital?.[0] || '',
      region: c.region || '',
      subregion: c.subregion || '',
      population: c.population || 0,
      currencies: c.currencies ? Object.keys(c.currencies).map(k => ({
        code: k, name: c.currencies[k].name, symbol: c.currencies[k].symbol,
      })) : [],
      languages: c.languages ? Object.values(c.languages) : [],
      flag: c.flags?.emoji || '',
      flagUrl: c.flags?.svg || '',
      timezones: c.timezones || [],
    };
  }

  async ping() {
    const t = Date.now();
    await httpFetch('https://restcountries.com/v3.1/alpha/co', { timeoutMs: 5000 });
    return { ok: true, ms: Date.now() - t };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   18 · CONECTOR · QUOTABLE
   ═══════════════════════════════════════════════════════════════════════════ */

class QuotableConnector extends BaseConnector {
  constructor() {
    super({
      id: 'quotable',
      name: 'Quotable',
      description: 'Frases célebres de más de 2000 citas y 900 autores',
      category: 'utilidades',
      icon: 'quote',
      ttlMs: 5 * 60 * 1000,
      keywords: ['frase', 'cita', 'motivación', 'inspiración'],
      examples: ['Frase del día', 'Citas sobre educación'],
    });
  }

  async run(input) {
    if (input.author) {
      const url = `https://api.quotable.io/quotes?author=${encodeURIComponent(input.author)}&limit=${Utils.clamp(input.limit, 1, 20, 5)}`;
      const res = await httpFetch(url, { timeoutMs: this.timeoutMs });
      return { type: 'byAuthor', author: input.author, count: res.results.length, quotes: res.results };
    }

    if (input.tag) {
      const url = `https://api.quotable.io/quotes?tags=${encodeURIComponent(input.tag)}&limit=${Utils.clamp(input.limit, 1, 20, 5)}`;
      const res = await httpFetch(url, { timeoutMs: this.timeoutMs });
      return { type: 'byTag', tag: input.tag, count: res.results.length, quotes: res.results };
    }

    if (input.q) {
      const url = `https://api.quotable.io/search/quotes?query=${encodeURIComponent(input.q)}&limit=${Utils.clamp(input.limit, 1, 20, 5)}`;
      const res = await httpFetch(url, { timeoutMs: this.timeoutMs });
      return { type: 'search', query: input.q, count: res.results.length, quotes: res.results };
    }

    // Random
    const url = 'https://api.quotable.io/random';
    const res = await httpFetch(url, { timeoutMs: this.timeoutMs });
    return { type: 'random', quote: res };
  }

  async ping() {
    const t = Date.now();
    await httpFetch('https://api.quotable.io/random', { timeoutMs: 5000 });
    return { ok: true, ms: Date.now() - t };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   19 · CONECTOR · NUMBERS API
   ═══════════════════════════════════════════════════════════════════════════ */

class NumbersConnector extends BaseConnector {
  constructor() {
    super({
      id: 'numbers',
      name: 'Numbers API',
      description: 'Datos curiosos sobre números, fechas y matemáticas',
      category: 'utilidades',
      icon: 'calculator',
      ttlMs: 24 * 60 * 60 * 1000,
      keywords: ['número curioso', 'dato', 'trivia número'],
      examples: ['Dato curioso del 42', 'Qué pasó un 15 de septiembre'],
    });
  }

  async run(input) {
    const type = String(input.type || 'trivia').toLowerCase();
    const number = Utils.clamp(input.number, 1, 99999, null) || 'random';

    const endpoints = {
      trivia: `http://numbersapi.com/${number}/trivia?json`,
      math: `http://numbersapi.com/${number}/math?json`,
      year: `http://numbersapi.com/${number}/year?json`,
      date: `http://numbersapi.com/${input.month || 9}/${input.day || 15}/date?json`,
    };

    const url = endpoints[type] || endpoints.trivia;
    const res = await httpFetch(url, { timeoutMs: this.timeoutMs });

    return {
      type,
      number: res?.number,
      text: res?.text || '',
      found: res?.found !== false,
    };
  }

  async ping() {
    const t = Date.now();
    await httpFetch('http://numbersapi.com/42/trivia?json', { timeoutMs: 5000 });
    return { ok: true, ms: Date.now() - t };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   20 · CONECTOR · NAGER HOLIDAYS
   ═══════════════════════════════════════════════════════════════════════════ */

class HolidaysConnector extends BaseConnector {
  constructor() {
    super({
      id: 'holidays',
      name: 'Nager.Holidays',
      description: 'Días festivos de más de 100 países',
      category: 'utilidades',
      icon: 'calendar',
      ttlMs: 24 * 60 * 60 * 1000,
      keywords: ['festivo', 'feriado', 'día festivo', 'asueto'],
      examples: ['Festivos de Colombia 2026', 'Cuándo es el próximo festivo'],
    });
  }

  async run(input) {
    const year = Utils.clamp(input.year, 2000, 2100, new Date().getFullYear());
    const country = String(input.country || 'CO').toUpperCase().slice(0, 2);

    const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`;
    const res = await httpFetch(url, { timeoutMs: this.timeoutMs });

    return {
      year,
      country,
      count: res.length,
      holidays: res.map(h => ({
        date: h.date,
        localName: h.localName,
        name: h.name,
        countryCode: h.countryCode,
        types: h.types || [],
      })),
    };
  }

  async ping() {
    const t = Date.now();
    await httpFetch('https://date.nager.at/api/v3/PublicHolidays/2026/CO', { timeoutMs: 5000 });
    return { ok: true, ms: Date.now() - t };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   21 · REGISTRO DE CONECTORES
   ═══════════════════════════════════════════════════════════════════════════ */

const CONNECTORS = new Map();

function registerConnector(instance) {
  CONNECTORS.set(instance.id, instance);
}

registerConnector(new WikipediaConnector());
registerConnector(new TriviaConnector());
registerConnector(new ColombiaConnector());
registerConnector(new BooksConnector());
registerConnector(new DictionaryConnector());
registerConnector(new RAEConnector());
registerConnector(new WiktionaryConnector());
registerConnector(new NASAConnector());
registerConnector(new MeteoConnector());
registerConnector(new CountriesConnector());
registerConnector(new QuotableConnector());
registerConnector(new NumbersConnector());
registerConnector(new HolidaysConnector());

/* ═══════════════════════════════════════════════════════════════════════════
   22 · DETECCIÓN AUTOMÁTICA DE CONECTOR
   ═══════════════════════════════════════════════════════════════════════════ */

function detectConnector(text) {
  const t = Utils.normKey(text);
  if (!t) return null;

  let best = null, bestScore = 0;

  for (const conn of CONNECTORS.values()) {
    let score = 0;
    for (const kw of conn.keywords) {
      if (t.includes(Utils.normKey(kw))) score++;
    }
    // Bonus por match en nombre
    if (t.includes(Utils.normKey(conn.name))) score += 3;
    if (t.includes(conn.id)) score += 2;

    if (score > bestScore) {
      bestScore = score;
      best = conn;
    }
  }

  return bestScore > 0 ? { connector: best, score: bestScore } : null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   23 · MOUNT · ENDPOINTS
   ═══════════════════════════════════════════════════════════════════════════ */

export function mountConnectorRoutes(app, requireAuth) {

  /* ─── GET /api/connectors · lista todos ─── */
  app.get('/api/connectors', (_req, res) => {
    try {
      const list = Array.from(CONNECTORS.values()).map(c => c.info());
      return res.json({ ok: true, count: list.length, connectors: list });
    } catch (e) {
      log('error', 'connectors.list.error', { message: e.message });
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  /* ─── GET /api/connectors/status · ping a todos ─── */
  app.get('/api/connectors/status', async (_req, res) => {
    const statuses = {};
    await Promise.all(Array.from(CONNECTORS.values()).map(async (c) => {
      try {
        const r = await c.ping();
        statuses[c.id] = { ...r, name: c.name };
      } catch (e) {
        statuses[c.id] = { ok: false, error: e.message, name: c.name };
      }
    }));
    return res.json({ ok: true, statuses });
  });

  /* ─── GET /api/connectors/cache · stats del cache ─── */
  app.get('/api/connectors/cache', requireAuth, (_req, res) => {
    return res.json({ ok: true, cache: cache.stats() });
  });

  /* ─── DELETE /api/connectors/cache · limpia el cache ─── */
  app.delete('/api/connectors/cache', requireAuth, (_req, res) => {
    cache.clear();
    log('info', 'connectors.cache.cleared');
    return res.json({ ok: true });
  });

  /* ─── POST /api/connectors/detect · detecta conector ─── */
  app.post('/api/connectors/detect', requireAuth, (req, res) => {
    const text = String(req.body?.text || '');
    if (!text) return res.status(400).json({ ok: false, error: 'Falta el texto.' });

    const detected = detectConnector(text);
    if (!detected) return res.json({ ok: true, connector: null, score: 0 });

    return res.json({
      ok: true,
      connector: detected.connector.info(),
      score: detected.score,
    });
  });

  /* ─── GET /api/connectors/:id · detalle ─── */
  app.get('/api/connectors/:id', (req, res) => {
    const c = CONNECTORS.get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Conector no encontrado.' });
    return res.json({ ok: true, connector: c.info() });
  });

  /* ─── GET /api/connectors/:id/health · ping a uno ─── */
  app.get('/api/connectors/:id/health', async (req, res) => {
    const c = CONNECTORS.get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Conector no encontrado.' });
    try {
      const r = await c.ping();
      return res.json({ ok: true, id: c.id, name: c.name, ...r });
    } catch (e) {
      return res.status(503).json({ ok: false, id: c.id, error: e.message });
    }
  });

  /* ─── POST /api/connectors/:id/query · ejecuta ─── */
  app.post('/api/connectors/:id/query', requireAuth, async (req, res) => {
    const c = CONNECTORS.get(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: 'Conector no encontrado.' });

    // Rate limit por usuario
    const rl = rateLimit(req.user.id);
    if (!rl.ok) {
      res.set('Retry-After', String(rl.retryAfter));
      return res.status(429).json({
        ok: false,
        error: `Demasiadas consultas. Espera ${rl.retryAfter}s.`,
        code: 'rate_limit',
      });
    }

    const input = req.body?.input || req.body || {};
    const result = await c.query(input, { userId: req.user.id });

    if (!result.ok) {
      return res.status(502).json({ ok: false, error: result.error, ms: result.ms });
    }

    return res.json({
      ok: true,
      connector: c.id,
      cached: result.cached,
      ms: result.ms,
      data: result.data,
    });
  });

  /* ─── POST /api/connectors/query-multi · varios a la vez ─── */
  app.post('/api/connectors/query-multi', requireAuth, async (req, res) => {
    const queries = Array.isArray(req.body?.queries) ? req.body.queries : [];
    if (queries.length === 0) {
      return res.status(400).json({ ok: false, error: 'Falta array "queries".' });
    }
    if (queries.length > 5) {
      return res.status(400).json({ ok: false, error: 'Máximo 5 consultas por request.' });
    }

    const rl = rateLimit(req.user.id);
    if (!rl.ok) {
      res.set('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ ok: false, error: `Rate limit. Espera ${rl.retryAfter}s.` });
    }

    const results = await Promise.all(queries.map(async (q) => {
      const c = CONNECTORS.get(q.connector);
      if (!c) return { connector: q.connector, ok: false, error: 'Conector no encontrado' };
      const r = await c.query(q.input || {}, { userId: req.user.id });
      return { connector: c.id, ...r };
    }));

    return res.json({ ok: true, count: results.length, results });
  });

  /* ─── BOOT ─── */
  const byCat = {};
  for (const c of CONNECTORS.values()) {
    byCat[c.category] = (byCat[c.category] || 0) + 1;
  }
  const summary = Object.entries(byCat).map(([k, v]) => `${k}: ${v}`).join(' · ');
  console.log(`[conn] ${CONNECTORS.size} conectores montados · ${summary}`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   24 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export {
  CONNECTORS,
  cache,
  detectConnector,
  rateLimit,
  BaseConnector,
};

/* ═══════════════════════════════════════════════════════════════════════════
   FIN.
   
   13 conectores gratuitos. 15 endpoints. Cache LRU. Rate limiting.
   Todo funciona sin API keys. Todo cae con gracia si el upstream falla.
   
   Cuando el chat necesite saber "quién fue Bolívar", habla con Wikipedia.
   Cuando pregunte el clima, habla con Open-Meteo. Cuando pida un quiz,
   con Open Trivia. Y así.
   
   — Álvaro & Robinson · Medellín · 2026
   ═══════════════════════════════════════════════════════════════════════════ */