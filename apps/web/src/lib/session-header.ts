// Whether the session screen shows its full header. On a computer the choice is remembered in this browser (a
// private window or blocked storage starts with the header shown). On a phone, and in a window too low for the header
// and the conversation (a phone held sideways), the header starts closed whenever a session screen opens, so the
// conversation gets the room.
import { useSyncExternalStore } from "react";
import { DESKTOP, matches, useMediaQuery } from "@/lib/media";

const KEY = "gasho.sessionHeader";
/** Where the choice is remembered. At 844×390, the header and the prompt box left the conversation about 30 px. */
const ROOMY = `${DESKTOP} and (min-height: 500px)`;
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "hidden";
  } catch {
    return true;
  }
}

let roomyShown = read();
let smallShown = false;

function changed(): void {
  for (const l of listeners) l();
}

export function toggleSessionHeader(): void {
  if (!matches(ROOMY)) {
    smallShown = !smallShown;
    return changed();
  }
  roomyShown = !roomyShown;
  try {
    localStorage.setItem(KEY, roomyShown ? "shown" : "hidden");
  } catch {
    // keep the choice for this page view only
  }
  changed();
}

/** A session screen opened: on a phone or in a low window, its header starts closed. */
export function closeSmallSessionHeader(): void {
  if (!smallShown) return;
  smallShown = false;
  changed();
}

export function useSessionHeaderShown(): boolean {
  const roomy = useMediaQuery(ROOMY);
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => (roomy ? roomyShown : smallShown),
  );
}
