// Whether Codex can be used on this working server: found by running its own commands (`codex --version`, `codex login
// status`). Its credentials (~/.codex/auth.json) are never read, and what the commands print goes no further than here.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentInfo, AgentStatus } from "@gasho/protocol";
import { exec, type ExecResult } from "./exec.ts";

const execFileP = promisify(execFile);

/** How long each command may take: both answer at once, without the network. */
const CODEX_TIMEOUT_MS = 10_000;
/** How long `codex app-server daemon start` may take: it may have to start the app-server. */
const SERVER_START_TIMEOUT_MS = 60_000;

/** Runs `codex` with these arguments; rejects as exec does when it cannot be run or ends with an error. */
export type RunCodex = (args: string[]) => Promise<ExecResult>;

export function codexRunner(bin: string): RunCodex {
  return (args) => exec(bin, args, { timeoutMs: CODEX_TIMEOUT_MS });
}

/** The version in the output of `codex --version` ("codex-cli 0.170.0"). */
export function codexVersionOf(output: string): string | undefined {
  return /^codex-cli\s+(\d+\.\d+\.\d+\S*)\s*$/m.exec(output)?.[1];
}

/**
 * What `codex login status` ended with. It says "Not logged in" on stderr and exits with 1; it exits with 1 as well when
 * it fails for another reason (settings that cannot be read), which logging in would not mend.
 */
export function codexLoginStatusOf(failure: unknown): AgentStatus {
  const stderr = (failure as { stderr?: unknown } | null)?.stderr;
  return typeof stderr === "string" && /^Not logged in\s*$/m.test(stderr) ? "loginRequired" : "unknown";
}

/** Codex on this working server; undefined when it is not installed. */
export async function detectCodex(run: RunCodex): Promise<AgentInfo | undefined> {
  let version: string | undefined;
  try {
    version = codexVersionOf((await run(["--version"])).stdout);
  } catch (e) {
    return (e as NodeJS.ErrnoException | null)?.code === "ENOENT" ? undefined : { status: "unknown" };
  }
  const status = await run(["login", "status"]).then((): AgentStatus => "available", codexLoginStatusOf);
  return { status, ...(version ? { version } : {}) };
}

/** The socket in what `codex app-server daemon start` prints: a line of JSON, whether it started it or it already ran. */
export function codexSocketOf(output: string): string | undefined {
  for (const line of output.split("\n").reverse()) {
    try {
      const socket = (JSON.parse(line) as { socketPath?: unknown } | null)?.socketPath;
      if (typeof socket === "string" && socket) return socket;
    } catch {
      // not the line
    }
  }
  return undefined;
}

/** Runs `command` (`codex app-server daemon start`, as `command` wraps it) and gives the app-server's socket. */
export async function startCodexServer(command: string[], env: Record<string, string>): Promise<string> {
  const { stdout } = await execFileP(command[0] ?? "", command.slice(1), { env, timeout: SERVER_START_TIMEOUT_MS });
  const socket = codexSocketOf(stdout);
  if (!socket) throw new Error("codex app-server daemon start did not say where its socket is");
  return socket;
}
