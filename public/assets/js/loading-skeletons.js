/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · loading-skeletons.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Skeletons de carga que reemplazan al spinner aburrido.

   QUÉ HACE
     · Inyecta el CSS dinámico (con `@keyframes shimmer`) UNA sola vez.
     · Expone helpers para crear skeletons de distintos tipos:
       texto, párrafo, avatar, tarjeta, tabla, botón.
     · Puede convertir cualquier spinner existente (`.spinner`,
       `[class*="loading"]`) en un skeleton automáticamente.
     · Respeta `prefers-reduced-motion`: sin animación, sólo un gris
       estático (mejor que un spinner parpadeando).

   POR QUÉ EL CSS SE INYECTA Y NO ES UN ARCHIVO
     El proyecto no usa archivos .css: todo el estilo visual se genera
     desde JS con `document.createElement('style')`.

   USO
     const sk = NumLoadingSkeletons.text(3);
     container.replaceChildren(sk);
     // ... cuando llega el dato:
     NumLoadingSkeletons.remove(container);
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STYLE_ID = 'numination-skeleton-styles';

  const CSS = `
@keyframes nm-shimmer {
  0%   { background-position: -320px 0; }
  100% { background-position: 320px 0; }
}
@keyframes nm-pulse {
  0%, 100% { opacity: .55; }
  50%      { opacity: .9; }
}
.nm-sk {
  position: relative;
  overflow: hidden;
  border-radius: 6px;
  background-color: rgba(255,255,255,.055);
  background-image: linear-gradient(90deg,
    rgba(255,255,255,0) 0%,
    rgba(255,255,255,.075) 50%,
    rgba(255,255,255,0) 100%);
  background-size: 320px 100%;
  background-repeat: no-repeat;
  animation: nm-shimmer 1.25s infinite linear;
}
.nm-sk--text    { height: 11px; margin: 7px 0; }
.nm-sk--text-sm { height: 9px;  margin: 5px 0; border-radius: 5px; }
.nm-sk--title   { height: 17px; margin: 0 0 12px; width: 42%; border-radius: 7px; }
.nm-sk--avatar  { width: 34px; height: 34px; border-radius: 50%; flex: 0 0 34px; }
.nm-sk--card    { height: 96px; border-radius: 12px; border: 1px solid rgba(255,255,255,.05); }
.nm-sk--block   { height: 120px; border-radius: 12px; }
.nm-sk--button  { height: 32px; width: 96px; border-radius: 8px; }
.nm-sk--chip    { height: 20px; width: 62px; border-radius: 99px; }
.nm-sk--code    { height: 14px; margin: 6px 0; border-radius: 4px; }
.nm-sk--table-row { height: 38px; margin: 0 0 6px; border-radius: 8px; }
.nm-sk--circle  { border-radius: 50%; }
.nm-sk-stack    { display: flex; flex-direction: column; }
.nm-sk-row      { display: flex; align-items: center; gap: 10px; }
.nm-sk-group    { display: flex; gap: 14px; flex-wrap: wrap; }
.nm-sk--pulse   { animation: nm-pulse 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .nm-sk { animation: none !important; background-image: none; }
  .nm-sk--pulse { animation: none !important; }
}
`;

  const state = {
    injected: false,
    observers: [],
  };

  /* ─── CSS ───────────────────────────────────────────────────────────── */

  function injectStyles() {
    if (state.injected) return;
    if (document.getElementById(STYLE_ID)) {
      state.injected = true;
      return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);

    state.injected = true;
  }

  /* ─── Constructores ─────────────────────────────────────────────────── */

  function make(className, style) {
    const el = document.createElement('div');
    el.className = `nm-sk ${className}`.trim();
    el.setAttribute('aria-hidden', 'true');
    if (style) el.setAttribute('style', style);
    return el;
  }

  /** Una línea de texto. */
  function text(lines = 1, width = null) {
    const stack = document.createElement('div');
    stack.className = 'nm-sk-stack';

    for (let i = 0; i < lines; i++) {
      const last = i === lines - 1;
      const w = width || (last ? '58%' : '100%');
      stack.appendChild(make('nm-sk--text', `width:${w}`));
    }

    return stack;
  }

  /** Un título. */
  function title() {
    return make('nm-sk--title');
  }

  /** Un avatar. */
  function avatar(size = 34) {
    return make('nm-sk--avatar', `width:${size}px;height:${size}px;flex:0 0 ${size}px`);
  }

  /** Una tarjeta. */
  function card(height = 96) {
    return make('nm-sk--card', `height:${height}px`);
  }

  /** Un bloque grande. */
  function block(height = 120) {
    return make('nm-sk--block', `height:${height}px`);
  }

  /** Un botón. */
  function button(width = 96) {
    return make('nm-sk--button', `width:${width}px`);
  }

  /** Un chip / etiqueta. */
  function chip() {
    return make('nm-sk--chip');
  }

  /** Filas de tabla. */
  function table(rows = 5) {
    const stack = document.createElement('div');
    stack.className = 'nm-sk-stack';

    for (let i = 0; i < rows; i++) {
      const row = document.createElement('div');
      row.className = 'nm-sk nm-sk--table-row';
      row.style.width = `${100 - (i % 3) * 6}%`;
      stack.appendChild(row);
    }

    return stack;
  }

  /** Un avatar + un bloque de texto (común en comentarios y mensajes). */
  function message() {
    const row = document.createElement('div');
    row.className = 'nm-sk-row';
    row.style.marginBottom = '14px';
    row.append(avatar(), text(2));
    return row;
  }

  /** Un grupo de tarjetas (KPIs). */
  function cards(count = 4, height = 96) {
    const group = document.createElement('div');
    group.className = 'nm-sk-group';

    for (let i = 0; i < count; i++) {
      group.appendChild(card(height));
    }

    return group;
  }

  /** Bloques de código (para el IDE). */
  function code(lines = 6) {
    const stack = document.createElement('div');
    stack.className = 'nm-sk-stack';

    for (let i = 0; i < lines; i++) {
      const w = 40 + ((i * 17) % 55);
      stack.appendChild(make('nm-sk--code', `width:${w}%`));
    }

    return stack;
  }

  /* ─── Utilidades ────────────────────────────────────────────────────── */

  /**
   * Muestra un skeleton dentro de un contenedor.
   */
  function show(container, kind = 'text', count = 3) {
    if (!container) return null;

    injectStyles();

    const node = typeof kind === 'function' ? kind() : build(kind, count);
    container.replaceChildren(node);
    container.dataset.nmSkeleton = '1';

    return node;
  }

  function build(kind, count = 3) {
    switch (kind) {
      case 'title': return title();
      case 'avatar': return avatar();
      case 'card': return card();
      case 'block': return block();
      case 'button': return button();
      case 'chip': return chip();
      case 'table': return table(count);
      case 'message': return message();
      case 'cards': return cards(count);
      case 'code': return code(count);
      case 'text':
      default: return text(count);
    }
  }

  /**
   * Quita el skeleton de un contenedor.
   */
  function remove(container) {
    if (!container) return;
    if (container.dataset.nmSkeleton === '1') {
      container.replaceChildren();
      delete container.dataset.nmSkeleton;
    }
  }

  /**
   * Convierte los spinners existentes en skeletons.
   *
   * @param {string} [selector]  Selector de los spinners (por defecto, los
   *   clases típicas de spinner).
   */
  function replaceSpinners(selector = '.spinner, [class*="spinner"], [class*="loader"], [class*="loading-circle"]') {
    injectStyles();

    let count = 0;

    document.querySelectorAll(selector).forEach((node) => {
      if (node.dataset.nmSkeletonReplaced === '1') return;
      if (node.classList.contains('nm-sk')) return;

      node.dataset.nmSkeletonReplaced = '1';

      const replacement = make('nm-sk nm-sk--circle', 'width:22px;height:22px');
      replacement.classList.add('nm-sk--pulse');

      if (node.parentNode) {
        node.parentNode.replaceChild(replacement, node);
        count++;
      }
    });

    return count;
  }

  /**
   * Observa un contenedor y muestra un skeleton mientras está vacío
   * (carga asíncrona de una región).
   *
   * @param {HTMLElement} container
   * @param {object} [opts] { kind, count, threshold }
   */
  function watch(container, opts = {}) {
    if (!container) return null;

    injectStyles();

    const { kind = 'text', count = 3, threshold = 120 } = opts;
    let emptyTimer = null;

    const observer = new MutationObserver(() => {
      clearTimeout(emptyTimer);
      emptyTimer = setTimeout(() => {
        const isEmpty = container.children.length === 0;
        if (isEmpty && container.dataset.nmSkeleton !== '1') {
          show(container, kind, count);
        } else if (!isEmpty) {
          remove(container);
        }
      }, threshold);
    });

    observer.observe(container, { childList: true });

    state.observers.push(observer);

    return observer;
  }

  /* ─── API pública ───────────────────────────────────────────────────── */

  window.NumLoadingSkeletons = {
    injectStyles,
    show,
    remove,
    build,
    replaceSpinners,
    watch,
    text,
    title,
    avatar,
    card,
    block,
    button,
    chip,
    table,
    message,
    cards,
    code,
  };

  document.addEventListener('DOMContentLoaded', () => {
    injectStyles();
    // Los spinners que ya están en el HTML se convierten al cargar.
    setTimeout(() => replaceSpinners(), 400);
  });
})();
