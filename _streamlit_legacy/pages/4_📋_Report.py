"""Modulo 4 - Output e Visualizzazione: report dei target rilevati."""

import sys
from pathlib import Path

import streamlit as st

sys.path.append(str(Path(__file__).resolve().parent.parent))

from modules import report as rpt
from modules import ui

ui.inject_base_style()
ui.sidebar_mission_status()
ui.page_header("📋", "Report Rilevamenti", module=4)

results = st.session_state.get("batch_results")
if not results:
    st.info("Nessun risultato disponibile. Esegui prima il modulo **📷 Elaborazione Batch**.")
    st.stop()

profile_name = st.session_state.get("batch_profile_name", "n/d")
total_detections = sum(len(r.detections) for r in results)

st.caption(f"Profilo colore usato: **{profile_name}** — {len(results)} foto analizzate, {total_detections} target individuati.")

min_confidence = st.slider(
    "Confidenza minima da mostrare (%)", 0, 100, 0,
    help="0 = mostra tutti i rilevamenti trovati dall'elaborazione batch. Alza la soglia solo se vuoi "
    "nascondere i rilevamenti meno somiglianti al colore calibrato (più falsi positivi esclusi, ma rischi "
    "di nascondere anche target reali fotografati con luce/ombra diversa).",
)

filtered = [(r, [d for d in r.detections if d.confidence >= min_confidence]) for r in results]
filtered = [(r, dets) for r, dets in filtered if dets]

m1, m2 = st.columns(2)
m1.metric("Foto con rilevamenti (sopra soglia)", len(filtered))
m2.metric("Target mostrati", sum(len(dets) for _, dets in filtered))

st.divider()

if not filtered:
    st.warning("Nessun rilevamento sopra la soglia di confidenza scelta. Prova ad abbassare il cursore qui sopra.")
else:
    for r, dets in sorted(filtered, key=lambda t: -max(d.confidence for d in t[1])):
        gps_txt = (
            f"📍 [{r.gps_lat:.6f}, {r.gps_lon:.6f}](https://www.google.com/maps?q={r.gps_lat:.6f},{r.gps_lon:.6f})"
            if r.gps_lat is not None
            else "📍 GPS non disponibile"
        )
        with st.expander(f"{Path(r.path).name} — {len(dets)} rilevamento/i", expanded=False):
            st.markdown(f"{gps_txt}  ·  🕒 {r.datetime_original or 'n/d'}")
            cols = st.columns(min(4, len(dets)))
            for i, d in enumerate(sorted(dets, key=lambda d: -d.confidence)):
                with cols[i % len(cols)]:
                    st.image(d.crop_jpeg, use_container_width=True)
                    st.caption(f"Confidenza: {d.confidence:.1f}% · Area: {d.fill_ratio:.1f}%")
                    x, y, w, h = d.bbox
                    st.caption(f"bbox: x={x} y={y} w={w} h={h}")

st.divider()
st.subheader("Esporta report")
c1, c2 = st.columns(2)
with c1:
    html_report = rpt.build_html_report(results, profile_name, min_confidence)
    st.download_button(
        "⬇️ Scarica report HTML",
        data=html_report,
        file_name="skyfind_report.html",
        mime="text/html",
    )
with c2:
    csv_report = rpt.build_csv_report(results, min_confidence)
    st.download_button(
        "⬇️ Scarica CSV rilevamenti",
        data=csv_report,
        file_name="skyfind_detections.csv",
        mime="text/csv",
    )
