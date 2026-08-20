// EEA Industrial Emissions Portal adapter.
// The portal at industry.eea.europa.eu uses Volto SSR + internal Elasticsearch
// which is not publicly queryable via REST. However, the site-map-table page
// embeds a Redux state in window.__data that we can parse.
//
// As a fallback, we use OSM Overpass for industrial facilities nearby rivers.
//
// For the full EEA dataset, the user should download the bulk CSV from:
// https://industry.eea.europa.eu/industrial-emissions/dataset

import https from "node:https";
import { log } from "./logger.js";
import { EEA_IED } from "./arpaRegistry.js";

function httpGet(url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.get(urlObj, {
      headers: { "User-Agent": "RiverPollutionMap/1.0 (research)", "Accept": "text/html,*/*" },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let body = "";
      res.on("data", (chunk) => body += chunk);
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
  });
}

// Attempt to parse the embedded SSR data from the EEA portal page.
// The actual facility data loads client-side via JS, so this may return
// limited results. Falls back gracefully.
export async function fetchEEASitesItaly(limit = 500) {
  try {
    log.info("EEA", `Fetching Italian industrial sites from EEA portal…`);
    const url = `${EEA_IED.portal}/industrial-emissions/data-connectors/site-map-table?mode=connector&country=IT`;
    const html = await httpGet(url, 25000);

    // Try to extract window.__data JSON
    const m = html.match(/window\.__data=([\s\S]*?);<\/script>/);
    if (!m) {
      log.warn("EEA", "No __data found in SSR page");
      return [];
    }

    // The data_providers slice may contain facility data if SSR fetched it
    const dataStr = m[1];
    // Look for connected_data_parameters or data_providers with actual data
    // This is a heuristic parse — the real data structure is deeply nested
    // in the Volto Redux state.
    //
    // If data_providers.data is empty (common for client-side loaded data),
    // we return an empty array and rely on OSM Overpass instead.
    const dpMatch = dataStr.match(/"data_providers"\s*:\s*\{[^}]*"data"\s*:\s*\{([^}]*)\}/);
    if (!dpMatch || dpMatch[1].trim().length < 10) {
      log.info("EEA", "SSR data is empty (client-side loaded). Using OSM Overpass fallback.");
      return [];
    }

    log.info("EEA", `Parsed SSR data, extracting facilities…`);
    // In a full implementation, we would parse the Redux state here.
    // For now, return empty and rely on OSM.
    return [];
  } catch (e) {
    log.warn("EEA", `Failed to fetch EEA sites: ${e.message}`);
    return [];
  }
}

export { EEA_IED };