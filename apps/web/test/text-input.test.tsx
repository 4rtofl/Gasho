// Which of the page's elements text is written in (typingIn), where a Mac's Ctrl+B moves the cursor. The parts that
// need no page are in text-input.test.ts.
import { expect, test } from "vitest";
import { typingIn } from "@/lib/text-input";

const input = (type?: string) => {
  const el = document.createElement("input");
  if (type) el.type = type;
  return el;
};

test("text is written in a text area and in the boxes of an input that take letters", () => {
  expect(typingIn(document.createElement("textarea"))).toBe(true);
  expect(typingIn(input())).toBe(true);
  for (const type of ["text", "search", "url", "email", "password", "tel", "number"]) expect(typingIn(input(type)), type).toBe(true);
});

test("an input that takes no letters leaves Ctrl+B to the page", () => {
  for (const type of ["checkbox", "radio", "button", "submit", "range", "file", "color", "date"]) expect(typingIn(input(type)), type).toBe(false);
});

test("text is written in an element made editable, and not in other elements", () => {
  const editable = document.createElement("div");
  editable.contentEditable = "true";
  document.body.append(editable);
  expect(typingIn(editable)).toBe(true);
  expect(typingIn(document.createElement("div"))).toBe(false);
  expect(typingIn(document.createElement("button"))).toBe(false);
  expect(typingIn(null)).toBe(false);
  editable.remove();
});
