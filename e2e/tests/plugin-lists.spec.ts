// The sidebar's lists that plugins decide (docs/plugins.md): the sessions in a plugin's categories (P17,
// e2e/plugins/e2e-session-list), and the worktrees in the categories of a plugin's grouping (P18, e2e-groupings). When
// the plugin's hook throws, or answers anew more than 20 times a second, the sidebar goes back to Gasho's list and says
// so; the plugins screen tells why. The test makes the hooks do that by localStorage, which they read. A category that
// tells the repository it stands for (e2e-repo-groupings) has a menu on its heading, which takes the repository off.
import type { Locator, Page, TestInfo } from "@playwright/test";
import { commandResult, type FakeDaemon, fakeSession, type GashoHub } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { card, plugin, sidebar } from "./plugin-helpers.ts";

const REPO = "/work/app";

/** Three sessions in three worktrees of one repository: one waits for an answer. */
function machine(hub: GashoHub): Promise<FakeDaemon> {
  const session = (n: number, name: string, branch: string, status: "waiting" | "idle") => {
    const path = n === 0 ? REPO : `${REPO}-${n}`;
    return fakeSession({ sessionId: `0b6f3a52-9a51-4c7e-8d2b-6c1f0e4a7d1${n}`, cwd: path, name, status, gitBranch: branch, worktree: { path, repo: REPO, branch } });
  };
  return hub.fakeDaemon({ name: "mac", sessions: [session(1, "確認の作業", "feat/1-a", "waiting"), session(2, "待機の作業", "fix/2-b", "idle"), session(0, "その他へ", "main", "idle")] });
}

/** The labels of all the sidebar's buttons, each on one line. */
async function rows(nav: Locator): Promise<string[]> {
  return (await nav.getByRole("button").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
}

/** Whether `labels` has an item starting with each of `starts`, in this order (others may come between). */
function inOrder(labels: string[], starts: string[]): boolean {
  let at = 0;
  for (const s of starts) {
    at = labels.findIndex((l, i) => i >= at && l.startsWith(s));
    if (at < 0) return false;
    at++;
  }
  return true;
}

async function reloadWithMode(page: Page, key: string, mode: string | null): Promise<void> {
  await page.evaluate(({ k, m }) => (m === null ? localStorage.removeItem(k) : localStorage.setItem(k, m)), { k: key, m: mode });
  await page.reload();
}

test.describe("セッションの一覧（P17）", () => {
  test.use({ hubOptions: { plugins: [plugin("e2e-session-list"), plugin("e2e-groupings")] } });

  test("プラグインのカテゴリにセッションを並べ、畳み、セッションのタブを隠し、フックが壊れると worktree の一覧に戻る", async ({ page, hub }) => {
    await machine(hub);
    await page.goto("/");

    await test.step("カテゴリの見出しの下にセッションを並べ、どのカテゴリにも入らないセッションは「その他」に並べる", async () => {
      const nav = await sidebar(page);
      await expect(nav.getByRole("button", { name: /^E2E 確認待ち/ })).toBeVisible();
      await expect(nav.getByText("worktree", { exact: true })).toHaveCount(0);
      const labels = await rows(nav);
      expect(inOrder(labels, ["E2E 確認待ち 1 件", "確認の作業 E2E 確認の作業", "E2E そのほか", "待機の作業 E2E 待機の作業", "その他", "その他へ"]), labels.join(" | ")).toBe(true);
    });

    await test.step("見出しを押すと畳み、確認待ちの数を出す", async () => {
      const nav = await sidebar(page);
      const heading = nav.getByRole("button", { name: /^E2E 確認待ち/ });
      await heading.click();
      await expect(heading).toHaveAttribute("aria-expanded", "false");
      await expect(heading).toContainText("確認 1");
      await expect(nav.getByRole("button", { name: /^確認の作業/ })).toHaveCount(0);
      await heading.click();
      await expect(nav.getByRole("button", { name: /^確認の作業/ })).toBeVisible();
    });

    await test.step("hideSessionTabs のプラグインは、セッションの画面の上のタブと「＋」を外し、過去の会話のボタンを残す", async () => {
      await (await sidebar(page)).getByRole("button", { name: /^待機の作業/ }).click();
      await expect(page.getByRole("heading", { name: "待機の作業", level: 1 })).toBeVisible();
      // Without the sessions' tabs, the row is named for the worktree alone.
      const tabs = page.getByRole("navigation", { name: "この worktree", exact: true });
      await expect(tabs.getByRole("button", { name: "過去の会話" })).toBeVisible();
      await expect(tabs.getByRole("button", { name: "待機の作業" })).toHaveCount(0);
      await expect(tabs.getByRole("button", { name: "この worktree で新しいセッションを起動" })).toHaveCount(0);
    });

    await test.step("一覧を出しているあいだ、worktree の分け方は使わないと、プラグインの画面に出す", async () => {
      await page.goto("/#/plugins");
      await expect(card(page.getByRole("region", { name: "入れたもの" }), "E2E 分け方").getByText("E2E 一覧 がサイドバーをセッションの一覧にしているので、worktree の分け方は使っていません。")).toBeVisible();
    });

    const notice = "E2E 一覧 の一覧を出せないので、worktree を並べています（理由はプラグインの画面に）。";
    await test.step("フックが例外を投げると worktree の一覧に戻し、知らせと理由を出す", async () => {
      await reloadWithMode(page, "e2e-session-list.mode", "throw");
      const nav = await sidebar(page);
      await expect(nav.getByText(notice)).toBeVisible();
      await expect(nav.getByRole("button", { name: /^E2E 確認待ち/ })).toHaveCount(0);
      await expect(nav.getByRole("button", { name: /^feat\/1-a/ })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(card(page.getByRole("region", { name: "入れたもの" }), "E2E 一覧").getByText("表示でエラーが起きました：一覧が壊れました")).toBeVisible();
    });

    await test.step("答えが 1 秒に 20 回を超えて変わると worktree の一覧に戻し、知らせと理由を出す", async () => {
      await reloadWithMode(page, "e2e-session-list.mode", "churn");
      const nav = await sidebar(page);
      await expect(nav.getByText(notice)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        card(page.getByRole("region", { name: "入れたもの" }), "E2E 一覧").getByText(
          "表示でエラーが起きました：サイドバーのセッションの一覧が、1秒に20回より多く変わりました。useCategories が、同じセッションに違う答えを返しています。",
        ),
      ).toBeVisible();
    });
  });
});

test.describe("worktree の分け方（P18）", () => {
  test.use({ hubOptions: { plugins: [plugin("e2e-groupings")] } });

  test("最初の分け方で worktree を分け、畳み、メニューで分けないに替え、フックが壊れると分けずに並べる", async ({ page, hub }) => {
    await machine(hub);
    await page.goto("/");

    await test.step("まだ選んだことのないブラウザーでは、最初の分け方で分ける。どのカテゴリにも入らない worktree は「その他」に並べる", async () => {
      const nav = await sidebar(page);
      await expect(nav.getByRole("button", { name: /^E2E feat/ })).toBeVisible();
      const labels = await rows(nav);
      expect(inOrder(labels, ["E2E feat", "feat/1-a", "E2E fix", "fix/2-b", "その他", "main"]), labels.join(" | ")).toBe(true);
    });

    await test.step("見出しを押すと畳み、確認待ちの数を出す", async () => {
      const nav = await sidebar(page);
      const heading = nav.getByRole("button", { name: /^E2E feat/ });
      await heading.click();
      await expect(heading).toHaveAttribute("aria-expanded", "false");
      await expect(heading).toContainText("確認 1");
      await expect(nav.getByRole("button", { name: /^feat\/1-a/ })).toHaveCount(0);
      await heading.click();
    });

    await test.step("メニューの「分け方」で「分けない」を選ぶと分けずに並べ、選び直すと分ける", async () => {
      const nav = await sidebar(page);
      await nav.getByRole("button", { name: "絞り込みと分け方（分け方：E2E ブランチごと）" }).click();
      await page.getByRole("menuitemradio", { name: "分けない" }).click();
      await expect(nav.getByRole("button", { name: /^E2E feat/ })).toHaveCount(0);
      await expect(nav.getByRole("button", { name: /^feat\/1-a/ })).toBeVisible();
      await nav.getByRole("button", { name: "絞り込みと分け方" }).click();
      await expect(page.getByRole("menuitemradio", { name: "分けない" })).toBeChecked();
      await page.getByRole("menuitemradio", { name: "E2E ブランチごと" }).click();
      await expect(nav.getByRole("button", { name: /^E2E feat/ })).toBeVisible();
    });

    const notice = "E2E 分け方 の分け方を使えないので、worktree を分けずに並べています（理由はプラグインの画面に）。";
    await test.step("フックが例外を投げると分けずに並べ、知らせと理由を出す", async () => {
      await reloadWithMode(page, "e2e-groupings.mode", "throw");
      const nav = await sidebar(page);
      await expect(nav.getByText(notice)).toBeVisible();
      await expect(nav.getByRole("button", { name: /^E2E feat/ })).toHaveCount(0);
      await expect(nav.getByRole("button", { name: /^feat\/1-a/ })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.goto("/#/plugins");
      await expect(card(page.getByRole("region", { name: "入れたもの" }), "E2E 分け方").getByText("表示でエラーが起きました：分け方が壊れました")).toBeVisible();
    });

    await test.step("答えが 1 秒に 20 回を超えて変わると分けずに並べ、知らせと理由を出す", async () => {
      await reloadWithMode(page, "e2e-groupings.mode", "churn");
      await expect((await sidebar(page)).getByText(notice)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        card(page.getByRole("region", { name: "入れたもの" }), "E2E 分け方").getByText(
          "表示でエラーが起きました：サイドバーの worktree の分け方「E2E ブランチごと」が、1秒に20回より多く変わりました。useCategories が、同じ worktree に違う答えを返しています。",
        ),
      ).toBeVisible();
    });

    await test.step("選んだ分け方は覚えたままで、フックが直ると分ける", async () => {
      await reloadWithMode(page, "e2e-groupings.mode", null);
      await expect((await sidebar(page)).getByRole("button", { name: /^E2E feat/ })).toBeVisible();
    });
  });

  test("#299: リポジトリが多く、画面が低くても、「分け方」と「リポジトリを登録・解除…」はスクロールせずに見える", async ({ page, hub, isMobile }) => {
    test.skip(isMobile, "窓の高さを変えるのは PC の幅で");
    await page.setViewportSize({ width: 1440, height: 600 });
    const repo = (n: number) => `/work/repo-${String(n).padStart(2, "0")}`;
    await hub.fakeDaemon({
      name: "mac",
      sessions: Array.from({ length: 21 }, (_, i) => fakeSession({ sessionId: `0b6f3a52-9a51-4c7e-8d2b-6c1f0e4a7e${String(i + 1).padStart(2, "0")}`, cwd: repo(i + 1), gitBranch: "main", worktree: { path: repo(i + 1), repo: repo(i + 1), branch: "main" } })),
    });
    await page.goto("/");
    const nav = await sidebar(page);
    await nav.getByRole("button", { name: /^絞り込みと分け方/ }).click();
    const menu = page.getByRole("menu");
    const box = menu.getByRole("group", { name: "リポジトリ" });
    await expect(box.getByRole("menuitemcheckbox")).toHaveCount(21);
    expect(await box.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
    expect(await menu.evaluate((e) => e.scrollHeight <= e.clientHeight)).toBe(true);
    for (const item of [
      menu.getByRole("menuitemcheckbox", { name: "すべて" }),
      menu.getByRole("menuitemradio", { name: "分けない" }),
      menu.getByRole("menuitemradio", { name: "E2E ブランチごと" }),
      menu.getByRole("menuitem", { name: "リポジトリを登録・解除…" }),
    ])
      await expect(item).toBeInViewport({ ratio: 1 });
  });
});

/**
 * Opens the menu of a heading as one would: a right-click on a computer, a long press on a touch screen (Radix's menu
 * opens on a touch held for 700 ms; Playwright has no long press, so the pointer events are sent).
 */
async function openHeadingMenu(page: Page, heading: Locator, testInfo: TestInfo): Promise<Locator> {
  const menu = page.getByRole("menu");
  if (testInfo.project.use.hasTouch) {
    const box = await heading.boundingBox();
    if (!box) throw new Error("the heading is not shown");
    const el = await heading.elementHandle();
    const at = { pointerType: "touch", isPrimary: true, bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
    await el.dispatchEvent("pointerdown", at);
    await expect(menu).toBeVisible();
    await el.dispatchEvent("pointerup", at);
    await el.dispose();
  } else {
    await heading.click({ button: "right" });
  }
  await expect(menu).toBeVisible();
  return menu;
}

test.describe("リポジトリのカテゴリのメニュー（P18、API 1.19）", () => {
  test.use({ hubOptions: { plugins: [plugin("e2e-repo-groupings")] } });

  test("リポジトリを伝えたカテゴリの見出しのメニューで登録を外す。セッションのある worktree は残り、伝えないカテゴリにはメニューを出さない", async ({ page, hub }, testInfo) => {
    const APP = "/work/app";
    const daemon = await hub.fakeDaemon({
      name: "mac",
      repos: [
        {
          path: APP,
          worktrees: [
            { path: APP, branch: "main" },
            { path: `${APP}-feat`, branch: "feat/1-a" },
            { path: `${APP}-old`, branch: "fix/2-b" },
          ],
        },
      ],
      sessions: [
        fakeSession({ sessionId: "0b6f3a52-9a51-4c7e-8d2b-6c1f0e4a7d21", cwd: `${APP}-feat`, name: "作業", gitBranch: "feat/1-a", worktree: { path: `${APP}-feat`, repo: APP, branch: "feat/1-a" } }),
        fakeSession({ sessionId: "0b6f3a52-9a51-4c7e-8d2b-6c1f0e4a7d22", cwd: "/work/notes", name: "メモ" }),
      ],
    });
    daemon.handle("repo.unregister", (msg) => {
      daemon.setRepos(daemon.repos.filter((r) => r.path !== msg.path));
      return commandResult(msg, { ok: true });
    });
    await page.goto("/");

    const heading = async () => (await sidebar(page)).getByRole("button", { name: /^E2E app/ });
    await test.step("リポジトリを伝えたカテゴリの見出しを右クリック（長押し）すると、名前とフォルダーと「登録を外す…」のメニューが出る", async () => {
      const nav = await sidebar(page);
      await expect(nav.getByRole("button", { name: /^main/ })).toBeVisible();
      const menu = await openHeadingMenu(page, await heading(), testInfo);
      await expect(menu).toContainText("E2E app");
      await expect(menu).toContainText("mac · /work/app");
      await expect(menu.getByRole("menuitem", { name: "登録を外す…" })).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath("repo-menu.png") });
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    });

    await test.step("リポジトリを伝えないカテゴリの見出しでは、メニューを出さない", async () => {
      const nav = await sidebar(page);
      const outside = nav.getByRole("button", { name: /^E2E リポジトリの外/ });
      if (testInfo.project.use.hasTouch) {
        const box = (await outside.boundingBox())!;
        const at = { pointerType: "touch", isPrimary: true, bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
        await outside.dispatchEvent("pointerdown", at);
        await page.waitForTimeout(1000);
        await outside.dispatchEvent("pointerup", at);
      } else {
        await outside.click({ button: "right" });
      }
      await expect(page.getByRole("menu")).toHaveCount(0);
    });

    await test.step("「登録を外す…」で、残るものと消えるものを確かめてから外す", async () => {
      const menu = await openHeadingMenu(page, await heading(), testInfo);
      await menu.getByRole("menuitem", { name: "登録を外す…" }).click();
      const dialog = page.getByRole("alertdialog", { name: "リポジトリの登録を外しますか？" });
      await expect(dialog).toContainText("フォルダーとファイルは消しません。");
      await expect(dialog).toContainText("セッションのある worktree 1 件（セッション 1 件）は、登録を外したあとも一覧に残ります。");
      await expect(dialog).toContainText("セッションの無い worktree 2 件は、一覧から消えます。");
      await page.screenshot({ path: testInfo.outputPath("repo-unregister.png") });
      await dialog.getByRole("button", { name: "登録を外す" }).click();
      await expect(dialog).toHaveCount(0);
      expect((await daemon.waitFor("repo.unregister")).path).toBe(APP);
    });

    await test.step("外したあとは、セッションのある worktree だけがカテゴリに残り、メニューはもう外せないと出す", async () => {
      const nav = await sidebar(page);
      await expect(nav.getByRole("button", { name: /^main/ })).toHaveCount(0);
      await expect(nav.getByRole("button", { name: /^fix\/2-b/ })).toHaveCount(0);
      await expect(nav.getByRole("button", { name: /^feat\/1-a/ })).toBeVisible();
      const menu = await openHeadingMenu(page, await heading(), testInfo);
      await expect(menu.getByRole("menuitem", { name: "登録を外す…" })).toBeDisabled();
      await expect(menu).toContainText("mac に登録していないリポジトリです。");
    });
  });
});
