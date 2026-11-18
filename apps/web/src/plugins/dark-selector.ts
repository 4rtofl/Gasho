/** `.dark` at the start of the text, as the class "dark" (not `.darker`, nor Tailwind's `.dark\:text-sky-400`). */
const DARK = /^\.dark(?![\w\\-]|[^\x00-\x7f])/;
/** A pseudo-element at the start of the text: a selector cannot go on after one. */
const PSEUDO_ELEMENT = /^:(:|before\b|after\b|first-line\b|first-letter\b)/i;

/**
 * The index of the first character from `from` outside strings (and, unless `nested`, outside () and []) that `at`
 * accepts, or the length of `text`. `at` gets how deep in () and [] the character is.
 */
function find(text: string, from: number, at: (i: number, depth: number) => boolean, nested = false): number {
  let depth = 0;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") {
      // A hex escape (`\31 ` in `.\31 23`) is up to 6 hex digits and the one whitespace after them.
      i += /^[\da-f]{1,6}\s?/i.exec(text.slice(i + 1, i + 8))?.[0].length ?? 1;
    } else if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if ((nested || depth === 0) && at(i, depth)) return i;
  }
  return text.length;
}

/** Where the block of a rule's cssText starts: its first `{` outside (), [] and strings (as in `@supports (content: "{")`). */
function blockStart(cssText: string): number {
  return find(cssText, 0, (i) => cssText[i] === "{");
}

/** The selectors of a selector list. */
function split(selectorText: string): string[] {
  const selectors: string[] = [];
  for (let start = 0; start <= selectorText.length; ) {
    const comma = find(selectorText, start, (i) => selectorText[i] === ",");
    selectors.push(selectorText.slice(start, comma).trim());
    start = comma + 1;
  }
  return selectors;
}

/** Where a rule's elements are: the element the plugin's part is drawn in, or inside it. */
type Place = "part" | "inside";

/**
 * Where a selector nested in a rule at `parent` matches, or undefined when it can match outside the part (Gasho's
 * elements) or a pseudo-element of the part's element.
 */
function place(selector: string, parent: Place): Place | undefined {
  // `:has(&)` matches the elements around `&`, and `:is(& ~ *)` those beside it.
  if (find(selector, 0, (i, depth) => depth > 0 && selector[i] === "&", true) < selector.length) return undefined;
  if (parent === "inside") return parent;
  // CSS nesting puts a selector without `&` after `& `, and one that starts with a combinator after `&`.
  let amp = -1;
  find(selector, 0, (i) => {
    if (selector[i] === "&") amp = i;
    return false;
  });
  const after = amp < 0 ? selector : selector.slice(find(selector, amp, (i) => /[\s>+~]/.test(selector[i]!)));
  if (/^\s*[+~]/.test(after)) return undefined;
  if (amp < 0 || after) return "inside";
  // Like `.dark::before` (dark), `&::before` is left as it is: it would be drawn by the part's element.
  return find(selector, amp, (i) => PSEUDO_ELEMENT.test(selector.slice(i))) < selector.length ? undefined : "part";
}

/** Whether a rule in `rules`, at any depth, can match outside the part when the rule they are in matches at `parent`. */
function escapes(rules: ArrayLike<CssRule> | undefined, parent: Place): boolean {
  return Array.from(rules ?? []).some((r) => {
    if (r.selectorText === undefined) return escapes(r.cssRules, parent);
    const places = split(r.selectorText).map((s) => place(s, parent));
    return places.includes(undefined) || escapes(r.cssRules, places.includes("part") ? "part" : "inside");
  });
}

/** `.dark .foo` as `.dark & .foo, & .dark .foo`; another selector as it is. `nested`: the rules in the selector's rule. */
function dark(selector: string, nested: ArrayLike<CssRule>): string {
  // CSS nesting puts `& ` before a selector only when it has no `&` (even in `:is()`): one with `&` places the part itself.
  if (find(selector, 0, (i) => selector[i] === "&", true) < selector.length) return selector;
  const end = find(selector, 0, (i) => /[\s>+~]/.test(selector[i]!));
  const first = selector.slice(0, end);
  const rest = selector.slice(end);
  if (find(first, 0, (i) => first[i] === "." && DARK.test(first.slice(i))) === first.length) return selector;
  if (find(first, 0, (i) => PSEUDO_ELEMENT.test(first.slice(i))) < first.length) return selector;
  // After `.dark &`, `+` and `~` would match the elements beside the plugin's part, which are Gasho's. For the rules
  // nested in the selector's, `.dark &` is the part's element itself, and `.dark & .foo` an element inside it.
  if (/^\s*[+~]/.test(rest) || escapes(nested, rest ? "inside" : "part")) return selector;
  return `${first} &${rest}, & ${selector}`;
}

/**
 * The selectors of a style rule of a plugin's web.css (its selectorText), for the rule nested in the plugin's part
 * (registry.ts), or undefined when none changes. Nested there, a selector is looked for inside the element the part
 * is drawn in, so that `.dark .foo` would want a `.dark` inside the part and miss `<html class="dark">`. A selector
 * whose first compound selector has `.dark` is written to match below a `.dark` above the part (as Tailwind's `dark:`,
 * `:is(.dark *)`, does) or inside it. `&` is the `:where()` the rule is nested in, so the specificity stays as it was.
 * `nested`: the rules in the style rule.
 */
export function darkSelector(selectorText: string, nested: ArrayLike<CssRule> = []): string | undefined {
  const selectors = split(selectorText);
  const out = selectors.map((s) => dark(s, nested));
  return out.some((s, i) => s !== selectors[i]) ? out.join(", ") : undefined;
}

/** What ruleText reads of a CSSOM rule. */
export interface CssRule {
  readonly cssText: string;
  /** A style rule's selectors. */
  readonly selectorText?: string;
  /** The rules inside a style rule or a rule like @media. */
  readonly cssRules?: ArrayLike<CssRule>;
}

/** A style rule or a rule with rules inside (@media, @supports…) of a plugin's web.css, with darkSelector's selectors. */
export function ruleText(rule: CssRule): string {
  if (rule.selectorText !== undefined) {
    const selector = darkSelector(rule.selectorText, rule.cssRules);
    // CSSOM writes a style rule as its selectorText and then its block.
    if (selector && rule.cssText.startsWith(rule.selectorText)) return selector + rule.cssText.slice(rule.selectorText.length);
  } else if (rule.cssRules) {
    return `${rule.cssText.slice(0, blockStart(rule.cssText))}{${Array.from(rule.cssRules, ruleText).join("")}}`;
  }
  return rule.cssText;
}
