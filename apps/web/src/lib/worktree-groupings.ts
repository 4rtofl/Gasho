// The sidebar's worktrees in a plugin's categories (docs/plugins.md, P18): the groupings the plugins offer in the menu
// of the list (groupingOptions; checkWorktreeGroupings refuses a web part whose groupings are not right), what the
// picked one's hook gets (worktreeListContext), what of its answer is kept (normalizeWorktreeCategories), the order
// dragged into and what is held while the pointer is over the list (arrangeWorktreeCategories), and which list the
// sidebar shows (worktreeListMode). Unlike the session list of P17, a grouping only puts Gasho's rows of worktrees under
// headings: the rows, the tabs above a session and the rest stay as they are. Pure, so that it can be tested;
// plugins/worktree-groupings.tsx runs the hook, App draws the result.
import type { WorktreeListContext, WorktreeListWorktree } from "@gasho/plugin-sdk";
import type { MachineInfo } from "@gasho/protocol";
import { arrangeSessions } from "./order.ts";
import { isRecord, listWorktreeOf, MAX_CATEGORIES, MAX_HINT, MAX_ID, MAX_TITLE, OTHER_CATEGORY, text, type CategoryPrefs } from "./session-list.ts";
import { worktreeLastUsed, worktreeStatus, type WorktreeSessions } from "./sessions.ts";

/** The grouping picked in a browser: none ("分けない"), or one of a plugin. */
export type GroupingChoice = "none" | { plugin: string; grouping: string };

/** The key of a plugin's grouping: what the menu tells it by, and what its preferences are kept under. */
export const groupingKey = (plugin: string, grouping: string) => `${plugin}/${grouping}`;

/** A grouping's id is at most this long. */
const MAX_GROUPING_ID = 100;

/**
 * Why a web part's `worktreeGroupings` cannot be used (the registry refuses that version), or undefined when it can: an
 * array of groupings, each with an id (one the plugin has once), a label and a function `useCategories`.
 */
export function checkWorktreeGroupings(given: unknown): string | undefined {
  if (given === undefined) return undefined;
  if (!Array.isArray(given)) return "worktreeGroupings は配列にしてください。";
  const ids = new Set<string>();
  for (const g of given) {
    if (!isRecord(g) || typeof g.id !== "string" || !g.id || g.id.length > MAX_GROUPING_ID) {
      return `worktreeGroupings の項目に、${MAX_GROUPING_ID}文字までの id を書いてください。`;
    }
    if (ids.has(g.id)) return `worktreeGroupings の id「${g.id}」が2つあります。`;
    ids.add(g.id);
    if (!text(g.label, MAX_TITLE)) return `worktreeGroupings の「${g.id}」に、label を書いてください。`;
    if (typeof g.useCategories !== "function") return `worktreeGroupings の「${g.id}」に、関数 useCategories を書いてください。`;
  }
  return undefined;
}

/** A grouping offered in the menu. */
export interface GroupingOption {
  /** groupingKey */
  key: string;
  plugin: string;
  pluginName: string;
  grouping: string;
  label: string;
  /** Another grouping offered has the same label: the menu tells the plugin's name too. */
  ambiguous: boolean;
}

/** The groupings of the loaded web parts, in the plugins' order and then in the order each plugin gives them. */
export function groupingOptions(parts: readonly { id: string; name: string; groupings: readonly { id: string; label: string }[] }[]): GroupingOption[] {
  const all = parts.flatMap((p) =>
    p.groupings.map((g) => ({ key: groupingKey(p.id, g.id), plugin: p.id, pluginName: p.name, grouping: g.id, label: text(g.label, MAX_TITLE) ?? g.id })),
  );
  return all.map((o) => ({ ...o, ambiguous: all.some((x) => x !== o && x.label === o.label) }));
}

/** The grouping to use: the one picked, or while none was ever picked here, the first offered (which is then kept). */
export function effectiveChoice(picked: GroupingChoice | undefined, options: readonly GroupingOption[]): GroupingChoice | undefined {
  if (picked !== undefined) return picked;
  const first = options[0];
  return first && { plugin: first.plugin, grouping: first.grouping };
}

/**
 * What the picked grouping's hook gets: the worktrees the sidebar lists (as worktreesByLastUse gives them, with those
 * this browser keeps once their sessions are gone, narrowed to the repositories picked), with their rows' state.
 */
export function worktreeListContext(worktrees: readonly WorktreeSessions[], machines: MachineInfo[]): WorktreeListContext {
  return {
    machines,
    worktrees: worktrees.map((w): WorktreeListWorktree => {
      const lastUsed = worktreeLastUsed(w);
      return { ...listWorktreeOf(w), status: worktreeStatus(w), ...(lastUsed !== undefined ? { lastUsed } : {}) };
    }),
  };
}

/** What of the hook's answer is kept, plain data (compared as JSON, kept in a store). */
export interface ListedWorktreeCategory {
  id: string;
  title: string;
  description?: string;
  hint?: string;
  /** The key of a worktree of the context. */
  launch?: string;
  worktrees: ListedWorktree[];
}

export interface ListedWorktree {
  /** The key of a worktree of the context (WorktreeSessions.id). */
  key: string;
  /** The line under its name: absent, Gasho's own; "", none. */
  description?: string;
}

/**
 * The categories the hook gave, checked as P17's are (lib/session-list): a category without an id or a title, with an
 * id used before, or past the first MAX_CATEGORIES is left out; so is a worktree that is not in the context, or that a
 * category before already has (its first place counts), and a `launch` that names no worktree of the context. A
 * worktree's description that is a string with nothing in it asks for no line. The worktrees left out of every category
 * go in one more at the end (OTHER_CATEGORY), in the context's order.
 */
export function normalizeWorktreeCategories(given: unknown, ctx: WorktreeListContext): ListedWorktreeCategory[] {
  const known = new Set(ctx.worktrees.map((w) => w.key));
  const placed = new Set<string>();
  const ids = new Set<string>([OTHER_CATEGORY]);
  const out: ListedWorktreeCategory[] = [];
  for (const c of Array.isArray(given) ? given : []) {
    if (out.length >= MAX_CATEGORIES) break;
    if (!isRecord(c)) continue;
    const id = typeof c.id === "string" && c.id.length <= MAX_ID ? c.id : undefined;
    const title = text(c.title, MAX_TITLE);
    if (!id || !title || ids.has(id)) continue;
    ids.add(id);
    const worktrees: ListedWorktree[] = [];
    for (const w of Array.isArray(c.worktrees) ? c.worktrees : []) {
      if (!isRecord(w) || typeof w.key !== "string" || !known.has(w.key) || placed.has(w.key)) continue;
      placed.add(w.key);
      const description = typeof w.description === "string" ? (text(w.description, MAX_TITLE) ?? "") : undefined;
      worktrees.push({ key: w.key, ...(description !== undefined ? { description } : {}) });
    }
    const description = text(c.description, MAX_TITLE);
    const hint = text(c.hint, MAX_HINT);
    const launch = typeof c.launch === "string" && known.has(c.launch) ? c.launch : undefined;
    out.push({ id, title, ...(description ? { description } : {}), ...(hint ? { hint } : {}), ...(launch ? { launch } : {}), worktrees });
  }
  const rest = ctx.worktrees.filter((w) => !placed.has(w.key));
  if (rest.length > 0) out.push({ id: OTHER_CATEGORY, title: "その他", worktrees: rest.map((w) => ({ key: w.key })) });
  return out;
}

/**
 * The list as it showed when the pointer came over it (on a phone, when the drawer opened), held while it stays there:
 * a worktree's state, and with it the category it belongs in, may change meanwhile. Only for the grouping `grouping`.
 */
export interface HeldWorktreeList {
  grouping: string;
  categories: ListedWorktreeCategory[];
}

export function holdWorktreeList(grouping: string, shown: readonly ListedWorktreeCategory[]): HeldWorktreeList {
  return { grouping, categories: [...shown] };
}

/**
 * The categories and their worktrees as the list shows them: the hook's (in its default order), or while `held`, each
 * worktree in the category it showed in and the categories in the order they showed; then the order dragged into over
 * it. What is not in a saved or held order (it came since) comes first.
 */
export function arrangeWorktreeCategories(
  categories: readonly ListedWorktreeCategory[],
  prefs: CategoryPrefs,
  held?: HeldWorktreeList | null,
): ListedWorktreeCategory[] {
  const shown = held ? keepHeld(categories, held.categories) : categories;
  const byId = new Map(shown.map((c) => [c.id, c]));
  return arrangeSessions(
    shown.map((c) => c.id),
    prefs.categories,
  ).flatMap((id) => {
    const c = byId.get(id);
    if (!c) return [];
    const byKey = new Map(c.worktrees.map((w) => [w.key, w]));
    const keys = arrangeSessions(
      c.worktrees.map((w) => w.key),
      prefs.sessions?.[id],
    );
    return [{ ...c, worktrees: keys.flatMap((k) => byKey.get(k) ?? []) }];
  });
}

/**
 * The hook's categories `now`, with every worktree that showed in `held` kept in the category it showed in, in the order
 * it showed. A worktree that came since goes first in the category the hook put it in; a category that came since shows
 * (first) once such a worktree is in it. A held category shows while a worktree shows in it; one that showed with none
 * (a heading alone), while the hook still gives it. The headings and the worktrees' lines are the hook's now, where it
 * still has them.
 */
function keepHeld(now: readonly ListedWorktreeCategory[], held: readonly ListedWorktreeCategory[]): ListedWorktreeCategory[] {
  const current = new Map<string, ListedWorktree>();
  for (const c of now) for (const w of c.worktrees) current.set(w.key, w);
  const wasShown = new Set(held.flatMap((c) => c.worktrees.map((w) => w.key)));
  const came = new Map(now.map((c) => [c.id, c.worktrees.filter((w) => !wasShown.has(w.key))]));
  const heldIds = new Set(held.map((c) => c.id));
  const nowById = new Map(now.map((c) => [c.id, c]));
  const out: ListedWorktreeCategory[] = [];
  for (const c of now) {
    const fresh = came.get(c.id) ?? [];
    if (!heldIds.has(c.id) && fresh.length > 0) out.push({ ...c, worktrees: fresh });
  }
  for (const h of held) {
    const c = nowById.get(h.id);
    const kept = h.worktrees.flatMap((w) => {
      const w2 = current.get(w.key);
      return w2 ? [w2] : [];
    });
    const worktrees = [...(came.get(h.id) ?? []), ...kept];
    if (worktrees.length === 0 && (h.worktrees.length > 0 || !c)) continue;
    out.push({ ...(c ?? h), worktrees });
  }
  return out;
}

/** What the probe of the picked grouping's hook last published (plugins/worktree-groupings.tsx). */
export type PublishedGrouping =
  | { plugin: string; version: string; grouping: string; categories: ListedWorktreeCategory[]; json: string }
  | { plugin: string; version: string; grouping: string; failed: true };

/** What the plugins are, as the registry has them, for worktreeListMode. */
export interface GroupingPlugins {
  /** Whether the Gasho server's list of plugins came (the snapshot); before it, nothing is known. */
  known: boolean;
  /** The installed plugins. */
  infos: readonly { id: string; enabled: boolean; hash?: string; web?: unknown; name: string }[];
  /** The loaded web parts, in the plugins' order: their version, and the ids of their groupings. */
  parts: readonly { id: string; version: string; name: string; groupings: readonly string[] }[];
  /** Why a plugin's web part could not be loaded. */
  errors: Readonly<Record<string, string>>;
}

/**
 * Which list of worktrees the sidebar shows for the grouping `choice` (effectiveChoice): Gasho's own (`flat`, with the
 * name of the plugin whose grouping failed), the grouping's categories (`grouped`), or nothing yet while waiting for
 * them (`pending`): the grouping's plugin is loading, or the hook has not answered yet. The flat list shows when nothing
 * is picked, or when the plugin is disabled, removed, could not be loaded, or its version has no such grouping.
 */
export type WorktreeListMode =
  | { kind: "flat"; failed?: string }
  | { kind: "pending"; plugin: string; grouping: string }
  | { kind: "grouped"; plugin: string; grouping: string; categories: ListedWorktreeCategory[] };

export function worktreeListMode(choice: GroupingChoice | undefined, plugins: GroupingPlugins, published: PublishedGrouping | undefined): WorktreeListMode {
  if (choice === undefined || choice === "none") return { kind: "flat" };
  const { plugin, grouping } = choice;
  const part = plugins.parts.find((p) => p.id === plugin);
  if (part) {
    if (!part.groupings.includes(grouping)) return { kind: "flat" };
    if (published?.plugin === plugin && published.version === part.version && published.grouping === grouping) {
      if ("failed" in published) return { kind: "flat", failed: part.name };
      return { kind: "grouped", plugin, grouping, categories: published.categories };
    }
    return { kind: "pending", plugin, grouping };
  }
  if (!plugins.known) return { kind: "pending", plugin, grouping };
  const info = plugins.infos.find((i) => i.id === plugin);
  // Enabled, with a web part, not loaded yet and not failed to load: it is loading (the registry gives up after 15 s).
  if (info?.enabled && info.web && info.hash && !plugins.errors[info.id]) return { kind: "pending", plugin, grouping };
  return { kind: "flat" };
}
