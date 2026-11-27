import assert from "node:assert/strict";
import { test } from "node:test";
import { shortcutKeys, shortcutOf, type ShortcutPress } from "../src/lib/shortcuts.ts";

const press = (key: string, mods: Partial<ShortcutPress> = {}): ShortcutPress => ({
  key,
  code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : "",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 0,
  ...mods,
});

test("⌥⌘W is told by the key's place, as ⌥ turns W into ∑ on a Mac", () => {
  assert.equal(shortcutOf(press("∑", { code: "KeyW", metaKey: true, altKey: true }), true, true), "remove");
});

test("⌥⌘↑↓ move between the rows, also from the chat box; ⌘↑↓ alone are left to it", () => {
  assert.equal(shortcutOf(press("ArrowDown", { metaKey: true, altKey: true }), true, true), "next");
  assert.equal(shortcutOf(press("ArrowUp", { metaKey: true, altKey: true }), true, true), "previous");
  assert.equal(shortcutOf(press("ArrowDown", { metaKey: true }), true, true), undefined);
});

test("the keys Chrome and macOS use with ⌥ or ⇧ are left to them", () => {
  // ⌥⌘B opens Chrome's bookmarks, ⇧⌘B shows its bookmarks bar, ⌥⌘I its developer tools.
  assert.equal(shortcutOf(press("∫", { code: "KeyB", metaKey: true, altKey: true }), true, false), undefined);
  assert.equal(shortcutOf(press("b", { metaKey: true, shiftKey: true }), true, false), undefined);
  assert.equal(shortcutOf(press("ˆ", { code: "KeyI", metaKey: true, altKey: true }), true, false), undefined);
  assert.equal(shortcutOf(press("ArrowRight", { metaKey: true, altKey: true }), true, false), undefined);
});

test("on a Mac, Ctrl with a letter in a text box moves the cursor, and is not a shortcut there", () => {
  assert.equal(shortcutOf(press("k", { ctrlKey: true }), true, true), undefined);
  assert.equal(shortcutOf(press("k", { ctrlKey: true }), true, false), "palette");
  assert.equal(shortcutOf(press("k", { ctrlKey: true }), false, true), "palette");
});

test("a key that ends a Japanese conversion is not a shortcut", () => {
  assert.equal(shortcutOf(press("k", { metaKey: true, isComposing: true }), true, true), undefined);
  assert.equal(shortcutOf(press("k", { metaKey: true, keyCode: 229 }), true, true), undefined);
});

test("the keys are written with a Mac's marks on a Mac, and with Ctrl and Alt elsewhere", () => {
  assert.deepEqual(shortcutKeys("next", true), ["⌥", "⌘", "↓"]);
  assert.deepEqual(shortcutKeys("next", false), ["Ctrl", "Alt", "↓"]);
  assert.deepEqual(shortcutKeys("palette", true), ["⌘", "K"]);
});
