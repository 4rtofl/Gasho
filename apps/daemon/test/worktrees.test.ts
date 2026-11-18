import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ControlRequest, controlRequest, controlSocketOf, sessionCommand, startControlServer, worktreeCommand } from "../src/control.ts";
import { Daemon } from "../src/daemon.ts";
import { changesProblem, removableWorktree, removeWorktree, worktreeChanges } from "../src/worktrees.ts";

/** A repository pushed to a bare remote, with two worktrees beside it: "done" (pushed) and "wip". */
function setup() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gasho-wt-")));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, stdio: "pipe" }).toString().trim();
  const commit = (cwd: string, msg: string) => {
    fs.writeFileSync(path.join(cwd, `${msg.replace(/\W/g, "-")}.txt`), msg);
    run(cwd, "add", "-A");
    run(cwd, "-c", "user.name=Ama", "-c", "user.email=a@example.com", "commit", "-m", msg);
    return run(cwd, "rev-parse", "HEAD");
  };
  const remote = path.join(dir, "remote.git");
  const repo = path.join(dir, "repo");
  run(dir, "init", "--bare", "-b", "main", remote);
  run(dir, "init", "-b", "main", repo);
  commit(repo, "first");
  run(repo, "remote", "add", "origin", remote);
  run(repo, "push", "-u", "origin", "main");
  const done = path.join(dir, "repo-done");
  const wip = path.join(dir, "repo-wip");
  run(repo, "worktree", "add", "-b", "feat/done", done);
  commit(done, "done work");
  run(done, "push", "origin", "feat/done");
  run(repo, "worktree", "add", "-b", "feat/wip", wip);
  const branches = () => run(repo, "branch", "--format=%(refname:short)").split("\n").sort();
  return { dir, repo, remote, done, wip, run, commit, branches, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("only a worktree that git lists, other than the main one, may be removed", async () => {
  const t = setup();
  try {
    assert.deepEqual(await removableWorktree(t.done), { path: t.done, repo: t.repo, branch: "feat/done" });
    assert.match((await removableWorktree(t.repo) as { error: string }).error, /main の worktree/);
    fs.mkdirSync(path.join(t.done, "sub"));
    assert.match((await removableWorktree(path.join(t.done, "sub")) as { error: string }).error, /worktree の中のフォルダー/);
    const plain = path.join(t.dir, "plain");
    fs.mkdirSync(plain);
    assert.match((await removableWorktree(plain) as { error: string }).error, /git のリポジトリではありません/);
    assert.match((await removableWorktree(path.join(t.dir, "nothing")) as { error: string }).error, /フォルダーがありません/);
    assert.match((await removableWorktree("relative") as { error: string }).error, /絶対パス/);
    // Another repository's clone is its own main worktree.
    const other = path.join(t.dir, "other");
    t.run(t.dir, "clone", "-q", t.remote, other);
    assert.match((await removableWorktree(other) as { error: string }).error, /main の worktree/);
  } finally {
    t.cleanup();
  }
});

test("a pushed worktree is removed with its branch", async () => {
  const t = setup();
  try {
    assert.deepEqual(await worktreeChanges(t.done), { uncommitted: 0, unpushed: 0 });
    const w = await removableWorktree(t.done);
    assert.ok(!("error" in w));
    assert.deepEqual(await removeWorktree(w, { deleteBranch: true }), {});
    assert.equal(fs.existsSync(t.done), false);
    assert.deepEqual(t.branches(), ["feat/wip", "main"]);
    assert.ok(!t.run(t.repo, "worktree", "list").includes("repo-done"));
  } finally {
    t.cleanup();
  }
});

test("without deleteBranch the branch stays", async () => {
  const t = setup();
  try {
    const w = await removableWorktree(t.done);
    assert.ok(!("error" in w));
    await removeWorktree(w, {});
    assert.equal(fs.existsSync(t.done), false);
    assert.deepEqual(t.branches(), ["feat/done", "feat/wip", "main"]);
  } finally {
    t.cleanup();
  }
});

test("uncommitted changes and unpushed commits are counted, and git refuses them without force", async () => {
  const t = setup();
  try {
    t.commit(t.wip, "local one");
    t.commit(t.wip, "local two");
    fs.writeFileSync(path.join(t.wip, "first.txt"), "changed");
    fs.writeFileSync(path.join(t.wip, "new.txt"), "untracked");
    // Ignored files are not changes that would be lost.
    fs.writeFileSync(path.join(t.wip, ".gitignore"), "build/\n");
    fs.mkdirSync(path.join(t.wip, "build"));
    fs.writeFileSync(path.join(t.wip, "build", "out.js"), "x");
    const changes = await worktreeChanges(t.wip);
    assert.deepEqual(changes, { uncommitted: 3, unpushed: 2 });
    assert.match(changesProblem(changes) ?? "", /未コミットの変更が 3 件、push していない commit が 2 件/);
    assert.equal(changesProblem({ uncommitted: 0, unpushed: 0 }), undefined);
    const w = await removableWorktree(t.wip);
    assert.ok(!("error" in w));
    await assert.rejects(removeWorktree(w, {}), /git worktree remove が失敗しました/);
    assert.equal(fs.existsSync(t.wip), true);
    // force removes it with the changes, and -D deletes the branch git sees as not merged.
    assert.deepEqual(await removeWorktree(w, { force: true, deleteBranch: true }), {});
    assert.equal(fs.existsSync(t.wip), false);
    assert.deepEqual(t.branches(), ["feat/done", "main"]);
  } finally {
    t.cleanup();
  }
});

test("commits given as pushed (a pull request merged by squashing, its branch deleted) count as pushed", async () => {
  const t = setup();
  try {
    const first = t.commit(t.wip, "pr one");
    const head = t.commit(t.wip, "pr two");
    assert.equal((await worktreeChanges(t.wip)).unpushed, 2);
    // The head of the pull request, and those before it; abbreviated SHAs too.
    assert.equal((await worktreeChanges(t.wip, [head])).unpushed, 0);
    assert.equal((await worktreeChanges(t.wip, [head.slice(0, 10)])).unpushed, 0);
    assert.equal((await worktreeChanges(t.wip, [first])).unpushed, 1);
    // A commit after the pull request's head is still not pushed.
    t.commit(t.wip, "after merge");
    assert.equal((await worktreeChanges(t.wip, [head])).unpushed, 1);
    // A SHA this clone does not have, or that is no SHA, is ignored.
    assert.equal((await worktreeChanges(t.wip, ["f".repeat(40), "--all"])).unpushed, 3);
  } finally {
    t.cleanup();
  }
});

test("a branch that cannot be deleted leaves a warning, with the worktree gone", async () => {
  const t = setup();
  try {
    const w = await removableWorktree(t.done);
    assert.ok(!("error" in w));
    // git keeps a branch checked out in another worktree (main is, in the repository's folder).
    const r = await removeWorktree({ ...w, branch: "main" }, { deleteBranch: true });
    assert.match(r.warning ?? "", /worktree は削除しましたが、ブランチ main は削除できませんでした/);
    assert.equal(fs.existsSync(t.done), false);
    assert.deepEqual(t.branches(), ["feat/done", "feat/wip", "main"]);
  } finally {
    t.cleanup();
  }
});

/** gasho-daemon's worktree.remove, with the sessions' ending stubbed (launch.test.ts covers session.end and session.remove). */
function daemonFor(t: ReturnType<typeof setup>) {
  const d = new Daemon({
    hubUrl: "ws://127.0.0.1:1",
    machineId: "m",
    token: "t",
    hookPort: 0,
    claudeDir: path.join(t.dir, "claude-dir"),
    claudeBin: "claude",
    ghBin: "gh",
    pollIntervalMs: 60_000,
    stateDir: path.join(t.dir, "state"),
    attachmentsDir: path.join(t.dir, "attachments"),
  } as ConstructorParameters<typeof Daemon>[0]) as unknown as Record<string, any>;
  const calls: string[] = [];
  const stays = new Set<string>();
  d.refresh = async () => undefined;
  d.refreshFolders = async () => undefined;
  d.refreshRepos = async () => calls.push("repos");
  d.end = async (ids: string[]) => {
    calls.push(`end ${ids.join(",")}`);
    const ended = ids.filter((id) => !stays.has(id));
    return ended.length === ids.length ? { ok: true, ended } : { ok: true, ended, warning: "次の会話の Claude Code は終了しませんでした。" };
  };
  d.remove = async (id: string) => {
    calls.push(`remove ${id}`);
    d.managed.remove(id);
    return { ok: true };
  };
  const session = (sessionId: string, cwd: string, own: boolean, name?: string) => {
    d.tracked.set(sessionId, { info: { sessionId, cwd, status: "idle", rcMode: "none", prLinks: [], ...(name ? { name } : {}) }, meta: {} });
    if (own) d.managed.add({ sessionId, terminal: `t-${sessionId}`, pid: 1, cwd, name: sessionId, launchedAt: Date.now() });
  };
  const run = (cmd: Record<string, unknown>) => d.removeWorktree({ type: "worktree.remove", requestId: "r", ...cmd });
  return { d, calls, stays, session, run };
}

test("gasho-daemon ends the sessions in the worktree, those outside Gasho first, then removes it and its branch", async () => {
  const t = setup();
  const { calls, session, run } = daemonFor(t);
  try {
    session("mine", t.done, true);
    session("mine-sub", path.join(t.done, "sub"), true);
    session("orca", t.done, false);
    session("elsewhere", t.wip, true);
    const r = await run({ path: t.done, branch: "feat/done" });
    assert.deepEqual(r, { ok: true, ended: ["orca", "mine", "mine-sub"] });
    assert.deepEqual(calls, ["end orca", "remove mine", "remove mine-sub", "repos"]);
    assert.equal(fs.existsSync(t.done), false);
    assert.deepEqual(t.branches(), ["feat/wip", "main"]);
  } finally {
    t.cleanup();
  }
});

test("gasho-daemon refuses changes before ending anything, a branch the worktree has not checked out, and stops at a session that does not end", async () => {
  const t = setup();
  const { calls, stays, session, run } = daemonFor(t);
  try {
    session("mine", t.wip, true);
    session("orca", t.wip, false);
    const head = t.commit(t.wip, "pr");
    fs.writeFileSync(path.join(t.wip, "new.txt"), "x");
    const refused = await run({ path: t.wip });
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.changes, { uncommitted: 1, unpushed: 1 });
    assert.deepEqual(calls, []);
    fs.rmSync(path.join(t.wip, "new.txt"));

    assert.match((await run({ path: t.wip, branch: "main" })).error, /checkout しているブランチではありません/);
    assert.match((await run({ path: t.repo })).error, /main の worktree/);

    stays.add("orca");
    const stuck = await run({ path: t.wip, pushed: [head] });
    assert.equal(stuck.ok, false);
    assert.match(stuck.error, /終了しませんでした。 worktree は削除していません。/);
    assert.deepEqual(calls, ["end orca"]);
    assert.equal(fs.existsSync(t.wip), true);

    stays.clear();
    const r = await run({ path: t.wip, pushed: [head] });
    assert.deepEqual(r, { ok: true, ended: ["orca", "mine"] });
    assert.equal(fs.existsSync(t.wip), false);
    // Without `branch`, the branch stays.
    assert.deepEqual(t.branches(), ["feat/done", "feat/wip", "main"]);
  } finally {
    t.cleanup();
  }
});

test("with force, gasho-daemon removes a worktree with changes", async () => {
  const t = setup();
  const { run } = daemonFor(t);
  try {
    t.commit(t.wip, "local");
    fs.writeFileSync(path.join(t.wip, "new.txt"), "x");
    assert.deepEqual(await run({ path: t.wip, branch: "feat/wip", force: true }), { ok: true, ended: [] });
    assert.equal(fs.existsSync(t.wip), false);
    assert.deepEqual(t.branches(), ["feat/done", "main"]);
  } finally {
    t.cleanup();
  }
});

test("through the control socket, worktree remove is the screen's removal and session remove takes away one whose folder is gone", async () => {
  const t = setup();
  const { d, calls, session } = daemonFor(t);
  fs.mkdirSync(path.join(t.dir, "state"));
  const file = controlSocketOf(path.join(t.dir, "state"));
  const server = await startControlServer(file, (req: ControlRequest) => d.onControl(req));
  const request = (req: ControlRequest, ms?: number) => controlRequest(file, req, ms);
  const out: string[] = [];
  const cli = { request, out: (s: string) => out.push(s) };
  const sessions = { request, readFile: async () => "", readStdin: async () => "", out: (s: string) => out.push(s), note: () => undefined };
  try {
    session("mine", t.wip, true, "wip-impl");
    session("orca", t.wip, false, "orca-review");
    fs.writeFileSync(path.join(t.wip, "new.txt"), "x");
    await assert.rejects(worktreeCommand(["remove", t.wip], cli), /未コミットの変更が 1 件あるため、削除していません/);
    assert.deepEqual(calls, []);
    assert.equal(fs.existsSync(t.wip), true);
    fs.rmSync(path.join(t.wip, "new.txt"));

    await worktreeCommand(["remove", t.wip], cli);
    assert.deepEqual(JSON.parse(out.pop()!), {
      path: t.wip,
      branch: "feat/wip",
      ended: [
        { sessionId: "orca", name: "orca-review" },
        { sessionId: "mine", name: "wip-impl" },
      ],
    });
    assert.deepEqual(calls, ["end orca", "remove mine", "repos"]);
    assert.equal(fs.existsSync(t.wip), false);
    // The branch stays, as from the screen.
    assert.deepEqual(t.branches(), ["feat/done", "feat/wip", "main"]);

    // A worktree removed with git: its session stays, and the list says its folder is gone.
    session("left", t.done, true, "done-impl");
    t.run(t.repo, "worktree", "remove", t.done);
    await assert.rejects(worktreeCommand(["remove", t.done], cli), /フォルダーがありません/);
    await sessionCommand(["list", "--json"], sessions);
    assert.deepEqual(JSON.parse(out.pop()!).map((s: { sessionId: string; cwdMissing?: boolean }) => [s.sessionId, s.cwdMissing]), [["left", true]]);
    await sessionCommand(["remove", "done-impl"], sessions);
    assert.deepEqual(JSON.parse(out.pop()!), { sessionId: "left", name: "done-impl", cwd: t.done });
    assert.equal(calls.at(-1), "remove left");
  } finally {
    server.close();
    t.cleanup();
  }
});
