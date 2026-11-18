// The local control socket and `gasho-daemon session launch/send/list`: requests over the socket reach the daemon's
// own commands (Daemon.launch, input, rename, as from the Gasho server), a launch names the session as Claude Code
// lists it, and a daemon that does not run gives an error that says what to do. Against a fake terminal and a fake
// `claude agents` (no claude).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  type ControlReply,
  type ControlRequest,
  type ControlSession,
  controlRequest,
  controlSocketOf,
  DaemonNotRunning,
  parseRequest,
  pick,
  sessionCommand,
  type SessionCliIO,
  startControlServer,
  worktreeCommand,
} from "../src/control.ts";
import { Daemon } from "../src/daemon.ts";
import { plainScreen } from "../src/managed.ts";

const SID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

async function tmp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-ctl-"));
  return { dir, done: () => fs.rm(dir, { recursive: true, force: true }) };
}

function io(request: (req: ControlRequest) => Promise<ControlReply>, extra: Partial<SessionCliIO> = {}) {
  const out: string[] = [];
  const notes: string[] = [];
  const value: SessionCliIO = {
    request,
    readFile: async (f) => `file:${f}`,
    readStdin: async () => "from stdin",
    out: (s) => out.push(s),
    note: (s) => notes.push(s),
    sleep: async () => undefined,
    ...extra,
  };
  return { io: value, out, notes };
}

test("the control socket answers one JSON line per request, only for its owner, and checks what it is sent", async () => {
  const { dir, done } = await tmp();
  const file = controlSocketOf(dir);
  const seen: ControlRequest[] = [];
  const server = await startControlServer(file, async (req) => {
    seen.push(req);
    return { ok: true, sessionId: "s1" };
  });
  try {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await controlRequest(file, { op: "session.launch", cwd: "/x", name: "n", trust: true }), { ok: true, sessionId: "s1" });
    assert.deepEqual(seen, [{ op: "session.launch", cwd: "/x", name: "n", trust: true }]);
    const bad = await controlRequest(file, { op: "session.input", sessionId: "s" } as unknown as ControlRequest);
    assert.equal(bad.ok, false);
    assert.match(bad.error ?? "", /text must be a string/);
    assert.equal((await controlRequest(file, { op: "nope" } as unknown as ControlRequest)).ok, false);
    assert.equal(seen.length, 1);
    // Another daemon with the same state folder does not take the socket over.
    await assert.rejects(startControlServer(file, async () => ({ ok: true })), /another gasho-daemon answers/);
  } finally {
    server.close();
    await done();
  }
});

test("a socket left behind by a daemon that ended is replaced", async () => {
  const { dir, done } = await tmp();
  const file = controlSocketOf(dir);
  // A daemon killed while it listened leaves its socket file, which nobody answers on.
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(file)}, () => console.log("up"))`], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  await once(child.stdout, "data");
  child.kill("SIGKILL");
  await once(child, "exit");
  assert.ok((await fs.stat(file)).isSocket());
  const server = await startControlServer(file, async () => ({ ok: true, sessions: [] }));
  try {
    assert.deepEqual(await controlRequest(file, { op: "session.list" }), { ok: true, sessions: [] });
  } finally {
    server.close();
    await done();
  }
});

test("when the daemon does not run, the session commands say so and what to do", async () => {
  const { dir, done } = await tmp();
  const file = controlSocketOf(dir);
  try {
    await assert.rejects(controlRequest(file, { op: "session.list" }), (e: Error) => e instanceof DaemonNotRunning && /gasho-daemon is not running/.test(e.message));
    const { io: cli } = io((req) => controlRequest(file, req));
    for (const args of [["list"], ["launch", "--cwd", dir], ["send", "x", "--text", "hi"], ["remove", "x"]]) {
      await assert.rejects(sessionCommand(args, cli), /not running: nothing answers on .*control\.sock[\s\S]*gasho-daemon run/);
    }
    await assert.rejects(
      worktreeCommand(["remove", dir], { request: (req, ms) => controlRequest(file, req, ms), out: () => undefined }),
      /not running: nothing answers on/,
    );
  } finally {
    await done();
  }
});

test("parseRequest keeps only the fields of each op", () => {
  assert.deepEqual(parseRequest({ op: "session.launch", cwd: "/a", trust: "yes", extra: 1 }), { op: "session.launch", cwd: "/a" });
  assert.deepEqual(parseRequest({ op: "session.list", x: 1 }), { op: "session.list" });
  assert.throws(() => parseRequest({ op: "session.rename", sessionId: "s" }), /name must be a string/);
  assert.throws(() => parseRequest(null), /unknown op/);
  assert.deepEqual(parseRequest({ op: "session.remove", sessionId: "s", force: true }), { op: "session.remove", sessionId: "s" });
  assert.throws(() => parseRequest({ op: "session.remove" }), /sessionId must be a string/);
  assert.deepEqual(parseRequest({ op: "worktree.remove", path: "/w", force: true, branch: "b", pushed: ["x"] }), { op: "worktree.remove", path: "/w", force: true });
  assert.deepEqual(parseRequest({ op: "worktree.remove", path: "/w", force: "yes" }), { op: "worktree.remove", path: "/w" });
  assert.throws(() => parseRequest({ op: "worktree.remove", path: 1 }), /path must be a string/);
});

/** A daemon as the control socket sees it: sessions with the names Claude Code lists, and a launch. */
function fakeDaemon(o: { listedAs: string; renameShows?: boolean }) {
  const calls: ControlRequest[] = [];
  let session: ControlSession | undefined;
  const request = async (req: ControlRequest): Promise<ControlReply> => {
    calls.push(req);
    switch (req.op) {
      case "session.launch":
        session = { sessionId: SID, name: o.listedAs, ...(req.name ? { gashoName: req.name } : {}), cwd: req.cwd, terminal: "gasho-x-1234", status: "idle" };
        return { ok: true, sessionId: SID };
      case "session.rename":
        if (session && o.renameShows !== false) session = { ...session, name: req.name, gashoName: undefined };
        return { ok: true, queued: false };
      case "session.input":
        return req.sessionId === SID ? { ok: true, queued: false } : { ok: false, error: "no such session" };
      case "session.list":
        return { ok: true, sessions: session ? [JSON.parse(JSON.stringify(session)) as ControlSession] : [] };
      default:
        return { ok: false, error: `unexpected ${req.op}` };
    }
  };
  return { calls, request };
}

test("launch with a name renames the session first, waits until Claude Code lists it so, then types the prompt", async () => {
  const f = fakeDaemon({ listedAs: "worktree-ab" });
  const { io: cli, out } = io(f.request);
  await sessionCommand(["launch", "--cwd", "/repo/wt", "--name", "impl-79", "--trust", "--prompt", "do #79"], cli);
  assert.deepEqual(
    f.calls.map((c) => c.op),
    ["session.launch", "session.list", "session.rename", "session.list", "session.input"],
  );
  assert.deepEqual(f.calls[0], { op: "session.launch", cwd: "/repo/wt", name: "impl-79", trust: true });
  assert.deepEqual(f.calls[4], { op: "session.input", sessionId: SID, text: "do #79" });
  assert.deepEqual(JSON.parse(out.join("\n")), { sessionId: SID, name: "impl-79", cwd: "/repo/wt", terminal: "gasho-x-1234" });
});

test("launch without a name gives the name Claude Code lists, and a prompt can come from a file or standard input", async () => {
  for (const [flags, text] of [
    [["--prompt-file", "p.md"], "file:p.md"],
    [["--prompt", "-"], "from stdin"],
  ] as const) {
    const f = fakeDaemon({ listedAs: "wt-9f" });
    const { io: cli, out } = io(f.request);
    await sessionCommand(["launch", "--cwd", "/repo/wt", ...flags], cli);
    assert.deepEqual(f.calls.map((c) => c.op), ["session.launch", "session.list", "session.input"]);
    assert.deepEqual(f.calls[2], { op: "session.input", sessionId: SID, text });
    assert.equal(JSON.parse(out.join("\n")).name, "wt-9f");
  }
});

test("a rename Claude Code does not show in time leaves a warning and the name it still lists", async () => {
  const f = fakeDaemon({ listedAs: "wt-9f", renameShows: false });
  let now = 0;
  const { io: cli, out } = io(f.request, { renameWaitMs: 0, sleep: async () => void (now += 1) });
  await sessionCommand(["launch", "--cwd", "/repo/wt", "--name", "impl"], cli);
  const r = JSON.parse(out.join("\n"));
  assert.equal(r.name, "wt-9f");
  assert.match(r.warning, /does not list the session as "impl" yet/);
});

test("a launch that fails says why, and nothing is typed", async () => {
  const calls: string[] = [];
  const { io: cli } = io(async (req) => {
    calls.push(req.op);
    return { ok: false, error: "このフォルダーは、まだ Claude Code に信頼されていません。", needsTrust: true };
  });
  await assert.rejects(sessionCommand(["launch", "--cwd", "/x", "--prompt", "hi"], cli), /信頼されていません/);
  assert.deepEqual(calls, ["session.launch"]);
  await assert.rejects(sessionCommand(["launch"], cli), /needs --cwd/);
  await assert.rejects(sessionCommand(["launch", "--cwd", "/x", "--prompt", "a", "--prompt-file", "b"], cli), /only once/);
});

test("send finds the session by the name Claude Code lists, its Gasho name or its id", async () => {
  const sessions: ControlSession[] = [
    { sessionId: "id-1", name: "impl-79", cwd: "/a", terminal: "t1", status: "idle" },
    { sessionId: "id-2", name: "wt-ab", gashoName: "review", cwd: "/b", terminal: "t2", status: "busy" },
  ];
  const sent: ControlRequest[] = [];
  const { io: cli, out } = io(async (req) => {
    if (req.op === "session.list") return { ok: true, sessions };
    sent.push(req);
    return { ok: true, queued: req.op === "session.input" && req.sessionId === "id-2" };
  });
  await sessionCommand(["send", "impl-79", "--text", "hello"], cli);
  await sessionCommand(["send", "review", "--file", "msg.txt"], cli);
  await sessionCommand(["send", "id-2", "-"], cli);
  assert.deepEqual(sent, [
    { op: "session.input", sessionId: "id-1", text: "hello" },
    { op: "session.input", sessionId: "id-2", text: "file:msg.txt" },
    { op: "session.input", sessionId: "id-2", text: "from stdin" },
  ]);
  assert.deepEqual(JSON.parse(out[1]!), { sessionId: "id-2", name: "wt-ab", queued: true });
  await assert.rejects(sessionCommand(["send", "nobody", "--text", "x"], cli), /no session started by Gasho is named "nobody"/);
  await assert.rejects(sessionCommand(["send", "impl-79"], cli), /needs --text/);
  assert.throws(() => pick([...sessions, { ...sessions[0]!, sessionId: "id-3" }], "impl-79"), /2 sessions are named/);
});

test("list prints one line per session, or JSON", async () => {
  const sessions: ControlSession[] = [{ sessionId: "id-1", name: "impl-79", cwd: "/a", terminal: "t1", status: "idle" }];
  const { io: cli, out } = io(async () => ({ ok: true, sessions }));
  await sessionCommand(["list"], cli);
  await sessionCommand(["list", "--json"], cli);
  assert.equal(out[0], "impl-79\tidle\t/a\tid-1");
  assert.deepEqual(JSON.parse(out[1]!), sessions);
  const empty = io(async () => ({ ok: true, sessions: [] }));
  await sessionCommand(["list"], empty.io);
  assert.match(empty.out[0]!, /no sessions/);
  // A session whose folder is gone says so.
  const gone: ControlSession[] = [{ ...sessions[0]!, cwdMissing: true }];
  const missing = io(async () => ({ ok: true, sessions: gone }));
  await sessionCommand(["list"], missing.io);
  await sessionCommand(["list", "--json"], missing.io);
  assert.equal(missing.out[0], "impl-79\tidle\t/a\tid-1\t(folder missing)");
  assert.equal(JSON.parse(missing.out[1]!)[0].cwdMissing, true);
});

test("session remove finds the session as send does, removes it by its id, and says why when the daemon refuses", async () => {
  const sessions: ControlSession[] = [
    { sessionId: "id-1", name: "impl-79", cwd: "/gone", terminal: "t1", status: "idle", cwdMissing: true },
    { sessionId: "id-2", name: "wt-ab", gashoName: "review", cwd: "/b", terminal: "t2", status: "busy" },
  ];
  const sent: ControlRequest[] = [];
  const { io: cli, out } = io(async (req) => {
    if (req.op === "session.list") return { ok: true, sessions };
    sent.push(req);
    return req.op === "session.remove" && req.sessionId === "id-2" ? { ok: false, error: "削除できません。" } : { ok: true };
  });
  await sessionCommand(["remove", "impl-79"], cli);
  assert.deepEqual(sent, [{ op: "session.remove", sessionId: "id-1" }]);
  assert.deepEqual(JSON.parse(out[0]!), { sessionId: "id-1", name: "impl-79", cwd: "/gone" });
  await assert.rejects(sessionCommand(["remove", "review"], cli), /削除できません。/);
  await assert.rejects(sessionCommand(["remove", "nobody"], cli), /no session started by Gasho is named "nobody"/);
  await assert.rejects(sessionCommand(["remove"], cli), /needs the session's name or id/);
  assert.equal(sent.length, 2);
});

test("worktree remove sends the folder as an absolute path, waits long enough, and prints what it removed or why not", async () => {
  const sent: { req: ControlRequest; timeoutMs?: number }[] = [];
  const out: string[] = [];
  let answer: ControlReply = {
    ok: true,
    ended: ["id-1"],
    path: "/repo-wt/79",
    branch: "feat/79",
    endedSessions: [{ sessionId: "id-1", name: "impl-79" }],
  };
  const cli = {
    request: async (req: ControlRequest, timeoutMs?: number) => {
      sent.push({ req, timeoutMs });
      return answer;
    },
    out: (s: string) => out.push(s),
    resolve: (p: string) => path.resolve("/here", p),
  };
  await worktreeCommand(["remove", "79"], cli);
  await worktreeCommand(["remove", "--force", "/repo-wt/79"], cli);
  assert.deepEqual(
    sent.map((s) => s.req),
    [
      { op: "worktree.remove", path: "/here/79" },
      { op: "worktree.remove", path: "/repo-wt/79", force: true },
    ],
  );
  assert.ok((sent[0]!.timeoutMs ?? 0) >= 160_000);
  assert.deepEqual(JSON.parse(out[0]!), { path: "/repo-wt/79", branch: "feat/79", ended: [{ sessionId: "id-1", name: "impl-79" }] });

  answer = { ok: false, error: "この worktree には未コミットの変更が 2 件あるため、削除していません。", changes: { uncommitted: 2, unpushed: 0 } };
  await assert.rejects(worktreeCommand(["remove", "/repo-wt/79"], cli), /未コミットの変更が 2 件/);
  answer = { ok: false, error: "終了できないセッションがあるため、worktree は削除していません：id-2", endedSessions: [{ sessionId: "id-1", name: "impl-79" }] };
  await assert.rejects(worktreeCommand(["remove", "/repo-wt/79"], cli), /終了できないセッション[\s\S]*ended meanwhile: impl-79/);

  const before = sent.length;
  await assert.rejects(worktreeCommand(["remove"], cli), /needs one folder/);
  await assert.rejects(worktreeCommand(["remove", "a", "b"], cli), /needs one folder/);
  await assert.rejects(worktreeCommand(["remove", "a", "--branch"], cli), /does not take --branch/);
  await assert.rejects(worktreeCommand(["list"], cli), /usage:[\s\S]*worktree remove/);
  assert.equal(sent.length, before);
});

const REPL = ["─".repeat(50), "❯ ", "─".repeat(50), ""].join("\n");

test("through the socket, a launch is Daemon.launch, and the rename and the prompt wait on its input queue in that order", async () => {
  const { dir, done } = await tmp();
  const agentsFile = path.join(dir, "agents.json");
  writeFileSync(agentsFile, "[]");
  const claude = path.join(dir, "claude");
  await fs.writeFile(claude, `#!/bin/sh\ncat '${agentsFile}'\n`, { mode: 0o755 });
  const folder = path.join(dir, "wt");
  await fs.mkdir(folder);
  // Claude Code lists a new session under a name of its own, whatever --remote-control was given.
  const agents = (name: string) => writeFileSync(agentsFile, JSON.stringify([{ pid: process.pid, sessionId: SID, cwd: folder, name, status: "idle" }]));
  const d = new Daemon({
    hubUrl: "ws://127.0.0.1:1",
    machineId: "m",
    token: "t",
    hookPort: 0,
    claudeDir: path.join(dir, "claude-dir"),
    claudeBin: claude,
    ghBin: "gh",
    pollIntervalMs: 60_000,
    stateDir: dir,
    attachmentsDir: path.join(dir, "attachments"),
    claudeTmpDir: path.join(dir, "claude-tmp"),
    pluginDataDir: path.join(dir, "plugin-data"),
  } as ConstructorParameters<typeof Daemon>[0]) as unknown as Record<string, any>;
  d.canLaunch = true;
  const started: { args: string[] }[] = [];
  d.terminals = {
    start: async (o: { args: string[] }) => {
      started.push(o);
      agents("wt-3c");
      return process.pid;
    },
    screen: async () => plainScreen(REPL),
    keys: async () => undefined,
    kill: async () => undefined,
  };
  d.refreshFolders = async () => undefined;
  d.readManagedScreens = async () => undefined;
  d.countTokens = async () => undefined;
  d.hub = { connected: false, send: () => undefined };
  // Nothing is typed here: the inputs stay on the queue, where the daemon types them from once the session is idle.
  d.flushInput = async () => undefined;
  const rename = d.rename.bind(d);
  d.rename = async (sessionId: string, name: string, requestId: string) => {
    const r = await rename(sessionId, name, requestId);
    agents(name);
    return r;
  };
  const file = controlSocketOf(dir);
  const server = await startControlServer(file, (req) => d.onControl(req));
  try {
    const { io: cli, out } = io((req) => controlRequest(file, req));
    await sessionCommand(["launch", "--cwd", folder, "--name", "impl-79", "--prompt", "Issue #79 を実装して"], cli);
    assert.deepEqual(started[0]!.args.slice(0, 2), ["--remote-control", "impl-79"]);
    const r = JSON.parse(out.join("\n"));
    assert.equal(r.sessionId, SID);
    assert.equal(r.name, "impl-79");
    assert.equal(r.cwd, folder);
    assert.match(r.terminal, /^gasho-impl-79-[0-9a-f]{4}$/);
    assert.deepEqual(
      d.managed.waiting(SID).map((i: { text: string }) => i.text),
      ["/rename impl-79", "Issue #79 を実装して"],
    );
    // The list shows the name Claude Code lists, with Gasho's when it differs.
    agents("wt-3c");
    const listed = io((req) => controlRequest(file, req));
    await sessionCommand(["list", "--json"], listed.io);
    assert.deepEqual(JSON.parse(listed.out[0]!), [
      { sessionId: SID, name: "wt-3c", gashoName: "impl-79", cwd: folder, terminal: r.terminal, status: "idle", pendingInputs: 2 },
    ]);
    // Only sessions Gasho started take input, as from the Gasho server.
    const refused = await controlRequest(file, { op: "session.input", sessionId: "other", text: "x" });
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? "", /Gasho が起動したセッションだけ/);
  } finally {
    server.close();
    await done();
  }
});
