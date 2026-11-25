import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSubstitution } from "../src/lib/sed.ts";

const apply = (command: string, text: string) => {
  const s = parseSubstitution(command);
  assert.ok(s.ok, s.ok ? "" : s.error);
  return s.apply(text);
};
const error = (command: string) => {
  const s = parseSubstitution(command);
  assert.ok(!s.ok);
  return s.error;
};

test("a sed s command replaces with the groups of a JavaScript regex, the first match or every one", () => {
  assert.equal(apply(String.raw`s/^feat\/([0-9]+)-.*/#\1/`, "feat/264-sidebar-sticky-menu"), "#264");
  assert.equal(apply(String.raw`s/^feat\/([0-9]+)-.*/#\1/`, "main"), "main");
  assert.equal(apply("s/-/ /", "a-b-c"), "a b-c");
  assert.equal(apply("s/-/ /g", "a-b-c"), "a b c");
  assert.equal(apply("s/X/y/gi", "xXx"), "yyy");
  // & is the whole match, \& an &; another separator, escaped where it is text; $ is text.
  assert.equal(apply(String.raw`s|[0-9]+|<&> \& \| $1|`, "#12"), "#<12> & | $1");
  // An escaped separator is that character as text, also one that a regex reads specially.
  assert.equal(apply(String.raw`s.a\.c.X.`, "a.c"), "X");
  assert.equal(apply(String.raw`s.a\.c.X.`, "abc"), "abc");
});

test("a command that is not a sed s command, or that the regex does not fit, says why", () => {
  assert.match(error("feat"), /s\/<正規表現>\/<置換>\//);
  assert.match(error("s/a/b"), /s\/<正規表現>\/<置換>\//);
  assert.match(error("s//b/"), /正規表現を書いてください/);
  assert.match(error("s/a/b/x"), /「x」は付けられません/);
  assert.match(error("s/(a/b/"), /正規表現が正しくありません/);
  assert.match(error(String.raw`s/(a)/\2/`), /\\2 に当たる括弧/);
});
