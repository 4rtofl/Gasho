// Work that Claude runs in the background: what the transcript says was started and has ended, what Claude Code's own
// state says still runs, the screens of Claude Code's list of background tasks (2.1.325, 2.1.331), and the daemon
// stopping that work in a fake Claude Code terminal, where no key may reach the prompt box by mistake: an Esc there
// stops Claude (two in a row open its rewind dialog), and an Enter there can send Claude Code's suggestion for the next
// message.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { BackgroundTask } from "@gasho/protocol";
import { Daemon } from "../src/daemon.ts";
import {
  agentRowFocused,
  plainScreen,
  readScreen,
  taskRowActive,
  taskRowKind,
  taskRowShows,
  tasksDialog,
  tasksItemFocused,
  typedInBox,
  waitingForBackground,
} from "../src/managed.ts";
import { mayRun, runningTasks, sessionStatus, waitingForOf } from "../src/sessions.ts";
import { emptyMeta, parseRecord } from "../src/transcript.ts";

const RULE = "─".repeat(50);

// ---------------------------------------------------------------------------------------------------------------------
// The transcript

function call(id: string, name: string, input: Record<string, unknown>, ts = "2026-11-14T16:13:41.000Z") {
  return { type: "assistant", uuid: `a-${id}`, timestamp: ts, message: { model: "claude-haiku-5-5", content: [{ type: "tool_use", id, name, input }] } };
}
function result(id: string, text: string, kept?: Record<string, unknown>, ts = "2026-11-14T16:13:42.000Z") {
  return { type: "user", uuid: `u-${id}`, timestamp: ts, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] }, ...(kept ? { toolUseResult: kept } : {}) };
}
const notice = (taskId: string, status?: string) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n${status ? `<status>${status}</status>\n` : "<event>tick</event>\n"}<summary>…</summary>\n</task-notification>`;

test("a background shell is open from its result until Claude Code's notice that it ended", () => {
  const meta = emptyMeta();
  parseRecord(call("t1", "Bash", { command: "sleep 300", description: "first sleep", run_in_background: true }), meta);
  // Not started yet: only the call is known.
  assert.deepEqual(meta.background?.list(), []);
  parseRecord(result("t1", "Command running in background with ID: bb5iuyc21. Output is being written to: /tmp/x", { stdout: "", backgroundTaskId: "bb5iuyc21" }), meta);
  assert.deepEqual(meta.background?.list(), [
    { id: "bb5iuyc21", kind: "shell", title: "first sleep", command: "sleep 300", startedAt: Date.parse("2026-11-14T16:13:41.000Z") },
  ]);
  // Claude Code queues its notice first; that is enough.
  parseRecord({ type: "queue-operation", operation: "enqueue", content: notice("bb5iuyc21", "killed") }, meta);
  assert.deepEqual(meta.background?.list(), []);
});

test("subagents, monitors and workflows; a monitor's events do not end it", () => {
  const meta = emptyMeta();
  parseRecord(call("a1", "Agent", { description: "license reader", prompt: "…", subagent_type: "general-purpose", run_in_background: true }), meta);
  parseRecord(result("a1", "Async agent launched successfully.\nagentId: aa43377f5d165f814", { isAsync: true, status: "async_launched", agentId: "aa43377f5d165f814" }), meta);
  parseRecord(call("m1", "Monitor", { command: "tail -f app.log | grep --line-buffered ERROR", description: "errors in app.log", timeout_ms: 30000 }), meta);
  parseRecord(result("m1", "Monitor started (task b1b4b0csk, expires in 30s …)", { taskId: "b1b4b0csk", timeoutMs: 30000, persistent: false }), meta);
  parseRecord(call("w1", "Workflow", { script: "export const meta = { name: 'review-changes', description: '…' }" }), meta);
  parseRecord(result("w1", "Workflow launched in background. Task ID: wf7", { taskId: "wf7" }), meta);
  // A subagent that ran in the foreground started nothing.
  parseRecord(call("a2", "Agent", { description: "quick look", prompt: "…" }), meta);
  parseRecord(result("a2", "Done.", { status: "completed", agentId: "ab1" }), meta);
  assert.deepEqual(
    meta.background?.list().map((t) => [t.id, t.kind, t.title]),
    [
      ["aa43377f5d165f814", "agent", "license reader"],
      ["b1b4b0csk", "monitor", "errors in app.log"],
      ["wf7", "workflow", "review-changes"],
    ],
  );
  // Delivered as a message to Claude: a monitor's event, then the end of the subagent.
  parseRecord({ type: "user", uuid: "n1", message: { role: "user", content: notice("b1b4b0csk") } }, meta);
  parseRecord({ type: "attachment", attachment: { type: "queued_command", prompt: notice("aa43377f5d165f814", "completed") } }, meta);
  assert.deepEqual(meta.background?.list().map((t) => t.id), ["b1b4b0csk", "wf7"]);
});

test("what ends background work, and what does not", () => {
  const meta = emptyMeta();
  for (const [id, task] of [
    ["t1", "b1"],
    ["t2", "b2"],
    ["t3", "b3"],
  ] as const) {
    parseRecord(call(id, "Bash", { command: `job ${task}`, run_in_background: true }), meta);
    parseRecord(result(id, `Command running in background with ID: ${task}.`, { backgroundTaskId: task }), meta);
  }
  // A notice quoted in a tool's result (a file Claude read) is no notice.
  parseRecord(result("read", notice("b1", "completed")), meta);
  // Claude's TaskStop.
  parseRecord(call("s1", "TaskStop", { task_id: "b2" }), meta);
  parseRecord(result("s1", "Successfully stopped task: b2", { task_id: "b2" }), meta);
  // A subagent's own work is not followed.
  parseRecord({ type: "user", isSidechain: true, uuid: "sc", message: { role: "user", content: notice("b3", "completed") } }, meta);
  assert.deepEqual(meta.background?.list().map((t) => t.id), ["b1", "b3"]);
  // A failed call starts nothing; an end recorded before the start keeps the work from being opened.
  parseRecord({ type: "queue-operation", content: notice("b9", "completed") }, meta);
  parseRecord(call("t9", "Bash", { command: "fast", run_in_background: true }), meta);
  parseRecord(result("t9", "Command running in background with ID: b9.", { backgroundTaskId: "b9" }), meta);
  parseRecord(call("t8", "Bash", { command: "nope", run_in_background: true }), meta);
  parseRecord({ ...result("t8", "Permission denied"), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t8", content: "Permission denied", is_error: true }] } }, meta);
  assert.deepEqual(meta.background?.list().map((t) => t.id), ["b1", "b3"]);
});

test("results recorded together are told apart by their text", () => {
  const meta = emptyMeta();
  parseRecord(call("t1", "Bash", { command: "npm run dev", description: "dev server", run_in_background: true }), meta);
  parseRecord(call("t2", "Bash", { command: "echo with ID: x1" }), meta);
  parseRecord(
    {
      type: "user",
      uuid: "u",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "Command running in background with ID: bdev1. Output is being written to: /tmp/x" },
          { type: "tool_result", tool_use_id: "t2", content: "with ID: x1" },
        ],
      },
      toolUseResult: { backgroundTaskId: "bdev1" },
    },
    meta,
  );
  assert.deepEqual(meta.background?.list().map((t) => [t.id, t.title]), [["bdev1", "dev server"]]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Claude Code's state

const task = (id: string, kind: BackgroundTask["kind"], startedAt = 2000): BackgroundTask => ({ id, kind, title: id, startedAt });

test("Claude Code's state says what still runs", () => {
  const all = [task("s", "shell"), task("m", "monitor"), task("a", "agent"), task("w", "workflow"), task("old", "shell", 500)];
  assert.deepEqual(runningTasks(all, { status: "idle" }, 1000), []);
  assert.deepEqual(runningTasks(all, { status: "shell" }, 1000).map((t) => t.id), ["s", "m"]);
  // The work of the Claude Code that ran before (a conversation resumed) is gone.
  assert.deepEqual(runningTasks(all, { status: "busy" }, 1000).map((t) => t.id), ["s", "m", "a", "w"]);
  assert.deepEqual(runningTasks(all, { status: "waiting" }, undefined).map((t) => t.id), ["s", "m", "a", "w", "old"]);
  // A state written before the work started says nothing of it.
  assert.deepEqual(runningTasks(all, { status: "idle", at: 1500 }, 1000), all.slice(0, 4));
  assert.deepEqual(runningTasks(all, { status: "idle", at: 2500 }, 1000), []);
});

test("a subagent whose end Claude Code did not record is forgotten once Claude Code says no subagent runs", () => {
  const meta = emptyMeta();
  parseRecord(call("a1", "Agent", { description: "copyright reader 2", prompt: "…" }, "2026-11-14T16:23:04.000Z"), meta);
  parseRecord(result("a1", "Async agent launched successfully.", { status: "async_launched", agentId: "aeec7" }, "2026-11-14T16:23:04.500Z"), meta);
  parseRecord(call("t1", "Bash", { command: "sleep 900", run_in_background: true }, "2026-11-14T16:30:00.000Z"), meta);
  parseRecord(result("t1", "Command running in background with ID: b1.", { backgroundTaskId: "b1" }, "2026-11-14T16:30:00.500Z"), meta);
  const claude = { status: "shell", at: Date.parse("2026-11-14T16:31:00.000Z") };
  meta.background?.settle((x) => mayRun(x, claude, undefined));
  assert.deepEqual(meta.background?.list().map((t) => t.id), ["b1"]);
  // Another subagent later makes Claude Code say "busy": the one that ended does not come back.
  parseRecord(call("a2", "Agent", { description: "copyright reader 5", prompt: "…" }, "2026-11-14T16:40:00.000Z"), meta);
  parseRecord(result("a2", "Async agent launched successfully.", { status: "async_launched", agentId: "a5" }, "2026-11-14T16:40:00.500Z"), meta);
  assert.deepEqual(runningTasks(meta.background!.list(), { status: "busy", at: Date.parse("2026-11-14T16:40:01.000Z") }, undefined).map((t) => t.id), ["b1", "a5"]);
});

test("a session whose turn has ended while only shells run is idle, though Claude Code's list says busy", () => {
  assert.equal(sessionStatus({ status: "busy" }, { status: "shell" }), "idle");
  assert.equal(sessionStatus({ status: "busy" }, { status: "busy" }), "busy");
  assert.equal(sessionStatus({ status: "busy" }, undefined), "busy");
});

test("a session's state is the one Claude Code wrote last in its file, which the list read seconds before on a busy machine", () => {
  assert.equal(sessionStatus({ status: "idle" }, { status: "busy" }), "busy");
  assert.equal(sessionStatus({ status: "busy" }, { status: "waiting", waitingFor: "permission prompt" }), "waiting");
  assert.equal(waitingForOf({ status: "busy" }, { status: "waiting", waitingFor: "permission prompt" }), "permission prompt");
  assert.equal(waitingForOf({ status: "waiting", waitingFor: "permission prompt" }, { status: "busy" }), undefined);
  // Without a state in the file (a session in the background writes `state`), the list's.
  assert.equal(sessionStatus({ state: "blocked" }, {}), "waiting");
  assert.equal(waitingForOf({ status: "waiting", waitingFor: "input needed" }, {}), "input needed");
  assert.equal(sessionStatus(undefined, undefined), "unknown");
});

// ---------------------------------------------------------------------------------------------------------------------
// Screens of Claude Code 2.1.325 (a 50-column terminal)

const LIST_TWO_GROUPS = [
  "● launched",
  "✻ Waiting for 1 background agent to finish",
  RULE,
  "  Background",
  "  1 active shell · 1 active agent",
  "    Shells (1)",
  "  ❯ ● sleep 900          running",
  "    Local agents (1)",
  "    ● copyright reader   running · Haiku 5.5",
  "      Earlier in this session (2)",
  "  ↑/↓ to select · Enter to view · x to stop ·",
  "  Esc to close",
].join("\n");

test("the list of background tasks: rows, groups, the cursor, and the view of one task", () => {
  const d = tasksDialog(LIST_TWO_GROUPS);
  assert.ok(d && d.view === "list");
  assert.equal(d.summary, "1 active shell · 1 active agent");
  assert.deepEqual(d.rows, [
    { label: "sleep 900", state: "running", selected: true, group: "Shells" },
    { label: "copyright reader", state: "running", selected: false, group: "Local agents" },
  ]);
  assert.deepEqual(d.rows.map(taskRowKind), ["shell", "agent"]);
  assert.equal(d.cursorAway, false);

  const one = tasksDialog(
    [
      RULE,
      "  Background",
      "  1 active shell",
      "    ● until [ -f /nonexistent/flag ];…   running",
      "  ❯   Earlier in this session (4)",
      "  ↑/↓ to select · Enter to show · Esc to close",
    ].join("\n"),
  );
  assert.ok(one && one.view === "list");
  assert.equal(one.cursorAway, true);
  assert.equal(taskRowKind(one.rows[0]!), "shell");
  assert.equal(taskRowShows(one.rows[0]!, ["until [ -f /nonexistent/flag ]; do\n  sleep 30; done; echo never"]), true);
  assert.equal(taskRowShows(one.rows[0]!, ["until [ -f /other ]"]), false);

  const done = tasksDialog(
    [
      RULE,
      "  Background",
      "  No tasks currently running",
      "    Completed (1)",
      "  ❯ ✔ slow helper   done · Haiku 5.5",
      "      Earlier in this session (0)",
      "  ↑/↓ to select · Enter to view · x to stop ·",
      "  Esc to close",
    ].join("\n"),
  );
  assert.ok(done && done.view === "list");
  assert.deepEqual(done.rows.filter(taskRowActive), []);

  const details = ["  Shell details", "  Status:   running", "  Command:  sleep 240; echo finished", "  ← to go back · Esc/Enter/Space to close · x to", "  stop"].join("\n");
  assert.deepEqual(tasksDialog(details), { view: "details" });
  // A conversation that quotes the hints is no list: only the bottom counts.
  assert.equal(tasksDialog(`${LIST_TWO_GROUPS}\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ auto mode on`), undefined);
});

// Screens of Claude Code 2.1.331 (a 50-column terminal): the hints change with the row the cursor is on, a group's
// heading has no count, and the summary is left out once nothing runs.

const PANEL_TOP = "▔".repeat(50);

test("the list of background tasks of Claude Code 2.1.331", () => {
  const shell = tasksDialog(
    ["● started", "", PANEL_TOP, "  Background", "  1 shell", "", "  ❯ ● sleep 900   running", "", "      Earlier in this session (0)", "", "  x to stop · Enter to view · Esc to close"].join(
      "\n",
    ),
  );
  assert.ok(shell && shell.view === "list");
  assert.equal(shell.summary, "1 shell");
  assert.deepEqual(shell.rows, [{ label: "sleep 900", state: "running", selected: true, group: "1 shell" }]);
  assert.equal(taskRowKind(shell.rows[0]!), "shell");

  const away = tasksDialog(
    [PANEL_TOP, "  Background", "  1 shell", "", "    ● sleep 900   running", "", "  ❯   Earlier in this session (0)", "", "  ↑/↓ to navigate · Esc to close"].join("\n"),
  );
  assert.ok(away && away.view === "list");
  assert.equal(away.cursorAway, true);
  assert.equal(away.rows.length, 1);

  const agents = tasksDialog(
    [
      "✻ Waiting for 1 background agent to finish",
      PANEL_TOP,
      "  Background",
      "  1 background agent",
      "",
      "    Background agents",
      "  ❯ ● slow helper   running · Haiku 5.5",
      "",
      "    Completed",
      "    ✔ slow helper   done · Haiku 5.5",
      "",
      "      Earlier in this session (0)",
      "",
      "  x to stop · f to foreground · Enter to view ·",
      "  Esc to close",
    ].join("\n"),
  );
  assert.ok(agents && agents.view === "list");
  assert.deepEqual(agents.rows, [
    { label: "slow helper", state: "running", selected: true, group: "Background agents" },
    { label: "slow helper", state: "done", selected: false, group: "Completed" },
  ]);
  assert.deepEqual(agents.rows.map(taskRowKind), ["agent", undefined]);
  assert.deepEqual(agents.rows.filter(taskRowActive).length, 1);

  // Once the agent is stopped: no summary, and Claude Code holds its notice back while the list is open.
  const stopped = tasksDialog(
    [
      "Background update waiting while this panel is open",
      PANEL_TOP,
      "  Background",
      "",
      "    Completed",
      "  ❯ ✔ slow helper   done · Haiku 5.5",
      "",
      "      Earlier in this session (0)",
      "",
      "  ↑/↓ to navigate · Enter to view · Esc to close",
    ].join("\n"),
  );
  assert.ok(stopped && stopped.view === "list");
  assert.equal(stopped.summary, "");
  assert.deepEqual(stopped.rows.filter(taskRowActive), []);

  const empty = tasksDialog([PANEL_TOP, "  Background", "", "  No tasks currently running", "", "  ❯ Earlier in this session (0)", "", "  Esc to close"].join("\n"));
  assert.ok(empty && empty.view === "list");
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.cursorAway, true);

  const details = [
    PANEL_TOP,
    "  Sleep for 900 seconds in background",
    "  shell",
    "",
    "  Status:   running",
    "  Command:  sleep 900",
    "",
    "  ← to go back · x to stop · Enter/Space to",
    "  close · Esc to close",
  ].join("\n");
  assert.deepEqual(tasksDialog(details), { view: "details" });
  // Another screen that ends in "Esc to close" is no list of background tasks.
  assert.equal(tasksDialog(["  Help", "", "  /tasks  List background tasks", "", "  Esc to close"].join("\n")), undefined);
  assert.equal(tasksDialog(["  Background", "", PANEL_TOP, "  Help", "  /tasks  List background tasks", "", "  Esc to close"].join("\n")), undefined);
});

test("the item for the background tasks has the keys when it is reversed; ↓ can go to the row of subagents instead", () => {
  const prompt = (footer: string, more: string[] = []) => [RULE, "❯ \x1b[2mstop the polling loop\x1b[22m", RULE, footer, ...more].join("\n");
  assert.equal(tasksItemFocused(readScreen(prompt("  ⏵⏵ auto mode on · 1 shell · ↓ to manage"))), false);
  assert.equal(tasksItemFocused(readScreen(prompt("  ⏵⏵ auto mode on · \x1b[7m1 shell\x1b[27m · Enter to view tas…"))), true);
  // The cursor in the box is reversed too, but it is no item of the footer.
  assert.equal(tasksItemFocused(readScreen([RULE, "❯ \x1b[7m \x1b[27m", RULE, "  ⏵⏵ auto mode on"].join("\n"))), false);
  const strip = prompt("  ↑/↓ to select", ["❯ ● main", "  ◯ general-purpose  copyri… 6s · ↓ 47.1k tokens"]);
  assert.equal(agentRowFocused(strip), true);
  assert.equal(agentRowFocused(prompt("  ⏵⏵ auto mode on · ↓ to m…", ["  ● main", "  ◯ general-purpose  copyri… 5s"])), false);
  assert.equal(typedInBox(readScreen(strip)), "");
});

test("Claude waits for its subagents once its turn has ended", () => {
  assert.equal(waitingForBackground(["● launched", "✻ Waiting for 1 background agent to finish", RULE, "❯ ", RULE, "  ⏵⏵ auto mode on"].join("\n")), true);
  assert.equal(waitingForBackground(["✻ Architecting… (1m 22s · ↓ 7.5k tokens)", RULE, "❯ ", RULE, "  ⏵⏵ auto mode on · 1 shell · esc to interrupt …"].join("\n")), false);
  assert.equal(waitingForBackground(plainScreen("✻ Waiting for 1 background agent to finish").plain), false);
});

// ---------------------------------------------------------------------------------------------------------------------
// The daemon in a fake Claude Code terminal

interface FakeTask {
  id: string;
  kind: "shell" | "agent";
  label: string;
  running: boolean;
}

/**
 * Claude Code's prompt box, its footer and its list of background tasks, as far as the daemon drives them: as 2.1.325
 * draws the list, or as 2.1.331 does (`version`).
 */
class FakeClaude {
  version: "2.1.325" | "2.1.331" = "2.1.325";
  tasks: FakeTask[] = [];
  /** Claude's turn runs (the footer then says "esc to interrupt"). */
  turn = false;
  box = "";
  suggestion = "stop the polling loop";
  mode: "prompt" | "list" | "details" = "prompt";
  focus: "box" | "item" | "agents" = "box";
  cursor = 0;
  /** Once x has stopped a task in the list, the next x goes to that task (and does nothing) until the cursor moves. */
  stale = false;
  detailsOf = 0;
  /** What would have done harm: keys that reached the prompt box when they were not meant for it. */
  harm: string[] = [];
  submitted: string[] = [];
  stopped: string[] = [];

  private active() {
    return this.tasks.filter((t) => t.running);
  }
  /** The list's rows the cursor can be on: the tasks that run, then "Earlier in this session". */
  private rows() {
    return [...this.active(), undefined];
  }

  key(k: string): void {
    if (this.mode === "prompt") return this.promptKey(k);
    if (this.mode === "details") {
      const t = this.active()[this.detailsOf];
      if (k === "Left") {
        this.mode = "list";
        this.cursor = this.detailsOf;
      } else if (k === "x" && t) this.stop(t, true);
      else if (k === "Esc" || k === "Enter" || k === " ") this.mode = "prompt";
      return;
    }
    const rows = this.rows();
    if (k === "Up" || k === "Down") this.stale = false;
    if (k === "Up") this.cursor = Math.max(0, this.cursor - 1);
    else if (k === "Down") this.cursor = Math.min(rows.length - 1, this.cursor + 1);
    else if (k === "Esc") this.mode = "prompt";
    else if (k === "x") {
      const t = rows[this.cursor];
      if (t && !this.stale) {
        this.stop(t, false);
        this.stale = true;
      }
    } else if (k === "Enter" && rows[this.cursor]) {
      this.mode = "details";
      this.detailsOf = this.cursor;
    }
  }

  private stop(t: FakeTask, close: boolean): void {
    t.running = false;
    this.stopped.push(t.id);
    if (close) this.mode = "prompt";
    this.cursor = Math.min(this.cursor, this.rows().length - 1);
  }

  private openTasks(): void {
    this.focus = "box";
    this.stale = false;
    this.mode = this.active().length === 1 ? "details" : "list";
    this.cursor = 0;
    this.detailsOf = 0;
  }

  private promptKey(k: string): void {
    const shells = this.active().filter((t) => t.kind === "shell").length;
    const agents = this.active().filter((t) => t.kind === "agent").length;
    if (k === "Enter") {
      if (this.focus === "item") return this.openTasks();
      if (this.focus === "agents") return void this.harm.push("Enter on the row of subagents");
      if (this.box === "/tasks") {
        this.box = "";
        // While the turn runs, Claude Code would queue it.
        if (this.turn) return void this.harm.push("/tasks while the turn runs");
        return this.openTasks();
      }
      if (this.box) this.submitted.push(this.box);
      else this.harm.push(`Enter on the prompt box (sends "${this.suggestion}")`);
      this.box = "";
    } else if (k === "Down") {
      if (this.box) return;
      if (shells > 0) this.focus = "item";
      else if (agents > 0) this.focus = "agents";
    } else if (k === "Up") {
      if (this.focus !== "box") this.focus = "box";
      else this.harm.push("↑ on the prompt box (brings back an old message)");
    } else if (k === "Esc") {
      this.harm.push("Esc on the prompt box");
    } else if (k === "Ctrl u" || k === "Backspace") {
      this.box = "";
    } else {
      this.harm.push(`${k} typed into the prompt box`);
    }
  }

  paste(text: string): void {
    if (this.mode !== "prompt") return void this.harm.push(`paste into the list: ${text}`);
    this.box += text;
  }

  ansi(): string {
    const head = ["● launched", this.turn ? "✻ Working… (5s · ↓ 1.2k tokens)" : this.active().some((t) => t.kind === "agent") ? "✻ Waiting for 1 background agent to finish" : "✻ Baked for 2s · done 4:11 PM"];
    if (this.mode === "details") {
      const t = this.active()[this.detailsOf];
      return [...head, RULE, "  Shell details", "  Status:   running", `  Command:  ${t?.label ?? ""}`, "  ← to go back · Esc/Enter/Space to close · x to", "  stop"].join("\n");
    }
    if (this.mode === "list" && this.version === "2.1.331") return [...head, PANEL_TOP, ...this.list331()].join("\n");
    if (this.mode === "list") {
      const active = this.active();
      const shells = active.filter((t) => t.kind === "shell");
      const agents = active.filter((t) => t.kind === "agent");
      const groups = [shells.length && ["Shells", shells], agents.length && ["Local agents", agents]].filter(Boolean) as [string, FakeTask[]][];
      const summary = active.length === 0 ? "No tasks currently running" : [shells.length && `${shells.length} active shell${shells.length > 1 ? "s" : ""}`, agents.length && `${agents.length} active agent${agents.length > 1 ? "s" : ""}`].filter(Boolean).join(" · ");
      const lines = ["  Background", `  ${summary}`];
      const order = [...shells, ...agents];
      for (const [name, list] of groups) {
        if (groups.length > 1) lines.push(`    ${name} (${list.length})`);
        for (const t of list) lines.push(`  ${order.indexOf(t) === this.cursor ? "❯" : " "} ● ${t.label.padEnd(16)}   running`);
      }
      lines.push(`  ${this.cursor === order.length ? "❯" : " "}   Earlier in this session (0)`, "  ↑/↓ to select · Enter to view · x to stop ·", "  Esc to close");
      return [...head, RULE, ...lines].join("\n");
    }
    return this.prompt();
  }

  /** The list as Claude Code 2.1.331 draws it: headings without counts, hints that follow the cursor. */
  private list331(): string[] {
    const active = this.active();
    const shells = active.filter((t) => t.kind === "shell");
    const agents = active.filter((t) => t.kind === "agent");
    const ended = this.tasks.filter((t) => !t.running);
    const groups = [shells.length && ["Shells", shells], agents.length && ["Background agents", agents]].filter(Boolean) as [string, FakeTask[]][];
    const summary = [shells.length && `${shells.length} shell${shells.length > 1 ? "s" : ""}`, agents.length && `${agents.length} background agent${agents.length > 1 ? "s" : ""}`]
      .filter(Boolean)
      .join(" · ");
    const lines = ["  Background", summary ? `  ${summary}` : "", ""];
    if (!summary && ended.length === 0) lines.push("  No tasks currently running", "");
    const order = [...shells, ...agents];
    for (const [name, list] of groups) {
      if (groups.length > 1 || ended.length > 0) lines.push(`    ${name}`);
      for (const t of list) lines.push(`  ${order.indexOf(t) === this.cursor ? "❯" : " "} ● ${t.label}   running`);
      lines.push("");
    }
    if (ended.length > 0) {
      lines.push("    Completed");
      for (const t of ended) lines.push(`    ✔ ${t.label}   ${t.kind === "agent" ? "done" : "killed"}`);
      lines.push("");
    }
    const away = this.cursor === order.length;
    lines.push(`  ${away ? "❯" : " "}   Earlier in this session (0)`, "");
    lines.push(away ? (order.length ? "  ↑/↓ to navigate · Esc to close" : "  Esc to close") : "  x to stop · Enter to view · Esc to close");
    return lines;
  }

  private prompt(): string {
    const head = ["● launched", this.turn ? "✻ Working… (5s · ↓ 1.2k tokens)" : this.active().some((t) => t.kind === "agent") ? "✻ Waiting for 1 background agent to finish" : "✻ Baked for 2s · done 4:11 PM"];
    const shells = this.active().filter((t) => t.kind === "shell").length;
    const agents = this.active().filter((t) => t.kind === "agent");
    const item = shells ? `${shells} shell${shells > 1 ? "s" : ""}` : "";
    const footer = [
      "  ⏵⏵ auto mode on",
      item && (this.focus === "item" ? `\x1b[7m${item}\x1b[27m` : item),
      this.turn ? "esc to interrupt" : this.focus === "item" ? "Enter to view tasks" : "↓ to manage",
    ]
      .filter(Boolean)
      .join(" · ");
    const strip = agents.length ? [this.focus === "agents" ? "❯ ● main" : "  ● main", ...agents.map((a) => `  ◯ general-purpose  ${a.label.slice(0, 6)}… 7s`)] : [];
    const box = this.box ? `❯ ${this.box}` : `❯ \x1b[2m${this.suggestion}\x1b[22m`;
    return [...head, RULE, box, RULE, footer, ...strip].join("\n");
  }
}

const SID = "11111111-2222-3333-4444-555555555555";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(c: FakeClaude, status: () => string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-background-"));
  const d = new Daemon(
    {
      hubUrl: "ws://127.0.0.1:1",
      machineId: "m",
      token: "t",
      hookPort: 0,
      claudeDir: path.join(dir, "claude"),
      claudeBin: "/bin/false",
      pollIntervalMs: 60_000,
      stateDir: dir,
      attachmentsDir: path.join(dir, "attachments"),
    } as ConstructorParameters<typeof Daemon>[0],
    { enterWaitMs: 400 },
  ) as unknown as Record<string, any>;
  d.terminals = {
    screen: async () => readScreen(c.ansi()),
    keys: async (_s: string, ...keys: string[]) => keys.forEach((k) => c.key(k)),
    paste: async (_s: string, text: string) => c.paste(text),
  };
  d.currentStatus = async () => status();
  d.scheduleRefresh = () => undefined;
  d.emitSessions = () => undefined;
  d.managed.add({ sessionId: SID, terminal: "z", pid: 1, cwd: dir, name: "fake", launchedAt: 1 });
  const background: BackgroundTask[] = c.tasks.map((t) => ({ id: t.id, kind: t.kind, title: t.kind === "agent" ? t.label : `run ${t.id}`, ...(t.kind === "shell" ? { command: t.label } : {}), startedAt: 2 }));
  d.tracked.set(SID, { info: { sessionId: SID, cwd: dir, status: status(), rcMode: "none", prLinks: [], background }, meta: emptyMeta() });
  return { d, done: () => fs.rm(dir, { recursive: true, force: true }) };
}

test("stopping one shell: /tasks once Claude's turn has ended, the cursor on its row, x, then Esc closes the list", async () => {
  const c = new FakeClaude();
  c.tasks = [
    { id: "b1", kind: "shell", label: "npm run dev", running: true },
    { id: "b2", kind: "shell", label: "until gh run list --workflow release.yml; do sleep 60; done", running: true },
  ];
  const { d, done } = await setup(c, () => "idle");
  const r = await d.stopTasks(SID, "b2");
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(c.stopped, ["b2"]);
  assert.equal(c.mode, "prompt");
  assert.deepEqual(c.harm, []);
  assert.deepEqual(c.submitted, []);
  await done();
});

test("stopping all of it, a shell and a subagent", async () => {
  const c = new FakeClaude();
  c.tasks = [
    { id: "b1", kind: "shell", label: "sleep 900", running: true },
    { id: "a1", kind: "agent", label: "copyright reader", running: true },
  ];
  const { d, done } = await setup(c, () => "busy");
  const r = await d.stopTasks(SID);
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(c.stopped.sort(), ["a1", "b1"]);
  assert.equal(c.mode, "prompt");
  assert.deepEqual(c.harm, []);
  await done();
});

test("one task alone opens in its own view: x there stops it and closes it", async () => {
  const c = new FakeClaude();
  c.tasks = [{ id: "b1", kind: "shell", label: "sleep 900", running: true }];
  const { d, done } = await setup(c, () => "idle");
  assert.deepEqual(await d.stopTasks(SID, "b1"), { ok: true });
  assert.deepEqual(c.stopped, ["b1"]);
  assert.equal(c.mode, "prompt");
  assert.deepEqual(c.harm, []);
  await done();
});

test("while Claude's turn runs: ↓ and Enter, only once the item for the tasks has the keys", async () => {
  const c = new FakeClaude();
  c.turn = true;
  c.tasks = [
    { id: "b1", kind: "shell", label: "sleep 900", running: true },
    { id: "b2", kind: "shell", label: "npm run dev", running: true },
  ];
  const { d, done } = await setup(c, () => "busy");
  assert.deepEqual(await d.stopTasks(SID, "b1"), { ok: true });
  assert.deepEqual(c.stopped, ["b1"]);
  assert.deepEqual(c.harm, []);
  await done();
});

test("while Claude's turn runs with only subagents, ↓ goes to their row: ↑ gives the keys back and nothing is pressed", async () => {
  const c = new FakeClaude();
  c.turn = true;
  c.tasks = [{ id: "a1", kind: "agent", label: "copyright reader", running: true }];
  const { d, done } = await setup(c, () => "busy");
  const r = await d.stopTasks(SID, "a1");
  assert.equal(r.ok, false);
  assert.match(r.error, /作業中/);
  assert.equal(c.focus, "box");
  assert.deepEqual(c.stopped, []);
  assert.deepEqual(c.harm, []);
  await done();
});

test("text in the prompt box is left alone: nothing is stopped", async () => {
  const c = new FakeClaude();
  c.box = "書きかけ";
  c.tasks = [{ id: "b1", kind: "shell", label: "sleep 900", running: true }];
  const { d, done } = await setup(c, () => "idle");
  const r = await d.stopTasks(SID, "b1");
  assert.equal(r.ok, false);
  assert.equal(c.box, "書きかけ");
  assert.deepEqual(c.stopped, []);
  assert.deepEqual(c.harm, []);
  await done();
});

test("a task the list does not show is not stopped in its place", async () => {
  const c = new FakeClaude();
  c.tasks = [
    { id: "b1", kind: "shell", label: "npm run dev", running: true },
    { id: "b2", kind: "shell", label: "sleep 900", running: true },
  ];
  const { d, done } = await setup(c, () => "idle");
  d.tracked.get(SID).info.background.push({ id: "b3", kind: "shell", title: "gone", command: "pnpm exec wrangler tail", startedAt: 2 });
  const r = await d.stopTasks(SID, "b3");
  assert.equal(r.ok, false);
  assert.deepEqual(c.stopped, []);
  assert.equal(c.mode, "prompt");
  assert.deepEqual(c.harm, []);
  await done();
});

test("stopping Claude: one Esc, and a second stop right after sends none (two Escs open Claude Code's rewind)", async () => {
  const c = new FakeClaude();
  c.turn = true;
  const { d, done } = await setup(c, () => "busy");
  const escs: string[] = [];
  const keys = d.terminals.keys;
  d.terminals.keys = async (s: string, ...k: string[]) => {
    escs.push(...k.filter((x) => x === "Esc"));
    if (!k.includes("Esc")) await keys(s, ...k);
  };
  assert.deepEqual(await d.interrupt(SID), { ok: true });
  assert.deepEqual(await d.interrupt(SID), { ok: true });
  await sleep(50);
  assert.deepEqual(await d.interrupt(SID), { ok: true });
  assert.deepEqual(escs, ["Esc"]);
  await done();
});

test("stopping Claude while it only waits for its subagents stops them, not the shells, and presses no Esc on the box", async () => {
  const c = new FakeClaude();
  c.tasks = [
    { id: "b1", kind: "shell", label: "npm run dev", running: true },
    { id: "a1", kind: "agent", label: "copyright reader", running: true },
  ];
  const { d, done } = await setup(c, () => "busy");
  assert.deepEqual(await d.interrupt(SID), { ok: true });
  assert.deepEqual(c.stopped, ["a1"]);
  assert.equal(c.tasks[0]!.running, true);
  assert.deepEqual(c.harm, []);
  await done();
});

test("stopping Claude when its turn has ended and only shells run: no Esc, and the shells are pointed to", async () => {
  const c = new FakeClaude();
  c.tasks = [{ id: "b1", kind: "shell", label: "npm run dev", running: true }];
  const { d, done } = await setup(c, () => "idle");
  const r = await d.interrupt(SID);
  assert.equal(r.ok, false);
  assert.match(r.error, /バックグラウンド/);
  assert.deepEqual(c.harm, []);
  assert.deepEqual(c.stopped, []);
  await done();
});

// Claude Code 2.1.331 (#262): the list was not told apart any more, so it stayed open after a stop; Claude Code then
// holds back the notice of the stop, and nothing more could be typed into the session.

test("2.1.331: stopping one of two shells, and the list is closed after", async () => {
  const c = new FakeClaude();
  c.version = "2.1.331";
  c.tasks = [
    { id: "b1", kind: "shell", label: "npm run dev", running: true },
    { id: "b2", kind: "shell", label: "sleep 900", running: true },
  ];
  const { d, done } = await setup(c, () => "idle");
  assert.deepEqual(await d.stopTasks(SID, "b2"), { ok: true });
  assert.deepEqual(c.stopped, ["b2"]);
  assert.equal(c.mode, "prompt");
  assert.deepEqual(c.harm, []);
  await done();
});

test("2.1.331: one shell alone opens in its own view; ← to the list, x, and the list is closed after", async () => {
  const c = new FakeClaude();
  c.version = "2.1.331";
  c.tasks = [{ id: "b1", kind: "shell", label: "sleep 900", running: true }];
  const { d, done } = await setup(c, () => "idle");
  // As by hand: the view of the only task, then ← back to the list.
  c.key("Down");
  c.mode = "details";
  c.focus = "box";
  c.key("Left");
  assert.equal(c.mode, "list");
  assert.deepEqual(await d.stopTasks(SID, "b1"), { ok: true });
  assert.deepEqual(c.stopped, ["b1"]);
  assert.equal(c.mode, "prompt");
  assert.deepEqual(c.harm, []);
  await done();
});

test("2.1.331: stopping Claude while it waits for its subagent stops it and closes the list", async () => {
  const c = new FakeClaude();
  c.version = "2.1.331";
  c.tasks = [
    { id: "b1", kind: "shell", label: "npm run dev", running: true },
    { id: "a1", kind: "agent", label: "slow helper", running: true },
  ];
  const { d, done } = await setup(c, () => "busy");
  assert.deepEqual(await d.interrupt(SID), { ok: true });
  assert.deepEqual(c.stopped, ["a1"]);
  assert.equal(c.tasks[0]!.running, true);
  assert.equal(c.mode, "prompt");
  assert.deepEqual(c.harm, []);
  await done();
});

test("a message waiting while the list of background tasks is left open closes it first, even while the session is busy", async () => {
  for (const status of ["idle", "busy"]) {
    const c = new FakeClaude();
    c.version = "2.1.331";
    c.tasks = [{ id: "a1", kind: "agent", label: "slow helper", running: false }];
    c.mode = "list";
    c.cursor = 0;
    let now = status;
    const { d, done } = await setup(c, () => now);
    const r = await d.input({ type: "session.input", requestId: "r", sessionId: SID, text: "次へ進んで" });
    assert.equal(r.ok, true);
    await d.flushInput(SID);
    assert.equal(c.mode, "prompt", status);
    assert.deepEqual(c.harm, [], status);
    // Claude Code goes on with the notice it held back, and the message is typed once the session is idle.
    now = "idle";
    d.settleUntil.delete(SID);
    await d.flushInput(SID);
    assert.deepEqual(c.submitted, ["次へ進んで"], status);
    await done();
  }
});
