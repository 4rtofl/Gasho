import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TranscriptBlock, TranscriptEntry } from "@gasho/protocol";
import { expect, test, vi } from "vitest";
import { Transcript } from "@/components/transcript";
import type { PendingMessage } from "@/lib/pending";
import type { TranscriptState } from "@/lib/store";

let n = 0;
const entry = (role: TranscriptEntry["role"], blocks: TranscriptBlock[], extra: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
  uuid: `u${++n}`,
  role,
  blocks,
  ...extra,
});
const said = (role: TranscriptEntry["role"], text: string) => entry(role, [{ type: "text", text }]);
const call = (id: string, name: string, input: object): TranscriptBlock => ({ type: "tool_use", id, name, input: JSON.stringify(input) });
const result = (toolUseId: string, content: string, isError = false): TranscriptEntry => entry("user", [{ type: "tool_result", toolUseId, content, isError }]);

const loaded = (entries: TranscriptEntry[], extra: Partial<TranscriptState> = {}): TranscriptState => ({
  entries,
  start: 0,
  total: entries.length,
  loading: false,
  ...extra,
});

/** The fold whose summary has `text`. */
function fold(text: string | RegExp): HTMLDetailsElement {
  const summary = screen.getAllByText(text).map((e) => e.closest("summary")).find(Boolean);
  if (!summary?.parentElement) throw new Error(`no fold with ${text}`);
  return summary.parentElement as HTMLDetailsElement;
}

test("a tool call is shown with its result in one fold, and calls in a row are one fold that counts them and their errors", async () => {
  const user = userEvent.setup();
  const long = "x".repeat(5000);
  render(
    <Transcript
      state={loaded([
        said("user", "テストを流して"),
        entry("assistant", [call("t1", "Bash", { command: "npm test" })]),
        result("t1", long),
        said("assistant", "ビルドもします。"),
        entry("assistant", [call("t2", "Read", { file_path: "/repo/a.ts" }), call("t3", "Bash", { command: "npm run build" })]),
        result("t2", "中身"),
        result("t3", "ビルドに失敗しました", true),
        said("assistant", "終わりました。"),
      ])}
      onLoadOlder={() => {}}
    />,
  );

  // One call alone: its input and its whole result (long ones are not cut), with how long it is.
  const single = fold("npm test");
  expect(within(single).getByText("Bash")).toBeTruthy();
  expect(within(single).getByText("結果（5,000 文字）")).toBeTruthy();
  expect(within(single).getByText(long)).toBeTruthy();
  expect(screen.getAllByText(long)).toHaveLength(1);

  // Two calls in a row: the latest is named, and the failed one is counted.
  const group = fold("ツール 2 回");
  expect(within(group).getByText("エラー 1 回")).toBeTruthy();
  expect(within(group.querySelector("summary")!).getByText("npm run build")).toBeTruthy();
  await user.click(group.querySelector("summary")!);
  expect(group.open).toBe(true);
  const failed = fold("npm run build");
  expect(within(failed).getByText("エラー（10 文字）")).toBeTruthy();
  expect(within(failed).getByText("ビルドに失敗しました")).toBeTruthy();
  expect(screen.getByText("終わりました。")).toBeTruthy();
});

test("a result whose call is on an older page is shown on its own, and a call without its result says so", () => {
  render(
    <Transcript
      state={loaded([result("old", "前のページの結果"), entry("assistant", [call("t9", "Grep", { pattern: "TODO" })])], { start: 40, total: 42, loading: true })}
      onLoadOlder={() => {}}
    />,
  );
  expect(within(fold("結果（8 文字）")).getByText("前のページの結果")).toBeTruthy();
  expect(within(fold("TODO")).getByText("（まだありません）")).toBeTruthy();
});

test("files sent from Gasho are shown as chips by their names, and the text around them as typed", () => {
  render(
    <Transcript
      state={loaded([said("user", "これを見て\n@/home/me/.cache/gasho/attachments/abc/20261118T010203-1-report.pdf\n  よろしく")])}
      onLoadOlder={() => {}}
    />,
  );
  expect(screen.getByText("report.pdf").closest("[title]")?.getAttribute("title")).toBe("/home/me/.cache/gasho/attachments/abc/20261118T010203-1-report.pdf");
  expect(screen.getByText("これを見て")).toBeTruthy();
  expect(screen.getByText("  よろしく", { normalizer: (s) => s })).toBeTruthy();
});

test("older pages are asked for one at a time while near the top, and when one fails it says why and can be asked again", async () => {
  const user = userEvent.setup();
  const onLoadOlder = vi.fn();
  const entries = [said("user", "こんにちは"), said("assistant", "はい")];
  const { rerender } = render(<Transcript state={loaded(entries, { start: 80, total: 82 })} onLoadOlder={onLoadOlder} />);
  expect(onLoadOlder).toHaveBeenCalledTimes(1);

  rerender(<Transcript state={loaded(entries, { start: 80, total: 82, loading: true })} onLoadOlder={onLoadOlder} />);
  expect(screen.getByText("前の会話を読み込んでいます…")).toBeTruthy();
  expect(onLoadOlder).toHaveBeenCalledTimes(1);

  rerender(<Transcript state={loaded(entries, { start: 80, total: 82, error: "working server がオフラインです" })} onLoadOlder={onLoadOlder} />);
  expect(screen.getByText("会話を読み込めませんでした：working server がオフラインです")).toBeTruthy();
  expect(onLoadOlder).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "もう一度" }));
  expect(onLoadOlder).toHaveBeenCalledTimes(2);
});

test("the start of a conversation asks for nothing older", () => {
  const onLoadOlder = vi.fn();
  render(<Transcript state={loaded([said("user", "最初の発言")])} onLoadOlder={onLoadOlder} />);
  expect(onLoadOlder).not.toHaveBeenCalled();
});

test("messages sent from here come after the conversation, with how far they have got", () => {
  const pending: PendingMessage[] = [
    { id: "p1", text: "次はこれ", files: ["memo.txt"], after: 1, at: 0, state: "queued" },
    { id: "p2", text: "!git status", files: [], after: 1, at: 0, state: "sent" },
  ];
  render(<Transcript state={loaded([said("assistant", "作業中です")])} pending={pending} onLoadOlder={() => {}} />);
  const text = screen.getByText("次はこれ");
  expect(screen.getByText("作業中です").compareDocumentPosition(text) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("memo.txt")).toBeTruthy();
  expect(screen.getByText("送信待ち（作業が終わったら送ります）")).toBeTruthy();
  // A shell command is shown as one, running until the conversation records it.
  expect(screen.getByLabelText("シェルのコマンド")).toBeTruthy();
  expect(screen.getByText("git status")).toBeTruthy();
  expect(screen.getByText("実行中…")).toBeTruthy();
});

test("an empty conversation says so, unless a message was just sent to it", () => {
  const { rerender } = render(<Transcript state={loaded([])} onLoadOlder={() => {}} />);
  expect(screen.getByText("まだ会話がありません")).toBeTruthy();
  rerender(<Transcript state={loaded([])} pending={[{ id: "p1", text: "始めて", files: [], after: 0, at: 0, state: "sending" }]} onLoadOlder={() => {}} />);
  expect(screen.queryByText("まだ会話がありません")).toBeNull();
  expect(screen.getByText("送信中…")).toBeTruthy();
});
