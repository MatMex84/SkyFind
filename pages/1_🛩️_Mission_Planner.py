"""Modulo 1 - Mission Planner Assistant: consigli di volo per la flotta drone in uso."""

import sys
from pathlib import Path

import streamlit as st

sys.path.append(str(Path(__file__).resolve().parent.parent))

from modules import mission_planner as mp
from modules import ui

ui.inject_base_style()
ui.sidebar_mission_status()
ui.page_header(
    "🛩️", "Mission Planner Assistant",
    "Seleziona il drone: quota di volo e overlap consigliati sono automatici.",
    module=1,
)

profiles = mp.load_sensor_profiles()
options = {f"{p.drone} — {p.sensore}": p for p in profiles}

choice = st.selectbox("Drone e camera in uso", list(options.keys()))
sensor = options[choice]

if sensor.is_custom:
    st.markdown("**Il tuo drone non è in elenco: inserisci i parametri della camera manualmente.**")
    c1, c2 = st.columns(2)
    with c1:
        sensor_width_mm = st.number_input("Larghezza sensore (mm)", min_value=0.1, value=6.3, step=0.1)
        image_width_px = st.number_input("Larghezza immagine (px)", min_value=1, value=5280, step=1)
    with c2:
        sensor_height_mm = st.number_input("Altezza sensore (mm)", min_value=0.1, value=4.7, step=0.1)
        image_height_px = st.number_input("Altezza immagine (px)", min_value=1, value=3956, step=1)
    focal_length_mm = st.number_input("Lunghezza focale reale (mm, non equivalente)", min_value=0.1, value=4.5, step=0.1)
else:
    sensor_width_mm = sensor.sensor_width_mm
    sensor_height_mm = sensor.sensor_height_mm
    focal_length_mm = sensor.focal_length_mm
    image_width_px = sensor.image_width_px
    image_height_px = sensor.image_height_px
    if "termic" in sensor.sensore.lower():
        st.info("📷 Camera termica: utile per la pianificazione di volo, ma SkyFind individua i target dal colore — usa una camera RGB per la ricerca.")

st.divider()

try:
    alt_min, alt_max = mp.recommended_altitude_range(sensor_width_mm, focal_length_mm, image_width_px)
    footprint_w, footprint_h = mp.ground_footprint_m((alt_min + alt_max) / 2, sensor_width_mm, sensor_height_mm, focal_length_mm)
    max_speed = mp.MAX_PRACTICAL_SPEED_MS

    st.subheader("✅ Consigli per questa missione")
    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Quota di volo consigliata", f"{alt_min:.0f}–{alt_max:.0f} m")
    c2.metric("Overlap frontale", f"{mp.FRONT_OVERLAP_MIN}–{mp.FRONT_OVERLAP_MAX}%")
    c3.metric("Overlap laterale", f"{mp.SIDE_OVERLAP_MIN}–{mp.SIDE_OVERLAP_MAX}%")
    c4.metric("Velocità massima", f"{max_speed:.0f} m/s")

    st.success(
        f"Vola tra **{alt_min:.0f} e {alt_max:.0f} metri** dal suolo (AGL), con **Terrain Following (DSM) attivo** "
        "se il terreno non è pianeggiante — mantiene il GSD costante ed evita collisioni con dislivelli. A questa "
        f"quota ogni fotogramma copre circa **{footprint_w:.0f} x {footprint_h:.0f} m** a terra — utile per stimare "
        "quante strisciate servono per coprire l'area di ricerca."
    )

    st.markdown(
        "**Consigli pratici per lo scatto:**\n\n"
        "- Imposta l'overlap ai valori indicati sopra nel software di pianificazione missione (es. DJI Pilot 2): "
        "front overlap 70-80%, side overlap 60-70%.\n"
        f"- Non superare **{max_speed:.0f} m/s** ({max_speed * 3.6:.0f} km/h) di velocità di crociera: oltre questa "
        "soglia rischi foto mosse e overlap insufficiente. Con poca luce, cielo coperto o vento vola ancora più piano.\n"
        "- Inclinazione camera (gimbal): tra **-75° e -85°** (leggermente obliqua) nella maggior parte dei casi — aiuta a "
        "vedere sotto rami/sporgenze e riduce le ombre nette sul bersaglio. Con vegetazione fitta passa a **-90° "
        "(nadir puro)**, per massimizzare le possibilità di inquadrare un varco nella chioma.\n"
        "- Imposta il **bilanciamento del bianco fisso** (es. Sole ~5500K o Nuvoloso ~6500K), mai automatico: se il "
        "drone passa da erba a roccia con l'AWB attivo, il colore dell'indumento nella foto può spostarsi abbastanza "
        "da uscire dalla tolleranza cromatica calibrata nel modulo 2.\n"
        "- Mantieni la quota costante durante tutta la missione: variazioni di quota cambiano il GSD e possono creare buchi nella copertura.\n"
        "- Vola con luce diffusa quando possibile: ombre nette rendono più difficile il riconoscimento cromatico nel modulo di elaborazione."
    )

    with st.expander("Dettagli tecnici (sensore e calcolo GSD)"):
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
        if not sensor.is_custom and sensor.note:
            st.caption(f"ℹ️ {sensor.note}")
        st.caption(
            f"Range calcolato per un GSD (dettaglio a terra) target di {mp.GSD_TARGET_MIN_CM:.1f}–{mp.GSD_TARGET_MAX_CM:.1f} cm/pixel "
            "(verificato sul dataset SAR accademico Heridal, foto scattate tra 40 e 65m, e sulle specifiche reali della flotta)."
        )
        st.caption(
            f"Velocità massima: tetto operativo prudenziale di {max_speed:.0f} m/s (non solo motion blur — lascia "
            "margine per overlap, vento e affidabilità del rilevamento)."
        )
except ValueError as e:
    st.error(f"Parametri non validi: {e}")
