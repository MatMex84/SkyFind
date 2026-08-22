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

// Tolleranza fissa e automatica (nessun cursore utente): valore "Ampia" —
// deliberatamente generoso perche' il colore scelto dall'utente puo' essere
// solo indicativo (foto, luce, ombre), non un campione di laboratorio.
const AUTO_TOLERANCE_HSV = [14, 75, 75]; // (H, S, V)
const AUTO_TOLERANCE_LAB = [20, 20, 20]; // (L, a, b)

/** Calcola mean HSV / mean LAB da una patch di pixel RGBA (Uint8ClampedArray, come da canvas ImageData). */
function computeProfileFromPatch(cv, rgbaData, width, height) {
  const rgba = new cv.Mat(height, width, cv.CV_8UC4);
  rgba.data.set(rgbaData);

  const rgb = new cv.Mat();
  cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);

  const hsv = new cv.Mat();
  cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
  const lab = new cv.Mat();
  cv.cvtColor(rgb, lab, cv.COLOR_RGB2Lab);

  const meanHsvScalar = cv.mean(hsv);
  const meanLabScalar = cv.mean(lab);

  rgba.delete(); rgb.delete(); hsv.delete(); lab.delete();

  return {
    mean_hsv: [meanHsvScalar[0], meanHsvScalar[1], meanHsvScalar[2]],
    mean_lab: [meanLabScalar[0], meanLabScalar[1], meanLabScalar[2]],
    tolerance_hsv: AUTO_TOLERANCE_HSV.slice(),
    tolerance_lab: AUTO_TOLERANCE_LAB.slice(),
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
