// How this Gasho server was installed: from a clone of the repository (TypeScript run as is), as the npm package from
// GitHub Packages run through npx, as that package installed for good (npm install -g), or by `service install` in a
// folder of its own per version (see Layout), which Gasho can update. Modeled on gasho-daemon's (apps/daemon/src/
// install.ts): the two are published apart, so the code is not shared.
import os from "node:os";
import path from "node:path";

/** The package on GitHub Packages (npm.pkg.github.com); its scope is the repository's owner. */
export const PACKAGE_NAME = "@4rtoflow/gasho-hub";

export type Install =
  | { kind: "repo"; repo: string }
  | { kind: "npx" }
  | { kind: "package"; cli: string }
  /** Installed by `service install` (or by an update) in `versions/<version>` of the layout. */
  | { kind: "managed"; version: string };

/**
 * Where `service install` and updates put the Gasho server: each version in a folder of its own (an npm prefix:
 * versions/0.1.0/node_modules/@4rtoflow/gasho-hub), `current`, a link to the one in use, and the launcher the service
 * runs, which starts `current` and goes back to the version before when one on trial did not start (launcher.ts). The
 * database, the plugins and the caches are not here: they stay where they are (config.ts).
 */
export interface Layout {
  root: string;
  versions: string;
  /** The link to the version in use (versions/<version>). */
  current: string;
  /** The launcher the service runs: lib/launcher.js of the last version that started well. */
  launcher: string;
  /** An update on trial: { from, to, at, starts } (see launcher.ts). */
  trialFile: string;
  /** The last update that went through: { from, to, at }, for going back. */
  updateFile: string;
  /** The last update that went back by itself: { from, to, error, at }. */
  rollbackFile: string;
  /** Why the version on trial ended: { message, at }. */
  lastErrorFile: string;
}

/** The names of the layout's files, as the launcher finds them beside itself (it is copied there alone). */
export const LAYOUT_NAMES = {
  versions: "versions",
  current: "current",
  launcher: "launcher.mjs",
  trialFile: "trial.json",
  updateFile: "update.json",
  rollbackFile: "rollback.json",
  lastErrorFile: "last-error.json",
} as const;

export function layoutAt(root: string): Layout {
  const at = (name: string) => path.join(root, name);
  return {
    root,
    versions: at(LAYOUT_NAMES.versions),
    current: at(LAYOUT_NAMES.current),
    launcher: at(LAYOUT_NAMES.launcher),
    trialFile: at(LAYOUT_NAMES.trialFile),
    updateFile: at(LAYOUT_NAMES.updateFile),
    rollbackFile: at(LAYOUT_NAMES.rollbackFile),
    lastErrorFile: at(LAYOUT_NAMES.lastErrorFile),
  };
}

export function layoutOf(env: NodeJS.ProcessEnv = process.env): Layout {
  return layoutAt(env.GASHO_HUB_HOME || path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "gasho", "hub"));
}

/** A version as the package registry has it, and as a folder of `versions` is named: x.y.z. */
export const VERSION_RE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

export function versionDir(layout: Layout, version: string): string {
  return path.join(layout.versions, version);
}

/** The package inside a version's folder, and its files. */
export function packageIn(dir: string): string {
  return path.join(dir, "node_modules", ...PACKAGE_NAME.split("/"));
}

export function cliIn(dir: string): string {
  return path.join(packageIn(dir), "lib", "cli.js");
}

export function launcherIn(dir: string): string {
  return path.join(packageIn(dir), "lib", "launcher.js");
}

export function webIn(dir: string): string {
  return path.join(packageIn(dir), "web");
}

/**
 * `cli`: the path of the running cli.ts (from a clone) or cli.js (from the package). Node.js runs a file through its
 * real path, so one started through `current` is seen in its own folder of `versions`. `versionsDirs`: the layout's
 * `versions` folder, as configured and as its real path (they differ when a folder above it is a link).
 */
export function installOf(cli: string, versionsDirs: string[] = []): Install {
  for (const dir of versionsDirs) {
    const rel = path.relative(dir, cli);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const version = rel.split(path.sep)[0] ?? "";
    if (VERSION_RE.test(version) && cliIn(path.join(dir, version)) === cli) return { kind: "managed", version };
  }
  const parts = cli.split(path.sep);
  if (parts.includes("_npx")) return { kind: "npx" };
  if (parts.includes("node_modules")) return { kind: "package", cli };
  return { kind: "repo", repo: path.resolve(path.dirname(cli), "../../..") };
}

/** The command to type for the Gasho server, in messages ("… pair", "… service install"). */
export function commandOf(i: Install): string {
  switch (i.kind) {
    case "repo":
      return "node apps/hub/src/cli.ts";
    case "npx":
    case "managed":
      return `npx ${PACKAGE_NAME}`;
    case "package":
      return "gasho-hub";
  }
}
