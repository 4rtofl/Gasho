// The daemon's local control socket: a Unix socket in its state folder (0600, so only the user who runs it), through
// which `gasho-daemon session …` and `gasho-daemon worktree …` start sessions, type into them, list and remove them, and
// remove worktrees, without the Gasho server. One line of JSON per request, one line of JSON back, then the connection
// closes. What it does is what the same commands from the Gasho server do (Daemon.launch, input, rename, remove,
// removeWorktree): nothing of its own. Naming a worktree is the exception: the Gasho server keeps the names, and the
// daemon asks it.
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { AgentKind, CommandResult } from "@gasho/protocol";

export const CONTROL_SOCKET = "control.sock";

/** Unix sockets take a path of about 100 bytes at most (104 on macOS; see terminal.ts). */
const MAX_SOCKET_PATH = 100;
/** At most this much of a request is read (an input is at most MAX_INPUT characters; see daemon.ts). */
const MAX_REQUEST = 1024 * 1024;

export function controlSocketOf(stateDir: string): string {
  return path.join(stateDir, CONTROL_SOCKET);
}

export type ControlRequest =
  /** `launchedBy`: the id of the session whose Claude Code asks (its CLAUDE_CODE_SESSION_ID), remembered as the parent. */
  | { op: "session.launch"; cwd: string; name?: string; trust?: boolean; agent?: AgentKind; chrome?: boolean; launchedBy?: string }
  /** `chrome`: the copy has Claude in Chrome; without it, it has it when the session has it. */
  | { op: "session.fork"; sessionId: string; name?: string; chrome?: boolean }
  | { op: "session.input"; sessionId: string; text: string }
  | { op: "session.rename"; sessionId: string; name: string }
  | { op: "session.list" }
  | { op: "session.remove"; sessionId: string }
  | { op: "worktree.remove"; path: string; force?: boolean }
  /** No `name`: takes the worktree's name away. */
  | { op: "worktree.name"; path: string; name?: string };

/** A session Gasho started, as `session list` shows it. */
export interface ControlSession {
  sessionId: string;
  /** The ids it had before /clear: `send` and `remove` find it by them too. */
  previousSessionIds?: string[];
  /** The name `claude agents` (and so ListAgents) shows; the one to send a message to. */
  name: string;
  /** The name in Gasho, when it differs. */
  gashoName?: string;
  cwd: string;
  /** The agent that runs it. */
  agent: AgentKind;
  /** The terminal it runs in (`gasho-daemon attach <terminal>`); Codex's sessions have none. */
  terminal?: string;
  /** Started with `--chrome`: it has Claude in Chrome's browser tools. */
  chrome?: boolean;
  status: string;
  pendingInputs?: number;
  /** Its folder is gone (removed with `git worktree remove`, say): only `session remove` takes it away. */
  cwdMissing?: boolean;
  /** Started with `session launch` from another session: that session's id (its id now, while Gasho keeps it). */
  launchedBy?: string;
}

/** A session that worktree.remove ended. */
export interface EndedSession {
  sessionId: string;
  /** As Claude Code listed it before it ended; absent when it was not known. */
  name?: string;
}

/**
 * session.list: `sessions`. worktree.remove: the worktree's folder (`path`), the branch it had checked out (`branch`),
 * and the sessions it ended (`endedSessions`, also when it then failed). worktree.name: the worktree's top folder
 * (`path`) and the name it has now (`name`, absent once taken away). The rest as from the Gasho server.
 */
export type ControlReply = CommandResult & { sessions?: ControlSession[]; branch?: string; endedSessions?: EndedSession[]; name?: string };

/**
 * Listens on `file` and answers each request with `handle`. A socket left there by a daemon that ended is replaced;
 * one that still answers belongs to another gasho-daemon with the same state folder, and is left alone (then this one
 * has no control socket, and the returned promise rejects).
 */
export async function startControlServer(file: string, handle: (req: ControlRequest) => Promise<ControlReply>): Promise<net.Server> {
  if (Buffer.byteLength(file) > MAX_SOCKET_PATH) throw new Error(`the path of the control socket is too long: ${file}`);
  if (await answers(file)) throw new Error(`another gasho-daemon answers on ${file}`);
  await fsp.rm(file, { force: true });
  const server = net.createServer((c) => serve(c, handle));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(file, () => {
      server.off("error", reject);
      resolve();
    });
  });
  fs.chmodSync(file, 0o600);
  return server;
}

function answers(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const c = net.connect(file);
    c.once("connect", () => {
      c.destroy();
      resolve(true);
    });
    c.once("error", () => resolve(false));
  });
}

function serve(c: net.Socket, handle: (req: ControlRequest) => Promise<ControlReply>): void {
  let buf = "";
  let done = false;
  const reply = (r: ControlReply) => {
    done = true;
    c.end(`${JSON.stringify(r)}\n`);
  };
  c.setEncoding("utf8");
  c.on("error", () => undefined);
  c.on("data", (chunk: string) => {
    if (done) return;
    buf += chunk;
    if (buf.length > MAX_REQUEST) return reply({ ok: false, error: "the request is too long" });
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    let req: ControlRequest;
    try {
      req = parseRequest(JSON.parse(buf.slice(0, nl)));
    } catch (e) {
      return reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    done = true;
    handle(req).then(
      (r) => c.end(`${JSON.stringify(r)}\n`),
      (e: unknown) => c.end(`${JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) })}\n`),
    );
  });
}

/** The agent an option names. */
function agentOf(value: string | undefined): AgentKind | undefined {
  if (value === undefined || value === "claude" || value === "codex") return value;
  throw new Error(`unknown agent: ${value} (claude or codex)`);
}

/** Checks a request's fields (it comes from another process). */
export function parseRequest(v: unknown): ControlRequest {
  const r = (v ?? {}) as Record<string, unknown>;
  const s = (k: string, optional = false): string | undefined => {
    const x = r[k];
    if (x === undefined && optional) return undefined;
    if (typeof x !== "string") throw new Error(`${k} must be a string`);
    return x;
  };
  switch (r.op) {
    case "session.launch": {
      const name = s("name", true);
      const agent = agentOf(s("agent", true));
      const launchedBy = s("launchedBy", true);
      return {
        op: "session.launch",
        cwd: s("cwd")!,
        ...(name !== undefined ? { name } : {}),
        ...(r.trust === true ? { trust: true } : {}),
        ...(agent ? { agent } : {}),
        ...(r.chrome === true ? { chrome: true } : {}),
        ...(launchedBy ? { launchedBy } : {}),
      };
    }
    case "session.fork": {
      const name = s("name", true);
      return {
        op: "session.fork",
        sessionId: s("sessionId")!,
        ...(name !== undefined ? { name } : {}),
        ...(r.chrome === true ? { chrome: true } : {}),
      };
    }
    case "session.input":
      return { op: "session.input", sessionId: s("sessionId")!, text: s("text")! };
    case "session.rename":
      return { op: "session.rename", sessionId: s("sessionId")!, name: s("name")! };
    case "session.list":
      return { op: "session.list" };
    case "session.remove":
      return { op: "session.remove", sessionId: s("sessionId")! };
    case "worktree.remove":
      return { op: "worktree.remove", path: s("path")!, ...(r.force === true ? { force: true } : {}) };
    case "worktree.name": {
      const name = s("name", true);
      return { op: "worktree.name", path: s("path")!, ...(name !== undefined ? { name } : {}) };
    }
    default:
      throw new Error(`unknown op: ${String(r.op)}`);
  }
}

/** The daemon is not running (or is a version without the control socket). */
export class DaemonNotRunning extends Error {}

/** Sends one request to the daemon's control socket and returns its answer. */
export function controlRequest(file: string, req: ControlRequest, timeoutMs = 120_000): Promise<ControlReply> {
  return new Promise((resolve, reject) => {
    const c = net.connect(file);
    let buf = "";
    let settled = false;
    const finish = (err: Error | undefined, r?: ControlReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      c.destroy();
      if (err) reject(err);
      else resolve(r!);
    };
    const timer = setTimeout(() => finish(new Error(`gasho-daemon did not answer on ${file} in time`)), timeoutMs);
    c.setEncoding("utf8");
    c.once("connect", () => c.write(`${JSON.stringify(req)}\n`));
    c.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        finish(undefined, JSON.parse(buf.slice(0, nl)) as ControlReply);
      } catch {
        finish(new Error(`a bad answer from ${file}`));
      }
    });
    c.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") {
        finish(
          new DaemonNotRunning(
            `gasho-daemon is not running: nothing answers on ${file}.\n` +
              "Start it (gasho-daemon run, or gasho-daemon service install to keep it running). If it runs, it may be a version " +
              "without the control socket: update it from Gasho, or use the state folder it runs with (GASHO_DAEMON_CONFIG).",
          ),
        );
      } else {
        finish(e);
      }
    });
    c.on("close", () => finish(new Error(`gasho-daemon closed the connection on ${file} without an answer`)));
  });
}

// ---- `gasho-daemon session …` ----

export const SESSION_USAGE = `  session launch --cwd DIR [--name NAME] [--agent claude|codex] [--trust] [--chrome] [--prompt TEXT | --prompt-file FILE | --prompt -]
                                                   start a session in DIR (as Gasho does) and wait for it; with a
                                                   prompt, type it in. Prints {sessionId, name, cwd, terminal} as JSON:
                                                   "name" is the name Claude Code lists it under (ListAgents). With
                                                   --name, the session is renamed to NAME first; without it, Gasho names
                                                   it after its first message later, so its name changes then.
                                                   --trust answers Claude Code's "trust this folder?" with yes.
                                                   --agent codex starts Codex instead of Claude Code (it has no terminal).
                                                   --chrome starts it with Claude in Chrome (claude --chrome): it can
                                                   drive the person's Chrome (on this machine, or on another computer
                                                   whose Claude extension is signed in to the same account)
  session fork <NAME|ID> [--name NAME] [--chrome] [--prompt TEXT | --prompt-file FILE | --prompt -]
                                                   copy a session Gasho started, with its conversation so far, into a
                                                   new one in the same folder (as Gasho's fork does), and wait for it;
                                                   with a prompt, type it in. --chrome gives the copy Claude in Chrome
                                                   (a fork of a session that has it has it anyway). Prints {sessionId,
                                                   name, cwd, terminal, forkOf} as JSON
  session send <NAME|ID> (--text TEXT | --file FILE | -)
                                                   type a message into a session Gasho started (it waits while the
                                                   session works)
  session list [--json]                            list the sessions Gasho started, with their agents; "(folder
                                                   missing)" (cwdMissing in JSON) marks one whose folder is gone
  session remove <NAME|ID>                         end a session Gasho started and take it away from Gasho (its
                                                   conversation is kept); also one whose folder is gone. Prints
                                                   {sessionId, name, cwd} as JSON`;

export const WORKTREE_USAGE = `  worktree remove <DIR> [--force]                  remove a worktree with the sessions in it, as Gasho's screen does:
                                                   its sessions end first; with uncommitted changes or commits no remote
                                                   has, nothing is removed (unless --force). The branch is kept. Prints
                                                   {path, branch, ended: [{sessionId, name}]} as JSON
  worktree name <DIR> (<NAME> | --clear)           give the worktree DIR is in a name, which Gasho's sidebar shows in
                                                   place of its branch (quote a name with spaces or "#"), or take it away
                                                   (--clear). The Gasho server keeps the names, so the daemon must be
                                                   connected to it. Prints {path, name} as JSON`;

/** How long a worktree.remove may take: its sessions end (some seconds each) and git removes the folder (up to 90 s). */
const WORKTREE_REMOVE_WAIT_MS = 180_000;

export interface SessionCliIO {
  /** Sends a request to the daemon. */
  request: (req: ControlRequest) => Promise<ControlReply>;
  readFile: (file: string) => Promise<string>;
  readStdin: () => Promise<string>;
  out: (s: string) => void;
  /** Says what happens meanwhile (stderr). */
  note: (s: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /**
   * The session whose Claude Code runs the command (CLAUDE_CODE_SESSION_ID, which Claude Code gives the commands it
   * runs): a launch remembers it as the parent. Absent when run outside Claude Code.
   */
  callerSessionId?: string;
  /** How long a launch with a name waits for Claude Code to list the session under it. */
  renameWaitMs?: number;
  pollMs?: number;
}

/** Runs `gasho-daemon session <args>`. Throws (with a message to show) on failure. */
export async function sessionCommand(args: string[], io: SessionCliIO): Promise<void> {
  const sleep = io.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const opt = (name: string): string | undefined => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || (v.startsWith("--") && v !== "-")) throw new Error(`${name} needs a value`);
    return v;
  };
  const call = async (req: ControlRequest): Promise<ControlReply> => {
    const r = await io.request(req);
    if (!r.ok) throw new Error(r.error ?? `${req.op} failed`);
    return r;
  };
  const list = async (): Promise<ControlSession[]> => {
    const r = await call({ op: "session.list" });
    return r.sessions ?? [];
  };

  switch (args[0]) {
    case "launch": {
      const cwd = opt("--cwd");
      if (!cwd) throw new Error("session launch needs --cwd DIR");
      const name = opt("--name")?.trim() || undefined;
      const agent = agentOf(opt("--agent"));
      const prompt = await textOf(opt("--prompt"), opt("--prompt-file"), io, "--prompt");
      const launched = await call({
        op: "session.launch",
        cwd: path.resolve(cwd),
        ...(name ? { name } : {}),
        ...(args.includes("--trust") ? { trust: true } : {}),
        ...(agent ? { agent } : {}),
        ...(args.includes("--chrome") ? { chrome: true } : {}),
        ...(io.callerSessionId ? { launchedBy: io.callerSessionId } : {}),
      });
      const sessionId = launched.sessionId;
      if (!sessionId) throw new Error("gasho-daemon started no session");
      const warnings: string[] = [];
      if (launched.warning) warnings.push(launched.warning);
      let session = (await list()).find((s) => s.sessionId === sessionId);
      if (name && session?.name !== name) {
        // Claude Code lists a new session under a name of its own (the folder's), not the one given: /rename gives it
        // that name, in Claude Code and its Remote Control session, as a rename from Gasho does.
        await call({ op: "session.rename", sessionId, name });
        io.note(`renaming the session to "${name}"`);
        const until = Date.now() + (io.renameWaitMs ?? 60_000);
        while (Date.now() < until) {
          session = (await list()).find((s) => s.sessionId === sessionId);
          if (session?.name === name) break;
          await sleep(io.pollMs ?? 1000);
        }
        if (session?.name !== name) warnings.push(`Claude Code does not list the session as "${name}" yet; it still shows "${session?.name ?? "?"}"`);
      }
      if (!session) throw new Error(`the session ${sessionId} started, but gasho-daemon no longer lists it`);
      if (prompt !== undefined) {
        const sent = await call({ op: "session.input", sessionId, text: prompt });
        if (sent.warning) warnings.push(sent.warning);
      }
      io.out(
        JSON.stringify(
          {
            sessionId,
            name: session.name,
            cwd: session.cwd,
            ...(session.agent !== "claude" ? { agent: session.agent } : {}),
            ...(session.terminal ? { terminal: session.terminal } : {}),
            ...(session.chrome ? { chrome: true } : {}),
            ...(session.launchedBy ? { launchedBy: session.launchedBy } : {}),
            ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          },
          null,
          2,
        ),
      );
      return;
    }
    case "fork": {
      const target = args[1];
      if (!target || target.startsWith("--") || target === "-") throw new Error("session fork needs the session's name or id");
      const name = opt("--name")?.trim() || undefined;
      const prompt = await textOf(opt("--prompt"), opt("--prompt-file"), io, "--prompt");
      const source = pick(await list(), target);
      const forked = await call({
        op: "session.fork",
        sessionId: source.sessionId,
        ...(name ? { name } : {}),
        ...(args.includes("--chrome") ? { chrome: true } : {}),
      });
      const sessionId = forked.sessionId;
      if (!sessionId) throw new Error("gasho-daemon forked no session");
      const warnings: string[] = forked.warning ? [forked.warning] : [];
      // The daemon renames the copy with /rename; until Claude Code shows that, it lists the copy under the source's name.
      let session = (await list()).find((s) => s.sessionId === sessionId);
      const until = Date.now() + (io.renameWaitMs ?? 60_000);
      while (session?.gashoName !== undefined && Date.now() < until) {
        await sleep(io.pollMs ?? 1000);
        session = (await list()).find((s) => s.sessionId === sessionId);
      }
      if (!session) throw new Error(`the copy ${sessionId} started, but gasho-daemon no longer lists it`);
      if (session.gashoName !== undefined) warnings.push(`Claude Code does not list the copy as "${session.gashoName}" yet; it still shows "${session.name}"`);
      if (prompt !== undefined) {
        const sent = await call({ op: "session.input", sessionId, text: prompt });
        if (sent.warning) warnings.push(sent.warning);
      }
      io.out(
        JSON.stringify(
          {
            sessionId,
            name: session.name,
            cwd: session.cwd,
            ...(session.terminal ? { terminal: session.terminal } : {}),
            ...(session.chrome ? { chrome: true } : {}),
            forkOf: source.sessionId,
            ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          },
          null,
          2,
        ),
      );
      return;
    }
    case "send": {
      const target = args[1];
      if (!target || target.startsWith("--") || target === "-") throw new Error("session send needs the session's name or id");
      const text = await textOf(opt("--text"), opt("--file"), io, "--text", args.slice(2).includes("-"));
      if (text === undefined) throw new Error("session send needs --text TEXT, --file FILE or - (standard input)");
      const session = pick(await list(), target);
      const sent = await call({ op: "session.input", sessionId: session.sessionId, text });
      io.out(
        JSON.stringify(
          { sessionId: session.sessionId, name: session.name, queued: sent.queued === true, ...(sent.warning ? { warning: sent.warning } : {}) },
          null,
          2,
        ),
      );
      return;
    }
    case "list": {
      const sessions = await list();
      if (args.includes("--json")) {
        io.out(JSON.stringify(sessions, null, 2));
        return;
      }
      if (sessions.length === 0) io.out("no sessions started by Gasho are running");
      for (const s of sessions) io.out([s.name, s.status, s.cwd, s.sessionId, s.agent, ...(s.cwdMissing ? ["(folder missing)"] : [])].join("\t"));
      return;
    }
    case "remove": {
      const target = args[1];
      if (!target || target.startsWith("--")) throw new Error("session remove needs the session's name or id");
      const session = pick(await list(), target);
      await call({ op: "session.remove", sessionId: session.sessionId });
      io.out(JSON.stringify({ sessionId: session.sessionId, name: session.name, cwd: session.cwd }, null, 2));
      return;
    }
    default:
      throw new Error(`usage: gasho-daemon\n${SESSION_USAGE}`);
  }
}

/** The text given as TEXT, as a file, or as "-" (standard input); undefined when none is given. */
async function textOf(
  value: string | undefined,
  file: string | undefined,
  io: SessionCliIO,
  flag: string,
  dash = false,
): Promise<string | undefined> {
  const given = [value !== undefined, file !== undefined, dash].filter(Boolean).length;
  if (given > 1) throw new Error(`give the text only once (${flag}, a file, or -)`);
  if (value === "-" || dash) return io.readStdin();
  if (file !== undefined) return io.readFile(file);
  return value;
}

/** The session `target` names: its id, the name Claude Code lists, or its name in Gasho. */
export function pick(sessions: ControlSession[], target: string): ControlSession {
  const byId = sessions.find((s) => s.sessionId === target) ?? sessions.find((s) => s.previousSessionIds?.includes(target));
  if (byId) return byId;
  const named = sessions.filter((s) => s.name === target || s.gashoName === target);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) throw new Error(`${named.length} sessions are named "${target}"; give its id (gasho-daemon session list)`);
  throw new Error(`no session started by Gasho is named "${target}" (gasho-daemon session list shows them)`);
}

/** What `gasho-daemon worktree` needs: a way to send a request to the daemon, and to print. */
export interface WorktreeCliIO {
  /** Sends a request to the daemon; `timeoutMs`: how long to wait for its answer. */
  request: (req: ControlRequest, timeoutMs?: number) => Promise<ControlReply>;
  out: (s: string) => void;
  /** Resolves a relative path (against the current folder). */
  resolve?: (p: string) => string;
}

/** Runs `gasho-daemon worktree <args>`. Throws (with a message to show) on failure. */
export async function worktreeCommand(args: string[], io: WorktreeCliIO): Promise<void> {
  if (args[0] === "name") return nameCommand(args.slice(1), io);
  if (args[0] !== "remove") throw new Error(`usage: gasho-daemon\n${WORKTREE_USAGE}`);
  const dir = args.slice(1).find((a) => !a.startsWith("--"));
  const unknown = args.slice(1).filter((a) => a.startsWith("--") && a !== "--force");
  if (unknown.length > 0) throw new Error(`worktree remove does not take ${unknown.join(" ")}`);
  if (!dir || args.slice(1).filter((a) => !a.startsWith("--")).length > 1) throw new Error("worktree remove needs one folder: the worktree's");
  const force = args.includes("--force");
  const r = await io.request({ op: "worktree.remove", path: (io.resolve ?? path.resolve)(dir), ...(force ? { force: true } : {}) }, WORKTREE_REMOVE_WAIT_MS);
  if (!r.ok) {
    const ended = r.endedSessions ?? [];
    const also = ended.length > 0 ? `\n(ended meanwhile: ${ended.map((s) => s.name ?? s.sessionId).join(", ")})` : "";
    throw new Error(`${r.error ?? "worktree.remove failed"}${also}`);
  }
  io.out(
    JSON.stringify(
      { path: r.path, ...(r.branch ? { branch: r.branch } : {}), ended: r.endedSessions ?? [], ...(r.warning ? { warning: r.warning } : {}) },
      null,
      2,
    ),
  );
}

/** `gasho-daemon worktree name <DIR> (<NAME> | --clear)`. */
async function nameCommand(args: string[], io: WorktreeCliIO): Promise<void> {
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--clear");
  if (unknown.length > 0) throw new Error(`worktree name does not take ${unknown.join(" ")}`);
  const clear = args.includes("--clear");
  const given = args.filter((a) => a !== "--clear");
  if (given.length !== (clear ? 1 : 2)) {
    throw new Error('worktree name needs the folder and one name (quote a name with spaces or "#"), or the folder and --clear');
  }
  const [dir, name] = given as [string, string | undefined];
  const r = await io.request({ op: "worktree.name", path: (io.resolve ?? path.resolve)(dir), ...(name !== undefined ? { name } : {}) });
  if (!r.ok) throw new Error(r.error ?? "worktree.name failed");
  io.out(JSON.stringify({ path: r.path, ...(r.name ? { name: r.name } : {}) }, null, 2));
}
