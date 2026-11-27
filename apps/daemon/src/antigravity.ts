import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import type { AgentInfo, CommandResult, HookEvent, PermissionDecision, PermissionRequestInfo, SessionInfo, TranscriptEntry, TranscriptPage } from "@gasho/protocol";
import { Acp, AGY_LOGIN, object } from "./acp.ts";
import { exec } from "./exec.ts";

const CONNECT_TIMEOUT_MS = 15_000;
// With initialize, reopening must fit in the hub's 45-second antigravity.open window.
const REOPEN_TIMEOUT_MS = 25_000;
export const ANTIGRAVITY_NO_FORK = "Antigravity のセッションは分岐できません。";

export async function detectAntigravity(bin: string): Promise<AgentInfo | undefined> {
  try {
    const { stdout } = await exec(bin, ["--version"], { timeoutMs: 3000 });
    return { status: "unknown", version: stdout.match(/\d+\.\d+\.\d+/)?.[0], canLaunch: true, operations: [] };
  } catch {
    return undefined;
  }
}

interface Options {
  bin: string;
  file: string;
  describe: (cwd: string) => Promise<Partial<SessionInfo>>;
  changed: () => void;
  event: (event: HookEvent) => void;
  append: (id: string, entries: TranscriptEntry[], reset?: true) => void;
  log: (...args: unknown[]) => void;
}

type SavedEntry = TranscriptEntry & { discardedInput?: true };

interface Saved {
  id: string;
  remoteId: string;
  cwd: string;
  name?: string;
  startedAt: number;
  lastActivityAt: number;
  entries: SavedEntry[];
}

interface Pending {
  id: string | number;
  info: PermissionRequestInfo;
  allow?: string;
  deny?: string;
}

interface State {
  saved: Saved;
  info: SessionInfo;
  rpc?: Acp;
  ready: boolean;
  opening?: Promise<void>;
  replay?: TranscriptEntry[];
  chunk?: { role: "user" | "assistant"; text: string };
  queue: string[];
  turning: boolean;
  cancelled: boolean;
  pending: Map<string, Pending>;
}

const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

export class AntigravitySessions {
  private sessionsById = new Map<string, State>();
  private saving = Promise.resolve();

  private o: Options;

  constructor(o: Options) {
    this.o = o;
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await fsp.readFile(this.o.file, "utf8")) as Saved[];
      for (const s of saved) {
        const state = this.add(s);
        await this.describe(state);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.o.log("cannot read Antigravity sessions", e);
    }
  }

  sessions(): SessionInfo[] {
    return [...this.sessionsById.values()].filter((s) => s.saved.remoteId).map((s) => ({
      ...s.info,
      pendingInputs: s.queue.length || undefined,
      permissionRequests: s.pending.size ? [...s.pending.values()].map((p) => p.info) : undefined,
    }));
  }

  has(id: string): boolean {
    return this.sessionsById.has(id);
  }

  cwdOf(id: string): string | undefined {
    return this.sessionsById.get(id)?.saved.cwd;
  }

  waitingInputs(): number {
    return [...this.sessionsById.values()].reduce((count, s) => count + s.queue.length, 0);
  }

  async refreshDetails(): Promise<void> {
    for (const s of this.sessionsById.values()) await this.describe(s);
    if (this.sessionsById.size) this.o.changed();
  }

  async launch(cwd: string, name?: string): Promise<string> {
    const startedAt = Date.now();
    const saved = { id: `antigravity-${randomUUID()}`, remoteId: "", cwd, name, startedAt, lastActivityAt: startedAt, entries: [] };
    const s = this.add(saved);
    try {
      await this.connect(s);
      await this.describe(s);
      await this.save();
      this.o.changed();
      return saved.id;
    } catch (e) {
      this.sessionsById.delete(saved.id);
      throw e;
    }
  }

  async open(id: string): Promise<CommandResult> {
    const s = this.sessionsById.get(id);
    if (!s) return { ok: false, error: "このセッションは見つかりません。" };
    try {
      await this.ensure(s);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: messageOf(e) };
    }
  }

  async input(id: string, text: string): Promise<CommandResult> {
    const s = this.sessionsById.get(id);
    if (!s) return { ok: false, error: "このセッションは見つかりません。" };
    const connected = await this.open(id);
    if (!connected.ok) return connected;
    if (!s.ready || !s.rpc?.open) return { ok: false, error: "Antigravity との接続が切れました。" };
    s.queue.push(text);
    this.next(s);
    this.o.changed();
    return { ok: true, queued: s.queue.length > 0 };
  }

  interrupt(id: string): CommandResult {
    const s = this.sessionsById.get(id);
    if (!s?.rpc?.open || !s.turning) return { ok: false, error: "作業中ではありません。" };
    s.cancelled = true;
    s.rpc.notify("session/cancel", { sessionId: s.saved.remoteId });
    this.cancelPermissions(s);
    this.o.changed();
    return { ok: true };
  }

  answer(id: string, permissionId: string, decision: PermissionDecision): CommandResult {
    const s = this.sessionsById.get(id);
    const p = s?.pending.get(permissionId);
    if (!s?.rpc?.open || !p) return { ok: false, error: "この確認は、すでに終了しています。" };
    if (decision === "always" || (decision === "allow" && p.allow === undefined)) {
      return { ok: false, error: "この確認では、その選択肢を使えません。" };
    }
    const optionId = decision === "allow" ? p.allow : p.deny;
    s.rpc.respond(p.id, { outcome: optionId !== undefined ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
    s.pending.delete(permissionId);
    this.updateStatus(s);
    return { ok: true };
  }

  async rename(id: string, name: string): Promise<CommandResult> {
    const s = this.sessionsById.get(id)!;
    s.saved.name = s.info.name = name;
    await this.save();
    this.o.changed();
    return { ok: true };
  }

  async remove(id: string): Promise<CommandResult> {
    const s = this.sessionsById.get(id)!;
    this.sessionsById.delete(id);
    s.queue.length = 0;
    this.closeSession(s);
    await this.save();
    this.o.changed();
    return { ok: true };
  }

  async close(): Promise<void> {
    for (const s of this.sessionsById.values()) this.closeSession(s);
    await this.saving;
  }

  page(id: string, before: number | undefined, limit: number): TranscriptPage {
    const entries = this.sessionsById.get(id)?.saved.entries ?? [];
    const total = entries.length;
    const end = Math.max(0, Math.min(before ?? total, total));
    const start = Math.max(0, end - limit);
    return { entries: entries.slice(start, end), start, total };
  }

  private add(saved: Saved): State {
    const s: State = {
      saved,
      info: { sessionId: saved.id, agent: "antigravity", cwd: saved.cwd, name: saved.name, status: "unknown", managed: true, startedAt: saved.startedAt, lastActivityAt: saved.lastActivityAt, rcMode: "none", prLinks: [] },
      ready: false,
      queue: [],
      turning: false,
      cancelled: false,
      pending: new Map(),
    };
    this.sessionsById.set(saved.id, s);
    return s;
  }

  private async describe(s: State): Promise<void> {
    Object.assign(s.info, await this.o.describe(s.saved.cwd));
  }

  private ensure(s: State): Promise<void> {
    if (s.ready && s.rpc?.open) return Promise.resolve();
    s.opening ??= this.connect(s).finally(() => { delete s.opening; });
    return s.opening;
  }

  private async connect(s: State): Promise<void> {
    const { cwd, remoteId } = s.saved;
    const rpc = new Acp(this.o.bin, cwd, (method, params, id) => this.receive(s, rpc, method, params, id), () => {
      if (s.rpc !== rpc) return;
      s.ready = false;
      s.pending.clear();
      const discarded = s.queue.splice(0);
      if (discarded.length) {
        this.flushChunk(s);
        for (const text of discarded) {
          this.record(s, "system", [
            { type: "text", text: "Antigravity との接続が切れたため、次の送信待ちの発言を破棄しました。" },
            { type: "text", text },
          ], { discardedInput: true });
        }
        void this.save();
      }
      this.updateStatus(s);
    });
    s.rpc = rpc;
    try {
      const init = object(await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, CONNECT_TIMEOUT_MS));
      if (init?.protocolVersion !== 1) throw new Error("Antigravity が ACP v1 に対応していません。");
      const params = { cwd, mcpServers: [] };
      if (!remoteId) {
        const result = object(await rpc.request("session/new", params, CONNECT_TIMEOUT_MS));
        if (typeof result?.sessionId !== "string" || !result.sessionId) throw new Error("Antigravity からセッション ID が返りませんでした。");
        s.saved.remoteId = result.sessionId;
      } else {
        const capabilities = object(init.agentCapabilities);
        if (capabilities?.loadSession === true) {
          s.replay = [];
          await rpc.request("session/load", { ...params, sessionId: remoteId }, REOPEN_TIMEOUT_MS);
          this.flushChunk(s);
          if (s.replay.length > 0) {
            // A replay from ACP cannot include text Gasho never sent.
            s.saved.entries = [...s.replay, ...s.saved.entries.filter((entry) => entry.discardedInput)];
            this.o.append(s.saved.id, [], true);
            await this.save();
          }
        } else if (object(object(capabilities?.sessionCapabilities)?.resume)) {
          await rpc.request("session/resume", { ...params, sessionId: remoteId }, REOPEN_TIMEOUT_MS);
        } else {
          throw new Error("この Antigravity は保存済みの会話を再開できません。新しいセッションを起動してください。");
        }
      }
      if (!rpc.open || s.rpc !== rpc) throw new Error("Antigravity との接続が切れました。");
      s.ready = true;
      this.updateStatus(s);
    } catch (e) {
      rpc.close();
      throw e;
    } finally {
      delete s.replay;
      delete s.chunk;
    }
  }

  private closeSession(s: State): void {
    const rpc = s.rpc;
    s.ready = false;
    delete s.rpc;
    rpc?.close();
  }

  private receive(s: State, rpc: Acp, method: string, value: unknown, id?: string | number): void {
    if (s.rpc !== rpc) return;
    const params = object(value);
    if (!params || !s.saved.remoteId || params.sessionId !== s.saved.remoteId) {
      if (id !== undefined) rpc.unsupported(id);
      return;
    }
    if (id !== undefined) {
      if (method !== "session/request_permission") return rpc.unsupported(id);
      const tool = object(params.toolCall);
      if (!tool || !Array.isArray(params.options)) return rpc.unsupported(id);
      if (!s.turning || s.cancelled) return rpc.respond(id, { outcome: { outcome: "cancelled" } });
      const options = params.options.map(object);
      const allow = options.find((o) => o?.kind === "allow_once" && typeof o.optionId === "string")?.optionId as string | undefined;
      const deny = options.find((o) => o?.kind === "reject_once" && typeof o.optionId === "string")?.optionId as string | undefined;
      const toolName = typeof tool.title === "string" ? tool.title.slice(0, 200) : "Antigravity";
      const info = {
        id: randomUUID(),
        toolName,
        input: (JSON.stringify(tool.rawInput, null, 2) ?? "").slice(0, 2000),
        at: Date.now(),
        ...(allow === undefined ? { denyOnly: true } : {}),
      };
      this.flushChunk(s);
      s.pending.set(info.id, { id, info, allow, deny });
      this.updateStatus(s);
      this.event(s, "Notification", { notificationType: "permission_prompt", toolName, summary: toolName });
      return;
    }
    if (method !== "session/update" || (!s.replay && !s.turning)) return;
    const update = object(params.update);
    const content = object(update?.content);
    const kind = update?.sessionUpdate;
    if ((kind === "agent_message_chunk" || (s.replay && kind === "user_message_chunk")) && content?.type === "text" && typeof content.text === "string") {
      const role = kind === "user_message_chunk" ? "user" : "assistant";
      if (s.chunk?.role !== role) this.flushChunk(s);
      s.chunk ??= { role, text: "" };
      s.chunk.text += content.text;
    } else if (kind === "tool_call" && typeof update?.title === "string" && typeof update.toolCallId === "string") {
      this.flushChunk(s);
      this.record(s, "assistant", [{
        type: "tool_use", id: update.toolCallId, name: update.title.slice(0, 200),
        input: (JSON.stringify(update.rawInput, null, 2) ?? "").slice(0, 4000),
      }]);
    } else if (kind === "tool_call_update" && typeof update?.toolCallId === "string" && (update.status === "completed" || update.status === "failed")) {
      this.flushChunk(s);
      this.record(s, "assistant", [{
        type: "tool_result", toolUseId: update.toolCallId, isError: update.status === "failed",
        content: (JSON.stringify(update.rawOutput, null, 2) ?? "").slice(0, 4000),
      }]);
    }
  }

  private cancelPermissions(s: State): void {
    for (const p of s.pending.values()) s.rpc?.respond(p.id, { outcome: { outcome: "cancelled" } });
    s.pending.clear();
  }

  private next(s: State): void {
    const rpc = s.rpc;
    if (s.turning || !s.ready || !rpc?.open || s.queue.length === 0) return;
    const text = s.queue.shift()!;
    s.turning = true;
    s.cancelled = false;
    this.updateStatus(s);
    this.record(s, "user", [{ type: "text", text }]);
    this.event(s, "UserPromptSubmit", { summary: text.slice(0, 200) });
    void this.save();
    void (async () => {
      try {
        const result = object(await rpc.request("session/prompt", { sessionId: s.saved.remoteId, prompt: [{ type: "text", text }] }));
        if (typeof result?.stopReason !== "string") throw new Error("Antigravity からターン終了の理由が返りませんでした。");
        const summary = s.chunk?.text.slice(0, 200);
        this.flushChunk(s);
        if (result.stopReason === "cancelled") this.record(s, "system", [{ type: "text", text: "割り込まれました" }], { interrupted: true });
        else this.event(s, "Stop", { summary });
      } catch (e) {
        if (s.rpc === rpc) {
          const error = messageOf(e);
          this.flushChunk(s);
          this.record(s, "system", [{ type: "text", text: error }]);
          this.event(s, "StopFailure", { summary: error.slice(0, 200) });
          if (error === AGY_LOGIN) rpc.close();
        }
      } finally {
        this.cancelPermissions(s);
        s.turning = false;
        if (s.rpc === rpc) {
          void this.save();
          this.updateStatus(s);
          this.next(s);
        }
      }
    })();
  }

  private flushChunk(s: State): void {
    if (!s.chunk) return;
    this.record(s, s.chunk.role, [{ type: "text", text: s.chunk.text }]);
    delete s.chunk;
  }

  private record(s: State, role: TranscriptEntry["role"], blocks: TranscriptEntry["blocks"], flags?: Pick<SavedEntry, "interrupted" | "discardedInput">): void {
    const entry = { uuid: randomUUID(), ts: new Date().toISOString(), role, blocks, ...flags };
    if (s.replay) {
      s.replay.push(entry);
      return;
    }
    if (!this.has(s.saved.id)) return;
    s.saved.entries.push(entry);
    this.o.append(s.saved.id, [entry]);
  }

  private updateStatus(s: State): void {
    s.info.status = !s.ready ? "unknown" : s.pending.size ? "waiting" : s.turning ? "busy" : "idle";
    s.info.waitingFor = s.pending.size ? "permission prompt" : undefined;
    this.o.changed();
  }

  private event(s: State, event: string, fields: Partial<HookEvent>): void {
    if (!this.has(s.saved.id)) return;
    const { id, cwd } = s.saved;
    s.info.lastActivityAt = s.saved.lastActivityAt = Date.now();
    this.o.event({ sessionId: id, cwd, event, at: s.saved.lastActivityAt, ...fields });
  }

  private save(): Promise<void> {
    this.saving = this.saving.then(async () => {
      const tmp = this.o.file + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify([...this.sessionsById.values()].filter((s) => s.saved.remoteId).map((s) => s.saved)), { mode: 0o600 });
      await fsp.rename(tmp, this.o.file);
    }).catch((e: unknown) => this.o.log("cannot save Antigravity sessions", e));
    return this.saving;
  }
}
