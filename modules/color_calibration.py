"""Estrazione e calibrazione del profilo colore di un campione (indumento/target).

Il campione viene analizzato in HSV e CIE-LAB per ridurre l'influenza di ombre,
esposizione e luce solare diretta rispetto al solo RGB. Il profilo prodotto qui
viene salvato su disco e riutilizzato dal modulo di elaborazione immagini (Modulo 3)
per generare le maschere di colore sulle foto di missione.
"""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path

import cv2
import numpy as np

DEFAULT_PROFILES_DIR = Path(__file__).resolve().parent.parent / "profiles"

# Tolleranza di default (in punti canale) applicata attorno al colore medio rilevato
DEFAULT_TOLERANCE_HSV = (10, 60, 60)   # (H, S, V)
DEFAULT_TOLERANCE_LAB = (15, 15, 15)   # (L, a, b)


@dataclass
class ColorProfile:
    name: str
    mean_hsv: list[float]
    std_hsv: list[float]
    mean_lab: list[float]
    std_lab: list[float]
    dominant_hsv: list[list[float]]     # centroidi k-means (palette dominante) in HSV
    dominant_lab: list[list[float]]     # centroidi k-means (palette dominante) in LAB
    tolerance_hsv: list[float] = field(default_factory=lambda: list(DEFAULT_TOLERANCE_HSV))
    tolerance_lab: list[float] = field(default_factory=lambda: list(DEFAULT_TOLERANCE_LAB))
    sample_source: str = ""
    roi: list[int] | None = None  # [x, y, w, h] se estratto da crop manuale

    def hsv_bounds(self) -> tuple[np.ndarray, np.ndarray]:
        h, s, v = self.mean_hsv
        th, ts, tv = self.tolerance_hsv
        lower = np.array([max(h - th, 0), max(s - ts, 0), max(v - tv, 0)], dtype=np.uint8)
        upper = np.array([min(h + th, 179), min(s + ts, 255), min(v + tv, 255)], dtype=np.uint8)
        return lower, upper

    def lab_bounds(self) -> tuple[np.ndarray, np.ndarray]:
        l, a, b = self.mean_lab
        tl, ta, tb = self.tolerance_lab
        lower = np.array([max(l - tl, 0), max(a - ta, 0), max(b - tb, 0)], dtype=np.uint8)
        upper = np.array([min(l + tl, 255), min(a + ta, 255), min(b + tb, 255)], dtype=np.uint8)
        return lower, upper


def extract_roi(image_bgr: np.ndarray, roi: tuple[int, int, int, int]) -> np.ndarray:
    """Ritaglia una ROI (x, y, w, h) in pixel dall'immagine campione."""
    x, y, w, h = roi
    height, width = image_bgr.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(width, x + w), min(height, y + h)
    if x1 <= x0 or y1 <= y0:
        raise ValueError("ROI non valida rispetto alle dimensioni dell'immagine")
    return image_bgr[y0:y1, x0:x1]


def _dominant_colors(pixels: np.ndarray, k: int) -> np.ndarray:
    """K-means sui pixel campionati; restituisce i k centroidi ordinati per frequenza."""
    k = max(1, min(k, len(pixels)))
    pixels_f32 = pixels.astype(np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5)
    _, labels, centers = cv2.kmeans(pixels_f32, k, None, criteria, attempts=5, flags=cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(labels.flatten(), minlength=k)
    order = np.argsort(-counts)
    return centers[order]


def compute_color_profile(
    image_bgr: np.ndarray,
    name: str,
    roi: tuple[int, int, int, int] | None = None,
    k: int = 3,
    tolerance_hsv: tuple[float, float, float] = DEFAULT_TOLERANCE_HSV,
    tolerance_lab: tuple[float, float, float] = DEFAULT_TOLERANCE_LAB,
    sample_source: str = "",
) -> ColorProfile:
    """Costruisce il profilo colore (HSV + LAB) da un'immagine campione o da una sua ROI."""
    sample = extract_roi(image_bgr, roi) if roi is not None else image_bgr

    hsv = cv2.cvtColor(sample, cv2.COLOR_BGR2HSV)
    lab = cv2.cvtColor(sample, cv2.COLOR_BGR2LAB)

    hsv_pixels = hsv.reshape(-1, 3)
    lab_pixels = lab.reshape(-1, 3)

    mean_hsv = hsv_pixels.mean(axis=0)
    std_hsv = hsv_pixels.std(axis=0)
    mean_lab = lab_pixels.mean(axis=0)
    std_lab = lab_pixels.std(axis=0)

    dominant_hsv = _dominant_colors(hsv_pixels, k)
    dominant_lab = _dominant_colors(lab_pixels, k)

    return ColorProfile(
        name=name,
        mean_hsv=mean_hsv.round(2).tolist(),
        std_hsv=std_hsv.round(2).tolist(),
        mean_lab=mean_lab.round(2).tolist(),
        std_lab=std_lab.round(2).tolist(),
        dominant_hsv=dominant_hsv.round(2).tolist(),
        dominant_lab=dominant_lab.round(2).tolist(),
        tolerance_hsv=list(tolerance_hsv),
        tolerance_lab=list(tolerance_lab),
        sample_source=sample_source,
        roi=list(roi) if roi is not None else None,
    )


def save_profile(profile: ColorProfile, directory: Path | str = DEFAULT_PROFILES_DIR) -> Path:
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in profile.name) or "profilo"
    path = directory / f"{safe_name}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(asdict(profile), f, ensure_ascii=False, indent=2)
    return path


def load_profile(path: Path | str) -> ColorProfile:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return ColorProfile(**data)


def list_saved_profiles(directory: Path | str = DEFAULT_PROFILES_DIR) -> list[Path]:
    directory = Path(directory)
    if not directory.exists():
        return []
    return sorted(directory.glob("*.json"))
