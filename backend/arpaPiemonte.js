import { log } from "./logger.js";
import { ecologicalScore, chemicalConstraint, combineScores, scoreToWfd } from "./wfdClassification.js";

export const PIEMONTE_SOURCE_URL = "https://webgis.arpa.piemonte.it/ags/rest/services/acqua/Classificazione_ambientale_CI_PdGPO/MapServer/2";
const QUERY_URL = `${PIEMONTE_SOURCE_URL}/query?where=1%3D1&outFields=*&returnGeometry=true&outSR=4326&f=geojson`;

function mergeGeometry(features) {
  const lines = features.flatMap(feature => feature.geometry?.type === "MultiLineString"
    ? feature.geometry.coordinates
    : feature.geometry?.type === "LineString" ? [feature.geometry.coordinates] : []);
  if (lines.length === 1) return { type: "LineString", coordinates: lines[0] };
  return lines.length ? { type: "MultiLineString", coordinates: lines } : null;
}

export async function loadArpaPiemonte() {
  const response = await fetch(QUERY_URL, { headers: { "User-Agent": "RiverWatch-Italy/1.0" } });
  if (!response.ok) throw new Error(`ARPA Piemonte ArcGIS ${response.status}`);
  const data = await response.json();
  const grouped = new Map();
  for (const feature of data.features || []) {
    const properties = feature.properties || {};
    const name = String(properties.NOME || "").trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!grouped.has(key)) grouped.set(key, { name, features: [], stretches: [] });
    const ecological = String(properties.P03618_1419_FI || "").trim() || null;
    const chemical = String(properties.P03477_1419_FI || "").trim() || null;
    const ecoScore = ecologicalScore(ecological);
    const chemScore = chemicalConstraint(chemical);
    grouped.get(key).features.push(feature);
    grouped.get(key).stretches.push({
      name: `${name} · ${properties.CODICE_CI || properties.WISE || "corpo idrico"}`,
      water_body_code: properties.WISE || properties.CODICE_CI || null,
      comune: null, status: ecological || chemical || "Non classificato",
      ecological, chemical,
      score: combineScores([ecoScore, chemScore]),
      source_url: PIEMONTE_SOURCE_URL,
      geometry: feature.geometry, geometry_source: "ARPA Piemonte official ArcGIS layer",
      source_feature_id: properties.CODICE_CI || properties.WISE || null,
      geometry_match: "native-source-feature", requires_review: false
    });
  }
  const rivers = [...grouped.entries()].map(([key, value]) => {
    const score = combineScores(value.stretches.map(stretch => stretch.score));
    return {
      id: `arpap_${key.replace(/[^a-z0-9]+/g, "_")}`, name: value.name,
      region: "Piemonte (ARPA Piemonte)", source: "ARPA Piemonte",
      source_url: PIEMONTE_SOURCE_URL,
      source_license: "ARPA Piemonte attribution; see service metadata",
      source_license_url: "https://webgis.arpa.piemonte.it/ags/rest/services/acqua/Classificazione_ambientale_CI_PdGPO/MapServer",
      source_period: "PdG Po 2021 classification (ecological/chemical status 2014–2019)",
      assessment_type: "WFD ecological + chemical status",
      wfd_status: scoreToWfd(score),
      stretches: value.stretches, geom: mergeGeometry(value.features), official_only: true
    };
  });
  log.info("ARPA-PIEMONTE", `Loaded ${rivers.length} rivers from ${data.features?.length || 0} official water bodies`);
  return rivers;
}
