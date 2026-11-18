import assert from "node:assert/strict";
import { test } from "node:test";
import { type CssRule, darkSelector, ruleText } from "../src/plugins/dark-selector.ts";

test("a selector that starts with .dark matches below a .dark above the plugin's part or inside it", () => {
  assert.equal(darkSelector(".dark .rcs"), ".dark & .rcs, & .dark .rcs");
  assert.equal(darkSelector("html.dark > .a"), "html.dark & > .a, & html.dark > .a");
  assert.equal(darkSelector(".dark"), ".dark &, & .dark");
  assert.equal(darkSelector('.a, .dark .b[title="x, y"]'), '.a, .dark & .b[title="x, y"], & .dark .b[title="x, y"]');
  // The whitespace after a hex escape is a part of it.
  assert.equal(darkSelector(".dark.\\31 23 .a"), ".dark.\\31 23 & .a, & .dark.\\31 23 .a");
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

// The rules below are written as Chrome's CSSOM writes them (a nested `~ *` as `& ~ *`); happy-dom cannot read nested
// rules nor a { in a string.
const style = (selectorText: string, block = "{ outline: red; }"): CssRule => ({ selectorText, cssText: `${selectorText} ${block}`, cssRules: [] });
const inside = (head: string, rules: CssRule[]) => `${head} {\n${rules.map((r) => `  ${r.cssText}\n`).join("")}}`;
const nest = (selectorText: string, ...rules: CssRule[]): CssRule => ({ selectorText, cssText: inside(selectorText, rules), cssRules: rules });
const media = (...rules: CssRule[]): CssRule => ({ cssText: inside("@media (min-width: 1px)", rules), cssRules: rules });

test("ruleText writes the selectors of the style rules, and of those in @media and @supports, before their blocks", () => {
  assert.equal(ruleText(style(".dark .a", "{ color: red; }")), ".dark & .a, & .dark .a { color: red; }");
  assert.equal(ruleText(style(".a", "{ color: red; }")), ".a { color: red; }");
  assert.equal(ruleText(media(style(".dark .a", "{ color: red; }"))), "@media (min-width: 1px) {.dark & .a, & .dark .a { color: red; }}");
  const supports = { cssText: '@supports (content: "{") {\n  .b { color: blue; }\n}', cssRules: [style(".b", "{ color: blue; }")] };
  assert.equal(ruleText(supports), '@supports (content: "{") {.b { color: blue; }}');
  assert.equal(ruleText(nest(".dark", style("& .c", "{ color: green; }"))), ".dark &, & .dark {\n  & .c { color: green; }\n}");
});

test("a .dark rule stays as it is when a rule nested in it can match outside the plugin's part", () => {
  for (const rule of [
    // .dark & alone is the part's element, and + or ~ after it match Gasho's elements.
    nest(".dark", style("& ~ *")),
    nest("html.dark", style("& + .a")),
    nest(".dark", media(style("& ~ *"))),
    nest(".dark", nest("&:not(.a)", style("& ~ *"))),
    // As .dark::before, a pseudo-element of the part's element.
    nest(".dark", style("&::before", '{ content: "x"; }')),
    // & in () can match around the part's elements.
    nest(".dark", style(":is(& ~ *)")),
    nest(".dark", style(":is(& + *)")),
    nest(".dark", style(":has(+ &)")),
    nest(".dark", style(":has(> &)")),
    nest(".dark", style(":has(&)")),
    nest(".dark", media(style(":is(& ~ *)"))),
    nest(".dark .a", style(":has(&)")),
  ]) {
    assert.equal(ruleText(rule), rule.cssText, rule.cssText);
  }
  // + and ~ below an element inside the part stay inside it.
  for (const rule of [
    nest(".dark", style("& .foo + .foo")),
    nest(".dark", nest("& .foo", style("& + .foo"))),
    nest(".dark", style("& .foo::before", '{ content: "x"; }')),
  ]) {
    assert.equal(ruleText(rule), `.dark &, & .dark${rule.cssText.slice(".dark".length)}`, rule.cssText);
  }
  const below = nest(".dark .a", style("& ~ *"));
  assert.equal(ruleText(below), `.dark & .a, & .dark .a${below.cssText.slice(".dark .a".length)}`);
});
