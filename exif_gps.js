/**
 * Lettore EXIF/GPS minimale per JPEG, senza dipendenze esterne.
 *
 * Porta in JS la stessa logica di modules/image_processing.py:read_exif_gps()
 * (che usa piexif lato Python): legge SOLO i segmenti APP1 vicino all'inizio
 * del file (non l'intera immagine, per restare veloce anche su centinaia di
 * foto 4K), estrae GPSLatitude/Longitude/Altitude e DateTimeOriginal dal
 * blocco EXIF standard, e non lancia mai eccezioni verso il chiamante — in
 * caso di file senza EXIF o non leggibile ritorna semplicemente valori nulli.
 *
 * In PIÙ, per la georeferenziazione per-pixel del target (vedi geo_utils.js),
 * legge anche — quando presenti — dati che l'EXIF standard non offre in modo
 * affidabile ma che i droni DJI scrivono in un secondo blocco APP1, in
 * formato XMP (XML testuale, letto qui con un semplice regex, non un parser
 * XML completo — sufficiente per gli attributi piatti che DJI scrive):
 *   - drone-dji:RelativeAltitude — quota SUL PUNTO DI DECOLLO (AGL rispetto
 *     al take-off, non quota assoluta), il dato giusto per calcolare il GSD;
 *   - drone-dji:GimbalYawDegree / drone-dji:FlightYawDegree — imbardata
 *     (heading) della camera/drone, per orientare correttamente l'offset
 *     pixel->metri del target rispetto al nord.
 *   - drone-dji:GimbalPitchDegree — usato dalla proiezione in geo_utils.js
 *     per correggere automaticamente scatti non nadir (obliqui), non solo
 *     per segnalarli.
 * Se questi campi DJI non ci sono, si tenta il tag EXIF standard
 * GPSImgDirection come fallback per l'heading; se anche quello manca, la
 * georeferenziazione del target ricade sulle assunzioni documentate in
 * geo_utils.js (nord=up, quota di fallback impostata dall'utente in Batch).
 */

// Legge solo i primi bytes del file: l'header EXIF è sempre vicino all'inizio.
const EXIF_READ_BYTES = 262144; // 256KB, ampio margine rispetto ai pochi KB tipici di un header EXIF

function readTag(view, offset, littleEndian) {
  const tag = view.getUint16(offset, littleEndian);
  const type = view.getUint16(offset + 2, littleEndian);
  const count = view.getUint32(offset + 4, littleEndian);
  return { tag, type, count, valueOffset: offset + 8 };
}

const TYPE_SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

function readValue(view, tiffStart, entry, littleEndian) {
  const size = (TYPE_SIZES[entry.type] || 1) * entry.count;
  const dataOffset = size <= 4 ? entry.valueOffset : tiffStart + view.getUint32(entry.valueOffset, littleEndian);

  if (entry.type === 2) {
    // ASCII string
    const bytes = [];
    for (let i = 0; i < entry.count; i++) {
      const b = view.getUint8(dataOffset + i);
      if (b === 0) break;
      bytes.push(b);
    }
    return String.fromCharCode(...bytes);
  }
  if (entry.type === 3) {
    // SHORT
    const vals = [];
    for (let i = 0; i < entry.count; i++) vals.push(view.getUint16(dataOffset + i * 2, littleEndian));
    return entry.count === 1 ? vals[0] : vals;
  }
  if (entry.type === 4) {
    // LONG
    const vals = [];
    for (let i = 0; i < entry.count; i++) vals.push(view.getUint32(dataOffset + i * 4, littleEndian));
    return entry.count === 1 ? vals[0] : vals;
  }
  if (entry.type === 5) {
    // RATIONAL: pair of LONGs (numerator, denominator)
    const vals = [];
    for (let i = 0; i < entry.count; i++) {
      const num = view.getUint32(dataOffset + i * 8, littleEndian);
      const den = view.getUint32(dataOffset + i * 8 + 4, littleEndian);
      vals.push(den === 0 ? 0 : num / den);
    }
    return entry.count === 1 ? vals[0] : vals;
  }
  if (entry.type === 1 || entry.type === 7) {
    // BYTE / UNDEFINED
    const vals = [];
    for (let i = 0; i < entry.count; i++) vals.push(view.getUint8(dataOffset + i));
    return entry.count === 1 ? vals[0] : vals;
  }
  return null;
}

function parseIFD(view, tiffStart, ifdOffset, littleEndian) {
  const entries = {};
  const numEntries = view.getUint16(ifdOffset, littleEndian);
  for (let i = 0; i < numEntries; i++) {
    const entryOffset = ifdOffset + 2 + i * 12;
    const entry = readTag(view, entryOffset, littleEndian);
    try {
      entries[entry.tag] = readValue(view, tiffStart, entry, littleEndian);
    } catch (e) {
      // tag malformato: lo ignoriamo e proseguiamo con gli altri
    }
  }
  return entries;
}

function dmsToDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return null;
  let value = dms[0] + dms[1] / 60 + dms[2] / 3600;
  if (ref === 'S' || ref === 'W') value = -value;
  return value;
}

/** Confronta i byte a partire da `offset` con la stringa ASCII data (usata per riconoscere gli header dei segmenti APP1). */
function matchesAscii(view, offset, byteLength, str) {
  if (offset + str.length > byteLength) return false;
  for (let i = 0; i < str.length; i++) {
    if (view.getUint8(offset + i) !== str.charCodeAt(i)) return false;
  }
  return true;
}

const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

/**
 * Scandisce UNA volta i segmenti JPEG all'inizio del file e restituisce sia
 * il punto di inizio del blocco TIFF/EXIF (per GPS/data) sia il testo grezzo
 * del blocco XMP (per i tag DJI drone-dji:*), se presenti. I droni DJI
 * scrivono entrambi i blocchi come segmenti APP1 distinti, uno di seguito
 * all'altro, prima dell'inizio dei dati immagine compressi (marker SOS).
 */
function findApp1Segments(view, byteLength) {
  const result = { exifTiffStart: null, xmpText: null };
  // JPEG: SOI 0xFFD8, poi segmenti marker(2B) + length(2B, include se stesso) + payload.
  if (view.getUint16(0) !== 0xffd8) return result;
  let offset = 2;
  while (offset < byteLength - 4) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) break; // non è un marker valido, ci fermiamo
    if (marker === 0xffd8 || marker === 0xffd9) { offset += 2; continue; }
    // SOS (Start of Scan, 0xFFDA): dopo inizia il flusso compresso, non ci sono più marker utili prima
    if (marker === 0xffda) break;
    const segLength = view.getUint16(offset + 2);
    if (marker === 0xffe1) {
      const headerStart = offset + 4;
      if (result.exifTiffStart === null && matchesAscii(view, headerStart, byteLength, 'Exif\0\0')) {
        result.exifTiffStart = headerStart + 6; // inizio del TIFF header
      } else if (result.xmpText === null && matchesAscii(view, headerStart, byteLength, XMP_HEADER)) {
        const xmpStart = headerStart + XMP_HEADER.length;
        const xmpEnd = Math.min(byteLength, offset + 2 + segLength);
        if (xmpEnd > xmpStart) {
          try {
            const bytes = new Uint8Array(view.buffer, view.byteOffset + xmpStart, xmpEnd - xmpStart);
            result.xmpText = new TextDecoder('utf-8').decode(bytes);
          } catch (e) {
            result.xmpText = null;
          }
        }
      }
    }
    offset += 2 + segLength;
  }
  return result;
}

/**
 * Estrae un valore numerico da un tag XMP DJI, sia in forma di attributo
 * (`drone-dji:Nome="12.3"`, il formato che DJI usa davvero) sia — per
 * tolleranza — in forma di elemento XML (`<drone-dji:Nome>12.3</...>`).
 * Ritorna null se il tag non c'è o non è un numero valido.
 */
function xmpNumericTag(xmpText, name) {
  if (!xmpText) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attrMatch = xmpText.match(new RegExp(escaped + '\\s*=\\s*"([^"]*)"'));
  if (attrMatch) {
    const v = parseFloat(attrMatch[1]);
    return Number.isFinite(v) ? v : null;
  }
  const elMatch = xmpText.match(new RegExp('<' + escaped + '>\\s*([^<]*)\\s*<\\/' + escaped + '>'));
  if (elMatch) {
    const v = parseFloat(elMatch[1]);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

/** Normalizza un angolo DJI (tipicamente -180..180, 0=nord, orario) in una direzione compass 0..360. */
function normalizeHeadingDeg(deg) {
  let h = deg % 360;
  if (h < 0) h += 360;
  return h;
}

/**
 * Legge GPS/quota/data/heading da un File o Blob JPEG. Non lancia mai: in
 * caso di problemi ritorna tutti i campi a null (stesso comportamento di
 * read_exif_gps() in Python per i campi che esisteva già).
 *
 * Campi restituiti in più rispetto alla versione base, usati da geo_utils.js
 * per calcolare la posizione GPS del target (non solo del centro foto):
 *   - rel_altitude_m: quota AGL sul punto di decollo, da drone-dji:RelativeAltitude
 *     (XMP). null se il drone/produttore non scrive questo tag.
 *   - heading_deg: imbardata della camera in gradi 0-360 (0=nord, orario).
 *     Preferenza: drone-dji:GimbalYawDegree (yaw della camera, il più preciso)
 *     > drone-dji:FlightYawDegree (yaw del velivolo, buona approssimazione se
 *     il gimbal non pana indipendentemente) > EXIF standard GPSImgDirection
 *     (raro su DJI, utile per altri produttori) > null se nessuno presente.
 *   - heading_source: quale dei tre ha fornito il valore ('xmp_gimbal_yaw' |
 *     'xmp_flight_yaw' | 'exif_gps_img_direction' | null), mostrato in Report
 *     per trasparenza sull'affidabilità della georeferenziazione.
 *   - gimbal_pitch_deg: da drone-dji:GimbalPitchDegree. Usato dalla
 *     proiezione raggio-terreno in geo_utils.js per calcolare correttamente
 *     la posizione anche su scatti obliqui (non solo nadir puro), e per
 *     segnalare in Report quando l'obliquità rende la stima meno certa.
 *
 * In PIÙ, campi EXIF standard (non DJI) usati in Elaborazione Batch per riconoscere
 * automaticamente la camera in uso (vedi matchDroneFromExifFingerprint in js/batch.js), SENZA
 * fare affidamento sul tag Model (che l'EXIF DJI non riporta in modo distinguibile tra le diverse
 * camere di uno stesso drone, es. grandangolare vs tele): dimensioni immagine reali e lunghezza
 * focale reale (non equivalente 35mm) sono invece dati oggettivi della foto stessa, confrontabili
 * con la tabella DRONES:
 *   - exif_image_width / exif_image_height: da ExifImageWidth (0xA002) / ExifImageHeight (0xA003).
 *   - focal_length_mm: da FocalLength (0x920A), lunghezza focale REALE in mm (non l'equivalente
 *     35mm, tag diverso 0xA405, qui non usato).
 */
async function readExifGps(file) {
  const result = {
    gps_lat: null, gps_lon: null, gps_altitude: null, datetime_original: null,
    rel_altitude_m: null, heading_deg: null, heading_source: null, gimbal_pitch_deg: null,
    exif_image_width: null, exif_image_height: null, focal_length_mm: null,
  };
  try {
    const headSlice = file.slice(0, Math.min(EXIF_READ_BYTES, file.size));
    const buf = await headSlice.arrayBuffer();
    const view = new DataView(buf);

    const segs = findApp1Segments(view, buf.byteLength);

    if (segs.exifTiffStart !== null) {
      const tiffStart = segs.exifTiffStart;
      const byteOrderMark = view.getUint16(tiffStart);
      const littleEndian = byteOrderMark === 0x4949; // "II"
      if (byteOrderMark === 0x4949 || byteOrderMark === 0x4d4d) {
        const ifd0Offset = tiffStart + view.getUint32(tiffStart + 4, littleEndian);
        const ifd0 = parseIFD(view, tiffStart, ifd0Offset, littleEndian);

        // DateTimeOriginal vive nella Exif SubIFD (tag 0x8769 in IFD0 punta lì)
        if (ifd0[0x8769] !== undefined) {
          const exifIfdOffset = tiffStart + ifd0[0x8769];
          const exifIfd = parseIFD(view, tiffStart, exifIfdOffset, littleEndian);
          if (typeof exifIfd[0x9003] === 'string') {
            result.datetime_original = exifIfd[0x9003];
          }
          // Dimensioni immagine reali e focale reale: fingerprint della camera (vedi commento sopra).
          if (typeof exifIfd[0xa002] === 'number') result.exif_image_width = exifIfd[0xa002];
          if (typeof exifIfd[0xa003] === 'number') result.exif_image_height = exifIfd[0xa003];
          if (typeof exifIfd[0x920a] === 'number') result.focal_length_mm = exifIfd[0x920a];
        }

        // GPS vive nella GPS SubIFD (tag 0x8825 in IFD0 punta lì)
        if (ifd0[0x8825] !== undefined) {
          const gpsIfdOffset = tiffStart + ifd0[0x8825];
          const gpsIfd = parseIFD(view, tiffStart, gpsIfdOffset, littleEndian);

          const latRef = typeof gpsIfd[0x0001] === 'string' ? gpsIfd[0x0001] : null;
          const lonRef = typeof gpsIfd[0x0003] === 'string' ? gpsIfd[0x0003] : null;
          if (gpsIfd[0x0002] && gpsIfd[0x0004] && latRef && lonRef) {
            result.gps_lat = dmsToDecimal(gpsIfd[0x0002], latRef);
            result.gps_lon = dmsToDecimal(gpsIfd[0x0004], lonRef);
          }
          if (typeof gpsIfd[0x0006] === 'number') {
            let alt = gpsIfd[0x0006];
            if (gpsIfd[0x0005] === 1) alt = -alt;
            result.gps_altitude = alt;
          }
          // Fallback per l'heading, standard EXIF (raro sui DJI ma utile per altri droni):
          // GPSImgDirection (0x0011) è la direzione verso cui punta la camera, in gradi 0-360;
          // GPSImgDirectionRef (0x0010) vale 'T' (vero nord) o 'M' (nord magnetico) — qui non
          // correggiamo la declinazione magnetica (dato non disponibile client-side), la
          // trattiamo come nord vero: errore tipicamente di pochi gradi, accettabile per SAR.
          if (typeof gpsIfd[0x0011] === 'number') {
            result.heading_deg = normalizeHeadingDeg(gpsIfd[0x0011]);
            result.heading_source = 'exif_gps_img_direction';
          }
        }
      }
    }

    if (segs.xmpText) {
      const relAlt = xmpNumericTag(segs.xmpText, 'drone-dji:RelativeAltitude');
      if (relAlt !== null) result.rel_altitude_m = relAlt;

      const gimbalYaw = xmpNumericTag(segs.xmpText, 'drone-dji:GimbalYawDegree');
      const flightYaw = xmpNumericTag(segs.xmpText, 'drone-dji:FlightYawDegree');
      if (gimbalYaw !== null) {
        result.heading_deg = normalizeHeadingDeg(gimbalYaw);
        result.heading_source = 'xmp_gimbal_yaw';
      } else if (flightYaw !== null) {
        result.heading_deg = normalizeHeadingDeg(flightYaw);
        result.heading_source = 'xmp_flight_yaw';
      }

      const gimbalPitch = xmpNumericTag(segs.xmpText, 'drone-dji:GimbalPitchDegree');
      if (gimbalPitch !== null) result.gimbal_pitch_deg = gimbalPitch;
    }
  } catch (e) {
    // file non leggibile / EXIF o XMP malformato: torniamo i valori nulli, come piexif lato Python
  }
  return result;
}
