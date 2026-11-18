// What the chat box of each session holds, kept while Gasho is open: going to another screen and back (another
// session, the home screen, or a panel on a phone) finds the box as it was left. That is the text being written, the
// files attached, the texts sent before (↑ recalls them), and the model, effort and ultracode picked to switch when
// sending. Kept in memory only: reloading the page starts afresh.
import { useCallback, useEffect, useSyncExternalStore, type RefObject } from "react";
import type { EffortLevel, SessionModel } from "@gasho/protocol";
import { createPromptDraft, type PromptDraftStore } from "@/components/ui/prompt-input";

/** What is picked in the chat box, to switch (for this session only) when the next message is sent. */
export interface Picks {
  model?: SessionModel;
  effort?: EffortLevel;
  ultracode?: boolean;
}

interface Draft {
  prompt: PromptDraftStore;
  picks: Picks;
  listeners: Set<() => void>;
  /** The chat box on screen (see useDraftBox). */
  box?: HTMLElement;
  /** Where the cursor was in the box when the session got its new id (see moveDraft). */
  caret?: [start: number, end: number];
}

/** Keyed by transcriptKey(machine, sessionId). */
const drafts = new Map<string, Draft>();

function draftOf(key: string): Draft {
  let d = drafts.get(key);
  if (!d) {
    d = { prompt: createPromptDraft(), picks: {}, listeners: new Set() };
    drafts.set(key, d);
  }
  return d;
}

/**
 * Whether some session's chat box holds something not sent: text or files (what was sent before and what is picked
 * are kept elsewhere too, or cheap to pick again). Reloading the page would lose it (lib/server-update.ts).
 */
export function hasDrafts(): boolean {
  for (const d of drafts.values()) {
    const v = d.prompt.get();
    if (v.text.trim() !== "" || v.attachments.length > 0) return true;
  }
  return false;
}

/**
 * After /clear the session goes on under a new id: so does its chat box. One kept under `to` before is of a session that
 * has ended (whose conversation this one opened again), so the box of the session that runs takes its place.
 */
export function moveDraft(from: string, to: string): void {
  const d = drafts.get(from);
  if (!d) return;
  // Being typed in: the box drawn for the new id takes the cursor where it was, and the typing goes on there.
  const typing = document.activeElement;
  if (typing instanceof HTMLTextAreaElement && d.box?.contains(typing)) d.caret = [typing.selectionStart, typing.selectionEnd];
  drafts.delete(from);
  drafts.set(to, d);
}

/** Ties a session's chat box (the element of `ref`) to its draft, and puts the cursor back in it after moveDraft. */
export function useDraftBox(key: string, ref: RefObject<HTMLElement | null>): void {
  const d = draftOf(key);
  useEffect(() => {
    const box = ref.current;
    if (!box) return;
    d.box = box;
    const caret = d.caret;
    delete d.caret;
    const text = caret && box.querySelector("textarea");
    if (text) {
      text.focus({ preventScroll: true });
      text.setSelectionRange(...caret);
    }
    return () => {
      if (d.box === box) delete d.box;
    };
  }, [d, ref]);
}

/** The text, files and sent texts of a session's chat box (PromptInput's `draft`). */
export function promptDraft(key: string): PromptDraftStore {
  return draftOf(key).prompt;
}

/**
 * What is picked in a session's chat box, and how to change it. A change made after the box has gone (when the
 * answer to a message sent from it comes) is kept too.
 */
export function usePicks(key: string): [Picks, (change: (p: Picks) => Picks) => void] {
  const d = draftOf(key);
  const subscribe = useCallback(
    (l: () => void) => {
      d.listeners.add(l);
      return () => d.listeners.delete(l);
    },
    [d],
  );
  const picks = useSyncExternalStore(subscribe, () => d.picks);
  const update = useCallback(
    (change: (p: Picks) => Picks) => {
      const next = change(d.picks);
      if (next === d.picks) return;
      d.picks = next;
      for (const l of d.listeners) l();
    },
    [d],
  );
  return [picks, update];
}
