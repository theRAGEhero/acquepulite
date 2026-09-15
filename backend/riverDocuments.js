// River document archive — file-based, filled by the team over time.
// Documents live in backend/data/documents/ as JSON metadata files and their
// binary files in backend/data/documents/files/. The page stays accessible
// even while the archive is empty: the API returns an empty, filterable list.
//
// Metadata schema (all fields optional except id/title):
// {
//   "id": "po-2024-report",            // unique slug, used in URLs
//   "title": "Relazione annuale Po 2024",
//   "river_ids": ["po"],               // links to /api/rivers ids
//   "river_names": ["Po"],             // free-text names for rivers not yet in the map
//   "region_codes": ["LOM"],           // ISO-ish region codes used by /api/regions
//   "type": "report",                  // report | study | legal | monitoring | press | other
//   "year": 2024,
//   "date": "2024-06-30",              // ISO date, optional
//   "author": "ARPA Lombardia",
//   "description": "…",
//   "file": "po-2024-report.pdf",      // relative to data/documents/files/
//   "url": "https://…",                // external link instead of a local file
//   "language": "it",
//   "tags": ["wfd", "nitrates"]
// }

import fs from "node:fs";
import path from "node:path";
import { log } from "./logger.js";

export const DOCUMENT_TYPES = [
  { value: "report", label: "Report" },
  { value: "study", label: "Study" },
  { value: "legal", label: "Legal" },
  { value: "monitoring", label: "Monitoring" },
  { value: "press", label: "Press" },
  { value: "other", label: "Other" }
];

const DOCUMENTS_DIR = path.join(import.meta.dirname, "data", "documents");
const FILES_DIR = path.join(DOCUMENTS_DIR, "files");

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,120}$/;
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._() -]{0,180}$/;

function normalizeId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeList(value) {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : [value];
  return [...new Set(items.map(item => String(item).trim()).filter(Boolean))];
}

function normalizeDocument(raw, fileName) {
  const id = normalizeId(raw.id);
  if (!id) return null;
  const title = String(raw.title || "").trim();
  if (!title) return null;
  const year = Number(raw.year);
  const doc = {
    id,
    title,
    river_ids: normalizeList(raw.river_ids),
    river_names: normalizeList(raw.river_names),
    region_codes: normalizeList(raw.region_codes).map(code => code.toUpperCase()),
    type: DOCUMENT_TYPES.some(item => item.value === raw.type) ? raw.type : "other",
    year: Number.isFinite(year) && year > 1900 && year < 2200 ? year : null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(raw.date || "")) ? raw.date : null,
    author: String(raw.author || "").trim() || null,
    description: String(raw.description || "").trim() || null,
    file: SAFE_FILE.test(String(raw.file || "")) ? raw.file : null,
    url: /^https?:\/\//i.test(String(raw.url || "")) ? raw.url : null,
    language: String(raw.language || "it").trim().slice(0, 8) || "it",
    tags: normalizeList(raw.tags).map(tag => tag.toLowerCase()).slice(0, 20),
    source_file: fileName
  };
  if (!doc.file && !doc.url) return null;
  return doc;
}

function loadDocuments() {
  const documents = [];
  let files = [];
  try {
    files = fs.readdirSync(DOCUMENTS_DIR).filter(name => name.endsWith(".json"));
  } catch {
    return { documents, errors: [] };
  }
  const errors = [];
  for (const fileName of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DOCUMENTS_DIR, fileName), "utf8"));
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        const doc = normalizeDocument(item, fileName);
        if (doc) documents.push(doc);
        else errors.push(`${fileName}: skipped invalid entry`);
      }
    } catch (error) {
      errors.push(`${fileName}: ${error.message}`);
    }
  }
  documents.sort((a, b) => {
    const aKey = a.date || `${a.year || 0}`;
    const bKey = b.date || `${b.year || 0}`;
    if (aKey !== bKey) return String(bKey).localeCompare(String(aKey));
    return a.title.localeCompare(b.title, "it");
  });
  return { documents, errors };
}

function matchesQuery(doc, query) {
  if (!query) return true;
  const needle = query.toLocaleLowerCase("it");
  const haystack = [
    doc.title, doc.author, doc.description,
    ...doc.river_names, ...doc.tags
  ].filter(Boolean).join(" ").toLocaleLowerCase("it");
  return haystack.includes(needle);
}

export function filterDocuments({ query, type, region, river, riverName, year } = {}) {
  const { documents, errors } = loadDocuments();
  const riverKey = river ? normalizeId(river) : null;
  const riverNameKey = riverName ? normalizeId(riverName) : null;
  const filtered = documents.filter(doc => {
    if (!matchesQuery(doc, query)) return false;
    if (type && doc.type !== type) return false;
    if (region && !doc.region_codes.includes(region.toUpperCase())) return false;
    if (riverKey || riverNameKey) {
      const matches = doc.river_ids.some(id => normalizeId(id) === riverKey) ||
        doc.river_names.some(name => {
          const key = normalizeId(name);
          return key === riverKey || (riverNameKey && key === riverNameKey);
        });
      if (!matches) return false;
    }
    if (year) {
      const yearNumber = Number(year);
      if (!Number.isFinite(yearNumber)) return false;
      const docYear = doc.year || (doc.date ? Number(doc.date.slice(0, 4)) : null);
      if (docYear !== yearNumber) return false;
    }
    return true;
  });
  return { documents: filtered, errors };
}

export function getDocument(id) {
  const { documents } = loadDocuments();
  return documents.find(doc => doc.id === normalizeId(id)) || null;
}

export function resolveDocumentFile(doc) {
  if (!doc?.file) return null;
  const filePath = path.resolve(FILES_DIR, doc.file);
  if (!filePath.startsWith(FILES_DIR + path.sep)) return null;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
  return filePath;
}

export function documentFacets() {
  const { documents } = loadDocuments();
  const types = new Map();
  const regions = new Map();
  const years = new Set();
  const rivers = new Map();
  for (const doc of documents) {
    types.set(doc.type, (types.get(doc.type) || 0) + 1);
    for (const code of doc.region_codes) regions.set(code, (regions.get(code) || 0) + 1);
    const docYear = doc.year || (doc.date ? Number(doc.date.slice(0, 4)) : null);
    if (docYear) years.add(docYear);
    for (const name of doc.river_names) {
      const key = normalizeId(name);
      rivers.set(key, { name, count: (rivers.get(key)?.count || 0) + 1 });
    }
  }
  return {
    types: [...types.entries()].map(([value, count]) => ({
      value, label: DOCUMENT_TYPES.find(item => item.value === value)?.label || value, count
    })),
    regions: [...regions.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => a.code.localeCompare(b.code)),
    years: [...years].sort((a, b) => b - a),
    rivers: [...rivers.values()].sort((a, b) => a.name.localeCompare(b.name, "it"))
  };
}

export function logDocumentArchiveState() {
  const { documents, errors } = loadDocuments();
  log.info("DOCUMENTS", `River document archive: ${documents.length} documents, ${errors.length} load errors`);
  for (const error of errors.slice(0, 5)) log.warn("DOCUMENTS", error);
}
