// Whether Claude Code can be used on this working server, for the 端末 screen: found by running its own commands
// (`claude --version`, `claude auth status --json`). Only whether it is logged in is taken from the second: it also
// says who is logged in, which stays here.
import type { AgentInfo, AgentStatus } from "@gasho/protocol";
import { exec, type ExecResult } from "./exec.ts";

/** How long each command may take. */
const CLAUDE_TIMEOUT_MS = 10_000;

/** Runs `claude` with these arguments; rejects as exec does when it cannot be run or ends with an error. */
export type RunClaude = (args: string[]) => Promise<ExecResult>;

export function claudeRunner(bin: string): RunClaude {
  return (args) => exec(bin, args, { timeoutMs: CLAUDE_TIMEOUT_MS });
}

/** The version in the output of `claude --version` ("2.1.327 (Claude Code)"). */
export function claudeVersionOf(output: string): string | undefined {
  return /^(\d+\.\d+\.\d+\S*)\s+\(Claude Code\)\s*$/m.exec(output)?.[1];
}

/** What the JSON of `claude auth status --json` says; it exits with 1 when not logged in, and says so all the same. */
export function claudeStatusOf(stdout: unknown): AgentStatus {
  if (typeof stdout !== "string") return "unknown";
  try {
    const loggedIn = (JSON.parse(stdout) as { loggedIn?: unknown } | null)?.loggedIn;
    return loggedIn === true ? "available" : loggedIn === false ? "loginRequired" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Claude Code on this working server. Gasho needs it, so one that cannot be run is told as a state not known. */
export async function detectClaude(run: RunClaude): Promise<AgentInfo> {
  let version: string | undefined;
  try {
    version = claudeVersionOf((await run(["--version"])).stdout);
  } catch {
    return { status: "unknown" };
  }
  const status = await run(["auth", "status", "--json"]).then(
    (r) => claudeStatusOf(r.stdout),
    (e: unknown) => claudeStatusOf((e as { stdout?: unknown } | null)?.stdout),
  );
  return { status, ...(version ? { version } : {}) };
}
