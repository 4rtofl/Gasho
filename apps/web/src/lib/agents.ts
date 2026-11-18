// The agents found on a working server besides Claude Code, as the screen says them.
import type { AgentInfo, AgentStatus } from "@gasho/protocol";
import { compareVersions } from "./daemon-update.ts";

/** The version of Codex that Gasho was checked with (docs/research.md). */
export const CODEX_CHECKED_VERSION = "0.170.0";

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  available: "使えます",
  loginRequired: "ログインしていません",
  unknown: "状態を確かめられませんでした",
};

/** Whether this Codex is older than the version Gasho was checked with; an unknown version is not said to be. */
export function codexOutdated(codex: AgentInfo): boolean {
  return codex.version !== undefined && compareVersions(codex.version, CODEX_CHECKED_VERSION) < 0;
}
