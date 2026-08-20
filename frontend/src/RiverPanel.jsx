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

export default function RiverPanel({ river, onStationClick }) {
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
  const isArpat = summary?.source === "ARPAT Toscana (D.M. 260/2010 — WFD)";

  const statusBadge = (status) => {
    const map = {
      "Elevato": "high", "Buono": "good", "Sufficiente": "moderate",
      "Scarso": "poor", "Cattivo": "bad", "Non buono": "bad"
    };
    return map[status] || null;
  };

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
        {(isArpa || isArpae || isArpat) && <span className="badge real" style={{ marginLeft: 4 }}>ARPA real data</span>}
      </div>

      {river.geometry_source && (
        <div className="meta" style={{ marginTop: 6 }}>
          River line: <b>{river.geometry_source}</b>
          {river.source_dataset_version && <> · {river.source_dataset_version}</>}
          {river.geometry_quality && <> · {river.geometry_quality}</>}
        </div>
      )}

      <KnowledgeCard data={knowledge} loading={knowledgeLoading} />

      {loading && <div className="loading">Loading pollution data…</div>}

      {!loading && summary && !isArpa && !isArpae && !isArpat && (
        <div className="empty" style={{ marginTop: 30 }}>
          <p style={{ fontSize: 15, marginBottom: 6 }}>No real ARPA data available</p>
          <p style={{ fontSize: 13 }}>This river has no monitoring stations with real measurements yet.</p>
        </div>
      )}

      {summary && (isArpa || isArpae) && (
        <>
          <div className="meta" style={{ marginBottom: 8 }}>
            <small>
              Source: <b>{summary.source}</b>
              {summary.fetched_at && <> · fetched {new Date(summary.fetched_at).toLocaleString()}</>}
            </small>
          </div>

          <div className="section-title">Pollution parameters</div>
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
                    ? ` · limit ${p.legal_limit} ${p.unit}`
                    : " · no legal limit"}
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

      {summary && isArpat && (
        <>
          <div className="meta" style={{ marginBottom: 8 }}>
            <small>
              Source: <b>ARPAT Toscana</b> — stato ecologico/chimico per corpo idrico
              (WFD · D.M. 260/2010) · triennio 2022-2024
            </small>
          </div>

          <div className="section-title">Water bodies ({summary.stretches?.length || 0})</div>
          {summary.stretches?.map(s => {
            const badge = statusBadge(s.status);
            return (
              <div key={s.name} className="param-card">
                <div className="top">
                  <div className="name">{s.name}</div>
                  {badge && <span className={`badge ${badge}`}>{s.status}</span>}
                </div>
                <div className="limit">
                  {s.comune && <>{s.comune} · </>}
                  {s.ecological && <>Ecol: {s.ecological} · </>}
                  {s.chemical && <>Chem: {s.chemical}</>}
                </div>
                <div className="bar">
                  <div style={{
                    width: `${(s.score ?? 0) * 100}%`,
                    background: scoreColor(s.score)
                  }}></div>
                </div>
              </div>
            );
          })}
        </>
      )}
    </>
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
      </div>
    </section>
  );
}
