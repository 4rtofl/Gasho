import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isInside } from "./statusline.ts";

/**
 * The temporary folders of the Claude Codes that Gasho starts. Claude Code keeps a session's scratchpad and the output
 * of its background work in `<CLAUDE_CODE_TMPDIR>/claude-<uid>/<folder>/<session id>/`, and leaves them there when the
 * session ends. By default that is in /tmp, which is RAM on a machine where /tmp is a tmpfs (docs/research.md).
 */

/** A folder nothing has changed in for this long, of a session that does not run, is removed. */
export const CLAUDE_TMP_MAX_AGE_MS = 72 * 60 * 60_000;
/** How often the folders left behind are looked for. */
export const CLAUDE_TMP_SWEEP_MS = 60 * 60_000;

const SESSION_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * What Claude Code is given as CLAUDE_CODE_TMPDIR: a folder of this daemon's own, in GASHO_CLAUDE_TMPDIR when that is an
 * absolute path, or else in gasho's cache folder. A daemon knows only its own sessions, and would take the folders of
 * another daemon's on the same machine for ones left behind. The daemons are told apart by their state folders.
 */
export function claudeTmpRoot(stateDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const chosen = env.GASHO_CLAUDE_TMPDIR;
  const base = chosen && path.isAbsolute(chosen) ? chosen : path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "gasho", "claude-tmp");
  return path.join(base, createHash("sha256").update(path.resolve(stateDir)).digest("hex").slice(0, 12));
}

/** A real folder: not a symbolic link, and not a file. */
async function isRealDir(dir: string): Promise<boolean> {
  const stat = await fsp.lstat(dir).catch(() => undefined);
  return stat?.isDirectory() === true;
}

/** The real folders directly in `dir`, by name. */
async function realDirsIn(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** The `<folder>` level of Claude Code's layout, as it is on disk. Nothing when `claude-<uid>` is not a real folder. */
async function projectDirs(root: string, uid: number): Promise<string[]> {
  const own = path.join(root, `claude-${uid}`);
  if (!(await isRealDir(own))) return [];
  return (await realDirsIn(own)).map((name) => path.join(own, name));
}

/** Whether `dir` is a session's folder that may be removed: a real folder whose real path is inside `root`. */
async function removable(root: string, dir: string): Promise<boolean> {
  if (!SESSION_DIR_RE.test(path.basename(dir)) || !(await isRealDir(dir))) return false;
  const [realRoot, realDir] = await Promise.all([fsp.realpath(root), fsp.realpath(dir)]).catch(() => []);
  return realRoot !== undefined && realDir !== undefined && realDir !== realRoot && isInside(realDir, realRoot);
}

/** The folders Claude Code made for a session under `root`: looked up on disk, never put together from the session's folder. */
export async function sessionTmpDirs(root: string, sessionId: string, uid = process.getuid?.() ?? 0): Promise<string[]> {
  if (!SESSION_DIR_RE.test(sessionId)) return [];
  const found: string[] = [];
  for (const project of await projectDirs(root, uid)) {
    const dir = path.join(project, sessionId);
    if (await removable(root, dir)) found.push(dir);
  }
  return found;
}

/** Removes a session's folders under `root`, and returns them. A symbolic link inside is removed, not followed. */
export async function removeSessionTmp(root: string, sessionId: string, uid = process.getuid?.() ?? 0): Promise<string[]> {
  const dirs = await sessionTmpDirs(root, sessionId, uid);
  for (const dir of dirs) {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rmdir(path.dirname(dir)).catch(() => undefined); // only when it is empty now
  }
  return dirs;
}

/** Whether anything in `dir` changed at `since` or later. What cannot be read counts as changed: it is then not removed. */
async function changedSince(dir: string, since: number): Promise<boolean> {
  const gone = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
  const folders = [dir];
  for (let folder = folders.pop(); folder !== undefined; folder = folders.pop()) {
    try {
      if ((await fsp.lstat(folder)).mtimeMs >= since) return true;
      for (const entry of await fsp.readdir(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) folders.push(file);
        else if ((await fsp.lstat(file)).mtimeMs >= since) return true;
      }
    } catch (e) {
      if (!gone(e)) return true;
    }
  }
  return false;
}

export interface SweepResult {
  removed: string[];
  failed: { dir: string; error: unknown }[];
}

/**
 * Removes the sessions' folders under `root` that nothing has changed in for `maxAgeMs`, except those `keep` names. Only
 * folders named as a session's id, at the level Claude Code puts them, are looked at. That also takes the folder Claude
 * Code makes when it starts, under an id no session goes on to use.
 */
export async function sweepClaudeTmp(
  root: string,
  {
    keep,
    now = Date.now(),
    maxAgeMs = CLAUDE_TMP_MAX_AGE_MS,
    uid = process.getuid?.() ?? 0,
  }: { keep: (sessionId: string) => boolean; now?: number; maxAgeMs?: number; uid?: number },
): Promise<SweepResult> {
  const result: SweepResult = { removed: [], failed: [] };
  for (const project of await projectDirs(root, uid)) {
    for (const name of await realDirsIn(project)) {
      const dir = path.join(project, name);
      if (keep(name) || !(await removable(root, dir)) || (await changedSince(dir, now - maxAgeMs))) continue;
      // Reading a large folder takes a while: the session may have been opened again meanwhile.
      if (keep(name)) continue;
      try {
        await fsp.rm(dir, { recursive: true, force: true });
        result.removed.push(dir);
      } catch (error) {
        result.failed.push({ dir, error });
      }
    }
    await fsp.rmdir(project).catch(() => undefined); // only when it is empty now
  }
  return result;
}
