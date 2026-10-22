/**
 * Numination · src/coder.js
 * Monta las rutas del Modo Coder en la app Express principal.
 *
 * Las implementaciones viven en `api/coder/*` (compatibles también como
 * funciones serverless de Vercel) y aquí se registran bajo `/api/coder/*`
 * con la autenticación de la plataforma (`requireAuth`).
 */

import loadHandler from '../api/coder/load.js';
import saveHandler from '../api/coder/save.js';
import executeHandler from '../api/coder/execute.js';
import chatHandler from '../api/coder/chat.js';

/**
 * @param {import('express').Application} app
 * @param {Function} requireAuth Middleware de autenticación.
 * @returns {void}
 */
export function mountCoderRoutes(app, requireAuth) {
  if (!app || typeof app.get !== 'function') {
    throw new Error('mountCoderRoutes necesita la app de Express.');
  }
  const auth = typeof requireAuth === 'function' ? requireAuth : (_req, _res, next) => next();

  app.get('/api/coder/load', auth, loadHandler);
  app.post('/api/coder/save', auth, saveHandler);
  app.post('/api/coder/execute', auth, executeHandler);
  app.post('/api/coder/chat', auth, chatHandler);
}

export default mountCoderRoutes;
