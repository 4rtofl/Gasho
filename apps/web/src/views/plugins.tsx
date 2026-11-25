// The plugins screen (docs/plugins.md, P9), opened from "プラグイン" in the sidebar: the plugins installed on the Gasho
// server, whether each is enabled (a switch), how its daemon part stands on each working server (it runs on every one
// while the plugin is enabled), and why it cannot be used when it cannot; and the plugins of GashoPlugins (its catalog,
// P10), listed by genre, to add, update and remove. Every change goes live at once (hot reload). Plugins being
// developed are linked with the Gasho server's command instead (npm run hub:plugin -- add --link), and are never
// updated from the catalog.
import { ArrowUpCircle, LoaderCircle, Palette, Plus, Puzzle, RefreshCw, Settings2, Trash2 } from "lucide-react";
import { AlertDialog, Dialog } from "radix-ui";
import { useEffect, useState } from "react";
import type { CatalogPlugin, MachineInfo, PluginCatalog, PluginDaemonState, PluginInfo } from "@gasho/protocol";
import { BUTTON_DANGER, BUTTON_PRIMARY, BUTTON_SECONDARY, DIALOG_OVERLAY, DIALOG_PANEL } from "@/components/dialog-styles";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { relativeTime } from "@/lib/format";
import { notInCatalog, updatesOf } from "@/lib/plugin-catalog";
import { byGenre, genreName, genreOf } from "@/lib/plugin-genres";
import { go } from "@/lib/route";
import { requestCatalog, sendPluginCommand, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { apiSupported, usePluginRegistry } from "@/plugins/registry";
import { useSessionListMode } from "@/plugins/session-list";
import { enabledThemes } from "@/plugins/theme";

const STATE: Record<PluginDaemonState, { label: string; className: string; dot: string }> = {
  running: { label: "動いている", className: "text-emerald-400", dot: "bg-emerald-400" },
  stopped: { label: "起動中", className: "text-muted-foreground", dot: "bg-muted-foreground" },
  off: { label: "動かさない", className: "text-muted-foreground", dot: "bg-muted-foreground" },
  old: { label: "gasho-daemon が古い", className: "text-amber-400", dot: "bg-amber-400" },
  failed: { label: "失敗", className: "text-red-400", dot: "bg-red-400" },
  offline: { label: "オフライン", className: "text-muted-foreground", dot: "bg-muted-foreground/50" },
};

const PERMISSION_NAMES: Record<string, string> = { "session.input": "セッションに発言を送る", "session.launch": "セッションを起動する", "session.remove": "セッションを削除する" };
const BUTTON = "inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs hover:border-border-hover disabled:opacity-50";
/** Removing a plugin: a red trash can alone (the dialog asks first). */
const REMOVE_BUTTON =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-destructive outline-none transition-colors hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 pointer-coarse:size-9";
const CHIP = "rounded-full border border-border px-1.5 py-px text-[11px] font-normal text-muted-foreground";
/** Adding or updating fetches the plugin's file first (the Gasho server gives up after 2 minutes). */
const INSTALL_WAIT_MS = 150_000;

const permissionsText = (permissions: readonly string[] | undefined) =>
  permissions && permissions.length > 0 ? `権限：${permissions.map((p) => PERMISSION_NAMES[p] ?? p).join("、")}` : undefined;

const needsApi = (api: string) => `この Gasho では使えません（プラグインの API ${api} が要ります）。`;

export function PluginsView() {
  const { infos, parts, errors, loading } = usePluginRegistry();
  const { machines, catalog, connected } = useAppState();
  const [adding, setAdding] = useState<CatalogPlugin>();
  const [removing, setRemoving] = useState<PluginInfo>();
  // Opening the screen (or connecting while it is open) reads the catalog again when it is older than 10 minutes.
  useEffect(() => {
    if (connected) requestCatalog();
  }, [connected]);
  const sorted = [...infos].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, "ja"));
  const updates = updatesOf(infos, catalog);
  const missing = notInCatalog(infos, catalog);
  const installed = new Set(infos.map((i) => i.id));
  const available = (catalog?.plugins ?? []).filter((p) => !installed.has(p.id)).sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const groups = byGenre(available, catalog?.genres);
  const [themeInUse, ...othersEnabled] = enabledThemes(infos);
  // The sidebar's session list is the first such plugin's (P17); another's is not used. While it shows, the worktrees'
  // groupings (P18) are not used either.
  const [listInUse, ...otherLists] = parts.filter((p) => p.def.sessionList);
  const listMode = useSessionListMode();
  const noteOf = (info: PluginInfo) =>
    themeInUse && othersEnabled.some((t) => t.id === info.id)
      ? `テーマが2つ以上有効です。当てているのは ${themeInUse.manifest.name} です。使わないテーマを無効にしてください。`
      : listInUse && otherLists.some((p) => p.info.id === info.id)
        ? `サイドバーのセッションの一覧を決めるプラグインが2つ以上有効です。使っているのは ${listInUse.info.manifest.name} の一覧です。`
        : listInUse && listMode.kind !== "gasho" && parts.some((p) => p.info.id === info.id && p.def.worktreeGroupings?.length && !p.def.sessionList)
          ? `${listInUse.info.manifest.name} がサイドバーをセッションの一覧にしているので、worktree の分け方は使っていません。`
          : undefined;
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-4 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight">プラグイン</h1>
          <CatalogStatus catalog={catalog} />
        </div>
        {catalog && (
          <button type="button" className={BUTTON} disabled={catalog.loading} onClick={() => requestCatalog(true)}>
            <RefreshCw className={cn("size-3.5", catalog.loading && "animate-spin")} />
            再読み込み
          </button>
        )}
      </div>

      <section aria-labelledby="installed" className="space-y-3">
        <h2 id="installed" className="text-sm font-medium">
          入れたもの
        </h2>
        {sorted.length === 0 ? (
          <p className="rounded-2xl border border-border bg-surface/40 p-4 text-sm text-muted-foreground">まだプラグインは入っていません。</p>
        ) : (
          <ul className="space-y-3">
            {sorted.map((info) => (
              <PluginCard
                key={info.id}
                info={info}
                machines={machines}
                genre={genreName(catalog, genreOf(info, catalog))}
                loadError={errors[info.id]}
                loading={Boolean(loading[info.id])}
                update={updates.get(info.id)}
                missing={missing.has(info.id)}
                note={noteOf(info)}
                onRemove={() => setRemoving(info)}
              />
            ))}
          </ul>
        )}
      </section>

      {catalog && (
        <section aria-labelledby="catalog" className="space-y-3">
          <h2 id="catalog" className="text-sm font-medium">
            GashoPlugins にあるもの
          </h2>
          {available.length === 0 ? (
            <p className="rounded-2xl border border-border bg-surface/40 p-4 text-sm text-muted-foreground">
              {catalog.checkedAt ? "ほかに入れられるプラグインはありません。" : catalog.loading ? "一覧を読んでいます…" : "一覧をまだ読めていません。"}
            </p>
          ) : groups ? (
            <div className="space-y-5">
              {groups.map((g) => (
                <div key={g.genre?.id ?? ""} role="group" aria-labelledby={`genre-${g.genre?.id ?? "none"}`} className="space-y-2">
                  <h3 id={`genre-${g.genre?.id ?? "none"}`} className="text-xs font-medium text-muted-foreground">
                    {g.genre?.name ?? "ジャンルなし"}
                  </h3>
                  <ul className="space-y-3">
                    {g.plugins.map((p) => (
                      <CatalogCard key={p.id} plugin={p} genre={g.genre?.name} onAdd={() => setAdding(p)} />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <ul className="space-y-3">
              {available.map((p) => (
                <CatalogCard key={p.id} plugin={p} onAdd={() => setAdding(p)} />
              ))}
            </ul>
          )}
        </section>
      )}

      <p className="text-xs text-muted-foreground">
        作っているプラグインは、Gasho サーバーで <code className="font-mono text-[0.92em]">npm run hub:plugin -- add --link &lt;dist フォルダー&gt;</code>{" "}
        を実行して入れます。ビルドするたびに、画面と gasho-daemon が新しいバージョンに入れ替わります。
      </p>

      {adding && <AddDialog plugin={adding} onClose={() => setAdding(undefined)} />}
      {removing && <RemoveDialog info={removing} onClose={() => setRemoving(undefined)} />}
    </div>
  );
}

/** Which repository the catalog is read from, when it was last read, and why it could not be read. */
function CatalogStatus({ catalog }: { catalog: PluginCatalog | undefined }) {
  const now = useNow();
  if (!catalog) return <p className="text-sm text-muted-foreground">Gasho サーバーに入っているプラグインです。</p>;
  const rel = catalog.checkedAt ? relativeTime(catalog.checkedAt, now) : undefined;
  const when = rel === "たった今" ? rel : `${rel}に`;
  // After a failure, the list shown is the one read before (if any).
  const note = catalog.loading ? "（読んでいます…）" : !rel ? "" : catalog.error ? `（${when}読んだもの）` : `（${when}確認）`;
  return (
    <div className="space-y-0.5">
      <p className="text-sm text-muted-foreground">
        {catalog.repo} の一覧{note}
      </p>
      {catalog.error && <p className="text-xs text-red-400">一覧を読めませんでした：{catalog.error}</p>}
    </div>
  );
}

function PluginCard({
  info,
  machines,
  genre,
  loadError,
  loading,
  update,
  missing,
  note,
  onRemove,
}: {
  info: PluginInfo;
  machines: MachineInfo[];
  /** The name of its genre (from the catalog). */
  genre?: string;
  loadError?: string;
  loading: boolean;
  /** The catalog's newer version of it. */
  update?: CatalogPlugin;
  /** The catalog no longer lists it (renamed or removed in GashoPlugins). */
  missing: boolean;
  /** Why this enabled plugin is not used in full: a theme or a session list that another one's stands in for. */
  note?: string;
  onRemove: () => void;
}) {
  const [busy, setBusy] = useState<"change" | "update">();
  const [error, setError] = useState<string>();
  const m = info.manifest;
  const hasSettings = Object.keys(m.settings ?? {}).length > 0;
  const run = async (cmd: Parameters<typeof sendPluginCommand>[0], what: "change" | "update" = "change") => {
    setBusy(what);
    setError(undefined);
    const r = await sendPluginCommand(cmd, what === "update" ? INSTALL_WAIT_MS : undefined);
    setBusy(undefined);
    if (!r.ok) setError(r.error ?? (what === "update" ? "更新できませんでした。" : "変えられませんでした。"));
  };
  const problem = info.error ?? (info.enabled ? loadError : undefined);
  const canUpdate = update && apiSupported(update.api);
  return (
    <li className="space-y-3 rounded-2xl border border-border bg-surface/40 p-4">
      {/* The switch and the buttons stay at the top right, below the text only on a phone. */}
      <div className="flex flex-wrap items-start justify-between gap-3 sm:flex-nowrap">
        <div className="min-w-0 sm:flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
            {m.theme ? <Palette className="size-4 text-muted-foreground" /> : <Puzzle className="size-4 text-muted-foreground" />}
            {m.name}
            {m.version && <span className="text-xs font-normal text-muted-foreground tabular-nums">{m.version}</span>}
            {update && (
              <span className={cn("text-xs font-normal", canUpdate ? "text-sky-300" : "text-muted-foreground")}>
                {canUpdate ? `（${update.version} に更新できる）` : `（${update.version} は API ${update.api} が要る）`}
              </span>
            )}
            {/* A theme that names no genre the catalog lists still says it is one. */}
            {genre ? <span className={CHIP}>{genre}</span> : m.theme && <span className={CHIP}>テーマ</span>}
            {info.dev && <span className="rounded-full border border-sky-500/40 px-1.5 py-px text-[11px] font-normal text-sky-300">開発中</span>}
            {missing && (
              <Badge variant="outline" tone="warning" className="h-auto px-1.5 py-px text-[11px] font-normal">
                GashoPlugins の一覧にない
              </Badge>
            )}
            {info.enabled && loading && <span className="text-[11px] font-normal text-muted-foreground">読み込み中…</span>}
          </p>
          {m.description && <p className="mt-1 text-xs text-muted-foreground">{m.description}</p>}
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{info.id}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canUpdate && (
            <button type="button" className={BUTTON} disabled={Boolean(busy)} onClick={() => void run({ type: "plugin.update", plugin: info.id }, "update")}>
              {busy === "update" ? <LoaderCircle className="size-3.5 animate-spin" /> : <ArrowUpCircle className="size-3.5" />}
              {busy === "update" ? "更新しています…" : "更新"}
            </button>
          )}
          {hasSettings && info.enabled && (
            <button
              type="button"
              className={BUTTON}
              onClick={() => go({ name: "settings", plugin: info.id })}
            >
              <Settings2 className="size-3.5" />
              設定
            </button>
          )}
          <Switch
            checked={info.enabled}
            disabled={Boolean(busy)}
            onCheckedChange={(enabled) => void run({ type: "plugin.enable", plugin: info.id, enabled })}
            aria-label={`${m.name} を有効にする`}
            title={info.enabled ? "有効" : "無効"}
          />
          <button type="button" className={REMOVE_BUTTON} disabled={Boolean(busy)} onClick={onRemove} aria-label={`${m.name} を外す`} title="外す">
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>

      {problem && <p className="text-xs text-red-400">{problem}</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
      {note && <p className="text-xs text-amber-400">{note}</p>}
      {permissionsText(m.permissions) && <p className="text-xs text-muted-foreground">{permissionsText(m.permissions)}</p>}
      {/* Disabled, it runs nowhere: every working server would only say so. */}
      {m.daemon && info.enabled && <DaemonStates info={info} machines={machines} />}
    </li>
  );
}

/** A plugin of the catalog that is not installed: added after the questions of AddDialog. */
function CatalogCard({ plugin, genre, onAdd }: { plugin: CatalogPlugin; genre?: string; onAdd: () => void }) {
  const problem = apiSupported(plugin.api) ? undefined : needsApi(plugin.api);
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-border bg-surface/40 p-4">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
          <Puzzle className="size-4 text-muted-foreground" />
          {plugin.name}
          <span className="text-xs font-normal text-muted-foreground tabular-nums">{plugin.version}</span>
          {genre && <span className={CHIP}>{genre}</span>}
        </p>
        {plugin.description && <p className="mt-1 text-xs text-muted-foreground">{plugin.description}</p>}
        {permissionsText(plugin.permissions) && <p className="mt-1 text-xs text-muted-foreground">{permissionsText(plugin.permissions)}</p>}
        {problem && <p className="mt-1 text-xs text-amber-400">{problem}</p>}
      </div>
      <button type="button" className={BUTTON} disabled={Boolean(problem)} onClick={onAdd}>
        <Plus className="size-3.5" />
        追加
      </button>
    </li>
  );
}

/** Adding a plugin of the catalog: what it may do, asked before it is added. */
function AddDialog({ plugin, onClose }: { plugin: CatalogPlugin; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const add = async () => {
    setBusy(true);
    setError(undefined);
    const r = await sendPluginCommand({ type: "plugin.install", plugin: plugin.id }, INSTALL_WAIT_MS);
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "追加できませんでした。");
      return;
    }
    onClose();
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
        <Dialog.Content className={DIALOG_PANEL}>
          <Dialog.Title className="text-base font-semibold tracking-tight">{plugin.name} を追加</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              <p>
                <span className="tabular-nums">{plugin.version}</span>
                {plugin.description ? `　${plugin.description}` : ""}
              </p>
              {permissionsText(plugin.permissions) && <p>{permissionsText(plugin.permissions)}</p>}
              <p>追加すると、すぐに有効になります。プラグインは、Gasho の画面と同じ権限で動きます。</p>
              {plugin.daemon && <p>working server で動く部分は、すべての working server で動かします（あとから登録したものでも）。</p>}
            </div>
          </Dialog.Description>
          {error && <p className="mt-3 text-sm text-red-400">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <button type="button" disabled={busy} className={BUTTON_SECONDARY}>
                やめる
              </button>
            </Dialog.Close>
            <button type="button" onClick={() => void add()} disabled={busy} className={BUTTON_PRIMARY}>
              {busy ? "追加しています…" : "追加して有効にする"}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Removing a plugin: its files and the settings the Gasho server keeps; only the link for one being developed. */
function RemoveDialog({ info, onClose }: { info: PluginInfo; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const name = info.manifest.name;
  const remove = async () => {
    setBusy(true);
    setError(undefined);
    const r = await sendPluginCommand({ type: "plugin.remove", plugin: info.id });
    setBusy(false);
    if (!r.ok) {
      setError(r.error ?? "外せませんでした。");
      return;
    }
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
          <AlertDialog.Title className="text-base font-semibold tracking-tight">{name} を外しますか？</AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              {info.dev ? (
                <p>Gasho サーバーに置いたリンクだけを消します。作っているプラグインのフォルダーは、そのまま残ります。</p>
              ) : (
                <>
                  <p>プラグインのファイルと、Gasho サーバーに保存したこのプラグインの設定を消します。開いている画面と gasho-daemon からも、すぐに外れます。</p>
                  <p>ブラウザーに覚えた設定は、それぞれのブラウザーに残ります。</p>
                </>
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
            <button type="button" onClick={() => void remove()} disabled={busy} className={BUTTON_DANGER}>
              {busy ? "外しています…" : "外す"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

/** How the daemon part stands on each working server: it runs on every one of them while the plugin is enabled. */
function DaemonStates({ info, machines }: { info: PluginInfo; machines: MachineInfo[] }) {
  if (machines.length === 0) return <p className="text-xs text-muted-foreground">working server はまだ登録されていません。</p>;
  const failures = machines.flatMap((m) => {
    const error = info.daemon?.[m.id]?.error;
    return error ? [{ id: m.id, name: m.name, error }] : [];
  });
  return (
    <div className="space-y-1 text-xs">
      <div className="flex items-start gap-3">
        <span className="shrink-0 text-muted-foreground">working server</span>
        <ul aria-label="working server ごとの状態" className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
          {machines.map((m) => {
            const d = info.daemon?.[m.id];
            const s = d ? STATE[d.state] : undefined;
            return (
              <li key={m.id} className="inline-flex min-w-0 items-center gap-1.5">
                <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", s?.dot ?? "bg-muted-foreground/50")} />
                <span className="truncate">{m.name}</span>
                {s && <span className={s.className}>{s.label}</span>}
              </li>
            );
          })}
        </ul>
      </div>
      {failures.map((f) => (
        <p key={f.id} className="text-red-400">
          {f.name}：{f.error}
        </p>
      ))}
    </div>
  );
}
