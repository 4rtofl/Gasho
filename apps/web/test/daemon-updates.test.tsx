import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MachineInfo, ServerInfo } from "@gasho/protocol";
import { expect, test } from "vitest";
import { DaemonUpdates } from "@/components/daemon-updates";
import { connectHub, machine, session } from "./hub";

const latest = { daemon: "0.22.0", hub: "0.8.0", checkedAt: Date.now() };
const server: ServerInfo = { version: "0.7.3", update: { canUpdate: true } };
const linux = (extra: Partial<MachineInfo> = {}) =>
  machine(
    "linux",
    [
      session("s1", { pendingInputs: 2, permissionRequests: [{ id: "p1", toolName: "Bash", input: "{}", at: 0 }] }),
      // A question read from the screen is read again after the restart: it is not counted.
      session("s2", { permissionRequests: [{ id: "question:1", toolName: "AskUserQuestion", input: "{}", at: 0 }] }),
    ],
    { name: "Linux", daemonVersion: "0.21.4", update: { canUpdate: true, previous: "0.21.3" }, ...extra },
  );

const row = (name: string) => screen.getByText(name, { selector: "span" }).closest("li")!;

test("a working server is updated after its dialog says what the update does to the work waiting there", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [linux()], latest, server });
  render(<DaemonUpdates />);
  expect(within(row("Linux")).getByText("0.22.0 に更新できます。")).toBeTruthy();

  await user.click(within(row("Linux")).getByRole("button", { name: "0.22.0 に更新" }));
  const dialog = screen.getByRole("alertdialog", { name: "「Linux」の gasho-daemon を 0.22.0 に更新しますか？" });
  expect(within(dialog).getByText(/送るのを待っている入力が 2 件あります/)).toBeTruthy();
  expect(within(dialog).getByText(/権限の確認を待っているものが 1 件あります/)).toBeTruthy();
  expect(within(dialog).getByRole("link", { name: /0.21.4 からの変更を GitHub で見る/ }).getAttribute("href")).toBe(
    "https://github.com/4rtofl/Gasho/compare/daemon-v0.21.4...daemon-v0.22.0",
  );

  await user.click(within(dialog).getByRole("button", { name: "更新する" }));
  expect(hub.commands().at(-1)).toMatchObject({ type: "daemon.update", machine: "linux", version: "0.22.0" });
  // Escape does not close it while the answer is still to come.
  await user.keyboard("{Escape}");
  expect(within(dialog).getByRole("button", { name: "始めています…" })).toBeTruthy();
  await hub.answer({ ok: true });
  expect(screen.queryByRole("alertdialog")).toBeNull();

  await hub.say({ type: "machine", machine: linux({ daemonVersion: "0.22.0", update: { canUpdate: true, previous: "0.21.4" } }) });
  expect(within(row("Linux")).getByText("0.22.0 に更新しました。")).toBeTruthy();
});

test("a working server goes back to the version it was updated from, and an update refused says why", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [linux({ update: { canUpdate: true, previous: "0.21.3", installed: ["0.21.3"] } })], latest, server });
  render(<DaemonUpdates />);

  await user.click(screen.getByRole("button", { name: "0.21.3 に戻す" }));
  const dialog = screen.getByRole("alertdialog", { name: "「Linux」の gasho-daemon を 0.21.3 に戻しますか？" });
  expect(within(dialog).getByText("入っている 0.21.3 に切り替えて、gasho-daemon を動かし直します。")).toBeTruthy();
  expect(within(dialog).queryByRole("link")).toBeNull();
  await user.click(within(dialog).getByRole("button", { name: "戻す" }));
  expect(hub.commands().at(-1)).toMatchObject({ type: "daemon.update", version: "0.21.3" });
  await hub.answer({ ok: false, error: "別の更新が進んでいます。" });
  expect(within(dialog).getByText("別の更新が進んでいます。")).toBeTruthy();
});

test("a working server that does not come back after its restart says where to look", async () => {
  await connectHub({
    machines: [linux({ connected: false, update: { canUpdate: true, progress: { version: "0.22.0", step: "restart", at: Date.now() - 3 * 60_000 } } })],
    latest,
    server,
  });
  render(<DaemonUpdates />);
  expect(within(row("Linux")).getByText(/0.22.0 に更新しています：切り替えて、動かし直しています/)).toBeTruthy();
  expect(within(row("Linux")).getByText(/2分以上たっても、つながりません/)).toBeTruthy();
  expect(within(row("Linux")).queryByRole("button")).toBeNull();
});

test("a gasho-daemon that cannot be updated from Gasho shows the command that makes it updatable", async () => {
  await connectHub({ machines: [linux({ update: undefined })], latest, server });
  render(<DaemonUpdates />);
  expect(within(row("Linux")).getByText(/Gasho からは更新できません/)).toBeTruthy();
  expect(within(row("Linux")).getByRole("button", { name: "npx @4rtofl/gasho-daemon@latest service install" })).toBeTruthy();
  expect(within(row("Linux")).queryByRole("button", { name: /に更新/ })).toBeNull();
});

test("the Gasho server is updated through its own message, and the latest versions are looked up again on request", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [], latest, server });
  render(<DaemonUpdates />);
  expect(screen.getByText(/公開されている最新のバージョン：Gasho サーバー 0.8.0・gasho-daemon 0.22.0/)).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "今すぐ調べる" }));
  expect(hub.sent.at(-1)).toEqual({ type: "latest.check" });

  await user.click(within(row("Gasho サーバー")).getByRole("button", { name: "0.8.0 に更新" }));
  const dialog = screen.getByRole("alertdialog", { name: "Gasho サーバーを 0.8.0 に更新しますか？" });
  await user.click(within(dialog).getByRole("button", { name: "更新する" }));
  expect(hub.sent.at(-1)).toMatchObject({ type: "hub.update", version: "0.8.0" });
  await hub.answer({ ok: true });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("a working server's row says whether Codex can be used, and what to do when it cannot", async () => {
  await connectHub({
    machines: [
      linux({ agents: { codex: { status: "available", version: "0.170.0" } } }),
      machine("login", [], { name: "Login", daemonVersion: "0.30.0", agents: { codex: { status: "loginRequired", version: "0.170.0" } } }),
      machine("old", [], { name: "Old", daemonVersion: "0.30.0", agents: { codex: { status: "available", version: "0.169.9" } } }),
      machine("unknown", [], { name: "Unknown", daemonVersion: "0.30.0", agents: { codex: { status: "unknown" } } }),
    ],
    latest,
    server,
  });
  render(<DaemonUpdates />);

  expect(within(row("Linux")).getByText("Codex 0.170.0").parentElement?.textContent).toBe("Codex 0.170.0：使えます");
  expect(within(row("Linux")).queryByText(/より古いバージョンです/)).toBeNull();
  expect(within(row("Linux")).queryByRole("button", { name: "codex login" })).toBeNull();

  expect(within(row("Login")).getByText("Codex 0.170.0").parentElement?.textContent).toBe("Codex 0.170.0：ログインしていません");
  expect(within(row("Login")).getByText("codex login")).toBeTruthy();

  expect(within(row("Old")).getByText("Gasho で確かめた版（0.170.0）より古いバージョンです。")).toBeTruthy();

  expect(within(row("Unknown")).getByText("Codex").parentElement?.textContent).toBe("Codex：状態を確かめられませんでした");
});

test("a working server without Codex, or offline, says nothing about it", async () => {
  await connectHub({
    machines: [
      linux({ agents: {} }),
      machine("older", [], { name: "Older", daemonVersion: "0.29.0" }),
      machine("offline", [], { name: "Offline", daemonVersion: "0.30.0", connected: false, agents: { codex: { status: "available", version: "0.170.0" } } }),
    ],
    latest,
    server,
  });
  render(<DaemonUpdates />);
  for (const name of ["Linux", "Older", "Offline"]) expect(within(row(name)).queryByText(/^Codex/)).toBeNull();
});
