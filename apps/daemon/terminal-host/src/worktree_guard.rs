// The PreToolUse hook of the sessions gasho-daemon starts, in Rust: what ../../src/worktree-guard-hook.ts does, without
// starting Node.js for every matching call (`gasho-terminal-host worktree-guard-hook`, with the call as JSON on stdin).
// The denials match guardReply in agent-worktrees.ts. The tests compare the two.
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
    // Antigravity の FAQ は agent から agy を呼ぶ使い方をサポートしていない（アカウント停止の対象になりうる）。
    // Bash でのうっかり実行を防ぐため、コマンド位置だけを見る。回避はできる。#331
    if tool == "Bash" && p["tool_input"]["command"].as_str().is_some_and(runs_agy) {
        return Some(json!({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": "agent から agy は実行できません。Antigravity を使うときは、利用者が Gasho の画面から操作してください。",
            }
        }));
    }
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

fn runs_agy(command: &str) -> bool {
    let mut words = Vec::new();
    let mut word = None;
    let mut quote = None;
    let mut escaped = false;
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        if escaped {
            if c != '\n' {
                word.get_or_insert_with(String::new).push(c);
            }
            escaped = false;
        } else if c == '\\' && quote != Some('\'') {
            escaped = true;
        } else if c == '`' && quote != Some('\'') {
            let mut body = String::new();
            for part in chars.by_ref() {
                if part == '`' && !escaped {
                    if runs_agy(&body) {
                        return true;
                    }
                    break;
                }
                body.push(part);
                escaped = part == '\\' && !escaped;
            }
        } else if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                word.get_or_insert_with(String::new).push(c);
            }
        } else if c == '\'' || c == '"' {
            quote = Some(c);
            word.get_or_insert_with(String::new);
        } else if " \t\r\n;|&()<>".contains(c) {
            words.extend(word.take());
            if "\n;|&()".contains(c) {
                if runs_agy_words(&words) {
                    return true;
                }
                words.clear();
            }
        } else {
            word.get_or_insert_with(String::new).push(c);
        }
    }
    words.extend(word);
    runs_agy_words(&words)
}

fn runs_agy_words(words: &[String]) -> bool {
    let mut words = words.iter();
    while let Some(word) = words.next() {
        if matches!(word.as_str(), "{" | "if" | "then" | "elif" | "else" | "while" | "until" | "do") {
            continue;
        }
        if let Some((name, _)) = word.split_once('=') {
            let mut chars = name.chars();
            if chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                continue;
            }
        }

        let bin = word.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        match bin {
            "agy" => return true,
            "env" | "sudo" | "nohup" | "exec" | "xargs" => continue,
            "timeout" => {
                words.next();
                continue;
            }
            "sh" | "bash" | "dash" | "zsh" => {
                while let Some(flag) = words.next().and_then(|word| word.strip_prefix('-')) {
                    if flag == "-" {
                        break;
                    }
                    if flag.contains('c') && flag.chars().all(|c| c.is_ascii_alphabetic()) {
                        return words.next().is_some_and(|script| runs_agy(script));
                    }
                }
            }
            _ => {}
        }
        return false;
    }
    false
}
