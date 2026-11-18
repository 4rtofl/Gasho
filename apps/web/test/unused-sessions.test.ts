import assert from "node:assert/strict";
import { test } from "node:test";
import type { MachineInfo, SessionInfo } from "@gasho/protocol";
import { KEEP_FOR_MS, UNUSED_AFTER_MS, keepUnused, keepsUnused, lastActive, unusedSessions } from "../src/lib/unused-sessions.ts";

const NOW = 1_800_000_000_000;
const old = NOW - UNUSED_AFTER_MS;

const session = (sessionId: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  sessionId,
  cwd: "/repo",
  status: "idle",
  rcMode: "server",
  prLinks: [],
  managed: true,
  ...extra,
});
const server = (sessions: SessionInfo[], extra: Partial<MachineInfo> = {}): MachineInfo => ({
  id: "mac",
  name: "Mac",
  connected: true,
  lastSeen: 0,
  daemonVersion: "0.24.0",
  sessions,
  ...extra,
});
const ids = (sessions: SessionInfo[]) => sessions.map((s) => s.sessionId);

test("an idle session started by Gasho is unused from 24 hours after its last activity", () => {
  assert.deepEqual(ids(unusedSessions(server([session("s", { lastActivityAt: old })]), NOW)), ["s"]);
  assert.deepEqual(unusedSessions(server([session("s", { lastActivityAt: old + 1 })]), NOW), []);
});

test("the time it started counts when nothing was active after it", () => {
  assert.deepEqual(ids(unusedSessions(server([session("s", { startedAt: old })]), NOW)), ["s"]);
  assert.deepEqual(unusedSessions(server([session("s", { startedAt: old, lastActivityAt: NOW })]), NOW), []);
});

test("a conversation opened again counts as active from then, though its last record is old", () => {
  const record = old - UNUSED_AFTER_MS;
  assert.deepEqual(unusedSessions(server([session("s", { lastActivityAt: record, startedAt: NOW - 5000 })]), NOW), []);
  assert.deepEqual(ids(unusedSessions(server([session("s", { lastActivityAt: record, startedAt: old })]), NOW)), ["s"]);
  assert.equal(lastActive(session("s", { lastActivityAt: record, startedAt: old })), old);
});

test("a session whose last activity is not known is left alone", () => {
  assert.deepEqual(unusedSessions(server([session("s")]), NOW), []);
});

const background = [{ id: "t" }] as unknown as SessionInfo["background"];
for (const [what, extra] of [
  ["busy", { status: "busy" }],
  ["waiting", { status: "waiting" }],
  ["unknown", { status: "unknown" }],
  ["running background work", { background }],
  ["started outside Gasho", { managed: false }],
] as [string, Partial<SessionInfo>][]) {
  test(`a session that is ${what} is not unused`, () => {
    assert.deepEqual(unusedSessions(server([session("s", { lastActivityAt: old, ...extra })]), NOW), []);
  });
}

test("the session on the screen is not unused", () => {
  const sessions = [session("open", { lastActivityAt: old }), session("other", { lastActivityAt: old })];
  assert.deepEqual(ids(unusedSessions(server(sessions), NOW, "open")), ["other"]);
});

test("the session unused longest comes first", () => {
  const sessions = [session("newer", { lastActivityAt: old }), session("older", { lastActivityAt: old - 1000 })];
  assert.deepEqual(ids(unusedSessions(server(sessions), NOW)), ["older", "newer"]);
});

for (const [what, extra] of [
  ["offline", { connected: false }],
  ["running a gasho-daemon that cannot remove sessions", { daemonVersion: "0.8.3" }],
] as [string, Partial<MachineInfo>][]) {
  test(`nothing is unused on a working server that is ${what}`, () => {
    assert.deepEqual(unusedSessions(server([session("s", { lastActivityAt: old })], extra), NOW), []);
  });
}

test("keeping the unused sessions lasts an hour, on that working server only", () => {
  keepUnused("kept-mac", NOW);
  assert.equal(keepsUnused("kept-mac", NOW + KEEP_FOR_MS - 1), true);
  assert.equal(keepsUnused("kept-mac", NOW + KEEP_FOR_MS), false);
  assert.equal(keepsUnused("kept-other", NOW), false);
});
