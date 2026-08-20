import { useEffect, useRef } from "react";
import maplibregl from "maplibre-gl";

const STYLES = {
  osm: "https://tiles.openfreemap.org/styles/liberty",
  liberty: "https://tiles.openfreemap.org/styles/liberty",
  dark: "https://tiles.openfreemap.org/styles/dark",
  neon: "https://tiles.openfreemap.org/styles/dark",
  satellite: "https://tiles.openfreemap.org/styles/satellite"
};

const NEON_POLLUTION_COLOR = [
  "case", ["==", ["get", "pollution_score"], null], "#64748b",
  ["interpolate", ["linear"], ["to-number", ["get", "pollution_score"]],
    0, "#168cff", 0.25, "#20c9ff", 0.45, "#ffd43b",
    0.65, "#ff8c1a", 0.85, "#ff3b30", 1, "#b91c1c"]
];

const NEON_WFD_COLOR = [
  "match", ["get", "wfd_status"],
  "high", "#168cff", "good", "#20c9ff", "moderate", "#ffd43b",
  "poor", "#ff8c1a", "bad", "#ff3b30", "#64748b"
];

function pollutionLabel(value) {
  if (value == null || value === "" || Number.isNaN(Number(value))) return "No data";
  return `${(Number(value) * 100).toFixed(0)}%`;
}

function applyNeonBaseStyle(map) {
  const style = map.getStyle();
  if (!style?.layers) return;

  for (const layer of style.layers) {
    const name = `${layer.id} ${layer["source-layer"] || ""}`.toLowerCase();
    const country = name.includes("country") || name.includes("admin_0") || name.includes("admin-0");
    const boundary = country || name.includes("boundary") || name.includes("admin");
    const water = name.includes("water") || name.includes("ocean") || name.includes("sea");
    try {
      if (layer.type === "background") {
        map.setPaintProperty(layer.id, "background-color", "#010208");
        map.setPaintProperty(layer.id, "background-opacity", 1);
      } else if (layer.type === "fill") {
        map.setPaintProperty(layer.id, "fill-color", water ? "#020817" : "#02040a");
        map.setPaintProperty(layer.id, "fill-opacity", water ? 0.95 : 1);
        if (name.includes("building")) map.setLayoutProperty(layer.id, "visibility", "none");
      } else if (layer.type === "line") {
        if (boundary) {
          map.setLayoutProperty(layer.id, "visibility", "visible");
          map.setPaintProperty(layer.id, "line-color", country ? "#2dd4ff" : "#17344d");
          map.setPaintProperty(layer.id, "line-opacity", country ? 0.72 : 0.3);
          map.setPaintProperty(layer.id, "line-width", country ? 1.15 : 0.55);
        } else if (water) {
          map.setPaintProperty(layer.id, "line-color", "#0b2740");
          map.setPaintProperty(layer.id, "line-opacity", 0.35);
        } else {
          map.setLayoutProperty(layer.id, "visibility", "none");
        }
      } else if (layer.type === "symbol") {
        if (country) {
          map.setLayoutProperty(layer.id, "visibility", "visible");
          map.setPaintProperty(layer.id, "text-color", "#dbeafe");
          map.setPaintProperty(layer.id, "text-halo-color", "#010208");
          map.setPaintProperty(layer.id, "text-halo-width", 2);
          map.setPaintProperty(layer.id, "text-opacity", 0.92);
        } else {
          map.setLayoutProperty(layer.id, "visibility", "none");
        }
      }
    } catch {
      // Remote styles can expose different paint properties.
    }
  }
}

export default function MapView3D({
  rivers, segments, stations, eeaSites, riverFacilities, showSegments, showNetwork = true, showLabels, showTerrain, basemap,
  onRiverClick, onStationClick, flyTo, flat = false
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const refs = useRef({ handlers: [] });
  refs.current = {
    ...refs.current, rivers, segments, stations, eeaSites, riverFacilities, showSegments, showNetwork, showLabels,
    showTerrain, basemap, onRiverClick, onStationClick, flat
  };

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: STYLES[basemap] || STYLES.liberty,
      center: [11.0, 43.5], zoom: 5.5, pitch: flat ? 0 : 50, bearing: flat ? 0 : -20, antialias: true
    });
    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.ScaleControl(), "bottom-left");
    mapRef.current = map;
    map.on("load", () => rebuildMap(map));

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.loaded()) return;
    map.setStyle(STYLES[basemap] || STYLES.liberty);
    map.once("style.load", () => rebuildMap(map));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [basemap]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.isStyleLoaded()) addLayers(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segments, rivers, stations, eeaSites, riverFacilities, showSegments, showNetwork, showLabels]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    if (showTerrain && !flat) addTerrain(map);
    else map.setTerrain(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showTerrain, flat]);

  useEffect(() => {
    if (!mapRef.current || !flyTo) return;
    mapRef.current.flyTo({
      center: [flyTo[1], flyTo[0]], zoom: 11, pitch: flat ? 0 : 55, bearing: 0, duration: 2000
    });
  }, [flyTo, flat]);

  function rebuildMap(map) {
    if (map.setProjection) map.setProjection({ type: refs.current.flat ? "mercator" : "globe" });
    if (refs.current.basemap === "neon") applyNeonBaseStyle(map);
    if (refs.current.showTerrain && !refs.current.flat) addTerrain(map);
    addLayers(map);
  }

  function addTerrain(map) {
    try {
      if (!map.getSource("terrain")) {
        map.addSource("terrain", {
          type: "raster-dem",
          tiles: ["https://demotiles.maplibre.org/terrain-tiles/{z}/{x}/{y}.png"],
          tileSize: 256, maxzoom: 12
        });
      }
      map.setTerrain({ source: "terrain", exaggeration: 1.5 });
    } catch {
      // Terrain is optional while a style is loading.
    }
  }

  function addEvent(map, type, layerId, handler) {
    map.on(type, layerId, handler);
    refs.current.handlers.push({ type, layerId, handler });
  }

  function addLayers(map) {
    const data = refs.current;
    const neon = data.basemap === "neon";

    for (const item of data.handlers) {
      try { map.off(item.type, item.layerId, item.handler); } catch { /* already removed */ }
    }
    refs.current.handlers = [];

    for (const id of [
      "segments", "segments-glow", "rivers-2d", "rivers-glow", "rivers-casing",
      "stations", "stations-glow", "river-labels", "eea-sites", "eea-sites-glow",
      "river-facilities", "river-facilities-glow",
      "hydro-network", "hydro-network-glow", "rivers-context"
    ]) if (map.getLayer(id)) map.removeLayer(id);
    for (const id of ["segments-src", "rivers-src", "stations-src", "labels-src", "eea-src", "river-facilities-src"])
      if (map.getSource(id)) map.removeSource(id);

    const clone = (value) => JSON.parse(JSON.stringify(value));

    if (data.showNetwork) addHydroNetwork(map, neon);

    if (data.rivers?.features?.length) {
      map.addSource("rivers-src", { type: "geojson", data: clone(data.rivers) });
      map.addLayer({
        id: "rivers-context", type: "line", source: "rivers-src",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": neon ? "#24718c" : "#4682a9",
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1.5, 10, 3.5],
          "line-opacity": 0.7
        }
      });
      addEvent(map, "click", "rivers-context", (e) => data.onRiverClick(e.features[0].properties));
    }

    if (data.showSegments && data.segments?.features?.length) {
      map.addSource("segments-src", { type: "geojson", data: clone(data.segments) });
      map.addLayer({
        id: "rivers-casing", type: "line", source: "segments-src",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#010208", "line-width": neon ? 12 : 9, "line-opacity": neon ? 0.9 : 0.5 }
      });
      if (neon) addGlowLine(map, "segments-glow", "segments-src", NEON_POLLUTION_COLOR);
      map.addLayer({
        id: "segments", type: "line", source: "segments-src",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": neon ? NEON_POLLUTION_COLOR : ["get", "color"],
          "line-width": ["interpolate", ["linear"], ["zoom"], 5, neon ? 4 : 3, 8, neon ? 6 : 5, 12, neon ? 12 : 10],
          "line-opacity": 0.98
        }
      });
      bindSegmentEvents(map, data);
    } else if (data.rivers?.features?.length) {
      const standardColors = [
        "match", ["get", "wfd_status"], "high", "#168cff", "good", "#20c9ff",
        "moderate", "#ffd43b", "poor", "#ff8c1a", "bad", "#ff3b30", "#64748b"
      ];
      if (neon) addGlowLine(map, "rivers-glow", "rivers-src", NEON_WFD_COLOR);
      map.addLayer({
        id: "rivers-2d", type: "line", source: "rivers-src",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": neon ? NEON_WFD_COLOR : standardColors, "line-width": neon ? 6 : 4, "line-opacity": 0.95 }
      });
      addEvent(map, "click", "rivers-2d", (e) => data.onRiverClick(e.features[0].properties));
    }

    if (data.showLabels && data.rivers) addRiverLabels(map, data.rivers, clone, neon);
    if (data.stations?.features?.length) addStations(map, data, clone, neon);
    if (data.eeaSites?.features?.length) addEeaSites(map, data.eeaSites, clone, neon);
    if (data.riverFacilities?.features?.length) addRiverFacilities(map, data.riverFacilities, clone, neon);
  }

  function addHydroNetwork(map, neon) {
    if (!map.getSource("openmaptiles")) return;
    try {
      if (neon) {
        map.addLayer({
          id: "hydro-network-glow", type: "line", source: "openmaptiles", "source-layer": "waterway",
          minzoom: 4,
          paint: {
            "line-color": "#00b7ff",
            "line-width": ["interpolate", ["linear"], ["zoom"], 4, 1, 9, 3, 13, 7],
            "line-opacity": 0.1, "line-blur": 4
          }
        });
      }
      map.addLayer({
        id: "hydro-network", type: "line", source: "openmaptiles", "source-layer": "waterway",
        minzoom: 4,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": neon ? "#1688b8" : "#4aa3d8",
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.35, 8, 0.8, 12, 2.2],
          "line-opacity": neon ? 0.55 : 0.42
        }
      });
    } catch {
      // Some styles do not expose the OpenMapTiles waterway source layer.
    }
  }

  function addGlowLine(map, id, source, color) {
    map.addLayer({
      id, type: "line", source,
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": color,
        "line-width": ["interpolate", ["linear"], ["zoom"], 5, 13, 8, 22, 12, 36],
        "line-opacity": 0.28, "line-blur": 7
      }
    });
  }

  function bindSegmentEvents(map, data) {
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: 10 });
    addEvent(map, "mouseenter", "segments", (e) => {
      map.getCanvas().style.cursor = "pointer";
      const p = e.features[0].properties;
      popup.setLngLat(e.lngLat).setHTML(
        `<b>${p.river_name}</b><br/>Tratta ${p.segment_index}<br/>Inquinamento: ${pollutionLabel(p.pollution_score)}` +
        (p.from_station ? `<br/>Da: ${p.from_station}` : "") +
        (p.to_station ? `<br/>A: ${p.to_station}` : "")
      ).addTo(map);
    });
    addEvent(map, "mouseleave", "segments", () => { map.getCanvas().style.cursor = ""; });
    addEvent(map, "click", "segments", (e) => {
      const p = e.features[0].properties;
      data.onRiverClick({
        id: p.river_id, name: p.river_name, region: p.region || "", length_km: null, wfd_status: null,
        geometry_source: p.geometry_source, source_dataset_version: p.source_dataset_version,
        source_feature_id: p.source_feature_id, geometry_quality: p.geometry_quality,
        source_url: p.source_url, source_license: p.source_license,
        source_license_url: p.source_license_url, source_period: p.source_period,
        assessment_type: p.assessment_type
      });
    });
  }

  function addRiverLabels(map, riversData, clone, neon) {
    const labelData = {
      type: "FeatureCollection",
      features: riversData.features.map((feature) => {
        const lines = feature.geometry.type === "MultiLineString"
          ? feature.geometry.coordinates
          : [feature.geometry.coordinates];
        const coords = lines.reduce((longest, line) => line.length > longest.length ? line : longest, []);
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: coords[Math.floor(coords.length / 2)] },
          properties: { name: feature.properties.name }
        };
      })
    };
    map.addSource("labels-src", { type: "geojson", data: clone(labelData) });
    map.addLayer({
      id: "river-labels", type: "symbol", source: "labels-src",
      layout: {
        "text-field": ["get", "name"], "text-size": neon ? 13 : 12,
        "text-anchor": "center", "text-offset": [0, -1], "text-allow-overlap": false
      },
      paint: {
        "text-color": neon ? "#9dfcff" : "#ffffff",
        "text-halo-color": "#010208", "text-halo-width": neon ? 3 : 2
      }
    });
  }

  function addStations(map, data, clone, neon) {
    map.addSource("stations-src", { type: "geojson", data: clone(data.stations) });
    if (neon) {
      map.addLayer({
        id: "stations-glow", type: "circle", source: "stations-src", minzoom: 6,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 9, 10, 18],
          "circle-color": ["case", ["==", ["get", "has_real_data"], true], "#00f5d4", "#20bfff"],
          "circle-opacity": 0.25, "circle-blur": 0.75
        }
      });
    }
    map.addLayer({
      id: "stations", type: "circle", source: "stations-src", minzoom: 6,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 10, 7],
        "circle-color": ["case", ["==", ["get", "has_real_data"], true], neon ? "#b8fff7" : "#34d399", neon ? "#62c8ff" : "#60a5fa"],
        "circle-stroke-color": "#07111f", "circle-stroke-width": 2, "circle-opacity": 0.95
      }
    });
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: 15 });
    addEvent(map, "mouseenter", "stations", (e) => {
      map.getCanvas().style.cursor = "pointer";
      popup.setLngLat(e.lngLat).setHTML(`<b>${e.features[0].properties.name}</b>`).addTo(map);
    });
    addEvent(map, "mouseleave", "stations", () => { map.getCanvas().style.cursor = ""; });
    addEvent(map, "click", "stations", (e) => {
      const [lon, lat] = e.features[0].geometry.coordinates;
      data.onStationClick(lat, lon);
    });
  }

  function addEeaSites(map, eeaSitesData, clone, neon) {
    map.addSource("eea-src", { type: "geojson", data: clone(eeaSitesData) });
    if (neon) {
      map.addLayer({
        id: "eea-sites-glow", type: "circle", source: "eea-src",
        paint: { "circle-radius": 15, "circle-color": "#c084fc", "circle-opacity": 0.22, "circle-blur": 0.75 }
      });
    }
    map.addLayer({
      id: "eea-sites", type: "circle", source: "eea-src",
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 4, 10, 8],
        "circle-color": neon ? "#d8b4fe" : "#8b5cf6",
        "circle-stroke-color": neon ? "#5b21b6" : "#ffffff",
        "circle-stroke-width": 1.5, "circle-opacity": 0.9
      }
    });
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: true, offset: 15 });
    addEvent(map, "mouseenter", "eea-sites", (e) => {
      map.getCanvas().style.cursor = "pointer";
      const p = e.features[0].properties;
      popup.setLngLat(e.lngLat).setHTML(`<b>${p.name}</b><br/>${p.sector || "Industrial site"}<br/>${p.city || ""}`).addTo(map);
    });
    addEvent(map, "mouseleave", "eea-sites", () => { map.getCanvas().style.cursor = ""; });
  }

  function addRiverFacilities(map, facilitiesData, clone, neon) {
    map.addSource("river-facilities-src", { type: "geojson", data: clone(facilitiesData) });
    if (neon) {
      map.addLayer({
        id: "river-facilities-glow", type: "circle", source: "river-facilities-src", minzoom: 5,
        paint: { "circle-radius": 13, "circle-color": "#ff8c1a", "circle-opacity": 0.2, "circle-blur": 0.8 }
      });
    }
    const categoryColor = [
      "match", ["get", "category"],
      "industrial", "#ff3b30", "farm", "#ffd43b", "water_treatment", "#20c9ff",
      "mining_landfill", "#ff8c1a", "transport_fuel", "#ff6b35", "business", "#c084fc", "#f8fafc"
    ];
    map.addLayer({
      id: "river-facilities", type: "circle", source: "river-facilities-src", minzoom: 5,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3.5, 9, 6.5, 13, 9],
        "circle-color": categoryColor, "circle-stroke-color": "#02040a",
        "circle-stroke-width": 1.5, "circle-opacity": 0.95
      }
    });
    const popup = new maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 13 });
    const showPopup = e => {
      const properties = e.features[0].properties;
      const distance = Number(properties.distance_to_river_m);
      const distanceLabel = distance < 1000 ? `${distance} m` : `${(distance / 1000).toFixed(1)} km`;
      popup.setLngLat(e.features[0].geometry.coordinates).setHTML(
        `<b>${escapeHtml(properties.name)}</b><br/>${escapeHtml(properties.category_label || "Company")}` +
        `<br/>${escapeHtml(properties.source)} · ${distanceLabel} from river` +
        (properties.operator ? `<br/>Operator: ${escapeHtml(properties.operator)}` : "") +
        (properties.pollutants ? `<br/>Pollutants: ${escapeHtml(properties.pollutants)}` : "")
      ).addTo(map);
    };
    addEvent(map, "mouseenter", "river-facilities", e => {
      map.getCanvas().style.cursor = "pointer"; showPopup(e);
    });
    addEvent(map, "mouseleave", "river-facilities", () => { map.getCanvas().style.cursor = ""; });
    addEvent(map, "click", "river-facilities", e => {
      e.originalEvent?.stopPropagation(); showPopup(e);
    });
  }

  return <div ref={containerRef} style={{ height: "100%", width: "100%" }} />;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  })[character]);
}
