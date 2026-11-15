// Updating the Gasho server from Gasho, the launcher that takes a version on trial back, and the commit a clone tells
// of. Versions are installed with a fake npm (which "installs" a package whose cli.js answers `version` and
// `check-db`), in a layout in a temporary folder; nothing is downloaded and no process ends.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { HubUpdateInfo } from "@gasho/protocol";
import { cliIn, commitOf, type Install, launcherIn, layoutAt, type Layout, PACKAGE_NAME, versionDir } from "../src/install.ts";
import { currentVersionAt, launch, planLaunch, readTrial, switchCurrent, type Trial } from "../src/launcher.ts";
import { currentVersion, HubUpdater, installedVersions, UPDATE_EXIT_CODE } from "../src/self-update.ts";

/**
 * A stand-in for npm: `install <name>@<version>` makes node_modules/<name> in the folder it runs in, with a cli.js that
 * answers `version` (FAKE_PRINTS: another version) and `check-db` (FAKE_DB_FAIL: it fails), a launcher.js that answers
 * `--check`, and the screen (FAKE_NO_WEB: without it). FAKE_NPM_FAIL: npm fails instead.
 */
const FAKE_NPM = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.env.FAKE_NPM_FAIL) {
  console.error("npm error code E404");
  console.error("npm error 404 Not Found - GET https://npm.pkg.github.com/@4rtoflow%2fgasho-hub");
  process.exit(1);
}
const spec = process.argv[process.argv.length - 1];
const at = spec.lastIndexOf("@");
const name = spec.slice(0, at);
const version = process.env.FAKE_PRINTS || spec.slice(at + 1);
const pkg = path.join(process.cwd(), "node_modules", ...name.split("/"));
fs.mkdirSync(path.join(pkg, "lib"), { recursive: true });
fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name, version, type: "module" }));
fs.writeFileSync(
  path.join(pkg, "lib", "cli.js"),
  [
    "const [cmd] = process.argv.slice(2);",
    "if (cmd === 'version') console.log(" + JSON.stringify(version) + ");",
    "if (cmd === 'check-db') {",
    "  if (process.env.FAKE_DB_FAIL) { console.error('no such column: x'); process.exit(1); }",
    "  console.log('ok');",
    "}",
  ].join("\\n"),
);
fs.writeFileSync(path.join(pkg, "lib", "launcher.js"), "if (process.argv[2] === '--check') console.log('ok');\\n");
if (!process.env.FAKE_NO_WEB) {
  fs.mkdirSync(path.join(pkg, "web"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "web", "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(pkg, "web", "build.json"), JSON.stringify({ build: "hub-" + version }));
}
`;

const HOLDING = "Gasho サーバーを更新しています。起動し直したら、もう一度試してください。";

async function setup(): Promise<{ dir: string; layout: Layout; npm: string; db: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-hub-update-"));
  const layout = layoutAt(path.join(dir, "hub"));
  const npm = path.join(dir, "npm");
  await fs.writeFile(npm, FAKE_NPM, { mode: 0o755 });
  // A database to copy and to check, as the Gasho server keeps one.
  const db = path.join(dir, "hub.db");
  const d = new DatabaseSync(db);
  d.exec("CREATE TABLE devices (id TEXT PRIMARY KEY); INSERT INTO devices VALUES ('d1')");
  d.close();
  return { dir, layout, npm, db };
}

/** A version installed as an update would have installed it. */
async function installed(layout: Layout, npm: string, version: string): Promise<void> {
  const dir = versionDir(layout, version);
  await fs.mkdir(dir, { recursive: true });
  execFileSync(npm, ["install", `${PACKAGE_NAME}@${version}`], { cwd: dir, env: { ...process.env, FAKE_NPM_FAIL: "", FAKE_PRINTS: "" } });
}

interface Run {
  updater: HubUpdater;
  /** The update's state at each change. */
  states: HubUpdateInfo[];
  /** What hold() was given, in order. */
  holds: (string | undefined)[];
  exited: Promise<number>;
}

function updater(o: {
  layout: Layout;
  npm: string;
  db: string;
  version?: string;
  install?: Install;
  service?: boolean;
  env?: NodeJS.ProcessEnv;
  inFlight?: () => number;
  drainMs?: number;
  now?: () => number;
}): Run {
  const states: HubUpdateInfo[] = [];
  const holds: (string | undefined)[] = [];
  let exit: (code: number) => void = () => undefined;
  const exited = new Promise<number>((resolve) => (exit = resolve));
  const version = o.version ?? "0.1.0";
  const u = new HubUpdater({
    install: o.install ?? { kind: "managed", version },
    layout: o.layout,
    version,
    service: o.service ?? true,
    npm: o.npm,
    node: process.execPath,
    env: { ...process.env, ...o.env },
    dbFile: o.db,
    inFlight: o.inFlight ?? (() => 0),
    hold: (why) => holds.push(why),
    changed: () => states.push(u.info()),
    exit: (code) => exit(code),
    log: () => undefined,
    drainMs: o.drainMs,
    pollMs: 10,
    now: o.now,
  });
  return { updater: u, states, holds, exited };
}

/** Waits until the update has ended, by failing or by ending the process. */
async function settled(r: Run): Promise<"exited" | "failed"> {
  for (let i = 0; i < 1000; i++) {
    if (r.states.at(-1)?.failed) return "failed";
    if (r.states.at(-1)?.progress?.step === "restart") {
      assert.equal(await r.exited, UPDATE_EXIT_CODE);
      return "exited";
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("the update did not end");
}

const exists = (file: string) => existsSync(file);

test("only a Gasho server installed by service install and run as its service can be updated from Gasho", async () => {
  const { layout, npm, db } = await setup();
  const repo = updater({ layout, npm, db, install: { kind: "repo", repo: "/r" } }).updater.info();
  assert.equal(repo.canUpdate, false);
  assert.match(repo.reason ?? "", /git pull/);
  assert.equal(repo.command, undefined);

  for (const install of [{ kind: "npx" }, { kind: "package", cli: "/usr/lib/node_modules/@4rtoflow/gasho-hub/lib/cli.js" }] as Install[]) {
    const info = updater({ layout, npm, db, install }).updater.info();
    assert.equal(info.canUpdate, false);
    assert.equal(info.command, "npx @4rtoflow/gasho-hub@latest service install");
  }

  const foreground = updater({ layout, npm, db, service: false }).updater.info();
  assert.equal(foreground.canUpdate, false);
  assert.match(foreground.reason ?? "", /常駐させずに/);
  assert.equal(foreground.command, "npx @4rtoflow/gasho-hub@latest service install");

  const r = updater({ layout, npm, db });
  assert.deepEqual(r.updater.info(), { canUpdate: true });
  assert.deepEqual(r.updater.start("latest"), { ok: false, error: "版の指定が正しくありません。" });
  assert.deepEqual(r.updater.start("0.1.0"), { ok: false, error: "すでに 0.1.0 で動いています。" });
  assert.equal(updater({ layout, npm, db, install: { kind: "npx" } }).updater.start("0.2.0").ok, false);
});

test("an update installs the version beside the running one, checks it, holds new commands, and switches on trial", async () => {
  const { layout, npm, db } = await setup();
  await installed(layout, npm, "0.1.0");
  switchCurrent(layout.root, "0.1.0");
  let busy = 3;
  // Commands under way end one by one; the update waits for them.
  const r = updater({ layout, npm, db, inFlight: () => (busy > 0 ? busy-- : 0) });
  await r.updater.load();
  assert.deepEqual(r.updater.start("0.2.0"), { ok: true });
  assert.equal(r.updater.start("0.2.1").error, "0.2.0 に更新している途中です。");
  assert.equal(await settled(r), "exited");
  assert.deepEqual(
    r.states.map((s) => s.progress?.step),
    ["install", "check", "drain", "restart"],
  );
  assert.equal(busy, 0);
  // New commands stay refused until the process ends.
  assert.deepEqual(r.holds, [HOLDING]);

  assert.equal(await currentVersion(layout), "0.2.0");
  assert.equal(await fs.readlink(layout.current), path.join("versions", "0.2.0"));
  const trial = readTrial(layout.trialFile);
  assert.deepEqual({ ...trial, at: 0 }, { from: "0.1.0", to: "0.2.0", at: 0, starts: 0 });
  // The database as it was, kept aside; the copy it was checked on is gone.
  assert.ok(exists(`${db}.before-0.2.0`));
  const kept = new DatabaseSync(`${db}.before-0.2.0`, { readOnly: true });
  assert.deepEqual(kept.prepare("SELECT id FROM devices").all().map((row) => row.id), ["d1"]);
  kept.close();
  assert.deepEqual((await fs.readdir(layout.root)).filter((n) => n.startsWith(".check-db")), []);
  // Nothing half-done is left in versions.
  assert.deepEqual((await fs.readdir(layout.versions)).sort(), ["0.1.0", "0.2.0"]);
  assert.deepEqual(await installedVersions(layout), ["0.1.0", "0.2.0"]);
});

test("a version on trial says so, is confirmed after its checks, and then removes what is no longer needed", async () => {
  const { layout, npm, db } = await setup();
  for (const v of ["0.0.9", "0.1.0", "0.2.0"]) await installed(layout, npm, v);
  switchCurrent(layout.root, "0.2.0");
  await fs.writeFile(layout.trialFile, JSON.stringify({ from: "0.1.0", to: "0.2.0", at: 1000, starts: 1 } satisfies Trial));
  await fs.writeFile(layout.launcher, "// the launcher of 0.1.0\n");
  for (const v of ["0.1.0", "0.2.0"]) await fs.writeFile(`${db}.before-${v}`, "");

  const r = updater({ layout, npm, db, version: "0.2.0" });
  await r.updater.load();
  assert.equal(r.updater.onTrial(), true);
  const info = r.updater.info();
  assert.deepEqual(info.progress, { version: "0.2.0", step: "trial", at: 1000 });
  assert.equal(info.previous, "0.1.0");
  assert.deepEqual(info.installed, ["0.0.9", "0.1.0"]);

  // Why it ends, for the launcher; a stop is not a failure: the next start tries it again.
  r.updater.recordFailure("listen EACCES");
  assert.equal(JSON.parse(await fs.readFile(layout.lastErrorFile, "utf8")).message, "listen EACCES");
  r.updater.stoppedOnTrial();
  assert.equal(readTrial(layout.trialFile)?.starts, 0);

  await r.updater.confirm();
  assert.equal(r.updater.onTrial(), false);
  assert.equal(exists(layout.trialFile), false);
  assert.equal(await fs.readFile(layout.launcher, "utf8"), await fs.readFile(launcherIn(versionDir(layout, "0.2.0")), "utf8"));
  const record = JSON.parse(await fs.readFile(layout.updateFile, "utf8"));
  assert.deepEqual([record.from, record.to], ["0.1.0", "0.2.0"]);
  const after = r.updater.info();
  assert.equal(after.progress, undefined);
  assert.equal(after.previous, "0.1.0");
  // The version to go back to stays; an older one goes, with the copies of the database but the last.
  assert.deepEqual(await installedVersions(layout), ["0.1.0", "0.2.0"]);
  assert.equal(exists(`${db}.before-0.1.0`), false);
  assert.equal(exists(`${db}.before-0.2.0`), true);
  assert.equal(r.states.at(-1)?.progress, undefined);

  // Not on trial: nothing is written.
  await fs.rm(layout.lastErrorFile);
  r.updater.recordFailure("boom");
  assert.equal(exists(layout.lastErrorFile), false);
});

test("going back to the version before installs nothing and goes through the same trial", async () => {
  const { layout, npm, db } = await setup();
  for (const v of ["0.1.0", "0.2.0"]) await installed(layout, npm, v);
  switchCurrent(layout.root, "0.2.0");
  await fs.writeFile(layout.updateFile, JSON.stringify({ from: "0.1.0", to: "0.2.0", at: 1 }));
  const r = updater({ layout, npm, db, version: "0.2.0", env: { FAKE_NPM_FAIL: "1" } });
  await r.updater.load();
  assert.equal(r.updater.info().previous, "0.1.0");
  assert.deepEqual(r.updater.start("0.1.0"), { ok: true });
  assert.equal(await settled(r), "exited");
  assert.equal(await currentVersion(layout), "0.1.0");
  assert.deepEqual({ ...readTrial(layout.trialFile), at: 0 }, { from: "0.2.0", to: "0.1.0", at: 0, starts: 0 });
});

test("an update that fails before the switch changes nothing and takes new commands again", async (t) => {
  const cases: { name: string; env?: NodeJS.ProcessEnv; inFlight?: () => number; error: RegExp; held: boolean }[] = [
    { name: "npm fails", env: { FAKE_NPM_FAIL: "1" }, error: /npm で @4rtoflow\/gasho-hub@0\.2\.0 を入れられませんでした：[\s\S]*E404/, held: false },
    { name: "it is another version", env: { FAKE_PRINTS: "9.9.9" }, error: /0\.2\.0 ではなく 9\.9\.9 でした/, held: false },
    { name: "its screen is missing", env: { FAKE_NO_WEB: "1" }, error: /web\/index\.html がありません/, held: false },
    { name: "it cannot open the database", env: { FAKE_DB_FAIL: "1" }, error: /0\.2\.0 では、データベース（の写し）を開けませんでした：no such column/, held: false },
    { name: "commands under way do not end", inFlight: () => 1, error: /処理中の命令（[^）]*）が 1 件、終わらなかったので、更新をやめました/, held: true },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      const { layout, npm, db } = await setup();
      await installed(layout, npm, "0.1.0");
      switchCurrent(layout.root, "0.1.0");
      const r = updater({ layout, npm, db, env: c.env, inFlight: c.inFlight, drainMs: 50 });
      await r.updater.load();
      assert.deepEqual(r.updater.start("0.2.0"), { ok: true });
      assert.equal(await settled(r), "failed");
      const failed = r.updater.info().failed;
      assert.equal(failed?.version, "0.2.0");
      assert.match(failed?.error ?? "", c.error);
      assert.equal(r.updater.info().progress, undefined);
      assert.deepEqual(r.holds, c.held ? [HOLDING, undefined] : []);
      assert.equal(await currentVersion(layout), "0.1.0");
      assert.equal(exists(layout.trialFile), false);
      assert.equal(exists(`${db}.before-0.2.0`), false);
      assert.deepEqual((await fs.readdir(layout.versions)).filter((n) => n.startsWith(".")), []);
      // A version that did not pass its checks is gone; one that waited in vain is kept for the next try.
      assert.deepEqual(await installedVersions(layout), c.held ? ["0.1.0", "0.2.0"] : ["0.1.0"]);
      assert.deepEqual(r.updater.info().installed, c.held ? ["0.2.0"] : undefined);
      assert.deepEqual((await fs.readdir(layout.root)).filter((n) => n.startsWith(".check-db")), []);
      // It can be tried again.
      assert.equal(r.updater.start("0.2.0").ok, true);
      await settled(r);
    });
  }
});

test("a version that went back by itself says why, for a week", async () => {
  const { layout, npm, db } = await setup();
  await installed(layout, npm, "0.1.0");
  switchCurrent(layout.root, "0.1.0");
  const now = Date.now();
  await fs.writeFile(layout.rollbackFile, JSON.stringify({ from: "0.2.0", to: "0.1.0", error: "読み込めませんでした：SyntaxError", at: now - 1000 }));
  const r = updater({ layout, npm, db, now: () => now });
  await r.updater.load();
  assert.deepEqual(r.updater.info().rolledBack, { from: "0.2.0", to: "0.1.0", error: "読み込めませんでした：SyntaxError", at: now - 1000 });
  const later = updater({ layout, npm, db, now: () => now + 8 * 24 * 3600_000 });
  await later.updater.load();
  assert.equal(later.updater.info().rolledBack, undefined);
});

// ---- the launcher ----

test("the launcher starts current, tries a version on trial once, and takes it back after that", () => {
  const trial: Trial = { from: "0.1.0", to: "0.2.0", at: 1, starts: 0 };
  assert.deepEqual(planLaunch(undefined, "0.1.0"), { action: "start" });
  assert.deepEqual(planLaunch(trial, "0.2.0"), { action: "try", trial });
  assert.deepEqual(planLaunch({ ...trial, starts: 1 }, "0.2.0"), { action: "rollback", trial: { ...trial, starts: 1 } });
  // A switch that did not happen, or one made by hand since: the trial is not about what runs.
  assert.deepEqual(planLaunch(trial, "0.1.0"), { action: "drop-trial" });
  assert.deepEqual(planLaunch(trial, undefined), { action: "drop-trial" });
});

/** A layout whose versions record that they were started (globalThis.started) instead of starting a Gasho server. */
async function launcherLayout(versions: Record<string, string>): Promise<Layout> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-hub-launch-"));
  const layout = layoutAt(dir);
  for (const [version, code] of Object.entries(versions)) {
    const cli = cliIn(versionDir(layout, version));
    await fs.mkdir(path.dirname(cli), { recursive: true });
    await fs.writeFile(path.join(path.dirname(cli), "..", "package.json"), JSON.stringify({ type: "module" }));
    await fs.writeFile(cli, code || `globalThis.started.push(${JSON.stringify(version)});\n`);
  }
  return layout;
}

const started = () => (globalThis as { started?: string[] }).started ?? [];

async function launched(layout: Layout): Promise<string[]> {
  (globalThis as { started?: string[] }).started = [];
  const env = { launcher: process.env.GASHO_HUB_LAUNCHER, home: process.env.GASHO_HUB_HOME };
  const error = console.error;
  console.error = () => undefined;
  try {
    await launch(layout.root);
    assert.equal(process.env.GASHO_HUB_LAUNCHER, "1");
    assert.equal(process.env.GASHO_HUB_HOME, layout.root);
  } finally {
    console.error = error;
    for (const [name, value] of [["GASHO_HUB_LAUNCHER", env.launcher], ["GASHO_HUB_HOME", env.home]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  return started();
}

test("launch: without a trial it starts current; on a trial's first start it counts it", async () => {
  const plain = await launcherLayout({ "0.1.0": "" });
  switchCurrent(plain.root, "0.1.0");
  assert.deepEqual(await launched(plain), ["0.1.0"]);

  const trying = await launcherLayout({ "0.1.0": "", "0.2.0": "" });
  switchCurrent(trying.root, "0.2.0");
  await fs.writeFile(trying.trialFile, JSON.stringify({ from: "0.1.0", to: "0.2.0", at: 1, starts: 0 }));
  assert.deepEqual(await launched(trying), ["0.2.0"]);
  assert.equal(readTrial(trying.trialFile)?.starts, 1);
});

test("launch: a version on trial that ended before it was confirmed is taken back, with why", async () => {
  const layout = await launcherLayout({ "0.1.0": "", "0.2.0": "" });
  switchCurrent(layout.root, "0.2.0");
  await fs.writeFile(layout.trialFile, JSON.stringify({ from: "0.1.0", to: "0.2.0", at: 1, starts: 1 }));
  await fs.writeFile(layout.lastErrorFile, JSON.stringify({ message: "listen EADDRNOTAVAIL", at: 2 }));
  assert.deepEqual(await launched(layout), ["0.1.0"]);
  assert.equal(currentVersionAt(layout.root), "0.1.0");
  const back = JSON.parse(await fs.readFile(layout.rollbackFile, "utf8"));
  assert.deepEqual([back.from, back.to, back.error], ["0.2.0", "0.1.0", "listen EADDRNOTAVAIL"]);
  assert.equal(exists(layout.trialFile), false);
  assert.equal(exists(layout.lastErrorFile), false);

  // Without a message, it says that it stopped before its checks.
  const quiet = await launcherLayout({ "0.1.0": "", "0.2.0": "" });
  switchCurrent(quiet.root, "0.2.0");
  await fs.writeFile(quiet.trialFile, JSON.stringify({ from: "0.1.0", to: "0.2.0", at: 1, starts: 1 }));
  assert.deepEqual(await launched(quiet), ["0.1.0"]);
  assert.match(JSON.parse(await fs.readFile(quiet.rollbackFile, "utf8")).error, /確かめが済む前に止まりました/);
});

test("launch: a version on trial that cannot be loaded is taken back at once and the version before starts", async () => {
  const layout = await launcherLayout({ "0.1.0": "", "0.2.0": "this is not JavaScript (" });
  switchCurrent(layout.root, "0.2.0");
  await fs.writeFile(layout.trialFile, JSON.stringify({ from: "0.1.0", to: "0.2.0", at: 1, starts: 0 }));
  assert.deepEqual(await launched(layout), ["0.1.0"]);
  assert.equal(currentVersionAt(layout.root), "0.1.0");
  assert.match(JSON.parse(await fs.readFile(layout.rollbackFile, "utf8")).error, /^読み込めませんでした：/);
  assert.equal(exists(layout.trialFile), false);
});

test("launch: a trial about another version than current is dropped; a version not on trial that fails is not taken back", async () => {
  const layout = await launcherLayout({ "0.1.0": "", "0.2.0": "" });
  switchCurrent(layout.root, "0.1.0");
  await fs.writeFile(layout.trialFile, JSON.stringify({ from: "0.1.0", to: "0.2.0", at: 1, starts: 0 }));
  assert.deepEqual(await launched(layout), ["0.1.0"]);
  assert.equal(exists(layout.trialFile), false);

  const broken = await launcherLayout({ "0.1.0": "", "0.2.0": "throw new Error('broken')" });
  switchCurrent(broken.root, "0.2.0");
  await assert.rejects(launched(broken), /broken/);
  assert.equal(currentVersionAt(broken.root), "0.2.0");
  assert.equal(exists(broken.rollbackFile), false);
});

test("the launcher run as a file only says that it loads when asked to check", () => {
  const launcher = path.resolve(import.meta.dirname, "../src/launcher.ts");
  assert.equal(execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", launcher, "--check"], { encoding: "utf8" }), "ok\n");
});

test("a clone's commit: its short SHA, -dirty once a tracked file changed, none for a folder inside another repository", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-hub-commit-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  await fs.writeFile(path.join(dir, "a.txt"), "a");
  git("add", "a.txt");
  git("commit", "-qm", "a");
  const sha = git("rev-parse", "--short", "HEAD");
  await fs.writeFile(path.join(dir, "new.txt"), "not tracked");
  assert.equal(await commitOf(dir), sha);
  await fs.writeFile(path.join(dir, "a.txt"), "b");
  assert.equal(await commitOf(dir), `${sha}-dirty`);
  // A Gasho folder without a .git of its own, in a repository such as $HOME's dotfiles.
  await fs.mkdir(path.join(dir, "gasho"));
  assert.equal(await commitOf(path.join(dir, "gasho")), undefined);
  await fs.rm(dir, { recursive: true, force: true });
});
