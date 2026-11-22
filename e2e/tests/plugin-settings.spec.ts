// A plugin's settings (docs/plugins.md P5): the settings screen makes an input for each setting of gasho-plugin.json
// (a checkbox, a choice, a number, a text), and keeps the value for this browser only (scope "browser", localStorage)
// or on the Gasho server for every browser (scope "server"). The plugin's own part under the inputs (definePlugin's
// `settings`) shows the values as the plugin reads them (useSetting).
import { expect, test } from "./fixtures.ts";
import { plugin } from "./plugin-helpers.ts";

test.use({ hubOptions: { plugins: [plugin("e2e-parts")] } });

test("4 つの型の設定を変えられ、このブラウザーだけの値とすべてのブラウザーで共通の値を分けて覚える", async ({ page, hub, browser }) => {
  // Another browser registered with the same Gasho server.
  const other = await browser.newContext({ baseURL: hub.url });
  await other.addCookies([await hub.browserCookie("e2e-other")]);
  const page2 = await other.newPage();
  await page2.goto("/#/settings");
  const section2 = page2.getByRole("region", { name: "E2E 部品" });
  await section2.getByRole("button", { name: "E2E 部品", exact: true }).click();
  const values2 = section2.getByText(/^出す:/);
  await expect(values2).toHaveText("出す:false 色:red 数:3 見出し:");

  await page.goto("/#/settings");
  const section = page.getByRole("region", { name: "E2E 部品" });
  await section.getByRole("button", { name: "E2E 部品", exact: true }).click();
  const values = section.getByText(/^出す:/);
  await expect(values).toHaveText("出す:false 色:red 数:3 見出し:");

  await test.step("どの欄にも、このブラウザーだけの設定か、すべてのブラウザーで共通の設定かを出す", async () => {
    await expect(section.getByText("このブラウザーだけの設定")).toHaveCount(2);
    await expect(section.getByText("すべてのブラウザーで共通の設定")).toHaveCount(2);
    await expect(section.getByText("ページの見出しの後ろに出す")).toBeVisible();
  });

  await test.step("チェックボックスは押すとすぐに変わり、ほかのブラウザーには伝わらない", async () => {
    await section.getByLabel("E2E 出す").check();
    await expect(values).toHaveText("出す:true 色:red 数:3 見出し:");
  });

  await test.step("選択は選ぶとすぐに変わり、ほかのブラウザーにも伝わる", async () => {
    await section.getByLabel("E2E 色").selectOption("blue");
    await expect(values).toHaveText("出す:true 色:blue 数:3 見出し:");
    await expect(values2).toHaveText("出す:false 色:blue 数:3 見出し:");
  });

  const count = section.getByLabel("E2E 数");
  await test.step("数は Enter で確定する", async () => {
    await count.fill("5");
    await expect(values).toHaveText("出す:true 色:blue 数:3 見出し:");
    await count.press("Enter");
    await expect(values).toHaveText("出す:true 色:blue 数:5 見出し:");
    await expect(values2).toHaveText("出す:false 色:blue 数:5 見出し:");
  });

  await test.step("数はフォーカスを外したときにも確定する", async () => {
    await count.fill("8");
    await count.blur();
    await expect(values).toHaveText("出す:true 色:blue 数:8 見出し:");
  });

  await test.step("数が空のときと範囲の外のときは、理由を出して変えない", async () => {
    await count.fill("");
    await count.press("Enter");
    await expect(section.getByText("数を入れてください。")).toBeVisible();
    await count.fill("99");
    await count.press("Enter");
    await expect(section.getByText("10 以下にしてください。")).toBeVisible();
    await expect(values).toHaveText("出す:true 色:blue 数:8 見出し:");
  });

  await test.step("文字はフォーカスを外したときに確定し、ほかのブラウザーには伝わらない", async () => {
    const title = section.getByLabel("E2E 見出し");
    await title.fill("見出しA");
    await expect(values).toHaveText("出す:true 色:blue 数:8 見出し:");
    await title.blur();
    await expect(values).toHaveText("出す:true 色:blue 数:8 見出し:見出しA");
  });

  await test.step("読み込み直しても、どちらの値も残る。ほかのブラウザーでは、共通の値だけが変わっている", async () => {
    await page.reload();
    await expect(values).toHaveText("出す:true 色:blue 数:8 見出し:見出しA");
    await expect(values2).toHaveText("出す:false 色:blue 数:8 見出し:");
  });

  await other.close();
});
