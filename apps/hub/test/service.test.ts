// Keeping the Gasho server running (service.ts). `service install` on macOS is run against a fake launchctl that behaves
// as the one in #87: bootout returns while the old agent is still registered, and bootstrap fails with 5 (Input/output
// error) until launchd has let it go.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  activateCommands,
  envFileOf,
  LAUNCHD_BOOTSTRAP_RETRIES,
  launchdPlist,
  loadEnvFile,
  portInUse,
  runAsService,
  serviceFile,
  servicePath,
  systemdUnit,
} from "../src/service.ts";

const FAKE_LAUNCHCTL = `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/calls"
left=$(cat "$dir/left" 2>/dev/null || echo 0)
fails=$(cat "$dir/fails" 2>/dev/null || echo 0)
case "$1" in
  bootout) exit 0 ;;
  print)
    if [ "$left" -gt 0 ]; then echo $((left - 1)) > "$dir/left"; exit 0; fi
    echo "Could not find service" >&2; exit 113 ;;
  bootstrap)
    if [ "$left" -gt 0 ] || [ "$fails" -gt 0 ]; then
      [ "$fails" -gt 0 ] && echo $((fails - 1)) > "$dir/fails"
      echo "Bootstrap failed: 5: Input/output error" >&2; exit 5
    fi
    exit 0 ;;
esac
`;

/**
 * Runs the commands as `service install` does (apps/hub/src/cli.ts), with the fake launchctl first on PATH. `left`:
 * how many more `launchctl print` find the old agent; `fails`: how many bootstraps fail anyway.
 */
function install(o: { left: number; fails: number }): { calls: string[]; error?: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-hub-launchd-"));
  try {
    fs.writeFileSync(path.join(dir, "launchctl"), FAKE_LAUNCHCTL, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "left"), String(o.left));
    fs.writeFileSync(path.join(dir, "fails"), String(o.fails));
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
    let error: string | undefined;
    for (const step of activateCommands("darwin", "/Users/u/Library/LaunchAgents/local.gasho.hub.plist", 501, true)) {
      try {
        execFileSync(step.argv[0] ?? "", step.argv.slice(1), { stdio: step.mayFail ? "ignore" : "pipe", env });
      } catch (e) {
        if (!step.mayFail) {
          error = String((e as { stderr?: unknown }).stderr ?? e);
          break;
        }
      }
    }
    const calls = fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n");
    return { calls, ...(error === undefined ? {} : { error }) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BOOTSTRAP = "bootstrap gui/501 /Users/u/Library/LaunchAgents/local.gasho.hub.plist";
const PRINT = "print gui/501/local.gasho.hub";

test("bootstrap waits until launchd has let the old agent go after bootout (#87)", () => {
  const { calls, error } = install({ left: 3, fails: 0 });
  assert.equal(error, undefined);
  assert.deepEqual(calls, ["bootout gui/501/local.gasho.hub", PRINT, PRINT, PRINT, PRINT, BOOTSTRAP]);
});

test("an agent that was not loaded is bootstrapped at once", () => {
  const { calls, error } = install({ left: 0, fails: 0 });
  assert.equal(error, undefined);
  assert.deepEqual(calls, ["bootout gui/501/local.gasho.hub", PRINT, BOOTSTRAP]);
});

test("a bootstrap that fails anyway is tried again a second later", () => {
  const { calls, error } = install({ left: 0, fails: 2 });
  assert.equal(error, undefined);
  assert.deepEqual(calls.slice(2), [BOOTSTRAP, BOOTSTRAP, BOOTSTRAP]);
});

test("bootstrap gives up after its tries, with launchctl's error of the last one", () => {
  const { calls, error } = install({ left: 0, fails: 100 });
  assert.equal(calls.filter((c) => c === BOOTSTRAP).length, LAUNCHD_BOOTSTRAP_RETRIES + 1);
  assert.equal(error?.trim(), "Bootstrap failed: 5: Input/output error");
});

test("without start (another Gasho server holds the port), launchd is left alone", () => {
  assert.deepEqual(activateCommands("darwin", "/Users/u/Library/LaunchAgents/local.gasho.hub.plist", 501, false), []);
});

test("on Linux, systemd reads the unit again and enables it, and restarts the Gasho server only with start", () => {
  const steps = (start: boolean) => activateCommands("linux", "/home/u/.config/systemd/user/gasho-hub.service", 1000, start).map((s) => s.argv.join(" "));
  assert.deepEqual(steps(true), ["systemctl --user daemon-reload", "systemctl --user enable gasho-hub", "systemctl --user restart gasho-hub"]);
  assert.deepEqual(steps(false), ["systemctl --user daemon-reload", "systemctl --user enable gasho-hub"]);
});

const repo = "/home/u/repos/Gasho 100%";
const input = {
  node: "/opt/node 24/bin/node",
  argv: ["/opt/node 24/bin/node", "--disable-warning=ExperimentalWarning", `${repo}/apps/hub/src/cli.ts`],
  cwd: repo,
  path: "/opt/node 24/bin:/usr/bin",
  home: "/home/u",
};

test("the systemd unit quotes its command and escapes %, and systemd never gives up starting it", () => {
  const unit = systemdUnit({ ...input, argv: [...input.argv, 'say "hi" \\ back'] });
  assert.match(unit, /^WorkingDirectory=\/home\/u\/repos\/Gasho 100%%$/m);
  assert.match(
    unit,
    /^ExecStart="\/opt\/node 24\/bin\/node" "--disable-warning=ExperimentalWarning" "\/home\/u\/repos\/Gasho 100%%\/apps\/hub\/src\/cli\.ts" "say \\"hi\\" \\\\ back" start$/m,
  );
  assert.match(unit, /^Environment="PATH=\/opt\/node 24\/bin:\/usr\/bin"$/m);
  assert.match(unit, /^StartLimitIntervalSec=0$/m);
  assert.match(unit, /^Restart=on-failure$/m);
});

test("the launchd agent runs the Gasho server with start, its paths escaped for XML, and logs in ~/Library/Logs", () => {
  const mac = `/Users/u/Gasho & <co>'s "hub"`;
  const plist = launchdPlist({ ...input, argv: [input.node, `${mac}/launcher.js`], cwd: mac, home: "/Users/u" });
  assert.match(plist, /<string>local\.gasho\.hub<\/string>/);
  assert.ok(plist.includes("<string>/Users/u/Gasho &amp; &lt;co&gt;'s &quot;hub&quot;/launcher.js</string>\n    <string>start</string>"));
  assert.ok(plist.includes("<key>WorkingDirectory</key>\n  <string>/Users/u/Gasho &amp; &lt;co&gt;'s &quot;hub&quot;</string>"));
  assert.ok(!plist.includes("& <co>"));
  assert.ok(plist.includes("<key>PATH</key>\n    <string>/opt/node 24/bin:/usr/bin</string>"));
  assert.ok(plist.includes("<string>/Users/u/Library/Logs/gasho-hub.log</string>"));
});

test("the service's PATH has Node.js's folder first and the shell's after, without the folders npm adds while it runs", () => {
  const shell = ["/home/u/.npm/_npx/24d82d1acaca0cc6/node_modules/.bin", "/home/u/Gasho/node_modules/.bin", "/opt/node/bin", "/usr/bin", "/usr/bin"].join(":");
  assert.equal(servicePath("/opt/node/bin/node", shell), "/opt/node/bin:/usr/bin");
  assert.equal(servicePath("/usr/bin/node", undefined), "/usr/bin");
});

test("the service's file goes where systemd or launchd reads it, and nowhere on other systems", () => {
  assert.equal(serviceFile("linux", "/home/u", {}), "/home/u/.config/systemd/user/gasho-hub.service");
  assert.equal(serviceFile("linux", "/home/u", { XDG_CONFIG_HOME: "/cfg" }), "/cfg/systemd/user/gasho-hub.service");
  assert.equal(serviceFile("darwin", "/Users/u", {}), "/Users/u/Library/LaunchAgents/local.gasho.hub.plist");
  assert.equal(serviceFile("win32", "C:\\Users\\u", {}), undefined);
});

test("the Gasho server counts as run by a service only when the launcher started it under systemd or launchd", () => {
  assert.equal(runAsService({ GASHO_HUB_LAUNCHER: "1", INVOCATION_ID: "x" }, "linux"), true);
  assert.equal(runAsService({ INVOCATION_ID: "x" }, "linux"), false);
  assert.equal(runAsService({ GASHO_HUB_LAUNCHER: "1" }, "linux"), false);
  assert.equal(runAsService({ GASHO_HUB_LAUNCHER: "1", XPC_SERVICE_NAME: "local.gasho.hub" }, "darwin"), true);
  assert.equal(runAsService({ GASHO_HUB_LAUNCHER: "1", INVOCATION_ID: "x" }, "darwin"), false);
});

test("hub.env is read into the environment, a value set in the shell wins, and only a file that is there but unreadable is reported", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-hub-env-"));
  const file = path.join(dir, "hub.env");
  fs.writeFileSync(file, "GASHO_TEST_FROM_FILE=file\nGASHO_TEST_SET=file\n");
  const said: string[] = [];
  process.env.GASHO_TEST_SET = "shell";
  try {
    loadEnvFile({ GASHO_HUB_ENV: file }, (s) => said.push(s));
    assert.equal(process.env.GASHO_TEST_FROM_FILE, "file");
    assert.equal(process.env.GASHO_TEST_SET, "shell");
    loadEnvFile({ GASHO_HUB_ENV: path.join(dir, "none.env") }, (s) => said.push(s));
    assert.equal(said.length, 0);
    loadEnvFile({ GASHO_HUB_ENV: dir }, (s) => said.push(s));
    assert.equal(said.length, 1);
    assert.ok(said[0]?.startsWith(`could not read ${dir}: `), said[0]);
  } finally {
    delete process.env.GASHO_TEST_FROM_FILE;
    delete process.env.GASHO_TEST_SET;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(envFileOf({ GASHO_HUB_ENV: "off" }), undefined);
  assert.equal(envFileOf({ XDG_CONFIG_HOME: "/cfg" }), "/cfg/gasho/hub.env");
});

test("a port counts as in use while something listens on it", async () => {
  const server = net.createServer().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as net.AddressInfo;
  assert.equal(await portInUse("127.0.0.1", port), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await portInUse("127.0.0.1", port), false);
});
