# Italian Rivers Pollution Map — Environmental Investigation Tool

Map-first technical dashboard for monitoring Italian rivers with pollution data
from **real regional authorities** (ARPA/ARPAT). River reaches follow official
WISE WFD 2022 hydrography where matched, with topology-safe OpenStreetMap
fallbacks, and use a blue (good) to red (bad) severity scale.

Selecting a river opens an expandable operations drawer with measurements,
water-body classifications, nearby companies, geometry provenance, and a
conservatively matched Wikipedia/Wikidata dossier. Every displayed dataset has
a direct source link. Ambiguous Wikimedia names are returned as candidates
instead of asserted facts.

## Data sources (all real, no sample data)

| Source | Region | Data | Access |
|---|---|---|---|
| ARPA Lombardia (Socrata) | Lombardia | 14 parameters, 304 stations, 18 basins | Automatic via API |
| ARPAT Toscana (CSV) | Toscana | 2022–2024 ecological/chemical status per water body | Automatic via API |
| ARPAE | Emilia-Romagna | River monitoring stations and measured parameters | Automatic via API |
| ARPA Piemonte (ArcGIS) | Piemonte | WFD ecological/chemical classification per water body | Automatic via API |
| ARPA Veneto (CSV) | Veneto | LIMeco nutrient/oxygen indicator, latest result per water body | Automatic via API |
| WISE WFD 2022 + OpenStreetMap | National | Official river lines + topology-safe fallback | Bulk download + automatic fallback |
| Wikidata + Wikipedia | National | River identity, descriptions, facts and conservatively linked environmental incidents | On demand, cached 24 hours |
| OSM Overpass + EEA IED | National/EU | Companies and potential sources within a river corridor | On demand |
| **EEA Industrial Emissions** | **EU/Italy** | **Industrial sites + pollutant releases** | **Manual download (see below)** |

## EEA dataset setup (optional, recommended)

1. Open https://industry.eea.europa.eu/industrial-emissions/dataset
2. Click "Industrial reporting dataset" → **Download** (JS-generated link)
3. Unzip the archive into `backend/data/eea/` (site.csv, facility.csv,
   pollutant.csv, transfer.csv, installation.csv, lcp.csv or their ZIP)
4. Restart the backend — it will import and cache to `backend/data/eea/_parsed.json`

Once loaded, the UI shows:
- **EEA industrial sites layer** (purple markers, toggle in Layers panel)
- **EEA regulated sites near each station** in the facilities panel with release counts
- `/api/eea/status`, `/api/eea/sites`, `/api/stations/:id/nearby-eea-sites`, `/api/eea/sites/:id`

## Reading WFD status

- **Elevato**: very good, the best ecological class.
- **Buono**: good; the WFD ecological objective is met.
- **Sufficiente**: moderate and already below the WFD target; improvement is required.
- **Scarso**: poor ecological condition.
- **Cattivo**: bad, the worst ecological class.
- Chemical status is **Buono** (pass) or **Non buono** (fail). If either the
  ecological or chemical component fails, the overall water-body objective is
  shown as not met.

Veneto's **LIMeco** class describes nutrients and dissolved oxygen. It is useful
for pressure screening but is not, by itself, the complete WFD ecological status.

## Run

### Backend
```powershell
cd backend
npm install
npm start          # http://localhost:4000
```

### Frontend
```powershell
cd frontend
npm install
npm run dev        # http://localhost:5173
```

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Health check |
| GET | `/api/rivers` | All rivers as GeoJSON (real agency data only) |
| GET | `/api/rivers/:id/pollution-summary` | Measurements (ARPA) or statuses (ARPAT) |
| GET | `/api/rivers/:id/knowledge` | Verified Wikidata match, Wikipedia summary + structured environmental incidents |
| GET | `/api/rivers/:id/nearby-facilities` | OSM/EEA companies within a corridor of the actual river line |
| GET | `/api/rivers-segments?param=NO3` | Per-tract colored segments (filterable) |
| GET | `/api/stations` | ARPA monitoring stations as GeoJSON |
| GET | `/api/stations/:id/measurements` | Real time-series for one station |
| GET | `/api/stations/:id/nearby-facilities` | OSM facilities (Overpass) |
| GET | `/api/stations/:id/nearby-eea-sites` | EEA regulated sites + releases |
| GET | `/api/eea/status` | EEA dataset status |
| GET | `/api/eea/sites` | Italian EEA sites as GeoJSON |
| GET | `/api/eea/sites/:id` | Site detail with releases/transfers |
| GET | `/api/arpa-regions` | Registry of all 20 Italian ARPA agencies |
| GET | `/api/data-sources` | Overview of all data sources |

## Notes
- No mock/sample data anywhere: rivers without real agency data are not shown.
- Layer toggles, pollutant filter, basemap, and 2D/3D view persist in localStorage.
- Environmental incidents are shown only when a conservative Wikidata match is
  found. “Not found in Wikidata” never means that no incident occurred.
- Attribution: ARPA Lombardia (CC0), ARPAT/ARPAE/ARPAV (CC BY where specified),
  ARPA Piemonte service terms, WISE/EEA re-use terms, OpenStreetMap (ODbL),
  Wikidata (CC0), and Wikipedia (CC BY-SA).
