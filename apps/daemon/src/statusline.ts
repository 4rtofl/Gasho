// What Claude Code reports to its status line, for the sessions Gasho starts: the context window and the Claude.ai
// plan's usage limits (docs/plugins.md, P14). Claude Code passes them, as JSON on stdin, only to the status line's
// command; no hook carries them. gasho-daemon starts each session with `--settings` that makes its status line
// command the relay, which sends them to the hook server (/statusline) and prints the status line the user set up, so
// that the terminal shows what it showed before. The relay is the Rust terminal host's `statusline-relay` where that
// runs (sessionCommands), else statusline-relay.ts (next to this file) on Node.js.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ContextWindow, PlanLimits, UsageWindow } from "@gasho/protocol";
import { NODE_GUARD } from "./agent-worktrees.ts";
import { NATIVE_HOST } from "./terminal.ts";
import { str } from "./util.ts";

const execFileP = promisify(execFile);

/** The relay's script, next to this file (.ts when run from the repository, .js in the npm package). */
export const RELAY_FILE = fileURLToPath(new URL(`./statusline-relay${path.extname(fileURLToPath(import.meta.url))}`, import.meta.url));

/**
 * The commands, as words, that Claude Code runs in the sessions Gasho starts: the status line's (the relay) and the
 * PreToolUse hook's (agent-worktrees.ts). Claude Code starts them at every update and every call of those tools.
 */
export interface SessionCommands {
  statusLine: readonly string[];
  guard: readonly string[];
}

/** The scripts on Node.js. */
export const NODE_COMMANDS: SessionCommands = { statusLine: [process.execPath, RELAY_FILE], guard: NODE_GUARD };

/**
 * The commands of the sessions started here: the Rust terminal host's, where it is there and runs the relay (one built
 * before the relay was in it takes the word for its settings file, and fails), else NODE_COMMANDS. Says why when there
 * is a Rust host that does not run it.
 */
export async function sessionCommands(log: (s: string) => void = () => undefined, native = NATIVE_HOST): Promise<SessionCommands> {
  try {
    // With nothing to send and no command of the user's, the relay reads its input and ends with 0.
    const run = execFileP(native, ["statusline-relay"], { env: {}, timeout: 10_000 });
    run.child.stdin?.end();
    await run;
    // A terminal host from before #331 would let Bash invoke agy.
    const probe = execFileP(native, ["worktree-guard-hook"], { env: {}, timeout: 10_000 });
    probe.child.stdin?.end(JSON.stringify({ tool_name: "Bash", tool_input: { command: "agy" } }));
    const guard = await probe;
    return {
      statusLine: [native, "statusline-relay"],
      guard: guard.stdout.includes('"permissionDecision":"deny"') ? [native, "worktree-guard-hook"] : NODE_COMMANDS.guard,
    };
  } catch (e) {
    if ((e as { code?: unknown }).code !== "ENOENT") {
      log(`the terminal host ${native} does not run the status line here (${e instanceof Error ? e.message : String(e)}); status lines and hooks run on Node.js`);
    }
    return NODE_COMMANDS;
  }
}

/** The variables the relay reads: where to send, the hook server's secret, and the user's own status line command. */
export const RELAY_URL_ENV = "GASHO_STATUSLINE_URL";
export const RELAY_SECRET_ENV = "GASHO_STATUSLINE_SECRET";
export const RELAY_COMMAND_ENV = "GASHO_STATUSLINE_COMMAND";

export function statusLineUrl(port: number): string {
  return `http://127.0.0.1:${port}/statusline`;
}

/** A status line as Claude Code's settings describe it (`statusLine`). */
export interface StatusLineSetting {
  type: "command";
  command: string;
  padding?: number;
  refreshInterval?: number;
  hideVimModeIndicator?: boolean;
}

function settingOf(v: unknown): StatusLineSetting | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s = v as Record<string, unknown>;
  const command = str(s.command)?.trim();
  if (s.type !== "command" || !command) return undefined;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const padding = num(s.padding);
  const refreshInterval = num(s.refreshInterval);
  return {
    type: "command",
    command,
    ...(padding !== undefined ? { padding } : {}),
    ...(refreshInterval !== undefined && refreshInterval >= 1 ? { refreshInterval } : {}),
    ...(s.hideVimModeIndicator === true ? { hideVimModeIndicator: true } : {}),
  };
}

/**
 * The status line the user set up for sessions in `cwd`, as Claude Code picks it: the folder's local settings, then
 * its shared ones, then the user's. The settings of an organization's policy are left out: they win over `--settings`
 * anyway, and then the relay never runs.
 */
export async function userStatusLine(cwd: string, claudeDir: string): Promise<StatusLineSetting | undefined> {
  for (const file of [path.join(cwd, ".claude", "settings.local.json"), path.join(cwd, ".claude", "settings.json"), path.join(claudeDir, "settings.json")]) {
    let settings: unknown;
    try {
      settings = JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
      continue;
    }
    const raw = settings && typeof settings === "object" ? (settings as Record<string, unknown>).statusLine : undefined;
    if (raw === undefined) continue;
    return settingOf(raw);
  }
  return undefined;
}

/** A word for the shell, as it is (bash runs the status line's command). */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * The arguments and the environment that make a session's status line command the relay. The user's own status line
 * keeps its padding and its interval, and the relay runs its command, so that the terminal shows what it showed.
 */
export function statusLineLaunch(o: {
  port: number;
  secret: string | undefined;
  user: StatusLineSetting | undefined;
  /** The relay's command (SessionCommands). */
  relay?: readonly string[];
  /** More settings to pass in the same `--settings`: the hooks of agent-worktrees.ts. */
  more?: Record<string, unknown>;
}): { args: string[]; env: Record<string, string> } {
  const { user } = o;
  const statusLine: StatusLineSetting = {
    type: "command",
    command: (o.relay ?? NODE_COMMANDS.statusLine).map(shellQuote).join(" "),
    ...(user?.padding !== undefined ? { padding: user.padding } : {}),
    ...(user?.refreshInterval !== undefined ? { refreshInterval: user.refreshInterval } : {}),
    ...(user?.hideVimModeIndicator ? { hideVimModeIndicator: true } : {}),
  };
  return {
    args: ["--settings", JSON.stringify({ ...o.more, statusLine })],
    env: {
      [RELAY_URL_ENV]: statusLineUrl(o.port),
      ...(o.secret ? { [RELAY_SECRET_ENV]: o.secret } : {}),
      ...(user ? { [RELAY_COMMAND_ENV]: user.command } : {}),
    },
  };
}

/** What a status line update says about a session (statusLineOf). */
export interface StatusLineReport {
  sessionId: string;
  context?: ContextWindow;
  limits?: PlanLimits;
}

const count = (v: unknown, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : undefined;

function windowOf(v: unknown): UsageWindow | undefined {
  if (!v || typeof v !== "object") return undefined;
  const w = v as Record<string, unknown>;
  const percent = count(w.used_percentage, 1000);
  // Unix time in seconds; up to a year ahead.
  const resetsAt = count(w.resets_at, Date.now() / 1000 + 366 * 86400);
  return percent !== undefined && resetsAt !== undefined ? { percent, resetsAt: Math.round(resetsAt * 1000) } : undefined;
}

/**
 * The context window and the plan's limits in what the relay sent (the status line's `session_id`, `context_window`
 * and `rate_limits`). The context window counts once the session has replied (`current_usage`); before that, Claude
 * Code knows only its size. The limits come with the replies of a Claude.ai plan.
 */
export function statusLineOf(body: unknown, now = Date.now()): StatusLineReport | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const sessionId = str(b.session_id);
  if (!sessionId || sessionId.length > 200) return undefined;
  const report: StatusLineReport = { sessionId };
  const c = b.context_window && typeof b.context_window === "object" ? (b.context_window as Record<string, unknown>) : undefined;
  if (c && c.current_usage && typeof c.current_usage === "object") {
    const used = count(c.total_input_tokens, 1e9);
    const size = count(c.context_window_size, 1e9);
    const percent = count(c.used_percentage, 100);
    if (used !== undefined && size !== undefined && size > 0 && percent !== undefined) report.context = { used, size, percent, at: now };
  }
  const r = b.rate_limits && typeof b.rate_limits === "object" ? (b.rate_limits as Record<string, unknown>) : undefined;
  if (r) {
    const fiveHour = windowOf(r.five_hour);
    const sevenDay = windowOf(r.seven_day);
    if (fiveHour || sevenDay) report.limits = { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), at: now };
  }
  return report;
}

/** Whether `dir` is `root` or inside it (both absolute). */
export function isInside(dir: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(dir));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
