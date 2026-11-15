import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineInfo, SessionInfo } from "@gasho/protocol";
import { removeWorktreeProblem, sessionsInWorktree, showsWorktree } from "../src/lib/worktree-remove.ts";

const session = (sessionId: string, cwd: string): SessionInfo => ({ sessionId, cwd, status: "idle", rcMode: "none", prLinks: [] });
const machine = (o: Partial<MachineInfo> = {}): MachineInfo => ({
  id: "m1",
  name: "ubuntu",
  connected: true,
  lastSeen: 0,
  canRemoveWorktree: true,
  sessions: [session("a", "/r/app-x"), session("b", "/r/app-x/web"), session("c", "/r/app-xy"), session("d", "/r/app")],
  ...o,
});

test("a worktree can be removed only inside a repository, not the main one, on a connected gasho-daemon that can", () => {
  const w = { path: "/r/app-x", repo: "/r/app" };
  assert.equal(removeWorktreeProblem(machine(), w), undefined);
  assert.match(removeWorktreeProblem(machine(), { path: "/r/app", repo: "/r/app" }) ?? "", /main の worktree/);
  assert.match(removeWorktreeProblem(machine(), { path: "/notes" }) ?? "", /リポジトリの外/);
  assert.match(removeWorktreeProblem(machine({ connected: false }), w) ?? "", /ubuntu はオフライン/);
  assert.match(removeWorktreeProblem(machine({ canRemoveWorktree: undefined }), w) ?? "", /gasho-daemon は古い/);
});

test("the sessions in a worktree are those whose folder is in it, not in a folder whose name only starts the same", () => {
  assert.deepEqual(sessionsInWorktree(machine(), "/r/app-x").map((s) => s.sessionId), ["a", "b"]);
});

test("the screen shows a worktree on its page, its plugin views, and its sessions", () => {
  assert.equal(showsWorktree({ name: "worktree", machine: "m1", path: "/r/app-x" }, "m1", "/r/app-x", []), true);
  assert.equal(showsWorktree({ name: "worktree", machine: "m1", path: "/r/app-x", view: { plugin: "p", id: "v", params: {} } }, "m1", "/r/app-x", []), true);
  assert.equal(showsWorktree({ name: "worktree", machine: "m2", path: "/r/app-x" }, "m1", "/r/app-x", []), false);
  assert.equal(showsWorktree({ name: "session", machine: "m1", sessionId: "a" }, "m1", "/r/app-x", ["a"]), true);
  assert.equal(showsWorktree({ name: "session", machine: "m1", sessionId: "c" }, "m1", "/r/app-x", ["a"]), false);
  assert.equal(showsWorktree({ name: "plugin", plugin: "p", page: "x", params: {} }, "m1", "/r/app-x", ["a"]), false);
  assert.equal(showsWorktree({ name: "home" }, "m1", "/r/app-x", []), false);
});
