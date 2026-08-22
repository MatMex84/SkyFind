"""Calcolo parametri di volo (GSD, quota, overlap) per missioni SAPR/SAR."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

DEFAULT_DRONES_DB = Path(__file__).resolve().parent.parent / "config" / "drones.json"

# Linee guida di overlap raccomandate per fotogrammetria/mappatura SAR
FRONT_OVERLAP_MIN, FRONT_OVERLAP_MAX = 70, 80
SIDE_OVERLAP_MIN, SIDE_OVERLAP_MAX = 60, 70

# Target GSD raccomandato per individuazione target SAR (dettaglio indumento/persona).
# Range verificato rispetto al dataset accademico Heridal (foto SAR scattate tra 40 e 65m,
# con accuratezza di rilevamento che cala fuori da quel range) e alle specifiche reali della
# flotta: per il M3E camera wide, 0.8-1.5cm corrisponde a circa 30-56m di quota.
GSD_TARGET_MIN_CM = 0.8
GSD_TARGET_MAX_CM = 1.5


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


# Tempo di posa assunto per il calcolo della velocita' massima (ipotesi cautelativa in
# pieno giorno/luce buona: la maggior parte delle camere DJI in modalita' foto sceglie
# automaticamente tempi piu' rapidi di 1/1000s con luce sufficiente). Con poca luce o
# cielo coperto la fotocamera userà tempi più lunghi: in quel caso conviene volare più
# lenti di quanto indicato qui.
ASSUMED_SHUTTER_S = 1 / 1000

# Limite operativo massimo di velocita' di crociera per missioni SAR: oltre i vantaggi
# di sfocatura teorica, un tetto prudenziale che lascia margine per overlap, vento e
# affidabilita' del rilevamento (indicazione diretta, non derivata solo dal motion blur).
MAX_PRACTICAL_SPEED_MS = 7.0
MIN_PRACTICAL_SPEED_MS = 2.0


def recommended_max_speed_ms(gsd_cm_px: float, shutter_s: float = ASSUMED_SHUTTER_S) -> float:
    """Velocita' di avanzamento (m/s) che mantiene lo sfocatura da movimento entro ~1 pixel di GSD.

    Regola pratica di fotogrammetria: a parita' di tempo di posa, piu' il GSD e' fine
    (quota bassa) piu' bisogna volare piano per non sfocare i dettagli; con GSD piu'
    largo (quota alta) si puo' volare piu' veloci senza perdere nitidezza utile.
    """
    gsd_m = gsd_cm_px / 100.0
    speed = gsd_m / shutter_s
    return max(MIN_PRACTICAL_SPEED_MS, min(MAX_PRACTICAL_SPEED_MS, speed))


def recommended_speed_range_ms(
    sensor_width_mm: float,
    focal_length_mm: float,
    image_width_px: int,
    gsd_min_cm: float = GSD_TARGET_MIN_CM,
    gsd_max_cm: float = GSD_TARGET_MAX_CM,
) -> tuple[float, float]:
    """Range di velocita' consigliata (m/s), corrispondente al range di quota consigliato."""
    v_min = recommended_max_speed_ms(gsd_min_cm)
    v_max = recommended_max_speed_ms(gsd_max_cm)
    return v_min, v_max
