/* ============================================================
   Servicio de preguntas
   Importa los JSON como módulos ES para que Vercel los bundlee.
   ============================================================ */

import matematicas from '../data/matematicas.js';
import lecturaCritica from '../data/lectura-critica.js';
import cienciasNaturales from '../data/ciencias-naturales.js';
import sociales from '../data/sociales.js';
import ingles from '../data/ingles.js';

const MATERIAS = {
  matematicas:          { nombre: 'Matemáticas',           data: matematicas },
  'lectura-critica':    { nombre: 'Lectura Crítica',       data: lecturaCritica },
  'ciencias-naturales': { nombre: 'Ciencias Naturales',    data: cienciasNaturales },
  sociales:             { nombre: 'Sociales y Ciudadanas', data: sociales },
  ingles:               { nombre: 'Inglés',                data: ingles },
};

function cargar(slug) {
  return MATERIAS[slug]?.data ?? [];
}

export function listarMaterias() {
  return Object.entries(MATERIAS).map(([slug, info]) => ({
    slug,
    nombre: info.nombre,
    total: info.data.length,
  }));
}

export function preguntaAleatoria(materia = null) {
  let pool = [];
  if (materia) {
    pool = cargar(materia);
  } else {
    for (const slug of Object.keys(MATERIAS)) pool.push(...cargar(slug));
  }
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

export function simulacro(cantidad = 10, areas = null) {
  const areasValidas = areas && areas.length
    ? areas.filter(a => MATERIAS[a])
    : Object.keys(MATERIAS);

  if (!areasValidas.length) return [];

  const resultado = [];
  const porArea = Math.ceil(cantidad / areasValidas.length);

  for (const slug of areasValidas) {
    const pool = [...cargar(slug)];
    for (let i = 0; i < porArea && resultado.length < cantidad; i++) {
      if (!pool.length) break;
      const idx = Math.floor(Math.random() * pool.length);
      resultado.push(pool.splice(idx, 1)[0]);
    }
  }

  return resultado.sort(() => Math.random() - 0.5).slice(0, cantidad);
}

export function buscarPorId(id) {
  for (const slug of Object.keys(MATERIAS)) {
    const found = cargar(slug).find(p => p.id === id);
    if (found) return found;
  }
  return null;
}

export function verificarRespuesta(id, respuestaUsuario) {
  const p = buscarPorId(id);
  if (!p) return { ok: false, error: 'Pregunta no encontrada' };
  const correcta = p.respuesta_correcta;
  const esCorrecta = String(respuestaUsuario).toUpperCase() === correcta;
  return {
    ok: true,
    correcta: esCorrecta,
    respuesta_correcta: correcta,
    explicacion: p.explicacion,
    enunciado: p.enunciado,
    materia: p.materia,
    competencia: p.competencia,
  };
}

export function formatearParaChat(p) {
  if (!p) return '';
  return [
    `**${p.materia}** · ${p.competencia} · Dificultad: ${p.nivel_dificultad}`,
    '',
    `**Contexto:** ${p.contexto}`,
    '',
    `**Pregunta:** ${p.enunciado}`,
    '',
    `A) ${p.opciones.A}`,
    `B) ${p.opciones.B}`,
    `C) ${p.opciones.C}`,
    `D) ${p.opciones.D}`,
    '',
    `_Responde con la letra (A, B, C o D). No te diré cuál es la correcta hasta que respondas._`,
    '',
    `(ID: ${p.id})`,
  ].join('\n');
}