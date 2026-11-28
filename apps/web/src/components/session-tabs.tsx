// The tabs above a session: the sessions Gasho shows in the same worktree, in the order they started. A tab opens its
// session, and its "×" removes it (asking first, as the menu's 削除 does, when that stops its work); a right-click (a
// long press on a phone) opens the session's menu (see session-menu). The button before the
// tabs lists the worktree's past conversations (see session-history); "＋" after them starts a new session in it. The
// plugins' tabs of the worktree come last (docs/plugins.md, P15). While a plugin's categories list the sessions in the
// sidebar (P17, hideSessionTabs), the sessions' tabs and their "＋" are left out: the sidebar has them. Above the tabs,
// the conversations open in the worktree outside Gasho, if any (see outside-sessions). At the right end, while a
// session is open, the button that hides or shows its header (on a phone, it is in the top bar).
import { LoaderCircle, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentKind, MachineInfo, SessionInfo } from "@gasho/protocol";
import { AgentMark } from "@/components/agent-mark";
import { LaunchMenu } from "@/components/launch-menu";
import { OutsideSessions } from "@/components/outside-sessions";
import { SessionHeaderToggle } from "@/components/session-header-toggle";
import { SessionHistory } from "@/components/session-history";
import { removeSession, SessionContextMenu, sessionActionsUnavailable, type SessionActionRequest } from "@/components/session-menu";
import { StatusDot } from "@/components/status-badge";
import { launchAgentFor, launchTitle, sessionAgent, showsAgents } from "@/lib/agents";
import { sessionLabel } from "@/lib/format";
import { showNotice } from "@/lib/notice";
import { go, type WorktreeView } from "@/lib/route";
import { useSessionLauncher } from "@/lib/session-launch";
import { hidesSessionTabs } from "@/lib/session-list";
import { sessionDot, unreadSessions, workRemovalStops, type WorktreeSessions } from "@/lib/sessions";
import { useAppState } from "@/lib/store";
import { cn } from "@/lib/utils";
import { PluginWorktreeTabs } from "@/plugins/parts";
import { useSessionListMode } from "@/plugins/session-list";
import type { LaunchInitial } from "@/views/launch";

/**
 * Starting a session in a worktree's top folder and opening it: whether it can be, whether it is under way, and why it
 * could not. The new session opens only while the caller is still shown: one picked meanwhile is not left for it. When
 * Claude Code asks whether to trust the folder (a repository just cloned, say), `onAskTrust` puts that question to the
 * person, in the app's dialog: the first session of a worktree replaces the screen that asked, and what the launch has
 * to tell must still show then. Only "信頼して起動する" there starts the session.
 */
export function useWorktreeLaunch(worktree: WorktreeSessions, onAskTrust: (initial: LaunchInitial) => void) {
  const { machine } = worktree;
  const defaultAgent = useAppState().server?.defaultAgent;
  const launchSession = useSessionLauncher();
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string>();
  const shown = useRef(true);
  useEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  const canLaunch = machine.connected && machine.canLaunch === true;
  /** `agent`: the one picked from the menu of the "＋"; else the default one. */
  const launch = async (agent: AgentKind = launchAgentFor(machine, defaultAgent)) => {
    if (!canLaunch || launching) return;
    setLaunching(true);
    setError(undefined);
    const r = await launchSession(machine.id, { cwd: worktree.path, agent });
    if (r.ok && r.warning) showNotice(r.warning);
    if (!shown.current) return;
    setLaunching(false);
    if (!r.ok || !r.sessionId) {
      if (r.needsTrust) onAskTrust({ machine: machine.id, folder: worktree.path, trust: r.trustWarnings ?? [], agent });
      else setError(r.error ?? "起動できませんでした。");
      return;
    }
    go({ name: "session", machine: machine.id, sessionId: r.sessionId });
  };
  return { canLaunch, launching, error, launch, defaultAgent };
}

/**
 * `current`: the session open below, if any. `view`: the plugin's screen open below instead, if any. `onAskTrust`: see
 * useWorktreeLaunch.
 */
export function SessionTabs({
  worktree,
  current,
  view,
  onAction,
  onAskTrust,
}: {
  worktree: WorktreeSessions;
  current?: string;
  view?: WorktreeView;
  onAction: (request: SessionActionRequest) => void;
  onAskTrust: (initial: LaunchInitial) => void;
}) {
  const { machine, sessions } = worktree;
  const active = useRef<HTMLDivElement>(null);
  // With more tabs than fit, the open one is scrolled into view.
  useEffect(() => {
    active.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);
  const { canLaunch, launching, error, launch, defaultAgent } = useWorktreeLaunch(worktree, onAskTrust);
  const hidden = hidesSessionTabs(useSessionListMode());
  const { notifications, machines } = useAppState();
  const unread = unreadSessions(notifications);
  const marks = showsAgents(machines);

  return (
    <>
      <OutsideSessions worktree={worktree} />
      <div className="flex shrink-0 items-center border-b border-border">
        <nav
          aria-label={hidden ? "この worktree" : "この worktree のセッション"}
          className="flex min-w-0 flex-1 gap-1 overflow-x-auto px-2 [scrollbar-width:none] md:px-4 [&::-webkit-scrollbar]:hidden"
        >
          <SessionHistory worktree={worktree} />
          {!hidden &&
            sessions.map((s) => {
              const open = s.sessionId === current;
              return (
                <SessionContextMenu key={s.sessionId} machine={machine} session={s} onPick={onAction}>
                  <div
                    ref={open ? active : undefined}
                    className={cn(
                      "relative flex h-9 max-w-56 shrink-0 items-center text-xs transition-colors",
                      "after:absolute after:inset-x-1.5 after:bottom-0 after:h-0.5 after:rounded-full",
                      open ? "text-foreground after:bg-foreground" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (!open) go({ name: "session", machine: machine.id, sessionId: s.sessionId });
                      }}
                      aria-current={open ? "page" : undefined}
                      title={sessionLabel(s)}
                      className="flex h-full min-w-0 items-center gap-2 pr-1 pl-2.5"
                    >
                      <StatusDot {...sessionDot(machine, s, unread)} />
                      {marks && <AgentMark agent={sessionAgent(s)} />}
                      <span className="truncate">{sessionLabel(s)}</span>
                      {/* Work Claude started that runs on in the background (listed above the chat box, where it can be stopped). */}
                      {machine.connected && s.background?.length ? (
                        <LoaderCircle
                          role="img"
                          aria-label={`バックグラウンドで ${s.background.length} 件実行中`}
                          className="size-3 shrink-0 animate-spin text-sky-400 motion-reduce:animate-none"
                        >
                          <title>{`バックグラウンドで ${s.background.length} 件実行中`}</title>
                        </LoaderCircle>
                      ) : null}
                    </button>
                    <CloseTabButton machine={machine} session={s} onAction={onAction} />
                  </div>
                </SessionContextMenu>
              );
            })}
          {!hidden && (
            <LaunchMenu machine={machine} onPick={(agent) => void launch(agent)}>
              <button
                type="button"
                onClick={() => void launch()}
                disabled={!canLaunch || launching}
                aria-label="この worktree で新しいセッションを起動"
                title={canLaunch ? launchTitle(machine, defaultAgent, "この worktree で新しいセッションを起動") : "接続していて、セッションの端末を作れる working server でだけ起動できます"}
                className="grid size-9 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
              >
                {launching ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}
              </button>
            </LaunchMenu>
          )}
          <PluginWorktreeTabs worktree={worktree} open={view} />
          {error && (
            <p role="alert" title={error} className="self-center truncate text-xs text-red-400">
              {error}
            </p>
          )}
        </nav>
        {/* Outside the tabs, so it stays in view however far they scroll. */}
        {current && <SessionHeaderToggle className="mr-2 hidden md:grid" />}
      </div>
    </>
  );
}

/**
 * The "×" at the right of a session's tab: the × of EasyUI's Badge with `onRemove` (easyui.site/components/badge),
 * changed for Gasho: Gasho's focus ring, and a larger target for a finger. When removing stops the session's work or
 * drops its inputs waiting to be sent, it asks first, in the same dialog as the menu's 削除; else it removes the session
 * at once, spinning until it is gone, and tells at the top of the screen why it could not (the tabs' row may have no
 * room left for it on a phone). It can be used when the menu's items can.
 */
function CloseTabButton({ machine, session, onAction }: { machine: MachineInfo; session: SessionInfo; onAction: (request: SessionActionRequest) => void }) {
  const unavailable = sessionActionsUnavailable(machine);
  const { working, pending } = workRemovalStops(session);
  const asks = working || pending > 0;
  const [removing, setRemoving] = useState(false);
  const close = async () => {
    if (asks) {
      onAction({ action: "remove", machine, session });
      return;
    }
    setRemoving(true);
    const r = await removeSession(machine.id, session.sessionId);
    // Once removed, the tab goes as the list comes: it spins until then.
    if (r.ok) return;
    setRemoving(false);
    showNotice(`「${sessionLabel(session)}」：${r.error}`);
  };
  return (
    <button
      type="button"
      onClick={() => void close()}
      disabled={unavailable !== undefined || removing}
      aria-label={`${sessionLabel(session)} を削除`}
      title={unavailable ?? (removing ? "削除しています…" : asks ? "削除…" : "削除")}
      className={cn(
        "mr-1.5 grid size-5 shrink-0 place-items-center rounded-full opacity-60 outline-none transition hover:bg-white/15 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-25 pointer-coarse:size-8",
        removing && "disabled:opacity-60",
      )}
    >
      {removing ? (
        <LoaderCircle className="size-3 animate-spin motion-reduce:animate-none pointer-coarse:size-3.5" />
      ) : (
        <X className="size-3 pointer-coarse:size-3.5" />
      )}
    </button>
  );
}
