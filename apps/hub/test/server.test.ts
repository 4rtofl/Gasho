// End-to-end over HTTP and WebSocket: registration, cookies, cross-origin guards and the allow list.
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { WebSocket as WsClient } from "ws";
import type { HubToClient, PairResponse } from "@gasho/protocol";
import { Hub } from "../src/hub.ts";
import { buildAllowList, parseNets } from "../src/netallow.ts";
import { createServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

let store: Store;
let server: ReturnType<typeof createServer>;
let base = "";

before(async () => {
  store = new Store(":memory:");
  server = createServer({ hub: new Hub(store), store, webDist: "/nonexistent", allow: buildAllowList(parseNets(undefined)) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const json = { "content-type": "application/json" };

async function pair(kind: "browser" | "machine", name: string, code = store.createPairingCode("test").code) {
  return fetch(`${base}/api/pair`, { method: "POST", headers: json, body: JSON.stringify({ code, kind, name }) });
}

function firstMessage(url: string, headers: Record<string, string>): Promise<{ data?: unknown; close?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers } as unknown as string[]);
    ws.addEventListener("message", (ev) => {
      resolve({ data: JSON.parse(String(ev.data)) });
      ws.close();
    });
    ws.addEventListener("close", (ev) => resolve({ close: ev.code }));
  });
}

/** A WebSocket of ws, which can also send a text frame that is not UTF-8 (a Buffer is sent as it is). */
async function connect(url: string, headers: Record<string, string> = {}) {
  const ws = new WsClient(url, { headers });
  const received: unknown[] = [];
  const waiting: ((m: unknown) => void)[] = [];
  ws.on("message", (data) => {
    const m = JSON.parse(String(data)) as unknown;
    const w = waiting.shift();
    if (w) w(m);
    else received.push(m);
  });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  await once(ws, "open");
  return {
    send: (m: unknown) => ws.send(Buffer.isBuffer(m) ? m : JSON.stringify(m), { binary: false }),
    next: () => (received.length > 0 ? Promise.resolve(received.shift()) : new Promise<unknown>((r) => waiting.push(r))),
    closed,
  };
}

test("a browser registers with a code, gets a cookie, and can then use the API", async () => {
  assert.equal((await fetch(`${base}/api/me`)).status, 401);

  const bad = await pair("browser", "iPhone", "WRNG-CODE");
  assert.equal(bad.status, 400);

  const res = await pair("browser", "iPhone");
  assert.equal(res.status, 201);
  const body = (await res.json()) as PairResponse;
  assert.equal(body.token, undefined); // browsers get the token only as a cookie
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^gasho_device=[0-9a-f-]+\.[\w-]+; .*HttpOnly; SameSite=Strict/);
  const cookie = setCookie.split(";")[0] ?? "";

  const me = await fetch(`${base}/api/me`, { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal(((await me.json()) as { name: string }).name, "iPhone");

  // State changes must be JSON from the same origin.
  assert.equal((await fetch(`${base}/api/pairing-codes`, { method: "POST", headers: { cookie } })).status, 415);
  const cross = await fetch(`${base}/api/pairing-codes`, {
    method: "POST",
    headers: { cookie, ...json, origin: "http://evil.example" },
    body: "{}",
  });
  assert.equal(cross.status, 403);
  const code = await fetch(`${base}/api/pairing-codes`, { method: "POST", headers: { cookie, ...json }, body: "{}" });
  assert.equal(code.status, 201);
  assert.match(((await code.json()) as { code: string }).code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const devices = (await (await fetch(`${base}/api/devices`, { headers: { cookie } })).json()) as Array<{ current?: boolean }>;
  assert.equal(devices.filter((d) => d.current).length, 1);

  // The browser WebSocket needs the cookie.
  const anonymous = await firstMessage(`${base.replace("http", "ws")}/ws/client`, {});
  assert.equal(anonymous.close, 4401);
  const authed = await firstMessage(`${base.replace("http", "ws")}/ws/client`, { cookie });
  assert.equal((authed.data as HubToClient).type, "snapshot");

  // Unregistering this browser clears the cookie and the registration.
  const out = await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie, ...json }, body: "{}" });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.equal((await fetch(`${base}/api/me`, { headers: { cookie } })).status, 401);
});

test("a working server registers with a code, gets a token, and its hello is accepted", async () => {
  const res = await pair("machine", "ubuntu");
  assert.equal(res.status, 201);
  const body = (await res.json()) as PairResponse;
  assert.ok(body.token);
  assert.equal(res.headers.get("set-cookie"), null);

  const welcome = await new Promise<unknown>((resolve) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/ws/daemon`);
    ws.addEventListener("open", () =>
      ws.send(JSON.stringify({ type: "hello", machineId: body.deviceId, token: body.token, daemonVersion: "test" })),
    );
    ws.addEventListener("message", (ev) => {
      resolve(JSON.parse(String(ev.data)));
      ws.close();
    });
  });
  assert.deepEqual(welcome, { type: "welcome" });
});

test("guessing codes is slowed down", async () => {
  // Earlier tests used up one failure for this address; 9 more reach the limit of 10.
  for (let i = 0; i < 9; i++) assert.equal((await pair("browser", "x", "AAAA-AAAA")).status, 400);
  assert.equal((await pair("browser", "x")).status, 429);
});

test("malformed requests and messages are answered or left, and the Gasho server keeps running (#97)", { timeout: 10_000 }, async () => {
  const wsBase = base.replace("http", "ws");
  assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);

  // Another app on the same host name may set a cookie that is not URI-encoded.
  const browser = store.createDevice("browser", "Mac");
  const cookie = `other=%E0%A4%A; gasho_device=${browser.device.id}.${browser.token}`;
  assert.equal((await fetch(`${base}/plugins/x/0123456789abcdef/web.js`, { headers: { cookie } })).status, 404);
  const client = await connect(`${wsBase}/ws/client`, { cookie });
  assert.equal(((await client.next()) as HubToClient).type, "snapshot");
  client.send({ type: "notification.read" });
  client.send({ type: "ping" });
  assert.deepEqual(await client.next(), { type: "pong" });
  // Text that is not UTF-8: ws closes the connection.
  client.send(Buffer.from([0xff]));
  assert.equal(await client.closed, 1007);

  const stranger = await connect(`${wsBase}/ws/daemon`);
  stranger.send({ type: "hello", token: "x" });
  assert.equal(await stranger.closed, 4001);

  const machine = store.createDevice("machine", "mac");
  const daemon = await connect(`${wsBase}/ws/daemon`);
  daemon.send({ type: "hello", machineId: machine.device.id, token: machine.token, daemonVersion: "0.21.4" });
  assert.deepEqual(await daemon.next(), { type: "welcome" });
  daemon.send({ type: "sessions" });
  daemon.send({ type: "hook", event: { sessionId: "s1", event: "Stop" } });
  daemon.send(Buffer.from([0xff]));
  assert.equal(await daemon.closed, 1007);

  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("addresses outside the allow list are refused", async () => {
  const s2 = new Store(":memory:");
  const strict = createServer({ hub: new Hub(s2), store: s2, webDist: "/nonexistent", allow: buildAllowList(["10.0.0.0/8"]) });
  await new Promise<void>((r) => strict.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(strict.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${url}/api/health`)).status, 403);
    assert.equal((await fetch(`${url}/`)).status, 403);
  } finally {
    strict.closeAllConnections();
    strict.close();
  }
});

test("only the hashed files under assets/ are cached for good; the browser asks again for the others, and never keeps the Service Worker", async () => {
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "gasho-web-"));
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html>");
  fs.writeFileSync(path.join(dist, "assets", "index-AbCd1234.js"), "");
  fs.writeFileSync(path.join(dist, "manifest.webmanifest"), "{}");
  fs.writeFileSync(path.join(dist, "sw.js"), "");
  const s2 = new Store(":memory:");
  const web = createServer({ hub: new Hub(s2), store: s2, webDist: dist, allow: buildAllowList(parseNets(undefined)) });
  await new Promise<void>((r) => web.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
  const get = async (p: string) => {
    const res = await fetch(`${url}${p}`);
    await res.arrayBuffer();
    return { type: res.headers.get("content-type"), cache: res.headers.get("cache-control") };
  };
  try {
    assert.deepEqual(await get("/assets/index-AbCd1234.js"), {
      type: "text/javascript; charset=utf-8",
      cache: "public, max-age=31536000, immutable",
    });
    assert.deepEqual(await get("/manifest.webmanifest"), { type: "application/manifest+json", cache: "no-cache" });
    // The Service Worker is not kept at all.
    assert.deepEqual(await get("/sw.js"), { type: "text/javascript; charset=utf-8", cache: "no-store" });
    // A path the app routes itself gets index.html.
    assert.deepEqual(await get("/sessions/x"), { type: "text/html; charset=utf-8", cache: "no-cache" });
    // A file found but not opened (as one removed meanwhile) is answered with 500 (root opens any file).
    if (process.getuid?.() !== 0) {
      fs.writeFileSync(path.join(dist, "locked.txt"), "");
      fs.chmodSync(path.join(dist, "locked.txt"), 0);
      assert.equal((await fetch(`${url}/locked.txt`)).status, 500);
    }
  } finally {
    web.closeAllConnections();
    web.close();
    fs.rmSync(dist, { recursive: true, force: true });
  }
});
