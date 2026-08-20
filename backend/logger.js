// Lightweight structured logger with levels, timestamps, and categories.
// Usage:
//   import { log } from "./logger.js";
//   log.info("ARPA", "Fetched 18 rivers");
//   log.warn("ARPA", "Failed, using mock", { error: e.message });
//   log.error("OVERPASS", "Request failed", { url, status });
//   log.debug("API", "GET /api/rivers", { duration_ms: 12 });

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_NAMES = { 10: "DEBUG", 20: "INFO", 30: "WARN", 40: "ERROR" };

let currentLevel = LEVELS.info;

// Allow level override via env
if (process.env.LOG_LEVEL) {
  const env = process.env.LOG_LEVEL.toLowerCase();
  if (LEVELS[env] != null) currentLevel = LEVELS[env];
}

const COLORS = {
  DEBUG: "\x1b[37m",
  INFO:  "\x1b[36m",
  WARN:  "\x1b[33m",
  ERROR: "\x1b[31m",
};
const RESET = "\x1b[0m";

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function emit(level, category, msg, extra) {
  if (level < currentLevel) return;
  const name = LEVEL_NAMES[level];
  const color = COLORS[name] || "";
  const line = `${color}[${ts()}] ${name.padEnd(5)} ${RESET}${(category || "").padEnd(10)} ${msg}`;
  if (extra != null) {
    const extraStr = typeof extra === "string" ? extra : JSON.stringify(extra);
    console.log(`${line} ${color}${extraStr}${RESET}`);
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (cat, msg, extra) => emit(LEVELS.debug, cat, msg, extra),
  info:  (cat, msg, extra) => emit(LEVELS.info, cat, msg, extra),
  warn:  (cat, msg, extra) => emit(LEVELS.warn, cat, msg, extra),
  error: (cat, msg, extra) => emit(LEVELS.error, cat, msg, extra),
  setLevel: (lvl) => { if (LEVELS[lvl] != null) currentLevel = LEVELS[lvl]; },
  levels: LEVELS
};