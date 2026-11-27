// Starting a session from Gasho's screen, by every way there is: the launch form, a worktree's "＋", a category's "＋" and
// a plugin's useLaunchSession.
import type { AgentKind, CommandResult } from "@gasho/protocol";
import { launchAgentField } from "./agents.ts";
import { sendCommand } from "./store.ts";

/** How long to wait for a new session, a little longer than the Gasho server does. */
const LAUNCH_WAIT_MS = 60_000;

export interface LaunchInput {
  cwd: string;
  name?: string;
  trust?: boolean;
  /** The agent to start: Claude Code when absent. */
  agent?: AgentKind;
}

function launchSession(machine: string, input: LaunchInput): Promise<CommandResult> {
  return sendCommand(
    machine,
    { type: "session.launch", cwd: input.cwd, name: input.name, ...(input.trust ? { trust: true } : {}), ...launchAgentField(input.agent ?? "claude"), ...(input.agent === "antigravity" ? { screen: true } : {}) },
    LAUNCH_WAIT_MS,
  );
}

/** The one way the screen starts a session. */
export const useSessionLauncher = () => launchSession;
