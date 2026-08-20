// Registry of all 20 Italian ARPA regional environmental agencies.
// Each entry documents the known open-data portal, API type, and water-quality
// dataset availability. This is a reference catalog used by the app to show
// coverage status and to route queries to the right adapter.
//
// Sources researched:
//   - https://www.snpa.it (Sistema Nazionale per la Protezione Ambientale)
//   - https://www.dati.gov.it (national open data catalog)
//   - Each ARPA regional portal

export const ARPA_REGIONS = [
  {
    code: "LOM", name: "Lombardia", arpa: "ARPA Lombardia",
    portal: "https://www.dati.lombardia.it",
    api_type: "Socrata",
    water_quality_dataset: "ixjj-e763",
    status: "integrated",
    notes: "Full integration via Socrata API. 18 basins, 304 stations, 14 parameters."
  },
  {
    code: "PIE", name: "Piemonte", arpa: "ARPA Piemonte",
    portal: "https://www.dati.piemonte.it",
    api_type: "CKAN",
    water_quality_dataset: "qualita-acque-superficiali",
    status: "researched",
    notes: "CKAN portal. Dataset 'acque superficiali' exists but needs adapter."
  },
  {
    code: "VEN", name: "Veneto", arpa: "ARPA Veneto",
    portal: "https://www.arpa.veneto.it",
    api_type: "CSV/HTML",
    water_quality_dataset: "monitoraggio-acque-superficiali",
    status: "researched",
    notes: "Data published as downloadable CSV/Excel from ARPA Veneto website."
  },
  {
    code: "TAA", name: "Trentino-Alto Adige", arpa: "APPA Trento + APPA Bolzano",
    portal: "https://www.appa.tn.it",
    api_type: "HTML/CSV",
    water_quality_dataset: "qualita-acque",
    status: "researched",
    notes: "Two provincial agencies (Trento + Bolzano). Data in PDF/CSV reports."
  },
  {
    code: "FVG", name: "Friuli-Venezia Giulia", arpa: "ARPA FVG",
    portal: "https://www.arpa.fvg.it",
    api_type: "CSV/HTML",
    water_quality_dataset: "acque-superficiali",
    status: "researched",
    notes: "CSV downloads available from ARPA FVG ambientale section."
  },
  {
    code: "LIG", name: "Liguria", arpa: "ARPAL",
    portal: "https://www.arpalge.net",
    api_type: "HTML/PDF",
    water_quality_dataset: "qualita-acque-corpi-idrici",
    status: "researched",
    notes: "PDF reports. No structured API. Would need scraping."
  },
  {
    code: "EMR", name: "Emilia-Romagna", arpa: "ARPAE",
    portal: "https://dati.arpae.it",
    api_type: "CKAN/ArcGIS",
    water_quality_dataset: "rete-regionale-per-la-qualita-ambientale-acque-superficiali-fluviali-dati-2010-2025",
    status: "integrated",
    notes: "Integrated via dati.arpae.it (Google Sheets CSV): 102 rivers (Asta), 174 stations, 14 params, measurements 2010-2025."
  },
  {
    code: "TOS", name: "Toscana", arpa: "ARPAT",
    portal: "https://dati.toscana.it",
    api_type: "CKAN",
    water_quality_dataset: "bacino-arno-stato-ecologico-e-chimico-delle-acque-superficiali",
    status: "integrated",
    notes: "Integrated via CKAN CSV: Arno (84 corpi idrici), Serchio (19), Ombrone (48), Albegna, Bruna, Merse, Versilia. Stato ecologico/chimico WFD per corpo idrico."
  },
  {
    code: "UMB", name: "Umbria", arpa: "ARPA Umbria",
    portal: "https://www.arpa.umbria.it",
    api_type: "CSV/HTML",
    water_quality_dataset: "acque-superficiali",
    status: "researched",
    notes: "Data available in CSV from ARPA Umbria website."
  },
  {
    code: "LAZ", name: "Lazio", arpa: "ARPA Lazio",
    portal: "https://www.arpalazio.it",
    api_type: "HTML/PDF",
    water_quality_dataset: "qualita-acque-superficiali",
    status: "researched",
    notes: "PDF reports per monitoring station. No structured API."
  },
  {
    code: "MAR", name: "Marche", arpa: "ARPAM",
    portal: "https://www.arpam.marche.it",
    api_type: "HTML/CSV",
    water_quality_dataset: "acque-superficiali",
    status: "researched",
    notes: "CSV data available from ARPAM monitoring section."
  },
  {
    code: "ABR", name: "Abruzzo", arpa: "ARTA Abruzzo",
    portal: "https://www.arta.abruzzo.it",
    api_type: "HTML/PDF",
    water_quality_dataset: "acque-superficiali",
    status: "researched",
    notes: "PDF reports. Limited structured data."
  },
  {
    code: "MOL", name: "Molise", arpa: "ARPAM Molise",
    portal: "https://www.arpamolise.it",
    api_type: "HTML/PDF",
    water_quality_dataset: "acque-corpi-idrici",
    status: "researched",
    notes: "Limited online data. PDF reports only."
  },
  {
    code: "CAM", name: "Campania", arpa: "ARPAC",
    portal: "https://www.arpacampania.it",
    api_type: "HTML/CSV",
    water_quality_dataset: "acque-superficiali",
    status: "researched",
    notes: "Some CSV data available from ARPAC monitoring section."
  },
  {
    code: "PUG", name: "Puglia", arpa: "ARPA Puglia",
    portal: "https://www.arpa.puglia.it",
    api_type: "CKAN/HTML",
    water_quality_dataset: "acque-superficiali",
    status: "researched",
    notes: "Data available via regional open data portal (dati.puglia.it)."
  },
  {
    code: "BAS", name: "Basilicata", arpa: "ARPAB",
    portal: "https://www.arpab.it",
    api_type: "HTML/PDF",
    water_quality_dataset: "acque-superficiali",
    status: "researched",
    notes: "PDF reports. No structured API."
  },
  {
    code: "CAL", name: "Calabria", arpa: "ARPACAL",
    portal: "https://www.arpacal.it",
    api_type: "HTML/PDF",
    water_quality_dataset: "acque-superficiali",
    status: "researched",
    notes: "Limited online data. PDF reports."
  },
  {
    code: "SIC", name: "Sicilia", arpa: "ARPA Sicilia",
    portal: "https://www.arpa.sicilia.it",
    api_type: "HTML/CSV",
    water_quality_dataset: "acque-superficiali",
    status: "researched",
    notes: "Some data via regional open data portal (dati.regione.sicilia.it)."
  },
  {
    code: "SAR", name: "Sardegna", arpa: "ARPAS",
    portal: "https://www.sardegnaambiente.it",
    api_type: "CKAN/HTML",
    water_quality_dataset: "acque-superficiali",
    status: "researched",
    notes: "Data via Sardegna Ambientale portal. Some WMS services."
  },
  {
    code: "VDA", name: "Valle d'Aosta", arpa: "ARPA VdA",
    portal: "https://Arpa.Vda.It",
    api_type: "HTML/CSV",
    water_quality_dataset: "acque-superficiali",
    status: "researched",
    notes: "Small region. CSV data available from ARPA VdA website."
  }
];

// Major Italian rivers to fetch geometries for (for national coverage)
export const MAJOR_ITALIAN_RIVERS = [
  "Po", "Adige", "Tevere", "Arno", "Adda", "Lambro", "Ticino",
  "Mincio", "Oglio", "Brembo", "Serio", "Seveso", "Mella",
  "Chiese", "Sesia", "Tanaro", "Trebbia", "Taro", "Reno",
  "Volturno", "Garigliano", "Aterno", "Ofanto", "Basento",
  "Simeto", "Nera", "Velino", "Tronto", "Metauro", "Foglia",
  "Marecchia", "Conca", "Uso", "Piave", "Tagliamento", "Isonzo",
  "Liri", "Sacco", "Aniene", "Ombrone", "Serchio", "Magra"
];

// EEA Industrial Emissions Portal — European industrial sites
// The portal uses Volto SSR + internal Elasticsearch (not publicly queryable).
// Data is downloadable as bulk CSV from the dataset page.
export const EEA_IED = {
  portal: "https://industry.eea.europa.eu",
  dataset_page: "https://industry.eea.europa.eu/industrial-emissions/dataset",
  // The map data comes from "site-map-table" data connector
  // Per-site detail: "site-header", "site-environmental-information"
  // Bulk download link (HTML page, needs manual or headless browser)
  bulk_download_hint: "https://industry.eea.europa.eu/industrial-emissions/dataset",
  license: "EEA standard re-use conditions (CC-BY 4.0)",
  notes: "No public REST API. Data is server-rendered in Volto SSR HTML. " +
         "Bulk CSV download requires navigating the SPA (JavaScript-driven). " +
         "For programmatic access, use OSM Overpass for industrial POIs instead, " +
         "or download the E-PRTR CSV manually from the dataset page."
};