/**
 * Web Worker: rilevamento colore su una foto di missione (elaborazione batch).
 *
 * Porta 1:1 la pipeline di modules/image_processing.py:process_image() usando
 * OpenCV.js (WASM) dentro un worker, cosi' più foto vengono elaborate in
 * parallelo (un worker per core) senza bloccare l'interfaccia. Impostazioni
 * fisse e già ottimizzate (nessun controllo avanzato esposto in UI), identiche
 * ai default usati finora nell'app Python.
 */

importScripts('opencv.js');
importScripts('color_calib.js');
importScripts('exif_gps.js');
importScripts('geo_utils.js');

const CONFIG = {
  downscaleMaxDim: 1600,
  minAreaPxFullres: 400,
  morphKernel: 5,
  maxDetectionsPerImage: 8,
  cropPaddingPx: 20,
};

// buildMask() e colorConfidence() sono definite in color_calib.js (importato
// sopra) e condivise con l'anteprima live del modulo Calibrazione Colore, cosi'
// l'anteprima mostra esattamente cio' che questo worker rilevera' in batch.

/**
 * Filtro geometrico sui blob rilevati (punto 2 della roadmap): scarta i contorni la cui
 * forma non è plausibile per un indumento/persona vista dall'alto, PRIMA del costoso ritaglio
 * e ri-mascheramento a piena risoluzione più sotto.
 *
 * - Aspect ratio (lato lungo / lato corto del bounding box a scala ridotta: il rapporto è
 *   invariante rispetto al downscale uniforme, quindi si può controllare qui senza riportare
 *   le misure a piena risoluzione): scarta forme troppo allungate/irregolari (es. un bordo di
 *   tetto, un solco, un'ombra lineare) che difficilmente sono un indumento o una persona.
 * - Area reale in m² (serve il GSD di QUESTA foto, disponibile solo se camera+quota sono
 *   configurate in Elaborazione Batch): scarta blob troppo piccoli (rumore/riflessi isolati) o
 *   troppo grandi (terreno, tetto, vegetazione dello stesso colore del profilo). Se il GSD non
 *   è disponibile per questa foto, il controllo sull'area viene semplicemente saltato — resta
 *   attivo solo l'aspect ratio, che non richiede alcun dato di quota/camera.
 *
 * Le soglie sono tutte configurabili da Elaborazione Batch (config.geomFilter); un valore
 * assente/non numerico o <= 0 disattiva quel singolo controllo (non l'intero filtro).
 *
 * @returns {{ok: boolean, reason: (string|null)}} reason è una delle chiavi usate per il
 *   riepilogo degli scarti in result.geom_filter_rejected.
 */
function passesGeometricFilter(rect, scale, gsdMPerPx, geomFilter) {
  const w = rect.width, h = rect.height;
  const longSidePx = Math.max(w, h), shortSidePx = Math.max(1, Math.min(w, h));
  const aspectRatio = longSidePx / shortSidePx;
  const maxAspect = geomFilter && geomFilter.maxAspectRatio;
  if (typeof maxAspect === 'number' && maxAspect > 0 && aspectRatio > maxAspect) {
    return { ok: false, reason: 'aspect_ratio' };
  }
  if (gsdMPerPx && geomFilter) {
    const areaFullResPx = (w * h) / (scale * scale);
    const areaM2 = areaFullResPx * gsdMPerPx * gsdMPerPx;
    const minArea = geomFilter.minAreaM2, maxArea = geomFilter.maxAreaM2;
    if (typeof minArea === 'number' && minArea > 0 && areaM2 < minArea) {
      return { ok: false, reason: 'area_troppo_piccola' };
    }
    if (typeof maxArea === 'number' && maxArea > 0 && areaM2 > maxArea) {
      return { ok: false, reason: 'area_troppo_grande' };
    }
  }
  return { ok: true, reason: null };
}

function matFromImageBitmap(cv, bitmap, targetW, targetH) {
  const canvas = new OffscreenCanvas(targetW, targetH);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, targetW, targetH);
  const imageData = ctx.getImageData(0, 0, targetW, targetH);
  const rgba = cv.matFromImageData(imageData);
  const rgb = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  rgba.delete();
  return rgb;
}

async function encodeCropJpeg(bitmap, x0, y0, w, h) {
  const canvas = new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
  canvas.getContext('2d').drawImage(bitmap, x0, y0, w, h, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  const buf = await blob.arrayBuffer();
  return buf; // trasferibile al thread principale senza copia (Transferable)
}

async function processImage(cv, file, profile, config) {
  const result = {
    name: file.name, width: 0, height: 0,
    gps_lat: null, gps_lon: null, gps_altitude: null, datetime_original: null,
    rel_altitude_m: null, heading_deg: null, heading_source: null, gimbal_pitch_deg: null,
    agl_m: null, agl_source: null, gsd_m_per_px: null,
    detections: [], skipped_reason: null, error: null,
    geom_filter_rejected: { aspect_ratio: 0, area_troppo_piccola: 0, area_troppo_grande: 0 },
  };

  const gps = await readExifGps(file);
  Object.assign(result, gps);

  if (config.requireGps && result.gps_lat === null) {
    result.skipped_reason = 'Nessun dato GPS nei metadati EXIF';
    return result;
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch (e) {
    result.error = 'Impossibile leggere il file immagine';
    return result;
  }

  const wFull = bitmap.width, hFull = bitmap.height;
  result.width = wFull; result.height = hFull;

  // --- georeferenziazione per-pixel del target: quota AGL, sorgente e GSD di QUESTA foto ---
  // (uguale per tutte le detection della stessa foto: viene ricalcolato una volta sola qui,
  // il costo per-detection è solo la trigonometria in pixelOffsetToLatLon più sotto).
  let aglM = null, aglSource = null;
  if (typeof gps.rel_altitude_m === 'number') {
    aglM = gps.rel_altitude_m;
    aglSource = 'xmp_relative_altitude'; // quota AGL reale sul punto di decollo, dai metadati DJI
  } else if (typeof config.fallbackAltitudeM === 'number' && config.fallbackAltitudeM > 0) {
    aglM = config.fallbackAltitudeM;
    aglSource = 'fallback_manual'; // valore unico impostato dall'utente in Elaborazione Batch, stessa quota per tutte le foto che ne mancano
  }
  const sensor = config.sensor || null;
  // focalPx alimenta la proiezione raggio-terreno (gestisce anche gli scatti obliqui, vedi
  // geo_utils.js); gsdMPerPx resta come indicatore di risoluzione "equivalente nadir" al centro
  // immagine, usato più avanti anche dal filtro geometrico sull'area dei blob.
  const focalPx = sensor ? computeFocalLengthPx(sensor.sensor_width_mm, sensor.focal_length_mm, wFull) : null;
  const gsdMPerPx = sensor ? computeGsdMPerPx(aglM, sensor.sensor_width_mm, sensor.focal_length_mm, wFull) : null;
  const canGeoreferenceTarget = result.gps_lat !== null && focalPx !== null && aglM !== null;
  const geoNote = !sensor
    ? 'nessuna camera selezionata in Elaborazione Batch: impossibile calcolare la posizione del target'
    : result.gps_lat === null
      ? 'foto senza dati GPS nei metadati EXIF'
      : aglM === null
        ? 'quota AGL non disponibile (né XMP DJI né quota di fallback impostata in Elaborazione Batch)'
        : null;
  const geoWarning = obliqueShotWarning(gps.gimbal_pitch_deg);
  result.agl_m = aglM;
  result.agl_source = aglSource;
  result.gsd_m_per_px = gsdMPerPx;

  const scale = Math.min(1, config.downscaleMaxDim / Math.max(wFull, hFull));
  const sw = Math.max(1, Math.round(wFull * scale)), sh = Math.max(1, Math.round(hFull * scale));

  const small = matFromImageBitmap(cv, bitmap, sw, sh);
  const mask = buildMask(cv, small, profile, config.colorSpace, config.morphKernel);

  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const minAreaSmall = config.minAreaPxFullres * scale * scale;
  const candidates = [];
  for (let i = 0; i < contours.size(); i++) {
    const c = contours.get(i);
    const area = cv.contourArea(c);
    if (area >= minAreaSmall) {
      const rect = cv.boundingRect(c);
      const check = passesGeometricFilter(rect, scale, gsdMPerPx, config.geomFilter);
      if (check.ok) {
        candidates.push({ area, rect });
      } else if (result.geom_filter_rejected[check.reason] !== undefined) {
        result.geom_filter_rejected[check.reason]++;
      }
    }
    c.delete();
  }
  candidates.sort((a, b) => b.area - a.area);
  const top = candidates.slice(0, config.maxDetectionsPerImage);

  small.delete(); mask.delete(); contours.delete(); hierarchy.delete();

  // Per ogni candidato disegniamo SOLO la regione di interesse (con margine) del
  // bitmap gia' decodificato su un piccolo canvas: evitiamo di materializzare mai
  // un cv.Mat a piena risoluzione dell'intera foto (risparmio di memoria notevole
  // su foto 4K, l'equivalente JS del semplice "slice" numpy usato in Python).
  const pad = config.cropPaddingPx;
  for (const cand of top) {
    const fx = Math.round(cand.rect.x / scale), fy = Math.round(cand.rect.y / scale);
    const fw = Math.min(Math.round(cand.rect.width / scale), wFull - fx);
    const fh = Math.min(Math.round(cand.rect.height / scale), hFull - fy);
    const cx0 = Math.max(0, fx - pad), cy0 = Math.max(0, fy - pad);
    const cx1 = Math.min(wFull, fx + fw + pad), cy1 = Math.min(hFull, fy + fh + pad);
    const cw = cx1 - cx0, ch = cy1 - cy0;
    if (cw <= 0 || ch <= 0) continue;

    const cropCanvas = new OffscreenCanvas(cw, ch);
    cropCanvas.getContext('2d').drawImage(bitmap, cx0, cy0, cw, ch, 0, 0, cw, ch);
    const cropImageData = cropCanvas.getContext('2d').getImageData(0, 0, cw, ch);
    const cropRgba = cv.matFromImageData(cropImageData);
    const cropRgb = new cv.Mat();
    cv.cvtColor(cropRgba, cropRgb, cv.COLOR_RGBA2RGB);
    cropRgba.delete();

    const cropMask = buildMask(cv, cropRgb, profile, config.colorSpace, config.morphKernel);
    const cropLab = new cv.Mat();
    cv.cvtColor(cropRgb, cropLab, cv.COLOR_RGB2Lab);

    const confidence = colorConfidence(cv, cropLab, cropMask, profile);
    let filled = 0;
    const md = cropMask.data;
    for (let i = 0; i < md.length; i++) if (md[i] > 0) filled++;
    const fillRatio = (100 * filled) / md.length;

    const jpegBuf = await encodeCropJpeg(bitmap, fx, fy, fw, fh);

    // Posizione GPS del target (non del centro foto): proietta il raggio ottico del centroide
    // del bounding box fino al terreno, tenendo conto di yaw E pitch della camera (gestisce
    // quindi anche scatti obliqui, non solo nadir — vedi geo_utils.js per il modello e le
    // assunzioni residue, es. terreno piano e roll=0).
    let targetLat = null, targetLon = null, geoUnreachable = false;
    if (canGeoreferenceTarget) {
      const cx = fx + fw / 2, cy = fy + fh / 2;
      const dxPx = cx - wFull / 2, dyPx = cy - hFull / 2;
      const targetGeo = pixelOffsetToLatLon(
        result.gps_lat, result.gps_lon, dxPx, dyPx, focalPx, aglM, result.heading_deg, result.gimbal_pitch_deg
      );
      if (targetGeo) {
        targetLat = targetGeo.lat;
        targetLon = targetGeo.lon;
      } else {
        geoUnreachable = true; // raggio oltre l'orizzonte apparente: scatto molto obliquo + target vicino al bordo
      }
    }
    const finalGeoNote = !canGeoreferenceTarget
      ? geoNote
      : geoUnreachable
        ? "il target si proietta oltre l'orizzonte apparente per questo scatto molto obliquo: posizione non calcolabile in modo affidabile"
        : null;

    result.detections.push({
      bbox: [fx, fy, fw, fh],
      confidence: Math.round(confidence * 10) / 10,
      fill_ratio: Math.round(fillRatio * 10) / 10,
      crop_jpeg: jpegBuf,
      target_lat: targetLat,
      target_lon: targetLon,
      geo_note: finalGeoNote,
      geo_warning: geoWarning,
      heading_source: result.heading_source,
    });

    cropRgb.delete(); cropMask.delete(); cropLab.delete();
  }

  bitmap.close();
  return result;
}

let cvReady = null;
async function ensureCv() {
  if (!cvReady) {
    if (self.cv && typeof self.cv.then === 'function') self.cv = await self.cv;
    cvReady = self.cv;
  }
  return cvReady;
}

self.onmessage = async function (e) {
  const { type, files, profile, config, jobId } = e.data;
  if (type !== 'process') return;
  const cv = await ensureCv();

  for (let i = 0; i < files.length; i++) {
    try {
      const result = await processImage(cv, files[i], profile, config);
      const transferables = result.detections.map((d) => d.crop_jpeg);
      self.postMessage({ jobId, index: i, result }, transferables);
    } catch (err) {
      self.postMessage({
        jobId, index: i,
        result: {
          name: files[i].name, width: 0, height: 0,
          gps_lat: null, gps_lon: null, gps_altitude: null, datetime_original: null,
          detections: [], error: String(err && err.message || err),
          geom_filter_rejected: null,
        },
      });
    }
  }
  self.postMessage({ jobId, done: true });
};
