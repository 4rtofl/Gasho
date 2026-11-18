/** `.dark` at the start of the text, as the class "dark" (not `.darker`, nor Tailwind's `.dark\:text-sky-400`). */
const DARK = /^\.dark(?![\w\\-]|[^\x00-\x7f])/;
/** `:root`, `html` or `body` at the start of a compound selector: the elements every part is drawn inside. */
const ROOT = /^(:root|html|body)(?![\w\\-]|[^\x00-\x7f])/i;
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

/** Where the compound selector of `selector` that starts at `from` ends. */
function compoundEnd(selector: string, from: number): number {
  return find(selector, from, (i) => /[\s>+~]/.test(selector[i]!));
}

/** Where a rule's elements are: the element the plugin's part is drawn in, or inside it. */
type Place = "part" | "inside";

/**
 * Where a selector nested in a rule at `parent` matches, for the selectors that cannot match outside the part: `.foo`
 * (which CSS nesting reads as `& .foo`), `&:hover`, and `&:hover .foo`. Undefined for any other, such as one with `&`
 * after a combinator or in (), or with a combinator other than a space after `&`. `root`: the rule at `parent` is of
 * `:root`, `html` or `body`.
 */
function place(selector: string, parent: Place, root: boolean): Place | undefined {
  const amp = find(selector, 0, (i) => selector[i] === "&", true);
  if (amp === selector.length) return /^[>+~]/.test(selector) ? undefined : "inside";
  if (amp > 0 || find(selector, 1, (i) => selector[i] === "&", true) < selector.length) return undefined;
  const end = compoundEnd(selector, 1);
  // There `&` is the part's element in place of <html> or <body>, so `&.dark` and `&:not(.dark) .foo` would test it.
  if (root && parent === "part" && end > 1) return undefined;
  if (end < selector.length) return /^\s+[^\s>+~]/.test(selector.slice(end)) ? "inside" : undefined;
  // Like `.dark::before` (inPart), the part's element's `&::before` is left as it is.
  if (find(selector, 1, (i) => PSEUDO_ELEMENT.test(selector.slice(i))) < end) return parent === "inside" ? parent : undefined;
  return parent;
}

/** The at-rules whose rules match as they would outside them. */
const GROUP = /^@(media|supports|container|layer)\b/i;

/**
 * Whether the rules in a rule at `parent`, at any depth, match only inside the part: style rules with place's
 * selectors, the at-rules of GROUP, and declarations. `root`: as in place.
 */
function inside(rules: ArrayLike<CssRule> | undefined, parent: Place, root: boolean): boolean {
  return Array.from(rules ?? []).every((r) => {
    if (r.selectorText === undefined) return !r.cssText.startsWith("@") || (GROUP.test(r.cssText) && inside(r.cssRules, parent, root));
    const places = split(r.selectorText).map((s) => place(s, parent, root));
    return !places.includes(undefined) && inside(r.cssRules, places.includes("part") ? "part" : "inside", root);
  });
}

function hasPseudoElement(compound: string): boolean {
  return find(compound, 0, (i) => PSEUDO_ELEMENT.test(compound.slice(i))) < compound.length;
}

/**
 * The end of the compound selectors of `:root`, `html` and `body` at the start of `selector`, each in or below the one
 * before it (`html body`, `html > body`), or 0.
 */
function rootEnd(selector: string): number {
  let end = 0;
  for (let from = 0; ROOT.test(selector.slice(from)); ) {
    const compound = compoundEnd(selector, from);
    if (hasPseudoElement(selector.slice(from, compound))) break;
    end = compound;
    const combinator = /^\s*>?\s*/.exec(selector.slice(end))![0];
    if (!combinator) break;
    from = end + combinator.length;
  }
  return end;
}

/**
 * `:root .foo` as `:root & .foo`, `.dark .foo` as `.dark & .foo, & .dark .foo`; another selector as it is. `nested`:
 * the rules in the selector's rule.
 */
function inPart(selector: string, nested: ArrayLike<CssRule>): string {
  // CSS nesting puts `& ` before a selector only when it has no `&` (even in `:is()`): one with `&` places the part itself.
  if (find(selector, 0, (i) => selector[i] === "&", true) < selector.length) return selector;
  const root = rootEnd(selector);
  const first = selector.slice(0, root || compoundEnd(selector, 0));
  const rest = selector.slice(first.length);
  if (!root && find(first, 0, (i) => first[i] === "." && DARK.test(first.slice(i))) === first.length) return selector;
  if (!root && hasPseudoElement(first)) return selector;
  // After `.dark &`, `+` and `~` would match the elements beside the plugin's part, which are Gasho's. For the rules
  // nested in the selector's, `.dark &` is the part's element itself, and `.dark & .foo` an element inside it.
  if (/^\s*[+~]/.test(rest) || !inside(nested, rest ? "inside" : "part", root > 0)) return selector;
  // No element inside the part is :root, html or body.
  return root ? `${first} &${rest}` : `${first} &${rest}, & ${selector}`;
}

/**
 * The selectors of a style rule of a plugin's web.css (its selectorText), for the rule nested in the plugin's part
 * (registry.ts), or undefined when none changes. Nested there, a selector is looked for inside the element the part
 * is drawn in, so that `:root .foo` and `.dark .foo` would miss the `<html>` above the part. A selector whose first
 * compound selectors are of `:root`, `html` and `body` is written to match the part's element or inside it, when they
 * match; one whose first compound selector has `.dark`, to match below a `.dark` above the part (as Tailwind's
 * `dark:`, `:is(.dark *)`, does) or inside it. `&` is the `:where()` the rule is nested in, so the specificity stays
 * as it was. `nested`: the rules in the style rule.
 */
export function partSelector(selectorText: string, nested: ArrayLike<CssRule> = []): string | undefined {
  const selectors = split(selectorText);
  const out = selectors.map((s) => inPart(s, nested));
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

/** A style rule or an at-rule of GROUP of a plugin's web.css, with partSelector's selectors; another rule as it is. */
export function ruleText(rule: CssRule): string {
  if (rule.selectorText !== undefined) {
    const selector = partSelector(rule.selectorText, rule.cssRules);
    // CSSOM writes a style rule as its selectorText and then its block.
    if (selector && rule.cssText.startsWith(rule.selectorText)) return selector + rule.cssText.slice(rule.selectorText.length);
  } else if (rule.cssRules && GROUP.test(rule.cssText)) {
    return `${rule.cssText.slice(0, blockStart(rule.cssText))}{${Array.from(rule.cssRules, ruleText).join("")}}`;
  }
  return rule.cssText;
}
