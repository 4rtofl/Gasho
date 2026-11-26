// The sidebar's worktrees in one category per repository (P18), each telling Gasho the repository it stands for
// (`repo`, API 1.19), whose heading then has a menu to take it off its working server; and one category for the
// folders outside a repository, which tells none.
const { modules } = globalThis.__gasho;
const sdk = modules["@gasho/plugin-sdk"];

function useByRepo({ worktrees }) {
  const byId = new Map();
  for (const w of worktrees) {
    const id = w.repo ? `${w.machine.id}\u001f${w.repo}` : "outside";
    if (!byId.has(id)) {
      byId.set(
        id,
        w.repo
          ? { id, title: `E2E ${w.repoName ?? w.repo}`, repo: { machine: w.machine.id, path: w.repo }, worktrees: [] }
          : { id, title: "E2E リポジトリの外", worktrees: [] },
      );
    }
    byId.get(id).worktrees.push({ key: w.key });
  }
  return [...byId.values()];
}

export default sdk.definePlugin({ worktreeGroupings: [{ id: "repo", label: "E2E リポジトリごと", useCategories: useByRepo }] });
