// Topology-safe OSM river geometry fallback. Ways are joined only when they
// share an exact OSM endpoint node; side streams are never spliced in.
// Attribution: OpenStreetMap contributors, ODbL.

import https from "node:https";
import { log } from "./logger.js";

const geometryCache = new Map();
const ACCEPTED_MAIN_ROLES = new Set(["", "main", "main_stream"]);

function httpGet(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(new URL(url), {
      headers: { "User-Agent": "RiverPollutionMap/2.0 (topology-safe)", Accept: "application/json" },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = "";
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
  });
}

async function findRiverRelationId(name) {
  const q = encodeURIComponent(`${name} river Italy`);
  const results = JSON.parse(await httpGet(
    `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=5`, 15000
  ));
  return results.find(result =>
    result.class === "waterway" && result.type === "river" && result.osm_type === "relation"
  )?.osm_id ?? results.find(result => result.osm_type === "relation")?.osm_id ?? null;
}

function planarLength(coords) {
  let length = 0;
  for (let i = 1; i < coords.length; i++) {
    const lat = (coords[i - 1][0] + coords[i][0]) * Math.PI / 360;
    const dx = (coords[i][1] - coords[i - 1][1]) * Math.cos(lat);
    const dy = coords[i][0] - coords[i - 1][0];
    length += Math.hypot(dx, dy);
  }
  return length;
}

function haversineMetres(a, b) {
  const r = Math.PI / 180;
  const lat1 = a[0] * r;
  const lat2 = b[0] * r;
  const dLat = (b[0] - a[0]) * r;
  const dLon = (b[1] - a[1]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function splitLongSourceSteps(coords, maxStepMetres = 2000) {
  if (coords.length < 2) return { lines: [], gaps: 0 };
  const lines = [];
  let current = [coords[0]];
  let gaps = 0;
  for (let i = 1; i < coords.length; i++) {
    if (haversineMetres(coords[i - 1], coords[i]) > maxStepMetres) {
      if (current.length > 1) lines.push(current);
      current = [coords[i]];
      gaps++;
    } else {
      current.push(coords[i]);
    }
  }
  if (current.length > 1) lines.push(current);
  return { lines, gaps };
}

// Exported for regression tests. Coordinates are [lat, lon].
export function assembleConnectedWays(ways) {
  const remaining = ways
    .filter(way => way.nodeIds?.length > 1 && way.coords?.length > 1)
    .map(way => ({ ...way, nodeIds: [...way.nodeIds], coords: [...way.coords] }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const chains = [];

  while (remaining.length) {
    const seed = remaining.shift();
    const chain = { nodeIds: [...seed.nodeIds], coords: [...seed.coords], wayIds: [seed.id] };
    let attached = true;
    while (attached) {
      attached = false;
      const first = chain.nodeIds[0];
      const last = chain.nodeIds[chain.nodeIds.length - 1];
      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        const cFirst = candidate.nodeIds[0];
        const cLast = candidate.nodeIds[candidate.nodeIds.length - 1];
        if (last === cFirst) {
          chain.nodeIds.push(...candidate.nodeIds.slice(1));
          chain.coords.push(...candidate.coords.slice(1));
        } else if (last === cLast) {
          chain.nodeIds.push(...candidate.nodeIds.slice(0, -1).reverse());
          chain.coords.push(...candidate.coords.slice(0, -1).reverse());
        } else if (first === cLast) {
          chain.nodeIds.unshift(...candidate.nodeIds.slice(0, -1));
          chain.coords.unshift(...candidate.coords.slice(0, -1));
        } else if (first === cFirst) {
          chain.nodeIds.unshift(...candidate.nodeIds.slice(1).reverse());
          chain.coords.unshift(...candidate.coords.slice(1).reverse());
        } else {
          continue;
        }
        chain.wayIds.push(candidate.id);
        remaining.splice(i, 1);
        attached = true;
        break;
      }
    }
    chain.length = planarLength(chain.coords);
    chains.push(chain);
  }
  return chains.sort((a, b) => b.length - a.length);
}

async function fetchRelationGeometry(relationId) {
  const data = JSON.parse(await httpGet(
    `https://api.openstreetmap.org/api/0.6/relation/${relationId}/full.json`, 25000
  ));
  const relation = data.elements.find(element =>
    element.type === "relation" && String(element.id) === String(relationId)
  );
  if (!relation) return null;

  const nodeMap = new Map();
  for (const element of data.elements) {
    if (element.type === "node" && element.lat != null && element.lon != null) {
      nodeMap.set(element.id, [element.lat, element.lon]);
    }
  }
  const memberOrder = new Map();
  relation.members.forEach((member, index) => {
    const role = String(member.role || "").toLowerCase();
    if (member.type === "way" && ACCEPTED_MAIN_ROLES.has(role)) memberOrder.set(member.ref, index);
  });
  const ways = data.elements
    .filter(element => element.type === "way" && memberOrder.has(element.id) && element.nodes?.length > 1)
    .map(element => ({
      id: element.id,
      order: memberOrder.get(element.id),
      nodeIds: element.nodes.filter(nodeId => nodeMap.has(nodeId)),
      coords: element.nodes.map(nodeId => nodeMap.get(nodeId)).filter(Boolean)
    }))
    .filter(way => way.nodeIds.length === way.coords.length && way.coords.length > 1);
  const chains = assembleConnectedWays(ways);
  if (!chains.length) return null;
  return { main: chains[0], componentCount: chains.length, wayCount: ways.length };
}

export async function fetchRiverGeometry(riverName) {
  if (geometryCache.has(riverName)) return geometryCache.get(riverName);
  try {
    log.info("OSM", `Fetching topology-safe geometry for "${riverName}"`);
    const relationId = await findRiverRelationId(riverName);
    if (!relationId) return null;
    const result = await fetchRelationGeometry(relationId);
    if (!result?.main?.coords || result.main.coords.length < 3) return null;
    const split = splitLongSourceSteps(result.main.coords);
    if (!split.lines.length) return null;
    const geoLines = split.lines.map(line => line.map(([lat, lon]) => [
      Number(lon.toFixed(7)), Number(lat.toFixed(7))
    ]));
    const value = {
      geometry: geoLines.length === 1
        ? { type: "LineString", coordinates: geoLines[0] }
        : { type: "MultiLineString", coordinates: geoLines },
      geometry_source: "OpenStreetMap",
      source_dataset_version: "live",
      source_feature_id: `relation/${relationId}`,
      geometry_quality: split.gaps
        ? "connected-main-course-with-source-gaps"
        : result.componentCount === 1 ? "connected" : "connected-main-course",
      topology: {
        components: result.componentCount + split.gaps,
        included_ways: result.main.wayIds.length,
        excluded_ways: Math.max(0, result.wayCount - result.main.wayIds.length),
        source_gaps: split.gaps,
        artificial_connectors: 0
      }
    };
    geometryCache.set(riverName, value);
    log.info("OSM", `"${riverName}": ${geoLines.reduce((n, line) => n + line.length, 0)} points, ${split.gaps} source gaps, 0 artificial connectors`);
    return value;
  } catch (error) {
    log.warn("OSM", `Failed to fetch "${riverName}": ${error.message}`);
    return null;
  }
}

export async function fetchRiverGeometries(riverNames) {
  const results = new Map();
  for (const name of riverNames) {
    results.set(name, await fetchRiverGeometry(name));
    await new Promise(resolve => setTimeout(resolve, 1100));
  }
  log.info("OSM", `Got topology-safe geometry for ${[...results.values()].filter(Boolean).length}/${riverNames.length} rivers`);
  return results;
}
