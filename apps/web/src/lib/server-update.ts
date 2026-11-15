// The Gasho server itself (ServerInfo): updating it from Gasho (hub.update), and what a page does once the Gasho server
// serves another build of the screen than its own (after an update, or a clone's npm run web:build): it reloads, unless
// something not sent or not saved is being written in it, which reloading would lose; then a band says so.
import type { HubUpdateStep, LatestVersions, ServerInfo } from "@gasho/protocol";
import { compareVersions } from "./daemon-update.ts";

/** What makes the Gasho server updatable from Gasho, when it was started otherwise. */
export const HUB_INSTALL_COMMAND = "npx @4rtoflow/gasho-hub@latest service install";

export const HUB_STEP_LABEL: Record<HubUpdateStep, string> = {
  install: "新しい版を取り込んでいます",
  check: "起動できるか、データベースを開けるかを確かめています",
  drain: "処理中の命令が終わるのを待っています",
  restart: "切り替えて、起動し直しています",
  trial: "新しい版を確かめています（1分ほど。起動できなければ、自動で前の版に戻ります）",
};

/** The version the Gasho server can be updated to now, if any. */
export function hubUpdateTo(server: ServerInfo | undefined, latest: LatestVersions | undefined): string | undefined {
  const to = latest?.hub;
  const u = server?.update;
  if (!to || !server || !u?.canUpdate || (u.progress && u.progress.step !== "trial")) return undefined;
  return compareVersions(to, server.version) > 0 ? to : undefined;
}

/**
 * The version the sidebar tells of (its 端末 badge): one to update to, unless the Gasho server went back by itself from
 * that very version (it did not start; the row says why and still offers it).
 */
export function hubUpdateToTell(server: ServerInfo | undefined, latest: LatestVersions | undefined): string | undefined {
  const to = hubUpdateTo(server, latest);
  return to && server?.update.rolledBack?.from !== to ? to : undefined;
}

/** Whether a newer Gasho server is published than the one running (updatable from Gasho or not). */
export function hubNewerPublished(server: ServerInfo | undefined, latest: LatestVersions | undefined): boolean {
  const to = latest?.hub;
  return Boolean(to && server && compareVersions(to, server.version) > 0);
}

/** The changes between two versions of the Gasho server, on GitHub (each release is tagged hub-v<version>). */
export function hubChangesUrl(from: string, to: string): string {
  return `https://github.com/4rtoflow/Gasho/compare/hub-v${from}...hub-v${to}`;
}

/** Whether this page (of build `own`) is out of date: the Gasho server serves another build. Never under the dev server. */
export function outOfDate(server: ServerInfo | undefined, own: string): boolean {
  return own !== "dev" && server?.web !== undefined && server.web !== own;
}

/** The last reload made by itself for a build (kept per tab), so that a page that keeps being out of date does not loop. */
export interface AutoReload {
  build: string;
  at: number;
}

/** How soon a page reloads itself again for the same build. */
export const RELOAD_AGAIN_MS = 60_000;

/**
 * What an out-of-date page does: reloads itself, or (something is being written in it, or it reloaded itself for this
 * build a moment ago) shows the band, whose button reloads it.
 */
export function onOutOfDate(o: { build: string; busy: boolean; last: AutoReload | undefined; now: number }): "reload" | "band" {
  if (o.busy) return "band";
  if (o.last && o.last.build === o.build && o.now - o.last.at < RELOAD_AGAIN_MS) return "band";
  return "reload";
}
