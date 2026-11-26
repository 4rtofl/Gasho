// The worktrees this browser keeps in the sidebar once their sessions are gone, in localStorage, until each is taken
// off. A private window or blocked storage keeps them for this page view only.
import { useSyncExternalStore } from "react";
import { worktreeKey, type RememberedWorktree } from "./sessions.ts";

const KEY = "gasho.worktrees";
/** Kept at most: the oldest go first. */
const MAX = 100;
const listeners = new Set<() => void>();
let list: RememberedWorktree[] | undefined;

function valid(x: unknown): x is RememberedWorktree {
  const r = x as Partial<RememberedWorktree> | null;
  return (
    typeof r?.machine === "string" &&
    typeof r.path === "string" &&
    typeof r.label === "string" &&
    typeof r.subfolders === "boolean" &&
    (r.repo === undefined || typeof r.repo === "string") &&
    (r.branch === undefined || typeof r.branch === "string") &&
    (r.repoFolder === undefined || typeof r.repoFolder === "string") &&
    (r.github === undefined || (typeof r.github?.owner === "string" && typeof r.github.name === "string" && typeof r.github.url === "string"))
  );
}

function read(): RememberedWorktree[] {
  if (list) return list;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "[]") as unknown;
    list = Array.isArray(saved) ? saved.filter(valid) : [];
  } catch {
    list = [];
  }
  return list;
}

function write(next: RememberedWorktree[]): void {
  list = next.slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // kept for this page view only
  }
  for (const l of listeners) l();
}

const keyOf = (r: RememberedWorktree) => worktreeKey(r.machine, r.path);

/** Keeps these worktrees: new ones first; ones already kept are updated (a branch switched, say) where they are. */
export function rememberWorktrees(items: RememberedWorktree[]): void {
  const current = read();
  const updated = new Map(current.map((r) => [keyOf(r), r]));
  const added: RememberedWorktree[] = [];
  let changed = false;
  for (const r of items) {
    const old = updated.get(keyOf(r));
    if (!old) {
      if (!added.some((a) => keyOf(a) === keyOf(r))) added.push(r);
      changed = true;
    } else if (JSON.stringify(old) !== JSON.stringify(r)) {
      updated.set(keyOf(r), r);
      changed = true;
    }
  }
  if (changed) write([...added, ...current.map((r) => updated.get(keyOf(r)) ?? r)]);
}

/** Takes a worktree off the sidebar (it shows again while it has sessions). */
export function forgetWorktree(machine: string, path: string): void {
  write(read().filter((r) => !(r.machine === machine && r.path === path)));
}

export function useRememberedWorktrees(): RememberedWorktree[] {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    read,
  );
}

// The folders the worktrees were started from (lib/worktree-nesting, launchFolders), by the worktree's key: a child
// stays under its parent once its sessions, which tell the folder, are gone.
const PARENTS_KEY = "gasho.worktreeParents";
/** Kept at most: the oldest go first. */
const MAX_PARENTS = 300;
const NO_PARENTS: ReadonlyMap<string, string> = new Map();
let parents: ReadonlyMap<string, string> | undefined;

function readParents(): ReadonlyMap<string, string> {
  if (parents) return parents;
  try {
    const saved = JSON.parse(localStorage.getItem(PARENTS_KEY) ?? "[]") as unknown;
    parents = new Map(
      Array.isArray(saved)
        ? saved.filter((e): e is [string, string] => Array.isArray(e) && e.length === 2 && typeof e[0] === "string" && typeof e[1] === "string")
        : [],
    );
  } catch {
    parents = NO_PARENTS;
  }
  return parents;
}

/** Keeps these folders (by the worktree's key): new and changed ones last, so that the oldest go first. */
export function rememberParents(folders: ReadonlyMap<string, string>): void {
  const current = readParents();
  const changed = [...folders].filter(([k, cwd]) => current.get(k) !== cwd);
  if (changed.length === 0) return;
  const next = new Map(current);
  for (const [k, cwd] of changed) {
    next.delete(k);
    next.set(k, cwd);
  }
  parents = new Map([...next].slice(-MAX_PARENTS));
  try {
    localStorage.setItem(PARENTS_KEY, JSON.stringify([...parents]));
  } catch {
    // kept for this page view only
  }
  for (const l of listeners) l();
}

export function useRememberedParents(): ReadonlyMap<string, string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    readParents,
  );
}
