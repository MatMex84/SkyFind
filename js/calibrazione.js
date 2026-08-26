/**
 * Modulo 2 - Calibrazione Colore: contagocce stile Google Maps (zoom +/-, drag per
 * spostarsi, click per scegliere il colore) oppure palette. Tolleranza automatica
 * e fissa (nessun cursore): porta di pages/2_🎨_Calibrazione_Colore.py.
 */
window.SF = window.SF || {};

(function () {
  'use strict';

  const PATCH_HALF = 4; // patch campionata: 9x9 px attorno al click, come in Python
  const DISPLAY_WIDTH = 640;
  const MIN_ZOOM = 1, MAX_ZOOM = 6;

  const st = {
    built: false,
    mode: 'photo', // 'photo' | 'palette'
    profileName: 'target_1',
    currentPatchRgba: null, // {data, width, height} — usato in modalita' palette
    samples: [], // {x, y, patch:{data,width,height}} — punti campionati in modalita' foto
    currentProfile: null,
    // Normalizzazione illuminazione (punto 5), calcolata una volta al caricamento della foto e
    // riapplicata identica a ogni campione/anteprima di QUESTA foto — mai in modalita' Palette
    // (nessuna foto la cui illuminazione vada compensata: l'utente sceglie un colore esatto).
    grayWorldGains: null,
    pointCaption: '',
    sampleSource: '',
    // pan/zoom
    imgEl: null, fullCanvas: null, natW: 0, natH: 0,
    zoom: 1, left: 0, top: 0, fitScale: 1,
    dragging: false, moved: false, startX: 0, startY: 0, startLeft: 0, startTop: 0,
  };

  let livePreviewTimer = null;
  let livePreviewGen = 0;

  // ---------------------------------------------------------------- pan/zoom picker
  function effScale() { return st.zoom * st.fitScale; }

  function applyBounds() {
    const rw = st.natW * effScale(), rh = st.natH * effScale();
    const viewport = document.getElementById('calib-pz-viewport');
    const DW = viewport.clientWidth, DH = viewport.clientHeight;
    st.left = rw <= DW ? (DW - rw) / 2 : Math.min(0, Math.max(DW - rw, st.left));
    st.top = rh <= DH ? (DH - rh) / 2 : Math.min(0, Math.max(DH - rh, st.top));
  }

  function renderPz() {
    if (!st.imgEl) return;
    const s = effScale();
    st.imgEl.style.width = st.natW * s + 'px';
    st.imgEl.style.height = st.natH * s + 'px';
    st.imgEl.style.left = st.left + 'px';
    st.imgEl.style.top = st.top + 'px';
    const label = document.getElementById('calib-pz-zoomlabel');
    if (label) label.textContent = st.zoom.toFixed(1) + 'x';
    positionCrosshairs();
  }

  function zoomTo(newZoom, anchorClientX, anchorClientY) {
    const viewport = document.getElementById('calib-pz-viewport');
    const rect = viewport.getBoundingClientRect();
    const cx = anchorClientX !== undefined ? anchorClientX - rect.left : rect.width / 2;
    const cy = anchorClientY !== undefined ? anchorClientY - rect.top : rect.height / 2;
    const oldScale = effScale();
    // punto immagine sotto il punto di ancoraggio, prima dello zoom
    const imgX = (cx - st.left) / oldScale;
    const imgY = (cy - st.top) / oldScale;
    st.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    const newScale = effScale();
    st.left = cx - imgX * newScale;
    st.top = cy - imgY * newScale;
    applyBounds();
    renderPz();
  }

  function resetView() {
    st.zoom = 1;
    applyBounds();
    renderPz();
  }

  function clientToImagePoint(clientX, clientY) {
    const viewport = document.getElementById('calib-pz-viewport');
    const rect = viewport.getBoundingClientRect();
    const s = effScale();
    let x = Math.round((clientX - rect.left - st.left) / s);
    let y = Math.round((clientY - rect.top - st.top) / s);
    x = Math.max(0, Math.min(st.natW - 1, x));
    y = Math.max(0, Math.min(st.natH - 1, y));
    return [x, y];
  }

  function onPointerDown(e) {
    if (e.target.closest('.sf-pz-btn') || e.target.closest('.sf-pz-mark')) return; // lascia gestire il click ai bottoni e ai marker punti
    const viewport = document.getElementById('calib-pz-viewport');
    st.dragging = true; st.moved = false;
    st.startX = e.clientX; st.startY = e.clientY;
    st.startLeft = st.left; st.startTop = st.top;
    viewport.classList.add('dragging');
    viewport.setPointerCapture(e.pointerId);
  }
  function onPointerMove(e) {
    if (!st.dragging) return;
    const dx = e.clientX - st.startX, dy = e.clientY - st.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) st.moved = true;
    st.left = st.startLeft + dx;
    st.top = st.startTop + dy;
    applyBounds();
    renderPz();
  }
  function onPointerUp(e) {
    if (!st.dragging) return;
    st.dragging = false;
    document.getElementById('calib-pz-viewport').classList.remove('dragging');
    if (!st.moved) {
      const [x, y] = clientToImagePoint(e.clientX, e.clientY);
      pickPoint(x, y);
    }
  }
  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.4 : -0.4;
    zoomTo(st.zoom + delta, e.clientX, e.clientY);
  }

  function setupPzViewport() {
    const viewport = document.getElementById('calib-pz-viewport');
    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', onPointerUp);
    viewport.addEventListener('pointercancel', onPointerUp);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    document.getElementById('calib-pz-plus').addEventListener('click', () => zoomTo(st.zoom + 0.6));
    document.getElementById('calib-pz-minus').addEventListener('click', () => zoomTo(st.zoom - 0.6));
    document.getElementById('calib-pz-reset').addEventListener('click', resetView);
  }

  function loadImageForPicking(file) {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      st.natW = img.naturalWidth;
      st.natH = img.naturalHeight;
      st.sampleSource = file.name;
      st.samples = []; // nuova foto: si riparte da zero punti campionati
      st.currentProfile = null;
      livePreviewGen++; // invalida un'eventuale anteprima live ancora in calcolo sulla foto precedente
      const oldPreview = document.getElementById('calib-preview');
      if (oldPreview) oldPreview.innerHTML = '';

      // canvas nascosto a piena risoluzione, usato per campionare i pixel al click e per l'anteprima live
      st.fullCanvas = document.createElement('canvas');
      st.fullCanvas.width = st.natW;
      st.fullCanvas.height = st.natH;
      st.fullCanvas.getContext('2d').drawImage(img, 0, 0);

      // Normalizzazione illuminazione (punto 5): calcolata una sola volta su tutta la foto appena
      // caricata (mai su un ritaglio piccolo dominato dal target, che violerebbe l'ipotesi "media
      // scena = grigio"), poi riapplicata identica a ogni campione e all'anteprima live di QUESTA foto.
      st.grayWorldGains = computeGrayWorldGainsForPhoto();

      const viewport = document.getElementById('calib-pz-viewport');
      const dispHeight = Math.max(1, Math.round((DISPLAY_WIDTH * st.natH) / st.natW));
      viewport.style.height = dispHeight + 'px';

      viewport.querySelectorAll('img.sf-pz-img').forEach((el) => el.remove());
      const dispImg = document.createElement('img');
      dispImg.className = 'sf-pz-img';
      dispImg.src = url;
      dispImg.draggable = false;
      viewport.insertBefore(dispImg, viewport.firstChild);
      st.imgEl = dispImg;

      st.fitScale = DISPLAY_WIDTH / st.natW;
      st.zoom = 1;
      applyBounds();
      renderPz();

      document.getElementById('calib-pz-hint').style.opacity = '1';
      setTimeout(() => {
        const hint = document.getElementById('calib-pz-hint');
        if (hint) hint.style.opacity = '0';
      }, 3500);

      document.getElementById('calib-pz-container').classList.remove('sf-hidden');
      document.getElementById('calib-pick-hint').classList.remove('sf-hidden');
      rebuildCrosshairs(); // pulisce eventuali marker della foto precedente e azzera la toolbar
    };
    img.src = url;
  }

  // ---------------------------------------------------------------- estrazione patch + profilo

  /** Calcola i guadagni gray-world sulla foto corrente (downscale a maxDim, come computeLivePreview). */
  function computeGrayWorldGainsForPhoto() {
    if (!st.fullCanvas) return null;
    const maxDim = 800;
    const scale = Math.min(1, maxDim / Math.max(st.natW, st.natH));
    const sw = Math.max(1, Math.round(st.natW * scale)), sh = Math.max(1, Math.round(st.natH * scale));
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width = sw; tmpCanvas.height = sh;
    const tctx = tmpCanvas.getContext('2d');
    tctx.drawImage(st.fullCanvas, 0, 0, sw, sh);
    const imgData = tctx.getImageData(0, 0, sw, sh);
    return computeGrayWorldGains(imgData.data, sw * sh, 4);
  }

  function clampedPatch(cx, cy) {
    const w = 2 * PATCH_HALF + 1, h = 2 * PATCH_HALF + 1;
    const x0 = Math.max(0, cx - PATCH_HALF), y0 = Math.max(0, cy - PATCH_HALF);
    const x1 = Math.min(st.natW, cx - PATCH_HALF + w), y1 = Math.min(st.natH, cy - PATCH_HALF + h);
    let imgData, pw, ph;
    if (x1 <= x0 || y1 <= y0) {
      const sx = Math.max(0, Math.min(st.natW - 1, cx)), sy = Math.max(0, Math.min(st.natH - 1, cy));
      imgData = st.fullCanvas.getContext('2d').getImageData(sx, sy, 1, 1);
      pw = 1; ph = 1;
    } else {
      imgData = st.fullCanvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0);
      pw = x1 - x0; ph = y1 - y0;
    }
    // Stessa correzione illuminazione applicata alla foto intera (mai ricalcolata sulla patch,
    // che sarebbe troppo piccola/non rappresentativa) — cosi' il profilo e i rilevamenti batch
    // vivono nello stesso spazio colore "canonicalizzato".
    if (st.grayWorldGains) applyGrayWorldGains(imgData.data, pw * ph, st.grayWorldGains, 4);
    return { data: imgData.data, width: pw, height: ph };
  }

  const MAX_SAMPLES = 12;

  async function pickPoint(x, y) {
    if (st.samples.length >= MAX_SAMPLES) {
      st.samples.shift(); // punti piu' vecchi ceduti al piu' recente, oltre il limite pratico
    }
    st.samples.push({ x, y, patch: clampedPatch(x, y) });
    st.pointCaption =
      st.samples.length === 1
        ? `Punto selezionato: x=${x}, y=${y} (immagine ${st.natW}x${st.natH} px)`
        : `${st.samples.length} punti selezionati sull'indumento — continua a cliccare su pieghe, ombra e luce diretta per un profilo piu' robusto.`;
    rebuildCrosshairs();
    await computeAndRenderProfile();
  }

  function rebuildCrosshairs() {
    const viewport = document.getElementById('calib-pz-viewport');
    if (!viewport) return;
    viewport.querySelectorAll('.sf-pz-mark').forEach((el) => el.remove());
    st.samples.forEach((sample, i) => {
      const mark = document.createElement('div');
      mark.className = 'sf-pz-mark';
      mark.dataset.idx = String(i);
      mark.title = 'Clicca per rimuovere questo punto';
      mark.textContent = String(i + 1);
      mark.addEventListener('click', (e) => {
        e.stopPropagation();
        st.samples.splice(i, 1);
        rebuildCrosshairs();
        if (st.samples.length) {
          computeAndRenderProfile();
        } else {
          st.currentProfile = null;
          document.getElementById('calib-preview').innerHTML = '';
        }
      });
      viewport.appendChild(mark);
    });
    positionCrosshairs();
    renderPointsToolbar();
  }

  function positionCrosshairs() {
    const s = effScale();
    document.querySelectorAll('#calib-pz-viewport .sf-pz-mark').forEach((el) => {
      const i = parseInt(el.dataset.idx, 10);
      const sample = st.samples[i];
      if (!sample) return;
      el.style.left = st.left + sample.x * s + 'px';
      el.style.top = st.top + sample.y * s + 'px';
    });
  }

  function renderPointsToolbar() {
    const el = document.getElementById('calib-points-toolbar');
    if (!el) return;
    if (!st.samples.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `<span class="sf-caption">${st.samples.length}/${MAX_SAMPLES} punto/i campionato/i (numeri sulla foto) —</span>
      <span class="sf-link-btn" id="calib-undo-point">annulla ultimo</span> ·
      <span class="sf-link-btn" id="calib-clear-points">cancella tutti</span>`;
    document.getElementById('calib-undo-point').addEventListener('click', () => {
      st.samples.pop();
      rebuildCrosshairs();
      if (st.samples.length) {
        computeAndRenderProfile();
      } else {
        st.currentProfile = null;
        document.getElementById('calib-preview').innerHTML = '';
      }
    });
    document.getElementById('calib-clear-points').addEventListener('click', () => {
      st.samples = [];
      rebuildCrosshairs();
      st.currentProfile = null;
      document.getElementById('calib-preview').innerHTML = '';
    });
  }

  /** Campioni attivi (patch RGBA) da cui calcolare il profilo, in entrambe le modalita'. */
  function activeSamples() {
    if (st.mode === 'palette') return st.currentPatchRgba ? [st.currentPatchRgba] : [];
    return st.samples.map((s) => s.patch);
  }

  async function computeAndRenderProfile() {
    const samples = activeSamples();
    if (!samples.length) return;
    const cv = await SF.loadCv();
    // Palette: nessuna foto reale da cui osservare variazione -> tolleranza allargata al tetto
    // massimo invece di collassare al pavimento più stretto (vedi commento in color_calib.js).
    st.currentProfile = computeProfileFromSamples(cv, samples, { widen: st.mode === 'palette' });
    st.currentProfile.name = st.profileName;
    st.currentProfile.sample_source = st.sampleSource;
    renderProfilePreview();
  }

  // ---------------------------------------------------------------- anteprima live sulla foto campione
  function computeLivePreview(cv, profile, colorSpace) {
    if (!st.fullCanvas) return null;
    const maxDim = 800;
    const scale = Math.min(1, maxDim / Math.max(st.natW, st.natH));
    const sw = Math.max(1, Math.round(st.natW * scale)), sh = Math.max(1, Math.round(st.natH * scale));
    const smallCanvas = document.createElement('canvas');
    smallCanvas.width = sw; smallCanvas.height = sh;
    const sctx = smallCanvas.getContext('2d');
    sctx.drawImage(st.fullCanvas, 0, 0, sw, sh);
    const imageData = sctx.getImageData(0, 0, sw, sh);

    const rgba = cv.matFromImageData(imageData);
    const rgb = new cv.Mat();
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    rgba.delete();

    // Stessa normalizzazione illuminazione usata per i campioni di QUESTA foto, cosi' l'anteprima
    // rispecchia fedelmente cio' che il batch rileverebbe davvero.
    if (st.grayWorldGains) applyGrayWorldGains(rgb.data, rgb.rows * rgb.cols, st.grayWorldGains, 3);

    const mask = buildMask(cv, rgb, profile, colorSpace, 5);
    const lab = new cv.Mat();
    cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);
    const confidence = colorConfidence(cv, lab, mask, profile);

    let filled = 0;
    const md = mask.data;
    for (let i = 0; i < md.length; i++) if (md[i] > 0) filled++;
    const fillRatio = (100 * filled) / md.length;

    // overlay: foto originale con tinta calda sui pixel che verrebbero rilevati
    const overlayData = sctx.getImageData(0, 0, sw, sh);
    const od = overlayData.data;
    for (let i = 0; i < sw * sh; i++) {
      if (md[i] > 0) {
        od[i * 4] = Math.round(od[i * 4] * 0.35 + 245 * 0.65);
        od[i * 4 + 1] = Math.round(od[i * 4 + 1] * 0.35 + 166 * 0.65);
        od[i * 4 + 2] = Math.round(od[i * 4 + 2] * 0.35 + 35 * 0.65);
      }
    }
    sctx.putImageData(overlayData, 0, 0);

    rgb.delete(); mask.delete(); lab.delete();

    return { fillRatio, confidence, overlayDataUrl: smallCanvas.toDataURL('image/jpeg', 0.85) };
  }

  function scheduleLivePreview() {
    const el0 = document.getElementById('calib-live-preview');
    if (st.mode !== 'photo' || !st.fullCanvas) {
      if (el0) el0.innerHTML = '';
      return;
    }
    if (el0) el0.innerHTML = '<p class="sf-caption">Calcolo anteprima…</p>';
    clearTimeout(livePreviewTimer);
    const gen = ++livePreviewGen;
    const profile = st.currentProfile;
    livePreviewTimer = setTimeout(() => {
      const cv = window.cv;
      if (!cv || !profile) return;
      const hsvRes = computeLivePreview(cv, profile, 'hsv');
      const bothRes = computeLivePreview(cv, profile, 'both');
      if (gen !== livePreviewGen) return; // superata da un campionamento piu' recente
      const el = document.getElementById('calib-live-preview');
      if (!el || !hsvRes || !bothRes) return;
      el.innerHTML = `
        <h3 style="margin-top:0;">Anteprima rilevamento su questa foto</h3>
        <p class="sf-caption">Cosa rileverebbe davvero il colore scelto su questa foto, prima di lanciare il batch —
          la zona con tinta arancione è quella che verrebbe individuata (modalità "Massima precisione").</p>
        <img class="sf-live-preview-img" src="${bothRes.overlayDataUrl}">
        <table class="sf-table" style="margin-top:0.6rem;">
          <tr><th></th><th>Area rilevata</th><th>Confidenza media</th></tr>
          <tr><td>⚡ Standard</td><td>${SF.formatNum(hsvRes.fillRatio)}%</td><td>${SF.formatNum(hsvRes.confidence)}%</td></tr>
          <tr><td>🎯 Massima precisione</td><td>${SF.formatNum(bothRes.fillRatio)}%</td><td>${SF.formatNum(bothRes.confidence)}%</td></tr>
        </table>
        <p class="sf-caption">Basato su ${profile.n_samples} punto/i campionato/i. Se l'area rilevata sembra troppo
          piccola, clicca altri punti sull'indumento (soprattutto pieghe/ombre) per allargare la tolleranza in modo
          mirato — questo calcolo avviene solo qui in calibrazione e non rallenta l'elaborazione batch.</p>
      `;
    }, 250);
  }

  function renderProfilePreview() {
    const out = document.getElementById('calib-preview');
    if (!out || !st.currentProfile) {
      if (out) out.innerHTML = '';
      return;
    }
    const cv = window.cv;
    const profile = st.currentProfile;
    const hex = profileHexColor(cv, profile);

    const captionTxt = st.mode === 'photo' ? st.pointCaption : 'Colore scelto dalla palette';
    const nPts = profile.n_samples || 1;

    out.innerHTML = `
      <h2 class="sf-section">Colore selezionato</h2>
      <div class="sf-grid-2">
        <div>
          <div class="sf-swatch" style="background-color:${hex};"></div>
          <p class="sf-caption">${SF.escapeHtml(captionTxt)} · ${hex}</p>
          <label class="sf-label">Nome profilo</label>
          <input type="text" id="calib-profile-name" value="${SF.escapeHtml(profile.name)}">
        </div>
        <div id="calib-live-preview"></div>
      </div>
      <details class="sf-expander">
        <summary>Dettagli tecnici (HSV / CIE-LAB)</summary>
        <div class="sf-grid-2">
          <div>
            <strong>Colore medio HSV</strong>
            <pre>H=${profile.mean_hsv[0].toFixed(2)}  S=${profile.mean_hsv[1].toFixed(2)}  V=${profile.mean_hsv[2].toFixed(2)}</pre>
            <p class="sf-caption">Range maschera (HSV): H ${hsvBounds(profile).hueRanges.map(([lo, hi]) => `${lo.toFixed(0)}-${hi.toFixed(0)}`).join(' ∪ ')}
              (giro gestito, tipico per i rossi) · S ${hsvBounds(profile).sRange.map((x) => x.toFixed(0)).join('-')}
              · V ${hsvBounds(profile).vRange.map((x) => x.toFixed(0)).join('-')}</p>
          </div>
          <div>
            <strong>Colore medio CIE-LAB</strong>
            <pre>L=${profile.mean_lab[0].toFixed(2)}  a=${profile.mean_lab[1].toFixed(2)}  b=${profile.mean_lab[2].toFixed(2)}</pre>
            <p class="sf-caption">Range maschera (LAB): ${JSON.stringify(labBounds(profile).lower)} → ${JSON.stringify(labBounds(profile).upper)}</p>
          </div>
        </div>
        <p class="sf-caption">Tolleranza calcolata su ${nPts} punto/i campionato/i: con un solo punto è il valore
          fisso di base (come prima); con più punti si allarga in automatico in base a quanto il colore varia tra i
          punti scelti (pieghe, ombra, luce), fino a un tetto massimo per non introdurre troppi falsi positivi.</p>
      </details>
      <button class="sf-btn primary" id="calib-save-btn">💾 Salva profilo</button>
      <div id="calib-save-msg"></div>
    `;

    document.getElementById('calib-profile-name').addEventListener('input', (e) => {
      st.profileName = e.target.value || 'target_1';
      profile.name = st.profileName;
    });
    document.getElementById('calib-save-btn').addEventListener('click', () => {
      if (!st.profileName.trim()) return;
      profile.name = st.profileName.trim();
      profile.created_at = new Date().toISOString();
      SF.saveProfile(profile);
      document.getElementById('calib-save-msg').innerHTML =
        `<div class="sf-success">Profilo salvato come <strong>${SF.escapeHtml(profile.name)}</strong>. Sarà riutilizzabile dal modulo Elaborazione Batch.</div>`;
      renderSavedProfiles();
      SF.updateSidebarStatus();
    });

    scheduleLivePreview();
  }

  function renderSavedProfiles() {
    const out = document.getElementById('calib-saved-list');
    if (!out) return;
    const cv = window.cv;
    const saved = SF.listProfiles();
    if (!saved.length || !cv) {
      out.innerHTML = '';
      return;
    }
    out.innerHTML =
      '<h2 class="sf-section">Profili salvati</h2><div style="display:flex; flex-wrap:wrap; gap:0.5rem;">' +
      saved
        .map((p) => {
          const hex = profileHexColor(cv, p);
          return `<span class="sf-module-pill" style="color:#e6e6e6; border-color:rgba(255,255,255,0.15); background:rgba(255,255,255,0.04);">
            <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${hex};margin-right:2px;"></span>
            📄 ${SF.escapeHtml(p.name)}
            <span class="calib-del-profile" data-name="${SF.escapeHtml(p.name)}" title="Elimina profilo" style="cursor:pointer; margin-left:0.3rem; color:var(--danger);">✕</span>
          </span>`;
        })
        .join('') +
      '</div>';
    out.querySelectorAll('.calib-del-profile').forEach((el) => {
      el.addEventListener('click', () => {
        const name = el.getAttribute('data-name');
        if (confirm(`Eliminare il profilo "${name}"?`)) {
          SF.deleteProfile(name);
          renderSavedProfiles();
          SF.updateSidebarStatus();
        }
      });
    });
  }

  // ---------------------------------------------------------------- palette mode
  function setupPaletteMode() {
    const hexInput = document.getElementById('calib-palette-color');
    async function update() {
      const hex = hexInput.value;
      const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      const w = 2 * PATCH_HALF + 1, h = 2 * PATCH_HALF + 1;
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255;
      }
      st.currentPatchRgba = { data, width: w, height: h };
      st.sampleSource = 'palette';
      await computeAndRenderProfile();
    }
    hexInput.addEventListener('input', update);
    update();
  }

  // ---------------------------------------------------------------- layout / mode switch
  function renderModeBody() {
    const body = document.getElementById('calib-mode-body');
    if (st.mode === 'photo') {
      body.innerHTML = `
        <label class="sf-label">Foto del target (es. l'indumento)</label>
        <input type="file" id="calib-file-input" accept="image/*">
        <p class="sf-caption sf-hidden" id="calib-pick-hint">🖱️ Trascina la foto per spostarti, usa <strong>+ / −</strong>
          per ingrandire (anche rotellina del mouse). Clicca <strong>uno o più punti</strong> sul target (pieghe,
          ombra, luce diretta): più punti campioni, più il rilevamento sarà affidabile su foto reali.</p>
        <div id="calib-pz-container" class="sf-pz-wrap sf-hidden">
          <div id="calib-pz-viewport" class="sf-pz-viewport">
            <div class="sf-pz-hint" id="calib-pz-hint">clicca per scegliere il colore</div>
            <div class="sf-pz-controls">
              <div class="sf-pz-btn" id="calib-pz-plus">+</div>
              <div class="sf-pz-btn" id="calib-pz-minus">−</div>
              <div class="sf-pz-btn" id="calib-pz-reset" style="font-size:0.65rem;">⟲</div>
            </div>
            <div class="sf-pz-zoomlabel" id="calib-pz-zoomlabel">1.0x</div>
          </div>
          <div id="calib-points-toolbar" style="margin-top:0.5rem;"></div>
        </div>
      `;
      setupPzViewport();
      document.getElementById('calib-file-input').addEventListener('change', (e) => {
        if (e.target.files && e.target.files[0]) loadImageForPicking(e.target.files[0]);
      });
    } else {
      body.innerHTML = `
        <label class="sf-label">Scegli il colore del target</label>
        <input type="color" id="calib-palette-color" value="#c82828" style="width:120px; height:44px; padding:2px; cursor:pointer;">
      `;
      setupPaletteMode();
    }
  }

  function buildOnce() {
    const container = document.getElementById('calib-content');
    container.innerHTML = `
      <div class="sf-radio-row" id="calib-mode-radio">
        <label><input type="radio" name="calib-mode" value="photo" checked> 📷 Contagocce su una foto</label>
        <label><input type="radio" name="calib-mode" value="palette"> 🎨 Palette colore</label>
      </div>
      <div id="calib-mode-body"></div>
      <hr style="border-color:var(--border); margin: 1.4rem 0;">
      <div id="calib-preview"></div>
      <div id="calib-saved-list"></div>
    `;
    container.querySelectorAll('input[name="calib-mode"]').forEach((r) => {
      r.addEventListener('change', (e) => {
        st.mode = e.target.value;
        st.currentPatchRgba = null;
        st.samples = [];
        st.currentProfile = null;
        st.grayWorldGains = null; // Palette: nessuna foto la cui illuminazione vada compensata
        livePreviewGen++;
        document.getElementById('calib-preview').innerHTML = '';
        renderModeBody();
      });
    });
    renderModeBody();
    st.built = true;
  }

  SF.init_calibrazione = function () {
    if (!st.built) buildOnce();
    SF.loadCv().then(() => renderSavedProfiles());
  };
})();
