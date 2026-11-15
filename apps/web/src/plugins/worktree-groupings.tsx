// The sidebar's worktrees in the categories of a plugin's grouping (docs/plugins.md, P18). The groupings of the loaded
// plugins are offered in the menu of the list, and the one picked is kept in this browser (lib/session-list-prefs).
// Its hook runs once, out of sight (PluginWorktreeGroupingProbe, beside P17's), in its plugin's scope and error
// boundary; what it answers is checked (lib/worktree-groupings) and published here, and the sidebar draws that, outside
// the boundary: an error of the plugin's brings Gasho's own list of worktrees back, and one of Gasho's is not taken for
// the plugin's.
import { Suspense, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { WorktreeGrouping, WorktreeListContext } from "@gasho/plugin-sdk";
import { countChange, MAX_CHANGES } from "@/lib/session-list";
import { chooseGrouping, useGroupingChoice } from "@/lib/session-list-prefs";
import { useAppState } from "@/lib/store";
import {
  effectiveChoice,
  groupingKey,
  groupingOptions,
  normalizeWorktreeCategories,
  worktreeListMode,
  type GroupingChoice,
  type GroupingOption,
  type PublishedGrouping,
  type WorktreeListMode,
} from "@/lib/worktree-groupings";
import { Part } from "./parts";
import { usePluginRegistry, type PluginPart } from "./registry";

let published: PublishedGrouping | undefined;
const listeners = new Set<() => void>();

function publish(next: PublishedGrouping | undefined): void {
  if (published === next) return;
  published = next;
  for (const l of listeners) l();
}

/** Takes back what a grouping of a version of a plugin published, unless another has published since. */
function unpublish(plugin: string, version: string, grouping: string): void {
  if (published?.plugin === plugin && published.version === version && published.grouping === grouping) publish(undefined);
}

function usePublished(): PublishedGrouping | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => published,
  );
}

/** The groupings offered (those of the loaded web parts), what was picked here, and the grouping to use. */
function useChoice(parts: PluginPart[]): { options: GroupingOption[]; stored: GroupingChoice | undefined; choice: GroupingChoice | undefined } {
  const stored = useGroupingChoice();
  const options = groupingOptions(
    parts.flatMap((p) => (p.def.worktreeGroupings?.length ? [{ id: p.info.id, name: p.info.manifest.name, groupings: p.def.worktreeGroupings }] : [])),
  );
  return { options, stored, choice: effectiveChoice(stored, options) };
}

export interface WorktreeGroupings {
  /** The groupings offered in the menu of the list. */
  options: GroupingOption[];
  /** The key of the grouping in use, which the menu checks; undefined: "分けない". */
  picked?: string;
  /** Picks the grouping with that key, or none (undefined). */
  pick: (key: string | undefined) => void;
  /** Which list of worktrees the sidebar shows. */
  mode: WorktreeListMode;
}

export function useWorktreeGroupings(): WorktreeGroupings {
  const { infos, parts, errors } = usePluginRegistry();
  const { synced } = useAppState();
  const list = usePublished();
  const { options, choice } = useChoice(parts);
  const mode = worktreeListMode(
    choice,
    {
      known: synced,
      infos: infos.map((i) => ({ id: i.id, enabled: i.enabled, hash: i.hash, web: i.web, name: i.manifest.name })),
      parts: parts.map((p) => ({ id: p.info.id, version: p.version, name: p.info.manifest.name, groupings: (p.def.worktreeGroupings ?? []).map((g) => g.id) })),
      errors,
    },
    list,
  );
  const picked = typeof choice === "object" ? options.find((o) => o.plugin === choice.plugin && o.grouping === choice.grouping)?.key : undefined;
  const pick = (key: string | undefined) => {
    const o = options.find((x) => x.key === key);
    chooseGrouping(o ? { plugin: o.plugin, grouping: o.grouping } : "none");
  };
  return { options, picked, pick, mode };
}

/**
 * Runs the hook of the grouping in use with `ctx` (App makes it from the worktrees it lists), unless `off`: the sidebar
 * shows P17's list of sessions instead. While nothing was ever picked here, the first grouping offered is kept as
 * picked, so that the next page waits for it rather than showing the worktrees ungrouped first.
 */
export function PluginWorktreeGroupingProbe({ ctx, off }: { ctx: WorktreeListContext; off: boolean }) {
  const { parts } = usePluginRegistry();
  const { stored, choice } = useChoice(parts);
  // effectiveChoice makes the choice anew each time: the effect goes by its parts.
  const first = stored === undefined && typeof choice === "object" ? choice : undefined;
  const firstPlugin = first?.plugin;
  const firstGrouping = first?.grouping;
  useEffect(() => {
    if (firstPlugin !== undefined && firstGrouping !== undefined) chooseGrouping({ plugin: firstPlugin, grouping: firstGrouping });
  }, [firstPlugin, firstGrouping]);
  if (off || typeof choice !== "object") return null;
  const part = parts.find((p) => p.info.id === choice.plugin);
  const grouping = part?.def.worktreeGroupings?.find((g) => g.id === choice.grouping);
  if (!part || !grouping) return null;
  return (
    // Another grouping starts afresh: its own hooks, and its own boundary (one that threw does not keep the next out).
    <Part key={groupingKey(part.info.id, grouping.id)} part={part} bare fallback={<Failed part={part} grouping={grouping.id} />}>
      {/* A hook that suspends waits here, not in a boundary of Gasho's (there is none: the page would go blank). */}
      <Suspense fallback={null}>
        <Probe part={part} grouping={grouping} ctx={ctx} />
      </Suspense>
    </Part>
  );
}

function Probe({ part, grouping, ctx }: { part: PluginPart; grouping: WorktreeGrouping; ctx: WorktreeListContext }) {
  const categories = normalizeWorktreeCategories(grouping.useCategories(ctx), ctx);
  const json = JSON.stringify(categories);
  const plugin = part.info.id;
  const version = part.version;
  const id = grouping.id;
  const label = grouping.label;
  // When the answer changed last: a hook that answers anew each time it is called would publish without end.
  const changes = useRef<number[]>([]);
  useLayoutEffect(() => {
    const now = published;
    if (now && !("failed" in now) && now.plugin === plugin && now.version === version && now.grouping === id && now.json === json) return;
    const counted = countChange(changes.current, performance.now());
    changes.current = counted.times;
    if (counted.tooMany) {
      throw new Error(`サイドバーの worktree の分け方「${label}」が、1秒に${MAX_CHANGES}回より多く変わりました。useCategories が、同じ worktree に違う答えを返しています。`);
    }
    publish({ plugin, version, grouping: id, categories, json });
  });
  // Another grouping picked, the plugin disabled, removed, or replaced by another version: its categories go with it.
  useLayoutEffect(() => () => unpublish(plugin, version, id), [plugin, version, id]);
  return null;
}

/** The grouping's hook threw (the boundary tells the plugins screen why): the sidebar goes back to Gasho's own list. */
function Failed({ part, grouping }: { part: PluginPart; grouping: string }) {
  const plugin = part.info.id;
  const version = part.version;
  useLayoutEffect(() => {
    publish({ plugin, version, grouping, failed: true });
    return () => unpublish(plugin, version, grouping);
  }, [plugin, version, grouping]);
  return null;
}
