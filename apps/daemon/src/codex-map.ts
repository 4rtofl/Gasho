// What Codex's app-server says, in Gasho's terms: a thread's status, the items of its conversation, and the approvals it
// asks for. Only the fields used here are typed; `codex app-server generate-ts` gives the whole protocol.
import type { AskedQuestion, PermissionDecision, PermissionRequestInfo, QuestionAnswer, SessionStatus, TokenUsage, TranscriptEntry } from "@gasho/protocol";
import { clip } from "./util.ts";

/** As for Claude Code's transcripts (transcript.ts). */
const MAX_TEXT = 40000;
const MAX_TOOL = 2000;
const MAX_SUMMARY = 300;

export interface CodexThreadStatus {
  type: string;
  activeFlags?: string[];
}

export interface CodexItem {
  type: string;
  id: string;
  startedAtMs?: number | null;
  completedAtMs?: number | null;
  [field: string]: unknown;
}

export interface CodexTurn {
  id: string;
  status: string;
  error?: { message?: string } | null;
  startedAt?: number | null;
  completedAt?: number | null;
  items?: CodexItem[];
}

/** idle, busy, or waiting for an answer. After a system error the thread takes the next input, as an idle one does. */
export function sessionStatusOf(status: CodexThreadStatus | undefined): SessionStatus {
  switch (status?.type) {
    case "idle":
    case "systemError":
      return "idle";
    case "active":
      return status.activeFlags?.some((f) => f === "waitingOnApproval" || f === "waitingOnUserInput") ? "waiting" : "busy";
    default:
      return "unknown";
  }
}

/** What turn/start takes as the text of an input. */
export function textInput(text: string): { type: "text"; text: string; text_elements: never[] }[] {
  return [{ type: "text", text, text_elements: [] }];
}

const tsOf = (ms: number | null | undefined): string | undefined => (typeof ms === "number" ? new Date(ms).toISOString() : undefined);
const withTs = (ts: string | undefined) => (ts ? { ts } : {});

function toolUse(item: CodexItem, name: string, input: unknown): TranscriptEntry {
  return {
    uuid: `${item.id}:use`,
    ...withTs(tsOf(item.startedAtMs)),
    role: "assistant",
    blocks: [{ type: "tool_use", id: item.id, name, input: clip(JSON.stringify(input), MAX_TOOL) }],
  };
}

function toolResult(item: CodexItem, content: string, isError: boolean): TranscriptEntry {
  return {
    uuid: `${item.id}:result`,
    ...withTs(tsOf(item.completedAtMs ?? item.startedAtMs)),
    role: "user",
    blocks: [{ type: "tool_result", toolUseId: item.id, content: clip(content, MAX_TOOL), isError }],
  };
}

interface FileChange {
  path?: unknown;
  kind?: { type?: unknown } | null;
  diff?: unknown;
}

const changesOf = (item: CodexItem): FileChange[] => (Array.isArray(item.changes) ? (item.changes as FileChange[]) : []);

function fileChangeInput(item: CodexItem): unknown {
  return { changes: changesOf(item).map((c) => ({ path: c.path, kind: c.kind?.type, diff: c.diff })) };
}

const refused = (status: unknown) => status === "failed" || status === "declined";

/**
 * The entries of an item. A command and a file change show as a call when they start, and their result when they end;
 * the rest shows once it is complete. Reasoning is not shown.
 */
export function entriesOfItem(item: CodexItem, phase: "started" | "completed"): TranscriptEntry[] {
  const ts = withTs(tsOf(item.startedAtMs));
  switch (item.type) {
    case "commandExecution": {
      const use = toolUse(item, "Bash", { command: item.command });
      if (phase === "started" || item.status === "inProgress") return [use];
      const failed = refused(item.status) || (typeof item.exitCode === "number" && item.exitCode !== 0);
      return [use, toolResult(item, typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "", failed)];
    }
    case "fileChange": {
      const use = toolUse(item, "apply_patch", fileChangeInput(item));
      if (phase === "started" || item.status === "inProgress") return [use];
      return [use, toolResult(item, changesOf(item).map((c) => String(c.path)).join("\n"), refused(item.status))];
    }
    case "userMessage": {
      if (phase === "started") return [];
      const content = Array.isArray(item.content) ? (item.content as { type?: unknown; text?: unknown }[]) : [];
      const text = content.flatMap((c) => (c.type === "text" && typeof c.text === "string" ? [c.text] : [])).join("\n");
      return text ? [{ uuid: item.id, ...ts, role: "user", blocks: [{ type: "text", text: clip(text, MAX_TEXT) }] }] : [];
    }
    case "agentMessage": {
      if (phase === "started" || typeof item.text !== "string" || !item.text) return [];
      return [{ uuid: item.id, ...ts, role: "assistant", blocks: [{ type: "text", text: clip(item.text, MAX_TEXT) }] }];
    }
    case "reasoning":
      return [];
    default: {
      if (phase === "started") return [];
      const { type: _type, id: _id, startedAtMs: _started, completedAtMs: _completed, ...input } = item;
      return [{ ...toolUse(item, item.type, input), uuid: item.id }];
    }
  }
}

/** What a turn's end adds to the conversation: the mark of an interrupted turn, the error of a failed one. */
export function entriesOfTurnEnd(turn: CodexTurn): TranscriptEntry[] {
  const ts = withTs(tsOf(typeof turn.completedAt === "number" ? turn.completedAt * 1000 : undefined));
  if (turn.status === "interrupted") {
    return [{ uuid: `${turn.id}:interrupted`, ...ts, role: "user", blocks: [{ type: "text", text: "[Request interrupted by user]" }], interrupted: true }];
  }
  if (turn.status === "failed" && turn.error?.message) {
    return [{ uuid: `${turn.id}:error`, ...ts, role: "system", blocks: [{ type: "text", text: clip(turn.error.message, MAX_TEXT) }] }];
  }
  return [];
}

/** A whole conversation, from its turns and its items (each of them in order). */
export function transcriptOf(turns: CodexTurn[], items: { turnId: string; item: CodexItem }[]): TranscriptEntry[] {
  const ofTurn = new Map<string, CodexItem[]>();
  for (const { turnId, item } of items) ofTurn.set(turnId, [...(ofTurn.get(turnId) ?? []), item]);
  const entries: TranscriptEntry[] = [];
  for (const turn of turns) {
    for (const item of ofTurn.get(turn.id) ?? []) entries.push(...entriesOfItem(item, "completed"));
    entries.push(...entriesOfTurnEnd(turn));
  }
  return entries;
}

/** The last thing the agent said in a turn. */
export function lastAgentText(items: CodexItem[] | undefined): string | undefined {
  const said = (items ?? []).filter((i) => i.type === "agentMessage" && typeof i.text === "string" && i.text);
  return said.at(-1)?.text as string | undefined;
}

export const eventSummary = (text: string | undefined): string | undefined => (text ? clip(text, MAX_SUMMARY) : undefined);

/** An approval or a question Codex waits for an answer to. */
export interface CodexRequest {
  /** The JSON-RPC id to answer. */
  id: string | number;
  method: string;
  params: Record<string, unknown>;
  info: PermissionRequestInfo;
}

interface AskedInput {
  id: string;
  header?: string;
  question: string;
  options?: { label: string; description?: string }[] | null;
}

const asked = (params: Record<string, unknown>): AskedInput[] => (Array.isArray(params.questions) ? (params.questions as AskedInput[]) : []);

/**
 * The request as Gasho's cards show it; undefined for one they cannot answer. `item`: the item it is about, as it
 * started (a file change's request does not say what it changes).
 */
export function requestOf(id: string | number, method: string, params: Record<string, unknown>, item: CodexItem | undefined, now: number): CodexRequest | undefined {
  const base = { id: `codex-${id}`, at: now };
  const reason = typeof params.reason === "string" && params.reason ? { reason: params.reason } : {};
  const made = (info: PermissionRequestInfo): CodexRequest => ({ id, method, params, info });
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const command = typeof params.command === "string" ? params.command : "";
      const amendment = params.proposedExecpolicyAmendment;
      const always = Array.isArray(amendment) && amendment.length > 0 ? { always: amendment.join(" ") } : {};
      return made({ ...base, toolName: "Bash", input: clip(JSON.stringify({ command, cwd: params.cwd, ...reason }, null, 2), MAX_TOOL), summary: clip(command, MAX_SUMMARY), ...always });
    }
    case "item/fileChange/requestApproval": {
      const changes = item ? changesOf(item) : [];
      const summary = changes.map((c) => String(c.path)).join(", ");
      return made({ ...base, toolName: "apply_patch", input: clip(JSON.stringify({ ...(item ? (fileChangeInput(item) as object) : {}), ...reason }, null, 2), MAX_TOOL), ...(summary ? { summary: clip(summary, MAX_SUMMARY) } : {}) });
    }
    case "item/permissions/requestApproval": {
      const summary = typeof params.reason === "string" ? params.reason : "";
      return made({ ...base, toolName: "Permissions", input: clip(JSON.stringify({ permissions: params.permissions, cwd: params.cwd, ...reason }, null, 2), MAX_TOOL), ...(summary ? { summary: clip(summary, MAX_SUMMARY) } : {}) });
    }
    case "item/tool/requestUserInput": {
      const questions: AskedQuestion[] = asked(params).map((q) => ({
        question: q.question,
        ...(q.header ? { header: q.header } : {}),
        options: (q.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
      }));
      return made({ ...base, toolName: "AskUserQuestion", input: clip(JSON.stringify({ questions }, null, 2), MAX_TOOL), summary: clip(questions[0]?.question ?? "", MAX_SUMMARY), questions });
    }
    default:
      return undefined;
  }
}

/** What to answer a request with, for Gasho's answer; `error` when that answer cannot be given to this request. */
export function replyOf(r: CodexRequest, decision: PermissionDecision, answers: QuestionAnswer[] | undefined): { result: unknown } | { error: string } {
  switch (r.method) {
    case "item/commandExecution/requestApproval": {
      if (decision === "allow") return { result: { decision: "accept" } };
      if (decision === "deny") return { result: { decision: "decline" } };
      const amendment = r.params.proposedExecpolicyAmendment;
      if (!Array.isArray(amendment) || amendment.length === 0) return { error: "この確認には「今後も許可」を使えません。" };
      return { result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: amendment } } } };
    }
    case "item/fileChange/requestApproval":
      if (decision === "always") return { error: "この確認には「今後も許可」を使えません。" };
      return { result: { decision: decision === "allow" ? "accept" : "decline" } };
    case "item/permissions/requestApproval": {
      if (decision === "always") return { error: "この確認には「今後も許可」を使えません。" };
      if (decision === "deny") return { result: { permissions: {}, scope: "turn" } };
      const wanted = (r.params.permissions ?? {}) as Record<string, unknown>;
      return { result: { permissions: Object.fromEntries(Object.entries(wanted).filter(([, v]) => v !== null && v !== undefined)), scope: "turn" } };
    }
    case "item/tool/requestUserInput": {
      if (decision === "deny") return { result: { answers: {} } };
      const replies = asked(r.params).map((q, i) => {
        const a = answers?.[i];
        const chosen = (a?.picked ?? []).flatMap((k) => (q.options?.[k] ? [q.options[k].label] : []));
        return [q.id, { answers: [...chosen, ...(a?.text?.trim() ? [a.text.trim()] : [])] }] as const;
      });
      return { result: { answers: Object.fromEntries(replies) } };
    }
    default:
      return { error: "この確認には答えられません。" };
  }
}

/** The tokens of `thread/tokenUsage/updated`. `inputTokens` holds the cached and the cache-written ones. */
export interface CodexTokenBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
}

export interface CodexTokenUsage {
  /** Every reply of the thread added up. */
  total: CodexTokenBreakdown;
  /** The latest reply: what its `totalTokens` counts is in the context now. */
  last: CodexTokenBreakdown;
  modelContextWindow?: number | null;
}

/** A breakdown in Gasho's kinds, which do not overlap. */
export function usageOfBreakdown(b: CodexTokenBreakdown): TokenUsage {
  const cacheWrite = b.cacheWriteInputTokens ?? 0;
  return { input: b.inputTokens - b.cachedInputTokens - cacheWrite, output: b.outputTokens, cacheWrite, cacheRead: b.cachedInputTokens };
}
