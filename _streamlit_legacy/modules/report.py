"""Generazione del report visuale (HTML autonomo) con i target rilevati."""

from __future__ import annotations

import base64
import csv
import html
import io
from pathlib import Path

from .image_processing import ImageResult


def _fmt_gps(lat: float | None, lon: float | None) -> str:
    if lat is None or lon is None:
        return "GPS non disponibile"
    return f"{lat:.6f}, {lon:.6f}"


def _maps_link(lat: float, lon: float) -> str:
    return f"https://www.google.com/maps?q={lat:.6f},{lon:.6f}"


def build_html_report(results: list[ImageResult], profile_name: str, min_confidence: float = 0.0) -> str:
    """Costruisce un report HTML autonomo (ritagli incorporati come base64, nessuna dipendenza esterna)."""
    filtered = [
        (r, [d for d in r.detections if d.confidence >= min_confidence])
        for r in results
    ]
    filtered = [(r, dets) for r, dets in filtered if dets]

    total_detections = sum(len(dets) for _, dets in filtered)
    photos_with_match = len(filtered)

    cards = []
    for r, dets in filtered:
        gps_txt = _fmt_gps(r.gps_lat, r.gps_lon)
        maps_html = ""
        if r.gps_lat is not None and r.gps_lon is not None:
            maps_html = f' — <a href="{_maps_link(r.gps_lat, r.gps_lon)}" target="_blank" rel="noopener">apri in mappa</a>'

        det_cards = []
        for d in dets:
            img_b64 = base64.b64encode(d.crop_jpeg).decode("ascii")
            x, y, w, h = d.bbox
            det_cards.append(
                f"""
            <div class="det-card">
                <img src="data:image/jpeg;base64,{img_b64}" alt="target rilevato" />
                <div class="det-meta">
                    <div><strong>Confidenza:</strong> {d.confidence:.1f}%</div>
                    <div><strong>Copertura area:</strong> {d.fill_ratio:.1f}%</div>
                    <div><strong>Bounding box:</strong> x={x} y={y} w={w} h={h}</div>
                </div>
            </div>"""
            )

        cards.append(
            f"""
        <section class="photo-card">
            <h3>{html.escape(Path(r.path).name)}</h3>
            <div class="photo-meta">
                <span>📍 {gps_txt}{maps_html}</span>
                <span>🕒 {html.escape(r.datetime_original or "n/d")}</span>
                <span>{len(dets)} rilevamento/i</span>
            </div>
            <div class="det-grid">{"".join(det_cards)}</div>
        </section>"""
        )

    css = """
    body { font-family: system-ui, sans-serif; margin: 2rem; background:#0e1117; color:#e6e6e6; }
    h1 { margin-bottom: 0.2rem; }
    .summary { color:#9aa0a6; margin-bottom: 2rem; }
    .photo-card { border:1px solid #333; border-radius:10px; padding:1rem; margin-bottom:1.5rem; background:#161b22; }
    .photo-meta { display:flex; flex-wrap:wrap; gap:1.5rem; color:#9aa0a6; font-size:0.9rem; margin-bottom:0.8rem; }
    .photo-meta a { color:#6ea8fe; }
    .det-grid { display:flex; flex-wrap:wrap; gap:1rem; }
    .det-card { width:220px; border:1px solid #333; border-radius:8px; overflow:hidden; background:#0e1117; }
    .det-card img { width:100%; display:block; }
    .det-meta { padding:0.5rem; font-size:0.85rem; }
    """

    body = "".join(cards) if cards else "<p>Nessun rilevamento sopra la soglia di confidenza scelta.</p>"

    return f"""<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8" />
<title>Report SkyFind</title>
<style>{css}</style>
</head>
<body>
<h1>🛰️ Report rilevamenti — SkyFind</h1>
<div class="summary">
    Profilo colore: <strong>{html.escape(profile_name)}</strong> —
    {len(results)} foto analizzate, {photos_with_match} con rilevamenti, {total_detections} target individuati (soglia confidenza ≥ {min_confidence:.0f}%).
</div>
{body}
</body>
</html>"""


def build_csv_report(results: list[ImageResult], min_confidence: float = 0.0) -> str:
    """Esporta i rilevamenti in CSV: una riga per target individuato."""
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["foto", "gps_lat", "gps_lon", "gps_altitude_m", "data_ora", "bbox_x", "bbox_y", "bbox_w", "bbox_h", "confidenza_%", "copertura_area_%"])
    for r in results:
        for d in r.detections:
            if d.confidence < min_confidence:
                continue
            x, y, w, h = d.bbox
            writer.writerow(
                [Path(r.path).name, r.gps_lat, r.gps_lon, r.gps_altitude, r.datetime_original, x, y, w, h, d.confidence, d.fill_ratio]
            )
    return buf.getvalue()
