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
    detections: [], skipped_reason: null, error: null,
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
    if (area >= minAreaSmall) candidates.push({ area, rect: cv.boundingRect(c) });
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

    result.detections.push({
      bbox: [fx, fy, fw, fh],
      confidence: Math.round(confidence * 10) / 10,
      fill_ratio: Math.round(fillRatio * 10) / 10,
      crop_jpeg: jpegBuf,
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
        result: { name: files[i].name, width: 0, height: 0, detections: [], error: String(err && err.message || err) },
      });
    }
  }
  self.postMessage({ jobId, done: true });
};
