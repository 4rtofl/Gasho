// What the footer of a session's screen shows of the context window and the Claude.ai plan's usage limits, worked out
// apart from React so that it can be tested: the tone of a share, which limits to show (those gasho-daemon read with
// get_usage, those the status line reported, or both), and how numbers and times are written. Taken over from the
// usage plugin of GashoPlugins (4rtofl/Gasho#298).
import type { MachineInfo, PlanLimits, PlanUsage, PlanUsageWindow } from "@gasho/protocol";

/** How a share looks: as the text around it, then amber from 70%, then red from 90%. */
export type Tone = "normal" | "warn" | "danger";

export function toneOf(percent: number): Tone {
  return percent >= 90 ? "danger" : percent >= 70 ? "warn" : "normal";
}

/** A share as a whole number from 0 to 100, cut as /usage cuts it (99.7% is 99%), so that 100% means used up. */
export function clampPercent(p: number): number {
  return Math.min(100, Math.max(0, Math.floor(p)));
}

/** "45,615" */
export function tokens(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "72.4k", "200k", "1M": tokens in the footer's few characters. */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1000) return `${trim(n / 1000)}k`;
  return String(Math.round(n));
}

const trim = (v: number) => (v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, ""));

/**
 * The freshest usage limits that a session of the working server reported through its status line. They are the
 * account's, and the sessions of one working server use the same login; each knows them as of its latest reply.
 */
export function latestStatusLineLimits(machine: Pick<MachineInfo, "sessions">): PlanLimits | undefined {
  let best: PlanLimits | undefined;
  for (const s of machine.sessions) if (s.limits && (!best || s.limits.at > best.at)) best = s.limits;
  return best;
}

/** Which limit a row is: the footer names them shorter than the popover. */
export type LimitKind = "five-hour" | "seven-day" | "seven-day-sonnet" | "model";

/** One limit. */
export interface LimitRow {
  key: string;
  kind: LimitKind;
  /** The popover's name of it ("週の上限（Fable）"). */
  label: string;
  /** The model's name, for a model's weekly limit. */
  model?: string;
  window: PlanUsageWindow;
  /** When get_usage read it, for a row older than the rest (`LimitsView.at`). */
  at?: number;
}

/**
 * The limits to show, as of `at`: read with get_usage (`usage`), or reported through the status line (`statusline`),
 * whichever is newer. The status line has no limits of single models: those get_usage read before stay, with the time
 * they were read. "none": no Claude.ai plan, so no limits.
 */
export type LimitsView = { source: "usage" | "statusline"; at: number; rows: LimitRow[] } | { source: "none" };

export function limitsView(read: PlanUsage | undefined, reported: PlanLimits | undefined): LimitsView | undefined {
  // Not available to get_usage: no plan, or a login whose token may not read the usage (setup-token), whose replies
  // still bring the limits to the status line.
  const usage = read?.available ? read : undefined;
  if (!usage && !reported) return read ? { source: "none" } : undefined;
  const line = usage && (!reported || usage.at >= reported.at) ? undefined : reported;
  // get_usage's rows are older than the rest while the status line is newer.
  const older = line ? usage?.at : undefined;
  const rows: LimitRow[] = [];
  const add = (row: Omit<LimitRow, "window" | "at">, w: PlanUsageWindow | undefined, fromUsage: boolean) => {
    if (w) rows.push({ ...row, window: w, ...(fromUsage && older !== undefined ? { at: older } : {}) });
  };
  add({ key: "five-hour", kind: "five-hour", label: "5時間の上限" }, line?.fiveHour ?? usage?.fiveHour, !line?.fiveHour);
  add({ key: "seven-day", kind: "seven-day", label: "週の上限（すべてのモデル）" }, line?.sevenDay ?? usage?.sevenDay, !line?.sevenDay);
  add({ key: "seven-day-sonnet", kind: "seven-day-sonnet", label: "週の上限（Sonnet）" }, usage?.sevenDaySonnet, true);
  for (const m of usage?.models ?? []) {
    add({ key: `model:${m.name}`, kind: "model", label: `週の上限（${m.name}）`, model: m.name }, { percent: m.percent, ...(m.resetsAt !== undefined ? { resetsAt: m.resetsAt } : {}) }, true);
  }
  return line ? { source: "statusline", at: line.at, rows } : { source: "usage", at: (usage as PlanUsage).at, rows };
}

/** The share of a limit to show: none once it has been reset, when the share read before no longer holds. */
export function shownPercent(w: PlanUsageWindow, now: number): number | undefined {
  return w.resetsAt !== undefined && w.resetsAt <= now ? undefined : clampPercent(w.percent);
}

const WEEKDAYS = "日月火水木金土";

/** A reset time to the nearest minute: Claude.ai gives one limit 13:59:59.7 and the next 14:00:00, which are the same. */
const toMinute = (ms: number) => new Date(Math.round(ms / 60_000) * 60_000);

/**
 * When a limit starts again, in the browser's time zone: "17:00 にリセット" today, "11月18日（水）17:00 にリセット" after.
 */
export function resetLabel(resetsAt: number, now: number): string {
  if (resetsAt <= now) return "リセット済み";
  const d = toMinute(resetsAt);
  const time = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === new Date(now).toDateString()) return `${time} にリセット`;
  return `${d.getMonth() + 1}月${d.getDate()}日（${WEEKDAYS[d.getDay()]}）${time} にリセット`;
}

/**
 * The footer's short word on a reset: how long until it for the 5-hour limit ("2:00 後"), the day of it for a weekly
 * one ("11/29 まで"; the time when it is today).
 */
export function shortReset(kind: LimitKind, resetsAt: number, now: number): string {
  if (kind === "five-hour") {
    const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
    return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} 後`;
  }
  const d = toMinute(resetsAt);
  if (d.toDateString() === new Date(now).toDateString()) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")} まで`;
  return `${d.getMonth() + 1}/${d.getDate()} まで`;
}

/** The footer's name of a limit: "5時間", "週", "Fable 週" (and "5h", "週", "Fable" on a phone). */
export function shortLabel(row: Pick<LimitRow, "kind" | "model">, phone: boolean): string {
  switch (row.kind) {
    case "five-hour":
      return phone ? "5h" : "5時間";
    case "seven-day":
      return "週";
    case "seven-day-sonnet":
      return phone ? "Sonnet" : "Sonnet 週";
    case "model":
      return phone ? (row.model ?? "") : `${row.model ?? ""} 週`;
  }
}

/** The limits the footer shows: the 5-hour one (where the plan has it), the weekly one, and those of single models. */
export function footerRows(view: LimitsView | undefined): LimitRow[] {
  if (!view || view.source === "none") return [];
  return view.rows.filter((r) => r.kind !== "seven-day-sonnet");
}
