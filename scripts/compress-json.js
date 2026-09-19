import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = 'src/data';
const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.js'));

for (const file of files) {
  const fullPath = path.join(DATA_DIR, file);
  let raw = fs.readFileSync(fullPath, 'utf-8').trim();
  raw = raw.replace(/^export default\s*/, '').replace(/;\s*$/, '');

  const data = JSON.parse(raw);
  const count = data.length;

  const lineas = data.map(q => '  ' + JSON.stringify(q));
  const output = 'export default [\n' + lineas.join(',\n') + '\n];\n';

  fs.writeFileSync(fullPath, output, 'utf-8');

  console.log(`  [OK] ${file.padEnd(28)} ${count} preguntas · ${output.length} bytes`);
}

console.log('\nListo.\\n');