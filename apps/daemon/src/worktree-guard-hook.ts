// The PreToolUse hook of the sessions Gasho starts (see agent-worktrees.ts). Claude Code runs it before each call of
// Agent, EnterWorktree and Bash, with the call as JSON on stdin. It prints the guard’s denial when one applies.
// A payload it cannot read is let through.
// Where the Rust terminal host runs, it does this instead (terminal-host/src/worktree_guard.rs; sessionCommands in
// statusline.ts).
import { readFileSync, writeSync } from "node:fs";
import { guardReply } from "./agent-worktrees.ts";

let payload: unknown;
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch {
  payload = undefined;
}
const reply = guardReply(payload);
if (reply) writeSync(1, `${JSON.stringify(reply)}\n`);
