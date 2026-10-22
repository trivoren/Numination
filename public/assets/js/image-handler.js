/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · image-handler.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Render de imágenes generadas en el chat.

   · Skeleton loader mientras carga el binario (nunca un hueco en blanco).
   · Botón "Descargar" que baja el archivo con Content-Disposition.
   · Detecta imágenes dentro de respuestas en Markdown y las mejora.
   · Si la imagen falla, muestra un estado de error recuperable con un
     botón "Reintentar".

   Uso en el chat:
     window.NumImageHandler.enhance(container)  // escanea y mejora
     window.NumImageHandler.render(el, image)   // render manual
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const ICONS = {
    download: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M7 10l5 5 5-5"></path><path d="M12 15V3"></path></svg>',
    retry: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"></path><path d="M21 3v6h-6"></path></svg>',
    broken: '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2.5"></rect><path d="M3 15l5-5 4 4 3-3 6 6"></path><circle cx="8.5" cy="8.5" r="1.5"></circle></svg>',
    open: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"></path><path d="M10 14L21 3"></path><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"></path></svg>',
  };

  /* ─── Utilidades ────────────────────────────────────────────────────── */

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((key) => {
        if (key === 'class') node.className = attrs[key];
        else if (key === 'text') node.textContent = attrs[key];
        else if (key === 'html') node.innerHTML = attrs[key];
        else if (key.startsWith('on') && typeof attrs[key] === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
        } else if (attrs[key] !== null && attrs[key] !== undefined) {
          node.setAttribute(key, attrs[key]);
        }
      });
    }
    (children || []).forEach((child) => {
      if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function toast(message, kind = 'info') {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
      return;
    }
    console.info('[image-handler]', kind, message);
  }

  function safeFilename(prompt, ext = 'png') {
    const base = String(prompt || 'numination-imagen')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'numination-imagen';
    return `${base}.${ext}`;
  }

  /* ─── Descarga ──────────────────────────────────────────────────────── */

  /**
   * Descarga una imagen.
   * Intenta el endpoint firmado (mismo origen → sin problemas de CORS)
   * y si falla, cae al enlace directo.
   */
  async function downloadImage(url, prompt) {
    if (!url) return;

    const isData = String(url).startsWith('data:');
    const isProxy = String(url).includes('/api/images/proxy');

    try {
      if (isData) {
        triggerDownloadFromDataUrl(url, safeFilename(prompt));
        return;
      }

      if (isProxy || url.startsWith('/')) {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        triggerDownloadFromBlob(blob, safeFilename(prompt, blob.type.includes('jpeg') ? 'jpg' : 'png'));
        return;
      }

      // URL remota: se intenta vía proxy firmado para no depender de CORS.
      const proxied = await fetch('/api/images/proxy?url=' + encodeURIComponent(url), {
        credentials: 'same-origin',
      });
      if (proxied.ok) {
        const blob = await proxied.blob();
        triggerDownloadFromBlob(blob, safeFilename(prompt, blob.type.includes('jpeg') ? 'jpg' : 'png'));
        return;
      }

      // Último recurso: abrir en una pestaña nueva.
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      console.warn('[image-handler] descarga fallida', e);
      window.open(url, '_blank', 'noopener');
      toast('Se abrió la imagen en una pestaña nueva.', 'info');
    }
  }

  function triggerDownloadFromBlob(blob, filename) {
    const href = URL.createObjectURL(blob);
    const a = el('a', { href, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(href);
      a.remove();
    }, 1500);
  }

  function triggerDownloadFromDataUrl(dataUrl, filename) {
    const a = el('a', { href: dataUrl, download: filename });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 200);
  }

  /* ─── Render ────────────────────────────────────────────────────────── */

  /**
   * Renderiza una imagen con skeleton y acciones.
   *
   * @param {HTMLElement} container
   * @param {object} image  { url, prompt, downloadUrl, width, height }
   * @returns {HTMLElement} El nodo renderizado
   */
  function render(container, image = {}) {
    if (!container) return null;

    const url = image.url || image.src || '';
    const prompt = image.prompt || image.alt || 'imagen generada';
    const source = image.downloadUrl || url;

    const skeleton = el('div', { class: 'img-skeleton' }, [
      el('div', { class: 'img-skeleton__shine' }),
    ]);

    const img = el('img', {
      class: 'img-img',
      src: url,
      alt: prompt,
      loading: 'lazy',
      decoding: 'async',
    });
    if (image.width) img.width = image.width;
    if (image.height) img.height = image.height;

    const errorBox = el('div', { class: 'img-error' }, [
      el('div', { class: 'img-error__icon', html: ICONS.broken }),
      el('div', { class: 'img-error__text', text: 'No se pudo cargar la imagen.' }),
      el('button', {
        class: 'img-btn',
        type: 'button',
        html: `${ICONS.retry}<span>Reintentar</span>`,
        onclick: () => {
          errorBox.hidden = true;
          skeleton.hidden = false;
          img.hidden = false;
          img.src = url.split('?')[0] + `?r=${Date.now()}`;
        },
      }),
    ]);
    errorBox.hidden = true;

    img.addEventListener('load', () => {
      skeleton.hidden = true;
      img.hidden = false;
    });

    img.addEventListener('error', () => {
      skeleton.hidden = true;
      img.hidden = true;
      errorBox.hidden = false;
    });

    const actions = el('div', { class: 'img-actions' }, [
      el('button', {
        class: 'img-btn',
        type: 'button',
        title: 'Descargar',
        html: `${ICONS.download}<span>Descargar</span>`,
        onclick: () => downloadImage(source, prompt),
      }),
      el('button', {
        class: 'img-btn img-btn--ghost',
        type: 'button',
        title: 'Abrir en otra pestaña',
        html: `${ICONS.open}<span>Abrir</span>`,
        onclick: () => window.open(url, '_blank', 'noopener'),
      }),
    ]);

    const caption = el('figcaption', { class: 'img-caption', text: prompt });

    const figure = el('figure', { class: 'img-figure' }, [
      el('div', { class: 'img-frame' }, [skeleton, img, errorBox]),
      el('div', { class: 'img-meta' }, [caption, actions]),
    ]);

    container.appendChild(figure);
    return figure;
  }

  /* ─── Mejora de contenido existente ──────────────────────────────────── */

  /**
   * Busca imágenes `<img>` dentro de un contenedor y les añade el
   * esqueleto, el pie de foto y los botones de acción.
   */
  function enhance(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return 0;

    const images = Array.from(container.querySelectorAll('img'));
    let count = 0;

    images.forEach((img) => {
      if (img.dataset.numEnhanced === '1') return;
      img.dataset.numEnhanced = '1';

      const src = img.getAttribute('src') || '';
      if (!src) return;

      const alt = img.getAttribute('alt') || 'imagen';

      // Si la imagen ya vive dentro de una figura nuestra, se saltea.
      if (img.closest('.img-figure')) return;

      const wrapper = el('div', { class: 'img-frame' });
      const parent = img.parentNode;
      if (!parent) return;

      parent.insertBefore(wrapper, img);
      wrapper.appendChild(img);

      const skeleton = el('div', { class: 'img-skeleton' }, [el('div', { class: 'img-skeleton__shine' })]);
      if (img.complete && img.naturalWidth > 0) {
        skeleton.hidden = true;
      } else {
        wrapper.insertBefore(skeleton, img);
        img.addEventListener('load', () => { skeleton.hidden = true; }, { once: true });
      }

      const actions = el('div', { class: 'img-actions' }, [
        el('button', {
          class: 'img-btn',
          type: 'button',
          html: `${ICONS.download}<span>Descargar</span>`,
          onclick: () => downloadImage(src, alt),
        }),
      ]);

      const caption = el('figcaption', { class: 'img-caption', text: alt });
      const meta = el('div', { class: 'img-meta' }, [caption, actions]);

      const figure = el('figure', { class: 'img-figure' });
      wrapper.parentNode.insertBefore(figure, wrapper);
      figure.appendChild(wrapper);
      figure.appendChild(meta);

      count++;
    });

    return count;
  }

  /* ─── API pública ───────────────────────────────────────────────────── */

  window.NumImageHandler = {
    render,
    enhance,
    downloadImage,
    safeFilename,
  };

  // Auto-mejora cuando el chat inserta contenido nuevo.
  document.addEventListener('DOMContentLoaded', () => {
    const chat = document.getElementById('chat-messages') || document.getElementById('messages');
    if (!chat) return;

    const observer = new MutationObserver((mutations) => {
      let touched = false;
      mutations.forEach((m) => {
        if (m.addedNodes && m.addedNodes.length) touched = true;
      });
      if (touched) enhance(chat);
    });

    observer.observe(chat, { childList: true, subtree: true });
  });
})();
