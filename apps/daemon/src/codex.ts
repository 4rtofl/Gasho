// Whether Codex can be used on this working server: found by running its own commands (`codex --version`, `codex login
// status`). Its credentials (~/.codex/auth.json) are never read, and what the commands print goes no further than here.
import type { AgentInfo, AgentStatus } from "@gasho/protocol";
import { exec, type ExecResult } from "./exec.ts";

/** How long each command may take: both answer at once, without the network. */
const CODEX_TIMEOUT_MS = 10_000;

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
