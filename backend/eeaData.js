// EEA Industrial Emissions data importer.
// Reads the EEA "Industrial reporting dataset" files placed in
// ./data/eea/ (user downloads the ZIP manually from the EEA portal:
//   https://industry.eea.europa.eu/industrial-emissions/dataset
// → "Industrial reporting dataset" → Download, unzip into ./data/eea/)
//
// Expected files (after unzip):
//   site.csv            - Site Registry: site id, name, address, coordinates
//   facility.csv        - EU Registry: facility id, site id, name
//   pollutant.csv       - E-PRTR releases: site/facility, pollutant, medium, amount, year
//   transfer.csv        - E-PRTR transfers
//   installation.csv    - IED installations & permits
//   lcp.csv             - Large Combustion Plants

import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { log } from "./logger.js";

const DATA_DIR = path.join(import.meta.dirname, "data", "eea");
const CACHE_FILE = path.join(import.meta.dirname, "data", "eea", "_parsed.json");

// Map EEA pollutant codes to our ARPA parameter codes (cross-reference)
export const POLLUTANT_MAP = {
  NITR: "NO3",
  N: "NO3",
  PHOS: "PO4",
  PB: "PB",
  NI: "NI",
  CR: "CR",
  CD: "CD",
  AS: "AS",
  HG: "HG",
  ZN: "ZN",
  CU: "CU",
  "E.COLI": "EC",
  NH4: "NH4",
  BOD: "BOD5",
  COD: "COD"
};

// CSV parser (handles quotes, BOM)
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(f => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(f => f.trim() !== "")) rows.push(row);
  return rows;
}

function readCsv(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const rows = parseCSV(text);
  if (rows.length === 0) return { header: [], rows: [] };
  const header = rows[0].map(h => h.trim());
  return { header, rows: rows.slice(1) };
}

function rowToObj(header, row) {
  const obj = {};
  for (let i = 0; i < header.length; i++) obj[header[i]] = (row[i] || "").trim();
  return obj;
}

function findColumn(header, names) {
  for (const n of names) {
    const idx = header.findIndex(h => h.toLowerCase() === n.toLowerCase());
    if (idx !== -1) return idx;
  }
  return -1;
}

function get(obj, names) {
  for (const n of names) {
    if (obj[n] != null && obj[n] !== "") return obj[n];
  }
  return "";
}

const empty = { sites: [], facilities: [], pollutant: [], transfers: [], installations: [], lcp: [] };

// Main import: returns { sites, facilities, pollutant, transfers, installations, lcp }
export async function loadEeaData() {
  // Cache hit?
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      log.info("EEA-IMPORT", `Loaded ${cached.sites.length} sites from cache`);
      return cached;
    } catch (e) {
      log.warn("EEA-IMPORT", `Cache read failed: ${e.message}`);
    }
  }

  let files = [];
  try { files = fs.readdirSync(DATA_DIR).map(f => path.join(DATA_DIR, f)); }
  catch (e) {
    log.warn("EEA-IMPORT", `No data dir (${DATA_DIR}) — put the EEA dataset here. Skipping.`);
    return empty;
  }

  // Unzip if present
  const zipFiles = files.filter(f => f.toLowerCase().endsWith(".zip"));
  if (zipFiles.length > 0) {
    log.info("EEA-IMPORT", `Found ZIP: ${zipFiles[0]}`);
    const zip = new AdmZip(zipFiles[0]);
    const tmpDir = path.join(DATA_DIR, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    const extracted = [];
    for (const e of zip.getEntries()) {
      if (!e.isDirectory && /\.(csv|txt)$/i.test(e.entryName)) {
        const out = path.join(tmpDir, path.basename(e.entryName));
        fs.writeFileSync(out, e.getData());
        extracted.push(out);
      }
    }
    files = extracted;
  }

  const result = { sites: [], facilities: [], pollutant: [], transfers: [], installations: [], lcp: [] };

  // --- SITES ---
  const siteFile = findFile(files, ["site"]);
  if (siteFile) {
    const { header, rows } = readCsv(siteFile);
    const idIdx = findColumn(header, ["site id", "siteid", "site_id", "eprtrsiteid", "iedsiteid", "id"]);
    const nameIdx = findColumn(header, ["site name", "sitename", "site_name", "name"]);
    const lonIdx = findColumn(header, ["longitude", "lon"]);
    const latIdx = findColumn(header, ["latitude", "lat"]);
    const countryIdx = findColumn(header, ["country", "countrycode", "country_code"]);
    const sectorIdx = findColumn(header, ["sector", "sectorname", "main sector", "annex i main activity", "industrialsector"]);
    const subIdx = findColumn(header, ["subsector", "sub sector", "annex i subsector", "industrialsubsector"]);
    const cityIdx = findColumn(header, ["city", "municipality", "town"]);
    const addrIdx = findColumn(header, ["address", "street"]);

    for (const row of rows) {
      const o = rowToObj(header, row);
      const id = getVal(o, ["Site ID", "SiteId", "siteId", "site_id", "EPRTRSiteId", "IEDSiteId", "id"]);
      if (!id) continue;
      const lat = parseFloat(getVal(o, ["Latitude", "lat"]));
      const lon = parseFloat(getVal(o, ["Longitude", "lon"]));
      result.sites[id] = {
        id: String(id),
        name: getVal(o, ["Site name", "SiteName", "siteName", "Name"]),
        lat: isFinite(lat) ? lat : null,
        lon: isFinite(lon) ? lon : null,
        country: getVal(o, ["Country", "CountryCode", "country_code"]),
        sector: getVal(o, ["Sector", "SectorName", "Main sector", "Annex I Main activity"]),
        subsector: getVal(o, ["Subsector", "Sub sector", "Annex I Subsector"]),
        city: getVal(o, ["City", "Municipality", "Town"]),
        address: getVal(o, ["Address", "Street"])
      };
    }
    log.info("EEA-IMPORT", `Sites parsed: ${Object.keys(result.sites).length}`);
  }

  // --- FACILITIES ---
  const facilityFile = findFile(files, ["facility"]);
  if (facilityFile) {
    const { header, rows } = readCsv(facilityFile);
    for (const row of rows) {
      const o = rowToObj(header, row);
      const id = getStr(o, ["Facility ID", "FacilityId", "facilityId", "id"]);
      const siteId = getStr(o, ["Site ID", "SiteId", "siteId"]);
      if (id && siteId) {
        result.facilities.push({
          id: String(id),
          siteId: String(siteId),
          name: getStr(o, ["Facility name", "FacilityName", "name"])
        });
      }
    }
    log.info("EEA-IMPORT", `Facilities parsed: ${result.facilities.length}`);
  }

  // --- POLLUTANT RELEASES ---
  const pollutantFile = findFile(files, ["pollutant", "release"]);
  if (pollutantFile) {
    const { header, rows } = readCsv(pollutantFile);
    for (const row of rows) {
      const o = rowToObj(header, row);
      const facilityId = getStr(o, ["Facility ID", "FacilityId", "facilityId"]);
      const siteId = getStr(o, ["Site ID", "SiteId", "siteId"]);
      const pollutant = getStr(o, ["Pollutant", "Pollutant code", "PollutantName", "Pollutant name"]);
      const medium = getStr(o, ["Medium", "Release medium", "Receiving environment"]);
      const amount = parseFloat(getStr(o, ["Total release", "Amount", "Quantity", "Total"]));
      const year = getStr(o, ["Reporting year", "Year"]);
      const unit = getStr(o, ["Unit"]) || "kg";
      if (pollutant && (facilityId || siteId)) {
        result.pollutant.push({
          facilityId, siteId,
          pollutant,
          paramCode: POLLUTANT_MAP[pollutant.toUpperCase()] || null,
          medium, amount: isFinite(amount) ? amount : null, unit, year
        });
      }
    }
    log.info("EEA-IMPORT", `Pollutant releases parsed: ${result.pollutant.length}`);
  }

  // --- TRANSFERS ---
  const transferFile = findFile(files, ["transfer"]);
  if (transferFile) {
    const { header, rows } = readCsv(transferFile);
    for (const row of rows) {
      const o = rowToObj(header, row);
      const siteId = getStr(o, ["Site ID", "SiteId", "siteId"]);
      const pollutant = getStr(o, ["Pollutant", "Pollutant code"]);
      const amount = parseFloat(getStr(o, ["Amount transferred", "Amount", "Total transfer"]));
      const year = getStr(o, ["Reporting year", "Year"]);
      if (pollutant && siteId) {
        result.transfers.push({
          siteId, pollutant, amount: isFinite(amount) ? amount : null,
          unit: getStr(o, ["Unit"]) || "kg", year
        });
      }
    }
    log.info("EEA-IMPORT", `Transfers parsed: ${result.transfers.length}`);
  }

  // --- INSTALLATIONS (permits) ---
  const installFile = findFile(files, ["installation", "permit"]);
  if (installFile) {
    const { header, rows } = readCsv(installFile);
    for (const row of rows) {
      const o = rowToObj(header, row);
      const siteId = getStr(o, ["Site ID", "SiteId", "siteId"]);
      if (siteId) {
        result.installations.push({
          siteId,
          permit: getStr(o, ["Permit", "Permit ID", "PermitId", "permit"]),
          status: getStr(o, ["Status", "Permit status"]),
          year: getStr(o, ["Permit year", "Reporting year", "Year"])
        });
      }
    }
    log.info("EEA-IMPORT", `Installations parsed: ${result.installations.length}`);
  }

  // --- LCP ---
  const lcpFile = findFile(files, ["lcp"]);
  if (lcpFile) {
    const { header, rows } = readCsv(lcpFile);
    for (const row of rows) {
      const o = rowToObj(header, row);
      const siteId = getStr(o, ["Site ID", "SiteId", "siteId"]);
      if (siteId) {
        result.lcp.push({
          siteId,
          name: getStr(o, ["Plant name", "LCP name", "PlantName"]),
          capacity: parseFloat(getStr(o, ["Thermal capacity", "Capacity"])) || null,
          fuel: getStr(o, ["Fuel", "Main fuel"])
        });
      }
    }
    log.info("EEA-IMPORT", `LCPs parsed: ${result.lcp.length}`);
  }

  // Normalize sites to array
  result.sites = Object.values(result.sites);

  fs.writeFileSync(CACHE_FILE, JSON.stringify(result));
  log.info("EEA-IMPORT", `Cached ${result.sites.length} sites, ${result.facilities.length} facilities, ${result.pollutant.length} releases, ${result.transfers.length} transfers`);
  return result;
}

function findFile(files, patterns) {
  for (const f of files) {
    const base = path.basename(f).toLowerCase();
    for (const p of patterns) {
      if (base.includes(p)) return f;
    }
  }
  return null;
}

function getStr(obj, names) {
  for (const n of names) {
    if (obj[n] != null && obj[n] !== "") return String(obj[n]);
  }
  return "";
}

export function hasEeaData() {
  return fs.existsSync(CACHE_FILE);
}

export { empty as EMPTY_EEA };