// EasyUI's UnfoldAccordion (easyui.site/components/unfold-accordion): one of its items, as a section of its own, and
// changed for Gasho: whether it is open is given (`open`, `onOpenChange`), so that each section of the settings screen
// keeps its own; the heading has an icon, a description, and buttons beside it (`actions`) that show folded too, with
// what they need said under the heading (`notes`); the
// chevron is a ChevronRight before the title, turned 90° as Gasho's other folds; the button names what it opens
// (`aria-controls`, as EasyUI's FAQ); `instant` opens it without the motion; the content, drawn from the first time it
// opens, is kept and hidden when it folds, so that what is typed in it and not saved yet stays; the colors are Gasho's.
import { motion, useReducedMotion } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { motionTransitions } from "@/lib/motion-tokens";
import { cn } from "@/lib/utils";

const NONE = { duration: 0 };
const BODY = { open: { height: "auto", opacity: 1 }, shut: { height: 0, opacity: 0 } };
const INNER = { open: { y: 0, opacity: 1 }, shut: { y: -4, opacity: 0 } };

export function AccordionSection({
  title,
  icon,
  description,
  actions,
  notes,
  open,
  onOpenChange,
  instant = false,
  id,
  className,
  bodyClassName = "space-y-3",
  children,
}: {
  title: ReactNode;
  icon?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Why the buttons beside the heading cannot be used, or what went wrong with them. */
  notes?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens at its full height at once, to be scrolled to. */
  instant?: boolean;
  id?: string;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
}) {
  const uid = useId();
  const titleId = `${uid}-title`;
  const descriptionId = `${uid}-description`;
  const contentId = `${uid}-content`;
  const reduceMotion = useReducedMotion();
  const [openAtFirst] = useState(open);
  const [drawn, setDrawn] = useState(open);
  const [was, setWas] = useState(open);
  // Set in the same render as `open`, so that the content is clipped from the first frame it moves.
  const [moving, setMoving] = useState(false);
  if (open !== was) {
    setWas(open);
    // Drawn for the first time at its full height, it does not move.
    setMoving(!(open && !drawn && instant));
    if (open) setDrawn(true);
  }
  const at = open ? "open" : "shut";
  const initial = instant || openAtFirst ? false : "shut";
  return (
    <section id={id} aria-labelledby={titleId} className={cn("rounded-2xl border border-border bg-surface/40", className)}>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 p-4">
        {/* Wide enough for the title before the buttons beside it go below it. */}
        <h2 className="min-w-0 flex-1 basis-60">
          <button
            type="button"
            onClick={() => onOpenChange(!open)}
            aria-expanded={open}
            aria-controls={drawn ? contentId : undefined}
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            className="group -m-1.5 flex w-[calc(100%+0.75rem)] cursor-pointer items-start gap-2 rounded-lg p-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <motion.span
              initial={false}
              animate={{ rotate: open ? 90 : 0 }}
              transition={reduceMotion ? NONE : motionTransitions.springSnappy}
              className="mt-0.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
            >
              <ChevronRight className="size-4" />
            </motion.span>
            <span className="min-w-0">
              <span id={titleId} className="flex items-center gap-2 text-sm font-medium">
                {icon}
                {title}
              </span>
              {description && (
                <span id={descriptionId} className="mt-0.5 block text-xs text-muted-foreground">
                  {description}
                </span>
              )}
            </span>
          </button>
        </h2>
        {actions}
      </div>
      <div className="-mt-1 space-y-1 px-4 pb-4 empty:hidden">{notes}</div>

      {drawn && (
        <motion.div
          id={contentId}
          variants={BODY}
          initial={initial}
          animate={at}
          transition={reduceMotion ? NONE : motionTransitions.springGentle}
          onAnimationComplete={(done) => {
            if (done === at) setMoving(false);
          }}
          hidden={!open && !moving}
          // Clipped only while it moves, so that the focus ring of what is at its top shows whole.
          className={cn((moving || !open) && "overflow-hidden")}
        >
          <motion.div
            variants={INNER}
            initial={initial}
            animate={at}
            // A little quicker than the height, so the content leads the chevron.
            transition={reduceMotion ? NONE : { duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className={cn("px-4 pb-4 empty:hidden", bodyClassName)}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </section>
  );
}
