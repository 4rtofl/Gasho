// EasyUI's DrawCheckbox (easyui.site/components/draw-checkbox): a box whose checkmark draws itself and settles with a
// small overshoot, changed for Gasho: only the box is drawn, for an item that holds the checked state and its role
// (Radix DropdownMenu.CheckboxItem), so it has no input, label or indeterminate bar. Checked, it takes the primary
// colour (Gasho's --accent is grey). It moves only when it changes (not when a menu opens with it checked), and not
// at all with reduced motion.
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

export function DrawCheckbox({ checked, className }: { checked: boolean; className?: string }) {
  const still = useReducedMotion() ?? false;
  return (
    <motion.span
      aria-hidden
      initial={false}
      animate={{ scale: checked && !still ? [0.9, 1.04, 1] : 1 }}
      transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        checked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface-raised",
        className,
      )}
    >
      <AnimatePresence initial={false}>
        {checked && (
          <motion.svg
            key="check"
            viewBox="0 0 16 16"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={still ? false : { scale: 0.6, opacity: 0 }}
            animate={{ scale: still ? 1 : [0.6, 1.18, 1], opacity: 1 }}
            transition={{ scale: { duration: 0.36, ease: [0.16, 1, 0.3, 1] }, opacity: { duration: 0.12 } }}
          >
            <motion.path
              d="M3.5 8.5 L6.5 11.5 L12.5 5"
              initial={still ? false : { pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.28, ease: [0.65, 0, 0.35, 1] }}
            />
          </motion.svg>
        )}
      </AnimatePresence>
    </motion.span>
  );
}
