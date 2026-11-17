import assert from "node:assert/strict";
import { test } from "node:test";
import { closesPanel } from "../src/lib/text-input.ts";

const esc = (isComposing: boolean, keyCode: number) => ({ key: "Escape", nativeEvent: { isComposing }, keyCode });

test("Esc closes the panel", () => {
  assert.equal(closesPanel(esc(false, 27)), true);
});

test("the Esc that cancels a conversion leaves the panel open", () => {
  // Chrome sends it while the conversion is on; an input method's keys also come with keyCode 229.
  assert.equal(closesPanel(esc(true, 229)), false);
  assert.equal(closesPanel(esc(false, 229)), false);
});
