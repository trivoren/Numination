/* ============================================================
   Formatea todos los JSON de data/ con indentación de 2 espacios
   Uso: node scripts/format-json.js
   ============================================================ */

import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.join(process.cwd(), 'data');

const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));

console.log('\n📦 Formateando JSON en data/\n');

let total = 0;

for (const file of files) {
  const fullPath = path.join(dataDir, file);
  const raw = fs.readFileSync(fullPath, 'utf-8').trim();

  if (!raw || raw === '[]') {
    console.log(`  [skip] ${file.padEnd(28)} (vacío)`);
    continue;
  }

  try {
    const data = JSON.parse(raw);
    const count = Array.isArray(data) ? data.length : 0;
    const formatted = JSON.stringify(data, null, 2);
    fs.writeFileSync(fullPath, formatted, 'utf-8');
    console.log(`  [OK]   ${file.padEnd(28)} ${count} preguntas · ${formatted.length} bytes`);
    total += count;
  } catch (err) {
    console.log(`  [ERR]  ${file.padEnd(28)} ${err.message}`);
  }
}

console.log(`\n🎉 Total: ${total} preguntas formateadas\n`);