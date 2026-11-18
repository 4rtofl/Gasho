// What the chat box of each session holds, kept while Gasho is open: going to another screen and back (another
// session, the home screen, or a panel on a phone) finds the box as it was left. That is the text being written, the
// files attached, the texts sent before (↑ recalls them), the model, effort and ultracode picked to switch when
// sending, and the messages sent whose result never came. Kept in memory only: reloading the page starts afresh.
import { useCallback, useSyncExternalStore } from "react";
import type { EffortLevel, SessionModel } from "@gasho/protocol";
import { createPromptDraft, type PromptDraftStore } from "@/components/ui/prompt-input";

/** What is picked in the chat box, to switch (for this session only) when the next message is sent. */
export interface Picks {
  model?: SessionModel;
  effort?: EffortLevel;
  ultracode?: boolean;
}

/**
 * A message sent from the chat box whose result never came: the connection to the Gasho server closed first. It may
 * have been typed into the session, so it is put back in the box only when asked.
 */
export interface Unsent {
  id: string;
  /** Its text that has not been put back in the box (empty once it has). */
  text: string;
  /** The files sent with it that have not been put back in the box. */
  files: File[];
  /**
   * Its text and the names of its files as sent, and how many entries the conversation had then: to find it in the
   * conversation should it show there (see lib/pending's recordedAsSent).
   */
  sent: { text: string; files: string[]; after: number };
}

interface Draft {
  prompt: PromptDraftStore;
  picks: Picks;
  unsent: Unsent[];
  listeners: Set<() => void>;
}

/** Keyed by transcriptKey(machine, sessionId). */
const drafts = new Map<string, Draft>();

function draftOf(key: string): Draft {
  let d = drafts.get(key);
  if (!d) {
    d = { prompt: createPromptDraft(), picks: {}, unsent: [], listeners: new Set() };
    drafts.set(key, d);
  }
  return d;
}

/**
 * Whether some session's chat box holds something not sent: text or files, or a message whose result never came (what
 * was sent before and what is picked are kept elsewhere too, or cheap to pick again). Reloading the page would lose it
 * (lib/server-update.ts).
 */
export function hasDrafts(): boolean {
  for (const d of drafts.values()) {
    const v = d.prompt.get();
    if (v.text.trim() !== "" || v.attachments.length > 0 || d.unsent.length > 0) return true;
  }
  return false;
}

/** The text, files and sent texts of a session's chat box (PromptInput's `draft`). */
export function promptDraft(key: string): PromptDraftStore {
  return draftOf(key).prompt;
}

/** One of what a session's chat box holds, and how to change it, kept up to date in a component. */
function useDraftPart<K extends "picks" | "unsent">(key: string, part: K): [Draft[K], (change: (v: Draft[K]) => Draft[K]) => void] {
  const d = draftOf(key);
  const subscribe = useCallback(
    (l: () => void) => {
      d.listeners.add(l);
      return () => d.listeners.delete(l);
    },
    [d],
  );
  const value = useSyncExternalStore(subscribe, () => d[part]);
  const update = useCallback(
    (change: (v: Draft[K]) => Draft[K]) => {
      const next = change(d[part]);
      if (next === d[part]) return;
      d[part] = next;
      for (const l of d.listeners) l();
    },
    [d, part],
  );
  return [value, update];
}

/**
 * What is picked in a session's chat box, and how to change it. A change made after the box has gone (when the
 * answer to a message sent from it comes) is kept too.
 */
export function usePicks(key: string): [Picks, (change: (p: Picks) => Picks) => void] {
  return useDraftPart(key, "picks");
}

/**
 * The messages sent from a session's chat box whose result never came, oldest first, and how to change them. One
 * added after the box has gone (another session was opened while it was being sent) is kept too.
 */
export function useUnsent(key: string): [Unsent[], (change: (u: Unsent[]) => Unsent[]) => void] {
  return useDraftPart(key, "unsent");
}
