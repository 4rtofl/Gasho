import assert from "node:assert/strict";
import { test } from "node:test";
import { closesPanel, pastedFiles } from "../src/lib/text-input.ts";

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

test("nothing is attached where files cannot be", () => {
  assert.deepEqual(pastedFiles(clipboard([png]), false), []);
});
