// A plugin's web part for the tests of the plugins' parts, written as a plugin's build turns one into: React and the
// SDK come from what Gasho's screen shares (globalThis.__gasho, sdk.tsx). The screen loads it as it loads any (registry.ts).
import type { FileViewerProps, GashoSdk } from "@gasho/plugin-sdk";
import type * as ReactType from "react";

const { modules } = (globalThis as unknown as { __gasho: { modules: { react: typeof ReactType; "@gasho/plugin-sdk": GashoSdk } } }).__gasho;
const React = modules.react;
const sdk = modules["@gasho/plugin-sdk"];
const h = React.createElement;

function Notes() {
  const [shown] = sdk.useSetting<boolean>("shown");
  const [count, setCount] = sdk.useSharedState("count", 0);
  const send = sdk.useSendInput();
  const call = sdk.useCall();
  const removeSession = sdk.useRemoveSession();
  const launch = sdk.useLaunchSession();
  const [said, setSaid] = React.useState("");
  const ctx = sdk.useSessionContext();
  return h(
    sdk.Panel,
    { title: "メモ" },
    h("p", null, shown ? "表示する" : "表示しない"),
    h("button", { type: "button", onClick: () => void setCount((n) => n + 1).catch((e: Error) => setSaid(e.message)) }, `数 ${count}`),
    h(
      "button",
      {
        type: "button",
        onClick: async () => {
          const r = await send({ machine: ctx!.machine.id, sessionId: ctx!.session.sessionId, text: "続けて" });
          setSaid(r.ok ? "送りました" : r.unknown ? `分からない：${r.error}` : r.error);
        },
      },
      "続けてと送る",
    ),
    h(
      "button",
      {
        type: "button",
        onClick: async () => {
          const r = await call({ machine: ctx!.machine.id, method: "save" });
          setSaid(r.ok ? "書きました" : r.unknown ? `分からない：${r.error}` : r.error);
        },
      },
      "書く",
    ),
    h(
      "button",
      {
        type: "button",
        onClick: async () => {
          const r = await send({ machine: ctx!.machine.id, sessionId: ctx!.session.sessionId, text: "見直して", effort: "max" });
          setSaid(r.ok ? `送りました${r.data.queued ? "（待ち）" : ""}${r.data.unapplied ? `（${r.data.unapplied.join("・")} はそのまま：${r.data.warning}）` : ""}` : r.error);
        },
      },
      "Max で見直してと送る",
    ),
    h(
      "button",
      {
        type: "button",
        onClick: async () => {
          const r = await removeSession({ machine: ctx!.machine.id, sessionId: ctx!.session.sessionId });
          setSaid(r.ok ? "削除しました" : r.error);
        },
      },
      "このセッションを削除",
    ),
    h(
      "button",
      {
        type: "button",
        onClick: async () => {
          const r = await launch({ machine: ctx!.machine.id, cwd: ctx!.session.cwd });
          setSaid(r.ok ? "起動しました" : r.error);
        },
      },
      "ここで起動",
    ),
    said && h("p", null, said),
  );
}

/** Its view of pictures in the file panel (P20): what it got, and a button to the next file of the folder. */
function Shot({ path, file, entries, openFile }: FileViewerProps) {
  if (path.endsWith("boom.png")) throw new Error("壊れました");
  const ctx = sdk.useSessionContext();
  const folder = path.slice(0, path.lastIndexOf("/") + 1);
  const names = entries?.filter((e) => e.kind === "file").map((e) => e.name);
  const next = names?.[names.indexOf(path.slice(folder.length)) + 1];
  return h(
    "div",
    null,
    h("p", null, `${path}（${file.size} バイト、${ctx?.session.sessionId}）`),
    h("p", null, names ? `同じフォルダー：${names.join("・")}` : "同じフォルダーを読み込み中"),
    next && h("button", { type: "button", onClick: () => openFile(folder + next) }, "次のファイル"),
  );
}

export default sdk.definePlugin({
  pages: {
    list: ({ params }) => h(sdk.Page, { title: "メモの一覧" }, `ページ ${params.tag ?? ""}`),
  },
  sessionHeader: [
    { id: "notes", label: "メモ", panel: { id: "notes" } },
    // Only for a session with a name: `when` decides.
    { id: "named", label: "名前あり", when: ({ session }) => Boolean(session.name), onClick: () => Promise.reject(new Error("押せませんでした")) },
  ],
  sessionPanels: { notes: Notes },
  // With and without the dot, in either case: they are the same.
  fileViewers: [{ id: "shots", extensions: [".PNG", "gif"], component: Shot }],
  conversationEnd: [
    {
      id: "end",
      component: ({ session }) => {
        if (session.name === "boom") throw new Error("壊れました");
        return h("p", null, "会話の終わり");
      },
    },
  ],
});
