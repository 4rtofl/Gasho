import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AgentKind, PermissionRequestInfo } from "@gasho/protocol";
import { afterEach, expect, test, vi } from "vitest";
import { PermissionRequests } from "@/components/permission-card";
import { connectHub, machine, session } from "./hub";

afterEach(() => {
  vi.useRealTimers();
});

const request = (extra: Partial<PermissionRequestInfo> = {}): PermissionRequestInfo => ({
  id: "perm-1",
  toolName: "Bash",
  input: '{\n  "command": "npm test"\n}',
  summary: "npm test",
  at: 0,
  ...extra,
});

function show(r: PermissionRequestInfo, connected = true, agent?: AgentKind) {
  const s = session("s1", { agent, status: "waiting", permissionRequests: [r] });
  return render(<PermissionRequests machine={machine("m1", [s], { connected })} session={s} />);
}

test("a permission is answered for the session's request, and the card waits for the answer without taking another", async () => {
  const user = userEvent.setup();
  const hub = await connectHub();
  show(request({ always: "Bash(npm test:*)" }));

  await user.click(screen.getByRole("button", { name: "今後も許可（Bash(npm test:*)）" }));
  expect(hub.commands()).toEqual([
    expect.objectContaining({ type: "permission.answer", machine: "m1", sessionId: "s1", permissionId: "perm-1", decision: "always" }),
  ]);
  expect(screen.getByRole("button", { name: "送信中…" })).toBeTruthy();
  for (const name of ["許可", "拒否"]) expect(screen.getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(true);

  // Refused by the working server: it says why, and the request can be answered again.
  await hub.answer({ ok: false, error: "この確認は、もう終わっています。" });
  expect(screen.getByText("この確認は、もう終わっています。")).toBeTruthy();
  await user.click(screen.getByRole("button", { name: "拒否" }));
  expect(hub.commands().at(-1)).toMatchObject({ permissionId: "perm-1", decision: "deny" });
});

test("Codex's deny button explains that Codex responds to the denial", () => {
  show(request(), true, "codex");
  expect(screen.getByRole("button", { name: "拒否" }).getAttribute("title")).toBe("Codex に拒否を伝えます。Codex は、拒否されたことを受けて応答します");
});

test("allow from now on is offered only when Claude Code suggests a rule for it", async () => {
  await connectHub();
  show(request());
  expect(screen.getByRole("button", { name: "許可" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /今後も許可/ })).toBeNull();
});

test("a request of an offline working server cannot be answered", async () => {
  await connectHub();
  show(request({ always: "Bash(npm test:*)" }), false);
  for (const b of screen.getAllByRole<HTMLButtonElement>("button")) expect(b.disabled).toBe(true);
});

test("a question from a gasho-daemon that cannot pass answers on is only stopped, not allowed", async () => {
  await connectHub();
  show(request({ toolName: "AskUserQuestion", summary: undefined }));
  expect(screen.getByText(/Gasho からは答えられません/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "許可" })).toBeNull();
  expect(screen.getByRole("button", { name: "答えずに止める" })).toBeTruthy();
});

test("Claude's questions are answered once each has an option or words of one's own", async () => {
  const user = userEvent.setup();
  const hub = await connectHub();
  show(
    request({
      toolName: "AskUserQuestion",
      questions: [
        { question: "どの方式にしますか？", header: "方式", options: [{ label: "A 案" }, { label: "B 案", preview: "B のサンプル" }] },
        { question: "どれを足しますか？", header: "追加", multiSelect: true, options: [{ label: "テスト" }, { label: "文書" }, { label: "型" }] },
      ],
    }),
  );
  const answer = screen.getByRole<HTMLButtonElement>("button", { name: "回答する" });
  expect(answer.disabled).toBe(true);

  await user.click(screen.getByRole("radio", { name: "B 案" }));
  // A chosen option's preview is shown under the question.
  expect(screen.getByText("B のサンプル")).toBeTruthy();
  // Writing an answer of one's own chooses it instead of the option (a question that takes one).
  await user.type(screen.getByRole("textbox", { name: "方式：自分の言葉で答える" }), "C 案");
  expect(screen.getByRole<HTMLInputElement>("radio", { name: "B 案" }).checked).toBe(false);
  expect(answer.disabled).toBe(true);

  // Several options of a question that takes several, kept in their order.
  await user.click(screen.getByRole("checkbox", { name: "型" }));
  await user.click(screen.getByRole("checkbox", { name: "テスト" }));
  expect(answer.disabled).toBe(false);
  await user.click(answer);
  expect(hub.commands().at(-1)).toMatchObject({
    type: "permission.answer",
    decision: "allow",
    answers: [
      { picked: [], text: "C 案" },
      { picked: [0, 2] },
    ],
  });
});

test("words of one's own are sent with ⌘/Ctrl+Enter once every question has an answer, and Enter adds a line", async () => {
  const user = userEvent.setup();
  const hub = await connectHub();
  show(
    request({
      toolName: "AskUserQuestion",
      questions: [
        { question: "どの方式にしますか？", header: "方式", options: [{ label: "A 案" }] },
        { question: "どれを足しますか？", header: "追加", options: [{ label: "テスト" }] },
      ],
    }),
  );
  const field = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "方式：自分の言葉で答える" });
  await user.type(field, "C 案{Enter}も");
  expect(field.value).toBe("C 案\nも");
  // The second question has no answer yet, as when 回答する cannot be pressed.
  await user.keyboard("{Meta>}{Enter}{/Meta}");
  expect(hub.commands()).toEqual([]);

  await user.click(screen.getByRole("radio", { name: "テスト" }));
  // The Enter that ends a conversion: Chrome sends it while composing, Safari after, with keyCode 229.
  fireEvent.keyDown(field, { key: "Enter", metaKey: true, isComposing: true });
  fireEvent.keyDown(field, { key: "Enter", ctrlKey: true, keyCode: 229 });
  expect(hub.commands()).toEqual([]);

  await user.click(field);
  await user.keyboard("{Control>}{Enter}{/Control}");
  expect(hub.commands()).toEqual([
    expect.objectContaining({ decision: "allow", answers: [{ picked: [], text: "C 案\nも" }, { picked: [0] }] }),
  ]);
  // Not again while it is being sent.
  fireEvent.keyDown(field, { key: "Enter", metaKey: true });
  expect(hub.commands()).toHaveLength(1);
});

test("a question answered waits to leave, and can be answered again if it is still there after a while", async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const hub = await connectHub();
  show(request({ toolName: "AskUserQuestion", answerAsMessage: true, questions: [{ question: "進めますか？", options: [{ label: "はい" }] }] }));
  expect(screen.getByText(/Gasho から直接は答えられません/)).toBeTruthy();

  await user.click(screen.getByRole("radio", { name: "はい" }));
  await user.click(screen.getByRole("button", { name: "回答する" }));
  await hub.answer({ ok: true });
  expect(screen.getByText("送りました")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "回答する" }).disabled).toBe(true);

  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(screen.queryByText("送りました")).toBeNull();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "回答する" }).disabled).toBe(false);
});

test("a plan is approved in the mode chosen, or sent back with what to change", async () => {
  const user = userEvent.setup();
  const hub = await connectHub();
  show(request({ id: "plan-1", toolName: "ExitPlanMode", plan: "## 計画\n\n1. テストを足す" }));
  expect(screen.getByRole("heading", { name: "計画" })).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "はい、編集はその都度承認する" }));
  expect(hub.commands().at(-1)).toMatchObject({ permissionId: "plan-1", decision: "allow", mode: "default" });
  await hub.answer({ ok: false, error: "送れませんでした。" });

  await user.click(screen.getByRole("button", { name: "直してほしいところを伝える" }));
  const send = screen.getByRole<HTMLButtonElement>("button", { name: "送る" });
  expect(send.disabled).toBe(true);
  const field = screen.getByRole("textbox", { name: "計画の直してほしいところ" });
  // Nothing written: nothing to send, as with 送る.
  await user.keyboard("{Meta>}{Enter}{/Meta}");
  expect(hub.commands()).toHaveLength(1);
  await user.type(field, "  テストを先に書く  ");
  await user.click(send);
  expect(hub.commands().at(-1)).toMatchObject({ permissionId: "plan-1", decision: "deny", message: "テストを先に書く" });

  await hub.answer({ ok: false, error: "送れませんでした。" });
  await user.type(field, "{Enter}型も足す");
  await user.keyboard("{Meta>}{Enter}{/Meta}");
  expect(hub.commands()).toHaveLength(3);
  expect(hub.commands().at(-1)).toMatchObject({ permissionId: "plan-1", decision: "deny", message: "テストを先に書く  \n型も足す" });
});
