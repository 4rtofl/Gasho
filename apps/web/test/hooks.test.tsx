// The hooks of lib/ that keep a choice of this browser (localStorage) or of the page (the chat boxes' drafts): every
// part that uses one sees a change at once, another tab's change comes in, and blocked storage still works for the page.
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CHAT_TEXT_DEFAULT, CHAT_TEXT_MAX, useChatTextSize } from "@/lib/chat-text";
import { hasDrafts, promptDraft, usePicks } from "@/lib/drafts";
import { useChoices, useFlag } from "@/lib/flag";
import { useSavedOrder } from "@/lib/order";
import { PANEL_WIDTH_MAX, usePanelWidth, useSidebarWidth } from "@/lib/widths";

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
