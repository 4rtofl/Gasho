// Which agent runs a session: a small mark beside its name.
import type { AgentKind } from "@gasho/protocol";
import { AGENT_NAME } from "@/lib/agents";
import { cn } from "@/lib/utils";

const MARK: Record<AgentKind, string> = { claude: "CC", codex: "Cx" };

export function AgentMark({ agent, className }: { agent: AgentKind; className?: string }) {
  return (
    <span
      role="img"
      aria-label={AGENT_NAME[agent]}
      title={AGENT_NAME[agent]}
      className={cn(
        "inline-grid h-4 shrink-0 place-items-center rounded border px-1 font-mono text-[10px] leading-none",
        agent === "codex" ? "border-sky-500/40 text-sky-400" : "border-amber-500/40 text-amber-400",
        className,
      )}
    >
      {MARK[agent]}
    </span>
  );
}
