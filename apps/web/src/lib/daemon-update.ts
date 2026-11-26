// Updating gasho-daemon from Gasho (daemon.update): what a working server's row says, and whether there is an update.
import type { DaemonUpdateStep, LatestVersions, MachineInfo } from "@gasho/protocol";

/** The command that makes gasho-daemon updatable from Gasho, for one too old to say whether it is. */
export const INSTALL_COMMAND = "npx @4rtofl/gasho-daemon@latest service install";
/** How long a restart may take before the row suggests looking at the working server's log. */
export const RESTART_SLOW_MS = 2 * 60_000;

export const STEP_LABEL: Record<DaemonUpdateStep, string> = {
  install: "新しいバージョンを取り込んでいます",
  check: "起動できるか確かめています",
  wait: "送るのを待っている入力を、送り終えるまで待っています",
  restart: "切り替えて、動かし直しています",
  trial: "新しいバージョンを確かめています",
};

/** A trial's length as the screen says it: in minutes when whole ones, else in seconds. */
export function trialLength(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000}分` : `${Math.round(ms / 1000)}秒`;
}

/** What a working server's row says while its new gasho-daemon is on trial: how long, when gasho-daemon says it. */
export function trialLabel(trialMs: number | undefined): string {
  const length = trialMs !== undefined ? `${trialLength(trialMs)}ほど。` : "";
  return `${STEP_LABEL.trial}（${length}起動できなければ、自動で前のバージョンに戻ります）`;
}

/** -1, 0 or 1 as `a` is older than, the same as, or newer than `b` (x.y.z; a missing part counts as 0). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** The version a working server's gasho-daemon can be updated to now, if any. */
export function updateTo(m: MachineInfo, latest: LatestVersions | undefined): string | undefined {
  const to = latest?.daemon;
  const u = m.update;
  if (!to || !m.connected || !u?.canUpdate || (u.progress && u.progress.step !== "trial")) return undefined;
  return !m.daemonVersion || compareVersions(to, m.daemonVersion) > 0 ? to : undefined;
}

/**
 * The version the sidebar tells of (its 端末 badge): one to update to, unless gasho-daemon went back by itself from that
 * very version (it did not start; the row says why and still offers it).
 */
export function updateToTell(m: MachineInfo, latest: LatestVersions | undefined): string | undefined {
  const to = updateTo(m, latest);
  return to && m.update?.rolledBack?.from !== to ? to : undefined;
}

/** Whether a newer gasho-daemon is published than the one a working server runs (updatable from Gasho or not). */
export function newerPublished(m: MachineInfo, latest: LatestVersions | undefined): boolean {
  const to = latest?.daemon;
  return Boolean(to && m.daemonVersion && compareVersions(to, m.daemonVersion) > 0);
}

/** The changes between two versions of gasho-daemon, on GitHub (each release is tagged daemon-v<version>). */
export function changesUrl(from: string, to: string): string {
  return `https://github.com/4rtofl/Gasho/compare/daemon-v${from}...daemon-v${to}`;
}

/** What waits on a working server that an update would affect: inputs still to send, and permission requests. */
export function pendingWork(m: MachineInfo): { inputs: number; requests: number } {
  let inputs = 0;
  let requests = 0;
  for (const s of m.sessions) {
    inputs += s.pendingInputs ?? 0;
    // A question read from the session's screen ("question:…") is read again after the restart; a permission request
    // held through Claude Code's hook is not.
    requests += (s.permissionRequests ?? []).filter((r) => !r.id.startsWith("question:")).length;
  }
  return { inputs, requests };
}

/** How long 「すべて更新」 waits for one working server's update before going on to the next. */
export const UPDATE_ALL_WAIT_MS = 10 * 60_000;

/**
 * Where a working server's update stands, as 「すべて更新」 waits for it before the next (DaemonUpdates): "running"
 * until it is done ("done": running the new version, on trial or past it), it failed without changing anything
 * ("failed", the row says why), or the working server is no longer registered ("gone"). `failedBefore` is the time of
 * the failure the row showed before the update was started; `seen` is whether its progress has been seen (the answer
 * to daemon.update may come before the working server's state says it started).
 */
export function updateOutcome(
  m: MachineInfo | undefined,
  version: string,
  failedBefore: number | undefined,
  seen: boolean,
): "running" | "done" | "failed" | "gone" {
  if (!m) return "gone";
  const u = m.update;
  if (!m.connected) return "running";
  if (u?.failed && u.failed.version === version && u.failed.at !== failedBefore) return "failed";
  const busy = u?.progress && u.progress.step !== "trial";
  if (busy) return "running";
  return seen || m.daemonVersion === version ? "done" : "running";
}
