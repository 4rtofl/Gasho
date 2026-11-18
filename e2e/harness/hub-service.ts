// The Gasho server as `gasho-hub service install` installs it, for the tests of its updates (HubOptions.service):
// this checkout compiled as its npm package (as apps/hub/scripts/pack.ts does, but with the screen the tests serve as
// its web/) under made-up versions, each in its folder of a layout in the test's folder (apps/hub/src/install.ts), and
// started by the layout's launcher under bin/service.ts, which starts it again as the service manager would. Nothing
// is registered with launchd or systemd.
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

let compiled: Promise<string> | undefined;

/** A folder of this test runner with this checkout's Gasho server compiled to JavaScript (lib/), made once. */
function compiledHub(): Promise<string> {
  compiled ??= (async () => {
    const dir = await fsp.realpath(await fsp.mkdtemp("/tmp/ge2e-pkg-"));
    onExit(() => fs.rmSync(dir, { recursive: true, force: true }));
    const tsc = path.join(GASHO_DIR, "node_modules/.bin/tsc");
    await promisify(execFile)(tsc, ["-p", path.join(GASHO_DIR, "apps/hub/tsconfig.build.json"), "--outDir", path.join(dir, "lib")]);
    return dir;
  })();
  return compiled;
}

const packages = new Map<string, Promise<string>>();

/**
 * The npm prefix of `version`, as npm installs it there: node_modules with the package (its lib/ says it is `version`,
 * its web/ is this checkout's apps/web/dist) and the one it needs (ws, this checkout's).
 */
function hubPackage(version: string): Promise<string> {
  let made = packages.get(version);
  if (!made) {
    made = (async () => {
      const base = await compiledHub();
      const prefix = path.join(base, `v${version}`);
      const pkg = path.join(prefix, "node_modules", ...PACKAGE);
      await fsp.cp(path.join(base, "lib"), path.join(pkg, "lib"), { recursive: true });
      const file = path.join(pkg, "lib", "version.js");
      const said = (await fsp.readFile(file, "utf8")).replace(/export const HUB_VERSION = "[^"]+"/, `export const HUB_VERSION = "${version}"`);
      await fsp.writeFile(file, said);
      await fsp.symlink(path.join(GASHO_DIR, "apps/web/dist"), path.join(pkg, "web"));
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
  for (const v of new Set([o.version, ...(o.installed ?? []), ...(o.trialFrom ? [o.trialFrom] : [])])) {
    await fsp.cp(await hubPackage(v), path.join(versions, v), { recursive: true, verbatimSymlinks: true });
  }
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
