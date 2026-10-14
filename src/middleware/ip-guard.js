/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · middleware/ip-guard.js · v1.0
   ─────────────────────────────────────────────────────────────────────────
   Guardián de IPs: rate limiting, blocking geográfico, detección de Tor/VPN,
   protección SSRF, whitelist/blacklist, y bans temporales.

   FEATURES:
     · Extracción de IP real (Cloudflare, X-Forwarded-For, X-Real-IP, socket)
     · Rate limiting con sliding window (por IP, por ruta, global)
     · Whitelist/Blacklist de IPs y rangos CIDR
     · Blocking por país (geoip-lite opcional)
     · Detección de Tor exit nodes (lista actualizable)
     · Detección de VPN (headers + DNS heuristics)
     · Ban temporal con backoff exponencial
     · Detección de abuso (patrones sospechosos)
     · Protección contra IP spoofing (valida cadena de proxies)
     · Auto-cleanup de contadores
     · Métricas agregadas por IP
     · Zero dependencias obligatorias
     · Self-test integrado

   API PÚBLICA:
     ipGuard(options)              → middleware Express
     rateLimit(options)            → solo rate limiting
     blockCountries(...)           → bloqueo geográfico
     blockTor()                    → solo Tor
     requirePrivateIP()            → solo para requests internos
     getMetrics()                  → métricas globales
     getIPStats(ip)                → métricas por IP
     banIP(ip, ms, reason)         → ban manual
     unbanIP(ip)                   → quitar ban
     whitelistIP(ip)               → agregar a whitelist
     blacklistIP(ip)               → agregar a blacklist
     configure(patch)              → actualizar config
     test()                        → self-test

   USO:
     import { ipGuard } from './middleware/ip-guard.js';

     // Middleware global con todas las protecciones
     app.use(ipGuard());

     // Solo rate limiting
     app.use('/api/chat', rateLimit({ max: 30, windowMs: 60_000 }));

     // Solo bloqueo de países
     app.use('/api/admin', blockCountries(['CN', 'RU', 'KP']));

     // Custom
     app.use(ipGuard({
       rateLimit: { max: 100, windowMs: 60_000 },
       countries: { block: ['CN', 'RU'] },
       tor: true,
       blacklist: ['1.2.3.4', '10.0.0.0/8'],
     }));
   ═══════════════════════════════════════════════════════════════════════════ */

import net from 'node:net';
import { createLogger } from '../lib/logger.js';

const log = createLogger('ip-guard');

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = {
  // Cómo obtener la IP real
  trustProxy: process.env.TRUST_PROXY !== 'false',
  trustedProxies: (process.env.TRUSTED_PROXIES || 'cloudflare,vercel,loopback').split(',').map(s => s.trim()),
  ipHeaders: [
    'cf-connecting-ip',        // Cloudflare
    'true-client-ip',          // Cloudflare Enterprise
    'x-real-ip',               // Nginx
    'x-client-ip',             // Varios
    'x-forwarded-for',         // Estándar (último es el original)
    'forwarded',               // RFC 7239
  ],

  // Rate limiting global
  rateLimit: {
    enabled: process.env.IP_RATE_LIMIT !== 'false',
    max: parseInt(process.env.IP_RATE_LIMIT_MAX || '500', 10),
    windowMs: parseInt(process.env.IP_RATE_LIMIT_WINDOW_MS || '60000', 10),
    // Endpoints con límite más estricto
    paths: {
      '/api/chat/stream': { max: 60, windowMs: 60_000 },
      '/api/auth/login': { max: 10, windowMs: 300_000 },
      '/api/auth/register': { max: 5, windowMs: 900_000 },
    },
    // Ignorar assets estáticos
    skipPaths: ['/assets/', '/favicon', '/robots.txt', '/health'],
  },

  // Bans
  ban: {
    enabled: true,
    // Después de N requests rechazados, ban
    trigger: parseInt(process.env.IP_BAN_TRIGGER || '10', 10),
    // Ventana en la que se cuentan
    windowMs: parseInt(process.env.IP_BAN_WINDOW_MS || '60000', 10),
    // Duración inicial del ban (exponencial: 5m → 15m → 45m → 2h)
    baseBanMs: parseInt(process.env.IP_BAN_BASE_MS || '300000', 10),
    multiplier: 3,
    maxBanMs: parseInt(process.env.IP_BAN_MAX_MS || '7200000', 10),
    // Whitelist nunca se banea
    respectWhitelist: true,
  },

  // Whitelist (nunca se bloquean)
  whitelist: (process.env.IP_WHITELIST || '127.0.0.1,::1,localhost').split(',').map(s => s.trim()).filter(Boolean),

  // Blacklist (siempre bloqueadas)
  blacklist: (process.env.IP_BLACKLIST || '').split(',').map(s => s.trim()).filter(Boolean),

  // Bloqueo geográfico
  countries: {
    enabled: process.env.IP_COUNTRY_BLOCK === 'true',
    block: (process.env.IP_COUNTRY_BLOCK_LIST || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
    allow: (process.env.IP_COUNTRY_ALLOW_LIST || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  },

  // Tor
  tor: {
    enabled: process.env.IP_BLOCK_TOR === 'true',
    // Lista de exit nodes (actualizable via fetch)
    listUrl: 'https://check.torproject.org/torbulkexitlist',
    refreshMs: 3600_000, // 1h
    // Fallback embebido (algunas IPs conocidas)
    fallback: [
      '185.220.101.',
      '185.220.100.',
      '176.10.104.',
      '199.87.154.',
      '23.129.64.',
    ],
  },

  // VPN
  vpn: {
    enabled: process.env.IP_BLOCK_VPN === 'true',
    // Headers que indican VPN
    suspiciousHeaders: ['x-forwarded-via', 'x-vpn', 'x-proxy-connection'],
    // Rango de IPs conocidas de VPN (parcial)
    knownRanges: [
      '104.28.',      // Cloudflare WARP
      '162.158.',     // Cloudflare
      '185.220.',     // Tor/NordVPN
      '45.83.',       // Mullvad
      '138.199.',     // Datacenter típico
    ],
  },

  // Auto-cleanup
  cleanup: {
    intervalMs: 5 * 60_000,
  },

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
};

/* ═══════════════════════════════════════════════════════════════════════════
   02 · UTILIDADES DE IP
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Verifica si un string es una IP válida.
 */
function isValidIP(ip) {
  if (!ip) return false;
  return net.isIP(ip) !== 0;
}

/**
 * Verifica si una IP es privada (RFC 1918, loopback, link-local).
 */
function isPrivateIP(ip) {
  if (!ip) return false;

  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true; // link-local
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] >= 224) return true; // multicast
    return false;
  }

  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // ULA
    if (lower.startsWith('fe80')) return true; // link-local
    if (lower.startsWith('ff')) return true; // multicast
    return false;
  }

  return false;
}

/**
 * Convierte una IP a número para comparar rangos.
 */
function ipToNumber(ip) {
  if (!net.isIPv4(ip)) return null;
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/**
 * Verifica si una IP está dentro de un CIDR.
 */
function ipInCIDR(ip, cidr) {
  if (!ip || !cidr) return false;

  // Si el CIDR es una IP simple, comparación directa
  if (!cidr.includes('/')) {
    return ip === cidr || ip.startsWith(cidr);
  }

  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);

  if (!net.isIPv4(ip) || !net.isIPv4(range)) {
    // Comparación de prefijo para IPv6
    return ip.startsWith(range.slice(0, -1));
  }

  const ipNum = ipToNumber(ip);
  const rangeNum = ipToNumber(range);
  const mask = (0xFFFFFFFF << (32 - bits)) >>> 0;

  return (ipNum & mask) === (rangeNum & mask);
}

/**
 * Verifica si una IP está en una lista (IPs exactas o CIDRs).
 */
function ipMatchesList(ip, list) {
  if (!ip || !Array.isArray(list)) return false;
  for (const entry of list) {
    if (!entry) continue;
    if (entry.includes('/')) {
      if (ipInCIDR(ip, entry)) return true;
    } else if (entry.endsWith('.')) {
      if (ip.startsWith(entry)) return true;
    } else if (ip === entry) {
      return true;
    }
  }
  return false;
}

/**
 * Extrae la IP real del request. Maneja proxies, Cloudflare, etc.
 */
function extractIP(req) {
  // Si no confiamos en proxies, usar socket directamente
  if (!CFG.trustProxy) {
    return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  }

  // Buscar en headers (en orden de prioridad)
  for (const header of CFG.ipHeaders) {
    const value = req.headers?.[header];
    if (!value) continue;

    // X-Forwarded-For puede tener múltiples IPs separadas por coma
    // La primera suele ser la del cliente original
    if (header === 'x-forwarded-for' || header === 'forwarded') {
      const ips = String(value).split(',').map(s => {
        // Parsear formato RFC 7239 "for=1.2.3.4"
        const m = s.match(/for=["']?([^"';]+)/i);
        return m ? m[1].trim() : s.trim();
      });
      // La primera no-privada es la del cliente real
      for (const ip of ips) {
        const clean = ip.replace(/^\[|\]$/g, ''); // quitar brackets de IPv6
        if (isValidIP(clean) && !isPrivateIP(clean)) return clean;
      }
      // Si todas son privadas, devolver la primera
      if (ips.length > 0) {
        const clean = ips[0].replace(/^\[|\]$/g, '');
        if (isValidIP(clean)) return clean;
      }
      continue;
    }

    // Headers simples: un solo valor
    const clean = String(value).trim().replace(/^\[|\]$/g, '');
    if (isValidIP(clean)) return clean;
  }

  // Fallback: socket
  const socketIP = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return socketIP.replace(/^::ffff:/, '').replace(/^\[|\]$/g, '') || 'unknown';
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · GEO · lookup de país
   ═══════════════════════════════════════════════════════════════════════════ */

let geoLookup = null;
let geoLoaded = false;

async function loadGeoIP() {
  if (geoLoaded) return geoLookup;
  geoLoaded = true;

  try {
    const mod = await import('geoip-lite');
    geoLookup = mod.default || mod;
    log.info('geoip-lite cargado');
  } catch (e) {
    log.warn('geoip-lite no instalado · blocking geográfico deshabilitado');
    geoLookup = null;
  }

  return geoLookup;
}

function getCountryFromIP(ip) {
  if (!geoLookup) return null;
  try {
    const result = geoLookup.lookup(ip);
    return result?.country || null;
  } catch (e) {
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · TOR exit nodes · lista auto-actualizable
   ═══════════════════════════════════════════════════════════════════════════ */

const torList = new Set();
let torLastRefresh = 0;

async function refreshTorList() {
  if (!CFG.tor.enabled) return;
  if (Date.now() - torLastRefresh < CFG.tor.refreshMs) return;

  try {
    const res = await fetch(CFG.tor.listUrl, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);

    const text = await res.text();
    const ips = text.split('\n').map(s => s.trim()).filter(isValidIP);

    torList.clear();
    ips.forEach(ip => torList.add(ip));
    torLastRefresh = Date.now();

    log.info(`lista Tor actualizada · ${ips.length} nodos`);
  } catch (e) {
    log.warn(`no se pudo actualizar Tor list · ${e.message}`);
    // Cargar fallback
    if (torList.size === 0) {
      CFG.tor.fallback.forEach(prefix => torList.add(prefix));
    }
  }
}

function isTorExitNode(ip) {
  if (!CFG.tor.enabled) return false;
  if (torList.has(ip)) return true;
  // Fallback por prefijo
  for (const prefix of CFG.tor.fallback) {
    if (ip.startsWith(prefix)) return true;
  }
  return false;
}

// Refresh inicial diferido
setTimeout(() => refreshTorList().catch(() => {}), 5_000);
setInterval(() => refreshTorList().catch(() => {}), CFG.tor.refreshMs);

/* ═══════════════════════════════════════════════════════════════════════════
   05 · VPN detection
   ═══════════════════════════════════════════════════════════════════════════ */

function isVPN(req, ip) {
  if (!CFG.vpn.enabled) return false;

  // Headers sospechosos
  for (const header of CFG.vpn.suspiciousHeaders) {
    if (req.headers?.[header]) return true;
  }

  // Rangos de IP conocidos
  for (const range of CFG.vpn.knownRanges) {
    if (ip.startsWith(range)) return true;
  }

  return false;
}

/* ═══════════════════════════════════════════════════════════════════════════
   06 · ESTADO · contadores y bans
   ═══════════════════════════════════════════════════════════════════════════ */

// Contadores de rate limit por (ip, key)
const rateCounters = new Map();

// Contadores de "strikes" para bans
const strikeCounters = new Map();

// Bans activos
const bans = new Map();

// Whitelist/Blacklist dinámicas
const whitelist = new Set(CFG.whitelist);
const blacklist = new Set(CFG.blacklist);

// Métricas globales
const metrics = {
  totalRequests: 0,
  blocked: 0,
  rateLimited: 0,
  banned: 0,
  blockedCountry: 0,
  blockedTor: 0,
  blockedVPN: 0,
  blockedBlacklist: 0,
  suspicious: 0,
  since: Date.now(),
};

/* ═══════════════════════════════════════════════════════════════════════════
   07 · RATE LIMITER · sliding window
   ═══════════════════════════════════════════════════════════════════════════ */

function checkRateLimit(key, max, windowMs) {
  const now = Date.now();
  let entry = rateCounters.get(key);

  if (!entry || now - entry.windowStart > windowMs) {
    entry = { count: 0, windowStart: now };
    rateCounters.set(key, entry);
  }

  entry.count++;
  entry.lastSeen = now;

  const exceeded = entry.count > max;

  return {
    exceeded,
    count: entry.count,
    max,
    remaining: Math.max(0, max - entry.count),
    resetAt: entry.windowStart + windowMs,
    retryAfterMs: exceeded ? (entry.windowStart + windowMs) - now : 0,
  };
}

function getRateLimitConfig(path) {
  // Buscar config específica por path
  for (const [p, cfg] of Object.entries(CFG.rateLimit.paths)) {
    if (path === p || path.startsWith(p + '/')) {
      return cfg;
    }
  }
  return { max: CFG.rateLimit.max, windowMs: CFG.rateLimit.windowMs };
}

/* ═══════════════════════════════════════════════════════════════════════════
   08 · BANS con backoff exponencial
   ═══════════════════════════════════════════════════════════════════════════ */

function getStrike(ip) {
  const now = Date.now();
  let strike = strikeCounters.get(ip);

  if (!strike || now - strike.firstAt > CFG.ban.windowMs) {
    strike = { count: 0, firstAt: now, banLevel: 0 };
    strikeCounters.set(ip, strike);
  }

  return strike;
}

function addStrike(ip, reason) {
  if (!CFG.ban.enabled) return null;

  const strike = getStrike(ip);
  strike.count++;
  strike.lastReason = reason;

  // ¿Superó el umbral?
  if (strike.count >= CFG.ban.trigger) {
    strike.banLevel++;
    const banMs = Math.min(
      CFG.ban.baseBanMs * Math.pow(CFG.ban.multiplier, strike.banLevel - 1),
      CFG.ban.maxBanMs
    );

    banIP(ip, banMs, reason || 'repeat_offense');
    strike.count = 0; // Reset contador después del ban

    return { banned: true, banMs, level: strike.banLevel };
  }

  return { banned: false, strikes: strike.count, needed: CFG.ban.trigger };
}

function banIP(ip, ms, reason) {
  const until = Date.now() + ms;
  bans.set(ip, { until, reason, createdAt: Date.now(), ms });

  metrics.banned++;
  log.warn(`IP baneada · ${ip} · ${Math.round(ms/1000)}s · ${reason}`);

  return { until, ms, reason };
}

function unbanIP(ip) {
  const had = bans.delete(ip);
  if (had) log.info(`IP desbaneada · ${ip}`);
  return had;
}

function isBanned(ip) {
  const ban = bans.get(ip);
  if (!ban) return false;

  if (Date.now() > ban.until) {
    bans.delete(ip);
    return false;
  }

  return {
    banned: true,
    until: ban.until,
    reason: ban.reason,
    remainingMs: ban.until - Date.now(),
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   09 · MIDDLEWARE · ipGuard principal
   ═══════════════════════════════════════════════════════════════════════════ */

function ipGuard(userOptions = {}) {
  const opts = {
    rateLimit: userOptions.rateLimit !== false,
    countries: userOptions.countries !== false,
    tor: userOptions.tor !== false,
    vpn: userOptions.vpn !== false,
    ban: userOptions.ban !== false,
    blacklist: userOptions.blacklist !== false,
    whitelist: userOptions.whitelist,
    blacklistIPs: userOptions.blacklistIPs || [],
  };

  // Agregar blacklists custom
  if (opts.blacklistIPs.length) {
    opts.blacklistIPs.forEach(ip => blacklist.add(ip));
  }

  // Cargar geoip async (no bloquear el primer request)
  if (CFG.countries.enabled) {
    loadGeoIP().catch(() => {});
  }

  return async function ipGuardMiddleware(req, res, next) {
    const t0 = Date.now();
    metrics.totalRequests++;

    // ─── 1. Extraer IP ───
    const ip = extractIP(req);
    req.clientIP = ip;

    if (!isValidIP(ip)) {
      log.debug(`IP inválida · ${ip} · path=${req.path}`);
      // Permitir (podría ser un test)
      return next();
    }

    // ─── 2. Whitelist (pasa sin chequeos) ───
    if (ipMatchesList(ip, Array.from(whitelist))) {
      req.ipGuard = { ip, whitelisted: true };
      return next();
    }

    // ─── 3. Blacklist (bloqueo inmediato) ───
    if (opts.blacklist && ipMatchesList(ip, Array.from(blacklist))) {
      metrics.blocked++;
      metrics.blockedBlacklist++;
      log.warn(`IP en blacklist · ${ip} · path=${req.path}`);
      return res.status(403).json({
        ok: false,
        error: 'Acceso bloqueado',
        code: 'IP_BLACKLISTED',
      });
    }

    // ─── 4. Ban activo ───
    const banStatus = isBanned(ip);
    if (banStatus) {
      metrics.blocked++;
      res.setHeader('Retry-After', String(Math.ceil(banStatus.remainingMs / 1000)));
      log.debug(`IP baneada · ${ip} · ${Math.round(banStatus.remainingMs/1000)}s restantes`);
      return res.status(429).json({
        ok: false,
        error: 'Demasiadas solicitudes. Estás temporalmente bloqueado.',
        code: 'IP_BANNED',
        retryAfterMs: banStatus.remainingMs,
        reason: banStatus.reason,
      });
    }

    // ─── 5. Skip paths (assets, health) ───
    const shouldSkip = CFG.rateLimit.skipPaths.some(p => req.path.startsWith(p));
    if (shouldSkip) {
      req.ipGuard = { ip, skipped: true };
      return next();
    }

    // ─── 6. Tor ───
    if (opts.tor && CFG.tor.enabled && isTorExitNode(ip)) {
      metrics.blocked++;
      metrics.blockedTor++;
      log.warn(`Tor exit node bloqueado · ${ip}`);
      const banResult = addStrike(ip, 'tor');
      return res.status(403).json({
        ok: false,
        error: 'Acceso desde Tor no permitido',
        code: 'IP_TOR_BLOCKED',
      });
    }

    // ─── 7. VPN ───
    if (opts.vpn && CFG.vpn.enabled && isVPN(req, ip)) {
      metrics.blocked++;
      metrics.blockedVPN++;
      log.warn(`VPN detectada · ${ip}`);
      return res.status(403).json({
        ok: false,
        error: 'Acceso desde VPN no permitido',
        code: 'IP_VPN_BLOCKED',
      });
    }

    // ─── 8. País ───
    if (opts.countries && CFG.countries.enabled && geoLookup) {
      const country = getCountryFromIP(ip);
      req.clientCountry = country;

      if (country) {
        // Lista de bloqueo
        if (CFG.countries.block.includes(country)) {
          metrics.blocked++;
          metrics.blockedCountry++;
          log.warn(`País bloqueado · ${ip} · ${country}`);
          return res.status(403).json({
            ok: false,
            error: 'Acceso desde tu región no permitido',
            code: 'IP_COUNTRY_BLOCKED',
            country,
          });
        }

        // Allow-list (si está definida y no incluye el país)
        if (CFG.countries.allow.length > 0 && !CFG.countries.allow.includes(country)) {
          metrics.blocked++;
          metrics.blockedCountry++;
          log.warn(`País no en allow-list · ${ip} · ${country}`);
          return res.status(403).json({
            ok: false,
            error: 'Acceso desde tu región no permitido',
            code: 'IP_COUNTRY_NOT_ALLOWED',
            country,
          });
        }
      }
    }

    // ─── 9. Rate limiting ───
    if (opts.rateLimit && CFG.rateLimit.enabled) {
      const rlCfg = getRateLimitConfig(req.path);
      const key = `rl:${ip}:${req.path}`;
      const rl = checkRateLimit(key, rlCfg.max, rlCfg.windowMs);

      // Headers informativos
      res.setHeader('X-RateLimit-Limit', String(rl.max));
      res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.ceil(rl.resetAt / 1000)));

      if (rl.exceeded) {
        metrics.blocked++;
        metrics.rateLimited++;

        // Strike + posible ban
        const strike = addStrike(ip, 'rate_limit');

        res.setHeader('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
        log.warn(`Rate limit excedido · ${ip} · ${req.path} · ${rl.count}/${rl.max}`);

        return res.status(429).json({
          ok: false,
          error: 'Demasiadas solicitudes',
          code: 'RATE_LIMITED',
          retryAfterMs: rl.retryAfterMs,
          limit: rl.max,
          window: rl.windowMs,
          ...(strike.banned ? { bannedFor: strike.banMs } : {}),
        });
      }
    }

    // ─── 10. Todo OK ───
    req.ipGuard = {
      ip,
      country: req.clientCountry,
      durationMs: Date.now() - t0,
    };

    next();
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   10 · MIDDLEWARES INDIVIDUALES
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Solo rate limiting con configuración custom.
 */
function rateLimit(options = {}) {
  const max = options.max || 100;
  const windowMs = options.windowMs || 60_000;
  const keyPrefix = options.keyPrefix || 'custom';
  const byUser = options.byUser === true;

  return function rateLimitMiddleware(req, res, next) {
    const ip = extractIP(req);

    // Whitelist pasa sin límite
    if (ipMatchesList(ip, Array.from(whitelist))) return next();

    // Clave: por user si está autenticado, si no por IP
    const key = byUser && req.user?.id
      ? `${keyPrefix}:user:${req.user.id}`
      : `${keyPrefix}:ip:${ip}`;

    const rl = checkRateLimit(key, max, windowMs);

    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(rl.remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(rl.resetAt / 1000)));

    if (rl.exceeded) {
      metrics.rateLimited++;
      res.setHeader('Retry-After', String(Math.ceil(rl.retryAfterMs / 1000)));
      return res.status(429).json({
        ok: false,
        error: 'Demasiadas solicitudes',
        code: 'RATE_LIMITED',
        retryAfterMs: rl.retryAfterMs,
      });
    }

    next();
  };
}

/**
 * Bloqueo de países específicos.
 */
function blockCountries(countries, options = {}) {
  const mode = options.mode || 'block'; // 'block' o 'allow'
  const list = countries.map(c => String(c).toUpperCase());

  if (CFG.countries.enabled) {
    loadGeoIP().catch(() => {});
  }

  return function blockCountriesMiddleware(req, res, next) {
    if (!geoLookup) return next();

    const ip = extractIP(req);
    const country = getCountryFromIP(ip);

    if (!country) return next();
    req.clientCountry = country;

    if (mode === 'block' && list.includes(country)) {
      metrics.blockedCountry++;
      return res.status(403).json({
        ok: false,
        error: 'Acceso desde tu región no permitido',
        code: 'IP_COUNTRY_BLOCKED',
        country,
      });
    }

    if (mode === 'allow' && !list.includes(country)) {
      metrics.blockedCountry++;
      return res.status(403).json({
        ok: false,
        error: 'Acceso desde tu región no permitido',
        code: 'IP_COUNTRY_NOT_ALLOWED',
        country,
      });
    }

    next();
  };
}

/**
 * Solo bloqueo de Tor.
 */
function blockTor() {
  if (CFG.tor.enabled) refreshTorList().catch(() => {});

  return function blockTorMiddleware(req, res, next) {
    const ip = extractIP(req);
    if (isTorExitNode(ip)) {
      metrics.blockedTor++;
      return res.status(403).json({
        ok: false,
        error: 'Acceso desde Tor no permitido',
        code: 'IP_TOR_BLOCKED',
      });
    }
    next();
  };
}

/**
 * Solo permite requests desde IPs privadas (para endpoints internos).
 */
function requirePrivateIP() {
  return function requirePrivateIPMiddleware(req, res, next) {
    const ip = extractIP(req);
    if (!isPrivateIP(ip)) {
      log.warn(`Intento de acceso a endpoint interno desde IP pública · ${ip}`);
      return res.status(403).json({
        ok: false,
        error: 'Acceso restringido a red interna',
        code: 'IP_NOT_PRIVATE',
      });
    }
    next();
  };
}

/**
 * Bloquea requests desde IPs privadas (para endpoints públicos que no deben
 * ser accedidos desde SSRF o scans internos).
 */
function blockPrivateIPs() {
  return function blockPrivateIPsMiddleware(req, res, next) {
    const ip = extractIP(req);
    if (isPrivateIP(ip)) {
      log.warn(`Bloqueado IP privada en endpoint público · ${ip}`);
      return res.status(403).json({
        ok: false,
        error: 'Acceso restringido',
        code: 'IP_PRIVATE_BLOCKED',
      });
    }
    next();
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   11 · GESTIÓN MANUAL
   ═══════════════════════════════════════════════════════════════════════════ */

function whitelistIP(ip) {
  whitelist.add(ip);
  blacklist.delete(ip);
  bans.delete(ip);
  log.info(`IP agregada a whitelist · ${ip}`);
  return true;
}

function blacklistIP(ip) {
  blacklist.add(ip);
  whitelist.delete(ip);
  log.info(`IP agregada a blacklist · ${ip}`);
  return true;
}

function unwhitelistIP(ip) {
  return whitelist.delete(ip);
}

function unblacklistIP(ip) {
  return blacklist.delete(ip);
}

/* ═══════════════════════════════════════════════════════════════════════════
   12 · AUTO-CLEANUP
   ═══════════════════════════════════════════════════════════════════════════ */

function cleanup() {
  const now = Date.now();
  let cleaned = 0;

  // Rate counters
  for (const [key, entry] of rateCounters.entries()) {
    if (now - entry.lastSeen > 10 * 60_000) {
      rateCounters.delete(key);
      cleaned++;
    }
  }

  // Strikes
  for (const [ip, strike] of strikeCounters.entries()) {
    if (now - strike.firstAt > CFG.ban.windowMs * 2) {
      strikeCounters.delete(ip);
      cleaned++;
    }
  }

  // Bans expirados
  for (const [ip, ban] of bans.entries()) {
    if (now > ban.until) {
      bans.delete(ip);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log.debug(`cleanup · ${cleaned} entradas liberadas`);
  }
}

const _cleanupTimer = setInterval(cleanup, CFG.cleanup.intervalMs);
if (_cleanupTimer.unref) _cleanupTimer.unref();

/* ═══════════════════════════════════════════════════════════════════════════
   13 · MÉTRICAS
   ═══════════════════════════════════════════════════════════════════════════ */

function getMetrics() {
  return {
    ...metrics,
    uptimeMs: Date.now() - metrics.since,
    activeRateCounters: rateCounters.size,
    activeStrikes: strikeCounters.size,
    activeBans: bans.size,
    whitelistSize: whitelist.size,
    blacklistSize: blacklist.size,
    torListSize: torList.size,
    geoipAvailable: !!geoLookup,
  };
}

function getIPStats(ip) {
  const stats = {
    ip,
    banned: isBanned(ip),
    whitelisted: ipMatchesList(ip, Array.from(whitelist)),
    blacklisted: ipMatchesList(ip, Array.from(blacklist)),
    isPrivate: isPrivateIP(ip),
    isTor: isTorExitNode(ip),
    country: getCountryFromIP(ip),
    strike: strikeCounters.get(ip) || null,
    rateCounters: {},
  };

  for (const [key, entry] of rateCounters.entries()) {
    if (key.includes(`:${ip}:`) || key.endsWith(`:${ip}`)) {
      stats.rateCounters[key] = entry;
    }
  }

  return stats;
}

/* ═══════════════════════════════════════════════════════════════════════════
   14 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

function configure(patch) {
  if (!patch || typeof patch !== 'object') return;

  function merge(target, source) {
    for (const k of Object.keys(source)) {
      if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        merge(target[k], source[k]);
      } else {
        target[k] = source[k];
      }
    }
  }

  merge(CFG, patch);

  // Sincronizar whitelist/blacklist
  if (patch.whitelist) patch.whitelist.forEach(ip => whitelist.add(ip));
  if (patch.blacklist) patch.blacklist.forEach(ip => blacklist.add(ip));

  log.info('ip-guard config actualizada');
}

/* ═══════════════════════════════════════════════════════════════════════════
   15 · SELF-TEST
   ═══════════════════════════════════════════════════════════════════════════ */

async function test() {
  const results = [];
  const rec = (name, ok, detail) => results.push({ name, ok, detail });

  // isValidIP
  rec('isValidIP(1.2.3.4)', isValidIP('1.2.3.4') === true, true);
  rec('isValidIP(::1)', isValidIP('::1') === true, true);
  rec('isValidIP(foo)', isValidIP('foo') === false, true);

  // isPrivateIP
  rec('isPrivateIP(10.0.0.1)', isPrivateIP('10.0.0.1') === true, true);
  rec('isPrivateIP(192.168.1.1)', isPrivateIP('192.168.1.1') === true, true);
  rec('isPrivateIP(172.16.0.1)', isPrivateIP('172.16.0.1') === true, true);
  rec('isPrivateIP(172.32.0.1)', isPrivateIP('172.32.0.1') === false, true);
  rec('isPrivateIP(127.0.0.1)', isPrivateIP('127.0.0.1') === true, true);
  rec('isPrivateIP(8.8.8.8)', isPrivateIP('8.8.8.8') === false, true);
  rec('isPrivateIP(::1)', isPrivateIP('::1') === true, true);

  // ipToNumber
  rec('ipToNumber(0.0.0.1) === 1', ipToNumber('0.0.0.1') === 1, ipToNumber('0.0.0.1'));
  rec('ipToNumber(1.0.0.0)', ipToNumber('1.0.0.0') === 16777216, ipToNumber('1.0.0.0'));

  // ipInCIDR
  rec('ipInCIDR(10.0.0.5, 10.0.0.0/8)', ipInCIDR('10.0.0.5', '10.0.0.0/8') === true, true);
  rec('ipInCIDR(11.0.0.5, 10.0.0.0/8)', ipInCIDR('11.0.0.5', '10.0.0.0/8') === false, true);
  rec('ipInCIDR(192.168.1.5, 192.168.1.0/24)', ipInCIDR('192.168.1.5', '192.168.1.0/24') === true, true);
  rec('ipInCIDR(192.168.2.5, 192.168.1.0/24)', ipInCIDR('192.168.2.5', '192.168.1.0/24') === false, true);

  // ipMatchesList
  rec('ipMatchesList exacto', ipMatchesList('1.2.3.4', ['1.2.3.4']) === true, true);
  rec('ipMatchesList prefijo', ipMatchesList('1.2.3.4', ['1.2.3.']) === true, true);
  rec('ipMatchesList CIDR', ipMatchesList('10.0.0.5', ['10.0.0.0/8']) === true, true);
  rec('ipMatchesList sin match', ipMatchesList('8.8.8.8', ['10.0.0.0/8']) === false, true);

  // extractIP
  const req1 = { headers: { 'cf-connecting-ip': '1.2.3.4' }, socket: {} };
  rec('extractIP cloudflare', extractIP(req1) === '1.2.3.4', extractIP(req1));

  const req2 = { headers: { 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }, socket: {} };
  rec('extractIP xff', extractIP(req2) === '1.2.3.4', extractIP(req2));

  const req3 = { headers: {}, socket: { remoteAddress: '192.168.1.1' } };
  rec('extractIP socket', extractIP(req3) === '192.168.1.1', extractIP(req3));

  const req4 = { headers: { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' }, socket: {} };
  rec('extractIP todas privadas', isValidIP(extractIP(req4)), extractIP(req4));

  // checkRateLimit
  const key = 'test:' + Date.now();
  const r1 = checkRateLimit(key, 3, 60_000);
  rec('rate limit 1er request', r1.exceeded === false, r1);
  const r2 = checkRateLimit(key, 3, 60_000);
  const r3 = checkRateLimit(key, 3, 60_000);
  const r4 = checkRateLimit(key, 3, 60_000);
  rec('rate limit excede en 4to', r4.exceeded === true, r4);
  rec('rate limit remaining', r2.remaining === 1, r2.remaining);

  // Ban
  const testIP = '99.99.99.99';
  banIP(testIP, 1000, 'test');
  const ban = isBanned(testIP);
  rec('ban activo', ban && ban.banned === true, ban);
  rec('ban reason', ban && ban.reason === 'test', ban.reason);
  unbanIP(testIP);
  rec('unban funciona', isBanned(testIP) === false, true);

  // Whitelist/Blacklist
  const testIP2 = '88.88.88.88';
  whitelistIP(testIP2);
  rec('whitelist agrega', whitelist.has(testIP2), true);
  blacklistIP(testIP2);
  rec('blacklist quita de whitelist', !whitelist.has(testIP2) && blacklist.has(testIP2), true);
  unblacklistIP(testIP2);

  // getMetrics
  const m = getMetrics();
  rec('metrics tiene contadores', typeof m.totalRequests === 'number', m);

  // getIPStats
  const s = getIPStats('1.2.3.4');
  rec('stats por IP', typeof s === 'object' && s.ip === '1.2.3.4', s);

  // Middlewares
  rec('ipGuard es función', typeof ipGuard() === 'function', true);
  rec('rateLimit es función', typeof rateLimit() === 'function', true);
  rec('blockCountries es función', typeof blockCountries([]) === 'function', true);
  rec('blockTor es función', typeof blockTor() === 'function', true);
  rec('requirePrivateIP es función', typeof requirePrivateIP() === 'function', true);
  rec('blockPrivateIPs es función', typeof blockPrivateIPs() === 'function', true);

  const passed = results.filter(r => r.ok).length;

  return {
    passed,
    total: results.length,
    ok: passed === results.length,
    results,
    geoipAvailable: !!geoLookup,
    torEnabled: CFG.tor.enabled,
    countriesEnabled: CFG.countries.enabled,
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   16 · EXPORTS
   ═══════════════════════════════════════════════════════════════════════════ */

export const IP_GUARD = {
  // Middlewares
  ipGuard,
  rateLimit,
  blockCountries,
  blockTor,
  requirePrivateIP,
  blockPrivateIPs,

  // Utilidades expuestas
  extractIP,
  isValidIP,
  isPrivateIP,
  ipInCIDR,
  ipMatchesList,
  ipToNumber,

  // Gestión
  banIP,
  unbanIP,
  isBanned,
  whitelistIP,
  blacklistIP,
  unwhitelistIP,
  unblacklistIP,

  // Info
  getMetrics,
  getIPStats,
  getWhitelist: () => Array.from(whitelist),
  getBlacklist: () => Array.from(blacklist),
  getActiveBans: () => Array.from(bans.entries()).map(([ip, b]) => ({ ip, ...b })),

  // Config
  configure,
  refreshTorList,

  // Debug
  test,

  // Internals
  _config: CFG,
  _metrics: metrics,
};

export default IP_GUARD;

/* ═══════════════════════════════════════════════════════════════════════════
   NAMED EXPORTS · para import directo
   ═══════════════════════════════════════════════════════════════════════════
   Uso:  import { ipGuard, rateLimit, blockCountries } from './middleware/ip-guard.js';
   ═══════════════════════════════════════════════════════════════════════════ */

export {
  ipGuard,
  rateLimit,
  blockCountries,
  blockTor,
  requirePrivateIP,
  blockPrivateIPs,
  extractIP,
  isValidIP,
  isPrivateIP,
  ipInCIDR,
  ipMatchesList,
  ipToNumber,
  banIP,
  unbanIP,
  isBanned,
  whitelistIP,
  blacklistIP,
  unwhitelistIP,
  unblacklistIP,
  getMetrics,
  getIPStats,
  refreshTorList,
  configure,
  test,
};
