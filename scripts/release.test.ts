import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { after, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { latestTag, namedAs, nextVersion, PACKAGES, parseVersion, type Plan, pluginApi, registryPackages } from "./release.ts";

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
        "node_modules/@4rtofl/gasho-plugin-sdk": { resolved: "packages/plugin-sdk", link: true },
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

test("each package's name is in its name file, and a tag from before a rename is told apart", () => {
  const root = path.resolve(import.meta.dirname, "..");
  for (const pkg of PACKAGES) assert.ok(namedAs(fs.readFileSync(path.join(root, pkg.nameFile), "utf8"), pkg.name), pkg.nameFile);
  assert.ok(namedAs('export const PACKAGE_NAME = "@4rtofl/gasho-daemon";', "@4rtofl/gasho-daemon"));
  assert.ok(!namedAs('export const PACKAGE_NAME = "@old-owner/gasho-daemon";', "@4rtofl/gasho-daemon"));
  assert.ok(!namedAs("", "@4rtofl/gasho-daemon"));
});

// plan and apply, run in a repository of their own: the files the release reads, release.ts itself, and stand-ins for
// gh (the pull requests of a commit, written in its subject as "pr:<what gh prints>") and npm (the versions published,
// a file each).

const FAKE_GH = `#!/bin/sh
sha=$(echo "$2" | sed 's#.*/commits/\\([0-9a-f]*\\)/pulls#\\1#')
subject=$(git log -1 --format=%s "$sha")
case "$subject" in
  *pr:*) echo "\${subject#*pr:}" ;;
  *) echo "gh: No commit found for SHA: $sha (HTTP 422)" >&2; exit 1 ;;
esac
`;

const FAKE_NPM = `#!/bin/sh
f="$(dirname "$0")/published/$(echo "$2" | tr / _)"
[ -f "$f" ] && exec cat "$f"
echo "npm error code E404" >&2
exit 1
`;

/** The folders made by the helpers below, removed once this file's tests are done. */
const temps: string[] = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function releaseRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gasho-release-")));
  temps.push(dir);
  const bin = path.join(dir, ".bin");
  const repo = path.join(dir, "repo");
  const files: Record<string, string> = {
    "scripts/release.ts": fs.readFileSync(path.join(import.meta.dirname, "release.ts"), "utf8"),
    "packages/plugin-sdk/scripts/tools.ts": fs.readFileSync(path.join(import.meta.dirname, "../packages/plugin-sdk/scripts/tools.ts"), "utf8"),
    "packages/plugin-sdk/scripts/pack.ts": 'const name = "@4rtofl/gasho-plugin-sdk";\n',
    "packages/plugin-sdk/package.json": `${JSON.stringify({ name: "@gasho/plugin-sdk", version: "1.4.0" }, null, 2)}\n`,
    "packages/plugin-sdk/src/exports.js": 'export const PLUGIN_API = "1.4";\n',
    "apps/daemon/src/daemon.ts": 'export const DAEMON_VERSION = "0.5.2";\n',
    "apps/daemon/src/install.ts": 'export const PACKAGE_NAME = "@4rtofl/gasho-daemon";\n',
    "apps/daemon/src/plugins.ts": 'export const PLUGIN_API = "1.4";\n',
    "apps/hub/src/version.ts": 'export const HUB_VERSION = "0.3.0";\n',
    "apps/hub/src/install.ts": 'export const PACKAGE_NAME = "@4rtofl/gasho-hub";\n',
    "apps/web/package.json": JSON.stringify({ dependencies: { react: "^19.0.0" }, devDependencies: { vite: "^8.0.0", "@vitejs/plugin-react": "^6.0.0", "@tailwindcss/vite": "^4.0.0", tailwindcss: "^4.0.0" } }),
    "package-lock.json": `${JSON.stringify({ packages: { "packages/plugin-sdk": { version: "1.4.0" }, "node_modules/react": { version: "19.0.0" } } }, null, 2)}\n`,
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
  }
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "npm"), FAKE_NPM, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  for (const tag of ["daemon-v0.5.2", "hub-v0.3.0", "plugin-sdk-v1.4.0"]) git("tag", tag);
  const change = (file: string, text: string, subject: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), text);
    git("add", "-A");
    git("commit", "-q", "-m", subject);
  };
  const publish = (name: string, versions: string[]) => {
    fs.mkdirSync(path.join(bin, "published"), { recursive: true });
    fs.writeFileSync(path.join(bin, "published", name.replace(/\//g, "_")), JSON.stringify(versions));
  };
  publish("@4rtofl/gasho-daemon", ["0.5.1", "0.5.2"]);
  publish("@4rtofl/gasho-hub", ["0.3.0"]);
  publish("@4rtofl/gasho-plugin-sdk", ["1.4.0"]);
  const step = (name: string, extra: Record<string, string> = {}) => {
    const output = path.join(dir, `output-${name}`);
    fs.rmSync(output, { force: true });
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", path.join(repo, "scripts/release.ts"), name], {
      cwd: repo,
      env: { ...env, GITHUB_OUTPUT: output, ...extra },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const values = Object.fromEntries(
      (fs.existsSync(output) ? fs.readFileSync(output, "utf8") : "")
        .split("\n")
        .filter(Boolean)
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    return { stdout: r.stdout, output: values };
  };
  return { repo, change, publish, step, read: (file: string) => fs.readFileSync(path.join(repo, file), "utf8") };
}

test("plan releases each package changed since its tag: a feature (enhancement or a new plugin API) raises y, a fix z", () => {
  const r = releaseRepo();
  r.change("apps/daemon/src/files.ts", "export {};\n", 'pr:[{"number":12,"labels":["enhancement"]}]');
  r.change("apps/hub/src/server.ts", "export {};\n", 'pr:[{"number":13,"labels":["bug"]},{"number":14,"labels":[]}]');
  r.change("README.md", "Gasho\n", "pr:[]");
  const { output } = r.step("plan");
  const plan = JSON.parse(output.plan ?? "{}") as Plan;
  assert.deepEqual(
    plan.releases.map((x) => [x.id, x.from, x.version, x.bump, x.pulls]),
    [
      ["daemon", "0.5.2", "0.6.0", "minor", [12]],
      ["hub", "0.3.0", "0.3.1", "patch", [13, 14]],
    ],
  );
  assert.equal(plan.releases[0]?.why, "機能の追加。enhancement: #12");
  assert.deepEqual(plan.pending, []);
  assert.deepEqual([output.release, output.daemon, output.hub, output.todo], ["true", "true", "true", "true"]);

  // A new plugin API is a feature of the SDK and of the screen the hub serves.
  r.change("packages/plugin-sdk/src/exports.js", 'export const PLUGIN_API = "1.5";\n', "pr:[]");
  const again = JSON.parse(r.step("plan").output.plan ?? "{}") as Plan;
  assert.deepEqual(
    again.releases.map((x) => [x.id, x.version, x.why]),
    [
      ["daemon", "0.6.0", "機能の追加。enhancement: #12"],
      ["hub", "0.4.0", "機能の追加。PLUGIN_API 1.4 → 1.5"],
      ["sdk", "1.5.0", "機能の追加。PLUGIN_API 1.4 → 1.5"],
    ],
  );

  // apply writes the versions where each package keeps it, the SDK's in the lockfile too.
  r.step("apply", { PLAN: JSON.stringify(again) });
  assert.equal(r.read("apps/daemon/src/daemon.ts"), 'export const DAEMON_VERSION = "0.6.0";\n');
  assert.equal(r.read("apps/hub/src/version.ts"), 'export const HUB_VERSION = "0.4.0";\n');
  assert.equal((JSON.parse(r.read("packages/plugin-sdk/package.json")) as { version: string }).version, "1.5.0");
  assert.equal((JSON.parse(r.read("package-lock.json")) as { packages: Record<string, { version: string }> }).packages["packages/plugin-sdk"]?.version, "1.5.0");
});

test("plan releases nothing without a change, counts a commit not on GitHub as a fix, and publishes a tag that is not yet", () => {
  const r = releaseRepo();
  const none = r.step("plan");
  assert.deepEqual(JSON.parse(none.output.plan ?? "{}").releases, []);
  assert.deepEqual([none.output.release, none.output.todo], ["false", "false"]);

  r.change("apps/daemon/src/files.ts", "export {};\n", "pushed by hand");
  r.publish("@4rtofl/gasho-hub", []);
  const { stdout, output } = r.step("plan");
  const plan = JSON.parse(output.plan ?? "{}") as Plan;
  assert.deepEqual(plan.releases.map((x) => [x.id, x.version, x.bump]), [["daemon", "0.5.3", "patch"]]);
  assert.match(stdout, /::warning::[0-9a-f]{7} is not on GitHub; it counts as a fix/);
  assert.deepEqual(plan.pending, ["hub-v0.3.0"]);
  assert.equal(output.hub, "false");
});
