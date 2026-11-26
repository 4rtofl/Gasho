// A fake gasho-daemon, driven by the test: it registers as a working server (POST /api/pair), connects to /ws/daemon,
// says hello, and sends the capabilities, repositories and sessions the test gives. It answers what the Gasho server
// asks with the test's handlers, or by default from the conversations it was given (transcript.get) and with ok to
// every command. The test decides its version, what it can do, its sessions and what it answers, how late, or not at
// all.
import type {
  DaemonToHub,
  HubToDaemon,
  RegisteredRepo,
  SessionInfo,
  TranscriptEntry,
} from "@gasho/protocol";

type Capabilities = Omit<Extract<DaemonToHub, { type: "capabilities" }>, "type">;
type HubMessage<K extends HubToDaemon["type"]> = Extract<HubToDaemon, { type: K }>;
/** What a handler sends back: one message, several, or nothing (the Gasho server then waits, and gives up). */
export type Answer = DaemonToHub | DaemonToHub[] | undefined;
type Handler<K extends HubToDaemon["type"]> = (msg: HubMessage<K>) => Answer | Promise<Answer>;

export interface FakeDaemonOptions {
  /** The working server's name (the device name it registers with). */
  name?: string;
  /** daemonVersion in its hello (what the screen offers depends on it: 0.9, 0.10, 0.11 and later). */
  version?: string;
  /** Over the default ones: a gasho-daemon of today that can launch, resume and end sessions. */
  capabilities?: Partial<Capabilities>;
  sessions?: SessionInfo[];
  repos?: RegisteredRepo[];
  /** The conversation of each session, by its id, that transcript.get reads. */
  transcripts?: Record<string, TranscriptEntry[]>;
}

/** For a handler that answers late. */
export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A session as gasho-daemon sends it, started from Gasho and idle unless `s` says otherwise. */
export function fakeSession(s: Partial<SessionInfo> & { sessionId: string; cwd: string }): SessionInfo {
  return { status: "idle", rcMode: "none", prLinks: [], managed: true, startedAt: Date.now(), lastActivityAt: Date.now(), ...s };
}

let entryCount = 0;
/** An entry of a conversation, of text only. */
export function textEntry(role: TranscriptEntry["role"], text: string): TranscriptEntry {
  return { uuid: `e2e-${process.pid}-${++entryCount}`, ts: new Date().toISOString(), role, blocks: [{ type: "text", text }] };
}

/** The answer to a command (session.input, session.launch, …). */
export function commandResult(msg: { requestId: string }, result: Extract<DaemonToHub, { type: "command.result" }>["result"] = { ok: true }): DaemonToHub {
  return { type: "command.result", requestId: msg.requestId, result };
}

/** The page of a session's conversation that transcript.get asks for, from the conversations the daemon was given. */
export function transcriptPage(d: FakeDaemon, msg: HubMessage<"transcript.get">): DaemonToHub {
  const all = d.transcripts[msg.sessionId] ?? [];
  const end = Math.min(msg.before ?? all.length, all.length);
  const start = Math.max(0, end - msg.limit);
  return { type: "transcript.page", requestId: msg.requestId, sessionId: msg.sessionId, entries: all.slice(start, end), start, total: all.length };
}

/** What a request of the Gasho server is answered with when the test gave no handler for it. */
function defaultAnswer(d: FakeDaemon, msg: HubToDaemon): Answer {
  switch (msg.type) {
    case "welcome":
    case "plugins":
    case "plugin.code":
      return undefined;
    case "transcript.get":
      return transcriptPage(d, msg);
    case "git.graph.get":
      return { type: "git.graph", requestId: msg.requestId, sessionId: msg.sessionId, ...(msg.repo ? { repo: msg.repo } : {}), error: "fake daemon: no graph" };
    case "dir.get":
      return { type: "dir", requestId: msg.requestId, sessionId: msg.sessionId, path: msg.path, error: "fake daemon: no folders" };
    case "file.get":
      return { type: "file", requestId: msg.requestId, sessionId: msg.sessionId, path: msg.path, error: "fake daemon: no files" };
    case "media.get":
      return { type: "media", requestId: msg.requestId, notFound: true };
    case "plugin.request":
      return { type: "plugin.response", requestId: msg.requestId, error: "fake daemon: no plugins run here" };
    case "usage.get":
      // Asked only of a fake daemon whose capabilities say canReadUsage.
      return { type: "usage", error: "fake daemon: no usage" };
    default:
      // The commands of sessions, folders and repositories.
      return commandResult(msg);
  }
}

export class FakeDaemon {
  readonly name: string;
  readonly version: string;
  readonly machineId: string;
  sessions: SessionInfo[];
  capabilities: Capabilities;
  repos: RegisteredRepo[];
  transcripts: Record<string, TranscriptEntry[]>;
  /** Every message of the Gasho server, oldest first. */
  readonly received: HubToDaemon[] = [];
  private url: string;
  private token: string;
  private ws: WebSocket | undefined;
  private handlers = new Map<string, (msg: HubToDaemon) => Answer | Promise<Answer>>();
  private waiters = new Set<() => void>();
  /** GashoHub.fakeDaemons, which the one startAgain makes is added to, so that GashoHub.stop disconnects it too. */
  private fakeDaemons: FakeDaemon[] | undefined;

  constructor(o: FakeDaemonOptions & { url: string; machineId: string; token: string; defaultVersion: string; fakeDaemons?: FakeDaemon[] }) {
    this.name = o.name ?? "e2e-machine";
    this.fakeDaemons = o.fakeDaemons;
    this.version = o.version ?? o.defaultVersion;
    this.machineId = o.machineId;
    this.token = o.token;
    this.url = o.url;
    this.sessions = o.sessions ?? [];
    this.repos = o.repos ?? [];
    this.transcripts = { ...o.transcripts };
    this.capabilities = {
      canLaunch: true,
      folders: [],
      features: ["model", "effort", "ultracode", "files"],
      canResume: true,
      canEnd: true,
      canRemoveWorktree: true,
      canListSkills: true,
      ...o.capabilities,
    };
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Connects and says hello; once welcomed, sends its capabilities, repositories and sessions. */
  async connect(): Promise<void> {
    const ws = new WebSocket(`${this.url.replace(/^http/, "ws")}/ws/daemon`);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", machineId: this.machineId, token: this.token, daemonVersion: this.version })));
      ws.addEventListener("close", (ev) => reject(new Error(`the Gasho server closed the connection of the fake daemon: ${ev.code} ${ev.reason}`)));
      ws.addEventListener("error", () => reject(new Error("the fake daemon could not connect to the Gasho server")));
      ws.addEventListener("message", (ev) => {
        const msg = JSON.parse(String(ev.data)) as HubToDaemon;
        if (msg.type === "welcome") resolve();
        void this.onMessage(msg);
      });
    });
    this.send({ type: "capabilities", ...this.capabilities });
    this.send({ type: "repos", repos: this.repos });
    this.send({ type: "sessions", sessions: this.sessions });
  }

  /** Goes offline, as a working server that stopped or lost its network. */
  async disconnect(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((r) => ws.addEventListener("close", r));
    ws.close();
    await closed;
  }

  /**
   * The same working server connected again by another gasho-daemon (after an update to `version`): this one goes
   * offline, and the new one says hello with this one's sessions, repositories and capabilities (with `capabilities`
   * over them). The handlers are not carried over.
   */
  async startAgain(o: { version?: string; capabilities?: Partial<Capabilities> } = {}): Promise<FakeDaemon> {
    await this.disconnect();
    const d = new FakeDaemon({
      name: this.name,
      url: this.url,
      machineId: this.machineId,
      token: this.token,
      defaultVersion: this.version,
      ...(o.version ? { version: o.version } : {}),
      capabilities: { ...this.capabilities, ...o.capabilities },
      sessions: this.sessions,
      repos: this.repos,
      transcripts: this.transcripts,
      ...(this.fakeDaemons ? { fakeDaemons: this.fakeDaemons } : {}),
    });
    this.fakeDaemons?.push(d);
    await d.connect();
    return d;
  }

  send(msg: DaemonToHub): void {
    if (!this.connected) throw new Error("the fake daemon is not connected");
    this.ws?.send(JSON.stringify(msg));
  }

  /** Answers the requests of this type with `fn` instead of the default answer. */
  handle<K extends HubToDaemon["type"]>(type: K, fn: Handler<K>): void {
    this.handlers.set(type, fn as (msg: HubToDaemon) => Answer | Promise<Answer>);
  }

  setSessions(sessions: SessionInfo[]): void {
    this.sessions = sessions;
    this.send({ type: "sessions", sessions });
  }

  /** Changes one session and sends them all, as gasho-daemon does. */
  updateSession(sessionId: string, change: Partial<SessionInfo>): void {
    this.setSessions(this.sessions.map((s) => (s.sessionId === sessionId ? { ...s, ...change } : s)));
  }

  setCapabilities(change: Partial<Capabilities>): void {
    this.capabilities = { ...this.capabilities, ...change };
    this.send({ type: "capabilities", ...this.capabilities });
  }

  setRepos(repos: RegisteredRepo[]): void {
    this.repos = repos;
    this.send({ type: "repos", repos });
  }

  /** Adds entries to a session's conversation and sends them, as when Claude Code writes its transcript. */
  append(sessionId: string, entries: TranscriptEntry[]): void {
    this.transcripts[sessionId] = [...(this.transcripts[sessionId] ?? []), ...entries];
    this.send({ type: "transcript.append", sessionId, entries });
  }

  /** The first message of the Gasho server of this type (that `match` accepts), once it has come. */
  async waitFor<K extends HubToDaemon["type"]>(type: K, match: (msg: HubMessage<K>) => boolean = () => true, timeoutMs = 30_000): Promise<HubMessage<K>> {
    const find = () => this.received.find((m): m is HubMessage<K> => m.type === type && match(m as HubMessage<K>));
    const end = Date.now() + timeoutMs;
    for (;;) {
      const found = find();
      if (found) return found;
      const left = end - Date.now();
      if (left <= 0) throw new Error(`the fake daemon did not get ${type} in ${timeoutMs} ms (got: ${this.received.map((m) => m.type).join(", ")})`);
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.waiters.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, left);
        this.waiters.add(wake);
      });
    }
  }

  private async onMessage(msg: HubToDaemon): Promise<void> {
    this.received.push(msg);
    for (const w of [...this.waiters]) w();
    const handler = this.handlers.get(msg.type);
    const answer = handler ? await handler(msg) : defaultAnswer(this, msg);
    for (const a of Array.isArray(answer) ? answer : answer ? [answer] : []) {
      if (this.connected) this.send(a);
    }
  }
}
