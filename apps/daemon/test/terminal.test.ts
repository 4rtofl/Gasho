// The terminals Gasho gives the sessions it starts (terminal.ts, terminal-host.ts, terminal-host/): real
// pseudo-terminals and real host processes, with a shell in place of Claude Code. No claude, no zellij, no systemd (a
// fake systemd-run at most). What a host does is tested on both hosts, the Rust one where it is built here.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import xterm from "@xterm/headless";
import { cleanEnv, isAlive, readScreen } from "../src/managed.ts";
import { dumpScreen, hostCommand, keyBytes, NATIVE_HOST, NODE_HOST, pasteBytes, Terminals, type HostHello } from "../src/terminal.ts";

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(what: string, f: () => Promise<T | undefined>, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const v = await f().catch(() => undefined);
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The terminal hosts, each with the reason it is skipped here, if it is. */
const HOSTS: { name: string; host: readonly string[]; skip: string | false }[] = [
  { name: "Node.js", host: NODE_HOST, skip: false },
  {
    name: "Rust",
    host: [NATIVE_HOST],
    skip: !existsSync(NATIVE_HOST) && "the Rust terminal host is not built here (node apps/daemon/scripts/terminal-host.ts)",
  },
];

/** A state folder of its own; every terminal still in it is closed afterwards. */
async function withTerminals(host: readonly string[], run: (t: Terminals, stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-term-"));
  const t = new Terminals({ stateDir, env: cleanEnv(), scopes: false, host });
  try {
    await run(t, stateDir);
  } finally {
    for (const name of (await t.live()).keys()) await t.kill(name);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

const shell = (name: string, script: string) => ({ name, cwd: os.tmpdir(), file: "/bin/sh", args: ["-c", script], env: cleanEnv() });

/** A connection that attaches to a terminal as `gasho-daemon attach` does: its messages one by one, and all it got out. */
function viewer(socket: string, attach: object) {
  const c = net.connect(socket);
  const got: Record<string, unknown>[] = [];
  let wake = () => undefined as void;
  let out = "";
  let buf = "";
  c.setEncoding("utf8");
  c.on("data", (chunk: string) => {
    buf += chunk;
    for (let end = buf.indexOf("\n"); end >= 0; end = buf.indexOf("\n")) {
      const m = JSON.parse(buf.slice(0, end)) as Record<string, unknown>;
      buf = buf.slice(end + 1);
      if (typeof m.out === "string") out += m.out;
      got.push(m);
      wake();
    }
  });
  const send = (m: object) => c.write(`${JSON.stringify(m)}\n`);
  send(attach);
  return {
    next: () => until("a message", async () => got.shift() ?? (await new Promise<undefined>((r) => (wake = () => r(undefined))))),
    send,
    out: () => out,
    close: () => c.end(),
    closed: new Promise<void>((r) => c.once("close", () => r())),
  };
}

test("keys are sent as a terminal sends them, the arrows in the program's cursor key mode", () => {
  const normal = { applicationCursorKeysMode: false };
  const app = { applicationCursorKeysMode: true };
  assert.equal(keyBytes("Enter", normal), "\r");
  assert.equal(keyBytes("Esc", normal), "\x1b");
  assert.equal(keyBytes("Backspace", normal), "\x7f");
  assert.equal(keyBytes("Ctrl u", normal), "\x15");
  assert.equal(keyBytes("Ctrl c", normal), "\x03");
  assert.equal(keyBytes("Down", normal), "\x1b[B");
  assert.equal(keyBytes("Down", app), "\x1bOB");
  assert.equal(keyBytes("Left", app), "\x1bOD");
  assert.equal(keyBytes("s", normal), "s");
  assert.equal(keyBytes("0", normal), "0");
  assert.equal(keyBytes("あ", normal), "あ");
  for (const bad of ["F13", "Ctrl", "ab", "\x1b", ""]) assert.throws(() => keyBytes(bad, normal), /unknown key/);
});

test("a paste is bracketed when the program asks for it, and no escape character gets through", () => {
  assert.equal(pasteBytes("一行目\n二行目", true), "\x1b[200~一行目\n二行目\x1b[201~");
  assert.equal(pasteBytes("x\x1b[201~\ry", true), "\x1b[200~x[201~\ry\x1b[201~");
  assert.equal(pasteBytes("plain", false), "plain");
});

test("without a Rust terminal host that runs here, the terminals run on Node.js", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-term-"));
  const said: string[] = [];
  try {
    assert.deepEqual(await hostCommand((s) => said.push(s), path.join(dir, "missing")), NODE_HOST);
    assert.equal(said.length, 0);
    // Built for another machine, it cannot even be run: say so.
    const other = path.join(dir, "gasho-terminal-host");
    await fs.writeFile(other, "\x7fELF", { mode: 0o755 });
    assert.deepEqual(await hostCommand((s) => said.push(s), other), NODE_HOST);
    assert.match(said[0] ?? "", /gasho-terminal-host does not run here \(.+\); terminals run on Node\.js$/s);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

for (const { name, host, skip } of HOSTS) {
  test(`${name}: a terminal runs its program, shows its screen with dim text told apart, and takes keys and pastes`, { skip }, async () => {
    await withTerminals(host, async (t) => {
      // Bracketed paste and the application cursor keys on, a dim word and a wide one, then everything typed comes back
      // through cat -v (the terminal echoes it too) with escape characters shown as ^[.
      const script = "printf '\\033[?2004h\\033[?1h\\033[2mdim\\033[22m ok 日本語\\n'; exec cat -v";
      const pid = await t.start(shell("gasho-sh-0001", script));
      assert.ok(isAlive(pid));
      const first = await until("the first line", async () => {
        const s = await t.screen("gasho-sh-0001");
        return s.plain.startsWith("dim ok 日本語") ? s : undefined;
      });
      assert.equal(first.typed.split("\n")[0]?.trimEnd(), " ok 日本語");
      assert.equal(first.plain.split("\n").length, 50);

      await t.keys("gasho-sh-0001", "a", "b", "Enter", "Up", "Enter");
      await t.paste("gasho-sh-0001", "hi\x1b");
      await t.keys("gasho-sh-0001", "Enter");
      const lines = await until("what was typed", async () => {
        const l = (await t.screen("gasho-sh-0001")).plain.split("\n").map((x) => x.trimEnd());
        return l.filter((x) => x === "^[[200~hi^[[201~").length === 2 ? l : undefined;
      });
      assert.equal(lines.filter((x) => x === "ab").length, 2);
      assert.equal(lines.filter((x) => x === "^[OA").length, 2);

      await assert.rejects(t.keys("gasho-sh-0001", "a", "F13"), /unknown key/);
    });
  });

  test(`${name}: a terminal outlives the process that started it, and a new daemon finds it; closing it ends its program`, { skip }, async () => {
    await withTerminals(host, async (t, stateDir) => {
      // Another process starts the terminal and exits, as gasho-daemon does when it is restarted.
      const terminal = path.resolve(import.meta.dirname, "../src/terminal.ts");
      const managed = path.resolve(import.meta.dirname, "../src/managed.ts");
      const code = `
        import { Terminals } from ${JSON.stringify(terminal)};
        import { cleanEnv } from ${JSON.stringify(managed)};
        const t = new Terminals({ stateDir: ${JSON.stringify(stateDir)}, env: cleanEnv(), scopes: false, host: ${JSON.stringify(host)} });
        const pid = await t.start({ name: "gasho-left-0002", cwd: "/", file: "/bin/sh", args: ["-c", "echo still here; exec cat"], env: cleanEnv() });
        console.log(pid);
      `;
      const { stdout } = await execFileP(process.execPath, ["--input-type=module", "-e", code]);
      const pid = Number(stdout.trim());
      assert.ok(isAlive(pid));

      const live = await t.live();
      const hello = live.get("gasho-left-0002") as HostHello;
      assert.equal(hello.pid, pid);
      assert.equal(hello.cwd, "/");
      assert.equal(hello.exited, undefined);
      assert.ok(isAlive(hello.hostPid));
      await until("its screen", async () => ((await t.screen("gasho-left-0002")).plain.startsWith("still here") ? true : undefined));

      await t.kill("gasho-left-0002");
      await until("the program to end", async () => (isAlive(pid) || isAlive(hello.hostPid) ? undefined : true));
      assert.deepEqual([...(await t.live()).keys()], []);
      assert.deepEqual(await fs.readdir(t.dir).then((f) => f.filter((x) => !x.endsWith(".log"))), []);
    });
  });

  test(`${name}: the last screen of a program that exited stays readable, and nothing more is typed into it`, { skip }, async () => {
    await withTerminals(host, async (t) => {
      await t.start(shell("gasho-done-0003", "echo did not start"));
      const hello = await until("the end", async () => {
        const h = await t.hello("gasho-done-0003");
        return h.exited ? h : undefined;
      });
      assert.deepEqual(hello.exited, { code: 0 });
      assert.ok((await t.screen("gasho-done-0003")).plain.startsWith("did not start"));
      await assert.rejects(t.keys("gasho-done-0003", "Enter"), /the program has exited/);
      await assert.rejects(t.paste("gasho-done-0003", "x"), /the program has exited/);
    });
  });

  test(`${name}: a viewer gets the screen as it is and what follows, types into it, and the terminal takes its size while it is there`, { skip }, async () => {
    await withTerminals(host, async (t) => {
      const lines = Array.from({ length: 60 }, (_, i) => `line${i}`).join("\\n");
      const script = `printf '\\033[2mdim\\033[22m \\033[1;31mred\\033[0m 日本語\\n${lines}\\n\\033[?2004h\\033[?1h'; exec cat`;
      await t.start(shell("gasho-view-0009", script));
      await until("the last line", async () => ((await t.screen("gasho-view-0009")).plain.includes("line59") ? true : undefined));

      const v = viewer(t.socketOf("gasho-view-0009"), { op: "attach", cols: 60, rows: 20 });
      assert.deepEqual(await v.next(), { ok: true });
      const first = await v.next();
      // The viewer's terminal draws the same screen, with the lines above it and the modes the program set.
      const replica = new xterm.Terminal({ cols: 60, rows: 20, scrollback: 1000, allowProposedApi: true });
      await new Promise<void>((r) => replica.write(String(first.out), r));
      assert.deepEqual(readScreen(dumpScreen(replica)), await t.screen("gasho-view-0009"));
      const all = Array.from({ length: replica.buffer.active.length }, (_, y) => replica.buffer.active.getLine(y)?.translateToString(true));
      assert.ok(all.includes("dim red 日本語"), all.join("\n"));
      assert.equal(replica.modes.bracketedPasteMode, true);
      assert.equal(replica.modes.applicationCursorKeysMode, true);
      assert.equal((await t.hello("gasho-view-0009")).viewers, 1);
      assert.equal((await t.screen("gasho-view-0009")).plain.split("\n").length, 20);

      v.send({ in: "typed\r" });
      await until("what was typed", async () => (v.out().includes("typed\r\ntyped") ? true : undefined));
      v.send({ resize: [70, 30] });
      await until("the new size", async () => ((await t.screen("gasho-view-0009")).plain.split("\n").length === 30 ? true : undefined));
      // When it leaves, the terminal goes back to its own size.
      v.close();
      await until("its own size", async () => ((await t.hello("gasho-view-0009")).viewers === 0 ? true : undefined));
      assert.equal((await t.screen("gasho-view-0009")).plain.split("\n").length, 50);

      const w = viewer(t.socketOf("gasho-view-0009"), { op: "attach", cols: 40, rows: 15 });
      await w.next();
      await w.next();
      // Ctrl+D: cat reads the end of its input and exits.
      w.send({ in: "\x04" });
      let m = await w.next();
      while (m.out !== undefined) m = await w.next();
      assert.deepEqual(m, { exit: { code: 0 } });
      await w.closed;
    });
  });
}

test("a terminal that cannot start says why, and leaves nothing behind", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-term-"));
  const bin = path.join(stateDir, "bin");
  await fs.mkdir(bin);
  // A systemd-run that can make scopes (it runs the command that checks it), but not this one.
  const failing = `#!/bin/sh
for a; do case "$a" in --unit=*) echo "Failed to start transient scope unit: Unit \${a#--unit=}.scope already exists." >&2; exit 1;; esac; done
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
[ $# -gt 0 ] && shift
exec "$@"
`;
  await fs.writeFile(path.join(bin, "systemd-run"), failing, { mode: 0o755 });
  const t = new Terminals({ stateDir, env: { ...cleanEnv(), PATH: `${bin}:${process.env.PATH}` } });
  try {
    const started = Date.now();
    await assert.rejects(t.start(shell("gasho-bad-0004", "exec cat")), /did not start \(it exited \(code 1\)\):\nFailed to start transient scope unit/);
    // It gives up as soon as the host is gone, not after the whole wait.
    assert.ok(Date.now() - started < 5000);
    assert.deepEqual(await fs.readdir(t.dir), []);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

// A systemd-run like systemd 254 and later: it writes its arguments to $LOG, then runs its command (after "--", or
// after the options) as `--scope` does, with each "$$" made a "$" unless it is given --expand-environment=no. With $OLD set, it is like an
// older one: it knows no --expand-environment, and expands nothing. With $FAIL set, it fails like one that finds no
// user manager.
const fakeSystemdRun = (): string => `#!${process.execPath}
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.LOG, "systemd-run " + args.join(" ") + "\\n");
if (process.env.FAIL) process.exit(1);
const asGiven = args.includes("--expand-environment=no");
if (asGiven && process.env.OLD) process.exit(1);
const at = args.indexOf("--");
const command = at >= 0 ? args.slice(at + 1) : args.slice(args.findIndex((a) => !a.startsWith("-")));
const run = asGiven || process.env.OLD ? command : command.map((a) => a.replaceAll("$$", "$"));
process.exit(spawnSync(run[0], run.slice(1), { stdio: "inherit" }).status ?? 1);
`;

test("where systemd runs for the user, a terminal gets a scope of its own, outside gasho-daemon's service, and its paths reach it as they are", async () => {
  // systemd 254 and later would make the "$$" in this folder a "$" (and the terminal would find no config). The name is
  // short so that the sockets' paths stay within 100 bytes in macOS's deep temporary folder.
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "g$$-"));
  const bin = path.join(stateDir, "bin");
  await fs.mkdir(bin);
  const log = path.join(stateDir, "systemd-run.log");
  await fs.writeFile(path.join(bin, "systemd-run"), fakeSystemdRun(), { mode: 0o755 });
  const env = (more: Record<string, string> = {}) => ({ ...cleanEnv(), PATH: `${bin}:${process.env.PATH}`, LOG: log, ...more });
  const calls = async () => (await fs.readFile(log, "utf8")).trim().split("\n");
  const check = (extra: string) => `systemd-run --user --scope --quiet --collect ${extra}-- ${process.execPath} -p '$$'`;
  const started = (name: string, extra: string) => `systemd-run --user --scope --quiet --collect ${extra}--unit=${name} -- ${process.execPath} `;
  // Run in gasho-daemon's service: said only of a terminal that cannot get a scope of its own.
  const said: string[] = [];
  const t = new Terminals({ stateDir, env: env(), inService: true, log: (s) => said.push(s), host: NODE_HOST });
  try {
    await t.start(shell("gasho-scoped-0005", "exec cat"));
    await t.start(shell("gasho-scoped-0006", "exec cat"));
    assert.equal(said.length, 0);
    const c = await calls();
    // Checked once: scopes can be made, and run their command as it is given; each terminal is started in its own.
    assert.equal(c.length, 3);
    assert.equal(c[0], check("--expand-environment=no "));
    for (const [i, name] of [[1, "gasho-scoped-0005"], [2, "gasho-scoped-0006"]] as const) {
      assert.ok(c[i]?.startsWith(started(name, "--expand-environment=no ")), c[i]);
      assert.ok(c[i]?.endsWith(path.join(t.dir, `${name}.json`)), c[i]);
    }
    assert.deepEqual([...(await t.live()).keys()].sort(), ["gasho-scoped-0005", "gasho-scoped-0006"]);

    // An older systemd (before 254) knows no --expand-environment, and expands nothing: scopes are made without it.
    await fs.rm(log);
    const old = new Terminals({ stateDir, env: env({ OLD: "1" }), host: NODE_HOST });
    await old.start(shell("gasho-scoped-0007", "exec cat"));
    const o = await calls();
    assert.equal(o.length, 3);
    assert.equal(o[0], check("--expand-environment=no "));
    assert.equal(o[1], check(""));
    assert.ok(o[2]?.startsWith(started("gasho-scoped-0007", "")), o[2]);

    // Without systemd for the user (macOS, no user manager), a terminal starts without a scope.
    await fs.rm(log);
    const none = new Terminals({ stateDir, env: env({ FAIL: "1" }), inService: true, log: (s) => said.push(s), host: NODE_HOST });
    await none.start(shell("gasho-scoped-0008", "exec cat"));
    assert.deepEqual(await calls(), [check("--expand-environment=no "), check("")]);
    assert.ok((await none.live()).has("gasho-scoped-0008"));
    // In gasho-daemon's service, that terminal is stopped with it: the log says so.
    assert.equal(said.length, 1);
    assert.match(said[0] ?? "", /terminal gasho-scoped-0008 runs inside gasho-daemon's service/);
  } finally {
    for (const name of (await t.live()).keys()) await t.kill(name);
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});

test("a terminal that refuses a request, answers what is not JSON, or hangs up says so rather than leaving the request waiting", async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-term-"));
  const t = new Terminals({ stateDir, env: {}, scopes: false });
  const answers: Record<string, string | undefined> = {
    refuses: `${JSON.stringify({ ok: false, error: "no such key" })}\n`,
    vague: `${JSON.stringify({ ok: false })}\n`,
    garbage: "nope\n",
    hangs: undefined,
  };
  const servers = await Promise.all(
    Object.entries(answers).map(async ([name, answer]) => {
      const server = net.createServer((c) => c.once("data", () => (answer === undefined ? c.end() : c.write(answer))));
      await fs.mkdir(path.dirname(t.socketOf(name)), { recursive: true });
      await new Promise<void>((resolve) => server.listen(t.socketOf(name), resolve));
      return server;
    }),
  );
  try {
    await assert.rejects(t.screen("refuses"), /^Error: no such key$/);
    await assert.rejects(t.screen("vague"), { message: `${t.socketOf("vague")} refused the request` });
    await assert.rejects(t.screen("garbage"), { message: `a bad answer from ${t.socketOf("garbage")}` });
    await assert.rejects(t.keys("hangs", "Enter"), { message: `${t.socketOf("hangs")} closed the connection` });
  } finally {
    for (const s of servers) s.close();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
});
