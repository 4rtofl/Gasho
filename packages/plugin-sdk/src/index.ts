// The plugin SDK for the web part of a Gasho plugin (web.js). Gasho's screen provides everything here at run time: a
// plugin's build (gasho-plugin build) replaces `import … from "@gasho/plugin-sdk"` with what Gasho puts on globalThis,
// so this file only describes it (GashoSdk), for TypeScript. See docs/plugins.md of Gasho.
import type { ComponentType, ReactNode } from "react";
import type { AgentKind, DirEntry, EffortLevel, FileContent, GitHubRepo, MachineInfo, PluginInfo, SessionInfo, SessionModel, SessionRepo, SessionStatus, SwitchField } from "@gasho/protocol";

export type {
  AgentKind,
  ContextWindow,
  DirEntry,
  EffortLevel,
  FileContent,
  GitHubRepo,
  MachineInfo,
  PlanLimits,
  PluginInfo,
  SessionInfo,
  SessionModel,
  SessionRepo,
  SessionStatus,
  SwitchField,
  UsageWindow,
} from "@gasho/protocol";

/** The arguments of a page or a panel: the query of its URL. */
export type Params = Record<string, string>;

/** Whether a plugin's daemon part can run on a working server, and why not when it cannot. */
export interface DaemonReadiness {
  ready: boolean;
  reason?: string;
}

/** A session, for the parts a plugin adds to it (header items, panels, the end of its conversation). */
export interface SessionContext {
  machine: MachineInfo;
  session: SessionInfo;
  /** This plugin's daemon part on the session's working server. */
  daemon: DaemonReadiness;
}

/** The panel open beside a session. */
export interface OpenPanel {
  plugin: string;
  id: string;
  params: Params;
}

type Icon = ComponentType<{ className?: string }>;

/** An item of the sidebar (P1). It opens a page of the plugin. */
export interface SidebarItem {
  id: string;
  label: string;
  icon: Icon;
  page: { id: string; params?: Params };
  /** A number or a short text beside the label. A React hook, called whenever the sidebar is drawn. */
  useBadge?: () => string | number | undefined;
}

/** A page of the plugin (P2): #/p/<plugin>/<page>?<params>. */
export interface PageProps {
  params: Params;
}

/** A panel of a session (P4): #/s/<machine>/<session>/p/<plugin>/<panel>?<params>. */
export interface PanelProps {
  machine: MachineInfo;
  session: SessionInfo;
  params: Params;
  /** Beside the session (a computer), rather than in its place (a phone). */
  docked: boolean;
}

/**
 * A panel of a page of the plugin (P19, plugin API 1.11): #/p/<plugin>/<page>/p/<panel>/<params>. The page opens it
 * with useNavigation's openPanel; it shows as a session's panel does, beside the page on a computer and in its place on
 * a phone.
 */
export interface PagePanelProps {
  params: Params;
  /** Beside the page (a computer), rather than in its place (a phone). */
  docked: boolean;
}

/**
 * An item of the row of a session's header (P3), where "Issues" and "ファイル" are. Pressing it does one of: open a
 * panel of the plugin, open a page of the plugin, open a link (https) in a new tab, or call `onClick`.
 */
export interface SessionHeaderItem {
  id: string;
  label: string;
  icon?: Icon;
  /** Shown on hover. */
  title?: string;
  /**
   * Where it goes in the row: Gasho's own items are at 0 (waiting), 100 (repository), 200 (branch), 400 (files),
   * 800 (pull request links), 900 (last activity) and 1000 (cost). By default 500.
   */
  order?: number;
  /** Whether it shows for this session. */
  when?: (ctx: SessionContext) => boolean;
  panel?: { id: string; params?: Params };
  page?: { id: string; params?: Params };
  href?: (ctx: SessionContext) => string | undefined;
  onClick?: (ctx: SessionContext) => void | Promise<void>;
  /** Whether the open panel is this item's (it then shows as pressed). By default: the same panel with the item's params. */
  isOpen?: (panel: OpenPanel) => boolean;
  /** A React hook, as SidebarItem.useBadge. */
  useBadge?: (ctx: SessionContext) => string | number | undefined;
}

/**
 * The size of a home tile. The home has as many columns as its width holds at 210px each, from 2 (a phone) to 5:
 * stat (1 column), small (1; both of 2), medium (2), large (all but one; both of 2 or 3).
 */
export type TileSize = "stat" | "small" | "medium" | "large";

/** A tile of the home screen (P6). */
export interface HomeTile {
  id: string;
  /** The tile's name (its drag handle is read out with it). */
  title: string;
  size?: TileSize;
  /** Two rows high, from three columns. */
  tall?: boolean;
  /** The tile it follows by default: one of Gasho's ("operations") or "<plugin>.<tile>". At the end without it. */
  after?: string;
  component: ComponentType;
}

/** A part at the end of a session's conversation (P13), and the session it is drawn for. */
export interface ConversationEndProps {
  machine: MachineInfo;
  session: SessionInfo;
}

/**
 * A part at the end of a session's conversation (P13): below its newest entry and the messages being sent, above the
 * chat box. It scrolls with the conversation, which keeps it in sight while the reader is at the bottom. Plugin API 1.2.
 */
export interface ConversationEndItem {
  id: string;
  /** Where it goes among the plugins' parts there: a smaller one comes first. By default 500. */
  order?: number;
  /** Whether it shows for this session. */
  when?: (ctx: SessionContext) => boolean;
  component: ComponentType<ConversationEndProps>;
}

/** A worktree of a working server, for the tabs a plugin adds to it and the screens they open (P15). Plugin API 1.5. */
export interface WorktreeInfo {
  /** Its top folder on the working server. For sessions in a folder outside a repository, that folder. */
  path: string;
  /** The branch checked out. Absent when HEAD is detached, outside a repository, and from an older gasho-daemon. */
  branch?: string;
  /** The folder of its repository: of the main worktree, which all the repository's worktrees share. Absent outside one. */
  repo?: string;
  /** Its repository on GitHub, if it is there. */
  github?: GitHubRepo;
  /**
   * Gasho's sessions in it, in the order of their tabs. None for a worktree the sidebar keeps once its sessions are gone,
   * and for a worktree of a registered repository that has none.
   */
  sessions: SessionInfo[];
}

/** A worktree, for the tabs a plugin adds to it (P15). */
export interface WorktreeContext {
  machine: MachineInfo;
  worktree: WorktreeInfo;
  /** This plugin's daemon part on the worktree's working server. */
  daemon: DaemonReadiness;
}

/** A tab beside a worktree's sessions (P15). Pressing it opens the plugin's `worktreeViews[view]` with `params` there. */
export interface WorktreeTab {
  label: string;
  icon?: Icon;
  /** Shown on hover (by default the label). */
  title?: string;
  view: string;
  params?: Params;
  /** A number or a short text beside the label. */
  badge?: string | number;
}

/**
 * What adds tabs to the worktrees (P15). They go after the sessions' tabs and their "＋". Plugin API 1.5.
 * `useTabs` is a React hook, called whenever a worktree's tabs are drawn: the tabs for that worktree (none, one or several).
 */
export interface WorktreeTabItem {
  id: string;
  /** Where its tabs go among the plugins' tabs: a smaller one comes first. By default 500. */
  order?: number;
  useTabs: (ctx: WorktreeContext) => WorktreeTab[] | undefined;
}

/** A screen a worktree's tab opens, below the tabs, where a session shows (P15): #/w/<machine>/<folder>/p/<plugin>/<view>?<params>. */
export interface WorktreeViewProps {
  machine: MachineInfo;
  worktree: WorktreeInfo;
  params: Params;
}

/** A part in the line under a session's chat box (P14), and the session it is drawn for. */
export interface ComposerFooterProps {
  machine: MachineInfo;
  session: SessionInfo;
}

/**
 * A part in the line under a session's chat box (P14), where the keyboard hint and the character count are: left of
 * the count, also on a phone (where the hint is hidden). The line is 1.5rem high; what does not fit goes in a Popover.
 * Plugin API 1.4.
 */
export interface ComposerFooterItem {
  id: string;
  /** Where it goes among the plugins' parts there: a smaller one comes further left. By default 500. */
  order?: number;
  /** Whether it shows for this session. */
  when?: (ctx: SessionContext) => boolean;
  component: ComponentType<ComposerFooterProps>;
}

/**
 * A worktree as the sidebar knows it, for the plugin that puts the sidebar's sessions in categories (P17). Plugin API
 * 1.7.
 */
export interface SessionListWorktree extends WorktreeInfo {
  /** Gasho's name for it, unique among all working servers: what a category's `launch` names it by. */
  key: string;
  machine: MachineInfo;
  /** Its repository's name, as Gasho shows it: its GitHub repository's, or its folder's. Absent outside a repository. */
  repoName?: string;
  /** A worktree of a repository registered with its working server (it may have no session). */
  registered: boolean;
}

/** A session the sidebar shows, with what categories are made of (P17). */
export interface SessionListSession {
  machine: MachineInfo;
  session: SessionInfo;
  /** The key of its worktree (SessionListWorktree.key). */
  worktree: string;
  /** When it was last used (ms since the epoch): its latest activity, or its start. What "最後に使った順" counts. */
  lastUsed: number;
}

/** What the plugin that puts the sidebar's sessions in categories gets (P17). */
export interface SessionListContext {
  machines: MachineInfo[];
  /** The sessions Gasho shows, of all working servers: the one used last first. */
  sessions: SessionListSession[];
  /** The worktrees those sessions are in, and the other worktrees of the repositories registered with each working server. */
  worktrees: SessionListWorktree[];
}

/** A session in a category of the sidebar (P17). */
export interface SessionCategoryItem {
  /** The working server (machine id). */
  machine: string;
  sessionId: string;
  /** A smaller line under the session's name. */
  description?: string;
}

/** A category of the sidebar's sessions (P17): a heading, which folds, and the sessions under it. */
export interface SessionCategory {
  /**
   * Unique among the categories, and the same whenever they are drawn and in the plugin's next versions: Gasho keeps the
   * order the person dragged them into, and which are folded, by it.
   */
  id: string;
  title: string;
  /** Dimmer text after the title (the working server's name, when there are several). */
  description?: string;
  /** Shown on hover over the heading. */
  hint?: string;
  /** The key of the worktree whose folder the "＋" at the right of the heading starts a session in. No "＋" without it. */
  launch?: string;
  /** In the order they show by default (the person can drag them into another). */
  sessions: SessionCategoryItem[];
}

/**
 * What puts the sidebar's sessions in categories, in place of Gasho's list of worktrees (P17). Gasho draws them, as it
 * draws every sidebar item; the person can fold the categories and drag them and their sessions into another order,
 * which Gasho keeps per browser. Only one plugin's list is used: the first such plugin in the plugins' order. Plugin
 * API 1.7.
 */
export interface SessionListDefinition {
  /**
   * A React hook, called whenever the sessions change: the categories, in the order they show by default. A session
   * left out of every category goes in one Gasho adds at the end ("その他").
   */
  useCategories: (ctx: SessionListContext) => SessionCategory[];
  /**
   * While these categories are shown, the tabs above a session leave out its worktree's sessions and the "＋" after them
   * (the past conversations and the plugins' tabs stay).
   */
  hideSessionTabs?: boolean;
}

/**
 * A worktree as the sidebar lists it, for a plugin's grouping of the sidebar's worktrees (P18): with the state its row's
 * dot shows and when it was last used. Plugin API 1.8.
 */
export interface WorktreeListWorktree extends SessionListWorktree {
  /**
   * The state its row's dot shows: the most pressing of its sessions' (waiting, then busy, then idle). "unknown" while its
   * working server is offline, and for a worktree without sessions.
   */
  status: SessionStatus;
  /** When the session of it used last was (ms since the epoch), as "最後に使った順" counts it. Absent without sessions. */
  lastUsed?: number;
}

/** What a grouping of the sidebar's worktrees gets (P18). */
export interface WorktreeListContext {
  machines: MachineInfo[];
  /**
   * The worktrees the sidebar lists, narrowed to the repositories picked there: those of the sessions, the one used last
   * first; then the other worktrees of the repositories registered with each working server; then those this browser
   * keeps once their sessions are gone.
   */
  worktrees: WorktreeListWorktree[];
}

/** A worktree in a category of the sidebar (P18). */
export interface WorktreeCategoryItem {
  /** WorktreeListWorktree.key */
  key: string;
  /**
   * The smaller line under its name. Absent: Gasho's own (its repository's name, and its working server's when there are
   * several); "": none.
   */
  description?: string;
}

/** A category of the sidebar's worktrees (P18): a heading, which folds, and the worktrees under it. */
export interface WorktreeCategory {
  /**
   * Unique among the categories, and the same whenever they are drawn and in the plugin's next versions: Gasho keeps the
   * order the person dragged them into, and which are folded, by it.
   */
  id: string;
  title: string;
  /** Dimmer text after the title (the working server's name, when there are several). */
  description?: string;
  /** Shown on hover over the heading. */
  hint?: string;
  /** The key of the worktree whose folder the "＋" at the right of the heading starts a session in. No "＋" without it. */
  launch?: string;
  /** In the order they show by default (the person can drag them into another). */
  worktrees: WorktreeCategoryItem[];
}

/** A worktree's row the person dropped in another category of a grouping (P18). Plugin API 1.9. */
export interface WorktreeMove {
  /** WorktreeListWorktree.key */
  worktree: string;
  /** The id of the category it showed in; null: the one Gasho adds at the end ("その他"). */
  from: string | null;
  /** The id of the category it was dropped in; null: "その他". */
  to: string | null;
  /** Where it was dropped among the worktrees that category shows, from 0 (Gasho keeps that order itself). */
  index: number;
}

/**
 * A way to put the sidebar's worktrees in categories (P18), picked in the menu at the right of the list's title, where
 * every enabled plugin's groupings are offered. Gasho draws the categories and the worktrees' rows as it draws its own
 * list; the person can fold the categories and drag them and their worktrees into another order, which Gasho keeps per
 * browser and grouping. Plugin API 1.8.
 */
export interface WorktreeGrouping {
  /** Unique among the plugin's groupings, and the same in its next versions: the browser keeps the one picked by it. */
  id: string;
  /** Its name in the menu (「リポジトリごと」). */
  label: string;
  /**
   * A React hook, called whenever the worktrees change while this grouping is picked: the categories, in the order they
   * show by default. A worktree left out of every category goes in one Gasho adds at the end ("その他").
   */
  useCategories: (ctx: WorktreeListContext) => WorktreeCategory[];
  /**
   * A React hook, called with useCategories: the function Gasho calls when the person drops a worktree's row in another
   * category (or moves it there with Alt+↑/↓). Only a grouping with it lets rows go from one category to another. Gasho
   * shows the row where it was dropped until the function's promise settles; then the categories useCategories gives
   * decide, so the function should change what they are made of (useSharedState keeps that for every browser). When it
   * throws or rejects, the row goes back and the list tells why. Plugin API 1.9.
   */
  useOnMove?: (ctx: WorktreeListContext) => (move: WorktreeMove) => void | Promise<void>;
}

/** The file a file viewer shows in a session's file panel (P20), and what it may do there. Plugin API 1.18. */
export interface FileViewerProps {
  machine: MachineInfo;
  session: SessionInfo;
  /** The file, from the session's folder, "/"-separated ("docs/shot.png"). */
  path: string;
  /** The file as gasho-daemon read it: also one too large to send (`tooLarge`), or neither text nor an image (`binary`). */
  file: FileContent;
  /**
   * The entries of the file's folder, as the file list shows them (folders first, then by name). Undefined until they
   * are read, and when they cannot be.
   */
  entries?: DirEntry[];
  /** Shows another file of the session's folder (its path from there) in the panel, as pressing it in the file list does. */
  openFile: (path: string) => void;
}

/**
 * What shows the files of some extensions in a session's file panel, in place of Gasho's view of them (P20): below the
 * panel's header, the folders on the way and the line of the file's size, which stay Gasho's. Gasho's editor stays for
 * editing a text file. When several plugins show an extension, the first in the plugins' order does. Plugin API 1.18.
 */
export interface FileViewer {
  id: string;
  /** The extensions it shows ("png", "tar.gz"), with or without the dot; upper and lower case are the same. */
  extensions: string[];
  component: ComponentType<FileViewerProps>;
}

/** What the web part of a plugin adds to Gasho's screen (its web.js exports it as default). */
export interface PluginDefinition {
  sidebar?: SidebarItem[];
  pages?: Record<string, ComponentType<PageProps>>;
  sessionHeader?: SessionHeaderItem[];
  sessionPanels?: Record<string, ComponentType<PanelProps>>;
  /** Panels of the plugin's pages, opened beside the page on screen (P19). Plugin API 1.11. */
  pagePanels?: Record<string, ComponentType<PagePanelProps>>;
  homeTiles?: HomeTile[];
  /** More on the settings screen, below the inputs made from gasho-plugin.json `settings` (P5). */
  settings?: ComponentType;
  /** Parts at the end of a session's conversation (P13). Plugin API 1.2. */
  conversationEnd?: ConversationEndItem[];
  /** Tabs beside a worktree's sessions (P15). Plugin API 1.5. */
  worktreeTabs?: WorktreeTabItem[];
  /** The screens the worktree's tabs open (P15). Plugin API 1.5. */
  worktreeViews?: Record<string, ComponentType<WorktreeViewProps>>;
  /** Parts in the line under a session's chat box (P14). Plugin API 1.4. */
  composerFooter?: ComposerFooterItem[];
  /** The sidebar's sessions in categories, in place of its list of worktrees (P17). Plugin API 1.7. */
  sessionList?: SessionListDefinition;
  /** Ways to put the sidebar's worktrees in categories, picked in the menu of the list (P18). Plugin API 1.8. */
  worktreeGroupings?: WorktreeGrouping[];
  /** Views of files in a session's file panel, in place of Gasho's (P20). Plugin API 1.18. */
  fileViewers?: FileViewer[];
}

/** A call of a method of the plugin's daemon part (P7). */
export interface RequestTarget {
  /** The working server (machine id). */
  machine: string;
  /** The session the call is about, if any: the daemon part gets its folder. */
  sessionId?: string;
  method: string;
  /** JSON, up to 64 KB. */
  params?: unknown;
}

export interface RequestOptions {
  /** Read again when shown, if the result is older than this. */
  staleSeconds?: number;
  /** Read again at this interval while shown and the page is visible. */
  refreshSeconds?: number;
}

/** The result of a call, kept while the page is open and shared by every part that asks the same. */
export interface RequestState<T> {
  data?: T;
  error?: string;
  loading: boolean;
  /** When `data` was read (ms since the epoch). */
  at?: number;
  /** Call again. */
  reload: () => void;
}

/**
 * `unknown` (plugin API 1.17): the connection to the Gasho server closed before the result came, so it may have been
 * done: doing it again may do it twice.
 */
export type CallResult<T> = { ok: true; data: T } | { ok: false; error: string; unknown?: true };

/** Moving between the plugin's pages and panels. */
export interface Navigation {
  pageHref(id: string, params?: Params): string;
  openPage(id: string, params?: Params): void;
  /**
   * A panel of the session on screen, or of `at` (from outside a session, such as a home tile). On a page of the plugin
   * without `at` (plugin API 1.11): a panel of that page (pagePanels, P19).
   */
  panelHref(id: string, params?: Params, at?: { machine: string; sessionId: string }): string;
  /** Opens a panel, as panelHref (a new entry of the browser's history: back returns to what was open). */
  openPanel(id: string, params?: Params, at?: { machine: string; sessionId: string }): void;
  /** Shows another panel, or the same with other params, in place of the open one (no new history entry): tabs. */
  replacePanel(id: string, params?: Params): void;
  /** Closes the panel open beside the session or the page on screen. */
  closePanel(): void;
  /** Back to `panel`: through the browser's history when the current one was opened from it, else by replacing. */
  back(panel: { id: string; params?: Params }): void;
  /** Gasho's screen of a session (plugin API 1.1). */
  sessionHref(machine: string, sessionId: string): string;
  /** Opens Gasho's screen of a session (plugin API 1.1). */
  openSession(machine: string, sessionId: string): void;
  /**
   * A screen of the plugin's worktree tabs (P15): in the worktree on screen (or the worktree of the session on screen),
   * or in `at` (its working server and top folder). Plugin API 1.5.
   */
  worktreeHref(view: string, params?: Params, at?: { machine: string; path: string }): string;
  /** Opens a screen of the plugin's worktree tabs, as worktreeHref (a new entry of the browser's history). Plugin API 1.5. */
  openWorktreeView(view: string, params?: Params, at?: { machine: string; path: string }): void;
}

/**
 * What starting a session gave: the new session, or why none was started. `needsTrust`: Claude Code asked whether to
 * trust the folder, so nothing was started; ask the person, and start it again with `trust: true` if they agree.
 */
/**
 * What useSendInput sends: the text, and (plugin API 1.12) what to switch the session to before it, for this session
 * only, as the chat box's pickers do. Switching works in sessions started from Gasho, with a gasho-daemon that lists the
 * field in `MachineInfo.features` (0.6.0 and later); elsewhere the text is sent as it is and the field is `unapplied`.
 */
export interface SendInput {
  machine: string;
  sessionId: string;
  text: string;
  model?: SessionModel;
  effort?: EffortLevel;
  ultracode?: boolean;
}

/** What useSendInput did besides sending (plugin API 1.12): what it could not switch, and why, for people. */
export interface SendInputResult {
  /** The input waits for the session to become idle (Gasho types it in then). */
  queued: boolean;
  warning?: string;
  /** Fields asked to switch that were not: the session keeps what it had. */
  unapplied?: SwitchField[];
}

export type LaunchResult =
  | { ok: true; sessionId: string }
  | { ok: false; error: string; needsTrust?: boolean; trustWarnings?: string[] };

/** What removing a session gave (useRemoveSession, plugin API 1.14). */
export type RemoveSessionResult = { ok: true } | { ok: false; error: string };

/**
 * Removing a worktree with the sessions in it (useRemoveWorktree, plugin API 1.10), as "削除…" of its row in the
 * sidebar does.
 */
export interface RemoveWorktreeInput {
  machine: string;
  /** Its top folder (WorktreeInfo.path): a worktree that git lists, not the repository's main worktree. */
  path: string;
  /** Also delete this local branch once the worktree is gone: the branch the worktree has checked out, or it is refused. */
  branch?: string;
  /** Remove it also with uncommitted changes, or with commits that no remote has. */
  force?: boolean;
  /**
   * Commits (their SHAs, 7 to 40 hex digits; up to 100) counted as pushed, with those before them: such as the head of
   * a pull request merged by squashing, whose branch on GitHub was then deleted.
   */
  pushed?: string[];
}

/** What keeps a worktree from being removed without `force`. */
export interface WorktreeChanges {
  /** Uncommitted changes: files changed, staged or untracked (`git status --porcelain`). */
  uncommitted: number;
  /** Commits of its HEAD that no remote branch has, nor any of `pushed`. */
  unpushed: number;
}

/**
 * What removing a worktree gave. `sessions`: the sessions it ended (and took off Gasho), also those ended before it
 * failed. `changes`: only when it was not removed because of them; `force: true` removes it all the same. `warning`:
 * the worktree is gone, but something asked for did not happen (the branch could not be deleted, say).
 */
export type RemoveWorktreeResult =
  | { ok: true; sessions: string[]; warning?: string }
  | { ok: false; error: string; changes?: WorktreeChanges; sessions?: string[] };

/**
 * What a session is working on, read from Claude Code's hooks and the session's conversation as Gasho's screen has
 * them (plugin API 1.2). Empty while the session is neither working nor waiting for an answer.
 */
export interface SessionActivity {
  /**
   * When the work going on started (ms since the epoch, the working server's clock): the person's last message, or,
   * when its work has ended, the first thing the session did after that (work it took up by itself, such as the end
   * of a task it ran in the background). Undefined when Gasho's screen cannot tell.
   */
  turnStartedAt?: number;
  /**
   * The tool running now: the latest one Claude Code started (PreToolUse) and has not finished (PostToolUse). `summary`
   * is its most telling input (the command, the file, …).
   */
  tool?: { name: string; summary?: string; startedAt: number };
}

/**
 * A popup that `trigger` opens, in Gasho's look (plugin API 1.4). It closes on Esc, on a press outside it, and on a
 * press of the trigger. It is not modal: the page behind it scrolls. What it shows is drawn only while it is open,
 * in the plugin's scope (its CSS and the SDK's hooks work there).
 */
export interface PopoverProps {
  /** One element that takes a ref, such as a <button>: it gets aria-expanded and aria-controls. */
  trigger: ReactNode;
  children?: ReactNode;
  /** The side of the trigger it opens on, when there is room ("bottom" by default). */
  side?: "top" | "bottom" | "left" | "right";
  /** How it lines up with the trigger along that side ("center" by default). */
  align?: "start" | "center" | "end";
  /** Its name for a screen reader. */
  label?: string;
  /** Classes for the popup itself, such as its width ("w-72" by default). */
  className?: string;
  /** Open or closed, when the plugin keeps that itself (with onOpenChange). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/** A session's folder, or one of the repositories gasho-daemon found inside it. */
export interface RepoChoice {
  repos?: SessionRepo[];
  selected?: SessionRepo;
}

/** Everything Gasho's screen provides to plugins under "@gasho/plugin-sdk". */
export interface GashoSdk {
  /** Returns `def`; Gasho checks it when loading the plugin. */
  definePlugin(def: PluginDefinition): PluginDefinition;
  /** The working servers and their sessions, as Gasho's screen has them (read only). */
  useMachines(): MachineInfo[];
  /** In a session's header items, panels and parts at the end of its conversation: that session. */
  useSessionContext(): SessionContext | undefined;
  /** Whether this plugin's daemon part runs on a working server. */
  useDaemonReady(machine: string): DaemonReadiness;
  /** Calls a method of the daemon part and keeps the result; undefined `target` calls nothing. */
  useRequest<T = unknown>(target: RequestTarget | undefined, options?: RequestOptions): RequestState<T>;
  /**
   * A function that calls a method once (for `write` methods; `summary` goes to the operations log). Plugin API 1.17:
   * `unknown` when the connection closed before the result came (the method may have run).
   */
  useCall(): <T = unknown>(target: RequestTarget & { summary?: string }) => Promise<CallResult<T>>;
  /** A setting of gasho-plugin.json `settings` and a function that changes it. */
  useSetting<T = unknown>(key: string): [T, (value: T) => Promise<void>];
  /** A value Gasho keeps while the page is open; it outlives a hot reload of the plugin. */
  usePluginState<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => void];
  /**
   * A JSON value the Gasho server keeps for this plugin, the same in every browser, and a function that changes it
   * (plugin API 1.9). `initial` until one is saved. A new value shows here at once; the function's promise settles once
   * the Gasho server kept it and sent it to every browser, and rejects when it refused it (the value then goes back).
   * Up to 64 KB as JSON, and 256 KB for all the plugin's keys together.
   */
  useSharedState<T>(key: string, initial: T): [T, (value: T | ((prev: T) => T)) => Promise<void>];
  useNavigation(): Navigation;
  /**
   * Sends a message to a session (needs the permission "session.input"), as the chat box does. Plugin API 1.12: the
   * model, the effort level and ultracode to switch to first (SendInput), and what was not switched (SendInputResult).
   * Plugin API 1.17: `unknown` when the connection closed before the result came (the message may have been typed).
   */
  useSendInput(): (input: SendInput) => Promise<CallResult<SendInputResult>>;
  /**
   * Starts a session in a folder of a working server (needs the permission "session.launch"), as "新しいセッション" does.
   * Plugin API 1.1. `agent` (plugin API 1.16): Claude Code unless it says "codex"; the default agent of the settings is
   * not used, because what plugins send may rely on Claude Code's skills and slash commands.
   */
  useLaunchSession(): (input: { machine: string; cwd: string; name?: string; trust?: boolean; agent?: AgentKind }) => Promise<LaunchResult>;
  /**
   * Removes a session Gasho started (needs the permission "session.remove"), as "削除" of its menu does, without asking:
   * its Claude Code ends, also in the middle of its work, and Gasho lists it no more. Its conversation stays on the
   * working server. When the screen shows that session, Gasho opens the tab next to it, or its worktree. Plugin API 1.14.
   */
  useRemoveSession(): (input: { machine: string; sessionId: string }) => Promise<RemoveSessionResult>;
  /**
   * Removes a worktree with the sessions in it (needs the permission "worktree.remove"), as "削除…" of its row in the
   * sidebar does: the sessions end (those started from Gasho are taken off it), then `git worktree remove`. Once it is
   * gone, the sidebar forgets it, and when the screen shows that worktree (one of its sessions, or its tabs, a plugin's
   * worktree view included) Gasho goes to the home screen and shows a `warning` there. Plugin API 1.10.
   */
  useRemoveWorktree(): (input: RemoveWorktreeInput) => Promise<RemoveWorktreeResult>;
  /**
   * Why a worktree cannot be removed, for people (undefined when it can): outside a repository, the repository's main
   * worktree (`path` is `repo`), its working server offline, or a gasho-daemon too old. Plugin API 1.10.
   */
  removeWorktreeProblem(machine: MachineInfo, worktree: { path: string; repo?: string }): string | undefined;
  /** What a session is working on: since when, and with which tool (plugin API 1.2). */
  useSessionActivity(machine: string, sessionId: string): SessionActivity;
  /**
   * The data of the last event of a topic that this plugin's daemon part sent from a working server (ctx.emit, plugin
   * API 1.5); undefined until one came. Events kept by the Gasho server (retain) come when the page connects. A new
   * version of the plugin starts without the events of the one before.
   */
  useEvent<T = unknown>(topic: string, options: { machine: string }): T | undefined;
  /** The current time, renewed every `intervalMs` (30 s by default). */
  useNow(intervalMs?: number): number;
  /** The GitHub repositories of a session: its folder's, or those of the repositories inside it. */
  githubRepos(session: SessionInfo): { path?: string; github: GitHubRepo; branch?: string }[];
  /** Of the repositories inside the session's folder, those that `fit`, and the one asked for (else the first). */
  panelRepo(session: SessionInfo, asked: string | undefined, fit?: (r: SessionRepo) => boolean): RepoChoice;
  /** "3分前" */
  relativeTime(ms: number | undefined, now: number): string;
  /** Joins class names, as Gasho does (clsx and tailwind-merge). */
  cn(...classes: unknown[]): string;
  /** The frame of a page: title, description, buttons at the top right. */
  Page: ComponentType<{ title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }>;
  /** The frame of a panel: Gasho adds the close button (computer) and "セッションに戻る" (phone; "戻る" for a page's panel). */
  Panel: ComponentType<{ title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode }>;
  /** The class of the small bordered buttons in a panel's header (reload, open on GitHub). */
  PANEL_BUTTON: string;
  /** Tabs of the repositories inside a session's folder. */
  RepoTabs: ComponentType<{ repos: SessionRepo[]; selected: string; onSelect: (path: string) => void }>;
  /** The frame of a home tile: title and icon. */
  Tile: ComponentType<{ title?: string; icon?: ReactNode; className?: string; children?: ReactNode }>;
  /**
   * GitHub's Markdown of issues, pull requests and comments: also the HTML GitHub shows in them (<img>, <details>,
   * <br> and the like; no scripts, event attributes or style), and images from http or https.
   */
  Markdown: ComponentType<{ text: string }>;
  /** "3分前", with the exact time on hover. */
  RelativeTime: ComponentType<{ at: string | number; now: number }>;
  /** A popup that a button opens (plugin API 1.4). */
  Popover: ComponentType<PopoverProps>;
}

export declare const definePlugin: GashoSdk["definePlugin"];
export declare const useMachines: GashoSdk["useMachines"];
export declare const useSessionContext: GashoSdk["useSessionContext"];
export declare const useDaemonReady: GashoSdk["useDaemonReady"];
export declare const useRequest: GashoSdk["useRequest"];
export declare const useCall: GashoSdk["useCall"];
export declare const useSetting: GashoSdk["useSetting"];
export declare const usePluginState: GashoSdk["usePluginState"];
export declare const useSharedState: GashoSdk["useSharedState"];
export declare const useNavigation: GashoSdk["useNavigation"];
export declare const useSendInput: GashoSdk["useSendInput"];
export declare const useLaunchSession: GashoSdk["useLaunchSession"];
export declare const useRemoveSession: GashoSdk["useRemoveSession"];
export declare const useRemoveWorktree: GashoSdk["useRemoveWorktree"];
export declare const removeWorktreeProblem: GashoSdk["removeWorktreeProblem"];
export declare const useSessionActivity: GashoSdk["useSessionActivity"];
export declare const useEvent: GashoSdk["useEvent"];
export declare const useNow: GashoSdk["useNow"];
export declare const githubRepos: GashoSdk["githubRepos"];
export declare const panelRepo: GashoSdk["panelRepo"];
export declare const relativeTime: GashoSdk["relativeTime"];
export declare const cn: GashoSdk["cn"];
export declare const Page: GashoSdk["Page"];
export declare const Panel: GashoSdk["Panel"];
export declare const PANEL_BUTTON: GashoSdk["PANEL_BUTTON"];
export declare const RepoTabs: GashoSdk["RepoTabs"];
export declare const Tile: GashoSdk["Tile"];
export declare const Markdown: GashoSdk["Markdown"];
export declare const RelativeTime: GashoSdk["RelativeTime"];
export declare const Popover: GashoSdk["Popover"];

/**
 * What Gasho's screen puts on globalThis.__gasho for plugins: the version of the plugin API, and the modules plugins
 * share with it (react, react/jsx-runtime, react-dom, @gasho/plugin-sdk).
 */
export interface GashoGlobal {
  api: string;
  modules: Record<string, unknown>;
}
