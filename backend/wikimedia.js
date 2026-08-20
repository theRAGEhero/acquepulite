const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

const WATER_WORDS = /\b(fiume|torrente|rio|river|stream|watercourse|canale|canal|affluente|tributary)\b/i;
const ITALY_WORDS = /\b(italia|italy|italian[oa]?|lombardia|toscana|emilia|romagna|veneto|piemonte|liguria|lazio|umbria|marche|abruzzo|molise|campania|puglia|basilicata|calabria|sicilia|sardegna|trentino|alto adige|friuli|valle d.aosta)\b/i;
const WATER_TYPES = new Set(["Q4022", "Q355304", "Q47521", "Q12284", "Q55659167"]);

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
      "User-Agent": "RiverWatch-Italy/1.0 (environmental monitoring dashboard; educational project)",
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
    candidates: ranked.slice(1, 4).map(item => item.view), fetched_at: new Date().toISOString()
  } : {
    available: false, query, match: null, wikipedia: null, facts: [],
    candidates: ranked.slice(0, 4).map(item => item.view), fetched_at: new Date().toISOString()
  };
  cache.set(river.id, { savedAt: Date.now(), value: result });
  return result;
}
