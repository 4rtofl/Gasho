// Sessions nobody uses are hibernated and brought back with `claude --resume`: what decides (hibernate.ts), and the
// daemon's part against a fake terminal, a fake `claude agents` and processes standing in for Claude Code.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Daemon } from "../src/daemon.ts";
import { DEFAULT_HIBERNATE_MINUTES, type HibernateFacts, hibernateAfterMs, mayHibernate, modelFlag, resumeArgs } from "../src/hibernate.ts";
import { ManagedSessions, plainScreen } from "../src/managed.ts";
import type { TerminalStart } from "../src/terminal.ts";
import { emptyMeta, TranscriptTail } from "../src/transcript.ts";

const HOUR = 3600_000;
const NOW = 1_800_000_000_000;
const facts = (extra: Partial<HibernateFacts> = {}): HibernateFacts => ({
  zellij: false,
  resumable: true,
  status: "idle",
  claudeStatus: "idle",
  background: 0,
  pendingInputs: 0,
  permissionRequests: 0,
  operating: false,
  scheduled: false,
  typed: "",
  attached: false,
  activity: [NOW - 2 * HOUR],
  ...extra,
});

test("the time before hibernating is 90 minutes, can be changed down to an hour, and hibernating can be turned off", () => {
  assert.equal(DEFAULT_HIBERNATE_MINUTES, 90);
  assert.equal(hibernateAfterMs({}), 90 * 60_000);
  assert.equal(hibernateAfterMs({ GASHO_HIBERNATE_AFTER_MINUTES: "120" }), 120 * 60_000);
  assert.equal(hibernateAfterMs({ GASHO_HIBERNATE_AFTER_MINUTES: "5" }), 60 * 60_000);
  assert.equal(hibernateAfterMs({ GASHO_HIBERNATE_AFTER_MINUTES: "soon" }), 90 * 60_000);
  assert.equal(hibernateAfterMs({ GASHO_HIBERNATE: "off" }), undefined);
  assert.equal(hibernateAfterMs({ GASHO_HIBERNATE: "OFF", GASHO_HIBERNATE_AFTER_MINUTES: "120" }), undefined);
});

test("a session left alone long enough is hibernated, and the latest activity of any source counts", () => {
  assert.equal(mayHibernate(facts(), NOW, HOUR), true);
  assert.equal(mayHibernate(facts({ activity: [NOW - HOUR] }), NOW, HOUR), true);
  assert.equal(mayHibernate(facts({ activity: [NOW - HOUR + 1] }), NOW, HOUR), false);
  assert.equal(mayHibernate(facts({ activity: [NOW - 5 * HOUR, undefined, NOW - 60_000] }), NOW, HOUR), false);
  assert.equal(mayHibernate(facts({ activity: [undefined] }), NOW, HOUR), false);
});

const KEPT_AWAKE: [string, Partial<HibernateFacts>][] = [
  ["in zellij", { zellij: true }],
  ["that cannot be resumed", { resumable: false }],
  ["working", { status: "busy" }],
  ["waiting for an answer", { status: "waiting" }],
  ["in an unknown state", { status: "unknown" }],
  ["with shells running on, shown as idle", { claudeStatus: "shell" }],
  ["with background work", { background: 1 }],
  ["with an input waiting", { pendingInputs: 1 }],
  ["with a permission request", { permissionRequests: 1 }],
  ["that gasho-daemon is working on", { operating: true }],
  ["with work scheduled in its process", { scheduled: true }],
  ["with text in its prompt box", { typed: "書きかけ" }],
  ["with a dialog open", { typed: undefined }],
  ["with its terminal open", { attached: true }],
];
for (const [what, extra] of KEPT_AWAKE) {
  test(`a session ${what} is not hibernated`, () => assert.equal(mayHibernate(facts(extra), NOW, HOUR), false));
}

test("a resume names the model and effort level the session had, for Claude Code does not keep them", () => {
  assert.equal(modelFlag("Opus 5.5"), "claude-opus-5-5");
  assert.equal(modelFlag("Haiku 5.5"), "claude-haiku-5-5");
  assert.equal(modelFlag("Sonnet 4"), "claude-sonnet-4");
  assert.equal(modelFlag("Opus 4.6 (1M context)"), "claude-opus-4-6[1m]");
  assert.equal(modelFlag("Sonnet 5.5 (default)"), "claude-sonnet-5-5");
  assert.equal(modelFlag("<synthetic>"), undefined);
  assert.equal(modelFlag(undefined), undefined);
  assert.deepEqual(resumeArgs("id", { model: "Sonnet 5.5", effort: "xhigh" }), ["--resume", "id", "--model", "claude-sonnet-5-5", "--effort", "xhigh"]);
  assert.deepEqual(resumeArgs("id", {}), ["--resume", "id"]);
});

test("what waits for a hibernated session is saved with it, and nothing else that waits is", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-hibernate-"));
  try {
    const file = path.join(dir, "managed.json");
    const a = new ManagedSessions(file);
    a.add({ sessionId: "asleep", terminal: "t1", pid: 1, cwd: "/a", name: "a", launchedAt: 1, hibernated: { at: 2, effort: "low" } });
    a.add({ sessionId: "awake", terminal: "t2", pid: 2, cwd: "/b", name: "b", launchedAt: 1 });
    a.enqueue("asleep", { id: "r1", text: "続きを" });
    a.enqueue("asleep", { text: "/rename a", auto: true });
    a.enqueue("awake", { text: "消える" });
    await a.save();

    const b = new ManagedSessions(file);
    await b.load(async () => true);
    assert.deepEqual(b.get("asleep")?.hibernated, { at: 2, effort: "low" });
    assert.deepEqual(b.waiting("asleep"), [{ id: "r1", text: "続きを" }]);
    assert.equal(b.pending("awake"), 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("work Claude scheduled to run later is noticed in the transcript", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-hibernate-"));
  try {
    const file = path.join(dir, "t.jsonl");
    const call = (name: string, at: string) =>
      JSON.stringify({ type: "assistant", uuid: name, timestamp: at, message: { role: "assistant", content: [{ type: "tool_use", id: name, name, input: {} }] } });
    await fs.writeFile(file, `${call("Read", "2026-11-18T01:00:00.000Z")}\n${call("CronCreate", "2026-11-18T02:00:00.000Z")}\n${call("Bash", "2026-11-18T03:00:00.000Z")}\n`);
    const meta = emptyMeta();
    for await (const _ of new TranscriptTail(file).read(meta)) void _;
    assert.equal(meta.scheduledAt, Date.parse("2026-11-18T02:00:00.000Z"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

const SID = "11111111-2222-3333-4444-777777777777";
const RULE = "─".repeat(50);

/** A process standing in for Claude Code, ready for SIGTERM. */
async function claudeProcess(): Promise<ChildProcess> {
  const p = spawn(process.execPath, ["-e", `setInterval(() => {}, 1000); console.log("ready")`], { stdio: ["ignore", "pipe", "ignore"] });
  await once(p.stdout!, "data");
  return p;
}

const until = async (done: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !done(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(done(), what);
};

/** A daemon with one session started from Gasho, left alone for hours. */
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-hibernate-"));
  const agentsFile = path.join(dir, "agents.json");
  const claude = path.join(dir, "claude");
  await fs.writeFile(claude, `#!/bin/sh\ncat '${agentsFile}'\n`, { mode: 0o755 });
  const folder = path.join(dir, "work");
  await fs.mkdir(folder);
  const claudeDir = path.join(dir, "claude-dir");
  await fs.mkdir(path.join(claudeDir, "projects", "p"), { recursive: true });
  const old = new Date(Date.now() - 5 * HOUR).toISOString();
  await fs.writeFile(
    path.join(claudeDir, "projects", "p", `${SID}.jsonl`),
    `${JSON.stringify({ type: "assistant", uuid: "a1", timestamp: old, cwd: folder, effort: "low", message: { role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "はい" }] } })}\n`,
  );
  const cfg = {
    hubUrl: "ws://127.0.0.1:1",
    machineId: "m",
    token: "t",
    hookPort: 0,
    claudeDir,
    claudeBin: claude,
    ghBin: "gh",
    pollIntervalMs: 60_000,
    stateDir: dir,
    attachmentsDir: path.join(dir, "attachments"),
    pluginDataDir: path.join(dir, "plugin-data"),
    hibernateAfterMs: HOUR,
  } as ConstructorParameters<typeof Daemon>[0];
  const procs: ChildProcess[] = [await claudeProcess()];
  const agents = (rows: object[]) => writeFileSync(agentsFile, JSON.stringify(rows));
  const row = (pid: number) => ({ pid, sessionId: SID, cwd: folder, status: "idle", startedAt: Date.now() - 5 * HOUR });
  agents([row(procs[0]!.pid!)]);

  // The terminal: its prompt box, what was entered into it, and whether ultracode is on.
  const term = { typed: "", entered: [] as string[], ultracode: false, viewers: 0, live: new Map<string, { pid: number; exited?: object }>() };
  const killed: string[] = [];
  const started: TerminalStart[] = [];
  const terminals = {
    start: async (o: TerminalStart) => {
      started.push(o);
      const p = await claudeProcess();
      procs.push(p);
      agents([row(p.pid!)]);
      return p.pid;
    },
    screen: async () =>
      plainScreen([`${RULE.slice(0, 30)}${term.ultracode ? " ultracode ─" : ""}`, `❯ ${term.typed}`, RULE, "  ⏵⏵ auto mode on (shift+tab to cycle)", ""].join("\n")),
    paste: async (_s: string, text: string) => {
      term.typed = text;
    },
    keys: async (_s: string, ...keys: string[]) => {
      for (const k of keys) {
        if (k === "Ctrl u" || k === "Backspace") term.typed = "";
        if (k !== "Enter") continue;
        term.entered.push(term.typed);
        if (term.typed === "/effort ultracode on") term.ultracode = true;
        term.typed = "";
      }
    },
    kill: async (name: string) => {
      killed.push(name);
    },
    builtIn: { hello: async () => ({ viewers: term.viewers }), live: async () => term.live },
  };
  const make = () => {
    const d = new Daemon(cfg) as unknown as Record<string, any>;
    d.canLaunch = true;
    d.terminals = terminals;
    d.readManagedScreens = async () => undefined;
    d.countTokens = async () => undefined;
    d.refreshFolders = async () => undefined;
    d.sent = [];
    d.hub = { connected: true, send: (m: { type: string; sessions?: object[] }) => m.type === "sessions" && d.sent.push(m.sessions) };
    return d;
  };
  const d = make();
  d.managed.add({ sessionId: SID, terminal: "t1", pid: procs[0]!.pid, cwd: folder, name: "眠るセッション", launchedAt: Date.now() - 5 * HOUR });
  await d.refresh();
  const shown = (daemon = d) => daemon.sent.at(-1)?.find((s: { sessionId: string }) => s.sessionId === SID);
  return {
    d,
    make,
    term,
    killed,
    started,
    agents,
    row,
    procs,
    folder,
    shown,
    done: async () => {
      for (const p of procs) p.kill("SIGKILL");
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test("a session left alone ends with its terminal, stays listed as it was, and can still be read", async () => {
  const { d, killed, agents, procs, shown, folder, done } = await setup();
  try {
    await d.hibernateIdle();
    assert.equal(procs[0]!.signalCode, "SIGTERM");
    assert.deepEqual(killed, ["t1"]);
    agents([]);
    await d.refresh();
    assert.equal(d.managed.has(SID), true);
    assert.equal(shown().hibernation, "hibernated");
    assert.equal(shown().status, "idle");
    assert.equal(shown().name, "眠るセッション");
    assert.equal(shown().model, "Haiku 5.5");
    assert.equal(shown().pid, undefined);
    assert.equal(d.tracked.get(SID).tail !== undefined, true);
    // Not offered as a past conversation too.
    assert.deepEqual((await d.history(folder, false)).history, []);
  } finally {
    await done();
  }
});

test("text in the prompt box, an open terminal or a waiting input keep a session running", async () => {
  const { d, term, procs, done } = await setup();
  try {
    term.typed = "書きかけ";
    await d.hibernateIdle();
    term.typed = "";
    term.viewers = 1;
    await d.hibernateIdle();
    term.viewers = 0;
    d.managed.enqueue(SID, { text: "待っている" });
    await d.hibernateIdle();
    assert.equal(procs[0]!.signalCode, null);
    assert.equal(d.managed.get(SID).hibernated, undefined);
  } finally {
    await done();
  }
});

test("an input brings the session back as it was, and is typed once it runs", async () => {
  const { d, term, started, agents, shown, done } = await setup();
  try {
    d.tracked.get(SID).info.ultracode = true;
    await d.hibernateIdle();
    agents([]);
    await d.refresh();
    assert.deepEqual(await d.input({ type: "session.input", requestId: "r1", sessionId: SID, text: "続きをお願いします" }), { ok: true, queued: true });
    assert.equal(shown().hibernation, "resuming");
    assert.equal(shown().pendingInputs, 1);
    await d.waking.get(SID);
    await until(() => term.entered.includes("続きをお願いします"), "the input was typed");

    assert.equal(started.length, 1);
    assert.deepEqual(started[0]!.args.slice(0, 7), ["--remote-control=眠るセッション", "--resume", SID, "--model", "claude-haiku-5-5", "--effort", "low"]);
    // Ultracode first: the input goes out with the session as it was.
    assert.deepEqual(term.entered, ["/effort ultracode on", "続きをお願いします"]);
    const m = d.managed.get(SID);
    assert.equal(m.hibernated, undefined);
    assert.equal(m.terminal, started[0]!.name);
    await d.refresh();
    assert.equal(shown().hibernation, undefined);
  } finally {
    await done();
  }
});

test("a session that cannot come back says why, keeps the input, and comes back when asked again", async () => {
  const { d, make, term, agents, shown, done } = await setup();
  const start = d.terminals.start;
  try {
    await d.hibernateIdle();
    agents([]);
    d.terminals.start = async () => {
      throw new Error("no terminal");
    };
    assert.equal((await d.input({ type: "session.input", requestId: "r1", sessionId: SID, text: "失いたくない発言" })).ok, true);
    await d.waking.get(SID);
    assert.equal(shown().hibernation, "hibernated");
    assert.match(shown().resumeError, /起動できませんでした/);
    assert.equal(shown().pendingInputs, 1);

    // Kept over a restart of gasho-daemon too.
    const again = make();
    await again.loadManaged();
    assert.equal(again.managed.waiting(SID)[0].text, "失いたくない発言");
    assert.match(again.managed.get(SID).hibernated.resumeError, /起動できませんでした/);

    d.terminals.start = start;
    assert.equal(d.wakeAsked(SID).ok, true);
    await d.waking.get(SID);
    await until(() => term.entered.includes("失いたくない発言"), "the input was typed");
    assert.equal(d.managed.get(SID).hibernated, undefined);
  } finally {
    await done();
  }
});

test("a restart of gasho-daemon keeps a hibernated session, and its conversation can still be read", async () => {
  const { d, make, agents, shown, done } = await setup();
  try {
    await d.hibernateIdle();
    agents([]);
    const again = make();
    await again.loadManaged();
    await again.refresh();
    assert.equal(shown(again).hibernation, "hibernated");
    assert.equal(shown(again).name, "眠るセッション");
    assert.equal(shown(again).model, "Haiku 5.5");
    assert.equal(shown(again).effort, "low");
    assert.ok(again.tracked.get(SID).tail);
  } finally {
    await done();
  }
});

test("renaming a hibernated session does not wake it; Claude Code is told once it is back", async () => {
  const { d, term, started, agents, done } = await setup();
  try {
    await d.hibernateIdle();
    agents([]);
    assert.equal((await d.rename(SID, "新しい名前", "r1")).ok, true);
    assert.equal(started.length, 0);
    assert.equal(d.managed.get(SID).name, "新しい名前");
    await d.wake(SID);
    await until(() => term.entered.includes("/rename 新しい名前"), "/rename was typed");
    assert.equal(started[0]!.args[0], "--remote-control=新しい名前");
  } finally {
    await done();
  }
});

test("a hibernated session opened outside Gasho is no longer Gasho's", async () => {
  const { d, agents, row, procs, shown, done } = await setup();
  try {
    await d.hibernateIdle();
    agents([row(procs[0]!.pid!)]);
    // The Claude Code that was ended, still in a list read before it ended, changes nothing.
    await d.refresh();
    assert.equal(d.managed.has(SID), true);
    const outside = await claudeProcess();
    procs.push(outside);
    agents([row(outside.pid!)]);
    await d.refresh();
    assert.equal(d.managed.has(SID), false);
    assert.equal(shown().managed, undefined);
    assert.equal(shown().hibernation, undefined);
    assert.equal(shown().pid, outside.pid);
  } finally {
    await done();
  }
});

test("inputs waiting for a session opened outside Gasho are kept, and it comes back only once that has ended", async () => {
  const { d, term, started, agents, row, procs, shown, done } = await setup();
  const start = d.terminals.start;
  try {
    await d.hibernateIdle();
    agents([]);
    d.terminals.start = async () => {
      throw new Error("no terminal");
    };
    await d.input({ type: "session.input", requestId: "r1", sessionId: SID, text: "預けた発言" });
    await d.waking.get(SID);
    d.terminals.start = start;

    const outside = await claudeProcess();
    procs.push(outside);
    agents([row(outside.pid!)]);
    await d.refresh();
    assert.equal(d.managed.has(SID), true);
    assert.equal(d.managed.pending(SID), 1);
    assert.equal(shown().hibernation, "hibernated");
    assert.match(shown().resumeError, /Gasho の外/);

    // Asked to come back meanwhile: no second Claude Code on the conversation.
    await d.wake(SID);
    assert.equal(started.length, 0);
    assert.match(d.managed.get(SID).hibernated.resumeError, /Gasho の外/);

    outside.kill("SIGKILL");
    await once(outside, "exit");
    agents([]);
    await d.wake(SID);
    await until(() => term.entered.includes("預けた発言"), "the input was typed");
    assert.equal(started.length, 1);
  } finally {
    await done();
  }
});

test("the terminal a session comes back in is saved before it starts", async () => {
  const { d, agents, started, done } = await setup();
  const start = d.terminals.start;
  let saved: { hibernated?: { resumingIn?: string } }[] = [];
  try {
    await d.hibernateIdle();
    agents([]);
    d.terminals.start = async (o: TerminalStart) => {
      saved = JSON.parse(await fs.readFile(path.join(d.cfg.stateDir, "managed.json"), "utf8"));
      return start(o);
    };
    await d.wake(SID);
    assert.equal(saved[0]?.hibernated?.resumingIn, started[0]!.name);
    assert.equal(d.managed.get(SID).hibernated, undefined);
  } finally {
    await done();
  }
});

test("a restart while a session is being ended: one that goes on running is not hibernated, and nothing starts a second", async () => {
  const { d, make, term, started, procs, done } = await setup();
  try {
    d.managed.get(SID).hibernated = { at: Date.now() };
    d.managed.enqueue(SID, { id: "r1", text: "止まらなかった発言" });
    await d.managed.save();
    term.live.set("t1", { pid: procs[0]!.pid! });

    const again = make();
    again.endWaitMs = 300;
    await again.loadManaged();
    again.wakeInterrupted();
    assert.equal(again.managed.get(SID).hibernated, undefined);
    await again.refresh();
    await until(() => term.entered.includes("止まらなかった発言"), "the input was typed");
    assert.equal(started.length, 0);
    assert.equal(procs[0]!.signalCode, null);
  } finally {
    await done();
  }
});

test("a restart while a session is being ended: one that has ended stays hibernated, and its terminal is closed", async () => {
  const { d, make, term, killed, agents, started, procs, done } = await setup();
  try {
    d.managed.get(SID).hibernated = { at: Date.now() };
    await d.managed.save();
    term.live.set("t1", { pid: procs[0]!.pid! });
    procs[0]!.kill("SIGTERM");
    await once(procs[0]!, "exit");
    agents([]);

    const again = make();
    await again.loadManaged();
    assert.deepEqual(killed, ["t1"]);
    assert.ok(again.managed.get(SID).hibernated);
    assert.equal(started.length, 0);
  } finally {
    await done();
  }
});

test("a restart while a session is coming back takes its terminal over, and keeps what waits for it", async () => {
  const { d, make, term, started, killed, agents, row, procs, done } = await setup();
  try {
    procs[0]!.kill("SIGKILL");
    await once(procs[0]!, "exit");
    const resumed = await claudeProcess();
    procs.push(resumed);
    agents([row(resumed.pid!)]);
    term.live.set("t2", { pid: resumed.pid! });
    // "もう一度再開": the reason of the last try is no longer saved once this one has begun.
    d.managed.get(SID).hibernated = { at: Date.now(), resumingIn: "t2" };
    d.managed.enqueue(SID, { id: "r1", text: "再開を待つ発言" });
    await d.managed.save();

    const again = make();
    await again.loadManaged();
    // Listed before it is gone on with: it is Gasho's own, not a conversation opened outside.
    await again.refresh();
    assert.equal(again.managed.has(SID), true);
    assert.equal(again.managed.pending(SID), 1);

    again.wakeInterrupted();
    await again.waking.get(SID);
    await until(() => term.entered.includes("再開を待つ発言"), "the input was typed");
    assert.equal(started.length, 0);
    assert.deepEqual(killed, []);
    assert.equal(again.managed.get(SID).terminal, "t2");
    assert.equal(again.managed.get(SID).pid, resumed.pid);
    assert.equal(again.managed.get(SID).hibernated, undefined);
  } finally {
    await done();
  }
});

test("a restart after the terminal it was coming back in has gone starts it once more", async () => {
  const { d, make, term, started, killed, agents, procs, done } = await setup();
  try {
    procs[0]!.kill("SIGKILL");
    await once(procs[0]!, "exit");
    agents([]);
    d.managed.get(SID).hibernated = { at: Date.now(), resumingIn: "t2" };
    d.managed.enqueue(SID, { id: "r1", text: "やり直す発言" });
    await d.managed.save();

    const again = make();
    await again.loadManaged();
    assert.deepEqual(killed, ["t2"]);
    assert.equal(again.managed.get(SID).hibernated.resumingIn, undefined);
    again.wakeInterrupted();
    await again.waking.get(SID);
    await until(() => term.entered.includes("やり直す発言"), "the input was typed");
    assert.equal(started.length, 1);
  } finally {
    await done();
  }
});

test("a session that something is typing into is not hibernated", async () => {
  const { d, procs, done } = await setup();
  try {
    d.flushing.add("t1");
    await d.hibernateIdle();
    assert.equal(procs[0]!.signalCode, null);
    assert.equal(d.managed.get(SID).hibernated, undefined);
  } finally {
    await done();
  }
});

test("an id the session had before /clear reaches it while it is hibernated", async () => {
  const OLD = "00000000-2222-3333-4444-777777777777";
  const { d, term, started, agents, done } = await setup();
  try {
    d.managed.get(SID).previousIds = [OLD];
    await d.hibernateIdle();
    agents([]);

    assert.equal((await d.rename(OLD, "新しい名前", "r1")).ok, true);
    assert.equal(d.managed.get(SID).name, "新しい名前");
    assert.equal(d.managed.get(SID).hibernated.renamed, true);
    assert.equal(started.length, 0);

    assert.deepEqual(await d.input({ type: "session.input", requestId: "r2", sessionId: OLD, text: "前の ID への発言" }), { ok: true, queued: true });
    await d.waking.get(SID);
    await until(() => term.entered.includes("前の ID への発言"), "the input was typed");
    assert.equal(started.length, 1);
  } finally {
    await done();
  }
});

test("removing a hibernated session signals nothing, and forgets it", async () => {
  const { d, killed, agents, shown, done } = await setup();
  try {
    await d.hibernateIdle();
    agents([]);
    killed.length = 0;
    assert.equal((await d.remove(SID)).ok, true);
    assert.deepEqual(killed, []);
    assert.equal(d.managed.has(SID), false);
    assert.equal(d.tracked.has(SID), false);
    assert.equal(shown(), undefined);
  } finally {
    await done();
  }
});
