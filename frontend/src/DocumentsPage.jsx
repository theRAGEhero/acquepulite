import { useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "./telemetry.js";
import RiverGallery from "./RiverGallery.jsx";

const TYPE_ICONS = {
  report: "▤", study: "◈", legal: "§", monitoring: "◉", press: "✎", other: "▢"
};

export default function DocumentsPage({ onBack, onShowRiverDocuments }) {
  const [data, setData] = useState(null);
  const [riversIndex, setRiversIndex] = useState([]);
  const [regions, setRegions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [region, setRegion] = useState("");
  const [river, setRiver] = useState("");
  const [year, setYear] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const documentsRef = useRef(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    Promise.all([fetchJson("/api/rivers-index"), fetchJson("/api/regions")])
      .then(([riverData, regionData]) => {
        setRiversIndex(riverData.rivers || []);
        setRegions(regionData || []);
      })
      .catch(() => { /* Indexes are optional; the document list still works. */ });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (type) params.set("type", type);
    if (region) params.set("region", region);
    if (river) params.set("river", river);
    if (year) params.set("year", year);
    setLoading(true);
    setError(null);
    fetchJson(`/api/documents?${params}`, { signal: controller.signal })
      .then(payload => { setData(payload); setLoading(false); })
      .catch(err => {
        if (err.name === "AbortError") return;
        setError(err.message);
        setLoading(false);
      });
    return () => controller.abort();
  }, [debouncedQuery, type, region, river, year]);

  const activeFilters = [debouncedQuery, type, region, river, year].filter(Boolean).length;
  const documents = data?.documents || [];
  const facets = data?.facets || { types: [], regions: [], years: [], rivers: [] };
  const regionNames = useMemo(() => {
    const map = new Map(regions.map(item => [item.code, item.name]));
    return map;
  }, [regions]);

  const resetFilters = () => {
    setQuery(""); setType(""); setRegion(""); setRiver(""); setYear("");
  };

  const showRiverDocuments = riverItem => {
    setRiver(riverItem.id);
    setQuery("");
    setType("");
    setRegion("");
    setYear("");
    documentsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="documents-page">
      <header className="documents-header">
        <div className="documents-title">
          <span className="system-mark">AP//IT</span>
          <div>
            <h1>River documents</h1>
            <p>Archive of reports, studies and legal documents for every river. The database is filled over time — the page stays accessible while it grows.</p>
          </div>
        </div>
        <button className="documents-back" onClick={onBack}>← Back to map</button>
      </header>

      <section className="documents-filters" aria-label="Document filters" ref={documentsRef}>
        <label className="documents-search">
          <span>Search</span>
          <input type="search" value={query} placeholder="Title, author, river, tag…"
            onChange={event => setQuery(event.target.value)} />
        </label>
        <label>
          <span>Type</span>
          <select value={type} onChange={event => setType(event.target.value)}>
            <option value="">All types</option>
            {(data?.types || []).map(item => (
              <option key={item.value} value={item.value}>{item.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Region</span>
          <select value={region} onChange={event => setRegion(event.target.value)}>
            <option value="">All regions</option>
            {regions.map(item => (
              <option key={item.code} value={item.code}>{item.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>River</span>
          <select value={river} onChange={event => setRiver(event.target.value)}>
            <option value="">All rivers</option>
            {riversIndex.map(item => (
              <option key={item.id} value={item.id}>{item.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Year</span>
          <select value={year} onChange={event => setYear(event.target.value)}>
            <option value="">All years</option>
            {facets.years.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <button className="documents-reset" onClick={resetFilters} disabled={!activeFilters}>
          Reset
        </button>
      </section>

      <div className="documents-count">
        {loading ? "Loading archive…" : `${documents.length} document${documents.length === 1 ? "" : "s"}`}
        {activeFilters > 0 && !loading ? ` · ${activeFilters} filter${activeFilters === 1 ? "" : "s"} active` : ""}
      </div>

      {error && (
        <div className="documents-error">
          <strong>Archive unavailable</strong>
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && documents.length === 0 && (
        <div className="documents-empty">
          <h2>{activeFilters ? "No documents match these filters" : "The archive is empty for now"}</h2>
          <p>
            Documents are added as files. Drop a JSON metadata entry into
            <code> backend/data/documents/</code> and the file itself into
            <code> backend/data/documents/files/</code>, then restart the backend.
          </p>
          <pre>{`{
  "id": "po-2024-report",
  "title": "Relazione annuale Po 2024",
  "river_ids": ["po"],
  "river_names": ["Po"],
  "region_codes": ["LOM"],
  "type": "report",
  "year": 2024,
  "author": "ARPA Lombardia",
  "description": "…",
  "file": "po-2024-report.pdf",
  "language": "it",
  "tags": ["wfd", "nitrates"]
}`}</pre>
        </div>
      )}

      {!loading && documents.length > 0 && (
        <ul className="documents-list">
          {documents.map(doc => (
            <li key={doc.id} className="document-card">
              <div className="document-icon">{TYPE_ICONS[doc.type] || TYPE_ICONS.other}</div>
              <div className="document-main">
                <div className="document-topline">
                  <span className="document-type">{doc.type}</span>
                  {doc.year && <span className="document-year">{doc.year}</span>}
                  {doc.language && <span className="document-lang">{doc.language.toUpperCase()}</span>}
                </div>
                <h3>{doc.title}</h3>
                {doc.author && <p className="document-author">{doc.author}{doc.date ? ` · ${doc.date}` : ""}</p>}
                {doc.description && <p className="document-description">{doc.description}</p>}
                <div className="document-meta">
                  {doc.river_names.length > 0 && (
                    <span className="document-rivers">
                      {doc.river_names.map(name => <em key={name}>{name}</em>)}
                    </span>
                  )}
                  {doc.region_codes.length > 0 && (
                    <span className="document-regions">
                      {doc.region_codes.map(code => (
                        <em key={code}>{regionNames.get(code) || code}</em>
                      ))}
                    </span>
                  )}
                  {doc.tags.length > 0 && (
                    <span className="document-tags">
                      {doc.tags.map(tag => <em key={tag}>#{tag}</em>)}
                    </span>
                  )}
                </div>
              </div>
              <div className="document-actions">
                {doc.file && (
                  <a className="document-download" href={`/api/documents/${doc.id}/file`} download>
                    Download
                  </a>
                )}
                {doc.url && (
                  <a className="document-download" href={doc.url} target="_blank" rel="noreferrer">
                    Open source ↗
                  </a>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {data?.load_errors?.length > 0 && (
        <p className="documents-load-errors">
          {data.load_errors.length} archive entr{data.load_errors.length === 1 ? "y" : "ies"} skipped: {data.load_errors.join("; ")}
        </p>
      )}

      <RiverGallery rivers={riversIndex} regions={regions} onOpenRiver={showRiverDocuments} />
    </div>
  );
}
