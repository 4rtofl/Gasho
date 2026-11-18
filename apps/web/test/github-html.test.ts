import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { GITHUB_HTML, webImageSrc } from "../src/lib/github-html.ts";

// The Markdown of a body, drawn with the same plugins as GitHubMarkdown (markdown.tsx), without its own parts.
function html(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [remarkGfm, remarkBreaks], rehypePlugins: GITHUB_HTML }, text));
}

test("an image pasted on GitHub stays, with its size and alt text", () => {
  const out = html('スクリーンショット\n\n<img width="600" alt="Gasho のホーム" src="https://github.com/user-attachments/assets/1b2c3d" />\n');
  assert.match(out, /<img [^>]*src="https:\/\/github\.com\/user-attachments\/assets\/1b2c3d"/);
  assert.match(out, /<img [^>]*width="600"/);
  assert.match(out, /<img [^>]*alt="Gasho のホーム"/);
});

test("a <details> keeps its <summary>, and the Markdown inside it is still Markdown", () => {
  const out = html("<details>\n<summary>ログ</summary>\n\n- **1 行目**\n- 2 行目<br>続き\n\n</details>\n");
  assert.match(out, /^<details>\s*<summary>ログ<\/summary>/);
  assert.match(out, /<li><strong>1 行目<\/strong><\/li>/);
  assert.match(out, /2 行目<br\/>続き/);
  assert.match(out, /<\/ul>\s*<\/details>$/);
});

test("scripts, event attributes, style and javascript: addresses go", () => {
  const out = html(
    [
      '<img src="https://example.com/a.png" onerror="alert(1)" style="position:fixed;inset:0" />',
      "",
      '<img src="javascript:alert(2)" alt="x" />',
      "",
      '<a href="javascript:alert(3)" onclick="alert(4)">リンク</a>',
      "",
      "<script>alert(5)</script>",
      "",
      "<style>body { display: none }</style>",
      "",
      '<iframe src="https://example.com"></iframe>',
      "",
      '<div style="color:red" onmouseover="alert(6)">本文</div>',
    ].join("\n"),
  );
  assert.doesNotMatch(out, /alert|javascript|onerror|onclick|onmouseover|style|<script|<iframe|display: none/i);
  // What is allowed in them is kept.
  assert.match(out, /<img src="https:\/\/example\.com\/a\.png"\/>/);
  assert.match(out, /<a>リンク<\/a>/);
  assert.match(out, /<div>本文<\/div>/);
});

test("HTML outside GitHub's list is not drawn; its text is kept as on GitHub", () => {
  const out = html('<form action="https://example.com"><button>送る</button></form>\n\n<marquee>流れる</marquee>\n');
  assert.doesNotMatch(out, /<form|<button|<marquee/);
  assert.match(out, /送る/);
  assert.match(out, /流れる/);
});

test("a <picture> shows its <img>; its <source> goes, so that every image passes webImageSrc", () => {
  const out = html(
    '<picture><source media="(prefers-color-scheme: dark)" srcset="/dark.png"><img alt="ロゴ" src="https://example.com/light.png"></picture>\n',
  );
  assert.doesNotMatch(out, /<source|srcset|dark\.png/i);
  assert.match(out, /<img alt="ロゴ" src="https:\/\/example\.com\/light\.png"\/>/);
});

test("an image is loaded only from http or https", () => {
  assert.equal(webImageSrc("https://github.com/user-attachments/assets/1b2c3d"), "https://github.com/user-attachments/assets/1b2c3d");
  assert.equal(webImageSrc(" http://example.com/a.png "), "http://example.com/a.png");
  assert.equal(webImageSrc("JaVa\tScript:alert(1)"), undefined);
  assert.equal(webImageSrc("data:image/svg+xml,<svg onload=alert(1)>"), undefined);
  // A relative address would load from Gasho's own server.
  assert.equal(webImageSrc("docs/home.png"), undefined);
  assert.equal(webImageSrc("//example.com/a.png"), undefined);
  assert.equal(webImageSrc("https://user:pass@example.com/a.png"), undefined);
  assert.equal(webImageSrc(undefined), undefined);
});
