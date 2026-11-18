import { render, screen, within } from "@testing-library/react";
import type { GitCommit, GitGraph } from "@gasho/protocol";
import { expect, test } from "vitest";
import { CommitGraph } from "@/components/commit-graph";

const now = Date.UTC(2026, 10, 18);
const commit = (hash: string, parents: string[], subject: string, refs: GitCommit["refs"] = []): GitCommit => ({
  hash,
  parents,
  subject,
  author: "dev",
  at: now - 60_000,
  refs,
});
const github = { owner: "4rtofl", name: "Gasho", url: "https://github.com/4rtofl/Gasho" };

/** The badges before a commit's subject, in their order, by what they say. */
function badges(subject: string): (string | null)[] {
  const s = screen.getByText(subject);
  return [...s.closest("li")!.querySelectorAll("span[title]")]
    .filter((b) => b.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING)
    .map((b) => b.getAttribute("title"));
}

test("a branch and the remote branch it tracks on the same commit are one badge, the checked-out branch first", () => {
  const graph: GitGraph = {
    root: "/repo",
    head: "feat/1",
    headHash: "c3",
    truncated: false,
    github,
    branches: [
      { name: "feat/1", remote: false, hash: "c3", upstream: "origin/feat/1" },
      { name: "main", remote: false, hash: "c2", upstream: "origin/main" },
      { name: "origin/feat/1", remote: true, hash: "c3" },
      { name: "origin/main", remote: true, hash: "c1" },
    ],
    commits: [
      commit("c3", ["c2"], "テストを足す", [
        { name: "v1.0", kind: "tag" },
        { name: "origin/feat/1", kind: "remote" },
        { name: "feat/1", kind: "local" },
      ]),
      commit("c2", ["c1"], "直す", [{ name: "main", kind: "local" }]),
      commit("c1", [], "始める", [{ name: "origin/main", kind: "remote" }]),
    ],
  };
  render(<CommitGraph graph={graph} now={now} />);

  expect(badges("テストを足す")).toEqual(["feat/1（チェックアウト中）。origin/feat/1 と同じコミット", "タグ v1.0"]);
  expect(within(screen.getByText("テストを足す").closest("li")!).getByLabelText("リモートと同じ")).toBeTruthy();
  // main is ahead of origin/main: each has its own badge on its own commit.
  expect(badges("直す")).toEqual(["main"]);
  expect(badges("始める")).toEqual(["origin/main（リモート）"]);
  // The commits open on GitHub.
  const links = within(screen.getByText("直す").closest("li")!).getAllByRole("link", { name: "c2" });
  expect(links[0]?.getAttribute("href")).toBe("https://github.com/4rtofl/Gasho/commit/c2");
});

test("a detached HEAD is marked on its commit, and commits of a repository not on GitHub are not links", () => {
  render(
    <CommitGraph
      graph={{ root: "/repo", headHash: "c1", truncated: false, branches: [], commits: [commit("c2", ["c1"], "あと"), commit("c1", [], "まえ")] }}
      now={now}
    />,
  );
  expect(badges("まえ")).toEqual(["HEAD（特定のブランチを指していません）"]);
  expect(badges("あと")).toEqual([]);
  expect(screen.queryByRole("link")).toBeNull();
});
