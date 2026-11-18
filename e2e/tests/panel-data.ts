// What the panels of a session (the branch graph, the files) read from gasho-daemon, given by a test to a fake daemon:
// a session to open them from, a branch graph, and a session's folder kept in memory that answers dir.get, file.get
// and file.write as gasho-daemon does (apps/daemon/src/files.ts), so that a test can change a file as Claude would.
import { createHash } from "node:crypto";
import type { Page } from "@playwright/test";
import type { CommandResult, DirEntry, DirListing, FileContent, GitCommit, GitGraph, GitRef, HubToDaemon, SessionInfo } from "@gasho/protocol";
import { fileNameProblem } from "../../apps/daemon/src/files.ts";
import { commandResult, type FakeDaemon, type FakeDaemonOptions, fakeSession, type GashoHub } from "../harness/index.ts";

export const SESSION_ID = "5d1e7c2a-3b4f-4e6a-9c8d-2f1a0b9e8d71";

/** A working server named mac with one session in /work/gasho, on branch main. */
export function sessionDaemon(hub: GashoHub, o: FakeDaemonOptions & { session?: Partial<SessionInfo> } = {}): Promise<FakeDaemon> {
  const { session, ...rest } = o;
  return hub.fakeDaemon({
    name: "mac",
    ...rest,
    sessions: [fakeSession({ sessionId: SESSION_ID, cwd: "/work/gasho", name: "e2e-session", gitBranch: "main", ...session })],
  });
}

/** The session's screen, or one of its panels (`/graph`, `/files/src`, `/file/README.md`). */
export const sessionUrl = (d: FakeDaemon, panel = "", sessionId = SESSION_ID): string =>
  `/#/s/${encodeURIComponent(d.machineId)}/${sessionId}${panel}`;

/** On a phone the session's header starts closed (lib/session-header.ts); its buttons open the panels. */
export async function showSessionHeader(page: Page, isMobile: boolean): Promise<void> {
  if (isMobile) await page.getByRole("button", { name: "ヘッダーを表示" }).click();
}

/**
 * Playwright's clock, paused at `time`: what the screen shows from the time (relative times, "hh:mm に読み込み") stays
 * as it is until the test moves the clock (page.clock.fastForward).
 */
export async function pauseClockAt(page: Page, time: number): Promise<void> {
  // Installed a little before, as the clock runs from it until paused.
  await page.clock.install({ time: time - 60_000 });
  await page.clock.pauseAt(time);
}

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** A commit's hash, the same for the same name. */
export const hashOf = (name: string): string => createHash("sha1").update(name).digest("hex");

/** A commit named `name` (its subject, unless given), whose parents are named too. */
export function commit(name: string, o: { parents?: string[]; subject?: string; author?: string; at: number; refs?: GitRef[] }): GitCommit {
  return { hash: hashOf(name), parents: (o.parents ?? []).map(hashOf), subject: o.subject ?? name, author: o.author ?? "e2e", at: o.at, refs: o.refs ?? [] };
}

/** A graph, or an error, or nothing: the Gasho server waits, and gives up after 15 seconds. */
type GraphAnswer = GitGraph | { error: string } | undefined;

/** Answers git.graph.get (with the repository asked for, inside the session's folder) with `answer`. */
export function serveGraph(d: FakeDaemon, answer: (repo: string | undefined) => GraphAnswer | Promise<GraphAnswer>): void {
  d.handle("git.graph.get", async (msg) => {
    const a = await answer(msg.repo);
    if (!a) return undefined;
    const reply = { type: "git.graph" as const, requestId: msg.requestId, sessionId: msg.sessionId, ...(msg.repo ? { repo: msg.repo } : {}) };
    return "error" in a ? { ...reply, error: a.error } : { ...reply, graph: a };
  });
}

type FileWrite = Extract<HubToDaemon, { type: "file.write" }>;

/** The folder that holds `path` ("" for the session's folder), and its name. */
function splitPath(path: string): [string, string] {
  const i = path.lastIndexOf("/");
  return [path.slice(0, Math.max(i, 0)), path.slice(i + 1)];
}

/**
 * A session's folder: its files by path ("src/main.ts"), and the folders that hold them. `extra` adds to a folder what
 * is no file of `files` (an empty folder, a link, a socket).
 */
export class FakeFolder {
  readonly files = new Map<string, FileContent>();
  readonly extra = new Map<string, DirEntry[]>();
  /** Folders that are sent with only their first entries. */
  readonly truncated = new Set<string>();
  /** Every file.write, oldest first. */
  readonly writes: FileWrite[] = [];
  /** When a file is written (the screen's clock may be Playwright's). */
  now: () => number;

  constructor(d: FakeDaemon, o: { now?: () => number } = {}) {
    this.now = o.now ?? Date.now;
    d.handle("dir.get", (msg) => {
      const dir = this.listing(msg.path);
      return { type: "dir", requestId: msg.requestId, sessionId: msg.sessionId, path: msg.path, ...(dir ? { dir } : { error: "フォルダーが見つかりません。" }) };
    });
    d.handle("file.get", (msg) => {
      const file = this.files.get(msg.path);
      return { type: "file", requestId: msg.requestId, sessionId: msg.sessionId, path: msg.path, ...(file ? { file } : { error: "ファイルが見つかりません。" }) };
    });
    d.handle("file.write", (msg) => {
      this.writes.push(msg);
      return commandResult(msg, this.write(msg));
    });
  }

  /** As writeFileAt (apps/daemon/src/files.ts) answers, in the same order. */
  private write(msg: FileWrite): CommandResult {
    const { path, create } = msg;
    const at = this.entryAt(path);
    if (create) {
      const [parent, name] = splitPath(path);
      const nameWrong = fileNameProblem(name);
      if (nameWrong) return { ok: false, error: nameWrong };
      const folder = parent === "" ? { kind: "dir" } : this.entryAt(parent);
      if (!folder) return { ok: false, error: `見つかりません：${parent}` };
      if (folder.kind !== "dir") return { ok: false, error: `フォルダーではありません：${parent}` };
      // Anything already there, a broken link included (O_EXCL).
      if (at) return { ok: false, error: `同じ名前のファイルかフォルダーが、すでにあります：${path}` };
    } else {
      // A broken link (listed with the kind "other").
      if (!at || (at.link && at.kind === "other")) return { ok: false, error: `見つかりません：${path}` };
      if (at.outside) return { ok: false, error: "セッションのフォルダーの外を指すリンクは開けません。" };
      if (at.kind === "dir") return { ok: false, error: `フォルダーです：${path}` };
      if (at.kind !== "file") return { ok: false, error: `ふつうのファイルではないので、保存できません：${path}` };
      const was = this.files.get(path);
      if (msg.baseHash !== undefined && was?.hash !== msg.baseHash) {
        return { ok: false, error: "このファイルは、開いたあとで変更されています。", conflict: true };
      }
      if (was && !was.writable) return { ok: false, error: `書き込む権限がありません：${path}` };
    }
    const file = this.text(path, msg.content);
    return { ok: true, written: { hash: file.hash!, size: file.size, mtime: file.mtime } };
  }

  /** What is at `path` (a file, a folder, a link…), as its folder lists it. Undefined when nothing is there. */
  private entryAt(path: string): DirEntry | undefined {
    const [parent, name] = splitPath(path);
    return this.listing(parent)?.entries.find((e) => e.name === name);
  }

  /** Writes a text file, as Claude would. */
  text(path: string, text: string, o: { mtime?: number; writable?: boolean } = {}): FileContent {
    const file: FileContent = { path, size: Buffer.byteLength(text), mtime: o.mtime ?? this.now(), hash: sha256(text), text, writable: o.writable ?? true };
    this.files.set(path, file);
    return file;
  }

  /** A file that is no text: an image, a binary file (or a text in another encoding than UTF-8), one too large to send. */
  other(path: string, o: Omit<FileContent, "path" | "mtime" | "writable"> & { mtime?: number }): void {
    this.files.set(path, { mtime: this.now(), writable: true, ...o, path });
  }

  /** As gasho-daemon lists a folder: folders first, then by name. Undefined when there is no such folder. */
  listing(path: string): DirListing | undefined {
    const prefix = path ? `${path}/` : "";
    const entries = new Map<string, DirEntry>();
    for (const [p, f] of this.files) {
      if (!p.startsWith(prefix)) continue;
      const [name, ...rest] = p.slice(prefix.length).split("/");
      if (!name) continue;
      entries.set(name, rest.length > 0 ? { name, kind: "dir" } : { name, kind: "file", size: f.size, mtime: f.mtime });
    }
    for (const e of this.extra.get(path) ?? []) entries.set(e.name, e);
    if (path !== "" && entries.size === 0 && !this.extra.has(path)) return undefined;
    const sorted = [...entries.values()].sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name));
    return { path, entries: sorted, truncated: this.truncated.has(path) };
  }
}
