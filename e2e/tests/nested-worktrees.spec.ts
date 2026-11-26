// The sidebar's worktrees nested under the worktree they were started from (#301): a session's Agent that set up a
// worktree and started a session in it (`gasho-daemon session launch`) is that session's parent
// (SessionInfo.launchedBy). In Gasho's own list and in a plugin's grouping (P18, e2e-groupings): the children one step
// in under their parent, folded by a mark at its left, dragged with it, at the top again once the parent is gone, and
// all at the top while "worktree を入れ子にする" is off. With fake gasho-daemons.
import type { Locator, Page } from "@playwright/test";
import type { SessionInfo } from "@gasho/protocol";
import { fakeSession } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { frames, pointOn, startDrag, worktreeSession } from "./home-sidebar.ts";
import { plugin, sidebar } from "./plugin-helpers.ts";

test.describe.configure({ mode: "parallel" });

/** The worktrees' rows at the top of the list, which are the items that can be put in another order. */
const rows = (nav: Locator) => nav.locator("[data-sort-row]");
/** The names of the rows at the top: the first line of each one's first button. */
const topLabels = (nav: Locator) => rows(nav).evaluateAll((els) => els.map((e) => (e.querySelector("button")?.innerText ?? "").trim().split("\n")[0]));
/** The names of all the worktrees' rows (nested ones too), in the order they show. */
async function allLabels(nav: Locator): Promise<string[]> {
  return (await nav.getByRole("button").allInnerTexts()).map((t) => t.trim().split("\n")[0]!).filter((t) => /^(feat\/|fix\/|main$)/.test(t));
}
/** A worktree's row (its button), by its name (the branch). */
const rowButton = (nav: Locator, label: string) => nav.getByRole("button", { name: new RegExp(`^${label.replace(/\//g, "\\/")}( |$)`) });
/** What is nested under a worktree's row. */
const under = (nav: Locator, label: string) => nav.getByRole("group", { name: `「${label}」の下`, exact: true });
/** The mark at the left of a parent's row that folds what is under it, or unfolds it. */
const foldMark = (nav: Locator, label: string) => nav.getByRole("button", { name: new RegExp(`^「${label.replace(/\//g, "\\/")}」の下を(畳む|開く)$`) });

const MENU_FLAT = "リポジトリで絞り込む";

async function setNesting(page: Page, menuName: RegExp, on: boolean): Promise<void> {
  const nav = await sidebar(page);
  await nav.getByRole("button", { name: menuName }).click();
  const menu = page.getByRole("menu");
  await expect(menu.getByText("表示", { exact: true })).toBeVisible();
  const box = menu.getByRole("menuitemcheckbox", { name: "worktree を入れ子にする" });
  await expect(box).toHaveAttribute("aria-checked", on ? "false" : "true");
  await box.click();
  // The menu stays open, to change something else.
  await expect(box).toHaveAttribute("aria-checked", on ? "true" : "false");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
}

/** The session of a worktree started by the session `parent` (gasho-daemon session launch), from its folder. */
const launchedBy = (parent: SessionInfo) => ({ launchedBy: { sessionId: parent.sessionId, cwd: parent.cwd } });

test.describe("分けない一覧", () => {
  test("Agent が作った worktree を元の worktree の下に入れ子に出し、畳み、親子で並べ替え、親が消えると上の段に戻す。メニューで入れ子をやめられる", async ({ page, hub, isMobile }) => {
    const now = Date.now();
    const ago = (min: number) => now - min * 60_000;
    const main = worktreeSession("s-main", { branch: "main", lastActivityAt: ago(5) });
    const parent = worktreeSession("s-290", { branch: "feat/290-session-footer", lastActivityAt: ago(3) });
    // Used last of all: without nesting, it would come first.
    const child = worktreeSession("s-295", { branch: "feat/295-footer-plugin-api", lastActivityAt: ago(1), ...launchedBy(parent) });
    const grandchild = worktreeSession("s-297", { branch: "feat/297-footer-docs", lastActivityAt: ago(4), ...launchedBy(child) });
    const other = worktreeSession("s-291", { branch: "feat/291-scrollbar", lastActivityAt: ago(2) });
    const daemon = await hub.fakeDaemon({ sessions: [main, parent, child, grandchild, other] });
    await page.goto("/");

    await test.step("子は親の下に一段下げて出し、孫もその下に出す", async () => {
      const nav = await sidebar(page);
      await expect.poll(() => topLabels(nav)).toEqual(["feat/291-scrollbar", "feat/290-session-footer", "main"]);
      expect(await allLabels(nav)).toEqual(["feat/291-scrollbar", "feat/290-session-footer", "feat/295-footer-plugin-api", "feat/297-footer-docs", "main"]);
      await expect(under(nav, "feat/290-session-footer").getByRole("button", { name: /^feat\/295/ })).toBeVisible();
      await expect(under(nav, "feat/295-footer-plugin-api").getByRole("button", { name: /^feat\/297/ })).toBeVisible();
      const x = async (label: string) => (await rowButton(nav, label).boundingBox())!.x;
      expect(await x("feat/295-footer-plugin-api")).toBeGreaterThan((await x("feat/290-session-footer")) + 15);
      expect(await x("feat/297-footer-docs")).toBeGreaterThan((await x("feat/295-footer-plugin-api")) + 15);
      // Only parents have the mark.
      await expect(foldMark(nav, "feat/290-session-footer")).toHaveAttribute("aria-expanded", "true");
      await expect(foldMark(nav, "feat/291-scrollbar")).toHaveCount(0);
    });

    await test.step("親の印で畳むと子が隠れ、隠れた子が確認を待つと親に「確認」が出る。読み込み直しても畳んだまま", async () => {
      let nav = await sidebar(page);
      await foldMark(nav, "feat/290-session-footer").click();
      await expect(foldMark(nav, "feat/290-session-footer")).toHaveAttribute("aria-expanded", "false");
      await expect(rowButton(nav, "feat/295-footer-plugin-api")).toHaveCount(0);
      await expect(rowButton(nav, "feat/297-footer-docs")).toHaveCount(0);
      await expect(rowButton(nav, "feat/290-session-footer")).not.toContainText("確認");
      daemon.updateSession(grandchild.sessionId, { status: "waiting" });
      await expect(rowButton(nav, "feat/290-session-footer")).toContainText("確認");
      await page.reload();
      nav = await sidebar(page);
      await expect(foldMark(nav, "feat/290-session-footer")).toHaveAttribute("aria-expanded", "false");
      await expect(rowButton(nav, "feat/295-footer-plugin-api")).toHaveCount(0);
    });

    await test.step("開いている worktree は、親を畳んでも見える", async () => {
      let nav = await sidebar(page);
      await foldMark(nav, "feat/290-session-footer").click();
      await rowButton(nav, "feat/297-footer-docs").click();
      await expect(page).toHaveURL(new RegExp(grandchild.sessionId));
      nav = await sidebar(page);
      await foldMark(nav, "feat/290-session-footer").click();
      await expect(rowButton(nav, "feat/297-footer-docs")).toBeVisible();
      await expect(rowButton(nav, "feat/295-footer-plugin-api")).toBeVisible();
      await foldMark(nav, "feat/290-session-footer").click();
      await expect(foldMark(nav, "feat/290-session-footer")).toHaveAttribute("aria-expanded", "true");
      daemon.updateSession(grandchild.sessionId, { status: "idle" });
    });

    await test.step("親をドラッグすると、子と孫もいっしょに動く。子を押してドラッグしても親子で動く", async () => {
      const nav = await sidebar(page);
      const grip = (label: string) => (isMobile ? rows(nav).filter({ has: rowButton(nav, label) }).locator("[data-sort-handle]").first() : rowButton(nav, label));
      const top = async (label: string) => pointOn(rowButton(nav, label), 0, -((await rowButton(nav, label).boundingBox())!.height / 2) + 2);
      let d = await startDrag(page, isMobile, grip("feat/290-session-footer"));
      await d.to(await top("feat/291-scrollbar"));
      await expect.poll(() => topLabels(nav)).toEqual(["feat/290-session-footer", "feat/291-scrollbar", "main"]);
      await d.drop();
      await frames(page);
      expect(await allLabels(nav)).toEqual(["feat/290-session-footer", "feat/295-footer-plugin-api", "feat/297-footer-docs", "feat/291-scrollbar", "main"]);
      if (isMobile) return;
      // On a computer, a row is dragged by itself: a child's takes its family.
      d = await startDrag(page, isMobile, grip("feat/297-footer-docs"));
      const main = await rowButton(nav, "main").boundingBox();
      await d.to({ x: main!.x + main!.width / 2, y: main!.y + main!.height - 2 });
      await expect.poll(() => topLabels(nav)).toEqual(["feat/291-scrollbar", "main", "feat/290-session-footer"]);
      await d.drop();
      await frames(page);
      expect(await allLabels(nav)).toEqual(["feat/291-scrollbar", "main", "feat/290-session-footer", "feat/295-footer-plugin-api", "feat/297-footer-docs"]);
      await nav.getByRole("button", { name: "最後に使った順に戻す" }).click();
      await expect.poll(() => topLabels(nav)).toEqual(["feat/291-scrollbar", "feat/290-session-footer", "main"]);
    });

    await test.step("メニューの「表示」で入れ子をやめると、どれも上の段に、最後に使った順に並ぶ。読み込み直しても残る", async () => {
      await setNesting(page, new RegExp(`^${MENU_FLAT}`), false);
      let nav = await sidebar(page);
      await expect.poll(() => topLabels(nav)).toEqual(["feat/295-footer-plugin-api", "feat/291-scrollbar", "feat/290-session-footer", "feat/297-footer-docs", "main"]);
      await expect(foldMark(nav, "feat/290-session-footer")).toHaveCount(0);
      await page.reload();
      nav = await sidebar(page);
      await expect.poll(() => topLabels(nav)).toHaveLength(5);
      await setNesting(page, new RegExp(`^${MENU_FLAT}`), true);
      await expect.poll(() => topLabels(nav)).toEqual(["feat/291-scrollbar", "feat/290-session-footer", "main"]);
    });

    await test.step("子のセッションが無くなっても、子は親の下に残る", async () => {
      daemon.setSessions([main, parent, other, grandchild]);
      const nav = await sidebar(page);
      // Its dot goes grey: no sessions.
      await expect(rowButton(nav, "feat/295-footer-plugin-api").locator(".bg-neutral-500")).toBeVisible();
      await expect(under(nav, "feat/290-session-footer").getByRole("button", { name: /^feat\/295/ })).toBeVisible();
      await expect(under(nav, "feat/295-footer-plugin-api").getByRole("button", { name: /^feat\/297/ })).toBeVisible();
    });

    await test.step("親の worktree が消えると、子は上の段に戻る", async () => {
      daemon.setSessions([main, other, grandchild]);
      let nav = await sidebar(page);
      await rowButton(nav, "feat/290-session-footer").click();
      await expect(page.getByRole("heading", { name: "feat/290-session-footer", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "サイドバーから外す" }).click();
      await expect(page.getByRole("main").getByRole("heading", { name: "ホーム" })).toBeVisible();
      nav = await sidebar(page);
      await expect(rowButton(nav, "feat/290-session-footer")).toHaveCount(0);
      // Without sessions, it comes after those with sessions, as a worktree the browser keeps does.
      await expect.poll(() => topLabels(nav)).toEqual(["feat/291-scrollbar", "main", "feat/295-footer-plugin-api"]);
      await expect(under(nav, "feat/295-footer-plugin-api").getByRole("button", { name: /^feat\/297/ })).toBeVisible();
    });
  });
});

test.describe("プラグインの分け方（P18）", () => {
  test.use({ hubOptions: { plugins: [plugin("e2e-groupings")] } });

  test("子は、プラグインが別のカテゴリに入れても、親のカテゴリで親の下に出る。入れ子をやめるとプラグインのカテゴリに戻る", async ({ page, hub }) => {
    const REPO = "/work/app";
    const session = (n: number, branch: string, extra: Partial<SessionInfo> = {}) => {
      const path = n === 0 ? REPO : `${REPO}-${n}`;
      return fakeSession({ sessionId: `0b6f3a52-9a51-4c7e-8d2b-6c1f0e4a7d2${n}`, cwd: path, gitBranch: branch, worktree: { path, repo: REPO, branch }, ...extra });
    };
    const parent = session(1, "feat/1-a", { lastActivityAt: Date.now() - 60_000 });
    const child = session(2, "fix/2-b", { lastActivityAt: Date.now(), ...launchedBy(parent) });
    const lone = session(3, "fix/3-c", { lastActivityAt: Date.now() - 120_000 });
    await hub.fakeDaemon({ name: "mac", sessions: [parent, child, lone, session(0, "main")] });
    await page.goto("/");

    await test.step("fix/2-b は「E2E fix」ではなく、親の feat/1-a の下に出る", async () => {
      const nav = await sidebar(page);
      await expect(nav.getByRole("button", { name: /^E2E feat/ })).toBeVisible();
      await expect(under(nav, "feat/1-a").getByRole("button", { name: /^fix\/2-b/ })).toBeVisible();
      const labels = (await nav.getByRole("button").allInnerTexts()).map((t) => t.trim().split("\n")[0]!).filter(Boolean);
      expect(labels.filter((l) => /^(E2E|その他|feat\/|fix\/|main$)/.test(l))).toEqual(["E2E feat", "feat/1-a", "fix/2-b", "E2E fix", "fix/3-c", "その他", "main"]);
    });

    await test.step("親の印で畳むと、子が隠れる", async () => {
      const nav = await sidebar(page);
      await foldMark(nav, "feat/1-a").click();
      await expect(rowButton(nav, "fix/2-b")).toHaveCount(0);
      await foldMark(nav, "feat/1-a").click();
      await expect(rowButton(nav, "fix/2-b")).toBeVisible();
    });

    await test.step("入れ子をやめると、fix/2-b はプラグインのカテゴリ「E2E fix」に戻る", async () => {
      await setNesting(page, /^絞り込みと分け方/, false);
      const nav = await sidebar(page);
      await expect(under(nav, "feat/1-a")).toHaveCount(0);
      const labels = (await nav.getByRole("button").allInnerTexts()).map((t) => t.trim().split("\n")[0]!).filter(Boolean);
      expect(labels.filter((l) => /^(E2E|その他|feat\/|fix\/|main$)/.test(l))).toEqual(["E2E feat", "feat/1-a", "E2E fix", "fix/2-b", "fix/3-c", "その他", "main"]);
    });
  });
});
