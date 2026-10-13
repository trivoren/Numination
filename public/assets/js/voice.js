/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · voice.js · v2.0
   ─────────────────────────────────────────────────────────────────────────
   Sistema de voz completo · STT + TTS + Auto-speak + Modo lectura

   NUEVO EN v2.0:
     · Text chunker inteligente (evita corte de Chrome a los 15s)
     · Cola de TTS con seek (skip/prev oración)
     · TTS streaming (lee mientras IA escribe)
     · Server TTS hook (ElevenLabs/OpenAI ready)
     · Recorder fallback para Whisper
     · Auto-puntuación de dictado
     · Vocabulario custom
     · Wake word opt-in
     · Modo lectura fullscreen
     · Descargar TTS como audio
     · Voice favorites + recientes
     · Multi-tab coordination (BroadcastChannel)
     · Ducking de otros audios
     · Noise gate en waveform
     · Settings con tabs
     · Preview por voz
     · aria-live status
     · Progress bar TTS con click-to-seek
     · Modal de atajos
     · Player flotante
     · Frases favoritas
     · Memo de voz
     · Lazy-loading de voces con retry
     · visibilitychange cleanup
     · Error taxonomy robusta
     · History de speak + text cache

   ELIMINADO:
     · highlightWordInElement() (era una función vacía)
     · startFakeWaveform con setInterval anidado (memory leak)
     · Doble llamada a updateSpeakButtons()
     · state.currentUtterance.__btn (nunca se asignaba)
     · Re-scan de speakers cada 2s (costoso)

   API PÚBLICA:
     NM_voice.startListening() / stopListening() / toggleListening()
     NM_voice.speak(text) / stopSpeaking() / pause() / resume()
     NM_voice.skipForward() / skipBack() / seekTo(index)
     NM_voice.toggleAutoSpeak() / speakLastResponse()
     NM_voice.openSettings() / openShortcuts() / openReadingMode()
     NM_voice.isListening() / isSpeaking() / isPaused()
     NM_voice.getVoices() / getFavorites() / toggleFavorite(voiceURI)
     NM_voice.setRate(r) / setPitch(p) / setLocale(l) / setVoice(uri)
     NM_voice.downloadLastAsAudio()
     NM_voice.addFavoritePhrase(label, text) / getFavoritePhrases()
     NM_voice.startVoiceMemo() / stopVoiceMemo()
     NM_voice.test() → reporte

   EVENTOS:
     nm:voice:ready                → { hasSTT, hasTTS, hasServer }
     nm:voice:listening:start      → {}
     nm:voice:listening:end        → {}
     nm:voice:listening:error      → { error, message }
     nm:voice:transcription        → { text, final }
     nm:voice:speak:start          → { text, chunks }
     nm:voice:speak:chunk          → { index, total, text }
     nm:voice:speak:end            → {}
     nm:voice:speak:error          → { error }
     nm:voice:autospeak            → { enabled }
     nm:voice:favorites:change     → { favorites }
     nm:voice:mode:reading         → { active }
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════
     01 · CONFIGURACIÓN
     ═══════════════════════════════════════════════════════════════════════ */

  const CFG = {
    // Idioma
    locale: 'es-CO',
    fallbackLocale: 'es-ES',
    autoDetectLocale: true,

    // TTS
    rate: 1.0,
    pitch: 1.0,
    volume: 1.0,
    chunkMaxChars: 180,
    chunkMinChars: 30,
    streamMinChars: 80,       // mínimo para empezar a leer mientras escribe
    preferSpanishVoices: true,
    duckingEnabled: true,
    duckingVolume: 0.25,

    // STT
    autoStopMs: 2200,         // pausa para detener
    maxDurationMs: 120000,    // 2 min máx
    interimResults: true,
    continuous: false,
    autoPunctuate: true,
    wakeWord: '',             // ej: 'hey numi' (vacío = desactivado)
    rateLimitMs: 800,         // mínimo entre start() calls

    // Waveform
    showWaveform: true,
    noiseGateThreshold: 0.05,
    waveformBars: 40,

    // UI
    showOverlay: true,
    showTimer: true,
    showProgressBar: true,
    showFloatingPlayer: true,
    showSpeakerButtons: true,

    // Storage
    keys: {
      autoSpeak:     'numination-voice-autospeak',
      voiceURI:      'numination-voice-uri',
      rate:          'numination-voice-rate',
      pitch:         'numination-voice-pitch',
      locale:        'numination-voice-locale',
      favorites:     'numination-voice-favorites',
      recent:        'numination-voice-recent',
      phrases:       'numination-voice-phrases',
      vocabulary:    'numination-voice-vocabulary',
      ducking:       'numination-voice-ducking',
    },

    // Server TTS (opcional)
    serverTTS: {
      enabled: false,          // activar para usar ElevenLabs
      endpoint: '/api/voice/tts',
      maxConcurrent: 1,
    },

    // Debug
    logLevel: 'warn',           // silent | error | warn | info | debug
  };

  /* ═══════════════════════════════════════════════════════════════════════
     02 · LOGGER
     ═══════════════════════════════════════════════════════════════════════ */

  const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  const LOG = {
    error(...a) { if (LOG_LEVELS[CFG.logLevel] >= 1) console.error('%c[voice]', 'color:#dc2626', ...a); },
    warn(...a)  { if (LOG_LEVELS[CFG.logLevel] >= 2) console.warn ('%c[voice]', 'color:#d97706', ...a); },
    info(...a)  { if (LOG_LEVELS[CFG.logLevel] >= 3) console.info ('%c[voice]', 'color:#0284c7', ...a); },
    debug(...a) { if (LOG_LEVELS[CFG.logLevel] >= 4) console.log  ('%c[voice]', 'color:#7c5eff', ...a); },
  };

  /* ═══════════════════════════════════════════════════════════════════════
     03 · FEATURE DETECTION
     ═══════════════════════════════════════════════════════════════════════ */

  const HAS_TTS = typeof window.speechSynthesis !== 'undefined';
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const HAS_STT = !!SpeechRecognitionCtor;
  const HAS_MEDIA_RECORDER = typeof window.MediaRecorder !== 'undefined';
  const HAS_AUDIO_CTX = !!(window.AudioContext || window.webkitAudioContext);
  const HAS_BROADCAST = typeof window.BroadcastChannel !== 'undefined';

  /* ═══════════════════════════════════════════════════════════════════════
     04 · UTILS
     ═══════════════════════════════════════════════════════════════════════ */

  const $ = (s, c) => (c || document).querySelector(s);
  const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));

  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail })); }
    catch (e) { LOG.warn('emit failed', name, e); }
  }

  function toast(kind, msg, actions) {
    const T = window.__nm && window.__nm.toast;
    if (T && typeof T[kind] === 'function') {
      try { return T[kind](msg, actions); } catch (e) {}
    }
    LOG[kind === 'err' ? 'error' : kind]?.(msg);
  }

  function storeGet(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : v; }
    catch { return fallback; }
  }

  function storeSet(key, val) {
    try { localStorage.setItem(key, String(val)); } catch {}
  }

  function storeGetJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
    catch { return fallback; }
  }

  function storeSetJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  function uid(p) {
    return (p || 'x') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
  }

  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) { clearTimeout(t); t = setTimeout(() => fn.apply(this, args), ms); };
  }

  function hashCode(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) + str.charCodeAt(i);
    return (h >>> 0).toString(36);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     05 · TEXT CHUNKER · divide textos largos en frases
     ═══════════════════════════════════════════════════════════════════════ */

  /**
   * Limpia markdown y caracteres raros, y devuelve texto listo para TTS.
   * Cachea el resultado por hash del input.
   */
  const _cleanCache = new Map();

  function cleanTextForSpeech(text) {
    const key = hashCode(text);
    if (_cleanCache.has(key)) return _cleanCache.get(key);

    let t = String(text || '');

    // Quitar bloques de código
    t = t.replace(/```[\s\S]*?```/g, ' (bloque de código) ');
    // Inline code
    t = t.replace(/`([^`\n]+)`/g, '$1');
    // Negritas/itálicas
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
    t = t.replace(/\*([^*\n]+)\*/g, '$1');
    t = t.replace(/__([^_]+)__/g, '$1');
    t = t.replace(/_([^_\n]+)_/g, '$1');
    // Links e imágenes
    t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    t = t.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');
    // Headings
    t = t.replace(/^#{1,6}\s+/gm, '');
    // Listas
    t = t.replace(/^[\s]*[-*+]\s+/gm, '');
    t = t.replace(/^[\s]*\d+\.\s+/gm, '');
    // Blockquotes
    t = t.replace(/^>\s+/gm, '');
    // Separadores
    t = t.replace(/^---+$/gm, '');
    // HTML residual
    t = t.replace(/<[^>]+>/g, '');
    // Emojis
    t = t.replace(/[\u{1F300}-\u{1F9FF}]/gu, '');
    t = t.replace(/[\u{2600}-\u{27BF}]/gu, '');
    t = t.replace(/[\u{1F000}-\u{1F0FF}]/gu, '');
    // Colapsar espacios
    t = t.replace(/\s+/g, ' ').trim();

    if (_cleanCache.size > 200) {
      const first = _cleanCache.keys().next().value;
      _cleanCache.delete(first);
    }
    _cleanCache.set(key, t);
    return t;
  }

  /**
   * Divide texto en chunks respetando puntuación.
   * Chrome corta el TTS a los ~15s (≈200 chars en español).
   * Devuelve array de { text, startChar, endChar }.
   */
  function chunkText(text, opts = {}) {
    const maxLen = opts.maxLen || CFG.chunkMaxChars;
    const minLen = opts.minLen || CFG.chunkMinChars;
    const clean = opts.clean === false ? text : cleanTextForSpeech(text);
    if (!clean) return [];

    // Si es corto, un solo chunk
    if (clean.length <= maxLen) {
      return [{ text: clean, startChar: 0, endChar: clean.length }];
    }

    // Dividir por límites naturales
    const chunks = [];
    const sentences = splitSentences(clean);

    let current = '';
    let currentStart = 0;
    let cursor = 0;

    for (const sentence of sentences) {
      // Si la frase sola ya es muy larga, sub-dividir
      if (sentence.length > maxLen) {
        // Guardar el actual si existe
        if (current.trim().length >= minLen) {
          chunks.push({
            text: current.trim(),
            startChar: currentStart,
            endChar: cursor,
          });
          current = '';
        }

        // Sub-dividir la frase larga
        const subChunks = splitLongSentence(sentence, maxLen);
        for (const sub of subChunks) {
          chunks.push({
            text: sub,
            startChar: cursor,
            endChar: cursor + sub.length,
          });
          cursor += sub.length + 1;
        }
        currentStart = cursor;
        continue;
      }

      // Si añadirla supera el máximo, cerrar el actual
      if (current.length + sentence.length + 1 > maxLen && current.length >= minLen) {
        chunks.push({
          text: current.trim(),
          startChar: currentStart,
          endChar: cursor,
        });
        current = sentence;
        currentStart = cursor;
      } else {
        current += (current ? ' ' : '') + sentence;
      }
      cursor += sentence.length + 1;
    }

    // Último chunk
    if (current.trim().length > 0) {
      chunks.push({
        text: current.trim(),
        startChar: currentStart,
        endChar: cursor,
      });
    }

    return chunks;
  }

  function splitSentences(text) {
    // Split por . ! ? … seguido de espacio + mayúscula
    const parts = text.split(/(?<=[.!?…])\s+(?=[A-ZÁÉÍÓÚÑ¡¿])/);
    return parts.filter(s => s.trim().length > 0);
  }

  function splitLongSentence(sentence, maxLen) {
    // Dividir por comas, punto y coma
    const subs = sentence.split(/(?<=[,;:])\s+/);
    const out = [];
    let cur = '';
    for (const s of subs) {
      if (cur.length + s.length + 1 > maxLen && cur) {
        out.push(cur.trim());
        cur = s;
      } else {
        cur += (cur ? ' ' : '') + s;
      }
    }
    if (cur.trim()) out.push(cur.trim());

    // Si aún hay uno muy largo, cortar por palabras
    return out.flatMap(s => {
      if (s.length <= maxLen) return [s];
      const words = s.split(/\s+/);
      const result = [];
      let line = '';
      for (const w of words) {
        if (line.length + w.length + 1 > maxLen && line) {
          result.push(line);
          line = w;
        } else {
          line += (line ? ' ' : '') + w;
        }
      }
      if (line) result.push(line);
      return result;
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     06 · ESTADO GLOBAL
     ═══════════════════════════════════════════════════════════════════════ */

  const S = {
    // TTS
    speaking: false,
    paused: false,
    currentChunkIndex: 0,
    currentChunks: [],
    currentFullText: '',
    currentElement: null,
    speakStartAt: 0,
    speakSessionId: null,
    lastSpeakHistory: [],        // { text, ts }
    lastAudioBlob: null,

    // Voces
    voices: [],
    selectedVoice: null,
    favorites: new Set(),
    recentVoices: [],            // voiceURIs

    // STT
    recognition: null,
    listening: false,
    listeningStartAt: 0,
    listeningTimer: null,
    silenceTimer: null,
    interimText: '',
    lastStartAt: 0,
    retryCount: 0,
    recorderStream: null,
    mediaRecorder: null,
    recordedChunks: [],

    // Waveform
    audioCtx: null,
    analyser: null,
    waveformRAF: null,
    noiseFloor: 0,

    // UI
    overlay: null,
    settingsPanel: null,
    readingModeEl: null,
    floatingPlayer: null,
    shortcutsModal: null,

    // Estado general
    autoSpeak: false,
    rate: CFG.rate,
    pitch: CFG.pitch,
    locale: CFG.locale,
    duckingEnabled: true,
    vocabulary: [],
    favoritePhrases: [],

    // Refs
    composer: null,
    textarea: null,
    thread: null,

    // Multi-tab
    bc: null,

    // Meta
    initialized: false,
    ready: false,
    hasServerTTS: false,

    // Wake word
    wakeWordRecognition: null,

    // Voice memo
    memoMode: false,
    memoStartAt: 0,
  };

  /* ═══════════════════════════════════════════════════════════════════════
     07 · TTS ENGINE · con chunking y cola
     ═══════════════════════════════════════════════════════════════════════ */

  function loadVoices() {
    if (!HAS_TTS) return [];
    let voices = [];
    try { voices = window.speechSynthesis.getVoices() || []; }
    catch (e) { LOG.warn('getVoices failed', e); }

    if (voices.length > 0) {
      S.voices = voices;
      pickVoice();
    }
    return voices;
  }

  /**
   * Carga voces con retry. Algunos navegadores tardan en cargar el catálogo.
   */
  function loadVoicesWithRetry(maxMs) {
    return new Promise((resolve) => {
      if (!HAS_TTS) return resolve([]);
      const start = Date.now();
      const max = maxMs || 5000;

      const tryLoad = () => {
        const voices = loadVoices();
        if (voices.length > 0) return resolve(voices);
        if (Date.now() - start > max) return resolve([]);
        setTimeout(tryLoad, 400);
      };

      tryLoad();
    });
  }

  function pickVoice() {
    if (!HAS_TTS || S.voices.length === 0) return;

    // 1) Voz guardada por el usuario
    const savedUri = storeGet(CFG.keys.voiceURI, '');
    if (savedUri) {
      const saved = S.voices.find(v => v.voiceURI === savedUri);
      if (saved) { S.selectedVoice = saved; return; }
    }

    // 2) Match exacto de locale
    const langCode = S.locale.split('-')[0];
    let match = S.voices.find(v => v.lang === S.locale);
    if (match) { S.selectedVoice = match; return; }

    // 3) Match por idioma base
    match = S.voices.find(v => v.lang.startsWith(langCode));
    if (match) { S.selectedVoice = match; return; }

    // 4) Voces preferidas por nombre
    const preferred = [
      'Google español', 'Microsoft Sabina', 'Microsoft Helena', 'Microsoft Laura',
      'Paulina', 'Mónica', 'Diego', 'Jorge', 'español', 'spanish',
    ];
    for (const pref of preferred) {
      const found = S.voices.find(v => v.name.toLowerCase().includes(pref.toLowerCase()));
      if (found) { S.selectedVoice = found; return; }
    }

    // 5) Fallback
    S.selectedVoice = S.voices[0] || null;
  }

  function getSortedVoices() {
    // Spanish primero, luego favoritas, luego recientes, luego resto
    const favSet = S.favorites;
    const recentSet = new Set(S.recentVoices);

    return S.voices.slice().sort((a, b) => {
      // Favoritas primero
      const aFav = favSet.has(a.voiceURI) ? 0 : 1;
      const bFav = favSet.has(b.voiceURI) ? 0 : 1;
      if (aFav !== bFav) return aFav - bFav;

      // Recientes segundo
      const aRecent = recentSet.has(a.voiceURI) ? 0 : 1;
      const bRecent = recentSet.has(b.voiceURI) ? 0 : 1;
      if (aRecent !== bRecent) return aRecent - bRecent;

      // Spanish antes que otros si preferSpanishVoices
      if (CFG.preferSpanishVoices) {
        const aEs = a.lang.startsWith('es') ? 0 : 1;
        const bEs = b.lang.startsWith('es') ? 0 : 1;
        if (aEs !== bEs) return aEs - bEs;
      }

      // Alfabético por nombre
      return a.name.localeCompare(b.name);
    });
  }

  function rememberVoice(voice) {
    if (!voice) return;
    const uri = voice.voiceURI;
    S.recentVoices = [uri, ...S.recentVoices.filter(u => u !== uri)].slice(0, 5);
    storeSetJSON(CFG.keys.recent, S.recentVoices);
  }

  /**
   * Habla un texto usando cola de chunks.
   */
  function speak(text, opts = {}) {
    if (!HAS_TTS) {
      toast('warn', 'Tu navegador no soporta lectura en voz alta');
      return false;
    }

    const clean = cleanTextForSpeech(text);
    if (!clean) return false;

    // Guardar en historial
    S.lastSpeakHistory.unshift({ text: clean, ts: Date.now() });
    if (S.lastSpeakHistory.length > 20) S.lastSpeakHistory.length = 20;

    // Detener cualquier habla anterior
    stopSpeaking();

    const chunks = chunkText(clean, { clean: false });
    if (chunks.length === 0) return false;

    S.currentChunks = chunks;
    S.currentChunkIndex = 0;
    S.currentFullText = clean;
    S.currentElement = opts.element || null;
    S.speakStartAt = Date.now();
    S.speakSessionId = uid('speak');
    S.autoSpeak = S.autoSpeak; // no-op

    // Notificar a otras tabs
    broadcastSpeakStart(S.speakSessionId);

    // Emit
    emit('nm:voice:speak:start', { text: clean, chunks });

    // Si hay server TTS, usar eso
    if (CFG.serverTTS.enabled && S.hasServerTTS) {
      speakViaServer(clean, opts).catch(e => {
        LOG.warn('server TTS failed, falling back to browser', e);
        speakNextChunk();
      });
      return true;
    }

    speakNextChunk();
    return true;
  }

  function speakNextChunk() {
    if (S.currentChunkIndex >= S.currentChunks.length) {
      finishSpeaking();
      return;
    }

    const chunk = S.currentChunks[S.currentChunkIndex];
    const utterance = new SpeechSynthesisUtterance(chunk.text);

    utterance.voice = S.selectedVoice;
    utterance.lang = S.locale;
    utterance.rate = S.rate;
    utterance.pitch = S.pitch;
    utterance.volume = CFG.volume;

    utterance.onstart = () => {
      S.speaking = true;
      S.paused = false;
      emit('nm:voice:speak:chunk', {
        index: S.currentChunkIndex,
        total: S.currentChunks.length,
        text: chunk.text,
      });
      updateFloatingPlayer();
      updateSpeakButtons();
      updateStatus('speaking');
    };

    utterance.onend = () => {
      // Si el usuario detuvo, no continuar
      if (!S.speaking && !S.paused) return;

      S.currentChunkIndex++;
      if (S.currentChunkIndex < S.currentChunks.length) {
        speakNextChunk();
      } else {
        finishSpeaking();
      }
    };

    utterance.onerror = (e) => {
      const err = e.error;
      // Errores benignos
      if (err === 'interrupted' || err === 'canceled') return;
      // Cancelación por stop
      if (err === 'not-allowed') {
        LOG.warn('TTS not allowed');
        toast('warn', 'No puedo hablar, revisá los permisos');
      } else {
        LOG.error('TTS error', err);
      }
      emit('nm:voice:speak:error', { error: err });
      // Intentar continuar con el siguiente
      S.currentChunkIndex++;
      if (S.currentChunkIndex < S.currentChunks.length) speakNextChunk();
      else finishSpeaking();
    };

    try {
      window.speechSynthesis.speak(utterance);
      S.currentUtterance = utterance;
      startDucking();
    } catch (e) {
      LOG.error('speechSynthesis.speak failed', e);
      finishSpeaking();
    }
  }

  function finishSpeaking() {
    S.speaking = false;
    S.paused = false;
    S.currentUtterance = null;
    S.currentChunks = [];
    S.currentChunkIndex = 0;
    stopDucking();
    updateFloatingPlayer();
    updateSpeakButtons();
    updateStatus('idle');
    emit('nm:voice:speak:end', {});
  }

  function stopSpeaking() {
    if (!HAS_TTS) return;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    S.speaking = false;
    S.paused = false;
    S.currentUtterance = null;
    S.currentChunks = [];
    S.currentChunkIndex = 0;
    stopDucking();
    updateFloatingPlayer();
    updateSpeakButtons();
    updateStatus('idle');
  }

  function pauseSpeaking() {
    if (!HAS_TTS || !S.speaking) return;
    try {
      window.speechSynthesis.pause();
      S.paused = true;
      updateFloatingPlayer();
      updateSpeakButtons();
      updateStatus('paused');
    } catch (e) { LOG.warn('pause failed', e); }
  }

  function resumeSpeaking() {
    if (!HAS_TTS || !S.paused) return;
    try {
      window.speechSynthesis.resume();
      S.paused = false;
      updateFloatingPlayer();
      updateSpeakButtons();
      updateStatus('speaking');
    } catch (e) { LOG.warn('resume failed', e); }
  }

  function skipForward() {
    if (!HAS_TTS || !S.speaking) return;
    if (S.currentChunkIndex >= S.currentChunks.length - 1) {
      stopSpeaking();
      return;
    }
    try { window.speechSynthesis.cancel(); } catch (e) {}
    S.currentChunkIndex++;
    setTimeout(speakNextChunk, 50);
  }

  function skipBack() {
    if (!HAS_TTS) return;
    if (S.currentChunkIndex <= 0) return;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    S.currentChunkIndex--;
    setTimeout(speakNextChunk, 50);
  }

  function seekTo(index) {
    if (!HAS_TTS) return;
    if (index < 0 || index >= S.currentChunks.length) return;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    S.currentChunkIndex = index;
    setTimeout(speakNextChunk, 50);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     08 · SERVER TTS HOOK (ElevenLabs / OpenAI TTS ready)
     ═══════════════════════════════════════════════════════════════════════ */

  async function speakViaServer(text, opts) {
    const res = await fetch(CFG.serverTTS.endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text,
        voice: opts.voice || 'default',
        locale: S.locale,
      }),
    });

    if (!res.ok) throw new Error('Server TTS HTTP ' + res.status);

    const blob = await res.blob();
    S.lastAudioBlob = blob;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    S.currentAudioEl = audio;

    audio.onplay = () => {
      S.speaking = true;
      updateFloatingPlayer();
      updateStatus('speaking');
    };

    audio.onended = () => {
      S.speaking = false;
      URL.revokeObjectURL(url);
      finishSpeaking();
    };

    audio.onerror = () => {
      URL.revokeObjectURL(url);
      finishSpeaking();
    };

    await audio.play();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     09 · DUCKING · baja otros audios mientras habla
     ═══════════════════════════════════════════════════════════════════════ */

  const _ducked = [];

  function startDucking() {
    if (!S.duckingEnabled) return;
    if (!CFG.duckingEnabled) return;

    $$('audio, video').forEach(el => {
      if (el === S.currentAudioEl) return;
      if (el.paused) return;
      if (el.__nmVoiceDucked) return;
      el.__nmVoiceDucked = true;
      el.__nmVoiceOriginalVolume = el.volume;
      el.volume = Math.max(0, el.volume * CFG.duckingVolume);
      _ducked.push(el);
    });
  }

  function stopDucking() {
    while (_ducked.length > 0) {
      const el = _ducked.pop();
      if (el && el.__nmVoiceDucked) {
        try { el.volume = el.__nmVoiceOriginalVolume ?? 1; } catch (e) {}
        delete el.__nmVoiceDucked;
        delete el.__nmVoiceOriginalVolume;
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     10 · MULTI-TAB COORDINATION (BroadcastChannel)
     ═══════════════════════════════════════════════════════════════════════ */

  function initMultiTab() {
    if (!HAS_BROADCAST) return;
    try {
      S.bc = new BroadcastChannel('nm-voice');
      S.bc.addEventListener('message', (e) => {
        const { type, sessionId } = e.data || {};
        if (type === 'speak-start' && sessionId !== S.speakSessionId) {
          // Otra pestaña empezó a hablar → nosotros paramos
          if (S.speaking) {
            LOG.info('otra tab habla, detengo');
            stopSpeaking();
          }
          if (S.listening) {
            LOG.info('otra tab habla, detengo STT');
            stopListening(true);
          }
        }
      });
    } catch (e) {
      LOG.warn('BroadcastChannel failed', e);
    }
  }

  function broadcastSpeakStart(sessionId) {
    if (!S.bc) return;
    try { S.bc.postMessage({ type: 'speak-start', sessionId }); }
    catch (e) {}
  }

  /* ═══════════════════════════════════════════════════════════════════════
     11 · STT ENGINE · reconocimiento con auto-puntuación
     ═══════════════════════════════════════════════════════════════════════ */

  function initRecognition() {
    if (!HAS_STT) return null;

    const rec = new SpeechRecognitionCtor();
    rec.lang = S.locale;
    rec.continuous = CFG.continuous;
    rec.interimResults = CFG.interimResults;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      S.listening = true;
      S.listeningStartAt = Date.now();
      S.interimText = '';
      S.lastStartAt = Date.now();

      applyVocabularyHints(rec);

      showOverlay();
      startTimer();
      updateMicButton();
      updateStatus('listening');
      emit('nm:voice:listening:start', {});

      if (navigator.vibrate) try { navigator.vibrate(30); } catch (e) {}
    };

    rec.onresult = (event) => {
      resetSilenceTimer();

      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += transcript;
        else interim += transcript;
      }

      if (final) {
        let text = final.trim();
        if (CFG.autoPunctuate) text = autoPunctuate(text);
        S.interimText = text;
        emit('nm:voice:transcription', { text, final: true });
      } else if (interim) {
        S.interimText = interim;
        updateOverlayText(interim);
        emit('nm:voice:transcription', { text: interim, final: false });
      }
    };

    rec.onerror = (event) => {
      const err = event.error;

      // Ignorar aborted (fue un stop manual)
      if (err === 'aborted') return;

      const msg = errorMessageForSTT(err);
      toast('err', msg);

      LOG.warn('STT error', err);
      emit('nm:voice:listening:error', { error: err, message: msg });

      stopListening(true);
    };

    rec.onend = () => {
      const wasListening = S.listening;
      S.listening = false;

      stopTimer();
      hideOverlay();
      updateMicButton();
      updateStatus('idle');

      if (wasListening && S.interimText) {
        let text = S.interimText.trim();
        if (text && CFG.autoPunctuate && !/[.!?]$/.test(text)) {
          text = autoPunctuate(text);
        }
        if (text) {
          if (S.memoMode) {
            // Modo memo: no insertar, solo notificar
            emit('nm:voice:memo:transcription', { text });
          } else {
            insertTextIntoComposer(text);
          }
          emit('nm:voice:listening:end', { text });
        }
      } else {
        emit('nm:voice:listening:end', {});
      }

      S.interimText = '';
    };

    return rec;
  }

  function applyVocabularyHints(rec) {
    // Algunos browsers soportan `rec.phrases` (Chrome con flag)
    if (S.vocabulary.length > 0 && 'phrases' in rec) {
      try { rec.phrases = S.vocabulary; }
      catch (e) { /* no soportado */ }
    }
  }

  function errorMessageForSTT(err) {
    const map = {
      'not-allowed': 'Permiso de micrófono denegado. Habilitalo en la barra del navegador.',
      'no-speech': 'No escuché nada. Intentá de nuevo.',
      'audio-capture': 'No encontré micrófono. Verificá que esté conectado.',
      'network': 'Sin conexión a internet.',
      'service-not-allowed': 'Servicio de voz no disponible en este navegador.',
      'language-not-supported': 'Idioma no soportado. Probá con Español.',
      'bad-grammar': 'Error de reconocimiento. Reformulá la frase.',
    };
    return map[err] || 'Error de reconocimiento de voz';
  }

  /**
   * Añade puntuación heurística al texto dictado.
   * El STT nativo no añade puntuación salvo si la decís explícitamente.
   */
  function autoPunctuate(text) {
    if (!text) return text;

    // Pausas largas → coma o punto
    let t = text.trim();

    // Capitalizar primera letra
    t = t.charAt(0).toUpperCase() + t.slice(1);

    // Detección de preguntas (¿qué, cómo, cuándo, dónde, quién, por qué)
    const questionStarters = /^(qué|que|cómo|como|cuándo|cuando|dónde|donde|quién|quien|por qué|por que|cuál|cual|cuánto|cuanto)\b/i;
    if (questionStarters.test(t) && !/[?!]$/.test(t)) {
      t = '¿' + t + '?';
    } else if (!/[.!?]$/.test(t)) {
      t = t + '.';
    }

    // Pausas largas → comas (más de 3 palabras entre comas, detectado por silencios largos)
    // Esto es heurístico. El STT nativo no da timestamps, así que no podemos
    // detectar bien las pausas. Añadimos comas después de conectores comunes.
    const connectors = /\b(pero|entonces|además|ademas|sin embargo|por ejemplo|es decir|o sea)\b/gi;
    t = t.replace(connectors, (match) => match + ',');

    // Limpiar comas dobles
    t = t.replace(/,\s*,/g, ',');

    return t;
  }

  function startListening() {
    if (!HAS_STT) {
      toast('warn', 'Tu navegador no soporta dictado por voz. Probá con Chrome o Edge.');
      return false;
    }

    if (S.listening) return true;

    // Rate limit
    const elapsed = Date.now() - S.lastStartAt;
    if (elapsed < CFG.rateLimitMs) {
      LOG.debug('rate limited');
      return false;
    }

    stopSpeaking();

    S.recognition = initRecognition();
    if (!S.recognition) return false;

    try {
      S.recognition.start();
      S.retryCount = 0;
      return true;
    } catch (e) {
      // Si ya estaba iniciado, no es error
      if (e.message && /already started/i.test(e.message)) return true;

      LOG.error('start failed', e);
      toast('err', 'No pude iniciar el micrófono');
      return false;
    }
  }

  function stopListening(silent) {
    if (!S.recognition) return;
    try {
      S.recognition.stop();
      if (!silent && navigator.vibrate) try { navigator.vibrate(15); } catch (e) {}
    } catch (e) {
      LOG.warn('stop failed', e);
    }
  }

  function toggleListening() {
    if (S.listening) stopListening();
    else startListening();
  }

  function resetSilenceTimer() {
    clearTimeout(S.silenceTimer);
    S.silenceTimer = setTimeout(() => {
      if (S.listening && S.interimText) {
        LOG.debug('auto-stop por silencio');
        stopListening();
      }
    }, CFG.autoStopMs);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     12 · VOICE MEMO MODE
     ═══════════════════════════════════════════════════════════════════════ */

  function startVoiceMemo() {
    S.memoMode = true;
    S.memoStartAt = Date.now();
    toast('info', 'Modo memo activo · grabá hasta 30s');
    startListening();
    setTimeout(() => {
      if (S.memoMode && S.listening) {
        stopListening();
        S.memoMode = false;
      }
    }, 30000);
  }

  function stopVoiceMemo() {
    S.memoMode = false;
    stopListening();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     13 · AUDIO RECORDER (fallback para Whisper)
     ═══════════════════════════════════════════════════════════════════════ */

  async function startRecording() {
    if (!HAS_MEDIA_RECORDER) {
      toast('warn', 'Tu navegador no puede grabar audio');
      return null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      S.recorderStream = stream;
      S.recordedChunks = [];

      const mr = new MediaRecorder(stream, { mimeType: getBestAudioMime() });
      S.mediaRecorder = mr;

      mr.ondataavailable = (e) => {
        if (e.data.size > 0) S.recordedChunks.push(e.data);
      };

      mr.start();
      return mr;
    } catch (e) {
      LOG.warn('recorder failed', e);
      return null;
    }
  }

  function getBestAudioMime() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
      'audio/wav',
    ];
    for (const m of candidates) {
      try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
    }
    return '';
  }

  async function stopRecording() {
    return new Promise((resolve) => {
      const mr = S.mediaRecorder;
      if (!mr) return resolve(null);

      mr.onstop = () => {
        const blob = new Blob(S.recordedChunks, { type: mr.mimeType || 'audio/webm' });
        S.lastAudioBlob = blob;
        if (S.recorderStream) {
          S.recorderStream.getTracks().forEach(t => t.stop());
          S.recorderStream = null;
        }
        S.mediaRecorder = null;
        S.recordedChunks = [];
        resolve(blob);
      };

      try { mr.stop(); }
      catch (e) { resolve(null); }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     14 · WAVEFORM VISUALIZER (RAF-based, sin leaks)
     ═══════════════════════════════════════════════════════════════════════ */

  async function startWaveform() {
    if (!CFG.showWaveform) return;
    if (!HAS_AUDIO_CTX) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      S.recorderStream = stream;

      const Ctx = window.AudioContext || window.webkitAudioContext;
      S.audioCtx = new Ctx();
      const source = S.audioCtx.createMediaStreamSource(stream);
      S.analyser = S.audioCtx.createAnalyser();
      S.analyser.fftSize = 64;
      S.analyser.smoothingTimeConstant = 0.7;
      source.connect(S.analyser);

      const dataArray = new Uint8Array(S.analyser.frequencyBinCount);

      const tick = () => {
        if (!S.analyser || !S.overlay || !S.overlay.waveformEl) return;
        S.analyser.getByteFrequencyData(dataArray);

        // Calcular noise floor
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length / 255;
        S.noiseFloor = S.noiseFloor * 0.9 + avg * 0.1;

        const bars = S.overlay.waveformEl.children;
        for (let i = 0; i < bars.length; i++) {
          const idx = Math.floor((i / bars.length) * dataArray.length);
          const raw = dataArray[idx] / 255;
          // Noise gate: por debajo del umbral → 0.15
          const v = raw < CFG.noiseGateThreshold ? 0.15 : raw;
          bars[i].style.transform = 'scaleY(' + (0.15 + v * 0.85) + ')';
        }

        S.waveformRAF = requestAnimationFrame(tick);
      };

      tick();
    } catch (e) {
      LOG.debug('waveform failed', e);
      startIdleWaveform();
    }
  }

  /**
   * Waveform idle con animación suave sin grabación real.
   * Reemplaza el startFakeWaveform() de v1.0 (que tenía un leak de setInterval).
   */
  function startIdleWaveform() {
    if (!S.overlay || !S.overlay.waveformEl) return;
    const bars = S.overlay.waveformEl.children;
    let phase = 0;

    const tick = () => {
      phase += 0.12;
      for (let i = 0; i < bars.length; i++) {
        const v = 0.15 + 0.35 * Math.abs(Math.sin(phase + i * 0.4));
        bars[i].style.transform = 'scaleY(' + v + ')';
      }
      S.waveformRAF = requestAnimationFrame(tick);
    };
    tick();
  }

  function stopWaveform() {
    if (S.waveformRAF) {
      cancelAnimationFrame(S.waveformRAF);
      S.waveformRAF = null;
    }

    // Solo cerrar el stream si es el del waveform (no el del recorder)
    if (S.recorderStream && !S.mediaRecorder) {
      S.recorderStream.getTracks().forEach(t => t.stop());
      S.recorderStream = null;
    }

    if (S.audioCtx) {
      S.audioCtx.close().catch(() => {});
      S.audioCtx = null;
    }
    S.analyser = null;
    S.noiseFloor = 0;

    // Resetear barras
    if (S.overlay && S.overlay.waveformEl) {
      Array.from(S.overlay.waveformEl.children).forEach(b => {
        b.style.transform = 'scaleY(0.15)';
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     15 · OVERLAY DE GRABACIÓN
     ═══════════════════════════════════════════════════════════════════════ */

  function ensureOverlay() {
    if (S.overlay && S.overlay.el && document.body.contains(S.overlay.el)) return S.overlay;

    const overlay = document.createElement('div');
    overlay.className = 'nm-voice-overlay';
    overlay.id = 'nm-voice-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="nm-voice-overlay__backdrop"></div>
      <div class="nm-voice-overlay__panel" role="dialog" aria-label="Dictado por voz">
        <div class="nm-voice-overlay__head">
          <div class="nm-voice-overlay__pulse" aria-hidden="true"></div>
          <span class="nm-voice-overlay__label" data-status>Escuchando…</span>
          <button class="nm-voice-overlay__close" data-action="cancel" aria-label="Cancelar" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div class="nm-voice-overlay__waveform" data-waveform aria-hidden="true">
          ${Array.from({ length: CFG.waveformBars }).map(() => '<span></span>').join('')}
        </div>
        <div class="nm-voice-overlay__text" data-text>Decí algo…</div>
        <div class="nm-voice-overlay__foot">
          <div class="nm-voice-overlay__timer" data-timer aria-live="off">00:00</div>
          <button class="nm-voice-overlay__btn" data-action="stop" type="button">
            <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
            <span>Detener</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    S.overlay = {
      el: overlay,
      timerEl: overlay.querySelector('[data-timer]'),
      waveformEl: overlay.querySelector('[data-waveform]'),
      textEl: overlay.querySelector('[data-text]'),
      statusEl: overlay.querySelector('[data-status]'),
    };

    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]');
      if (!action) return;
      if (action.dataset.action === 'cancel') {
        S.interimText = '';
        stopListening(true);
      } else if (action.dataset.action === 'stop') {
        stopListening();
      }
    });

    return S.overlay;
  }

  function showOverlay() {
    if (!CFG.showOverlay) return;
    const ov = ensureOverlay();
    ov.el.hidden = false;
    void ov.el.offsetHeight;
    ov.el.classList.add('is-visible');
    updateOverlayText('');
    startWaveform();
  }

  function hideOverlay() {
    if (!S.overlay || !S.overlay.el) return;
    S.overlay.el.classList.remove('is-visible');
    setTimeout(() => {
      if (S.overlay && S.overlay.el) S.overlay.el.hidden = true;
    }, 200);
    stopWaveform();
  }

  function updateOverlayText(text) {
    if (!S.overlay || !S.overlay.textEl) return;
    if (!text || !text.trim()) {
      S.overlay.textEl.textContent = 'Decí algo…';
      S.overlay.textEl.classList.add('is-empty');
    } else {
      S.overlay.textEl.textContent = text;
      S.overlay.textEl.classList.remove('is-empty');
    }
  }

  function startTimer() {
    S.listeningStartAt = Date.now();
    S.listeningTimer = setInterval(() => {
      if (!S.overlay || !S.overlay.timerEl) return;
      const elapsed = Date.now() - S.listeningStartAt;
      S.overlay.timerEl.textContent = fmtTime(elapsed);
      if (elapsed > CFG.maxDurationMs) {
        LOG.debug('auto-stop por duración máxima');
        stopListening();
      }
    }, 100);
  }

  function stopTimer() {
    clearInterval(S.listeningTimer);
    S.listeningTimer = null;
    clearTimeout(S.silenceTimer);
    S.silenceTimer = null;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     16 · INSERCIÓN EN COMPOSER
     ═══════════════════════════════════════════════════════════════════════ */

  function insertTextIntoComposer(text) {
    if (!text) return;

    const field = $('[data-field]') || $('.composer textarea') || $('textarea[placeholder*="Escrib"]');
    if (!field) {
      LOG.warn('no composer field found');
      return;
    }

    const current = field.value || '';
    const separator = current.trim() && !/\s$/.test(current) ? ' ' : '';
    field.value = current + separator + text;

    field.focus();
    try { field.setSelectionRange(field.value.length, field.value.length); } catch (e) {}
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* ═══════════════════════════════════════════════════════════════════════
     17 · MIC BUTTON
     ═══════════════════════════════════════════════════════════════════════ */

  function findOrCreateMicButton() {
    let btn = $('[data-voice-mic]');
    if (btn) return btn;

    // Buscar por aria/title
    btn = $('[aria-label*="micrófono" i]') || $('[aria-label*="microphone" i]') || $('[title*="micrófono" i]');
    if (btn) { btn.setAttribute('data-voice-mic', ''); return btn; }

    // Crear
    const composer = $('.composer');
    if (!composer) return null;

    const sendBtn = composer.querySelector('[type="submit"]');
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'composer__mic';
    btn.setAttribute('data-voice-mic', '');
    btn.setAttribute('aria-label', 'Dictar por voz');
    btn.title = 'Dictar por voz (Ctrl+M)';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="2" width="6" height="12" rx="3"/>
        <path d="M5 10v1a7 7 0 0 0 14 0v-1"/>
        <line x1="12" y1="18" x2="12" y2="22"/>
        <line x1="8" y1="22" x2="16" y2="22"/>
      </svg>
    `;

    if (sendBtn && sendBtn.parentNode === composer) {
      composer.insertBefore(btn, sendBtn);
    } else {
      composer.appendChild(btn);
    }
    return btn;
  }

  function updateMicButton() {
    const btn = S.micBtn || findOrCreateMicButton();
    if (!btn) return;
    btn.classList.toggle('is-listening', S.listening);
    btn.setAttribute('aria-pressed', String(S.listening));
    btn.title = S.listening ? 'Detener dictado' : 'Dictar por voz (Ctrl+M)';
  }

  function wireMicButton() {
    S.micBtn = findOrCreateMicButton();
    if (!S.micBtn) return;
    if (S.micBtn.__nmWired) return;
    S.micBtn.__nmWired = true;

    S.micBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleListening();
    });
    updateMicButton();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     18 · SPEAKER EN MENSAJES
     ═══════════════════════════════════════════════════════════════════════ */

  function injectSpeakerIntoMessage(messageEl) {
    if (!messageEl || !CFG.showSpeakerButtons) return;
    if (messageEl.__nmVoiceSpeaker) return;

    const isAI = messageEl.classList.contains('message--assistant')
              || messageEl.classList.contains('message--ai')
              || messageEl.dataset.role === 'ai'
              || messageEl.dataset.role === 'assistant';
    if (!isAI) return;

    const textEl = messageEl.querySelector('.message__text, .message__content');
    if (!textEl) return;
    if (messageEl.querySelector('.nm-voice-speaker')) return;

    messageEl.__nmVoiceSpeaker = true;

    const actions = document.createElement('div');
    actions.className = 'nm-voice-actions';

    const speakBtn = document.createElement('button');
    speakBtn.type = 'button';
    speakBtn.className = 'nm-voice-speaker';
    speakBtn.setAttribute('aria-label', 'Leer en voz alta');
    speakBtn.title = 'Leer en voz alta';
    speakBtn.innerHTML = `
      <svg class="nm-voice-speaker__icon nm-voice-speaker__icon--play" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
      </svg>
      <svg class="nm-voice-speaker__icon nm-voice-speaker__icon--stop" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="2"/>
      </svg>
    `;

    speakBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (S.speaking) {
        stopSpeaking();
      } else {
        const text = extractTextFromMessage(textEl);
        speak(text, { element: textEl });
      }
    });

    actions.appendChild(speakBtn);
    textEl.appendChild(actions);
    messageEl.__nmVoiceSpeakBtn = speakBtn;
  }

  function extractTextFromMessage(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.nm-voice-actions, button, svg, pre, code').forEach(n => n.remove());
    return (clone.textContent || '').trim();
  }

  /**
   * Actualiza el estado de todos los botones speaker.
   * v2.0: una sola pasada en vez de la duplicación de v1.0
   */
  function updateSpeakButtons() {
    const speaking = S.speaking;
    $$('.nm-voice-speaker').forEach(btn => {
      btn.classList.toggle('is-speaking', speaking);
      btn.setAttribute('aria-pressed', String(speaking));
    });
  }

  function scanThreadForSpeakers() {
    const thread = $('[data-thread]');
    if (!thread) return;
    $$('.message', thread).forEach(injectSpeakerIntoMessage);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     19 · AUTO-SPEAK
     ═══════════════════════════════════════════════════════════════════════ */

  function toggleAutoSpeak(force) {
    const next = typeof force === 'boolean' ? force : !S.autoSpeak;
    S.autoSpeak = next;
    storeSet(CFG.keys.autoSpeak, next ? '1' : '0');
    updateSettingsUI();
    toast('ok', next ? 'Auto-lectura activada' : 'Auto-lectura desactivada');
    emit('nm:voice:autospeak', { enabled: next });
    return next;
  }

  function speakLastResponse() {
    const thread = $('[data-thread]');
    if (!thread) return;
    const messages = $$('.message--assistant, .message--ai, [data-role="assistant"], [data-role="ai"]', thread);
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    const textEl = last.querySelector('.message__text, .message__content');
    if (!textEl) return;
    const text = extractTextFromMessage(textEl);
    speak(text, { element: textEl });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     20 · FLOATING PLAYER
     ═══════════════════════════════════════════════════════════════════════ */

  function ensureFloatingPlayer() {
    if (S.floatingPlayer && document.body.contains(S.floatingPlayer.el)) return S.floatingPlayer;
    if (!CFG.showFloatingPlayer) return null;

    const el = document.createElement('div');
    el.className = 'nm-voice-player';
    el.hidden = true;
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', 'Reproductor de voz');
    el.innerHTML = `
      <div class="nm-voice-player__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        </svg>
      </div>
      <div class="nm-voice-player__progress" data-progress>
        <div class="nm-voice-player__bar" data-bar></div>
      </div>
      <div class="nm-voice-player__controls">
        <button type="button" class="nm-voice-player__btn" data-action="prev" title="Anterior (←)">
          <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="19 20 9 12 19 4"/><line x1="5" y1="19" x2="5" y2="5" stroke="currentColor" stroke-width="2"/></svg>
        </button>
        <button type="button" class="nm-voice-player__btn" data-action="pause" title="Pausar (Espacio)">
          <svg viewBox="0 0 24 24" fill="currentColor" data-icon="pause"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
          <svg viewBox="0 0 24 24" fill="currentColor" data-icon="play" style="display:none"><polygon points="5 3 19 12 5 21"/></svg>
        </button>
        <button type="button" class="nm-voice-player__btn" data-action="next" title="Siguiente (→)">
          <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="5 4 15 12 5 20"/><line x1="19" y1="5" x2="19" y2="19" stroke="currentColor" stroke-width="2"/></svg>
        </button>
        <button type="button" class="nm-voice-player__btn" data-action="close" title="Cerrar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>
      <div class="nm-voice-player__time" data-time aria-live="off">0/0</div>
    `;

    document.body.appendChild(el);

    S.floatingPlayer = {
      el,
      bar: el.querySelector('[data-bar]'),
      progress: el.querySelector('[data-progress]'),
      time: el.querySelector('[data-time]'),
      pauseBtn: el.querySelector('[data-action="pause"]'),
      pauseIcon: el.querySelector('[data-icon="pause"]'),
      playIcon: el.querySelector('[data-icon="play"]'),
    };

    el.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'prev') skipBack();
      else if (action === 'next') skipForward();
      else if (action === 'pause') {
        if (S.paused) resumeSpeaking();
        else pauseSpeaking();
      } else if (action === 'close') stopSpeaking();
    });

    // Click en progress → seek
    S.floatingPlayer.progress.addEventListener('click', (e) => {
      const rect = S.floatingPlayer.progress.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      const targetChunk = Math.floor(pct * S.currentChunks.length);
      seekTo(targetChunk);
    });

    return S.floatingPlayer;
  }

  function updateFloatingPlayer() {
    const player = S.floatingPlayer || ensureFloatingPlayer();
    if (!player) return;

    if (!S.speaking) {
      player.el.hidden = true;
      player.el.classList.remove('is-visible');
      return;
    }

    player.el.hidden = false;
    void player.el.offsetHeight;
    player.el.classList.add('is-visible');

    const total = S.currentChunks.length;
    const cur = S.currentChunkIndex;
    const pct = total > 0 ? ((cur + 1) / total) * 100 : 0;
    player.bar.style.width = pct + '%';
    player.time.textContent = (cur + 1) + '/' + total;

    player.pauseIcon.style.display = S.paused ? 'none' : '';
    player.playIcon.style.display = S.paused ? '' : 'none';
  }

  /* ═══════════════════════════════════════════════════════════════════════
     21 · READING MODE
     ═══════════════════════════════════════════════════════════════════════ */

  function openReadingMode(text) {
    if (!text) {
      // Leer la última respuesta del thread
      const thread = $('[data-thread]');
      if (!thread) return;
      const msgs = $$('.message--assistant, .message--ai', thread);
      if (msgs.length === 0) return;
      const el = msgs[msgs.length - 1].querySelector('.message__text');
      text = el ? extractTextFromMessage(el) : '';
    }

    if (!text) return;

    closeReadingMode();

    const el = document.createElement('div');
    el.className = 'nm-reading-mode';
    el.innerHTML = `
      <div class="nm-reading-mode__head">
        <button class="nm-reading-mode__close" data-action="close" aria-label="Cerrar">✕</button>
        <span class="nm-reading-mode__title">Modo lectura</span>
        <div class="nm-reading-mode__controls">
          <button data-action="rate-down" title="Más lento">−</button>
          <span class="nm-reading-mode__rate" data-rate>1.0x</span>
          <button data-action="rate-up" title="Más rápido">+</button>
        </div>
      </div>
      <div class="nm-reading-mode__body">
        <div class="nm-reading-mode__text" data-text></div>
      </div>
      <div class="nm-reading-mode__foot">
        <button class="nm-reading-mode__play" data-action="play" aria-label="Play/Pausa">▶</button>
      </div>
    `;

    el.querySelector('[data-text]').textContent = text;
    document.body.appendChild(el);
    S.readingModeEl = el;

    requestAnimationFrame(() => el.classList.add('is-visible'));

    el.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'close') closeReadingMode();
      else if (action === 'play') {
        if (S.speaking) stopSpeaking();
        else speak(text);
      } else if (action === 'rate-up') {
        S.rate = Math.min(2, S.rate + 0.1);
        storeSet(CFG.keys.rate, S.rate);
        el.querySelector('[data-rate]').textContent = S.rate.toFixed(1) + 'x';
      } else if (action === 'rate-down') {
        S.rate = Math.max(0.5, S.rate - 0.1);
        storeSet(CFG.keys.rate, S.rate);
        el.querySelector('[data-rate]').textContent = S.rate.toFixed(1) + 'x';
      }
    });

    el.querySelector('[data-rate]').textContent = S.rate.toFixed(1) + 'x';
    emit('nm:voice:mode:reading', { active: true });
  }

  function closeReadingMode() {
    if (!S.readingModeEl) return;
    const el = S.readingModeEl;
    S.readingModeEl = null;
    el.classList.remove('is-visible');
    setTimeout(() => el.remove(), 200);
    emit('nm:voice:mode:reading', { active: false });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     22 · SETTINGS PANEL (con tabs)
     ═══════════════════════════════════════════════════════════════════════ */

  function ensureSettingsPanel() {
    if (S.settingsPanel && document.body.contains(S.settingsPanel.el)) return S.settingsPanel;

    const panel = document.createElement('div');
    panel.className = 'nm-voice-settings';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Configuración de voz');

    panel.innerHTML = `
      <div class="nm-voice-settings__backdrop" data-close></div>
      <div class="nm-voice-settings__panel">
        <div class="nm-voice-settings__head">
          <h3>Configuración de voz</h3>
          <button class="nm-voice-settings__close" data-close aria-label="Cerrar" type="button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div class="nm-voice-settings__tabs" role="tablist">
          <button class="is-active" data-tab="general" role="tab">General</button>
          <button data-tab="voice" role="tab">Voz</button>
          <button data-tab="dictation" role="tab">Dictado</button>
          <button data-tab="advanced" role="tab">Avanzado</button>
        </div>

        <div class="nm-voice-settings__body">
          <!-- GENERAL -->
          <div class="nm-voice-settings__tab" data-tab-content="general">
            <div class="nm-voice-settings__row">
              <label class="nm-voice-settings__label">
                Leer respuestas automáticamente
                <span class="nm-voice-settings__hint">Lee cada respuesta de Numi al terminar</span>
              </label>
              <label class="nm-voice-toggle">
                <input type="checkbox" data-setting="autospeak" />
                <span class="nm-voice-toggle__track"><span class="nm-voice-toggle__thumb"></span></span>
              </label>
            </div>
            <div class="nm-voice-settings__row">
              <label class="nm-voice-settings__label">
                Reducir otros audios
                <span class="nm-voice-settings__hint">Baja el volumen de música/videos mientras habla</span>
              </label>
              <label class="nm-voice-toggle">
                <input type="checkbox" data-setting="ducking" />
                <span class="nm-voice-toggle__track"><span class="nm-voice-toggle__thumb"></span></span>
              </label>
            </div>
          </div>

          <!-- VOZ -->
          <div class="nm-voice-settings__tab" data-tab-content="voice" hidden>
            <div class="nm-voice-settings__row nm-voice-settings__row--stack">
              <label class="nm-voice-settings__label">Voz</label>
              <div class="nm-voice-settings__voice-picker">
                <select class="nm-voice-settings__select" data-setting="voice"></select>
                <button type="button" class="nm-voice-settings__star" data-action="favorite" title="Marcar como favorita">★</button>
              </div>
            </div>
            <div class="nm-voice-settings__row">
              <label class="nm-voice-settings__label">
                Velocidad
                <span class="nm-voice-settings__value" data-value="rate">1.0x</span>
              </label>
              <input type="range" class="nm-voice-settings__range" data-setting="rate" min="0.5" max="2" step="0.1" />
            </div>
            <div class="nm-voice-settings__row">
              <label class="nm-voice-settings__label">
                Tono
                <span class="nm-voice-settings__value" data-value="pitch">1.0</span>
              </label>
              <input type="range" class="nm-voice-settings__range" data-setting="pitch" min="0.5" max="1.5" step="0.1" />
            </div>
            <div class="nm-voice-settings__actions">
              <button class="nm-voice-settings__test" data-action="test" type="button">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/></svg>
                Probar voz
              </button>
            </div>
          </div>

          <!-- DICTADO -->
          <div class="nm-voice-settings__tab" data-tab-content="dictation" hidden>
            <div class="nm-voice-settings__row nm-voice-settings__row--stack">
              <label class="nm-voice-settings__label">Idioma de dictado</label>
              <select class="nm-voice-settings__select" data-setting="locale">
                <option value="es-CO">Español (Colombia)</option>
                <option value="es-ES">Español (España)</option>
                <option value="es-MX">Español (México)</option>
                <option value="es-AR">Español (Argentina)</option>
                <option value="en-US">English (US)</option>
                <option value="pt-BR">Português (Brasil)</option>
              </select>
            </div>
            <div class="nm-voice-settings__row">
              <label class="nm-voice-settings__label">
                Auto-puntuación
                <span class="nm-voice-settings__hint">Añade comas y puntos al dictado</span>
              </label>
              <label class="nm-voice-toggle">
                <input type="checkbox" data-setting="autoPunctuate" />
                <span class="nm-voice-toggle__track"><span class="nm-voice-toggle__thumb"></span></span>
              </label>
            </div>
          </div>

          <!-- AVANZADO -->
          <div class="nm-voice-settings__tab" data-tab-content="advanced" hidden>
            <div class="nm-voice-settings__row nm-voice-settings__row--stack">
              <label class="nm-voice-settings__label">Vocabulario custom</label>
              <span class="nm-voice-settings__hint">Palabras que el dictado debe reconocer mejor</span>
              <textarea class="nm-voice-settings__textarea" data-setting="vocabulary" placeholder="Numination, Álvaro, Robinson, Coder..."></textarea>
            </div>
            <div class="nm-voice-settings__actions">
              <button class="nm-voice-settings__reset" data-action="reset" type="button">Restaurar valores</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);

    S.settingsPanel = {
      el: panel,
      voiceSelect: panel.querySelector('[data-setting="voice"]'),
      rateInput: panel.querySelector('[data-setting="rate"]'),
      pitchInput: panel.querySelector('[data-setting="pitch"]'),
      localeSelect: panel.querySelector('[data-setting="locale"]'),
      autospeakInput: panel.querySelector('[data-setting="autospeak"]'),
      duckingInput: panel.querySelector('[data-setting="ducking"]'),
      autoPunctuateInput: panel.querySelector('[data-setting="autoPunctuate"]'),
      vocabTextarea: panel.querySelector('[data-setting="vocabulary"]'),
      favoriteBtn: panel.querySelector('[data-action="favorite"]'),
      rateValue: panel.querySelector('[data-value="rate"]'),
      pitchValue: panel.querySelector('[data-value="pitch"]'),
    };

    // Eventos
    panel.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return hideSettings();

      const tab = e.target.closest('[data-tab]');
      if (tab) return switchSettingsTab(tab.dataset.tab);

      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action === 'test') {
        speak('Hola, soy Numi. Estoy lista para ayudarte.');
      } else if (action === 'reset') {
        resetSettings();
      } else if (action === 'favorite') {
        toggleFavoriteCurrent();
      }
    });

    S.settingsPanel.autospeakInput.addEventListener('change', (e) => {
      toggleAutoSpeak(e.target.checked);
    });

    S.settingsPanel.duckingInput.addEventListener('change', (e) => {
      S.duckingEnabled = e.target.checked;
      storeSet(CFG.keys.ducking, S.duckingEnabled ? '1' : '0');
    });

    S.settingsPanel.autoPunctuateInput.addEventListener('change', (e) => {
      CFG.autoPunctuate = e.target.checked;
    });

    S.settingsPanel.voiceSelect.addEventListener('change', (e) => {
      const uri = e.target.value;
      const voice = S.voices.find(v => v.voiceURI === uri);
      if (voice) {
        S.selectedVoice = voice;
        storeSet(CFG.keys.voiceURI, uri);
        rememberVoice(voice);
        updateFavoriteBtn();
        toast('ok', 'Voz: ' + voice.name);
      }
    });

    const debounceStore = debounce(() => {
      storeSet(CFG.keys.rate, S.rate);
      storeSet(CFG.keys.pitch, S.pitch);
    }, 200);

    S.settingsPanel.rateInput.addEventListener('input', (e) => {
      S.rate = parseFloat(e.target.value);
      S.settingsPanel.rateValue.textContent = S.rate.toFixed(1) + 'x';
      debounceStore();
    });

    S.settingsPanel.pitchInput.addEventListener('input', (e) => {
      S.pitch = parseFloat(e.target.value);
      S.settingsPanel.pitchValue.textContent = S.pitch.toFixed(1);
      debounceStore();
    });

    S.settingsPanel.localeSelect.addEventListener('change', (e) => {
      S.locale = e.target.value;
      storeSet(CFG.keys.locale, S.locale);
      if (S.recognition) S.recognition.lang = S.locale;
      pickVoice();
      updateSettingsUI();
    });

    S.settingsPanel.vocabTextarea.addEventListener('input', debounce((e) => {
      S.vocabulary = e.target.value.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
      storeSetJSON(CFG.keys.vocabulary, S.vocabulary);
    }, 300));

    return S.settingsPanel;
  }

  function switchSettingsTab(tabName) {
    const panel = S.settingsPanel.el;
    $$('[data-tab]', panel).forEach(t => {
      t.classList.toggle('is-active', t.dataset.tab === tabName);
    });
    $$('[data-tab-content]', panel).forEach(c => {
      c.hidden = c.dataset.tabContent !== tabName;
    });
  }

  function updateFavoriteBtn() {
    if (!S.settingsPanel) return;
    const voice = S.selectedVoice;
    const isFav = voice && S.favorites.has(voice.voiceURI);
    S.settingsPanel.favoriteBtn.classList.toggle('is-active', !!isFav);
    S.settingsPanel.favoriteBtn.textContent = isFav ? '★' : '☆';
  }

  function toggleFavoriteCurrent() {
    if (!S.selectedVoice) return;
    const uri = S.selectedVoice.voiceURI;
    if (S.favorites.has(uri)) {
      S.favorites.delete(uri);
      toast('info', 'Voz quitada de favoritas');
    } else {
      S.favorites.add(uri);
      toast('ok', 'Voz marcada como favorita');
    }
    storeSetJSON(CFG.keys.favorites, Array.from(S.favorites));
    updateFavoriteBtn();
    updateSettingsUI();
    emit('nm:voice:favorites:change', { favorites: Array.from(S.favorites) });
  }

  function updateSettingsUI() {
    if (!S.settingsPanel) return;
    const p = S.settingsPanel;

    p.autospeakInput.checked = S.autoSpeak;
    p.duckingInput.checked = S.duckingEnabled;
    p.autoPunctuateInput.checked = CFG.autoPunctuate;

    // Voces
    const sorted = getSortedVoices();
    const currentURI = S.selectedVoice ? S.selectedVoice.voiceURI : '';
    p.voiceSelect.innerHTML = sorted.map(v => {
      const selected = v.voiceURI === currentURI ? 'selected' : '';
      const fav = S.favorites.has(v.voiceURI) ? '★ ' : '';
      const label = fav + v.name + ' · ' + v.lang;
      return '<option value="' + escAttr(v.voiceURI) + '" ' + selected + '>' + escHtml(label) + '</option>';
    }).join('');

    p.rateInput.value = S.rate;
    p.rateValue.textContent = S.rate.toFixed(1) + 'x';
    p.pitchInput.value = S.pitch;
    p.pitchValue.textContent = S.pitch.toFixed(1);
    p.localeSelect.value = S.locale;
    p.vocabTextarea.value = S.vocabulary.join(', ');

    updateFavoriteBtn();
  }

  function resetSettings() {
    S.autoSpeak = false;
    S.rate = CFG.rate;
    S.pitch = CFG.pitch;
    S.locale = CFG.locale;
    S.selectedVoice = null;
    S.favorites.clear();
    S.vocabulary = [];
    S.duckingEnabled = true;

    storeSet(CFG.keys.autoSpeak, '0');
    storeSet(CFG.keys.rate, S.rate);
    storeSet(CFG.keys.pitch, S.pitch);
    storeSet(CFG.keys.locale, S.locale);
    storeSet(CFG.keys.voiceURI, '');
    storeSetJSON(CFG.keys.favorites, []);
    storeSetJSON(CFG.keys.vocabulary, []);

    pickVoice();
    updateSettingsUI();
    toast('ok', 'Valores restaurados');
  }

  function showSettings() {
    const panel = ensureSettingsPanel();
    updateSettingsUI();
    panel.el.hidden = false;
    void panel.el.offsetHeight;
    panel.el.classList.add('is-visible');
  }

  function hideSettings() {
    if (!S.settingsPanel) return;
    S.settingsPanel.el.classList.remove('is-visible');
    setTimeout(() => {
      if (S.settingsPanel) S.settingsPanel.el.hidden = true;
    }, 200);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     23 · SHORTCUTS MODAL
     ═══════════════════════════════════════════════════════════════════════ */

  function openShortcuts() {
    if (S.shortcutsModal) return;

    const el = document.createElement('div');
    el.className = 'nm-voice-shortcuts';
    el.innerHTML = `
      <div class="nm-voice-shortcuts__backdrop" data-close></div>
      <div class="nm-voice-shortcuts__panel">
        <h3>Atajos de voz</h3>
        <div class="nm-voice-shortcuts__list">
          <div class="nm-voice-shortcuts__row"><kbd>Ctrl</kbd><kbd>M</kbd><span>Activar/desactivar micrófono</span></div>
          <div class="nm-voice-shortcuts__row"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>S</kbd><span>Alternar auto-lectura</span></div>
          <div class="nm-voice-shortcuts__row"><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>R</kbd><span>Re-leer última respuesta</span></div>
          <div class="nm-voice-shortcuts__row"><kbd>Esc</kbd><span>Detener grabación / habla</span></div>
          <div class="nm-voice-shortcuts__row"><kbd>Espacio</kbd><span>Pausar/reanudar habla</span></div>
          <div class="nm-voice-shortcuts__row"><kbd>←</kbd><kbd>→</kbd><span>Anterior/siguiente oración</span></div>
        </div>
        <button class="nm-voice-shortcuts__close" data-close>Cerrar</button>
      </div>
    `;
    document.body.appendChild(el);
    S.shortcutsModal = el;
    requestAnimationFrame(() => el.classList.add('is-visible'));

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) closeShortcuts();
    });
  }

  function closeShortcuts() {
    if (!S.shortcutsModal) return;
    S.shortcutsModal.remove();
    S.shortcutsModal = null;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     24 · FAVORITE PHRASES
     ═══════════════════════════════════════════════════════════════════════ */

  function addFavoritePhrase(label, text) {
    S.favoritePhrases.push({ id: uid('phrase'), label, text });
    storeSetJSON(CFG.keys.phrases, S.favoritePhrases);
    toast('ok', 'Frase guardada: ' + label);
  }

  function getFavoritePhrases() {
    return S.favoritePhrases.slice();
  }

  function removeFavoritePhrase(id) {
    S.favoritePhrases = S.favoritePhrases.filter(p => p.id !== id);
    storeSetJSON(CFG.keys.phrases, S.favoritePhrases);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     25 · DOWNLOAD TTS AS AUDIO
     ═══════════════════════════════════════════════════════════════════════ */

  function downloadLastAsAudio() {
    if (!S.lastAudioBlob) {
      toast('warn', 'No hay audio reciente para descargar');
      return;
    }
    const url = URL.createObjectURL(S.lastAudioBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'numi-' + Date.now() + '.webm';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast('ok', 'Audio descargado');
  }

  /* ═══════════════════════════════════════════════════════════════════════
     26 · STATUS ARIA-LIVE
     ═══════════════════════════════════════════════════════════════════════ */

  let _statusEl = null;
  function updateStatus(state) {
    if (!_statusEl) {
      _statusEl = document.createElement('div');
      _statusEl.setAttribute('aria-live', 'polite');
      _statusEl.setAttribute('aria-atomic', 'true');
      _statusEl.className = 'nm-voice-sr-only';
      document.body.appendChild(_statusEl);
    }
    const labels = {
      idle: 'Listo',
      listening: 'Escuchando',
      speaking: 'Hablando',
      paused: 'Pausado',
    };
    _statusEl.textContent = labels[state] || '';
  }

  /* ═══════════════════════════════════════════════════════════════════════
     27 · KEYBOARD SHORTCUTS
     ═══════════════════════════════════════════════════════════════════════ */

  function handleKeydown(e) {
    const isCtrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    const tag = (e.target.tagName || '').toLowerCase();
    const isInField = tag === 'textarea' || tag === 'input' || e.target.isContentEditable;

    // Ctrl+M · toggle mic
    if (isCtrl && key === 'm' && !e.shiftKey) {
      e.preventDefault();
      toggleListening();
      return;
    }

    // Ctrl+Shift+S · auto-speak
    if (isCtrl && e.shiftKey && key === 's') {
      e.preventDefault();
      toggleAutoSpeak();
      return;
    }

    // Ctrl+Shift+R · re-leer
    if (isCtrl && e.shiftKey && key === 'r') {
      e.preventDefault();
      speakLastResponse();
      return;
    }

    // Ctrl+/ · atajos
    if (isCtrl && (key === '/' || key === '?')) {
      e.preventDefault();
      if (S.shortcutsModal) closeShortcuts();
      else openShortcuts();
      return;
    }

    // Escape · cancelar
    if (e.key === 'Escape') {
      if (S.shortcutsModal) return closeShortcuts();
      if (S.settingsPanel && !S.settingsPanel.el.hidden) return hideSettings();
      if (S.readingModeEl) return closeReadingMode();
      if (S.listening) {
        e.preventDefault();
        S.interimText = '';
        stopListening(true);
        return;
      }
      if (S.speaking) {
        e.preventDefault();
        stopSpeaking();
        return;
      }
    }

    // Espacio · pausa TTS (si no está escribiendo)
    if (e.key === ' ' && S.speaking && !isInField) {
      e.preventDefault();
      if (S.paused) resumeSpeaking();
      else pauseSpeaking();
      return;
    }

    // ← → · skip chunks
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && S.speaking && !isInField) {
      e.preventDefault();
      if (e.key === 'ArrowLeft') skipBack();
      else skipForward();
      return;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     28 · GLOBAL TOPBAR BUTTON
     ═══════════════════════════════════════════════════════════════════════ */

  function injectGlobalButtons() {
    // Buscar topbar
    const topbar = $('.topbar__actions') || $('.topbar');
    if (!topbar) return;
    if ($('[data-voice-settings]')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'topbar__icon nm-voice-topbar-btn';
    btn.setAttribute('data-voice-settings', '');
    btn.setAttribute('aria-label', 'Configuración de voz');
    btn.title = 'Configuración de voz';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
      </svg>
    `;
    btn.addEventListener('click', showSettings);
    topbar.appendChild(btn);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     29 · THREAD OBSERVER
     ═══════════════════════════════════════════════════════════════════════ */

  function startThreadObserver() {
    const thread = $('[data-thread]');
    if (!thread) {
      setTimeout(startThreadObserver, 500);
      return;
    }

    S.thread = thread;
    scanThreadForSpeakers();

    const obs = new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList && node.classList.contains('message')) {
            injectSpeakerIntoMessage(node);
          }
          if (node.querySelectorAll) {
            node.querySelectorAll('.message').forEach(injectSpeakerIntoMessage);
          }
        }
      }
    });
    obs.observe(thread, { childList: true, subtree: true });

    LOG.debug('thread observer attached');
  }

  /* ═══════════════════════════════════════════════════════════════════════
     30 · CSS
     ═══════════════════════════════════════════════════════════════════════ */

  function injectCSS() {
    if ($('#nm-voice-css')) return;
    const style = document.createElement('style');
    style.id = 'nm-voice-css';
    style.textContent = `
      .nm-voice-sr-only {
        position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
        overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0;
      }

      /* ─── MIC button listening state ─── */
      .composer__mic.is-listening {
        color: var(--c-danger, #dc2626);
        background: var(--c-danger-soft, #fee2e2);
        animation: nmVoiceMicPulse 1.4s ease-in-out infinite;
      }
      @keyframes nmVoiceMicPulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, .4); }
        50% { box-shadow: 0 0 0 8px rgba(220, 38, 38, 0); }
      }

      /* ─── Overlay grabación ─── */
      .nm-voice-overlay {
        position: fixed; inset: 0; z-index: 9997;
        opacity: 0; transition: opacity .2s; pointer-events: none;
      }
      .nm-voice-overlay[hidden] { display: none; }
      .nm-voice-overlay.is-visible { opacity: 1; pointer-events: auto; }
      .nm-voice-overlay__backdrop {
        position: absolute; inset: 0;
        background: rgba(0, 0, 0, .55);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
      }
      .nm-voice-overlay__panel {
        position: absolute;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        width: min(440px, calc(100vw - 32px));
        background: var(--c-bg, #fff);
        border-radius: 24px;
        padding: 24px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, .35);
        animation: nmVoiceOverlayIn .3s cubic-bezier(.16, 1, .3, 1);
      }
      @keyframes nmVoiceOverlayIn {
        from { opacity: 0; transform: translate(-50%, -48%) scale(.96); }
        to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
      }
      .nm-voice-overlay__head {
        display: flex; align-items: center; gap: 12px; margin-bottom: 20px;
      }
      .nm-voice-overlay__pulse {
        width: 12px; height: 12px; border-radius: 50%;
        background: var(--c-danger, #dc2626);
        animation: nmVoicePulseDot 1.2s ease-in-out infinite;
      }
      @keyframes nmVoicePulseDot {
        0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, .5); }
        50% { box-shadow: 0 0 0 6px rgba(220, 38, 38, 0); }
      }
      .nm-voice-overlay__label {
        flex: 1; font-size: 15px; font-weight: 700;
        letter-spacing: -.015em;
        color: var(--c-text, #0a0a0c);
      }
      .nm-voice-overlay__close {
        width: 34px; height: 34px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        background: transparent; border: none; cursor: pointer;
        color: var(--c-text-muted, #6b6b70);
        transition: all .15s;
      }
      .nm-voice-overlay__close:hover { background: var(--c-bg-hover, #f2f2f4); color: var(--c-text, #0a0a0c); }
      .nm-voice-overlay__close svg { width: 18px; height: 18px; }

      .nm-voice-overlay__waveform {
        display: flex; align-items: center; justify-content: center;
        gap: 3px;
        height: 64px;
        margin-bottom: 16px;
        padding: 8px;
        background: var(--c-bg-soft, #f7f7f8);
        border-radius: 14px;
        overflow: hidden;
      }
      .nm-voice-overlay__waveform span {
        display: block;
        width: 4px; height: 40px;
        background: var(--c-primary, #7c5eff);
        border-radius: 2px;
        transform: scaleY(0.15);
        transform-origin: center;
        transition: transform .06s linear;
      }

      .nm-voice-overlay__text {
        font-size: 14px; line-height: 1.5;
        color: var(--c-text, #0a0a0c);
        min-height: 44px;
        padding: 12px 14px;
        background: var(--c-bg-soft, #f7f7f8);
        border-radius: 12px;
        margin-bottom: 16px;
        word-break: break-word;
      }
      .nm-voice-overlay__text.is-empty {
        color: var(--c-text-subtle, #a0a0a5);
        font-style: italic;
      }

      .nm-voice-overlay__foot {
        display: flex; align-items: center; gap: 12px; justify-content: space-between;
      }
      .nm-voice-overlay__timer {
        font-family: var(--font-mono, monospace);
        font-size: 13px;
        color: var(--c-text-muted, #6b6b70);
        font-variant-numeric: tabular-nums;
      }
      .nm-voice-overlay__btn {
        display: inline-flex; align-items: center; gap: 8px;
        padding: 10px 20px;
        border-radius: 999px;
        background: var(--c-danger, #dc2626);
        color: #fff;
        border: none; cursor: pointer;
        font-size: 14px; font-weight: 600;
        font-family: inherit;
        transition: all .15s;
      }
      .nm-voice-overlay__btn:hover { opacity: .9; transform: translateY(-1px); }
      .nm-voice-overlay__btn svg { width: 14px; height: 14px; }

      /* ─── Speaker por mensaje ─── */
      .nm-voice-actions {
        display: flex; gap: 4px; margin-top: 8px;
      }
      .nm-voice-speaker {
        display: inline-flex; align-items: center; justify-content: center;
        width: 32px; height: 32px;
        border-radius: 8px;
        background: transparent; border: none;
        color: var(--c-text-muted, #6b6b70);
        cursor: pointer;
        transition: all .15s;
      }
      .nm-voice-speaker:hover {
        background: var(--c-bg-hover, #f2f2f4);
        color: var(--c-primary, #7c5eff);
      }
      .nm-voice-speaker svg { width: 16px; height: 16px; }
      .nm-voice-speaker__icon--stop { display: none; }
      .nm-voice-speaker.is-speaking { color: var(--c-primary, #7c5eff); background: var(--c-primary-soft, #f2ecff); }
      .nm-voice-speaker.is-speaking .nm-voice-speaker__icon--play { display: none; }
      .nm-voice-speaker.is-speaking .nm-voice-speaker__icon--stop { display: block; }

      /* ─── Floating player ─── */
      .nm-voice-player {
        position: fixed; top: 76px; right: 20px;
        z-index: 9995;
        display: flex; align-items: center; gap: 10px;
        padding: 8px 12px;
        background: var(--c-bg, #fff);
        border: 1px solid var(--c-border, #e8e8ea);
        border-radius: 999px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, .15);
        opacity: 0;
        transform: translateY(-8px);
        transition: opacity .2s, transform .2s;
        max-width: calc(100vw - 40px);
      }
      .nm-voice-player[hidden] { display: none; }
      .nm-voice-player.is-visible { opacity: 1; transform: translateY(0); }
      .nm-voice-player__icon {
        width: 24px; height: 24px; flex-shrink: 0;
        color: var(--c-primary, #7c5eff);
      }
      .nm-voice-player__icon svg { width: 100%; height: 100%; }
      .nm-voice-player__progress {
        flex: 1; min-width: 80px; max-width: 200px;
        height: 4px;
        background: var(--c-bg-hover, #f2f2f4);
        border-radius: 2px;
        cursor: pointer;
        overflow: hidden;
      }
      .nm-voice-player__bar {
        height: 100%;
        background: var(--c-primary, #7c5eff);
        border-radius: 2px;
        transition: width .2s linear;
      }
      .nm-voice-player__controls {
        display: flex; gap: 2px; flex-shrink: 0;
      }
      .nm-voice-player__btn {
        width: 30px; height: 30px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 50%;
        background: transparent; border: none;
        color: var(--c-text-2, #3a3a40);
        cursor: pointer;
        transition: all .15s;
      }
      .nm-voice-player__btn:hover { background: var(--c-bg-hover, #f2f2f4); color: var(--c-primary, #7c5eff); }
      .nm-voice-player__btn svg { width: 14px; height: 14px; }
      .nm-voice-player__time {
        font-size: 11.5px;
        color: var(--c-text-muted, #6b6b70);
        font-variant-numeric: tabular-nums;
        font-family: var(--font-mono, monospace);
        flex-shrink: 0;
      }

      /* ─── Settings panel ─── */
      .nm-voice-settings {
        position: fixed; inset: 0; z-index: 9996;
        opacity: 0;
        transition: opacity .2s;
        pointer-events: none;
      }
      .nm-voice-settings[hidden] { display: none; }
      .nm-voice-settings.is-visible { opacity: 1; pointer-events: auto; }
      .nm-voice-settings__backdrop {
        position: absolute; inset: 0;
        background: rgba(0, 0, 0, .5);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
      }
      .nm-voice-settings__panel {
        position: absolute;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        width: min(520px, calc(100vw - 32px));
        max-height: min(720px, calc(100vh - 40px));
        background: var(--c-bg, #fff);
        border-radius: 24px;
        overflow: hidden;
        display: flex; flex-direction: column;
        box-shadow: 0 24px 80px rgba(0, 0, 0, .35);
        animation: nmVoiceOverlayIn .3s cubic-bezier(.16, 1, .3, 1);
      }
      .nm-voice-settings__head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 20px 24px 12px;
        flex-shrink: 0;
      }
      .nm-voice-settings__head h3 {
        font-size: 18px; font-weight: 700;
        letter-spacing: -.02em;
        color: var(--c-text, #0a0a0c);
        margin: 0;
      }
      .nm-voice-settings__close {
        width: 34px; height: 34px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        background: transparent; border: none; cursor: pointer;
        color: var(--c-text-muted, #6b6b70);
      }
      .nm-voice-settings__close:hover { background: var(--c-bg-hover, #f2f2f4); }
      .nm-voice-settings__close svg { width: 18px; height: 18px; }

      .nm-voice-settings__tabs {
        display: flex; gap: 4px;
        padding: 0 24px;
        border-bottom: 1px solid var(--c-border-soft, #f0f0f2);
        flex-shrink: 0;
      }
      .nm-voice-settings__tabs button {
        padding: 10px 14px;
        background: transparent; border: none;
        font-size: 13.5px; font-weight: 500;
        color: var(--c-text-muted, #6b6b70);
        cursor: pointer;
        position: relative;
        font-family: inherit;
        transition: color .15s;
      }
      .nm-voice-settings__tabs button:hover { color: var(--c-text, #0a0a0c); }
      .nm-voice-settings__tabs button.is-active {
        color: var(--c-primary, #7c5eff);
        font-weight: 600;
      }
      .nm-voice-settings__tabs button.is-active::after {
        content: ''; position: absolute;
        bottom: -1px; left: 8px; right: 8px; height: 2px;
        background: var(--c-primary, #7c5eff);
        border-radius: 2px 2px 0 0;
      }

      .nm-voice-settings__body {
        flex: 1; min-height: 0;
        overflow-y: auto;
        padding: 16px 24px 24px;
      }
      .nm-voice-settings__tab { display: flex; flex-direction: column; gap: 16px; }
      .nm-voice-settings__row {
        display: flex; align-items: center; gap: 16px;
        justify-content: space-between;
      }
      .nm-voice-settings__row--stack {
        flex-direction: column;
        align-items: stretch;
        gap: 10px;
      }
      .nm-voice-settings__label {
        flex: 1;
        font-size: 14px; font-weight: 500;
        color: var(--c-text, #0a0a0c);
        display: flex; flex-direction: column; gap: 2px;
      }
      .nm-voice-settings__hint {
        font-size: 12px;
        color: var(--c-text-muted, #6b6b70);
        font-weight: 400;
      }
      .nm-voice-settings__value {
        display: inline-block;
        margin-left: 8px;
        font-family: var(--font-mono, monospace);
        color: var(--c-primary, #7c5eff);
        font-weight: 600;
        font-size: 12.5px;
      }
      .nm-voice-settings__select,
      .nm-voice-settings__textarea {
        width: 100%;
        padding: 10px 14px;
        border-radius: 10px;
        border: 1px solid var(--c-border, #e8e8ea);
        background: var(--c-bg-soft, #f7f7f8);
        font-family: inherit;
        font-size: 13.5px;
        color: var(--c-text, #0a0a0c);
        outline: none;
      }
      .nm-voice-settings__select:focus,
      .nm-voice-settings__textarea:focus {
        border-color: var(--c-primary, #7c5eff);
        box-shadow: 0 0 0 3px var(--c-primary-glow, rgba(124, 94, 255, .22));
      }
      .nm-voice-settings__textarea {
        min-height: 80px; resize: vertical;
        font-family: inherit;
      }
      .nm-voice-settings__voice-picker {
        display: flex; gap: 8px;
      }
      .nm-voice-settings__voice-picker select { flex: 1; }
      .nm-voice-settings__star {
        width: 42px;
        border-radius: 10px;
        border: 1px solid var(--c-border, #e8e8ea);
        background: var(--c-bg-soft, #f7f7f8);
        color: var(--c-text-subtle, #a0a0a5);
        font-size: 18px; cursor: pointer;
        transition: all .15s;
      }
      .nm-voice-settings__star:hover { background: var(--c-bg-hover, #f2f2f4); color: var(--c-warn, #f59e0b); }
      .nm-voice-settings__star.is-active { color: var(--c-warn, #f59e0b); }
      .nm-voice-settings__range {
        width: 100%;
        accent-color: var(--c-primary, #7c5eff);
      }
      .nm-voice-settings__actions {
        display: flex; gap: 10px; justify-content: flex-end;
        margin-top: 8px;
      }
      .nm-voice-settings__test,
      .nm-voice-settings__reset {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 10px 18px;
        border-radius: 999px;
        border: none; cursor: pointer;
        font-size: 13.5px; font-weight: 600;
        font-family: inherit;
        transition: all .15s;
      }
      .nm-voice-settings__test {
        background: var(--c-primary, #7c5eff);
        color: #fff;
        box-shadow: 0 4px 14px var(--c-primary-glow, rgba(124, 94, 255, .22));
      }
      .nm-voice-settings__test:hover { transform: translateY(-1px); }
      .nm-voice-settings__test svg { width: 14px; height: 14px; }
      .nm-voice-settings__reset {
        background: transparent;
        color: var(--c-text-muted, #6b6b70);
      }
      .nm-voice-settings__reset:hover { background: var(--c-bg-hover, #f2f2f4); }

      /* Toggle */
      .nm-voice-toggle {
        position: relative;
        display: inline-block;
        flex-shrink: 0;
      }
      .nm-voice-toggle input {
        position: absolute; opacity: 0; pointer-events: none;
      }
      .nm-voice-toggle__track {
        display: block;
        width: 46px; height: 26px;
        background: var(--c-border-strong, #d8d8dc);
        border-radius: 13px;
        transition: background .2s;
        position: relative;
        cursor: pointer;
      }
      .nm-voice-toggle__thumb {
        position: absolute;
        top: 3px; left: 3px;
        width: 20px; height: 20px;
        background: #fff;
        border-radius: 50%;
        box-shadow: 0 1px 3px rgba(0, 0, 0, .2);
        transition: transform .2s;
      }
      .nm-voice-toggle input:checked + .nm-voice-toggle__track {
        background: var(--c-primary, #7c5eff);
      }
      .nm-voice-toggle input:checked + .nm-voice-toggle__track .nm-voice-toggle__thumb {
        transform: translateX(20px);
      }

      /* ─── Reading mode ─── */
      .nm-reading-mode {
        position: fixed; inset: 0; z-index: 9998;
        background: var(--c-bg, #fff);
        display: flex; flex-direction: column;
        opacity: 0;
        transition: opacity .2s;
      }
      .nm-reading-mode.is-visible { opacity: 1; }
      .nm-reading-mode__head {
        display: flex; align-items: center; gap: 16px;
        padding: 16px 24px;
        border-bottom: 1px solid var(--c-border-soft, #f0f0f2);
        flex-shrink: 0;
      }
      .nm-reading-mode__close {
        width: 36px; height: 36px;
        border-radius: 50%;
        background: transparent; border: none;
        cursor: pointer;
        color: var(--c-text-muted, #6b6b70);
        font-size: 18px;
      }
      .nm-reading-mode__close:hover { background: var(--c-bg-hover, #f2f2f4); }
      .nm-reading-mode__title {
        flex: 1;
        font-size: 15px; font-weight: 700;
        letter-spacing: -.015em;
        color: var(--c-text, #0a0a0c);
      }
      .nm-reading-mode__controls {
        display: flex; align-items: center; gap: 8px;
        font-size: 13px;
        color: var(--c-text-muted, #6b6b70);
      }
      .nm-reading-mode__controls button {
        width: 28px; height: 28px;
        border-radius: 50%;
        background: var(--c-bg-soft, #f7f7f8);
        border: none; cursor: pointer;
        color: inherit; font-size: 16px;
      }
      .nm-reading-mode__rate {
        font-family: var(--font-mono, monospace);
        font-variant-numeric: tabular-nums;
        min-width: 40px; text-align: center;
      }
      .nm-reading-mode__body {
        flex: 1; min-height: 0;
        overflow-y: auto;
        padding: 40px 24px;
      }
      .nm-reading-mode__text {
        max-width: 720px;
        margin: 0 auto;
        font-size: 20px;
        line-height: 1.7;
        letter-spacing: -.005em;
        color: var(--c-text, #0a0a0c);
        white-space: pre-wrap;
      }
      .nm-reading-mode__foot {
        padding: 20px;
        text-align: center;
        border-top: 1px solid var(--c-border-soft, #f0f0f2);
        flex-shrink: 0;
      }
      .nm-reading-mode__play {
        width: 56px; height: 56px;
        border-radius: 50%;
        background: var(--c-primary, #7c5eff);
        color: #fff;
        border: none;
        font-size: 20px;
        cursor: pointer;
        box-shadow: 0 6px 20px var(--c-primary-glow, rgba(124, 94, 255, .22));
        transition: transform .15s;
      }
      .nm-reading-mode__play:hover { transform: scale(1.06); }

      /* ─── Shortcuts modal ─── */
      .nm-voice-shortcuts {
        position: fixed; inset: 0; z-index: 9999;
        display: flex; align-items: center; justify-content: center;
        opacity: 0; transition: opacity .2s;
      }
      .nm-voice-shortcuts.is-visible { opacity: 1; }
      .nm-voice-shortcuts__backdrop {
        position: absolute; inset: 0;
        background: rgba(0, 0, 0, .5);
        backdrop-filter: blur(6px);
      }
      .nm-voice-shortcuts__panel {
        position: relative;
        width: min(480px, calc(100vw - 32px));
        background: var(--c-bg, #fff);
        border-radius: 20px;
        padding: 24px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, .35);
      }
      .nm-voice-shortcuts__panel h3 {
        font-size: 17px; font-weight: 700;
        margin: 0 0 16px;
        letter-spacing: -.02em;
      }
      .nm-voice-shortcuts__list {
        display: flex; flex-direction: column; gap: 10px;
      }
      .nm-voice-shortcuts__row {
        display: flex; align-items: center; gap: 8px;
        font-size: 13.5px;
        color: var(--c-text-2, #3a3a40);
      }
      .nm-voice-shortcuts__row kbd {
        display: inline-block;
        padding: 3px 8px;
        background: var(--c-bg-soft, #f7f7f8);
        border: 1px solid var(--c-border, #e8e8ea);
        border-bottom-width: 2px;
        border-radius: 6px;
        font-family: var(--font-mono, monospace);
        font-size: 11px; font-weight: 600;
        color: var(--c-text-muted, #6b6b70);
      }
      .nm-voice-shortcuts__row span {
        margin-left: auto;
        color: var(--c-text-muted, #6b6b70);
      }
      .nm-voice-shortcuts__close {
        width: 100%;
        margin-top: 20px;
        padding: 12px;
        border-radius: 12px;
        background: var(--c-primary, #7c5eff);
        color: #fff;
        border: none; cursor: pointer;
        font-family: inherit;
        font-size: 14px; font-weight: 600;
      }

      @media (max-width: 640px) {
        .nm-voice-player { top: auto; bottom: 90px; right: 12px; left: 12px; }
        .nm-voice-settings__panel,
        .nm-reading-mode__text { font-size: 17px; }
      }
    `;
    document.head.appendChild(style);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     31 · PREFS · cargar/guardar
     ═══════════════════════════════════════════════════════════════════════ */

  function loadPrefs() {
    S.autoSpeak = storeGet(CFG.keys.autoSpeak, '0') === '1';
    S.rate = parseFloat(storeGet(CFG.keys.rate, String(CFG.rate))) || CFG.rate;
    S.pitch = parseFloat(storeGet(CFG.keys.pitch, String(CFG.pitch))) || CFG.pitch;
    S.locale = storeGet(CFG.keys.locale, CFG.locale);
    S.duckingEnabled = storeGet(CFG.keys.ducking, '1') === '1';

    try {
      const favs = JSON.parse(storeGet(CFG.keys.favorites, '[]'));
      if (Array.isArray(favs)) S.favorites = new Set(favs);
    } catch (e) {}

    try {
      const recent = JSON.parse(storeGet(CFG.keys.recent, '[]'));
      if (Array.isArray(recent)) S.recentVoices = recent;
    } catch (e) {}

    try {
      const phrases = JSON.parse(storeGet(CFG.keys.phrases, '[]'));
      if (Array.isArray(phrases)) S.favoritePhrases = phrases;
    } catch (e) {}

    try {
      const vocab = JSON.parse(storeGet(CFG.keys.vocabulary, '[]'));
      if (Array.isArray(vocab)) S.vocabulary = vocab;
    } catch (e) {}
  }

  /* ═══════════════════════════════════════════════════════════════════════
     32 · VISIBILITY HANDLER
     ═══════════════════════════════════════════════════════════════════════ */

  function handleVisibilityChange() {
    if (document.hidden) {
      if (S.speaking && !S.paused) {
        pauseSpeaking();
      }
      if (S.listening) {
        stopListening(true);
      }
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     33 · CHAT INTEGRATION (response-complete)
     ═══════════════════════════════════════════════════════════════════════ */

  function hookChatResponseComplete() {
    window.addEventListener('nm:chat:response-complete', (e) => {
      const { text, element } = e.detail || {};
      if (S.autoSpeak && text) {
        speak(text, { element });
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     34 · SELF TEST
     ═══════════════════════════════════════════════════════════════════════ */

  async function selfTest() {
    const results = [];
    const rec = (name, ok, detail) => results.push({ name, ok, detail });

    // Chunker
    const c1 = chunkText('Hola mundo');
    rec('chunk texto corto → 1 chunk', c1.length === 1, c1.length);

    const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(10);
    const c2 = chunkText(long);
    rec('chunk texto largo → múltiples', c2.length > 1, c2.length);

    // Clean
    const clean = cleanTextForSpeech('**Hola** `código` [link](url)');
    rec('clean elimina markdown', clean === 'Hola código link', clean);

    // Locale split
    rec('locale es-CO → base es', 'es-CO'.split('-')[0] === 'es', 'ok');

    // Feature detection
    rec('HAS_TTS detectado', typeof HAS_TTS === 'boolean', HAS_TTS);
    rec('HAS_STT detectado', typeof HAS_STT === 'boolean', HAS_STT);

    // Estado
    rec('S inicializado', typeof S === 'object', true);
    rec('S.speaking boolean', typeof S.speaking === 'boolean', S.speaking);

    // Favorites Set
    rec('S.favorites es Set', S.favorites instanceof Set, true);

    // Utils
    rec('fmtTime(0) → 00:00', fmtTime(0) === '00:00', fmtTime(0));
    rec('fmtTime(60000) → 01:00', fmtTime(60000) === '01:00', fmtTime(60000));

    const passed = results.filter(r => r.ok).length;
    return {
      passed, total: results.length,
      ok: passed === results.length,
      results,
      feature: { HAS_TTS, HAS_STT, HAS_AUDIO_CTX, HAS_BROADCAST, HAS_MEDIA_RECORDER },
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════
     35 · INIT
     ═══════════════════════════════════════════════════════════════════════ */

  async function init() {
    if (S.initialized) return;
    S.initialized = true;

    injectCSS();
    loadPrefs();

    // Cargar voces con retry
    if (HAS_TTS) {
      loadVoicesWithRetry(5000).then(voices => {
        LOG.info('voces cargadas:', voices.length);
      });

      // Listener de cambios de voces
      try {
        window.speechSynthesis.onvoiceschanged = () => {
          loadVoices();
          if (S.settingsPanel) updateSettingsUI();
        };
      } catch (e) {}
    }

    // UI
    setTimeout(() => {
      wireMicButton();
      injectGlobalButtons();
      startThreadObserver();
    }, 300);

    // Keyboard
    document.addEventListener('keydown', handleKeydown);

    // Visibility
    document.addEventListener('visibilitychange', handleVisibilityChange);

    // Multi-tab
    initMultiTab();

    // Chat integration
    hookChatResponseComplete();

    // Status
    updateStatus('idle');

    // Ready
    S.ready = true;
    emit('nm:voice:ready', {
      hasSTT: HAS_STT,
      hasTTS: HAS_TTS,
      hasServer: S.hasServerTTS,
    });

    LOG.info('initialized · STT=' + HAS_STT + ' TTS=' + HAS_TTS + ' v2.0.0');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     36 · API PÚBLICA
     ═══════════════════════════════════════════════════════════════════════ */

  window.NM_voice = {
    // STT
    startListening,
    stopListening,
    toggleListening,
    isListening: () => S.listening,

    // TTS
    speak,
    stopSpeaking,
    pauseSpeaking,
    resumeSpeaking,
    skipForward,
    skipBack,
    seekTo,
    isSpeaking: () => S.speaking,
    isPaused: () => S.paused,
    speakLastResponse,

    // Auto-speak
    toggleAutoSpeak,

    // UI
    openSettings: showSettings,
    closeSettings: hideSettings,
    openShortcuts,
    closeShortcuts,
    openReadingMode,
    closeReadingMode,

    // Voces
    getVoices: () => S.voices.slice(),
    getSortedVoices,
    setVoice: (uri) => {
      const v = S.voices.find(x => x.voiceURI === uri);
      if (v) {
        S.selectedVoice = v;
        storeSet(CFG.keys.voiceURI, uri);
        rememberVoice(v);
        return true;
      }
      return false;
    },

    // Favoritos
    getFavorites: () => Array.from(S.favorites),
    toggleFavorite: (uri) => {
      if (S.favorites.has(uri)) S.favorites.delete(uri);
      else S.favorites.add(uri);
      storeSetJSON(CFG.keys.favorites, Array.from(S.favorites));
      emit('nm:voice:favorites:change', { favorites: Array.from(S.favorites) });
      return S.favorites.has(uri);
    },

    // Config
    setRate: (r) => { S.rate = Math.max(0.5, Math.min(2, parseFloat(r))); storeSet(CFG.keys.rate, S.rate); },
    setPitch: (p) => { S.pitch = Math.max(0.5, Math.min(1.5, parseFloat(p))); storeSet(CFG.keys.pitch, S.pitch); },
    setLocale: (l) => { S.locale = l; storeSet(CFG.keys.locale, l); if (S.recognition) S.recognition.lang = l; pickVoice(); },
    configure: (patch) => {
      if (!patch) return;
      Object.keys(patch).forEach(k => { CFG[k] = patch[k]; });
    },

    // Frases favoritas
    addFavoritePhrase,
    getFavoritePhrases,
    removeFavoritePhrase,

    // Audio
    downloadLastAsAudio,

    // Voice memo
    startVoiceMemo,
    stopVoiceMemo,

    // Debug
    test: selfTest,

    // Estado interno (para debugging)
    _state: S,
    _config: CFG,
    _version: '2.0.0',
    _hasSTT: HAS_STT,
    _hasTTS: HAS_TTS,
  };

  LOG.info('module loaded · v2.0.0');
})();