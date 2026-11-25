// What can be done to a worktree from its row in the sidebar (Gasho's list, and a grouping's categories): give it a
// name to show in place of its branch, or remove it with the sessions in it. The menu opens with a right-click (a long
// press on a touch screen, the context menu key on a keyboard), as a session's does (session-menu). Each item opens a
// dialog, which the app keeps at its top (WorktreeActionDialog): it stays open while the sidebar redraws. Plugins
// remove worktrees the same way (removeWorktree, through the SDK's useRemoveWorktree). On a row of the worktrees
// selected together (pressed with Shift), the menu does the same to all of them (BatchNameDialog, BatchRemoveDialog).
import { ArrowRight, Pencil, Trash2 } from "lucide-react";
import { AlertDialog, ContextMenu, Dialog } from "radix-ui";
import { useRef, useState, type ChangeEvent, type FormEvent, type ReactElement } from "react";
import type { RemoveWorktreeInput, RemoveWorktreeResult, WorktreeChanges } from "@gasho/plugin-sdk";
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL, MENU, MENU_ITEM } from "@/components/dialog-styles";
import { StatusDot } from "@/components/status-badge";
import { sessionLabel } from "@/lib/format";
import { showNotice } from "@/lib/notice";
import { forgetWorktree } from "@/lib/remembered-worktrees";
import { go, parseHash } from "@/lib/route";
import { MAX_SESSION_NAME, nameProblem } from "@/lib/session-names";
import { sessionDotStatus, shownStatus, worktreeOrigin, worktreeTitle, type WorktreeSessions } from "@/lib/sessions";
import { getAppState, sendCommand, setWorktreeName, useAppState } from "@/lib/store";
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

/**
 * A worktree, as it was when an item of its menu was picked, and what to do with it; `worktrees`: picked on a row of
 * the worktrees selected together, all of them (several, in the order they show), which it is done to instead.
 */
export interface WorktreeActionRequest {
  action: WorktreeAction;
  worktree: WorktreeSessions;
  worktrees?: WorktreeSessions[];
}

const problemOf = (w: WorktreeSessions, machine = w.machine) =>
  removeWorktreeProblem(machine, { path: w.path, repo: w.subfolders ? w.repoFolder : undefined });

/**
 * The menu of a worktree's row; `children` is the row's button, which opens it. `selection`: the worktrees selected
 * together, when the row is one of them (several, in the order they show); the menu is then theirs.
 */
export function WorktreeContextMenu({
  worktree,
  selection,
  onPick,
  children,
}: {
  worktree: WorktreeSessions;
  selection?: WorktreeSessions[];
  onPick: (request: WorktreeActionRequest) => void;
  children: ReactElement;
}) {
  // Focus goes back to the row when the menu closes, unless a dialog is opening from it.
  const picked = useRef(false);
  // Several can be removed while one of them can be; those that cannot are left out (the dialog tells why).
  const problem = selection
    ? selection.every((w) => problemOf(w) !== undefined)
      ? "選んだ worktree は、どれも削除できません。"
      : undefined
    : problemOf(worktree);
  const pick = (action: WorktreeAction) => {
    picked.current = true;
    onPick({ action, worktree, ...(selection ? { worktrees: selection } : {}) });
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
            {selection ? (
              <span className="block truncate">選んだ {selection.length} 件の worktree</span>
            ) : (
              <>
                <span className="block truncate">{worktreeTitle(worktree)}</span>
                {/* Where the pointer cannot hover (a long press on a touch screen), what the name stands in for shows here. */}
                {worktree.name && <span className="block truncate font-mono text-[11px]">{worktreeOrigin(worktree)}</span>}
              </>
            )}
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
  const { action, worktree, worktrees } = request;
  if (worktrees) {
    const key = `${action}/${worktrees.map((w) => w.id).join("\n")}`;
    if (action === "rename") return <BatchNameDialog key={key} worktrees={worktrees} onClose={onClose} />;
    return <BatchRemoveDialog key={key} worktrees={worktrees} onClose={onClose} />;
  }
  const key = `${action}/${worktree.id}`;
  if (action === "rename") return <NameDialog key={key} worktree={worktree} onClose={onClose} />;
  return <RemoveDialog key={key} worktree={worktree} onClose={onClose} />;
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

/** What replacing a text makes of a worktree's name. */
interface PlannedName {
  worktree: WorktreeSessions;
  /** The name it shows now: the one given to it, or its branch. */
  before: string;
  /** The name to give it; "": its name is taken away (its branch shows again); absent: it stays as it is. */
  name?: string;
  /** What the replacing made of it, when the Gasho server would not take that as a name, and why. */
  refused?: { after: string; error: string };
}

/** `search` replaced with `replacement` wherever it is in the name the worktree shows, as Finder renames files. */
function planName(w: WorktreeSessions, name: string | undefined, search: string, replacement: string): PlannedName {
  const before = name ?? w.label;
  const after = before.split(search).join(replacement).trim();
  if (after === before || (!after && !name)) return { worktree: w, before };
  if (!after) return { worktree: w, before, name: "" };
  const error = nameProblem(after);
  return error ? { worktree: w, before, refused: { after, error } } : { worktree: w, before, name: after };
}

const FIELD =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-border-hover disabled:opacity-60";

/**
 * Renaming the worktrees selected together by replacing a text in the name each shows (its branch when it has none).
 * Each one's name now and what it becomes show before anything is sent; only those that change are.
 */
function BatchNameDialog({ worktrees, onClose }: { worktrees: WorktreeSessions[]; onClose: () => void }) {
  // The names as the Gasho server has them now: once some were given and others failed, those given show as they are.
  const { machines } = useAppState();
  const [search, setSearch] = useState("");
  const [replacement, setReplacement] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map());
  const input = useRef<HTMLInputElement>(null);
  const nameOf = (w: WorktreeSessions) => machines.find((m) => m.id === w.machine.id)?.worktreeNames?.[w.path];
  const plan = worktrees.map((w): PlannedName => (search ? planName(w, nameOf(w), search, replacement) : { worktree: w, before: nameOf(w) ?? w.label }));
  const changes = plan.filter((p) => p.name !== undefined);
  const edit = (set: (value: string) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    set(e.target.value);
    setFailed(new Map());
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || changes.length === 0) return;
    setBusy(true);
    setFailed(new Map());
    const results = await Promise.all(changes.map((p) => setWorktreeName(p.worktree.machine.id, p.worktree.path, p.name ?? "")));
    setBusy(false);
    const errors = new Map(changes.flatMap((p, i) => (results[i]!.ok ? [] : [[p.worktree.id, results[i]!.error ?? "名前を変えられませんでした。"] as const])));
    if (errors.size === 0) onClose();
    else setFailed(errors);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
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
          }}
        >
          <Dialog.Title className="text-base font-semibold tracking-tight">{worktrees.length} 件の worktree の名前を変更</Dialog.Title>
          <form onSubmit={(e) => void submit(e)}>
            <Dialog.Description className="mt-2 text-sm text-muted-foreground">
              今の名前（名前が無ければブランチ名）の中の検索文字列を、すべて置換文字列に置き換えます。
            </Dialog.Description>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1.5">
                <span className="text-xs text-muted-foreground">検索文字列</span>
                <input
                  ref={input}
                  value={search}
                  onChange={edit(setSearch)}
                  placeholder="feat/"
                  disabled={busy}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className={FIELD}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs text-muted-foreground">置換文字列</span>
                <input
                  value={replacement}
                  onChange={edit(setReplacement)}
                  disabled={busy}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoCorrect="off"
                  className={FIELD}
                />
              </label>
            </div>
            <ul aria-label="変更前と変更後" className="mt-3 max-h-64 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1 text-sm">
              {plan.map((p) => {
                const error = failed.get(p.worktree.id) ?? p.refused?.error;
                return (
                  <li key={p.worktree.id} className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 px-2 py-1.5">
                    <span className="truncate" title={p.before}>
                      {p.before}
                    </span>
                    <ArrowRight aria-hidden className="size-3.5 text-muted-foreground" />
                    <span className="sr-only">は</span>
                    {p.name ? (
                      <span className="truncate font-medium" title={p.name}>
                        {p.name}
                      </span>
                    ) : p.name === "" ? (
                      <span className="truncate text-muted-foreground">{p.worktree.label}（名前を消す）</span>
                    ) : p.refused ? (
                      <span className="truncate" title={p.refused.after}>
                        {p.refused.after}
                      </span>
                    ) : (
                      <span className="truncate text-muted-foreground">変わりません</span>
                    )}
                    {error && <span className="col-span-3 text-xs text-red-400">{error}</span>}
                  </li>
                );
              })}
            </ul>
            <div className="mt-5 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button type="button" disabled={busy} className={BUTTON_SECONDARY}>
                  キャンセル
                </button>
              </Dialog.Close>
              <button type="submit" disabled={busy || changes.length === 0} className={BUTTON_PRIMARY}>
                {busy ? "変更しています…" : changes.length > 0 ? `${changes.length} 件を変更する` : "変更する"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Removing the worktrees selected together, one after another, as RemoveDialog removes one. Those that cannot be removed
 * are left out, with why. Those with changes that would be lost stay, with how many, and only a second press ("変更を
 * 捨てて削除") removes them all the same.
 */
function BatchRemoveDialog({ worktrees, onClose }: { worktrees: WorktreeSessions[]; onClose: () => void }) {
  // As listed when the dialog opened: those that end leave the list before the answers come.
  const [targets] = useState(() =>
    worktrees.map((w) => {
      const live = getAppState().machines.find((m) => m.id === w.machine.id) ?? w.machine;
      return { worktree: w, problem: problemOf(w, live), sessions: sessionsInWorktree(live, w.path) };
    }),
  );
  const removable = targets.filter((t) => t.problem === undefined);
  const leftOut = targets.filter((t) => t.problem !== undefined);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const [busy, setBusy] = useState<{ done: number; of: number }>();
  const [results, setResults] = useState<ReadonlyMap<string, RemoveWorktreeResult>>(new Map());
  const remaining = removable.filter((t) => !results.get(t.worktree.id)?.ok);
  const changed = (r: RemoveWorktreeResult | undefined) => (r && !r.ok ? r.changes : undefined);
  const withChanges = remaining.filter((t) => changed(results.get(t.worktree.id)));
  const sessions = removable.flatMap((t) => t.sessions);
  const working = sessions.some((s) => shownStatus(s) === "busy" || s.status === "waiting");

  const remove = async () => {
    const now = new Map(results);
    const warnings: string[] = [];
    setBusy({ done: 0, of: remaining.length });
    // One after another: two git commands at once in one repository can find its lock files taken.
    for (const [i, t] of remaining.entries()) {
      const { machine, path, branch } = t.worktree;
      const force = changed(now.get(t.worktree.id)) !== undefined;
      const r = await removeWorktree({ machine: machine.id, path, ...(branch && deleteBranch ? { branch } : {}), ...(force ? { force: true } : {}) });
      now.set(t.worktree.id, r);
      if (r.ok && r.warning) warnings.push(r.warning);
      setResults(new Map(now));
      setBusy({ done: i + 1, of: remaining.length });
    }
    setBusy(undefined);
    // removeWorktree tells each warning in place of the one before.
    if (warnings.length > 1) showNotice(warnings.join(" "));
    if (removable.every((t) => now.get(t.worktree.id)?.ok)) onClose();
  };

  const row = "px-2 py-1.5";
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
          <AlertDialog.Title className="text-base font-semibold tracking-tight">{removable.length} 件の worktree を削除しますか？</AlertDialog.Title>
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
              {sessions.length > 0 && <p>会話の記録は、それぞれの working server に残ります。</p>}
            </div>
          </AlertDialog.Description>
          <ul aria-label="削除する worktree" className="mt-3 max-h-56 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1 text-sm">
            {removable.map(({ worktree: w, sessions: inside }) => {
              const r = results.get(w.id);
              const changes = changed(r);
              return (
                <li key={w.id} className={row}>
                  <div className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate" title={w.path}>
                      {worktreeTitle(w)}
                    </span>
                    {r?.ok && <span className="shrink-0 text-xs text-emerald-400">削除しました</span>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {[w.repo, w.machine.name, inside.length > 0 ? `セッション ${inside.length} 件` : undefined].filter(Boolean).join(" · ")}
                  </p>
                  {r && !r.ok && <p className={cn("text-xs", changes ? "text-amber-400" : "text-red-400")}>{changes ? `${changesText(changes)}があります` : r.error}</p>}
                </li>
              );
            })}
          </ul>
          {leftOut.length > 0 && (
            <>
              <p className="mt-3 text-xs text-muted-foreground">削除しない worktree</p>
              <ul aria-label="削除しない worktree" className="mt-1 max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1 text-sm">
                {leftOut.map(({ worktree: w, problem }) => (
                  <li key={w.id} className={row}>
                    <span className="block truncate text-muted-foreground" title={w.path}>
                      {worktreeTitle(w)}
                    </span>
                    <span className="block text-xs text-muted-foreground">{problem}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {removable.some((t) => t.worktree.branch) && (
            <label className="mt-3 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={deleteBranch}
                onChange={(e) => setDeleteBranch(e.currentTarget.checked)}
                disabled={busy !== undefined}
                className="size-4 accent-foreground"
              />
              <span className="min-w-0">それぞれのローカルのブランチも消す</span>
            </label>
          )}
          {withChanges.length > 0 && !busy && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {withChanges.length} 件の worktree は、未コミットの変更か push していない commit があるため、削除していません。削除すると、これらは失われます。
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={busy !== undefined} className={BUTTON_SECONDARY}>
                キャンセル
              </button>
            </AlertDialog.Cancel>
            {/* Not AlertDialog.Action, which would close the dialog before the answers come. */}
            <button type="button" onClick={() => void remove()} disabled={busy !== undefined || remaining.length === 0} className={BUTTON_DANGER}>
              {busy ? `削除しています…（${busy.done}/${busy.of}）` : withChanges.length > 0 ? "変更を捨てて削除" : `${remaining.length} 件を削除する`}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
