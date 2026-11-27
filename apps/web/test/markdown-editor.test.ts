import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@codemirror/state";
import { parseMarkdown, previewLooks } from "../src/lib/markdown-editor.ts";

/** What the box shows of `text` with the cursor at `caret` (none: not being typed in): its marks hidden or drawn. */
function shown(text: string, caret?: number): string {
  const looks = previewLooks(parseMarkdown(text), Text.of(text.split("\n")), caret === undefined ? null : [{ from: caret, to: caret }]);
  let out = "";
  let at = 0;
  for (const l of looks.filter((l) => l.kind === "hide" || l.kind === "bullet").sort((a, b) => a.from - b.from)) {
    out += text.slice(at, l.from) + (l.kind === "bullet" ? "•" : "");
    at = l.to;
  }
  return out + text.slice(at);
}

test("the marks are hidden, and shown on what the cursor is in or next to", () => {
  const text = "**太字** と `~/Project` と [資料](https://example.com)";
  assert.equal(shown(text), "太字 と ~/Project と 資料");
  assert.equal(shown(text, 3), "**太字** と ~/Project と 資料");
  // Next to the closing mark is on it, so that typing on after it shows what is typed.
  assert.equal(shown(text, 6), "**太字** と ~/Project と 資料");
  assert.equal(shown(text, 7), "太字 と ~/Project と 資料");
  assert.equal(shown(text, 12), "太字 と `~/Project` と 資料");
});

test("a heading's and a quote's marks are shown while the cursor is on their line, a bullet's next to it", () => {
  const text = "# 見出し\n> 引用\n- 項目\n1. 番号";
  assert.equal(shown(text), "見出し\n引用\n• 項目\n1. 番号");
  assert.equal(shown(text, 5), "# 見出し\n引用\n• 項目\n1. 番号");
  assert.equal(shown(text, 8), "見出し\n> 引用\n• 項目\n1. 番号");
  // Just after "- ", where an item is begun.
  assert.equal(shown(text, 13), "見出し\n引用\n- 項目\n1. 番号");
  assert.equal(shown(text, 15), "見出し\n引用\n• 項目\n1. 番号");
});

test("a code block's fences are hidden unless the cursor is in the block, and nothing in it is formatted", () => {
  const text = "```ts\nconst **a** = 1;\n```\n次";
  assert.equal(shown(text, text.length), "\nconst **a** = 1;\n\n次");
  assert.equal(shown(text, 8), text);
});

test("what Markdown shows as typed stays as typed: a reference without a link, an image, a lone \"*\"", () => {
  assert.equal(shown("[参照] と ![図](a.png)"), "[参照] と ![図](a.png)");
  assert.equal(shown("2 * 3 * 4"), "2 * 3 * 4");
});

test("a link whose address goes on to the next line stays as typed, as the editor cannot hide a line break", () => {
  assert.equal(shown("[資料](\nhttps://example.com)"), "[資料](\nhttps://example.com)");
  assert.equal(shown('[資料](https://example.com\n"題")'), '[資料](https://example.com\n"題")');
  assert.equal(shown("[資\n料](https://example.com)"), "資\n料");
});
