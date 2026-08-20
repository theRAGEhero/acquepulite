import { useEffect, useState } from "react";
import FacilitiesPanel from "./FacilitiesPanel.jsx";

const WFD_LABEL = {
  high: "High", good: "Good", moderate: "Moderate",
  poor: "Poor", bad: "Bad"
};

function scoreColor(score) {
  if (score == null) return "#8ca5be";
  const stops = [
    [0.00, [22, 140, 255]], [0.25, [32, 201, 255]], [0.45, [255, 212, 59]],
    [0.65, [255, 140, 26]], [0.85, [255, 59, 48]], [1.00, [185, 28, 28]]
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [s0, c0] = stops[i], [s1, c1] = stops[i + 1];
    if (score >= s0 && score <= s1) {
      const t = (score - s0) / (s1 - s0 || 1);
      return `rgb(${Math.round(c0[0]+(c1[0]-c0[0])*t)},${Math.round(c0[1]+(c1[1]-c0[1])*t)},${Math.round(c0[2]+(c1[2]-c0[2])*t)})`;
    }
  }
  return `rgb(185,28,28)`;
}

export default function RiverPanel({
  river, onStationClick, facilities, facilitiesLoading, facilitiesError
}) {
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [facilitiesStation, setFacilitiesStation] = useState(null);
  const [knowledge, setKnowledge] = useState(null);
  const [knowledgeLoading, setKnowledgeLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setSummary(null);
    setFacilitiesStation(null);
    fetch(`/api/rivers/${river.id}/pollution-summary`)
      .then(r => r.json())
      .then(d => { setSummary(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [river.id]);

  useEffect(() => {
    setKnowledge(null);
    setKnowledgeLoading(true);
    fetch(`/api/rivers/${river.id}/knowledge`)
      .then(response => response.json())
      .then(data => { setKnowledge(data); setKnowledgeLoading(false); })
      .catch(() => setKnowledgeLoading(false));
  }, [river.id]);

  const handleStationClick = (s) => {
    onStationClick(s.lat, s.lon);
    setFacilitiesStation(s);
  };

  const isArpa = summary?.source === "ARPA Lombardia";
  const isArpae = summary?.source === "ARPAE Emilia-Romagna";
  const isStatusAssessment = summary?.assessment_type === "water_body_status";

  return (
    <>
      <h1>{river.name}</h1>
      <div className="meta">
        {river.region && <>{river.region} · </>}
        {river.length_km ? <>{river.length_km} km · </> : null}
        {river.wfd_status && (
          <span className={`badge ${river.wfd_status}`}>
            WFD: {WFD_LABEL[river.wfd_status]}
          </span>
        )}
        {(isArpa || isArpae || isStatusAssessment) && <span className="badge real" style={{ marginLeft: 4 }}>Official agency data</span>}
      </div>

      {river.geometry_source && (
        <div className="meta" style={{ marginTop: 6 }}>
          River line: <a className="source-link" href={geometrySourceUrl(river)} target="_blank" rel="noreferrer">{river.geometry_source} ↗</a>
          {river.source_dataset_version && <> · {river.source_dataset_version}</>}
          {river.geometry_quality && <> · {river.geometry_quality}</>}
        </div>
      )}

      <KnowledgeCard data={knowledge} loading={knowledgeLoading} />

      <RiverCompanies data={facilities} loading={facilitiesLoading} error={facilitiesError}
        onCompanyClick={onStationClick} />

      {loading && <div className="loading">Loading pollution data…</div>}

      {!loading && summary && !isArpa && !isArpae && !isStatusAssessment && (
        <div className="empty" style={{ marginTop: 30 }}>
          <p style={{ fontSize: 15, marginBottom: 6 }}>No real ARPA data available</p>
          <p style={{ fontSize: 13 }}>This river has no monitoring stations with real measurements yet.</p>
        </div>
      )}

      {summary && (isArpa || isArpae) && (
        <>
          <div className="meta" style={{ marginBottom: 8 }}>
            <small>
              Source: <SourceLink href={summary.source_url}>{summary.source}</SourceLink>
              {summary.source_period && <> · {summary.source_period}</>}
              {summary.source_license && <> · <SourceLink href={summary.source_license_url}>{summary.source_license}</SourceLink></>}
              {summary.fetched_at && <> · fetched {new Date(summary.fetched_at).toLocaleString()}</>}
            </small>
          </div>

          <div className="section-title">Measured pollution parameters</div>
          <div className="assessment-note">Values come from the linked agency dataset. Thresholds shown below are dashboard screening references, not a legal compliance ruling.</div>
          {summary.parameters.map(p => {
            const pct = p.legal_limit
              ? Math.min(100, (p.avg / p.legal_limit) * 100)
              : 50;
            const overLimit = p.legal_limit && p.avg > p.legal_limit;
            return (
              <div className="param-card" key={p.param_code}>
                <div className="top">
                  <div className="name">{p.param_name}</div>
                  <div>
                    <span className={`val ${overLimit ? "over-limit" : ""}`}>{p.avg}</span>
                    <span className="unit">{p.unit}</span>
                  </div>
                </div>
                <div className="limit">
                  avg of {p.stations?.length || 0} station(s) · max {p.max}
                  {p.legal_limit
                    ? ` · screening reference ${p.legal_limit} ${p.unit}`
                    : " · no screening reference"}
                </div>
                <div className="bar">
                  <div style={{
                    width: `${pct}%`,
                    background: scoreColor(p.legal_limit ? p.avg / p.legal_limit : 0.3)
                  }}></div>
                </div>
              </div>
            );
          })}

          <div className="section-title">Monitoring stations</div>
          {summary.stations.map(s => (
            <div
              key={s.id}
              className="station-item"
              onClick={() => handleStationClick(s)}
              style={{ justifyContent: "space-between" }}
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="dot real"></span>
                {s.name}
              </span>
              {facilitiesStation?.id === s.id && <span style={{ fontSize: 10, color: "#2563eb" }}>●</span>}
            </div>
          ))}

          {facilitiesStation && (
            <FacilitiesPanel
              station={facilitiesStation}
              onClose={() => setFacilitiesStation(null)}
              onFacilityClick={onStationClick}
            />
          )}
        </>
      )}

      {summary && isStatusAssessment && (
        <>
          <div className="source-strip">
            Source: <SourceLink href={summary.source_url}>{summary.source}</SourceLink>
            {summary.source_period && <> · {summary.source_period}</>}
            {summary.source_license && <> · <SourceLink href={summary.source_license_url}>{summary.source_license}</SourceLink></>}
          </div>
          <WfdGuide method={summary.assessment_method} />

          <div className="section-title">Water bodies ({summary.stretches?.length || 0})</div>
          {summary.stretches?.map(s => {
            const ecological = statusInfo(s.ecological);
            const chemical = chemicalInfo(s.chemical);
            const indicator = statusInfo(s.status);
            return (
              <div key={`${s.water_body_code || "body"}-${s.name}`} className="param-card water-body-card">
                <div className="top">
                  <div className="name">{s.name}</div>
                  <span className={`objective-chip ${s.meets_wfd_objective ? "met" : "failed"}`}>
                    {s.meets_wfd_objective ? "WFD objective met" : "WFD objective not met"}
                  </span>
                </div>
                {s.comune && <div className="water-body-location">{s.comune}</div>}
                <div className="status-components">
                  {s.ecological && <StatusComponent label="Ecological status" raw={s.ecological} info={ecological} />}
                  {s.chemical && <StatusComponent label="Chemical status" raw={s.chemical} info={chemical} />}
                  {s.indicator && <StatusComponent label={`${s.indicator}${s.indicator_year ? ` ${s.indicator_year}` : ""}`} raw={s.status} info={indicator} />}
                </div>
                <div className="bar">
                  <div style={{
                    width: `${(s.score ?? 0) * 100}%`,
                    background: scoreColor(s.score)
                  }}></div>
                </div>
                {s.source_url && <div className="record-source"><SourceLink href={s.source_url}>Source record/dataset ↗</SourceLink></div>}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

const ECOLOGICAL_STATUS = {
  Elevato: { tone: "high", verdict: "Very good", explanation: "Best class; ecosystem is close to undisturbed conditions." },
  Buono: { tone: "good", verdict: "Good", explanation: "The WFD ecological objective is met." },
  Sufficiente: { tone: "moderate", verdict: "Below target", explanation: "Moderate ecological quality. It is not ‘good’; improvement is required." },
  Scarso: { tone: "poor", verdict: "Poor", explanation: "Clearly degraded ecological quality; the WFD objective is not met." },
  Cattivo: { tone: "bad", verdict: "Bad", explanation: "Worst class; the ecosystem is seriously degraded." }
};

function statusInfo(status) {
  return ECOLOGICAL_STATUS[status] || { tone: "nodata", verdict: "Not classified", explanation: "No interpretable classification was supplied." };
}

function chemicalInfo(status) {
  if (/^buono$/i.test(status || "")) return { tone: "good", verdict: "Pass", explanation: "Priority-substance environmental standards are achieved." };
  if (/^non\s*buono$/i.test(status || "")) return { tone: "bad", verdict: "Fail", explanation: "At least one priority-substance standard is not achieved." };
  return { tone: "nodata", verdict: "Not classified", explanation: "No chemical-status classification was supplied." };
}

function StatusComponent({ label, raw, info }) {
  return (
    <div className={`status-component ${info.tone}`}>
      <div><span>{label}</span><strong>{raw} · {info.verdict}</strong></div>
      <p>{info.explanation}</p>
    </div>
  );
}

function WfdGuide({ method }) {
  const limecoOnly = /LIMeco/i.test(method || "");
  return (
    <div className="wfd-guide">
      <strong>How to read these classes</strong>
      {limecoOnly ? (
        <p>LIMeco measures nutrients and dissolved oxygen. Elevato/Buono are favorable; Sufficiente, Scarso and Cattivo indicate progressively worse conditions. LIMeco alone is not the complete WFD ecological classification.</p>
      ) : (
        <p>Ecological status has five classes: Elevato and Buono are favorable. Sufficiente is moderate and already below the WFD objective; Scarso is poor; Cattivo is the worst. Chemical status is only Buono (pass) or Non buono (fail). The overall objective fails when either component fails.</p>
      )}
      <a href={limecoOnly
        ? "https://www.arpa.veneto.it/dati-ambientali/open-data/idrosfera/corsi-dacqua/limeco-livello-di-inquinamento-espresso-dai-macrodescrittori-per-lo-stato-ecologico-dei-corsi-dacqua"
        : "https://www.arpa.piemonte.it/temi/acqua/qualita-delle-acque"}
        target="_blank" rel="noreferrer">Official class explanation ↗</a>
    </div>
  );
}

function SourceLink({ href, children }) {
  return href
    ? <a className="source-link" href={href} target="_blank" rel="noreferrer">{children}</a>
    : <b>{children}</b>;
}

function geometrySourceUrl(river) {
  if (/OpenStreetMap/i.test(river.geometry_source || "")) return "https://www.openstreetmap.org/copyright";
  if (/WISE|WFD 2022/i.test(river.geometry_source || "")) return "https://water.discomap.eea.europa.eu/arcgis/rest/services/WISE_WFD/WFD2022_SurfaceWaterBody_WM/MapServer/16";
  return river.source_url || "https://water.europa.eu/freshwater";
}

function RiverCompanies({ data, loading, error, onCompanyClick }) {
  const [showAll, setShowAll] = useState(false);
  const [category, setCategory] = useState("all");
  useEffect(() => { setShowAll(false); setCategory("all"); }, [data?.river?.id]);
  const categories = [...new Set((data?.facilities || []).map(item => item.category))];
  const filtered = (data?.facilities || []).filter(item => category === "all" || item.category === category);
  const visible = showAll ? filtered : filtered.slice(0, 16);

  return (
    <section className="river-companies">
      <div className="section-title">
        <span>Companies / potential sources near river</span>
        {data && <span>{data.count} within {(data.radius_m / 1000).toFixed(0)} km</span>}
      </div>
      <div className="facility-method">
        Corridor distance is calculated against the actual river line. Click a company to locate it on the map.
      </div>
      {loading && <div className="loading">Scanning OpenStreetMap and the installed EEA registry…</div>}
      {error && <div className="facility-warning">Facility scan failed: {error}</div>}
      {data?.warning && <div className="facility-warning">{data.warning}</div>}
      {data && data.count === 0 && <div className="loading">No mapped companies found in this corridor.</div>}
      {data && data.count > 0 && (
        <>
          <div className="facility-toolbar">
            <span>OSM {data.osm_count} · EEA {data.eea_count}</span>
            <select value={category} onChange={event => { setCategory(event.target.value); setShowAll(false); }}>
              <option value="all">All categories</option>
              {categories.map(value => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
            </select>
          </div>
          <div className="company-grid">
            {visible.map(company => (
              <div key={company.id} className="company-row">
                <button className="company-locate" onClick={() => onCompanyClick(company.lat, company.lon)}>
                  <span className={`company-symbol ${company.category}`} />
                  <span className="company-main">
                    <strong>{company.name}</strong>
                    <small>{company.category_label} · {company.source}</small>
                  </span>
                  <span className="company-distance">{company.distance_to_river_m < 1000
                    ? `${company.distance_to_river_m} m`
                    : `${(company.distance_to_river_m / 1000).toFixed(1)} km`}</span>
                </button>
                {(company.osm_url || company.external_url) && <a className="company-source" href={company.osm_url || company.external_url} target="_blank" rel="noreferrer" title="Open source record">↗</a>}
              </div>
            ))}
          </div>
          {filtered.length > 16 && (
            <button className="show-companies" onClick={() => setShowAll(value => !value)}>
              {showAll ? "Show first 16" : `Show all ${filtered.length}`}
            </button>
          )}
          <div className="facility-attribution">OpenStreetMap coverage depends on contributed tags. EEA entries appear when the bulk Industrial Emissions dataset is installed.</div>
        </>
      )}
    </section>
  );
}

function KnowledgeCard({ data, loading }) {
  if (loading) return <div className="knowledge-card loading">Resolving Wikidata identity…</div>;
  if (!data?.available) {
    return (
      <div className="knowledge-card unresolved">
        <div className="knowledge-kicker">Wikimedia identity</div>
        <p>No sufficiently reliable river match was found.</p>
        {data?.candidates?.length > 0 && (
          <div className="candidate-links">
            Candidate records: {data.candidates.map((candidate, index) => (
              <span key={candidate.id}>
                {index > 0 && " · "}
                <a href={candidate.wikidata_url} target="_blank" rel="noreferrer">{candidate.label}</a>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <section className="knowledge-card">
      {data.wikipedia?.thumbnail && <img src={data.wikipedia.thumbnail} alt="" loading="lazy" />}
      <div className="knowledge-content">
        <div className="knowledge-kicker">
          Wikimedia dossier · {data.match.confidence} confidence · {data.match.id}
        </div>
        <h2>{data.wikipedia?.title || data.match.label}</h2>
        <p>{data.wikipedia?.extract || data.match.description}</p>
        {data.facts?.length > 0 && (
          <div className="knowledge-facts">
            {data.facts.map(fact => (
              <div key={fact.property}>
                <span>{fact.label}</span>
                {fact.url
                  ? <a href={fact.url} target="_blank" rel="noreferrer">{fact.value}</a>
                  : <strong>{fact.value}{fact.unit ? ` ${fact.unit}` : ""}</strong>}
              </div>
            ))}
          </div>
        )}
        <div className="knowledge-links">
          {data.wikipedia && <a href={data.wikipedia.url} target="_blank" rel="noreferrer">Wikipedia ↗</a>}
          <a href={data.match.wikidata_url} target="_blank" rel="noreferrer">Wikidata ↗</a>
        </div>
        <div className="incident-section">
          <div className="knowledge-kicker">Environmental incidents linked through Wikidata</div>
          {data.environmental_incidents?.length ? data.environmental_incidents.map(incident => (
            <article className="incident-row" key={incident.id}>
              <div>
                <strong>{incident.label}</strong>
                <span>{incident.date || "Date not structured"} · {incident.confidence} confidence</span>
                <p>{incident.description || incident.relation}</p>
                <small>{incident.relation}</small>
              </div>
              <div className="incident-links">
                {incident.wikipedia && <a href={incident.wikipedia.url} target="_blank" rel="noreferrer">Wikipedia ↗</a>}
                <a href={incident.wikidata_url} target="_blank" rel="noreferrer">Wikidata ↗</a>
              </div>
            </article>
          )) : (
            <p className="no-incidents">No sufficiently reliable environmental incident is directly structured for this river in Wikidata. This means “not found in Wikidata,” not “no incident occurred.”</p>
          )}
        </div>
      </div>
    </section>
  );
}
