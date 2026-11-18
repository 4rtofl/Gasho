import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MachineInfo } from "@gasho/protocol";
import { expect, test, vi } from "vitest";
import { CloneRepoDialog } from "@/components/clone-repo-dialog";
import { connectHub, machine } from "./hub";

const server = (id: string, extra: Partial<MachineInfo> = {}) =>
  machine(id, [], { name: id, daemonVersion: "0.28.2", repos: [], folders: ["/home/me/repos/app"], ...extra });

const repoField = () => screen.getByRole<HTMLInputElement>("textbox", { name: "clone するリポジトリ" });
const cloneButton = () => screen.getByRole<HTMLButtonElement>("button", { name: "clone する" });

test("offers the trusted folders and those that hold them, and shows where the clone goes before it runs", async () => {
  const user = userEvent.setup();
  await connectHub({ machines: [server("linux")] });
  render(<CloneRepoDialog open onClose={() => {}} />);
  const folder = screen.getByRole<HTMLSelectElement>("combobox", { name: "clone 先のフォルダー" });
  expect([...folder.options].map((o) => o.textContent)).toEqual(["/home/me/repos", "/home/me/repos/app", "ほかのフォルダーを入力する…"]);

  await user.type(repoField(), "https://github.com/cli/go-gh.git");
  expect(screen.getByText("/home/me/repos/go-gh")).toBeTruthy();
  await user.type(screen.getByRole("textbox", { name: "フォルダーの名前（任意）" }), "gh-lib");
  expect(screen.getByText("/home/me/repos/gh-lib")).toBeTruthy();
});

test("clones, then registers what was cloned, tells the caller and closes", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [server("linux")] });
  const onClose = vi.fn();
  const onCloned = vi.fn();
  render(<CloneRepoDialog open onClose={onClose} onCloned={onCloned} />);
  await user.type(repoField(), " cli/cli ");
  await user.click(cloneButton());
  expect(hub.commands().at(-1)).toMatchObject({ type: "repo.clone", machine: "linux", parent: "/home/me/repos", repo: "cli/cli" });
  expect(hub.commands().at(-1)).not.toHaveProperty("name");

  await hub.answer({ ok: true, path: "/home/me/repos/cli" });
  expect(hub.commands().at(-1)).toMatchObject({ type: "repo.register", machine: "linux", path: "/home/me/repos/cli" });
  expect(onClose).not.toHaveBeenCalled();

  await hub.answer({ ok: true, path: "/home/me/repos/cli" });
  expect(onCloned).toHaveBeenCalledWith("linux", "/home/me/repos/cli");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("nothing closes the dialog while the clone goes on, and it can be closed once it failed", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [server("linux")] });
  const onClose = vi.fn();
  render(<CloneRepoDialog open onClose={onClose} />);
  await user.type(repoField(), "cli/cli");
  await user.click(cloneButton());

  expect(screen.getByRole("status").textContent).toContain("最長 10 分");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "clone しています…" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "閉じる" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "やめる" }).disabled).toBe(true);
  expect(repoField().disabled).toBe(true);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", keyCode: 27 });
  expect(onClose).not.toHaveBeenCalled();

  await hub.answer({ ok: false, error: "同じ名前のフォルダーかファイルが、すでにあります：/home/me/repos/cli" });
  expect(screen.getByRole("alert").textContent).toContain("すでにあります");
  expect(hub.commands().filter((c) => c.type === "repo.register")).toHaveLength(0);
  expect(repoField().value).toBe("cli/cli");
  fireEvent.keyDown(repoField(), { key: "Escape", keyCode: 27 });
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("what cannot be cloned is said without asking the working server", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [server("linux")] });
  render(<CloneRepoDialog open onClose={() => {}} />);
  await user.type(repoField(), "not a repo");
  await user.click(cloneButton());
  expect(screen.getByRole("alert").textContent).toContain("owner/name");

  await user.clear(repoField());
  await user.type(repoField(), "cli/cli");
  await user.selectOptions(screen.getByRole("combobox", { name: "clone 先のフォルダー" }), "ほかのフォルダーを入力する…");
  await user.type(screen.getByRole("textbox", { name: "clone 先のフォルダーの絶対パス" }), "relative/path");
  await user.click(cloneButton());
  expect(screen.getByRole("alert").textContent).toBe("clone 先のフォルダーを絶対パスで入れてください。");
  expect(hub.commands()).toHaveLength(0);
});

test("a folder typed in is where it clones, under the name given", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [server("linux")] });
  render(<CloneRepoDialog open onClose={() => {}} />);
  await user.type(repoField(), "cli/cli");
  await user.selectOptions(screen.getByRole("combobox", { name: "clone 先のフォルダー" }), "ほかのフォルダーを入力する…");
  await user.type(screen.getByRole("textbox", { name: "clone 先のフォルダーの絶対パス" }), "/srv/code/");
  await user.type(screen.getByRole("textbox", { name: "フォルダーの名前（任意）" }), "gh");
  expect(screen.getByText("/srv/code/gh")).toBeTruthy();
  await user.click(cloneButton());
  expect(hub.commands().at(-1)).toMatchObject({ type: "repo.clone", parent: "/srv/code/", repo: "cli/cli", name: "gh" });
});

test("cloned but not registered: says where the clone is and why, and stays open", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [server("linux")] });
  const onClose = vi.fn();
  const onCloned = vi.fn();
  render(<CloneRepoDialog open onClose={onClose} onCloned={onCloned} />);
  await user.type(repoField(), "cli/cli");
  await user.click(cloneButton());
  await hub.answer({ ok: true, path: "/home/me/repos/cli" });
  await hub.answer({ ok: false, error: "登録先に書き込めません。" });

  const alert = screen.getByRole("alert").textContent;
  expect(alert).toContain("clone できましたが、登録できませんでした");
  expect(alert).toContain("/home/me/repos/cli");
  expect(alert).toContain("登録先に書き込めません。");
  expect(onCloned).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

test("the connection lost during the clone: says the result is unknown and where, can be closed, and registers nothing", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [server("linux")] });
  const onClose = vi.fn();
  const onCloned = vi.fn();
  render(<CloneRepoDialog open onClose={onClose} onCloned={onCloned} />);
  await user.type(repoField(), "cli/cli");
  await user.click(cloneButton());
  const asked = hub.commands().length;
  hub.drop();

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("clone できたか分かりません");
  expect(alert.textContent).toContain("/home/me/repos/cli");
  expect(alert.textContent).toContain("「リポジトリを登録・解除…」");
  expect(hub.commands()).toHaveLength(asked);
  expect(onCloned).not.toHaveBeenCalled();
  await user.click(screen.getAllByRole("button", { name: "閉じる" }).at(-1)!);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("the connection lost during the registration: says the clone is there and the registration is unknown", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [server("linux")] });
  const onCloned = vi.fn();
  render(<CloneRepoDialog open onClose={() => {}} onCloned={onCloned} />);
  await user.type(repoField(), "cli/cli");
  await user.click(cloneButton());
  await hub.answer({ ok: true, path: "/home/me/repos/cli" });
  hub.drop();

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("clone できましたが、登録できたか分かりません");
  expect(alert.textContent).toContain("/home/me/repos/cli");
  expect(onCloned).not.toHaveBeenCalled();
});

test("clones on the working server picked, with that server's folders, and only offers those that can clone", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({
    machines: [
      server("linux"),
      server("mac", { folders: ["/Users/me/code/site"] }),
      server("away", { connected: false }),
      server("old", { daemonVersion: "0.9.0" }),
    ],
  });
  render(<CloneRepoDialog open onClose={() => {}} />);
  const picker = screen.getByRole<HTMLSelectElement>("combobox", { name: "working server" });
  expect([...picker.options].map((o) => o.value)).toEqual(["linux", "mac"]);

  await user.selectOptions(picker, "mac");
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "clone 先のフォルダー" }).value).toBe("/Users/me/code");
  await user.type(repoField(), "cli/cli");
  await user.click(cloneButton());
  expect(hub.commands().at(-1)).toMatchObject({ type: "repo.clone", machine: "mac", parent: "/Users/me/code" });
  await hub.answer({ ok: true, path: "/Users/me/code/cli" });
  expect(hub.commands().at(-1)).toMatchObject({ type: "repo.register", machine: "mac" });
});

test("the working server going offline during the clone does not send the registration to another one", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [server("linux"), server("mac")] });
  render(<CloneRepoDialog open onClose={() => {}} />);
  await user.selectOptions(screen.getByRole("combobox", { name: "working server" }), "mac");
  await user.type(repoField(), "cli/cli");
  await user.click(cloneButton());
  await hub.say({ type: "machine", machine: server("mac", { connected: false }) });
  expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "working server" }).value).toBe("mac");
  await hub.answer({ ok: true, path: "/home/me/repos/cli" });
  expect(hub.commands().at(-1)).toMatchObject({ type: "repo.register", machine: "mac" });
});

test("the working server picked going offline stops the clone instead of moving to another one, until it is back", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [server("alpha"), server("zeta")] });
  render(<CloneRepoDialog open onClose={() => {}} />);
  const picker = screen.getByRole<HTMLSelectElement>("combobox", { name: "working server" });
  await user.selectOptions(picker, "zeta");
  await user.type(repoField(), "cli/cli");

  await hub.say({ type: "machine", machine: server("zeta", { connected: false }) });
  expect(picker.value).toBe("zeta");
  expect(screen.getByRole("alert").textContent).toContain("zeta では、いま clone できません");
  expect(cloneButton().disabled).toBe(true);
  fireEvent.submit(cloneButton().closest("form")!);
  expect(hub.commands()).toHaveLength(0);

  await hub.say({ type: "machine", machine: server("zeta") });
  expect(screen.queryByRole("alert")).toBeNull();
  await user.click(cloneButton());
  expect(hub.commands().at(-1)).toMatchObject({ type: "repo.clone", machine: "zeta" });
});

test("another working server connecting changes nothing chosen, also during a clone that then fails", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [server("alpha", { connected: false }), server("zeta")] });
  render(<CloneRepoDialog open onClose={() => {}} />);
  const picker = screen.getByRole<HTMLSelectElement>("combobox", { name: "working server" });
  expect(picker.value).toBe("zeta");
  await hub.say({ type: "machine", machine: server("alpha") });
  expect(picker.value).toBe("zeta");

  await user.type(repoField(), "cli/cli");
  await user.click(cloneButton());
  await hub.say({ type: "machine", machine: server("alpha", { folders: ["/srv/alpha/app"] }) });
  await hub.answer({ ok: false, error: "clone できませんでした：だめでした" });
  expect(picker.value).toBe("zeta");
  await user.click(cloneButton());
  expect(hub.commands().at(-1)).toMatchObject({ type: "repo.clone", machine: "zeta" });
});

test("the working server lost during the clone: the result is unknown, not a failure, and nothing is registered", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [server("linux")] });
  const onCloned = vi.fn();
  render(<CloneRepoDialog open onClose={() => {}} onCloned={onCloned} />);
  await user.type(repoField(), "cli/cli");
  await user.click(cloneButton());
  const asked = hub.commands().length;
  // In the order the Gasho server sends them.
  await hub.say({ type: "machine", machine: server("linux", { connected: false }) });
  await hub.answer({ ok: false, error: "working server との接続が切れました。" });

  const alert = screen.getByRole("alert").textContent;
  expect(alert).toContain("clone できたか分かりません");
  expect(alert).toContain("/home/me/repos/cli");
  expect(alert).toContain("「リポジトリを登録・解除…」");
  expect(hub.commands()).toHaveLength(asked);
  expect(onCloned).not.toHaveBeenCalled();
});

test("the working server lost during the registration: the clone is there and the registration is unknown", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [server("linux")] });
  render(<CloneRepoDialog open onClose={() => {}} />);
  await user.type(repoField(), "cli/cli");
  await user.click(cloneButton());
  await hub.answer({ ok: true, path: "/home/me/repos/cli" });
  await hub.say({ type: "machine", machine: server("linux", { connected: false }) });
  await hub.answer({ ok: false, error: "working server との接続が切れました。" });
  expect(screen.getByRole("alert").textContent).toContain("clone できましたが、登録できたか分かりません");
});

test("the Enter that confirms a conversion does not start a clone", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [server("linux")] });
  render(<CloneRepoDialog open onClose={() => {}} />);
  await user.type(repoField(), "cli/cli");
  const notPrevented = fireEvent.keyDown(repoField(), { key: "Enter", isComposing: true });
  expect(notPrevented).toBe(false);
  expect(hub.commands()).toHaveLength(0);
});

test("without a working server that can clone, says so", async () => {
  await connectHub({ machines: [server("old", { daemonVersion: "0.9.0" })] });
  render(<CloneRepoDialog open onClose={() => {}} />);
  expect(screen.getByText(/^clone できる working server がありません。/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "clone する" })).toBeNull();
});
