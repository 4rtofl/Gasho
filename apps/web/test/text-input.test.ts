import assert from "node:assert/strict";
import { test } from "node:test";
import { appleKeys, closesPanel, pastedFiles } from "../src/lib/text-input.ts";

const esc = (isComposing: boolean, keyCode: number) => ({ key: "Escape", nativeEvent: { isComposing }, keyCode });

test("Esc closes the panel", () => {
  assert.equal(closesPanel(esc(false, 27)), true);
});

test("the Esc that cancels a conversion leaves the panel open", () => {
  // Chrome sends it while the conversion is on; an input method's keys also come with keyCode 229.
  assert.equal(closesPanel(esc(true, 229)), false);
  assert.equal(closesPanel(esc(false, 229)), false);
});

const png = new File([new Uint8Array([1, 2, 3])], "image.png", { type: "image/png" });
const clipboard = (files: File[], text = "") => ({ files, getData: (type: string) => (type === "text/plain" ? text : "") });

test("a file copied without text is attached", () => {
  assert.deepEqual(pastedFiles(clipboard([png]), true), [png]);
});

test("cells copied with a picture of them paste as text", () => {
  assert.deepEqual(pastedFiles(clipboard([png], "A1\tB1\nA2\tB2"), true), []);
});

test("files copied in the Finder are attached in Safari, which also gives their names as text", () => {
  const pdf = new File([new Uint8Array([4])], "spec.pdf", { type: "application/pdf" });
  assert.deepEqual(pastedFiles(clipboard([png, pdf], "spec.pdf\nimage.png"), true), [png, pdf]);
  // Lines ended by a CR alone, and a name whose voiced mark is a letter of its own (NFD) beside the same name in one.
  const kana = new File([new Uint8Array([5])], "\u30d5\u3099\u30fc\u30c4.txt", { type: "text/plain" });
  assert.deepEqual(pastedFiles(clipboard([png, kana], "image.png\r\u30d6\u30fc\u30c4.txt"), true), [png, kana]);
  // Text that mentions a file's name stays text.
  assert.deepEqual(pastedFiles(clipboard([png], "see image.png"), true), []);
  assert.deepEqual(pastedFiles(clipboard([png, pdf], "image.png"), true), []);
});

test("nothing is attached where files cannot be", () => {
  assert.deepEqual(pastedFiles(clipboard([png]), false), []);
});

test("Ctrl+B is left to a text box on a Mac, iPhone and iPad, not on Windows, Linux or Android", () => {
  const apple = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  ];
  const others = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0",
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
  ];
  for (const ua of apple) assert.equal(appleKeys(ua), true, ua);
  for (const ua of others) assert.equal(appleKeys(ua), false, ua);
});
