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

function buildMask(cv, mat, profile, colorSpace, kernelSize) {
  let maskHsv = null, maskLab = null;
  if (colorSpace === 'hsv' || colorSpace === 'both') {
    const hsv = new cv.Mat();
    cv.cvtColor(mat, hsv, cv.COLOR_RGB2HSV);
    const hb = hsvBounds(profile);
    const lower = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [hb.lower[0], hb.lower[1], hb.lower[2], 0]);
    const upper = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [hb.upper[0], hb.upper[1], hb.upper[2], 255]);
    maskHsv = new cv.Mat();
    cv.inRange(hsv, lower, upper, maskHsv);
    hsv.delete(); lower.delete(); upper.delete();
  }
  if (colorSpace === 'lab' || colorSpace === 'both') {
    const lab = new cv.Mat();
    cv.cvtColor(mat, lab, cv.COLOR_RGB2Lab);
    const lb = labBounds(profile);
    const lower = new cv.Mat(lab.rows, lab.cols, lab.type(), [lb.lower[0], lb.lower[1], lb.lower[2], 0]);
    const upper = new cv.Mat(lab.rows, lab.cols, lab.type(), [lb.upper[0], lb.upper[1], lb.upper[2], 255]);
    maskLab = new cv.Mat();
    cv.inRange(lab, lower, upper, maskLab);
    lab.delete(); lower.delete(); upper.delete();
  }

  let mask;
  if (colorSpace === 'hsv') { mask = maskHsv; }
  else if (colorSpace === 'lab') { mask = maskLab; }
  else {
    mask = new cv.Mat();
    cv.bitwise_and(maskHsv, maskLab, mask);
    maskHsv.delete(); maskLab.delete();
  }

  const kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kernelSize, kernelSize));
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
  kernel.delete();
  return mask;
}

/** Percentuale di match cromatico: 100% = colore medio del profilo, 0% = al limite della tolleranza. */
function colorConfidence(cv, regionLabMat, maskMat, profile) {
  const rows = regionLabMat.rows, cols = regionLabMat.cols;
  const labData = regionLabMat.data; // Uint8, 3 canali (RGB2Lab -> CV_8UC3)
  const maskData = maskMat.data;
  const [ml, ma, mb] = profile.mean_lab;
  let sumDelta = 0, n = 0;
  for (let i = 0; i < rows * cols; i++) {
    if (maskData[i] > 0) {
      const l = labData[i * 3], a = labData[i * 3 + 1], b = labData[i * 3 + 2];
      const dl = l - ml, da = a - ma, db = b - mb;
      sumDelta += Math.sqrt(dl * dl + da * da + db * db);
      n++;
    }
  }
  if (n === 0) return 0;
  const meanDelta = sumDelta / n;
  const [tl, ta, tb] = profile.tolerance_lab;
  const maxTol = Math.sqrt(tl * tl + ta * ta + tb * tb) || 1;
  const confidence = 100 * (1 - meanDelta / maxTol);
  return Math.max(0, Math.min(100, confidence));
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
