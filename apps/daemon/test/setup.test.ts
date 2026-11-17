import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { saveCredentials } from "../src/credentials.ts";
import { hookUrl, installHooks } from "../src/hooks.ts";
import { commandOf, installOf, layoutOf, serviceCommand } from "../src/install.ts";
import {
  activateCommands,
  atLeast,
  type Check,
  doctor,
  formatChecks,
  launchdPlist,
  serviceFile,
  servicePath,
  systemdUnit,
  versionOf,
} from "../src/setup.ts";

test("versions are read from what the tools print, and compared", () => {
  assert.deepEqual(versionOf("v24.22.2"), [24, 22, 2]);
  assert.deepEqual(versionOf("zellij 0.45.1"), [0, 45, 1]);
  assert.deepEqual(versionOf("2.1.323 (Claude Code)"), [2, 1, 323]);
  assert.equal(versionOf("no version"), undefined);
  assert.ok(atLeast([0, 45, 1], [0, 45]));
  assert.ok(!atLeast([0, 44, 9], [0, 45]));
  assert.ok(atLeast([25, 0, 0], [24]));
});

test("the service gets Node.js's folder first, then the shell's PATH, each once", () => {
  assert.equal(servicePath("/opt/node/bin/node", "/usr/bin:/opt/node/bin:/home/u/.local/bin"), "/opt/node/bin:/usr/bin:/home/u/.local/bin");
  assert.equal(servicePath("/usr/bin/node", undefined), "/usr/bin");
});

test("the folders npm puts on PATH while npx runs are left out of the service's PATH", () => {
  const npxPath = [
    "/home/u/.npm/_npx/24d82d1acaca0cc6/node_modules/.bin",
    "/home/u/node_modules/.bin",
    "/home/node_modules/.bin",
    "/node_modules/.bin",
    "/opt/node/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin",
    "/opt/node/bin",
    "/home/u/.local/bin",
    "/usr/bin",
  ].join(":");
  assert.equal(servicePath("/opt/node/bin/node", npxPath), "/opt/node/bin:/home/u/.local/bin:/usr/bin");
});

const repo = "/home/u/repos/Gasho 100%";
const input = {
  node: "/opt/node 24/bin/node",
  argv: ["/opt/node 24/bin/node", `${repo}/apps/daemon/src/cli.ts`],
  cwd: repo,
  path: "/opt/node 24/bin:/usr/bin",
  home: "/home/u",
};

test("the systemd unit quotes its command and escapes % (WorkingDirectory takes no quotes)", () => {
  const unit = systemdUnit(input);
  assert.match(unit, /^WorkingDirectory=\/home\/u\/repos\/Gasho 100%%$/m);
  assert.match(unit, /^ExecStart="\/opt\/node 24\/bin\/node" "\/home\/u\/repos\/Gasho 100%%\/apps\/daemon\/src\/cli\.ts" run$/m);
  assert.match(unit, /^Environment="PATH=\/opt\/node 24\/bin:\/usr\/bin"$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test("the launchd agent runs Node.js on the daemon directly, with its paths escaped for XML", () => {
  const mac = "/Users/u/Gasho & <co>'s";
  const plist = launchdPlist({ ...input, argv: [input.node, `${mac}/apps/daemon/src/cli.ts`], cwd: mac, home: "/Users/u" });
  assert.match(plist, /<string>local\.gasho\.daemon<\/string>/);
  assert.ok(plist.includes("<string>/opt/node 24/bin/node</string>"));
  assert.ok(plist.includes("<string>/Users/u/Gasho &amp; &lt;co&gt;'s/apps/daemon/src/cli.ts</string>"));
  assert.ok(!plist.includes("& <co>"));
  assert.ok(plist.includes("<string>/Users/u/Library/Logs/gasho-daemon.log</string>"));
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
});

test("the checks are listed with their marks, the names lined up, and a summary", () => {
  const text = formatChecks(
    [
      { level: "ok", name: "Node.js", detail: "24.22.2" },
      { level: "warn", name: "GitHub CLI", detail: "ログインしていません", hint: "gh auth login" },
      { level: "fail", name: "登録", detail: "ありません", hint: "register" },
    ],
    "0.9.0",
  );
  const lines = text.split("\n");
  assert.equal(lines[0], "gasho-daemon 0.9.0 のセットアップの確認");
  assert.equal(lines[2], "✓ Node.js     24.22.2");
  assert.equal(lines[3], "! GitHub CLI  ログインしていません");
  assert.equal(lines[4], "    → gh auth login");
  assert.equal(lines[5], "✗ 登録        ありません");
  assert.match(text, /✗ が 1 件あります/);
});

test("how gasho-daemon was installed decides the command to suggest and what its service runs", () => {
  const node = "/opt/node/bin/node";
  const layout = layoutOf({ GASHO_DAEMON_HOME: "/home/u/.local/share/gasho/daemon" });
  const repo = installOf("/home/u/repos/Gasho/apps/daemon/src/cli.ts");
  assert.deepEqual(repo, { kind: "repo", repo: "/home/u/repos/Gasho" });
  assert.equal(commandOf(repo), "node apps/daemon/src/cli.ts");
  assert.deepEqual(serviceCommand(repo, node, "1.2.3", "/home/u", layout), {
    argv: [node, "/home/u/repos/Gasho/apps/daemon/src/cli.ts"],
    cwd: "/home/u/repos/Gasho",
  });

  // npx keeps the package in a cache npm may clear: the service runs npx again, for the same version.
  const npx = installOf("/home/u/.npm/_npx/0123abcd/node_modules/@4rtofl/gasho-daemon/lib/cli.js");
  assert.equal(commandOf(npx), "npx @4rtofl/gasho-daemon");
  assert.deepEqual(serviceCommand(npx, node, "1.2.3", "/home/u", layout), {
    argv: ["/opt/node/bin/npx", "--yes", "--prefer-offline", "@4rtofl/gasho-daemon@1.2.3"],
    cwd: "/home/u",
  });

  const global = installOf("/opt/node/lib/node_modules/@4rtofl/gasho-daemon/lib/cli.js");
  assert.equal(commandOf(global), "gasho-daemon");
  assert.deepEqual(serviceCommand(global, node, "1.2.3", "/home/u", layout).argv, [node, "/opt/node/lib/node_modules/@4rtofl/gasho-daemon/lib/cli.js"]);

  // Installed by `service install`: Node.js runs it through its real path, in its own folder of versions; the service
  // runs the version that `current` links to, so that an update changes the link alone.
  const managed = installOf("/home/u/.local/share/gasho/daemon/versions/0.15.2/node_modules/@4rtofl/gasho-daemon/lib/cli.js", [layout.versions]);
  assert.deepEqual(managed, { kind: "managed", version: "0.15.2" });
  assert.equal(commandOf(managed), "npx @4rtofl/gasho-daemon");
  assert.deepEqual(serviceCommand(managed, node, "0.15.2", "/home/u", layout), {
    argv: [node, "/home/u/.local/share/gasho/daemon/current/node_modules/@4rtofl/gasho-daemon/lib/cli.js"],
    cwd: "/home/u",
  });
  // Not a folder of a version: an ordinary package.
  assert.equal(installOf("/home/u/.local/share/gasho/daemon/versions/.0.15.2-1-x/node_modules/@4rtofl/gasho-daemon/lib/cli.js", [layout.versions]).kind, "package");
});

test("service install writes the unit where systemd or launchd reads it, and restarts the daemon with it", () => {
  assert.equal(serviceFile("linux", "/home/u", {}), "/home/u/.config/systemd/user/gasho-daemon.service");
  assert.equal(serviceFile("linux", "/home/u", { XDG_CONFIG_HOME: "/cfg" }), "/cfg/systemd/user/gasho-daemon.service");
  assert.equal(serviceFile("darwin", "/Users/u", {}), "/Users/u/Library/LaunchAgents/local.gasho.daemon.plist");
  assert.equal(serviceFile("win32", "C:/u", {}), undefined);
  assert.deepEqual(
    activateCommands("linux", "/x", 1000).map((c) => c.argv.join(" ")),
    ["systemctl --user daemon-reload", "systemctl --user enable gasho-daemon", "systemctl --user restart gasho-daemon"],
  );
  // launchd: bootout, wait until the agent is gone, bootstrap (tried again on failure); run in launchd.test.ts.
  const darwin = activateCommands("darwin", "/Users/u/Library/LaunchAgents/local.gasho.daemon.plist", 501);
  assert.deepEqual(darwin[0], { argv: ["launchctl", "bootout", "gui/501/local.gasho.daemon"], mayFail: true });
  assert.deepEqual(darwin[1]?.argv.slice(-1), ["gui/501/local.gasho.daemon"]);
  assert.equal(darwin[1]?.mayFail, true);
  assert.deepEqual(darwin[2]?.argv.slice(-2), ["gui/501", "/Users/u/Library/LaunchAgents/local.gasho.daemon.plist"]);
  assert.equal(darwin[2]?.mayFail, undefined);
});

// doctor, with stand-ins for claude and gh, a registration pointing at a local server, and a settings file of its own.

function doctorFolder(o: { ghLoggedIn: boolean }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-doctor-"));
  const claude = path.join(dir, "claude");
  fs.writeFileSync(claude, '#!/bin/sh\necho "2.1.326 (Claude Code)"\n', { mode: 0o755 });
  const gh = path.join(dir, "gh");
  const auth = o.ghLoggedIn ? 'echo "  ✓ Logged in to github.com account someone"' : 'echo "You are not logged into any GitHub hosts." >&2; exit 1';
  fs.writeFileSync(gh, `#!/bin/sh\ncase "$1" in\n  --version) echo "gh version 2.80.0 (2025-10-01)" ;;\n  auth) ${auth} ;;\nesac\n`, { mode: 0o755 });
  return { dir, claude, gh, settings: path.join(dir, "settings.json"), creds: path.join(dir, "daemon.json") };
}

async function listen(answer: number): Promise<{ port: number; close: () => void }> {
  const server = http.createServer((_req, res) => res.writeHead(answer).end());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, close: () => server.close() };
}

async function runDoctor(o: Parameters<typeof doctor>[0], creds: string): Promise<Map<string, Check>> {
  const before = process.env.GASHO_DAEMON_CONFIG;
  process.env.GASHO_DAEMON_CONFIG = creds;
  try {
    return new Map((await doctor(o)).map((c) => [c.name, c]));
  } finally {
    if (before === undefined) delete process.env.GASHO_DAEMON_CONFIG;
    else process.env.GASHO_DAEMON_CONFIG = before;
  }
}

test("doctor finds all that gasho-daemon needs: registered, the Gasho server answering, claude, gh logged in, the hooks, the daemon running", async () => {
  const f = doctorFolder({ ghLoggedIn: true });
  const hub = await listen(200);
  const daemon = await listen(404);
  try {
    await saveCredentials(f.creds, { server: `http://127.0.0.1:${hub.port}`, machineId: "m1", token: "t", name: "ubuntu" });
    await installHooks(f.settings, daemon.port);
    const checks = await runDoctor({ claudeBin: f.claude, ghBin: f.gh, hookPort: daemon.port, settingsFile: f.settings }, f.creds);
    assert.deepEqual(checks.get("登録"), { level: "ok", name: "登録", detail: `「ubuntu」として http://127.0.0.1:${hub.port} に登録済み` });
    assert.equal(checks.get("Gasho サーバー")?.level, "ok");
    assert.deepEqual(checks.get("Claude Code"), { level: "ok", name: "Claude Code", detail: "2.1.326 (Claude Code)" });
    assert.deepEqual(checks.get("GitHub CLI"), { level: "ok", name: "GitHub CLI", detail: "2.80.0、ログイン済み" });
    assert.equal(checks.get("hooks")?.level, "ok");
    assert.deepEqual(checks.get("daemon"), { level: "ok", name: "daemon", detail: `動いています（127.0.0.1:${daemon.port}）` });
  } finally {
    hub.close();
    daemon.close();
  }
});

test("doctor says what is missing and how to get it, with the command for gasho-daemon as installed", async () => {
  const f = doctorFolder({ ghLoggedIn: true });
  const free = await listen(200);
  free.close();
  const checks = await runDoctor(
    { claudeBin: path.join(f.dir, "no-claude"), ghBin: path.join(f.dir, "no-gh"), hookPort: free.port, settingsFile: f.settings, command: "npx @4rtofl/gasho-daemon" },
    f.creds,
  );
  const registration = checks.get("登録");
  assert.equal(registration?.level, "fail");
  assert.equal(registration?.detail, `${f.creds} がありません`);
  assert.match(registration?.hint ?? "", /^Gasho サーバーで登録コードを出し、npx @4rtofl\/gasho-daemon register --server /);
  assert.equal(checks.has("Gasho サーバー"), false);
  assert.equal(checks.get("Claude Code")?.level, "fail");
  assert.equal(checks.get("GitHub CLI")?.detail, "ありません");
  assert.equal(checks.get("hooks")?.detail, "入っていません");
  assert.equal(checks.get("daemon")?.level, "warn");
  assert.match(checks.get("daemon")?.hint ?? "", /npx @4rtofl\/gasho-daemon service install/);
});

test("doctor tells a Gasho server that refuses this machine from one it cannot reach, gh logged out, and hooks without PermissionRequest", async () => {
  const f = doctorFolder({ ghLoggedIn: false });
  const refusing = await listen(403);
  try {
    await saveCredentials(f.creds, { server: `http://127.0.0.1:${refusing.port}`, machineId: "m1", token: "t", name: "" });
    const url = hookUrl(refusing.port);
    fs.writeFileSync(f.settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "http", url }] }] } }));
    const checks = await runDoctor({ claudeBin: f.claude, ghBin: f.gh, hookPort: refusing.port, settingsFile: f.settings }, f.creds);
    assert.equal(checks.get("登録")?.detail, `「${os.hostname()}」として http://127.0.0.1:${refusing.port} に登録済み`);
    assert.equal(checks.get("Gasho サーバー")?.detail, "このマシンからの接続が許可されていません");
    assert.match(checks.get("Gasho サーバー")?.hint ?? "", /GASHO_ALLOW_NETS/);
    assert.deepEqual([checks.get("GitHub CLI")?.level, checks.get("GitHub CLI")?.detail], ["warn", "ログインしていません"]);
    assert.equal(checks.get("hooks")?.detail, "PermissionRequest が入っていません");
  } finally {
    refusing.close();
  }

  const gone = await listen(200);
  gone.close();
  await saveCredentials(f.creds, { server: `http://127.0.0.1:${gone.port}`, machineId: "m1", token: "t", name: "ubuntu" });
  const unreachable = await runDoctor({ claudeBin: f.claude, ghBin: f.gh, hookPort: gone.port, settingsFile: f.settings }, f.creds);
  assert.deepEqual([unreachable.get("Gasho サーバー")?.level, unreachable.get("Gasho サーバー")?.detail], ["fail", `http://127.0.0.1:${gone.port} につながりません`]);
});
