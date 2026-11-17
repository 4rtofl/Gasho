import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MachineInfo } from "@gasho/protocol";
import { expect, test } from "vitest";
import { ReposDialog } from "@/components/repos-dialog";
import { connectHub, machine } from "./hub";

const linux = (extra: Partial<MachineInfo> = {}) =>
  machine("linux", [], {
    name: "Linux",
    repos: [{ path: "/src/gasho", worktrees: [{ path: "/src/gasho", branch: "main" }, { path: "/src/issue-1", branch: "feat/1" }] }],
    folderRepos: [
      { path: "/src/gasho", worktreeCount: 2 },
      { path: "/src/zeta", worktreeCount: 1 },
      { path: "/src/alpha", worktreeCount: 3 },
    ],
    ...extra,
  });

const draw = () => render(<ReposDialog open onClose={() => {}} />);

test("the repositories offered are those of the trusted folders but the registered ones, and picking one registers it", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [linux()] });
  draw();
  const section = screen.getByRole("region", { name: "Linux" });
  expect(within(section).getByText(/worktree 2/)).toBeTruthy();

  const options = within(section).getAllByRole("option");
  expect(options.map((o) => o.textContent)).toEqual([expect.stringContaining("alpha"), expect.stringContaining("zeta")]);
  await user.click(options[0]!);
  expect(hub.commands().at(-1)).toMatchObject({ type: "repo.register", machine: "linux", path: "/src/alpha" });

  await hub.answer({ ok: true });
  expect(screen.getByText("登録しました：/src/alpha")).toBeTruthy();
  // The working server tells its repositories again: the new one is registered, and no longer offered.
  const registered = { path: "/src/alpha", worktrees: [{ path: "/src/alpha", branch: "main" }] };
  await hub.say({ type: "machine", machine: linux({ repos: [...linux().repos!, registered] }) });
  expect(within(section).getAllByRole("option").map((o) => o.textContent)).toEqual([expect.stringContaining("zeta")]);
  expect(within(section).getAllByRole("button", { name: "解除" })).toHaveLength(2);
});

test("a folder typed in is registered only as an absolute path, and the field empties once it is", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [linux()] });
  draw();
  const field = screen.getByRole<HTMLInputElement>("textbox", { name: /一覧に無いフォルダーを登録する/ });

  await user.type(field, "src/other{Enter}");
  expect(screen.getByRole("alert").textContent).toBe("フォルダーを絶対パスで入れてください。");
  expect(hub.commands()).toHaveLength(0);

  await user.clear(field);
  await user.type(field, "/src/issue-1");
  await user.click(screen.getByRole("button", { name: "登録する" }));
  expect(hub.commands().at(-1)).toMatchObject({ type: "repo.register", path: "/src/issue-1" });
  // A worktree's folder registers its repository: the answer names it.
  await hub.answer({ ok: true, path: "/src/gasho" });
  expect(screen.getByText("登録しました：/src/gasho")).toBeTruthy();
  expect(field.value).toBe("");
});

test("a registered repository is taken off, and what went wrong is said", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [linux()] });
  draw();
  await user.click(screen.getByRole("button", { name: "解除" }));
  expect(hub.commands().at(-1)).toMatchObject({ type: "repo.unregister", path: "/src/gasho" });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "解除しています…" }).disabled).toBe(true);
  await hub.answer({ ok: false });
  expect(screen.getByRole("alert").textContent).toBe("解除できませんでした。");
});

test("a gasho-daemon that cannot register repositories, or one offline, says so instead", async () => {
  await connectHub({ machines: [machine("old", [], { name: "Old" }), linux({ connected: false })] });
  draw();
  expect(within(screen.getByRole("region", { name: "Old" })).getByText(/古いため、リポジトリを登録できません/)).toBeTruthy();
  const offline = screen.getByRole("region", { name: "Linux" });
  expect(within(offline).getByText("オフライン")).toBeTruthy();
  expect(within(offline).queryByRole("option")).toBeNull();
  expect(within(offline).getByRole<HTMLButtonElement>("button", { name: "解除" }).disabled).toBe(true);
});
