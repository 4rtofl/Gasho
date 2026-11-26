import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineInfo, SessionInfo } from "@gasho/protocol";
import { worktreesByLastUse } from "../src/lib/sessions.ts";
import { descendants, launchFolders, nestCategories, nestWorktrees, shownWhileFolded, worktreeParents } from "../src/lib/worktree-nesting.ts";

const session = (sessionId: string, path: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId,
  cwd: path,
  status: "idle",
  rcMode: "server",
  prLinks: [],
  managed: true,
  worktree: { path, repo: "/r/app", branch: path.slice(path.lastIndexOf("/") + 1) },
  ...extra,
});
const machine = (id: string, sessions: SessionInfo[]): MachineInfo => ({ id, name: id, connected: true, lastSeen: 0, sessions });
const from = (sessionId: string, cwd: string) => ({ launchedBy: { sessionId, cwd } });
const key = (m: string, path: string) => `${m}\u001f${path}`;

test("a worktree's parent is the worktree its session was started from, by the folder, on the same working server", () => {
  const list = worktreesByLastUse([
    machine("mac", [
      session("main", "/r/app", { startedAt: 1 }),
      // Started from a folder inside the parent worktree: the deepest worktree that holds it.
      session("a", "/r/app-a", { startedAt: 2, ...from("main", "/r/app/web") }),
      // A grandchild.
      session("b", "/r/app-b", { startedAt: 3, ...from("a", "/r/app-a") }),
      // Its first session started from somewhere tells; a later one does not change it.
      session("c1", "/r/app-c", { startedAt: 4 }),
      session("c2", "/r/app-c", { startedAt: 5, ...from("a", "/r/app-a") }),
      session("c3", "/r/app-c", { startedAt: 6, ...from("main", "/r/app") }),
      // A parent's folder that no worktree listed holds.
      session("d", "/r/app-d", { startedAt: 7, ...from("x", "/elsewhere") }),
    ]),
    // The same folder on another working server is not the parent.
    machine("ubuntu", [session("e", "/r/app-e", { startedAt: 8, ...from("main", "/r/app") })]),
  ]);
  const folders = launchFolders(list);
  assert.equal(folders.get(key("mac", "/r/app-c")), "/r/app-a");
  const parents = worktreeParents(list, folders);
  assert.deepEqual(
    [...parents].sort(),
    [
      [key("mac", "/r/app-a"), key("mac", "/r/app")],
      [key("mac", "/r/app-b"), key("mac", "/r/app-a")],
      [key("mac", "/r/app-c"), key("mac", "/r/app-a")],
    ],
  );
});

test("a worktree is never its own parent, and a loop is cut", () => {
  const list = worktreesByLastUse([
    machine("mac", [
      session("self", "/r/self", from("x", "/r/self/sub")),
      session("p", "/r/p", from("q", "/r/q")),
      session("q", "/r/q", from("p", "/r/p")),
      session("r", "/r/r", from("q", "/r/q")),
    ]),
  ]);
  const parents = worktreeParents(list, launchFolders(list));
  assert.equal(parents.has(key("mac", "/r/self")), false);
  // p and q name each other: the loop is cut at one of them, and r still goes under q.
  assert.equal([parents.has(key("mac", "/r/p")), parents.has(key("mac", "/r/q"))].filter(Boolean).length, 1);
  assert.equal(parents.get(key("mac", "/r/r")), key("mac", "/r/q"));
});

test("the folders kept by the browser tell the parent of a worktree whose sessions are gone", () => {
  const list = worktreesByLastUse([machine("mac", [session("main", "/r/app")])], [
    { machine: "mac", path: "/r/app-a", label: "app-a", subfolders: true },
  ]);
  const parents = worktreeParents(list, new Map([[key("mac", "/r/app-a"), "/r/app"]]));
  assert.equal(parents.get(key("mac", "/r/app-a")), key("mac", "/r/app"));
});

test("children go under their parent in the order of the list; those whose parent is not listed stay at the top", () => {
  const parents = new Map([
    ["c", "a"],
    ["d", "c"],
    ["b", "gone"],
    ["e", "a"],
  ]);
  const tree = nestWorktrees(["e", "b", "a", "c", "d"], parents);
  assert.deepEqual(tree.roots, ["b", "a"]);
  assert.deepEqual(tree.children.get("a"), ["e", "c"]);
  assert.deepEqual(descendants("a", tree.children), ["e", "c", "d"]);
});

test("in a grouping, a child shows in its parent's category, under it", () => {
  const parents = new Map([
    ["child", "parent"],
    ["grandchild", "child"],
    ["lonely", "gone"],
  ]);
  const { roots, children } = nestCategories(
    [
      { id: "busy", keys: ["child", "x"] },
      { id: "idle", keys: ["parent", "grandchild", "lonely"] },
    ],
    parents,
  );
  assert.deepEqual(roots.get("busy"), ["x"]);
  assert.deepEqual(roots.get("idle"), ["parent", "lonely"]);
  assert.deepEqual(descendants("parent", children), ["child", "grandchild"]);
});

test("a folded parent still shows the way to the open worktree", () => {
  const children = new Map([
    ["a", ["b", "c"]],
    ["c", ["d"]],
  ]);
  assert.deepEqual(shownWhileFolded("a", children, undefined), []);
  assert.deepEqual(shownWhileFolded("a", children, "b"), ["b"]);
  assert.deepEqual(shownWhileFolded("a", children, "d"), ["c"]);
});
