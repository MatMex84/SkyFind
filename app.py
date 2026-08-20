"""SkyFind - Analisi immagini aeree da drone per operazioni SAR.

Entry point Streamlit. Le pagine operative si trovano in pages/.
"""

import streamlit as st

st.set_page_config(page_title="SkyFind", page_icon="🛰️", layout="wide")

st.title("🛰️ SkyFind — Ricerca colore da immagini drone (SAR)")

st.markdown(
    """
Strumento per la pianificazione di missioni SAPR e l'individuazione rapida
di indumenti o target tramite filtraggio cromatico su immagini aeree.

Usa il menu a sinistra per navigare tra i moduli, in ordine:

1. **🛩️ Mission Planner** — calcolo GSD, quota di volo consigliata e overlap.
2. **🎨 Calibrazione Colore** — estrazione del profilo colore dal campione target.
3. **📷 Elaborazione Batch** — applica il profilo alle foto di missione (ottimizzato per centinaia di foto 4K) ed estrae i target.
4. **📋 Report** — ritagli dei target rilevati, coordinate GPS e confidenza cromatica, esportabile in HTML/CSV.
"""
)

st.info("Tutti e 4 i moduli sono operativi. Segui l'ordine sopra per una missione completa.")
