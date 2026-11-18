// The processes a test starts (the Gasho server, gasho-daemon), their logs, and the environment they get: a HOME and
// XDG folders of the test's own, and none of the GASHO_* settings of the shell that runs the tests.
import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The Gasho checkout these files are in (GashoPlugins gets one in gasho/). */
export const GASHO_DIR = fileURLToPath(new URL("../..", import.meta.url));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What a test started and has not stopped yet, undone (latest first) if the test runner ends before the test does
 * (a test that ran out of time): its processes, its terminals, its folder. Each undo is synchronous.
 */
const leftovers = new Set<() => void>();
process.once("exit", () => {
  for (const undo of [...leftovers].reverse()) {
    try {
      undo();
    } catch {
      // the next one still runs
    }
  }
});

/** Registers what to undo at exit; the function it gives takes it back once the test has undone it itself. */
export function onExit(undo: () => void): () => void {
  leftovers.add(undo);
  return () => leftovers.delete(undo);
}

export function isolatedEnv(home: string, more: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.startsWith("GASHO_") || k.startsWith("CLAUDE")) continue;
    if (["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"].includes(k)) continue;
    env[k] = v;
  }
  return {
    ...env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    ...more,
  };
}

/**
 * The ports of the Gasho servers stopped to be started again (GashoHub.stopServer), one file each, which freePort
 * gives to no test of any worker: such a server starts on its port again, which the screen and gasho-daemon go to.
 */
const KEPT_PORTS = "/tmp/ge2e-ports";

/** Keeps the port from freePort until the function it gives is called. */
export function keepPort(port: number): () => void {
  fs.mkdirSync(KEPT_PORTS, { recursive: true });
  const file = path.join(KEPT_PORTS, String(port));
  fs.writeFileSync(file, "");
  const forget = onExit(() => fs.rmSync(file, { force: true }));
  return () => {
    fs.rmSync(file, { force: true });
    forget();
  };
}

/** A port on the loopback that nothing listens on now, and that no stopped Gasho server keeps (keepPort). */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = await anyPort();
    if (!fs.existsSync(path.join(KEPT_PORTS, String(port)))) return port;
  }
}

function anyPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/** A TypeScript file of the checkout run by Node.js, with what it prints kept as its log. */
export class Proc {
  readonly name: string;
  readonly child: ChildProcess;
  private lines: string[] = [];
  private exited: Promise<number | null>;

  constructor(name: string, script: string, args: string[], env: Record<string, string>) {
    this.name = name;
    this.child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(GASHO_DIR, script), ...args], {
      cwd: GASHO_DIR,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const forget = onExit(() => this.child.kill("SIGKILL"));
    for (const s of [this.child.stdout, this.child.stderr]) {
      s?.setEncoding("utf8");
      let rest = "";
      s?.on("data", (chunk: string) => {
        const parts = (rest + chunk).split("\n");
        rest = parts.pop() ?? "";
        this.lines.push(...parts);
      });
      s?.on("end", () => rest && this.lines.push(rest));
    }
    this.exited = new Promise((resolve) => {
      // "close": after what it printed has been read too.
      this.child.on("close", (code) => {
        forget();
        resolve(code);
      });
    });
  }

  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  log(): string {
    return this.lines.join("\n");
  }

  /** Waits for a line of its log, and throws if it ends first or the time is up. */
  async waitForLog(re: RegExp, timeoutMs: number): Promise<void> {
    for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(100)) {
      if (this.lines.some((l) => re.test(l))) return;
      if (!this.alive) throw new Error(`${this.name} ended before ${re}:\n${this.log()}`);
    }
    throw new Error(`${this.name} did not print ${re} in ${timeoutMs} ms:\n${this.log()}`);
  }

  /** Its exit code once it ends. */
  done(): Promise<number | null> {
    return this.exited;
  }

  /** SIGTERM, then SIGKILL if it has not ended in 10 s. */
  async stop(): Promise<void> {
    if (!this.alive) return;
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 10_000);
    await this.exited;
    clearTimeout(timer);
  }
}

/** Runs a command of the checkout to its end; throws with what it printed if it fails. */
export async function runScript(name: string, script: string, args: string[], env: Record<string, string>): Promise<string> {
  const p = new Proc(name, script, args, env);
  const code = await p.done();
  if (code !== 0) throw new Error(`${name} ${args.join(" ")} failed (${code}):\n${p.log()}`);
  return p.log();
}
