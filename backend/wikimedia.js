const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

const WATER_WORDS = /\b(fiume|torrente|rio|river|stream|watercourse|canale|canal|affluente|tributary)\b/i;
const ITALY_WORDS = /\b(italia|italy|italian[oa]?|lombardia|toscana|emilia|romagna|veneto|piemonte|liguria|lazio|umbria|marche|abruzzo|molise|campania|puglia|basilicata|calabria|sicilia|sardegna|trentino|alto adige|friuli|valle d.aosta)\b/i;
const WATER_TYPES = new Set(["Q4022", "Q355304", "Q47521", "Q12284", "Q55659167"]);
const INCIDENT_WORDS = /\b(disastro|catastrofe|incidente|inquinamento|contaminazione|sversamento|alluvione|disaster|pollution|contamination|spill|flood)\b/i;
const INCIDENT_RELATIONS = {
  P276: "location", P361: "part of", P921: "main subject",
  P793: "significant event", P206: "located on physical feature"
};

const FACT_PROPERTIES = {
  P2043: { label: "Length", kind: "quantity" },
  P2053: { label: "Basin area", kind: "quantity" },
  P403: { label: "Mouth", kind: "entity" },
  P885: { label: "Source", kind: "entity" },
  P4614: { label: "Drainage basin", kind: "entity" },
  P625: { label: "Coordinates", kind: "coordinate" }
};

function normalizeName(value = "") {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(fiume|torrente|rio|river|stream|the|sublacuale|prelacuale|sopralacuale)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function claimEntityIds(entity, property) {
  return (entity?.claims?.[property] || [])
    .map(claim => claim?.mainsnak?.datavalue?.value?.id).filter(Boolean);
}

function coordinatePairs(geometry) {
  const pairs = [];
  function visit(value) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])) {
      pairs.push(value);
      return;
    }
    for (const child of value) visit(child);
  }
  visit(geometry?.coordinates);
  return pairs;
}

function distanceKm(lon1, lat1, lon2, lat2) {
  const toRad = value => value * Math.PI / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function scoreRiverCandidate(river, entity) {
  const riverName = normalizeName(river.name);
  const labels = [entity.labels?.it?.value, entity.labels?.en?.value].filter(Boolean);
  const descriptions = [entity.descriptions?.it?.value, entity.descriptions?.en?.value].filter(Boolean);
  const normalizedLabels = labels.map(normalizeName);
  let score = 0;
  if (normalizedLabels.some(label => label === riverName)) score += 55;
  else if (normalizedLabels.some(label => label.includes(riverName) || riverName.includes(label))) score += 24;
  if (descriptions.some(description => WATER_WORDS.test(description))) score += 25;
  if (descriptions.some(description => ITALY_WORDS.test(description))) score += 18;
  const regions = String(river.region || "").split("/").map(normalizeName).filter(Boolean);
  if (regions.some(region => descriptions.some(description => normalizeName(description).includes(region)))) score += 25;
  if (claimEntityIds(entity, "P17").includes("Q38")) score += 35;
  if (claimEntityIds(entity, "P31").some(id => WATER_TYPES.has(id))) score += 20;
  if (entity.sitelinks?.itwiki || entity.sitelinks?.enwiki) score += 5;
  const coordinate = entity?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
  const riverPairs = coordinatePairs(river.geom);
  if (Number.isFinite(coordinate?.longitude) && Number.isFinite(coordinate?.latitude) && riverPairs.length) {
    const nearest = riverPairs.reduce((minimum, pair) => Math.min(
      minimum, distanceKm(coordinate.longitude, coordinate.latitude, pair[0], pair[1])
    ), Infinity);
    if (nearest <= 50) score += 40;
    else if (nearest <= 150) score += 25;
    else if (nearest <= 350) score += 8;
    else if (nearest >= 500) score -= 35;
  }
  return score;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "AcquePulite/1.0 (environmental monitoring dashboard; educational project)",
      Accept: "application/json"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`Wikimedia request failed (${response.status})`);
  return response.json();
}

async function searchIds(query, language) {
  const params = new URLSearchParams({
    action: "wbsearchentities", search: query, language, uselang: language,
    type: "item", limit: "8", format: "json", origin: "*"
  });
  const data = await fetchJson(`${WIKIDATA_API}?${params}`);
  return (data.search || []).map(item => item.id).filter(Boolean);
}

async function getEntities(ids) {
  if (!ids.length) return {};
  const params = new URLSearchParams({
    action: "wbgetentities", ids: ids.join("|"),
    props: "labels|descriptions|claims|sitelinks", languages: "it|en",
    sitefilter: "itwiki|enwiki", format: "json", origin: "*"
  });
  const data = await fetchJson(`${WIKIDATA_API}?${params}`);
  return data.entities || {};
}

async function getEntitiesBatched(ids, batchSize = 50) {
  const entities = {};
  for (let index = 0; index < ids.length; index += batchSize) {
    Object.assign(entities, await getEntities(ids.slice(index, index + batchSize)));
  }
  return entities;
}

function bestText(entity, field) {
  return entity?.[field]?.it?.value || entity?.[field]?.en?.value || null;
}

function candidateView(river, entity) {
  const score = scoreRiverCandidate(river, entity);
  const descriptions = [entity.descriptions?.it?.value, entity.descriptions?.en?.value].filter(Boolean);
  const watercourse = descriptions.some(description => WATER_WORDS.test(description))
    || claimEntityIds(entity, "P31").some(id => WATER_TYPES.has(id));
  return {
    id: entity.id,
    label: bestText(entity, "labels") || entity.id,
    description: bestText(entity, "descriptions"), score,
    confidence: score >= 110 ? "high" : score >= 78 ? "medium" : "low", watercourse,
    wikidata_url: `https://www.wikidata.org/wiki/${entity.id}`
  };
}

function rawClaim(entity, property) {
  return entity?.claims?.[property]?.[0]?.mainsnak?.datavalue?.value;
}

function quantityFact(property, value) {
  if (!value?.amount) return null;
  const amount = Number(value.amount);
  if (!Number.isFinite(amount)) return null;
  const unitId = typeof value.unit === "string" ? value.unit.split("/").pop() : null;
  const unit = unitId === "Q828224" ? "km" : unitId === "Q712226" ? "km²" : null;
  return { property, label: FACT_PROPERTIES[property].label, value: Number(amount.toFixed(2)), unit };
}

async function buildFacts(entity) {
  const linkedIds = Object.entries(FACT_PROPERTIES)
    .filter(([, config]) => config.kind === "entity")
    .flatMap(([property]) => claimEntityIds(entity, property));
  const linkedEntities = await getEntities([...new Set(linkedIds)]);
  const facts = [];
  for (const [property, config] of Object.entries(FACT_PROPERTIES)) {
    const value = rawClaim(entity, property);
    if (!value) continue;
    if (config.kind === "quantity") {
      const fact = quantityFact(property, value);
      if (fact) facts.push(fact);
    } else if (config.kind === "coordinate" && Number.isFinite(value.latitude) && Number.isFinite(value.longitude)) {
      facts.push({ property, label: config.label, value: `${value.latitude.toFixed(4)}, ${value.longitude.toFixed(4)}` });
    } else if (config.kind === "entity" && value.id) {
      const linked = linkedEntities[value.id];
      facts.push({
        property, label: config.label, value: bestText(linked, "labels") || value.id,
        entity_id: value.id, url: `https://www.wikidata.org/wiki/${value.id}`
      });
    }
  }
  return facts;
}

async function getWikipedia(entity) {
  const sitelink = entity.sitelinks?.itwiki
    ? { language: "it", ...entity.sitelinks.itwiki }
    : entity.sitelinks?.enwiki ? { language: "en", ...entity.sitelinks.enwiki } : null;
  if (!sitelink?.title) return null;
  const fallbackUrl = `https://${sitelink.language}.wikipedia.org/wiki/${encodeURIComponent(sitelink.title.replace(/ /g, "_"))}`;
  try {
    const summary = await fetchJson(
      `https://${sitelink.language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(sitelink.title)}`
    );
    return {
      title: summary.title || sitelink.title, language: sitelink.language,
      url: summary.content_urls?.desktop?.page || fallbackUrl,
      extract: summary.extract || null, thumbnail: summary.thumbnail?.source || null
    };
  } catch {
    return { title: sitelink.title, language: sitelink.language, url: fallbackUrl, extract: null, thumbnail: null };
  }
}

function claimDate(entity) {
  for (const property of ["P585", "P580", "P571"]) {
    const time = rawClaim(entity, property)?.time;
    if (time) return time.replace(/^\+/, "").slice(0, 10);
  }
  return null;
}

async function directlyLinkedItems(riverId) {
  const query = `SELECT DISTINCT ?item ?property ?direction WHERE {
    VALUES ?property { wdt:P276 wdt:P361 wdt:P921 wdt:P793 wdt:P206 }
    {
      ?item ?property wd:${riverId} .
      BIND("item_to_river" AS ?direction)
    } UNION {
      wd:${riverId} ?property ?item .
      BIND("river_to_item" AS ?direction)
    }
    FILTER(?item != wd:${riverId})
  } LIMIT 50`;
  const params = new URLSearchParams({ query, format: "json" });
  const data = await fetchJson(`https://query.wikidata.org/sparql?${params}`);
  const linked = new Map();
  for (const binding of data.results?.bindings || []) {
    const id = binding.item?.value?.split("/").pop();
    const property = binding.property?.value?.split("/").pop();
    if (!id || !property) continue;
    if (!linked.has(id)) linked.set(id, []);
    linked.get(id).push({ property, direction: binding.direction?.value || "item_to_river" });
  }
  return linked;
}

function incidentRelationText(relations) {
  const strongest = relations.find(item => item.property === "P793") || relations[0];
  if (!strongest) return "River named in the Wikidata label or description";
  if (strongest.property === "P793" && strongest.direction === "river_to_item") {
    return "Listed by Wikidata as a significant event of this river";
  }
  const label = INCIDENT_RELATIONS[strongest.property] || strongest.property;
  return strongest.direction === "item_to_river"
    ? `Wikidata ${label} relationship points to this river`
    : `This river's Wikidata ${label} relationship points to the event`;
}

export function scoreIncidentCandidate(river, entity, directRelations = []) {
  const label = bestText(entity, "labels") || entity.id;
  const description = bestText(entity, "descriptions") || "";
  const normalizedText = normalizeName(`${label} ${description}`);
  const riverName = normalizeName(river.name);
  const riverNamed = Boolean(riverName && normalizedText.includes(riverName));
  const incidentLanguage = INCIDENT_WORDS.test(`${label} ${description}`);
  const environmentalClass = claimEntityIds(entity, "P31").includes("Q3193890");
  const significantEvent = directRelations.some(relation => relation.property === "P793");
  const direct = directRelations.length > 0;
  const incidentEvidence = incidentLanguage || environmentalClass || significantEvent;
  let score = direct ? 55 : 0;
  if (riverNamed) score += 30;
  if (incidentLanguage) score += 35;
  if (environmentalClass) score += 50;
  if (significantEvent) score += 25;
  if (entity.sitelinks?.itwiki || entity.sitelinks?.enwiki) score += 5;
  return {
    entity, score, direct, label, description, incidentEvidence,
    relation: incidentRelationText(directRelations),
    evidence: [
      direct && "Structured river relationship",
      significantEvent && "Significant-event property",
      environmentalClass && "Environmental-disaster class",
      riverNamed && "River named in item",
      incidentLanguage && "Incident terminology"
    ].filter(Boolean)
  };
}

async function getEnvironmentalIncidents(river, riverEntity) {
  let directLinks = new Map();
  try { directLinks = await directlyLinkedItems(riverEntity.id); } catch { /* WDQS is optional */ }
  const searches = await Promise.allSettled([
    searchIds(`${river.name} inquinamento`, "it"),
    searchIds(`${river.name} disastro`, "it"),
    searchIds(`${river.name} sversamento`, "it"),
    searchIds(`${river.name} pollution`, "en")
  ]);
  const searchedIds = searches.flatMap(result => result.status === "fulfilled" ? result.value : []);
  const ids = [...new Set([...directLinks.keys(), ...searchedIds])].filter(id => id !== riverEntity.id).slice(0, 50);
  const entities = await getEntities(ids);
  const ranked = Object.values(entities)
    .map(entity => scoreIncidentCandidate(river, entity, directLinks.get(entity.id) || []))
    .filter(item => item.incidentEvidence && item.score >= 70)
    .sort((a, b) => b.score - a.score).slice(0, 6);

  return Promise.all(ranked.map(async item => ({
    id: item.entity.id, label: item.label, description: item.description,
    date: claimDate(item.entity), confidence: item.score >= 120 ? "high" : "medium",
    score: item.score, relation: item.relation, evidence: item.evidence,
    wikidata_url: `https://www.wikidata.org/wiki/${item.entity.id}`,
    wikipedia: await getWikipedia(item.entity)
  })));
}

function pointSegmentDistanceKm(lat, lon, a, b) {
  const referenceLat = (lat + a[1] + b[1]) / 3 * Math.PI / 180;
  const kmPerLon = 111.32 * Math.cos(referenceLat);
  const px = lon * kmPerLon;
  const py = lat * 110.54;
  const ax = a[0] * kmPerLon;
  const ay = a[1] * 110.54;
  const bx = b[0] * kmPerLon;
  const by = b[1] * 110.54;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const position = lengthSquared
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
    : 0;
  return Math.hypot(px - (ax + position * dx), py - (ay + position * dy));
}

export function distanceToRiverKm(lat, lon, geometry) {
  let nearest = Infinity;
  for (const line of geometryLinesForPopulation(geometry)) {
    if (line.length === 1) nearest = Math.min(nearest, distanceKm(lon, lat, line[0][0], line[0][1]));
    for (let index = 1; index < line.length; index++) {
      nearest = Math.min(nearest, pointSegmentDistanceKm(lat, lon, line[index - 1], line[index]));
    }
  }
  return nearest;
}

function geometryLinesForPopulation(geometry) {
  if (geometry?.type === "LineString") return [geometry.coordinates || []];
  if (geometry?.type === "MultiLineString") return geometry.coordinates || [];
  return [];
}

function pointAlongLine(line, targetKm) {
  let travelled = 0;
  for (let index = 1; index < line.length; index++) {
    const start = line[index - 1];
    const end = line[index];
    const segmentKm = distanceKm(start[0], start[1], end[0], end[1]);
    if (travelled + segmentKm >= targetKm) {
      const fraction = segmentKm ? (targetKm - travelled) / segmentKm : 0;
      return [
        start[0] + (end[0] - start[0]) * fraction,
        start[1] + (end[1] - start[1]) * fraction
      ];
    }
    travelled += segmentKm;
  }
  return line[line.length - 1];
}

export function sampleRiverCorridor(geometry, spacingKm = 15, maximumPoints = 36) {
  const sampled = [];
  for (const line of geometryLinesForPopulation(geometry).filter(value => value.length)) {
    const lengthKm = line.slice(1).reduce((sum, point, index) => (
      sum + distanceKm(line[index][0], line[index][1], point[0], point[1])
    ), 0);
    const count = Math.max(1, Math.ceil(lengthKm / spacingKm) + 1);
    for (let index = 0; index < count; index++) {
      sampled.push(pointAlongLine(line, count === 1 ? 0 : lengthKm * index / (count - 1)));
    }
  }
  if (sampled.length <= maximumPoints) return sampled;
  const reduced = [];
  const step = (sampled.length - 1) / (maximumPoints - 1);
  for (let index = 0; index < maximumPoints; index++) reduced.push(sampled[Math.round(index * step)]);
  return reduced;
}

function qualifierDate(claim, property = "P585") {
  const time = claim?.qualifiers?.[property]?.[0]?.datavalue?.value?.time;
  return time ? time.replace(/^\+/, "").slice(0, 10) : null;
}

export function selectLatestPopulation(entity) {
  const claims = (entity?.claims?.P1082 || []).filter(claim => {
    const amount = Number(claim?.mainsnak?.datavalue?.value?.amount);
    return claim.rank !== "deprecated" && Number.isFinite(amount) && amount >= 0;
  });
  if (!claims.length) return null;
  claims.sort((a, b) => {
    const rank = value => value.rank === "preferred" ? 2 : 1;
    return rank(b) - rank(a) || String(qualifierDate(b) || "").localeCompare(String(qualifierDate(a) || ""));
  });
  const claim = claims[0];
  const population = Math.round(Number(claim.mainsnak.datavalue.value.amount));
  const references = claim.references || [];
  const sourceUrls = [...new Set(references.flatMap(reference => (
    reference.snaks?.P854 || []
  )).map(snak => snak?.datavalue?.value).filter(value => typeof value === "string" && /^https?:/i.test(value)))];
  const statedIn = [...new Set(references.flatMap(reference => (
    reference.snaks?.P248 || []
  )).map(snak => snak?.datavalue?.value?.id).filter(Boolean))];
  return {
    population,
    date: qualifierDate(claim),
    rank: claim.rank || "normal",
    source_urls: sourceUrls,
    stated_in: statedIn.map(id => ({ id, url: `https://www.wikidata.org/wiki/${id}` }))
  };
}

const POPULATION_RADIUS_KM = 10;
const SETTLEMENT_TYPES = ["Q747074", "Q515", "Q3957", "Q532", "Q5084", "Q486972", "Q1134686", "Q123705"];

async function findNearbySettlementIds(geometry) {
  const centers = sampleRiverCorridor(geometry);
  if (!centers.length) return { ids: [], centers: [], query: null };
  const centerValues = centers.map(([lon, lat]) => (
    `"Point(${Number(lon).toFixed(6)} ${Number(lat).toFixed(6)})"^^geo:wktLiteral`
  )).join(" ");
  const typeValues = SETTLEMENT_TYPES.map(id => `wd:${id}`).join(" ");
  const query = `SELECT DISTINCT ?place WHERE {
    VALUES ?center { ${centerValues} }
    SERVICE wikibase:around {
      ?place wdt:P625 ?location .
      bd:serviceParam wikibase:center ?center .
      bd:serviceParam wikibase:radius "${POPULATION_RADIUS_KM}" .
    }
    ?place wdt:P17 wd:Q38 ; wdt:P31 ?kind ; wdt:P1082 ?population .
    VALUES ?kind { ${typeValues} }
  } LIMIT 300`;
  const params = new URLSearchParams({ query, format: "json" });
  const data = await fetchJson(`https://query.wikidata.org/sparql?${params}`);
  const ids = [...new Set((data.results?.bindings || [])
    .map(binding => binding.place?.value?.split("/").pop()).filter(Boolean))];
  return { ids, centers, query };
}

const populationPending = new Map();

export async function getNearbyPopulationContext(river) {
  const cacheKey = `population:${river.id}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return cached.value;
  if (populationPending.has(cacheKey)) return populationPending.get(cacheKey);
  const request = buildNearbyPopulationContext(river, cacheKey);
  populationPending.set(cacheKey, request);
  try {
    return await request;
  } finally {
    populationPending.delete(cacheKey);
  }
}

async function buildNearbyPopulationContext(river, cacheKey) {
  const { ids, centers, query } = await findNearbySettlementIds(river.geom);
  const entities = await getEntitiesBatched(ids);
  const places = Object.values(entities).map(entity => {
    const population = selectLatestPopulation(entity);
    const coordinate = rawClaim(entity, "P625");
    if (!population || !Number.isFinite(coordinate?.latitude) || !Number.isFinite(coordinate?.longitude)) return null;
    const distance = distanceToRiverKm(coordinate.latitude, coordinate.longitude, river.geom);
    if (!Number.isFinite(distance) || distance > POPULATION_RADIUS_KM) return null;
    return {
      id: entity.id,
      name: bestText(entity, "labels") || entity.id,
      description: bestText(entity, "descriptions"),
      lat: coordinate.latitude,
      lon: coordinate.longitude,
      distance_to_river_km: Number(distance.toFixed(2)),
      ...population,
      wikidata_url: `https://www.wikidata.org/wiki/${entity.id}`,
      population_statement_url: `https://www.wikidata.org/wiki/${entity.id}#P1082`
    };
  }).filter(Boolean).sort((a, b) => a.distance_to_river_km - b.distance_to_river_km || b.population - a.population);
  const sourcedPlaces = places.slice(0, 80);
  const result = {
    available: true,
    radius_km: POPULATION_RADIUS_KM,
    place_count: sourcedPlaces.length,
    matched_place_count: places.length,
    places_truncated: places.length > sourcedPlaces.length,
    reported_population_sum: sourcedPlaces.reduce((sum, place) => sum + place.population, 0),
    places: sourcedPlaces,
    sampled_points: centers.length,
    methodology: "Wikidata settlements and Italian municipalities whose coordinate point is within the mapped river corridor; exact distance is recalculated against the river line.",
    interpretation: "Context only. The sum is non-additive and is not a count of people exposed, served, flooded, or otherwise affected by the river.",
    source: {
      name: "Wikidata",
      url: "https://www.wikidata.org/",
      query_service_url: query ? `https://query.wikidata.org/#${encodeURIComponent(query)}` : "https://query.wikidata.org/",
      population_property_url: "https://www.wikidata.org/wiki/Property:P1082",
      point_in_time_property_url: "https://www.wikidata.org/wiki/Property:P585",
      license: "CC0 1.0",
      license_url: "https://www.wikidata.org/wiki/Wikidata:Licensing"
    },
    fetched_at: new Date().toISOString()
  };
  cache.set(cacheKey, { savedAt: Date.now(), value: result });
  return result;
}

export async function getRiverImage(river) {
  const cacheKey = `image:${river.id}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return cached.value;
  const searchName = river.name.replace(/\b(sublacuale|prelacuale|sopralacuale)\b/gi, "").trim();
  const result = await buildRiverImage(river, searchName);
  // Only cache successful lookups: a transient Wikimedia outage or rate limit
  // must not pin "no image" for 24 hours.
  if (result.available) cache.set(cacheKey, { savedAt: Date.now(), value: result });
  return result;
}

async function buildRiverImage(river, searchName) {
  const fallback = { available: false, image_url: null, thumb_url: null, page_url: null, license: null, artist: null };
  try {
    const params = new URLSearchParams({
      action: "query", generator: "search", gsrsearch: `${searchName} fiume`,
      gsrnamespace: "6", gsrlimit: "12", prop: "imageinfo",
      iiprop: "url|extmetadata", iiurlwidth: "640", format: "json", origin: "*"
    });
    const data = await fetchJson(`https://commons.wikimedia.org/w/api.php?${params}`);
    const pages = Object.values(data?.query?.pages || {});
    const normalized = normalizeName(searchName);
    const namePattern = normalized.length >= 4
      ? new RegExp(normalized, "i")
      : new RegExp(`(^|[^a-z])${normalized}([^a-z]|$)`, "i");
    const candidates = pages
      .map(page => {
        const info = page.imageinfo?.[0];
        if (!info) return null;
        const metadata = info.extmetadata || {};
        const title = String(page.title || "");
        const description = String(metadata.ImageDescription?.value || "");
        const titleScore = namePattern.test(title) ? 2 : 0;
        const descriptionScore = namePattern.test(description) ? 1 : 0;
        const waterScore = WATER_WORDS.test(description) ? 1 : 0;
        const width = Number(info.width) || 0;
        const height = Number(info.height) || 0;
        const landscape = width >= height;
        const sizeScore = width >= 400 && height >= 200 ? 1 : 0;
        return {
          page, info, metadata,
          score: titleScore * 3 + descriptionScore * 2 + waterScore + sizeScore + (landscape ? 1 : 0)
        };
      })
      .filter(item => item && item.score >= 3)
      .sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best) return fallback;
    const license = best.metadata.LicenseShortName?.value || null;
    const artist = String(best.metadata.Artist?.value || "").replace(/<[^>]+>/g, "").trim() || null;
    return {
      available: true,
      image_url: best.info.url,
      thumb_url: best.info.thumburl || best.info.url,
      page_url: best.info.descriptionurl || null,
      license,
      artist,
      source: "Wikimedia Commons",
      source_url: "https://commons.wikimedia.org/"
    };
  } catch {
    return fallback;
  }
}

export async function getRiverKnowledge(river) {
  const cached = cache.get(river.id);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return cached.value;
  const searchName = river.name.replace(/\b(sublacuale|prelacuale|sopralacuale)\b/gi, "").trim();
  const query = searchName;
  const italianIds = await searchIds(searchName, "it");
  const englishIds = italianIds.length < 4 ? await searchIds(searchName, "en") : [];
  const ids = [...new Set([...italianIds, ...englishIds])].slice(0, 12);
  const entities = await getEntities(ids);
  const ranked = Object.values(entities).filter(entity => !entity.missing)
    .map(entity => ({ entity, view: candidateView(river, entity) }))
    .sort((a, b) => b.view.score - a.view.score);
  const top = ranked[0];
  const runnerUp = ranked[1];
  const unambiguous = !runnerUp || top.view.score - runnerUp.view.score >= 12;
  const accepted = top?.view.watercourse && top.view.score >= 75 && unambiguous ? top : null;
  const result = accepted ? {
    available: true, query, match: accepted.view,
    wikipedia: await getWikipedia(accepted.entity), facts: await buildFacts(accepted.entity),
    environmental_incidents: await getEnvironmentalIncidents(river, accepted.entity),
    candidates: ranked.slice(1, 4).map(item => item.view), fetched_at: new Date().toISOString()
  } : {
    available: false, query, match: null, wikipedia: null, facts: [],
    environmental_incidents: [],
    candidates: ranked.slice(0, 4).map(item => item.view), fetched_at: new Date().toISOString()
  };
  cache.set(river.id, { savedAt: Date.now(), value: result });
  return result;
}
