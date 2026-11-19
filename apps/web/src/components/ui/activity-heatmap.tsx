// EasyUI's Activity Heatmap (easyui.site/components/activity-heatmap, MIT): a contribution calendar with one cell per
// day, keyboard navigation and a tooltip. Taken with the Tooltip of its chart-primitives, and changed for Gasho: only
// the calendar mode, the texts are Japanese, numbers go through `format`, the levels are a blue ramp for each theme
// (color-mix with transparent could not be told apart on the light surface), and the keyframes are a plain style
// element. Hand-written SVG; measures its own width, and leaves out the oldest weeks when they do not fit.
import { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion, useSpring } from "framer-motion";
import { useDismissOutside, useElementWidth } from "@/components/ui/stat-card";

export interface HeatDay {
  /** YYYY-MM-DD */
  date: string;
  value: number;
}

export interface ActivityHeatmapProps {
  data: HeatDay[];
  /** The last day shown (YYYY-MM-DD). */
  endDate: string;
  /** The most weeks shown; a narrow tile shows fewer. */
  weeks?: number;
  /** What is counted, in the summary and the tooltip ("トークン"). */
  unit: string;
  format?: (n: number) => string;
  /** The smallest cell, in px, before the oldest weeks are left out. */
  minCell?: number;
  animated?: boolean;
  className?: string;
}

const DAY_MS = 86_400_000;
const EASE_OUT = [0.23, 1, 0.32, 1] as const;
const LABEL_WIDTH = 20;
const TOP = 18;
const GAP = 3;
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
const cx = (...a: (string | false | null | undefined)[]) => a.filter(Boolean).join(" ");
const plain = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
const dayText = new Intl.DateTimeFormat("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short", timeZone: "UTC" });

const toDay = (date: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  return m ? Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS) : null;
};
/** 0 is Sunday. */
const weekday = (day: number) => (((day + 4) % 7) + 7) % 7;
const monthOf = (day: number) => new Date(day * DAY_MS).getUTCMonth();

/** The steps of use, on the tiles' white and near-black surfaces: the more use, the further from the surface. */
const LEVEL_FILLS = ["fill-black/[0.05] dark:fill-white/[0.06]", "fill-blue-200 dark:fill-blue-900", "fill-blue-400 dark:fill-blue-700", "fill-blue-600 dark:fill-blue-500", "fill-blue-800 dark:fill-blue-300"];
const LEVEL_SWATCHES = ["bg-black/[0.05] dark:bg-white/[0.06]", "bg-blue-200 dark:bg-blue-900", "bg-blue-400 dark:bg-blue-700", "bg-blue-600 dark:bg-blue-500", "bg-blue-800 dark:bg-blue-300"];

interface HeatCell {
  c: number;
  r: number;
  day: number;
  v: number;
  title: string;
}

function Tooltip({ pos, boundsWidth, children }: { pos: { x: number; y: number } | null; boundsWidth: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const seen = useRef(false);
  const x = useSpring(0, { stiffness: 520, damping: 42, mass: 0.6 });
  const y = useSpring(0, { stiffness: 520, damping: 42, mass: 0.6 });
  useLayoutEffect(() => {
    if (!pos) {
      seen.current = false;
      return;
    }
    const w = ref.current?.offsetWidth ?? 130;
    const h = ref.current?.offsetHeight ?? 60;
    const tx = clamp(pos.x - w / 2, 0, Math.max(0, boundsWidth - w));
    // Above the cell, or below it when the top row has no room.
    const ty = pos.y - h - 12 < 0 ? pos.y + 18 : pos.y - h - 12;
    if (seen.current) {
      x.set(tx);
      y.set(ty);
    } else {
      x.jump(tx);
      y.jump(ty);
      seen.current = true;
    }
  }, [pos, boundsWidth, x, y]);
  return (
    <motion.div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute top-0 left-0 z-20 min-w-[112px] rounded-xl bg-white/95 px-3 py-2 text-[12px] whitespace-nowrap shadow-lg ring-1 ring-black/[0.07] backdrop-blur dark:bg-neutral-900/95 dark:ring-white/[0.07]"
      style={{ x, y }}
      initial={false}
      animate={{ opacity: pos ? 1 : 0 }}
      transition={{ duration: 0.14, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}

export function ActivityHeatmap({ data, endDate, weeks = 53, unit, format = (n) => plain.format(n), minCell = 11, animated = true, className }: ActivityHeatmapProps) {
  const reduce = useReducedMotion();
  const anim = animated && !reduce;
  const [rootRef, width] = useElementWidth<HTMLDivElement>(720);
  const [active, setActive] = useState<{ c: number; r: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismissOutside(wrapRef, active !== null, useCallback(() => setActive(null), []));

  const innerW = Math.max(40, width - LABEL_WIDTH);
  const cols = clamp(Math.min(weeks, Math.floor((innerW + GAP) / (minCell + GAP))), 4, weeks);
  const cell = Math.min((innerW - (cols - 1) * GAP) / cols, 16);

  const model = useMemo(() => {
    const values = new Map<number, number>();
    for (const d of data) {
      const day = toDay(d.date);
      if (day !== null && Number.isFinite(d.value)) values.set(day, (values.get(day) ?? 0) + Math.max(0, d.value));
    }
    const endDay = toDay(endDate) ?? 0;
    const first = endDay - weekday(endDay) - (cols - 1) * 7;
    const cells: HeatCell[] = [];
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < 7; r++) {
        const day = first + c * 7 + r;
        if (day <= endDay) cells.push({ c, r, day, v: values.get(day) ?? 0, title: dayText.format(new Date(day * DAY_MS)) });
      }
    }
    // Quarters of the days with use, so that one very large day does not leave the others all alike.
    const used = cells.filter((x) => x.v > 0).map((x) => x.v).sort((a, b) => a - b);
    const q = (p: number) => used[Math.min(used.length - 1, Math.floor(p * used.length))] ?? 0;
    const [t1, t2, t3] = [q(0.25), q(0.5), q(0.75)];
    const level = (v: number) => (v <= 0 ? 0 : v <= t1 ? 1 : v <= t2 ? 2 : v <= t3 ? 3 : 4);
    const best = cells.reduce<HeatCell | null>((b, x) => (!b || x.v > b.v ? x : b), null);
    return { cells, level, first, best, total: cells.reduce((s, x) => s + x.v, 0) };
  }, [data, endDate, cols]);

  const byKey = useMemo(() => new Map(model.cells.map((x) => [`${x.c}:${x.r}`, x])), [model.cells]);
  const gx = (c: number) => LABEL_WIDTH + c * (cell + GAP);
  const gy = (r: number) => TOP + r * (cell + GAP);
  const svgH = TOP + 7 * cell + 6 * GAP + 2;

  const months = useMemo(() => {
    const out: { c: number; text: string }[] = [];
    let prev = -1;
    let lastC = -9;
    for (let c = 0; c < cols; c++) {
      const m = monthOf(model.first + c * 7);
      if (m === prev) continue;
      // The first column's month only when the next label leaves it room.
      if (prev === -1 ? cols > 6 && monthOf(model.first + 14) === m : c - lastC >= 3 && c <= cols - 2) {
        out.push({ c, text: `${m + 1}月` });
        lastC = c;
      }
      prev = m;
    }
    return out;
  }, [cols, model.first]);

  const locate = (e: PointerEvent<SVGRectElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const c = Math.floor((e.clientX - box.left) / (cell + GAP));
    const r = Math.floor((e.clientY - box.top) / (cell + GAP));
    setActive(byKey.has(`${c}:${r}`) ? { c, r } : null);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") return setActive(null);
    const dc = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const dr = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (!dc && !dr) return;
    e.preventDefault();
    setActive((a) => {
      const from = a ?? { c: cols - 1, r: 0 };
      const next = { c: clamp(from.c + dc, 0, cols - 1), r: clamp(from.r + dr, 0, 6) };
      return byKey.has(`${next.c}:${next.r}`) ? next : from;
    });
  };

  const cur = active ? byKey.get(`${active.c}:${active.r}`) : undefined;
  const span = cols >= 52 ? "過去1年" : cols >= 8 ? `過去 ${Math.round(cols / 4.345)} か月` : `過去 ${cols} 週間`;
  const summary = `${span}で ${format(model.total)} ${unit}`;

  return (
    <div ref={rootRef} className={cx("w-full min-w-0", className)}>
      <style>
        {"@keyframes heat-cell{from{opacity:0;transform:scale(.4)}to{opacity:1;transform:scale(1)}}" +
          ".heat-cell{transform-box:fill-box;transform-origin:center;animation:heat-cell .55s cubic-bezier(.23,1,.32,1) both;animation-delay:var(--d,0s)}" +
          "@media (prefers-reduced-motion: reduce){.heat-cell{animation:none}}"}
      </style>

      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-[13px] font-medium tabular-nums text-neutral-900 dark:text-neutral-100">{summary}</p>
        {model.best && model.best.v > 0 && (
          <p className="text-[12px] text-neutral-500">
            最も多い日 {model.best.title} · <span className="tabular-nums">{format(model.best.v)}</span>
          </p>
        )}
      </div>

      <div ref={wrapRef} className="relative" style={{ height: svgH }}>
        <svg
          width={width}
          height={svgH}
          role="img"
          aria-label={`日ごとの${unit}のヒートマップ。${summary}`}
          tabIndex={0}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          className="block touch-pan-y overflow-visible rounded-md outline-none focus-visible:ring-2 focus-visible:ring-neutral-400/60 dark:focus-visible:ring-white/30"
        >
          {months.map((l) => (
            <text key={l.c} x={gx(l.c)} y={11} className="fill-neutral-500 text-[11px]">
              {l.text}
            </text>
          ))}
          {[
            [1, "月"],
            [3, "水"],
            [5, "金"],
          ].map(([r, text]) => (
            <text key={r} x={0} y={gy(r as number) + cell / 2} dominantBaseline="middle" className="fill-neutral-500 text-[10.5px]">
              {text}
            </text>
          ))}
          {model.cells.map((x) => (
            <rect
              key={x.day}
              x={gx(x.c)}
              y={gy(x.r)}
              width={cell}
              height={cell}
              rx={Math.min(3, cell / 4)}
              data-level={model.level(x.v)}
              className={cx(anim && "heat-cell", LEVEL_FILLS[model.level(x.v)])}
              style={anim ? ({ "--d": `${(x.c * 0.012 + x.r * 0.02).toFixed(3)}s` } as CSSProperties) : undefined}
            />
          ))}
          <motion.rect
            width={cell + 2}
            height={cell + 2}
            rx={Math.min(4, cell / 3)}
            fill="none"
            strokeWidth={1.5}
            className="stroke-neutral-900 dark:stroke-white"
            initial={false}
            animate={{ x: gx(active?.c ?? 0) - 1, y: gy(active?.r ?? 0) - 1, opacity: active ? 1 : 0 }}
            transition={{ duration: reduce ? 0 : 0.12 }}
          />
          <rect
            x={LABEL_WIDTH}
            y={TOP}
            width={cols * (cell + GAP)}
            height={7 * (cell + GAP)}
            fill="transparent"
            onPointerMove={locate}
            onPointerDown={locate}
            onPointerLeave={(e) => e.pointerType === "mouse" && setActive(null)}
          />
        </svg>
        <Tooltip pos={active ? { x: gx(active.c) + cell / 2, y: gy(active.r) } : null} boundsWidth={width}>
          {cur && (
            <>
              <p className="font-medium tabular-nums text-neutral-900 dark:text-neutral-100">
                {format(cur.v)} <span className="font-normal text-neutral-500">{unit}</span>
              </p>
              <p className="mt-0.5 text-neutral-500">{cur.title}</p>
            </>
          )}
        </Tooltip>
      </div>

      <p className="sr-only" role="status" aria-live="polite">
        {cur ? `${cur.title}：${format(cur.v)} ${unit}` : ""}
      </p>

      <div className="mt-3 flex items-center justify-end gap-2 text-[11.5px] text-neutral-500">
        少ない
        <span className="flex gap-[3px]" aria-hidden>
          {LEVEL_SWATCHES.map((c) => (
            <span key={c} className={cx("h-[11px] w-[11px] rounded-[3px]", c)} />
          ))}
        </span>
        多い
      </div>
    </div>
  );
}
