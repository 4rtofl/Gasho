// The PreToolUse hook of the sessions Gasho starts (see agent-worktrees.ts). Claude Code runs it before each call of
// the Agent tool and of EnterWorktree, with the call as JSON on stdin. It prints a denial for a subagent in a worktree
// and for EnterWorktree, and nothing for the rest. It never fails the call: a payload it cannot read is let through.
// Where the Rust terminal host runs, it does this instead (terminal-host/src/worktree_guard.rs; sessionCommands in
// statusline.ts).
import { guardReply } from "./agent-worktrees.ts";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
let payload: unknown;
try {
  payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  payload = undefined;
}
const reply = guardReply(payload);
if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
