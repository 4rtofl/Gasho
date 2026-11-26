// Taking a repository off a working server's registered ones (repo.unregister) from the heading of a grouping's
// category that stands for it (docs/plugins.md, P18): whether it can be, and what the sidebar lists of it once it is.
// Its folders and files stay; so do its sessions, and with them their worktrees' rows (no longer registered). The
// worktrees without a session leave the list, but for those this browser keeps (remembered-worktrees).
import type { MachineInfo } from "@gasho/protocol";
import { worktreesByLastUse, type RememberedWorktree } from "./sessions.ts";

/** Why the repository at `path` cannot be taken off `machine`, for people; undefined when it can. */
export function unregisterRepoProblem(machine: MachineInfo, path: string): string | undefined {
  if (!machine.connected) return `${machine.name} はオフラインです。`;
  if (!machine.repos) return `${machine.name} の gasho-daemon は古いため、リポジトリの登録を外せません。gasho-daemon を更新してください。`;
  if (!machine.repos.some((r) => r.path === path)) return `${machine.name} に登録していないリポジトリです。`;
  return undefined;
}

/** What the sidebar lists of a repository once it is taken off its working server. */
export interface UnregisterPlan {
  /** Its worktrees with sessions, which stay in the list. */
  staying: number;
  /** The sessions in them. */
  sessions: number;
  /** Its worktrees that leave the list (those without a session). */
  leaving: number;
}

export function unregisterRepoPlan(machines: MachineInfo[], remembered: RememberedWorktree[], machine: string, path: string): UnregisterPlan {
  const of = (ms: MachineInfo[]) => worktreesByLastUse(ms, remembered).filter((w) => w.machine.id === machine && w.repoFolder === path);
  const before = of(machines);
  const after = of(machines.map((m) => (m.id === machine && m.repos ? { ...m, repos: m.repos.filter((r) => r.path !== path) } : m)));
  const staying = after.filter((w) => w.sessions.length > 0);
  return { staying: staying.length, sessions: staying.reduce((n, w) => n + w.sessions.length, 0), leaving: before.length - after.length };
}
