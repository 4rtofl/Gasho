// Messages sent from this browser that the conversation does not show yet. Claude Code records a message only once
// gasho-daemon has typed it into the session, which can take a while: the session may switch the model first (with
// /model), or be busy (the message then waits on the working server). Meanwhile, the conversation shows the message at
// its end, from here, as being sent; the entry Claude Code records takes its place.
import { useCallback, useSyncExternalStore } from "react";
import type { TranscriptEntry } from "@gasho/protocol";
import { isShellInput, shellCommand } from "./shell.ts";

export interface PendingMessage {
  id: string;
  /** As sent (trimmed); empty when only files were sent. */
  text: string;
  /** Names of the files sent with it. */
  files: string[];
  /** How many entries the conversation had when it was sent: the message is recorded after them. */
  after: number;
  /**
   * "sending": the working server has not answered yet; "queued": it waits there until the session has finished its
   * work; "sent": typed into the session, so the conversation shows it shortly.
   */
  state: "sending" | "queued" | "sent";
  /**
   * Typed into the session while it worked ("sent"): Claude Code holds it until the current step ends, and records it
   * only then. It stays shown while the session works (see sessionWorking).
   */
  whileWorking?: boolean;
  /** When the state last changed (ms, this browser's clock). */
  at: number;
}

/**
 * How long a message is shown from here after it was typed into the session (or, waiting on the working server, after
 * the session has none waiting any more), should the conversation not show it by then: Claude Code records some texts
 * otherwise, such as a slash command that only changes the session.
 */
export const SENT_GRACE_MS = 20_000;
/** The first characters of a message, spaces aside, that its entry in the conversation must hold. */
const HEAD = 24;

const squeeze = (s: string): string => s.replace(/\s+/g, "");

function entryText(e: TranscriptEntry): string {
  return squeeze(e.blocks.map((b) => (b.type === "text" ? b.text : "")).join(""));
}

/**
 * Whether the conversation shows the message: an entry recorded after the ones it had when the message was sent, that
 * holds the message's first characters. Claude Code drops the "!" of a shell command (it records the command inside
 * tags); a slash command becomes a note that starts with it; files sent alone show as their paths under Gasho's
 * attachments folder. `start` is the index of entries[0] in the whole conversation.
 */
export function recorded(p: Pick<PendingMessage, "text" | "after">, entries: readonly TranscriptEntry[], start: number): boolean {
  const head = squeeze(p.text.replace(/^\s*!/, "")).slice(0, HEAD);
  const command = p.text.startsWith("/");
  for (let i = Math.max(0, p.after - start); i < entries.length; i++) {
    const e = entries[i];
    if (!e || e.isSidechain) continue;
    const text = entryText(e);
    if (e.role === "user" && (head ? text.includes(head) : text.includes("/gasho/attachments/"))) return true;
    if (e.role === "system" && command && head && text.startsWith(head)) return true;
  }
  return false;
}

/** A file sent with a message, as gasho-daemon mentions it after the text: "@<attachments>/<session>/<time>-<n>-<name>". */
const ATTACHED_RE = /@(\S*\/gasho\/attachments\/\S+)/g;

/** A file's name as gasho-daemon saves it (safeFileName in apps/daemon/src/managed.ts). */
export function savedName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.normalize("NFC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^[._]+/, "");
  return cleaned.slice(-100) || "file";
}

/** A message sent from here, as it was sent: how many entries the conversation had then, and when (this browser's clock). */
export interface SentAs {
  text: string;
  files: readonly string[];
  after: number;
  at: number;
}

/** Whether an entry is the message as it was sent: its whole text (spaces aside) and nothing else, and its files. */
function isAsSent(m: SentAs, e: TranscriptEntry): boolean {
  if (e.isSidechain || (e.role !== "user" && e.role !== "system")) return false;
  const shell = isShellInput(m.text);
  const text = squeeze(shell ? m.text.slice(1) : m.text);
  const raw = e.blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
  if (e.role === "system") return m.text.startsWith("/") && m.files.length === 0 && squeeze(raw) === text;
  if (shell) return squeeze(shellCommand(raw) ?? "") === text;
  if (squeeze(raw.replace(ATTACHED_RE, "")) !== text) return false;
  // The files sent with it, in order, by their names.
  const files = [...raw.matchAll(ATTACHED_RE)].map((f) => f[1]?.split("/").pop() ?? "");
  const same = (file: string, k: number) => {
    const name = `${k + 1}-${savedName(m.files[k] ?? "")}`;
    return file === name || file.endsWith(`-${name}`);
  };
  return files.length === m.files.length && files.every(same);
}

/**
 * Where the conversation shows each of the messages whose result never came (oldest first) as it was sent: the index
 * of the entry in the whole conversation, or -1. Stricter than `recorded`, as the message is kept only until the
 * conversation shows it: the entry is recorded after it was sent (after the entries the conversation had then, and not
 * before its time), and after the entry found for an older one. The same short text ("はい", "続けて") is often sent
 * again, and the page may not have had the entry of the one before when this one was sent. `start` is the index of
 * entries[0] in the whole conversation.
 */
export function recordedAsSent(list: readonly SentAs[], entries: readonly TranscriptEntry[], start: number): number[] {
  let from = 0;
  return list.map((m) => {
    for (let i = Math.max(0, m.after - start, from); i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      // The working server's clock: should this browser's be ahead, a message that reached the session stays (閉じる
      // removes it).
      if (e.ts && Date.parse(e.ts) < m.at) continue;
      if (isAsSent(m, e)) {
        from = i + 1;
        return start + i;
      }
    }
    return -1;
  });
}

/**
 * The messages whose result never came (oldest first) the conversation does not show yet (see recordedAsSent), `list`
 * itself when it shows none of them. One sent after one it shows is looked for after that entry from then on: that
 * entry is not taken for it once the one found is no longer in the list.
 */
export function notRecordedYet<T extends { sent: SentAs }>(list: T[], entries: readonly TranscriptEntry[], start: number): T[] {
  const found = recordedAsSent(list.map((u) => u.sent), entries, start);
  if (found.every((at) => at < 0)) return list;
  let past = -1;
  const left: T[] = [];
  list.forEach((u, i) => {
    const at = found[i] ?? -1;
    if (at >= 0) past = Math.max(past, at);
    else left.push(past < u.sent.after ? u : { ...u, sent: { ...u.sent, after: past + 1 } });
  });
  return left;
}

/**
 * Whether to show a message from here: not once the conversation shows it. A message that waits on the working server
 * is shown while the session has messages waiting there (`waiting`, from the session's info), and for a while after it
 * was queued, in case that count was not seen go up.
 */
export function pendingShown(
  p: PendingMessage,
  entries: readonly TranscriptEntry[],
  start: number,
  waiting: number,
  now: number,
): boolean {
  if (recorded(p, entries, start)) return false;
  if (p.state === "queued") return waiting > 0 || now - p.at < SENT_GRACE_MS;
  return true;
}

// ---- the messages of each session, keyed by transcriptKey(machine, sessionId) ----

const lists = new Map<string, PendingMessage[]>();
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Whether each session is working, as last told (see sessionWorking). */
const working = new Map<string, boolean>();
const NONE: PendingMessage[] = [];

function set(key: string, list: PendingMessage[]): void {
  if (list.length > 0) lists.set(key, list);
  else lists.delete(key);
  for (const l of listeners) l();
}

/**
 * Where a message is kept: under the key it was sent with, or under the one its session went on under after /clear
 * (see movePending), when the working server answers after that.
 */
function holder(key: string, id: string): string | undefined {
  if (lists.get(key)?.some((p) => p.id === id)) return key;
  for (const [k, list] of lists) if (list.some((p) => p.id === id)) return k;
  return undefined;
}

/** Shows a message just sent from here. Returns its id. */
export function addPending(key: string, message: { text: string; files: string[]; after: number }): string {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  set(key, [...(lists.get(key) ?? []), { id, ...message, state: "sending", at: Date.now() }]);
  return id;
}

/** Returns the message removed: after /clear, its `after` is of the new conversation (see movePending). */
export function removePending(key: string, id: string): PendingMessage | undefined {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const at = holder(key, id);
  if (!at) return undefined;
  const list = lists.get(at) ?? [];
  set(at, list.filter((p) => p.id !== id));
  return list.find((p) => p.id === id);
}

/**
 * What the working server did with a message: typed it into the session ("sent"; it is removed from here a while
 * later, by when the conversation shows it), or kept it waiting until the session has finished its work ("queued").
 * `afterWork`: one it kept was typed in once the work had ended (see noneWaiting), so Claude Code does not hold it,
 * even if the session already works on it.
 */
export function settlePending(key: string, id: string, state: "queued" | "sent", afterWork = false): void {
  const at = holder(key, id);
  if (!at) return;
  const list = lists.get(at) ?? [];
  // A shell command runs, and any other message typed while the session works waits in Claude Code, as long as the
  // session works (see sessionWorking).
  const shell = isShellInput(list.find((p) => p.id === id)?.text ?? "");
  const whileWorking = state === "sent" && !shell && !afterWork && working.get(at) === true;
  set(at, list.map((p) => (p.id === id ? { ...p, state, at: Date.now(), ...(whileWorking ? { whileWorking } : {}) } : p)));
  if (state === "sent") {
    clearTimeout(timers.get(id));
    timers.delete(id);
    if (!((shell || whileWorking) && working.get(at))) timers.set(id, setTimeout(() => removePending(at, id), SENT_GRACE_MS));
  }
}

/**
 * Whether the session is working. Claude Code records a shell command ("!") only once it has ended, so one typed into
 * the session from here stays shown, as running, while the session works; so does a message typed while it worked,
 * which Claude Code records once the current step has ended. Once the session stops, they go SENT_GRACE_MS later, by
 * when the conversation shows them (a command that was stopped is not recorded at all).
 */
export function sessionWorking(key: string, now: boolean): void {
  working.set(key, now);
  for (const p of lists.get(key) ?? []) {
    if (p.state !== "sent" || !(isShellInput(p.text) || p.whileWorking)) continue;
    clearTimeout(timers.get(p.id));
    timers.delete(p.id);
    if (!now) timers.set(p.id, setTimeout(() => removePending(key, p.id), SENT_GRACE_MS));
  }
}

/** The session has no messages waiting on the working server any more: the ones that waited there were typed. */
export function noneWaiting(key: string): void {
  for (const p of lists.get(key) ?? []) if (p.state === "queued") settlePending(key, p.id, "sent", true);
}

/**
 * After /clear the session goes on under a new id (see lib/drafts' moveDraft). The messages not yet typed into it
 * ("sending", "queued") are typed into the new conversation, so they go with it, to be looked for from its first entry.
 * One typed already shows in the conversation it was typed into: moved, one typed before /clear would show at the end
 * of the new conversation until SENT_GRACE_MS is over.
 */
export function movePending(from: string, to: string): void {
  const list = lists.get(from);
  if (!list) return;
  for (const p of list) {
    if (p.state !== "sent") continue;
    clearTimeout(timers.get(p.id));
    timers.delete(p.id);
  }
  lists.delete(from);
  const moving = list.filter((p) => p.state !== "sent").map((p) => ({ ...p, after: 0 }));
  set(to, [...(lists.get(to) ?? []), ...moving]);
}

/** The messages sent from here to a session that are not over yet (see pendingShown for which to show). */
export function pendingOf(key: string): PendingMessage[] {
  return lists.get(key) ?? NONE;
}

/** pendingOf, kept up to date in a component. */
export function usePending(key: string): PendingMessage[] {
  const subscribe = useCallback((l: () => void) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return useSyncExternalStore(subscribe, () => pendingOf(key));
}
