import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import type { AgentInfo, AgentInputConfig, AgentInputSelection, AgentSelector, AskedOption, AskedQuestion, CommandResult, HookEvent, PermissionDecision, PermissionRequestInfo, QuestionAnswer, SessionInfo, TranscriptEntry, TranscriptPage } from "@gasho/protocol";
import { Acp, AGY_LOGIN, object } from "./acp.ts";
import { exec } from "./exec.ts";
import { clip, contextOf, str } from "./util.ts";

const CONNECT_TIMEOUT_MS = 15_000;
// With initialize, reopening must fit in the hub's 45-second antigravity.open window.
const REOPEN_TIMEOUT_MS = 25_000;
export const ANTIGRAVITY_NO_FORK = "Antigravity のセッションは分岐できません。";

export async function detectAntigravity(bin: string): Promise<AgentInfo | undefined> {
  try {
    const { stdout } = await exec(bin, ["--version"], { timeoutMs: 3000 });
    return { status: "unknown", version: stdout.match(/\d+\.\d+\.\d+/)?.[0], canLaunch: true, operations: ["model", "effort"] };
  } catch {
    return undefined;
  }
}

interface Options {
  bin: string;
  file: string;
  catalogFile?: string;
  describe: (cwd: string) => Promise<Partial<SessionInfo>>;
  changed: () => void;
  catalogChanged?: () => void;
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

/** A permission request (the ids of the options for each decision) or a question (what its answers go back as). */
interface Pending {
  id: string | number;
  info: PermissionRequestInfo;
  allow?: string;
  always?: string;
  deny?: string;
  fields?: Field[];
}

interface Field {
  name: string;
  /** What each option of the card stands for; absent for text written by the person. */
  values?: (string | boolean)[];
  multi?: true;
  optional: boolean;
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
  configuring?: true;
  configIds?: Partial<Record<keyof AgentInputSelection, string>>;
  cancelled: boolean;
  pending: Map<string, Pending>;
}

const messageOf = (e: unknown) => e instanceof Error ? e.message : String(e);

// The Gasho server takes no more questions and options than these in an answer.
const MAX_QUESTIONS = 10;
const MAX_OPTIONS = 20;

/**
 * An elicitation's form as questions of Gasho's card; undefined when the card cannot take it whole: another mode,
 * numbers (it has no field that holds a person to one), text with a constraint, or a number of picks to keep to.
 */
function formOf(params: Record<string, unknown>): { questions: AskedQuestion[]; fields: Field[] } | undefined {
  const message = str(params.message);
  const schema = object(params.requestedSchema);
  const properties = Object.entries(object(schema?.properties) ?? {});
  if (params.mode !== "form" || !message || !properties.length || properties.length > MAX_QUESTIONS) return undefined;
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const questions: AskedQuestion[] = [];
  const fields: Field[] = [];
  for (const [i, [name, value]] of properties.entries()) {
    const property = object(value);
    if (!property) return undefined;
    const items = object(property.items);
    const multi = property.type === "array";
    // Titled choices ({ const, title }), or plain values.
    const titled = multi ? items?.anyOf : property.oneOf;
    const plain = multi ? (items?.type === "string" ? items.enum : undefined) : property.enum;
    let choices: { value: string | boolean; option: AskedOption }[] | undefined;
    if (property.type === "boolean") {
      choices = [{ value: true, option: { label: "はい" } }, { value: false, option: { label: "いいえ" } }];
    } else if (property.type === "string" || multi) {
      const list: unknown = titled ?? plain;
      if (Array.isArray(list)) {
        choices = [];
        for (const item of list) {
          const choice: Record<string, unknown> | undefined = titled ? object(item) : { const: item, title: item };
          if (typeof choice?.const !== "string" || typeof choice.title !== "string") return undefined;
          const description = str(choice.description);
          choices.push({ value: choice.const, option: { label: clip(choice.title, 300), ...(description ? { description: clip(description, 2000) } : {}) } });
        }
        if (!choices.length || choices.length > MAX_OPTIONS) return undefined;
        if (multi && (Number(property.minItems ?? 0) > 1 || Number(property.maxItems ?? choices.length) < choices.length)) return undefined;
      } else if (multi || ["minLength", "maxLength", "pattern", "format"].some((k) => property[k] != null)) {
        return undefined;
      }
    } else {
      return undefined;
    }
    const title = str(property.title);
    // Several fields are told apart by their names when they say nothing else about themselves.
    const about = str(property.description) ?? (properties.length > 1 && !title ? name : undefined);
    const optional = !required.includes(name);
    const said = [i === 0 ? message : undefined, about].filter(Boolean).join("\n");
    questions.push({
      question: clip(said || title || name, 4000),
      ...(said && title ? { header: clip(title, 60) } : {}),
      options: choices?.map((c) => c.option) ?? [],
      ...(multi ? { multiSelect: true } : {}),
      ...(choices ? { noOther: true } : {}),
      ...(optional ? { optional: true } : {}),
    });
    fields.push({ name, values: choices?.map((c) => c.value), ...(multi ? { multi: true } : {}), optional });
  }
  return { questions, fields };
}

/** The content that answers a form; a string is why the answers do not fit it. */
function contentOf(fields: Field[], answers: QuestionAnswer[] | undefined): Record<string, unknown> | string {
  if (answers?.length !== fields.length) return "すべての質問に答えてください。";
  const content: [string, unknown][] = [];
  for (const [i, { name, values, multi, optional }] of fields.entries()) {
    const { picked, text } = answers[i]!;
    const fits = values
      ? !text && (multi || picked.length <= 1) && new Set(picked).size === picked.length && picked.every((k) => k < values.length)
      : picked.length === 0;
    if (!fits) return "答えが質問に合っていません。画面を読み込み直してから、もう一度答えてください。";
    if (values ? picked.length === 0 : !text) {
      if (!optional) return "すべての質問に答えてください。";
      continue;
    }
    content.push([name, !values ? text : multi ? picked.map((k) => values[k]) : values[picked[0]!]]);
  }
  return Object.fromEntries(content);
}

export class AntigravitySessions {
  private sessionsById = new Map<string, State>();
  private saving = Promise.resolve();
  launchCatalog?: AgentInputConfig;

  private o: Options;

  constructor(o: Options) {
    this.o = o;
  }

  async load(): Promise<void> {
    if (this.o.catalogFile) {
      try {
        this.launchCatalog = JSON.parse(await fsp.readFile(this.o.catalogFile, "utf8")) as AgentInputConfig;
        this.o.catalogChanged?.();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.o.log("cannot read Antigravity catalog", e);
      }
    }
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

  async launch(cwd: string, name?: string, defaults?: AgentInputSelection): Promise<{ sessionId: string; warning?: string }> {
    const startedAt = Date.now();
    const saved = { id: `antigravity-${randomUUID()}`, remoteId: "", cwd, name, startedAt, lastActivityAt: startedAt, entries: [] };
    const s = this.add(saved);
    try {
      const warning = await this.connect(s, defaults);
      await this.describe(s);
      await this.save();
      this.o.changed();
      return { sessionId: saved.id, ...(warning ? { warning } : {}) };
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

  async input(id: string, text: string, selection?: AgentInputSelection): Promise<CommandResult> {
    const s = this.sessionsById.get(id);
    if (!s) return { ok: false, error: "このセッションは見つかりません。" };
    const connected = await this.open(id);
    if (!connected.ok) return connected;
    if (!s.ready || !s.rpc?.open) return { ok: false, error: "Antigravity との接続が切れました。" };
    let error: string | undefined;
    if (selection) {
      if (s.turning || s.configuring || s.queue.length) {
        return { ok: false, error: "Antigravity が入力を受け付けられる状態になってから、モデルや Effort を切り替えてください。" };
      }
      const rpc = s.rpc;
      s.configuring = true;
      try {
        for (const field of ["model", "effort"] as const) {
          const value = selection[field];
          if (value !== undefined) await this.switchOption(s, rpc, field, value);
        }
        s.queue.unshift(text);
      } catch (e) {
        error = `Antigravity の設定を切り替えられませんでした：${messageOf(e)}`;
      } finally {
        delete s.configuring;
      }
    } else {
      s.queue.push(text);
    }
    this.next(s);
    this.o.changed();
    return error ? { ok: false, error } : { ok: true, queued: s.queue.length > 0 };
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

  answer(id: string, permissionId: string, decision: PermissionDecision, answers?: QuestionAnswer[]): CommandResult {
    const s = this.sessionsById.get(id);
    const p = s?.pending.get(permissionId);
    if (!s?.rpc?.open || !p) return { ok: false, error: "この確認は、すでに終了しています。" };
    const unusable = { ok: false, error: "この確認では、その選択肢を使えません。" };
    if (p.fields) {
      if (decision === "always") return unusable;
      const content = decision === "allow" ? contentOf(p.fields, answers) : undefined;
      if (typeof content === "string") return { ok: false, error: content };
      s.rpc.respond(p.id, content ? { action: "accept", content } : { action: "decline" });
    } else {
      const optionId = p[decision];
      if (decision !== "deny" && optionId === undefined) return unusable;
      s.rpc.respond(p.id, { outcome: optionId !== undefined ? { outcome: "selected", optionId } : { outcome: "cancelled" } });
    }
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
    s.opening ??= this.connect(s).then(() => undefined).finally(() => { delete s.opening; });
    return s.opening;
  }

  private async switchOption(s: State, rpc: Acp, field: keyof AgentInputSelection, value: string, timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    const configId = s.configIds?.[field];
    const selector = s.info.agentConfig?.[field];
    const label = field === "model" ? "モデル" : "Effort";
    if (configId === undefined || !selector?.options.some((o) => o.id === value)) {
      throw new Error(`指定した${label}は選べません。`);
    }
    if (selector.current === value) return;
    const result = object(await rpc.request("session/set_config_option", {
      sessionId: s.saved.remoteId, configId, value,
    }, timeoutMs));
    if (!rpc.open || s.rpc !== rpc) throw new Error("Antigravity との接続が切れました。");
    this.applyConfig(s, result?.configOptions);
    if (s.info.agentConfig?.[field]?.current !== value) {
      throw new Error(`指定した${label}に切り替わりませんでした。`);
    }
  }

  private async connect(s: State, defaults?: AgentInputSelection): Promise<string | undefined> {
    const { cwd, remoteId } = s.saved;
    const rpc = new Acp(this.o.bin, cwd, (method, params, id) => this.receive(s, rpc, method, params, id), () => {
      if (s.rpc !== rpc) return;
      s.ready = false;
      this.applyConfig(s, undefined);
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
      const init = object(await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } }, CONNECT_TIMEOUT_MS));
      if (init?.protocolVersion !== 1) throw new Error("Antigravity が ACP v1 に対応していません。");
      const params = { cwd, mcpServers: [] };
      let result: Record<string, unknown> | undefined;
      if (!remoteId) {
        result = object(await rpc.request("session/new", params, CONNECT_TIMEOUT_MS));
        if (typeof result?.sessionId !== "string" || !result.sessionId) throw new Error("Antigravity からセッション ID が返りませんでした。");
        s.saved.remoteId = result.sessionId;
      } else {
        const capabilities = object(init.agentCapabilities);
        if (capabilities?.loadSession === true) {
          s.replay = [];
          result = object(await rpc.request("session/load", { ...params, sessionId: remoteId }, REOPEN_TIMEOUT_MS));
          this.flushChunk(s);
          if (s.replay.length > 0) {
            // A replay from ACP cannot include text Gasho never sent.
            s.saved.entries = [...s.replay, ...s.saved.entries.filter((entry) => entry.discardedInput)];
            this.o.append(s.saved.id, [], true);
            await this.save();
          }
        } else if (object(object(capabilities?.sessionCapabilities)?.resume)) {
          result = object(await rpc.request("session/resume", { ...params, sessionId: remoteId }, REOPEN_TIMEOUT_MS));
        } else {
          throw new Error("この Antigravity は保存済みの会話を再開できません。新しいセッションを起動してください。");
        }
      }
      if (!rpc.open || s.rpc !== rpc) throw new Error("Antigravity との接続が切れました。");
      if (Array.isArray(result?.configOptions)) this.applyConfig(s, result.configOptions, !remoteId);
      const warnings: string[] = [];
      if (!remoteId && defaults) {
        for (const field of ["model", "effort"] as const) {
          const value = defaults[field];
          if (value === undefined) continue;
          try {
            // Both switches must fit in the hub's remaining launch window after initialize and session/new.
            await this.switchOption(s, rpc, field, value, 5_000);
          } catch (e) {
            warnings.push(`既定の${field === "model" ? "モデル" : " Effort"}（${value}）を適用できませんでした。 ${messageOf(e)}`);
          }
        }
      }
      s.ready = rpc.open;
      this.updateStatus(s);
      return warnings.length ? warnings.join(" ") : undefined;
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
      if (method === "elicitation/create") return this.ask(s, rpc, params, id);
      if (method !== "session/request_permission") return rpc.unsupported(id);
      const tool = object(params.toolCall);
      if (!tool || !Array.isArray(params.options)) return rpc.unsupported(id);
      if (!s.turning || s.cancelled) return rpc.respond(id, { outcome: { outcome: "cancelled" } });
      const options = params.options.map(object);
      const optionOf = (kind: string) => options.find((o) => o?.kind === kind && typeof o.optionId === "string");
      const allow = optionOf("allow_once")?.optionId as string | undefined;
      const always = optionOf("allow_always");
      const deny = optionOf("reject_once")?.optionId as string | undefined;
      const toolName = typeof tool.title === "string" ? tool.title.slice(0, 200) : "Antigravity";
      const info = {
        id: randomUUID(),
        toolName,
        input: (JSON.stringify(tool.rawInput, null, 2) ?? "").slice(0, 2000),
        at: Date.now(),
        ...(always ? { always: clip(str(always.name) ?? String(always.optionId), 200) } : {}),
        ...(allow === undefined ? { denyOnly: true } : {}),
      };
      this.wait(s, { id, info, allow, always: always?.optionId as string | undefined, deny }, toolName);
      return;
    }
    if (method !== "session/update") return;
    const update = object(params.update);
    if (update?.sessionUpdate === "config_option_update") {
      this.applyConfig(s, update.configOptions);
      if (s.ready) this.o.changed();
      return;
    }
    // `used` is what is in the context, not what was used up, so it is not counted in the tokens per day.
    if (update?.sessionUpdate === "usage_update") {
      const { used, size } = update;
      if (typeof used === "number" && typeof size === "number" && size > 0) s.info.context = contextOf(s.info.context, used, size);
      const cost = object(update.cost);
      // Other units ("credits") are not shown: SessionInfo holds only US dollars.
      if (cost?.currency === "USD" && typeof cost.amount === "number") s.info.costUSD = cost.amount;
      if (s.ready) this.o.changed();
      return;
    }
    if (!s.replay && !s.turning) return;
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

  private ask(s: State, rpc: Acp, params: Record<string, unknown>, id: string | number): void {
    if (!s.turning || s.cancelled) return rpc.respond(id, { action: "cancel" });
    const form = formOf(params);
    if (!form) {
      // Not "decline": that would say the person turned the question down.
      rpc.invalidParams(id);
      this.flushChunk(s);
      this.record(s, "system", [{ type: "text", text: `Antigravity の質問は、Gasho の画面で答えられない形のため断りました。\n${clip(str(params.message) ?? "", 4000)}` }]);
      void this.save();
      return;
    }
    const summary = clip(str(params.message)!, 200);
    const info = {
      id: randomUUID(),
      toolName: "AskUserQuestion",
      input: clip(JSON.stringify(params.requestedSchema, null, 2), 4000),
      summary,
      at: Date.now(),
      questions: form.questions,
    };
    this.wait(s, { id, info, fields: form.fields }, summary);
  }

  private wait(s: State, pending: Pending, summary: string): void {
    this.flushChunk(s);
    s.pending.set(pending.info.id, pending);
    this.updateStatus(s);
    this.event(s, "Notification", { notificationType: "permission_prompt", toolName: pending.info.toolName, summary });
  }

  private applyConfig(s: State, value: unknown, newSession = false): void {
    delete s.info.agentConfig;
    delete s.configIds;
    delete s.info.model;
    if (!Array.isArray(value)) return;
    const config: AgentInputConfig = {};
    const ids: NonNullable<State["configIds"]> = {};
    for (const entry of value) {
      const option = object(entry);
      if (option?.type !== "select" || typeof option.id !== "string" || typeof option.currentValue !== "string" || !Array.isArray(option.options)) continue;
      const field = option.category === "model" ? "model" : option.category === "thought_level" ? "effort" : undefined;
      if (!field) continue;
      const choices: AgentSelector["options"] = [];
      for (const item of option.options.flatMap((v: unknown) => {
        const group = object(v);
        return Array.isArray(group?.options) ? group.options : [v];
      })) {
        const choice = object(item);
        if (typeof choice?.value === "string" && typeof choice.name === "string") {
          choices.push({ id: choice.value, name: choice.name, description: typeof choice.description === "string" ? choice.description : undefined });
        }
      }
      if (!choices.length) continue;
      ids[field] = option.id;
      config[field] = { current: option.currentValue, options: choices };
    }
    if (config.model || config.effort) {
      s.info.agentConfig = config;
      s.configIds = ids;
    }
    const model = config.model;
    if (model) s.info.model = model.options.find((m) => m.id === model.current)?.name ?? model.current;
    const before = this.launchCatalog;
    const catalog: AgentInputConfig = {
      model: model ? {
        current: newSession ? model.current : before?.model?.current,
        options: model.options.map((choice) => ({
          ...choice,
          efforts: choice.id === model.current
            ? config.effort?.options
            : before?.model?.options.find((m) => m.id === choice.id)?.efforts,
        })),
      } : before?.model,
      effort: model ? undefined : config.effort,
    };
    if (JSON.stringify(catalog) !== JSON.stringify(before)) {
      this.launchCatalog = catalog;
      this.o.catalogChanged?.();
      if (this.o.catalogFile) void this.write(this.o.catalogFile, () => catalog);
    }
  }

  private cancelPermissions(s: State): void {
    for (const p of s.pending.values()) s.rpc?.respond(p.id, p.fields ? { action: "cancel" } : { outcome: { outcome: "cancelled" } });
    s.pending.clear();
  }

  private next(s: State): void {
    const rpc = s.rpc;
    if (s.turning || s.configuring || !s.ready || !rpc?.open || s.queue.length === 0) return;
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
    return this.write(this.o.file, () => [...this.sessionsById.values()].filter((s) => s.saved.remoteId).map((s) => s.saved));
  }

  private write(file: string, value: () => unknown): Promise<void> {
    this.saving = this.saving.then(async () => {
      const tmp = file + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(value()), { mode: 0o600 });
      await fsp.rename(tmp, file);
    }).catch((e: unknown) => this.o.log(`cannot save ${file}`, e));
    return this.saving;
  }
}
