// The settings screen: the size of the conversation's text (its buttons, slider, default, sample, another tab and a
// reload), and a page that does not scroll past its end (#94).
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

const sizeShown = (page: Page) => page.getByText(/^\d+px(（標準）)?$/);
/** The sample's request, whose text is the conversation's body text. */
const sampleText = (page: Page) => page.getByText("ログインのボタンが押せないことがある。原因を調べて直して", { exact: true });

test("会話の文字の大きさ: ボタンは 12px・20px で押せなくなり、スライダーと「標準に戻す」で変わり、見本の大きさも変わる", async ({ page }) => {
  await page.goto("/#/settings");
  const smaller = page.getByRole("button", { name: "小さくする" });
  const larger = page.getByRole("button", { name: "大きくする" });
  const slider = page.getByRole("slider", { name: "会話の文字の大きさ" });
  await expect(sizeShown(page)).toHaveText("14px（標準）");
  await expect(sampleText(page)).toHaveCSS("font-size", "14px");
  await expect(page.getByRole("button", { name: "標準に戻す" })).toHaveCount(0);

  await smaller.click();
  await smaller.click();
  await expect(sizeShown(page)).toHaveText("12px");
  await expect(smaller).toBeDisabled();
  await expect(larger).toBeEnabled();
  await expect(sampleText(page)).toHaveCSS("font-size", "12px");

  await slider.fill("20");
  await expect(sizeShown(page)).toHaveText("20px");
  await expect(larger).toBeDisabled();
  await expect(smaller).toBeEnabled();
  await expect(sampleText(page)).toHaveCSS("font-size", "20px");

  await page.getByRole("button", { name: "標準に戻す" }).click();
  await expect(sizeShown(page)).toHaveText("14px（標準）");
  await expect(slider).toHaveValue("14");
});

test("会話の文字の大きさ: 別のタブで変えると追いかけ、読み込み直しても残る", async ({ page, context }) => {
  await page.goto("/#/settings");
  await expect(sizeShown(page)).toHaveText("14px（標準）");

  const other = await context.newPage();
  await other.goto("/#/settings");
  await other.getByRole("button", { name: "大きくする" }).click();
  await other.getByRole("button", { name: "大きくする" }).click();
  await expect(sizeShown(other)).toHaveText("16px");
  await expect(sizeShown(page)).toHaveText("16px");
  await expect(sampleText(page)).toHaveCSS("font-size", "16px");
  await other.close();

  await page.reload();
  await expect(sizeShown(page)).toHaveText("16px");
});

test("設定の画面で、ページ全体が下までスクロールしない（#94）", async ({ page }) => {
  await page.goto("/#/settings");
  await expect(page.getByRole("heading", { name: "バージョン" })).toBeVisible();
  const heights = () => page.evaluate<[number, number]>("[document.scrollingElement.scrollHeight, window.innerHeight]");
  const [scrollHeight, innerHeight] = await heights();
  expect(scrollHeight).toBe(innerHeight);
});
