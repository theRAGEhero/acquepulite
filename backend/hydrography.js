import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";

const HYDRO_DIR = path.join(import.meta.dirname, "data", "hydrography");
const MANIFEST_FILE = path.join(HYDRO_DIR, "manifest.json");

export function geometryLines(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates];
  if (geometry?.type === "MultiLineString") return geometry.coordinates;
  return [];
}

export function combineLineGeometries(geometries) {
  const lines = geometries.flatMap(geometryLines).filter(line => line.length > 1);
  if (!lines.length) return null;
  return lines.length === 1
    ? { type: "LineString", coordinates: lines[0] }
    : { type: "MultiLineString", coordinates: lines };
}

function squaredSegmentDistance(point, start, end) {
  let x = start[0];
  let y = start[1];
  let dx = end[0] - x;
  let dy = end[1] - y;
  if (dx || dy) {
    const t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = end[0]; y = end[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = point[0] - x;
  dy = point[1] - y;
  return dx * dx + dy * dy;
}

function simplifyLine(line, tolerance) {
  if (!Array.isArray(line) || line.length <= 2) return line;
  const squaredTolerance = tolerance * tolerance;
  const markers = new Uint8Array(line.length);
  markers[0] = 1;
  markers[line.length - 1] = 1;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maximum = squaredTolerance;
    let index = -1;
    for (let current = first + 1; current < last; current++) {
      const distance = squaredSegmentDistance(line[current], line[first], line[last]);
      if (distance > maximum) { index = current; maximum = distance; }
    }
    if (index < 0) continue;
    markers[index] = 1;
    if (index - first > 1) stack.push([first, index]);
    if (last - index > 1) stack.push([index, last]);
  }
  return line.filter((_, index) => markers[index]);
}

// Display-only simplification. The full official geometry remains in memory
// for corridor distance, facility searches, snapping and detailed analysis.
export function simplifyGeometry(geometry, tolerance = 0.00025) {
  if (geometry?.type === "LineString") {
    return { ...geometry, coordinates: simplifyLine(geometry.coordinates, tolerance) };
  }
  if (geometry?.type === "MultiLineString") {
    return { ...geometry, coordinates: geometry.coordinates.map(line => simplifyLine(line, tolerance)) };
  }
  return geometry;
}

function normalized(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/^(fiume|torrente|rio|canale|f\.|t\.|r\.|c\.)\s+/i, "")
    .replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function firstProperty(properties, fields = []) {
  for (const field of fields) {
    if (properties?.[field] != null && String(properties[field]).trim()) return properties[field];
  }
  return null;
}

export function loadOfficialHydrography() {
  const catalog = { datasets: [], byCode: new Map(), byName: new Map(), featureCount: 0 };
  if (!fs.existsSync(MANIFEST_FILE)) return catalog;
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
  const datasets = [...(manifest.datasets || [])].sort((a, b) => (b.priority || 0) - (a.priority || 0));
  for (const dataset of datasets) {
    const file = path.resolve(HYDRO_DIR, dataset.file || "");
    if (!file.startsWith(path.resolve(HYDRO_DIR)) || !fs.existsSync(file)) {
      log.warn("HYDRO", `Skipping ${dataset.id}: ${dataset.file} not found`);
      continue;
    }
    const collection = JSON.parse(fs.readFileSync(file, "utf8"));
    let loaded = 0;
    for (const feature of collection.features || []) {
      if (!geometryLines(feature.geometry).some(line => line.length > 1)) continue;
      const properties = feature.properties || {};
      const codes = [...new Set((dataset.code_fields || [])
        .map(field => normalized(properties?.[field])).filter(Boolean))];
      const code = codes[0] || "";
      const name = normalized(firstProperty(properties, dataset.name_fields));
      const featureId = firstProperty(properties, dataset.feature_id_fields) ?? feature.id ?? null;
      const record = { feature, dataset, featureId, code, codes, name };
      for (const indexedCode of codes) {
        if (!catalog.byCode.has(indexedCode)) catalog.byCode.set(indexedCode, []);
        catalog.byCode.get(indexedCode).push(record);
      }
      if (name) {
        if (!catalog.byName.has(name)) catalog.byName.set(name, []);
        catalog.byName.get(name).push(record);
      }
      loaded++;
    }
    catalog.datasets.push({ ...dataset, loaded_features: loaded });
    catalog.featureCount += loaded;
    log.info("HYDRO", `${dataset.title || dataset.id}: ${loaded} official line features loaded`);
  }
  return catalog;
}

function highestPriority(records) {
  if (!records.length) return [];
  const priority = Math.max(...records.map(record => record.dataset.priority || 0));
  return records.filter(record => (record.dataset.priority || 0) === priority);
}

export function resolveOfficialGeometry(catalog, river) {
  const matched = [];
  let matchedWaterBodies = 0;
  for (const stretch of river.stretches || []) {
    const code = normalized(stretch.water_body_code);
    let records = code ? highestPriority(catalog.byCode.get(code) || []) : [];
    let matchMethod = "water-body-code";
    if (!records.length) {
      const nameRecords = highestPriority(catalog.byName.get(normalized(stretch.name)) || []);
      if (nameRecords.length === 1) {
        records = nameRecords;
        matchMethod = "exact-name";
      }
    }
    if (!records.length) continue;
    stretch.geometry = combineLineGeometries(records.map(record => record.feature.geometry));
    stretch.geometry_source = records[0].dataset.title || records[0].dataset.id;
    stretch.source_feature_id = records.map(record => record.featureId).filter(Boolean).join(",");
    stretch.geometry_match = matchMethod;
    stretch.requires_review = matchMethod !== "water-body-code";
    matched.push(...records);
    matchedWaterBodies++;
  }
  if (!matched.length) {
    const nameMatches = highestPriority(catalog.byName.get(normalized(river.name)) || []);
    if (nameMatches.length === 1) matched.push(nameMatches[0]);
  }
  if (!matched.length) return null;
  const unique = [...new Map(matched.map(record => [
    `${record.dataset.id}:${record.featureId ?? JSON.stringify(record.feature.geometry).slice(0, 100)}`, record
  ])).values()];
  const primary = unique[0];
  return {
    geometry: combineLineGeometries(unique.map(record => record.feature.geometry)),
    geometry_source: primary.dataset.title || primary.dataset.id,
    source_dataset_version: primary.dataset.version || "unknown",
    source_feature_id: unique.map(record => record.featureId).filter(Boolean).join(",") || null,
    geometry_quality: "official",
    topology: { components: unique.length, artificial_connectors: 0 },
    matched_water_bodies: matchedWaterBodies
  };
}

function haversineMetres(a, b) {
  const r = Math.PI / 180;
  const lat1 = a[1] * r;
  const lat2 = b[1] * r;
  const dLat = (b[1] - a[1]) * r;
  const dLon = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function projectToSegment(point, a, b) {
  const refLat = point[1] * Math.PI / 180;
  const scaleX = 111320 * Math.cos(refLat);
  const scaleY = 110540;
  const px = (point[0] - a[0]) * scaleX;
  const py = (point[1] - a[1]) * scaleY;
  const bx = (b[0] - a[0]) * scaleX;
  const by = (b[1] - a[1]) * scaleY;
  const denominator = bx * bx + by * by;
  const t = denominator ? Math.max(0, Math.min(1, (px * bx + py * by) / denominator)) : 0;
  return { coordinate: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], t };
}

export function snapPointToGeometry(point, geometry) {
  let best = null;
  geometryLines(geometry).forEach((line, lineIndex) => {
    let distanceAlong = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const projected = projectToSegment(point, line[i], line[i + 1]);
      const distance = haversineMetres(point, projected.coordinate);
      const segmentLength = haversineMetres(line[i], line[i + 1]);
      const candidate = {
        ...projected,
        distance_m: distance,
        line_index: lineIndex,
        segment_index: i,
        distance_along_m: distanceAlong + segmentLength * projected.t
      };
      if (!best || candidate.distance_m < best.distance_m) best = candidate;
      distanceAlong += segmentLength;
    }
  });
  return best;
}

export function sliceLineBetweenSnaps(line, from, to) {
  let start = from;
  let end = to;
  if (start.distance_along_m > end.distance_along_m) [start, end] = [end, start];
  const coordinates = [start.coordinate];
  for (let i = start.segment_index + 1; i <= end.segment_index; i++) coordinates.push(line[i]);
  coordinates.push(end.coordinate);
  return coordinates.filter((coordinate, index, array) =>
    index === 0 || coordinate[0] !== array[index - 1][0] || coordinate[1] !== array[index - 1][1]
  );
}
