// A message for the person shown at the top of Gasho's screen until it is closed: what happened after the screen it
// belonged to went away (a worktree removed with a warning, say). One at a time; a new one replaces it.
import { useSyncExternalStore } from "react";

let notice: string | undefined;
const listeners = new Set<() => void>();

export function showNotice(text: string | undefined): void {
  notice = text;
  for (const l of listeners) l();
}

export function useNotice(): string | undefined {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => notice,
  );
}
