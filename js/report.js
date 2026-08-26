/**
 * Modulo 4 - Report: anteprima foto intera con il target cerchiato (stile SkyReport),
 * miniature in basso e lightbox per l'ingrandimento. Porta di pages/4_📋_Report.py +
 * modules/report.py (export HTML/CSV).
 */
window.SF = window.SF || {};

(function () {
  'use strict';

  const st = {
    built: false, minConfidence: 0, cropUrls: new Map(), browseIdx: 0, viewMode: 'photo', dedupRadiusM: 7, filterExports: false,
    // Punto 6 — "falso positivo": disattivato di default (impostazione avanzata, opt-in) perché è
    // un'azione che RIMUOVE davvero un rilevamento da schede ed export (diversa dal filtro per
    // punteggio sopra, che non cancella mai nulla) — va attivata consapevolmente prima di comparire.
    reviewMode: false,
    falsePositiveLog: [], // {result, det, idx} nell'ordine in cui sono stati rimossi, per "annulla ultima eliminazione"
    profileDirty: false, // true se SF.state.batchProfile e' stato ristretto in memoria ma non ancora salvato
  };
  const fileUrlCache = new WeakMap();
  let browseItems = []; // [{result, dets, file}], costruito all'apertura della modalita' Sfoglia
  let lightboxCurrent = null; // { det, result } del rilevamento aperto nella lightbox — per il pulsante falso positivo

  function cropUrl(det) {
    if (!st.cropUrls.has(det)) {
      const blob = new Blob([det.crop_jpeg], { type: 'image/jpeg' });
      st.cropUrls.set(det, URL.createObjectURL(blob));
    }
    return st.cropUrls.get(det);
  }

  function fileUrl(file) {
    if (!fileUrlCache.has(file)) fileUrlCache.set(file, URL.createObjectURL(file));
    return fileUrlCache.get(file);
  }

  function mapsLink(lat, lon) {
    return `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
  }

  // ------------------------------------------------------------- deduplica cross-foto (punto 3)
  /**
   * Raccoglie tutte le detection sopra soglia confidenza, divise tra quelle con posizione GPS del
   * target calcolabile (punto 1, deduplicabili per prossimità) e quelle senza (nessuna camera/quota
   * configurata, o EXIF assente): queste ultime non spariscono, restano visibili separatamente
   * perché la deduplica per posizione non può includerle.
   */
  function gatherGeoreferencedItems(minConfidence) {
    const results = SF.state.batchResults || [];
    const withGeo = [], withoutGeo = [];
    results.forEach((r) => {
      (r.detections || []).forEach((d) => {
        if (d.confidence < minConfidence) return;
        const item = { det: d, result: r };
        if (d.target_lat !== null && d.target_lat !== undefined) withGeo.push(item);
        else withoutGeo.push(item);
      });
    });
    return { withGeo, withoutGeo };
  }

  /**
   * Raggruppa le detection georiferite che ricadono entro `thresholdM` metri l'una dall'altra: lo
   * stesso target visto in scatti diversi con overlap frontale/laterale diventa un cluster unico
   * invece di righe duplicate nel Report. Algoritmo greedy voluto semplice (niente DBSCAN o
   * dipendenze esterne): si processa in ordine di confidenza decrescente, ogni detection entra nel
   * cluster più vicino il cui centroide è entro soglia (il centroide si ricalcola come media a ogni
   * aggiunta), altrimenti apre un cluster nuovo. A scala di missione SAR (decine di target al più)
   * è sufficiente e resta facile da verificare/spiegare.
   *
   * Limite noto: essendo greedy e basato sul centroide corrente (non su ogni coppia di punti), in
   * casi limite (tanti target ravvicinati in fila, a distanza vicina alla soglia) può unire o
   * separare diversamente da un clustering esaustivo — accettabile per l'uso previsto.
   */
  function clusterDetectionsByGps(items, thresholdM) {
    const clusters = [];
    const sorted = items.slice().sort((a, b) => b.det.confidence - a.det.confidence);
    for (const item of sorted) {
      let best = null, bestDist = Infinity;
      for (const cl of clusters) {
        const d = distanceMetersApprox(item.det.target_lat, item.det.target_lon, cl.lat, cl.lon);
        if (d <= thresholdM && d < bestDist) { best = cl; bestDist = d; }
      }
      if (best) {
        best.items.push(item);
        best.lat = best.items.reduce((s, it) => s + it.det.target_lat, 0) / best.items.length;
        best.lon = best.items.reduce((s, it) => s + it.det.target_lon, 0) / best.items.length;
      } else {
        clusters.push({ lat: item.det.target_lat, lon: item.det.target_lon, items: [item] });
      }
    }
    return clusters;
  }

  function drawCircles(canvas, img, dets, selectedIdx) {
    const w = img.naturalWidth, h = img.naturalHeight;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    const rectW = canvas.getBoundingClientRect().width || w;
    const lineW = Math.max(2, (4 * w) / Math.max(1, rectW));
    dets.forEach((d, i) => {
      const [bx, by, bw, bh] = d.bbox;
      const cx = bx + bw / 2, cy = by + bh / 2;
      const r = Math.min(w * 0.09, Math.max(w * 0.018, Math.max(bw, bh) * 1.3));
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = i === selectedIdx ? '#6EA8FE' : '#F5A623';
      ctx.lineWidth = i === selectedIdx ? lineW * 1.6 : lineW;
      ctx.shadowColor = 'rgba(0,0,0,0.65)';
      ctx.shadowBlur = lineW;
      ctx.stroke();
    });
  }

  // ------------------------------------------------------------- modalità Sfoglia (schermo intero, in sequenza)
  function setupBrowseModal() {
    if (document.getElementById('sf-browse-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'sf-browse-modal';
    modal.className = 'sf-browse-modal';
    modal.innerHTML = `
      <div class="sf-browse-top">
        <span class="sf-browse-counter" id="sf-browse-counter"></span>
        <button class="sf-browse-close" id="sf-browse-close" title="Chiudi (Esc)">×</button>
      </div>
      <div class="sf-browse-stage">
        <button class="sf-browse-nav prev" id="sf-browse-prev" title="Foto precedente (←)">‹</button>
        <div class="sf-browse-frame" id="sf-browse-frame"></div>
        <button class="sf-browse-nav next" id="sf-browse-next" title="Foto successiva (→)">›</button>
      </div>
      <div class="sf-browse-caption" id="sf-browse-caption"></div>
    `;
    document.body.appendChild(modal);
    document.getElementById('sf-browse-close').addEventListener('click', closeBrowse);
    document.getElementById('sf-browse-prev').addEventListener('click', () => browseStep(-1));
    document.getElementById('sf-browse-next').addEventListener('click', () => browseStep(1));
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeBrowse();
    });
    document.addEventListener('keydown', (e) => {
      if (!modal.classList.contains('open')) return;
      if (e.key === 'Escape') closeBrowse();
      else if (e.key === 'ArrowLeft') browseStep(-1);
      else if (e.key === 'ArrowRight') browseStep(1);
    });
  }

  function openBrowse(startIdx) {
    const filtered = getFiltered();
    const files = SF.state.batchFiles || [];
    browseItems = filtered.map(([r, dets]) => ({ result: r, dets, file: files[r._idx] }));
    if (!browseItems.length) return;
    st.browseIdx = Math.max(0, Math.min(browseItems.length - 1, startIdx || 0));
    document.getElementById('sf-browse-modal').classList.add('open');
    renderBrowseFrame();
  }

  function closeBrowse() {
    const modal = document.getElementById('sf-browse-modal');
    if (modal) modal.classList.remove('open');
  }

  function browseStep(delta) {
    if (!browseItems.length) return;
    st.browseIdx = (st.browseIdx + delta + browseItems.length) % browseItems.length;
    renderBrowseFrame();
  }

  function renderBrowseFrame() {
    const item = browseItems[st.browseIdx];
    if (!item) return;
    const frame = document.getElementById('sf-browse-frame');
    frame.innerHTML = '';
    document.getElementById('sf-browse-counter').textContent = `Foto ${st.browseIdx + 1} di ${browseItems.length}`;

    const bestConf = item.dets.length ? Math.max(...item.dets.map((d) => d.confidence)) : 0;
    const gpsTxt =
      item.result.gps_lat !== null
        ? `📍 <a href="${mapsLink(item.result.gps_lat, item.result.gps_lon)}" target="_blank" rel="noopener">${item.result.gps_lat.toFixed(6)}, ${item.result.gps_lon.toFixed(6)}</a>`
        : '📍 GPS non disponibile';
    document.getElementById('sf-browse-caption').innerHTML =
      `<strong>${SF.escapeHtml(item.result.name)}</strong> — ${item.dets.length} rilevamento/i (max ${SF.formatNum(bestConf)}%) · ` +
      `${gpsTxt} · 🕒 ${SF.escapeHtml(item.result.datetime_original || 'n/d')}`;

    if (item.file) {
      const img = document.createElement('img');
      const canvas = document.createElement('canvas');
      img.src = fileUrl(item.file);
      img.addEventListener('load', () => drawCircles(canvas, img, item.dets, -1));
      frame.appendChild(img);
      frame.appendChild(canvas);
    } else {
      frame.innerHTML = '<p class="sf-caption" style="color:#fff; padding:2rem;">Anteprima foto non disponibile (ricaricata da una sessione precedente).</p>';
    }
  }

  /** Riga con la posizione GPS stimata del target (non del centro foto), o il motivo per cui manca. */
  function targetGeoLine(det) {
    if (det.target_lat !== null && det.target_lat !== undefined) {
      const warn = det.geo_warning ? ` ⚠️ ${SF.escapeHtml(det.geo_warning)}` : '';
      const noHeading = !det.heading_source
        ? ' (heading della camera non disponibile nei metadati: assunto nord=alto immagine)'
        : '';
      return (
        `📍 target: <a href="${mapsLink(det.target_lat, det.target_lon)}" target="_blank" rel="noopener">` +
        `${det.target_lat.toFixed(6)}, ${det.target_lon.toFixed(6)}</a>${noHeading}${warn}`
      );
    }
    return `📍 target: posizione non calcolabile${det.geo_note ? ' (' + SF.escapeHtml(det.geo_note) + ')' : ''}`;
  }

  /** Riga di avviso sulla forma del blob (filtro geometrico, punto 2): non un errore, solo un
   *  invito a verificare a video — tipico di un target parzialmente coperto nella foto. */
  function shapeWarningLine(det) {
    if (!det.geom_warning) return '';
    return `🔍 ${SF.escapeHtml(det.geom_warning)}`;
  }

  function openLightbox(det, result) {
    const box = document.getElementById('sf-lightbox');
    lightboxCurrent = { det, result };
    document.getElementById('sf-lightbox-img').src = cropUrl(det);
    const shapeLine = shapeWarningLine(det);
    document.getElementById('sf-lightbox-caption').innerHTML =
      `${SF.escapeHtml(result.name)} — Confidenza: <strong>${SF.formatNum(det.confidence)}%</strong> · ` +
      `Area: ${SF.formatNum(det.fill_ratio)}% · bbox: x=${det.bbox[0]} y=${det.bbox[1]} w=${det.bbox[2]} h=${det.bbox[3]}<br>` +
      targetGeoLine(det) + (shapeLine ? `<br>${shapeLine}` : '');
    const fpBtn = document.getElementById('sf-lightbox-fp-btn');
    if (fpBtn) fpBtn.style.display = st.reviewMode ? 'inline-block' : 'none';
    box.classList.add('open');
  }

  // ------------------------------------------------------------- punto 6: "falso positivo"
  /**
   * Rimuove DAVVERO il rilevamento da schede/export (a differenza del filtro per punteggio, che
   * non nasconde mai nulla dai dati) — è una scelta esplicita dell'utente su UN rilevamento preciso,
   * non un taglio automatico globale. Se il colore effettivamente rilevato è disponibile
   * (detected_mean_lab, punto 5/6 in detect_worker.js), viene usato come campione negativo per
   * restringere in memoria la tolleranza del profilo colore corrente — non salvato in automatico:
   * l'utente decide se renderlo permanente col pulsante dedicato nel pannello di revisione.
   */
  function markFalsePositive(det, result) {
    const idx = result.detections.indexOf(det);
    if (idx === -1) return;
    result.detections.splice(idx, 1);

    const profile = SF.state.batchProfile;
    if (profile && det.detected_mean_lab) {
      const before = profile.tolerance_lab.slice();
      const narrowed = narrowToleranceFromFalsePositive(profile, det.detected_mean_lab);
      if (narrowed.some((v, i) => v !== before[i])) {
        profile.tolerance_lab = narrowed;
        st.profileDirty = true;
      }
    }
    st.falsePositiveLog.push({ result, det, idx });
    render();
  }

  /** Ripristina l'ultimo rilevamento rimosso. NON riallarga la tolleranza del profilo (che nel
   *  frattempo può essere già stata salvata, o ulteriormente ristretta da altre marcature): per
   *  tornare alla tolleranza originale basta non salvare, o ricaricare il profilo da Calibrazione. */
  function undoLastFalsePositive() {
    const entry = st.falsePositiveLog.pop();
    if (!entry) return;
    const pos = Math.min(entry.idx, entry.result.detections.length);
    entry.result.detections.splice(pos, 0, entry.det);
    render();
  }

  /** "Ri-applica filtro" (punto 6): rielabora lo stesso lotto di foto già in memoria (SF.state.
   *  batchFiles) con il profilo aggiornato, riusando lo stesso pool di worker dell'Elaborazione
   *  Batch (SF.runDetectionPoolAsync) — senza dover riselezionare la cartella né rifare la
   *  configurazione ("senza I/O completo" nel senso della roadmap: nessun nuovo giro nella UI di
   *  Elaborazione Batch, solo la rilettura/decodifica delle foto già note, inevitabile perché la
   *  maschera colore va ricalcolata con la nuova tolleranza). Sostituisce interamente i risultati:
   *  l'elenco "annulla" del pannello di revisione viene azzerato perché si riferirebbe a oggetti
   *  detection ormai sostituiti da rilevamenti nuovi.
   */
  function rerunWithUpdatedProfile() {
    const files = SF.state.batchFiles;
    const profile = SF.state.batchProfile;
    const config = SF.state.batchConfig;
    if (!files || !files.length || !profile || !config) return;
    if (
      !confirm(
        'Rielaborare tutte le foto con il profilo colore aggiornato? Sostituirà i rilevamenti attuali ' +
          '(quelli già segnati come falso positivo restano esclusi solo se il nuovo profilo non li rileva più) ' +
          "e azzererà l'elenco \"annulla\" di questa sessione."
      )
    ) {
      return;
    }
    const progressEl = document.getElementById('report-rerun-progress');
    if (progressEl) progressEl.textContent = `Rielaborazione in corso… 0/${files.length}`;
    SF.runDetectionPoolAsync(files, profile, config, (done, total) => {
      const el = document.getElementById('report-rerun-progress');
      if (el) el.textContent = `Rielaborazione in corso… ${done}/${total}`;
    }).then((results) => {
      SF.state.batchResults = results;
      st.falsePositiveLog = [];
      render();
    });
  }

  function renderReviewPanel() {
    const panel = document.getElementById('report-review-panel');
    if (!panel) return;
    if (!st.reviewMode) {
      panel.innerHTML = '';
      return;
    }
    const canRerun = !!(SF.state.batchFiles && SF.state.batchFiles.length && SF.state.batchProfile);
    panel.innerHTML = `
      <div class="sf-info" style="margin-top:0.6rem;">
        ${
          st.falsePositiveLog.length
            ? `<div>${st.falsePositiveLog.length} rilevamento/i segnato/i come falso positivo in questa sessione —
               <span class="sf-link-btn" id="report-fp-undo">annulla ultima eliminazione</span></div>`
            : '<div>Nessun rilevamento segnato come falso positivo finora in questa sessione.</div>'
        }
        ${
          st.profileDirty
            ? `<div style="margin-top:0.5rem;">🔧 Il profilo colore <strong>${SF.escapeHtml(SF.state.batchProfileName || '')}</strong>
               è stato ristretto in memoria a partire dai falsi positivi segnalati, non ancora salvato.
               <button class="sf-btn" id="report-fp-save-profile" style="margin-left:0.4rem;">💾 Salva profilo aggiornato</button></div>`
            : ''
        }
        ${
          canRerun
            ? `<div style="margin-top:0.6rem;">
                 <button class="sf-btn" id="report-fp-rerun">🔁 Ri-applica filtro su tutte le foto</button>
                 <span class="sf-caption" id="report-rerun-progress"></span>
                 <p class="sf-caption">Rielabora tutte le foto già caricate con il profilo aggiornato, senza dover
                   riselezionare la cartella — utile dopo aver segnato uno o più falsi positivi, per vedere
                   subito l'effetto sull'intero lotto.</p>
               </div>`
            : ''
        }
      </div>
    `;
    const undoBtn = document.getElementById('report-fp-undo');
    if (undoBtn) undoBtn.addEventListener('click', undoLastFalsePositive);
    const saveBtn = document.getElementById('report-fp-save-profile');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        SF.saveProfile(SF.state.batchProfile);
        st.profileDirty = false;
        SF.updateSidebarStatus();
        renderReviewPanel();
      });
    }
    const rerunBtn = document.getElementById('report-fp-rerun');
    if (rerunBtn) rerunBtn.addEventListener('click', rerunWithUpdatedProfile);
  }

  function renderPhotoCard(result, file, dets, browseIndex) {
    const card = document.createElement('div');
    card.className = 'sf-photo-card';

    const gpsTxt =
      result.gps_lat !== null
        ? `📍 <a href="${mapsLink(result.gps_lat, result.gps_lon)}" target="_blank" rel="noopener">${result.gps_lat.toFixed(6)}, ${result.gps_lon.toFixed(6)}</a>`
        : '📍 GPS non disponibile';

    card.innerHTML = `
      <div class="sf-photo-card-head">
        <div>
          <div class="sf-photo-card-title">${SF.escapeHtml(result.name)} — ${dets.length} rilevamento/i</div>
          <div class="sf-photo-card-meta">
            <span>${gpsTxt}</span>
            <span>🕒 ${SF.escapeHtml(result.datetime_original || 'n/d')}</span>
          </div>
        </div>
        <div style="display:flex; align-items:center; gap:0.6rem; flex-shrink:0;">
          <button class="sf-btn" id="browse-open-${result._idx}" title="Apri in modalità Sfoglia">🖼️ Sfoglia da qui</button>
          <span class="sf-photo-card-chevron">▶</span>
        </div>
      </div>
      <div class="sf-photo-card-body">
        <div class="sf-photo-preview" id="prev-${result._idx}"></div>
        <div class="sf-thumb-strip" id="thumbs-${result._idx}"></div>
      </div>
    `;

    card.querySelector('.sf-photo-card-head').addEventListener('click', () => {
      const wasOpen = card.classList.contains('open');
      card.classList.toggle('open');
      if (!wasOpen) renderPhotoBody(card, result, file, dets);
    });
    card.querySelector(`#browse-open-${result._idx}`).addEventListener('click', (e) => {
      e.stopPropagation();
      openBrowse(browseIndex);
    });

    return card;
  }

  function renderPhotoBody(card, result, file, dets) {
    const previewEl = card.querySelector(`#prev-${result._idx}`);
    const thumbsEl = card.querySelector(`#thumbs-${result._idx}`);
    if (previewEl.dataset.rendered) return;
    previewEl.dataset.rendered = '1';

    let selectedIdx = -1;

    if (file) {
      const img = document.createElement('img');
      const canvas = document.createElement('canvas');
      img.src = URL.createObjectURL(file);
      img.addEventListener('load', () => drawCircles(canvas, img, dets, selectedIdx));
      previewEl.appendChild(img);
      previewEl.appendChild(canvas);
      previewEl.addEventListener('click', () => {
        if (dets.length) openLightbox(dets[Math.max(0, selectedIdx)], result);
      });
      window.addEventListener('resize', () => {
        if (img.complete && img.naturalWidth) drawCircles(canvas, img, dets, selectedIdx);
      });
    } else {
      previewEl.innerHTML = '<p class="sf-caption" style="padding:1rem;">Anteprima foto non disponibile (ricaricata da una sessione precedente).</p>';
    }

    dets
      .slice()
      .sort((a, b) => b.confidence - a.confidence)
      .forEach((d) => {
        const idxInOriginal = dets.indexOf(d);
        const thumb = document.createElement('div');
        thumb.className = 'sf-thumb';
        const flagBadge = d.geom_warning ? `<div class="sf-thumb-flag" title="${SF.escapeHtml(d.geom_warning)}">🔍</div>` : '';
        thumb.innerHTML = `<img src="${cropUrl(d)}"><div class="sf-thumb-conf">${SF.formatNum(d.confidence)}%</div>${flagBadge}`;
        thumb.addEventListener('click', () => {
          selectedIdx = idxInOriginal;
          thumbsEl.querySelectorAll('.sf-thumb').forEach((t) => t.classList.remove('selected'));
          thumb.classList.add('selected');
          const img = previewEl.querySelector('img');
          const canvas = previewEl.querySelector('canvas');
          if (img && canvas && img.naturalWidth) drawCircles(canvas, img, dets, selectedIdx);
          openLightbox(d, result);
        });
        thumbsEl.appendChild(thumb);
      });
  }

  // ------------------------------------------------------------- export
  function arrayBufferToBase64(buf) {
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function buildHtmlReport(filtered, profileName, minConfidence) {
    const totalDetections = filtered.reduce((s, [, dets]) => s + dets.length, 0);
    const cards = filtered
      .map(([r, dets]) => {
        const gpsTxt = r.gps_lat !== null ? `${r.gps_lat.toFixed(6)}, ${r.gps_lon.toFixed(6)}` : 'GPS non disponibile';
        const mapsHtml =
          r.gps_lat !== null ? ` — <a href="${mapsLink(r.gps_lat, r.gps_lon)}" target="_blank" rel="noopener">apri in mappa</a>` : '';
        const detCards = dets
          .map((d) => {
            const b64 = arrayBufferToBase64(d.crop_jpeg);
            const [x, y, w, h] = d.bbox;
            const targetGpsHtml =
              d.target_lat !== null && d.target_lat !== undefined
                ? `<div><strong>Posizione target:</strong> <a href="${mapsLink(d.target_lat, d.target_lon)}" target="_blank" rel="noopener">${d.target_lat.toFixed(6)}, ${d.target_lon.toFixed(6)}</a>${d.geo_warning ? ' ⚠️ ' + SF.escapeHtml(d.geo_warning) : ''}</div>`
                : `<div><strong>Posizione target:</strong> non calcolabile${d.geo_note ? ' (' + SF.escapeHtml(d.geo_note) + ')' : ''}</div>`;
            const shapeWarningHtml = d.geom_warning ? `<div>🔍 ${SF.escapeHtml(d.geom_warning)}</div>` : '';
            return `<div class="det-card"><img src="data:image/jpeg;base64,${b64}" alt="target rilevato" />
              <div class="det-meta"><div><strong>Confidenza:</strong> ${SF.formatNum(d.confidence)}%</div>
              <div><strong>Copertura area:</strong> ${SF.formatNum(d.fill_ratio)}%</div>
              <div><strong>Bounding box:</strong> x=${x} y=${y} w=${w} h=${h}</div>${targetGpsHtml}${shapeWarningHtml}</div></div>`;
          })
          .join('');
        return `<section class="photo-card"><h3>${SF.escapeHtml(r.name)}</h3>
          <div class="photo-meta"><span>📍 ${gpsTxt}${mapsHtml}</span><span>🕒 ${SF.escapeHtml(r.datetime_original || 'n/d')}</span>
          <span>${dets.length} rilevamento/i</span></div><div class="det-grid">${detCards}</div></section>`;
      })
      .join('');

    const css = `
      body { font-family: system-ui, sans-serif; margin: 2rem; background:#0e1117; color:#e6e6e6; }
      h1 { margin-bottom: 0.2rem; }
      .summary { color:#9aa0a6; margin-bottom: 2rem; }
      .photo-card { border:1px solid #333; border-radius:10px; padding:1rem; margin-bottom:1.5rem; background:#161b22; }
      .photo-meta { display:flex; flex-wrap:wrap; gap:1.5rem; color:#9aa0a6; font-size:0.9rem; margin-bottom:0.8rem; }
      .photo-meta a { color:#6ea8fe; }
      .det-grid { display:flex; flex-wrap:wrap; gap:1rem; }
      .det-card { width:220px; border:1px solid #333; border-radius:8px; overflow:hidden; background:#0e1117; }
      .det-card img { width:100%; display:block; }
      .det-meta { padding:0.5rem; font-size:0.85rem; }
    `;
    const body = cards || '<p>Nessun rilevamento sopra la soglia di confidenza scelta.</p>';
    return `<!doctype html><html lang="it"><head><meta charset="utf-8" /><title>Report SkyFind</title><style>${css}</style></head>
      <body><h1>🛰️ Report rilevamenti — SkyFind</h1>
      <div class="summary">Profilo colore: <strong>${SF.escapeHtml(profileName)}</strong> — ${SF.state.batchResults.length} foto analizzate,
      ${filtered.length} con rilevamenti, ${totalDetections} target individuati (soglia confidenza ≥ ${minConfidence.toFixed(0)}%).</div>
      ${body}</body></html>`;
  }

  // ------------------------------------------------------------- export "Target unici" (punto 3)
  function buildHtmlReportByTarget(clusters, withoutGeo, profileName, minConfidence) {
    const cards = clusters
      .map((cl, i) => {
        const items = cl.items.slice().sort((a, b) => b.det.confidence - a.det.confidence);
        const photoNames = [...new Set(items.map((it) => it.result.name))];
        const detCards = items
          .map((it) => {
            const d = it.det;
            const b64 = arrayBufferToBase64(d.crop_jpeg);
            const shapeWarningHtml = d.geom_warning ? `<div>🔍 ${SF.escapeHtml(d.geom_warning)}</div>` : '';
            return `<div class="det-card"><img src="data:image/jpeg;base64,${b64}" alt="target rilevato" />
              <div class="det-meta"><div><strong>Foto:</strong> ${SF.escapeHtml(it.result.name)}</div>
              <div><strong>Confidenza:</strong> ${SF.formatNum(d.confidence)}%</div>${shapeWarningHtml}</div></div>`;
          })
          .join('');
        return `<section class="photo-card"><h3>🎯 Target ${i + 1}</h3>
          <div class="photo-meta"><span>📍 <a href="${mapsLink(cl.lat, cl.lon)}" target="_blank" rel="noopener">${cl.lat.toFixed(6)}, ${cl.lon.toFixed(6)}</a> (centroide)</span>
          <span>${items.length} rilevamento/i in ${photoNames.length} foto: ${photoNames.map((n) => SF.escapeHtml(n)).join(', ')}</span></div>
          <div class="det-grid">${detCards}</div></section>`;
      })
      .join('');

    const withoutGeoHtml = withoutGeo.length
      ? `<p>${withoutGeo.length} rilevamento/i sopra soglia senza posizione GPS del target (non deduplicabile/i per
         prossimità): ${withoutGeo.map((it) => SF.escapeHtml(it.result.name)).join(', ')}.</p>`
      : '';

    const css = `
      body { font-family: system-ui, sans-serif; margin: 2rem; background:#0e1117; color:#e6e6e6; }
      h1 { margin-bottom: 0.2rem; }
      .summary { color:#9aa0a6; margin-bottom: 2rem; }
      .photo-card { border:1px solid #333; border-radius:10px; padding:1rem; margin-bottom:1.5rem; background:#161b22; }
      .photo-meta { display:flex; flex-wrap:wrap; gap:1.5rem; color:#9aa0a6; font-size:0.9rem; margin-bottom:0.8rem; }
      .photo-meta a { color:#6ea8fe; }
      .det-grid { display:flex; flex-wrap:wrap; gap:1rem; }
      .det-card { width:220px; border:1px solid #333; border-radius:8px; overflow:hidden; background:#0e1117; }
      .det-card img { width:100%; display:block; }
      .det-meta { padding:0.5rem; font-size:0.85rem; }
    `;
    const body = cards || '<p>Nessun target georiferito sopra la soglia di confidenza scelta.</p>';
    return `<!doctype html><html lang="it"><head><meta charset="utf-8" /><title>Report SkyFind — target unici</title><style>${css}</style></head>
      <body><h1>🛰️ Report target unici — SkyFind</h1>
      <div class="summary">Profilo colore: <strong>${SF.escapeHtml(profileName)}</strong> — ${clusters.length} target unici deduplicati per
      prossimità GPS (soglia confidenza ≥ ${minConfidence.toFixed(0)}%).</div>
      ${body}${withoutGeoHtml}</body></html>`;
  }

  function buildCsvReportByTarget(clusters, withoutGeo) {
    const rows = [[
      'target_id', 'target_lat', 'target_lon', 'n_rilevamenti', 'n_foto', 'foto',
      'confidenza_max_%', 'confidenza_min_%', 'avvisi_forma',
    ]];
    clusters.forEach((cl, i) => {
      const items = cl.items;
      const photoNames = [...new Set(items.map((it) => it.result.name))];
      const confs = items.map((it) => it.det.confidence);
      const warnings = [...new Set(items.map((it) => it.det.geom_warning).filter(Boolean))];
      rows.push([
        i + 1, cl.lat, cl.lon, items.length, photoNames.length, photoNames.join('; '),
        Math.max(...confs), Math.min(...confs), warnings.join('; '),
      ]);
    });
    if (withoutGeo.length) {
      rows.push([]);
      rows.push(['# rilevamenti sopra soglia senza posizione GPS (non deduplicabili per prossimità):']);
      withoutGeo.forEach((it) => rows.push(['', '', '', '', '', it.result.name, it.det.confidence, it.det.confidence, it.det.geom_warning || '']));
    }
    return rows.map((row) => row.map((v) => (v === null || v === undefined ? '' : csvEscape(String(v)))).join(',')).join('\r\n');
  }

  function buildCsvReport(results, minConfidence) {
    const rows = [[
      'foto', 'gps_lat_drone', 'gps_lon_drone', 'gps_altitude_m', 'data_ora',
      'target_lat', 'target_lon', 'target_geo_note',
      'bbox_x', 'bbox_y', 'bbox_w', 'bbox_h', 'confidenza_%', 'copertura_area_%', 'avviso_forma',
    ]];
    results.forEach((r) => {
      (r.detections || []).forEach((d) => {
        if (d.confidence < minConfidence) return;
        const hasTargetGeo = d.target_lat !== null && d.target_lat !== undefined;
        rows.push([
          r.name, r.gps_lat, r.gps_lon, r.gps_altitude, r.datetime_original,
          hasTargetGeo ? d.target_lat : '', hasTargetGeo ? d.target_lon : '',
          hasTargetGeo ? (d.geo_warning || '') : (d.geo_note || ''),
          d.bbox[0], d.bbox[1], d.bbox[2], d.bbox[3], d.confidence, d.fill_ratio,
          d.geom_warning || '',
        ]);
      });
    });
    return rows.map((row) => row.map((v) => (v === null || v === undefined ? '' : csvEscape(String(v)))).join(',')).join('\r\n');
  }
  function csvEscape(s) {
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ------------------------------------------------------------- render principale
  function render() {
    const container = document.getElementById('report-content');
    const results = SF.state.batchResults;
    if (!results || !results.length) {
      container.innerHTML = '<div class="sf-info">Nessun risultato disponibile. Esegui prima il modulo <strong>📷 Elaborazione Batch</strong>.</div>';
      return;
    }
    results.forEach((r, i) => (r._idx = i));
    const profileName = SF.state.batchProfileName || 'n/d';
    const totalDetections = results.reduce((s, r) => s + (r.detections ? r.detections.length : 0), 0);

    container.innerHTML = `
      <p class="sf-caption">Profilo colore usato: <strong>${SF.escapeHtml(profileName)}</strong> — ${results.length} foto analizzate,
        ${totalDetections} target individuati.</p>
      <p class="sf-caption">Ogni rilevamento ha un <strong>punteggio</strong> (0-100%) che misura quanto il colore
        <em>medio di tutta l'area rilevata</em> assomiglia al colore campionato — più alto è, più il rilevamento parte
        in cima alla lista da controllare. <strong>Non è un verdetto "vero/falso positivo":</strong> un punteggio basso
        può comunque essere un target reale, coperto da un'ombra, con luce diversa o tessuto sporco/bagnato — la
        differenza la fa solo l'occhio di chi rivede la foto. Per questo qui sotto vedi <em>tutti</em> i rilevamenti,
        dal più al meno probabile: nessuno viene nascosto o escluso dall'export a meno che tu non lo decida
        esplicitamente nelle impostazioni avanzate.</p>
      <div id="report-metrics"></div>

      <details id="report-advanced-settings" style="margin: 0.8rem 0;">
        <summary style="cursor:pointer; color:var(--muted);">⚙️ Impostazioni avanzate: filtro per punteggio</summary>
        <div style="padding: 0.8rem 0 0.2rem;">
          <label class="sf-label">Punteggio minimo da mostrare a schermo (%)</label>
          <input type="range" id="report-confidence-slider" min="0" max="100" step="1" value="${st.minConfidence}">
          <p class="sf-caption" id="report-confidence-value">${st.minConfidence}%</p>
          <p class="sf-caption">Restringe solo la lista mostrata qui sotto (schede, Sfoglia, lightbox) per concentrarti
            sui rilevamenti più probabili durante la revisione — riportalo a 0 in qualsiasi momento per rivedere tutto.
            <strong>Non cancella nulla</strong>: i rilevamenti sotto soglia restano nei dati e, per default, restano
            anche nell'export sotto.</p>
          <label class="sf-caption" style="display:flex; align-items:center; gap:0.5rem; cursor:pointer;">
            <input type="checkbox" id="report-filter-exports-checkbox" ${st.filterExports ? 'checked' : ''}>
            Applica questa soglia anche all'export CSV/HTML (esclude i rilevamenti sotto soglia dal file scaricato)
          </label>
          <p class="sf-caption" style="color:var(--accent-warm, #e0a030);">⚠️ Attiva questa casella solo se vuoi
            consapevolmente escludere dei rilevamenti dal report finale (es. per condividere solo i più probabili):
            un target reale con punteggio basso, se questa casella è attiva, non comparirà nel file esportato.</p>

          <hr style="border-color:var(--border); margin: 0.8rem 0;">
          <label class="sf-caption" style="display:flex; align-items:center; gap:0.5rem; cursor:pointer;">
            <input type="checkbox" id="report-review-mode-checkbox" ${st.reviewMode ? 'checked' : ''}>
            Abilita "🚫 falso positivo" su ogni rilevamento (modalità revisione)
          </label>
          <p class="sf-caption">Diverso dal filtro per punteggio sopra: qui stai dicendo esplicitamente "questo NON
            è il target" su UN rilevamento preciso che hai guardato da vicino — non un ordinamento, una tua scelta
            consapevole. Quando confermi (nella lightbox, aprendo il rilevamento): viene rimosso davvero da schede
            ed export, e il profilo colore viene ristretto in memoria per essere più selettivo su colori simili
            (mai salvato automaticamente). Puoi annullare l'ultima eliminazione dal pannello qui sotto.</p>
          <div id="report-review-panel"></div>
        </div>
      </details>
      <div style="margin: 0.8rem 0 0.4rem;">
        <button class="sf-btn primary" id="report-browse-btn">🖼️ Sfoglia foto in sequenza</button>
        <span class="sf-caption" style="margin-left:0.6rem;">Vista a schermo intero, foto per foto, con frecce ← →.</span>
      </div>
      <hr style="border-color:var(--border); margin: 1.4rem 0;">

      <div class="sf-radio-row" id="report-view-radio">
        <label><input type="radio" name="report-view" value="photo" ${st.viewMode === 'photo' ? 'checked' : ''}> 📷 Per foto</label>
        <label><input type="radio" name="report-view" value="target" ${st.viewMode === 'target' ? 'checked' : ''}> 🎯 Target unici (deduplica GPS)</label>
      </div>
      <div id="report-dedup-controls" style="display:${st.viewMode === 'target' ? 'block' : 'none'}; margin: 0.6rem 0;">
        <label class="sf-label">Raggio di deduplica (metri)</label>
        <input type="number" id="report-dedup-radius" min="1" step="1" value="${st.dedupRadiusM}" style="max-width:120px;">
        <p class="sf-caption">Rilevamenti georiferiti (punto 1) entro questa distanza l'uno dall'altro vengono considerati
          lo stesso target e raggruppati in un'unica scheda, con riferimento a tutte le foto in cui compare — invece di
          righe duplicate per ogni scatto in overlap. Richiede la posizione GPS del target (camera+quota in Elaborazione
          Batch): i rilevamenti senza restano visibili a parte, non vengono scartati.</p>
      </div>

      <div id="report-cards"></div>
      <hr style="border-color:var(--border); margin: 1.4rem 0;">
      <h2 class="sf-section">Esporta report</h2>
      <div style="display:flex; gap:0.8rem;">
        <button class="sf-btn" id="report-export-html">⬇️ Scarica report HTML</button>
        <button class="sf-btn" id="report-export-csv">⬇️ Scarica CSV rilevamenti</button>
      </div>
      <p class="sf-caption" id="report-export-note"></p>
    `;

    document.getElementById('report-confidence-slider').addEventListener('input', (e) => {
      st.minConfidence = parseInt(e.target.value, 10);
      document.getElementById('report-confidence-value').textContent = st.minConfidence + '%';
      renderFiltered();
    });
    container.querySelectorAll('input[name="report-view"]').forEach((r) => {
      r.addEventListener('change', (e) => {
        st.viewMode = e.target.value;
        document.getElementById('report-dedup-controls').style.display = st.viewMode === 'target' ? 'block' : 'none';
        renderFiltered();
      });
    });
    document.getElementById('report-dedup-radius').addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      st.dedupRadiusM = Number.isFinite(v) && v > 0 ? v : 7;
      if (st.viewMode === 'target') renderFiltered();
    });
    document.getElementById('report-filter-exports-checkbox').addEventListener('change', (e) => {
      st.filterExports = e.target.checked;
      renderFiltered(); // aggiorna la nota sotto i pulsanti di export
    });
    document.getElementById('report-review-mode-checkbox').addEventListener('change', (e) => {
      st.reviewMode = e.target.checked;
      renderReviewPanel();
    });
    document.getElementById('report-export-html').addEventListener('click', () => {
      const exportThreshold = getExportThreshold();
      if (st.viewMode === 'target') {
        const { withGeo, withoutGeo } = gatherGeoreferencedItems(exportThreshold);
        const clusters = clusterDetectionsByGps(withGeo, st.dedupRadiusM);
        downloadBlob(buildHtmlReportByTarget(clusters, withoutGeo, profileName, exportThreshold), 'skyfind_report_target.html', 'text/html');
      } else {
        const filtered = getFilteredWithThreshold(exportThreshold);
        downloadBlob(buildHtmlReport(filtered, profileName, exportThreshold), 'skyfind_report.html', 'text/html');
      }
    });
    document.getElementById('report-export-csv').addEventListener('click', () => {
      const exportThreshold = getExportThreshold();
      if (st.viewMode === 'target') {
        const { withGeo, withoutGeo } = gatherGeoreferencedItems(exportThreshold);
        const clusters = clusterDetectionsByGps(withGeo, st.dedupRadiusM);
        downloadBlob(buildCsvReportByTarget(clusters, withoutGeo), 'skyfind_target_unici.csv', 'text/csv');
      } else {
        downloadBlob(buildCsvReport(results, exportThreshold), 'skyfind_detections.csv', 'text/csv');
      }
    });
    document.getElementById('report-browse-btn').addEventListener('click', () => openBrowse(0));

    renderFiltered();
    renderReviewPanel();
  }

  /** Elenco foto+detection con punteggio >= soglia, ordinato per punteggio massimo decrescente
   *  (punto 4: si parte sempre dai match più probabili). Soglia esplicita, non implicita da `st`,
   *  così la vista a schermo e l'export possono usarne una diversa — vedi getFiltered()/export. */
  function getFilteredWithThreshold(threshold) {
    const results = SF.state.batchResults;
    return results
      .map((r) => [r, (r.detections || []).filter((d) => d.confidence >= threshold)])
      .filter(([, dets]) => dets.length)
      .sort((a, b) => Math.max(...b[1].map((d) => d.confidence)) - Math.max(...a[1].map((d) => d.confidence)));
  }

  /** Vista a schermo (schede, Sfoglia, lightbox): rispetta la soglia scelta nelle impostazioni
   *  avanzate — vedi getExportThreshold() per la soglia usata invece nell'export. */
  function getFiltered() {
    return getFilteredWithThreshold(st.minConfidence);
  }

  /** Soglia usata per l'EXPORT: per default sempre 0 (tutti i rilevamenti), indipendentemente da
   *  quanto è stato ristretto lo sguardo a schermo — a meno che l'utente non abbia esplicitamente
   *  spuntato "applica anche all'export" nelle impostazioni avanzate (punto 4: mai perdere target
   *  reali solo perché il punteggio è basso, senza una scelta consapevole di chi rivede le foto). */
  function getExportThreshold() {
    return st.filterExports ? st.minConfidence : 0;
  }

  function renderFiltered() {
    const note = document.getElementById('report-export-note');
    if (note) {
      const viewNote = st.viewMode === 'target' ? "Vista 'Target unici': un CSV/HTML per target, con l'elenco delle foto in cui compare. " : '';
      const exportNote = st.filterExports
        ? `⚠️ L'export esclude i rilevamenti sotto ${st.minConfidence}% (impostazione avanzata attiva).`
        : "L'export include SEMPRE tutti i rilevamenti, anche quelli nascosti qui sopra dal filtro a schermo.";
      note.textContent = viewNote + exportNote;
    }
    if (st.viewMode === 'target') renderTargetView();
    else renderPhotoView();
  }

  function renderPhotoView() {
    const filtered = getFiltered();
    document.getElementById('report-metrics').innerHTML = `
      <div class="sf-grid-2">
        <div class="sf-metric"><div class="sf-metric-label">Foto con rilevamenti (sopra soglia)</div><div class="sf-metric-value">${filtered.length}</div></div>
        <div class="sf-metric"><div class="sf-metric-label">Target mostrati</div><div class="sf-metric-value">${filtered.reduce((s, [, d]) => s + d.length, 0)}</div></div>
      </div>
    `;
    const cardsEl = document.getElementById('report-cards');
    cardsEl.innerHTML = '';
    if (!filtered.length) {
      cardsEl.innerHTML = '<div class="sf-warning">Nessun rilevamento sopra la soglia di confidenza scelta. Prova ad abbassare il cursore qui sopra.</div>';
      return;
    }
    const files = SF.state.batchFiles || [];
    filtered.forEach(([r, dets], i) => {
      cardsEl.appendChild(renderPhotoCard(r, files[r._idx], dets, i));
    });
  }

  // ------------------------------------------------------------- vista "Target unici" (punto 3)
  /** Indice della foto (per _idx) nella lista filtrata corrente, per aprire la modalità Sfoglia
   *  sulla foto giusta da una scheda target — -1 se quella foto non ha rilevamenti sopra soglia. */
  function photoIndexInFiltered(resultIdx) {
    return getFiltered().findIndex(([r]) => r._idx === resultIdx);
  }

  function buildClusterThumb(item) {
    const d = item.det;
    const thumb = document.createElement('div');
    thumb.className = 'sf-thumb';
    thumb.title = item.result.name;
    const flagBadge = d.geom_warning ? `<div class="sf-thumb-flag" title="${SF.escapeHtml(d.geom_warning)}">🔍</div>` : '';
    thumb.innerHTML = `<img src="${cropUrl(d)}"><div class="sf-thumb-conf">${SF.formatNum(d.confidence)}%</div>${flagBadge}`;
    thumb.addEventListener('click', () => openLightbox(d, item.result));
    return thumb;
  }

  function renderClusterBody(card, cluster) {
    const thumbsEl = card.querySelector('.sf-thumb-strip');
    if (thumbsEl.dataset.rendered) return;
    thumbsEl.dataset.rendered = '1';
    cluster.items
      .slice()
      .sort((a, b) => b.det.confidence - a.det.confidence)
      .forEach((item) => thumbsEl.appendChild(buildClusterThumb(item)));

    const photosEl = card.querySelector('.sf-cluster-photos');
    const seen = new Set();
    cluster.items.forEach((item) => {
      if (seen.has(item.result._idx)) return;
      seen.add(item.result._idx);
      const btn = document.createElement('button');
      btn.className = 'sf-link-btn';
      btn.style.cssText = 'background:none; border:none; font:inherit; padding:0; margin-right:0.6rem;';
      btn.textContent = item.result.name;
      btn.title = 'Apri in modalità Sfoglia';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const idx = photoIndexInFiltered(item.result._idx);
        if (idx >= 0) openBrowse(idx);
      });
      photosEl.appendChild(btn);
    });
  }

  function renderClusterCard(cluster, clusterIdx) {
    const card = document.createElement('div');
    card.className = 'sf-photo-card';
    const items = cluster.items;
    const confs = items.map((it) => it.det.confidence);
    const maxConf = Math.max(...confs), minConf = Math.min(...confs);
    const confRange = items.length > 1 ? `${SF.formatNum(minConf)}–${SF.formatNum(maxConf)}%` : `${SF.formatNum(maxConf)}%`;
    const nPhotos = new Set(items.map((it) => it.result._idx)).size;

    card.innerHTML = `
      <div class="sf-photo-card-head">
        <div>
          <div class="sf-photo-card-title">🎯 Target ${clusterIdx + 1} — ${items.length} rilevamento/i in ${nPhotos} foto</div>
          <div class="sf-photo-card-meta">
            <span>📍 <a href="${mapsLink(cluster.lat, cluster.lon)}" target="_blank" rel="noopener">${cluster.lat.toFixed(6)}, ${cluster.lon.toFixed(6)}</a> (centroide)</span>
            <span>Confidenza: ${confRange}</span>
          </div>
        </div>
        <span class="sf-photo-card-chevron">▶</span>
      </div>
      <div class="sf-photo-card-body">
        <div class="sf-thumb-strip"></div>
        <p class="sf-caption" style="margin-top:0.6rem;">Foto in cui compare (clic per aprire in Sfoglia): <span class="sf-cluster-photos"></span></p>
      </div>
    `;
    card.querySelector('.sf-photo-card-head').addEventListener('click', () => {
      const wasOpen = card.classList.contains('open');
      card.classList.toggle('open');
      if (!wasOpen) renderClusterBody(card, cluster);
    });
    return card;
  }

  function renderTargetView() {
    const { withGeo, withoutGeo } = gatherGeoreferencedItems(st.minConfidence);
    const clusters = clusterDetectionsByGps(withGeo, st.dedupRadiusM);
    clusters.sort((a, b) => Math.max(...b.items.map((it) => it.det.confidence)) - Math.max(...a.items.map((it) => it.det.confidence)));

    document.getElementById('report-metrics').innerHTML = `
      <div class="sf-grid-2">
        <div class="sf-metric"><div class="sf-metric-label">Target unici (georiferiti)</div><div class="sf-metric-value">${clusters.length}</div></div>
        <div class="sf-metric"><div class="sf-metric-label">Rilevamenti senza posizione GPS</div><div class="sf-metric-value">${withoutGeo.length}</div></div>
      </div>
    `;

    const cardsEl = document.getElementById('report-cards');
    cardsEl.innerHTML = '';
    if (!clusters.length && !withoutGeo.length) {
      cardsEl.innerHTML = '<div class="sf-warning">Nessun rilevamento sopra la soglia di confidenza scelta. Prova ad abbassare il cursore qui sopra.</div>';
      return;
    }
    if (!clusters.length) {
      cardsEl.innerHTML =
        '<div class="sf-info">Nessuno dei rilevamenti sopra soglia ha una posizione GPS del target calcolabile: la ' +
        'deduplica per prossimità richiede camera e quota configurate in Elaborazione Batch (punto 1). Vedi sotto per i ' +
        'rilevamenti senza posizione, oppure passa alla vista "Per foto".</div>';
    } else {
      clusters.forEach((cl, i) => cardsEl.appendChild(renderClusterCard(cl, i)));
    }
    if (withoutGeo.length) {
      const note = document.createElement('div');
      note.className = 'sf-info';
      note.style.marginTop = '1rem';
      note.textContent =
        `${withoutGeo.length} rilevamento/i sopra soglia senza posizione GPS del target: non deduplicabile/i per ` +
        `prossimità (manca camera/quota o dati EXIF). Restano visibili nella vista "Per foto".`;
      cardsEl.appendChild(note);
    }
  }

  function setupLightbox() {
    if (document.getElementById('sf-lightbox')) return;
    const box = document.createElement('div');
    box.id = 'sf-lightbox';
    box.className = 'sf-lightbox';
    box.innerHTML = `
      <button class="sf-lightbox-close" id="sf-lightbox-close">×</button>
      <img id="sf-lightbox-img">
      <div class="sf-lightbox-caption" id="sf-lightbox-caption"></div>
      <button class="sf-btn" id="sf-lightbox-fp-btn" style="display:none; margin-top:0.6rem;">🚫 Segna come falso positivo</button>
    `;
    document.body.appendChild(box);
    box.addEventListener('click', (e) => {
      if (e.target === box) box.classList.remove('open');
    });
    document.getElementById('sf-lightbox-close').addEventListener('click', () => box.classList.remove('open'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') box.classList.remove('open');
    });
    // Pulsante "falso positivo" (punto 6): mostrato solo in modalità revisione (impostazioni
    // avanzate del Report). Un solo listener qui, riusato per ogni apertura della lightbox tramite
    // la variabile di chiusura lightboxCurrent, aggiornata da openLightbox().
    document.getElementById('sf-lightbox-fp-btn').addEventListener('click', () => {
      if (!lightboxCurrent) return;
      if (
        !confirm(
          'Segnare questo rilevamento come falso positivo?\n\n' +
            'Verrà rimosso da schede ed export, e il profilo colore verrà ristretto in memoria per essere ' +
            'più selettivo su colori simili (non salvato automaticamente sul profilo).'
        )
      ) {
        return;
      }
      const { det, result } = lightboxCurrent;
      lightboxCurrent = null;
      box.classList.remove('open');
      markFalsePositive(det, result);
    });
  }

  // Esposta su SF (non solo uso interno) per essere testabile in isolamento, come le altre
  // funzioni pure condivise in questo namespace (SF.escapeHtml, SF.formatNum, ecc.).
  SF.clusterDetectionsByGps = clusterDetectionsByGps;

  SF.init_report = function () {
    setupLightbox();
    setupBrowseModal();
    render();
  };
})();
