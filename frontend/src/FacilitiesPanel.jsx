import { useEffect, useState } from "react";
import { fetchJson } from "./telemetry.js";

const CATEGORY_ICONS = {
  industrial: "🏭",
  farm: "🚜",
  water_treatment: "🚿",
  mining_landfill: "⛏️",
  transport_fuel: "⛽",
  business: "🏢"
};

const CATEGORY_COLORS = {
  industrial: "#ef4444",
  farm: "#84cc16",
  water_treatment: "#06b6d4",
  mining_landfill: "#a16207",
  transport_fuel: "#f97316",
  business: "#8b5cf6"
};

export default function FacilitiesPanel({ station, onClose, onFacilityClick }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [radius, setRadius] = useState(3000);
  const [eea, setEea] = useState(null);
  const [eeaLoading, setEeaLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setData(null);
    const url = `/api/stations/${station.id}/nearby-facilities?radius=${radius}`;
    fetchJson(url, { signal: controller.signal })
      .then(d => { setData(d); setLoading(false); })
      .catch(e => {
        if (e.name === "AbortError") return;
        setError(e.message); setLoading(false);
      });

    // Also fetch EEA industrial sites nearby
    setEeaLoading(true);
    setEea(null);
    fetchJson(`/api/stations/${station.id}/nearby-eea-sites?radius=${radius}`, { signal: controller.signal })
      .then(d => { setEea(d); setEeaLoading(false); })
      .catch(error => { if (error.name !== "AbortError") setEeaLoading(false); });
    return () => controller.abort();
  }, [station.id, radius, attempt]);

  const grouped = {};
  if (data) {
    for (const f of data.facilities) {
      if (!grouped[f.category]) grouped[f.category] = [];
      grouped[f.category].push(f);
    }
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div className="section-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Potential pollution sources</span>
        <button className="close-btn" style={{ position: "static", fontSize: 18 }} onClick={onClose} aria-label="Close facilities">×</button>
      </div>

      <div className="facility-near">
        Near <b>{station.name}</b> ·
        <select
          className="facility-radius-select"
          value={radius}
          onChange={(e) => setRadius(Number(e.target.value))}
          aria-label="Search radius"
        >
          <option value={1000}>1 km</option>
          <option value={3000}>3 km</option>
          <option value={5000}>5 km</option>
          <option value={10000}>10 km</option>
        </select>
      </div>

      {/* --- EEA industrial sites section --- */}
      {eeaLoading && <div className="loading">Querying EEA registry…</div>}
      {eea && !eea.available && (
        <div className="param-card" style={{ borderLeft: "3px solid #8b5cf6" }}>
          <div className="name" style={{ fontSize: 13 }}>EEA Industrial Emissions</div>
          <div className="limit">
            Dataset non caricato. Scarica l'"Industrial reporting dataset" da{" "}
            <a className="facility-eea-link" href="https://industry.eea.europa.eu/industrial-emissions/dataset"
               target="_blank" rel="noopener">industry.eea.europa.eu</a>{" "}
            e scompattalo in <code>backend/data/eea/</code>.
          </div>
        </div>
      )}
      {eea && eea.available && eea.count > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="facility-group-heading eea">
            🏭 EEA regulated sites ({eea.count})
          </div>
          {eea.sites.slice(0, 6).map(s => (
            <div key={s.id} className="station-item" onClick={() => onFacilityClick(s.lat, s.lon)} style={{ paddingLeft: 10 }}>
              <span className="dot" style={{ background: "#8b5cf6" }}></span>
              <span style={{ flex: 1 }}>
                <b>{s.name}</b>
                <span className="facility-distance">
                  {(s.distance_km || 0).toFixed(1)} km
                </span>
                <div className="facility-subline">
                  {s.sector || "Industrial site"}{s.has_releases ? ` · ${s.release_count} releases` : ""}
                </div>
              </span>
            </div>
          ))}
          {eea.sites.length > 6 && (
            <div className="facility-dim" style={{ paddingLeft: 18 }}>+{eea.sites.length - 6} more…</div>
          )}
        </div>
      )}

      {loading && <div className="loading">Querying OpenStreetMap…</div>}
      {error && <div className="loading facility-error">Error: {error}</div>}

      {data?.warning && (
        <div className="facility-warning partial">
          <strong>Partial coverage</strong>{data.warning}
          <button className="show-companies" onClick={() => setAttempt(value => value + 1)} disabled={loading}>Retry OSM scan</button>
        </div>
      )}

      {data && data.count === 0 && data.osm_status !== "unavailable" && (
        <div className="loading">No facilities found within {radius / 1000} km</div>
      )}

      {data && data.count > 0 && (
        <>
          <div className="facility-dim" style={{ marginBottom: 10 }}>
            {data.count} facilities found · Source: {data.source}
          </div>

          {Object.entries(grouped).sort(([a], [b]) => a.localeCompare(b)).map(([cat, items]) => (
            <div key={cat} style={{ marginBottom: 14 }}>
              <div className="facility-group-heading" style={{ color: CATEGORY_COLORS[cat] || undefined }}>
                <span>{CATEGORY_ICONS[cat] || "📍"}</span>
                {items[0].category_label} ({items.length})
              </div>
              {items.slice(0, 8).map(f => (
                <div
                  key={f.id}
                  className="station-item"
                  onClick={() => onFacilityClick(f.lat, f.lon)}
                  style={{ paddingLeft: 10 }}
                >
                  <span className="dot" style={{ background: CATEGORY_COLORS[cat] || "#60a5fa" }}></span>
                  <span style={{ flex: 1 }}>
                    {f.name}
                    <span className="facility-distance">
                      {(f.distance_m / 1000).toFixed(1)} km
                    </span>
                  </span>
                </div>
              ))}
              {items.length > 8 && (
                <div className="facility-dim" style={{ paddingLeft: 18, marginBottom: 4 }}>
                  +{items.length - 8} more…
                </div>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
