// The screen's keyboard shortcuts: which one a key press is, and how its keys are written beside an action.
//
// On a Mac they use ⌘, with ⌥ for those that Chrome and macOS leave free (⌥⌘↑↓, not ⌘↑↓, which move the cursor in the
// chat box; ⌥⌘W, not ⌘W, which closes the browser's tab). Elsewhere Ctrl and Alt are used in their places. As for ⌘B
// (components/ui/sidebar.tsx), Ctrl is taken on a Mac too, but not in a box that text is written in, where Ctrl with a
// letter moves the cursor.
import { useEffect, useRef } from "react";
import { appleKeys, typingIn } from "./text-input.ts";

export type Shortcut = "palette" | "sidebar" | "next" | "previous" | "remove";

/** What of a key press tells the shortcut (a KeyboardEvent has all of it). */
export interface ShortcutPress {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

/**
 * The letter pressed. On a Mac, ⌥ turns a letter into another character (⌥W is ∑), so the key's place on the keyboard
 * tells it then.
 */
const letter = (e: ShortcutPress): string | undefined => {
  const key = e.key.toLowerCase();
  if (/^[a-z]$/.test(key)) return key;
  return /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : undefined;
};

/** The shortcut a key press is, if any. `typing`: the key goes to a box that text is written in. */
export function shortcutOf(e: ShortcutPress, apple: boolean, typing: boolean): Shortcut | undefined {
  // An input method's keys (a Japanese conversion) are its own.
  if (e.isComposing || e.keyCode === 229) return undefined;
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return undefined;
  if (apple && !e.metaKey && typing) return undefined;
  if (e.altKey) {
    if (e.key === "ArrowDown") return "next";
    if (e.key === "ArrowUp") return "previous";
    return letter(e) === "w" ? "remove" : undefined;
  }
  const l = letter(e);
  return l === "k" ? "palette" : l === "b" ? "sidebar" : undefined;
}

const KEYS: Record<Shortcut, { mod: string[]; key: string }> = {
  palette: { mod: [], key: "K" },
  sidebar: { mod: [], key: "B" },
  next: { mod: ["alt"], key: "↓" },
  previous: { mod: ["alt"], key: "↑" },
  remove: { mod: ["alt"], key: "W" },
};

/** The keys of a shortcut, one a chip: ⌥ ⌘ ↓ on a Mac, Ctrl Alt ↓ elsewhere. */
export function shortcutKeys(s: Shortcut, apple: boolean): string[] {
  const { mod, key } = KEYS[s];
  const alt = mod.includes("alt") ? [apple ? "⌥" : "Alt"] : [];
  return apple ? [...alt, "⌘", key] : ["Ctrl", ...alt, key];
}

/** Whether this browser's keys are a Mac's (or an iPhone's or iPad's). */
export const appleBrowser = () => appleKeys(navigator.userAgent);

/**
 * Runs the shortcuts given, from a key pressed anywhere on the screen but in a dialog or a menu, whose keys are their
 * own. A shortcut not given is left to what else takes it (⌘B to the sidebar). The keys are taken before the element
 * they are pressed in gets them: the chat box would show the message sent before with ⌥⌘↑, and a row of the sidebar
 * would move with ⌥↑.
 */
export function useShortcuts(on: Partial<Record<Shortcut, () => void>>) {
  const latest = useRef(on);
  useEffect(() => {
    latest.current = on;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = shortcutOf(e, appleBrowser(), typingIn(e.target));
      const run = s && latest.current[s];
      if (!run || ownKeys(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      run();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}

/** Whether a key goes to a dialog or a menu (the sidebar's drawer on a phone is a dialog too). */
const ownKeys = (target: EventTarget | null) =>
  target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
