// The sidebar's sessions in categories of the plugin's (P17): the sessions that wait for an answer, and the others but
// the one named "その他へ" (Gasho puts it in "その他"). localStorage "e2e-session-list.mode" makes the hook throw
// ("throw") or answer anew each time it is called ("churn").
const { modules } = globalThis.__gasho;
const sdk = modules["@gasho/plugin-sdk"];

const item = (s) => ({ machine: s.machine.id, sessionId: s.session.sessionId, description: `E2E ${s.session.name}` });

function useCategories({ sessions }) {
  const mode = localStorage.getItem("e2e-session-list.mode");
  if (mode === "throw") throw new Error("一覧が壊れました");
  const waiting = sessions.filter((s) => s.session.status === "waiting");
  const rest = sessions.filter((s) => s.session.status !== "waiting" && s.session.name !== "その他へ");
  return [
    { id: "waiting", title: "E2E 確認待ち", description: `${waiting.length} 件`, sessions: waiting.map(item) },
    { id: "rest", title: "E2E そのほか", ...(mode === "churn" ? { description: String(Math.random()) } : {}), sessions: rest.map(item) },
  ];
}

export default sdk.definePlugin({ sessionList: { useCategories, hideSessionTabs: true } });
