import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.cwd(), 'src', 'index.js');
let src = fs.readFileSync(file, 'utf-8');

// 1) Import de streaming
if (!src.includes("from './services/streaming.js'")) {
  src = src.replace(
    "import {\n  listarMaterias,",
    "import { streamGroq, streamGemini } from './services/streaming.js';\nimport {\n  listarMaterias,"
  );
  console.log('  [OK] import de streaming agregado');
} else {
  console.log('  [skip] import ya estaba');
}

// 2) Endpoint de streaming, justo antes de /api/health
if (!src.includes("/api/chat/stream")) {
  const endpoint = `
app.post('/api/chat/stream', async (req, res) => {
  const { message, role = 'student', file = null } = req.body ?? {};
  const hasText = message && message.trim();
  const hasFile = file && file.data;

  if (!hasText && !hasFile) {
    return res.status(400).json({ error: 'Falta el mensaje o archivo' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const heartbeat = setInterval(() => {
    try { res.write(': ping\\n\\n'); } catch {}
  }, 15000);

  const send = (data) => {
    try { res.write('data: ' + JSON.stringify(data) + '\\n\\n'); } catch {}
  };

  const systemPrompt = buildSystemPrompt(role);
  let responded = false;

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

  try {
    console.log('[stream] Gemini -> streaming...');
    for await (const token of streamGemini(gemini, systemPrompt, message || '', file)) {
      send({ token, done: false });
      responded = true;
    }
    if (responded) {
      send({ token: '', done: true, provider: 'gemini' });
      return;
    }
    throw new Error('Gemini no devolvio tokens');
  } catch (err) {
    console.warn('[stream] Gemini fallo: ' + String(err.message).slice(0, 100));
    if (responded) {
      send({ token: '', done: true, provider: 'gemini', partial: true });
      return;
    }
  }

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
    console.error('[stream] Todos los motores fallaron');
    send({ error: 'Los motores de IA estan saturados. Intenta de nuevo.', done: true });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

`;
  src = src.replace("app.get('/api/health'", endpoint + "app.get('/api/health'");
  console.log('  [OK] endpoint /api/chat/stream agregado');
} else {
  console.log('  [skip] endpoint ya existia');
}

fs.writeFileSync(file, src, 'utf-8');
console.log('\\nListo.');