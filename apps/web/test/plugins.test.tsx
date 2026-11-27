import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FileContent, PluginInfo, TranscriptEntry } from "@gasho/protocol";
import { beforeEach, expect, test, vi } from "vitest";
import { MarkdownText } from "@/components/markdown";
import { Transcript } from "@/components/transcript";
import { answerSelection, answerText } from "@/lib/answer-selection";
import { PluginAnswerSelection, PluginConversationEnd, PluginHeaderItems, PluginPageView, PluginPanelView, PluginSettingsSections } from "@/plugins/parts";
import { FilePanel } from "@/views/files";
import { connectHub, machine, session } from "./hub";

beforeEach(() => {
  location.hash = "";
  localStorage.clear();
});

const info = (extra: Partial<PluginInfo> = {}): PluginInfo => ({
  id: "notes",
  manifest: {
    id: "notes",
    name: "メモ",
    version: "1.0.0",
    api: "1.10",
    web: { js: "web.js" },
    permissions: ["session.input"],
    settings: {
      shown: { label: "表示する", scope: "server", type: "boolean", default: false },
      limit: { label: "上限", scope: "server", type: "number", default: 3, min: 1 },
      mine: { label: "このブラウザーの名前", scope: "browser", type: "string", default: "" },
    },
  },
  dev: false,
  enabled: true,
  hash: "h1",
  // Served from apps/web as the Gasho server serves a plugin's files.
  web: { js: "/test/sample-plugin.ts" },
  values: { shown: true },
  shared: { count: 4 },
  ...extra,
});
const s1 = session("s1");
const m1 = machine("m1", [s1]);

test("a plugin's page is drawn once its web part has loaded, in an element of its own", async () => {
  await connectHub({ machines: [m1], plugins: [info()] });
  render(<PluginPageView plugin="notes" page="list" params={{ tag: "todo" }} />);
  expect(screen.getByText("読み込み中…")).toBeTruthy();
  const page = await screen.findByText("ページ todo");
  expect(page.closest("[data-gasho-plugin]")?.getAttribute("data-gasho-plugin")).toBe("notes");
  expect(screen.getByRole("heading", { name: "メモの一覧" })).toBeTruthy();
});

test("a page opened before the Gasho server's first snapshot is loading, not missing", async () => {
  render(<PluginPageView plugin="notes" page="list" params={{}} />);
  expect(screen.getByText("読み込み中…")).toBeTruthy();
  expect(screen.queryByText("このプラグインは、Gasho サーバーに入っていません。")).toBeNull();
  await connectHub({ machines: [m1], plugins: [] });
  expect(screen.getByText("このプラグインは、Gasho サーバーに入っていません。")).toBeTruthy();
});

test.each([
  ["a page the plugin does not have", [info()], "missing", "このページはありません。"],
  ["a disabled plugin", [info({ enabled: false })], "list", "メモ は無効になっています。"],
  ["a plugin that is not installed", [], "list", "このプラグインは、Gasho サーバーに入っていません。"],
  ["a plugin written for a newer screen", [info({ manifest: { ...info().manifest, api: "2.0" } })], "list", /この画面は対応していません/],
])("%s says so in the page's place", async (_, plugins, page, why) => {
  await connectHub({ machines: [m1], plugins });
  render(<PluginPageView plugin="notes" page={page} params={{}} />);
  expect(await screen.findByText(why)).toBeTruthy();
});

test("a header item opens the plugin's panel and shows as pressed while it is open, and one that fails says why", async () => {
  const user = userEvent.setup();
  await connectHub({ machines: [m1], plugins: [info()] });
  const { rerender } = render(<PluginHeaderItems machine={m1} session={s1} panel={undefined} from={-Infinity} to={Infinity} />);
  const notes = await screen.findByRole("button", { name: "メモ" });
  // `when` leaves out the item of a session without a name.
  expect(screen.queryByRole("button", { name: "名前あり" })).toBeNull();
  expect(notes.getAttribute("aria-pressed")).toBe("false");

  await user.click(notes);
  expect(location.hash).toBe("#/s/m1/s1/p/notes/notes");
  rerender(<PluginHeaderItems machine={m1} session={s1} panel={{ kind: "plugin", plugin: "notes", id: "notes", params: {} }} from={-Infinity} to={Infinity} />);
  expect(screen.getByRole("button", { name: "メモ" }).getAttribute("aria-pressed")).toBe("true");

  const named = session("s1", { name: "作業" });
  rerender(<PluginHeaderItems machine={m1} session={named} panel={undefined} from={-Infinity} to={Infinity} />);
  await user.click(screen.getByRole("button", { name: "名前あり" }));
  expect(await screen.findByText("押せませんでした")).toBeTruthy();
});

test("a panel reads the plugin's settings and shared values, and a shared value shows at once and goes back when refused", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [m1], plugins: [info()] });
  render(<PluginPanelView machine="m1" sessionId="s1" panel={{ kind: "plugin", plugin: "notes", id: "notes", params: {} }} docked onClose={() => {}} />);
  expect(await screen.findByText("表示する")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "数 4" }));
  expect(screen.getByRole("button", { name: "数 5" })).toBeTruthy();
  expect(hub.sent.at(-1)).toMatchObject({ type: "plugin.shared", plugin: "notes", key: "count", value: 5 });
  await hub.answer({ ok: false, error: "保存できませんでした。" });
  expect(screen.getByRole("button", { name: "数 4" })).toBeTruthy();
  expect(screen.getByText("保存できませんでした。")).toBeTruthy();
});

test("a plugin sends to a session only with the permission for it, and says it is the sender", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [m1], plugins: [info()] });
  const panel = <PluginPanelView machine="m1" sessionId="s1" panel={{ kind: "plugin", plugin: "notes", id: "notes", params: {} }} docked onClose={() => {}} />;
  const { unmount } = render(panel);
  await user.click(await screen.findByRole("button", { name: "続けてと送る" }));
  expect(hub.commands().at(-1)).toMatchObject({ type: "session.input", machine: "m1", sessionId: "s1", text: "続けて", via: "notes" });
  await hub.answer({ ok: true });
  expect(screen.getByText("送りました")).toBeTruthy();
  unmount();

  await hub.say({ type: "plugins", plugins: [info({ manifest: { ...info().manifest, permissions: [] } })] });
  const sent = hub.sent.length;
  render(panel);
  await user.click(screen.getByRole("button", { name: "続けてと送る" }));
  expect(screen.getByText("メモ には、セッションに発言を送る権限がありません（gasho-plugin.json の permissions）。")).toBeTruthy();
  expect(hub.sent).toHaveLength(sent);
});

test("a plugin hears that what it sent may have been typed when the connection closed before the result (API 1.17)", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [m1], plugins: [info()] });
  render(<PluginPanelView machine="m1" sessionId="s1" panel={{ kind: "plugin", plugin: "notes", id: "notes", params: {} }} docked onClose={() => {}} />);
  await user.click(await screen.findByRole("button", { name: "続けてと送る" }));
  hub.drop();
  expect(await screen.findByText("分からない：Gasho サーバーとの接続が切れたので、結果が分かりません。")).toBeTruthy();
});

test("a plugin hears that a method it called may have run when the connection closed before the result (API 1.17)", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [m1], plugins: [info()] });
  render(<PluginPanelView machine="m1" sessionId="s1" panel={{ kind: "plugin", plugin: "notes", id: "notes", params: {} }} docked onClose={() => {}} />);
  await user.click(await screen.findByRole("button", { name: "書く" }));
  expect(hub.sent.at(-1)).toMatchObject({ type: "plugin.request", plugin: "notes", machine: "m1", method: "save" });
  hub.drop();
  // The call ends once connected again: the Gasho server forgot it with the connection.
  await hub.reopen();
  expect(await screen.findByText("分からない：Gasho サーバーとの接続が切れたので、結果が分かりません。")).toBeTruthy();
});

test("a plugin switches the session's effort level with what it sends, and hears what was not switched (API 1.12)", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [m1], plugins: [info()] });
  render(<PluginPanelView machine="m1" sessionId="s1" panel={{ kind: "plugin", plugin: "notes", id: "notes", params: {} }} docked onClose={() => {}} />);
  const button = await screen.findByRole("button", { name: "Max で見直してと送る" });

  await user.click(button);
  expect(hub.commands().at(-1)).toMatchObject({ type: "session.input", sessionId: "s1", text: "見直して", effort: "max", via: "notes" });
  expect(hub.commands().at(-1)).not.toHaveProperty("model");
  expect(hub.commands().at(-1)).not.toHaveProperty("ultracode");
  await hub.answer({ ok: true, queued: true });
  expect(screen.getByText("送りました（待ち）")).toBeTruthy();

  await user.click(button);
  await hub.answer({ ok: true, warning: "Effort を Max にできませんでした。いまの Effort のまま送ります。", unapplied: ["effort"] });
  expect(screen.getByText("送りました（effort はそのまま：Effort を Max にできませんでした。いまの Effort のまま送ります。）")).toBeTruthy();
});

test("a plugin removes a session with the permission, naming itself, and the screen leaves that session (API 1.14)", async () => {
  const user = userEvent.setup();
  const withRemove = info({ manifest: { ...info().manifest, permissions: ["session.remove"] } });
  const hub = await connectHub({ machines: [m1], plugins: [withRemove] });
  location.hash = "#/s/m1/s1";
  render(<PluginPanelView machine="m1" sessionId="s1" panel={{ kind: "plugin", plugin: "notes", id: "notes", params: {} }} docked onClose={() => {}} />);
  await user.click(await screen.findByRole("button", { name: "このセッションを削除" }));
  expect(hub.commands().at(-1)).toMatchObject({ type: "session.remove", sessionId: "s1", via: "notes" });
  await hub.answer({ ok: true });
  expect(await screen.findByText("削除しました")).toBeTruthy();
  expect(location.hash).not.toBe("#/s/m1/s1");
});

test("a plugin hears why its launch failed", async () => {
  const user = userEvent.setup();
  const withLaunch = info({ manifest: { ...info().manifest, permissions: ["session.launch"] } });
  const hub = await connectHub({ machines: [machine("m-failed", [s1], { daemonVersion: "0.24.0" })], plugins: [withLaunch] });
  render(<PluginPanelView machine="m-failed" sessionId="s1" panel={{ kind: "plugin", plugin: "notes", id: "notes", params: {} }} docked onClose={() => {}} />);
  await user.click(await screen.findByRole("button", { name: "ここで起動" }));
  await hub.answer({ ok: false, error: "フォルダーがありません" });
  expect(await screen.findByText("フォルダーがありません")).toBeTruthy();
});

test("a plugin without the permission cannot remove a session, and one that fails hears why", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [m1], plugins: [info()] });
  render(<PluginPanelView machine="m1" sessionId="s1" panel={{ kind: "plugin", plugin: "notes", id: "notes", params: {} }} docked onClose={() => {}} />);
  const sent = hub.commands().length;
  await user.click(await screen.findByRole("button", { name: "このセッションを削除" }));
  expect(screen.getByText("メモ には、セッションを削除する権限がありません（gasho-plugin.json の permissions）。")).toBeTruthy();
  expect(hub.commands()).toHaveLength(sent);

  await hub.say({ type: "plugins", plugins: [info({ manifest: { ...info().manifest, permissions: ["session.remove"] } })] });
  await user.click(screen.getByRole("button", { name: "このセッションを削除" }));
  await hub.answer({ ok: false, error: "このセッションは削除できません。" });
  expect(await screen.findByText("このセッションは削除できません。")).toBeTruthy();
});

test("a part that throws shows an error in its place, and the session's other parts stay", async () => {
  await connectHub({ machines: [m1], plugins: [info()] });
  const boom = session("s1", { name: "boom" });
  render(
    <>
      <PluginConversationEnd machine={m1} session={boom} />
      <PluginHeaderItems machine={m1} session={boom} panel={undefined} from={-Infinity} to={Infinity} />
    </>,
  );
  expect(await screen.findByText(/メモ の表示でエラーが起きました。/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "もう一度" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "メモ" })).toBeTruthy();
});

const shot = (path: string): FileContent => ({ path, size: 120, mtime: 0, image: { mime: "image/png", data: "iVBORw0KGgo=" }, writable: true });

test("a plugin shows the files of its extensions in the file panel, with the entries of their folder, and opens another there (P20)", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [m1], plugins: [info()] });
  render(<FilePanel machine="m1" sessionId="s1" path="shots/a.png" docked onClose={() => {}} />);
  await hub.say({ type: "file", machine: "m1", sessionId: "s1", path: "shots/a.png", file: shot("shots/a.png") });
  expect(await screen.findByText("shots/a.png（120 バイト、s1）")).toBeTruthy();
  expect(screen.queryByRole("img", { name: "a.png" })).toBeNull();

  expect(hub.sent).toContainEqual({ type: "dir.get", machine: "m1", sessionId: "s1", path: "shots" });
  expect(screen.getByText("同じフォルダーを読み込み中")).toBeTruthy();
  const entries = [{ name: "old", kind: "dir" as const }, { name: "a.png", kind: "file" as const }, { name: "b.png", kind: "file" as const }];
  await hub.say({ type: "dir", machine: "m1", sessionId: "s1", path: "shots", dir: { path: "shots", entries, truncated: false } });
  expect(screen.getByText("同じフォルダー：a.png・b.png")).toBeTruthy();

  await user.click(screen.getByRole("button", { name: "次のファイル" }));
  expect(location.hash).toBe("#/s/m1/s1/file/shots/b.png");
});

test("the file panel shows a file as Gasho does when the plugin's view of it throws, and once the plugin is disabled (P20)", async () => {
  const hub = await connectHub({ machines: [m1], plugins: [info()] });
  const { unmount } = render(
    <>
      <PluginHeaderItems machine={m1} session={s1} panel={undefined} from={-Infinity} to={Infinity} />
      <FilePanel machine="m1" sessionId="s1" path="boom.png" docked onClose={() => {}} />
    </>,
  );
  await hub.say({ type: "file", machine: "m1", sessionId: "s1", path: "boom.png", file: shot("boom.png") });
  // Drawn once the plugin has loaded.
  await screen.findByRole("button", { name: "メモ" });
  expect(screen.getByRole("img", { name: "boom.png" })).toBeTruthy();
  unmount();

  render(<FilePanel machine="m1" sessionId="s1" path="a.png" docked onClose={() => {}} />);
  await hub.say({ type: "file", machine: "m1", sessionId: "s1", path: "a.png", file: shot("a.png") });
  expect(await screen.findByText("a.png（120 バイト、s1）")).toBeTruthy();
  await hub.say({ type: "plugins", plugins: [info({ enabled: false })] });
  expect(screen.getByRole("img", { name: "a.png" })).toBeTruthy();
  expect(screen.queryByText("a.png（120 バイト、s1）")).toBeNull();
});

/** The first text node in `root` that has `text`. */
function textNode(text: string, root: Node = document.body): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue?.includes(text)) return n as Text;
  throw new Error(`「${text}」がありません`);
}

/** A range over where `text` first is in its first text node in `root`. */
function rangeOf(text: string, root?: Node): Range {
  const node = textNode(text, root);
  const at = node.nodeValue!.indexOf(text);
  const range = document.createRange();
  range.setStart(node, at);
  range.setEnd(node, at + text.length);
  return range;
}

/** Selects `range` in the page, as a reader does. */
function select(range?: Range) {
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  if (range) selection.addRange(range);
  document.dispatchEvent(new Event("selectionchange"));
}

test("an answer's text is what the conversation shows, a line for each of its blocks, and a selection across its marks is found in it (P22)", () => {
  const answer = ["Gasho の **hub** が中継する。", "", "- 1 つ目", "- 2 つ目", "", "```ts", "const a = 1;", "```", "", "| 名前 | 数 |", "| --- | --- |", "| hub | 1 |"].join("\n");
  const { container } = render(
    <div data-answer="">
      <MarkdownText text={answer} />
    </div>,
  );
  const root = container.firstElementChild!;
  // Without the code block's language and its copy button.
  expect(answerText(root).text.trimEnd()).toBe("Gasho の hub が中継する。\n1 つ目\n2 つ目\nconst a = 1;\n名前\t数\nhub\t1");

  const range = document.createRange();
  range.setStart(textNode("Gasho の"), "Gasho ".length);
  range.setEnd(textNode("が中継する"), " が".length);
  const found = answerSelection(range, container);
  expect(found?.text).toBe("の hub が");
  expect(found && found.answer.slice(found.start, found.end)).toBe("の hub が");
  // From the code block's copy button: from the code block on.
  const code = document.createRange();
  code.setStart(textNode("コピー"), 0);
  code.setEnd(textNode("const a"), "const".length);
  expect(answerSelection(code, container)?.text).toBe("const");
  // White space only, and outside an answer: nothing.
  const space = document.createRange();
  space.setStart(textNode("Gasho の"), "Gasho".length);
  space.setEnd(textNode("Gasho の"), "Gasho ".length);
  expect(answerSelection(space, container)).toBeUndefined();
  expect(answerSelection(rangeOf("Gasho"), document.createElement("div"))).toBeUndefined();
});

const said = (uuid: string, role: TranscriptEntry["role"], text: string): TranscriptEntry => ({ uuid, role, blocks: [{ type: "text", text }] });

test("a plugin's part shows by text selected in Claude's answers, with the answer and where the text is in it, and not by what the user wrote (P22)", async () => {
  // The page has no layout here, so the popup is always out of view (hidden, with no names for a screen reader): it
  // is found by its mark and its text, and pressed all the same.
  const user = userEvent.setup({ pointerEventsCheck: 0 });
  const hub = await connectHub({ machines: [m1], plugins: [info()] });
  const entries = [said("u1", "user", "hub とは？"), said("a1", "assistant", "Gasho の **hub** が中継する。")];
  render(
    <Transcript
      state={{ entries, start: 0, total: 2, loading: false }}
      onLoadOlder={() => {}}
      selection={(selection, close) => <PluginAnswerSelection machine={m1} session={s1} selection={selection} onClose={close} />}
    />,
  );
  const answer = () => document.querySelector("[data-answer]")!;
  const popup = () => document.querySelector<HTMLElement>("[data-answer-selection]");

  // What the user wrote shows nothing.
  select(rangeOf("hub とは"));
  await new Promise((r) => setTimeout(r, 400));
  expect(popup()).toBeNull();

  select(rangeOf("hub", answer()));
  await waitFor(() => expect(popup()).toBeTruthy());
  const shown = popup()!;
  expect(shown.getAttribute("aria-label")).toBe("選んだ文");
  expect(within(shown).getByText("「hub」8〜11（本文のとおり、s1、s1）")).toBeTruthy();
  expect(within(shown).getByText("本文：Gasho の hub が中継する。")).toBeTruthy();
  // Pressing a button in it keeps it.
  await user.click(within(shown).getByText("意味"));
  expect(await within(shown).findByText("「hub」の意味")).toBeTruthy();
  await new Promise((r) => setTimeout(r, 400));
  expect(popup()).toBe(shown);
  // Pressing its text clears the selection, and keeps it too.
  await user.click(within(shown).getByText("「hub」の意味"));
  await new Promise((r) => setTimeout(r, 400));
  expect(document.getSelection()?.toString()).toBe("");
  expect(popup()).toBe(shown);
  // Another selection while it shows (a long press on a phone does not press outside it): the part is drawn anew.
  select(rangeOf("中継", answer()));
  expect(await screen.findByText("「中継」13〜15（本文のとおり、s1、s1）")).toBeTruthy();
  expect(screen.getByText("意味")).toBeTruthy();

  await user.keyboard("{Escape}");
  await waitFor(() => expect(popup()).toBeNull());

  // Gone once nothing is selected.
  select(rangeOf("中継", answer()));
  await waitFor(() => expect(popup()).toBeTruthy());
  select();
  await waitFor(() => expect(popup()).toBeNull());

  // And once the plugin is disabled.
  select(rangeOf("中継", answer()));
  await waitFor(() => expect(popup()).toBeTruthy());
  await hub.say({ type: "plugins", plugins: [info({ enabled: false })] });
  expect(popup()).toBeNull();
});

test("the settings screen opened for a plugin opens its section and scrolls to it once it is drawn, also when opened before the snapshot", async () => {
  const scrolled: Element[] = [];
  vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function (this: Element) {
    scrolled.push(this);
  });
  location.hash = "#/settings/p/notes";
  render(<PluginSettingsSections />);
  expect(scrolled).toEqual([]);
  await connectHub({ machines: [m1], plugins: [info({ id: "aaa", manifest: { ...info().manifest, id: "aaa", name: "前のプラグイン" } }), info()] });
  const section = screen.getByRole("region", { name: "メモ" });
  expect(scrolled).toEqual([section]);
  expect(within(section).getByRole("checkbox", { name: "表示する" })).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "前のプラグイン" })).queryByRole("checkbox")).toBeNull();
  vi.restoreAllMocks();
});

test("the settings of a plugin are kept on the Gasho server or in this browser, as each says", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [m1], plugins: [info()] });
  render(<PluginSettingsSections />);
  const section = screen.getByRole("region", { name: "メモ" });
  await user.click(within(section).getByRole("button", { name: "メモ" }));

  await user.click(within(section).getByRole("checkbox", { name: "表示する" }));
  expect(hub.sent.at(-1)).toMatchObject({ type: "plugin.setting", plugin: "notes", key: "shown", value: false });
  await hub.answer({ ok: true });

  const limit = within(section).getByRole("spinbutton", { name: "上限" });
  await user.clear(limit);
  await user.tab();
  expect(within(section).getByText("数を入れてください。")).toBeTruthy();
  // Folded and opened again, what was typed and not saved stays, and so does what went wrong with it.
  const heading = within(section).getByRole("button", { name: "メモ" });
  await user.click(heading);
  await waitFor(() => expect(within(section).queryByRole("spinbutton")).toBeNull());
  await user.click(heading);
  expect(within(section).getByRole("spinbutton", { name: "上限" })).toHaveProperty("value", "");
  expect(within(section).getByText("数を入れてください。")).toBeTruthy();
  await user.type(limit, "7{Enter}");
  expect(hub.sent.at(-1)).toMatchObject({ type: "plugin.setting", key: "limit", value: 7 });
  await hub.answer({ ok: true });

  const sent = hub.sent.length;
  await user.type(within(section).getByRole("textbox", { name: "このブラウザーの名前" }), "仕事用{Enter}");
  expect(localStorage.getItem("gasho.plugin.notes.mine")).toBe('"仕事用"');
  expect(hub.sent).toHaveLength(sent);
});
