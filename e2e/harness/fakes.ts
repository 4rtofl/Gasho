// The fake gh, npm and claude that the Gasho server and gasho-daemon run under test (GASHO_GH_BIN, GASHO_NPM_BIN,
// GASHO_CLAUDE_BIN). Each answers from a table the test writes and records the arguments of every call. The table and
// the record are files under $HOME/.gasho-e2e: the terminals of the sessions gasho-daemon starts pass Claude Code little
// more than HOME (cleanEnv in apps/daemon/src/managed.ts), so the fakes find them there. The table is read at every
// call, so a test can change the answers while it runs.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type FakeName = "gh" | "npm" | "claude";

/** An argument as given, or a regular expression it matches (a string in the table, which is JSON). */
export type ArgPattern = string | { re: string };

/** An answer of the table: the first one whose `args` the call's arguments start with is given. */
export interface FakeAnswer {
  args: ArgPattern[];
  stdout?: string;
  stderr?: string;
  /** 0 when absent. */
  exitCode?: number;
  /** gh release download: the text written to the file that follows --output. */
  output?: string;
  /** …or the file copied there (a plugin's .tgz). */
  outputFile?: string;
  /** A folder copied into the folder the command runs in, at `to` (npm install: the packages, at node_modules). */
  copyInto?: { from: string; to: string };
  /** How long it takes to answer (ms). */
  delayMs?: number;
}

export interface FakeTable {
  answers?: FakeAnswer[];
}

/** A row of `claude agents --json` (apps/daemon/src/sessions.ts). */
export interface AgentRow {
  pid?: number;
  cwd?: string;
  kind?: string;
  startedAt?: number;
  sessionId?: string;
  name?: string;
  status?: string;
  waitingFor?: string;
  state?: string;
}

/** The answer to a control request of `claude -p --input-format stream-json`, by its subtype. */
export type ControlAnswer = { response: unknown } | { error: string };

export interface ClaudeTable extends FakeTable {
  /** Listed by `claude agents --json`, besides the sessions the fake runs in gasho-daemon's terminals. */
  agents?: AgentRow[];
  /** initialize is answered with {} when absent; any other subtype without an answer, with an error. */
  controls?: Record<string, ControlAnswer>;
  /** What the fake answers in a terminal when it is sent `text` (by default, it repeats the text). */
  replies?: { text: string; reply: string }[];
}

export interface FakeCall {
  args: string[];
  cwd: string;
  at: number;
}

export const FAKES_DIR = ".gasho-e2e";

/** The executable of a fake (a script with a shebang, run by the Node.js on PATH). */
export function fakeBin(name: FakeName): string {
  return fileURLToPath(new URL(`./bin/${name}.ts`, import.meta.url));
}

export function tableFile(home: string, name: FakeName): string {
  return path.join(home, FAKES_DIR, `${name}.json`);
}

export function callsFile(home: string, name: FakeName): string {
  return path.join(home, FAKES_DIR, `${name}.calls.jsonl`);
}

/** One fake, for a test to give its answers and read its calls. */
export class FakeCommand<T extends FakeTable = FakeTable> {
  readonly name: FakeName;
  readonly bin: string;
  readonly home: string;

  constructor(name: FakeName, home: string) {
    this.name = name;
    this.bin = fakeBin(name);
    this.home = home;
  }

  /** Replaces the table. Written aside and then moved in, so that a call never reads half of it. */
  async set(table: T): Promise<void> {
    const file = tableFile(this.home, this.name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(table));
    await fs.rename(tmp, file);
  }

  async table(): Promise<T> {
    return readTable<T>(this.home, this.name);
  }

  /** The calls so far, oldest first. */
  async calls(): Promise<FakeCall[]> {
    const text = await fs.readFile(callsFile(this.home, this.name), "utf8").catch(() => "");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as FakeCall);
  }
}

export async function readTable<T extends FakeTable>(home: string, name: FakeName): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(tableFile(home, name), "utf8")) as T;
  } catch {
    return {} as T;
  }
}

export function matches(pattern: ArgPattern[], args: string[]): boolean {
  return pattern.length <= args.length && pattern.every((p, i) => (typeof p === "string" ? p === args[i] : new RegExp(p.re).test(args[i] ?? "")));
}

/** gh release download --output: the answer for the catalog of plugins (apps/hub/src/catalog.ts). */
export function catalogAnswer(catalog: unknown, repo = "4rtofl/GashoPlugins"): FakeAnswer {
  return { args: ["release", "download", "catalog", "--repo", repo], output: JSON.stringify(catalog) };
}

/** npm view <package> version: the answer for the latest published version (apps/hub/src/latest.ts). */
export function npmLatestAnswer(pkg: string, version: string): FakeAnswer {
  return { args: ["view", pkg, "version"], stdout: JSON.stringify(version) };
}

/**
 * npm install of <package>@<version>, as an update runs it (apps/hub/src/self-update.ts): the answer that puts the
 * packages of `nodeModules` (the package and what it needs) in the folder it installs in.
 */
export function npmInstallAnswer(pkg: string, version: string, nodeModules: string): FakeAnswer {
  return {
    args: ["install", "--prefer-online", "--no-audit", "--no-fund", "--omit=dev", `${pkg}@${version}`],
    copyInto: { from: nodeModules, to: "node_modules" },
  };
}
