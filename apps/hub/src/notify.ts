import type { GashoNotification, HookEvent, SessionInfo } from "@gasho/protocol";

export function sessionLabel(s: SessionInfo | undefined, sessionId: string): string {
  if (s?.title) return s.title;
  if (s?.name) return s.name;
  if (s?.cwd) return s.cwd.split("/").filter(Boolean).pop() ?? s.cwd;
  return sessionId.slice(0, 8);
}

/** What a plugin says of a Stop (plugin API 1.13), when gasho-daemon sent something that can be shown. */
function pluginNotification(ev: HookEvent): HookEvent["notification"] {
  const n = ev.notification;
  if (typeof n?.plugin !== "string" || typeof n.title !== "string" || !n.title.trim()) return undefined;
  return { plugin: n.plugin, title: n.title.trim().slice(0, 120), ...(typeof n.body === "string" && n.body.trim() ? { body: n.body.trim().slice(0, 300) } : {}) };
}

/**
 * Decides whether a hook event deserves a notification.
 * Server-mode sessions never send idle_prompt, so "waiting for input" there is shown from Stop.
 */
export function notificationFor(
  machine: string,
  ev: HookEvent,
  session: SessionInfo | undefined,
  id: string,
): GashoNotification | null {
  const label = sessionLabel(session, ev.sessionId);
  const base = { id, machine, sessionId: ev.sessionId, at: ev.at, read: false };
  if (ev.event === "Stop") {
    const said = pluginNotification(ev);
    if (said) return { ...base, kind: "done", title: said.title, body: said.body, plugin: said.plugin };
    return { ...base, kind: "done", title: `${label} の応答が終わりました`, body: ev.summary || undefined };
  }
  if (ev.event === "StopFailure") {
    return { ...base, kind: "error", title: `${label} がエラーで止まりました`, body: ev.summary || undefined };
  }
  if (ev.event === "Notification" && ev.notificationType === "permission_prompt") {
    // Claude Code says "needs your permission" for a question or a plan too; the request it is about says which.
    const requests = session?.permissionRequests ?? [];
    const r = requests[requests.length - 1];
    // The summary is the (first) question or the plan's title; from a gasho-daemon too old to send them, raw JSON.
    if (r?.toolName === "AskUserQuestion") {
      return { ...base, kind: "permission", title: `${label} が質問しています`, body: (r.questions && r.summary) || undefined };
    }
    if (r?.toolName === "ExitPlanMode") {
      return { ...base, kind: "permission", title: `${label} が計画の承認を待っています`, body: (r.plan !== undefined && r.summary) || undefined };
    }
    return { ...base, kind: "permission", title: `${label} が権限の確認を待っています`, body: ev.summary || undefined };
  }
  if (ev.event === "Notification" && ev.notificationType === "idle_prompt") {
    return { ...base, kind: "idle", title: `${label} が入力を待っています`, body: ev.summary || undefined };
  }
  return null;
}

interface GateState {
  /** The session has been reported waiting for input (a Stop, StopFailure or idle_prompt) since it last did anything. */
  told: boolean;
  /** The turn going on began with a prompt Claude Code submitted by itself (HookEvent.automatic). */
  automatic: boolean;
  /** The last notification of the session. */
  last?: string;
}

/**
 * Keeps notifications that only repeat what the user already knows from reaching them (#91), per session:
 *
 * - idle_prompt comes 60 s after the session last did anything, also when that was a reply that a Stop already
 *   reported, or something that runs no turn and sends no hook (/compact, /context). It is dropped when the session
 *   has been reported waiting since its last hook of any other kind.
 * - A turn that Claude Code began by itself (a background task ended, a message from another session) ends in a Stop
 *   with no input from the user. Its notification is dropped while the session's last one is still unread.
 *
 * Kept in memory: after a restart of the Gasho server, the first idle_prompt of a session may be notified again.
 */
export class NotificationGate {
  private sessions = new Map<string, GateState>();

  /**
   * Called with every hook event of a session Gasho notifies about, and the notification notificationFor made of it
   * (if any). Says whether to send that notification. `unread` tells whether a notification is still unread.
   */
  pass(machine: string, ev: HookEvent, n: GashoNotification | null, unread: (id: string) => boolean): boolean {
    const key = `${machine}/${ev.sessionId}`;
    if (ev.event === "SessionEnd") {
      this.sessions.delete(key);
      return n !== null;
    }
    let s = this.sessions.get(key);
    if (!s) this.sessions.set(key, (s = { told: false, automatic: false }));
    let send = n !== null;
    if (ev.event === "UserPromptSubmit") {
      s.told = false;
      s.automatic = ev.automatic === true;
    } else if (ev.event === "Stop" || ev.event === "StopFailure") {
      // A failure is notified even in a turn of its own: it may need the user.
      // So is what a plugin says of this turn: it is news, whoever began the turn.
      if (ev.event === "Stop" && !n?.plugin && s.automatic && s.last !== undefined && unread(s.last)) send = false;
      s.automatic = false;
      s.told = true;
    } else if (ev.event === "Notification" && ev.notificationType === "idle_prompt") {
      if (s.told) send = false;
      s.told = true;
    } else {
      s.told = false;
    }
    if (send && n) s.last = n.id;
    return send;
  }
}
