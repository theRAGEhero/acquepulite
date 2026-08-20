import { useState, useEffect } from "react";
import { reportClientError } from "./telemetry.js";

// usePersistentState — like useState but synced to localStorage.
// Key is namespaced under "rivermap:" to avoid collisions.
export function usePersistentState(key, defaultValue) {
  const fullKey = `rivermap:${key}`;
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(fullKey);
      if (stored != null) return JSON.parse(stored);
    } catch (error) {
      reportClientError(error, { kind: "local-storage-read", severity: "warning" });
    }
    return defaultValue;
  });

  useEffect(() => {
    try {
      localStorage.setItem(fullKey, JSON.stringify(value));
    } catch (error) {
      reportClientError(error, { kind: "local-storage-write", severity: "warning" });
    }
  }, [fullKey, value]);

  return [value, setValue];
}
