/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · services/voice-engine.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Motor de voz: transcripción (STT) y síntesis (TTS).

   STT · Cadena
     1. OpenAI Whisper (`whisper-1`) vía multipart/form-data.
     2. Groq Whisper (`whisper-large-v3`) — mismo formato, endpoint compatible.
     3. Sin proveedor → se responde con `available: false` y el cliente
        usa la Web Speech API del navegador (gratis, sin subir audio).

   TTS · Cadena
     1. OpenAI (`gpt-4o-mini-tts` / `tts-1`) → audio/mpeg.
     2. ElevenLabs (`eleven_multilingual_v2`) → audio/mpeg.
     3. Sin proveedor → el cliente sintetiza en el navegador.

   PRIVACIDAD
   El audio nunca se escribe en disco: se procesa en memoria y se
   descarta. Las transcripciones se devuelven al cliente pero no se
   guardan en la base de datos (el usuario decide qué se guarda, vía la
   memoria explícita).
   ═══════════════════════════════════════════════════════════════════════════ */

import crypto from 'node:crypto';
import { LOG } from '../lib/logger.js';

/* ═══════════════════════════════════════════════════════════════════════════
   01 · CONFIGURACIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

const CFG = Object.freeze({
  maxAudioBytes: 25 * 1024 * 1024,   // 25 MB
  maxChars: 8000,                    // límite del texto a sintetizar
  sttTimeoutMs: 60_000,
  ttsTimeoutMs: 45_000,
  openaiBase: 'https://api.openai.com/v1',
  groqBase: 'https://api.groq.com/openai/v1',
  openaiWhisperModel: 'whisper-1',
  groqWhisperModel: 'whisper-large-v3',
  openaiTtsModel: 'gpt-4o-mini-tts',
  openaiTtsFallbackModel: 'tts-1',
  elevenBase: 'https://api.elevenlabs.io/v1',
  elevenModel: 'eleven_multilingual_v2',
  defaultVoice: 'alloy',
  defaultElevenVoice: 'pNInz6obpgDQGcFmaJgB',
  voices: [
    { id: 'alloy', label: 'Alfa (neutra)' },
    { id: 'echo', label: 'Eco (masculina)' },
    { id: 'fable', label: 'Fábula (cálida)' },
    { id: 'onyx', label: 'Onyx (grave)' },
    { id: 'nova', label: 'Nova (clara)' },
    { id: 'shimmer', label: 'Shimmer (suave)' },
  ],
});

/* ═══════════════════════════════════════════════════════════════════════════
   02 · HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

/* Las claves pueden venir de .env.local o del archivo env.local.js
   (así lo carga el resto del proyecto). */
let FILE_KEYS = {};
try {
  const mod = await import('../../env.local.js');
  FILE_KEYS = mod.TEST_KEYS ?? {};
} catch { /* archivo opcional */ }

function openaiKey() {
  return process.env.OPENAI_API_KEY || FILE_KEYS.OPENAI_API_KEY || null;
}

function groqKey() {
  return process.env.GROQ_API_KEY || null;
}

function elevenKey() {
  return process.env.ELEVENLABS_API_KEY || FILE_KEYS.ELEVENLABS_API_KEY || null;
}

/** Normaliza el nombre de archivo con la extensión de audio correcta. */
function audioFilename(filename, mimeType) {
  const ext = mimeType === 'audio/webm' ? 'webm'
    : mimeType === 'audio/ogg' ? 'ogg'
      : mimeType === 'audio/mp4' ? 'm4a'
        : mimeType === 'audio/mpeg' ? 'mp3'
          : mimeType === 'audio/wav' ? 'wav'
            : mimeType === 'audio/flac' ? 'flac'
              : 'webm';

  const name = String(filename || 'audio').replace(/[^\w.-]/g, '_').slice(0, 60);
  return name.toLowerCase().endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

/** Convierte un texto a un blob de audio para el multipart. */
function toBlob(buffer, mimeType) {
  return new Blob([new Uint8Array(buffer)], { type: mimeType || 'application/octet-stream' });
}

/* ═══════════════════════════════════════════════════════════════════════════
   03 · STT · TRANSCRIPCIÓN
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Transcribe un audio.
 *
 * @param {object} params
 * @param {Buffer} params.buffer
 * @param {string} [params.filename]
 * @param {string} [params.mimeType]
 * @param {string} [params.language]  'es' por defecto
 * @param {string} [params.prompt]     Contexto para mejorar el resultado
 * @returns {Promise<object>} { ok, text, provider, language, durationMs }
 */
export async function transcribe({ buffer, filename, mimeType, language = 'es', prompt = '' } = {}) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: 'No se recibió audio.', code: 'empty_audio' };
  }
  if (buffer.length > CFG.maxAudioBytes) {
    return { ok: false, error: 'El audio supera los 25 MB.', code: 'audio_too_large' };
  }

  const started = Date.now();
  const fileName = audioFilename(filename, mimeType);

  const providers = [];

  if (openaiKey()) {
    providers.push({
      name: 'openai',
      run: () => transcribeWithOpenAI({ buffer, fileName, mimeType, language, prompt }),
    });
  }
  if (groqKey()) {
    providers.push({
      name: 'groq',
      run: () => transcribeWithGroq({ buffer, fileName, mimeType, language, prompt }),
    });
  }

  if (!providers.length) {
    return {
      ok: true,
      available: false,
      text: '',
      provider: 'client',
      fallback: 'webspeech',
      message: 'No hay proveedor de voz configurado. Usá la transcripción del navegador.',
    };
  }

  let lastError = null;

  for (const provider of providers) {
    try {
      const result = await provider.run();
      return {
        ok: true,
        available: true,
        text: result.text || '',
        provider: provider.name,
        language: result.language || language,
        durationMs: result.duration || 0,
        elapsedMs: Date.now() - started,
      };
    } catch (e) {
      lastError = e;
      LOG.warn(`voice-engine: falló el proveedor STT ${provider.name}`, { error: e.message });
    }
  }

  return {
    ok: false,
    error: 'No se pudo transcribir el audio.',
    code: 'stt_failed',
    detail: lastError?.message || null,
    elapsedMs: Date.now() - started,
  };
}

async function transcribeWithOpenAI({ buffer, fileName, mimeType, language, prompt }) {
  const form = new FormData();
  form.append('file', toBlob(buffer, mimeType), fileName);
  form.append('model', CFG.openaiWhisperModel);
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', String(prompt).slice(0, 800));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.sttTimeoutMs);

  try {
    const res = await fetch(`${CFG.openaiBase}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey()}` },
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 180)}`);
    }

    const data = await res.json();
    return {
      text: String(data?.text || '').trim(),
      language: data?.language || language,
      duration: Number(data?.duration || 0),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeWithGroq({ buffer, fileName, mimeType, language, prompt }) {
  const form = new FormData();
  form.append('file', toBlob(buffer, mimeType), fileName);
  form.append('model', CFG.groqWhisperModel);
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', String(prompt).slice(0, 800));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.sttTimeoutMs);

  try {
    const res = await fetch(`${CFG.groqBase}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey()}` },
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Groq ${res.status}: ${body.slice(0, 180)}`);
    }

    const data = await res.json();
    return {
      text: String(data?.text || '').trim(),
      language: data?.language || language,
      duration: Number(data?.duration || 0),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   04 · TTS · SÍNTESIS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Sintetiza voz a partir de texto.
 *
 * @param {object} params
 * @param {string} params.text
 * @param {string} [params.voice]
 * @param {string} [params.format]   mp3 | wav | opus | aac | flac | pcm
 * @param {number} [params.speed]
 * @returns {Promise<object>} { ok, audio: Buffer, contentType, provider }
 */
export async function speak({ text, voice, format = 'mp3', speed = 1 } = {}) {
  const clean = String(text || '').trim();

  if (!clean) {
    return { ok: false, error: 'No hay texto para leer.', code: 'empty_text' };
  }
  if (clean.length > CFG.maxChars) {
    return { ok: false, error: `El texto supera los ${CFG.maxChars} caracteres.`, code: 'text_too_long' };
  }

  const allowedFormats = ['mp3', 'wav', 'opus', 'aac', 'flac', 'pcm'];
  const outFormat = allowedFormats.includes(format) ? format : 'mp3';

  const providers = [];

  if (openaiKey()) {
    providers.push({
      name: 'openai',
      run: () => speakWithOpenAI({ text: clean, voice, format: outFormat, speed }),
    });
  }
  if (elevenKey()) {
    providers.push({
      name: 'elevenlabs',
      run: () => speakWithElevenLabs({ text: clean, voice }),
    });
  }

  if (!providers.length) {
    return {
      ok: true,
      available: false,
      provider: 'client',
      fallback: 'webspeech',
      message: 'No hay proveedor de voz configurado. Usá la síntesis del navegador.',
    };
  }

  let lastError = null;

  for (const provider of providers) {
    try {
      const result = await provider.run();
      return {
        ok: true,
        available: true,
        audio: result.audio,
        contentType: result.contentType,
        provider: provider.name,
        bytes: result.audio.length,
      };
    } catch (e) {
      lastError = e;
      LOG.warn(`voice-engine: falló el proveedor TTS ${provider.name}`, { error: e.message });
    }
  }

  return {
    ok: false,
    error: 'No se pudo generar el audio.',
    code: 'tts_failed',
    detail: lastError?.message || null,
  };
}

async function speakWithOpenAI({ text, voice, format, speed }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.ttsTimeoutMs);

  try {
    const res = await fetch(`${CFG.openaiBase}/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${openaiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CFG.openaiTtsModel,
        voice: voice || CFG.defaultVoice,
        input: text,
        response_format: format === 'opus' ? 'opus' : format,
        speed: Math.max(0.25, Math.min(Number(speed) || 1, 4)),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      // El modelo nuevo puede no existir en la cuenta: se reintenta con
      // el clásico antes de rendirse.
      if (res.status === 404 || res.status === 400) {
        return await speakWithOpenAILegacy({ text, voice, format, speed });
      }
      throw new Error(`OpenAI ${res.status}: ${body.slice(0, 180)}`);
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      audio: buffer,
      contentType: res.headers.get('content-type') || `audio/${format}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function speakWithOpenAILegacy({ text, voice, format, speed }) {
  const res = await fetch(`${CFG.openaiBase}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${openaiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: CFG.openaiTtsFallbackModel,
      voice: voice || CFG.defaultVoice,
      input: text,
      response_format: format === 'opus' ? 'opus' : format,
      speed: Math.max(0.25, Math.min(Number(speed) || 1, 4)),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 180)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  return { audio: buffer, contentType: res.headers.get('content-type') || `audio/${format}` };
}

async function speakWithElevenLabs({ text, voice }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CFG.ttsTimeoutMs);

  try {
    const voiceId = voice && voice.startsWith('eleven_') ? voice : (process.env.ELEVENLABS_VOICE_ID || CFG.defaultElevenVoice);

    const res = await fetch(`${CFG.elevenBase}/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': elevenKey(),
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: CFG.elevenModel,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`ElevenLabs ${res.status}: ${body.slice(0, 180)}`);
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    return { audio: buffer, contentType: 'audio/mpeg' };
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   05 · UTILIDADES
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Genera un id de sesión de voz (para correlacionar STT y TTS).
 */
export function createVoiceSessionId() {
  return `vs_${crypto.randomBytes(8).toString('hex')}`;
}

/**
 * Estado del motor: qué proveedores están disponibles.
 */
export function getVoiceStatus() {
  return {
    stt: {
      openai: Boolean(openaiKey()),
      groq: Boolean(groqKey()),
      available: Boolean(openaiKey() || groqKey()),
    },
    tts: {
      openai: Boolean(openaiKey()),
      elevenlabs: Boolean(elevenKey()),
      available: Boolean(openaiKey() || elevenKey()),
    },
    voices: CFG.voices,
    maxAudioMb: Math.round(CFG.maxAudioBytes / 1024 / 1024),
    maxChars: CFG.maxChars,
  };
}

export default {
  transcribe,
  speak,
  getVoiceStatus,
  createVoiceSessionId,
};
