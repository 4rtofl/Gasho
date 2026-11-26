// The sessions Gasho starts do work in a worktree in a session of their own: the hook stops a subagent in a worktree
// and EnterWorktree (and nothing else), and the plugin gasho-daemon loads into them has the skills that say how.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GUARD_FILE, guardHooks, guardReply, LAUNCH_SKILL, PLUGIN_DIR, PLUGIN_NAME, SYSTEM_PROMPT } from "../src/agent-worktrees.ts";
import { listSkills } from "../src/skills.ts";

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

function runHook(stdin: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [GUARD_FILE], (e, stdout) => (e ? reject(e) : resolve(stdout)));
    child.stdin?.end(stdin);
  });
}

test("the hook's script prints the denial for Claude Code, and nothing for the rest", async () => {
  const denied = JSON.parse(await runHook(JSON.stringify(pre("EnterWorktree", {}))));
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(await runHook(JSON.stringify(pre("Agent", { prompt: "look" }))), "");
  assert.equal(await runHook("not json"), "");
  // The command the settings give runs it the same way.
  const command = (guardHooks().PreToolUse as { hooks: { command: string }[] }[])[0]?.hooks[0]?.command ?? "";
  const out = await new Promise<string>((resolve, reject) => {
    const child = execFile("bash", ["-c", command], (e, stdout) => (e ? reject(e) : resolve(stdout)));
    child.stdin?.end(JSON.stringify(pre("Agent", { isolation: "worktree" })));
  });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
});

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
