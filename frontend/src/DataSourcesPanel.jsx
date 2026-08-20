import { useEffect, useState } from "react";
import { fetchJson } from "./telemetry.js";

export default function DataSourcesPanel() {
  const [data, setData] = useState(null);
  const [eea, setEea] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchJson("/api/data-sources", { signal: controller.signal })
      .then(setData)
      .catch(error => { if (error.name !== "AbortError") setData(null); });
    fetchJson("/api/eea/status", { signal: controller.signal })
      .then(setEea)
      .catch(error => { if (error.name !== "AbortError") setEea(null); });
    return () => controller.abort();
  }, []);

  if (!data) return <div className="loading">Loading data sources…</div>;

  const regionItems = data.water_quality.regions || [];
  const integrated = regionItems.filter(r => r.status === "integrated");
  const baseline = regionItems.filter(r => r.status !== "integrated");

  return (
    <>
      <div className="section-title">Data Sources</div>

      {(data.water_quality.sources || []).map(source => (
        <div className="param-card" style={{ borderLeft: "3px solid #2563eb" }} key={source.region}>
          <div className="name" style={{ fontSize: 13 }}>{source.region} — {source.name}</div>
          <div className="limit">
            {source.notes}<br/>
            Dataset: <Source href={source.source_url}>{source.dataset}</Source><br/>
            {source.download_url && <>Direct data: <Source href={source.download_url}>CSV download</Source><br/></>}
            License: <Source href={source.license_url}>{source.license}</Source>
          </div>
        </div>
      ))}

      {data.water_quality.national_baseline && (
        <div className="param-card" style={{ borderLeft: "3px solid #20c9ff" }}>
          <div className="name" style={{ fontSize: 13 }}>National coverage — EEA WISE WFD 2022</div>
          <div className="limit">
            {data.water_quality.national_baseline.rivers.toLocaleString()} mapped rivers supplement regions without a dedicated agency adapter.<br/>
            Status and geometry: <Source href={data.water_quality.national_baseline.source_url}>EEA WISE WFD</Source><br/>
            Regional assignment: <Source href={data.water_quality.national_baseline.region_boundary_source}>Eurostat GISCO NUTS 2024</Source><br/>
            License: <Source href={data.water_quality.national_baseline.license_url}>{data.water_quality.national_baseline.license}</Source>
          </div>
        </div>
      )}

      <div className="param-card" style={{ borderLeft: "3px solid #22c55e" }}>
        <div className="name" style={{ fontSize: 13 }}>River Geometries — Official + OSM fallback</div>
        <div className="limit">
          {data.river_geometries.rivers_loaded} of {data.river_geometries.rivers_total} rivers with real geometry<br/>
          Official: {data.river_geometries.official_rivers || 0} · OSM fallback: {data.river_geometries.osm_fallback_rivers || 0}<br/>
          Artificial connectors: {data.river_geometries.artificial_connectors}<br/>
          Sources: <Source href={data.river_geometries.eea_url}>WISE WFD 2022</Source> · {" "}
          <Source href={data.river_geometries.osm_url}>OpenStreetMap</Source><br/>
          License: {data.river_geometries.license}
        </div>
      </div>

      <div className="param-card" style={{ borderLeft: "3px solid #f97316" }}>
        <div className="name" style={{ fontSize: 13 }}>Industrial Facilities — OSM Overpass</div>
        <div className="limit">
          Categories: {data.industrial_facilities.categories.join(", ")}<br/>
          API: <Source href={data.industrial_facilities.source_url}>Overpass API</Source><br/>
          License: <Source href={data.industrial_facilities.license_url}>{data.industrial_facilities.license}</Source>
        </div>
      </div>

      <div className="param-card" style={{ borderLeft: "3px solid #20c9ff" }}>
        <div className="name" style={{ fontSize: 13 }}>Wikidata + Wikipedia</div>
        <div className="limit">
          River identities, incident relationships, and nearby-place populations: <Source href={data.wikimedia.wikidata_url}>Wikidata</Source> ({data.wikimedia.wikidata_license})<br/>
          Population statements: <Source href={data.wikimedia.population_property_url}>population (P1082)</Source> with <Source href={data.wikimedia.point_in_time_property_url}>point in time (P585)</Source><br/>
          Corridor discovery: <Source href={data.wikimedia.query_service_docs_url}>Wikidata geospatial query documentation</Source><br/>
          Descriptions and article links: <Source href={data.wikimedia.wikipedia_url}>Wikipedia</Source> ({data.wikimedia.wikipedia_license})<br/>
          <Source href={data.wikimedia.environmental_incident_class_url}>Environmental-disaster class</Source> · {" "}
          <Source href={data.wikimedia.api_docs_url}>Wikidata API</Source> · {" "}
          <Source href={data.wikimedia.wikipedia_api_docs_url}>Wikimedia REST API</Source>
        </div>
      </div>

      <div className="param-card" style={{ borderLeft: "3px solid #8b5cf6" }}>
        <div className="name" style={{ fontSize: 13 }}>EEA Industrial Emissions Portal</div>
        <div className="limit">
          {eea?.available ? (
            <>
              <b style={{ color: "#15803d" }}>{eea.sites_italy.toLocaleString()} Italian industrial sites loaded</b><br/>
              Source: <Source href={data?.eea_industrial_emissions?.dataset_page}>EEA Industrial Emissions Portal</Source><br/>
              Sectors, pollutants, river basin districts per site<br/>
              License: <Source href={data?.eea_industrial_emissions?.license_url}>{data?.eea_industrial_emissions?.license}</Source>
            </>
          ) : (
            <>
              <a href={data?.eea_industrial_emissions?.dataset_page} target="_blank" rel="noopener"
                 style={{ color: "#2563eb", textDecoration: "none" }}>
                Download bulk dataset →
              </a><br/>
              <Source href={data?.eea_industrial_emissions?.license_url}>{data?.eea_industrial_emissions?.license}</Source>
            </>
          )}
        </div>
      </div>

      <div className="section-title" style={{ marginTop: 18 }}>
        Italian Coverage ({regionItems.length}/20 regions)
      </div>

      {integrated.map(r => (
        <div key={r.code} className="station-item" style={{ cursor: "default", background: "#f0fdf4" }}>
          <span className="dot real"></span>
          <span style={{ flex: 1 }}>
            <Source href={r.dataset_url || r.portal}><b>{r.name}</b> — {r.arpa}</Source>
          </span>
          <span className="badge good">Active</span>
        </div>
      ))}

      <div style={{ fontSize: 11, color: "#8896a8", margin: "10px 0 6px", fontWeight: 600 }}>
        EEA WFD national baseline ({baseline.length})
      </div>

      {baseline.map(r => (
        <div key={r.code} className="station-item" style={{ cursor: "default", fontSize: 12 }}>
          <span className="dot real"></span>
          <span style={{ flex: 1 }}>
            <Source href={r.portal}><b>{r.name}</b> — {r.arpa}</Source>
          </span>
          <span className="badge moderate">WISE baseline</span>
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

function Source({ href, children }) {
  return href
    ? <a href={href} target="_blank" rel="noreferrer" className="source-link">{children} ↗</a>
    : <>{children}</>;
}
