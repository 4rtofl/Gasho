import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { TokenDays, tokenDayOf } from "../src/token-days.ts";
import { TokenCounter, usageOfLine } from "../src/tokens.ts";

const reply = (id: string, at: string, usage: Record<string, number>, extra = "") =>
  `${JSON.stringify({ type: "assistant", timestamp: at, message: { id, model: "claude-opus-5-5", usage, content: [{ type: "text", text: `はい${extra}` }] } })}\n`;

test("a reply's usage is read from its transcript line; other lines record none", () => {
  const line = reply("m1", "2026-11-12T10:15:00Z", { input_tokens: 2, output_tokens: 738, cache_creation_input_tokens: 3101, cache_read_input_tokens: 45541 });
  assert.deepEqual(usageOfLine(line.trim()), {
    id: "m1",
    at: Date.parse("2026-11-12T10:15:00Z"),
    usage: { input: 2, output: 738, cacheWrite: 3101, cacheRead: 45541 },
  });
  assert.equal(usageOfLine(JSON.stringify({ type: "user", message: { usage: {} } })), undefined);
  assert.equal(usageOfLine('{"type":"assistant","usage": broken'), undefined);
});

test("tokens are counted once per reply, across the session's transcript and its subagents', as they are written", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-tokens-"));
  const transcript = path.join(dir, "s1.jsonl");
  const workflow = path.join(dir, "s1", "subagents", "workflows", "wf_1");
  await fs.mkdir(workflow, { recursive: true });
  const u = (input: number, output: number, cacheWrite: number, cacheRead: number) => ({
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: cacheWrite,
    cache_read_input_tokens: cacheRead,
  });
  // A reply written as two records (one per content block) repeats its usage.
  await fs.writeFile(transcript, reply("m1", "2026-11-12T10:15:00Z", u(1, 10, 100, 1000)) + reply("m1", "2026-11-12T10:15:01Z", u(1, 10, 100, 1000)));
  await fs.writeFile(path.join(dir, "s1", "subagents", "agent-a.jsonl"), reply("a1", "2026-11-12T11:00:00Z", u(2, 20, 0, 0)));
  await fs.writeFile(path.join(workflow, "agent-b.jsonl"), reply("b1", "2026-11-12T11:30:00Z", u(3, 30, 0, 300)));
  const c = new TokenCounter(transcript);
  assert.equal(await c.update(), true);
  assert.deepEqual(c.totals(), { input: 6, output: 60, cacheWrite: 100, cacheRead: 1300 });
  assert.equal(await c.update(), false);
  // A reply written in two pieces, split inside a character, counts once the line is whole.
  const more = Buffer.from(reply("m2", "2026-11-12T12:05:00Z", u(4, 40, 0, 0), "（続き）"));
  const cut = more.indexOf(Buffer.from("続")) + 1;
  await fs.appendFile(transcript, more.subarray(0, cut));
  await c.update();
  assert.equal(c.totals().output, 60);
  await fs.appendFile(transcript, more.subarray(cut));
  assert.equal(await c.update(), true);
  assert.equal(c.totals().output, 100);
  // Per hour, within the last 48 hours.
  const hours = c.hours(Date.parse("2026-11-12T12:30:00Z"));
  assert.deepEqual(
    hours.map(([h, x]) => [new Date(h).toISOString().slice(11, 16), x.output]),
    [
      ["10:00", 10],
      ["11:00", 50],
      ["12:00", 40],
    ],
  );
  assert.deepEqual(c.hours(Date.parse("2026-11-15T00:00:00Z")), []);
  await fs.rm(dir, { recursive: true, force: true });
});

test("a fork does not count the replies copied from the session it was forked from", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-tokens-"));
  try {
    const transcript = path.join(dir, "fork.jsonl");
    const u = { input_tokens: 1, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100 };
    // The copy keeps the replies' times; the fork's own replies come after it was forked.
    await fs.writeFile(transcript, reply("m1", "2026-11-13T09:00:00Z", u) + reply("m2", "2026-11-13T09:30:00Z", u) + reply("m3", "2026-11-13T10:05:00Z", u));
    const fork = new TokenCounter(transcript, { since: Date.parse("2026-11-13T10:00:00Z") });
    await fork.update();
    assert.deepEqual(fork.totals(), { input: 1, output: 10, cacheWrite: 0, cacheRead: 100 });
    const whole = new TokenCounter(transcript);
    await whole.update();
    assert.equal(whole.totals().output, 30);
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

test("the tokens per day count each reply once, and the day ends at midnight in Japan", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-tokens-"));
  const transcript = path.join(dir, "s1.jsonl");
  const u = (input: number) => ({ input_tokens: input, output_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 });
  await fs.writeFile(
    transcript,
    // 23:59:59 and 00:00:00 in Japan; the second reply is written as two records.
    reply("m1", "2026-11-17T14:59:59Z", u(10)) + reply("m2", "2026-11-17T15:00:00Z", u(20)) + reply("m2", "2026-11-17T15:00:00Z", u(20)),
  );
  const counter = new TokenCounter(transcript);
  await counter.update();
  assert.deepEqual([...counter.days()], [["2026-11-17", 16], ["2026-11-18", 26]]);
  assert.equal(counter.complete, true);
});

test("a later record of a reply replaces what the day counted", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-tokens-"));
  const transcript = path.join(dir, "s1.jsonl");
  await fs.writeFile(transcript, reply("m1", "2026-11-18T01:00:00Z", { input_tokens: 5 }));
  const counter = new TokenCounter(transcript);
  await counter.update();
  await fs.appendFile(transcript, reply("m1", "2026-11-18T01:00:00Z", { input_tokens: 5, output_tokens: 7 }));
  await counter.update();
  assert.deepEqual([...counter.days()], [["2026-11-18", 12]]);
});

test("a fork's days leave out the conversation it was forked from", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-tokens-"));
  const transcript = path.join(dir, "fork.jsonl");
  await fs.writeFile(transcript, reply("m1", "2026-11-16T01:00:00Z", { input_tokens: 100 }) + reply("m2", "2026-11-18T01:00:00Z", { input_tokens: 3 }));
  const counter = new TokenCounter(transcript, { since: Date.parse("2026-11-17T00:00:00Z") });
  await counter.update();
  assert.deepEqual([...counter.days()], [["2026-11-18", 3]]);
});

const NOW = Date.parse("2026-11-18T03:00:00Z");

test("the day of a moment is that of Japan, whatever the time zone of the server", () => {
  assert.equal(tokenDayOf(Date.parse("2026-11-17T14:59:59.999Z")), "2026-11-17");
  assert.equal(tokenDayOf(Date.parse("2026-11-17T15:00:00Z")), "2026-11-18");
});

test("reading a session's transcripts again replaces its days, and the sessions are added together", () => {
  const days = new TokenDays("/nonexistent/token-days.json");
  days.record("a", new Map([["2026-11-18", 10]]), NOW);
  days.record("a", new Map([["2026-11-18", 10]]), NOW);
  days.record("b", new Map([["2026-11-18", 5]]), NOW);
  assert.deepEqual(days.takeChanged(), [["2026-11-18", 15]]);
  days.record("a", new Map([["2026-11-18", 10]]), NOW);
  assert.deepEqual(days.takeChanged(), []);
  days.record("a", new Map([["2026-11-18", 12]]), NOW);
  assert.deepEqual(days.takeChanged(), [["2026-11-18", 17]]);
});

test("the days stay after a restart, also those of a session whose transcripts are gone", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-token-days-"));
  const file = path.join(dir, "token-days.json");
  const before = new TokenDays(file);
  before.record("removed", new Map([["2026-11-10", 40]]), NOW);
  before.record("kept", new Map([["2026-11-18", 7]]), NOW);
  await before.save(NOW);

  const after = new TokenDays(file);
  await after.load();
  // Read again from its transcript, the session that goes on replaces its day; nothing is counted twice.
  after.record("kept", new Map([["2026-11-18", 9]]), NOW);
  assert.deepEqual(after.all(NOW), [["2026-11-10", 40], ["2026-11-18", 9]]);
  assert.deepEqual(after.takeChanged(), []);
});

test("only the last 371 days are kept and told", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-token-days-"));
  const file = path.join(dir, "token-days.json");
  const days = new TokenDays(file);
  days.record("a", new Map([["2025-11-12", 1], ["2025-11-13", 2]]), NOW);
  assert.deepEqual(days.all(NOW), [["2025-11-13", 2]]);
  await days.save(Date.parse("2026-11-19T03:00:00Z"));
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {});
});
