import assert from "node:assert/strict";
import { test } from "node:test";
import type { ServerInfo } from "@gasho/protocol";
import { hubChangesUrl, hubNewerPublished, hubUpdateTo, hubUpdateToTell, onOutOfDate, outOfDate, RELOAD_AGAIN_MS } from "../src/lib/server-update.ts";

const server = (o: Partial<ServerInfo> = {}): ServerInfo => ({ version: "0.1.0", web: "hub-0.1.0", update: { canUpdate: true }, ...o });

test("the Gasho server's update is offered only for a newer version, when it can take one and none is under way", () => {
  const latest = { hub: "0.2.0", checkedAt: 1 };
  assert.equal(hubUpdateTo(server(), latest), "0.2.0");
  assert.equal(hubUpdateTo(server({ version: "0.2.0" }), latest), undefined);
  assert.equal(hubUpdateTo(server({ version: "0.3.0" }), latest), undefined);
  assert.equal(hubUpdateTo(server({ update: { canUpdate: false, reason: "clone" } }), latest), undefined);
  assert.equal(hubUpdateTo(server({ update: { canUpdate: true, progress: { version: "0.2.0", step: "drain", at: 1 } } }), latest), undefined);
  // On trial, a newer one may follow.
  assert.equal(hubUpdateTo(server({ update: { canUpdate: true, progress: { version: "0.1.0", step: "trial", at: 1 } } }), latest), "0.2.0");
  assert.equal(hubUpdateTo(server(), { checkedAt: 1 }), undefined);
  assert.equal(hubUpdateTo(undefined, latest), undefined);

  // A version it went back from by itself is still offered, but the sidebar does not call for it.
  const back = server({ update: { canUpdate: true, rolledBack: { from: "0.2.0", to: "0.1.0", at: 1, error: "boom" } } });
  assert.equal(hubUpdateTo(back, latest), "0.2.0");
  assert.equal(hubUpdateToTell(back, latest), undefined);
  assert.equal(hubUpdateToTell(back, { hub: "0.2.1", checkedAt: 1 }), "0.2.1");
  assert.equal(hubUpdateToTell(server(), latest), "0.2.0");

  // Newer, whether or not Gasho can update it (then the row says how).
  assert.equal(hubNewerPublished(server({ update: { canUpdate: false } }), latest), true);
  assert.equal(hubNewerPublished(server({ version: "0.2.0" }), latest), false);
  assert.equal(hubNewerPublished(server(), undefined), false);
  assert.equal(hubChangesUrl("0.1.0", "0.2.0"), "https://github.com/4rtofl/Gasho/compare/hub-v0.1.0...hub-v0.2.0");
});

test("a page is out of date when the Gasho server serves another build of the screen; never under the dev server", () => {
  assert.equal(outOfDate(server(), "hub-0.1.0"), false);
  assert.equal(outOfDate(server({ web: "hub-0.2.0" }), "hub-0.1.0"), true);
  assert.equal(outOfDate(server({ web: undefined }), "hub-0.1.0"), false);
  assert.equal(outOfDate(undefined, "hub-0.1.0"), false);
  assert.equal(outOfDate(server({ web: "hub-0.2.0" }), "dev"), false);
});

test("an out-of-date page reloads itself, unless something is being written in it or it just did for this build", () => {
  const now = 1_000_000;
  assert.equal(onOutOfDate({ build: "b2", busy: false, last: undefined, now }), "reload");
  assert.equal(onOutOfDate({ build: "b2", busy: true, last: undefined, now }), "band");
  // Reloaded for this build a moment ago, and still out of date: no loop.
  assert.equal(onOutOfDate({ build: "b2", busy: false, last: { build: "b2", at: now - 5_000 }, now }), "band");
  assert.equal(onOutOfDate({ build: "b2", busy: false, last: { build: "b2", at: now - RELOAD_AGAIN_MS }, now }), "reload");
  assert.equal(onOutOfDate({ build: "b3", busy: false, last: { build: "b2", at: now - 5_000 }, now }), "reload");
});
