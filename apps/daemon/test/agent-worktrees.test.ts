// The sessions Gasho starts do work in a worktree in a session of their own: the hook stops a subagent in a worktree
// and EnterWorktree (and nothing else), and the plugin gasho-daemon loads into them has the skills that say how.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { guardHooks, guardReply, LAUNCH_SKILL, NODE_GUARD, PLUGIN_DIR, PLUGIN_NAME, SYSTEM_PROMPT } from "../src/agent-worktrees.ts";
import { listSkills } from "../src/skills.ts";
import { NATIVE_HOST } from "../src/terminal.ts";

const pre = (tool_name: string, tool_input: Record<string, unknown>) => ({ hook_event_name: "PreToolUse", session_id: "s", tool_name, tool_input });

test("a subagent in a worktree and EnterWorktree are stopped, with the way to do it instead", () => {
  for (const payload of [pre("Agent", { prompt: "do it", isolation: "worktree" }), pre("Task", { isolation: "worktree" }), pre("EnterWorktree", {})]) {
    const r = guardReply(payload);
    assert.equal(r?.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(r?.hookSpecificOutput.permissionDecision, "deny");
    assert.ok(r?.hookSpecificOutput.permissionDecisionReason.includes("gasho-daemon session launch"));
    assert.ok(r?.hookSpecificOutput.permissionDecisionReason.includes(LAUNCH_SKILL));
  }
  assert.match(SYSTEM_PROMPT, /gasho-daemon session launch/);
});

test("subagents without a worktree, other tools and what cannot be read are let through", () => {
  for (const payload of [
    pre("Agent", { prompt: "look", subagent_type: "Explore" }),
    pre("Agent", { isolation: "remote" }),
    pre("Bash", { command: "git worktree add ../x" }),
    pre("ExitWorktree", {}),
    {},
    null,
    "text",
  ]) {
    assert.equal(guardReply(payload), undefined);
  }
});

const agyDenied = [
  "agy acp", "/opt/tools/agy --help", "pwd; agy", "pwd && /bin/agy", "pwd || agy", "echo x | agy", "pwd\n'./agy'",
  "timeout 60 agy acp", "FOO=1 agy", "env agy", "env FOO=1 agy", "sudo agy", "nohup agy &", "exec agy", "xargs agy",
  'bash -c "agy acp"', "sh -lc 'agy'", "if true; then agy; fi", "{ agy; }", "echo `agy`", 'echo "`/bin/agy`"',
];
const agyAllowed = [
  "which agy", "command -v agy", "grep agy file", "timeout 60 grep agy file", 'echo "bash -c agy"', "FOO=agy ls",
  "printf '%s' 'look; agy'", "echo /bin/agy", "agy-helper", "echo '`agy`'", "bash script -c agy", "sh -lc '' agy",
];

test("Bash blocks agy in command position without blocking mentions of agy", () => {
  for (const command of agyDenied) {
    assert.match(guardReply(pre("Bash", { command }))?.hookSpecificOutput.permissionDecisionReason ?? "", /agent から agy は実行できません/, command);
  }
  for (const command of agyAllowed) assert.equal(guardReply(pre("Bash", { command })), undefined, command);
});

/** The hooks, each with the reason it is skipped here, if it is. */
const HOOKS: { name: string; command: readonly string[]; skip: string | false }[] = [
  { name: "Node.js", command: NODE_GUARD, skip: false },
  {
    name: "Rust",
    command: [NATIVE_HOST, "worktree-guard-hook"],
    skip: !existsSync(NATIVE_HOST) && "the Rust terminal host is not built here (node apps/daemon/scripts/terminal-host.ts)",
  },
];

/** Runs the hook as Claude Code does: its command from the settings, with bash, the call on stdin. */
function runHook(command: readonly string[], stdin: string): Promise<string> {
  const line = (guardHooks(command).PreToolUse as { hooks: { command: string }[] }[])[0]?.hooks[0]?.command ?? "";
  return new Promise((resolve, reject) => {
    const child = execFile("bash", ["-c", line], (e, stdout) => (e ? reject(e) : resolve(stdout)));
    child.stdin?.end(stdin);
  });
}

for (const { name, command, skip } of HOOKS) {
  test(`the hook on ${name} prints guardReply's denial for Claude Code, word for word, and nothing for the rest`, { skip }, async () => {
    const calls = [
      pre("EnterWorktree", {}),
      pre("Agent", { prompt: "do it", isolation: "worktree" }),
      pre("Task", { isolation: "worktree" }),
      pre("Agent", { prompt: "look" }),
      pre("Agent", { isolation: "remote" }),
      pre("Bash", { command: "git worktree add ../x" }),
      ...[...agyDenied, ...agyAllowed].map((command) => pre("Bash", { command })),
      { tool_name: "Agent", tool_input: ["isolation"] },
      {},
    ];
    for (const call of calls) {
      const reply = guardReply(call);
      assert.equal(await runHook(command, JSON.stringify(call)), reply ? `${JSON.stringify(reply)}\n` : "", JSON.stringify(call));
    }
    assert.equal(await runHook(command, "not json"), "");
  });
}

test("the plugin has the skills, and the \"/\" menu of a session started with it lists them under its name", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.name, PLUGIN_NAME);
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "gasho-skills-"));
  try {
    const places = { claudeDir: path.join(empty, "claude"), claudeJson: path.join(empty, "claude.json"), cwd: empty };
    const names = (await listSkills({ ...places, pluginDirs: [PLUGIN_DIR] })).map((s) => s.name);
    assert.deepEqual(names, [LAUNCH_SKILL, `${PLUGIN_NAME}:remove-gasho-worktree`, `${PLUGIN_NAME}:verify-in-chrome`]);
    assert.deepEqual(await listSkills(places), []);
  } finally {
    await fs.rm(empty, { recursive: true, force: true });
  }
});
