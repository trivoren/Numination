import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = 'src/data';

const CONFIG = {
  matematicas: { prefijo: 'MATE', mdFile: 'scripts/matematicas-500.md', materia: 'Matematicas' },
  'lectura-critica': { prefijo: 'LECT', mdFile: 'scripts/lectura-critica-500.md', materia: 'Lectura Critica' },
};

for (const [slug, cfg] of Object.entries(CONFIG)) {
  const jsFile = path.join(DATA_DIR, slug + '.js');

  if (!fs.existsSync(cfg.mdFile)) {
    console.log('  [skip]', slug, '- no existe', cfg.mdFile);
    continue;
  }

  let raw = fs.readFileSync(jsFile, 'utf-8').trim();
  raw = raw.replace(/^export default\s*/, '').replace(/;\s*$/, '');
  const originales = JSON.parse(raw);

  const md = fs.readFileSync(cfg.mdFile, 'utf-8');
  const partes = md.split(/#\s*Clave de respuestas/i);
  if (partes.length < 2) { console.log('  [ERR]', slug); continue; }
  const cuerpo = partes[0];
  const claveSection = partes[1];

  const respuestas = {};
  const reResp = /\*\*(\d+)\.\s+([ABCD])\*\*/g;
  let mr;
  while ((mr = reResp.exec(claveSection)) !== null) {
    respuestas[parseInt(mr[1], 10)] = mr[2];
  }

  const bloques = cuerpo.split(/^### /m).slice(1);
  const nuevas = [];

  for (const bloque of bloques) {
    const lines = bloque.split('\n');
    const m = lines[0].trim().match(/^(\d+)\.\s+(.+)$/);
    if (!m) continue;
    const num = parseInt(m[1], 10);
    const opciones = {};
    const textoLineas = [];
    let inOpciones = false;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const om = line.match(/^\-\s+\*\*([ABCD])\.\*\*\s+(.+)$/);
      if (om) { inOpciones = true; opciones[om[1]] = om[2].trim(); continue; }
      if (inOpciones) continue;
      if (!line.trim()) continue;
      textoLineas.push(line.trim());
    }

    const texto = textoLineas.join(' ').replace(/\*\*/g, '').trim();

    if (Object.keys(opciones).length === 4 && respuestas[num]) {
      nuevas.push({ num, texto, opciones, respuesta: respuestas[num] });
    }
  }

  const inicioId = originales.length + 1;
  const convertidas = nuevas.map((q, i) => ({
    id: cfg.prefijo + '-' + String(inicioId + i).padStart(3, '0'),
    materia: cfg.materia,
    competencia: 'Comprension',
    afirmacion: 'Comprende y aplica conceptos en contexto.',
    evidencia: 'Resuelve el ejercicio propuesto.',
    contexto: q.texto,
    enunciado: q.texto,
    opciones: q.opciones,
    respuesta_correcta: q.respuesta,
    explicacion: 'Revisa cada opcion con cuidado.',
    fuente: 'Banco Numination 2026',
    año: 2026,
    nivel_dificultad: 'Medio',
    imagen_url: null,
  }));

  // SIN DEDUP. Concatenar todo.
  const finales = [...originales, ...convertidas];
  finales.forEach((q, i) => {
    q.id = cfg.prefijo + '-' + String(i + 1).padStart(3, '0');
  });

  const lineas = finales.map(q => '  ' + JSON.stringify(q));
  const output = 'export default [\n' + lineas.join(',\n') + '\n];\n';
  fs.writeFileSync(jsFile, output, 'utf-8');

  console.log('  [OK]', slug.padEnd(20), originales.length, '+', nuevas.length, '=', finales.length);
}