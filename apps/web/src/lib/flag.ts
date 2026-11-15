// Small choices of this browser (a folded list, the repositories the sidebar is narrowed to, and the like), kept in
// localStorage. A private window or blocked storage just uses the default.
import { useMemo, useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
/** What is saved under each key read so far (null: nothing). */
const values = new Map<string, string | null>();

function read(key: string): string | null {
  const known = values.get(key);
  if (known !== undefined) return known;
  let value: string | null = null;
  try {
    value = localStorage.getItem(key);
  } catch {
    // storage unavailable
  }
  values.set(key, value);
  return value;
}

function write(key: string, value: string | null): void {
  values.set(key, value);
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // keep it for this page view only
  }
  for (const l of listeners) l();
}

function useSaved(key: string): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => read(key),
  );
}

export function useFlag(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
  const saved = useSaved(key);
  return [saved === "1" ? true : saved === "0" ? false : fallback, (next) => write(key, next ? "1" : "0")];
}

/**
 * What is saved as several choices (ids): a JSON array. A value saved when only one could be chosen is that id alone,
 * and is read as choosing it.
 */
export function savedChoices(saved: string | null): string[] {
  if (saved === null) return [];
  try {
    const ids: unknown = JSON.parse(saved);
    if (Array.isArray(ids) && ids.every((id) => typeof id === "string")) return ids;
  } catch {
    // not JSON: one id
  }
  return [saved];
}

/** Several of a list of choices, such as ids (none: nothing chosen). */
export function useChoices(key: string): [string[], (values: string[]) => void] {
  const saved = useSaved(key);
  return [useMemo(() => savedChoices(saved), [saved]), (next) => write(key, next.length > 0 ? JSON.stringify(next) : null)];
}
