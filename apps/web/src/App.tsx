import { motion } from "framer-motion";
import { FolderGit2, Home, KeyRound, ListRestart, LoaderCircle, Plus, Puzzle, Settings } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { SessionListWorktree } from "@gasho/plugin-sdk";
import type { SessionStatus } from "@gasho/protocol";
import { ResizeHandle } from "@/components/resize-handle";
import { SessionHeaderToggle } from "@/components/session-header-toggle";
import { RegisterRepos, RepoFilter } from "@/components/repo-filter";
import { ReposDialog } from "@/components/repos-dialog";
import { SessionActionDialog, SessionContextMenu, type SessionActionRequest } from "@/components/session-menu";
import { LAUNCH_WAIT_MS } from "@/components/session-tabs";
import { StatusDot } from "@/components/status-badge";
import { Sidebar, SidebarTrigger, useSidebar, type SidebarGroup, type SidebarItem, type SidebarSection } from "@/components/ui/sidebar";
import { updateTo } from "@/lib/daemon-update";
import { useChoice } from "@/lib/flag";
import { sessionLabel } from "@/lib/format";
import { DESKTOP, useMediaQuery, useWindowWidth } from "@/lib/media";
import { arrangeSessions, rememberSessions, reorderShown, useSavedOrder } from "@/lib/order";
import { updateCount } from "@/lib/plugin-catalog";
import { go, isOldGitHubLink, useRoute, type SessionPanel } from "@/lib/route";
import { rememberWorktrees, useRememberedWorktrees } from "@/lib/remembered-worktrees";
import {
  arrangeCategories,
  hasOrder,
  holdOrder,
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
import { useSessionListPrefs } from "@/lib/session-list-prefs";
import {
  notificationShown,
  rememberedOf,
  repoChoices,
  repoKeyOf,
  sessionToOpen,
  worktreeId,
  worktreeKey,
  worktreesByLastUse,
  type WorktreeSessions,
} from "@/lib/sessions";
import { sendCommand, useAppState } from "@/lib/store";
import { cn } from "@/lib/utils";
import { PANEL_WIDTH_MAX, PANEL_WIDTH_MIN, clampPanelWidth, defaultPanelWidth, usePanelWidth } from "@/lib/widths";
import { PluginBadgeProbes, PluginPageView, PluginPanelView, usePluginBadges } from "@/plugins/parts";
import { usePluginRegistry } from "@/plugins/registry";
import { PluginSessionListProbe, useSessionListMode } from "@/plugins/session-list";
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

/** Where this browser keeps the order the sidebar's worktrees were dragged into, and the repository they are narrowed to. */
const WORKTREE_ORDER_KEY = "gasho.worktreeOrder";
const WORKTREE_REPO_KEY = "gasho.worktreeRepo";

/** A worktree's status in the sidebar: that of its most pressing session. */
function worktreeStatus(w: WorktreeSessions): SessionStatus {
  if (!w.machine.connected) return "unknown";
  return (["waiting", "busy", "idle"] as const).find((st) => w.sessions.some((s) => s.status === st)) ?? "unknown";
}

/** Gasho's logo: 🙏 (合掌, gasshō). The collapsed sidebar shows the logo alone. */
export const LOGO = "🙏";

function Brand() {
  const { collapsed } = useSidebar();
  return (
    <div className="flex items-center gap-2 px-2.5 text-base font-semibold tracking-tight">
      <span aria-hidden className="font-emoji text-lg leading-none">
        {LOGO}
      </span>
      {!collapsed && <span>Gasho</span>}
    </div>
  );
}

/** A panel of a session beside it on a computer, its left edge dragged to change its width (lib/widths). */
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
    <aside ref={ref} style={{ width }} className="relative shrink-0 border-l border-border bg-background">
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
  const { auth, me, machines, notifications, connected, plugins, catalog, latest } = useAppState();
  const [mobileOpen, setMobileOpen] = useState(false);
  // What was picked from a session tab's menu (rename, fork, remove); its dialog is open meanwhile.
  const [sessionAction, setSessionAction] = useState<SessionActionRequest | null>(null);
  // The dialog that starts a new session, opened from the "＋" of the sidebar's worktree list.
  const [launchOpen, setLaunchOpen] = useState(false);
  // The dialog that registers repositories, opened from the menu that narrows the sidebar's worktrees.
  const [reposOpen, setReposOpen] = useState(false);
  const [repoKey, setRepoKey] = useChoice(WORKTREE_REPO_KEY);
  // The order the sidebar's worktrees were dragged into (none: the one used last first).
  const [worktreeOrder, setWorktreeOrder] = useSavedOrder(WORKTREE_ORDER_KEY);
  const desktop = useMediaQuery(DESKTOP);
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
  // The category whose "＋" is starting a session, and what the dialog opens with when that did not work.
  const [launchingIn, setLaunchingIn] = useState<string>();
  const [launchInitial, setLaunchInitial] = useState<LaunchInitial>();

  if (auth === "checking") return <Centered>読み込み中…</Centered>;
  if (auth === "unreachable") return <Centered>Gasho サーバーにつながりません。再試行しています…</Centered>;
  if (auth === "unregistered") return <PairView />;

  const unread = notifications.filter((n) => !n.read && notificationShown(n, machines)).length;
  // The worktrees of all working servers in one list: the one used last first, then those without sessions, or in the
  // order they were dragged into (worktrees that got their first session since then come first).
  const byId = new Map(worktreesByLastUse(machines, remembered).map((w) => [w.id, w]));
  const worktrees = arrangeSessions([...byId.keys()], worktreeOrder).flatMap((id) => byId.get(id) ?? []);
  // Narrowed to one repository, while it is in the list (it may come back: its working server reconnects, say).
  const repos = repoChoices(worktrees);
  const narrowed = repos.find((r) => r.key === repoKey);
  const listed = narrowed ? worktrees.filter((w) => repoKeyOf(w) === narrowed.key) : worktrees;
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
  // While the pointer is over the list (on a phone, while the drawer is open), the order shown stays: the time a
  // session was last used changes as Claude works, and its row would move away from under the pointer.
  const holdList = (on: boolean) => setHeldOrder(on ? holdOrder(categories) : null);
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
        icon: <StatusDot status={m.connected ? s.status : "unknown"} />,
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

  const worktreeSection: SidebarSection = {
    // Shown even without sessions, for its "＋".
    title: narrowed ? `worktree · ${narrowed.name}` : "worktree",
    notice: listMode.kind === "gasho" && listMode.failed ? `${listMode.failed} の一覧を出せないので、worktree を並べています（理由はプラグインの画面に）。` : undefined,
    action: { label: "新しいセッション", icon: <Plus />, onClick: () => openLaunch() },
    secondaryAction: worktreeOrder
      ? { label: "最後に使った順に戻す", icon: <ListRestart />, onClick: () => setWorktreeOrder(undefined) }
      : undefined,
    tools: (
      <RepoFilter
        choices={repos}
        picked={narrowed}
        onPick={setRepoKey}
        onRegister={() => setReposOpen(true)}
        machineNames={machines.length > 1}
      />
    ),
    sort: {
      onReorder: (ids) => setWorktreeOrder(rememberSessions(reorderShown(worktrees.map((w) => w.id), ids), worktreeOrder)),
    },
    items: listed.map((w) => ({
      id: w.id,
      label: w.label,
      // The working server too, when there are several.
      description: [w.repo, machines.length > 1 ? w.machine.name : undefined].filter(Boolean).join(" · ") || undefined,
      icon: <StatusDot status={worktreeStatus(w)} />,
      badge: !w.machine.connected ? "オフライン" : w.sessions.some((s) => s.status === "waiting") ? "確認" : undefined,
    })),
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
        { id: "devices", label: "端末", icon: <KeyRound />, badge: machines.some((m) => updateTo(m, latest)) ? "更新" : undefined },
        // The plugins that the catalog has a newer version of.
        { id: "plugins", label: "プラグイン", icon: <Puzzle />, badge: updateCount(plugins, catalog) || undefined },
        { id: "settings", label: "設定", icon: <Settings /> },
      ],
    },
    listMode.kind === "gasho" ? worktreeSection : categorySection,
  ];
  const openSession =
    route.name === "session" ? machines.find((m) => m.id === route.machine)?.sessions.find((s) => s.sessionId === route.sessionId) : undefined;
  const activeId =
    route.name === "session"
      ? listMode.kind !== "gasho"
        ? sessionKey(route.machine, route.sessionId)
        : openSession
          ? worktreeId(route.machine, openSession)
          : ""
      : route.name === "worktree"
        ? worktreeKey(route.machine, route.path)
        : route.name === "plugin"
        ? (pluginItems.find((i) => i.plugin === route.plugin && i.page.id === route.page)?.id ?? "")
        : route.name;
  const panel = route.name === "session" ? route.panel : undefined;
  // The session on a phone's screen (not while one of its panels takes the screen): the top bar shows its name and
  // state, and its header leaves them out (see SessionView), so the two bars become one.
  const onScreen = route.name === "session" && !panel && openSession?.managed ? openSession : undefined;
  const onScreenMachine = onScreen && machines.find((m) => m.id === (route.name === "session" ? route.machine : ""));

  return (
    <div className="flex h-dvh overflow-hidden bg-background text-foreground">
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
        header={<Brand />}
        footer={<Connection connected={connected} deviceName={me?.name} />}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
          <SidebarTrigger
            onClick={() => {
              setMobileOpen(true);
              holdList(true);
            }}
          />
          {onScreen && onScreenMachine ? (
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
        <div className="flex min-h-0 flex-1">
          {/* layoutScroll: the home screen's tiles slide to new places inside it, also while it scrolls. */}
          <motion.main layoutScroll className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            {route.name === "home" && <HomeView />}
            {route.name === "devices" && <DevicesView />}
            {route.name === "settings" && <SettingsView />}
            {route.name === "plugins" && <PluginsView />}
            {route.name === "plugin" && <PluginPageView plugin={route.plugin} page={route.page} params={route.params} />}
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
              <PanelView machine={route.machine} sessionId={route.sessionId} panel={panel} docked={false} />
            )}
          </motion.main>
          {route.name === "session" && desktop && panel && (
            <DockedPanel>
              <PanelView machine={route.machine} sessionId={route.sessionId} panel={panel} docked />
            </DockedPanel>
          )}
        </div>
      </div>
      <PluginBadgeProbes />
      <PluginSessionListProbe ctx={listContext} />
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
    </div>
  );
}
