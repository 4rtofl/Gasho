import assert from "node:assert/strict";
import { test } from "node:test";
import type { HookEvent, PluginStopNotification } from "@gasho/protocol";
import { HookRelay } from "../src/hook-relay.ts";

const hook = (event: string, sessionId = "s1"): HookEvent => ({ sessionId, event, at: 1 });
const flush = () => new Promise((r) => setTimeout(r, 0));

function relay(asks = true) {
  const sent: HookEvent[] = [];
  const answers: ((n?: PluginStopNotification) => void)[] = [];
  const r = new HookRelay({
    send: (e) => sent.push(e),
    asks: () => asks,
    ask: () => new Promise((resolve) => answers.push(resolve)),
    log: () => undefined,
  });
  return { r, sent, answers };
}

test("with no plugin to ask, every hook goes at once", () => {
  const { r, sent } = relay(false);
  r.pass(hook("Stop"));
  r.pass(hook("UserPromptSubmit"));
  assert.deepEqual(sent.map((e) => e.event), ["Stop", "UserPromptSubmit"]);
});

test("a Stop carries what the plugins say, and the session's later hooks wait behind it; other sessions do not", async () => {
  const { r, sent, answers } = relay();
  r.pass(hook("Stop"));
  r.pass(hook("UserPromptSubmit"));
  r.pass(hook("PreToolUse", "s2"));
  await flush();
  assert.deepEqual(sent.map((e) => e.event), ["PreToolUse"]);
  answers[0]?.({ plugin: "p", title: "終わりました" });
  await flush();
  assert.deepEqual(sent.map((e) => e.event), ["PreToolUse", "Stop", "UserPromptSubmit"]);
  assert.deepEqual(sent[1]?.notification, { plugin: "p", title: "終わりました" });
  r.pass(hook("PostToolUse"));
  assert.equal(sent.at(-1)?.event, "PostToolUse");
});

test("a Stop goes without a notification when the plugins say nothing or fail", async () => {
  const sent: HookEvent[] = [];
  const r = new HookRelay({ send: (e) => sent.push(e), asks: () => true, ask: () => Promise.reject(new Error("x")), log: () => undefined });
  r.pass(hook("Stop"));
  await flush();
  assert.equal(sent[0]?.event, "Stop");
  assert.equal(sent[0]?.notification, undefined);
});
