import { useEffect, useState } from "react";

export default function DataSourcesPanel() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/api/data-sources")
      .then(r => r.json())
      .then(setData)
      .catch(() => setData(null));
  }, []);

  if (!data) return <div className="loading">Loading data sources…</div>;

  const regionItems = data.water_quality.regions || [];
  const integrated = regionItems.filter(r => r.status === "integrated");
  const researched = regionItems.filter(r => r.status === "researched");

  return (
    <>
      <div className="section-title">Data Sources</div>

      <div className="param-card" style={{ borderLeft: "3px solid #2563eb" }}>
        <div className="name" style={{ fontSize: 13 }}>Water Quality — ARPA Lombardia</div>
        <div className="limit">
          {data.water_quality.coverage}<br/>
          License: {data.water_quality.license}<br/>
          Dataset: {data.water_quality.dataset}
        </div>
      </div>

      <div className="param-card" style={{ borderLeft: "3px solid #22c55e" }}>
        <div className="name" style={{ fontSize: 13 }}>River Geometries — Official + OSM fallback</div>
        <div className="limit">
          {data.river_geometries.rivers_loaded} of {data.river_geometries.rivers_total} rivers with real geometry<br/>
          Official: {data.river_geometries.official_rivers || 0} · OSM fallback: {data.river_geometries.osm_fallback_rivers || 0}<br/>
          Artificial connectors: {data.river_geometries.artificial_connectors}<br/>
          License: {data.river_geometries.license}
        </div>
      </div>

      <div className="param-card" style={{ borderLeft: "3px solid #f97316" }}>
        <div className="name" style={{ fontSize: 13 }}>Industrial Facilities — OSM Overpass</div>
        <div className="limit">
          Categories: {data.industrial_facilities.categories.join(", ")}<br/>
          License: {data.industrial_facilities.license}
        </div>
      </div>

      <div className="param-card" style={{ borderLeft: "3px solid #8b5cf6" }}>
        <div className="name" style={{ fontSize: 13 }}>EEA Industrial Emissions Portal</div>
        <div className="limit">
          <a href={data.eea_industrial_emissions.dataset_page} target="_blank" rel="noopener"
             style={{ color: "#2563eb", textDecoration: "none" }}>
            Download bulk dataset →
          </a><br/>
          {data.eea_industrial_emissions.license}
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 18 }}>
        ARPA Regional Coverage ({integrated.length} integrated)
      </div>

      {integrated.map(r => (
        <div key={r.code} className="station-item" style={{ cursor: "default", background: "#f0fdf4" }}>
          <span className="dot real"></span>
          <span style={{ flex: 1 }}>
            <b>{r.name}</b> — {r.arpa}
          </span>
          <span className="badge good">Active</span>
        </div>
      ))}

      <div style={{ fontSize: 11, color: "#8896a8", margin: "10px 0 6px", fontWeight: 600 }}>
        Researched ({researched.length})
      </div>

      {researched.map(r => (
        <div key={r.code} className="station-item" style={{ cursor: "default", opacity: 0.7, fontSize: 12 }}>
          <span className="dot"></span>
          <span style={{ flex: 1 }}>
            <b>{r.name}</b> — {r.arpa}
          </span>
          <span style={{ fontSize: 10, color: "#8896a8" }}>{r.api_type}</span>
        </div>
      ))}

      <div style={{
        fontSize: 11, color: "#6b7785", marginTop: 16, padding: 10,
        background: "#f8fafc", borderRadius: 8, lineHeight: 1.5
      }}>
        <b>Investigation tool for environmental research.</b><br/>
        This app integrates water quality data from ARPA agencies, real river
        geometries from OpenStreetMap, and nearby industrial facility data to
        help investigate pollution sources along Italian rivers.<br/><br/>
        Last data update: {data.updated_at ? new Date(data.updated_at).toLocaleString() : "unknown"}
      </div>
    </>
  );
}
