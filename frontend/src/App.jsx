import { useEffect, useState, useCallback, useMemo } from "react";
import MapView2D from "./MapView2D.jsx";
import MapView3D from "./MapView3D.jsx";
import RiverPanel from "./RiverPanel.jsx";
import LayerControl from "./LayerControl.jsx";
import ErrorBoundary from "./ErrorBoundary.jsx";
import DataSourcesPanel from "./DataSourcesPanel.jsx";
import DocumentsPage from "./DocumentsPage.jsx";
import { usePersistentState } from "./usePersistentState.js";
import { apiFetch, fetchJson } from "./telemetry.js";

function readRoute() {
  return window.location.hash.replace(/^#\/?/, "").split("?")[0].toLowerCase();
}

export default function App() {
  const [route, setRoute] = useState(readRoute);
  const [rivers, setRivers] = useState(null);
  const [segments, setSegments] = useState(null);
  const [stations, setStations] = useState(null);
  const [dataSources, setDataSources] = useState(null);
  const [regions, setRegions] = useState([]);
  const [systemHealth, setSystemHealth] = useState(null);
  const [selected, setSelected] = useState(null);
  const [selectedStation, setSelectedStation] = useState(null);
  const [drawer, setDrawer] = useState(null);
  const [drawerFullscreen, setDrawerFullscreen] = useState(false);
  const [flyTo, setFlyTo] = useState(null);
  const [riverFacilities, setRiverFacilities] = useState(null);
  const [riverFacilitiesLoading, setRiverFacilitiesLoading] = useState(false);
  const [riverFacilitiesError, setRiverFacilitiesError] = useState(null);
  const [riverFacilitiesAttempt, setRiverFacilitiesAttempt] = useState(0);
  const [view3D, setView3D] = usePersistentState("view3d", false);
  const [uiTheme, setUiTheme] = usePersistentState("uiTheme", "dark");
  const [layers, setLayers] = usePersistentState("layers", {
    stations: true, network: true, segments: true, labels: true,
    terrain: true, facilities: false, eeaSites: false
  });
  const [paramFilter, setParamFilter] = usePersistentState("paramFilter", null);
  const [basemap, setBasemap] = usePersistentState("basemap", "neon");
  const [regionFilter, setRegionFilter] = usePersistentState("regionFilter", null);
  const [eeaSites, setEeaSites] = useState(null);
  const [levelsShown, setLevelsShown] = usePersistentState("levelsShown", {
    clean: true, low: true, moderate: true, high: true, critical: true, nodata: true
  });

  const visibleRivers = useMemo(() => {
    if (!rivers || !regionFilter) return rivers;
    return {
      type: "FeatureCollection",
      features: rivers.features.filter(feature => {
        const codes = feature.properties.region_codes || [];
        return codes.includes(regionFilter) || feature.properties.region_code === regionFilter;
      })
    };
  }, [rivers, regionFilter]);

  const visibleRiverIds = useMemo(() => new Set(
    (visibleRivers?.features || []).map(feature => feature.properties.id)
  ), [visibleRivers]);

  const visibleSegments = useMemo(() => {
    if (!segments) return segments;
    return {
      type: "FeatureCollection",
      features: segments.features.filter(feature => {
        const properties = feature.properties;
        if (regionFilter && !visibleRiverIds.has(properties.river_id)) return false;
        const selectedReach = selectedStation &&
          (!selectedStation.river_id || properties.river_id === selectedStation.river_id) &&
          (properties.from_station_id === selectedStation.id || properties.to_station_id === selectedStation.id ||
            properties.from_station === selectedStation.name || properties.to_station === selectedStation.name);
        if (selectedReach) return true;
        const score = properties.pollution_score;
        if (score == null) return levelsShown.nodata;
        if (score < 0.25) return levelsShown.clean;
        if (score < 0.45) return levelsShown.low;
        if (score < 0.65) return levelsShown.moderate;
        if (score < 0.85) return levelsShown.high;
        return levelsShown.critical;
      })
    };
  }, [segments, levelsShown, selectedStation, regionFilter, visibleRiverIds]);

  const visibleStations = useMemo(() => {
    if (!stations || !regionFilter) return stations;
    return {
      type: "FeatureCollection",
      features: stations.features.filter(feature => visibleRiverIds.has(feature.properties.river_id))
    };
  }, [stations, regionFilter, visibleRiverIds]);

  useEffect(() => {
    Promise.all([
      fetchJson("/api/stations"),
      fetchJson("/api/data-sources"),
      fetchJson("/api/regions")
    ]).then(([stationData, sourceData, regionData]) => {
      setStations(stationData); setDataSources(sourceData); setRegions(regionData);
    }).catch(() => {
      setStations({ type: "FeatureCollection", features: [] });
    });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const query = regionFilter ? `?region=${encodeURIComponent(regionFilter)}` : "?overview=1";
    fetchJson(`/api/rivers${query}`, { signal: controller.signal })
      .then(setRivers)
      .catch(error => {
        if (error.name !== "AbortError") setRivers({ type: "FeatureCollection", features: [] });
      });
    return () => controller.abort();
  }, [regionFilter]);

  useEffect(() => {
    let active = true;
    const refreshHealth = () => fetchJson("/api/health")
      .then(data => { if (active) setSystemHealth(data); })
      .catch(error => {
        if (active && error.name !== "AbortError") setSystemHealth({ status: "offline", ok: false, ready: false });
      });
    refreshHealth();
    const interval = window.setInterval(refreshHealth, 60_000);
    window.addEventListener("online", refreshHealth);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("online", refreshHealth);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams();
    if (paramFilter) query.set("param", paramFilter);
    if (regionFilter) query.set("region", regionFilter);
    else query.set("overview", "1");
    fetchJson(`/api/rivers-segments?${query}`, { signal: controller.signal }).then(setSegments)
      .catch(error => {
        if (error.name !== "AbortError") setSegments({ type: "FeatureCollection", features: [] });
      });
    return () => controller.abort();
  }, [paramFilter, regionFilter]);

  useEffect(() => {
    if (!layers.eeaSites) return;
    fetchJson("/api/eea/sites").then(setEeaSites)
      .catch(() => setEeaSites({ type: "FeatureCollection", features: [], available: false }));
  }, [layers.eeaSites]);

  useEffect(() => {
    if (!selected?.id) return;
    const controller = new AbortController();
    let fullResultDelivered = false;
    setRiverFacilities(null);
    setRiverFacilitiesError(null);
    setRiverFacilitiesLoading(true);

    const refresh = riverFacilitiesAttempt > 0 ? "&refresh=1" : "";
    const endpoint = `/api/rivers/${selected.id}/nearby-facilities?radius=3000${refresh}`;
    const eeaRequest = apiFetch(`${endpoint}&source=eea`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : null)
      .then(data => {
        if (data && !fullResultDelivered) {
          setRiverFacilities({ ...data, osm_status: "loading" });
          setRiverFacilitiesError(null);
        }
        return data;
      })
      .catch(() => null);

    apiFetch(endpoint, { signal: controller.signal })
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
  }, [selected?.id, riverFacilitiesAttempt]);

  const handleRiverClick = useCallback(props => {
    setRiverFacilitiesAttempt(0);
    setSelected({
      id: props.id, name: props.name, region: props.region,
      length_km: props.length_km, wfd_status: props.wfd_status,
      geometry_source: props.geometry_source,
      source_dataset_version: props.source_dataset_version,
      source_feature_id: props.source_feature_id,
      geometry_quality: props.geometry_quality,
      source_url: props.source_url, source_license: props.source_license,
      source_license_url: props.source_license_url, source_period: props.source_period,
      assessment_type: props.assessment_type,
      national_baseline: props.national_baseline === true,
      region_source_url: props.region_source_url
    });
    setDrawer("river");
    setDrawerFullscreen(false);
    setSelectedStation(null);
    setLayers(previous => ({ ...previous, facilities: true }));
  }, [setLayers]);

  const metrics = useMemo(() => {
    const riverFeatures = visibleRivers?.features || [];
    const segmentFeatures = visibleSegments?.features || [];
    const official = riverFeatures.filter(feature => feature.properties.geometry_quality === "official").length;
    return {
      rivers: riverFeatures.length,
      reaches: segmentFeatures.length,
      stations: visibleStations?.features?.length || 0,
      alerts: segmentFeatures.filter(feature => Number(feature.properties.pollution_score) >= 0.85).length,
      official: riverFeatures.length ? Math.round((official / riverFeatures.length) * 100) : 0
    };
  }, [visibleRivers, visibleSegments, visibleStations]);

  const closeDrawer = useCallback(() => {
    setDrawer(null); setSelected(null); setRiverFacilities(null);
    setSelectedStation(null);
    setDrawerFullscreen(false);
  }, []);
  const toggleLayer = useCallback((key, value) => setLayers(previous => ({ ...previous, [key]: value })), [setLayers]);
  const toggleLevel = useCallback((key, value) => setLevelsShown(previous => ({ ...previous, [key]: value })), [setLevelsShown]);
  const handleUiThemeChange = useCallback(theme => {
    setUiTheme(theme);
    if (theme === "light") setBasemap("light");
    else setBasemap(current => current === "light" ? "neon" : current);
  }, [setBasemap, setUiTheme]);
  const handleBasemapChange = useCallback(nextBasemap => {
    setBasemap(nextBasemap);
    if (nextBasemap === "light") setUiTheme("light");
    else if (uiTheme === "light") setUiTheme("dark");
  }, [setBasemap, setUiTheme, uiTheme]);
  const handleStationClick = useCallback((lat, lon, station = null) => {
    setFlyTo([lat, lon, Date.now(), station?.id ? 12.5 : 11]);
    if (station?.id) {
      setSelectedStation({
        id: station.id,
        name: station.name,
        river_id: station.river_id,
        lat,
        lon
      });
      setLayers(previous => ({ ...previous, stations: true, segments: true }));
    }
  }, [setLayers]);
  const neonMode = basemap === "neon";
  const effectiveUiTheme = uiTheme === "light" ? "light" : "dark";

  const regionBounds = useMemo(() => {
    if (!regionFilter || !visibleRivers?.features?.length) return null;
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    const visit = coordinates => {
      if (!Array.isArray(coordinates)) return;
      if (typeof coordinates[0] === "number" && typeof coordinates[1] === "number") {
        west = Math.min(west, coordinates[0]); south = Math.min(south, coordinates[1]);
        east = Math.max(east, coordinates[0]); north = Math.max(north, coordinates[1]);
        return;
      }
      coordinates.forEach(visit);
    };
    visibleRivers.features.forEach(feature => visit(feature.geometry?.coordinates));
    return Number.isFinite(west) ? [[west, south], [east, north], Date.now()] : null;
  }, [regionFilter, visibleRivers]);

  useEffect(() => {
    document.documentElement.dataset.uiTheme = effectiveUiTheme;
    document.documentElement.style.colorScheme = effectiveUiTheme;
  }, [effectiveUiTheme]);

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const openDocuments = useCallback(() => {
    window.location.hash = "#/documents";
    setDrawer(null);
  }, []);

  // The beta badge opens the provenance drawer. When the dedicated data-status
  // page lands it should point there instead.
  const openDataStatus = useCallback(() => {
    setDrawer("sources");
    setDrawerFullscreen(false);
  }, []);

  const closeDocuments = useCallback(() => {
    window.location.hash = "";
  }, []);

  useEffect(() => {
    // Migrate persisted light-theme sessions created before the white map existed.
    if (uiTheme === "light" && basemap !== "light") setBasemap("light");
    // This is intentionally a one-time compatibility pass; later map choices remain user-controlled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every hook must run before this route branch. Returning earlier changes the
  // hook count between renders and React aborts with "Rendered fewer hooks than
  // expected", which white-screens the whole app on the documents route.
  if (route === "documents") {
    return (
      <div className={`app ${neonMode ? "neon-mode" : ""} ${effectiveUiTheme === "light" ? "light-ui" : "dark-ui"}`}>
        <DocumentsPage onBack={closeDocuments} />
      </div>
    );
  }

  const mapProps = {
    rivers: visibleRivers, segments: visibleSegments, stations: layers.stations ? visibleStations : null,
    eeaSites: layers.eeaSites ? eeaSites : null,
    showSegments: layers.segments, showNetwork: layers.network !== false,
    showLabels: layers.labels, basemap, onRiverClick: handleRiverClick,
    onStationClick: handleStationClick, selectedStation, flyTo, fitBounds: regionBounds,
    riverFacilities: layers.facilities ? riverFacilities?.geojson : null
  };

  return (
    <div className={`app ${neonMode ? "neon-mode" : ""} ${effectiveUiTheme === "light" ? "light-ui" : "dark-ui"}`}>
      <main className="map-wrap">
        <header className="title-card">
          <span className="system-mark">AP//IT</span>
          <span>AcquePulite</span>
          {/* The subtitle used to claim "live agency observations". Nothing here
              is live: sources are ingested periodically and some regional
              classifications date from 2014-2019. */}
          <small>Official WFD geometry · agency classifications, dated at source</small>
          <button type="button" className="beta-badge" onClick={openDataStatus}
            title="This platform is under development — see what is provisional">
            BETA · in sviluppo
          </button>
        </header>
        <MonitoringHud metrics={metrics} updatedAt={dataSources?.updated_at} health={systemHealth} />

        <LayerControl layers={layers} onToggleLayer={toggleLayer}
          paramFilter={paramFilter} onParamChange={setParamFilter}
          basemap={basemap} onBasemapChange={handleBasemapChange}
          regions={regions} regionFilter={regionFilter} onRegionChange={setRegionFilter}
          uiTheme={effectiveUiTheme} onUiThemeChange={handleUiThemeChange}
          view3D={view3D} onView3DChange={setView3D}
          levelsShown={levelsShown} onToggleLevel={toggleLevel}
          sourceDrawerOpen={drawer === "sources"}
          metrics={metrics} updatedAt={dataSources?.updated_at}
          onOpenDocuments={openDocuments}
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
                    facilitiesError={riverFacilitiesError}
                    onFacilitiesRetry={() => setRiverFacilitiesAttempt(value => value + 1)} />
                : <DataSourcesPanel />}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function MonitoringHud({ metrics, updatedAt, health }) {
  const state = health?.status || "starting";
  const label = state === "ready" ? "LIVE" : state === "degraded" ? "DEGRADED" :
    state === "offline" || state === "failed" ? "OFFLINE" : "STARTING";
  const detail = health?.degraded_sources?.length
    ? `Unavailable sources: ${health.degraded_sources.join(", ")}`
    : `System status: ${state}`;
  return (
    <div className="monitoring-hud">
      <div className={`live-state ${state}`} title={detail}><span /> {label}</div>
      <HudMetric label="Rivers" value={metrics.rivers} />
      <HudMetric label="Reaches" value={metrics.reaches} />
      <HudMetric label="Stations" value={metrics.stations} />
      <HudMetric label="Critical" value={metrics.alerts} alert={metrics.alerts > 0} />
      <HudMetric label="Official geom." value={`${metrics.official}%`} />
      {/* Time alone made two-week-old data read as this afternoon. */}
      <div className="hud-clock" title={updatedAt ? new Date(updatedAt).toLocaleString() : undefined}>
        SYNC {updatedAt
          ? new Date(updatedAt).toLocaleDateString([], { day: "2-digit", month: "2-digit", year: "numeric" })
          : "--/--/----"}
      </div>
    </div>
  );
}

function HudMetric({ label, value, alert }) {
  return <div className={`hud-metric ${alert ? "alert" : ""}`}><span>{label}</span><strong>{value}</strong></div>;
}
