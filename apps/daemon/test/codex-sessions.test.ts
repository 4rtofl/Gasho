// Codex's sessions, against a stand-in for its app-server on a Unix socket.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import type { HookEvent, SessionInfo, TranscriptEntry } from "@gasho/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { CodexSessions } from "../src/codex-sessions.ts";

const THREAD = "thread-1";

interface Call {
  method: string;
  params: Record<string, unknown>;
}

type Handler = (params: Record<string, unknown>) => unknown;

/** Answers what gasho-daemon asks, and says what the test tells it to. */
class FakeAppServer {
  calls: Call[] = [];
  answers: { id: unknown; result?: unknown; error?: unknown }[] = [];
  clients = new Set<WebSocket>();
  handlers = new Map<string, Handler>();
  status: Record<string, unknown> = { type: "idle" };
  private http: http.Server;
  private wss: WebSocketServer;
  readonly socket: string;

  constructor(socket: string) {
    this.socket = socket;
    this.http = http.createServer();
    this.wss = new WebSocketServer({ server: this.http });
    this.wss.on("connection", (ws) => {
      this.clients.add(ws);
      ws.on("close", () => this.clients.delete(ws));
      ws.on("message", (data) => this.onMessage(ws, JSON.parse(String(data)) as Record<string, unknown>));
    });
  }

  listen(): Promise<void> {
    return new Promise((resolve) => this.http.listen(this.socket, resolve));
  }

  close(): Promise<void> {
    for (const c of this.clients) c.terminate();
    this.wss.close();
    return new Promise((resolve) => this.http.close(() => resolve()));
  }

  private onMessage(ws: WebSocket, m: Record<string, unknown>): void {
    if (typeof m.method !== "string") {
      this.answers.push({ id: m.id, result: m.result, error: m.error });
      return;
    }
    if (m.id === undefined) return;
    const params = (m.params ?? {}) as Record<string, unknown>;
    this.calls.push({ method: m.method, params });
    try {
      ws.send(JSON.stringify({ id: m.id, result: this.answer(m.method, params) }));
    } catch (e) {
      ws.send(JSON.stringify({ id: m.id, error: { code: -32600, message: (e as Error).message } }));
    }
  }

  private answer(method: string, params: Record<string, unknown>): unknown {
    const handler = this.handlers.get(method);
    if (handler) return handler(params);
    const thread = { id: params.threadId ?? THREAD, cwd: params.cwd ?? "/work", status: this.status, name: null, createdAt: 100, updatedAt: 200 };
    switch (method) {
      case "thread/start":
      case "thread/resume":
        return { thread, model: "gpt-test" };
      case "turn/start":
        return { turn: { id: `turn-${this.called("turn/start").length}`, status: "inProgress" } };
      case "thread/turns/list":
        return { data: [], nextCursor: null };
      case "thread/items/list":
        return { data: [], nextCursor: null };
      default:
        return {};
    }
  }

  called(method: string): Call[] {
    return this.calls.filter((c) => c.method === method);
  }

  notify(method: string, params: Record<string, unknown>): void {
    for (const c of this.clients) c.send(JSON.stringify({ method, params: { threadId: THREAD, ...params } }));
  }

  ask(id: string | number, method: string, params: Record<string, unknown>): void {
    for (const c of this.clients) c.send(JSON.stringify({ id, method, params: { threadId: THREAD, ...params } }));
  }

  dropClients(): void {
    for (const c of this.clients) c.terminate();
  }
}

async function until(what: string, ok: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-codex-"));
  const server = new FakeAppServer(path.join(dir, "s.sock"));
  await server.listen();
  const events: HookEvent[] = [];
  const appended: TranscriptEntry[] = [];
  const file = path.join(dir, "codex-threads.json");
  const make = () =>
    new CodexSessions({
      file,
      version: "0.0.0",
      startServer: async () => server.socket,
      describe: async () => ({ gitBranch: "main" }),
      changed: () => undefined,
      event: (e) => events.push(e),
      append: (_id, entries) => appended.push(...entries),
      log: () => undefined,
    });
  t.after(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sessions = make();
  const info = (s: CodexSessions = sessions): SessionInfo => {
    const found = s.sessions()[0];
    assert.ok(found);
    return found;
  };
  return { dir, server, sessions, events, appended, file, make, info, named: (name: string) => events.filter((e) => e.event === name) };
}

test("a session starts with its folder alone, and shows as a session of Codex", async (t) => {
  const { server, sessions, info } = await setup(t);
  const id = await sessions.launch("/work", "調査");
  assert.equal(id, THREAD);
  assert.deepEqual(server.called("thread/start")[0]?.params, { cwd: "/work" });
  assert.deepEqual(server.called("thread/name/set")[0]?.params, { threadId: THREAD, name: "調査" });
  const s = info();
  assert.equal(s.agent, "codex");
  assert.equal(s.status, "idle");
  assert.equal(s.managed, true);
  assert.equal(s.rcMode, "none");
  assert.equal(s.model, "gpt-test");
  assert.equal(s.name, "調査");
  assert.equal(s.title, "調査");
  assert.equal(s.gitBranch, "main");
  assert.equal(s.pid, undefined);
});

test("a thread's status follows what Codex says, and the name Codex gives it is taken", async (t) => {
  const { server, sessions, info } = await setup(t);
  await sessions.launch("/work", undefined);
  server.notify("thread/status/changed", { status: { type: "active", activeFlags: ["waitingOnApproval"] } });
  await until("waiting", () => info().status === "waiting");
  server.notify("thread/name/updated", { threadName: "テストの追加" });
  await until("named", () => info().name === "テストの追加");
  assert.equal(info().title, "テストの追加");
});

test("an input to an idle session starts a turn; while it works, inputs wait and go one at a time", async (t) => {
  const { server, sessions, info } = await setup(t);
  await sessions.launch("/work", undefined);
  assert.deepEqual(await sessions.input(THREAD, "1つ目"), { ok: true, queued: false });
  assert.deepEqual(server.called("turn/start")[0]?.params.input, [{ type: "text", text: "1つ目", text_elements: [] }]);
  assert.equal(info().status, "busy");

  assert.deepEqual(await sessions.input(THREAD, "2つ目"), { ok: true, queued: true });
  assert.deepEqual(await sessions.input(THREAD, "3つ目"), { ok: true, queued: true });
  assert.equal(info().pendingInputs, 2);
  assert.equal(server.called("turn/start").length, 1);

  server.notify("thread/status/changed", { status: { type: "idle" } });
  await until("the second input", () => server.called("turn/start").length === 2);
  assert.equal((server.called("turn/start")[1]?.params.input as { text: string }[])[0]?.text, "2つ目");
  await until("one left", () => info().pendingInputs === 1);
  assert.equal(server.called("turn/start").length, 2);
});

test("an input that Codex refuses is said to be refused, and does not wait", async (t) => {
  const { server, sessions, info } = await setup(t);
  await sessions.launch("/work", undefined);
  server.handlers.set("turn/start", () => {
    throw new Error("thread is archived");
  });
  const r = await sessions.input(THREAD, "x");
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /thread is archived/);
  assert.equal(info().pendingInputs, undefined);
});

test("the events of a turn are those the Gasho server makes notifications from", async (t) => {
  const { server, sessions, named } = await setup(t);
  await sessions.launch("/work", undefined);
  await sessions.input(THREAD, "お願いします");
  server.notify("turn/started", { turn: { id: "turn-1", status: "inProgress" } });
  await until("the start", () => named("UserPromptSubmit").length === 1);
  assert.equal(named("UserPromptSubmit")[0]?.summary, "お願いします");

  server.notify("item/completed", { item: { type: "agentMessage", id: "m1", text: "終わりました" } });
  server.notify("turn/completed", { turn: { id: "turn-1", status: "completed", items: [] } });
  await until("the end", () => named("Stop").length === 1);
  assert.equal(named("Stop")[0]?.summary, "終わりました");

  server.notify("turn/completed", { turn: { id: "turn-2", status: "failed", error: { message: "上限です" } } });
  await until("the failure", () => named("StopFailure").length === 1);
  assert.equal(named("StopFailure")[0]?.summary, "上限です");
});

test("an interrupted turn stops by its id, leaves its mark, and is no Stop", async (t) => {
  const { server, sessions, appended, named } = await setup(t);
  await sessions.launch("/work", undefined);
  await sessions.input(THREAD, "x");
  assert.deepEqual(await sessions.interrupt(THREAD), { ok: true });
  assert.deepEqual(server.called("turn/interrupt")[0]?.params, { threadId: THREAD, turnId: "turn-1" });
  server.notify("turn/completed", { turn: { id: "turn-1", status: "interrupted" } });
  await until("the mark", () => appended.some((e) => e.interrupted === true));
  assert.equal(named("Stop").length, 0);
  assert.deepEqual(await sessions.interrupt(THREAD), { ok: false, error: "作業中ではありません。" });
});

test("an approval shows until it is answered, and the answer goes back to Codex", async (t) => {
  const { server, sessions, info, named } = await setup(t);
  await sessions.launch("/work", undefined);
  server.ask(11, "item/commandExecution/requestApproval", { command: "rm a", proposedExecpolicyAmendment: ["rm", "a"] });
  await until("the request", () => info().permissionRequests?.length === 1);
  assert.equal(info().permissionRequests?.[0]?.always, "rm a");
  assert.equal(named("Notification")[0]?.notificationType, "permission_prompt");
  assert.equal(named("Notification")[0]?.toolName, "Bash");

  assert.equal(sessions.answer(THREAD, "codex-11", "always", undefined), undefined);
  await until("the answer", () => server.answers.length === 1);
  assert.deepEqual(server.answers[0]?.result, { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["rm", "a"] } } });
  assert.equal(info().permissionRequests, undefined);
  assert.ok(sessions.answer(THREAD, "codex-11", "allow", undefined));
});

test("an approval answered elsewhere goes away", async (t) => {
  const { server, sessions, info } = await setup(t);
  await sessions.launch("/work", undefined);
  server.ask(12, "item/commandExecution/requestApproval", { command: "ls" });
  await until("the request", () => info().permissionRequests?.length === 1);
  server.notify("serverRequest/resolved", { requestId: 12 });
  await until("gone", () => info().permissionRequests === undefined);
  assert.equal(server.answers.length, 0);
});

test("what Gasho cannot answer is refused at once; another client's thread is left to that client", async (t) => {
  const { server, sessions, info } = await setup(t);
  await sessions.launch("/work", undefined);
  server.ask(13, "mcpServer/elicitation/request", {});
  await until("the refusal", () => server.answers.length === 1);
  assert.equal(server.answers[0]?.id, 13);
  assert.ok(server.answers[0]?.error);

  server.ask(14, "item/commandExecution/requestApproval", { threadId: "someone-elses", command: "ls" });
  server.notify("thread/status/changed", { threadId: "someone-elses", status: { type: "active", activeFlags: [] } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(server.answers.length, 1);
  assert.equal(info().permissionRequests, undefined);
  assert.equal(info().status, "idle");
});

test("the conversation is read page by page, and what comes later is added once", async (t) => {
  const { server, sessions, appended } = await setup(t);
  await sessions.launch("/work", undefined);
  server.handlers.set("thread/turns/list", (p) =>
    p.cursor ? { data: [{ id: "t2", status: "interrupted" }], nextCursor: null } : { data: [{ id: "t1", status: "completed" }], nextCursor: "next-turns" },
  );
  server.handlers.set("thread/items/list", (p) =>
    p.cursor
      ? { data: [{ turnId: "t2", item: { type: "userMessage", id: "u2", content: [{ type: "text", text: "b" }] } }], nextCursor: null }
      : { data: [{ turnId: "t1", item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "a" }] } }], nextCursor: "next-items" },
  );
  const last = await sessions.page(THREAD, undefined, 2);
  assert.deepEqual(last.entries.map((e) => e.uuid), ["u2", "t2:interrupted"]);
  assert.equal(last.start, 1);
  assert.equal(last.total, 3);
  assert.deepEqual((await sessions.page(THREAD, 1, 2)).entries.map((e) => e.uuid), ["u1"]);

  const item = { type: "agentMessage", id: "m9", text: "c" };
  server.notify("item/completed", { item });
  server.notify("item/completed", { item });
  await until("the new entry", () => appended.length > 0);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(appended.map((e) => e.uuid), ["m9"]);
  assert.equal((await sessions.page(THREAD, undefined, 10)).total, 4);
});

test("a thread with no message yet has an empty conversation", async (t) => {
  const { server, sessions } = await setup(t);
  await sessions.launch("/work", undefined);
  server.handlers.set("thread/turns/list", () => {
    throw new Error("thread thread-1 is not materialized yet; thread/turns/list is unavailable before first user message");
  });
  assert.deepEqual(await sessions.page(THREAD, undefined, 80), { entries: [], start: 0, total: 0 });
  assert.equal(server.called("thread/items/list").length, 0);
});

test("after the connection ends, it connects again: the thread is loaded, waiting inputs go, and an approval is not told twice", async (t) => {
  const { server, sessions, info, named } = await setup(t);
  await sessions.launch("/work", undefined);
  server.ask(15, "item/commandExecution/requestApproval", { command: "ls" });
  await until("the request", () => info().permissionRequests?.length === 1);

  server.dropClients();
  await until("the end of the connection", () => info().status === "unknown");
  assert.equal(info().permissionRequests, undefined);
  assert.deepEqual(await sessions.input(THREAD, "待っている発言"), { ok: true, queued: true });

  await until("the thread loaded again", () => server.called("thread/resume").length === 1, 8000);
  assert.deepEqual(server.called("thread/resume")[0]?.params, { threadId: THREAD, excludeTurns: true });
  await until("the input sent", () => server.called("turn/start").length === 1);

  await until("connected", () => server.clients.size === 1);
  server.ask(15, "item/commandExecution/requestApproval", { command: "ls" });
  await until("the request again", () => info().permissionRequests?.length === 1);
  assert.equal(named("Notification").length, 1);
});

test("a turn that ended while the connection was gone is told, and its messages reach the browsers", async (t) => {
  const { server, sessions, info, appended, named } = await setup(t);
  await sessions.launch("/work", undefined);
  await sessions.page(THREAD, undefined, 80);
  await sessions.input(THREAD, "長い作業");
  assert.equal(info().status, "busy");

  server.handlers.set("thread/turns/list", () => ({ data: [{ id: "turn-1", status: "completed" }], nextCursor: null }));
  server.handlers.set("thread/items/list", () => ({ data: [{ turnId: "turn-1", item: { type: "agentMessage", id: "m1", text: "終わりました" } }], nextCursor: null }));
  server.dropClients();
  await until("the Stop", () => named("Stop").length === 1, 8000);
  assert.equal(named("Stop")[0]?.summary, "終わりました");
  assert.deepEqual(appended.map((e) => e.uuid), ["m1"]);
});

test("after a restart of gasho-daemon, the sessions are loaded again from the file", async (t) => {
  const { server, sessions, make, info, file } = await setup(t);
  await sessions.launch("/work", "続きの作業");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  server.dropClients();

  server.status = { type: "active", activeFlags: [] };
  server.handlers.set("thread/turns/list", () => ({ data: [{ id: "turn-7", status: "inProgress" }], nextCursor: null }));
  const again = make();
  await again.load();
  await until("loaded", () => again.sessions()[0]?.status === "busy");
  assert.equal(info(again).name, "続きの作業");
  assert.deepEqual(await again.interrupt(THREAD), { ok: true });
  assert.equal(server.called("turn/interrupt").at(-1)?.params.turnId, "turn-7");
});

test("a thread Codex no longer has is taken off the list", async (t) => {
  const { server, sessions, make, named } = await setup(t);
  await sessions.launch("/work", undefined);
  server.dropClients();
  server.handlers.set("thread/resume", () => {
    throw new Error(`no rollout found for thread id ${THREAD}`);
  });
  const again = make();
  await again.load();
  await until("gone", () => again.sessions().length === 0);
  assert.equal(named("SessionEnd").length >= 1, true);
});

test("removing a session stops its turn and leaves the thread; the conversation stays with Codex", async (t) => {
  const { server, sessions, make, named, file } = await setup(t);
  await sessions.launch("/work", undefined);
  await sessions.input(THREAD, "x");
  assert.deepEqual(await sessions.remove(THREAD), { ok: true });
  assert.deepEqual(server.called("turn/interrupt")[0]?.params, { threadId: THREAD, turnId: "turn-1" });
  assert.deepEqual(server.called("thread/unsubscribe")[0]?.params, { threadId: THREAD });
  assert.equal(sessions.has(THREAD), false);
  assert.equal(named("SessionEnd").length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), []);
  const again = make();
  await again.load();
  assert.equal(again.sessions().length, 0);
});
