// Removing a worktree with its sessions (worktree.remove): whether it can be, which sessions end with it, and whether
// the screen shows it (it then goes to the home screen). Shared by the sidebar's menu and the plugin SDK.
import type { MachineInfo, SessionInfo } from "@gasho/protocol";
import type { Route } from "./route.ts";

/** Why the worktree cannot be removed, for people; undefined when it can. `repo`: its repository's folder. */
export function removeWorktreeProblem(machine: MachineInfo, worktree: { path: string; repo?: string }): string | undefined {
  if (!worktree.repo) return "git のリポジトリの外のフォルダーは、Gasho からは削除できません。";
  if (worktree.path === worktree.repo) return "リポジトリの main の worktree（リポジトリのフォルダーそのもの）は削除できません。";
  if (!machine.connected) return `${machine.name} はオフラインです。`;
  if (!machine.canRemoveWorktree) return `${machine.name} の gasho-daemon は古いため、worktree を削除できません。gasho-daemon を更新してください。`;
  return undefined;
}

export const isInsideFolder = (dir: string, root: string): boolean => dir === root || dir.startsWith(root.endsWith("/") ? root : `${root}/`);

/** The sessions that end with the worktree: those whose folder is in it, started from Gasho or outside it. */
export function sessionsInWorktree(machine: MachineInfo, path: string): SessionInfo[] {
  return machine.sessions.filter((s) => isInsideFolder(s.cwd, path));
}

/** Whether `route` shows the worktree: its page or tabs, or one of `sessions` (those in it, as they were before it went). */
export function showsWorktree(route: Route, machine: string, path: string, sessions: readonly string[]): boolean {
  if (route.name === "worktree") return route.machine === machine && route.path === path;
  if (route.name === "session") return route.machine === machine && sessions.includes(route.sessionId);
  return false;
}
