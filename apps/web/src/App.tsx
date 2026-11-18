import { motion } from "framer-motion";
import { FolderGit2, Home, KeyRound, ListRestart, LoaderCircle, Plus, Puzzle, Settings, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { SessionListWorktree } from "@gasho/plugin-sdk";
import { GasshoOverlay } from "@/components/gassho";
import { ResizeHandle } from "@/components/resize-handle";
import { SessionHeaderToggle } from "@/components/session-header-toggle";
import { PanelBarContext } from "@/components/side-panel";
import { RegisterRepos, RepoFilter } from "@/components/repo-filter";
import { ReposDialog } from "@/components/repos-dialog";
import { SessionActionDialog, SessionContextMenu, type SessionActionRequest } from "@/components/session-menu";
import { RemoveWorktreeDialog, WorktreeContextMenu } from "@/components/worktree-menu";
import { showNotice, useNotice } from "@/lib/notice";
import { LAUNCH_WAIT_MS } from "@/components/session-tabs";
import { StatusDot } from "@/components/status-badge";
import { Sidebar, SidebarTrigger, useSidebar, type SidebarGroup, type SidebarItem, type SidebarMove, type SidebarSection } from "@/components/ui/sidebar";
import { updateTo } from "@/lib/daemon-update";
import { hubUpdateToTell } from "@/lib/server-update";
import { useChoices } from "@/lib/flag";
import { sessionLabel } from "@/lib/format";
import { prepareClap } from "@/lib/clap";
import { TAPS, countTap, type GasshoFrom, type Taps } from "@/lib/gassho";
import { DESKTOP, useMediaQuery, useWindowWidth } from "@/lib/media";
import { arrangeSessions, rememberSessions, reorderShown, useSavedOrder } from "@/lib/order";
import { updateCount } from "@/lib/plugin-catalog";
import { go, isOldGitHubLink, pageOf, useRoute, type SessionPanel } from "@/lib/route";
import { rememberWorktrees, useRememberedWorktrees } from "@/lib/remembered-worktrees";
import {
  arrangeCategories,
  hasOrder,
  holdOrder,
  OTHER_CATEGORY,
  rowAfterRemoval,
  sessionKey,
  sessionListContext,
  shownSessions,
  withCategoryOrder,
  withFolded,
  withoutOrder,
  withSessionOrder,
  type HeldOrder,
  type ListedSession,
} from "@/lib/session-list";
import { useGroupingPrefs, useSessionListPrefs } from "@/lib/session-list-prefs";
import {
  movedSession,
  narrowWorktrees,
  notificationShown,
  rememberedOf,
  repoChoices,
  sessionDot,
  sessionToOpen,
  unreadSessions,
  worktreeDot,
  worktreeId,
  worktreeKey,
  worktreesByLastUse,
  type WorktreeSessions,
} from "@/lib/sessions";
import { reloadToNewBuild, sendCommand, useAppState, useReadWhileOpen } from "@/lib/store";
import { cn } from "@/lib/utils";
import {
  arrangeWorktreeCategories,
  groupingKey,
  holdWorktreeList,
  moveHeldWorktree,
  withMoves,
  worktreeListContext,
  type HeldWorktreeList,
  type PendingMove,
} from "@/lib/worktree-groupings";
import { PANEL_WIDTH_MAX, PANEL_WIDTH_MIN, clampPanelWidth, defaultPanelWidth, panelOverlays, usePanelWidth } from "@/lib/widths";
import { PluginBadgeProbes, PluginPagePanelView, PluginPageView, PluginPanelView, usePluginBadges } from "@/plugins/parts";
import { usePluginRegistry } from "@/plugins/registry";
import { PluginSessionListProbe, useSessionListMode } from "@/plugins/session-list";
import { PluginWorktreeGroupingProbe, useWorktreeGroupings } from "@/plugins/worktree-groupings";
import { DevicesView } from "@/views/devices";
import { FilePanel, FolderPanel } from "@/views/files";
import { GraphPanel } from "@/views/graph";
import { HomeView } from "@/views/home";
import { LaunchDialog, type LaunchInitial } from "@/views/launch";
import { PairView } from "@/views/pair";
import { PluginsView } from "@/views/plugins";
import { SessionState, SessionView } from "@/views/session";
import { SettingsView } from "@/views/settings";
import { WorktreeView } from "@/views/worktree";

/** Where this browser keeps the order the sidebar's worktrees were dragged into, and the repositories they are narrowed to. */
const WORKTREE_ORDER_KEY = "gasho.worktreeOrder";
const WORKTREE_REPO_KEY = "gasho.worktreeRepo";

/** How long the list tells that a row could not be moved to another category of a grouping (ms). */
const MOVE_ERROR_MS = 10_000;

/** Gasho's logo: 🙏 (合掌, gasshō). The collapsed sidebar shows the logo alone. */
export const LOGO = "🙏";

/** Gasho's site, served by Nakamaba from `nakamaba/`. */
const SITE_URL = "https://d15rkbm4ghff09.cloudfront.net/gasho/";

/**
 * The logo, lined up with the items' icons. Hidden in it: tapped TAPS times, one to three seconds apart, it starts the
 * easter egg that opens Gasho's site (components/gassho.tsx), and its 🙏 is away in the middle of the screen meanwhile.
 */
function Brand({ away, onGassho }: { away: boolean; onGassho: (from: GasshoFrom) => void }) {
  const { collapsed } = useSidebar();
  const glyph = useRef<HTMLSpanElement>(null);
  const taps = useRef<Taps | undefined>(undefined);
  return (
    <div
      onClick={(e) => {
        const el = glyph.current;
        if (away || !el) return;
        taps.current = countTap(taps.current, e.timeStamp);
        if (taps.current.count < TAPS) return;
        taps.current = undefined;
        // From the tap, so that the clap can be heard later (lib/clap.ts).
        prepareClap();
        const box = el.getBoundingClientRect();
        onGassho({ x: box.left + box.width / 2, y: box.top + box.height / 2, size: Number.parseFloat(getComputedStyle(el).fontSize) });
      }}
      className="flex h-9 w-full cursor-default select-none items-center gap-2 px-2.5 text-base font-semibold tracking-tight"
    >
      <span ref={glyph} aria-hidden className={cn("grid size-5 shrink-0 place-items-center font-emoji text-lg leading-none", away && "opacity-0")}>
        {LOGO}
      </span>
      {!collapsed && <span>Gasho</span>}
    </div>
  );
}

/**
 * A panel of a session beside it on a computer, its left edge dragged to change its width (lib/widths). Where the
 * conversation would be too narrow to be read beside it, it goes over the conversation, at the right.
 */
function DockedPanel({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [savedWidth, setSavedWidth] = usePanelWidth();
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const windowWidth = useWindowWidth();
  // What the conversation and the panel share (the window but the sidebar), followed as the sidebar's width changes.
  const [room, setRoom] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const row = ref.current?.parentElement;
    if (!row) return;
    const observer = new ResizeObserver(() => setRoom(row.clientWidth));
    observer.observe(row);
    setRoom(row.clientWidth);
    return () => observer.disconnect();
  }, []);
  const clampWidth = (w: number) => clampPanelWidth(w, room);
  const width = clampWidth(dragWidth ?? savedWidth ?? defaultPanelWidth(windowWidth));
  return (
    <aside
      ref={ref}
      style={{ width }}
      className={cn("shrink-0 border-l border-border bg-background", panelOverlays(room) ? "absolute inset-y-0 right-0 z-30 shadow-2xl shadow-black/50" : "relative")}
    >
      {children}
      <ResizeHandle
        edge="left"
        label="パネルの幅"
        width={width}
        min={PANEL_WIDTH_MIN}
        max={clampWidth(PANEL_WIDTH_MAX)}
        clamp={clampWidth}
        onDrag={setDragWidth}
        onChange={setSavedWidth}
        onReset={() => setSavedWidth(null)}
      />
    </aside>
  );
}

/** A panel of a session (see SidePanel): beside it on a computer (`docked`), in its place on a phone. */
function PanelView({ machine, sessionId, panel, docked }: { machine: string; sessionId: string; panel: SessionPanel; docked: boolean }) {
  // Back to the session, replacing the panel in the history.
  const close = () => go({ name: "session", machine, sessionId }, { replace: true });
  if (panel.kind === "plugin") return <PluginPanelView machine={machine} sessionId={sessionId} panel={panel} docked={docked} onClose={close} />;
  if (panel.kind === "graph") return <GraphPanel machine={machine} sessionId={sessionId} repo={panel.repo} docked={docked} onClose={close} />;
  // A folder or a file starts afresh when another one opens.
  if (panel.kind === "files") {
    const path = panel.path ?? "";
    return <FolderPanel key={path} machine={machine} sessionId={sessionId} path={path} docked={docked} onClose={close} />;
  }
  const path = panel.path ?? "";
  return <FilePanel key={path} machine={machine} sessionId={sessionId} path={path} docked={docked} onClose={close} />;
}

function Connection({ connected, deviceName }: { connected: boolean; deviceName?: string }) {
  const { collapsed } = useSidebar();
  return (
    <div
      className="flex items-center gap-2 px-2.5 text-xs text-muted-foreground"
      title={connected ? "Gasho サーバーに接続中" : "Gasho サーバーに再接続しています"}
    >
      <span className={cn("size-2 shrink-0 rounded-full", connected ? "bg-emerald-500" : "bg-red-500")} />
      {!collapsed && (
        <span className="truncate">
          {connected ? "接続中" : "再接続中…"}
          {deviceName && ` · ${deviceName}`}
        </span>
      )}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh items-center justify-center bg-background p-4 text-sm text-muted-foreground">{children}</div>;
}

export function App() {
  const route = useRoute();
  // A link from before the GitHub plugin (…/issues, …/pull/<n>) opens the plugin's panel; the address bar gets its URL.
  useEffect(() => {
    if (isOldGitHubLink(location.hash)) go(route, { replace: true });
  }, [route]);
  // The pages scroll in `main`, which stays as they change: another page starts at its top. A layout effect, so that it
  // runs before the pages' own effects, which scroll to a section of theirs (#/devices/updates).
  const main = useRef<HTMLElement>(null);
  const page = pageOf(route);
  useLayoutEffect(() => {
    if (main.current) main.current.scrollTop = 0;
  }, [page]);
  const { auth, me, machines, notifications, connected, plugins, catalog, latest, server, outdated } = useAppState();
  // After /clear, the session goes on under a new id: its page (and the panel open beside it) goes there too.
  const movedTo = route.name === "session" ? movedSession(machines.find((m) => m.id === route.machine), route.sessionId)?.sessionId : undefined;
  useEffect(() => {
    if (movedTo && route.name === "session") go({ ...route, sessionId: movedTo }, { replace: true });
  }, [route, movedTo]);
  const [mobileOpen, setMobileOpen] = useState(false);
  // The logo's easter egg while it is out (where the logo's 🙏 was when it started), drawn over everything.
  const [gassho, setGassho] = useState<GasshoFrom | null>(null);
  // What was picked from a session tab's menu (rename, fork, remove); its dialog is open meanwhile.
  const [sessionAction, setSessionAction] = useState<SessionActionRequest | null>(null);
  // The worktree whose row's menu picked "削除…"; its dialog is open meanwhile.
  const [removingWorktree, setRemovingWorktree] = useState<WorktreeSessions | null>(null);
  // What to tell once the screen it belonged to went away (a worktree removed with a warning).
  const notice = useNotice();
  // The dialog that starts a new session, opened from the "＋" of the sidebar's worktree list.
  const [launchOpen, setLaunchOpen] = useState(false);
  // The dialog that registers repositories, opened from the menu that narrows the sidebar's worktrees.
  const [reposOpen, setReposOpen] = useState(false);
  const [repoKeys, setRepoKeys] = useChoices(WORKTREE_REPO_KEY);
  // The order the sidebar's worktrees were dragged into (none: the one used last first), and the order held while the
  // pointer is over the list.
  const [worktreeOrder, setWorktreeOrder] = useSavedOrder(WORKTREE_ORDER_KEY);
  const [heldWorktreeOrder, setHeldWorktreeOrder] = useState<string[]>();
  const desktop = useMediaQuery(DESKTOP);
  // A panel takes a phone's screen: its heading goes into the top bar, in this place (see SidePanel).
  const [panelBar, setPanelBar] = useState<HTMLElement | null>(null);
  // The plugins' web parts (docs/plugins.md): their sidebar items and the badges their hooks give.
  const { parts } = usePluginRegistry();
  const badges = usePluginBadges();
  // Every worktree with sessions is kept, so that it stays in the sidebar once they are gone.
  const remembered = useRememberedWorktrees();
  const ownWorktrees = useMemo(() => worktreesByLastUse(machines), [machines]);
  useEffect(() => rememberWorktrees(ownWorktrees.flatMap((w) => (w.sessions.length > 0 ? [rememberedOf(w)] : []))), [ownWorktrees]);
  // A plugin's categories of the sessions, in place of the worktrees (docs/plugins.md, P17): what its hook gets, which
  // list shows, the order dragged into and the folded categories, and the order held while the pointer is over the list.
  const listContext = useMemo(() => sessionListContext(ownWorktrees, machines), [ownWorktrees, machines]);
  const listMode = useSessionListMode();
  const [listPrefs, changeListPrefs] = useSessionListPrefs(listMode.kind === "gasho" ? undefined : listMode.plugin);
  const [heldOrder, setHeldOrder] = useState<HeldOrder | null>(null);
  // The worktrees the sidebar lists, with those only this browser keeps (the one used last first), and the repositories
  // they are narrowed to (one picked may come back: its working server reconnects, say).
  const allWorktrees = useMemo(() => worktreesByLastUse(machines, remembered), [machines, remembered]);
  const repos = useMemo(() => repoChoices(allWorktrees), [allWorktrees]);
  const narrowed = useMemo(() => repos.filter((r) => repoKeys.includes(r.key)), [repos, repoKeys]);
  // A plugin's grouping of the worktrees (docs/plugins.md, P18): what its hook gets (those narrowed to, in the order of
  // last use, not the one dragged into), which list shows, the grouping's order dragged into and its folded categories,
  // and what is held while the pointer is over the list.
  const groupingContext = useMemo(() => worktreeListContext(narrowWorktrees(allWorktrees, narrowed), machines), [allWorktrees, narrowed, machines]);
  const groupings = useWorktreeGroupings();
  const shownGrouping = groupings.mode.kind === "flat" ? undefined : groupingKey(groupings.mode.plugin, groupings.mode.grouping);
  const [groupingPrefs, changeGroupingPrefs] = useGroupingPrefs(shownGrouping);
  const [heldWorktrees, setHeldWorktrees] = useState<HeldWorktreeList | null>(null);
  // Rows dropped in another category, until the plugin's function for that settles, and why the last one failed.
  const [moves, setMoves] = useState<PendingMove[]>([]);
  const [moveError, setMoveError] = useState<string>();
  useEffect(() => {
    if (!moveError) return;
    const t = setTimeout(() => setMoveError(undefined), MOVE_ERROR_MS);
    return () => clearTimeout(t);
  }, [moveError]);
  // The drawer is a phone's: once the window is wide, it is hidden, so it is closed, and the list it held is let go
  // (else the list would stay held while the pointer comes and goes on a computer).
  useEffect(() => {
    if (!desktop) return;
    setMobileOpen(false);
    setHeldOrder(null);
    setHeldWorktrees(null);
    setHeldWorktreeOrder(undefined);
  }, [desktop]);
  // The category whose "＋" is starting a session, and what the dialog opens with when that did not work.
  const [launchingIn, setLaunchingIn] = useState<string>();
  const [launchInitial, setLaunchInitial] = useState<LaunchInitial>();
  useReadWhileOpen(route.name === "session" ? route.machine : undefined, route.name === "session" ? route.sessionId : undefined);

  if (auth === "checking") return <Centered>読み込み中…</Centered>;
  if (auth === "unreachable") return <Centered>Gasho サーバーにつながりません。再試行しています…</Centered>;
  if (auth === "unregistered") return <PairView />;

  const unread = notifications.filter((n) => !n.read && notificationShown(n, machines)).length;
  const unreadOnes = unreadSessions(notifications);
  // The worktrees of all working servers in one list: the one used last first, then those without sessions, or as held,
  // then in the order they were dragged into (worktrees that got their first session since then come first).
  const byId = new Map(allWorktrees.map((w) => [w.id, w]));
  const worktrees = arrangeSessions(arrangeSessions([...byId.keys()], heldWorktreeOrder), worktreeOrder).flatMap((id) => byId.get(id) ?? []);
  // Narrowed to the repositories picked.
  const listed = narrowWorktrees(worktrees, narrowed);
  const openSession =
    route.name === "session" ? machines.find((m) => m.id === route.machine)?.sessions.find((s) => s.sessionId === route.sessionId) : undefined;
  // The worktree whose row is the open one (a folded category of a grouping still shows it).
  const openWorktree =
    route.name === "session"
      ? openSession
        ? worktreeId(route.machine, openSession)
        : undefined
      : route.name === "worktree"
        ? worktreeKey(route.machine, route.path)
        : undefined;
  // The plugins' sidebar items: between ホーム and 端末, in the plugins' order. Each opens a page of its plugin.
  const pluginItems = parts.flatMap(({ info, def }) =>
    (def.sidebar ?? []).map((item) => {
      const Icon = item.icon;
      const id = `plugin:${info.id}:${item.id}`;
      return { id, label: item.label, icon: <Icon />, badge: badges.get(id), plugin: info.id, page: item.page };
    }),
  );
  const openLaunch = (initial?: LaunchInitial) => {
    setLaunchInitial(initial);
    setLaunchOpen(true);
  };

  // The plugin's categories, in the order dragged into (or held), each with its sessions as rows.
  const categories = listMode.kind === "plugin" ? arrangeCategories(listMode.categories, listPrefs, heldOrder) : [];
  // The grouping's categories of the worktrees, in the order dragged into, or as held.
  const worktreeCategories =
    groupings.mode.kind === "grouped"
      ? arrangeWorktreeCategories(
          withMoves(groupings.mode.categories, moves, shownGrouping),
          groupingPrefs,
          heldWorktrees?.grouping === shownGrouping ? heldWorktrees : null,
        )
      : [];
  // While the pointer is over the list (on a phone, while the drawer is open), the order shown stays: the time a
  // session was last used changes as Claude works, and its row would move away from under the pointer. A grouping's
  // worktrees also stay in the categories they showed in: their state, and with it their category, changes as Claude
  // works. What shows while waiting for the categories is not held.
  const holdList = (on: boolean) => {
    setHeldWorktreeOrder(on ? worktrees.map((w) => w.id) : undefined);
    setHeldOrder(on ? holdOrder(categories) : null);
    setHeldWorktrees(on && shownGrouping && groupings.mode.kind === "grouped" ? holdWorktreeList(shownGrouping, worktreeCategories) : null);
  };
  const openKey = route.name === "session" ? sessionKey(route.machine, route.sessionId) : undefined;
  const shownByKey = new Map(machines.flatMap((m) => m.sessions.filter((s) => s.managed).map((s) => [sessionKey(m.id, s.sessionId), { m, s }] as const)));
  const listWorktrees = new Map(listContext.worktrees.map((w) => [w.key, w]));
  const folded = new Set(listPrefs.folded ?? []);
  // "＋" of a category: a session in its worktree's folder, at once (as the "＋" after a worktree's tabs). When it does
  // not start (Claude Code asks whether to trust the folder, say), "新しいセッション" opens for that folder and tells why.
  const launchIn = async (w: SessionListWorktree) => {
    if (launchingIn) return;
    setLaunchingIn(w.key);
    const r = await sendCommand(w.machine.id, { type: "session.launch", cwd: w.path }, LAUNCH_WAIT_MS);
    setLaunchingIn(undefined);
    if (r.ok && r.sessionId) {
      setMobileOpen(false);
      go({ name: "session", machine: w.machine.id, sessionId: r.sessionId });
      return;
    }
    openLaunch({ machine: w.machine.id, folder: w.path, ...(r.needsTrust ? { trust: r.trustWarnings ?? [] } : { error: r.error ?? "起動できませんでした。" }) });
  };
  // A session's row, as the sidebar's list of sessions had them: its state, its name, waiting or offline, the work it
  // runs in the background, and its menu (rename, fork, remove).
  const sessionRow = (row: ListedSession): SidebarItem[] => {
    const found = shownByKey.get(row.key);
    if (!found) return [];
    const { m, s } = found;
    const background = m.connected ? (s.background?.length ?? 0) : 0;
    return [
      {
        id: row.key,
        label: sessionLabel(s),
        description: row.description,
        icon: <StatusDot {...sessionDot(m, s, unreadOnes)} />,
        badge: !m.connected ? "オフライン" : s.status === "waiting" ? "確認" : undefined,
        mark: background ? (
          <LoaderCircle role="img" aria-label={`バックグラウンドで ${background} 件実行中`} className="size-3 animate-spin text-sky-400 motion-reduce:animate-none">
            <title>{`バックグラウンドで ${background} 件実行中`}</title>
          </LoaderCircle>
        ) : undefined,
        wrap: (button: ReactElement) => (
          <SessionContextMenu machine={m} session={s} onPick={setSessionAction}>
            {button}
          </SessionContextMenu>
        ),
      },
    ];
  };
  const groups: SidebarGroup[] = categories.map((c) => {
    const isFolded = folded.has(c.id);
    const waiting = c.sessions.filter((row) => {
      const found = shownByKey.get(row.key);
      return found?.m.connected && found.s.status === "waiting";
    }).length;
    const target = c.launch ? listWorktrees.get(c.launch) : undefined;
    const canLaunch = target !== undefined && target.machine.connected && target.machine.canLaunch === true;
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      hint: c.hint,
      // Folded, a category still tells that a session in it waits for an answer.
      badge: isFolded && waiting > 0 ? `確認 ${waiting}` : undefined,
      icon: <FolderGit2 />,
      action: canLaunch
        ? {
            label: `${c.title} で新しいセッションを起動`,
            icon: launchingIn === target.key ? <LoaderCircle className="animate-spin" /> : <Plus />,
            onClick: () => void launchIn(target),
          }
        : undefined,
      folded: isFolded,
      onFoldedChange: (f) => changeListPrefs((p) => withFolded(p, c.id, f)),
      // Folded, only the open session's row shows (where the person is).
      items: shownSessions(c, isFolded, openKey).flatMap(sessionRow),
      sort: isFolded ? undefined : { onReorder: (keys) => changeListPrefs((p) => withSessionOrder(p, c.id, keys, categories.map((x) => x.id))) },
    };
  });

  // A worktree's row, in Gasho's list and in a grouping's categories: its state (a bell in its place while a session
  // has a notification not read), its name, the line under it (its repository, and its working server when there are
  // several, unless the grouping gave another or none), and whether it waits for an answer or is offline.
  const worktreeRow = (w: WorktreeSessions, line?: string): SidebarItem => ({
    id: w.id,
    label: w.label,
    description: line === undefined ? [w.repo, machines.length > 1 ? w.machine.name : undefined].filter(Boolean).join(" · ") || undefined : line || undefined,
    icon: <StatusDot {...worktreeDot(w, unreadOnes)} />,
    badge: !w.machine.connected ? "オフライン" : w.sessions.some((s) => s.status === "waiting") ? "確認" : undefined,
    wrap: (button: ReactElement) => (
      <WorktreeContextMenu worktree={w} onPick={setRemovingWorktree}>
        {button}
      </WorktreeContextMenu>
    ),
  });
  const groupingWorktrees = new Map(groupingContext.worktrees.map((w) => [w.key, w]));
  const groupingFolded = new Set(groupingPrefs.folded ?? []);
  const worktreeGroups: SidebarGroup[] = worktreeCategories.map((c) => {
    const isFolded = groupingFolded.has(c.id);
    const rows = c.worktrees.flatMap((item) => {
      const w = byId.get(item.key);
      return w ? [{ item, w }] : [];
    });
    const waiting = rows.filter(({ w }) => w.machine.connected && w.sessions.some((s) => s.status === "waiting")).length;
    const target = c.launch ? groupingWorktrees.get(c.launch) : undefined;
    const canLaunch = target !== undefined && target.machine.connected && target.machine.canLaunch === true;
    return {
      id: c.id,
      title: c.title,
      description: c.description,
      hint: c.hint,
      // Folded, a category still tells that a worktree in it waits for an answer.
      badge: isFolded && waiting > 0 ? `確認 ${waiting}` : undefined,
      icon: <FolderGit2 />,
      action: canLaunch
        ? {
            label: `${c.title} で新しいセッションを起動`,
            icon: launchingIn === target.key ? <LoaderCircle className="animate-spin" /> : <Plus />,
            onClick: () => void launchIn(target),
          }
        : undefined,
      folded: isFolded,
      onFoldedChange: (f) => changeGroupingPrefs((p) => withFolded(p, c.id, f)),
      // Folded, only the open worktree's row shows (where the person is).
      items: rows.filter(({ w }) => !isFolded || w.id === openWorktree).map(({ item, w }) => worktreeRow(w, item.description)),
      sort: isFolded
        ? undefined
        : { onReorder: (keys) => changeGroupingPrefs((p) => withSessionOrder(p, c.id, keys, worktreeCategories.map((x) => x.id))) },
    };
  });
  // A row dropped in another category of a grouping with useOnMove: it shows there at once, where it was dropped, until
  // the plugin's function settles; then the plugin's categories decide (while the list is held, from when the pointer
  // leaves it). When the function fails, the row goes back and the list tells why for a while.
  const moveRow = (m: SidebarMove) => {
    const move = groupings.move;
    if (!move || !shownGrouping) return;
    const grouping = shownGrouping;
    const index = m.ids.indexOf(m.id);
    const back = worktreeCategories.find((c) => c.id === m.from)?.worktrees.findIndex((w) => w.key === m.id) ?? 0;
    const pending: PendingMove = { grouping, worktree: m.id, to: m.to };
    changeGroupingPrefs((p) => withSessionOrder(p, m.to, m.ids, worktreeCategories.map((x) => x.id)));
    setMoves((prev) => [...prev.filter((x) => x.grouping !== grouping || x.worktree !== m.id), pending]);
    setHeldWorktrees((h) => (h?.grouping === grouping ? moveHeldWorktree(h, m.id, m.to, index) : h));
    setMoveError(undefined);
    const settled = () => setMoves((prev) => prev.filter((x) => x !== pending));
    const plugins = (id: string) => (id === OTHER_CATEGORY ? null : id);
    const label = byId.get(m.id)?.label ?? m.id;
    move({ worktree: m.id, from: plugins(m.from), to: plugins(m.to), index }).then(settled, (e: unknown) => {
      settled();
      setHeldWorktrees((h) => (h?.grouping === grouping ? moveHeldWorktree(h, m.id, m.from, back) : h));
      setMoveError(`「${label}」を移せませんでした（${e instanceof Error ? e.message : String(e)}）。`);
    });
  };
  // A grouping's categories show in place of the rows (none yet while waiting for them); the order dragged into and
  // "最後に使った順に戻す" are then the grouping's.
  const grouped = groupings.mode.kind !== "flat";
  const notices = [
    listMode.kind === "gasho" && listMode.failed ? `${listMode.failed} の一覧を出せないので、worktree を並べています（理由はプラグインの画面に）。` : undefined,
    groupings.mode.kind === "flat" && groupings.mode.failed
      ? `${groupings.mode.failed} の分け方を使えないので、worktree を分けずに並べています（理由はプラグインの画面に）。`
      : undefined,
    groupings.mode.kind === "grouped" ? moveError : undefined,
  ].filter(Boolean);
  const worktreeSection: SidebarSection = {
    // Shown even without worktrees, for its menu that registers the repositories. No "＋": the rows are worktrees, and
    // a "＋" there reads as adding one. A session starts from a worktree's tabs, or from "新しいセッション" at home.
    title: narrowed.length > 0 ? `worktree · ${narrowed.map((r) => r.name).join("、")}` : "worktree",
    notice: notices.length > 0 ? notices.join(" ") : undefined,
    secondaryAction: grouped
      ? hasOrder(groupingPrefs)
        ? { label: "最後に使った順に戻す", icon: <ListRestart />, onClick: () => changeGroupingPrefs(withoutOrder) }
        : undefined
      : worktreeOrder
        ? {
            label: "最後に使った順に戻す",
            icon: <ListRestart />,
            onClick: () => {
              setWorktreeOrder(undefined);
              // Held, the list would keep the order dragged into until the pointer leaves it.
              setHeldWorktreeOrder((held) => held && allWorktrees.map((w) => w.id));
            },
          }
        : undefined,
    tools: (
      <RepoFilter
        choices={repos}
        picked={narrowed}
        onPick={setRepoKeys}
        onRegister={() => setReposOpen(true)}
        machineNames={machines.length > 1}
        groupings={groupings.options}
        grouping={groupings.picked}
        onGroup={groupings.pick}
      />
    ),
    sort: grouped
      ? undefined
      : {
          onReorder: (ids) => setWorktreeOrder(rememberSessions(reorderShown(worktrees.map((w) => w.id), ids), worktreeOrder)),
        },
    items: grouped ? [] : listed.map((w) => worktreeRow(w)),
    groups: grouped ? worktreeGroups : undefined,
    groupSort: grouped ? { onReorder: (ids) => changeGroupingPrefs((p) => withCategoryOrder(p, ids)) } : undefined,
    itemMove: grouped && groupings.move ? moveRow : undefined,
  };
  // The plugin's categories (none yet while waiting for it). The repositories need no narrowing there; registering
  // them stays.
  const categorySection: SidebarSection = {
    title: "セッション",
    action: { label: "新しいセッション", icon: <Plus />, onClick: () => openLaunch() },
    secondaryAction: hasOrder(listPrefs)
      ? { label: "最後に使った順に戻す", icon: <ListRestart />, onClick: () => changeListPrefs(withoutOrder) }
      : undefined,
    tools: <RegisterRepos onRegister={() => setReposOpen(true)} />,
    items: [],
    groups,
    groupSort: { onReorder: (ids) => changeListPrefs((p) => withCategoryOrder(p, ids)) },
  };
  const sections: SidebarSection[] = [
    {
      items: [
        { id: "home", label: "ホーム", icon: <Home />, badge: unread || undefined },
        ...pluginItems.map(({ id, label, icon, badge }) => ({ id, label, icon, badge })),
        {
          id: "devices",
          label: "端末",
          icon: <KeyRound />,
          // gasho-daemon on a working server, or the Gasho server itself, can be updated.
          badge: machines.some((m) => updateTo(m, latest)) || hubUpdateToTell(server, latest) ? "更新" : undefined,
        },
        // The plugins that the catalog has a newer version of.
        { id: "plugins", label: "プラグイン", icon: <Puzzle />, badge: updateCount(plugins, catalog) || undefined },
        { id: "settings", label: "設定", icon: <Settings /> },
      ],
    },
    listMode.kind === "gasho" ? worktreeSection : categorySection,
  ];
  const activeId =
    route.name === "session"
      ? listMode.kind !== "gasho"
        ? sessionKey(route.machine, route.sessionId)
        : (openWorktree ?? "")
      : route.name === "worktree"
        ? worktreeKey(route.machine, route.path)
        : route.name === "plugin"
        ? (pluginItems.find((i) => i.plugin === route.plugin && i.page.id === route.page)?.id ?? "")
        : route.name;
  const panel = route.name === "session" ? route.panel : undefined;
  // A panel of a plugin's page (P19), shown as a session's panel is.
  const pagePanel = route.name === "plugin" ? route.panel : undefined;
  const closePagePanel = () => {
    if (route.name === "plugin") go({ name: "plugin", plugin: route.plugin, page: route.page, params: route.params }, { replace: true });
  };
  // The session on a phone's screen (not while one of its panels takes the screen): the top bar shows its name and
  // state, and its header leaves them out (see SessionView), so the two bars become one.
  const onScreen = route.name === "session" && !panel && openSession?.managed ? openSession : undefined;
  const onScreenMachine = onScreen && machines.find((m) => m.id === (route.name === "session" ? route.machine : ""));

  return (
    // On an iPhone, the screen's edges are kept clear of its notch and status bar (--safe-*, index.css): the sidebar
    // keeps its own side, this the right and, below the sidebar's width, the left.
    <div className="flex h-dvh overflow-hidden bg-background pr-(--safe-right) pl-(--safe-left) text-foreground md:pl-0">
      <Sidebar
        sections={sections}
        activeId={activeId}
        onActiveChange={(id) => {
          if (id === "home" || id === "devices" || id === "settings" || id === "plugins") return go({ name: id });
          const item = pluginItems.find((i) => i.id === id);
          if (item) return go({ name: "plugin", plugin: item.plugin, page: item.page.id, params: item.page.params ?? {} });
          // A session's row of the plugin's categories.
          const row = listMode.kind !== "gasho" ? shownByKey.get(id) : undefined;
          if (row) return go({ name: "session", machine: row.m.id, sessionId: row.s.sessionId });
          const w = worktrees.find((x) => x.id === id);
          if (!w) return;
          const s = sessionToOpen(w);
          go(s ? { name: "session", machine: w.machine.id, sessionId: s.sessionId } : { name: "worktree", machine: w.machine.id, path: w.path });
        }}
        mobileOpen={mobileOpen}
        onMobileOpenChange={(open) => {
          setMobileOpen(open);
          holdList(open);
        }}
        onPointerInside={(inside) => {
          if (inside || !mobileOpen) holdList(inside);
        }}
        header={<Brand away={gassho !== null} onGassho={setGassho} />}
        footer={<Connection connected={connected} deviceName={me?.name} />}
      />
      <div className="flex min-w-0 flex-1 flex-col pt-(--safe-top)">
        {/* The Gasho server serves a new build of the screen, and this page did not reload itself: something is being written in it. */}
        {outdated && (
          <div role="status" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs md:px-4">
            <span className="min-w-0 flex-1 text-amber-200">
              Gasho が新しいバージョンになりました。書きかけの文やファイルを送るか写してから、読み込み直してください（読み込み直すと、書きかけは消えます）。
            </span>
            <button type="button" onClick={reloadToNewBuild} className="shrink-0 rounded-md border border-amber-500/40 px-2.5 py-1 font-medium text-amber-100 hover:bg-amber-500/10">
              読み込み直す
            </button>
          </div>
        )}
        {notice && (
          <div role="status" className="flex shrink-0 items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs md:px-4">
            <span className="min-w-0 flex-1 text-amber-200">{notice}</span>
            <button type="button" onClick={() => showNotice(undefined)} aria-label="閉じる" className="grid size-6 shrink-0 place-items-center rounded-md text-amber-100 hover:bg-amber-500/10">
              <X className="size-3.5" />
            </button>
          </div>
        )}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
          <SidebarTrigger
            onClick={() => {
              setMobileOpen(true);
              holdList(true);
            }}
          />
          {!desktop && (panel || pagePanel) ? (
            <div ref={setPanelBar} className="flex min-w-0 flex-1 items-center gap-2" />
          ) : onScreen && onScreenMachine ? (
            <>
              <h1 className="min-w-0 truncate text-sm font-semibold">{sessionLabel(onScreen)}</h1>
              <SessionState machine={onScreenMachine} session={onScreen} />
            </>
          ) : (
            <span className="flex items-center gap-1.5 font-semibold">
              <span aria-hidden className="font-emoji">
                {LOGO}
              </span>
              Gasho
            </span>
          )}
          {/* The connection shows in the sidebar's footer; here only while it is down. */}
          {!connected && <span className="ml-auto shrink-0 text-xs text-red-400">再接続中…</span>}
          {onScreen && <SessionHeaderToggle className={cn("-mr-1", connected && "ml-auto")} />}
        </header>
        <div className="relative flex min-h-0 flex-1">
          {/* layoutScroll: the home screen's tiles slide to new places inside it, also while it scrolls. relative: an
              absolutely placed element with no placed parent of its own (an sr-only status line) is placed in here and
              scrolls with the screen. Otherwise it is placed on the page and makes the page longer than the window. */}
          <motion.main ref={main} layoutScroll className="relative min-h-0 min-w-0 flex-1 overflow-y-auto">
            {route.name === "home" && <HomeView />}
            {route.name === "devices" && <DevicesView />}
            {route.name === "settings" && <SettingsView />}
            {route.name === "plugins" && <PluginsView />}
            {/* The page stays where it is while its panel opens beside it, so it keeps its state and its scroll. */}
            {route.name === "plugin" && (desktop || !pagePanel) && <PluginPageView plugin={route.plugin} page={route.page} params={route.params} />}
            {route.name === "plugin" && !desktop && pagePanel && (
              <PanelBarContext.Provider value={panelBar}>
                <PluginPagePanelView plugin={route.plugin} panel={pagePanel} docked={false} onClose={closePagePanel} />
              </PanelBarContext.Provider>
            )}
            {route.name === "worktree" && (
              <WorktreeView
                key={worktreeKey(route.machine, route.path)}
                worktree={worktrees.find((w) => w.id === worktreeKey(route.machine, route.path))}
                view={route.view}
                onSessionAction={setSessionAction}
              />
            )}
            {route.name === "session" && (desktop || !panel) && (
              <SessionView
                key={`${route.machine}/${route.sessionId}`}
                machine={route.machine}
                sessionId={route.sessionId}
                panel={panel}
                onSessionAction={setSessionAction}
              />
            )}
            {route.name === "session" && !desktop && panel && (
              <PanelBarContext.Provider value={panelBar}>
                <PanelView machine={route.machine} sessionId={route.sessionId} panel={panel} docked={false} />
              </PanelBarContext.Provider>
            )}
          </motion.main>
          {route.name === "plugin" && desktop && pagePanel && (
            <DockedPanel>
              <PluginPagePanelView key={`${route.plugin}/${route.page}`} plugin={route.plugin} panel={pagePanel} docked onClose={closePagePanel} />
            </DockedPanel>
          )}
          {route.name === "session" && desktop && panel && (
            <DockedPanel>
              <PanelView machine={route.machine} sessionId={route.sessionId} panel={panel} docked />
            </DockedPanel>
          )}
        </div>
      </div>
      <PluginBadgeProbes />
      <PluginSessionListProbe ctx={listContext} />
      <PluginWorktreeGroupingProbe ctx={groupingContext} off={listMode.kind !== "gasho"} />
      <SessionActionDialog
        request={sessionAction}
        onClose={() => setSessionAction(null)}
        rowAfter={
          listMode.kind === "plugin"
            ? (machine, sessionId) => {
                const next = rowAfterRemoval(categories, sessionKey(machine, sessionId));
                return next && { machine: next.machine, sessionId: next.sessionId };
              }
            : undefined
        }
      />
      <RemoveWorktreeDialog worktree={removingWorktree} onClose={() => setRemovingWorktree(null)} />
      <LaunchDialog
        open={launchOpen}
        initial={launchInitial}
        onClose={() => {
          setLaunchOpen(false);
          setLaunchInitial(undefined);
        }}
        onLaunched={() => setMobileOpen(false)}
      />
      <ReposDialog open={reposOpen} onClose={() => setReposOpen(false)} />
      {/* Out of the sidebar: its events do not reach the drawer, and closing the drawer does not take it away. */}
      {gassho && <GasshoOverlay from={gassho} logo={LOGO} href={SITE_URL} onClose={() => setGassho(null)} />}
    </div>
  );
}
