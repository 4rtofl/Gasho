// Updating gasho-daemon from Gasho, as the Gasho server sees it: what each working server says about it, the update
// command relayed only to one that can take it, and the latest versions looked up on the registry (a fake lookup, and
// npm view run as a fake npm).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import type { HubToClient, HubToDaemon } from "@gasho/protocol";
import { Hub, updateInfoFor, updateInfoOf, validateCommand, versionAfter } from "../src/hub.ts";
import { DAEMON_PACKAGE, HUB_PACKAGE, LatestCheck, npmBin, npmLatest } from "../src/latest.ts";
import { Store } from "../src/store.ts";

function fakePeer<T>(deviceId = "") {
  const peer = {
    deviceId,
    machineId: undefined as string | undefined,
    sent: [] as T[],
    send(m: T) {
      peer.sent.push(m);
    },
    close() {},
  };
  return peer;
}

function setup(latest?: LatestCheck) {
  const store = new Store(":memory:");
  const machine = store.createDevice("machine", "ubuntu");
  const browser = store.createDevice("browser", "iPhone");
  const hub = new Hub(store, { latest });
  const c = fakePeer<HubToClient>(browser.device.id);
  hub.onClientConnect(c);
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId: machine.device.id, token: machine.token, daemonVersion: "0.22.0" });
  return { store, hub, c, d, machineId: machine.device.id };
}

const caps = { type: "capabilities" as const, canLaunch: true, folders: [] };

test("what a gasho-daemon says about updating it reaches browsers, kept to what is expected", () => {
  const { hub, c, d, machineId } = setup();
  hub.onDaemonMessage(d, {
    ...caps,
    update: {
      canUpdate: true,
      installed: ["0.14.0", "latest", "0.13.2"],
      previous: "0.14.0",
      progress: { version: "0.23.0", step: "check", at: 5 },
      failed: { version: "../x", error: "e", at: 1 },
    },
  });
  const m = c.sent.at(-1);
  assert.ok(m?.type === "machine" && m.machine.id === machineId);
  assert.deepEqual(m.machine.update, {
    canUpdate: true,
    reason: undefined,
    command: undefined,
    installed: ["0.14.0", "0.13.2"],
    previous: "0.14.0",
    progress: { version: "0.23.0", step: "check", at: 5 },
    failed: undefined,
  });
  assert.equal(updateInfoOf("yes"), undefined);
  assert.equal(updateInfoOf({ canUpdate: "true" })?.canUpdate, false);
  assert.equal(updateInfoOf({ canUpdate: true, progress: { version: "0.23.0", step: "reboot", at: 5 } })?.progress, undefined);
});

test("the update goes only to a gasho-daemon that can take it, is checked, and is recorded from which version to which", () => {
  const { hub, c, d, machineId } = setup();
  const result = () => {
    const r = c.sent.at(-1);
    assert.ok(r?.type === "command.result");
    return r.result;
  };
  // A gasho-daemon from before updates from Gasho says nothing about them.
  hub.onClientMessage(c, { type: "daemon.update", requestId: "u0", machine: machineId, version: "0.23.0" });
  assert.match(result().error ?? "", /service install/);
  // One that cannot says why.
  hub.onDaemonMessage(d, { ...caps, update: { canUpdate: false, reason: "常駐させずに動かしているので", command: "npx x" } });
  hub.onClientMessage(c, { type: "daemon.update", requestId: "u1", machine: machineId, version: "0.23.0" });
  assert.equal(result().error, "常駐させずに動かしているので");
  assert.equal(d.sent.at(-1)?.type, "welcome");

  hub.onDaemonMessage(d, { ...caps, update: { canUpdate: true } });
  hub.onClientMessage(c, { type: "daemon.update", requestId: "u2", machine: machineId, version: "latest" });
  assert.equal(result().error, "版の指定が正しくありません。");
  assert.equal(validateCommand({ type: "daemon.update", version: "0.23.0; rm -rf ~" }), "版の指定が正しくありません。");

  hub.onClientMessage(c, { type: "daemon.update", requestId: "u3", machine: machineId, version: "0.23.0" });
  const sent = d.sent.at(-1);
  assert.ok(sent?.type === "daemon.update" && sent.version === "0.23.0");
  const event = c.sent.findLast((m) => m.type === "event");
  assert.ok(event?.type === "event");
  assert.equal(event.event.event, "Gasho:daemon.update");
  assert.match(event.event.summary ?? "", /^0\.22\.0 → 0\.23\.0 \(by /);
  hub.onDaemonMessage(d, { type: "command.result", requestId: sent.requestId, result: { ok: true } });
  assert.deepEqual(c.sent.at(-1), { type: "command.result", requestId: "u3", machine: machineId, result: { ok: true } });

  // Its steps come with the capabilities; the restart closes the connection, and the new version's hello ends it.
  hub.onDaemonMessage(d, { ...caps, update: { canUpdate: true, progress: { version: "0.23.0", step: "restart", at: 9 } } });
  hub.onDaemonClose(d);
  const offline = c.sent.at(-1);
  assert.ok(offline?.type === "machine" && !offline.machine.connected && offline.machine.update?.progress?.step === "restart");
});

test("a new connection of the working server clears what the old one said about an update", () => {
  const store = new Store(":memory:");
  const machine = store.createDevice("machine", "ubuntu");
  const hub = new Hub(store);
  const c = fakePeer<HubToClient>("b");
  hub.onClientConnect(c);
  const d = fakePeer<HubToDaemon>();
  const hello = (v: string) => ({ type: "hello" as const, machineId: machine.device.id, token: machine.token, daemonVersion: v });
  hub.onDaemonMessage(d, hello("0.15.0"));
  hub.onDaemonMessage(d, { ...caps, update: { canUpdate: true, progress: { version: "0.16.0", step: "restart", at: 9 } } });
  hub.onDaemonClose(d);
  const next = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(next, hello("0.16.0"));
  const m = c.sent.at(-1);
  assert.ok(m?.type === "machine" && m.machine.daemonVersion === "0.16.0" && m.machine.update === undefined);
});

test("the latest versions are in the snapshot, looked up again when a browser asks, and kept when a look-up fails", async () => {
  const answers: Record<string, (string | Error)[]> = {
    [DAEMON_PACKAGE]: ["0.16.0", new Error("npm error code E401"), "0.16.1"],
    // Not published before its first release; then a look-up that fails on its own.
    [HUB_PACKAGE]: [new Error("npm error code E404\nnpm error 404 Not Found - GET https://npm.pkg.github.com/@4rtofl%2fgasho-hub"), "0.1.0", new Error("npm error code ETIMEDOUT")],
  };
  const asked: string[] = [];
  const latest = new LatestCheck({
    lookup: async (name) => {
      asked.push(name);
      const a = answers[name]?.shift();
      if (a instanceof Error || a === undefined) throw a ?? new Error("no more");
      return a;
    },
  });
  await latest.check();
  const { hub, c } = setup(latest);
  const snap = c.sent[0];
  assert.ok(snap?.type === "snapshot");
  assert.equal(snap.latest?.daemon, "0.16.0");
  assert.equal(snap.latest?.error, undefined);
  assert.equal(snap.latest?.hub, undefined);
  assert.equal(snap.latest?.hubError, "Gasho サーバーの版は、まだ公開されていません。");
  assert.deepEqual(asked, [DAEMON_PACKAGE, HUB_PACKAGE]);

  // Just looked up: a browser's "check now" is answered with what is known.
  hub.onClientMessage(c, { type: "latest.check" });
  await new Promise((r) => setImmediate(r));
  assert.equal(asked.length, 2);
  const known = c.sent.at(-1);
  assert.ok(known?.type === "latest" && known.latest.daemon === "0.16.0");

  // A failed look-up keeps the version known before, and says why; each package on its own.
  await latest.check();
  const failed = latest.latest();
  assert.equal(failed.daemon, "0.16.0");
  assert.match(failed.error ?? "", /最新の版を調べられませんでした：npm error code E401/);
  assert.equal(failed.hub, "0.1.0");
  assert.equal(failed.hubError, undefined);
  assert.equal(failed.checking, undefined);
  const steps = c.sent.filter((m) => m.type === "latest").map((m) => (m.type === "latest" ? m.latest.checking === true : false));
  assert.deepEqual(steps, [false, true, false]);

  await latest.check();
  assert.deepEqual(latest.latest().daemon, "0.16.1");
  assert.equal(latest.latest().error, undefined);
  assert.equal(latest.latest().hub, "0.1.0");
  assert.equal(latest.latest().hubError, "Gasho サーバーの最新の版を調べられませんでした：npm error code ETIMEDOUT");
});

test("a gasho-daemon from before the package was renamed is told to be moved by hand, not updated", () => {
  assert.equal(versionAfter("0.21.1", [0, 21, 1]), false);
  assert.equal(versionAfter("0.21.2", [0, 21, 1]), true);
  assert.equal(versionAfter("0.22.0", [0, 21, 1]), true);
  assert.equal(versionAfter("1.0.0", [0, 21, 1]), true);
  assert.equal(versionAfter("0.9.30", [0, 21, 1]), false);
  assert.equal(versionAfter(undefined, [0, 21, 1]), false);

  const says = { canUpdate: true, installed: ["0.20.0"], previous: "0.20.0", failed: { version: "0.22.0", error: "E404", at: 1 } };
  const old = updateInfoFor("0.21.1", says);
  assert.equal(old?.canUpdate, false);
  assert.match(old?.reason ?? "", /@4rtofl:registry/);
  assert.equal(old?.command, "npx @4rtofl/gasho-daemon@latest service install");
  assert.equal(old?.previous, undefined);
  assert.equal(old?.installed, undefined);
  assert.equal(old?.failed?.error, "E404");
  assert.deepEqual(updateInfoFor("0.21.2", says), updateInfoOf(says));
  assert.equal(updateInfoFor("0.21.0", undefined), undefined);

  const store = new Store(":memory:");
  const machine = store.createDevice("machine", "mac");
  const browser = store.createDevice("browser", "iPhone");
  const hub = new Hub(store, {});
  const c = fakePeer<HubToClient>(browser.device.id);
  hub.onClientConnect(c);
  const d = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(d, { type: "hello", machineId: machine.device.id, token: machine.token, daemonVersion: "0.21.0" });
  hub.onDaemonMessage(d, { ...caps, update: { canUpdate: true } });
  hub.onClientMessage(c, { type: "daemon.update", requestId: "r", machine: machine.device.id, version: "0.22.0" });
  const r = c.sent.at(-1);
  assert.ok(r?.type === "command.result");
  assert.match(r.result.error ?? "", /パッケージの名前が変わる前/);
  assert.ok(d.sent.every((m) => m.type !== "daemon.update"));
});

/** The folders made by the helpers below, removed once this file's tests are done. */
const temps: string[] = [];
after(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

/** A stand-in for npm that records its arguments and answers as `script` says. */
function fakeNpm(script: string): { bin: string; args: () => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-hub-npm-"));
  temps.push(dir);
  const bin = path.join(dir, "npm");
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" > "${dir}/args"\n${script}\n`, { mode: 0o755 });
  return { bin, args: () => fs.readFileSync(path.join(dir, "args"), "utf8").trim() };
}

test("npm view gives the version the latest tag points at, as JSON or plain, and anything else is refused", async () => {
  const json = fakeNpm(`echo '"0.21.4"'`);
  assert.equal(await npmLatest(json.bin, DAEMON_PACKAGE), "0.21.4");
  // Not the versions npm read earlier and kept.
  assert.equal(json.args(), `view ${DAEMON_PACKAGE} version --json --prefer-online`);
  assert.equal(await npmLatest(fakeNpm("echo 0.7.3").bin, HUB_PACKAGE), "0.7.3");
  await assert.rejects(npmLatest(fakeNpm(`echo '["0.7.3"]'`).bin, HUB_PACKAGE), /^Error: npm view @4rtofl\/gasho-hub がわからない答えを返しました：\["0\.7\.3"\]$/);
  await assert.rejects(npmLatest(fakeNpm(`echo '"latest"'`).bin, HUB_PACKAGE), /がわからない答えを返しました/);
});

test("when npm view fails, the last lines it wrote say why (npm's E404 for a package not published yet)", async () => {
  const failing = fakeNpm(`echo "npm notice a" >&2; echo "npm error code E404" >&2; echo "npm error 404 Not Found - GET https://npm.pkg.github.com/x" >&2; echo "npm error 404" >&2; exit 1`);
  await assert.rejects(npmLatest(failing.bin, HUB_PACKAGE), (e: Error) => {
    assert.equal(e.message, "npm error code E404\nnpm error 404 Not Found - GET https://npm.pkg.github.com/x\nnpm error 404");
    return true;
  });
  await assert.rejects(npmLatest(fakeNpm("exit 3").bin, HUB_PACKAGE), /Command failed/);
});

test("npm is GASHO_NPM_BIN, or the one beside the Node.js that runs the Gasho server, or the one on PATH", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-hub-node-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const node = path.join(dir, "node");
  assert.equal(npmBin({ GASHO_NPM_BIN: "/opt/npm" }, node), "/opt/npm");
  assert.equal(npmBin({}, node), "npm");
  fs.writeFileSync(path.join(dir, "npm"), "");
  assert.equal(npmBin({}, node), path.join(dir, "npm"));
});
