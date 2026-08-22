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
from modules import ui

ui.inject_base_style()
ui.sidebar_mission_status()
ui.page_header(
    "📷", "Elaborazione Batch",
    "Applica il profilo colore calibrato a un lotto di foto di missione ed estrae i target rilevati.",
    module=3,
)

DETECTION_MODE_LABELS = {
    "hsv": "⚡ Standard (veloce)",
    "lab": "🌤️ Robusto a ombre e controluce",
    "both": "🎯 Massima precisione (più lento, meno falsi positivi)",
}


def _browse_folder() -> str:
    """Apre il selettore cartelle nativo del sistema (l'app gira in locale sulla stessa macchina)."""
    try:
        import tkinter as tk
        from tkinter import filedialog

        root = tk.Tk()
        root.withdraw()
        root.attributes("-topmost", True)
        path = filedialog.askdirectory(title="Seleziona la cartella con le foto di missione")
        root.destroy()
        return path
    except Exception:
        return ""


saved_profiles = cc.list_saved_profiles()
if not saved_profiles:
    st.warning("Nessun profilo colore salvato. Vai prima al modulo **🎨 Calibrazione Colore** per crearne uno.")
    st.stop()

st.subheader("1. Profilo colore")
profile_paths = {p.stem: p for p in saved_profiles}
profile_name = st.selectbox("Profilo da usare per il rilevamento", list(profile_paths.keys()))
profile = cc.load_profile(profile_paths[profile_name])

swatch_col, label_col = st.columns([1, 8])
with swatch_col:
    st.markdown(
        f'<div style="background-color:{cc.profile_hex_color(profile)};height:36px;border-radius:6px;'
        f'border:1px solid rgba(255,255,255,0.15);"></div>',
        unsafe_allow_html=True,
    )
with label_col:
    st.caption(f"Colore target del profilo **{profile_name}**")

st.subheader("2. Sorgente immagini")
st.info(
    "Per lotti di centinaia di foto 4K usa la **cartella locale**: legge i file direttamente dal disco "
    "senza trasferirli nel browser, molto più veloce e leggero del caricamento manuale."
)
source_mode = st.radio("Sorgente", ["Cartella locale (consigliato)", "Carica file (pochi scatti)"], horizontal=True)

image_paths: list[Path] = []
if source_mode.startswith("Cartella"):
    if "sf_batch_folder" not in st.session_state:
        st.session_state["sf_batch_folder"] = ""

    col_path, col_browse = st.columns([5, 1])
    with col_browse:
        st.markdown("<div style='height:1.7rem'></div>", unsafe_allow_html=True)
        if st.button("📂 Sfoglia..."):
            picked = _browse_folder()
            if picked:
                st.session_state["sf_batch_folder"] = picked
                st.rerun()
    with col_path:
        folder = st.text_input(
            "Percorso cartella con le foto di missione", key="sf_batch_folder",
            help="Clicca \"Sfoglia...\" per aprire la finestra di selezione cartella, oppure incolla il percorso.",
        )

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

st.subheader("3. Modalità di rilevamento")
c1, c2 = st.columns(2)
with c1:
    detection_mode = st.select_slider(
        "Come cercare il colore nelle foto?",
        options=["hsv", "lab", "both"],
        value="hsv",
        format_func=lambda v: DETECTION_MODE_LABELS[v],
    )
with c2:
    require_gps = st.checkbox("Scarta foto senza posizione GPS", value=False)
    st.caption("Utile se vuoi solo target georiferiti sulla mappa nel report finale.")

with st.expander("⚙️ Impostazioni avanzate (valori di default già ottimizzati)"):
    a1, a2, a3 = st.columns(3)
    with a1:
        downscale_max_dim = st.slider("Lato max per rilevamento veloce (px)", 800, 3000, 1600, step=100)
        min_area_px = st.number_input("Area minima target (px², a piena risoluzione)", min_value=10, value=400, step=10)
    with a2:
        morph_kernel = st.slider("Pulizia forma rilevamento (px)", 3, 25, 5, step=2)
        max_detections = st.slider("Max rilevamenti per foto", 1, 20, 8)
    with a3:
        max_workers_default = min(8, os.cpu_count() or 4)
        max_workers = st.slider("Foto elaborate in parallelo", 1, max(1, os.cpu_count() or 4), max_workers_default)

st.subheader("4. Avvia elaborazione")
if not image_paths:
    st.info("Indica una cartella o carica delle foto per procedere.")
    st.stop()

if st.button("▶️ Avvia elaborazione batch", type="primary"):
    config = ip.ProcessingConfig(
        color_space=detection_mode,
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
