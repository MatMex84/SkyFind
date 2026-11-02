/**
 * Bootstrap dell'app: routing tra pagine, caricamento OpenCV.js condiviso,
 * storage dei profili colore (localStorage) e stato missione in sidebar.
 *
 * Tutta l'app gira in un'unica pagina HTML: nessun upload, nessun server —
 * le foto vengono lette direttamente dal disco locale via File API.
 */

window.SF = window.SF || {};

(function () {
  'use strict';

  const PROFILES_KEY = 'skyfind_profiles_v1';

  // ---------------- OpenCV.js loader (condiviso da tutte le pagine) ----------------
  let cvReadyPromise = null;
  SF.loadCv = function () {
    if (!cvReadyPromise) {
      cvReadyPromise = (async () => {
        if (window.cv && typeof window.cv.then === 'function') {
          window.cv = await window.cv;
        }
        return window.cv;
      })();
    }
    return cvReadyPromise;
  };

  // ---------------- Stato missione (in memoria, per sidebar + Report) ----------------
  SF.state = {
    batchResults: null, // array di ImageResult-like objects prodotti dal worker
    batchProfileName: null,
  };

  // ---------------- Storage profili colore ----------------
  function readProfilesRaw() {
    try {
      const raw = localStorage.getItem(PROFILES_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }
  function writeProfilesRaw(obj) {
    localStorage.setItem(PROFILES_KEY, JSON.stringify(obj));
  }

  SF.listProfiles = function () {
    const raw = readProfilesRaw();
    return Object.keys(raw)
      .sort()
      .map((k) => raw[k]);
  };

  SF.saveProfile = function (profile) {
    const raw = readProfilesRaw();
    raw[profile.name] = profile;
    writeProfilesRaw(raw);
  };

  SF.deleteProfile = function (name) {
    const raw = readProfilesRaw();
    delete raw[name];
    writeProfilesRaw(raw);
  };

  SF.getProfile = function (name) {
    const raw = readProfilesRaw();
    return raw[name] || null;
  };

  // ---------------- Helpers UI ----------------
  SF.escapeHtml = function (s) {
    const div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  };

  SF.formatNum = function (n, decimals) {
    if (n === null || n === undefined || Number.isNaN(n)) return 'n/d';
    return Number(n).toFixed(decimals === undefined ? 1 : decimals);
  };

  // ---------------- Routing ----------------
  const pages = ['home', 'mission', 'calibrazione', 'batch', 'report'];
  let currentPage = null;

  function updateSidebarStatus() {
    const profileReady = SF.listProfiles().length > 0;
    const batchReady = !!(SF.state.batchResults && SF.state.batchResults.length);
    const rows = [
      ['Profilo colore calibrato', profileReady],
      ['Elaborazione batch eseguita', batchReady],
    ];
    const strip = document.getElementById('home-status');
    if (strip) {
      strip.innerHTML = rows
        .map(([label, done]) => `<span class="sf-chip ${done ? 'done' : ''}">${done ? '✓' : '○'} ${SF.escapeHtml(label)}</span>`)
        .join('');
    }
    const container = document.getElementById('sf-status-rows');
    if (!container) return;
    container.innerHTML = rows
      .map(
        ([label, done]) =>
          `<div class="sf-status-row"><span class="sf-status-dot ${done ? 'done' : ''}"></span>${
            done ? '✓' : '—'
          } ${SF.escapeHtml(label)}</div>`
      )
      .join('');
  }
  SF.updateSidebarStatus = updateSidebarStatus;

  // ---------------- Barra "Indietro / Avanti" a fine pagina: porta alla fase successiva del flusso ----------------
  const FLOW = {
    mission: { prev: 'home', next: 'calibrazione' },
    calibrazione: { prev: 'mission', next: 'batch' },
    batch: { prev: 'calibrazione', next: 'report' },
    report: { prev: 'batch', next: null },
  };
  const FLOW_TITLES = { home: 'Home', mission: 'Mission Planner', calibrazione: 'Calibrazione Colore', batch: 'Elaborazione Batch', report: 'Report' };
  function renderPageNav() {
    document.querySelectorAll('.sf-pagenav').forEach((el) => {
      const f = FLOW[el.dataset.page];
      if (!f) return;
      const prev = f.prev ? `<button type="button" class="sf-btn" data-go="${f.prev}">${SF.icon('arrow-left')} ${FLOW_TITLES[f.prev]}</button>` : '<span></span>';
      const next = f.next ? `<button type="button" class="sf-btn primary" data-go="${f.next}">Avanti: ${FLOW_TITLES[f.next]} ${SF.icon('arrow-right')}</button>` : '<span></span>';
      el.innerHTML = prev + next;
      el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => SF.navigate(b.dataset.go)));
    });
  }
  /** Singolare/plurale: SF.plural(1,'target','target') → '1 target'. Forme con la stessa parola per 1 e N non servono: si passa solo `one` e `many`. */
  SF.plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

  function showPage(name) {
    if (!pages.includes(name)) name = 'home';
    document.querySelectorAll('.sf-page').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.sf-nav-link').forEach((el) => el.classList.remove('active'));
    const pageEl = document.getElementById('page-' + name);
    const navEl = document.getElementById('nav-' + name);
    if (pageEl) pageEl.classList.add('active');
    if (navEl) navEl.classList.add('active');
    currentPage = name;
    updateSidebarStatus();
    // Chiama l'init della pagina (idempotente, ridisegna con lo stato corrente)
    const initFn = SF['init_' + name];
    if (typeof initFn === 'function') initFn();
    window.scrollTo(0, 0);
  }
  SF.navigate = function (name) {
    if (location.hash.slice(1) === name) {
      showPage(name);
    } else {
      location.hash = name;
    }
  };

  function onHashChange() {
    const name = location.hash.replace('#', '') || 'home';
    showPage(name);
  }

  window.addEventListener('hashchange', onHashChange);
  document.addEventListener('DOMContentLoaded', () => {
    if (SF.hydrateIcons) SF.hydrateIcons();
    renderPageNav();
    onHashChange();
  });
})();
