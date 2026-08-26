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

// Modalità Palette: un solo colore esatto scelto dall'utente (nessuna foto reale), quindi la
// deviazione osservata tra campioni è SEMPRE zero e la formula adattiva sopra collasserebbe sempre
// al pavimento AUTO_TOLERANCE_LAB/HSV — la tolleranza più stretta possibile, anche più stretta di
// un singolo punto scelto col contagocce su una foto vera (che almeno un minimo di rumore/JPEG ce
// l'ha). Un colore "da catalogo" non cattura però la variazione reale di un target sul campo (luce,
// ombra, sporco, usura del tessuto): per questo qui si assume direttamente il tetto massimo
// (TOLERANCE_CEIL_MULT) invece di quello osservato — la stessa tolleranza che un campione fotografico
// otterrebbe nel caso di massima variazione consentita, non un valore nuovo o più permissivo di quello.

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ------------------------------------------------------------- normalizzazione illuminazione (punto 5)
/**
 * Normalizzazione dell'illuminazione stile "gray-world", punto 5 della roadmap: compensa le
 * variazioni di luce/esposizione tra foto diverse della stessa missione (sole pieno vs nuvoloso,
 * ombra del drone, esposizione automatica della camera che cambia scatto per scatto) PRIMA del
 * color matching, così lo stesso indumento risulta più simile a se stesso da una foto all'altra.
 *
 * Assunzione gray-world: in una foto "abbastanza varia" (terreno, vegetazione, ombre, strade...)
 * il colore medio della scena tende al grigio neutro; se un canale (R, G o B) ha una media diversa
 * dagli altri due, è probabile un cast di colore dovuto all'illuminazione — si corregge riportando
 * ogni canale alla stessa media (la media complessiva dei tre).
 *
 * IMPORTANTE: va calcolata sull'INTERA foto (o una sua versione ridotta rappresentativa), MAI su
 * un ritaglio piccolo dominato dal target stesso (es. una giacca rossa satura): un ritaglio così
 * violerebbe l'assunzione "il colore medio tende al grigio" e la correzione distorcerebbe proprio
 * il colore che si sta cercando di riconoscere. Per questo sia il worker di rilevamento
 * (detect_worker.js) sia la Calibrazione (js/calibrazione.js) calcolano i guadagni UNA VOLTA per
 * foto — su una versione dell'intera immagine — e li riapplicano identici a ogni ritaglio/campione
 * successivo della stessa foto, senza ricalcolarli localmente.
 *
 * Per lo stesso motivo la Calibrazione applica la stessa normalizzazione ai campioni prelevati
 * dalla foto (non alla modalità Palette, dove l'utente sceglie un colore esatto, senza una foto la
 * cui illuminazione vada compensata): profilo e rilevamento devono essere calcolati sulla stessa
 * base cromatica "canonicalizzata", altrimenti il confronto in batch sarebbe sistematicamente
 * disallineato rispetto a come il profilo è stato calibrato.
 *
 * LIMITE NOTO: un profilo salvato PRIMA di questa modifica è stato calibrato su colori grezzi (non
 * gray-world); da qui in avanti calibrazione e rilevamento sono coerenti tra loro per i profili
 * creati/aggiornati con questa versione, ma un profilo più vecchio può risultare leggermente meno
 * preciso finché non viene ricreato.
 */
const GRAY_WORLD_MAX_GAIN_DEVIATION = 0.35; // guadagni ammessi in [0.65, 1.35]: correzione moderata,
// mai estrema — su foto con poca varietà cromatica (molta neve, molto mare) l'assunzione di base è
// meno valida, e una correzione aggressiva rischierebbe di alterare i colori più del necessario.

function clamp255(v) {
  return Math.max(0, Math.min(255, v));
}

/**
 * Calcola i guadagni gray-world (uno per canale R,G,B) leggendo direttamente il buffer di pixel di
 * un'immagine — RGB a 3 canali (Mat OpenCV) o RGBA a 4 (ImageData canvas): solo i primi 3 canali
 * contano, l'eventuale alpha viene ignorato. Nessuna dipendenza da `cv` (loop diretto sul buffer,
 * stesso stile già usato in colorConfidence/buildMask), quindi utilizzabile identica sia sul thread
 * principale (Calibrazione) sia nel worker.
 */
function computeGrayWorldGains(data, nPixels, channelsPerPixel) {
  const stride = channelsPerPixel || 3;
  let sumR = 0, sumG = 0, sumB = 0;
  for (let i = 0; i < nPixels; i++) {
    const o = i * stride;
    sumR += data[o]; sumG += data[o + 1]; sumB += data[o + 2];
  }
  const meanR = sumR / nPixels, meanG = sumG / nPixels, meanB = sumB / nPixels;
  const overallMean = (meanR + meanG + meanB) / 3;
  const clampGain = (g) => clamp(g, 1 - GRAY_WORLD_MAX_GAIN_DEVIATION, 1 + GRAY_WORLD_MAX_GAIN_DEVIATION);
  return {
    r: clampGain(overallMean / Math.max(meanR, 1)),
    g: clampGain(overallMean / Math.max(meanG, 1)),
    b: clampGain(overallMean / Math.max(meanB, 1)),
  };
}

/**
 * Applica IN-PLACE i guadagni (da computeGrayWorldGains, calcolati una volta per foto) al buffer
 * passato — nessun nuovo Mat/ImageData allocato, il chiamante continua a usare lo stesso oggetto.
 */
function applyGrayWorldGains(data, nPixels, gains, channelsPerPixel) {
  const stride = channelsPerPixel || 3;
  for (let i = 0; i < nPixels; i++) {
    const o = i * stride;
    data[o] = clamp255(Math.round(data[o] * gains.r));
    data[o + 1] = clamp255(Math.round(data[o + 1] * gains.g));
    data[o + 2] = clamp255(Math.round(data[o + 2] * gains.b));
  }
}

/**
 * Calcola il profilo colore (media + tolleranza adattiva) da uno o piu' campioni.
 * Ogni sample e' una patch di pixel RGBA (come da canvas ImageData): con un
 * solo sample il comportamento e' equivalente alla vecchia funzione a patch
 * singola (tolleranza = valore fisso di base). Con piu' sample, la media e'
 * calcolata su tutti i pixel insieme e la tolleranza si allarga in base alla
 * deviazione standard osservata tra i campioni, entro i limiti sopra.
 *
 * `opts.widen` (usato dalla modalità Palette): salta il calcolo dalla deviazione osservata — che
 * con un colore esatto è sempre zero — e usa direttamente il tetto massimo di tolleranza. Nessun
 * effetto sulla modalità contagocce su foto (widen assente/false): comportamento invariato.
 */
function computeProfileFromSamples(cv, samples, opts) {
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

  const widen = !!(opts && opts.widen);
  const toleranceHsv = AUTO_TOLERANCE_HSV.map((base, i) =>
    widen ? base * TOLERANCE_CEIL_MULT : clamp(ADAPTIVE_K * stdHsv[i], base, base * TOLERANCE_CEIL_MULT)
  );
  const toleranceLab = AUTO_TOLERANCE_LAB.map((base, i) =>
    widen ? base * TOLERANCE_CEIL_MULT : clamp(ADAPTIVE_K * stdLab[i], base, base * TOLERANCE_CEIL_MULT)
  );

  return {
    mean_hsv: meanHsv,
    mean_lab: meanLab,
    tolerance_hsv: toleranceHsv,
    tolerance_lab: toleranceLab,
    n_samples: samples.length,
    n_pixels: totalPixels,
  };
}

/**
 * Colore medio CIE-LAB (convenzione OpenCV) dei soli pixel della maschera in una regione — usato
 * per memorizzare il colore effettivamente rilevato di ogni hit (punto 6: serve da "campione
 * negativo" quando l'utente segna un rilevamento come falso positivo, per restringere il profilo
 * lontano da quel colore specifico). Torna null se la maschera è vuota (nessun pixel > 0): può
 * capitare in rari casi limite di ritaglio/maschera ai bordi — il chiamante deve gestirlo.
 */
function meanLabMasked(cv, regionLabMat, maskMat) {
  const rows = regionLabMat.rows, cols = regionLabMat.cols;
  const labData = regionLabMat.data;
  const maskData = maskMat.data;
  let sumL = 0, sumA = 0, sumB = 0, n = 0;
  for (let i = 0; i < rows * cols; i++) {
    if (maskData[i] > 0) {
      sumL += labData[i * 3]; sumA += labData[i * 3 + 1]; sumB += labData[i * 3 + 2];
      n++;
    }
  }
  if (n === 0) return null;
  return [sumL / n, sumA / n, sumB / n];
}

/**
 * Punto 6: quando l'utente segna un rilevamento come falso positivo nel Report, il colore medio
 * EFFETTIVAMENTE rilevato (meanLabMasked sopra) diventa un "campione negativo" — restringiamo la
 * tolleranza del profilo sul canale con il margine più stretto (quello con cui la modifica minima
 * esclude quel punto), non su tutti e tre: inRange richiede che TUTTI i canali siano dentro i
 * limiti, quindi basta escludere su un solo asse per escludere l'intero punto, con il minor impatto
 * possibile su rilevamenti veri vicini ma non identici a quello segnalato.
 *
 * Un pavimento (frazione della tolleranza di base AUTO_TOLERANCE_LAB) impedisce che marcature
 * ripetute collassino il profilo a una tolleranza pressoché nulla, rendendolo inutilizzabile.
 */
const NEG_SAMPLE_MIN_TOLERANCE_MULT = 0.25;
const NEG_SAMPLE_MARGIN = 1; // unità LAB (0-255): il punto negativo deve restare chiaramente fuori, non sul bordo

function narrowToleranceFromFalsePositive(profile, negativeMeanLab) {
  const tol = profile.tolerance_lab.slice();
  const mean = profile.mean_lab;
  let bestIdx = -1, bestMargin = Infinity;
  for (let i = 0; i < 3; i++) {
    const offset = Math.abs(negativeMeanLab[i] - mean[i]);
    const margin = tol[i] - offset;
    if (margin < bestMargin) { bestMargin = margin; bestIdx = i; }
  }
  if (bestMargin <= 0) return tol; // il campione e' gia' fuori dal profilo su almeno un canale: nulla da restringere
  const offset = Math.abs(negativeMeanLab[bestIdx] - mean[bestIdx]);
  const floor = AUTO_TOLERANCE_LAB[bestIdx] * NEG_SAMPLE_MIN_TOLERANCE_MULT;
  tol[bestIdx] = Math.max(floor, offset - NEG_SAMPLE_MARGIN);
  return tol;
}

/**
 * La tonalità (H) in OpenCV è un angolo su una ruota 0-179 che poi torna a 0: il rosso sta proprio
 * sul punto di giunzione (rosso "caldo" vicino a H=0, rosso più violaceo/carrozzeria vicino a
 * H=179). Un intervallo dritto [h-th, h+th] tagliato a [0,179] esclude erroneamente metà della
 * tolleranza reale quando il colore campionato è vicino a uno dei due bordi — per esempio un rosso
 * campionato a H=2 con tolleranza 30 dovrebbe coprire anche H=175-179 (che sul cerchio dei colori
 * sono a soli pochi gradi di distanza), ma [2-30,2+30] tagliato a 0 dà [0,32], perdendo del tutto
 * quel lato. Qui si restituiscono 1 o 2 intervalli che insieme coprono correttamente il giro.
 */
function hsvHueRanges(h, th) {
  if (th >= 90) return [[0, 179]]; // tolleranza >= mezzo giro: copre già l'intera ruota
  const lo = h - th, hi = h + th;
  if (lo < 0) return [[0, hi], [lo + 180, 179]];
  if (hi > 179) return [[lo, 179], [0, hi - 180]];
  return [[lo, hi]];
}

function hsvBounds(profile) {
  const [h, s, v] = profile.mean_hsv;
  const [th, ts, tv] = profile.tolerance_hsv;
  return {
    hueRanges: hsvHueRanges(h, th),
    sRange: [Math.max(s - ts, 0), Math.min(s + ts, 255)],
    vRange: [Math.max(v - tv, 0), Math.min(v + tv, 255)],
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
    // Uno o due passaggi di inRange (uno per ogni intervallo di tonalità, vedi hsvHueRanges),
    // uniti con bitwise_or: un pixel passa se rientra in QUALSIASI dei due intervalli di H, con
    // S e V verificati identicamente in entrambi — gestisce correttamente il giro della ruota dei
    // colori attorno allo 0/179, dove sta il rosso.
    maskHsv = new cv.Mat();
    hb.hueRanges.forEach(([hLo, hHi], i) => {
      const lower = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [hLo, hb.sRange[0], hb.vRange[0], 0]);
      const upper = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [hHi, hb.sRange[1], hb.vRange[1], 255]);
      if (i === 0) {
        cv.inRange(hsv, lower, upper, maskHsv);
      } else {
        const partial = new cv.Mat();
        cv.inRange(hsv, lower, upper, partial);
        cv.bitwise_or(maskHsv, partial, maskHsv);
        partial.delete();
      }
      lower.delete(); upper.delete();
    });
    hsv.delete();
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

/**
 * Punteggio continuo di somiglianza cromatica (punto 4 della roadmap), non più una distanza
 * euclidea normalizzata sulla stessa scala per tutti i canali, ma una distanza di Mahalanobis a
 * covarianza diagonale: ogni canale LAB è pesato per la propria "sigma" effettiva, così un canale
 * più variabile nei campioni raccolti (tipicamente la luminosità, se il target è stato campionato
 * sia in luce che in ombra) pesa meno nel punteggio di un canale stabile — invece che tutti allo
 * stesso modo come nella vecchia normalizzazione isotropa.
 *
 * La "sigma" per canale è la tolleranza adattiva già calcolata per il profilo (vedi
 * computeProfileFromSamples sopra), riportata a deviazione standard dividendo per ADAPTIVE_K —
 * la stessa conversione usata al contrario per andare da std osservata a tolleranza, quindi con
 * lo stesso floor (un solo campione => tolleranza di base, mai zero: nessuna divisione per zero)
 * e lo stesso tetto già in vigore altrove nel profilo.
 *
 * Il punteggio è 100·exp(-d²/2), la stessa forma di una gaussiana multivariata: 100% a distanza
 * zero (colore medio esatto del profilo), ~61% a 1 sigma, ~14% a 2 sigma, <2% a 3 sigma — un
 * andamento continuo e statisticamente motivato, non un taglio netto dentro/fuori soglia.
 *
 * IMPORTANTE (vedi anche il Report): questo è un punteggio di RANKING — quanto un rilevamento
 * somiglia al profilo, in relazione agli altri — non un verdetto "vero/falso positivo". Un
 * punteggio basso può comunque essere un target reale (luce diversa, ombra, tessuto sporco o
 * bagnato): va sempre verificato a video, mai scartato solo perché il numero è basso.
 */
function colorConfidence(cv, regionLabMat, maskMat, profile) {
  const rows = regionLabMat.rows, cols = regionLabMat.cols;
  const labData = regionLabMat.data; // Uint8, 3 canali (RGB2Lab -> CV_8UC3)
  const maskData = maskMat.data;
  const [ml, ma, mb] = profile.mean_lab;
  const [sl, sa, sb] = profile.tolerance_lab.map((t) => Math.max(t / ADAPTIVE_K, 1e-6));
  let sumD2 = 0, n = 0;
  for (let i = 0; i < rows * cols; i++) {
    if (maskData[i] > 0) {
      const l = labData[i * 3], a = labData[i * 3 + 1], b = labData[i * 3 + 2];
      const dl = (l - ml) / sl, da = (a - ma) / sa, db = (b - mb) / sb;
      sumD2 += dl * dl + da * da + db * db;
      n++;
    }
  }
  if (n === 0) return 0;
  const meanD2 = sumD2 / n;
  const confidence = 100 * Math.exp(-meanD2 / 2);
  return Math.max(0, Math.min(100, confidence));
}
