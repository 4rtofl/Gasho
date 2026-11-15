// Updating the Gasho server from Gasho (hub.update), as gasho-daemon is updated (apps/daemon/src/self-update.ts, whose
// parts are copied here: the two are published apart). Each version is installed in a folder of its own (install.ts)
// and the service runs the launcher, which starts the one `current` links to (launcher.ts). An update installs the
// new version beside the running one; checks that it loads, that its files are whole, and that it migrates a copy of
// the database; holds new commands and waits for those under way (their answers would be lost, and a message put back
// in the chat box would be sent twice); copies the database aside; writes the trial and switches `current`; and ends
// with UPDATE_EXIT_CODE, for the service to start the new version. Until the switch nothing changes. The new version
// is on trial until it has been up for a while and its own checks pass (confirm): one that ends before that is taken
// back by the launcher at its next start.
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { CommandResult, HubUpdateInfo, HubUpdateStep } from "@gasho/protocol";
import { cliIn, type Install, launcherIn, type Layout, PACKAGE_NAME, VERSION_RE, versionDir, webIn } from "./install.ts";
import { readTrial, switchCurrent, type Trial, writeJson } from "./launcher.ts";

/** How the Gasho server ends to be started again as another version (EX_TEMPFAIL: the service manager restarts it). */
export const UPDATE_EXIT_CODE = 75;
const INSTALL_TIMEOUT_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 60_000;
/** How long an update waits for the commands under way, before it gives up and changes nothing. */
const DRAIN_MS = 2 * 60_000;
const DRAIN_POLL_MS = 500;
/** After the switch: time for the last step to reach the browsers before the process ends. */
const EXIT_DELAY_MS = 500;
/** How long a version that went back by itself is told about. */
const ROLLBACK_SHOWN_MS = 7 * 24 * 3600_000;

/** What runs on the Gasho server's machine to make it updatable from Gasho. */
export const INSTALL_COMMAND = `npx ${PACKAGE_NAME}@latest service install`;

/** The last update that went through, or the last one that went back by itself (rollback.json). */
interface Record_ {
  from: string;
  to: string;
  at: number;
  error?: string;
}

function run(cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { ...o, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      // The end of what it said: npm prints its error last, then where its log is.
      const lines = `${stderr}\n${stdout}`.trim().split("\n").filter((l) => !/A complete log of this run/.test(l));
      const said = lines.slice(-5).join("\n");
      const why = (err as { killed?: boolean }).killed ? "時間がかかりすぎたので止めました" : said || err.message;
      reject(new Error(why));
    });
  });
}

/**
 * Installs `version` in its folder of `versions`, unless it is there. It is installed in a hidden folder first and
 * then moved into place, so that a folder of `versions` is always a whole install.
 */
export async function installVersion(layout: Layout, version: string, o: { npm: string; env: NodeJS.ProcessEnv }): Promise<string> {
  const dir = versionDir(layout, version);
  if (fs.existsSync(cliIn(dir))) return dir;
  await fsp.mkdir(layout.versions, { recursive: true });
  const tmp = path.join(layout.versions, `.${version}-${process.pid}-${Date.now().toString(36)}`);
  try {
    await fsp.mkdir(tmp);
    await fsp.writeFile(path.join(tmp, "package.json"), `${JSON.stringify({ private: true, description: `gasho-hub ${version}` }, null, 2)}\n`);
    // --prefer-online: a version published since npm last read the package's list of versions is found.
    await run(o.npm, ["install", "--prefer-online", "--no-audit", "--no-fund", "--omit=dev", `${PACKAGE_NAME}@${version}`], {
      cwd: tmp,
      env: o.env,
      timeout: INSTALL_TIMEOUT_MS,
    }).catch((e: unknown) => {
      throw new Error(`npm で ${PACKAGE_NAME}@${version} を入れられませんでした：${e instanceof Error ? e.message : String(e)}`);
    });
    if (!fs.existsSync(cliIn(tmp))) throw new Error(`npm で入れた ${PACKAGE_NAME}@${version} に lib/cli.js がありません。`);
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rename(tmp, dir);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
  return dir;
}

/**
 * Checks an installed version before anything changes: it loads and says it is `version`; its screen and launcher are
 * there and the launcher loads; and it opens (migrating) a copy of the database, when there is one.
 */
export async function checkVersion(dir: string, version: string, o: { node: string; env: NodeJS.ProcessEnv; dbFile: string; scratch: string }): Promise<void> {
  const said = (await run(o.node, [cliIn(dir), "version"], { cwd: dir, env: o.env, timeout: CHECK_TIMEOUT_MS }).catch((e: unknown) => {
    throw new Error(`入れた Gasho サーバー ${version} が起動しませんでした：${e instanceof Error ? e.message : String(e)}`);
  }))
    .trim()
    .split("\n")
    .pop()
    ?.trim();
  if (said !== version) throw new Error(`入れた Gasho サーバーが ${version} ではなく ${said || "不明な版"} でした。`);
  for (const file of [path.join(webIn(dir), "index.html"), path.join(webIn(dir), "build.json"), launcherIn(dir)]) {
    if (!fs.existsSync(file)) throw new Error(`入れた Gasho サーバー ${version} に ${path.relative(dir, file)} がありません。`);
  }
  await run(o.node, [launcherIn(dir), "--check"], { cwd: dir, env: o.env, timeout: CHECK_TIMEOUT_MS }).catch((e: unknown) => {
    throw new Error(`入れた Gasho サーバー ${version} の launcher が動きませんでした：${e instanceof Error ? e.message : String(e)}`);
  });
  if (!fs.existsSync(o.dbFile)) return;
  const copy = path.join(o.scratch, `.check-db-${process.pid}-${Date.now().toString(36)}.db`);
  try {
    await copyDatabase(o.dbFile, copy);
    await run(o.node, [cliIn(dir), "check-db", copy], { cwd: dir, env: o.env, timeout: CHECK_TIMEOUT_MS }).catch((e: unknown) => {
      throw new Error(`入れた Gasho サーバー ${version} では、データベース（の写し）を開けませんでした：${e instanceof Error ? e.message : String(e)}`);
    });
  } finally {
    for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) await fsp.rm(f, { force: true });
  }
}

/** A consistent copy of the database while the Gasho server keeps it open (SQLite's online backup). */
export async function copyDatabase(from: string, to: string): Promise<void> {
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    await backup(db, to);
  } finally {
    db.close();
  }
}

/** The version `current` links to, if it links to one. */
export async function currentVersion(layout: Layout): Promise<string | undefined> {
  const target = await fsp.readlink(layout.current).catch(() => undefined);
  const version = target ? path.basename(target) : undefined;
  return version && VERSION_RE.test(version) ? version : undefined;
}

/** The versions installed in `versions`, oldest first. */
export async function installedVersions(layout: Layout): Promise<string[]> {
  const names = await fsp.readdir(layout.versions).catch(() => [] as string[]);
  return names.filter((n) => VERSION_RE.test(n) && fs.existsSync(cliIn(versionDir(layout, n)))).sort(compareVersions);
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function readRecord(file: string): Promise<Record_ | undefined> {
  try {
    const r = JSON.parse(await fsp.readFile(file, "utf8")) as Partial<Record_>;
    if (typeof r.from !== "string" || typeof r.to !== "string" || typeof r.at !== "number") return undefined;
    return { from: r.from, to: r.to, at: r.at, ...(typeof r.error === "string" ? { error: r.error } : {}) };
  } catch {
    return undefined;
  }
}

/** Starts the trial of `to`: written before `current` is switched, so that the launcher counts its starts. */
export async function beginTrial(layout: Layout, from: string, to: string, now = Date.now()): Promise<void> {
  await fsp.mkdir(layout.root, { recursive: true });
  writeJson(layout.trialFile, { from, to, at: now, starts: 0 } satisfies Trial);
  switchCurrent(layout.root, to);
}

export interface HubUpdaterOptions {
  install: Install;
  layout: Layout;
  /** The running version (HUB_VERSION). */
  version: string;
  /** Run by the launcher under the service (service.ts, runAsService). */
  service: boolean;
  npm: string;
  node: string;
  env: NodeJS.ProcessEnv;
  dbFile: string;
  /** The commands under way that an update waits for (Hub.inFlight). */
  inFlight: () => number;
  /** Refuses new commands with `why`, or takes them again (Hub.hold). */
  hold: (why: string | undefined) => void;
  /** info() changed (sent to the browsers). */
  changed: () => void;
  /** Ends the process, for the service to start the new version. */
  exit: (code: number) => void;
  log: (s: string) => void;
  drainMs?: number;
  pollMs?: number;
  now?: () => number;
}

const STEP_LOG: Record<HubUpdateStep, string> = {
  install: "installing",
  check: "checking",
  drain: "waiting for the commands under way",
  restart: "switched; ending so that the service starts it",
  trial: "on trial",
};

/** Why new commands are refused while an update waits for those under way. */
const HOLDING = "Gasho サーバーを更新しています。起動し直したら、もう一度試してください。";

/** The update of this Gasho server from Gasho: whether it can be, the one under way, and this version's trial. */
export class HubUpdater {
  private o: HubUpdaterOptions;
  private progress: HubUpdateInfo["progress"];
  private failed: HubUpdateInfo["failed"];
  private installed: string[] = [];
  private previous: string | undefined;
  private rolledBack: HubUpdateInfo["rolledBack"];
  /** This version's trial, when it was started by an update and is not confirmed yet. */
  private trial: Trial | undefined;

  constructor(o: HubUpdaterOptions) {
    this.o = o;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Reads the versions installed beside this one, the one it replaced, its trial and what went back by itself. */
  async load(): Promise<void> {
    if (this.o.install.kind !== "managed") return;
    const { layout, version } = this.o;
    this.installed = await installedVersions(layout);
    const trial = readTrial(layout.trialFile);
    this.trial = trial?.to === version ? trial : undefined;
    const record = await readRecord(layout.updateFile);
    // On trial, the version to go back to is the one the trial came from; after it, the one the record names.
    const from = this.trial?.from ?? (record?.to === version ? record.from : undefined);
    this.previous = from && this.installed.includes(from) ? from : undefined;
    const back = await readRecord(layout.rollbackFile);
    this.rolledBack =
      back && back.to === version && this.now() - back.at < ROLLBACK_SHOWN_MS
        ? { from: back.from, to: back.to, at: back.at, ...(back.error ? { error: back.error } : {}) }
        : undefined;
    if (this.trial && !this.progress) this.progress = { version, step: "trial", at: this.trial.at };
  }

  /** Whether this version is on trial (just started by an update). */
  onTrial(): boolean {
    return this.trial !== undefined;
  }

  info(): HubUpdateInfo {
    const { install, service } = this.o;
    if (install.kind === "repo") {
      return {
        canUpdate: false,
        reason: "リポジトリの clone から動かしているので、Gasho からは更新できません。git pull して画面をビルドし直し（npm run web:build）、Gasho サーバーを動かし直してください。",
      };
    }
    if (install.kind !== "managed") {
      return {
        canUpdate: false,
        reason: "Gasho から更新できるようにするには、Gasho サーバーのマシンでこのコマンドを一度実行してください。常駐の設定が、Gasho から更新できる形に変わります。",
        command: INSTALL_COMMAND,
      };
    }
    if (!service) {
      return {
        canUpdate: false,
        reason: "常駐させずに動かしているので、Gasho からは更新できません。Gasho サーバーのマシンでこのコマンドを実行すると、常駐させて Gasho から更新できるようになります。",
        command: INSTALL_COMMAND,
      };
    }
    const installed = this.installed.filter((v) => v !== this.o.version);
    return {
      canUpdate: true,
      ...(installed.length > 0 ? { installed } : {}),
      ...(this.previous ? { previous: this.previous } : {}),
      ...(this.progress ? { progress: this.progress } : {}),
      ...(this.failed ? { failed: this.failed } : {}),
      ...(this.rolledBack ? { rolledBack: this.rolledBack } : {}),
    };
  }

  /** Begins an update to `version` (or back to it); the result says whether it has begun. */
  start(version: string): CommandResult {
    const info = this.info();
    if (!info.canUpdate) return { ok: false, error: info.reason ?? "Gasho からは更新できません。" };
    if (typeof version !== "string" || !VERSION_RE.test(version)) return { ok: false, error: "版の指定が正しくありません。" };
    if (version === this.o.version) return { ok: false, error: `すでに ${version} で動いています。` };
    if (this.progress && this.progress.step !== "trial") return { ok: false, error: `${this.progress.version} に更新している途中です。` };
    this.failed = undefined;
    void this.run(version);
    return { ok: true };
  }

  private step(version: string, step: HubUpdateStep): void {
    this.progress = { version, step, at: this.now() };
    this.o.log(`update to ${version}: ${STEP_LOG[step]}`);
    this.o.changed();
  }

  private async run(version: string): Promise<void> {
    const { layout, npm, node, env, dbFile } = this.o;
    const trial = this.trial;
    let held = false;
    let unchecked: string | undefined;
    try {
      this.step(version, "install");
      unchecked = await installVersion(layout, version, { npm, env });
      this.step(version, "check");
      await checkVersion(unchecked, version, { node, env, dbFile, scratch: layout.root });
      unchecked = undefined;
      await this.load();
      this.step(version, "drain");
      this.o.hold(HOLDING);
      held = true;
      await this.drain();
      // The database as it was before the new version touched it, to go back by hand if ever needed.
      if (fs.existsSync(dbFile)) await copyDatabase(dbFile, `${dbFile}.before-${version}`);
      // A version still on trial is replaced as if it had been confirmed: it is the one the new version came from.
      await beginTrial(layout, this.o.version, version, this.now());
      if (trial) this.trial = undefined;
      this.step(version, "restart");
      setTimeout(() => this.o.exit(UPDATE_EXIT_CODE), EXIT_DELAY_MS);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.o.log(`update to ${version} failed: ${error}`);
      if (held) this.o.hold(undefined);
      // A version that did not pass its checks is not kept, nor offered as installed: a retry installs it again.
      if (unchecked) {
        await fsp.rm(unchecked, { recursive: true, force: true }).catch(() => undefined);
        this.installed = await installedVersions(layout);
      }
      this.progress = this.trial ? { version: this.o.version, step: "trial", at: this.trial.at } : undefined;
      this.failed = { version, error, at: this.now() };
      this.o.changed();
    }
  }

  /** Waits until no command is under way; gives up after a while (nothing has changed yet). */
  private async drain(): Promise<void> {
    const until = this.now() + (this.o.drainMs ?? DRAIN_MS);
    let n = this.o.inFlight();
    while (n > 0) {
      if (this.now() >= until) {
        throw new Error(`処理中の命令（セッションへの送信、起動、プラグインの追加など）が ${n} 件、終わらなかったので、更新をやめました。終わってから、もう一度更新してください。`);
      }
      await new Promise((r) => setTimeout(r, this.o.pollMs ?? DRAIN_POLL_MS));
      n = this.o.inFlight();
    }
  }

  /**
   * Ends this version's trial once it has been up for a while and its checks passed (cli.ts): the record for going
   * back, the launcher from this version, and the versions and copies of the database no longer needed.
   */
  async confirm(): Promise<void> {
    const trial = this.trial;
    if (!trial) return;
    const { layout, version, dbFile } = this.o;
    const dir = versionDir(layout, version);
    // The launcher of the version that started well goes beside `current` (written aside, then renamed over it).
    const tmp = `${layout.launcher}.${process.pid}.tmp`;
    await fsp.copyFile(launcherIn(dir), tmp);
    await fsp.rename(tmp, layout.launcher);
    writeJson(layout.updateFile, { from: trial.from, to: version, at: this.now() });
    await fsp.rm(layout.trialFile, { force: true });
    await fsp.rm(layout.rollbackFile, { force: true });
    this.trial = undefined;
    if (this.progress?.step === "trial") this.progress = undefined;
    this.o.log(`${version} started well; it is no longer on trial`);
    await this.prune(dbFile);
    await this.load();
    this.o.changed();
  }

  /** On trial, why this version is ending: the launcher tells it when it takes the version back. */
  recordFailure(message: string): void {
    if (!this.trial) return;
    try {
      writeJson(this.o.layout.lastErrorFile, { message: message.slice(0, 2000), at: this.now() });
    } catch {
      // nothing more can be done
    }
  }

  /** On trial, a stop (SIGTERM, a restart of the machine) is not a failure: the next start tries this version again. */
  stoppedOnTrial(): void {
    const trial = readTrial(this.o.layout.trialFile);
    if (!this.trial || !trial || trial.to !== this.o.version) return;
    try {
      writeJson(this.o.layout.trialFile, { ...trial, starts: 0 });
    } catch {
      // the launcher then takes it back: better than not starting at all
    }
  }

  /**
   * Removes the folders of the versions no longer needed (all but the running one and the one to go back to), what an
   * update left half done, and the copies of the database but the last one. Returns the versions removed.
   */
  async prune(dbFile = this.o.dbFile): Promise<string[]> {
    if (this.o.install.kind !== "managed" || (this.progress && this.progress.step !== "trial")) return [];
    const { layout, version } = this.o;
    const record = await readRecord(layout.updateFile);
    const keep = new Set([version, ...(record?.to === version ? [record.from] : []), ...(this.trial ? [this.trial.from] : [])]);
    const current = await currentVersion(layout);
    if (current) keep.add(current);
    const removed: string[] = [];
    for (const name of await fsp.readdir(layout.versions).catch(() => [] as string[])) {
      const leftover = name.startsWith(".");
      if (!leftover && (!VERSION_RE.test(name) || keep.has(name))) continue;
      await fsp.rm(path.join(layout.versions, name), { recursive: true, force: true });
      if (!leftover) removed.push(name);
    }
    const dir = path.dirname(dbFile);
    const prefix = `${path.basename(dbFile)}.before-`;
    const copies = (await fsp.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith(prefix));
    for (const name of copies) {
      if (name === `${prefix}${version}`) continue;
      await fsp.rm(path.join(dir, name), { force: true });
    }
    if (removed.length > 0) this.o.log(`removed the versions no longer used: ${removed.join(", ")}`);
    return removed;
  }
}
