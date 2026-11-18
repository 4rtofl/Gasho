// What a plugin adds to Gasho's screen (docs/plugins.md): the sidebar's item and badge (P1), a page (P2), the session
// header's items (P3), a panel (P4), a home tile (P6), the end of the conversation (P13), the line under the chat box
// (P14), a worktree's tab and screen (P15); what shows when the plugin is not there, disabled, or cannot be loaded; and
// a part that throws while it is drawn. The plugin is e2e/plugins/e2e-parts, linked before the Gasho server starts.
import { type FakeDaemon, fakeSession, type GashoHub, textEntry } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { card, plugin, showHeader, sidebar } from "./plugin-helpers.ts";

const SESSION = "0b6f3a52-9a51-4c7e-8d2b-6c1f0e4a7d10";
const FOLDER = "/work/app";

/** A working server with one session in the worktree of the branch feat/1-x. */
function machine(hub: GashoHub): Promise<FakeDaemon> {
  return hub.fakeDaemon({
    name: "mac",
    sessions: [fakeSession({ sessionId: SESSION, cwd: FOLDER, name: "作業", gitBranch: "feat/1-x", worktree: { path: FOLDER, repo: FOLDER, branch: "feat/1-x" } })],
    transcripts: { [SESSION]: [textEntry("user", "こんにちは"), textEntry("assistant", "はい、どうぞ。")] },
  });
}

const sessionUrl = (d: FakeDaemon, more = "") => `/#/s/${encodeURIComponent(d.machineId)}/${SESSION}${more}`;
const worktreeUrl = (d: FakeDaemon, more = "") => `/#/w/${encodeURIComponent(d.machineId)}/${encodeURIComponent(FOLDER)}${more}`;

test.describe("部品", () => {
  test.use({ hubOptions: { plugins: [plugin("e2e-parts")] } });

  test("サイドバーの項目とバッジ・ページ・ホームのタイル・worktree のタブと画面", async ({ page, hub }) => {
    const d = await machine(hub);
    await page.goto("/");
    const main = page.getByRole("main");

    await test.step("ホームのタイルを、after に書いたタイルのあとに置く", async () => {
      await expect(main.getByRole("heading", { name: "E2E タイル" })).toBeVisible();
      await expect(main.getByText("タイルの中身")).toBeVisible();
      const titles = await main.getByRole("heading", { level: 2 }).allTextContents();
      expect(titles.indexOf("E2E タイル")).toBe(titles.indexOf("最近の操作") + 1);
    });

    await test.step("サイドバーの項目は、ホームと端末のあいだにバッジを付けて出す", async () => {
      const nav = await sidebar(page);
      await expect(nav.getByRole("button", { name: "E2E メモ 7" })).toBeVisible();
      const names = await nav.getByRole("button").allInnerTexts();
      const at = names.findIndex((n) => n.startsWith("E2E メモ"));
      expect(names.slice(at - 1, at + 2).map((n) => n.split("\n")[0])).toEqual(["ホーム", "E2E メモ", "端末"]);
    });

    await test.step("押すとそのページを引数つきで開き、項目を選んだ状態で出す", async () => {
      await (await sidebar(page)).getByRole("button", { name: "E2E メモ 7" }).click();
      await expect(page).toHaveURL(/#\/p\/e2e-parts\/notes\?tag=/);
      await expect(main.getByRole("heading", { name: "E2E メモ", level: 1 })).toBeVisible();
      await expect(main.getByText("ページの引数 横")).toBeVisible();
      await expect((await sidebar(page)).getByRole("button", { name: "E2E メモ 7" })).toHaveAttribute("aria-current", "page");
      await page.keyboard.press("Escape");
    });

    await test.step("worktree のタブを、セッションのタブのあとに出し、押すとプラグインの画面を出す", async () => {
      await page.goto(sessionUrl(d));
      const tabs = page.getByRole("navigation", { name: "この worktree のセッション" });
      const tab = tabs.getByRole("button", { name: "E2E タブ 2" });
      await tab.click();
      await expect(page).toHaveURL(/#\/w\/.+\/p\/e2e-parts\/view\?n=1$/);
      await expect(main.getByText("worktree の画面 feat/1-x 1")).toBeVisible();
      await expect(tab).toHaveAttribute("aria-current", "page");
      await expect(tabs.getByRole("button", { name: "作業" })).toBeVisible();
    });

    await test.step("無い画面のタブは、そのことを出す", async () => {
      await page.getByRole("navigation", { name: "この worktree のセッション" }).getByRole("button", { name: "E2E 無い画面" }).click();
      await expect(main.getByText("この画面はありません。")).toBeVisible();
    });
  });

  test("セッションのヘッダーの項目・パネル・会話の末尾・入力欄の下", async ({ page, hub, context, isMobile }) => {
    const d = await machine(hub);
    await context.route("https://example.com/**", (r) => r.fulfill({ contentType: "text/plain", body: "e2e" }));
    const opened: string[] = [];
    context.on("page", (p) => opened.push(p.url()));
    await page.goto(sessionUrl(d));
    const main = page.getByRole("main");

    await test.step("会話の末尾に、最後の発言のあとで部品を出す。入力欄の下にも出す", async () => {
      const end = main.getByText("会話の末尾 作業");
      await expect(end).toBeVisible();
      await expect(main.getByText("入力欄の下", { exact: true })).toBeVisible();
      const last = (await main.getByText("はい、どうぞ。").boundingBox())!;
      const box = (await end.boundingBox())!;
      const input = (await page.getByPlaceholder("Agent への指示を入力…").boundingBox())!;
      expect(last.y).toBeLessThan(box.y);
      expect(box.y).toBeLessThan(input.y);
    });

    await test.step("panel の項目は、そのパネルを開き、開いているあいだ選んだ状態で出す", async () => {
      await showHeader(page);
      await main.getByRole("button", { name: "E2E パネル" }).click();
      await expect(page).toHaveURL(/\/p\/e2e-parts\/notes\?kind=/);
      await expect(page.getByText("種類 一覧")).toBeVisible();
      await expect(page.getByText("パネルのセッション 作業")).toBeVisible();
      // On a phone, the panel takes the session's place, header and all.
      if (!isMobile) await expect(main.getByRole("button", { name: "E2E パネル" })).toHaveAttribute("aria-pressed", "true");
    });

    await test.step("権限を書いていないプラグインは、発言を送れず、セッションを起動できない", async () => {
      await page.getByRole("button", { name: "続けてと送る" }).click();
      await expect(page.getByText("E2E 部品 には、セッションに発言を送る権限がありません（gasho-plugin.json の permissions）。")).toBeVisible();
      await page.getByRole("button", { name: "起動する" }).click();
      await expect(page.getByText("E2E 部品 には、セッションを起動する権限がありません（gasho-plugin.json の permissions）。")).toBeVisible();
      expect(d.received.filter((m) => m.type === "session.input" || m.type === "session.launch")).toEqual([]);
      await page.goBack();
      await expect(page.getByText("パネルのセッション 作業")).toBeHidden();
    });

    await test.step("無いパネルの項目は、パネルにそのことを出す", async () => {
      await showHeader(page);
      await main.getByRole("button", { name: "E2E 無いパネル" }).click();
      await expect(page.getByText("このパネルはありません。")).toBeVisible();
      await page.goBack();
    });

    await test.step("page の項目は、そのページを開く", async () => {
      await showHeader(page);
      await main.getByRole("button", { name: "E2E ページ" }).click();
      await expect(main.getByText("ページの引数 ヘッダー")).toBeVisible();
      await page.goBack();
    });

    await test.step("href の項目は、https の URL だけを新しいタブで開く", async () => {
      const popup = context.waitForEvent("page");
      await showHeader(page);
      await main.getByRole("button", { name: "E2E リンク" }).click();
      await (await popup).close();
      await main.getByRole("button", { name: "E2E http" }).click();
    });

    await test.step("onClick の項目は、終わるまで押せなくし、失敗したときは理由を出す", async () => {
      await showHeader(page);
      const button = main.getByRole("button", { name: "E2E 押す" });
      await button.click();
      await expect(button).toBeDisabled();
      await page.evaluate("window.e2ePartsFail()");
      await expect(main.getByText("押せませんでした")).toBeVisible();
      await expect(button).toBeEnabled();
      // By now the http link would have opened a tab too.
      expect(opened).toEqual(["https://example.com/e2e-parts"]);
    });
  });
});

test.describe("使えないとき", () => {
  test.use({ hubOptions: { plugins: [plugin("e2e-parts"), plugin("e2e-broken")] } });

  test("入っていない・無いページ・読み込めない・無効なプラグインの部品の場所に、そのことを出す", async ({ page, hub }) => {
    const d = await machine(hub);
    const main = page.getByRole("main");

    await test.step("入っていないプラグインのページ・パネル・worktree の画面", async () => {
      await page.goto("/#/p/e2e-none/notes");
      await expect(main.getByRole("heading", { name: "e2e-none" })).toBeVisible();
      await expect(main.getByText("このプラグインは、Gasho サーバーに入っていません。")).toBeVisible();
      await page.goto(sessionUrl(d, "/p/e2e-none/notes"));
      await expect(page.getByText("このプラグインは、Gasho サーバーに入っていません。")).toBeVisible();
      await page.goto(worktreeUrl(d, "/p/e2e-none/view"));
      await expect(main.getByText("このプラグインは、Gasho サーバーに入っていません。")).toBeVisible();
      await main.getByRole("link", { name: "プラグインの画面" }).click();
      await expect(page).toHaveURL(/#\/plugins$/);
    });

    await test.step("無いページ", async () => {
      await page.goto("/#/p/e2e-parts/nothing");
      await expect(main.getByText("このページはありません。")).toBeVisible();
    });

    await test.step("読み込めないプラグインのページは、理由を出す", async () => {
      await page.goto("/#/p/e2e-broken/notes");
      await expect(main.getByText("読み込めませんでした：読み込みで壊れました")).toBeVisible();
    });

    await test.step("無効にしたプラグインのページ・パネル・worktree の画面", async () => {
      await page.goto("/#/plugins");
      const toggle = card(page.getByRole("region", { name: "入れたもの" }), "E2E 部品").getByRole("switch", { name: "E2E 部品 を有効にする" });
      await toggle.click();
      await expect(toggle).not.toBeChecked();
      await page.goto("/#/p/e2e-parts/notes");
      await expect(main.getByText("E2E 部品 は無効になっています。")).toBeVisible();
      await page.goto(sessionUrl(d, "/p/e2e-parts/notes"));
      await expect(page.getByText("E2E 部品 は無効になっています。")).toBeVisible();
      await page.goto(worktreeUrl(d, "/p/e2e-parts/view"));
      await expect(main.getByText("E2E 部品 は無効になっています。")).toBeVisible();
    });
  });

  test("入っているプラグインのページを開くと、読み込むまで「入っていません」と出さない", async ({ page }) => {
    // Browser code as text: e2e/tsconfig.json has no DOM types.
    await page.addInitScript({
      content: `new MutationObserver(() => {
        if (document.documentElement.innerText.includes("Gasho サーバーに入っていません")) window.e2eNotInstalled = true;
      }).observe(document, { subtree: true, childList: true, characterData: true });`,
    });
    await page.goto("/#/p/e2e-parts/notes");
    await expect(page.getByText("ページの引数 なし")).toBeVisible();
    expect(await page.evaluate("window.e2eNotInstalled ?? false")).toBe(false);
  });

  test("部品が描くときにエラーを投げると、その場所にエラーと「もう一度」を出し、ほかの画面は動き続ける", async ({ page }) => {
    await page.goto("/#/p/e2e-parts/boom");
    const main = page.getByRole("main");

    await test.step("エラーの文と「もう一度」を出す", async () => {
      await expect(main.getByText("E2E 部品 の表示でエラーが起きました。")).toBeVisible();
      await expect(main.getByRole("button", { name: "もう一度" })).toBeVisible();
    });

    await test.step("ほかの画面とプラグインのほかの部品は動き続け、プラグインの画面に理由を出す", async () => {
      await (await sidebar(page)).getByRole("button", { name: "ホーム" }).click();
      await expect(main.getByText("タイルの中身")).toBeVisible();
      await expect((await sidebar(page)).getByRole("button", { name: "E2E メモ 7" })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.goto("/#/plugins");
      await expect(card(page.getByRole("region", { name: "入れたもの" }), "E2E 部品").getByText("表示でエラーが起きました：ページが壊れました")).toBeVisible();
    });

    await test.step("「もう一度」で描き直す", async () => {
      await page.goto("/#/p/e2e-parts/boom");
      await expect(main.getByRole("button", { name: "もう一度" })).toBeVisible();
      await page.evaluate(() => localStorage.setItem("e2e-parts.boom", "fixed"));
      await main.getByRole("button", { name: "もう一度" }).click();
      await expect(main.getByText("直りました")).toBeVisible();
    });
  });
});
