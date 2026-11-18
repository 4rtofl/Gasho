// What the tests of the session screen (session-*.spec.ts) share: a fake gasho-daemon with one session started from
// Gasho, the screen opened on it, and the entries of a conversation as gasho-daemon sends them.
import type { JSHandle, Locator, Page } from "@playwright/test";
import type { DaemonToHub, HubToDaemon, SessionInfo, TranscriptBlock, TranscriptEntry } from "@gasho/protocol";
import { type FakeDaemon, type FakeDaemonOptions, fakeSession, type GashoHub } from "../harness/index.ts";

export const SESSION_ID = "5d0c9a3e-1f2b-4c6d-8e7f-90a1b2c3d4e5";
export const OTHER_SESSION_ID = "7a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d";

/** The session screen of a session, by its URL. */
export function sessionPath(daemon: FakeDaemon, sessionId = SESSION_ID): string {
  return `/#/s/${encodeURIComponent(daemon.machineId)}/${encodeURIComponent(sessionId)}`;
}

/**
 * Connects a fake gasho-daemon named "mac" with a session started from Gasho ("e2e-session" in /work/gasho, idle,
 * unless `session` says otherwise), and opens the session screen. The daemon's other options (version, capabilities,
 * more sessions, conversations) are passed on. `setup` is given the daemon before the screen opens, to set how it
 * answers what the screen asks for at once (the conversation, its images).
 */
export async function openSession(
  page: Page,
  hub: GashoHub,
  o: { session?: Partial<SessionInfo>; transcript?: TranscriptEntry[]; daemon?: FakeDaemonOptions; setup?: (daemon: FakeDaemon) => void } = {},
): Promise<FakeDaemon> {
  const session = fakeSession({ sessionId: SESSION_ID, cwd: "/work/gasho", name: "e2e-session", ...o.session });
  const daemon = await hub.fakeDaemon({
    name: "mac",
    ...o.daemon,
    sessions: [session, ...(o.daemon?.sessions ?? [])],
    transcripts: { [SESSION_ID]: o.transcript ?? [], ...o.daemon?.transcripts },
  });
  o.setup?.(daemon);
  await page.goto(sessionPath(daemon, session.sessionId));
  return daemon;
}

/** The chat box's text field (its name changes to "シェルのコマンド" in shell mode). */
export const chatBox = (page: Page) => page.getByPlaceholder("Agent への指示を入力…");

let count = 0;
/** An entry of a conversation, with the blocks given. */
export function entry(role: TranscriptEntry["role"], blocks: TranscriptBlock[], more: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { uuid: `e2e-${process.pid}-s${++count}`, ts: new Date().toISOString(), role, blocks, ...more };
}

/** An assistant entry with one tool call, and the user entry with its result, as Claude Code records them. */
export function toolCall(name: string, input: Record<string, unknown>, result: string, isError = false): TranscriptEntry[] {
  const id = `toolu_e2e_${++count}`;
  return [
    entry("assistant", [{ type: "tool_use", id, name, input: JSON.stringify(input) }]),
    entry("user", [{ type: "tool_result", toolUseId: id, content: result, isError }]),
  ];
}

/** `n` entries, the user's and Claude's in turn, numbered from `from` ("発言 1", "発言 2", …). */
export function numberedEntries(n: number, from = 1): TranscriptEntry[] {
  return Array.from({ length: n }, (_, i) => entry(i % 2 === 0 ? "user" : "assistant", [{ type: "text", text: `発言 ${from + i}` }]));
}

/** The page of a session's conversation that transcript.get asks for, from the conversations the daemon was given. */
export function transcriptPage(daemon: FakeDaemon, msg: Extract<HubToDaemon, { type: "transcript.get" }>): DaemonToHub {
  const all = daemon.transcripts[msg.sessionId] ?? [];
  const end = Math.min(msg.before ?? all.length, all.length);
  const start = Math.max(0, end - msg.limit);
  return { type: "transcript.page", requestId: msg.requestId, sessionId: msg.sessionId, entries: all.slice(start, end), start, total: all.length };
}

/** A promise that the test fulfils when it likes: an answer that waits for it comes then. */
export function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

/** Scrolls the session's conversation to its top or its bottom, as the reader does. */
export async function scrollConversation(page: Page, to: "top" | "bottom"): Promise<void> {
  await page.locator(".chat-text").evaluate((rows, top) => {
    const scroller = rows.closest(".overflow-y-auto");
    if (scroller) scroller.scrollTop = top ? 0 : scroller.scrollHeight;
  }, to === "top");
}

/** A file as the browser holds one, for a drop or a paste. */
interface PageFile {
  name: string;
  type: string;
  text: string;
}

/** The browser's constructors that the tests use, which this project's types (Node.js only) do not name. */
interface PageGlobals {
  DataTransfer: new () => { items: { add(item: unknown): void }; setData(type: string, data: string): void };
  File: new (parts: string[], name: string, o: { type: string }) => unknown;
  KeyboardEvent: new (type: string, init: object) => { defaultPrevented: boolean };
  ClipboardEvent: new (type: string, init: object) => { defaultPrevented: boolean };
}

/** A DataTransfer in the page holding these files (and this text), as a drop or a paste carries them. */
export function dataTransfer(page: Page, files: PageFile[], text?: string): Promise<JSHandle> {
  return page.evaluateHandle(
    ([files, text]) => {
      const w = globalThis as unknown as PageGlobals;
      const dt = new w.DataTransfer();
      for (const f of files) dt.items.add(new w.File([f.text], f.name, { type: f.type }));
      if (text !== undefined) dt.setData("text/plain", text);
      return dt;
    },
    [files, text] as const,
  );
}

/** Pastes what a DataTransfer holds into the element (a paste event, as the browser sends one). */
export async function paste(target: Locator, data: JSHandle): Promise<void> {
  await target.evaluate((el, clipboardData) => {
    const w = globalThis as unknown as PageGlobals;
    el.dispatchEvent(new w.ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  }, data);
}

/** Sends a keydown made by the page to the element, and tells whether something handled it (its default prevented). */
export function keydown(target: Locator, init: Record<string, unknown>): Promise<boolean> {
  return target.evaluate((el, init) => {
    const w = globalThis as unknown as PageGlobals;
    const e = new w.KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  }, init);
}

/** Puts the text field's caret at its start or its end. */
export async function caretAt(field: Locator, at: "start" | "end"): Promise<void> {
  await field.evaluate((el, end) => {
    const n = end ? el.value.length : 0;
    el.setSelectionRange(n, n);
  }, at === "end");
}

/**
 * An answer to media.get from the bytes of a file (an image or a video Claude sent), as gasho-daemon reads it part by
 * part.
 */
export function mediaAnswer(msg: Extract<HubToDaemon, { type: "media.get" }>, bytes: Buffer, mime: string): DaemonToHub {
  const part = bytes.subarray(msg.offset, msg.offset + msg.length);
  return { type: "media", requestId: msg.requestId, media: { mime, size: bytes.length, mtime: 0, offset: msg.offset, data: part.toString("base64") } };
}

/** A WebM of 16×16 pixels and 0.2 seconds (VP8), which Chromium and WebKit both play. */
export const WEBM = Buffer.from(
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAICEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggHs7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAxV0GNTGF2ZjYyLjEyLjEwMUSJiEBpAAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYhtE4hw4dmo5pyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhAvrwgDgkLCBELqBEJqBAlWwhFW5gQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAxc3PWY8CLY8WIbROIcOHZqOZnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMSBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAwLjIwMDAwMDAwMAAfQ7Z1weeBAKO8gQAAgLACAJ0BKhAAEAAARwiFhYiFhIgCAgJ1qgP4Agz9KAD+/00S//xYV/FhX8WFf/FhX/z8zu3F/OYAHFO7a5G7j7OBALeK94EB8YIBpvCBAw==",
  "base64",
);

/** A PNG of 1×1 pixel. */
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
