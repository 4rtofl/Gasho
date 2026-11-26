// Holds a session's next tool call while gasho-daemon types a message into it as Claude works: a permission dialog
// that opens as Enter is pressed takes the Enter as a yes. Claude Code checks a tool call's permission only once its
// PreToolUse hooks have answered, so no dialog opens while gasho-daemon holds the answer to its PreToolUse.
import { str } from "./util.ts";

/**
 * How long a tool call may still open a permission dialog after its PreToolUse was answered: other PreToolUse hooks
 * may still run, and in auto mode a model decides on the permission first, which takes seconds.
 */
export const DIALOG_MAY_OPEN_MS = 15_000;
/** How long after a PermissionRequest its dialog may not be drawn yet: Claude Code sends the hook as it opens it. */
export const DIALOG_DRAWN_MS = 2000;

export interface HeldTools {
  /** When the hold ends by itself, still under the 5 s Claude Code waits for a hook (see hooksConfig). */
  until: number;
  /** How many tool calls have waited so far. */
  readonly waited: number;
  release(): void;
}

export class ToolHold {
  /** Sessions whose hooks reach gasho-daemon, every one since a turn of theirs began: a UserPromptSubmit came. */
  private seen = new Set<string>();
  /** By session: the tool calls answered (by their tool_use_id), and until when each may open a dialog. */
  private calls = new Map<string, Map<string, number>>();
  /** By session: until when a dialog that has just opened may not be drawn yet. */
  private drawing = new Map<string, number>();
  private holds = new Map<string, { until: number; waiting: Array<() => void>; timer: NodeJS.Timeout }>();
  private unnamed = 0;
  private now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** A hook other than PreToolUse. */
  observe(p: Record<string, unknown>): void {
    const id = str(p.session_id);
    if (!id) return;
    switch (str(p.hook_event_name)) {
      case "UserPromptSubmit":
        this.seen.add(id);
        break;
      case "PostToolUse":
      case "PostToolUseFailure": {
        const call = str(p.tool_use_id);
        if (call) this.calls.get(id)?.delete(call);
        break;
      }
      case "PermissionRequest":
        this.drawing.set(id, this.now() + DIALOG_DRAWN_MS);
        break;
      case "SessionEnd":
        this.seen.delete(id);
        this.calls.delete(id);
        this.drawing.delete(id);
        break;
    }
  }

  /** A PreToolUse: `answer` is called at once, or when the hold on its session ends. */
  preToolUse(p: Record<string, unknown>, answer: () => void): void {
    const id = str(p.session_id);
    const go = () => {
      answer();
      if (!id) return;
      const calls = this.calls.get(id) ?? new Map<string, number>();
      this.calls.set(id, calls);
      // Without an id, its end cannot be told: it is taken as able to open a dialog for as long as any call.
      calls.set(str(p.tool_use_id) ?? `unnamed-${++this.unnamed}`, this.now() + DIALOG_MAY_OPEN_MS);
    };
    const hold = id ? this.holds.get(id) : undefined;
    if (hold) hold.waiting.push(go);
    else go();
  }

  /**
   * Holds the session's next tool calls for `ms` at most, if no dialog can open meanwhile: its hooks reach gasho-daemon,
   * and none of its tool calls may still open one. Undefined when it cannot hold.
   */
  hold(sessionId: string, ms: number): HeldTools | undefined {
    if (this.holds.has(sessionId) || !this.quiet(sessionId)) return undefined;
    const h = { until: this.now() + ms, waiting: [] as Array<() => void>, timer: setTimeout(() => release(), ms) };
    h.timer.unref();
    const release = () => {
      if (this.holds.get(sessionId) !== h) return;
      clearTimeout(h.timer);
      this.holds.delete(sessionId);
      for (const go of h.waiting) go();
    };
    this.holds.set(sessionId, h);
    return {
      until: h.until,
      get waited() {
        return h.waiting.length;
      },
      release,
    };
  }

  private quiet(sessionId: string): boolean {
    const now = this.now();
    if (!this.seen.has(sessionId) || (this.drawing.get(sessionId) ?? 0) > now) return false;
    const calls = this.calls.get(sessionId);
    for (const [call, until] of calls ?? []) {
      if (until > now) return false;
      calls?.delete(call);
    }
    return true;
  }
}
