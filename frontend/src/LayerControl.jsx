import { useState } from "react";

export default function LayerControl({
  layers, onToggleLayer,
  paramFilter, onParamChange,
  basemap, onBasemapChange
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className={`layer-btn ${open ? "active" : ""}`}
        onClick={() => setOpen(!open)}
        aria-label="Layer controls"
        title="Layers & filters"
      >
        {open ? "✕" : "☰"}
      </button>

      <div className={`layer-control ${open ? "open" : ""}`}>
        <div className="lc-header">
          <span>Layers & Filters</span>
        </div>

        <div className="lc-row">
          <label htmlFor="sw-network">Complete river network (OSM)</label>
          <label className="switch">
            <input id="sw-network" type="checkbox" checked={layers.network !== false}
              onChange={(e) => onToggleLayer("network", e.target.checked)} />
            <span className="slider"></span>
          </label>
        </div>

        <div className="lc-row">
          <label htmlFor="sw-stations">Monitoring stations</label>
          <label className="switch">
            <input id="sw-stations" type="checkbox" checked={layers.stations}
              onChange={(e) => onToggleLayer("stations", e.target.checked)} />
            <span className="slider"></span>
          </label>
        </div>

        <div className="lc-row">
          <label htmlFor="sw-facilities">Nearby facilities (OSM)</label>
          <label className="switch">
            <input id="sw-facilities" type="checkbox" checked={layers.facilities}
              onChange={(e) => onToggleLayer("facilities", e.target.checked)} />
            <span className="slider"></span>
          </label>
        </div>

        <div className="lc-row">
          <label htmlFor="sw-eea-sites">EEA industrial sites</label>
          <label className="switch">
            <input id="sw-eea-sites" type="checkbox" checked={layers.eeaSites}
              onChange={(e) => onToggleLayer("eeaSites", e.target.checked)} />
            <span className="slider"></span>
          </label>
        </div>

        <div className="lc-row">
          <label htmlFor="sw-segments">Per-tract coloring</label>
          <label className="switch">
            <input id="sw-segments" type="checkbox" checked={layers.segments}
              onChange={(e) => onToggleLayer("segments", e.target.checked)} />
            <span className="slider"></span>
          </label>
        </div>

        <div className="lc-row">
          <label htmlFor="sw-labels">River name labels</label>
          <label className="switch">
            <input id="sw-labels" type="checkbox" checked={layers.labels}
              onChange={(e) => onToggleLayer("labels", e.target.checked)} />
            <span className="slider"></span>
          </label>
        </div>

        <div className="lc-row">
          <label htmlFor="sw-terrain">3D Terrain</label>
          <label className="switch">
            <input id="sw-terrain" type="checkbox" checked={layers.terrain}
              onChange={(e) => onToggleLayer("terrain", e.target.checked)} />
            <span className="slider"></span>
          </label>
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: 12, color: "#9ca3af", display: "block", marginBottom: 4 }}>
            Color by pollutant
          </label>
          <select value={paramFilter || ""} onChange={(e) => onParamChange(e.target.value || null)}>
            <option value="">All pollutants (avg)</option>
            <option value="NO3">Nitrates (NO₃)</option>
            <option value="PO4">Orthophosphate (PO₄)</option>
            <option value="PTOT">Total Phosphorus</option>
            <option value="EC">Escherichia coli</option>
            <option value="PB">Lead</option>
            <option value="NI">Nickel</option>
            <option value="CR">Chromium</option>
            <option value="CD">Cadmium</option>
            <option value="AS">Arsenic</option>
            <option value="HG">Mercury</option>
            <option value="BOD5">BOD5</option>
            <option value="COD">COD</option>
            <option value="DO">Dissolved Oxygen</option>
            <option value="NH4">Ammonia</option>
          </select>
        </div>

        <div style={{ marginTop: 12 }}>
          <label style={{ fontSize: 12, color: "#9ca3af", display: "block", marginBottom: 4 }}>
            Basemap
          </label>
          <select value={basemap} onChange={(e) => onBasemapChange(e.target.value)}>
            <option value="osm">OpenStreetMap (flat)</option>
            <option value="satellite">Satellite</option>
            <option value="dark">Dark</option>
            <option value="neon">Neon political</option>
            <option value="liberty">Liberty (3D)</option>
          </select>
        </div>
      </div>
    </>
  );
}
