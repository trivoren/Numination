/**
 * Numination · Modo Coder — _session.js
 * Puente de sesión para los handlers serverless de `api/coder/*`.
 *
 * POR QUÉ EXISTE
 *   En Vercel los archivos de `api/coder/*` se convierten en funciones
 *   serverless que INTERCEPTAN sus rutas antes que el rewrite `/api/(.*)`
 *   hacia la app Express (la prioridad de filesystem > rewrites es fija).
 *   Dentro de Express, `src/coder.js` monta los mismos handlers DETRAS de
 *   `requireAuth`, pero en el contexto serverless NADIE resolvía la sesión:
 *   `req.user` siempre era `undefined` → 401 "Sin conexión con el backend
 *   de archivos" para TODOS los usuarios, incluso logueados.
 *
 * QUÉ HACE (idempotente, seguro en ambos contextos)
 *   1. Normaliza lo que Express daba por sentado y Vercel no trae:
 *      `req.cookies` (cookie-parser), `req.query` (URL) y `req.body` (JSON).
 *   2. Ejecuta el middleware real de la plataforma `attachUser` (unificado
 *      con el resto del producto) con `next` promisificado. No bloquea:
 *      deja `req.user = null` si no hay sesión y el handler responde su
 *      propio 401 con su propio código.
 *
 * COMPATIBILIDAD
 *   · Express + requireAuth (src/coder.js): si `req.user` ya existe, nada
 *     se toca ni re-parsea → cero cambios de comportamiento.
 *   · Tests unitarios: los mocks que pasan `req.user`/`req.body` directo
 *     siguen funcionando (el wrapper salta todo lo ya resuelto).
 *   · SSE (chat.js): no toca headers de respuesta.
 */

import { attachUser } from '../../src/middleware/auth.js';

/**
 * Lee cookies del header `cookie` y las deposita en req.cookies.
 * @param {import('express').Request} req
 * @returns {void}
 */
function parseCookies(req) {
  if (req.cookies && typeof req.cookies === 'object') return;
  const jar = {};
  const header = req.headers?.cookie || '';
  for (const pair of String(header).split(';')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    try {
      jar[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
    } catch {
      jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }
  req.cookies = jar;
}

/**
 * Parsear el query string en `req.query` (Express lo hace; Vercel no).
 * @param {import('express').Request} req
 * @returns {void}
 */
function parseQuery(req) {
  if (req.query && typeof req.query === 'object') return;
  const query = {};
  try {
    const url = new URL(req.url || '/', 'http://numination.local');
    for (const [key, value] of url.searchParams.entries()) query[key] = value;
  } catch {
    /* URL malformada: queda {} */
  }
  req.query = query;
}

/**
 * Parsear el cuerpo JSON en `req.body` acumulando el stream crudo.
 * @param {import('express').Request} req
 * @returns {Promise<void>}
 */
function parseJsonBody(req) {
  return new Promise((resolve) => {
    if (req.body !== undefined && req.body !== null) return resolve();
    const method = String(req.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') return resolve();

    const contentType = String(req.headers?.['content-type'] || '');
    if (!contentType.toLowerCase().includes('application/json')) return resolve();

    const chunks = [];
    let size = 0;
    const LIMIT = 1_000_000; // 1MB: el Coder nunca manda más
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= LIMIT) chunks.push(chunk);
      else req.removeAllListeners('data'); // stop intake, el JSON caerá corrupto → 400 arriba
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw) {
        try { req.body = JSON.parse(raw); }
        catch { req.body = undefined; }
      } else {
        req.body = {};
      }
      resolve();
    });
    req.on('error', () => resolve()); // handler decide qué responder
  });
}

/**
 * Envuelve un handler del módulo Coder con: normalización de request +
 * `attachUser`. Sin bloqueos y sin tocar la respuesta.
 * @template T
 * @param {T} handlerCore
 * @returns {T}
 */
export function withCoderSession(handlerCore) {
  return async function handler(req, res) {
    try {
      if (!req.headers || typeof req.headers !== 'object') req.headers = {};
      parseCookies(req);
      parseQuery(req);
      await parseJsonBody(req);

      await new Promise((resolve) => {
        Promise.resolve(attachUser(req, res, resolve)).catch(() => resolve());
      });
    } catch (err) {
      // La normalización JAMÁS debe romper la respuesta: downgrade a anónimo.
      console.error('[coder/_session] normalización fallida:', err?.message || err);
      req.user = req.user ?? null;
    }
    return handlerCore(req, res);
  };
}

export default withCoderSession;
