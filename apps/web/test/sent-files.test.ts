import assert from "node:assert/strict";
import { test } from "node:test";
import type { SentFile, TranscriptEntry } from "@gasho/protocol";
import { fileName, mediaUrl, sentFilesLayout } from "../src/lib/sent-files.ts";
import { transcriptItems } from "../src/lib/transcript-items.ts";

test("an image or a video is read through the Gasho server, by the session and the file's path", () => {
  assert.equal(
    mediaUrl("m-1", "s 1", "/tmp/claude-1000/x/ショット #1.png"),
    "/media/m-1/s%201?path=%2Ftmp%2Fclaude-1000%2Fx%2F%E3%82%B7%E3%83%A7%E3%83%83%E3%83%88%20%231.png",
  );
  assert.equal(fileName("/tmp/x/shot.png"), "shot.png");
  assert.equal(fileName("shot.png"), "shot.png");
  assert.equal(fileName("/"), "/");
});

test("images and videos are shown as they are, unless Claude offered them as files; the others go by name", () => {
  const png: SentFile = { path: "/w/a.png", kind: "image" };
  const mp4: SentFile = { path: "/w/b.mp4", kind: "video" };
  const md: SentFile = { path: "/w/c.md", kind: "file" };
  assert.deepEqual(sentFilesLayout([png, md, mp4], false), { shown: [png, mp4], listed: [md], viewable: [png, mp4] });
  // Offered as files: listed, but still opened in the viewer.
  assert.deepEqual(sentFilesLayout([png, md, mp4], true), { shown: [], listed: [png, md, mp4], viewable: [png, mp4] });
});

test("files Claude sent break a row of tool calls, and their result is not shown on its own", () => {
  const call = (id: string): TranscriptEntry => ({ uuid: `u-${id}`, role: "assistant", blocks: [{ type: "tool_use", id, name: "Bash", input: "{}" }] });
  const result = (id: string): TranscriptEntry => ({ uuid: `r-${id}`, role: "user", blocks: [{ type: "tool_result", toolUseId: id, content: "", isError: false }] });
  const sent: TranscriptEntry = {
    uuid: "f",
    role: "assistant",
    blocks: [{ type: "tool_use", id: "f1", name: "SendUserFile", input: "{}", sent: { files: [{ path: "/w/a.png", kind: "image" }] } }],
  };
  const calls = new Set(["a", "b", "c", "f1"]);
  const items = transcriptItems([call("a"), result("a"), call("b"), result("b"), sent, result("f1"), call("c"), result("c")], 0, (id) => Boolean(id && calls.has(id)));
  assert.deepEqual(
    items.map((i) => (i.kind === "tools" ? `tools:${i.calls.map((c) => c.id).join(",")}` : `${i.kind}:${i.key}`)),
    ["tools:a,b", "entry:f", "entry:u-c"],
  );
});
