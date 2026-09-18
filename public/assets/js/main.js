/* ============================================================
   Numination — entrypoint del frontend
   ============================================================ */

import { initTheme }        from './modules/theme-toggle.js';
import { initMobileMenu }   from './modules/mobile-menu.js';
import { initSmoothScroll } from './modules/smooth-scroll.js';
import { initCounters }     from './modules/counters.js';
import { initScrollReveal } from './modules/scroll-reveal.js';
import { initContactForm }  from './modules/contact-form.js';
import { initChat }         from './modules/chat.js';
import { initChatMedia }    from './modules/chat-media.js';
import { initChatAudio }    from './modules/chat-audio.js';

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initMobileMenu();
  initSmoothScroll();
  initCounters();
  initScrollReveal();
  initContactForm();
  initChat();
  initChatMedia();
  initChatAudio();
});