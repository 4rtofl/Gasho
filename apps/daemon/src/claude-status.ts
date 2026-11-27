// Whether Claude Code can be used on this working server, for the 端末 screen: found by running its own commands
// (`claude --version`, `claude auth status --json`). From auth status, only login state and subscription type are kept.
import type { AgentStatus } from "@gasho/protocol";
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

type ClaudeAuth = { status: AgentStatus; subscriptionType?: string };

export type ClaudeInfo = ClaudeAuth & { version?: string };

/** What the JSON of `claude auth status --json` says; it exits with 1 when not logged in, and says so all the same. */
export function claudeAuthOf(stdout: unknown): ClaudeAuth {
  if (typeof stdout !== "string") return { status: "unknown" };
  try {
    const auth = JSON.parse(stdout) as { loggedIn?: unknown; subscriptionType?: unknown } | null;
    if (auth?.loggedIn === true) {
      const subscriptionType = auth.subscriptionType;
      return { status: "available", ...(typeof subscriptionType === "string" ? { subscriptionType } : {}) };
    }
    return { status: auth?.loggedIn === false ? "loginRequired" : "unknown" };
  } catch {
    return { status: "unknown" };
  }
}

/** Claude Code on this working server. Gasho needs it, so one that cannot be run is told as a state not known. */
export async function detectClaude(run: RunClaude): Promise<ClaudeInfo> {
  let version: string | undefined;
  try {
    version = claudeVersionOf((await run(["--version"])).stdout);
  } catch {
    return { status: "unknown" };
  }
  const auth = await run(["auth", "status", "--json"]).then(
    (r) => claudeAuthOf(r.stdout),
    (e: unknown) => claudeAuthOf((e as { stdout?: unknown } | null)?.stdout),
  );
  return { ...auth, ...(version ? { version } : {}) };
}
