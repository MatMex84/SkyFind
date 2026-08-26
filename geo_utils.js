/**
 * geo_utils.js — georeferenziazione per-pixel del target rilevato.
 *
 * Fino ad ora SkyFind riportava solo la posizione GPS del CENTRO FOTO (cioè
 * del drone al momento dello scatto, dai tag EXIF standard). Queste funzioni
 * calcolano invece la posizione GPS del TARGET stesso, partendo da: dove
 * si trovava il drone, quanto era alto, dove punta la camera (yaw E pitch,
 * quindi anche scatti obliqui, non solo nadir) e a quanti pixel di distanza
 * dal centro immagine è stato rilevato il target.
 *
 * File dual-context come color_calib.js: nessuna dipendenza dal DOM, solo
 * funzioni pure su numeri — caricato sia da detect_worker.js (via
 * importScripts, dove viene eseguito il calcolo per ogni detection) sia,
 * volendo, dal thread principale.
 *
 * ## Il modello geometrico
 *
 * pixelOffsetToLatLon() non usa più un semplice fattore di scala (GSD)
 * applicato al pixel: proietta un vero raggio ottico (modello pin-hole)
 * dalla camera, orientato secondo yaw e pitch letti dagli EXIF/XMP della
 * FOTO STESSA (non un valore fisso), fino a intersecarlo con il piano del
 * terreno. Questo gestisce automaticamente sia il caso nadir (gimbal -90°)
 * sia scatti obliqui (es. i -75°/-85° che il Mission Planner consiglia in
 * bosco): non serve più sapere a priori se lo scatto è nadir o obliquo, il
 * calcolo lo capisce da solo dal tag drone-dji:GimbalPitchDegree di ogni
 * foto e si corregge di conseguenza.
 *
 * Frame di riferimento: mondo ENU (Est, Nord, Alto) centrato nel punto a
 * terra sotto il drone; drone/camera in (0,0,h), h = quota AGL. Con yaw ψ
 * (bearing, 0=nord, orario) e pitch φ (convenzione DJI: -90°=nadir puro,
 * 0°=orizzontale) e assumendo roll=0 (gimbal a 3 assi, quasi sempre vero in
 * pratica — vedi limite 5 sotto), gli assi camera in coordinate mondo sono:
 *   forward (asse ottico) F = (cosφ·sinψ, cosφ·cosψ, sinφ)
 *   right   (destra immagine) R = (cosψ, -sinψ, 0)
 *   down    (basso immagine)  D = F × R = (sinφ·sinψ, sinφ·cosψ, -cosφ)
 * Un pixel a offset (dxPx,dyPx) dal centro genera il raggio (in coordinate
 * mondo, non normalizzato) ray = R·(dxPx/f) + D·(dyPx/f) + F, dove f è la
 * focale in PIXEL (vedi computeFocalLengthPx). Si interseca con il piano
 * z=-h per trovare il punto a terra. Con φ=-90° (nadir) questa formula si
 * riduce esattamente alla vecchia formula lineare basata sul GSD (verificato
 * algebricamente e con un test numerico dedicato) — non è un modello
 * alternativo, è la sua generalizzazione corretta anche per scatti obliqui.
 *
 * ASSUNZIONI e LIMITI NOTI (documentati anche in Report, per trasparenza):
 *
 * 1. Il pitch/yaw usati sono quelli letti dai metadati DELLA FOTO (XMP DJI
 *    drone-dji:GimbalPitchDegree/GimbalYawDegree, o FlightYawDegree se il
 *    gimbal non pana indipendentemente) — quando mancano, il calcolo assume
 *    nadir (φ=-90°) e nord (ψ=0°), la stessa assunzione di prima, ma
 *    esplicitamente marcata (vedi heading_source in exif_gps.js) così il
 *    Report può segnalarlo invece di mostrare una posizione come se fosse
 *    certa.
 *
 * 2. Terreno pianeggiante rispetto al punto di decollo. La quota usata è
 *    l'AGL relativo al take-off (drone-dji:RelativeAltitude, quando c'è, o
 *    il valore di fallback impostato dall'utente in Elaborazione Batch), non
 *    un vero modello di elevazione del terreno sotto il target — non
 *    disponibile client-side senza connessione. Su terreno molto accidentato
 *    (dislivelli marcati tra punto di decollo e punto del target) la
 *    posizione stimata può discostarsi dal reale; l'effetto è più
 *    pronunciato su scatti molto obliqui, dove un errore di quota si
 *    traduce in un errore di posizione a terra amplificato dalla tangente
 *    dell'angolo di ripresa.
 *
 * 3. Proiezione piana (equirettangolare) per convertire l'offset est/nord in
 *    lat/lon, non una proiezione cartografica vera: adeguata alle distanze
 *    in gioco in una missione SAR (decine-centinaia di metri dal punto di
 *    scatto), non per aree molto estese.
 *
 * 4. La precisione della posizione dipende dalla precisione con cui il
 *    drone misura/scrive yaw e pitch nei metadati (in pratica dell'ordine di
 *    ±1°): su uno scatto nadir questo errore angolare pesa poco, ma su uno
 *    scatto molto obliquo e/o per un target vicino al bordo dell'immagine
 *    si amplifica — obliqueShotWarning() lo segnala esplicitamente nel
 *    Report, anche se la posizione VIENE comunque calcolata (proiettata),
 *    non semplicemente omessa.
 *
 * 5. Roll del gimbal assunto 0° (i gimbal a 3 assi DJI lo stabilizzano
 *    quasi sempre all'orizzonte): non leggiamo/usiamo drone-dji:
 *    GimbalRollDegree. In caso di roll residuo non compensato dal gimbal,
 *    la posizione stimata avrebbe un errore laterale non corretto qui.
 *
 * 6. Se il raggio del pixel non interseca mai il terreno (caso raro: scatto
 *    molto obliquo con il target vicino al bordo superiore dell'immagine,
 *    oltre l'orizzonte apparente) la posizione non è calcolabile: viene
 *    segnalato invece di restituire un punto a distanza infinita/assurda.
 */

// Metri per grado di latitudine (approssimazione sferica, standard per queste distanze).
const EARTH_METERS_PER_DEG_LAT = 111320;

// Oltre questa soglia (gradi di scarto dal nadir -90°) segnaliamo lo scatto come "obliquo": la
// posizione viene comunque proiettata correttamente, ma l'incertezza di misura di yaw/pitch pesa
// di più — sotto la soglia l'effetto è trascurabile per uno score di ricerca SAR.
const NADIR_PITCH_TOLERANCE_DEG = 10;

/**
 * GSD (Ground Sample Distance) "equivalente nadir" in metri/pixel, alla
 * quota AGL data — utile come indicatore di risoluzione generale (e per il
 * filtro geometrico sull'area dei blob), non più usato direttamente per il
 * calcolo della posizione (che ora usa la focale in pixel + proiezione,
 * vedi computeFocalLengthPx/pixelOffsetToLatLon). Su scatti molto obliqui il
 * GSD reale varia punto per punto nell'immagine: questo resta un valore di
 * riferimento al centro, non un dato preciso per ogni pixel.
 * Ritorna null se manca un dato necessario o non è fisicamente valido.
 */
function computeGsdMPerPx(altitudeAglM, sensorWidthMm, focalLengthMm, imageWidthPx) {
  if (!(altitudeAglM > 0) || !(sensorWidthMm > 0) || !(focalLengthMm > 0) || !(imageWidthPx > 0)) return null;
  return (sensorWidthMm * altitudeAglM) / (focalLengthMm * imageWidthPx);
}

/** Focale in PIXEL (intrinseco pin-hole), usata dalla proiezione raggio-terreno. */
function computeFocalLengthPx(sensorWidthMm, focalLengthMm, imageWidthPx) {
  if (!(sensorWidthMm > 0) || !(focalLengthMm > 0) || !(imageWidthPx > 0)) return null;
  return (focalLengthMm * imageWidthPx) / sensorWidthMm;
}

/**
 * Interseca il raggio ottico del pixel (dxPx,dyPx dal centro immagine) con
 * il piano del terreno, tenendo conto di yaw e pitch della camera. Ritorna
 * {eastM, northM} (offset a terra rispetto al punto sotto il drone) o null
 * se il raggio non incontra mai il terreno (vedi limite 6 in testa al file).
 * headingDegOrNull/pitchDegOrNull null => assunti 0° (nord) / -90° (nadir).
 */
function groundOffsetFromPixel(dxPx, dyPx, focalPx, altitudeAglM, headingDegOrNull, pitchDegOrNull) {
  const psi = ((headingDegOrNull === null || headingDegOrNull === undefined ? 0 : headingDegOrNull) * Math.PI) / 180;
  const phi = ((pitchDegOrNull === null || pitchDegOrNull === undefined ? -90 : pitchDegOrNull) * Math.PI) / 180;

  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  const cosPsi = Math.cos(psi), sinPsi = Math.sin(psi);

  // Assi camera in coordinate mondo (Est, Nord, Alto) — vedi derivazione in testa al file.
  const Fx = cosPhi * sinPsi, Fy = cosPhi * cosPsi, Fz = sinPhi;
  const Rx = cosPsi, Ry = -sinPsi; // Rz = 0 (right resta orizzontale con roll assunto 0)
  const Dx = sinPhi * sinPsi, Dy = sinPhi * cosPsi, Dz = -cosPhi;

  const u = dxPx / focalPx, v = dyPx / focalPx;
  const rayX = Rx * u + Dx * v + Fx;
  const rayY = Ry * u + Dy * v + Fy;
  const rayZ = Dz * v + Fz; // Rz*u = 0, omesso

  if (rayZ >= -1e-9) return null; // il raggio punta verso l'alto/orizzonte: non incontra mai il terreno

  const t = -altitudeAglM / rayZ;
  return { eastM: t * rayX, northM: t * rayY };
}

/**
 * Calcola lat/lon del target dato: posizione del drone, offset in pixel del
 * target rispetto al centro immagine (dxPx = destra positivo, dyPx = basso
 * positivo), focale in pixel (computeFocalLengthPx), quota AGL in metri,
 * heading e pitch della camera in gradi (heading: 0=nord, orario, null =
 * sconosciuto → assunto 0; pitch: convenzione DJI -90°=nadir, null =
 * sconosciuto → assunto -90°/nadir). Ritorna null se il raggio non incontra
 * il terreno (vedi groundOffsetFromPixel).
 */
function pixelOffsetToLatLon(droneLat, droneLon, dxPx, dyPx, focalPx, altitudeAglM, headingDegOrNull, pitchDegOrNull) {
  const offset = groundOffsetFromPixel(dxPx, dyPx, focalPx, altitudeAglM, headingDegOrNull, pitchDegOrNull);
  if (!offset) return null;

  const dLat = offset.northM / EARTH_METERS_PER_DEG_LAT;
  const dLon = offset.eastM / (EARTH_METERS_PER_DEG_LAT * Math.cos((droneLat * Math.PI) / 180));

  return { lat: droneLat + dLat, lon: droneLon + dLon };
}

/**
 * Se il tag DJI GimbalPitchDegree è disponibile e indica uno scatto non
 * nadir (oltre NADIR_PITCH_TOLERANCE_DEG di scarto da -90°), ritorna un
 * messaggio da mostrare in Report; altrimenti null (nadir, o dato assente —
 * in quel caso il calcolo assume comunque nadir, ma non lo sappiamo per
 * certo, quindi non emettiamo un avviso specifico sull'obliquità).
 * La posizione VIENE proiettata correttamente anche per scatti obliqui
 * (vedi pixelOffsetToLatLon): questo avviso segnala solo che l'incertezza
 * di misura di yaw/pitch pesa di più quanto più lo scatto è obliquo.
 */
function obliqueShotWarning(gimbalPitchDegOrNull) {
  if (gimbalPitchDegOrNull === null || gimbalPitchDegOrNull === undefined) return null;
  const offNadir = Math.abs(-90 - gimbalPitchDegOrNull);
  if (offNadir <= NADIR_PITCH_TOLERANCE_DEG) return null;
  return (
    `scatto obliquo (gimbal ${gimbalPitchDegOrNull.toFixed(0)}°, ${offNadir.toFixed(0)}° fuori dal nadir): la ` +
    `posizione del target è comunque calcolata tenendo conto dell'inclinazione, ma un piccolo errore nella lettura ` +
    `di yaw/pitch del drone pesa di più su scatti così obliqui — margine di errore verosimilmente maggiore del normale`
  );
}

/**
 * Distanza approssimata in metri tra due punti lat/lon (usata per la deduplica cross-foto del
 * punto 3: raggruppa le detection georiferite dello stesso target visto in scatti diversi con
 * overlap). Stessa proiezione piana usata altrove in questo file (EARTH_METERS_PER_DEG_LAT, con
 * cos(lat) per la longitudine) — coerente con pixelOffsetToLatLon() e adeguata alle distanze in
 * gioco in una missione SAR (non per calcoli geodetici su aree estese).
 */
function distanceMetersApprox(lat1, lon1, lat2, lon2) {
  const dLatM = (lat2 - lat1) * EARTH_METERS_PER_DEG_LAT;
  const avgLatRad = ((lat1 + lat2) / 2) * Math.PI / 180;
  const dLonM = (lon2 - lon1) * EARTH_METERS_PER_DEG_LAT * Math.cos(avgLatRad);
  return Math.sqrt(dLatM * dLatM + dLonM * dLonM);
}
