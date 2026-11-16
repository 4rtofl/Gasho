#!/usr/bin/env node
// The Gasho server's command line: `start` (what the service runs, through the launcher: launcher.ts), `pair`,
// `devices`, `revoke`, `plugin`, and for keeping it running and updating it, `version`, `check-db` and `service`
// (docs/hub-setup.md). It starts its command as soon as it is loaded: the launcher imports it.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dbFileOf, type HubConfig, loadConfig, pluginsDirOf } from "./config.ts";
import { ghRunner, PluginCatalogSource } from "./catalog.ts";
import { Hub, type ServerSource } from "./hub.ts";
import { commandOf, commitOf, type Install, installOf, launcherIn, type Layout, layoutOf, VERSION_RE, versionDir } from "./install.ts";
import { switchCurrent, writeJson } from "./launcher.ts";
import { LatestCheck, npmBin, npmLatest } from "./latest.ts";
import { buildAllowList } from "./netallow.ts";
import { stableNode } from "./node-path.ts";
import { PLUGIN_API, PluginRegistry, readPluginFolder, removePluginFolder, swapPluginFolder } from "./plugins.ts";
import { PushSender } from "./push.ts";
import { beginTrial, checkVersion, currentVersion, HubUpdater, installVersion } from "./self-update.ts";
import { createServer } from "./server.ts";
import {
  activateCommands,
  envFileOf,
  LAUNCHD_LABEL,
  launchdPlist,
  loadEnvFile,
  portInUse,
  runAsService,
  type ServiceInput,
  serviceFile,
  servicePath,
  SYSTEMD_UNIT,
  systemdUnit,
} from "./service.ts";
import { Store } from "./store.ts";
import { HUB_VERSION } from "./version.ts";

// The Gasho server's own settings (GASHO_HUB_PORT and the like) in hub.env, read by every command; a value set in the
// shell wins (GASHO_HUB_ENV=off: not read).
loadEnvFile();

const log = (s: string) => console.log(`${new Date().toISOString()} [gasho-hub] ${s}`);
const layout = layoutOf();

/** The layout's `versions` folder, as configured and as its real path (they differ when a folder above it is a link). */
function versionsDirs(l: Layout): string[] {
  const dirs = [l.versions];
  try {
    dirs.push(fs.realpathSync.native(l.versions));
  } catch {
    // not there: nothing installed
  }
  return dirs;
}

/** How this copy was installed (a clone, npx, npm install -g, or `service install`). */
const install: Install = installOf(fileURLToPath(import.meta.url), versionsDirs(layout));
const command = commandOf(install);

const usage = `usage:
  ${command} start            start the Gasho server
  ${command} pair             issue a registration code (valid for 10 minutes, single use)
  ${command} devices          list registered browsers and working servers
  ${command} revoke <id>      revoke a registration (the server disconnects it within 30 s)
  ${command} plugin add <folder>          install a plugin (a built dist/ folder), replacing one with its id
  ${command} plugin add --link <folder>   install it as a link, for a plugin being developed (hot reload)
  ${command} plugin list                  list the installed plugins
  ${command} plugin remove <id>           remove a plugin, and the settings the Gasho server keeps for it
  ${command} service install  install this version in a folder of its own and keep it running (a systemd user
                              service on Linux, a launchd agent on macOS); Gasho can then update it
  ${command} service print    print the file that keeps the Gasho server running
  ${command} service use <version>   switch to another version, on trial as an update is
  ${command} version          print the version
The running Gasho server picks up added, changed and removed plugins at once (GASHO_PLUGINS_DIR). The plugins of
GashoPlugins (GASHO_PLUGIN_REPO) are added from the plugins screen instead. Settings such as GASHO_HUB_PORT go in
${envFileOf() ?? "hub.env"} (NAME=value per line).`;

function lanAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i?.address ?? "");
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The build of the screen in `webDist` (web/build.json, written by its build), to tell pages when it changed. */
export function webBuildOf(webDist: string): string | undefined {
  try {
    const b = (JSON.parse(fs.readFileSync(path.join(webDist, "build.json"), "utf8")) as { build?: unknown }).build;
    return typeof b === "string" && b.length > 0 && b.length <= 100 ? b : undefined;
  } catch {
    return undefined;
  }
}

/** Calls `onChange` when the build of the screen changes under the running Gasho server (a clone's npm run web:build). */
function watchWebBuild(webDist: string, onChange: () => void): void {
  let last = webBuildOf(webDist);
  let timer: NodeJS.Timeout | undefined;
  try {
    fs.watch(webDist, () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const now = webBuildOf(webDist);
        if (now === last) return;
        last = now;
        onChange();
      }, 300);
    }).on("error", () => undefined);
  } catch {
    // no screen there yet: pages hear of a new one when they connect again
  }
}

/** How a version on trial checks itself before it is confirmed: it answers, its screen is there, its launcher loads. */
async function selfCheck(cfg: HubConfig): Promise<string | undefined> {
  const host = cfg.host === "0.0.0.0" || cfg.host === "" ? "127.0.0.1" : cfg.host === "::" ? "[::1]" : cfg.host.includes(":") ? `[${cfg.host}]` : cfg.host;
  try {
    // Any answer counts: a narrow GASHO_ALLOW_NETS answers 403 to the loopback.
    await fetch(`http://${host}:${cfg.port}/api/health`, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    return `/api/health に答えませんでした：${messageOf(e)}`;
  }
  if (!fs.existsSync(path.join(cfg.webDist, "index.html"))) return `画面（${cfg.webDist}/index.html）がありません。`;
  try {
    execFileSync(process.execPath, [launcherIn(versionDir(layout, HUB_VERSION)), "--check"], { stdio: "ignore", timeout: 30_000 });
  } catch (e) {
    return `launcher が動きませんでした：${messageOf(e)}`;
  }
  return undefined;
}

async function start(): Promise<void> {
  const cfg = loadConfig();
  let hub: Hub | undefined;
  let stop = (code: number) => process.exit(code);
  const listeners = new Set<() => void>();
  const emitServer = () => {
    for (const l of listeners) l();
  };
  const updater = new HubUpdater({
    install,
    layout,
    version: HUB_VERSION,
    service: runAsService(),
    npm: npmBin(),
    node: process.execPath,
    env: process.env,
    dbFile: cfg.dbFile,
    inFlight: () => hub?.inFlight() ?? 0,
    hold: (why) => hub?.hold(why),
    changed: emitServer,
    exit: (code) => stop(code),
    log,
  });
  await updater.load();
  const onTrial = updater.onTrial();
  // Ending with a failure: the service starts it again, and a version on trial is taken back (launcher.ts).
  const fail = (e: unknown) => {
    const message = messageOf(e);
    updater.recordFailure(message);
    console.error(`${new Date().toISOString()} [gasho-hub] stopped: ${message}`);
    process.exit(1);
  };
  process.on("uncaughtException", fail);
  // Before the database: another Gasho server on the port (the one being replaced, still running) is not a failure
  // of this version; the service tries again.
  if (await portInUse(cfg.host, cfg.port)) {
    log(`port ${cfg.port} on ${cfg.host} is in use (another Gasho server?); trying again later`);
    if (onTrial) updater.stoppedOnTrial();
    process.exit(1);
  }
  let store: Store;
  try {
    store = new Store(cfg.dbFile);
  } catch (e) {
    fail(e);
    return;
  }
  store.prune();
  setInterval(() => store.prune(), 3600_000).unref();
  const plugins = new PluginRegistry({
    dir: cfg.pluginsDir,
    cacheDir: cfg.pluginCacheDir,
    log: (s) => console.log(`${new Date().toISOString()} [gasho-hub] ${s}`),
  });
  await plugins.start().catch((e: unknown) => console.error(`[gasho-hub] cannot read the plugins in ${cfg.pluginsDir}`, e));
  const catalog = new PluginCatalogSource({
    repo: cfg.pluginRepo,
    gh: ghRunner(cfg.ghBin),
    log: (s) => console.log(`${new Date().toISOString()} [gasho-hub] ${s}`),
  });
  catalog.start();
  // The latest published versions, with npm and the user's .npmrc (GASHO_LATEST_CHECK=off: not looked up).
  const npm = npmBin();
  const latest = process.env.GASHO_LATEST_CHECK === "off" ? undefined : new LatestCheck({ lookup: (name) => npmLatest(npm, name) });
  // The Gasho server itself for browsers: its version (with a clone's commit), its plugin API, the build of the screen
  // it serves, its update.
  // Read once, while it starts (a later git pull does not change the running code); said to browsers once known.
  let commit: string | undefined;
  if (install.kind === "repo") {
    void commitOf(install.repo).then((c) => {
      commit = c;
      if (c) emitServer();
    });
  }
  const serverSource: ServerSource = {
    info: () => {
      const web = webBuildOf(cfg.webDist);
      return { version: HUB_VERSION, ...(commit ? { commit } : {}), pluginApi: PLUGIN_API, ...(web ? { web } : {}), update: updater.info() };
    },
    update: (version) => updater.start(version),
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
  const push = new PushSender({ store, subject: cfg.vapidSubject, log });
  hub = new Hub(store, { plugins, catalog, latest, server: serverSource, push });
  watchWebBuild(cfg.webDist, emitServer);
  latest?.start();
  const server = createServer({ hub, store, webDist: cfg.webDist, allow: buildAllowList(cfg.allowNets), plugins });
  stop = (code: number) => {
    catalog.stop();
    plugins.close();
    latest?.close();
    server.close();
    store.close();
    process.exit(code);
  };
  server.on("error", fail);
  server.listen(cfg.port, cfg.host, () => {
    log(`gasho-hub ${HUB_VERSION} listening on ${cfg.host}:${cfg.port} (db: ${cfg.dbFile})`);
    log(`allowed networks: ${cfg.allowNets.join(", ")}`);
    log(`plugins: ${cfg.pluginsDir} (catalog: ${cfg.pluginRepo})`);
    if (cfg.host === "0.0.0.0") for (const a of lanAddresses()) log(`open http://${a}:${cfg.port} from the LAN`);
    if (store.listDevices().length === 0) log(`no devices are registered yet; run "${command} pair" to get a code`);
    if (onTrial) {
      // On trial: confirmed once up for a while with its checks passed; else it ends, and the launcher takes it back.
      const probation = Number(process.env.GASHO_HUB_PROBATION_MS ?? 60_000);
      log(`on trial: confirmed in ${Math.round(probation / 1000)} s if all is well`);
      setTimeout(() => {
        void selfCheck(cfg).then((problem) => (problem ? fail(new Error(problem)) : updater.confirm().catch(fail)));
      }, probation);
    } else {
      void updater.prune().catch((e: unknown) => log(`could not remove old versions: ${messageOf(e)}`));
    }
  });
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      // A stop is not a failure: on trial, the next start tries this version again.
      updater.stoppedOnTrial();
      stop(0);
    });
  }
}

/** hub:plugin add|list|remove: changes the plugins folder; a running Gasho server notices at once. */
async function plugin(argv: string[]): Promise<void> {
  const dir = pluginsDirOf();
  const [sub, ...rest] = argv;
  const fail = (message: string) => {
    console.error(message);
    process.exitCode = 1;
  };
  if (sub === "add") {
    const link = rest.includes("--link");
    const source = rest.find((a) => !a.startsWith("--"));
    if (!source) return fail(usage);
    const from = path.resolve(source);
    const read = await readPluginFolder(from, undefined);
    if ("error" in read) return fail(`${from}: ${read.error}`);
    const { id, name, version } = read.manifest;
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, id);
    // Built aside and then swapped in, so that the Gasho server never reads a half-copied plugin.
    const tmp = path.join(dir, `.${id}-${process.pid}`);
    await fsp.rm(tmp, { recursive: true, force: true });
    if (link) await fsp.symlink(await fsp.realpath(from), tmp);
    else await fsp.cp(from, tmp, { recursive: true, dereference: true });
    await swapPluginFolder(dir, id, tmp);
    console.log(`${link ? "linked" : "installed"} ${name} ${version} (${id}) in ${target}${link ? ` -> ${await fsp.realpath(from)}` : ""}`);
    return;
  }
  if (sub === "list") {
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    if (names.filter((n) => !n.startsWith(".")).length === 0) console.log(`no plugins in ${dir}`);
    for (const n of names.filter((x) => !x.startsWith(".")).sort()) {
      const folder = path.join(dir, n);
      const linked = (await fsp.lstat(folder)).isSymbolicLink();
      const real = await fsp.realpath(folder).catch(() => undefined);
      const read = real ? await readPluginFolder(real, n) : { error: "the link points nowhere" };
      const what = "error" in read ? `error: ${read.error}` : `${read.manifest.name} ${read.manifest.version} (${read.hash})`;
      console.log(`${n.padEnd(20)} ${what}${linked ? `  [link -> ${real ?? "?"}]` : ""}`);
    }
    return;
  }
  if (sub === "remove") {
    const id = rest[0];
    if (!id || id.includes("/") || id.startsWith(".")) return fail(usage);
    if (!(await removePluginFolder(dir, id))) return fail(`no plugin ${id} in ${dir}`);
    const store = new Store(dbFileOf());
    store.forgetPlugin(id);
    store.close();
    console.log(`removed ${id}`);
    return;
  }
  fail(usage);
}

// ---- keeping it running ----

/** What the service runs: the layout's launcher (or, from a clone, the clone itself, which Gasho cannot update). */
function serviceInput(how: Install): ServiceInput {
  const home = os.homedir();
  // Not Homebrew's folder for this version of Node.js, which an upgrade removes (node-path.ts).
  const node = stableNode(process.execPath);
  const flags = ["--disable-warning=ExperimentalWarning"];
  const where = how.kind === "repo" ? { argv: [node, ...flags, path.join(how.repo, "apps/hub/src/cli.ts")], cwd: how.repo } : { argv: [node, ...flags, layout.launcher], cwd: home };
  return { node, ...where, path: servicePath(node, process.env.PATH), home };
}

function serviceText(how: Install): string {
  if (process.platform === "linux") return systemdUnit(serviceInput(how));
  if (process.platform === "darwin") return launchdPlist(serviceInput(how));
  throw new Error(`no service file for ${process.platform}; run the Gasho server with: ${command} start`);
}

function systemdActive(): boolean {
  try {
    execFileSync("systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT.replace(/\.service$/, "")], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * `service install`: puts this version in its folder of the layout (from the package registry, unless it runs from
 * there already), checks it, links `current` to it and puts its launcher beside it, writes the service's file, and
 * has the service manager enable it and start it, unless another Gasho server holds the port (the one it replaces:
 * stop it, then start the service). From a clone, the service runs the clone, which Gasho cannot update.
 */
async function serviceInstall(): Promise<void> {
  const file = serviceFile(process.platform, os.homedir());
  if (!file) throw new Error(`no service for ${process.platform}; run the Gasho server with: ${command} start`);
  const cfg = loadConfig();
  let how: Install = install;
  if (install.kind !== "repo") {
    const version = HUB_VERSION;
    console.log(`installing gasho-hub ${version} in ${layout.versions}`);
    const env = process.env;
    const dir = await installVersion(layout, version, { npm: npmBin(), env });
    await checkVersion(dir, version, { node: process.execPath, env, dbFile: cfg.dbFile, scratch: layout.root });
    const before = await currentVersion(layout);
    await fsp.mkdir(layout.root, { recursive: true });
    switchCurrent(layout.root, version);
    await fsp.copyFile(launcherIn(dir), `${layout.launcher}.${process.pid}.tmp`);
    await fsp.rename(`${layout.launcher}.${process.pid}.tmp`, layout.launcher);
    if (before && before !== version) writeJson(layout.updateFile, { from: before, to: version, at: Date.now() });
    how = { kind: "managed", version };
  }
  const text = serviceText(how);
  const old = await fsp.readFile(file, "utf8").catch(() => undefined);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (old !== undefined && old !== text) {
    await fsp.writeFile(`${file}.bak`, old);
    console.log(`kept the old file as ${file}.bak`);
  }
  await fsp.writeFile(file, text);
  console.log(`wrote ${file}`);
  // Restarted when the service runs already; not started while another Gasho server holds the port.
  const start = process.platform === "linux" && systemdActive() ? true : !(await portInUse(cfg.host, cfg.port));
  for (const step of activateCommands(process.platform, file, process.getuid?.() ?? 0, start)) {
    try {
      execFileSync(step.argv[0] ?? "", step.argv.slice(1), { stdio: step.mayFail ? "ignore" : "inherit" });
    } catch (e) {
      if (!step.mayFail) throw new Error(`${step.argv.join(" ")} failed: ${messageOf(e)}`);
    }
  }
  const what = how.kind === "managed" ? `gasho-hub ${how.version} runs as a service; Gasho can update it from now on` : "gasho-hub runs as a service (from this clone)";
  if (start) console.log(what);
  else {
    const later = process.platform === "darwin" ? `launchctl bootstrap gui/${process.getuid?.() ?? 0} ${file}` : `systemctl --user start ${SYSTEMD_UNIT.replace(/\.service$/, "")}`;
    console.log(`port ${cfg.port} is in use (the Gasho server running now?): the service is set up but not started.`);
    console.log(`stop that Gasho server, then: ${later}`);
  }
  if (process.platform === "linux") {
    const linger = (() => {
      try {
        return execFileSync("loginctl", ["show-user", os.userInfo().username, "-p", "Linger", "--value"], { encoding: "utf8" }).trim();
      } catch {
        return "";
      }
    })();
    if (linger === "no") console.log(`to keep it running while you are logged out: loginctl enable-linger ${os.userInfo().username}`);
  }
}

/**
 * `service use <version>`: from a shell, switches to another version (installing it when it is not there), on trial
 * as an update is, and restarts the service. The way back when the screen cannot be opened.
 */
async function serviceUse(version: string | undefined): Promise<void> {
  if (!version || !VERSION_RE.test(version)) throw new Error(`usage: ${command} service use <x.y.z>`);
  const from = await currentVersion(layout);
  if (!from) throw new Error(`no version is installed in ${layout.versions} yet: run ${command} service install first`);
  if (from === version) {
    console.log(`${version} is in use already`);
    return;
  }
  const env = process.env;
  const dir = await installVersion(layout, version, { npm: npmBin(), env });
  await checkVersion(dir, version, { node: process.execPath, env, dbFile: loadConfig().dbFile, scratch: layout.root });
  await beginTrial(layout, from, version);
  console.log(`switched ${from} -> ${version} (on trial)`);
  const restart =
    process.platform === "darwin"
      ? ["launchctl", "kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${LAUNCHD_LABEL}`]
      : ["systemctl", "--user", "restart", SYSTEMD_UNIT.replace(/\.service$/, "")];
  execFileSync(restart[0] ?? "", restart.slice(1), { stdio: "inherit" });
}

async function service(argv: string[]): Promise<void> {
  const [sub, version] = argv;
  if (sub === "install") return serviceInstall();
  if (sub === "use") return serviceUse(version);
  if (sub === "print") {
    process.stdout.write(serviceText(install.kind === "repo" ? install : { kind: "managed", version: HUB_VERSION }));
    return;
  }
  throw new Error(usage);
}

const args = process.argv.slice(2);
switch (args[0] ?? "start") {
  case "start":
    void start();
    break;
  case "version":
    console.log(HUB_VERSION);
    break;
  case "check-db": {
    // An update checks that this version opens (and migrates) a copy of the database (self-update.ts).
    const file = args[1];
    if (!file) {
      console.error(`usage: ${command} check-db <file>`);
      process.exitCode = 2;
      break;
    }
    try {
      new Store(file).close();
      console.log("ok");
    } catch (e) {
      console.error(messageOf(e));
      process.exitCode = 1;
    }
    break;
  }
  case "service":
    try {
      await service(args.slice(1));
    } catch (e) {
      console.error(messageOf(e));
      process.exitCode = 1;
    }
    break;
  case "plugin":
    await plugin(args.slice(1));
    break;
  case "pair": {
    const store = new Store(dbFileOf());
    const { code, expiresAt } = store.createPairingCode("cli");
    store.close();
    console.log(`registration code: ${code}`);
    console.log(`valid until ${new Date(expiresAt).toLocaleString()} (single use)`);
    console.log("- browser: open the Gasho server and enter the code");
    console.log("- working server: npx @4rtofl/gasho-daemon register --server http://<this server>:7740 --code <code>");
    break;
  }
  case "devices": {
    const store = new Store(dbFileOf());
    for (const d of store.listDevices()) {
      const seen = d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "never";
      console.log(`${d.id}  ${d.kind.padEnd(7)}  ${d.name}  (last seen: ${seen})`);
    }
    store.close();
    break;
  }
  case "revoke": {
    const id = args[1];
    if (!id) {
      console.error(usage);
      process.exitCode = 2;
      break;
    }
    const store = new Store(dbFileOf());
    console.log(store.revokeDevice(id) ? `revoked ${id}` : `no active device ${id}`);
    store.close();
    break;
  }
  default:
    console.error(usage);
    process.exitCode = 2;
}
