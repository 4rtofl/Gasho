// What the Gasho server's service runs (docs/hub-setup.md): `node launcher.mjs start`. It is lib/launcher.js of the last
// version that started well, copied beside `current` in the layout (install.ts), so that a new version that cannot even
// be loaded does not decide whether it is taken back. It starts the version `current` links to, and counts the starts
// of a version on trial (trial.json, written by the update before it switches `current`): a version on trial that
// started once and ended before the Gasho server confirmed it (60 s up and its checks passed, self-update.ts) is taken
// back at its next start, and so is one that cannot be loaded at all. Node.js built-ins only, and nothing else of the
// Gasho server is imported: the copy runs alone. A stop (SIGTERM) is not a failure: the Gasho server sets the count
// back to 0 when it is stopped while on trial.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** An update on trial: the version it came from and went to, and how many times the new one was started. */
export interface Trial {
  from: string;
  to: string;
  at: number;
  starts: number;
}

/** What a launch does, by the trial on record and the version `current` links to. */
export type LaunchPlan =
  /** No trial: start `current`. */
  | { action: "start" }
  /** A trial of another version than `current` (a switch that did not finish, one done by hand): forget it, start. */
  | { action: "drop-trial" }
  /** The first start of the version on trial: count it, then start it. */
  | { action: "try"; trial: Trial }
  /** The version on trial started before and ended without being confirmed: go back to the version before. */
  | { action: "rollback"; trial: Trial };

export function planLaunch(trial: Trial | undefined, current: string | undefined): LaunchPlan {
  if (!trial) return { action: "start" };
  if (trial.to !== current) return { action: "drop-trial" };
  if (trial.starts >= 1) return { action: "rollback", trial };
  return { action: "try", trial };
}

const VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;
const PACKAGE = ["@4rtoflow", "gasho-hub"];

/** The files of the layout beside the launcher (the same names as install.ts's LAYOUT_NAMES). */
export function filesAt(root: string) {
  return {
    versions: path.join(root, "versions"),
    current: path.join(root, "current"),
    trial: path.join(root, "trial.json"),
    rollback: path.join(root, "rollback.json"),
    lastError: path.join(root, "last-error.json"),
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Written aside and renamed over the file, so that it is never read half written. */
export function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function readTrial(file: string): Trial | undefined {
  const t = readJson(file) as Partial<Trial> | undefined;
  if (!t || typeof t.from !== "string" || typeof t.to !== "string" || !VERSION_RE.test(t.from) || !VERSION_RE.test(t.to)) return undefined;
  return { from: t.from, to: t.to, at: typeof t.at === "number" ? t.at : 0, starts: typeof t.starts === "number" ? t.starts : 0 };
}

export function currentVersionAt(root: string): string | undefined {
  try {
    const version = path.basename(fs.readlinkSync(filesAt(root).current));
    return VERSION_RE.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/** Points `current` at `version`, at once: the link is made aside and renamed over the old one. */
export function switchCurrent(root: string, version: string): void {
  const { current } = filesAt(root);
  const tmp = `${current}.${process.pid}`;
  fs.rmSync(tmp, { force: true });
  fs.symlinkSync(path.join("versions", version), tmp);
  fs.renameSync(tmp, current);
}

/** Takes the version on trial back: `current` to the version before, with why (rollback.json). */
export function rollBack(root: string, trial: Trial, error: string | undefined, now = Date.now()): void {
  const f = filesAt(root);
  switchCurrent(root, trial.from);
  writeJson(f.rollback, { from: trial.to, to: trial.from, ...(error ? { error } : {}), at: now });
  fs.rmSync(f.trial, { force: true });
  fs.rmSync(f.lastError, { force: true });
  console.error(`${new Date(now).toISOString()} [gasho-hub] ${trial.to} did not start well; went back to ${trial.from}${error ? `: ${error}` : ""}`);
}

/** cli.js of the version `current` links to, by its real path (so that it sees itself in its folder of `versions`). */
function cliOf(root: string): string {
  return fs.realpathSync(path.join(filesAt(root).current, "node_modules", ...PACKAGE, "lib", "cli.js"));
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 2000);

/** Starts the Gasho server of the layout at `root`, with the trial's rules (see the top of this file). */
export async function launch(root: string): Promise<void> {
  const f = filesAt(root);
  const plan = planLaunch(readTrial(f.trial), currentVersionAt(root));
  if (plan.action === "drop-trial") fs.rmSync(f.trial, { force: true });
  if (plan.action === "rollback") {
    const last = readJson(f.lastError) as { message?: unknown } | undefined;
    rollBack(root, plan.trial, typeof last?.message === "string" ? last.message : "起動したあと、確かめが済む前に止まりました。");
  }
  if (plan.action === "try") writeJson(f.trial, { ...plan.trial, starts: plan.trial.starts + 1 });
  // The Gasho server sees that the service keeps it running (service.ts, runAsService), and finds its layout where the
  // launcher is (whatever hub.env says).
  process.env.GASHO_HUB_LAUNCHER = "1";
  process.env.GASHO_HUB_HOME = root;
  try {
    await import(pathToFileURL(cliOf(root)).href);
  } catch (e) {
    if (plan.action !== "try") throw e;
    // The version on trial cannot even be loaded: back at once, and start the version before in its place.
    rollBack(root, plan.trial, `読み込めませんでした：${messageOf(e)}`);
    await import(pathToFileURL(cliOf(root)).href);
  }
}

// Run as a file (the service's `node launcher.mjs start`): `--check` only says that it loads (an update checks the
// launcher it will copy).
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  if (process.argv[2] === "--check") {
    console.log("ok");
  } else {
    await launch(path.dirname(self));
  }
}
