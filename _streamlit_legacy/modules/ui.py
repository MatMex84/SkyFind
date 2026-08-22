"""Componenti UI condivisi tra le pagine: tema, header di modulo, branding sidebar.

Centralizza qui lo stile per mantenere coerenza visiva tra i 4 moduli senza
duplicare CSS in ogni pagina. La palette ricalca quella del report HTML
esportato (``modules/report.py``), cosi' l'app live e il report scaricato
condividono lo stesso linguaggio visivo.
"""

from __future__ import annotations

from pathlib import Path

import streamlit as st

ASSETS_DIR = Path(__file__).resolve().parent.parent / "assets"

ACCENT = "#6EA8FE"       # blu cielo — brand primario, navigazione/pianificazione
ACCENT_WARM = "#F5A623"  # ambra — rilevamenti/target (alta visibilita', come le divise SAR)
BORDER = "rgba(255,255,255,0.08)"
MUTED = "#9aa0a6"


def inject_base_style() -> None:
    """CSS condiviso: badge modulo, header, card, metriche. Da chiamare a inizio pagina."""
    st.markdown(
        f"""
        <style>
        .sf-module-pill {{
            display:inline-flex; align-items:center; gap:0.4rem;
            background:rgba(110,168,254,0.13); color:{ACCENT};
            border:1px solid rgba(110,168,254,0.35);
            border-radius:999px; padding:0.15rem 0.75rem; font-size:0.78rem;
            font-weight:600; letter-spacing:0.04em; margin-bottom:0.7rem;
        }}
        .sf-header {{ display:flex; align-items:center; gap:0.9rem; margin-bottom:0.1rem; }}
        .sf-header .sf-icon {{
            display:flex; align-items:center; justify-content:center; flex-shrink:0;
            width:52px; height:52px; border-radius:14px; font-size:1.6rem;
            background:linear-gradient(135deg, rgba(110,168,254,0.20), rgba(245,166,35,0.14));
            border:1px solid {BORDER};
        }}
        .sf-header h1 {{ margin:0; line-height:1.15; font-size:2rem; }}
        .sf-subtitle {{ color:{MUTED}; margin-top:0.35rem; margin-bottom:1.3rem; max-width:70ch; }}
        .sf-divider {{
            height:3px; border-radius:3px; margin:0.5rem 0 1.6rem 0; max-width:420px;
            background:linear-gradient(90deg, {ACCENT}, {ACCENT_WARM}, transparent);
        }}

        div[data-testid="stMetric"] {{
            background:rgba(255,255,255,0.03);
            border:1px solid {BORDER}; border-radius:10px;
            padding:0.75rem 0.7rem 0.55rem 0.7rem;
        }}
        div[data-testid="stMetric"] label[data-testid="stMetricLabel"],
        div[data-testid="stMetric"] label[data-testid="stMetricLabel"] > div,
        div[data-testid="stMetric"] label[data-testid="stMetricLabel"] p,
        div[data-testid="stMetric"] [data-testid="stMetricValue"],
        div[data-testid="stMetric"] [data-testid="stMetricValue"] div,
        div[data-testid="stMetric"] [data-testid="stMetricValue"] p {{
            white-space:normal !important; overflow:visible !important;
            text-overflow:clip !important; line-height:1.25;
        }}

        button[kind="primary"] {{ box-shadow:0 2px 12px rgba(110,168,254,0.25); }}

        section[data-testid="stSidebar"] {{ border-right:1px solid {BORDER}; }}
        .sf-sidebar-tagline {{
            color:{MUTED}; font-size:0.8rem; margin-top:-0.6rem; margin-bottom:1rem;
        }}
        .sf-status-row {{
            display:flex; align-items:center; gap:0.5rem; font-size:0.82rem;
            padding:0.2rem 0; color:{MUTED};
        }}
        .sf-status-dot {{
            width:8px; height:8px; border-radius:50%; flex-shrink:0;
            background:#4a4f57;
        }}
        .sf-status-dot.done {{ background:{ACCENT_WARM}; }}
        .sf-status-row.done {{ color:{MUTED}; }}
        </style>
        """,
        unsafe_allow_html=True,
    )


def page_header(icon: str, title: str, subtitle: str = "", module: int | None = None, total_modules: int = 4) -> None:
    """Header di pagina coerente tra i moduli: badge, icona, titolo, sottotitolo, divisore cromatico."""
    if module is not None:
        st.markdown(f'<div class="sf-module-pill">MODULO {module} DI {total_modules}</div>', unsafe_allow_html=True)
    st.markdown(
        f'<div class="sf-header"><div class="sf-icon">{icon}</div><h1>{title}</h1></div>',
        unsafe_allow_html=True,
    )
    if subtitle:
        st.markdown(f'<div class="sf-subtitle">{subtitle}</div>', unsafe_allow_html=True)
    st.markdown('<div class="sf-divider"></div>', unsafe_allow_html=True)


def sidebar_brand(tagline: str = "Ricerca colore SAR da drone") -> None:
    """Logo + tagline in sidebar (st.logo e' nativo: resta stabile tra le versioni di Streamlit)."""
    try:
        st.logo(str(ASSETS_DIR / "logo.svg"), icon_image=str(ASSETS_DIR / "icon.svg"))
    except Exception:
        pass
    with st.sidebar:
        st.markdown(f'<div class="sf-sidebar-tagline">{tagline}</div>', unsafe_allow_html=True)


def sidebar_mission_status() -> None:
    """Riepilogo stato missione in sidebar: cosa e' gia' pronto nei moduli precedenti."""
    profile_ready = "color_profile" in st.session_state
    batch_ready = bool(st.session_state.get("batch_results"))

    n_saved = 0
    try:
        from modules import color_calibration as cc

        n_saved = len(cc.list_saved_profiles())
    except Exception:
        pass

    rows = [
        ("Profilo colore calibrato", profile_ready or n_saved > 0),
        ("Elaborazione batch eseguita", batch_ready),
    ]
    with st.sidebar:
        st.markdown("**Stato missione**")
        for label, done in rows:
            cls = "done" if done else ""
            mark = "✓" if done else "—"
            st.markdown(
                f'<div class="sf-status-row {cls}"><span class="sf-status-dot {cls}"></span>{mark} {label}</div>',
                unsafe_allow_html=True,
            )
