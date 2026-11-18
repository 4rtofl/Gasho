// Web Push: the subscriptions kept, the VAPID keys and header, the encryption (decrypted here as a browser would),
// the sending to a fake push service, and the Gasho server's part (ping and pong, being on screen).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { GashoNotification, HubToClient, HubToDaemon, PushPayload, SessionInfo } from "@gasho/protocol";
import { Hub, PRESENCE_TTL_MS } from "../src/hub.ts";
import {
  checkSubscription,
  DEFAULT_VAPID_SUBJECT,
  encryptPayload,
  type PushFetch,
  PushSender,
  pushPayloadOf,
  vapidAuthorization,
  vapidKeysOf,
} from "../src/push.ts";
import { Store } from "../src/store.ts";

/** A browser's side of a subscription: its key pair and secret. */
function browserKeys() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, p256dh: ecdh.getPublicKey().toString("base64url"), authB64: auth.toString("base64url") };
}

/** Decrypts an aes128gcm message as the browser does (RFC 8291). */
function decrypt(body: Buffer, ua: { ecdh: crypto.ECDH; auth: Buffer }): Buffer {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  assert.ok(data.length <= rs);
  const shared = ua.ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ua.ecdh.getPublicKey(), asPublic]);
  const prk = crypto.createHmac("sha256", ua.auth).update(shared).digest();
  const ikm = crypto.createHmac("sha256", prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  const prk2 = crypto.createHmac("sha256", salt).update(ikm).digest();
  const cek = crypto.createHmac("sha256", prk2).update(Buffer.from("Content-Encoding: aes128gcm\0\x01")).digest().subarray(0, 16);
  const nonce = crypto.createHmac("sha256", prk2).update(Buffer.from("Content-Encoding: nonce\0\x01")).digest().subarray(0, 12);
  const decipher = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2, "the last record's delimiter");
  return plain.subarray(0, plain.length - 1);
}

/** A fake push service: records what is posted and answers with `status(endpoint)`. */
function fakeService(status: (endpoint: string) => number = () => 201) {
  const posts: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
  const fetch: PushFetch = async (url, init) => {
    posts.push({ url, headers: init.headers, body: Buffer.from(init.body) });
    return { status: status(url), text: async () => "" };
  };
  return { posts, fetch };
}

const quiet = () => {};

function subscriptionOf(endpoint: string, keys = browserKeys()) {
  return { keys, sub: { endpoint, keys: { p256dh: keys.p256dh, auth: keys.authB64 } } };
}

const notification = (kind: GashoNotification["kind"] = "done"): GashoNotification => ({
  id: "n1",
  machine: "m1",
  sessionId: "s1",
  at: 1,
  kind,
  title: "プラグインの整理 の応答が終わりました",
  body: "秘密の会話の中身",
  read: false,
});

test("the encryption is what a browser decrypts", () => {
  const ua = browserKeys();
  const text = Buffer.from(JSON.stringify({ title: "こんにちは" }));
  const body = encryptPayload(text, { p256dh: ua.p256dh, auth: ua.authB64 });
  assert.deepEqual(decrypt(body, ua), text);
  // A new salt and key each time.
  assert.notDeepEqual(encryptPayload(text, { p256dh: ua.p256dh, auth: ua.authB64 }).subarray(0, 86), body.subarray(0, 86));
});

test("the VAPID header is a JWT for the push service's origin, signed with the key browsers subscribe with", () => {
  const store = new Store(":memory:");
  const keys = vapidKeysOf(store);
  // Made once and kept.
  assert.deepEqual(vapidKeysOf(store), keys);
  const now = Date.UTC(2026, 10, 16);
  const h = vapidAuthorization("https://web.push.apple.com/QGxx/abc", keys, DEFAULT_VAPID_SUBJECT, now);
  const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(h);
  assert.ok(m);
  const [, header, claims, sig, k] = m as unknown as string[];
  assert.equal(k, keys.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(header as string, "base64url").toString()), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(Buffer.from(claims as string, "base64url").toString()), {
    aud: "https://web.push.apple.com",
    exp: now / 1000 + 12 * 3600,
    sub: "https://github.com/4rtofl/Gasho",
  });
  const raw = Buffer.from(k as string, "base64url");
  assert.equal(raw.length, 65);
  const pub = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
  assert.ok(crypto.verify("sha256", Buffer.from(`${header}.${claims}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(sig as string, "base64url")));
});

test("only https subscriptions with proper keys are taken", () => {
  const { sub } = subscriptionOf("https://fcm.googleapis.com/fcm/send/x");
  assert.deepEqual(checkSubscription(sub), sub);
  assert.equal(checkSubscription({ ...sub, endpoint: "http://127.0.0.1/x" }), undefined);
  assert.equal(checkSubscription({ ...sub, endpoint: "not a url" }), undefined);
  assert.equal(checkSubscription({ ...sub, keys: { ...sub.keys, auth: "AAAA" } }), undefined);
  assert.equal(checkSubscription({ ...sub, keys: { ...sub.keys, p256dh: Buffer.alloc(65).toString("base64url") } }), undefined);
  assert.equal(checkSubscription(undefined), undefined);
});

test("subscriptions are kept per browser, moved with their endpoint, and forgotten with the browser's registration", () => {
  const store = new Store(":memory:");
  const a = store.createDevice("browser", "iPhone").device.id;
  const b = store.createDevice("browser", "Mac").device.id;
  const push = new PushSender({ store, fetch: fakeService().fetch, log: quiet });
  const s1 = subscriptionOf("https://web.push.apple.com/1").sub;
  assert.equal(push.subscribe(a, s1, ["done", "bogus", "permission"]), true);
  assert.deepEqual(push.info(a).subscriptions, [{ endpoint: s1.endpoint, kinds: ["done", "permission"] }]);
  // The kinds change.
  push.subscribe(a, s1, ["error"]);
  assert.deepEqual(push.info(a).subscriptions, [{ endpoint: s1.endpoint, kinds: ["error"] }]);
  assert.equal(push.subscribe(a, { endpoint: "http://x" }, ["done"]), false);
  // Another browser cannot drop it, the browser itself can.
  push.unsubscribe(b, s1.endpoint);
  assert.equal(push.info(a).subscriptions.length, 1);
  push.unsubscribe(a, s1.endpoint);
  assert.equal(push.info(a).subscriptions.length, 0);
  // Only the newest few per browser.
  for (let i = 0; i < 7; i++) store.savePushSubscription({ endpoint: `https://p.example/${i}`, deviceId: b, p256dh: "x", auth: "y", kinds: ["done"] }, i);
  push.subscribe(b, subscriptionOf("https://p.example/new").sub, ["done"]);
  assert.deepEqual(
    push.info(b).subscriptions.map((s) => s.endpoint),
    ["https://p.example/3", "https://p.example/4", "https://p.example/5", "https://p.example/6", "https://p.example/new"],
  );
  assert.equal(store.revokeDevice(b), true);
  assert.equal(store.pushSubscriptionsOf(b).length, 0);
});

test("a revoked browser is sent nothing even if its subscription is still there (left by an older Gasho server)", async () => {
  const store = new Store(":memory:");
  const a = store.createDevice("browser", "iPhone").device.id;
  const svc = fakeService();
  const push = new PushSender({ store, fetch: svc.fetch, log: quiet });
  push.subscribe(a, subscriptionOf("https://web.push.apple.com/1").sub, ["done"]);
  // As an older server revokes: the row stays.
  (store as unknown as { db: DatabaseSync }).db.prepare("UPDATE devices SET revoked_at = 1 WHERE id = ?").run(a);
  await push.notify(notification(), "x", 0);
  assert.equal(svc.posts.length, 0);
});

test("a notification goes, encrypted, to the subscriptions that asked for its kind, with only the session's name and kind", async () => {
  const store = new Store(":memory:");
  const a = store.createDevice("browser", "iPhone").device.id;
  const b = store.createDevice("browser", "Mac").device.id;
  const svc = fakeService();
  const push = new PushSender({ store, fetch: svc.fetch, subject: "mailto:x@example.com", log: quiet });
  const ka = subscriptionOf("https://web.push.apple.com/a");
  push.subscribe(a, ka.sub, ["done", "permission"]);
  push.subscribe(b, subscriptionOf("https://fcm.googleapis.com/b").sub, ["permission"]);
  await push.notify(notification("done"), "プラグインの整理", 2);
  assert.equal(svc.posts.length, 1);
  const post = svc.posts[0];
  assert.ok(post);
  assert.equal(post.url, ka.sub.endpoint);
  assert.equal(post.headers["content-encoding"], "aes128gcm");
  assert.equal(post.headers.ttl, "86400");
  assert.match(post.headers.authorization ?? "", /^vapid t=.+, k=.+$/);
  const claims = JSON.parse(Buffer.from((post.headers.authorization ?? "").split(".")[1] ?? "", "base64url").toString()) as { aud: string; sub: string };
  assert.deepEqual([claims.aud, claims.sub], ["https://web.push.apple.com", "mailto:x@example.com"]);
  const payload = JSON.parse(decrypt(post.body, ka.keys).toString()) as PushPayload;
  assert.deepEqual(payload, { title: "プラグインの整理", body: "応答が終わりました", kind: "done", tag: "m1/s1", url: "/#/s/m1/s1", badge: 2 });
  assert.ok(!JSON.stringify(payload).includes("秘密"));
  // Both for a permission, but not to a browser on screen.
  svc.posts.length = 0;
  await push.notify(notification("permission"), "x", 1, (device) => device === b);
  assert.deepEqual(svc.posts.map((p) => p.url), [ka.sub.endpoint]);
});

test("a subscription the push service no longer knows (404, 410) is forgotten; other failures keep it", async () => {
  const store = new Store(":memory:");
  const a = store.createDevice("browser", "iPhone").device.id;
  const answers: Record<string, number> = { "https://p.example/gone": 410, "https://p.example/missing": 404, "https://p.example/busy": 503 };
  const svc = fakeService((url) => answers[url] ?? 201);
  const logs: string[] = [];
  const push = new PushSender({ store, fetch: svc.fetch, log: (s) => logs.push(s) });
  for (const e of ["https://p.example/gone", "https://p.example/missing", "https://p.example/busy", "https://p.example/ok"]) {
    push.subscribe(a, subscriptionOf(e).sub, ["done"]);
  }
  // A push service that cannot be reached is only logged.
  const down = subscriptionOf("https://down.example/x");
  push.subscribe(a, down.sub, ["done"]);
  const failing = new PushSender({
    store,
    fetch: async (url, init) => (url.startsWith("https://down.example") ? Promise.reject(new Error("ECONNREFUSED")) : svc.fetch(url, init)),
    log: (s) => logs.push(s),
  });
  await failing.notify(notification(), "x", 0);
  assert.deepEqual(
    push.info(a).subscriptions.map((s) => s.endpoint).sort(),
    ["https://down.example/x", "https://p.example/busy", "https://p.example/ok"],
  );
  assert.ok(logs.some((l) => l.includes("410")));
  assert.ok(logs.some((l) => l.includes("503")));
  assert.ok(logs.some((l) => l.includes("ECONNREFUSED")));
});

test("the VAPID keys survive a restart of the Gasho server", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-push-"));
  try {
    const file = path.join(dir, "hub.db");
    const s1 = new Store(file);
    const k1 = new PushSender({ store: s1, log: quiet }).info("x").publicKey;
    s1.close();
    const s2 = new Store(file);
    assert.equal(new PushSender({ store: s2, log: quiet }).info("x").publicKey, k1);
    s2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the Gasho server's part ----

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

const session: SessionInfo = { sessionId: "s1", cwd: "/home/rg/repos/Bobert", title: "プラグインの整理", status: "idle", rcMode: "server", prLinks: [], managed: true };

function setup() {
  const store = new Store(":memory:");
  const machine = store.createDevice("machine", "ubuntu");
  const phone = store.createDevice("browser", "iPhone").device.id;
  const svc = fakeService();
  const push = new PushSender({ store, fetch: svc.fetch, log: quiet });
  const hub = new Hub(store, { push });
  const daemon = fakePeer<HubToDaemon>();
  hub.onDaemonMessage(daemon, { type: "hello", machineId: machine.device.id, token: machine.token, daemonVersion: "0.20.0" });
  hub.onDaemonMessage(daemon, { type: "sessions", sessions: [session, { ...session, sessionId: "s2", status: "waiting" }] });
  const stop = () => hub.onDaemonMessage(daemon, { type: "hook", event: { sessionId: "s1", event: "Stop", at: 1, summary: "秘密" } });
  return { store, hub, svc, phone, stop, machineId: machine.device.id };
}

/** Lets the sending (not awaited by the Gasho server) finish. */
const settle = () => new Promise((r) => setTimeout(r, 10));
/** How t.waitFor waits for that sending: up to 5 seconds, for a machine under load. */
const WAIT = { interval: 10, timeout: 5_000 };

test("the Gasho server answers ping with pong, and its snapshot says so with this browser's Web Push", () => {
  const { hub, phone } = setup();
  const c = fakePeer<HubToClient>(phone);
  hub.onClientConnect(c);
  const snap = c.sent[0];
  assert.equal(snap?.type, "snapshot");
  if (snap?.type !== "snapshot") return;
  assert.equal(snap.heartbeat, true);
  assert.match(snap.push?.publicKey ?? "", /^[\w-]{87}$/);
  assert.deepEqual(snap.push?.subscriptions, []);
  hub.onClientMessage(c, { type: "ping" });
  assert.deepEqual(c.sent.at(-1), { type: "pong" });
  // Without Web Push (an embedding without it), no push in the snapshot; ping still works.
  const bare = new Hub(new Store(":memory:"));
  const d = fakePeer<HubToClient>("x");
  bare.onClientConnect(d);
  assert.equal(d.sent[0]?.type === "snapshot" && d.sent[0].push, undefined);
  bare.onClientMessage(d, { type: "ping" });
  assert.deepEqual(d.sent.at(-1), { type: "pong" });
});

test("subscribing from one page tells every page of that browser, and a notification is pushed with the badge", async (t) => {
  const { hub, svc, phone, stop } = setup();
  const c1 = fakePeer<HubToClient>(phone);
  const c2 = fakePeer<HubToClient>(phone);
  const other = fakePeer<HubToClient>("someone-else");
  for (const c of [c1, c2, other]) hub.onClientConnect(c);
  const ua = subscriptionOf("https://web.push.apple.com/z");
  hub.onClientMessage(c1, { type: "push.subscribe", subscription: ua.sub, kinds: ["done"] });
  for (const c of [c1, c2]) assert.deepEqual(c.sent.at(-1), { type: "push", push: { publicKey: (c.sent[0] as { push: { publicKey: string } }).push.publicKey, subscriptions: [{ endpoint: ua.sub.endpoint, kinds: ["done"] }] } });
  assert.equal(other.sent.at(-1)?.type, "snapshot");
  // Its pages are connected but in the background: it is sent the notification.
  hub.onClientMessage(c1, { type: "presence", visible: false });
  stop();
  await t.waitFor(() => assert.equal(svc.posts.length, 1), WAIT);
  const payload = JSON.parse(decrypt(svc.posts[0]?.body ?? Buffer.alloc(0), ua.keys).toString()) as PushPayload;
  // s2 waits for a confirmation.
  assert.equal(payload.badge, 1);
  assert.equal(payload.title, "プラグインの整理");
  hub.onClientMessage(c2, { type: "push.unsubscribe", endpoint: ua.sub.endpoint });
  assert.deepEqual(c1.sent.at(-1)?.type === "push" && c1.sent.at(-1), { type: "push", push: { publicKey: (c1.sent[0] as { push: { publicKey: string } }).push.publicKey, subscriptions: [] } });
});

test("a browser with a page on screen is not pushed to, until the page goes away, hides or goes silent", async (t) => {
  const { hub, svc, phone, stop } = setup();
  const c = fakePeer<HubToClient>(phone);
  hub.onClientConnect(c);
  hub.onClientMessage(c, { type: "push.subscribe", subscription: subscriptionOf("https://web.push.apple.com/z").sub, kinds: ["done"] });
  hub.onClientMessage(c, { type: "presence", visible: true });
  assert.equal(hub.onScreen(phone), true);
  stop();
  await settle();
  assert.equal(svc.posts.length, 0);
  // Silent for too long (the phone suspended it before it could say so).
  assert.equal(hub.onScreen(phone, Date.now() + PRESENCE_TTL_MS + 1), false);
  // A ping keeps it on screen.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + PRESENCE_TTL_MS - 1000 });
  hub.onClientMessage(c, { type: "ping" });
  assert.equal(hub.onScreen(phone, Date.now() + PRESENCE_TTL_MS - 1000), true);
  t.mock.timers.reset();
  hub.onClientMessage(c, { type: "presence", visible: false });
  stop();
  await t.waitFor(() => assert.equal(svc.posts.length, 1), WAIT);
  hub.onClientMessage(c, { type: "presence", visible: true });
  hub.onClientClose(c);
  assert.equal(hub.onScreen(phone), false);
});

test("a permission prompt counts its session in the badge before the sessions say it waits", async (t) => {
  const { hub, svc, phone } = setup();
  const c = fakePeer<HubToClient>(phone);
  hub.onClientConnect(c);
  const ua = subscriptionOf("https://web.push.apple.com/z");
  hub.onClientMessage(c, { type: "push.subscribe", subscription: ua.sub, kinds: ["permission"] });
  hub.onClientClose(c);
  const machine = [...(hub as unknown as { daemons: Map<string, ReturnType<typeof fakePeer<HubToDaemon>>> }).daemons.values()][0];
  assert.ok(machine);
  hub.onDaemonMessage(machine, { type: "hook", event: { sessionId: "s1", event: "Notification", notificationType: "permission_prompt", at: 2, summary: "rm -rf" } });
  await t.waitFor(() => assert.equal(svc.posts.length, 1), WAIT);
  const payload = JSON.parse(decrypt(svc.posts[0]?.body ?? Buffer.alloc(0), ua.keys).toString()) as PushPayload;
  assert.deepEqual([payload.body, payload.badge], ["確認を待っています", 2]);
});

test("the lock screen shows a plugin's title, and Gasho's fixed words for the others", () => {
  const n: GashoNotification = { id: "1", machine: "m", sessionId: "s", at: 1, kind: "done", title: "s の応答が終わりました", body: "会話の中身", read: false };
  assert.equal(pushPayloadOf(n, "s", 0).body, "応答が終わりました");
  const said = pushPayloadOf({ ...n, title: "#5 のレビューが終わりました", plugin: "github-review" }, "s", 0);
  assert.equal(said.body, "#5 のレビューが終わりました");
  assert.equal(said.kind, "done");
});
