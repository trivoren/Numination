/**
 * Numination · Modo Coder — save.js
 * POST /api/coder/save
 *
 * Body: { filename: string, content: string, language?: string }
 * → 200  { ok: true, path, size, updatedAt }
 * → 400  { ok: false, error, code }        (validación)
 * → 401  { ok: false, error, code }        (sin sesión)
 *
 * Idempotencia: `upsert` sobre (user_id, filename). Guardar dos veces el mismo
 * contenido no crea filas extra ni efectos duplicados.
 */

import { upsertFile, normalizeFilename, languageFromPath, MAX_FILE_BYTES } from './_store.js';
import { withCoderSession } from './_session.js';

/**
 * Handler POST.
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @returns {Promise<void>}
 */
async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Método no permitido. Usa POST.' });
  }

  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ ok: false, error: 'Sesión requerida.', code: 'unauthenticated' });
  }

  const body = req.body ?? {};
  const { filename, content } = body;
  const language = typeof body.language === 'string' ? body.language.slice(0, 40) : null;

  const norm = normalizeFilename(filename);
  if (!norm.ok) {
    return res.status(400).json({ ok: false, error: norm.error, code: 'invalid_filename' });
  }

  if (typeof content !== 'string') {
    return res.status(400).json({ ok: false, error: 'El contenido debe ser texto.', code: 'invalid_content' });
  }

  const size = Buffer.byteLength(content, 'utf8');
  if (size > MAX_FILE_BYTES) {
    return res.status(413).json({
      ok: false,
      error: `El archivo supera el máximo de ${Math.round(MAX_FILE_BYTES / 1024)} KB.`,
      code: 'file_too_large'
    });
  }

  try {
    const saved = await upsertFile(
      userId,
      norm.path,
      content,
      language || languageFromPath(norm.path)
    );
    return res.json({ ok: true, ...saved });
  } catch (err) {
    console.error('[coder/save] error:', err?.message || err);
    const tooBig = /supera el máximo/i.test(err?.message || '');
    return res.status(tooBig ? 413 : 500).json({
      ok: false,
      error: tooBig ? err.message : 'No se pudo guardar el archivo.',
      code: tooBig ? 'file_too_large' : 'storage_error'
    });
  }
}

export default withCoderSession(handler);
