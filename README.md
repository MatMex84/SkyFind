# SkyFind

Applicazione per l'analisi di immagini aeree da drone (SAPR) in operazioni SAR (Search and Rescue), per l'individuazione rapida di indumenti o target tramite filtraggio cromatico.

## Stato del progetto

- ✅ **Modulo 1 — Mission Planner Assistant**: calcolo GSD, quota di volo min/max consigliata per il target GSD, database sensori (DJI Mavic 3 Enterprise/Thermal, Matrice 350 RTK + H20T/P1), linee guida overlap (front 70–80%, side 60–70%).
- ✅ **Modulo 2 — Estrazione e Calibrazione Campione**: caricamento immagine/ROI, estrazione profilo colore in HSV e CIE-LAB, palette dominante (k-means), tolleranza regolabile, salvataggio profilo su disco.
- ✅ **Modulo 3 — Elaborazione Immagini (OpenCV Processing Pipeline)**: caricamento batch da cartella locale o upload, maschera colore (HSV/LAB/entrambi) + pulizia morfologica, bounding box dei contorni, lettura EXIF/GPS. Progettato per lotti di centinaia di foto 4K — vedi note tecniche sulle performance più sotto.
- ✅ **Modulo 4 — Output e Visualizzazione**: report interattivo in-app con ritagli, coordinate GPS (link mappa) e confidenza cromatica; esportazione in HTML autonomo e CSV.

## Avvio rapido

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
streamlit run app.py
```

## Struttura del progetto

```
SkyFind/
├── app.py                              # Home Streamlit
├── pages/
│   ├── 1_🛩️_Mission_Planner.py         # Modulo 1
│   ├── 2_🎨_Calibrazione_Colore.py     # Modulo 2
│   ├── 3_📷_Elaborazione_Batch.py      # Modulo 3
│   └── 4_📋_Report.py                  # Modulo 4
├── modules/
│   ├── mission_planner.py              # Logica GSD / quota / overlap
│   ├── color_calibration.py            # Estrazione profilo colore HSV/LAB
│   ├── image_processing.py             # Pipeline batch: maschera, morfologia, contorni, EXIF/GPS
│   └── report.py                       # Generazione report HTML/CSV
├── config/
│   └── drones.json                     # Database sensori/drone
├── profiles/                           # Profili colore salvati (JSON, non versionati)
└── requirements.txt
```

## Note tecniche

- Il GSD è calcolato con la formula standard di fotogrammetria:
  `GSD (cm/px) = (larghezza_sensore_mm × quota_m × 100) / (focale_reale_mm × larghezza_immagine_px)`
  Usa la **focale reale** del sensore (non l'equivalente 35mm).
- Il profilo colore usa HSV e CIE-LAB perché entrambi separano meglio la crominanza dalla luminosità rispetto a RGB puro, riducendo l'impatto di ombre ed esposizione sul matching cromatico.
- La confidenza di un rilevamento (Modulo 3/4) è calcolata dalla distanza cromatica media (in CIE-LAB) dei pixel del bounding box rispetto al colore medio del profilo, normalizzata sulla tolleranza impostata: 100% = colore medio esatto, 0% = al limite della tolleranza.

## Performance del Modulo 3 (lotti di centinaia di foto 4K)

- **Streaming**: le foto vengono elaborate una alla volta per worker (`modules/image_processing.process_batch`, generatore); non viene mai tenuto in RAM l'intero lotto, solo le foto correntemente in lavorazione.
- **Downscaling per il rilevamento**: la maschera colore, la morfologia e la ricerca dei contorni girano su una copia ridotta dell'immagine (lato configurabile, default 1600px); il ritaglio ad alta risoluzione viene estratto solo per i rilevamenti positivi, e solo sull'area del bounding box (+ margine), non sull'intera foto.
- **Parallelizzazione via thread, non processi**: `ThreadPoolExecutor` invece di `multiprocessing`/`ProcessPoolExecutor`. Le funzioni OpenCV usate (`imread`, `cvtColor`, `resize`, `inRange`, `morphologyEx`, `findContours`) sono implementate in C++ e rilasciano il GIL di Python durante l'esecuzione, quindi i thread ottengono comunque uno speedup parallelo reale. `multiprocessing` sotto Streamlit su Windows è fragile (lo spawn di un processo figlio rilancerebbe l'entry point di Streamlit stesso) e aggiungerebbe overhead di serializzazione delle immagini tra processi senza vantaggio, dato che il collo di bottiglia è già condiviso grazie al GIL rilasciato da OpenCV.
- **I/O efficiente**: lettura EXIF/GPS con `piexif` (legge solo il segmento EXIF del file) prima di decodificare i pixel; se il GPS è impostato come obbligatorio, le foto senza metadati vengono scartate senza mai decodificare l'immagine.
- **Sorgente da cartella locale**: nel Modulo 3 è preferibile indicare il percorso di una cartella locale piuttosto che caricare le foto via browser — Streamlit trasferirebbe centinaia di MB via websocket, molto più lento della lettura diretta da disco.
- **Feedback incrementale in UI**: progress bar con conteggio foto elaborate/rimanenti e rilevamenti trovati in tempo reale.
