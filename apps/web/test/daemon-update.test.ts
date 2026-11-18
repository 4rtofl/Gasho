import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineInfo } from "@gasho/protocol";
import { changesUrl, compareVersions, newerPublished, pendingWork, trialLabel, updateTo, updateToTell } from "../src/lib/daemon-update.ts";

const machine = (o: Partial<MachineInfo>): MachineInfo => ({ id: "m", name: "ubuntu", connected: true, lastSeen: 0, sessions: [], ...o });

test("versions compare part by part, as numbers", () => {
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.15.0", "0.15.0"), 0);
  assert.equal(compareVersions("0.14.2", "0.15.0"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

test("an update is offered only for a newer version, to a connected gasho-daemon that can take it and is not updating", () => {
  const latest = { daemon: "0.16.0", checkedAt: 1 };
  const can = { canUpdate: true };
  assert.equal(updateTo(machine({ daemonVersion: "0.15.0", update: can }), latest), "0.16.0");
  assert.equal(updateTo(machine({ daemonVersion: "0.16.0", update: can }), latest), undefined);
  assert.equal(updateTo(machine({ daemonVersion: "0.17.0", update: can }), latest), undefined);
  assert.equal(updateTo(machine({ daemonVersion: "0.15.0", update: can, connected: false }), latest), undefined);
  assert.equal(updateTo(machine({ daemonVersion: "0.15.0", update: { canUpdate: false } }), latest), undefined);
  assert.equal(updateTo(machine({ daemonVersion: "0.14.0" }), latest), undefined);
  assert.equal(updateTo(machine({ daemonVersion: "0.15.0", update: { canUpdate: true, progress: { version: "0.16.0", step: "check", at: 1 } } }), latest), undefined);
  assert.equal(updateTo(machine({ daemonVersion: "0.15.0", update: can }), undefined), undefined);
  // On trial after an update, it can be updated again; one that went back by itself is offered, but not told of.
  const trial = { canUpdate: true, progress: { version: "0.15.0", step: "trial" as const, at: 1 } };
  assert.equal(updateTo(machine({ daemonVersion: "0.15.0", update: trial }), latest), "0.16.0");
  const back = { canUpdate: true, rolledBack: { from: "0.16.0", to: "0.15.0", at: 1 } };
  assert.equal(updateTo(machine({ daemonVersion: "0.15.0", update: back }), latest), "0.16.0");
  assert.equal(updateToTell(machine({ daemonVersion: "0.15.0", update: back }), latest), undefined);
  assert.equal(updateToTell(machine({ daemonVersion: "0.15.0", update: can }), latest), "0.16.0");
  // Published, but not updatable from Gasho: the row still says so.
  assert.ok(newerPublished(machine({ daemonVersion: "0.14.0" }), latest));
  assert.ok(!newerPublished(machine({ daemonVersion: "0.16.0" }), latest));
});

test("a working server's row says how long its trial takes, as gasho-daemon set it (GASHO_DAEMON_PROBATION_MS)", () => {
  assert.match(trialLabel(60_000), /（1分ほど。/);
  assert.match(trialLabel(20_000), /（20秒ほど。/);
  // A length the Gasho server does not pass on (over an hour): no length rather than a wrong one.
  assert.doesNotMatch(trialLabel(undefined), /ほど/);
});

test("the inputs to send and the permission requests an update would affect are counted; questions read from the screen are not", () => {
  const s = { cwd: "/r", status: "idle" as const, rcMode: "server" as const, prLinks: [] };
  const m = machine({
    sessions: [
      { ...s, sessionId: "a", pendingInputs: 2, permissionRequests: [{ id: "p1", toolName: "Bash", input: "{}", at: 1 }] },
      { ...s, sessionId: "b", permissionRequests: [{ id: "question:1", toolName: "AskUserQuestion", input: "{}", at: 1 }] },
    ],
  });
  assert.deepEqual(pendingWork(m), { inputs: 2, requests: 1 });
  assert.equal(changesUrl("0.15.0", "0.16.0"), "https://github.com/4rtofl/Gasho/compare/daemon-v0.15.0...daemon-v0.16.0");
});
