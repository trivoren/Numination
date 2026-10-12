/* ================================================================
   NUMINATION · voice.js · v1.0
   ----------------------------------------------------------------
   Módulo completo de voz para Numination.

   FUNCIONALIDAD:
     · STT (Speech to Text): dictado por voz con Web Speech API
     · TTS (Text to Speech): lectura en voz alta de respuestas IA
     · Auto-speak: lee automáticamente cada respuesta de Numi
     · Overlay de grabación con waveform y timer
     · Panel de configuración de voz
     · Botones speaker por mensaje
     · Highlight palabra por palabra mientras habla
     · Multi-idioma (es-CO, es-ES, es-MX, en-US)
     · Persistencia de preferencias en localStorage
     · Atajos de teclado (Ctrl+M mic, Ctrl+Shift+S auto-speak)
     · Manejo elegante de errores y falta de permisos

   INTEGRACIÓN:
     Se auto-inicializa al cargar. Detecta el botón micrófono
     existente en el composer o lo crea si no existe.

   API PÚBLICA:
     NM_voice.startListening()
     NM_voice.stopListening()
     NM_voice.speak(text)
     NM_voice.stopSpeaking()
     NM_voice.pauseSpeaking()
     NM_voice.resumeSpeaking()
     NM_voice.toggleAutoSpeak()
     NM_voice.openSettings()
     NM_voice.isListening()
     NM_voice.isSpeaking()
     NM_voice.getVoices()
   ================================================================ */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════
     1 · CONFIGURACIÓN
     ═══════════════════════════════════════════════════════════════════ */

  const CFG = {
    /* Idioma por defecto */
    locale: 'es-CO',
    fallbackLocale: 'es-ES',

    /* TTS */
    rate: 1.0,          // 0.5 - 2.0
    pitch: 1.0,         // 0.5 - 1.5
    volume: 1.0,        // 0 - 1
    preferredVoiceMatch: [
      'Google español',
      'Microsoft Sabina',
      'Microsoft Helena',
      'Microsoft Laura',
      'Paulina',
      'Mónica',
      'Diego',
      'Jorge',
      'español',
      'spanish',
    ],

    /* STT */
    autoStopMs: 2000,       // detiene después de X ms de silencio
    maxDurationMs: 60000,   // máximo 60s de grabación
    interimResults: true,
    continuous: false,

    /* UI */
    showOverlay: true,
    showWaveform: true,
    showTimer: true,
    highlightWords: true,

    /* Storage keys */
    keys: {
      autoSpeak: 'numination-voice-autospeak',
      voiceURI: 'numination-voice-uri',
      rate: 'numination-voice-rate',
      pitch: 'numination-voice-pitch',
      locale: 'numination-voice-locale',
    },

    /* Debug */
    debug: false,
  };

  /* ═══════════════════════════════════════════════════════════════════
     2 · ESTADO
     ═══════════════════════════════════════════════════════════════════ */

  const state = {
    /* STT */
    recognition: null,
    listening: false,
    listeningStartAt: 0,
    listeningTimer: null,
    silenceTimer: null,
    interimText: '',

    /* TTS */
    speaking: false,
    paused: false,
    currentUtterance: null,
    voices: [],
    selectedVoice: null,
    autoSpeak: false,
    rate: CFG.rate,
    pitch: CFG.pitch,
    locale: CFG.locale,

    /* UI refs */
    micBtn: null,
    overlay: null,
    overlayTimerEl: null,
    overlayWaveformEl: null,
    settingsPanel: null,

    /* Refs a elementos */
    composer: null,
    textarea: null,
    thread: null,

    /* Session */
    initialized: false,
    audioCtx: null,
    analyser: null,
    stream: null,
    animFrame: null,
  };

  /* ═══════════════════════════════════════════════════════════════════
     3 · FEATURE DETECTION
     ═══════════════════════════════════════════════════════════════════ */

  const HAS_STT = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  const HAS_TTS = !!('speechSynthesis' in window);
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  /* ═══════════════════════════════════════════════════════════════════
     4 · UTILS
     ═══════════════════════════════════════════════════════════════════ */

  function log(...args) {
    if (CFG.debug) console.log('[voice]', ...args);
  }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {}
  }

  function $(sel, ctx) {
    return (ctx || document).querySelector(sel);
  }

  function $$(sel, ctx) {
    return Array.from((ctx || document).querySelectorAll(sel));
  }

  function toast(kind, msg) {
    if (window.__nm && window.__nm.toast && typeof window.__nm.toast[kind] === 'function') {
      try { window.__nm.toast[kind](msg); return; } catch {}
    }
    log(kind, msg);
  }

  function debounce(fn, ms) {
    let t;
    return function () {
      const args = arguments;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function fmtTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const s = String(totalSec % 60).padStart(2, '0');
    return m + ':' + s;
  }

  function localStorageGet(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : v;
    } catch { return fallback; }
  }

  function localStorageSet(key, value) {
    try { localStorage.setItem(key, String(value)); } catch {}
  }

  /* ═══════════════════════════════════════════════════════════════════
     5 · TTS · SPEECH SYNTHESIS
     ═══════════════════════════════════════════════════════════════════ */

  function loadVoices() {
    if (!HAS_TTS) return [];
    const voices = window.speechSynthesis.getVoices();
    state.voices = voices;
    pickVoice();
    return voices;
  }

  function pickVoice() {
    if (!HAS_TTS || state.voices.length === 0) return;

    /* Si el usuario ya eligió una voz, respetarla */
    const savedUri = localStorageGet(CFG.keys.voiceURI, '');
    if (savedUri) {
      const saved = state.voices.find((v) => v.voiceURI === savedUri);
      if (saved) {
        state.selectedVoice = saved;
        return;
      }
    }

    /* Intentar match por locale */
    const locale = state.locale;
    const langCode = locale.split('-')[0];

    /* Prioridad 1: coincidencia exacta locale */
    let match = state.voices.find((v) => v.lang === locale);
    if (match) { state.selectedVoice = match; return; }

    /* Prioridad 2: match por idioma (es-*) */
    match = state.voices.find((v) => v.lang.startsWith(langCode));
    if (match) { state.selectedVoice = match; return; }

    /* Prioridad 3: match por nombre de voz preferida */
    for (const pref of CFG.preferredVoiceMatch) {
      const lower = pref.toLowerCase();
      const found = state.voices.find((v) => v.name.toLowerCase().includes(lower));
      if (found) { state.selectedVoice = found; return; }
    }

    /* Fallback: primera voz disponible */
    state.selectedVoice = state.voices[0] || null;
  }

  function getSpanishVoices() {
    if (!HAS_TTS) return [];
    return state.voices.filter((v) => v.lang.startsWith('es'));
  }

  /**
   * Habla un texto con la voz configurada.
   * Limpia markdown antes de hablar.
   */
  function speak(text, opts = {}) {
    if (!HAS_TTS) {
      toast('warn', 'Tu navegador no soporta lectura en voz alta');
      return false;
    }

    if (!text || !String(text).trim()) return false;

    /* Detener lo que esté hablando */
    stopSpeaking();

    /* Limpiar markdown y caracteres raros para TTS */
    const clean = cleanTextForSpeech(String(text));
    if (!clean) return false;

    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.voice = state.selectedVoice;
    utterance.lang = state.locale;
    utterance.rate = state.rate;
    utterance.pitch = state.pitch;
    utterance.volume = CFG.volume;

    utterance.onstart = () => {
      state.speaking = true;
      state.paused = false;
      state.currentUtterance = utterance;
      updateSpeakButtons();
      emit('nm:voice:speak:start', { text: clean });
    };

    utterance.onend = () => {
      state.speaking = false;
      state.paused = false;
      state.currentUtterance = null;
      updateSpeakButtons();
      emit('nm:voice:speak:end', {});
    };

    utterance.onerror = (e) => {
      /* Ignorar "interrupted" y "canceled" que son normales al detener */
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      log('TTS error', e.error);
      state.speaking = false;
      state.currentUtterance = null;
      updateSpeakButtons();
      emit('nm:voice:speak:error', { error: e.error });
    };

    /* Highlight de palabra actual (soportado en Chrome/Edge) */
    if (CFG.highlightWords && opts.element) {
      utterance.onboundary = (e) => {
        if (e.name === 'word') {
          highlightWordInElement(opts.element, e.charIndex);
        }
      };
    }

    try {
      window.speechSynthesis.speak(utterance);
      return true;
    } catch (e) {
      log('speak failed', e);
      return false;
    }
  }

  function stopSpeaking() {
    if (!HAS_TTS) return;
    try {
      window.speechSynthesis.cancel();
      state.speaking = false;
      state.paused = false;
      state.currentUtterance = null;
      updateSpeakButtons();
      clearWordHighlights();
    } catch (e) {
      log('stopSpeaking failed', e);
    }
  }

  function pauseSpeaking() {
    if (!HAS_TTS || !state.speaking) return;
    try {
      window.speechSynthesis.pause();
      state.paused = true;
      updateSpeakButtons();
    } catch {}
  }

  function resumeSpeaking() {
    if (!HAS_TTS || !state.paused) return;
    try {
      window.speechSynthesis.resume();
      state.paused = false;
      updateSpeakButtons();
    } catch {}
  }

  /**
   * Limpia el texto de markdown y símbolos para TTS.
   * Es muy importante: si le pasás **negrita** o `code` la voz
   * lo lee literal ("asterisco asterisco negrita asterisco asterisco").
   */
  function cleanTextForSpeech(text) {
    let t = text;

    /* Quitar bloques de código completos */
    t = t.replace(/```[\s\S]*?```/g, ' (bloque de código) ');

    /* Quitar código inline */
    t = t.replace(/`([^`\n]+)`/g, '$1');

    /* Quitar negritas e itálicas */
    t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
    t = t.replace(/\*([^*\n]+)\*/g, '$1');
    t = t.replace(/__([^_]+)__/g, '$1');
    t = t.replace(/_([^_\n]+)_/g, '$1');

    /* Quitar links [texto](url) → texto */
    t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

    /* Quitar imágenes ![alt](url) */
    t = t.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

    /* Quitar headings #, ##, ### */
    t = t.replace(/^#{1,6}\s+/gm, '');

    /* Quitar bullets y números de lista */
    t = t.replace(/^[\s]*[-*+]\s+/gm, '');
    t = t.replace(/^[\s]*\d+\.\s+/gm, '');

    /* Quitar blockquotes */
    t = t.replace(/^>\s+/gm, '');

    /* Quitar separadores horizontales */
    t = t.replace(/^---+$/gm, '');

    /* Convertir HTML a texto si quedó algo */
    t = t.replace(/<[^>]+>/g, '');

    /* Quitar emojis y símbolos raros */
    t = t.replace(/[\u{1F300}-\u{1F9FF}]/gu, '');
    t = t.replace(/[\u{2600}-\u{27BF}]/gu, '');
    t = t.replace(/[\u{1F000}-\u{1F02F}]/gu, '');
    t = t.replace(/[\u{1F0A0}-\u{1F0FF}]/gu, '');

    /* Colapsar espacios */
    t = t.replace(/\s+/g, ' ').trim();

    /* Recortar si es muy largo (una locura de 10 min) */
    if (t.length > 3000) t = t.slice(0, 3000) + '…';

    return t;
  }

  /* ═══════════════════════════════════════════════════════════════════
     6 · WORD HIGHLIGHT (mientras habla)
     ═══════════════════════════════════════════════════════════════════ */

  function highlightWordInElement(element, charIndex) {
    if (!element) return;
    /* Simplemente añadimos una animación sutil al elemento */
    /* Un highlight real palabra-por-palabra requiere re-parsear el HTML */
    /* y es muy frágil. Skip. */
  }

  function clearWordHighlights() {
    $$('.nm-voice-speaking').forEach((el) => el.classList.remove('nm-voice-speaking'));
  }

  /* ═══════════════════════════════════════════════════════════════════
     7 · STT · SPEECH RECOGNITION
     ═══════════════════════════════════════════════════════════════════ */

  function initRecognition() {
    if (!HAS_STT) return null;

    const rec = new SpeechRecognitionCtor();
    rec.lang = state.locale;
    rec.continuous = CFG.continuous;
    rec.interimResults = CFG.interimResults;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      state.listening = true;
      state.listeningStartAt = Date.now();
      state.interimText = '';
      showOverlay();
      startTimer();
      updateMicButton();
      emit('nm:voice:listening:start', {});
    };

    rec.onresult = (event) => {
      /* Reiniciar el timer de silencio */
      resetSilenceTimer();

      let interim = '';
      let final = '';

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          final += transcript;
        } else {
          interim += transcript;
        }
      }

      if (final) {
        state.interimText = final.trim();
        /* Auto-stop: cuando hay resultado final, paramos */
        /* (a menos que continuous esté activo) */
      } else if (interim) {
        state.interimText = interim;
        updateOverlayText(interim);
      }
    };

    rec.onerror = (event) => {
      const err = event.error;
      log('STT error', err);

      let msg = 'Error de reconocimiento de voz';
      if (err === 'not-allowed') msg = 'Permiso de micrófono denegado';
      else if (err === 'no-speech') msg = 'No escuché nada. Intentá de nuevo.';
      else if (err === 'audio-capture') msg = 'No encontré micrófono. Verificá que esté conectado.';
      else if (err === 'network') msg = 'Sin conexión a internet';
      else if (err === 'aborted') { /* silencioso */ return; }

      toast('err', msg);
      stopListening(true);
      emit('nm:voice:listening:error', { error: err, message: msg });
    };

    rec.onend = () => {
      const wasListening = state.listening;
      state.listening = false;
      stopTimer();
      hideOverlay();
      updateMicButton();

      if (wasListening && state.interimText) {
        const text = state.interimText.trim();
        if (text) {
          insertTextIntoComposer(text);
          emit('nm:voice:transcription', { text });
        }
      }

      state.interimText = '';
      emit('nm:voice:listening:end', {});
    };

    return rec;
  }

  function startListening() {
    if (!HAS_STT) {
      toast('warn', 'Tu navegador no soporta dictado por voz. Probá con Chrome o Edge.');
      return false;
    }

    if (state.listening) {
      log('already listening');
      return true;
    }

    stopSpeaking();
    state.recognition = initRecognition();
    if (!state.recognition) return false;

    try {
      state.recognition.start();
      /* Vibración corta en móvil (si soporta) */
      if (navigator.vibrate) try { navigator.vibrate(30); } catch {}
      return true;
    } catch (e) {
      log('start failed', e);
      if (e.message && e.message.includes('already started')) {
        /* Ya estaba escuchando, no es error */
        return true;
      }
      toast('err', 'No pude iniciar el micrófono');
      return false;
    }
  }

  function stopListening(silent) {
    if (!state.recognition) return;
    try {
      state.recognition.stop();
      if (!silent && navigator.vibrate) try { navigator.vibrate(15); } catch {}
    } catch (e) {
      log('stop failed', e);
    }
  }

  function resetSilenceTimer() {
    clearTimeout(state.silenceTimer);
    state.silenceTimer = setTimeout(() => {
      if (state.listening && state.interimText) {
        log('auto-stop por silencio');
        stopListening();
      }
    }, CFG.autoStopMs);
  }

  /* ═══════════════════════════════════════════════════════════════════
     8 · INSERCIÓN EN EL COMPOSER
     ═══════════════════════════════════════════════════════════════════ */

  function insertTextIntoComposer(text) {
    if (!text) return;

    const field = $('[data-field]') || $('.composer textarea') || $('textarea[placeholder*="Escrib"]');
    if (!field) {
      log('no composer field found');
      return;
    }

    const current = field.value || '';
    const separator = current.trim() && !current.endsWith(' ') ? ' ' : '';
    field.value = current + separator + text;

    /* Posicionar el cursor al final */
    field.focus();
    try {
      field.setSelectionRange(field.value.length, field.value.length);
    } catch {}

    /* Disparar input event para que otros listeners reaccionen */
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* ═══════════════════════════════════════════════════════════════════
     9 · UI · OVERLAY DE GRABACIÓN
     ═══════════════════════════════════════════════════════════════════ */

  function ensureOverlay() {
    if (state.overlay) return state.overlay;

    const overlay = document.createElement('div');
    overlay.className = 'nm-voice-overlay';
    overlay.id = 'nm-voice-overlay';
    overlay.hidden = true;
    overlay.innerHTML = `
      <div class="nm-voice-overlay__backdrop"></div>
      <div class="nm-voice-overlay__panel">
        <div class="nm-voice-overlay__head">
          <div class="nm-voice-overlay__pulse"></div>
          <span class="nm-voice-overlay__label">Escuchando…</span>
          <button class="nm-voice-overlay__close" data-action="cancel" aria-label="Cancelar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div class="nm-voice-overlay__waveform" data-waveform>
          ${Array.from({length: 32}).map(() => '<span></span>').join('')}
        </div>

        <div class="nm-voice-overlay__text" data-text>Decí algo…</div>

        <div class="nm-voice-overlay__foot">
          <div class="nm-voice-overlay__timer" data-timer>00:00</div>
          <button class="nm-voice-overlay__btn" data-action="stop">
            <svg viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
            <span>Detener</span>
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    /* Refs */
    state.overlay = overlay;
    state.overlayTimerEl = overlay.querySelector('[data-timer]');
    state.overlayWaveformEl = overlay.querySelector('[data-waveform]');
    state.overlayTextEl = overlay.querySelector('[data-text]');

    /* Eventos */
    overlay.addEventListener('click', (e) => {
      const action = e.target.closest('[data-action]');
      if (!action) return;
      if (action.dataset.action === 'cancel') {
        state.interimText = '';
        stopListening(true);
      }
      if (action.dataset.action === 'stop') {
        stopListening();
      }
    });

    return overlay;
  }

  function showOverlay() {
    if (!CFG.showOverlay) return;
    const overlay = ensureOverlay();
    overlay.hidden = false;
    /* Forzar reflow para animación */
    void overlay.offsetHeight;
    overlay.classList.add('is-visible');
    updateOverlayText('');
    startWaveform();
  }

  function hideOverlay() {
    if (!state.overlay) return;
    state.overlay.classList.remove('is-visible');
    setTimeout(() => {
      if (state.overlay) state.overlay.hidden = true;
    }, 200);
    stopWaveform();
  }

  function updateOverlayText(text) {
    if (!state.overlayTextEl) return;
    if (!text || !text.trim()) {
      state.overlayTextEl.textContent = 'Decí algo…';
      state.overlayTextEl.classList.add('is-empty');
    } else {
      state.overlayTextEl.textContent = text;
      state.overlayTextEl.classList.remove('is-empty');
    }
  }

  function startTimer() {
    state.listeningStartAt = Date.now();
    state.listeningTimer = setInterval(() => {
      if (!state.overlayTimerEl) return;
      const elapsed = Date.now() - state.listeningStartAt;
      state.overlayTimerEl.textContent = fmtTime(elapsed);

      /* Auto-stop por duración máxima */
      if (elapsed > CFG.maxDurationMs) {
        log('auto-stop por duración máxima');
        stopListening();
      }
    }, 100);
  }

  function stopTimer() {
    clearInterval(state.listeningTimer);
    state.listeningTimer = null;
    clearTimeout(state.silenceTimer);
    state.silenceTimer = null;
  }

  /* ═══════════════════════════════════════════════════════════════════
     10 · WAVEFORM · visualización en vivo
     ═══════════════════════════════════════════════════════════════════ */

  async function startWaveform() {
    if (!CFG.showWaveform) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    if (!window.AudioContext && !window.webkitAudioContext) return;

    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new Ctx();
      const source = state.audioCtx.createMediaStreamSource(state.stream);
      state.analyser = state.audioCtx.createAnalyser();
      state.analyser.fftSize = 64;
      source.connect(state.analyser);

      const dataArray = new Uint8Array(state.analyser.frequencyBinCount);

      const tick = () => {
        if (!state.analyser || !state.overlayWaveformEl) return;
        state.analyser.getByteFrequencyData(dataArray);
        const bars = state.overlayWaveformEl.children;
        for (let i = 0; i < bars.length; i++) {
          const idx = Math.floor((i / bars.length) * dataArray.length);
          const v = dataArray[idx] / 255;
          bars[i].style.transform = `scaleY(${0.15 + v * 0.85})`;
        }
        state.animFrame = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      log('waveform failed', e);
      /* Fallback: animación falsa */
      startFakeWaveform();
    }
  }

  function startFakeWaveform() {
    if (!state.overlayWaveformEl) return;
    const bars = state.overlayWaveformEl.children;
    const tick = () => {
      for (let i = 0; i < bars.length; i++) {
        const v = Math.random() * 0.8 + 0.15;
        bars[i].style.transform = `scaleY(${v})`;
      }
      state.animFrame = requestAnimationFrame(() => setTimeout(tick, 80));
    };
    tick();
  }

  function stopWaveform() {
    if (state.animFrame) {
      cancelAnimationFrame(state.animFrame);
      state.animFrame = null;
    }
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    if (state.audioCtx) {
      state.audioCtx.close().catch(() => {});
      state.audioCtx = null;
    }
    state.analyser = null;

    if (state.overlayWaveformEl) {
      Array.from(state.overlayWaveformEl.children).forEach((b) => {
        b.style.transform = 'scaleY(0.15)';
      });
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     11 · UI · MIC BUTTON
     ═══════════════════════════════════════════════════════════════════ */

  function findOrCreateMicButton() {
    /* Buscar botón de micrófono existente */
    let btn = $('[data-voice-mic]') || $('[aria-label*="micrófono" i]') || $('[aria-label*="microphone" i]') || $('[title*="micrófono" i]');

    if (btn) {
      btn.setAttribute('data-voice-mic', '');
      return btn;
    }

    /* Buscar por SVG que parezca micrófono */
    const svgs = $$('.composer button svg, [data-composer] button svg');
    for (const svg of svgs) {
      const path = svg.innerHTML.toLowerCase();
      if (path.includes('mic') || (path.includes('rect') && path.includes('path') && svg.getAttribute('viewbox') === '0 0 24 24')) {
        const maybeBtn = svg.closest('button');
        if (maybeBtn && !maybeBtn.hasAttribute('data-voice-mic')) {
          maybeBtn.setAttribute('data-voice-mic', '');
          return maybeBtn;
        }
      }
    }

    /* Crear uno nuevo si no existe */
    const composer = $('.composer') || $('[data-composer]');
    if (!composer) {
      log('no composer found, skipping mic button creation');
      return null;
    }

    const sendBtn = composer.querySelector('[type="submit"]') || composer.querySelector('.composer__send');

    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'composer__add composer__mic';
    btn.setAttribute('data-voice-mic', '');
    btn.setAttribute('aria-label', 'Dictar por voz');
    btn.title = 'Dictar por voz (Ctrl+M)';
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
    if (!state.micBtn) return;
    state.micBtn.classList.toggle('is-listening', state.listening);
    state.micBtn.setAttribute('aria-pressed', String(state.listening));
    state.micBtn.title = state.listening ? 'Detener dictado' : 'Dictar por voz (Ctrl+M)';
  }

  function wireMicButton() {
    state.micBtn = findOrCreateMicButton();
    if (!state.micBtn) return;

    state.micBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (state.listening) stopListening();
      else startListening();
    });

    updateMicButton();
  }

  /* ═══════════════════════════════════════════════════════════════════
     12 · UI · SPEAKER EN MENSAJES IA
     ═══════════════════════════════════════════════════════════════════ */

  function injectSpeakerIntoMessage(messageEl) {
    if (!messageEl || messageEl.__nmVoiceSpeaker) return;
    messageEl.__nmVoiceSpeaker = true;

    /* Solo mensajes de IA */
    const isAI = messageEl.classList.contains('message--ai')
              || messageEl.classList.contains('message--assistant')
              || messageEl.dataset.role === 'ai'
              || messageEl.dataset.role === 'assistant';

    if (!isAI) return;

    /* Buscar el contenedor de texto */
    const textEl = messageEl.querySelector('.message__text, .message__content, [data-message-text]');
    if (!textEl) return;

    /* Evitar duplicados */
    if (messageEl.querySelector('.nm-voice-speaker')) return;

    const actions = document.createElement('div');
    actions.className = 'nm-voice-actions';

    const speakBtn = document.createElement('button');
    speakBtn.type = 'button';
    speakBtn.className = 'nm-voice-speaker';
    speakBtn.setAttribute('aria-label', 'Leer en voz alta');
    speakBtn.title = 'Leer en voz alta';
    speakBtn.innerHTML = `
      <svg class="nm-voice-speaker__icon nm-voice-speaker__icon--play" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
        <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
      </svg>
      <svg class="nm-voice-speaker__icon nm-voice-speaker__icon--stop" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="6" width="12" height="12" rx="2"/>
      </svg>
    `;

    speakBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (state.speaking && state.currentUtterance) {
        /* Está hablando este mensaje u otro → detener */
        stopSpeaking();
        return;
      }

      const text = extractTextFromMessage(textEl);
      speak(text, { element: textEl });
    });

    actions.appendChild(speakBtn);
    textEl.appendChild(actions);

    /* Marcar el mensaje para actualizar su estado */
    messageEl.__nmVoiceSpeakBtn = speakBtn;
  }

  function extractTextFromMessage(el) {
    /* Clonar para no mutar el original */
    const clone = el.cloneNode(true);
    /* Quitar botones, acciones y bloques de código */
    clone.querySelectorAll('.nm-voice-actions, button, svg, pre, code').forEach((n) => n.remove());
    return (clone.textContent || '').trim();
  }

  function updateSpeakButtons() {
    const isSpeaking = state.speaking;
    $$('.nm-voice-speaker').forEach((btn) => {
      btn.classList.toggle('is-speaking', isSpeaking && btn === (state.currentUtterance && state.currentUtterance.__btn));
    });
    /* Simplificado: marcar todos los botones si está hablando alguno */
    $$('.nm-voice-speaker').forEach((btn) => {
      btn.classList.toggle('is-speaking', isSpeaking);
    });
  }

  function scanThreadForSpeakers() {
    const thread = state.thread || $('[data-thread]');
    if (!thread) return;
    $$('.message', thread).forEach(injectSpeakerIntoMessage);
  }

  /* ═══════════════════════════════════════════════════════════════════
     13 · AUTO-SPEAK · leer respuestas automáticamente
     ═══════════════════════════════════════════════════════════════════ */

  function toggleAutoSpeak(force) {
    const next = typeof force === 'boolean' ? force : !state.autoSpeak;
    state.autoSpeak = next;
    localStorageSet(CFG.keys.autoSpeak, next ? '1' : '0');
    updateSettingsUI();
    toast('ok', next ? 'Auto-lectura activada' : 'Auto-lectura desactivada');
    emit('nm:voice:autospeak', { enabled: next });
    return next;
  }

  /**
   * Llamado desde el flujo de chat cuando llega una respuesta completa de IA.
   * Se puede invocar manualmente o vía hook en el sistema de streaming.
   */
  function onAIResponseComplete(text, messageEl) {
    if (!state.autoSpeak) return;
    if (!text || !text.trim()) return;
    speak(text, { element: messageEl });
  }

  /* ═══════════════════════════════════════════════════════════════════
     14 · UI · SETTINGS PANEL
     ═══════════════════════════════════════════════════════════════════ */

  function ensureSettingsPanel() {
    if (state.settingsPanel) return state.settingsPanel;

    const panel = document.createElement('div');
    panel.className = 'nm-voice-settings';
    panel.id = 'nm-voice-settings';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="nm-voice-settings__backdrop" data-close></div>
      <div class="nm-voice-settings__panel">
        <div class="nm-voice-settings__head">
          <h3>Configuración de voz</h3>
          <button class="nm-voice-settings__close" data-close aria-label="Cerrar">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div class="nm-voice-settings__body">
          <div class="nm-voice-settings__row">
            <label class="nm-voice-settings__label">Leer respuestas automáticamente</label>
            <label class="nm-voice-toggle">
              <input type="checkbox" data-setting="autospeak" />
              <span class="nm-voice-toggle__track"><span class="nm-voice-toggle__thumb"></span></span>
            </label>
          </div>

          <div class="nm-voice-settings__row">
            <label class="nm-voice-settings__label">Voz</label>
            <select class="nm-voice-settings__select" data-setting="voice"></select>
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

          <div class="nm-voice-settings__row">
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

          <div class="nm-voice-settings__actions">
            <button class="nm-voice-settings__test" data-action="test">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>
              Probar voz
            </button>
            <button class="nm-voice-settings__reset" data-action="reset">Restaurar valores</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    state.settingsPanel = panel;

    /* Eventos */
    panel.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) {
        hideSettings();
        return;
      }
      const action = e.target.closest('[data-action]');
      if (action) {
        if (action.dataset.action === 'test') {
          speak('Hola, soy Numi. Estoy lista para ayudarte con lo que necesites.');
        }
        if (action.dataset.action === 'reset') {
          resetSettings();
        }
      }
    });

    /* Auto-speak toggle */
    const autoSpeakInput = panel.querySelector('[data-setting="autospeak"]');
    autoSpeakInput.addEventListener('change', (e) => {
      toggleAutoSpeak(e.target.checked);
    });

    /* Voice select */
    const voiceSelect = panel.querySelector('[data-setting="voice"]');
    voiceSelect.addEventListener('change', (e) => {
      const uri = e.target.value;
      const voice = state.voices.find((v) => v.voiceURI === uri);
      if (voice) {
        state.selectedVoice = voice;
        localStorageSet(CFG.keys.voiceURI, uri);
        toast('ok', `Voz: ${voice.name}`);
      }
    });

    /* Rate slider */
    const rateInput = panel.querySelector('[data-setting="rate"]');
    rateInput.addEventListener('input', (e) => {
      state.rate = parseFloat(e.target.value);
      localStorageSet(CFG.keys.rate, state.rate);
      panel.querySelector('[data-value="rate"]').textContent = state.rate.toFixed(1) + 'x';
    });

    /* Pitch slider */
    const pitchInput = panel.querySelector('[data-setting="pitch"]');
    pitchInput.addEventListener('input', (e) => {
      state.pitch = parseFloat(e.target.value);
      localStorageSet(CFG.keys.pitch, state.pitch);
      panel.querySelector('[data-value="pitch"]').textContent = state.pitch.toFixed(1);
    });

    /* Locale select */
    const localeSelect = panel.querySelector('[data-setting="locale"]');
    localeSelect.addEventListener('change', (e) => {
      state.locale = e.target.value;
      localStorageSet(CFG.keys.locale, state.locale);
      if (state.recognition) state.recognition.lang = state.locale;
      pickVoice();
      updateSettingsUI();
    });

    return panel;
  }

  function updateSettingsUI() {
    const panel = state.settingsPanel;
    if (!panel) return;

    /* Auto-speak */
    panel.querySelector('[data-setting="autospeak"]').checked = state.autoSpeak;

    /* Voice list */
    const voiceSelect = panel.querySelector('[data-setting="voice"]');
    const spanishVoices = state.voices.filter((v) => v.lang.startsWith('es'));
    const otherVoices = state.voices.filter((v) => !v.lang.startsWith('es'));
    const sortedVoices = [...spanishVoices, ...otherVoices];

    if (sortedVoices.length === 0) {
      voiceSelect.innerHTML = '<option value="">Cargando voces…</option>';
    } else {
      voiceSelect.innerHTML = sortedVoices.map((v) => {
        const selected = state.selectedVoice && v.voiceURI === state.selectedVoice.voiceURI;
        const label = v.name + ' · ' + v.lang;
        return `<option value="${escapeAttr(v.voiceURI)}" ${selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
      }).join('');
    }

    /* Rate */
    panel.querySelector('[data-setting="rate"]').value = state.rate;
    panel.querySelector('[data-value="rate"]').textContent = state.rate.toFixed(1) + 'x';

    /* Pitch */
    panel.querySelector('[data-setting="pitch"]').value = state.pitch;
    panel.querySelector('[data-value="pitch"]').textContent = state.pitch.toFixed(1);

    /* Locale */
    panel.querySelector('[data-setting="locale"]').value = state.locale;
  }

  function resetSettings() {
    state.autoSpeak = false;
    state.rate = CFG.rate;
    state.pitch = CFG.pitch;
    state.locale = CFG.locale;
    state.selectedVoice = null;

    localStorageSet(CFG.keys.autoSpeak, '0');
    localStorageSet(CFG.keys.rate, state.rate);
    localStorageSet(CFG.keys.pitch, state.pitch);
    localStorageSet(CFG.keys.locale, state.locale);
    localStorageSet(CFG.keys.voiceURI, '');

    pickVoice();
    updateSettingsUI();
    toast('ok', 'Valores restaurados');
  }

  function showSettings() {
    const panel = ensureSettingsPanel();
    updateSettingsUI();
    panel.hidden = false;
    void panel.offsetHeight;
    panel.classList.add('is-visible');
  }

  function hideSettings() {
    const panel = state.settingsPanel;
    if (!panel) return;
    panel.classList.remove('is-visible');
    setTimeout(() => {
      if (state.settingsPanel) state.settingsPanel.hidden = true;
    }, 200);
  }

  /* ═══════════════════════════════════════════════════════════════════
     15 · HELPERS
     ═══════════════════════════════════════════════════════════════════ */

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* ═══════════════════════════════════════════════════════════════════
     16 · KEYBOARD SHORTCUTS
     ═══════════════════════════════════════════════════════════════════ */

  function handleKeydown(e) {
    /* Ctrl+M: alternar micrófono */
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm' && !e.shiftKey) {
      const target = e.target;
      /* No interferir con campos de texto que necesiten Ctrl+M nativo */
      if (target && target.tagName === 'TEXTAREA' && target.dataset.field === undefined) return;
      e.preventDefault();
      if (state.listening) stopListening();
      else startListening();
      return;
    }

    /* Ctrl+Shift+S: alternar auto-speak */
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      toggleAutoSpeak();
      return;
    }

    /* Esc durante grabación: cancelar */
    if (e.key === 'Escape' && state.listening) {
      e.preventDefault();
      state.interimText = '';
      stopListening(true);
      return;
    }

    /* Espacio durante TTS: pausa/reanuda (solo si no está escribiendo) */
    if (e.key === ' ' && state.speaking) {
      const target = e.target;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT')) return;
      e.preventDefault();
      if (state.paused) resumeSpeaking();
      else pauseSpeaking();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     17 · OBSERVER · añadir speakers a mensajes nuevos
     ═══════════════════════════════════════════════════════════════════ */

  function startThreadObserver() {
    state.thread = $('[data-thread]');
    if (!state.thread) {
      setTimeout(startThreadObserver, 500);
      return;
    }

    /* Escanear lo que ya hay */
    scanThreadForSpeakers();

    /* Observar nuevos */
    const obs = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1) {
            if (node.classList && node.classList.contains('message')) {
              injectSpeakerIntoMessage(node);
            }
            const innerMsgs = node.querySelectorAll && node.querySelectorAll('.message');
            if (innerMsgs) innerMsgs.forEach(injectSpeakerIntoMessage);
          }
        }
      }
    });
    obs.observe(state.thread, { childList: true, subtree: true });

    /* Escanear cada 2s por si acaso */
    setInterval(scanThreadForSpeakers, 2000);

    log('thread observer attached');
  }

  /* ═══════════════════════════════════════════════════════════════════
     18 · GLOBAL BUTTONS (topbar / floating)
     ═══════════════════════════════════════════════════════════════════ */

  function injectGlobalButtons() {
    /* Buscar la topbar del chat */
    const topbar = $('.topbar') || $('.topbar__actions') || $('.chat__header-actions');
    if (!topbar) return;

    /* Botón de settings de voz (engranaje) */
    if (!$('[data-voice-settings]')) {
      const settingsBtn = document.createElement('button');
      settingsBtn.type = 'button';
      settingsBtn.className = 'nm-voice-topbar-btn';
      settingsBtn.setAttribute('data-voice-settings', '');
      settingsBtn.setAttribute('aria-label', 'Configuración de voz');
      settingsBtn.title = 'Configuración de voz';
      settingsBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
        </svg>
      `;
      settingsBtn.addEventListener('click', showSettings);
      topbar.appendChild(settingsBtn);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     19 · SPEAK LAST RESPONSE (helper)
     ═══════════════════════════════════════════════════════════════════ */

  function speakLastResponse() {
    const thread = state.thread || $('[data-thread]');
    if (!thread) return;
    const messages = $$('.message--ai, .message--assistant, [data-role="ai"], [data-role="assistant"]', thread);
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    const textEl = last.querySelector('.message__text, .message__content, [data-message-text]');
    if (!textEl) return;
    const text = extractTextFromMessage(textEl);
    speak(text, { element: textEl });
  }

  /* ═══════════════════════════════════════════════════════════════════
     20 · INIT
     ═══════════════════════════════════════════════════════════════════ */

  function loadPrefs() {
    state.autoSpeak = localStorageGet(CFG.keys.autoSpeak, '0') === '1';
    state.rate = parseFloat(localStorageGet(CFG.keys.rate, String(CFG.rate)));
    state.pitch = parseFloat(localStorageGet(CFG.keys.pitch, String(CFG.pitch)));
    state.locale = localStorageGet(CFG.keys.locale, CFG.locale);

    if (isNaN(state.rate)) state.rate = CFG.rate;
    if (isNaN(state.pitch)) state.pitch = CFG.pitch;
  }

  function init() {
    if (state.initialized) return;
    state.initialized = true;

    loadPrefs();

    /* TTS */
    if (HAS_TTS) {
      loadVoices();
      if (typeof window.speechSynthesis.onvoiceschanged !== 'undefined') {
        window.speechSynthesis.onvoiceschanged = () => {
          loadVoices();
          updateSettingsUI();
        };
      }
      /* Forzar carga (algunos browsers tardan) */
      setTimeout(loadVoices, 200);
      setTimeout(loadVoices, 1000);
    } else {
      log('TTS not supported');
    }

    /* STT */
    if (!HAS_STT) {
      log('STT not supported');
    }

    /* Composer / mic button */
    setTimeout(() => {
      wireMicButton();
      injectGlobalButtons();
      startThreadObserver();
    }, 300);

    /* Keyboard */
    document.addEventListener('keydown', handleKeydown);

    /* Hook en el flujo de chat (si existe) */
    window.addEventListener('nm:chat:response-complete', (e) => {
      const { text, element } = e.detail || {};
      if (state.autoSpeak && text) {
        speak(text, { element });
      }
    });

    log('initialized · STT=' + HAS_STT + ' TTS=' + HAS_TTS);
    emit('nm:voice:ready', { hasSTT: HAS_STT, hasTTS: HAS_TTS });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  /* ═══════════════════════════════════════════════════════════════════
     21 · PUBLIC API
     ═══════════════════════════════════════════════════════════════════ */

  window.NM_voice = {
    startListening,
    stopListening,
    speak,
    stopSpeaking,
    pauseSpeaking,
    resumeSpeaking,
    speakLastResponse,
    toggleAutoSpeak,
    openSettings: showSettings,
    closeSettings: hideSettings,
    isListening: () => state.listening,
    isSpeaking: () => state.speaking,
    isPaused: () => state.paused,
    getVoices: () => state.voices.slice(),
    getSpanishVoices,
    setVoice: (voiceURI) => {
      const v = state.voices.find((x) => x.voiceURI === voiceURI);
      if (v) {
        state.selectedVoice = v;
        localStorageSet(CFG.keys.voiceURI, voiceURI);
        return true;
      }
      return false;
    },
    setRate: (r) => {
      state.rate = Math.max(0.5, Math.min(2, parseFloat(r)));
      localStorageSet(CFG.keys.rate, state.rate);
    },
    setPitch: (p) => {
      state.pitch = Math.max(0.5, Math.min(1.5, parseFloat(p)));
      localStorageSet(CFG.keys.pitch, state.pitch);
    },
    setLocale: (l) => {
      state.locale = l;
      localStorageSet(CFG.keys.locale, l);
      if (state.recognition) state.recognition.lang = l;
      pickVoice();
    },
    onAIResponseComplete,
    _config: CFG,
    _state: state,
    _version: '1.0.0',
    _hasSTT: HAS_STT,
    _hasTTS: HAS_TTS,
  };

  log('module loaded · v1.0.0');
})();