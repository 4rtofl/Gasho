// The sidebar's sessions in a plugin's categories, in place of the list of worktrees (docs/plugins.md, P17): what the
// plugin gets (sessionListContext), what of its answer is kept (normalizeCategories), the order the person dragged
// things into put over the plugin's (arrangeCategories), and which list the sidebar shows meanwhile (sessionListMode).
// Pure, so that it can be tested; plugins/session-list.tsx runs the plugin's hook, App draws the result.
import type { SessionListContext, SessionListSession, SessionListWorktree } from "@gasho/plugin-sdk";
import type { MachineInfo } from "@gasho/protocol";
import { arrangeSessions, rememberSessions } from "./order.ts";
import { lastUsed, type WorktreeSessions } from "./sessions.ts";

/** A row's id: its working server and session, as the sidebar's session list of before named it. */
export const sessionKey = (machine: string, sessionId: string) => `${machine}\u001f${sessionId}`;

/** The category Gasho adds for the sessions the plugin put in none, so that every session can be reached. */
export const OTHER_CATEGORY = "\u001fother";

/** What of the plugin's answer is kept, plain data (compared as JSON, kept in a store). */
export interface ListedCategory {
  id: string;
  title: string;
  description?: string;
  hint?: string;
  /** The key of a worktree of the context. */
  launch?: string;
  sessions: ListedSession[];
}

export interface ListedSession {
  /** sessionKey */
  key: string;
  machine: string;
  sessionId: string;
  description?: string;
}

/** What a plugin gets: Gasho's worktrees (as worktreesByLastUse gives them, without those only this browser keeps). */
export function sessionListContext(worktrees: readonly WorktreeSessions[], machines: MachineInfo[]): SessionListContext {
  const listed: SessionListWorktree[] = worktrees.map((w) => ({
    key: w.id,
    machine: w.machine,
    path: w.path,
    ...(w.branch ? { branch: w.branch } : {}),
    ...(w.repoFolder ? { repo: w.repoFolder } : {}),
    ...(w.github ? { github: w.github } : {}),
    sessions: w.sessions,
    ...(w.repo ? { repoName: w.repo } : {}),
    registered: w.registered,
  }));
  const sessions: SessionListSession[] = worktrees
    .flatMap((w) => w.sessions.map((session) => ({ machine: w.machine, session, worktree: w.id, lastUsed: lastUsed(session) })))
    .sort((a, b) => b.lastUsed - a.lastUsed || sessionKey(a.machine.id, a.session.sessionId).localeCompare(sessionKey(b.machine.id, b.session.sessionId)));
  return { machines, sessions, worktrees: listed };
}

/** At most this many categories are kept; a category's id, title and descriptions at most this long. */
const MAX_CATEGORIES = 200;
const MAX_ID = 500;
const MAX_TITLE = 80;
const MAX_HINT = 300;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** A string of one line, clipped; undefined when there is none. */
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const line = v.replace(/[\p{Cc}\s]+/gu, " ").trim();
  return line ? Array.from(line).slice(0, max).join("") : undefined;
}

/**
 * The categories the plugin gave, checked: a category without an id or a title, with an id used before, or past the
 * first MAX_CATEGORIES is left out; so is a session that is not in the context, or that a category before already has
 * (its first place counts), and a `launch` that names no worktree of the context. The sessions left out of every category
 * go in one more at the end (OTHER_CATEGORY), the one used last first.
 */
export function normalizeCategories(given: unknown, ctx: SessionListContext): ListedCategory[] {
  const known = new Map(ctx.sessions.map((s) => [sessionKey(s.machine.id, s.session.sessionId), s]));
  const worktrees = new Set(ctx.worktrees.map((w) => w.key));
  const placed = new Set<string>();
  const ids = new Set<string>([OTHER_CATEGORY]);
  const out: ListedCategory[] = [];
  for (const c of Array.isArray(given) ? given : []) {
    if (out.length >= MAX_CATEGORIES) break;
    if (!isRecord(c)) continue;
    const id = typeof c.id === "string" && c.id.length <= MAX_ID ? c.id : undefined;
    const title = text(c.title, MAX_TITLE);
    if (!id || !title || ids.has(id)) continue;
    ids.add(id);
    const sessions: ListedSession[] = [];
    for (const s of Array.isArray(c.sessions) ? c.sessions : []) {
      if (!isRecord(s) || typeof s.machine !== "string" || typeof s.sessionId !== "string") continue;
      const key = sessionKey(s.machine, s.sessionId);
      if (!known.has(key) || placed.has(key)) continue;
      placed.add(key);
      const description = text(s.description, MAX_TITLE);
      sessions.push({ key, machine: s.machine, sessionId: s.sessionId, ...(description ? { description } : {}) });
    }
    const description = text(c.description, MAX_TITLE);
    const hint = text(c.hint, MAX_HINT);
    const launch = typeof c.launch === "string" && worktrees.has(c.launch) ? c.launch : undefined;
    out.push({ id, title, ...(description ? { description } : {}), ...(hint ? { hint } : {}), ...(launch ? { launch } : {}), sessions });
  }
  const rest = ctx.sessions.filter((s) => !placed.has(sessionKey(s.machine.id, s.session.sessionId)));
  if (rest.length > 0) {
    out.push({
      id: OTHER_CATEGORY,
      title: "その他",
      sessions: rest.map((s) => ({ key: sessionKey(s.machine.id, s.session.sessionId), machine: s.machine.id, sessionId: s.session.sessionId })),
    });
  }
  return out;
}

/** What this browser keeps of the plugin's list: the orders the person dragged things into, and the folded categories. */
export interface SessionListPrefs {
  /** Category ids, in the order dragged into. */
  categories?: string[];
  /** Per category id: its session keys, in the order dragged into. */
  sessions?: Record<string, string[]>;
  folded?: string[];
}

/** An order to keep for a while, as the list showed it (while the pointer is over it): category ids, and session keys per category. */
export interface HeldOrder {
  categories: string[];
  sessions: Record<string, string[]>;
}

/**
 * The categories and their sessions in the order to show: the plugin's (its default, by last use), or the order `held`
 * kept, then the order dragged into over it. What is not in a saved or held order (started or forked since) comes first.
 */
export function arrangeCategories(categories: readonly ListedCategory[], prefs: SessionListPrefs, held?: HeldOrder | null): ListedCategory[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  let ids = categories.map((c) => c.id);
  if (held) ids = arrangeSessions(ids, held.categories);
  ids = arrangeSessions(ids, prefs.categories);
  return ids.flatMap((id) => {
    const c = byId.get(id);
    if (!c) return [];
    const byKey = new Map(c.sessions.map((s) => [s.key, s]));
    let keys = c.sessions.map((s) => s.key);
    if (held) keys = arrangeSessions(keys, held.sessions[id]);
    keys = arrangeSessions(keys, prefs.sessions?.[id]);
    return [{ ...c, sessions: keys.flatMap((k) => byKey.get(k) ?? []) }];
  });
}

/** The order the list shows now, to hold while the pointer is over it. */
export function holdOrder(shown: readonly ListedCategory[]): HeldOrder {
  return { categories: shown.map((c) => c.id), sessions: Object.fromEntries(shown.map((c) => [c.id, c.sessions.map((s) => s.key)])) };
}

/** Saved orders of the sessions of at most this many categories (those of categories gone are dropped first). */
const MAX_SAVED_CATEGORIES = 100;

/** The preferences once the categories were dragged into the order `ids` (all of them are shown). */
export function withCategoryOrder(prefs: SessionListPrefs, ids: readonly string[]): SessionListPrefs {
  return { ...prefs, categories: rememberSessions(ids, prefs.categories) };
}

/** The preferences once the sessions of a category were dragged into the order `keys`. `current`: the categories now. */
export function withSessionOrder(prefs: SessionListPrefs, category: string, keys: readonly string[], current: readonly string[]): SessionListPrefs {
  const sessions = { ...prefs.sessions, [category]: rememberSessions(keys, prefs.sessions?.[category]) };
  const saved = Object.keys(sessions);
  if (saved.length > MAX_SAVED_CATEGORIES) {
    const now = new Set(current);
    // Those of categories that are gone go first, then the oldest saved.
    const drop = [...saved.filter((id) => !now.has(id) && id !== category), ...saved.filter((id) => now.has(id) && id !== category)];
    for (const id of drop.slice(0, saved.length - MAX_SAVED_CATEGORIES)) delete sessions[id];
  }
  return { ...prefs, sessions };
}

export function withFolded(prefs: SessionListPrefs, category: string, folded: boolean): SessionListPrefs {
  const rest = (prefs.folded ?? []).filter((id) => id !== category);
  return { ...prefs, folded: folded ? [...rest, category].slice(-MAX_CATEGORIES) : rest };
}

/** "最後に使った順に戻す": the dragged orders go; the folded categories stay. */
export function withoutOrder(prefs: SessionListPrefs): SessionListPrefs {
  return prefs.folded?.length ? { folded: prefs.folded } : {};
}

export function hasOrder(prefs: SessionListPrefs): boolean {
  return Boolean(prefs.categories?.length || Object.keys(prefs.sessions ?? {}).length);
}

/** The sessions a category shows: all of them, or folded, only the one open (if it is there). */
export function shownSessions(c: ListedCategory, folded: boolean, open: string | undefined): ListedSession[] {
  return folded ? c.sessions.filter((s) => s.key === open) : c.sessions;
}

/** The row to open once the open session (`key`) is removed: the next in its category, else the one before. */
export function rowAfterRemoval(shown: readonly ListedCategory[], key: string): ListedSession | undefined {
  for (const c of shown) {
    const i = c.sessions.findIndex((s) => s.key === key);
    if (i >= 0) return c.sessions[i + 1] ?? c.sessions[i - 1];
  }
  return undefined;
}

/** What the probe of the plugin's hook last published (plugins/session-list.tsx). */
export type PublishedList =
  | { plugin: string; version: string; hideTabs: boolean; categories: ListedCategory[]; json: string }
  | { plugin: string; version: string; failed: true };

/** The plugin whose list this browser showed last, so that the sidebar waits for it when the page opens. */
export interface RememberedList {
  plugin: string;
  hideTabs: boolean;
}

/** What the plugins are, as the registry has them, for sessionListMode. */
export interface ListPlugins {
  /** Whether the Gasho server's list of plugins came (the snapshot); before it, nothing is known. */
  known: boolean;
  /** The installed plugins. */
  infos: readonly { id: string; enabled: boolean; hash?: string; web?: unknown; name: string }[];
  /** The loaded web parts, in the plugins' order: their version and whether they define a session list. */
  parts: readonly { id: string; version: string; hasList: boolean; hideTabs: boolean }[];
  /** Why a plugin's web part could not be loaded. */
  errors: Readonly<Record<string, string>>;
}

/**
 * Which list the sidebar shows: Gasho's worktrees (`gasho`, with the name of a plugin whose list failed), the plugin's
 * categories (`plugin`), or nothing yet while waiting for the plugin (`pending`): its list was the last one shown here,
 * and it is still loading, or its hook has not answered yet. `forget`: the plugin remembered is no longer to wait for.
 */
export type SessionListMode =
  | { kind: "gasho"; failed?: string; forget: boolean }
  | { kind: "pending"; plugin: string; hideTabs: boolean }
  | { kind: "plugin"; plugin: string; hideTabs: boolean; categories: ListedCategory[] };

export function sessionListMode(plugins: ListPlugins, published: PublishedList | undefined, remembered: RememberedList | undefined): SessionListMode {
  // The first loaded plugin with a list is the one used; another's hook is not called.
  const part = plugins.parts.find((p) => p.hasList);
  if (part) {
    if (published?.plugin === part.id && published.version === part.version) {
      if ("failed" in published) return { kind: "gasho", failed: plugins.infos.find((i) => i.id === part.id)?.name ?? part.id, forget: true };
      return { kind: "plugin", plugin: part.id, hideTabs: published.hideTabs, categories: published.categories };
    }
    return { kind: "pending", plugin: part.id, hideTabs: part.hideTabs };
  }
  if (remembered) {
    if (!plugins.known) return { kind: "pending", plugin: remembered.plugin, hideTabs: remembered.hideTabs };
    const info = plugins.infos.find((i) => i.id === remembered.plugin);
    const loaded = plugins.parts.some((p) => p.id === remembered.plugin);
    // Enabled, with a web part, not loaded yet and not failed to load: it is loading (the registry gives up after 15 s).
    if (info?.enabled && info.web && info.hash && !loaded && !plugins.errors[info.id]) {
      return { kind: "pending", plugin: remembered.plugin, hideTabs: remembered.hideTabs };
    }
    return { kind: "gasho", forget: true };
  }
  return { kind: "gasho", forget: false };
}

/** Whether the tabs above a session leave out its worktree's sessions and their "＋". */
export const hidesSessionTabs = (mode: SessionListMode) => mode.kind !== "gasho" && mode.hideTabs;

/** A hook's answer may change at most this many times in WINDOW_MS; more is taken for a loop (an answer made anew each time). */
export const MAX_CHANGES = 20;
const WINDOW_MS = 1000;

/** The times of the changes within the window, with one more at `now`, and whether that is too many. */
export function countChange(times: readonly number[], now: number): { times: number[]; tooMany: boolean } {
  const kept = [...times.filter((t) => now - t < WINDOW_MS), now];
  return { times: kept, tooMany: kept.length > MAX_CHANGES };
}
