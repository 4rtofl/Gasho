// The sidebar's worktrees in categories of the plugin's (P18): by the start of the branch (feat/, fix/); the others go
// in Gasho's "その他". localStorage "e2e-groupings.mode" makes the hook throw ("throw") or answer anew each time it is
// called ("churn").
const { modules } = globalThis.__gasho;
const sdk = modules["@gasho/plugin-sdk"];

function useByBranch({ worktrees }) {
  const mode = localStorage.getItem("e2e-groupings.mode");
  if (mode === "throw") throw new Error("分け方が壊れました");
  const of = (prefix) => worktrees.filter((w) => w.branch?.startsWith(prefix)).map((w) => ({ key: w.key }));
  return [
    { id: "feat", title: "E2E feat", ...(mode === "churn" ? { description: String(Math.random()) } : {}), worktrees: of("feat/") },
    { id: "fix", title: "E2E fix", worktrees: of("fix/") },
  ];
}

export default sdk.definePlugin({ worktreeGroupings: [{ id: "branch", label: "E2E ブランチごと", useCategories: useByBranch }] });
