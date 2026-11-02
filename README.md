# SkyFind

Applicazione per l'analisi di immagini aeree da drone (SAPR) in operazioni SAR (Search and Rescue): individua rapidamente indumenti o target tramite filtraggio cromatico e restituisce una lista ordinata di punti da verificare a occhio.

- **App online**: https://matmex84.github.io/SkyFind/
- **Scheda tecnica** (come funziona, limiti, potenzialità): https://matmex84.github.io/SkyFind/info/ — sorgente in [`info/index.html`](info/index.html)

## Avvio rapido

Nessuna installazione: apri `index.html` col doppio click (o servilo con un qualsiasi web server statico). Gira interamente nel browser — le foto vengono lette dal disco locale e non lasciano mai il computer; dopo il primo caricamento della pagina non serve connessione internet.

## Moduli

- **🛩️ Mission Planner**: quota di volo consigliata (sul GSD target, 0,8–1,5 cm/pixel), overlap frontale/laterale, velocità massima e consigli pratici in base al drone/camera selezionato.
- **🎨 Calibrazione Colore**: contagocce sulla foto campione (anche più punti) oppure palette con colori predefiniti. Tolleranza cromatica automatica e adattiva. Profili salvati nel browser (localStorage).
- **📷 Elaborazione Batch**: cartella locale di foto, elaborazione parallela con un Web Worker per core (OpenCV.js/WebAssembly). Include i suggerimenti dai colori della scena, più profili per lotto, colori da escludere, tolleranza adattiva e la ricerca dei bersagli piccoli in background.
- **📋 Report**: foto con il target cerchiato, miniature ordinate per punteggio, lightbox con zoom, revisione dei falsi positivi, export HTML / CSV / KML / GeoJSON.

## Funzioni sul colore (ultime aggiunte)

1. **Colori che spiccano nella scena** — analizza un campione delle foto (25% del lotto, da 40 a 150) e propone i colori vivaci e rari rispetto allo sfondo, con un ritaglio d'esempio; un clic crea il profilo (`scene_colors.js`).
2. **Più profili colore nello stesso lotto** — una passata per profilo, risultati uniti senza duplicati; filtro per profilo nel Report.
3. **Colori da escludere** — tolti dalla maschera a livello di pixel (papaveri, tetti, veicoli); dichiarati in Report ed export. Solo per la sessione.
4. **Tolleranza adattiva alla scena** — avviso se lo sfondo rientra già nel profilo (> 1,5%) e pulsante per restringere la tolleranza per quell'elaborazione.
5. **Ricerca dei bersagli piccoli in background** — dopo la prima passata il Report è subito consultabile; una seconda passata a risoluzione più alta (fino a 4000 px, area minima 80 px) aggiunge i nuovi rilevamenti (🔎) senza duplicare i precedenti.

## Architettura tecnica

Applicazione statica HTML/JS/CSS, senza build step e senza dipendenze da installare:

- `index.html` — shell dell'app (navigazione tra i moduli via hash routing, `APP_VERSION` per l'aggiornamento della cache)
- `js/app.js` — bootstrap, storage profili colore (localStorage), stato missione
- `js/mission_planner.js`, `js/calibrazione.js`, `js/batch.js`, `js/report.js` — logica dei 4 moduli
- `drones_data.js` — database sensori/focali dei droni
- `color_calib.js` — profili colore, maschere HSV/LAB, gray-world, punteggio di confidenza (condiviso con il worker)
- `scene_colors.js` — colori della scena, campione di sfondo, tolleranza adattiva
- `exif_gps.js` — parser EXIF/GPS/XMP DJI scritto a mano
- `geo_utils.js` — proiezione pixel → terreno (yaw e pitch)
- `detect_worker.js` — Web Worker del rilevamento (OpenCV.js/WASM)
- `opencv.js` — build WebAssembly di OpenCV.js (`@techstark/opencv-js`)
- `icons.js` — set di icone SVG condivise (app e scheda tecnica)
- `info/index.html` — scheda tecnica pubblicata su `/info/`, stesso layout dell'app

Pipeline per foto: riduzione + gray-world → maschera colore (HSV/LAB) → esclusioni → morfologia e contorni → fusione blob vicini → filtro geometrico → punteggio → ritaglio e posizione GPS. I dettagli sono nella scheda tecnica.

## Limiti principali

Solo colore (nessun riconoscimento di forme o persone); bianco e verde militare si confondono con sfondo; ombre e controluce abbassano il punteggio; bersagli molto piccoli o coperti possono sfuggire; la posizione GPS assume terreno piatto; i risultati non sono salvati chiudendo la pagina. Elenco completo nella scheda tecnica.

## Per chi sviluppa

Ogni modifica a un `.js` o `.css` richiede di incrementare `window.APP_VERSION` in `index.html` (cache-busting). Nessun test automatico nel repository; le verifiche si fanno aprendo l'app con foto di prova.

## Versione precedente (Streamlit/Python)

La prima versione, basata su Streamlit e Python, è archiviata in `_streamlit_legacy/` per riferimento storico e non viene più aggiornata:

```bash
cd _streamlit_legacy
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
streamlit run app.py
```
