import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptEntry } from "@gasho/protocol";
import { takePage } from "../src/lib/transcript-page.ts";

const entry = (i: number): TranscriptEntry => ({
  uuid: `u${i}`,
  ts: new Date(Date.UTC(2026, 10, 17, 0, 0, i)).toISOString(),
  role: "user",
  blocks: [{ type: "text", text: `#${i}` }],
});
const range = (from: number, to: number): TranscriptEntry[] => Array.from({ length: to - from }, (_, k) => entry(from + k));
const uuids = (entries: TranscriptEntry[]): string[] => entries.map((e) => e.uuid);

test("the latest page after a new connection keeps the older entries the reader scrolled up to", () => {
  // Entries 100–259 loaded (older pages read by scrolling up); 10 came while the connection was down.
  const cur = { entries: range(100, 260), start: 100, total: 260, loading: true };
  const t = takePage(cur, { entries: range(190, 270), start: 190, total: 270 });
  assert.deepEqual(uuids(t.entries), uuids(range(100, 270)));
  assert.equal(t.start, 100);
  assert.equal(t.total, 270);
});

test("the latest page joins right after what is loaded", () => {
  const cur = { entries: range(100, 190), start: 100, total: 190, loading: true };
  const t = takePage(cur, { entries: range(190, 270), start: 190, total: 270 });
  assert.deepEqual(uuids(t.entries), uuids(range(100, 270)));
  assert.equal(t.start, 100);
});

test("the latest page that does not reach what is loaded replaces it", () => {
  // More came meanwhile than a page holds: keeping the older entries would leave a hole.
  const cur = { entries: range(100, 180), start: 100, total: 180, loading: true };
  const t = takePage(cur, { entries: range(190, 270), start: 190, total: 270 });
  assert.deepEqual(uuids(t.entries), uuids(range(190, 270)));
  assert.equal(t.start, 190);
});

test("the latest page joins at its first entry even when the indexes loaded are off", () => {
  // One entry is missing from what is loaded, so its indexes after it are one short.
  const cur = { entries: [...range(100, 150), ...range(151, 261)], start: 100, total: 259, loading: true };
  const t = takePage(cur, { entries: range(190, 270), start: 190, total: 270 });
  assert.deepEqual(uuids(t.entries), uuids([...range(100, 150), ...range(151, 270)]));
});

test("live entries that came after the latest page was read stay below it", () => {
  const cur = { entries: range(100, 272), start: 100, total: 272, loading: true };
  const t = takePage(cur, { entries: range(190, 270), start: 190, total: 270 });
  assert.deepEqual(uuids(t.entries), uuids(range(100, 272)));
  assert.equal(t.total, 272);
});
