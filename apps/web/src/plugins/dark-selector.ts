/** `.dark` at the start of the text, as the class "dark" (not `.darker`, nor Tailwind's `.dark\:text-sky-400`). */
const DARK = /^\.dark(?![\w\\-]|[^\x00-\x7f])/;
/** A pseudo-element at the start of the text: a selector cannot go on after one. */
const PSEUDO_ELEMENT = /^:(:|before\b|after\b|first-line\b|first-letter\b)/i;

/**
 * The index of the first character from `from` outside strings (and, unless `nested`, outside () and []) that `at`
 * accepts, or the length of `text`.
 */
function find(text: string, from: number, at: (i: number) => boolean, nested = false): number {
  let depth = 0;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") i++;
    else if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if ((nested || depth === 0) && at(i)) return i;
  }
  return text.length;
}

/** `.dark .foo` as `.dark & .foo, & .dark .foo`; another selector as it is. */
function dark(selector: string): string {
  // CSS nesting puts `& ` before a selector only when it has no `&` (even in `:is()`): one with `&` places the part itself.
  if (find(selector, 0, (i) => selector[i] === "&", true) < selector.length) return selector;
  const end = find(selector, 0, (i) => /[\s>+~]/.test(selector[i]!));
  const first = selector.slice(0, end);
  const rest = selector.slice(end);
  if (find(first, 0, (i) => first[i] === "." && DARK.test(first.slice(i))) === first.length) return selector;
  if (find(first, 0, (i) => PSEUDO_ELEMENT.test(first.slice(i))) < first.length) return selector;
  // After `.dark &`, `+` and `~` would match the elements beside the plugin's part, which are Gasho's.
  if (/^\s*[+~]/.test(rest)) return selector;
  return `${first} &${rest}, & ${selector}`;
}

/**
 * The selectors of a style rule of a plugin's web.css (its selectorText), for the rule nested in the plugin's part
 * (registry.ts), or undefined when none changes. Nested there, a selector is looked for inside the element the part
 * is drawn in, so that `.dark .foo` would want a `.dark` inside the part and miss `<html class="dark">`. A selector
 * whose first compound selector has `.dark` is written to match below a `.dark` above the part (as Tailwind's `dark:`,
 * `:is(.dark *)`, does) or inside it. `&` is the `:where()` the rule is nested in, so the specificity stays as it was.
 */
export function darkSelector(selectorText: string): string | undefined {
  const selectors: string[] = [];
  for (let start = 0; start <= selectorText.length; ) {
    const comma = find(selectorText, start, (i) => selectorText[i] === ",");
    selectors.push(selectorText.slice(start, comma).trim());
    start = comma + 1;
  }
  const out = selectors.map(dark);
  return out.some((s, i) => s !== selectors[i]) ? out.join(", ") : undefined;
}
