// The sidebar's worktrees nested under the worktree they were started from (#301): a session's Agent that set up a
// worktree and started a session in it (`gasho-daemon session launch`, #300) is that session's parent
// (SessionInfo.launchedBy), and the worktree its folder (`launchedBy.cwd`) is in is the parent of the new worktree.
// Grandchildren nest too. A worktree whose parent is not listed (gone, or narrowed out) shows where it would without
// nesting. Pure, so that it can be tested; App draws the result, and lib/session-list-prefs keeps whether to nest and
// which parents are folded, lib/remembered-worktrees the parents once a child's sessions are gone.
import type { WorktreeSessions } from "./sessions.ts";

/** Whether `path` is `folder` or inside it. */
const within = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);

/**
 * The folders the sessions of a worktree were started from (its sessions' `launchedBy.cwd`, the first one started first),
 * by the key of the worktree. Worktrees without such sessions are left out.
 */
export function launchFolders(worktrees: readonly WorktreeSessions[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const w of worktrees) {
    const cwd = w.sessions.find((s) => s.launchedBy?.cwd)?.launchedBy?.cwd;
    if (cwd) out.set(w.id, cwd);
  }
  return out;
}

/**
 * The worktree each worktree was started from, by key: the worktree of the same working server whose folder is `cwd`
 * of `folders` (launchFolders, and those this browser kept), or holds it (a git worktree, whose sessions may run in its
 * folders; the deepest one). A worktree is never its own parent, and a loop (which git cannot make, but which the
 * folders could tell once a folder is used again) is cut at one of its links.
 */
export function worktreeParents(worktrees: readonly WorktreeSessions[], folders: ReadonlyMap<string, string>): Map<string, string> {
  const parents = new Map<string, string>();
  for (const w of worktrees) {
    const cwd = folders.get(w.id);
    if (!cwd) continue;
    let best: WorktreeSessions | undefined;
    for (const x of worktrees) {
      if (x === w || x.machine.id !== w.machine.id) continue;
      if (x.path !== cwd && !(x.subfolders && within(cwd, x.path))) continue;
      if (!best || x.path.length > best.path.length) best = x;
    }
    if (best) parents.set(w.id, best.id);
  }
  for (const id of [...parents.keys()]) {
    const seen = new Set([id]);
    let at = parents.get(id);
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      at = parents.get(at);
    }
    if (at !== undefined) parents.delete(id);
  }
  return parents;
}

/** The worktrees of a list as a tree: those at its top, and each one's children, in the order of the list. */
export interface WorktreeTree {
  roots: string[];
  children: ReadonlyMap<string, string[]>;
}

/**
 * The keys `keys` (in the order they show) nested by `parents` (worktreeParents): a worktree whose parent is among them
 * goes under it, the rest stay at the top. Children keep the order of `keys` among themselves.
 */
export function nestWorktrees(keys: readonly string[], parents: ReadonlyMap<string, string>): WorktreeTree {
  const present = new Set(keys);
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const k of keys) {
    const p = parents.get(k);
    if (p !== undefined && present.has(p)) {
      const list = children.get(p);
      if (list) list.push(k);
      else children.set(p, [k]);
    } else roots.push(k);
  }
  return { roots, children };
}

/**
 * The categories of a grouping (docs/plugins.md, P18) nested: a child shows in its parent's category, under it, as
 * far as the parent is in one of them (else it stays in its own). `categories`: the keys of each category, in the
 * order they show. Gives the roots of each category, and the children of each worktree in the order of the categories.
 */
export function nestCategories(
  categories: readonly { id: string; keys: readonly string[] }[],
  parents: ReadonlyMap<string, string>,
): { roots: Map<string, string[]>; children: ReadonlyMap<string, string[]> } {
  const { children } = nestWorktrees(
    categories.flatMap((c) => c.keys),
    parents,
  );
  const nested = new Set([...children.values()].flat());
  return { roots: new Map(categories.map((c) => [c.id, c.keys.filter((k) => !nested.has(k))])), children };
}

/** The keys of a worktree's descendants, in the order they show (depth first). */
export function descendants(key: string, children: ReadonlyMap<string, readonly string[]>): string[] {
  return (children.get(key) ?? []).flatMap((c) => [c, ...descendants(c, children)]);
}

/** The children a folded parent (`key`) still shows under it: those on the way to `open`, if it is among them. */
export function shownWhileFolded(key: string, children: ReadonlyMap<string, readonly string[]>, open: string | undefined): string[] {
  return (children.get(key) ?? []).filter((c) => c === open || descendants(c, children).includes(open ?? "\u0000"));
}

