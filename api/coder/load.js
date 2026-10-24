/**
 * Numination · Modo Coder — load.js
 * GET /api/coder/load
 *
 * Devuelve el árbol de archivos del usuario autenticado.
 *   GET /api/coder/load          → { ok, files: [{ path, language, size, updatedAt }] }
 *   GET /api/coder/load?f=<path> → { ok, file: { path, content, language, updatedAt } }
 *
 * Si el usuario todavía no tiene proyecto, se devuelve un archivo `index.js`
 * por defecto (no se persiste hasta que el usuario guarde).
 *
 * Seguridad: el `user_id` sale de la sesión verificada (req.user), nunca del
 * cuerpo de la petición. Un usuario no puede leer archivos ajenos.
 */

import { listFiles, getFile, languageFromPath, normalizeFilename } from './_store.js';
import { withCoderSession } from './_session.js';

/** Archivo semilla para proyectos nuevos. */
const DEFAULT_FILE = {
  path: 'index.js',
  language: 'javascript',
  content: [
    '/**',
    ' * Proyecto Numination — punto de entrada.',
    ' * Pide a la IA un cambio y revisa el diff antes de aplicarlo.',
    ' */',
    '',
    'export function main(args = {}) {',
    "  console.log('Numination Coder listo');",
    '  return args;',
    '}',
    '',
    'main();',
    ''
  ].join('\n')
};

/**
 * Handler GET.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ ok: false, error: 'Método no permitido. Usa GET.' });
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'Sesión requerida.', code: 'unauthenticated' });
  }

  const requested = req.query?.f;

  try {
    // ── Archivo concreto ──
    if (typeof requested === 'string' && requested.trim()) {
      const norm = normalizeFilename(requested);
      if (!norm.ok) {
        return res.status(400).json({ ok: false, error: norm.error, code: 'invalid_path' });
      }
      const file = await getFile(userId, norm.path);
      if (!file) {
        return res.status(404).json({
          ok: false,
          error: `El archivo "${norm.path}" no existe en tu proyecto.`,
          code: 'not_found'
        });
      }
      return res.json({
        ok: true,
        file: { ...file, language: file.language || languageFromPath(file.path) }
      });
    }

    // ── Árbol completo ──
    const files = await listFiles(userId);

    if (!files.length) {
      return res.json({
        ok: true,
        files: [{
          path: DEFAULT_FILE.path,
          language: DEFAULT_FILE.language,
          size: DEFAULT_FILE.content.length,
          updatedAt: null,
          isDefault: true
        }],
        empty: true
      });
    }

    return res.json({ ok: true, files, empty: false });
  } catch (err) {
    console.error('[coder/load] error:', err?.message || err);
    return res.status(500).json({
      ok: false,
      error: 'No se pudo leer el proyecto.',
      code: 'storage_error'
    });
  }
}

export { DEFAULT_FILE };
export default withCoderSession(handler);
