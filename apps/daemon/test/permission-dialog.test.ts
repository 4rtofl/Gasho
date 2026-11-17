// A permission dialog that gasho-daemon holds no hook for (it restarted while the dialog was open, or the hook timed
// out): shown from the transcript's open tool call, and answered with the keys of Claude Code's dialog. Against a fake
// Claude Code terminal (no claude, no zellij).
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Daemon } from "../src/daemon.ts";
import { dialogOpen, permissionDialog, permissionDialogText, readScreen } from "../src/managed.ts";
import { dialogCall, shownCall } from "../src/permissions.ts";
import { emptyMeta, type OpenCall, parseRecord } from "../src/transcript.ts";

const RULE = "─".repeat(50);
const DASHES = "╌".repeat(50);
const SID = "11111111-2222-3333-4444-555555555555";
const FIRST = "touch first-aaa.txt";
const SECOND = "touch second-bbb.txt";

/** The question and choices at the bottom of the screen, with the cursor on one: long choices wrap. */
function bottom(question: string[], choices: string[][], cursor: number): string[] {
  return [
    ...question,
    ...choices.flatMap((lines, i) => lines.map((l, j) => (j === 0 ? `${i === cursor ? " ❯ " : "   "}${l}` : `   ${l}`))),
    " Esc to cancel · Tab to amend",
    "",
  ];
}

const COMMAND_CHOICES = [
  ["1. Yes"],
  ["2. Yes, and always allow access to", "   /home/rg/repos/Gasho from this project"],
  ["3. Yes, and switch to auto mode · auto mode", "   handles these prompts for you"],
  ["4. No"],
];
const FILE_CHOICES = [["1. Yes"], ["2. Yes, and switch to accept edits", "   (auto-approve file edits and common file", "   commands) for this session (shift+tab)"], ["3. No"]];

/** Claude Code 2.1.326's dialog for a command, in a pane 50 columns wide, while Claude has made two at once. */
function dialog(cursor: number, command = FIRST): string {
  return [
    " ▐▛███▛█   Claude Code v2.1.326",
    `⏺ Bash(${FIRST})`,
    "  ⎿  Waiting…",
    `⏺ Bash(${SECOND})`,
    "  ⎿  Waiting…",
    RULE,
    " Bash command",
    " Tip: auto mode handles these prompts for you —",
    ' choose "switch to auto mode" below',
    " Create a file",
    DASHES,
    ` ${command}`,
    DASHES,
    ...bottom([" Do you want to proceed?"], COMMAND_CHOICES, cursor),
  ].join("\n");
}

test("the dialog's choices are read from the bottom of the screen, whatever the tool", () => {
  const options = permissionDialog(dialog(0));
  assert.deepEqual(
    options?.map((o) => [o.n, o.label, o.selected]),
    [
      [1, "Yes", true],
      [2, "Yes, and always allow access to", false],
      [3, "Yes, and switch to auto mode · auto mode", false],
      [4, "No", false],
    ],
  );
  assert.equal(permissionDialog(dialog(3))?.[3]?.selected, true);
  const edit = dialog(0).replace(" Do you want to proceed?", " Do you want to make this edit to managed.ts?");
  assert.ok(permissionDialog(edit));
  // An edit's dialog keeps typed input away like a command's.
  assert.ok(dialogOpen(edit.replace("Bash", "Edit")));
  // A list in Claude's reply, above the prompt box, is no dialog.
  const reply = [" ▐▛███▛█   Claude Code v2.1.325", "● 1. Yes", "  2. No", RULE, "❯ ", RULE, "  ⏵⏵ auto mode on", ""].join("\n");
  assert.equal(permissionDialog(reply), undefined);
  // Nor a question whose first choice is not "Yes".
  assert.equal(permissionDialog(dialog(0).replace("1. Yes", "1. Opus")), undefined);
});

const call = (toolUseId: string, name: string, input: Record<string, unknown>): OpenCall => ({ toolUseId, name, input });
const CALLS = [call("toolu_3", "Bash", { command: FIRST }), call("toolu_4", "Bash", { command: SECOND })];
const text = (screen: string) => permissionDialogText(screen) ?? assert.fail("no dialog on the screen");
const shownId = (calls: OpenCall[], screen: string) => shownCall(calls, text(screen))?.toolUseId;

test("the dialog's text tells which of the calls without a result it is about, or nothing is", () => {
  // Claude Code asks about calls made at once in their order; the card follows the screen once it has been read.
  assert.equal(dialogCall(CALLS)?.toolUseId, "toolu_3");
  assert.equal(dialogCall(CALLS, text(dialog(0, SECOND)))?.toolUseId, "toolu_4");
  assert.equal(shownId(CALLS, dialog(0)), "toolu_3");
  assert.equal(shownId(CALLS, dialog(0, "touch third.txt")), undefined);
  // The command on the screen is the whole command: one that only starts like it is another.
  assert.equal(shownId([call("toolu_5", "Bash", { command: `${FIRST} && rm -rf build` })], dialog(0)), undefined);
  // The same call twice is one; calls that differ and both fit are none.
  assert.equal(shownId([...CALLS, call("toolu_5", "Bash", { command: FIRST })], dialog(0)), "toolu_3");

  // A command of more than one line: each has "│" on its left, and long ones wrap between words or inside one.
  const lines = "printf 'this is a very long string that will certainly wrap across lines in a narrow terminal %s' first > long-output.txt && mkdir -p sub/dir\ncat long-output.txt";
  const wrapped = [
    RULE,
    " Bash command",
    DASHES,
    " │ printf 'this is a very long string that will",
    " │ certainly wrap across lines in a narrow",
    " │ terminal %s' first > long-output.txt && mkdir",
    " │ -p sub/dir",
    " │ cat long-output.txt",
    DASHES,
    ...bottom([" Do you want to proceed?"], COMMAND_CHOICES, 0),
  ].join("\n");
  assert.equal(shownId([call("toolu_6", "Bash", { command: lines })], wrapped), "toolu_6");

  // A script taller than the screen: its start is above it, and what the screen shows must be its end. Two scripts
  // that end alike are none.
  const script = (first: string) => [first, ...Array.from({ length: 60 }, (_, i) => `print(${i + 1})`), "EOF"].join("\n");
  const cut = [
    ...script("python3 - <<'EOF'").split("\n").slice(24).map((l) => ` │ ${l}`),
    DASHES,
    " This command requires approval",
    ...bottom([" Do you want to proceed?"], COMMAND_CHOICES, 0),
  ].join("\n");
  assert.equal(text(cut).top, false);
  const heredoc = call("toolu_7", "Bash", { command: script("python3 - <<'EOF'") });
  assert.equal(shownId([heredoc], cut), "toolu_7");
  assert.equal(shownId([heredoc, call("toolu_8", "Bash", { command: script("python3 -u - <<'EOF'") })], cut), undefined);
  assert.equal(shownId([call("toolu_8", "Bash", { command: script("python3 - <<'EOF'").replace("print(40)", "print(41)") })], cut), undefined);

  // A file's tool: the question ends with the file's name, also when the dialog's top is above the screen.
  const edit = call("toolu_9", "Edit", { file_path: "/w/notes.txt", old_string: "line two", new_string: "line 2" });
  const write = call("toolu_10", "Write", { file_path: "/w/new-file.txt", content: "hello" });
  const editing = [
    `⏺ Update(notes.txt)`,
    `⏺ Write(new-file.txt)`,
    RULE,
    " Edit file",
    " notes.txt",
    DASHES,
    " 1  line one",
    " 2 -line two",
    " 2 +line 2",
    " 3  line three",
    DASHES,
    ...bottom([" Do you want to make this edit to notes.txt?"], FILE_CHOICES, 0),
  ].join("\n");
  assert.equal(shownId([edit, write], editing), "toolu_9");
  const creating = [...Array.from({ length: 30 }, (_, i) => `  ${i + 41} ${i + 41}`), DASHES, ...bottom([" Do you want to create new-file.txt?"], FILE_CHOICES, 0)].join("\n");
  assert.equal(shownId([edit, write], creating), "toolu_10");
  // Another notes.txt: the question cannot tell them apart.
  assert.equal(shownId([edit, call("toolu_11", "Edit", { file_path: "/w/sub/notes.txt", old_string: "a", new_string: "b" })], editing), undefined);

  // A fetch shows its URL; other tools their name and the texts of their input.
  const fetching = [
    RULE,
    " Fetch",
    " Claude wants to fetch content from example.com",
    DASHES,
    " url: https://example.com/",
    " prompt: What is the title of this page? Answer",
    " with one word only.",
    DASHES,
    ...bottom([" Do you want to allow Claude to fetch this", " content?"], [["1. Yes"], ["2. Yes, and don't ask again for example.com"], ["3. No, and tell Claude what to do differently", "   (esc)"]], 0),
  ].join("\n");
  const fetch = (url: string) => call("toolu_12", "WebFetch", { url, prompt: "What is the title of this page?" });
  assert.equal(shownId([fetch("https://example.com/")], fetching), "toolu_12");
  assert.equal(shownId([fetch("https://example.org/")], fetching), undefined);
  const reading = [RULE, " Read file", DASHES, " Read(/etc/hosts)", DASHES, ...bottom([" Do you want to proceed?"], [["1. Yes"], ["2. Yes, allow reading from /etc and", "   /private/etc during this session"], ["3. No"]], 0)].join("\n");
  assert.equal(shownId([call("toolu_13", "Read", { file_path: "/etc/passwd" }), call("toolu_14", "Read", { file_path: "/etc/hosts" })], reading), "toolu_14");
});

test("the transcript keeps the calls without a result until the person writes", () => {
  const meta = emptyMeta();
  // Read anew each time: an assertion that it is undefined would narrow `meta.openCalls` for good.
  const open = (): OpenCall[] | undefined => meta.openCalls;
  const call = (id: string, name: string, input: Record<string, unknown>) =>
    parseRecord({ type: "assistant", uuid: id, timestamp: "2026-11-14T17:13:11.780Z", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } }, meta);
  const result = (id: string) =>
    parseRecord({ type: "user", uuid: `r${id}`, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } }, meta);
  call("toolu_1", "Read", { file_path: "/a" });
  result("toolu_1");
  assert.equal(meta.openCalls, undefined);
  call("toolu_2", "Agent", { prompt: "調べて" });
  call("toolu_3", "Bash", { command: FIRST });
  assert.deepEqual(
    open()?.map((c) => c.toolUseId),
    ["toolu_2", "toolu_3"],
  );
  // A subagent asks nothing in the main transcript: the dialog is the command's.
  assert.equal(dialogCall(open())?.toolUseId, "toolu_3");
  result("toolu_3");
  assert.equal(dialogCall(open()), undefined);
  parseRecord({ type: "user", uuid: "u", message: { role: "user", content: "やめて" } }, meta);
  assert.equal(meta.openCalls, undefined);
});

class FakeClaude {
  cursor = 0;
  /** The command its dialog asks about. */
  command = FIRST;
  open = true;
  keys: string[] = [];
  answered?: string;
  onKey?: () => void;
  key(key: string): void {
    this.keys.push(key);
    if (!this.open) return;
    if (key === "Up") this.cursor = Math.max(0, this.cursor - 1);
    else if (key === "Down") this.cursor = Math.min(3, this.cursor + 1);
    else if (key === "Enter" || key === "Esc") {
      this.answered = key === "Esc" ? "no" : ["yes", "always", "auto", "no"][this.cursor];
      this.open = false;
    }
    this.onKey?.();
  }
  ansi(): string {
    return this.open ? dialog(this.cursor, this.command) : [" ▐▛███▛█   Claude Code v2.1.326", RULE, "❯ ", RULE, "  ⏵⏵ auto mode on", ""].join("\n");
  }
}

async function setup(c: FakeClaude) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-dialog-"));
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
    { enterWaitMs: 300 },
  ) as unknown as Record<string, any>;
  d.terminals = {
    screen: async () => readScreen(c.ansi()),
    keys: async (_s: string, ...keys: string[]) => keys.forEach((k) => c.key(k)),
    paste: async () => undefined,
  };
  d.currentStatus = async () => (c.open ? "waiting" : "busy");
  d.scheduleRefresh = () => undefined;
  d.emitSessions = () => undefined;
  d.managed.add({ sessionId: SID, terminal: "z", pid: 1, cwd: dir, name: "fake", launchedAt: 1 });
  d.tracked.set(SID, {
    info: { sessionId: SID, cwd: dir, status: "waiting", waitingFor: "permission prompt", rcMode: "none", prLinks: [] },
    meta: { prLinks: [], openCalls: CALLS.map((c) => ({ ...c, at: 5 })) },
  });
  return { d, done: () => fs.rm(dir, { recursive: true, force: true }) };
}

const answer = (extra: Record<string, unknown>) => ({
  type: "permission.answer",
  requestId: "r1",
  sessionId: SID,
  permissionId: "dialog:toolu_3",
  decision: "allow",
  ...extra,
});

test("the open call is shown while the session waits on a permission prompt, only for a session started from Gasho", async () => {
  const c = new FakeClaude();
  const { d, done } = await setup(c);
  try {
    const t = d.tracked.get(SID);
    const [r] = d.openPermission(t) ?? [];
    assert.equal(r?.id, "dialog:toolu_3");
    assert.equal(r?.toolName, "Bash");
    assert.equal(r?.always, undefined);
    // Once the screen has been read, the call its dialog is about.
    t.dialog = permissionDialogText(dialog(0, SECOND));
    assert.equal(d.openPermission(t)?.[0]?.id, "dialog:toolu_4");
    t.info.waitingFor = "input needed";
    assert.equal(d.openPermission(t), undefined);
    t.info.waitingFor = "permission prompt";
    d.managed.remove(SID);
    assert.equal(d.openPermission(t), undefined);
  } finally {
    await done();
  }
});

test("allowing puts the cursor on Yes and presses Enter", async () => {
  const c = new FakeClaude();
  c.cursor = 2;
  const { d, done } = await setup(c);
  try {
    assert.deepEqual(await d.answerDialog(answer({})), { ok: true });
    assert.deepEqual(c.keys, ["Up", "Up", "Enter"]);
    assert.equal(c.answered, "yes");
  } finally {
    await done();
  }
});

test("denying presses Esc and sends a message given as the next message; other answers press nothing", async () => {
  const c = new FakeClaude();
  const { d, done } = await setup(c);
  try {
    assert.match((await d.answerDialog(answer({ decision: "always" }))).error, /今後も許可することはできません/);
    assert.match((await d.answerDialog(answer({ permissionId: "dialog:toolu_0" }))).error, /すでに答えられて/);
    const real = c.ansi.bind(c);
    c.ansi = () => real().replace("1. Yes", "1. Opus");
    assert.match((await d.answerDialog(answer({}))).error, /確認の画面が見当たらない/);
    c.ansi = real;
    assert.deepEqual(c.keys, []);

    assert.deepEqual(await d.answerDialog(answer({ decision: "deny", message: "先にテストを書いて" })), { ok: true, queued: true });
    assert.deepEqual(c.keys, ["Esc"]);
    assert.equal(c.answered, "no");
    assert.equal(d.managed.pending(SID), 1);
  } finally {
    await done();
  }
});

test("nothing is pressed while the dialog is about another call than the card's", async () => {
  const c = new FakeClaude();
  c.cursor = 2;
  const { d, done } = await setup(c);
  try {
    const t = d.tracked.get(SID);
    // The card shows the second call (the screen was read while its dialog was open); the terminal asks about the first.
    t.dialog = permissionDialogText(dialog(0, SECOND));
    for (const decision of ["allow", "deny"]) {
      assert.match((await d.answerDialog(answer({ permissionId: "dialog:toolu_4", decision }))).error, /確かめられない/);
    }
    assert.deepEqual(c.keys, []);
    // While the cursor moves, the first is answered in the terminal and the second's dialog opens: Enter is not pressed.
    t.dialog = undefined;
    c.onKey = () => (c.command = SECOND);
    assert.match((await d.answerDialog(answer({}))).error, /確かめられない/);
    assert.deepEqual(c.keys, ["Up", "Up"]);
    assert.equal(c.answered, undefined);
  } finally {
    await done();
  }
});
