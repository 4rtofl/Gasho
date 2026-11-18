// A session's panel (components/side-panel.tsx, DockedPanel in App.tsx): beside the conversation on a computer, where
// its left edge changes its width, and in the conversation's place on a phone. The branch graph is the panel opened.
import type { FakeDaemon } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { commit, FakeFolder, hashOf, serveGraph, sessionDaemon, sessionUrl, showSessionHeader } from "./panel-data.ts";

function serveOneCommit(d: FakeDaemon): void {
  serveGraph(d, () => ({
    root: "/work/gasho",
    head: "main",
    headHash: hashOf("first"),
    branches: [{ name: "main", remote: false, hash: hashOf("first") }],
    commits: [commit("first", { subject: "最初のコミット", at: Date.now() })],
    truncated: false,
  }));
}

test.describe("PC の幅", () => {
  test.skip(({ isMobile }) => isMobile, "PC の幅だけの動き");

  test("パネルが会話の右に並び、左の端で 380〜620px に変えた幅が残り、× と Esc で閉じる", async ({ page, hub }) => {
    const d = await sessionDaemon(hub);
    serveOneCommit(d);
    await page.goto(sessionUrl(d));
    const input = page.getByPlaceholder("Agent への指示を入力…");
    const panel = page.getByRole("region", { name: "ブランチグラフ" });
    const edge = page.getByRole("separator", { name: "パネルの幅" });
    const aside = page.locator("aside").filter({ has: edge });
    const width = async () => (await aside.boundingBox())?.width;
    const drag = async (dx: number) => {
      const b = await edge.boundingBox();
      if (!b) throw new Error("パネルの端が見えません");
      const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y, { steps: 5 });
      await page.mouse.up();
    };

    await test.step("ヘッダーのブランチ名を押すと、ブランチグラフが会話の右に開く", async () => {
      await page.getByTitle("ブランチグラフを開く").click();
      await expect(panel.getByText("最初のコミット")).toBeVisible();
      await expect(page).toHaveURL(/\/graph$/);
      await expect(input).toBeVisible();
      const [p, i] = [await panel.boundingBox(), await input.boundingBox()];
      expect(p!.x).toBeGreaterThanOrEqual(i!.x + i!.width);
    });

    await test.step("左の端を左へドラッグすると広がり、620px で止まる", async () => {
      await drag(-400);
      await expect(edge).toHaveAttribute("aria-valuenow", "620");
      expect(await width()).toBe(620);
    });

    await test.step("右へドラッグすると狭まり、380px で止まる", async () => {
      await drag(400);
      await expect(edge).toHaveAttribute("aria-valuenow", "380");
      expect(await width()).toBe(380);
    });

    await test.step("ドラッグで変えた幅は、読み込み直しても残る", async () => {
      await drag(-50);
      await expect(edge).toHaveAttribute("aria-valuenow", "430");
      await page.reload();
      await expect(panel.getByText("最初のコミット")).toBeVisible();
      await expect(edge).toHaveAttribute("aria-valuenow", "430");
      expect(await width()).toBe(430);
    });

    await test.step("フォーカスが会話の入力欄にあるときは、Esc でパネルを閉じない", async () => {
      await input.click();
      await page.keyboard.press("Escape");
      await expect(panel).toBeVisible();
    });

    await test.step("フォーカスがパネルの中にあるときは、Esc でパネルを閉じる", async () => {
      await panel.getByRole("button", { name: "再読み込み" }).focus();
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(page).not.toHaveURL(/\/graph$/);
    });

    await test.step("× でパネルを閉じる", async () => {
      await page.getByTitle("ブランチグラフを開く").click();
      await expect(panel).toBeVisible();
      await panel.getByRole("button", { name: "閉じる" }).click();
      await expect(panel).toBeHidden();
      await expect(input).toBeVisible();
    });
  });
});

test.describe("スマホの幅", () => {
  test.skip(({ isMobile }) => !isMobile, "スマホの幅だけの動き");

  test("パネルが画面全体に出て、「セッションに戻る」で会話に戻る", async ({ page, hub }) => {
    const d = await sessionDaemon(hub);
    serveOneCommit(d);
    new FakeFolder(d).text("README.md", "# Gasho\n");
    await page.goto(sessionUrl(d));
    const input = page.getByPlaceholder("Agent への指示を入力…");
    const back = page.getByRole("button", { name: "セッションに戻る" });
    const fullWidth = async (name: string) => {
      const b = await page.getByRole("region", { name }).boundingBox();
      expect(b?.x).toBe(0);
      expect(b?.width).toBe(page.viewportSize()?.width);
    };

    await test.step("ブランチグラフが会話の代わりに画面の幅いっぱいに出て、見出しは上のバーに入る", async () => {
      await showSessionHeader(page, true);
      await page.getByTitle("ブランチグラフを開く").click();
      await expect(page.getByText("最初のコミット")).toBeVisible();
      await expect(page.getByRole("heading", { name: "ブランチグラフ" })).toBeVisible();
      await expect(input).toBeHidden();
      await fullWidth("ブランチグラフ");
    });

    await test.step("「セッションに戻る」で会話に戻る", async () => {
      await back.click();
      await expect(input).toBeVisible();
      await expect(page).not.toHaveURL(/\/graph$/);
    });

    await test.step("ファイルのパネルも画面の幅いっぱいに出て、「セッションに戻る」で戻る", async () => {
      await showSessionHeader(page, true);
      await page.getByTitle("このセッションのフォルダーのファイルを開く").click();
      await expect(page.getByRole("link", { name: /README\.md/ })).toBeVisible();
      await expect(input).toBeHidden();
      await fullWidth("ファイル");
      await back.click();
      await expect(input).toBeVisible();
    });
  });
});
