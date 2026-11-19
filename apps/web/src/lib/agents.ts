// The agents that run sessions (Claude Code, Codex): what the screen calls them, what a session of each can do, and which
// one a new session starts with.
import type { AgentInfo, AgentKind, AgentOperation, AgentStatus, MachineInfo } from "@gasho/protocol";
import { compareVersions } from "./daemon-update.ts";

/** The version of Codex that Gasho was checked with (docs/research.md). */
export const CODEX_CHECKED_VERSION = "0.170.0";

export const AGENT_NAME: Record<AgentKind, string> = { claude: "Claude Code", codex: "Codex" };
/** The agent as the one who works and answers in a session ("Claude からの質問"). */
export const AGENT_SPEAKER: Record<AgentKind, string> = { claude: "Claude", codex: "Codex" };
/** What to run on the working server to log in. */
export const AGENT_LOGIN_COMMAND: Record<AgentKind, string> = { claude: "claude auth login", codex: "codex login" };

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  available: "使えます",
  loginRequired: "ログインしていません",
  unknown: "状態を確かめられませんでした",
};

/** Whether this Codex is older than the version Gasho was checked with; an unknown version is not said to be. */
export function codexOutdated(codex: AgentInfo): boolean {
  return codex.version !== undefined && compareVersions(codex.version, CODEX_CHECKED_VERSION) < 0;
}

/** The agent of a session: one that names none is Claude Code's. */
export const sessionAgent = (session: { agent?: AgentKind }): AgentKind => session.agent ?? "claude";

/** Whether a session can do this. A gasho-daemon that does not list what its agents can do runs only Claude Code. */
export function canDo(machine: MachineInfo, session: { agent?: AgentKind }, operation: AgentOperation): boolean {
  const agent = sessionAgent(session);
  const operations = machine.agents?.[agent]?.operations;
  return operations ? operations.includes(operation) : agent === "claude";
}

/** Codex is offered on this working server: it is installed, and its gasho-daemon can start it. */
export const codexOffered = (machine: MachineInfo): boolean => machine.agents?.codex?.canLaunch === true;

/** Why Codex cannot be picked on a working server that offers it. */
export function codexProblem(machine: MachineInfo): string | undefined {
  const status = machine.agents?.codex?.status;
  if (status === "available") return undefined;
  return status === "loginRequired"
    ? `${machine.name} で codex login を実行すると使えます。`
    : `${machine.name} の Codex の状態を確かめられません。`;
}

export const codexUsable = (machine: MachineInfo): boolean => codexOffered(machine) && codexProblem(machine) === undefined;

/** The agent a new session starts with on a working server: the default one, or Claude Code where that cannot be used. */
export function launchAgentFor(machine: MachineInfo, defaultAgent: AgentKind | undefined): AgentKind {
  return defaultAgent === "codex" && codexUsable(machine) ? "codex" : "claude";
}

/** What session.launch says about the agent: nothing for Claude Code, which every gasho-daemon starts. */
export const launchAgentField = (agent: AgentKind): { agent?: AgentKind } => (agent === "codex" ? { agent } : {});

/** What a "＋" says it does. Where only Claude Code can be started, it says what it always said. */
export function launchTitle(machine: MachineInfo, defaultAgent: AgentKind | undefined, what: string): string {
  if (!codexOffered(machine)) return what;
  return `${what}：${AGENT_NAME[launchAgentFor(machine, defaultAgent)]}（右クリックか長押しで、エージェントを選べます）`;
}

/** Sessions show which agent runs them once Codex can be used somewhere. */
export const showsAgents = (machines: readonly MachineInfo[]): boolean => machines.some(codexUsable);
