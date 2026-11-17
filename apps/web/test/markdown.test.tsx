import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { MarkdownText } from "@/components/markdown";

const draw = (text: string) => render(<MarkdownText text={text} />).container;

test("HTML in Claude's text is never rendered, and links that would run script are plain text", () => {
  const box = draw('前 <img src="https://evil.test/x.png" onerror="alert(1)"> <script>alert(1)</script> 後\n\n[開く](javascript:alert(1)) と [GitHub](https://github.com/4rtofl/Gasho)');
  expect(box.querySelector("img, script")).toBeNull();
  expect(screen.queryByRole("link", { name: "開く" })).toBeNull();
  expect(screen.getByText("開く").tagName).toBe("SPAN");
  const link = screen.getByRole("link", { name: "GitHub" });
  expect(link.getAttribute("href")).toBe("https://github.com/4rtofl/Gasho");
  expect(link.getAttribute("rel")).toContain("noopener");
});

test("an image is a link to it, so that opening a conversation loads nothing from other servers", () => {
  const box = draw("![図](https://example.test/a.png)");
  expect(box.querySelector("img")).toBeNull();
  expect(screen.getByRole("link", { name: "画像：図" }).getAttribute("href")).toBe("https://example.test/a.png");
});

test("a single newline breaks the line, and tables, task lists and code blocks are drawn", () => {
  const box = draw(
    [
      "1 行目",
      "2 行目",
      "",
      "| 名前 | 数 |",
      "| --- | --: |",
      "| テスト | 3 |",
      "",
      "- [x] 済んだ",
      "- [ ] まだ",
      "",
      "```ts",
      "const a = 1;",
      "```",
    ].join("\n"),
  );
  expect(box.querySelector("p")?.innerHTML).toMatch(/1 行目<br>\s*2 行目/);
  expect(screen.getByRole("columnheader", { name: "名前" })).toBeTruthy();
  expect(screen.getByRole("cell", { name: "3" }).style.textAlign).toBe("right");
  const boxes = screen.getAllByRole<HTMLInputElement>("checkbox");
  expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
    [true, true],
    [false, true],
  ]);
  expect(screen.getByText("const a = 1;")).toBeTruthy();
  expect(screen.getByText("ts")).toBeTruthy();
});
