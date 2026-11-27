import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import type { CommandResult, HookEvent, HubToDaemon } from "@gasho/protocol";
import { AGY_LOGIN } from "../src/acp.ts";
import { AntigravitySessions, detectAntigravity } from "../src/antigravity.ts";
import { loadConfig } from "../src/config.ts";
import { parseRequest, sessionCommand, type ControlRequest } from "../src/control.ts";
import { Daemon } from "../src/daemon.ts";

const bin = fileURLToPath(new URL("../../../e2e/harness/bin/agy.ts", import.meta.url));
const creds = { server: "http://localhost:1", machineId: "m1", token: "test", name: "ACP" };

async function fixture(t: TestContext, mode?: string) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "gasho-agt-"));
  const file = path.join(dir, "antigravity-sessions.json");
  const log = path.join(dir, "acp.jsonl");
  const oldLog = process.env.GASHO_TEST_ACP_LOG;
  const oldMode = process.env.GASHO_TEST_ACP_MODE;
  process.env.GASHO_TEST_ACP_LOG = log;
  if (mode) process.env.GASHO_TEST_ACP_MODE = mode;
  else delete process.env.GASHO_TEST_ACP_MODE;
  const events: HookEvent[] = [];
  const changes: AntigravitySessions[] = [];
  t.after(async () => {
    for (const sessions of changes) await sessions.close();
    if (oldLog === undefined) delete process.env.GASHO_TEST_ACP_LOG;
    else process.env.GASHO_TEST_ACP_LOG = oldLog;
    if (oldMode === undefined) delete process.env.GASHO_TEST_ACP_MODE;
    else process.env.GASHO_TEST_ACP_MODE = oldMode;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return {
    dir, file,
    events,
    calls: async () => (await fsp.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)),
    make: () => {
      const s = new AntigravitySessions({
        bin, file, describe: async () => ({}), changed: () => {}, event: (event) => events.push(event),
        append: () => {}, log: (...args) => assert.fail(args.join(" ")),
      });
      changes.push(s);
      return s;
    },
  };
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await wait(10);
  assert.ok(check(), "expected ACP update");
}

test("Antigravity detection runs only --version and leaves login unchecked", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await detectAntigravity(bin), { status: "unknown", version: "1.2.3", canLaunch: true, operations: [] });
  assert.deepEqual(await f.calls(), [{ args: ["--version"] }]);
  assert.equal(await detectAntigravity("/dev/null/agy"), undefined);
  assert.equal(loadConfig(creds, { GASHO_AGY_BIN: bin }).agyBin, bin);
  assert.equal(loadConfig(creds, {}).agyBin, "agy");
});

test("ACP sends the exact human text, waits for permission and serializes prompts, with notifications and cancel", async (t) => {
  const f = await fixture(t);
  const s = f.make();
  const id = await s.launch(f.dir, "対話");
  assert.match(id, /^antigravity-/);
  assert.equal(s.sessions()[0]?.status, "idle");

  const first = "権限を確認\n   ";
  const next = "  二つ目\n";
  assert.deepEqual(await s.input(id, first), { ok: true, queued: false });
  assert.deepEqual(await s.input(id, next), { ok: true, queued: true });
  await until(() => s.sessions()[0]?.status === "waiting");
  assert.equal(s.sessions()[0]?.pendingInputs, 1);
  assert.equal((await f.calls()).filter((c) => c.method === "session/prompt").length, 1);
  const permission = s.sessions()[0]!.permissionRequests![0]!.id;
  assert.equal(s.answer(id, permission, "always").ok, false);
  assert.equal(s.answer(id, permission, "allow").ok, true);
  await until(() => s.sessions()[0]?.status === "idle" && !s.sessions()[0]?.pendingInputs);
  const texts = s.page(id, undefined, 100).entries.flatMap((e) => e.blocks).map((b) => b.type === "text" && b.text);
  assert.deepEqual(texts, [first, "偽 ACP の許可を受けました", next, "偽 ACP の応答：二つ目"]);
  assert.deepEqual(f.events.map((e) => e.event), ["UserPromptSubmit", "Notification", "Stop", "UserPromptSubmit", "Stop"]);

  await s.input(id, "権限を拒否");
  await until(() => s.sessions()[0]?.status === "waiting");
  assert.equal(s.answer(id, s.sessions()[0]!.permissionRequests![0]!.id, "deny").ok, true);
  await until(() => s.sessions()[0]?.status === "idle");
  assert.ok(s.page(id, undefined, 10).entries.at(-1)?.blocks.some((b) => b.type === "text" && b.text.includes("拒否")));

  await s.input(id, "割り込み試験");
  assert.equal(s.interrupt(id).ok, true);
  await until(() => s.sessions()[0]?.status === "idle");
  assert.equal(s.page(id, undefined, 10).entries.at(-1)?.interrupted, true);
  const calls = await f.calls();
  assert.deepEqual(calls.filter((c) => c.method === "session/prompt").map((c) => c.params.prompt[0].text), [first, next, "権限を拒否", "割り込み試験"]);
  assert.equal(calls.filter((c) => c.method === "session/cancel").length, 1);
  assert.deepEqual(calls.filter((c) => c.id === "ask").map((c) => c.result.outcome.optionId), ["allow", "deny"]);
});

for (const mode of ["load", "resume", "none"]) {
  test(`saved Antigravity sessions connect only on explicit open (${mode})`, async (t) => {
    const f = await fixture(t, mode);
    const s = f.make();
    const id = await s.launch(f.dir);
    assert.equal((await s.rename(id, "新しい名前")).ok, true);
    await s.close();
    const calls = await f.calls();

    const restarted = f.make();
    await restarted.load();
    assert.equal(restarted.sessions()[0]?.name, "新しい名前");
    assert.equal(restarted.sessions()[0]?.status, "unknown");
    assert.deepEqual(restarted.page(id, undefined, 100).entries, []);
    assert.deepEqual(await f.calls(), calls);
    const opened = await restarted.open(id);
    if (mode === "none") {
      assert.match(opened.error ?? "", /保存済みの会話を再開できません/);
    } else {
      assert.equal(opened.ok, true);
      if (mode === "load") assert.deepEqual(restarted.page(id, undefined, 100).entries.map((e) => e.role), ["user", "assistant"]);
      else assert.ok((await f.calls()).some((c) => c.method === "session/resume"));
      await restarted.input(id, "再開");
      await until(() => restarted.sessions()[0]?.status === "idle");
    }
    assert.equal((await restarted.remove(id)).ok, true);
    assert.deepEqual(restarted.sessions(), []);
    assert.equal((await f.calls()).filter((c) => c.method === "session/new").length, 1);
    assert.deepEqual(JSON.parse(await fsp.readFile(f.file, "utf8")), []);
  });
}

test("authentication required gives the terminal instruction without sending authenticate", async (t) => {
  const f = await fixture(t, "auth");
  const s = f.make();
  await assert.rejects(s.launch(f.dir), { message: AGY_LOGIN });
  assert.deepEqual(s.sessions(), []);
  assert.deepEqual((await f.calls()).map((c) => c.method).filter(Boolean), ["initialize", "session/new"]);
});

test("disconnection records queued prompts in the conversation without resending them", async (t) => {
  const f = await fixture(t);
  const s = f.make();
  const id = await s.launch(f.dir);
  await s.input(id, "権限の確認後に切断");
  const waiting = ["  待っていた発言\n次の行", "もう一つの発言"];
  for (const text of waiting) assert.equal((await s.input(id, text)).queued, true);
  await until(() => s.sessions()[0]?.status === "waiting");
  assert.equal(s.answer(id, s.sessions()[0]!.permissionRequests![0]!.id, "deny").ok, true);
  await until(() => s.sessions()[0]?.status === "unknown");
  assert.equal(s.waitingInputs(), 0);
  const discarded = (sessions: AntigravitySessions) => sessions.page(id, undefined, 10).entries
    .filter((entry) => entry.role === "system" && entry.blocks[0]?.type === "text" && entry.blocks[0].text.includes("送信待ちの発言を破棄"))
    .map((entry) => entry.blocks[1]);
  const expected = waiting.map((text) => ({ type: "text", text }));
  assert.deepEqual(discarded(s), expected);
  assert.equal((await f.calls()).filter((c) => c.method === "session/prompt").length, 1);

  await s.close();
  const restarted = f.make();
  await restarted.load();
  assert.deepEqual(discarded(restarted), expected);
  await restarted.input(id, "次の発言");
  await until(() => restarted.sessions()[0]?.status === "idle");
  assert.deepEqual(discarded(restarted), expected);
  assert.deepEqual((await f.calls()).filter((c) => c.method === "session/prompt").map((c) => c.params.prompt[0].text), ["権限の確認後に切断", "次の発言"]);
});

test("the session launch CLI refuses Antigravity before reading a prompt or connecting", async () => {
  await assert.rejects(sessionCommand(["launch", "--cwd", "/work", "--agent", "antigravity", "--prompt-file", "/unused"], {
    request: async () => assert.fail("control socket called"),
    readFile: async () => assert.fail("prompt file read"),
    readStdin: async () => assert.fail("stdin read"),
    out: () => assert.fail("unexpected output"),
    note: () => assert.fail("unexpected note"),
    sleep: async () => assert.fail("unexpected wait"),
  }), /Gasho の画面から/);
});

test("daemon rejects control and plugin routes while listing an Antigravity session", async (t) => {
  const f = await fixture(t);
  const replies = new Map<string, CommandResult>();
  const daemon = new Daemon(loadConfig(creds, {
    GASHO_AGY_BIN: bin, GASHO_DAEMON_CONFIG: path.join(f.dir, "daemon.json"),
    GASHO_CLAUDE_DIR: path.join(f.dir, "claude"), XDG_DATA_HOME: f.dir, XDG_CACHE_HOME: f.dir,
  }));
  const d = daemon as unknown as {
    antigravitySessions: AntigravitySessions;
    onHubMessage(m: HubToDaemon): Promise<void>;
    onControl(req: ControlRequest): Promise<CommandResult>;
    controlSessions(): { agent: string; sessionId: string }[];
    hub: { send: (m: { type: string; requestId: string; result: CommandResult }) => void };
  };
  t.after(() => d.antigravitySessions.close());
  d.hub.send = (m) => { if (m.type === "command.result") replies.set(m.requestId, m.result); };
  const launch = { cwd: f.dir, agent: "antigravity" } as const;
  assert.match((await d.onControl(parseRequest({ op: "session.launch", ...launch }))).error ?? "", /Gasho の画面から/);
  await d.onHubMessage({ type: "session.launch", requestId: "plugin-launch", ...launch });
  assert.match(replies.get("plugin-launch")?.error ?? "", /Gasho の画面から/);
  await d.onHubMessage({ type: "session.launch", requestId: "screen-launch", screen: true, ...launch });
  const id = replies.get("screen-launch")?.sessionId;
  assert.ok(id);
  assert.ok(d.controlSessions().some((s) => s.agent === "antigravity" && s.sessionId === id));
  assert.match((await d.onControl({ op: "session.input", sessionId: id, text: "plugin" })).error ?? "", /Gasho の画面から/);
  assert.match((await d.onControl({ op: "session.fork", sessionId: id })).error ?? "", /分岐できません/);
  await d.onHubMessage({ type: "session.input", requestId: "plugin-input", sessionId: id, text: "plugin", via: "demo-plugin", screen: true });
  assert.match(replies.get("plugin-input")?.error ?? "", /Gasho の画面から/);
  await d.onHubMessage({ type: "permission.answer", requestId: "agent-answer", sessionId: id, permissionId: "ask", decision: "allow" });
  assert.match(replies.get("agent-answer")?.error ?? "", /Gasho の画面から/);
  assert.equal((await f.calls()).filter((c) => c.method === "session/prompt").length, 0);
});
