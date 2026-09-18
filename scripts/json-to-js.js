import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.join(process.cwd(), 'data');
const outDir = path.join(process.cwd(), 'src', 'data');

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));

for (const file of files) {
  const baseName = file.replace('.json', '');
  const json = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
  const js = `export default ${JSON.stringify(json)};\n`;
  fs.writeFileSync(path.join(outDir, `${baseName}.js`), js, 'utf-8');
  console.log(`  [OK] ${file} -> ${baseName}.js (${json.length} preguntas)`);
}

console.log('\nListo.\n');