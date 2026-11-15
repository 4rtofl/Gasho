import assert from "node:assert/strict";
import { test } from "node:test";
import { latestTag, nextVersion, PACKAGES, parseVersion, pluginApi, registryPackages } from "./release.ts";

test("a feature raises y and puts z back to 0; a fix raises z", () => {
  assert.equal(nextVersion("0.13.0", "minor", 0), "0.14.0");
  assert.equal(nextVersion("0.12.1", "minor", 0), "0.13.0");
  assert.equal(nextVersion("0.13.0", "patch", 0), "0.13.1");
  assert.equal(nextVersion("0.9.9", "patch", 0), "0.9.10");
  assert.equal(nextVersion("1.2.0", "patch", 1), "1.2.1");
});

test("x stays fixed", () => {
  assert.throws(() => nextVersion("1.2.0", "minor", 0), /fixed x 0/);
});

test("versions are x.y.z", () => {
  assert.deepEqual(parseVersion("0.13.0"), [0, 13, 0]);
  assert.throws(() => parseVersion("0.13"));
  assert.throws(() => parseVersion("0.13.0-beta.1"));
});

test("the last tag is the highest version, not the last in the list", () => {
  const tags = ["daemon-v0.9.0", "daemon-v0.10.2", "daemon-v0.10.10", "plugin-sdk-v1.2.0", "daemon-vx", "daemon-v0.11.0-rc.1"];
  assert.equal(latestTag(tags, "daemon-v"), "daemon-v0.10.10");
  assert.equal(latestTag(tags, "plugin-sdk-v"), "plugin-sdk-v1.2.0");
  assert.equal(latestTag(tags, "none-v"), undefined);
});

test("the plugin API's version is read from the source", () => {
  assert.equal(pluginApi('export const PLUGIN_API = "1.2";'), "1.2");
  assert.equal(pluginApi("nothing here"), undefined);
});

test("a change of a package from the registry in the lockfile counts; the workspace's own versions do not", () => {
  const lock = (sdk: string, ws: string) =>
    JSON.stringify({
      packages: {
        "": { name: "gasho" },
        "packages/plugin-sdk": { version: sdk },
        "node_modules/@4rtoflow/gasho-plugin-sdk": { resolved: "packages/plugin-sdk", link: true },
        "node_modules/ws": { version: ws },
      },
    });
  assert.equal(registryPackages(lock("1.8.0", "8.18.0")), registryPackages(lock("1.8.1", "8.18.0")));
  assert.notEqual(registryPackages(lock("1.8.0", "8.18.0")), registryPackages(lock("1.8.0", "8.18.3")));
  assert.equal(registryPackages("not json"), undefined);
});

test("the tag prefixes do not overlap, so that publish finds each tag's package", () => {
  for (const a of PACKAGES) {
    for (const b of PACKAGES) if (a !== b) assert.ok(!a.tagPrefix.startsWith(b.tagPrefix), `${a.tagPrefix} / ${b.tagPrefix}`);
  }
});
