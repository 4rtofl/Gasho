// The branch graph of a session's repository (views/graph.tsx, components/commit-graph.tsx), from what gasho-daemon
// answers to git.graph.get. Times are of Playwright's clock, paused at 09:30 in Tokyo.
import type { GitGraph } from "@gasho/protocol";
import { expect, test } from "./fixtures.ts";
import { commit, hashOf, pauseClockAt, serveGraph, sessionDaemon, sessionUrl, showSessionHeader } from "./panel-data.ts";

test.use({ timezoneId: "Asia/Tokyo" });

const MIN = 60_000;
const T0 = Date.parse("2026-11-18T09:30:00+09:00");
const github = { owner: "4rtofl", name: "Gasho", url: "https://github.com/4rtofl/Gasho" };
const LONG = `${"長い件名の続き、".repeat(16)}ここで終わり`;

/**
 * On branch topic/x, ahead of its upstream by 2 and behind by 1, with branches in each state of their upstream. topic/x
 * comes last by name, so that it is first in the list only because it is checked out.
 */
const graph: GitGraph = {
  root: "/work/gasho",
  head: "topic/x",
  headHash: hashOf("x2"),
  changes: { staged: 1, unstaged: 2, untracked: 3 },
  github,
  branches: [
    { name: "topic/x", remote: false, hash: hashOf("x2"), upstream: "origin/topic/x", ahead: 2, behind: 1 },
    { name: "main", remote: false, hash: hashOf("m1"), upstream: "origin/main", ahead: 0, behind: 0 },
    { name: "old", remote: false, hash: hashOf("m1"), upstream: "origin/old", upstreamGone: true },
    { name: "local-only", remote: false, hash: hashOf("m1") },
    { name: "origin/topic/x", remote: true, hash: hashOf("x0") },
    { name: "origin/main", remote: true, hash: hashOf("m1") },
    { name: "origin/release", remote: true, hash: hashOf("m1") },
  ],
  commits: [
    commit("x2", { parents: ["x1"], subject: LONG, author: "Alice", at: T0 - 5 * MIN, refs: [{ name: "topic/x", kind: "local" }] }),
    commit("x1", { parents: ["x0"], subject: "x の 2 つ目", at: T0 - 30 * MIN }),
    commit("x0", { parents: ["m1"], subject: "x の 1 つ目", at: T0 - 120 * MIN, refs: [{ name: "origin/topic/x", kind: "remote" }] }),
    commit("m1", {
      subject: "最初のコミット",
      at: T0 - 3 * 24 * 60 * MIN,
      refs: [
        { name: "main", kind: "local" },
        { name: "origin/main", kind: "remote" },
        { name: "origin/release", kind: "remote" },
        { name: "v1.0", kind: "tag" },
      ],
    }),
  ],
  truncated: false,
};

test("HEAD のブランチ・未コミットの変更・読み込んだ時刻・ブランチの一覧と上流の状態・コミットが出る", async ({ page, hub, isMobile }) => {
  const d = await sessionDaemon(hub, { session: { gitBranch: "topic/x" } });
  serveGraph(d, () => graph);
  await pauseClockAt(page, T0);
  await page.goto(sessionUrl(d));
  const panel = page.getByRole("region", { name: "ブランチグラフ" });
  const commits = panel.getByRole("list", { name: "コミットの履歴" });
  const branch = (name: string) => panel.getByRole("listitem").filter({ has: page.getByTitle(name, { exact: true }) });
  // The line above the branches, without them.
  const summary = panel.locator("div").filter({ hasText: "に読み込み" }).filter({ hasNot: page.getByRole("listitem") });

  await test.step("ヘッダーのブランチ名からブランチグラフを開く", async () => {
    await showSessionHeader(page, isMobile);
    await page.getByTitle("ブランチグラフを開く").click();
    await expect(commits).toBeVisible();
  });

  await test.step("HEAD のブランチ、未コミットの変更の件数、読み込んだ時刻が出る", async () => {
    await expect(summary.getByText("topic/x", { exact: true })).toBeVisible();
    await expect(summary.getByText("未コミットの変更：ステージ済み 1・未ステージ 2・未追跡 3")).toBeVisible();
    await expect(summary.getByText("09:30 に読み込み")).toBeVisible();
  });

  await test.step("ブランチの一覧は、チェックアウト中のブランチを先頭に、追跡されていないリモートのブランチまで並ぶ", async () => {
    await expect(panel.getByRole("button", { name: "ブランチ（5）" })).toHaveAttribute("aria-expanded", "true");
    await expect(panel.getByRole("listitem").first()).toContainText("topic/x");
    await expect(branch("topic/x")).toContainText("チェックアウト中");
    await expect(branch("origin/release")).toBeVisible();
    // Tracked by a local branch, it is shown with it.
    await expect(branch("origin/main")).toHaveCount(0);
  });

  await test.step("上流の状態: ↑n・↓n、同期済み、削除済み、なし", async () => {
    await expect(branch("topic/x")).toContainText("↑2");
    await expect(branch("topic/x")).toContainText("↓1");
    await expect(branch("main")).toContainText("同期済み");
    await expect(branch("old")).toContainText("上流は削除済み");
    await expect(branch("local-only")).toContainText("上流なし");
  });

  await test.step("origin にあるブランチと、リポジトリと、コミットに GitHub のリンクが付く", async () => {
    await expect(panel.getByRole("link", { name: "topic/x を GitHub で開く" })).toHaveAttribute("href", `${github.url}/tree/topic/x`);
    await expect(panel.getByRole("link", { name: "origin/release を GitHub で開く" })).toHaveAttribute("href", `${github.url}/tree/release`);
    await expect(panel.getByRole("link", { name: "local-only を GitHub で開く" })).toHaveCount(0);
    // On a phone the panel's buttons are in the screen's top bar.
    await expect(page.getByRole("link", { name: "GitHub", exact: true })).toHaveAttribute("href", github.url);
    await expect(commits.getByRole("link", { name: hashOf("m1").slice(0, 7) })).toHaveAttribute("href", `${github.url}/commit/${hashOf("m1")}`);
  });

  await test.step("コミットに、ブランチとタグの札と、相対時刻が出る", async () => {
    const first = commits.getByRole("listitem").filter({ hasText: "最初のコミット" });
    await expect(first.getByTitle("タグ v1.0")).toBeVisible();
    await expect(first.getByTitle("origin/release（リモート）")).toBeVisible();
    await expect(first).toContainText("3 日前");
    await expect(commits.getByRole("listitem").filter({ hasText: "x の 2 つ目" })).toContainText("30 分前");
    await expect(commits.getByRole("listitem").first()).toContainText("5 分前");
  });

  await test.step("長い件名は 1 行のまま、その行だけが横にスクロールする", async () => {
    const subject = commits.getByText(LONG);
    const row = subject.locator("xpath=../..");
    const size = await row.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
    expect(size.scroll).toBeGreaterThan(size.client);
    expect((await subject.boundingBox())?.height).toBeLessThan(32);
    if (isMobile) await row.evaluate((el) => el.scrollBy({ left: 200 }));
    else {
      await subject.hover();
      await page.mouse.wheel(200, 0);
    }
    await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    // The panel itself does not scroll sideways.
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  });

  await test.step("時計が 1 時間進むと、相対時刻が変わる", async () => {
    await page.clock.fastForward("01:00:00");
    await expect(commits.getByRole("listitem").first()).toContainText("1 時間前");
  });

  await test.step("ブランチの一覧を閉じると、読み込み直しても閉じたまま", async () => {
    await panel.getByRole("button", { name: "ブランチ（5）" }).click();
    await expect(branch("topic/x")).toHaveCount(0);
    await page.reload();
    await expect(commits).toBeVisible();
    await expect(panel.getByRole("button", { name: "ブランチ（5）" })).toHaveAttribute("aria-expanded", "false");
    await expect(branch("topic/x")).toHaveCount(0);
    await panel.getByRole("button", { name: "ブランチ（5）" }).click();
    await expect(branch("topic/x")).toBeVisible();
  });
});

test.describe("PC の幅", () => {
  test.skip(({ isMobile }) => isMobile, "パネルの幅を変えられるのは PC の幅だけ");

  test("パネルの幅で、コミットの番号が件名の後ろと右の列のあいだで移り、作者は件名の後ろに残る", async ({ page, hub }) => {
    const d = await sessionDaemon(hub, { session: { gitBranch: "topic/x" } });
    serveGraph(d, () => graph);
    await pauseClockAt(page, T0);
    await page.goto(sessionUrl(d, "/graph"));
    const row = page.getByRole("list", { name: "コミットの履歴" }).getByRole("listitem").filter({ hasText: "x の 2 つ目" });
    const hash = row.getByRole("link", { name: hashOf("x1").slice(0, 7) });
    const author = row.getByText("e2e", { exact: true }).filter({ visible: true });
    const time = row.getByText("30 分前");
    const x = async (l: typeof hash) => (await l.boundingBox())?.x ?? Number.NaN;
    const edge = page.getByRole("separator", { name: "パネルの幅" });

    await test.step("既定の幅（窓の 40%）では、番号は時刻の右の列に出る", async () => {
      await expect(edge).toHaveAttribute("aria-valuenow", "512");
      await expect(hash).toBeVisible();
      expect(await x(hash)).toBeGreaterThan(await x(time));
      await expect(author).toHaveCount(1);
      expect(await x(author)).toBeLessThan(await x(time));
    });

    await test.step("380px に狭めると、番号は件名の後ろに移る", async () => {
      const b = (await edge.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + 400, b.y + b.height / 2, { steps: 5 });
      await page.mouse.up();
      await expect(edge).toHaveAttribute("aria-valuenow", "380");
      await expect(hash).toBeVisible();
      expect(await x(hash)).toBeLessThan(await x(time));
      await expect(author).toHaveCount(1);
      expect(await x(author)).toBeLessThan(await x(time));
    });
  });
});

test("複数のリポジトリはタブで切り替え、再読み込みでもう一度読む", async ({ page, hub, isMobile }) => {
  const app = { owner: "4rtofl", name: "app", url: "https://github.com/4rtofl/app" };
  const d = await sessionDaemon(hub, {
    session: { cwd: "/work/mono", gitBranch: undefined, repos: [{ path: "app", branch: "main", github: app }, { path: "lib", branch: "dev" }] },
  });
  const one = (name: string, head: string, root: string, gh?: typeof app): GitGraph => ({
    root,
    head,
    headHash: hashOf(name),
    branches: [{ name: head, remote: false, hash: hashOf(name) }],
    commits: [commit(name, { at: Date.now() })],
    truncated: false,
    ...(gh ? { github: gh } : {}),
  });
  let lib = one("lib のコミット", "dev", "/work/mono/lib");
  serveGraph(d, (repo) => (repo === "lib" ? lib : one("app のコミット", "main", "/work/mono/app", app)));
  await page.goto(sessionUrl(d));
  const panel = page.getByRole("region", { name: "ブランチグラフ" });
  const tab = (name: string) => panel.getByRole("tab", { name });
  const asked = (repo: string) => d.received.filter((m) => m.type === "git.graph.get" && m.repo === repo).length;

  await test.step("ヘッダーの「ブランチ…」で開くと、リポジトリのタブが出て、最初のリポジトリのグラフが出る", async () => {
    await showSessionHeader(page, isMobile);
    await page.getByTitle("ブランチグラフを開き、リポジトリを切り替えて見る").click();
    await expect(tab("app")).toHaveAttribute("aria-selected", "true");
    await expect(tab("lib")).toHaveAttribute("aria-selected", "false");
    await expect(panel.getByText("app のコミット")).toBeVisible();
    await expect(page.getByRole("link", { name: "GitHub", exact: true })).toHaveAttribute("href", app.url);
  });

  await test.step("タブを押すと、そのリポジトリのグラフに替わり、URL もそのリポジトリを指す", async () => {
    await tab("lib").click();
    await expect(panel.getByText("lib のコミット")).toBeVisible();
    await expect(tab("lib")).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/\/graph\/lib$/);
    // lib is not on GitHub.
    await expect(page.getByRole("link", { name: "GitHub", exact: true })).toHaveCount(0);
  });

  await test.step("再読み込みで、そのリポジトリのグラフをもう一度読む", async () => {
    expect(asked("lib")).toBe(1);
    lib = one("lib の新しいコミット", "dev", "/work/mono/lib");
    await page.getByRole("button", { name: "再読み込み" }).click();
    await expect(panel.getByText("lib の新しいコミット")).toBeVisible();
    expect(asked("lib")).toBe(2);
  });
});

test("読み込み中・コミット 0 件・detached・件数を切ったとき・エラー・オフライン・セッションが見つからないときの表示", async ({ page, hub }) => {
  const d = await sessionDaemon(hub);
  let release: (g: GitGraph) => void = () => {};
  let next: GitGraph | { error: string } | Promise<GitGraph> = new Promise<GitGraph>((r) => (release = r));
  serveGraph(d, () => next);
  await page.goto(sessionUrl(d, "/graph"));
  const panel = page.getByRole("region", { name: "ブランチグラフ" });
  const reload = page.getByRole("button", { name: "再読み込み" });

  await test.step("答えが来るまで「読み込み中…」が出る", async () => {
    await expect(panel.getByText("読み込み中…")).toBeVisible();
    release({ root: "/work/gasho", head: "main", branches: [], commits: [], truncated: false, changes: { staged: 0, unstaged: 0, untracked: 0 } });
  });

  await test.step("コミットが 0 件のリポジトリ", async () => {
    await expect(panel.getByText("コミットはまだありません。")).toBeVisible();
    await expect(panel.getByText("未コミットの変更なし")).toBeVisible();
    await expect(panel.getByText("読み込み中…")).toHaveCount(0);
  });

  await test.step("detached HEAD と、件数を切ったときの文", async () => {
    next = {
      root: "/work/gasho",
      headHash: hashOf("d2"),
      branches: [{ name: "main", remote: false, hash: hashOf("d1") }],
      commits: [commit("d2", { parents: ["d1"], at: Date.now() }), commit("d1", { at: Date.now(), refs: [{ name: "main", kind: "local" }] })],
      truncated: true,
    };
    await reload.click();
    await expect(panel.getByText("特定のブランチを指していません（detached HEAD）")).toBeVisible();
    await expect(panel.getByTitle("HEAD（特定のブランチを指していません）")).toBeVisible();
    await expect(panel.getByText("新しいものから 2 件を表示しています。")).toBeVisible();
  });

  await test.step("読み込みに失敗すると、エラーを出し、前に読んだグラフは残す", async () => {
    next = { error: "git の実行に失敗しました。" };
    await reload.click();
    await expect(panel.getByText("git の実行に失敗しました。")).toBeVisible();
    await expect(panel.getByText("d2", { exact: true })).toBeVisible();
  });

  await test.step("working server がオフラインになると、そう出て、再読み込みを押せず、グラフは残る", async () => {
    await d.disconnect();
    await expect(panel.getByText("mac はオフラインです。")).toBeVisible();
    await expect(reload).toBeDisabled();
    await expect(panel.getByText("d2", { exact: true })).toBeVisible();
  });

  await test.step("無いセッションのグラフを開くと、見つからないと出る", async () => {
    await page.goto(sessionUrl(d, "/graph", "00000000-0000-4000-8000-000000000000"));
    await expect(panel.getByText("このセッションは見つかりません。終了したか、mac の gasho-daemon が接続していません。")).toBeVisible();
  });
});

test("読み込みの途中で working server が切れても、英語のエラーは出ない", async ({ page, hub }) => {
  test.fail(true, "#177: hub が答えを待っている要求に machine disconnected と返し、画面がそのまま出す");
  const d = await sessionDaemon(hub);
  // Never answered: the Gasho server is still waiting when the working server goes.
  serveGraph(d, () => undefined);
  await page.goto(sessionUrl(d, "/graph"));
  const panel = page.getByRole("region", { name: "ブランチグラフ" });
  await expect(panel.getByText("読み込み中…")).toBeVisible();
  await d.disconnect();
  await expect(panel.getByText("mac はオフラインです。")).toBeVisible();
  await expect(panel.getByText("読み込み中…")).toHaveCount(0);
  await expect(panel.getByText("machine disconnected")).toHaveCount(0);
});
