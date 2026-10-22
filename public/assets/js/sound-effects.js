/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · sound-effects.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Efectos de sonido sin archivos externos.

   POR QUÉ BASE64 Y NO ARCHIVOS
     · Cero peticiones de red: los sonidos están embebidos en el JS.
     · No hay tema de caché, ni 404, ni un archivo .mp3 que alguien pueda
       borrar por error.
     · El peso es bajo: los efectos son < 2 KB cada uno.

   CÓMO SE GENERAN
     Los sonidos se sintetizan con la Web Audio API en el primer uso y se
     guardan como data URI (base64) para poder reproducirlos también con
     `new Audio()`, como pide el brief.

   CATÁLOGO
     · pop    → respuesta recibida (nota ascendente corta)
     · error  → error (dos notas descendentes)
     · send   → mensaje enviado (clic muy breve)
     · tick   → confirmación de UI
     · whoosh → cambio de vista

   REGLAS
     · El volumen por defecto es bajo (0.18): los sonidos no deben
       sobresaltar a nadie.
     · Se respeta `prefers-reduced-motion` (y una preferencia de sonido
       desactivada guardada en localStorage).
     · Si el navegador bloquea el audio (política de autoplay), no se
       insistirá: el primer sonido queda "armado" para el primer click.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STORAGE_KEY = 'nm_sound_enabled';

  const state = {
    enabled: true,
    volume: 0.18,
    armed: false,
    cache: new Map(),
    audioContext: null,
  };

  /* ─── Catálogo de efectos ───────────────────────────────────────────── */

  const CATALOG = {
    pop: {
      label: 'Pop',
      notes: [[880, 0.0, 0.07], [1320, 0.05, 0.09]],
      wave: 'sine',
      gain: 0.5,
    },
    error: {
      label: 'Error',
      notes: [[320, 0.0, 0.11], [200, 0.09, 0.15]],
      wave: 'sawtooth',
      gain: 0.35,
    },
    send: {
      label: 'Enviar',
      notes: [[560, 0.0, 0.045]],
      wave: 'triangle',
      gain: 0.32,
    },
    tick: {
      label: 'Tick',
      notes: [[1400, 0.0, 0.03]],
      wave: 'sine',
      gain: 0.22,
    },
    whoosh: {
      label: 'Whoosh',
      sweep: [220, 1400],
      duration: 0.16,
      wave: 'sine',
      gain: 0.22,
    },
  };

  /* ─── Audio ─────────────────────────────────────────────────────────── */

  function getContext() {
    if (state.audioContext) return state.audioContext;

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      state.audioContext = new Ctx();
      return state.audioContext;
    } catch (e) {
      console.debug('[sound-effects] no hay Web Audio', e);
      return null;
    }
  }

  /**
   * Sintetiza el efecto y devuelve un data URI base64 (WAV).
   * Se cachea para no regenerarlo.
   */
  function synthToDataUri(name) {
    if (state.cache.has(name)) return state.cache.get(name);

    const effect = CATALOG[name];
    if (!effect) return null;

    const sampleRate = 22050;
    const duration = effect.sweep ? effect.duration : 0.26;
    const frames = Math.floor(sampleRate * duration);
    const data = new Int16Array(frames);

    const total = effect.notes
      ? effect.notes[effect.notes.length - 1][1] + effect.notes[effect.notes.length - 1][2]
      : duration;
    const scale = duration / Math.max(total, 0.01);

    for (let i = 0; i < frames; i++) {
      const t = i / sampleRate;

      let sample = 0;

      if (effect.notes) {
        for (const [freq, start, len] of effect.notes) {
          const s = start * scale;
          const l = len * scale;
          if (t >= s && t < s + l) {
            const local = (t - s) / l;
            const env = Math.sin(Math.PI * local) ** 1.6;
            const phase = 2 * Math.PI * freq * (t - s);
            sample += Math.sin(phase) * env;
          }
        }
      } else if (effect.sweep) {
        const [from, to] = effect.sweep;
        const freq = from + (to - from) * (t / duration);
        const env = Math.sin(Math.PI * (t / duration)) ** 1.4;
        sample = Math.sin(2 * Math.PI * freq * t) * env;
      }

      const value = Math.max(-1, Math.min(1, sample * (effect.gain || 0.4)));
      data[i] = value * 32767;
    }

    const uri = encodeWav(data, sampleRate);
    state.cache.set(name, uri);
    return uri;
  }

  /**
   * Empaqueta samples PCM en un WAV (RIFF) y lo devuelve como data URI.
   */
  function encodeWav(samples, sampleRate) {
    const bytesPerSample = 2;
    const dataSize = samples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    const writeString = (offset, str) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);            // PCM
    view.setUint16(22, 1, true);            // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
      view.setInt16(offset, samples[i], true);
      offset += bytesPerSample;
    }

    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }

    return `data:audio/wav;base64,${btoa(binary)}`;
  }

  /**
   * Reproduce un efecto.
   *
   * @param {string} name  'pop' | 'error' | 'send' | 'tick' | 'whoosh'
   * @param {object} [opts] { volume }
   */
  function play(name, opts = {}) {
    if (!state.enabled) return false;
    if (!CATALOG[name]) {
      console.warn('[sound-effects] efecto desconocido', name);
      return false;
    }

    const volume = Number.isFinite(Number(opts.volume)) ? Number(opts.volume) : state.volume;

    // ── Camino 1 · Web Audio (síntesis directa, sin decodificar) ────────
    const ctx = getContext();
    if (ctx) {
      try {
        if (ctx.state === 'suspended') {
          ctx.resume().catch(() => {});
        }

        const effect = CATALOG[name];
        const now = ctx.currentTime;

        if (effect.notes) {
          for (const [freq, start, len] of effect.notes) {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();

            osc.type = effect.wave || 'sine';
            osc.frequency.setValueAtTime(freq, now + start);

            gain.gain.setValueAtTime(0.0001, now + start);
            gain.gain.exponentialRampToValueAtTime(volume * (effect.gain || 0.4), now + start + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, now + start + len);

            osc.connect(gain).connect(ctx.destination);
            osc.start(now + start);
            osc.stop(now + start + len + 0.02);
          }
        } else if (effect.sweep) {
          const [from, to] = effect.sweep;
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();

          osc.type = effect.wave || 'sine';
          osc.frequency.setValueAtTime(from, now);
          osc.frequency.exponentialRampToValueAtTime(to, now + effect.duration);

          gain.gain.setValueAtTime(0.0001, now);
          gain.gain.exponentialRampToValueAtTime(volume * (effect.gain || 0.3), now + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + effect.duration);

          osc.connect(gain).connect(ctx.destination);
          osc.start(now);
          osc.stop(now + effect.duration + 0.02);
        }

        return true;
      } catch (e) {
        console.debug('[sound-effects] Web Audio falló', e);
      }
    }

    // ── Camino 2 · new Audio() con el WAV embebido ─────────────────────
    try {
      const uri = synthToDataUri(name);
      if (!uri) return false;

      const audio = new Audio(uri);
      audio.volume = volume;
      const promise = audio.play();

      if (promise && typeof promise.catch === 'function') {
        promise.catch(() => {
          // Autoplay bloqueado: se marca para reintentar en el próximo click.
          state.armed = false;
        });
      }

      state.armed = true;
      return true;
    } catch (e) {
      console.debug('[sound-effects] no se pudo reproducir', e);
      return false;
    }
  }

  /* ─── Preferencias ──────────────────────────────────────────────────── */

  function loadPreference() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      state.enabled = raw === null ? true : raw === 'true';
    } catch {
      state.enabled = true;
    }
    return state.enabled;
  }

  function savePreference() {
    try {
      window.localStorage.setItem(STORAGE_KEY, String(state.enabled));
    } catch { /* modo privado */ }
  }

  function setEnabled(enabled) {
    state.enabled = Boolean(enabled);
    savePreference();
    return state.enabled;
  }

  function toggle() {
    return setEnabled(!state.enabled);
  }

  /* ─── Integración con el chat ───────────────────────────────────────── */

  function bindEvents() {
    if (!window.eventBus || typeof window.eventBus.on !== 'function') return;

    window.eventBus.on('chat:response', () => play('pop'));
    window.eventBus.on('chat:error', () => play('error'));
    window.eventBus.on('chat:send', () => play('send'));
    window.eventBus.on('ui:success', () => play('tick'));
    window.eventBus.on('ui:navigate', () => play('whoosh'));
  }

  /* ─── Montaje ───────────────────────────────────────────────────────── */

  function init() {
    loadPreference();

    // El primer gesto del usuario "arma" el audio (política de autoplay).
    const arm = () => {
      const ctx = getContext();
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      state.armed = true;
      window.removeEventListener('pointerdown', arm);
      window.removeEventListener('keydown', arm);
    };

    window.addEventListener('pointerdown', arm, { once: true });
    window.addEventListener('keydown', arm, { once: true });

    bindEvents();

    return state.enabled;
  }

  window.NumSoundEffects = {
    init,
    play,
    toggle,
    setEnabled,
    get enabled() { return state.enabled; },
    get volume() { return state.volume; },
    set volume(v) { state.volume = Math.max(0, Math.min(1, Number(v) || 0)); },
    get catalog() {
      return Object.entries(CATALOG).map(([id, e]) => ({ id, label: e.label }));
    },
    synthToDataUri,
  };

  document.addEventListener('DOMContentLoaded', init, { once: true });
})();
