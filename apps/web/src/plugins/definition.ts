// What a plugin's web part must be for this screen to load it: written for a plugin API it runs, and exporting a
// definition of the right shape (registry.ts loads it).
import type { FileViewer, PluginDefinition } from "@gasho/plugin-sdk";
import { PLUGIN_API } from "@gasho/plugin-sdk/exports";
import { checkWorktreeGroupings } from "../lib/worktree-groupings.ts";

/** Whether this screen runs plugins written for `api` (the same major, a minor up to its own). */
export function apiSupported(api: string): boolean {
  const [major, minor] = PLUGIN_API.split(".").map(Number);
  const m = /^(\d+)\.(\d+)$/.exec(api);
  return Boolean(m && Number(m[1]) === major && Number(m[2]) <= (minor ?? 0));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** An extension of a file viewer (P20) as files are matched against it: without the dot, in lower case. */
const bare = (extension: string) => extension.replace(/^\./, "").toLowerCase();

/** What a web.js exports, checked enough that drawing it cannot fail on its shape. */
export function checkDefinition(d: unknown): PluginDefinition {
  if (!isRecord(d)) throw new Error("web.js が、プラグイン（export default definePlugin({ … })）を書き出していません。");
  for (const k of ["sidebar", "sessionHeader", "homeTiles", "conversationEnd", "composerFooter", "worktreeTabs", "fileViewers"] as const) {
    if (d[k] !== undefined && !Array.isArray(d[k])) throw new Error(`${k} は配列にしてください。`);
    for (const item of (d[k] as unknown[] | undefined) ?? []) {
      if (!isRecord(item) || typeof item.id !== "string" || !item.id) throw new Error(`${k} の項目に id がありません。`);
    }
  }
  for (const k of ["pages", "sessionPanels", "pagePanels", "worktreeViews"] as const) {
    if (d[k] !== undefined && !isRecord(d[k])) throw new Error(`${k} はオブジェクトにしてください。`);
  }
  // The file panel matches every file against the extensions, outside the plugin's error boundary.
  for (const v of (d.fileViewers as Record<string, unknown>[] | undefined) ?? []) {
    const ext = v.extensions;
    if (!Array.isArray(ext) || ext.length === 0 || !ext.every((e) => typeof e === "string" && bare(e) !== "")) {
      throw new Error(`fileViewers の ${String(v.id)} の extensions は、拡張子（"png" など）の配列にしてください。`);
    }
  }
  if (d.settings !== undefined && typeof d.settings !== "function") throw new Error("settings は部品にしてください。");
  if (d.sessionList !== undefined) {
    const l = d.sessionList;
    if (!isRecord(l) || typeof l.useCategories !== "function") throw new Error("sessionList には、関数 useCategories を書いてください。");
    if (l.hideSessionTabs !== undefined && typeof l.hideSessionTabs !== "boolean") throw new Error("sessionList の hideSessionTabs は true か false にしてください。");
  }
  const groupings = checkWorktreeGroupings(d.worktreeGroupings);
  if (groupings) throw new Error(groupings);
  return d as PluginDefinition;
}

/** Whether a file viewer (P20) shows the file at `path`. */
export function viewerShows(viewer: FileViewer, path: string): boolean {
  const p = path.toLowerCase();
  return viewer.extensions.some((e) => p.endsWith(`.${bare(e)}`));
}
