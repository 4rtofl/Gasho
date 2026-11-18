// Passes Claude Code's hooks on to the Gasho server. A Stop first asks the plugins' daemon parts what to say of it
// (onSessionStop, plugin API 1.13); the hooks of that session that come meanwhile wait behind it, so that the Gasho
// server hears them in the order they happened: a prompt overtaking the Stop before it would look like a turn that ended.
import type { HookEvent, PluginStopNotification } from "@gasho/protocol";

export interface HookRelayOptions {
  send: (event: HookEvent) => void;
  /** Whether any daemon part may have something to say. */
  asks: () => boolean;
  /** What the daemon parts say of the session that stopped; they are given a limited time (PluginRunner.sessionStop). */
  ask: (sessionId: string) => Promise<PluginStopNotification | undefined>;
  log: (...args: unknown[]) => void;
}

export class HookRelay {
  private opts: HookRelayOptions;
  /** By session: the hooks being held back, until the last of them is sent. */
  private held = new Map<string, Promise<void>>();

  constructor(opts: HookRelayOptions) {
    this.opts = opts;
  }

  pass(ev: HookEvent): void {
    const before = this.held.get(ev.sessionId);
    const asking = ev.event === "Stop" && this.opts.asks();
    if (!before && !asking) {
      this.opts.send(ev);
      return;
    }
    const done = (before ?? Promise.resolve())
      .then(() => (asking ? this.withNotification(ev) : ev))
      .then((e) => this.opts.send(e))
      .catch((e: unknown) => this.opts.log("could not pass on a hook", e))
      .finally(() => {
        if (this.held.get(ev.sessionId) === done) this.held.delete(ev.sessionId);
      });
    this.held.set(ev.sessionId, done);
  }

  /** A plugin that fails leaves the Stop as it is: Gasho's own notification goes out. */
  private async withNotification(ev: HookEvent): Promise<HookEvent> {
    try {
      const notification = await this.opts.ask(ev.sessionId);
      return notification ? { ...ev, notification } : ev;
    } catch (e) {
      this.opts.log("could not ask the plugins about a session that stopped", e);
      return ev;
    }
  }
}
