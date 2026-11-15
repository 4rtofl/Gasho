// EasyUI's Morphing Button (easyui.site/components/morphing-button): a button whose label changes in place to say how
// its action went. Changed for Gasho: only the bordered look (the secondary variant), in Gasho's colors and the size of
// its other small buttons; no loading state (its action ends at once); the labels and icons are the caller's.
import { AnimatePresence, motion } from "framer-motion";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { motionTransitions } from "@/lib/motion-tokens";
import { cn } from "@/lib/utils";

export type MorphingButtonStatus = "idle" | "success" | "error";

export interface MorphingButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onAnimationStart" | "onDrag" | "onDragEnd" | "onDragStart" | "style" | "children"> {
  status?: MorphingButtonStatus;
  idleText: string;
  successText: string;
  errorText: string;
  idleIcon?: ReactNode;
  successIcon?: ReactNode;
  errorIcon?: ReactNode;
}

export function MorphingButton({
  status = "idle",
  idleText,
  successText,
  errorText,
  idleIcon,
  successIcon,
  errorIcon,
  disabled = false,
  className,
  type = "button",
  ...props
}: MorphingButtonProps) {
  const label =
    status === "success"
      ? { icon: successIcon, text: successText, className: "text-emerald-500" }
      : status === "error"
        ? { icon: errorIcon, text: errorText, className: "text-red-400" }
        : { icon: idleIcon, text: idleText, className: "" };
  return (
    <motion.button
      type={type}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      transition={motionTransitions.springSnappy}
      disabled={disabled}
      className={cn(
        "relative inline-flex items-center justify-center overflow-hidden rounded-lg border border-border px-2.5 py-1.5 text-xs outline-none transition-colors select-none hover:border-border-hover focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={status}
          initial={status === "idle" ? { opacity: 0, y: -6 } : { opacity: 0, scale: 0.8 }}
          animate={status === "idle" ? { opacity: 1, y: 0 } : { opacity: 1, scale: 1 }}
          exit={status === "idle" ? { opacity: 0, y: 6 } : { opacity: 0, scale: 0.8 }}
          transition={motionTransitions.springSnappy}
          className={cn("flex items-center gap-1.5", label.className)}
          aria-live="polite"
        >
          {label.icon}
          <span>{label.text}</span>
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}
