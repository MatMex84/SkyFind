/**
 * Modulo 4 - Report: anteprima foto intera con il target cerchiato (stile SkyReport),
 * miniature in basso e lightbox per l'ingrandimento. Porta di pages/4_📋_Report.py +
 * modules/report.py (export HTML/CSV).
 */
window.SF = window.SF || {};

(function () {
  'use strict';

  const st = { built: false, minConfidence: 0, cropUrls: new Map(), browseIdx: 0 };
  const fileUrlCache = new WeakMap();
  let browseItems = []; // [{result, dets, file}], costruito all'apertura della modalita' Sfoglia

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

  function openLightbox(det, photoName) {
    const box = document.getElementById('sf-lightbox');
    document.getElementById('sf-lightbox-img').src = cropUrl(det);
    document.getElementById('sf-lightbox-caption').innerHTML =
      `${SF.escapeHtml(photoName)} — Confidenza: <strong>${SF.formatNum(det.confidence)}%</strong> · ` +
      `Area: ${SF.formatNum(det.fill_ratio)}% · bbox: x=${det.bbox[0]} y=${det.bbox[1]} w=${det.bbox[2]} h=${det.bbox[3]}<br>` +
      targetGeoLine(det);
    box.classList.add('open');
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
        if (dets.length) openLightbox(dets[Math.max(0, selectedIdx)], result.name);
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
        thumb.innerHTML = `<img src="${cropUrl(d)}"><div class="sf-thumb-conf">${SF.formatNum(d.confidence)}%</div>`;
        thumb.addEventListener('click', () => {
          selectedIdx = idxInOriginal;
          thumbsEl.querySelectorAll('.sf-thumb').forEach((t) => t.classList.remove('selected'));
          thumb.classList.add('selected');
          const img = previewEl.querySelector('img');
          const canvas = previewEl.querySelector('canvas');
          if (img && canvas && img.naturalWidth) drawCircles(canvas, img, dets, selectedIdx);
          openLightbox(d, result.name);
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
            return `<div class="det-card"><img src="data:image/jpeg;base64,${b64}" alt="target rilevato" />
              <div class="det-meta"><div><strong>Confidenza:</strong> ${SF.formatNum(d.confidence)}%</div>
              <div><strong>Copertura area:</strong> ${SF.formatNum(d.fill_ratio)}%</div>
              <div><strong>Bounding box:</strong> x=${x} y=${y} w=${w} h=${h}</div>${targetGpsHtml}</div></div>`;
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

  function buildCsvReport(results, minConfidence) {
    const rows = [[
      'foto', 'gps_lat_drone', 'gps_lon_drone', 'gps_altitude_m', 'data_ora',
      'target_lat', 'target_lon', 'target_geo_note',
      'bbox_x', 'bbox_y', 'bbox_w', 'bbox_h', 'confidenza_%', 'copertura_area_%',
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
      <label class="sf-label">Confidenza minima da mostrare (%)</label>
      <input type="range" id="report-confidence-slider" min="0" max="100" step="1" value="${st.minConfidence}">
      <p class="sf-caption" id="report-confidence-value">${st.minConfidence}%</p>
      <p class="sf-caption">La confidenza misura quanto il colore <em>medio di tutta l'area rilevata</em> è vicino al
        colore campionato — non solo del punto esatto in cui hai fatto il contagocce. Su un indumento vero (pieghe,
        ombre, texture del tessuto) è normale che sia ben sotto il 100% anche quando il rilevamento è corretto:
        non alzare troppo la soglia sopra, o rischi di nascondere target reali.</p>
      <div id="report-metrics"></div>
      <div style="margin: 0.8rem 0 0.4rem;">
        <button class="sf-btn primary" id="report-browse-btn">🖼️ Sfoglia foto in sequenza</button>
        <span class="sf-caption" style="margin-left:0.6rem;">Vista a schermo intero, foto per foto, con frecce ← →.</span>
      </div>
      <hr style="border-color:var(--border); margin: 1.4rem 0;">
      <div id="report-cards"></div>
      <hr style="border-color:var(--border); margin: 1.4rem 0;">
      <h2 class="sf-section">Esporta report</h2>
      <div style="display:flex; gap:0.8rem;">
        <button class="sf-btn" id="report-export-html">⬇️ Scarica report HTML</button>
        <button class="sf-btn" id="report-export-csv">⬇️ Scarica CSV rilevamenti</button>
      </div>
    `;

    document.getElementById('report-confidence-slider').addEventListener('input', (e) => {
      st.minConfidence = parseInt(e.target.value, 10);
      document.getElementById('report-confidence-value').textContent = st.minConfidence + '%';
      renderFiltered();
    });
    document.getElementById('report-export-html').addEventListener('click', () => {
      const filtered = getFiltered();
      downloadBlob(buildHtmlReport(filtered, profileName, st.minConfidence), 'skyfind_report.html', 'text/html');
    });
    document.getElementById('report-export-csv').addEventListener('click', () => {
      downloadBlob(buildCsvReport(results, st.minConfidence), 'skyfind_detections.csv', 'text/csv');
    });
    document.getElementById('report-browse-btn').addEventListener('click', () => openBrowse(0));

    renderFiltered();
  }

  function getFiltered() {
    const results = SF.state.batchResults;
    return results
      .map((r) => [r, (r.detections || []).filter((d) => d.confidence >= st.minConfidence)])
      .filter(([, dets]) => dets.length)
      .sort((a, b) => Math.max(...b[1].map((d) => d.confidence)) - Math.max(...a[1].map((d) => d.confidence)));
  }

  function renderFiltered() {
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

  function setupLightbox() {
    if (document.getElementById('sf-lightbox')) return;
    const box = document.createElement('div');
    box.id = 'sf-lightbox';
    box.className = 'sf-lightbox';
    box.innerHTML = `
      <button class="sf-lightbox-close" id="sf-lightbox-close">×</button>
      <img id="sf-lightbox-img">
      <div class="sf-lightbox-caption" id="sf-lightbox-caption"></div>
    `;
    document.body.appendChild(box);
    box.addEventListener('click', (e) => {
      if (e.target === box) box.classList.remove('open');
    });
    document.getElementById('sf-lightbox-close').addEventListener('click', () => box.classList.remove('open'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') box.classList.remove('open');
    });
  }

  SF.init_report = function () {
    setupLightbox();
    setupBrowseModal();
    render();
  };
})();
