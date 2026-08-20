// Downloads all Italian EEA IED industrial sites from the ArcGIS MapServer
// (air.discomap.eea.europa.eu) and saves them to data/eea/ied_sites_it.json
// Run: node scripts/downloadEeaSites.js

import fs from "node:fs";
import path from "node:path";

const OUT_DIR = path.join(import.meta.dirname, "..", "data", "eea");
const BASE = "https://air.discomap.eea.europa.eu/arcgis/rest/services/Air/IED_SiteMap/MapServer/0/query";
const PAGE_SIZE = 2000;

async function fetchPage(offset) {
  const url = `${BASE}?where=countryCode%3D%27IT%27&outFields=*&returnGeometry=true&resultOffset=${offset}&resultRecordCount=${PAGE_SIZE}&f=pjson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // First get total count
  const countRes = await fetch(`${BASE}?where=countryCode%3D%27IT%27&returnCountOnly=true&f=pjson`);
  const countJson = await countRes.json();
  const total = countJson.count;
  console.log(`[EEA] Total Italian sites: ${total}`);

  const all = [];
  let offset = 0;
  while (offset < total) {
    const j = await fetchPage(offset);
    const feats = j.features || [];
    if (feats.length === 0) break;
    for (const f of feats) {
      const a = f.attributes;
      all.push({
        id: String(a.id),
        inspire_id: a.InspireSiteId || null,
        name: a.siteName || null,
        lat: a.y_4258,
        lon: a.x_4258,
        country: a.countryCode,
        city: a.cities || null,
        nuts: a.nuts_regions || null,
        river_basin_districts: a.rbds || null,
        sector: a.eprtr_sectors || null,
        activity: a.eea_activities || null,
        activity_details: a.activity_details || null,
        annex1: a.eprtr_AnnexIActivity || null,
        pollutants: a.pollutants || null,
        air_groups: a.air_groups || null,
        water_groups: a.water_groups || null,
        facility_names: a.facilityNames || null,
        reporting_year: a.Site_reporting_year || null,
        has_release_data: a.has_release_data,
        has_waste_data: a.has_waste_data,
        has_transfer_data: a.has_transfer_data,
        n_facilities: a.nFacilities,
        n_installations: a.nInstallations,
        n_lcp: a.nLCP,
        has_seveso: a.has_seveso
      });
    }
    offset += feats.length;
    if (offset % 10000 < PAGE_SIZE) {
      console.log(`[EEA] Downloaded ${offset}/${total}…`);
    }
    // small delay to be polite
    await new Promise(r => setTimeout(r, 150));
  }

  const outFile = path.join(OUT_DIR, "ied_sites_it.json");
  fs.writeFileSync(outFile, JSON.stringify(all));
  console.log(`[EEA] Saved ${all.length} sites to ${outFile} (${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB)`);
}

main().catch((e) => { console.error("[EEA] Failed:", e.message); process.exit(1); });