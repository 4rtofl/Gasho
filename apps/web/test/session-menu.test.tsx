import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MachineInfo } from "@gasho/protocol";
import { beforeEach, expect, test, vi } from "vitest";
import { SessionActionDialog, SessionContextMenu, type SessionActionRequest } from "@/components/session-menu";
import { connectHub, machine, session } from "./hub";

beforeEach(() => {
  location.hash = "";
});

const tab = session("s1", { name: "API の修正", startedAt: 1 });
const next = session("s2", { name: "テスト", startedAt: 2 });
const mac = (extra: Partial<MachineInfo> = {}) => machine("mac", [tab, next], { name: "Mac", daemonVersion: "0.21.4", canLaunch: true, canResume: true, ...extra });

function menu(m: MachineInfo) {
  const onPick = vi.fn<(r: SessionActionRequest) => void>();
  render(
    <SessionContextMenu machine={m} session={tab} onPick={onPick}>
      <button type="button">API の修正</button>
    </SessionContextMenu>,
  );
  return onPick;
}

test("the menu of a session's tab opens with a right-click and picks what to do with the session", async () => {
  const user = userEvent.setup();
  const onPick = menu(mac());
  await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "API の修正" }) });
  await user.click(screen.getByRole("menuitem", { name: "フォーク…" }));
  expect(onPick).toHaveBeenCalledWith({ action: "fork", machine: expect.objectContaining({ id: "mac" }), session: tab });
});

test.each([
  ["an offline working server", { connected: false }, "Mac はオフラインです。"],
  ["a gasho-daemon older than 0.9.0", { daemonVersion: "0.8.3" }, "Mac の gasho-daemon を 0.9.0 以上に更新すると使えます。"],
])("nothing can be done to a session of %s, and the menu says why", async (_, extra, why) => {
  const user = userEvent.setup();
  menu(mac(extra));
  await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "API の修正" }) });
  for (const name of ["名前を変更…", "フォーク…", "削除…"]) expect(screen.getByRole("menuitem", { name }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText(why)).toBeTruthy();
});

test("a session of a working server that cannot start sessions cannot be forked", async () => {
  const user = userEvent.setup();
  menu(mac({ canLaunch: false }));
  await user.pointer({ keys: "[MouseRight]", target: screen.getByRole("button", { name: "API の修正" }) });
  expect(screen.getByRole("menuitem", { name: "フォーク…" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("menuitem", { name: "名前を変更…" }).getAttribute("aria-disabled")).toBeNull();
});

test("a rename waits for its answer with the dialog open, and shows what Claude Code said about it", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [mac()] });
  const onClose = vi.fn();
  render(<SessionActionDialog request={{ action: "rename", machine: mac(), session: tab }} onClose={onClose} />);

  const field = screen.getByRole<HTMLInputElement>("textbox", { name: "名前" });
  expect(field.value).toBe("API の修正");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "変更する" }).disabled).toBe(true);
  await user.clear(field);
  await user.type(field, "  API の直し  ");
  await user.click(screen.getByRole("button", { name: "変更する" }));
  expect(hub.commands().at(-1)).toMatchObject({ type: "session.rename", machine: "mac", sessionId: "s1", name: "API の直し" });

  // Escape does not close it while the answer is still to come.
  await user.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "変更しています…" })).toBeTruthy();

  await hub.answer({ ok: true, warning: "作業が終わってから /rename を送ります。" });
  expect(screen.getByText("名前を変えました。")).toBeTruthy();
  expect(screen.getByText("作業が終わってから /rename を送ります。")).toBeTruthy();
  expect(onClose).not.toHaveBeenCalled();
});

test("a fork is named after the session, and opens once it has started", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [mac()] });
  const onClose = vi.fn();
  render(<SessionActionDialog request={{ action: "fork", machine: mac(), session: tab }} onClose={onClose} />);

  expect(screen.getByRole<HTMLInputElement>("textbox").value).toBe("API の修正 のフォーク");
  await user.click(screen.getByRole("button", { name: "フォークする" }));
  expect(hub.commands().at(-1)).toMatchObject({ type: "session.fork", sessionId: "s1", name: "API の修正 のフォーク" });
  await hub.answer({ ok: false, error: "Claude Code を起動できませんでした。" });
  expect(screen.getByText("Claude Code を起動できませんでした。")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "フォークする" }));
  await hub.answer({ ok: true, sessionId: "s9" });
  expect(location.hash).toBe("#/s/mac/s9");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("removing the open session opens the tab next to it, and the dialog tells about work it would stop", async () => {
  const user = userEvent.setup();
  // The session started working after its menu was opened.
  const hub = await connectHub({ machines: [machine("mac", [{ ...tab, status: "busy", pendingInputs: 2 }, next], { name: "Mac", daemonVersion: "0.21.4", canResume: true })] });
  location.hash = "#/s/mac/s1";
  const onClose = vi.fn();
  render(<SessionActionDialog request={{ action: "remove", machine: mac(), session: tab }} onClose={onClose} />);

  expect(screen.getByText(/作業の途中で止まります。送信待ちの 2 件は送りません。/)).toBeTruthy();
  expect(screen.getByText(/過去の会話から開き直せます/)).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "削除する" }));
  expect(hub.commands().at(-1)).toMatchObject({ type: "session.remove", machine: "mac", sessionId: "s1" });
  expect(screen.getByRole("button", { name: "削除しています…" })).toBeTruthy();

  await hub.answer({ ok: true });
  expect(location.hash).toBe("#/s/mac/s2");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a session that cannot be removed stays, with why", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [mac()] });
  location.hash = "#/s/mac/s1";
  const onClose = vi.fn();
  render(<SessionActionDialog request={{ action: "remove", machine: mac(), session: tab }} onClose={onClose} />);
  await user.click(screen.getByRole("button", { name: "削除する" }));
  await hub.answer({ ok: false, error: "Claude Code が終わりませんでした。" });
  expect(screen.getByText("Claude Code が終わりませんでした。")).toBeTruthy();
  expect(location.hash).toBe("#/s/mac/s1");
  expect(onClose).not.toHaveBeenCalled();
});
