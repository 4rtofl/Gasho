// Images and videos Claude sent in a session, served to browsers over HTTP (GET /media/…): read from the working
// server part by part, whole or by Range, against a fake gasho-daemon on a real WebSocket.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type { DaemonToHub, HubToDaemon } from "@gasho/protocol";
import { Hub, MAX_MEDIA_PART } from "../src/hub.ts";
import { byteRange } from "../src/media.ts";
import { buildAllowList, parseNets } from "../src/netallow.ts";
import { createServer } from "../src/server.ts";
import { Store } from "../src/store.ts";

const FILE = "/tmp/claude-1000/x/scratchpad/shot.png";
/** The files the fake working server has, and how many parts it was asked for. */
const files = new Map<string, Buffer>();
let asked: Extract<HubToDaemon, { type: "media.get" }>[] = [];
/** What the fake working server answers instead of a file's part, when set. */
let answer: ((m: Extract<HubToDaemon, { type: "media.get" }>) => DaemonToHub) | undefined;

let store: Store;
let hub: Hub;
let server: ReturnType<typeof createServer>;
let base = "";
let cookie = "";
let machineId = "";
let daemon: WebSocket;

before(async () => {
  store = new Store(":memory:");
  hub = new Hub(store);
  server = createServer({ hub, store, webDist: "/nonexistent", allow: buildAllowList(parseNets(undefined)) });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = store.createDevice("browser", "iPhone");
  cookie = `gasho_device=${browser.device.id}.${browser.token}`;
  const machine = store.createDevice("machine", "ubuntu");
  machineId = machine.device.id;
  daemon = new WebSocket(`${base.replace("http", "ws")}/ws/daemon`);
  await new Promise<void>((resolve) => {
    daemon.addEventListener("open", () => daemon.send(JSON.stringify({ type: "hello", machineId, token: machine.token, daemonVersion: "0.18.0" })));
    daemon.addEventListener("message", (ev) => {
      const m = JSON.parse(String(ev.data)) as HubToDaemon;
      if (m.type === "welcome") resolve();
      if (m.type !== "media.get") return;
      asked.push(m);
      const reply = answer?.(m) ?? partOf(m);
      daemon.send(JSON.stringify(reply));
    });
  });
});

after(() => {
  daemon.close();
  server.closeAllConnections();
  server.close();
});

function partOf(m: Extract<HubToDaemon, { type: "media.get" }>): DaemonToHub {
  const bytes = m.sessionId === "s1" ? files.get(m.path) : undefined;
  if (!bytes) return { type: "media", requestId: m.requestId, error: "ファイルがありません。", notFound: true };
  const data = bytes.subarray(m.offset, m.offset + m.length).toString("base64");
  return { type: "media", requestId: m.requestId, media: { mime: "image/png", size: bytes.length, mtime: 1_700_000_000_000, offset: m.offset, data } };
}

const url = (file = FILE, session = "s1") => `${base}/media/${machineId}/${session}?path=${encodeURIComponent(file)}`;
const get = (headers: Record<string, string> = {}, file?: string) => fetch(url(file), { headers: { cookie, ...headers } });

test("only a registered browser gets a file, and only by GET or HEAD", async () => {
  files.set(FILE, Buffer.from("PNG!"));
  assert.equal((await fetch(url())).status, 401);
  assert.equal((await fetch(url(), { method: "POST", headers: { cookie } })).status, 405);
  assert.equal((await fetch(`${base}/media/${machineId}?path=x`, { headers: { cookie } })).status, 404);
});

test("the whole file, with its type, size and version", async () => {
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
  files.set(FILE, bytes);
  const res = await get();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("content-length"), "5000");
  assert.equal(res.headers.get("accept-ranges"), "bytes");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("content-disposition"), "inline; filename*=UTF-8''shot.png");
  assert.equal(res.headers.get("content-security-policy"), null);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  // Asked again with its version: not sent again.
  const etag = res.headers.get("etag") ?? "";
  assert.match(etag, /^"[0-9a-z]+-[0-9a-z]+"$/);
  const again = await get({ "if-none-match": etag });
  assert.equal(again.status, 304);
  // HEAD: only what it is.
  asked = [];
  const head = await fetch(url(), { method: "HEAD", headers: { cookie } });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "5000");
  assert.deepEqual(
    asked.map((m) => m.length),
    [0],
  );
});

test("a Range gets that part of the file; a suffix the end of it; one beyond the file is refused", async () => {
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  files.set(FILE, bytes);
  const part = await get({ range: "bytes=10-19" });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), "bytes 10-19/1000");
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(10, 20));
  const open = await get({ range: "bytes=990-" });
  assert.equal(open.headers.get("content-range"), "bytes 990-999/1000");
  assert.deepEqual(Buffer.from(await open.arrayBuffer()), bytes.subarray(990));
  const suffix = await get({ range: "bytes=-5" });
  assert.equal(suffix.headers.get("content-range"), "bytes 995-999/1000");
  assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(995));
  const beyond = await get({ range: "bytes=1000-" });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers.get("content-range"), "bytes */1000");
  // Safari's first ask for a video.
  const probe = await get({ range: "bytes=0-1" });
  assert.equal(probe.status, 206);
  assert.deepEqual(Buffer.from(await probe.arrayBuffer()), bytes.subarray(0, 2));
  // If-Range for another version: the whole file.
  const changed = await get({ range: "bytes=0-1", "if-range": '"old"' });
  assert.equal(changed.status, 200);
  assert.equal((await changed.arrayBuffer()).byteLength, 1000);
});

test("a large file is read from the working server part by part", async () => {
  const bytes = Buffer.alloc(MAX_MEDIA_PART * 2 + 12345);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 256;
  files.set(FILE, bytes);
  asked = [];
  const res = await get();
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  assert.deepEqual(
    asked.map((m) => [m.offset, m.length]),
    [
      [0, 0],
      [0, MAX_MEDIA_PART],
      [MAX_MEDIA_PART, MAX_MEDIA_PART],
      [MAX_MEDIA_PART * 2, 12345],
    ],
  );
});

test("what the working server cannot give is answered with why", async () => {
  const gone = await get({}, "/tmp/none.png");
  assert.equal(gone.status, 404);
  assert.equal(await gone.text(), "ファイルがありません。");
  const offline = await fetch(`${base}/media/other-machine/s1?path=${encodeURIComponent(FILE)}`, { headers: { cookie } });
  assert.equal(offline.status, 503);
  assert.equal((await fetch(url("relative.png"), { headers: { cookie } })).status, 400);
  // A working server that answers with another type of file than an image or a video is not passed on.
  answer = (m) => ({ type: "media", requestId: m.requestId, media: { mime: "text/html", size: 4, mtime: 1, offset: m.offset, data: "" } });
  try {
    assert.equal((await get()).status, 502);
  } finally {
    answer = undefined;
  }
});

test("a file that changes while it is sent is cut off, not sent in parts of two versions", async () => {
  const bytes = Buffer.alloc(MAX_MEDIA_PART + 10, 1);
  files.set(FILE, bytes);
  let n = 0;
  answer = (m) => {
    const r = partOf(m);
    // The second part comes from a newer version of the file.
    if (r.type === "media" && r.media && n++ === 2) r.media.mtime += 1;
    return r;
  };
  try {
    const res = await get();
    assert.equal(res.status, 200);
    await assert.rejects(res.arrayBuffer());
  } finally {
    answer = undefined;
  }
});

test("byteRange reads one range of bytes; several, or one it does not understand, mean the whole file", () => {
  assert.deepEqual(byteRange("bytes=0-499", 1000), { start: 0, end: 499 });
  assert.deepEqual(byteRange("bytes=500-", 1000), { start: 500, end: 999 });
  assert.deepEqual(byteRange("bytes=900-2000", 1000), { start: 900, end: 999 });
  assert.deepEqual(byteRange("bytes=-100", 1000), { start: 900, end: 999 });
  assert.deepEqual(byteRange("bytes=-2000", 1000), { start: 0, end: 999 });
  assert.equal(byteRange("bytes=1000-", 1000), "unsatisfiable");
  assert.equal(byteRange("bytes=-0", 1000), "unsatisfiable");
  assert.equal(byteRange("bytes=0-", 0), "unsatisfiable");
  assert.equal(byteRange(undefined, 1000), undefined);
  assert.equal(byteRange("bytes=0-1,5-6", 1000), undefined);
  assert.equal(byteRange("bytes=5-1", 1000), undefined);
  assert.equal(byteRange("items=0-1", 1000), undefined);
  assert.equal(byteRange("bytes=-", 1000), undefined);
});
