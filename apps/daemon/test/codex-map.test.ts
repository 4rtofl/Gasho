// What Codex's app-server says, in Gasho's terms.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type CodexItem,
  entriesOfItem,
  entriesOfTurnEnd,
  lastAgentText,
  replyOf,
  requestOf,
  sessionStatusOf,
  transcriptOf,
} from "../src/codex-map.ts";
import { codexSocketOf } from "../src/codex.ts";

const command = (extra: Partial<CodexItem> = {}): CodexItem => ({
  type: "commandExecution",
  id: "exec-1",
  command: "touch a.txt",
  status: "completed",
  aggregatedOutput: "done",
  exitCode: 0,
  startedAtMs: 1_000,
  completedAtMs: 2_000,
  ...extra,
});

test("a thread's status: an answer waited for is waiting, and work without one is busy", () => {
  assert.equal(sessionStatusOf({ type: "idle" }), "idle");
  assert.equal(sessionStatusOf({ type: "active", activeFlags: [] }), "busy");
  assert.equal(sessionStatusOf({ type: "active", activeFlags: ["waitingOnApproval"] }), "waiting");
  assert.equal(sessionStatusOf({ type: "active", activeFlags: ["waitingOnUserInput"] }), "waiting");
  assert.equal(sessionStatusOf({ type: "systemError" }), "idle");
  assert.equal(sessionStatusOf({ type: "notLoaded" }), "unknown");
  assert.equal(sessionStatusOf(undefined), "unknown");
});

test("what the person and the agent say are the conversation's text; reasoning is not shown", () => {
  const user = { type: "userMessage", id: "u1", content: [{ type: "text", text: "こんにちは" }, { type: "localImage", path: "/x.png" }], startedAtMs: 1_000 };
  assert.deepEqual(entriesOfItem(user, "completed"), [
    { uuid: "u1", ts: new Date(1_000).toISOString(), role: "user", blocks: [{ type: "text", text: "こんにちは" }] },
  ]);
  assert.deepEqual(entriesOfItem(user, "started"), []);
  const said = entriesOfItem({ type: "agentMessage", id: "m1", text: "はい" }, "completed");
  assert.deepEqual(said, [{ uuid: "m1", role: "assistant", blocks: [{ type: "text", text: "はい" }] }]);
  assert.deepEqual(entriesOfItem({ type: "agentMessage", id: "m2", text: "" }, "completed"), []);
  assert.deepEqual(entriesOfItem({ type: "reasoning", id: "r1", summary: ["…"] }, "completed"), []);
});

test("a command shows as a call when it starts, and with its result when it ends", () => {
  const started = entriesOfItem(command({ status: "inProgress" }), "started");
  assert.equal(started.length, 1);
  assert.deepEqual(started[0]?.blocks, [{ type: "tool_use", id: "exec-1", name: "Bash", input: '{"command":"touch a.txt"}' }]);
  const [use, result] = entriesOfItem(command(), "completed");
  assert.equal(use?.uuid, started[0]?.uuid);
  assert.equal(result?.role, "user");
  assert.deepEqual(result?.blocks, [{ type: "tool_result", toolUseId: "exec-1", content: "done", isError: false }]);
});

test("a command that failed, or was declined, is an error", () => {
  const isError = (item: CodexItem) => {
    const b = entriesOfItem(item, "completed")[1]?.blocks[0];
    return b?.type === "tool_result" && b.isError;
  };
  assert.equal(isError(command({ exitCode: 1 })), true);
  assert.equal(isError(command({ status: "declined", exitCode: null, aggregatedOutput: null })), true);
  assert.equal(isError(command({ status: "failed", exitCode: null })), true);
  assert.equal(isError(command({ exitCode: null })), false);
});

test("a file change is an apply_patch call with the files it changes", () => {
  const item = { type: "fileChange", id: "p1", status: "completed", changes: [{ path: "a.txt", kind: { type: "update" }, diff: "+1" }] };
  const [use, result] = entriesOfItem(item, "completed");
  const b = use?.blocks[0];
  assert.ok(b?.type === "tool_use");
  assert.equal(b.name, "apply_patch");
  assert.deepEqual(JSON.parse(b.input), { changes: [{ path: "a.txt", kind: "update", diff: "+1" }] });
  assert.deepEqual(result?.blocks, [{ type: "tool_result", toolUseId: "p1", content: "a.txt", isError: false }]);
});

test("any other item is a call named after its kind", () => {
  const [e] = entriesOfItem({ type: "webSearch", id: "w1", query: "gasho", startedAtMs: 5 }, "completed");
  const b = e?.blocks[0];
  assert.equal(e?.uuid, "w1");
  assert.ok(b?.type === "tool_use");
  assert.equal(b.name, "webSearch");
  assert.deepEqual(JSON.parse(b.input), { query: "gasho" });
  assert.deepEqual(entriesOfItem({ type: "webSearch", id: "w1" }, "started"), []);
});

test("an interrupted turn leaves its mark, a failed one its error, and a completed one nothing", () => {
  const [mark] = entriesOfTurnEnd({ id: "t1", status: "interrupted", completedAt: 3 });
  assert.equal(mark?.interrupted, true);
  assert.equal(mark?.uuid, "t1:interrupted");
  assert.equal(mark?.ts, new Date(3000).toISOString());
  const [failed] = entriesOfTurnEnd({ id: "t2", status: "failed", error: { message: "usage limit" } });
  assert.deepEqual(failed?.blocks, [{ type: "text", text: "usage limit" }]);
  assert.deepEqual(entriesOfTurnEnd({ id: "t3", status: "completed" }), []);
});

test("a conversation is read turn by turn, in order", () => {
  const entries = transcriptOf(
    [
      { id: "t1", status: "completed" },
      { id: "t2", status: "interrupted" },
    ],
    [
      { turnId: "t1", item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "1" }] } },
      { turnId: "t1", item: { type: "agentMessage", id: "m1", text: "2" } },
      { turnId: "t2", item: { type: "userMessage", id: "u2", content: [{ type: "text", text: "3" }] } },
      { turnId: "t2", item: { type: "reasoning", id: "r1" } },
    ],
  );
  assert.deepEqual(entries.map((e) => e.uuid), ["u1", "m1", "u2", "t2:interrupted"]);
});

test("the last thing the agent said is the turn's summary", () => {
  assert.equal(lastAgentText([{ type: "agentMessage", id: "1", text: "a" }, { type: "reasoning", id: "2" }, { type: "agentMessage", id: "3", text: "b" }]), "b");
  assert.equal(lastAgentText([]), undefined);
  assert.equal(lastAgentText(undefined), undefined);
});

const commandRequest = (params: Record<string, unknown> = {}) => {
  const r = requestOf(7, "item/commandExecution/requestApproval", { threadId: "t", command: "touch a.txt", cwd: "/w", ...params }, undefined, 100);
  assert.ok(r);
  return r;
};

test("a command's approval: allow, deny, and always with what Codex proposes", () => {
  const r = commandRequest({ proposedExecpolicyAmendment: ["touch", "a.txt"] });
  assert.equal(r.info.id, "codex-7");
  assert.equal(r.info.toolName, "Bash");
  assert.equal(r.info.summary, "touch a.txt");
  assert.equal(r.info.always, "touch a.txt");
  assert.deepEqual(replyOf(r, "allow", undefined), { result: { decision: "accept" } });
  assert.deepEqual(replyOf(r, "deny", undefined), { result: { decision: "decline" } });
  assert.deepEqual(replyOf(r, "always", undefined), { result: { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["touch", "a.txt"] } } } });
});

test("without a proposal, always is not offered and cannot be answered", () => {
  const r = commandRequest();
  assert.equal(r.info.always, undefined);
  assert.ok("error" in replyOf(r, "always", undefined));
});

test("a file change's approval says what the change is, from the item as it started", () => {
  const item = { type: "fileChange", id: "p1", status: "inProgress", changes: [{ path: "a.txt", kind: { type: "add" }, diff: "+x" }] };
  const r = requestOf("f", "item/fileChange/requestApproval", { threadId: "t", itemId: "p1", reason: "write" }, item, 100);
  assert.ok(r);
  assert.equal(r.info.toolName, "apply_patch");
  assert.equal(r.info.summary, "a.txt");
  assert.match(r.info.input, /"reason": "write"/);
  assert.equal(r.info.always, undefined);
  assert.deepEqual(replyOf(r, "allow", undefined), { result: { decision: "accept" } });
  assert.deepEqual(replyOf(r, "deny", undefined), { result: { decision: "decline" } });
  assert.ok("error" in replyOf(r, "always", undefined));
});

test("a request for more permissions grants what it asks for this turn, or nothing", () => {
  const permissions = { network: { enabled: true }, fileSystem: null };
  const r = requestOf(1, "item/permissions/requestApproval", { threadId: "t", cwd: "/w", reason: "needs network", permissions }, undefined, 100);
  assert.ok(r);
  assert.equal(r.info.summary, "needs network");
  assert.deepEqual(replyOf(r, "allow", undefined), { result: { permissions: { network: { enabled: true } }, scope: "turn" } });
  assert.deepEqual(replyOf(r, "deny", undefined), { result: { permissions: {}, scope: "turn" } });
});

test("a question of Codex is a question card, and its answers go back by the question's id", () => {
  const questions = [
    { id: "q1", header: "進め方", question: "どちらにしますか？", isOther: true, isSecret: false, options: [{ label: "A", description: "先に" }, { label: "B", description: "" }] },
    { id: "q2", header: "", question: "名前は？", isOther: true, isSecret: false, options: null },
  ];
  const r = requestOf(2, "item/tool/requestUserInput", { threadId: "t", questions }, undefined, 100);
  assert.ok(r);
  assert.equal(r.info.toolName, "AskUserQuestion");
  assert.deepEqual(r.info.questions, [
    { question: "どちらにしますか？", header: "進め方", options: [{ label: "A", description: "先に" }, { label: "B" }] },
    { question: "名前は？", options: [] },
  ]);
  assert.deepEqual(replyOf(r, "allow", [{ picked: [1] }, { picked: [], text: " がしょう " }]), {
    result: { answers: { q1: { answers: ["B"] }, q2: { answers: ["がしょう"] } } },
  });
  assert.deepEqual(replyOf(r, "deny", undefined), { result: { answers: {} } });
});

test("a request that Gasho's cards cannot show is not taken", () => {
  assert.equal(requestOf(3, "mcpServer/elicitation/request", { threadId: "t" }, undefined, 100), undefined);
});

test("the socket is read from the line of JSON that codex app-server daemon start prints", () => {
  const line = JSON.stringify({ status: "alreadyRunning", socketPath: "/home/u/.codex/app-server-control/app-server-control.sock" });
  assert.equal(codexSocketOf(`${line}\n`), "/home/u/.codex/app-server-control/app-server-control.sock");
  assert.equal(codexSocketOf(`note\n${line}\n\n`), "/home/u/.codex/app-server-control/app-server-control.sock");
  assert.equal(codexSocketOf('{"status":"started"}\n'), undefined);
  assert.equal(codexSocketOf("not json"), undefined);
});
