# SkyFind

Applicazione per l'analisi di immagini aeree da drone (SAPR) in operazioni SAR (Search and Rescue), per l'individuazione rapida di indumenti o target tramite filtraggio cromatico.

## Avvio rapido

Nessuna installazione: apri `index.html` col doppio click (o servilo con un qualsiasi web server statico). Gira interamente nel browser — le foto vengono lette dal disco locale e non lasciano mai il computer, non serve una connessione internet dopo il primo caricamento della pagina.

## Moduli

- **🛩️ Mission Planner**: quota di volo consigliata (calcolata sul GSD target, 0,8–1,5 cm/pixel), overlap frontale/laterale, velocità massima e consigli pratici (Terrain Following, gimbal, bilanciamento del bianco), in base al drone/camera selezionato.
- **🎨 Calibrazione Colore**: contagocce stile Google Maps sulla foto campione (drag per spostarsi, +/− per zoomare, click per scegliere il colore) oppure palette colore. Tolleranza cromatica automatica. Profili salvati nel browser (localStorage), eliminabili singolarmente.
- **📷 Elaborazione Batch**: seleziona una cartella locale di foto di missione, elabora in parallelo con un Web Worker per core (OpenCV.js via WebAssembly) — nessun upload, nessun server.
- **📋 Report**: anteprima della foto intera con il target cerchiato, miniature dei rilevamenti, ingrandimento in lightbox, coordinate GPS ed export in HTML/CSV.

## Architettura tecnica

Applicazione statica HTML/JS/CSS, senza build step e senza dipendenze da installare:

- `index.html` — shell dell'app (navigazione tra i 4 moduli via hash routing)
- `js/app.js` — bootstrap, storage profili colore (localStorage), stato missione
- `js/mission_planner.js`, `js/calibrazione.js`, `js/batch.js`, `js/report.js` — logica dei 4 moduli
- `drones_data.js` — database sensori/focali della flotta drone
- `color_calib.js` — calcolo profilo colore (HSV/CIE-LAB), condiviso tra pagina principale e worker
- `exif_gps.js` — parser EXIF/GPS per JPEG scritto a mano (nessuna dipendenza esterna)
- `detect_worker.js` — Web Worker che esegue il rilevamento colore (OpenCV.js/WASM) su ogni foto
- `opencv.js` — build WebAssembly di OpenCV.js (`@techstark/opencv-js`)

Il rilevamento (maschera colore HSV/LAB + pulizia morfologica + contorni) gira su un pool di Web Worker, uno per core disponibile, per elaborare in parallelo lotti di centinaia di foto 4K senza bloccare l'interfaccia.

## Versione precedente (Streamlit/Python)

La prima versione dell'app, basata su Streamlit e Python, è archiviata in `_streamlit_legacy/` per riferimento storico e non viene più aggiornata. Per avviarla (richiede Python):

```bash
cd _streamlit_legacy
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
streamlit run app.py
```
