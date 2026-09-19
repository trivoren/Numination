import fs from 'node:fs';

const file = 'src/index.js';
const raw = fs.readFileSync(file, 'utf-8');
const lines = raw.split(/\r?\n/);

// 1) Linea del log de Groq -> retroceder al "try {"
let groqLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes("[stream] Groq -> streaming...")) { groqLine = i; break; }
}
if (groqLine === -1) { console.log('[ERROR] Groq log'); process.exit(1); }

let tryLine = groqLine;
while (tryLine > 0 && !lines[tryLine].trim().startsWith('try {')) tryLine--;

// 2) Linea del "} finally {"
let finallyLine = -1;
for (let i = groqLine; i < lines.length; i++) {
  if (lines[i].trim().startsWith('} finally {')) { finallyLine = i; break; }
}
if (finallyLine === -1) { console.log('[ERROR] finally'); process.exit(1); }

// 3) Bloque nuevo (sin try ni finally propios: los toma prestados del original)
const newBlock = `    const orden = ['gemini', 'groq', 'nvidia'];
    for (const prov of orden) {
      if (prov === 'gemini') {
        const candidates = geminiCandidates();
        if (!candidates.length) {
          console.warn('[stream] Todas las keys de Gemini en cooldown, paso a Groq');
          continue;
        }
        let ok = false;
        for (const entry of candidates) {
          try {
            console.log('[stream] Gemini #' + entry.id + ' -> streaming...');
            let localTokens = 0;
            for await (const token of streamGemini(entry.client, systemPrompt, message || '', file)) {
              send({ token, done: false });
              responded = true;
              localTokens++;
            }
            if (localTokens > 0) {
              send({ token: '', done: true, provider: 'gemini-' + entry.id });
              ok = true;
              break;
            }
            throw new Error('Gemini no devolvio tokens');
          } catch (err) {
            const esRate = isRateLimitError(err);
            console.warn('[stream] Gemini #' + entry.id + ' fallo: ' + String(err.message).slice(0, 100));
            if (esRate && !responded) {
              markGeminiCooldown(entry, GEMINI_COOLDOWN_MS);
              console.warn('[stream] Key #' + entry.id + ' en cooldown 60s');
              continue;
            }
            if (responded) {
              send({ token: '', done: true, provider: 'gemini-' + entry.id, partial: true });
              ok = true;
              break;
            }
            markGeminiCooldown(entry, 15000);
            continue;
          }
        }
        if (ok) return;
      } else if (prov === 'groq') {
        try {
          console.log('[stream] Groq -> streaming...');
          for await (const token of streamGroq(groq, systemPrompt, message || '', file)) {
            send({ token, done: false });
            responded = true;
          }
          if (responded) {
            send({ token: '', done: true, provider: 'groq' });
            return;
          }
          throw new Error('Groq no devolvio tokens');
        } catch (err) {
          console.warn('[stream] Groq fallo: ' + String(err.message).slice(0, 100));
          if (responded) {
            send({ token: '', done: true, provider: 'groq', partial: true });
            return;
          }
        }
      } else if (prov === 'nvidia') {
        try {
          console.log('[stream] Kimi K3 -> sin streaming');
          const reply = await callNvidia(systemPrompt, message || '', file);
          if (reply && reply.trim()) {
            send({ token: reply, done: false });
            send({ token: '', done: true, provider: 'nvidia', noStream: true });
            return;
          }
          throw new Error('Respuesta vacia');
        } catch (err) {
          console.warn('[stream] Kimi K3 fallo: ' + String(err.message).slice(0, 100));
        }
      }
    }

    if (!responded) {
      console.error('[stream] Todos los motores fallaron');
      send({ error: 'Los motores de IA estan saturados. Intenta de nuevo.', done: true });
    }`;

const result = [
  ...lines.slice(0, tryLine + 1),
  ...newBlock.split('\n'),
  ...lines.slice(finallyLine)
].join('\n');

fs.writeFileSync(file, result, 'utf-8');
console.log('[OK] Bloque del stream reemplazado con rotacion de Gemini');