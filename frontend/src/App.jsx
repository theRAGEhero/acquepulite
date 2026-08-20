import { useEffect, useState, useCallback, useMemo } from "react";
import MapView2D from "./MapView2D.jsx";
import MapView3D from "./MapView3D.jsx";
import RiverPanel from "./RiverPanel.jsx";
import LayerControl from "./LayerControl.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";
import DataSourcesPanel from "./DataSourcesPanel.jsx";
import { usePersistentState } from "./usePersistentState.js";

export default function App() {
  const [rivers, setRivers] = useState(null);
  const [segments, setSegments] = useState(null);
  const [stations, setStations] = useState(null);
  const [dataSources, setDataSources] = useState(null);
  const [selected, setSelected] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [drawerFullscreen, setDrawerFullscreen] = useState(false);
  const [flyTo, setFlyTo] = useState(null);
  const [riverFacilities, setRiverFacilities] = useState(null);
  const [riverFacilitiesLoading, setRiverFacilitiesLoading] = useState(false);
  const [riverFacilitiesError, setRiverFacilitiesError] = useState(null);
  const [view3D, setView3D] = usePersistentState("view3d", false);
  const [uiTheme, setUiTheme] = usePersistentState("uiTheme", "dark");
  const [layers, setLayers] = usePersistentState("layers", {
    stations: true, network: true, segments: true, labels: true,
    terrain: true, facilities: false, eeaSites: false
  });
  const [paramFilter, setParamFilter] = usePersistentState("paramFilter", null);
  const [basemap, setBasemap] = usePersistentState("basemap", "neon");
  const [eeaSites, setEeaSites] = useState(null);
  const [levelsShown, setLevelsShown] = usePersistentState("levelsShown", {
    clean: true, low: true, moderate: true, high: true, critical: true, nodata: true
  });

  const visibleSegments = useMemo(() => {
    if (!segments) return segments;
    return {
      type: "FeatureCollection",
      features: segments.features.filter(feature => {
        const score = feature.properties.pollution_score;
        if (score == null) return levelsShown.nodata;
        if (score < 0.25) return levelsShown.clean;
        if (score < 0.45) return levelsShown.low;
        if (score < 0.65) return levelsShown.moderate;
        if (score < 0.85) return levelsShown.high;
        return levelsShown.critical;
      })
    };
  }, [segments, levelsShown]);

  useEffect(() => {
    Promise.all([
      fetch("/api/rivers").then(response => response.json()),
      fetch("/api/stations").then(response => response.json()),
      fetch("/api/data-sources").then(response => response.json())
    ]).then(([riverData, stationData, sourceData]) => {
      setRivers(riverData); setStations(stationData); setDataSources(sourceData);
    }).catch(() => {
      setRivers({ type: "FeatureCollection", features: [] });
      setStations({ type: "FeatureCollection", features: [] });
    });
  }, []);

  useEffect(() => {
    const url = paramFilter ? `/api/rivers-segments?param=${paramFilter}` : "/api/rivers-segments";
    fetch(url).then(response => response.json()).then(setSegments)
      .catch(() => setSegments({ type: "FeatureCollection", features: [] }));
  }, [paramFilter]);

  useEffect(() => {
    if (!layers.eeaSites) return;
    fetch("/api/eea/sites").then(response => response.json()).then(setEeaSites)
      .catch(() => setEeaSites({ type: "FeatureCollection", features: [], available: false }));
  }, [layers.eeaSites]);

  useEffect(() => {
    if (!selected?.id) return;
    const controller = new AbortController();
    let fullResultDelivered = false;
    setRiverFacilities(null);
    setRiverFacilitiesError(null);
    setRiverFacilitiesLoading(true);

    const endpoint = `/api/rivers/${selected.id}/nearby-facilities?radius=3000`;
    const eeaRequest = fetch(`${endpoint}&source=eea`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (data && !fullResultDelivered) {
          setRiverFacilities({ ...data, osm_status: "loading" });
          setRiverFacilitiesError(null);
        }
        return data;
      })
      .catch(() => null);

    fetch(endpoint, { signal: controller.signal })
      .then(async response => {
        if (response.ok) return response.json();
        let detail = "";
        try {
          const payload = await response.json();
          detail = payload.detail || payload.error || "";
        } catch { /* A proxy may return a non-JSON error page. */ }
        throw new Error(detail || `Facility service returned ${response.status}`);
      })
      .then(data => {
        fullResultDelivered = true;
        setRiverFacilities(data);
        setRiverFacilitiesLoading(false);
      })
      .catch(async error => {
        if (error.name === "AbortError") return;
        const eeaData = await eeaRequest;
        if (controller.signal.aborted) return;
        if (eeaData) {
          setRiverFacilities({
            ...eeaData,
            osm_status: "unavailable",
            warning: `OpenStreetMap scan unavailable: ${error.message}. Showing EEA registry results.`
          });
          setRiverFacilitiesError(null);
        } else {
          setRiverFacilitiesError(error.message);
        }
        setRiverFacilitiesLoading(false);
      });
    return () => controller.abort();
  }, [selected?.id]);

  const handleRiverClick = useCallback(props => {
    setSelected({
      id: props.id, name: props.name, region: props.region,
      length_km: props.length_km, wfd_status: props.wfd_status,
      geometry_source: props.geometry_source,
      source_dataset_version: props.source_dataset_version,
      source_feature_id: props.source_feature_id,
      geometry_quality: props.geometry_quality,
      source_url: props.source_url, source_license: props.source_license,
      source_license_url: props.source_license_url, source_period: props.source_period,
      assessment_type: props.assessment_type
    });
    setDrawer("river");
    setDrawerFullscreen(false);
    setLayers(previous => ({ ...previous, facilities: true }));
  }, [setLayers]);

  const metrics = useMemo(() => {
    const riverFeatures = rivers?.features || [];
    const segmentFeatures = segments?.features || [];
    const official = riverFeatures.filter(feature => feature.properties.geometry_quality === "official").length;
    return {
      rivers: riverFeatures.length,
      reaches: segmentFeatures.length,
      stations: stations?.features?.length || 0,
      alerts: segmentFeatures.filter(feature => Number(feature.properties.pollution_score) >= 0.85).length,
      official: riverFeatures.length ? Math.round((official / riverFeatures.length) * 100) : 0
    };
  }, [rivers, segments, stations]);

  const closeDrawer = useCallback(() => {
    setDrawer(null); setSelected(null); setRiverFacilities(null);
    setDrawerFullscreen(false);
  }, []);
  const toggleLayer = useCallback((key, value) => setLayers(previous => ({ ...previous, [key]: value })), [setLayers]);
  const toggleLevel = useCallback((key, value) => setLevelsShown(previous => ({ ...previous, [key]: value })), [setLevelsShown]);
  const handleStationClick = useCallback((lat, lon) => setFlyTo([lat, lon, Date.now()]), []);
  const neonMode = basemap === "neon";
  const effectiveUiTheme = uiTheme === "light" ? "light" : "dark";

  useEffect(() => {
    document.documentElement.dataset.uiTheme = effectiveUiTheme;
    document.documentElement.style.colorScheme = effectiveUiTheme;
  }, [effectiveUiTheme]);

  const mapProps = {
    rivers, segments: visibleSegments, stations: layers.stations ? stations : null,
    eeaSites: layers.eeaSites ? eeaSites : null,
    showSegments: layers.segments, showNetwork: layers.network !== false,
    showLabels: layers.labels, basemap, onRiverClick: handleRiverClick,
    onStationClick: handleStationClick, flyTo,
    riverFacilities: layers.facilities ? riverFacilities?.geojson : null
  };

  return (
    <div className={`app ${neonMode ? "neon-mode" : ""} ${effectiveUiTheme === "light" ? "light-ui" : "dark-ui"}`}>
      <main className="map-wrap">
        <header className="title-card">
          <span className="system-mark">AP//IT</span>
          <span>AcquePulite</span>
          <small>Official WFD geometry · live agency observations</small>
        </header>
        <MonitoringHud metrics={metrics} updatedAt={dataSources?.updated_at} />

        <LayerControl layers={layers} onToggleLayer={toggleLayer}
          paramFilter={paramFilter} onParamChange={setParamFilter}
          basemap={basemap} onBasemapChange={setBasemap}
          uiTheme={effectiveUiTheme} onUiThemeChange={setUiTheme}
          view3D={view3D} onView3DChange={setView3D}
          levelsShown={levelsShown} onToggleLevel={toggleLevel}
          sourceDrawerOpen={drawer === "sources"}
          metrics={metrics} updatedAt={dataSources?.updated_at}
          onOpenSources={() => {
            setDrawer(current => current === "sources" ? null : "sources");
            setDrawerFullscreen(false);
          }} />

        {view3D ? (
          <ErrorBoundary key="map3d"><MapView3D {...mapProps} showTerrain={layers.terrain} /></ErrorBoundary>
        ) : (
          <ErrorBoundary key="map2d"><MapView2D {...mapProps} /></ErrorBoundary>
        )}

        {drawer && (
          <section className={`monitor-drawer ${drawer} ${drawerFullscreen ? "fullscreen" : ""}`} aria-live="polite">
            <div className="drawer-handle" />
            <button className="fullscreen-btn" onClick={() => setDrawerFullscreen(value => !value)}
              aria-label={drawerFullscreen ? "Exit full screen panel" : "Expand panel to full screen"}>
              {drawerFullscreen ? "↙ Exit full screen" : "↗ Full screen"}
            </button>
            <button className="close-btn" onClick={closeDrawer} aria-label="Close panel">×</button>
            <div className="drawer-scroll">
              {drawer === "river" && selected
                ? <RiverPanel river={selected} onStationClick={handleStationClick}
                    facilities={riverFacilities} facilitiesLoading={riverFacilitiesLoading}
                    facilitiesError={riverFacilitiesError} />
                : <DataSourcesPanel />}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function MonitoringHud({ metrics, updatedAt }) {
  return (
    <div className="monitoring-hud">
      <div className="live-state"><span /> LIVE</div>
      <HudMetric label="Rivers" value={metrics.rivers} />
      <HudMetric label="Reaches" value={metrics.reaches} />
      <HudMetric label="Stations" value={metrics.stations} />
      <HudMetric label="Critical" value={metrics.alerts} alert={metrics.alerts > 0} />
      <HudMetric label="Official geom." value={`${metrics.official}%`} />
      <div className="hud-clock">SYNC {updatedAt ? new Date(updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "--:--"}</div>
    </div>
  );
}

function HudMetric({ label, value, alert }) {
  return <div className={`hud-metric ${alert ? "alert" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}
