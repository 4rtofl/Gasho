// What this browser keeps of the sidebar's session list of a plugin (P17): the orders the person dragged the
// categories and their sessions into, and the folded categories (lib/session-list), one localStorage key per plugin;
// and which plugin's list was shown last, so that the next page waits for it rather than showing the worktrees first.
// A private window or blocked storage keeps them for this page view only, as lib/order does.
import { useCallback, useSyncExternalStore } from "react";
import type { RememberedList, SessionListPrefs } from "./session-list.ts";

const PREFS_PREFIX = "gasho.sessionList.";
const REMEMBERED_KEY = "gasho.sessionList";

const listeners = new Set<() => void>();
const values = new Map<string, unknown>();

function read(key: string, check: (v: unknown) => unknown): unknown {
  if (values.has(key)) return values.get(key);
  let value: unknown;
  try {
    value = check(JSON.parse(localStorage.getItem(key) ?? "null"));
  } catch {
    // storage unavailable or unreadable: none
  }
  values.set(key, value);
  return value;
}

function write(key: string, value: unknown): void {
  values.set(key, value);
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // kept for this page view only
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What was saved, keeping only the parts of the right shape. */
function checkPrefs(v: unknown): SessionListPrefs {
  if (!isRecord(v)) return {};
  const sessions = isRecord(v.sessions) ? Object.fromEntries(Object.entries(v.sessions).filter((e): e is [string, string[]] => strings(e[1]))) : undefined;
  return {
    ...(strings(v.categories) ? { categories: v.categories } : {}),
    ...(sessions && Object.keys(sessions).length > 0 ? { sessions } : {}),
    ...(strings(v.folded) ? { folded: v.folded } : {}),
  };
}

const EMPTY: SessionListPrefs = {};

/** A plugin's preferences: what was saved, or none (also once they were all taken back). */
const prefsOf = (key: string | undefined): SessionListPrefs => (key ? ((read(key, checkPrefs) as SessionListPrefs | undefined) ?? EMPTY) : EMPTY);

/** A plugin's preferences (none for no plugin), and a way to change them. */
export function useSessionListPrefs(plugin: string | undefined): [SessionListPrefs, (change: (prefs: SessionListPrefs) => SessionListPrefs) => void] {
  const key = plugin ? PREFS_PREFIX + plugin : undefined;
  const prefs = useSyncExternalStore(subscribe, () => prefsOf(key));
  const change = useCallback(
    (f: (prefs: SessionListPrefs) => SessionListPrefs) => {
      if (!key) return;
      const next = f(prefsOf(key));
      write(key, Object.keys(next).length > 0 ? next : undefined);
    },
    [key],
  );
  return [prefs, change];
}

function checkRemembered(v: unknown): RememberedList | undefined {
  return isRecord(v) && typeof v.plugin === "string" && typeof v.hideTabs === "boolean" ? { plugin: v.plugin, hideTabs: v.hideTabs } : undefined;
}

/** The plugin whose list this browser showed last. */
export function useRememberedList(): RememberedList | undefined {
  return useSyncExternalStore(subscribe, () => read(REMEMBERED_KEY, checkRemembered) as RememberedList | undefined);
}

export function rememberList(list: RememberedList | undefined): void {
  const now = read(REMEMBERED_KEY, checkRemembered) as RememberedList | undefined;
  if (now?.plugin === list?.plugin && now?.hideTabs === list?.hideTabs) return;
  write(REMEMBERED_KEY, list);
}
