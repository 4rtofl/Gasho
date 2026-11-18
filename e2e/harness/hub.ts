// A Gasho server for one test, in a folder of its own (its database, plugins, caches, and the HOME of the fakes), on a
// free port of the loopback, with the fake gh and npm. It serves the screen of apps/web/dist, so that the screen and the
// Gasho server are of one build (a page of another build reloads). Working servers are added to it as fake daemons, or
// as real gasho-daemons that run the fake claude and gh. Nothing of the person's own Gasho server, gasho-daemon or
// Claude Code is read or written.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Terminals } from "../../apps/daemon/src/terminal.ts";
import { FakeDaemon, type FakeDaemonOptions } from "./fake-daemon.ts";
import { type ClaudeTable, FakeCommand, type FakeAnswer, npmLatestAnswer, catalogAnswer } from "./fakes.ts";
import { HubService, type HubServiceOptions, makeLayout, SERVICE_BIN } from "./hub-service.ts";
import { freePort, GASHO_DIR, isolatedEnv, onExit, Proc, runScript } from "./process.ts";

const HUB_CLI = "apps/hub/src/cli.ts";
const DAEMON_CLI = "apps/daemon/src/cli.ts";
/** Generous: the machine that runs the tests may be busy. */
const START_MS = 60_000;

export interface HubOptions {
  /** Plugin folders (a built dist/) added with `plugin add --link` before the Gasho server starts. */
  plugins?: string[];
  /** The fake gh's answers; by default, an empty catalog of plugins. */
  gh?: FakeAnswer[];
  /** The fake npm's answers; by default, the versions of this checkout are the latest. */
  npm?: FakeAnswer[];
  /** The fake claude's table, for the real gasho-daemons. */
  claude?: ClaudeTable;
  /** More settings of the Gasho server (GASHO_*). */
  env?: Record<string, string>;
  /** The screen it serves (apps/web/dist). */
  webDist?: string;
  /**
   * Run as `gasho-hub service install` installs it, which Gasho can update (hub-service.ts), in place of this
   * checkout's apps/hub/src/cli.ts.
   */
  service?: HubServiceOptions;
}

export interface DaemonOptions {
  name?: string;
  /**
   * Folders made in HOME and trusted in Claude Code (~/.claude.json), which gasho-daemon offers to start sessions in
   * (paths from HOME).
   */
  folders?: string[];
  /** More settings of gasho-daemon (GASHO_*). */
  env?: Record<string, string>;
}

/** The registration cookie of a browser, as Playwright's BrowserContext.addCookies takes it. */
export interface BrowserCookie {
  name: string;
  value: string;
  url: string;
  httpOnly: boolean;
  sameSite: "Strict";
}

/** The version of this checkout's gasho-daemon or Gasho server, from its source. */
export function checkoutVersion(what: "daemon" | "hub"): string {
  const file = what === "daemon" ? "apps/daemon/src/daemon.ts" : "apps/hub/src/version.ts";
  const name = what === "daemon" ? "DAEMON_VERSION" : "HUB_VERSION";
  const m = new RegExp(`export const ${name} = "([^"]+)"`).exec(fs.readFileSync(path.join(GASHO_DIR, file), "utf8"));
  if (!m?.[1]) throw new Error(`no ${name} in ${file}`);
  return m[1];
}

/** A gasho-daemon of this checkout, registered with the Gasho server, running the fake claude and gh. */
export class RealDaemon {
  readonly name: string;
  readonly machineId: string;
  /** Its registration's folder, where its terminals' sockets are (<stateDir>/terminals/<name>.sock). */
  readonly stateDir: string;
  readonly proc: Proc;
  private forget: () => void;

  constructor(name: string, machineId: string, stateDir: string, proc: Proc) {
    this.name = name;
    this.machineId = machineId;
    this.stateDir = stateDir;
    this.proc = proc;
    // The terminals are no children of the test runner's: found by the folder in their command line.
    this.forget = onExit(() => spawnSync("pkill", ["-f", `${stateDir}/terminals/`]));
  }

  log(): string {
    return this.proc.log();
  }

  /** Stops gasho-daemon, and closes the terminals it started, which outlive it (apps/daemon/src/terminal.ts). */
  async stop(): Promise<void> {
    await this.proc.stop();
    const terminals = new Terminals({ stateDir: this.stateDir, env: {}, scopes: false });
    for (const name of (await terminals.live()).keys()) await terminals.kill(name);
    this.forget();
  }
}

export class GashoHub {
  readonly url: string;
  readonly port: number;
  /** The test's folder: hub/ (the Gasho server), home/ (HOME), d<n>/ (each real gasho-daemon). */
  readonly root: string;
  readonly home: string;
  readonly gh: FakeCommand;
  readonly npm: FakeCommand;
  readonly claude: FakeCommand<ClaudeTable>;
  /** The Gasho server's process (another one once startServer has started it again). */
  proc: Proc;
  readonly fakeDaemons: FakeDaemon[] = [];
  readonly daemons: RealDaemon[] = [];
  /** HubOptions.service: what the Gasho server runs under. */
  readonly service: HubService | undefined;
  private env: Record<string, string>;
  private forget: () => void;
  /** The Gasho server's processes before startServer, for logs(). */
  private earlier: Proc[] = [];
  /** The first browser registered, which asks for the codes after it. */
  private cookie: BrowserCookie | undefined;

  constructor(o: {
    root: string;
    port: number;
    env: Record<string, string>;
    proc: Proc;
    fakes: [FakeCommand, FakeCommand, FakeCommand<ClaudeTable>];
    forget: () => void;
    service?: HubService;
  }) {
    this.root = o.root;
    this.service = o.service;
    this.forget = o.forget;
    this.home = path.join(o.root, "home");
    this.port = o.port;
    this.url = `http://127.0.0.1:${o.port}`;
    this.env = o.env;
    this.proc = o.proc;
    [this.gh, this.npm, this.claude] = o.fakes;
  }

  /**
   * A registration code: from `gasho-hub pair`, or, once a browser is registered, from POST /api/pairing-codes as that
   * browser (quicker than starting Node.js again).
   */
  async pairingCode(): Promise<string> {
    if (this.cookie) {
      const res = await fetch(`${this.url}/api/pairing-codes`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${this.cookie.name}=${this.cookie.value}` },
        body: "{}",
      });
      if (res.status === 201) return ((await res.json()) as { code: string }).code;
    }
    const out = await runScript("gasho-hub pair", HUB_CLI, ["pair"], this.env);
    const code = /registration code: (\S+)/.exec(out)?.[1];
    if (!code) throw new Error(`gasho-hub pair printed no code:\n${out}`);
    return code;
  }

  /** Registers a browser with a code, and gives the cookie that the Gasho server set for it. */
  async browserCookie(name = "e2e-browser"): Promise<BrowserCookie> {
    const res = await this.pair("browser", name);
    const value = /gasho_device=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    if (!value) throw new Error("the Gasho server set no registration cookie");
    const cookie: BrowserCookie = { name: "gasho_device", value, url: this.url, httpOnly: true, sameSite: "Strict" };
    this.cookie ??= cookie;
    return cookie;
  }

  /** Registers a working server and connects a fake gasho-daemon as it. */
  async fakeDaemon(o: FakeDaemonOptions = {}): Promise<FakeDaemon> {
    const name = o.name ?? `e2e-machine-${this.fakeDaemons.length + 1}`;
    const res = await this.pair("machine", name);
    const { deviceId, token } = (await res.json()) as { deviceId: string; token: string };
    const d = new FakeDaemon({ ...o, name, url: this.url, machineId: deviceId, token, defaultVersion: checkoutVersion("daemon"), fakeDaemons: this.fakeDaemons });
    this.fakeDaemons.push(d);
    await d.connect();
    return d;
  }

  /**
   * Registers a working server and runs this checkout's gasho-daemon as it, with the fake claude and gh (the tables of
   * this.claude and this.gh), until it has connected to the Gasho server.
   */
  async startDaemon(o: DaemonOptions = {}): Promise<RealDaemon> {
    for (const f of o.folders ?? []) await this.trustFolder(path.join(this.home, f));
    // Watched by gasho-daemon, which Claude Code would have made.
    await fsp.mkdir(path.join(this.home, ".claude", "sessions"), { recursive: true });
    const n = this.daemons.length + 1;
    const name = o.name ?? `e2e-daemon-${n}`;
    // Short: a terminal's socket is <stateDir>/terminals/<name>.sock, and a socket's path may not exceed 104 bytes.
    const stateDir = path.join(this.root, `d${n}`);
    const env = isolatedEnv(this.home, {
      GASHO_DAEMON_CONFIG: path.join(stateDir, "daemon.json"),
      GASHO_HOOK_PORT: String(await freePort()),
      GASHO_CLAUDE_BIN: this.claude.bin,
      GASHO_GH_BIN: this.gh.bin,
      GASHO_CLAUDE_DIR: path.join(this.home, ".claude"),
      GASHO_POLL_MS: "1000",
      // Its own: gasho-daemon removes the attachments of sessions that it does not keep.
      XDG_DATA_HOME: path.join(stateDir, "data"),
      XDG_CACHE_HOME: path.join(stateDir, "cache"),
      ...o.env,
    });
    await runScript("gasho-daemon register", DAEMON_CLI, ["register", "--server", this.url, "--code", await this.pairingCode(), "--name", name], env);
    const creds = JSON.parse(await fsp.readFile(path.join(stateDir, "daemon.json"), "utf8")) as { machineId: string };
    const proc = new Proc(`gasho-daemon ${name}`, DAEMON_CLI, ["run"], env);
    const d = new RealDaemon(name, creds.machineId, stateDir, proc);
    this.daemons.push(d);
    await proc.waitForLog(/hub: connected to/, START_MS);
    return d;
  }

  /** Makes the folder and records it in ~/.claude.json as one Claude Code trusts (apps/daemon/src/managed.ts). */
  async trustFolder(dir: string): Promise<void> {
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(this.home, ".claude.json");
    const data = JSON.parse(await fsp.readFile(file, "utf8").catch(() => "{}")) as { projects?: Record<string, unknown> };
    data.projects = { ...data.projects, [dir]: { hasTrustDialogAccepted: true } };
    await fsp.writeFile(file, JSON.stringify(data, null, 2));
  }

  /** Stops the Gasho server, as one that ended; its folder and its port are kept for startServer. */
  async stopServer(): Promise<void> {
    await this.proc.stop();
  }

  /** Starts the Gasho server again after stopServer, on the same port, with the same database and plugins. */
  async startServer(): Promise<void> {
    if (this.proc.alive) throw new Error("the Gasho server is running");
    this.earlier.push(this.proc);
    this.proc = new Proc("gasho-hub", HUB_CLI, ["start"], this.env);
    await this.proc.waitForLog(/listening on /, START_MS);
  }

  /** What the Gasho server and the real gasho-daemons printed, for a test that failed. */
  logs(): string {
    return [...this.earlier, this.proc, ...this.daemons.map((d) => d.proc)].map((p) => `===== ${p.name}\n${p.log()}`).join("\n\n");
  }

  async stop(): Promise<void> {
    await Promise.all(this.fakeDaemons.map((d) => d.disconnect()));
    await Promise.all(this.daemons.map((d) => d.stop()));
    await this.proc.stop();
    await fsp.rm(this.root, { recursive: true, force: true, maxRetries: 5 });
    this.forget();
  }

  private async pair(kind: "browser" | "machine", name: string): Promise<Response> {
    const code = await this.pairingCode();
    const res = await fetch(`${this.url}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, kind, name }) });
    if (res.status !== 201) throw new Error(`registering ${name} failed: ${res.status} ${await res.text()}`);
    return res;
  }
}

export async function startHub(o: HubOptions = {}): Promise<GashoHub> {
  const webDist = o.webDist ?? path.join(GASHO_DIR, "apps/web/dist");
  if (!fs.existsSync(path.join(webDist, "index.html"))) throw new Error(`${webDist}/index.html がありません。先に npm run web:build を流してください。`);
  // Under /tmp, not the longer os.tmpdir() of macOS: the sockets of a real gasho-daemon's terminals are in it.
  const root = await fsp.realpath(await fsp.mkdtemp("/tmp/ge2e-"));
  const forget = onExit(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const gh = new FakeCommand("gh", home);
  const npm = new FakeCommand("npm", home);
  const claude = new FakeCommand<ClaudeTable>("claude", home);
  await gh.set({ answers: o.gh ?? [catalogAnswer({ plugins: [] })] });
  await npm.set({
    answers: o.npm ?? [npmLatestAnswer("@4rtofl/gasho-daemon", checkoutVersion("daemon")), npmLatestAnswer("@4rtofl/gasho-hub", checkoutVersion("hub"))],
  });
  await claude.set(o.claude ?? {});
  const base = isolatedEnv(home, {
    GASHO_HUB_ENV: "off",
    GASHO_HUB_HOST: "127.0.0.1",
    GASHO_DB: path.join(root, "hub", "hub.db"),
    GASHO_PLUGINS_DIR: path.join(root, "hub", "plugins"),
    GASHO_PLUGIN_CACHE: path.join(root, "hub", "plugin-cache"),
    GASHO_WEB_DIST: webDist,
    GASHO_GH_BIN: gh.bin,
    GASHO_NPM_BIN: npm.bin,
    ...o.env,
  });
  await fsp.mkdir(path.join(root, "hub"), { recursive: true });
  for (const dir of o.plugins ?? []) await runScript("gasho-hub plugin add", HUB_CLI, ["plugin", "add", "--link", path.resolve(dir)], base);
  const service = o.service && (await serviceOf(root, o.service, base, forget));
  for (let attempt = 1; ; attempt++) {
    const port = await freePort();
    const env = { ...(service?.env ?? base), GASHO_HUB_PORT: String(port) };
    const proc = service ? new Proc("gasho-hub (service)", SERVICE_BIN, [service.launcher, service.control], env) : new Proc("gasho-hub", HUB_CLI, ["start"], env);
    try {
      await proc.waitForLog(/listening on /, START_MS);
      const hubService = service && new HubService({ root: service.layout, control: service.control, proc });
      return new GashoHub({ root, port, env, proc, fakes: [gh, npm, claude], forget: service?.forget ?? forget, service: hubService });
    } catch (e) {
      await proc.stop();
      // Another process took the port after freePort let it go.
      if (attempt < 3 && /is in use/.test(proc.log())) continue;
      await fsp.rm(root, { recursive: true, force: true });
      (service?.forget ?? forget)();
      throw e;
    }
  }
}

/**
 * The layout of HubOptions.service in the test's folder, and the environment the service manager gives the launcher
 * (none of the shell's: XPC_SERVICE_NAME is set in a terminal of macOS too).
 */
async function serviceOf(root: string, o: HubServiceOptions, base: Record<string, string>, forgetRoot: () => void) {
  const layout = path.join(root, "hub", "service");
  await fsp.mkdir(layout, { recursive: true });
  const launcher = await makeLayout(layout, o);
  const env: Record<string, string> = { ...base, GASHO_HUB_HOME: layout };
  delete env.XPC_SERVICE_NAME;
  delete env.INVOCATION_ID;
  if (o.asService !== false) Object.assign(env, { XPC_SERVICE_NAME: "local.gasho.hub", INVOCATION_ID: "gasho-e2e" });
  // A Gasho server left running when the test runner ended before the test did: found by its launcher's path.
  const forgetProcs = onExit(() => spawnSync("pkill", ["-f", launcher]));
  const forget = () => {
    forgetProcs();
    forgetRoot();
  };
  return { layout, launcher, control: path.join(root, "hub", "service.json"), env, forget };
}
