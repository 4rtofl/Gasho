import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineInfo, SessionInfo } from "@gasho/protocol";
import {
  arrangeCategories,
  countChange,
  hasOrder,
  hidesSessionTabs,
  holdOrder,
  MAX_CHANGES,
  normalizeCategories,
  OTHER_CATEGORY,
  rowAfterRemoval,
  sessionKey,
  sessionListContext,
  sessionListMode,
  shownSessions,
  withCategoryOrder,
  withFolded,
  withoutOrder,
  withSessionOrder,
  type ListedCategory,
  type ListPlugins,
} from "../src/lib/session-list.ts";
import { worktreesByLastUse } from "../src/lib/sessions.ts";

const session = (sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId,
  cwd: "/src/app",
  status: "idle",
  rcMode: "server",
  prLinks: [],
  managed: true,
  ...extra,
});
const machine = (id: string, sessions: SessionInfo[], extra: Partial<MachineInfo> = {}): MachineInfo => ({
  id,
  name: id,
  connected: true,
  lastSeen: 0,
  sessions,
  ...extra,
});

const app = { path: "/src/app", repo: "/src/app", branch: "main" };
const feat = { path: "/src/app-x", repo: "/src/app", branch: "feat/x" };
const machines = [
  machine("mac", [
    session("a", { worktree: app, startedAt: 10, lastActivityAt: 300 }),
    session("b", { worktree: app, startedAt: 20, lastActivityAt: 100 }),
    session("c", { cwd: "/src/app-x", worktree: feat, startedAt: 30 }),
    // Not started from Gasho: not shown.
    session("d", { worktree: app, managed: false, lastActivityAt: 999 }),
  ]),
];
const ctx = sessionListContext(worktreesByLastUse(machines), machines);

test("the plugin gets the sessions Gasho shows, the one used last first, with their worktrees", () => {
  assert.deepEqual(
    ctx.sessions.map((s) => `${s.session.sessionId} ${s.worktree.split("\u001f")[1]} ${s.lastUsed}`),
    // c has no activity yet: its start counts.
    ["a /src/app 300", "b /src/app 100", "c /src/app-x 30"],
  );
  assert.deepEqual(
    ctx.worktrees.map((w) => [w.key, w.path, w.repo, w.branch, w.repoName, w.registered, w.sessions.length]),
    [
      ["mac\u001f/src/app", "/src/app", "/src/app", "main", "app", false, 2],
      ["mac\u001f/src/app-x", "/src/app-x", "/src/app", "feat/x", "app", false, 1],
    ],
  );
});

const key = (id: string) => sessionKey("mac", id);
const ref = (id: string, description?: string) => ({ machine: "mac", sessionId: id, ...(description ? { description } : {}) });

test("what the plugin gave is kept as far as it is right; the sessions it left out go in その他", () => {
  const got = normalizeCategories(
    [
      { id: "app", title: "  app\n", description: "mac", hint: "/src/app", launch: "mac\u001f/src/app", sessions: [ref("b", "main"), ref("a"), ref("b"), ref("zz")] },
      // The same id again, no title, not an object: left out.
      { id: "app", title: "again", sessions: [ref("c")] },
      { id: "untitled", title: "  ", sessions: [ref("c")] },
      "nonsense",
      // A launch naming no worktree of the context has no "＋".
      { id: "other", title: "other", launch: "/etc", sessions: [{ machine: "mac" }, ref("d")] },
    ],
    ctx,
  );
  assert.deepEqual(got, [
    {
      id: "app",
      title: "app",
      description: "mac",
      hint: "/src/app",
      launch: "mac\u001f/src/app",
      sessions: [
        { key: key("b"), machine: "mac", sessionId: "b", description: "main" },
        { key: key("a"), machine: "mac", sessionId: "a" },
      ],
    },
    { id: "other", title: "other", sessions: [] },
    { id: OTHER_CATEGORY, title: "その他", sessions: [{ key: key("c"), machine: "mac", sessionId: "c" }] },
  ]);
  // The same answer gives the same result (it is published only when it changes).
  assert.equal(JSON.stringify(normalizeCategories([{ id: "x", title: "x", sessions: [ref("a")] }], ctx)), JSON.stringify(normalizeCategories([{ id: "x", title: "x", sessions: [ref("a")] }], ctx)));
  // Not an array: every session in その他, the one used last first.
  assert.deepEqual(
    normalizeCategories(undefined, ctx).map((c) => [c.id, c.sessions.map((s) => s.sessionId)]),
    [[OTHER_CATEGORY, ["a", "b", "c"]]],
  );
  // The plugin cannot take the id of Gasho's own category.
  assert.deepEqual(
    normalizeCategories([{ id: OTHER_CATEGORY, title: "mine", sessions: [ref("a")] }], ctx).map((c) => c.title),
    ["その他"],
  );
});

const cat = (id: string, sessions: string[]): ListedCategory => ({ id, title: id, sessions: sessions.map((s) => ({ key: key(s), machine: "mac", sessionId: s })) });
const order = (cs: ListedCategory[]) => cs.map((c) => `${c.id}:${c.sessions.map((s) => s.sessionId).join(",")}`);

test("the order dragged into is kept per category; what is new since comes first; the others keep the plugin's", () => {
  const plugin = [cat("x", ["a", "b", "c"]), cat("y", ["d", "e"]), cat("z", ["f"])];
  let prefs = withCategoryOrder({}, ["z", "x", "y"]);
  prefs = withSessionOrder(prefs, "x", [key("c"), key("a"), key("b")], ["x", "y", "z"]);
  assert.deepEqual(order(arrangeCategories(plugin, prefs)), ["z:f", "x:c,a,b", "y:d,e"]);
  // A session started in x and a new category since: first. y was never dragged: the plugin's order (last used).
  const later = [cat("w", ["g"]), cat("x", ["h", "a", "b", "c"]), cat("y", ["e", "d"]), cat("z", ["f"])];
  assert.deepEqual(order(arrangeCategories(later, prefs)), ["w:g", "z:f", "x:h,c,a,b", "y:e,d"]);
  assert.ok(hasOrder(prefs));
  // Back to the plugin's order: the folding stays.
  const reset = withoutOrder(withFolded(prefs, "y", true));
  assert.deepEqual(reset, { folded: ["y"] });
  assert.equal(hasOrder(reset), false);
  assert.deepEqual(order(arrangeCategories(later, reset)), ["w:g", "x:h,a,b,c", "y:e,d", "z:f"]);
  assert.deepEqual(withFolded(reset, "y", false), { folded: [] });
});

test("while held, the list keeps the order it showed; what came meanwhile comes first, and dragging still counts", () => {
  const shown = arrangeCategories([cat("x", ["a", "b"]), cat("y", ["c"])], {});
  const held = holdOrder(shown);
  // Meanwhile y was used last, and b in x; a new session came in y.
  const now = [cat("y", ["n", "c"]), cat("x", ["b", "a"])];
  assert.deepEqual(order(arrangeCategories(now, {}, held)), ["x:a,b", "y:n,c"]);
  assert.deepEqual(order(arrangeCategories(now, {})), ["y:n,c", "x:b,a"]);
  assert.deepEqual(order(arrangeCategories(now, withCategoryOrder({}, ["y", "x"]), held)), ["y:n,c", "x:a,b"]);
});

test("the saved orders of sessions are kept for at most 100 categories, those of gone categories dropped first", () => {
  let prefs = {};
  for (let i = 0; i < 100; i++) prefs = withSessionOrder(prefs, `gone${i}`, [key("a")], []);
  prefs = withSessionOrder(prefs, "x", [key("a")], ["x"]);
  const saved = Object.keys((prefs as { sessions: Record<string, string[]> }).sessions);
  assert.equal(saved.length, 100);
  assert.ok(saved.includes("x"));
  assert.ok(!saved.includes("gone0"));
});

test("a folded category shows only the open session; the row after a removed one is the next in its category", () => {
  const c = cat("x", ["a", "b", "c"]);
  assert.deepEqual(shownSessions(c, true, key("b")).map((s) => s.sessionId), ["b"]);
  assert.deepEqual(shownSessions(c, true, key("zz")), []);
  assert.deepEqual(shownSessions(c, false, key("b")).map((s) => s.sessionId), ["a", "b", "c"]);
  const shown = [c, cat("y", ["d"])];
  assert.equal(rowAfterRemoval(shown, key("b"))?.sessionId, "c");
  assert.equal(rowAfterRemoval(shown, key("c"))?.sessionId, "b");
  // Alone in its category: none (the worktree's screen opens).
  assert.equal(rowAfterRemoval(shown, key("d")), undefined);
});

const plugins = (extra: Partial<ListPlugins> = {}): ListPlugins => ({
  known: true,
  infos: [
    { id: "rewind", name: "Session List Rewind", enabled: true, hash: "h2", web: { js: "web.js" } },
    { id: "zz-other", name: "Other list", enabled: true, hash: "o1", web: { js: "web.js" } },
  ],
  parts: [],
  errors: {},
  ...extra,
});
const listed = [cat("x", ["a"])];

test("the sidebar shows the first plugin's list once its hook answered, and Gasho's otherwise", () => {
  const parts = [
    { id: "rewind", version: "h2", hasList: true, hideTabs: true },
    { id: "zz-other", version: "o1", hasList: true, hideTabs: false },
  ];
  // Loaded, not answered yet: waiting (the tabs already hidden, not to come and go).
  assert.deepEqual(sessionListMode(plugins({ parts }), undefined, undefined), { kind: "pending", plugin: "rewind", hideTabs: true });
  const mine = { plugin: "rewind", version: "h2", hideTabs: true, categories: listed, json: JSON.stringify(listed) };
  assert.deepEqual(sessionListMode(plugins({ parts }), mine, undefined), { kind: "plugin", plugin: "rewind", hideTabs: true, categories: listed });
  // What an older version published does not count.
  assert.equal(sessionListMode(plugins({ parts }), { ...mine, version: "h1" }, undefined).kind, "pending");
  // Its hook threw: Gasho's list, naming the plugin; the plugin remembered is forgotten.
  assert.deepEqual(sessionListMode(plugins({ parts }), { plugin: "rewind", version: "h2", failed: true }, undefined), {
    kind: "gasho",
    failed: "Session List Rewind",
    forget: true,
  });
  // No plugin with a list.
  assert.deepEqual(sessionListMode(plugins({ parts: [{ id: "rewind", version: "h2", hasList: false, hideTabs: false }] }), undefined, undefined), { kind: "gasho", forget: false });
  assert.equal(hidesSessionTabs(sessionListMode(plugins({ parts }), mine, undefined)), true);
  assert.equal(hidesSessionTabs(sessionListMode(plugins({ parts }), { ...mine, hideTabs: false }, undefined)), false);
  assert.equal(hidesSessionTabs({ kind: "gasho", forget: false }), false);
});

test("a page opened after the plugin's list was shown waits for it while it loads, and only then", () => {
  const remembered = { plugin: "rewind", hideTabs: true };
  const pending = { kind: "pending", plugin: "rewind", hideTabs: true };
  // Before the Gasho server's list of plugins, and while the plugin loads.
  assert.deepEqual(sessionListMode(plugins({ known: false, infos: [] }), undefined, remembered), pending);
  assert.deepEqual(sessionListMode(plugins(), undefined, remembered), pending);
  // It could not be loaded, it is disabled or gone, or its version has no list: Gasho's list, and forget it.
  const gasho = { kind: "gasho", forget: true };
  assert.deepEqual(sessionListMode(plugins({ errors: { rewind: "読み込めませんでした：…" } }), undefined, remembered), gasho);
  assert.deepEqual(sessionListMode(plugins({ infos: [{ id: "rewind", name: "R", enabled: false, hash: "h2", web: {} }] }), undefined, remembered), gasho);
  assert.deepEqual(sessionListMode(plugins({ infos: [] }), undefined, remembered), gasho);
  assert.deepEqual(sessionListMode(plugins({ parts: [{ id: "rewind", version: "h2", hasList: false, hideTabs: false }] }), undefined, remembered), gasho);
});

test("more than 20 changes of a hook's answer within a second are taken for a loop", () => {
  let times: number[] = [];
  let tooMany = false;
  for (let i = 0; i < MAX_CHANGES; i++) ({ times, tooMany } = countChange(times, i * 10));
  assert.equal(tooMany, false);
  assert.equal(countChange(times, MAX_CHANGES * 10).tooMany, true);
  // Spread over more than a second, as many are fine.
  assert.equal(countChange(times, 1000 + 5).tooMany, false);
});
