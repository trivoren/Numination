import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = 'src/data';

const CONFIG = {
  matematicas:         { prefijo: 'MATE', mdFile: 'scripts/matematicas-500.md',         materia: 'Matematicas' },
  'lectura-critica':   { prefijo: 'LECT', mdFile: 'scripts/lectura-critica-500.md',     materia: 'Lectura Critica' },
  'ciencias-naturales':{ prefijo: 'CIEN', mdFile: 'scripts/ciencias-naturales-500.md',  materia: 'Ciencias Naturales' },
  sociales:            { prefijo: 'SOC',  mdFile: 'scripts/sociales-500.md',            materia: 'Sociales y Ciudadanas' },
  ingles:              { prefijo: 'INGL', mdFile: 'scripts/ingles-500.md',              materia: 'Ingles' },
};

const soloEstas = process.argv.slice(2);

function parseMD(filepath) {
  let md = fs.readFileSync(filepath, 'utf-8');
  // Normalizar line endings (CRLF/CR -> LF)
  md = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const partes = md.split(/#+\s*Clave de respuestas/i);
  const cuerpo = partes[0];
  const claveSection = partes[1] || '';

  // Respuestas: acepta "1: A", "1. A", "**1:** A", "**1. A**"
  const respuestas = {};
  const reResp = /\*?\*?(\d+)\*?\*?\s*[:.]\s*\*?\*?\s*([ABCDE])\b/g;
  let mr;
  while ((mr = reResp.exec(claveSection)) !== null) {
    respuestas[parseInt(mr[1], 10)] = mr[2];
  }

  // Preguntas: parsear línea por línea
  const lineas = cuerpo.split('\n');
  const preguntas = [];
  let actual = null;

  for (const linea of lineas) {
    const t = linea.trim();

    // Header: "### 1." o "### 1. texto"
    const mHeader = t.match(/^###\s+(\d+)[\.\)]?\s*(.*)$/);
    if (mHeader) {
      if (actual) preguntas.push(actual);
      actual = { num: parseInt(mHeader[1], 10), texto: [], opciones: {} };
      if (mHeader[2]) actual.texto.push(mHeader[2].replace(/\*\*/g, ''));
      continue;
    }

    if (!actual) continue;

    // Opción: "- A. texto" o "A. texto" o "**A.** texto"
    const mOpc = t.match(/^[\-\*]?\s*\*?\*?([ABCDE])[\.\)\:\-]\*?\*?\s+(.+)$/);
    if (mOpc) {
      actual.opciones[mOpc[1]] = mOpc[2].trim();
      continue;
    }

    // Texto del enunciado (ignorar encabezados normales y separadores)
    if (t && !t.startsWith('---') && !t.startsWith('## ') && !t.startsWith('#')) {
      actual.texto.push(t.replace(/\*\*/g, ''));
    }
  }
  if (actual) preguntas.push(actual);

  return { preguntas, respuestas };
}

for (const [slug, cfg] of Object.entries(CONFIG)) {
  if (soloEstas.length && !soloEstas.includes(slug)) continue;

  const jsFile = path.join(DATA_DIR, slug + '.js');
  if (!fs.existsSync(jsFile)) { console.log('  [skip]', slug, '- no existe js'); continue; }
  if (!fs.existsSync(cfg.mdFile)) { console.log('  [skip]', slug, '- no existe md'); continue; }

  let raw = fs.readFileSync(jsFile, 'utf-8').trim();
  raw = raw.replace(/^export default\s*/, '').replace(/;\s*$/, '');
  const originales = JSON.parse(raw);

  const { preguntas, respuestas } = parseMD(cfg.mdFile);

  const nuevas = [];
  for (const q of preguntas) {
    const num = q.num;
    const opciones = q.opciones;
    if (Object.keys(opciones).length >= 3 && respuestas[num]) {
      nuevas.push({
        num,
        texto: q.texto.join(' ').trim(),
        opciones,
        respuesta: respuestas[num],
      });
    }
  }

  console.log('  [debug]', slug, 'parseadas:', nuevas.length, 'de', preguntas.length);

  const inicioId = originales.length + 1;
  const convertidas = nuevas.map((q, i) => ({
    id: cfg.prefijo + '-' + String(inicioId + i).padStart(3, '0'),
    materia: cfg.materia,
    competencia: 'Comprension',
    afirmacion: 'Comprende y aplica conceptos en contexto.',
    evidencia: 'Resuelve el ejercicio propuesto.',
    contexto: q.texto.slice(0, 300),
    enunciado: q.texto,
    opciones: q.opciones,
    respuesta_correcta: q.respuesta,
    explicacion: 'Revisa cada opcion con cuidado.',
    fuente: 'Banco Numination 2026',
    año: 2026,
    nivel_dificultad: 'Medio',
    imagen_url: null,
  }));

  const finales = [...originales, ...convertidas];
  finales.forEach((q, i) => {
    q.id = cfg.prefijo + '-' + String(i + 1).padStart(3, '0');
  });

  const lineasOut = finales.map(q => '  ' + JSON.stringify(q));
  const output = 'export default [\n' + lineasOut.join(',\n') + '\n];\n';
  fs.writeFileSync(jsFile, output, 'utf-8');

  console.log('  [OK]', slug.padEnd(22), originales.length, '+', nuevas.length, '=', finales.length);
}