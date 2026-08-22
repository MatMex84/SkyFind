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
    currentPatchRgba: null, // {data, width, height}
    currentProfile: null,
    pointCaption: '',
    sampleSource: '',
    // pan/zoom
    imgEl: null, fullCanvas: null, natW: 0, natH: 0,
    zoom: 1, left: 0, top: 0, fitScale: 1,
    dragging: false, moved: false, startX: 0, startY: 0, startLeft: 0, startTop: 0,
  };

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
    if (e.target.closest('.sf-pz-btn')) return; // lascia gestire il click ai bottoni +/-/reset
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

      // canvas nascosto a piena risoluzione, usato solo per campionare i pixel al click
      st.fullCanvas = document.createElement('canvas');
      st.fullCanvas.width = st.natW;
      st.fullCanvas.height = st.natH;
      st.fullCanvas.getContext('2d').drawImage(img, 0, 0);

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
    };
    img.src = url;
  }

  // ---------------------------------------------------------------- estrazione patch + profilo
  function clampedPatch(cx, cy) {
    const w = 2 * PATCH_HALF + 1, h = 2 * PATCH_HALF + 1;
    const x0 = Math.max(0, cx - PATCH_HALF), y0 = Math.max(0, cy - PATCH_HALF);
    const x1 = Math.min(st.natW, cx - PATCH_HALF + w), y1 = Math.min(st.natH, cy - PATCH_HALF + h);
    if (x1 <= x0 || y1 <= y0) {
      const sx = Math.max(0, Math.min(st.natW - 1, cx)), sy = Math.max(0, Math.min(st.natH - 1, cy));
      const imgData = st.fullCanvas.getContext('2d').getImageData(sx, sy, 1, 1);
      return { data: imgData.data, width: 1, height: 1 };
    }
    const imgData = st.fullCanvas.getContext('2d').getImageData(x0, y0, x1 - x0, y1 - y0);
    return { data: imgData.data, width: x1 - x0, height: y1 - y0 };
  }

  async function pickPoint(x, y) {
    st.currentPatchRgba = clampedPatch(x, y);
    st.pointCaption = `Punto selezionato: x=${x}, y=${y} (immagine ${st.natW}x${st.natH} px)`;
    await computeAndRenderProfile();
    positionCrosshair(x, y);
  }

  function positionCrosshair(x, y) {
    let crosshair = document.getElementById('calib-pz-crosshair');
    const viewport = document.getElementById('calib-pz-viewport');
    if (!crosshair) {
      crosshair = document.createElement('div');
      crosshair.id = 'calib-pz-crosshair';
      crosshair.className = 'sf-pz-crosshair';
      viewport.appendChild(crosshair);
    }
    const s = effScale();
    crosshair.style.left = st.left + x * s + 'px';
    crosshair.style.top = st.top + y * s + 'px';
  }

  async function computeAndRenderProfile() {
    if (!st.currentPatchRgba) return;
    const cv = await SF.loadCv();
    const { data, width, height } = st.currentPatchRgba;
    st.currentProfile = computeProfileFromPatch(cv, data, width, height);
    st.currentProfile.name = st.profileName;
    st.currentProfile.sample_source = st.sampleSource;
    renderProfilePreview();
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

    const [l0, a0, b0] = profile.mean_lab;
    const tolL = profile.tolerance_lab[0];
    const steps = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1];
    const swatches = steps
      .map((frac) => `<div class="sf-swatch-item" style="background-color:${labToHex(cv, l0 + frac * tolL, a0, b0)};"></div>`)
      .join('');

    const captionTxt = st.mode === 'photo' ? st.pointCaption : 'Colore scelto dalla palette';

    out.innerHTML = `
      <h2 class="sf-section">Colore selezionato</h2>
      <div class="sf-grid-2">
        <div>
          <div class="sf-swatch" style="background-color:${hex};"></div>
          <p class="sf-caption">${SF.escapeHtml(captionTxt)} · ${hex}</p>
          <label class="sf-label">Nome profilo</label>
          <input type="text" id="calib-profile-name" value="${SF.escapeHtml(profile.name)}">
        </div>
        <div>
          <h3 style="margin-top:0;">Anteprima tolleranza</h3>
          <p class="sf-caption">Il range di colore ancora riconosciuto, dal più scuro al più chiaro:</p>
          <div class="sf-swatch-row">${swatches}</div>
          <div style="display:flex; justify-content:space-between; margin-top:0.3rem;">
            <span class="sf-caption">⬅ più scuro</span>
            <span class="sf-caption">centro</span>
            <span class="sf-caption">più chiaro ➡</span>
          </div>
        </div>
      </div>
      <details class="sf-expander">
        <summary>Dettagli tecnici (HSV / CIE-LAB)</summary>
        <div class="sf-grid-2">
          <div>
            <strong>Colore medio HSV</strong>
            <pre>H=${profile.mean_hsv[0].toFixed(2)}  S=${profile.mean_hsv[1].toFixed(2)}  V=${profile.mean_hsv[2].toFixed(2)}</pre>
            <p class="sf-caption">Range maschera (HSV): ${JSON.stringify(hsvBounds(profile).lower)} → ${JSON.stringify(hsvBounds(profile).upper)}</p>
          </div>
          <div>
            <strong>Colore medio CIE-LAB</strong>
            <pre>L=${profile.mean_lab[0].toFixed(2)}  a=${profile.mean_lab[1].toFixed(2)}  b=${profile.mean_lab[2].toFixed(2)}</pre>
            <p class="sf-caption">Range maschera (LAB): ${JSON.stringify(labBounds(profile).lower)} → ${JSON.stringify(labBounds(profile).upper)}</p>
          </div>
        </div>
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
          per ingrandire (anche rotellina del mouse), clicca per scegliere il colore del target.</p>
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
        st.currentProfile = null;
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
