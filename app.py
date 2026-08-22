"""SkyFind - Analisi immagini aeree da drone per operazioni SAR.

Entry point Streamlit. Le pagine operative si trovano in pages/.
"""

import sys
from pathlib import Path

import streamlit as st

sys.path.append(str(Path(__file__).resolve().parent))

from modules import ui

st.set_page_config(page_title="SkyFind", page_icon="🛰️", layout="wide")


def home_page() -> None:
    ui.inject_base_style()
    ui.sidebar_mission_status()

    ui.page_header(
        "🛰️",
        "SkyFind",
        "Ricerca colore da immagini drone (SAR) — individuazione rapida di indumenti o "
        "target tramite filtraggio cromatico su immagini aeree, dalla pianificazione al report finale.",
    )

    st.markdown("Usa il menu a sinistra per navigare tra i moduli, in ordine:")

    c1, c2 = st.columns(2)
    with c1:
        with st.container(border=True):
            st.markdown("**🛩️ 1 · Mission Planner**")
            st.caption("Consigli su quota di volo e overlap in base al drone in uso.")
        with st.container(border=True):
            st.markdown("**📷 3 · Elaborazione Batch**")
            st.caption("Applica il profilo alle foto di missione (ottimizzato per centinaia di foto 4K) ed estrae i target.")
    with c2:
        with st.container(border=True):
            st.markdown("**🎨 2 · Calibrazione Colore**")
            st.caption("Estrazione del profilo colore dal campione target.")
        with st.container(border=True):
            st.markdown("**📋 4 · Report**")
            st.caption("Ritagli dei target rilevati, coordinate GPS e confidenza cromatica, esportabile in HTML/CSV.")

    st.success("Tutti e 4 i moduli sono operativi. Segui l'ordine sopra per una missione completa.")


pages = [
    st.Page(home_page, title="SkyFind", icon="🛰️", url_path="Home", default=True),
    st.Page("pages/1_🛩️_Mission_Planner.py", title="Mission Planner", icon="🛩️", url_path="Mission_Planner"),
    st.Page("pages/2_🎨_Calibrazione_Colore.py", title="Calibrazione Colore", icon="🎨", url_path="Calibrazione_Colore"),
    st.Page("pages/3_📷_Elaborazione_Batch.py", title="Elaborazione Batch", icon="📷", url_path="Elaborazione_Batch"),
    st.Page("pages/4_📋_Report.py", title="Report", icon="📋", url_path="Report"),
]

ui.sidebar_brand()
nav = st.navigation(pages, position="sidebar")
nav.run()
