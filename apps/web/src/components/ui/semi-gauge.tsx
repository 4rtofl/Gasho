// EasyUI's Donut Chart (easyui.site/components/donut-chart), its half-ring gauge, with the keys of Torque Dial
// (easyui.site/components/torque-dial), changed for Gasho: a picker of one of a few steps, lowest on the left. Each
// step is one arc, filled up to the one picked, with its name outside the ring as a radio; the centre names the one
// picked, and what it does is said under the ring. Nothing picked leaves the ring empty. No legend, no totals, no intro
// animation.
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface GaugeStep<T extends string> {
  id: T;
  name: string;
  description: string;
}

// The drawing's own units; it scales to the width it is given (up to W px).
const W = 320;
const H = 150;
const R = 100;
const THICKNESS = 14;
const CENTRE = { x: W / 2, y: 138 };
/** How far outside the ring the names are. */
const LABEL_R = R + 28;
const FADE = { duration: 0.16, ease: [0.16, 1, 0.3, 1] } as const;
/** Between two arcs: a gap, and the round caps. */
const PAD = 3.5 / R + THICKNESS / 2 / R;

const pt = (r: number, a: number) => ({ x: CENTRE.x + r * Math.sin(a), y: CENTRE.y - r * Math.cos(a) });
function arcPath(a0: number, a1: number): string {
  const p0 = pt(R, a0);
  const p1 = pt(R, a1);
  return `M${p0.x.toFixed(2)} ${p0.y.toFixed(2)}A${R} ${R} 0 0 1 ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`;
}

export function SemiGauge<T extends string>({
  steps,
  value,
  onChange,
  label,
  empty,
  children,
}: {
  steps: readonly GaugeStep<T>[];
  /** The step picked; undefined for none. */
  value: T | undefined;
  onChange: (id: T) => void;
  /** The radio group's name. */
  label: string;
  /** What the centre says with no step picked. */
  empty: { name: string; description: string };
  /** Other radios of the group, under the gauge. */
  children?: ReactNode;
}) {
  const still = useReducedMotion() ?? false;
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const at = steps.findIndex((s) => s.id === value);
  const shown = steps[at] ?? empty;
  const span = Math.PI / steps.length;

  // As Torque Dial: ←/↓ one step lower, →/↑ one higher, Home and End the ends.
  const step = (e: KeyboardEvent, from: number) => {
    const to = { ArrowLeft: from - 1, ArrowDown: from - 1, ArrowRight: from + 1, ArrowUp: from + 1, Home: 0, End: steps.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = steps[Math.min(steps.length - 1, Math.max(0, to))];
    if (!next) return;
    if (next.id !== value) onChange(next.id);
    buttons.current[steps.indexOf(next)]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={label} className="flex flex-col items-center gap-3">
      <div className="relative w-full" style={{ maxWidth: W, aspectRatio: `${W} / ${H}` }}>
        <svg viewBox={`0 0 ${W} ${H}`} aria-hidden className="absolute inset-0 size-full overflow-visible">
          {steps.map((s, i) => {
            const d = arcPath(-Math.PI / 2 + i * span + PAD, -Math.PI / 2 + (i + 1) * span - PAD);
            return (
              <g key={s.id} className="group cursor-pointer" onClick={() => s.id !== value && onChange(s.id)}>
                <path
                  d={d}
                  fill="none"
                  strokeLinecap="round"
                  style={{ strokeWidth: i === at ? THICKNESS + 4 : THICKNESS }}
                  className={cn(
                    "transition-[stroke,stroke-width] duration-200 motion-reduce:transition-none",
                    i <= at ? "stroke-primary" : "stroke-white/[0.07] [@media(hover:hover)]:group-hover:stroke-white/[0.16]",
                  )}
                />
                {/* A wider band to click than the arc drawn. */}
                <path d={d} fill="none" stroke="transparent" strokeWidth={32} pointerEvents="stroke" />
              </g>
            );
          })}
        </svg>

        {steps.map((s, i) => {
          const p = pt(LABEL_R, -Math.PI / 2 + (i + 0.5) * span);
          return (
            <button
              key={s.id}
              ref={(el) => {
                buttons.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={i === at}
              aria-description={s.description}
              onClick={() => s.id !== value && onChange(s.id)}
              onKeyDown={(e) => step(e, i)}
              style={{ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` }}
              className={cn(
                "absolute -translate-x-1/2 -translate-y-1/2 rounded-md px-1.5 py-0.5 text-xs whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                i === at ? "font-medium text-foreground" : "text-muted-foreground [@media(hover:hover)]:hover:text-foreground",
              )}
            >
              {s.name}
            </button>
          );
        })}

        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center">
          <AnimatePresence mode="wait" initial={false}>
            <motion.p
              key={value ?? ""}
              initial={{ opacity: 0, y: still ? 0 : 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: still ? 0 : -4 }}
              transition={FADE}
              className="text-2xl leading-none font-semibold tracking-[-0.03em] text-foreground"
            >
              {shown.name}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.p
          key={value ?? ""}
          aria-hidden
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={FADE}
          className="-mt-1 text-center text-xs text-muted-foreground"
        >
          {shown.description}
        </motion.p>
      </AnimatePresence>
      {children}
    </div>
  );
}
