// Which sessions of a working server look finished with, offered for removal when a new session starts there (see
// session-launch), and how long this browser has been told not to offer them.
import type { MachineInfo, SessionInfo } from "@gasho/protocol";
import { daemonAtLeast } from "./sessions.ts";

/** A session counts as unused once this long has passed since it was last active (ms). */
export const UNUSED_AFTER_MS = 24 * 60 * 60 * 1000;
/** How long "削除せずに起動" keeps the question away on that working server (ms). */
export const KEEP_FOR_MS = 60 * 60 * 1000;

const KEPT_KEY = "gasho.unusedSessions.keptUntil";

/** When a session was last active, as far as is known. */
export const lastActive = (s: SessionInfo): number | undefined => s.lastActivityAt ?? s.startedAt;

/**
 * The sessions of a working server that can be removed without getting in anyone's way, the one unused longest first:
 * started by Gasho, idle, with no work in the background, not active for UNUSED_AFTER_MS, and not the session on the
 * screen. One whose last activity is not known is left alone, and so is everything on a working server that is offline
 * or whose gasho-daemon cannot remove sessions.
 */
export function unusedSessions(m: MachineInfo, now: number, openSessionId?: string): SessionInfo[] {
  if (!m.connected || !daemonAtLeast(m, 0, 9)) return [];
  return m.sessions
    .filter((s) => {
      const active = lastActive(s);
      return (
        s.managed === true &&
        s.status === "idle" &&
        !s.background?.length &&
        s.sessionId !== openSessionId &&
        active !== undefined &&
        now - active >= UNUSED_AFTER_MS
      );
    })
    .sort((a, b) => (lastActive(a) ?? 0) - (lastActive(b) ?? 0));
}

// Also kept here for a private window or blocked storage, where it lasts as long as the page.
const kept = new Map<string, number>();

function savedKept(): Record<string, number> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEPT_KEY) ?? "{}");
    return saved && typeof saved === "object" ? (saved as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Whether this browser was told, within the last hour, to leave the unused sessions of this working server alone. */
export function keepsUnused(machine: string, now: number): boolean {
  const until = Math.max(kept.get(machine) ?? 0, Number(savedKept()[machine]) || 0);
  return now < until;
}

export function keepUnused(machine: string, now: number): void {
  const until = now + KEEP_FOR_MS;
  kept.set(machine, until);
  try {
    // Those that ran out are dropped, so the list does not grow.
    const live = Object.fromEntries(Object.entries(savedKept()).filter(([, t]) => Number(t) > now));
    localStorage.setItem(KEPT_KEY, JSON.stringify({ ...live, [machine]: until }));
  } catch {
    // Blocked storage: `kept` holds it for this page.
  }
}
