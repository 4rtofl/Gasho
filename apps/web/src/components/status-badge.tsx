import { motion, useReducedMotion } from "framer-motion";
import { Bell } from "lucide-react";
import type { SessionStatus } from "@gasho/protocol";
import { Badge } from "@/components/ui/badge";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/format";
import type { DotStatus } from "@/lib/sessions";
import { cn } from "@/lib/utils";

/**
 * A session's state. Working and idle show the dot alone, told apart by its color and by its ping while the session
 * works; their words are left to screen readers and the tooltip. Waiting for an answer, and a state Gasho cannot
 * tell, keep their words.
 */
export function StatusBadge({ status }: { status: SessionStatus }) {
  if (status === "busy" || status === "idle") {
    return (
      // As tall as the badge, so what is beside it does not move when the state changes.
      <span role="img" aria-label={STATUS_LABEL[status]} title={STATUS_LABEL[status]} className="inline-flex h-6 shrink-0 items-center">
        <StatusDot status={status} />
      </span>
    );
  }
  return (
    <Badge tone={STATUS_TONE[status]} dot pulse={status === "waiting"}>
      {STATUS_LABEL[status]}
    </Badge>
  );
}

// Yellow while Claude is at its turn (working, or waiting for an answer), green once it is done, gray without a session.
const DOT: Record<DotStatus, string> = {
  busy: "bg-amber-500",
  waiting: "bg-amber-500",
  idle: "bg-emerald-500",
  none: "bg-neutral-500",
  unknown: "bg-neutral-700",
};

const UNREAD = "読んでいない通知があります";
const SHAKE = { rotate: [0, -12, 10, -8, 6, -2, 0] };

/**
 * Small status dot, for the sidebar and for the states that show no words. `unread`: a bell in its place, which shakes
 * as it comes: a response or a question has not been seen yet (the bell of EasyUI's Notification Bell,
 * easyui.site/components/notification-bell, without its button and its list).
 */
export function StatusDot({ status, unread = false }: { status: DotStatus; unread?: boolean }) {
  const reduceMotion = useReducedMotion();
  if (unread) {
    return (
      // As big as the dot, the bell a little bigger over it, so that what is beside it does not move.
      <span role="img" aria-label={UNREAD} title={UNREAD} className="relative inline-flex size-2.5">
        <motion.span
          className="absolute -inset-0.5 flex text-amber-500"
          animate={reduceMotion ? undefined : SHAKE}
          transition={{ duration: 0.5, ease: "easeInOut" }}
        >
          <Bell className="size-3.5" strokeWidth={2.5} />
        </motion.span>
      </span>
    );
  }
  return (
    <span className="relative inline-flex size-2.5">
      {(status === "busy" || status === "waiting") && (
        <span className={cn("absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:animate-none", DOT[status])} />
      )}
      <span className={cn("relative inline-flex size-2.5 rounded-full", DOT[status])} />
    </span>
  );
}
