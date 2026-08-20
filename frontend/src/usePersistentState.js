import { useState, useEffect } from "react";

// usePersistentState — like useState but synced to localStorage.
// Key is namespaced under "rivermap:" to avoid collisions.
export function usePersistentState(key, defaultValue) {
  const fullKey = `rivermap:${key}`;
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(fullKey);
      if (stored != null) return JSON.parse(stored);
    } catch (e) { /* ignore parse errors */ }
    return defaultValue;
  });

  useEffect(() => {
    try {
      localStorage.setItem(fullKey, JSON.stringify(value));
    } catch (e) { /* ignore quota errors */ }
  }, [fullKey, value]);

  return [value, setValue];
}