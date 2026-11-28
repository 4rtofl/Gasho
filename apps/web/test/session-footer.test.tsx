import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { SessionInfo } from "@gasho/protocol";
import { SessionFooter } from "@/components/session-footer";
import { connectHub, machine, session } from "./hub";

beforeEach(() => {
  // A desktop-wide screen.
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
});

const limits = { fiveHour: { percent: 18, resetsAt: Date.now() + 3600_000 }, at: Date.now() };
const context = { used: 72_000, size: 200_000, percent: 36, at: Date.now() };
const claude = session("claude-1", { limits });

async function footer(shown: SessionInfo) {
  const m = machine("m1", [claude, shown], { canReadUsage: true });
  const hub = await connectHub({ machines: [m] });
  render(<SessionFooter machine={m} session={shown} />);
  return () => hub.sent.filter((c) => c.type === "usage.get");
}

test("Claude Code's session shows the plan's usage limits and asks for them", async () => {
  const asked = await footer(claude);
  expect(screen.getByRole("button", { name: /5時間の上限 18%/ })).toBeTruthy();
  expect(asked().length).toBe(1);
});

test.each(["codex", "antigravity"] as const)("a session of %s shows its own context window, and none of Claude's limits", async (agent) => {
  const asked = await footer(session("other", { agent, context }));
  expect(screen.getByRole("button", { name: /コンテキスト 36% 使用/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /上限/ })).toBeNull();
  screen.getByRole("button", { name: /コンテキスト/ }).click();
  expect(await screen.findByText("72,000 / 200,000 トークン")).toBeTruthy();
  expect(screen.queryByText(/上限/)).toBeNull();
  expect(asked().length).toBe(0);
});
