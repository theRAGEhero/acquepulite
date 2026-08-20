import fs from "node:fs";
import path from "node:path";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
const LEVEL_NAMES = { 10: "DEBUG", 20: "INFO", 30: "WARN", 40: "ERROR", 50: "FATAL" };
const COLORS = {
  DEBUG: "\x1b[37m", INFO: "\x1b[36m", WARN: "\x1b[33m",
  ERROR: "\x1b[31m", FATAL: "\x1b[35m"
};
const RESET = "\x1b[0m";
const SECRET_KEY = /authorization|cookie|password|passwd|secret|token|api[_-]?key|session/i;
const MAX_STRING = 4000;
const MAX_RECENT = 250;

let currentLevel = LEVELS[String(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;
const jsonConsole = String(process.env.LOG_FORMAT || "pretty").toLowerCase() === "json";
const fileEnabled = String(process.env.LOG_TO_FILE || "true").toLowerCase() !== "false";
const logDirectory = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.join(import.meta.dirname, "logs");
const retentionDays = Math.max(1, Math.min(90, Number(process.env.LOG_RETENTION_DAYS) || 14));
const recent = [];
let fileFailureReported = false;
let fileLoggingInitialized = false;

export function sanitizeMeta(value, key = "", depth = 0, seen = new WeakSet()) {
  if (SECRET_KEY.test(key)) return "[REDACTED]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    const redacted = value
      .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
      .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[REDACTED]");
    return redacted.length > MAX_STRING ? `${redacted.slice(0, MAX_STRING)}…[truncated]` : redacted;
  }
  if (value instanceof Error) return serializeError(value, depth < 2);
  if (typeof value !== "object") return String(value);
  if (depth >= 5) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    const output = value.slice(0, 50).map(item => sanitizeMeta(item, key, depth + 1, seen));
    if (value.length > 50) output.push(`[${value.length - 50} more items]`);
    return output;
  }
  const output = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 80)) {
    output[childKey] = sanitizeMeta(childValue, childKey, depth + 1, seen);
  }
  return output;
}

export function serializeError(error, includeStack = true) {
  if (!(error instanceof Error)) return { message: sanitizeMeta(String(error)) };
  const output = {
    name: error.name || "Error",
    message: sanitizeMeta(error.message || String(error))
  };
  if (error.code != null) output.code = sanitizeMeta(error.code, "code");
  if (error.cause != null) output.cause = sanitizeMeta(error.cause, "cause", 1);
  if (includeStack && error.stack) output.stack = sanitizeMeta(error.stack, "stack");
  return output;
}

function writeFile(record) {
  if (!fileEnabled) return;
  try {
    if (!fileLoggingInitialized) {
      fs.mkdirSync(logDirectory, { recursive: true });
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(logDirectory)) {
        if (!/^acquepulite-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
        const target = path.join(logDirectory, name);
        if (fs.statSync(target).mtimeMs < cutoff) fs.unlinkSync(target);
      }
      fileLoggingInitialized = true;
    }
    const day = record.timestamp.slice(0, 10);
    fs.appendFileSync(path.join(logDirectory, `acquepulite-${day}.jsonl`), `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    if (fileFailureReported) return;
    fileFailureReported = true;
    process.stderr.write(`[LOGGER] File logging unavailable: ${error.message}\n`);
  }
}

function writeConsole(record) {
  if (jsonConsole) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return;
  }
  const name = record.level.toUpperCase();
  const color = COLORS[name] || "";
  const localTimestamp = record.timestamp.replace("T", " ").slice(0, 23);
  const meta = record.meta && Object.keys(record.meta).length ? ` ${JSON.stringify(record.meta)}` : "";
  process.stdout.write(`${color}[${localTimestamp}] ${name.padEnd(5)} ${RESET}${record.category.padEnd(14)} ${record.message}${meta}\n`);
}

function emit(level, category, message, extra) {
  if (level < currentLevel) return null;
  const record = {
    timestamp: new Date().toISOString(),
    level: LEVEL_NAMES[level].toLowerCase(),
    category: String(category || "APP").slice(0, 40),
    message: sanitizeMeta(String(message || "")),
    service: "acquepulite-api",
    pid: process.pid
  };
  if (extra != null) {
    const sanitized = sanitizeMeta(extra);
    record.meta = sanitized && typeof sanitized === "object" ? sanitized : { detail: sanitized };
  }
  recent.push(record);
  if (recent.length > MAX_RECENT) recent.shift();
  writeConsole(record);
  writeFile(record);
  return record;
}

function scoped(baseMeta = {}) {
  const withBase = extra => ({ ...baseMeta, ...(extra && typeof extra === "object" ? extra : { detail: extra }) });
  return {
    debug: (category, message, extra) => emit(LEVELS.debug, category, message, withBase(extra)),
    info: (category, message, extra) => emit(LEVELS.info, category, message, withBase(extra)),
    warn: (category, message, extra) => emit(LEVELS.warn, category, message, withBase(extra)),
    error: (category, message, extra) => emit(LEVELS.error, category, message, withBase(extra)),
    fatal: (category, message, extra) => emit(LEVELS.fatal, category, message, withBase(extra))
  };
}

export function getRecentLogs({ minimumLevel = "warn", limit = 50 } = {}) {
  const threshold = LEVELS[minimumLevel] ?? LEVELS.warn;
  return recent.filter(record => LEVELS[record.level] >= threshold).slice(-Math.max(1, Math.min(100, limit)));
}

export function getLogStatus() {
  return {
    level: LEVEL_NAMES[currentLevel].toLowerCase(),
    format: jsonConsole ? "json" : "pretty",
    file_enabled: fileEnabled,
    directory: fileEnabled ? logDirectory : null,
    retention_days: fileEnabled ? retentionDays : null,
    buffered_records: recent.length
  };
}

export const log = {
  debug: (category, message, extra) => emit(LEVELS.debug, category, message, extra),
  info: (category, message, extra) => emit(LEVELS.info, category, message, extra),
  warn: (category, message, extra) => emit(LEVELS.warn, category, message, extra),
  error: (category, message, extra) => emit(LEVELS.error, category, message, extra),
  fatal: (category, message, extra) => emit(LEVELS.fatal, category, message, extra),
  child: scoped,
  setLevel: level => { if (LEVELS[level] != null) currentLevel = LEVELS[level]; },
  levels: LEVELS
};
