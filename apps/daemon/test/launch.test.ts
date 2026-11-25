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
import { chromeOnboardingOpen, dialogOpen, mcpQuestionOpen, plainScreen, trustQuestion, typedInBox } from "../src/managed.ts";
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

/**
 * Claude Code's explanation the first time it starts with --chrome, drawn from its words in 2.1.331 (its source; the
 * screen itself was not captured: starting with --chrome on a test machine would use that explanation up).
 */
const CHROME_SCREEN = [
  RULE,
  "  Claude in Chrome",
  "",
  "  Claude can use Chrome through its extension: open",
  "  sites, fill forms, take screenshots, record GIFs,",
  "  and read console logs and network requests.",
  "",
  "  Claude Code asks before Claude browses, clicks, or",
  "  types on a site, unless your permission mode or a",
  "  rule in /permissions answers for you. Sites you",
  "  approved in the extension don't carry over.",
  "",
  "  For more info, use /chrome or visit",
  "  https://code.claude.com/docs/en/chrome",
  "",
  "  Enter to continue · Esc to close",
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

test("the explanation of Claude in Chrome is open only while it has the keys", () => {
  assert.ok(chromeOnboardingOpen(CHROME_SCREEN));
  assert.ok(dialogOpen(CHROME_SCREEN));
  assert.equal(typedInBox(plainScreen(CHROME_SCREEN)), undefined);
  assert.equal(chromeOnboardingOpen(replScreen()), false);
  assert.equal(chromeOnboardingOpen(replScreen(["● It said: Claude can use Chrome through its extension: open sites"])), false);
  assert.equal(chromeOnboardingOpen(MCP_SCREEN), false);
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
  state: "trust" | "mcp" | "chrome" | "repl" | "exited" = "trust";
  /** 0: "No, exit", 1: "Yes, I trust this folder". */
  cursor = 0;
  keys: string[] = [];
  private readonly o: { mcp?: boolean; chrome?: boolean; warnings?: string[]; agentsFile: string; registryFile?: string; sessionId: string };
  /** The explanation of Claude in Chrome has been shown (it is shown once, before the prompt). */
  private chromeShown = false;

  constructor(o: { mcp?: boolean; chrome?: boolean; warnings?: string[]; agentsFile: string; registryFile?: string; sessionId: string }) {
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
    else if (this.state === "chrome" && (k === "Esc" || k === "Enter")) this.to("repl");
  }

  private to(state: FakeStart["state"]): void {
    if (state === "repl" && this.o.chrome && !this.chromeShown) {
      this.chromeShown = true;
      state = "chrome";
    }
    this.state = state;
    // Once its prompt is up, `claude agents` lists the session, and Claude Code's file has its id.
    if (state !== "repl") return;
    writeFileSync(this.o.agentsFile, JSON.stringify([{ pid: process.pid, sessionId: this.o.sessionId, status: "idle" }]));
    if (this.o.registryFile) writeFileSync(this.o.registryFile, JSON.stringify({ pid: process.pid, sessionId: this.o.sessionId, status: "idle" }));
  }

  screen(): string {
    if (this.state === "trust") return trustScreen(this.cursor === 1, this.o.warnings);
    if (this.state === "mcp") return MCP_SCREEN;
    if (this.state === "chrome") return CHROME_SCREEN;
    return this.state === "repl" ? replScreen() : "";
  }
}

const SID = "11111111-2222-3333-4444-666666666666";

/**
 * A daemon whose terminal is the fake one and whose `claude agents` reads a file the fake writes. With `emptyList`,
 * `claude agents` prints nothing, as it did when stopped at its time limit on a busy machine, and Claude Code's file
 * (~/.claude/sessions/<pid>.json) has the session id.
 */
async function setup(o: { mcp?: boolean; chrome?: boolean; warnings?: string[]; emptyList?: boolean } = {}) {
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
    claudeTmpDir: path.join(dir, "claude-tmp"),
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

test("with chrome, Claude Code starts with --chrome, its explanation is closed with Enter, and the session keeps it", async () => {
  const { d, fake, folder, started, done } = await setup({ chrome: true });
  try {
    const r = await d.launch(folder, "browse", true, "claude", true);
    assert.deepEqual(r, { ok: true, sessionId: SID });
    assert.deepEqual(fake.keys, ["Down", "Enter", "Enter"]);
    assert.deepEqual(started[0]?.args.slice(0, 2), ["--remote-control=browse", "--chrome"]);
    assert.equal(d.managed.get(SID)?.chrome, true);
    assert.equal(d.controlSessions().find((s: { sessionId: string }) => s.sessionId === SID)?.chrome, true);
  } finally {
    await done();
  }
});

test("without chrome, Claude Code starts as before, and an explanation of Claude in Chrome is not answered", async () => {
  const { d, fake, folder, started, done } = await setup();
  try {
    assert.equal((await d.launch(folder, "plain", true)).ok, true);
    assert.equal(started[0]?.args.includes("--chrome"), false);
    assert.equal(d.managed.get(SID)?.chrome, undefined);
    assert.equal("chrome" in d.controlSessions()[0], false);
    assert.deepEqual(fake.keys, ["Down", "Enter"]);
  } finally {
    await done();
  }
});

test("a launch with a model and an effort level starts Claude Code with them, and the session shows the effort level until its first reply", async () => {
  const { d, folder, started, done } = await setup();
  try {
    assert.equal((await d.launch(folder, "tuned", true, "claude", false, { model: "opus", effort: "high" })).ok, true);
    assert.deepEqual(started[0]?.args.slice(0, 5), ["--remote-control=tuned", "--model", "opus", "--effort", "high"]);
    assert.equal(d.managed.get(SID)?.effort, "high");
  } finally {
    await done();
  }
});

test("the default model, and what is not a model or an effort level, start Claude Code with nothing for them", async () => {
  const { d, folder, started, done } = await setup();
  try {
    assert.equal((await d.launch(folder, "plain", true, "claude", false, { model: "default", effort: "--yolo" })).ok, true);
    assert.equal(started[0]?.args.includes("--model"), false);
    assert.equal(started[0]?.args.includes("--effort"), false);
    assert.equal(d.managed.get(SID)?.effort, undefined);
  } finally {
    await done();
  }
});

test("Codex is not started with Claude in Chrome", async () => {
  const { d, folder, started, done } = await setup();
  try {
    const r = await d.launch(folder, "x", true, "codex", true);
    assert.equal(r.ok, false);
    assert.match(r.error, /Claude Code のセッションでだけ/);
    assert.deepEqual(started, []);
  } finally {
    await done();
  }
});

test("a fork of a session with Claude in Chrome has it, and a fork can ask for it", async () => {
  const { d, folder, done } = await setup();
  try {
    await fs.mkdir(path.join(d.cfg.claudeDir, "projects", "p"), { recursive: true });
    for (const id of ["plain", "browsing"]) {
      await fs.writeFile(path.join(d.cfg.claudeDir, "projects", "p", `${id}.jsonl`), "");
      d.managed.add({ sessionId: id, terminal: `t-${id}`, pid: process.pid, cwd: folder, name: id, launchedAt: Date.now(), ...(id === "browsing" ? { chrome: true } : {}) });
    }
    const asked: { chrome?: boolean; claudeArgs?: string[] }[] = [];
    // Only what the copy is started with matters here: it then fails, and nothing is kept.
    d.startClaude = async (_dir: string, _name: string, o: { chrome?: boolean; claudeArgs?: string[] }) => {
      asked.push(o);
      return { error: "stop" };
    };
    for (const [id, opts] of [["plain", {}], ["plain", { chrome: true }], ["browsing", {}], ["browsing", { chrome: false }]] as const) {
      assert.equal((await d.fork(id, undefined, opts)).ok, false);
    }
    assert.deepEqual(asked.map((o) => o.chrome), [false, true, true, false]);
    assert.deepEqual(asked[0]?.claudeArgs, ["--resume", "plain", "--fork-session"]);
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

test("while /clear gives a session started from Gasho its new id, every list of sessions sent has it", async () => {
  const { d, agentsFile, folder, done } = await setup();
  const claude = await child('process.on("SIGTERM", () => process.exit(0))');
  const OLD = "aaaaaaaa-0000-4000-8000-000000000011";
  const NEW = "aaaaaaaa-0000-4000-8000-000000000012";
  const launchedAt = Date.now();
  const agents = (sessionId: string) =>
    writeFileSync(agentsFile, JSON.stringify([{ pid: claude.pid, sessionId, cwd: folder, status: "idle", startedAt: launchedAt - 1000 }]));
  const sent: { sessionId: string; managed?: boolean }[][] = [];
  try {
    d.cfg.pluginDataDir = path.join(folder, "plugin-data");
    d.refresh = Object.getPrototypeOf(d).refresh;
    d.readManagedScreens = async () => undefined;
    d.countTokens = async () => undefined;
    d.flushInput = async () => undefined;
    d.hub = { connected: true, send: (m: { type: string; sessions?: [] }) => m.type === "sessions" && sent.push(m.sessions!) };
    d.managed.add({ sessionId: OLD, terminal: "t-old", pid: claude.pid, cwd: folder, name: "-wip", launchedAt });
    agents(OLD);
    await d.refresh();
    // The sessions are sent for something else (a hook, a permission request) while the new id is saved.
    const save = d.managed.save.bind(d.managed);
    d.managed.save = async () => {
      d.emitSessions();
      await save();
    };
    agents(NEW);
    await d.refresh();
    assert.deepEqual(
      sent.map((list) => list.map((s) => [s.sessionId, s.managed])),
      [[[OLD, true]], [[NEW, true]]],
    );
  } finally {
    claude.kill("SIGKILL");
    await done();
  }
});

test("an input or a rename that waits while /clear gives the session a new id waits under the new id", async () => {
  const { d, folder, done } = await setup();
  try {
    d.flushInput = async () => undefined;
    d.hub = { connected: true, send: () => undefined };
    d.managed.add({ sessionId: "s1", terminal: "t", pid: 1, cwd: folder, name: "x", launchedAt: 1 });
    // /clear while the files sent with the input are written ...
    const saveAttachments = d.saveAttachments.bind(d);
    d.saveAttachments = async (id: string, files: unknown) => {
      const paths = await saveAttachments(id, files);
      d.managed.rekey("s1", "s2");
      return paths;
    };
    const files = [{ name: "a.txt", data: Buffer.from("a").toString("base64") }];
    assert.deepEqual(await d.input({ type: "session.input", requestId: "r1", sessionId: "s1", text: "見て", files }), { ok: true, queued: true });
    // ... and while the new name is saved.
    const save = d.managed.save.bind(d.managed);
    d.managed.save = async () => {
      await save();
      d.managed.rekey("s2", "s3");
    };
    assert.deepEqual(await d.rename("s2", "y", "r2"), { ok: true, queued: true });
    d.managed.save = save;
    assert.deepEqual(
      d.managed.waiting("s3").map((i: { text: string }) => i.text.split("\n")[0]),
      ["見て", "/rename y"],
    );
    // A page that has not yet heard of the new id sends the one it shows (the name asked for last takes the place of
    // the one still waiting).
    assert.deepEqual(await d.input({ type: "session.input", requestId: "r3", sessionId: "s1", text: "前の ID で" }), { ok: true, queued: true });
    assert.deepEqual(await d.rename("s2", "z", "r4"), { ok: true, queued: true });
    assert.deepEqual(
      d.managed.waiting("s3").map((i: { text: string }) => i.text.split("\n")[0]),
      ["見て", "前の ID で", "/rename z"],
    );
    assert.equal(d.managed.pending("s1") + d.managed.pending("s2"), 0);
  } finally {
    await done();
  }
});

test("the conversation from before /clear, opened again while a refresh runs, is no longer sent among the session's earlier ids", async () => {
  const { d, agentsFile, folder, done } = await setup();
  const claude = await child('process.on("SIGTERM", () => process.exit(0))');
  const OLD = "aaaaaaaa-0000-4000-8000-000000000021";
  const NEW = "aaaaaaaa-0000-4000-8000-000000000022";
  const launchedAt = Date.now();
  writeFileSync(agentsFile, JSON.stringify([{ pid: claude.pid, sessionId: NEW, cwd: folder, status: "idle", startedAt: launchedAt - 1000 }]));
  const sent: { sessionId: string; previousSessionIds?: string[] }[][] = [];
  try {
    d.cfg.pluginDataDir = path.join(folder, "plugin-data");
    d.refresh = Object.getPrototypeOf(d).refresh;
    d.readManagedScreens = async () => undefined;
    d.countTokens = async () => undefined;
    d.flushInput = async () => undefined;
    d.hub = { connected: true, send: (m: { type: string; sessions?: [] }) => m.type === "sessions" && sent.push(m.sessions!) };
    d.managed.add({ sessionId: OLD, terminal: "t-old", pid: claude.pid, cwd: folder, name: "-wip", launchedAt });
    await d.refresh();
    assert.deepEqual(sent.at(-1)?.map((s) => [s.sessionId, s.previousSessionIds]), [[NEW, [OLD]]]);

    const project = path.join(d.cfg.claudeDir, "projects", "p");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(path.join(project, `${OLD}.jsonl`), `${JSON.stringify({ type: "user", cwd: folder, message: { role: "user", content: "前の会話" } })}\n`);
    d.startClaude = async () => ({ sessionId: OLD, terminal: "t-resumed", pid: process.pid });
    // `claude agents` is slow, and the refresh resume asks for only has the one running go again.
    d.refreshing = true;
    assert.equal((await d.resume(OLD)).ok, true);
    assert.deepEqual(sent.at(-1)?.map((s) => [s.sessionId, s.previousSessionIds]), [[NEW, undefined]]);
  } finally {
    claude.kill("SIGKILL");
    await done();
  }
});

/** A session's temporary folder as Claude Code leaves it, last changed long ago. */
async function oldTmpFolder(root: string, sessionId: string): Promise<string> {
  const dir = path.join(root, `claude-${process.getuid!()}`, "-home-rg-repo", sessionId);
  await fs.mkdir(path.join(dir, "scratchpad"), { recursive: true });
  const long = new Date(Date.now() - 30 * 24 * 60 * 60_000);
  await fs.utimes(path.join(dir, "scratchpad"), long, long);
  await fs.utimes(dir, long, long);
  return dir;
}

const present = (file: string) => fs.lstat(file).then(() => true, () => false);

test("a new session, one opened again and a fork are all given the same temporary folder", async () => {
  const { d, fake, folder, started, agentsFile, done } = await setup();
  try {
    fake.state = "repl";
    await fs.writeFile(agentsFile, JSON.stringify([{ pid: process.pid, sessionId: SID, status: "idle" }]));
    for (const claudeArgs of [[], ["--resume", SID], ["--resume", SID, "--fork-session"]]) {
      assert.equal((await d.startClaude(folder, "s", { claudeArgs })).sessionId, SID);
    }
    assert.deepEqual(started.map((s) => s.env?.CLAUDE_CODE_TMPDIR), Array(3).fill(d.cfg.claudeTmpDir));
    assert.equal(await present(d.cfg.claudeTmpDir), true);
  } finally {
    await done();
  }
});

test("with a temporary folder that cannot be used, Claude Code starts with its default one", async () => {
  const { d, fake, folder, started, agentsFile, done } = await setup();
  const readOnly = path.join(folder, "read-only");
  try {
    fake.state = "repl";
    await fs.writeFile(agentsFile, JSON.stringify([{ pid: process.pid, sessionId: SID, status: "idle" }]));
    await fs.mkdir(readOnly, { mode: 0o555 });
    for (const dir of [readOnly, path.join(readOnly, "below")]) {
      d.cfg.claudeTmpDir = dir;
      for (const claudeArgs of [[], ["--resume", SID], ["--resume", SID, "--fork-session"]]) {
        assert.equal((await d.startClaude(folder, "s", { claudeArgs })).sessionId, SID);
      }
    }
    assert.equal(started.length, 6);
    for (const s of started) assert.equal("CLAUDE_CODE_TMPDIR" in (s.env ?? {}), false);
  } finally {
    await fs.chmod(readOnly, 0o755);
    await done();
  }
});

test("removing a session removes its temporary folder once its Claude Code has ended, and only then", async () => {
  const { d, folder, agentsFile, done } = await setup();
  const other = "11111111-2222-3333-4444-777777777777";
  try {
    const mine = await oldTmpFolder(d.cfg.claudeTmpDir, SID);
    const kept = await oldTmpFolder(d.cfg.claudeTmpDir, other);
    const claude = await child('process.on("SIGTERM", () => process.exit(0))');
    await fs.writeFile(agentsFile, JSON.stringify([{ pid: claude.pid, sessionId: SID, cwd: folder, status: "idle" }]));
    d.managed.add({ sessionId: SID, terminal: "t", pid: claude.pid!, cwd: folder, name: "s", launchedAt: Date.now() });
    assert.equal((await d.remove(SID)).ok, true);
    for (let i = 0; i < 40 && (await present(mine)); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await present(mine), false);
    assert.equal(await present(kept), true);

    // A process that is still there, and a conversation being opened again: the regular clean-up decides later.
    await d.removeClaudeTmp(other, process.pid);
    assert.equal(await present(kept), true);
    d.claudeTmpOpening.set(other, Date.now() + 60_000);
    await d.removeClaudeTmp(other, 0x7ffffff0);
    assert.equal(await present(kept), true);
  } finally {
    await done();
  }
});

test("a temporary folder that cannot be removed does not fail the removal of the session", async () => {
  const { d, folder, done } = await setup();
  const dir = await oldTmpFolder(d.cfg.claudeTmpDir, SID);
  try {
    await fs.chmod(path.dirname(dir), 0o555);
    d.managed.add({ sessionId: SID, terminal: "t", pid: 0x7ffffff0, cwd: folder, name: "s", launchedAt: Date.now() });
    assert.deepEqual(await d.remove(SID), { ok: true });
    await d.removeClaudeTmp(SID, 0x7ffffff0);
  } finally {
    await fs.chmod(path.dirname(dir), 0o755);
    await done();
  }
});

test("the clean-up keeps the folders of the ids a running session had before /clear, until that session is gone", async () => {
  const { d, folder, agentsFile, done } = await setup();
  const id = (n: number) => `11111111-2222-3333-4444-${String(n).padStart(12, "0")}`;
  const list = (rows: object[]) => fs.writeFile(agentsFile, JSON.stringify(rows));
  try {
    const [first, cleared, , another] = await Promise.all([1, 2, 3, 4].map((n) => oldTmpFolder(d.cfg.claudeTmpDir, id(n))));
    d.managed.add({ sessionId: id(1), terminal: "t", pid: process.pid, cwd: folder, name: "s", launchedAt: Date.now() });
    delete d.refresh; // the real one, which setup replaces
    d.sessionsRead = true; // no clean-up of its own after the first refresh: this test runs them

    // Started as 1, then /clear made it 2 and 3. Another Claude Code's id is not this session's.
    await list([{ pid: process.pid, sessionId: id(2), cwd: folder, status: "idle" }, { pid: 0x7ffffff0, sessionId: id(4), cwd: folder, status: "idle" }]);
    await d.refresh();
    await list([{ pid: process.pid, sessionId: id(3), cwd: folder, status: "idle" }]);
    await d.refresh();
    assert.deepEqual(d.managed.get(id(3)).previousIds, [id(1), id(2)]);

    await d.sweepClaudeTmp();
    assert.equal(await present(first!), true);
    assert.equal(await present(cleared!), true);
    assert.equal(await present(another!), false);

    d.managed.remove(id(3));
    await d.sweepClaudeTmp();
    assert.equal(await present(first!), false);
    assert.equal(await present(cleared!), false);
  } finally {
    await done();
  }
});

test("a folder stays while a running session shows a file from it or was forked from it, but a session's own files do not keep it", async () => {
  const { d, folder, done } = await setup();
  const id = (n: number) => `11111111-2222-3333-4444-${String(n).padStart(12, "0")}`;
  const ended = 0x7ffffff0;
  try {
    const [shown, forked, own] = await Promise.all([1, 2, 3].map((n) => oldTmpFolder(d.cfg.claudeTmpDir, id(n))));
    d.tracked.set(id(5), { info: {}, meta: { sentFiles: new Set([path.join(shown!, "scratchpad", "a.png")]) } });
    d.managed.add({ sessionId: id(6), terminal: "t", pid: ended, cwd: folder, name: "fork", launchedAt: Date.now(), forkOf: id(2) });
    d.tracked.set(id(3), { info: {}, meta: { sentFiles: new Set([path.join(own!, "scratchpad", "b.png")]) } });

    await d.removeClaudeTmp(id(1), ended);
    await d.removeClaudeTmp(id(2), ended);
    await d.removeClaudeTmp(id(3), ended);
    await d.sweepClaudeTmp();
    assert.equal(await present(shown!), true);
    assert.equal(await present(forked!), true);
    assert.equal(await present(own!), false);

    d.tracked.delete(id(5));
    d.managed.remove(id(6));
    await d.sweepClaudeTmp();
    assert.equal(await present(shown!), false);
    assert.equal(await present(forked!), false);
  } finally {
    await done();
  }
});

test("a session that opens an earlier id of a running one again does not take that id's folder with it when removed", async () => {
  const { d, folder, done } = await setup();
  const id = (n: number) => `11111111-2222-3333-4444-${String(n).padStart(12, "0")}`;
  const ended = 0x7ffffff0;
  try {
    const dir = await oldTmpFolder(d.cfg.claudeTmpDir, id(1));
    d.managed.add({ sessionId: id(2), terminal: "a", pid: ended, cwd: folder, name: "a", launchedAt: Date.now(), previousIds: [id(1)] });
    d.managed.add({ sessionId: id(1), terminal: "b", pid: ended - 1, cwd: folder, name: "b", launchedAt: Date.now() });
    assert.equal(d.managed.get(id(2)).previousIds, undefined);

    d.managed.remove(id(1));
    await d.managed.save();
    const saved = JSON.parse(await fs.readFile(path.join(d.cfg.stateDir, "managed.json"), "utf8"));
    assert.deepEqual(saved[0].releasedIds, [id(1)]);
    await d.removeClaudeTmp(id(1), ended);
    await d.sweepClaudeTmp();
    assert.equal(await present(dir), true);

    d.managed.remove(id(2));
    await d.sweepClaudeTmp();
    assert.equal(await present(dir), false);
  } finally {
    await done();
  }
});

test("the first clean-up waits for the first refresh that reads the sessions", async () => {
  const { d, folder, done } = await setup();
  let sweeps = 0;
  try {
    d.sweepClaudeTmp = async () => void sweeps++;
    delete d.refresh; // the real one, which setup replaces
    const claudeBin = d.cfg.claudeBin;
    d.cfg.claudeBin = path.join(folder, "no-such-claude");
    await d.refresh();
    assert.equal(sweeps, 0);
    d.cfg.claudeBin = claudeBin;
    await d.refresh();
    await d.refresh();
    assert.equal(sweeps, 1);
  } finally {
    await done();
  }
});

test("the clean-up keeps what runs, what Gasho keeps and what is being opened, and removes nothing without the list of what runs", async () => {
  const { d, folder, agentsFile, done } = await setup();
  const id = (n: number) => `11111111-2222-3333-4444-${String(n).padStart(12, "0")}`;
  try {
    const [listed, managed, opening, left] = await Promise.all([1, 2, 3, 4].map((n) => oldTmpFolder(d.cfg.claudeTmpDir, id(n))));
    d.managed.add({ sessionId: id(2), terminal: "t", pid: 0x7ffffff0, cwd: folder, name: "s", launchedAt: Date.now() });
    d.claudeTmpOpening.set(id(3), Date.now() + 60_000);
    await fs.writeFile(agentsFile, JSON.stringify([{ pid: process.pid, sessionId: id(1), status: "idle" }]));

    const claudeBin = d.cfg.claudeBin;
    d.cfg.claudeBin = path.join(folder, "no-such-claude");
    await d.sweepClaudeTmp();
    assert.equal(await present(left!), true);

    d.cfg.claudeBin = claudeBin;
    await d.sweepClaudeTmp();
    assert.equal(await present(left!), false);
    for (const dir of [listed!, managed!, opening!]) assert.equal(await present(dir), true, dir);
  } finally {
    await done();
  }
});
