# AcquePulite — specifiche eseguibili

Companion di [PLAN.md](PLAN.md). Il piano dice **cosa** e **perché**; questo documento dice
**come verificarlo** e **cosa può andare storto**. Stessa numerazione (`T1`…`T53`).

Ogni specifica ha la stessa forma:

- **Dipende da / Blocca** — l'ordine non è un suggerimento: alcune attività rilasciate da sole
  peggiorano il sito.
- **Contratto** — firme e formati, dove nasce codice nuovo.
- **Trappole** — fatti del codice circostante che non sono deducibili leggendo la singola
  attività. Sono la ragione per cui una modifica "ovvia" non funziona.
- **Accettazione** — un comando che decide se l'attività è finita.

---

## Invarianti — valgono per ogni attività

1. **Nessun dato inventato.** Se una classificazione non è pubblicata, il valore è `null` e
   l'interfaccia dice "non classificato". Mai un valore di ripiego, mai un default favorevole.
2. **Ogni numero mostrato porta fonte e data.** Un valore senza data non è verificabile.
3. **Degradare, non fallire.** Una fonte irraggiungibile produce un risultato parziale
   dichiarato, mai un 5xx. Il modello è in `backend/overpass.js`.
4. **Nessuna regressione di copertura silenziosa.** Se un cambiamento riduce il numero di corpi
   idrici mostrati, va dichiarato nel commit e nei limiti noti del README.
5. **I test non avviano il server.** `backend/server.js` chiama `app.listen` al caricamento del
   modulo: importarlo in un test tenta di occupare la porta 4000, che in produzione è in uso.
   La logica testabile va in moduli puri — il modello è `backend/wfdClassification.js` e
   `backend/measurementFreshness.js`.

### Comandi di riferimento

```bash
cd backend && node --test                      # 44 test, devono restare verdi
cd frontend && npm run build                   # deve compilare
# deploy
rm -rf /var/www/digital-pollution/assets
cp -r frontend/dist/. /var/www/digital-pollution/
chown -R www-data:www-data /var/www/digital-pollution
systemctl restart acquepulite-api              # boot ~5 min finché T8 non è fatta
curl -s localhost:4000/api/health              # "ready" e degraded_sources vuoto
```

### Trappole globali del codice

| Fatto | Conseguenza |
|---|---|
| `server.js` assegna `store.rivers = allRivers` (adattatori regionali) **prima** di `initRiverGeometries()`, che poi fa `store.rivers.push(river)` per i fiumi WISE | Aggiungere WISE senza deduplicare crea **doppioni**: lo stesso corpo idrico da due fonti con id diversi |
| `resolveOfficialGeometry(catalog, river)` cerca per `river.stretches[].water_body_code`, poi per nome esatto — **mai** per geometria | Un fiume senza `stretches` non ottiene geometria ufficiale, qualunque coordinata abbia |
| `official_only: true` esclude il fiume dal recupero geometrie via OpenStreetMap | Impostarlo su un fiume senza geometria propria lo rende invisibile |
| `geometry_locked: true` insieme a `geom` salta del tutto la risoluzione | È l'unico modo per cui una geometria fornita dall'adattatore sopravvive |
| Quando nessun match riesce, il server fa `river.geom = null` | La geometria fornita da un adattatore viene **sempre** sostituita o annullata, a meno di `geometry_locked` |
| `/api/rivers` filtra `river.geom` non nullo, `/api/regions` no | Un fiume senza geometria è contato nei totali ma invisibile sulla mappa (oggi sono 73) |
| `simplifyGeometry()` gira a ogni richiesta su tutti i fiumi | È la causa principale della lentezza; vedi T20 |
| La compressione gzip è in nginx, non nell'app | Misurare sempre con `-H "Accept-Encoding: gzip"`, altrimenti i numeri non sono confrontabili |

---

# F1 — Pipeline di ingestione

Obiettivo della fase: il server non scarica più nulla dalla rete all'avvio.

### T6 — Modulo di ingestione riusabile

**Dipende da:** nulla. **Blocca:** T7, T8, T9, T11, T12.

**Contratto.** Nuovo `backend/ingest/snapshot.mjs`. Generalizza ciò che
`backend/fetchNationalBaseline.mjs` già fa bene: scrittura atomica, sha256, busta con metadati,
validazione **prima** di scrivere.

```js
// Busta di ogni snapshot su disco — identica a quella già usata da
// fetchNationalBaseline.mjs, così i due formati non divergono.
// { metadata: { id, title, source_url, version, license, downloaded_at, records }, records: [...] }

export async function fetchWithRetry(url, { label, timeoutMs = 60000, retries = 2 }): Promise<Response>
export function writeSnapshot(file, { id, title, source_url, version, license }, records): { sha256, path, count }
export function readSnapshot(file): { metadata, records } | null
export function upsertManifestEntry(manifestFile, entry): void
```

**Trappole.**
- `writeJsonAtomic` in `fetchNationalBaseline.mjs` scrive su `${file}.tmp` e poi rinomina: **non
  semplificare in una scrittura diretta**, un'interruzione a metà lascerebbe uno snapshot
  troncato che il server caricherebbe al riavvio successivo.
- Lo sha256 va calcolato sulla **stessa stringa** che viene scritta, non sull'oggetto
  riserializzato: due `JSON.stringify` possono differire.
- Lo schema del manifest esiste già in `backend/data/hydrography/manifest.json`
  (`id`, `title`, `version`, `license`, `file`, `source_url`, `downloaded_at`, `sha256`).
  Riusarlo, non inventarne un secondo.

**Accettazione.**
```bash
cd backend && node --test ingest/          # test del modulo verdi
node -e 'import("./ingest/snapshot.mjs").then(m=>console.log(Object.keys(m)))'
# scrivere uno snapshot, poi troncare il file e verificare che readSnapshot lo rifiuti
```

### T7 — Un ingestore per fonte

**Dipende da:** T6. **Blocca:** T8.

**Contratto.** Un file per fonte in `backend/ingest/`, ciascuno eseguibile da solo:
`node ingest/arpaLombardia.mjs`. Ogni ingestore esporta `export async function ingest(): Promise<{id, count, sha256}>`.

Fonti e destinazioni (verificate nel codice attuale):

| Ingestore | Sorgente | Snapshot |
|---|---|---|
| `arpaLombardia` | `dati.lombardia.it/resource/ixjj-e763.json` (Socrata) | `data/snapshots/arpa-lombardia.json` |
| `arpatToscana` | 4 CSV su `arpat.toscana.it` | `data/snapshots/arpat-toscana.json` |
| `arpaeEmiliaRomagna` | `dati.arpae.it` (CSV già su disco in `data/arpae/`) | `data/snapshots/arpae-emilia-romagna.json` |
| `arpaPiemonte` | `webgis.arpa.piemonte.it` ArcGIS | `data/snapshots/arpa-piemonte.json` |
| `arpaVeneto` | CSV LIMeco su `arpa.veneto.it` | `data/snapshots/arpa-veneto.json` |
| `arpaFvg` | tabelle HTML su `arpa.fvg.it` | `data/snapshots/arpa-fvg.json` |
| `arpaLazio` | `dati.lazio.it` CKAN CSV (snapshot già su disco) | `data/snapshots/arpa-lazio.json` |
| `eea` | archivio scaricato a mano in `data/eea/` | già in `_parsed.json` |
| `wise` | **già fatto** — `fetchNationalBaseline.mjs` | `data/regional/wise-wfd-2022-it-status.json` |

**Trappole.**
- Gli ingestori devono salvare il **dato grezzo normalizzato**, non il risultato già
  classificato: la classificazione cambia (è cambiata con D3) e non deve richiedere un nuovo
  scarico per essere ricalcolata.
- `arpaFvg` fa scraping di HTML: il parser va tenuto nell'adattatore, l'ingestore salva l'HTML
  o le righe estratte, così un cambio di layout si diagnostica senza rifare la rete.
- `arpaLombardia` interroga per nome di bacino con una lista scritta a mano in
  `server.js:initArpa()`. **Non replicarla nell'ingestore**: T17 la elimina.

**Accettazione.**
```bash
cd backend && for f in ingest/arpa*.mjs; do node "$f" || echo "FALLITO: $f"; done
ls -la data/snapshots/                       # uno snapshot per fonte, non vuoto
node -e 'const s=require("./data/snapshots/arpa-piemonte.json");console.log(s.metadata, s.records.length)'
```

### T8 — Il server carica solo da disco

**Dipende da:** T7 (tutti gli ingestori devono esistere, o il boot perde fonti).
**Blocca:** T9, T10.

**Contratto.** `initArpa()` in `backend/server.js` non chiama più `loadArpa*()` che fanno rete.
Ogni adattatore espone in più una funzione pura di trasformazione:
`export function buildFromSnapshot(records): { rivers, stations, measurementsByStation }`.
L'ingestore scarica, l'adattatore trasforma, il server assembla.

**Trappole.**
- Se manca uno snapshot, il boot **non deve fallire**: registra la fonte come degradata
  (`markSourceFailure`) e prosegue. Il meccanismo esiste già in `initArpa()`.
- `store.arpaFetchedAt` oggi è il momento del boot. Deve diventare la data dello snapshot più
  vecchio, altrimenti T10 mostrerà dati vecchi come appena sincronizzati.
- Gli adattatori che già leggono da disco (`arpaLazio.js`, `arpaeEmiliaRomagna.js`) vanno
  allineati al nuovo percorso, non lasciati su due meccanismi diversi.

**Accettazione.**
```bash
# 1. boot veloce
systemctl restart acquepulite-api && time (until curl -sf localhost:4000/api/health | grep -q '"ready":true'; do sleep 1; done)
#    atteso: secondi, non minuti
# 2. boot senza rete
#    disabilitare temporaneamente l'uscita di rete e riavviare: deve partire comunque
curl -s localhost:4000/api/health | grep degraded_sources     # vuoto
# 3. nessuna chiamata di rete al boot
grep -n "fetch(" backend/server.js                            # nessuna dentro initArpa
```

### T9 — Scheduler e refresh manuale

**Dipende da:** T8. **Blocca:** T10, T12.

**Contratto.** `backend/ingest/scheduler.mjs`: esegue gli ingestori per cadenza (giornaliera per
le regionali) e ricarica lo store **senza riavviare il processo**.
`POST /api/refresh` con header `Authorization: Bearer <REFRESH_TOKEN>` da variabile d'ambiente.

**Trappole.**
- Ricaricare lo store mentre una richiesta è in corso: costruire il nuovo store e **sostituirlo
  con un'assegnazione atomica**, mai mutare quello in uso.
- `POST /api/refresh` senza token configurato deve rispondere 503, non accettare tutto.
- L'endpoint va escluso dalla zona di rate limiting `acquepulite_api` in nginx, o aggiunto con
  una zona propria molto stretta.
- Se il token non è configurato, lo scheduler deve comunque funzionare: sono indipendenti.

**Accettazione.**
```bash
curl -X POST localhost:4000/api/refresh                          # 401
curl -X POST -H "Authorization: Bearer $REFRESH_TOKEN" localhost:4000/api/refresh   # 202
curl -s localhost:4000/api/health                                # data_updated_at avanzato, nessun riavvio
```

### T10 — Età del dato dichiarata

**Dipende da:** T8. **Blocca:** nulla.

**Contratto.** `/api/health` guadagna:
```json
"sources": [{ "id": "arpa-piemonte", "fetched_at": "…", "data_age_hours": 12.4, "stale": false }]
```
`MonitoringHud` in `frontend/src/App.jsx` mostra `LIVE` solo se nessuna fonte è `stale`,
altrimenti `STALE`.

**Trappole.**
- Distinguere due età diverse: quando abbiamo **scaricato** (`downloaded_at`) e a quando
  risalgono i **dati** (`source_period`, già derivato dai dati per Lombardia ed Emilia-Romagna).
  Uno snapshot scaricato ieri può contenere misure del 2016 — è esattamente il caso reale.
- Il badge `LIVE` era già ingannevole una volta: non reintrodurlo legato allo stato del processo.

**Accettazione.**
```bash
curl -s localhost:4000/api/health | node -e '…'   # ogni fonte ha fetched_at e data_age_hours
# rendere vecchio uno snapshot a mano e verificare che la HUD passi a STALE
```

### T11 — Validazione prima della pubblicazione

**Dipende da:** T6. **Blocca:** nulla, ma senza di essa T9 può pubblicare dati rotti.

**Contratto.** `backend/ingest/validate.mjs`:
```js
export function validateSnapshot(previous, next, rules): { ok, violations: [{rule, expected, actual}] }
```
Regole minime: conteggio record non inferiore a `−10 %` rispetto allo snapshot precedente;
campi obbligatori presenti; codici corpo idrico unici oltre una soglia.

Uno snapshot che viola una regola **non sostituisce** il precedente: viene scritto accanto come
`.rejected.json` e registrato come errore.

**Trappole.**
- Il precedente snapshot può non esistere (primo scarico): in quel caso passa, ma lo dichiara.
- `fetchNationalBaseline.mjs` ha già validazioni di questo tipo (`records.length < 5000`,
  conteggio codici unici, almeno 20 unità NUTS): vanno riespresse come regole, non duplicate.
- **Caso reale da usare come test**: lo snapshot ARPAE su disco finisce al 2019 mentre la fonte
  è pubblicata come 2010–2025. Una regola sulla data massima dei record lo avrebbe segnalato.

**Accettazione.**
```bash
cd backend && node --test ingest/validate.test.js
# troncare uno snapshot al 50% dei record e rilanciare l'ingestore:
#   deve rifiutare, scrivere .rejected.json e lasciare intatto quello buono
```

### T12 — Registro delle variazioni

**Dipende da:** T9. **Blocca:** T32 (vista classifica).

**Contratto.** `backend/ingest/changelog.mjs` confronta snapshot consecutivi per
`euSurfaceWaterBodyCode` e scrive `data/changelog/<data>.json`:
```json
[{ "water_body_code": "…", "field": "ecological", "from": "Buono", "to": "Sufficiente", "source": "…" }]
```

**Trappole.**
- Un cambiamento può derivare da una **nostra** modifica al codice di classificazione, non dal
  dato: registrare anche la versione del modulo di classificazione, altrimenti il registro
  attribuisce ai fiumi ciò che abbiamo fatto noi.
- Non registrare variazioni quando il campo passa da un valore a `null` per assenza dello
  snapshot: sarebbe rumore da guasto, non un cambiamento reale.

**Accettazione.**
```bash
ls data/changelog/ && node -e 'console.log(require("./data/changelog/…json").slice(0,3))'
# modificare una classe in uno snapshot di prova: deve comparire una voce, e una sola
```

---

# F2 — Completezza del dato

> **Avvertenza d'ordine: T13 non va rilasciata senza T14.** Rilasciata da sola raddoppia i
> fiumi nelle sette regioni con adattatore, con id diversi per lo stesso corpo idrico.

### T13 + T14 — Spina dorsale WISE e arricchimento regionale

**Dipende da:** F1 conclusa (senza, ogni prova costa 5 minuti di boot).
**Blocca:** T16, T17, T18, T19. **Da rilasciare insieme.**

**Contratto.**
```js
// backend/wiseNational.js
export function loadWiseNationalRivers(catalog)            // niente più parametro di esclusione

// backend/waterBodyIndex.js (nuovo)
export function buildIndex(wiseRivers): Map<normalizedCode, WaterBody>
export function enrich(index, regionalRivers): { enriched, unmatched }
```

Regola di merge, per ogni corpo idrico:
- la **classificazione WFD** resta quella WISE (è l'aggregato ufficiale);
- l'arricchimento regionale aggiunge `regional_source`, `regional_assessment`,
  `regional_period`, e le misure per stazione;
- se la fonte regionale è **più recente** di WISE, la sua classificazione viene esposta come
  campo separato — non sovrascrive quella WISE. Quale delle due colora la mappa è deciso da T16.

**Trappole.**
- `store.rivers` è **già popolato** dagli adattatori quando `initRiverGeometries()` aggiunge
  WISE (`server.js:238` poi `265`). L'arricchimento deve avvenire **prima** del push, oppure il
  push va sostituito da un merge.
- `store.arpatStretches.set(river.id, river)` viene usato da `buildAccurateSegments` per
  decidere il ramo "stato del corpo idrico". Con id che cambiano, quella mappa va ricostruita
  coerentemente o le tratte spariscono.
- La normalizzazione dei codici non è uniforme: `normalizedCode()` in `wiseNational.js` toglie
  tutto ciò che non è alfanumerico e alza a maiuscolo; il Piemonte espone il codice in
  `properties.WISE` **oppure** `properties.CODICE_CI`. Verificare la resa dell'aggancio prima di
  dichiarare "unmatched".
- `regionCodesForGeometry()` campiona fino a 30 punti per geometria e fa point-in-polygon su
  tutte le regioni: togliere l'esclusione aumenta il costo del boot. Misurarlo.

**Accettazione.**
```bash
curl -s localhost:4000/api/regions | node -e '…'
#   Toscana ~831 (oggi 11), Lombardia ~551 (oggi 18), nessuna regione in calo
grep "WISE-NATIONAL" /var/log/acquepulite-api.log     # excluded_records: 0
# nessun doppione:
curl -s "localhost:4000/api/rivers" | node -e 'const j=…; const codes=j.features.flatMap(f=>f.properties.water_body_code||[]); console.log(codes.length, new Set(codes).size)'
#   i due numeri devono coincidere
```

### T15 — Record regionali senza corrispondenza

**Dipende da:** T14. **Blocca:** nulla.

**Contratto.** Ogni fiume espone `match_status: "matched" | "unmatched"` e, se agganciato,
`matched_by: "eu-code" | "name"`.

**Trappole.** Un record non agganciato **non va scartato**: è un dato pubblicato da un'agenzia,
e la mancata corrispondenza è un difetto nostro da correggere, non suo. Precedente reale: in F0
un filtro ha fatto sparire 12 corpi idrici del FVG classificati solo dalla chimica conforme.

**Accettazione.** `/api/data-quality` (T34) riporta il conteggio per fonte; deve scendere nel tempo.

### T16 — Una sola metrica colora la mappa

**Dipende da:** T14. **Blocca:** nulla.

**Contratto.** Il colore deriva solo da `wfd_status`. Misure e LIMeco restano nel pannello.

**Trappole.**
- `buildAccurateSegments` ha **due rami**: uno per `arpatStretches` (stato del corpo idrico) e
  uno per stazioni con misure. Il secondo va convertito, non cancellato: le stazioni restano
  visibili, non colorano più le tratte.
- Le misure lombarde ed emiliane sono già escluse dal colore da F0/T1 tramite
  `measurementsAreCurrent()`. T16 rende la regola strutturale e non più dipendente dall'età.
- La scala arcobaleno attuale va sostituita (T52): non farlo in questa attività, ma non
  consolidarla nemmeno.

**Accettazione.**
```bash
curl -s "localhost:4000/api/rivers-segments" | node -e '…'
#   nessuna feature con pollution_score derivato da misure; ogni colore risale a una classe WFD
```

### T17 — Un fiume è un corpo idrico

**Dipende da:** T14. **Blocca:** T19.

**Trappole.**
- La Toscana raggruppa per sottobacino: `riverKey` è il primo token di `"Arno-Arno"`, perciò 157
  corpi idrici diventano 11 "fiumi". Il bacino va conservato come **attributo**, non come unità.
- La lista di 18 bacini in `server.js:initArpa()` va eliminata, non spostata.
- Cambiare l'unità **cambia gli id**: i permalink (T27) non esistono ancora, quindi è il momento
  giusto per farlo. Dopo T27 diventa una rottura di URL pubblici.

**Accettazione.** Toscana: numero di fiumi ≈ numero di corpi idrici, non 11.

### T18 — Fiumi senza geometria

**Dipende da:** T14. **Blocca:** nulla.

**Trappole.** Sono 73 (51 Emilia-Romagna, 20 Veneto, 2 Lombardia). Dopo T14 la maggior parte si
aggancia via codice UE. Per i residui: **non inventare una geometria** dai punti stazione — è
esattamente ciò che è stato rimosso in Fase 0. Vanno elencati in `/api/data-quality`.

**Accettazione.** Log `HYDRO` con `unmatched` ridotto; i residui presenti in `/api/data-quality`.

### T19 — Aggancio delle stazioni

**Dipende da:** T17. **Blocca:** nulla.

**Contratto.** `station.matched_by: "water-body-code" | "distance" | "none"` sempre esposto.

**Trappole.**
- Oggi 138 stazioni su 478 sono `rejected` e 87 `unmatched`; le rifiutate vengono saltate in
  `buildAccurateSegments`. La causa principale è l'aggancio alla linea di **bacino** invece che
  del corpo idrico: T17 deve precedere.
- Le soglie 250 m / 1.000 m (`server.js:407`) restano solo come ripiego.
- Una stazione agganciata per codice **non** va poi riagganciata per distanza.

**Accettazione.**
```bash
curl -s localhost:4000/api/stations | node -e '…'   # accepted > 400 su 478
```

---

# F3 — Velocità

Riferimento attuale, da battere: `/api/rivers?overview=1` = 1,41 MB in 4,7 s;
`/api/rivers-segments?overview=1` = 1,80 MB in 3,9 s; primo caricamento ~3,5 MB e ~5 s.

### T20 + T21 — Payload precalcolati e cache

**Dipende da:** F1 (l'invalidazione si aggancia al refresh). **Blocca:** T23.

**Contratto.** Al termine del caricamento dati, costruire e tenere in memoria i buffer JSON già
serializzati per: panoramica nazionale, ogni regione, ogni valore di `param`. `ETag` forte
derivato da `data_updated_at` + parametri di query.

**Trappole.**
- `simplifyGeometry()` gira oggi a ogni richiesta su 3.085 fiumi. Dopo T14 saranno ~5.000: senza
  precalcolo il tempo peggiora, non migliora.
- La combinazione regione × pollutant è ampia: precalcolare la panoramica e le regioni, e
  calcolare su richiesta con cache LRU il resto.
- L'`ETag` debole generato da Express non evita il ricalcolo: va impostato **prima** di
  serializzare.

**Accettazione.**
```bash
curl -s -H "Accept-Encoding: gzip" -o /dev/null -w "%{size_download} %{time_total}\n" \
  "https://acquepulite.it/api/rivers?overview=1"
#   atteso < 500 KB e < 1,5 s, con ~5.000 fiumi
curl -s -D - -o /dev/null "localhost:4000/api/rivers?overview=1" | grep -i etag
curl -s -o /dev/null -w "%{http_code}\n" -H 'If-None-Match: <etag>' "localhost:4000/api/rivers?overview=1"   # 304
```

### T22 — `overview` reale

**Dipende da:** T20. **Blocca:** nulla.

**Trappole.** Il frontend lo richiede già (`App.jsx:107`) e `/api/rivers` lo ignora
(`server.js:501` legge solo `region`). "Overview" deve significare: geometria semplificata più
aggressivamente **e** proprietà ridotte all'essenziale per disegnare e cliccare. Oggi ogni
feature porta ~20 proprietà di provenienza che servono solo al pannello.

**Accettazione.** `overview=1` restituisce meno byte di `overview=0` a parità di regione.

### T23 — Vector tiles

**Dipende da:** T20, e T13/T14 concluse (le tile vanno generate sul dataset finale).

**Trappole.** Le tile sono un artefatto di build: vanno generate da un ingestore (F1) e servite
da nginx come file statici, non dal processo Node. Serve una regola nginx per `.pmtiles` con
`Accept-Ranges`. Il frontend deve continuare a funzionare senza tile, per sviluppo.

**Accettazione.** Il browser scarica solo le tile della vista; il traffico al primo caricamento
scende sotto 1 MB.

### T24 — Fine del clone-and-rebuild

**Dipende da:** nulla. **Può essere fatta subito**, è indipendente dal backend.

**Trappole.** `MapView3D.jsx:254` clona i due GeoJSON con `JSON.parse(JSON.stringify(...))` e
`addLayers` rigira a ogni cambio di `showLabels`, `showSegments`, `showNetwork`,
`selectedStation` (`MapView3D.jsx:176`). Attenzione: `addLayers` **rimuove e ricrea** anche i
gestori di eventi; passando a `setData` va evitato di registrarli due volte.

**Accettazione.** Nel profiler, attivare "River labels" non produce un blocco del thread
principale; nessun `removeSource` nella traccia.

### T25 — `/api/regions` efficiente

**Dipende da:** nulla. **Trappole.** Oggi filtra `store.rivers` per ciascuna delle 20 regioni:
20 × 3.158 iterazioni per 406 byte di risposta, 1,1 s. Basta un conteggio in una sola passata.

**Accettazione.** `time curl -s localhost:4000/api/regions` sotto 50 ms.

---

# F4–F7 — specifiche sintetiche

Attività a rischio architetturale minore: contratto e accettazione, trappole solo dove esistono.

| # | Contratto / Accettazione | Trappole |
|---|---|---|
| **T26** Ricerca | Typeahead su `/api/rivers-index` (**esiste già**, la mappa non lo usa). Accettazione: trovare "Lambro" e volarci in meno di 3 interazioni | L'indice è 2,8 MB: servirlo compresso e filtrare lato server oltre N risultati |
| **T27** Permalink | Stato in URL: fiume, regione, filtri, inquinante. Accettazione: incollare un link in una finestra pulita riproduce la vista | Da fare **dopo T17**: T17 cambia gli id e romperebbe gli URL già condivisi |
| **T28** Serie storiche | `/api/stations/:id/measurements` **restituisce già** `values[]` con timestamp. Accettazione: sparkline per parametro, grafico all'espansione | Molte serie finiscono nel 2016/2019: il grafico deve mostrare l'asse temporale reale, non insinuare continuità fino a oggi |
| **T29** Accessibilità | `role="dialog"`, focus trap, ripristino del focus, `prefers-reduced-motion`. Accettazione: axe-core senza errori; percorso completo da tastiera | `prefers-reduced-motion` è a **zero occorrenze** in 2.400 righe di CSS, con animazioni neon e `flyTo` di 2 s |
| **T30** Esportazione CSV | Intestazioni con fonte, licenza, vintage, data di estrazione. Accettazione: il CSV si apre e cita la fonte | Il download non deve passare da `<a download>` con blob se il sito sarà incorporato altrove |
| **T31** Confronto | Due corpi idrici affiancati, stessa scala. Accettazione: confronto fra classi diverse leggibile | Mai confrontare una classe WFD con una misura: non sono la stessa grandezza |
| **T32** Classifica | Peggiori tratte e regioni, maggiori peggioramenti. Dipende da **T12** | "Peggioramento" va distinto da "cambio di metodo": usare la versione del classificatore registrata da T12 |
| **T33** Ingresso | Numero nazionale, peggiori 10 tratte, una riga di spiegazione | Il numero nazionale deve coincidere con quello di T39, o la home contraddice la pagina Stato dei dati |
| **T34** `/api/data-quality` | Calcolato dallo store, mai scritto a mano. Accettazione: coincide con i conteggi ricavati da `/api/rivers` e `/api/stations` | Se è scritto a mano invecchia e mente: è il difetto che la pagina esiste per denunciare |
| **T35** Stato dei dati | Rotta `#/stato-dati`, modello `DocumentsPage.jsx` | Il badge BETA punta oggi al pannello fonti: ripuntarlo qui |
| **T36** Metodologia | Valori letti da `wfdClassification.js`, non ricopiati | Se ricopiati divergeranno dal codice: è già successo con le sei tabelle di soglie |
| **T37** Fonti e footer | Repo, licenze, attribuzione OSM (richiesta da ODbL). Accettazione: `grep 'color: "#' DataSourcesPanel.jsx` vuoto | 6 colori inline rompono il tema scuro, stesso difetto già corretto in `FacilitiesPanel.jsx` |
| **T38** Segnala errore | Issue GitHub precompilata con codice, fonte, classe, vintage, URL | Non includere dati personali nell'URL precompilato |
| **T39** Oracolo ISPRA | Confronto con 43,6 % e >75 % del Rapporto 427/2026. Accettazione: lo scarto è calcolato e pubblicato | Confrontare su popolazioni omogenee: ISPRA conta oltre 7.700 corpi idrici, noi oggi 3.085 |
| **T40** Idrometria | Socrata `3e8b-w7ay` (livello) e `9zzw-tkky` (portata, con `cod_ci_adbpo`). Riusa il client Socrata | `9zzw-tkky` risulta fermo al 2017; `3e8b-w7ay` aggiornato a maggio 2026. Verificare **prima** di prometterne l'attualità |
| **T41–T45** Nuove fonti | Un ingestore F1 ciascuna, test come `regionalStatusAdapters.test.js` | Ogni nuova fonte passa da T11: nessuna entra senza validazione |
| **T46** Soglie citate | `backend/thresholds.js` con `value`, `basis`, `legal_reference`, `source_url`, `applies_to` | Verificare ogni numero sul testo primario: gli attuali mescolano acqua potabile, classi di balneazione ed EQS |
| **T47–T50** Produzione | Docker, CI, Vitest, Playwright | Il test di regressione obbligatorio: navigare a `#/documents` e tornare senza schermata bianca |
| **T51** Italiano | Stringhe in `frontend/src/i18n/`, lingua nell'URL | Il popup della mappa è già in italiano mentre il resto è inglese: non due sistemi |
| **T52** Scala colori | Divergente con neutro al confine buono/moderato, validata per daltonismo | La classe WFD è **ordinale**: non interpolare colori continui fra classi |
| **T53** SEO | Pagina statica per fiume. Dipende da **T27** | Una SPA a hash è oggi invisibile ai motori |

---

## Come si chiude un'attività

1. I test passano: `cd backend && node --test`.
2. Il criterio di accettazione dell'attività è soddisfatto, con il comando eseguito.
3. Se la copertura cambia, il numero è nel messaggio di commit e nei limiti noti del README.
4. Il commit cita l'identificativo (`T13`) e descrive il difetto risolto, non solo la modifica.
