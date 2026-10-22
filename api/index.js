import app from '../src/index.js';

export default function handler(req, res) {
  try {
    return app(req, res);
  } catch (error) {
    console.error('🔥 ERROR CRÍTICO EN EL BACKEND:', error);
    res.status(500).json({
      ok: false,
      error: 'El backend falló al iniciar.',
      details: error.message,
      stack: error.stack
    });
  }
}