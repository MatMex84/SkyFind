"""Modulo 3 - Elaborazione Immagini: mascheratura colore batch su foto di missione."""

import os
import sys
import tempfile
import time
from pathlib import Path

import streamlit as st

sys.path.append(str(Path(__file__).resolve().parent.parent))

from modules import color_calibration as cc
from modules import image_processing as ip

st.set_page_config(page_title="Elaborazione Batch - SkyFind", page_icon="📷", layout="wide")
st.title("📷 Elaborazione Batch")
st.caption("Applica il profilo colore calibrato a un lotto di foto di missione ed estrae i target rilevati.")

saved_profiles = cc.list_saved_profiles()
if not saved_profiles:
    st.warning("Nessun profilo colore salvato. Vai prima al modulo **🎨 Calibrazione Colore** per crearne uno.")
    st.stop()

st.subheader("1. Profilo colore")
profile_paths = {p.stem: p for p in saved_profiles}
profile_name = st.selectbox("Profilo da usare per il rilevamento", list(profile_paths.keys()))
profile = cc.load_profile(profile_paths[profile_name])

c1, c2 = st.columns(2)
c1.caption(f"HSV medio: {profile.mean_hsv} · tolleranza {profile.tolerance_hsv}")
c2.caption(f"LAB medio: {profile.mean_lab} · tolleranza {profile.tolerance_lab}")

st.subheader("2. Sorgente immagini")
st.info(
    "Per lotti di centinaia di foto 4K usa la **cartella locale**: legge i file direttamente dal disco "
    "senza trasferirli nel browser, molto più veloce e leggero del caricamento manuale."
)
source_mode = st.radio("Sorgente", ["Cartella locale (consigliato)", "Carica file (pochi scatti)"], horizontal=True)

image_paths: list[Path] = []
if source_mode.startswith("Cartella"):
    folder = st.text_input("Percorso cartella con le foto di missione", value="")
    if folder:
        try:
            image_paths = ip.list_images(folder)
            st.success(f"{len(image_paths)} foto trovate in `{folder}`.")
        except NotADirectoryError as e:
            st.error(str(e))
else:
    uploaded_files = st.file_uploader(
        "Foto di missione", type=["jpg", "jpeg", "png", "tif", "tiff"], accept_multiple_files=True
    )
    if uploaded_files:
        tmp_dir = Path(tempfile.gettempdir()) / "skyfind_upload"
        tmp_dir.mkdir(exist_ok=True)
        for f in uploaded_files:
            dest = tmp_dir / f.name
            with open(dest, "wb") as out:
                out.write(f.getbuffer())
            image_paths.append(dest)
        st.success(f"{len(image_paths)} foto caricate.")

st.subheader("3. Parametri di rilevamento")
c1, c2, c3 = st.columns(3)
with c1:
    color_space = st.selectbox("Spazio colore per la maschera", ["hsv", "lab", "both"], help="'both' = HSV AND LAB, più selettivo (meno falsi positivi)")
    require_gps = st.checkbox("Scarta foto senza GPS", value=False)
with c2:
    downscale_max_dim = st.slider("Lato max per rilevamento veloce (px)", 800, 3000, 1600, step=100)
    min_area_px = st.number_input("Area minima target (px², a piena risoluzione)", min_value=10, value=400, step=10)
with c3:
    morph_kernel = st.slider("Kernel pulizia morfologica (px)", 3, 25, 5, step=2)
    max_detections = st.slider("Max rilevamenti per foto", 1, 20, 8)

max_workers_default = min(8, os.cpu_count() or 4)
max_workers = st.slider("Worker paralleli (thread)", 1, max(1, os.cpu_count() or 4), max_workers_default)

st.subheader("4. Avvia elaborazione")
if not image_paths:
    st.info("Indica una cartella o carica delle foto per procedere.")
    st.stop()

if st.button("▶️ Avvia elaborazione batch", type="primary"):
    config = ip.ProcessingConfig(
        color_space=color_space,
        downscale_max_dim=downscale_max_dim,
        min_area_px_fullres=int(min_area_px),
        morph_kernel=morph_kernel,
        max_detections_per_image=max_detections,
        require_gps=require_gps,
    )

    progress_bar = st.progress(0.0)
    status = st.empty()
    results = []
    start = time.perf_counter()

    for i, result in enumerate(ip.process_batch(image_paths, profile, config, max_workers=max_workers), 1):
        results.append(result)
        progress_bar.progress(i / len(image_paths))
        n_matches = sum(1 for r in results if r.detections)
        status.text(f"{i}/{len(image_paths)} foto elaborate — {n_matches} con rilevamenti")

    elapsed = time.perf_counter() - start
    st.session_state["batch_results"] = results
    st.session_state["batch_profile_name"] = profile_name

    total_detections = sum(len(r.detections) for r in results)
    errors = [r for r in results if r.error]
    skipped = [r for r in results if r.skipped_reason]

    st.success(f"Elaborazione completata in {elapsed:.1f}s ({len(image_paths) / elapsed:.1f} foto/s).")
    m1, m2, m3, m4 = st.columns(4)
    m1.metric("Foto elaborate", len(results))
    m2.metric("Foto con rilevamenti", sum(1 for r in results if r.detections))
    m3.metric("Target individuati", total_detections)
    m4.metric("Scartate/errori", len(skipped) + len(errors))

    if errors:
        with st.expander(f"⚠️ {len(errors)} foto con errori di lettura"):
            for r in errors:
                st.text(f"{r.path}: {r.error}")

    st.info("Vai al modulo **📋 Report** per vedere i ritagli, le coordinate e generare il report finale.")
