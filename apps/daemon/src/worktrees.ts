// Removing a worktree of a repository (worktree.remove): which folders may be removed, what would be lost, and the
// removal itself. The sessions in the worktree are ended by the daemon before removeWorktree runs.
import fs from "node:fs/promises";
import path from "node:path";
import type { WorktreeChanges } from "@gasho/protocol";
import { git, listWorktrees, worktreeOf } from "./git.ts";

/** `git worktree remove` deletes the folder's files, node_modules included: it may take a while. */
const REMOVE_TIMEOUT_MS = 90_000;
const SHA_RE = /^[0-9a-f]{7,40}$/i;

export interface RemovableWorktree {
  /** Its top folder, as git names it (a real path). */
  path: string;
  /** The folder of its repository's main worktree. */
  repo: string;
  branch?: string;
}

/**
 * The worktree whose top folder is `dir`, when it may be removed: one that `git worktree list` lists, other than the
 * repository's main worktree. Any other folder is refused.
 */
export async function removableWorktree(dir: string): Promise<RemovableWorktree | { error: string }> {
  if (!path.isAbsolute(dir)) return { error: "フォルダーを絶対パスで指定してください。" };
  const real = await fs.realpath(dir).catch(() => undefined);
  if (!real) return { error: `フォルダーがありません：${dir}` };
  const own = await worktreeOf(real);
  if (!own) return { error: "このフォルダーは git のリポジトリではありません。" };
  if (own.path !== real) return { error: "worktree の中のフォルダーは削除できません。worktree のフォルダーそのものを指定してください。" };
  const listed = await listWorktrees(own.repo).catch(() => []);
  const at = listed.findIndex((w) => w.path === real);
  if (at < 0) return { error: "このフォルダーは、リポジトリの worktree の一覧にありません。" };
  // git lists the main worktree first: the repository's own folder, which holds .git.
  if (at === 0 || real === own.repo) return { error: "リポジトリの main の worktree（リポジトリのフォルダーそのもの）は削除できません。" };
  return { path: real, repo: own.repo, ...(listed[at]!.branch ? { branch: listed[at]!.branch } : {}) };
}

/**
 * What removing the worktree would lose: uncommitted changes (untracked files included, ignored ones not), and the
 * commits of its HEAD that no remote branch has. Commits given as `pushed` (and those before them) count as pushed,
 * such as the head of a pull request merged by squashing, whose branch on GitHub was then deleted.
 */
export async function worktreeChanges(dir: string, pushed: string[] = []): Promise<WorktreeChanges> {
  const status = await git(dir, ["status", "--porcelain", "--untracked-files=all"]);
  const uncommitted = status.split("\n").filter((l) => l.trim()).length;
  const hasHead = await git(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]).then(() => true, () => false);
  if (!hasHead) return { uncommitted, unpushed: 0 };
  // A commit this clone does not have cannot be one of HEAD's.
  const known = await Promise.all(
    [...new Set(pushed.filter((s) => SHA_RE.test(s)))].map((s) =>
      git(dir, ["rev-parse", "--verify", "--quiet", `${s}^{commit}`]).then((out) => out.trim() || undefined, () => undefined),
    ),
  );
  const out = await git(dir, ["rev-list", "--count", "HEAD", "--not", "--remotes", ...known.filter((s) => s !== undefined)]);
  return { uncommitted, unpushed: Number(out.trim()) || 0 };
}

/** Says what keeps a worktree from being removed, or undefined when nothing would be lost. */
export function changesProblem(c: WorktreeChanges): string | undefined {
  const parts = [c.uncommitted > 0 && `未コミットの変更が ${c.uncommitted} 件`, c.unpushed > 0 && `push していない commit が ${c.unpushed} 件`].filter(Boolean);
  if (parts.length === 0) return undefined;
  return `この worktree には${parts.join("、")}あるため、削除していません。`;
}

/**
 * Removes the worktree (`git worktree remove`; with `force`, also with changes, and when locked), then, with
 * `deleteBranch`, its branch (`git branch -D`: a branch merged by squashing is not merged as git sees it). A branch that
 * cannot be deleted leaves a warning: the worktree is gone by then.
 */
export async function removeWorktree(w: RemovableWorktree, opts: { force?: boolean; deleteBranch?: boolean }): Promise<{ warning?: string }> {
  const force = opts.force ? ["--force", "--force"] : [];
  try {
    await git(w.repo, ["worktree", "remove", ...force, w.path], REMOVE_TIMEOUT_MS);
  } catch (e) {
    throw new Error(`git worktree remove が失敗しました：${gitMessage(e)}`);
  }
  if (!opts.deleteBranch || !w.branch) return {};
  try {
    await git(w.repo, ["branch", "-D", w.branch]);
    return {};
  } catch (e) {
    return { warning: `worktree は削除しましたが、ブランチ ${w.branch} は削除できませんでした：${gitMessage(e)}` };
  }
}

function gitMessage(e: unknown): string {
  const stderr = (e as { stderr?: unknown })?.stderr;
  const text = typeof stderr === "string" && stderr.trim() ? stderr : e instanceof Error ? e.message : String(e);
  return text.trim().split("\n").slice(0, 3).join(" ").slice(0, 400);
}
