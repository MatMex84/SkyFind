/**
 * icons.js — icone SVG in linea, tutte dello stesso stile, che prendono il colore del testo (currentColor).
 * Sostituiscono gli emoji nei punti chiave dell'interfaccia: un emoji cambia aspetto con il sistema operativo
 * (Windows, iPhone, Android), un'icona SVG è identica ovunque. Disegnate su griglia 24×24, tratto 1.8.
 * Uso: SF.icon('home') restituisce la stringa <svg>; gli elementi con data-icon="nome" vengono riempiti da SF.hydrateIcons().
 */
window.SF = window.SF || {};
(function () {
  'use strict';
  const P = {
    radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/><path d="M12 1.5v3M12 19.5v3M1.5 12h3M19.5 12h3"/>',
    home: '<path d="M3.5 11.2 12 4l8.5 7.2"/><path d="M5.5 9.8V20h13V9.8"/><path d="M10 20v-5.2h4V20"/>',
    plane: '<path d="M21 3 10.2 13.8"/><path d="m21 3-6.6 18-3.6-7.2L3.6 10.2z"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.3 0 2.1-.9 2.1-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 16.9 3 12 3z"/><circle cx="7.6" cy="11.2" r="1" fill="currentColor"/><circle cx="10.2" cy="7.2" r="1" fill="currentColor"/><circle cx="14.6" cy="7.2" r="1" fill="currentColor"/>',
    image: '<rect x="3" y="3.5" width="18" height="17" rx="2.5"/><circle cx="9" cy="9.2" r="1.6"/><path d="m21 15.5-4.8-4.8L6 20.5"/>',
    clipboard: '<rect x="8" y="2.5" width="8" height="4" rx="1.2"/><path d="M16 4.5h2A2 2 0 0 1 20 6.5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2h2"/><path d="M8.5 12h7M8.5 16h4.5"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.2"/><path d="M12 7.9h.01" stroke-width="2.4"/>',
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.2h7.5A2.5 2.5 0 0 1 21 9.7v7.8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
    ban: '<circle cx="12" cy="12" r="9"/><path d="m5.7 5.7 12.6 12.6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    download: '<path d="M12 4v11"/><path d="m7.5 11 4.5 4.5 4.5-4.5"/><path d="M5 20h14"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4.5V11h-6.5"/>',
    'arrow-right': '<path d="M4.5 12h15"/><path d="m13.5 6 6 6-6 6"/>',
    'arrow-left': '<path d="M19.5 12h-15"/><path d="m10.5 6-6 6 6 6"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  };
  SF.icon = function (name, cls) {
    const body = P[name];
    if (!body) return '';
    return '<svg class="sf-i' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + body + '</svg>';
  };
  SF.hydrateIcons = function (root) {
    (root || document).querySelectorAll('[data-icon]').forEach((el) => {
      if (!el.firstChild || el.dataset.iconDone !== '1') { el.innerHTML = SF.icon(el.dataset.icon); el.dataset.iconDone = '1'; }
    });
  };
})();
