// The logo's easter egg (lib/gassho.ts): the 🙏 comes from the sidebar's logo to the middle of a dimmed screen.
// Pressed and held anywhere (or the space or Enter key held), its two halves, its hands, part to the sides, trembling
// ("ゴゴゴゴゴ") more as they part, and reach the screen's edges after HOLD_TO_EDGE_MS; let go, they come back together
// with a clap (lib/clap.ts), and OPEN_AFTER_CLAP_MS later `href` opens in this tab. A press let go sooner than
// MIN_HOLD_MS only lets the hands go back; × and Esc close the screen without opening anything. With reduced motion,
// the 🙏 fades in instead of flying, and the hands do not tremble.
import {
  animate,
  motion,
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
  useTransform,
  type AnimationPlaybackControls,
  type MotionValue,
} from "framer-motion";
import { X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { playClap, prepareClap } from "@/lib/clap";
import {
  DIM_S,
  FLIGHT_S,
  MIN_HOLD_MS,
  OPEN_AFTER_CLAP_MS,
  SHAKE_MS,
  centreSize,
  clapDuration,
  edgeDistance,
  holdDuration,
  shakeShift,
  shakeTurn,
  type GasshoFrom,
} from "@/lib/gassho";
import { motionTransitions } from "@/lib/motion-tokens";

type Phase = "flying" | "ready" | "holding" | "clapping" | "leaving";
/** What holds the hands apart: a pointer (its id), or the space or Enter key. */
type Holder = number | "key";

/** Each half of the 🙏 shows up to its middle, with nothing cut above, below or outside it. */
const LEFT_HALF = "inset(-50% 50% -50% -50%)";
const RIGHT_HALF = "inset(-50% -50% -50% 50%)";

/** A hand's trembling: how far it is shifted (px) and turned (degrees) from where it is going. */
interface Shake {
  x: MotionValue<number>;
  y: MotionValue<number>;
  rotate: MotionValue<number>;
}

function useShake(): Shake {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const rotate = useMotionValue(0);
  return useMemo(() => ({ x, y, rotate }), [x, y, rotate]);
}

/** Between -1 and 1. */
const either = (): number => Math.random() * 2 - 1;

export function GasshoOverlay({ from, logo, href, onClose }: { from: GasshoFrom; logo: string; href: string; onClose: () => void }) {
  const reduce = useReducedMotion() ?? false;
  const hint = useId();
  const [phase, setPhase] = useState<Phase>("flying");
  // The phase as the handlers see it at once: several events can come before a render (pointerup, lostpointercapture).
  const current = useRef<Phase>("flying");
  const to = useCallback((next: Phase) => {
    current.current = next;
    setPhase(next);
  }, []);
  const [size] = useState(() => centreSize(window.innerWidth, window.innerHeight));
  // The logo's 🙏 seen from the middle of the screen, and its size beside the one there.
  const [start] = useState(() => ({ x: from.x - window.innerWidth / 2, y: from.y - window.innerHeight / 2, scale: from.size / size }));

  const root = useRef<HTMLDivElement>(null);
  /** How far apart the hands are: 0, together; 1, at the screen's edges. */
  const spread = useMotionValue(0);
  const edge = useRef(0);
  const left = useShake();
  const right = useShake();
  const leftX = useTransform([spread, left.x], ([s, shift]: number[]) => -s * edge.current + shift);
  const rightX = useTransform([spread, right.x], ([s, shift]: number[]) => s * edge.current + shift);
  // Together, the 🙏 is drawn whole, with no seam down its middle; apart, as its two halves.
  const whole = useTransform(spread, (s) => (s > 0 ? 0 : 1));
  const halves = useTransform(spread, (s) => (s > 0 ? 1 : 0));
  const moving = useRef<AnimationPlaybackControls | undefined>(undefined);
  const holder = useRef<Holder | null>(null);
  const pressedAt = useRef(0);
  const opening = useRef<number | undefined>(undefined);

  /** The hands stop trembling. */
  const still = useCallback(() => {
    for (const hand of [left, right]) {
      hand.x.set(0);
      hand.y.set(0);
      hand.rotate.set(0);
    }
  }, [left, right]);

  const press = useCallback(
    (by: Holder): boolean => {
      if (current.current !== "ready") return false;
      prepareClap();
      holder.current = by;
      pressedAt.current = performance.now();
      moving.current?.stop();
      moving.current = animate(spread, 1, { duration: holdDuration(spread.get()), ease: "linear" });
      to("holding");
      return true;
    },
    [spread, to]
  );

  const release = useCallback(
    (cancelled: boolean) => {
      if (current.current !== "holding") return;
      holder.current = null;
      moving.current?.stop();
      still();
      if (cancelled || performance.now() - pressedAt.current < MIN_HOLD_MS) {
        // A tap, or a press taken away (a call, another window): the hands only go back.
        moving.current = animate(spread, 0, motionTransitions.springGentle);
        to("ready");
        return;
      }
      prepareClap();
      to("clapping");
      moving.current = animate(spread, 0, {
        duration: clapDuration(spread.get()),
        ease: "easeIn",
        onComplete: () => {
          playClap();
          opening.current = window.setTimeout(() => window.location.assign(href), OPEN_AFTER_CLAP_MS);
        },
      });
    },
    [href, spread, still, to]
  );

  const close = useCallback(() => {
    if (current.current === "leaving") return;
    holder.current = null;
    moving.current?.stop();
    still();
    window.clearTimeout(opening.current);
    to("leaving");
  }, [still, to]);

  // While held, each hand trembles ("ゴゴゴゴゴ"): a new shift and turn every SHAKE_MS, larger as they part.
  const shookAt = useRef(0);
  useAnimationFrame((time) => {
    if (reduce || current.current !== "holding" || time - shookAt.current < SHAKE_MS) return;
    shookAt.current = time;
    const shift = shakeShift(spread.get(), size);
    const turn = shakeTurn(spread.get());
    for (const hand of [left, right]) {
      hand.x.set(shift * either());
      hand.y.set(shift * either());
      hand.rotate.set(turn * either());
    }
  });

  useLayoutEffect(() => {
    const measure = () => {
      edge.current = edgeDistance(window.innerWidth, size);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [size]);

  useEffect(() => {
    root.current?.focus({ preventScroll: true });
    return () => {
      moving.current?.stop();
      window.clearTimeout(opening.current);
    };
  }, []);

  // Another window or app taken to while pressing: no release comes, so the press is taken away.
  useEffect(() => {
    const onBlur = () => release(true);
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [release]);

  // Back from the site to this page as it was left (the back-forward cache): the screen is closed.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) onClose();
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, [onClose]);

  return createPortal(
    <motion.div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label="合掌"
      aria-describedby={hint}
      tabIndex={-1}
      initial={false}
      animate={{ opacity: phase === "leaving" ? 0 : 1 }}
      transition={{ duration: 0.2 }}
      onAnimationComplete={() => {
        if (current.current === "leaving") onClose();
      }}
      onPointerDown={(e) => {
        // A mouse's left button, or one finger at a time.
        if (e.button !== 0 || holder.current !== null) return;
        if (press(e.pointerId)) e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerUp={(e) => {
        if (e.pointerId === holder.current) release(false);
      }}
      onPointerCancel={(e) => {
        if (e.pointerId === holder.current) release(true);
      }}
      onLostPointerCapture={(e) => {
        if (e.pointerId === holder.current) release(true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          // Only this screen: a phone's drawer under it stays open.
          e.stopPropagation();
          close();
        } else if ((e.key === " " || e.key === "Enter") && e.target === e.currentTarget) {
          e.preventDefault();
          if (!e.repeat && holder.current === null) press("key");
        }
      }}
      onKeyUp={(e) => {
        if ((e.key === " " || e.key === "Enter") && holder.current === "key") release(false);
      }}
      // A long press opens no menu, selects nothing, and shows no callout.
      onContextMenu={(e) => e.preventDefault()}
      className="fixed inset-0 z-[120] select-none outline-none"
      style={{ touchAction: "none", WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
    >
      <motion.div
        aria-hidden
        className="absolute inset-0 bg-black/60"
        initial={{ opacity: 0 }}
        animate={{ opacity: phase === "flying" ? 0 : 1 }}
        transition={{ duration: DIM_S }}
      />
      <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
        {/* Drawn at its size in the middle and scaled down to the logo's at first, so that it is not blurred there. */}
        <motion.div
          initial={reduce ? { opacity: 0 } : { x: start.x, y: start.y, scale: start.scale }}
          animate={reduce ? { opacity: 1 } : { x: 0, y: 0, scale: 1 }}
          transition={reduce ? { duration: DIM_S } : { duration: FLIGHT_S, ease: [0.65, 0, 0.35, 1] }}
          onAnimationComplete={() => {
            if (current.current === "flying") to("ready");
          }}
          className="relative font-emoji leading-none"
          style={{ fontSize: size }}
        >
          <motion.span className="block" style={{ opacity: whole }}>
            {logo}
          </motion.span>
          <motion.span
            className="absolute inset-0"
            style={{ x: leftX, y: left.y, rotate: left.rotate, opacity: halves, clipPath: LEFT_HALF }}
          >
            {logo}
          </motion.span>
          <motion.span
            className="absolute inset-0"
            style={{ x: rightX, y: right.y, rotate: right.rotate, opacity: halves, clipPath: RIGHT_HALF }}
          >
            {logo}
          </motion.span>
        </motion.div>
      </div>
      <p id={hint} className="sr-only">
        長押しして離すと、拍手をして Gasho のサイトへ移ります。Esc で閉じます。
      </p>
      <motion.button
        type="button"
        aria-label="閉じる"
        initial={{ opacity: 0 }}
        animate={{ opacity: phase === "flying" ? 0 : 1 }}
        transition={{ duration: DIM_S }}
        // Not a press of the screen.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={close}
        className="absolute grid size-10 place-items-center rounded-full text-white/70 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/50"
        style={{ top: "max(0.75rem, env(safe-area-inset-top))", right: "max(0.75rem, env(safe-area-inset-right))" }}
      >
        <X className="size-5" />
      </motion.button>
    </motion.div>,
    document.body
  );
}
