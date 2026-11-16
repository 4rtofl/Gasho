import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cellarNode, serviceNode, stableNode } from "../src/node-path.ts";
import { launchdPlist, serviceNodeCheck, systemdUnit } from "../src/setup.ts";

/** A Homebrew prefix in a temporary folder: Cellar/<formula>/<version>/bin/node, opt/<formula> and bin/node linked to it. */
function brew(formula: string, version: string, linkBin = true): { prefix: string; node: string } {
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-brew-"));
  const keg = path.join(prefix, "Cellar", formula, version);
  fs.mkdirSync(path.join(keg, "bin"), { recursive: true });
  fs.writeFileSync(path.join(keg, "bin", "node"), "");
  fs.mkdirSync(path.join(prefix, "opt"));
  fs.symlinkSync(`../Cellar/${formula}/${version}`, path.join(prefix, "opt", formula));
  if (linkBin) {
    fs.mkdirSync(path.join(prefix, "bin"));
    fs.symlinkSync(`../Cellar/${formula}/${version}/bin/node`, path.join(prefix, "bin", "node"));
  }
  return { prefix, node: path.join(keg, "bin", "node") };
}

test("Homebrew's folder for a version of node is recognized, other installs are not", () => {
  assert.deepEqual(cellarNode("/opt/homebrew/Cellar/node/26.13.0_1/bin/node"), { prefix: "/opt/homebrew", formula: "node" });
  assert.deepEqual(cellarNode("/usr/local/Cellar/node@24/24.22.2/bin/node"), { prefix: "/usr/local", formula: "node@24" });
  assert.equal(cellarNode("/opt/homebrew/bin/node"), undefined);
  assert.equal(cellarNode("/opt/homebrew/opt/node/bin/node"), undefined);
  assert.equal(cellarNode("/home/u/.local/opt/node-v24.22.2-linux-x64/bin/node"), undefined);
  assert.equal(cellarNode("/home/u/.nvm/versions/node/v24.22.2/bin/node"), undefined);
});

test("the service runs Homebrew's link in opt, which stays across versions, rather than the Cellar folder", () => {
  const { prefix, node } = brew("node", "26.13.0_1");
  try {
    assert.equal(stableNode(fs.realpathSync(node)), path.join(fs.realpathSync(prefix), "opt", "node", "bin", "node"));
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});

test("a keg-only node@24 (not linked in bin) gets its link in opt", () => {
  const { prefix, node } = brew("node@24", "24.22.2", false);
  try {
    assert.equal(stableNode(fs.realpathSync(node)), path.join(fs.realpathSync(prefix), "opt", "node@24", "bin", "node"));
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});

test("bin/node is used when opt does not lead to the same file, and nothing that leads elsewhere is", () => {
  const cellar = "/opt/homebrew/Cellar/node/26.13.0_1/bin/node";
  const links = (map: Record<string, string>) => (f: string) => (f === cellar ? cellar : map[f]);
  assert.equal(stableNode(cellar, links({ "/opt/homebrew/bin/node": cellar })), "/opt/homebrew/bin/node");
  // bin/node is another formula's (node@24 linked), opt/node is gone: the Cellar path stays.
  assert.equal(stableNode(cellar, links({ "/opt/homebrew/bin/node": "/opt/homebrew/Cellar/node@24/24.22.2/bin/node" })), cellar);
});

test("a Node.js that is not Homebrew's keeps its path, version in it or not (Linux: put in by hand)", () => {
  const never = () => assert.fail("not looked up");
  for (const node of ["/home/u/.local/opt/node-v24.22.2-linux-x64/bin/node", "/usr/bin/node", "/opt/homebrew/bin/node"]) {
    assert.equal(stableNode(node, never), node);
  }
});

test("the Node.js of a service's file is read back from systemd's unit and launchd's agent", () => {
  const input = { node: "/opt/n%de/bin/node", argv: ['/opt/n%de "x"/bin/node', "/h/cli.js"], cwd: "/h", path: "/usr/bin", home: "/h" };
  assert.equal(serviceNode(systemdUnit(input)), '/opt/n%de "x"/bin/node');
  assert.equal(serviceNode(launchdPlist({ ...input, argv: ["/a&b/<n>/node", "/h/cli.js"] })), "/a&b/<n>/node");
  assert.equal(serviceNode("ExecStart=/usr/bin/node /h/cli.js run\n"), "/usr/bin/node");
  assert.equal(serviceNode("nothing here"), undefined);
});

test("doctor warns about a service that runs Node.js from Homebrew's folder for one version", () => {
  const unit = (node: string) => launchdPlist({ node, argv: [node, "/h/cli.js"], cwd: "/h", path: "/usr/bin", home: "/h" });
  const cellar = "/opt/homebrew/Cellar/node/26.13.0_1/bin/node";
  const warn = serviceNodeCheck(unit(cellar), "npx gasho-daemon", () => "/opt/homebrew/opt/node/bin/node");
  assert.equal(warn?.level, "warn");
  assert.match(warn?.detail ?? "", /26\.13\.0_1/);
  assert.match(warn?.hint ?? "", /service install/);
  assert.match(warn?.hint ?? "", /\/opt\/homebrew\/opt\/node\/bin\/node/);
  assert.equal(serviceNodeCheck(unit(cellar), "npx gasho-daemon", (n) => n)?.level, "warn");
  assert.equal(serviceNodeCheck(unit("/opt/homebrew/opt/node/bin/node"), "npx gasho-daemon")?.level, "ok");
  // Linux: a Node.js put in by hand, version in its path, is left alone.
  assert.equal(serviceNodeCheck(unit("/home/u/.local/opt/node-v24.22.2-linux-x64/bin/node"), "npx gasho-daemon")?.level, "ok");
  assert.equal(serviceNodeCheck("", "npx gasho-daemon"), undefined);
});
