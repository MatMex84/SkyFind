"""Modulo 1 - Mission Planner Assistant: calcolo GSD e quota di volo consigliata."""

import sys
from pathlib import Path

import streamlit as st

sys.path.append(str(Path(__file__).resolve().parent.parent))

from modules import mission_planner as mp

st.set_page_config(page_title="Mission Planner - SkyFind", page_icon="🛩️", layout="wide")
st.title("🛩️ Mission Planner Assistant")
st.caption("Calcolo del GSD e della quota di volo consigliata in funzione del sensore utilizzato.")

profiles = mp.load_sensor_profiles()
options = {f"{p.drone} — {p.sensore}": p for p in profiles}

col_left, col_right = st.columns([1, 1])

with col_left:
    st.subheader("1. Selezione drone / sensore")
    choice = st.selectbox("Modello drone e camera", list(options.keys()))
    sensor = options[choice]

    if sensor.is_custom:
        st.markdown("**Parametri sensore personalizzati**")
        sensor_width_mm = st.number_input("Larghezza sensore (mm)", min_value=0.1, value=6.3, step=0.1)
        sensor_height_mm = st.number_input("Altezza sensore (mm)", min_value=0.1, value=4.7, step=0.1)
        focal_length_mm = st.number_input("Lunghezza focale reale (mm)", min_value=0.1, value=4.5, step=0.1)
        image_width_px = st.number_input("Larghezza immagine (px)", min_value=1, value=5280, step=1)
        image_height_px = st.number_input("Altezza immagine (px)", min_value=1, value=3956, step=1)
    else:
        sensor_width_mm = sensor.sensor_width_mm
        sensor_height_mm = sensor.sensor_height_mm
        focal_length_mm = sensor.focal_length_mm
        image_width_px = sensor.image_width_px
        image_height_px = sensor.image_height_px
        st.markdown(
            f"""
            | Parametro | Valore |
            |---|---|
            | Larghezza sensore | {sensor_width_mm} mm |
            | Altezza sensore | {sensor_height_mm} mm |
            | Focale reale | {focal_length_mm} mm |
            | Risoluzione | {image_width_px} x {image_height_px} px |
            """
        )
        if sensor.note:
            st.caption(f"ℹ️ {sensor.note}")

    st.subheader("2. Target GSD")
    gsd_min, gsd_max = st.slider(
        "Range GSD target (cm/px)", min_value=0.2, max_value=5.0,
        value=(mp.GSD_TARGET_MIN_CM, mp.GSD_TARGET_MAX_CM), step=0.1,
    )

with col_right:
    st.subheader("3. Quota di volo consigliata")
    try:
        alt_min, alt_max = mp.recommended_altitude_range(
            sensor_width_mm, focal_length_mm, image_width_px, gsd_min, gsd_max
        )
        c1, c2 = st.columns(2)
        c1.metric(f"Quota min. (GSD {gsd_min:.1f} cm/px)", f"{alt_min:.1f} m AGL")
        c2.metric(f"Quota max. (GSD {gsd_max:.1f} cm/px)", f"{alt_max:.1f} m AGL")
        st.success(
            f"Vola tra **{alt_min:.1f} m** e **{alt_max:.1f} m** AGL per mantenere il GSD "
            f"nell'intervallo {gsd_min:.1f}–{gsd_max:.1f} cm/px."
        )

        st.subheader("4. Verifica quota puntuale")
        altitude_check = st.number_input("Quota di volo da verificare (m AGL)", min_value=1.0, value=float(round((alt_min + alt_max) / 2, 1)), step=1.0)
        gsd_at_altitude = mp.gsd_cm_per_px(altitude_check, sensor_width_mm, focal_length_mm, image_width_px)
        footprint_w, footprint_h = mp.ground_footprint_m(altitude_check, sensor_width_mm, sensor_height_mm, focal_length_mm)
        st.metric("GSD stimato a quota indicata", f"{gsd_at_altitude:.2f} cm/px")
        st.caption(f"Estensione a terra per fotogramma: {footprint_w:.1f} m x {footprint_h:.1f} m")
        if not (gsd_min <= gsd_at_altitude <= gsd_max):
            st.warning("Il GSD a questa quota è fuori dal range target impostato.")
    except ValueError as e:
        st.error(f"Parametri non validi: {e}")

st.divider()
st.subheader("5. Linee guida overlap")
c1, c2 = st.columns(2)
c1.metric("Front Overlap consigliato", f"{mp.FRONT_OVERLAP_MIN}–{mp.FRONT_OVERLAP_MAX}%")
c2.metric("Side Overlap consigliato", f"{mp.SIDE_OVERLAP_MIN}–{mp.SIDE_OVERLAP_MAX}%")
st.caption(
    "Overlap elevato migliora la ricostruzione fotogrammetrica e riduce le zone cieche tra strisciate; "
    "in scenari SAR con vento/turbolenza preferire i valori più alti del range."
)
