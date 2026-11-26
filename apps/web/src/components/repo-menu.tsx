// What can be done to a repository from the heading of a grouping's category that stands for it (docs/plugins.md,
// P18, a category's `repo`): take it off its working server's registered ones, as "リポジトリを登録・解除…" does. The
// menu opens with a right-click (a long press on a touch screen, the context menu key on a keyboard) and looks as a
// worktree's row's does (worktree-menu). Its dialog is kept at the app's top (RepoActionDialog): the heading may go
// from the list once the repository is off it.
import { CircleMinus } from "lucide-react";
import { AlertDialog, ContextMenu } from "radix-ui";
import { useRef, useState, type ReactElement } from "react";
import { BUTTON_DANGER, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL, MENU, MENU_ITEM } from "@/components/dialog-styles";
import { unregisterRepoPlan, unregisterRepoProblem } from "@/lib/repo-unregister";
import { useRememberedWorktrees } from "@/lib/remembered-worktrees";
import { getAppState, sendCommand, useAppState } from "@/lib/store";
import { cn } from "@/lib/utils";

/** A little longer than the Gasho server waits. */
const WAIT_MS = 20_000;

/** A repository, as its category's heading showed it when an item of its menu was picked. */
export interface RepoActionRequest {
  /** The working server (machine id). */
  machine: string;
  /** The repository's folder. */
  path: string;
  /** The category's title. */
  title: string;
}

/** The menu of a category's heading; `children` is the heading's button, which opens it. */
export function RepoContextMenu({ repo, onPick, children }: { repo: RepoActionRequest; onPick: (request: RepoActionRequest) => void; children: ReactElement }) {
  const { machines } = useAppState();
  const machine = machines.find((m) => m.id === repo.machine);
  // Focus goes back to the heading when the menu closes, unless a dialog is opening from it.
  const picked = useRef(false);
  if (!machine) return children;
  const problem = unregisterRepoProblem(machine, repo.path);
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
            <span className="block truncate">{repo.title}</span>
            <span className="block truncate font-mono text-[11px]" title={repo.path}>
              {machine.name} · {repo.path}
            </span>
          </ContextMenu.Label>
          <ContextMenu.Separator className="mx-1 my-1 h-px bg-border" />
          <ContextMenu.Item
            disabled={problem !== undefined}
            onSelect={() => {
              picked.current = true;
              onPick(repo);
            }}
            className={cn(MENU_ITEM, "text-red-400 data-[highlighted]:bg-red-500/10")}
          >
            <CircleMinus />
            登録を外す…
          </ContextMenu.Item>
          {problem && <p className="max-w-60 px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">{problem}</p>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** The dialog for a picked menu item. A new pick starts a fresh dialog. */
export function RepoActionDialog({ request, onClose }: { request: RepoActionRequest | null; onClose: () => void }) {
  if (!request) return null;
  return <UnregisterDialog key={`${request.machine}\u001f${request.path}`} repo={request} onClose={onClose} />;
}

/**
 * Taking the repository off its working server: what stays in the list (its worktrees with sessions) and what leaves it
 * (those without), as they are when the dialog opens. Its folders and files stay.
 */
function UnregisterDialog({ repo, onClose }: { repo: RepoActionRequest; onClose: () => void }) {
  const remembered = useRememberedWorktrees();
  const [plan] = useState(() => unregisterRepoPlan(getAppState().machines, remembered, repo.machine, repo.path));
  const machine = useAppState().machines.find((m) => m.id === repo.machine);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const unregister = async () => {
    setBusy(true);
    setError(undefined);
    const r = await sendCommand(repo.machine, { type: "repo.unregister", path: repo.path }, WAIT_MS);
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "登録を外せませんでした。");
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
          <AlertDialog.Title className="text-base font-semibold tracking-tight">リポジトリの登録を外しますか？</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              <p>
                {repo.title} を、{machine?.name ?? repo.machine} に登録したリポジトリから外します。フォルダーとファイルは消しません。
              </p>
              {plan.staying > 0 && (
                <p>
                  セッションのある worktree {plan.staying} 件（セッション {plan.sessions} 件）は、登録を外したあとも一覧に残ります。
                </p>
              )}
              {plan.leaving > 0 && <p>セッションの無い worktree {plan.leaving} 件は、一覧から消えます。</p>}
            </div>
          </AlertDialog.Description>
          <dl className={cn(field, "mt-3 rounded-lg border border-border px-3 py-2")}>
            <dt className="text-muted-foreground">フォルダー</dt>
            <dd className="truncate font-mono" title={repo.path}>
              {repo.path}
            </dd>
            <dt className="text-muted-foreground">working server</dt>
            <dd className="truncate">{machine?.name ?? repo.machine}</dd>
          </dl>
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {error}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={busy} className={BUTTON_SECONDARY}>
                キャンセル
              </button>
            </AlertDialog.Cancel>
            {/* Not AlertDialog.Action, which would close the dialog before the answer comes. */}
            <button type="button" onClick={() => void unregister()} disabled={busy} className={BUTTON_DANGER}>
              {busy ? "外しています…" : "登録を外す"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
