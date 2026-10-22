/**
 * Numination · Modo Coder — ide-events.js
 * Bus de eventos del IDE. Desacopla File Tree, Monaco, Chat, Terminal y Diff
 * sin que ninguno tenga una referencia directa a otro.
 *
 * Dos canales de escucha:
 *   1. `eventBus.on('file:opened', fn)`  → bus propio (rápido, sin DOM).
 *   2. `window.addEventListener('numination:file:opened', fn)` → CustomEvent
 *      nativo, útil para integración con código externo al IDE.
 *
 * Catálogo de eventos:
 *   editor:ready      { }                          Monaco inicializado.
 *   editor:change     { value }                    Contenido modificado (debounce).
 *   editor:dirty      { isDirty }                  Cambio de estado "sin guardar".
 *   editor:saved      { path }                     Archivo guardado.
 *   file:opened       { path, language, lines? }   Archivo abierto en Monaco.
 *   file:save         { path }                     Solicitud de guardado (Ctrl+S).
 *   tree:refresh      { }                          Recarga del árbol de archivos.
 *   chat:message      { role, content }            Mensaje enviado/recibido.
 *   chat:stream       { text }                     Fragmento de token recibido.
 *   chat:done         { provider, tokens }         Respuesta finalizada.
 *   chat:error        { message }                  Error del stream.
 *   diff:opened       { path }                     Modal de diff abierto.
 *   diff:applied      { path, added, removed }     Cambios aplicados al editor.
 *   diff:discarded    { path }                     Cambios descartados.
 *   term:command      { command, done }            Comando ejecutado.
 */

(function () {
  'use strict';

  /**
   * @typedef {(data: any) => void} EventHandler
   */

  /** @type {Map<string, Set<EventHandler>>} */
  const handlers = new Map();
  /** @type {Map<string, Set<EventHandler>>}Listeners con prefijo comodín */
  const wildcardHandlers = new Map();

  const eventBus = {
    /**
     * Suscribe un listener. Devuelve la función para desuscribir.
     * @param {string} evt Nombre del evento (soporta comodín final: "file:*").
     * @param {EventHandler} fn
     * @returns {() => void}
     */
    on(evt, fn) {
      if (typeof evt !== 'string' || typeof fn !== 'function') return () => {};
      const isWildcard = evt.endsWith(':*');
      const map = isWildcard ? wildcardHandlers : handlers;
      const key = isWildcard ? evt.slice(0, -1) : evt; // "file:*" → "file:"
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(fn);
      return () => eventBus.off(evt, fn);
    },

    /**
     * Cancela la suscripción.
     * @param {string} evt
     * @param {EventHandler} fn
     * @returns {void}
     */
    off(evt, fn) {
      if (typeof evt !== 'string' || typeof fn !== 'function') return;
      const isWildcard = evt.endsWith(':*');
      const map = isWildcard ? wildcardHandlers : handlers;
      const key = isWildcard ? evt.slice(0, -1) : evt;
      map.get(key)?.delete(fn);
    },

    /**
     * Suscribe un listener de un solo uso.
     * @param {string} evt
     * @param {EventHandler} fn
     * @returns {() => void}
     */
    once(evt, fn) {
      const wrapped = (data) => { eventBus.off(evt, wrapped); fn(data); };
      return eventBus.on(evt, wrapped);
    },

    /**
     * Emite un evento. Los errores de un listener no rompen el resto.
     * @param {string} evt
     * @param {any} [data]
     * @returns {void}
     */
    emit(evt, data) {
      if (typeof evt !== 'string') return;
      try {
        handlers.get(evt)?.forEach((fn) => {
          try { fn(data); } catch (err) { console.error(`[eventBus] listener de "${evt}" falló:`, err); }
        });
        const prefix = evt.split(':')[0] + ':';
        wildcardHandlers.get(prefix)?.forEach((fn) => {
          try { fn({ event: evt, data }); } catch (err) { console.error(`[eventBus] wildcard de "${evt}" falló:`, err); }
        });
      } catch (err) {
        console.error('[eventBus] emit falló:', err);
      }
      // Canal nativo: window.dispatchEvent
      try {
        window.dispatchEvent(new CustomEvent(`numination:${evt}`, { detail: data }));
      } catch (err) {
        console.error('[eventBus] dispatch falló:', err);
      }
    },

    /**
     * Elimina todos los listeners de un evento (o de todos si no se indica).
     * @param {string} [evt]
     * @returns {void}
     */
    clear(evt) {
      if (typeof evt === 'string') { handlers.delete(evt); return; }
      handlers.clear();
      wildcardHandlers.clear();
    }
  };

  /* Alias global que usan el resto de módulos del IDE. */
  window.eventBus = eventBus;
  window.NumEvents = eventBus;
  window.eventBusIsFallback = false;
})();
