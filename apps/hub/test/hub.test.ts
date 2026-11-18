import assert from "node:assert/strict";
import { test } from "node:test";
import type { HubToClient, HubToDaemon, MachineHookEvent, ServerInfo, SessionInfo } from "@gasho/protocol";
import {
  CLOSE_INVALID_CREDENTIALS,
  CLOSE_UNAUTHORIZED,
  Hub,
  legacyFeatures,
  MAX_FILES_BYTES,
  MAX_WRITE_BYTES,
  type ServerSource,
  UPDATING,
  validateCommand,
} from "../src/hub.ts";
import { notificationFor } from "../src/notify.ts";
import { Store } from "../src/store.ts";

function fakePeer<T>(deviceId = "") {
  const peer = {
    deviceId,
    machineId: undefined as string | undefined,
    sent: [] as T[],
    closed: undefined as [number, string] | undefined,
    send(m: T) {
      peer.sent.push(m);
    },
    close(code: number, reason: string) {
      peer.closed = [code, reason];
    },
  };
  return peer;
}

function setup() {
  const store = new Store(":memory:");
  const machine = store.createDevice("machine", "ubuntu");
  const browser = store.createDevice("browser", "iPhone");
  const hub = new Hub(store);
  return { store, hub, machineId: machine.device.id, machineToken: machine.token, browserId: browser.device.id };
}

const session: SessionInfo = {
  sessionId: "s1",
  cwd: "/home/rg/repos/Bobert",
  title: "プラグインの整理",
  status: "idle",
  rcMode: "server",
  prLinks: [],
  managed: true,
};

test("a daemon with a wrong token, or with a browser's id, is closed", () => {
  const { hub, machineId, browserId, store } = setup();
  const browserToken = store.createDevice("browser", "x").token;
  const d1 = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d1, { type: "hello", machineId, token: "wrong", daemonVersion: "0.1.0" });
  assert.equal(d1.closed?.[0], CLOSE_INVALID_CREDENTIALS);
  const d2 = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d2, { type: "hello", machineId: browserId, token: browserToken, daemonVersion: "0.1.0" });
  assert.equal(d2.closed?.[0], CLOSE_INVALID_CREDENTIALS);
  assert.equal(d1.sent.length + d2.sent.length, 0);
});

test("sessions and hooks reach the browser, and Stop becomes a notification", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  assert.equal(c.sent[0]?.type, "snapshot");

  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.1.0" });
  assert.deepEqual(d.sent, [{ type: "welcome" }]);
  hub.onDaemonMessage(d, { type: "sessions", sessions: [session] });
  hub.onDaemonMessage(d, { type: "hook", event: { sessionId: "s1", event: "Stop", at: 1000, summary: "終わりました" } });

  assert.deepEqual(
    c.sent.map((m) => m.type),
    ["snapshot", "machine", "machine", "event", "notification"],
  );
  const first = c.sent[1];
  assert.ok(first?.type === "machine");
  assert.equal(first.machine.id, machineId);
  assert.equal(first.machine.name, "ubuntu");
  const n = c.sent.at(-1);
  assert.ok(n?.type === "notification");
  assert.equal(n.notification.title, "プラグインの整理 の応答が終わりました");
  assert.equal(n.notification.machine, machineId);

  hub.onDaemonClose(d);
  const last = c.sent.at(-1);
  assert.ok(last?.type === "machine" && last.machine.connected === false);
});

test("the snapshot sends the operations apart from the hooks of tools, which outnumber them", () => {
  const { hub, store, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.2.0" });
  const asking = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(asking);
  hub.onClientMessage(asking, { type: "session.input", requestId: "a", machine: machineId, sessionId: "s1", text: "直して" });
  for (let i = 0; i < 300; i++) {
    hub.onDaemonMessage(d, { type: "hook", event: { sessionId: "s1", event: i % 2 ? "PostToolUse" : "PreToolUse", at: Date.now(), toolName: "Bash" } });
  }
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const snap = c.sent[0];
  assert.ok(snap?.type === "snapshot");
  assert.ok(!snap.events.some((e) => e.event === "Gasho:session.input"));
  assert.deepEqual(snap.operations?.map((e) => e.event), ["Gasho:session.input"]);

  // Those of the last 48 hours; the latest 20 when fewer.
  const now = Date.now();
  const op = (at: number): MachineHookEvent => ({ machine: machineId, sessionId: "", event: "Gasho:folder.create", at, summary: "/tmp/x" });
  const older = new Store(":memory:");
  for (let i = 0; i < 25; i++) older.addEvent(op(now - 72 * 3600_000 + i));
  assert.deepEqual(
    older.recentOperations(now).map((e) => e.at),
    Array.from({ length: 20 }, (_, i) => now - 72 * 3600_000 + 5 + i),
  );
  for (let i = 0; i < 5; i++) store.addEvent(op(now - 72 * 3600_000 + i));
  for (let i = 0; i < 30; i++) store.addEvent(op(now - 3600_000 + i));
  const recent = store.recentOperations(now);
  assert.equal(recent.length, 31);
  assert.ok(recent.every((e) => e.at >= now - 48 * 3600_000));
});

test("transcript.get is relayed to the daemon and the page goes back to the asking browser", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.1.0" });
  const asking = fakePeer<HubToClient>(browserId);
  const other = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(asking);
  hub.onClientConnect(other);
  hub.onClientMessage(asking, { type: "transcript.get", machine: machineId, sessionId: "s1", limit: 50 });
  const req = d.sent.at(-1);
  assert.ok(req?.type === "transcript.get");
  hub.onDaemonMessage(d, {
    type: "transcript.page",
    requestId: req.requestId,
    sessionId: "s1",
    entries: [{ uuid: "u1", role: "user", blocks: [{ type: "text", text: "hi" }] }],
    start: 0,
    total: 1,
  });
  const page = asking.sent.at(-1);
  assert.ok(page?.type === "transcript.page");
  assert.equal(page.machine, machineId);
  assert.equal(page.entries.length, 1);
  assert.ok(!other.sent.some((m) => m.type === "transcript.page"));
});

test("transcript.get for an offline machine answers with an error", () => {
  const { hub, machineId, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  hub.onClientMessage(c, { type: "transcript.get", machine: machineId, sessionId: "s1", limit: 50 });
  const page = c.sent.at(-1);
  assert.ok(page?.type === "transcript.page");
  assert.equal(page.error, "working server がオフラインです。");
});

test("revoking a machine disconnects it, fails the commands under way on it, and removes it from browsers", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.1.0" });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  hub.onClientMessage(c, { type: "session.input", requestId: "a", machine: machineId, sessionId: "s1", text: "テスト" });
  assert.equal(d.sent.at(-1)?.type, "session.input");
  hub.onClientMessage(c, { type: "git.graph.get", machine: machineId, sessionId: "s1" });
  assert.equal(hub.revokeDevice(machineId), true);
  assert.equal(d.closed?.[0], CLOSE_INVALID_CREDENTIALS);
  hub.onDaemonClose(d); // as the socket's close follows
  assert.equal(hub.inFlight(), 0);
  assert.deepEqual(c.sent.at(-2), {
    type: "command.result",
    requestId: "a",
    machine: machineId,
    result: { ok: false, error: "working server の登録が外されました。" },
  });
  const graph = c.sent.find((m) => m.type === "git.graph");
  assert.ok(graph?.type === "git.graph" && !graph.graph);
  assert.equal(graph.error, "working server の登録が外されました。");
  assert.deepEqual(c.sent.at(-1), { type: "machine.removed", id: machineId });
  assert.equal(hub.revokeDevice(machineId), false);
});

test("renaming a machine is broadcast", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  hub.onDaemonMessage(fakePeer<HubToDaemon>(), { type: "hello", machineId, token: machineToken, daemonVersion: "0.1.0" });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  assert.equal(hub.renameDevice(machineId, "Ubuntu Server"), true);
  const m = c.sent.at(-1);
  assert.ok(m?.type === "machine" && m.machine.name === "Ubuntu Server");
});

test("browsers revoked from the command line are disconnected by checkRevocations", () => {
  const { hub, store, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  store.revokeDevice(browserId); // what `cli.ts revoke` does in another process
  hub.checkRevocations();
  assert.equal(c.closed?.[0], CLOSE_UNAUTHORIZED);
});

test("an offline machine revoked from the command line is taken off browsers by checkRevocations", () => {
  const { hub, store, machineId, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const snap = c.sent[0];
  assert.ok(snap?.type === "snapshot" && snap.machines.some((m) => m.id === machineId && !m.connected));
  store.revokeDevice(machineId);
  hub.checkRevocations();
  assert.deepEqual(c.sent.at(-1), { type: "machine.removed", id: machineId });
  const later = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(later);
  const again = later.sent[0];
  assert.ok(again?.type === "snapshot");
  assert.deepEqual(again.machines, []);
});

test("machines are restored from the store as disconnected; revoked ones are not", () => {
  const store = new Store(":memory:");
  const keep = store.createDevice("machine", "ubuntu").device;
  const gone = store.createDevice("machine", "old-mac").device;
  store.saveMachine({ id: keep.id, name: "ubuntu", connected: true, lastSeen: 5, sessions: [session] });
  store.revokeDevice(gone.id);
  const hub = new Hub(store);
  const c = fakePeer<HubToClient>("b");
  hub.onClientConnect(c);
  const snap = c.sent[0];
  assert.ok(snap?.type === "snapshot");
  assert.deepEqual(
    snap.machines.map((m) => [m.name, m.connected]),
    [["ubuntu", false]],
  );
  assert.equal(snap.machines[0]?.sessions[0]?.title, "プラグインの整理");
});

test("messages of the wrong shape are left and change nothing; a hello of the wrong shape is refused (#97)", () => {
  const { hub, store, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  for (const hello of [{ type: "hello" }, { type: "hello", machineId, token: 1 }]) {
    const d = fakePeer<HubToDaemon>();
    hub.onDaemonMessage(d, hello as never);
    assert.equal(d.closed?.[0], CLOSE_INVALID_CREDENTIALS);
  }
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: {} as never });
  assert.deepEqual(d.sent, [{ type: "welcome" }]);
  hub.onDaemonMessage(d, { type: "sessions", sessions: [session] });
  const sent = c.sent.length;

  hub.onDaemonMessage(d, { type: "sessions" } as never);
  hub.onDaemonMessage(d, { type: "sessions", sessions: [null] } as never);
  hub.onDaemonMessage(d, { type: "hook" } as never);
  hub.onDaemonMessage(d, { type: "hook", event: { sessionId: "s1", event: "Stop" } } as never);
  hub.onClientMessage(c, { type: "notification.read" } as never);
  hub.onClientMessage(c, { type: "notification.read", ids: [{}] } as never);
  assert.equal(c.sent.length, sent);
  assert.equal(d.closed, undefined);
  const [m] = store.loadMachines();
  assert.deepEqual(m?.sessions, [session]);
  assert.equal(m?.daemonVersion, undefined);
  assert.deepEqual(store.recentEvents(), []);
});

test("notificationFor covers permission, idle and errors, and ignores other events", () => {
  const ev = { sessionId: "s1", at: 1 };
  assert.equal(
    notificationFor("m", { ...ev, event: "Notification", notificationType: "permission_prompt" }, session, "1")?.kind,
    "permission",
  );
  assert.equal(notificationFor("m", { ...ev, event: "Notification", notificationType: "idle_prompt" }, session, "2")?.kind, "idle");
  assert.equal(notificationFor("m", { ...ev, event: "StopFailure" }, session, "3")?.kind, "error");
  assert.equal(notificationFor("m", { ...ev, event: "PreToolUse" }, session, "4"), null);
  assert.equal(notificationFor("m", { ...ev, event: "Stop" }, undefined, "5")?.title, "s1 の応答が終わりました");
});

test("a permission prompt for Claude's question or plan is notified as such", () => {
  const ev = { sessionId: "s1", at: 1, event: "Notification", notificationType: "permission_prompt", summary: "Claude needs your permission" };
  const waiting = (r: Record<string, unknown>) =>
    ({ ...session, permissionRequests: [{ id: "b", toolName: "Bash", input: "{}", at: 0 }, { id: "r", input: "{}", at: 1, ...r }] }) as SessionInfo;
  const question = notificationFor("m", ev, waiting({ toolName: "AskUserQuestion", summary: "Which color?", questions: [] }), "1");
  assert.deepEqual([question?.kind, question?.title, question?.body], ["permission", "プラグインの整理 が質問しています", "Which color?"]);
  const plan = notificationFor("m", ev, waiting({ toolName: "ExitPlanMode", summary: "Plan: hello", plan: "# Plan: hello" }), "2");
  assert.deepEqual([plan?.title, plan?.body], ["プラグインの整理 が計画の承認を待っています", "Plan: hello"]);
  // From a gasho-daemon too old to send the questions, the summary is raw JSON: no body then.
  const old = notificationFor("m", ev, waiting({ toolName: "AskUserQuestion", summary: '{"questions":[' }), "3");
  assert.deepEqual([old?.title, old?.body], ["プラグインの整理 が質問しています", undefined]);
  const other = notificationFor("m", ev, waiting({ toolName: "Bash", summary: "npm test" }), "4");
  assert.deepEqual([other?.title, other?.body], ["プラグインの整理 が権限の確認を待っています", "Claude needs your permission"]);
});

test("session commands are relayed to the working server and the result goes back to the asking browser only", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.2.0" });
  const folderRepos = [{ path: "/home/rg/repos/Gasho", worktreeCount: 2 }];
  hub.onDaemonMessage(d, { type: "capabilities", canLaunch: true, folders: ["/home/rg/repos/Gasho"], folderRepos });
  const asking = fakePeer<HubToClient>(browserId);
  const other = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(asking);
  hub.onClientConnect(other);
  const snap = asking.sent[0];
  assert.ok(snap?.type === "snapshot");
  assert.deepEqual(snap.machines[0]?.folders, ["/home/rg/repos/Gasho"]);
  assert.deepEqual(snap.machines[0]?.folderRepos, folderRepos);

  hub.onClientMessage(asking, { type: "session.input", requestId: "c1", machine: machineId, sessionId: "s1", text: "テスト" });
  const relayed = d.sent.at(-1);
  assert.ok(relayed?.type === "session.input");
  assert.equal(relayed.text, "テスト");
  assert.notEqual(relayed.requestId, "c1"); // the hub uses its own ids towards working servers

  hub.onDaemonMessage(d, { type: "command.result", requestId: relayed.requestId, result: { ok: true, queued: true } });
  assert.deepEqual(asking.sent.at(-1), { type: "command.result", requestId: "c1", machine: machineId, result: { ok: true, queued: true } });
  assert.ok(!other.sent.some((m) => m.type === "command.result"));
});

test("session commands are refused when invalid or when the working server is offline, and fail when it disconnects", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  hub.onClientMessage(c, { type: "session.input", requestId: "a", machine: machineId, sessionId: "s1", text: "hi" });
  let r = c.sent.at(-1);
  assert.ok(r?.type === "command.result" && !r.result.ok);

  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.2.0" });
  hub.onClientMessage(c, { type: "session.input", requestId: "b", machine: machineId, sessionId: "s1", text: "   " });
  r = c.sent.at(-1);
  assert.ok(r?.type === "command.result" && r.requestId === "b" && r.result.error === "入力が空です。");
  hub.onClientMessage(c, { type: "session.launch", requestId: "c", machine: machineId, cwd: "relative/path" });
  r = c.sent.at(-1);
  assert.ok(r?.type === "command.result" && r.requestId === "c" && !r.result.ok);

  hub.onClientMessage(c, { type: "session.interrupt", requestId: "d", machine: machineId, sessionId: "s1" });
  assert.equal(d.sent.at(-1)?.type, "session.interrupt");
  hub.onDaemonClose(d);
  r = c.sent.at(-1);
  assert.ok(r?.type === "command.result" && r.requestId === "d" && !r.result.ok);
});

test("session.stopTask is checked, relayed with its task, and logged with what it stops", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.15.0" });
  hub.onDaemonMessage(d, {
    type: "sessions",
    sessions: [
      {
        sessionId: "s1",
        cwd: "/w",
        status: "idle",
        rcMode: "none",
        prLinks: [],
        managed: true,
        background: [{ id: "b1", kind: "shell", title: "dev server", command: "npm run dev", startedAt: 1 }],
      },
    ],
  });
  hub.onClientMessage(c, { type: "session.stopTask", requestId: "a", machine: machineId, sessionId: "s1", taskId: "" });
  const r = c.sent.at(-1);
  assert.ok(r?.type === "command.result" && r.requestId === "a" && r.result.error === "タスクの指定が正しくありません。");
  const logged = () => {
    const e = c.sent.filter((m) => m.type === "event").at(-1);
    return e?.type === "event" ? e.event.summary : undefined;
  };
  hub.onClientMessage(c, { type: "session.stopTask", requestId: "b", machine: machineId, sessionId: "s1", taskId: "b1" });
  const relayed = d.sent.at(-1);
  assert.ok(relayed?.type === "session.stopTask" && relayed.taskId === "b1" && relayed.sessionId === "s1");
  assert.match(logged() ?? "", /^dev server \[shell\] \(by /);
  hub.onClientMessage(c, { type: "session.stopTask", requestId: "c", machine: machineId, sessionId: "s1" });
  const all = d.sent.at(-1);
  assert.ok(all?.type === "session.stopTask" && all.taskId === undefined);
  assert.match(logged() ?? "", /^\[all\] \(by /);
});

test("git.graph.get is relayed to the working server and the graph goes back to the asking browser only", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.3.0" });
  const asking = fakePeer<HubToClient>(browserId);
  const other = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(asking);
  hub.onClientConnect(other);
  hub.onClientMessage(asking, { type: "git.graph.get", machine: machineId, sessionId: "s1" });
  const req = d.sent.at(-1);
  assert.ok(req?.type === "git.graph.get");
  assert.equal(req.sessionId, "s1");
  // An answer of the wrong kind for this request is ignored.
  hub.onDaemonMessage(d, { type: "transcript.page", requestId: req.requestId, sessionId: "s1", entries: [], start: 0, total: 0 });
  assert.ok(!asking.sent.some((m) => m.type === "transcript.page"));
  const graph = { root: "/home/rg/repos/Bobert", head: "main", branches: [], commits: [], truncated: false };
  hub.onDaemonMessage(d, { type: "git.graph", requestId: req.requestId, sessionId: "s1", graph });
  const got = asking.sent.at(-1);
  assert.ok(got?.type === "git.graph");
  assert.equal(got.machine, machineId);
  assert.deepEqual(got.graph, graph);
  assert.ok(!other.sent.some((m) => m.type === "git.graph"));
});

test("git.graph.get fails when the working server is offline or disconnects", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  hub.onClientMessage(c, { type: "git.graph.get", machine: machineId, sessionId: "s1" });
  const offline = c.sent.at(-1);
  assert.ok(offline?.type === "git.graph" && offline.error && !offline.graph);

  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.3.0" });
  hub.onClientMessage(c, { type: "git.graph.get", machine: machineId, sessionId: "s1" });
  hub.onDaemonClose(d);
  const failed = c.sent.filter((m) => m.type === "git.graph").at(-1);
  assert.ok(failed?.type === "git.graph" && !failed.graph);
  assert.equal(failed.error, "working server との接続が切れました。");
});

test("git.graph.get passes the chosen repository through and echoes it with the graph", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.3.0" });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  hub.onClientMessage(c, { type: "git.graph.get", machine: machineId, sessionId: "s1", repo: "org/web" });
  const req = d.sent.at(-1);
  assert.ok(req?.type === "git.graph.get");
  assert.equal(req.repo, "org/web");
  hub.onDaemonMessage(d, { type: "git.graph", requestId: req.requestId, sessionId: "s1", error: "このリポジトリは見つかりません。" });
  const got = c.sent.at(-1);
  assert.ok(got?.type === "git.graph");
  assert.equal(got.repo, "org/web");
  assert.equal(got.error, "このリポジトリは見つかりません。");

  // An empty or oversized repository name never reaches the working server.
  const before = d.sent.length;
  hub.onClientMessage(c, { type: "git.graph.get", machine: machineId, sessionId: "s1", repo: "" });
  hub.onClientMessage(c, { type: "git.graph.get", machine: machineId, sessionId: "s1", repo: "x".repeat(501) });
  assert.equal(d.sent.length, before);
});

test("inputs with a model and files are checked: allowed models, at most 5 files and 10 MB, base64 only", () => {
  const ok = { type: "session.input", sessionId: "s1", text: "見て" } as const;
  const file = (bytes: number, name = "a.png") => ({ name, data: Buffer.alloc(bytes, 7).toString("base64") });
  assert.equal(validateCommand({ ...ok, model: "sonnet", files: [file(10)] }), undefined);
  // Files alone are an input too.
  assert.equal(validateCommand({ ...ok, text: "", files: [file(10)] }), undefined);
  assert.equal(validateCommand({ ...ok, text: "" }), "入力が空です。");
  assert.match(validateCommand({ ...ok, model: "gpt" as never }) ?? "", /モデル/);
  assert.match(validateCommand({ ...ok, files: Array.from({ length: 6 }, () => file(1)) }) ?? "", /5 個/);
  assert.match(validateCommand({ ...ok, files: [file(MAX_FILES_BYTES / 2), file(MAX_FILES_BYTES / 2 + 1)] }) ?? "", /10MB/);
  assert.equal(validateCommand({ ...ok, files: [file(MAX_FILES_BYTES / 2), file(MAX_FILES_BYTES / 2)] }), undefined);
  assert.match(validateCommand({ ...ok, files: [{ name: "a", data: "not base64!" }] }) ?? "", /中身/);
  assert.match(validateCommand({ ...ok, files: [{ name: "", data: "" }] }) ?? "", /ファイル名/);
});

test("the audit log records file names and sizes, never their contents", () => {
  const { hub, store, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.5.0" });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const data = Buffer.from("秘密の中身").toString("base64");
  hub.onClientMessage(c, { type: "session.input", requestId: "f", machine: machineId, sessionId: "s1", text: "読んで", model: "haiku", files: [{ name: "memo.txt", data }] });
  const relayed = d.sent.at(-1);
  assert.ok(relayed?.type === "session.input" && relayed.files?.[0]?.data === data && relayed.model === "haiku");
  const logged = store.recentEvents().at(-1);
  assert.match(logged?.summary ?? "", /読んで \[model: haiku\] \[file: memo\.txt, 1KB\]/);
  assert.ok(!(logged?.summary ?? "").includes(data));
});

test("effort and ultracode of inputs are checked, and machines carry the model names their daemon read", () => {
  const ok = { type: "session.input", sessionId: "s1", text: "考えて" } as const;
  assert.equal(validateCommand({ ...ok, effort: "xhigh", ultracode: true }), undefined);
  assert.match(validateCommand({ ...ok, effort: "huge" as never }) ?? "", /Effort/);
  assert.match(validateCommand({ ...ok, ultracode: "yes" as never }) ?? "", /Ultracode/);
  // Typed commands that would change the defaults of every new session are refused; the session-only one is not.
  assert.match(validateCommand({ ...ok, text: "/model sonnet" }) ?? "", /モデルの選択/);
  assert.match(validateCommand({ ...ok, text: " /effort high" }) ?? "", /Effort のボタン/);
  assert.equal(validateCommand({ ...ok, text: "/effort ultracode on" }), undefined);
  assert.equal(validateCommand({ ...ok, text: "/models について教えて" }), undefined);
  assert.equal(validateCommand({ ...ok, text: "/model-review を実行して" }), undefined);
  assert.equal(validateCommand({ ...ok, text: "/effort-estimate この課題" }), undefined);
  assert.match(validateCommand({ ...ok, text: "/model" }) ?? "", /モデルの選択/);

  const { hub, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.6.0" });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  hub.onDaemonMessage(d, {
    type: "capabilities",
    canLaunch: true,
    folders: [],
    models: [
      { id: "default", name: "Sonnet 5.5" },
      { id: "opus", name: "Opus 5.5" },
      { id: "gpt" as never, name: "x" },
      { id: "haiku", name: "" },
    ],
    modelsAt: 1_700_000_000_000,
    features: ["model", "effort", "ultracode", "files", "teleport" as never, "effort"],
  });
  const got = c.sent.filter((m) => m.type === "machine").at(-1);
  assert.ok(got?.type === "machine");
  assert.deepEqual(got.machine.models, [
    { id: "default", name: "Sonnet 5.5" },
    { id: "opus", name: "Opus 5.5" },
  ]);
  assert.equal(got.machine.modelsAt, 1_700_000_000_000);
  assert.deepEqual(got.machine.features, ["model", "effort", "ultracode", "files"]);

  hub.onClientMessage(c, { type: "session.input", requestId: "e", machine: machineId, sessionId: "s1", text: "考えて", effort: "high", ultracode: false });
  const relayed = d.sent.at(-1);
  assert.ok(relayed?.type === "session.input" && relayed.effort === "high" && relayed.ultracode === false);
});

test("a gasho-daemon that does not list its features gets no effort or ultracode switch, with a clear error", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.5.0" });
  hub.onDaemonMessage(d, { type: "capabilities", canLaunch: true, folders: [] });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const before = d.sent.length;
  hub.onClientMessage(c, { type: "session.input", requestId: "old", machine: machineId, sessionId: "s1", text: "考えて", effort: "high", ultracode: true });
  assert.equal(d.sent.length, before);
  const reply = c.sent.at(-1);
  assert.ok(reply?.type === "command.result" && !reply.result.ok);
  assert.match(reply.result.error ?? "", /gasho-daemon は古いため、次のものを扱えません：Effort、Ultracode。/);
  // What 0.5.0 could do still goes through.
  hub.onClientMessage(c, { type: "session.input", requestId: "ok", machine: machineId, sessionId: "s1", text: "見て", model: "opus" });
  assert.equal(d.sent.at(-1)?.type, "session.input");
  // Older ones only type the text.
  assert.deepEqual(legacyFeatures("0.5.0"), ["model", "files"]);
  assert.deepEqual(legacyFeatures("0.4.0"), []);
  assert.deepEqual(legacyFeatures(undefined), []);
  assert.deepEqual(legacyFeatures("1.0.0"), ["model", "files"]);
});

test("a session started elsewhere gets no notification; one not known yet still does", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.7.0" });
  hub.onDaemonMessage(d, { type: "sessions", sessions: [{ ...session, sessionId: "rc", managed: false }] });
  hub.onDaemonMessage(d, { type: "hook", event: { sessionId: "rc", event: "Stop", at: 1000 } });
  assert.equal(c.sent.filter((m) => m.type === "notification").length, 0);
  hub.onDaemonMessage(d, { type: "hook", event: { sessionId: "new", event: "Stop", at: 1001 } });
  assert.equal(c.sent.filter((m) => m.type === "notification").length, 1);
});

test("a session already reported waiting gets no idle_prompt notification (#91)", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.21.0" });
  hub.onDaemonMessage(d, { type: "sessions", sessions: [session] });
  const hook = (event: string, at: number, extra: Record<string, unknown> = {}) =>
    hub.onDaemonMessage(d, { type: "hook", event: { sessionId: "s1", event, at, ...extra } });
  const kinds = () => c.sent.flatMap((m) => (m.type === "notification" ? [m.notification.kind] : []));
  const idle = { notificationType: "idle_prompt" };

  // A reply, then idle_prompt 60 s later: only the reply is notified.
  hook("UserPromptSubmit", 1000, { summary: "こんにちは" });
  hook("Stop", 2000);
  hook("Notification", 62_000, idle);
  assert.deepEqual(kinds(), ["done"]);
  // /compact or /context sends no hook, but makes Claude Code send idle_prompt again.
  hook("Notification", 200_000, idle);
  assert.deepEqual(kinds(), ["done"]);
  // A session that did something since (here, a permission prompt answered in the terminal) is told again.
  hook("PreToolUse", 300_000, { toolName: "Bash" });
  hook("Notification", 360_000, idle);
  assert.deepEqual(kinds(), ["done", "idle"]);
  hook("Notification", 500_000, idle);
  assert.deepEqual(kinds(), ["done", "idle"]);
  // A failure ends a reply as a Stop does.
  hook("UserPromptSubmit", 600_000, { summary: "続けて" });
  hook("StopFailure", 601_000);
  hook("Notification", 661_000, idle);
  assert.deepEqual(kinds(), ["done", "idle", "error"]);
  // Without a reply before it (a session Gasho has not heard from), idle_prompt is notified.
  hub.onDaemonMessage(d, { type: "hook", event: { sessionId: "s2", event: "Notification", at: 700_000, ...idle } });
  assert.deepEqual(kinds(), ["done", "idle", "error", "idle"]);
});

test("a turn Claude Code began by itself is notified only once the last notification has been read (#91)", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.21.0" });
  hub.onDaemonMessage(d, { type: "sessions", sessions: [session] });
  const hook = (event: string, at: number, extra: Record<string, unknown> = {}) =>
    hub.onDaemonMessage(d, { type: "hook", event: { sessionId: "s1", event, at, ...extra } });
  const sent = () => c.sent.flatMap((m) => (m.type === "notification" ? [m.notification] : []));
  const task = { summary: "<task-notification> <task-id>b1</task-id>", automatic: true };

  hook("UserPromptSubmit", 1000, { summary: "裏でテストを流して" });
  hook("Stop", 2000, { summary: "started" });
  assert.equal(sent().length, 1);
  // The background task ends while the first notification is unread: its turn is not notified.
  hook("UserPromptSubmit", 20_000, task);
  hook("Stop", 21_000, { summary: "finished" });
  hook("Notification", 81_000, { notificationType: "idle_prompt" });
  assert.equal(sent().length, 1);
  // Once it is read, the next turn of its own is.
  hub.onClientMessage(c, { type: "notification.read", ids: [sent()[0]!.id] });
  hook("UserPromptSubmit", 100_000, task);
  hook("Stop", 101_000, { summary: "finished again" });
  assert.deepEqual(sent().map((n) => n.body), ["started", "finished again"]);
  // A turn of the user's own is always notified, read or not; so is one that fails.
  hook("UserPromptSubmit", 200_000, { summary: "次へ" });
  hook("Stop", 201_000, { summary: "next" });
  hook("UserPromptSubmit", 300_000, task);
  hook("StopFailure", 301_000, { summary: "overloaded" });
  assert.deepEqual(sent().map((n) => n.kind), ["done", "done", "done", "error"]);
  // A `!` command runs a turn with no UserPromptSubmit: it is not taken for one of Claude Code's own.
  hook("UserPromptSubmit", 400_000, task);
  hook("Stop", 401_000);
  assert.equal(sent().length, 4);
  hook("Stop", 500_000, { summary: "after !ls" });
  assert.equal(sent().at(-1)?.body, "after !ls");
});

test("what a browser asked a working server to do reaches the browsers at once (the home screen's latest operations)", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.8.0" });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  hub.onClientMessage(c, { type: "session.input", requestId: "x", machine: machineId, sessionId: "s1", text: "テストを流して" });
  const ev = c.sent.find((m) => m.type === "event");
  assert.ok(ev?.type === "event" && ev.event.event === "Gasho:session.input" && ev.event.summary?.startsWith("テストを流して"));
});

test("renaming, forking and removing go to a gasho-daemon 0.9.0 or later; older ones are refused with a clear error", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const old = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(old, { type: "hello", machineId, token: machineToken, daemonVersion: "0.8.0" });
  hub.onClientMessage(c, { type: "session.rename", requestId: "r0", machine: machineId, sessionId: "s1", name: "新しい名前" });
  let reply = c.sent.at(-1);
  assert.ok(reply?.type === "command.result" && reply.requestId === "r0" && !reply.result.ok);
  assert.match(reply.result.error ?? "", /gasho-daemon は古いため/);
  assert.equal(old.sent.filter((m) => m.type !== "welcome").length, 0);

  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.9.0" });
  hub.onDaemonMessage(d, { type: "sessions", sessions: [{ ...session, name: "Bobert-gasho" }] });
  hub.onClientMessage(c, { type: "session.rename", requestId: "r1", machine: machineId, sessionId: "s1", name: "  新しい名前 " });
  const rename = d.sent.at(-1);
  assert.ok(rename?.type === "session.rename" && rename.sessionId === "s1" && rename.name === "  新しい名前 ");
  hub.onClientMessage(c, { type: "session.fork", requestId: "f1", machine: machineId, sessionId: "s1" });
  const fork = d.sent.at(-1);
  assert.ok(fork?.type === "session.fork" && fork.name === undefined);
  hub.onDaemonMessage(d, { type: "command.result", requestId: fork.requestId, result: { ok: true, sessionId: "s2" } });
  assert.deepEqual(c.sent.at(-1), { type: "command.result", requestId: "f1", machine: machineId, result: { ok: true, sessionId: "s2" } });
  hub.onClientMessage(c, { type: "session.remove", requestId: "x1", machine: machineId, sessionId: "s1" });
  assert.equal(d.sent.at(-1)?.type, "session.remove");

  // The latest operations name the session: the new name, and the removed session's name (it is gone afterwards).
  const summaries = c.sent.flatMap((m) => (m.type === "event" ? [[m.event.event, m.event.summary?.replace(/ \(by .*\)$/, "")]] : []));
  assert.deepEqual(summaries.slice(-3), [
    ["Gasho:session.rename", "新しい名前"],
    ["Gasho:session.fork", ""],
    ["Gasho:session.remove", "Bobert-gasho"],
  ]);

  // A plugin that removes a session is named in the operations log.
  hub.onClientMessage(c, { type: "session.remove", requestId: "x2", machine: machineId, sessionId: "s1", via: "github-review" });
  assert.equal(c.sent.flatMap((m) => (m.type === "event" ? [m.event.summary?.replace(/ \(by .*\)$/, "")] : [])).at(-1), "Bobert-gasho [via: github-review]");
});

test("a session's name must be one line of 1 to 60 characters; a fork may leave it out", () => {
  const rename = (name: unknown) => validateCommand({ type: "session.rename", sessionId: "s1", name } as never);
  assert.equal(rename("調査"), undefined);
  assert.equal(rename(`  ${"x".repeat(60)}  `), undefined);
  assert.match(rename("   ") ?? "", /名前を入れて/);
  assert.match(rename("x".repeat(61)) ?? "", /60文字まで/);
  assert.match(rename("一行目\n/model opus") ?? "", /改行/);
  assert.match(rename(42) ?? "", /名前を入れて/);
  assert.equal(validateCommand({ type: "session.fork", sessionId: "s1" }), undefined);
  assert.match(validateCommand({ type: "session.fork", sessionId: "s1", name: "\u0007" }) ?? "", /制御文字/);
  assert.match(validateCommand({ type: "session.remove", sessionId: "" }) ?? "", /セッションの指定/);
  assert.match(validateCommand({ type: "session.remove", sessionId: 7 } as never) ?? "", /セッションの指定/);
  assert.equal(validateCommand({ type: "session.remove", sessionId: "s1", via: "github-review" }), undefined);
  assert.match(validateCommand({ type: "session.remove", sessionId: "s1", via: "Not A Plugin" }) ?? "", /プラグインの指定/);
});

test("a folder to make and a repository to clone are checked before they reach the working server", () => {
  const v = (cmd: unknown) => validateCommand(cmd as never);
  assert.equal(v({ type: "folder.create", parent: "/home/rg/repos", name: "ws" }), undefined);
  assert.match(v({ type: "folder.create", parent: "repos", name: "ws" }) ?? "", /絶対パス/);
  assert.match(v({ type: "folder.create", parent: "/home/rg", name: "" }) ?? "", /名前を入れて/);
  assert.match(v({ type: "folder.create", parent: "/home/rg", name: " ws" }) ?? "", /空白/);
  for (const name of ["..", "a/b", "-x", "a\nb"]) assert.match(v({ type: "folder.create", parent: "/home/rg", name }) ?? "", /使えません/, name);
  assert.match(v({ type: "folder.create", parent: "/home/rg", name: "x".repeat(256) }) ?? "", /長すぎ/);
  assert.equal(v({ type: "repo.clone", parent: "/home/rg/repos", repo: "https://github.com/cli/cli.git", name: "gh" }), undefined);
  assert.equal(v({ type: "repo.clone", parent: "/home/rg/repos", repo: "cli/cli" }), undefined);
  assert.match(v({ type: "repo.clone", parent: "/home/rg/repos", repo: " " }) ?? "", /リポジトリを入れて/);
  assert.match(v({ type: "repo.clone", parent: "/home/rg/repos", repo: "--upload-pack=x" }) ?? "", /リポジトリの指定/);
  assert.match(v({ type: "repo.clone", parent: "/home/rg/repos", repo: "cli/cli extra" }) ?? "", /リポジトリの指定/);
  assert.match(v({ type: "repo.clone", parent: "/home/rg/repos", repo: "cli/cli", name: "../x" }) ?? "", /使えません/);
  assert.match(v({ type: "repo.clone", parent: "~/repos", repo: "cli/cli" }) ?? "", /絶対パス/);
  assert.equal(v({ type: "session.launch", cwd: "/home/rg/repos/cli", trust: true }), undefined);
  assert.match(v({ type: "session.launch", cwd: "/home/rg/repos/cli", trust: "yes" }) ?? "", /信頼の指定/);
});

test("making folders, cloning and trusting go to a gasho-daemon 0.10.0 or later, and are recorded", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const old = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(old, { type: "hello", machineId, token: machineToken, daemonVersion: "0.9.0" });
  hub.onClientMessage(c, { type: "folder.create", requestId: "f0", machine: machineId, parent: "/home/rg/repos", name: "ws" });
  let reply = c.sent.at(-1);
  assert.ok(reply?.type === "command.result" && reply.requestId === "f0" && !reply.result.ok);
  assert.match(reply.result.error ?? "", /フォルダーの作成と clone を扱えません/);
  hub.onClientMessage(c, { type: "session.launch", requestId: "l0", machine: machineId, cwd: "/home/rg/repos/ws", trust: true });
  reply = c.sent.at(-1);
  assert.ok(reply?.type === "command.result" && reply.requestId === "l0" && !reply.result.ok);
  assert.match(reply.result.error ?? "", /信頼できません/);
  // A launch that does not ask to trust still goes to an older daemon.
  hub.onClientMessage(c, { type: "session.launch", requestId: "l1", machine: machineId, cwd: "/home/rg/repos/zen" });
  assert.equal(old.sent.at(-1)?.type, "session.launch");

  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.10.0" });
  hub.onClientMessage(c, { type: "folder.create", requestId: "f1", machine: machineId, parent: "/home/rg/repos", name: "ws" });
  const mk = d.sent.at(-1);
  assert.ok(mk?.type === "folder.create" && mk.parent === "/home/rg/repos" && mk.name === "ws");
  hub.onDaemonMessage(d, { type: "command.result", requestId: mk.requestId, result: { ok: true, path: "/home/rg/repos/ws" } });
  assert.deepEqual(c.sent.at(-1), { type: "command.result", requestId: "f1", machine: machineId, result: { ok: true, path: "/home/rg/repos/ws" } });

  hub.onClientMessage(c, { type: "repo.clone", requestId: "c1", machine: machineId, parent: "/home/rg/repos/ws", repo: "cli/cli" });
  const clone = d.sent.at(-1);
  assert.ok(clone?.type === "repo.clone" && clone.repo === "cli/cli" && clone.name === undefined);

  // A launch that stopped at Claude Code's question comes back with what Claude Code pointed out.
  hub.onClientMessage(c, { type: "session.launch", requestId: "l2", machine: machineId, cwd: "/home/rg/repos/ws/cli" });
  const asked = d.sent.at(-1);
  assert.ok(asked?.type === "session.launch" && asked.trust === undefined);
  const stopped = { ok: false, error: "このフォルダーは、まだ Claude Code に信頼されていません。", needsTrust: true, trustWarnings: ["⚠ This folder …"] };
  hub.onDaemonMessage(d, { type: "command.result", requestId: asked.requestId, result: stopped });
  assert.deepEqual(c.sent.at(-1), { type: "command.result", requestId: "l2", machine: machineId, result: stopped });
  hub.onClientMessage(c, { type: "session.launch", requestId: "l3", machine: machineId, cwd: "/home/rg/repos/ws/cli", trust: true });
  const trusted = d.sent.at(-1);
  assert.ok(trusted?.type === "session.launch" && trusted.trust === true);

  // The audit log: refused commands are not in it; a launch told to trust its folder says so.
  const summaries = c.sent.flatMap((m) => (m.type === "event" ? [[m.event.event, m.event.summary?.replace(/ \(by .*\)$/, "")]] : []));
  assert.deepEqual(summaries, [
    ["Gasho:session.launch", "/home/rg/repos/zen"],
    ["Gasho:folder.create", "/home/rg/repos/ws"],
    ["Gasho:repo.clone", "cli/cli → /home/rg/repos/ws"],
    ["Gasho:session.launch", "/home/rg/repos/ws/cli"],
    ["Gasho:session.launch", "/home/rg/repos/ws/cli [trust]"],
  ]);
});

test("registering a repository goes to a gasho-daemon that sends its repositories, which reach browsers; older ones are refused", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const old = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(old, { type: "hello", machineId, token: machineToken, daemonVersion: "0.14.0" });
  hub.onClientMessage(c, { type: "repo.register", requestId: "r0", machine: machineId, path: "/home/rg/repos/app" });
  let reply = c.sent.at(-1);
  assert.ok(reply?.type === "command.result" && reply.requestId === "r0" && !reply.result.ok);
  assert.match(reply.result.error ?? "", /リポジトリを登録できません/);
  hub.onClientMessage(c, { type: "repo.register", requestId: "r1", machine: machineId, path: "app" });
  reply = c.sent.at(-1);
  assert.ok(reply?.type === "command.result" && reply.requestId === "r1" && reply.result.error === "フォルダーを絶対パスで指定してください。");

  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.15.0" });
  const repos = [{ path: "/home/rg/repos/app", worktrees: [{ path: "/home/rg/repos/app", branch: "main" }, { path: "/home/rg/repos/app-x" }] }];
  hub.onDaemonMessage(d, { type: "repos", repos });
  const machine = c.sent.at(-1);
  assert.ok(machine?.type === "machine");
  assert.deepEqual(machine.machine.repos, repos);
  hub.onClientMessage(c, { type: "repo.unregister", requestId: "r2", machine: machineId, path: "/home/rg/repos/app" });
  assert.ok(d.sent.at(-1)?.type === "repo.unregister");
  const summaries = c.sent.flatMap((m) => (m.type === "event" ? [[m.event.event, m.event.summary?.replace(/ \(by .*\)$/, "")]] : []));
  assert.deepEqual(summaries, [["Gasho:repo.unregister", "/home/rg/repos/app"]]);
});

test("ending sessions opened outside Gasho goes to a gasho-daemon that can, and the record keeps their names", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.16.0" });
  const outside = (sessionId: string, name: string) => ({ sessionId, cwd: "/w", name, status: "idle" as const, rcMode: "none" as const, prLinks: [] });
  hub.onDaemonMessage(d, { type: "sessions", sessions: [outside("o1", "orca-a"), outside("o2", "orca-b")] });
  hub.onClientMessage(c, { type: "session.end", requestId: "r0", machine: machineId, sessionIds: ["o1", "o2"] });
  const reply = c.sent.at(-1);
  assert.ok(reply?.type === "command.result" && reply.requestId === "r0" && !reply.result.ok);
  assert.match(reply.result.error ?? "", /Gasho の外で開いている会話を終了できません/);
  assert.notEqual(d.sent.at(-1)?.type, "session.end");

  hub.onDaemonMessage(d, { type: "capabilities", canLaunch: true, folders: [], canResume: true, canEnd: true });
  hub.onClientMessage(c, { type: "session.end", requestId: "r1", machine: machineId, sessionIds: [] });
  const invalid = c.sent.at(-1);
  assert.ok(invalid?.type === "command.result" && invalid.result.error === "会話の指定が正しくありません。");
  hub.onClientMessage(c, { type: "session.end", requestId: "r2", machine: machineId, sessionIds: ["o1", "o2"] });
  const sent = d.sent.at(-1);
  assert.ok(sent?.type === "session.end");
  assert.deepEqual(sent.sessionIds, ["o1", "o2"]);
  const summaries = c.sent.flatMap((m) => (m.type === "event" ? [[m.event.event, m.event.summary?.replace(/ \(by .*\)$/, "")]] : []));
  assert.deepEqual(summaries, [["Gasho:session.end", "orca-a, orca-b"]]);
});

test("a session's skills are asked of a gasho-daemon that lists them, even while an update holds commands, and are not recorded", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.19.0" });
  hub.onClientMessage(c, { type: "session.skills", requestId: "r0", machine: machineId, sessionId: "s1" });
  const refused = c.sent.at(-1);
  assert.ok(refused?.type === "command.result" && refused.requestId === "r0" && !refused.result.ok);
  assert.match(refused.result.error ?? "", /スキルの候補を出せません/);

  hub.onDaemonMessage(d, { type: "capabilities", canLaunch: true, folders: [], canListSkills: true });
  hub.hold(UPDATING);
  hub.onClientMessage(c, { type: "session.skills", requestId: "r1", machine: machineId, sessionId: "s1" });
  const asked = d.sent.at(-1);
  assert.ok(asked?.type === "session.skills" && asked.sessionId === "s1");
  const skills = [{ name: "impl-review", description: "セルフレビューする" }];
  hub.onDaemonMessage(d, { type: "command.result", requestId: asked.requestId, result: { ok: true, skills } });
  assert.deepEqual(c.sent.at(-1), { type: "command.result", requestId: "r1", machine: machineId, result: { ok: true, skills } });
  assert.ok(!c.sent.some((m) => m.type === "event"));
});

test("validateCommand checks an answer to a permission request", () => {
  const ok = { type: "permission.answer" as const, sessionId: "s1", permissionId: "p1", decision: "allow" as const };
  assert.equal(validateCommand(ok), undefined);
  assert.equal(validateCommand({ ...ok, decision: "always" }), undefined);
  assert.ok(validateCommand({ ...ok, permissionId: "" }));
  assert.ok(validateCommand({ ...ok, decision: "maybe" as "allow" }));
  // Answers to Claude's questions, the mode an approved plan goes on in, and what to tell Claude on a denial.
  assert.equal(validateCommand({ ...ok, answers: [{ picked: [1] }, { picked: [0, 2], text: "ほかにも" }] }), undefined);
  assert.equal(validateCommand({ ...ok, answers: [{ picked: [], text: "どちらでもない" }] }), undefined);
  assert.ok(validateCommand({ ...ok, answers: [] }));
  assert.ok(validateCommand({ ...ok, answers: [{ picked: [-1] }] }));
  assert.ok(validateCommand({ ...ok, answers: [{ picked: [1.5] }] }));
  assert.ok(validateCommand({ ...ok, answers: [{ picked: "1" as unknown as number[] }] }));
  assert.ok(validateCommand({ ...ok, answers: [{ picked: [], text: 3 as unknown as string }] }));
  assert.match(validateCommand({ ...ok, answers: [{ picked: [], text: "あ".repeat(4001) }] }) ?? "", /4000文字まで/);
  assert.equal(validateCommand({ ...ok, mode: "auto" }), undefined);
  assert.equal(validateCommand({ ...ok, mode: "default" }), undefined);
  assert.ok(validateCommand({ ...ok, mode: "bypassPermissions" as "auto" }));
  assert.equal(validateCommand({ ...ok, decision: "deny", message: "ファイル名を変えて" }), undefined);
  assert.ok(validateCommand({ ...ok, decision: "deny", message: "x".repeat(20_001) }));
});

test("answers to Claude's questions and plans go to the working server, are recorded as such, and need the answers", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.11.0" });
  const question = {
    id: "q1",
    toolName: "AskUserQuestion",
    input: "{}",
    summary: "Which color do you like?",
    at: 1,
    questions: [
      { question: "Which color do you like?", header: "Color", options: [{ label: "Red" }, { label: "Blue" }] },
      { question: "Which fruits?", options: [{ label: "Apple" }, { label: "Cherry" }], multiSelect: true },
    ],
  };
  const plan = { id: "p1", toolName: "ExitPlanMode", input: "{}", summary: "Plan: hello", at: 2, plan: "# Plan: hello" };
  // As a gasho-daemon too old for either sends them: no questions, no plan.
  const oldQuestion = { id: "q0", toolName: "AskUserQuestion", input: '{"questions":[]}', summary: '{"questions":[]}', at: 3 };
  const oldPlan = { id: "p0", toolName: "ExitPlanMode", input: "{}", summary: "{}", at: 4 };
  hub.onDaemonMessage(d, { type: "sessions", sessions: [{ ...session, status: "waiting", permissionRequests: [question, plan, oldQuestion, oldPlan] }] });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const answer = (requestId: string, permissionId: string, rest: Record<string, unknown>) =>
    hub.onClientMessage(c, { type: "permission.answer", requestId, machine: machineId, sessionId: "s1", permissionId, decision: "allow", ...rest });
  const result = (requestId: string) => {
    const r = c.sent.findLast((m) => m.type === "command.result" && m.requestId === requestId);
    return r?.type === "command.result" ? r.result : undefined;
  };
  const relayed = () => d.sent.filter((m) => m.type === "permission.answer").length;

  // "allow" alone would spend the request and leave Claude Code's dialog open.
  answer("a0", "q1", {});
  assert.match(result("a0")?.error ?? "", /選んだ答えを添えて/);
  answer("a1", "q0", { answers: [{ picked: [0] }] });
  assert.match(result("a1")?.error ?? "", /gasho-daemon は古いため/);
  answer("a2", "p0", { mode: "auto" });
  assert.match(result("a2")?.error ?? "", /gasho-daemon は古いため/);
  assert.equal(relayed(), 0);
  // Denying still reaches the working server: Claude stops.
  answer("a3", "q0", { decision: "deny" });
  assert.equal(relayed(), 1);

  answer("a4", "q1", { answers: [{ picked: [1] }, { picked: [0, 1], text: " and plums " }] });
  const sent = d.sent.at(-1);
  assert.ok(sent?.type === "permission.answer");
  assert.deepEqual(sent.answers, [{ picked: [1] }, { picked: [0, 1], text: " and plums " }]);
  answer("a5", "p1", { mode: "auto" });
  answer("a6", "p1", { decision: "deny", message: "ファイル名は farewell.txt に" });
  const summaries = c.sent.flatMap((m) => (m.type === "event" ? [m.event.summary?.replace(/ \(by .*\)$/, "")] : []));
  assert.deepEqual(summaries, [
    "[deny] AskUserQuestion {\"questions\":[]}",
    "[answer] Color → Blue / Which fruits? → Apple, Cherry, and plums",
    "[approve] Plan: hello",
    "[revise] ファイル名は farewell.txt に",
  ]);
});

test("a shell command (an input that starts with \"!\") needs a command and cannot carry files", () => {
  const input = (text: string, files: { name: string; data: string }[] = []) =>
    validateCommand({ type: "session.input", sessionId: "s1", text, ...(files.length ? { files } : {}) });
  assert.equal(input("!ls -la"), undefined);
  assert.equal(input("!npm test 2>&1 | tail -20"), undefined);
  assert.match(input("!") ?? "", /コマンドを入れて/);
  assert.match(input("  !   ") ?? "", /コマンドを入れて/);
  assert.match(input("!cat", [{ name: "a.txt", data: "YQ==" }]) ?? "", /ファイルを添付できません/);
  // Not a shell command: "!" further on, or files with an ordinary message.
  assert.equal(input("これを見て!"), undefined);
  assert.equal(input("見て", [{ name: "a.txt", data: "YQ==" }]), undefined);
});

test("a folder and a file of a session go to a gasho-daemon 0.11.0 or later, and back to the browser that asked", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const asking = fakePeer<HubToClient>(browserId);
  const other = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(asking);
  hub.onClientConnect(other);
  const old = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(old, { type: "hello", machineId, token: machineToken, daemonVersion: "0.10.0" });
  hub.onClientMessage(asking, { type: "dir.get", machine: machineId, sessionId: "s1", path: "" });
  const tooOld = asking.sent.at(-1);
  assert.ok(tooOld?.type === "dir" && tooOld.path === "" && /0\.11\.0/.test(tooOld.error ?? ""));
  assert.equal(old.sent.length, 1); // the welcome only

  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.11.0" });
  hub.onClientMessage(asking, { type: "dir.get", machine: machineId, sessionId: "s1", path: "src" });
  const askedDir = d.sent.at(-1);
  assert.ok(askedDir?.type === "dir.get" && askedDir.path === "src" && askedDir.sessionId === "s1");
  // An answer of the other kind is not taken for it.
  hub.onDaemonMessage(d, { type: "file", requestId: askedDir.requestId, sessionId: "s1", path: "src", error: "x" });
  assert.ok(!asking.sent.some((m) => m.type === "file"));
  const dir = { path: "src", entries: [{ name: "app.ts", kind: "file" as const, size: 10, mtime: 1 }], truncated: false };
  hub.onDaemonMessage(d, { type: "dir", requestId: askedDir.requestId, sessionId: "s1", path: "src", dir });
  assert.deepEqual(asking.sent.at(-1), { type: "dir", machine: machineId, sessionId: "s1", path: "src", dir, error: undefined });

  hub.onClientMessage(asking, { type: "file.get", machine: machineId, sessionId: "s1", path: "src/app.ts" });
  const askedFile = d.sent.at(-1);
  assert.ok(askedFile?.type === "file.get" && askedFile.path === "src/app.ts");
  const file = { path: "src/app.ts", size: 10, mtime: 1, hash: "a".repeat(64), text: "const a=1;", writable: true };
  hub.onDaemonMessage(d, { type: "file", requestId: askedFile.requestId, sessionId: "s1", path: "src/app.ts", file });
  const got = asking.sent.at(-1);
  assert.ok(got?.type === "file" && got.machine === machineId && got.file?.text === "const a=1;");
  assert.ok(!other.sent.some((m) => m.type === "dir" || m.type === "file"));

  // Paths that leave the folder never reach the working server; a file needs a path.
  const before = d.sent.length;
  for (const path of ["../x", "/etc/passwd", "a//b", "a/./b", "a\0b"]) {
    hub.onClientMessage(asking, { type: "dir.get", machine: machineId, sessionId: "s1", path });
    const r = asking.sent.at(-1);
    assert.ok(r?.type === "dir" && r.path === path && r.error, path);
  }
  hub.onClientMessage(asking, { type: "file.get", machine: machineId, sessionId: "s1", path: "" });
  const noFile = asking.sent.at(-1);
  assert.ok(noFile?.type === "file" && /ファイルを指定/.test(noFile.error ?? ""));
  assert.equal(d.sent.length, before);

  // Waiting requests fail when the working server goes away.
  hub.onClientMessage(asking, { type: "file.get", machine: machineId, sessionId: "s1", path: "README.md" });
  hub.onDaemonClose(d);
  const gone = asking.sent.at(-1);
  assert.ok(gone?.type === "file" && gone.path === "README.md" && gone.error && !gone.file);
  hub.onClientMessage(asking, { type: "dir.get", machine: machineId, sessionId: "s1", path: "" });
  const offline = asking.sent.at(-1);
  assert.ok(offline?.type === "dir" && /オフライン/.test(offline.error ?? ""));
});

test("writing a file is checked, goes to a gasho-daemon 0.11.0 or later, and the audit log keeps its path and size, never its text", () => {
  const ok = { type: "file.write" as const, sessionId: "s1", path: "notes/a.md", content: "メモ" };
  assert.equal(validateCommand(ok), undefined);
  assert.equal(validateCommand({ ...ok, content: "", create: true }), undefined);
  assert.equal(validateCommand({ ...ok, baseHash: "0123456789abcdef".repeat(4) }), undefined);
  assert.match(validateCommand({ ...ok, path: "" }) ?? "", /ファイルを指定/);
  assert.match(validateCommand({ ...ok, path: "../a.md" }) ?? "", /フォルダーの中のパス/);
  assert.match(validateCommand({ ...ok, path: "/home/rg/a.md" }) ?? "", /フォルダーの中のパス/);
  assert.match(validateCommand({ ...ok, content: 3 as never }) ?? "", /中身/);
  assert.match(validateCommand({ ...ok, content: "あ".repeat(MAX_WRITE_BYTES / 3 + 1) }) ?? "", /1MB/);
  assert.match(validateCommand({ ...ok, baseHash: "abc" }) ?? "", /版/);
  assert.match(validateCommand({ ...ok, create: "yes" as never }) ?? "", /作成/);

  const { hub, store, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const old = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(old, { type: "hello", machineId, token: machineToken, daemonVersion: "0.10.0" });
  hub.onClientMessage(c, { ...ok, requestId: "w0", machine: machineId });
  const refused = c.sent.at(-1);
  assert.ok(refused?.type === "command.result" && refused.requestId === "w0" && !refused.result.ok);
  assert.match(refused.result.error ?? "", /ファイルを扱えません/);
  assert.equal(old.sent.at(-1)?.type, "welcome");

  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.11.0" });
  const secret = "これは秘密の本文";
  hub.onClientMessage(c, { ...ok, content: secret, create: true, requestId: "w1", machine: machineId });
  const made = d.sent.at(-1);
  assert.ok(made?.type === "file.write" && made.content === secret && made.create === true && made.path === "notes/a.md");
  const written = { hash: "b".repeat(64), size: 24, mtime: 5 };
  hub.onDaemonMessage(d, { type: "command.result", requestId: made.requestId, result: { ok: true, written } });
  assert.deepEqual(c.sent.at(-1), { type: "command.result", requestId: "w1", machine: machineId, result: { ok: true, written } });

  hub.onClientMessage(c, { ...ok, content: "新しい本文", baseHash: written.hash, requestId: "w2", machine: machineId });
  const save = d.sent.at(-1);
  assert.ok(save?.type === "file.write" && save.baseHash === written.hash && save.create === undefined);
  const conflict = { ok: false, error: "このファイルは、開いたあとで変更されています。", conflict: true };
  hub.onDaemonMessage(d, { type: "command.result", requestId: save.requestId, result: conflict });
  assert.deepEqual(c.sent.at(-1), { type: "command.result", requestId: "w2", machine: machineId, result: conflict });

  const logged = store.recentEvents().filter((e) => e.event === "Gasho:file.write");
  assert.deepEqual(
    logged.map((e) => e.summary?.replace(/ \(by .*\)$/, "")),
    ["notes/a.md [new] [1KB]", "notes/a.md [1KB]"],
  );
  assert.ok(logged.every((e) => !e.summary?.includes(secret) && !e.summary?.includes("新しい本文")));
});

test("while an update holds them, commands are refused (listing past sessions goes on), and those under way are counted", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.17.0" });
  hub.onDaemonMessage(d, { type: "capabilities", canLaunch: true, folders: [], canResume: true });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  assert.equal(hub.inFlight(), 0);
  hub.onClientMessage(c, { type: "session.input", requestId: "a", machine: machineId, sessionId: "s1", text: "テスト" });
  const relayed = d.sent.at(-1);
  assert.ok(relayed?.type === "session.input");
  assert.equal(hub.inFlight(), 1);

  hub.hold(UPDATING);
  const toDaemon = d.sent.length;
  hub.onClientMessage(c, { type: "session.input", requestId: "b", machine: machineId, sessionId: "s1", text: "もう一つ" });
  assert.deepEqual(c.sent.at(-1), { type: "command.result", requestId: "b", machine: machineId, result: { ok: false, error: UPDATING } });
  hub.onClientMessage(c, { type: "daemon.update", requestId: "u", machine: machineId, version: "0.18.0" });
  assert.deepEqual(c.sent.at(-1), { type: "command.result", requestId: "u", machine: machineId, result: { ok: false, error: UPDATING } });
  assert.equal(d.sent.length, toDaemon);
  hub.onClientMessage(c, { type: "session.history", requestId: "h", machine: machineId, cwd: "/home/rg/repos/Gasho" });
  const history = d.sent.at(-1);
  assert.ok(history?.type === "session.history");
  assert.equal(hub.inFlight(), 2);

  // What was under way still gets its answer.
  hub.onDaemonMessage(d, { type: "command.result", requestId: relayed.requestId, result: { ok: true, queued: true } });
  hub.onDaemonMessage(d, { type: "command.result", requestId: history.requestId, result: { ok: true, history: [] } });
  assert.deepEqual(c.sent.at(-2), { type: "command.result", requestId: "a", machine: machineId, result: { ok: true, queued: true } });
  assert.equal(hub.inFlight(), 0);

  hub.hold(undefined);
  hub.onClientMessage(c, { type: "session.input", requestId: "c", machine: machineId, sessionId: "s1", text: "あとで" });
  assert.equal(d.sent.at(-1)?.type, "session.input");
});

test("the Gasho server's own version and update reach browsers; hub.update goes to its updater and is logged", () => {
  const store = new Store(":memory:");
  const browser = store.createDevice("browser", "iPhone");
  let info: ServerInfo = { version: "0.1.0", web: "hub-0.1.0", update: { canUpdate: true } };
  let listener = () => undefined as void;
  const asked: string[] = [];
  const server: ServerSource = {
    info: () => info,
    update(version) {
      asked.push(version);
      return version === "0.2.0" ? { ok: true } : { ok: false, error: "版の指定が正しくありません。" };
    },
    subscribe(l) {
      listener = l;
      return () => undefined;
    },
  };
  const hub = new Hub(store, { server });
  const c = fakePeer<HubToClient>(browser.device.id);
  hub.onClientConnect(c);
  const snap = c.sent[0];
  assert.ok(snap?.type === "snapshot");
  assert.deepEqual(snap.server, info);

  hub.onClientMessage(c, { type: "hub.update", requestId: "u1", version: "0.2.0" });
  assert.deepEqual(c.sent.at(-1), { type: "server.result", requestId: "u1", result: { ok: true } });
  const logged = store.recentEvents().find((e) => e.event === "Gasho:hub.update");
  assert.equal(logged?.summary, `Gasho サーバー 0.1.0 → 0.2.0 (by ${browser.device.id})`);
  hub.onClientMessage(c, { type: "hub.update", requestId: "u2", version: "latest" });
  assert.deepEqual(c.sent.at(-1), { type: "server.result", requestId: "u2", result: { ok: false, error: "版の指定が正しくありません。" } });
  assert.deepEqual(asked, ["0.2.0", "latest"]);
  assert.equal(store.recentEvents().filter((e) => e.event === "Gasho:hub.update").length, 1);

  info = { ...info, update: { canUpdate: true, progress: { version: "0.2.0", step: "install", at: 1 } } };
  listener();
  assert.deepEqual(c.sent.at(-1), { type: "server", server: info });

  // A Gasho server without an updater (an embedding, the tests) says so.
  const plain = setup();
  const p = fakePeer<HubToClient>(plain.browserId);
  plain.hub.onClientConnect(p);
  assert.ok(p.sent[0]?.type === "snapshot" && p.sent[0].server === undefined);
  plain.hub.onClientMessage(p, { type: "hub.update", requestId: "u3", version: "0.2.0" });
  assert.deepEqual(p.sent.at(-1), { type: "server.result", requestId: "u3", result: { ok: false, error: "この Gasho サーバーは、Gasho からは更新できません。" } });
});

test("removing a worktree goes to a gasho-daemon that can, checked, and the record keeps its sessions' names", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.19.0" });
  const session = (sessionId: string, cwd: string, name: string) => ({ sessionId, cwd, name, status: "idle" as const, rcMode: "none" as const, prLinks: [] });
  hub.onDaemonMessage(d, { type: "sessions", sessions: [session("s1", "/r/app-x", "fix"), session("s2", "/r/app-x/web", "web"), session("s3", "/r/app-xy", "other")] });
  const cmd = { type: "worktree.remove" as const, path: "/r/app-x", branch: "feat/x" };
  hub.onClientMessage(c, { ...cmd, requestId: "r0", machine: machineId });
  let reply = c.sent.at(-1);
  assert.ok(reply?.type === "command.result" && !reply.result.ok);
  assert.match(reply.result.error ?? "", /worktree を削除できません/);
  assert.notEqual(d.sent.at(-1)?.type, "worktree.remove");

  hub.onDaemonMessage(d, { type: "capabilities", canLaunch: true, folders: [], canRemoveWorktree: true });
  for (const [i, wrong] of [{ path: "app-x" }, { branch: "-D" }, { branch: "a b" }, { force: "yes" }, { pushed: ["xyz"] }, { pushed: "abcdef0" }, { via: "Bad" }].entries()) {
    hub.onClientMessage(c, { ...cmd, ...(wrong as object), requestId: `w${i}`, machine: machineId });
    reply = c.sent.at(-1);
    assert.ok(reply?.type === "command.result" && !reply.result.ok, JSON.stringify(wrong));
  }
  hub.onClientMessage(c, { ...cmd, force: true, pushed: ["abcdef0"], via: "github-almighty", requestId: "r1", machine: machineId });
  const sent = d.sent.at(-1);
  assert.ok(sent?.type === "worktree.remove");
  assert.deepEqual({ ...sent, requestId: undefined }, { ...cmd, force: true, pushed: ["abcdef0"], via: "github-almighty", requestId: undefined });
  const summaries = c.sent.flatMap((m) => (m.type === "event" ? [[m.event.event, m.event.summary?.replace(/ \(by .*\)$/, "")]] : []));
  assert.deepEqual(summaries, [["Gasho:worktree.remove", "/r/app-x [branch: feat/x] [force] [sessions: fix, web] [via: github-almighty]"]]);
  hub.onDaemonMessage(d, { type: "command.result", requestId: sent.requestId, result: { ok: false, error: "x", changes: { uncommitted: 1, unpushed: 2 } } });
  reply = c.sent.at(-1);
  assert.ok(reply?.type === "command.result" && reply.requestId === "r1");
  assert.deepEqual(reply.result.changes, { uncommitted: 1, unpushed: 2 });
});

test("a working server's memory reaches the browsers, is kept for those that connect later, and is never saved", () => {
  const { hub, store, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.25.0" });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  c.sent.length = 0;

  const saved = store.saveMachine.bind(store);
  let saves = 0;
  store.saveMachine = (m) => {
    saves++;
    saved(m);
  };
  const memory = { total: 16, used: 4 };
  hub.onDaemonMessage(d, { type: "memory", memory });
  assert.deepEqual(c.sent, [{ type: "machine.memory", machine: machineId, memory }]);
  assert.equal(saves, 0);
  assert.equal(JSON.stringify(store.loadMachines()).includes("memory"), false);

  const later = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(later);
  const snapshot = later.sent[0];
  assert.deepEqual(snapshot?.type === "snapshot" ? snapshot.memory : undefined, { [machineId]: memory });
});

test("a working server's memory is forgotten when it goes offline, cannot read it, or tells something wrong", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId, token: machineToken, daemonVersion: "0.25.0" });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const memory = { total: 16, used: 4 };
  const memoryMessages = () => c.sent.filter((m) => m.type === "machine.memory");
  const snapshotMemory = () => {
    const later = fakePeer<HubToClient>(browserId);
    hub.onClientConnect(later);
    const s = later.sent[0];
    return s?.type === "snapshot" ? s.memory : undefined;
  };

  hub.onDaemonMessage(d, { type: "memory", memory });
  hub.onDaemonMessage(d, { type: "memory" });
  assert.deepEqual(memoryMessages().at(-1), { type: "machine.memory", machine: machineId });
  assert.deepEqual(snapshotMemory(), {});

  hub.onDaemonMessage(d, { type: "memory", memory });
  hub.onDaemonMessage(d, { type: "memory", memory: { total: 0, used: 0 } });
  assert.deepEqual(snapshotMemory(), {});

  hub.onDaemonMessage(d, { type: "memory", memory });
  hub.onDaemonClose(d);
  assert.deepEqual(memoryMessages().at(-1), { type: "machine.memory", machine: machineId });
  assert.deepEqual(snapshotMemory(), {});
});

test("a gasho-daemon that does not tell its memory replaces one that did without leaving the old value", () => {
  const { hub, machineId, machineToken, browserId } = setup();
  const newer = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(newer, { type: "hello", machineId, token: machineToken, daemonVersion: "0.25.0" });
  hub.onDaemonMessage(newer, { type: "memory", memory: { total: 16, used: 4 } });
  const older = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(older, { type: "hello", machineId, token: machineToken, daemonVersion: "0.24.0" });
  const c = fakePeer<HubToClient>(browserId);
  hub.onClientConnect(c);
  const s = c.sent[0];
  assert.deepEqual(s?.type === "snapshot" ? s.memory : undefined, {});
});
