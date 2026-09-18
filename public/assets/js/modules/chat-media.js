/* ============================================================
   Adjuntar archivos al chat
   Maneja selección, preview, lectura base64 y limpieza.
   ============================================================ */

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

export const attachState = {
  file: null,
};

let elInput, elBtn, elPreview, elIcon, elName, elSize, elRemove;

export function initChatMedia() {
  elInput   = document.getElementById('file-input');
  elBtn     = document.getElementById('attach-btn');
  elPreview = document.getElementById('attach-preview');
  elIcon    = document.getElementById('attach-preview-icon');
  elName    = document.getElementById('attach-preview-name');
  elSize    = document.getElementById('attach-preview-size');
  elRemove  = document.getElementById('attach-preview-remove');

  if (!elInput || !elBtn) return;

  elBtn.addEventListener('click', () => elInput.click());
  elInput.addEventListener('change', handleSelect);
  if (elRemove) elRemove.addEventListener('click', clearFile);

  const field = document.querySelector('[data-chat-field]');
  if (field) {
    field.addEventListener('paste', (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith('image/')) {
          const file = it.getAsFile();
          if (file) { e.preventDefault(); processFile(file); }
          return;
        }
      }
    });
  }
}

function handleSelect(e) {
  const file = e.target.files?.[0];
  if (file) processFile(file);
}

function processFile(file) {
  if (file.size > MAX_FILE_SIZE) {
    alert('El archivo supera los 10 MB.');
    elInput.value = '';
    return;
  }

  const reader = new FileReader();

  reader.onload = () => {
    const result = String(reader.result);
    const commaIdx = result.indexOf(',');
    const base64 = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;

    attachState.file = {
      name: file.name || 'archivo',
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      data: base64,
    };

    renderPreview();
  };

  reader.onerror = () => alert('No se pudo leer el archivo.');
  reader.readAsDataURL(file);
}

function renderPreview() {
  const f = attachState.file;
  if (!f) {
    if (elPreview) elPreview.hidden = true;
    elBtn.classList.remove('has-file');
    return;
  }

  elBtn.classList.add('has-file');
  if (elPreview) elPreview.hidden = false;
  if (elIcon)  elIcon.textContent = iconForFile(f.mimeType, f.name);
  if (elName)  elName.textContent = f.name;
  if (elSize)  elSize.textContent = formatSize(f.size);
}

function clearFile() {
  attachState.file = null;
  if (elInput) elInput.value = '';
  renderPreview();
}

export function consumeAttachedFile() {
  const f = attachState.file;
  attachState.file = null;
  if (elInput) elInput.value = '';
  renderPreview();
  return f;
}

function iconForFile(mime, name) {
  if (mime.startsWith('image/')) return '🖼️';
  if (mime === 'application/pdf') return '📕';
  if (mime.startsWith('text/')) return '📄';
  if (/\.(doc|docx)$/i.test(name)) return '📘';
  if (/\.(xls|xlsx)$/i.test(name)) return '📊';
  return '📎';
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}