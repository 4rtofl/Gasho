// The 端末 screen's section for updates: the Gasho server's own version (hub.update, its row first) and each working
// server's gasho-daemon (daemon.update), the latest ones published, and each update with what it will do, its steps
// while it runs, and why one cannot be updated from here.
import { CircleArrowUp, Copy, ExternalLink, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react";
import { AlertDialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import type { AgentInfo, AgentKind, MachineInfo, ServerInfo } from "@gasho/protocol";
import { BUTTON_PRIMARY, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL } from "@/components/dialog-styles";
import { ConfirmUpdateAll, UpdateAllButton, useUpdateAll } from "@/components/update-all";
import { AGENT_LOGIN_COMMAND, AGENT_NAME, AGENT_STATUS_LABEL, CODEX_CHECKED_VERSION, codexOutdated } from "@/lib/agents";
import {
  changesUrl,
  compareVersions,
  INSTALL_COMMAND,
  newerPublished,
  pendingWork,
  RESTART_SLOW_MS,
  STEP_LABEL,
  trialLabel,
  trialLength,
  UPDATE_ALL_WAIT_MS,
  updateOutcome,
  updateTo,
  updateToTell,
} from "@/lib/daemon-update";
import { relativeTime } from "@/lib/format";
import { HUB_INSTALL_COMMAND, HUB_STEP_LABEL, hubChangesUrl, hubNewerPublished, hubUpdateTo } from "@/lib/server-update";
import { useRoute } from "@/lib/route";
import { checkLatest, getAppState, sendCommand, subscribeAppState, updateServer, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn, copyToClipboard } from "@/lib/utils";

const SMALL_BUTTON = "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs hover:border-border-hover disabled:opacity-50";

/**
 * Where DaemonUpdates keeps the updates this tab started, so that a page reloaded meanwhile (to the updated Gasho
 * server's build of the screen) still says "updated". Per tab, as the reload itself (store.ts).
 */
const STARTED_KEY = "gasho.updatesStarted";

function startedInTab(): Record<string, string> {
  try {
    const v: unknown = JSON.parse(sessionStorage.getItem(STARTED_KEY) ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

function keepInTab(started: Record<string, string>): void {
  try {
    if (Object.keys(started).length > 0) sessionStorage.setItem(STARTED_KEY, JSON.stringify(started));
    else sessionStorage.removeItem(STARTED_KEY);
  } catch {
    // kept for this page only: a reload does not say "updated"
  }
}

/**
 * Waits for a working server's update, started by 「すべて更新」, to be done or to fail (updateOutcome): "timeout" after
 * UPDATE_ALL_WAIT_MS, and "left" when the screen goes.
 */
function waitForUpdate(id: string, version: string, failedBefore: number | undefined, signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    let seen = false;
    const check = () => {
      const m = getAppState().machines.find((x) => x.id === id);
      if (m?.update?.progress?.version === version && m.update.progress.step !== "trial") seen = true;
      const outcome = updateOutcome(m, version, failedBefore, seen);
      if (outcome !== "running") finish(outcome);
    };
    const finish = (outcome: string) => {
      unsubscribe();
      clearTimeout(timer);
      signal.removeEventListener("abort", left);
      resolve(outcome);
    };
    const left = () => finish("left");
    const unsubscribe = subscribeAppState(check);
    const timer = setTimeout(() => finish("timeout"), UPDATE_ALL_WAIT_MS);
    signal.addEventListener("abort", left);
    check();
  });
}

/** A command to run on the working server, copied with a click. */
function CommandLine({ command }: { command: string }) {
  return (
    <button
      type="button"
      onClick={() => void copyToClipboard(command)}
      className="mt-1.5 flex w-full items-start gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-left font-mono text-[11px] text-foreground/80 hover:border-border-hover"
      title="コピー"
    >
      <span className="min-w-0 flex-1 break-all">{command}</span>
      <Copy className="mt-0.5 size-3.5 shrink-0" />
    </button>
  );
}

/** An agent on a working server: its version, whether it can be used, and what to do when it cannot. */
function AgentState({ agent, info }: { agent: AgentKind; info: AgentInfo }) {
  const name = AGENT_NAME[agent];
  return (
    <div className="mt-1">
      <p className="text-xs text-muted-foreground">
        <span className="font-mono">{info.version ? `${name} ${info.version}` : name}</span>：{AGENT_STATUS_LABEL[info.status]}
      </p>
      {info.status === "loginRequired" && (
        <>
          <p className="mt-1 text-xs text-muted-foreground">working server でこのコマンドを実行して、ログインしてください。</p>
          <CommandLine command={AGENT_LOGIN_COMMAND[agent]} />
        </>
      )}
      {agent === "codex" && codexOutdated(info) && <p className="mt-1 text-xs text-amber-500">Gasho で確かめた版（{CODEX_CHECKED_VERSION}）より古いバージョンです。</p>}
    </div>
  );
}

export function DaemonUpdates() {
  const { machines, latest, connected, server } = useAppState();
  const now = useNow(5000);
  // The update the dialog asks about.
  const [asking, setAsking] = useState<{ machine: MachineInfo; version: string }>();
  const [askingServer, setAskingServer] = useState<string>();
  // The versions this browser updated working servers (and the Gasho server, "") to: "updated" is shown once they run them.
  const [started, setStarted] = useState<Record<string, string>>(startedInTab);
  // Forgotten once the 端末 screen is left; a reload does not run the cleanup, and the page loaded again reads them.
  useEffect(() => {
    keepInTab(started);
    return () => keepInTab({});
  }, [started]);
  // Opened for it (the settings screen's versions): scrolled to once drawn, however long the 端末 screen took to show.
  const route = useRoute();
  const opened = route.name === "devices" && route.section === "updates";
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (opened) ref.current?.scrollIntoView({ block: "start" });
  }, [opened]);
  // 「すべて更新」: the working servers whose gasho-daemon can be updated now (as the sidebar's badge counts them), one
  // after another, each once its update is done. Not the Gasho server: its restart drops this page's connection.
  const updatable = machines.filter((m) => updateToTell(m, latest));
  const [askingAll, setAskingAll] = useState(false);
  const all = useUpdateAll(async ({ id }, signal) => {
    const { machines: now, latest: newest } = getAppState();
    const m = now.find((x) => x.id === id);
    const to = m && updateTo(m, newest);
    // Updated or gone meanwhile.
    if (!m || !to) return undefined;
    const failedBefore = m.update?.failed?.at;
    const r = await sendCommand(id, { type: "daemon.update", version: to }, 20_000);
    if (!r.ok) return `${to} への更新を始められませんでした。${r.error ?? ""}`;
    setStarted((s) => ({ ...s, [id]: to }));
    const outcome = await waitForUpdate(id, to, failedBefore, signal);
    // "failed": the row says why, as for an update of its own.
    return outcome === "timeout" ? `${to} への更新が10分たっても終わらないので、待たずに次の working server に進みました。` : undefined;
  });

  return (
    <section ref={ref} className="scroll-mt-4 space-y-3 rounded-2xl border border-border bg-surface/40 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <CircleArrowUp className="size-4" />
            Gasho サーバーと gasho-daemon の更新
          </h2>
          <p className="text-xs text-muted-foreground">
            {!latest
              ? "この Gasho サーバーは、公開されている最新のバージョンを調べていません。"
              : latest.checking && !latest.daemon && !latest.hub
                ? "公開されている最新のバージョンを調べています…"
                : latest.daemon || latest.hub
                  ? `公開されている最新のバージョン：${[latest.hub && `Gasho サーバー ${latest.hub}`, latest.daemon && `gasho-daemon ${latest.daemon}`].filter(Boolean).join("・")}（${relativeTime(latest.checkedAt, now)}に調べました）`
                  : "公開されている最新のバージョンは、まだわかりません。"}
          </p>
          {latest?.error && <p className="mt-1 text-xs text-red-400">{latest.error}</p>}
          {latest?.hubError && <p className="mt-1 text-xs text-muted-foreground">{latest.hubError}</p>}
        </div>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <UpdateAllButton count={updatable.length} progress={all.progress} disabled={!connected} onClick={() => setAskingAll(true)} />
          {latest && (
            <button type="button" className={SMALL_BUTTON} disabled={!connected || latest.checking} onClick={checkLatest}>
              <RefreshCw className={cn("size-3.5", latest.checking && "animate-spin")} />
              今すぐ調べる
            </button>
          )}
        </div>
      </div>

      <ul className="divide-y divide-border rounded-xl border border-border bg-background">
        <ServerRow
          server={server}
          connected={connected}
          now={now}
          updated={started[""] !== undefined && started[""] === server?.version}
          onUpdate={setAskingServer}
        />
      </ul>

      {machines.length === 0 ? (
        <p className="text-sm text-muted-foreground">登録された working server はありません。</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-background">
          {machines.map((m) => (
            <MachineRow
              key={m.id}
              machine={m}
              now={now}
              updated={started[m.id] !== undefined && started[m.id] === m.daemonVersion}
              updating={all.progress?.item.id === m.id}
              updatingAll={Boolean(all.progress)}
              failure={all.failures[m.id]}
              onUpdate={(version) => setAsking({ machine: m, version })}
            />
          ))}
        </ul>
      )}

      {askingServer && server && (
        <ConfirmServerUpdate
          server={server}
          version={askingServer}
          onClose={() => setAskingServer(undefined)}
          onStarted={() => setStarted((s) => ({ ...s, "": askingServer }))}
        />
      )}
      {asking && (
        <ConfirmUpdate
          machine={asking.machine}
          version={asking.version}
          onClose={() => setAsking(undefined)}
          onStarted={() => {
            setStarted((s) => ({ ...s, [asking.machine.id]: asking.version }));
            all.forget(asking.machine.id);
          }}
        />
      )}
      {askingAll && (
        <ConfirmUpdateAllDaemons
          machines={updatable}
          serverToo={Boolean(connected && hubUpdateTo(server, latest))}
          onClose={() => setAskingAll(false)}
          onConfirm={() => void all.run(updatable.map((m) => ({ id: m.id, name: m.name })))}
        />
      )}
    </section>
  );
}

function MachineRow({
  machine: m,
  now,
  updated,
  updating,
  updatingAll,
  failure,
  onUpdate,
}: {
  machine: MachineInfo;
  now: number;
  updated: boolean;
  /** 「すべて更新」 is updating it now. */
  updating: boolean;
  /** 「すべて更新」 goes on: its own buttons wait. */
  updatingAll: boolean;
  /** Why 「すべて更新」 could not update it (not a failure the working server tells of: the row says that one). */
  failure?: string;
  onUpdate: (version: string) => void;
}) {
  const { latest } = useAppState();
  const u = m.update;
  const to = updateTo(m, latest);
  // The version it came from; after going back from the latest, "update" offers it already.
  const previous = m.connected && u?.canUpdate && (!u.progress || u.progress.step === "trial") && u.previous !== to ? u.previous : undefined;

  let status: React.ReactNode;
  if (u?.progress && u.progress.step === "trial" && m.connected) {
    status = (
      <p className="flex items-center gap-1.5 text-xs text-foreground/80">
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
        {trialLabel(u.trialMs)}
      </p>
    );
  } else if (u?.progress && (m.connected || u.progress.step === "restart")) {
    const slow = !m.connected && now - u.progress.at > RESTART_SLOW_MS;
    status = (
      <>
        <p className="flex items-center gap-1.5 text-xs text-foreground/80">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          {u.progress.version} に更新しています：{STEP_LABEL[u.progress.step]}
        </p>
        {slow && (
          <p className="mt-1 text-xs text-amber-500">
            動かし直してから2分以上たっても、つながりません。working server のログを見てください（Ubuntu：journalctl --user -u gasho-daemon、Mac：~/Library/Logs/gasho-daemon.log）。
          </p>
        )}
      </>
    );
  } else if (!m.connected) {
    status = <p className="text-xs text-muted-foreground">オフライン・最後の接続 {relativeTime(m.lastSeen, now)}</p>;
  } else if (!u) {
    // A gasho-daemon from before updates from Gasho says nothing about them.
    status = (
      <>
        <p className="text-xs text-muted-foreground">
          このバージョンの gasho-daemon は、Gasho からは更新できません。working server でこのコマンドを一度実行すると、最新のバージョンになり、これからは Gasho から更新できます。
        </p>
        <CommandLine command={INSTALL_COMMAND} />
      </>
    );
  } else if (!u.canUpdate) {
    status = (
      <>
        {newerPublished(m, latest) && <p className="text-xs text-foreground/80">{latest?.daemon} が公開されています。</p>}
        <p className="text-xs text-muted-foreground">{u.reason ?? "Gasho からは更新できません。"}</p>
        {u.command && <CommandLine command={u.command} />}
      </>
    );
  } else {
    status = (
      <p className={cn("text-xs", updated ? "text-emerald-500" : "text-muted-foreground")}>
        {updated ? `${m.daemonVersion} に更新しました。` : to ? `${to} に更新できます。` : latest?.daemon ? "最新のバージョンです。" : ""}
      </p>
    );
  }

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-3" aria-current={updating || undefined}>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium">{m.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{m.daemonVersion ? `gasho-daemon ${m.daemonVersion}` : "バージョンは不明"}</span>
        </p>
        <div className="mt-0.5">{status}</div>
        {m.connected && m.agents?.claude && <AgentState agent="claude" info={m.agents.claude} />}
        {m.connected && m.agents?.codex && <AgentState agent="codex" info={m.agents.codex} />}
        {m.connected && u?.rolledBack && (
          <p className="mt-1 text-xs text-amber-500">
            {u.rolledBack.from} がうまく起動しなかったので、{u.rolledBack.to} に自動で戻しました（{relativeTime(u.rolledBack.at, now)}）。{u.rolledBack.error}
          </p>
        )}
        {m.connected && u?.failed && (!u.progress || u.progress.step === "trial") && (
          <p className="mt-1 text-xs text-red-400">
            {u.failed.version} への更新に失敗しました（{relativeTime(u.failed.at, now)}）。何も変えていません。{u.failed.error}
          </p>
        )}
        {failure && <p className="mt-1 text-xs text-red-400">{failure}</p>}
      </div>
      {(to || previous) && (
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {previous && (
            <button type="button" className={SMALL_BUTTON} disabled={updatingAll} onClick={() => onUpdate(previous)}>
              <RotateCcw className="size-3.5" />
              {previous} に戻す
            </button>
          )}
          {to && (
            <button
              type="button"
              className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              disabled={updatingAll}
              onClick={() => onUpdate(to)}
            >
              {to} に更新
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** 「すべて更新」's dialog: the working servers it updates, one after another, and what waits on each. */
function ConfirmUpdateAllDaemons({
  machines,
  serverToo,
  onClose,
  onConfirm,
}: {
  machines: MachineInfo[];
  /** The Gasho server can be updated too (by its own row). */
  serverToo: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { latest } = useAppState();
  const trials = machines.map((m) => m.update?.trialMs);
  const items = machines.map((m) => {
    const to = updateTo(m, latest) ?? "";
    const from = m.daemonVersion;
    const { inputs, requests } = pendingWork(m);
    return {
      id: m.id,
      label: (
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{m.name}</span>
          <span className="font-mono text-xs text-muted-foreground">
            {from ? `${from} → ${to}` : to}
          </span>
        </span>
      ),
      detail: (inputs > 0 || requests > 0 || from) && (
        <>
          {inputs > 0 && <p>送るのを待っている入力が {inputs} 件あります。送り終えてから切り替えます。5分たっても残っているときは、この working server の更新をやめます。</p>}
          {requests > 0 && <p>権限の確認を待っているものが {requests} 件あります。動かし直したあとは Gasho から答えられなくなるので、端末か公式アプリで答えてください。</p>}
          {from && (
            <a href={changesUrl(from, to)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline">
              {from} からの変更を GitHub で見る
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </>
      ),
    };
  });
  const notes = [
    "1台ずつ、新しいバージョンを取り込み、起動できることを確かめてから切り替えて、gasho-daemon を動かし直します。1台の更新が終わってから、次の working server に進みます。うまくいかなかった working server は何も変えずに、残りを続けます。",
    "セッションは止まりません。動かし直すあいだ（10秒ほど）は、その working server の様子が届きません。",
    trials.every((t) => t !== undefined) &&
      `新しいバージョンがうまく起動しなかったとき（${new Set(trials).size === 1 && trials[0] !== undefined ? `${trialLength(trials[0])}のうちに止まったとき` : "確かめているうちに止まったとき"}）は、自動で前のバージョンに戻します。`,
    "この画面を離れると、そのとき更新している working server のあとは更新しません。",
    serverToo && "Gasho サーバーは含みません（更新するあいだ、この画面とのつながりが切れるため）。Gasho サーバーの行から更新してください。",
  ].filter((l): l is string => typeof l === "string");
  return (
    <ConfirmUpdateAll
      title={`${machines.length} 台の gasho-daemon を更新しますか？`}
      items={items}
      notes={notes}
      onClose={onClose}
      onConfirm={onConfirm}
    />
  );
}

function ConfirmUpdate({ machine, version, onClose, onStarted }: { machine: MachineInfo; version: string; onClose: () => void; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const from = machine.daemonVersion;
  const back = from !== undefined && compareVersions(version, from) < 0;
  const installed = machine.update?.installed?.includes(version) ?? false;
  const { inputs, requests } = pendingWork(machine);
  const trialMs = machine.update?.trialMs;
  const lines = [
    installed
      ? `入っている ${version} に切り替えて、gasho-daemon を動かし直します。`
      : `${version} を取り込み、起動できることを確かめてから切り替えて、gasho-daemon を動かし直します。うまくいかなかったときは、何も変えません。`,
    "セッションは止まりません。動かし直すあいだ（10秒ほど）は、この working server の様子が届きません。",
    // A version older than the running one may not go back by itself.
    trialMs !== undefined &&
      !back &&
      `新しいバージョンがうまく起動しなかったとき（${trialLength(trialMs)}のうちに止まったとき）は、自動で前のバージョンに戻します。`,
    inputs > 0 && `送るのを待っている入力が ${inputs} 件あります。送り終えてから切り替えます。5分たっても残っているときは、更新をやめます。`,
    requests > 0 &&
      `権限の確認を待っているものが ${requests} 件あります。動かし直したあとは Gasho から答えられなくなるので、端末か公式アプリで答えてください。`,
  ].filter((l): l is string => typeof l === "string");

  const start = async () => {
    setBusy(true);
    setError(undefined);
    const r = await sendCommand(machine.id, { type: "daemon.update", version }, 20_000);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "更新を始められませんでした。");
      return;
    }
    onStarted();
    onClose();
  };

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
          <AlertDialog.Title className="text-base font-semibold tracking-tight">
            「{machine.name}」の gasho-daemon を {version} に{back ? "戻しますか" : "更新しますか"}？
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              {lines.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
              {from && !back && (
                <a
                  href={changesUrl(from, version)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
                >
                  {from} からの変更を GitHub で見る
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          </AlertDialog.Description>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={busy} className={BUTTON_SECONDARY}>
                キャンセル
              </button>
            </AlertDialog.Cancel>
            {/* Not AlertDialog.Action, which would close the dialog before the answer comes. */}
            <button type="button" onClick={() => void start()} disabled={busy} className={BUTTON_PRIMARY}>
              {busy ? "始めています…" : back ? "戻す" : "更新する"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** How long the Gasho server's restart may take before the row suggests looking at its log. */
const SERVER_RESTART_SLOW_MS = 2 * 60_000;

/** The Gasho server's own row: its version, its update and trial, what went back by itself, and why it cannot update. */
function ServerRow({
  server,
  connected,
  now,
  updated,
  onUpdate,
}: {
  server: ServerInfo | undefined;
  connected: boolean;
  now: number;
  updated: boolean;
  onUpdate: (version: string) => void;
}) {
  const { latest } = useAppState();
  const u = server?.update;
  const to = connected ? hubUpdateTo(server, latest) : undefined;
  // The version it came from; after going back from the latest, "update" offers it already.
  const previous = connected && u?.canUpdate && (!u.progress || u.progress.step === "trial") && u.previous !== to ? u.previous : undefined;

  let status: React.ReactNode;
  if (u?.progress && u.progress.step === "trial" && connected) {
    status = (
      <p className="flex items-center gap-1.5 text-xs text-foreground/80">
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
        {HUB_STEP_LABEL.trial}
      </p>
    );
  } else if (u?.progress && (connected || u.progress.step === "restart")) {
    const slow = !connected && now - u.progress.at > SERVER_RESTART_SLOW_MS;
    status = (
      <>
        <p className="flex items-center gap-1.5 text-xs text-foreground/80">
          <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
          {u.progress.version} に更新しています：{HUB_STEP_LABEL[u.progress.step]}
        </p>
        {slow && (
          <p className="mt-1 text-xs text-amber-500">
            起動し直してから2分以上たっても、つながりません。Gasho サーバーのマシンでログを見てください（Ubuntu：journalctl --user -u gasho-hub、Mac：~/Library/Logs/gasho-hub.log）。
          </p>
        )}
      </>
    );
  } else if (!connected) {
    status = <p className="text-xs text-muted-foreground">Gasho サーバーにつながっていません。</p>;
  } else if (!server) {
    // A Gasho server from before updates from Gasho says nothing about itself.
    status = (
      <>
        <p className="text-xs text-muted-foreground">
          このバージョンの Gasho サーバーは、Gasho からは更新できません。Gasho サーバーのマシンでこのコマンドを一度実行すると、これからは Gasho から更新できます。
        </p>
        <CommandLine command={HUB_INSTALL_COMMAND} />
      </>
    );
  } else if (!u?.canUpdate) {
    status = (
      <>
        {hubNewerPublished(server, latest) && <p className="text-xs text-foreground/80">{latest?.hub} が公開されています。</p>}
        <p className="text-xs text-muted-foreground">{u?.reason ?? "Gasho からは更新できません。"}</p>
        {u?.command && <CommandLine command={u.command} />}
      </>
    );
  } else {
    status = (
      <p className={cn("text-xs", updated ? "text-emerald-500" : "text-muted-foreground")}>
        {updated ? `${server.version} に更新しました。` : to ? `${to} に更新できます。` : latest?.hub ? "最新のバージョンです。" : ""}
      </p>
    );
  }

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-3">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-medium">Gasho サーバー</span>
          <span className="font-mono text-xs text-muted-foreground">{server ? `gasho-hub ${server.version}` : "バージョンは不明"}</span>
        </p>
        <div className="mt-0.5">{status}</div>
        {connected && u?.rolledBack && (
          <p className="mt-1 text-xs text-amber-500">
            {u.rolledBack.from} がうまく起動しなかったので、{u.rolledBack.to} に自動で戻しました（{relativeTime(u.rolledBack.at, now)}）。{u.rolledBack.error}
          </p>
        )}
        {connected && u?.failed && (!u.progress || u.progress.step === "trial") && (
          <p className="mt-1 text-xs text-red-400">
            {u.failed.version} への更新に失敗しました（{relativeTime(u.failed.at, now)}）。何も変えていません。{u.failed.error}
          </p>
        )}
      </div>
      {(to || previous) && (
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {previous && (
            <button type="button" className={SMALL_BUTTON} onClick={() => onUpdate(previous)}>
              <RotateCcw className="size-3.5" />
              {previous} に戻す
            </button>
          )}
          {to && (
            <button type="button" className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground" onClick={() => onUpdate(to)}>
              {to} に更新
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function ConfirmServerUpdate({ server, version, onClose, onStarted }: { server: ServerInfo; version: string; onClose: () => void; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const from = server.version;
  const back = compareVersions(version, from) < 0;
  const installed = server.update.installed?.includes(version) ?? false;
  const lines = [
    installed
      ? `入っている ${version} に切り替えて、Gasho サーバーを起動し直します。`
      : `${version} を取り込み、起動できるかと、データベースを開けるか（写しで）を確かめてから切り替えて、Gasho サーバーを起動し直します。うまくいかなかったときは、何も変えません。`,
    "処理中の命令（セッションへの送信、起動、プラグインの追加など）が終わるのを待ってから起動し直します。そのあいだは新しい命令を受け付けず、2分たっても終わらなければ更新をやめます。",
    "起動し直すあいだ（数秒）、Gasho につながりません。セッションは working server で動き続けます。",
    "新しいバージョンがうまく起動しなかったとき（1分のうちに止まったとき）は、自動で前のバージョンに戻します。",
    "開いているページは、つながり直すと新しい画面に読み込み直します。入力欄に書きかけがあるページは、読み込み直すかを聞きます。",
  ];

  const start = async () => {
    setBusy(true);
    setError(undefined);
    const r = await updateServer(version);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "更新を始められませんでした。");
      return;
    }
    onStarted();
    onClose();
  };

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
          <AlertDialog.Title className="text-base font-semibold tracking-tight">
            Gasho サーバーを {version} に{back ? "戻しますか" : "更新しますか"}？
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              {lines.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
              {!back && (
                <a
                  href={hubChangesUrl(from, version)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
                >
                  {from} からの変更を GitHub で見る
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          </AlertDialog.Description>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" disabled={busy} className={BUTTON_SECONDARY}>
                キャンセル
              </button>
            </AlertDialog.Cancel>
            {/* Not AlertDialog.Action, which would close the dialog before the answer comes. */}
            <button type="button" onClick={() => void start()} disabled={busy} className={BUTTON_PRIMARY}>
              {busy ? "始めています…" : back ? "戻す" : "更新する"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
