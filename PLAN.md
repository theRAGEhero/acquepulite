# AcquePulite — piano di lavoro

Stato del progetto e roadmap delle attività necessarie a rendere la piattaforma affidabile.
Documento di lavoro: le attività sono numerate (`T1`…`T53`) e raggruppate in fasi.

**Sito:** https://acquepulite.it · **Codice:** https://github.com/theRAGEhero/acquepulite

> **Per eseguire:** questo documento dice *cosa* e *perché*.
> [SPEC.md](SPEC.md) dice *come verificarlo* e *cosa può andare storto* — dipendenze,
> contratti, trappole del codice e un criterio di accettazione per ogni attività.
> Chi implementa parte da lì.

> Questo documento dichiara apertamente i difetti noti della piattaforma. È una scelta:
> una piattaforma ambientale che elenca i propri limiti è più verificabile di una che tace.

---

## Dove siamo

**Fatto**

- Correzioni critiche: crash della rotta documenti, mojibake nell'interfaccia, injection nei
  popup della mappa, tema chiaro rotto nel pannello impianti.
- Rimozione di ~470 righe di dati sintetici e codice morto (geometrie disegnate a mano, un
  generatore pseudo-casuale di misure, un algoritmo di scoring superato che ordinava le stazioni
  per latitudine).
- Pubblicazione online: nginx, HTTPS con rinnovo automatico, backend sotto systemd, gzip
  (15,3 → 3,2 MB), rate limiting sull'API.
- **Armonizzazione della classificazione WFD** fra tutte le regioni: un solo modulo
  (`backend/wfdClassification.js`), 40 test. Effetti in produzione: Veneto da 0 a 109 corpi
  idrici in classe "elevato", WISE da 0 a 72, Toscana 8 fiumi corretti da "poor" a "bad".
- **F0 completa** (T1–T5): le misure storiche non colorano più la mappa, i periodi sono derivati
  dai dati e non più scritti a mano, via l'affermazione "live agency observations", badge BETA
  sempre visibile, licenza EUPL-1.2 e limiti noti dichiarati nel README.

**Difetti noti ancora aperti**

| Difetto | Misura |
|---|---|
| **Lombardia ed Emilia-Romagna senza colore sulla mappa.** Conseguenza diretta e prevista di F0: le loro misure sono storiche (2016 e 2019) e non esiste per loro una classificazione pubblicata. Si risolve con **T13/T14** | 183 tratte perse, da recuperare come ~835 corpi idrici WISE |
| Copertura sacrificata dagli adattatori regionali | 1.214 corpi idrici su 3.208 disponibili |
| **Snapshot locali alla deriva rispetto alla sorgente.** Il file ARPAE su disco finisce nel 2019 mentre la fonte è pubblicata come 2010–2025, e nulla se ne accorge. È il caso reale che motiva **T11** | 1 fonte accertata, le altre non verificate |
| Corpi idrici non classificati | 267 |
| Stazioni di monitoraggio da rivedere | 270 su 478 |
| Vintage delle classificazioni mostrati identici | dal 2014 al 2025 |
| Peso del primo caricamento | 3,5 MB, ~5 s |
| Test frontend | 0 |

---

## Perché non serve una pipeline in tempo reale

Le cadenze reali delle fonti:

| Fonte | Cadenza |
|---|---|
| WISE WFD | **ogni 6 anni** (2022 = 3° ciclo; il prossimo verso il 2028) |
| Classificazioni regionali ARPA | annuali o triennali |
| Misure di laboratorio | campagne periodiche |
| Idrometria e portata | ogni 10 minuti |

Il problema non è la frequenza di aggiornamento: è che **l'ingestione non è programmata,
versionata né verificabile**. Oggi sette fonti su nove vengono scaricate dalla rete *durante
l'avvio del server*. Da qui discendono tre difetti che sembrano scollegati ma hanno una sola
causa: il boot di 5 minuti, il degrado dell'app quando una fonte non risponde, e
l'irriproducibilità di qualunque dato mostrato.

Il pattern corretto **esiste già nel repository**, applicato a 2 fonti su 9:
`backend/fetchNationalBaseline.mjs` scarica offline con paging, timeout e `createHash` e scrive
uno snapshot; `backend/data/hydrography/manifest.json` registra `version`, `downloaded_at`,
`sha256`, `source_url`, `license`. La fase F1 estende quel pattern a tutte le fonti e lo mette
su uno scheduler.

L'idrometria è l'unica fonte ad alta frequenza e va trattata come **contesto su domanda**, con
cache, non come flusso continuo. Vale comunque la pena integrarla: portata × concentrazione =
*carico*, ed è l'unico modo per distinguere un miglioramento reale da una diluizione.

---

## F0 — Verità immediata

Ferma affermazioni non difendibili già pubbliche.

| # | Attività | File |
|---|---|---|
| T1 | Ritirare le misure 2016 dalla colorazione della mappa; `source_period` dichiara l'anno reale | `backend/arpaLombardia.js`, `backend/server.js` |
| T2 | Mostrare la data di campionamento accanto a ogni valore misurato | `frontend/src/RiverPanel.jsx` |
| T3 | Eliminare "live agency observations" dall'header; l'orologio SYNC mostra il giorno, non solo l'ora | `frontend/src/App.jsx` |
| T4 | Badge `BETA · in sviluppo` sempre visibile, non chiudibile, cliccabile | `frontend/src/App.jsx`, `styles.css` |
| T5 | `LICENSE` EUPL-1.2 e sezione "Limiti noti" nel README; correggere la rivendicazione sulle integrazioni regionali | radice |

## F1 — Pipeline di ingestione

| # | Attività | File |
|---|---|---|
| T6 | Estrarre in un modulo riusabile il pattern di `fetchNationalBaseline.mjs`: fetch con timeout, paging, `createHash`, scrittura snapshot e voce di manifest | `backend/ingest/` |
| T7 | Un ingestore per fonte (7 regionali, EEA, idrometria), ognuno scrive snapshot con `version`, `downloaded_at`, `sha256`, `source_url`, `license` | `backend/ingest/*.mjs` |
| T8 | Il server carica **solo snapshot da disco**, mai dalla rete al boot | `backend/server.js` (`initArpa`) |
| T9 | Scheduler per cadenza (giornaliera per le regionali, su domanda per l'idrometria) e `POST /api/refresh` protetto da token | `backend/ingest/scheduler.mjs` |
| T10 | `fetched_at` per fonte e `data_age_hours` in `/api/health`; badge LIVE → STALE oltre soglia | `backend/server.js`, `frontend/src/App.jsx` |
| T11 | **Validazione prima della pubblicazione**: uno snapshot che perde più di una soglia di record rispetto al precedente non entra in produzione e viene segnalato | `backend/ingest/validate.mjs` |
| T12 | **Registro delle variazioni** fra snapshot successivi: mostra i cambiamenti reali dei fiumi e rileva le regressioni interne | `backend/ingest/changelog.mjs` |

## F2 — Completezza del dato

Le ARPA trasmettono a ISPRA tramite SINTAI e ISPRA riporta a WISE: **WISE è l'aggregato ufficiale
delle stesse classificazioni regionali**. Sostituirlo con un adattatore regionale non aumenta
l'autorevolezza, riduce solo la copertura.

| # | Attività | File |
|---|---|---|
| T13 | Spina dorsale WISE: rimuovere l'esclusione per regione, caricare tutte e 20 le regioni | `backend/wiseNational.js` |
| T14 | Indice per `euSurfaceWaterBodyCode` (riusare `normalizedCode()`); gli adattatori regionali **arricchiscono** il corpo idrico invece di sostituirlo | `backend/wiseNational.js`, adattatori |
| T15 | I record regionali senza corrispondenza restano con `match_status: "unmatched"` esplicito, mai scartati in silenzio | adattatori |
| T16 | Una sola metrica colora la mappa: la classe WFD ufficiale. Misure e LIMeco diventano dettaglio nel pannello | `backend/server.js`, `frontend/src/MapView3D.jsx` |
| T17 | Un "fiume" è un **corpo idrico** ovunque: la Toscana smette di collassare 157 corpi in 11 bacini; via la lista di 18 bacini scritta a mano | `backend/arpatToscana.js`, `backend/server.js` |
| T18 | Recuperare i 73 fiumi con dati e senza geometria; i residui in un rapporto esplicito | `backend/hydrography.js` |
| T19 | Agganciare le stazioni al corpo idrico invece che alla linea di bacino; usare il codice dove presente invece della distanza geometrica | `backend/server.js` |

*Atteso: da 3.085 a ~5.000 fiumi mappati. Toscana 11 → ~831, Lombardia 18 → ~551. Stazioni
agganciate in modo affidabile da 208 a oltre 400.*

## F3 — Velocità

Obbligatoria **prima** di pubblicare ~5.000 fiumi: senza, la completezza peggiora l'esperienza.

| # | Attività | File |
|---|---|---|
| T20 | Precalcolare i payload al boot invece di risimplificare 3.085 geometrie a ogni richiesta | `backend/server.js` |
| T21 | `Cache-Control` ed `ETag` forte legato a `data_updated_at`, invalidato dal refresh | `backend/server.js` |
| T22 | Implementare davvero `overview`: il frontend lo richiede, il backend lo ignora | `backend/server.js`, `frontend/src/App.jsx` |
| T23 | Vector tiles (`tippecanoe` → `.pmtiles`) serviti staticamente da nginx | `backend/ingest/`, nginx |
| T24 | Eliminare il clone-and-rebuild: `source.setData()` e `setLayoutProperty(visibility)` invece di clonare i GeoJSON a ogni toggle | `frontend/src/MapView3D.jsx` |
| T25 | `/api/regions` non deve iterare 3.158 fiumi per ciascuna delle 20 regioni (1,1 s per 406 byte) | `backend/server.js` |

*Obiettivo: `/api/rivers?overview=1` sotto 500 KB e 1,5 s, contro 1,41 MB e 4,7 s attuali, con
~5.000 fiumi invece di 3.085.*

## F4 — Usabilità e interattività

| # | Attività | File |
|---|---|---|
| T26 | Ricerca fiumi: typeahead su `/api/rivers-index`, endpoint già esistente e non usato dalla mappa | `frontend/src/` |
| T27 | Permalink: fiume, regione, filtri e inquinante nell'URL; tag OG per fiume | `frontend/src/App.jsx` |
| T28 | Serie storiche: il dato è già in `/api/stations/:id/measurements`, l'interfaccia mostra solo l'ultimo valore | `frontend/src/RiverPanel.jsx` |
| T29 | Accesso da tastiera a ogni fiume; `role="dialog"`, focus trap, `prefers-reduced-motion` | `frontend/src/App.jsx`, `styles.css` |
| T30 | Esportazione CSV del corpo idrico e della vista, con fonte e vintage nelle intestazioni | `frontend/src/`, `backend/server.js` |
| T31 | Confronto fiume ↔ fiume e fiume ↔ mediana regionale | nuovo componente |
| T32 | Vista classifica: peggiori tratte, peggiori regioni, maggiori peggioramenti (usa T12) | nuova rotta |
| T33 | Schermata d'ingresso per non esperti: numero nazionale, peggiori 10 tratte, una riga di spiegazione | `frontend/src/App.jsx` |

## F5 — Fiducia visibile

| # | Attività | File |
|---|---|---|
| T34 | Endpoint `/api/data-quality` che calcola i limiti dallo store, non da testo scritto a mano | `backend/server.js` |
| T35 | Pagina pubblica **Stato dei dati** (`#/stato-dati`): non classificati, stazioni da rivedere, vintage, copertura per regione | nuova pagina |
| T36 | Pagina **Metodologia**: one-out-all-out, significato delle classi, perché LIMeco non è lo stato ecologico completo, la catena ARPA → SINTAI → ISPRA → WISE | nuova pagina |
| T37 | Fonti fuori dal menu Workspace; footer con repository, licenze e attribuzioni; correggere i colori inline che rompono il tema scuro | `frontend/src/DataSourcesPanel.jsx` |
| T38 | "Segnala un errore": issue GitHub precompilata con codice del corpo idrico, fonte, classe e vintage | `frontend/src/RiverPanel.jsx` |
| T39 | Oracolo ISPRA: confronto continuo con il 43,6 % in stato ecologico buono o superiore e oltre il 75 % in stato chimico buono del Rapporto 427/2026, pubblicato sulla pagina Stato dei dati | `backend/server.js` |

## F6 — Tutti i dati che servono

| # | Attività | Fonte |
|---|---|---|
| T40 | Idrometria e portata: trasforma la concentrazione in *carico* | dati.lombardia.it `3e8b-w7ay` e `9zzw-tkky`; ARPAE dati idrometrici |
| T41 | Scarichi urbani: oggi è mappata l'industria, non le fogne | EEA Waterbase-UWWTD |
| T42 | Pesticidi: l'agricoltura è del tutto assente | Portale pesticidi ISPRA |
| T43 | Concentrazioni misurate 2000–2021 per tutta Italia, incluse le 13 regioni senza adattatore | EEA Waterbase Water Quality ICM |
| T44 | Balneazione e PFAS Veneto: i due dati più leggibili dal cittadino | EEA Bathing Water Directive; ARPAV open data PFAS |
| T45 | Laghi e acque sotterranee: la WFD li copre, ISPRA classifica 1.007 corpi sotterranei | WISE |
| T46 | Soglie citate: `backend/thresholds.js` con `basis` e `legal_reference`; `screening-only` dove non esiste una norma | 2013/39/UE; D.Lgs. 152/2006; D.M. 260/2010 |

## F7 — Produzione e qualità

| # | Attività |
|---|---|
| T47 | Dockerfile e compose; configurazione da ambiente (oggi `PORT` fisso, CORS `*`) |
| T48 | CI che esegue `node --test` e una suite frontend |
| T49 | Vitest e Testing Library, con test di regressione per il crash della rotta documenti |
| T50 | Playwright: caricamento, selezione fiume, rotta documenti |
| T51 | Italiano come lingua principale con selettore EN |
| T52 | Scala divergente al posto dell'arcobaleno (validata per daltonismo), profilo longitudinale, nastro delle pressioni |
| T53 | SEO: pagina statica per fiume |

---

## Verifica

- **F0** — nessuna affermazione "live" nell'interfaccia; ogni valore misurato mostra la sua data;
  `LICENSE` presente.
- **F1** — il servizio riparte in secondi anziché minuti; staccando la rete a una fonte l'app
  parte comunque dagli snapshot; ogni risposta API dichiara la versione dei dati; uno snapshot
  deliberatamente troncato viene rifiutato da T11.
- **F2** — `/api/regions` mostra Toscana ~831 e Lombardia ~551; nessuna regione perde fiumi;
  stazioni `accepted` oltre 400.
- **F3** — `curl -H "Accept-Encoding: gzip"` su `/api/rivers?overview=1` sotto 500 KB e 1,5 s;
  toggle di un layer senza blocco del thread principale.
- **F4** — raggiungere un fiume da tastiera e condividerne il link; la serie storica appare dove
  l'API ha già i dati; axe-core senza errori.
- **F5** — `/api/data-quality` coincide con i numeri ricavati manualmente da `/api/rivers` e
  `/api/stations`; lo scarto ISPRA è calcolato e pubblicato.
- **F6** — ogni adattatore ha test nello stile di `backend/regionalStatusAdapters.test.js`;
  togliendo la rete l'app degrada a risultato parziale dichiarato, mai a errore 5xx.
- **Non regressione** — `node --test` verde, ricostruzione del frontend, deploy, riavvio del
  servizio, `/api/health` con `degraded_sources` vuoto.

---

## Ordine e motivazioni

1. **F0** — ferma un'affermazione falsa già pubblica.
2. **F1** — la pipeline sblocca boot veloce, riproducibilità e rilevamento delle regressioni.
   Senza, ogni miglioramento successivo ricomincia subito a invecchiare.
3. **F2** — la completezza è la ragione d'essere della piattaforma.
4. **F3** — obbligatoria prima di pubblicare ~5.000 fiumi.
5. **F4** e **F5** — in parallelo: usabilità e fiducia si rafforzano a vicenda.
6. **F6** — nuovi dati su fondamenta solide.
7. **F7** — irrobustimento continuo.
