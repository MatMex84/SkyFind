/**
 * Calibrazione colore: porta di modules/color_calibration.py.
 *
 * Usa sempre OpenCV.js (parametro `cv`) per le conversioni colore, cosi' da
 * restare byte-per-byte coerente con la stessa libreria usata per costruire
 * le maschere nel worker di rilevamento (stessa convenzione LAB 8-bit di
 * OpenCV: L in 0-255, a/b in 0-255 con offset +128 — diversa dal CIELAB
 * "standard" L 0-100/a,b -128..127, quindi non va mai calcolata a mano).
 *
 * File caricabile sia da <script> (thread principale) sia da importScripts()
 * (Web Worker): nessuna dipendenza dal DOM, solo funzioni pure su numeri/cv.Mat.
 */

// Tolleranza di base, automatica (nessun cursore utente): valore "Ampia" —
// deliberatamente generoso perche' il colore scelto dall'utente puo' essere
// solo indicativo (foto, luce, ombre), non un campione di laboratorio. E'
// anche il PAVIMENTO della tolleranza adattiva qui sotto: con un solo punto
// campionato il risultato e' identico a prima (nessuna regressione).
const AUTO_TOLERANCE_HSV = [14, 75, 75]; // (H, S, V)
const AUTO_TOLERANCE_LAB = [20, 20, 20]; // (L, a, b)

// Tolleranza adattiva multi-punto: quando l'utente campiona piu' punti sullo
// stesso indumento (pieghe, ombra, luce diretta), usiamo la variazione di
// colore osservata *tra* quei punti per allargare la tolleranza in modo
// mirato, invece di indovinare un valore fisso unico per tutti i target.
// ADAPTIVE_K = quante "deviazioni standard" di variazione osservata includere.
// TOLERANCE_CEIL_MULT = tetto massimo (multiplo della tolleranza base), per
// non allargare troppo e generare falsi positivi anche con punti molto sparsi.
const ADAPTIVE_K = 2.2;
const TOLERANCE_CEIL_MULT = 2.2;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Calcola il profilo colore (media + tolleranza adattiva) da uno o piu' campioni.
 * Ogni sample e' una patch di pixel RGBA (come da canvas ImageData): con un
 * solo sample il comportamento e' equivalente alla vecchia funzione a patch
 * singola (tolleranza = valore fisso di base). Con piu' sample, la media e'
 * calcolata su tutti i pixel insieme e la tolleranza si allarga in base alla
 * deviazione standard osservata tra i campioni, entro i limiti sopra.
 */
function computeProfileFromSamples(cv, samples) {
  let totalPixels = 0;
  samples.forEach((s) => { totalPixels += s.width * s.height; });
  const combined = new Uint8ClampedArray(totalPixels * 4);
  let offsetPx = 0;
  samples.forEach((s) => {
    combined.set(s.data, offsetPx * 4);
    offsetPx += s.width * s.height;
  });

  const rgba = new cv.Mat(1, totalPixels, cv.CV_8UC4);
  rgba.data.set(combined);
  const rgb = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
  const hsv = new cv.Mat();
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const lab = new cv.Mat();
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);

  const hsvMean = new cv.Mat(), hsvStd = new cv.Mat();
  cv.meanStdDev(hsv, hsvMean, hsvStd);
  const labMean = new cv.Mat(), labStd = new cv.Mat();
  cv.meanStdDev(lab, labMean, labStd);

  const meanHsv = [hsvMean.data64F[0], hsvMean.data64F[1], hsvMean.data64F[2]];
  const stdHsv = [hsvStd.data64F[0], hsvStd.data64F[1], hsvStd.data64F[2]];
  const meanLab = [labMean.data64F[0], labMean.data64F[1], labMean.data64F[2]];
  const stdLab = [labStd.data64F[0], labStd.data64F[1], labStd.data64F[2]];

  rgba.delete(); rgb.delete(); hsv.delete(); lab.delete();
  hsvMean.delete(); hsvStd.delete(); labMean.delete(); labStd.delete();

  const toleranceHsv = AUTO_TOLERANCE_HSV.map((base, i) => clamp(ADAPTIVE_K * stdHsv[i], base, base * TOLERANCE_CEIL_MULT));
  const toleranceLab = AUTO_TOLERANCE_LAB.map((base, i) => clamp(ADAPTIVE_K * stdLab[i], base, base * TOLERANCE_CEIL_MULT));

  return {
    mean_hsv: meanHsv,
    mean_lab: meanLab,
    tolerance_hsv: toleranceHsv,
    tolerance_lab: toleranceLab,
    n_samples: samples.length,
    n_pixels: totalPixels,
  };
}

function hsvBounds(profile) {
  const [h, s, v] = profile.mean_hsv;
  const [th, ts, tv] = profile.tolerance_hsv;
  return {
    lower: [Math.max(h - th, 0), Math.max(s - ts, 0), Math.max(v - tv, 0)],
    upper: [Math.min(h + th, 179), Math.min(s + ts, 255), Math.min(v + tv, 255)],
  };
}

function labBounds(profile) {
  const [l, a, b] = profile.mean_lab;
  const [tl, ta, tb] = profile.tolerance_lab;
  return {
    lower: [Math.max(l - tl, 0), Math.max(a - ta, 0), Math.max(b - tb, 0)],
    upper: [Math.min(l + tl, 255), Math.min(a + ta, 255), Math.min(b + tb, 255)],
  };
}

/** Converte un punto CIE-LAB (convenzione OpenCV 8-bit) in stringa esadecimale, per anteprime UI. */
function labToHex(cv, l, a, b) {
  const lab = new cv.Mat(1, 1, cv.CV_8UC3);
  lab.data.set([
    Math.max(0, Math.min(255, Math.round(l))),
    Math.max(0, Math.min(255, Math.round(a))),
    Math.max(0, Math.min(255, Math.round(b))),
  ]);
  const rgb = new cv.Mat();
  cv.cvtColor(lab, rgb, cv.COLOR_Lab2RGB);
  const d = rgb.data;
  const hex = '#' + [d[0], d[1], d[2]].map((c) => c.toString(16).padStart(2, '0')).join('');
  lab.delete(); rgb.delete();
  return hex;
}

function profileHexColor(cv, profile) {
  return labToHex(cv, profile.mean_lab[0], profile.mean_lab[1], profile.mean_lab[2]);
}

/**
 * Costruisce la maschera binaria dei pixel che rientrano nel profilo colore.
 * Condivisa tra il worker di elaborazione batch (detect_worker.js, via
 * importScripts) e l'anteprima live in Calibrazione Colore (thread principale),
 * cosi' l'anteprima mostra esattamente cio' che il batch rileverebbe.
 */
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
