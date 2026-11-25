// The conversations open outside Gasho that were open in a worktree when the banner above its tabs was closed (see
// outside-sessions), by worktree: while only they are open, the banner stays closed. Kept in this browser's
// localStorage; a private window or blocked storage keeps them for this page view only.
import { useCallback, useSyncExternalStore } from "react";

const KEY = "gasho.outsideSessions.dismissed";
/** Worktrees kept at most: the one closed longest ago goes first. */
const MAX = 100;

interface Dismissed {
  /** See worktreeId. */
  worktree: string;
  sessions: string[];
}

const listeners = new Set<() => void>();
let list: Dismissed[] | undefined;

const valid = (x: unknown): x is Dismissed => {
  const d = x as Partial<Dismissed> | null;
  return typeof d?.worktree === "string" && Array.isArray(d.sessions) && d.sessions.every((id) => typeof id === "string");
};

function read(): Dismissed[] {
  if (list) return list;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    list = Array.isArray(saved) ? saved.filter(valid) : [];
  } catch {
    list = [];
  }
  return list;
}

const NONE: string[] = [];

/** The conversations open when the banner of this worktree was last closed (none: it was not). */
export function dismissedOutside(worktree: string): string[] {
  return read().find((d) => d.worktree === worktree)?.sessions ?? NONE;
}

export function dismissOutside(worktree: string, sessions: string[]): void {
  list = [{ worktree, sessions }, ...read().filter((d) => d.worktree !== worktree)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // kept for this page view only
  }
  for (const l of listeners) l();
}

/** dismissedOutside of this worktree, and a way to close its banner over the conversations open now. */
export function useDismissedOutside(worktree: string): [string[], (sessions: string[]) => void] {
  const sessions = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => dismissedOutside(worktree),
  );
  return [sessions, useCallback((ids: string[]) => dismissOutside(worktree, ids), [worktree])];
}
