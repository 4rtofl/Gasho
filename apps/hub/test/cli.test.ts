// The Gasho server's command line, run as the service and a shell run it: a process of its own, with every folder it
// uses in a temporary one (hub.env is not read).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { Store } from "../src/store.ts";
import { HUB_VERSION } from "../src/version.ts";

const CLI = path.resolve(import.meta.dirname, "../src/cli.ts");
const REPO = path.resolve(import.meta.dirname, "../../..");
const NODE_FLAGS = ["--disable-warning=ExperimentalWarning"];

/** The folders made by the helpers below, removed once this file's tests are done. */
const temps: string[] = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-hub-cli-"));
  temps.push(dir);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GASHO_HUB_ENV: "off",
    GASHO_HUB_HOME: path.join(dir, "layout"),
    GASHO_DB: path.join(dir, "hub.db"),
    GASHO_PLUGINS_DIR: path.join(dir, "plugins"),
    GASHO_PLUGIN_CACHE: path.join(dir, "plugin-cache"),
    GASHO_WEB_DIST: path.join(dir, "web"),
    GASHO_GH_BIN: path.join(dir, "no-gh"),
    GASHO_LATEST_CHECK: "off",
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [...NODE_FLAGS, CLI, ...args], { env, encoding: "utf8" });
  return { dir, env, run };
}

function writePlugin(folder: string, id: string): string {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "gasho-plugin.json"), JSON.stringify({ id, name: `Plugin ${id}`, version: "1.0.0", api: "1.2", web: { js: "web.js" } }));
  fs.writeFileSync(path.join(folder, "web.js"), "export default {}");
  return folder;
}

test("plugin add copies a built plugin in (or links it), list says which, and remove forgets what the server kept for it", () => {
  const { dir, env, run } = setup();
  const plugins = env.GASHO_PLUGINS_DIR ?? "";

  const copied = writePlugin(path.join(dir, "src", "hello"), "hello");
  const added = run("plugin", "add", copied);
  assert.equal(added.status, 0, added.stderr);
  assert.match(added.stdout, /^installed Plugin hello 1\.0\.0 \(hello\) in /);
  assert.equal(fs.lstatSync(path.join(plugins, "hello")).isSymbolicLink(), false);
  // The copy was made aside and swapped in: nothing half-copied is left beside it.
  assert.deepEqual(fs.readdirSync(plugins), ["hello"]);

  const linkedFrom = writePlugin(path.join(dir, "src", "dev"), "dev");
  const linked = run("plugin", "add", "--link", linkedFrom);
  assert.equal(linked.status, 0, linked.stderr);
  assert.equal(fs.realpathSync(path.join(plugins, "dev")), fs.realpathSync(linkedFrom));

  const gone = writePlugin(path.join(dir, "src", "gone"), "gone");
  assert.equal(run("plugin", "add", "--link", gone).status, 0);
  fs.rmSync(gone, { recursive: true });

  const list = run("plugin", "list").stdout.split("\n").filter(Boolean);
  assert.equal(list.length, 3);
  assert.match(list[0] ?? "", /^dev +Plugin dev 1\.0\.0 \(\w+\) {2}\[link -> .+\/src\/dev\]$/);
  assert.match(list[1] ?? "", /^gone +error: the link points nowhere {2}\[link -> \?\]$/);
  assert.match(list[2] ?? "", /^hello +Plugin hello 1\.0\.0 \(\w+\)$/);

  const store = new Store(env.GASHO_DB ?? "");
  store.setPluginSetting("hello", "interval", 30);
  store.close();
  const removed = run("plugin", "remove", "hello");
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(removed.stdout.trim(), "removed hello");
  assert.equal(fs.existsSync(path.join(plugins, "hello")), false);
  const reopened = new Store(env.GASHO_DB ?? "");
  assert.deepEqual(reopened.pluginSettings("hello"), {});
  reopened.close();
});

test("plugin add and remove refuse what is not a plugin, a path for an id, and an id not installed", () => {
  const { dir, run } = setup();
  const empty = path.join(dir, "empty");
  fs.mkdirSync(empty);
  const notPlugin = run("plugin", "add", empty);
  assert.equal(notPlugin.status, 1);
  assert.ok(notPlugin.stderr.startsWith(`${empty}: `), notPlugin.stderr);

  for (const id of ["../hub.db", ".hidden"]) {
    const r = run("plugin", "remove", id);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^usage:/);
  }
  assert.equal(fs.existsSync(path.join(dir, "hub.db")), false);

  const missing = run("plugin", "remove", "nothing");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /^no plugin nothing in /);
});

test("pair issues a code the Gasho server takes once; devices lists the registrations, and revoke takes one off", () => {
  const { env, run } = setup();
  const paired = run("pair");
  assert.equal(paired.status, 0, paired.stderr);
  const code = /^registration code: (\S+)$/m.exec(paired.stdout)?.[1];
  assert.ok(code, paired.stdout);

  const store = new Store(env.GASHO_DB ?? "");
  assert.equal(store.consumePairingCode(code), true);
  assert.equal(store.consumePairingCode(code), false);
  const { device } = store.createDevice("machine", "ubuntu");
  store.close();

  assert.match(run("devices").stdout, new RegExp(`^${device.id} {2}machine {2}ubuntu {2}\\(last seen: never\\)$`, "m"));
  assert.equal(run("revoke", device.id).stdout.trim(), `revoked ${device.id}`);
  assert.equal(run("revoke", device.id).stdout.trim(), `no active device ${device.id}`);
  assert.equal(run("devices").stdout, "");
  assert.equal(run("revoke").status, 2);
});

test("version prints the version alone (an update compares it), and an unknown command the usage", () => {
  const { run } = setup();
  const version = run("version");
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, `${HUB_VERSION}\n`);
  const unknown = run("sart");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /^usage:/);
});

test("service print, from a clone: the service runs the clone's cli.ts with start, and npm's folders are left off its PATH", { skip: !["linux", "darwin"].includes(process.platform) }, () => {
  const { env } = setup();
  const r = spawnSync(process.execPath, [...NODE_FLAGS, CLI, "service", "print"], {
    env: { ...env, PATH: `${REPO}/node_modules/.bin:/usr/bin:/bin` },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  const mac = process.platform === "darwin";
  if (mac) {
    assert.ok(r.stdout.includes(`<string>${CLI}</string>\n    <string>start</string>`), r.stdout);
    assert.ok(r.stdout.includes(`<key>WorkingDirectory</key>\n  <string>${REPO}</string>`), r.stdout);
  } else {
    assert.ok(r.stdout.split("\n").some((l) => l.startsWith("ExecStart=") && l.endsWith(` "${CLI}" start`)), r.stdout);
    assert.ok(r.stdout.includes(`\nWorkingDirectory=${REPO}\n`), r.stdout);
  }
  const servicePath = (mac ? /<key>PATH<\/key>\s*<string>([^<]*)</ : /^Environment="PATH=([^"]*)"$/m).exec(r.stdout)?.[1] ?? "";
  assert.ok(servicePath.endsWith("/usr/bin:/bin"), servicePath);
  assert.ok(!servicePath.includes("node_modules/.bin"), servicePath);
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

/** Starts the Gasho server; resolves once it says that it listens, or it ended. */
function start(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [...NODE_FLAGS, CLI, "start"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr.setEncoding("utf8").on("data", (d: string) => (out += d));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const listening = new Promise<void>((resolve, reject) => {
    child.stdout.on("data", () => /listening on /.test(out) && resolve());
    void exited.then((code) => reject(new Error(`gasho-hub ended (${code}):\n${out}`)));
    // A server that runs on without saying so would leave the test waiting, and the server running, for good.
    setTimeout(() => reject(new Error(`gasho-hub did not start:\n${out}`)), 60_000).unref();
  });
  // Not awaited by a test that expects it to end.
  listening.catch(() => undefined);
  return { child, exited, listening, output: () => out };
}

test("start serves on its port until SIGTERM, which ends it with 0", async () => {
  const { env } = setup();
  const port = await freePort();
  const hub = start({ ...env, GASHO_HUB_HOST: "127.0.0.1", GASHO_HUB_PORT: String(port) });
  try {
    await hub.listening;
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.deepEqual(await res.json(), { ok: true, version: HUB_VERSION });
    assert.match(hub.output(), /no devices are registered yet/);
  } finally {
    hub.child.kill("SIGTERM");
  }
  assert.equal(await hub.exited, 0);
});

test("start, while another Gasho server holds the port, ends with 1 before it opens the database", async () => {
  const { env } = setup();
  const holder = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => holder.once("listening", resolve));
  try {
    const { port } = holder.address() as net.AddressInfo;
    const hub = start({ ...env, GASHO_HUB_HOST: "127.0.0.1", GASHO_HUB_PORT: String(port) });
    assert.equal(await hub.exited, 1);
    assert.match(hub.output(), new RegExp(`port ${port} on 127\\.0\\.0\\.1 is in use`));
    assert.equal(fs.existsSync(env.GASHO_DB ?? ""), false);
  } finally {
    holder.close();
  }
});
