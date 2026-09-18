/* ============================================================
   Audio del chat
   - Dictado por voz (Web Speech Recognition) -> texto al input
   - Lectura en voz alta (Speech Synthesis) de respuestas IA
   ============================================================ */

const STORAGE_VOICE = 'numination_voice';

let recognition = null;
let listening = false;
let elMicBtn = null;
let elField = null;

export function initChatAudio() {
  elMicBtn = document.getElementById('mic-btn');
  elField  = document.querySelector('[data-chat-field]');

  if (!elMicBtn || !elField) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  if (!SpeechRecognition) {
    elMicBtn.style.display = 'none';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.lang = 'es-CO';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    listening = true;
    elMicBtn.classList.add('is-listening');
    elField.placeholder = 'Escuchando…';
  };

  recognition.onresult = (e) => {
    let finalTxt = '';
    let interimTxt = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalTxt += t;
      else interimTxt += t;
    }
    const base = elField.dataset.voiceBase || '';
    elField.value = base + finalTxt + interimTxt;
    elField.dispatchEvent(new Event('input', { bubbles: true }));
  };

  recognition.onend = () => {
    listening = false;
    elMicBtn.classList.remove('is-listening');
    elField.placeholder = 'Pregúntale algo a Numination…';
    delete elField.dataset.voiceBase;
  };

  recognition.onerror = (e) => {
    console.warn('[audio] error:', e.error);
    if (e.error === 'not-allowed') alert('Necesito permiso para usar el micrófono.');
    elMicBtn.classList.remove('is-listening');
    elField.placeholder = 'Pregúntale algo a Numination…';
    listening = false;
  };

  elMicBtn.addEventListener('click', toggleMic);
}

function toggleMic() {
  if (!recognition) return;

  if (listening) {
    recognition.stop();
    return;
  }

  elField.dataset.voiceBase = elField.value ? elField.value + ' ' : '';
  try { recognition.start(); } catch (err) { console.warn('[audio]', err); }
}

let voices = [];

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  voices = window.speechSynthesis.getVoices();
}

if ('speechSynthesis' in window) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

function pickVoice() {
  const saved = localStorage.getItem(STORAGE_VOICE);
  if (saved) {
    const v = voices.find(x => x.voiceURI === saved);
    if (v) return v;
  }
  return (
    voices.find(v => v.lang === 'es-CO') ||
    voices.find(v => v.lang === 'es-MX') ||
    voices.find(v => v.lang === 'es-US') ||
    voices.find(v => v.lang.startsWith('es')) ||
    voices[0] ||
    null
  );
}

function cleanForSpeech(text) {
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/#+\s/g, '')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/\[(.+?)\]\(.+?\)/g, '$1')
    .replace(/_{1,2}(.+?)_{1,2}/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const clean = cleanForSpeech(text);
  if (!clean) return;

  window.speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(clean);
  const v = pickVoice();
  if (v) { u.voice = v; u.lang = v.lang; }
  else   { u.lang = 'es-CO'; }
  u.rate = 1.0;
  u.pitch = 1.0;
  window.speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

export function attachSpeakButton(bubble, text) {
  if (!bubble || !('speechSynthesis' in window)) return;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'msg__speak';
  btn.setAttribute('aria-label', 'Leer en voz alta');
  btn.innerHTML = '<svg class="icon icon--sm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';

  let speaking = false;

  btn.addEventListener('click', () => {
    if (speaking) {
      stopSpeaking();
      speaking = false;
      btn.classList.remove('is-speaking');
      return;
    }
    speak(text);
    speaking = true;
    btn.classList.add('is-speaking');

    const cleanup = () => {
      speaking = false;
      btn.classList.remove('is-speaking');
      window.speechSynthesis.removeEventListener('end', cleanup);
    };
    window.speechSynthesis.addEventListener('end', cleanup);
  });

  bubble.appendChild(btn);
}