import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PluginInfo } from "@gasho/protocol";
import { beforeEach, expect, test } from "vitest";
import { PluginConversationEnd, PluginHeaderItems, PluginPageView, PluginPanelView, PluginSettingsSections } from "@/plugins/parts";
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

test("the settings of a plugin are kept on the Gasho server or in this browser, as each says", async () => {
  const user = userEvent.setup();
  const hub = await connectHub({ machines: [m1], plugins: [info()] });
  render(<PluginSettingsSections />);
  const section = screen.getByRole("region", { name: "メモ" });

  await user.click(within(section).getByRole("checkbox", { name: "表示する" }));
  expect(hub.sent.at(-1)).toMatchObject({ type: "plugin.setting", plugin: "notes", key: "shown", value: false });
  await hub.answer({ ok: true });

  const limit = within(section).getByRole("spinbutton", { name: "上限" });
  await user.clear(limit);
  await user.tab();
  expect(within(section).getByText("数を入れてください。")).toBeTruthy();
  await user.type(limit, "7{Enter}");
  expect(hub.sent.at(-1)).toMatchObject({ type: "plugin.setting", key: "limit", value: 7 });
  await hub.answer({ ok: true });

  const sent = hub.sent.length;
  await user.type(within(section).getByRole("textbox", { name: "このブラウザーの名前" }), "仕事用{Enter}");
  expect(localStorage.getItem("gasho.plugin.notes.mine")).toBe('"仕事用"');
  expect(hub.sent).toHaveLength(sent);
});
