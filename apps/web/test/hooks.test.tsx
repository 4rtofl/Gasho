// The hooks of lib/ that keep a choice of this browser (localStorage) or of the page (the chat boxes' drafts): every
// part that uses one sees a change at once, another tab's change comes in, and blocked storage still works for the page.
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CHAT_TEXT_DEFAULT, CHAT_TEXT_MAX, useChatTextSize } from "@/lib/chat-text";
import { hasDrafts, promptDraft, useDraftBox, usePicks, useUnsent } from "@/lib/drafts";
import { getFileDraft, hasUnsavedFiles, setFileDraft } from "@/lib/file-drafts";
import { useChoices, useFlag } from "@/lib/flag";
import { useSavedOrder } from "@/lib/order";
import { addPending, pendingOf, removePending, settlePending } from "@/lib/pending";
import { fileKey, transcriptKey } from "@/lib/store";
import { PANEL_WIDTH_MAX, usePanelWidth, useSidebarWidth } from "@/lib/widths";
import { connectHub, machine, session } from "./hub";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Another tab of this browser saved `value` under `key`. */
function savedInAnotherTab(key: string, value: string | null): void {
  act(() => {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
  });
}

test("a flag is the same in every part that reads it, and is kept in this browser", () => {
  const a = renderHook(() => useFlag("test.folded", false));
  const b = renderHook(() => useFlag("test.folded", false));
  expect(a.result.current[0]).toBe(false);
  act(() => a.result.current[1](true));
  expect(b.result.current[0]).toBe(true);
  expect(localStorage.getItem("test.folded")).toBe("1");
});

test("without storage (a private window, or storage blocked), a flag starts at its default and still changes for this page", () => {
  const blocked = vi.fn(() => {
    throw new DOMException("blocked", "SecurityError");
  });
  vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked, removeItem: blocked });
  const { result } = renderHook(() => useFlag("test.blocked", true));
  expect(result.current[0]).toBe(true);
  act(() => result.current[1](false));
  expect(result.current[0]).toBe(false);
  expect(blocked).toHaveBeenCalledTimes(2);
});

test("choosing nothing forgets the choices", () => {
  localStorage.setItem("test.repos", '["a","b"]');
  const { result } = renderHook(() => useChoices("test.repos"));
  expect(result.current[0]).toEqual(["a", "b"]);
  act(() => result.current[1]([]));
  expect(result.current[0]).toEqual([]);
  expect(localStorage.getItem("test.repos")).toBeNull();
});

test("the text size of the conversations follows another tab, is kept within its range, and the default is not saved", () => {
  const { result } = renderHook(() => useChatTextSize());
  expect(result.current[0]).toBe(CHAT_TEXT_DEFAULT);
  savedInAnotherTab("gasho.chatTextSize", "17");
  expect(result.current[0]).toBe(17);

  act(() => result.current[1](99));
  expect(result.current[0]).toBe(CHAT_TEXT_MAX);
  act(() => result.current[1](CHAT_TEXT_DEFAULT));
  expect(localStorage.getItem("gasho.chatTextSize")).toBeNull();

  // The storage was cleared in another tab.
  act(() => result.current[1](16));
  savedInAnotherTab("gasho.chatTextSize", null);
  expect(result.current[0]).toBe(CHAT_TEXT_DEFAULT);
});

test("an order saved by dragging is the same everywhere it is read, and going back to the default forgets it", () => {
  localStorage.setItem("test.order", "not json");
  const a = renderHook(() => useSavedOrder("test.order"));
  const b = renderHook(() => useSavedOrder("test.order"));
  expect(a.result.current[0]).toBeUndefined();
  act(() => a.result.current[1](["b", "a"]));
  expect(b.result.current[0]).toEqual(["b", "a"]);
  act(() => b.result.current[1](undefined));
  expect(a.result.current[0]).toBeUndefined();
  expect(localStorage.getItem("test.order")).toBeNull();
});

test("a width saved follows another tab and is kept within its range, and each width is kept apart", () => {
  const sidebar = renderHook(() => useSidebarWidth());
  const panel = renderHook(() => usePanelWidth());
  expect(sidebar.result.current[0]).toBeNull();

  act(() => panel.result.current[1](10_000));
  expect(panel.result.current[0]).toBe(PANEL_WIDTH_MAX);
  expect(sidebar.result.current[0]).toBeNull();

  savedInAnotherTab("gasho.sidebarWidth", "300");
  expect(sidebar.result.current[0]).toBe(300);
  act(() => sidebar.result.current[1](null));
  expect(sidebar.result.current[0]).toBeNull();
  expect(localStorage.getItem("gasho.sidebarWidth")).toBeNull();
});

test("a chat box holds something not sent while it has text or files, and what is picked in it outlives the box", () => {
  const box = promptDraft("m1\u0000s1");
  expect(hasDrafts()).toBe(false);
  box.set({ text: "  ", attachments: [], history: ["前の発言"] });
  expect(hasDrafts()).toBe(false);
  box.set({ text: "書きかけ", attachments: [], history: [] });
  expect(hasDrafts()).toBe(true);
  const file = new File(["x"], "a.txt");
  box.set({ text: "", attachments: [{ id: "f1", file, name: "a.txt", size: 1, type: "text/plain" }], history: [] });
  expect(hasDrafts()).toBe(true);
  box.set({ text: "", attachments: [], history: [] });

  // The answer to a message comes after its session's screen was left: the model it switched to is kept.
  const first = renderHook(() => usePicks("m1\u0000s1"));
  const update = first.result.current[1];
  first.unmount();
  act(() => update((p) => ({ ...p, effort: "high" })));
  const again = renderHook(() => usePicks("m1\u0000s1"));
  expect(again.result.current[0]).toEqual({ effort: "high" });
  // Each session's box has its own.
  expect(renderHook(() => usePicks("m1\u0000s2")).result.current[0]).toEqual({});
});

/** A chat box on the page, with the text of its draft. */
function chatBox(text: string): { current: HTMLDivElement; text: HTMLTextAreaElement } {
  const box = document.createElement("div");
  const area = document.createElement("textarea");
  area.value = text;
  box.append(area);
  document.body.append(box);
  return { current: box, text: area };
}

test("after /clear, a session's chat box, the messages sent from it not typed yet and the files being written in it go on under its new id, with the cursor where it was, also while the session is not on screen", async () => {
  const key = (id: string) => transcriptKey("m2", id);
  const hub = await connectHub({ machines: [machine("m2", [session("a"), session("other")])] });
  promptDraft(key("a")).set({ text: "書きかけ", attachments: [], history: ["前の発言"] });
  const picked = renderHook(() => usePicks(key("a")));
  act(() => picked.result.current[1]((p) => ({ ...p, model: "opus" })));
  promptDraft(key("other")).set({ text: "別のセッション", attachments: [], history: [] });
  const edited = { value: "編集中", original: "元", eol: "\n" as const, bom: false };
  setFileDraft(fileKey("m2", "a", "src/x.ts"), edited);
  // Messages sent from it: one the working server has not answered yet, one waiting there, one typed already.
  const sending = addPending(key("a"), { text: "送っている", files: [], after: 5 });
  const queued = addPending(key("a"), { text: "待っている", files: [], after: 5 });
  settlePending(key("a"), queued, "queued");
  settlePending(key("a"), addPending(key("a"), { text: "打った", files: [], after: 5 }), "sent");
  // And one whose result never came.
  const unsent = renderHook(() => useUnsent(key("a")));
  const lost = { id: "u1", text: "届いたか分からない", files: [], sent: { text: "届いたか分からない", files: [], after: 5 } };
  act(() => unsent.result.current[1]((list) => [...list, lost]));
  // The page of "a" is open, with its box being typed in.
  const before = chatBox("書きかけ");
  const open = renderHook(() => useDraftBox(key("a"), before));
  before.text.focus();
  before.text.setSelectionRange(2, 2);

  await hub.say({ type: "machine", machine: machine("m2", [session("b", { previousSessionIds: ["a"] }), session("other")]) });
  open.unmount();
  const after = chatBox("書きかけ");
  renderHook(() => useDraftBox(key("b"), after));
  expect(document.activeElement).toBe(after.text);
  expect([after.text.selectionStart, after.text.selectionEnd]).toEqual([2, 2]);
  expect(promptDraft(key("b")).get()).toEqual({ text: "書きかけ", attachments: [], history: ["前の発言"] });
  expect(renderHook(() => usePicks(key("b"))).result.current[0]).toEqual({ model: "opus" });
  expect(promptDraft(key("other")).get().text).toBe("別のセッション");
  expect(getFileDraft(fileKey("m2", "b", "src/x.ts"))).toBe(edited);
  // Not typed yet, they are typed into the new conversation, and are looked for from its first entry.
  expect(pendingOf(key("b")).map((p) => [p.text, p.state, p.after])).toEqual([
    ["送っている", "sending", 0],
    ["待っている", "queued", 0],
  ]);
  expect(pendingOf(key("a"))).toEqual([]);
  const moved = renderHook(() => useUnsent(key("b")));
  expect(moved.result.current[0].map((u) => [u.text, u.sent.after])).toEqual([["届いたか分からない", 0]]);
  // What the working server answers later about a message sent under the id from before reaches it.
  settlePending(key("a"), sending, "queued");
  expect(pendingOf(key("b")).map((p) => p.state)).toEqual(["queued", "queued"]);
  for (const id of [sending, queued]) removePending(key("a"), id);
  expect(pendingOf(key("b"))).toEqual([]);
  // Nothing is left under the id from before: once the boxes are sent and the file saved, no page reload waits for them.
  for (const id of ["b", "other"]) promptDraft(key(id)).set({ text: "", attachments: [], history: [] });
  act(() => moved.result.current[1](() => []));
  setFileDraft(fileKey("m2", "b", "src/x.ts"), undefined);
  expect(hasDrafts()).toBe(false);
  expect(hasUnsavedFiles()).toBe(false);
});
