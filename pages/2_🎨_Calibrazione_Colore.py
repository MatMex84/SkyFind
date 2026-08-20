"""Modulo 2 - Estrazione e calibrazione del profilo colore del campione target."""

import sys
from pathlib import Path

import cv2
import numpy as np
import streamlit as st
from PIL import Image

sys.path.append(str(Path(__file__).resolve().parent.parent))

from modules import color_calibration as cc

st.set_page_config(page_title="Calibrazione Colore - SkyFind", page_icon="🎨", layout="wide")
st.title("🎨 Calibrazione Colore Campione")
st.caption("Carica una foto dell'indumento/target e ricava il profilo colore (HSV + CIE-LAB) da usare nel filtraggio.")

uploaded = st.file_uploader("Immagine campione", type=["jpg", "jpeg", "png", "bmp"])

if uploaded is None:
    st.info("Carica un'immagine del target (es. foto dell'indumento, anche uno scatto di prova) per iniziare.")
    st.stop()

pil_image = Image.open(uploaded).convert("RGB")
image_rgb = np.array(pil_image)
image_bgr = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2BGR)
h_img, w_img = image_bgr.shape[:2]

col_left, col_right = st.columns([1, 1])

with col_left:
    st.subheader("1. Selezione ROI (crop manuale)")
    use_roi = st.checkbox("Ritaglia una regione (ROI) invece di usare l'intera immagine", value=(max(h_img, w_img) > 200))

    roi = None
    if use_roi:
        x = st.slider("X iniziale", 0, max(w_img - 1, 0), 0)
        y = st.slider("Y iniziale", 0, max(h_img - 1, 0), 0)
        w = st.slider("Larghezza ROI", 1, w_img - x, min(w_img - x, w_img))
        h = st.slider("Altezza ROI", 1, h_img - y, min(h_img - y, h_img))
        roi = (x, y, w, h)
        preview = image_rgb[y:y + h, x:x + w]
        st.image(preview, caption="Anteprima ROI selezionata", use_container_width=True)
    else:
        st.image(image_rgb, caption="Immagine campione completa", use_container_width=True)

    st.subheader("2. Parametri estrazione")
    k_colors = st.slider("Numero colori dominanti (k-means)", 1, 6, 3)
    profile_name = st.text_input("Nome profilo", value="target_1")

with col_right:
    st.subheader("3. Tolleranza colore (regolabile)")
    st.markdown("**Spazio HSV** (H: tonalità 0-179, S: saturazione, V: luminosità)")
    tol_h = st.slider("Tolleranza H", 0, 90, 10)
    tol_s = st.slider("Tolleranza S", 0, 128, 60)
    tol_v = st.slider("Tolleranza V", 0, 128, 60)

    st.markdown("**Spazio CIE-LAB** (L: luminosità, a/b: componenti cromatiche — più robusto a ombre/esposizione)")
    tol_l = st.slider("Tolleranza L", 0, 128, 15)
    tol_a = st.slider("Tolleranza a", 0, 128, 15)
    tol_b = st.slider("Tolleranza b", 0, 128, 15)

    if st.button("🔍 Estrai profilo colore", type="primary"):
        profile = cc.compute_color_profile(
            image_bgr,
            name=profile_name,
            roi=roi,
            k=k_colors,
            tolerance_hsv=(tol_h, tol_s, tol_v),
            tolerance_lab=(tol_l, tol_a, tol_b),
            sample_source=uploaded.name,
        )
        st.session_state["color_profile"] = profile

if "color_profile" in st.session_state:
    profile = st.session_state["color_profile"]
    st.divider()
    st.subheader("4. Profilo colore estratto")

    c1, c2 = st.columns(2)
    with c1:
        st.markdown("**Colore medio HSV**")
        st.code(f"H={profile.mean_hsv[0]}  S={profile.mean_hsv[1]}  V={profile.mean_hsv[2]}")
        lower_hsv, upper_hsv = profile.hsv_bounds()
        st.caption(f"Range maschera cv2.inRange (HSV): {lower_hsv.tolist()} → {upper_hsv.tolist()}")
    with c2:
        st.markdown("**Colore medio CIE-LAB**")
        st.code(f"L={profile.mean_lab[0]}  a={profile.mean_lab[1]}  b={profile.mean_lab[2]}")
        lower_lab, upper_lab = profile.lab_bounds()
        st.caption(f"Range maschera cv2.inRange (LAB): {lower_lab.tolist()} → {upper_lab.tolist()}")

    st.markdown("**Palette colori dominanti (k-means, in ordine di frequenza)**")
    swatch_cols = st.columns(len(profile.dominant_hsv))
    for i, (hsv_center, col) in enumerate(zip(profile.dominant_hsv, swatch_cols)):
        swatch_hsv = np.uint8([[hsv_center]])
        swatch_bgr = cv2.cvtColor(swatch_hsv, cv2.COLOR_HSV2BGR)[0][0]
        swatch_rgb = swatch_bgr[::-1]
        hex_color = "#%02x%02x%02x" % tuple(int(c) for c in swatch_rgb)
        with col:
            st.markdown(
                f'<div style="background-color:{hex_color};height:60px;border-radius:6px;'
                f'border:1px solid #999;"></div>',
                unsafe_allow_html=True,
            )
            st.caption(hex_color)

    if st.button("💾 Salva profilo"):
        path = cc.save_profile(profile)
        st.success(f"Profilo salvato in `{path}`. Sarà riutilizzabile dal modulo di elaborazione immagini.")

saved = cc.list_saved_profiles()
if saved:
    st.divider()
    st.subheader("Profili salvati")
    for p in saved:
        st.write(f"📄 {p.name}")
