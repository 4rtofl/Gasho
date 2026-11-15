import assert from "node:assert/strict";
import { test } from "node:test";
import { matchSlash, slashQuery } from "../src/lib/slash.ts";

test("the list is offered while the text is a '/' and the start of a name, not once something follows it", () => {
  assert.equal(slashQuery("/"), "");
  assert.equal(slashQuery("/impl"), "impl");
  assert.equal(slashQuery("/impl-review "), undefined);
  assert.equal(slashQuery("/impl-review 63"), undefined);
  assert.equal(slashQuery(" /impl"), undefined);
  assert.equal(slashQuery("メモ /impl"), undefined);
});

test("names that start with the typed text come first, then those with a part that does", () => {
  const commands = [
    { name: "issue-implement" },
    { name: "impl-review" },
    { name: "anthropic-skills:beer-style" },
    { name: "impl-explain" },
    { name: "simplify" },
    { name: "anthropic-skills:toki-pona" },
  ];
  const names = (q: string) => matchSlash(commands, q).map((m) => `${m.command.name}@${m.at}`);
  assert.deepEqual(names("impl"), ["impl-explain@0", "impl-review@0", "issue-implement@6"]);
  assert.deepEqual(names("REVIEW"), ["impl-review@5"]);
  assert.deepEqual(names("beer"), ["anthropic-skills:beer-style@17"]);
  assert.deepEqual(names("anthropic-skills:b"), ["anthropic-skills:beer-style@0"]);
  // A namespace does not put a skill first: "anthropic-skills:toki-pona" is among the t's.
  assert.deepEqual(
    names("").map((n) => n.replace(/@0$/, "")),
    ["anthropic-skills:beer-style", "impl-explain", "impl-review", "issue-implement", "simplify", "anthropic-skills:toki-pona"],
  );
  assert.deepEqual(names("plify"), []);
});
