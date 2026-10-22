/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · language-detector.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Detección de idioma del navegador e inyección de la directiva de
   idioma en el system prompt.

   POR QUÉ
   Un usuario de Colombia que escribe "cuánto es 2+2" espera español,
   aunque el prompt base esté en inglés. El idioma del navegador es la
   señal más fiable y barata que tenemos SIN pedirle nada al usuario.

   REGLAS
     · `es*`  → "Responde en español."  (+ variante regional si existe)
     · `en*`  → "Respond in English."
     · otro   → se usa el idioma del último mensaje del usuario (si se
                 puede detectar) o se deja el prompt base intacto.

   INTEGRACIÓN
     · `window.NumLanguageDetector.getDirective()` → la frase.
     · `applyTo(payload)` → agrega `systemPrompt` al payload del chat.
     · Se suscribe a `window.eventBus` para reaccionar a `chat:send` y
       ajustar el payload antes de que salga.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const DIRECTIVES = Object.freeze({
    es: 'Responde siempre en español. Si el usuario escribe en otro idioma, respondé en español salvo que te lo pida explícitamente.',
    en: 'Always respond in English. If the user writes in another language, reply in English unless explicitly asked otherwise.',
  });

  const state = {
    lang: 'es',
    region: '',
    directive: DIRECTIVES.es,
    detected: false,
    lastUserLanguage: null,
  };

  /* ─── Detección ─────────────────────────────────────────────────────── */

  /**
   * Normaliza `navigator.languages` / `navigator.language`.
   * @returns {{lang:string, region:string, supported:boolean}}
   */
  function detect() {
    let raw = '';

    try {
      const list = Array.isArray(navigator.languages) && navigator.languages.length
        ? navigator.languages
        : [navigator.language];
      raw = list.find((l) => typeof l === 'string' && l.length) || '';
    } catch {
      raw = '';
    }

    const normalized = String(raw || 'es').replace('_', '-');
    const [langPart, regionPart] = normalized.split('-');
    const lang = String(langPart || 'es').toLowerCase();

    return {
      lang,
      region: String(regionPart || '').toLowerCase(),
      supported: Object.prototype.hasOwnProperty.call(DIRECTIVES, lang),
    };
  }

  /**
   * Heurística barata para detectar el idioma del último mensaje.
   * Usa palabras funcionales: es 100% local y no necesita ninguna API.
   */
  function detectMessageLanguage(text) {
    const s = String(text || '').toLowerCase();
    if (!s.trim()) return null;

    const es = [
      ' el ', ' la ', ' los ', ' las ', ' de ', ' que ', ' y ', ' para ',
      ' con ', ' cómo ', ' qué ', ' por ', ' una ', ' como ', ' más ',
      'ñ', '¿', '¡',
    ];
    const en = [' the ', ' and ', ' what ', ' how ', ' for ', ' with ', ' you ', ' is '];

    let esHits = 0;
    let enHits = 0;

    for (const w of es) if (s.includes(w)) esHits++;
    for (const w of en) if (s.includes(w)) enHits++;

    if (esHits === 0 && enHits === 0) return null;
    if (esHits === enHits) return null;
    return esHits > enHits ? 'es' : 'en';
  }

  /* ─── API ───────────────────────────────────────────────────────────── */

  /**
   * Devuelve la directiva de idioma para el system prompt.
   * @param {string} [lastMessage]
   * @returns {string}
   */
  function getDirective(lastMessage = '') {
    const detected = detect();

    if (!detected.supported) {
      // Idioma no soportado: si el último mensaje está en español o
      // inglés, se usa ese. Si no, se devuelve la directiva por defecto.
      const fromMessage = detectMessageLanguage(lastMessage);
      if (fromMessage && DIRECTIVES[fromMessage]) return DIRECTIVES[fromMessage];
      return DIRECTIVES.es;
    }

    return DIRECTIVES[detected.lang];
  }

  /**
   * Aplica la directiva a un payload de chat.
   * @param {object} payload  { message, systemPrompt, role, ... }
   * @returns {object} payload nuevo (no muta el original)
   */
  function applyTo(payload) {
    if (!payload || typeof payload !== 'object') return payload;

    const message = payload.message || '';
    const directive = getDirective(message);

    const current = String(payload.systemPrompt || '');

    // Si ya está aplicada, no se duplica.
    if (current.includes(directive)) return payload;

    const next = current
      ? `${current}\n\n${directive}`
      : directive;

    return { ...payload, systemPrompt: next, language: state.lang };
  }

  /**
   * Aplica la directiva a un array de mensajes (para el historial).
   */
  function applyToMessages(messages) {
    if (!Array.isArray(messages) || !messages.length) return messages;

    const directive = getDirective(
      [...messages].reverse().find((m) => m?.role === 'user')?.content || ''
    );

    const systemIndex = messages.findIndex((m) => m?.role === 'system');

    if (systemIndex >= 0) {
      const copy = messages.map((m) => ({ ...m }));
      if (!String(copy[systemIndex].content || '').includes(directive)) {
        copy[systemIndex].content = `${copy[systemIndex].content}\n\n${directive}`;
      }
      return copy;
    }

    return [{ role: 'system', content: directive }, ...messages];
  }

  /**
   * Etiqueta visible para el usuario ("Español (es-CO)").
   */
  function getLabel() {
    const detected = detect();
    const names = {
      es: 'Español',
      en: 'English',
    };
    const name = names[detected.lang] || detected.lang.toUpperCase();
    return detected.region ? `${name} (${detected.lang}-${detected.region})` : name;
  }

  /* ─── Arranque ──────────────────────────────────────────────────────── */

  function init() {
    const detected = detect();
    state.lang = detected.lang;
    state.region = detected.region;
    state.directive = getDirective();
    state.detected = true;

    // Si el usuario cambia el idioma del navegador en caliente, se
    // recalcula (raro, pero no cuesta nada).
    window.addEventListener('languagechange', () => {
      state.lang = detect().lang;
      state.directive = getDirective();
      document.dispatchEvent(new CustomEvent('numination:language-changed', {
        detail: { lang: state.lang, directive: state.directive },
      }));
    });

    // Integración con el chat: si existe un bus de eventos, se engancha.
    if (window.eventBus && typeof window.eventBus.on === 'function') {
      window.eventBus.on('chat:send', (payload) => applyTo(payload));
    }

    return state;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  window.NumLanguageDetector = {
    init,
    detect,
    detectMessageLanguage,
    getDirective,
    getLabel,
    applyTo,
    applyToMessages,
    get language() { return state.lang; },
    get directive() { return state.directive; },
    DIRECTIVES,
  };
})();
