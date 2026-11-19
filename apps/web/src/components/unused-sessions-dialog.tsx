// The question asked before a new session starts on a working server that has unused sessions: which of them to remove
// first (see lib/session-launch). There is one for the whole screen, in App.
import { AlertDialog } from "radix-ui";
import { useRef, useState } from "react";
import { BUTTON_DANGER, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL } from "@/components/dialog-styles";
import { DrawCheckbox } from "@/components/ui/draw-checkbox";
import { relativeTime, sessionLabel } from "@/lib/format";
import { cancelLaunch, launchKeepingUnused, launchRemovingUnused, useUnusedQuestion, type UnusedQuestion } from "@/lib/session-launch";
import { useAppState } from "@/lib/store";
import { lastActive } from "@/lib/unused-sessions";

function Question({ question }: { question: UnusedQuestion }) {
  const { machines } = useAppState();
  const machine = machines.find((m) => m.id === question.machine);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set(question.sessions.map((s) => s.sessionId)));
  const [removing, setRemoving] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);

  const toggle = (sessionId: string, on: boolean) => {
    const next = new Set(picked);
    if (on) next.add(sessionId);
    else next.delete(sessionId);
    setPicked(next);
  };

  return (
    <AlertDialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !removing) cancelLaunch(question);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={DIALOG_OVERLAY} />
        <AlertDialog.Content
          className={DIALOG_PANEL}
          // With no "キャンセル" to start on, the focus starts on the answer that removes nothing.
          onOpenAutoFocus={(e) => {
            if (question.cancellable) return;
            e.preventDefault();
            keep.current?.focus({ preventScroll: true });
          }}
        >
          <AlertDialog.Title className="text-base font-semibold tracking-tight">未使用のセッションを削除しますか？</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              <p>{machine?.name ?? question.machine} に、24 時間以上使っていないセッションがあります。削除すると Claude Code が終了し、メモリが空きます。</p>
              <p>
                削除しても会話は残り、
                {machine?.canResume ? "あとから過去の会話を開いて再開できます。" : (
                  <>
                    あとから端末で <code className="font-mono text-[0.92em]">claude --resume</code> を使うと再開できます。
                  </>
                )}
              </p>
              {!question.cancellable && <p>プラグインが起動を待っているので、キャンセルできません。</p>}
            </div>
          </AlertDialog.Description>
          <ul className="mt-3 max-h-64 space-y-1 overflow-y-auto">
            {question.sessions.map((s) => {
              const on = picked.has(s.sessionId);
              return (
                <li key={s.sessionId}>
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-raised">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={removing}
                      onChange={(e) => toggle(s.sessionId, e.target.checked)}
                      className="peer sr-only"
                    />
                    <DrawCheckbox checked={on} className="mt-0.5 peer-focus-visible:ring-2 peer-focus-visible:ring-ring/50" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-foreground">{sessionLabel(s)}</span>
                      <span title={s.cwd} className="block truncate font-mono text-xs text-muted-foreground">
                        {s.cwd}
                      </span>
                      <span className="block text-xs text-muted-foreground">最後の活動：{relativeTime(lastActive(s))}</span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            {question.cancellable && (
              <AlertDialog.Cancel asChild>
                <button type="button" disabled={removing} className={BUTTON_SECONDARY}>
                  キャンセル
                </button>
              </AlertDialog.Cancel>
            )}
            <button ref={keep} type="button" disabled={removing} onClick={() => launchKeepingUnused(question)} className={BUTTON_SECONDARY}>
              削除せずに起動
            </button>
            <button
              type="button"
              disabled={removing || picked.size === 0}
              onClick={() => {
                setRemoving(true);
                void launchRemovingUnused(question, picked);
              }}
              className={BUTTON_DANGER}
            >
              {removing ? "削除しています…" : "削除して起動"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function UnusedSessionsDialog() {
  const question = useUnusedQuestion();
  return question ? <Question key={question.id} question={question} /> : null;
}
