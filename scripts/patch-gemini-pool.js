import fs from 'node:fs';

const file = 'src/index.js';
let src = fs.readFileSync(file, 'utf-8');
let cambios = 0;

/* ─────────── 1) Bloque KEYS con 3 Gemini ─────────── */
const oldKeysBlock = /const KEYS = \{[\s\S]*?\};\s*\n\s*if \(!KEYS\.GEMINI_API_KEY\)[\s\S]*?if \(!KEYS\.GROQ_API_KEY\)\s*console\.warn\([^\n]+\);/;
const newKeysBlock = `const KEYS = {
  GEMINI_API_KEY:   process.env.GEMINI_API_KEY   ?? TEST_KEYS.GEMINI_API_KEY,
  GEMINI_API_KEY_2: process.env.GEMINI_API_KEY_2 ?? TEST_KEYS.GEMINI_API_KEY_2,
  GEMINI_API_KEY_3: process.env.GEMINI_API_KEY_3 ?? TEST_KEYS.GEMINI_API_KEY_3,
  NVIDIA_API_KEY:   process.env.NVIDIA_API_KEY   ?? TEST_KEYS.NVIDIA_API_KEY,
  GROQ_API_KEY:     process.env.GROQ_API_KEY     ?? TEST_KEYS.GROQ_API_KEY,
};

if (!KEYS.GEMINI_API_KEY && !KEYS.GEMINI_API_KEY_2 && !KEYS.GEMINI_API_KEY_3) {
  console.warn('Aviso: ninguna GEMINI_API_KEY configurada');
}
if (!KEYS.NVIDIA_API_KEY) console.warn('Aviso: NVIDIA_API_KEY no configurada');
if (!KEYS.GROQ_API_KEY)   console.warn('Aviso: GROQ_API_KEY no configurada');`;

if (oldKeysBlock.test(src)) {
  src = src.replace(oldKeysBlock, newKeysBlock);
  cambios++;
  console.log('  [OK] bloque KEYS con 3 Gemini');
} else {
  console.log('  [WARN] no encontre el bloque KEYS original');
}

/* ─────────── 2) Pool de clientes Gemini ─────────── */
const oldGeminiClient = /const gemini = new GoogleGenAI\(\{[^}]+\}\);/;
const newGeminiPool = `// Pool de clientes Gemini con rotacion
const GEMINI_KEY_LIST = [
  KEYS.GEMINI_API_KEY,
  KEYS.GEMINI_API_KEY_2,
  KEYS.GEMINI_API_KEY_3,
].filter(Boolean);

const geminiPool = GEMINI_KEY_LIST.map((apiKey, i) => ({
  id: i + 1,
  key: apiKey,
  client: new GoogleGenAI({ apiKey }),
  cooldownUntil: 0,
}));

const GEMINI_COOLDOWN_MS = 60000;

function markGeminiCooldown(entry, ms = GEMINI_COOLDOWN_MS) {
  entry.cooldownUntil = Date.now() + ms;
}

function geminiCandidates() {
  const now = Date.now();
  return geminiPool.filter((e) => e.cooldownUntil <= now);
}

function isRateLimitError(err) {
  const msg = String(err?.message ?? '').toLowerCase();
  const status = err?.status ?? err?.code ?? 0;
  return (
    status === 429 || status === 503 || status === 500 ||
    msg.includes('429') || msg.includes('503') || msg.includes('500') ||
    msg.includes('quota') || msg.includes('rate limit') ||
    msg.includes('resource exhausted') || msg.includes('overloaded')
  );
}

const gemini = geminiPool[0]?.client ?? null;`;

if (oldGeminiClient.test(src)) {
  src = src.replace(oldGeminiClient, newGeminiPool);
  cambios++;
  console.log('  [OK] pool de clientes Gemini');
} else {
  console.log('  [WARN] no encontre el cliente Gemini original');
}

/* ─────────── 3) Orden del stream con rotacion ─────────── */
const oldStreamBlock = /const hasFile = file && file\.data;[\s\S]*?if \(!responded\) \{[\s\S]*?send\(\{ error: 'Los motores de IA estan saturados[^}]+\}\);\s*\n\s*\}/;

const newStreamBlock = `// Orden: Gemini primero, con rotacion automatica de keys
const orden = ['gemini', 'groq', 'nvidia'];
let responded = false;

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
        console.warn('[stream] Gemini #' + entry.id + ' fallo:', String(err.message).slice(0, 100));
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
    if (ok) break;
  } else if (prov === 'groq') {
    try {
      console.log('[stream] Groq -> streaming...');
      for await (const token of streamGroq(groq, systemPrompt, message || '', file)) {
        send({ token, done: false });
        responded = true;
      }
      if (responded) {
        send({ token: '', done: true, provider: 'groq' });
        break;
      }
      throw new Error('Groq no devolvio tokens');
    } catch (err) {
      console.warn('[stream] Groq fallo:', String(err.message).slice(0, 100));
      if (responded) {
        send({ token: '', done: true, provider: 'groq', partial: true });
        break;
      }
    }
  } else if (prov === 'nvidia') {
    try {
      console.log('[stream] Kimi K3 -> sin streaming');
      const reply = await callNvidia(systemPrompt, message || '', file);
      if (reply && reply.trim()) {
        send({ token: reply, done: false });
        send({ token: '', done: true, provider: 'nvidia', noStream: true });
        break;
      }
      throw new Error('Respuesta vacia');
    } catch (err) {
      console.warn('[stream] Kimi K3 fallo:', String(err.message).slice(0, 100));
    }
  }
}

if (!responded) {
  console.error('[stream] Todos los motores fallaron');
  send({ error: 'Los motores de IA estan saturados. Intenta de nuevo.', done: true });
}`;

if (oldStreamBlock.test(src)) {
  src = src.replace(oldStreamBlock, newStreamBlock);
  cambios++;
  console.log('  [OK] orden del stream con rotacion');
} else {
  console.log('  [WARN] no encontre el bloque del stream');
}

/* ─────────── 4) Health endpoint con las 3 keys ─────────── */
const oldHealthKeys = /keys:\s*\{\s*gemini:\s*!!KEYS\.GEMINI_API_KEY,\s*nvidia:\s*!!KEYS\.NVIDIA_API_KEY,\s*groq:\s*!!KEYS\.GROQ_API_KEY,\s*\}/;
const newHealthKeys = `keys: {
      gemini_1: !!KEYS.GEMINI_API_KEY,
      gemini_2: !!KEYS.GEMINI_API_KEY_2,
      gemini_3: !!KEYS.GEMINI_API_KEY_3,
      nvidia: !!KEYS.NVIDIA_API_KEY,
      groq: !!KEYS.GROQ_API_KEY,
    }`;

if (oldHealthKeys.test(src)) {
  src = src.replace(oldHealthKeys, newHealthKeys);
  cambios++;
  console.log('  [OK] health endpoint con 3 keys');
} else {
  console.log('  [WARN] no encontre el bloque de keys en /api/health');
}

fs.writeFileSync(file, src, 'utf-8');
console.log('');
console.log('Cambios aplicados:', cambios, 'de 4');