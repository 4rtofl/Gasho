// 「すべて更新」, as the 端末 screen (its gasho-daemons, DaemonUpdates) and the plugins screen (its plugins, PluginsView)
// both have it: the button, with how many can be updated or which one is being updated; the dialog that asks first,
// with what will be updated; and the runner that updates them one after another, going on past one that fails.
import { ArrowUpCircle, LoaderCircle } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL } from "@/components/dialog-styles";

/** One thing 「すべて更新」 updates: its id, and its name as the button says it while it is being updated. */
export type UpdateAllItem = { id: string; name: string };

/** The one being updated: its place in the run (from 1) and how many the run updates. */
export type UpdateAllProgress = { item: UpdateAllItem; index: number; total: number };

/**
 * Updates items one after another: `update` resolves to why one failed (undefined when it went well), and a failure
 * does not stop the rest. Each item's failure is kept until the next run. A run stops when the screen goes; what was
 * already started goes on.
 */
export function useUpdateAll(update: (item: UpdateAllItem, signal: AbortSignal) => Promise<string | undefined>): {
  progress: UpdateAllProgress | undefined;
  failures: Record<string, string>;
  run: (items: UpdateAllItem[]) => Promise<void>;
  /** Forgets an item's failure (updated by itself since). */
  forget: (id: string) => void;
} {
  const [progress, setProgress] = useState<UpdateAllProgress>();
  const [failures, setFailures] = useState<Record<string, string>>({});
  const leaving = useRef<AbortController>(undefined);
  useEffect(() => {
    const c = new AbortController();
    leaving.current = c;
    return () => c.abort();
  }, []);
  const run = async (items: UpdateAllItem[]) => {
    const signal = leaving.current?.signal;
    if (!signal || signal.aborted) return;
    setFailures({});
    for (const [i, item] of items.entries()) {
      setProgress({ item, index: i + 1, total: items.length });
      let error: string | undefined;
      try {
        error = await update(item, signal);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      if (signal.aborted) return;
      if (error) setFailures((f) => ({ ...f, [item.id]: error }));
    }
    setProgress(undefined);
  };
  const forget = (id: string) =>
    setFailures((f) => {
      if (!(id in f)) return f;
      const { [id]: _, ...rest } = f;
      return rest;
    });
  return { progress, failures, run, forget };
}

/**
 * 「すべて更新（N）」, or, while a run goes on, which one it is updating. Not shown when there is nothing to update and
 * no run.
 */
export function UpdateAllButton({ count, progress, disabled, onClick }: { count: number; progress?: UpdateAllProgress; disabled?: boolean; onClick: () => void }) {
  if (!progress && count === 0) return null;
  return (
    <button
      type="button"
      className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
      disabled={disabled || Boolean(progress)}
      onClick={onClick}
    >
      {progress ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : <ArrowUpCircle className="size-3.5 shrink-0" />}
      <span className="truncate">
        {progress ? `更新しています（${progress.index}/${progress.total}）：${progress.item.name}` : `すべて更新（${count}）`}
      </span>
    </button>
  );
}

/**
 * The dialog 「すべて更新」 opens: what will be updated (a line for each, with what is to know about it) and what the
 * updates do. 「更新する」 closes it, and the run starts.
 */
export function ConfirmUpdateAll({
  title,
  items,
  notes,
  onClose,
  onConfirm,
}: {
  title: string;
  items: { id: string; label: ReactNode; detail?: ReactNode }[];
  notes: string[];
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={DIALOG_OVERLAY} />
        <AlertDialog.Content className={DIALOG_PANEL}>
          <AlertDialog.Title className="text-base font-semibold tracking-tight">{title}</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 space-y-3 text-sm text-muted-foreground">
              <ul aria-label="更新するもの" className="divide-y divide-border rounded-xl border border-border bg-background">
                {items.map((item) => (
                  <li key={item.id} className="px-3 py-2">
                    <div className="text-foreground">{item.label}</div>
                    {item.detail && <div className="mt-0.5 space-y-0.5 text-xs">{item.detail}</div>}
                  </li>
                ))}
              </ul>
              <div className="space-y-1.5">
                {notes.map((note, i) => (
                  <p key={i}>{note}</p>
                ))}
              </div>
            </div>
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" className={BUTTON_SECONDARY}>
                キャンセル
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button type="button" className={BUTTON_PRIMARY} onClick={onConfirm}>
                更新する
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
