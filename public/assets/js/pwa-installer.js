/* ═══════════════════════════════════════════════════════════════════════════
   NUMINATION · pwa-installer.js · v1.0
   ───────────────────────────────────────────────────────────────────────────
   Instalador de la PWA: banner inferior con botón "Instalar".

   FLUJO
     1. Se captura el evento `beforeinstallprompt` (Chrome/Edge/Android).
     2. Se muestra un banner discreto en la parte inferior (no
       intrusivo: se puede cerrar).
     3. Al pulsar "Instalar" se llama a `prompt()` del evento y se espera
        el `userChoice`.
     4. Si el navegador no soporta el evento (Safari/iOS), se muestra la
       instrucciones manuales ("Compartí → Agregar a pantalla de inicio").

   PERSISTENCIA
     · Si el usuario descarta el banner, no se vuelve a mostrar en esa
       navegación (se guarda en sessionStorage).
     · Si la app ya está instalada (display-mode: standalone), no se
       muestra nunca.

   ESTILOS
     Inyectados desde JS (el proyecto no usa archivos .css).
   ═══════════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  const STYLE_ID = 'numination-pwa-styles';
  const DISMISS_KEY = 'nm_pwa_dismissed';

  const CSS = `
.nm-pwa-banner {
  position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%) translateY(140%);
  z-index: 220; width: min(520px, 94vw);
  display: flex; align-items: center; gap: 14px;
  padding: 14px 16px;
  background: rgba(16,16,22,.97);
  border: 1px solid rgba(139,92,246,.34);
  border-radius: 14px;
  box-shadow: 0 22px 54px rgba(0,0,0,.62);
  backdrop-filter: blur(10px);
  transition: transform .32s cubic-bezier(.22,.9,.3,1), opacity .2s ease;
  opacity: 0;
}
.nm-pwa-banner.is-visible { transform: translateX(-50%) translateY(0); opacity: 1; }
.nm-pwa-banner__icon {
  width: 38px; height: 38px; flex: 0 0 38px; border-radius: 10px;
  display: grid; place-items: center;
  background: linear-gradient(135deg, #8b5cf6, #6d28d9); color: #fff;
}
.nm-pwa-banner__body { flex: 1; min-width: 0; }
.nm-pwa-banner__title { font: 700 13.5px/1.3 var(--font-sans, Inter, system-ui, sans-serif); color: #f4f4f7; }
.nm-pwa-banner__text { font-size: 12px; line-height: 1.45; color: #8b8b9c; margin-top: 3px; }
.nm-pwa-banner__actions { display: flex; align-items: center; gap: 7px; flex: 0 0 auto; }
.nm-pwa-btn {
  border: 1px solid rgba(255,255,255,.14); border-radius: 9px; background: transparent;
  color: #c9c9d4; cursor: pointer; padding: 8px 13px;
  font: 600 12px/1 var(--font-sans, Inter, system-ui, sans-serif); white-space: nowrap;
}
.nm-pwa-btn:hover { background: rgba(255,255,255,.07); color: #fff; }
.nm-pwa-btn--primary {
  background: linear-gradient(135deg, #8b5cf6, #6d28d9);
  border-color: transparent; color: #fff;
  box-shadow: 0 6px 18px rgba(139,92,246,.3);
}
.nm-pwa-btn--primary:hover { filter: brightness(1.08); background: linear-gradient(135deg, #8b5cf6, #6d28d9); }
.nm-pwa-banner__close {
  border: 0; background: transparent; color: #6a6a80; cursor: pointer;
  font-size: 17px; line-height: 1; padding: 4px 6px; border-radius: 7px;
}
.nm-pwa-banner__close:hover { background: rgba(255,255,255,.06); color: #fff; }
@media (max-width: 520px) {
  .nm-pwa-banner { flex-wrap: wrap; }
  .nm-pwa-banner__actions { width: 100%; justify-content: flex-end; }
}
`;

  const state = {
    deferredPrompt: null,
    banner: null,
    installed: false,
    dismissed: false,
    showTimer: null,
  };

  /* ─── Estilos ────────────────────────────────────────────────────────── */

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  /* ─── Detección ─────────────────────────────────────────────────────── */

  function isStandalone() {
    try {
      return (
        window.matchMedia('(display-mode: standalone)').matches ||
        window.navigator.standalone === true
      );
    } catch {
      return false;
    }
  }

  function isIOS() {
    const ua = String(navigator.userAgent || '');
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  function wasDismissed() {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  }

  function markDismissed() {
    try {
      sessionStorage.setItem(DISMISS_KEY, '1');
    } catch { /* modo privado */ }
  }

  /* ─── Banner ─────────────────────────────────────────────────────────── */

  function buildBanner() {
    if (state.banner) return state.banner;

    injectStyles();

    const banner = document.createElement('div');
    banner.className = 'nm-pwa-banner';
    banner.setAttribute('role', 'dialog');
    banner.setAttribute('aria-label', 'Instalar Numination');

    const icon = document.createElement('div');
    icon.className = 'nm-pwa-banner__icon';
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M21 19v2H3v-2"></path></svg>';

    const body = document.createElement('div');
    body.className = 'nm-pwa-banner__body';

    const title = document.createElement('div');
    title.className = 'nm-pwa-banner__title';
    title.textContent = 'Instalá Numination';

    const text = document.createElement('div');
    text.className = 'nm-pwa-banner__text';
    text.textContent = 'Tenelo a mano como app: acceso directo, más rápido y funciona sin conexión.';

    body.append(title, text);

    const actions = document.createElement('div');
    actions.className = 'nm-pwa-banner__actions';

    const installBtn = document.createElement('button');
    installBtn.className = 'nm-pwa-btn nm-pwa-btn--primary';
    installBtn.type = 'button';
    installBtn.textContent = 'Instalar';
    installBtn.addEventListener('click', () => triggerInstall());

    const laterBtn = document.createElement('button');
    laterBtn.className = 'nm-pwa-btn';
    laterBtn.type = 'button';
    laterBtn.textContent = 'Ahora no';
    laterBtn.addEventListener('click', () => hide(true));

    const closeBtn = document.createElement('button');
    closeBtn.className = 'nm-pwa-banner__close';
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Cerrar');
    closeBtn.addEventListener('click', () => hide(true));

    actions.append(laterBtn, installBtn, closeBtn);

    banner.append(icon, body, actions);
    document.body.appendChild(banner);

    state.banner = banner;

    return banner;
  }

  function show(delayMs = 2600) {
    if (state.installed || state.dismissed || wasDismissed()) return false;
    if (!state.deferredPrompt && !isIOS()) return false;

    const banner = buildBanner();

    clearTimeout(state.showTimer);
    state.showTimer = setTimeout(() => {
      banner.classList.add('is-visible');
    }, delayMs);

    return true;
  }

  function hide(dismiss = false) {
    if (dismiss) {
      state.dismissed = true;
      markDismissed();
    }
    clearTimeout(state.showTimer);
    if (state.banner) state.banner.classList.remove('is-visible');
  }

  /* ─── Instalación ────────────────────────────────────────────────────── */

  async function triggerInstall() {
    if (!state.deferredPrompt) {
      // iOS / Firefox: se muestran las instrucciones manuales.
      showManualInstructions();
      return { ok: false, reason: 'no_prompt' };
    }

    try {
      state.deferredPrompt.prompt();
      const choice = await state.deferredPrompt.userChoice;

      hide(choice.outcome !== 'accepted');

      if (choice.outcome === 'accepted') {
        state.installed = true;
        document.dispatchEvent(new CustomEvent('numination:pwa-installed', { detail: { source: 'prompt' } }));
        return { ok: true, outcome: choice.outcome };
      }

      return { ok: false, outcome: choice.outcome };
    } catch (e) {
      console.warn('[pwa-installer] falló la instalación', e);
      hide(true);
      return { ok: false, error: e.message };
    }
  }

  function showManualInstructions() {
    const text = isIOS()
      ? 'En Safari: tocá el botón Compartir y elegí "Agregar a pantalla de inicio".'
      : 'Abrí el menú del navegador y elegí "Instalar aplicación" o "Agregar a la pantalla de inicio".';

    const banner = buildBanner();
    const textEl = banner.querySelector('.nm-pwa-banner__text');
    const installBtn = banner.querySelector('.nm-pwa-btn--primary');

    if (textEl) textEl.textContent = text;
    if (installBtn) {
      installBtn.textContent = 'Entendido';
      installBtn.onclick = () => hide(true);
    }

    banner.classList.add('is-visible');
  }

  /* ─── Eventos ────────────────────────────────────────────────────────── */

  function onBeforeInstallPrompt(e) {
    // Sin preventDefault: se guarda el evento para mostrarlo después.
    e.preventDefault?.();
    state.deferredPrompt = e;
    show();
  }

  function onAppInstalled() {
    state.installed = true;
    state.deferredPrompt = null;
    hide(true);
    document.dispatchEvent(new CustomEvent('numination:pwa-installed', { detail: { source: 'appinstalled' } }));
  }

  /* ─── Montaje ────────────────────────────────────────────────────────── */

  function init() {
    injectStyles();

    if (isStandalone()) {
      state.installed = true;
      return { installed: true };
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onAppInstalled);

    // Si el evento ya pasó (a veces pasa antes del script), se consulta
    // el atributo de la app instalada.
    try {
      if (window.matchMedia('(display-mode: standalone)').matches) {
        state.installed = true;
      }
    } catch { /* noop */ }

    return { installed: state.installed };
  }

  window.NumPwaInstaller = {
    init,
    show,
    hide,
    triggerInstall,
    showManualInstructions,
    get canInstall() { return Boolean(state.deferredPrompt); },
    get installed() { return state.installed; },
    get isIOS() { return isIOS(); },
  };

  document.addEventListener('DOMContentLoaded', init, { once: true });
})();
