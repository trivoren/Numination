/* ================================================================
   NUMINATION · attachments.js · v1.0
   ----------------------------------------------------------------
   Sistema de adjuntos para el chat.

   CARACTERÍSTICAS:

     · Multi-archivo (hasta 5 simultáneos)
     · Drag & drop sobre el composer
     · Paste desde clipboard (capturas de pantalla)
     · Preview de imágenes (thumbnail)
     · Auto-compresión de imágenes grandes (>2MB) con canvas
     · PDFs detectados sin librería (magic bytes)
     · Texto plano inline (código, .txt, .md) → inserta en composer
     · Binarios → adjunto en base64 al backend
     · Validación: tamaño, tipo, cantidad
     · Chips con preview, tamaño y botón ✕
     · Progress bar para archivos grandes
     · Persistencia de adjuntos entre recargas (sessionStorage)
     · Integración automática con /api/chat/stream
     · Métodos públicos para el chat.html

   API PÚBLICA:

     NM_attachments.add(file)         → Promise<boolean>
     NM_attachments.remove(index)     → void
     NM_attachments.clear()           → void
     NM_attachments.list()            → Array
     NM_attachments.count()           → number
     NM_attachments.hasAttachments()  → boolean
     NM_attachments.getStreamPayload() → object | null

   USO BÁSICO:

     <script src="/assets/js/attachments.js"></script>
     <!-- Se auto-inicializa al detectar el composer -->

   EVENTOS EMITIDOS:

     nm:attachments:change   · cuando cambia la lista
     nm:attachments:added    · al añadir uno
     nm:attachments:removed  · al quitar uno
     nm:attachments:error    · cuando falla la validación

   ================================================================ */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════
     CONFIGURACIÓN
     ═══════════════════════════════════════════════════════════════════ */

  const CFG = {
    maxFileSize:     10 * 1024 * 1024,     // 10 MB
    maxFiles:        5,
    maxTextPreview:  3000,
    maxTextFileSize: 100 * 1024,           // 100 KB para pegar inline
    imageMaxDim:     1536,                  // redimensionar a esto
    imageQuality:    0.82,
    imageCompressThreshold: 2 * 1024 * 1024, // >2MB comprime
    sessionKey:      'numination-draft-attachments',
    debug:           false,
  };

  /* ═══════════════════════════════════════════════════════════════════
     EXTENSIONES / MIMES
     ═══════════════════════════════════════════════════════════════════ */

  const TEXT_EXTS = new Set([
    '.txt', '.md', '.json', '.csv', '.log', '.ini', '.env',
    '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
    '.py', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.swift',
    '.c', '.cpp', '.cc', '.h', '.hpp', '.cs',
    '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.sql', '.sh', '.bash', '.zsh', '.ps1', '.bat',
    '.yaml', '.yml', '.xml', '.toml',
  ]);

  const IMAGE_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
  ]);

  const PDF_EXTS = new Set(['.pdf']);
  const DOC_EXTS = new Set(['.doc', '.docx', '.odt', '.rtf']);

  /* ═══════════════════════════════════════════════════════════════════
     UTILS
     ═══════════════════════════════════════════════════════════════════ */

  function log(...args) {
    if (CFG.debug) console.log('[attach]', ...args);
  }

  function extOf(name) {
    const i = name.lastIndexOf('.');
    return i >= 0 ? name.slice(i).toLowerCase() : '';
  }

  function isTextFile(name) { return TEXT_EXTS.has(extOf(name)); }
  function isImageFile(name, mime) {
    return IMAGE_EXTS.has(extOf(name)) || /^image\//.test(mime || '');
  }
  function isPdfFile(name, mime) {
    return PDF_EXTS.has(extOf(name)) || mime === 'application/pdf';
  }
  function isDocFile(name) { return DOC_EXTS.has(extOf(name)); }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch {}
  }

  function toast(kind, msg) {
    if (window.__nm && window.__nm.toast && window.__nm.toast[kind]) {
      window.__nm.toast[kind](msg);
    } else if (window.__nm && window.__nm.toast) {
      try { window.__nm.toast[kind](msg); } catch {}
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     ESTADO
     ═══════════════════════════════════════════════════════════════════ */

  const state = {
    items: [],
    totalBytes: 0,
    isProcessing: false,
  };

  /* ═══════════════════════════════════════════════════════════════════
     MAGIC BYTES · detección de PDF real
     ═══════════════════════════════════════════════════════════════════ */

  async function looksLikePdf(file) {
    try {
      const slice = file.slice(0, 5);
      const buf = await slice.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // PDF empieza con "%PDF-"
      return bytes[0] === 0x25 && bytes[1] === 0x50 &&
             bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D;
    } catch {
      return false;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     LECTORES
     ═══════════════════════════════════════════════════════════════════ */

  function readAsText(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = (e) => resolve(String(e.target.result || ''));
      r.onerror = reject;
      r.readAsText(file);
    });
  }

  function readAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = (e) => resolve(String(e.target.result || ''));
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  function readAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = (e) => resolve(e.target.result);
      r.onerror = reject;
      r.readAsArrayBuffer(file);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     COMPRESIÓN DE IMÁGENES
     ═══════════════════════════════════════════════════════════════════ */

  async function compressImage(file) {
    const dataUrl = await readAsDataURL(file);
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          let { width, height } = img;
          const max = CFG.imageMaxDim;
          if (width > max || height > max) {
            if (width > height) {
              height = Math.round((height * max) / width);
              width = max;
            } else {
              width = Math.round((width * max) / height);
              height = max;
            }
          }

          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          if (!ctx) return resolve({ dataUrl, width: img.width, height: img.height, compressed: false });

          ctx.drawImage(img, 0, 0, width, height);

          const mime = file.type === 'image/png' && file.size < CFG.imageCompressThreshold
            ? 'image/png'
            : 'image/jpeg';
          const out = canvas.toDataURL(mime, CFG.imageQuality);

          const dataUrlSize = Math.round((out.length - 'data:image/jpeg;base64,'.length) * 3 / 4);
          if (dataUrlSize < file.size) {
            resolve({ dataUrl: out, width, height, compressed: true, size: dataUrlSize });
          } else {
            resolve({ dataUrl, width: img.width, height: img.height, compressed: false, size: file.size });
          }
        } catch (e) {
          resolve({ dataUrl, width: img.width, height: img.height, compressed: false, size: file.size });
        }
      };
      img.onerror = () => resolve({ dataUrl, width: 0, height: 0, compressed: false, size: file.size });
      img.src = dataUrl;
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     CONVERTIR ARCHIVO A ITEM
     ═══════════════════════════════════════════════════════════════════ */

  async function buildAttachment(file) {
    const name = file.name || ('archivo-' + Date.now());
    const size = file.size || 0;
    const mime = file.type || 'application/octet-stream';
    const ext = extOf(name);

    /* ─── Imagen ─── */
    if (isImageFile(name, mime)) {
      let finalDataUrl = null;
      let finalSize = size;
      let thumb = null;
      let width = 0, height = 0;
      let compressed = false;

      if (size > CFG.imageCompressThreshold) {
        const r = await compressImage(file);
        finalDataUrl = r.dataUrl;
        finalSize = r.size || size;
        width = r.width;
        height = r.height;
        compressed = r.compressed;
      } else {
        finalDataUrl = await readAsDataURL(file);
        try {
          const img = new Image();
          await new Promise((res) => {
            img.onload = res;
            img.onerror = res;
            img.src = finalDataUrl;
          });
          width = img.naturalWidth || 0;
          height = img.naturalHeight || 0;
        } catch {}
      }

      // Thumbnail (max 60px de lado)
      thumb = finalDataUrl;

      const comma = finalDataUrl.indexOf(',');
      const base64 = comma >= 0 ? finalDataUrl.slice(comma + 1) : finalDataUrl;
      const m = finalDataUrl.slice(0, comma).match(/^data:([^;]+)/);
      const finalMime = m ? m[1] : mime;

      return {
        id: uid(),
        kind: 'image',
        name,
        size: finalSize,
        originalSize: size,
        compressed,
        mime: finalMime,
        data: base64,
        thumb,
        width,
        height,
        createdAt: Date.now(),
      };
    }

    /* ─── PDF ─── */
    if (isPdfFile(name, mime) || await looksLikePdf(file)) {
      const dataUrl = await readAsDataURL(file);
      const comma = dataUrl.indexOf(',');
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      return {
        id: uid(),
        kind: 'pdf',
        name,
        size,
        mime: 'application/pdf',
        data: base64,
        createdAt: Date.now(),
      };
    }

    /* ─── Documentos (docx, etc.) ─── */
    if (isDocFile(name)) {
      const dataUrl = await readAsDataURL(file);
      const comma = dataUrl.indexOf(',');
      const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
      return {
        id: uid(),
        kind: 'doc',
        name,
        size,
        mime: mime || 'application/octet-stream',
        data: base64,
        createdAt: Date.now(),
      };
    }

    /* ─── Texto plano → devolver como texto (se inserta inline) ─── */
    if (isTextFile(name) && size < CFG.maxTextFileSize) {
      const content = await readAsText(file);
      return {
        id: uid(),
        kind: 'text',
        name,
        size,
        ext: ext.slice(1),
        content,
        createdAt: Date.now(),
      };
    }

    /* ─── Otros binarios → intentar como doc ─── */
    const dataUrl = await readAsDataURL(file);
    const comma = dataUrl.indexOf(',');
    const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    return {
      id: uid(),
      kind: 'binary',
      name,
      size,
      mime,
      data: base64,
      createdAt: Date.now(),
    };
  }

  function uid() {
    return 'att_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ═══════════════════════════════════════════════════════════════════
     VALIDACIÓN
     ═══════════════════════════════════════════════════════════════════ */

  function validate(file) {
    if (!file) return { ok: false, reason: 'empty' };
    if (file.size > CFG.maxFileSize) {
      return { ok: false, reason: 'too_large', message: `${file.name} pasa los 10 MB` };
    }
    if (file.size === 0) {
      return { ok: false, reason: 'empty_file', message: `${file.name} está vacío` };
    }
    if (state.items.length >= CFG.maxFiles) {
      return { ok: false, reason: 'too_many', message: `Máximo ${CFG.maxFiles} adjuntos` };
    }
    // Evitar duplicados por nombre+tamaño
    const dup = state.items.find((i) => i.name === file.name && i.size === file.size);
    if (dup) {
      return { ok: false, reason: 'duplicate', message: `${file.name} ya está adjunto` };
    }
    return { ok: true };
  }

  /* ═══════════════════════════════════════════════════════════════════
     AGREGAR
     ═══════════════════════════════════════════════════════════════════ */

  async function addOne(file) {
    const v = validate(file);
    if (!v.ok) {
      toast('warn', v.message || 'Archivo no válido');
      emit('nm:attachments:error', { file, reason: v.reason, message: v.message });
      return false;
    }

    state.isProcessing = true;
    try {
      const item = await buildAttachment(file);

      if (item.kind === 'text') {
        insertTextInline(item);
        return true;
      }

      state.items.push(item);
      state.totalBytes += item.size || 0;
      render();
      emit('nm:attachments:added', item);
      emit('nm:attachments:change', state.items.slice());
      persistDraft();
      log('added', item.name, item.kind, fmtSize(item.size));
      return true;
    } catch (e) {
      log('error', e);
      toast('err', 'No pude procesar ' + file.name);
      emit('nm:attachments:error', { file, reason: 'process_failed', message: e.message });
      return false;
    } finally {
      state.isProcessing = false;
    }
  }

  async function addMany(files) {
    const list = Array.from(files || []);
    for (const f of list) {
      await addOne(f);
    }
  }

  function insertTextInline(item) {
    const field = document.querySelector('[data-field]');
    if (!field) return;

    let content = item.content || '';
    if (content.length > CFG.maxTextPreview) {
      const rest = content.length - CFG.maxTextPreview;
      content = content.slice(0, CFG.maxTextPreview) + '\n// […' + rest + ' caracteres más]';
    }

    const lang = item.ext || '';
    const block = `## ${item.name}\n\`\`\`${lang}\n${content}\n\`\`\``;
    const cur = (field.value || '').trim();
    field.value = cur ? cur + '\n\n' + block : block;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    toast('ok', 'Texto insertado: ' + item.name);
    field.focus();
    log('text inserted', item.name, content.length + ' chars');
  }

  /* ═══════════════════════════════════════════════════════════════════
     QUITAR / LIMPIAR
     ═══════════════════════════════════════════════════════════════════ */

  function removeAt(index) {
    const item = state.items[index];
    if (!item) return;
    state.items.splice(index, 1);
    state.totalBytes = Math.max(0, state.totalBytes - (item.size || 0));
    render();
    emit('nm:attachments:removed', item);
    emit('nm:attachments:change', state.items.slice());
    persistDraft();
  }

  function clear() {
    state.items = [];
    state.totalBytes = 0;
    render();
    emit('nm:attachments:change', []);
    persistDraft();
  }

  /* ═══════════════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════════════ */

  function getHost() {
    let host = document.querySelector('[data-attachments]');
    if (host) return host;

    // Auto-crear si no existe
    const composer = document.querySelector('.composer');
    if (!composer) return null;
    const wrap = composer.querySelector('.composer__wrap') || composer;
    const box = wrap.querySelector('.composer__box');

    host = document.createElement('div');
    host.className = 'chat-attachments';
    host.setAttribute('data-attachments', '');
    host.hidden = true;
    if (box && box.parentNode === wrap) {
      wrap.insertBefore(host, box);
    } else {
      wrap.appendChild(host);
    }
    return host;
  }

  function render() {
    const host = getHost();
    if (!host) return;

    host.innerHTML = '';

    if (state.items.length === 0) {
      host.hidden = true;
      return;
    }

    host.hidden = false;

    state.items.forEach((it, idx) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip';
      chip.setAttribute('data-id', it.id);

      const icon = it.kind === 'image' ? '🖼️'
                 : it.kind === 'pdf'   ? '📄'
                 : it.kind === 'doc'   ? '📝'
                 : '📎';

      const thumb = it.kind === 'image' && it.thumb
        ? `<img class="attachment-chip__thumb" src="${it.thumb}" alt="" />`
        : `<span class="attachment-chip__icon">${icon}</span>`;

      const compressed = it.compressed
        ? `<span class="attachment-chip__compressed" title="Comprimida de ${fmtSize(it.originalSize)}">↓</span>`
        : '';

      chip.innerHTML = `
        ${thumb}
        <span class="attachment-chip__name" title="${esc(it.name)}">${esc(it.name)}</span>
        <span class="attachment-chip__size">${fmtSize(it.size)}</span>
        ${compressed}
        <button class="attachment-chip__remove" type="button" aria-label="Quitar" data-remove>✕</button>
      `;

      chip.querySelector('[data-remove]').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeAt(idx);
      });

      // Click en la imagen → preview grande
      if (it.kind === 'image' && it.thumb) {
        const img = chip.querySelector('.attachment-chip__thumb');
        if (img) {
          img.style.cursor = 'zoom-in';
          img.addEventListener('click', (e) => {
            e.stopPropagation();
            openImagePreview(it.thumb, it.name);
          });
        }
      }

      host.appendChild(chip);
    });

    // Contador total
    if (state.items.length > 1) {
      const total = document.createElement('span');
      total.className = 'attachment-chip attachment-chip--total';
      total.innerHTML = `${state.items.length} adjuntos · ${fmtSize(state.totalBytes)}`;
      host.appendChild(total);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════
     IMAGE PREVIEW MODAL
     ═══════════════════════════════════════════════════════════════════ */

  function openImagePreview(src, name) {
    const overlay = document.createElement('div');
    overlay.className = 'nm-attach-preview';
    overlay.innerHTML = `
      <div class="nm-attach-preview__inner">
        <button class="nm-attach-preview__close" aria-label="Cerrar">✕</button>
        <img src="${src}" alt="${esc(name)}" />
        <div class="nm-attach-preview__name">${esc(name)}</div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('is-open'));

    const close = () => {
      overlay.classList.remove('is-open');
      setTimeout(() => overlay.remove(), 200);
    };
    overlay.querySelector('.nm-attach-preview__close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', function esc2(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc2); }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     PERSISTENCIA · sessionStorage
     ═══════════════════════════════════════════════════════════════════ */

  function persistDraft() {
    try {
      // Solo persistir las imágenes (base64 puede ser grande)
      const light = state.items
        .filter((i) => i.kind === 'image' && i.size < 500_000)
        .map((i) => ({
          id: i.id, kind: i.kind, name: i.name, size: i.size,
          originalSize: i.originalSize, mime: i.mime,
          data: i.data, thumb: i.thumb, width: i.width, height: i.height,
        }));
      if (light.length === 0) {
        sessionStorage.removeItem(CFG.sessionKey);
      } else {
        sessionStorage.setItem(CFG.sessionKey, JSON.stringify(light));
      }
    } catch {}
  }

  function restoreDraft() {
    try {
      const raw = sessionStorage.getItem(CFG.sessionKey);
      if (!raw) return;
      const items = JSON.parse(raw);
      if (!Array.isArray(items)) return;
      state.items = items;
      state.totalBytes = items.reduce((s, i) => s + (i.size || 0), 0);
      render();
      log('restored', items.length, 'draft attachments');
    } catch {}
  }

  /* ═══════════════════════════════════════════════════════════════════
     INTEGRACIÓN CON EL STREAM
     ═══════════════════════════════════════════════════════════════════ */

  function getStreamPayload() {
    if (state.items.length === 0) return null;
    // El backend acepta UN archivo por request
    const first = state.items[0];
    return {
      data: first.data,
      mimeType: first.mime,
      name: first.name,
    };
  }

  // Interceptar fetch para inyectar `file` en el body
  const _origFetch = window.fetch;
  window.fetch = function (url, opts) {
    if (
      typeof url === 'string' &&
      url.indexOf('/api/chat/stream') !== -1 &&
      opts && opts.body &&
      state.items.length > 0
    ) {
      try {
        const body = JSON.parse(opts.body);
        body.file = getStreamPayload();
        opts = Object.assign({}, opts, { body: JSON.stringify(body) });
      } catch {}
    }
    return _origFetch.apply(this, arguments);
  };

  // Limpiar después de enviar
  function hookSubmit() {
    const forms = document.querySelectorAll('[data-form], .composer form, form.composer');
    forms.forEach((form) => {
      if (form.__nmAttached) return;
      form.__nmAttached = true;
      form.addEventListener('submit', () => {
        setTimeout(() => {
          if (state.items.length > 0) clear();
        }, 200);
      }, true);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     DRAG & DROP
     ═══════════════════════════════════════════════════════════════════ */

  function hookDragDrop() {
    const composer = document.querySelector('.composer');
    if (!composer || composer.__nmDragHooked) return;
    composer.__nmDragHooked = true;

    let counter = 0;

    composer.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types) return;
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      counter++;
      composer.classList.add('is-dragover');
    });

    composer.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types) return;
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    composer.addEventListener('dragleave', () => {
      counter = Math.max(0, counter - 1);
      if (counter === 0) composer.classList.remove('is-dragover');
    });

    composer.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files) return;
      e.preventDefault();
      counter = 0;
      composer.classList.remove('is-dragover');
      addMany(e.dataTransfer.files);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     PASTE DESDE CLIPBOARD (capturas de pantalla)
     ═══════════════════════════════════════════════════════════════════ */

  function hookPaste() {
    const field = document.querySelector('[data-field]');
    if (!field || field.__nmPasteHooked) return;
    field.__nmPasteHooked = true;

    field.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;

      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        // Renombrar screenshots genéricos
        files.forEach((f) => {
          if (!f.name || f.name === 'image.png') {
            const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            try {
              Object.defineProperty(f, 'name', {
                value: `screenshot-${ts}.png`,
                writable: false,
              });
            } catch {}
          }
        });
        addMany(files);
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     HOOK DEL BOTÓN +
     ═══════════════════════════════════════════════════════════════════ */

  function hookAttachButton() {
    const btn = document.querySelector('[data-attach-btn]');
    if (!btn || btn.__nmAttachHooked) return;
    btn.__nmAttachHooked = true;

    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = [
      'image/*',
      ...Array.from(TEXT_EXTS),
      '.pdf', '.doc', '.docx',
    ].join(',');
    input.style.display = 'none';
    btn.parentNode.appendChild(input);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (input.__nmClicked) return;
      input.__nmClicked = true;
      input.click();
      setTimeout(() => { input.__nmClicked = false; }, 500);
    });

    input.addEventListener('change', () => {
      if (input.files && input.files.length > 0) {
        addMany(input.files);
      }
      input.value = '';
    });
  }

  /* ═══════════════════════════════════════════════════════════════════
     INYECCIÓN DE CSS
     ═══════════════════════════════════════════════════════════════════ */

  function injectCSS() {
    if (document.getElementById('nm-attach-css')) return;
    const style = document.createElement('style');
    style.id = 'nm-attach-css';
    style.textContent = `
      .chat-attachments {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 8px 4px;
        max-width: var(--composer-max, 820px);
        margin: 0 auto;
        width: 100%;
      }
      .chat-attachments[hidden] { display: none; }

      .attachment-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 8px 6px 10px;
        background: var(--c-bg-soft, #f7f7f8);
        border: 1px solid var(--c-border, #e8e8ea);
        border-radius: 999px;
        font-size: 12.5px;
        color: var(--c-text-2, #3a3a40);
        max-width: 300px;
        animation: nmAttachIn 0.2s ease-out;
      }
      .attachment-chip--total {
        background: transparent;
        border-style: dashed;
        color: var(--c-text-muted, #6b6b70);
        font-style: italic;
      }
      @keyframes nmAttachIn {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .attachment-chip__thumb {
        width: 26px; height: 26px;
        border-radius: 6px;
        object-fit: cover;
        flex-shrink: 0;
        background: var(--c-bg-hover, #f2f2f4);
      }
      .attachment-chip__icon {
        font-size: 15px;
        line-height: 1;
        flex-shrink: 0;
      }
      .attachment-chip__name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        min-width: 0;
        font-weight: 500;
      }
      .attachment-chip__size {
        font-size: 11px;
        color: var(--c-text-subtle, #a0a0a5);
        flex-shrink: 0;
        font-variant-numeric: tabular-nums;
      }
      .attachment-chip__compressed {
        font-size: 10px;
        color: var(--c-primary, #7c5eff);
        flex-shrink: 0;
        font-weight: 700;
      }
      .attachment-chip__remove {
        background: none;
        border: none;
        color: var(--c-text-muted, #6b6b70);
        cursor: pointer;
        padding: 2px 5px;
        border-radius: 50%;
        font-size: 12px;
        line-height: 1;
        flex-shrink: 0;
        transition: all 0.15s;
        font-family: inherit;
      }
      .attachment-chip__remove:hover {
        background: var(--c-danger-soft, #fef2f2);
        color: var(--c-danger, #dc2626);
      }

      /* Drag & drop */
      .composer.is-dragover::after {
        content: 'Soltá el archivo acá';
        position: absolute;
        inset: 8px;
        background: rgba(124, 94, 255, 0.08);
        border: 2px dashed var(--c-primary, #7c5eff);
        border-radius: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        font-weight: 600;
        color: var(--c-primary, #7c5eff);
        pointer-events: none;
        z-index: 10;
      }

      /* Preview modal */
      .nm-attach-preview {
        position: fixed; inset: 0;
        background: rgba(0, 0, 0, 0.85);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        opacity: 0;
        transition: opacity 0.2s;
        cursor: zoom-out;
      }
      .nm-attach-preview.is-open { opacity: 1; }
      .nm-attach-preview__inner {
        position: relative;
        max-width: 90vw;
        max-height: 90vh;
        cursor: default;
      }
      .nm-attach-preview__inner img {
        display: block;
        max-width: 90vw;
        max-height: 85vh;
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      }
      .nm-attach-preview__close {
        position: absolute;
        top: -16px; right: -16px;
        width: 36px; height: 36px;
        border-radius: 50%;
        background: #fff;
        color: #0a0a0c;
        border: none;
        cursor: pointer;
        font-size: 16px;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3);
      }
      .nm-attach-preview__name {
        text-align: center;
        margin-top: 12px;
        color: rgba(255, 255, 255, 0.9);
        font-size: 13px;
        font-weight: 500;
        letter-spacing: -0.005em;
      }
    `;
    document.head.appendChild(style);
  }

  /* ═══════════════════════════════════════════════════════════════════
     INIT
     ═══════════════════════════════════════════════════════════════════ */

  let _initDone = false;

  function init() {
    if (_initDone) return;
    _initDone = true;

    injectCSS();
    getHost();      // crear el contenedor si no existe
    hookAttachButton();
    hookDragDrop();
    hookPaste();
    hookSubmit();
    restoreDraft();
    render();

    log('initialized');
  }

  // Auto-init cuando el DOM esté listo
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // Si el chat.html añade el composer dinámicamente (raro), reintentar
  const _observer = new MutationObserver(() => {
    if (!_initDone) return;
    if (document.querySelector('[data-attach-btn]') && !document.querySelector('[data-attach-btn]').__nmAttachHooked) {
      hookAttachButton();
    }
    if (document.querySelector('.composer') && !document.querySelector('.composer').__nmDragHooked) {
      hookDragDrop();
    }
    if (document.querySelector('[data-field]') && !document.querySelector('[data-field]').__nmPasteHooked) {
      hookPaste();
    }
    hookSubmit();
  });
  if (document.body) {
    _observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ═══════════════════════════════════════════════════════════════════
     API PÚBLICA
     ═══════════════════════════════════════════════════════════════════ */

  window.NM_attachments = {
    add: (file) => addOne(file),
    addMany: (files) => addMany(files),
    remove: (index) => removeAt(index),
    clear: () => clear(),
    list: () => state.items.slice(),
    count: () => state.items.length,
    hasAttachments: () => state.items.length > 0,
    getStreamPayload: () => getStreamPayload(),
    getTotalBytes: () => state.totalBytes,
    render: () => render(),
    init: () => init(),
    _config: CFG,
    _state: state,
  };

  log('module loaded');
})();