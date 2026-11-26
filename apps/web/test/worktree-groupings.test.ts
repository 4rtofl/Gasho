import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineInfo, SessionInfo } from "@gasho/protocol";
import { OTHER_CATEGORY, withCategoryOrder, withSessionOrder } from "../src/lib/session-list.ts";
import { worktreeKey, worktreesByLastUse, type RememberedWorktree } from "../src/lib/sessions.ts";
import {
  arrangeWorktreeCategories,
  checkWorktreeGroupings,
  effectiveChoice,
  groupingOptions,
  holdWorktreeList,
  moveHeldWorktree,
  movesOfDrop,
  normalizeWorktreeCategories,
  withMoves,
  worktreeListContext,
  worktreeListMode,
  type GroupingPlugins,
  type ListedWorktreeCategory,
} from "../src/lib/worktree-groupings.ts";

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
const lib = { path: "/src/lib", branch: "main" };
const mac = machine(
  "mac",
  [
    session("a", { worktree: app, status: "idle", startedAt: 10, lastActivityAt: 300 }),
    session("b", { worktree: app, status: "busy", startedAt: 20, lastActivityAt: 100 }),
    session("c", { cwd: "/src/app-x", worktree: feat, status: "waiting", startedAt: 30, lastActivityAt: 200 }),
  ],
  // A registered repository with a worktree that has no session.
  { repos: [{ path: "/src/lib", worktrees: [lib] }] },
);
const remembered: RememberedWorktree[] = [{ machine: "mac", path: "/src/old", label: "fix/y", subfolders: true, branch: "fix/y", repo: "app", repoFolder: "/src/app" }];
const key = (path: string) => worktreeKey("mac", path);
const ctx = worktreeListContext(worktreesByLastUse([mac], remembered), [mac]);

test("the hook gets every worktree the sidebar lists, the one used last first, with its row's state and last use", () => {
  assert.deepEqual(
    ctx.worktrees.map((w) => `${w.path} ${w.status} ${w.lastUsed ?? "-"} ${w.registered}`),
    [
      // a was used at 300: its worktree comes first, waiting for nothing but working (b).
      "/src/app busy 300 false",
      "/src/app-x waiting 200 false",
      // Then the registered repository's worktree, and the one this browser keeps: no session, no state, no last use.
      "/src/lib unknown - true",
      "/src/old unknown - false",
    ],
  );
  const w = ctx.worktrees[0]!;
  assert.equal(w.key, key("/src/app"));
  assert.equal(w.repo, "/src/app");
  assert.equal(w.repoName, "app");
  assert.equal(w.branch, "main");
  assert.equal(ctx.worktrees[3]!.repo, "/src/app");
  // Offline, every worktree's state is unknown, as its row's dot is.
  const offline = worktreeListContext(worktreesByLastUse([{ ...mac, connected: false }]), [{ ...mac, connected: false }]);
  assert.ok(offline.worktrees.every((x) => x.status === "unknown"));
});

test("what the hook gave is kept as far as it is right; the worktrees it left out go in その他", () => {
  const got = normalizeWorktreeCategories(
    [
      { id: "repo", title: "  app\n ", hint: "mac · /src/app", launch: key("/src/app"), repo: { machine: "mac", path: "/src/app", extra: 1 }, worktrees: [{ key: key("/src/app"), description: "" }, { key: key("/src/app-x"), description: " x\ty " }] },
      // Without a title, the same id again, or Gasho's own: left out.
      { id: "notitle", worktrees: [{ key: key("/src/lib") }] },
      { id: "repo", title: "again", worktrees: [{ key: key("/src/lib") }] },
      { id: OTHER_CATEGORY, title: "mine", worktrees: [{ key: key("/src/lib") }] },
      // An unknown worktree, one placed before, and an unknown launch are left out; a description that is no string is Gasho's.
      // A repo on an unknown working server, or not an absolute path, is left out too.
      { id: "rest", title: "rest", launch: "nope", repo: { machine: "nope", path: "/src/lib" }, worktrees: [{ key: "nope" }, { key: key("/src/app") }, { key: key("/src/lib"), description: 3 }, "x"] },
      "not a category",
    ],
    ctx,
  );
  assert.deepEqual(got, [
    {
      id: "repo",
      title: "app",
      hint: "mac · /src/app",
      launch: key("/src/app"),
      repo: { machine: "mac", path: "/src/app" },
      worktrees: [
        { key: key("/src/app"), description: "" },
        { key: key("/src/app-x"), description: "x y" },
      ],
    },
    { id: "rest", title: "rest", worktrees: [{ key: key("/src/lib") }] },
    { id: OTHER_CATEGORY, title: "その他", worktrees: [{ key: key("/src/old") }] },
  ]);
  for (const repo of [{ machine: "mac", path: "src/app" }, { machine: "mac" }, { machine: "mac", path: `/${"a".repeat(1024)}` }, "mac:/src/app"]) {
    const [c] = normalizeWorktreeCategories([{ id: "r", title: "r", repo, worktrees: [] }], ctx);
    assert.equal(c!.repo, undefined, JSON.stringify(repo));
  }
  // No answer at all: every worktree in その他, in the context's order.
  assert.deepEqual(
    normalizeWorktreeCategories(undefined, ctx).map((c) => c.worktrees.map((w) => w.key.split("\u001f")[1])),
    [["/src/app", "/src/app-x", "/src/lib", "/src/old"]],
  );
});

const cat = (id: string, keys: string[]): ListedWorktreeCategory => ({ id, title: id, worktrees: keys.map((k) => ({ key: k })) });
const shown = (cs: ListedWorktreeCategory[]) => cs.map((c) => `${c.id}: ${c.worktrees.map((w) => w.key).join(",")}`);

test("the order dragged into is kept per category; what is new since comes first", () => {
  let prefs = withCategoryOrder({}, ["idle", "busy"]);
  prefs = withSessionOrder(prefs, "idle", ["z", "y"], ["idle", "busy"]);
  assert.deepEqual(shown(arrangeWorktreeCategories([cat("busy", ["a"]), cat("idle", ["x", "y", "z"]), cat("waiting", ["w"])], prefs)), [
    "waiting: w",
    "idle: x,z,y",
    "busy: a",
  ]);
});

test("while held, a worktree stays in the category it showed in; what came meanwhile comes first; what is gone goes", () => {
  const before = [cat("waiting", ["w"]), cat("busy", ["a", "b"]), cat("idle", ["x"])];
  const held = holdWorktreeList("p/status", arrangeWorktreeCategories(before, {}));
  // a stopped working (to idle), w was answered (to busy, and waiting is gone), x went, n and m came.
  const now = [cat("busy", ["w", "b", "n"]), cat("idle", ["a"]), cat("none", ["m"])];
  assert.deepEqual(shown(arrangeWorktreeCategories(now, {}, held)), [
    // A category that came with a worktree that came: first.
    "none: m",
    // A category the hook no longer gives stays while its worktree shows there.
    "waiting: w",
    "busy: n,a,b",
    // x is gone; a still shows in busy, so idle has nothing to show and is not there yet.
  ]);
  // The headings and lines are the hook's now.
  const renamed = arrangeWorktreeCategories([{ ...cat("busy", ["a", "b"]), title: "作業中" }, cat("waiting", ["w"])], {}, held);
  assert.equal(renamed.find((c) => c.id === "busy")?.title, "作業中");
  // Dragging still counts while held.
  const prefs = withSessionOrder({}, "busy", ["b", "a"], ["busy"]);
  assert.deepEqual(shown(arrangeWorktreeCategories(before, prefs, held)), ["waiting: w", "busy: b,a", "idle: x"]);
  // Released, the hook's categories show again.
  assert.deepEqual(shown(arrangeWorktreeCategories(now, {})), ["busy: w,b,n", "idle: a", "none: m"]);
});

test("a row dropped in another category shows there until the plugin took it, and while held, stays where it was dropped", () => {
  const answer = [cat("doing", ["a"]), cat("review", []), cat(OTHER_CATEGORY, ["n", "m"])];
  const moves = [
    { grouping: "p/manual", worktree: "n", to: "review" },
    { grouping: "p/manual", worktree: "a", to: OTHER_CATEGORY },
    // Of another grouping, and to a category that is gone: neither takes a row out of its own.
    { grouping: "p/other", worktree: "m", to: "doing" },
    { grouping: "p/manual", worktree: "m", to: "gone" },
  ];
  assert.deepEqual(shown(withMoves(answer, moves, "p/manual")), ["doing: ", "review: n", `${OTHER_CATEGORY}: a,m`]);
  // その他 shows once a row is dropped in it, and goes once its last row is taken out.
  assert.deepEqual(shown(withMoves([cat("doing", ["a"])], [{ grouping: "g", worktree: "a", to: OTHER_CATEGORY }], "g")), ["doing: ", `${OTHER_CATEGORY}: a`]);
  assert.deepEqual(shown(withMoves([cat("doing", []), cat(OTHER_CATEGORY, ["n"])], [{ grouping: "g", worktree: "n", to: "doing" }], "g")), ["doing: n"]);

  // Held: the row goes where it was dropped, and the heading it left stays while the hook still gives it.
  const held = moveHeldWorktree(holdWorktreeList("p/manual", answer), "n", "doing", 0);
  assert.deepEqual(shown(held.categories), ["doing: n,a", "review: ", `${OTHER_CATEGORY}: m`]);
  assert.deepEqual(shown(arrangeWorktreeCategories(answer, {}, held)), ["doing: n,a", "review: ", `${OTHER_CATEGORY}: m`]);
  // When the plugin's function failed, it goes back to where it was.
  assert.deepEqual(shown(moveHeldWorktree(held, "n", OTHER_CATEGORY, 0).categories), ["doing: a", "review: ", `${OTHER_CATEGORY}: n,m`]);
});

test("a selected row dropped in another category takes the selected rows of the other categories with it, where it was dropped", () => {
  const categoryOf = (k: string) => ({ a: "doing", b: "doing", c: "review", d: "done", e: "done" })[k];
  // b dropped first in done, above d (which is selected, and already there).
  const drop = { id: "b", from: "doing", ids: ["b", "d", "e"] };
  assert.deepEqual(movesOfDrop(drop, ["a", "b", "c", "d"], categoryOf), {
    ids: ["a", "b", "c", "d", "e"],
    moves: [
      { worktree: "a", from: "doing", index: 0 },
      { worktree: "b", from: "doing", index: 1 },
      { worktree: "c", from: "review", index: 2 },
    ],
  });
  // A row out of the selection, or a selection of one, goes alone.
  for (const selected of [["a", "c"], ["b"]]) {
    assert.deepEqual(movesOfDrop(drop, selected, categoryOf), { ids: ["b", "d", "e"], moves: [{ worktree: "b", from: "doing", index: 0 }] });
  }
});

test("the groupings offered are those of the loaded plugins, in their order; the first is used until one is picked", () => {
  const options = groupingOptions([
    { id: "better", name: "Better", groupings: [{ id: "repo", label: "リポジトリごと" }, { id: "status", label: "作業中・待機中" }] },
    { id: "other", name: "Other", groupings: [{ id: "r", label: "リポジトリごと" }] },
  ]);
  assert.deepEqual(
    options.map((o) => `${o.key} ${o.label} ${o.ambiguous}`),
    ["better/repo リポジトリごと true", "better/status 作業中・待機中 false", "other/r リポジトリごと true"],
  );
  assert.deepEqual(effectiveChoice(undefined, options), { plugin: "better", grouping: "repo" });
  assert.equal(effectiveChoice("none", options), "none");
  assert.deepEqual(effectiveChoice({ plugin: "other", grouping: "r" }, options), { plugin: "other", grouping: "r" });
  assert.equal(effectiveChoice(undefined, []), undefined);
});

test("which list shows: the grouping's categories once its hook answered, Gasho's own otherwise", () => {
  const info = { id: "better", enabled: true, hash: "h1", web: {}, name: "Better" };
  const loaded: GroupingPlugins = { known: true, infos: [info], parts: [{ id: "better", version: "h1", name: "Better", groupings: ["repo", "status"] }], errors: {} };
  const choice = { plugin: "better", grouping: "status" };
  const categories = [cat("busy", ["a"])];
  const answer = { plugin: "better", version: "h1", grouping: "status", categories, json: "" };
  assert.deepEqual(worktreeListMode(undefined, loaded, answer), { kind: "flat" });
  assert.deepEqual(worktreeListMode("none", loaded, answer), { kind: "flat" });
  assert.deepEqual(worktreeListMode(choice, loaded, answer), { kind: "grouped", plugin: "better", grouping: "status", categories });
  // Not answered yet, or answered by another version or grouping: waiting.
  for (const published of [undefined, { ...answer, version: "h0" }, { ...answer, grouping: "repo" }]) {
    assert.equal(worktreeListMode(choice, loaded, published).kind, "pending");
  }
  // The hook threw: Gasho's own list, naming the plugin.
  assert.deepEqual(worktreeListMode(choice, loaded, { plugin: "better", version: "h1", grouping: "status", failed: true }), { kind: "flat", failed: "Better" });
  // The loaded version has no such grouping.
  assert.deepEqual(worktreeListMode({ plugin: "better", grouping: "gone" }, loaded, undefined), { kind: "flat" });
  // Before the list of plugins came, and while the plugin loads: waiting.
  const notLoaded = { ...loaded, parts: [] };
  assert.equal(worktreeListMode(choice, { ...notLoaded, known: false }, undefined).kind, "pending");
  assert.equal(worktreeListMode(choice, notLoaded, undefined).kind, "pending");
  // Disabled, removed, or failed to load: Gasho's own list.
  assert.deepEqual(worktreeListMode(choice, { ...notLoaded, infos: [{ ...info, enabled: false }] }, undefined), { kind: "flat" });
  assert.deepEqual(worktreeListMode(choice, { ...notLoaded, infos: [] }, undefined), { kind: "flat" });
  assert.deepEqual(worktreeListMode(choice, { ...notLoaded, errors: { better: "x" } }, undefined), { kind: "flat" });
});

test("a web part's groupings need an id each (once), a label and useCategories", () => {
  const ok = { id: "repo", label: "リポジトリごと", useCategories: () => [] };
  assert.equal(checkWorktreeGroupings(undefined), undefined);
  assert.equal(checkWorktreeGroupings([ok, { ...ok, id: "status" }]), undefined);
  assert.match(checkWorktreeGroupings(ok) ?? "", /配列/);
  assert.match(checkWorktreeGroupings([{ ...ok, id: "" }]) ?? "", /id/);
  assert.match(checkWorktreeGroupings([{ ...ok, id: "x".repeat(101) }]) ?? "", /100文字/);
  assert.match(checkWorktreeGroupings([ok, ok]) ?? "", /「repo」が2つ/);
  assert.match(checkWorktreeGroupings([{ ...ok, label: " " }]) ?? "", /label/);
  assert.match(checkWorktreeGroupings([{ ...ok, useCategories: "no" }]) ?? "", /useCategories/);
  assert.equal(checkWorktreeGroupings([{ ...ok, useOnMove: () => () => {} }]), undefined);
  assert.match(checkWorktreeGroupings([{ ...ok, useOnMove: {} }]) ?? "", /useOnMove/);
});
