// The sidebar's sessions in a plugin's categories (docs/plugins.md, P17). The plugin's hook runs once, out of sight
// (PluginSessionListProbe, beside the sidebar badges' probes), in the plugin's scope and error boundary; what it answers
// is checked (lib/session-list) and published here, and the sidebar draws that, outside the boundary: an error of the
// plugin's brings Gasho's list of worktrees back, and one of Gasho's is not taken for the plugin's.
import { Suspense, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { SessionListContext } from "@gasho/plugin-sdk";
import { countChange, MAX_CHANGES, normalizeCategories, sessionListMode, type PublishedList, type SessionListMode } from "@/lib/session-list";
import { rememberList, useRememberedList } from "@/lib/session-list-prefs";
import { useAppState } from "@/lib/store";
import { Part } from "./parts";
import { usePluginRegistry, type PluginPart } from "./registry";

let published: PublishedList | undefined;
const listeners = new Set<() => void>();

function publish(next: PublishedList | undefined): void {
  if (published === next) return;
  published = next;
  for (const l of listeners) l();
}

/** Takes back what a version of a plugin published, unless another has published since. */
function unpublish(plugin: string, version: string): void {
  if (published?.plugin === plugin && published.version === version) publish(undefined);
}

function usePublished(): PublishedList | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => published,
  );
}

/** Which list the sidebar shows, and whether the tabs above a session leave out its worktree's sessions. */
export function useSessionListMode(): SessionListMode {
  const { infos, parts, errors } = usePluginRegistry();
  const { synced } = useAppState();
  const list = usePublished();
  const remembered = useRememberedList();
  return sessionListMode(
    {
      known: synced,
      infos: infos.map((i) => ({ id: i.id, enabled: i.enabled, hash: i.hash, web: i.web, name: i.manifest.name })),
      parts: parts.map((p) => ({ id: p.info.id, version: p.version, hasList: p.def.sessionList !== undefined, hideTabs: p.def.sessionList?.hideSessionTabs === true })),
      errors,
    },
    list,
    remembered,
  );
}

/**
 * Runs the hook of the first plugin that defines a session list, with `ctx` (App makes it from the sessions). Also
 * keeps which plugin's list was shown, so that the next page waits for it (session-list-prefs).
 */
export function PluginSessionListProbe({ ctx }: { ctx: SessionListContext }) {
  const { parts } = usePluginRegistry();
  const part = parts.find((p) => p.def.sessionList);
  const mode = useSessionListMode();
  const shown = mode.kind === "plugin" ? mode.plugin : undefined;
  const hideTabs = mode.kind === "plugin" && mode.hideTabs;
  const forget = mode.kind === "gasho" && mode.forget;
  useEffect(() => {
    if (shown) rememberList({ plugin: shown, hideTabs });
    else if (forget) rememberList(undefined);
  }, [shown, hideTabs, forget]);
  if (!part) return null;
  return (
    <Part part={part} bare fallback={<Failed part={part} />}>
      {/* A hook that suspends waits here, not in a boundary of Gasho's (there is none: the page would go blank). */}
      <Suspense fallback={null}>
        <Probe part={part} ctx={ctx} />
      </Suspense>
    </Part>
  );
}

function Probe({ part, ctx }: { part: PluginPart; ctx: SessionListContext }) {
  const list = part.def.sessionList!;
  const categories = normalizeCategories(list.useCategories(ctx), ctx);
  const json = JSON.stringify(categories);
  const plugin = part.info.id;
  const version = part.version;
  const hideTabs = list.hideSessionTabs === true;
  // When the answer changed last: a hook that answers anew each time it is called would publish without end.
  const changes = useRef<number[]>([]);
  useLayoutEffect(() => {
    const now = published;
    if (now && !("failed" in now) && now.plugin === plugin && now.version === version && now.json === json && now.hideTabs === hideTabs) return;
    const counted = countChange(changes.current, performance.now());
    changes.current = counted.times;
    if (counted.tooMany) {
      throw new Error(`サイドバーのセッションの一覧が、1秒に${MAX_CHANGES}回より多く変わりました。useCategories が、同じセッションに違う答えを返しています。`);
    }
    publish({ plugin, version, hideTabs, categories, json });
  });
  // Disabled, removed, or replaced by another version: its list goes with it.
  useLayoutEffect(() => () => unpublish(plugin, version), [plugin, version]);
  return null;
}

/** The plugin's hook threw (the boundary tells the plugins screen why): the sidebar goes back to the worktrees. */
function Failed({ part }: { part: PluginPart }) {
  const plugin = part.info.id;
  const version = part.version;
  useLayoutEffect(() => {
    publish({ plugin, version, failed: true });
    return () => unpublish(plugin, version);
  }, [plugin, version]);
  return null;
}
