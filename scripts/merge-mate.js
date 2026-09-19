import fs from 'node:fs';

const JS_FILE = 'src/data/matematicas.js';
const MD_FILE = 'scripts/matematicas-500.md';

if (!fs.existsSync(JS_FILE)) { console.error('ERROR: no existe', JS_FILE); process.exit(1); }
if (!fs.existsSync(MD_FILE)) { console.error('ERROR: no existe', MD_FILE); process.exit(1); }

let raw = fs.readFileSync(JS_FILE, 'utf-8').trim();
raw = raw.replace(/^export default\s*/, '').replace(/;\s*$/, '');
const originales = JSON.parse(raw);
console.log('Originales cargadas:', originales.length);

const md = fs.readFileSync(MD_FILE, 'utf-8');

const partes = md.split(/#\s*Clave de respuestas/i);
if (partes.length < 2) { console.error('ERROR: no encontre "Clave de respuestas"'); process.exit(1); }
const cuerpo = partes[0];
const claveSection = partes[1];

const respuestas = {};
const reResp = /\*\*(\d+)\.\s+([ABCD])\*\*/g;
let mr;
while ((mr = reResp.exec(claveSection)) !== null) {
  respuestas[parseInt(mr[1], 10)] = mr[2];
}
console.log('Respuestas parseadas:', Object.keys(respuestas).length);

const bloques = cuerpo.split(/^### /m).slice(1);
const nuevas = [];

for (const bloque of bloques) {
  const lines = bloque.split('\n');
  const header = lines[0].trim();
  const m = header.match(/^(\d+)\.\s+(.+)$/);
  if (!m) continue;

  const num = parseInt(m[1], 10);
  const enunciado = m[2].trim();

  const opciones = {};
  for (const line of lines) {
    const om = line.match(/^\-\s+\*\*([ABCD])\.\*\*\s+(.+)$/);
    if (om) opciones[om[1]] = om[2].trim();
  }

  if (Object.keys(opciones).length === 4 && respuestas[num]) {
    nuevas.push({ num, enunciado, opciones, respuesta: respuestas[num] });
  }
}

console.log('Nuevas parseadas:', nuevas.length);

if (nuevas.length < 400) console.warn('ADVERTENCIA: menos de 400 parseadas');

function competenciaPorNumero(n) {
  if (n >= 191 && n <= 320) return 'Interpretacion y representacion';
  if (n >= 441 && n <= 500) return 'Argumentacion';
  return 'Formulacion y ejecucion';
}

const inicioId = originales.length + 1;
const convertidas = nuevas.map((q, i) => ({
  id: 'MATE-' + String(inicioId + i).padStart(3, '0'),
  materia: 'Matematicas',
  competencia: competenciaPorNumero(q.num),
  afirmacion: 'Aplica conceptos matematicos en contexto.',
  evidencia: 'Resuelve problemas numericos con operaciones basicas.',
  contexto: 'Situacion matematica de practica.',
  enunciado: q.enunciado,
  opciones: q.opciones,
  respuesta_correcta: q.respuesta,
  explicacion: 'Revisa el procedimiento paso a paso.',
  fuente: 'Banco Numination 2026',
  año: 2026,
  nivel_dificultad: 'Facil',
  imagen_url: null,
}));

const todas = [...originales, ...convertidas];
console.log('Total final:', todas.length);

const output = 'export default ' + JSON.stringify(todas, null, 2) + ';\n';
fs.writeFileSync(JS_FILE, output, 'utf-8');

console.log('Escrito:', JS_FILE);
console.log('Bytes:', output.length);
console.log('OK');