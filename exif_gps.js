/**
 * Lettore EXIF/GPS minimale per JPEG, senza dipendenze esterne.
 *
 * Porta in JS la stessa logica di modules/image_processing.py:read_exif_gps()
 * (che usa piexif lato Python): legge SOLO il segmento APP1/EXIF vicino
 * all'inizio del file (non l'intera immagine, per restare veloce anche su
 * centinaia di foto 4K), estrae GPSLatitude/Longitude/Altitude e
 * DateTimeOriginal, e non lancia mai eccezioni verso il chiamante — in caso
 * di file senza EXIF o non leggibile ritorna semplicemente valori nulli.
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

function findApp1Exif(view, byteLength) {
  // JPEG: SOI 0xFFD8, poi segmenti marker(2B) + length(2B, include se stesso) + payload.
  if (view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset < byteLength - 4) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) break; // non è un marker valido, ci fermiamo
    if (marker === 0xffd8 || marker === 0xffd9) { offset += 2; continue; }
    // SOS (Start of Scan, 0xFFDA): dopo inizia il flusso compresso, non ci sono più marker utili prima
    if (marker === 0xffda) break;
    const segLength = view.getUint16(offset + 2);
    if (marker === 0xffe1) {
      // APP1: verifica header "Exif\0\0"
      const headerStart = offset + 4;
      if (
        view.getUint8(headerStart) === 0x45 && // E
        view.getUint8(headerStart + 1) === 0x78 && // x
        view.getUint8(headerStart + 2) === 0x69 && // i
        view.getUint8(headerStart + 3) === 0x66 && // f
        view.getUint8(headerStart + 4) === 0x00 &&
        view.getUint8(headerStart + 5) === 0x00
      ) {
        return headerStart + 6; // inizio del TIFF header
      }
    }
    offset += 2 + segLength;
  }
  return null;
}

/**
 * Legge GPS/quota/data da un File o Blob JPEG. Non lancia mai: in caso di
 * problemi ritorna tutti i campi a null (stesso comportamento di
 * read_exif_gps() in Python).
 */
async function readExifGps(file) {
  const result = { gps_lat: null, gps_lon: null, gps_altitude: null, datetime_original: null };
  try {
    const headSlice = file.slice(0, Math.min(EXIF_READ_BYTES, file.size));
    const buf = await headSlice.arrayBuffer();
    const view = new DataView(buf);

    const tiffStart = findApp1Exif(view, buf.byteLength);
    if (tiffStart === null) return result;

    const byteOrderMark = view.getUint16(tiffStart);
    const littleEndian = byteOrderMark === 0x4949; // "II"
    if (byteOrderMark !== 0x4949 && byteOrderMark !== 0x4d4d) return result;

    const ifd0Offset = tiffStart + view.getUint32(tiffStart + 4, littleEndian);
    const ifd0 = parseIFD(view, tiffStart, ifd0Offset, littleEndian);

    // DateTimeOriginal vive nella Exif SubIFD (tag 0x8769 in IFD0 punta lì)
    if (ifd0[0x8769] !== undefined) {
      const exifIfdOffset = tiffStart + ifd0[0x8769];
      const exifIfd = parseIFD(view, tiffStart, exifIfdOffset, littleEndian);
      if (typeof exifIfd[0x9003] === 'string') {
        result.datetime_original = exifIfd[0x9003];
      }
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
    }
  } catch (e) {
    // file non leggibile / EXIF malformato: torniamo i valori nulli, come piexif lato Python
  }
  return result;
}
