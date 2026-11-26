// The footer of a session's screen (4rtofl/Gasho#298): one line at the bottom of the session's column with the
// connection to the Gasho server and this browser's name, the memory of the session's working server, the plugins'
// parts (P21), the session's context window, and the Claude.ai plan's usage limits. Pressing the context window or a
// limit opens the details, as the usage plugin's popover did. On a phone the line is short (numbers only), each item
// opens the details (with the memory), and what does not fit the width is left out. The footer keeps the iPhone's home
// indicator clear (its safe area), right under the chat box.
//
// The limits come from the status line of the working server's sessions (SessionInfo.limits) and from Claude Code's
// get_usage, which gasho-daemon reads when a browser asks (usage.get): every 5 minutes while the footer is on screen,
// every minute while the details are open. The newer of the two is shown; the models' weekly limits come only from
// get_usage.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import type { MachineInfo, MachineMemory, MachineUsage, SessionInfo } from "@gasho/protocol";
import { MEMORY_LEVELS, memoryAmount, memoryLevel, memoryPercent } from "@/components/memory-meters";
import { relativeTime } from "@/lib/format";
import { DESKTOP, useMediaQuery, usePageVisible } from "@/lib/media";
import {
  clampPercent,
  footerRows,
  latestStatusLineLimits,
  limitsView,
  resetLabel,
  shortLabel,
  shortReset,
  shortTokens,
  shownPercent,
  tokens,
  toneOf,
  type LimitRow,
  type LimitsView,
  type Tone,
} from "@/lib/plan-usage";
import { sendToHub, useAppState } from "@/lib/store";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";
import { PluginSessionFooter } from "@/plugins/parts";

/** How old the limits read with get_usage may be while the footer is on screen, and while the details are open. */
export const FOOTER_MAX_AGE_MS = 5 * 60_000;
export const DETAILS_MAX_AGE_MS = 60_000;
/** How often the footer asks again (the Gasho server reads only what is older than the above). */
const ASK_EVERY_MS = 60_000;

const TONE_TEXT: Record<Tone, string> = {
  normal: "text-foreground",
  warn: "text-amber-600 dark:text-amber-400",
  danger: "text-red-600 dark:text-red-400",
};
const TONE_BAR: Record<Tone, string> = {
  normal: "bg-foreground/60",
  warn: "bg-amber-500",
  danger: "bg-red-500",
};

/**
 * Asks the Gasho server to have the working server read its plan usage again when what is known is too old: while the
 * page is on screen, and sooner while the details are open.
 */
function useUsageReads(machine: MachineInfo, open: boolean): void {
  const visible = usePageVisible();
  const tick = useNow(ASK_EVERY_MS);
  const can = machine.connected && machine.canReadUsage === true;
  useEffect(() => {
    if (can && visible) sendToHub({ type: "usage.get", machine: machine.id, maxAgeMs: open ? DETAILS_MAX_AGE_MS : FOOTER_MAX_AGE_MS });
  }, [can, visible, open, tick, machine.id]);
}

export function SessionFooter({ machine, session }: { machine: MachineInfo; session: SessionInfo }) {
  const { connected, me, memory, usage } = useAppState();
  const phone = !useMediaQuery(DESKTOP);
  const now = useNow(30_000);
  const [open, setOpen] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  useUsageReads(machine, open);

  const known = usage[machine.id];
  const view = limitsView(known?.usage, latestStatusLineLimits(machine));
  const mem = machine.connected ? memory[machine.id] : undefined;
  const context = session.context;
  const rows = footerRows(view).flatMap((row) => {
    const percent = shownPercent(row.window, now);
    return percent === undefined ? [] : [{ row, percent }];
  });
  const toggle = () => setOpen((o) => !o);
  const opener = { open, onToggle: toggle };

  return (
    <Popover.Root open={open} onOpenChange={setOpen} modal={false}>
      <Popover.Anchor asChild>
        <footer
          aria-label="セッションの状態"
          className="@container shrink-0 border-t border-border bg-background text-muted-foreground"
          // The iPhone's home indicator: the footer takes its room, right under the chat box.
          style={{ paddingBottom: "var(--safe-bottom)" }}
        >
          {/* One line: items that do not fit wrap onto a second line, which the height keeps out of sight. */}
          <div
            ref={bar}
            data-testid="session-footer"
            className={cn("flex flex-wrap items-center overflow-hidden px-2 tabular-nums", phone ? "h-9 text-[13px]" : "h-7 text-[11.5px]")}
          >
            {phone ? (
              <>
                <Item>
                  <Opener {...opener} label={`${connected ? "接続中" : "再接続中"}。${memoryWords(machine, mem)}。詳細を開く`}>
                    <Dot connected={connected} />
                    <span>MEM</span>
                    {mem ? <MemoryPercent memory={mem} /> : <span>{machine.connected ? "–" : "オフライン"}</span>}
                  </Opener>
                </Item>
                <PluginSessionFooter machine={machine} session={session} side="left" />
                <PluginSessionFooter machine={machine} session={session} side="right" />
                {context && (
                  <Item>
                    <Opener {...opener} label={`コンテキスト ${clampPercent(context.percent)}% 使用。詳細を開く`}>
                      <Ring percent={clampPercent(context.percent)} />
                      <Percent value={clampPercent(context.percent)} />
                    </Opener>
                  </Item>
                )}
                {rows.map(({ row, percent }) => (
                  <Item key={row.key}>
                    <Opener {...opener} label={`${row.label} ${percent}%。詳細を開く`}>
                      <span>{shortLabel(row, true)}</span>
                      <Percent value={percent} />
                    </Opener>
                  </Item>
                ))}
              </>
            ) : (
              <>
                <Item first>
                  <span className="flex items-center gap-1.5" title={connected ? "Gasho サーバーに接続中" : "Gasho サーバーに再接続しています"}>
                    <Dot connected={connected} />
                    <span className="max-w-48 truncate">
                      {connected ? "接続中" : "再接続中…"}
                      {me?.name && ` · ${me.name}`}
                    </span>
                  </span>
                </Item>
                <Item>
                  <MemoryItem machine={machine} memory={mem} />
                </Item>
                <PluginSessionFooter machine={machine} session={session} side="left" />
                <span className="flex-1" />
                <PluginSessionFooter machine={machine} session={session} side="right" />
                {context && (
                  <Item>
                    <Opener {...opener} label={`コンテキスト ${clampPercent(context.percent)}% 使用。使用量の詳細を開く`}>
                      <Ring percent={clampPercent(context.percent)} />
                      <span>コンテキスト</span>
                      <Percent value={clampPercent(context.percent)} />
                      <span className="hidden @4xl:inline">
                        {shortTokens(context.used)} / {shortTokens(context.size)}
                      </span>
                    </Opener>
                  </Item>
                )}
                {rows.map(({ row, percent }) => (
                  <Item key={row.key}>
                    <Opener {...opener} label={`${row.label} ${percent}%。使用量の詳細を開く`}>
                      <span>{shortLabel(row, false)}</span>
                      <Bar percent={percent} />
                      <Percent value={percent} />
                      {/* Where the line is narrow, the limits keep their shares and leave out when they reset. */}
                      {row.window.resetsAt !== undefined && <span className="hidden @6xl:inline">{shortReset(row.kind, row.window.resetsAt, now)}</span>}
                    </Opener>
                  </Item>
                ))}
              </>
            )}
          </div>
        </footer>
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          side="top"
          align={phone ? "center" : "end"}
          sideOffset={6}
          collisionPadding={12}
          aria-label="使用量"
          className="z-50 outline-none"
          // A press on the footer's items toggles it: let their click close it, rather than close and open it again.
          onInteractOutside={(e) => {
            if (bar.current?.contains(e.target as Node)) e.preventDefault();
          }}
        >
          <div className="w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border bg-surface p-3 text-sm text-foreground shadow-xl">
            <UsageDetails
              machine={machine}
              session={session}
              view={view}
              known={known}
              {...(phone ? { phone: { connected, deviceName: me?.name, memory: mem } } : {})}
            />
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** An item of the line, after a divider unless it is the first. */
function Item({ first, children }: { first?: boolean; children: ReactNode }) {
  return <span className={cn("flex h-full shrink-0 items-center px-1.5", !first && "border-l border-border/70 first:border-l-0")}>{children}</span>;
}

/** An item that opens the details. */
function Opener({ open, onToggle, label, children }: { open: boolean; onToggle: () => void; label: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      className={cn(
        "-mx-1 inline-flex h-[calc(100%-6px)] cursor-pointer items-center gap-1.5 rounded px-1 outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        open && "text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function Dot({ connected }: { connected: boolean }) {
  return <span aria-hidden className={cn("size-2 shrink-0 rounded-full", connected ? "bg-emerald-500" : "bg-red-500")} />;
}

/** A share in the tone of its level. */
function Percent({ value }: { value: number }) {
  return <span className={cn("font-medium", TONE_TEXT[toneOf(value)])}>{value}%</span>;
}

/** A small bar of a share, in the tone of its level. */
function Bar({ percent }: { percent: number }) {
  return (
    <span aria-hidden className="h-1 w-8 overflow-hidden rounded-full bg-foreground/10">
      <span className={cn("block h-full rounded-full", TONE_BAR[toneOf(percent)])} style={{ width: `${percent}%` }} />
    </span>
  );
}

/** The share of the context window in use, as a ring (the usage plugin's). */
function Ring({ percent }: { percent: number }) {
  const size = 12;
  const stroke = 2;
  const r = (size - stroke) / 2;
  const round = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className={cn("shrink-0 -rotate-90", TONE_TEXT[toneOf(percent)])}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.25} strokeWidth={stroke} />
      {percent > 0 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={round}
          strokeDashoffset={round * (1 - percent / 100)}
        />
      )}
    </svg>
  );
}

/** "ubuntu のメモリ 62%（注意）、9.9 / 16.0 GB", for a screen reader. */
function memoryWords(machine: MachineInfo, memory: MachineMemory | undefined): string {
  if (!memory) return `${machine.name} のメモリ ${machine.connected ? "不明" : "オフライン"}`;
  const percent = memoryPercent(memory);
  const word = MEMORY_LEVELS[memoryLevel(percent)].word;
  return `${machine.name} のメモリ ${percent}%${word ? `（${word}）` : ""}、${memoryAmount(memory)}`;
}

/** The memory's share in the color of its level, as the home screen's tile shows it. */
function MemoryPercent({ memory }: { memory: MachineMemory }) {
  const percent = memoryPercent(memory);
  return <span className={cn("font-medium", MEMORY_LEVELS[memoryLevel(percent)].text)}>{percent}%</span>;
}

/**
 * The working server's memory as the home screen's tile shows it: the share and the amount, the level by color. An
 * offline server shows no old value, and one whose gasho-daemon does not tell its memory says so.
 */
function MemoryItem({ machine, memory }: { machine: MachineInfo; memory: MachineMemory | undefined }) {
  if (!memory) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="max-w-40 truncate">{machine.name} メモリ</span>
        <span>{machine.connected ? "未対応" : "オフライン"}</span>
      </span>
    );
  }
  const percent = memoryPercent(memory);
  const level = MEMORY_LEVELS[memoryLevel(percent)];
  return (
    <span
      role="meter"
      aria-label={`${machine.name} のメモリ使用率`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%${level.word ? `（${level.word}）` : ""}、${memoryAmount(memory)}`}
      className="flex items-center gap-1.5"
    >
      <span className="max-w-40 truncate">{machine.name} メモリ</span>
      <span aria-hidden className="h-1 w-8 overflow-hidden rounded-full bg-foreground/10">
        <span className="block h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: level.color }} />
      </span>
      <MemoryPercent memory={memory} />
      <span className="hidden @5xl:inline">{memoryAmount(memory)}</span>
    </span>
  );
}

/** A share as a bar, read out as its name and percent. */
function Meter({ label, percent, tone }: { label: string; percent: number; tone: Tone }) {
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
      <div className={cn("h-full rounded-full", TONE_BAR[tone])} style={{ width: `${percent}%` }} />
    </div>
  );
}

function Heading({ label, percent, className }: { label: string; percent?: number; className?: string }) {
  return (
    <p className="flex items-baseline justify-between gap-3 text-[13px] font-medium">
      <span className="min-w-0 truncate">{label}</span>
      {percent !== undefined && <span className={cn("shrink-0 tabular-nums", className)}>{percent}%</span>}
    </p>
  );
}

/** One limit: its share, and when it starts again. */
function Limit({ row, now }: { row: LimitRow; now: number }) {
  const percent = shownPercent(row.window, now);
  const resetsAt = row.window.resetsAt;
  return (
    <div className={cn("flex flex-col gap-1", percent === undefined && "opacity-60")}>
      <Heading label={row.label} percent={percent} />
      {percent !== undefined && <Meter label={row.label} percent={percent} tone={toneOf(percent)} />}
      {resetsAt !== undefined && <p className="text-xs text-muted-foreground">{resetLabel(resetsAt, now)}</p>}
    </div>
  );
}

/**
 * The details: the context window and the plan's usage limits, as the usage plugin's popover showed them (and the
 * memory, on a phone, where the footer shows only its share).
 */
export function UsageDetails({
  machine,
  session,
  view,
  known,
  phone,
}: {
  machine: MachineInfo;
  session: SessionInfo;
  view: LimitsView | undefined;
  known: MachineUsage | undefined;
  /** On a phone, what its footer shows only by a dot or a share: the connection, this browser's name and the memory. */
  phone?: { connected: boolean; deviceName?: string; memory?: MachineMemory };
}) {
  const memory = phone?.memory;
  const now = useNow(30_000);
  const data = known?.usage;
  const reading = known?.reading === true;
  const outdated = machine.connected && !machine.canReadUsage;
  const problem = outdated ? "この working server の gasho-daemon は古いため、モデルごとの週の上限を読めません。" : known?.error;
  // get_usage's rows older than the status line's come after them, with when they were read said once.
  const older = view && view.source !== "none" ? view.rows.filter((r) => r.at !== undefined) : [];
  const hasUsage = view !== undefined && view.source !== "none" && (view.source === "usage" || older.length > 0);
  const modelsNote =
    hasUsage || problem
      ? undefined
      : data && !data.available
        ? "この working server の Claude Code のログインでは、モデルごとの週の上限を読めません。"
        : reading
          ? "モデルごとの週の上限を読んでいます…"
          : undefined;
  const note =
    view === undefined
      ? problem
        ? undefined
        : reading
          ? "使用量の上限を読んでいます…"
          : "使用量の上限は、Claude.ai のプランで使っているとき、最初の返答のあとに出ます。"
      : view.source === "none"
        ? "この working server の Claude Code は Claude.ai のプランで使っていないので、使用量の上限はありません。"
        : modelsNote;
  const context = session.context;
  return (
    <div className="flex flex-col gap-3">
      {phone && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Dot connected={phone.connected} />
          {phone.connected ? "接続中" : "再接続中…"}
          {phone.deviceName && ` · ${phone.deviceName}`}
        </p>
      )}
      {memory && (
        <section className="flex flex-col gap-1.5">
          <Heading label={`${machine.name} のメモリ`} percent={memoryPercent(memory)} className={MEMORY_LEVELS[memoryLevel(memoryPercent(memory))].text} />
          <p className="text-xs text-muted-foreground tabular-nums">{memoryAmount(memory)}</p>
        </section>
      )}
      {context && (
        <section className={cn("flex flex-col gap-1.5", memory && "border-t border-border pt-3")}>
          <Heading label="コンテキスト" percent={clampPercent(context.percent)} />
          <Meter label="コンテキストの使用率" percent={clampPercent(context.percent)} tone={toneOf(context.percent)} />
          <p className="text-xs text-muted-foreground tabular-nums">
            {tokens(context.used)} / {tokens(context.size)} トークン
          </p>
          <p className="text-xs text-muted-foreground">最後の返答の時点（{relativeTime(context.at, now)}）</p>
        </section>
      )}
      <section className={cn("flex flex-col gap-2", (context || memory) && "border-t border-border pt-3")}>
        {view && view.source !== "none" && (
          <>
            {view.rows
              .filter((r) => r.at === undefined)
              .map((row) => (
                <Limit key={row.key} row={row} now={now} />
              ))}
            {(older.length === 0 || older.length < view.rows.length) && (
              <p className="text-xs text-muted-foreground">
                {view.source === "usage" ? `Claude.ai から読んだ値（${relativeTime(view.at, now)}）` : `最後の返答の時点（${relativeTime(view.at, now)}）`}
              </p>
            )}
            {older.map((row) => (
              <Limit key={row.key} row={row} now={now} />
            ))}
            {older[0]?.at !== undefined && <p className="text-xs text-muted-foreground">Claude.ai から読んだ値（{relativeTime(older[0].at, now)}）</p>}
          </>
        )}
        {/* What came of a read, which takes up to a minute, is read out by a screen reader. The region stays while empty,
            as only what comes into one already there is read out; -mt-2 then takes back the gap before it. */}
        <div aria-live="polite" className="flex flex-col gap-2 empty:-mt-2">
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
          {problem && (
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs text-amber-600 dark:text-amber-400">
                {problem}
                {view && view.source !== "none" && !hasUsage && !outdated ? " モデルごとの週の上限は出せません。" : ""}
              </p>
              {known?.error && !outdated && machine.connected && (
                <button
                  type="button"
                  disabled={reading}
                  onClick={() => sendToHub({ type: "usage.get", machine: machine.id, maxAgeMs: 0 })}
                  className="h-6 shrink-0 cursor-pointer rounded-md border border-border bg-surface px-2 text-xs font-medium text-foreground outline-none hover:border-border-hover hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
                >
                  読み直す
                </button>
              )}
            </div>
          )}
        </div>
        {!machine.connected && <p className="text-xs text-muted-foreground">working server がオフラインです。最後に受け取った値を出しています。</p>}
      </section>
    </div>
  );
}
