/**
 * scene_colors.js — suggerimento dei "colori che spiccano nella scena" (ricerca a colore sconosciuto).
 *
 * Quando non si sa di che colore è l'indumento, questo modulo analizza un campione delle foto del
 * lotto e propone i colori VIVACI e RARI rispetto allo sfondo (terreno, vegetazione), ognuno con un
 * esempio ritagliato dalla foto in cui compare di più: un clic lo trasforma in profilo colore.
 *
 * Funzionamento (tutto client-side, thread principale, nessun upload):
 *  1. campiona fino a MAX_PHOTOS foto distribuite uniformemente nel lotto;
 *  2. ogni foto viene ridotta a THUMB_W px di larghezza (decodifica già ridimensionata) e normalizzata
 *     con lo stesso gray-world usato dal rilevamento (così i colori suggeriti stanno nello stesso
 *     spazio colore "canonicalizzato" dei profili e dei match in detect_worker.js);
 *  3. ogni pixel vivace (saturazione e luminosità sopra soglia) finisce in un bin tonalità×saturazione;
 *  4. un colore è candidato se è raro nel complesso del campione (< MAX_TOTAL_FRACTION dei pixel),
 *     abbastanza presente in almeno una foto da non essere rumore, e non onnipresente nel lotto;
 *  5. i candidati sono ordinati per rarità, le tonalità vicine accorpate, e per ciascuno si ritaglia
 *     l'esempio dalla zona della foto dove quel colore è più concentrato.
 *
 * LIMITI NOTI (mostrati anche nell'interfaccia): solo colori vivaci — bianco, grigio, nero e tinte
 * spente non vengono mai suggeriti; si analizza un campione, non ogni foto, quindi un target visibile
 * solo in poche foto non campionate può non comparire; la rarità non distingue un indumento da, per
 * esempio, un fiore o un veicolo dello stesso colore: è un suggerimento da verificare a occhio.
 *
 * Dipende da color_calib.js (computeGrayWorldGains / applyGrayWorldGains), caricato prima.
 */
window.SF = window.SF || {};

(function () {
  'use strict';

  const MAX_PHOTOS = 40;
  const THUMB_W = 320;
  const HUE_BINS = 24; // 15° ciascuno
  const SAT_BINS = 2; // 0.55-0.80 e 0.80-1.00
  const MIN_SAT = 0.55;
  const MIN_VAL = 0.4;
  const SAT_SPLIT = 0.8;
  const MIN_PIXELS_IN_THUMB = 8; // sotto questa soglia in ogni foto è rumore, non un oggetto
  const MAX_TOTAL_FRACTION = 0.01; // un colore che copre >1% del campione è sfondo, non target
  const MAX_PRESENCE_RATIO = 0.6; // presente in oltre il 60% delle foto = onnipresente (con N > 3)
  const MAX_CANDIDATES = 6;
  const CELL = 16; // lato (px miniatura) della cella per trovare dove il colore è più concentrato
  const CROP = 56; // lato (px miniatura) dell'esempio ritagliato

  function hueName(h) {
    if (h < 15 || h >= 345) return 'Rosso';
    if (h < 45) return 'Arancione';
    if (h < 70) return 'Giallo';
    if (h < 95) return 'Giallo-verde';
    if (h < 165) return 'Verde';
    if (h < 195) return 'Ciano';
    if (h < 215) return 'Azzurro';
    if (h < 255) return 'Blu';
    if (h < 285) return 'Viola';
    return 'Magenta/rosa';
  }

  function rgbToHex(r, g, b) {
    const x = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + x(r) + x(g) + x(b);
  }

  /** Bin (0..HUE_BINS*SAT_BINS-1) di un pixel RGB, o -1 se non abbastanza vivace. */
  function binOf(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max === 0) return -1;
    const v = max / 255, s = (max - min) / max;
    if (s < MIN_SAT || v < MIN_VAL) return -1;
    const d = max - min;
    let h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
    const hb = Math.floor((h / 360) * HUE_BINS) % HUE_BINS;
    return hb * SAT_BINS + (s < SAT_SPLIT ? 0 : 1);
  }

  function pickSample(files) {
    const n = files.length;
    const m = Math.min(n, MAX_PHOTOS);
    if (m === n) return files.slice();
    const out = [];
    for (let i = 0; i < m; i++) out.push(files[Math.floor((i * (n - 1)) / (m - 1))]);
    return out;
  }

  async function loadThumb(file) {
    try {
      const bmp = await createImageBitmap(file, { resizeWidth: THUMB_W, resizeQuality: 'low' });
      const canvas = document.createElement('canvas');
      canvas.width = bmp.width;
      canvas.height = bmp.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      return { canvas, ctx };
    } catch (e) {
      return null; // formato non decodificabile dal browser (es. alcuni TIFF): foto saltata
    }
  }

  /**
   * @param files      File[] del lotto
   * @param onProgress opzionale (fatte, totali)
   * @returns Promise<{ candidates: [...], nAnalyzed, nTotal }>
   */
  SF.analyzeSceneColors = async function (files, onProgress) {
    const sample = pickSample(files);
    const nBins = HUE_BINS * SAT_BINS;
    const tot = { count: new Float64Array(nBins), r: new Float64Array(nBins), g: new Float64Array(nBins), b: new Float64Array(nBins) };
    const photos = []; // { name, canvas, data, w, h, count:Int32Array }
    let totalPixels = 0;

    for (let i = 0; i < sample.length; i++) {
      const th = await loadThumb(sample[i]);
      if (th) {
        const { canvas, ctx } = th;
        const w = canvas.width, h = canvas.height;
        const imgData = ctx.getImageData(0, 0, w, h);
        const data = imgData.data;
        const nPx = w * h;
        // stessa normalizzazione del rilevamento (gray-world, 4 canali RGBA): l'originale resta nel canvas
        const gains = computeGrayWorldGains(data, nPx, 4);
        applyGrayWorldGains(data, nPx, gains, 4);
        const count = new Int32Array(nBins);
        for (let p = 0; p < nPx; p++) {
          const k = p * 4;
          const bin = binOf(data[k], data[k + 1], data[k + 2]);
          if (bin < 0) continue;
          count[bin]++;
          tot.count[bin]++;
          tot.r[bin] += data[k]; tot.g[bin] += data[k + 1]; tot.b[bin] += data[k + 2];
        }
        totalPixels += nPx;
        photos.push({ name: sample[i].name, canvas, data, w, h, count });
      }
      if (onProgress) onProgress(i + 1, sample.length);
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0)); // lascia respirare l'interfaccia
    }

    if (!photos.length || !totalPixels) return { candidates: [], nAnalyzed: 0, nTotal: files.length };

    // ---- selezione dei bin candidati
    const N = photos.length;
    const ranked = [];
    for (let bin = 0; bin < nBins; bin++) {
      const f = tot.count[bin] / totalPixels;
      if (f <= 0 || f >= MAX_TOTAL_FRACTION) continue;
      let presence = 0, maxCount = 0, maxPhoto = -1;
      photos.forEach((ph, pi) => {
        const c = ph.count[bin];
        if (c >= MIN_PIXELS_IN_THUMB) presence++;
        if (c > maxCount) { maxCount = c; maxPhoto = pi; }
      });
      if (maxCount < MIN_PIXELS_IN_THUMB) continue;
      if (N > 3 && presence > MAX_PRESENCE_RATIO * N) continue;
      const score = Math.log10(1 / f) + (bin % SAT_BINS === 1 ? 0.3 : 0) + (presence <= 2 ? 0.5 : 0);
      ranked.push({ bin, f, presence, maxPhoto, score });
    }
    ranked.sort((a, b) => b.score - a.score);

    // ---- accorpa tonalità adiacenti (stessa "famiglia di colore"), tieni i migliori
    const chosen = [];
    for (const c of ranked) {
      const hb = Math.floor(c.bin / SAT_BINS);
      const near = chosen.some((o) => {
        const ob = Math.floor(o.bin / SAT_BINS);
        const d = Math.min(Math.abs(hb - ob), HUE_BINS - Math.abs(hb - ob));
        return d <= 1;
      });
      if (near) continue;
      chosen.push(c);
      if (chosen.length >= MAX_CANDIDATES) break;
    }

    // ---- per ogni candidato: colore medio, esempio ritagliato dove è più concentrato
    const candidates = chosen.map((c) => {
      const n = tot.count[c.bin];
      const rgb = [tot.r[c.bin] / n, tot.g[c.bin] / n, tot.b[c.bin] / n];
      const hue = (Math.floor(c.bin / SAT_BINS) + 0.5) * (360 / HUE_BINS);
      const ph = photos[c.maxPhoto];
      // cella CELL×CELL con più pixel di questo bin
      const cols = Math.ceil(ph.w / CELL), rows = Math.ceil(ph.h / CELL);
      const cells = new Int32Array(cols * rows);
      for (let y = 0; y < ph.h; y++) {
        for (let x = 0; x < ph.w; x++) {
          const k = (y * ph.w + x) * 4;
          if (binOf(ph.data[k], ph.data[k + 1], ph.data[k + 2]) === c.bin) cells[Math.floor(y / CELL) * cols + Math.floor(x / CELL)]++;
        }
      }
      let best = 0, bestIdx = 0;
      for (let i = 0; i < cells.length; i++) if (cells[i] > best) { best = cells[i]; bestIdx = i; }
      const cx = (bestIdx % cols) * CELL + CELL / 2, cy = Math.floor(bestIdx / cols) * CELL + CELL / 2;
      const x0 = Math.max(0, Math.min(ph.w - CROP, Math.round(cx - CROP / 2)));
      const y0 = Math.max(0, Math.min(ph.h - CROP, Math.round(cy - CROP / 2)));
      const ex = document.createElement('canvas');
      ex.width = 112; ex.height = 112;
      const ectx = ex.getContext('2d');
      ectx.imageSmoothingEnabled = false;
      ectx.drawImage(ph.canvas, x0, y0, Math.min(CROP, ph.w), Math.min(CROP, ph.h), 0, 0, 112, 112);
      return {
        name: hueName(hue),
        hex: rgbToHex(rgb[0], rgb[1], rgb[2]),
        rgb: rgb.map(Math.round),
        pctScene: Math.round(c.f * 10000) / 100,
        presence: c.presence,
        nPhotos: N,
        photoName: ph.name,
        exampleUrl: ex.toDataURL('image/jpeg', 0.85),
      };
    });

    return { candidates, nAnalyzed: N, nTotal: files.length };
  };

  /** Patch RGBA 9×9 di un colore esatto, nel formato atteso da computeProfileFromSamples (come la modalità Palette). */
  SF.solidPatch = function (rgb) {
    const w = 9, h = 9;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      data[i * 4] = rgb[0]; data[i * 4 + 1] = rgb[1]; data[i * 4 + 2] = rgb[2]; data[i * 4 + 3] = 255;
    }
    return { data, width: w, height: h };
  };
})();
