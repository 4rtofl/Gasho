// The skills and custom commands of each session, for the "/" list of its chat box. Read from the working server when
// the list opens (session.skills) and kept while Gasho is open; read again when the list opens a minute later, so that
// a skill added meanwhile is there the next time.
import { useSyncExternalStore } from "react";
import type { SkillInfo } from "@gasho/protocol";
import { sendCommand, transcriptKey } from "@/lib/store";

export interface SessionSkills {
  /** Absent until first read. */
  list?: SkillInfo[];
  /** Why the last read failed (the list, if any, is from before). */
  error?: string;
  loading: boolean;
}

const FRESH_MS = 60_000;
const NONE: SessionSkills = { loading: false };
const kept = new Map<string, SessionSkills & { at: number }>();
const listeners = new Set<() => void>();

function keep(key: string, value: SessionSkills & { at: number }): void {
  kept.set(key, value);
  for (const l of listeners) l();
}

/** Reads the session's skills, unless they are being read or were read within the minute. */
export function loadSkills(machine: string, sessionId: string): void {
  const key = transcriptKey(machine, sessionId);
  const cur = kept.get(key);
  if (cur?.loading || (cur?.list && !cur.error && Date.now() - cur.at < FRESH_MS)) return;
  keep(key, { list: cur?.list, loading: true, at: cur?.at ?? 0 });
  void sendCommand(machine, { type: "session.skills", sessionId }, 20_000).then((r) => {
    keep(key, r.ok ? { list: r.skills ?? [], loading: false, at: Date.now() } : { list: cur?.list, error: r.error ?? "読み込めませんでした。", loading: false, at: Date.now() });
  });
}

export function useSkills(machine: string, sessionId: string): SessionSkills {
  const key = transcriptKey(machine, sessionId);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => kept.get(key) ?? NONE,
  );
}
