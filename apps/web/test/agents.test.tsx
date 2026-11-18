// Which agent a new session starts with, the menu of a "＋", and what a session of each agent offers.
import { fireEvent, render, renderHook, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentInfo, MachineInfo } from "@gasho/protocol";
import { expect, test, vi } from "vitest";
import { LaunchMenu } from "@/components/launch-menu";
import { useWorktreeLaunch } from "@/components/session-tabs";
import { canDo, codexOffered, codexProblem, launchAgentFor, launchTitle, showsAgents } from "@/lib/agents";
import type { WorktreeSessions } from "@/lib/sessions";
import { DefaultAgentSection } from "@/views/settings";
import { connectHub, machine, session } from "./hub";

const codex = (extra: Partial<AgentInfo> = {}): AgentInfo => ({ status: "available", version: "0.170.0", canLaunch: true, operations: [], ...extra });
const withCodex = (info: AgentInfo = codex()): MachineInfo => machine("m", [], { name: "Linux", canLaunch: true, agents: { codex: info } });
const claudeOnly = machine("m", [], { name: "Linux", canLaunch: true });
const worktree = (m: MachineInfo) => ({ machine: m, path: "/repo", sessions: [] }) as unknown as WorktreeSessions;
const server = (defaultAgent: "claude" | "codex") => ({ version: "0.15.0", update: { canUpdate: false }, defaultAgent });

test("a new session starts with the default agent, and with Claude Code where Codex cannot be used", () => {
  expect(launchAgentFor(withCodex(), "codex")).toBe("codex");
  expect(launchAgentFor(withCodex(), "claude")).toBe("claude");
  expect(launchAgentFor(withCodex(), undefined)).toBe("claude");
  expect(launchAgentFor(withCodex(codex({ status: "loginRequired" })), "codex")).toBe("claude");
  expect(launchAgentFor(claudeOnly, "codex")).toBe("claude");
});

test("gasho-daemon 0.30.0 reports Codex but cannot start it: it is not offered", () => {
  const reports = withCodex({ status: "available", version: "0.170.0" });
  expect(codexOffered(reports)).toBe(false);
  expect(launchAgentFor(reports, "codex")).toBe("claude");
  expect(showsAgents([reports])).toBe(false);
});

test("the marks show once Codex can be used somewhere", () => {
  expect(showsAgents([claudeOnly])).toBe(false);
  expect(showsAgents([withCodex(codex({ status: "loginRequired" }))])).toBe(false);
  expect(showsAgents([claudeOnly, withCodex()])).toBe(true);
});

test("what a session can do follows its agent; a gasho-daemon that does not tell runs Claude Code", () => {
  const m = machine("m", [], { agents: { claude: { status: "available", operations: ["model", "fork"] }, codex: codex() } });
  expect(canDo(m, session("c"), "fork")).toBe(true);
  expect(canDo(m, session("c"), "files")).toBe(false);
  expect(canDo(m, session("x", { agent: "codex" }), "fork")).toBe(false);
  expect(canDo(machine("old"), session("c"), "fork")).toBe(true);
  expect(canDo(machine("old"), session("x", { agent: "codex" }), "fork")).toBe(false);
});

test("the tooltip of a \"＋\" names the agent only where there is a choice", () => {
  expect(launchTitle(claudeOnly, "codex", "起動")).toBe("起動");
  expect(launchTitle(withCodex(), "codex", "起動")).toBe("起動：Codex（右クリックか長押しで、エージェントを選べます）");
  expect(launchTitle(withCodex(), "claude", "起動")).toContain("Claude Code");
});

test("the menu of a \"＋\" picks an agent for this session", async () => {
  const onPick = vi.fn();
  render(
    <LaunchMenu machine={withCodex()} onPick={onPick}>
      <button type="button">＋</button>
    </LaunchMenu>,
  );
  fireEvent.contextMenu(screen.getByRole("button", { name: "＋" }));
  await userEvent.setup().click(await screen.findByRole("menuitem", { name: "Codex" }));
  expect(onPick).toHaveBeenCalledWith("codex");
});

test("before logging in, Codex shows in the menu but cannot be picked, and says why", async () => {
  const m = withCodex(codex({ status: "loginRequired" }));
  render(
    <LaunchMenu machine={m} onPick={() => undefined}>
      <button type="button">＋</button>
    </LaunchMenu>,
  );
  fireEvent.contextMenu(screen.getByRole("button", { name: "＋" }));
  expect((await screen.findByRole("menuitem", { name: "Codex" })).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText(codexProblem(m)!)).toBeTruthy();
});

test("without Codex, a \"＋\" has no menu", () => {
  render(
    <LaunchMenu machine={claudeOnly} onPick={() => undefined}>
      <button type="button">＋</button>
    </LaunchMenu>,
  );
  fireEvent.contextMenu(screen.getByRole("button", { name: "＋" }));
  expect(screen.queryByRole("menuitem")).toBeNull();
});

test("a \"＋\" sends the default agent, and the one picked from its menu instead", async () => {
  const m = withCodex();
  const hub = await connectHub({ machines: [m], server: server("codex") });
  const { result } = renderHook(() => useWorktreeLaunch(worktree(m)));
  act(() => void result.current.launch());
  expect(hub.commands().at(-1)).toMatchObject({ type: "session.launch", cwd: "/repo", agent: "codex" });
  await act(() => hub.answer({ ok: false, error: "x" }));
  act(() => void result.current.launch("claude"));
  expect(hub.commands().at(-1)).not.toHaveProperty("agent");
});

test("the default agent is set for every browser, and the choice shows only where Codex is installed", async () => {
  const hub = await connectHub({ machines: [withCodex()], server: server("claude") });
  const { unmount } = render(<DefaultAgentSection />);
  expect(screen.getByRole("radio", { name: "Claude Code" }).getAttribute("aria-checked")).toBe("true");
  await userEvent.setup().click(screen.getByRole("radio", { name: "Codex" }));
  expect(hub.sent.at(-1)).toMatchObject({ type: "defaultAgent.set", agent: "codex" });
  unmount();

  await connectHub({ machines: [claudeOnly], server: server("claude") });
  render(<DefaultAgentSection />);
  expect(screen.queryByRole("radio")).toBeNull();
});
