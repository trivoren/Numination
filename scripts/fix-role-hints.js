import fs from 'node:fs';

const file = 'src/index.js';
const raw = fs.readFileSync(file, 'utf-8');
const lines = raw.split(/\r?\n/);

// Buscar la linea de "function buildSystemPrompt"
let fnIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('function buildSystemPrompt')) { fnIdx = i; break; }
}
if (fnIdx === -1) { console.log('[ERROR] No encontre buildSystemPrompt'); process.exit(1); }

// Verificar si ya existen por si acaso
const already = lines.some(l => l.includes('const ROLE_HINT_STUDENT'));
if (already) {
  console.log('[SKIP] ROLE_HINT_STUDENT ya existe, no toco nada');
  process.exit(0);
}

// Bloque a insertar (editable)
const block = [
  "const ROLE_HINT_STUDENT = `Eres un tutor amable y claro para estudiantes colombianos que se preparan para el ICFES Saber 11. Explica paso a paso, usa ejemplos sencillos, adapta el lenguaje al nivel del estudiante y motiva siempre. Responde en espanol.`;",
  "",
  "const ROLE_HINT_TEACHER = `Eres un asistente pedagogico para docentes colombianos. Ayuda a disenar actividades, evaluaciones y explicaciones alineadas al marco del ICFES Saber 11. Usa lenguaje profesional y da sugerencias aplicables al aula. Responde en espanol.`;",
  ""
];

const result = [
  ...lines.slice(0, fnIdx),
  ...block,
  ...lines.slice(fnIdx)
].join('\n');

fs.writeFileSync(file, result, 'utf-8');
console.log('[OK] ROLE_HINT_STUDENT y ROLE_HINT_TEACHER insertadas antes de buildSystemPrompt');