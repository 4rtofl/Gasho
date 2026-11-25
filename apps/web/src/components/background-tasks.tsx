// Work that Claude Code runs in the background for a session (SessionInfo.background): shells, monitors, subagents
// and workflows that Claude started, which run on after its turn has ended. Listed above the chat box while something
// runs, each with a button that stops it the way Claude Code's own list of background tasks does (session.stopTask);
// Claude is then told that the person stopped it. The button next to the effort picker shows or hides the list
// (BackgroundToggle); this browser remembers which. Its look is that of EasyUI's panels (the model picker, the slash menu).
import { motion, useReducedMotion } from "framer-motion";
import { Bot, Radio, SquareTerminal, Workflow, type LucideIcon } from "lucide-react";
import { useCallback, useState, useSyncExternalStore } from "react";
import type { BackgroundTask, BackgroundTaskKind, MachineInfo, SessionInfo } from "@gasho/protocol";
import { elapsedTime } from "@/lib/format";
import { sendCommand } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const KIND: Record<BackgroundTaskKind, { label: string; icon: LucideIcon }> = {
  shell: { label: "シェル", icon: SquareTerminal },
  monitor: { label: "監視", icon: Radio },
  agent: { label: "サブエージェント", icon: Bot },
  workflow: { label: "ワークフロー", icon: Workflow },
};

/** A little longer than the Gasho server waits for the working server (each task is stopped in turn, on the screen). */
const STOP_WAIT_MS = 70_000;
const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/* Whether the list is shown, kept in localStorage for every session (a private window: for this page view only). */
const OPEN_KEY = "gasho.backgroundList";
const openListeners = new Set<() => void>();
let shownHere = true;
function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== "hidden";
  } catch {
    return shownHere;
  }
}
function subscribeOpen(l: () => void): () => void {
  openListeners.add(l);
  window.addEventListener("storage", l);
  return () => {
    openListeners.delete(l);
    window.removeEventListener("storage", l);
  };
}

/** Whether the list of the work running in the background is shown, and the toggle of it. */
export function useBackgroundListOpen(): [boolean, () => void] {
  const open = useSyncExternalStore(subscribeOpen, readOpen, () => true);
  const toggle = useCallback(() => {
    shownHere = !readOpen();
    try {
      if (shownHere) localStorage.removeItem(OPEN_KEY);
      else localStorage.setItem(OPEN_KEY, "hidden");
    } catch {
      // storage unavailable: kept for this page view
    }
    for (const l of openListeners) l();
  }, []);
  return [open, toggle];
}

export function BackgroundTasks({ machine, session, open = true }: { machine: MachineInfo; session: SessionInfo; open?: boolean }) {
  const tasks = session.background ?? [];
  const reduce = useReducedMotion();
  const now = useNow(10_000);
  // Which stop is on its way: a task's id, or "all".
  const [stopping, setStopping] = useState<string>();
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  // Hidden at once, as EasyUI's panels close; it glides in when shown.
  if (!open || tasks.length === 0) return null;

  const stop = async (task?: BackgroundTask) => {
    setStopping(task?.id ?? "all");
    setMessage(undefined);
    try {
      const r = await sendCommand(
        machine.id,
        { type: "session.stopTask", sessionId: session.sessionId, ...(task ? { taskId: task.id } : {}) },
        STOP_WAIT_MS,
      );
      if (!r.ok) setMessage({ text: r.error ?? "止められませんでした。", error: true });
      else if (r.warning) setMessage({ text: r.warning, error: false });
    } finally {
      setStopping(undefined);
    }
  };
  const disabled = !machine.connected || stopping !== undefined;

  return (
    <motion.section
      aria-label="バックグラウンドで実行中"
      initial={{ opacity: 0, y: reduce ? 0 : 6, scale: reduce ? 1 : 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.16, ease: EASE_OUT }}
      style={{ transformOrigin: "bottom left" }}
      className="mb-2 overflow-hidden rounded-2xl bg-popover shadow-xl ring-1 ring-white/[0.1]"
    >
      <div className="flex min-h-10 items-center gap-2 py-1 pr-1.5 pl-3.5">
        <span aria-hidden className="relative flex size-2 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400/60 motion-reduce:hidden" />
          <span className="relative inline-flex size-2 rounded-full bg-sky-400" />
        </span>
        <h2 className="truncate text-xs font-medium text-neutral-400">バックグラウンドで実行中</h2>
        <span aria-label={`${tasks.length} 件`} className="rounded-full bg-white/[0.08] px-1.5 py-px text-[10.5px] font-medium text-neutral-400 tabular-nums">
          {tasks.length}
        </span>
        <span className="flex-1" />
        {tasks.length > 1 && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void stop()}
            title="バックグラウンドで動いているものを、すべて止めます"
            className={cn(STOP, "text-neutral-500")}
          >
            {stopping === "all" ? "止めています…" : "すべて止める"}
          </button>
        )}
      </div>
      <ul className="max-h-44 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
        {tasks.map((t) => {
          const { label, icon: Icon } = KIND[t.kind] ?? KIND.shell;
          const since = t.startedAt ? `${elapsedTime(t.startedAt, now)}前から` : undefined;
          const command = t.command && t.command !== t.title ? t.command : undefined;
          return (
            <li key={t.id} className="flex min-h-12 items-center gap-3 rounded-xl px-2 py-1.5 [@media(hover:hover)]:hover:bg-white/[0.04]">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-neutral-300 ring-1 ring-white/[0.06]">
                <Icon className="size-4" aria-label={label} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-medium text-neutral-100" title={t.title}>
                  {t.title}
                </span>
                <span className="block truncate text-[12px] text-neutral-500" title={command}>
                  {[label, since].filter(Boolean).join(" · ")}
                  {command && (
                    <>
                      {" · "}
                      <span className="font-mono text-[11.5px]">{command}</span>
                    </>
                  )}
                </span>
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => void stop(t)}
                title="Claude Code のタスクの一覧で止めます。止めたことは Claude に伝わります"
                className={cn(STOP, "text-neutral-300 ring-1 ring-white/[0.08]")}
              >
                {stopping === t.id ? "止めています…" : "止める"}
              </button>
            </li>
          );
        })}
      </ul>
      {message && <p className={cn("border-t border-white/[0.06] px-3.5 py-2 text-xs", message.error ? "text-red-400" : "text-amber-400")}>{message.text}</p>}
    </motion.section>
  );
}

/** A stop button: quiet until it is pointed at, then red. */
const STOP =
  "h-8 shrink-0 rounded-lg px-2.5 text-[12.5px] font-medium transition-[color,background-color,box-shadow] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-white/40 disabled:pointer-events-none disabled:opacity-40 [@media(hover:hover)]:hover:bg-red-500/10 [@media(hover:hover)]:hover:text-red-300";
