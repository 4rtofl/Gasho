// The sessions of Codex that Gasho started. Each is a thread of Codex's own app-server, which runs apart from
// gasho-daemon: gasho-daemon connects to it, keeps the ids of its threads in a file, and loads them again each time it
// connects, so a turn goes on while gasho-daemon restarts. Claude Code's sessions do not come through here.
import fsp from "node:fs/promises";
import type { CommandResult, HookEvent, PermissionDecision, QuestionAnswer, SessionInfo, TranscriptEntry, TranscriptPage } from "@gasho/protocol";
import {
  type CodexItem,
  type CodexRequest,
  type CodexThreadStatus,
  type CodexTurn,
  entriesOfItem,
  entriesOfTurnEnd,
  eventSummary,
  lastAgentText,
  replyOf,
  requestOf,
  sessionStatusOf,
  textInput,
  transcriptOf,
} from "./codex-map.ts";
import { CodexConnectionClosed, CodexRpc, CodexRpcError } from "./codex-rpc.ts";

/** Reconnecting: the first wait, and the longest. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 30_000;
const TURNS_PAGE = 100;
const ITEMS_PAGE = 200;
/** JSON-RPC's "method not found", for a request of the app-server that Gasho cannot answer. */
const NOT_SUPPORTED = -32601;

export interface CodexSessionsOptions {
  /** Where the threads are kept. */
  file: string;
  /** gasho-daemon's version, told to the app-server. */
  version: string;
  /** Starts the app-server if it does not run; gives its socket. */
  startServer: () => Promise<string>;
  /** What is known of a folder: its repository, branch and worktree. */
  describe: (cwd: string) => Promise<Partial<SessionInfo>>;
  changed: () => void;
  event: (event: HookEvent) => void;
  append: (sessionId: string, entries: TranscriptEntry[]) => void;
  log: (...args: unknown[]) => void;
}

interface SavedThread {
  threadId: string;
  cwd: string;
  name?: string;
  launchedAt: number;
}

interface ThreadState {
  info: SessionInfo;
  launchedAt: number;
  /** Inputs waiting for the thread to become idle, the next one first. */
  queue: string[];
  sending: boolean;
  /** The turn going on, and the last one that ended (its turn/start may be answered after it ended). */
  turnId?: string;
  lastTurnEnded?: string;
  /** The input that started the turn going on. */
  sentText?: string;
  said?: string;
  pending: Map<string, CodexRequest>;
  /** The requests already notified: the app-server sends those still open again after a reconnection. */
  notified: Set<string>;
  /** Commands and file changes under way. */
  items: Map<string, CodexItem>;
  /** It was working when the connection ended. */
  wasActive: boolean;
  transcript?: { entries: TranscriptEntry[]; ids: Set<string> };
  loading?: Promise<void>;
  /** What came in while the conversation was read. */
  buffered: TranscriptEntry[];
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const known = (entries: TranscriptEntry[]) => ({ entries, ids: new Set(entries.map((e) => e.uuid)) });

export class CodexSessions {
  private o: CodexSessionsOptions;
  private threads = new Map<string, ThreadState>();
  private rpc: CodexRpc | undefined;
  private opening: Promise<CodexRpc> | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private retryMs = RETRY_MIN_MS;
  private saving: Promise<void> = Promise.resolve();

  constructor(o: CodexSessionsOptions) {
    this.o = o;
  }

  /** Reads the threads kept, and connects to go on with them. */
  async load(): Promise<void> {
    let saved: SavedThread[];
    try {
      const list = JSON.parse(await fsp.readFile(this.o.file, "utf8")) as unknown;
      if (!Array.isArray(list)) throw new Error("not a list");
      saved = list as SavedThread[];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.o.log(`cannot read ${this.o.file}; starting without the Codex sessions it kept`, e);
      return;
    }
    for (const s of saved) if (typeof s?.threadId === "string" && typeof s.cwd === "string") this.add(s.threadId, s.cwd, s.name, s.launchedAt);
    if (this.threads.size > 0) this.connectInBackground();
  }

  has(sessionId: string): boolean {
    return this.threads.has(sessionId);
  }

  /** The folder of a session of Codex. */
  cwdOf(sessionId: string): string | undefined {
    return this.threads.get(sessionId)?.info.cwd;
  }

  ids(): string[] {
    return [...this.threads.keys()];
  }

  sessions(): SessionInfo[] {
    return [...this.threads.values()].map((t) => ({
      ...t.info,
      pendingInputs: t.queue.length || undefined,
      permissionRequests: t.pending.size > 0 ? [...t.pending.values()].map((r) => r.info) : undefined,
    }));
  }

  /** How many inputs wait to be sent: they are not kept over a restart. */
  waitingInputs(): number {
    return [...this.threads.values()].reduce((n, t) => n + t.queue.length, 0);
  }

  async launch(cwd: string, name: string | undefined): Promise<string> {
    const rpc = await this.ensure();
    // Only the folder: approvals and the sandbox are as the person set them up for Codex (~/.codex/config.toml).
    const r = await rpc.request<{ thread: Record<string, unknown>; model?: string }>("thread/start", { cwd });
    const threadId = r.thread.id as string;
    const t = this.add(threadId, cwd, name, Date.now());
    this.applyThread(t, r.thread, r.model);
    if (name) await rpc.request("thread/name/set", { threadId, name }).catch((e: unknown) => this.o.log(`could not name the thread ${threadId}`, messageOf(e)));
    await this.describe(t);
    await this.save();
    this.o.changed();
    return threadId;
  }

  async input(sessionId: string, text: string): Promise<CommandResult> {
    const t = this.threads.get(sessionId);
    if (!t) return { ok: false, error: "このセッションは見つかりません。" };
    t.queue.push(text);
    if (t.queue.length === 1) {
      const error = await this.flush(t);
      if (error) return { ok: false, error };
    }
    this.o.changed();
    return { ok: true, queued: t.queue.length > 0 };
  }

  async interrupt(sessionId: string): Promise<CommandResult> {
    const t = this.threads.get(sessionId);
    if (!t) return { ok: false, error: "このセッションは見つかりません。" };
    const rpc = this.rpc;
    if (!rpc) return { ok: false, error: "Codex とつながっていません。" };
    t.turnId ??= await this.activeTurn(rpc, sessionId);
    if (!t.turnId) return { ok: false, error: "作業中ではありません。" };
    await rpc.request("turn/interrupt", { threadId: sessionId, turnId: t.turnId });
    return { ok: true };
  }

  async rename(sessionId: string, name: string): Promise<CommandResult> {
    const t = this.threads.get(sessionId);
    if (!t) return { ok: false, error: "このセッションは見つかりません。" };
    const rpc = await this.ensure();
    await rpc.request("thread/name/set", { threadId: sessionId, name });
    this.setName(t, name);
    await this.save();
    this.o.changed();
    return { ok: true };
  }

  /** Takes a session away from Gasho. Its conversation stays with Codex (`codex resume` opens it). */
  async remove(sessionId: string): Promise<CommandResult> {
    const t = this.threads.get(sessionId);
    if (!t) return { ok: false, error: "このセッションは見つかりません。" };
    const rpc = this.rpc;
    if (rpc) {
      const turnId = t.turnId ?? (t.info.status === "busy" || t.info.status === "waiting" ? await this.activeTurn(rpc, sessionId).catch(() => undefined) : undefined);
      if (turnId) await rpc.request("turn/interrupt", { threadId: sessionId, turnId }).catch((e: unknown) => this.o.log(`could not stop the turn of ${sessionId}`, e));
      await rpc.request("thread/unsubscribe", { threadId: sessionId }).catch((e: unknown) => this.o.log(`could not leave the thread ${sessionId}`, e));
    }
    await this.forget(t, "removed");
    return { ok: true };
  }

  /** Answers a request of the session; returns why it cannot be answered. */
  answer(sessionId: string, permissionId: string, decision: PermissionDecision, answers: QuestionAnswer[] | undefined): string | undefined {
    const t = this.threads.get(sessionId);
    const r = t?.pending.get(permissionId);
    if (!t || !r) return "この確認は、すでに答えが出ています。";
    if (!this.rpc) return "Codex とつながっていません。つながり直してから、もう一度答えてください。";
    const reply = replyOf(r, decision, answers);
    if ("error" in reply) return reply.error;
    this.rpc.respond(r.id, reply.result);
    t.pending.delete(permissionId);
    this.o.changed();
    return undefined;
  }

  async page(sessionId: string, before: number | undefined, limit: number): Promise<TranscriptPage> {
    const t = this.threads.get(sessionId);
    if (!t) return { entries: [], start: 0, total: 0, error: "session not found" };
    try {
      await this.ensure();
      await this.readOnce(t);
    } catch (e) {
      return { entries: [], start: 0, total: 0, error: messageOf(e) };
    }
    const entries = t.transcript?.entries ?? [];
    const total = entries.length;
    const end = Math.max(0, Math.min(before ?? total, total));
    const start = Math.max(0, end - limit);
    return { entries: entries.slice(start, end), start, total };
  }

  /** Reads again what is known of the sessions' folders. */
  async refreshDetails(): Promise<void> {
    let changed = false;
    for (const t of this.threads.values()) if (await this.describe(t)) changed = true;
    if (changed) this.o.changed();
  }

  // ---- the connection ----

  private ensure(): Promise<CodexRpc> {
    if (this.rpc?.open) return Promise.resolve(this.rpc);
    this.opening ??= this.open().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async open(): Promise<CodexRpc> {
    const socket = await this.o.startServer();
    // Until it is connected there are no threads loaded in it for it to say anything about.
    let connected: CodexRpc | undefined;
    const rpc = await CodexRpc.connect(socket, this.o.version, {
      notification: (method, params) => this.onNotification(method, params),
      request: (id, method, params) => {
        if (connected) this.onRequest(connected, id, method, params);
      },
      closed: () => {
        if (connected) this.onClosed(connected);
      },
    });
    connected = rpc;
    if (!rpc.open) throw new CodexConnectionClosed("Codex との接続が切れました。");
    this.rpc = rpc;
    this.retryMs = RETRY_MIN_MS;
    await Promise.all([...this.threads.values()].map((t) => this.resume(rpc, t)));
    this.o.changed();
    return rpc;
  }

  private connectInBackground(): void {
    this.ensure().catch((e: unknown) => {
      this.o.log("cannot connect to Codex's app-server", messageOf(e));
      this.retryLater();
    });
  }

  private retryLater(): void {
    if (this.retryTimer || this.threads.size === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.connectInBackground();
    }, this.retryMs);
    this.retryTimer.unref();
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  private onClosed(rpc: CodexRpc): void {
    if (this.rpc !== rpc) return;
    this.rpc = undefined;
    this.o.log("the connection to Codex's app-server ended");
    for (const t of this.threads.values()) {
      t.wasActive = t.info.status === "busy" || t.info.status === "waiting";
      t.info.status = "unknown";
      t.pending.clear();
      delete t.turnId;
    }
    this.o.changed();
    this.retryLater();
  }

  /** Loads a thread into this connection, and catches up with what happened while it was away. */
  private async resume(rpc: CodexRpc, t: ThreadState): Promise<void> {
    const threadId = t.info.sessionId;
    try {
      const r = await rpc.request<{ thread: Record<string, unknown>; model?: string }>("thread/resume", { threadId, excludeTurns: true });
      this.applyThread(t, r.thread, r.model);
      if (t.info.status === "busy" || t.info.status === "waiting") t.turnId = await this.activeTurn(rpc, threadId);
      await this.describe(t);
      if (t.transcript) await this.catchUp(rpc, t);
      if (t.wasActive && t.info.status === "idle") this.event(t, "Stop", { summary: eventSummary(t.said) });
      t.wasActive = false;
      this.flushInBackground(t);
    } catch (e) {
      if (e instanceof CodexRpcError && /no rollout found/.test(e.message)) {
        this.o.log(`Codex no longer has the thread ${threadId}`);
        await this.forget(t, "gone");
      } else {
        this.o.log(`could not load the thread ${threadId}`, messageOf(e));
      }
    }
  }

  private async activeTurn(rpc: CodexRpc, threadId: string): Promise<string | undefined> {
    const r = await rpc.request<{ data?: CodexTurn[] }>("thread/turns/list", { threadId, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    const turn = r.data?.[0];
    return turn?.status === "inProgress" ? turn.id : undefined;
  }

  // ---- what the app-server says ----

  private onNotification(method: string, params: Record<string, unknown>): void {
    const t = typeof params.threadId === "string" ? this.threads.get(params.threadId) : undefined;
    if (!t) return;
    switch (method) {
      case "thread/status/changed":
        t.info.status = sessionStatusOf(params.status as CodexThreadStatus);
        this.flushInBackground(t);
        break;
      case "thread/name/updated":
        this.setName(t, typeof params.threadName === "string" ? params.threadName : undefined);
        void this.save();
        break;
      case "thread/closed":
        if (this.rpc) void this.resume(this.rpc, t);
        return;
      case "turn/started": {
        const turn = params.turn as CodexTurn;
        t.turnId = turn.id;
        delete t.said;
        t.info.lastActivityAt = Date.now();
        this.event(t, "UserPromptSubmit", { summary: eventSummary(t.sentText) });
        delete t.sentText;
        break;
      }
      case "turn/completed":
        this.onTurnEnd(t, params.turn as CodexTurn);
        break;
      case "item/started": {
        const item = params.item as CodexItem;
        if (item.type === "commandExecution" || item.type === "fileChange") t.items.set(item.id, item);
        this.addEntries(t, entriesOfItem(item, "started"));
        break;
      }
      case "item/completed": {
        const item = params.item as CodexItem;
        t.items.delete(item.id);
        if (item.type === "agentMessage" && typeof item.text === "string" && item.text) t.said = item.text;
        t.info.lastActivityAt = Date.now();
        this.addEntries(t, entriesOfItem(item, "completed"));
        break;
      }
      case "serverRequest/resolved":
        // Answered here, in a terminal, or by another client.
        if (!t.pending.delete(`codex-${String(params.requestId)}`)) return;
        break;
      default:
        return;
    }
    this.o.changed();
  }

  private onTurnEnd(t: ThreadState, turn: CodexTurn): void {
    t.lastTurnEnded = turn.id;
    if (t.turnId === turn.id) delete t.turnId;
    t.items.clear();
    t.notified.clear();
    t.info.lastActivityAt = Date.now();
    this.addEntries(t, entriesOfTurnEnd(turn));
    if (turn.status === "completed") this.event(t, "Stop", { summary: eventSummary(t.said ?? lastAgentText(turn.items)) });
    else if (turn.status === "failed") this.event(t, "StopFailure", { summary: eventSummary(turn.error?.message) });
  }

  private onRequest(rpc: CodexRpc, id: string | number, method: string, params: Record<string, unknown>): void {
    const t = typeof params.threadId === "string" ? this.threads.get(params.threadId) : undefined;
    // Another client's thread is that client's to answer.
    if (!t) return;
    const item = typeof params.itemId === "string" ? t.items.get(params.itemId) : undefined;
    const request = requestOf(id, method, params, item, Date.now());
    if (!request) {
      this.o.log(`Codex asked ${method}, which Gasho cannot answer`);
      rpc.respondError(id, NOT_SUPPORTED, `Gasho cannot answer ${method}`);
      return;
    }
    t.pending.set(request.info.id, request);
    if (!t.notified.has(request.info.id)) {
      t.notified.add(request.info.id);
      this.event(t, "Notification", { notificationType: "permission_prompt", toolName: request.info.toolName, summary: request.info.summary });
    }
    this.o.changed();
  }

  // ---- sending ----

  /** Starts a turn with the next input, if the thread can take it; returns why it could not be sent. */
  private async flush(t: ThreadState): Promise<string | undefined> {
    const rpc = this.rpc;
    const text = t.queue[0];
    if (t.sending || !rpc || t.info.status !== "idle" || text === undefined) return undefined;
    t.sending = true;
    try {
      t.sentText = text;
      const r = await rpc.request<{ turn: CodexTurn }>("turn/start", { threadId: t.info.sessionId, input: textInput(text) });
      t.queue.shift();
      if (t.lastTurnEnded !== r.turn.id) {
        t.turnId = r.turn.id;
        if (t.info.status === "idle") t.info.status = "busy";
      }
      return undefined;
    } catch (e) {
      delete t.sentText;
      // Sent again once connected: the thread did not take it, or nothing says that it did.
      if (e instanceof CodexConnectionClosed) return undefined;
      t.queue.shift();
      this.o.log(`Codex did not take the input for ${t.info.sessionId}`, messageOf(e));
      return `Codex が発言を受け付けませんでした：${messageOf(e)}`;
    } finally {
      t.sending = false;
    }
  }

  private flushInBackground(t: ThreadState): void {
    void this.flush(t).then((error) => {
      if (error) this.event(t, "StopFailure", { summary: eventSummary(error) });
      this.o.changed();
    });
  }

  // ---- the conversation ----

  private addEntries(t: ThreadState, entries: TranscriptEntry[]): void {
    if (entries.length === 0) return;
    if (t.loading) t.buffered.push(...entries);
    const added = t.transcript ? entries.filter((e) => !t.transcript!.ids.has(e.uuid)) : entries;
    if (t.transcript) {
      for (const e of added) {
        t.transcript.ids.add(e.uuid);
        t.transcript.entries.push(e);
      }
    }
    if (added.length > 0) this.o.append(t.info.sessionId, added);
  }

  private readOnce(t: ThreadState): Promise<void> {
    if (t.transcript) return Promise.resolve();
    t.loading ??= this.read(t.info.sessionId)
      .then((entries) => {
        const read = known(entries);
        for (const e of t.buffered) {
          if (read.ids.has(e.uuid)) continue;
          read.ids.add(e.uuid);
          read.entries.push(e);
        }
        t.transcript = read;
      })
      .finally(() => {
        t.buffered = [];
        delete t.loading;
      });
    return t.loading;
  }

  /** The whole conversation of a thread, page by page. */
  private async read(threadId: string): Promise<TranscriptEntry[]> {
    const rpc = await this.ensure();
    const turns: CodexTurn[] = [];
    let cursor: string | null | undefined;
    try {
      do {
        const r: { data: CodexTurn[]; nextCursor: string | null } = await rpc.request("thread/turns/list", {
          threadId,
          sortDirection: "asc",
          limit: TURNS_PAGE,
          itemsView: "notLoaded",
          ...(cursor ? { cursor } : {}),
        });
        turns.push(...r.data);
        cursor = r.nextCursor;
      } while (cursor);
    } catch (e) {
      // A thread has no conversation to list until its first message.
      if (e instanceof CodexRpcError && /not materialized/.test(e.message)) return [];
      throw e;
    }
    if (turns.length === 0) return [];
    const items: { turnId: string; item: CodexItem }[] = [];
    cursor = undefined;
    do {
      const r: { data: { turnId: string; item: CodexItem }[]; nextCursor: string | null } = await rpc.request("thread/items/list", {
        threadId,
        limit: ITEMS_PAGE,
        ...(cursor ? { cursor } : {}),
      });
      items.push(...r.data);
      cursor = r.nextCursor;
    } while (cursor);
    return transcriptOf(turns, items);
  }

  /** After a reconnection: what the conversation gained while the connection was gone reaches the browsers. */
  private async catchUp(rpc: CodexRpc, t: ThreadState): Promise<void> {
    const entries = await this.read(t.info.sessionId);
    if (this.rpc !== rpc) return;
    const before = t.transcript?.ids ?? new Set<string>();
    const added = entries.filter((e) => !before.has(e.uuid));
    t.transcript = known(entries);
    const said = [...entries].reverse().find((e) => e.role === "assistant" && e.blocks[0]?.type === "text")?.blocks[0];
    if (said?.type === "text") t.said = said.text;
    if (added.length > 0) this.o.append(t.info.sessionId, added);
  }

  // ---- the sessions ----

  private add(threadId: string, cwd: string, name: string | undefined, launchedAt: number | undefined): ThreadState {
    const at = typeof launchedAt === "number" ? launchedAt : Date.now();
    const t: ThreadState = {
      info: { sessionId: threadId, agent: "codex", cwd, status: "unknown", rcMode: "none", prLinks: [], managed: true, startedAt: at, lastActivityAt: at },
      launchedAt: at,
      queue: [],
      sending: false,
      pending: new Map(),
      notified: new Set(),
      items: new Map(),
      wasActive: false,
      buffered: [],
    };
    this.setName(t, name);
    this.threads.set(threadId, t);
    return t;
  }

  private applyThread(t: ThreadState, thread: Record<string, unknown>, model: string | undefined): void {
    if (typeof thread.cwd === "string") t.info.cwd = thread.cwd;
    if (typeof thread.name === "string" && thread.name) this.setName(t, thread.name);
    if (typeof thread.createdAt === "number") t.info.startedAt = thread.createdAt * 1000;
    if (typeof thread.updatedAt === "number") t.info.lastActivityAt = Math.max(t.info.lastActivityAt ?? 0, thread.updatedAt * 1000);
    if (model) t.info.model = model;
    t.info.status = sessionStatusOf(thread.status as CodexThreadStatus | undefined);
  }

  private setName(t: ThreadState, name: string | undefined): void {
    t.info.name = name;
    t.info.title = name;
  }

  /** Returns whether what is known of the folder changed. */
  private async describe(t: ThreadState): Promise<boolean> {
    const details = await this.o.describe(t.info.cwd).catch(() => undefined);
    if (!details) return false;
    const before = JSON.stringify(t.info);
    Object.assign(t.info, details);
    return JSON.stringify(t.info) !== before;
  }

  private async forget(t: ThreadState, reason: string): Promise<void> {
    this.threads.delete(t.info.sessionId);
    await this.save();
    this.event(t, "SessionEnd", { summary: reason });
    this.o.changed();
  }

  private event(t: ThreadState, event: string, extra: Partial<HookEvent>): void {
    const defined = Object.fromEntries(Object.entries(extra).filter(([, v]) => v !== undefined));
    this.o.event({ sessionId: t.info.sessionId, event, at: Date.now(), cwd: t.info.cwd, ...defined });
  }

  /** One write at a time, renamed over the file, so that an exit while writing leaves the last one. */
  private save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      const list: SavedThread[] = [...this.threads.values()].map((t) => ({
        threadId: t.info.sessionId,
        cwd: t.info.cwd,
        ...(t.info.name ? { name: t.info.name } : {}),
        launchedAt: t.launchedAt,
      }));
      const tmp = `${this.o.file}.tmp`;
      await fsp.writeFile(tmp, `${JSON.stringify(list, null, 2)}\n`, { mode: 0o600 });
      await fsp.rename(tmp, this.o.file);
    }).catch((e: unknown) => this.o.log(`could not save ${this.o.file}`, e));
    return this.saving;
  }
}
