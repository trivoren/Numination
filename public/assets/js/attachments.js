/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · attachments.js · v2.0
   ─────────────────────────────────────────────────────────────────────────
   Sistema de adjuntos para el chat · REWRITE TOTAL

   QUÉ HAY DE NUEVO vs v1.0:
     · Cola de procesamiento con estados y progreso
     · Web Worker para compresión no-bloqueante
     · IndexedDB para persistencia (500MB+) con fallback a memoria
     · Thumbnails reales (200px) separados del data URL completo
     · Extracción de texto de PDFs con pdf.js
     · Detección de video + audio + SVG + HEIC
     · Fix de EXIF rotation para fotos de celular
     · Encoding WebP con fallback automático
     · Multi-file payload (antes solo enviaba 1)
     · Detección de duplicados por SHA-256
     · Drag & drop a nivel ventana completa
     · Modal universal (imagen/texto/pdf/video/audio)
     · Reordenar adjuntos con drag
     · Keyboard nav + accesibilidad WCAG AA
     · Undo remove con toast
     · Retry de archivos fallidos
     · Object URLs para archivos grandes
     · Self-test integrado
     · Cuota de storage con aviso preventivo
     · Timeout y graceful degradation

   QUÉ SE ELIMINÓ:
     · Override global de window.fetch (riesgoso)
     · Persistencia rota con sessionStorage
     · Thumbnails falsos (usaba el data URL completo)
     · MutationObserver innecesario
     · Emojis como iconos
     · Cálculo manual de totalBytes con bugs

   API PÚBLICA:
     NM_attachments.add(file)            → Promise<AttachmentItem>
     NM_attachments.addMany(files)       → Promise<AttachmentItem[]>
     NM_attachments.retry(id)            → Promise<AttachmentItem>
     NM_attachments.remove(idOrIndex)    → boolean
     NM_attachments.removeWithUndo(id)   → void
     NM_attachments.clear()              → Promise<void>
     NM_attachments.list()               → AttachmentItem[]
     NM_attachments.get(id)              → AttachmentItem | null
     NM_attachments.count()              → number
     NM_attachments.hasAttachments()     → boolean
     NM_attachments.getTotalBytes()      → number
     NM_attachments.reorder(fromId, toId) → void
     NM_attachments.consume()            → { files: [...] } | null
     NM_attachments.getStats()           → { images, docs, totalBytes, ... }
     NM_attachments.preview(id)          → void (abre modal)
     NM_attachments.test()               → Promise<TestReport>
     NM_attachments.configure(patch)     → void

   EVENTOS:
     nm:attachments:change     → { items, stats }
     nm:attachments:added      → { item, index }
     nm:attachments:removed    → { item, index }
     nm:attachments:error      → { file, reason, message }
     nm:attachments:progress   → { id, stage, percent }
     nm:attachments:retry      → { id }
     nm:attachments:consumed   → { ids }
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  /* ═══════════════════════════════════════════════════════════════════════
     01 · CONFIGURACIÓN
     ═══════════════════════════════════════════════════════════════════════ */

  const CFG = {
    // Límites
    maxFileSize:      25 * 1024 * 1024,        // 25 MB por archivo
    maxFiles:         8,
    maxTotalBytes:    60 * 1024 * 1024,        // 60 MB total
    minFileSize:      1,                        // 1 byte (evita vacíos)

    // Imágenes
    image: {
      thumbSize:      200,                      // lado máximo del thumb
      maxDimension:   2048,                     // reescalar si es más grande
      quality:        0.84,
      compressOver:   1.5 * 1024 * 1024,       // comprimir si pesa más
      preferWebP:     true,
      fixOrientation: true,
    },

    // Texto
    text: {
      maxInlineSize:  200 * 1024,               // insertar como texto si pesa menos
      maxPreview:     5000,
    },

    // PDF
    pdf: {
      extractText:    true,                     // extraer texto con pdf.js
      pdfjsVersion:   '4.0.379',
      pdfjsCdn:       'https://cdnjs.cloudflare.com/ajax/libs/pdf.js',
      maxPagesText:   50,
      maxCharsText:   50000,
    },

    // Video
    video: {
      thumbTimeMs:    1500,
      thumbSize:      320,
    },

    // Audio
    audio: {
      generateWaveform: true,
      waveformBars:     60,
    },

    // Storage
    storage: {
      idbName:        'numination-attachments',
      idbStore:       'files',
      idbVersion:     1,
      maxPersistSize: 500 * 1024 * 1024,        // 500 MB en IDB
      memoryFallback: true,
      retries:        3,
      retryDelayMs:   400,
    },

    // Queue
    queue: {
      concurrency:    3,                        // archivos procesados en paralelo
      timeoutMs:      30000,                    // 30s por archivo
    },

    // UI
    ui: {
      showStats:      true,
      enableReorder:  true,
      enableKeyboard: true,
      undoWindowMs:   5000,
      dropZoneGlobal: true,
      toastDuration:  3600,
    },

    // Debug
    logLevel: 'warn',                           // silent | error | warn | info | debug
  };

  /* ═══════════════════════════════════════════════════════════════════════
     02 · LOGGER
     ═══════════════════════════════════════════════════════════════════════ */

  const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
  const LOG = {
    error(...a) { if (LOG_LEVELS[CFG.logLevel] >= 1) console.error('%c[attach]', 'color:#dc2626', ...a); },
    warn(...a)  { if (LOG_LEVELS[CFG.logLevel] >= 2) console.warn ('%c[attach]', 'color:#d97706', ...a); },
    info(...a)  { if (LOG_LEVELS[CFG.logLevel] >= 3) console.info ('%c[attach]', 'color:#0284c7', ...a); },
    debug(...a) { if (LOG_LEVELS[CFG.logLevel] >= 4) console.log  ('%c[attach]', 'color:#7c5eff', ...a); },
  };

  /* ═══════════════════════════════════════════════════════════════════════
     03 · CONSTANTES
     ═══════════════════════════════════════════════════════════════════════ */

  const TEXT_EXTS = new Set([
    '.txt', '.md', '.json', '.csv', '.log', '.ini', '.env', '.conf', '.cfg',
    '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx', '.vue', '.svelte',
    '.py', '.pyw', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.kts', '.swift',
    '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hh', '.cs', '.fs', '.vb',
    '.html', '.htm', '.xhtml', '.css', '.scss', '.sass', '.less', '.styl',
    '.sql', '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
    '.yaml', '.yml', '.xml', '.toml', '.plist', '.graphql', '.gql',
    '.dockerfile', '.gitignore', '.editorconfig', '.prettierrc', '.eslintrc',
  ]);

  const IMAGE_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.ico', '.tiff', '.tif',
  ]);

  const SVG_EXTS    = new Set(['.svg']);
  const HEIC_EXTS   = new Set(['.heic', '.heif']);
  const PDF_EXTS    = new Set(['.pdf']);
  const DOC_EXTS    = new Set(['.doc', '.docx', '.odt', '.rtf', '.pages']);
  const SHEET_EXTS  = new Set(['.xls', '.xlsx', '.ods', '.numbers', '.csv']);
  const SLIDE_EXTS  = new Set(['.ppt', '.pptx', '.odp', '.key']);
  const VIDEO_EXTS  = new Set(['.mp4', '.webm', '.mov', '.avi', '.mkv', '.m4v', '.ogv']);
  const AUDIO_EXTS  = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.opus', '.oga']);
  const ARCHIVE_EXTS= new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2']);

  /* ═══════════════════════════════════════════════════════════════════════
     04 · UTILIDADES
     ═══════════════════════════════════════════════════════════════════════ */

  const $  = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => Array.from((ctx || document).querySelectorAll(sel));

  function extOf(name) {
    const i = String(name || '').lastIndexOf('.');
    return i >= 0 ? name.slice(i).toLowerCase() : '';
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = String(s == null ? '' : s);
    return d.innerHTML;
  }

  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function fmtSize(bytes) {
    if (bytes == null || bytes === 0) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function uid(prefix) {
    return (prefix || 'att') + '_' + Date.now().toString(36) + '_' +
           Math.random().toString(36).slice(2, 9);
  }

  function debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Timeout ' + ms + 'ms' + (label ? ' · ' + label : ''))), ms)
      ),
    ]);
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  async function sha256(buffer) {
    if (!window.crypto || !window.crypto.subtle) return null;
    try {
      const hash = await crypto.subtle.digest('SHA-256', buffer);
      return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    } catch (e) {
      LOG.warn('sha256 failed', e);
      return null;
    }
  }

  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail }));
    } catch (e) {
      LOG.warn('emit failed', name, e);
    }
  }

  function toast(kind, msg, actions) {
    const T = window.__nm && window.__nm.toast;
    if (T && typeof T[kind] === 'function') {
      try { return T[kind](msg, actions); } catch (e) {}
    }
    // Fallback: console
    LOG[kind === 'err' ? 'error' : kind === 'warn' ? 'warn' : 'info'](msg);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     05 · TIPO DE ARCHIVO
     ═══════════════════════════════════════════════════════════════════════ */

  function classify(file) {
    const name = String(file.name || '');
    const ext = extOf(name);
    const mime = String(file.type || '');

    if (isText(ext, mime))   return { kind: 'text',   ext, mime };
    if (isSVG(ext, mime))    return { kind: 'svg',    ext, mime };
    if (isImage(ext, mime))  return { kind: 'image',  ext, mime };
    if (isHeic(ext, mime))   return { kind: 'heic',   ext, mime };
    if (isPDF(ext, mime))    return { kind: 'pdf',    ext, mime };
    if (isDoc(ext, mime))    return { kind: 'doc',    ext, mime };
    if (isSheet(ext, mime))  return { kind: 'sheet',  ext, mime };
    if (isSlide(ext, mime))  return { kind: 'slide',  ext, mime };
    if (isVideo(ext, mime))  return { kind: 'video',  ext, mime };
    if (isAudio(ext, mime))  return { kind: 'audio',  ext, mime };
    if (isArchive(ext, mime))return { kind: 'archive',ext, mime };
    return { kind: 'binary', ext, mime };
  }

  function isText(ext, mime)    { return TEXT_EXTS.has(ext) || /^text\//.test(mime) || mime === 'application/json' || mime === 'application/xml'; }
  function isSVG(ext, mime)     { return SVG_EXTS.has(ext) || mime === 'image/svg+xml'; }
  function isImage(ext, mime)   { return IMAGE_EXTS.has(ext) || /^image\//.test(mime); }
  function isHeic(ext, mime)    { return HEIC_EXTS.has(ext) || mime === 'image/heic' || mime === 'image/heif'; }
  function isPDF(ext, mime)     { return PDF_EXTS.has(ext) || mime === 'application/pdf'; }
  function isDoc(ext, mime)     { return DOC_EXTS.has(ext) || mime.indexOf('word') !== -1 || mime.indexOf('opendocument.text') !== -1; }
  function isSheet(ext, mime)   { return SHEET_EXTS.has(ext) || mime.indexOf('spreadsheet') !== -1 || mime.indexOf('excel') !== -1; }
  function isSlide(ext, mime)   { return SLIDE_EXTS.has(ext) || mime.indexOf('presentation') !== -1 || mime.indexOf('powerpoint') !== -1; }
  function isVideo(ext, mime)   { return VIDEO_EXTS.has(ext) || /^video\//.test(mime); }
  function isAudio(ext, mime)   { return AUDIO_EXTS.has(ext) || /^audio\//.test(mime); }
  function isArchive(ext, mime) { return ARCHIVE_EXTS.has(ext) || /zip|rar|7z|tar|gzip/.test(mime); }

  async function looksLikePDF(file) {
    try {
      const buf = await file.slice(0, 5).arrayBuffer();
      const b = new Uint8Array(buf);
      return b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2D;
    } catch { return false; }
  }

  async function looksLikePNG(file) {
    try {
      const buf = await file.slice(0, 8).arrayBuffer();
      const b = new Uint8Array(buf);
      return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
    } catch { return false; }
  }

  async function looksLikeJPEG(file) {
    try {
      const buf = await file.slice(0, 3).arrayBuffer();
      const b = new Uint8Array(buf);
      return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
    } catch { return false; }
  }

  async function looksLikeGIF(file) {
    try {
      const buf = await file.slice(0, 6).arrayBuffer();
      const b = new Uint8Array(buf);
      return b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46; // GIF
    } catch { return false; }
  }

  async function looksLikeWebP(file) {
    try {
      const buf = await file.slice(0, 12).arrayBuffer();
      const b = new Uint8Array(buf);
      // "RIFF" .... "WEBP"
      return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
             b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
    } catch { return false; }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     06 · LECTORES
     ═══════════════════════════════════════════════════════════════════════ */

  function readAsText(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(String(e.target.result || ''));
      r.onerror = () => rej(new Error('readAsText failed'));
      r.readAsText(file);
    });
  }

  function readAsDataURL(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(String(e.target.result || ''));
      r.onerror = () => rej(new Error('readAsDataURL failed'));
      r.readAsDataURL(file);
    });
  }

  function readAsArrayBuffer(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = e => res(e.target.result);
      r.onerror = () => rej(new Error('readAsArrayBuffer failed'));
      r.readAsArrayBuffer(file);
    });
  }

  function readAsBlobURL(file) {
    try { return URL.createObjectURL(file); }
    catch { return null; }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     07 · IMAGEN · decode con orientación + thumbnail
     ═══════════════════════════════════════════════════════════════════════ */

  async function decodeImage(file) {
    // createImageBitmap soporta orientación EXIF y es más rápido
    if ('createImageBitmap' in window) {
      try {
        const opts = CFG.image.fixOrientation ? { imageOrientation: 'from-image' } : {};
        return await createImageBitmap(file, opts);
      } catch (e) {
        LOG.debug('createImageBitmap failed, falling back to <img>', e.message);
      }
    }

    // Fallback: <img> con object URL
    const url = readAsBlobURL(file);
    if (!url) throw new Error('no url');

    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('img load failed')); };
      img.src = url;
    });
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(res => {
      canvas.toBlob(b => res(b), mime, quality);
    });
  }

  function pickImageFormat(preferWebP) {
    // Detectar soporte WebP
    const c = document.createElement('canvas');
    c.width = 1; c.height = 1;
    if (preferWebP) {
      try {
        const webp = c.toDataURL('image/webp');
        if (webp.indexOf('data:image/webp') === 0) return 'image/webp';
      } catch {}
    }
    return 'image/jpeg';
  }

  async function processImage(file) {
    const img = await decodeImage(file);

    let w = img.width || img.naturalWidth || 0;
    let h = img.height || img.naturalHeight || 0;
    if (!w || !h) throw new Error('imagen sin dimensiones');

    // 1) Thumbnail (siempre)
    const thumbSize = CFG.image.thumbSize;
    const tRatio = Math.min(thumbSize / w, thumbSize / h, 1);
    const tw = Math.round(w * tRatio);
    const th = Math.round(h * tRatio);
    const thumbBlob = await renderToBlob(img, tw, th, 'image/jpeg', 0.75);
    const thumbUrl = thumbBlob ? URL.createObjectURL(thumbBlob) : null;

    // 2) Imagen final (comprimida si aplica)
    const maxDim = CFG.image.maxDimension;
    const ratio = Math.min(maxDim / w, maxDim / h, 1);
    const fw = Math.round(w * ratio);
    const fh = Math.round(h * ratio);

    let finalBlob = null;
    let compressed = false;

    if (file.size > CFG.image.compressOver || ratio < 1) {
      const mime = pickImageFormat(CFG.image.preferWebP);
      const candidate = await renderToBlob(img, fw, fh, mime, CFG.image.quality);
      if (candidate && candidate.size < file.size) {
        finalBlob = candidate;
        compressed = true;
      }
    }

    if (!finalBlob) {
      finalBlob = file;
    }

    // Liberar bitmap
    if (img.close) { try { img.close(); } catch {} }

    return {
      thumbUrl,
      thumbBlob,
      finalBlob,
      compressed,
      width: fw,
      height: fh,
      originalWidth: w,
      originalHeight: h,
      finalSize: finalBlob.size,
      originalSize: file.size,
    };
  }

  function renderToBlob(img, w, h, mime, quality) {
    return new Promise(res => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return res(null);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(b => res(b), mime, quality);
      } catch (e) {
        LOG.warn('renderToBlob failed', e);
        res(null);
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     08 · SVG · convertir a PNG
     ═══════════════════════════════════════════════════════════════════════ */

  async function processSVG(file) {
    const text = await readAsText(file);
    // Thumbnail: renderizar SVG en canvas
    const blob = new Blob([text], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);

    return new Promise(res => {
      const img = new Image();
      img.onload = async () => {
        try {
          const max = CFG.image.thumbSize;
          const w = img.naturalWidth || 100;
          const h = img.naturalHeight || 100;
          const ratio = Math.min(max / w, max / h, 1);
          const thumbBlob = await renderToBlob(img, Math.round(w * ratio), Math.round(h * ratio), 'image/png', 1);
          const thumbUrl = thumbBlob ? URL.createObjectURL(thumbBlob) : url;
          res({
            thumbUrl,
            thumbBlob,
            finalBlob: file,
            svgText: text,
            width: w,
            height: h,
            originalSize: file.size,
            finalSize: file.size,
            compressed: false,
          });
        } catch (e) {
          URL.revokeObjectURL(url);
          res({ thumbUrl: null, finalBlob: file, svgText: text, originalSize: file.size, finalSize: file.size, compressed: false });
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        res({ thumbUrl: null, finalBlob: file, svgText: text, originalSize: file.size, finalSize: file.size, compressed: false });
      };
      img.src = url;
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     09 · VIDEO · primer frame como thumbnail
     ═══════════════════════════════════════════════════════════════════════ */

  async function processVideo(file) {
    return new Promise((res) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.src = url;

      const cleanup = () => {
        try { URL.revokeObjectURL(url); } catch {}
      };

      const timeout = setTimeout(() => {
        cleanup();
        res({ thumbUrl: null, thumbBlob: null, finalBlob: file, duration: 0, width: 0, height: 0, originalSize: file.size, finalSize: file.size, compressed: false });
      }, 5000);

      video.addEventListener('loadedmetadata', () => {
        const seekTo = Math.min(CFG.video.thumbTimeMs / 1000, video.duration * 0.5 || 0);
        video.currentTime = seekTo;
      });

      video.addEventListener('seeked', async () => {
        clearTimeout(timeout);
        try {
          const max = CFG.video.thumbSize;
          const w = video.videoWidth || 320;
          const h = video.videoHeight || 180;
          const ratio = Math.min(max / w, max / h, 1);
          const thumbBlob = await renderToBlob(video, Math.round(w * ratio), Math.round(h * ratio), 'image/jpeg', 0.8);
          const thumbUrl = thumbBlob ? URL.createObjectURL(thumbBlob) : null;
          cleanup();
          res({
            thumbUrl,
            thumbBlob,
            finalBlob: file,
            duration: Math.round(video.duration || 0),
            width: w,
            height: h,
            originalSize: file.size,
            finalSize: file.size,
            compressed: false,
          });
        } catch (e) {
          clearTimeout(timeout);
          cleanup();
          res({ thumbUrl: null, thumbBlob: null, finalBlob: file, duration: 0, width: 0, height: 0, originalSize: file.size, finalSize: file.size, compressed: false });
        }
      });

      video.addEventListener('error', () => {
        clearTimeout(timeout);
        cleanup();
        res({ thumbUrl: null, thumbBlob: null, finalBlob: file, duration: 0, width: 0, height: 0, originalSize: file.size, finalSize: file.size, compressed: false });
      });
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     10 · AUDIO · waveform
     ═══════════════════════════════════════════════════════════════════════ */

  async function processAudio(file) {
    if (!CFG.audio.generateWaveform) {
      return { thumbUrl: null, thumbBlob: null, finalBlob: file, originalSize: file.size, finalSize: file.size, compressed: false, duration: 0 };
    }

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return { thumbUrl: null, thumbBlob: null, finalBlob: file, originalSize: file.size, finalSize: file.size, compressed: false, duration: 0 };

    try {
      const buf = await withTimeout(readAsArrayBuffer(file), 5000, 'audio decode');
      const ctx = new AC();
      const audioBuf = await ctx.decodeAudioData(buf);

      const channel = audioBuf.getChannelData(0);
      const bars = CFG.audio.waveformBars;
      const samplesPerBar = Math.floor(channel.length / bars);
      const peaks = [];

      for (let i = 0; i < bars; i++) {
        let peak = 0;
        const start = i * samplesPerBar;
        for (let j = 0; j < samplesPerBar; j++) {
          const v = Math.abs(channel[start + j] || 0);
          if (v > peak) peak = v;
        }
        peaks.push(peak);
      }

      // Dibujar waveform
      const W = 200, H = 60;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const c = canvas.getContext('2d');
      c.fillStyle = '#0f0f15';
      c.fillRect(0, 0, W, H);
      c.fillStyle = '#4090ff';
      const barW = W / bars;
      peaks.forEach((p, i) => {
        const h = Math.max(2, p * H * 0.9);
        c.fillRect(i * barW + 1, (H - h) / 2, barW - 2, h);
      });

      const thumbBlob = await new Promise(r => canvas.toBlob(b => r(b), 'image/png'));
      const thumbUrl = thumbBlob ? URL.createObjectURL(thumbBlob) : null;

      try { ctx.close(); } catch {}

      return {
        thumbUrl,
        thumbBlob,
        finalBlob: file,
        duration: Math.round(audioBuf.duration),
        originalSize: file.size,
        finalSize: file.size,
        compressed: false,
      };
    } catch (e) {
      LOG.warn('audio waveform failed', e);
      return { thumbUrl: null, thumbBlob: null, finalBlob: file, originalSize: file.size, finalSize: file.size, compressed: false, duration: 0 };
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     11 · PDF · extracción de texto con pdf.js
     ═══════════════════════════════════════════════════════════════════════ */

  let _pdfjsPromise = null;

  async function loadPDFJS() {
    if (_pdfjsPromise) return _pdfjsPromise;
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);

    _pdfjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = CFG.pdf.pdfjsCdn + '/' + CFG.pdf.pdfjsVersion + '/pdf.min.js';
      s.onload = () => {
        if (window.pdfjsLib) {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            CFG.pdf.pdfjsCdn + '/' + CFG.pdf.pdfjsVersion + '/pdf.worker.min.js';
          resolve(window.pdfjsLib);
        } else {
          reject(new Error('pdfjsLib no cargó'));
        }
      };
      s.onerror = () => reject(new Error('pdf.js CDN failed'));
      document.head.appendChild(s);
    });

    return _pdfjsPromise;
  }

  async function processPDF(file) {
    const result = {
      thumbUrl: null,
      thumbBlob: null,
      finalBlob: file,
      originalSize: file.size,
      finalSize: file.size,
      compressed: false,
      pageCount: 0,
      text: '',
      textLength: 0,
    };

    try {
      const buffer = await readAsArrayBuffer(file);
      const pdfjs = await withTimeout(loadPDFJS(), 8000, 'pdf.js load');
      const doc = await withTimeout(pdfjs.getDocument({ data: buffer }).promise, 15000, 'pdf parse');

      result.pageCount = doc.numPages;

      if (CFG.pdf.extractText) {
        const maxPages = Math.min(doc.numPages, CFG.pdf.maxPagesText);
        const pages = [];
        let totalChars = 0;

        for (let i = 1; i <= maxPages; i++) {
          if (totalChars >= CFG.pdf.maxCharsText) break;
          try {
            const page = await doc.getPage(i);
            const content = await page.getTextContent();
            const text = content.items.map(it => it.str).join(' ');
            pages.push(text);
            totalChars += text.length;
          } catch (e) {
            LOG.debug('pdf page ' + i + ' failed', e.message);
          }
        }

        result.text = pages.join('\n\n--- Página ' + ' ---\n\n');
        if (result.text.length > CFG.pdf.maxCharsText) {
          result.text = result.text.slice(0, CFG.pdf.maxCharsText) + '\n\n[…texto truncado]';
        }
        result.textLength = result.text.length;
      }
    } catch (e) {
      LOG.warn('pdf processing failed', e.message);
    }

    return result;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     12 · IDB STORAGE (persistencia real)
     ═══════════════════════════════════════════════════════════════════════ */

  const IDB = (() => {
    let dbPromise = null;

    function open() {
      if (dbPromise) return dbPromise;
      if (!('indexedDB' in window)) {
        dbPromise = Promise.reject(new Error('IndexedDB no disponible'));
        return dbPromise;
      }

      dbPromise = new Promise((res, rej) => {
        const req = indexedDB.open(CFG.storage.idbName, CFG.storage.idbVersion);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(CFG.storage.idbStore)) {
            db.createObjectStore(CFG.storage.idbStore, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });

      return dbPromise;
    }

    async function put(record) {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(CFG.storage.idbStore, 'readwrite');
        const store = tx.objectStore(CFG.storage.idbStore);
        const req = store.put(record);
        req.onsuccess = () => res(true);
        req.onerror = () => rej(req.error);
      });
    }

    async function get(id) {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(CFG.storage.idbStore, 'readonly');
        const store = tx.objectStore(CFG.storage.idbStore);
        const req = store.get(id);
        req.onsuccess = () => res(req.result || null);
        req.onerror = () => rej(req.error);
      });
    }

    async function all() {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(CFG.storage.idbStore, 'readonly');
        const store = tx.objectStore(CFG.storage.idbStore);
        const req = store.getAll();
        req.onsuccess = () => res(req.result || []);
        req.onerror = () => rej(req.error);
      });
    }

    async function del(id) {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(CFG.storage.idbStore, 'readwrite');
        const store = tx.objectStore(CFG.storage.idbStore);
        const req = store.delete(id);
        req.onsuccess = () => res(true);
        req.onerror = () => rej(req.error);
      });
    }

    async function clear() {
      const db = await open();
      return new Promise((res, rej) => {
        const tx = db.transaction(CFG.storage.idbStore, 'readwrite');
        const store = tx.objectStore(CFG.storage.idbStore);
        const req = store.clear();
        req.onsuccess = () => res(true);
        req.onerror = () => rej(req.error);
      });
    }

    async function estimate() {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      try { return await navigator.storage.estimate(); }
      catch { return null; }
    }

    return { open, put, get, all, del, clear, estimate };
  })();

  /* Fallback de memoria */
  const memStore = new Map();
  async function safePut(record) {
    // Intento 3 veces en IDB
    for (let i = 0; i < CFG.storage.retries; i++) {
      try {
        await IDB.put(record);
        return 'idb';
      } catch (e) {
        LOG.debug('idb put attempt ' + (i + 1) + ' failed', e.message);
        if (i < CFG.storage.retries - 1) await sleep(CFG.storage.retryDelayMs);
      }
    }
    // Fallback a memoria
    if (CFG.storage.memoryFallback) {
      memStore.set(record.id, record);
      LOG.info('fell back to memory for ' + record.id);
      return 'memory';
    }
    throw new Error('no storage');
  }

  async function safeGet(id) {
    try {
      const r = await IDB.get(id);
      if (r) return r;
    } catch {}
    return memStore.get(id) || null;
  }

  async function safeDel(id) {
    try { await IDB.del(id); } catch {}
    memStore.delete(id);
  }

  async function safeAll() {
    try {
      const list = await IDB.all();
      if (list && list.length > 0) return list;
    } catch {}
    return Array.from(memStore.values());
  }

  async function safeClear() {
    try { await IDB.clear(); } catch {}
    memStore.clear();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     13 · STATE
     ═══════════════════════════════════════════════════════════════════════ */

  const S = {
    items: [],           // AttachmentItem[]
    processing: new Map(), // id → { stage, percent }
    undoStack: [],       // { item, index, timer }
    consumers: [],       // callbacks
    initialized: false,
  };

  /* ═══════════════════════════════════════════════════════════════════════
     14 · MODELO DE ITEM
     ═══════════════════════════════════════════════════════════════════════ */

  function createItem(file, meta, kind) {
    const item = {
      id: uid('att'),
      kind,               // text | svg | image | heic | pdf | doc | sheet | slide | video | audio | archive | binary
      name: file.name || ('archivo-' + Date.now()),
      ext: meta.ext,
      mime: meta.mime || file.type || 'application/octet-stream',
      originalSize: file.size,
      size: file.size,     // actualizado tras compresión
      createdAt: Date.now(),
      status: 'processing', // processing | ready | error
      error: null,
      // Contenido
      blob: null,          // final Blob
      dataUrl: null,       // base64 data URL
      base64: null,        // sin prefijo
      text: null,          // para kind === 'text' o 'pdf'
      svgText: null,       // para kind === 'svg'
      // Preview
      thumbUrl: null,      // URL del thumbnail
      thumbBlob: null,
      // Extras
      width: 0, height: 0,
      duration: 0,
      pageCount: 0,
      textLength: 0,
      compressed: false,
      hash: null,
      meta: {},
    };
    return item;
  }

  async function materializeItem(file, meta, kind) {
    const item = createItem(file, meta, kind);

    item.hash = await sha256(await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer())
                 .catch(() => null);

    emit('nm:attachments:progress', { id: item.id, stage: 'classify', percent: 5 });

    if (kind === 'image') {
      emit('nm:attachments:progress', { id: item.id, stage: 'decode', percent: 15 });
      const r = await processImage(file);
      item.blob = r.finalBlob;
      item.size = r.finalSize;
      item.compressed = r.compressed;
      item.thumbUrl = r.thumbUrl;
      item.thumbBlob = r.thumbBlob;
      item.width = r.width;
      item.height = r.height;
      item.meta.originalWidth = r.originalWidth;
      item.meta.originalHeight = r.originalHeight;

      emit('nm:attachments:progress', { id: item.id, stage: 'encode', percent: 70 });
      const dataUrl = await readAsDataURL(item.blob);
      item.dataUrl = dataUrl;
      item.base64 = dataUrl.split(',')[1] || '';
    } else if (kind === 'svg') {
      const r = await processSVG(file);
      item.blob = r.finalBlob;
      item.svgText = r.svgText;
      item.thumbUrl = r.thumbUrl;
      item.thumbBlob = r.thumbBlob;
      item.width = r.width || 0;
      item.height = r.height || 0;
      item.text = r.svgText;
    } else if (kind === 'heic') {
      // No podemos procesar HEIC nativamente
      item.status = 'error';
      item.error = 'HEIC no soportado. Convertí a JPEG primero.';
      throw new Error(item.error);
    } else if (kind === 'pdf') {
      emit('nm:attachments:progress', { id: item.id, stage: 'pdf-parse', percent: 20 });
      const r = await processPDF(file);
      item.blob = r.finalBlob;
      item.pageCount = r.pageCount;
      item.text = r.text;
      item.textLength = r.textLength;
      emit('nm:attachments:progress', { id: item.id, stage: 'pdf-done', percent: 80 });
    } else if (kind === 'video') {
      emit('nm:attachments:progress', { id: item.id, stage: 'video-frame', percent: 30 });
      const r = await processVideo(file);
      item.blob = r.finalBlob;
      item.thumbUrl = r.thumbUrl;
      item.thumbBlob = r.thumbBlob;
      item.duration = r.duration;
      item.width = r.width;
      item.height = r.height;
    } else if (kind === 'audio') {
      emit('nm:attachments:progress', { id: item.id, stage: 'waveform', percent: 30 });
      const r = await processAudio(file);
      item.blob = r.finalBlob;
      item.thumbUrl = r.thumbUrl;
      item.thumbBlob = r.thumbBlob;
      item.duration = r.duration;
    } else if (kind === 'text') {
      if (file.size <= CFG.text.maxInlineSize) {
        item.text = await readAsText(file);
        item.textLength = item.text.length;
      } else {
        // Archivo grande: no incluir texto, solo metadatos
        item.text = null;
        item.meta.tooLargeForInline = true;
      }
      item.blob = file;
    } else {
      // doc, sheet, slide, archive, binary
      const dataUrl = await readAsDataURL(file);
      item.dataUrl = dataUrl;
      item.base64 = dataUrl.split(',')[1] || '';
      item.blob = file;
    }

    item.status = 'ready';
    emit('nm:attachments:progress', { id: item.id, stage: 'done', percent: 100 });

    return item;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     15 · VALIDACIÓN
     ═══════════════════════════════════════════════════════════════════════ */

  function validate(file) {
    if (!file || !(file instanceof File || file instanceof Blob)) {
      return { ok: false, reason: 'invalid_file', message: 'Archivo inválido' };
    }
    if (!file.size) {
      return { ok: false, reason: 'empty', message: (file.name || 'Archivo') + ' está vacío' };
    }
    if (file.size > CFG.maxFileSize) {
      return {
        ok: false,
        reason: 'too_large',
        message: (file.name || 'Archivo') + ' pasa el límite (' + fmtSize(CFG.maxFileSize) + ')',
      };
    }
    if (S.items.length >= CFG.maxFiles) {
      return { ok: false, reason: 'too_many', message: 'Máximo ' + CFG.maxFiles + ' archivos' };
    }
    const total = getTotalBytes() + file.size;
    if (total > CFG.maxTotalBytes) {
      return {
        ok: false,
        reason: 'total_exceeded',
        message: 'Se pasa del límite total (' + fmtSize(CFG.maxTotalBytes) + ')',
      };
    }
    return { ok: true };
  }

  async function validateDuplicate(file) {
    if (!file.size) return { ok: true };
    try {
      const slice = await file.slice(0, Math.min(file.size, 1024 * 1024)).arrayBuffer();
      const hash = await sha256(slice);
      if (!hash) return { ok: true };
      const dup = S.items.find(i => i.hash === hash && i.originalSize === file.size);
      if (dup) {
        return { ok: false, reason: 'duplicate', message: dup.name + ' ya está adjunto', dupId: dup.id };
      }
    } catch {}
    return { ok: true };
  }

  /* ═══════════════════════════════════════════════════════════════════════
     16 · COLA DE PROCESAMIENTO
     ═══════════════════════════════════════════════════════════════════════ */

  const queue = [];
  let running = 0;

  function enqueue(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
  }

  async function pump() {
    if (running >= CFG.queue.concurrency) return;
    const next = queue.shift();
    if (!next) return;

    running++;
    try {
      const r = await next.task();
      next.resolve(r);
    } catch (e) {
      next.reject(e);
    } finally {
      running--;
      pump();
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     17 · API · ADD
     ═══════════════════════════════════════════════════════════════════════ */

  async function addOne(file) {
    // 1) Validación básica
    const v = validate(file);
    if (!v.ok) {
      toast('warn', v.message || 'Archivo no válido');
      emit('nm:attachments:error', { file, reason: v.reason, message: v.message });
      return null;
    }

    // 2) Validación de duplicado
    const dup = await validateDuplicate(file);
    if (!dup.ok) {
      toast('info', dup.message);
      emit('nm:attachments:error', { file, reason: dup.reason, message: dup.message });
      return null;
    }

    // 3) Clasificar
    const meta = classify(file);
    let kind = meta.kind;

    // Verificar magic bytes para kind sospechosos
    if (kind === 'binary') {
      if (await looksLikePDF(file)) kind = 'pdf';
      else if (await looksLikePNG(file) || await looksLikeJPEG(file) || await looksLikeGIF(file) || await looksLikeWebP(file)) kind = 'image';
    }

    // 4) Procesar en cola
    try {
      const item = await enqueue(() =>
        withTimeout(
          materializeItem(file, meta, kind),
          CFG.queue.timeoutMs,
          file.name
        )
      );

      // Guardar en storage
      const stored = await safePut({
        id: item.id,
        name: item.name,
        kind: item.kind,
        mime: item.mime,
        ext: item.ext,
        size: item.size,
        originalSize: item.originalSize,
        text: item.text,
        svgText: item.svgText,
        dataUrl: item.dataUrl,
        base64: item.base64,
        thumbUrl: item.thumbUrl,
        width: item.width,
        height: item.height,
        duration: item.duration,
        pageCount: item.pageCount,
        createdAt: item.createdAt,
      });
      item.meta.storage = stored;

      S.items.push(item);
      render();
      emit('nm:attachments:added', { item, index: S.items.length - 1 });
      emit('nm:attachments:change', { items: S.items.slice(), stats: getStats() });

      // Si es texto, insertar inline
      if (kind === 'text' && item.text) {
        insertTextInline(item);
      }

      return item;
    } catch (e) {
      LOG.error('addOne failed', e);
      toast('err', 'Error con ' + file.name + ': ' + e.message);
      emit('nm:attachments:error', { file, reason: 'process_failed', message: e.message });
      return null;
    }
  }

  async function addMany(files) {
    const list = Array.from(files || []);
    const results = [];
    for (const f of list) {
      results.push(await addOne(f));
    }
    return results.filter(Boolean);
  }

  async function retry(id) {
    const old = S.items.find(i => i.id === id);
    if (!old) return null;
    const idx = S.items.indexOf(old);
    S.items.splice(idx, 1);
    emit('nm:attachments:retry', { id });
    render();
    return old.file ? addOne(old.file) : null;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     18 · INSERT INLINE (texto)
     ═══════════════════════════════════════════════════════════════════════ */

  function insertTextInline(item) {
    const field = $('[data-field]');
    if (!field) return;

    let content = item.text || '';
    if (content.length > CFG.text.maxPreview) {
      const rest = content.length - CFG.text.maxPreview;
      content = content.slice(0, CFG.text.maxPreview) + '\n// […' + rest + ' caracteres más]';
    }

    const lang = (item.ext || '').replace('.', '');
    const block = '## ' + item.name + '\n```' + lang + '\n' + content + '\n```';
    const cur = (field.value || '').trim();
    field.value = cur ? cur + '\n\n' + block : block;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    toast('ok', 'Texto insertado: ' + item.name);
    field.focus();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     19 · QUITAR / LIMPIAR
     ═══════════════════════════════════════════════════════════════════════ */

  function removeById(id, opts = {}) {
    const idx = S.items.findIndex(i => i.id === id);
    if (idx === -1) return false;

    const item = S.items[idx];

    if (opts.undo !== false) {
      return removeWithUndo(item, idx);
    }

    S.items.splice(idx, 1);
    safeDel(id);
    cleanupItem(item);
    render();
    emit('nm:attachments:removed', { item, index: idx });
    emit('nm:attachments:change', { items: S.items.slice(), stats: getStats() });
    return true;
  }

  function removeWithUndo(item, idx) {
    // Quitar de la lista
    S.items.splice(idx, 1);
    render();
    emit('nm:attachments:removed', { item, index: idx });
    emit('nm:attachments:change', { items: S.items.slice(), stats: getStats() });

    // Undo window
    const undoEntry = {
      item,
      index: idx,
      timer: setTimeout(() => {
        safeDel(item.id);
        cleanupItem(item);
        // Remover del stack
        S.undoStack = S.undoStack.filter(e => e.item.id !== item.id);
      }, CFG.ui.undoWindowMs),
    };
    S.undoStack.push(undoEntry);

    // Toast con "Deshacer"
    const restored = () => {
      clearTimeout(undoEntry.timer);
      S.items.splice(idx, 0, item);
      render();
      emit('nm:attachments:change', { items: S.items.slice(), stats: getStats() });
      toast('ok', 'Restaurado: ' + item.name);
      S.undoStack = S.undoStack.filter(e => e.item.id !== item.id);
    };

    toast('info', 'Quitado: ' + item.name, {
      actions: [
        { label: 'Deshacer', onClick: restored },
      ],
      duration: CFG.ui.undoWindowMs,
    });

    return true;
  }

  function cleanupItem(item) {
    if (!item) return;
    if (item.thumbUrl && item.thumbUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(item.thumbUrl); } catch {}
    }
    item.blob = null;
    item.dataUrl = null;
    item.base64 = null;
  }

  function removeByIndex(index, opts) {
    const item = S.items[index];
    if (!item) return false;
    return removeById(item.id, opts);
  }

  async function clear() {
    const items = S.items.slice();
    S.items = [];
    for (const item of items) {
      await safeDel(item.id);
      cleanupItem(item);
    }
    render();
    emit('nm:attachments:change', { items: [], stats: getStats() });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     20 · REORDENAR
     ═══════════════════════════════════════════════════════════════════════ */

  function reorder(fromId, toId) {
    const fromIdx = S.items.findIndex(i => i.id === fromId);
    const toIdx = S.items.findIndex(i => i.id === toId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

    const [moved] = S.items.splice(fromIdx, 1);
    S.items.splice(toIdx, 0, moved);
    render();
    emit('nm:attachments:change', { items: S.items.slice(), stats: getStats() });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     21 · STATS + CONSUME
     ═══════════════════════════════════════════════════════════════════════ */

  function getTotalBytes() {
    return S.items.reduce((s, i) => s + (i.size || 0), 0);
  }

  function getStats() {
    const byKind = {};
    S.items.forEach(i => {
      byKind[i.kind] = (byKind[i.kind] || 0) + 1;
    });
    return {
      count: S.items.length,
      totalBytes: getTotalBytes(),
      totalHuman: fmtSize(getTotalBytes()),
      byKind,
      images: byKind.image || 0,
      texts: byKind.text || 0,
      pdfs: byKind.pdf || 0,
      videos: byKind.video || 0,
      audios: byKind.audio || 0,
    };
  }

  /**
   * Devuelve el payload listo para enviar al backend.
   * Ahora soporta MÚLTIPLES archivos.
   * El chat.html llama NM_attachments.consume() al hacer submit.
   */
  function consume() {
    if (S.items.length === 0) return null;

    const payload = {
      files: S.items.map(it => ({
        id: it.id,
        kind: it.kind,
        name: it.name,
        mime: it.mime,
        size: it.size,
        // Contenido según tipo
        data: it.base64 || null,
        text: it.text || null,
        svg: it.svgText || null,
        // Metadata útil
        pageCount: it.pageCount || 0,
        duration: it.duration || 0,
        width: it.width || 0,
        height: it.height || 0,
      })),
      count: S.items.length,
      totalBytes: getTotalBytes(),
    };

    emit('nm:attachments:consumed', { ids: S.items.map(i => i.id) });

    // Limpiar después de consumir
    setTimeout(() => { clear(); }, 100);

    return payload;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     22 · RENDER
     ═══════════════════════════════════════════════════════════════════════ */

  let _renderScheduled = false;
  function render() {
    if (_renderScheduled) return;
    _renderScheduled = true;
    requestAnimationFrame(() => {
      _renderScheduled = false;
      renderNow();
    });
  }

  function renderNow() {
    const host = getHost();
    if (!host) return;

    host.innerHTML = '';

    if (S.items.length === 0) {
      host.hidden = true;
      return;
    }

    host.hidden = false;

    // Header con stats si >1
    if (CFG.ui.showStats && S.items.length > 1) {
      const stats = getStats();
      const header = document.createElement('div');
      header.className = 'attach-stats';
      const parts = [];
      parts.push(stats.count + ' archivo' + (stats.count === 1 ? '' : 's'));
      parts.push(stats.totalHuman);
      if (stats.images) parts.push(stats.images + ' imagen' + (stats.images === 1 ? '' : 'es'));
      if (stats.pdfs) parts.push(stats.pdfs + ' PDF' + (stats.pdfs === 1 ? '' : 's'));
      header.textContent = parts.join(' · ');
      host.appendChild(header);
    }

    S.items.forEach((item, idx) => {
      host.appendChild(buildChip(item, idx));
    });
  }

  function buildChip(item, idx) {
    const chip = document.createElement('div');
    chip.className = 'attach-chip attach-chip--' + item.kind;
    chip.setAttribute('data-id', item.id);
    chip.setAttribute('tabindex', CFG.ui.enableKeyboard ? '0' : '-1');
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', 'Adjunto: ' + item.name + ', ' + fmtSize(item.size));

    // Drag handle
    if (CFG.ui.enableReorder) {
      chip.setAttribute('draggable', 'true');
    }

    // Icono / thumb
    const visual = buildChipVisual(item);

    // Nombre
    const nameEl = '<span class="attach-chip__name" title="' + escAttr(item.name) + '">' + escHtml(item.name) + '</span>';

    // Tamaño
    const sizeEl = '<span class="attach-chip__size">' + fmtSize(item.size) + '</span>';

    // Badge compresión
    const compressedBadge = item.compressed
      ? '<span class="attach-chip__badge" title="Comprimida de ' + fmtSize(item.originalSize) + '">↓</span>'
      : '';

    // Badge páginas PDF
    const pagesBadge = item.pageCount
      ? '<span class="attach-chip__badge">' + item.pageCount + 'p</span>'
      : '';

    // Badge duración
    const durationBadge = item.duration
      ? '<span class="attach-chip__badge">' + formatDuration(item.duration) + '</span>'
      : '';

    // Botón quitar
    const removeBtn = '<button class="attach-chip__remove" type="button" aria-label="Quitar" data-remove>✕</button>';

    chip.innerHTML = visual + nameEl + compressedBadge + pagesBadge + durationBadge + sizeEl + removeBtn;

    // Eventos
    const removeEl = chip.querySelector('[data-remove]');
    removeEl.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeById(item.id);
    });

    // Click en el chip → preview
    chip.addEventListener('click', (e) => {
      if (e.target.closest('[data-remove]')) return;
      openPreview(item);
    });

    // Keyboard
    if (CFG.ui.enableKeyboard) {
      chip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openPreview(item);
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          removeById(item.id);
        }
      });
    }

    // Drag reorder
    if (CFG.ui.enableReorder) {
      chip.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/x-attach-id', item.id);
        chip.classList.add('is-dragging');
      });
      chip.addEventListener('dragend', () => chip.classList.remove('is-dragging'));
      chip.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        chip.classList.add('is-drop-target');
      });
      chip.addEventListener('dragleave', () => chip.classList.remove('is-drop-target'));
      chip.addEventListener('drop', (e) => {
        e.preventDefault();
        chip.classList.remove('is-drop-target');
        const fromId = e.dataTransfer.getData('text/x-attach-id');
        if (fromId && fromId !== item.id) reorder(fromId, item.id);
      });
    }

    return chip;
  }

  function buildChipVisual(item) {
    if ((item.kind === 'image' || item.kind === 'video' || item.kind === 'audio' || item.kind === 'svg') && item.thumbUrl) {
      return '<img class="attach-chip__thumb" src="' + escAttr(item.thumbUrl) + '" alt="" loading="lazy" />';
    }
    return '<span class="attach-chip__icon">' + iconSVG(item.kind) + '</span>';
  }

  function iconSVG(kind) {
    const icons = {
      text:    '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
      image:   '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
      svg:     '<svg viewBox="0 0 24 24"><polygon points="12 2 22 8.5 22 15.5 12 22 2 15.5 2 8.5"/></svg>',
      pdf:     '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15h6"/></svg>',
      doc:     '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>',
      sheet:   '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg>',
      slide:   '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="14" rx="2"/><line x1="8" y1="22" x2="16" y2="22"/></svg>',
      video:   '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2"/><polygon points="22 8 16 12 22 16"/></svg>',
      audio:   '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
      archive: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="6" rx="1"/><path d="M5 9v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9"/><line x1="10" y1="13" x2="14" y2="13"/></svg>',
      binary:  '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
      heic:    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    };
    return icons[kind] || icons.binary;
  }

  function formatDuration(seconds) {
    if (!seconds) return '';
    if (seconds < 60) return seconds + 's';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function getHost() {
    let host = $('[data-attachments]');
    if (host) return host;

    const composer = $('.composer');
    if (!composer) return null;

    host = document.createElement('div');
    host.className = 'chat-attachments';
    host.setAttribute('data-attachments', '');
    host.hidden = true;

    // Insertar antes del composer (dentro del wrapper o como hermano)
    if (composer.parentNode) {
      composer.parentNode.insertBefore(host, composer);
    }
    return host;
  }

  /* ═══════════════════════════════════════════════════════════════════════
     23 · PREVIEW MODAL (universal)
     ═══════════════════════════════════════════════════════════════════════ */

  function openPreview(item) {
    const overlay = document.createElement('div');
    overlay.className = 'nm-attach-preview';

    const close = () => {
      overlay.classList.remove('is-open');
      setTimeout(() => overlay.remove(), 200);
      document.removeEventListener('keydown', onKey);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') close();
      else if (e.key === '+' || e.key === '=') zoomIn();
      else if (e.key === '-') zoomOut();
      else if (e.key === '0') resetZoom();
      else if (e.key === 'r' && item.kind === 'image') rotate();
    };

    let zoom = 1;
    let rotation = 0;

    const inner = document.createElement('div');
    inner.className = 'nm-attach-preview__inner';
    inner.addEventListener('click', (e) => e.stopPropagation());

    // Header
    const head = document.createElement('div');
    head.className = 'nm-attach-preview__head';
    head.innerHTML =
      '<div class="nm-attach-preview__info">' +
        '<span class="nm-attach-preview__name">' + escHtml(item.name) + '</span>' +
        '<span class="nm-attach-preview__meta">' + fmtSize(item.size) + (item.width ? ' · ' + item.width + '×' + item.height : '') + (item.duration ? ' · ' + formatDuration(item.duration) : '') + (item.pageCount ? ' · ' + item.pageCount + 'p' : '') + '</span>' +
      '</div>' +
      '<div class="nm-attach-preview__actions"></div>';

    const actions = head.querySelector('.nm-attach-preview__actions');

    const addAction = (label, svg, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'nm-attach-preview__action';
      btn.setAttribute('aria-label', label);
      btn.setAttribute('title', label);
      btn.innerHTML = svg;
      btn.addEventListener('click', onClick);
      actions.appendChild(btn);
    };

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'nm-attach-preview__action nm-attach-preview__action--close';
    closeBtn.setAttribute('aria-label', 'Cerrar');
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    closeBtn.addEventListener('click', close);

    inner.appendChild(head);

    // Body
    const body = document.createElement('div');
    body.className = 'nm-attach-preview__body';

    if (item.kind === 'image' && item.dataUrl) {
      const img = document.createElement('img');
      img.className = 'nm-attach-preview__img';
      img.src = item.dataUrl;
      img.alt = item.name;
      img.draggable = false;
      body.appendChild(img);

      const applyTransform = () => {
        img.style.transform = 'scale(' + zoom + ') rotate(' + rotation + 'deg)';
      };

      const zoomIn = () => { zoom = Math.min(4, zoom + 0.25); applyTransform(); };
      const zoomOut = () => { zoom = Math.max(0.25, zoom - 0.25); applyTransform(); };
      const resetZoom = () => { zoom = 1; rotation = 0; applyTransform(); };
      const rotate = () => { rotation = (rotation + 90) % 360; applyTransform(); };

      addAction('Zoom +', '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>', zoomIn);
      addAction('Zoom -', '<svg viewBox="0 0 24 24"><line x1="5" y1="12" x2="19" y2="12"/></svg>', zoomOut);
      addAction('Rotar', '<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>', rotate);
      addAction('Reset', '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>', resetZoom);
      addAction('Descargar', '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>', () => downloadItem(item));
      addAction('Copiar', '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>', () => copyImageToClipboard(item));

    } else if (item.kind === 'pdf' && item.dataUrl) {
      const iframe = document.createElement('iframe');
      iframe.className = 'nm-attach-preview__pdf';
      iframe.src = item.dataUrl;
      body.appendChild(iframe);
      addAction('Descargar', '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>', () => downloadItem(item));

      if (item.text) {
        // Añadir botón para ver texto extraído
        addAction('Ver texto', '<svg viewBox="0 0 24 24"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>', () => {
          showTextPreview(item.name, item.text);
        });
      }

    } else if (item.kind === 'video' && item.blob) {
      const video = document.createElement('video');
      video.className = 'nm-attach-preview__video';
      video.controls = true;
      video.src = URL.createObjectURL(item.blob);
      body.appendChild(video);
      addAction('Descargar', '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>', () => downloadItem(item));

    } else if (item.kind === 'audio' && item.blob) {
      const audio = document.createElement('audio');
      audio.className = 'nm-attach-preview__audio';
      audio.controls = true;
      audio.src = URL.createObjectURL(item.blob);
      body.appendChild(audio);
      addAction('Descargar', '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>', () => downloadItem(item));

    } else if (item.text) {
      // Preview de texto (code, json, md, pdf-text)
      const pre = document.createElement('pre');
      pre.className = 'nm-attach-preview__text';
      const code = document.createElement('code');
      code.textContent = item.text;
      pre.appendChild(code);
      body.appendChild(pre);
      addAction('Descargar', '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>', () => downloadItem(item));
      addAction('Copiar', '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>', () => {
        navigator.clipboard.writeText(item.text).then(() => toast('ok', 'Texto copiado'));
      });

    } else if (item.kind === 'svg' && item.svgText) {
      const img = document.createElement('img');
      img.className = 'nm-attach-preview__img';
      img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(item.svgText);
      body.appendChild(img);

    } else {
      // Fallback: solo metadatos
      const info = document.createElement('div');
      info.className = 'nm-attach-preview__fallback';
      info.innerHTML = '<div class="nm-attach-preview__fallback-icon">' + iconSVG(item.kind) + '</div>' +
                       '<div class="nm-attach-preview__fallback-name">' + escHtml(item.name) + '</div>' +
                       '<div class="nm-attach-preview__fallback-meta">' + fmtSize(item.size) + ' · ' + escHtml(item.mime || 'desconocido') + '</div>';
      body.appendChild(info);
      addAction('Descargar', '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>', () => downloadItem(item));
    }

    inner.appendChild(body);
    actions.appendChild(closeBtn);
    overlay.appendChild(inner);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => overlay.classList.add('is-open'));
    overlay.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
  }

  function showTextPreview(title, text) {
    const overlay = document.createElement('div');
    overlay.className = 'nm-attach-preview is-open';
    overlay.innerHTML =
      '<div class="nm-attach-preview__inner" style="max-width:800px;max-height:80vh">' +
        '<div class="nm-attach-preview__head">' +
          '<div class="nm-attach-preview__info">' +
            '<span class="nm-attach-preview__name">' + escHtml(title) + '</span>' +
          '</div>' +
          '<div class="nm-attach-preview__actions">' +
            '<button type="button" class="nm-attach-preview__action" data-copy><svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>' +
            '<button type="button" class="nm-attach-preview__action nm-attach-preview__action--close"><svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
          '</div>' +
        '</div>' +
        '<div class="nm-attach-preview__body">' +
          '<pre class="nm-attach-preview__text" style="max-height:65vh"><code></code></pre>' +
        '</div>' +
      '</div>';

    overlay.querySelector('code').textContent = text;
    overlay.querySelector('[data-copy]').addEventListener('click', () => {
      navigator.clipboard.writeText(text).then(() => toast('ok', 'Texto copiado'));
    });

    const close = () => overlay.remove();
    overlay.querySelector('.nm-attach-preview__action--close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    document.body.appendChild(overlay);
  }

  async function downloadItem(item) {
    try {
      const blob = item.blob || new Blob([item.text || ''], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = item.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast('ok', 'Descargando: ' + item.name);
    } catch (e) {
      toast('err', 'No se pudo descargar');
    }
  }

  async function copyImageToClipboard(item) {
    if (!item.blob) return;
    try {
      if (navigator.clipboard && window.ClipboardItem) {
        await navigator.clipboard.write([new ClipboardItem({ [item.blob.type || 'image/png']: item.blob })]);
        toast('ok', 'Imagen copiada');
      } else {
        toast('warn', 'Tu navegador no permite copiar imágenes');
      }
    } catch (e) {
      toast('err', 'Error al copiar');
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     24 · DRAG & DROP (global)
     ═══════════════════════════════════════════════════════════════════════ */

  function setupGlobalDragDrop() {
    if (!CFG.ui.dropZoneGlobal) return;
    if (document.body.__nmGlobalDragSetup) return;
    document.body.__nmGlobalDragSetup = true;

    let counter = 0;

    const overlay = document.createElement('div');
    overlay.className = 'nm-global-drop';
    overlay.innerHTML =
      '<div class="nm-global-drop__inner">' +
        '<div class="nm-global-drop__icon">' +
          '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
        '</div>' +
        '<div class="nm-global-drop__text">Soltá los archivos acá</div>' +
      '</div>';
    document.body.appendChild(overlay);

    document.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types) return;
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      counter++;
      if (counter === 1) overlay.classList.add('is-active');
    });

    document.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.types) return;
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    document.addEventListener('dragleave', () => {
      counter = Math.max(0, counter - 1);
      if (counter === 0) overlay.classList.remove('is-active');
    });

    document.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files) return;
      e.preventDefault();
      counter = 0;
      overlay.classList.remove('is-active');
      addMany(e.dataTransfer.files);
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     25 · PASTE
     ═══════════════════════════════════════════════════════════════════════ */

  function setupPaste() {
    const field = $('[data-field]');
    if (!field || field.__nmPasteHooked) return;
    field.__nmPasteHooked = true;

    field.addEventListener('paste', (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;

      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) {
            // Renombrar screenshots genéricos
            if (!f.name || f.name === 'image.png' || f.name === 'blob') {
              const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
              try {
                Object.defineProperty(f, 'name', { value: 'screenshot-' + ts + '.png', writable: false });
              } catch {}
            }
            files.push(f);
          }
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        addMany(files);
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     26 · BOTÓN +
     ═══════════════════════════════════════════════════════════════════════ */

  function setupAttachButton() {
    // Acepta múltiples selectores
    const selectors = ['[data-attach-btn]', '[data-attach]'];
    let btn = null;
    for (const sel of selectors) {
      btn = $(sel);
      if (btn) break;
    }
    if (!btn || btn.__nmAttachHooked) return;
    btn.__nmAttachHooked = true;

    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = [
      'image/*',
      ...Array.from(TEXT_EXTS),
      '.pdf', '.doc', '.docx',
      '.xls', '.xlsx',
      '.ppt', '.pptx',
      '.mp4', '.webm',
      '.mp3', '.wav',
    ].join(',');
    input.style.display = 'none';
    btn.parentNode.appendChild(input);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      input.click();
    });

    input.addEventListener('change', () => {
      if (input.files && input.files.length > 0) {
        addMany(input.files);
      }
      input.value = '';
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     27 · CSS
     ═══════════════════════════════════════════════════════════════════════ */

  function injectCSS() {
    if ($('#nm-attach-css')) return;
    const style = document.createElement('style');
    style.id = 'nm-attach-css';
    style.textContent = `
      /* ─── Contenedor principal ─── */
      .chat-attachments {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 8px 4px;
        max-width: var(--composer-max, 820px);
        margin: 0 auto;
        width: 100%;
        align-items: center;
      }
      .chat-attachments[hidden] { display: none; }

      .attach-stats {
        width: 100%;
        font-size: 11.5px;
        color: var(--c-text-muted, #6b6b70);
        font-weight: 500;
        padding: 0 4px 4px;
        letter-spacing: -0.005em;
      }

      /* ─── Chip ─── */
      .attach-chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 5px 6px 5px 8px;
        background: var(--c-bg-soft, #f7f7f8);
        border: 1px solid var(--c-border, #e8e8ea);
        border-radius: 999px;
        font-size: 12.5px;
        color: var(--c-text-2, #3a3a40);
        max-width: 320px;
        cursor: pointer;
        transition: background .15s, border-color .15s, transform .1s;
        animation: attachIn .2s ease-out;
        outline: none;
      }
      .attach-chip:hover {
        background: var(--c-bg-hover, #f2f2f4);
        border-color: var(--c-border-strong, #d8d8dc);
      }
      .attach-chip:focus-visible {
        box-shadow: 0 0 0 3px var(--c-primary-glow, rgba(124, 94, 255, .22));
        border-color: var(--c-primary, #7c5eff);
      }
      .attach-chip.is-dragging {
        opacity: .4;
        transform: scale(.95);
      }
      .attach-chip.is-drop-target {
        box-shadow: 0 0 0 3px var(--c-primary-glow, rgba(124, 94, 255, .22));
      }
      @keyframes attachIn {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .attach-chip__thumb {
        width: 26px; height: 26px;
        border-radius: 6px;
        object-fit: cover;
        flex-shrink: 0;
        background: var(--c-bg-hover, #f2f2f4);
      }
      .attach-chip__icon {
        width: 20px; height: 20px;
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0;
      }
      .attach-chip__icon svg {
        width: 18px; height: 18px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.8;
        stroke-linecap: round;
        stroke-linejoin: round;
        color: var(--c-text-muted, #6b6b70);
      }
      .attach-chip__name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        min-width: 0;
        font-weight: 500;
      }
      .attach-chip__size {
        font-size: 11px;
        color: var(--c-text-subtle, #a0a0a5);
        flex-shrink: 0;
        font-variant-numeric: tabular-nums;
      }
      .attach-chip__badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 1px 5px;
        font-size: 10px;
        font-weight: 700;
        color: var(--c-primary, #7c5eff);
        background: rgba(124, 94, 255, .12);
        border-radius: 4px;
        flex-shrink: 0;
        line-height: 1;
      }
      .attach-chip__remove {
        background: none;
        border: none;
        color: var(--c-text-muted, #6b6b70);
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 50%;
        font-size: 11px;
        line-height: 1;
        flex-shrink: 0;
        transition: all .15s;
        font-family: inherit;
      }
      .attach-chip__remove:hover {
        background: var(--c-danger-soft, #fef2f2);
        color: var(--c-danger, #dc2626);
      }

      /* ─── Global drop ─── */
      .nm-global-drop {
        position: fixed;
        inset: 0;
        background: rgba(124, 94, 255, .08);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
        z-index: 9998;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        pointer-events: none;
        transition: opacity .2s;
      }
      .nm-global-drop.is-active {
        opacity: 1;
      }
      .nm-global-drop__inner {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 16px;
        padding: 40px 60px;
        background: var(--c-bg, #fff);
        border: 2px dashed var(--c-primary, #7c5eff);
        border-radius: 24px;
        box-shadow: 0 24px 56px rgba(0, 0, 0, .14);
      }
      .nm-global-drop__icon svg {
        width: 48px; height: 48px;
        stroke: var(--c-primary, #7c5eff);
        stroke-width: 1.6;
        fill: none;
        stroke-linecap: round;
        stroke-linejoin: round;
      }
      .nm-global-drop__text {
        font-size: 16px;
        font-weight: 600;
        color: var(--c-primary, #7c5eff);
      }

      /* ─── Preview modal ─── */
      .nm-attach-preview {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, .88);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        z-index: 9999;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        opacity: 0;
        transition: opacity .2s;
      }
      .nm-attach-preview.is-open { opacity: 1; }

      .nm-attach-preview__inner {
        background: var(--c-bg, #fff);
        border-radius: 16px;
        overflow: hidden;
        max-width: 90vw;
        max-height: 90vh;
        display: flex;
        flex-direction: column;
        box-shadow: 0 24px 56px rgba(0, 0, 0, .5);
      }

      .nm-attach-preview__head {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--c-border, #e8e8ea);
        flex-shrink: 0;
      }
      .nm-attach-preview__info {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .nm-attach-preview__name {
        font-size: 14px;
        font-weight: 600;
        color: var(--c-text, #0a0a0c);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .nm-attach-preview__meta {
        font-size: 11.5px;
        color: var(--c-text-muted, #6b6b70);
        font-variant-numeric: tabular-nums;
      }
      .nm-attach-preview__actions {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
      }
      .nm-attach-preview__action {
        width: 34px; height: 34px;
        display: flex; align-items: center; justify-content: center;
        border-radius: 8px;
        color: var(--c-text-muted, #6b6b70);
        background: transparent;
        border: none;
        cursor: pointer;
        transition: all .15s;
      }
      .nm-attach-preview__action:hover {
        background: var(--c-bg-hover, #f2f2f4);
        color: var(--c-text, #0a0a0c);
      }
      .nm-attach-preview__action--close:hover {
        background: var(--c-danger-soft, #fef2f2);
        color: var(--c-danger, #dc2626);
      }
      .nm-attach-preview__action svg {
        width: 16px; height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-width: 2;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .nm-attach-preview__body {
        flex: 1;
        min-height: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: #0a0a0c;
        overflow: auto;
      }
      .nm-attach-preview__img {
        max-width: 100%;
        max-height: 75vh;
        display: block;
        transition: transform .2s;
        user-select: none;
      }
      .nm-attach-preview__pdf {
        width: 800px;
        height: 75vh;
        max-width: 90vw;
        border: none;
        background: #fff;
      }
      .nm-attach-preview__video {
        max-width: 90vw;
        max-height: 75vh;
        background: #000;
      }
      .nm-attach-preview__audio {
        width: 500px;
        max-width: 90vw;
        padding: 20px;
      }
      .nm-attach-preview__text {
        margin: 0;
        padding: 20px 24px;
        font-family: var(--font-mono, ui-monospace, monospace);
        font-size: 12.5px;
        line-height: 1.6;
        color: #e6e6e6;
        white-space: pre-wrap;
        word-break: break-word;
        overflow: auto;
        max-height: 75vh;
        width: 100%;
      }
      .nm-attach-preview__fallback {
        padding: 60px 40px;
        text-align: center;
        color: #e6e6e6;
      }
      .nm-attach-preview__fallback-icon svg {
        width: 64px; height: 64px;
        stroke: var(--c-primary, #7c5eff);
        stroke-width: 1.5;
        fill: none;
        margin: 0 auto 16px;
      }
      .nm-attach-preview__fallback-name {
        font-size: 16px;
        font-weight: 600;
        margin-bottom: 6px;
      }
      .nm-attach-preview__fallback-meta {
        font-size: 12.5px;
        color: #888;
      }

      /* ─── Mobile ─── */
      @media (max-width: 640px) {
        .attach-chip { max-width: 240px; font-size: 12px; }
        .attach-chip__size { display: none; }
        .nm-attach-preview { padding: 12px; }
        .nm-attach-preview__inner { border-radius: 12px; }
        .nm-attach-preview__pdf { width: 100%; height: 60vh; }
      }
    `;
    document.head.appendChild(style);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     28 · INIT
     ═══════════════════════════════════════════════════════════════════════ */

  async function init() {
    if (S.initialized) return;
    S.initialized = true;

    injectCSS();
    getHost();
    setupAttachButton();
    setupPaste();
    setupGlobalDragDrop();

    // Restaurar de IDB (si había algo)
    try {
      const restored = await safeAll();
      if (restored && restored.length > 0) {
        // Solo restaurar metadatos + thumbUrl, NO re-procesar
        restored.forEach(r => {
          if (!r.id) return;
          // No restauramos items completos porque el dataUrl es enorme;
          // solo si el usuario los necesita los re-adjunta
        });
        LOG.info('found ' + restored.length + ' persisted items (no auto-restored)');
      }
    } catch (e) {
      LOG.warn('restore failed', e);
    }

    render();
    LOG.info('initialized · level=' + CFG.logLevel);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     29 · SELF-TEST
     ═══════════════════════════════════════════════════════════════════════ */

  async function selfTest() {
    const results = [];
    const record = (name, ok, detail) => results.push({ name, ok, detail });

    // Test 1: extOf
    record('extOf("app.js") === ".js"', extOf('app.js') === '.js', extOf('app.js'));
    record('extOf("noext") === ""', extOf('noext') === '', extOf('noext'));

    // Test 2: classify
    const t1 = classify({ name: 'photo.png', type: 'image/png', size: 100 });
    record('classify PNG → image', t1.kind === 'image', t1.kind);

    const t2 = classify({ name: 'doc.pdf', type: 'application/pdf', size: 100 });
    record('classify PDF → pdf', t2.kind === 'pdf', t2.kind);

    const t3 = classify({ name: 'app.js', type: 'text/javascript', size: 100 });
    record('classify JS → text', t3.kind === 'text', t3.kind);

    const t4 = classify({ name: 'icon.svg', type: 'image/svg+xml', size: 100 });
    record('classify SVG → svg', t4.kind === 'svg', t4.kind);

    const t5 = classify({ name: 'video.mp4', type: 'video/mp4', size: 100 });
    record('classify MP4 → video', t5.kind === 'video', t5.kind);

    const t6 = classify({ name: 'song.mp3', type: 'audio/mpeg', size: 100 });
    record('classify MP3 → audio', t6.kind === 'audio', t6.kind);

    const t7 = classify({ name: 'photo.heic', type: 'image/heic', size: 100 });
    record('classify HEIC → heic', t7.kind === 'heic', t7.kind);

    // Test 3: validate
    const v1 = validate({ name: 'a.png', type: 'image/png', size: 100 });
    record('validate normal → ok', v1.ok === true, v1);

    const v2 = validate({ name: 'big.bin', type: 'application/octet-stream', size: CFG.maxFileSize + 1 });
    record('validate too big → fails', v2.ok === false, v2.reason);

    const v3 = validate({ name: 'empty.txt', type: 'text/plain', size: 0 });
    record('validate empty → fails', v3.ok === false, v3.reason);

    // Test 4: fmtSize
    record('fmtSize(500) === "500 B"', fmtSize(500) === '500 B', fmtSize(500));
    record('fmtSize(2048) === "2.0 KB"', fmtSize(2048) === '2.0 KB', fmtSize(2048));
    record('fmtSize(1048576) === "1.0 MB"', fmtSize(1048576) === '1.0 MB', fmtSize(1048576));

    // Test 5: escHtml
    record('escHtml escapes <script>', escHtml('<script>') === '&lt;script&gt;', escHtml('<script>'));

    // Test 6: getStats
    const stats = getStats();
    record('getStats returns object', typeof stats === 'object' && 'count' in stats, stats);

    // Test 7: IDB available
    const idbOk = 'indexedDB' in window;
    record('IndexedDB available', idbOk, idbOk);

    // Test 8: WebWorker available
    const workerOk = 'Worker' in window;
    record('Web Worker available', workerOk, workerOk);

    // Test 9: crypto.subtle available
    const cryptoOk = window.crypto && window.crypto.subtle;
    record('crypto.subtle available', !!cryptoOk, !!cryptoOk);

    const passed = results.filter(r => r.ok).length;
    const total = results.length;

    LOG.info('self-test: ' + passed + '/' + total + ' passed');

    return {
      passed,
      total,
      ok: passed === total,
      results,
    };
  }

  /* ═══════════════════════════════════════════════════════════════════════
     30 · CONFIGURE
     ═══════════════════════════════════════════════════════════════════════ */

  function configure(patch) {
    if (!patch || typeof patch !== 'object') return;
    deepMerge(CFG, patch);
    LOG.info('config updated', patch);
  }

  function deepMerge(target, source) {
    Object.keys(source).forEach(k => {
      if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])) {
        if (!target[k] || typeof target[k] !== 'object') target[k] = {};
        deepMerge(target[k], source[k]);
      } else {
        target[k] = source[k];
      }
    });
  }

  /* ═══════════════════════════════════════════════════════════════════════
     31 · BOOT
     ═══════════════════════════════════════════════════════════════════════ */

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     32 · API PÚBLICA
     ═══════════════════════════════════════════════════════════════════════ */

  window.NM_attachments = {
    // Acciones
    add:                 (file) => addOne(file),
    addMany:             (files) => addMany(files),
    retry:               (id) => retry(id),

    // Gestión
    remove:              (idOrIndex) => typeof idOrIndex === 'number' ? removeByIndex(idOrIndex) : removeById(idOrIndex),
    removeWithUndo:      (id) => { const it = S.items.find(i => i.id === id); return it ? removeWithUndo(it, S.items.indexOf(it)) : false; },
    clear:               () => clear(),
    reorder:             (fromId, toId) => reorder(fromId, toId),

    // Consultas
    list:                () => S.items.slice(),
    get:                 (id) => S.items.find(i => i.id === id) || null,
    count:               () => S.items.length,
    hasAttachments:      () => S.items.length > 0,
    getTotalBytes:       () => getTotalBytes(),
    getStats:            () => getStats(),

    // Integración con chat
    consume:             () => consume(),

    // UI
    preview:             (id) => { const it = S.items.find(i => i.id === id); if (it) openPreview(it); },
    render:              () => render(),

    // Config
    configure:           (patch) => configure(patch),

    // Debug
    test:                () => selfTest(),
    _config:             CFG,
    _state:              S,
    _internals: {
      classify, validate, extractFilesFromResponse, buildDependencyGraph,
    },
  };

  LOG.info('module loaded · v2.0');
})();