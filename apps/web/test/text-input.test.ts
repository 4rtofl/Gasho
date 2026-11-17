import assert from "node:assert/strict";
import { test } from "node:test";
import { pastedFiles } from "../src/lib/text-input.ts";

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
