// Which sections of the settings screen are open in this browser; all are folded at first. Kept in localStorage by
// their keys, so a phone and a computer each keep their own; a private window or blocked storage keeps them for this
// page view only.
import { useCallback, useSyncExternalStore } from "react";

const KEY = "gasho.settingsOpen";

const listeners = new Set<() => void>();
let open: ReadonlySet<string> = new Set();
/** What `open` was read from, so that storage changed elsewhere (another tab) is read again. */
let readFrom: string | null = null;

function parse(saved: string | null): ReadonlySet<string> {
  try {
    const keys: unknown = JSON.parse(saved ?? "[]");
    return new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function read(): ReadonlySet<string> {
  let saved: string | null;
  try {
    saved = localStorage.getItem(KEY);
  } catch {
    return open; // storage unavailable
  }
  if (saved !== readFrom) {
    readFrom = saved;
    open = parse(saved);
  }
  return open;
}

/** Opens or folds the section of `key`. */
export function setSettingsSectionOpen(key: string, value: boolean): void {
  const now = read();
  if (now.has(key) === value) return;
  const next = new Set(now);
  if (value) next.add(key);
  else next.delete(key);
  open = next;
  try {
    if (next.size === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify([...next]));
    readFrom = localStorage.getItem(KEY);
  } catch {
    // kept for this page view only
  }
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** Whether the section of `key` is open, and a way to open or fold it. */
export function useSettingsSectionOpen(key: string): [boolean, (open: boolean) => void] {
  const isOpen = useSyncExternalStore(subscribe, () => read().has(key));
  return [isOpen, useCallback((value: boolean) => setSettingsSectionOpen(key, value), [key])];
}
