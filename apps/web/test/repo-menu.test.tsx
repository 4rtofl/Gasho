import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RegisteredRepo } from "@gasho/protocol";
import { expect, test, vi } from "vitest";
import { RepoActionDialog, RepoContextMenu, type RepoActionRequest } from "@/components/repo-menu";
import { unregisterRepoPlan, unregisterRepoProblem } from "@/lib/repo-unregister";
import { connectHub, machine, session } from "./hub";

const GASHO: RegisteredRepo = {
  path: "/w/gasho",
  worktrees: [
    { path: "/w/gasho", branch: "main" },
    { path: "/w/issue-1", branch: "feat/1" },
    { path: "/w/issue-2", branch: "feat/2" },
  ],
};
const inRepo = (id: string, path: string, branch: string) => session(id, { cwd: path, worktree: { path, repo: "/w/gasho", branch } });
/** The repository registered on mac, with two sessions in its worktree issue-1 and none in the others. */
const mac = (extra = {}) =>
  machine("mac", [inRepo("s1", "/w/issue-1", "feat/1"), inRepo("s2", "/w/issue-1", "feat/1"), session("s3", { cwd: "/w/lib", worktree: { path: "/w/lib", repo: "/w/lib", branch: "main" } })], { name: "Mac", repos: [GASHO], ...extra });
const request: RepoActionRequest = { machine: "mac", path: "/w/gasho", title: "Gasho" };

test("a repository can be taken off a working server that is connected, knows registering, and has it registered", () => {
  expect(unregisterRepoProblem(mac(), "/w/gasho")).toBeUndefined();
  expect(unregisterRepoProblem(mac({ connected: false }), "/w/gasho")).toBe("Mac はオフラインです。");
  expect(unregisterRepoProblem(mac({ repos: undefined }), "/w/gasho")).toMatch(/^Mac の gasho-daemon は古いため/);
  expect(unregisterRepoProblem(mac(), "/w/lib")).toBe("Mac に登録していないリポジトリです。");
});

test("once taken off, its worktrees with sessions stay in the list, and those without leave it, but those this browser keeps", () => {
  expect(unregisterRepoPlan([mac()], [], "mac", "/w/gasho")).toEqual({ staying: 1, sessions: 2, leaving: 2 });
  // A worktree this browser keeps since its sessions went comes back to the list.
  const kept = { machine: "mac", path: "/w/issue-2", label: "feat/2", subfolders: true, repoFolder: "/w/gasho", branch: "feat/2" };
  expect(unregisterRepoPlan([mac()], [kept], "mac", "/w/gasho")).toEqual({ staying: 1, sessions: 2, leaving: 1 });
  // Another working server's repository of the same folder is not this one.
  expect(unregisterRepoPlan([mac(), machine("pc", [], { repos: [GASHO] })], [], "pc", "/w/gasho")).toEqual({ staying: 0, sessions: 0, leaving: 3 });
});

test("a category's menu names the repository and its folder, and picks taking it off; it cannot while the server is offline", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [mac()] });
  const onPick = vi.fn<(r: RepoActionRequest) => void>();
  render(
    <RepoContextMenu repo={request} onPick={onPick}>
      <button type="button">Gasho</button>
    </RepoContextMenu>,
  );
  await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Gasho" }) });
  expect(screen.getByText("Mac · /w/gasho")).toBeTruthy();
  await user.click(screen.getByRole("menuitem", { name: "登録を外す…" }));
  expect(onPick).toHaveBeenCalledWith(request);

  await hub.say({ type: "machine", machine: mac({ connected: false }) });
  await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "Gasho" }) });
  expect(screen.getByRole("menuitem", { name: "登録を外す…" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("Mac はオフラインです。")).toBeTruthy();
});

test("the dialog tells what stays and what leaves the list, and stays open until the working server answers", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [mac()] });
  const onClose = vi.fn();
  render(<RepoActionDialog request={request} onClose={onClose} />);
  const dialog = screen.getByRole("alertdialog", { name: "リポジトリの登録を外しますか？" });
  expect(dialog.textContent).toContain("フォルダーとファイルは消しません。");
  expect(dialog.textContent).toContain("セッションのある worktree 1 件（セッション 2 件）は、登録を外したあとも一覧に残ります。");
  expect(dialog.textContent).toContain("セッションの無い worktree 2 件は、一覧から消えます。");

  await user.click(screen.getByRole("button", { name: "登録を外す" }));
  expect(hub.sent.at(-1)).toMatchObject({ type: "repo.unregister", machine: "mac", path: "/w/gasho" });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "外しています…" }).disabled).toBe(true);
  await hub.answer({ ok: false, error: "外せませんでした：理由" });
  expect(screen.getByRole("alert").textContent).toBe("外せませんでした：理由");
  expect(onClose).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "登録を外す" }));
  await hub.answer({ ok: true });
  expect(onClose).toHaveBeenCalledTimes(1);
});
