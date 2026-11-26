// EasyUI's Morphing Icon (easyui.site/components/morphing-icon): two icons in one place, the one shown turning into the
// other. Changed for Gasho: spans, to sit inside a button; the size of its small icons (16 px) and one fixed timing;
// both icons hidden from screen readers (the button that holds them names what it does); with reduced motion, they
// swap at once.
import { motion, useReducedMotion } from "framer-motion";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const TRANSITION = { duration: 0.3, ease: [0.4, 0, 0.2, 1] } as const;

/** Shows `from`, or `to` while `active`. */
export function MorphingIcon({ from, to, active, className }: { from: ReactNode; to: ReactNode; active: boolean; className?: string }) {
  const transition = useReducedMotion() ? { duration: 0 } : TRANSITION;
  return (
    <span aria-hidden className={cn("relative inline-flex size-4 shrink-0", className)}>
      <motion.span
        className="absolute inset-0 grid place-items-center"
        initial={false}
        animate={active ? { opacity: 0, scale: 0.65, rotate: -90 } : { opacity: 1, scale: 1, rotate: 0 }}
        transition={transition}
      >
        {from}
      </motion.span>
      <motion.span
        className="absolute inset-0 grid place-items-center"
        initial={false}
        animate={active ? { opacity: 1, scale: 1, rotate: 0 } : { opacity: 0, scale: 0.65, rotate: 90 }}
        transition={transition}
      >
        {to}
      </motion.span>
    </span>
  );
}
