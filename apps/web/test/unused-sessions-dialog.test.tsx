import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CommandResult, MachineInfo } from "@gasho/protocol";
import { afterEach, beforeEach, expect, test } from "vitest";
import { UnusedSessionsDialog } from "@/components/unused-sessions-dialog";
import { showNotice } from "@/lib/notice";
import { useSessionLauncher, type LaunchInput, type LaunchOutcome } from "@/lib/session-launch";
import { UNUSED_AFTER_MS } from "@/lib/unused-sessions";
import { connectHub, machine, session, type Hub, type SentCommand } from "./hub";

// Answers are remembered per working server for the page's life, so each test has a server of its own.
let serial = 0;
let id = "";
const lastWeek = () => Date.now() - 7 * UNUSED_AFTER_MS;
const server = (extra: Partial<MachineInfo> = {}) =>
  machine(
    id,
    [
      session("old-1", { name: "API の修正", cwd: "/repo/api", lastActivityAt: lastWeek() }),
      session("old-2", { name: "画面の直し", cwd: "/repo/web", lastActivityAt: lastWeek() }),
      session("new", { name: "今の作業", lastActivityAt: Date.now() }),
    ],
    { name: "Mac", daemonVersion: "0.24.0", canLaunch: true, canResume: true, ...extra },
  );

beforeEach(() => {
  localStorage.clear();
  location.hash = "";
  showNotice(undefined);
  id = `mac-${++serial}`;
});

// The question lives outside the screen: one left open would stand in front of the next test's.
afterEach(async () => {
  const cancel = screen.queryByRole("button", { name: "キャンセル" });
  if (cancel) await userEvent.click(cancel);
});

let launch: ReturnType<typeof useSessionLauncher>;
function Screen() {
  launch = useSessionLauncher();
  return <UnusedSessionsDialog />;
}

async function open(m = server()) {
  const hub = await connectHub({ machines: [m] });
  render(<Screen />);
  return hub;
}

/** Starts a launch and gives what it comes to. */
function start(input: LaunchInput = { cwd: "/repo" }, options?: { fromPlugin?: boolean }) {
  const done: { outcome?: LaunchOutcome } = {};
  act(() => {
    void launch(id, input, options).then((outcome) => {
      done.outcome = outcome;
    });
  });
  return done;
}

const ofType = (hub: Hub, type: SentCommand["type"]) => hub.commands().filter((c) => c.type === type);
const OK: CommandResult = { ok: true, sessionId: "started" };

/** Answers the commands still open, in the order they were sent. */
async function answerAll(hub: Hub, commands: SentCommand[], result: (c: SentCommand) => CommandResult = () => ({ ok: true })) {
  for (const c of commands) await hub.answer(result(c), c);
}

test("with no unused session nothing is asked and the session starts", async () => {
  const hub = await open(machine(id, [session("new", { lastActivityAt: Date.now() })], { daemonVersion: "0.24.0" }));
  const done = start({ cwd: "/repo" });
  await waitFor(() => expect(ofType(hub, "session.launch")).toHaveLength(1));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await hub.answer(OK, ofType(hub, "session.launch")[0]);
  await waitFor(() => expect(done.outcome).toMatchObject(OK));
});

test("the dialog lists the unused sessions, all picked, and says that the conversations stay", async () => {
  const hub = await open();
  start();
  const dialog = await screen.findByRole("alertdialog", { name: "未使用のセッションを削除しますか？" });
  expect(ofType(hub, "session.launch")).toHaveLength(0);
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /API の修正/ }).checked).toBe(true);
  expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /画面の直し/ }).checked).toBe(true);
  expect(screen.queryByRole("checkbox", { name: /今の作業/ })).toBeNull();
  expect(dialog.textContent).toContain("/repo/api");
  expect(dialog.textContent).toContain("最後の活動：7 日前");
  expect(dialog.textContent).toContain("削除しても会話は残り、あとから過去の会話を開いて再開できます。");
});

test("only the sessions picked are removed, and then the session starts", async () => {
  const user = userEvent.setup();
  const hub = await open();
  const done = start();
  await user.click(await screen.findByRole("checkbox", { name: /画面の直し/ }));
  await user.click(screen.getByRole("button", { name: "削除して起動" }));

  await waitFor(() => expect(ofType(hub, "session.remove")).toHaveLength(1));
  expect(ofType(hub, "session.remove")[0]).toMatchObject({ sessionId: "old-1" });
  // The session starts once the removal has been answered.
  expect(ofType(hub, "session.launch")).toHaveLength(0);
  await answerAll(hub, ofType(hub, "session.remove"));
  await waitFor(() => expect(ofType(hub, "session.launch")).toHaveLength(1));
  await hub.answer(OK, ofType(hub, "session.launch")[0]);
  await waitFor(() => expect(done.outcome).toMatchObject(OK));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("nothing can be removed with no session picked", async () => {
  const user = userEvent.setup();
  await open();
  start();
  await user.click(await screen.findByRole("checkbox", { name: /API の修正/ }));
  await user.click(screen.getByRole("checkbox", { name: /画面の直し/ }));
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "削除して起動" }).disabled).toBe(true);
});

test("a session that could not be removed is told about, and the session still starts", async () => {
  const user = userEvent.setup();
  const hub = await open();
  let notice: string | undefined;
  const { useNotice } = await import("@/lib/notice");
  function Notice() {
    notice = useNotice();
    return null;
  }
  render(<Notice />);
  start();
  await user.click(await screen.findByRole("button", { name: "削除して起動" }));
  await waitFor(() => expect(ofType(hub, "session.remove")).toHaveLength(2));
  await answerAll(hub, ofType(hub, "session.remove"), (c) =>
    c.type === "session.remove" && c.sessionId === "old-1" ? { ok: false, error: "終了できませんでした" } : { ok: true },
  );
  await waitFor(() => expect(ofType(hub, "session.launch")).toHaveLength(1));
  expect(notice).toContain("「API の修正」：終了できませんでした");
  expect(notice).not.toContain("画面の直し");
});

test("a session put to use while the dialog is open is not removed", async () => {
  const user = userEvent.setup();
  const hub = await open();
  start();
  await screen.findByRole("alertdialog");
  const m = server();
  await hub.say({ type: "machine", machine: { ...m, sessions: m.sessions.map((s) => (s.sessionId === "old-1" ? { ...s, status: "busy" as const } : s)) } });
  await user.click(screen.getByRole("button", { name: "削除して起動" }));
  await waitFor(() => expect(ofType(hub, "session.remove")).toHaveLength(1));
  expect(ofType(hub, "session.remove")[0]).toMatchObject({ sessionId: "old-2" });
  await answerAll(hub, ofType(hub, "session.remove"));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

test("cancelling starts nothing and removes nothing", async () => {
  const user = userEvent.setup();
  const hub = await open();
  const done = start();
  await user.click(await screen.findByRole("button", { name: "キャンセル" }));
  await waitFor(() => expect(done.outcome).toMatchObject({ ok: false, cancelled: true }));
  expect(ofType(hub, "session.launch")).toHaveLength(0);
  expect(ofType(hub, "session.remove")).toHaveLength(0);
});

test("a person who cancelled is asked again the next time", async () => {
  const user = userEvent.setup();
  await open();
  start();
  await user.click(await screen.findByRole("button", { name: "キャンセル" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  start();
  expect(await screen.findByRole("alertdialog")).toBeTruthy();
});

test("starting without removing keeps the question away on that working server", async () => {
  const user = userEvent.setup();
  const hub = await open();
  start();
  await user.click(await screen.findByRole("button", { name: "削除せずに起動" }));
  await waitFor(() => expect(ofType(hub, "session.launch")).toHaveLength(1));
  expect(ofType(hub, "session.remove")).toHaveLength(0);
  expect(JSON.parse(localStorage.getItem("gasho.unusedSessions.keptUntil") ?? "{}")[id]).toBeGreaterThan(Date.now());

  start({ cwd: "/repo/second" });
  await waitFor(() => expect(ofType(hub, "session.launch")).toHaveLength(2));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("launches that come while the dialog is open wait for the one answer", async () => {
  const user = userEvent.setup();
  const hub = await open();
  start({ cwd: "/repo/a" }, { fromPlugin: true });
  await screen.findByRole("alertdialog");
  start({ cwd: "/repo/b" }, { fromPlugin: true });
  start({ cwd: "/repo/c" }, { fromPlugin: true });
  await act(async () => {});
  expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  expect(ofType(hub, "session.launch")).toHaveLength(0);

  await user.click(screen.getByRole("button", { name: "削除せずに起動" }));
  await waitFor(() => expect(ofType(hub, "session.launch")).toHaveLength(3));
});

test("a plugin that starts sessions one after the other is asked about once", async () => {
  const user = userEvent.setup();
  const hub = await open();
  const first = start({ cwd: "/repo/a" }, { fromPlugin: true });
  await user.click(await screen.findByRole("checkbox", { name: /画面の直し/ }));
  await user.click(screen.getByRole("button", { name: "削除して起動" }));
  await waitFor(() => expect(ofType(hub, "session.remove")).toHaveLength(1));
  await answerAll(hub, ofType(hub, "session.remove"));
  await waitFor(() => expect(ofType(hub, "session.launch")).toHaveLength(1));
  await hub.answer(OK, ofType(hub, "session.launch")[0]);
  await waitFor(() => expect(first.outcome).toMatchObject(OK));

  // "画面の直し" is still unused, but the answer holds for the next one of the list.
  start({ cwd: "/repo/b" }, { fromPlugin: true });
  await waitFor(() => expect(ofType(hub, "session.launch")).toHaveLength(2));
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

test("starting again after Claude Code asked to trust the folder asks nothing more", async () => {
  const user = userEvent.setup();
  const hub = await open();
  const first = start({ cwd: "/repo/new" });
  await user.click(await screen.findByRole("checkbox", { name: /画面の直し/ }));
  await user.click(screen.getByRole("button", { name: "削除して起動" }));
  await waitFor(() => expect(ofType(hub, "session.remove")).toHaveLength(1));
  await answerAll(hub, ofType(hub, "session.remove"));
  await waitFor(() => expect(ofType(hub, "session.launch")).toHaveLength(1));
  await hub.answer({ ok: false, needsTrust: true }, ofType(hub, "session.launch")[0]);
  await waitFor(() => expect(first.outcome).toMatchObject({ needsTrust: true }));

  start({ cwd: "/repo/new", trust: true });
  await waitFor(() => expect(ofType(hub, "session.launch")).toHaveLength(2));
  expect(ofType(hub, "session.launch")[1]).toMatchObject({ cwd: "/repo/new", trust: true });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});
