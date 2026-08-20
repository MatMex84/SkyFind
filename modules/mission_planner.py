"""Calcolo parametri di volo (GSD, quota, overlap) per missioni SAPR/SAR."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

DEFAULT_DRONES_DB = Path(__file__).resolve().parent.parent / "config" / "drones.json"

# Linee guida di overlap raccomandate per fotogrammetria/mappatura SAR
FRONT_OVERLAP_MIN, FRONT_OVERLAP_MAX = 70, 80
SIDE_OVERLAP_MIN, SIDE_OVERLAP_MAX = 60, 70

# Target GSD raccomandato per individuazione target SAR
GSD_TARGET_MIN_CM = 1.0
GSD_TARGET_MAX_CM = 2.0


@dataclass
class SensorProfile:
    id: str
    drone: str
    sensore: str
    sensor_width_mm: float | None
    sensor_height_mm: float | None
    image_width_px: int | None
    image_height_px: int | None
    focal_length_mm: float | None
    note: str = ""

    @property
    def is_custom(self) -> bool:
        return self.sensor_width_mm is None or self.focal_length_mm is None or self.image_width_px is None


def load_sensor_profiles(path: Path | str = DEFAULT_DRONES_DB) -> list[SensorProfile]:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    return [SensorProfile(**entry) for entry in data["drones"]]


def gsd_cm_per_px(altitude_m: float, sensor_width_mm: float, focal_length_mm: float, image_width_px: int) -> float:
    """GSD (cm/pixel) in funzione della quota di volo (AGL, in metri)."""
    if focal_length_mm <= 0 or image_width_px <= 0:
        raise ValueError("focal_length_mm e image_width_px devono essere > 0")
    return (sensor_width_mm * altitude_m * 100) / (focal_length_mm * image_width_px)


def altitude_for_gsd(gsd_cm_px: float, sensor_width_mm: float, focal_length_mm: float, image_width_px: int) -> float:
    """Quota di volo (m AGL) necessaria per ottenere il GSD target."""
    if sensor_width_mm <= 0:
        raise ValueError("sensor_width_mm deve essere > 0")
    return (gsd_cm_px * focal_length_mm * image_width_px) / (sensor_width_mm * 100)


def recommended_altitude_range(
    sensor_width_mm: float,
    focal_length_mm: float,
    image_width_px: int,
    gsd_min_cm: float = GSD_TARGET_MIN_CM,
    gsd_max_cm: float = GSD_TARGET_MAX_CM,
) -> tuple[float, float]:
    """Range di quota (m AGL) che mantiene il GSD nell'intervallo target.

    Quota piu' bassa -> GSD piu' fine (gsd_min_cm); quota piu' alta -> GSD piu' grossolano (gsd_max_cm).
    """
    alt_min = altitude_for_gsd(gsd_min_cm, sensor_width_mm, focal_length_mm, image_width_px)
    alt_max = altitude_for_gsd(gsd_max_cm, sensor_width_mm, focal_length_mm, image_width_px)
    return alt_min, alt_max


def ground_footprint_m(altitude_m: float, sensor_width_mm: float, sensor_height_mm: float, focal_length_mm: float) -> tuple[float, float]:
    """Estensione a terra (larghezza, altezza in metri) inquadrata da un singolo fotogramma."""
    width_m = (sensor_width_mm * altitude_m) / focal_length_mm
    height_m = (sensor_height_mm * altitude_m) / focal_length_mm
    return width_m, height_m
