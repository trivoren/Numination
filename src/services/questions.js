/* ============================================================
   Servicio de preguntas
   Lee los JSON de src/data/ y expone funciones para el chat.
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');

const MATERIAS = {
  matematicas:          { nombre: 'Matemáticas',          archivo: 'matematicas.json' },
  'lectura-critica':    { nombre: 'Lectura Crítica',      archivo: 'lectura-critica.json' },
  'ciencias-naturales': { nombre: 'Ciencias Naturales',   archivo: 'ciencias-naturales.json' },
  sociales:             { nombre: 'Sociales y Ciudadanas', archivo: 'sociales.json' },
  ingles:               { nombre: 'Inglés',               archivo: 'ingles.json' },
};

const cache = new Map();

function cargar(slug) {
  if (cache.has(slug)) return cache.get(slug);
  const info = MATERIAS[slug];
  if (!info) return [];
  try {
    const raw = fs.readFileSync(path.join(dataDir, info.archivo), 'utf-8');
    const data = JSON.parse(raw);
    cache.set(slug, data);
    return data;
  } catch (err) {
    console.error(`[questions] No pude leer ${slug}:`, err.message);
    return [];
  }
}

export function listarMaterias() {
  return Object.entries(MATERIAS).map(([slug, info]) => ({
    slug,
    nombre: info.nombre,
    total: cargar(slug).length,
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