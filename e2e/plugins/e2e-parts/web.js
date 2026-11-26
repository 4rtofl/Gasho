// A plugin's web part as its build makes it, without the build: React and the SDK are read from what Gasho's screen
// shares (globalThis.__gasho). It adds a part to each extension point, for e2e/tests/plugin-parts.spec.ts and
// plugin-settings.spec.ts.
const { modules } = globalThis.__gasho;
const React = modules.react;
const sdk = modules["@gasho/plugin-sdk"];
const h = React.createElement;

const Dot = (props) => h("svg", { viewBox: "0 0 24 24", fill: "currentColor", ...props }, h("circle", { cx: 12, cy: 12, r: 6 }));

/** What the settings are now, as a part reads them. */
function Settings() {
  const [shown] = sdk.useSetting("shown");
  const [color] = sdk.useSetting("color");
  const [count] = sdk.useSetting("count");
  const [title] = sdk.useSetting("title");
  return h("p", null, `出す:${shown} 色:${color} 数:${count} 見出し:${title}`);
}

function NotesPage({ params }) {
  return h(sdk.Page, { title: "E2E メモ" }, h("p", null, `ページの引数 ${params.tag ?? "なし"}`), h(Settings));
}

/** Throws until the test lets it draw (localStorage), to show the notice of an error and "もう一度". */
function BoomPage() {
  if (localStorage.getItem("e2e-parts.boom") !== "fixed") throw new Error("ページが壊れました");
  return h(sdk.Page, { title: "E2E 直ったページ" }, "直りました");
}

function NotesPanel({ session, params }) {
  const send = sdk.useSendInput();
  const launch = sdk.useLaunchSession();
  const ctx = sdk.useSessionContext();
  const [said, setSaid] = React.useState("");
  return h(
    sdk.Panel,
    { title: "E2E パネル", subtitle: `種類 ${params.kind ?? "なし"}` },
    h("p", null, `パネルのセッション ${session.name}`),
    h(
      "button",
      {
        type: "button",
        onClick: async () => {
          const r = await send({ machine: ctx.machine.id, sessionId: ctx.session.sessionId, text: "続けて" });
          setSaid(r.ok ? "送りました" : r.error);
        },
      },
      "続けてと送る",
    ),
    h(
      "button",
      {
        type: "button",
        onClick: async () => {
          const r = await launch({ machine: ctx.machine.id, cwd: ctx.session.cwd });
          setSaid(r.ok ? "起動しました" : r.error);
        },
      },
      "起動する",
    ),
    said && h("p", null, said),
  );
}

export default sdk.definePlugin({
  sidebar: [{ id: "notes", label: "E2E メモ", icon: Dot, page: { id: "notes", params: { tag: "横" } }, useBadge: () => 7 }],
  pages: { notes: NotesPage, boom: BoomPage },
  settings: Settings,
  sessionHeader: [
    { id: "panel", label: "E2E パネル", title: "E2E のパネルを開く", panel: { id: "notes", params: { kind: "一覧" } } },
    { id: "page", label: "E2E ページ", page: { id: "notes", params: { tag: "ヘッダー" } } },
    { id: "link", label: "E2E リンク", href: () => "https://example.com/e2e-parts" },
    { id: "plain", label: "E2E http", href: () => "http://example.com/e2e-parts" },
    {
      id: "click",
      label: "E2E 押す",
      // Fails when the test calls window.e2ePartsFail, so the test sees the button disabled however slow the machine is.
      onClick: () =>
        new Promise((_, reject) => {
          globalThis.e2ePartsFail = () => reject(new Error("押せませんでした"));
        }),
    },
    { id: "missing", label: "E2E 無いパネル", panel: { id: "nothing" } },
  ],
  sessionPanels: { notes: NotesPanel },
  homeTiles: [{ id: "tile", title: "E2E タイル", size: "small", after: "operations", component: () => h(sdk.Tile, { title: "E2E タイル" }, h("p", null, "タイルの中身")) }],
  conversationEnd: [{ id: "end", component: ({ session }) => h("p", null, `会話の末尾 ${session.name}`) }],
  composerFooter: [{ id: "footer", component: () => h("span", null, "入力欄の下") }],
  sessionFooter: [
    { id: "right", component: () => h("span", null, "フッター右") },
    { id: "left", side: "left", component: () => h("span", null, "フッター左") },
  ],
  worktreeTabs: [
    {
      id: "tab",
      useTabs: ({ worktree }) => (worktree.branch ? [{ label: "E2E タブ", title: "E2E の画面を開く", view: "view", params: { n: "1" }, badge: 2 }, { label: "E2E 無い画面", view: "nothing" }] : []),
    },
  ],
  worktreeViews: { view: ({ worktree, params }) => h("p", null, `worktree の画面 ${worktree.branch} ${params.n}`) },
});
