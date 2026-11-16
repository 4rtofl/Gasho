import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stableNode } from "../src/node-path.ts";

test("the hub's service runs Homebrew's link in opt rather than the folder for one version of node", () => {
  const prefix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gasho-brew-")));
  try {
    const keg = path.join(prefix, "Cellar", "node", "26.13.0_1");
    fs.mkdirSync(path.join(keg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(keg, "bin", "node"), "");
    fs.mkdirSync(path.join(prefix, "opt"));
    fs.symlinkSync("../Cellar/node/26.13.0_1", path.join(prefix, "opt", "node"));
    assert.equal(stableNode(path.join(keg, "bin", "node")), path.join(prefix, "opt", "node", "bin", "node"));
    // The opt link moved to another version: it no longer leads to the same file, so the path is kept.
    fs.rmSync(path.join(prefix, "opt", "node"));
    fs.symlinkSync("../Cellar/node/27.0.0", path.join(prefix, "opt", "node"));
    assert.equal(stableNode(path.join(keg, "bin", "node")), path.join(keg, "bin", "node"));
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});

test("a Node.js put in by hand keeps its path on the hub's service too", () => {
  assert.equal(stableNode("/home/u/.local/opt/node-v24.22.2-linux-x64/bin/node"), "/home/u/.local/opt/node-v24.22.2-linux-x64/bin/node");
});
