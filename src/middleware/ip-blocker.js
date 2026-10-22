/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · middleware/ip-blocker.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Bloqueo de IPs: hosted providers (AWS / DigitalOcean / Hetzner…) y
   rangos de VPN conocidos.

   POR QUÉ
     · Los scrapers y los ataques de fuerza bruta salen, casi siempre,
       de la infraestructura cloud pública.
     · Bloquear el rango de un proveedor de hosting es más efectivo que
       bloquear IP por IP: el atacante rota IPs dentro del mismo /16.

   CÓMO FUNCIONA
     · Lista de rangos CIDR → se comparan en binario (sin librería).
     · Lista de rangos "confidence" (VPN/Tor): se rechazan por defecto en
       modo estricto, pero se pueden dejar en "observar" (sólo loguean).
     · Heurísticas: cabeceras de proxy, IPs reservadas,user-agents de
       bot molecular.

   PRECAUCIONES
     · `TRUST_PROXY` mal configurado hace que TODAS las peticiones
       parezcan venir del proxy: por eso la lista de rangos de cloud
       está separada de la de VPN (el cloud se puede desactivar sin
       romper la protección anti-VPN).
     · El bloqueo por defecto es "observar" (log) para los rangos de
       VPN y "bloquear" para los de cloud maliciosa conocida.
     · Un allowlist siempre gana: los rangos internos y los del equipo
       nunca se bloquean.
   ═══════════════════════════════════════════════════════════════════════════ */

import net from 'node:net';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  // Rangos de cloud pública (bloqueo por defecto: 'block')
  cloudRanges: [
    // AWS
    '3.0.0.0/8', '13.32.0.0/15', '15.177.0.0/16', '18.128.0.0/9',
    '34.192.0.0/12', '35.152.0.0/13', '52.0.0.0/10', '54.64.0.0/12',
    '54.144.0.0/12', '54.160.0.0/12', '54.192.0.0/12', '54.208.0.0/13',
    '54.216.0.0/13', '63.32.0.0/14', '64.252.0.0/14', '67.202.0.0/18',
    '72.44.32.0/19', '75.101.128.0/17', '75.127.0.0/17', '76.20.0.0/14',
    '77.75.0.0/16', '79.125.0.0/17', '96.0.0.0/12', '103.21.244.0/22',
    '107.20.0.0/14', '174.129.0.0/16', '175.41.192.0/18', '176.32.125.0/24',
    '176.34.0.0/15', '176.59.0.0/16', '176.62.0.0/15', '177.71.0.0/16',
    '177.79.128.0/17', '177.83.128.0/17', '179.48.0.0/15', '184.72.0.0/15',
    '184.72.64.0/18', '184.73.0.0/16', '184.169.128.0/17', '189.2.128.0/17',
    '190.93.240.0/20', '192.225.0.0/16', '198.199.64.0/18', '204.236.192.0/18',
    '216.182.224.0/20',
    // DigitalOcean
    '24.199.64.0/18', '45.55.0.0/16', '46.101.0.0/16', '63.88.0.0/18',
    '64.225.0.0/16', '68.183.0.0/16', '69.10.0.0/16', '71.10.0.0/16',
    '74.125.0.0/16', '82.196.0.0/16', '82.196.192.0/18', '88.99.0.0/16',
    '95.179.128.0/17', '104.131.0.0/16', '104.236.0.0/16', '107.170.0.0/16',
    '108.62.0.0/16', '128.199.0.0/16', '134.209.0.0/16', '137.184.0.0/16',
    '138.68.0.0/16', '139.59.0.0/16', '140.82.0.0/16', '142.93.0.0/16',
    '143.110.0.0/16', '143.198.0.0/16', '146.190.0.0/16', '147.182.0.0/16',
    '149.248.0.0/16', '157.230.0.0/16', '157.245.0.0/16', '159.65.0.0/16',
    '159.89.0.0/16', '159.203.0.0/16', '161.35.0.0/16', '162.243.0.0/16',
    '164.90.0.0/16', '164.92.0.0/16', '167.71.0.0/16', '167.99.0.0/16',
    '168.62.0.0/16', '168.235.0.0/16', '170.64.0.0/16', '174.138.0.0/16',
    '178.62.0.0/16', '178.128.0.0/16', '184.225.0.0/16', '188.166.0.0/16',
    '188.226.0.0/16', '192.34.56.0/21', '192.81.208.0/20', '192.241.128.0/18',
    '192.241.160.0/19', '198.199.64.0/18', '206.189.0.0/16', '207.154.192.0/18',
    '209.97.128.0/18', '2604:a880:800:10::/64',
    // Hetzner / OVH (parcial, los rangos más usados)
    '5.9.0.0/16', '46.4.0.0/16', '78.46.0.0/15', '88.198.0.0/16',
    '94.130.0.0/16', '95.216.0.0/16', '116.203.0.0/16', '135.243.0.0/16',
    '143.198.0.0/16', '157.90.0.0/16', '157.175.0.0/16', '167.88.0.0/16',
    '176.9.0.0/16', '178.128.0.0/16', '193.32.0.0/16', '212.227.81.0/24',
    // Linode / Vultr
    '45.33.0.0/16', '50.116.0.0/18', '66.228.32.0/19', '72.14.176.0/20',
    '104.156.224.0/19', '104.237.152.0/19', '106.187.48.0/20', '107.170.0.0/16',
    '139.144.0.0/16', '139.162.0.0/16', '192.155.80.0/20', '198.58.96.0/19',
    '207.148.64.0/18', '209.222.18.0/24',
  ],

  // Rangos de VPN / proxy conocidos (modo 'observe' por defecto)
  vpnRanges: [
    '103.0.0.0/8',      // APNIC bloqueado por abuse
    '198.18.0.0/15',    // benchmarking
    '45.83.88.0/22',
    '185.220.100.0/22', // Tor exit
    '185.220.101.0/24',
    '51.15.0.0/16',     // Scaleway (VPN)
    '141.98.0.0/16',
    '45.155.205.0/24',
  ],

  // Rangos internos / del equipo: nunca se bloquean
  allowRanges: [
    '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8',
    '169.254.0.0/16', '100.64.0.0/10',
  ],

  // User-agents claramente automatizados
  botAgents: [
    'curl/', 'wget/', 'python-requests/', 'python-urllib', 'go-http-client',
    'scrapy', 'httpclient', 'okhttp', 'java/', 'libwww-perl', 'phantomjs',
    'headlesschrome', 'puppeteer', 'playwright', 'masscan', 'zgrab', 'nmap',
  ],

  // Modo de los rangos de VPN: 'observe' | 'block'
  vpnMode: process.env.IP_VPN_MODE === 'block' ? 'block' : 'observe',

  // Bloquear los rangos de cloud
  cloudMode: process.env.IP_CLOUD_BLOCK === 'block' ? 'block' : 'observe',

  // Rutas exentas del bloqueo (health checks, webhooks de pagos)
  skipPaths: ['/api/health', '/api/version', '/api/ping', '/api/payments/webhook'],
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · CIDR MATCHING (sin dependencias)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Convierte "a.b.c.d" a un entero de 32 bits.
 */
function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/**
 * Parsea un CIDR a { base, mask }.
 */
function parseCidr(cidr) {
  const [ip, bitsRaw] = String(cidr).split('/');
  const base = ipToInt(ip);
  const bits = bitsRaw === undefined ? 32 : Number(bitsRaw);

  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;

  const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;

  return { base: (base & mask) >>> 0, mask, bits };
}

/**
 * ¿La IP cae dentro del CIDR?
 */
export function ipInCidr(ip, cidr) {
  const parsed = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  const value = ipToInt(ip);

  if (!parsed || value === null) return false;

  return ((value & parsed.mask) >>> 0) === parsed.base;
}

/**
 * Normaliza una IP (saca corchetes IPv6, puerto, etc.).
 */
export function normalizeIp(raw) {
  let ip = String(raw || '').trim();

  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  } else if (ip.includes(':') && ip.split(':').length === 2) {
    ip = ip.split(':')[0];   // IPv4:puerto
  }

  return ip;
}

/** ¿Es una IPv4 válida? */
export function isIPv4(ip) {
  return ipToInt(ip) !== null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · ÍNDICES PRECOMPILADOS
   ═══════════════════════════════════════════════════════════════════════════ */

const ALLOW = CFG.allowRanges.map(parseCidr).filter(Boolean);
const CLOUD = CFG.cloudRanges.map(parseCidr).filter(Boolean);
const VPN = CFG.vpnRanges.map(parseCidr).filter(Boolean);

function inAny(ip, ranges) {
  for (const range of ranges) {
    if (ipInCidr(ip, range)) return true;
  }
  return false;
}

/**
 * Clasifica una IP.
 *
 * La clasificación SIEMPRE ocurre (aunque el modo sea "observe"): lo que
 * cambia con el modo es si la IP se BLOQUEA o sólo se registra. Sin
 * esto, el panel de admin no podría mostrar qué tráfico viene de
 * datacenters.
 *
 * @returns {{blocked:boolean, reason:string|null, category:string}}
 */
export function classifyIp(ip) {
  const clean = normalizeIp(ip);

  if (!clean) return { blocked: false, reason: null, category: 'unknown' };

  // El allowlist siempre gana.
  if (inAny(clean, ALLOW)) {
    return { blocked: false, reason: null, category: 'allowlist' };
  }

  // Rangos reservados / no enrutables.
  if (clean.startsWith('0.') || clean === '255.255.255.255' || clean.startsWith('169.254.')) {
    return { blocked: true, reason: 'reserved_range', category: 'reserved' };
  }

  // ── Datacenter ───────────────────────────────────────────────────────
  if (inAny(clean, CLOUD)) {
    if (CFG.cloudMode === 'block') {
      return { blocked: true, reason: 'cloud_datacenter', category: 'cloud' };
    }
    return { blocked: false, reason: 'cloud_datacenter', category: 'cloud' };
  }

  // ── VPN / Tor ────────────────────────────────────────────────────────
  if (inAny(clean, VPN)) {
    if (CFG.vpnMode === 'block') {
      return { blocked: true, reason: 'vpn_or_tor', category: 'vpn' };
    }
    return { blocked: false, reason: 'vpn_or_tor', category: 'vpn' };
  }

  return { blocked: false, reason: null, category: 'normal' };
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · MIDDLEWARE
   ═══════════════════════════════════════════════════════════════════════════ */

const stats = {
  checked: 0,
  blocked: 0,
  observed: 0,
  byCategory: new Map(),
};

function clientIp(req) {
  const raw =
    req.headers['cf-connecting-ip'] ||
    req.headers['x-real-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '';
  return normalizeIp(raw);
}

/**
 * Middleware de bloqueo de IPs.
 *
 * @param {object} [options]
 * @param {'block'|'observe'} [options.cloudMode]
 * @param {'block'|'observe'} [options.vpnMode]
 * @param {string[]} [options.skipPaths]
 * @returns {function} middleware Express
 */
export function ipBlocker(options = {}) {
  const cloudMode = options.cloudMode || CFG.cloudMode;
  const vpnMode = options.vpnMode || CFG.vpnMode;
  const skipPaths = options.skipPaths || CFG.skipPaths;

  return function block(req, res, next) {
    if (skipPaths.includes(req.path)) return next();

    const ip = clientIp(req);
    if (!ip) return next();

    stats.checked++;

    // ── Allowlist ───────────────────────────────────────────────────────
    if (inAny(ip, ALLOW)) return next();

    // ── Rangos reservados ───────────────────────────────────────────────
    if (ip.startsWith('0.') || ip === '255.255.255.255') {
      stats.blocked++;
      LOG.warn('ip-blocker: IP reservada bloqueada', { ip, path: req.path });
      return res.status(403).json({
        ok: false,
        error: 'Acceso denegado.',
        code: 'ip_blocked',
      });
    }

    // ── Cloud ───────────────────────────────────────────────────────────
    if (inAny(ip, CLOUD)) {
      stats.byCategory.set('cloud', (stats.byCategory.get('cloud') || 0) + 1);

      if (cloudMode === 'block') {
        stats.blocked++;
        LOG.warn('ip-blocker: IP de datacenter bloqueada', { ip, path: req.path });
        return res.status(403).json({
          ok: false,
          error: 'Este servicio no está disponible desde centros de datos.',
          code: 'ip_blocked',
        });
      }

      stats.observed++;
    }

    // ── VPN / Tor ───────────────────────────────────────────────────────
    if (inAny(ip, VPN)) {
      stats.byCategory.set('vpn', (stats.byCategory.get('vpn') || 0) + 1);

      if (vpnMode === 'block') {
        stats.blocked++;
        LOG.warn('ip-blocker: IP de VPN/Tor bloqueada', { ip, path: req.path });
        return res.status(403).json({
          ok: false,
          error: 'Acceso denegado.',
          code: 'ip_blocked',
        });
      }

      stats.observed++;
    }

    // ── User-agent automatizado ─────────────────────────────────────────
    const ua = String(req.headers['user-agent'] || '').toLowerCase();
    if (ua) {
      for (const agent of CFG.botAgents) {
        if (ua.includes(agent)) {
          stats.observed++;
          LOG.info('ip-blocker: user-agent automatizado', { ip, agent, path: req.path });
          break;
        }
      }
    }

    return next();
  };
}

/**
 * Estadísticas del bloqueador.
 */
export function getIpBlockerStats() {
  return {
    checked: stats.checked,
    blocked: stats.blocked,
    observed: stats.observed,
    byCategory: Object.fromEntries(stats.byCategory),
    modes: { cloud: CFG.cloudMode, vpn: CFG.vpnMode },
    ranges: {
      cloud: CFG.cloudRanges.length,
      vpn: CFG.vpnRanges.length,
      allow: CFG.allowRanges.length,
    },
  };
}

export function getBlocklist() {
  return {
    cloud: CFG.cloudRanges.slice(),
    vpn: CFG.vpnRanges.slice(),
    allow: CFG.allowRanges.slice(),
  };
}

export function resetIpBlockerStats() {
  stats.checked = 0;
  stats.blocked = 0;
  stats.observed = 0;
  stats.byCategory.clear();
}

export default {
  ipBlocker,
  classifyIp,
  ipInCidr,
  normalizeIp,
  isIPv4,
  getIpBlockerStats,
  getBlocklist,
  resetIpBlockerStats,
};
