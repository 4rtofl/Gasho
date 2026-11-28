// The menu of a "＋" that starts a session at once: a right-click (a long press on a touch screen) picks the agent for this
// session, and leaves the default agent as it is. Where Codex is not offered, the "＋" has no menu.
import type { AgentKind, MachineInfo } from "@gasho/protocol";
import { ContextMenu } from "radix-ui";
import type { ReactElement } from "react";
import { MENU, MENU_ITEM } from "@/components/dialog-styles";
import { AGENT_NAME, agentUsable, codexProblem, offeredAgents } from "@/lib/agents";

export function LaunchMenu({ machine, onPick, children }: { machine: MachineInfo; onPick: (agent: AgentKind) => void; children: ReactElement }) {
  const agents = offeredAgents(machine);
  if (!agents.length) return children;
  const problem = agents.includes("codex") ? codexProblem(machine) : undefined;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content collisionPadding={8} className={MENU}>
          <ContextMenu.Label className="px-2.5 pt-1 pb-1.5 text-xs text-muted-foreground">エージェントを選んで起動</ContextMenu.Label>
          <ContextMenu.Item disabled={!agentUsable(machine, "claude")} onSelect={() => onPick("claude")} className={MENU_ITEM}>
            {AGENT_NAME.claude}
          </ContextMenu.Item>
          {agents.map((agent) => (
            <ContextMenu.Item key={agent} disabled={!agentUsable(machine, agent)} onSelect={() => onPick(agent)} className={MENU_ITEM}>
              {AGENT_NAME[agent]}
            </ContextMenu.Item>
          ))}
          {problem && <p className="max-w-60 px-2.5 pt-1.5 pb-1 text-xs text-muted-foreground">{problem}</p>}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
