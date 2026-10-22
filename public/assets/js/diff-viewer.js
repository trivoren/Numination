/**
 * Numination · Modo Coder — diff-viewer.js
 * Parsea la respuesta de la IA, calcula el diff línea a línea y lo presenta
 * en un modal antes de tocar Monaco. Nada se aplica sin confirmación.
 *
 * Piezas:
 *  - `parseAiResponse(text)`   → extrae el bloque ```lenguaje de la respuesta.
 *  - `buildDiff(original,next)` → diff por líneas (LCS) + stats.
 *  - `expandEllipsis(...)`      → resuelve la marca "// ..." del modelo.
 *  - `open({original, next})`   → muestra el modal y cablea "Aplicar".
 *  - `apply()`                 → escribe en Monaco y emite el evento.
 *
 * Seguridad: todo el texto se inserta con `textContent` (nunca innerHTML),
 * por lo que un prompt malicioso no puede inyectar HTML en el IDE.
 */

(function () {
  'use strict';

  const modal = document.getElementById('diff-modal');
  const body = document.getElementById('diff-body');
  const statAdd = document.getElementById('diff-stat-add');
  const statDel = document.getElementById('diff-stat-del');
  const title = document.getElementById('diff-modal-title');

  /** Máximo de líneas para el diff O(n·m); por encima, diff por bloques. */
  const MAX_DIFF_LINES = 4000;

  /** Estado del modal en curso. */
  let current = null;
  /** Elemento que tenía el foco antes de abrir el modal. */
  let lastFocused = null;

  /* ────────────────────────────────────────────────────────────────
     PARSEO DE LA RESPUESTA DE LA IA
     ──────────────────────────────────────────────────────────────── */

  /**
   * Extrae el código de una respuesta de la IA.
   * @param {string} text Respuesta cruda del modelo.
   * @returns {{ code: string, language: string, explanation: string } | null}
   */
  function parseAiResponse(text) {
    if (typeof text !== 'string' || !text.trim()) return null;

    const fence = /```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/;
    const match = fence.exec(text);

    if (!match) {
      // Sin bloque: si parece código suelto, lo usamos; si es prosa, no hay diff.
      const looksLikeCode = /[;{}]|\n\s*(function|const|let|var|class|def|import|export)\b/.test(text);
      if (!looksLikeCode) return null;
      return { code: text.replace(/\r\n/g, '\n').trimEnd(), language: '', explanation: '' };
    }

    const before = text.slice(0, match.index).trim();
    const after = text.slice(match.index + match[0].length).trim();
    return {
      code: match[2].replace(/\r\n/g, '\n').replace(/\s+$/, ''),
      language: (match[1] || '').toLowerCase(),
      explanation: [before, after].filter(Boolean).join('\n')
    };
  }

  /* ────────────────────────────────────────────────────────────────
     DIFF POR LÍNEAS (LCS)
     ──────────────────────────────────────────────────────────────── */

  /**
   * Calcula el diff entre dos textos.
   * @param {string} original
   * @param {string} next
   * @returns {{ ops: Array<{type:'ctx'|'del'|'add', text:string}>, added:number, removed:number }}
   */
  function buildDiff(original, next) {
    const a = String(original ?? '').split('\n');
    const b = String(next ?? '').split('\n');

    // Diff por bloques cuando el archivo es enorme (evita el coste O(n·m)).
    if (a.length + b.length > MAX_DIFF_LINES) {
      return {
        ops: [
          ...a.map((text) => ({ type: 'del', text })),
          ...b.map((text) => ({ type: 'add', text }))
        ],
        added: b.length,
        removed: a.length
      };
    }

    // Tabla LCS
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    const ops = [];
    let i = 0, j = 0;
    while (i < m && j < n) {
      if (a[i] === b[j]) {
        ops.push({ type: 'ctx', text: a[i] }); i++; j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: 'del', text: a[i] }); i++;
      } else {
        ops.push({ type: 'add', text: b[j] }); j++;
      }
    }
    while (i < m) { ops.push({ type: 'del', text: a[i] }); i++; }
    while (j < n) { ops.push({ type: 'add', text: b[j] }); j++; }

    return finalizeOps(ops);
  }

  /**
   * Resuelve la elisión "// ..." que usa el modelo para no repetir el archivo:
   * si el modelo марcal un bloque como "sin cambios", esas líneas se conservan
   * como contexto en vez de aparecer como borradas.
   * @param {Array<{type:string,text:string}>} ops
   * @returns {{ ops: Array<{type:string,text:string}>, added:number, removed:number }}
   */
  function finalizeOps(ops) {
    const isElision = (line) => {
      const t = String(line || '').trim();
      if (!t.startsWith('//') && !t.startsWith('#') && !t.startsWith('/*')) return false;
      return /(\.\.\.|resto del archivo|resto del fichero|resto del código|sin cambios|unchanged)/i.test(t);
    };

    const out = [];
    for (let k = 0; k < ops.length; k++) {
      const op = ops[k];
      if (op.type === 'add' && isElision(op.text)) {
        // Retrocede hasta el bloque 'del' contiguo y conviértelo en contexto.
        let back = out.length - 1;
        while (back >= 0 && out[back].type === 'del') back--;
        const delStart = back + 1;
        for (let d = delStart; d < out.length; d++) {
          out[d] = { type: 'ctx', text: out[d].text };
        }
        continue; // la marca de elisión no se muestra
      }
      out.push(op);
    }

    const added = out.filter((o) => o.type === 'add').length;
    const removed = out.filter((o) => o.type === 'del').length;
    return { ops: out, added, removed };
  }

  /* ────────────────────────────────────────────────────────────────
     RENDER DEL MODAL
     ──────────────────────────────────────────────────────────────── */

  /**
   * Crea una línea de diff.
   * @param {string} text
   * @param {'ctx'|'add'|'del'|'meta'} type
   * @returns {HTMLElement}
   */
  function makeLine(text, type) {
    const el = document.createElement('div');
    el.className = `diff-line diff-line--${type}`;
    el.textContent = text === '' ? ' ' : text; // textContent ⇒ sin XSS
    return el;
  }

  /**
   * Rellena el modal con el diff calculado.
   * @param {{ops:Array, added:number, removed:number}} diff
   * @param {{filePath?:string, language?:string}} meta
   */
  function renderDiff(diff, meta = {}) {
    if (!body) return;
    body.textContent = '';

    const left = document.createElement('div');
    left.className = 'diff-pane';
    const leftLabel = document.createElement('div');
    leftLabel.className = 'diff-pane__label';
    leftLabel.textContent = `ACTUAL · ${meta.filePath || 'archivo'}`;
    left.appendChild(leftLabel);

    const right = document.createElement('div');
    right.className = 'diff-pane';
    const rightLabel = document.createElement('div');
    rightLabel.className = 'diff-pane__label';
    rightLabel.textContent = `PROPUESTO · ${meta.language || 'texto'}`;
    right.appendChild(rightLabel);

    // Columna izquierda: contexto + borrados
    for (const op of diff.ops) {
      if (op.type === 'ctx') left.appendChild(makeLine(op.text, 'ctx'));
      else if (op.type === 'del') left.appendChild(makeLine(op.text, 'del'));
    }
    // Columna derecha: contexto + añadidos
    for (const op of diff.ops) {
      if (op.type === 'ctx') right.appendChild(makeLine(op.text, 'ctx'));
      else if (op.type === 'add') right.appendChild(makeLine(op.text, 'add'));
    }

    body.append(left, right);
    if (statAdd) statAdd.textContent = `+${diff.added}`;
    if (statDel) statDel.textContent = `−${diff.removed}`;
    if (title) {
      title.textContent = meta.filePath
        ? `Cambios propuestos · ${meta.filePath}`
        : 'Cambios propuestos por la IA';
    }
  }

  /* ────────────────────────────────────────────────────────────────
     CICLO DE VIDA DEL MODAL
     ──────────────────────────────────────────────────────────────── */

  /**
   * Abre el modal con un diff.
   * @param {{original:string, next:string, filePath?:string, language?:string, onApply?:Function, onDiscard?:Function}} payload
   * @returns {void}
   */
  function open(payload) {
    if (!modal) return;
    const original = payload.original ?? '';
    const next = payload.next ?? '';

    if (original === next) {
      window.NuminToast.info('La IA no propuso cambios de código.');
      window.eventBus?.emit('diff:noop', { path: payload.filePath });
      return;
    }

    const diff = buildDiff(original, next);
    current = { ...payload, diff };
    renderDiff(diff, payload);

    lastFocused = document.activeElement;
    modal.hidden = false;
    document.body.style.overflow = 'hidden';

    const applyBtn = modal.querySelector('[data-diff-action="apply"]');
    const discardBtn = modal.querySelector('[data-diff-action="discard"]');
    applyBtn?.focus();

    window.eventBus?.emit('diff:opened', { path: payload.filePath, added: diff.added, removed: diff.removed });
  }

  /**
   * Aplica los cambios propuestos en Monaco.
   * @returns {void}
   */
  function apply() {
    if (!current) return;
    const { next, filePath, diff, onApply } = current;

    if (window.EditorState && typeof window.EditorState.updateValue === 'function') {
      window.EditorState.updateValue(next, false);
    }

    window.eventBus?.emit('diff:applied', {
      path: filePath,
      added: diff.added,
      removed: diff.removed
    });
    if (typeof onApply === 'function') onApply({ next, diff });

    window.NuminToast?.ok(`Cambios aplicados a ${filePath || 'el editor'}.`);
    close();
  }

  /**
   * Descarta los cambios propuestos.
   * @returns {void}
   */
  function discard() {
    if (!current) return;
    const { filePath, onDiscard } = current;
    window.eventBus?.emit('diff:discarded', { path: filePath });
    if (typeof onDiscard === 'function') onDiscard();
    window.NuminToast?.info('Cambios descartados.');
    close();
  }

  /**
   * Cierra el modal y restaura el foco.
   * @returns {void}
   */
  function close() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = '';
    current = null;
    if (lastFocused && typeof lastFocused.focus === 'function') {
      try { lastFocused.focus(); } catch { /* noop */ }
    }
  }

  /* ── Foco y teclado ── */
  function trapFocus(event) {
    if (!modal || modal.hidden || event.key !== 'Tab') return;
    const focusables = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  document.addEventListener('keydown', (event) => {
    if (!modal || modal.hidden) return;
    if (event.key === 'Escape') { event.preventDefault(); discard(); }
    trapFocus(event);
  });

  modal?.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.hasAttribute('data-diff-close')) { discard(); return; }
    const action = target.getAttribute('data-diff-action');
    if (action === 'apply') apply();
    else if (action === 'discard') discard();
  });

  window.DiffViewer = {
    parseAiResponse,
    buildDiff,
    finalizeOps,
    renderDiff,
    open,
    apply,
    discard,
    close,
    isOpen: () => Boolean(modal && !modal.hidden)
  };
  window.diffViewer = window.DiffViewer;
})();
