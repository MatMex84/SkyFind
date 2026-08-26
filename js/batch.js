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
    // Camera + quota, usati SOLO per calcolare la posizione GPS del target (vedi geo_utils.js).
    // Non influenzano il rilevamento colore in sé: se lasciati vuoti, il batch funziona comunque
    // com'era prima, semplicemente senza coordinate del singolo target (solo del centro foto).
    georef: {
      droneId: null, // impostato al primo drone rilevante in buildOnce
      custom: { sensor_width_mm: 6.3, focal_length_mm: 4.5 },
      fallbackAltitudeM: null,
    },
    // Filtro geometrico sui blob rilevati (punto 2): scarta forme troppo allungate (aspect
    // ratio) e, quando il GSD è disponibile per la foto (sezione 3 sopra), aree reali implausibili
    // per un indumento/persona vista dall'alto. Ogni soglia a null/vuoto disattiva quel singolo
    // controllo, non l'intero filtro — vedi passesGeometricFilter() in detect_worker.js.
    geomFilter: { minAreaM2: 0.05, maxAreaM2: 8, maxAspectRatio: 6 },
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

  // ------------------------------------------------------------- camera + quota (georeferenziazione target)
  /** Sensore/focale da usare per il calcolo del GSD, o null se non ancora impostati (custom incompleto). */
  function resolveGeorefSensor() {
    const d = DRONES.find((x) => x.id === st.georef.droneId);
    if (!d) return null;
    if (d.sensor_width_mm === null) {
      const c = st.georef.custom;
      if (!(c.sensor_width_mm > 0) || !(c.focal_length_mm > 0)) return null;
      return { sensor_width_mm: c.sensor_width_mm, focal_length_mm: c.focal_length_mm };
    }
    return { sensor_width_mm: d.sensor_width_mm, focal_length_mm: d.focal_length_mm };
  }

  function renderGeorefCustomFields() {
    const wrap = document.getElementById('batch-georef-custom');
    if (!wrap) return;
    const d = DRONES.find((x) => x.id === st.georef.droneId);
    if (!d || d.sensor_width_mm !== null) {
      wrap.innerHTML = '';
      return;
    }
    const c = st.georef.custom;
    wrap.innerHTML = `
      <div class="sf-grid-2">
        <div>
          <label class="sf-label">Larghezza sensore (mm)</label>
          <input type="number" step="0.1" min="0.1" id="batch-sensor-width" value="${c.sensor_width_mm}">
        </div>
        <div>
          <label class="sf-label">Lunghezza focale reale (mm, non equivalente)</label>
          <input type="number" step="0.1" min="0.1" id="batch-focal-length" value="${c.focal_length_mm}">
        </div>
      </div>
      <p class="sf-caption">Stessi valori del Mission Planner per questo drone, se li hai già inseriti lì.</p>
    `;
    document.getElementById('batch-sensor-width').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      st.georef.custom.sensor_width_mm = Number.isFinite(v) ? v : 0;
    });
    document.getElementById('batch-focal-length').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      st.georef.custom.focal_length_mm = Number.isFinite(v) ? v : 0;
    });
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
      sensor: resolveGeorefSensor(), // per il GSD/posizione GPS del target, non per il rilevamento colore
      fallbackAltitudeM: st.georef.fallbackAltitudeM,
      geomFilter: st.geomFilter,
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
            results[gi] = {
              name: files[gi].name, width: 0, height: 0,
              gps_lat: null, gps_lon: null, gps_altitude: null, datetime_original: null,
              detections: [], error: String(e.message || e),
              geom_filter_rejected: null,
            };
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

    let detectionsWithGeo = 0;
    const geoMissingReasons = new Set();
    results.forEach((r) =>
      (r.detections || []).forEach((d) => {
        if (d.target_lat !== null && d.target_lat !== undefined) detectionsWithGeo++;
        else if (d.geo_note) geoMissingReasons.add(d.geo_note);
      })
    );

    // Riepilogo del filtro geometrico (punto 2): quanti blob sono stati scartati e perché,
    // così l'utente capisce se le soglie in sezione 5 sono troppo/poco severe per questa missione.
    const geomRejected = { aspect_ratio: 0, area_troppo_piccola: 0, area_troppo_grande: 0 };
    let geomRejectedTotal = 0;
    results.forEach((r) => {
      const g = r.geom_filter_rejected;
      if (!g) return;
      for (const k of Object.keys(geomRejected)) {
        geomRejected[k] += g[k] || 0;
        geomRejectedTotal += g[k] || 0;
      }
    });
    const GEOM_REASON_LABELS = {
      aspect_ratio: 'forma troppo allungata',
      area_troppo_piccola: 'area troppo piccola',
      area_troppo_grande: 'area troppo grande',
    };

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
        totalDetections
          ? `<p class="sf-caption" style="margin-top:0.6rem;">📍 Posizione GPS calcolata per <strong>${detectionsWithGeo}/${totalDetections}</strong>
             target rilevati.${geoMissingReasons.size ? ' Per gli altri manca: ' + Array.from(geoMissingReasons).map((s) => SF.escapeHtml(s)).join('; ') + '.' : ''}</p>`
          : ''
      }
      ${
        geomRejectedTotal
          ? `<p class="sf-caption">📐 Filtro geometrico: <strong>${geomRejectedTotal}</strong> blob scartati prima del ritaglio
             (${Object.keys(geomRejected).filter((k) => geomRejected[k]).map((k) => `${geomRejected[k]} ${GEOM_REASON_LABELS[k]}`).join(', ')}).
             Se sembrano troppi (o troppo pochi), regola le soglie nella sezione 5 e riavvia il batch.</p>`
          : ''
      }
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
    const droneFilter = typeof SF.isWideRgbColorCamera === 'function' ? SF.isWideRgbColorCamera : () => true;
    const georefDrones = DRONES.filter(droneFilter);
    if (!st.georef.droneId) st.georef.droneId = georefDrones.length ? georefDrones[0].id : DRONES[0].id;
    const droneOptions = georefDrones
      .map((d) => `<option value="${d.id}">${SF.escapeHtml(d.drone)} — ${SF.escapeHtml(d.sensore)}</option>`)
      .join('');

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

      <h2 class="sf-section">3. Camera e posizione GPS del target</h2>
      <p class="sf-caption">SkyFind calcola la posizione GPS di ogni target rilevato (non solo del centro foto):
        servono la camera in uso — come nel Mission Planner — e la quota di volo.</p>
      <label class="sf-label">Drone e camera in uso</label>
      <select id="batch-drone-select">${droneOptions}</select>
      <div id="batch-georef-custom" style="margin-top:0.7rem;"></div>
      <label class="sf-label" style="margin-top:0.9rem;">Quota di volo di riserva (AGL, metri) — opzionale</label>
      <input type="number" step="1" min="1" id="batch-fallback-altitude" placeholder="es. 40">
      <p class="sf-caption">Usata solo per le foto <em>senza</em> quota relativa nei metadati DJI
        (<code>drone-dji:RelativeAltitude</code>, presente sulla stragrande maggioranza delle foto DJI): se il dato
        c'è nella foto, ha sempre la precedenza su questo valore. Se lasci vuoto e manca anche nella foto, per
        quelle foto i target vengono comunque rilevati ma senza una loro posizione GPS specifica (resta solo la
        posizione del drone al momento dello scatto, come prima).</p>

      <h2 class="sf-section">4. Modalità di rilevamento</h2>
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

      <h2 class="sf-section">5. Filtro geometrico sui blob rilevati</h2>
      <p class="sf-caption">Dopo il rilevamento del colore, scarta automaticamente le forme che difficilmente
        sono un indumento o una persona vista dall'alto: troppo allungate, oppure — se camera e quota sono
        configurate in sezione 3 — con un'area reale troppo piccola (rumore) o troppo grande (terreno,
        vegetazione dello stesso colore). Sono soglie euristiche, non limiti scientifici: lascia vuoto un
        campo per disattivare solo quel controllo.</p>
      <div class="sf-grid-2">
        <div>
          <label class="sf-label">Area minima (m²)</label>
          <input type="number" step="0.01" min="0" id="batch-min-area-m2" value="${st.geomFilter.minAreaM2}" placeholder="es. 0.05">
        </div>
        <div>
          <label class="sf-label">Area massima (m²)</label>
          <input type="number" step="0.1" min="0" id="batch-max-area-m2" value="${st.geomFilter.maxAreaM2}" placeholder="es. 8">
        </div>
      </div>
      <label class="sf-label" style="margin-top:0.9rem;">Aspect ratio massimo (lato lungo / lato corto)</label>
      <input type="number" step="0.5" min="1" id="batch-max-aspect-ratio" value="${st.geomFilter.maxAspectRatio}" placeholder="es. 6">
      <p class="sf-caption">I due campi sull'area richiedono camera e quota configurate in sezione 3: se
        mancano, per quella foto viene applicato solo il controllo sull'aspect ratio (sempre attivo, non
        richiede il GSD).</p>

      <h2 class="sf-section">6. Avvia elaborazione</h2>
      <div id="batch-start-section"></div>
      <div id="batch-progress-wrap"></div>
      <div id="batch-results-section"></div>
    `;

    document.getElementById('batch-detection-mode').addEventListener('change', (e) => (st.detectionMode = e.target.value));
    document.getElementById('batch-require-gps').addEventListener('change', (e) => (st.requireGps = e.target.checked));

    document.getElementById('batch-drone-select').value = st.georef.droneId;
    document.getElementById('batch-drone-select').addEventListener('change', (e) => {
      st.georef.droneId = e.target.value;
      renderGeorefCustomFields();
    });
    renderGeorefCustomFields();
    document.getElementById('batch-fallback-altitude').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      st.georef.fallbackAltitudeM = Number.isFinite(v) && v > 0 ? v : null;
    });

    document.getElementById('batch-min-area-m2').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      st.geomFilter.minAreaM2 = Number.isFinite(v) && v > 0 ? v : null;
    });
    document.getElementById('batch-max-area-m2').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      st.geomFilter.maxAreaM2 = Number.isFinite(v) && v > 0 ? v : null;
    });
    document.getElementById('batch-max-aspect-ratio').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      st.geomFilter.maxAspectRatio = Number.isFinite(v) && v > 0 ? v : null;
    });

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
