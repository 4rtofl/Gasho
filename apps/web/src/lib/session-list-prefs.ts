// What this browser keeps of the sidebar's lists in categories. Of the session list of a plugin (P17): the orders the
// person dragged the categories and their sessions into, and the folded categories (lib/session-list), one localStorage
// key per plugin; and which plugin's list was shown last, so that the next page waits for it rather than showing the
// worktrees first. Of the groupings of the worktrees (P18, lib/worktree-groupings): the one picked, and the same orders
// and folding, one key per grouping. Of the worktrees nested under those they were started from (lib/worktree-nesting):
// whether to nest them, and the parents folded. A private window or blocked storage keeps them for this page view only, as
// lib/order does.
import { useCallback, useSyncExternalStore } from "react";
import type { CategoryPrefs, RememberedList } from "./session-list.ts";
import type { GroupingChoice } from "./worktree-groupings.ts";

const PREFS_PREFIX = "gasho.sessionList.";
const REMEMBERED_KEY = "gasho.sessionList";
const GROUPING_KEY = "gasho.worktreeGrouping";
const GROUPING_PREFS_PREFIX = "gasho.worktreeGrouping.";

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
function checkPrefs(v: unknown): CategoryPrefs {
  if (!isRecord(v)) return {};
  const sessions = isRecord(v.sessions) ? Object.fromEntries(Object.entries(v.sessions).filter((e): e is [string, string[]] => strings(e[1]))) : undefined;
  return {
    ...(strings(v.categories) ? { categories: v.categories } : {}),
    ...(sessions && Object.keys(sessions).length > 0 ? { sessions } : {}),
    ...(strings(v.folded) ? { folded: v.folded } : {}),
  };
}

const EMPTY: CategoryPrefs = {};

/** The preferences saved under a key: what was saved, or none (also once they were all taken back). */
const prefsOf = (key: string | undefined): CategoryPrefs => (key ? ((read(key, checkPrefs) as CategoryPrefs | undefined) ?? EMPTY) : EMPTY);

type ChangePrefs = (change: (prefs: CategoryPrefs) => CategoryPrefs) => void;

/** The preferences saved under a key (none for no key), and a way to change them. */
function useCategoryPrefs(key: string | undefined): [CategoryPrefs, ChangePrefs] {
  const prefs = useSyncExternalStore(subscribe, () => prefsOf(key));
  const change = useCallback(
    (f: (prefs: CategoryPrefs) => CategoryPrefs) => {
      if (!key) return;
      const next = f(prefsOf(key));
      write(key, Object.keys(next).length > 0 ? next : undefined);
    },
    [key],
  );
  return [prefs, change];
}

/** A plugin's preferences of its session list (none for no plugin), and a way to change them. */
export function useSessionListPrefs(plugin: string | undefined): [CategoryPrefs, ChangePrefs] {
  return useCategoryPrefs(plugin ? PREFS_PREFIX + plugin : undefined);
}

/** The preferences of a grouping of the worktrees (`<plugin>/<grouping>`; none for none), and a way to change them. */
export function useGroupingPrefs(grouping: string | undefined): [CategoryPrefs, ChangePrefs] {
  return useCategoryPrefs(grouping ? GROUPING_PREFS_PREFIX + grouping : undefined);
}

function checkChoice(v: unknown): GroupingChoice | undefined {
  if (v === "none") return v;
  return isRecord(v) && typeof v.plugin === "string" && typeof v.grouping === "string" ? { plugin: v.plugin, grouping: v.grouping } : undefined;
}

/** The grouping of the worktrees picked in this browser: "none" (分けない), a plugin's, or undefined when none was ever picked. */
export function useGroupingChoice(): GroupingChoice | undefined {
  return useSyncExternalStore(subscribe, () => read(GROUPING_KEY, checkChoice) as GroupingChoice | undefined);
}

export function chooseGrouping(choice: GroupingChoice): void {
  const now = read(GROUPING_KEY, checkChoice) as GroupingChoice | undefined;
  if (now === choice || (typeof now === "object" && typeof choice === "object" && now.plugin === choice.plugin && now.grouping === choice.grouping)) return;
  write(GROUPING_KEY, choice);
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

/** Whether the worktrees are nested under those they were started from (lib/worktree-nesting), and the parents folded. */
const NESTING_KEY = "gasho.worktreeNesting";
/** Folded parents kept at most: the oldest go first. */
const MAX_FOLDED_PARENTS = 200;

export interface NestingPrefs {
  /** Nest them: on unless turned off here. */
  on: boolean;
  /** The keys of the parents folded. */
  folded: string[];
}

const NESTING_DEFAULT: NestingPrefs = { on: true, folded: [] };

function checkNesting(v: unknown): NestingPrefs {
  if (!isRecord(v)) return NESTING_DEFAULT;
  return { on: v.on !== false, folded: strings(v.folded) ? v.folded : [] };
}

const nestingNow = () => (read(NESTING_KEY, checkNesting) as NestingPrefs | undefined) ?? NESTING_DEFAULT;

/** Whether this browser nests the sidebar's worktrees, and which parents it folded. */
export function useNestingPrefs(): NestingPrefs {
  return useSyncExternalStore(subscribe, nestingNow);
}

export function setNesting(on: boolean): void {
  const now = nestingNow();
  if (now.on !== on) write(NESTING_KEY, { ...now, on });
}

export function foldParent(key: string, folded: boolean): void {
  const now = nestingNow();
  const rest = now.folded.filter((k) => k !== key);
  write(NESTING_KEY, { ...now, folded: folded ? [...rest, key].slice(-MAX_FOLDED_PARENTS) : rest });
}
