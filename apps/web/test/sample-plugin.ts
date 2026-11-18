// A plugin's web part for the tests of the plugins' parts, written as a plugin's build turns one into: React and the
// SDK come from what Gasho's screen shares (globalThis.__gasho, sdk.tsx). The screen loads it as it loads any (registry.ts).
import type { GashoSdk } from "@gasho/plugin-sdk";
import type * as ReactType from "react";

const { modules } = (globalThis as unknown as { __gasho: { modules: { react: typeof ReactType; "@gasho/plugin-sdk": GashoSdk } } }).__gasho;
const React = modules.react;
const sdk = modules["@gasho/plugin-sdk"];
const h = React.createElement;

function Notes() {
  const [shown] = sdk.useSetting<boolean>("shown");
  const [count, setCount] = sdk.useSharedState("count", 0);
  const send = sdk.useSendInput();
  const removeSession = sdk.useRemoveSession();
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
    said && h("p", null, said),
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
