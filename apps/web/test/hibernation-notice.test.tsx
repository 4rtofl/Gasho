import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SessionInfo } from "@gasho/protocol";
import { expect, test } from "vitest";
import { HibernationNotice } from "@/components/hibernation-notice";
import { StatusBadge } from "@/components/status-badge";
import { connectHub, machine, session } from "./hub";

function show(extra: Partial<SessionInfo>) {
  const s = session("s1", extra);
  return render(<HibernationNotice machine={machine("m1", [s])} session={s} />);
}

test("a running session shows nothing", async () => {
  await connectHub();
  const { container } = show({});
  expect(container.textContent).toBe("");
});

test("a hibernated session says that a message brings it back, with no button to press", async () => {
  await connectHub();
  show({ hibernation: "hibernated" });
  expect(screen.getByRole("status").textContent).toContain("休止中です。発言すると再開します。");
  expect(screen.queryByRole("button")).toBeNull();
});

test("a session coming back says so, and that what was sent follows", async () => {
  await connectHub();
  show({ hibernation: "resuming", pendingInputs: 2 });
  expect(screen.getByRole("status").textContent).toContain("Claude Code を再開しています。送信待ち 2 件は、再開してから送ります。");
});

test("a session that could not come back says why, keeps what was sent, and can be tried again", async () => {
  const user = userEvent.setup();
  const hub = await connectHub();
  show({ hibernation: "hibernated", resumeError: "会話のフォルダーがありません：/repo", pendingInputs: 1 });
  expect(screen.getByRole("alert").textContent).toContain("再開できませんでした：会話のフォルダーがありません：/repo 送信待ち 1 件は預かっています。");

  await user.click(screen.getByRole("button", { name: "もう一度再開" }));
  expect(hub.commands().at(-1)).toMatchObject({ type: "session.wake", machine: "m1", sessionId: "s1" });
  await hub.answer({ ok: false, error: "このセッションは見つかりません。" });
  expect(screen.getByRole("alert").textContent).toContain("このセッションは見つかりません。");
});

test("the state says that a session is hibernated", () => {
  render(<StatusBadge status="idle" hibernation="hibernated" />);
  expect(screen.getByText("休止中")).toBeTruthy();
});
