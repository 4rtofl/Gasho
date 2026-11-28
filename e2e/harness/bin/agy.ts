#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import assert from "node:assert/strict";
import { appendFileSync, readSync, writeSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

const args = process.argv.slice(2);
const log = process.env.GASHO_TEST_ACP_LOG;
if (log) appendFileSync(log, JSON.stringify({ args }) + "\n");
if (args.length === 1 && args[0] === "--version") {
  writeSync(1, "Antigravity CLI 1.2.3\n");
  process.exit(0);
}

assert.deepEqual(args, ["acp"]);
const mode = process.env.GASHO_TEST_ACP_MODE;
const sessionId = "fake-acp-session";
let turn: { id: number; text: string } | undefined;
let model = "gemini-test";
let effort = "baseline";
const configOptions = () => mode === "no-config" ? {} : { configOptions: [
  { id: "engine", name: "Model", type: "select", category: "model", currentValue: model, options: [
    { group: "gemini", name: "Gemini", options: [
      { value: "gemini-test", name: "Gemini Test" },
      { value: "gemini-test-pro", name: "Gemini Test Pro" },
      { value: "unavailable-test", name: "Unavailable Test" },
    ] },
  ] },
  { id: "thinking", name: "Thinking level", type: "select", category: "thought_level", currentValue: effort, options: [
    { value: "baseline", name: "Baseline" },
    model === "gemini-test-pro" ? { value: "extra-pro", name: "Extra Pro" } : { value: "extra-fast", name: "Extra Fast" },
  ] },
] };
const send = (value: object) => writeSync(1, JSON.stringify({ jsonrpc: "2.0", ...value }) + "\n");
const result = (id: number, value: object = {}) => send({ id, result: value });
const chunk = (sessionUpdate: string, text: string) => send({
  method: "session/update",
  params: { sessionId, update: { sessionUpdate, content: { type: "text", text } } },
});
const finish = (reply: string) => {
  assert.ok(turn);
  chunk("agent_message_chunk", "偽 ACP の");
  chunk("agent_message_chunk", reply);
  result(turn.id, { stopReason: "end_turn" });
  turn = undefined;
};

function* lines(): Generator<string> {
  const buffer = Buffer.alloc(4096);
  const decoder = new StringDecoder("utf8");
  let rest = "";
  for (let size = readSync(0, buffer); size > 0; size = readSync(0, buffer)) {
    const parts = (rest + decoder.write(buffer.subarray(0, size))).split("\n");
    rest = parts.pop()!;
    yield* parts;
  }
}

for (const line of lines()) {
  const m = JSON.parse(line);
  if (log) appendFileSync(log, line + "\n");
  switch (m.method) {
    case "initialize":
      assert.deepEqual(m.params, { protocolVersion: 1, clientCapabilities: {} });
      result(m.id, {
        protocolVersion: 1,
        agentCapabilities: mode === "none" ? {} : mode?.startsWith("resume") ? { sessionCapabilities: { resume: {} } } : { loadSession: true },
      });
      break;
    case "session/new":
      assert.deepEqual(m.params, { cwd: process.cwd(), mcpServers: [] });
      if (mode === "auth") send({ id: m.id, error: { code: -32000, message: "Authentication required" } });
      else result(m.id, { sessionId, ...configOptions() });
      break;
    case "session/load":
    case "session/resume":
      assert.deepEqual(m.params, { cwd: process.cwd(), mcpServers: [], sessionId });
      if (m.method === "session/load") {
        chunk("user_message_chunk", "前の発言");
        chunk("agent_message_chunk", "前の応答");
      }
      if (mode?.endsWith("-different-model")) model = "gemini-test-pro";
      result(m.id, configOptions());
      break;
    case "session/set_config_option": {
      assert.equal(m.params.sessionId, sessionId);
      assert.equal(turn, undefined);
      const value = m.params.value;
      if (m.params.configId === "engine") {
        if (value === "unavailable-test") {
          send({ id: m.id, error: { code: -32602, message: "このモデルは現在使えません。" } });
          break;
        }
        assert.ok(["gemini-test", "gemini-test-pro"].includes(value));
        model = value;
        effort = "baseline";
      } else {
        assert.equal(m.params.configId, "thinking");
        assert.ok(["baseline", model === "gemini-test-pro" ? "extra-pro" : "extra-fast"].includes(value));
        effort = value;
      }
      result(m.id, configOptions());
      break;
    }
    case "session/prompt":
      assert.equal(turn, undefined);
      assert.equal(m.params.sessionId, sessionId);
      assert.equal(m.params.prompt.length, 1);
      assert.equal(m.params.prompt[0].type, "text");
      turn = { id: m.id, text: m.params.prompt[0].text };
      if (turn.text.startsWith("権限")) {
        send({
          id: "ask",
          method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: "tool", title: "ファイルを書く", rawInput: { path: "example.txt" } },
            options: [
              { kind: "allow_always", optionId: "always", name: "Always allow" },
              { kind: "allow_once", optionId: "allow", name: "Allow once" },
              { kind: "reject_once", optionId: "deny", name: "Reject once" },
            ],
          },
        });
      } else if (turn.text === "通知を試す") {
        finish("通知試験");
        effort = "extra-fast";
        send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "config_option_update", ...configOptions() } } });
      } else if (turn.text !== "割り込み試験") finish(`応答：${turn.text.trim()}`);
      break;
    case "session/cancel":
      assert.ok(turn);
      assert.deepEqual(m.params, { sessionId });
      result(turn.id, { stopReason: "cancelled" });
      turn = undefined;
      break;
    case undefined:
      assert.equal(m.id, "ask");
      assert.notEqual(m.result.outcome.optionId, "always");
      if (turn?.text === "権限の確認後に切断") process.exit(1);
      if (turn) finish(m.result.outcome.optionId === "allow" ? "許可を受けました" : "拒否を受けました");
      break;
    default:
      assert.fail(`unexpected ACP method: ${m.method}`);
  }
}
