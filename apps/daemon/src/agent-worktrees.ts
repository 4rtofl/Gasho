// How the sessions Gasho starts do work in a worktree: in a session of their own, started in the worktree with
// `gasho-daemon session launch` (the plugin's skill launch-gasho-session), so that Gasho shows it and the person can
// watch it. A subagent in a worktree (the Agent tool's `isolation: "worktree"`) or EnterWorktree would work there out of
// Gasho's sight. gasho-daemon starts each Claude Code with
// - its plugin (claude-plugin, next to src/ and lib/: the skills) with `--plugin-dir`,
// - a PreToolUse hook in its `--settings` (worktree-guard-hook, next to this file) that stops those two tools and says
//   what to do instead, and
// - the same rule in `--append-system-prompt`, so that Claude picks the session from the start.
// None of these touches the person's settings: they hold for the sessions Gasho starts, and only while they run.
// This file uses only Node.js's own modules: the hook imports it, and starts at every call of those tools.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);

/** The plugin's folder: apps/daemon/claude-plugin from src/, and the package's claude-plugin from lib/. */
export const PLUGIN_DIR = path.resolve(path.dirname(here), "..", "claude-plugin");
/** The plugin's name, as its skills are called ("gasho:launch-gasho-session"). */
export const PLUGIN_NAME = "gasho";
export const LAUNCH_SKILL = `${PLUGIN_NAME}:launch-gasho-session`;

/** The hook's script, next to this file (.ts when run from the repository, .js in the npm package). */
export const GUARD_FILE = path.join(path.dirname(here), `worktree-guard-hook${path.extname(here)}`);

/** The tools the hook looks at: the Agent tool (Task in older Claude Code) and EnterWorktree. */
export const GUARD_MATCHER = "Agent|Task|EnterWorktree";

/** What to do instead, shown to Claude when a tool is stopped and appended to the system prompt. */
const INSTEAD =
  `worktree を作り、その中に Gasho のセッションを \`gasho-daemon session launch\` で起動して、そのセッションに指示する。` +
  `手順はスキル ${LAUNCH_SKILL} にある（git worktree add で worktree を作り、` +
  "`gasho-daemon session launch --cwd <worktree> --name <名前> --trust --prompt-file <指示文>` で起動して指示文を送る）。";

export const SYSTEM_PROMPT =
  "このセッションは Gasho（gasho-daemon）が起動した。Gasho の利用者は、画面でセッションを見守る。" +
  "worktree で作業するとき、また作業を worktree に分けて任せるときは、Agent ツールの isolation: \"worktree\" の Subagent や EnterWorktree を使わず、" +
  `${INSTEAD}` +
  "「Subagent でやって」と頼まれても、worktree を使う作業はこの形にする（これらは hook で止められる）。" +
  "worktree を使わない Subagent（Explore などの調べもの）はそのまま使ってよい。";

/** What the hook answers to a tool call it stops (PreToolUse's `permissionDecision: "deny"`). */
export interface GuardReply {
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string };
}

/**
 * The hook's answer to a PreToolUse payload: a denial for EnterWorktree and for a subagent in a worktree, nothing for
 * the rest (Claude Code then goes on as without the hook).
 */
export function guardReply(payload: unknown): GuardReply | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  const input = p.tool_input && typeof p.tool_input === "object" ? (p.tool_input as Record<string, unknown>) : {};
  let what: string;
  if (p.tool_name === "EnterWorktree") what = "EnterWorktree";
  else if ((p.tool_name === "Agent" || p.tool_name === "Task") && input.isolation === "worktree") what = `${p.tool_name} の isolation: "worktree"`;
  else return undefined;
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `Gasho のセッションでは ${what} を使わない（worktree の中にセッションができず、Gasho の画面から作業を見守れないため）。` +
        `代わりに、${INSTEAD}` +
        "worktree を使わない Subagent はそのまま使ってよい。",
    },
  };
}

/** A word for the shell, as it is (Claude Code runs a hook's command with bash). */
function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The PreToolUse hook to put in a session's `--settings`. Claude Code adds it to the hooks of the person's and the
 * folder's settings; it replaces none of them.
 */
export function guardHooks(o: { node?: string; script?: string } = {}): Record<string, unknown> {
  return {
    PreToolUse: [
      {
        matcher: GUARD_MATCHER,
        hooks: [{ type: "command", command: `${shellQuote(o.node ?? process.execPath)} ${shellQuote(o.script ?? GUARD_FILE)}`, timeout: 10 }],
      },
    ],
  };
}

/** The arguments that give a session the plugin and the rule (the hook goes with the status line's `--settings`). */
export function agentWorktreeArgs(pluginDir = PLUGIN_DIR): string[] {
  return ["--plugin-dir", pluginDir, "--append-system-prompt", SYSTEM_PROMPT];
}
