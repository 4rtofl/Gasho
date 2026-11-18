// A theme (docs/plugins.md P16): the enabled theme plugin's values go on <html> as Gasho's CSS variables; the browser
// keeps them, and index.html sets them again before the page is drawn, before the Gasho server is reached. One theme is
// enabled at a time; disabling it brings Gasho's own colors back. The themes are e2e/plugins/e2e-theme-a and -b.
import { addPlugin } from "../harness/index.ts";
import { expect, test } from "./fixtures.ts";
import { card, plugin } from "./plugin-helpers.ts";

test.use({ hubOptions: { plugins: [plugin("e2e-theme-a")] } });

// Browser code as text: e2e/tsconfig.json has no DOM types.
const BACKGROUND = "getComputedStyle(document.documentElement).getPropertyValue('--background').trim()";

test("有効なテーマの色を当て、読み込み直したときは描く前に当て、無効にすると Gasho の色に戻す", async ({ page, hub }) => {
  const background = () => page.evaluate(BACKGROUND);
  // Until `reach` is true, the screen's connection reaches no Gasho server (it never hears of the plugins).
  let reach = true;
  const connections: { close: () => Promise<void> }[] = [];
  await page.routeWebSocket(/\/ws\/client$/, (ws) => {
    connections.push(ws);
    if (reach) ws.connectToServer();
  });
  await page.goto("/");

  await test.step("有効なテーマの値を、Gasho の CSS 変数に当てる", async () => {
    await expect.poll(background).toBe("#102030");
    expect(await page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--radius').trim()")).toBe("0.25rem");
    expect(await page.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--color-neutral-950').trim()")).toBe("#0a0b0c");
    expect(await page.evaluate("getComputedStyle(document.body).backgroundColor")).toBe("rgb(16, 32, 48)");
  });

  await test.step("読み込み直すと、Gasho サーバーにつながる前から当てる", async () => {
    reach = false;
    await page.reload();
    await expect.poll(() => connections.length).toBeGreaterThan(1);
    expect(await background()).toBe("#102030");
    // Closed, the screen connects again, to the Gasho server this time.
    reach = true;
    for (const c of connections.splice(0)) await c.close();
  });

  await page.goto("/#/plugins");
  const installed = page.getByRole("region", { name: "入れたもの" });
  const night = card(installed, "E2E 夜").getByRole("switch", { name: "E2E 夜 を有効にする" });

  await test.step("無効にすると Gasho の色に戻し、ブラウザーに覚えた値も消す", async () => {
    await night.click();
    await expect(night).not.toBeChecked();
    await expect.poll(background).not.toBe("#102030");
    expect(await page.evaluate("localStorage.getItem('gasho.theme')")).toBeNull();
  });

  await test.step("テーマを有効にすると、ほかのテーマを無効にして、そのテーマの色を当てる", async () => {
    await addPlugin(hub, plugin("e2e-theme-b"), { link: true });
    const morning = card(installed, "E2E 朝").getByRole("switch", { name: "E2E 朝 を有効にする" });
    await expect(morning).toBeChecked();
    await expect.poll(background).toBe("#304050");
    await night.click();
    await expect(night).toBeChecked();
    await expect(morning).not.toBeChecked();
    await expect.poll(background).toBe("#102030");
  });
});
