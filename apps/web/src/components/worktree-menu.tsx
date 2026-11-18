// What can be done to a worktree from its row in the sidebar (Gasho's list, and a grouping's categories): remove it
// with the sessions in it. The menu opens with a right-click (a long press on a touch screen, the context menu key on a
// keyboard), as a session's does (session-menu). "削除…" opens a dialog, which the app keeps at its top
// (RemoveWorktreeDialog): it stays open while the sidebar redraws. Plugins remove worktrees the same way
// (removeWorktree, through the SDK's useRemoveWorktree).
import { Trash2 } from "lucide-react";
import { AlertDialog, ContextMenu } from "radix-ui";
import { useRef, useState, type ReactElement } from "react";
import type { RemoveWorktreeInput, RemoveWorktreeResult, WorktreeChanges } from "@gasho/plugin-sdk";
import { BUTTON_DANGER, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL, MENU, MENU_ITEM } from "@/components/dialog-styles";
import { StatusDot } from "@/components/status-badge";
import { sessionLabel } from "@/lib/format";
import { showNotice } from "@/lib/notice";
import { forgetWorktree } from "@/lib/remembered-worktrees";
import { go, parseHash } from "@/lib/route";
import type { WorktreeSessions } from "@/lib/sessions";
import { getAppState, sendCommand } from "@/lib/store";
import { cn } from "@/lib/utils";
import { removeWorktreeProblem, sessionsInWorktree, showsWorktree } from "@/lib/worktree-remove";

/** A little longer than the Gasho server waits (the sessions end, then git deletes the folder). */
const REMOVE_WAIT_MS = 160_000;

/**
 * Removes a worktree with its sessions. Once it is gone, the sidebar forgets it, and when the screen shows it (its
 * page, its tabs, one of its sessions) the home screen opens instead. A warning shows at the top of the screen. `via`: the plugin that asked, for the operations log.
 */
export async function removeWorktree(input: RemoveWorktreeInput, { via }: { via?: string } = {}): Promise<RemoveWorktreeResult> {
  const { machine, path, branch, force, pushed } = input;
  // As they are before it goes: once removed, its sessions are gone from the list.
  const m = getAppState().machines.find((x) => x.id === machine);
  const inside = m ? sessionsInWorktree(m, path).map((s) => s.sessionId) : [];
  const r = await sendCommand(
    machine,
    { type: "worktree.remove", path, ...(branch ? { branch } : {}), ...(force ? { force: true } : {}), ...(pushed?.length ? { pushed } : {}), ...(via ? { via } : {}) },
    REMOVE_WAIT_MS,
  );
  if (!r.ok) {
    return { ok: false, error: r.error ?? "削除できませんでした。", ...(r.changes ? { changes: r.changes } : {}), ...(r.ended?.length ? { sessions: r.ended } : {}) };
  }
  forgetWorktree(machine, path);
  if (showsWorktree(parseHash(location.hash), machine, path, [...inside, ...(r.ended ?? [])])) go({ name: "home" }, { replace: true });
  if (r.warning) showNotice(r.warning);
  return { ok: true, sessions: r.ended ?? [], ...(r.warning ? { warning: r.warning } : {}) };
}

/** The menu of a worktree's row; `children` is the row's button, which opens it. */
export function WorktreeContextMenu({
  worktree,
  onPick,
  children,
}: {
  worktree: WorktreeSessions;
  onPick: (worktree: WorktreeSessions) => void;
  children: ReactElement;
}) {
  // Focus goes back to the row when the menu closes, unless the dialog is opening from it.
  const picked = useRef(false);
  const problem = removeWorktreeProblem(worktree.machine, { path: worktree.path, repo: worktree.subfolders ? worktree.repoFolder : undefined });
  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (open) picked.current = false;
      }}
    >
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          collisionPadding={8}
          className={MENU}
          onCloseAutoFocus={(e) => {
            if (picked.current) e.preventDefault();
          }}
        >
          <ContextMenu.Label className="truncate px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground">{worktree.label}</ContextMenu.Label>
          <ContextMenu.Item
            disabled={problem !== undefined}
            onSelect={() => {
              picked.current = true;
              onPick(worktree);
            }}
            className={cn(MENU_ITEM, "text-red-400 data-[highlighted]:bg-red-500/10")}
          >
            <Trash2 />
            削除…
          </ContextMenu.Item>
          {problem && <p className="max-w-60 px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">{problem}</p>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

const changesText = (c: WorktreeChanges) =>
  [c.uncommitted > 0 && `未コミットの変更 ${c.uncommitted} 件`, c.unpushed > 0 && `push していない commit ${c.unpushed} 件`].filter(Boolean).join("、");

/**
 * Removing a worktree: its folder, branch and working server, the sessions that end with it, and whether to delete its
 * local branch too. When the worktree has changes that would be lost, the answer says how many, and only a second
 * press ("変更を捨てて削除") removes it all the same.
 */
export function RemoveWorktreeDialog({ worktree, onClose }: { worktree: WorktreeSessions | null; onClose: () => void }) {
  if (!worktree) return null;
  return <RemoveDialog key={worktree.id} worktree={worktree} onClose={onClose} />;
}

function RemoveDialog({ worktree, onClose }: { worktree: WorktreeSessions; onClose: () => void }) {
  const { machine, path, branch } = worktree;
  // As listed when the dialog opened: those that end leave the list before the answer comes.
  const [sessions] = useState(() => {
    const live = getAppState().machines.find((m) => m.id === machine.id) ?? machine;
    return sessionsInWorktree(live, path);
  });
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [changes, setChanges] = useState<WorktreeChanges>();
  const working = sessions.some((s) => s.status === "busy" || s.status === "waiting");

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    const r = await removeWorktree({ machine: machine.id, path, ...(branch && deleteBranch ? { branch } : {}), ...(changes ? { force: true } : {}) });
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      if (r.changes) setChanges(r.changes);
      return;
    }
    onClose();
  };

  const field = "grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs";
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={DIALOG_OVERLAY} />
        <AlertDialog.Content className={DIALOG_PANEL}>
          <AlertDialog.Title className="text-base font-semibold tracking-tight">worktree を削除しますか？</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              <p>
                {sessions.length > 0
                  ? sessions.some((s) => s.agent === "codex")
                    ? `中の ${sessions.length} 件のセッションを終了し、worktree のフォルダーを削除します（git worktree remove）。`
                    : `中の ${sessions.length} 件のセッションの Claude Code を終了し、worktree のフォルダーを削除します（git worktree remove）。`
                  : "worktree のフォルダーを削除します（git worktree remove）。"}
                {working && "作業中のセッションは、作業が途中で止まります。"}
              </p>
              {sessions.length > 0 && <p>会話の記録は {machine.name} に残ります。</p>}
            </div>
          </AlertDialog.Description>
          <dl className={cn(field, "mt-3 rounded-lg border border-border px-3 py-2")}>
            <dt className="text-muted-foreground">フォルダー</dt>
            <dd className="truncate font-mono" title={path}>
              {path}
            </dd>
            <dt className="text-muted-foreground">ブランチ</dt>
            <dd className="truncate font-mono">{branch ?? "（なし）"}</dd>
            <dt className="text-muted-foreground">working server</dt>
            <dd className="truncate">{machine.name}</dd>
          </dl>
          {sessions.length > 0 && (
            <ul aria-label="一緒に終了するセッション" className="mt-3 max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1 text-sm">
              {sessions.map((s) => (
                <li key={s.sessionId} className="flex items-center gap-2 px-2 py-1.5">
                  <StatusDot status={s.status} />
                  <span className="min-w-0 flex-1 truncate" title={sessionLabel(s)}>
                    {sessionLabel(s)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {branch && (
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={deleteBranch}
                onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
                disabled={busy}
                className="size-4 accent-foreground"
              />
              <span className="min-w-0">
                ローカルのブランチ <code className="font-mono text-[0.92em]">{branch}</code> も消す
              </span>
            </label>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {changes ? `${changesText(changes)}があるため、削除していません。削除すると、これらは失われます。` : error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={busy} className={BUTTON_SECONDARY}>
                キャンセル
              </button>
            </AlertDialog.Cancel>
            {/* Not AlertDialog.Action, which would close the dialog before the answer comes. */}
            <button type="button" onClick={() => void remove()} disabled={busy} className={BUTTON_DANGER}>
              {busy ? "削除しています…" : changes ? "変更を捨てて削除" : "削除する"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
