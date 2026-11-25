import { render, screen, within } from "@testing-library/react";
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

const inRepo = (id: string, path: string, branch: string) => session(id, { cwd: path, worktree: { path, repo: "/w/gasho", branch } });
/** Two worktrees and the repository's main one, in that order. */
const selectedOf = (names?: Record<string, string>) => {
  const all = worktreesByLastUse([
    machine("mac", [inRepo("s1", "/w/issue-255", "feat/255-worktree-name"), inRepo("s2", "/w/issue-264", "feat/264-sidebar-sticky-menu"), inRepo("s3", "/w/gasho", "main")], {
      name: "Mac",
      daemonVersion: "0.37.0",
      canRemoveWorktree: true,
      ...(names ? { worktreeNames: names } : {}),
    }),
  ]);
  return ["/w/issue-255", "/w/issue-264", "/w/gasho"].map((p) => all.find((w) => w.path === p)!);
};

test("on a row of the worktrees selected together, the menu is theirs and picks for all of them", async () => {
  const user = userEvent.setup();
  const onPick = vi.fn<(r: WorktreeActionRequest) => void>();
  const selected = selectedOf();
  render(
    <WorktreeContextMenu worktree={selected[1]!} selection={selected} onPick={onPick}>
      <button type="button">#264</button>
    </WorktreeContextMenu>,
  );
  await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "#264" }) });
  expect(screen.getByText("選んだ 3 件の worktree")).toBeTruthy();
  await user.click(screen.getByRole("menuitem", { name: "削除…" }));
  expect(onPick).toHaveBeenCalledWith({ action: "remove", worktree: selected[1], worktrees: selected });
});

test("the worktrees selected together are removed one by one; those that cannot be are left out, and those with changes stay until pressed again", async () => {
  const user = userEvent.setup();
  const selected = selectedOf();
  const hub = await connectHub({ machines: [selected[0]!.machine] });
  const onClose = vi.fn();
  render(<WorktreeActionDialog request={{ action: "remove", worktree: selected[0]!, worktrees: selected }} onClose={onClose} />);

  expect(screen.getByRole("heading", { name: "2 件の worktree を削除しますか？" })).toBeTruthy();
  expect(within(screen.getByRole("list", { name: "削除しない worktree" })).getByText(/main の worktree/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "2 件を削除する" }));
  expect(hub.commands()).toMatchObject([{ type: "worktree.remove", path: "/w/issue-255", branch: "feat/255-worktree-name" }]);
  await hub.answer({ ok: true, ended: ["s1"] });
  await vi.waitFor(() => expect(hub.commands()).toHaveLength(2));
  expect(hub.commands()[1]).toMatchObject({ type: "worktree.remove", path: "/w/issue-264" });
  expect(hub.commands()[1] && "force" in hub.commands()[1]!).toBe(false);
  await hub.answer({ ok: false, error: "未コミットの変更が 2 件あります。", changes: { uncommitted: 2, unpushed: 0 } });

  expect(screen.getByRole("alert").textContent).toMatch(/1 件の worktree は、未コミットの変更か push していない commit があるため/);
  expect(screen.getByText("未コミットの変更 2 件があります")).toBeTruthy();
  expect(screen.getByText("削除しました")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
  // The second press removes only the one left, its changes and all.
  await user.click(screen.getByRole("button", { name: "変更を捨てて削除" }));
  expect(hub.commands()).toHaveLength(3);
  expect(hub.commands()[2]).toMatchObject({ type: "worktree.remove", path: "/w/issue-264", force: true });
  await hub.answer({ ok: true, ended: ["s2"] });
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

test("the worktrees selected together are renamed with a sed s command, each one's name before and after shown first", async () => {
  const user = userEvent.setup();
  const selected = selectedOf({ "/w/gasho": "本体" });
  const hub = await connectHub({ machines: [selected[0]!.machine] });
  const onClose = vi.fn();
  render(<WorktreeActionDialog request={{ action: "rename", worktree: selected[0]!, worktrees: selected }} onClose={onClose} />);
  const field = screen.getByRole("textbox", { name: "置換" });
  const rows = () => within(screen.getByRole("list", { name: "変更前と変更後" })).getAllByRole("listitem").map((li) => li.textContent);

  await user.click(field);
  await user.paste("s/^feat");
  expect(screen.getByText(/s\/<正規表現>\/<置換>\/ の形で/)).toBeTruthy();
  await user.clear(field);
  await user.paste(String.raw`s/^feat\/([0-9]+)-.*/#\1/`);
  expect(rows()).toEqual(["feat/255-worktree-nameは#255", "feat/264-sidebar-sticky-menuは#264", "本体は変わりません"]);
  // A name that comes to nothing is taken away.
  await user.clear(field);
  await user.paste("s/本体//");
  expect(rows()[2]).toBe("本体はmain（名前を消す）");
  await user.clear(field);
  await user.paste(String.raw`s/^feat\/([0-9]+)-.*/#\1/`);

  await user.click(screen.getByRole("button", { name: "2 件を変更する" }));
  const names = hub.sent.filter((m) => m.type === "worktree.name");
  expect(names).toMatchObject([
    { machine: "mac", path: "/w/issue-255", name: "#255" },
    { machine: "mac", path: "/w/issue-264", name: "#264" },
  ]);
  for (const request of names) await hub.answer({ ok: true }, request);
  await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});
