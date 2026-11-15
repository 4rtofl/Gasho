import assert from "node:assert/strict";
import { test } from "node:test";
import { savedChoices } from "../src/lib/flag.ts";

test("several choices are read back, and a value saved when only one could be chosen is read as choosing it", () => {
  const app = ["mac", "/src/app"].join("\u001f");
  const lib = ["ubuntu", "/src/lib"].join("\u001f");
  assert.deepEqual(savedChoices(null), []);
  assert.deepEqual(savedChoices(JSON.stringify([app, lib])), [app, lib]);
  assert.deepEqual(savedChoices(app), [app]);
  // Valid JSON, but not a list of ids.
  assert.deepEqual(savedChoices("42"), ["42"]);
});
