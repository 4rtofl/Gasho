import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BackgroundTask } from "@gasho/protocol";
import { expect, test } from "vitest";
import { BackgroundTasks } from "@/components/background-tasks";
import { connectHub, machine, session } from "./hub";

const shell: BackgroundTask = { id: "b1", kind: "shell", title: "開発サーバー", command: "npm run dev" };
const agent: BackgroundTask = { id: "a1", kind: "agent", title: "テストを調べる" };

function show(background: BackgroundTask[]) {
  const s = session("s1", { background });
  render(<BackgroundTasks machine={machine("m1", [s])} session={s} />);
}

test("a task is stopped by its id, all of them without one, and nothing else can be stopped meanwhile", async () => {
  const user = userEvent.setup();
  const hub = await connectHub();
  show([shell, agent]);
  const rows = screen.getAllByRole("listitem");
  expect(rows).toHaveLength(2);

  await user.click(within(rows[1]!).getByRole("button", { name: "止める" }));
  expect(hub.commands().at(-1)).toMatchObject({ type: "session.stopTask", machine: "m1", sessionId: "s1", taskId: "a1" });
  expect(within(rows[1]!).getByRole("button", { name: "止めています…" })).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "すべて止める" }).disabled).toBe(true);
  // Stopped, but Claude Code said something about it.
  await hub.answer({ ok: true, warning: "止めましたが、Claude に伝えられませんでした。" });
  expect(screen.getByText("止めましたが、Claude に伝えられませんでした。")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "すべて止める" }));
  const all = hub.commands().at(-1);
  expect(all).toMatchObject({ type: "session.stopTask", sessionId: "s1" });
  expect(all).not.toHaveProperty("taskId");
  await hub.answer({ ok: false, error: "セッションが見つかりません。" });
  expect(screen.getByText("セッションが見つかりません。")).toBeTruthy();
});

test("a single task has no button to stop them all", async () => {
  await connectHub();
  show([shell]);
  expect(screen.getByText("バックグラウンドで実行中（1）")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "すべて止める" })).toBeNull();
  // A shell shows what it runs under its title.
  expect(screen.getByText(/npm run dev/)).toBeTruthy();
});
