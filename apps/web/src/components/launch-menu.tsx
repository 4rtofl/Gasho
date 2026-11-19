// The menu of a "＋" that starts a session at once: a right-click (a long press on a touch screen) picks the agent for this
// session, and leaves the default agent as it is. Where Codex is not offered, the "＋" has no menu.
import type { AgentKind, MachineInfo } from "@gasho/protocol";
import { ContextMenu } from "radix-ui";
import type { ReactElement } from "react";
import { MENU, MENU_ITEM } from "@/components/dialog-styles";
import { AGENT_NAME, codexOffered, codexProblem } from "@/lib/agents";

export function LaunchMenu({ machine, onPick, children }: { machine: MachineInfo; onPick: (agent: AgentKind) => void; children: ReactElement }) {
  if (!codexOffered(machine)) return children;
  const problem = codexProblem(machine);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content collisionPadding={8} className={MENU}>
          <ContextMenu.Label className="px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground">エージェントを選んで起動</ContextMenu.Label>
          <ContextMenu.Item onSelect={() => onPick("claude")} className={MENU_ITEM}>
            {AGENT_NAME.claude}
          </ContextMenu.Item>
          <ContextMenu.Item disabled={problem !== undefined} onSelect={() => onPick("codex")} className={MENU_ITEM}>
            {AGENT_NAME.codex}
          </ContextMenu.Item>
          {problem && <p className="max-w-60 px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">{problem}</p>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
