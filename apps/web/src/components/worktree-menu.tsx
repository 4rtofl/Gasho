// What can be done to a worktree from its row in the sidebar (Gasho's list, and a grouping's categories): give it a
// name to show in place of its branch, or remove it with the sessions in it. The menu opens with a right-click (a long
// press on a touch screen, the context menu key on a keyboard), as a session's does (session-menu). Each item opens a
// dialog, which the app keeps at its top (WorktreeActionDialog): it stays open while the sidebar redraws. Plugins
// remove worktrees the same way (removeWorktree, through the SDK's useRemoveWorktree).
import { Pencil, Trash2 } from "lucide-react";
import { AlertDialog, ContextMenu, Dialog } from "radix-ui";
import { useRef, useState, type FormEvent, type ReactElement } from "react";
import type { RemoveWorktreeInput, RemoveWorktreeResult, WorktreeChanges } from "@gasho/plugin-sdk";
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL, MENU, MENU_ITEM } from "@/components/dialog-styles";
import { StatusDot } from "@/components/status-badge";
import { sessionLabel } from "@/lib/format";
import { showNotice } from "@/lib/notice";
import { forgetWorktree } from "@/lib/remembered-worktrees";
import { go, parseHash } from "@/lib/route";
import { MAX_SESSION_NAME } from "@/lib/session-names";
import { sessionDotStatus, shownStatus, worktreeOrigin, worktreeTitle, type WorktreeSessions } from "@/lib/sessions";
import { getAppState, sendCommand, setWorktreeName } from "@/lib/store";
import { keepOpenWhileComposing } from "@/lib/text-input";
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

export type WorktreeAction = "rename" | "remove";

/** A worktree, as it was when an item of its menu was picked, and what to do with it. */
export interface WorktreeActionRequest {
  action: WorktreeAction;
  worktree: WorktreeSessions;
}

/** The menu of a worktree's row; `children` is the row's button, which opens it. */
export function WorktreeContextMenu({
  worktree,
  onPick,
  children,
}: {
  worktree: WorktreeSessions;
  onPick: (request: WorktreeActionRequest) => void;
  children: ReactElement;
}) {
  // Focus goes back to the row when the menu closes, unless a dialog is opening from it.
  const picked = useRef(false);
  const problem = removeWorktreeProblem(worktree.machine, { path: worktree.path, repo: worktree.subfolders ? worktree.repoFolder : undefined });
  const pick = (action: WorktreeAction) => {
    picked.current = true;
    onPick({ action, worktree });
  };
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
          <ContextMenu.Label className="max-w-72 px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground">
            <span className="block truncate">{worktreeTitle(worktree)}</span>
            {/* Where the pointer cannot hover (a long press on a touch screen), what the name stands in for shows here. */}
            {worktree.name && <span className="block truncate font-mono text-[11px]">{worktreeOrigin(worktree)}</span>}
          </ContextMenu.Label>
          <ContextMenu.Item onSelect={() => pick("rename")} className={cn(MENU_ITEM, "[&>svg]:text-muted-foreground")}>
            <Pencil />
            名前を変更…
          </ContextMenu.Item>
          <ContextMenu.Separator className="mx-1 my-1 h-px bg-border" />
          <ContextMenu.Item
            disabled={problem !== undefined}
            onSelect={() => pick("remove")}
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

/** The dialog for a picked menu item. A new pick starts a fresh dialog. */
export function WorktreeActionDialog({ request, onClose }: { request: WorktreeActionRequest | null; onClose: () => void }) {
  if (!request) return null;
  const key = `${request.action}/${request.worktree.id}`;
  if (request.action === "rename") return <NameDialog key={key} worktree={request.worktree} onClose={onClose} />;
  return <RemoveDialog key={key} worktree={request.worktree} onClose={onClose} />;
}

/**
 * Naming a worktree, or taking its name away (then its branch shows again). The Gasho server keeps the names, so every
 * browser shows the same, also while its working server is offline.
 */
function NameDialog({ worktree, onClose }: { worktree: WorktreeSessions; onClose: () => void }) {
  const current = worktree.name ?? "";
  const [name, setName] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const input = useRef<HTMLInputElement>(null);
  const unchanged = name.trim() === current;

  const save = async (given: string) => {
    setBusy(true);
    setError(undefined);
    const r = await setWorktreeName(worktree.machine.id, worktree.path, given);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "名前を変えられませんでした。");
      return;
    }
    onClose();
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || unchanged) return;
    void save(name);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        // While waiting, the answer is still to come: the dialog stays to show it.
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={DIALOG_OVERLAY} />
        <Dialog.Content
          className={DIALOG_PANEL}
          onEscapeKeyDown={keepOpenWhileComposing}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            input.current?.focus();
            input.current?.select();
          }}
        >
          <Dialog.Title className="text-base font-semibold tracking-tight">名前を変更</Dialog.Title>
          <form onSubmit={submit}>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">
              サイドバーで、ブランチ名の代わりにこの名前を出します。どのブラウザーにも同じ名前が出ます。名前を消すと、ブランチ名に戻ります。
            </Dialog.Description>
            <p className="mt-3 truncate font-mono text-xs text-muted-foreground" title={worktree.path}>
              {worktreeOrigin(worktree)} · {worktree.machine.name}
            </p>
            <label className="mt-4 block space-y-1.5">
              <span className="text-xs text-muted-foreground">名前</span>
              <input
                ref={input}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setError(undefined);
                }}
                placeholder={worktree.label}
                maxLength={MAX_SESSION_NAME}
                disabled={busy}
                spellCheck={false}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-border-hover disabled:opacity-60"
              />
            </label>
            {error && (
              <p role="alert" className="mt-2 text-sm text-red-400">
                {error}
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              {worktree.name && (
                <button type="button" onClick={() => void save("")} disabled={busy} className={cn(BUTTON_SECONDARY, "mr-auto")}>
                  名前を消す
                </button>
              )}
              <Dialog.Close asChild>
                <button type="button" disabled={busy} className={BUTTON_SECONDARY}>
                  キャンセル
                </button>
              </Dialog.Close>
              <button type="submit" disabled={busy || unchanged} className={BUTTON_PRIMARY}>
                {busy ? "変更しています…" : "変更する"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Removing a worktree: its folder, branch and working server, the sessions that end with it, and whether to delete its
 * local branch too. When the worktree has changes that would be lost, the answer says how many, and only a second
 * press ("変更を捨てて削除") removes it all the same.
 */
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
  const working = sessions.some((s) => shownStatus(s) === "busy" || s.status === "waiting");

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
                  <StatusDot status={sessionDotStatus(s)} />
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
