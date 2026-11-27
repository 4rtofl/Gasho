// The PreToolUse hook of the sessions gasho-daemon starts, in Rust: what ../../src/worktree-guard-hook.ts does, without
// starting Node.js at every call of the Agent tool (`gasho-terminal-host worktree-guard-hook`, with the call as JSON on
// stdin). It prints a denial for a subagent in a worktree and for EnterWorktree, and nothing for the rest; a payload it
// cannot read is let through. The words are those of guardReply in agent-worktrees.ts: the tests compare the two.
use std::io::{self, Read, Write};

use serde_json::{Value, json};

const INSTEAD: &str = concat!(
    "worktree を作り、その中に Gasho のセッションを `gasho-daemon session launch` で起動して、そのセッションに指示する。",
    "手順はスキル gasho:launch-gasho-session にある（git worktree add で worktree を作り、",
    "`gasho-daemon session launch --cwd <worktree> --name <名前> --trust --prompt-file <指示文>` で起動して指示文を送る）。",
);

pub fn run() {
    let mut input = Vec::new();
    let _ = io::stdin().read_to_end(&mut input);
    if let Some(reply) = reply(&input) {
        let _ = writeln!(io::stdout(), "{reply}");
    }
}

fn reply(input: &[u8]) -> Option<Value> {
    let p: Value = serde_json::from_slice(input).ok()?;
    let tool = p["tool_name"].as_str()?;
    let what = match tool {
        "EnterWorktree" => tool.to_string(),
        "Agent" | "Task" if p["tool_input"]["isolation"] == "worktree" => format!("{tool} の isolation: \"worktree\""),
        _ => return None,
    };
    Some(json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": format!(
                "Gasho のセッションでは {what} を使わない（worktree の中にセッションができず、Gasho の画面から作業を見守れないため）。代わりに、{INSTEAD}worktree を使わない Subagent はそのまま使ってよい。"
            ),
        }
    }))
}
