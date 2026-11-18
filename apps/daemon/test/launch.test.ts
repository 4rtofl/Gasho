// Starting a session in a folder Claude Code does not trust yet: the question is found by its choices at the bottom,
// it is answered only when the launch asks for it (and then only with the cursor on "Yes, I trust this folder"), and
// the question about a folder's MCP servers that follows is answered with Esc. Screens as Claude Code 2.1.323 drew them
// in a 50-column zellij pane (Gasho's own terminals are as wide); the launches run against a fake terminal and a fake
// `claude agents` (no claude, no terminal).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Daemon } from "../src/daemon.ts";
import { dialogOpen, mcpQuestionOpen, plainScreen, trustQuestion, typedInBox } from "../src/managed.ts";
import { RELAY_FILE, shellQuote } from "../src/statusline.ts";
import type { TerminalStart } from "../src/terminal.ts";

const RULE = "─".repeat(50);

function trustScreen(onYes: boolean, warnings: string[] = []): string {
  return [
    RULE,
    " Accessing workspace:",
    "",
    " /tmp/claude-1000/-home-rg-repos-Gasho/2591f41f-b",
    " ad4-4ca0-8809-bfaab0522045/scratchpad/trust-prob",
    " e/cloned",
    "",
    " Quick safety check: Is this a project you",
    " created or one you trust? (Like your own code, a",
    " well-known open source project, or work from",
    " your team). If not, take a moment to review",
    " what's in this folder first.",
    "",
    " Claude Code'll be able to read, edit, and",
    " execute files here.",
    "",
    ...warnings.flatMap((w) => [...w.split("\n"), ""]),
    " Security guide",
    "",
    `${onYes ? "  " : " ❯"} No, exit`,
    `${onYes ? " ❯" : "  "} Yes, I trust this folder`,
    "",
    " Enter to confirm · Esc to cancel",
    "",
    "",
  ].join("\n");
}

const PERMISSIONS_WARNING = [
  " ⚠ This folder pre-approves 1 tool permission in",
  " .claude/settings.json:",
  "   Bash(ls:*)",
  " These will apply without asking. Only proceed if",
  " you trust this configuration.",
].join("\n");

const MCP_SCREEN = [
  RULE,
  "  New MCP server found in this project: demo",
  "  MCP servers may execute code or access system",
  "  resources. All tool calls require approval.",
  "  Learn more in the MCP documentation.",
  "",
  "    Use this MCP server",
  "    Use this and all future MCP servers in this",
  "    project",
  "  ❯ Continue without using this MCP server",
  "",
  "  Enter to confirm · Esc to cancel",
  "",
].join("\n");

function replScreen(above: string[] = []): string {
  return [
    " ▐▛███▛█   Claude Code v2.1.323",
    "▝▜██████▀  Opus 5.5 · Claude Ultra",
    " ▝▝   ▝▝   /…/scratchpad/trust-probe/parent",
    ...above,
    "                              ◐ medium · /effort",
    RULE,
    "❯ ",
    RULE,
    "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for …",
    "",
  ].join("\n");
}

test("the trust question is found by its two choices at the bottom, with where the cursor is", () => {
  assert.deepEqual(trustQuestion(trustScreen(false)), { onYes: false, yesBelow: true, warnings: [] });
  assert.deepEqual(trustQuestion(trustScreen(true)), { onYes: true, yesBelow: true, warnings: [] });
  assert.ok(dialogOpen(trustScreen(false)));
  assert.equal(typedInBox(plainScreen(trustScreen(false))), undefined);
  // Quoted in a conversation above the prompt box, the same words are not the question.
  const quoted = replScreen(["● Claude Code asked:", " ❯ No, exit", "   Yes, I trust this folder", "  Enter to confirm · Esc to cancel"]);
  assert.equal(trustQuestion(quoted), undefined);
});

test("what Claude Code points out about the folder's settings comes with the question, one paragraph each", () => {
  const q = trustQuestion(trustScreen(false, [PERMISSIONS_WARNING, " ⚠ This folder configures hooks that run commands,\n declared in .claude/settings.json."]));
  assert.deepEqual(q?.warnings, [
    "⚠ This folder pre-approves 1 tool permission in .claude/settings.json: Bash(ls:*) These will apply without asking. Only proceed if you trust this configuration.",
    "⚠ This folder configures hooks that run commands, declared in .claude/settings.json.",
  ]);
});

test("the question about a folder's new MCP servers is open only while it has the keys", () => {
  assert.ok(mcpQuestionOpen(MCP_SCREEN));
  assert.ok(dialogOpen(MCP_SCREEN));
  assert.ok(mcpQuestionOpen(MCP_SCREEN.replace("New MCP server found in this project: demo", "2 new MCP servers found in this project")));
  assert.equal(mcpQuestionOpen(replScreen()), false);
  assert.equal(mcpQuestionOpen(replScreen(["● It said: New MCP server found in this project: demo"])), false);
  assert.equal(mcpQuestionOpen(trustScreen(false)), false);
});

/** Claude Code starting in a folder it does not trust, as far as the daemon sees and drives it. */
class FakeStart {
  state: "trust" | "mcp" | "repl" | "exited" = "trust";
  /** 0: "No, exit", 1: "Yes, I trust this folder". */
  cursor = 0;
  keys: string[] = [];
  private readonly o: { mcp?: boolean; warnings?: string[]; agentsFile: string; registryFile?: string; sessionId: string };

  constructor(o: { mcp?: boolean; warnings?: string[]; agentsFile: string; registryFile?: string; sessionId: string }) {
    this.o = o;
  }

  key(k: string): void {
    this.keys.push(k);
    if (this.state === "trust") {
      if (k === "Down") this.cursor = 1;
      else if (k === "Up") this.cursor = 0;
      else if (k === "Enter") this.to(this.cursor === 1 ? (this.o.mcp ? "mcp" : "repl") : "exited");
      else if (k === "Esc") this.to("exited");
    } else if (this.state === "mcp" && (k === "Esc" || k === "Enter")) this.to("repl");
  }

  private to(state: FakeStart["state"]): void {
    this.state = state;
    // Once its prompt is up, `claude agents` lists the session, and Claude Code's file has its id.
    if (state !== "repl") return;
    writeFileSync(this.o.agentsFile, JSON.stringify([{ pid: process.pid, sessionId: this.o.sessionId, status: "idle" }]));
    if (this.o.registryFile) writeFileSync(this.o.registryFile, JSON.stringify({ pid: process.pid, sessionId: this.o.sessionId, status: "idle" }));
  }

  screen(): string {
    if (this.state === "trust") return trustScreen(this.cursor === 1, this.o.warnings);
    if (this.state === "mcp") return MCP_SCREEN;
    return this.state === "repl" ? replScreen() : "";
  }
}

const SID = "11111111-2222-3333-4444-666666666666";

/**
 * A daemon whose terminal is the fake one and whose `claude agents` reads a file the fake writes. With `emptyList`,
 * `claude agents` prints nothing, as it did when stopped at its time limit on a busy machine, and Claude Code's file
 * (~/.claude/sessions/<pid>.json) has the session id.
 */
async function setup(o: { mcp?: boolean; warnings?: string[]; emptyList?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-launch-"));
  const agentsFile = path.join(dir, "agents.json");
  await fs.writeFile(agentsFile, "[]");
  const claude = path.join(dir, "claude");
  await fs.writeFile(claude, o.emptyList ? "#!/bin/sh\n" : `#!/bin/sh\ncat '${agentsFile}'\n`, { mode: 0o755 });
  const folder = path.join(dir, "cloned");
  await fs.mkdir(folder);
  const sessions = path.join(dir, "claude-dir", "sessions");
  await fs.mkdir(sessions, { recursive: true });
  const registryFile = o.emptyList ? path.join(sessions, `${process.pid}.json`) : undefined;
  const fake = new FakeStart({ ...o, agentsFile, ...(registryFile ? { registryFile } : {}), sessionId: SID });
  const killed: string[] = [];
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
  } as ConstructorParameters<typeof Daemon>[0]) as unknown as Record<string, any>;
  d.canLaunch = true;
  const started: TerminalStart[] = [];
  d.terminals = {
    // The terminal answers with Claude Code's PID; `claude agents` (the fake) lists this process.
    start: async (o: TerminalStart) => {
      started.push(o);
      return process.pid;
    },
    screen: async () => plainScreen(fake.screen()),
    keys: async (_s: string, ...keys: string[]) => keys.forEach((k) => fake.key(k)),
    kill: async (s: string) => {
      killed.push(s);
      fake.state = "exited";
    },
  };
  d.refresh = async () => undefined;
  d.refreshFolders = async () => undefined;
  return { d, fake, folder, killed, started, agentsFile, done: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("without trust, the launch stops at the question: nothing is pressed, and Claude Code's warnings come back", async () => {
  const { d, fake, folder, killed, done } = await setup({ warnings: [PERMISSIONS_WARNING] });
  try {
    const r = await d.launch(folder, "clone-test");
    assert.equal(r.ok, false);
    assert.equal(r.needsTrust, true);
    assert.match(r.error, /まだ Claude Code に信頼されていません/);
    assert.deepEqual(r.trustWarnings, [
      "⚠ This folder pre-approves 1 tool permission in .claude/settings.json: Bash(ls:*) These will apply without asking. Only proceed if you trust this configuration.",
    ]);
    assert.deepEqual(fake.keys, []);
    assert.equal(killed.length, 1);
    assert.equal(d.managed.has(SID), false);
  } finally {
    await done();
  }
});

test("with trust, the cursor is moved to yes before the one Enter, and the session starts", async () => {
  const { d, fake, folder, killed, started, done } = await setup();
  try {
    const r = await d.launch(folder, "clone-test", true);
    assert.deepEqual(r, { ok: true, sessionId: SID });
    assert.deepEqual(fake.keys, ["Down", "Enter"]);
    assert.deepEqual(killed, []);
    assert.equal(d.managed.get(SID)?.cwd, folder);
    // Claude Code runs with Remote Control in the folder, in a terminal named after the session, and its status line
    // is the relay that reports the context window and the plan's limits (statusline.ts).
    assert.equal(started.length, 1);
    assert.deepEqual(started[0]?.args.slice(0, 2), ["--remote-control=clone-test", "--settings"]);
    assert.deepEqual(JSON.parse(started[0]?.args[2] ?? ""), {
      statusLine: { type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(RELAY_FILE)}` },
    });
    assert.equal(started[0]?.env.GASHO_STATUSLINE_URL, "http://127.0.0.1:0/statusline");
    assert.equal(started[0]?.env.GASHO_STATUSLINE_COMMAND, undefined);
    assert.equal(started[0]?.cwd, folder);
    assert.match(started[0]?.name ?? "", /^gasho-clone-test-[0-9a-f]{4}$/);
    assert.equal(d.managed.get(SID)?.terminal, started[0]?.name);
  } finally {
    await done();
  }
});

test("with `claude agents` printing nothing, the session starts with the id in Claude Code's file", async () => {
  const { d, folder, killed, done } = await setup({ emptyList: true });
  try {
    assert.deepEqual(await d.launch(folder, "clone-test", true), { ok: true, sessionId: SID });
    assert.deepEqual(killed, []);
    assert.equal(d.managed.get(SID)?.cwd, folder);
  } finally {
    await done();
  }
});

test("with `claude agents` printing nothing, a Claude Code that ends before it has a session id fails the launch, and its terminal is closed", async () => {
  const { d, folder, killed, done } = await setup({ emptyList: true });
  const p = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1500)"], { stdio: "ignore" });
  try {
    d.terminals.start = async () => p.pid;
    const r = await d.launch(folder, "clone-test", true);
    assert.equal(r.ok, false);
    assert.match(r.error, /時間内にセッションを確認できませんでした/);
    assert.equal(killed.length, 1);
    assert.equal(d.managed.has(SID), false);
  } finally {
    p.kill("SIGKILL");
    await done();
  }
});

test("the status line the user set up for the folder keeps running, through the relay", async () => {
  const { d, folder, started, done } = await setup();
  try {
    await fs.mkdir(path.join(folder, ".claude"));
    await fs.writeFile(path.join(folder, ".claude", "settings.json"), JSON.stringify({ statusLine: { type: "command", command: "./line.sh", padding: 0 } }));
    assert.equal((await d.launch(folder, "clone-test", true)).ok, true);
    assert.deepEqual(JSON.parse(started[0]?.args[2] ?? "").statusLine.padding, 0);
    assert.equal(started[0]?.env.GASHO_STATUSLINE_COMMAND, "./line.sh");
  } finally {
    await done();
  }
});

test("the question about the folder's MCP servers that follows is answered with Esc, and the launch says so", async () => {
  const { d, fake, folder, done } = await setup({ mcp: true });
  try {
    const r = await d.launch(folder, undefined, true);
    assert.equal(r.ok, true);
    assert.equal(r.sessionId, SID);
    assert.match(r.warning, /MCP サーバーは、使わない設定にして起動しました/);
    assert.deepEqual(fake.keys, ["Down", "Enter", "Esc"]);
  } finally {
    await done();
  }
});

/** A process standing in for Claude Code. It says so once it is ready for SIGTERM (one that has not set its handler yet would end on it). */
async function child(code: string) {
  const p = spawn(process.execPath, ["-e", `${code}; setInterval(() => {}, 1000); console.log("ready")`], { stdio: ["ignore", "pipe", "ignore"] });
  await once(p.stdout, "data");
  return p;
}

test("ending sessions opened outside Gasho signals the process `claude agents` lists for each, and kills none that stays", async () => {
  const { d, agentsFile, done } = await setup();
  const ends = await child("");
  const stays = await child('process.on("SIGTERM", () => {})');
  try {
    await fs.writeFile(agentsFile, JSON.stringify([{ pid: ends.pid, sessionId: "out-1" }, { pid: stays.pid, sessionId: "out-2" }]));
    d.endWaitMs = 500;
    // "gone": `claude agents` no longer lists it, so it has ended already.
    const r = await d.end(["out-1", "out-2", "gone"]);
    assert.equal(r.ok, true);
    assert.deepEqual([...r.ended].sort(), ["gone", "out-1"]);
    assert.match(r.warning, /終了しませんでした/);
    // Long enough for a kill to be seen.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(ends.signalCode, "SIGTERM");
    assert.equal(stays.exitCode, null);
    assert.equal(stays.signalCode, null);
  } finally {
    ends.kill("SIGKILL");
    stays.kill("SIGKILL");
    await done();
  }
});

test("after a restart, no sessions are sent before the first refresh has ended, also one that failed", async () => {
  const { d, agentsFile, folder, done } = await setup();
  const sent: string[][] = [];
  try {
    d.cfg.pluginDataDir = path.join(folder, "plugin-data");
    d.refresh = Object.getPrototypeOf(d).refresh;
    d.readManagedScreens = async () => undefined;
    d.countTokens = async () => undefined;
    d.hub = {
      connected: true,
      send: (m: { type: string; sessions?: { sessionId: string }[] }) => m.type === "sessions" && sent.push(m.sessions!.map((s) => s.sessionId)),
    };
    // Connected before the first refresh, as start() connects: the Gasho server keeps the sessions it has meanwhile.
    d.emitSessions();
    assert.deepEqual(sent, []);
    await fs.writeFile(agentsFile, "not json");
    await d.refresh();
    assert.deepEqual(sent, [[]]);
    await fs.writeFile(agentsFile, JSON.stringify([{ pid: process.pid, sessionId: "s1", cwd: folder, status: "idle" }]));
    await d.refresh();
    assert.deepEqual(sent, [[], ["s1"]]);
  } finally {
    await done();
  }
});

test("a Claude Code that Gasho is starting or removing is neither sent nor ended as one opened outside Gasho", async () => {
  const { d, agentsFile, folder, done } = await setup();
  // The copy a fork starts, and a session that is removed: both end a little after SIGTERM.
  const copy = await child('process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300))');
  const mine = await child('process.on("SIGTERM", () => setTimeout(() => process.exit(0), 300))');
  const rows = new Map([["src", process.pid], ["mine", mine.pid!]]);
  const agents = () => writeFileSync(agentsFile, JSON.stringify([...rows].map(([sessionId, pid]) => ({ pid, sessionId, cwd: folder, status: "idle" }))));
  agents();
  const sent: { sessionId: string; pid?: number; managed?: boolean }[][] = [];
  try {
    d.cfg.pluginDataDir = path.join(folder, "plugin-data");
    d.refresh = Object.getPrototypeOf(d).refresh;
    d.readManagedScreens = async () => undefined;
    d.countTokens = async () => undefined;
    d.hub = { connected: true, send: (m: { type: string; sessions?: [] }) => m.type === "sessions" && sent.push(m.sessions!) };
    await fs.mkdir(path.join(d.cfg.claudeDir, "projects", "p"), { recursive: true });
    await fs.writeFile(path.join(d.cfg.claudeDir, "projects", "p", "src.jsonl"), "");
    for (const [sessionId, pid] of rows) d.managed.add({ sessionId, terminal: `t-${sessionId}`, pid, cwd: folder, name: sessionId, launchedAt: Date.now() });
    let loaded = false;
    d.terminals.start = async () => {
      rows.set("copy", copy.pid!);
      agents();
      return copy.pid;
    };
    d.terminals.screen = async () => plainScreen(loaded ? replScreen() : "");

    // The copy is listed with its own id, and Gasho waits for it to load the conversation before taking it on.
    const forking = d.fork("src", "copy");
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await d.refresh();
    assert.deepEqual(sent.at(-1)?.map((s) => s.sessionId).sort(), ["mine", "src"]);
    const r = await d.end(["copy"]);
    assert.equal(r.ok, false);
    assert.equal(copy.signalCode, null);
    loaded = true;
    assert.equal((await forking).ok, true);
    assert.equal(sent.at(-1)?.find((s) => s.sessionId === "copy")?.managed, true);

    // Taken off Gasho's sessions at once, it runs on until SIGTERM ends it. The refresh after it is still given a
    // listing that has it, as one read just before it ended is.
    assert.equal((await d.remove("mine")).ok, true);
    assert.equal(mine.signalCode, null);
    assert.equal(mine.exitCode, 0);
    rows.delete("mine");
    agents();
    await d.refresh();
    assert.deepEqual(
      sent.flat().filter((s) => !s.managed && s.pid),
      [],
    );
  } finally {
    copy.kill("SIGKILL");
    mine.kill("SIGKILL");
    await done();
  }
});

test("after /clear, a session started from Gasho goes on under its new id, with its waiting inputs and attachments", async () => {
  const { d, agentsFile, folder, done } = await setup();
  const claude = await child('process.on("SIGTERM", () => process.exit(0))');
  const OLD = "aaaaaaaa-0000-4000-8000-000000000001";
  const NEW = "aaaaaaaa-0000-4000-8000-000000000002";
  const OTHER = "aaaaaaaa-0000-4000-8000-000000000003";
  const agents = (sessionId: string, startedAt: number) =>
    writeFileSync(agentsFile, JSON.stringify([{ pid: claude.pid, sessionId, cwd: folder, status: "idle", startedAt }]));
  const sent: { sessionId: string; managed?: boolean; name?: string; previousSessionIds?: string[] }[][] = [];
  try {
    d.cfg.pluginDataDir = path.join(folder, "plugin-data");
    d.refresh = Object.getPrototypeOf(d).refresh;
    d.readManagedScreens = async () => undefined;
    d.countTokens = async () => undefined;
    d.flushInput = async () => undefined;
    d.hub = { connected: true, send: (m: { type: string; sessions?: [] }) => m.type === "sessions" && sent.push(m.sessions!) };
    const launchedAt = Date.now();
    d.managed.add({ sessionId: OLD, terminal: "t-old", pid: claude.pid, cwd: folder, name: "-wip", launchedAt });
    d.managed.enqueue(OLD, { text: "次の指示" });
    for (const id of [OLD, NEW, OTHER]) await fs.mkdir(path.join(d.cfg.attachmentsDir, id), { recursive: true });

    // A Claude Code that got the same PID after the session was recorded is another one.
    agents(NEW, launchedAt + 1000);
    await d.refresh();
    assert.ok(d.managed.has(OLD));

    // /clear: the same Claude Code, listed under a new id.
    agents(NEW, launchedAt - 1000);
    await d.refresh();
    assert.equal(d.managed.has(OLD), false);
    assert.deepEqual(d.managed.waiting(NEW).map((i: { text: string }) => i.text), ["次の指示"]);
    const s = sent.at(-1)?.find((x) => x.sessionId === NEW);
    assert.equal(s?.managed, true);
    assert.equal(s?.name, "-wip");
    assert.deepEqual(s?.previousSessionIds, [OLD]);
    const saved = JSON.parse(await fs.readFile(path.join(d.cfg.stateDir, "managed.json"), "utf8"));
    assert.deepEqual(saved.map((x: { sessionId: string; previousIds?: string[] }) => [x.sessionId, x.previousIds]), [[NEW, [OLD]]]);
    // gasho-daemon session send|remove <the id from before> finds it (see pick).
    assert.deepEqual(d.controlSessions().map((x: { sessionId: string; previousSessionIds?: string[] }) => [x.sessionId, x.previousSessionIds]), [[NEW, [OLD]]]);

    // The files attached before /clear stay while the session runs, and go with it.
    await d.pruneAttachments();
    assert.deepEqual((await fs.readdir(d.cfg.attachmentsDir)).sort(), [OLD, NEW]);
    assert.equal((await d.remove(NEW)).ok, true);
    assert.deepEqual(await fs.readdir(d.cfg.attachmentsDir), []);
  } finally {
    claude.kill("SIGKILL");
    await done();
  }
});
