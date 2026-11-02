/**
 * Modulo 3 - Elaborazione Batch: applica il profilo colore calibrato a un lotto di
 * foto di missione usando un pool di Web Worker (uno per core) con OpenCV.js.
 * Camera/posizione GPS e filtro geometrico vivono in un unico pannello "Impostazioni avanzate"
 * (collassato di default): entrambi sono normalmente automatici o già ben impostati di default —
 * i valori di default del filtro geometrico sono ragionevoli per la maggior parte dei casi (porta
 * 1:1 di modules/image_processing.py:ProcessingConfig, poi affinata nei punti 2/6/7 della roadmap).
 */
window.SF = window.SF || {};

(function () {
  'use strict';

  const IMAGE_EXT_RE = /\.(jpe?g|png|tiff?|bmp)$/i;

  // ------------------------------------------------------------- riconoscimento camera da EXIF
  // Tolleranza sulla lunghezza focale reale (mm) nel confronto con la tabella DRONES: assorbe gli
  // arrotondamenti tipici della rappresentazione RATIONAL dell'EXIF (es. 12.29 vs 12.3) senza
  // però confondere camere realmente diverse. Non è "quanto siamo permissivi nello scegliere" —
  // è il margine di errore di misura, quindi resta piccolo.
  const FOCAL_MATCH_TOLERANCE_MM = 0.15;

  /**
   * Trova le voci DRONES il cui fingerprint (dimensioni immagine + lunghezza focale reale) è
   * compatibile con quello letto dall'EXIF di una foto — MAI il tag Model, che i droni DJI non
   * scrivono in modo distinguibile tra le diverse camere dello stesso corpo drone (es.
   * grandangolare vs tele hanno lo stesso "Model" ma sensori/focali diversi).
   *
   * Ritorna un array: 0 elementi = nessun drone compatibile, 1 = riconoscimento univoco, 2+ =
   * fingerprint ambiguo (es. due generazioni con la stessa ottica, caso reale per M3E/M4E
   * grandangolare — differiscono di soli 0.01mm di focale nella tabella). Il chiamante decide se e
   * come mostrare l'esito: qui non si sceglie mai "il primo" tra più candidati, per non rischiare
   * una camera sbagliata in modo silenzioso — un GSD errato altererebbe il filtro geometrico per
   * area (impostazioni avanzate).
   */
  function findExifFingerprintMatches(exifImageWidth, exifImageHeight, focalLengthMm, drones) {
    if (!(exifImageWidth > 0) || !(exifImageHeight > 0) || !(focalLengthMm > 0)) return [];
    return drones.filter((d) => {
      if (!(d.image_width_px > 0) || !(d.image_height_px > 0) || !(d.focal_length_mm > 0)) return false; // es. 'custom'
      const dimsMatch =
        (d.image_width_px === exifImageWidth && d.image_height_px === exifImageHeight) ||
        (d.image_width_px === exifImageHeight && d.image_height_px === exifImageWidth); // foto verticale (ruotata)
      if (!dimsMatch) return false;
      return Math.abs(d.focal_length_mm - focalLengthMm) <= FOCAL_MATCH_TOLERANCE_MM;
    });
  }
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
    excludeColors: [],
    tolScale: {}, // nome profilo -> fattore di riduzione tolleranza scelto per questa elaborazione
    fitCache: {}, // colori da ESCLUDERE: [{ name, hex, profile }] — solo per questa sessione, mai salvati (nascondono pixel: meglio che si vedano sempre)
    extraProfiles: new Set(), // nomi dei profili AGGIUNTIVI cercati nello stesso lotto (oltre a quello scelto nella select)
    files: [],
    detectionMode: 'hsv',
    requireGps: false,
    running: false,
    // Camera + quota, usati SOLO per calcolare la posizione GPS del target (vedi geo_utils.js).
    // Non influenzano il rilevamento colore in sé: se lasciati vuoti, il batch funziona comunque
    // com'era prima, semplicemente senza coordinate del singolo target (solo del centro foto).
    georef: {
      droneId: null, // impostato al primo drone rilevante in buildOnce, o dal riconoscimento EXIF sotto
      custom: { sensor_width_mm: 6.3, focal_length_mm: 4.5 },
      fallbackAltitudeM: null,
      // Esito dell'ultimo tentativo di riconoscimento automatico da EXIF (vedi detectCameraFromExif):
      // null finché non è ancora stato tentato; poi {status: 'matched'|'ambiguous'|'unmatched'|'no-exif', ...}.
      // SOLO informativo per l'utente (nota a schermo): la select del drone resta sempre visibile e
      // modificabile, il riconoscimento automatico non nasconde né forza mai la scelta manuale.
      exifDetection: null,
    },
    // Filtro geometrico sui blob rilevati (punto 2): scarta forme troppo allungate (aspect
    // ratio) e, quando il GSD è disponibile (camera configurata sopra, in georef), aree reali
    // implausibili per un indumento/persona vista dall'alto. Ogni soglia a null/vuoto disattiva
    // quel singolo controllo, non l'intero filtro — vedi passesGeometricFilter() in detect_worker.js.
    geomFilter: { minAreaM2: 0.05, maxAreaM2: 8, maxAspectRatio: 6, mergeGapPx: 30 },
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
        <label class="sf-btn primary" for="batch-folder-input">${SF.icon('folder')} Sfoglia...</label>
        <input type="file" id="batch-folder-input" webkitdirectory directory multiple style="display:none;">
        <div id="batch-source-status" style="margin-top:0.6rem;"></div>
      `;
      document.getElementById('batch-folder-input').addEventListener('change', (e) => {
        st.files = filterImages(e.target.files);
        renderSourceStatus();
        detectCameraFromExif();
        startSceneAnalysis();
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
        detectCameraFromExif();
        startSceneAnalysis();
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

  /**
   * Riga SEMPRE visibile in sezione 2 (fuori dalle impostazioni avanzate, dove vivono select e
   * dettagli): la camera che verrà davvero usata per GPS/filtro area deve restare visibile anche a
   * pannello avanzato chiuso — altrimenti una camera sbagliata passerebbe inosservata. "Cambia" apre
   * il pannello avanzato invece di duplicarne i controlli qui.
   */
  function renderCameraSummary() {
    const out = document.getElementById('batch-camera-summary');
    if (!out) return;
    const d = DRONES.find((x) => x.id === st.georef.droneId);
    const name = d ? `${d.drone} — ${d.sensore}` : 'nessuna camera selezionata';
    const det = st.georef.exifDetection;
    const statusTxt =
      det && det.status === 'matched'
        ? " (rilevata automaticamente dall'EXIF)"
        : det
          ? ' (non riconosciuta automaticamente dall\'EXIF — verifica che sia corretta)'
          : '';
    out.innerHTML =
      `<p class="sf-caption">📷 Camera per GPS/filtro area: <strong>${SF.escapeHtml(name)}</strong>${statusTxt}. ` +
      `<span class="sf-link-btn" id="batch-camera-summary-edit">Cambia</span></p>`;
    const editBtn = document.getElementById('batch-camera-summary-edit');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        const details = document.getElementById('batch-advanced-settings');
        if (!details) return;
        details.open = true;
        details.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    }
  }

  /** Nota sotto la select del drone: SEMPRE visibile dopo un tentativo di riconoscimento, qualunque
   *  sia l'esito — la select stessa non cambia comportamento (resta modificabile in ogni caso). */
  function renderGeorefDetectionNote() {
    const out = document.getElementById('batch-georef-exif-note');
    if (!out) return;
    const d = st.georef.exifDetection;
    if (!d) {
      out.innerHTML = '';
      return;
    }
    if (d.status === 'matched') {
      out.innerHTML = `<div class="sf-success">📷 Camera rilevata automaticamente dall'EXIF della prima foto (${d.w}×${d.h}px, focale ${d.f}mm): <strong>${SF.escapeHtml(d.droneName)}</strong>. Selezionata qui sotto — cambiala se non è corretta.</div>`;
    } else if (d.status === 'ambiguous') {
      out.innerHTML = `<div class="sf-info">ℹ️ L'EXIF (${d.w}×${d.h}px, focale ${d.f}mm) è compatibile con più camere in elenco (stessa ottica) — non scelta automaticamente: seleziona quella giusta qui sotto.</div>`;
    } else if (d.status === 'unmatched') {
      out.innerHTML = `<div class="sf-info">ℹ️ Nessuna camera in elenco combacia con l'EXIF della prima foto (${d.w}×${d.h}px, focale ${d.f}mm) — seleziona quella giusta qui sotto.</div>`;
    } else {
      out.innerHTML = `<div class="sf-info">ℹ️ Le foto non hanno un EXIF con dimensioni/focale leggibili: seleziona la camera qui sotto.</div>`;
    }
  }

  /**
   * Tenta il riconoscimento automatico della camera leggendo l'EXIF delle prime foto del lotto
   * appena selezionato (non tutte: costoso su centinaia di file, e la camera è la stessa per
   * l'intera missione) — si ferma alla prima foto che ha dati EXIF di dimensioni/focale utilizzabili.
   * Aggiorna st.georef.droneId SOLO in caso di riconoscimento univoco (vedi findExifFingerprintMatches):
   * la select resta comunque sempre visibile e modificabile, il risultato è sempre spiegato a schermo
   * tramite renderGeorefDetectionNote(), mai applicato in silenzio.
   */
  async function detectCameraFromExif() {
    st.georef.exifDetection = null;
    if (!st.files.length || typeof readExifGps !== 'function') {
      renderGeorefDetectionNote();
      renderCameraSummary();
      return;
    }
    const droneFilter = typeof SF.isWideRgbColorCamera === 'function' ? SF.isWideRgbColorCamera : () => true;
    const georefDrones = DRONES.filter(droneFilter);
    const sampleSize = Math.min(st.files.length, 5);
    for (let i = 0; i < sampleSize; i++) {
      const exif = await readExifGps(st.files[i]);
      if (exif.exif_image_width && exif.exif_image_height && exif.focal_length_mm) {
        const matches = findExifFingerprintMatches(exif.exif_image_width, exif.exif_image_height, exif.focal_length_mm, georefDrones);
        const info = { w: exif.exif_image_width, h: exif.exif_image_height, f: exif.focal_length_mm };
        if (matches.length === 1) {
          st.georef.droneId = matches[0].id;
          st.georef.exifDetection = { status: 'matched', droneName: `${matches[0].drone} — ${matches[0].sensore}`, ...info };
          const sel = document.getElementById('batch-drone-select');
          if (sel) { sel.value = st.georef.droneId; renderGeorefCustomFields(); }
        } else {
          st.georef.exifDetection = { status: matches.length > 1 ? 'ambiguous' : 'unmatched', ...info };
        }
        renderGeorefDetectionNote();
        renderCameraSummary();
        return;
      }
    }
    st.georef.exifDetection = { status: 'no-exif' };
    renderGeorefDetectionNote();
    renderCameraSummary();
  }

  // ------------------------------------------------------------- profili: opzioni, swatch, refresh
  function profileOptionsHtml(selected) {
    const saved = SF.listProfiles();
    if (!saved.length) return '<option value="">— nessun profilo salvato —</option>';
    return saved
      .map((p) => `<option value="${SF.escapeHtml(p.name)}"${p.name === selected ? ' selected' : ''}>${SF.escapeHtml(p.name)}</option>`)
      .join('');
  }

  function updateProfileSwatch() {
    const sel = document.getElementById('batch-profile-select');
    const out = document.getElementById('batch-profile-swatch');
    if (!sel || !out) return;
    const p = SF.getProfile(sel.value);
    if (!p) {
      out.innerHTML = `<div class="sf-info">Nessun profilo selezionato: creane uno nel modulo <strong>${SF.icon('palette')} Calibrazione Colore</strong>,
        oppure — dopo aver scelto le foto qui sotto — usa uno dei <strong>colori suggeriti dalla scena</strong>.</div>`;
      return;
    }
    SF.loadCv().then((cv) => {
      if (sel.value !== p.name) return; // selezione cambiata nel frattempo
      out.innerHTML =
        `<div style="display:flex; align-items:center; gap:0.6rem;">
          <div style="width:36px;height:36px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background-color:${profileHexColor(cv, p)};"></div>
          <span class="sf-caption">Colore target del profilo <strong>${SF.escapeHtml(p.name)}</strong></span>
        </div>`;
    });
  }

  function renderExtraProfiles() {
    renderExtraProfilesList();
    renderExclusions();
  }

  function renderExtraProfilesList() {
    const out = document.getElementById('batch-extra-profiles');
    const sel = document.getElementById('batch-profile-select');
    if (!out || !sel) return;
    const others = SF.listProfiles().filter((p) => p.name !== sel.value);
    // niente profili aggiuntivi che non esistono piu' o che coincidono col principale
    Array.from(st.extraProfiles).forEach((n) => { if (!others.some((p) => p.name === n)) st.extraProfiles.delete(n); });
    if (!others.length) { out.innerHTML = ''; return; }
    const n = st.extraProfiles.size;
    out.innerHTML = `
      <details class="sf-expander"${n ? ' open' : ''}>
        <summary>➕ Cerca più colori nello stesso lotto${n ? ` (${n} aggiuntiv${n === 1 ? 'o' : 'i'})` : ''}</summary>
        <p class="sf-caption">Ogni profilo aggiuntivo fa rielaborare tutte le foto: i tempi si moltiplicano per il numero di
          profili. Nel Report ogni rilevamento indica il profilo che lo ha trovato (se due colori trovano lo stesso oggetto,
          resta un solo rilevamento).</p>
        ${others
          .map(
            (p) => `<label class="sf-caption" style="display:flex; gap:0.5rem; align-items:center; margin:0.2rem 0; cursor:pointer;">
              <input type="checkbox" data-extra="${SF.escapeHtml(p.name)}"${st.extraProfiles.has(p.name) ? ' checked' : ''}> ${SF.escapeHtml(p.name)}</label>`
          )
          .join('')}
      </details>`;
    out.querySelectorAll('input[data-extra]').forEach((cb) => {
      cb.addEventListener('change', () => {
        if (cb.checked) st.extraProfiles.add(cb.dataset.extra);
        else st.extraProfiles.delete(cb.dataset.extra);
        renderExtraProfiles();
        renderStartSection();
      });
    });
  }

  // ------------------------------------------------------------- colori da escludere
  function labDist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }

  /** Aggiunge un colore (RGB) all'elenco delle esclusioni, con tolleranza di base (NON allargata: meglio
   *  un falso positivo in più che un target vero nascosto in silenzio — si possono aggiungere più sfumature). */
  async function addExclusionColor(rgb, label) {
    const hex = '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
    if (st.excludeColors.some((e) => e.hex === hex)) return;
    const cv = await SF.loadCv();
    const profile = computeProfileFromSamples(cv, [SF.solidPatch(rgb.map(Math.round))], {});
    profile.name = `escluso_${hex.slice(1)}`;
    st.excludeColors.push({ name: label ? `${label} ${hex}` : hex, hex, profile });
    renderExclusions();
    renderStartSection();
  }

  function renderExclusions() {
    const out = document.getElementById('batch-exclusions');
    if (!out) return;
    const n = st.excludeColors.length;
    // avviso: un colore escluso troppo vicino a un profilo cercato eliminerebbe anche il target
    const sel = document.getElementById('batch-profile-select');
    const targets = [];
    if (sel && SF.getProfile(sel.value)) targets.push(SF.getProfile(sel.value));
    st.extraProfiles.forEach((nm) => { const p = SF.getProfile(nm); if (p) targets.push(p); });
    const clashes = st.excludeColors.filter((e) => targets.some((t) => labDist(e.profile.mean_lab, t.mean_lab) < 30));
    out.innerHTML = `
      <details class="sf-expander"${n ? ' open' : ''}>
        <summary>${SF.icon('ban')} Colori da escludere${n ? ` (${n})` : ''}</summary>
        <p class="sf-caption">Utile quando qualcosa di <em>quasi dello stesso colore</em> del target riempie la scena
          (papaveri, un tetto, un veicolo): i pixel di questo colore vengono tolti dalla ricerca. Attenzione: non
          vale solo per quell'oggetto — qualunque cosa di quel colore sparisce, target compreso se gli somiglia.
          Per prudenza la tolleranza è stretta: se il colore varia, aggiungi più sfumature.
          Le esclusioni valgono solo per questa elaborazione (non vengono salvate).</p>
        <div style="display:flex; flex-wrap:wrap; gap:0.4rem; margin:0.4rem 0;">
          ${st.excludeColors
            .map(
              (e, i) => `<span class="sf-module-pill" style="color:var(--text); border-color:var(--border); background:var(--panel-soft);">
                <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${e.hex};margin-right:4px;border:1px solid rgba(255,255,255,0.3);"></span>${SF.escapeHtml(e.name)}
                <span class="batch-excl-del" data-i="${i}" title="Rimuovi" style="cursor:pointer; margin-left:0.3rem; color:var(--danger);">✕</span></span>`
            )
            .join('')}
        </div>
        ${clashes.length ? `<div class="sf-warning">⚠️ ${clashes.map((e) => SF.escapeHtml(e.name)).join(', ')} è molto vicino al colore che stai cercando: l'esclusione rischia di eliminare anche il target.</div>` : ''}
        <div style="display:flex; align-items:center; gap:0.5rem; flex-wrap:wrap;">
          <input type="color" id="batch-exclude-color" value="#c82828" style="width:60px; height:36px; padding:2px; cursor:pointer;">
          <button class="sf-btn" id="batch-exclude-add">${SF.icon('ban')} Escludi questo colore</button>
          <span class="sf-caption">oppure usa "🚫 Escludi" sui colori suggeriti dalla scena qui sotto.</span>
        </div>
      </details>`;
    out.querySelectorAll('.batch-excl-del').forEach((el) => {
      el.addEventListener('click', () => {
        st.excludeColors.splice(parseInt(el.dataset.i, 10), 1);
        renderExclusions();
        renderStartSection();
      });
    });
    document.getElementById('batch-exclude-add').addEventListener('click', () => {
      const h = document.getElementById('batch-exclude-color').value;
      addExclusionColor([parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)], 'Colore');
    });
  }

  function refreshProfileSelect(selectName) {
    const sel = document.getElementById('batch-profile-select');
    if (!sel) return;
    sel.innerHTML = profileOptionsHtml(selectName);
    if (selectName) sel.value = selectName;
    updateProfileSwatch();
    renderExtraProfiles();
    renderStartSection();
  }

  // ------------------------------------------------------------- colori che spiccano nella scena (scene_colors.js)
  let sceneToken = 0; // invalida un'analisi in corso quando cambia la sorgente foto

  function startSceneAnalysis() {
    const token = ++sceneToken;
    st.tolScale = {};
    st.fitCache = {};
    if (!st.files.length || typeof SF.analyzeSceneColors !== 'function') {
      st.scene = null;
      renderSceneColors();
      return;
    }
    st.scene = { status: 'running', done: 0, total: SF.sceneSampleSize(st.files.length) };
    renderSceneColors();
    SF.analyzeSceneColors(st.files, (done, total) => {
      if (token !== sceneToken) return;
      st.scene.done = done;
      st.scene.total = total;
      const el = document.getElementById('batch-scene-progress');
      if (el) el.textContent = `${done}/${total}`;
    })
      .then((res) => {
        if (token !== sceneToken) return;
        st.scene = { status: 'done', ...res };
        renderSceneColors();
        updateSceneFit();
      })
      .catch(() => {
        if (token !== sceneToken) return;
        st.scene = { status: 'error' };
        renderSceneColors();
      });
  }

  function renderSceneColors() {
    const out = document.getElementById('batch-scene-colors');
    if (!out) return;
    const sc = st.scene;
    if (!sc) { out.innerHTML = ''; return; }
    if (sc.status === 'running') {
      out.innerHTML = `<p class="sf-caption">🎨 Analisi dei colori della scena… <span id="batch-scene-progress">${sc.done}/${sc.total}</span></p>`;
      return;
    }
    if (sc.status === 'error') {
      out.innerHTML = '<p class="sf-caption">🎨 Analisi dei colori della scena non riuscita su queste foto (formato non leggibile dal browser).</p>';
      return;
    }
    const note = `<p class="sf-caption">Analizzate ${sc.nAnalyzed} foto su ${sc.nTotal}. Solo colori <strong>vivaci</strong>: bianco, grigio, nero e tinte
      spente non vengono suggeriti. Un target visibile solo in foto non campionate può non comparire; il colore è un
      suggerimento da verificare a occhio (potrebbe essere un fiore, un veicolo, un telo…).</p>`;
    if (!sc.candidates || !sc.candidates.length) {
      out.innerHTML = `<p class="sf-caption">🎨 Nessun colore vivace e raro rilevato nella scena.</p>${note}`;
      return;
    }
    const chips = sc.candidates
      .map((c) => `<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${c.hex};border:1px solid rgba(255,255,255,0.3);margin-left:3px;vertical-align:-1px;"></span>`)
      .join('');
    out.innerHTML = `
      <details class="sf-expander" id="batch-scene-details">
        <summary>${SF.icon('palette')} Non sai che colore cercare? ${sc.candidates.length === 1 ? '1 colore spicca' : sc.candidates.length + ' colori spiccano'} nella scena${chips}</summary>
        <div class="sf-scene-grid">
          ${sc.candidates
            .map(
              (c, i) => `
            <div class="sf-scene-card">
              <img src="${c.exampleUrl}" alt="esempio ${SF.escapeHtml(c.name)}">
              <div class="sf-scene-meta">
                <div><span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${c.hex};border:1px solid rgba(255,255,255,0.3);vertical-align:-1px;"></span>
                  <strong>${SF.escapeHtml(c.name)}</strong> <span class="sf-caption">${c.hex}</span></div>
                <div class="sf-caption">${c.pctScene < 0.01 ? '&lt;0,01' : SF.formatNum(c.pctScene, 2)}% della scena · in ${c.presence}/${c.nPhotos} foto<br>esempio da ${SF.escapeHtml(c.photoName)}</div>
                <div style="display:flex; gap:0.4rem; flex-wrap:wrap;">
                  <button class="sf-btn" data-scene-idx="${i}">Usa questo colore</button>
                  <button class="sf-btn" data-scene-add="${i}" title="Cerca anche questo colore, oltre al profilo già scelto">${SF.icon('plus')} Aggiungi</button>
                  <button class="sf-btn" data-scene-excl="${i}" title="Togli questo colore dalla ricerca (es. papaveri, tetti)">${SF.icon('ban')} Escludi</button>
                </div>
              </div>
            </div>`
            )
            .join('')}
        </div>
        ${note}
      </details>`;
    async function createProfileFromCandidate(c) {
      const cv = await SF.loadCv();
      // Come la modalità Palette: colore esatto -> tolleranza al tetto massimo (nessuna variazione osservabile)
      const profile = computeProfileFromSamples(cv, [SF.solidPatch(c.rgb)], { widen: true });
      profile.name = `scena_${c.name.toLowerCase().replace(/[^a-z]+/g, '-')}_${c.hex.slice(1)}`;
      profile.sample_source = 'scena';
      profile.created_at = new Date().toISOString();
      SF.saveProfile(profile);
      SF.updateSidebarStatus();
      return profile;
    }
    out.querySelectorAll('button[data-scene-idx]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const c = sc.candidates[parseInt(btn.dataset.sceneIdx, 10)];
        btn.disabled = true;
        const profile = await createProfileFromCandidate(c);
        refreshProfileSelect(profile.name);
        btn.disabled = false;
        btn.textContent = '✓ Selezionato';
      });
    });
    out.querySelectorAll('button[data-scene-excl]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const c = sc.candidates[parseInt(btn.dataset.sceneExcl, 10)];
        await addExclusionColor(c.rgb, c.name);
        btn.textContent = '✓ Escluso';
        btn.disabled = true;
      });
    });
    out.querySelectorAll('button[data-scene-add]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const c = sc.candidates[parseInt(btn.dataset.sceneAdd, 10)];
        btn.disabled = true;
        const profile = await createProfileFromCandidate(c);
        const sel = document.getElementById('batch-profile-select');
        if (!sel.value || !SF.getProfile(sel.value)) refreshProfileSelect(profile.name); // nessun principale: diventa il principale
        else {
          st.extraProfiles.add(profile.name);
          const keep = sel.value;
          sel.innerHTML = profileOptionsHtml(keep);
          sel.value = keep;
          renderExtraProfiles();
          renderStartSection();
        }
        btn.textContent = '✓ Aggiunto';
      });
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
    const selEl = document.getElementById('batch-profile-select');
    const hasProfile = !!(selEl && SF.getProfile(selEl.value));
    out.innerHTML = `<div id="batch-scene-fit"></div><div class="sf-sticky-bar"><span id="batch-start-status" class="sf-caption">${hasProfile ? st.files.length + ' foto pronte' + (st.extraProfiles.size ? ' · ' + (1 + st.extraProfiles.size) + ' profili colore' : '') + (st.excludeColors.length ? ' · ' + st.excludeColors.length + ' colori esclusi' : '') : 'Scegli o crea un profilo colore (anche dai colori suggeriti) per avviare'}</span><button class="sf-btn primary" id="batch-start-btn" ${hasProfile ? '' : 'disabled'}>▶️ Avvia elaborazione batch</button></div>`;
    document.getElementById('batch-start-btn').addEventListener('click', runBatch);
    updateSceneFit();
  }

  // ------------------------------------------------------------- tolleranza adattiva alla scena
  let fitToken = 0;
  function selectedProfileNames() {
    const selEl = document.getElementById('batch-profile-select');
    const names = [];
    if (selEl && SF.getProfile(selEl.value)) names.push(selEl.value);
    st.extraProfiles.forEach((n) => { if (n !== (selEl && selEl.value) && SF.getProfile(n)) names.push(n); });
    return names;
  }

  async function updateSceneFit() {
    const box = document.getElementById('batch-scene-fit');
    if (!box) return;
    const bg = st.scene && st.scene.status === 'done' ? st.scene.bg : null;
    if (!bg) { box.innerHTML = ''; return; }
    const token = ++fitToken;
    const cv = await SF.loadCv();
    if (token !== fitToken) return;
    const rows = [];
    for (const name of selectedProfileNames()) {
      const prof = SF.getProfile(name);
      const key = name + '|' + st.detectionMode + '|' + JSON.stringify(prof.tolerance_lab) + JSON.stringify(prof.mean_lab);
      if (!(key in st.fitCache)) st.fitCache[key] = SF.sceneFit(cv, prof, st.detectionMode, bg);
      const fit = st.fitCache[key];
      if (!fit || !fit.warn) continue;
      const pct = (v) => (v * 100).toFixed(v < 0.1 ? 1 : 0).replace('.', ',') + '%';
      const on = st.tolScale[name];
      rows.push(`<div class="sf-warning" style="margin-bottom:0.4rem;padding:0.5rem 0.7rem;">⚠️ <strong>${name}</strong>: il ${pct(fit.frac)} dello sfondo campionato rientra già in questo profilo → attesi molti falsi positivi.
        ${on
          ? `<strong>Tolleranza ridotta (×${on})</strong> per questa elaborazione. <button class="sf-btn" data-fit-off="${name}">Annulla</button>`
          : `<button class="sf-btn" data-fit-on="${name}" data-fit-scale="${fit.scale}">Restringi tolleranza ×${fit.scale} (sfondo → ${pct(fit.fracAfter)})</button>${fit.reached ? '' : ' <span class="sf-caption">neanche al minimo il profilo si separa del tutto dallo sfondo: valuta un altro colore o un’esclusione.</span>'}`}
        </div>`);
    }
    box.innerHTML = rows.join('');
    box.querySelectorAll('[data-fit-on]').forEach((b) => b.addEventListener('click', () => {
      st.tolScale[b.dataset.fitOn] = parseFloat(b.dataset.fitScale); updateSceneFit();
    }));
    box.querySelectorAll('[data-fit-off]').forEach((b) => b.addEventListener('click', () => {
      delete st.tolScale[b.dataset.fitOff]; updateSceneFit();
    }));
  }

  // ------------------------------------------------------------- pool di worker
  /**
   * Nucleo del pool di worker, senza alcuna dipendenza dal DOM: usato sia dall'avvio iniziale
   * dell'Elaborazione Batch qui sotto (runBatch, con la propria UI di progresso), sia dal pulsante
   * "Ri-applica filtro" nel Report (punto 6) — che rielabora lo stesso lotto di foto già in memoria
   * con un profilo colore aggiornato (dopo aver segnato uno o più falsi positivi), senza dover
   * riselezionare la cartella né rifare la configurazione. Ritorna una Promise che risolve
   * nell'array dei risultati (uno per foto, stesso ordine di `files`); `onProgress`, se passato,
   * viene richiamato dopo ogni foto completata come `onProgress(completedCount, total, resultsSoFar)`
   * — `resultsSoFar` è l'array risultati stesso (in corso di riempimento), cosi' il chiamante può
   * mostrare metriche parziali (es. "N con rilevamenti") senza che questa funzione sappia nulla di UI.
   */
  SF.runDetectionPoolAsync = function (files, profile, config, onProgress) {
    return new Promise((resolve) => {
      const nWorkers = Math.max(1, Math.min(config.maxWorkers || 8, navigator.hardwareConcurrency || 4, files.length));
      const chunks = Array.from({ length: nWorkers }, () => []);
      files.forEach((f, i) => chunks[i % nWorkers].push(f));

      const results = new Array(files.length).fill(null);
      let completedCount = 0;
      let workersDone = 0;

      // mappa: worker -> lista di indici globali (nello stesso ordine dei file inviati a quel worker)
      const chunkGlobalIndices = [];
      {
        const perWorkerFiles = Array.from({ length: nWorkers }, () => []);
        files.forEach((f, i) => perWorkerFiles[i % nWorkers].push(f));
        for (let w = 0; w < nWorkers; w++) {
          const idxs = [];
          for (let i = 0; i < perWorkerFiles[w].length; i++) idxs.push(w + i * nWorkers);
          chunkGlobalIndices.push(idxs);
        }
      }

      function maybeResolve() {
        if (workersDone < nWorkers) return;
        resolve(results);
      }

      for (let w = 0; w < nWorkers; w++) {
        const worker = new Worker('detect_worker.js');
        const globalIdxs = chunkGlobalIndices[w];
        worker.onmessage = (e) => {
          const data = e.data;
          if (data.done) {
            workersDone++;
            worker.terminate();
            maybeResolve();
            return;
          }
          results[globalIdxs[data.index]] = data.result;
          completedCount++;
          if (onProgress) onProgress(completedCount, files.length, results);
        };
        worker.onerror = (e) => {
          // un worker in errore non deve bloccare l'intero batch: segna i suoi file come errore e prosegui
          for (const gi of globalIdxs) {
            if (!results[gi]) {
              results[gi] = {
                name: files[gi].name, width: 0, height: 0,
                gps_lat: null, gps_lon: null, gps_altitude: null, datetime_original: null,
                detections: [], error: String(e.message || e),
                geom_filter_rejected: null, geom_filter_flagged: null, blobs_merged: null,
              };
              completedCount++;
            }
          }
          workersDone++;
          if (onProgress) onProgress(completedCount, files.length, results);
          maybeResolve();
        };
        worker.postMessage({ type: 'process', files: chunks[w], profile: profile, config: config, jobId: w });
      }
    });
  };

  // ------------------------------------------------------------- più profili colore nello stesso lotto
  /** Unisce i risultati di più passate (una per profilo) nella stessa struttura "un risultato per foto":
   *  la prima passata fa da base, i rilevamenti delle altre vengono aggiunti. Due rilevamenti di profili
   *  diversi che si sovrappongono (il centro di uno cade nel riquadro dell'altro) sono lo STESSO oggetto
   *  visto da due colori vicini: ne resta uno solo, quello con confidenza maggiore, con l'altro profilo
   *  annotato in `also_profiles` — mai due cerchi sullo stesso indumento. */
  function mergeProfilePasses(passes) {
    const base = passes[0];
    const inside = (b, x, y) => x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];
    const center = (b) => [b[0] + b[2] / 2, b[1] + b[3] / 2];
    for (let pi = 1; pi < passes.length; pi++) {
      passes[pi].forEach((other, i) => {
        const r = base[i];
        if (!r || !other) return;
        ['geom_filter_rejected', 'geom_filter_flagged'].forEach((key) => {
          if (r[key] && other[key]) Object.keys(other[key]).forEach((k) => { r[key][k] = (r[key][k] || 0) + other[key][k]; });
        });
        r.blobs_merged = (r.blobs_merged || 0) + (other.blobs_merged || 0);
        (other.detections || []).forEach((d) => {
          const [dx, dy] = center(d.bbox);
          const hit = (r.detections || []).find((e) => {
            const [ex, ey] = center(e.bbox);
            return inside(e.bbox, dx, dy) || inside(d.bbox, ex, ey);
          });
          if (!hit) { r.detections.push(d); return; }
          if (d.confidence > hit.confidence) {
            const also = [...(hit.also_profiles || []), hit.profile];
            const idx = r.detections.indexOf(hit);
            d.also_profiles = also;
            r.detections[idx] = d;
          } else {
            hit.also_profiles = [...(hit.also_profiles || []), d.profile];
          }
        });
      });
    }
    return base;
  }

  /** Esegue il rilevamento una volta per profilo (ognuna con l'intero pool di worker) e unisce i risultati.
   *  `profiles` = [{ name, profile }]. Ogni rilevamento porta `profile` (nome) per il Report. Con un solo
   *  profilo equivale a SF.runDetectionPoolAsync. Il tempo cresce linearmente col numero di profili: ogni
   *  passata rilegge e rielabora tutte le foto. `onProgress(done, total, resultsSoFar, profileIdx, nProfiles)`. */
  SF.runMultiProfileAsync = async function (files, profiles, config, onProgress) {
    const passes = [];
    for (let pi = 0; pi < profiles.length; pi++) {
      const res = await SF.runDetectionPoolAsync(files, profiles[pi].profile, config, (done, total, soFar) => {
        if (onProgress) onProgress(pi * total + done, profiles.length * total, soFar, pi, profiles.length);
      });
      res.forEach((r) => (r && r.detections ? r.detections : []).forEach((d) => { d.profile = profiles[pi].name; }));
      passes.push(res);
    }
    return profiles.length > 1 ? mergeProfilePasses(passes) : passes[0];
  };

  // ------------------------------------------------------------- seconda passata: bersagli piccoli (in background)
  /** Dopo la prima passata (veloce) rielabora TUTTE le foto a risoluzione più alta e con area minima più bassa,
   *  cercando solo blob più piccoli di quelli già coperti. Gira mentre l'utente guarda il Report: i nuovi
   *  rilevamenti (`small_pass: true`) vengono AGGIUNTI a SF.state.batchResults, mai sostituiti, e solo se non si
   *  sovrappongono a un rilevamento già presente (stesso controllo di mergeProfilePasses). Usa metà dei core
   *  per non appesantire la visione dei risultati. Notifica con l'evento 'sf-smallpass'. */
  const SMALL_PASS = { downscaleMaxDim: 4000, minAreaPxFullres: 80, maxAreaPxFullres: 400 };
  let smallToken = 0;

  function notifySmallPass() { window.dispatchEvent(new CustomEvent('sf-smallpass')); }

  SF.cancelSmallPass = function () {
    smallToken++;
    const sp = SF.state.smallPass;
    if (sp && sp.status === 'running') { sp.status = 'cancelled'; notifySmallPass(); }
  };

  SF.startSmallPass = function () {
    const token = ++smallToken;
    const files = SF.state.batchFiles, profs = SF.state.batchProfiles, base = SF.state.batchConfig;
    const results = SF.state.batchResults;
    if (!files || !files.length || !profs || !profs.length || !base || !results) { SF.state.smallPass = null; return; }
    const config = {
      ...base,
      downscaleMaxDim: Math.max(base.downscaleMaxDim, SMALL_PASS.downscaleMaxDim),
      minAreaPxFullres: SMALL_PASS.minAreaPxFullres,
      maxAreaPxFullres: SMALL_PASS.maxAreaPxFullres,
      maxWorkers: Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2))),
    };
    const sp = (SF.state.smallPass = { status: 'running', done: 0, total: files.length * profs.length, added: 0 });
    notifySmallPass();
    const center = (b) => [b[0] + b[2] / 2, b[1] + b[3] / 2];
    const inside = (b, x, y) => x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];

    (async () => {
      for (let pi = 0; pi < profs.length; pi++) {
        const merged = new Set();
        const mergeNew = (resSoFar) => {
          if (token !== smallToken) return;
          resSoFar.forEach((r2, i) => {
            if (!r2 || merged.has(i)) return;
            merged.add(i);
            const r = results[i];
            if (!r) return;
            (r2.detections || []).forEach((d) => {
              const [dx, dy] = center(d.bbox);
              const dup = (r.detections || []).some((e) => {
                const [ex, ey] = center(e.bbox);
                return inside(e.bbox, dx, dy) || inside(d.bbox, ex, ey);
              });
              if (dup) return;
              d.profile = profs[pi].name;
              d.small_pass = true;
              r.detections.push(d);
              sp.added++;
            });
          });
        };
        await SF.runDetectionPoolAsync(files, profs[pi].profile, config, (done, total, soFar) => {
          if (token !== smallToken) return;
          sp.done = pi * files.length + done;
          mergeNew(soFar);
          notifySmallPass();
        });
        if (token !== smallToken) return;
      }
      sp.status = 'done';
      notifySmallPass();
    })().catch(() => { if (token === smallToken) { sp.status = 'error'; notifySmallPass(); } });
  };

  function runBatch() {
    SF.cancelSmallPass();
    const profileName = document.getElementById('batch-profile-select').value;
    const profile = SF.getProfile(profileName);
    if (!profile) return;
    const profs = [{ name: profileName, profile }];
    st.extraProfiles.forEach((n) => {
      const p = SF.getProfile(n);
      if (p && n !== profileName) profs.push({ name: n, profile: p });
    });
    // tolleranza adattiva: solo per questa elaborazione, il profilo salvato non cambia
    profs.forEach((x) => { const sc = st.tolScale[x.name]; if (sc && sc < 1) x.profile = SF.scaleProfileTolerance(x.profile, sc); });
    SF.state.batchTolNote = profs.filter((x) => x.profile.tol_scale).map((x) => x.name + ' ×' + x.profile.tol_scale);

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
      excludeProfiles: st.excludeColors.map((e) => e.profile),
    };

    const files = st.files;
    const t0 = performance.now();

    function onProgress(completedCount, total, resultsSoFar, pi, k) {
      const pct = total ? (100 * completedCount) / total : 0;
      const inner = document.getElementById('batch-progress-inner');
      const text = document.getElementById('batch-progress-text');
      if (inner) inner.style.width = pct.toFixed(1) + '%';
      const nMatches = resultsSoFar.filter((r) => r && r.detections && r.detections.length).length;
      const perPass = Math.round(total / k);
      const done = completedCount - pi * perPass;
      if (text) {
        text.textContent = k > 1
          ? `Profilo ${pi + 1}/${k} (${profs[pi].name}): ${done}/${perPass} foto — ${nMatches} con rilevamenti`
          : `${completedCount}/${total} foto elaborate — ${nMatches} con rilevamenti`;
      }
    }

    SF.runMultiProfileAsync(files, profs, config, onProgress).then(async (results) => {
      const elapsed = (performance.now() - t0) / 1000;
      st.running = false;
      const cv = await SF.loadCv();
      SF.state.batchResults = results;
      SF.state.batchFiles = files;
      SF.state.batchProfileName = profs.map((x) => x.name).join(' + ');
      // Profili e config effettivi di questa run (non solo i nomi): servono al punto 6 nel Report
      // per "Ri-applica filtro" — rielaborare lo stesso lotto senza riselezionare cartella/impostazioni.
      SF.state.batchProfile = profs[0].profile; // primo profilo (compatibilita' col codice a profilo singolo)
      SF.state.batchProfiles = profs.map((x) => ({ name: x.name, profile: x.profile, hex: profileHexColor(cv, x.profile) }));
      SF.state.batchConfig = config;
      SF.state.batchExcluded = st.excludeColors.map((e) => ({ name: e.name, hex: e.hex }));
      SF.startSmallPass(); // seconda passata in background: bersagli piccoli, a piena risoluzione
      SF.updateSidebarStatus();
      renderBatchSummary(elapsed);
      renderStartSection();
    });
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

    // Riepilogo del filtro geometrico (punto 2): scarti automatici (casi quasi certi di non-target)
    // e segnalazioni (blob tenuti nei risultati ma con un avviso, tipicamente possibile occlusione
    // parziale del target) — vedi evaluateGeometricFilter() in detect_worker.js. Tenute separate:
    // sommarle darebbe l'impressione che vengano tutte scartate, mentre le segnalazioni restano
    // visibili e vanno solo verificate a video.
    const geomRejected = { aspect_ratio_estremo: 0, area_troppo_grande: 0 };
    const geomFlagged = { aspect_ratio: 0, area_piccola: 0 };
    let geomRejectedTotal = 0, geomFlaggedTotal = 0;
    results.forEach((r) => {
      if (r.geom_filter_rejected) {
        for (const k of Object.keys(geomRejected)) {
          geomRejected[k] += r.geom_filter_rejected[k] || 0;
          geomRejectedTotal += r.geom_filter_rejected[k] || 0;
        }
      }
      if (r.geom_filter_flagged) {
        for (const k of Object.keys(geomFlagged)) {
          geomFlagged[k] += r.geom_filter_flagged[k] || 0;
          geomFlaggedTotal += r.geom_filter_flagged[k] || 0;
        }
      }
    });
    const GEOM_REJECT_LABELS = {
      aspect_ratio_estremo: 'forma estremamente allungata (artefatto)',
      area_troppo_grande: 'area troppo grande',
    };
    const GEOM_FLAG_LABELS_SUMMARY = {
      aspect_ratio: 'forma allungata',
      area_piccola: 'area piccola',
    };
    // Blob vicini fusi in un unico rilevamento (mergeNearbyRects in detect_worker.js): puramente
    // informativo, per trasparenza su quante volte è successo — nulla viene scartato qui.
    const blobsMergedTotal = results.reduce((s, r) => s + (r.blobs_merged || 0), 0);

    document.getElementById('batch-progress-wrap').innerHTML = '';
    const out = document.getElementById('batch-results-section');
    out.innerHTML = `
      <div class="sf-success">Elaborazione completata in ${elapsed.toFixed(1)}s (${(results.length / elapsed).toFixed(1)} foto/s).</div>
      ${(SF.state.batchExcluded || []).length ? `<p class="sf-caption" style="margin-top:0.5rem;">🚫 Colori esclusi in questa elaborazione: ${SF.state.batchExcluded.map((e) => SF.escapeHtml(e.name)).join(', ')}.</p>` : ''}
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
          ? `<p class="sf-caption">📐 Filtro geometrico: <strong>${geomRejectedTotal}</strong> blob scartati automaticamente prima del ritaglio
             (${Object.keys(geomRejected).filter((k) => geomRejected[k]).map((k) => `${geomRejected[k]} ${GEOM_REJECT_LABELS[k]}`).join(', ')}) — casi quasi certi di non-target
             (terreno/vegetazione estesa, artefatti lineari). Se sembrano troppi, allarga le soglie nelle impostazioni avanzate sopra.</p>`
          : ''
      }
      ${
        geomFlaggedTotal
          ? `<p class="sf-caption">🔍 <strong>${geomFlaggedTotal}</strong> rilevamenti segnalati per revisione, ma NON scartati
             (${Object.keys(geomFlagged).filter((k) => geomFlagged[k]).map((k) => `${geomFlagged[k]} ${GEOM_FLAG_LABELS_SUMMARY[k]}`).join(', ')}) —
             tipico di un target parzialmente coperto: controllali comunque nel Report.</p>`
          : ''
      }
      ${
        blobsMergedTotal
          ? `<p class="sf-caption">🔗 <strong>${blobsMergedTotal}</strong> gruppo/i di blob vicini sulla stessa foto uniti in un unico
             rilevamento (entro ${st.geomFilter.mergeGapPx}px, impostazioni avanzate) invece di comparire come rilevamenti separati —
             tipico di un target la cui maschera colore si è spezzata in più pezzi ravvicinati.</p>`
          : ''
      }
      ${
        errors.length
          ? `<details class="sf-expander"><summary>⚠️ ${errors.length} foto con errori di lettura</summary>
             ${errors.map((r) => `<div class="sf-caption">${SF.escapeHtml(r.name)}: ${SF.escapeHtml(r.error)}</div>`).join('')}
             </details>`
          : ''
      }
      <div class="sf-info">Vai al modulo <strong>${SF.icon('clipboard')} Report</strong> per vedere i ritagli, le coordinate e generare il report finale.</div>
      <button class="sf-btn primary" id="batch-goto-report">${SF.icon('clipboard')} Vai al Report</button>
    `;
    document.getElementById('batch-goto-report').addEventListener('click', () => SF.navigate('report'));
  }

  // ------------------------------------------------------------- build
  function buildOnce() {
    const container = document.getElementById('batch-content');
    const profileOptions = profileOptionsHtml();
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
      <div id="batch-extra-profiles" style="margin-top:0.6rem;"></div>
      <div id="batch-exclusions" style="margin-top:0.6rem;"></div>
      <div id="batch-scene-colors" style="margin-top:0.6rem;"></div>

      <h2 class="sf-section">2. Sorgente immagini</h2>
      <div class="sf-radio-row" id="batch-source-radio">
        <label><input type="radio" name="batch-source" value="folder" checked> Cartella locale (consigliato)</label>
        <label><input type="radio" name="batch-source" value="upload"> Carica file (pochi scatti)</label>
      </div>
      <div id="batch-source-body"></div>
      <div id="batch-camera-summary" style="margin-top:0.4rem;"></div>

      <h2 class="sf-section">3. Modalità di rilevamento</h2>
      <label class="sf-label">Come cercare il colore nelle foto?</label>
      <select id="batch-detection-mode">
        ${Object.entries(DETECTION_MODE_LABELS).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
      </select>
      <p class="sf-caption">"Massima precisione" è la più severa (un pixel deve superare due controlli invece di
        uno): riduce i falsi positivi, ma su un indumento reale può mostrare una confidenza più bassa dello
        "Standard" — non è un errore, è normale. Se non sei sicuro parti da "Standard".</p>

      <details id="batch-advanced-settings" style="margin: 1rem 0;">
        <summary style="cursor:pointer; color:var(--muted);">⚙️ Impostazioni avanzate: camera GPS e filtro geometrico</summary>
        <div style="padding: 0.8rem 0 0.2rem;">
          <label class="sf-label"><input type="checkbox" id="batch-require-gps"> Scarta foto senza posizione GPS</label>
          <p class="sf-caption">Utile se vuoi solo target georiferiti sulla mappa nel report finale.</p>
          <hr style="border-color:var(--border); margin: 1rem 0;">
          <h3 class="sf-section" style="font-size:1rem;">Camera e posizione GPS del target</h3>
          <p class="sf-caption">La posizione GPS (e la quota) vengono lette <strong>automaticamente dai metadati EXIF
            di ogni foto</strong>, nessuna azione richiesta qui sotto. Serve solo indicare la camera in uso — come nel
            Mission Planner — per calcolare correttamente il GSD (metri per pixel) e quindi la posizione precisa del
            target, non solo del centro foto: SkyFind prova a riconoscerla da sola dalle prime foto del lotto
            (dimensioni immagine e focale nell'EXIF, vedi riepilogo sopra), ma la scelta resta sempre modificabile qui.</p>
          <label class="sf-label">Drone e camera in uso</label>
          <select id="batch-drone-select">${droneOptions}</select>
          <div id="batch-georef-exif-note" style="margin-top:0.5rem;"></div>
          <div id="batch-georef-custom" style="margin-top:0.7rem;"></div>
          <label class="sf-label" style="margin-top:0.9rem;">Quota di volo di riserva (AGL, metri) — opzionale</label>
          <input type="number" step="1" min="1" id="batch-fallback-altitude" placeholder="es. 40">
          <p class="sf-caption">Usata solo per le foto <em>senza</em> quota relativa nei metadati DJI
            (<code>drone-dji:RelativeAltitude</code>, presente sulla stragrande maggioranza delle foto DJI): se il dato
            c'è nella foto, ha sempre la precedenza su questo valore (anche questo letto automaticamente dall'EXIF). Se
            lasci vuoto e manca anche nella foto, per quelle foto i target vengono comunque rilevati ma senza una loro
            posizione GPS specifica (resta solo la posizione del drone al momento dello scatto, come prima).</p>

          <hr style="border-color:var(--border); margin: 1rem 0;">

          <h3 class="sf-section" style="font-size:1rem;">Filtro geometrico sui blob rilevati</h3>
          <p class="sf-caption">I valori di default sotto sono già ragionevoli per la maggior parte delle missioni.
            Un target SAR è spesso parzialmente coperto (vegetazione, ombre, altri ostacoli): un pezzo di indumento a
            malapena visibile può risultare piccolo o di forma insolita pur essendo un rilevamento vero. Per questo
            le soglie qui sotto <strong>non scartano</strong> i casi dubbi: li tengono nei risultati con un avviso
            "da verificare". Viene scartato in automatico solo ciò che è quasi certamente non un target — un'area
            reale oltre il massimo (terreno/tetto/vegetazione estesa) o una forma estremamente allungata, ben oltre
            queste soglie (tipicamente un artefatto lineare, non un frammento di indumento).</p>
          <div class="sf-grid-2">
            <div>
              <label class="sf-label">Area minima (m²) — solo segnalazione</label>
              <input type="number" step="0.01" min="0" id="batch-min-area-m2" value="${st.geomFilter.minAreaM2}" placeholder="es. 0.05">
            </div>
            <div>
              <label class="sf-label">Area massima (m²) — scarta</label>
              <input type="number" step="0.1" min="0" id="batch-max-area-m2" value="${st.geomFilter.maxAreaM2}" placeholder="es. 8">
            </div>
          </div>
          <label class="sf-label" style="margin-top:0.9rem;">Aspect ratio massimo (lato lungo / lato corto) — oltre segnala, oltre 2,5× scarta</label>
          <input type="number" step="0.5" min="1" id="batch-max-aspect-ratio" value="${st.geomFilter.maxAspectRatio}" placeholder="es. 6">
          <p class="sf-caption">I campi sull'area richiedono la camera configurata sopra: se manca, per quella foto
            viene valutato solo l'aspect ratio (non richiede il GSD). Lascia vuoto un campo per disattivare solo
            quel controllo.</p>

          <label class="sf-label" style="margin-top:0.9rem;">Distanza massima per unire rilevamenti vicini (px, foto originale)</label>
          <input type="number" step="5" min="0" id="batch-merge-gap-px" value="${st.geomFilter.mergeGapPx}" placeholder="es. 30">
          <p class="sf-caption">Un target parzialmente coperto (ramo, ombra, altro ostacolo) può spezzare la maschera
            colore in più pezzi ravvicinati sulla stessa foto: entro questa distanza vengono uniti in un unico
            rilevamento (un solo ritaglio/cerchio nel Report), invece di comparire come rilevamenti separati.
            Un valore troppo alto rischia di unire due target realmente distinti ma vicini tra loro — 0 o vuoto
            disattiva l'unione (comportamento precedente, un rilevamento per ogni pezzo).</p>
        </div>
      </details>

      <h2 class="sf-section">4. Avvia elaborazione</h2>
      <div id="batch-start-section"></div>
      <div id="batch-progress-wrap"></div>
      <div id="batch-results-section"></div>
    `;

    document.getElementById('batch-detection-mode').addEventListener('change', (e) => { st.detectionMode = e.target.value; updateSceneFit(); });
    document.getElementById('batch-require-gps').addEventListener('change', (e) => (st.requireGps = e.target.checked));

    document.getElementById('batch-drone-select').value = st.georef.droneId;
    document.getElementById('batch-drone-select').addEventListener('change', (e) => {
      st.georef.droneId = e.target.value;
      st.georef.exifDetection = null; // scelta manuale esplicita: non è più "rilevata dall'EXIF"
      renderGeorefCustomFields();
      renderCameraSummary();
    });
    renderGeorefCustomFields();
    renderCameraSummary();
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
    document.getElementById('batch-merge-gap-px').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      st.geomFilter.mergeGapPx = Number.isFinite(v) && v > 0 ? v : 0;
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
        startSceneAnalysis();
      });
    });
    renderSourceBody();

    updateProfileSwatch();
    document.getElementById('batch-profile-select').addEventListener('change', () => {
      updateProfileSwatch();
      renderExtraProfiles();
      renderStartSection();
    });
    renderExtraProfiles();
    renderSceneColors();

    st.built = true;
  }

  SF.init_batch = function () {
    if (st.running) return; // non ricostruire la UI mentre un batch e' in corso
    buildOnce();
  };
})();
