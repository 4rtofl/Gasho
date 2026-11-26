// Gasho shows only the sessions it started (from its own launcher). Others running on a working server are only listed
// above the tabs of their worktree, to be ended there and opened again from Gasho (see outside-sessions).
import type { FolderRepo, GashoNotification, GitHubRepo, MachineInfo, RegisteredRepo, SessionInfo, SessionStatus } from "@gasho/protocol";
import { basename } from "./format.ts";

export function shownSessions(m: MachineInfo): SessionInfo[] {
  return m.sessions.filter((s) => s.managed);
}

/** What a dot shows: a session's state, "hibernated" for one asleep, or "none" for a worktree without sessions. */
export type DotStatus = SessionStatus | "hibernated" | "none";

/** A session's state for its dot: one coming back counts as working. */
export function sessionDotStatus(s: SessionInfo): DotStatus {
  if (s.hibernation === "resuming") return "busy";
  return s.hibernation === "hibernated" ? "hibernated" : shownStatus(s);
}

/** What the chat box says about a hibernated session. Undefined while the session runs. */
export function hibernationNote(s: SessionInfo): string | undefined {
  const waiting = s.pendingInputs ? `送信待ち ${s.pendingInputs} 件は、再開してから送ります。` : "";
  if (s.hibernation === "resuming") return `Claude Code を再開しています。${waiting}`;
  if (s.hibernation !== "hibernated") return undefined;
  if (s.resumeError) return `再開できませんでした：${s.resumeError}${s.pendingInputs ? ` 送信待ち ${s.pendingInputs} 件は預かっています。` : ""}`;
  return "休止中です。発言すると再開します。";
}

/** A dot, or a bell in its place while its session (one of its worktree's) has a notification not read yet. */
export interface Dot {
  status: DotStatus;
  unread: boolean;
}

const unreadKey = (machine: string, sessionId: string) => [machine, sessionId].join("\u001f");

/** The sessions that have a notification not read yet, for sessionDot and worktreeDot. */
export function unreadSessions(notifications: GashoNotification[]): ReadonlySet<string> {
  return new Set(notifications.flatMap((n) => (n.read ? [] : [unreadKey(n.machine, n.sessionId)])));
}

/** The ids a session's notifications came under: its own, and those it had before /clear. */
function idsOf(s: SessionInfo): string[] {
  return [s.sessionId, ...(s.previousSessionIds ?? [])];
}

const hasUnread = (machine: string, s: SessionInfo, unread: ReadonlySet<string>) => idsOf(s).some((id) => unread.has(unreadKey(machine, id)));

/**
 * The state to show for a session. Its turn has ended (idle) while work it started runs on in the background: it is
 * shown as working, since Claude usually goes on once that work ends. `status` stays idle, which is what decides that
 * input goes in at once.
 */
export function shownStatus(s: Pick<SessionInfo, "status" | "background">): SessionStatus {
  return s.status === "idle" && (s.background?.length ?? 0) > 0 ? "busy" : s.status;
}

/**
 * What removing a session stops: its work (`working`: Claude works, also only in the background, or waits for an
 * answer), and the inputs waiting to be sent (`pending`). The "×" of its tab asks before removing only when there is
 * either; the conversation itself can be opened again.
 */
export function workRemovalStops(s: Pick<SessionInfo, "status" | "background" | "pendingInputs">): { working: boolean; pending: number } {
  return { working: shownStatus(s) === "busy" || s.status === "waiting", pending: s.pendingInputs ?? 0 };
}

/** A session's dot. The bell shows also while its working server is offline: what was not read stays so. */
export function sessionDot(m: MachineInfo, s: SessionInfo, unread: ReadonlySet<string>): Dot {
  return { status: m.connected ? sessionDotStatus(s) : "unknown", unread: hasUnread(m.id, s, unread) };
}

/** A worktree's dot in the sidebar: that of its most pressing session, and a bell if any of them has one. */
export function worktreeDot(w: WorktreeSessions, unread: ReadonlySet<string>): Dot {
  const unreadOne = w.sessions.some((s) => hasUnread(w.machine.id, s, unread));
  if (!w.machine.connected) return { status: "unknown", unread: unreadOne };
  if (w.sessions.length === 0) return { status: "none", unread: false };
  // Asleep only when all of its sessions are: one that runs says more.
  const asleep = w.sessions.every((s) => s.hibernation === "hibernated");
  return { status: asleep ? "hibernated" : worktreeStatus(w), unread: unreadOne };
}

const byStart = (a: SessionInfo, b: SessionInfo) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.sessionId.localeCompare(b.sessionId);

/** When a session was last used: its latest activity, or for one with no conversation yet, when it started. */
export const lastUsed = (s: SessionInfo): number => s.lastActivityAt ?? s.startedAt ?? 0;

/**
 * A worktree on a working server and the sessions Gasho shows in it: a row of the sidebar, and the tabs above a session.
 */
export interface WorktreeSessions {
  /** Unique among all working servers (see worktreeId). */
  id: string;
  machine: MachineInfo;
  /** The branch, or the folder's name when no branch is checked out or the folder is not in a repository. */
  label: string;
  /** The name given to it (MachineInfo.worktreeNames), which shows in place of `label` (worktreeTitle). */
  name?: string;
  /** The repository's name: its GitHub repository's, or its folder's. Absent outside a repository. */
  repo?: string;
  /** Its top folder: where "＋" starts a session and whose past conversations are listed. */
  path: string;
  /** Whether it is a git worktree, whose sessions may run in the folders inside `path` too. */
  subfolders: boolean;
  /** A worktree of a repository registered with its working server: it stays in the sidebar while git lists it. */
  registered: boolean;
  /**
   * What plugins get of it (docs/plugins.md): the branch checked out, the repository's folder (SessionWorktree.repo,
   * which the sidebar is also narrowed by), its GitHub repository.
   */
  branch?: string;
  repoFolder?: string;
  github?: GitHubRepo;
  /** In the order they started, which is the order of the tabs. Empty for one of a registered repository or remembered. */
  sessions: SessionInfo[];
  /**
   * The sessions in it that Claude Codes started outside Gasho (in Orca, a terminal) have open, which session.end can
   * end: those with a process. In the order they started. They make no worktree of their own.
   */
  outside: SessionInfo[];
}

/** A worktree this browser keeps in the sidebar once its sessions are gone, until it is taken off (see remembered-worktrees). */
export interface RememberedWorktree {
  machine: string;
  path: string;
  label: string;
  repo?: string;
  subfolders: boolean;
  branch?: string;
  /** Absent for one remembered before the repository's folder was. */
  repoFolder?: string;
  github?: GitHubRepo;
}

/** The fields of a worktree that are absent when unknown. */
const known = (w: Pick<WorktreeSessions, "repo" | "branch" | "repoFolder" | "github">) => ({
  ...(w.repo ? { repo: w.repo } : {}),
  ...(w.branch ? { branch: w.branch } : {}),
  ...(w.repoFolder ? { repoFolder: w.repoFolder } : {}),
  ...(w.github ? { github: w.github } : {}),
});

/**
 * The worktree a session is in. A session in a folder that is not in a repository, or one whose gasho-daemon is too old
 * to tell the worktree, is in a worktree of its own folder.
 */
export function worktreeId(machine: string, s: SessionInfo): string {
  return worktreeKey(machine, s.worktree?.path ?? s.cwd);
}

export function worktreeKey(machine: string, path: string): string {
  return [machine, path].join("\u001f");
}

/** A repository's name: its GitHub repository's, or its folder's (without ".git", for a bare one). */
const repoName = (folder: string, github: GitHubRepo | undefined) => github?.name ?? basename(folder).replace(/\.git$/, "");

/**
 * The worktrees of the sessions Gasho shows, of all working servers (the sidebar's list): the one used last first.
 * Then the other worktrees of the repositories registered with each working server, as git lists them, and then the
 * `remembered` ones that have no session now, in the order given. One remembered in a registered repository is left
 * out: the repository's list tells whether it is still there.
 */
export function worktreesByLastUse(machines: MachineInfo[], remembered: RememberedWorktree[] = []): WorktreeSessions[] {
  const byId = new Map<string, WorktreeSessions>();
  for (const machine of machines) {
    for (const s of shownSessions(machine)) {
      const id = worktreeId(machine.id, s);
      const found = byId.get(id);
      if (found) {
        found.sessions.push(s);
        continue;
      }
      const w = s.worktree;
      const path = w?.path ?? s.cwd;
      const repo = w ? repoName(w.repo, s.github) : s.github?.name;
      const facts = known({ repo, branch: w?.branch, repoFolder: w?.repo, github: s.github });
      byId.set(id, { id, machine, label: w?.branch ?? basename(path), path, subfolders: Boolean(w), registered: false, ...facts, sessions: [s], outside: [] });
    }
  }
  const worktrees = [...byId.values()];
  for (const w of worktrees) w.sessions.sort(byStart);
  const latest = (w: WorktreeSessions) => worktreeLastUsed(w) ?? 0;
  worktrees.sort((a, b) => latest(b) - latest(a) || a.id.localeCompare(b.id));
  for (const machine of machines) {
    for (const r of machine.repos ?? []) {
      for (const t of r.worktrees) {
        const id = worktreeKey(machine.id, t.path);
        const label = t.branch ?? basename(t.path);
        const found = byId.get(id);
        if (found) {
          // git's list is read more often than a session's worktree.
          Object.assign(found, { label, registered: true });
          if (t.branch) found.branch = t.branch;
          else delete found.branch;
          continue;
        }
        const facts = known({ repo: repoName(r.path, r.github), branch: t.branch, repoFolder: r.path, github: r.github });
        const w: WorktreeSessions = { id, machine, label, path: t.path, subfolders: true, registered: true, ...facts, sessions: [], outside: [] };
        byId.set(id, w);
        worktrees.push(w);
      }
    }
  }
  for (const r of remembered) {
    const machine = machines.find((m) => m.id === r.machine);
    const id = worktreeKey(r.machine, r.path);
    if (!machine || byId.has(id) || machine.repos?.some((x) => x.path === r.repoFolder)) continue;
    byId.set(id, { id, machine, label: r.label, path: r.path, subfolders: r.subfolders, registered: false, ...known(r), sessions: [], outside: [] });
    worktrees.push(byId.get(id)!);
  }
  for (const machine of machines) {
    for (const s of machine.sessions) {
      if (!s.managed && s.pid) byId.get(worktreeId(machine.id, s))?.outside.push(s);
    }
  }
  for (const w of worktrees) {
    w.outside.sort(byStart);
    const name = w.machine.worktreeNames?.[w.path];
    if (name) w.name = name;
  }
  return worktrees;
}

/** What a worktree shows as: the name given to it, or its branch (or its folder's name). */
export const worktreeTitle = (w: Pick<WorktreeSessions, "label" | "name">): string => w.name ?? w.label;

/** What the name given to a worktree stands in for: its branch, or its folder. */
export function worktreeOrigin(w: Pick<WorktreeSessions, "label" | "branch">): string {
  return w.branch ? `ブランチ ${w.branch}` : `フォルダー ${w.label}`;
}

/**
 * A worktree's state in the sidebar: that of its most pressing session, waiting for an answer, then working, then idle.
 * "unknown" while its working server is offline, and without sessions (whose dot worktreeDot tells apart, "none").
 * Its row's dot (worktreeDot) and a grouping's context (docs/plugins.md, P18) take it from here.
 */
export function worktreeStatus(w: Pick<WorktreeSessions, "machine" | "sessions">): SessionStatus {
  if (!w.machine.connected) return "unknown";
  return (["waiting", "busy", "idle"] as const).find((st) => w.sessions.some((s) => shownStatus(s) === st)) ?? "unknown";
}

/** When a worktree was last used: when its session used last was. Undefined without sessions. */
export function worktreeLastUsed(w: Pick<WorktreeSessions, "sessions">): number | undefined {
  return w.sessions.length > 0 ? Math.max(...w.sessions.map(lastUsed)) : undefined;
}

/** What the sidebar keeps of a worktree once its sessions are gone. */
export function rememberedOf(w: WorktreeSessions): RememberedWorktree {
  return { machine: w.machine.id, path: w.path, label: w.label, subfolders: w.subfolders, ...known(w) };
}

/** A repository the sidebar can be narrowed to: one that a worktree in it names, on one working server. */
export interface RepoChoice {
  /** worktreeKey of the working server and the repository's folder; repoKeyOf gives a worktree's. */
  key: string;
  name: string;
  machine: MachineInfo;
}

export function repoKeyOf(w: WorktreeSessions): string | undefined {
  return w.repoFolder === undefined ? undefined : worktreeKey(w.machine.id, w.repoFolder);
}

/** The repositories of these worktrees, by name. */
export function repoChoices(worktrees: WorktreeSessions[]): RepoChoice[] {
  const byKey = new Map<string, RepoChoice>();
  for (const w of worktrees) {
    const key = repoKeyOf(w);
    if (key && !byKey.has(key)) byKey.set(key, { key, name: w.repo ?? basename(w.repoFolder ?? ""), machine: w.machine });
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name) || a.machine.name.localeCompare(b.machine.name));
}

/** The worktrees in the repositories `picked` (of repoChoices), in the order given; all of them when none is picked. */
export function narrowWorktrees<W extends WorktreeSessions>(worktrees: readonly W[], picked: readonly RepoChoice[]): W[] {
  if (picked.length === 0) return [...worktrees];
  const keys = new Set(picked.map((r) => r.key));
  return worktrees.filter((w) => {
    const key = repoKeyOf(w);
    return key !== undefined && keys.has(key);
  });
}

/** A registered repository's name, as the sidebar shows it. */
export function registeredRepoName(r: RegisteredRepo): string {
  return repoName(r.path, r.github);
}

/** The name of a repository offered to register: its folder's. */
export function folderRepoName(r: FolderRepo): string {
  return repoName(r.path, undefined);
}

/** The tab to open once the open session's tab is gone: the one after it, else the one before. */
export function tabAfterRemoval(w: WorktreeSessions, sessionId: string): SessionInfo | undefined {
  const i = w.sessions.findIndex((s) => s.sessionId === sessionId);
  if (i < 0) return undefined;
  return w.sessions[i + 1] ?? w.sessions[i - 1];
}

/**
 * The session that a page open on `sessionId` is to go to: after /clear, Claude Code goes on in the same process under
 * a new id (see SessionInfo.previousSessionIds). Undefined while the machine lists `sessionId`, or when no session had it.
 */
export function movedSession(m: MachineInfo | undefined, sessionId: string): SessionInfo | undefined {
  if (!m || m.sessions.some((s) => s.sessionId === sessionId)) return undefined;
  return m.sessions.find((s) => s.previousSessionIds?.includes(sessionId));
}

/** The session each worktree had open last, by worktreeId, while this page is open. */
const lastOpened = new Map<string, string>();

export function rememberOpened(worktree: string, sessionId: string): void {
  lastOpened.set(worktree, sessionId);
}

/** The session to open for a worktree picked in the sidebar: the one it had open last, or else the one used last. */
export function sessionToOpen(w: WorktreeSessions): SessionInfo | undefined {
  const id = lastOpened.get(w.id);
  return w.sessions.find((s) => s.sessionId === id) ?? [...w.sessions].sort((a, b) => lastUsed(b) - lastUsed(a))[0];
}

/**
 * How long a session just started may be missing from its working server's list before its page says it is not found
 * (ms). An older gasho-daemon answers before it sends the list that has the session: that list comes with the refresh
 * after the one running, and each reads `claude agents`, which takes 3 s and more on a busy Mac.
 */
const STARTING_MS = 30_000;
/** The sessions started from this page that their working server has not listed yet, and when they were started. */
const starting = new Map<string, number>();
const startingKey = (machine: string, sessionId: string) => `${machine}\u0000${sessionId}`;

/** A session that session.launch, session.fork or session.resume answered with, before its working server lists it. */
export function rememberStarting(machine: string, sessionId: string, now = Date.now()): void {
  for (const [key, at] of starting) if (now - at >= STARTING_MS) starting.delete(key);
  starting.set(startingKey(machine, sessionId), now);
}

/** The sessions a working server lists are started: one of them missing later has ended. */
export function forgetStarting(m: Pick<MachineInfo, "id" | "sessions">): void {
  for (const s of m.sessions) starting.delete(startingKey(m.id, s.sessionId));
}

/** Whether the page of a session its working server does not list is to say that the session is starting. */
export function startingSession(machine: string, sessionId: string, now: number): boolean {
  const at = starting.get(startingKey(machine, sessionId));
  return at !== undefined && now - at < STARTING_MS;
}

/** Whether a working server's gasho-daemon is at least `major.minor` (older ones lack what came later). */
export function daemonAtLeast(m: MachineInfo, major: number, minor: number): boolean {
  const [a = 0, b = 0] = (m.daemonVersion ?? "").split(".").map((n) => Number.parseInt(n, 10) || 0);
  return a > major || (a === major && b >= minor);
}

/** The unread notifications of the session open on `sessionId`, those that came under an id it had before /clear too. */
export function unreadOfSession(notifications: GashoNotification[], machines: MachineInfo[], machine: string, sessionId: string): GashoNotification[] {
  const s = machines.find((m) => m.id === machine)?.sessions.find((x) => x.sessionId === sessionId);
  const ids = s ? idsOf(s) : [sessionId];
  return notifications.filter((n) => !n.read && n.machine === machine && ids.includes(n.sessionId));
}

/** A notification is shown unless it is about a session known to have been started elsewhere. */
export function notificationShown(n: GashoNotification, machines: MachineInfo[]): boolean {
  const s = machines.find((m) => m.id === n.machine)?.sessions.find((x) => x.sessionId === n.sessionId);
  return !s || Boolean(s.managed);
}
