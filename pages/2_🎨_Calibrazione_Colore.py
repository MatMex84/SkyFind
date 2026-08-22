"""Modulo 2 - Estrazione e calibrazione del profilo colore del campione target.

Selezione rapida del colore in due modalita' (contagocce su foto o palette),
un solo cursore di tolleranza (1-5) con anteprima live di quanto si allarga
il range verso lo scuro/chiaro: nessun parametro tecnico da impostare a mano.
"""

import sys
from pathlib import Path

import cv2
import numpy as np
import streamlit as st
from PIL import Image

sys.path.append(str(Path(__file__).resolve().parent.parent))

from modules import color_calibration as cc
from modules import ui
from modules.pan_zoom_picker import pan_zoom_picker

ui.inject_base_style()
ui.sidebar_mission_status()
ui.page_header(
    "🎨", "Calibrazione Colore Campione",
    "Scegli il colore del target col contagocce su una foto oppure da una palette. Il resto è automatico.",
    module=2,
)

MAX_DISPLAY_WIDTH = 640
PATCH_HALF = 4  # patch campionata: (2*PATCH_HALF+1) x (2*PATCH_HALF+1) px attorno al click


mode = st.radio(
    "Come vuoi selezionare il colore del target?",
    ["📷 Contagocce su una foto", "🎨 Palette colore"],
    horizontal=True,
)

patch_bgr = None
sample_source = ""
point_caption = ""

if mode.startswith("📷"):
    uploaded = st.file_uploader("Foto del target (es. l'indumento)", type=["jpg", "jpeg", "png", "bmp"])
    if uploaded is None:
        st.info("Carica una foto del target, poi clicca sul punto esatto del colore da usare (contagocce).")
        st.stop()

    pil_image = Image.open(uploaded).convert("RGB")
    image_rgb = np.array(pil_image)
    image_bgr = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)
    h_img, w_img = image_bgr.shape[:2]

    st.caption("🖱️ Trascina la foto per spostarti, usa **+ / −** per ingrandire, clicca per scegliere il colore del target.")
    result = pan_zoom_picker(
        image_rgb, image_id=uploaded.file_id, display_width=MAX_DISPLAY_WIDTH, key="sf_pan_zoom",
    )

    if result is None:
        st.info("👆 Clicca sulla foto qui sopra, esattamente sul colore del target, per selezionarlo.")
        st.stop()

    real_x, real_y = result["x"], result["y"]

    try:
        patch_bgr = cc.extract_roi(
            image_bgr,
            (real_x - PATCH_HALF, real_y - PATCH_HALF, 2 * PATCH_HALF + 1, 2 * PATCH_HALF + 1),
        )
    except ValueError:
        patch_bgr = image_bgr[real_y:real_y + 1, real_x:real_x + 1]

    sample_source = uploaded.name
    point_caption = f"Punto selezionato: x={real_x}, y={real_y} (immagine {w_img}x{h_img} px)"

else:
    hex_color = st.color_picker("Scegli il colore del target", value="#c82828")
    rgb = tuple(int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    patch_bgr = np.full((2 * PATCH_HALF + 1, 2 * PATCH_HALF + 1, 3), rgb[::-1], dtype=np.uint8)
    sample_source = "palette"
    point_caption = "Colore scelto dalla palette"

st.divider()

col_left, col_right = st.columns([1, 1])

with col_left:
    st.subheader("Colore selezionato")
    picked_hex = "#%02x%02x%02x" % tuple(int(c) for c in patch_bgr.reshape(-1, 3).mean(axis=0)[::-1])
    st.markdown(
        f'<div style="background-color:{picked_hex};height:90px;border-radius:10px;'
        f'border:1px solid rgba(255,255,255,0.15);"></div>',
        unsafe_allow_html=True,
    )
    st.caption(f"{point_caption} · {picked_hex}")

    profile_name = st.text_input("Nome profilo", value="target_1")

with col_right:
    st.subheader("Tolleranza")
    tolerance_level = st.select_slider(
        "Quanto deve essere permissivo il riconoscimento del colore?",
        options=[1, 2, 3, 4, 5],
        value=cc.DEFAULT_TOLERANCE_LEVEL,
        format_func=lambda v: cc.TOLERANCE_LEVEL_LABELS[v],
    )
    st.caption("Bassa = colore molto specifico (meno falsi positivi). Alta = copre più ombre/esposizioni diverse.")

tol_hsv = cc.TOLERANCE_LEVEL_HSV[tolerance_level]
tol_lab = cc.TOLERANCE_LEVEL_LAB[tolerance_level]

profile = cc.compute_color_profile(
    patch_bgr, name=profile_name, roi=None, k=1,
    tolerance_hsv=tol_hsv, tolerance_lab=tol_lab, sample_source=sample_source,
)

st.subheader("Anteprima tolleranza")
st.caption("Il range di colore ancora riconosciuto, dal più scuro al più chiaro, aumentando la tolleranza:")
l0, a0, b0 = profile.mean_lab
tol_l = profile.tolerance_lab[0]
steps = np.linspace(-1.0, 1.0, 7)
swatch_cols = st.columns(7)
for frac, col in zip(steps, swatch_cols):
    hex_i = cc.lab_to_hex(l0 + frac * tol_l, a0, b0)
    with col:
        st.markdown(
            f'<div style="background-color:{hex_i};height:46px;border-radius:6px;'
            f'border:1px solid rgba(255,255,255,0.15);"></div>',
            unsafe_allow_html=True,
        )
c1, c2, c3 = st.columns(3)
c1.caption("⬅ più scuro")
c2.caption("colore scelto (centro)")
c3.caption("più chiaro ➡")

with st.expander("Dettagli tecnici (HSV / CIE-LAB)"):
    d1, d2 = st.columns(2)
    with d1:
        st.markdown("**Colore medio HSV**")
        st.code(f"H={profile.mean_hsv[0]}  S={profile.mean_hsv[1]}  V={profile.mean_hsv[2]}")
        lower_hsv, upper_hsv = profile.hsv_bounds()
        st.caption(f"Range maschera cv2.inRange (HSV): {lower_hsv.tolist()} → {upper_hsv.tolist()}")
    with d2:
        st.markdown("**Colore medio CIE-LAB**")
        st.code(f"L={profile.mean_lab[0]}  a={profile.mean_lab[1]}  b={profile.mean_lab[2]}")
        lower_lab, upper_lab = profile.lab_bounds()
        st.caption(f"Range maschera cv2.inRange (LAB): {lower_lab.tolist()} → {upper_lab.tolist()}")

if st.button("💾 Salva profilo", type="primary"):
    path = cc.save_profile(profile)
    st.success(f"Profilo salvato in `{path}`. Sarà riutilizzabile dal modulo di elaborazione immagini.")

saved = cc.list_saved_profiles()
if saved:
    st.divider()
    st.subheader("Profili salvati")
    pills = " ".join(
        f'<span class="sf-module-pill" style="color:#e6e6e6;border-color:rgba(255,255,255,0.15);'
        f'background:rgba(255,255,255,0.04);">📄 {p.stem}</span>'
        for p in saved
    )
    st.markdown(pills, unsafe_allow_html=True)
