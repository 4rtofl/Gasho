import { PanelTopClose, PanelTopOpen } from "lucide-react";
import { MorphingIcon } from "@/components/ui/morphing-icon";
import { toggleSessionHeader, useSessionHeaderShown } from "@/lib/session-header";
import { cn } from "@/lib/utils";

/**
 * Shows or hides the session screen's header. On phones it sits in the top bar, on wider screens at the right end of
 * the session's tabs (see session-tabs).
 */
export function SessionHeaderToggle({ className }: { className?: string }) {
  const shown = useSessionHeaderShown();
  const label = shown ? "ヘッダーを隠す" : "ヘッダーを表示";
  return (
    <button
      type="button"
      onClick={toggleSessionHeader}
      aria-pressed={shown}
      aria-label={label}
      title={label}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground",
        className,
      )}
    >
      <MorphingIcon from={<PanelTopClose className="size-4" />} to={<PanelTopOpen className="size-4" />} active={!shown} />
    </button>
  );
}
