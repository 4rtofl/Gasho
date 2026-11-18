#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
// The fake claude (fakes.ts). Besides the table, it answers `claude agents --json` and the control requests of
// `claude -p --input-format stream-json` (the Agent SDK's initialize and get_usage, which the usage plugin sends). Run in
// a terminal of gasho-daemon (`claude --remote-control=<name> …`), it is a session: it draws a prompt box as Claude
// Code does (what apps/daemon/src/managed.ts reads), is listed by `claude agents` while it runs, and answers each text
// sent to it, writing both into its transcript (~/.claude/projects/<folder>/<session>.jsonl).
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { type AgentRow, type ClaudeTable, FAKES_DIR, readTable } from "../fakes.ts";
import { runFake } from "./run.ts";

/** Where each session the fake runs is listed while it runs, by its pid. */
const sessionsDir = () => path.join(os.homedir(), FAKES_DIR, "claude-sessions");

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runningSessions(): AgentRow[] {
  const dir = sessionsDir();
  const rows: AgentRow[] = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    try {
      const row = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as AgentRow;
      if (row.pid && alive(row.pid)) rows.push(row);
    } catch {
      // being written
    }
  }
  return rows;
}

/** Answers each control request on stdin with a control response on stdout, until stdin ends. */
async function controlRequests(table: ClaudeTable): Promise<number> {
  for await (const line of readline.createInterface({ input: process.stdin })) {
    let m: { type?: unknown; request_id?: unknown; request?: { subtype?: unknown } };
    try {
      m = JSON.parse(line) as typeof m;
    } catch {
      continue;
    }
    if (m.type !== "control_request" || typeof m.request_id !== "string") continue;
    const subtype = String(m.request?.subtype);
    const answer = table.controls?.[subtype] ?? (subtype === "initialize" ? { response: {} } : { error: `fake claude: no answer for ${subtype}` });
    const response =
      "error" in answer
        ? { subtype: "error", request_id: m.request_id, error: answer.error }
        : { subtype: "success", request_id: m.request_id, response: answer.response };
    process.stdout.write(`${JSON.stringify({ type: "control_response", response })}\n`);
  }
  return 0;
}

const COLS = 50;
const RULE = "─".repeat(COLS);
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;

/** `text` cut into lines of at most `cols` columns (a wide character takes two). */
function fold(text: string, cols: number): string[] {
  const lines: string[] = [];
  let line = "";
  let width = 0;
  for (const ch of text) {
    const w = WIDE.test(ch) ? 2 : 1;
    if (width + w > cols) {
      lines.push(line);
      line = "";
      width = 0;
    }
    line += ch;
    width += w;
  }
  lines.push(line);
  return lines;
}

/** A session in a terminal, until the terminal closes it. */
function session(args: string[]): Promise<number> {
  const resume = args.indexOf("--resume") >= 0 ? args[args.indexOf("--resume") + 1] : undefined;
  const sessionId = resume && !args.includes("--fork-session") ? resume : randomUUID();
  const cwd = process.cwd();
  const row: AgentRow = { pid: process.pid, cwd, kind: "interactive", startedAt: Date.now(), sessionId, name: args[0]?.slice("--remote-control=".length), status: "idle" };
  const rowFile = path.join(sessionsDir(), `${process.pid}.json`);
  fs.mkdirSync(sessionsDir(), { recursive: true });
  const saveRow = () => {
    fs.writeFileSync(`${rowFile}.tmp`, JSON.stringify(row));
    fs.renameSync(`${rowFile}.tmp`, rowFile);
  };
  saveRow();
  const transcript = path.join(os.homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);
  let parent: string | null = null;
  const record = (role: "user" | "assistant", text: string) => {
    const uuid = randomUUID();
    const message = role === "user" ? { role, content: text } : { role, model: "claude-opus-5-5", content: [{ type: "text", text }] };
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.appendFileSync(transcript, `${JSON.stringify({ type: role, uuid, parentUuid: parent, sessionId, cwd, timestamp: new Date().toISOString(), message })}\n`);
    parent = uuid;
  };

  const said: string[] = [];
  let typed = "";
  const draw = () => {
    const box = fold(typed, COLS - 2).map((l, i) => (i === 0 ? `❯ ${l}` : `  ${l}`));
    const name = row.name ? `${"─".repeat(Math.max(0, COLS - row.name.length - 3))} ${row.name} ─` : RULE;
    const footer = ["  ? for shortcuts"];
    const room = Math.max(0, (process.stdout.rows || 50) - box.length - 2 - footer.length - 1);
    const lines = [...said.slice(-room), name, ...box, RULE, ...footer];
    process.stdout.write(`\x1b[H\x1b[2J${lines.join("\r\n")}`);
  };
  const reply = async (text: string) => {
    said.push(...fold(`> ${text}`, COLS));
    row.status = "busy";
    saveRow();
    record("user", text);
    draw();
    const table = await readTable<ClaudeTable>(os.homedir(), "claude");
    const answer = table.replies?.find((r) => r.text === text)?.reply ?? `fake claude: ${text}`;
    said.push(...fold(`● ${answer}`, COLS), "");
    record("assistant", answer);
    row.status = "idle";
    saveRow();
    draw();
  };

  process.stdin.setRawMode(true);
  // Pastes come between the bracketed-paste markers (apps/daemon/src/terminal.ts).
  process.stdout.write("\x1b[?2004h");
  let pending = "";
  process.stdin.on("data", (chunk) => {
    pending += chunk.toString("utf8");
    for (;;) {
      if (pending.startsWith("\x1b[200~")) {
        const end = pending.indexOf("\x1b[201~");
        if (end < 0) break;
        typed += pending.slice(6, end);
        pending = pending.slice(end + 6);
        continue;
      }
      const ch = pending[0];
      if (ch === undefined) break;
      // The start of a paste marker that the next chunk completes.
      if (ch === "\x1b" && "\x1b[200~".startsWith(pending)) break;
      // An escape sequence that is not a paste (an arrow) is let go; a lone Esc does nothing.
      const seq = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])?/.exec(pending)?.[0];
      if (seq) {
        if (seq === "\x1b" && pending.length === 1) pending = "";
        else pending = pending.slice(seq.length);
        continue;
      }
      pending = pending.slice(ch.length);
      if (ch === "\r") {
        const text = typed.trim();
        typed = "";
        const rename = /^\/rename\s+(.+)$/.exec(text);
        if (rename?.[1]) {
          row.name = rename[1];
          saveRow();
        } else if (text) void reply(text);
      } else if (ch === "\x15") typed = "";
      else if (ch === "\x7f") typed = Array.from(typed).slice(0, -1).join("");
      else if (ch >= " ") typed += ch;
    }
    draw();
  });
  process.stdout.on("resize", draw);
  draw();
  return new Promise((resolve) => {
    const end = () => {
      fs.rmSync(rowFile, { force: true });
      resolve(0);
    };
    process.stdin.on("end", end);
    for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(sig, end);
  });
}

await runFake<ClaudeTable>("claude", async (table, args) => {
  if (args[0] === "agents" && args.includes("--json")) {
    process.stdout.write(`${JSON.stringify([...(table.agents ?? []), ...runningSessions()])}\n`);
    return 0;
  }
  if (args.includes("-p") && args.join(" ").includes("--input-format stream-json")) return controlRequests(table);
  if (args[0]?.startsWith("--remote-control=") && process.stdin.isTTY) return session(args);
  return undefined;
});
