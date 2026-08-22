"""Elaborazione batch delle foto di missione: mascheratura colore, pulizia morfologica,
individuazione bounding box e lettura EXIF/GPS.

Progettato per lotti di centinaia di foto 4K senza appesantire la macchina:

- Le foto vengono elaborate **in streaming**, una alla volta per worker: non si tiene
  mai l'intero lotto in RAM, solo l'immagine corrente per worker attivo.
- I metadati GPS/EXIF vengono letti **prima** di decodificare i pixel (``piexif.load``
  legge solo il segmento EXIF del file); se il GPS è obbligatorio e assente, la foto
  viene scartata senza mai decodificare l'immagine.
- La fase di rilevamento (maschera colore + morfologia + contorni) gira su una copia
  **ridotta** dell'immagine: il ritaglio ad alta risoluzione viene estratto solo per i
  rilevamenti positivi, sulla sola area del bounding box (+ margine), non sull'intera foto.
- La parallelizzazione usa i **thread**, non i processi: le funzioni OpenCV usate qui
  (``imread``, ``cvtColor``, ``resize``, ``inRange``, ``morphologyEx``, ``findContours``)
  sono implementate in C++ e rilasciano il GIL durante l'esecuzione, quindi un
  ``ThreadPoolExecutor`` ottiene comunque uno speedup parallelo reale. Usare
  ``multiprocessing``/``ProcessPoolExecutor`` sotto Streamlit su Windows sarebbe fragile
  (lo spawn di un processo figlio rilancerebbe l'entry point di Streamlit stesso) e
  aggiungerebbe overhead di serializzazione delle immagini tra processi senza un
  vantaggio reale, dato che il collo di bottiglia CPU è già condiviso grazie al GIL
  rilasciato da OpenCV.
"""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator, Optional

import cv2
import numpy as np
import piexif

from .color_calibration import ColorProfile

SUPPORTED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff"}


@dataclass
class ProcessingConfig:
    color_space: str = "hsv"            # "hsv" | "lab" | "both" (both = AND, piu' selettivo)
    downscale_max_dim: int = 1600        # lato massimo per la fase di rilevamento (velocita')
    min_area_px_fullres: int = 400       # area minima contorno (px^2, in coordinate full-res)
    morph_kernel: int = 5                # kernel apertura/chiusura morfologica (px)
    max_detections_per_image: int = 8    # limite rilevamenti per foto (evita esplosioni su falsi positivi diffusi)
    require_gps: bool = False            # scarta le foto senza GPS senza decodificarle
    crop_padding_px: int = 20            # margine attorno al bounding box nel ritaglio salvato


@dataclass
class Detection:
    bbox: tuple[int, int, int, int]       # x, y, w, h in coordinate pixel full-res
    confidence: float                      # 0-100, in base alla distanza cromatica media dal profilo (CIE-LAB)
    fill_ratio: float                      # 0-100, percentuale del bbox coperta dalla maschera colore
    crop_jpeg: bytes                       # ritaglio ad alta risoluzione, JPEG encoded (per il report)


@dataclass
class ImageResult:
    path: str
    width: int
    height: int
    gps_lat: Optional[float] = None
    gps_lon: Optional[float] = None
    gps_altitude: Optional[float] = None
    datetime_original: Optional[str] = None
    detections: list[Detection] = field(default_factory=list)
    skipped_reason: Optional[str] = None
    error: Optional[str] = None


def list_images(folder: Path | str) -> list[Path]:
    folder = Path(folder)
    if not folder.is_dir():
        raise NotADirectoryError(f"Cartella non trovata: {folder}")
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in SUPPORTED_EXTENSIONS)


def _dms_to_decimal(dms, ref: bytes) -> float:
    degrees = dms[0][0] / dms[0][1]
    minutes = dms[1][0] / dms[1][1]
    seconds = dms[2][0] / dms[2][1]
    value = degrees + minutes / 60 + seconds / 3600
    if ref in (b"S", b"W"):
        value = -value
    return value


def read_exif_gps(path: Path | str) -> dict:
    """Legge GPS/quota/data dai metadati EXIF senza decodificare i pixel dell'immagine."""
    result = {"gps_lat": None, "gps_lon": None, "gps_altitude": None, "datetime_original": None}
    try:
        exif = piexif.load(str(path))
    except Exception:
        return result

    gps = exif.get("GPS", {})
    lat_dms = gps.get(piexif.GPSIFD.GPSLatitude)
    lat_ref = gps.get(piexif.GPSIFD.GPSLatitudeRef)
    lon_dms = gps.get(piexif.GPSIFD.GPSLongitude)
    lon_ref = gps.get(piexif.GPSIFD.GPSLongitudeRef)
    if lat_dms and lat_ref and lon_dms and lon_ref:
        result["gps_lat"] = _dms_to_decimal(lat_dms, lat_ref)
        result["gps_lon"] = _dms_to_decimal(lon_dms, lon_ref)

    alt = gps.get(piexif.GPSIFD.GPSAltitude)
    alt_ref = gps.get(piexif.GPSIFD.GPSAltitudeRef)
    if alt:
        altitude = alt[0] / alt[1]
        if alt_ref == 1:
            altitude = -altitude
        result["gps_altitude"] = altitude

    dt = exif.get("Exif", {}).get(piexif.ExifIFD.DateTimeOriginal)
    if dt:
        result["datetime_original"] = dt.decode("utf-8", errors="ignore")

    return result


def _build_mask(image_bgr: np.ndarray, profile: ColorProfile, color_space: str, kernel_size: int) -> np.ndarray:
    mask_hsv = mask_lab = None
    if color_space in ("hsv", "both"):
        hsv = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2HSV)
        lower, upper = profile.hsv_bounds()
        mask_hsv = cv2.inRange(hsv, lower, upper)
    if color_space in ("lab", "both"):
        lab = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2LAB)
        lower, upper = profile.lab_bounds()
        mask_lab = cv2.inRange(lab, lower, upper)

    if color_space == "hsv":
        mask = mask_hsv
    elif color_space == "lab":
        mask = mask_lab
    else:
        mask = cv2.bitwise_and(mask_hsv, mask_lab)

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (kernel_size, kernel_size))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    return mask


def _color_confidence(region_lab: np.ndarray, mask_region: np.ndarray, profile: ColorProfile) -> float:
    """Percentuale di match cromatico: 100% = colore medio del profilo, 0% = al limite della tolleranza impostata."""
    pixels = region_lab[mask_region > 0]
    if len(pixels) == 0:
        return 0.0
    mean_lab = np.array(profile.mean_lab, dtype=np.float32)
    delta = np.linalg.norm(pixels.astype(np.float32) - mean_lab, axis=1)
    mean_delta = float(delta.mean())
    tol = np.array(profile.tolerance_lab, dtype=np.float32)
    max_tol = float(np.linalg.norm(tol)) or 1.0
    confidence = 100.0 * (1.0 - mean_delta / max_tol)
    return max(0.0, min(100.0, confidence))


def process_image(path: Path | str, profile: ColorProfile, config: ProcessingConfig) -> ImageResult:
    """Elabora una singola foto: rilevamento su copia ridotta, ritaglio full-res solo sui match."""
    path = Path(path)
    gps = read_exif_gps(path)

    if config.require_gps and gps["gps_lat"] is None:
        return ImageResult(path=str(path), width=0, height=0, skipped_reason="Nessun dato GPS nei metadati EXIF", **gps)

    full = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if full is None:
        return ImageResult(path=str(path), width=0, height=0, error="Impossibile leggere il file immagine", **gps)

    h_full, w_full = full.shape[:2]
    scale = min(1.0, config.downscale_max_dim / max(h_full, w_full))
    small = (
        cv2.resize(full, (max(1, int(w_full * scale)), max(1, int(h_full * scale))), interpolation=cv2.INTER_AREA)
        if scale < 1.0
        else full
    )

    mask_small = _build_mask(small, profile, config.color_space, config.morph_kernel)
    contours, _ = cv2.findContours(mask_small, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    min_area_small = config.min_area_px_fullres * (scale ** 2)
    candidates = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < min_area_small:
            continue
        x, y, w, h = cv2.boundingRect(c)
        candidates.append((area, x, y, w, h))
    candidates.sort(key=lambda t: -t[0])

    detections: list[Detection] = []
    for area, x, y, w, h in candidates[: config.max_detections_per_image]:
        fx, fy = int(x / scale), int(y / scale)
        fw, fh = min(int(w / scale), w_full - fx), min(int(h / scale), h_full - fy)
        pad = config.crop_padding_px
        cx0, cy0 = max(0, fx - pad), max(0, fy - pad)
        cx1, cy1 = min(w_full, fx + fw + pad), min(h_full, fy + fh + pad)
        crop = full[cy0:cy1, cx0:cx1]
        if crop.size == 0:
            continue

        crop_mask = _build_mask(crop, profile, config.color_space, config.morph_kernel)
        crop_lab = cv2.cvtColor(crop, cv2.COLOR_BGR2LAB)
        confidence = _color_confidence(crop_lab, crop_mask, profile)
        fill_ratio = 100.0 * float((crop_mask > 0).sum()) / crop_mask.size

        ok, buf = cv2.imencode(".jpg", crop, [cv2.IMWRITE_JPEG_QUALITY, 90])
        crop_jpeg = buf.tobytes() if ok else b""

        detections.append(
            Detection(bbox=(fx, fy, fw, fh), confidence=round(confidence, 1), fill_ratio=round(fill_ratio, 1), crop_jpeg=crop_jpeg)
        )

    return ImageResult(path=str(path), width=w_full, height=h_full, detections=detections, **gps)


def process_batch(
    paths: list[Path | str],
    profile: ColorProfile,
    config: ProcessingConfig,
    max_workers: int | None = None,
) -> Iterator[ImageResult]:
    """Elabora il lotto in parallelo (thread) restituendo i risultati man mano che arrivano.

    Usare come iteratore per aggiornare una progress bar in tempo reale, es.::

        for i, result in enumerate(process_batch(paths, profile, config), 1):
            aggiorna_progress(i, len(paths))
    """
    max_workers = max_workers or min(8, (os.cpu_count() or 4))
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(process_image, p, profile, config): p for p in paths}
        for future in as_completed(futures):
            try:
                yield future.result()
            except Exception as e:
                yield ImageResult(path=str(futures[future]), width=0, height=0, error=str(e))
