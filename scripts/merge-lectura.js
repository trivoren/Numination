import fs from 'node:fs';

const JS_FILE = 'src/data/lectura-critica.js';
const MD_FILE = 'scripts/lectura-critica-500.md';

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
  let contexto = m[2].trim();
  let enunciado = '';
  const opciones = {};

  let inOpciones = false;
  const contextoLines = [];
  const enunciadoLines = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const om = line.match(/^\-\s+\*\*([ABCD])\.\*\*\s+(.+)$/);
    if (om) {
      inOpciones = true;
      opciones[om[1]] = om[2].trim();
      continue;
    }
    if (inOpciones) continue;
    if (!line.trim()) continue;

    if (line.trim().startsWith('**') && line.trim().endsWith('.')) {
      contextoLines.push(line.trim());
    } else {
      enunciadoLines.push(line.trim());
    }
  }

  const contextoFull = contextoLines.join(' ').replace(/\*\*/g, '');
  const enunciadoFull = enunciadoLines.join(' ').trim();

  if (Object.keys(opciones).length === 4 && respuestas[num]) {
    nuevas.push({
      num,
      contexto: contextoFull || 'Texto breve.',
      enunciado: enunciadoFull || contexto,
      opciones,
      respuesta: respuestas[num],
    });
  }
}

console.log('Nuevas parseadas:', nuevas.length);
if (nuevas.length < 400) console.warn('ADVERTENCIA: menos de 400 parseadas');

const inicioId = originales.length + 1;
const convertidas = nuevas.map((q, i) => ({
  id: 'LECT-' + String(inicioId + i).padStart(3, '0'),
  materia: 'Lectura Critica',
  competencia: 'Comprension lectora',
  afirmacion: 'Comprende textos breves en contexto.',
  evidencia: 'Identifica ideas principales y secundarias.',
  contexto: q.contexto,
  enunciado: q.enunciado,
  opciones: q.opciones,
  respuesta_correcta: q.respuesta,
  explicacion: 'Revisa el texto y evalua cada opcion.',
  fuente: 'Banco Numination 2026',
  año: 2026,
  nivel_dificultad: 'Medio',
  imagen_url: null,
}));

const todas = [...originales, ...convertidas];
console.log('Total final:', todas.length);

const output = 'export default ' + JSON.stringify(todas, null, 2) + ';\n';
fs.writeFileSync(JS_FILE, output, 'utf-8');

console.log('Escrito:', JS_FILE);
console.log('Bytes:', output.length);
console.log('OK');