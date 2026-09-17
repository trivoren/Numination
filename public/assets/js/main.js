/* ============================================================
   Numination — entrypoint del frontend
   ============================================================ */

import { initTheme }        from './modules/theme-toggle.js';
import { initMobileMenu }   from './modules/mobile-menu.js';
import { initSmoothScroll } from './modules/smooth-scroll.js';
import { initCounters }     from './modules/counters.js';
import { initScrollReveal } from './modules/scroll-reveal.js';
import { initChatPreview }  from './modules/chat-preview.js';
import { initContactForm }  from './modules/contact-form.js';
import { initChat }         from './modules/chat.js';

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initMobileMenu();
  initSmoothScroll();
  initCounters();
  initScrollReveal();
  initChatPreview();
  initContactForm();
  initChat();
});