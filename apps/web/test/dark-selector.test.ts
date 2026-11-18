import assert from "node:assert/strict";
import { test } from "node:test";
import { type CssRule, darkSelector, ruleText } from "../src/plugins/dark-selector.ts";

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

// The rules below are written as Chrome's CSSOM writes them; happy-dom cannot read nested rules nor a { in a string.
test("ruleText writes the selectors of the style rules, and of those in @media and @supports, before their blocks", () => {
  const style = (selectorText: string, block: string) => ({ selectorText, cssText: `${selectorText} ${block}`, cssRules: [] });
  assert.equal(ruleText(style(".dark .a", "{ color: red; }")), ".dark & .a, & .dark .a { color: red; }");
  assert.equal(ruleText(style(".a", "{ color: red; }")), ".a { color: red; }");
  const media = { cssText: "@media (min-width: 1px) {\n  .dark .a { color: red; }\n}", cssRules: [style(".dark .a", "{ color: red; }")] };
  assert.equal(ruleText(media), "@media (min-width: 1px) {.dark & .a, & .dark .a { color: red; }}");
  const supports = { cssText: '@supports (content: "{") {\n  .b { color: blue; }\n}', cssRules: [style(".b", "{ color: blue; }")] };
  assert.equal(ruleText(supports), '@supports (content: "{") {.b { color: blue; }}');
  const nested = { selectorText: ".dark", cssText: ".dark {\n  & .c { color: green; }\n}", cssRules: [style("& .c", "{ color: green; }")] };
  assert.equal(ruleText(nested), ".dark &, & .dark {\n  & .c { color: green; }\n}");
});

test("a .dark rule with + or ~ in a nested rule stays as it is, as .dark & would be the part's element", () => {
  const sibling = { selectorText: "& ~ *", cssText: "& ~ * { outline: red; }", cssRules: [] };
  const nest = (selectorText: string, child: CssRule) => ({ selectorText, cssText: `${selectorText} {\n  ${child.cssText}\n}`, cssRules: [child] });
  for (const rule of [
    nest(".dark", sibling),
    nest("html.dark", { selectorText: "& + .a", cssText: "& + .a { outline: red; }", cssRules: [] }),
    nest(".dark", { cssText: "@media (min-width: 1px) {\n  & ~ * { outline: red; }\n}", cssRules: [sibling] }),
  ]) {
    assert.equal(ruleText(rule), rule.cssText, rule.cssText);
  }
  // Below .dark .a, ~ stays inside the part.
  assert.equal(ruleText(nest(".dark .a", sibling)), ".dark & .a, & .dark .a {\n  & ~ * { outline: red; }\n}");
});
