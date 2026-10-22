/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · rag-ui.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Dropzone de PDFs para el chat.

   Flujo:
     1. El usuario arrastra (o elige) un PDF.
     2. Se sube con XHR (necesitamos `upload.onprogress`; fetch no lo da).
     3. El backend devuelve un `jobId` y el cliente lo sondea.
     4. Barra de progreso con la etapa real ("extrayendo texto",
        "generando embeddings", "guardando…").
     5. Al terminar, el documento queda disponible para el RAG y se emite
        el evento `numination:rag-ready` para que el chat lo sepa.

   Integración en el chat:
     <div id="rag-dropzone"></div>   → se inyecta la UI aquí
     o bien  window.NumRagUI.mount(elChatContainer)
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const MAX_BYTES = 15 * 1024 * 1024;
  const POLL_MS = 1200;
  const MAX_CONCURRENT = 2;

  const state = {
    root: null,
    items: [],          // { id, name, size, status, pct, stage, error, docId }
    active: 0,
    listEl: null,
    counter: 0,
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

  function fmtBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / 1024 / 1024).toFixed(1)} MB`;
  }

  function toast(message, kind = 'info') {
    if (window.NuminToast && typeof window.NuminToast.show === 'function') {
      window.NuminToast.show(message, kind);
      return;
    }
    console.info('[rag-ui]', kind, message);
  }

  async function api(path, options = {}) {
    const { method = 'GET', body, timeoutMs = 30000 } = options;

    if (window.NumAPI && typeof window.NumAPI.request === 'function') {
      return window.NumAPI.request(path, { method, body, timeoutMs });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const init = {
        method,
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      };
      if (body !== undefined && body !== null) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await fetch(path, init);
      const text = await res.text();
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
      }
      if (!res.ok) {
        const err = new Error(payload?.error || `Error ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ─── Íconos ────────────────────────────────────────────────────────── */

  const ICONS = {
    pdf: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M9 15h6"></path><path d="M9 18h4"></path></svg>',
    up: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><path d="M7 10l5-5 5 5"></path><path d="M12 5v12"></path></svg>',
    trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4h8v2"></path><path d="M19 6l-1 14H6L5 6"></path></svg>',
    check: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg>',
    warn: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"></path><path d="M12 17h.01"></path><circle cx="12" cy="12" r="9"></circle></svg>',
  };

  /* ─── Render ────────────────────────────────────────────────────────── */

  function render() {
    if (!state.listEl) return;
    state.listEl.innerHTML = '';

    if (!state.items.length) {
      state.listEl.appendChild(el('div', {
        class: 'rag-empty',
        text: 'Sin documentos. Arrastrá un PDF para que la IA pueda citarlo.',
      }));
      return;
    }

    state.items.forEach((item) => {
      const bar = el('div', { class: 'rag-bar' });
      const fill = el('div', { class: 'rag-bar__fill' });
      fill.style.width = `${item.pct}%`;
      if (item.status === 'error') fill.classList.add('is-error');
      if (item.status === 'done') fill.classList.add('is-done');
      bar.appendChild(fill);

      let icon = ICONS.pdf;
      if (item.status === 'done') icon = ICONS.check;
      if (item.status === 'error') icon = ICONS.warn;

      const actions = el('div', { class: 'rag-item__actions' });
      if (item.status === 'done' && item.docId) {
        actions.appendChild(el('button', {
          class: 'rag-btn rag-btn--danger',
          type: 'button',
          title: 'Eliminar documento',
          html: ICONS.trash,
          onclick: () => removeDocument(item),
        }));
      }

      const row = el('div', { class: `rag-item is-${item.status}` }, [
        el('div', { class: 'rag-item__icon', html: icon }),
        el('div', { class: 'rag-item__body' }, [
          el('div', { class: 'rag-item__name', title: item.name, text: item.name }),
          el('div', { class: 'rag-item__meta', text: metaText(item) }),
          bar,
        ]),
        actions,
      ]);

      state.listEl.appendChild(row);
    });
  }

  function metaText(item) {
    if (item.status === 'error') return item.error || 'Error al procesar';
    if (item.status === 'done') {
      const chunks = item.chunkCount ? ` · ${item.chunkCount} fragmentos` : '';
      const degraded = item.degraded ? ' · indexado básico' : '';
      return `Listo${chunks}${degraded} · ${fmtBytes(item.size)}`;
    }
    return `${item.stage || 'Procesando…'} · ${item.pct}% · ${fmtBytes(item.size)}`;
  }

  function setItem(id, patch) {
    const item = state.items.find((i) => i.id === id);
    if (!item) return;
    Object.assign(item, patch);
    render();
  }

  /* ─── Subida ────────────────────────────────────────────────────────── */

  function handleFiles(fileList) {
    const files = Array.from(fileList || []);

    if (!files.length) return;

    files.forEach((file) => {
      if (!/\.pdf$/i.test(file.name)) {
        toast(`"${file.name}" no es un PDF.`, 'error');
        return;
      }
      if (file.size > MAX_BYTES) {
        toast(`"${file.name}" supera los 15 MB.`, 'error');
        return;
      }
      if (state.active >= MAX_CONCURRENT) {
        toast('Espera a que terminen las subidas en curso.', 'info');
        return;
      }

      const id = `rag-${++state.counter}`;
      state.items.unshift({
        id,
        name: file.name,
        size: file.size,
        status: 'uploading',
        pct: 0,
        stage: 'subiendo',
        error: null,
        docId: null,
        chunkCount: 0,
        degraded: false,
      });
      state.active++;
      render();
      upload(id, file);
    });
  }

  function upload(id, file) {
    const form = new FormData();
    form.append('file', file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/rag/upload', true);
    xhr.withCredentials = true;

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      setItem(id, { status: 'uploading', pct: Math.min(pct, 99), stage: 'subiendo' });
    };

    xhr.onload = () => {
      let payload = null;
      try { payload = JSON.parse(xhr.responseText); } catch { payload = null; }

      if (xhr.status >= 200 && xhr.status < 300 && payload?.jobId) {
        setItem(id, { status: 'processing', pct: 100, stage: 'procesando' });
        poll(id, payload.jobId);
        return;
      }

      const message = payload?.error || `Error ${xhr.status} al subir el archivo.`;
      state.active = Math.max(0, state.active - 1);
      setItem(id, { status: 'error', error: message });
      toast(message, 'error');
    };

    xhr.onerror = () => {
      state.active = Math.max(0, state.active - 1);
      setItem(id, { status: 'error', error: 'No hay conexión con el servidor.' });
      toast('No se pudo subir el PDF.', 'error');
    };

    xhr.ontimeout = () => {
      state.active = Math.max(0, state.active - 1);
      setItem(id, { status: 'error', error: 'La subida excedió el tiempo límite.' });
    };

    xhr.timeout = 120000;
    xhr.send(form);
  }

  async function poll(id, jobId) {
    let delay = POLL_MS;

    for (;;) {
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.35), 5000);

      let payload;
      try {
        payload = await api(`/api/rag/jobs/${encodeURIComponent(jobId)}`, { timeoutMs: 15000 });
      } catch (e) {
        // Un fallo puntual de red no debe matar el trabajo: se reintenta.
        continue;
      }

      const job = payload?.job;
      if (!job) continue;

      if (job.status === 'done') {
        state.active = Math.max(0, state.active - 1);
        setItem(id, {
          status: 'done',
          pct: 100,
          stage: 'listo',
          docId: job.docId,
          chunkCount: job.chunkCount,
          degraded: job.degraded,
        });
        toast(`"${job.filename}" quedó listo para consultar.`, 'ok');
        document.dispatchEvent(new CustomEvent('numination:rag-ready', {
          detail: { docId: job.docId, filename: job.filename, chunks: job.chunkCount },
        }));
        loadDocuments();
        return;
      }

      if (job.status === 'error') {
        state.active = Math.max(0, state.active - 1);
        setItem(id, { status: 'error', error: job.error || 'No se pudo procesar el PDF.' });
        toast(job.error || 'No se pudo procesar el PDF.', 'error');
        return;
      }

      setItem(id, { status: 'processing', pct: job.pct, stage: job.stage });
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /* ─── Documentos guardados ──────────────────────────────────────────── */

  async function loadDocuments() {
    try {
      const data = await api('/api/rag/documents');
      const docs = Array.isArray(data?.documents) ? data.documents : [];
      // Se Limpian los items locales ya persistidos para no duplicar.
      const known = new Set(docs.map((d) => d.id));
      state.items = state.items.filter((i) => i.status !== 'done' || !known.has(i.docId));
      render();
    } catch {
      /* silencioso: la lista de documentos es complementaria */
    }
  }

  async function removeDocument(item) {
    if (!item.docId) return;
    try {
      await api(`/api/rag/documents/${encodeURIComponent(item.docId)}`, { method: 'DELETE' });
      state.items = state.items.filter((i) => i.id !== item.id);
      render();
      toast('Documento eliminado.', 'ok');
      document.dispatchEvent(new CustomEvent('numination:rag-removed', { detail: { docId: item.docId } }));
    } catch (e) {
      toast(e.message || 'No se pudo eliminar.', 'error');
    }
  }

  /* ─── Montaje ───────────────────────────────────────────────────────── */

  function buildDropzone() {
    const input = el('input', {
      type: 'file',
      accept: 'application/pdf,.pdf',
      multiple: 'multiple',
      class: 'rag-input',
      style: 'display:none',
    });

    input.addEventListener('change', () => {
      handleFiles(input.files);
      input.value = '';
    });

    const zone = el('div', {
      class: 'rag-dropzone',
      role: 'button',
      tabindex: '0',
      'aria-label': 'Subir un PDF para indexarlo',
    }, [
      el('div', { class: 'rag-dropzone__icon', html: ICONS.up }),
      el('div', { class: 'rag-dropzone__title', text: 'Arrastrá tus PDFs acá' }),
      el('div', { class: 'rag-dropzone__hint', text: 'o hacé clic para elegir · máx. 15 MB' }),
      input,
    ]);

    zone.addEventListener('click', (e) => {
      if (e.target === input) return;
      input.click();
    });
    zone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        input.click();
      }
    });

    ['dragenter', 'dragover'].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.add('is-over');
      });
    });

    ['dragleave', 'drop'].forEach((evt) => {
      zone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        zone.classList.remove('is-over');
      });
    });

    zone.addEventListener('drop', (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      if (dt.files && dt.files.length) handleFiles(dt.files);
    });

    return zone;
  }

  /**
   * Monta la UI de RAG dentro de un contenedor.
   * @param {HTMLElement} container
   * @param {object} [options]
   */
  function mount(container, options = {}) {
    if (!container) return null;
    if (state.root && state.root.isConnected) return state.root;

    const root = el('div', { class: 'rag-panel' });
    const header = el('div', { class: 'rag-panel__head' }, [
      el('div', { class: 'rag-panel__title', text: options.title || 'Documentos' }),
      el('button', {
        class: 'rag-btn',
        type: 'button',
        text: 'Actualizar',
        onclick: () => loadDocuments(),
      }),
    ]);

    const list = el('div', { class: 'rag-list' });
    state.root = root;
    state.listEl = list;

    root.appendChild(header);
    root.appendChild(buildDropzone());
    root.appendChild(list);

    container.appendChild(root);
    render();
    loadDocuments();

    return root;
  }

  /* ─── API pública ───────────────────────────────────────────────────── */

  window.NumRagUI = {
    mount,
    handleFiles,
    loadDocuments,
    removeDocument,
    get state() { return state.items; },
    reset() {
      state.items = [];
      render();
    },
  };

  // Auto-montaje si el chat ya tiene el contenedor.
  document.addEventListener('DOMContentLoaded', () => {
    const target = document.getElementById('rag-dropzone') || document.getElementById('rag-panel');
    if (target) mount(target);
  });
})();
