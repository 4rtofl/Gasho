// The Gasho server as the screen's store meets it (GET /api/me, then the WebSocket of /ws/client), for the tests that
// draw the parts: a test says what the Gasho server tells the page, and reads what the parts sent it. The store itself
// runs as it does in the browser.
import { act } from "@testing-library/react";
import type { ClientToHub, CommandResult, HubToClient, MachineInfo, SessionCommand, SessionInfo } from "@gasho/protocol";
import { afterEach, vi } from "vitest";
import { becomeUnregistered, start } from "@/lib/store";

type Snapshot = Extract<HubToClient, { type: "snapshot" }>;
/** A command for a working server, as the page sends it. */
export type SentCommand = SessionCommand & { requestId: string; machine: string };

export const session = (sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId,
  cwd: "/repo",
  status: "idle",
  rcMode: "server",
  prLinks: [],
  managed: true,
  ...extra,
});

export const machine = (id: string, sessions: SessionInfo[] = [], extra: Partial<MachineInfo> = {}): MachineInfo => ({
  id,
  name: id,
  connected: true,
  lastSeen: 0,
  sessions,
  ...extra,
});

let sockets: FakeSocket[] = [];

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  sent: ClientToHub[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    sockets.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as ClientToHub);
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code: 1000 });
  }
}

/** What the Gasho server answers itself, with server.result. */
const SERVER_REQUESTS = new Set<ClientToHub["type"]>(["hub.update", "defaultAgent.set", "worktree.name"]);

export interface Hub {
  /** Every message the page sent, in order. */
  readonly sent: ClientToHub[];
  /** The commands for working servers among them (not those the Gasho server answers itself, such as worktree.name). */
  commands(): SentCommand[];
  /** Tells the page something, as the Gasho server does. */
  say(m: HubToClient): Promise<void>;
  /**
   * Answers a request as the Gasho server does: a command for a working server, a plugin's command (plugin.result) or
   * one the Gasho server answers itself (server.result). The last one sent, unless one is given.
   */
  answer(result: CommandResult, request?: ClientToHub): Promise<void>;
  /** Closes the page's connection, as a network that lost it. */
  drop(): void;
  /** Opens the connection the page makes again after drop() (its back-off is 1 s). The functions above keep to the first one. */
  reopen(): Promise<void>;
}

/** Registers this browser with the stand-in, connects to it, and has it send `snapshot` (no machines unless given). */
export async function connectHub(snapshot: Partial<Omit<Snapshot, "type">> = {}): Promise<Hub> {
  vi.stubGlobal("fetch", async () => Response.json({ id: "browser", kind: "browser", name: "test", createdAt: 0 }));
  vi.stubGlobal("WebSocket", FakeSocket);
  await act(() => start());
  const socket = sockets.at(-1);
  if (!socket) throw new Error("the store did not connect");
  act(() => {
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.();
  });
  const say = (m: HubToClient) =>
    act(async () => {
      socket.onmessage?.({ data: JSON.stringify(m) });
    });
  const commands = () =>
    socket.sent.filter((m): m is ClientToHub & SentCommand => "machine" in m && "requestId" in m && m.type !== "plugin.request" && !SERVER_REQUESTS.has(m.type));
  await say({ type: "snapshot", machines: [], notifications: [], events: [], ...snapshot });
  return {
    sent: socket.sent,
    commands,
    say,
    drop: () => act(() => socket.close()),
    async reopen() {
      const next = await vi.waitFor(
        () => {
          const s = sockets.at(-1);
          if (!s || s === socket) throw new Error("the store has not connected again");
          return s;
        },
        { timeout: 3000 },
      );
      act(() => {
        next.readyState = FakeSocket.OPEN;
        next.onopen?.();
      });
    },
    answer(result, request = socket.sent.findLast((m) => "requestId" in m)) {
      if (!request || !("requestId" in request)) throw new Error("no request was sent");
      const { requestId } = request;
      if (SERVER_REQUESTS.has(request.type)) return say({ type: "server.result", requestId, result });
      if (!("machine" in request)) return say({ type: "plugin.result", requestId, result });
      return say({ type: "command.result", requestId, machine: request.machine, result });
    },
  };
}

afterEach(() => {
  // Forgets the connection and what came over it, for the next test of the file.
  becomeUnregistered();
  sockets = [];
  vi.unstubAllGlobals();
});
