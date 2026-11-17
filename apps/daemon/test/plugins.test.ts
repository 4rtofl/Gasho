import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DaemonToHub } from "@gasho/protocol";
import { Daemon } from "../src/daemon.ts";
import { GitHubProxy } from "../src/github.ts";
import { PluginRunner } from "../src/plugins.ts";

const V1 = `
export default {
  start(ctx) { globalThis.startedOn = ctx.machine.id; },
  methods: {
    echo: async (params, ctx) => ({
      params,
      settings: ctx.settings,
      machine: globalThis.startedOn,
      cwd: ctx.session?.cwd,
      app: ctx.session?.repo("app").dir,
    }),
    local: (params, ctx) => ({ folders: ctx.folders(), dataDir: ctx.dataDir }),
    outside: (params, ctx) => ctx.session.repo("../etc"),
    oops: () => { const e = new Error("見せてよい理由"); e.gashoPluginError = true; throw e; },
    crash: () => { throw new Error("secret detail"); },
    slow: (params, ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve("aborted"))),
    sh: async (params, ctx) => (await ctx.exec("echo", ["hi"])).stdout.trim(),
    missing: async (params, ctx) => { try { await ctx.exec("no-such-command-gasho", []); } catch (e) { return e.code; } },
    ghRead: async (params, ctx) => (await ctx.github.read(params.args)).stdout.trim(),
    ghWrite: async (params, ctx) => (await ctx.github.write(params.args, { repo: "o/n" })).stdout.trim(),
    ghFail: async (params, ctx) => { try { await ctx.github.read(["fail"]); } catch (e) { return { code: e.code, stderr: e.stderr.trim() }; } },
    version: () => 1,
  },
};
`;
const V2 = `export default { methods: { version: () => 2 } };`;
const V3 = `
export default {
  start(ctx) { ctx.emit("state", { up: true }, { retain: true }); },
  methods: {
    burst: (params, ctx) => { for (let i = 1; i <= 5; i++) ctx.emit("progress", { i }); ctx.emit("other", "x"); return "ok"; },
    big: (params, ctx) => ctx.emit("big", "a".repeat(300 * 1024)),
    noTopic: (params, ctx) => ctx.emit("", 1),
    cyclic: (params, ctx) => { const a = {}; a.a = a; ctx.emit("cyclic", a); },
  },
};
`;
// What it started outlives it unless its stop runs; stop writes "stopped" in its folder, after it logged and emitted
// (both fail once gasho-daemon is gone).
const STOPS = `
import fs from "node:fs";
import path from "node:path";
let ctx;
export default {
  start(c) { ctx = c; },
  async stop() {
    ctx.log("stopping");
    ctx.emit("state", "stopping");
    await new Promise((r) => setTimeout(r, 100));
    ctx.log("stopped");
    await new Promise((r) => setTimeout(r, 100));
    fs.writeFileSync(path.join(ctx.dataDir, "stopped"), String(process.pid));
  },
  methods: {
    slow: (params, c) => {
      c.log("slow begins");
      return new Promise((resolve) => c.signal.addEventListener("abort", () => resolve("aborted")));
    },
  },
};
`;
const HASH1 = "aaaaaaaaaaaaaaaa";
const HASH2 = "bbbbbbbbbbbbbbbb";
const HASH3 = "cccccccccccccccc";
const HASH4 = "dddddddddddddddd";

function setup(enabled = true, answerCode = true) {
  const sent: DaemonToHub[] = [];
  const logs: string[] = [];
  const codes: Record<string, string> = { [HASH1]: V1, [HASH2]: V2, [HASH3]: V3, [HASH4]: STOPS };
  let runner: PluginRunner;
  const local = { folders: ["/work"], dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "gasho-plugin-data-")) };
  // A gh that writes down each time it runs.
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-fake-gh-"));
  const ghBin = path.join(ghDir, "gh");
  fs.writeFileSync(ghBin, `#!/bin/sh\necho "$*" >> "${ghDir}/runs"\ncase "$*" in fail) echo boom >&2; exit 3;; esac\necho "gh $*"\n`, { mode: 0o755 });
  const ghRuns = () => (fs.existsSync(path.join(ghDir, "runs")) ? fs.readFileSync(path.join(ghDir, "runs"), "utf8").trim().split("\n") : []);
  const giveCode = (hash: string) => runner.onCode({ type: "plugin.code", plugin: "hello", hash, code: codes[hash] });
  const send = (m: DaemonToHub) => {
    sent.push(m);
    // The Gasho server hands over the code asked for.
    if (m.type === "plugin.code.get" && answerCode) setTimeout(() => giveCode(m.hash), 5);
  };
  runner = new PluginRunner({
    cacheDir: fs.mkdtempSync(path.join(os.tmpdir(), "gasho-daemon-plugins-")),
    send,
    machine: () => ({ id: "m1", name: "ubuntu" }),
    session: async (id) => (id === "s1" ? { sessionId: "s1", cwd: "/work/zen", managed: true, repos: [{ path: "app" }] } : undefined),
    folders: () => local.folders,
    dataDir: local.dataDir,
    github: new GitHubProxy({ ghBin }),
    enabled,
    log: (s) => logs.push(s),
  });
  const call = async (method: string, extra: { sessionId?: string; timeoutMs?: number; params?: unknown; write?: boolean } = {}) => {
    const requestId = `${method}-${Math.random()}`;
    await runner.request({ type: "plugin.request", requestId, plugin: "hello", method, timeoutMs: extra.timeoutMs ?? 10_000, ...extra });
    const r = sent.find((m) => m.type === "plugin.response" && m.requestId === requestId);
    assert.ok(r?.type === "plugin.response");
    return r;
  };
  const state = () => {
    const s = sent.filter((m) => m.type === "plugin.status").at(-1);
    return s?.type === "plugin.status" ? s.plugins.find((p) => p.id === "hello") : undefined;
  };
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(ok(), "timed out");
  };
  return { runner, sent, logs, call, state, until, local, ghRuns, giveCode };
}

test("a daemon part runs in a process of its own, gets its session and settings, and answers calls", async () => {
  const { runner, call, state, until, sent, local } = setup();
  try {
    runner.update([{ id: "hello", hash: HASH1, run: true, settings: { interval: 60 } }]);
    assert.ok(sent.some((m) => m.type === "plugin.code.get" && m.hash === HASH1));
    await until(() => state()?.state === "running");
    assert.equal(state()?.hash, HASH1);

    const echo = await call("echo", { sessionId: "s1", params: { a: 1 } });
    assert.deepEqual(echo.result, { params: { a: 1 }, settings: { interval: 60 }, machine: "m1", cwd: "/work/zen", app: "/work/zen/app" });
    assert.equal((await call("echo", { sessionId: "nope" })).error, "このセッションは見つかりません。");
    // A repository the daemon did not find is refused (the path comes from a browser).
    assert.equal((await call("outside", { sessionId: "s1" })).error, "このリポジトリは見つかりません。");
    assert.equal((await call("oops")).error, "見せてよい理由");
    assert.match((await call("crash")).error ?? "", /^処理に失敗しました/);
    assert.match((await call("nothing")).error ?? "", /nothing という処理はありません/);
    assert.equal((await call("sh")).result, "hi");
    assert.equal((await call("missing")).result, "ENOENT");
    assert.equal((await call("slow", { timeoutMs: 1000 })).error, "working server から応答がありません。");

    // Its own folder is made before it starts; the folders reach the running process when they change.
    const dataDir = path.join(local.dataDir, "hello");
    assert.deepEqual((await call("local")).result, { folders: ["/work"], dataDir });
    assert.ok(fs.statSync(dataDir).isDirectory());
    local.folders = ["/work", "/home/rg/repos"];
    runner.foldersChanged();
    assert.deepEqual((await call("local")).result, { folders: ["/work", "/home/rg/repos"], dataDir });
  } finally {
    await runner.stopAll();
  }
});

test("gasho-daemon runs gh for a daemon part: the same read again is answered without gh, and a write reads it again", async () => {
  const { runner, call, state, until, ghRuns } = setup();
  try {
    runner.update([{ id: "hello", hash: HASH1, run: true, settings: {} }]);
    await until(() => state()?.state === "running");
    const list = { args: ["pr", "list", "--repo", "o/n"] };
    assert.equal((await call("ghRead", { params: list })).result, "gh pr list --repo o/n");
    assert.equal((await call("ghRead", { params: list })).result, "gh pr list --repo o/n");
    assert.equal(ghRuns().length, 1);

    // Only a write method may change GitHub, so that the operations log has it.
    const assign = { args: ["issue", "edit", "1", "--repo", "o/n", "--add-assignee", "@me"] };
    assert.match((await call("ghWrite", { params: assign })).error ?? "", /kind が write のメソッド/);
    assert.equal(ghRuns().length, 1);
    assert.equal((await call("ghWrite", { params: assign, write: true })).result, "gh issue edit 1 --repo o/n --add-assignee @me");
    await call("ghRead", { params: list });
    assert.deepEqual(ghRuns(), ["pr list --repo o/n", "issue edit 1 --repo o/n --add-assignee @me", "pr list --repo o/n"]);

    // A failure reads as from ctx.exec, so that a plugin explains it as before.
    assert.deepEqual((await call("ghFail")).result, { code: 3, stderr: "boom" });
  } finally {
    await runner.stopAll();
  }
});

test("a new version replaces the old one (hot reload), and turning the plugin off stops it", async () => {
  const { runner, call, state, until } = setup();
  try {
    runner.update([{ id: "hello", hash: HASH1, run: true, settings: {} }]);
    await until(() => state()?.state === "running");
    assert.equal((await call("version")).result, 1);
    runner.update([{ id: "hello", hash: HASH2, run: true, settings: {} }]);
    await until(() => state()?.hash === HASH2);
    assert.equal((await call("version")).result, 2);
    runner.update([{ id: "hello", hash: HASH2, run: false, settings: {} }]);
    assert.equal(state()?.state, "off");
    assert.equal((await call("version")).error, "このプラグインは、この working server では動いていません。");
  } finally {
    await runner.stopAll();
  }
});

test("a daemon part's events go to the Gasho server, at most once a second for each topic", async () => {
  const { runner, call, state, until, sent } = setup();
  const events = (topic?: string) => sent.filter((m) => m.type === "plugin.event" && (topic === undefined || m.topic === topic));
  try {
    runner.update([{ id: "hello", hash: HASH3, run: true, settings: {} }]);
    await until(() => state()?.state === "running");
    // From start already: what it watches, kept by the Gasho server for browsers that connect later.
    assert.deepEqual(events("state"), [{ type: "plugin.event", plugin: "hello", topic: "state", data: { up: true }, retain: true }]);

    // Five at once: the first now, the last when the second is over; another topic does not wait for this one.
    const t0 = Date.now();
    assert.equal((await call("burst")).result, "ok");
    assert.deepEqual(events("progress").map((m) => (m.type === "plugin.event" ? m.data : undefined)), [{ i: 1 }]);
    assert.equal(events("other").length, 1);
    await until(() => events("progress").length === 2);
    assert.ok(Date.now() - t0 >= 900);
    assert.deepEqual(events("progress").at(-1), { type: "plugin.event", plugin: "hello", topic: "progress", data: { i: 5 } });
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(events("progress").length, 2);

    // What is not right is the plugin's error, and nothing is sent.
    assert.match((await call("big")).error ?? "", /大きすぎます（256KB まで）/);
    assert.match((await call("noTopic")).error ?? "", /topic/);
    assert.match((await call("cyclic")).error ?? "", /JSON にできません/);
    assert.equal(events("big").length + events("cyclic").length, 0);

    // A plugin that stops tells nothing more: an event waiting for its turn is dropped.
    await call("burst");
    await call("burst");
    const before = events("progress").length;
    runner.update([{ id: "hello", hash: HASH3, run: false, settings: {} }]);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(events("progress").length, before);
  } finally {
    await runner.stopAll();
  }
});

test("the code of a version is asked for once while it comes, and again after reconnecting", async () => {
  const { runner, sent, state, until, giveCode } = setup(true, false);
  const asks = () => sent.filter((m) => m.type === "plugin.code.get").length;
  const entry = { id: "hello", hash: HASH1, run: true, settings: {} };
  try {
    runner.update([entry]);
    // The list again while the code comes (another plugin changed): the ask on its way is waited for.
    runner.update([entry]);
    assert.equal(asks(), 1);
    // An answer on its way is lost with the old connection.
    runner.connected();
    assert.equal(asks(), 2);
    giveCode(HASH1);
    giveCode(HASH1);
    await until(() => state()?.state === "running");
    assert.equal(asks(), 2);
  } finally {
    await runner.stopAll();
  }
});

test("with GASHO_PLUGINS=none no daemon part runs", async () => {
  const { runner, call, state, sent } = setup(false);
  runner.update([{ id: "hello", hash: HASH1, run: true, settings: {} }]);
  assert.equal(state()?.state, "off");
  assert.ok(!sent.some((m) => m.type === "plugin.code.get"));
  assert.match((await call("version")).error ?? "", /GASHO_PLUGINS/);
  await runner.stopAll();
});

test("when gasho-daemon stops, each daemon part runs its stop at once, without waiting for its calls, and none starts again", async () => {
  const { runner, call, state, until, local, logs, sent } = setup();
  try {
    runner.update([{ id: "hello", hash: HASH4, run: true, settings: {} }]);
    await until(() => state()?.state === "running");
    const slow = call("slow", { timeoutMs: 60_000 });
    await until(() => logs.includes("plugin hello: slow begins"));
    const at = Date.now();
    await runner.stopAll();
    // A hot reload would wait for the call (up to 60 s here); the bound leaves room for a busy machine.
    assert.ok(Date.now() - at < 20_000);
    assert.ok(fs.existsSync(path.join(local.dataDir, "hello", "stopped")));
    assert.equal((await slow).result, "aborted");

    // The Gasho server's list may still come while gasho-daemon ends.
    runner.update([{ id: "hello", hash: HASH1, run: true, settings: {} }]);
    assert.ok(!sent.some((m) => m.type === "plugin.code.get" && m.hash === HASH1));
    assert.equal(state()?.state, "stopped");
  } finally {
    await runner.stopAll();
  }
});

test("a daemon part runs its stop when gasho-daemon is gone or sends SIGTERM, and ends after 5 seconds when stop does not", async () => {
  const host = path.resolve(import.meta.dirname, "../src/plugin-host.ts");
  const run = async (code: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-plugin-host-"));
    const file = path.join(dir, "daemon.mjs");
    fs.writeFileSync(file, code);
    const child = fork(host, [file], { stdio: ["ignore", "pipe", "pipe", "ipc"], serialization: "json" });
    const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
    const ready = new Promise<void>((resolve, reject) => child.on("message", (m: { t: string; error?: string }) => (m.t === "ready" ? resolve() : m.t === "failed" ? reject(new Error(m.error)) : undefined)));
    child.send({ t: "init", plugin: "hello", machine: { id: "m1", name: "ubuntu" }, settings: {}, local: { folders: [], dataDir: dir } });
    await ready;
    return { child, exited, stopped: () => fs.existsSync(path.join(dir, "stopped")) };
  };

  // gasho-daemon ended without a word (it crashed, or was killed): its IPC channel and pipes close.
  const gone = await run(STOPS);
  gone.child.stdout?.destroy();
  gone.child.stderr?.destroy();
  gone.child.disconnect();
  assert.equal(await gone.exited, 0);
  assert.ok(gone.stopped());

  // systemd stops a service by sending SIGTERM to all of its processes at once.
  const term = await run(STOPS);
  term.child.kill("SIGTERM");
  assert.equal(await term.exited, 0);
  assert.ok(term.stopped());

  // A stop that never ends, and keeps the process busy: it would run on after gasho-daemon for good.
  const stuck = await run(`export default { stop: () => new Promise(() => setInterval(() => {}, 1000)), methods: {} };`);
  const at = Date.now();
  stuck.child.disconnect();
  assert.equal(await stuck.exited, 0);
  assert.ok(Date.now() - at < 15_000);
});

test("gasho-daemon ends (an update, a signal) only once its plugins' daemon parts have stopped", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-daemon-exit-"));
  const dataDir = path.join(dir, "plugin-data");
  const d = new Daemon({
    hubUrl: "ws://127.0.0.1:1",
    machineId: "m",
    token: "t",
    hookPort: 0,
    hookSecret: undefined,
    claudeDir: path.join(dir, "claude-dir"),
    claudeBin: "claude",
    ghBin: "gh",
    pollIntervalMs: 60_000,
    stateDir: dir,
    attachmentsDir: path.join(dir, "attachments"),
    pluginCacheDir: path.join(dir, "plugin-cache"),
    pluginDataDir: dataDir,
    runPlugins: true,
  }) as unknown as Record<string, any>;
  let running = false;
  d.hub = {
    connected: true,
    send: (m: DaemonToHub) => {
      if (m.type === "plugin.code.get") setTimeout(() => void d.onHubMessage({ type: "plugin.code", plugin: m.plugin, hash: m.hash, code: STOPS }), 5);
      if (m.type === "plugin.status") running = m.plugins.some((p) => p.state === "running");
    },
  };
  try {
    await d.onHubMessage({ type: "plugins", plugins: [{ id: "hello", hash: HASH4, run: true, settings: {} }] });
    // A daemon part may take its 10 s to start on a busy machine.
    await t.waitFor(() => assert.ok(running), { interval: 10, timeout: 15_000 });

    const exits: { code: number; stopped: boolean }[] = [];
    t.mock.method(process, "exit", ((code: number) => {
      exits.push({ code, stopped: fs.existsSync(path.join(dataDir, "hello", "stopped")) });
    }) as typeof process.exit);
    await Promise.all([d.exit(75), d.exit(0)]);
    assert.deepEqual(exits, [{ code: 75, stopped: true }]);
  } finally {
    await d.plugins.stopAll();
  }
});
