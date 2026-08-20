// Overpass API adapter — queries OpenStreetMap for industrial/farm/water/
// mining/fuel facilities near a given lat/lon within a radius (default 3km).
// Free, no API key needed. Attribution: OpenStreetMap contributors.

import { log } from "./logger.js";

const OVERPASS_ENDPOINTS = [
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter"
];
const endpointHealth = new Map();

// OSM tag presets per category
const CATEGORY_QUERIES = {
  industrial: [
    '["man_made"]["man_made"!~"surveillance|tower|flagpole|mast|antenna"]',
    '["landuse"="industrial"]',
    '["building"="industrial"]',
    '["industrial"]',
    '["craft"~"chemical|plating|brewery|sawmill|winery|pottery"]'
  ],
  farm: [
    '["landuse"="farmland"]',
    '["building"="farm_auxiliary"]',
    '["farm"]',
    '["man_made"="storage_tank"]',
    '["amenity"="animal_boarding"]',
    '["landuse"="greenhouse_horticulture"]'
  ],
  water_treatment: [
    '["man_made"="wastewater_plant"]',
    '["waterway"="dam"]',
    '["man_made"="pumping_station"]',
    '["facility"~"wastewater|water_works"]'
  ],
  mining_landfill: [
    '["landuse"="quarry"]',
    '["landuse"="landfill"]',
    '["man_made"="mine"]',
    '["man_made"="tailings"]',
    '["resource"]'
  ],
  transport_fuel: [
    '["amenity"="fuel"]',
    '["landuse"="railway"]',
    '["man_made"="pipeline"]',
    '["industrial"="port"]',
    '["landuse"="port"]',
    '["amenity"="loading_dock"]'
  ],
  business: [
    '["office"]["name"]',
    '["shop"~"wholesale|trade|hardware|agrarian|chemical|paint"]["name"]',
    '["craft"~"carpenter|plumber|electrician|painter|mechanic|welder"]["name"]',
    '["company"]'
  ]
};

const CATEGORY_LABELS = {
  industrial: "Industrial facility",
  farm: "Farm / Agriculture",
  water_treatment: "Water treatment",
  mining_landfill: "Mining / Landfill",
  transport_fuel: "Transport / Fuel",
  business: "Business / Office"
};

const CORRIDOR_FILTERS = [
  '["industrial"]',
  '["landuse"~"industrial|quarry|landfill|port"]',
  '["man_made"~"wastewater_plant|pumping_station|storage_tank|mine|tailings|pipeline"]',
  '["amenity"~"fuel|animal_boarding|loading_dock"]'
];

function buildQuery(lat, lon, radius) {
  const filters = Object.entries(CATEGORY_QUERIES)
    .map(([cat, tags]) => tags.map(t => `node${t}(around:${radius},${lat},${lon}); way${t}(around:${radius},${lat},${lon});`).join(""))
    .join("");
  return `[out:json][timeout:25];(${filters});out tags center 100;`;
}

function geometryLines(geometry) {
  if (!geometry) return [];
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
}

function downsampleLine(line, maximumPoints) {
  if (line.length <= maximumPoints) return line;
  const sampled = [];
  const step = (line.length - 1) / (maximumPoints - 1);
  for (let i = 0; i < maximumPoints; i++) sampled.push(line[Math.round(i * step)]);
  return sampled;
}

export function buildCorridorQuery(geometry, radius) {
  const lines = geometryLines(geometry).filter(line => line.length > 0);
  const totalVertices = lines.reduce((sum, line) => sum + line.length, 0) || 1;
  const corridors = lines.map(line => {
    const allowance = Math.max(2, Math.round(28 * line.length / totalVertices));
    const coordinates = downsampleLine(line, allowance)
      .map(([lon, lat]) => `${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`).join(",");
    return `(around:${radius},${coordinates})`;
  });
  const filters = corridors.flatMap(corridor => CORRIDOR_FILTERS.map(tags => `nwr${tags}${corridor};`)).join("");
  return `[out:json][timeout:14];(${filters});out tags center 2000;`;
}

function corridorPaths(geometry, maximumPoints = 28, maximumPointsPerQuery = 10) {
  const lines = geometryLines(geometry).filter(line => line.length > 0);
  const totalVertices = lines.reduce((sum, line) => sum + line.length, 0) || 1;
  const paths = [];
  for (const line of lines) {
    const allowance = Math.max(2, Math.round(maximumPoints * line.length / totalVertices));
    const sampled = downsampleLine(line, allowance);
    if (sampled.length <= maximumPointsPerQuery) {
      paths.push(sampled);
      continue;
    }
    for (let start = 0; start < sampled.length - 1; start += maximumPointsPerQuery - 1) {
      const chunk = sampled.slice(start, start + maximumPointsPerQuery);
      if (chunk.length > 1) paths.push(chunk);
    }
  }
  return paths;
}

export function buildCorridorQueries(geometry, radius) {
  return corridorPaths(geometry).map(path => {
    const coordinates = path
      .map(([lon, lat]) => `${Number(lat).toFixed(6)},${Number(lon).toFixed(6)}`).join(",");
    const corridor = `(around:${radius},${coordinates})`;
    const filters = CORRIDOR_FILTERS.map(tags => `nwr${tags}${corridor};`).join("");
    return `[out:json][timeout:10];(${filters});out tags center 750;`;
  });
}

function endpointName(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

function endpointOrder() {
  const now = Date.now();
  let available = OVERPASS_ENDPOINTS.filter(url => (endpointHealth.get(url)?.cooldownUntil || 0) <= now);
  if (!available.length) {
    available = [...OVERPASS_ENDPOINTS].sort((a, b) =>
      (endpointHealth.get(a)?.cooldownUntil || 0) - (endpointHealth.get(b)?.cooldownUntil || 0)
    ).slice(0, 1);
  }
  return available;
}

async function tryOverpass(query, timeoutMs = 10000) {
  const failures = [];
  // Two mirrors per compact query is enough redundancy without sending the
  // same request to every free public server simultaneously.
  for (const url of endpointOrder().slice(0, 2)) {
    const startedAt = Date.now();
    try {
      log.debug("OVERPASS", `Trying ${url}`, { query_bytes: query.length });
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "AcquePulite/1.0 (river monitoring research dashboard)",
          Referer: "http://localhost:5173/"
        },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) {
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        const cooldownMs = res.status === 429 ? Math.max(30_000, retryAfter * 1000)
          : res.status >= 500 ? 45_000 : 15_000;
        endpointHealth.set(url, { cooldownUntil: Date.now() + cooldownMs, status: res.status });
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      endpointHealth.set(url, { cooldownUntil: 0, status: 200 });
      log.debug("OVERPASS", `Got ${data.elements?.length || 0} elements from ${url}`, {
        duration_ms: Date.now() - startedAt, query_bytes: query.length
      });
      return data;
    } catch (error) {
      if (!endpointHealth.has(url) || endpointHealth.get(url).status === 200) {
        endpointHealth.set(url, { cooldownUntil: Date.now() + 20_000, status: "network" });
      }
      const failure = {
        endpoint: endpointName(url),
        reason: error?.name === "TimeoutError" ? "timeout" : error.message,
        duration_ms: Date.now() - startedAt
      };
      failures.push(failure);
      log.warn("OVERPASS", `Mirror failed: ${failure.endpoint} (${failure.reason})`, failure);
    }
  }
  const error = new Error(`Overpass mirrors unavailable: ${failures.map(item => `${item.endpoint} ${item.reason}`).join("; ")}`);
  error.failures = failures;
  throw error;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function pointSegmentDistanceMeters(lat, lon, a, b) {
  const referenceLat = (lat + a[1] + b[1]) / 3 * Math.PI / 180;
  const metresPerLon = 111320 * Math.cos(referenceLat);
  const px = lon * metresPerLon;
  const py = lat * 110540;
  const ax = a[0] * metresPerLon;
  const ay = a[1] * 110540;
  const bx = b[0] * metresPerLon;
  const by = b[1] * 110540;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distanceToRiverMeters(lat, lon, geometry) {
  let nearest = Infinity;
  for (const line of geometryLines(geometry)) {
    if (line.length === 1) nearest = Math.min(nearest, distanceMeters(lat, lon, line[0][1], line[0][0]));
    for (let index = 1; index < line.length; index++) {
      nearest = Math.min(nearest, pointSegmentDistanceMeters(lat, lon, line[index - 1], line[index]));
    }
  }
  return Math.round(nearest);
}

function categorize(tags) {
  for (const [cat, patterns] of Object.entries(CATEGORY_QUERIES)) {
    for (const p of patterns) {
      const m = p.match(/\["([^"]+)"(?:=~?"([^"]+)")?\]/g);
      if (!m) continue;
      for (const match of m) {
        const [, key, val] = match.match(/\["([^"]+)"(?:=~?"([^"]+)")?/);
        if (val) {
          if (tags[key] && new RegExp(val.replace(/"/g, "")).test(tags[key])) return cat;
        } else {
          if (tags[key]) return cat;
        }
      }
    }
  }
  return "industrial";
}

function deriveName(tags) {
  return tags.name || tags.operator || tags.brand ||
    tags["name:it"] || tags["addr:street"] ||
    "Unnamed facility";
}

export async function queryNearbyFacilities(lat, lon, radius = 3000) {
  const query = buildQuery(lat, lon, radius);
  log.info("OVERPASS", `Querying facilities near ${lat},${lon} radius=${radius}m`);
  const t0 = Date.now();
  const data = await tryOverpass(query);
  const dt = Date.now() - t0;
  log.info("OVERPASS", `Got ${data.elements?.length || 0} results in ${dt}ms`);

  const seen = new Set();
  const facilities = [];
  for (const el of data.elements || []) {
    const lat2 = el.lat ?? el.center?.lat;
    const lon2 = el.lon ?? el.center?.lon;
    if (lat2 == null || lon2 == null) continue;
    const tags = el.tags || {};
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const cat = categorize(tags);
    facilities.push({
      id,
      name: deriveName(tags),
      category: cat,
      category_label: CATEGORY_LABELS[cat] || cat,
      lat: lat2,
      lon: lon2,
      distance_m: distanceMeters(lat, lon, lat2, lon2),
      osm_tags: tags
    });
  }
  facilities.sort((a, b) => a.distance_m - b.distance_m);
  log.debug("OVERPASS", `Deduplicated: ${facilities.length} facilities`);
  return facilities;
}

export async function queryFacilitiesAlongRiver(geometry, radius = 3000) {
  const queries = buildCorridorQueries(geometry, radius);
  log.info("OVERPASS", `Querying facilities within ${radius}m of river geometry`, { chunks: queries.length });
  const results = new Array(queries.length);
  let nextQuery = 0;
  const workers = Array.from({ length: Math.min(2, queries.length) }, async () => {
    while (nextQuery < queries.length) {
      const index = nextQuery++;
      try {
        results[index] = { ok: true, data: await tryOverpass(queries[index], 12000) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  const successful = results.filter(result => result?.ok);
  const failed = results.filter(result => result && !result.ok);
  if (!successful.length) {
    const error = new Error(`All ${queries.length} compact Overpass corridor queries failed`);
    error.failures = failed.flatMap(result => result.error?.failures || []);
    throw error;
  }
  const elements = successful.flatMap(result => result.data?.elements || []);
  const seen = new Set();
  const facilities = [];
  for (const el of elements) {
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const distance = distanceToRiverMeters(lat, lon, geometry);
    if (distance > radius) continue;
    const tags = el.tags || {};
    const category = categorize(tags);
    facilities.push({
      id, name: deriveName(tags), category,
      category_label: CATEGORY_LABELS[category] || category,
      lat, lon, distance_to_river_m: distance,
      source: "OpenStreetMap", osm_url: `https://www.openstreetmap.org/${id}`,
      osm_tags: tags
    });
  }
  facilities.sort((a, b) => a.distance_to_river_m - b.distance_to_river_m);
  const meta = {
    query_chunks: queries.length,
    successful_chunks: successful.length,
    failed_chunks: failed.length,
    partial: failed.length > 0,
    failures: failed.flatMap(result => result.error?.failures || []).slice(0, 8)
  };
  log.info("OVERPASS", `Corridor query completed: ${facilities.length} facilities`, meta);
  return { facilities, meta };
}

export { CATEGORY_LABELS };
