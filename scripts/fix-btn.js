import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'public', 'assets', 'js', 'modules', 'chat.js');
let src = fs.readFileSync(file, 'utf-8');

// 1) updateSend ya no deshabilita el botón
src = src.replace(
  `const updateSend = () => {
    sendBtn.disabled = field.value.trim().length === 0;
  };`,
  `const updateSend = () => {
    sendBtn.disabled = false;
  };`
);

// 2) El submit valida si hay texto antes de enviar
src = src.replace(
  `    const text = field.value.trim();
    if (!text) return;`,
  `    const text = field.value.trim();
    if (!text) { field.focus(); return; }`
);

fs.writeFileSync(file, src, 'utf-8');
console.log('  [OK] boton siempre habilitado');
console.log('  [OK] submit valida texto antes de enviar');