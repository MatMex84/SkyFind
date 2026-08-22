/**
 * Modulo 1 - Mission Planner Assistant: consigli di volo per la flotta drone in uso.
 * Porta 1:1 la logica di modules/mission_planner.py e pages/1_🛩️_Mission_Planner.py.
 */
window.SF = window.SF || {};

(function () {
  'use strict';

  // ---- Costanti (identiche a modules/mission_planner.py) ----
  const FRONT_OVERLAP_MIN = 70, FRONT_OVERLAP_MAX = 80;
  const SIDE_OVERLAP_MIN = 60, SIDE_OVERLAP_MAX = 70;
  const GSD_TARGET_MIN_CM = 0.8, GSD_TARGET_MAX_CM = 1.5;
  const MAX_PRACTICAL_SPEED_MS = 7.0;

  function altitudeForGsd(gsdCmPx, sensorWidthMm, focalLengthMm, imageWidthPx) {
    return (gsdCmPx * focalLengthMm * imageWidthPx) / (sensorWidthMm * 100);
  }
  function recommendedAltitudeRange(sensorWidthMm, focalLengthMm, imageWidthPx) {
    return [
      altitudeForGsd(GSD_TARGET_MIN_CM, sensorWidthMm, focalLengthMm, imageWidthPx),
      altitudeForGsd(GSD_TARGET_MAX_CM, sensorWidthMm, focalLengthMm, imageWidthPx),
    ];
  }
  function groundFootprintM(altitudeM, sensorWidthMm, sensorHeightMm, focalLengthMm) {
    return [(sensorWidthMm * altitudeM) / focalLengthMm, (sensorHeightMm * altitudeM) / focalLengthMm];
  }

  const mpState = {
    built: false,
    droneId: DRONES[0].id,
    custom: { sensor_width_mm: 6.3, sensor_height_mm: 4.7, image_width_px: 5280, image_height_px: 3956, focal_length_mm: 4.5 },
  };

  function currentSensor() {
    const d = DRONES.find((x) => x.id === mpState.droneId) || DRONES[0];
    const isCustom = d.sensor_width_mm === null;
    if (isCustom) {
      return { ...mpState.custom, drone: d.drone, sensore: d.sensore, note: d.note, isCustom: true };
    }
    return { ...d, isCustom: false };
  }

  function renderResults() {
    const out = document.getElementById('mp-results');
    if (!out) return;
    const sensor = currentSensor();

    if (!sensor.sensor_width_mm || !sensor.focal_length_mm || !sensor.image_width_px) {
      out.innerHTML = '<div class="sf-info">Inserisci i parametri della camera per vedere i consigli di missione.</div>';
      return;
    }
    if (sensor.sensor_width_mm <= 0 || sensor.focal_length_mm <= 0 || sensor.image_width_px <= 0) {
      out.innerHTML = '<div class="sf-error">Parametri non validi: i valori devono essere maggiori di zero.</div>';
      return;
    }

    let thermalNote = '';
    if (!sensor.isCustom && sensor.sensore && sensor.sensore.toLowerCase().includes('termic')) {
      thermalNote =
        '<div class="sf-info">📷 Camera termica: utile per la pianificazione di volo, ma SkyFind individua i target ' +
        'dal colore — usa una camera RGB per la ricerca.</div>';
    }

    const [altMin, altMax] = recommendedAltitudeRange(sensor.sensor_width_mm, sensor.focal_length_mm, sensor.image_width_px);
    const [footW, footH] = groundFootprintM(
      (altMin + altMax) / 2, sensor.sensor_width_mm, sensor.sensor_height_mm, sensor.focal_length_mm
    );
    const maxSpeed = MAX_PRACTICAL_SPEED_MS;

    out.innerHTML = `
      ${thermalNote}
      <h2 class="sf-section">✅ Consigli per questa missione</h2>
      <div class="sf-grid-4">
        <div class="sf-metric"><div class="sf-metric-label">Quota di volo consigliata</div><div class="sf-metric-value">${altMin.toFixed(0)}–${altMax.toFixed(0)} m</div></div>
        <div class="sf-metric"><div class="sf-metric-label">Overlap frontale</div><div class="sf-metric-value">${FRONT_OVERLAP_MIN}–${FRONT_OVERLAP_MAX}%</div></div>
        <div class="sf-metric"><div class="sf-metric-label">Overlap laterale</div><div class="sf-metric-value">${SIDE_OVERLAP_MIN}–${SIDE_OVERLAP_MAX}%</div></div>
        <div class="sf-metric"><div class="sf-metric-label">Velocità massima</div><div class="sf-metric-value">${maxSpeed.toFixed(0)} m/s</div></div>
      </div>
      <div class="sf-success">
        Vola tra <strong>${altMin.toFixed(0)} e ${altMax.toFixed(0)} metri</strong> dal suolo (AGL), con
        <strong>Terrain Following (DSM) attivo</strong> se il terreno non è pianeggiante — mantiene il GSD costante
        ed evita collisioni con dislivelli. A questa quota ogni fotogramma copre circa
        <strong>${footW.toFixed(0)} x ${footH.toFixed(0)} m</strong> a terra — utile per stimare quante strisciate
        servono per coprire l'area di ricerca.
      </div>
      <p><strong>Consigli pratici per lo scatto:</strong></p>
      <ul>
        <li>Imposta l'overlap ai valori indicati sopra nel software di pianificazione missione (es. DJI Pilot 2):
          front overlap ${FRONT_OVERLAP_MIN}-${FRONT_OVERLAP_MAX}%, side overlap ${SIDE_OVERLAP_MIN}-${SIDE_OVERLAP_MAX}%.</li>
        <li>Non superare <strong>${maxSpeed.toFixed(0)} m/s</strong> (${(maxSpeed * 3.6).toFixed(0)} km/h) di velocità di
          crociera: oltre questa soglia rischi foto mosse e overlap insufficiente. Con poca luce, cielo coperto o
          vento vola ancora più piano.</li>
        <li>Inclinazione camera (gimbal): tra <strong>-75° e -85°</strong> (leggermente obliqua) nella maggior parte
          dei casi — aiuta a vedere sotto rami/sporgenze e riduce le ombre nette sul bersaglio. Con vegetazione
          fitta passa a <strong>-90° (nadir puro)</strong>, per massimizzare le possibilità di inquadrare un varco
          nella chioma.</li>
        <li>Imposta il <strong>bilanciamento del bianco fisso</strong> (es. Sole ~5500K o Nuvoloso ~6500K), mai
          automatico: se il drone passa da erba a roccia con l'AWB attivo, il colore dell'indumento nella foto può
          spostarsi abbastanza da uscire dalla tolleranza cromatica calibrata nel modulo 2.</li>
        <li>Mantieni la quota costante durante tutta la missione: variazioni di quota cambiano il GSD e possono
          creare buchi nella copertura.</li>
        <li>Vola con luce diffusa quando possibile: ombre nette rendono più difficile il riconoscimento cromatico
          nel modulo di elaborazione.</li>
      </ul>
      <details class="sf-expander">
        <summary>Dettagli tecnici (sensore e calcolo GSD)</summary>
        <table class="sf-table">
          <tr><th>Parametro</th><th>Valore</th></tr>
          <tr><td>Larghezza sensore</td><td>${sensor.sensor_width_mm} mm</td></tr>
          <tr><td>Altezza sensore</td><td>${sensor.sensor_height_mm} mm</td></tr>
          <tr><td>Focale reale</td><td>${sensor.focal_length_mm} mm</td></tr>
          <tr><td>Risoluzione</td><td>${sensor.image_width_px} x ${sensor.image_height_px} px</td></tr>
        </table>
        ${!sensor.isCustom && sensor.note ? `<p class="sf-caption">ℹ️ ${SF.escapeHtml(sensor.note)}</p>` : ''}
        <p class="sf-caption">Range calcolato per un GSD (dettaglio a terra) target di ${GSD_TARGET_MIN_CM.toFixed(1)}–${GSD_TARGET_MAX_CM.toFixed(1)}
          cm/pixel (verificato sul dataset SAR accademico Heridal, foto scattate tra 40 e 65m, e sulle specifiche
          reali della flotta).</p>
        <p class="sf-caption">Velocità massima: tetto operativo prudenziale di ${maxSpeed.toFixed(0)} m/s (non solo motion
          blur — lascia margine per overlap, vento e affidabilità del rilevamento).</p>
      </details>
    `;
  }

  function renderCustomFields() {
    const wrap = document.getElementById('mp-custom-fields');
    if (!wrap) return;
    const sensor = DRONES.find((x) => x.id === mpState.droneId);
    if (!sensor || sensor.sensor_width_mm !== null) {
      wrap.innerHTML = '';
      return;
    }
    const c = mpState.custom;
    wrap.innerHTML = `
      <p><strong>Il tuo drone non è in elenco: inserisci i parametri della camera manualmente.</strong></p>
      <div class="sf-grid-2">
        <div>
          <label class="sf-label">Larghezza sensore (mm)</label>
          <input type="number" step="0.1" min="0.1" id="mp-sensor-width" value="${c.sensor_width_mm}">
        </div>
        <div>
          <label class="sf-label">Altezza sensore (mm)</label>
          <input type="number" step="0.1" min="0.1" id="mp-sensor-height" value="${c.sensor_height_mm}">
        </div>
        <div>
          <label class="sf-label">Larghezza immagine (px)</label>
          <input type="number" step="1" min="1" id="mp-image-width" value="${c.image_width_px}">
        </div>
        <div>
          <label class="sf-label">Altezza immagine (px)</label>
          <input type="number" step="1" min="1" id="mp-image-height" value="${c.image_height_px}">
        </div>
      </div>
      <label class="sf-label">Lunghezza focale reale (mm, non equivalente)</label>
      <input type="number" step="0.1" min="0.1" id="mp-focal-length" value="${c.focal_length_mm}">
    `;
    const bind = (id, key, isFloat) => {
      document.getElementById(id).addEventListener('input', (e) => {
        const v = isFloat ? parseFloat(e.target.value) : parseInt(e.target.value, 10);
        mpState.custom[key] = Number.isFinite(v) ? v : 0;
        renderResults();
      });
    };
    bind('mp-sensor-width', 'sensor_width_mm', true);
    bind('mp-sensor-height', 'sensor_height_mm', true);
    bind('mp-image-width', 'image_width_px', false);
    bind('mp-image-height', 'image_height_px', false);
    bind('mp-focal-length', 'focal_length_mm', true);
  }

  function buildOnce() {
    const container = document.getElementById('mp-content');
    if (!container) return;
    const options = DRONES.map((d) => `<option value="${d.id}">${SF.escapeHtml(d.drone)} — ${SF.escapeHtml(d.sensore)}</option>`).join('');
    container.innerHTML = `
      <label class="sf-label">Drone e camera in uso</label>
      <select id="mp-drone-select">${options}</select>
      <div id="mp-custom-fields" style="margin-top:0.9rem;"></div>
      <hr style="border-color:var(--border); margin: 1.4rem 0;">
      <div id="mp-results"></div>
    `;
    document.getElementById('mp-drone-select').value = mpState.droneId;
    document.getElementById('mp-drone-select').addEventListener('change', (e) => {
      mpState.droneId = e.target.value;
      renderCustomFields();
      renderResults();
    });
    mpState.built = true;
  }

  SF.init_mission = function () {
    if (!mpState.built) buildOnce();
    renderCustomFields();
    renderResults();
  };
})();
