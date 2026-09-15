import { useEffect, useMemo, useRef, useState } from "react";

const BASEMAPS = [
  { value: "light", label: "White", detail: "Light monitoring map" },
  { value: "neon", label: "Neon", detail: "Political monitoring" },
  { value: "dark", label: "Dark", detail: "Low distraction" },
  { value: "osm", label: "OSM", detail: "Street context" },
  { value: "satellite", label: "Satellite", detail: "Aerial imagery" },
  { value: "liberty", label: "Liberty", detail: "Detailed 3D" }
];

const POLLUTANTS = [
  ["", "All pollutants (average)"], ["NO3", "Nitrates (NO₃)"],
  ["PO4", "Orthophosphate (PO₄)"], ["PTOT", "Total phosphorus"],
  ["EC", "Escherichia coli"], ["PB", "Lead"], ["NI", "Nickel"],
  ["CR", "Chromium"], ["CD", "Cadmium"], ["AS", "Arsenic"],
  ["HG", "Mercury"], ["BOD5", "BOD5"], ["COD", "COD"],
  ["DO", "Dissolved oxygen"], ["NH4", "Ammonia"]
];

const QUALITY_LEVELS = [
  ["clean", "Clean", "#168cff"], ["low", "Low", "#20c9ff"],
  ["moderate", "Moderate", "#ffd43b"], ["high", "High", "#ff8c1a"],
  ["critical", "Critical", "#ff3b30"], ["nodata", "No data", "#64748b"]
];

export default function LayerControl({
  layers, onToggleLayer, paramFilter, onParamChange, basemap, onBasemapChange,
  regions, regionFilter, onRegionChange,
  uiTheme, onUiThemeChange,
  view3D, onView3DChange, levelsShown, onToggleLevel, onOpenSources,
  onOpenDocuments, sourceDrawerOpen, metrics, updatedAt
}) {
  const [panel, setPanel] = useState(null);
  const rootRef = useRef(null);
  const activeLayers = useMemo(() => [
    layers.network !== false, layers.stations, layers.facilities, layers.eeaSites,
    layers.segments, layers.labels, view3D && layers.terrain
  ].filter(Boolean).length, [layers, view3D]);
  const activeLevels = QUALITY_LEVELS.filter(([key]) => levelsShown[key]).length;
  const filtersChanged = Boolean(paramFilter) || Boolean(regionFilter) || activeLevels !== QUALITY_LEVELS.length;
  const pollutantLabel = POLLUTANTS.find(([value]) => value === (paramFilter || ""))?.[1] || "All pollutants";

  useEffect(() => {
    const onPointerDown = event => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setPanel(null);
    };
    const onKeyDown = event => { if (event.key === "Escape") setPanel(null); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const togglePanel = name => setPanel(current => current === name ? null : name);
  const resetFilters = () => {
    onParamChange(null);
    onRegionChange(null);
    QUALITY_LEVELS.forEach(([key]) => onToggleLevel(key, true));
  };

  return (
    <div className="map-controls" ref={rootRef}>
      <button className={`workspace-menu-btn ${panel === "menu" ? "active" : ""}`}
        onClick={() => togglePanel("menu")} aria-expanded={panel === "menu"}
        aria-controls="workspace-panel" aria-label="Open workspace menu">
        <Icon name={panel === "menu" ? "close" : "menu"} />
        <span>Workspace</span>
      </button>

      <div className="map-tool-dock" aria-label="Map tools">
        <ToolButton name="layers" label="Layers" active={panel === "layers"}
          badge={activeLayers} onClick={() => togglePanel("layers")} />
        <ToolButton name="filter" label="Filters" active={panel === "filters"}
          alert={filtersChanged} onClick={() => togglePanel("filters")} />
      </div>

      <button className={`map-quality-key ${panel === "filters" ? "active" : ""}`}
        onClick={() => togglePanel("filters")} aria-label="Open water-quality filters">
        <span className="quality-key-heading">Water quality</span>
        <span className="quality-key-current">{pollutantLabel}</span>
        <span className="quality-key-gradient" />
        <span className="quality-key-range"><span>Good</span><span>Bad</span></span>
      </button>

      {panel === "menu" && (
        <ControlPanel id="workspace-panel" className="workspace-panel" title="Workspace"
          eyebrow="AcquePulite / Italy" onClose={() => setPanel(null)}>
          <div className="control-status-grid">
            <ControlMetric label="Rivers" value={metrics?.rivers ?? "—"} />
            <ControlMetric label="Stations" value={metrics?.stations ?? "—"} />
            <ControlMetric label="Official lines" value={`${metrics?.official ?? 0}%`} />
          </div>

          <ControlGroup label="Map dimension">
            <div className="control-segmented" role="group" aria-label="Map dimension">
              <button className={!view3D ? "active" : ""} onClick={() => onView3DChange(false)}>2D map</button>
              <button className={view3D ? "active" : ""} onClick={() => onView3DChange(true)}>3D terrain</button>
            </div>
          </ControlGroup>

          <ControlGroup label="Interface theme">
            <div className="theme-selector" role="group" aria-label="Interface theme">
              <button type="button" className={uiTheme === "light" ? "active" : ""}
                aria-pressed={uiTheme === "light"} onClick={() => onUiThemeChange("light")}>
                <Icon name="sun" />
                <span><strong>Light</strong><small>Bright dashboard</small></span>
              </button>
              <button type="button" className={uiTheme === "dark" ? "active" : ""}
                aria-pressed={uiTheme === "dark"} onClick={() => onUiThemeChange("dark")}>
                <Icon name="moon" />
                <span><strong>Dark</strong><small>Operations room</small></span>
              </button>
            </div>
          </ControlGroup>

          <ControlGroup label="Basemap">
            <div className="basemap-grid">
              {BASEMAPS.map(item => (
                <button key={item.value} className={`basemap-option ${basemap === item.value ? "active" : ""}`}
                  onClick={() => onBasemapChange(item.value)} aria-pressed={basemap === item.value}>
                  <span className={`basemap-sample ${item.value}`} />
                  <span><strong>{item.label}</strong><small>{item.detail}</small></span>
                  {basemap === item.value && <Icon name="check" />}
                </button>
              ))}
            </div>
          </ControlGroup>

          <button className={`sources-menu-action ${sourceDrawerOpen ? "active" : ""}`}
            onClick={() => { onOpenSources(); setPanel(null); }}>
            <Icon name="database" />
            <span><strong>System & data sources</strong><small>Coverage, licenses and provenance</small></span>
            <Icon name="arrow" />
          </button>
          <button className="sources-menu-action"
            onClick={() => { onOpenDocuments(); setPanel(null); }}>
            <Icon name="documents" />
            <span><strong>River documents</strong><small>Reports, studies and legal files per river</small></span>
            <Icon name="arrow" />
          </button>
          <div className="control-sync">Last agency sync: {updatedAt
            ? new Date(updatedAt).toLocaleString()
            : "waiting for data"}</div>
        </ControlPanel>
      )}

      {panel === "layers" && (
        <ControlPanel id="layers-panel" className="tool-panel" title="Map layers"
          eyebrow={`${activeLayers} visible`} onClose={() => setPanel(null)}>
          <ControlGroup label="Hydrography">
            <LayerToggle id="sw-network" checked={layers.network !== false} color="#1688b8"
              title="River network" detail="Complete OSM waterway context"
              onChange={value => onToggleLayer("network", value)} />
            <LayerToggle id="sw-segments" checked={layers.segments} color="#ff8c1a"
              title="Quality reaches" detail="Color official reaches by condition"
              onChange={value => onToggleLayer("segments", value)} />
            <LayerToggle id="sw-labels" checked={layers.labels} color="#9dfcff"
              title="River labels" detail="Names positioned on monitored rivers"
              onChange={value => onToggleLayer("labels", value)} />
          </ControlGroup>

          <ControlGroup label="Monitoring & pressure">
            <LayerToggle id="sw-stations" checked={layers.stations} color="#35f58a"
              title="Monitoring stations" detail="Regional agency sampling points"
              onChange={value => onToggleLayer("stations", value)} />
            <LayerToggle id="sw-facilities" checked={layers.facilities} color="#ff665c"
              title="River-corridor companies" detail="Facilities loaded for the selected river"
              onChange={value => onToggleLayer("facilities", value)} />
            <LayerToggle id="sw-eea-sites" checked={layers.eeaSites} color="#c084fc"
              title="EEA industrial sites" detail="Regulated installations across Italy"
              onChange={value => onToggleLayer("eeaSites", value)} />
          </ControlGroup>

          <ControlGroup label="Surface">
            <LayerToggle id="sw-terrain" checked={layers.terrain} color="#7dd3fc"
              title="Terrain relief" detail={view3D ? "Elevation is active in 3D" : "Switch to 3D to see elevation"}
              onChange={value => onToggleLayer("terrain", value)} disabled={!view3D} />
          </ControlGroup>
        </ControlPanel>
      )}

      {panel === "filters" && (
        <ControlPanel id="filters-panel" className="tool-panel" title="Quality filters"
          eyebrow={filtersChanged ? "Custom view" : "All data"} onClose={() => setPanel(null)}>
          <ControlGroup label="Geographic coverage">
            <select className="pollutant-select" value={regionFilter || ""}
              onChange={event => onRegionChange(event.target.value || null)}>
              <option value="">All Italy — 20 regions</option>
              {(regions || []).map(region => (
                <option key={region.code} value={region.code}>
                  {region.name} — {region.rivers} rivers
                </option>
              ))}
            </select>
            <p className="control-help">Selecting a region filters rivers, reaches and stations, then fits the map to its monitored network.</p>
          </ControlGroup>

          <ControlGroup label="Color monitored reaches by">
            <select className="pollutant-select" value={paramFilter || ""}
              onChange={event => onParamChange(event.target.value || null)}>
              {POLLUTANTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <p className="control-help">Changes the measurement used to score monitored reaches. Regional WFD classes remain authoritative.</p>
          </ControlGroup>

          <ControlGroup label={`Visible severity · ${activeLevels}/${QUALITY_LEVELS.length}`}>
            <div className="severity-grid">
              {QUALITY_LEVELS.map(([key, label, color]) => (
                <button key={key} className={levelsShown[key] ? "active" : ""}
                  onClick={() => onToggleLevel(key, !levelsShown[key])}
                  aria-pressed={levelsShown[key]}>
                  <span style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
                  {label}
                  <Icon name={levelsShown[key] ? "check" : "minus"} />
                </button>
              ))}
            </div>
          </ControlGroup>

          <div className="filter-actions">
            <button onClick={resetFilters} disabled={!filtersChanged}>Reset filters</button>
            <button onClick={() => QUALITY_LEVELS.forEach(([key]) => onToggleLevel(key, key !== "nodata"))}>
              Hide no-data
            </button>
          </div>
        </ControlPanel>
      )}
    </div>
  );
}

function ToolButton({ name, label, active, badge, alert, onClick }) {
  return (
    <button className={`map-tool-btn ${active ? "active" : ""}`} onClick={onClick}
      aria-label={label} aria-expanded={active} title={label}>
      <Icon name={name} />
      <span className="map-tool-label">{label}</span>
      {badge != null && <span className="map-tool-badge">{badge}</span>}
      {alert && <span className="map-tool-alert" />}
    </button>
  );
}

function ControlPanel({ id, className, title, eyebrow, onClose, children }) {
  return (
    <section id={id} className={`map-control-panel ${className}`} aria-label={title}>
      <header className="control-panel-header">
        <div><span>{eyebrow}</span><h2>{title}</h2></div>
        <button onClick={onClose} aria-label={`Close ${title}`}><Icon name="close" /></button>
      </header>
      <div className="control-panel-body">{children}</div>
    </section>
  );
}

function ControlGroup({ label, children }) {
  return <section className="control-group"><h3>{label}</h3>{children}</section>;
}

function LayerToggle({ id, checked, color, title, detail, onChange, disabled = false }) {
  return (
    <label className={`layer-toggle-row ${disabled ? "disabled" : ""}`} htmlFor={id}>
      <span className="layer-symbol" style={{ color, background: color }} />
      <span className="layer-toggle-copy"><strong>{title}</strong><small>{detail}</small></span>
      <span className="switch">
        <input id={id} type="checkbox" checked={checked} disabled={disabled}
          onChange={event => onChange(event.target.checked)} />
        <span className="slider" />
      </span>
    </label>
  );
}

function ControlMetric({ label, value }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function Icon({ name }) {
  const paths = {
    menu: <><path d="M4 7h16M4 12h16M4 17h16"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></>,
    filter: <><path d="M4 5h16M7 12h10M10 19h4"/></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
    documents: <><path d="M7 3h7l4 4v14H7V3Z"/><path d="M14 3v4h4M10 12h5M10 16h5"/></>,
    arrow: <><path d="M5 12h14M14 7l5 5-5 5"/></>,
    check: <><path d="m5 12 4 4L19 6"/></>,
    minus: <><path d="M6 12h12"/></>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/></>,
    moon: <><path d="M20.5 14.3A8.5 8.5 0 0 1 9.7 3.5 8.5 8.5 0 1 0 20.5 14.3Z"/></>
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
