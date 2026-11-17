// The working server's registration with the Gasho server (credentials.ts) and its connection to it (hub-client.ts),
// against a stand-in for the Gasho server's /api/pair and /ws/daemon.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DaemonToHub, HubToDaemon, PairRequest } from "@gasho/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { daemonUrl, loadCredentials, register, saveCredentials } from "../src/credentials.ts";
import { HubClient } from "../src/hub-client.ts";

const WAIT = { timeout: 20_000 };

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "gasho-daemon-creds-"));
}

test("the registration is saved for this user only and read back; a missing or incomplete file says to register again", async () => {
  const file = path.join(tmp(), "gasho", "daemon.json");
  await assert.rejects(loadCredentials(file), new RegExp(`^Error: ${file} not found\\. Register this machine first`));

  await saveCredentials(file, { server: "http://hub:7740", machineId: "m1", token: "secret", name: "ubuntu" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(await loadCredentials(file), { server: "http://hub:7740", machineId: "m1", token: "secret", name: "ubuntu" });

  // Saved over a file that others could read, it is made private again.
  fs.chmodSync(file, 0o644);
  await saveCredentials(file, { server: "http://hub:7740", machineId: "m1", token: "secret2", name: "ubuntu" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  fs.writeFileSync(file, JSON.stringify({ server: "http://hub:7740", machineId: "m1" }));
  await assert.rejects(loadCredentials(file), /is incomplete; register this machine again/);
  fs.writeFileSync(file, JSON.stringify({ server: "http://hub:7740", machineId: "m1", token: "t" }));
  assert.equal((await loadCredentials(file)).name, "");
});

test("the WebSocket address is the Gasho server's, on /ws/daemon, and wss for https", () => {
  assert.equal(daemonUrl("http://192.168.1.10:7740"), "ws://192.168.1.10:7740/ws/daemon");
  assert.equal(daemonUrl("https://gasho.example.com/some/path?x=1"), "wss://gasho.example.com/ws/daemon");
});

/** A stand-in for POST /api/pair, answering `status` and `body`; `asked` holds what it was sent. */
async function pairServer(status: number, body: unknown) {
  const asked: { url?: string; body?: PairRequest } = {};
  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (d: Buffer) => (text += d.toString()));
    req.on("end", () => {
      asked.url = req.url;
      asked.body = JSON.parse(text) as PairRequest;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked, close: () => server.close() };
}

test("a registration code is exchanged for this machine's id and token, kept with the Gasho server's address alone", async () => {
  const hub = await pairServer(200, { deviceId: "m1", name: "ubuntu (2)", token: "secret" });
  try {
    const c = await register(`${hub.url}/somewhere/`, "ABCD-EFGH", "ubuntu");
    assert.equal(hub.asked.url, "/api/pair");
    assert.deepEqual(hub.asked.body, { code: "ABCD-EFGH", kind: "machine", name: "ubuntu" });
    // The name the Gasho server gave (made unique there) is kept.
    assert.deepEqual(c, { server: hub.url, machineId: "m1", token: "secret", name: "ubuntu (2)" });
  } finally {
    hub.close();
  }
});

test("a refused registration says the status and the Gasho server's reason, and an answer without a token is refused", async () => {
  const refused = await pairServer(400, { error: "invalid or expired code" });
  try {
    await assert.rejects(register(refused.url, "WRONG", "ubuntu"), /^Error: registration failed \(400\): invalid or expired code$/);
  } finally {
    refused.close();
  }
  const odd = await pairServer(200, { deviceId: "m1", name: "ubuntu" });
  try {
    await assert.rejects(register(odd.url, "ABCD", "ubuntu"), /^Error: registration failed \(200\)/);
  } finally {
    odd.close();
  }
  const notJson = await pairServer(502, "<html>Bad Gateway</html>");
  try {
    await assert.rejects(register(notJson.url, "ABCD", "ubuntu"), /^Error: registration failed \(502\): Bad Gateway$/);
  } finally {
    notJson.close();
  }
});

/** A stand-in for the Gasho server's /ws/daemon: each connection, with what it was sent, in order. */
async function hubServer() {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => wss.once("listening", resolve));
  const conns: { ws: WebSocket; got: DaemonToHub[] }[] = [];
  wss.on("connection", (ws) => {
    const conn = { ws, got: [] as DaemonToHub[] };
    conns.push(conn);
    ws.on("message", (d) => conn.got.push(JSON.parse(String(d)) as DaemonToHub));
  });
  return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/ws/daemon`, conns, close: () => wss.close() };
}

function client(url: string) {
  const seen = { ready: 0, messages: [] as HubToDaemon[], rejected: [] as string[] };
  const c = new HubClient({
    url,
    hello: () => ({ type: "hello", machineId: "m1", token: "secret", daemonVersion: "0.0.0" }),
    onReady: () => seen.ready++,
    onMessage: (m) => seen.messages.push(m),
    onRejected: (reason) => seen.rejected.push(reason),
  });
  return { c, seen };
}

const hook = (n: number): DaemonToHub => ({ type: "hook", event: { sessionId: "s1", event: "Stop", at: n } });

test("hook events are kept while not connected and sent once welcomed (the latest 500); other messages are not kept", async (t) => {
  const hub = await hubServer();
  try {
    const { c, seen } = client(hub.url);
    for (let n = 0; n < 502; n++) c.send(hook(n));
    c.send({ type: "sessions", sessions: [] });
    c.connect();
    await t.waitFor(() => assert.deepEqual(hub.conns[0]?.got, [{ type: "hello", machineId: "m1", token: "secret", daemonVersion: "0.0.0" }]), WAIT);
    assert.equal(c.connected, false);
    const conn = hub.conns[0];
    assert.ok(conn);
    conn.ws.send(JSON.stringify({ type: "welcome" }));
    await t.waitFor(() => assert.equal(conn.got.length, 501), WAIT);
    assert.equal(seen.ready, 1);
    assert.equal(c.connected, true);
    assert.deepEqual(
      conn.got.slice(1).map((m) => (m.type === "hook" ? m.event.at : -1)),
      Array.from({ length: 500 }, (_, i) => i + 2),
    );

    // Connected, a message goes at once; what the Gasho server sends is handed on, and what is not JSON is not.
    c.send({ type: "sessions", sessions: [] });
    conn.ws.send("not json");
    conn.ws.send(JSON.stringify({ type: "plugins", plugins: [] }));
    await t.waitFor(() => assert.equal(conn.got.at(-1)?.type, "sessions"), WAIT);
    await t.waitFor(() => assert.deepEqual(seen.messages, [{ type: "plugins", plugins: [] }]), WAIT);

    // A revoked registration: no connecting again.
    conn.ws.close(4001, "revoked");
    await t.waitFor(() => assert.deepEqual(seen.rejected, ["revoked"]), WAIT);
    assert.equal(c.connected, false);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(hub.conns.length, 1);
  } finally {
    hub.close();
  }
});

test("a connection that ends otherwise is made again, with hello again", async (t) => {
  const hub = await hubServer();
  try {
    const { c, seen } = client(hub.url);
    c.connect();
    await t.waitFor(() => assert.equal(hub.conns[0]?.got.length, 1), WAIT);
    hub.conns[0]?.ws.send(JSON.stringify({ type: "welcome" }));
    await t.waitFor(() => assert.equal(c.connected, true), WAIT);
    hub.conns[0]?.ws.close(1011, "restarting");
    await t.waitFor(() => assert.equal(c.connected, false), WAIT);
    // Not connected meanwhile: a hook event waits for the next connection.
    c.send(hook(7));
    await t.waitFor(() => assert.equal(hub.conns[1]?.got[0]?.type, "hello"), WAIT);
    hub.conns[1]?.ws.send(JSON.stringify({ type: "welcome" }));
    await t.waitFor(() => assert.deepEqual(hub.conns[1]?.got[1], hook(7)), WAIT);
    assert.equal(seen.ready, 2);
    hub.conns[1]?.ws.close(4001, "");
    await t.waitFor(() => assert.deepEqual(seen.rejected, ["invalid credentials"]), WAIT);
  } finally {
    hub.close();
  }
});
