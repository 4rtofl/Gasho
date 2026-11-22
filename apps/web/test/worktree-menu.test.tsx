import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { WorktreeActionDialog, WorktreeContextMenu, type WorktreeActionRequest } from "@/components/worktree-menu";
import { worktreesByLastUse } from "@/lib/sessions";
import { connectHub, machine, session } from "./hub";

const inWorktree = session("s1", { cwd: "/w/issue-255", worktree: { path: "/w/issue-255", repo: "/w/gasho", branch: "feat/255-worktree-name" } });
const worktreeOf = (names?: Record<string, string>) =>
  worktreesByLastUse([machine("mac", [inWorktree], { name: "Mac", daemonVersion: "0.37.0", canRemoveWorktree: true, ...(names ? { worktreeNames: names } : {}) })])[0]!;

test("a worktree's menu names its branch under the name given to it, where the pointer cannot hover, and picks a rename", async () => {
  const user = userEvent.setup();
  const onPick = vi.fn<(r: WorktreeActionRequest) => void>();
  const worktree = worktreeOf({ "/w/issue-255": "#255 名前" });
  render(
    <WorktreeContextMenu worktree={worktree} onPick={onPick}>
      <button type="button">#255 名前</button>
    </WorktreeContextMenu>,
  );
  await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "#255 名前" }) });
  expect(screen.getByText("ブランチ feat/255-worktree-name")).toBeTruthy();
  await user.click(screen.getByRole("menuitem", { name: "名前を変更…" }));
  expect(onPick).toHaveBeenCalledWith({ action: "rename", worktree });
});

test("a name is given to a worktree with the dialog open until the Gasho server answers, and taken away to show its branch again", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [worktreeOf().machine] });
  const onClose = vi.fn();
  const { unmount } = render(<WorktreeActionDialog request={{ action: "rename", worktree: worktreeOf() }} onClose={onClose} />);

  // Without a name, nothing to take away; the branch shows where the name goes.
  const field = screen.getByRole<HTMLInputElement>("textbox", { name: "名前" });
  expect(field.value).toBe("");
  expect(field.placeholder).toBe("feat/255-worktree-name");
  expect(screen.queryByRole("button", { name: "名前を消す" })).toBeNull();
  await user.type(field, "  #255 名前  ");
  await user.click(screen.getByRole("button", { name: "変更する" }));
  expect(hub.sent.at(-1)).toMatchObject({ type: "worktree.name", machine: "mac", path: "/w/issue-255", name: "#255 名前" });
  await user.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  await hub.answer({ ok: false, error: "名前は60文字までです。" });
  expect(screen.getByRole("alert").textContent).toBe("名前は60文字までです。");
  await user.click(screen.getByRole("button", { name: "変更する" }));
  await hub.answer({ ok: true });
  expect(onClose).toHaveBeenCalledTimes(1);
  unmount();

  render(<WorktreeActionDialog request={{ action: "rename", worktree: worktreeOf({ "/w/issue-255": "#255 名前" }) }} onClose={onClose} />);
  expect(screen.getByRole<HTMLInputElement>("textbox", { name: "名前" }).value).toBe("#255 名前");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "変更する" }).disabled).toBe(true);
  await user.click(screen.getByRole("button", { name: "名前を消す" }));
  const cleared = hub.sent.at(-1);
  expect(cleared).toMatchObject({ type: "worktree.name", machine: "mac", path: "/w/issue-255" });
  expect(cleared && "name" in cleared).toBe(false);
  expect(hub.commands()).toEqual([]);
});
