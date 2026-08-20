// Overpass API adapter — queries OpenStreetMap for industrial/farm/water/
// mining/fuel facilities near a given lat/lon within a radius (default 3km).
// Free, no API key needed. Attribution: OpenStreetMap contributors.

import { log } from "./logger.js";

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
];

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

function buildQuery(lat, lon, radius) {
  const filters = Object.entries(CATEGORY_QUERIES)
    .map(([cat, tags]) => tags.map(t => `node${t}(around:${radius},${lat},${lon}); way${t}(around:${radius},${lat},${lon});`).join(""))
    .join("");
  return `[out:json][timeout:25];(${filters});out tags center 100;`;
}

async function tryOverpass(query) {
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      log.debug("OVERPASS", `Trying ${url}`);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query)
      });
      if (!res.ok) { log.warn("OVERPASS", `${url} returned ${res.status}`); continue; }
      const data = await res.json();
      log.debug("OVERPASS", `Got ${data.elements?.length || 0} elements from ${url}`);
      return data;
    } catch (e) {
      log.warn("OVERPASS", `${url} failed: ${e.message}`);
    }
  }
  throw new Error("All Overpass endpoints failed");
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

export { CATEGORY_LABELS };