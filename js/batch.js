/**
 * Modulo 3 - Elaborazione Batch: applica il profilo colore calibrato a un lotto di
 * foto di missione usando un pool di Web Worker (uno per core) con OpenCV.js.
 * Nessuna impostazione avanzata esposta: valori di default già ottimizzati
 * (porta 1:1 di modules/image_processing.py:ProcessingConfig).
 */
window.SF = window.SF || {};

(function () {
  'use strict';

  const IMAGE_EXT_RE = /\.(jpe?g|png|tiff?|bmp)$/i;
  const DETECTION_MODE_LABELS = {
    hsv: '⚡ Standard (veloce)',
    lab: '🌤️ Robusto a ombre e controluce',
    both: '🎯 Massima precisione (più lento, meno falsi positivi)',
  };
  const FIXED_CONFIG = {
    downscaleMaxDim: 1600,
    minAreaPxFullres: 400,
    morphKernel: 5,
    maxDetectionsPerImage: 8,
    cropPaddingPx: 20,
  };

  const st = {
    built: false,
    sourceMode: 'folder', // 'folder' | 'upload'
    files: [],
    detectionMode: 'hsv',
    requireGps: false,
    running: false,
  };

  function filterImages(fileList) {
    return Array.from(fileList).filter((f) => IMAGE_EXT_RE.test(f.name));
  }

  function renderSourceStatus() {
    const out = document.getElementById('batch-source-status');
    if (!out) return;
    if (!st.files.length) {
      out.innerHTML = '<div class="sf-info">Indica una cartella o carica delle foto per procedere.</div>';
    } else {
      out.innerHTML = `<div class="sf-success">${st.files.length} foto trovate.</div>`;
    }
    renderStartSection();
  }

  function renderSourceBody() {
    const body = document.getElementById('batch-source-body');
    if (st.sourceMode === 'folder') {
      body.innerHTML = `
        <div class="sf-info">Per lotti di centinaia di foto 4K usa la <strong>cartella locale</strong>: le foto vengono
          lette direttamente dal disco, elaborate qui nel browser e non lasciano mai il tuo computer.</div>
        <label class="sf-btn primary" for="batch-folder-input">📂 Sfoglia...</label>
        <input type="file" id="batch-folder-input" webkitdirectory directory multiple style="display:none;">
        <div id="batch-source-status" style="margin-top:0.6rem;"></div>
      `;
      document.getElementById('batch-folder-input').addEventListener('change', (e) => {
        st.files = filterImages(e.target.files);
        renderSourceStatus();
      });
    } else {
      body.innerHTML = `
        <label class="sf-label">Foto di missione</label>
        <input type="file" id="batch-upload-input" accept="image/*" multiple>
        <div id="batch-source-status" style="margin-top:0.6rem;"></div>
      `;
      document.getElementById('batch-upload-input').addEventListener('change', (e) => {
        st.files = filterImages(e.target.files);
        renderSourceStatus();
      });
    }
    renderSourceStatus();
  }

  function renderStartSection() {
    const out = document.getElementById('batch-start-section');
    if (!out) return;
    if (st.running) return;
    if (!st.files.length) {
      out.innerHTML = '';
      return;
    }
    out.innerHTML = `<button class="sf-btn primary" id="batch-start-btn">▶️ Avvia elaborazione batch</button>`;
    document.getElementById('batch-start-btn').addEventListener('click', runBatch);
  }

  // ------------------------------------------------------------- pool di worker
  function runBatch() {
    const profileName = document.getElementById('batch-profile-select').value;
    const profile = SF.getProfile(profileName);
    if (!profile) return;

    st.running = true;
    document.getElementById('batch-start-section').innerHTML = '';
    const progressWrap = document.getElementById('batch-progress-wrap');
    progressWrap.innerHTML = `
      <div class="sf-progress-outer"><div class="sf-progress-inner" id="batch-progress-inner"></div></div>
      <p class="sf-caption" id="batch-progress-text">0/${st.files.length} foto elaborate</p>
    `;
    document.getElementById('batch-results-section').innerHTML = '';

    const config = {
      colorSpace: st.detectionMode,
      downscaleMaxDim: FIXED_CONFIG.downscaleMaxDim,
      minAreaPxFullres: FIXED_CONFIG.minAreaPxFullres,
      morphKernel: FIXED_CONFIG.morphKernel,
      maxDetectionsPerImage: FIXED_CONFIG.maxDetectionsPerImage,
      cropPaddingPx: FIXED_CONFIG.cropPaddingPx,
      requireGps: st.requireGps,
    };

    const files = st.files;
    const nWorkers = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4, files.length));
    const chunks = Array.from({ length: nWorkers }, () => []);
    files.forEach((f, i) => chunks[i % nWorkers].push(f));

    const results = new Array(files.length).fill(null);
    let completedCount = 0;
    let workersDone = 0;
    const t0 = performance.now();

    // mappa: worker -> lista di indici globali (nello stesso ordine dei file inviati a quel worker)
    const chunkGlobalIndices = [];
    {
      let cursor = 0;
      const perWorkerFiles = Array.from({ length: nWorkers }, () => []);
      files.forEach((f, i) => perWorkerFiles[i % nWorkers].push(f));
      for (let w = 0; w < nWorkers; w++) {
        const idxs = [];
        for (let i = 0; i < perWorkerFiles[w].length; i++) idxs.push(w + i * nWorkers);
        chunkGlobalIndices.push(idxs);
      }
    }

    function updateProgress() {
      const pct = files.length ? (100 * completedCount) / files.length : 0;
      const inner = document.getElementById('batch-progress-inner');
      const text = document.getElementById('batch-progress-text');
      if (inner) inner.style.width = pct.toFixed(1) + '%';
      const nMatches = results.filter((r) => r && r.detections && r.detections.length).length;
      if (text) text.textContent = `${completedCount}/${files.length} foto elaborate — ${nMatches} con rilevamenti`;
    }

    function finishIfDone() {
      if (workersDone < nWorkers) return;
      const elapsed = (performance.now() - t0) / 1000;
      st.running = false;
      SF.state.batchResults = results;
      SF.state.batchFiles = files;
      SF.state.batchProfileName = profileName;
      SF.updateSidebarStatus();
      renderBatchSummary(elapsed);
      renderStartSection();
    }

    for (let w = 0; w < nWorkers; w++) {
      const worker = new Worker('detect_worker.js');
      const globalIdxs = chunkGlobalIndices[w];
      worker.onmessage = (e) => {
        const data = e.data;
        if (data.done) {
          workersDone++;
          worker.terminate();
          finishIfDone();
          return;
        }
        results[globalIdxs[data.index]] = data.result;
        completedCount++;
        updateProgress();
      };
      worker.onerror = (e) => {
        // un worker in errore non deve bloccare l'intero batch: segna i suoi file come errore e prosegui
        for (const gi of globalIdxs) {
          if (!results[gi]) {
            results[gi] = { name: files[gi].name, width: 0, height: 0, detections: [], error: String(e.message || e) };
            completedCount++;
          }
        }
        workersDone++;
        updateProgress();
        finishIfDone();
      };
      worker.postMessage({ type: 'process', files: chunks[w], profile: profile, config: config, jobId: w });
    }
  }

  function renderBatchSummary(elapsed) {
    const results = SF.state.batchResults;
    const totalDetections = results.reduce((s, r) => s + (r.detections ? r.detections.length : 0), 0);
    const withDetections = results.filter((r) => r.detections && r.detections.length).length;
    const errors = results.filter((r) => r.error);
    const skipped = results.filter((r) => r.skipped_reason);

    document.getElementById('batch-progress-wrap').innerHTML = '';
    const out = document.getElementById('batch-results-section');
    out.innerHTML = `
      <div class="sf-success">Elaborazione completata in ${elapsed.toFixed(1)}s (${(results.length / elapsed).toFixed(1)} foto/s).</div>
      <div class="sf-grid-4">
        <div class="sf-metric"><div class="sf-metric-label">Foto elaborate</div><div class="sf-metric-value">${results.length}</div></div>
        <div class="sf-metric"><div class="sf-metric-label">Foto con rilevamenti</div><div class="sf-metric-value">${withDetections}</div></div>
        <div class="sf-metric"><div class="sf-metric-label">Target individuati</div><div class="sf-metric-value">${totalDetections}</div></div>
        <div class="sf-metric"><div class="sf-metric-label">Scartate/errori</div><div class="sf-metric-value">${skipped.length + errors.length}</div></div>
      </div>
      ${
        errors.length
          ? `<details class="sf-expander"><summary>⚠️ ${errors.length} foto con errori di lettura</summary>
             ${errors.map((r) => `<div class="sf-caption">${SF.escapeHtml(r.name)}: ${SF.escapeHtml(r.error)}</div>`).join('')}
             </details>`
          : ''
      }
      <div class="sf-info">Vai al modulo <strong>📋 Report</strong> per vedere i ritagli, le coordinate e generare il report finale.</div>
      <button class="sf-btn primary" id="batch-goto-report">📋 Vai al Report</button>
    `;
    document.getElementById('batch-goto-report').addEventListener('click', () => SF.navigate('report'));
  }

  // ------------------------------------------------------------- build
  function buildOnce() {
    const container = document.getElementById('batch-content');
    const saved = SF.listProfiles();
    if (!saved.length) {
      container.innerHTML =
        '<div class="sf-warning">Nessun profilo colore salvato. Vai prima al modulo <strong>🎨 Calibrazione Colore</strong> per crearne uno.</div>';
      st.built = false; // ririprova la costruzione completa quando un profilo esisterà
      return;
    }

    const profileOptions = saved.map((p) => `<option value="${SF.escapeHtml(p.name)}">${SF.escapeHtml(p.name)}</option>`).join('');

    container.innerHTML = `
      <h2 class="sf-section">1. Profilo colore</h2>
      <label class="sf-label">Profilo da usare per il rilevamento</label>
      <select id="batch-profile-select">${profileOptions}</select>
      <div id="batch-profile-swatch" style="margin-top:0.5rem;"></div>

      <h2 class="sf-section">2. Sorgente immagini</h2>
      <div class="sf-radio-row" id="batch-source-radio">
        <label><input type="radio" name="batch-source" value="folder" checked> Cartella locale (consigliato)</label>
        <label><input type="radio" name="batch-source" value="upload"> Carica file (pochi scatti)</label>
      </div>
      <div id="batch-source-body"></div>

      <h2 class="sf-section">3. Modalità di rilevamento</h2>
      <div class="sf-grid-2">
        <div>
          <label class="sf-label">Come cercare il colore nelle foto?</label>
          <select id="batch-detection-mode">
            ${Object.entries(DETECTION_MODE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
          </select>
          <p class="sf-caption">"Massima precisione" è la più severa (un pixel deve superare due controlli invece di
            uno): riduce i falsi positivi, ma su un indumento reale può mostrare una confidenza più bassa dello
            "Standard" — non è un errore, è normale. Se non sei sicuro parti da "Standard".</p>
        </div>
        <div>
          <label class="sf-label"><input type="checkbox" id="batch-require-gps"> Scarta foto senza posizione GPS</label>
          <p class="sf-caption">Utile se vuoi solo target georiferiti sulla mappa nel report finale.</p>
        </div>
      </div>

      <h2 class="sf-section">4. Avvia elaborazione</h2>
      <div id="batch-start-section"></div>
      <div id="batch-progress-wrap"></div>
      <div id="batch-results-section"></div>
    `;

    document.getElementById('batch-detection-mode').addEventListener('change', (e) => (st.detectionMode = e.target.value));
    document.getElementById('batch-require-gps').addEventListener('change', (e) => (st.requireGps = e.target.checked));

    container.querySelectorAll('input[name="batch-source"]').forEach((r) => {
      r.addEventListener('change', (e) => {
        st.sourceMode = e.target.value;
        st.files = [];
        renderSourceBody();
      });
    });
    renderSourceBody();

    SF.loadCv().then((cv) => {
      const p = SF.getProfile(document.getElementById('batch-profile-select').value);
      if (p) {
        document.getElementById('batch-profile-swatch').innerHTML =
          `<div style="display:flex; align-items:center; gap:0.6rem;">
            <div style="width:36px;height:36px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background-color:${profileHexColor(cv, p)};"></div>
            <span class="sf-caption">Colore target del profilo <strong>${SF.escapeHtml(p.name)}</strong></span>
          </div>`;
      }
    });
    document.getElementById('batch-profile-select').addEventListener('change', async () => {
      const cv = await SF.loadCv();
      const p = SF.getProfile(document.getElementById('batch-profile-select').value);
      if (p) {
        document.getElementById('batch-profile-swatch').innerHTML =
          `<div style="display:flex; align-items:center; gap:0.6rem;">
            <div style="width:36px;height:36px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background-color:${profileHexColor(cv, p)};"></div>
            <span class="sf-caption">Colore target del profilo <strong>${SF.escapeHtml(p.name)}</strong></span>
          </div>`;
      }
    });

    st.built = true;
  }

  SF.init_batch = function () {
    if (st.running) return; // non ricostruire la UI mentre un batch e' in corso
    buildOnce();
  };
})();
