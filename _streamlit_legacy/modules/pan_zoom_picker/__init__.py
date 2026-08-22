"""Componente Streamlit custom: foto con zoom (+/-) e pan stile Google Maps.

Trascinando con il tasto sinistro si sposta la foto (movimento fluido, gestito
interamente lato browser); un clic breve senza trascinamento seleziona il
colore nel punto esatto. Implementato come componente "statico" senza build
Node/React: la comunicazione con Streamlit usa direttamente il protocollo
postMessage dei Componenti (componentReady / render / setComponentValue /
setFrameHeight) — vedi frontend/index.html per la logica.
"""

from __future__ import annotations

import base64
import io
from pathlib import Path
from typing import Optional

import numpy as np
import streamlit.components.v1 as components
from PIL import Image

_FRONTEND_DIR = Path(__file__).resolve().parent / "frontend"
_component_func = components.declare_component("sf_pan_zoom_picker", path=str(_FRONTEND_DIR))

# Lato massimo (px) dell'immagine inviata al browser: sufficiente per zoom fino a ~6x
# senza appesantire troppo il payload websocket per foto 4K+.
MAX_SEND_DIM = 1800


def pan_zoom_picker(
    image_rgb: np.ndarray,
    image_id: str,
    display_width: int = 640,
    key: Optional[str] = None,
) -> Optional[dict]:
    """Mostra ``image_rgb`` con zoom/pan stile Google Maps; ritorna il punto cliccato.

    ``image_id`` deve identificare univocamente la foto corrente (es. file_id
    dell'upload): usato lato JS per capire se serve resettare zoom/pan (nuova
    foto) o mantenere la vista corrente (rerun per altri motivi, es. un altro
    widget della pagina che cambia).

    Ritorna ``None`` finche' l'utente non clicca sulla foto. Al click ritorna
    ``{"x": int, "y": int, "seq": int}`` in coordinate pixel dell'immagine
    ORIGINALE (``image_rgb``), gia' corrette per lo zoom/pan corrente — nessun
    ricalcolo lato Python necessario.
    """
    h, w = image_rgb.shape[:2]
    scale = min(1.0, MAX_SEND_DIM / max(w, h))
    send_w, send_h = max(1, int(round(w * scale))), max(1, int(round(h * scale)))

    pil_img = Image.fromarray(image_rgb)
    if scale < 1.0:
        pil_img = pil_img.resize((send_w, send_h), Image.BILINEAR)

    buf = io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=88)
    image_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    display_height = max(1, round(display_width * send_h / send_w))

    result = _component_func(
        image_b64=image_b64,
        image_id=image_id,
        sent_width=send_w,
        sent_height=send_h,
        display_width=display_width,
        display_height=display_height,
        key=key,
        default=None,
    )
    if result is None:
        return None

    real_x = int(round(result["x"] / scale))
    real_y = int(round(result["y"] / scale))
    real_x = max(0, min(w - 1, real_x))
    real_y = max(0, min(h - 1, real_y))
    return {"x": real_x, "y": real_y, "seq": result.get("seq", 0)}
