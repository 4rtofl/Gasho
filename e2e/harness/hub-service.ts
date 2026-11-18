// The Gasho server as `gasho-hub service install` installs it, for the tests of its updates (HubOptions.service):
// this checkout compiled as its npm package (as apps/hub/scripts/pack.ts does, with the screen built for its version
// as its web/) under made-up versions, each in its folder of a layout in the test's folder (apps/hub/src/install.ts),
// and started by the layout's launcher under bin/service.ts, which starts it again as the service manager would.
// Nothing is registered with launchd or systemd.
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { type FakeAnswer, npmInstallAnswer } from "./fakes.ts";
import { GASHO_DIR, onExit, type Proc } from "./process.ts";

const PACKAGE = ["@4rtofl", "gasho-hub"] as const;
export const HUB_PACKAGE = PACKAGE.join("/");
export const SERVICE_BIN = "e2e/harness/bin/service.ts";

export interface HubServiceOptions {
  /** The version it runs (made up: this checkout's code says it is that version). */
  version: string;
  /** Other versions installed beside it, which an update switches to without npm. */
  installed?: string[];
  /** It was started by an update from this version, and is on trial (trial.json; started once it starts). */
  trialFrom?: string;
  /** false: started by the launcher, but not by a service manager (runAsService), so Gasho cannot update it. */
  asService?: boolean;
}

let runner: Promise<string> | undefined;

/** This test runner's folder for the packages it makes, removed when it ends. */
function runnerDir(): Promise<string> {
  runner ??= (async () => {
    const dir = await fsp.realpath(await fsp.mkdtemp("/tmp/ge2e-pkg-"));
    onExit(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  })();
  return runner;
}

let compiled: Promise<string> | undefined;

/** This checkout's Gasho server compiled to JavaScript (a lib/ folder), made once. */
function compiledHub(): Promise<string> {
  compiled ??= (async () => {
    const lib = path.join(await runnerDir(), "lib");
    const tsc = path.join(GASHO_DIR, "node_modules/.bin/tsc");
    await promisify(execFile)(tsc, ["-p", path.join(GASHO_DIR, "apps/hub/tsconfig.build.json"), "--outDir", lib]);
    return lib;
  })();
  return compiled;
}

const screens = new Map<string, Promise<string>>();

/**
 * This checkout's screen built as the package of `version` builds it (hub-<version>, apps/hub/scripts/pack.ts), made
 * once per version: a page of one version's screen reloads once it connects to another version, as after an update.
 * Not a copy of apps/web/dist with another build.json: its scripts would keep their names, which the browser caches.
 */
function screenOf(version: string): Promise<string> {
  let made = screens.get(version);
  if (!made) {
    made = (async () => {
      const out = path.join(await runnerDir(), `web-${version}`);
      const vite = path.join(GASHO_DIR, "node_modules/.bin/vite");
      await promisify(execFile)(vite, ["build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"], {
        cwd: path.join(GASHO_DIR, "apps/web"),
        env: { ...process.env, GASHO_WEB_BUILD: `hub-${version}` },
      });
      return out;
    })();
    screens.set(version, made);
  }
  return made;
}

const packages = new Map<string, Promise<string>>();

/**
 * The npm prefix of `version`, as npm installs it there: node_modules with the package (its lib/ says it is `version`,
 * its web/ is the screen built for it) and the one it needs (ws, this checkout's).
 */
function hubPackage(version: string): Promise<string> {
  let made = packages.get(version);
  if (!made) {
    made = (async () => {
      const [lib, web] = await Promise.all([compiledHub(), screenOf(version)]);
      const prefix = path.join(await runnerDir(), `v${version}`);
      const pkg = path.join(prefix, "node_modules", ...PACKAGE);
      await fsp.cp(lib, path.join(pkg, "lib"), { recursive: true });
      const file = path.join(pkg, "lib", "version.js");
      const said = (await fsp.readFile(file, "utf8")).replace(/export const HUB_VERSION = "[^"]+"/, `export const HUB_VERSION = "${version}"`);
      await fsp.writeFile(file, said);
      await fsp.symlink(web, path.join(pkg, "web"));
      await fsp.writeFile(path.join(pkg, "package.json"), `${JSON.stringify({ name: HUB_PACKAGE, version, type: "module" }, null, 2)}\n`);
      await fsp.symlink(await fsp.realpath(path.join(GASHO_DIR, "node_modules/ws")), path.join(prefix, "node_modules", "ws"));
      return prefix;
    })();
    packages.set(version, made);
  }
  return made;
}

/** The fake npm's answer to an update's npm install of the Gasho server's `version`. */
export async function hubInstallAnswer(version: string): Promise<FakeAnswer> {
  return npmInstallAnswer(HUB_PACKAGE, version, path.join(await hubPackage(version), "node_modules"));
}

/**
 * Makes the layout at `root` as `service install` and the updates leave it: the versions, `current` linking to the one
 * it runs, the launcher of the last version that started well, and the trial. Gives the launcher's path.
 */
export async function makeLayout(root: string, o: HubServiceOptions): Promise<string> {
  const versions = path.join(root, "versions");
  const all = [...new Set([o.version, ...(o.installed ?? []), ...(o.trialFrom ? [o.trialFrom] : [])])];
  // Made side by side: each builds its screen.
  const prefixes = await Promise.all(all.map(hubPackage));
  for (const [i, v] of all.entries()) await fsp.cp(prefixes[i] ?? "", path.join(versions, v), { recursive: true, verbatimSymlinks: true });
  await fsp.symlink(path.join("versions", o.version), path.join(root, "current"));
  const launcher = path.join(root, "launcher.mjs");
  await fsp.copyFile(path.join(versions, o.trialFrom ?? o.version, "node_modules", ...PACKAGE, "lib", "launcher.js"), launcher);
  if (o.trialFrom) {
    const trial = { from: o.trialFrom, to: o.version, at: Date.now(), starts: 0 };
    await fsp.writeFile(path.join(root, "trial.json"), `${JSON.stringify(trial, null, 2)}\n`);
  }
  return launcher;
}

/** The service a test's Gasho server runs under (bin/service.ts): its layout, and how the test drives it. */
export class HubService {
  /** The layout (GASHO_HUB_HOME): versions/, current, launcher.mjs, trial.json, update.json, rollback.json. */
  readonly root: string;
  private control: string;
  private proc: Proc;

  constructor(o: { root: string; control: string; proc: Proc }) {
    this.root = o.root;
    this.control = o.control;
    this.proc = o.proc;
  }

  /** Once the Gasho server ends, it is not started again until allowRestarts (a restart that takes long). */
  async holdRestarts(): Promise<void> {
    await fsp.writeFile(this.control, JSON.stringify({ hold: true }));
  }

  async allowRestarts(): Promise<void> {
    await fsp.writeFile(this.control, JSON.stringify({ hold: false }));
  }

  /** Kills the Gasho server at once (SIGKILL), as one that crashed; it is started again, as the service manager does. */
  crash(): void {
    this.proc.child.kill("SIGUSR2");
  }
}
