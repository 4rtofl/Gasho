import assert from "node:assert/strict";
import { test } from "node:test";
import { type CssRule, partSelector, ruleText } from "../src/plugins/part-selector.ts";

test("a selector that starts with .dark matches below a .dark above the plugin's part or inside it", () => {
  assert.equal(partSelector(".dark .rcs"), ".dark & .rcs, & .dark .rcs");
  assert.equal(partSelector(".dark"), ".dark &, & .dark");
  assert.equal(partSelector('.a, .dark .b[title="x, y"]'), '.a, .dark & .b[title="x, y"], & .dark .b[title="x, y"]');
  // The whitespace after a hex escape is a part of it.
  assert.equal(partSelector(".dark.\\31 23 .a"), ".dark.\\31 23 & .a, & .dark.\\31 23 .a");
});

test("a selector that starts with :root, html or body matches the plugin's part or inside it, while those match", () => {
  assert.equal(partSelector(":root"), ":root &");
  assert.equal(partSelector(":root .a"), ":root & .a");
  assert.equal(partSelector(":root:not(.dark)"), ":root:not(.dark) &");
  assert.equal(partSelector("html.dark > .a"), "html.dark & > .a");
  assert.equal(partSelector("html body .a"), "html body & .a");
  assert.equal(partSelector("HTML>BODY"), "HTML>BODY &");
  assert.equal(partSelector("body > .a"), "body & > .a");
  assert.equal(partSelector(":root, .a"), ":root &, .a");
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
    ":root + .a",
    "html ~ .a",
    "html body + .a",
    "body::before",
    "html-x .a",
    ".a :root",
    // Selectors with & match as they did before.
    ".dark & .foo",
    ".dark :is(&) .foo",
    ":root &",
  ]) {
    assert.equal(partSelector(s), undefined, s);
  }
});

// The rules below are written as Chrome's CSSOM writes them (a nested `~ *` as `& ~ *`); happy-dom cannot read nested
// rules nor a { in a string.
const style = (selectorText: string, block = "{ outline: red; }"): CssRule => ({ selectorText, cssText: `${selectorText} ${block}`, cssRules: [] });
const block = (head: string, rules: CssRule[]) => `${head} {\n${rules.map((r) => `  ${r.cssText}\n`).join("")}}`;
const nest = (selectorText: string, ...rules: CssRule[]): CssRule => ({ selectorText, cssText: block(selectorText, rules), cssRules: rules });
const at = (head: string, ...rules: CssRule[]): CssRule => ({ cssText: block(head, rules), cssRules: rules });
const media = (...rules: CssRule[]) => at("@media (min-width: 1px)", ...rules);
const scope = (start: string) => at(`@scope (${start})`, style(":scope"));

test("ruleText writes the selectors of the style rules, and of those in @media and @supports, before their blocks", () => {
  assert.equal(ruleText(style(".dark .a", "{ color: red; }")), ".dark & .a, & .dark .a { color: red; }");
  assert.equal(ruleText(style(".a", "{ color: red; }")), ".a { color: red; }");
  assert.equal(ruleText(media(style(".dark .a", "{ color: red; }"))), "@media (min-width: 1px) {.dark & .a, & .dark .a { color: red; }}");
  const supports = { cssText: '@supports (content: "{") {\n  .b { color: blue; }\n}', cssRules: [style(".b", "{ color: blue; }")] };
  assert.equal(ruleText(supports), '@supports (content: "{") {.b { color: blue; }}');
  assert.equal(ruleText(nest(".dark", style("& .c", "{ color: green; }"))), ".dark &, & .dark {\n  & .c { color: green; }\n}");
});

test("a .dark rule stays as it is unless the rules nested in it are of the forms that match only inside the part", () => {
  for (const rule of [
    // +, ~ or > after &, or & after a selector: .dark & alone is the part's element.
    nest(".dark", style("& ~ *")),
    nest(".dark", style("& + *")),
    nest("html.dark", style("& + .a")),
    nest(".dark", style("& > .a")),
    nest(".dark", style(".a &")),
    nest(".dark", media(style("& ~ *"))),
    nest(".dark", nest("&:not(.a)", style("& ~ *"))),
    nest(".dark .a", style("& ~ *")),
    nest(".dark", nest("& .a", style("& + .a"))),
    // & in ().
    nest(".dark", style(":is(& ~ *)")),
    nest(".dark", style(":is(& + *)")),
    nest(".dark", style(":has(+ &)")),
    nest(".dark", style(":has(> &)")),
    nest(".dark", style(":has(&)")),
    nest(".dark", style(":where(& ~ *)")),
    nest("html.dark", style(":is(& ~ *)")),
    nest(".dark", media(style(":is(& ~ *)"))),
    nest(".dark .a", style(":has(&)")),
    // A pseudo-element of the part's element, as .dark::before.
    nest(".dark", style("&::before", '{ content: "x"; }')),
    // An at-rule other than @media, @supports, @container and @layer.
    nest(".dark", scope("& ~ *")),
    nest(".dark", scope("& + *")),
    nest(".dark", scope(":has(> &)")),
    nest(".dark", scope(":has(&)")),
    nest(".dark .a", scope(":has(&)")),
    nest("html.dark", scope("& ~ *")),
    nest(".dark", scope(".a")),
    nest(".dark", at("@starting-style", style("& .a"))),
  ]) {
    assert.equal(ruleText(rule), rule.cssText, rule.cssText);
  }
  const inMedia = [nest(".dark", style("& ~ *")), nest(".dark", scope("& ~ *"))];
  assert.equal(ruleText(media(...inMedia)), `@media (min-width: 1px) {${inMedia.map((r) => r.cssText).join("")}}`);
  // The rules in an at-rule other than those, too.
  const scoped = at("@scope (.a)", style(".dark .b"));
  assert.equal(ruleText(scoped), scoped.cssText);
});

test("a .dark rule is written anew when the rules nested in it match only inside the part", () => {
  for (const rule of [
    nest(".dark", style("& .foo + .foo")),
    nest(".dark", style("&:hover, & .foo")),
    nest(".dark", style("&:not(.a) .foo")),
    nest(".dark", style("& .foo:nth-child(2n+1), & .foo")),
    nest(".dark", style("& .foo::before", '{ content: "x"; }')),
    nest(".dark", nest("& .a", style("& .b"))),
    nest(".dark", media(style("& .a")), at("@supports (display: grid)", style("& .a")), at("@container (min-width: 1px)", style("& .a")), at("@layer a", style("& .a"))),
    // Declarations after a nested rule (CSSNestedDeclarations).
    nest(".dark", style("& .a"), { cssText: "--v: 1;" }),
  ]) {
    assert.equal(ruleText(rule), `.dark &, & .dark${rule.cssText.slice(".dark".length)}`, rule.cssText);
  }
  // Below .dark .a, &::before is the pseudo-element of an element inside the part.
  const below = nest(".dark .a", style("&::before", '{ content: "x"; }'));
  assert.equal(ruleText(below), `.dark & .a, & .dark .a${below.cssText.slice(".dark .a".length)}`);
});

test("a :root rule is written anew in @media, and only when the rules nested in it match only inside the part", () => {
  assert.equal(ruleText(media(style(":root", "{ --x: 1px; }"))), "@media (min-width: 1px) {:root & { --x: 1px; }}");
  const inside = nest(":root", style("& .a"));
  assert.equal(ruleText(inside), `:root &${inside.cssText.slice(":root".length)}`);
  for (const rule of [
    nest(":root", style("& ~ *")),
    nest("html", style("& + .a")),
    nest("body", scope("& ~ *")),
    // A condition on & would be tested on the part's element instead of <html>.
    nest(":root", style("&.dark", "{ --x: 1px; }")),
    nest(":root", media(style("&:not(.dark)", "{ --x: 1px; }"))),
    nest("html", style("&:not(.dark) .a")),
    nest("html body", style("&.a")),
  ]) {
    assert.equal(ruleText(rule), rule.cssText, rule.cssText);
  }
});
  // Below :root .a, & is an element inside the part.
  for (const rule of [nest(":root .a", style("&.b")), nest(":root", nest("& .a", style("&.b")))]) {
    const selector = rule.selectorText!;
    assert.equal(ruleText(rule), `${selector.replace(/^:root/, ":root &")}${rule.cssText.slice(selector.length)}`, rule.cssText);
  }
