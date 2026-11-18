import assert from "node:assert/strict";
import { test } from "node:test";
import { blockStart, darkSelector } from "../src/plugins/dark-selector.ts";

test("a selector that starts with .dark matches below a .dark above the plugin's part or inside it", () => {
  assert.equal(darkSelector(".dark .rcs"), ".dark & .rcs, & .dark .rcs");
  assert.equal(darkSelector("html.dark > .a"), "html.dark & > .a, & html.dark > .a");
  assert.equal(darkSelector(".dark"), ".dark &, & .dark");
  assert.equal(darkSelector('.a, .dark .b[title="x, y"]'), '.a, .dark & .b[title="x, y"], & .dark .b[title="x, y"]');
});

test("the other selectors stay as they are", () => {
  for (const s of [
    ".rcs",
    ".darker .a",
    // Tailwind's dark: variant, which matches already.
    ".dark\\:text-sky-400:is(.dark *)",
    ":is(.dark *)::highlight(ref)",
    ":not(.dark) .a",
    ".a .dark .b",
    '[title=".dark a"] .b',
    ".dark + .a",
    ".dark ~ .a",
    ".dark::before",
    // Selectors with & match as they did before.
    ".dark & .foo",
    ".dark :is(&) .foo",
  ]) {
    assert.equal(darkSelector(s), undefined, s);
  }
});

test("the block of a rule starts after a { in its condition's string", () => {
  const text = '@supports (content: "{") { .a { color: red; } }';
  assert.equal(text.slice(0, blockStart(text)), '@supports (content: "{") ');
});
