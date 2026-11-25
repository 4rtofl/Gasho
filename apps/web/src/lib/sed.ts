// sed's `s` command (`s/<regex>/<replacement>/<flags>`), for renaming the sidebar's worktrees together. The regex is
// JavaScript's, so its groups are `(…)` as with `sed -E`; the replacement takes `\1`–`\9` and `&` (the whole match),
// and the flags `g` (every match) and `i` (case not minded). Any character after the `s` can stand for `/`.

export type Substitution = { ok: true; apply: (text: string) => string } | { ok: false; error: string };

/** An escaped separator is that character as text: one that a regex reads specially stays escaped in it. */
const REGEX_SYNTAX = new Set([..."^$\\.*+?()[]{}|"]);

const FORM = "s/<正規表現>/<置換>/ の形で書いてください。";

type Char = { ch: string; escaped: boolean };

export function parseSubstitution(command: string): Substitution {
  const chars = Array.from(command.trim());
  const sep = chars[1];
  if (chars[0] !== "s" || sep === undefined || sep === "\\" || /\s/.test(sep)) return { ok: false, error: FORM };
  let at = 2;
  // The characters up to the next separator not escaped, each escape as one; undefined when there is none.
  const part = (): Char[] | undefined => {
    const out: Char[] = [];
    for (; at < chars.length; at++) {
      const ch = chars[at]!;
      if (ch === "\\" && at + 1 < chars.length) out.push({ ch: chars[++at]!, escaped: true });
      else if (ch === sep) {
        at++;
        return out;
      } else out.push({ ch, escaped: false });
    }
    return undefined;
  };
  const pattern = part();
  const replacement = pattern && part();
  if (!pattern || !replacement) return { ok: false, error: FORM };
  if (pattern.length === 0) return { ok: false, error: "正規表現を書いてください。" };

  const flags = new Set<string>();
  for (const f of chars.slice(at)) {
    if (f !== "g" && f !== "i") return { ok: false, error: `「${f}」は付けられません。付けられるのは g と i です。` };
    flags.add(f);
  }
  const source = pattern.map(({ ch, escaped }) => (!escaped ? ch : ch === sep && !REGEX_SYNTAX.has(ch) ? ch : `\\${ch}`)).join("");
  let regex: RegExp;
  try {
    regex = new RegExp(source, [...flags].join(""));
  } catch (e) {
    return { ok: false, error: `正規表現が正しくありません（${e instanceof Error ? e.message : String(e)}）。` };
  }
  const groups = new RegExp(`${source}|`).exec("")!.length - 1;

  // Text, or the group of that number (0: the whole match).
  const pieces: (string | number)[] = [];
  for (const { ch, escaped } of replacement) {
    if (!escaped) pieces.push(ch === "&" ? 0 : ch);
    else if (/^[0-9]$/.test(ch)) {
      const n = Number(ch);
      if (n > groups) return { ok: false, error: `置換の \\${n} に当たる括弧が、正規表現にありません。` };
      pieces.push(n);
    } else pieces.push(ch);
  }
  return {
    ok: true,
    apply: (text) =>
      text.replace(regex, (...args: unknown[]) =>
        pieces.map((p) => (typeof p === "string" ? p : typeof args[p] === "string" ? (args[p] as string) : "")).join(""),
      ),
  };
}
