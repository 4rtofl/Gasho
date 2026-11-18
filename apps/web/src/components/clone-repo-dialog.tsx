// Clones a GitHub repository into a folder of a working server (repo.clone) and registers it (repo.register), so that
// the sidebar lists it without a session having started there. Opened from the button beside the worktree list's menu.
import { LoaderCircle, TriangleAlert, X } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL } from "@/components/dialog-styles";
import { CLONE_WAIT_MS, cloneProblem, clonePath, folderChoices, repoFolderName } from "@/lib/folders";
import { daemonAtLeast } from "@/lib/sessions";
import { sendCommand, useAppState } from "@/lib/store";
import { composing, keepOpenWhileComposing } from "@/lib/text-input";
import { cn } from "@/lib/utils";

const TITLE = "リポジトリを clone";
const OTHER = "\u0000other";
/** A little longer than the Gasho server waits. */
const REGISTER_WAIT_MS = 20_000;
const FIELD =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-hover disabled:opacity-60";
const PLAIN_TEXT = { spellCheck: false, autoCapitalize: "none", autoCorrect: "off" } as const;

/** What is going on: the working server it was asked of, which stays offered if it goes offline meanwhile. */
interface Running {
  machine: string;
  step: "clone" | "register";
}

/**
 * The dialog. While a clone goes on it stays open, whatever is pressed. `onCloned` is called with the working server and
 * the repository's folder once it is cloned and registered.
 */
export function CloneRepoDialog({ open, onClose, onCloned }: { open: boolean; onClose: () => void; onCloned?: (machine: string, path: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={DIALOG_OVERLAY} />
        <Dialog.Content
          className={cn(DIALOG_PANEL, "w-[min(32rem,calc(100vw-2rem))] space-y-4")}
          onEscapeKeyDown={keepOpenWhileComposing}
          onOpenAutoFocus={(e) => {
            // The repository is what is typed first; the working server is usually the one already chosen.
            const first = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>("input");
            if (first) {
              e.preventDefault();
              first.focus();
            }
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <Dialog.Title className="text-base font-semibold tracking-tight">{TITLE}</Dialog.Title>
              <Dialog.Description className="text-xs text-muted-foreground">
                working server の GitHub CLI で <code className="font-mono">gh repo clone</code> し、サイドバーの一覧に出るように登録します。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" disabled={busy} className="text-muted-foreground hover:text-foreground disabled:opacity-40" aria-label="閉じる">
                <X className="size-4" />
              </button>
            </Dialog.Close>
          </div>
          <CloneForm
            onBusyChange={setBusy}
            onClose={onClose}
            onCloned={(machine, path) => {
              onCloned?.(machine, path);
              onClose();
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function CloneForm({
  onBusyChange,
  onClose,
  onCloned,
}: {
  onBusyChange: (busy: boolean) => void;
  onClose: () => void;
  onCloned: (machine: string, path: string) => void;
}) {
  const { machines } = useAppState();
  const [running, setRunning] = useState<Running>();
  // gasho-daemon 0.10.0 clones.
  const candidates = useMemo(
    () => machines.filter((m) => (m.connected && daemonAtLeast(m, 0, 10)) || m.id === running?.machine),
    [machines, running?.machine],
  );
  const [machineId, setMachineId] = useState<string>();
  const machine = candidates.find((m) => m.id === machineId) ?? candidates[0];
  const folders = useMemo(() => folderChoices(machine?.folders ?? []), [machine?.folders]);
  // The folder picked, while the working server still offers it; at first the first one offered.
  const [picked, setPicked] = useState<string>();
  const folder = picked === OTHER || (picked !== undefined && folders.includes(picked)) ? picked : (folders[0] ?? OTHER);
  const [custom, setCustom] = useState("");
  const [repo, setRepo] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  // Cloned, but not registered: the clone is there, so the form has nothing left to do.
  const [unregistered, setUnregistered] = useState<{ path: string; reason: string }>();

  const busy = running !== undefined;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  const parent = folder === OTHER ? custom.trim() : folder;
  const what = repo.trim();
  const as = name.trim();
  const target = clonePath(parent, what, as);

  const clone = async () => {
    if (!machine || busy) return;
    const problem = cloneProblem(parent, what, as);
    if (problem) return setError(problem);
    // The working server asked, whatever the form shows by the time the clone is done.
    const id = machine.id;
    setError(undefined);
    setRunning({ machine: id, step: "clone" });
    const cloned = await sendCommand(id, { type: "repo.clone", parent, repo: what, ...(as ? { name: as } : {}) }, CLONE_WAIT_MS);
    if (!cloned.ok || !cloned.path) {
      setRunning(undefined);
      return setError(cloned.error ?? "clone できませんでした。");
    }
    setRunning({ machine: id, step: "register" });
    const registered = await sendCommand(id, { type: "repo.register", path: cloned.path }, REGISTER_WAIT_MS);
    setRunning(undefined);
    if (!registered.ok) return setUnregistered({ path: cloned.path, reason: registered.error ?? "原因が分かりません。" });
    onCloned(id, registered.path ?? cloned.path);
  };

  if (unregistered) {
    return (
      <div className="space-y-4">
        <div role="alert" className="space-y-1.5 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
          <p className="flex items-center gap-2 font-medium">
            <TriangleAlert className="size-4 shrink-0" />
            clone できましたが、登録できませんでした
          </p>
          <p className="font-mono text-xs break-all">{unregistered.path}</p>
          <p className="break-words">{unregistered.reason}</p>
          <p className="text-xs">絞り込みのメニューの「リポジトリを登録・解除…」から、このフォルダーを登録し直せます。</p>
        </div>
        <div className="flex justify-end">
          <button type="button" onClick={onClose} className={BUTTON_SECONDARY}>
            閉じる
          </button>
        </div>
      </div>
    );
  }

  if (!machine) {
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">
          clone できる working server がありません。接続していて、gasho-daemon が 0.10.0 以上の working server が必要です。
        </p>
        {/* The only working server went offline during the clone: why it failed still shows. */}
        {error && (
          <p role="alert" className="text-sm break-words text-red-400">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        void clone();
      }}
      // The Enter that confirms a Japanese input method's conversion does not start a clone.
      onKeyDown={(e: KeyboardEvent<HTMLFormElement>) => {
        if (e.key === "Enter" && composing(e)) e.preventDefault();
      }}
    >
      <label className="block space-y-1.5">
        <span className="text-xs text-muted-foreground">working server</span>
        <select
          value={machine.id}
          disabled={busy}
          onChange={(e) => {
            setMachineId(e.target.value);
            setPicked(undefined);
            setCustom("");
            setError(undefined);
          }}
          className={FIELD}
        >
          {candidates.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      <label className="block space-y-1.5">
        <span className="text-xs text-muted-foreground">clone するリポジトリ</span>
        <input
          value={repo}
          disabled={busy}
          onChange={(e) => {
            setRepo(e.target.value);
            setError(undefined);
          }}
          placeholder="owner/name か GitHub の URL"
          className={cn(FIELD, "font-mono")}
          {...PLAIN_TEXT}
        />
      </label>

      <div className="space-y-2">
        <label className="block space-y-1.5">
          <span className="text-xs text-muted-foreground">clone 先のフォルダー</span>
          <select
            value={folder}
            disabled={busy}
            onChange={(e) => {
              setPicked(e.target.value);
              setError(undefined);
            }}
            className={FIELD}
          >
            {folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
            <option value={OTHER}>ほかのフォルダーを入力する…</option>
          </select>
        </label>
        {folder === OTHER && (
          <input
            value={custom}
            disabled={busy}
            onChange={(e) => {
              setCustom(e.target.value);
              setError(undefined);
            }}
            aria-label="clone 先のフォルダーの絶対パス"
            placeholder="/home/rg/repos（絶対パス）"
            className={cn(FIELD, "font-mono")}
            {...PLAIN_TEXT}
          />
        )}
      </div>

      <label className="block space-y-1.5">
        <span className="text-xs text-muted-foreground">フォルダーの名前（任意）</span>
        <input
          value={name}
          disabled={busy}
          onChange={(e) => {
            setName(e.target.value);
            setError(undefined);
          }}
          placeholder={repoFolderName(what) ?? "空ならリポジトリの名前"}
          className={cn(FIELD, "font-mono")}
          {...PLAIN_TEXT}
        />
      </label>

      {target && (
        <div className="space-y-1 rounded-lg bg-background/40 px-3 py-2">
          <p className="text-xs text-muted-foreground">clone される場所</p>
          <p className="font-mono text-xs break-all">{target}</p>
        </div>
      )}

      {running && (
        <p role="status" className="text-xs text-muted-foreground">
          {running.step === "clone"
            ? "clone しています。大きいリポジトリでは最長 10 分かかります。終わるまで、このダイアログは閉じられません。"
            : "clone できました。リポジトリを登録しています。"}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm break-words text-red-400">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} disabled={busy} className={BUTTON_SECONDARY}>
          やめる
        </button>
        <button type="submit" disabled={busy || !what || !parent} className={cn(BUTTON_PRIMARY, "gap-1.5")}>
          {busy && <LoaderCircle className="size-4 animate-spin" />}
          {running?.step === "register" ? "登録しています…" : busy ? "clone しています…" : "clone する"}
        </button>
      </div>
    </form>
  );
}
