/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · terminal-history.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Historial de comandos de la terminal, persistido en localStorage.

   REGLAS
     · Máximo 50 comandos (los más antiguos se caen).
     · Comandos repetidos consecutivos se colapsan (y se sube una vez en
       lugar de 20).
     · Los comandos con contraseña se filtran antes de guardarse
       (`export TOKEN=...`, `psql postgres://...`).
     · Se integra con la terminal del Coder interceptando las flechas
       ↑ / ↓ sobre el input de la terminal.

   POR QUÉ localStorage Y NO EL SERVIDOR
     El historial es del usuario, es pequeño, y así funciona aunque el
     servidor esté caído. Además no sale de su navegador.
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STORAGE_KEY = 'nm_terminal_history';
  const MAX_ITEMS = 50;

  /** Patrones de secretos: si un comando matchea, NO se guarda. */
  const SECRET_PATTERNS = [
    /\b(password|passwd|pwd|secret|token|api[_-]?key)\s*=\s*\S+/i,
    /\bpostgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/i,
    /\bBearer\s+[A-Za-z0-9._-]{12,}/i,
    /\bssh-pass\b|\b--password\b/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  ];

  const state = {
    items: [],
    index: -1,
    draft: '',
    storageOk: true,
  };

  /* ─── Persistencia ───────────────────────────────────────────────────── */

  function load() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        state.items = [];
        return state.items;
      }
      const parsed = JSON.parse(raw);
      state.items = Array.isArray(parsed) ? parsed.slice(-MAX_ITEMS).map(String) : [];
    } catch (e) {
      state.items = [];
      state.storageOk = false;
      console.warn('[terminal-history] no se pudo leer el historial', e);
    }
    return state.items;
  }

  function save() {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state.items.slice(-MAX_ITEMS)));
    } catch (e) {
      state.storageOk = false;
      console.warn('[terminal-history] no se pudo guardar el historial', e);
    }
  }

  /* ─── API ────────────────────────────────────────────────────────────── */

  /**
   * Agrega un comando al historial.
   * @param {string} command
   * @returns {boolean} true si se guardó
   */
  function push(command) {
    const cmd = String(command || '').trim();

    if (!cmd) return false;

    // Nunca se guardan comandos con credenciales.
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(cmd)) {
        console.info('[terminal-history] comando con secretos: no se guarda');
        return false;
      }
    }

    // Se colapsan duplicados consecutivos.
    if (state.items.length && state.items[state.items.length - 1] === cmd) {
      return true;
    }

    state.items.push(cmd);

    if (state.items.length > MAX_ITEMS) {
      state.items.splice(0, state.items.length - MAX_ITEMS);
    }

    state.index = state.items.length;
    state.draft = '';

    save();
    return true;
  }

  /**
   * Devuelve el comando en la posición `index` (0 = más reciente).
   */
  function get(index) {
    if (!state.items.length) return null;
    const i = state.items.length - 1 - index;
    return i >= 0 ? state.items[i] : null;
  }

  /**
   * Navega el historial.
   *
   * @param {number} direction  -1 = anterior (↑), +1 = siguiente (↓)
   * @param {string} [currentDraft] Texto que el usuario estaba escribiendo
   *   (se guarda para restaurarlo al bajar del final).
   * @returns {string|null} El comando a mostrar, o null si no hay.
   */
  function navigate(direction, currentDraft = '') {
    if (!state.items.length) return null;

    if (state.index === state.items.length && currentDraft) {
      state.draft = currentDraft;
    }

    if (direction < 0) {
      state.index = Math.max(0, state.index - 1);
    } else {
      state.index = Math.min(state.items.length, state.index + 1);
    }

    if (state.index >= state.items.length) {
      // Volvimos al final: se restaura el borrador.
      state.index = state.items.length;
      return state.draft || '';
    }

    return get(state.items.length - 1 - state.index);
  }

  function clear() {
    state.items = [];
    state.index = -1;
    state.draft = '';
    save();
  }

  function removeAt(index) {
    const i = state.items.length - 1 - index;
    if (i < 0 || i >= state.items.length) return false;
    state.items.splice(i, 1);
    state.index = Math.min(state.index, state.items.length);
    save();
    return true;
  }

  /* ─── Integración con la terminal ────────────────────────────────────── */

  /**
   * Se engancha al input de la terminal (xterm) interceptando las
   * flechas. Si la terminal expone `term.onKey`, se usa esa vía.
   */
  function bindTerminal() {
    const term = window.terminal || window.term || null;

    if (term && typeof term.onKey === 'function') {
      term.onKey(({ key, domEvent }) => {
        if (!domEvent) return;

        if (domEvent.key === 'ArrowUp') {
          const value = navigate(-1, term.buffer?.active?.getLine?.(0) || '');
          if (value !== null) {
            domEvent.preventDefault();
            writeToTerminal(term, value);
          }
          return;
        }

        if (domEvent.key === 'ArrowDown') {
          const value = navigate(1, term.buffer?.active?.getLine?.(0) || '');
          if (value !== null) {
            domEvent.preventDefault();
            writeToTerminal(term, value);
          }
        }
      });
      return true;
    }

    // Fallback: se escuchan las teclas a nivel de documento y se
    // comprueba que el foco esté dentro de la terminal.
    document.addEventListener('keydown', (e) => {
      const target = e.target;
      const inTerminal = target && (
        target.closest('.xterm') ||
        target.classList?.contains('xterm-helper-textarea') ||
        target.closest('#terminal') ||
        target.closest('.terminal')
      );
      if (!inTerminal) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

      const value = navigate(e.key === 'ArrowUp' ? -1 : 1, target.value || '');
      if (value === null) return;

      e.preventDefault();

      if (typeof target.value === 'string') {
        target.value = value;
        target.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    return true;
  }

  function writeToTerminal(term, value) {
    try {
      if (typeof term.clearLine === 'function') term.clearLine();
      if (typeof term.write === 'function') term.write(value);
    } catch (e) {
      console.debug('[terminal-history] no se pudo escribir en la terminal', e);
    }
  }

  /* ─── Montaje ────────────────────────────────────────────────────────── */

  function init() {
    load();
    bindTerminal();

    // Se registran los comandos que la terminal ejecuta por su cuenta.
    if (window.eventBus && typeof window.eventBus.on === 'function') {
      window.eventBus.on('terminal:command', (data) => {
        if (data && typeof data.command === 'string') push(data.command);
      });
      window.eventBus.on('terminal:execute', (data) => {
        if (data && typeof data.command === 'string') push(data.command);
      });
    }

    return state.items;
  }

  window.NumTerminalHistory = {
    init,
    push,
    get,
    navigate,
    clear,
    removeAt,
    load,
    save,
    get items() { return state.items.slice(); },
    get max() { return MAX_ITEMS; },
    get storageOk() { return state.storageOk; },
  };

  document.addEventListener('DOMContentLoaded', init, { once: true });
})();
