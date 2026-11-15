// Files Claude sends to the person (Claude Code's SendUserFile): shown in the conversation as files, not as a tool call,
// and the images and videos among them read part by part for the Gasho screen, only those the conversation sent.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DaemonToHub, TranscriptBlock } from "@gasho/protocol";
import { Daemon } from "../src/daemon.ts";
import { MAX_MEDIA_PART, readMediaPart, sentFileKind, sentFiles } from "../src/media.ts";
import { emptyMeta, parseRecord } from "../src/transcript.ts";

/** A call of SendUserFile as Claude Code 2.1.318 records it. */
function sendCall(id: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: `a-${id}`,
    cwd: "/home/rg/repos/Gasho",
    timestamp: "2026-11-15T09:00:00.000Z",
    message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "SendUserFile", input }] },
    ...extra,
  };
}

/** The files a block says its call sent (`sent`), or undefined. */
const sentBy = (b: TranscriptBlock | undefined) => (b?.type === "tool_use" ? b.sent : undefined);

test("a call of SendUserFile says which files it sent, what each is shown as, and Claude's caption", () => {
  const meta = emptyMeta();
  const e = parseRecord(
    sendCall("toolu_1", {
      files: ["/tmp/claude-1000/x/scratchpad/shots/01-menu.png", "docs/demo.mp4", "report.md", "../up/./a.webp"],
      caption: "  テスト用の Gasho で撮った画面  ",
      status: "normal",
      display: "render",
    }),
    meta,
  );
  assert.equal(e?.role, "assistant");
  // Still a tool call, which a screen from before shows as one.
  const [b] = e?.blocks ?? [];
  assert.ok(b?.type === "tool_use" && b.id === "toolu_1" && b.name === "SendUserFile" && b.input.includes("01-menu.png"));
  assert.deepEqual(sentBy(b), {
    files: [
      { path: "/tmp/claude-1000/x/scratchpad/shots/01-menu.png", kind: "image" },
      // A path from the folder Claude worked in is made absolute.
      { path: "/home/rg/repos/Gasho/docs/demo.mp4", kind: "video" },
      { path: "/home/rg/repos/Gasho/report.md", kind: "file" },
      { path: "/home/rg/repos/up/a.webp", kind: "image" },
    ],
    caption: "テスト用の Gasho で撮った画面",
  });
  // Only its images and videos may be read for the screen.
  assert.deepEqual(
    [...(meta.sentFiles ?? [])],
    ["/tmp/claude-1000/x/scratchpad/shots/01-menu.png", "/home/rg/repos/Gasho/docs/demo.mp4", "/home/rg/repos/up/a.webp"],
  );
  // It is a tool call all the same: open until its result comes.
  assert.deepEqual(
    meta.openCalls?.map((c) => c.toolUseId),
    ["toolu_1"],
  );
  parseRecord(
    {
      type: "user",
      uuid: "r1",
      message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "4 files delivered to user." }] },
    },
    meta,
  );
  assert.equal(meta.openCalls, undefined);
});

test("files Claude asked to offer as files are marked so; a call of another shape is only a tool call", () => {
  const meta = emptyMeta();
  const attach = parseRecord(sendCall("t1", { files: ["/w/out.png"], status: "normal", display: "attach" }), meta);
  assert.deepEqual(sentBy(attach?.blocks[0]), { files: [{ path: "/w/out.png", kind: "image" }], attach: true });
  for (const input of [{ files: [] }, { files: "/w/a.png" }, { files: [1] }, { path: "/w/a.png" }]) {
    const e = parseRecord(sendCall("t2", input), meta);
    assert.equal(e?.blocks[0]?.type, "tool_use", JSON.stringify(input));
    assert.equal(sentBy(e?.blocks[0]), undefined, JSON.stringify(input));
  }
  // A relative path without the folder it is from cannot be found: it is listed as given, never read.
  const lost = parseRecord(sendCall("t3", { files: ["shot.png"] }, { cwd: undefined }), meta);
  assert.deepEqual(sentBy(lost?.blocks[0]), { files: [{ path: "shot.png", kind: "file" }] });
  // Another tool of that name from a subagent's or the person's side is not Claude sending files to the person.
  const other = parseRecord({ type: "user", uuid: "u", message: { content: [{ type: "tool_use", id: "t4", name: "SendUserFile", input: { files: ["/w/x.png"] } }] } }, meta);
  assert.equal(sentBy(other?.blocks[0]), undefined);
  assert.deepEqual([...(meta.sentFiles ?? [])], ["/w/out.png"]);
});

test("what a sent file is shown as goes by its extension", () => {
  assert.equal(sentFileKind("/a/B.PNG"), "image");
  assert.equal(sentFileKind("/a/b.jpeg"), "image");
  assert.equal(sentFileKind("/a/b.svg"), "image");
  assert.equal(sentFileKind("/a/b.mov"), "video");
  assert.equal(sentFileKind("/a/b.webm"), "video");
  assert.equal(sentFileKind("/a/b.html"), "file");
  assert.equal(sentFileKind("/a/png"), "file");
  assert.equal(sentFiles({ files: ["/a/b.png"] }, undefined)?.[0]?.kind, "image");
});

test("a part of an image is read from where it is asked, up to the end of the file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-media-"));
  try {
    const file = path.join(dir, "shot.png");
    const bytes = Buffer.from(Array.from({ length: 300 }, (_, i) => i % 256));
    await fs.writeFile(file, bytes);
    const part = await readMediaPart(file, 100, 50);
    assert.ok(!("error" in part));
    assert.equal(part.mime, "image/png");
    assert.equal(part.size, 300);
    assert.equal(part.offset, 100);
    assert.deepEqual(Buffer.from(part.data, "base64"), bytes.subarray(100, 150));
    // Only what the file is, and the end of it.
    const stat = await readMediaPart(file, 0, 0);
    assert.ok(!("error" in stat) && stat.data === "" && stat.size === 300);
    const tail = await readMediaPart(file, 280, 50);
    assert.ok(!("error" in tail) && Buffer.from(tail.data, "base64").length === 20);
    const beyond = await readMediaPart(file, 400, 10);
    assert.ok(!("error" in beyond) && beyond.data === "");

    assert.deepEqual(await readMediaPart(path.join(dir, "gone.png"), 0, 10), { error: "ファイルがありません（消されたか、移された）。", notFound: true });
    // Neither a file of another type, nor more than a part, nor a range before the start, nor a relative path.
    await fs.writeFile(path.join(dir, "notes.txt"), "x");
    assert.ok("error" in (await readMediaPart(path.join(dir, "notes.txt"), 0, 10)));
    assert.ok("error" in (await readMediaPart(file, 0, MAX_MEDIA_PART + 1)));
    assert.ok("error" in (await readMediaPart(file, -1, 10)));
    assert.ok("error" in (await readMediaPart("shot.png", 0, 10)));
    await fs.mkdir(path.join(dir, "dir.png"));
    assert.ok("error" in (await readMediaPart(path.join(dir, "dir.png"), 0, 10)));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("the daemon reads only the images and videos that the session's conversation sent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-media-"));
  const sent: DaemonToHub[] = [];
  try {
    const d = new Daemon({
      hubUrl: "ws://127.0.0.1:1",
      machineId: "m",
      token: "t",
      hookPort: 0,
      claudeDir: path.join(dir, "claude"),
      claudeBin: "/bin/false",
      pollIntervalMs: 60_000,
      stateDir: dir,
      attachmentsDir: path.join(dir, "attachments"),
    } as ConstructorParameters<typeof Daemon>[0]) as unknown as Record<string, any>;
    d.hub = { send: (m: DaemonToHub) => sent.push(m) };
    const shot = path.join(dir, "shot.png");
    const other = path.join(dir, "other.png");
    await fs.writeFile(shot, "PNG!");
    await fs.writeFile(other, "PNG?");
    const meta = emptyMeta();
    parseRecord(sendCall("t1", { files: [shot], status: "normal" }, { cwd: dir }), meta);
    d.tracked.set("s1", { info: { sessionId: "s1", cwd: dir, status: "idle", rcMode: "none", prLinks: [] }, meta });

    const ask = async (sessionId: string, file: string) => {
      await d.onHubMessage({ type: "media.get", requestId: `r${sent.length}`, sessionId, path: file, offset: 0, length: 100 });
      return sent.at(-1);
    };
    const ok = await ask("s1", shot);
    assert.ok(ok?.type === "media" && ok.media);
    assert.equal(Buffer.from(ok.media.data, "base64").toString(), "PNG!");
    // Another image next to it was not sent, and another session has no such file.
    const notSent = await ask("s1", other);
    assert.ok(notSent?.type === "media" && !notSent.media && /送った画像や動画ではありません/.test(notSent.error ?? ""));
    const noSession = await ask("s2", shot);
    assert.ok(noSession?.type === "media" && noSession.notFound === true);
    // Sent, then deleted.
    await fs.rm(shot);
    const gone = await ask("s1", shot);
    assert.ok(gone?.type === "media" && gone.notFound === true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
